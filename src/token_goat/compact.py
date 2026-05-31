"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

__all__ = [
    "build_manifest",
    "build_manifest_with_count",
    "build_manifest_adaptive",
    "compute_adaptive_budget",
    "event_count",
    "is_noise_path",
    "_dedup_grep_entries",
    "_build_sealed_block",
    "_format_hint_telemetry",
    "_get_inline_diff_for_file",
    "_get_whole_repo_diff",
]

import hashlib
import heapq
import io
import json
import math
import os
import re
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from operator import attrgetter, itemgetter
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import urlparse

from . import paths
from .cache_common import short_content_hash as _short_content_hash
from .cache_common import short_output_id as _short_id
from .config import Config as _Config
from .config import load as _load_config
from .hooks_common import sanitize_log_str
from .util import _humanize_bytes, ellipsize, get_logger
from .util import run_git as _util_run_git


def __getattr__(name: str) -> object:
    """Lazy-load heavy submodules on first attribute access.

    ``session_mod`` is deferred so importing ``compact`` during the PreCompact
    hook cold-start does not pay the cost of loading ``session`` (and its
    transitive deps) until the first actual call to ``build_manifest`` /
    ``event_count``.  Saves ~25 ms on Windows cold-subprocess startup.

    The attribute is intentionally NOT written back to the module dict so that
    ``unittest.mock.patch("token_goat.compact.session_mod.X")`` continues to
    work: patch resolves the target by calling ``getattr(compact_mod,
    "session_mod")`` on each enter/exit, which goes through ``__getattr__``
    every time — no stale reference is cached in the module namespace.
    """
    if name == "session_mod":
        from . import session as _session  # noqa: PLC0415
        return _session
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _norm_key(path: object) -> str:
    """Return the case-insensitive normalized path key used in compact lookups."""
    return paths.normalize_key(str(path)).lower()


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~3 chars/token (conservative vs. the true 3.5 ratio).

    Inlined from repomap.estimate_tokens to avoid loading repomap (and its db
    dependency) during the PreCompact hook cold-start, which runs as a separate
    Python process on Windows with no shared module cache.
    """
    return max(1, len(text) // 3 + 1)

if TYPE_CHECKING:
    from .session import FileEntry, SessionCache

_LOG = get_logger("compact")


def _run_git(args: list[str], cwd: str, timeout: float = 5) -> str | None:
    """Run ``git <args>`` in *cwd* and return stripped stdout, or ``None`` on failure.

    Returns ``None`` when git is not found, the working directory does not exist,
    the process times out, the exit code is non-zero, or the output is empty.

    Item #31: only ``OSError`` (covers ``FileNotFoundError`` / ``PermissionError``)
    and ``subprocess.SubprocessError`` (covers ``CalledProcessError`` /
    ``TimeoutExpired``) are swallowed — programming errors like
    ``AttributeError`` or assertion failures are allowed to propagate so they
    surface in tests instead of being silently masked.  Aligns with the
    ``util.run_git`` convention.

    Delegates to ``util.run_git`` for consistent kwargs (encoding, errors, lock avoidance).
    """
    import subprocess  # noqa: PLC0415  — keep import lazy for hook cold-start

    try:
        result = _util_run_git(args, cwd=cwd, timeout=timeout)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


# Wall-clock timeout for build_manifest() to prevent the PreCompact hook from stalling.
# The function makes git subprocess calls which may hang on network mounts or large repos.
# This is a belt-and-suspenders guard: individual git subprocesses have their own 2-5s
# timeouts, but the overall function has an 8s wall-clock limit so the hook always
# returns within a reasonable time, even if multiple git calls run sequentially.
_MANIFEST_TIMEOUT_SECS: Final[float] = 8.0

# Maximum files listed in the "files read" section of the manifest.  The compaction
# LLM needs the most-accessed files to know what context mattered, but listing every
# file read in a long session would blow the token budget.  10 covers the handful of
# core files a typical feature or bug-fix session touches.
_MAX_FILES_READ: Final[int] = 10
# Maximum files that show per-symbol detail in the manifest.  Fewer than _MAX_FILES_READ
# because symbol lists are verbose (one line each); limiting to 8 keeps the symbols
# section from dominating a 400-token budget and crowding out the edited-files section.
_MAX_SYMBOLS_FILES: Final[int] = 8
# Maximum line-ranges shown per file.  Ranges help the compaction LLM understand *which
# parts* of a file were read, but beyond 4 ranges the list becomes noise — if a file
# was read in 5+ disjoint slices the whole-file summary conveys more than a range list.
_MAX_RANGES_PER_FILE: Final[int] = 4
# Max symbols listed per file entry in the manifest (separate from _MAX_SYMBOLS_FILES,
# which caps the number of *files* that show any symbols at all).
_MAX_SYMBOLS_PER_FILE_ENTRY: Final[int] = 6
# Maximum number of cached Bash commands listed in the manifest.  Bash entries
# preserve the test/build context most likely to drive the next agent turn
# (a green pytest, a failing build, the most recent git log), but listing every
# command across a long session would crowd out higher-priority sections.  Six
# covers the typical iterate-test-fix-test-commit cycle without dominating the
# budget — most sessions accumulate fewer than that.
_MAX_BASH_ENTRIES: Final[int] = 6
# Maximum pending/in-progress TaskList entries shown in the ### TODOs section.
# Five covers the typical feature-branch task list without consuming too much of
# the manifest budget; additional tasks get an overflow note.
_MAX_TODO_ENTRIES: Final[int] = 5
# Max characters for a task subject in the manifest.  Subjects are user-authored
# strings of arbitrary length; truncating at 50 chars keeps each line short
# enough to fit the compact token budget without losing the essential meaning.
_MAX_TODO_SUBJECT_CHARS: Final[int] = 50
# Smallest cached Bash output worth surfacing in the manifest.  Below ~400 bytes
# the dedup hint suppresses on size anyway, and the manifest line itself costs
# tokens that would not be paid back even if the agent acted on the hint.
_MIN_BASH_BYTES_FOR_MANIFEST: Final[int] = 400

# Maximum web fetches listed in the "Web Fetches" section of the manifest.
# Web fetches capture documentation, API responses, and external context the
# agent loaded mid-session.  Four entries cover the common case (fetch a docs
# page, maybe an API reference or two) without crowding the bash section.
_MAX_WEB_ENTRIES: Final[int] = 4
# Smallest cached web body worth surfacing in the manifest.  Small fetches
# (redirects, tiny JSON blobs) don't pay back the manifest line's token cost.
_MIN_WEB_BYTES_FOR_MANIFEST: Final[int] = 200

# Sentinel gap used by session.mark_file_read() when no line limit is specified.
# A range whose (end - start) equals this value represents "whole file read, extent
# unknown" — _format_ranges() annotates these as "(full)" rather than printing
# "lines 1-100000", so the compaction LLM knows the entire file was in context.
# Value mirrors session._UNKNOWN_END_SENTINEL (99_999); inlined here to avoid
# importing session at module level so the PreCompact hook cold-start stays fast.
_FULL_READ_SENTINEL_GAP: Final[int] = 99_999

# Files read this many times or more are "hot" — the model knows them intimately.
# Listing them individually wastes manifest lines on content the compaction LLM
# would never evict. Consolidate to a single summary line instead.
_HOT_FILE_READ_THRESHOLD: Final[int] = 5

# Maximum number of hot files shown by name in the consolidated summary line.
# Beyond this, a "+N more" suffix is appended so the line stays compact.
_HOT_FILE_MAX_SHOWN: Final[int] = 6

# Maximum glob patterns listed in the "Directory Scans" section.  Three entries
# cover the typical file-discovery queries without crowding higher-priority sections.
_MAX_GLOB_ENTRIES: Final[int] = 3

# Maximum grep patterns listed in the "Patterns Searched" section.  Grep entries
# give the compaction LLM context about what the user was investigating, but beyond
# 5 patterns the list becomes noise — the most-recently-searched ones dominate anyway.
_MAX_GREP_ENTRIES: Final[int] = 5

# Grep patterns older than this are considered stale and dropped from the manifest.
# 45 minutes is a practical session horizon: patterns from more than 45 minutes ago
# predate most recent context switches and carry little signal for the upcoming compact.
# If *all* patterns are older than this threshold, the 2 most recent are surfaced anyway
# so the section is never entirely empty when searches exist.
_GREP_STALE_SECS: Final[int] = 2700  # 45 minutes

# Kept for external callers (e.g. tests) that may reference the old name.  The new
# constant _GREP_STALE_SECS is the authoritative staleness threshold used internally.
_GREP_MANIFEST_STALE_SECS: Final[int] = _GREP_STALE_SECS

# Minimum number of grep entries to show even when all are stale.  Avoids rendering
# an empty "Patterns Searched" section when the session only has old searches.
_GREP_MIN_WHEN_ALL_STALE: Final[int] = 2

# Half-life used by the grep recency weight in _select_top_grep_entries.
# At age=0 weight=1.0; at age=30min weight≈0.5; at age=45min weight≈0.35.
# The weight is multiplied by a normalised match_count so high-result searches
# that are still recent beat zero-result searches of the same age.
_GREP_RECENCY_HALF_LIFE_SECS: Final[float] = 1800.0  # 30 minutes

# Hard ceiling on the max_tokens parameter accepted by build_manifest.
# The config layer sets a sensible default (400) but build_manifest is also part of
# the public API.  Without a cap, a caller could pass an arbitrarily large value,
# causing the manifest construction pass to allocate and render all sections before
# the trim loop brings it back down — a pointless memory/CPU spike with no benefit.
_MAX_MANIFEST_TOKENS_CAP: Final[int] = 4_000
# Manifest delta-cache TTL (item #19).  If less than this many seconds have elapsed
# since the last emit AND the rendered text is byte-for-byte identical, return a
# brief stub instead of rebuilding.  Force a full rebuild after 10 min regardless.
_MANIFEST_CACHE_TTL_SECS: Final[float] = 600.0
# Process-local set of session IDs for which we wrote a new manifest SHA this
# process run.  On Windows Claude Code launches a fresh hook process per tool
# call, so this set is always empty at the start of a hook invocation — the
# cache-hit path is only reachable when the SHA was written by a *prior* process
# (i.e., a prior PreCompact fire).  In tests (same process, multiple calls) the
# set prevents a false stub on the call that immediately follows a write.
_manifest_sha_written_this_process: set[str] = set()

# ---------------------------------------------------------------------------
# Manifest sidecar helpers (item #1 of 2026-05-24 design)
# ---------------------------------------------------------------------------
# The sidecar file ``sentinels/manifest_sha_{session_id}`` stores a small JSON
# record: {"sha": <hex>, "fp": <fingerprint-hex>, "ts": <float>}.  Reading it
# is ~0.1 ms (stat + open + json.loads on a 200-byte file) vs ~5–50 ms for a
# full manifest render, so the fast-path saves meaningful wall time as well as
# ~300–600 tokens per redundant compaction.

def _compute_manifest_fingerprint(cache: SessionCache) -> str:  # type: ignore[name-defined]
    """Return a hex fingerprint that changes when manifest-driving state changes.

    The sidecar cache must invalidate when the session state that feeds the
    rendered manifest changes: file access details, edits, grep history, bash /
    web / skill / glob history, bash dedup exclusions, cwd, and the current
    age tier. Build-manifest bookkeeping fields are intentionally excluded.
    """

    def _entry_payload(entry: object) -> object:
        if hasattr(entry, "__dataclass_fields__"):
            entry_dict = asdict(entry)  # type: ignore[call-overload]
            # Exclude symbols_ts from FileEntry — it changes on every symbol access
            # but doesn't affect the manifest output (only symbols_read matters).
            # This prevents unnecessary fingerprint cache invalidation.
            if isinstance(entry_dict, dict) and "symbols_ts" in entry_dict:
                entry_dict = {k: v for k, v in entry_dict.items() if k != "symbols_ts"}
            return entry_dict
        return entry

    def _dict_payload(mapping: object) -> dict[str, object]:
        if not isinstance(mapping, dict) or not mapping:
            return {}
        return {str(key): _entry_payload(mapping[key]) for key in sorted(mapping)}

    def _list_payload(items: object) -> list[object]:
        if not isinstance(items, list) or not items:
            return []
        return [_entry_payload(item) for item in items]

    now = time.time()
    created_ts = float(getattr(cache, "created_ts", 0.0) or 0.0)
    age_tier = _session_age_tier(max(0.0, now - created_ts))
    edited_files = cache.edited_files if isinstance(cache.edited_files, dict) else {}
    bash_dedup_ids = sorted(getattr(cache, "bash_dedup_emitted_ids", set()) or [])

    hints_emitted = int(getattr(cache, "hints_emitted", 0) or 0)
    _suppressed_raw = getattr(cache, "hints_suppressed_by_type", None) or {}
    hints_suppressed = sum(_suppressed_raw.values()) if isinstance(_suppressed_raw, dict) else 0

    payload = json.dumps(
        {
            "age_tier": age_tier,
            "bash_dedup_emitted_ids": bash_dedup_ids,
            "bash_history": _dict_payload(getattr(cache, "bash_history", None)),
            "cwd": getattr(cache, "cwd", None),
            "decisions": _list_payload(getattr(cache, "decisions", None)),
            "edited_files": sorted(edited_files.items()),
            "files": _dict_payload(getattr(cache, "files", None)),
            "glob_history": _list_payload(getattr(cache, "glob_history", None)),
            "greps": _list_payload(getattr(cache, "greps", None)),
            "hints_emitted": hints_emitted,
            "hints_suppressed": hints_suppressed,
            "skill_history": _dict_payload(getattr(cache, "skill_history", None)),
            "web_history": _dict_payload(getattr(cache, "web_history", None)),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# Sidecar payload version.  v1 = {sha, fp, ts}.  v2 adds {counts: {...}} for
# item #26 (Manifest Delta).  Bumping `_SIDECAR_VERSION` is how we ensure that
# legacy v1 sidecars are gracefully ignored when the reader expects v2 fields.
_SIDECAR_VERSION: Final[int] = 2


def _read_manifest_sidecar(
    session_id: str,
) -> tuple[str, str, float, dict[str, int] | None] | None:
    """Read the manifest sidecar and return (sha, fingerprint, emit_ts, counts) or None.

    *counts* is a small dict of section-element counts from the prior render
    (``{"edited": N, "bash": N, ...}``) used by item #26's Manifest Delta
    section, or ``None`` for v1 sidecars / when the field is absent / malformed.
    All other parse errors return ``None`` for the whole tuple.
    """
    from . import paths  # noqa: PLC0415

    try:
        sidecar = paths.manifest_sha_sidecar_path(session_id)
        raw = sidecar.read_text(encoding="utf-8")
        data = json.loads(raw)
        sha = str(data["sha"])
        fp = str(data["fp"])
        ts = float(data["ts"])
        # Non-finite ts (NaN, inf) would compare-false in every cache-hit
        # predicate but the upstream caller has no reason to inspect for it.
        # Treat the whole sidecar as unreadable to keep the contract simple
        # (returns None → caller rebuilds).  Empty sha/fp likewise indicate a
        # corrupted write — refuse to surface them as a cache key.
        import math  # noqa: PLC0415
        if not math.isfinite(ts) or not sha or not fp:
            return None
        # Best-effort extraction of v2 counts.  A v1 sidecar (no "counts" key)
        # OR a malformed counts dict yields counts=None — the caller falls back
        # to skipping the delta section, never crashes.
        counts_raw = data.get("counts")
        counts: dict[str, int] | None = None
        if isinstance(counts_raw, dict):
            try:
                counts = {str(k): int(v) for k, v in counts_raw.items()}
            except (TypeError, ValueError):
                counts = None
        return sha, fp, ts, counts
    except Exception:  # noqa: BLE001
        return None


def _write_manifest_sidecar(
    session_id: str,
    sha: str,
    fingerprint: str,
    ts: float,
    counts: dict[str, int] | None = None,
) -> None:
    """Write the manifest sidecar atomically.  Errors are silently swallowed.

    *counts* (item #26): per-section element counts emitted in the current
    manifest, persisted so the next compact can compute a "Δ since last compact"
    line.  Omitted (or empty) → no counts written, treated as v1-compatible.
    """
    from . import paths  # noqa: PLC0415

    try:
        sidecar = paths.manifest_sha_sidecar_path(session_id)
        paths.ensure_dir(sidecar.parent)
        payload_dict: dict[str, object] = {
            "v": _SIDECAR_VERSION,
            "sha": sha,
            "fp": fingerprint,
            "ts": ts,
        }
        if counts:
            payload_dict["counts"] = {k: int(v) for k, v in counts.items()}
        payload = json.dumps(payload_dict, separators=(",", ":"), sort_keys=True)
        paths.atomic_write_text(sidecar, payload)
    except Exception:  # noqa: BLE001
        pass


def _compute_section_counts(cache: object) -> dict[str, int]:
    """Return per-section element counts for the current cache snapshot.

    Used by item #26 (Manifest Delta) to persist a small fingerprint of "how
    much was in the manifest last time" so the next compact can show what grew.
    Defensive ``getattr`` calls so a legacy/test cache without one of these
    fields contributes 0 rather than raising.
    """
    def _len(obj: object) -> int:
        try:
            return len(obj)  # type: ignore[arg-type]
        except (TypeError, AttributeError):
            return 0

    files: object = getattr(cache, "files", None) or {}
    return {
        "edited": _len(getattr(cache, "edited_files", None) or {}),
        "files": _len(files),
        "bash": _len(getattr(cache, "bash_history", None) or {}),
        "web": _len(getattr(cache, "web_history", None) or {}),
        "grep": _len(getattr(cache, "greps", None) or []),
        "glob": _len(getattr(cache, "glob_history", None) or []),
        "skill": _len(getattr(cache, "skill_history", None) or {}),
        "decision": _len(getattr(cache, "decisions", None) or []),
        "symbols": sum(
            1 for e in (files.values() if hasattr(files, "values") else [])  # type: ignore[union-attr]
            if getattr(e, "symbols_read", None)
        ),
    }


def _format_manifest_delta(
    prior: dict[str, int] | None, current: dict[str, int]
) -> str | None:
    """Item #26: return a one-line delta string or None.

    Format:  ``**Δ since last compact:** +2 edited, +3 bash``

    - Returns None if *prior* is None (no prior sidecar; first compact).
    - Returns None when no section count changed (manifest is steady-state).
    - Reports both growth (+N) and shrinkage (-N) — a shrink usually means
      session reset / cache trim and is just as informative.
    - Section order is fixed (most load-bearing first) so the line is stable
      across compactions and easy to scan.
    """
    if not prior:
        return None
    # Stable display order — matches the manifest's own section emission order.
    _ORDER = ("edited", "files", "bash", "web", "grep", "glob", "skill", "decision", "symbols")
    parts: list[str] = []
    for key in _ORDER:
        cur = int(current.get(key, 0))
        old = int(prior.get(key, 0))
        delta = cur - old
        if delta == 0:
            continue
        sign = "+" if delta > 0 else ""
        parts.append(f"{sign}{delta} {key}")
    if not parts:
        return None
    return "**Δ since last compact:** " + ", ".join(parts)


# Maximum number of edited files listed individually in the "Files Edited" section.
# The section is documented as "uncapped — every edited file is must-preserve", but
# in practice a session that touches 30–100 files (e.g. a large refactor or mass
# rename) would let the edited-files block alone consume the entire 400-token budget,
# squeezing out the Symbols Accessed and other variable sections that carry the most
# useful compaction signal.  Cap at 20: the top-20 most-edited files are listed by
# name (sorted by edit count descending), and any overflow gets a single "+N more
# edited" line so the compaction LLM knows additional files exist without paying the
# per-line token cost.  20 files × ~13 tokens/line ≈ 260 tokens, leaving ~140 for
# the rest of the sections at a 400-token budget.
_MAX_EDITED_FILES_SHOWN: Final[int] = 20

# Key for sorting edited_files dict items by edit count (the second element of each pair).
# Defined at module level so it is created once rather than re-created on every manifest build.
_BY_EDIT_COUNT = itemgetter(1)

# Composite sort key for FileEntry: primary read_count (descending), secondary
# last_read_ts (descending).  Using a tuple from attrgetter means heapq.nlargest
# compares both fields in one step — files tied on read_count are broken by
# recency, so the most recently touched files rise in the Key Files Read section.
_BY_READ_COUNT_THEN_TS = attrgetter("read_count", "last_read_ts")

# Attribute-based key for sorting FileEntry objects by recency.
# Used to rank "Symbols Accessed" entries — most-recently-touched first
# (the symbols a user just inspected are more load-bearing for the upcoming
# compaction than ones touched at the start of a long session).
_BY_LAST_READ_TS = attrgetter("last_read_ts")

# Same idea, applied to BashEntry — most-recently-run commands are the ones
# whose output the compaction LLM most needs to preserve as context.
_BY_BASH_TS = attrgetter("ts")

# Age threshold (seconds) for flagging cached Bash outputs as cold / evictable.
# Outputs this old are unlikely to be actively iterated on; surfacing them in
# the manifest lets the compaction LLM know they can be dropped from context.
_COLD_OUTPUT_AGE_SECS: Final[int] = 1_800  # 30 minutes

# Maximum cold bash entries surfaced in the "Cold Outputs" manifest section.
_MAX_COLD_OUTPUTS: Final[int] = 4

# Maximum skills surfaced in the "Active Skills" manifest section.  Sessions
# load a handful of skills at most (Ralph + improve + a few specialist skills);
# 6 covers any realistic session without crowding higher-priority blockers.
_MAX_ACTIVE_SKILLS: Final[int] = 6

# Skills not loaded in the last N minutes are excluded from the manifest to avoid
# cluttering with "done" skills.  30 minutes is conservative: a typical task may
# involve loading multiple skills sequentially (1–2 min each); 30 min covers that
# plus a buffer for quick re-invocations of the same skill without stale noise.
_SKILL_STALE_THRESHOLD_SECS: Final[int] = 30 * 60

# Skills loaded more than N hours ago are flagged as potentially stale (old-session
# data). Used in _format_skill_entry to warn the post-compact agent that the
# cached body may be outdated if the underlying skill file was updated since.
_SKILL_STALE_FOR_SESSION_SECS: Final[int] = 6 * 3600  # 6 hours

# Maximum decisions surfaced in the **Decisions:** manifest section.  Opt-in via
# ``token-goat decision "<text>"``, so the volume is self-limited — typical
# sessions log 0–3 decisions per task.  5 covers heavier sessions while keeping
# the section bounded; older entries are still on disk for ``token-goat
# decision --list`` recall.
_MAX_DECISIONS: Final[int] = 5
# Hard per-line cap when rendering a decision into the manifest.  Long enough
# to surface the reasoning ("Chose option A because Y; rejected B due to Z")
# but short enough that 5 entries fit comfortably in a 60–80 token slice.
_MAX_DECISION_RENDER_LEN: Final[int] = 140


# Minimum weighted activity score required to emit a full session manifest.
# Below this floor the manifest is suppressed entirely (or replaced by a 1-line
# stub) because there is not enough session context worth preserving across a
# compaction.  The weights are:
#   edited_files  × 2  — edits are the most load-bearing signal
#   bash_history  × 1  — commands run are secondary context
#   web_history   × 1  — web fetches are secondary context
#   skill_history × 1  — loaded skills are useful but lighter
#   active blockers × 5  — a current failure is always worth surfacing
# A score of 3 means roughly: 1 edit + 1 bash run, or 2 edits, or 3 fetches.
# Short sessions (a single file read, no edits, no commands) score 0 and are
# suppressed — there is nothing to preserve.
_ACTIVITY_FLOOR: Final[int] = 3

# TTL for the process-level git diff stat summary cache (seconds).
# `_get_git_diff_stat_summary` runs two git subprocesses per call; caching
# avoids repeated invocations when build_manifest is called in quick succession
# (e.g. `token-goat compact-hint --session-id <id>` runs, then PreCompact fires).
_DIFF_STAT_SUMMARY_TTL: Final[float] = 30.0
# Cache: {cwd_str → (result, monotonic_timestamp)}
_diff_stat_summary_cache: dict[str | None, tuple[str, float]] = {}

# Parallel cache for `_get_uncommitted_changes` (two git subprocesses per call,
# called from both compute_adaptive_budget and _render during the same manifest
# build). Same TTL semantics as the diff-stat cache above.
_uncommitted_changes_cache: dict[str | None, tuple[str | None, float]] = {}

# Item #35: LRU cap for the process-level caches above.  Long-lived worker
# processes can hit hundreds of project switches over a session; an unbounded
# dict slowly leaks memory and degrades dict-lookup performance.  32 is enough
# for the common case (one or two repos under active iteration) with headroom
# for monorepo sub-projects, and small enough that eviction overhead is trivial.
_DIFF_STAT_CACHE_MAX_ENTRIES: Final[int] = 32


def _put_bounded(cache: dict, key: object, value: object) -> None:
    """Insert *value* under *key* in *cache*, evicting the oldest entry past the cap.

    Dict insertion order is FIFO in CPython 3.7+, so popping ``next(iter(cache))``
    removes the oldest key — close enough to LRU for these caches (TTL-bounded
    + write-once-per-key) without the OrderedDict bookkeeping overhead.
    """
    if key in cache:
        # Re-insert so the key becomes the most-recently-touched entry.
        del cache[key]
    elif len(cache) >= _DIFF_STAT_CACHE_MAX_ENTRIES:
        # Drop the oldest entry to make room.
        try:
            oldest = next(iter(cache))
        except StopIteration:  # pragma: no cover — empty dict, len == 0
            oldest = None
        if oldest is not None:
            cache.pop(oldest, None)
    cache[key] = value

# Process-level cache for _is_git_repo() results.
# A single stat() call per cwd is enough for the lifetime of the hook process
# (the working directory doesn't change between git repo and non-git repo
# within a single hook invocation). Saves ~30–60 ms per non-git cwd by
# avoiding two git subprocess spawns per helper.
_is_git_repo_cache: dict[str, bool] = {}

# Maximum number of failed bash commands surfaced in the "Current Blockers" section.
# Three is enough to identify the active failure without crowding the header.
_MAX_BLOCKER_ENTRIES: Final[int] = 3

# Failed commands older than this are not considered active blockers.
# 60 minutes: if a command failed more than an hour ago the agent has likely
# already moved on and the failure is no longer the immediate problem.
_BLOCKER_STALE_SECS: Final[int] = 3600  # 60 minutes

# Half-life for the recency component of _importance_score, in seconds.
# At t=0 the recency bonus is 3.0; at t=30min it is ~1.5; at t=60min it is ~0.75.
# Files read within the last 5 minutes receive a bonus close to the full 3.0.
_RECENCY_HALF_LIFE_SECS: Final[float] = 1800.0  # 30 minutes

# Noise file extensions and basenames that should never enter the manifest.
# These files are build artifacts, OS metadata, or auto-generated lockfiles that
# the compaction LLM does not need to "preserve" — listing them wastes budget on
# items that carry no semantic information about the user's work.  Keep the set
# small and conservative: false negatives (a real file mistakenly skipped) are
# worse than false positives (a noise file slipping through).
_NOISE_EXTS: Final[frozenset[str]] = frozenset({
    ".pyc", ".pyo", ".pyd",          # Python bytecode / extension binaries
    ".class",                          # Java
    ".o", ".obj", ".a", ".lib", ".dll", ".so", ".dylib",  # compiled native
    ".log",                            # log files
    ".tmp", ".temp", ".swp", ".swo",  # editor / scratch files
    ".bak",                            # backup files
    ".pid",                            # daemon/process id files
    ".lock",                           # generic lockfiles (worker locks, etc.)
})
_NOISE_BASENAMES: Final[frozenset[str]] = frozenset({
    ".ds_store", "thumbs.db", "desktop.ini",  # OS metadata
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",  # JS lockfiles
    "poetry.lock", "uv.lock", "pdm.lock",                # Python lockfiles
    "cargo.lock",                                         # Rust lockfile
    "composer.lock", "gemfile.lock",                      # PHP/Ruby lockfiles
    "coverage.xml", ".coverage", "lcov.info",            # coverage artifacts
})
# Path-substring noise markers — any normalized path containing one of these
# segments is considered noise.  Forward-slash form because _short_path already
# normalises backslashes; the matcher runs against the un-shortened normalized
# path so it works regardless of where the segment appears in the tree.
_NOISE_SEGMENTS: Final[tuple[str, ...]] = (
    "/__pycache__/", "/.git/", "/node_modules/", "/.venv/", "/venv/",
    "/dist/", "/build/", "/.mypy_cache/", "/.pytest_cache/", "/.ruff_cache/",
    "/appdata/local/temp/", "/appdata/roaming/",
    "/tmp/",  # Unix temp dir — ephemeral files (improve_commit_msg, etc.)
    # Frontend build outputs and framework caches
    "/.next/", "/.nuxt/", "/.svelte-kit/", "/.turbo/", "/.parcel-cache/",
    # General-purpose cache dirs (one level up from .pytest_cache etc.)
    "/.cache/", "/.tox/",
    # Coverage outputs
    "/coverage/", "/.nyc_output/",
    # Python virtualenv / package payloads installed under the project tree
    "/site-packages/", ".egg-info/",
    # Rust / JVM compiled output
    "/target/",
)


def _importance_score(entry: FileEntry, now: float, edit_bonus: float = 0.0) -> float:
    """Composite importance score for manifest ranking of 'Key Files Read' entries.

    Combines four signals so the most genuinely important files rise to the top
    of the manifest, not just the most-frequently-polled ones:

    - **read_score**: raw read frequency, capped at 10 to avoid dominating.
    - **symbol_score**: each unique symbol accessed adds 2.0 — a file read once
      for a specific function is more load-bearing than one blindly scanned.
    - **edit_bonus**: 15.0 when the file was edited this session, 0.0 otherwise.
      (Edited files are *already* pinned in the 'Files Edited' section; this
      bonus only affects files that are in ``files_clean`` but NOT in
      ``edited_files`` — i.e. files that were both read and edited but whose
      edited-section entry predates the read, or files whose edit path key
      differs slightly from their read key.)
    - **recency**: exponential decay with a 30-minute half-life so a file read
      five minutes ago outweighs one read two hours ago even when counts tie.

    Args:
        entry:      A :class:`session.FileEntry` with ``read_count``,
                    ``symbols_read``, and ``last_read_ts`` attributes.
        now:        Current Unix timestamp (``time.time()``).  Passed in so the
                    caller can snapshot it once per render pass rather than
                    calling ``time.time()`` per entry.
        edit_bonus: Additional score for files edited this session.  The caller
                    passes 15.0 when ``entry``'s path is in ``edited_files``,
                    0.0 otherwise.

    Returns:
        A float importance score.  Higher is more important.
    """
    # Base: read frequency, capped so a file read 50× doesn't drown symbol signal.
    read_score = min(entry.read_count, 10) * 1.0
    # Symbol bonus: each unique symbol is strong evidence the agent used this file.
    symbol_score = min(len(entry.symbols_read), 20) * 2.0
    # Recency bonus: exponential decay, half-life = 30 minutes.
    age_seconds = max(0.0, now - entry.last_read_ts)
    recency = math.exp(-age_seconds * math.log(2) / _RECENCY_HALF_LIFE_SECS)
    return read_score + symbol_score + edit_bonus + recency * 3.0


def is_noise_path(path: str) -> bool:
    """Return True when *path* should be excluded from the manifest as low-value noise.

    Build artifacts (``.pyc``, ``.o``), OS metadata (``.DS_Store``,
    ``Thumbs.db``), lockfiles (``package-lock.json``, ``poetry.lock``), and
    cache directories (``__pycache__/``, ``.git/``, ``node_modules/``) carry
    no information the compaction LLM needs to preserve, and would otherwise
    eat into the manifest's strict token budget.

    Also filters temporary files in /tmp/, Windows temp paths (AppData/Local/Temp,
    AppData/Roaming), and loop-state files (.improve-state-*.json,
    improve_commit_msg_*.txt) created by automation tools.

    Matching is case-insensitive and tolerant of both POSIX and Windows
    separators.  Returns False for any empty or malformed input.
    """
    if not path:
        return False
    p = _norm_key(path)
    # Path-segment check first: catches whole noise directories regardless of
    # the file's own extension (e.g. ``project/.venv/lib/foo.py``).
    for segment in _NOISE_SEGMENTS:
        if segment in p:
            return True
    # Basename and extension checks — slice once and reuse.
    slash_idx = p.rfind("/")
    basename = p[slash_idx + 1:] if slash_idx >= 0 else p
    if basename in _NOISE_BASENAMES:
        return True
    # Basename prefix checks: ephemeral state files from automation tools.
    if basename.startswith(".improve-state-") or basename.startswith("improve_commit_msg_"):
        return True
    dot_idx = basename.rfind(".")
    return dot_idx >= 0 and basename[dot_idx:] in _NOISE_EXTS


def _get_git_diff_stat(
    edited_paths: list[str],
    cwd: str | None,
) -> str | None:
    """Get git diff --stat output for edited files, truncated to 8 lines and 200 chars.

    Returns a formatted string like:
        src/foo.py    | 12 ++++-----
        src/bar.py    |  3 +-

    Or None if: git unavailable, not a repo, no differences, or cwd is None.

    Timeout: 2 seconds. Output is capped at 8 lines and 200 characters total.
    """
    if not cwd or not edited_paths:
        return None

    raw = _run_git(["diff", "--stat", "HEAD", "--"] + edited_paths, cwd, timeout=2)
    if not raw:
        return None
    # Filter out summary line (contains "file changed" / "insertions")
    diff_lines = [
        line for line in raw.splitlines()
        if "file changed" not in line.lower() and "insertion" not in line.lower()
    ]
    if not diff_lines:
        _LOG.debug("_get_git_diff_stat: no diff lines after filtering summary")
        return None

    # Truncate to 8 lines and cap total at 200 chars.
    output = "\n".join(diff_lines[:8])
    if len(output) > 200:
        output = output[:200].rsplit("\n", 1)[0]
    return output


_INLINE_DIFF_MAX_BYTES: Final[int] = 500  # per-file diff size gate (#7)
_INLINE_DIFF_TOTAL_CAP: Final[int] = 800  # total inlined diff bytes in manifest (#7); ~200 tokens at typical code density (4 bytes/token).
# NOTE: _INLINE_DIFF_TOTAL_CAP is denominated in bytes, while the manifest budget
# (_render's max_tokens arg) is denominated in tokens.  The inline diff section can
# therefore consume up to ~200 tokens without the token-budget system being aware.
# For the default 400-token manifest this is ≤50 % of budget, acceptable because
# inline diffs displace the (lower-value) edited-file list entries they replace.
# If the manifest budget is shrunk significantly, revisit this constant or convert
# it to a token-denominated cap derived from max_tokens.
_SINGLE_FILE_DIFF_CAP: Final[int] = 400  # whole-repo diff cap for single-file replace (#17)

# Item #2: short-TTL cache for the whole-repo ``git diff HEAD`` output keyed
# by cwd.  ``_get_whole_repo_diff`` and ``_get_inline_diff_for_file`` both
# need the diff; running git separately for each path multiplies the
# subprocess cost across a manifest build.  We fetch once, slice for the
# per-file callers, and let the TTL expire so a fresh diff is picked up
# between consecutive PreCompact fires.
_WHOLE_DIFF_TTL_SECS: Final[float] = 30.0
_whole_diff_cache: dict[str, tuple[str | None, float]] = {}


def _fetch_whole_repo_diff_cached(cwd: str) -> str | None:
    """Return the full ``git diff HEAD`` output for *cwd*, cached for the TTL.

    Returns ``None`` when git is unavailable, the repo has no diff, or the
    subprocess fails.  Empty-string is normalised to ``None`` so callers can
    use the simple ``if diff is None`` idiom.
    """
    if not cwd:
        return None
    now = time.monotonic()
    cached = _whole_diff_cache.get(cwd)
    if cached is not None and now - cached[1] < _WHOLE_DIFF_TTL_SECS:
        return cached[0]
    diff = _run_git(["diff", "--no-color", "HEAD"], cwd, timeout=1.5)
    _put_bounded(_whole_diff_cache, cwd, (diff, now))
    return diff


def _slice_diff_for_file(whole_diff: str, path: str) -> str | None:
    """Extract the per-file segment for *path* from a full ``git diff HEAD`` output.

    Splits *whole_diff* on the ``diff --git`` boundary that opens each file's
    section and returns the chunk whose header references *path*.  Path
    matching tolerates both ``a/path`` / ``b/path`` prefixes and case-
    insensitive matches so Windows-cased paths still resolve.

    Returns ``None`` when no chunk matches (e.g. path is staged-but-unmodified
    or has been added via ``git add`` only).
    """
    if not whole_diff or not path:
        return None
    norm_path = paths.normalize_key(path)
    # Split on each "diff --git" boundary; keep the prefix attached to its chunk.
    chunks = [c for c in whole_diff.split("\ndiff --git ") if c.strip()]
    # The first chunk may or may not start with "diff --git " depending on the
    # split shape; normalise by ensuring every chunk's first line is the file
    # header so we can match consistently.
    needle_a = f"a/{norm_path}"
    needle_b = f"b/{norm_path}"
    for chunk in chunks:
        header = chunk.split("\n", 1)[0]
        # Case-insensitive search handles Windows case-folding inside git.
        if needle_a in header or needle_b in header or norm_path in header:
            # Re-prepend the "diff --git " token we stripped during split.
            if not chunk.startswith("diff --git "):
                chunk = "diff --git " + chunk
            return chunk
    return None


def _get_inline_diff_for_file(path: str, cwd: str) -> str | None:
    """Return per-file ``git diff HEAD`` when the diff is small enough to inline.

    Used by the edited-files section (#7) to replace the bare "edited Nx" note
    with the actual diff when it fits within *_INLINE_DIFF_MAX_BYTES*.

    Item #2: routes through the per-manifest whole-diff cache instead of
    spawning a fresh ``git diff HEAD -- <path>`` subprocess per file.  The
    cached diff is sliced down to just this file's segment via
    :func:`_slice_diff_for_file`.

    Falls back to ``None`` on any failure or when the sliced diff is too large.
    """
    if not cwd or not path:
        return None
    whole = _fetch_whole_repo_diff_cached(cwd)
    if not whole:
        return None
    segment = _slice_diff_for_file(whole, path)
    if segment is None or len(segment) > _INLINE_DIFF_MAX_BYTES:
        return None
    return segment


def _get_whole_repo_diff(cwd: str) -> str | None:
    """Return ``git diff HEAD`` for the whole repo if under *_SINGLE_FILE_DIFF_CAP* bytes.

    Used by the single-file inline path (#17).  Returns ``None`` on any failure
    or when the diff exceeds the cap.

    Item #2: shares the cached subprocess result with
    :func:`_get_inline_diff_for_file`.
    """
    if not cwd:
        return None
    diff = _fetch_whole_repo_diff_cached(cwd)
    if diff is None or len(diff) > _SINGLE_FILE_DIFF_CAP:
        return None
    return diff


def _is_git_repo(cwd: str) -> bool:
    """Return True when *cwd* is inside a git repository.

    Checks for the presence of a ``.git`` entry (directory **or** file — the
    latter is used by git worktrees and submodules).  A single ``os.path.exists``
    call, sub-millisecond.  Result is cached per cwd for the lifetime of the
    process so repeated calls within the same hook invocation pay zero cost.
    """
    cached = _is_git_repo_cache.get(cwd)
    if cached is not None:
        return cached
    import os as _os  # noqa: PLC0415
    result = _os.path.exists(_os.path.join(cwd, ".git"))
    _is_git_repo_cache[cwd] = result
    return result


def _get_uncommitted_changes(project_root: str | None) -> str | None:
    """Return a compact summary of all uncommitted changes in *project_root*.

    Combines ``git diff --stat HEAD`` (tracked file changes) with
    ``git status --short`` (which also surfaces untracked files not yet staged).
    Returns a non-empty string on success, or ``None`` on any failure (git
    unavailable, not a repo, nothing changed, timeout, etc.).

    Caps:
    - At most 8 lines total (across both commands, deduplicated).
    - At most 200 characters total (header not included — caller adds it).
    - Timeout 5 s so a slow git never blocks the PreCompact hook.
    - Each line has trailing whitespace stripped.

    This function must never raise.
    """
    if project_root is None:
        return None
    if not _is_git_repo(project_root):
        return None
    try:
        # Process-level cache: skip the subprocesses when called again within TTL.
        # build_manifest_adaptive calls this once for the budget calculation and
        # _render calls it again to emit the section, both within the same
        # manifest build — without the cache, that doubles the four git
        # subprocess invocations needed.
        now = time.monotonic()
        cached = _uncommitted_changes_cache.get(project_root)
        if cached is not None and now - cached[1] < _DIFF_STAT_SUMMARY_TTL:
            return cached[0]

        # Run git diff --stat HEAD to see tracked file changes with +/- counts.
        _diff_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], project_root, timeout=5)
        diff_lines: list[str] = (
            [line.rstrip() for line in _diff_out.splitlines() if line.strip()]
            if _diff_out else []
        )

        # Run git status --short to catch untracked (??) and staged files not
        # reflected in diff --stat HEAD (e.g. new files added to the index).
        _status_out = _run_git(["status", "--short"], project_root, timeout=5)
        status_lines: list[str] = (
            [line.rstrip() for line in _status_out.splitlines() if line.strip()]
            if _status_out else []
        )

        if not diff_lines and not status_lines:
            _put_bounded(_uncommitted_changes_cache, project_root, (None, now))
            return None

        # Prefer diff --stat lines (they include +/- counts which are more
        # informative) and supplement with status lines that mention files not
        # already covered by the diff output.  We extract the filename from
        # each status line ("?? foo.py" → "foo.py") to check for overlap.
        diff_filenames: set[str] = set()
        for dl in diff_lines:
            # diff --stat lines look like " src/foo.py | 12 +++---"
            parts = dl.split("|")
            if parts:
                diff_filenames.add(parts[0].strip())

        combined: list[str] = list(diff_lines)
        for sl in status_lines:
            # status --short lines: "?? foo.py", " M src/bar.py", "A  new.py"
            tokens = sl.split(None, 1)
            filename = tokens[1].strip() if len(tokens) > 1 else sl.strip()
            if filename not in diff_filenames:
                combined.append(sl)

        if not combined:
            _put_bounded(_uncommitted_changes_cache, project_root, (None, now))
            return None

        # Truncate to 8 lines and cap total chars at 200.
        lines = combined[:8]
        output = "\n".join(lines)
        if len(output) > 200:
            output = output[:200].rsplit("\n", 1)[0]
        result = output if output.strip() else None
        _put_bounded(_uncommitted_changes_cache, project_root, (result, now))
        return result
    except Exception:  # noqa: BLE001
        return None


def _get_git_diff_stat_summary(root: object) -> str:
    """Run ``git diff --stat HEAD`` in *root* and return a compact summary string.

    Designed for the "Pending Changes" section of the compaction manifest.
    Unlike :func:`_get_git_diff_stat` (which queries specific files and strips the
    summary line), this helper runs on the whole working tree and *keeps* the
    ``N files changed, M insertions(+), K deletions(-)`` summary line so the
    compaction LLM sees the scope at a glance.

    Caps:
    - At most 6 lines (5 per-file lines + 1 summary line).
    - At most 300 characters total (avoid ballooning the manifest).
    - Timeout 5 s so a slow git never blocks the PreCompact hook.

    ANSI escape codes are stripped from the output (git --no-color is used
    directly, which is simpler and more reliable than a regex).

    Returns:
        A non-empty string on success, or ``""`` on any failure (git not found,
        not a git repo, no changes, output too large, timeout, etc.).  This
        function must never raise.
    """
    if root is None:
        return ""
    try:
        root_str = root if isinstance(root, str) else str(root)
        if not _is_git_repo(root_str):
            return ""

        # Process-level cache: skip the subprocess when called again within TTL.
        now = time.monotonic()
        cached = _diff_stat_summary_cache.get(root_str)
        if cached is not None and now - cached[1] < _DIFF_STAT_SUMMARY_TTL:
            return cached[0]

        _stat_out = _run_git(["diff", "--no-color", "--stat", "HEAD"], root_str, timeout=5)
        if not _stat_out:
            _put_bounded(_diff_stat_summary_cache, root_str, ("", now))
            return ""
        lines = _stat_out.splitlines()
        # Keep at most 6 lines (last 5 file-stat lines + the summary line which is last).
        # git --stat outputs file lines first then a summary line at the end; taking the
        # last 6 lines captures the summary and up to 5 file entries.
        last6 = lines[-6:]
        # Drop alignment padding that git --stat adds for column alignment.
        # "src/foo.py    | 12 +++--" → "src/foo.py | 12 +++--"
        # Each stat line saves 2–8 spaces.  Summary line is unaffected (no "|").
        compressed = []
        for ln in last6:
            ln = re.sub(r"\s{2,}\|", " |", ln)
            ln = re.sub(r"\|\s{2,}(\d)", r"| \1", ln)
            compressed.append(ln)
        output = "\n".join(compressed)
        # Hard cap: if still too long, drop the manifest section entirely rather than
        # truncating mid-line (a partial diff stat is misleading).
        if len(output) > 300:
            _put_bounded(_diff_stat_summary_cache, root_str, ("", now))
            return ""
        _put_bounded(_diff_stat_summary_cache, root_str, (output, now))
        return output
    except Exception:  # noqa: BLE001
        return ""


def _get_stash_count(cwd: str | None) -> int:
    """Return the number of entries in ``git stash list``, or 0 on any failure.

    Item #27: stash count is load-bearing state currently invisible to the
    compaction LLM — a forgotten ``git stash`` carries pending work the agent
    must remember.  Lightweight subprocess (no pathspec), 2 s timeout.  The
    return value gates emit-vs-suppress in the manifest renderer; 0 disables
    the section entirely so the common (no-stashes) path costs nothing.
    """
    if not cwd:
        return 0
    out = _run_git(["stash", "list"], cwd, timeout=2)
    if not out:
        return 0
    return sum(1 for line in out.splitlines() if line.strip())


def _get_session_commits(cwd: str | None, session_start_ts: float) -> list[str]:
    """Return git log lines for commits made after session_start_ts.

    Returns at most 5 commits, formatted as ``{short_hash} {subject}``.

    Item #5: the leading ``- `` prefix was dropped — the commits section is
    already rendered under an ``### Commits This Session`` header inside an
    already-bulleted block, and the prefix added ~2 tokens per commit × 5
    commits with no information gain.

    Returns [] when git is unavailable, not in a repo, or cwd is None.
    Times out after 2 seconds.
    """
    if not cwd or session_start_ts <= 0:
        return []
    out = _run_git(
        ["log", "--oneline", f"--since={int(session_start_ts)}", "--max-count=5"],
        cwd,
        timeout=2,
    )
    if not out:
        return []
    return [sanitize_log_str(line, max_len=100) for line in out.splitlines()[:5]]


def _count_suffix(n: int) -> str:
    """Return '  ×N' when *n* > 1, or '' when the count is unremarkable.

    Used in the manifest to annotate files edited or read multiple times without
    cluttering single-occurrence entries.
    """
    return f"  ×{n}" if n > 1 else ""


def _group_edited_by_dir(
    entries: list[tuple[str, int]],
    project_root: str | None = None,
    threshold: int = 3,
) -> list[str]:
    """Group edited files by directory when >= threshold files share the same parent.

    When multiple files share a common parent directory, group them under one
    directory header to save tokens. Directories with fewer than threshold files
    remain on their own lines. Set threshold=0 to disable grouping entirely.

    Args:
        entries: List of (path, edit_count) tuples, already sorted by edit count descending.
        project_root: Optional project root for path shortening.
        threshold: Minimum number of files in a directory to trigger grouping.
                  Set to 0 to disable grouping. Defaults to 3.

    Returns:
        A list of formatted strings ready for the manifest. Each string is either:
        - A single-file line: "- ✎ path/to/file.py  ×N"
        - A grouped line: "  path/to/dir/ (N files):  file1.py ×2, file2.py ×1, ..."
    """
    from collections import defaultdict

    if not entries or threshold < 0:
        return []

    # Special case: threshold=0 disables grouping
    if threshold == 0:
        ungrouped_result = []
        for path, count in entries:
            ungrouped_result.append(f"- ✎ {_short_path(path, project_root=project_root)}{_count_suffix(count)}")
        return ungrouped_result

    # Group by directory
    dir_groups: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for path, count in entries:
        dirname = os.path.dirname(path) or "."
        basename = os.path.basename(path)
        dir_groups[dirname].append((basename, count))

    result: list[str] = []
    for dirname in sorted(dir_groups.keys(), key=lambda d: -max(c for _, c in dir_groups[d])):
        group = dir_groups[dirname]

        if len(group) < threshold:
            # Below threshold: list each file on its own line
            for basename, count in group:
                full_path = os.path.join(dirname, basename) if dirname != "." else basename
                result.append(f"- ✎ {_short_path(full_path, project_root=project_root)}{_count_suffix(count)}")
        else:
            # 3+ files: use grouped format
            # Sort files within the group by edit count descending, maintaining relative order
            group_sorted = sorted(group, key=lambda x: x[1], reverse=True)
            file_parts = [f"{basename}{_count_suffix(count)}" for basename, count in group_sorted]
            files_str = ", ".join(file_parts)

            # Cap the grouped line to fit within reasonable manifest bounds (~120 chars)
            display_dir = _short_path(dirname + "/", project_root=project_root) if dirname != "." else ""
            line = f"  {display_dir} ({len(group)} files):  {files_str}"

            if len(line) > 120:
                # If too long, truncate the file list
                files_str = ", ".join(file_parts[:2])
                overflow = len(group_sorted) - 2
                if overflow > 0:
                    files_str += f", +{overflow} more"
                line = f"  {display_dir} ({len(group)} files):  {files_str}"

            result.append(line)

    return result


def _format_duration(seconds: float) -> str:
    """Format a duration in seconds as a compact human-readable string.

    Examples: 65 → "1m", 3665 → "1h 1m", 7200 → "2h"
    """
    secs = int(seconds)
    if secs < 3600:
        return f"{secs // 60}m"
    hours = secs // 3600
    mins = (secs % 3600) // 60
    return f"{hours}h {mins}m" if mins > 0 else f"{hours}h"


def _short_path(p: str, max_len: int = 70, project_root: str | None = None) -> str:
    """Return a compact display representation of a file path.

    Normalises backslashes to forward slashes, strips the leading
    absolute-path component up to a recognised project-layout directory
    (``/src/``, ``/tests/``, ``/docs/``) so the manifest stays readable on
    both Windows and POSIX without leaking the user's home directory prefix,
    and sanitizes embedded newlines/CRs to prevent log/manifest injection.
    Falls back to tail-truncation with an ellipsis if the path is still over
    *max_len* after stripping (e.g. deeply nested monorepo paths).

    If *project_root* is provided and the path starts with the project
    basename as its first component (e.g. ``token-goat/src/file.py``), that
    leading component is stripped so the manifest shows ``src/file.py`` rather
    than ``token-goat/src/file.py``.  Paths from other projects keep their
    leading component intact.
    """
    # Sanitize before any further processing: paths come from harness payloads
    # and session cache entries written by hooks, both of which accept arbitrary
    # attacker-controlled strings.  Embedded newlines would break the manifest
    # structure and could inject fake manifest sections into the LLM context.
    p = sanitize_log_str(p, max_len=max_len * 2)
    p = p.replace("\\", "/")
    # Strip common prefixes to keep paths short
    for prefix in ("/src/", "/tests/", "/docs/"):
        idx = p.find(prefix)
        if idx >= 0:
            return p[idx + 1:]
    # Strip the project basename when it's the first path component.
    # E.g. with project_root="/Projects/token-goat", a path that after the
    # above stripping starts with "token-goat/" becomes just the remainder.
    # Only applies to the *current* project — other projects keep their name.
    if project_root:
        import os as _os
        proj_name = _os.path.basename(project_root.rstrip("/\\"))
        if proj_name:
            prefix_check = proj_name + "/"
            if p.startswith(prefix_check):
                p = p[len(prefix_check):]
    if len(p) > max_len:
        return "…" + p[-(max_len - 1):]
    return p


def _extract_path_from_line(line: str) -> str | None:
    """Extract the path string from a manifest line if it contains one.

    Recognizes lines with path-bearing markers: '- ✎ ', '- → ', '- ⚠ ', '- ❄ ',
    and plain symbol lines '- '.  Returns the path token (first non-empty token
    after the marker) or None if the line doesn't contain a path.

    Examples:
        "- ✎ token_goat/compact.py  ×2" → "token_goat/compact.py"
        "- → token_goat/hints.py  L:1-100" → "token_goat/hints.py"
        "- token_goat/session.py → FileEntry" → "token_goat/session.py"
        "### Files Edited" → None
        "Legend: edited=✎" → None
    """
    line = line.rstrip()
    if not line.startswith("- "):
        return None

    # Remove the "- " prefix
    rest = line[2:]

    # Skip marker symbols (✎, →, ⚠, ❄) if present
    if rest and rest[0] in ("✎", "→", "⚠", "❄"):
        rest = rest[1:].lstrip()

    # Extract the first whitespace-delimited token
    if not rest:
        return None
    parts = rest.split()
    if not parts:
        return None

    path = parts[0]
    # Validate: a path should not start with a backtick or look like a command
    if path.startswith("`"):
        return None
    return path


def _find_common_prefix(paths: list[str]) -> str | None:
    """Find the longest common directory prefix shared by all paths.

    A directory prefix is one that ends at a '/' boundary.  Single-segment
    paths (no '/') contribute no prefix.  Returns None if no common directory
    prefix exists or if the prefix is too short to be worthwhile.

    Examples:
        ["token_goat/compact.py", "token_goat/hints.py"] → "token_goat/"
        ["src/foo.py", "src/bar.py"] → "src/"
        ["a/b/c.py", "x/y/z.py"] → None (no common prefix)
        ["compact.py", "hints.py"] → None (single-segment paths)
    """
    if not paths:
        return None

    # If only one path, extract its directory
    if len(paths) == 1:
        p = paths[0]
        if "/" in p:
            idx = p.rfind("/")
            return p[:idx + 1]
        return None

    # Find the longest common string prefix across all paths
    # First, find the shortest common substring that is a prefix of all
    common = paths[0]
    for p in paths[1:]:
        # Shorten 'common' until it's a prefix of p (or becomes empty)
        while common and not p.startswith(common):
            common = common[:-1]

    if not common:
        return None

    # Ensure the common prefix ends at a directory boundary ('/')
    # Trim back to the last '/', or return None if there is no '/'
    if "/" not in common:
        return None

    # Find the directory boundary (last '/' in the common part)
    slash_idx = common.rfind("/")
    # Include the '/' in the result
    return common[:slash_idx + 1]


def _strip_common_prefix_lines(
    lines: list[str],
    common_prefix: str,
) -> list[str]:
    """Strip ``common_prefix`` from path-bearing lines, leaving non-path lines intact.

    Unlike :func:`_strip_common_prefix_from_sections`, this helper does NOT
    insert a ``(paths relative to ...)`` header line — it only rewrites
    existing path-bearing lines.  Use this when you need to apply the same
    transformation to a single section in isolation (e.g. during priority-
    aware safety trim, where the manifest body is rebuilt section-by-section).
    """
    if not common_prefix:
        return list(lines)
    out: list[str] = []
    for line in lines:
        path = _extract_path_from_line(line)
        if path and path.startswith(common_prefix) and line.startswith("- "):
            rest = line[2:]
            marker = ""
            if rest and rest[0] in ("✎", "→", "⚠", "❄"):
                marker = rest[0]
                rest = rest[1:].lstrip()
            else:
                rest = rest.lstrip()
            parts = rest.split(None, 1)
            new_path = path[len(common_prefix):]
            tail = f" {parts[1]}" if len(parts) > 1 else ""
            if marker:
                out.append(f"- {marker} {new_path}{tail}")
            else:
                out.append(f"- {new_path}{tail}")
        else:
            out.append(line)
    return out


def _strip_common_prefix_from_sections(
    sections: list[str],
    common_prefix: str,
) -> list[str]:
    """Rewrite sections list to strip common_prefix from all path-bearing lines.

    Inserts a header note after the "Session: ..." line indicating the stripped prefix.
    All path-bearing lines have their paths rewritten to remove the prefix.

    Args:
        sections: The list of manifest lines to transform.
        common_prefix: The directory prefix to strip (e.g., "token_goat/").

    Returns:
        A new list of sections with the prefix stripped and a header note inserted.
    """
    if not common_prefix:
        return sections

    result: list[str] = []
    session_line_idx = -1

    # Find the session line and copy header lines
    for i, line in enumerate(sections):
        result.append(line)
        if line.startswith("Session: "):
            session_line_idx = i
            break

    if session_line_idx >= 0:
        # Insert the prefix note after the session line, then process the tail.
        result.insert(session_line_idx + 1, f"(paths relative to {common_prefix})")
        result.extend(_strip_common_prefix_lines(sections[session_line_idx + 1:], common_prefix))
    else:
        # No session header (e.g. body-only slices from the safety-trim path).
        # The loop already consumed every line into result, but those copies are
        # unprocessed originals.  Replace them with the prefix-stripped version.
        result = _strip_common_prefix_lines(sections, common_prefix)

    return result


def _format_ranges(ranges: list[tuple[int, int]]) -> str:
    """Render merged line ranges compactly for inclusion in the manifest.

    Examples::

        _format_ranges([(1, 50)])          # →  "  L:1-50"
        _format_ranges([(1, 1)])           # →  "  L:1"      (single line)
        _format_ranges([(1, 50), (100, 200), (300, 400), (500, 600), (700, 800)])
        # →  "  L:1-50, 100-200, 300-400, 400-500 +1 more"

    Single-line ranges (start == end) are formatted without a dash to keep the
    output readable.  Ranges beyond _MAX_RANGES_PER_FILE are summarised as
    "+N more" so the manifest line stays short enough to fit within the token
    budget even for files read in many separate slices.

    Silently skips any malformed entries (non-sequence or wrong length) that
    could arise from a corrupt or downgrade-migrated session JSON file.
    """
    if not ranges:
        return ""
    valid: list[tuple[int, int]] = []
    had_sentinel = False
    for entry in ranges:
        try:
            start, end = entry
            start, end = int(start), int(end)
            if end - start >= _FULL_READ_SENTINEL_GAP:
                had_sentinel = True  # whole-file read — sentinel supersedes all partials
            else:
                valid.append((start, end))
        except (TypeError, ValueError):
            _LOG.debug("_format_ranges: skipping malformed range entry: %r", entry)
    if had_sentinel:
        return "  (full)"
    if not valid:
        return ""
    total_ranges = len(valid)
    shown = valid[:_MAX_RANGES_PER_FILE]
    # Generator expression avoids building an intermediate list just to join.
    parts = ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in shown)
    hidden_count = total_ranges - _MAX_RANGES_PER_FILE
    overflow_suffix = f" +{hidden_count} more" if hidden_count > 0 else ""
    return f"  L:{parts}{overflow_suffix}"


def _is_noop_bash_command(entry: object) -> bool:
    """Check if a bash entry is a no-op command (status check, pwd, cd, etc).

    No-op commands consume manifest token budget with zero compaction value.
    Examples: `git status`, `ls`, `pwd`, `echo`, `cd`, `cat` on tiny files,
    or any command shorter than 5 characters.

    Returns True if the command is deemed a no-op and should be excluded from
    the manifest bash section.
    """
    cmd_preview = getattr(entry, "cmd_preview", "").strip()
    if not cmd_preview:
        return False

    # Commands shorter than 5 chars are typically inaudible (ls, cd, pwd, git, etc.)
    if len(cmd_preview) < 5:
        return True

    # Extract the base command (first word, handling pipes/redirects)
    first_word = cmd_preview.split()[0] if cmd_preview.split() else ""
    first_word_lower = first_word.lower()

    # No-op patterns: common status/navigation commands
    noop_patterns = {
        "git status", "git diff --stat", "git log --oneline",
        "ls", "pwd", "cd", "echo", "cat", "head", "tail",
    }

    # Check exact match first
    if cmd_preview.lower() in noop_patterns:
        return True

    # Check prefix match for common no-ops
    cmd_lower = cmd_preview.lower()
    for pattern in ("git status", "git diff --stat", "git log"):
        if cmd_lower.startswith(pattern):
            return True

    # Commands that are inherently silent (cd, echo)
    if first_word_lower in ("cd", "echo"):
        return True

    # 'cat' or 'head' on tiny outputs (< 200 bytes) are inaudible
    if first_word_lower in ("cat", "head", "tail"):
        total_bytes = getattr(entry, "stdout_bytes", 0) + getattr(entry, "stderr_bytes", 0)
        if total_bytes < 200:
            return True

    return False


def _select_failed_bash_entries(bash_history: object, now_ts: float) -> list[object]:
    """Return up to :data:`_MAX_BLOCKER_ENTRIES` recently-failed bash commands.

    A "failure" is any entry whose ``exit_code`` is a real integer != 0.
    Entries with ``exit_code=None`` (unknown / not captured) are excluded —
    we cannot assert they failed, so surfacing them as blockers would be noisy.

    Only commands run within the last :data:`_BLOCKER_STALE_SECS` seconds (60
    min) are considered; older failures are stale and no longer the active
    problem.  Results are sorted most-recent-first so the freshest failure is
    listed first in the "Current Blockers" section.

    Accepts ``bash_history`` typed as ``object`` for the same defensive reason
    as :func:`_select_top_bash_entries` — legacy or test SessionCache instances
    may not have the field.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []
    cutoff = now_ts - _BLOCKER_STALE_SECS
    candidates = [
        e for e in bash_history.values()
        if isinstance(getattr(e, "exit_code", None), int)
        and e.exit_code != 0  # type: ignore[union-attr]
        and getattr(e, "ts", 0.0) >= cutoff
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_BLOCKER_ENTRIES, candidates, key=_BY_BASH_TS)


def _session_activity_score(cache: SessionCache) -> int:
    """Compute a weighted activity score for the session.

    Used by :func:`build_manifest_adaptive` to decide whether to emit a full
    manifest or suppress it.  See :data:`_ACTIVITY_FLOOR` for weight rationale.

    Returns a non-negative integer; higher means more session activity.
    """
    edited_count = len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0
    bash_count = len(getattr(cache, "bash_history", None) or {})
    web_count = len(getattr(cache, "web_history", None) or {})
    skill_count = len(getattr(cache, "skill_history", None) or {})

    # Active blockers: recent failed bash commands
    now_ts = time.time()
    blocker_count = len(
        _select_failed_bash_entries(
            getattr(cache, "bash_history", None) or {}, now_ts
        )
    )

    return (
        edited_count * 2
        + bash_count * 1
        + web_count * 1
        + skill_count * 1
        + blocker_count * 5
    )


# Cache for blocker error previews keyed by output_id.  A render of the manifest
# typically references each blocker output_id at most twice (once in
# _build_sealed_block, once via _format_blocker_entry), so a small LRU is enough
# to halve the disk reads without bounding growth across long sessions.  Sized
# generously to cover the rare case where many blocker entries share a render.
_BLOCKER_PREVIEW_CACHE_MAX: Final[int] = 32
_blocker_preview_cache: dict[str, str] = {}


def _extract_blocker_error_preview(entry: object, *, max_chars: int = 70) -> str:
    """Return a short error line extracted from a blocker's cached bash output.

    The cached output stored under ``entry.output_id`` is read via
    :mod:`token_goat.bash_cache` and scanned for the most discriminating line:
    lines containing ``"error"``, ``"failed"``, ``"traceback"``, ``"fatal"``,
    or ``"exception"`` (case-insensitive) win first; otherwise the last
    non-blank line is returned (typical exit summary or final stderr line).

    Returns an empty string on any failure — missing output_id, cache miss,
    permission error, parse error, etc.  Manifest assembly never blocks on
    this helper.

    Result is cached per-process by output_id so the sealed-block render and
    the per-blocker entry render share one disk read.  Cache is bounded at
    :data:`_BLOCKER_PREVIEW_CACHE_MAX`; FIFO eviction is good enough for the
    short-lived cache lifetime (one manifest render).
    """
    output_id = getattr(entry, "output_id", "") or ""
    if not output_id:
        return ""
    cached = _blocker_preview_cache.get(output_id)
    if cached is not None:
        return cached
    try:
        from . import bash_cache  # noqa: PLC0415  — deferred to keep cold-start cheap
        raw_output = bash_cache.load_output(output_id)
    except Exception:  # noqa: BLE001 — fail-soft per manifest contract
        _blocker_preview_cache[output_id] = ""
        return ""
    if not raw_output:
        _blocker_preview_cache[output_id] = ""
        return ""

    # Cap how many lines we scan so a huge cached output never adds latency
    # to manifest construction.  Most real error output surfaces a tag in
    # the first ~200 lines (or trails at the very end).
    lines = raw_output.splitlines()
    head = lines[:200]
    tail = lines[-20:] if len(lines) > 220 else []
    error_tokens = ("error", "failed", "traceback", "fatal", "exception", "✗")
    picked: str = ""
    for line in head + tail:
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        if any(tok in low for tok in error_tokens):
            picked = stripped
            break
    if not picked:
        # Fall back to last non-blank line — usually the exit summary.
        for line in reversed(lines):
            stripped = line.strip()
            if stripped:
                picked = stripped
                break

    picked = sanitize_log_str(picked, max_len=max_chars)
    # FIFO eviction once we hit the cap.
    if len(_blocker_preview_cache) >= _BLOCKER_PREVIEW_CACHE_MAX:
        # Pop the oldest entry (insertion order is preserved in Python dicts).
        oldest_key = next(iter(_blocker_preview_cache))
        _blocker_preview_cache.pop(oldest_key, None)
    _blocker_preview_cache[output_id] = picked
    return picked


def _format_blocker_entry(entry: object) -> str:
    """Render one failed :class:`session.BashEntry` as a "Current Blockers" line.

    Format::

        - ✗ pytest tests/  (exit 1) — AssertionError: expected 5, got 4
        - ✗ make build  (exit 2)

    The trailing "—" clause is a one-line error preview pulled from the cached
    output via :func:`_extract_blocker_error_preview` when available.  It is
    omitted when the preview is empty (cache miss, no output_id, or no
    discriminating line) — the compaction LLM still sees what failed and how,
    and the agent can retrieve details via ``token-goat bash-output <id>`` for
    the full trace.
    """
    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    exit_code = getattr(entry, "exit_code", "?")
    error_preview = _extract_blocker_error_preview(entry, max_chars=70)
    if error_preview:
        return f"- ✗ {cmd_preview}  (exit {exit_code}) — {error_preview}"
    return f"- ✗ {cmd_preview}  (exit {exit_code})"


def _select_top_entries(
    history: object,
    min_bytes: int,
    size_fn: Callable[[object], int],
    max_n: int,
    exclude_fn: Callable[[object], bool] | None = None,
) -> list[object]:
    """Recency-ranked selector shared by bash and web history dicts.

    Filters *history* values whose size (per *size_fn*) is below *min_bytes*,
    optionally excludes entries where *exclude_fn* returns True, and returns
    the *max_n* most-recent survivors.  Safe on legacy or missing fields
    (``None`` / non-dict input → empty list).
    """
    if not isinstance(history, dict) or not history:
        return []
    candidates = [
        e for e in history.values()
        if size_fn(e) >= min_bytes
        and (exclude_fn is None or not exclude_fn(e))
    ]
    if not candidates:
        return []
    return heapq.nlargest(max_n, candidates, key=lambda e: getattr(e, "ts", 0.0))


def _rank_symbols_by_recency(entry: FileEntry, now: float) -> list[str]:
    """Return symbols from *entry* ranked by recency (most recent first).

    Uses exponential decay with a 5-minute, 30-minute, and open-ended tiers:
    - Accessed within last 5 minutes: 1.5× recency multiplier
    - Accessed within last 30 minutes: 1.2× multiplier
    - Accessed earlier: 1.0× multiplier

    Symbols without timestamps (from legacy sessions) fall back to 1.0×.
    """
    # Backwards compatibility: symbols_ts may not exist on old entries
    symbols_ts = getattr(entry, 'symbols_ts', None)
    if not symbols_ts:
        # No timestamp info; return symbols in original order
        return entry.symbols_read

    # Build (symbol, score) pairs using recency multiplier
    scored_symbols: list[tuple[str, float, float]] = []
    for symbol in entry.symbols_read:
        ts = symbols_ts.get(symbol, 0.0)
        age_seconds = max(0.0, now - ts)
        # Tier-based multiplier: recent symbols rank first
        if age_seconds < 300:  # < 5 minutes
            multiplier = 1.5
        elif age_seconds < 1800:  # < 30 minutes
            multiplier = 1.2
        else:
            multiplier = 1.0
        scored_symbols.append((symbol, multiplier, ts))

    # Sort by tier desc, then raw timestamp desc (most recent within same tier first)
    scored_symbols.sort(key=lambda x: (x[1], x[2]), reverse=True)
    return [item[0] for item in scored_symbols]


def _dedup_symbols_across_files(
    entries: list,  # list[FileEntry]
    now: float,
) -> dict[str, tuple[str, float]]:
    """Deduplicate symbols across multiple files, keeping only most-recent reference.

    When the same symbol appears in multiple files, keep only the reference from
    the file where it was most recently accessed. This saves manifest tokens by
    eliminating redundant symbol listings.

    Args:
        entries: List of FileEntry objects with symbols_read.
        now: Current timestamp for recency ranking.

    Returns:
        A dict mapping symbol name to (file_path, access_timestamp).
        Only the most-recent file reference is kept per symbol.
    """
    symbol_map: dict[str, tuple[str, float]] = {}

    for entry in entries:  # type: ignore[var-annotated]
        if not getattr(entry, "symbols_read", None):
            continue
        ranked = _rank_symbols_by_recency(entry, now)  # type: ignore[arg-type]
        symbols_ts = getattr(entry, "symbols_ts", None) or {}  # type: ignore[union-attr]
        for symbol in ranked:
            ts = symbols_ts.get(symbol, 0.0)
            rel_or_abs = getattr(entry, "rel_or_abs", "")
            if symbol not in symbol_map or ts > symbol_map[symbol][1]:
                symbol_map[symbol] = (rel_or_abs, ts)

    return symbol_map


def _adaptive_bash_max(bash_history: object) -> int:
    """Compute the effective Bash entry cap based on session size.

    Short sessions (< 10 commands) are dominated by the bash section if the
    full _MAX_BASH_ENTRIES constant is used — the handful of commands run so
    far would fill the manifest while the agent still has fresh context.
    Scaling down for short sessions keeps the manifest proportional.

    Formula: ``min(_MAX_BASH_ENTRIES, max(2, len(bash_history) // 5))``.
    Examples:
    - 10 commands → 2  (10 // 5 = 2)
    - 25 commands → 5  (25 // 5 = 5, capped at 6)
    - 30 commands → 6  (30 // 5 = 6)
    - 60 commands → 6  (capped at _MAX_BASH_ENTRIES)
    """
    n = len(bash_history) if isinstance(bash_history, dict) else 0
    return min(_MAX_BASH_ENTRIES, max(2, n // 5))


def _select_top_bash_entries(bash_history: object) -> list[object]:
    """Pick up to an adaptive cap of cached Bash runs worth surfacing.

    The cap scales with session length (see :func:`_adaptive_bash_max`) so
    short sessions don't let the bash section dominate the manifest budget.
    """
    effective_max = _adaptive_bash_max(bash_history)
    return _select_top_entries(
        bash_history,
        min_bytes=_MIN_BASH_BYTES_FOR_MANIFEST,
        size_fn=lambda e: getattr(e, "stdout_bytes", 0) + getattr(e, "stderr_bytes", 0),
        max_n=effective_max,
        exclude_fn=_is_noop_bash_command,
    )


# Prefixes that identify test-runner commands eligible for the "What Worked" section.
# The heuristic matches the command preview string (lowercased, leading whitespace stripped)
# against this tuple using str.startswith — any command that begins with one of these
# is considered a test run.  Keep the list conservative: false positives (e.g. surfacing
# a non-test command as "What Worked") are more confusing than false negatives.
_TEST_COMMAND_PREFIXES: Final[tuple[str, ...]] = (
    "pytest",
    "uv run pytest",
    "python -m pytest",
    "npm test",
    "npm run test",
    "yarn test",
    "cargo test",
    "go test",
    "mocha",
    "jest",
    "make test",
    "make check",
)


def _is_test_command(entry: object) -> bool:
    """Return True when *entry*'s cmd_preview looks like a test-runner invocation.

    Matches against :data:`_TEST_COMMAND_PREFIXES` (case-insensitive prefix check).
    Short or empty previews never match.
    """
    cmd = getattr(entry, "cmd_preview", "").strip().lower()
    if not cmd:
        return False
    return any(cmd.startswith(prefix) for prefix in _TEST_COMMAND_PREFIXES)


def _select_what_worked(bash_history: object, blocker_ids: set[object]) -> list[object]:
    """Return at most 2 most-recent green (exit 0) test runs from *bash_history*.

    Criteria:
    - ``exit_code == 0`` (green pass)
    - ``cmd_preview`` matches a test-runner prefix (see :data:`_TEST_COMMAND_PREFIXES`)
    - ``output_id`` not in *blocker_ids* — don't surface the passing version of a
      command that is currently blocking (defensive: the current state is what matters)

    Results are returned most-recent-first.  Returns an empty list when no
    qualifying entries exist.

    *bash_history* is typed as ``object`` for the same defensive reason as
    :func:`_select_top_bash_entries` — legacy/test fixtures may not supply a dict.
    """
    if not isinstance(bash_history, dict) or not bash_history:
        return []
    candidates = [
        e for e in bash_history.values()
        if getattr(e, "exit_code", None) == 0
        and _is_test_command(e)
        and getattr(e, "output_id", None) not in blocker_ids
    ]
    if not candidates:
        return []
    return heapq.nlargest(2, candidates, key=_BY_BASH_TS)


def _render_what_worked_section(entries: list[object], now_ts: float) -> list[str]:
    """Render a ``**Passed:**`` section listing at most 2 recent green test runs.

    Item #6: when there are 1–2 entries (the common case — the selector caps
    at 2 anyway) the section collapses to a single ``**Passed:** cmd1 (Nm),
    cmd2 (Nm)`` line.  Saves ~5 tokens vs. the previous header + bullet form
    and keeps the entries visually adjacent so the compaction LLM can see
    "what's green" at a glance.

    The cmd_preview is truncated to 60 characters.  Age is expressed in whole
    minutes (rounded down).  Output-id recall hints are dropped from the
    collapsed form — the agent can recover them from the bash section's
    cache pointers; duplicating them here was redundant context.

    Returns an empty list when *entries* is empty (no section emitted).
    """
    if not entries:
        return []

    def _format_entry(entry: object) -> str:
        raw_cmd = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=200)
        cmd = raw_cmd[:57] + "..." if len(raw_cmd) > 60 else raw_cmd
        ts = getattr(entry, "ts", now_ts)
        age_min = max(0, int((now_ts - ts) / 60))
        return f"`{cmd}` ({age_min}m)"

    # Item #6 collapse: 1-2 entries → single line.
    if len(entries) <= 2:
        joined = ", ".join(_format_entry(e) for e in entries)
        return [f"**Passed:** {joined}"]

    # Fallback for the hypothetical case where future selector loosens the cap:
    # keep the bulleted form with the old recall-id suffix so we still preserve
    # the per-entry output pointer when more than 2 entries are listed.
    lines: list[str] = ["**Passed:**"]
    for entry in entries:
        raw_cmd = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=200)
        cmd = raw_cmd[:57] + "..." if len(raw_cmd) > 60 else raw_cmd
        ts = getattr(entry, "ts", now_ts)
        age_min = max(0, int((now_ts - ts) / 60))
        oid = _short_id(sanitize_log_str(getattr(entry, "output_id", ""), max_len=64))
        lines.append(f"- ✅ `{cmd}` ({age_min} min ago) `{oid}`")
    return lines


def _middle_truncate(text: str, max_lines: int = 20) -> str:
    """Return *text* middle-truncated to at most *max_lines* lines.

    When the line count is within *max_lines* the text is returned unchanged.
    Otherwise the first ``ceil(max_lines * 0.4)`` lines and the last
    ``ceil(max_lines * 0.4)`` lines are kept, with a human-readable omission
    marker inserted between them::

        line 1
        line 2
        ... [8 lines omitted] ...
        line 11
        line 12

    The split is intentionally biased toward showing both the beginning (which
    usually contains the command header / test summary) and the end (which
    usually contains the final error or result), dropping the noisy middle.

    *max_lines* must be >= 2; values below 2 are clamped to 2.
    """
    if max_lines < 2:
        max_lines = 2
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text
    keep = math.ceil(max_lines * 0.4)
    head = lines[:keep]
    tail = lines[-keep:]
    omitted = len(lines) - keep * 2
    marker = f"... [{omitted} lines omitted] ..."
    return "\n".join(head + [marker] + tail)


def _render_cache_meta(
    status: str,
    body_bytes: int,
    *,
    truncated: bool = False,
    output_id: str = "",
) -> str:
    """Build the parenthesised metadata suffix shared by bash and web manifest lines.

    Examples::

        _render_cache_meta("e=0", 12345)
        # → "(e=0, 12.1KB)"

        _render_cache_meta("200", 14200, truncated=True, output_id="abc123ef")
        # → "(200, 13.9KB (truncated), id=abc123ef)"

    When *output_id* is non-empty the ``id=<short>`` component is appended so
    the compaction LLM can recall the body via ``token-goat web-output <id>``.
    When *truncated* is True ``" (truncated)"`` is inserted after the byte count.
    """
    truncated_marker = " (truncated)" if truncated else ""
    bytes_str = _humanize_bytes(body_bytes)
    id_part = f", id={_short_id(output_id)}" if output_id else ""
    return f"({status}, {bytes_str}{truncated_marker}{id_part})"


def _format_bash_entry(entry: object, inline_snippet: bool = True, *, is_blocker: bool = False) -> str:
    """Render one :class:`session.BashEntry` as a single manifest line.

    Format::

        - $ pytest -v tests/  (e=1, 12.3KB)
        - $ pytest -v tests/  [×3] (e=1, 12.3KB)

    When *inline_snippet* is True and a cached output body is available it is
    loaded from disk, passed through :func:`_middle_truncate` (keeping the
    first+last ~40 % of lines), and appended as an indented block so the
    compaction LLM can see both the header and tail of long outputs without
    paying for the noisy middle.

    When *inline_snippet* is False the header line only is returned.
    Byte counts use a compact human suffix (KB/MB) because the raw integer
    (``12345``) is harder to scan in a glance-level summary.  ``[×N]`` appears
    when the command was retried (same SHA, run_count > 1) so retry loops are
    immediately visible.

    *is_blocker* controls the inline snippet line cap: blocker entries keep 20
    lines (failure context is load-bearing); non-blocker entries cap at 12 to
    save ~60-200 tokens/session.
    """
    from . import bash_cache as bash_cache_mod

    cmd_preview = sanitize_log_str(getattr(entry, "cmd_preview", ""), max_len=80)
    total = int(getattr(entry, "stdout_bytes", 0)) + int(getattr(entry, "stderr_bytes", 0))
    exit_code = getattr(entry, "exit_code", None)
    output_id = getattr(entry, "output_id", "")
    run_count = int(getattr(entry, "run_count", 1))
    run_count_marker = f" [×{run_count}]" if run_count > 1 else ""
    exit_str = "e=?" if exit_code is None else f"e={exit_code}"
    truncated = bool(getattr(entry, "truncated", False))
    # Item #10: when the command's output is small (<1KB) AND not truncated,
    # the byte count carries no useful signal — drop it entirely.  Saves
    # ~3 tokens/entry across the typical short-command-heavy session.
    if not truncated and total < 1024:
        meta = f"({exit_str})"
    else:
        meta = _render_cache_meta(exit_str, total, truncated=truncated)
    header = f"- $ {cmd_preview}{run_count_marker}  {meta}"

    if not inline_snippet:
        return header

    # Attempt to load cached output for inline snippet.  Failures are silently
    # ignored — the metadata line is always emitted even without the body.
    # Non-blocker entries are capped at 12 lines (was 20) to save ~60-200
    # tokens/session; blocker entries keep 20 lines because failure output is
    # the most load-bearing content in the manifest and needs more context.
    snippet: str | None = None
    if output_id:
        try:
            raw = bash_cache_mod.load_output(output_id)
            if raw and raw.strip():
                snippet_max_lines = 20 if is_blocker else 12
                snippet = _middle_truncate(raw.strip(), max_lines=snippet_max_lines)
        except Exception:  # noqa: BLE001
            pass

    if snippet:
        indented = "\n".join(f"  {line}" for line in snippet.splitlines())
        return f"{header}\n{indented}"
    return header


def _select_top_web_entries(web_history: object) -> list[object]:
    """Pick up to :data:`_MAX_WEB_ENTRIES` web fetches worth surfacing in the manifest.

    Filters out dead-end fetches:
    - HTTP errors (4xx, 5xx status codes) carry no useful content
    - Bodies below :data:`_MIN_WEB_BYTES_FOR_MANIFEST` threshold are filtered by _select_top_entries
    """
    def is_dead_end(entry: object) -> bool:
        """Return True if this web fetch is a dead-end (error or worthless)."""
        status_code = getattr(entry, "status_code", None)
        return status_code is not None and status_code >= 400

    return _select_top_entries(
        web_history,
        min_bytes=_MIN_WEB_BYTES_FOR_MANIFEST,
        size_fn=lambda e: getattr(e, "body_bytes", 0),
        max_n=_MAX_WEB_ENTRIES,
        exclude_fn=is_dead_end,
    )


def _format_web_entry(entry: object) -> str:
    """Render one :class:`session.WebEntry` as a single manifest line.

    Format::

        - 🌐 https://docs.example.com/api  (200, 14.2KB, id=abc123...)
        - 🌐 https://example.com/page  (404, 0.5KB, id=def456...)

    The cache ID is included so the compaction LLM can hand the agent
    ``token-goat web-output <id>`` to recover the body without re-fetching.
    Status code distinguishes successful fetches from error responses so the
    LLM knows whether the cached body is useful content or an error page.
    """
    url_preview = sanitize_log_str(getattr(entry, "url_preview", ""), max_len=100)
    body_bytes = int(getattr(entry, "body_bytes", 0))
    status_code = getattr(entry, "status_code", None)
    output_id = sanitize_log_str(getattr(entry, "output_id", ""), max_len=24)
    status_str = str(status_code) if status_code is not None else "?"
    meta = _render_cache_meta(
        status_str,
        body_bytes,
        truncated=bool(getattr(entry, "truncated", False)),
        output_id=output_id,
    )
    return f"- 🌐 {url_preview}  {meta}"


def _group_web_entries_by_domain(entries: list[object]) -> list[str]:
    """Group web entries by domain to save tokens in the manifest.

    When multiple URLs share the same domain, they are grouped as:
        → domain (N): path1, path2, ...

    Single URLs per domain show the full path. Very long aggregations are
    truncated with an indication of overflow.

    Args:
        entries: List of :class:`session.WebEntry` objects.

    Returns:
        List of formatted strings, one per domain or single-URL entry.
    """
    from collections import defaultdict

    if not entries:
        return []

    # Group entries by netloc (domain)
    domain_groups: dict[str, list[object]] = defaultdict(list)
    for entry in entries:
        url_preview = getattr(entry, "url_preview", "")
        if not url_preview:
            continue
        try:
            parsed = urlparse(url_preview)
            netloc = parsed.netloc or "unknown"
        except Exception:  # noqa: BLE001
            netloc = "unknown"
        domain_groups[netloc].append(entry)

    result = []
    for netloc in sorted(domain_groups.keys()):
        group = domain_groups[netloc]
        if len(group) == 1:
            # Single URL: use full format
            line = _format_web_entry(group[0])
            result.append(line)
        else:
            # Multiple URLs from same domain: compact format
            # Extract paths from each URL
            paths = []
            for entry in group:
                url_preview = getattr(entry, "url_preview", "")
                try:
                    parsed = urlparse(url_preview)
                    path = parsed.path or "/"
                    if parsed.params or parsed.query:
                        path += f"{parsed.params}{('?' + parsed.query) if parsed.query else ''}"
                    paths.append(path)
                except Exception:  # noqa: BLE001
                    paths.append("?")

            # Format as compact line: "→ domain (N): path1, path2, ..."
            path_str = ", ".join(paths)
            # Truncate if too long (keep to ~80 chars for path summary)
            if len(path_str) > 80:
                path_str = path_str[:77] + "..."
            line = f"- 🌐 {netloc} ({len(group)}): {path_str}"
            result.append(line)

    return result


def _select_top_skill_entries(skill_history: object) -> list[object]:
    """Pick up to :data:`_MAX_ACTIVE_SKILLS` skill loads worth surfacing.

    Returns the most-recently-loaded skills, newest first, filtering out
    skills not loaded in the last :data:`_SKILL_STALE_THRESHOLD_SECS` to avoid
    cluttering the manifest with "done" skills that linger in history.

    When the same skill was loaded multiple times (e.g. loaded, then updated
    on disk, then loaded again with different content_sha), returns only the
    most recent version to avoid cluttering the manifest with superseded bodies.
    Sessions typically load a handful of skills total; stale skills are excluded.
    """
    if not isinstance(skill_history, dict) or not skill_history:
        return []

    now = time.time()
    # Filter to recently-loaded skills only
    recent_skills = [
        entry for entry in skill_history.values()
        if (now - getattr(entry, "ts", 0.0)) <= _SKILL_STALE_THRESHOLD_SECS
    ]

    # Deduplicate by skill name: keep only the most-recent content_sha per skill.
    # When a skill file is updated mid-session, multiple entries may exist with
    # the same name but different content_sha / output_id. Retaining all versions
    # would clutter the manifest; the most-recent body is what the agent should use.
    deduped: dict[str, object] = {}
    for entry in recent_skills:
        skill_name = getattr(entry, "skill_name", "")
        ts = getattr(entry, "ts", 0.0)
        if skill_name not in deduped or ts > getattr(deduped[skill_name], "ts", 0.0):
            deduped[skill_name] = entry

    return heapq.nlargest(
        _MAX_ACTIVE_SKILLS,
        deduped.values(),
        key=lambda e: getattr(e, "ts", 0.0),
    )


def _format_skill_entry(entry: object) -> str:
    """Render one :class:`session.SkillEntry` as a single manifest line.

    Format::

        - 🧠 ralph  ×3  (28KB)  recall: `token-goat skill-body ralph`
        - 🧠 plugin:improve  (12KB)  (stale: 8h)  recall: `token-goat skill-body plugin:improve`
        - 🧠 brainstorm  (30KB)*  recall: `token-goat skill-body brainstorm`

    Annotations:
    - ``×N``: skill was loaded N times in the session (only shown if N > 1)
    - ``(stale: Xh)``: skill body cached more than :data:`_SKILL_STALE_FOR_SESSION_SECS`
      ago; the underlying skill file may have been updated since and the cached
      body could be outdated. Agent should verify freshness via ``token-goat
      skill-body`` or re-invoke if critical.
    - ``*`` (after byte size): skill body was truncated when stored; the cached
      version is partial, typically last ~256 KB kept with head dropped.

    The recall hint points the post-compact agent at the cached body so the full
    prose can be retrieved without re-invoking the skill (which would replay any
    side effects).
    """
    name = sanitize_log_str(getattr(entry, "skill_name", ""), max_len=80)
    body_bytes = int(getattr(entry, "body_bytes", 0))
    run_count = int(getattr(entry, "run_count", 1))
    truncated = bool(getattr(entry, "truncated", False))
    ts = float(getattr(entry, "ts", time.time()))

    count_str = f"  ×{run_count}" if run_count > 1 else ""
    size_str = _humanize_bytes(body_bytes)
    trunc_marker = "*" if truncated else ""

    # Flag stale skills: loaded more than 6 hours ago
    now = time.time()
    age_secs = now - ts
    stale_str = ""
    if age_secs > _SKILL_STALE_FOR_SESSION_SECS:
        age_hours = int(age_secs / 3600)
        stale_str = f"  (stale: {age_hours}h)"

    return f"- 🧠 {name}{count_str}  ({size_str}{trunc_marker}){stale_str}  recall: `token-goat skill-body {name}`"


def _select_top_decision_entries(decisions: object) -> list[object]:
    """Pick up to :data:`_MAX_DECISIONS` recent decision entries for the manifest.

    The session ``decisions`` list is append-only, newest-last, so returning the
    last ``_MAX_DECISIONS`` slice preserves chronological order without a sort.
    Older entries remain on disk and are reachable via ``token-goat decision
    --list``; this selector intentionally favours recency over breadth.
    """
    if not isinstance(decisions, list) or not decisions:
        return []
    return list(decisions[-_MAX_DECISIONS:])


def _format_decision_entry(entry: object) -> str:
    """Render one :class:`session.DecisionEntry` as a single manifest line.

    Format::

        - 💡 [rationale] Picked option A because lower risk
        - 💡 Chose plan B — fits budget

    The tag (if any) is wrapped in square brackets as a column-style prefix so
    grep + tag-filtering is straightforward.  Text is hard-trimmed at
    :data:`_MAX_DECISION_RENDER_LEN`; the on-disk entry retains the full body
    for the ``token-goat decision --list`` recall path.
    """
    text = sanitize_log_str(getattr(entry, "text", ""), max_len=_MAX_DECISION_RENDER_LEN)
    tag = sanitize_log_str(getattr(entry, "tag", ""), max_len=24)
    tag_str = f"[{tag}] " if tag else ""
    return f"- 💡 {tag_str}{text}"


def _format_hint_telemetry(cache: object) -> str | None:
    """Return a one-line hint activity summary for the manifest header, or None.

    Emitted only when at least one hint was emitted or suppressed this session.
    Both zeroes means no hints fired at all (e.g. first tool call, cold session)
    and the line adds no signal.

    Format: ``(12 hints emitted, 4 suppressed)``
    """
    emitted = int(getattr(cache, "hints_emitted", 0) or 0)
    _sup_raw = getattr(cache, "hints_suppressed_by_type", None) or {}
    suppressed = sum(_sup_raw.values()) if isinstance(_sup_raw, dict) else 0
    if emitted == 0 and suppressed == 0:
        return None
    if suppressed == 0:
        return f"({emitted} hints emitted)"
    return f"({emitted} hints emitted, {suppressed} suppressed)"


def _select_top_glob_entries(glob_history: object) -> list[object]:
    """Pick up to :data:`_MAX_GLOB_ENTRIES` glob scans worth surfacing in the manifest.

    Filters trivially broad patterns (``*``, ``**``, empty) that carry no useful
    context for the compaction LLM, and returns the most recent survivors.
    Accepts ``glob_history`` typed as ``object`` for defensive compatibility with
    legacy SessionCache instances (``None`` / non-list → empty list).
    """
    if not isinstance(glob_history, list) or not glob_history:
        return []
    _TRIVIAL = {"", "*", "**"}
    candidates = [
        e for e in glob_history
        if sanitize_log_str(getattr(e, "pattern", ""), max_len=256).strip() not in _TRIVIAL
    ]
    if not candidates:
        return []
    return heapq.nlargest(_MAX_GLOB_ENTRIES, candidates, key=lambda e: getattr(e, "ts", 0.0))


def _format_glob_entry(entry: object, *, cwd: str | None = None) -> str:
    """Render one :class:`session.GlobEntry` as a single manifest line.

    Format::

        - g: **/*.py  (src/, 42 files)
        - g: tests/**  (27 files)
        - g: src/**/*.ts

    Item #4: the ``📂`` emoji prefix is replaced with the ASCII marker ``g:``
    (multi-byte emojis cost more tokens than 2 ASCII chars), and the scope
    path is suppressed when it equals *cwd* (the path scope is then redundant
    — the agent already knows the working directory).
    """
    pattern = sanitize_log_str(getattr(entry, "pattern", ""), max_len=80)
    path = getattr(entry, "path", None)
    if path and cwd:
        # Suppress scope path when it equals the session cwd.
        norm_path = _norm_key(str(path)).rstrip("/")
        norm_cwd = _norm_key(str(cwd)).rstrip("/")
        if norm_path == norm_cwd:
            path = None
    count = getattr(entry, "result_count", None)
    scope = f"  ({path}" if path else ""
    hits = (f", {count} files)" if scope else f"  ({count} files)") if isinstance(count, int) else (")" if scope else "")
    return f"- g: {pattern}{scope}{hits}"


def _token_count(text: str) -> int:
    """Rough token estimate: 1 token ≈ 4 characters.

    Used for per-section budget enforcement inside :func:`_render`.  The same
    ratio is used by :func:`estimate_tokens` (which divides by 3); using 4
    here makes section budgets slightly conservative so the
    assembled manifest fits the global budget even before the final
    ``estimate_tokens`` check.
    """
    return len(text) // 4


def _section_budgets(total_budget: int, edited_tokens: int, section_content_counts: dict[str, int] | None = None) -> dict[str, int]:
    """Distribute the manifest token budget across variable sections.

    The edited-files section is must-preserve and gets its full allocation first.
    The remaining budget is split proportionally among sections with content:

        - ``symbols``  — 38 %
        - ``files``    — 22 %
        - ``greps``    — 15 %
        - ``bash``     — 10 %
        - ``web``      — 10 %
        - ``glob``     — 5 %

    Sections with zero entries are excluded from budget allocation, and their share
    flows proportionally to sections with content.

    Every non-empty section is guaranteed at least *_MIN_SECTION_TOKENS* tokens so that a
    section with a very tight budget still renders at least one line.

    Args:
        total_budget:          The global token ceiling for the entire manifest.
        edited_tokens:         Token estimate for the already-rendered edited-files block
                               (header + file lines + diff stat + commits).  This is
                               subtracted from *total_budget* before distribution.
        section_content_counts: Optional dict mapping section names to entry counts.
                               If provided, sections with count==0 get 0 allocation.
                               If None, all sections are treated as potentially having content
                               (backward-compat mode: static proportions).

    Returns:
        A dict with keys ``"symbols"``, ``"files"``, ``"greps"``, ``"bash"``, ``"web"``, ``"glob"``
        mapping to their respective token budgets.
    """
    remaining = max(0, total_budget - edited_tokens)

    # Proportions must sum to 1.0.
    base_proportions: dict[str, float] = {
        "symbols": 0.38,
        "files":   0.22,
        "greps":   0.15,
        "bash":    0.10,
        "web":     0.10,
        "glob":    0.05,
    }

    # If no content info provided, use static proportions (backward compatible).
    if section_content_counts is None:
        _MIN_SECTION_TOKENS = 20  # Old minimum for backward compat
        budgets: dict[str, int] = {}
        for name, ratio in base_proportions.items():
            budgets[name] = max(_MIN_SECTION_TOKENS, int(remaining * ratio))
        return budgets

    # Content-aware mode: filter out empty sections and redistribute their budget.
    # Identify which sections have content.
    sections_with_content = {
        name for name in base_proportions
        if section_content_counts.get(name, 0) > 0
    }

    # If no sections have content, return all zeros.
    if not sections_with_content:
        return {name: 0 for name in base_proportions}

    # Redistribute proportions: renormalize to sum to 1.0 among non-empty sections.
    active_proportions = {
        name: base_proportions[name] for name in sections_with_content
    }
    proportion_sum = sum(active_proportions.values())
    normalized_proportions = {
        name: (prop / proportion_sum) for name, prop in active_proportions.items()
    }

    # Allocate: empty sections get 0, others get proportional share with floor applied.
    _MIN_SECTION_TOKENS = 40  # Minimum for non-empty sections in content-aware mode
    result_budgets: dict[str, int] = {}
    for name in base_proportions:
        if name not in sections_with_content:
            result_budgets[name] = 0
        else:
            result_budgets[name] = max(_MIN_SECTION_TOKENS, int(remaining * normalized_proportions[name]))

    return result_budgets


def _grep_sort_key(entry: object, now_ts: float) -> float:
    """Composite sort key for grep entries: recency_weight * (1 + normalised match_count).

    Recency weight uses exponential decay with :data:`_GREP_RECENCY_HALF_LIFE_SECS`
    so a search from 30 minutes ago is worth half as much as one from just now.
    The match_count factor rewards searches that actually found results — a search
    that returned 20 matches is more load-bearing context than one that returned 0.
    Match counts are normalised to [0, 1] by capping at 100 so a single mega-result
    search does not completely swamp recency.

    Returns a float in (0, 2] — higher is more important.
    """
    age = max(0.0, now_ts - getattr(entry, "ts", 0.0))
    recency = math.exp(-age * math.log(2) / _GREP_RECENCY_HALF_LIFE_SECS)
    match_count = getattr(entry, "result_count", None)
    # Treat unknown result_count as 1 (neutral) so it neither boosts nor penalises.
    count_factor = 1.0 + min(100, match_count or 1) / 100.0
    return recency * count_factor


def _select_top_grep_entries(greps: list[object]) -> list[object]:
    """Pick up to :data:`_MAX_GREP_ENTRIES` best unique grep patterns for the manifest.

    **Step 1 — Dedup by pattern text**: iterate oldest→newest so the most-recent
    search (with its current path scope and result_count) overwrites earlier ones.
    Deduplicating by pattern alone (not pattern+path) avoids listing the same search
    term twice just because the scope changed between runs.

    **Step 2 — Drop stale entries**: patterns older than :data:`_GREP_STALE_SECS`
    (45 min) are unlikely to drive the next agent turn.  If *all* patterns are stale,
    the :data:`_GREP_MIN_WHEN_ALL_STALE` most-recent ones are kept so the section is
    never entirely empty when searches exist.

    **Step 3 — Rank by composite score**: :func:`_grep_sort_key` combines a
    30-minute recency half-life with a normalised match_count factor so searches that
    found more results AND were more recent surface first.

    Accepts ``greps`` typed as ``list[object]`` (rather than ``list[GrepEntry]``) to
    avoid importing :class:`session.GrepEntry` at cold-start time; all field access is
    via :func:`getattr`.
    """
    if not greps:
        return []

    # Step 1: Deduplicate by pattern — keep the most-recent occurrence.
    seen: dict[str, object] = {}
    for g in sorted(greps, key=lambda g: getattr(g, "ts", 0.0)):
        seen[getattr(g, "pattern", "")] = g
    candidates = list(seen.values())
    if not candidates:
        return []

    # Step 1b: Drop zero-result greps — searches that found nothing carry no
    # context the compaction LLM should preserve. If every grep was zero-result
    # (the user is exploring blindly and nothing matches yet), keep them all so
    # the section still surfaces — better to show "looking for X, no hits yet"
    # than nothing.
    with_hits = [g for g in candidates if (getattr(g, "result_count", 0) or 0) > 0]
    if with_hits:
        candidates = with_hits

    # Step 2: Staleness filter — drop entries older than _GREP_STALE_SECS.
    now_ts = time.time()
    fresh = [g for g in candidates if (now_ts - getattr(g, "ts", 0.0)) < _GREP_STALE_SECS]
    if not fresh:
        # All entries are stale — surface the _GREP_MIN_WHEN_ALL_STALE most-recent ones
        # so the section is never entirely empty when searches exist.
        fresh = heapq.nlargest(
            _GREP_MIN_WHEN_ALL_STALE,
            candidates,
            key=lambda g: getattr(g, "ts", 0.0),
        )

    # Step 3: Rank by composite (recency × match_count) score, then pick top N.
    return heapq.nlargest(_MAX_GREP_ENTRIES, fresh, key=lambda g: _grep_sort_key(g, now_ts))


def _dedup_grep_entries(
    entries: list[object],
    raw_counts: dict[str, int] | None = None,
) -> list[object]:
    """Deduplicate and annotate grep entries: group by pattern, keep best representative.

    When the same grep pattern appears multiple times in the entries list,
    this function collapses them into a single entry and appends " [×N]"
    to the pattern string where N is the count.  The entry with the most
    matches (or the latest timestamp if counts tie) is chosen as the
    representative.

    ``raw_counts`` is an optional pre-computed dict mapping pattern text to its
    total occurrence count in the *original* (unfiltered) session history.
    When provided, its count overrides the internal count that would otherwise
    always be 1 (because callers typically pass already-deduped entries from
    :func:`_select_top_grep_entries`).  This lets the annotation reflect how
    many times the agent actually ran each search.

    Args:
        entries: List of grep entry objects.
        raw_counts: Optional mapping of pattern → raw occurrence count.

    Returns:
        A deduplicated list where each unique pattern appears once,
        with the pattern field annotated with a count suffix when N > 1.
    """
    if not entries:
        return []

    # Group entries by pattern text
    pattern_groups: dict[str, tuple[object, int]] = {}
    for entry in entries:
        pattern = getattr(entry, "pattern", "")
        if not pattern:
            continue

        result_count = getattr(entry, "result_count", None)
        ts = getattr(entry, "ts", 0.0)

        if pattern not in pattern_groups:
            # First occurrence: store entry and count
            pattern_groups[pattern] = (entry, 1)
        else:
            # Subsequent occurrence: increment count and possibly replace entry
            existing_entry, count = pattern_groups[pattern]
            existing_count = getattr(existing_entry, "result_count", None)
            existing_ts = getattr(existing_entry, "ts", 0.0)

            # Prefer entry with more matches; on tie, prefer more recent
            should_replace = False
            if result_count is not None and existing_count is not None:
                should_replace = result_count > existing_count
            elif result_count is not None or ts > existing_ts:
                should_replace = True

            if should_replace:
                pattern_groups[pattern] = (entry, count + 1)
            else:
                pattern_groups[pattern] = (existing_entry, count + 1)

    # Build result: create modified entries with annotated patterns when count > 1.
    # When raw_counts is provided, use its value — the internal count is always 1
    # because _select_top_grep_entries already deduplicated before calling us.
    class _AugmentedEntry:
        """Wrapper that substitutes an annotated pattern without mutating the original."""
        def __init__(self, orig: object, new_pattern: str) -> None:
            self._orig = orig
            self._pattern = new_pattern

        def __getattr__(self, name: str) -> Any:
            if name == "pattern":
                return self._pattern
            return getattr(self._orig, name)

    result: list[object] = []
    for pattern, (entry, count) in pattern_groups.items():
        effective_count = (raw_counts or {}).get(pattern, count)
        if effective_count == 1:
            result.append(entry)
        else:
            annotated_pattern = f"{pattern} [×{effective_count}]"
            result.append(_AugmentedEntry(entry, annotated_pattern))

    return result


def _format_grep_entry(entry: object) -> str:
    """Render one :class:`session.GrepEntry` as a single manifest line.

    Format::

        - `pattern` in src/token_goat/ (12)
        - `pattern` (0)                (zero = dead end, still informative)
        - `pattern` in src/            (when result_count is unknown)

    Item #3: the explicit "results"/"result" noun is dropped — bare ``(N)`` is
    unambiguous in context and saves ~1 token per entry × _MAX_GREP_ENTRIES.
    The compaction LLM infers the count semantics from the grep line shape.
    """
    pattern = sanitize_log_str(getattr(entry, "pattern", ""), max_len=80)
    path = getattr(entry, "path", None)
    result_count = getattr(entry, "result_count", None)
    path_str = f" in {_short_path(path)}" if path else ""
    count_str = f" ({result_count})" if result_count is not None else ""
    return f"- `{pattern}`{path_str}{count_str}"


def _load_session_cache(session_id: str, caller: str) -> SessionCache | None:
    """Validate *session_id* and load the session cache, returning ``None`` on any failure.

    Thin shim over :func:`session_mod.safe_load` that adds a structured debug
    log line with file/grep/edit counts on success.  The four
    ``build_manifest*`` / ``event_count`` callers each pass a distinct *caller*
    label so log lines remain distinguishable.
    """
    from . import (
        session as session_mod,  # deferred — cold-start; __getattr__ handles external access
    )
    cache = session_mod.safe_load(session_id, caller=caller)
    if cache is not None:
        _LOG.debug(
            "%s: session=%s loaded (files=%d greps=%d edited=%d)",
            caller,
            session_id[:8],
            len(cache.files),
            len(cache.greps),
            len(cache.edited_files),
        )
    return cache


def _session_age_tier(age_seconds: float) -> str:
    """Classify session age into a tier that controls manifest verbosity.

    young  < 10 min  → minimal manifest; session is fresh, little to preserve
    active 10-60 min → standard manifest
    mature > 60 min  → expanded manifest; session has significant context
    """
    if age_seconds < 600:
        return "young"
    if age_seconds < 3600:
        return "active"
    return "mature"


def compute_adaptive_budget(
    cache: SessionCache,
    age_seconds: float = 0.0,
    *,
    has_pending_diff: bool = False,
    has_uncommitted_changes: bool = False,
) -> int:
    """Compute an adaptive token budget for the manifest based on session complexity.

    Simple sessions (few edits, no bash history) waste no budget; complex sessions
    get more room to preserve signal.  Formula:

        Base: 200 tokens
        + min(200, edited_files_count × 50)       [up to 4 files]
        + min(150, symbols_accessed_files × 30)   [up to 5 files with symbols]
        + 20 tokens if bash_history has entries
        + 50 tokens if there are pending git changes (git diff --stat HEAD non-empty)
        + 10 tokens if there are uncommitted changes (git diff/status non-empty)
        × tier multiplier (young=0.6, active=1.0, mature=1.4)
        Capped to [200, 800]

    *age_seconds* is the session age in seconds.  When omitted (or 0) the session
    is treated as young.  Pass ``time.time() - cache.created_ts`` at call sites
    that have the cache in hand.

    *has_pending_diff* should be ``True`` when ``_get_git_diff_stat_summary()``
    returned a non-empty string for this session's working directory.  Adds 50
    tokens to account for the "Pending Changes" section in the manifest.

    *has_uncommitted_changes* should be ``True`` when ``_get_uncommitted_changes()``
    returned a non-empty string.  Adds 10 tokens to account for the
    "Uncommitted Changes" section in the manifest.

    Returns a value guaranteed to be in the range [200, 800].
    """
    base = 200
    max_total = 800
    min_total = 200

    # Edited files bonus: 50 tokens per file, capped at 200
    edited_count = len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0
    edited_bonus = min(200, edited_count * 50)

    # Symbols accessed files bonus: 30 tokens per file, capped at 150
    symbols_files = sum(1 for e in cache.files.values() if e.symbols_read)
    symbols_bonus = min(150, symbols_files * 30)

    # Bash history bonus: 20 tokens if there are any entries
    bash_bonus = 20 if (getattr(cache, "bash_history", None) and cache.bash_history) else 0

    # Web history bonus: 15 tokens if there are any cached web fetches
    web_bonus = 15 if (getattr(cache, "web_history", None) and cache.web_history) else 0

    # Pending diff bonus: 50 tokens when there are uncommitted changes to show
    diff_bonus = 50 if has_pending_diff else 0

    # Uncommitted changes bonus: 10 tokens for the "Uncommitted Changes" section
    uncommitted_bonus = 10 if has_uncommitted_changes else 0

    raw_total = base + edited_bonus + symbols_bonus + bash_bonus + web_bonus + diff_bonus + uncommitted_bonus

    # Apply session-age tier multiplier: young sessions need less manifest space
    # (little context has accumulated); mature sessions need more.
    tier = _session_age_tier(age_seconds)
    tier_factors = {"young": 0.6, "active": 1.0, "mature": 1.4}
    factor = tier_factors[tier]
    total = int(round(raw_total * factor))

    return max(min_total, min(max_total, total))


def build_manifest_adaptive(session_id: str) -> str:
    """Load session cache and build manifest with adaptively-computed token budget.

    Convenience wrapper that loads the cache once and calls build_manifest with
    a budget computed from session complexity via :func:`compute_adaptive_budget`.

    Returns empty string when the session cache is missing or unreadable.
    """
    _LOG.debug("build_manifest_adaptive: session=%s", session_id[:8])
    cache = _load_session_cache(session_id, "build_manifest_adaptive")
    if cache is None:
        return ""
    created_ts = getattr(cache, "created_ts", None)
    age_seconds = max(0.0, time.time() - created_ts) if created_ts is not None else 0.0
    cwd = getattr(cache, "cwd", None)
    pending_diff = _get_git_diff_stat_summary(cwd)
    uncommitted = _get_uncommitted_changes(cwd)
    budget = compute_adaptive_budget(
        cache,
        age_seconds=age_seconds,
        has_pending_diff=bool(pending_diff),
        has_uncommitted_changes=bool(uncommitted),
    )
    # Activity-floor suppression: if the session has too little activity, skip
    # the full manifest.  A score below _ACTIVITY_FLOOR means essentially
    # "session started but nothing worth preserving happened" — a single file
    # read with no edits or commands is not worth injecting into the compaction.
    activity_score = _session_activity_score(cache)
    if activity_score < _ACTIVITY_FLOOR:
        _LOG.info(
            "build_manifest_adaptive: session=%s suppressed (activity_score=%d < floor=%d)",
            session_id[:8],
            activity_score,
            _ACTIVITY_FLOOR,
        )
        return ""

    _LOG.debug(
        "build_manifest_adaptive: session=%s budget=%d tier=%s (edited=%d symbols=%d bash=%s web=%s diff=%s uncommitted=%s activity=%d)",
        session_id[:8],
        budget,
        _session_age_tier(age_seconds),
        len(cache.edited_files) if isinstance(cache.edited_files, dict) else 0,
        sum(1 for e in cache.files.values() if e.symbols_read),
        bool(getattr(cache, "bash_history", None) and cache.bash_history),
        bool(getattr(cache, "web_history", None) and cache.web_history),
        bool(pending_diff),
        bool(uncommitted),
        activity_score,
    )
    cfg = _load_config()
    return _build_manifest_from_cache(cache, session_id, budget, **_compact_render_kwargs(cfg))


def event_count(session_id: str) -> int:
    """Count tracked events (reads + greps + edits + bash runs) for a session.

    Bash invocations are counted alongside reads/greps/edits so a session
    whose only activity is a cached test run still clears the
    ``min_events`` threshold for compaction-manifest emission — that command's
    output is exactly what the manifest is meant to preserve.
    """
    cache = _load_session_cache(session_id, "event_count")
    if cache is None:
        return 0
    return (
        len(cache.files)
        + len(cache.greps)
        + len(cache.edited_files)
        + len(getattr(cache, "bash_history", {}) or {})
        + len(getattr(cache, "skill_history", {}) or {})
    )


def _compact_render_kwargs(cfg: _Config) -> dict[str, int]:
    """Unpack the render-tuning fields from *cfg* into a kwargs dict.

    Used by the three public ``build_manifest*`` entry points so the field
    list lives in exactly one place.
    """
    ca = cfg.compact_assist
    return {
        "edited_dir_group_threshold": ca.edited_dir_group_threshold,
        "max_section_lines": ca.max_section_lines,
        "noise_floor_tokens": ca.noise_floor_tokens,
        "wide_session_threshold": ca.wide_session_threshold,
    }


def _build_manifest_from_cache(
    cache: SessionCache,
    session_id: str,
    max_tokens: int,
    edited_dir_group_threshold: int = 3,
    max_section_lines: int = 0,
    noise_floor_tokens: int = 0,
    wide_session_threshold: int = 15,
) -> str:
    """Render the manifest from an already-loaded *cache*.

    Separated from :func:`build_manifest` so :func:`build_manifest_with_count`
    can share the render + log path without a second disk load.

    Wall-clock timeout: if manifest construction exceeds _MANIFEST_TIMEOUT_SECS,
    returns what has been assembled so far with a note appended.
    """
    clamped = max(1, min(max_tokens, _MAX_MANIFEST_TOKENS_CAP))
    if clamped != max_tokens:
        _LOG.warning(
            "build_manifest: max_tokens=%d out of range [1, %d], clamped to %d",
            max_tokens,
            _MAX_MANIFEST_TOKENS_CAP,
            clamped,
        )
    max_tokens = clamped
    start = time.monotonic()
    result, files_with_symbols_count = _render(
        cache,
        session_id,
        max_tokens,
        edited_dir_group_threshold=edited_dir_group_threshold,
        max_section_lines=max_section_lines,
        noise_floor_tokens=noise_floor_tokens,
        wide_session_threshold=wide_session_threshold,
    )
    elapsed = time.monotonic() - start

    # Check if we exceeded the wall-clock timeout
    if elapsed > _MANIFEST_TIMEOUT_SECS:
        result += f"\n\n⚠ manifest build timed out after {elapsed:.2f}s — output may be incomplete"
        _LOG.warning(
            "build_manifest: timeout exceeded for session=%s (%.2fs > %.2fs)",
            session_id[:8],
            elapsed,
            _MANIFEST_TIMEOUT_SECS,
        )
    elif elapsed > _MANIFEST_TIMEOUT_SECS * 0.8:
        # Item #30: graduated warning — when render time crosses 80 % of the
        # hard timeout, emit a footer signal so operators see slow-render
        # sessions before they tip over into truncation.  Plain text, single
        # line, ~10 tokens cost; the compaction LLM ignores it but downstream
        # tooling and humans can grep for "(rendered in" to spot trouble.
        result += f"\n\n(rendered in {int(elapsed * 1000)}ms)"
        _LOG.info(
            "build_manifest: slow-render warning for session=%s (%.2fs > 80%% of %.2fs)",
            session_id[:8],
            elapsed,
            _MANIFEST_TIMEOUT_SECS,
        )

    token_estimate = estimate_tokens(result)
    _LOG.info(
        "build_manifest: session=%s edited_files=%d files_read=%d symbols_files=%d "
        "manifest_tokens=%d elapsed=%.3fs",
        session_id[:8],
        len(cache.edited_files),
        len(cache.files),
        files_with_symbols_count,
        token_estimate,
        elapsed,
    )
    return result


def build_manifest(session_id: str, *, max_tokens: int = 400) -> str:
    """Build a compact session manifest from the session cache.

    Returns structured text under *max_tokens* tokens that summarises:
    - Files edited this session (most important: must survive compaction)
    - Symbols accessed via token-goat read/symbol commands
    - Key files read, deduped and sorted by access frequency

    *max_tokens* is clamped to [1, _MAX_MANIFEST_TOKENS_CAP] to prevent a caller
    from triggering unbounded manifest construction via an extreme value.

    Safe to call even when the session cache is empty or missing.
    """
    _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id[:8], max_tokens)
    cache = _load_session_cache(session_id, "build_manifest")
    if cache is None:
        return ""

    # --- Manifest delta-cache (item #1, 2026-05-24 design) ---
    # Compute a cheap fingerprint from session inputs BEFORE rendering.  If the
    # sidecar exists, is fresh (< TTL), and the fingerprint matches, we can skip
    # the full _render and return a 1-line stub (~300-600 tokens saved per idle
    # multi-compaction session).  The fingerprint includes the last-bash exit_code
    # so a new red test result always busts the cache.
    now = time.time()
    fingerprint = _compute_manifest_fingerprint(cache)

    sidecar_data = _read_manifest_sidecar(session_id)
    prior_counts: dict[str, int] | None = None
    if (
        sidecar_data is not None
        and session_id not in _manifest_sha_written_this_process
    ):
        _cached_sha, cached_fp, cached_ts, prior_counts = sidecar_data
        sidecar_age = now - cached_ts
        # Cache-hit predicate requires 0 <= sidecar_age < TTL.  A negative age
        # means the sidecar's ``ts`` is in the future relative to the current
        # clock — clock skew, NTP step, a wall-clock rollback, or a manually
        # edited sentinel file.  Without the lower bound, ``-7_000_000_000s <
        # 600s`` would pass and pin the cache to a stub indefinitely.  A
        # cached_ts <= 0 means the sidecar was parsed from corrupted/legacy
        # data and should likewise force a full rebuild (the read helper
        # coerces ``data["ts"]`` to float, but a missing/zero stored ts would
        # arrive here as 0.0 if ever serialized by an older writer).
        if (
            cached_ts > 0.0
            and 0.0 <= sidecar_age < _MANIFEST_CACHE_TTL_SECS
            and cached_fp == fingerprint
        ):
            emit_time = datetime.fromtimestamp(cached_ts, tz=UTC).strftime("%H:%M")
            short_id = session_id[:8] if len(session_id) >= 8 else session_id
            _LOG.debug(
                "build_manifest: sidecar cache-hit session=%s fp=%s age=%.0fs — returning stub",
                session_id[:8], fingerprint, sidecar_age,
            )
            return (
                f"## Token-Goat Manifest — unchanged since {emit_time}. "
                f"Recall: `token-goat compact-hint --session-id {short_id}`."
            )
        # Log negative-age incidents so operators notice clock-skew problems.
        if sidecar_age < 0.0:
            _LOG.warning(
                "build_manifest: sidecar ts is in the future session=%s skew=%.0fs"
                " — ignoring cache, rebuilding manifest",
                session_id[:8], -sidecar_age,
            )
            # Drop the poisoned prior_counts: an out-of-band/future ts often
            # implies the sidecar is from a different machine or session swap,
            # so its counts would yield a misleading delta.
            prior_counts = None
        elif cached_ts <= 0.0:
            _LOG.warning(
                "build_manifest: sidecar ts is non-positive session=%s ts=%r"
                " — ignoring cache, rebuilding manifest",
                session_id[:8], cached_ts,
            )
            prior_counts = None
    elif sidecar_data is not None:
        # Cache write happened earlier in this process — still surface prior_counts
        # for the delta line so the new manifest reflects the growth/shrink.
        _cached_sha, cached_fp, cached_ts, prior_counts = sidecar_data

    # Cache miss or TTL expired: render the full manifest.
    cfg = _load_config()
    full_manifest = _build_manifest_from_cache(
        cache, session_id, max_tokens, **_compact_render_kwargs(cfg)
    )
    if not full_manifest:
        return full_manifest

    # Item #26: prepend a one-line **Δ since last compact:** when the prior
    # sidecar carried a counts payload AND any section count changed.  First-time
    # compactions (prior_counts is None) skip the line — no "Δ: first compact"
    # noise.  The line is inserted as the very first content line of the manifest
    # so the compaction LLM sees what changed before reading anything else.
    current_counts = _compute_section_counts(cache)
    delta_line = _format_manifest_delta(prior_counts, current_counts)
    if delta_line:
        full_manifest = delta_line + "\n" + full_manifest

    # Persist the sidecar with the new SHA + fingerprint + counts so the next
    # PreCompact can skip rendering AND compute a delta against current counts.
    sha = _short_content_hash(full_manifest)
    _write_manifest_sidecar(session_id, sha, fingerprint, now, counts=current_counts)
    _manifest_sha_written_this_process.add(session_id)

    # Also update the session-JSON fields so legacy callers and stats remain consistent.
    from . import (
        session as session_mod,  # deferred — cold-start; __getattr__ handles external access
    )
    cache.last_manifest_sha = sha
    cache.last_manifest_ts = now
    cache._invalidate_json_cache()
    session_mod.save(cache)

    return full_manifest


def build_manifest_with_count(
    session_id: str,
    *,
    max_tokens: int = 400,
) -> tuple[str, int]:
    """Load the session cache once and return ``(manifest, event_count)``.

    Callers that need both values (e.g. the PreCompact hook, which checks the
    event count before deciding whether to inject the manifest) should prefer
    this function over calling :func:`event_count` and :func:`build_manifest`
    separately — the separate calls each deserialize the session JSON from disk,
    paying the I/O and parse cost twice for every compaction trigger.

    Returns ``("", 0)`` when the session cache is missing or unreadable.
    """
    _LOG.debug("build_manifest_with_count: session=%s max_tokens=%d", session_id[:8], max_tokens)
    cache = _load_session_cache(session_id, "build_manifest_with_count")
    if cache is None:
        return "", 0
    n_events = (
        len(cache.files)
        + len(cache.greps)
        + len(cache.edited_files)
        + len(getattr(cache, "bash_history", {}) or {})
        + len(getattr(cache, "skill_history", {}) or {})
    )
    # Delegate to build_manifest so the sidecar cache fast-path, delta-line,
    # and session write-back all apply.  The extra JSON deserialisation inside
    # build_manifest is negligible vs. the git subprocess calls in the cache-miss
    # path, and the sidecar hit path avoids those entirely.
    manifest = build_manifest(session_id, max_tokens=max_tokens)
    return manifest, n_events


def _cap_line(line: str, max_len: int = 120) -> str:
    """Cap a line to max_len characters, truncating with '…' if exceeded.

    If the line is longer than *max_len*, returns ``line[:max_len-1] + "…"``.
    Otherwise returns *line* unchanged.  Header lines (starting with '###')
    are never capped — they are structural and must be preserved whole.

    Args:
        line: The line to cap.
        max_len: Maximum line length (default 120).

    Returns:
        The original line, or a truncated version with ellipsis.
    """
    return ellipsize(line, max_len)


def _load_task_list(session_id: str) -> list[dict[str, str]]:
    """Load TaskList entries for *session_id* from ``~/.claude/tasks/<session_id>/``.

    Claude Code persists each task as a separate JSON file named ``<id>.json``
    inside a per-session subdirectory.  We read every ``*.json`` file in that
    directory, parse the ``id``, ``subject``, and ``status`` fields, and return
    the raw list (unsorted, unfiltered — callers apply their own predicate).

    Returns an empty list on any error (missing directory, permission denied,
    malformed JSON) so callers never need to handle exceptions.
    """
    from . import paths as paths_mod  # noqa: PLC0415

    try:
        tasks_dir = paths_mod.safe_join(paths_mod.claude_config_dir() / "tasks", session_id)
    except ValueError:
        return []
    if not tasks_dir.is_dir():
        return []

    results: list[dict[str, str]] = []
    try:
        for p in tasks_dir.glob("*.json"):
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    continue
                task_id = str(data.get("id", p.stem))
                subject = str(data.get("subject", "")).strip()
                status = str(data.get("status", "")).strip().lower()
                if subject and status:
                    results.append({"id": task_id, "subject": subject, "status": status})
            except Exception:  # noqa: BLE001
                _LOG.debug("_load_task_list: skipping malformed task file %s", p)
    except Exception:  # noqa: BLE001
        _LOG.debug("_load_task_list: error reading tasks dir %s", tasks_dir)
    return results


def _render_tasks_section(
    tasks: list[dict[str, str]],
    *,
    edited_paths: set[str] | None = None,
) -> list[str]:
    """Render a ``### TODOs`` manifest section from a raw task list.

    Filters to ``pending`` and ``in_progress`` (``in-progress``) tasks, caps at
    :data:`_MAX_TODO_ENTRIES`, truncates subjects to :data:`_MAX_TODO_SUBJECT_CHARS`
    chars, and returns an empty list when no qualifying tasks remain.

    The status prefix uses ``[ ]`` for pending and ``[→]`` for in-progress so
    the compaction LLM can distinguish work not yet started from work underway.

    Item #29: when *edited_paths* is provided, tasks whose subject contains the
    basename or trailing path component of any edited file are suppressed —
    those files are already pinned in the Edited section, so the TODO line
    duplicates context that the compaction LLM already has.  Path matching is
    case-insensitive against both basename and the last two path segments to
    catch common phrasings like "update auth.py" and "fix src/auth.py".
    """
    active_statuses = {"pending", "in_progress", "in-progress"}
    active = [t for t in tasks if t.get("status", "") in active_statuses]
    if not active:
        return []

    # Item #29: build a deduped set of edited-file basenames + last-two-segments
    # so a substring match against the task subject is fast and predictable.
    _suppress_tokens: set[str] = set()
    if edited_paths:
        import os as _os
        for p in edited_paths:
            norm = _norm_key(p)
            basename = _os.path.basename(norm)
            if basename:
                _suppress_tokens.add(basename)
            # Last two path segments (e.g. "src/auth.py") catch
            # "src/auth.py is broken"-style subjects without matching too broadly.
            parts = norm.strip("/").split("/")
            if len(parts) >= 2:
                _suppress_tokens.add("/".join(parts[-2:]))

    def _is_about_edited_file(subject: str) -> bool:
        if not _suppress_tokens:
            return False
        s = subject.lower()
        return any(tok in s for tok in _suppress_tokens)

    filtered_active = [t for t in active if not _is_about_edited_file(t["subject"])]
    if not filtered_active:
        return []

    lines: list[str] = ["**TODOs:**"]
    shown = filtered_active[:_MAX_TODO_ENTRIES]
    for t in shown:
        subject = t["subject"]
        subject = ellipsize(subject, _MAX_TODO_SUBJECT_CHARS)
        status = t.get("status", "pending")
        marker = "[→]" if status in ("in_progress", "in-progress") else "[ ]"
        lines.append(f"- {marker} {subject}")

    overflow = len(filtered_active) - len(shown)
    if overflow > 0:
        lines.append(f"- …+{overflow} more")

    return lines


def _apply_section_line_cap(lines: list[str], cap: int) -> list[str]:
    """Truncate a section's bullet list to at most *cap* items, appending a "+N more" tail.

    When cap <= 0 (disabled) or cap >= len(lines), returns *lines* unchanged.
    Otherwise, returns a new list with the first *cap* items plus a final
    "(+N more)" line indicating the number of truncated entries.

    This prevents a single bloated section (e.g. 80 edited files) from dominating
    the manifest budget at the expense of other sections. Apply this AFTER
    directory-grouping so grouped lines count as 1 item each.

    Args:
        lines: List of manifest lines, typically header + bullet items.
               Expected format: ["### Header", "- item1", "- item2", ...].
        cap: Maximum number of items (lines after the header) to keep.
             Values <= 0 disable the cap and return *lines* unchanged.

    Returns:
        Either *lines* unchanged (if cap is disabled or >= len(lines)),
        or a new list with the header + first *cap* items + a "+N more" tail.
    """
    if cap <= 0 or not lines:
        return lines

    # The first line is the header; count items after it.
    if len(lines) <= 1:
        return lines

    # Skip the header (line 0) when counting items.
    item_count = len(lines) - 1
    if item_count <= cap:
        return lines

    # Truncate: keep header + first cap items, then add "+N more" tail.
    kept_lines = lines[:cap + 1]  # header + cap items
    overflow = item_count - cap
    kept_lines.append(f"- ... (+{overflow} more)")
    return kept_lines


def _render_section(
    header: str,
    entries: list[Any],
    fmt: Callable[[Any], str],
) -> list[str]:
    """Render a manifest section as a list of lines.

    Returns an empty list when *entries* is empty (so the caller can safely
    concatenate with ``+`` without adding a blank section).  Lines produced by
    *fmt* that are themselves empty strings are silently skipped.

    This covers the common section shape::

        ### Header
        - line_1
        - line_2

    Content lines are capped at 120 characters to guarantee predictable token
    use; header lines are never capped.

    Sections with token-budget loops, sub-sections, or non-trivial formatting
    keep their own inline implementation in :func:`_render`.
    """
    if not entries:
        return []
    # Bold-label headers (starting with "**") are already fully formed; plain
    # header strings get the markdown H3 prefix so legacy callers are unaffected.
    hdr_line = header if header.startswith("**") else f"### {header}"
    lines: list[str] = [hdr_line]
    for entry in entries:
        line = fmt(entry)
        if line:
            lines.append(_cap_line(line))
    return lines


# Item #28: threshold for the **Slow:** bash group.  A successfully-exited
# command that took longer than this many seconds is surfaced separately so
# the compaction LLM (and post-compact agent) can see "this passes but is
# expensive" candidates worth speeding up.
_SLOW_BASH_THRESHOLD_SECS: Final[float] = 5.0


def _classify_bash_entry(entry: object) -> str:
    """Return one of ``"failed"``, ``"slow"``, or ``"ok"`` for grouped emission.

    - ``failed``: exit_code is not None and not zero.
    - ``slow``:   exit_code == 0 AND wall time > _SLOW_BASH_THRESHOLD_SECS.
    - ``ok``:     everything else (including exit_code is None — unknown class
                   defaults to ok rather than failed to avoid scary false alarms).

    Wall-time is read defensively via ``getattr(entry, "elapsed_ms", 0)`` then
    ``elapsed_s`` so the function works with both the in-memory ``BashEntry``
    dataclass (which may grow either field in future) and the test fixtures
    that only set a subset of attributes.
    """
    exit_code = getattr(entry, "exit_code", None)
    if exit_code is not None and exit_code != 0:
        return "failed"
    elapsed_ms = getattr(entry, "elapsed_ms", None)
    if elapsed_ms is None:
        elapsed_s = float(getattr(entry, "elapsed_s", 0.0) or 0.0)
    else:
        try:
            elapsed_s = float(elapsed_ms) / 1000.0
        except (TypeError, ValueError):
            elapsed_s = 0.0
    if exit_code == 0 and elapsed_s > _SLOW_BASH_THRESHOLD_SECS:
        return "slow"
    return "ok"


def _render_bash_grouped(
    bash_entries: list[object],
    budget: int,
    should_inline: Callable[[object], bool],
) -> tuple[list[str], int]:
    """Item #28: emit bash entries grouped by exit-code class.

    Produces::

        **Recent Commands:**
        **Failed:**
        - $ pytest tests/  (e=1, ...)
        **Slow:**
        - $ pip install ...  (e=0, ...)
        **Ok:**
        - $ ls (e=0, ...)

    Within each group the existing entry order (recency-then-size, as built
    by :func:`_select_top_bash_entries`) is preserved.  Empty groups omit
    their sub-header.  When every retained entry is in a single group AND
    that group is ``ok``, the sub-header is omitted entirely (**Recent Commands:**
    alone is sufficient context — saves ~3 tokens on the common all-passing case).
    Token budget is honoured greedily in group-priority order (failed first).
    """
    if not bash_entries:
        return [], 0

    # Partition while preserving original order within each bucket.
    by_class: dict[str, list[object]] = {"failed": [], "slow": [], "ok": []}
    for be in bash_entries:
        by_class[_classify_bash_entry(be)].append(be)

    header = "**Recent Commands:**"
    header_cost = _token_count(header)
    out: list[str] = [header]
    used = header_cost

    # Item #28 micro-opt: skip the **Ok:** sub-header on the common case where
    # every entry passes — the **Recent Commands:** label is enough context and we save
    # ~3 tokens per all-green manifest.
    only_ok = (
        not by_class["failed"] and not by_class["slow"] and bool(by_class["ok"])
    )

    # Emit groups in priority order so a tight budget still surfaces failures.
    _ORDER: tuple[tuple[str, str | None], ...] = (
        ("failed", "**Failed:**"),
        ("slow", "**Slow:**"),
        ("ok", None if only_ok else "**Ok:**"),
    )

    emitted_any = False
    for group_key, sub_header in _ORDER:
        group_entries = by_class[group_key]
        if not group_entries:
            continue
        # Reserve room for the sub-header before trying to fit content lines.
        sub_header_cost = _token_count(sub_header) if sub_header else 0
        if sub_header and used + sub_header_cost > budget:
            break  # Even the sub-header doesn't fit — stop here.

        group_lines: list[str] = []
        group_cost = 0
        for be in group_entries:
            line = _format_bash_entry(be, inline_snippet=should_inline(be))
            cost = _token_count(line)
            if used + sub_header_cost + group_cost + cost > budget:
                break
            group_lines.append(line)
            group_cost += cost

        if not group_lines:
            continue  # No content fits — don't emit a lone sub-header.

        if sub_header:
            out.append(sub_header)
            used += sub_header_cost
        out.extend(group_lines)
        used += group_cost
        emitted_any = True

    if not emitted_any:
        return [], 0
    return out, used


def _render_budget_lines(
    header: str,
    lines: list[str],
    budget: int,
    min_lines: int = 1,
) -> tuple[list[str], int]:
    """Emit header + as many pre-formatted lines as fit within *budget* tokens.

    Returns ``(output_lines, tokens_used)``; ``output_lines`` is empty when
    nothing fits.  Callers pre-format their entries so this helper owns only
    the header-gating and budget-loop logic, eliminating the repeated 15-line
    pattern across the symbols / bash / web / grep sections of :func:`_render`.

    *min_lines* (default 1): the minimum number of content lines required for
    the section to be emitted at all.  Sections like ``### Web Fetches`` and
    ``### Directory Scans`` with only one entry are rarely worth the header
    overhead; pass ``min_lines=2`` for those callers.
    """
    if not lines:
        return [], 0
    header_cost = _token_count(header)
    out: list[str] = []
    used = 0
    for line in lines:
        cost = _token_count(line)
        if used + header_cost + cost <= budget:
            out.append(line)
            used += cost
        else:
            break
    if len(out) < min_lines:
        return [], 0
    return [header] + out, used + header_cost


def _build_sealed_block(
    edited_clean: dict[str, int],
    blocker_entries: list[object],
    raw_skills: dict,
) -> list[str]:
    """Build the above-the-fold sealed block prepended before the main manifest body.

    Format::

        ### MUST_PRESERVE
        <<preserve>>
        🎯 RESUME: auth.py
        ✎ auth.py×3  db.py  session.py
        ⛔ pytest tests/  (exit 1)
        🧠 ralph  plugin:improve
        <</preserve>>

    The RESUME line tells the post-compact agent which single file to re-read
    first to recover state — the same anchor recovery that Ralph's
    ``RESUME_POINT`` protocol calls for after a compaction event.  Priority
    order: most-edited file > most-recent blocker's command > skipped.  This
    line is small (~14-25 chars) and sits inside the preserve markers
    so the compaction LLM is unlikely to summarise it away.

    The block is omitted entirely (empty list) when all three content slots
    are empty.  Content is bounded at 80 tokens (≤ 320 characters).  The
    markdown header makes the block discoverable to structured queries while
    the XML-like inner markers provide fail-safe signal for the compaction LLM.
    """

    # Slot (a): ≤3 edited basenames with edit counts
    edit_slot = ""
    top_edited_basename = ""  # for the RESUME line below
    if edited_clean:
        # Sort by edit count descending, take top 3
        top_edits = sorted(edited_clean.items(), key=_BY_EDIT_COUNT, reverse=True)[:3]
        parts = []
        for path, count in top_edits:
            basename = sanitize_log_str(os.path.basename(path) or path, max_len=40)
            parts.append(f"{basename}×{count}" if count > 1 else basename)
        edit_slot = "✎ " + "  ".join(parts)
        # First (most-edited) basename anchors the RESUME pointer.
        if top_edits:
            top_edited_basename = sanitize_log_str(
                os.path.basename(top_edits[0][0]) or top_edits[0][0], max_len=40
            )

    # Slot (b): most-recent blocker (truncated to 80 chars).
    # When the cached output yields a usable error preview, prefer it over
    # the bare "(exit N)" tail — the preview carries WHY the command failed
    # (e.g. "AssertionError: …", "ModuleNotFoundError: …"), which lets a
    # post-compact agent skip re-running the command to diagnose.
    blocker_slot = ""
    blocker_cmd_word = ""  # first word of the failing cmd, fallback RESUME anchor
    if blocker_entries:
        most_recent = max(blocker_entries, key=lambda e: getattr(e, "ts", 0.0))
        cmd = sanitize_log_str(getattr(most_recent, "cmd_preview", ""), max_len=70)
        exit_code = getattr(most_recent, "exit_code", "?")
        # Compute remaining char budget for the rationale clause: the sealed
        # block hard-caps each slot at 80 chars, so subtract the cmd + "⛔ " +
        # " — " framing to know how much room is left for the preview text.
        framing = f"⛔ {cmd} — "
        room = max(0, 80 - len(framing))
        preview = _extract_blocker_error_preview(most_recent, max_chars=room) if room >= 12 else ""
        raw = f"⛔ {cmd} — {preview}" if preview else f"⛔ {cmd}  (exit {exit_code})"
        blocker_slot = raw[:80]
        # Strip leading flags / env vars to land on the actual binary, e.g.
        # "FOO=bar pytest tests/" → "pytest".  Falls back to the first token
        # when no obvious binary is present.
        for tok in cmd.split():
            if "=" not in tok and not tok.startswith("-"):
                blocker_cmd_word = sanitize_log_str(tok, max_len=30)
                break

    # Slot (c): ≤2 active skill names (excluding stale skills)
    skill_slot = ""
    if raw_skills:
        now = time.time()
        # Filter to recently-loaded skills only
        recent_skills = [
            entry for entry in raw_skills.values()
            if (now - getattr(entry, "ts", 0.0)) <= _SKILL_STALE_THRESHOLD_SECS
        ]
        top_skills = heapq.nlargest(
            2, recent_skills, key=lambda e: getattr(e, "ts", 0.0)
        )
        names = [sanitize_log_str(getattr(e, "skill_name", ""), max_len=40) for e in top_skills]
        names = [n for n in names if n]
        if names:
            skill_slot = "🧠 " + "  ".join(names)

    # Skip the entire block when all three content slots are empty.
    # The RESUME line is derived from those slots so an empty block stays empty.
    if not edit_slot and not blocker_slot and not skill_slot:
        return []

    # RESUME pointer — first inner line so post-compact attention lands on it first.
    # Prefer the most-edited file (ongoing work); fall back to the failing command
    # (the most recent thing the agent tried).  Skip silently when neither applies
    # (e.g. skills-only sealed block — the skill list already implies the anchor).
    resume_slot = ""
    if top_edited_basename:
        resume_slot = f"🎯 RESUME: {top_edited_basename}"
    elif blocker_cmd_word:
        resume_slot = f"🎯 RESUME: re-run {blocker_cmd_word}"

    inner = [s for s in (resume_slot, edit_slot, blocker_slot, skill_slot) if s]
    block = ["### MUST_PRESERVE", "<<preserve>>"] + inner + ["<</preserve>>"]

    # Enforce 80-token cap: if the block is too large, truncate inner content.
    # The RESUME line is the highest-priority anchor — keep it intact and trim
    # the other slots first.  If still over after trimming, drop the skill slot.
    block_text = "\n".join(block)
    if _token_count(block_text) > 80:
        # Preserve resume_slot verbatim; trim the rest to 60 chars each.
        trimmed_rest = [line[:60] for line in (edit_slot, blocker_slot, skill_slot) if line]
        inner_trimmed = ([resume_slot] if resume_slot else []) + trimmed_rest
        block = ["### MUST_PRESERVE", "<<preserve>>"] + inner_trimmed + ["<</preserve>>"]
        # If still over the cap, drop the skill slot (lowest signal of the three).
        # Compare the truncated form: inner_trimmed holds line[:60] copies, not originals.
        truncated_skill = skill_slot[:60] if skill_slot else ""
        if _token_count("\n".join(block)) > 80 and truncated_skill and truncated_skill in inner_trimmed:
            inner_trimmed.remove(truncated_skill)
            block = ["### MUST_PRESERVE", "<<preserve>>"] + inner_trimmed + ["<</preserve>>"]

    return block


def _apply_noise_floor(
    section_groups: list[tuple[str, list[str], bool]],
    noise_floor: int,
) -> list[tuple[str, list[str], bool]]:
    """Filter out small unprotected sections when their token count is below the noise floor.

    Args:
        section_groups: List of (name, lines, protected) tuples representing manifest sections.
        noise_floor: Minimum token count threshold. Sections with fewer tokens are dropped.
                     If 0, no filtering is applied.

    Returns:
        A new list with small unprotected sections removed. Protected sections (protected=True)
        are always kept. Only body subsections (not header/legend) can be dropped.
    """
    if noise_floor <= 0:
        return section_groups

    filtered: list[tuple[str, list[str], bool]] = []
    for name, lines, protected in section_groups:
        if protected:
            # Always keep protected sections
            filtered.append((name, lines, protected))
        else:
            # For unprotected sections, check token count
            if not lines:
                # Empty section — drop it
                continue
            section_text = "\n".join(lines)
            section_tokens = _token_count(section_text)
            if section_tokens >= noise_floor:
                # Keep it — above noise floor
                filtered.append((name, lines, protected))
            else:
                # Drop it — below noise floor
                _LOG.debug(
                    "_apply_noise_floor: dropped section=%s tokens=%d < floor=%d",
                    name, section_tokens, noise_floor,
                )
    return filtered


def _render(
    cache: SessionCache,
    session_id: str,
    max_tokens: int,
    edited_dir_group_threshold: int = 3,
    max_section_lines: int = 0,
    noise_floor_tokens: int = 0,
    wide_session_threshold: int = 15,
) -> tuple[str, int]:
    """Build the Markdown session manifest string from *cache* for the PreCompact hook.

    Priority order (inverted pyramid — most critical first so truncation hurts least):
    0. **Current Blockers** — failed bash commands from the last 60 min (up to 3).
       Omitted entirely when there are no recent failures.
    0b.**Uncommitted Changes** — ``git diff --stat HEAD`` + ``git status --short``,
       capped at 8 lines / 200 chars.  Provides a ground-truth view of what's on
       disk (including manual edits and untracked files) before the Claude-tracked
       sections.  Omitted when the working tree is clean or git is unavailable.
    1. **Edited files** — always listed after blockers; the compaction LLM must preserve these.
       This section is uncapped — every edited file is must-preserve.
    2. **Recent Commands** — cached command outputs from session; the current work context.
       Capped at 15 % of remaining budget.
    3. **Symbols Accessed** — files where specific symbols were read via ``token-goat read``,
       ranked by most-recent access first, capped at 40 % of remaining budget.
    4. **Web Fetches** — reference material (docs, API responses) loaded mid-session, capped at 10 %.
    5. **Patterns Searched** — recent grep/search patterns, capped at 15 % of remaining budget.
    6. **Key files read** — top files by ``read_count`` (most re-read first), capped at 30 %.
    6b.**TODOs** — pending/in-progress TaskList entries read from
       ``~/.claude/tasks/<session_id>/``.  No budget slice — the section is small
       (≤5 lines) and uses overall headroom.  Omitted when the task directory is
       absent or all tasks are completed.

    Budget allocation via :func:`_section_budgets`: the edited-files block is rendered
    first and its token cost is subtracted from the global budget before the remaining
    sections split the remainder proportionally.  Each section builder stops adding
    entries when its slice is exhausted.  No post-hoc bottom-trimming is needed.

    Each manifest line is prefixed with an activity marker so the compaction LLM
    can distinguish edited (``✎``) from read-only (``→``) files — edited files
    represent ongoing work and must always survive compaction, whereas a file
    read once for context can be safely summarised.

    Noise paths (``.pyc``, ``__pycache__/``, lockfiles, OS metadata, build dirs)
    are filtered out before any ranking so the budget is spent on entries the
    compaction LLM can actually use.  See :func:`is_noise_path` for the full
    deny-list.

    Returns a (manifest_string, symbols_files_count) tuple.  The string is empty
    when the cache has no meaningful data (nothing edited, no symbols accessed,
    no files read).
    """
    # Filter noise paths out of both maps before any other work.
    # Build artifacts, lockfiles, and cache dirs eat manifest budget for items the
    # compaction LLM can't usefully preserve.  Filter once up-front so every
    # downstream selection (top_files, files_with_symbols, edited_files) inherits
    # the cleaned input — no need to repeat the predicate per-section.
    # Defensive: legacy/test fixtures sometimes hand us a list for edited_files
    # rather than a dict; guard with isinstance so the filter never KeyErrors.
    raw_edited = cache.edited_files if isinstance(cache.edited_files, dict) else {}
    # Item #32: cache is_noise_path() results per render so each path is
    # classified at most once.  On wide sessions (200+ files) the previous
    # repeated calls (edited_clean, files_clean.rel_or_abs, files_clean.key)
    # ran 600+ regex/segment checks; routing through a local dict drops that
    # to one classification per unique path.
    _noise_cache: dict[str, bool] = {}

    def _is_noise(path: str) -> bool:
        cached = _noise_cache.get(path)
        if cached is None:
            cached = is_noise_path(path)
            _noise_cache[path] = cached
        return cached

    edited_clean: dict[str, int] = {
        path: count for path, count in raw_edited.items()
        if not _is_noise(path)
    }
    files_clean: dict[str, FileEntry] = {
        key: entry for key, entry in cache.files.items()
        if not _is_noise(entry.rel_or_abs) and not _is_noise(key)
    }
    noise_skipped = (
        (len(raw_edited) - len(edited_clean))
        + (len(cache.files) - len(files_clean))
    )
    if noise_skipped:
        _LOG.debug(
            "_render: filtered %d noise path(s) from manifest input (session=%s)",
            noise_skipped, session_id[:8],
        )

    # Nothing to report when the session has no activity at all.
    # edited_files covers writes; files covers reads; greps covers searches;
    # bash_history covers commands run.  All four empty → just a header → not worth injecting.
    raw_greps = getattr(cache, "greps", None) or []
    _raw_bash = getattr(cache, "bash_history", None)
    raw_bash: dict = _raw_bash if isinstance(_raw_bash, dict) else {}
    _raw_web = getattr(cache, "web_history", None)
    raw_web: dict = _raw_web if isinstance(_raw_web, dict) else {}
    _raw_skills = getattr(cache, "skill_history", None)
    raw_skills: dict = _raw_skills if isinstance(_raw_skills, dict) else {}
    _raw_decisions = getattr(cache, "decisions", None)
    raw_decisions_for_activity: list = _raw_decisions if isinstance(_raw_decisions, list) else []
    if (
        not edited_clean and not files_clean and not raw_greps
        and not raw_bash and not raw_web and not raw_skills
        and not raw_decisions_for_activity
    ):
        _LOG.info(
            "_render: manifest suppressed for session=%s "
            "(no activity tracked: edited=0 files_read=0 greps=0 bash=0 skills=0 decisions=0)",
            session_id[:8],
        )
        return "", 0

    # Normalised key set of edited files (lower-cased forward-slash form) so we can
    # de-dup the "Key Files Read" section against the "Files Edited" section.
    # An edited file is *already* flagged as must-preserve in the edited section;
    # listing it a second time under Key Files Read wastes budget without adding
    # signal.  We compare normalised forms because edited_files keys come from
    # session._normalize_path() and files-dict keys come from the same helper —
    # but the rel_or_abs display strings differ (relative vs. absolute), so we
    # match on the dict keys, not the display path.
    edited_keys = {_norm_key(p) for p in edited_clean}

    # Compute session age and tier once up-front — used in multiple sections below.
    _created_ts = getattr(cache, "created_ts", None)
    age_secs = max(0.0, time.time() - _created_ts) if _created_ts is not None else 0.0
    age_tier = _session_age_tier(age_secs)

    # Files where the agent has a cached read that predates a subsequent edit —
    # the snapshot in context may no longer match the file on disk.
    stale_read_files: list[str] = [
        entry.rel_or_abs
        for key, entry in files_clean.items()
        if getattr(entry, "last_edit_ts", 0.0) > entry.last_read_ts
        and _norm_key(key) not in edited_keys
    ]

    # Rank "Symbols Accessed" by most-recent read first.  When a long session
    # touches many files, the *recent* symbols are more load-bearing for the
    # upcoming compaction than ones inspected at the start.  Previously we used
    # insertion order (whatever dict-iteration gave us), which is arbitrary and
    # often dumps the earliest reads into the manifest while burying the latest.
    files_with_symbols_all = [
        e for e in files_clean.values()
        if e.symbols_read
    ]
    files_with_symbols = heapq.nlargest(
        _MAX_SYMBOLS_FILES, files_with_symbols_all, key=_BY_LAST_READ_TS
    )
    files_with_symbols_count = len(files_with_symbols)

    # Most-important files, capped at _MAX_FILES_READ, for the "Key Files Read" section.
    # Uses _importance_score() — a composite of read frequency, symbols accessed,
    # edit status, and recency — rather than read_count alone.  This surfaces files
    # the agent genuinely worked with (e.g. read once but accessed many symbols, or
    # read/edited recently) over files that were merely scanned many times.
    #
    # heapq.nlargest is O(n log k) instead of O(n log n) full sort — material when a
    # long session has hundreds of file entries but we only need the top 10.
    # The heap keeps only k items in memory, so this is also more memory-efficient
    # than sorting the full list when sessions accumulate many hundreds of file reads.
    # We exclude files that already appear in the Edited section: those are pinned
    # at higher priority and re-listing them duplicates manifest budget.
    now_for_scoring = time.time()
    total_files_read = len(files_clean)
    key_files_candidates = [
        entry for key, entry in files_clean.items()
        if _norm_key(key) not in edited_keys
    ]
    # Files that are also in edited_files (path key match) get an edit_bonus even
    # when they appear in key_files_candidates — this handles the case where a file
    # was both read and edited but its edit-section entry predates the re-read so it
    # wasn't deduplicated into edited_keys.  Normalized key lookup for robustness.
    edited_keys_set = edited_keys  # already a set of normalized lower/forward-slash keys
    # Mature sessions (> 60 min) get 2 extra key-file slots: more context has
    # accumulated and the compaction LLM benefits from a broader file picture.
    # Item #23: dynamically reduce max_files_read when there are many edited files —
    # the Files Edited section already covers those paths, so the Key Files Read
    # section has diminishing value and should yield budget to higher-signal sections.
    _n_edited = len(edited_clean)
    if _n_edited >= 10:
        _dynamic_max_files = 4
    elif _n_edited >= 5:
        _dynamic_max_files = 6
    else:
        _dynamic_max_files = _MAX_FILES_READ
    max_key_files = _dynamic_max_files + (2 if age_tier == "mature" else 0)
    top_files = heapq.nlargest(
        max_key_files,
        key_files_candidates,
        key=lambda e: _importance_score(
            e,
            now_for_scoring,
            edit_bonus=15.0 if _norm_key(e.rel_or_abs) in edited_keys_set else 0.0,
        ),
    )
    _LOG.debug(
        "_render: selected top %d/%d files by importance_score (cap=%d); "
        "files_with_symbols=%d edited=%d noise_skipped=%d",
        len(top_files),
        total_files_read,
        _MAX_FILES_READ,
        files_with_symbols_count,
        len(edited_clean),
        noise_skipped,
    )

    header_lines: list[str] = [
        "## Token-Goat Session Manifest",
    ]
    _hint_telemetry = _format_hint_telemetry(cache)
    if _hint_telemetry:
        header_lines.append(_hint_telemetry)

    # Get cwd early so it can be used by both diff summary and commits section.
    cwd = getattr(cache, "cwd", None)
    created_ts = getattr(cache, "created_ts", 0.0)

    # ── 0. Current Blockers — failed commands from the last 60 min ───────────
    # Built before everything else so it appears at the top of the manifest.
    # Young sessions are included here too — a failure is critical regardless of age.
    now_ts_for_blockers = time.time()
    blocker_entries = _select_failed_bash_entries(raw_bash, now_ts_for_blockers)
    blocker_lines = _render_section("**Blocked:**", blocker_entries, _format_blocker_entry)

    # ── 0a. Active Skills — load-bearing protocol content ───────────────────
    # Built early so it sits high in the inverted-pyramid order: a loaded skill
    # (Ralph, /improve, etc.) is multi-thousand-token prose that the compaction
    # LLM aggressively summarises, dropping load-bearing rules.  Listing every
    # loaded skill with a recall hint tells the compaction LLM "preserve these"
    # and gives the post-compact agent an exact command to re-fetch the body.
    #
    # Item #9 / A25 — always collapse to a single summary line.
    # Listing each skill on its own bullet with a per-skill recall hint wastes
    # 15–25 tokens per skill (6 skills × ~30t = 180t).  The agent already knows
    # the recall pattern from one example; the per-skill body is available via
    # the recovery hint that fires after compaction.  Use the summary format
    # unconditionally: one line, names + a single generic recall example.
    # ── 0a-bis. Decisions — opt-in agent decision log ───────────────────────
    # Built right next to skills because both carry load-bearing *intent* that
    # compaction otherwise drops.  The list is opt-in (the agent must call
    # ``token-goat decision "<text>"``) so the typical session has 0 entries
    # and the section is suppressed entirely.  When present, we surface the
    # most recent ``_MAX_DECISIONS`` items so the post-compact agent inherits
    # the *why* behind the work-in-progress, not just the *what*.
    raw_decisions = getattr(cache, "decisions", None)
    decision_entries = _select_top_decision_entries(raw_decisions)
    if decision_entries:
        decision_lines: list[str] = ["**Decisions:**"]
        for _de in decision_entries:
            decision_lines.append(_format_decision_entry(_de))
        # Overflow note when older decisions exist beyond the surfaced slice.
        if isinstance(raw_decisions, list) and len(raw_decisions) > len(decision_entries):
            overflow_n = len(raw_decisions) - len(decision_entries)
            decision_lines.append(
                f"- …+{overflow_n} more — recall via `token-goat decision --list`"
            )
    else:
        decision_lines = []

    skill_entries = _select_top_skill_entries(raw_skills)
    if skill_entries:
        # Build summary: "ralph ×3, improve ×1 — recall via token-goat skill-body <name>"
        _skill_parts = []
        for _se in skill_entries:
            _sname = sanitize_log_str(getattr(_se, "skill_name", ""), max_len=40)
            _src = int(getattr(_se, "run_count", 1))
            _skill_parts.append(f"{_sname} ×{_src}" if _src > 1 else _sname)
        overflow_skills = len(raw_skills) - len(skill_entries)
        if overflow_skills > 0:
            _skill_parts.append(f"+{overflow_skills} more")
        _skills_summary = ", ".join(_skill_parts)
        skill_lines = [
            f"**Skills:** {_skills_summary} — recall via `token-goat skill-body <name>`"
        ]
    else:
        skill_lines = []

    # ── 0b. Uncommitted Changes — git diff --stat + status --short ───────────
    # Ground-truth picture of what's on disk regardless of which tool made the
    # changes.  Shown before Files Edited so the compaction LLM sees both the
    # Claude-tool-tracked edits and any manual changes in one pass.
    # Budget: ~40 tokens / ~200 chars max for the content; not counted against
    # the adaptive per-section budget (it's additional fixed context).
    uncommitted_changes: str | None = _get_uncommitted_changes(cwd)
    uncommitted_lines: list[str] = []
    if uncommitted_changes:
        uncommitted_lines.append("**Uncommitted:**")
        for line in uncommitted_changes.splitlines():
            uncommitted_lines.append(f"  {line.rstrip()}")

    # ── 1. Edited files — highest priority (no cap) ───────────────────────────
    # Build the entire edited-files block first so we can measure its token cost
    # before allocating the remaining budget to variable sections.
    edited_lines: list[str] = []
    # Run the whole-repo git diff --stat once here so both the "Pending Changes"
    # section and the adaptive budget computation can use the cached result.
    pending_diff_stat: str = _get_git_diff_stat_summary(cwd)

    # Pre-compute a normalized-path → last_edit_ts lookup from files_clean once here.
    # Used both by the Edited section sort and (via sorted_edited) by the merged-files
    # section, so we pay the O(|files_clean|) build cost only once per manifest render.
    # Files only edited but never read have no FileEntry, so they map to 0.0.
    _edit_ts_by_norm: dict[str, float] = {
        _norm_key(key): getattr(entry, "last_edit_ts", 0.0)
        for key, entry in files_clean.items()
        if getattr(entry, "last_edit_ts", 0.0) > 0.0
    }

    if edited_clean:
        edited_lines.append("**Edited:**")
        # Sort by recency (most recently edited first) so truncation at
        # _MAX_EDITED_FILES_SHOWN drops the OLDEST edits rather than the newest.
        # When two files share the same last_edit_ts (e.g. both only edited, never read —
        # no FileEntry so last_edit_ts=0.0), edit count is the tiebreaker so the
        # most-touched file still wins within that cohort.
        sorted_edited = sorted(
            edited_clean.items(),
            key=lambda item: (_edit_ts_by_norm.get(_norm_key(item[0]), 0.0), item[1]),
            reverse=True,
        )
        shown_edited = sorted_edited[:_MAX_EDITED_FILES_SHOWN]
        overflow_edited = len(sorted_edited) - len(shown_edited)

        # ── #17: single-file inline diff ─────────────────────────────────────
        # When there is exactly one edited file AND the whole-repo diff is small
        # (<= _SINGLE_FILE_DIFF_CAP bytes), replace the file-list entry with the
        # inline diff so the compaction LLM has the exact change without a
        # round-trip.  Only attempted when cwd is available.
        _single_file_diff_used = False
        _inline_diffs_were_emitted = False  # Item #13: track for Pending Changes gate
        if len(edited_clean) == 1 and cwd:
            _only_path, _only_count = shown_edited[0]
            _whole_diff = _get_whole_repo_diff(cwd)
            if _whole_diff:
                edited_lines.append(f"#### {_short_path(_only_path, project_root=cwd)} (inline diff)")
                for _dl in _whole_diff.splitlines():
                    edited_lines.append(f"  {_dl}")
                _single_file_diff_used = True
                _inline_diffs_were_emitted = True

        if not _single_file_diff_used:
            # ── #7: per-file inline diffs for top 2 ──────────────────────────
            # For the top-2 most-edited files, attempt to inline git diff HEAD
            # output when the diff is small (< _INLINE_DIFF_MAX_BYTES).  Fall
            # back to the grouped directory format when diff is too large or git
            # is unavailable.  Total inlined bytes are capped at _INLINE_DIFF_TOTAL_CAP.
            _inline_budget = _INLINE_DIFF_TOTAL_CAP
            _inlined_paths: set[str] = set()
            if cwd and len(shown_edited) >= 1:
                for _ip, _ic in shown_edited[:2]:
                    if _inline_budget <= 0:
                        break
                    _idiff = _get_inline_diff_for_file(_ip, cwd)
                    if _idiff and len(_idiff) <= _inline_budget:
                        edited_lines.append(
                            f"#### {_short_path(_ip, project_root=cwd)}{_count_suffix(_ic)} (inline diff)"
                        )
                        for _dl in _idiff.splitlines():
                            edited_lines.append(f"  {_dl}")
                        _inlined_paths.add(_ip)
                        _inline_budget -= len(_idiff)
                        _inline_diffs_were_emitted = True

            # Remaining files (not inlined) use the grouped directory format.
            remaining_shown = [item for item in shown_edited if item[0] not in _inlined_paths]
            if remaining_shown:
                # Item #35: adaptive directory grouping — increase grouping threshold
                # when many files are edited to save tokens. If >= 15 edited files,
                # group more aggressively (threshold=2 instead of 3) to consolidate
                # the directory listing.
                _adaptive_threshold = edited_dir_group_threshold
                if len(remaining_shown) >= 15:
                    _adaptive_threshold = max(2, edited_dir_group_threshold - 1)
                grouped_lines = _group_edited_by_dir(
                    remaining_shown,
                    project_root=cwd,
                    threshold=_adaptive_threshold,
                )
                edited_lines.extend(grouped_lines)
        else:
            _inlined_paths = set()

        if overflow_edited > 0:
            edited_lines.append(f"- …+{overflow_edited} more edited")

        # ── 1a. Pending Changes (git diff --stat HEAD) ────────────────────────
        # Whole-repo stat placed immediately after Files Edited so the compaction
        # LLM sees the scope and magnitude of in-flight work alongside the list of
        # edited files.  Omitted entirely when there are no uncommitted changes.
        # Item #13: skip when nearly all edited files already have inline diffs —
        # the per-file diffs carry more information than the aggregate stat.
        # "Nearly all" = at most one file without an inline diff.
        _skip_pending = (
            _inline_diffs_were_emitted
            and len(_inlined_paths) >= len(edited_clean) - 1
        )
        if pending_diff_stat and not _skip_pending:
            edited_lines.append("**Pending:**")
            for line in pending_diff_stat.splitlines():
                edited_lines.append(f"  {line}")

        # ── 1b. Diff summary + Commits this session ───────────────────────────
        # Both helpers are fail-soft and skip immediately when cwd is not a git
        # repo (via _is_git_repo). Sequential calls avoid ~3–8 ms of
        # ThreadPoolExecutor creation overhead on every manifest build; the
        # process-level TTL caches mean both results are usually already warm
        # on the second call within the same session anyway.
        edited_paths = list(edited_clean.keys())
        diff_stat = _get_git_diff_stat(edited_paths, cwd)
        session_commits = _get_session_commits(cwd, created_ts) if created_ts > 0 else []

        # Item #27: surface non-zero stash count.  A forgotten stash is real
        # in-flight work the compaction LLM should know about; silent zero
        # stashes pay no token cost.
        stash_count = _get_stash_count(cwd) if cwd else 0
        if stash_count > 0:
            edited_lines.append(f"**Stashes:** {stash_count}  (run `git stash list` to inspect)")

        if diff_stat:
            edited_lines.append("### Diff Summary")
            for line in diff_stat.splitlines():
                edited_lines.append(f"- {line}")

        if session_commits:
            edited_lines.append("### Commits This Session")
            edited_lines.extend(session_commits)

    # ── 1d. Stale file snapshots ──────────────────────────────────────────────
    stale_lines = _render_section(
        "Outdated File Snapshots",
        stale_read_files[:6],
        lambda path: f"- ⚠ {_short_path(path, project_root=cwd)}",
    )

    # Measure the "fixed" cost (header + blockers + uncommitted + edited + stale)
    # to derive per-section budgets.  Blocker lines are small (≤3 lines) so they
    # rarely consume more than ~15 tokens, but we count them to keep the budget
    # accurate.  The uncommitted-changes section is additional fixed context and
    # is not counted against any per-section proportional budget.
    # Compute sealed block early (same inputs as the final call below) so its
    # token cost can be deducted from the section-budget pool.  The sealed block
    # is protected — the safety-trim pass can never remove it — so any tokens it
    # consumes are not available to the proportional sections.  Without this
    # deduction _section_budgets over-allocates by ~20-80 tokens and the assembled
    # manifest consistently exceeds max_tokens on sessions with active blockers /
    # edited files / skills.
    sealed_block = _build_sealed_block(edited_clean, blocker_entries, raw_skills)
    sealed_tokens = _token_count("\n".join(sealed_block)) if sealed_block else 0

    fixed_text = "\n".join(
        header_lines + blocker_lines + decision_lines + skill_lines
        + uncommitted_lines + edited_lines + stale_lines
    )
    fixed_tokens = _token_count(fixed_text) + sealed_tokens

    # Compute content-aware section budgets: identify which sections have entries
    # so empty sections (e.g., no web fetches) don't consume budget.
    # Count from raw/candidate sets to avoid redundant selection function calls.
    section_content_counts: dict[str, int] = {
        "symbols": len(files_with_symbols),  # files with accessed symbols
        "files": len(top_files),  # top files by read count
        "greps": len(raw_greps),  # grep searches (raw count; dedup is for rendering)
        "bash": len(raw_bash),  # bash commands in history
        "web": len(raw_web),  # web fetches
        "glob": len(getattr(cache, "glob_history", None) or []),  # glob scans
    }

    sec_budgets = _section_budgets(max_tokens, fixed_tokens, section_content_counts)
    _LOG.debug(
        "_render: fixed_tokens=%d  section_budgets=%s content_counts=%s (session=%s)",
        fixed_tokens, sec_budgets, section_content_counts, session_id[:8],
    )

    # ── 2. Symbols accessed — up to 40 % of remaining budget ─────────────────
    sym_budget = sec_budgets["symbols"]
    # Item #24 — Wide session: replace per-file symbol list with map pointer.
    # When the session has accessed >= wide_session_threshold unique files,
    # the per-file symbol listing consumes 200–300 tokens the compaction LLM
    # can't usefully retain.  Emit a single actionable pointer instead.
    _wide_session = len(cache.files) >= wide_session_threshold
    if _wide_session:
        _wide_line = (
            f"**Symbols Accessed:** {len(cache.files)} files accessed"
            " — use `token-goat map --compact` to re-orient."
        )
        _wide_cost = _token_count(_wide_line)
        sym_lines: list[str] = [_wide_line] if _wide_cost <= sym_budget else []
        sym_used: int = _wide_cost if sym_lines else 0
    else:
        # Item #8: suppress symbol-detail lines for files that already appear in
        # the **Files:** read list (top_files).  The read entry implies the file
        # is interesting; repeating its symbol breakdown is redundant
        # (~25 tokens per dual-listed file).  We use the `top_files` candidate
        # set rather than the budget-filtered `included_top_files` because the
        # files section is rendered later; in practice nearly every entry in
        # top_files survives budget filtering, so the suppression set is
        # essentially the same.
        _top_files_paths_norm = {
            _norm_key(getattr(e, "rel_or_abs", ""))
            for e in top_files
        }

        # Item #33: cross-file symbol deduplication. When the same symbol appears
        # in multiple files, keep only the reference from the most-recently-accessed
        # file. This saves manifest tokens by eliminating redundant listings.
        _global_symbol_refs = _dedup_symbols_across_files(files_with_symbols, now_for_scoring)

        # Item #34: stale symbol filtering when budget is tight (< 80 tokens remaining).
        # Drop symbols accessed more than 60 min ago to preserve budget for recent context.
        _budget_tight = sym_budget < 80
        _stale_threshold_secs = 3600 if _budget_tight else float("inf")

        sym_formatted: list[str] = []
        _suppressed_sym_files = 0
        for entry in files_with_symbols:
            _entry_path_norm = _norm_key(entry.rel_or_abs)
            if _entry_path_norm in _top_files_paths_norm:
                # Skip — the file already appears in **Files:** so the symbol
                # detail line would be a redundant ~25-token repeat.
                _suppressed_sym_files += 1
                continue
            ranked_symbols = _rank_symbols_by_recency(entry, now_for_scoring)
            # Item #11: dedup consecutive/repeated symbols before rendering (order-preserving).
            _seen_syms: set[str] = set()
            deduped_symbols = [s for s in ranked_symbols if not (_seen_syms.__contains__(s) or _seen_syms.add(s))]  # type: ignore[func-returns-value]

            # Item #33: filter out symbols that are duplicated in other files
            # (keep only if this file is the most-recent reference).
            filtered_symbols = [
                s for s in deduped_symbols
                if _global_symbol_refs.get(s, ("", 0.0))[0] == entry.rel_or_abs
            ]

            # Item #34: filter stale symbols when budget is tight
            if _budget_tight:
                symbols_ts = getattr(entry, "symbols_ts", None) or {}
                fresh_symbols = [
                    s for s in filtered_symbols
                    if (now_for_scoring - symbols_ts.get(s, 0.0)) < _stale_threshold_secs
                ]
                stale_removed = len(filtered_symbols) - len(fresh_symbols)
                filtered_symbols = fresh_symbols
            else:
                stale_removed = 0

            dupes_removed = len(ranked_symbols) - len(deduped_symbols)
            cross_file_dupes = len(deduped_symbols) - len(filtered_symbols) - stale_removed
            syms = [sanitize_log_str(s, max_len=80) for s in filtered_symbols[:_MAX_SYMBOLS_PER_FILE_ENTRY]]
            overflow = len(filtered_symbols) - _MAX_SYMBOLS_PER_FILE_ENTRY
            dupe_note = f" (+{dupes_removed} dupes)" if dupes_removed >= 3 else ""
            xfile_note = f" (-{cross_file_dupes} xfile)" if cross_file_dupes >= 1 else ""
            stale_note = f" (-{stale_removed} stale)" if stale_removed >= 1 else ""
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "") + dupe_note + xfile_note + stale_note
            sym_formatted.append(f"- {_short_path(entry.rel_or_abs, project_root=cwd)} → {sym_str}")
        if _suppressed_sym_files:
            _LOG.debug(
                "_render: suppressed %d symbol-detail line(s) for files in **Files:** "
                "(item #8)", _suppressed_sym_files,
            )
        sym_lines, sym_used = _render_budget_lines("**Symbols Accessed:**", sym_formatted, sym_budget)

    # ── 3. Bash history — up to 15 % of remaining budget ─────────────────────
    # Young sessions (< 10 min) skip bash/web sections: few commands have run
    # and the overhead of listing them is not worth it relative to the budget.
    bash_budget = sec_budgets["bash"]
    _all_bash_entries = (
        _select_top_bash_entries(getattr(cache, "bash_history", None))
        if age_tier != "young"
        else []
    )
    # Exclude entries already listed in "Current Blockers" — showing a failed
    # command as both a brief blocker note and a full entry with output snippet
    # wastes manifest tokens on the same information twice.
    # Also exclude entries whose output_id was already surfaced to the agent via
    # a bash dedup hint earlier in the session — the agent has already seen a
    # recall pointer; repeating the full snippet in the manifest is redundant.
    # Blocker entries are exempt from the dedup-hint exclusion so a failing
    # command always appears in the manifest regardless of prior hint exposure.
    _blocker_ids = {getattr(e, "output_id", None) for e in blocker_entries}
    _dedup_emitted_ids: set[str] = getattr(cache, "bash_dedup_emitted_ids", set()) or set()
    bash_entries = [
        e for e in _all_bash_entries
        if getattr(e, "output_id", None) not in _blocker_ids
        and getattr(e, "output_id", None) not in _dedup_emitted_ids
    ]
    # Inline snippet only when the entry is large enough that the preview pays
    # for itself (>= 600 bytes).  Small outputs are trivially recalled via
    # `token-goat bash-output <id>`; emitting the snippet wastes manifest tokens.
    # Blockers always get inline_snippet=True — their output is the most
    # load-bearing content in the manifest and must be visible without a
    # recall round-trip.
    _blocker_ids_for_snippet = {getattr(e, "output_id", None) for e in blocker_entries}
    def _should_inline(be: object) -> bool:
        oid = getattr(be, "output_id", None)
        if oid and oid in _blocker_ids_for_snippet:
            return True
        total = int(getattr(be, "stdout_bytes", 0)) + int(getattr(be, "stderr_bytes", 0))
        return total >= 600

    # Item #28: group bash entries by exit-code class within the **Ran:** section.
    # Order: **Failed:** (exit != 0) first, then **Slow:** (exit == 0, elapsed > 5s),
    # then **Ok:** (the rest).  Within each group the existing recency/size ordering
    # from `_select_top_bash_entries` is preserved.  Empty groups omit their header.
    # When all entries are in a single group AND that group is **Ok:**, we skip the
    # sub-header entirely (the **Ran:** label is sufficient).
    bash_lines, bash_used = _render_bash_grouped(
        bash_entries, bash_budget, _should_inline,
    )

    # ── 3a. What Worked — last 2 green test runs ──────────────────────────────
    # A dedicated curated section so the compaction LLM (and post-compact agent)
    # knows "tests passed as of N minutes ago" without re-running them.
    # Uses the same _blocker_ids set as the Commands Run exclusion above so we
    # never surface the passing version of a command that is currently blocking.
    # Also excludes _dedup_emitted_ids so an entry the agent already received a
    # recall pointer for is not re-surfaced via this different section path.
    _what_worked_exclude = _blocker_ids | _dedup_emitted_ids
    _what_worked_entries = _select_what_worked(raw_bash, _what_worked_exclude)
    now_ts_for_worked = time.time()
    what_worked_lines = _render_what_worked_section(_what_worked_entries, now_ts_for_worked)

    # Cold outputs are grouped with bash history (same budget slice).
    # Skip for young and active sessions — only emit for mature sessions (>60 min).
    # Rationale: Cold Outputs advises the compaction LLM to evict old bash output
    # from context.  For active sessions the outputs are still likely relevant and
    # emitting the section wastes budget; for mature sessions the 30-min-old outputs
    # are almost certainly stale and the eviction hint pays back its token cost.
    now_ts = time.time()
    bash_hist_raw = getattr(cache, "bash_history", None) or {} if age_tier == "mature" else {}
    cold_candidates = sorted(
        [
            be for be in bash_hist_raw.values()
            if (now_ts - getattr(be, "ts", now_ts)) > _COLD_OUTPUT_AGE_SECS
            and (getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0))
            >= _MIN_BASH_BYTES_FOR_MANIFEST
            and getattr(be, "exit_code", 0) == 0  # Exclude failed commands (unresolved issues)
        ],
        key=lambda be: getattr(be, "ts", 0.0),
        reverse=True,
    )
    cold_outputs: list[object] = []
    if cold_candidates:
        # Item #11: shortened from "### Cold Outputs (evict — recall via …)" to a
        # bold-label one-liner.  Saves ~2 tokens per session that has cold outputs.
        cold_header = "**Cold:** evict, recall via `token-goat bash-output <id>`"
        cold_header_cost = _token_count(cold_header)
        if bash_used + cold_header_cost <= bash_budget:
            # Collect content lines first; emit header only when ≥2 entries fit
            # (min_lines=2: a single cold-output row isn't worth the header cost).
            cold_content_lines: list[str] = []
            cold_content_used = 0
            for be in cold_candidates[:_MAX_COLD_OUTPUTS]:
                age_min = int((now_ts - getattr(be, "ts", now_ts)) / 60)
                total = getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
                oid = _short_id(sanitize_log_str(getattr(be, "output_id", "?"), max_len=64))
                prev = sanitize_log_str(getattr(be, "cmd_preview", "?"), max_len=60)
                line = f"- ❄ `{prev}` ({_humanize_bytes(total)}, {age_min}min old, {oid})"
                cost = _token_count(line)
                if bash_used + cold_header_cost + cold_content_used + cost > bash_budget:
                    break
                cold_content_lines.append(line)
                cold_content_used += cost
                cold_outputs.append(be)
            if len(cold_outputs) >= 2:
                bash_lines.append(cold_header)
                bash_used += cold_header_cost
                bash_lines.extend(cold_content_lines)
                bash_used += cold_content_used
                dropped_cold = len(cold_candidates) - len(cold_outputs)
                if dropped_cold > 0 and bash_used < bash_budget:
                    overflow_line = f"- …+{dropped_cold} more cold outputs"
                    if bash_used + _token_count(overflow_line) <= bash_budget:
                        bash_lines.append(overflow_line)

    # ── 3b. Web fetches — up to 10 % of remaining budget ─────────────────────
    # Young sessions skip web sections — same rationale as bash_entries above.
    web_budget = sec_budgets["web"]
    web_entries = (
        _select_top_web_entries(raw_web)
        if age_tier != "young"
        else []
    )
    # min_lines=1: a single fetched URL is genuine signal (the agent did one
    # WebFetch and that URL is worth surfacing); min_lines=2 here hid useful
    # entries.  Cold Outputs and Directory Scans keep min_lines=2 because a
    # single stale/empty-ish entry is genuinely noisy there.
    web_lines, web_used = _render_budget_lines(
        "**Web Fetches:**",
        _group_web_entries_by_domain(web_entries) if web_entries else [],
        web_budget,
    )

    # ── 4. Grep patterns — up to 15 % of remaining budget ────────────────────
    grep_budget = sec_budgets["greps"]
    # Tally raw occurrence counts BEFORE _select_top_grep_entries deduplicates by
    # pattern; otherwise _dedup_grep_entries always sees count=1 and [×N] never fires.
    _raw_grep_counts: dict[str, int] = {}
    for _rg in raw_greps:
        _rp = getattr(_rg, "pattern", "")
        if _rp:
            _raw_grep_counts[_rp] = _raw_grep_counts.get(_rp, 0) + 1
    grep_entries = _dedup_grep_entries(
        _select_top_grep_entries(raw_greps),
        raw_counts=_raw_grep_counts,
    )
    # #35: when the all-zero fallback is active (every remaining entry has 0 hits)
    # AND the session is older than 5 minutes, the section carries no useful signal —
    # drop it entirely.  Young sessions keep the section so the agent sees it tried.
    _all_grep_zero = bool(grep_entries) and all(
        (getattr(g, "result_count", None) or 0) == 0 for g in grep_entries
    )
    if _all_grep_zero and age_secs > 300:
        grep_entries = []
    grep_lines, grep_used = _render_budget_lines(
        "**Patterns Searched:**",
        [_format_grep_entry(ge) for ge in grep_entries],
        grep_budget,
    )
    if grep_lines:
        included_greps = len(grep_lines) - 1  # index 0 is the header
        # Count only selector-surviving entries — stale/zero-result patterns
        # were intentionally discarded by _select_top_grep_entries and must
        # not inflate the "+N more" count shown to the compaction LLM.
        dropped_greps = len(grep_entries) - included_greps
        if dropped_greps > 0:
            overflow_line = f"- …+{dropped_greps} more patterns"
            if grep_used + _token_count(overflow_line) <= grep_budget:
                grep_lines.append(overflow_line)

    # ── 4b. Glob scans — up to 5 % of remaining budget ───────────────────────
    glob_budget = sec_budgets["glob"]
    glob_lines: list[str] = []
    glob_used = 0
    glob_entries = (
        _select_top_glob_entries(getattr(cache, "glob_history", None))
        if age_tier != "young"
        else []
    )
    glob_lines = _render_section(
        "Directory Scans",
        glob_entries,
        lambda e: _format_glob_entry(e, cwd=cwd),
    )
    if glob_lines:
        # min_lines=2: a single-entry Directory Scans section is rarely worth the
        # header overhead — suppress it the same way _render_budget_lines does.
        content_lines = len(glob_lines) - 1  # index 0 is the header
        if content_lines < 2:
            glob_lines = []
            glob_used = 0
        else:
            glob_used = _token_count("\n".join(glob_lines))
            if glob_used > glob_budget:
                glob_lines = []
                glob_used = 0

    # ── 5. Key files read — up to 30 % of remaining budget ───────────────────
    files_budget = sec_budgets["files"]
    files_lines: list[str] = []
    files_used = 0
    from .session import FileEntry as _FileEntry  # noqa: PLC0415
    included_top_files: list[_FileEntry] = []

    if top_files:
        header = "**Files:**"
        header_cost = _token_count(header)
        files_entries_for_section: list[str] = []

        # Hot files (≥ threshold reads) get a single consolidated summary line.
        hot_files = [e for e in top_files if e.read_count >= _HOT_FILE_READ_THRESHOLD]
        normal_files = [e for e in top_files if e.read_count < _HOT_FILE_READ_THRESHOLD]

        if hot_files:
            shown = hot_files[:_HOT_FILE_MAX_SHOWN]
            overflow = len(hot_files) - _HOT_FILE_MAX_SHOWN

            def _basename(p: str) -> str:
                p = p.replace("\\", "/")
                return p.rsplit("/", 1)[-1] if "/" in p else p

            name_parts = [
                f"{_basename(e.rel_or_abs)}{_count_suffix(e.read_count)}"
                for e in shown
            ]
            hot_line_text = "Hot (5+×): " + ", ".join(name_parts)
            if overflow > 0:
                hot_line_text += f" +{overflow} more"
            hot_line = f"- → {hot_line_text}"
            cost = _token_count(hot_line)
            if files_used + header_cost + cost <= files_budget:
                files_entries_for_section.append(hot_line)
                files_used += cost
                included_top_files.extend(shown)

        for entry in normal_files:
            ranges_str = _format_ranges(entry.line_ranges)
            # Files read 3+ times get an explicit "(read Nx)" annotation so post-compaction
            # Claude can immediately identify which files received the most attention.
            # Files read once or twice get no annotation — the path alone is sufficient.
            read_annotation = f" (read {entry.read_count}x)" if entry.read_count >= 3 else ""
            line = f"- → {_short_path(entry.rel_or_abs, max_len=80, project_root=cwd)}{read_annotation}{ranges_str}"
            cost = _token_count(line)
            if files_used + header_cost + cost > files_budget:
                break
            files_entries_for_section.append(line)
            files_used += cost
            included_top_files.append(entry)

        # Only emit header if we have entries to show
        if files_entries_for_section:
            files_lines.append(header)
            files_lines.extend(files_entries_for_section)
            files_used += header_cost

    # ── 6b. TODOs — pending/in-progress TaskList entries (no budget slice) ──────
    # TaskList state is persisted by the harness at ~/.claude/tasks/<session_id>/.
    # Loading it is a fast local disk read; the section is small (≤5 lines) so it
    # does not need a dedicated budget slice — it comes out of the overall headroom
    # after the budgeted sections are assembled.
    raw_tasks = _load_task_list(session_id)
    # Item #29: pass the set of edited paths so the section suppresses TODOs
    # whose subject already references a pinned edited file.
    todo_lines = _render_tasks_section(
        raw_tasks,
        edited_paths=set(edited_clean) if edited_clean else None,
    )

    # ── Item #16 — Merge Files Edited + Key Files Read when overlap >= 50% ──────
    # When many of the same paths appear in both the Edited and Files sections,
    # collapsing them into one "**Files:**" section saves one section header plus
    # one listing per overlapping path (~13 tokens/path).  The merged section uses
    # a combined "✎×N →×M" annotation so the compaction LLM still distinguishes
    # edited paths from read-only ones.
    #
    # Overlap ratio = |edited ∩ all_reads| / max(|edited|, 1).
    # We compare against files_clean (the full read map including edited files —
    # edited files are explicitly excluded from key_files_candidates so they never
    # appear in included_top_files, but they were still read by the session).
    # Only merge when ratio >= 0.5 AND both the Edited section and Files section
    # have content (so we are not collapsing a section that doesn't exist yet).
    _all_read_paths_norm = {
        _norm_key(key)
        for key in files_clean
    }
    _edited_paths_norm = {_norm_key(p): p for p in edited_clean}
    _overlap_set = set(_edited_paths_norm.keys()) & _all_read_paths_norm
    _overlap_ratio = len(_overlap_set) / max(len(edited_clean), 1)
    _do_merge = (
        _overlap_ratio >= 0.5
        and bool(edited_clean)
        and bool(included_top_files)
        and not _inline_diffs_were_emitted  # keep inline diffs — higher value than merge savings
    )
    if _do_merge:
        # Build a merged **Files:** section.
        # Collect all unique paths: edited paths first (preserving recency-then-count order),
        # then read-only top-files not in edited.
        merged_entries: list[str] = []
        _read_count_map = {
            _norm_key(entry.rel_or_abs): entry
            for entry in included_top_files
        }
        # Also check files_clean for read counts of edited paths.
        _files_clean_norm = {
            _norm_key(key): entry
            for key, entry in files_clean.items()
        }
        # Reuse sorted_edited (pre-computed above) — same recency-then-count ordering
        # as the Edited section, so the merged section is consistent with it.
        for _ep, _ec in sorted_edited:
            _ep_norm = _norm_key(_ep)
            # Prefer read-count from included_top_files; fall back to files_clean.
            _re = _read_count_map.get(_ep_norm) or _files_clean_norm.get(_ep_norm)
            _rc = _re.read_count if _re else 0
            _annotation = f"✎×{_ec}" if _ec > 1 else "✎"
            if _rc > 0:
                _annotation += f" →×{_rc}"
            merged_entries.append(f"- {_short_path(_ep, project_root=cwd)} {_annotation}")
        # Add read-only top-files not in edited_clean.
        _edited_norm_set = set(_edited_paths_norm.keys())
        for _re in included_top_files:
            _rp_norm = _norm_key(_re.rel_or_abs)
            if _rp_norm not in _edited_norm_set:
                _rc = _re.read_count
                _annotation = f"→×{_rc}" if _rc > 1 else "→"
                merged_entries.append(
                    f"- {_short_path(_re.rel_or_abs, project_root=cwd)} {_annotation}"
                )
        # Replace both edited_lines and files_lines with the merged section.
        # Drop the existing edited content (header + file list) and files_lines.
        # Keep only the non-file sub-sections from edited_lines: diff, commits, pending.
        # The merged block goes where edited_lines was; files_lines is suppressed.
        _merged_section_lines = ["**Files:**"] + merged_entries
        # Preserve diff/commit/pending sub-sections that were appended after the file list.
        # These start with "**Pending:**", "### Diff Summary", "### Commits This Session".
        _edited_subsections: list[str] = []
        _in_subsection = False
        for _el in edited_lines:
            if _el.startswith(("**Pending:**", "### Diff Summary", "### Commits This Session")):
                _in_subsection = True
            if _in_subsection:
                _edited_subsections.append(_el)
        edited_lines = _merged_section_lines + _edited_subsections
        files_lines = []  # suppressed — merged into edited_lines

    # ── Legend — only list markers that actually appear above ─────────────────
    has_edit = bool(edited_clean)
    has_read = bool(included_top_files or sym_lines)
    has_stale = bool(stale_read_files)
    has_cold = bool(cold_outputs)
    has_skill = bool(skill_lines)
    legend_parts = []
    if has_edit:
        legend_parts.append("edited=✎")
    if has_read:
        legend_parts.append("read=→")
    if has_stale:
        legend_parts.append("stale=⚠")
    if has_cold:
        legend_parts.append("cold=❄")
    if has_skill:
        legend_parts.append("skill=🧠")

    # ── Sealed above-the-fold block — survives aggressive compaction ─────────
    # Built last so it has access to all three inputs (edited_clean, blocker_entries,
    # raw_skills).  Prepended before the header so it appears at the very top of the
    # manifest — compaction LLMs attend most to the top of long documents, and the
    # explicit <<MUST_PRESERVE>> markers are unlikely to be summarised away.
    # (sealed_block is computed earlier near the fixed_tokens calculation — reuse it.)

    # Assemble the final manifest in inverted-pyramid order: most critical first
    # so that if the manifest is truncated mid-token the surviving content is
    # the highest-value information for the compaction LLM.
    #   [sealed] Above-the-fold MUST_PRESERVE block — edited files, blocker, skills
    #   0. Current Blockers  — active failures the agent must know about
    #   1. Files Edited       — ongoing work (must survive compaction)
    #   2. Bash history       — current work context (what was just run)
    #   2a.What Worked        — last 2 green test runs (curated "good state" pointer)
    #   3. Symbols accessed   — precise code read
    #   4. Web fetches        — reference material
    #   4b. Glob scans        — directory scan history
    #   5. Grep patterns      — investigation history (least critical)
    #   6. Key files read     — broader context
    #   6b. TODOs             — pending/in-progress TaskList entries
    # ── Section assembly with truncation priority ───────────────────────────
    # Each tuple is (name, lines, protected).  ``protected`` sections are NEVER
    # dropped wholesale during the safety-trim pass — they carry the highest
    # post-compact recovery signal (sealed block, header, blockers, decisions,
    # active skills, uncommitted/edited state).  Unprotected sections are
    # dropped in reverse list order (lowest-signal first) when the manifest
    # exceeds ``max_tokens``.  This replaces the previous naive bottom-up
    # line-popping which could leave orphan section headers (e.g. ``**Files:**``
    # with no entries) and silently strip the legend line before any content.
    #
    # Drop order (lowest signal → highest):
    #   1. todos     — TaskList entries (usually fresh from disk; cheap to recover)
    #   2. files     — Key Files Read (read-only context, already implied by syms)
    #   3. grep      — Investigation history (least load-bearing)
    #   4. glob      — Directory scan history
    #   5. web       — Reference material URLs
    #   6. syms      — Symbol detail per file
    #   7. what_worked — Curated "tests were green" pointer
    #   8. bash      — Command history (current work context — only drop under extreme pressure)
    #   9. stale     — Outdated snapshot warnings (small, useful — kept above bash)
    # Protected (never wholesale-dropped):
    #   sealed, header, blockers, decisions, skills, uncommitted, edited, legend.
    _section_groups: list[tuple[str, list[str], bool]] = [
        ("sealed",      sealed_block,        True),
        ("header",      header_lines,        True),
        ("blockers",    blocker_lines,       True),
        ("decisions",   decision_lines,      True),
        ("skills",      skill_lines,         True),
        ("uncommitted", uncommitted_lines,   True),
        ("edited",      edited_lines,        True),
        ("stale",       stale_lines,         False),
        ("bash",        bash_lines,          False),
        ("what_worked", what_worked_lines,   False),
        ("syms",        sym_lines,           False),
        ("web",         web_lines,           False),
        ("glob",        glob_lines,          False),
        ("grep",        grep_lines,          False),
        ("files",       files_lines,         False),
        ("todos",       todo_lines,          False),
    ]
    # ── Apply noise floor: drop small unprotected sections ───────────────────
    _section_groups = _apply_noise_floor(_section_groups, noise_floor_tokens)
    max_section_lines_cap = max_section_lines

    # ── Apply per-section line cap to prevent bloated sections dominating budget ─
    # The cap is applied AFTER directory-grouping so grouped lines count as 1 item.
    # Only apply to the four list-shaped sections; skip single-line sections and
    # protected sections (header, blockers, decisions, skills, uncommitted).
    if max_section_lines_cap > 0:
        for idx, (_name, _lines, _protected) in enumerate(_section_groups):
            if not _protected and _name in ("edited", "files", "syms"):
                _section_groups[idx] = (_name, _apply_section_line_cap(_lines, max_section_lines_cap), _protected)

    sections: list[str] = []
    for _name, _lines, _ in _section_groups:
        sections.extend(_lines)
    # #22: When only one marker kind appears the verbose "Legend: key=symbol"
    # prefix is self-evident — drop the "Legend: " label to save ~3-5 tokens.
    # With two or more kinds the full legend is a useful key, so keep the prefix.
    legend_line: str | None = None
    if len(legend_parts) == 1:
        legend_line = legend_parts[0]
    elif len(legend_parts) >= 2:
        legend_line = "Legend: " + "  ".join(legend_parts)
    if legend_line is not None:
        sections.append(legend_line)

    # ── Common prefix stripping — save tokens by detecting shared path prefixes ─
    path_lines = [line for line in sections if _extract_path_from_line(line) is not None]
    paths_only = [p for line in path_lines if (p := _extract_path_from_line(line)) is not None]
    _applied_prefix: str | None = None
    if (
        len(path_lines) >= 3  # Worthwhile only with 3+ paths
        and len(paths_only) > 0
        and (common_prefix := _find_common_prefix(paths_only))
        and len(common_prefix) >= 6  # Prefix must be at least 6 chars to justify header
        and len(paths_only) >= int(len(path_lines) * 0.7)  # Must cover 70% of path lines
    ):
        sections = _strip_common_prefix_from_sections(sections, common_prefix)
        _applied_prefix = common_prefix

    # Item #21: StringIO write-buffer assembly — avoids the N-object intermediate
    # list copy that "\n".join() creates for the full manifest string.
    _buf = io.StringIO()
    for _sec_line in sections:
        _buf.write(_sec_line)
        _buf.write("\n")
    result = _buf.getvalue().rstrip()
    token_count = estimate_tokens(result)
    _LOG.debug(
        "_render: manifest assembled for session=%s; ~%d tokens (budget=%d) "
        "sym=%d bash=%d web=%d glob=%d grep=%d files=%d",
        session_id[:8], token_count, max_tokens,
        sym_used, bash_used, web_used, glob_used, grep_used, files_used,
    )

    # ── Safety net: priority-aware section truncation ────────────────────────
    # Per-section budgets use _token_count (len//4, conservative) while
    # estimate_tokens uses len/3.5 (slightly more generous).  In rare cases
    # the assembled total can still exceed max_tokens by a few tokens.
    #
    # Strategy: drop unprotected sections wholesale in reverse priority order
    # (todos → files → grep → glob → web → syms → what_worked → bash → stale)
    # before any line-by-line trimming.  Wholesale section drops never leave
    # an orphan ``**Files:**`` header with no entries — a known defect of the
    # previous bottom-popping approach.  Protected sections (sealed, header,
    # blockers, decisions, skills, uncommitted, edited) and the legend are
    # never wholesale-dropped — they carry the highest post-compact recovery
    # signal.  As a final fallback when wholesale drops are exhausted, the
    # tail is line-trimmed but the legend (last line) is pinned in place so
    # marker explanations always survive.
    if token_count > max_tokens:
        _LOG.info(
            "_render: safety trim for session=%s (%d tokens > %d budget)",
            session_id[:8], token_count, max_tokens,
        )

        def _assemble(live_groups: list[tuple[str, list[str], bool]]) -> str:
            """Rebuild the manifest string from *live_groups*, applying the same
            common-prefix stripping that was applied to the original assembly."""
            body: list[str] = []
            for _name, _lines, _ in live_groups:
                body.extend(_lines)
            if legend_line is not None:
                body.append(legend_line)
            if _applied_prefix:
                body = _strip_common_prefix_from_sections(body, _applied_prefix)
            return "\n".join(body).rstrip()

        _droppable_names_in_drop_order = [
            "todos", "files", "grep", "glob", "web",
            "syms", "what_worked", "bash", "stale",
        ]
        _live_groups = list(_section_groups)
        _solved = False
        for _drop_name in _droppable_names_in_drop_order:
            _live_groups = [
                (n, lns, p) for (n, lns, p) in _live_groups if n != _drop_name
            ]
            _candidate_text = _assemble(_live_groups)
            if estimate_tokens(_candidate_text) <= max_tokens:
                result = _candidate_text
                _solved = True
                _LOG.info(
                    "_render: safety trim dropped section=%s (session=%s)",
                    _drop_name, session_id[:8],
                )
                break
            _LOG.debug(
                "_render: safety trim dropped section=%s, still over budget",
                _drop_name,
            )
        if not _solved:
            # All droppable sections gone and still over budget.  Fall back
            # to bottom line-popping on what remains, but pin the legend so
            # marker explanations survive (they explain markers still in
            # the body — losing the legend leaves orphan symbols).
            # Pop floor: never trim below sealed + header lines so the
            # non-negotiable framing and MUST_PRESERVE markers always survive.
            # (The edited section is protected from wholesale-drop above; if
            # the budget is so tight that even protected sections can't fit,
            # line-popping of lower-priority protected content is unavoidable.)
            _pop_floor_names = {"sealed", "header"}
            _pop_floor = sum(
                len(_lines)
                for _name, _lines, _ in _live_groups
                if _name in _pop_floor_names
            )
            _pop_floor = max(3, _pop_floor)
            _body_lines: list[str] = []
            for _name, _lines, _ in _live_groups:
                _body_lines.extend(_lines)
            _legend_suffix = [legend_line] if legend_line is not None else []
            _trimmed = _body_lines[:]
            while len(_trimmed) > _pop_floor and estimate_tokens(
                "\n".join(
                    _strip_common_prefix_from_sections(
                        _trimmed + _legend_suffix, _applied_prefix,
                    ) if _applied_prefix else _trimmed + _legend_suffix
                )
            ) > max_tokens:
                _trimmed.pop()
            _final = _trimmed + _legend_suffix
            if _applied_prefix:
                _final = _strip_common_prefix_from_sections(_final, _applied_prefix)
            result = "\n".join(_final).rstrip()

    final_tokens = estimate_tokens(result)
    _LOG.debug(
        "_render: final manifest for session=%s; %d tokens (budget=%d, trimmed=%s)",
        session_id[:8], final_tokens, max_tokens, str(token_count > max_tokens),
    )
    return result, files_with_symbols_count
