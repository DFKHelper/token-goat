"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import contextlib
import difflib
import hashlib
import json
import sqlite3
import sys
from collections import defaultdict, deque
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, TypedDict

import typer

from . import db, hints, read_replacement, session
from .project import Project, find_project
from .util import get_logger

_LOG = get_logger("read_commands")

#: Optional ``--session-id`` / ``-s`` Typer option — mirrors the definition in
#: ``cli.py``.  Defined here to avoid a circular import (``cli`` lazily imports
#: ``read_commands``; a top-level ``from .cli import _OPT_SESSION_ID`` would
#: form a cycle at load time).
_OPT_SESSION_ID: str | None = typer.Option(None, "--session-id", "-s")  # noqa: B008

# Module-level key functions avoid allocating a new lambda object on every sort call.
# Sorting dep maps is on the hot path when rendering large dependency graphs.
def _key_dep_by_size(item: tuple[str, set[str]]) -> tuple[int, str]:
    """Sort dependency items by descending symbol count, then name."""
    return (-len(item[1]), item[0])


def _key_transitive_by_depth(item: tuple[str, _DepNode]) -> tuple[int, str]:
    """Sort transitive dependency items by depth, then name."""
    return (item[1]["depth"], item[0])

# Precise type alias for the ``reader`` parameter of :func:`_run_read_like_command`.
# ``Callable[..., X]`` accepts any argument shape (including keyword-only
# ``context_lines``) while still constraining the return to a known union.
# Both :func:`~read_replacement.read_symbol` (returns ``SymbolResult | None``)
# and :func:`~read_replacement.read_section` (returns ``SectionResult | None``)
# satisfy this alias because their return types are subtypes of the union.
_ReaderCallable = Callable[
    ...,
    read_replacement.SymbolResult | read_replacement.SectionResult | None,
]


class _DepNode(TypedDict):
    """One node in the transitive dependency BFS result.

    Produced by :func:`_collect_transitive_outgoing` and consumed by
    :func:`deps` for both JSON serialisation and text rendering.
    """

    depth: int
    via: str
    symbols: set[str]


def _not_indexed_hint(project_hash: str) -> str | None:
    """Return a one-line hint when this project has no indexed files.

    Distinguishes three cases:
    - Indexing currently in progress: return "indexing in progress" hint.
    - Indexing previously spawned but PID is gone: return "may have failed" hint.
    - Indexing never started: return generic "not yet indexed" hint.
    """
    try:
        if not db.project_has_files(project_hash):
            # Check if an index spawn is currently active.
            from . import paths, worker  # noqa: PLC0415

            marker = paths.locks_dir() / f"{project_hash}.indexing"
            if worker._index_spawn_active(marker):
                return (
                    "(indexing is currently in progress — try again in a moment, "
                    "or run `token-goat index --full` to force synchronous indexing.)"
                )

            # Check if marker exists but process is gone (may have failed).
            if marker.exists():
                return (
                    "(a previous indexing attempt may have failed — "
                    "run `token-goat index --full` to retry, or check the logs.)"
                )

            # Marker does not exist — auto-index was never spawned or already cleared.
            return (
                "(project not yet indexed. auto-indexing started in the "
                "background on first SessionStart; if it has not finished, "
                "rerun in a moment, or run `token-goat index --full` to force "
                "synchronous indexing.)"
            )
    except (FileNotFoundError, OSError, sqlite3.Error) as exc:
        _LOG.warning("failed to check project index status: %s", exc)
        return (
            "(unable to check whether this project is indexed right now; "
            "run `token-goat index --full` again or check the logs.)"
        )
    return None


# Maximum bytes hashed when computing a file-content SHA for the in-session
# result cache.  Mirrors the 2 MB cap enforced by read_replacement._MAX_READ_BYTES
# so the SHA is computed over exactly the contents that read_symbol/read_section
# would extract from.  A file larger than this is skipped by the readers anyway,
# so we never need to hash beyond the cap.
_SHA_MAX_BYTES = 2_000_000


def _file_sha1(abs_path: Path) -> str:
    """Return the hex SHA-1 of the file's contents, or empty string on any I/O error.

    Used as a cheap invalidation token for the in-session result cache: when
    the SHA differs from the one stored at cache-write time, the cached slice
    is treated as stale and recomputed.  An empty string is returned on
    ``OSError`` so a missing or unreadable file simply skips the cache rather
    than crashing the read path.

    The SHA is computed over up to ``_SHA_MAX_BYTES`` (2 MB) — files larger than
    that are rejected by the readers anyway, so hashing past the cap would
    waste I/O.  SHA-1 is used because we only need collision resistance against
    accidental same-length edits, not cryptographic strength; SHA-1 is roughly
    2× faster than SHA-256 on the typical 5–50 KB source file.
    """
    try:
        with abs_path.open("rb") as fh:
            data = fh.read(_SHA_MAX_BYTES)
    except OSError as exc:
        _LOG.debug("_file_sha1: cannot read %s: %s", abs_path, exc)
        return ""
    return hashlib.sha1(data, usedforsecurity=False).hexdigest()


# Max number of "did you mean…?" suggestions to surface on a missed lookup.
# Capped at 3: a top-3 spelling-similarity list covers the typo case without
# burning ~50-100 tokens of "is it any of these?" noise per miss. Difflib's
# default ceiling is 5, but in practice the 4th and 5th candidates are almost
# always weaker and rarely chosen by the agent.
_DIDYOUMEAN_LIMIT = 3
# difflib similarity cutoff. 0.6 is difflib's default; lowering would surface
# more candidates but also more noise. The aim is to cover near-typos and
# case mismatches, not arbitrary substring containment.
_DIDYOUMEAN_CUTOFF = 0.6


def _close_db_matches(
    project: Project,
    rel_path: str,
    query_term: str,
    *,
    table: str,
    column: str,
    kind: str,
) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` values from ``column`` in ``table``
    that are close lexical matches for ``query_term``.

    Shared implementation used by :func:`_close_symbol_matches` and
    :func:`_close_section_matches`. ``kind`` is only used in the debug log
    message to identify which lookup produced the error.

    Returns an empty list on any DB error so the caller's miss message still emits.
    """
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                f"SELECT DISTINCT {column} FROM {table}"  # noqa: S608
                f" WHERE file_rel = ? AND {column} IS NOT NULL",
                (rel_path,),
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError, FileNotFoundError) as exc:
        _LOG.debug("close-match query failed for %s in %s: %s", kind, rel_path, exc)
        return []
    candidates = [r[column] for r in rows if r[column]]
    return difflib.get_close_matches(query_term, candidates, n=_DIDYOUMEAN_LIMIT, cutoff=_DIDYOUMEAN_CUTOFF)


def _close_symbol_matches(project: Project, rel_path: str, symbol: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` symbol names from ``rel_path`` that are
    close lexical matches for ``symbol``.

    Used to produce "did you mean…?" suggestions when ``token-goat read`` fails
    to find a symbol in an otherwise-resolved file. Returning even one good
    candidate keeps the agent on the surgical-read path instead of falling
    back to ``Read full-file``.

    Returns an empty list on any DB error so the miss message still emits.
    """
    return _close_db_matches(project, rel_path, symbol, table="symbols", column="name", kind="symbol")


def _close_section_matches(project: Project, rel_path: str, heading: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` section headings from ``rel_path``
    that are close lexical matches for ``heading``.

    The mirror of :func:`_close_symbol_matches` for ``token-goat section``.
    Returns an empty list on any DB error.
    """
    return _close_db_matches(project, rel_path, heading, table="sections", column="heading", kind="section")


def _emit_read_error(
    *,
    code: str,
    message: str,
    json_output: bool,
    candidates: Sequence[str] = (),
    **details: object,
) -> None:
    """Emit a structured read error in either text or JSON form.

    In JSON mode, outputs {"ok": False, "error": {...}} with code, message, and optional
    candidates/details. In text mode, outputs the message to stderr with candidates indented below.
    """
    if json_output:
        error: dict[str, object] = {"code": code, "message": message}
        if candidates:
            error["candidates"] = list(candidates)
        error.update(details)
        typer.echo(json.dumps({"ok": False, "error": error}, separators=(",", ":")))
        return

    typer.echo(message, err=True)
    for candidate in candidates:
        typer.echo(f"  - {candidate}", err=True)


def _emit_ambiguous_file_match(file_part: str, candidates: Sequence[str], *, json_output: bool) -> None:
    """Emit a structured error when a file name matches multiple indexed paths.

    Delegates to _emit_read_error with code='ambiguous_file' and includes all
    candidate paths so the user can disambiguate with a more specific path pattern.
    """
    _emit_read_error(
        code="ambiguous_file",
        message=f"Ambiguous file match: {file_part}",
        candidates=candidates,
        json_output=json_output,
        file_part=file_part,
    )


def _emit_file_not_found_error(
    file_part: str,
    current_proj: Project | None,
    *,
    json_output: bool,
) -> None:
    """Emit a structured error when file resolution returns no match.

    Distinguishes three cases:
    - No project detected at all (``current_proj is None``).
    - Project detected but not yet indexed (``_not_indexed_hint`` returns a hint).
    - Project indexed but the file pattern matched nothing.

    Extracted from the identical ``if rel is None`` blocks in
    :func:`_run_read_like_command` and :func:`deps`.
    """
    if current_proj is None:
        _emit_read_error(
            code="no_project",
            message="No project detected.",
            json_output=json_output,
            file_part=file_part,
        )
    else:
        hint = _not_indexed_hint(current_proj.hash)
        _emit_read_error(
            code="project_not_indexed" if hint else "file_not_found",
            message=hint if hint else f"File not found in any indexed project: {file_part}",
            json_output=json_output,
            file_part=file_part,
            project_hash=current_proj.hash,
        )


def _collect_dependency_graph(
    conn: sqlite3.Connection,
    rel_path: str,
) -> tuple[dict[str, set[str]], dict[str, set[str]], list[str]]:
    """Return file-level dependency edges and unresolved refs for the given file.

    Returns (outgoing, incoming, unresolved_refs):
      - outgoing: files this file depends on, mapped to referenced symbol names
      - incoming: files that depend on this file, mapped to symbol names they use
      - unresolved_refs: ref names in this file that match no indexed symbol
    """
    outgoing: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        """,
        (rel_path,),
    ).fetchall():
        outgoing[row["file_rel"]].add(row["symbol_name"])

    incoming: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT r.file_rel, s.name AS symbol_name
          FROM symbols s
          JOIN refs r ON r.symbol_name = s.name AND r.file_rel != s.file_rel
         WHERE s.file_rel = ?
        """,
        (rel_path,),
    ).fetchall():
        incoming[row["file_rel"]].add(row["symbol_name"])

    unresolved: list[str] = [
        row["symbol_name"]
        for row in conn.execute(
            """
            SELECT DISTINCT r.symbol_name
              FROM refs r
              LEFT JOIN symbols s ON s.name = r.symbol_name
             WHERE r.file_rel = ?
               AND r.symbol_name != ''
               AND s.name IS NULL
             ORDER BY r.symbol_name
            """,
            (rel_path,),
        ).fetchall()
    ]

    return outgoing, incoming, unresolved


def _collect_outgoing_edges(conn: sqlite3.Connection, rel_path: str) -> dict[str, set[str]]:
    """Return only the outgoing file-level edges for rel_path (no incoming, no unresolved)."""
    outgoing: dict[str, set[str]] = defaultdict(set)
    for row in conn.execute(
        """
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        """,
        (rel_path,),
    ).fetchall():
        outgoing[row["file_rel"]].add(row["symbol_name"])
    return outgoing


def _collect_transitive_outgoing(
    conn: sqlite3.Connection,
    start_rel: str,
    max_depth: int,
) -> dict[str, _DepNode]:
    """BFS over outgoing dependency edges up to max_depth levels.

    Computes transitive dependencies: all files that start_rel depends on,
    directly or indirectly, up to the specified depth limit. Uses breadth-first
    search to discover dependencies in order of distance from the root.

    Args:
        conn: Database connection to query symbol references and definitions.
        start_rel: Repository-relative path of the starting file (project root-relative).
        max_depth: Maximum traversal depth (0 = unlimited, 1 = direct dependencies only).

    Returns:
        Dict keyed by file_rel (dependency path) with entries:
          {"depth": int, "via": str, "symbols": set[str]}
        where:
          - depth: Distance from start_rel (1=direct dependency, 2=indirect, etc.)
          - via: Immediate parent file in the BFS tree (for path reconstruction)
          - symbols: Set of symbol names referenced from start_rel to this file
    """
    result: dict[str, _DepNode] = {}
    # Use a deque for O(1) popleft — list.pop(0) is O(n) and misreads as a stack.
    bfs_queue: deque[tuple[str, int]] = deque([(start_rel, 0)])
    visited: set[str] = {start_rel}

    while bfs_queue:
        current, depth = bfs_queue.popleft()
        next_depth = depth + 1
        if max_depth and next_depth > max_depth:
            continue
        for dep_file, symbols in _collect_outgoing_edges(conn, current).items():
            if dep_file not in visited:
                visited.add(dep_file)
                result[dep_file] = _DepNode(depth=next_depth, via=current, symbols=symbols)
                bfs_queue.append((dep_file, next_depth))
            elif dep_file in result and result[dep_file]["depth"] == next_depth:
                result[dep_file]["symbols"] |= symbols

    return result


def _edge_summary(file_count: int, edge_count: int) -> str:
    """Return a human-readable summary of file and edge counts, with correct plurals.

    Example output: '3 files, 7 edges' or '1 file, 1 edge'.
    """
    files_noun = "file" if file_count == 1 else "files"
    edges_noun = "edge" if edge_count == 1 else "edges"
    return f"{file_count} {files_noun}, {edge_count} {edges_noun}"


def _format_dependency_line(file_rel: str, symbols: set[str]) -> str:
    """Format a dependency entry showing a file and symbols referenced from it.

    Produces indented, comma-separated output for human readability in CLI output.
    Example: "  - path/to/file.py (2 symbols: funcA, funcB)"

    Args:
        file_rel: Repository-relative path of the dependency file.
        symbols: Set of symbol names (functions, classes, etc.) referenced from the file.

    Returns:
        Indented text line with file path and symbol count/list, or just file path
        if no symbols are provided.
    """
    symbol_list = ", ".join(sorted(symbols))
    count = len(symbols)
    noun = "symbol" if count == 1 else "symbols"
    if symbol_list:
        return f"  - {file_rel} ({count} {noun}: {symbol_list})"
    return f"  - {file_rel} ({count} {noun})"


class _FileTarget(NamedTuple):
    """Result of resolving a file-name pattern to a concrete project-relative path.

    Attributes:
        project: The project that owns the resolved file, or ``None`` if not found.
        rel_path: Project-relative path of the resolved file, or ``None`` if not found.
        current_project: The project rooted at the shell's cwd (may differ from
            ``project`` when the cross-project fallback matched a foreign project).
            Callers compare ``project != current_project`` to detect cross-project hits
            and emit an appropriate hint.
    """

    project: Project | None
    rel_path: str | None
    current_project: Project | None


def _resolve_file_target(file_part: str) -> _FileTarget:
    """Resolve a file name pattern to a concrete project-relative path.

    First attempts resolution in the current project; if not found, searches across
    all indexed projects via the cross-project fallback so that ``token-goat read``
    and ``token-goat section`` can reach files in ~/.claude/skills/ or other
    marker-free directories indexed with ``token-goat index --root``, regardless
    of which project the shell's cwd belongs to.
    """
    proj = find_project(Path.cwd())
    if proj is not None:
        rel = read_replacement.resolve_file_rel(proj, file_part)
        if rel is not None:
            _LOG.debug("resolved %r -> %s (current project %s)", file_part, rel, proj.hash[:8])
            return _FileTarget(project=proj, rel_path=rel, current_project=proj)
        _LOG.debug("file %r not found in current project %s; trying cross-project fallback", file_part, proj.hash[:8])
    else:
        _LOG.debug("no current project detected for cwd; trying cross-project fallback for %r", file_part)

    cross = read_replacement.find_in_all_projects(file_part)
    if cross is not None:
        _LOG.info("cross-project fallback: resolved %r -> %s (project %s)", file_part, cross[1], cross[0].hash[:8])
        return _FileTarget(project=cross[0], rel_path=cross[1], current_project=proj)
    _LOG.debug("file %r not found in any indexed project", file_part)
    return _FileTarget(project=None, rel_path=None, current_project=proj)


# ANSI escape for dim/faint text — used to visually distinguish context lines from
# the core symbol body on TTY output.  The reset code (\x1b[0m) restores normal
# rendering after each context line so subsequent lines are unaffected.
_ANSI_DIM = "\x1b[2m"
_ANSI_RESET = "\x1b[0m"


def _apply_context_gutter(
    text: str,
    context_before: int,
    context_after: int,
    *,
    no_color: bool,
) -> str:
    """Return *text* with context lines visually distinguished from the core body.

    On TTY with color enabled, context lines get a dim ``│ `` gutter prefix so the
    core symbol body stands out.  With ``no_color=True`` (or piped output) the text
    is returned unchanged.

    *context_before* and *context_after* are the number of leading/trailing lines
    that are context (not part of the core symbol).  When both are zero the input
    is returned as-is.
    """
    if no_color or (context_before == 0 and context_after == 0):
        return text
    lines = text.split("\n")
    total = len(lines)
    result: list[str] = []
    for i, line in enumerate(lines):
        is_context = i < context_before or i >= total - context_after
        if is_context:
            result.append(f"{_ANSI_DIM}│ {line}{_ANSI_RESET}")
        else:
            result.append(f"  {line}")
    return "\n".join(result)


def _emit_text_result(
    text: str,
    rel_path: str,
    item: str,
    separator_label: str,
    no_header: bool,
    *,
    context_before: int = 0,
    context_after: int = 0,
    no_color: bool = False,
) -> None:
    """Emit *text* to stdout, optionally prefixed with a ``## …`` header (Item 15).

    The header ``## {rel_path} — {separator_label}: {item}`` is emitted when:
    - ``no_header`` is False, AND
    - stdout is a TTY (interactive terminal).

    In agent / pipe / capture contexts (``isatty() == False``) the header is
    suppressed by default so callers do not pay ~10 tokens per surgical read.
    Pass ``--header`` (``no_header=False`` with explicit override) or redirect
    to a TTY to restore it; pass ``--no-header`` to force suppression.

    When *context_before* or *context_after* is non-zero and stdout is a TTY
    (and ``no_color`` is False), context lines are rendered with a dim ``│ ``
    gutter prefix so the core symbol body stands out visually.

    A token estimate comment (``# {N} lines ({approx_tokens} tokens est.)``) is
    always prepended to the output so the agent can budget its context before
    reading.
    """
    token_header = read_replacement.token_estimate_header(text)
    if not no_header and sys.stdout.isatty():
        typer.echo(f"## {rel_path} — {separator_label}: {item}")
    typer.echo(token_header)
    is_tty = sys.stdout.isatty()
    apply_color = is_tty and not no_color
    display_text = _apply_context_gutter(text, context_before, context_after, no_color=not apply_color)
    typer.echo(display_text)


def _context_bounds(result: read_replacement.SymbolResult | read_replacement.SectionResult | dict) -> tuple[int, int]:
    """Return (context_before, context_after) line counts from a read result dict.

    Uses ``start_line``/``end_line`` (expanded by context) vs ``core_start_line``/
    ``core_end_line`` (the raw symbol/section bounds before context expansion).
    Falls back to (0, 0) when the core fields are absent (e.g. LineRangeResult or
    a cached result from an older format).
    """
    core_start = result.get("core_start_line")
    core_end = result.get("core_end_line")
    if core_start is None or core_end is None:
        return 0, 0
    start = result.get("start_line", core_start)
    end = result.get("end_line", core_end)
    before = max(0, core_start - start)
    after = max(0, end - core_end)
    return before, after


def _run_read_like_command(
    *,
    target: str,
    session_id: str | None,
    json_output: bool,
    context_lines: int,
    separator_label: str,
    missing_label: str,
    stat_kind: str,
    reader: _ReaderCallable,
    no_header: bool = False,
    no_color: bool = False,
    full: bool = False,
) -> None:
    """Unified handler for read/section/deps CLI commands.

    Parses target (format "file::item"), resolves the file, calls the reader function,
    handles errors (ambiguous file, not found, not indexed), marks the read in session
    cache, records token savings, and emits output (JSON or text).

    Args:
        target: Format "file_pattern::symbol_or_heading". Delimiter must be "::".
        session_id: Session ID for tracking in session cache (optional).
        json_output: If true, emit JSON response; else plain text.
        context_lines: Extra lines before/after the result (for read command).
        separator_label: Display label for the :: separator (e.g., "symbol", "heading").
        missing_label: Label for missing-item error (e.g., "Symbol", "Section").
        stat_kind: Stat kind to record (e.g., "read_replacement", "section_replacement").
        reader: Callable matching :class:`_ReaderCallable` — takes ``(project, rel_path,
            item, *, context_lines)`` and returns a ``SymbolResult``, ``SectionResult``,
            or ``None``.
        no_header: When True, suppress the ``## path — label: item`` header line.
            Defaults to False; auto-suppressed in non-TTY contexts (Item 15).
        no_color: When True, suppress ANSI color/dim escapes even on TTY output.
        full: When True, bypass smart truncation for long symbol bodies and return the
            complete text.  Defaults to False (truncation active for bodies > 60 lines).
    """
    if "::" not in target:
        _emit_read_error(
            code="invalid_target",
            message=f"Error: target must be '<file>::<{separator_label}>'",
            json_output=json_output,
            target=target,
        )
        raise typer.Exit(2)

    file_part, _, item_part = target.partition("::")

    try:
        file_target = _resolve_file_target(file_part)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=json_output,
            file_part=file_part,
        )
        raise typer.Exit(0) from None
    except read_replacement.AmbiguousFileMatch as exc:
        _emit_ambiguous_file_match(file_part, exc.candidates, json_output=json_output)
        raise typer.Exit(0) from None

    if file_target.rel_path is None:
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None  # guaranteed once rel_path is resolved

    # In-session result cache (per Claude session).  Cache hit on
    # (rel_path, item, kind, file_sha) avoids the DB round-trip and file read.
    # context_lines is folded into the cache key because two reads with different
    # context windows must not share a cached slice — they extract different text.
    cache_kind = "section" if separator_label == "heading" else "symbol"
    cache_item_key = f"{item_part}\x1ec={context_lines}"
    cached_result: dict | None = None
    file_sha = ""
    if session_id:
        abs_path = file_target.project.root / file_target.rel_path
        file_sha = _file_sha1(abs_path)
        if file_sha:
            cached_result = session.get_result_cache(
                session_id,
                file_target.rel_path,
                cache_item_key,
                cache_kind,
                file_sha,
            )
    if cached_result is not None and session_id:
        _LOG.debug(
            "%s cache hit: %s::%s (kind=%s)",
            stat_kind, file_target.rel_path, item_part, cache_kind,
        )
        # Still mark the read so dedup hints see this access.  No stat is recorded
        # for a cache hit — we already counted the savings on the original call.
        session.mark_file_read(session_id, file_target.rel_path, symbol=item_part)
        if json_output:
            out = {k: v for k, v in cached_result.items() if k not in _INTERNAL_RESULT_FIELDS}
            display_text = read_replacement.truncate_symbol_body(out.get("text", ""), full=full)
            out = dict(out)
            out["text"] = display_text
            typer.echo(json.dumps(out, separators=(",", ":")))
        else:
            cb, ca = _context_bounds(cached_result)
            display_text = read_replacement.truncate_symbol_body(cached_result["text"], full=full)
            _emit_text_result(
                display_text, file_target.rel_path, item_part, separator_label, no_header,
                context_before=cb, context_after=ca, no_color=no_color,
            )
        return

    result = reader(file_target.project, file_target.rel_path, item_part, context_lines=context_lines)
    if result is None:
        _label_lower = missing_label.lower()
        # Suggest close matches from the same file so the agent has an
        # immediate next step instead of falling back to a full-file Read.
        # The label tells us which table to consult: "Symbol" -> symbols,
        # "Section" -> sections.
        if _label_lower == "symbol":
            suggestions = _close_symbol_matches(file_target.project, file_target.rel_path, item_part)
        elif _label_lower == "section":
            suggestions = _close_section_matches(file_target.project, file_target.rel_path, item_part)
        else:
            suggestions = []
        base_message = f"{missing_label} not found: {item_part} (in {file_target.rel_path})"
        if suggestions and not json_output:
            base_message = base_message + "\nDid you mean:"
        # On this path the file resolved cleanly — only the symbol/heading missed.
        # ``rel_path`` is the canonical, normalized form (e.g. "src/index.ts");
        # the raw ``file_part`` ("index.ts") that triggered the lookup is already
        # echoed back in the user's command and isn't useful downstream, so we
        # omit it to save ~30-150 bytes of redundant payload per miss.
        _emit_read_error(
            code=f"{_label_lower}_not_found",
            message=base_message,
            json_output=json_output,
            candidates=suggestions,
            rel_path=file_target.rel_path,
            item=item_part,
            item_kind=_label_lower,
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, file_target.rel_path, symbol=item_part)
        # Store the freshly-computed result for future same-session lookups.
        # ``file_sha`` was computed up front above (when session_id was provided);
        # if it is empty here, the file could not be read for hashing, so we
        # skip caching rather than store an entry that would never invalidate.
        if file_sha:
            session.put_result_cache(
                session_id,
                file_target.rel_path,
                cache_item_key,
                cache_kind,
                file_sha,
                dict(result),
            )

    bytes_saved = result.get("bytes_saved", 0)
    tokens_saved = bytes_saved // 4
    _LOG.debug(
        "%s served: %s::%s bytes_saved=%d tokens_saved=%d",
        stat_kind, file_target.rel_path, item_part, bytes_saved, tokens_saved,
    )
    db.record_stat(
        file_target.project.hash,
        stat_kind,
        tokens_saved=tokens_saved,
        bytes_saved=bytes_saved,
        detail=f"{file_target.rel_path}::{item_part}",
    )

    # Apply smart truncation to the result text (no-op when full=True or body is short).
    display_text = read_replacement.truncate_symbol_body(result["text"], full=full)

    # Symbol-level stale-edit hint: warn the agent when the symbol body has changed
    # since the session's last snapshot of this file.  Only fires for symbol reads
    # (not section/line-range reads) when a session_id is provided.  Emitted to
    # stderr so it appears before the body without corrupting JSON or piped output.
    if session_id and separator_label == "symbol":
        stale_hint = hints.build_symbol_stale_hint(
            session_id=session_id,
            file_path=str(file_target.project.root / file_target.rel_path),
            symbol_name=result.get("symbol", item_part),
            current_start_line=result.get("start_line", 1),
            current_end_line=result.get("end_line", 1),
            current_text=result.get("text", ""),
        )
        if stale_hint:
            typer.echo(stale_hint, err=True)

    # Emit a cross-project attribution note when the result came from a
    # different project than the shell's cwd.  The user needs to know the
    # result is from a foreign repo so they can verify path accuracy.
    if (
        file_target.project != file_target.current_project
        and file_target.current_project is not None
    ):
        note = f"[from project: {file_target.project.root}]"
        if json_output:
            out = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
            out["_project_root"] = str(file_target.project.root)
            out["text"] = display_text
            typer.echo(json.dumps(out, separators=(",", ":")))
            return
        cb, ca = _context_bounds(result)
        typer.echo(note, err=True)
        _emit_text_result(
            display_text, file_target.rel_path, item_part, separator_label, no_header,
            context_before=cb, context_after=ca, no_color=no_color,
        )
        return

    if json_output:
        # Strip internal stat fields — model never acts on them; stats are recorded above.
        out = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
        out["text"] = display_text
        typer.echo(json.dumps(out, separators=(",", ":")))
        return
    cb, ca = _context_bounds(result)
    _emit_text_result(
        display_text, file_target.rel_path, item_part, separator_label, no_header,
        context_before=cb, context_after=ca, no_color=no_color,
    )


def deps(
    file: str,
    json_output: bool = typer.Option(False, "--json"),
    depth: int = typer.Option(1, "--depth", "-d", help="Transitive depth (1=direct, 0=unlimited)"),
) -> None:
    """Show dependency graph for file."""
    try:
        file_target = _resolve_file_target(file)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=json_output,
            file_part=file,
        )
        return

    if file_target.rel_path is None:
        _emit_file_not_found_error(file, file_target.current_project, json_output=json_output)
        return

    assert file_target.project is not None
    with db.open_project(file_target.project.hash) as conn:
        outgoing, incoming, unresolved = _collect_dependency_graph(conn, file_target.rel_path)
        transitive: dict[str, _DepNode] = {}
        if depth != 1:
            transitive = _collect_transitive_outgoing(conn, file_target.rel_path, max_depth=depth)

    outgoing_edge_count = sum(len(v) for v in outgoing.values())
    outgoing_file_count = len(outgoing)
    incoming_edge_count = sum(len(v) for v in incoming.values())
    incoming_file_count = len(incoming)
    _LOG.debug(
        "deps graph for %s: out=%d files/%d edges in=%d files/%d edges unresolved=%d transitive=%d",
        file_target.rel_path, outgoing_file_count, outgoing_edge_count,
        incoming_file_count, incoming_edge_count,
        len(unresolved), len(transitive),
    )

    if json_output:
        payload: dict[str, object] = {
            "file": file_target.rel_path,
            "depth": depth,
            "dependency_file_count": outgoing_file_count,
            "dependency_edge_count": outgoing_edge_count,
            "dependent_file_count": incoming_file_count,
            "dependent_edge_count": incoming_edge_count,
            "unresolved_ref_count": len(unresolved),
            "dependencies": {
                dep: sorted(syms)
                for dep, syms in sorted(outgoing.items(), key=_key_dep_by_size)
            },
            "dependents": {
                dep: sorted(syms)
                for dep, syms in sorted(incoming.items(), key=_key_dep_by_size)
            },
            "unresolved_refs": unresolved,
        }
        if transitive:
            payload["all_dependencies"] = {
                f: {"depth": v["depth"], "via": v["via"], "symbols": sorted(v["symbols"])}
                for f, v in sorted(transitive.items(), key=_key_transitive_by_depth)
            }
        typer.echo(json.dumps(payload))
        return

    outgoing_summary = _edge_summary(outgoing_file_count, outgoing_edge_count)
    incoming_summary = _edge_summary(incoming_file_count, incoming_edge_count)
    typer.echo(f"Dependency graph for {file_target.rel_path}")
    typer.echo(f"Dependencies ({outgoing_summary}):")
    if outgoing:
        for dep_rel, symbols in sorted(outgoing.items(), key=_key_dep_by_size):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    if transitive:
        transitive_only = {f: v for f, v in transitive.items() if f not in outgoing}
        if transitive_only:
            typer.echo(f"Transitive dependencies (depth 2–{depth or '∞'}, {len(transitive_only)} more files):")
            for dep_rel, info in sorted(transitive_only.items(), key=_key_transitive_by_depth):
                indent = "    " * (info["depth"] - 1)
                via_note = f"  via {info['via']}" if info["via"] != file_target.rel_path else ""
                typer.echo(f"{indent}{_format_dependency_line(dep_rel, info['symbols'])}{via_note}")

    typer.echo(f"Dependents ({incoming_summary}):")
    if incoming:
        for dep_rel, symbols in sorted(incoming.items(), key=_key_dep_by_size):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    if unresolved:
        noun = "ref" if len(unresolved) == 1 else "refs"
        typer.echo(f"Unresolved {noun} ({len(unresolved)}): {', '.join(unresolved[:20])}"
                   + (" ..." if len(unresolved) > 20 else ""))


def _run_read_line_range(
    *,
    target: str,
    session_id: str | None,
    json_output: bool,
    no_header: bool,
) -> None:
    """Handle ``token-goat read file::N-M`` (line-range variant).

    Called from :func:`read` after :func:`~read_replacement.parse_line_range`
    confirms the item part is a ``start-end`` integer pair.  Resolves the file,
    reads the requested lines, emits result, and records stats.
    """
    file_part, _, item_part = target.partition("::")
    range_parsed = read_replacement.parse_line_range(item_part)
    if range_parsed is None:
        _emit_read_error(
            code="invalid_target",
            message=f"Error: line range '{item_part}' is invalid (expected 'N-M' with N≥1 and M≥N)",
            json_output=json_output,
            target=target,
        )
        raise typer.Exit(2)

    start, end = range_parsed

    try:
        file_target = _resolve_file_target(file_part)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(code=exc.code, message=str(exc), json_output=json_output, file_part=file_part)
        raise typer.Exit(0) from None
    except read_replacement.AmbiguousFileMatch as exc:
        _emit_ambiguous_file_match(file_part, exc.candidates, json_output=json_output)
        raise typer.Exit(0) from None

    if file_target.rel_path is None:
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None

    result = read_replacement.read_line_range(file_target.project, file_target.rel_path, start, end)
    if result is None:
        _emit_read_error(
            code="line_range_out_of_bounds",
            message=f"Line range {start}-{end} is out of bounds for {file_target.rel_path}",
            json_output=json_output,
            rel_path=file_target.rel_path,
            item=item_part,
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, file_target.rel_path)

    bytes_saved = result.get("bytes_saved", 0)
    db.record_stat(
        file_target.project.hash,
        "read_replacement",
        tokens_saved=bytes_saved // 4,
        bytes_saved=bytes_saved,
        detail=f"{file_target.rel_path}::{item_part}",
    )

    cross_project = (
        file_target.project != file_target.current_project
        and file_target.current_project is not None
    )
    if json_output:
        out: dict[str, object] = {k: v for k, v in result.items() if k not in _INTERNAL_RESULT_FIELDS}
        if cross_project:
            out["_project_root"] = str(file_target.project.root)
        typer.echo(json.dumps(out, separators=(",", ":")))
        return

    if cross_project:
        typer.echo(f"[from project: {file_target.project.root}]", err=True)
    _emit_text_result(result["text"], file_target.rel_path, item_part, "lines", no_header)


def read(
    target: str = typer.Argument(..., help="<file>::<symbol|N-M> — e.g., 'parser.py::index_project', 'auth.py::Session.refresh' for a method, or 'parser.py::100-200' for a line range."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after the symbol body. Context lines are visually distinguished on TTY output."),
    no_header: bool = typer.Option(False, "--no-header", help="Suppress the '## path — symbol: name' header line (auto-suppressed in non-TTY contexts)"),
    header: bool = typer.Option(False, "--header", help="Force the '## path — symbol: name' header even in non-TTY contexts"),
    no_color: bool = typer.Option(False, "--no-color", help="Suppress ANSI color/dim escapes (useful when piping output)"),
    full: bool = typer.Option(False, "--full", "-f", help="Return the complete symbol body without smart truncation (bypasses the 60-line threshold)."),
) -> None:
    """Read just <symbol> from <file>, not the whole file.

    Accepts a symbol name (``file::MyFunc``), a qualified method
    (``file::Class.method``), or a line range (``file::100-200``).

    In agent/capture contexts (non-TTY stdout) the path header is suppressed
    by default to avoid paying ~10 tokens per call for information the agent
    already has.  Pass ``--header`` to force it on, or ``--no-header`` to
    force it off regardless of TTY state.

    Long symbol bodies (> 60 lines) are smart-truncated by default: the
    signature, optional docstring, first 15 body lines, an ellipsis comment,
    and last 5 lines are shown.  Pass ``--full`` (``-f``) to bypass truncation.
    """
    _no_header = no_header or not header and not sys.stdout.isatty()

    # Route line-range syntax ``file::N-M`` to a dedicated handler that skips
    # the symbol DB entirely and slices the file directly by line numbers.
    if "::" in target:
        _, _, item_part = target.partition("::")
        if read_replacement.parse_line_range(item_part) is not None:
            _run_read_line_range(
                target=target,
                session_id=session_id,
                json_output=json_output,
                no_header=_no_header,
            )
            return

    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="symbol",
        missing_label="Symbol",
        stat_kind="read_replacement",
        reader=read_replacement.read_symbol,
        no_header=_no_header,
        no_color=no_color,
        full=full,
    )


def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'. Append #N to disambiguate duplicate headings, e.g. 'doc.md::Setup#2'."),
    session_id: str | None = _OPT_SESSION_ID,
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after the section body. Context lines are visually distinguished on TTY output."),
    no_header: bool = typer.Option(False, "--no-header", help="Suppress the '## path — heading: name' header line (auto-suppressed in non-TTY contexts)"),
    header: bool = typer.Option(False, "--header", help="Force the '## path — heading: name' header even in non-TTY contexts"),
    no_color: bool = typer.Option(False, "--no-color", help="Suppress ANSI color/dim escapes (useful when piping output)"),
) -> None:
    """Extract just <heading> section from <file>, not the whole file.

    In agent/capture contexts (non-TTY stdout) the path header is suppressed
    by default to avoid paying ~10 tokens per call for information the agent
    already has.  Pass ``--header`` to force it on, or ``--no-header`` to
    force it off regardless of TTY state.
    """
    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="heading",
        missing_label="Section",
        stat_kind="section_replacement",
        reader=read_replacement.read_section,
        no_header=no_header or not header and not sys.stdout.isatty(),
        no_color=no_color,
    )


# Symbol kinds worth including in a skeleton view.  Excludes variables, imports,
# and other non-structural items that add noise without aiding navigation.
_STUB_VIEW_INCLUDE_KINDS: frozenset[str] = frozenset({
    "function", "method", "class", "interface", "struct", "trait", "enum",
    "type_alias", "constructor", "property", "decorator",
})

# Cap on symbols listed; large files with 200+ symbols still produce a useful
# skeleton without hitting context limits.
_STUB_VIEW_MAX_SYMBOLS: int = 80

#: Internal stat fields stored in ``SymbolResult`` / ``SectionResult`` dicts that
#: are never forwarded to callers — they drive savings accounting only.
#: Defined once here to avoid repeating the same tuple in every JSON-emission site.
_INTERNAL_RESULT_FIELDS: frozenset[str] = frozenset({"bytes_total", "bytes_extracted"})


def _format_stub_line(name: str, kind: str, line: int, signature: str | None) -> str:
    """Render one symbol entry for the skeleton view."""
    sig = f"  {signature}" if signature else ""
    return f"  {line:>5}  {kind:<12}  {name}{sig}"


# ---------------------------------------------------------------------------
# outline — top-level symbol list with docstring first-lines
# ---------------------------------------------------------------------------

# Maximum characters to show from a docstring first-line before truncating.
_OUTLINE_DOCSTRING_MAX_CHARS: int = 80

# How many lines past the symbol start line to scan for a docstring.
_OUTLINE_DOCSTRING_SCAN_LINES: int = 5

# Symbol kinds included in the outline view (same as skeleton but used
# independently so the two commands can diverge independently in future).
_OUTLINE_INCLUDE_KINDS: frozenset[str] = frozenset({
    "function", "async_function", "class", "interface", "struct", "trait",
    "enum", "type_alias", "constructor",
})

# Maximum top-level symbols to list; a single file rarely has more than this
# in practice, but the cap prevents OOM on pathological auto-generated files.
_OUTLINE_MAX_SYMBOLS: int = 200


def _extract_docstring_first_line(
    source_lines: list[str],
    symbol_start: int,
    symbol_end: int,
) -> str | None:
    """Return the first meaningful line of the symbol's docstring, or None.

    *source_lines* is the full file content as a list (1-indexed via [line-1]).
    *symbol_start* and *symbol_end* are 1-based line numbers.

    Scans up to :data:`_OUTLINE_DOCSTRING_SCAN_LINES` lines starting from
    ``symbol_start + 1`` (the line after the def/class header).  Recognises
    Python triple-quote docstrings and single-line doc comments
    (``//``, ``#``, ``/*``, ``*``).  Returns ``None`` when nothing
    docstring-like is found within the scan window.
    """
    scan_end = min(symbol_start + _OUTLINE_DOCSTRING_SCAN_LINES, symbol_end, len(source_lines))
    inside_triple_quote = False
    for lineno in range(symbol_start + 1, scan_end + 1):
        raw = source_lines[lineno - 1]
        stripped = raw.strip()
        if not stripped:
            continue

        # Python triple-quote: """..., '''...
        for q in ('"""', "'''"):
            if stripped.startswith(q):
                # Could be one-liner: """text""" or opening of multi-line block.
                inner = stripped[3:]
                # Remove trailing closing quote if present (one-liner).
                if inner.endswith(q):
                    inner = inner[:-3]
                content = inner.strip()
                if content:
                    return content[:_OUTLINE_DOCSTRING_MAX_CHARS]
                # Empty opening line of multi-line triple-quote — mark that we
                # are inside a block so subsequent lines are treated as body.
                inside_triple_quote = True
                break
        else:
            # No triple-quote match on this line.
            if inside_triple_quote:
                # We already entered a triple-quote block — this line is body text.
                # Stop if it looks like a closing quote line (""" alone).
                if stripped not in ('"""', "'''"):
                    return stripped[:_OUTLINE_DOCSTRING_MAX_CHARS]
                # Closing quote with no body text — no docstring.
                return None

            # Single-line doc comment styles: // #
            for prefix in ("//", "#"):
                if stripped.startswith(prefix):
                    content = stripped[len(prefix):].strip()
                    if content:
                        return content[:_OUTLINE_DOCSTRING_MAX_CHARS]
            # Block-comment styles: /** or /* or leading *
            if stripped.startswith(("/**", "/*")):
                inner = stripped[stripped.index("*") + 1:].strip().lstrip("*").strip()
                if inner and not inner.startswith("/"):
                    return inner[:_OUTLINE_DOCSTRING_MAX_CHARS]
            if stripped.startswith("*") and not stripped.startswith("*/"):
                inner = stripped[1:].strip()
                if inner:
                    return inner[:_OUTLINE_DOCSTRING_MAX_CHARS]
            # First non-comment, non-empty line that doesn't match any doc pattern
            # means there is no docstring — stop scanning.
            break
    return None


def _format_outline_line(
    name: str,
    kind: str,
    start_line: int,
    end_line: int,
    docstring_line: str | None,
) -> str:
    """Render one symbol entry for the outline view.

    Format: ``  L1-L2  kind            name  # docstring first line``

    The kind column is left-padded to 16 chars so names align regardless
    of kind length (``async_function`` is the longest at 14 chars).
    """
    range_str = f"{start_line}-{end_line}"
    doc_part = f"  # {docstring_line}" if docstring_line else ""
    return f"  {range_str:<10}  {kind:<16}  {name}{doc_part}"


def outline(
    file: str,
    json_output: bool = False,
) -> None:
    """List top-level symbols in <file> with line ranges and docstring hints.

    Returns a compact structured list of every top-level (module-level) symbol
    in the file — kind, name, line range, and the first line of its docstring
    if one exists.  Body text is omitted, so the output is typically ~5% of
    the cost of reading the full file.

    Use ``token-goat read <file>::<symbol>`` to retrieve any symbol body.
    """
    target = _resolve_file_target(file)
    if target.project is None or target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file}", err=True)
        hint = _not_indexed_hint(target.current_project.hash) if target.current_project else None
        if hint:
            typer.echo(hint, err=True)
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    with db.open_project_readonly(proj.hash) as conn:
        try:
            rows = conn.execute(
                "SELECT name, kind, line, end_line "
                "FROM symbols "
                "WHERE file_rel = ? AND parent_id IS NULL AND end_line IS NOT NULL "
                "ORDER BY line",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []

    if not rows:
        if json_output:
            typer.echo(json.dumps({"file": file_rel, "symbols": []}, separators=(",", ":")))
        else:
            typer.echo(f"No indexed top-level symbols found for {file_rel}.")
            typer.echo("(Run `token-goat index --full` if this file has not been indexed yet.)")
        return

    filtered = [
        row for row in rows
        if row["kind"] in _OUTLINE_INCLUDE_KINDS
    ][:_OUTLINE_MAX_SYMBOLS]

    if not filtered:
        # All symbols exist but none are structural (e.g. file of constants only).
        if json_output:
            typer.echo(json.dumps({"file": file_rel, "symbols": []}, separators=(",", ":")))
        else:
            typer.echo(f"No structural top-level symbols found for {file_rel}.")
        return

    # Read source lines once to extract docstrings for all symbols.
    source_lines: list[str] = []
    abs_path = proj.root / file_rel
    with contextlib.suppress(OSError):
        source_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()

    if json_output:
        out = []
        for row in filtered:
            doc = _extract_docstring_first_line(
                source_lines, int(row["line"]), int(row["end_line"]),
            ) if source_lines else None
            out.append({
                "name": row["name"],
                "kind": row["kind"],
                "start_line": row["line"],
                "end_line": row["end_line"],
                "docstring": doc,
            })
        typer.echo(json.dumps({"file": file_rel, "symbols": out}, separators=(",", ":")))
        return

    typer.echo(f"# Outline: {file_rel}  ({len(filtered)} top-level symbols)")
    for row in filtered:
        doc = _extract_docstring_first_line(
            source_lines, int(row["line"]), int(row["end_line"]),
        ) if source_lines else None
        typer.echo(_format_outline_line(row["name"], row["kind"], int(row["line"]), int(row["end_line"]), doc))

    # Record token savings: outline costs ~5% of a full file read.
    try:
        src_bytes = abs_path.stat().st_size
        outline_bytes = sum(
            len(_format_outline_line(
                r["name"], r["kind"], int(r["line"]), int(r["end_line"]), None,
            ).encode())
            for r in filtered
        )
        saved = max(0, src_bytes - outline_bytes)
        db.record_stat(None, "outline", bytes_saved=saved, tokens_saved=saved // 4, detail=file_rel)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# scope — symbols in scope at a given line
# ---------------------------------------------------------------------------

# Maximum imports to list in the "Module-level imports:" section before truncating.
_SCOPE_MAX_IMPORTS: int = 15

# Symbol kinds that count as "enclosing scope" for scope resolution.
# We include all structural kinds — a variable or import at module level can also
# enclose a line if it appears before it, but for enclosing scope we want the
# function/class/method nesting chain.
_SCOPE_ENCLOSING_KINDS: frozenset[str] = frozenset({
    "function", "async_function", "method", "class", "interface",
    "struct", "trait", "enum", "constructor",
})


def scope(
    target: str,
    json_output: bool = False,
) -> None:
    """Show what symbols are in scope at <file>:<line>.

    Accepts ``src/foo.py:42`` or an absolute path with a colon-separated line number.
    Returns:
    - **Enclosing scope** — function/class chain enclosing the line, outermost first.
    - **Module-level imports** — up to 15 imports at the top of the file.
    - **Suggestion** — a ``token-goat read`` command to read the innermost enclosing function.
    """
    # Parse <file>:<line>
    if ":" not in target:
        typer.echo(
            "Error: target must be '<file>:<line>' — e.g., 'src/foo.py:42'",
            err=True,
        )
        raise typer.Exit(2)

    # Split on the last colon to allow absolute Windows paths like C:\foo\bar.py:42
    last_colon = target.rfind(":")
    file_part = target[:last_colon]
    line_part = target[last_colon + 1:]

    # Validate line number
    try:
        target_line = int(line_part)
        if target_line < 1:
            raise ValueError("must be >= 1")
    except ValueError:
        typer.echo(
            f"Error: line number must be a positive integer, got '{line_part}'",
            err=True,
        )
        raise typer.Exit(2) from None

    # Resolve file
    file_target = _resolve_file_target(file_part)
    if file_target.rel_path is None:
        _emit_file_not_found_error(file_part, file_target.current_project, json_output=json_output)
        raise typer.Exit(0)

    assert file_target.project is not None
    proj = file_target.project
    file_rel = file_target.rel_path

    # Query DB
    enclosing_rows: list = []
    import_rows: list = []
    out_of_range = False

    with db.open_project_readonly(proj.hash) as conn:
        # Find total line count to check if target_line is out of range
        try:
            file_row = conn.execute(
                "SELECT line_count FROM files WHERE rel_path = ?",
                (file_rel,),
            ).fetchone()
            if file_row is not None and file_row["line_count"] is not None and target_line > file_row["line_count"]:
                out_of_range = True
        except (sqlite3.OperationalError, TypeError):
            pass

        # Find enclosing symbols: all symbols whose range spans the target line,
        # filtered to structural kinds, ordered outermost→innermost.
        try:
            enclosing_rows = conn.execute(
                "SELECT name, kind, line, end_line "
                "FROM symbols "
                "WHERE file_rel = ? "
                "  AND line <= ? AND end_line >= ? "
                "  AND end_line IS NOT NULL "
                "ORDER BY line ASC",
                (file_rel, target_line, target_line),
            ).fetchall()
        except sqlite3.OperationalError:
            enclosing_rows = []

        # Filter to structural enclosing kinds
        enclosing_rows = [r for r in enclosing_rows if r["kind"] in _SCOPE_ENCLOSING_KINDS]

        # Find module-level imports from imports_exports table
        try:
            import_rows = conn.execute(
                "SELECT target, line "
                "FROM imports_exports "
                "WHERE file_rel = ? AND kind = 'import' "
                "ORDER BY line ASC",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            import_rows = []

    if out_of_range:
        warn_msg = (
            f"Warning: line {target_line} is beyond the end of {file_rel}; "
            "showing module-level scope only."
        )
        if json_output:
            _LOG.warning(warn_msg)
        else:
            typer.echo(warn_msg, err=True)
        enclosing_rows = []

    # Determine the innermost enclosing function (for the suggestion)
    innermost_fn: str | None = None
    for row in reversed(enclosing_rows):
        if row["kind"] in ("function", "async_function", "method"):
            innermost_fn = row["name"]
            break

    # Truncate imports list
    total_imports = len(import_rows)
    display_imports = import_rows[:_SCOPE_MAX_IMPORTS]
    truncated_imports = total_imports - len(display_imports)

    if json_output:
        enclosing_out = [
            {
                "name": row["name"],
                "kind": row["kind"],
                "start_line": row["line"],
                "end_line": row["end_line"],
            }
            for row in enclosing_rows
        ]
        imports_out = [r["target"] for r in display_imports]
        result: dict[str, object] = {
            "file": file_rel,
            "line": target_line,
            "enclosing": enclosing_out,
            "imports": imports_out,
        }
        if truncated_imports:
            result["imports_truncated"] = truncated_imports
        if innermost_fn:
            result["suggestion"] = f'token-goat read "{file_rel}::{innermost_fn}"'
        typer.echo(json.dumps(result, separators=(",", ":")))
        return

    # Text output
    typer.echo(f"# Scope at {file_rel}:{target_line}")
    typer.echo("")

    typer.echo("Enclosing scope:")
    if enclosing_rows:
        for row in enclosing_rows:
            typer.echo(f"  {row['kind']:<16}  {row['name']}  (lines {row['line']}–{row['end_line']})")
    else:
        typer.echo("  (module level — no enclosing function or class)")

    typer.echo("")
    typer.echo("Module-level imports:")
    if display_imports:
        for imp in display_imports:
            typer.echo(f"  {imp['target']}")
        if truncated_imports:
            typer.echo(f"  ... and {truncated_imports} more")
    else:
        typer.echo("  (none)")

    if innermost_fn:
        typer.echo("")
        typer.echo(f'Suggestion: token-goat read "{file_rel}::{innermost_fn}"')


def stub_view(
    file: str,
    json_output: bool = False,
    include_private: bool = False,
) -> None:
    """Show all signatures in <file> without bodies — typically 70-90% fewer tokens.

    Queries the indexed symbol DB for the file and prints each symbol's kind,
    line number, and signature.  Use ``--private`` to include underscore-prefixed
    names.
    """
    target = _resolve_file_target(file)
    if target.project is None or target.rel_path is None:
        typer.echo(f"File not found in any indexed project: {file}", err=True)
        raise typer.Exit(1)

    proj = target.project
    file_rel = target.rel_path

    with db.open_project_readonly(proj.hash) as conn:
        try:
            rows = conn.execute(
                "SELECT name, kind, line, signature "
                "FROM symbols "
                "WHERE file_rel = ? AND end_line IS NOT NULL "
                "ORDER BY line",
                (file_rel,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []

    if not rows:
        typer.echo(f"No indexed symbols found for {file_rel}.")
        return

    filtered = [
        row for row in rows
        if row["kind"] in _STUB_VIEW_INCLUDE_KINDS
        and (include_private or not str(row["name"]).startswith("_"))
    ][:_STUB_VIEW_MAX_SYMBOLS]

    if json_output:
        out = [
            {
                "name": row["name"],
                "kind": row["kind"],
                "line": row["line"],
                "signature": row["signature"],
            }
            for row in filtered
        ]
        typer.echo(json.dumps(out, separators=(",", ":")))
        return

    typer.echo(f"# Skeleton: {file_rel}  ({len(filtered)} symbols)")
    for row in filtered:
        typer.echo(_format_stub_line(row["name"], row["kind"], row["line"], row["signature"]))

    # Record savings: stub views cost ~5-15% of a full file read.
    try:
        abs_path = proj.root / file_rel
        src_bytes = abs_path.stat().st_size
        stub_bytes = sum(
            len(_format_stub_line(r["name"], r["kind"], r["line"], r["signature"]).encode())
            for r in filtered
        )
        saved = max(0, src_bytes - stub_bytes)
        db.record_stat(None, "stub_view", bytes_saved=saved, tokens_saved=saved // 4, detail=file_rel)
    except Exception:  # noqa: BLE001
        pass
