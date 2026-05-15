"""Builds informational hints for PreToolUse on Read."""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from . import db, session
from .project import find_project

_LOG = logging.getLogger("token_goat.hints")

# Token estimator: ~3.5 chars/token, ~60 chars/line code → ~17 tokens/line average
CHARS_PER_TOKEN = 3.5
AVG_CHARS_PER_LINE = 60
TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN  # ≈17.1

# Thresholds
LARGE_FILE_LINE_THRESHOLD = 500
MIN_OVERLAP_TO_WARN = 50  # only warn about overlap if >50 lines overlap
DEFAULT_READ_LIMIT = 2000  # Claude Code's default lines-per-Read


class ReadHint(str):
    """A pre-read hint string carrying the genuine token saving it represents.

    Subclasses ``str`` so every existing consumer (substring checks, JSON
    serialization as ``additionalContext``) keeps working unchanged, while
    ``tokens_saved`` rides along for honest stats accounting.

    ``tokens_saved`` is **0** for *suggestion* hints — "this file is large, you
    could use ``token-goat read``" — because firing the suggestion realizes no
    saving; if the agent acts on it, ``token-goat read`` records the real
    ``read_replacement`` stat itself. It is non-zero only for dedup hints that
    warn about re-reading content already in the session: a concrete, already-
    realized avoided cost.
    """

    tokens_saved: int

    def __new__(cls, text: str, tokens_saved: int = 0) -> ReadHint:
        obj = super().__new__(cls, text)
        obj.tokens_saved = tokens_saved
        return obj


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


def _get_indexed_symbols_and_line_count(
    file_rel: str, project_hash: str
) -> tuple[list[dict], int | None, bool]:
    """Return symbols AND actual or estimated line count in one query.

    Returns a third flag indicating whether the line count is exact (stored in
    the files table) versus an estimate derived from file size.
    """
    try:
        with db.open_project(project_hash) as conn:
            # Fetch file metadata and symbols in one round-trip
            try:
                file_row = conn.execute(
                    "SELECT size, line_count FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                has_exact_line_count = True
            except sqlite3.OperationalError as exc:
                if "line_count" not in str(exc).lower():
                    raise
                file_row = conn.execute(
                    "SELECT size FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                has_exact_line_count = False

            sym_rows = conn.execute(
                """
                SELECT kind, name, line, end_line
                FROM symbols
                WHERE file_rel = ? AND name IS NOT NULL
                ORDER BY line
                LIMIT 50
                """,
                (file_rel,),
            ).fetchall()

            # If DB has file metadata, estimate lines from file size.
            # Rough estimate: 50-100 bytes per line for code.
            if file_row:
                if has_exact_line_count and file_row["line_count"] is not None:
                    n_lines = int(file_row["line_count"])
                    exact_line_count = True
                else:
                    size = file_row["size"]
                    n_lines = max(1, size // 75)  # conservative estimate
                    exact_line_count = False
            else:
                n_lines = None
                exact_line_count = False

            return [dict(r) for r in sym_rows], n_lines, exact_line_count
    except Exception:  # noqa: BLE001
        _LOG.exception("failed to load indexed symbols for %s", file_rel)
        return [], None, False


def build_read_hint(
    *,
    session_id: str | None,
    file_path: str,
    offset: int | None,
    limit: int | None,
    cwd: str | None,
    cache: session.SessionCache | None = None,
) -> ReadHint | None:
    """Return a ReadHint, or None when no hint is warranted."""
    if not session_id or not file_path:
        return None

    # Requested line range (1-indexed inclusive).
    req_start = (offset or 0) + 1
    req_end = req_start + (limit or DEFAULT_READ_LIMIT) - 1

    # 1. Check session cache first.
    entry = session.get_file_entry(session_id, file_path, cache=cache)
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
) -> ReadHint | None:
    """Build hint when the file was already accessed this session."""
    fname = Path(file_path).name

    # Case: file accessed only via token-goat read <file>::<symbol>.
    # A suggestion, not a realized saving → tokens_saved=0.
    if entry.symbols_read and not entry.line_ranges:
        sym_list = ", ".join(f"`{s}`" for s in entry.symbols_read[:3])
        more = f" and {len(entry.symbols_read) - 3} more" if len(entry.symbols_read) > 3 else ""
        return ReadHint(
            f"Note: `{fname}` was already accessed this session via "
            f"`token-goat read` for symbol(s): {sym_list}{more}. "
            f"If you only need additional symbols, consider "
            f"`token-goat read \"{file_path}::another_symbol\"` "
            f"instead of reading the whole file.",
            0,
        )

    # Compute overlap against all cached ranges.
    overlap_lines = 0
    exact_match = False
    for cached_start, cached_end in entry.line_ranges:
        overlap_start = max(cached_start, req_start)
        overlap_end = min(cached_end, req_end)
        if overlap_end >= overlap_start:
            overlap_lines += overlap_end - overlap_start + 1
        if cached_start <= req_start and cached_end >= req_end:
            exact_match = True

    cached_summary = ", ".join(f"{s}-{e}" for s, e in entry.line_ranges[:3])
    extra = f" (+{len(entry.line_ranges) - 3} more ranges)" if len(entry.line_ranges) > 3 else ""

    # Exact re-read of already-cached lines — the full request is avoidable.
    if exact_match:
        wasted = _est_tokens_from_lines(req_end - req_start + 1)
        return ReadHint(
            f"Note: `{fname}` lines {req_start}-{req_end} were already read this session "
            f"(cached ranges: {cached_summary}{extra}). "
            f"Re-reading wastes ~{wasted} tokens. "
            f"Consider whether your existing context is sufficient, or use a different "
            f"offset/limit to read only new content.",
            wasted,
        )

    # Partial overlap — only the overlapping lines are avoidable.
    if overlap_lines > MIN_OVERLAP_TO_WARN:
        wasted = _est_tokens_from_lines(overlap_lines)
        # Suggest starting the next Read just past the last cached line.
        # The Read tool's `offset` is 0-indexed (lines skipped before reading),
        # so passing `last_cached_end` as offset resumes at line last_cached_end+1.
        last_cached_end = max(e for _, e in entry.line_ranges)
        resume_offset = last_cached_end
        return ReadHint(
            f"Note: `{fname}` was previously read this session at lines {cached_summary}{extra}. "
            f"Your current request (lines {req_start}-{req_end}) overlaps by {overlap_lines} lines "
            f"(~{wasted} wasted tokens). "
            f"Consider using `offset={resume_offset}` to skip the overlap.",
            wasted,
        )

    # Non-overlapping prior read — there is nothing actionable to say: the
    # agent is reading genuinely new content and the file is not necessarily
    # large. An "FYI, proceeding" note would cost tokens in the conversation
    # for zero benefit, so suppress it entirely rather than inject noise.
    return None


def _hint_from_index(
    file_path: str,
    cwd: str | None,
    req_start: int,
    req_end: int,
) -> ReadHint | None:
    """Build hint when file is large and has indexed symbols but not yet cached."""
    if cwd is None:
        return None

    project = find_project(Path(cwd))
    if project is None:
        return None

    abs_path = Path(file_path)
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()

    # Compute relative path for DB lookup.
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return None

    # Fetch symbols; line count comes from file if DB estimate is unreliable
    symbols, estimated_lines, exact_line_count = _get_indexed_symbols_and_line_count(
        rel, project.hash
    )
    if not symbols:
        return None

    # Use estimated line count from DB if available; fall back to actual read
    n_lines = estimated_lines
    if n_lines is None:
        return None
    if exact_line_count:
        if n_lines < LARGE_FILE_LINE_THRESHOLD:
            return None
    elif n_lines < LARGE_FILE_LINE_THRESHOLD:
        n_lines = _line_count(abs_path)
        if n_lines is None or n_lines < LARGE_FILE_LINE_THRESHOLD:
            return None

    full_tokens = _est_tokens_from_lines(n_lines)
    n_total = len(symbols)
    first_sym_name = symbols[0].get("name", "")

    # A *suggestion*, not a realized saving. tokens_saved=0: if the agent acts
    # on it, `token-goat read` records the real `read_replacement` stat — counting
    # a saving here too would double-count, and counting one when the agent
    # ignores the hint and reads the whole file is pure phantom inflation.
    #
    # Kept deliberately terse: the hint text itself costs tokens in the
    # conversation, so it carries one example command rather than enumerating
    # every indexed symbol (`token-goat symbol`/`map` cover that on demand).
    return ReadHint(
        f"`{Path(file_path).name}` is {n_lines} lines (~{full_tokens} tokens to read fully). "
        f"token-goat has {n_total} symbol(s) indexed here — e.g. "
        f"`token-goat read \"{rel}::{first_sym_name}\"` extracts just one (~85% fewer tokens). "
        f"Use a full Read if you need the surrounding context.",
        0,
    )
