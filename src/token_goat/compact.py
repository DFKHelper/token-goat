"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

import logging
import operator
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from . import session as session_mod
from .repomap import estimate_tokens

if TYPE_CHECKING:
    from .session import SessionCache

_LOG = logging.getLogger("token_goat.compact")

_MAX_FILES_READ = 10
_MAX_SYMBOLS_FILES = 8
_MAX_RANGES_PER_FILE = 4
# Max symbols listed per file entry in the manifest (separate from _MAX_SYMBOLS_FILES,
# which caps the number of *files* that show any symbols at all).
_MAX_SYMBOLS_PER_FILE_ENTRY = 6


def _short_path(p: str, max_len: int = 70) -> str:
    """Return a compact representation of a file path."""
    p = p.replace("\\", "/")
    # Strip common prefixes to keep paths short
    for prefix in ("/src/", "/tests/", "/docs/"):
        idx = p.find(prefix)
        if idx >= 0:
            return p[idx + 1:]
    if len(p) > max_len:
        return "…" + p[-(max_len - 1):]
    return p


def _format_ranges(ranges: list[tuple[int, int]]) -> str:
    """Render line ranges compactly, e.g. 'lines 1-50, 100-200'."""
    if not ranges:
        return ""
    shown = ranges[:_MAX_RANGES_PER_FILE]
    parts = [str(s) if s == e else f"{s}-{e}" for s, e in shown]
    extra = f" +{len(ranges) - _MAX_RANGES_PER_FILE} more" if len(ranges) > _MAX_RANGES_PER_FILE else ""
    return f"  lines {', '.join(parts)}{extra}"


def event_count(session_id: str) -> int:
    """Count tracked events (reads + greps + edits) for a session."""
    try:
        session_mod.validate_session_id(session_id)
        cache = session_mod.load(session_id)
        return len(cache.files) + len(cache.greps) + len(cache.edited_files)
    except Exception as e:  # noqa: BLE001
        _LOG.debug("event_count(%s) failed: %s", session_id[:8] if session_id else "<empty>", e)
        return 0


def build_manifest(session_id: str, *, max_tokens: int = 400) -> str:
    """Build a compact session manifest from the session cache.

    Returns structured text under *max_tokens* tokens that summarises:
    - Files edited this session (most important: must survive compaction)
    - Symbols accessed via token-goat read/symbol commands
    - Key files read, deduped and sorted by access frequency

    Safe to call even when the session cache is empty or missing.
    """
    t0 = time.monotonic()
    try:
        session_mod.validate_session_id(session_id)
    except ValueError as exc:
        _LOG.warning("build_manifest: invalid session_id: %s", exc)
        return ""
    _LOG.debug("build_manifest: session=%s max_tokens=%d", session_id[:8], max_tokens)
    try:
        cache = session_mod.load(session_id)
    except Exception as e:  # noqa: BLE001
        _LOG.warning("compact: could not load session %s: %s", session_id[:8], e)
        return ""

    result, symbols_files_count = _render(cache, session_id, max_tokens)
    elapsed = time.monotonic() - t0
    token_estimate = estimate_tokens(result)
    _LOG.info(
        "build_manifest: session=%s edited_files=%d files_read=%d symbols_files=%d "
        "manifest_tokens=%d elapsed=%.3fs",
        session_id[:8],
        len(cache.edited_files),
        len(cache.files),
        symbols_files_count,
        token_estimate,
        elapsed,
    )
    return result


def _render(cache: SessionCache, session_id: str, max_tokens: int) -> tuple[str, int]:
    """Build the Markdown session manifest string from *cache* for the PreCompact hook.

    Priority order:
    1. **Edited files** — always listed first; the compaction LLM must preserve these.
    2. **Symbols accessed** — files where specific symbols were read via ``token-goat read``.
    3. **Key files read** — top files by ``read_count`` (most re-read first).

    If the rendered manifest exceeds *max_tokens*, lines are trimmed from the
    bottom until the budget is met, preserving the highest-priority sections.
    Returns a (manifest_string, symbols_files_count) tuple.  The string is empty
    when the cache has no meaningful data (nothing edited, no symbols accessed,
    no files read).
    """
    # Return early if there is nothing meaningful to report
    if not cache.edited_files and not cache.files:
        return "", 0

    files_with_symbols = [e for e in cache.files.values() if e.symbols_read]
    # Most-frequently-read files, capped at _MAX_FILES_READ, for the "Key Files Read" section.
    top_files = sorted(cache.files.values(), key=lambda e: -e.read_count)[:_MAX_FILES_READ]

    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    sid = session_id[:8]
    sections: list[str] = [
        "## Token-Goat Session Manifest",
        f"Session: {sid}  |  {now}",
        "",
    ]

    # ── 1. Edited files — highest priority ────────────────────────────────────
    if cache.edited_files:
        sections.append("### Files Edited (preserve in summary)")
        # Sort by edit count descending — operator.itemgetter avoids lambda
        # object creation on each sort call and runs at C speed.
        for path, count in sorted(cache.edited_files.items(), key=operator.itemgetter(1), reverse=True):
            suffix = f"  ×{count}" if count > 1 else ""
            sections.append(f"- {_short_path(path)}{suffix}")
        sections.append("")

    # ── 2. Symbols accessed via token-goat read / symbol ────────────────────────
    if files_with_symbols:
        sections.append("### Symbols Accessed")
        for entry in files_with_symbols[:_MAX_SYMBOLS_FILES]:
            syms = entry.symbols_read[:_MAX_SYMBOLS_PER_FILE_ENTRY]
            overflow = len(entry.symbols_read) - _MAX_SYMBOLS_PER_FILE_ENTRY
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "")
            sections.append(f"- {_short_path(entry.rel_or_abs)} → {sym_str}")
        sections.append("")

    # ── 3. Key files read (top N by read_count) ───────────────────────────────
    if top_files:
        sections.append("### Key Files Read")
        for entry in top_files:
            count_str = f"  ×{entry.read_count}" if entry.read_count > 1 else ""
            ranges_str = _format_ranges(entry.line_ranges)
            sections.append(f"- {_short_path(entry.rel_or_abs)}{count_str}{ranges_str}")
        sections.append("")

    result = "\n".join(sections).rstrip()
    n_symbols_files = len(files_with_symbols)

    if estimate_tokens(result) <= max_tokens:
        return result, n_symbols_files

    # Trim: drop lines from the bottom until within budget, preserving headers.
    # Track accumulated character length incrementally to avoid O(n²) re-joins
    # on each iteration of the trim loop.
    lines = result.splitlines()
    # budget in chars: max_tokens * 3 chars/token (conservative from estimate_tokens)
    char_budget = max_tokens * 3 - 1
    total_chars = sum(len(ln) for ln in lines) + len(lines) - 1
    while total_chars > char_budget and len(lines) > 3:
        removed = lines.pop()
        total_chars -= len(removed) + 1  # +1 for the '\n' separator
    return "\n".join(lines), n_symbols_files
