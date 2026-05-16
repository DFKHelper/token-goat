"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import json
import logging
import sqlite3
from collections import defaultdict, deque
from collections.abc import Callable, Sequence
from pathlib import Path

import typer

from . import db, read_replacement, session
from .project import Project, find_project

_LOG = logging.getLogger("token_goat.read_commands")


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
) -> dict[str, dict]:
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
    result: dict[str, dict] = {}
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
                result[dep_file] = {"depth": next_depth, "via": current, "symbols": symbols}
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


def _resolve_file_target(file_part: str) -> tuple[Project | None, str | None, Project | None]:
    """Resolve a file name pattern to a concrete project-relative path.

    First attempts resolution in the current project; if not found, searches across
    all indexed projects. Returns (project, rel_path, current_project). rel_path is
    None if file not found; project is the one owning that file (or None if not found
    in any project).
    """
    proj = find_project(Path.cwd())
    if proj is not None:
        rel = read_replacement.resolve_file_rel(proj, file_part)
        if rel is not None:
            return proj, rel, proj

    cross = read_replacement.find_in_all_projects(file_part)
    if cross is not None:
        return cross[0], cross[1], proj
    return None, None, proj


def _run_read_like_command(
    *,
    target: str,
    session_id: str | None,
    json_output: bool,
    context_lines: int,
    separator_label: str,
    missing_label: str,
    stat_kind: str,
    reader: Callable[..., dict | None],
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
        reader: Callable(project, rel_path, item, context_lines) -> dict|None.
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
        proj, rel, current_proj = _resolve_file_target(file_part)
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

    if rel is None:
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
        raise typer.Exit(0)

    assert proj is not None  # guaranteed once rel is resolved
    result = reader(proj, rel, item_part, context_lines=context_lines)
    if result is None:
        _emit_read_error(
            code=f"{missing_label.lower()}_not_found",
            message=f"{missing_label} not found: {item_part} (in {rel})",
            json_output=json_output,
            file_part=file_part,
            rel_path=rel,
            item=item_part,
            item_kind=missing_label.lower(),
        )
        raise typer.Exit(0)

    if session_id:
        session.mark_file_read(session_id, rel, symbol=item_part)

    bytes_saved = result.get("bytes_saved", 0)
    tokens_saved = bytes_saved // 4
    db.record_stat(
        proj.hash,
        stat_kind,
        tokens_saved=tokens_saved,
        bytes_saved=bytes_saved,
        detail=f"{rel}::{item_part}",
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
        proj, rel, current_proj = _resolve_file_target(file)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=json_output,
            file_part=file,
        )
        return

    if rel is None:
        if current_proj is None:
            _emit_read_error(
                code="no_project",
                message="No project detected.",
                json_output=json_output,
                file_part=file,
            )
        else:
            hint = _not_indexed_hint(current_proj.hash)
            _emit_read_error(
                code="project_not_indexed" if hint else "file_not_found",
                message=hint if hint else f"File not found in any indexed project: {file}",
                json_output=json_output,
                file_part=file,
                project_hash=current_proj.hash,
            )
        return

    assert proj is not None
    with db.open_project(proj.hash) as conn:
        outgoing, incoming, unresolved = _collect_dependency_graph(conn, rel)
        transitive: dict[str, dict] = {}
        if depth != 1:
            transitive = _collect_transitive_outgoing(conn, rel, max_depth=depth)

    outgoing_edge_count = sum(len(v) for v in outgoing.values())
    outgoing_file_count = len(outgoing)
    incoming_edge_count = sum(len(v) for v in incoming.values())
    incoming_file_count = len(incoming)

    if json_output:
        payload: dict[str, object] = {
            "file": rel,
            "depth": depth,
            "dependency_file_count": outgoing_file_count,
            "dependency_edge_count": outgoing_edge_count,
            "dependent_file_count": incoming_file_count,
            "dependent_edge_count": incoming_edge_count,
            "unresolved_ref_count": len(unresolved),
            "dependencies": {
                dep: sorted(syms)
                for dep, syms in sorted(outgoing.items(), key=lambda item: (-len(item[1]), item[0]))
            },
            "dependents": {
                dep: sorted(syms)
                for dep, syms in sorted(incoming.items(), key=lambda item: (-len(item[1]), item[0]))
            },
            "unresolved_refs": unresolved,
        }
        if transitive:
            payload["all_dependencies"] = {
                f: {"depth": v["depth"], "via": v["via"], "symbols": sorted(v["symbols"])}
                for f, v in sorted(transitive.items(), key=lambda x: (x[1]["depth"], x[0]))
            }
        typer.echo(json.dumps(payload))
        return

    outgoing_summary = _edge_summary(outgoing_file_count, outgoing_edge_count)
    incoming_summary = _edge_summary(incoming_file_count, incoming_edge_count)
    typer.echo(f"Dependency graph for {rel}")
    typer.echo(f"Dependencies ({outgoing_summary}):")
    if outgoing:
        for dep_rel, symbols in sorted(outgoing.items(), key=lambda item: (-len(item[1]), item[0])):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    if transitive:
        transitive_only = {f: v for f, v in transitive.items() if f not in outgoing}
        if transitive_only:
            typer.echo(f"Transitive dependencies (depth 2–{depth or '∞'}, {len(transitive_only)} more files):")
            for dep_rel, info in sorted(transitive_only.items(), key=lambda x: (x[1]["depth"], x[0])):
                indent = "    " * (info["depth"] - 1)
                via_note = f"  via {info['via']}" if info["via"] != rel else ""
                typer.echo(f"{indent}{_format_dependency_line(dep_rel, info['symbols'])}{via_note}")

    typer.echo(f"Dependents ({incoming_summary}):")
    if incoming:
        for dep_rel, symbols in sorted(incoming.items(), key=lambda item: (-len(item[1]), item[0])):
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
