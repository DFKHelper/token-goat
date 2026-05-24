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
    "DEFAULT_MAX_TOTAL_BYTES",
    "OUTPUT_FILENAME_RE",
    "SkillMeta",
    "content_hash",
    "evict_old_entries",
    "extract_checklist_section",
    "list_by_session",
    "list_outputs",
    "load_output",
    "load_output_meta",
    "lookup_by_name",
    "output_id_for",
    "read_sidecar",
    "store_output",
    "write_sidecar",
]

import re
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .cache_common import (
    OUTPUT_FILENAME_RE,
    OutputStatDict,
    evict_cache_dir,
    get_cache_dir,
    list_cache_outputs,
    load_output_meta_stat,
    load_output_text,
    load_sidecar_json,
    safe_join_output_id,
    safe_session_fragment,
    short_content_hash,
    sidecar_path_for,
    truncate_tail_preserve,
    write_sidecar_metadata,
)
from .hooks_common import sanitize_log_str
from .util import get_logger

_LOG = get_logger("skill_cache")

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
    name = _safe_skill_name(skill_name)
    if name is None:
        _LOG.warning(
            "skill_cache: rejected invalid skill_name: %s",
            sanitize_log_str(skill_name, max_len=120),
        )
        return None

    try:
        sha = content_hash(body)
        out_id = output_id_for(session_id, name, sha)
        path = safe_join_output_id(out_id, _skill_outputs_dir, "skill_cache")
        if path is None:
            return None

        stored, truncated = truncate_tail_preserve(
            body, _MAX_STORED_BYTES, marker_template=_TRUNC_MARKER,
        )
        paths.atomic_write_text(path, stored)

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
    except OSError as exc:
        _LOG.warning("skill_cache: store failed: %s", exc)
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
    name = _safe_skill_name(skill_name)
    if name is None:
        return None
    best: SkillMeta | None = None
    best_ts: float = 0.0
    for entry in list_outputs():
        oid = entry.get("output_id")
        if not oid:
            continue
        meta = read_sidecar(oid)
        if meta is None or meta.skill_name != name:
            continue
        if meta.ts > best_ts:
            best, best_ts = meta, meta.ts
    return best


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
        if not safe_name or not sha:
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
