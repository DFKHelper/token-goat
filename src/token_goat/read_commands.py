"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import difflib
import json
import logging
import sqlite3
from collections import defaultdict, deque
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, TypedDict

import typer

from . import db, read_replacement, session
from .project import Project, find_project

_LOG = logging.getLogger("token_goat.read_commands")

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
    """Return a one-line hint when this project has no indexed files."""
    try:
        if not db.project_has_files(project_hash):
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


# Max number of "did you mean…?" suggestions to surface on a missed lookup.
# 5 is the difflib default ceiling; more becomes noise and competes with the
# error message for the agent's attention.
_DIDYOUMEAN_LIMIT = 5
# difflib similarity cutoff. 0.6 is difflib's default; lowering would surface
# more candidates but also more noise. The aim is to cover near-typos and
# case mismatches, not arbitrary substring containment.
_DIDYOUMEAN_CUTOFF = 0.6


def _close_symbol_matches(project: Project, rel_path: str, symbol: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` symbol names from ``rel_path`` that are
    close lexical matches for ``symbol``.

    Used to produce "did you mean…?" suggestions when ``token-goat read`` fails
    to find a symbol in an otherwise-resolved file. Returning even one good
    candidate keeps the agent on the surgical-read path instead of falling
    back to ``Read full-file``.

    Returns an empty list on any DB error so the miss message still emits.
    """
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                "SELECT DISTINCT name FROM symbols WHERE file_rel = ? AND name IS NOT NULL",
                (rel_path,),
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        _LOG.debug("close-match query failed for symbol in %s: %s", rel_path, exc)
        return []
    names = [r["name"] for r in rows if r["name"]]
    return difflib.get_close_matches(symbol, names, n=_DIDYOUMEAN_LIMIT, cutoff=_DIDYOUMEAN_CUTOFF)


def _close_section_matches(project: Project, rel_path: str, heading: str) -> list[str]:
    """Return up to :data:`_DIDYOUMEAN_LIMIT` section headings from ``rel_path``
    that are close lexical matches for ``heading``.

    The mirror of :func:`_close_symbol_matches` for ``token-goat section``.
    Returns an empty list on any DB error.
    """
    try:
        with db.open_project_readonly(project.hash) as conn:
            rows = conn.execute(
                "SELECT DISTINCT heading FROM sections WHERE file_rel = ? AND heading IS NOT NULL",
                (rel_path,),
            ).fetchall()
    except (sqlite3.OperationalError, sqlite3.DatabaseError) as exc:
        _LOG.debug("close-match query failed for section in %s: %s", rel_path, exc)
        return []
    headings = [r["heading"] for r in rows if r["heading"]]
    return difflib.get_close_matches(heading, headings, n=_DIDYOUMEAN_LIMIT, cutoff=_DIDYOUMEAN_CUTOFF)


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
        typer.echo(json.dumps({"ok": False, "error": error}, indent=2))
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
        _emit_read_error(
            code=f"{_label_lower}_not_found",
            message=base_message,
            json_output=json_output,
            candidates=suggestions,
            file_part=file_part,
            rel_path=file_target.rel_path,
            item=item_part,
            item_kind=_label_lower,
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, file_target.rel_path, symbol=item_part)

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

    if json_output:
        typer.echo(json.dumps(result, indent=2))
        return
    typer.echo(result["text"])


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


def read(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'parser.py::index_project'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Read just <symbol> from <file>, not the whole file."""
    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="symbol",
        missing_label="Symbol",
        stat_kind="read_replacement",
        reader=read_replacement.read_symbol,
    )


def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Extract just <heading> section from <file>, not the whole file."""
    _run_read_like_command(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
        separator_label="heading",
        missing_label="Section",
        stat_kind="section_replacement",
        reader=read_replacement.read_section,
    )
