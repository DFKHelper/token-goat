"""Builds informational hints for PreToolUse on Read."""
from __future__ import annotations

import logging
from pathlib import Path

from . import db, session
from .project import find_project

_LOG = logging.getLogger("cc_saver.hints")

# Token estimator: ~3.5 chars/token, ~60 chars/line code → ~17 tokens/line average
CHARS_PER_TOKEN = 3.5
AVG_CHARS_PER_LINE = 60
TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN  # ≈17.1

# Thresholds
LARGE_FILE_LINE_THRESHOLD = 500
MIN_OVERLAP_TO_WARN = 50  # only warn about overlap if >50 lines overlap
DEFAULT_READ_LIMIT = 2000  # Claude Code's default lines-per-Read


def _est_tokens_from_lines(n_lines: int) -> int:
    """Rough token estimate from line count (integer, never < 1)."""
    return max(1, int(n_lines * TOKENS_PER_LINE))


def _est_tokens_from_chars(n_chars: int) -> int:
    """Rough token estimate from character count."""
    return max(1, int(n_chars / CHARS_PER_TOKEN))


def _line_count(path: Path) -> int | None:
    """Cheap newline count; returns None on any error."""
    try:
        if not path.is_file():
            return None
        with path.open("rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def _get_indexed_symbols(file_rel: str, project_hash: str) -> list[dict]:
    """Return symbols indexed for this file (up to 50), ordered by line number."""
    try:
        with db.open_project(project_hash) as conn:
            rows = conn.execute(
                """
                SELECT kind, name, line, end_line
                FROM symbols
                WHERE file_rel = ? AND name IS NOT NULL
                ORDER BY line
                LIMIT 50
                """,
                (file_rel,),
            ).fetchall()
            return [dict(r) for r in rows]
    except Exception:  # noqa: BLE001
        _LOG.exception("failed to load indexed symbols for %s", file_rel)
        return []


def build_read_hint(
    *,
    session_id: str | None,
    file_path: str,
    offset: int | None,
    limit: int | None,
    cwd: str | None,
) -> str | None:
    """Return a hint string, or None when no hint is warranted."""
    if not session_id or not file_path:
        return None

    # Requested line range (1-indexed inclusive).
    req_start = (offset or 0) + 1
    req_end = req_start + (limit or DEFAULT_READ_LIMIT) - 1

    # 1. Check session cache first.
    entry = session.get_file_entry(session_id, file_path)
    if entry is not None:
        return _hint_from_cache(entry, req_start, req_end, file_path)

    # 2. Not cached — consider "large file with indexed symbols" suggestion.
    return _hint_from_index(file_path, cwd, req_start, req_end)


# ---------------------------------------------------------------------------
# Hint builders
# ---------------------------------------------------------------------------


def _hint_from_cache(
    entry: session.FileEntry,
    req_start: int,
    req_end: int,
    file_path: str,
) -> str | None:
    """Build hint when the file was already accessed this session."""
    fname = Path(file_path).name

    # Case: file accessed only via cc-saver read <file>::<symbol>
    if entry.symbols_read and not entry.line_ranges:
        sym_list = ", ".join(f"`{s}`" for s in entry.symbols_read[:3])
        more = f" and {len(entry.symbols_read) - 3} more" if len(entry.symbols_read) > 3 else ""
        return (
            f"Note: `{fname}` was already accessed this session via "
            f"`cc-saver read` for symbol(s): {sym_list}{more}. "
            f"If you only need additional symbols, consider "
            f"`cc-saver read \"{file_path}::another_symbol\"` "
            f"instead of reading the whole file."
        )

    # Compute overlap against all cached ranges.
    overlap_lines = 0
    exact_match = False
    for cached_start, cached_end in entry.line_ranges:
        ov_s = max(cached_start, req_start)
        ov_e = min(cached_end, req_end)
        if ov_e >= ov_s:
            overlap_lines += ov_e - ov_s + 1
        if cached_start <= req_start and cached_end >= req_end:
            exact_match = True

    cached_summary = ", ".join(f"{s}-{e}" for s, e in entry.line_ranges[:3])
    extra = f" (+{len(entry.line_ranges) - 3} more ranges)" if len(entry.line_ranges) > 3 else ""

    if exact_match:
        wasted = _est_tokens_from_lines(req_end - req_start + 1)
        return (
            f"Note: `{fname}` lines {req_start}-{req_end} were already read this session "
            f"(cached ranges: {cached_summary}{extra}). "
            f"Re-reading wastes ~{wasted} tokens. "
            f"Consider whether your existing context is sufficient, or use a different "
            f"offset/limit to read only new content."
        )

    if overlap_lines > MIN_OVERLAP_TO_WARN:
        wasted = _est_tokens_from_lines(overlap_lines)
        # Suggest skipping to just past the last cached end.
        last_cached_end = max(e for _, e in entry.line_ranges)
        suggested_offset = last_cached_end  # offset is 0-indexed, so last_cached_end skips up to that line
        return (
            f"Note: `{fname}` was previously read this session at lines {cached_summary}{extra}. "
            f"Your current request (lines {req_start}-{req_end}) overlaps by {overlap_lines} lines "
            f"(~{wasted} wasted tokens). "
            f"Consider using `offset={suggested_offset}` to skip the overlap."
        )

    # Non-overlapping prior read — mild informational note only.
    return (
        f"FYI: `{fname}` was read earlier this session at lines {cached_summary}{extra}. "
        f"Current request (lines {req_start}-{req_end}) is new content — proceeding."
    )


def _hint_from_index(
    file_path: str,
    cwd: str | None,
    req_start: int,
    req_end: int,
) -> str | None:
    """Build hint when file is large and has indexed symbols but not yet cached."""
    if cwd is None:
        return None

    project = find_project(Path(cwd))
    if project is None:
        return None

    abs_path = Path(file_path)
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()

    n_lines = _line_count(abs_path)
    if n_lines is None or n_lines < LARGE_FILE_LINE_THRESHOLD:
        return None

    # Compute relative path for DB lookup.
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return None

    symbols = _get_indexed_symbols(rel, project.hash)
    if not symbols:
        return None

    full_tokens = _est_tokens_from_lines(n_lines)

    # Build a readable symbol list (up to 8 entries).
    sym_strs: list[str] = []
    for sym in symbols[:8]:
        kind = sym.get("kind") or "?"
        name = sym.get("name") or "?"
        line = sym.get("line") or 0
        end = sym.get("end_line") or line
        approx_tokens = _est_tokens_from_lines(max(1, end - line + 1))
        sym_strs.append(f"`{name}` ({kind}, line {line}, ~{approx_tokens}t)")

    n_total = len(symbols)
    more_note = f", plus {n_total - 8} more" if n_total > 8 else ""
    first_sym_name = symbols[0].get("name", "")

    return (
        f"This file is {n_lines} lines (~{full_tokens} tokens to read fully). "
        f"cc-saver has indexed {n_total} symbol(s) here. "
        f"To read just one symbol, run: `cc-saver read \"{rel}::{first_sym_name}\"` "
        f"(saves ~85% tokens). "
        f"Top symbols: {', '.join(sym_strs)}{more_note}. "
        f"Proceed with full Read if you need the surrounding context."
    )
