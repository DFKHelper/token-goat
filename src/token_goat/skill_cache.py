"""Persistent store for loaded-skill bodies.

Every PostToolUse(Skill) hook invocation records the loaded skill's body to a
short text file under ``data_dir() / "skills"`` keyed by ``session_short``,
``skill_name``, and a short content hash.  After compaction, the agent can
recall the full body via the ``token-goat skill-body`` CLI without re-invoking
the skill (which would also re-trigger any side effects the skill performs on
first load).

Why a separate disk store (vs. session JSON):

* Skill bodies can be tens of KB (Ralph is ~30 KB, /improve ~10 KB).  Inlining
  that into the session JSON would bloat every subsequent load/save round trip
  on the hot pre-read path.  Storing the bytes once on disk and only a short
  ID in the session keeps the session JSON cheap.

* The CLI retrieval path (``token-goat skill-body``) can stream the file
  directly without re-parsing JSON.

* Retention is simple to bound by total bytes: scan the directory, evict the
  oldest files until the cap is met.  No cross-session coordination is needed.

The store is intentionally fail-soft: any I/O error on write is logged and
swallowed so a hook never aborts because the cache is full or read-only.
"""
from __future__ import annotations

__all__ = [
    "COMPACT_END_MARKER",
    "DEFAULT_MAX_TOTAL_BYTES",
    "OUTPUT_FILENAME_RE",
    "SkillMeta",
    "content_hash",
    "evict_old_entries",
    "extract_checklist_section",
    "extract_compact_from_marker",
    "extract_h2_headings",
    "extract_named_section",
    "generate_compact_summary",
    "get_all_cached_skills",
    "get_compact",
    "get_skill_file_path",
    "list_by_session",
    "list_outputs",
    "load_output",
    "load_output_meta",
    "lookup_all_by_name",
    "lookup_by_name",
    "output_id_for",
    "read_sidecar",
    "store_compact",
    "store_output",
    "write_sidecar",
]

import contextlib
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    evict_cache_dir,
    get_cache_dir,
    list_cache_outputs,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    safe_cache_op,
    safe_join_output_id,
    safe_session_fragment,
    short_content_hash,
    sidecar_path_for,
    store_blob,
    truncate_tail_preserve,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str
from .util import get_logger

_LOG = get_logger("skill_cache")

# One-shot orphan sweep flag: set to True after the sweep runs in this process.
_sweep_done = False

# Total byte budget for the on-disk skill body store.  When exceeded, the
# oldest entries (by mtime) are evicted until the cap is met.  5 MB is small
# enough to be invisible on any modern disk while big enough to hold dozens of
# skill bodies (most are 5–30 KB; the largest known skill is ~50 KB).
DEFAULT_MAX_TOTAL_BYTES: int = 5 * 1024 * 1024

# Sentinel placed at the head of every output file marking the truncation
# boundary, so a reader can immediately see when the stored bytes are partial.
_TRUNC_MARKER = "[token-goat: skill body truncated; stored {n} of {total} bytes]\n"

# Maximum bytes stored per skill body file.  Skill bodies above this size are
# tail-truncated (head dropped).  Tail-preserve matches the cache_common helper
# behaviour shared with bash/web caches, and skill bodies' most useful parts
# (rules, checklists, examples) tend to live in the latter half of the file —
# the opening is usually metadata + setup that is also captured in a section
# heading reachable via ``token-goat section``.
_MAX_STORED_BYTES: int = 256 * 1024

# Skill-name validation regex.  Restrict to characters that are filesystem-safe
# on all platforms (Windows + POSIX) and that we expect Claude Code skills to
# use: alphanumerics, hyphens, underscores, and a single colon for the
# ``plugin:skill`` form.  Anything else is rejected to keep the cache filename
# safe from injection attacks.
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9_:\-]{1,128}$")

# Explicit compact-section delimiter.  Skill authors place this HTML comment on
# its own line to divide the file into two logical parts:
#
#   * Everything **above** the marker is the compact form — the essential
#     rules, directives, and quick-reference content the agent needs after a
#     compaction event.  Typically 200–600 tokens.
#   * Everything **below** is detailed reference — extended examples,
#     implementation notes, edge cases — useful when the agent wants to drill
#     deeper via ``token-goat skill-section <name> <heading>``.
#
# When the marker is absent ``extract_compact_from_marker`` returns ``None``
# and the caller falls back to ``generate_compact_summary`` auto-extraction.
COMPACT_END_MARKER: str = "<!-- COMPACT_END -->"


@dataclass
class SkillMeta:
    """Metadata associated with a cached skill body entry.

    Persisted in the session cache (small) alongside an ID that points at the
    on-disk file (potentially large).  Carries everything a manifest renderer
    or CLI recall path needs without re-reading the body from disk.
    """

    output_id: str
    skill_name: str
    content_sha: str
    body_bytes: int
    ts: float
    truncated: bool
    source_path: str = ""  # best-effort filesystem path where the skill body was found


def _skill_outputs_dir() -> Path:
    """Return ``data_dir() / "skills"`` and create it on first use."""
    return get_cache_dir("skills")


def content_hash(content: str) -> str:
    """Return a short content hash (first 16 hex chars of SHA-256).

    Thin wrapper around :func:`cache_common.short_content_hash` kept for
    backwards compatibility.  Callers outside this module (e.g. hooks_skill)
    may pass the result to :func:`output_id_for` directly.
    """
    return short_content_hash(content)


def _safe_skill_name(skill_name: str) -> str | None:
    """Return *skill_name* if it passes validation, else ``None``.

    Rejects names that would not be safe to embed in a filesystem path (slashes,
    backslashes, dots, control characters) or that exceed our length cap.  The
    ``plugin:skill`` form is allowed because Claude Code uses ``:`` as the
    namespace separator and we want plugin-namespaced skills addressable.
    """
    if not skill_name:
        return None
    if not _SKILL_NAME_RE.match(skill_name):
        return None
    return skill_name


def output_id_for(session_id: str, skill_name: str, content_sha: str) -> str:
    """Build a filesystem-safe ID for the (session, skill_name, content) tuple.

    Embeds a short session prefix, a sanitised skill name, and the content
    hash.  Two loads of the same skill body in the same session produce the
    same ID — i.e. the cache is idempotent per (session, name, content).  If
    the body changes (skill was updated between loads), a new ID is generated
    and both versions remain addressable.

    Session ID is short-prefixed (16 chars) so total filename length stays
    well under PATH_MAX; ``:`` in plugin-namespaced skill names is replaced
    with ``_`` so the result is filesystem-safe everywhere.
    """
    safe_session = safe_session_fragment(session_id)
    safe_name = skill_name.replace(":", "_")
    return f"{safe_session}-{safe_name}-{content_sha}"


def extract_compact_from_marker(body: str) -> str | None:
    """Return the pre-marker compact slice when ``COMPACT_END_MARKER`` is present.

    Scans *body* for the first line that equals :data:`COMPACT_END_MARKER`
    (stripped, case-sensitive) that is **not** inside a fenced code block.
    When found, returns everything above the marker, stripped of leading/trailing
    whitespace.  Returns ``None`` when the marker is absent so callers can fall
    back to :func:`generate_compact_summary` auto-extraction.

    Code-block awareness: the marker is ignored when it appears between a
    pair of triple-backtick (````) or triple-tilde (~~~) fences.  This prevents
    a skill body that *documents* the marker (e.g. a how-to example) from being
    mis-split at the wrong location.

    The returned text is **not** capped — the caller decides whether to
    truncate.  Skill authors are responsible for keeping the compact section
    at a reasonable size (target: ≤600 tokens ≈ 2400 chars).
    """
    if not body or COMPACT_END_MARKER not in body:
        return None
    in_code_block = False
    lines = body.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        # Track fenced code block state.  A fence opens or closes when the
        # stripped line starts with ``` or ~~~.  We toggle on each fence line
        # rather than matching pairs so a mismatched fence file still terminates
        # correctly at end-of-file.
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if stripped == COMPACT_END_MARKER:
            pre_marker = "\n".join(lines[:i]).strip()
            return pre_marker if pre_marker else None
    return None


# Headings searched in priority order when looking for actionable checklist prose.
# The first match wins.
_CHECKLIST_HEADINGS = (
    "## DoD",
    "## Checklist",
    "## Steps",
    "## Definition of Done",
    "## Process",
    "## Quick Start",
)

# Maximum characters returned from a matched checklist section (per skill).
_CHECKLIST_MAX_CHARS: int = 400


def extract_checklist_section(body: str) -> str | None:
    """Return the first checklist-shaped section from a skill body, or ``None``.

    Walks *body* line by line and checks each ``##``-level heading against
    :data:`_CHECKLIST_HEADINGS` (case-insensitive prefix match).  When a match
    is found, collects lines until the next ``##``-level heading or end-of-file,
    strips leading/trailing whitespace, and returns the result capped at
    :data:`_CHECKLIST_MAX_CHARS` characters.  Returns ``None`` when no matching
    heading is found or the extracted text is empty.
    """
    if not body:
        return None

    lines = body.splitlines()
    n = len(lines)

    # Build a lower-cased version of each target heading for fast comparison.
    targets = tuple(h.lower() for h in _CHECKLIST_HEADINGS)

    # Priority: return the match for the highest-priority heading found.
    # We do a single pass recording the first-found position per heading, then
    # return the match with the lowest priority index.
    best_priority: int = len(targets)
    best_start: int = -1

    for i, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        if not stripped.startswith("## "):
            continue
        low = stripped.lower()
        for pri, target in enumerate(targets):
            if pri >= best_priority:
                break  # already have a better match
            if low.startswith(target):
                best_priority = pri
                best_start = i
                break  # each heading checked only once per line

    if best_start == -1:
        return None

    # Collect body lines from the line after the heading up to the next ## heading.
    body_lines: list[str] = []
    for j in range(best_start + 1, n):
        if lines[j].strip().startswith("## "):
            break
        body_lines.append(lines[j])

    text = "\n".join(body_lines).strip()
    if not text:
        return None

    # Cap at _CHECKLIST_MAX_CHARS; prefer breaking at a newline boundary.
    if len(text) > _CHECKLIST_MAX_CHARS:
        cut = text.rfind("\n", 0, _CHECKLIST_MAX_CHARS)
        if cut <= 0:
            cut = _CHECKLIST_MAX_CHARS
        text = text[:cut].rstrip() + "…"

    return text


def extract_h2_headings(body: str) -> list[str]:
    """Return a list of all ``##``-level heading texts found in *body*.

    Used by ``token-goat skill-body --section`` to list available sections when
    the ``--section`` flag is absent so the agent can discover section names
    before deciding which to fetch.

    Returns an empty list when *body* is empty or contains no ``##`` headings.
    """
    if not body:
        return []
    headings: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("## ") and len(stripped) > 3:
            headings.append(stripped[3:].strip())
    return headings


def extract_named_section(body: str, heading: str) -> str | None:
    """Return the content of the section matching *heading*, or ``None``.

    Searches ``##``-level headings first, then ``###``-level headings so that
    subsections of large skills (e.g. ``### Phase 1 — Explore`` inside ralph)
    are reachable without knowing the exact heading level.  A ``##`` match
    always wins over a ``###`` match for the same heading text.

    Case-insensitive prefix match on the heading text (after stripping the
    leading ``#`` prefix and whitespace).  Collects lines from the line after
    the matched heading up to the next heading at the same or higher level, or
    end of file.  Returns ``None`` when no matching heading is found or the
    extracted content is empty after stripping.

    This is the in-memory equivalent of ``read_replacement.read_section`` for
    skill bodies, which are not indexed in the project DB.
    """
    if not body or not heading:
        return None

    heading_lower = heading.strip().lower()
    lines = body.splitlines()
    n = len(lines)

    # Two-pass: prefer ## then fall back to ### or deeper.
    # Each pass records (line_index, heading_level) for the first match.
    match_start = -1
    match_level = -1

    for pass_level in (2, 3, 4):
        prefix = "#" * pass_level + " "
        for i, raw_line in enumerate(lines):
            stripped = raw_line.strip()
            if stripped.startswith(prefix):
                section_title = stripped[len(prefix):].strip().lower()
                if section_title.startswith(heading_lower):
                    match_start = i
                    match_level = pass_level
                    break
        if match_start != -1:
            break

    if match_start == -1:
        return None

    # Collect body lines until the next heading at the same or higher level.
    body_lines: list[str] = []
    for j in range(match_start + 1, n):
        stripped_j = lines[j].strip()
        # Stop at any heading at match_level or shorter (higher in hierarchy).
        # "#".startswith("##") is False but "###".startswith("##") is True, so
        # we check whether the line's leading-hash count is <= match_level.
        if stripped_j.startswith("#"):
            level_j = len(stripped_j) - len(stripped_j.lstrip("#"))
            if level_j <= match_level:
                break
        body_lines.append(lines[j])

    text = "\n".join(body_lines).strip()
    return text if text else None


def _sweep_skill_orphans() -> None:
    """One-shot cleanup of stale skill body blobs older than ``orphan_age_secs``.

    Sessions are short-lived (hours). Any body file older than the threshold
    (default 7 days) belongs to a dead session and can be safely removed.
    Sidecars (``.json``) next to removed blobs are also deleted.

    Runs once per process (guarded by ``_sweep_done`` flag) at first
    ``store_output()`` call. Fail-soft: any I/O error is logged and skipped.
    Never raises.
    """
    global _sweep_done  # noqa: PLW0603
    if _sweep_done:
        return
    _sweep_done = True

    try:
        from .config import load as _load_config  # noqa: PLC0415
        _cfg = _load_config()
        if not _cfg.skill_preservation.orphan_sweep_enabled:
            _LOG.debug("_sweep_skill_orphans: disabled by config")
            return
        age_secs = _cfg.skill_preservation.orphan_age_secs
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("_sweep_skill_orphans: config load failed, skipping: %s", exc)
        return

    cache_dir = _skill_outputs_dir()
    if not cache_dir.is_dir():
        return

    now = time.time()
    removed = 0
    try:
        for fp in cache_dir.iterdir():
            if fp.suffix == ".json":
                continue
            if not OUTPUT_FILENAME_RE.match(fp.name):
                continue
            try:
                age = now - fp.stat().st_mtime
                if age <= age_secs:
                    continue
                fp.unlink()
                removed += 1
                _LOG.debug("_sweep_skill_orphans: removed %s (age=%.1f days)", fp.name, age / 86400.0)
                sidecar = fp.with_suffix(".json")
                with contextlib.suppress(OSError):
                    sidecar.unlink()
            except OSError as exc:
                _LOG.debug("_sweep_skill_orphans: failed to remove %s: %s", fp.name, exc)
    except OSError as exc:
        _LOG.debug("_sweep_skill_orphans: directory scan failed: %s", exc)
        return

    if removed > 0:
        _LOG.info("_sweep_skill_orphans: removed %d stale skill body blob(s)", removed)


def store_output(
    session_id: str,
    skill_name: str,
    body: str,
    *,
    source_path: str = "",
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
) -> SkillMeta | None:
    """Write *body* to the cache and return descriptive metadata.

    Returns ``None`` on any I/O error so the calling hook can degrade silently.
    Body larger than ``_MAX_STORED_BYTES`` is tail-preserved (head truncated)
    using the shared :func:`truncate_tail_preserve` helper.  After the write
    the function opportunistically evicts the oldest files until the total
    store size is back under ``max_total_bytes``.

    Rejects invalid skill names (returns ``None`` without writing) to keep the
    filesystem layout safe from injection attacks.
    """
    _sweep_skill_orphans()

    name = _safe_skill_name(skill_name)
    if name is None:
        _LOG.warning(
            "skill_cache: rejected invalid skill_name: %s",
            sanitize_log_str(skill_name, max_len=120),
        )
        return None

    with safe_cache_op("store_output", log=_LOG):
        sha = content_hash(body)
        out_id = output_id_for(session_id, name, sha)
        stored, truncated = truncate_tail_preserve(
            body, _MAX_STORED_BYTES, marker_template=_TRUNC_MARKER,
        )
        if store_blob(out_id, stored, _skill_outputs_dir, "skill_cache") is None:
            return None

        meta = SkillMeta(
            output_id=out_id,
            skill_name=name,
            content_sha=sha,
            body_bytes=len(body.encode("utf-8", errors="replace")),
            ts=time.time(),
            truncated=truncated,
            source_path=source_path,
        )

        # Best-effort eviction.  We do not wait or retry: if the directory
        # walk fails (e.g. concurrent worker activity, antivirus lock) the
        # cap is enforced on the next call.
        evict_old_entries(max_total_bytes=max_total_bytes)

        _LOG.debug(
            "skill_cache: stored id=%s skill=%s bytes=%d truncated=%s",
            out_id, name, meta.body_bytes, truncated,
        )
        return meta
    return None


def load_output(output_id: str) -> str | None:
    """Return the cached skill body for *output_id*, or ``None`` if absent."""
    return load_output_text(output_id, _skill_outputs_dir, "skill_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None."""
    return load_output_meta_stat(output_id, _skill_outputs_dir, "skill_cache")


def evict_old_entries(*, max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES) -> int:
    """Evict the oldest entries until total size is at or under *max_total_bytes*."""
    return evict_cache_dir(
        cache_dir_fn=_skill_outputs_dir,
        log_name="skill_cache",
        max_total_bytes=max_total_bytes,
    )


def list_outputs() -> list[OutputStatDict]:
    """Return metadata for every cached output, newest first."""
    return list_cache_outputs(_skill_outputs_dir)


def lookup_by_name(skill_name: str) -> SkillMeta | None:
    """Return the most-recent cached entry for *skill_name*, across all sessions.

    Walks the cache directory and picks the entry whose ``skill_name`` field in
    the sidecar matches.  Returns ``None`` when no entry exists.  Used by the
    ``token-goat skill-body NAME`` CLI to find a body without needing the full
    ``output_id``.

    Skips invalid skill names defensively rather than scanning the directory
    with a name that could never have produced a valid entry.
    """
    matches = lookup_all_by_name(skill_name)
    return matches[0] if matches else None


def get_skill_file_path(skill_name: str) -> Path | None:
    """Resolve *skill_name* to an on-disk file path, or return ``None``.

    Resolution order:

    1. Check the in-memory/on-disk skill cache for any session's stored entry
       that recorded a ``source_path``.  Use the most-recent such entry whose
       path still exists on disk.
    2. Delegate to the same filesystem probe that the PostToolUse(Skill) hook
       uses at capture time: ``~/.claude/skills/<name>/SKILL.md``, plugin
       layouts, etc.  This covers the case where no PostToolUse hook has fired
       yet (e.g. the user queries a skill they have installed but never loaded
       in this session).

    Returns ``None`` when the skill cannot be located by either strategy.
    Never raises — callers treat ``None`` as "not found".
    """
    # Strategy 1: use the source_path recorded by the PostToolUse(Skill) hook.
    for candidate in lookup_all_by_name(skill_name):
        sp = candidate.source_path
        if sp:
            try:
                p = Path(sp)
                if p.is_file():
                    return p
            except (OSError, ValueError):
                continue

    # Strategy 2: probe the filesystem using the same logic as the hook.
    from . import hooks_skill  # noqa: PLC0415
    resolved = hooks_skill._resolve_skill_body_path(skill_name)
    if resolved:
        try:
            p = Path(resolved)
            if p.is_file():
                return p
        except (OSError, ValueError):
            pass

    return None


def lookup_all_by_name(skill_name: str) -> list[SkillMeta]:
    """Return every cached entry for *skill_name*, newest first.

    Used by the CLI recall path: when the most-recent entry's body file has
    been evicted (the sidecar may outlive the body since both go through
    independent unlinks under the byte-cap eviction loop), the caller can
    walk older entries to find a still-loadable body.  Each entry is paired
    with its sidecar metadata so callers can inspect ``ts`` and decide which
    is acceptable.

    Returns an empty list when no entry exists or the skill name is invalid.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        return []
    results: list[SkillMeta] = []
    for entry in list_outputs():
        oid = entry.get("output_id")
        if not oid:
            continue
        meta = read_sidecar(oid)
        if meta is None or meta.skill_name != name:
            continue
        results.append(meta)
    results.sort(key=lambda m: m.ts, reverse=True)
    return results


def list_by_session(session_id: str) -> list[SkillMeta]:
    """Return lightweight SkillMeta stubs for every cached entry in *session_id*.

    The ``output_id`` filename encodes ``{session_prefix}-{skill_name}-{sha}``.
    We parse it directly (no sidecar needed — ``store_output`` does not write
    sidecars) so that callers can discover whether the same skill was stored
    with multiple distinct ``content_sha`` values during one session (i.e. the
    skill body changed between loads).

    Fields populated: ``output_id``, ``skill_name``, ``content_sha``.
    Fields left at defaults: ``body_bytes=0``, ``ts=0.0``, ``truncated=False``.
    Entries that do not match the expected 3-segment format are skipped.

    ``list_outputs()`` returns entries newest-first by mtime; that order is
    preserved so callers iterating for "most recent sha" get it first.
    """
    prefix = safe_session_fragment(session_id)
    # prefix is 16 chars; output_id is "{prefix}-{safe_name}-{sha16}".
    # Split off the prefix+dash, then split on "-" from the right to extract sha.
    prefix_dash = prefix + "-"
    # sha portion is short_content_hash output: 16 lowercase hex chars.  Validate
    # both length and alphabet so a malformed filename that happens to share the
    # session prefix can't pollute the parsed result.
    _SHA_RE = re.compile(r"^[0-9a-f]{16}$")
    results: list[SkillMeta] = []
    for entry in list_outputs():
        oid = entry.get("output_id")
        if not oid or not oid.startswith(prefix_dash):
            continue
        # Strip session prefix, leaving "{safe_name}-{sha16}".
        remainder = oid[len(prefix_dash):]
        # sha is always the last 16-char hex segment after the final "-".
        dash_pos = remainder.rfind("-")
        if dash_pos < 1:
            continue
        safe_name = remainder[:dash_pos]
        sha = remainder[dash_pos + 1:]
        if not safe_name or not _SHA_RE.match(sha):
            continue
        # Restore ":" from "_" in plugin-namespaced names (best-effort; may be
        # ambiguous if the skill name itself contains underscores, but the
        # consumer only needs this for grouping, not exact round-tripping).
        skill_name = safe_name  # keep as-is for grouping; exact form in session
        results.append(SkillMeta(
            output_id=oid,
            skill_name=skill_name,
            content_sha=sha,
            body_bytes=0,
            ts=float(entry.get("mtime", 0.0)),
            truncated=False,
        ))
    return results


def sidecar_meta_path(output_id: str) -> Path | None:
    """Return the sidecar JSON metadata path for *output_id*, or None on invalid ID."""
    base = safe_join_output_id(output_id, _skill_outputs_dir, "skill_cache")
    if base is None:
        return None
    return sidecar_path_for(base)


def write_sidecar(meta: SkillMeta) -> None:
    """Persist *meta* as a JSON sidecar next to its output file (best-effort)."""
    write_sidecar_metadata(
        sidecar_meta_path(meta.output_id),
        meta,
        log=_LOG,
        log_prefix="skill_cache",
    )


def read_sidecar(output_id: str) -> SkillMeta | None:
    """Return parsed :class:`SkillMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added later — missing fields
    fall back to safe defaults so an old cache survives a token-goat upgrade.
    """
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        return SkillMeta(
            output_id=str(data.get("output_id", output_id)),
            skill_name=str(data.get("skill_name", "")),
            content_sha=str(data.get("content_sha", "")),
            body_bytes=int(data.get("body_bytes", 0)),
            ts=float(data.get("ts", 0.0)),
            truncated=bool(data.get("truncated", False)),
            source_path=str(data.get("source_path", "")),
        )
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Compact summary helpers
# ---------------------------------------------------------------------------

# Maximum characters for a compact summary (~400 tokens at ~4 chars/token).
_COMPACT_MAX_CHARS: int = 1600

# Keywords that identify high-priority "rule" lines worth including in the compact.
_RULE_KEYWORDS_RE = re.compile(r"\b(CRITICAL|MUST|NEVER|RULE)\b")


def generate_compact_summary(full_body: str) -> str:
    """Extract a compact summary from *full_body* capped at ~400 tokens (1600 chars).

    The summary includes, in order:
    1. The YAML frontmatter ``description`` field (if present) as an opening line.
    2. All H2 and H3 headings as a table of contents.
    3. All lines containing CRITICAL/MUST/NEVER/RULE keywords (first occurrence
       per unique line, deduplicated).
    4. Lines starting with ``**`` (bold emphasis — typically key directives).

    The result is capped at :data:`_COMPACT_MAX_CHARS` characters.  Returns the
    compact text as a single string; never raises.
    """
    if not full_body:
        return ""

    parts: list[str] = []

    # 1. Extract description from YAML frontmatter (between leading --- fences).
    fm_desc = _extract_frontmatter_description(full_body)
    if fm_desc:
        parts.append(fm_desc)

    # 2. H2/H3 headings as table of contents.
    headings: list[str] = []
    for line in full_body.splitlines():
        stripped = line.strip()
        if stripped.startswith("## ") or stripped.startswith("### "):
            headings.append(stripped)
    if headings:
        parts.append("**Sections:** " + " | ".join(headings))

    # 3. Lines with CRITICAL/MUST/NEVER/RULE (deduplicated, first occurrence only).
    seen_rules: set[str] = set()
    rule_lines: list[str] = []
    for line in full_body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _RULE_KEYWORDS_RE.search(stripped) and stripped not in seen_rules:
            seen_rules.add(stripped)
            rule_lines.append(stripped)
    if rule_lines:
        parts.append("\n".join(rule_lines))

    # 4. Bold-emphasis lines (start with "**").
    bold_lines: list[str] = []
    seen_bold: set[str] = set()
    for line in full_body.splitlines():
        stripped = line.strip()
        if stripped.startswith("**") and stripped not in seen_bold and stripped not in seen_rules:
            seen_bold.add(stripped)
            bold_lines.append(stripped)
    if bold_lines:
        parts.append("\n".join(bold_lines))

    text = "\n\n".join(parts)

    # Cap at _COMPACT_MAX_CHARS, breaking at a newline boundary when possible.
    if len(text) > _COMPACT_MAX_CHARS:
        cut = text.rfind("\n", 0, _COMPACT_MAX_CHARS)
        if cut <= 0:
            cut = _COMPACT_MAX_CHARS
        text = text[:cut].rstrip() + "…"

    return text


def _extract_frontmatter_description(body: str) -> str:
    """Return the ``description`` value from YAML frontmatter, or an empty string.

    Frontmatter is a block delimited by ``---`` at line 0 and a second ``---``
    later.  The ``description`` field may span multiple lines (block scalar);
    this implementation handles the simple single-line case (``description: text``)
    and ignores multi-line scalars to avoid a YAML parser dependency.
    """
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    # Find closing fence.
    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end == -1:
        return ""
    # Scan frontmatter block for a simple ``description: ...`` line.
    desc_re = re.compile(r"^description\s*:\s*(.+)$", re.IGNORECASE)
    for line in lines[1:end]:
        m = desc_re.match(line.strip())
        if m:
            value = m.group(1).strip().strip("'\"")
            return value
    return ""


def store_compact(session_id: str, skill_name: str, compact_text: str) -> None:
    """Persist a compact summary for *skill_name* under the skills cache directory.

    The compact is stored as a plain text file beside the full-body files, keyed
    by ``{session_fragment}-{safe_name}-compact``.  Fail-soft: any I/O error is
    logged and swallowed so callers are never interrupted.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        _LOG.warning(
            "skill_cache.store_compact: rejected invalid skill_name: %s",
            sanitize_log_str(skill_name, max_len=120),
        )
        return

    with safe_cache_op("store_compact", log=_LOG):
        from .cache_common import safe_session_fragment  # noqa: PLC0415

        safe_session = safe_session_fragment(session_id)
        safe_name = name.replace(":", "_")
        file_id = f"{safe_session}-{safe_name}-compact"
        out_dir = _skill_outputs_dir()
        out_path = out_dir / file_id
        out_path.write_text(compact_text, encoding="utf-8", errors="replace")
        _LOG.debug("skill_cache.store_compact: stored id=%s", file_id)


def get_compact(session_id: str, skill_name: str) -> str | None:
    """Return a previously stored compact summary for *skill_name*, or ``None``.

    Looks up by ``{session_fragment}-{safe_name}-compact`` in the skills cache
    directory.  Returns ``None`` when absent.  Fail-soft on I/O errors.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        return None

    try:
        from .cache_common import safe_session_fragment  # noqa: PLC0415

        safe_session = safe_session_fragment(session_id)
        safe_name = name.replace(":", "_")
        file_id = f"{safe_session}-{safe_name}-compact"
        out_path = _skill_outputs_dir() / file_id
        if not out_path.exists():
            return None
        return out_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        _LOG.debug("skill_cache.get_compact: I/O error for %s: %s", skill_name, exc)
        return None


def get_all_cached_skills(session_id: str | None = None) -> list[dict[str, object]]:
    """Return metadata for all cached skills, optionally filtered by session_id.

    For each skill, return a dict with keys:
    - name (str): the skill name
    - body_len (int): body size in bytes
    - compact_len (int): compact size in bytes (0 if not cached)
    - has_marker (bool): True if COMPACT_END_MARKER is present

    When *session_id* is provided, only skills from that session are returned.
    When *session_id* is None, all cached skills across all sessions are returned.

    Used by ``token-goat skill-size`` to report per-skill token overhead.
    Returns an empty list when no skills are cached.
    """
    results: list[dict[str, object]] = []

    if session_id is not None:
        # Filter by session
        session_metas = list_by_session(session_id)
    else:
        # All skills across all sessions (newest version per skill name)
        all_outputs = list_outputs()
        seen: dict[str, str] = {}  # skill_name -> output_id (newest)
        for entry in all_outputs:
            oid = entry.get("output_id")
            if not oid or oid.endswith("-compact"):
                continue
            meta = read_sidecar(oid)
            if meta is not None and meta.skill_name not in seen:
                seen[meta.skill_name] = oid
        session_metas = []
        for skill_name, oid in seen.items():
            session_metas.append(SkillMeta(
                output_id=oid,
                skill_name=skill_name,
                content_sha="",
                body_bytes=0,
                ts=0.0,
                truncated=False,
            ))

    for meta in session_metas:
        # Load the full body to calculate metrics.
        body = load_output(meta.output_id)
        if body is None:
            continue

        # Try to load the compact form if it exists.
        compact_text: str | None = None
        if session_id is not None:
            compact_text = get_compact(session_id, meta.skill_name)
        else:
            # When no session specified, try to find any compact version
            for entry in list_outputs():
                oid = entry.get("output_id", "")
                if oid.endswith("-compact"):
                    # Compact file: {session}-{safe_name}-compact
                    file_id = oid[:-8]  # strip "-compact"
                    # Check if this compact matches our skill
                    meta_check = read_sidecar(file_id)
                    if meta_check and meta_check.skill_name == meta.skill_name:
                        compact_text = load_output(oid)
                        break

        compact_len = len(compact_text.encode("utf-8", errors="replace")) if compact_text else 0

        # Check for marker.
        has_marker = extract_compact_from_marker(body) is not None

        results.append({
            "name": meta.skill_name,
            "body_len": len(body.encode("utf-8", errors="replace")),
            "compact_len": compact_len,
            "has_marker": has_marker,
        })

    return results
