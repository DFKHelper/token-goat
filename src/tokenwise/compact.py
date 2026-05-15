"""Session manifest generator for compaction assist.

Builds a <400-token structured summary of the session's file activity so the
compaction LLM knows what to preserve without reading the full conversation.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from . import session as session_mod
from .repomap import estimate_tokens
from .session import SessionCache

_LOG = logging.getLogger("tokenwise.compact")

_MAX_FILES_READ = 10
_MAX_SYMBOLS_FILES = 8
_MAX_RANGES_PER_FILE = 4


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
        cache = session_mod.load(session_id)
        return len(cache.files) + len(cache.greps) + len(cache.edited_files)
    except Exception as e:  # noqa: BLE001
        _LOG.debug("event_count(%s) failed: %s", session_id[:8], e)
        return 0


def build_manifest(session_id: str, *, max_tokens: int = 400) -> str:
    """Build a compact session manifest from the session cache.

    Returns structured text under *max_tokens* tokens that summarises:
    - Files edited this session (most important: must survive compaction)
    - Symbols accessed via tokenwise read/symbol commands
    - Key files read, deduped and sorted by access frequency

    Safe to call even when the session cache is empty or missing.
    """
    try:
        cache = session_mod.load(session_id)
    except Exception:  # noqa: BLE001
        _LOG.warning("compact: could not load session %s", session_id[:8])
        return ""

    return _render(cache, session_id, max_tokens)


def _render(cache: SessionCache, session_id: str, max_tokens: int) -> str:
    files_with_symbols = [e for e in cache.files.values() if e.symbols_read]
    readable = sorted(cache.files.values(), key=lambda e: -e.read_count)[:_MAX_FILES_READ]

    # Return empty if there is nothing meaningful to report
    if not cache.edited_files and not files_with_symbols and not readable:
        return ""

    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    sid = session_id[:8]
    sections: list[str] = [
        "## Tokenwise Session Manifest",
        f"Session: {sid}  |  {now}",
        "",
    ]

    # ── 1. Edited files — highest priority ────────────────────────────────────
    if cache.edited_files:
        sections.append("### Files Edited (preserve in summary)")
        # Sort by edit count descending
        for path, count in sorted(cache.edited_files.items(), key=lambda x: -x[1]):
            suffix = f"  ×{count}" if count > 1 else ""
            sections.append(f"- {_short_path(path)}{suffix}")
        sections.append("")

    # ── 2. Symbols accessed via tokenwise read / symbol ────────────────────────
    if files_with_symbols:
        sections.append("### Symbols Accessed")
        for entry in files_with_symbols[:_MAX_SYMBOLS_FILES]:
            syms = entry.symbols_read[:6]
            overflow = len(entry.symbols_read) - 6
            sym_str = ", ".join(syms) + (f" +{overflow}" if overflow > 0 else "")
            sections.append(f"- {_short_path(entry.rel_or_abs)} → {sym_str}")
        sections.append("")

    # ── 3. Key files read (top N by read_count) ───────────────────────────────
    if readable:
        sections.append("### Key Files Read")
        for entry in readable:
            count_str = f"  ×{entry.read_count}" if entry.read_count > 1 else ""
            ranges_str = _format_ranges(entry.line_ranges)
            sections.append(f"- {_short_path(entry.rel_or_abs)}{count_str}{ranges_str}")
        sections.append("")

    result = "\n".join(sections).rstrip()

    if estimate_tokens(result) <= max_tokens:
        return result

    # Trim: drop lines from the bottom until within budget, preserving headers
    lines = result.splitlines()
    while estimate_tokens("\n".join(lines)) > max_tokens and len(lines) > 3:
        lines.pop()
    return "\n".join(lines)
