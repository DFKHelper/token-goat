"""Builds informational hints for PreToolUse on Read."""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import TypedDict

from . import db, session
from .project import find_project

_LOG = logging.getLogger("token_goat.hints")


class _SymbolRow(TypedDict):
    """Shape of one row returned by the symbols SELECT in _get_indexed_symbols_and_line_count."""

    kind: str
    name: str
    line: int
    end_line: int

# Token estimator: ~3.5 chars/token, ~60 chars/line code → ~17 tokens/line average
CHARS_PER_TOKEN = 3.5
AVG_CHARS_PER_LINE = 60
TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN  # ≈17.1

# Thresholds
LARGE_FILE_LINE_THRESHOLD = 500
MIN_OVERLAP_TO_WARN = 50  # only warn about overlap if >50 lines overlap
DEFAULT_READ_LIMIT = 2000  # Claude Code's default lines-per-Read

# How many bytes to assume per line when estimating line count from file size.
# This is intentionally conservative (real code averages 30-50 bytes/line) so
# we slightly overestimate the line count rather than underestimate it.
_BYTES_PER_LINE_ESTIMATE = 75

# Maximum number of indexed symbols to fetch per file in one DB query.
# Enough to fill a useful hint; the full list is available via `token-goat symbol`.
_MAX_INDEXED_SYMBOLS_FETCHED = 50


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
        """Construct a ReadHint string with an attached *tokens_saved* annotation.

        ``str.__new__`` requires the string value to be passed at construction
        time; ``tokens_saved`` is attached as a plain attribute afterwards.
        """
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
) -> tuple[list[_SymbolRow], int | None, bool]:
    """Return symbols AND actual or estimated line count in one query.

    Returns a third flag indicating whether the returned line count is exact
    (read from the ``line_count`` column) or estimated from file size.

    The two-step SELECT handles older DB schemas that pre-date the ``line_count``
    column: first try the full query; if ``line_count`` is missing, fall back to
    ``size``-only and mark the schema as lacking the column.
    """
    try:
        with db.open_project(project_hash) as conn:
            # Fetch file metadata and symbols in one round-trip.
            # db_has_line_count_column tracks whether the schema supports line_count.
            try:
                file_row = conn.execute(
                    "SELECT size, line_count FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                db_has_line_count_column = True
            except sqlite3.OperationalError as exc:
                if "line_count" not in str(exc).lower():
                    raise
                file_row = conn.execute(
                    "SELECT size FROM files WHERE rel_path = ?",
                    (file_rel,),
                ).fetchone()
                db_has_line_count_column = False

            sym_rows = conn.execute(
                f"""
                SELECT kind, name, line, end_line
                FROM symbols
                WHERE file_rel = ? AND name IS NOT NULL
                ORDER BY line
                LIMIT {_MAX_INDEXED_SYMBOLS_FETCHED}
                """,
                (file_rel,),
            ).fetchall()

            # Resolve line count: prefer the stored exact value; fall back to a
            # size-based estimate when the column is absent or NULL.
            if file_row:
                if db_has_line_count_column and file_row["line_count"] is not None:
                    n_lines = int(file_row["line_count"])
                    line_count_is_exact = True
                else:
                    size = file_row["size"]
                    n_lines = max(1, size // _BYTES_PER_LINE_ESTIMATE)
                    line_count_is_exact = False
            else:
                n_lines = None
                line_count_is_exact = False

            sym_dicts: list[_SymbolRow] = [
                _SymbolRow(
                    kind=str(r["kind"]),
                    name=str(r["name"]),
                    line=int(r["line"]),
                    end_line=int(r["end_line"]),
                )
                for r in sym_rows
            ]
            return sym_dicts, n_lines, line_count_is_exact
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
        _LOG.debug("build_read_hint: skipped (session_id=%r, file_path=%r)", session_id, file_path)
        return None

    # Requested line range (1-indexed inclusive).
    safe_offset = max(0, int(offset)) if offset is not None else 0
    safe_limit = max(0, int(limit)) if limit is not None else 0
    req_start = safe_offset + 1
    req_end = req_start + (safe_limit or DEFAULT_READ_LIMIT) - 1

    # Compute fname once; it is used in multiple debug log calls below and
    # forwarded to _hint_from_cache / _hint_from_index which also need it.
    fname = Path(file_path).name

    # 1. Check session cache first.
    entry = session.get_file_entry(session_id, file_path, cache=cache)
    if entry is not None:
        hint = _hint_from_cache(entry, req_start, req_end, file_path, fname=fname)
        if hint is not None:
            _LOG.debug(
                "build_read_hint: cache hint for %s lines %d-%d (tokens_saved=%d)",
                fname, req_start, req_end, hint.tokens_saved,
            )
        else:
            _LOG.debug("build_read_hint: no hint (non-overlapping prior read of %s)", fname)
        return hint

    # 2. Not cached — consider "large file with indexed symbols" suggestion.
    hint = _hint_from_index(file_path, cwd, req_start, req_end, fname=fname)
    if hint is not None:
        _LOG.debug("build_read_hint: index hint for %s (large file suggestion)", fname)
    else:
        _LOG.debug("build_read_hint: no hint for %s (not in session cache, not large/indexed)", fname)
    return hint


# ---------------------------------------------------------------------------
# Hint builders
# ---------------------------------------------------------------------------


def _hint_from_cache(
    entry: session.FileEntry,
    req_start: int,
    req_end: int,
    file_path: str,
    *,
    fname: str | None = None,
) -> ReadHint | None:
    """Build hint when the file was already accessed this session."""
    # Accept pre-computed fname from build_read_hint to avoid a redundant
    # Path allocation on the hot pre-read path (one Path per hook call saved).
    if fname is None:
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

    # Compute overlap against all cached ranges in a single pass.
    # Also track last_cached_end here to avoid a second generator scan later.
    overlap_lines = 0
    exact_match = False
    last_cached_end = 0
    for cached_start, cached_end in entry.line_ranges:
        overlap_start = max(cached_start, req_start)
        overlap_end = min(cached_end, req_end)
        if overlap_end >= overlap_start:
            overlap_lines += overlap_end - overlap_start + 1
        if cached_start <= req_start and cached_end >= req_end:
            exact_match = True
        if cached_end > last_cached_end:
            last_cached_end = cached_end

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
        # last_cached_end was already computed above during the overlap scan.
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


def _confirmed_line_count(
    estimated_lines: int,
    line_count_is_exact: bool,
    abs_path: Path,
) -> int | None:
    """Return a confirmed line count at or above the large-file threshold, or None.

    When the DB already stores an exact count, use it directly.  When the count
    is only an estimate (size-based), verify against the real file: estimates
    can be low enough to suppress hints for genuinely large files.  Returns None
    when the file is clearly below the threshold and no hint is warranted.
    """
    if line_count_is_exact:
        return estimated_lines if estimated_lines >= LARGE_FILE_LINE_THRESHOLD else None
    # Estimate is below threshold — check the real file before suppressing the hint.
    if estimated_lines < LARGE_FILE_LINE_THRESHOLD:
        actual = _line_count(abs_path)
        if actual is None or actual < LARGE_FILE_LINE_THRESHOLD:
            return None
        return actual
    # Estimate is at or above threshold — trust it without a disk read.
    return estimated_lines


def _hint_from_index(
    file_path: str,
    cwd: str | None,
    req_start: int,
    req_end: int,
    *,
    fname: str | None = None,
) -> ReadHint | None:
    """Build hint when file is large and has indexed symbols but not yet cached."""
    # Accept a pre-computed fname to avoid a redundant Path allocation on the
    # hot pre-read path; fall back to computing it here for direct callers.
    if fname is None:
        fname = Path(file_path).name
    if cwd is None:
        _LOG.debug("_hint_from_index: skipped for %s (no cwd)", fname)
        return None

    project = find_project(Path(cwd))
    if project is None:
        _LOG.debug("_hint_from_index: skipped for %s (no project found in %s)", fname, cwd)
        return None

    abs_path = Path(file_path)
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()

    # Compute relative path for DB lookup.
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        _LOG.debug("_hint_from_index: %s not under project root %s", file_path, project.root)
        return None

    symbols, estimated_lines, line_count_is_exact = _get_indexed_symbols_and_line_count(
        rel, project.hash
    )
    if estimated_lines is None:
        _LOG.debug("_hint_from_index: %s not in project index (no file row)", fname)
        return None
    if not symbols:
        _LOG.info(
            "_hint_from_index: %s is in the index but has no symbols "
            "(estimated %s lines, project=%s) — no surgical-read hint possible",
            rel,
            estimated_lines,
            project.hash[:8],
        )
        return None

    n_lines = _confirmed_line_count(estimated_lines, line_count_is_exact, abs_path)
    if n_lines is None:
        _LOG.debug("_hint_from_index: %s below large-file threshold (estimated=%s)", fname, estimated_lines)
        return None

    full_tokens = _est_tokens_from_lines(n_lines)
    n_total = len(symbols)
    first_sym_name = symbols[0]["name"]

    # A *suggestion*, not a realized saving. tokens_saved=0: if the agent acts
    # on it, `token-goat read` records the real `read_replacement` stat — counting
    # a saving here too would double-count, and counting one when the agent
    # ignores the hint and reads the whole file is pure phantom inflation.
    #
    # Kept deliberately terse: the hint text itself costs tokens in the
    # conversation, so it carries one example command rather than enumerating
    # every indexed symbol (`token-goat symbol`/`map` cover that on demand).
    return ReadHint(
        f"`{fname}` is {n_lines} lines (~{full_tokens} tokens to read fully). "
        f"token-goat has {n_total} symbol(s) indexed here — e.g. "
        f"`token-goat read \"{rel}::{first_sym_name}\"` extracts just one (~85% fewer tokens). "
        f"Use a full Read if you need the surrounding context.",
        0,
    )
