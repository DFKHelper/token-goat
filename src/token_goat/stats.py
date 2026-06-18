"""Token-savings telemetry: aggregate and render per-session and all-time stats.

Stats are stored as rows in the ``stats`` table of each per-project SQLite DB
(and the global DB for project-agnostic events) by
:func:`~token_goat.db.record_stat`.  This module reads those rows back,
aggregates them by event kind, and formats them for display.

Public API:

- :func:`aggregate_stats` — load all stat rows from every known project DB
  (plus global.db) and return a flat list of :class:`StatRow` dataclasses,
  one per recorded event.
- :func:`render_text` / :func:`render_json` — format aggregated stats as
  human-readable text panels or structured JSON, respectively; called by the
  ``token-goat stats`` CLI command.

Stats are read via the read-only DB path
(:func:`~token_goat.db.open_global_readonly` /
:func:`~token_goat.db.open_project_readonly`) so the ``stats`` command never
acquires a write lock on any DB and completes in milliseconds even for large
projects.
"""
from __future__ import annotations

import hashlib
import operator
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

from . import db
from .render.ansi import fmt_bytes as _fmt_bytes
from .render.ansi import strip_ansi as _strip_ansi
from .util import get_logger

if TYPE_CHECKING:
    from rich.table import Table as RichTable

    from .render.types import StatsData

# Kinds that track bytes but not (reliable) token counts.
BYTES_MODE_ONLY_KINDS: frozenset[str] = frozenset({"webfetch_image", "gdrive_image"})

# User-facing "source" buckets exposed in the stats summary.  These collapse the
# raw event kinds (10+ over the lifetime of the project) into the four mechanisms
# the user understands from the README: image-shrink, hint, surgical-read,
# compact-assist.  An "other" bucket catches anything new the indexer records
# before the mapping below is updated — that way unknown kinds still appear in
# totals; they just are not attributed to a known source.
SOURCE_IMAGE = "image"
SOURCE_HINT = "hint"
SOURCE_READ = "read"
SOURCE_COMPACT = "compact"
SOURCE_BASH = "bash"
SOURCE_WEB = "web"
SOURCE_MCP = "mcp"
SOURCE_SKILL = "skill"
SOURCE_OTHER = "other"

# Map each raw event kind → user-facing source bucket.  Unknown kinds fall
# through to SOURCE_OTHER inside kind_to_source().  Keep this list aligned with
# the kinds passed to db.record_stat() across the codebase.
_KIND_TO_SOURCE: dict[str, str] = {
    # image-shrink family: both cache hits and fresh shrinks are counted as
    # image context savings. Cache hits have zero processing cost but still reduce
    # token budget by avoiding re-opening/re-reading a file from disk. Fresh shrinks
    # represent CPU work to compress the image down to a smaller size.
    "image_shrink": SOURCE_IMAGE,
    "image_shrink_cache_hit": SOURCE_IMAGE,
    # image_shrink_skipped: informational row for images that fell under the
    # per-format threshold (see image_shrink.format_threshold) and were passed
    # through unmodified.  bytes_saved / tokens_saved are always 0; the row
    # exists so the bypass rate can be measured (skipped / (skipped + shrunk +
    # cache_hit)) and the threshold tuned based on real session data.  Only
    # surfaces in `token-goat stats` when [stats] record_zero_savings = true.
    "image_shrink_skipped": SOURCE_IMAGE,
    "webfetch_image": SOURCE_IMAGE,
    "gdrive_image": SOURCE_IMAGE,
    # hint family (both gross savings and overhead live here so the source
    # bucket reflects the net contribution of the hint mechanism).  Diff hints
    # are the smart variant that injects a unified diff instead of suppressing
    # the re-read entirely — same prevention mechanism, same bucket.  Grep
    # dedup is a "prevent another file-like read" hint and stays in this
    # bucket too; the cross-tool symmetry keeps stats scannable.
    #
    # Note: `*_overhead` kinds are NOT listed here.  ``kind_to_source()`` strips
    # the ``_overhead`` suffix and re-looks up the base kind, so every overhead
    # row inherits its parent's bucket automatically.  This keeps the table
    # mechanical-pair-free and prevents drift when a new hint is added but its
    # overhead row is forgotten.
    "session_hint": SOURCE_HINT,
    # session_hint_suppressed: per-file cooldown suppression events.  A session
    # hint was not injected because the same file already received a
    # tokens_saved>0 hint this session and has not been edited since.  The
    # bytes_saved / tokens_saved are always 0 (the suppression is the saving,
    # recorded under session_hint's parent row); this row exists to make the
    # suppression rate visible in ``token-goat stats``.
    "session_hint_suppressed": SOURCE_HINT,
    "diff_hint": SOURCE_HINT,
    # structured_file_hint: advisory hint for large structured files
    # (.toml/.yaml/.json/.ini/.csv/Dockerfile/etc.) emitted by
    # hooks_read.handle_pre_read_structured.  Always bytes_saved=0 because the
    # hint is navigational — it steers the agent toward `token-goat section` or
    # jq/yq rather than claiming a realized saving.  Adoption-tracking shape:
    # like symbol_lookup/map_lookup, the row only surfaces in `token-goat stats`
    # when [stats] record_zero_savings = true.  When record_zero_savings is False
    # (the default), record_hint_stat_pair skips both the savings row and the
    # _overhead row (line 539 of hooks_common.py), so no net-negative overhead
    # appears.  The overhead only shows when record_zero_savings=True is opted in.
    "structured_file_hint": SOURCE_HINT,
    # predictive_prefetch_hit: attribution row written when a diff_hint fires
    # against a snapshot that was captured speculatively by post_edit (kind=
    # "predictive") rather than by post_read.  bytes_saved / tokens_saved are
    # always 0 so the row never double-counts the parent diff_hint saving —
    # it exists purely to measure how often the import-following prefetch
    # path actually pays off.  Written directly via db.record_stat (not via
    # record_hint_stat_pair) so the zero-saving filter does not drop it; the
    # row is always preserved for telemetry queries.
    "predictive_prefetch_hit": SOURCE_HINT,
    "grep_dedup_hint": SOURCE_HINT,
    # surgical read family — every variant that replaces a full-file Read with
    # a narrower slice belongs here so the user can see one combined "read"
    # savings line in `token-goat stats`.
    "read_replacement": SOURCE_READ,
    "section_replacement": SOURCE_READ,
    "symbol_read": SOURCE_READ,
    "section_read": SOURCE_READ,
    # stub_view: `token-goat skeleton <file>` — signatures-only view.  Saving
    # is the difference between the full file body and the signature block.
    "stub_view": SOURCE_READ,
    # symbol_lookup / semantic_search: not direct file slices, but they steer
    # the agent toward a surgical read instead of a Grep walk.  Realised
    # bytes_saved is 0 (the lookup itself is not a content fetch), so they
    # only appear in `token-goat stats` when [stats] record_zero_savings is
    # on — exactly like image_shrink_skipped.  Their presence in the bucket
    # exists so adoption (invocations per day, per project) can be measured.
    "symbol_lookup": SOURCE_READ,
    "semantic_search": SOURCE_READ,
    # map_lookup: ``token-goat map`` — orientation overview of the project.
    # Same adoption-tracking shape as symbol_lookup / semantic_search: zero
    # realised savings, but the row records how often agents reach for the
    # ranked file list instead of recursive ``ls`` + several Read calls.  Per
    # the [stats] record_zero_savings policy the row only surfaces in
    # ``token-goat stats`` when zero-saving rows are opted-in.
    "map_lookup": SOURCE_READ,
    # compaction assist family — includes the post-compact recovery hint and
    # its injection overhead.  Recovery overhead is a real cost even though
    # its realized saving is attributed downstream (bash_dedup_hint /
    # web_dedup_hint when the agent uses a recalled ID).
    "compact_manifest": SOURCE_COMPACT,
    "compact_assist": SOURCE_COMPACT,
    "compact_recovery": SOURCE_COMPACT,
    # skill_body_recall: `token-goat skill-body <name>` — re-loads a skill
    # body (whole or sliced) after compaction.  Same recovery family as the
    # compact_recovery hint, so it shares the bucket: both let the agent
    # rebuild context that compaction stripped.
    "skill_body_recall": SOURCE_COMPACT,
    # resume_packet: `token-goat resume <id>` — emits the saved resume packet
    # for a prior session.  Always bytes_saved=0; the row is an adoption
    # signal (how often agents fall back on resume) rather than a saving.
    "resume_packet": SOURCE_COMPACT,
    # decision_log: `token-goat decision "<text>"` — append-only reasoning log
    # surfaced in the compact manifest.  Tokens saved is always 0 (the entry is
    # additive context that survives compaction, not a replacement for a read).
    # bytes_saved tracks cumulative entry length so adoption is measurable in
    # ``token-goat stats``; the row sits in the compact bucket alongside the
    # other "preserve through compaction" mechanisms (skill_body_recall,
    # compact_recovery, resume_packet).
    "decision_log": SOURCE_COMPACT,
    # skill cache family — tracks the tokens saved by serving compact form
    # instead of the full body, and the adoption signal for skill caching.
    #
    # skill_compact_served: fired in the post-skill hook when a compact is
    #   stored for a large skill body.  tokens_saved = (full body tokens) −
    #   (compact tokens); bytes_saved = the same delta in bytes.  This is the
    #   primary savings signal for the skill-preservation feature.
    # skill_cached: fired once per new skill body stored to disk.
    #   bytes_saved / tokens_saved = size of the cached body (4 chars ≈ 1 token).
    #   The compaction delta (full − compact) is separately attributed to
    #   skill_compact_served.  Both together give the total skill-preservation
    #   savings picture.
    "skill_compact_served": SOURCE_SKILL,
    "skill_cached": SOURCE_SKILL,
    # changed_lookup: `token-goat changed` — lists symbols that changed since a
    # git ref.  Replaces reading the full unified diff (which can be hundreds of
    # KB for large PRs); bytes_saved is estimated as diff_size − output_size.
    # Falls into SOURCE_READ because it steers the agent toward a narrow slice
    # of the project history instead of a full diff read.
    "changed_lookup": SOURCE_READ,
    # bash output cache family — preventing repeat command runs is structurally
    # distinct from preventing file re-reads (no source file is involved), so
    # it gets its own user-visible bucket rather than folding into HINT.
    "bash_dedup_hint": SOURCE_BASH,
    "bash_range_read_hint": SOURCE_BASH,
    "bash_streak_hint": SOURCE_BASH,
    "bash_poll_hint": SOURCE_BASH,
    "mcp_cache_invalidated": SOURCE_MCP,
    "bash_output_cached": SOURCE_BASH,
    # bash_output_too_small: fired by post_bash when an output is skipped from
    # caching because it falls below min_cache_bytes or above max_cache_bytes
    # (size threshold filtering). bytes_saved / tokens_saved are always 0.
    # The row exists to measure threshold-induced cache misses and tune the
    # min/max values based on real session data.  Only surfaces in `token-goat
    # stats` when [stats] record_zero_savings = true.
    "bash_output_too_small": SOURCE_BASH,
    # bash_output_recall: fired by cmd_bash_output when the agent calls
    # `token-goat bash-output` to retrieve a cached output.  saved_bytes =
    # full_output − returned_slice; zero for an unsliced full recall (honest).
    "bash_output_recall": SOURCE_BASH,
    # bash_output_recall_miss: fired by cmd_bash_output when the agent
    # asks for an ID that no longer exists on disk (evicted, mistyped, or
    # from a different session).  bytes_saved is always 0.  The row exists
    # so adoption telemetry can distinguish a healthy recall from a stale
    # one — a high miss rate signals eviction is too aggressive or the
    # agent is hallucinating IDs.  Only surfaces in `token-goat stats`
    # when [stats] record_zero_savings = true.
    "bash_output_recall_miss": SOURCE_BASH,
    # bash_dedup_stale: fired by build_bash_dedup_hint when a prior bash
    # entry exists in the session cache but its age exceeds the stale
    # threshold, so the hint is suppressed and the agent ends up re-running
    # the command.  Parallel to image_shrink_skipped: zero realized saving,
    # but the row makes the bypass rate measurable
    # (stale / (stale + dedup_hint)) so the threshold can be tuned.
    "bash_dedup_stale": SOURCE_BASH,
    # web-fetch cache family — same shape as bash, separate bucket so the
    # network-savings line is distinct from the local-execution-savings line
    # in the stats output.
    "web_dedup_hint": SOURCE_WEB,
    "web_output_cached": SOURCE_WEB,
    # web_output_recall: fired by cmd_web_output when the agent calls
    # `token-goat web-output` to retrieve a cached web response.  Same
    # semantics as bash_output_recall: zero for a full recall, >0 for a slice.
    "web_output_recall": SOURCE_WEB,
    # web_output_recall_miss: fired by cmd_web_output for a missing ID.
    # Same adoption-telemetry shape as bash_output_recall_miss; surfaces
    # only when [stats] record_zero_savings = true.
    "web_output_recall_miss": SOURCE_WEB,
    # web_dedup_stale: fired by build_web_dedup_hint when a prior fetch
    # entry exists but is age-stale.  Parallel to bash_dedup_stale.
    "web_dedup_stale": SOURCE_WEB,
    # mcp_output_recall: fired by cmd_mcp_output when the model calls
    # `token-goat mcp-output` to retrieve a cached MCP result. Same
    # semantics as bash_output_recall: zero for a full recall, >0 for a slice.
    "mcp_output_recall": SOURCE_MCP,
    # mcp_output_recall_miss: fired by cmd_mcp_output for a missing ID.
    "mcp_output_recall_miss": SOURCE_MCP,
    # session_cache_lock_timeout: operational telemetry fired by the session cache writer (session.py) when it cannot acquire the per-session write lock within the timeout window. bytes_saved / tokens_saved are always 0; the row exists so operators can detect contention on the session cache file (e.g., two concurrent hook processes racing on the same session). Falls into SOURCE_OTHER because it is not a token-saving event but a reliability health signal.
    "session_cache_lock_timeout": SOURCE_OTHER,
}


# Prefix → source bucket for dynamic kind names.  `bash_runner` records one
# kind per filter (``bash_compress:pytest``, ``bash_compress:npm``, ...), so the
# static dict cannot enumerate them.  Order does not matter — at most one
# prefix can ever match a given kind because all prefixes end with ``:``.
_KIND_PREFIX_TO_SOURCE: tuple[tuple[str, str], ...] = (
    ("bash_compress:", SOURCE_BASH),
)

# CLI commands that record their own stats with command-specific kinds.
# Used to group by_kind entries into a by_command breakdown.
# Maps command_name to the kind(s) it records (some commands may record multiple kinds).
_COMMAND_KINDS: dict[str, set[str]] = {
    "symbol": {"symbol_lookup"},
    "read": {"read_replacement"},
    "section": {"section_replacement", "section_read"},
    "semantic": {"semantic_search"},
    "outline": {"outline"},
    "exports": {"exports"},
    "skeleton": {"stub_view"},
    "refs": {"symbol_read"},  # refs uses symbol_read internally
    "map": {"map_lookup"},
    "changed": {"changed_lookup"},  # changed -- list symbols changed since a git ref
}


_OVERHEAD_SUFFIX = "_overhead"


def kind_to_source(kind: str) -> str:
    """Map a raw stats event *kind* to a user-facing source bucket.

    Returns one of ``SOURCE_IMAGE``, ``SOURCE_HINT``, ``SOURCE_READ``,
    ``SOURCE_COMPACT``, ``SOURCE_BASH``, ``SOURCE_WEB``, ``SOURCE_SKILL``,
    or ``SOURCE_OTHER`` for unknown kinds.

    Resolution order:
    1. Exact match against ``_KIND_TO_SOURCE`` (the canonical static table).
    2. If the kind ends in ``_overhead`` (the canonical hint-cost suffix),
       re-look up the base kind without the suffix.  Every overhead row pairs
       1:1 with a parent kind and shares its bucket, so this saves the table
       from having to enumerate both halves of every pair.
    3. ``<family>:<subkind>`` dynamic kinds match against
       ``_KIND_PREFIX_TO_SOURCE`` (used by ``bash_compress:<filter>``).
    4. Fallback ``SOURCE_OTHER``.

    Used by :func:`summarize` to populate ``StatsSummary.by_source``.
    """
    src = _KIND_TO_SOURCE.get(kind)
    if src is not None:
        return src
    if kind.endswith(_OVERHEAD_SUFFIX):
        base = kind[: -len(_OVERHEAD_SUFFIX)]
        base_src = _KIND_TO_SOURCE.get(base)
        if base_src is not None:
            return base_src
    for prefix, prefix_src in _KIND_PREFIX_TO_SOURCE:
        if kind.startswith(prefix):
            return prefix_src
    return SOURCE_OTHER


__all__ = [
    "BYTES_MODE_ONLY_KINDS",
    "SOURCE_BASH",
    "SOURCE_COMPACT",
    "SOURCE_HINT",
    "SOURCE_IMAGE",
    "SOURCE_OTHER",
    "SOURCE_READ",
    "SOURCE_SKILL",
    "SOURCE_WEB",
    "StatsSummary",
    "kind_to_source",
    "render_by_command",
    "render_by_project",
    "render_text",
    "summarize",
]


class _StatsBucket(TypedDict):
    """Mutable accumulator for a single stats aggregation bucket (kind, day, or project)."""

    events: int
    bytes_saved: int
    tokens_saved: int

_LOG = get_logger("stats")

# Cache directory → inferred git root so we don't re-walk on every event.
_git_root_cache: dict[str, str | None] = {}

# Cache integer timestamp → "YYYY-MM-DD" date string.  Stats rows often share
# timestamps that truncate to the same day, so this cuts datetime.fromtimestamp
# + strftime cost from O(rows) to O(unique_days) — typically 1-30 unique values
# across thousands of rows.
# Note: this cache is process-lifetime and never evicted. With STATS_RETENTION_DAYS
# = 90 and at most one unique-second per row, the dict tops out at ~7.8 M entries in
# the absolute worst case (every row a unique second for 90 days of dense logging).
# In practice it stays well under 10 k entries.  If retention or event rates ever
# grow dramatically, add an LRU cap here.
_ts_to_date_cache: dict[int, str] = {}


def _norm_path(p: str) -> str:
    """Normalize to forward slashes with lowercase drive letter."""
    n = p.replace("\\", "/")
    if len(n) >= 2 and n[1] == ":":
        n = n[0].lower() + n[1:]
    return n


def _extract_file_path(kind: str, detail: str | None) -> str | None:
    """Pull the source filesystem path out of a stats detail field.

    image_shrink stores "src -> dest"; everything else is the path directly.
    """
    if not detail:
        return None
    if " -> " in detail and (kind in BYTES_MODE_ONLY_KINDS or kind == "image_shrink"):
        return detail.split(" -> ", 1)[0].strip()
    return detail


def _find_git_root(file_path: str) -> str | None:
    """Walk upward from *file_path* to find the nearest .git directory.

    The result is cached by parent directory so repeated calls for files in
    the same directory cost only a dict lookup.  Returns the normalized path
    of the git root, or ``None`` if no .git ancestor was found within 20 hops.
    """
    parent_dir = str(Path(file_path).parent)
    if parent_dir in _git_root_cache:
        return _git_root_cache[parent_dir]

    p = Path(file_path).parent
    for _ in range(20):
        if (p / ".git").exists():
            _git_root_cache[parent_dir] = _norm_path(str(p))
            return _git_root_cache[parent_dir]
        up = p.parent
        if up == p:
            break
        p = up

    _git_root_cache[parent_dir] = None
    return None


def _infer_project_root(file_path: str, registered_roots: list[str]) -> str | None:
    """Return the project root for *file_path*.

    Walks up the directory tree for a .git ancestor first — that is always
    the most specific boundary and handles repos cloned inside a registered
    parent directory. Falls back to longest-prefix match against registered
    roots for the rare case of non-git projects.
    """
    git_root = _find_git_root(file_path)
    if git_root is not None:
        return git_root

    norm = _norm_path(file_path)
    for root in sorted(registered_roots, key=len, reverse=True):
        root_norm = _norm_path(root).rstrip("/")
        if norm.startswith(root_norm + "/") or norm == root_norm:
            return root

    return None


def _infer_project_root_fast(
    file_path: str,
    sorted_norm_roots: list[tuple[str, str]],
) -> str | None:
    """Fast variant of _infer_project_root for hot loops.

    Accepts *sorted_norm_roots* as a pre-sorted, pre-normalized list of
    ``(original_root, normalized_root)`` pairs (longest first).  Avoids
    re-sorting and re-normalizing registered roots on every call — the caller
    builds this list once before iterating over rows.

    .git walk result is still cached in ``_git_root_cache`` as usual.
    """
    git_root = _find_git_root(file_path)
    if git_root is not None:
        return git_root

    norm = _norm_path(file_path)
    for orig_root, root_norm in sorted_norm_roots:
        if norm.startswith(root_norm + "/") or norm == root_norm:
            return orig_root

    return None


def _root_hash(root: str) -> str:
    """Stable key for a project root that isn't in the projects table."""
    return hashlib.sha1(root.encode()).hexdigest()


def _zero_bucket() -> _StatsBucket:
    """Return a fresh zero-valued stats accumulator bucket."""
    return {"events": 0, "bytes_saved": 0, "tokens_saved": 0}


def _inc_bucket(bucket: _StatsBucket, bytes_saved: int, tokens_saved: int) -> None:
    """Increment a stats accumulator bucket by the given byte/token counts."""
    bucket["events"] += 1
    bucket["bytes_saved"] += bytes_saved
    bucket["tokens_saved"] += tokens_saved


def _row_byte_token(row: sqlite3.Row) -> tuple[int, int]:
    """Extract (bytes_saved, tokens_saved) from a stats row, defaulting NULLs to 0."""
    return row["bytes_saved"] or 0, row["tokens_saved"] or 0


class _ProjectBucket(_StatsBucket):
    """Stats bucket extended with a project_root label."""

    project_root: str


class _DayRow(TypedDict):
    """A single by-day aggregation row (after the date key is merged in)."""

    date: str
    events: int
    bytes_saved: int
    tokens_saved: int


class _ProjectRow(TypedDict):
    """A single by-project aggregation row returned in StatsSummary.by_project."""

    project_hash: str
    project_root: str
    events: int
    bytes_saved: int
    tokens_saved: int


class _CommandRow(TypedDict):
    """A single by-command aggregation row returned in StatsSummary.by_command."""

    command: str
    events: int
    bytes_saved: int
    tokens_saved: int


@dataclass
class StatsSummary:
    """Aggregated statistics across projects and time.

    ``by_source`` collapses the raw event kinds into the four user-facing
    sources (image / hint / read / compact) plus an ``other`` catch-all.  It is
    derived from ``by_kind`` at summary time using :func:`kind_to_source`, so
    callers can render either view without re-walking the DB.  The field is
    defaulted to an empty dict so callers that construct ``StatsSummary``
    directly (older tests, in-memory cached summaries) still work unmodified.

    ``by_command`` breaks down savings by CLI command (symbol, read, section, etc.)
    for users who want to see which command is most valuable. It is derived from
    by_kind at summary time using the _COMMAND_KINDS mapping.
    """

    total_events: int
    total_bytes_saved: int
    total_tokens_saved: int
    by_kind: dict[str, _StatsBucket]  # kind -> {events, bytes_saved, tokens_saved}
    by_day: list[_DayRow]  # newest first: {date, events, bytes_saved, tokens_saved}
    by_project: list[_ProjectRow]  # {project_hash, project_root, events, bytes_saved, tokens_saved}
    window_days: int
    # source -> {events, bytes_saved, tokens_saved}.  Populated by summarize().
    # Defaulted so older code paths that construct StatsSummary directly (tests,
    # in-memory cached summaries) still work without modification.
    by_source: dict[str, _StatsBucket] = dataclass_field(default_factory=dict)
    # command -> {events, bytes_saved, tokens_saved}.  Populated by summarize().
    # Defaulted so older code paths still work without modification.
    by_command: list[_CommandRow] = dataclass_field(default_factory=list)


def _read_stats(
    conn: sqlite3.Connection, since_ts: float | None
) -> list[sqlite3.Row]:
    """Fetch stats rows from the given connection.

    When *since_ts* is provided only rows at or after that timestamp are
    returned; passing ``None`` returns the full table.
    """
    base = "SELECT ts, kind, tokens_saved, bytes_saved, detail FROM stats"
    if since_ts is not None:
        return conn.execute(f"{base} WHERE ts >= ? ORDER BY ts", (int(since_ts),)).fetchall()
    return conn.execute(f"{base} ORDER BY ts").fetchall()


def summarize(window_days: int = 30) -> StatsSummary:
    """Aggregate stats from global.db + all known per-project DBs over the last N days."""
    t0 = time.time()
    since_ts = (
        (datetime.now() - timedelta(days=window_days)).timestamp()
        if window_days > 0
        else None
    )
    _LOG.debug("summarize started: window=%d days, since_ts=%s", window_days, since_ts)

    by_kind: dict[str, _StatsBucket] = defaultdict(_zero_bucket)
    by_day: dict[str, _StatsBucket] = defaultdict(_zero_bucket)
    by_project: dict[str, _ProjectBucket] = defaultdict(
        lambda: _ProjectBucket(events=0, bytes_saved=0, tokens_saved=0, project_root="")
    )
    total_events = 0
    total_bytes = 0
    total_tokens = 0

    # Global DB
    projects: list[tuple[str, str]] = []
    global_rows: list[sqlite3.Row] = []
    try:
        with db.open_global_readonly() as conn:
            global_rows = list(_read_stats(conn, since_ts))
            for row in global_rows:
                _accumulate(row, by_kind, by_day)
                bs, ts = _row_byte_token(row)
                total_events += 1
                total_bytes += bs
                total_tokens += ts
            _LOG.debug("global.db: aggregated %d rows", len(global_rows))

            # Pull project list for per-project rollup
            project_rows = conn.execute(
                "SELECT hash, root FROM projects"
            ).fetchall()
            projects = [(r["hash"], r["root"]) for r in project_rows]
            _LOG.debug("found %d projects to aggregate", len(projects))
    except (db.DBError, OSError, sqlite3.DatabaseError) as _exc:
        _LOG.error("global stats read failed: %s", _exc, exc_info=True)

    # Per-project DBs
    projects_aggregated = 0
    for project_hash, project_root in projects:
        try:
            with db.open_project_readonly(project_hash) as conn:
                rows = list(_read_stats(conn, since_ts))
                for row in rows:
                    _accumulate(row, by_kind, by_day)
                    bs, ts = _row_byte_token(row)
                    total_events += 1
                    total_bytes += bs
                    total_tokens += ts
                    p = by_project[project_hash]
                    _inc_bucket(p, bs, ts)
                    p["project_root"] = project_root
                projects_aggregated += 1
                _LOG.debug("project %s: aggregated %d rows", project_hash[:8], len(rows))
        except (db.DBError, OSError, sqlite3.DatabaseError) as _exc:
            _LOG.error("project stats read failed %s: %s", project_hash[:8], _exc, exc_info=True)

    # Attribute global.db events (session hints, image shrink, etc.) to projects
    # by matching each event's file path against registered roots, then falling
    # back to a .git walk for projects opened from a parent directory.
    #
    # This second pass runs AFTER the per-project loop so that by_project already
    # has entries for all known hashes.  Global events for an unregistered root
    # land in a synthetic bucket keyed by _root_hash(root) rather than being lost.
    root_to_hash = {root: h for h, root in projects}
    # Normalized lookup so .git-walk results (always normalized) match DB roots
    # that may use original Windows casing (e.g. "C:/Projects" vs "c:/Projects").
    norm_root_to_hash = {_norm_path(root).rstrip("/"): h for root, h in root_to_hash.items()}
    # Pre-sort and pre-normalize once; avoids O(R·log R + R) work per row in the hot loop.
    sorted_norm_roots: list[tuple[str, str]] = sorted(
        ((root, _norm_path(root).rstrip("/")) for root in root_to_hash),
        key=lambda t: len(t[1]),
        reverse=True,
    )
    for row in global_rows:
        file_path = _extract_file_path(row["kind"], row["detail"])
        if not file_path:
            continue
        root = _infer_project_root_fast(file_path, sorted_norm_roots)
        if root is None:
            continue
        # _infer_project_root_fast returns either a git-walk result (always
        # normalized) or an original root string from root_to_hash.  Try the
        # direct lookup first (O(1)); if it misses, normalize once and try
        # norm_root_to_hash; fall back to a synthetic hash for unregistered roots.
        proj_key = root_to_hash.get(root)
        if proj_key is None:
            norm_root = _norm_path(root).rstrip("/")
            proj_key = norm_root_to_hash.get(norm_root) or _root_hash(root)
        p = by_project[proj_key]
        _inc_bucket(p, *_row_byte_token(row))
        p["project_root"] = root

    by_day_list: list[_DayRow] = sorted(
        [
            _DayRow(
                date=k,
                events=v["events"],
                bytes_saved=v["bytes_saved"],
                tokens_saved=v["tokens_saved"],
            )
            for k, v in by_day.items()
        ],
        key=operator.itemgetter("date"),
        reverse=True,
    )
    by_project_list: list[_ProjectRow] = sorted(
        [
            _ProjectRow(
                project_hash=k,  # full hash; callers truncate for display
                project_root=v["project_root"],
                events=v["events"],
                bytes_saved=v["bytes_saved"],
                tokens_saved=v["tokens_saved"],
            )
            for k, v in by_project.items()
        ],
        key=operator.itemgetter("bytes_saved"),
        reverse=True,
    )

    # Roll up by_kind into the four user-facing source buckets so the
    # renderer / JSON consumers can show "image vs hint vs read vs compact"
    # without re-walking the DB.  Unknown kinds land in SOURCE_OTHER so newly
    # added event types don't disappear silently from the user-facing total.
    by_source: dict[str, _StatsBucket] = defaultdict(_zero_bucket)
    for kind_name, bucket in by_kind.items():
        src_bucket = by_source[kind_to_source(kind_name)]
        src_bucket["events"] += bucket["events"]
        src_bucket["bytes_saved"] += bucket["bytes_saved"]
        src_bucket["tokens_saved"] += bucket["tokens_saved"]

    # Roll up by_kind into CLI commands (symbol, read, section, etc.) so users
    # can see which command is most valuable.  Commands may record multiple kinds
    # (e.g., section_replacement + section_read both map to "section").
    by_command_dict: dict[str, _StatsBucket] = defaultdict(_zero_bucket)
    for cmd_name, cmd_kinds in _COMMAND_KINDS.items():
        for kind_name in cmd_kinds:
            if kind_name in by_kind:
                bucket = by_kind[kind_name]
                cmd_bucket = by_command_dict[cmd_name]
                cmd_bucket["events"] += bucket["events"]
                cmd_bucket["bytes_saved"] += bucket["bytes_saved"]
                cmd_bucket["tokens_saved"] += bucket["tokens_saved"]

    by_command_list: list[_CommandRow] = sorted(
        [
            _CommandRow(
                command=cmd,
                events=v["events"],
                bytes_saved=v["bytes_saved"],
                tokens_saved=v["tokens_saved"],
            )
            for cmd, v in by_command_dict.items()
        ],
        key=operator.itemgetter("bytes_saved"),
        reverse=True,
    )

    elapsed = time.time() - t0
    _LOG.info("summarize completed: events=%d bytes=%.0f tokens=%d projects_read=%d elapsed=%.3fs",
              total_events, total_bytes, total_tokens, projects_aggregated, elapsed)

    return StatsSummary(
        total_events=total_events,
        total_bytes_saved=total_bytes,
        total_tokens_saved=total_tokens,
        by_kind=dict(by_kind),
        by_day=by_day_list,
        by_project=by_project_list,
        window_days=window_days,
        by_source=dict(by_source),
        by_command=by_command_list,
    )


def _accumulate(row: sqlite3.Row, by_kind: dict[str, _StatsBucket], by_day: dict[str, _StatsBucket]) -> None:
    """Accumulate a stats row into the kind and day dictionaries.

    The kind bucket is always incremented even when day bucketing fails (bad
    timestamp).  This is intentional: a corrupt timestamp should not erase the
    event from by_kind totals; it just cannot be placed on the calendar.
    """
    bs, ts = _row_byte_token(row)
    _inc_bucket(by_kind[row["kind"]], bs, ts)

    raw_ts = row["ts"]
    date_str = _ts_to_date_cache.get(raw_ts)
    if date_str is None:
        try:
            date_str = datetime.fromtimestamp(raw_ts).strftime("%Y-%m-%d")
        except (OSError, OverflowError, ValueError):
            # Malformed or out-of-range timestamp — skip day bucketing for this row.
            # The event is still counted in by_kind (see note above).
            _LOG.debug("skipping day accumulation: invalid ts=%r", raw_ts)
            return
        _ts_to_date_cache[raw_ts] = date_str
    _inc_bucket(by_day[date_str], bs, ts)


def _fmt_tokens(n: int) -> str:
    """Format token count as human-readable (t/kt/Mt/Gt/Tt)."""
    if n < 1000:
        return f"{n}t"
    if n < 1_000_000:
        return f"{n/1000:.1f}kt"
    if n < 1_000_000_000:
        return f"{n/1_000_000:.2f}Mt"
    if n < 1_000_000_000_000:
        return f"{n/1_000_000_000:.2f}Gt"
    return f"{n/1_000_000_000_000:.2f}Tt"


def _short_project(root: str) -> str:
    """Last path component of a project root, for compact display."""
    if not root:
        return "(unknown)"
    cleaned = root.rstrip("/\\")
    sep = "\\" if "\\" in cleaned else "/"
    tail = cleaned.split(sep)[-1] if sep in cleaned else cleaned
    return tail[:28]


def _to_stats_data(summary: StatsSummary, top_projects: int = 5) -> StatsData:
    """Convert StatsSummary to the render layer's StatsData."""
    from . import __version__  # noqa: PLC0415
    from .render.types import (
        CommandStat,
        DayStat,
        KindStat,
        ProjectStat,
        SourceStat,
        StatsData,
        TotalStats,
    )

    today = date.today()
    if summary.window_days > 0:
        period_start = today - timedelta(days=summary.window_days)
    elif summary.by_day:
        # by_day is newest-first; the last element is the oldest day in the window.
        # fromisoformat raises ValueError on a malformed date string — fall back to
        # today rather than crashing the renderer on a single bad DB row.
        try:
            period_start = date.fromisoformat(summary.by_day[-1]["date"])
        except (ValueError, KeyError) as exc:
            _LOG.warning("could not parse period_start from by_day[-1]: %r (%s)", summary.by_day[-1], exc)
            period_start = today
    else:
        period_start = today

    _get_bytes = operator.attrgetter("bytes")
    by_kind = sorted(
        [
            KindStat(
                kind=k,
                bytes=v["bytes_saved"],
                tokens=v["tokens_saved"],
                events=v["events"],
                bytes_mode_only=k in BYTES_MODE_ONLY_KINDS,
            )
            for k, v in summary.by_kind.items()
        ],
        key=_get_bytes,
        reverse=True,
    )

    by_day = sorted(
        [
            DayStat(
                date=d["date"],
                bytes=d["bytes_saved"],
                tokens=d["tokens_saved"],
                events=d["events"],
            )
            for d in summary.by_day
        ],
        key=_get_bytes,
        reverse=True,
    )[:7]

    by_project = [
        ProjectStat(
            project=_short_project(p["project_root"]),
            hash=p["project_hash"][:8],
            path=p["project_root"] or "(unknown)",
            bytes=p["bytes_saved"],
            tokens=p["tokens_saved"],
            events=p["events"],
        )
        for p in summary.by_project
    ][:top_projects]

    # Per-source rollup mirrors the legacy renderer's "By source" panel.
    # Empty when older summaries (pre by_source rollup) are passed in, which
    # the renderer interprets as "skip the section" — backward-compatible.
    by_source = sorted(
        [
            SourceStat(
                source=src,
                bytes=v["bytes_saved"],
                tokens=v["tokens_saved"],
                events=v["events"],
            )
            for src, v in (summary.by_source or {}).items()
        ],
        key=_get_bytes,
        reverse=True,
    )

    # Per-command breakdown: shows which CLI command (symbol, read, section, etc.)
    # saved the most tokens. Empty when older summaries (pre by_command rollup)
    # are passed in, backward-compatible.
    by_command = [
        CommandStat(
            command=c["command"],
            bytes=c["bytes_saved"],
            tokens=c["tokens_saved"],
            events=c["events"],
        )
        for c in (summary.by_command or [])
    ]

    return StatsData(
        period_start=period_start,
        period_end=today,
        totals=TotalStats(
            events=summary.total_events,
            bytes=summary.total_bytes_saved,
            tokens=summary.total_tokens_saved,
        ),
        by_kind=by_kind,
        by_day=by_day,
        by_project=by_project,
        by_source=by_source,
        by_command=by_command,
        version=__version__,
        window_label="all time" if summary.window_days == 0 else f"last {summary.window_days} days",
    )


def _make_stats_table(label_col: str) -> RichTable:
    """Create the standard 5-column stats table used by kind/day/project sections.

    All three legacy-renderer tables share identical structure: a label column,
    a relative-savings bar column, bytes, tokens, and events. Only the first
    column name differs, so it is accepted as a parameter.

    ``rich`` is imported lazily inside this function so it is not required at
    module import time (environments without rich skip the renderer entirely).
    """
    from rich.table import Table  # noqa: PLC0415

    tbl = Table(
        show_header=True,
        header_style="bold dim",
        show_edge=False,
        box=None,
        pad_edge=False,
        padding=(0, 1),
    )
    tbl.add_column(label_col, style="white", no_wrap=True, width=18)
    tbl.add_column("savings (relative)", no_wrap=True, width=28)
    tbl.add_column("bytes", justify="right", style="bold green", width=10)
    tbl.add_column("tokens", justify="right", style="bold cyan", width=10)
    tbl.add_column("events", justify="right", style="dim", width=7)
    return tbl


# Bar character set; finer-grained than █░ for half-block resolution.
_BAR_FILL = "█"
_BAR_PARTIAL = "▏▎▍▌▋▊▉"  # 1/8 through 7/8
_BAR_EMPTY = " "

# Sparkline char set; 0/8 (no value) through 8/8 (max).
_SPARK = " ▁▂▃▄▅▆▇█"


def _bar_text(value: int, max_value: int, width: int = 28) -> tuple[str, str]:
    """Return (bar_string, rich_style) where bar uses 1/8-block resolution.

    Style ramps yellow -> green -> cyan as fill grows, giving the eye a
    quick read of relative magnitude across rows.
    """
    if max_value <= 0 or value <= 0:
        return _BAR_EMPTY * width, "dim"
    fill_units = (value / max_value) * width
    whole = int(fill_units)
    remainder = fill_units - whole
    bar = _BAR_FILL * whole
    if whole < width and remainder > 0:
        idx = max(0, min(6, int(remainder * 8) - 1))
        bar += _BAR_PARTIAL[idx]
        bar += _BAR_EMPTY * (width - whole - 1)
    else:
        bar += _BAR_EMPTY * (width - whole)
    # Color graded by saturation ratio.
    ratio = min(1.0, value / max_value)
    if ratio >= 0.66:
        style = "bold cyan"
    elif ratio >= 0.33:
        style = "bold green"
    else:
        style = "yellow"
    return bar, style


def _sparkline(values: list[int]) -> str:
    """Render a sequence of values as a unicode sparkline."""
    if not values:
        return ""
    hi = max(values)
    if hi <= 0:
        return _SPARK[0] * len(values)
    out = []
    for v in values:
        idx = 0 if v <= 0 else max(1, min(8, round((v / hi) * 8)))
        out.append(_SPARK[idx])
    return "".join(out)


def render_text(
    summary: StatsSummary, *, top_days: int = 7, top_projects: int = 5
) -> str:
    """Render stats using the ANSI truecolor renderer.

    Delegates to render.stats_renderer.render_stats() for the rich visual
    output (gradient bars, heatmap, insights). Falls back to the legacy
    rich-based renderer if the render package is unavailable.
    """
    try:
        from .render.stats_renderer import render_stats
        return render_stats(_to_stats_data(summary, top_projects=top_projects))
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("new renderer failed (%s: %s), falling back to rich", type(exc).__name__, exc, exc_info=True)

    try:
        import io

        from rich.box import ROUNDED
        from rich.console import Console
        from rich.panel import Panel
        from rich.text import Text
    except ImportError as exc:
        _LOG.error("rich is not installed; cannot render stats: %s", exc)
        return f"(stats render unavailable: {exc})"

    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=True,
        color_system="truecolor",
        width=80,
        legacy_windows=False,
    )

    window_desc = (
        "all time" if summary.window_days == 0 else f"last {summary.window_days} days"
    )
    from . import __version__  # noqa: PLC0415

    # ---- Headline panel ----
    # Keep label+value pairs as single styled segments so substring matches
    # (e.g. "Total: 2 events") survive the ANSI wrapping.
    headline = Text("\n  ", style="")
    headline.append(f"Total: {summary.total_events:,} events", style="bold magenta")
    headline.append("     ", style="")
    headline.append(
        f"{_fmt_bytes(summary.total_bytes_saved)} saved", style="bold green"
    )
    headline.append("     ", style="")
    headline.append(
        f"~{_fmt_tokens(summary.total_tokens_saved)} tokens (estimated)",
        style="bold cyan",
    )
    headline.append("\n", style="")

    console.print(
        Panel(
            headline,
            title=Text.assemble(
                ("token-goat stats", "bold white"),
                (f"  v{__version__}", "dim"),
                ("  ·  ", "dim"),
                (window_desc, "cyan"),
            ),
            title_align="left",
            border_style="bright_cyan",
            box=ROUNDED,
            padding=(0, 1),
        )
    )

    # ---- By kind ----
    if summary.by_kind:
        console.print()
        console.print(Text("By kind:", style="bold"))
        by_kind = summary.by_kind
        kinds_sorted = sorted(
            by_kind,
            key=lambda k: by_kind[k]["bytes_saved"],
            reverse=True,
        )
        max_bytes = max(
            (by_kind[k]["bytes_saved"] for k in kinds_sorted), default=0
        )
        tbl = _make_stats_table("kind")
        for kind in kinds_sorted:
            v = summary.by_kind[kind]
            bar, bar_style = _bar_text(v["bytes_saved"], max_bytes)
            tbl.add_row(
                kind,
                Text(bar, style=bar_style),
                _fmt_bytes(v["bytes_saved"]),
                _fmt_tokens(v["tokens_saved"]),
                f"{v['events']} ev",
            )
        console.print(tbl)

        img = summary.by_kind.get("image_shrink")
        if img and img["events"] > 0:
            console.print(
                Text(
                    "  note: image token estimates use Claude's vision pricing formula "
                    "(pixel dimensions ÷ 750, capped at 1568 px/side).",
                    style="dim italic",
                )
            )

        hint_gross = summary.by_kind.get("session_hint")
        hint_overhead = summary.by_kind.get("session_hint_overhead")
        if hint_gross and hint_overhead:
            console.print(
                Text(
                    "  note: session_hint shows realized savings; session_hint_overhead "
                    "shows injected hint cost; headline totals are net.",
                    style="dim italic",
                )
            )

    # ---- By source (image / hint / read / compact) ----
    # This view answers the user's most useful question: which of the four
    # mechanisms is contributing most to my savings?  Raw kinds are too
    # granular (image_shrink vs gdrive_image vs webfetch_image all roll up to
    # "image"; session_hint and session_hint_overhead net into "hint").
    if summary.by_source:
        console.print()
        console.print(Text("By source:", style="bold"))
        src = summary.by_source
        sources_sorted = sorted(
            src,
            key=lambda s: src[s]["bytes_saved"],
            reverse=True,
        )
        max_bytes = max((src[s]["bytes_saved"] for s in sources_sorted), default=0)
        tbl = _make_stats_table("source")
        for source in sources_sorted:
            v = src[source]
            bar, bar_style = _bar_text(v["bytes_saved"], max_bytes)
            tbl.add_row(
                source,
                Text(bar, style=bar_style),
                _fmt_bytes(v["bytes_saved"]),
                _fmt_tokens(v["tokens_saved"]),
                f"{v['events']} ev",
            )
        console.print(tbl)

    # ---- By command (symbol / read / section / semantic / etc.) ----
    # This view shows which CLI command is most valuable to the user.
    # Useful for understanding which surgical-read variants are being adopted.
    if summary.by_command:
        console.print()
        console.print(Text("By command:", style="bold"))
        cmds = summary.by_command
        max_bytes = max((c["bytes_saved"] for c in cmds), default=0)
        tbl = _make_stats_table("command")
        for c in cmds:
            bar, bar_style = _bar_text(c["bytes_saved"], max_bytes)
            tbl.add_row(
                c["command"],
                Text(bar, style=bar_style),
                _fmt_bytes(c["bytes_saved"]),
                _fmt_tokens(c["tokens_saved"]),
                f"{c['events']} ev",
            )
        console.print(tbl)

    # ---- Activity sparkline (last 7 days, oldest -> newest) ----
    if summary.by_day:
        days_for_spark = summary.by_day[:top_days]
        # by_day is newest-first; reverse for left-to-right time progression.
        days_chrono = list(reversed(days_for_spark))
        spark_values = [d["events"] for d in days_chrono]
        spark = _sparkline(spark_values)
        date_range = (
            f"{days_chrono[0]['date']} -> {days_chrono[-1]['date']}"
            if len(days_chrono) > 1
            else days_chrono[0]["date"]
        )
        console.print()
        spark_line = Text()
        spark_line.append("Activity ", style="bold")
        spark_line.append(f"({date_range})  ", style="dim")
        spark_line.append(spark, style="bold green")
        console.print(spark_line)

    # ---- By day (top N) ----
    if summary.by_day:
        console.print()
        console.print(Text(f"By day (top {top_days}):", style="bold"))
        days = summary.by_day[:top_days]
        max_bytes = max((d["bytes_saved"] for d in days), default=0)
        tbl = _make_stats_table("date")
        for d in days:
            bar, bar_style = _bar_text(d["bytes_saved"], max_bytes)
            tbl.add_row(
                d["date"],
                Text(bar, style=bar_style),
                _fmt_bytes(d["bytes_saved"]),
                _fmt_tokens(d["tokens_saved"]),
                f"{d['events']} ev",
            )
        console.print(tbl)

    # ---- By project ----
    if summary.by_project:
        console.print()
        console.print(Text(f"By project (top {top_projects}):", style="bold"))
        projs = summary.by_project[:top_projects]
        max_bytes = max((p["bytes_saved"] for p in projs), default=0)
        tbl = _make_stats_table("project")
        for p in projs:
            label = _short_project(p["project_root"])
            bar, bar_style = _bar_text(p["bytes_saved"], max_bytes)
            tbl.add_row(
                label,
                Text(bar, style=bar_style),
                _fmt_bytes(p["bytes_saved"]),
                _fmt_tokens(p["tokens_saved"]),
                f"{p['events']} ev",
            )
        console.print(tbl)
        # Hash + full path below each project row, dimmed.
        # Strip ANSI escapes from project_root before passing to Rich Text():
        # Rich neutralises its own markup but forwards raw ESC bytes to the
        # terminal, so a crafted root path could inject colour/cursor sequences.
        for p in projs:
            safe_root = _strip_ansi(p["project_root"]) if p["project_root"] else "(unknown)"
            console.print(
                Text("    ", style="")
                + Text(f"{p['project_hash'][:8]}  ", style="dim cyan")
                + Text(safe_root, style="dim")
            )

    if summary.total_events == 0:
        console.print()
        console.print(
            Text(
                "(no recorded savings yet. token-goat will accumulate stats as it "
                "intercepts reads, image fetches, etc.)",
                style="dim italic",
            )
        )

    return buf.getvalue()


def render_by_project(summary: StatsSummary, top: int = 10) -> str:
    """Render a focused per-project breakdown table, ordered by tokens saved.

    Shows up to *top* projects. Each row includes the project basename, tokens
    saved, bytes saved, event count, and share of the total. A path sub-row below
    each entry shows the short project hash and full absolute path.

    Falls back gracefully to a plain-text table when rich is unavailable.
    """
    try:
        from .render.stats_renderer import (  # noqa: PLC0415
            _render_by_project_section,
            _render_header,
            _render_kpi_section,
        )
        data = _to_stats_data(summary, top_projects=top)
        sections = [
            _render_header(data),
            _render_kpi_section(data),
            _render_by_project_section(data),
            [""],
        ]
        return "\n".join(line for section in sections for line in section)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("new renderer failed for by-project (%s: %s), falling back", type(exc).__name__, exc)

    try:
        import io

        from rich.console import Console
        from rich.text import Text as RichText
    except ImportError:
        lines = [f"By project (top {top}):"]
        if not summary.by_project:
            lines.append("  (no project data recorded yet)")
            return "\n".join(lines)
        lines.append(f"  {'project':<28}  {'tokens':>10}  {'bytes':>10}  {'events':>7}")
        for p in summary.by_project[:top]:
            label = _short_project(p["project_root"])
            lines.append(
                f"  {label:<28}  {_fmt_tokens(p['tokens_saved']):>10}  "
                f"{_fmt_bytes(p['bytes_saved']):>10}  {p['events']:>7}"
            )
            lines.append(f"    {p['project_hash'][:8]}  {p['project_root'] or '(unknown)'}")
        return "\n".join(lines)

    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=True,
        color_system="truecolor",
        width=80,
        legacy_windows=False,
    )

    projs = summary.by_project[:top]
    if not projs:
        console.print(RichText("(no project data recorded yet)", style="dim italic"))
        return buf.getvalue()

    window_desc = "all time" if summary.window_days == 0 else f"last {summary.window_days} days"
    console.print(RichText(f"By project (top {top})  —  {window_desc}", style="bold"))

    max_bytes = max((p["bytes_saved"] for p in projs), default=0)
    tbl = _make_stats_table("project")
    for p in projs:
        label = _short_project(p["project_root"])
        bar, bar_style = _bar_text(p["bytes_saved"], max_bytes)
        tbl.add_row(
            label,
            RichText(bar, style=bar_style),
            _fmt_bytes(p["bytes_saved"]),
            _fmt_tokens(p["tokens_saved"]),
            f"{p['events']} ev",
        )
    console.print(tbl)
    for p in projs:
        safe_root = _strip_ansi(p["project_root"]) if p["project_root"] else "(unknown)"
        console.print(
            RichText("    ", style="")
            + RichText(f"{p['project_hash'][:8]}  ", style="dim cyan")
            + RichText(safe_root, style="dim")
        )
    return buf.getvalue()


def render_by_command(summary: StatsSummary) -> str:
    """Render a focused per-command breakdown table, ordered by tokens saved.

    Shows all CLI commands with recorded stats, with bytes saved, tokens saved,
    event count, and share of the total for each command.

    Falls back gracefully to a plain-text table when rich is unavailable.
    """
    try:
        from .render.stats_renderer import (  # noqa: PLC0415
            _render_by_command_section,
            _render_header,
            _render_kpi_section,
        )
        data = _to_stats_data(summary)
        sections = [
            _render_header(data),
            _render_kpi_section(data),
            _render_by_command_section(data),
            [""],
        ]
        return "\n".join(line for section in sections for line in section)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("new renderer failed for by-command (%s: %s), falling back", type(exc).__name__, exc)

    try:
        import io  # noqa: PLC0415

        from rich.console import Console  # noqa: PLC0415
        from rich.text import Text as RichText  # noqa: PLC0415
    except ImportError:
        lines = ["By command:"]
        if not summary.by_command:
            lines.append("  (no command data recorded yet)")
            return "\n".join(lines)
        lines.append(f"  {'command':<16}  {'tokens':>10}  {'bytes':>10}  {'events':>7}")
        lines.extend(
            f"  {c['command']:<16}  {_fmt_tokens(c['tokens_saved']):>10}  "
            f"{_fmt_bytes(c['bytes_saved']):>10}  {c['events']:>7}"
            for c in summary.by_command
        )
        return "\n".join(lines)

    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=True,
        color_system="truecolor",
        width=80,
        legacy_windows=False,
    )

    cmds = summary.by_command
    if not cmds:
        console.print(RichText("(no command data recorded yet)", style="dim italic"))
        return buf.getvalue()

    window_desc = "all time" if summary.window_days == 0 else f"last {summary.window_days} days"
    console.print(RichText(f"By command  —  {window_desc}", style="bold"))

    max_bytes = max((c["bytes_saved"] for c in cmds), default=0)
    tbl = _make_stats_table("command")
    for c in cmds:
        bar, bar_style = _bar_text(c["bytes_saved"], max_bytes)
        tbl.add_row(
            c["command"],
            RichText(bar, style=bar_style),
            _fmt_bytes(c["bytes_saved"]),
            _fmt_tokens(c["tokens_saved"]),
            f"{c['events']} ev",
        )
    console.print(tbl)
    return buf.getvalue()
