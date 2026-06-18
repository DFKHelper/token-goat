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
    "MAX_COMPACT_FILE_COUNT",
    "OUTPUT_FILENAME_RE",
    "SIDECAR_SCHEMA_VERSION",
    "_DIR_LISTING_CACHE_TTL_SECS",
    "_MIN_COMPACT_CONTENT_CHARS",
    "SkillMeta",
    "_get_skills_dir_listing",
    "_is_valid_compact",
    "_parse_section_ordinal",
    "content_hash",
    "evict_old_entries",
    "extract_all_headings",
    "extract_checklist_section",
    "extract_compact_from_marker",
    "extract_compact_source_sha",
    "extract_h2_headings",
    "extract_named_section",
    "find_cross_session_entry",
    "generate_compact_summary",
    "get_all_cached_skills",
    "get_compact",
    "get_compact_any_session",
    "get_compact_mtime",
    "get_skill_file_path",
    "invalidate_for_path",
    "list_by_session",
    "list_outputs",
    "load_output",
    "load_output_meta",
    "lookup_all_by_name",
    "lookup_by_name",
    "output_id_for",
    "read_sidecar",
    "sidecar_meta_path",
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
    find_markdown_boundary,
    get_cache_dir,
    list_cache_outputs,
    load_blob_gz,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    safe_cache_op,
    safe_join_output_id,
    safe_session_fragment,
    short_content_hash,
    sidecar_path_for,
    store_blob,
    store_blob_gz,
    truncate_tail_preserve,
)
from .hooks_common import sanitize_log_str
from .util import get_logger

_LOG = get_logger("skill_cache")

# One-shot orphan sweep flag: set to True after the sweep runs in this process.
_sweep_done = False

# Process-local directory listing cache for the skills output directory.
# A single manifest build may call get_compact_any_session() once per loaded
# skill; each call previously ran out_dir.glob(pattern), which is an OS-level
# directory scan.  With 3 skills that is 3 scans of the same directory in
# rapid succession.  The cache below stores the full directory listing for a
# short TTL (5 s) so that all skill lookups within one render share a single
# iterdir() call.  TTL is deliberately short so new compact files written
# between manifest renders are visible without delay.
_DIR_LISTING_CACHE_TTL_SECS: float = 5.0
_dir_listing_cache: tuple[float, list[Path]] | None = None


def _get_skills_dir_listing(out_dir: Path) -> list[Path]:
    """Return a cached listing of *out_dir*, refreshed at most every 5 seconds.

    Caches the result of ``list(out_dir.iterdir())`` so that multiple
    :func:`get_compact_any_session` calls within a single manifest render
    reuse the same directory scan rather than each running a separate
    ``Path.glob()`` syscall.  Fail-soft: returns an empty list on I/O error.
    """
    global _dir_listing_cache
    now = time.time()
    if _dir_listing_cache is not None:
        cached_ts, cached_list = _dir_listing_cache
        if now - cached_ts < _DIR_LISTING_CACHE_TTL_SECS:
            return cached_list
    try:
        listing = list(out_dir.iterdir())
    except OSError:
        listing = []
    _dir_listing_cache = (now, listing)
    return listing


# Schema version embedded in every newly written SkillMeta sidecar JSON.
# Increment this when a new required field is added so that read_sidecar can
# detect entries written by older versions and handle them gracefully.
#
# v1  — original schema (output_id, skill_name, content_sha, body_bytes, ts,
#        truncated; source_path added later as optional with "" default)
# v2  — explicit schema_v field; source_path promoted from implicit default to
#        tracked presence; read_sidecar detects v1 entries and back-fills
#        source_path as "" without discarding the entry.
SIDECAR_SCHEMA_VERSION: int = 2

# Total byte budget for the on-disk skill body store.  When exceeded, the
# oldest entries (by mtime) are evicted until the cap is met.  5 MB is small
# enough to be invisible on any modern disk while big enough to hold dozens of
# skill bodies (most are 5–30 KB; the largest known skill is ~50 KB).
DEFAULT_MAX_TOTAL_BYTES: int = 5 * 1024 * 1024

# Maximum number of compact files allowed in the cache directory.  Compact
# files have no extension (``{session}-{name}-compact``) so they are invisible
# to the `.txt`-only LRU eviction in :func:`evict_old_entries`.  Without a
# count cap they accumulate indefinitely — one compact per (session, skill)
# pair per ``token-goat skill-compact`` invocation.  Each file is tiny
# (usually < 2 KB) so a byte cap would never fire, but a count cap of 500
# gives plenty of headroom for active use (a session with 10 skills × 50
# compactions = 500) while bounding the long-term tail of orphaned compacts.
MAX_COMPACT_FILE_COUNT: int = 500

# Compact file name regex: ``{session}-{safe_name}-compact`` with no extension.
# Session fragment and safe_name are restricted to ``[a-zA-Z0-9_-]``.  The
# trailing ``-compact`` literal is the distinguishing token.
_COMPACT_FILENAME_RE: re.Pattern[str] = re.compile(
    r"^[a-zA-Z0-9_\-]{1,80}-compact$"
)

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


def _store_blob_gz(output_id: str, text: str) -> Path | None:
    """Delegate to :func:`cache_common.store_blob_gz` for the skills directory."""
    return store_blob_gz(output_id, text, _skill_outputs_dir, "skill_cache")


def _load_blob_gz(output_id: str) -> str | None:
    """Delegate to :func:`cache_common.load_blob_gz` for the skills directory."""
    return load_blob_gz(output_id, _skill_outputs_dir, "skill_cache")


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

    Collision-free namespace marker: when the original *skill_name* contains a
    ``:`` (plugin-namespaced form), a ``n`` suffix is appended to the
    filesystem-safe name segment so that ``plugin:improve`` produces
    ``plugin_improven`` while the plain ``plugin_improve`` skill produces
    ``plugin_improve`` — distinct filenames despite both mapping to the same
    ``_``-substituted string.  The ``n`` stands for "namespaced" and is chosen
    because it does not appear in the short content hash (hex-only).
    """
    safe_session = safe_session_fragment(session_id)
    safe_name = skill_name.replace(":", "_")
    if ":" in skill_name:
        safe_name += "n"  # namespace-collision guard
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
        if stripped.startswith(("```", "~~~")):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if stripped == COMPACT_END_MARKER:
            pre_marker = "\n".join(lines[:i]).strip()
            return pre_marker or None
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
    # Code-block-aware: headings inside fenced blocks (``` or ~~~) are skipped.
    best_priority: int = len(targets)
    best_start: int = -1
    in_code_block = False

    for i, raw_line in enumerate(lines):
        stripped = raw_line.strip()
        if stripped.startswith(("```", "~~~")):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
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

    # Cap at _CHECKLIST_MAX_CHARS; prefer breaking at a markdown boundary
    # (heading or paragraph) rather than at an arbitrary newline so the
    # extracted checklist is a complete unit.
    if len(text) > _CHECKLIST_MAX_CHARS:
        cut = find_markdown_boundary(text, _CHECKLIST_MAX_CHARS)
        if cut <= 0:
            cut = _CHECKLIST_MAX_CHARS
        text = text[:cut].rstrip() + "…"

    return text


def extract_h2_headings(body: str) -> list[str]:
    """Return a list of all ``##``-level heading texts found in *body*.

    Code-block-aware: headings inside fenced blocks (``` or ~~~) are excluded.
    Returns an empty list when *body* is empty or contains no ``##`` headings.
    """
    if not body:
        return []
    headings = []
    in_code_block = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_code_block = not in_code_block
        elif not in_code_block and stripped.startswith("## ") and len(stripped) > 3:
            headings.append(stripped[3:].strip())
    return headings


def extract_all_headings(body: str, max_level: int = 3) -> list[tuple[int, str]]:
    """Return all headings up to *max_level* depth as ``(level, title)`` tuples.

    Unlike :func:`extract_h2_headings`, this function includes H3 (and
    optionally H4+) headings so callers can show the complete navigable
    section tree.  :func:`extract_named_section` can reach H3/H4 sections
    but they were previously invisible in the "Sections available" hint,
    making subsections of large skills like ralph undiscoverable without
    knowing the exact heading text in advance.

    Each tuple is ``(heading_level, heading_text)`` where *heading_level* is
    the number of leading ``#`` characters (2, 3, or 4).

    Returns an empty list when *body* is empty.  Headings inside fenced code
    blocks are excluded to avoid false positives from Markdown examples.
    """
    if not body:
        return []
    headings: list[tuple[int, str]] = []
    in_code_block = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if not stripped.startswith("#"):
            continue
        # Count leading hashes.
        level = len(stripped) - len(stripped.lstrip("#"))
        if level < 2 or level > max_level:
            continue
        title = stripped[level:].strip()
        if title:
            headings.append((level, title))
    return headings


def _parse_section_ordinal(heading: str) -> tuple[str, int | None]:
    """Split a heading like ``Usage#2`` into ``("Usage", 2)``.

    The ``#N`` suffix selects which occurrence to return when a skill contains
    multiple headings with the same text (e.g. two ``## Usage`` sections).
    Returns ``(heading, None)`` when no ordinal suffix is present or the suffix
    is malformed, so a real heading containing ``#`` is not mistakenly treated
    as an ordinal.
    """
    if "#" not in heading:
        return heading, None
    base, _, ordinal_str = heading.rpartition("#")
    if not base or not ordinal_str:
        return heading, None
    try:
        ordinal = int(ordinal_str)
    except ValueError:
        return heading, None
    if ordinal < 1:
        return heading, None
    return base, ordinal


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

    Supports an ordinal suffix ``Heading#N`` (1-based) to select the *N*-th
    occurrence when a skill contains multiple sections with the same heading
    text.  Without an ordinal, the first match is returned and a warning is
    logged listing other match line numbers so the caller knows to add ``#2``,
    ``#3``, etc.

    This is the in-memory equivalent of ``read_replacement.read_section`` for
    skill bodies, which are not indexed in the project DB.
    """
    if not body or not heading:
        return None

    base_heading, ordinal = _parse_section_ordinal(heading)
    heading_lower = base_heading.strip().lower()
    lines = body.splitlines()
    n = len(lines)

    # Two-pass: prefer ## then fall back to ### or deeper.
    # Each pass collects ALL matches at that level (for ordinal selection and
    # disambiguation warnings).  Code-block-aware: headings inside fenced
    # blocks (``` or ~~~) are skipped.
    # matches_at_level: list of (line_index, heading_level) for each match.
    matches: list[tuple[int, int]] = []

    for pass_level in (2, 3, 4):
        prefix = "#" * pass_level + " "
        in_code_block = False
        level_matches: list[tuple[int, int]] = []
        for i, raw_line in enumerate(lines):
            stripped = raw_line.strip()
            if stripped.startswith(("```", "~~~")):
                in_code_block = not in_code_block
                continue
            if in_code_block:
                continue
            if stripped.startswith(prefix):
                section_title = stripped[len(prefix):].strip().lower()
                if section_title.startswith(heading_lower):
                    level_matches.append((i, pass_level))
        if level_matches:
            matches = level_matches
            break

    if not matches:
        return None

    # Apply ordinal selection or first-match default with disambiguation warning.
    if ordinal is not None:
        if ordinal > len(matches):
            _LOG.info(
                "extract_named_section: ordinal %d requested for %r but only %d match(es); "
                "no section returned",
                ordinal, base_heading, len(matches),
            )
            return None
        match_start, match_level = matches[ordinal - 1]
    elif len(matches) > 1:
        # Multiple sections share this heading text; return the first and log a
        # disambiguation hint so the caller knows to add #2, #3, etc.
        other_lines = ", ".join(str(line_idx + 1) for line_idx, _ in matches[1:])
        _LOG.warning(
            "extract_named_section: %d sections share heading %r; returning first "
            "(line %d). Use %r#2, %r#3, … (other matches at lines: %s)",
            len(matches), base_heading, matches[0][0] + 1,
            base_heading, base_heading, other_lines,
        )
        match_start, match_level = matches[0]
    else:
        match_start, match_level = matches[0]

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
    return text or None


def _sweep_skill_orphans() -> None:
    """One-shot cleanup of stale skill body blobs older than ``orphan_age_secs``.

    Sessions are short-lived (hours). Any body file older than the threshold
    (default 7 days) belongs to a dead session and can be safely removed.
    Sidecars (``.json``) next to removed blobs are also deleted.

    Also sweeps compact files (``{session}-{name}-compact``, no extension).
    These are invisible to the `.txt`-only LRU eviction in
    :func:`evict_old_entries` and would otherwise accumulate indefinitely
    after their corresponding session ends.

    Runs once per process (guarded by ``_sweep_done`` flag) at first
    ``store_output()`` call. Fail-soft: any I/O error is logged and skipped.
    Never raises.
    """
    global _sweep_done
    if _sweep_done:
        return
    _sweep_done = True

    try:
        from .config import load as _load_config
        _cfg = _load_config()
        if not _cfg.skill_preservation.orphan_sweep_enabled:
            _LOG.debug("_sweep_skill_orphans: disabled by config")
            return
        age_secs = _cfg.skill_preservation.orphan_age_secs
    except Exception as exc:
        _LOG.debug("_sweep_skill_orphans: config load failed, skipping: %s", exc)
        return

    cache_dir = _skill_outputs_dir()
    if not cache_dir.is_dir():
        return

    now = time.time()
    removed = 0
    compact_removed = 0
    try:
        for fp in cache_dir.iterdir():
            if fp.suffix == ".json":
                continue
            is_body = OUTPUT_FILENAME_RE.match(fp.name)
            is_compact = _COMPACT_FILENAME_RE.match(fp.name)
            if not is_body and not is_compact:
                continue
            try:
                age = now - fp.stat().st_mtime
                if age <= age_secs:
                    continue
                fp.unlink()
                if is_body:
                    removed += 1
                    _LOG.debug(
                        "_sweep_skill_orphans: removed body %s (age=%.1f days)",
                        fp.name, age / 86400.0,
                    )
                    sidecar = fp.with_suffix(".json")
                    with contextlib.suppress(OSError):
                        sidecar.unlink()
                else:
                    compact_removed += 1
                    _LOG.debug(
                        "_sweep_skill_orphans: removed compact %s (age=%.1f days)",
                        fp.name, age / 86400.0,
                    )
            except OSError as exc:
                _LOG.debug("_sweep_skill_orphans: failed to remove %s: %s", fp.name, exc)
    except OSError as exc:
        _LOG.debug("_sweep_skill_orphans: directory scan failed: %s", exc)
        return

    if removed > 0:
        _LOG.info("_sweep_skill_orphans: removed %d stale skill body blob(s)", removed)
    if compact_removed > 0:
        _LOG.info("_sweep_skill_orphans: removed %d stale compact file(s)", compact_removed)


def find_cross_session_entry(skill_name: str, content_sha: str) -> SkillMeta | None:
    """Search for an existing body entry with the same *skill_name* and *content_sha*.

    Scans all sidecar files in the skills cache directory and returns the first
    :class:`SkillMeta` whose ``skill_name`` and ``content_sha`` match the
    requested values AND whose body file still exists on disk.  Returns ``None``
    when no such entry is found.

    This is the cross-session dedup probe used by :func:`store_output`: when the
    same skill body (same SHA) was already cached in an earlier session, the new
    session reuses the existing file rather than writing a duplicate.  The
    returned ``SkillMeta.output_id`` points at the *original* session's file so
    :func:`load_output` works without any path indirection.

    Fail-soft: any I/O error during the scan is logged and skipped.  Returns
    ``None`` in all error cases so the caller falls back to the normal write path.
    """
    name = _safe_skill_name(skill_name)
    if not name or not content_sha:
        return None

    cache_dir = _skill_outputs_dir()
    if not cache_dir.is_dir():
        return None

    try:
        for entry in list_outputs():
            oid = entry.get("output_id")
            if not oid:
                continue
            meta = read_sidecar(oid)
            if meta is None:
                continue
            if meta.skill_name != name or meta.content_sha != content_sha:
                continue
            # Verify the body file is still present on disk.
            body_path = cache_dir / f"{oid}.txt"
            gz_path = cache_dir / f"{oid}.gz"
            if body_path.exists() or gz_path.exists():
                _LOG.debug(
                    "find_cross_session_entry: hit for skill=%s sha=%s id=%s",
                    name, content_sha[:8], oid,
                )
                return meta
    except Exception as exc:
        _LOG.debug("find_cross_session_entry: scan error: %s", exc)

    return None


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

    **Cross-session dedup:** when another session has already cached the same
    skill body (same *skill_name* and content SHA), this function skips the disk
    write and returns a :class:`SkillMeta` pointing at the existing entry.  The
    body file is only written once per unique ``(name, sha)`` pair across the
    entire cache lifetime.  This saves disk I/O on the hot path where a long-lived
    install accumulates the same ralph/improve/etc. skill body across hundreds of
    sessions.

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

        # Cross-session dedup: avoid writing the same body bytes twice when the
        # same skill (same SHA) was already cached in an earlier session.  The
        # existing entry's output_id is reused so load_output works without any
        # path indirection.  The caller (hooks_skill) will still call
        # write_sidecar to record the new session's timestamp alongside the
        # existing body file.
        cross_session_hit = find_cross_session_entry(name, sha)
        if cross_session_hit is not None:
            _LOG.debug(
                "skill_cache: cross-session dedup hit for skill=%s sha=%s "
                "(existing id=%s); skipping disk write",
                name, sha[:8], cross_session_hit.output_id,
            )
            # Return a fresh SkillMeta with the caller-supplied source_path and
            # an updated timestamp so the sidecar written by the caller reflects
            # the current session load, not the original session's metadata.
            return SkillMeta(
                output_id=cross_session_hit.output_id,
                skill_name=name,
                content_sha=sha,
                body_bytes=cross_session_hit.body_bytes,
                ts=time.time(),
                truncated=cross_session_hit.truncated,
                source_path=source_path or cross_session_hit.source_path,
            )

        out_id = output_id_for(session_id, name, sha)
        stored, truncated = truncate_tail_preserve(
            body, _MAX_STORED_BYTES, marker_template=_TRUNC_MARKER,
        )

        # Determine whether to compress this body.
        compress = False
        try:
            from .config import load as _load_config
            _sp = _load_config().skill_preservation
            compress = (
                _sp.compress_bodies
                and len(stored.encode("utf-8", errors="replace")) >= _sp.compress_min_bytes
            )
        except Exception:
            pass

        stored_path: Path | None
        if compress:
            stored_path = _store_blob_gz(out_id, stored)
        else:
            stored_path = store_blob(out_id, stored, _skill_outputs_dir, "skill_cache")

        if stored_path is None:
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
        # cap is enforced on the next call.  Protect the id we just wrote so a
        # coarse-mtime tie can never evict this very entry (MRU protection).
        evict_old_entries(max_total_bytes=max_total_bytes, protect_id=out_id)

        _LOG.debug(
            "skill_cache: stored id=%s skill=%s bytes=%d truncated=%s compressed=%s",
            out_id, name, meta.body_bytes, truncated, compress,
        )
        return meta
    return None


def load_output(output_id: str) -> str | None:
    """Return the cached skill body for *output_id*, or ``None`` if absent.

    Transparently decompresses gzip-stored bodies: checks for ``output_id.gz``
    first, then falls back to the plain-text file so callers see plain text
    regardless of how the body was stored.
    """
    gz_text = _load_blob_gz(output_id)
    if gz_text is not None:
        return gz_text
    return load_output_text(output_id, _skill_outputs_dir, "skill_cache")


def load_output_meta(output_id: str) -> OutputStatDict | None:
    """Return stat-derived metadata for an output file (size, mtime), or None."""
    return load_output_meta_stat(output_id, _skill_outputs_dir, "skill_cache")


def evict_old_entries(
    *,
    max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
    max_compact_files: int = MAX_COMPACT_FILE_COUNT,
    protect_id: str | None = None,
) -> int:
    """Evict the oldest body entries until total size is at or under *max_total_bytes*.

    Also enforces a count cap on compact files (``{session}-{name}-compact``,
    no extension).  Compact files are tiny (usually < 2 KB each) so the
    byte-cap eviction that :func:`cache_common.evict_cache_dir` runs on
    ``.txt`` body files would never reach them — without a count cap they
    accumulate indefinitely.  The oldest compacts (by mtime) are removed first
    when the count exceeds *max_compact_files*.

    *protect_id*, when given, is the output id the caller just wrote; it is
    forwarded as the protected set so a coarse-mtime tie can never evict the
    freshest entry (see :func:`cache_common.evict_cache_dir`).

    Returns the number of body files removed by the LRU eviction (the compact
    count eviction runs separately and does not add to this total).
    """
    removed = evict_cache_dir(
        cache_dir_fn=_skill_outputs_dir,
        log_name="skill_cache",
        max_total_bytes=max_total_bytes,
        protect_ids=frozenset({protect_id}) if protect_id else None,
    )
    _evict_compact_files(max_compact_files=max_compact_files)
    return removed


def _evict_compact_files(*, max_compact_files: int = MAX_COMPACT_FILE_COUNT) -> None:
    """Remove the oldest compact files when the count exceeds *max_compact_files*.

    Compact files are named ``{session}-{name}-compact`` with no extension and
    are not tracked by the byte-cap LRU eviction that targets ``.txt`` body
    files.  This function provides a separate count-based guard so a long-lived
    install (many sessions × many skills) does not accumulate thousands of
    tiny compact files.

    Fail-soft: any I/O error is logged at DEBUG and skipped.  Never raises.
    """
    try:
        cache_dir = _skill_outputs_dir()
        if not cache_dir.is_dir():
            return

        compacts: list[tuple[Path, float]] = []
        try:
            for fp in cache_dir.iterdir():
                if not _COMPACT_FILENAME_RE.match(fp.name):
                    continue
                try:
                    st = fp.stat()
                except OSError:
                    continue
                compacts.append((fp, float(st.st_mtime)))
        except OSError as exc:
            _LOG.debug("skill_cache._evict_compact_files: directory scan failed: %s", exc)
            return

        if len(compacts) <= max_compact_files:
            return

        # Sort oldest-first and evict the surplus.
        compacts.sort(key=lambda t: t[1])
        to_evict = len(compacts) - max_compact_files
        evicted = 0
        for fp, _mtime in compacts[:to_evict]:
            try:
                fp.unlink(missing_ok=True)
                evicted += 1
                _LOG.debug("skill_cache._evict_compact_files: removed %s", fp.name)
            except OSError as exc:
                _LOG.debug(
                    "skill_cache._evict_compact_files: failed to remove %s: %s",
                    fp.name, exc,
                )

        if evicted > 0:
            _LOG.info(
                "skill_cache._evict_compact_files: evicted %d compact file(s) (cap=%d)",
                evicted, max_compact_files,
            )
    except Exception as exc:
        _LOG.debug("skill_cache._evict_compact_files: unexpected error: %s", exc)


def invalidate_for_path(file_path: str) -> int:
    """Remove all cached skill entries whose ``source_path`` matches *file_path*.

    Called by the worker after re-indexing a file that was in the dirty queue,
    when that file is a known skill body path.  Ensures that the stale cached
    body is not served to the agent after the skill has been edited on disk.

    Also removes associated compact files keyed to the same skill name/session
    so a subsequent ``--compact`` recall regenerates from the fresh body.

    Returns the number of body files removed.  Fail-soft: any I/O error is
    logged and skipped so the worker is never interrupted.
    """
    if not file_path:
        return 0

    # Normalise the path for comparison: resolve forward-slash/back-slash
    # differences on Windows.
    try:
        norm_path = str(Path(file_path).resolve())
    except (OSError, ValueError):
        norm_path = file_path.replace("\\", "/")

    removed = 0
    # Set of compact-file name suffixes to purge, built during the body-removal
    # loop (before files are deleted) so the second pass sees the right suffix
    # patterns even though the body .txt files have already been unlinked.
    compact_suffixes: set[str] = set()
    cache_dir = _skill_outputs_dir()
    if not cache_dir.is_dir():
        return 0

    for entry in list_outputs():
        oid = entry.get("output_id")
        if not oid:
            continue
        meta = read_sidecar(oid)
        if meta is None:
            continue
        if not meta.source_path:
            continue
        try:
            candidate_norm = str(Path(meta.source_path).resolve())
        except (OSError, ValueError):
            candidate_norm = meta.source_path.replace("\\", "/")
        if candidate_norm != norm_path:
            continue
        # Match found: collect the compact suffix pattern BEFORE removing files
        # so the suffix is available even after the body .txt is deleted.
        # Must mirror _compact_file_id exactly — it lowercases the safe name, so
        # a mixed-case skill name (e.g. "userSettings:brainstorming") writes a
        # compact file as "...-usersettings_brainstormingn-compact". Without the
        # same .lower() here the purge suffix never matches and the stale compact
        # survives a skill edit.
        safe_name = meta.skill_name.lower().replace(":", "_")
        if ":" in meta.skill_name:
            safe_name += "n"
        compact_suffixes.add(f"-{safe_name}-compact")
        # Remove body file (.txt and optionally .gz) and sidecar (.json).
        body_path = cache_dir / f"{oid}.txt"
        gz_path = cache_dir / f"{oid}.gz"
        sidecar = cache_dir / f"{oid}.json"
        for p in (body_path, gz_path, sidecar):
            try:
                if p.exists():
                    p.unlink()
                    _LOG.debug("skill_cache.invalidate_for_path: removed %s", p.name)
            except OSError as exc:
                _LOG.debug("skill_cache.invalidate_for_path: failed to remove %s: %s", p.name, exc)
        removed += 1

    # Purge compact files whose name ends with any of the collected suffixes.
    # Compact files are named ``{session_fragment}-{safe_name}-compact`` with no
    # extension, so ``fp.suffix == ""`` and the suffix pattern is an exact match.
    if compact_suffixes:
        try:
            for fp in cache_dir.iterdir():
                if fp.suffix:  # compact files have no extension (.txt/.gz/.json have suffixes)
                    continue
                for sfx in compact_suffixes:
                    if fp.name.endswith(sfx):
                        with contextlib.suppress(OSError):
                            fp.unlink()
                            _LOG.debug(
                                "skill_cache.invalidate_for_path: removed compact %s", fp.name
                            )
                        break
        except OSError as exc:
            _LOG.debug("skill_cache.invalidate_for_path: compact scan failed: %s", exc)

    # Mark any doc compact sidecar stale so pre_read stops serving it.
    try:
        from pathlib import Path as _Path

        from . import doc_compact as _dc
        from .project import find_project
        _abs = _Path(norm_path)
        _proj = find_project(_abs.parent)
        if _proj is not None:
            _cpath = _dc.find_compact_for_path(_abs, _proj.hash)
            if _cpath is not None:
                _dc.mark_compact_stale(_cpath)
    except Exception as exc:
        _LOG.debug("skill_cache.invalidate_for_path: doc_compact stale failed: %s", exc)

    if removed > 0:
        _LOG.info(
            "skill_cache.invalidate_for_path: removed %d entr%s for path %s",
            removed, "y" if removed == 1 else "ies",
            sanitize_log_str(file_path, max_len=120),
        )
    return removed


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
    from . import hooks_skill
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
    """Persist *meta* as a JSON sidecar next to its output file (best-effort).

    Embeds :data:`SIDECAR_SCHEMA_VERSION` in the written JSON so that
    :func:`read_sidecar` can detect entries created by older versions and
    apply appropriate migration or ignore-and-continue logic.
    """
    import json as _json
    from dataclasses import asdict as _asdict

    sidecar_path = sidecar_meta_path(meta.output_id)
    if sidecar_path is None:
        return
    try:
        from . import paths as _paths
        payload = _asdict(meta)
        payload["schema_v"] = SIDECAR_SCHEMA_VERSION
        _paths.atomic_write_text(
            sidecar_path,
            _json.dumps(payload, ensure_ascii=False),
        )
    except OSError as exc:
        _LOG.debug(
            "skill_cache: sidecar write failed for %s: %s",
            meta.output_id,
            exc,
        )


def read_sidecar(output_id: str) -> SkillMeta | None:
    """Return parsed :class:`SkillMeta` from the sidecar JSON, or None.

    Tolerant of older sidecars that lack fields added in later schema versions:

    * **v1 → v2**: ``source_path`` was added as an optional field with ``""``
      default; older entries simply omit it.  :func:`read_sidecar` back-fills
      the default so callers never see ``None`` for this field.
    * Entries with ``schema_v`` greater than :data:`SIDECAR_SCHEMA_VERSION`
      (written by a future version of token-goat) are loaded with best-effort
      parsing — unknown fields are silently ignored, known fields retain their
      safe defaults when absent.

    Returns ``None`` only when the file is missing, unreadable, or the JSON
    payload cannot be coerced into a valid :class:`SkillMeta` at all (e.g. the
    required ``output_id`` field is a dict rather than a string).
    """
    p = sidecar_meta_path(output_id)
    if p is None:
        return None
    data = load_sidecar_json(p)
    if data is None:
        return None
    try:
        # Log a debug note when the stored schema version is ahead of ours so
        # operators can tell if a downgrade is in play without failing loudly.
        stored_v = data.get("schema_v")
        if stored_v is not None:
            try:
                stored_v_int = int(stored_v)
            except (TypeError, ValueError):
                stored_v_int = 0
            if stored_v_int > SIDECAR_SCHEMA_VERSION:
                _LOG.debug(
                    "read_sidecar: entry %s has schema_v=%s > current %s; "
                    "unknown fields will be ignored",
                    output_id,
                    stored_v,
                    SIDECAR_SCHEMA_VERSION,
                )
        return SkillMeta(
            output_id=str(data.get("output_id", output_id)),
            skill_name=str(data.get("skill_name", "")),
            content_sha=str(data.get("content_sha", "")),
            body_bytes=int(data.get("body_bytes", 0)),
            ts=float(data.get("ts", 0.0)),
            truncated=bool(data.get("truncated", False)),
            # v1 entries lack source_path; default to "" (safe for all callers).
            source_path=str(data.get("source_path", "")),
        )
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Compact summary helpers
# ---------------------------------------------------------------------------

# Maximum characters for a compact summary (~400 tokens at ~4 chars/token).
_COMPACT_MAX_CHARS: int = 1600

# Regex that matches the one-line header prepended by store_compact.
# Two supported forms:
#   Old (pre-staleness-tracking): "--- compact form (N tokens) ---\n"
#   New (with source SHA):        "--- compact form (N tokens, sha=ABCD1234) ---\n"
# Used by _strip_compact_header to recover the bare body for accurate token counting
# and by extract_compact_source_sha to retrieve the embedded SHA.
_COMPACT_HEADER_RE = re.compile(r"^--- compact form \(\d+ tokens(?:, sha=[0-9a-f]+)?\) ---\n")
_COMPACT_HEADER_SHA_RE = re.compile(r"^--- compact form \(\d+ tokens, sha=([0-9a-f]+)\) ---\n")

# Keywords that identify high-priority "rule" lines worth including in the compact.
_RULE_KEYWORDS_RE = re.compile(r"\b(CRITICAL|MUST|NEVER|RULE)\b")


def _strip_compact_header(stored_text: str) -> str:
    """Strip the one-line metadata header from a stored compact text and return the body.

    :func:`store_compact` prepends ``"--- compact form (N tokens) ---\\n"`` (or the
    newer ``"--- compact form (N tokens, sha=ABCD1234) ---\\n"`` form) so readers can
    immediately see the token count.  When computing token counts programmatically
    (e.g. in :func:`get_all_cached_skills`) we need only the body so that
    ``len(body) // 4`` matches the formula used at write time.

    Returns the input unchanged when no header is present (safe for callers that
    may receive raw body text instead of stored compact text).
    """
    m = _COMPACT_HEADER_RE.match(stored_text)
    if m:
        return stored_text[m.end():]
    return stored_text


def extract_compact_source_sha(stored_text: str) -> str | None:
    """Return the ``source_sha`` embedded in a compact header, or ``None``.

    When :func:`store_compact` is called with a *source_sha* (the sha256 hex
    digest of the body that generated the compact), it embeds the first 12 hex
    characters in the header line:

        ``--- compact form (N tokens, sha=ABCD12345678) ---``

    This function extracts that fragment so callers can compare it against the
    current body's sha and warn when the compact is derived from a different
    version of the skill body (i.e. the compact may be stale).

    Returns ``None`` when the header is absent or was written by an older version
    of token-goat that did not embed a sha.
    """
    m = _COMPACT_HEADER_SHA_RE.match(stored_text)
    if m:
        return m.group(1)
    return None


def score_compact(compact_body: str, full_body: str) -> dict[str, object]:
    """Score the quality of a compact relative to its source body.

    Returns a dict with these fields:

    - ``score`` (int 0-100): overall quality score (higher is better).
    - ``coverage_ratio`` (float 0.0-1.0): compact tokens / body tokens, capped at 1.0.
      A well-formed compact should be 0.10–0.50 (10-50% of the body).
    - ``non_empty_sections`` (int): number of headings in the compact followed by
      at least one non-blank content line.
    - ``has_goal_marker`` (bool): whether the compact contains a COMPACT_END marker
      or a frontmatter ``description:`` field — both indicate the compact was
      intentionally curated vs. heuristically generated.
    - ``headings_count`` (int): total H1-H4 heading count in the compact body
      (outside fenced code blocks).
    - ``has_rule_lines`` (bool): whether any CRITICAL/MUST/NEVER/RULE lines were
      preserved (a signal that the compact captured load-bearing directives).
    - ``issues`` (list[str]): human-readable warnings about quality problems.

    Callers must pass the *bare* compact body (without the ``--- compact form … ---``
    header line — pass the output of :func:`_strip_compact_header`).  The *full_body*
    should be the original skill body text used to estimate the coverage ratio.
    """
    issues: list[str] = []

    # ── token estimates ────────────────────────────────────────────────────────
    # Use the same 3-chars/token heuristic as compact.estimate_tokens so the
    # coverage ratio is internally consistent.
    compact_tokens = max(1, len(compact_body) // 3)
    body_tokens = max(1, len(full_body) // 3)
    raw_ratio = compact_tokens / body_tokens
    coverage_ratio = min(1.0, raw_ratio)

    # ── heading analysis (code-block-aware) ───────────────────────────────────
    in_fence = False
    headings: list[str] = []
    lines = compact_body.splitlines()
    i = 0
    heading_has_content: list[bool] = []
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            i += 1
            continue
        if not in_fence and stripped.startswith("#"):
            headings.append(stripped)
            # Look ahead for at least one non-blank content line
            j = i + 1
            has_content = False
            while j < len(lines):
                next_stripped = lines[j].strip()
                if next_stripped.startswith("#"):
                    break
                if next_stripped and not next_stripped.startswith("```"):
                    has_content = True
                    break
                j += 1
            heading_has_content.append(has_content)
        i += 1

    headings_count = len(headings)
    non_empty_sections = sum(1 for hc in heading_has_content if hc)

    # ── goal / curation markers ───────────────────────────────────────────────
    has_goal_marker = (
        "<!-- COMPACT_END -->" in full_body
        or bool(_COMPACT_HEADER_RE.match(compact_body + "\n"))  # unlikely but safe
        # frontmatter description in the body is a strong curation signal
        or (full_body.startswith("---") and "description:" in full_body[:400])
    )

    # ── rule-line presence ────────────────────────────────────────────────────
    has_rule_lines = bool(_RULE_KEYWORDS_RE.search(compact_body))

    # ── quality scoring ───────────────────────────────────────────────────────
    # Base score starts at 50; penalties and bonuses applied below.
    score = 50

    # Coverage ratio: ideal range 0.10–0.50.  Too small → may be empty/stub.
    # Too large → compact is not meaningfully smaller than the body.
    if raw_ratio < 0.05:
        score -= 20
        issues.append(f"compact is very small ({coverage_ratio:.0%} of body) — may be stub or empty")
    elif raw_ratio < 0.10:
        score -= 8
        issues.append(f"compact coverage is low ({coverage_ratio:.0%} of body)")
    elif raw_ratio <= 0.50:
        score += 15  # ideal range
    elif raw_ratio <= 0.80:
        score += 5   # acceptable but verbose
    else:
        score -= 10
        issues.append(f"compact is {coverage_ratio:.0%} of body — barely smaller than the original")

    # Headings: structured compacts are easier to navigate.
    if headings_count == 0:
        score -= 10
        issues.append("compact has no headings — may be unstructured prose")
    elif headings_count >= 3:
        score += 10

    # Non-empty sections: sections with content are better than placeholder headers.
    empty_sections = headings_count - non_empty_sections
    if headings_count > 0 and empty_sections > 0:
        score -= 5 * min(empty_sections, 3)
        issues.append(f"{empty_sections} section(s) with no content lines")

    # Goal/curation marker: intentionally curated compacts score higher.
    if has_goal_marker:
        score += 10

    # Rule lines: load-bearing directives were preserved.
    if has_rule_lines:
        score += 5

    # Clamp to 0-100.
    score = max(0, min(100, score))

    return {
        "score": score,
        "coverage_ratio": round(coverage_ratio, 4),
        "non_empty_sections": non_empty_sections,
        "has_goal_marker": has_goal_marker,
        "headings_count": headings_count,
        "has_rule_lines": has_rule_lines,
        "issues": issues,
    }


def generate_compact_summary(full_body: str) -> str:
    """Extract a compact summary from *full_body* capped at ~400 tokens (1600 chars).

    The summary includes, in order:
    1. The YAML frontmatter ``description`` field (if present) as an opening line.
    2. All H2 and H3 headings as a table of contents (code-block-aware: headings
       inside fenced blocks are excluded to avoid false positives from examples).
    3. All lines containing CRITICAL/MUST/NEVER/RULE keywords (first occurrence
       per unique line, deduplicated, code-block-aware).
    4. Lines starting with ``**`` (bold emphasis — typically key directives,
       code-block-aware).
    5. Fallback for flat skill files: when none of the above yield content, the
       first non-empty, non-heading prose paragraph (up to 400 chars) is used.
       Flat skills (no structural headings, no rule keywords) still get a usable
       compact so the compaction manifest is not empty for that skill.

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

    # Single-pass over lines: track code-block state to exclude content inside
    # fenced blocks from all three extraction phases (headings, rules, bold).
    # A fence opens or closes when a stripped line starts with ``` or ~~~.
    in_code_block = False
    # Frontmatter tracking: skip the leading --- block so field declarations
    # (e.g. "description: ...") are not captured as prose or rule lines.
    # _fm_open/closed follow the first pair of "---" lines at the head of the
    # document; after that, "---" is a normal horizontal rule.
    in_frontmatter = False
    headings: list[str] = []
    seen_rules: set[str] = set()
    rule_lines: list[str] = []
    seen_bold: set[str] = set()
    bold_lines: list[str] = []
    # Track first prose paragraph for the flat-file fallback (phase 5).
    first_prose: str = ""

    for line_idx, line in enumerate(full_body.splitlines()):
        stripped = line.strip()

        # Frontmatter detection: the very first line "---" opens a YAML block;
        # a subsequent "---" closes it.  We skip all content inside.
        if line_idx == 0 and stripped == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            continue

        # Track fenced code block state.
        if stripped.startswith(("```", "~~~")):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        # 2. H2/H3 headings as table of contents.
        if stripped.startswith(("## ", "### ")):
            headings.append(stripped)
            continue

        if not stripped:
            continue

        # 3. Lines with CRITICAL/MUST/NEVER/RULE (deduplicated, first occurrence).
        if _RULE_KEYWORDS_RE.search(stripped) and stripped not in seen_rules:
            seen_rules.add(stripped)
            rule_lines.append(stripped)

        # 4. Bold-emphasis lines (start with "**").
        if stripped.startswith("**") and stripped not in seen_bold and stripped not in seen_rules:
            seen_bold.add(stripped)
            bold_lines.append(stripped)

        # 5. Collect first prose paragraph for flat-file fallback: skip H1 titles
        # and lines that are solely horizontal rules or other Markdown decorators.
        if (
            not first_prose
            and not stripped.startswith("#")
            and not stripped.startswith(">")
            and not set(stripped).issubset(set("-_* \t"))
            and len(stripped) >= 20
        ):
            first_prose = stripped

    if headings:
        parts.append("**Sections:** " + " | ".join(headings))
    if rule_lines:
        parts.append("\n".join(rule_lines))
    if bold_lines:
        parts.append("\n".join(bold_lines))

    # 5. Flat-file fallback: when none of the structural extractions yielded
    # content beyond a possible frontmatter description, include the first prose
    # paragraph so the manifest is not empty for minimally structured skills.
    if not headings and not rule_lines and not bold_lines and first_prose:
        cap = min(len(first_prose), 400)
        prose_snippet = first_prose[:cap]
        if cap < len(first_prose):
            prose_snippet = prose_snippet.rstrip() + "…"
        parts.append(prose_snippet)

    text = "\n\n".join(parts)

    # Cap at _COMPACT_MAX_CHARS, breaking at a markdown heading or paragraph
    # boundary when possible so the compact ends at a coherent structural point
    # rather than mid-sentence.  Falls back to the last plain newline, then
    # hard-cuts at the byte cap.
    if len(text) > _COMPACT_MAX_CHARS:
        cut = find_markdown_boundary(text, _COMPACT_MAX_CHARS)
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
            return m.group(1).strip().strip("'\"")
    return ""


def _compact_file_id(session_id: str, skill_name: str) -> str:
    """Build the filesystem-safe compact-file ID for a (session, skill) pair.

    Uses the same namespace-collision guard as :func:`output_id_for`: when
    *skill_name* contains a ``:`` (plugin-namespaced form) an ``n`` suffix is
    appended to the safe name so ``plugin:improve`` and ``plugin_improve``
    produce distinct compact file IDs.
    """
    safe_session = safe_session_fragment(session_id)
    safe_name = skill_name.lower().replace(":", "_")
    if ":" in skill_name:
        safe_name += "n"  # namespace-collision guard (matches output_id_for)
    return f"{safe_session}-{safe_name}-compact"


def store_compact(
    session_id: str,
    skill_name: str,
    compact_text: str,
    source_sha: str | None = None,
) -> None:
    """Persist a compact summary for *skill_name* under the skills cache directory.

    The compact is stored as a plain text file beside the full-body files, keyed
    by ``{session_fragment}-{safe_name}-compact`` (collision-safe: see
    :func:`_compact_file_id`).  Fail-soft: any I/O error is logged and swallowed
    so callers are never interrupted.

    *source_sha* is the sha256 hex digest of the skill body that generated this
    compact.  When supplied, the first 12 hex characters are embedded in the
    header line so :func:`extract_compact_source_sha` can later verify freshness:

        ``--- compact form (N tokens, sha=ABCD12345678) ---``

    Callers should pass the ``content_sha`` from the :class:`SkillMeta` entry
    that was active when the compact was generated.  Omitting it (or passing
    ``None``) stores the old header format, which is treated as "unknown sha"
    by the staleness check and will not trigger a stale-compact warning.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        _LOG.warning(
            "skill_cache.store_compact: rejected invalid skill_name: %s",
            sanitize_log_str(skill_name, max_len=120),
        )
        return

    with safe_cache_op("store_compact", log=_LOG):
        from . import paths as _paths

        file_id = _compact_file_id(session_id, name)
        out_dir = _skill_outputs_dir()
        out_path = out_dir / file_id
        # Prepend a header so readers (compaction manifest, CLI, model) immediately
        # know this is the truncated compact form and how large it is relative to
        # the full body.  The token estimate uses the 4-chars/token convention
        # consistent with how hooks_skill.py reports body size.
        compact_tokens = max(1, len(compact_text) // 4)
        # Embed the first 12 hex chars of source_sha when available so the
        # staleness check in cmd_skill_body can detect when the compact was
        # derived from a different version of the body.
        if source_sha and len(source_sha) >= 8:
            sha_fragment = source_sha[:12]
            header = f"--- compact form ({compact_tokens} tokens, sha={sha_fragment}) ---\n"
        else:
            header = f"--- compact form ({compact_tokens} tokens) ---\n"
        stored_text = header + compact_text
        # Use atomic write (temp file + rename) so concurrent sessions writing the
        # same compact cannot produce a torn file.  Matches the pattern used by
        # store_blob / session.py for all other cache writes.
        _paths.atomic_write_text(out_path, stored_text)
        # Invalidate the directory listing cache so subsequent calls to
        # get_compact_any_session within the same process pick up the newly
        # written compact without waiting for the TTL to expire.
        global _dir_listing_cache
        _dir_listing_cache = None
        _LOG.debug("skill_cache.store_compact: stored id=%s (%d tokens)", file_id, compact_tokens)


# Minimum number of non-whitespace characters required for a compact to be
# considered valid.  Files shorter than this threshold are treated as empty or
# corrupted (e.g. a zero-byte file, a file containing only a stale header, or
# a file produced by a partial write) and callers receive ``None`` instead of
# the garbage content.  10 chars is low enough to pass any real compact (even a
# trivial one-line "## Rules\nX." snippet is 14 chars) while reliably catching
# empty, header-only, and whitespace-only files.
_MIN_COMPACT_CONTENT_CHARS: int = 10


def _is_valid_compact(text: str) -> bool:
    """Return True when *text* looks like a real compact (non-empty, non-stub).

    Rejects:
    * Empty strings and whitespace-only strings.
    * Files whose non-whitespace content is below ``_MIN_COMPACT_CONTENT_CHARS``
      — these are header-only stubs or zero-byte corruption artifacts.

    Does NOT validate format/structure; callers that need quality scoring should
    call :func:`score_compact` separately.
    """
    stripped = text.strip()
    if not stripped:
        return False
    non_ws = sum(1 for c in stripped if not c.isspace())
    return non_ws >= _MIN_COMPACT_CONTENT_CHARS


def get_compact(session_id: str, skill_name: str) -> str | None:
    """Return a previously stored compact summary for *skill_name*, or ``None``.

    Looks up by ``{session_fragment}-{safe_name}-compact`` (collision-safe: see
    :func:`_compact_file_id`) in the skills cache directory.  Returns ``None``
    when absent.  Fail-soft on I/O errors.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        return None

    try:
        file_id = _compact_file_id(session_id, name)
        out_path = _skill_outputs_dir() / file_id
        if not out_path.exists():
            return None
        text = out_path.read_text(encoding="utf-8", errors="replace")
        if not _is_valid_compact(text):
            _LOG.debug(
                "skill_cache.get_compact: compact file %s is empty or corrupted — returning None",
                file_id,
            )
            return None
        return text
    except OSError as exc:
        _LOG.debug("skill_cache.get_compact: I/O error for %s: %s", skill_name, exc)
        return None


def get_compact_any_session(skill_name: str) -> str | None:
    """Return a compact summary for *skill_name* from any session, or ``None``.

    Unlike :func:`get_compact`, this performs a cross-session glob search for
    ``*-{safe_name}-compact`` files in the skills cache directory, picking the
    newest match by file mtime.  Used by :mod:`hooks_skill` post_skill advisory
    and by :mod:`install` to verify that a pre-generated compact is visible
    regardless of which session created it.  Fail-soft on I/O errors.
    """
    name = _safe_skill_name(skill_name)
    if name is None:
        return None

    safe_name = name.lower().replace(":", "_")
    if ":" in name:
        safe_name += "n"
    suffix = f"-{safe_name}-compact"

    try:
        out_dir = _skill_outputs_dir()
        # Use the process-local directory listing cache to avoid a separate
        # glob() syscall for each skill when multiple skills are looked up
        # during a single manifest render.  The cache is refreshed every 5 s
        # so newly written compact files are visible promptly.
        all_entries = _get_skills_dir_listing(out_dir)
        matches = [p for p in all_entries if p.name.endswith(suffix)]
        if not matches:
            return None
        # Sort by mtime descending so we try the newest file first.  If it is
        # corrupted/empty, fall through to the next-newest one.
        sorted_matches = sorted(matches, key=lambda p: p.stat().st_mtime, reverse=True)
        for candidate in sorted_matches:
            try:
                text = candidate.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if _is_valid_compact(text):
                return text
            _LOG.debug(
                "skill_cache.get_compact_any_session: skipping corrupted/empty compact %s",
                candidate.name,
            )
        return None
    except OSError as exc:
        _LOG.debug("skill_cache.get_compact_any_session: I/O error for %s: %s", skill_name, exc)
        return None


def get_compact_mtime(session_id: str, skill_name: str) -> float | None:
    """Return the mtime (POSIX seconds) of the stored compact file, or ``None``.

    Used by ``token-goat skill-list`` to display how old a compact is (separate
    from body age).  Returns ``None`` when no compact exists for this
    (session, skill) pair, or on any I/O error (fail-soft).

    The returned value is the raw :meth:`pathlib.Path.stat().st_mtime` float,
    so callers compute age as ``time.time() - get_compact_mtime(...)`` when
    the return value is not ``None``.
    """
    if not session_id:
        return None
    name = _safe_skill_name(skill_name)
    if name is None:
        return None
    try:
        file_id = _compact_file_id(session_id, name)
        out_path = _skill_outputs_dir() / file_id
        if not out_path.exists():
            return None
        return out_path.stat().st_mtime
    except (OSError, TypeError) as exc:
        _LOG.debug("skill_cache.get_compact_mtime: I/O error for %s: %s", skill_name, exc)
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

        # Compute compact_chars: character count of the compact *body* (header
        # stripped) so callers can derive token counts with the same
        # ``len(body) // 4`` formula used in store_compact — avoiding the
        # double-count from the header line and the byte-vs-char discrepancy
        # for non-ASCII content.  See _strip_compact_header for the stripping logic.
        if compact_text:
            compact_body_text = _strip_compact_header(compact_text)
            compact_chars = len(compact_body_text)
        else:
            compact_chars = 0

        # Check for marker.
        has_marker = extract_compact_from_marker(body) is not None

        results.append({
            "name": meta.skill_name,
            "body_len": len(body.encode("utf-8", errors="replace")),
            "body_chars": len(body),
            "compact_len": compact_len,
            "compact_chars": compact_chars,
            "has_marker": has_marker,
        })

    return results
