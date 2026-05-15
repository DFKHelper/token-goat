"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import json
import logging
import sqlite3
from collections import defaultdict
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
    """Emit a structured read error in either text or JSON form."""
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
    _emit_read_error(
        code="ambiguous_file",
        message=f"Ambiguous file match: {file_part}",
        candidates=candidates,
        json_output=json_output,
        file_part=file_part,
    )


def _collect_dependency_graph(conn: sqlite3.Connection, rel_path: str) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """Return file-level dependency edges for the given file."""
    outgoing: dict[str, set[str]] = defaultdict(set)
    referenced_names = [
        row["symbol_name"]
        for row in conn.execute(
            "SELECT DISTINCT symbol_name FROM refs WHERE file_rel = ? AND symbol_name != ''",
            (rel_path,),
        ).fetchall()
    ]
    for symbol_name in referenced_names:
        for row in conn.execute(
            "SELECT DISTINCT file_rel FROM symbols WHERE name = ? AND file_rel != ?",
            (symbol_name, rel_path),
        ).fetchall():
            outgoing[row["file_rel"]].add(symbol_name)

    incoming: dict[str, set[str]] = defaultdict(set)
    defined_names = [
        row["name"]
        for row in conn.execute(
            "SELECT DISTINCT name FROM symbols WHERE file_rel = ?",
            (rel_path,),
        ).fetchall()
    ]
    for symbol_name in defined_names:
        for row in conn.execute(
            "SELECT DISTINCT file_rel FROM refs WHERE symbol_name = ? AND file_rel != ?",
            (symbol_name, rel_path),
        ).fetchall():
            incoming[row["file_rel"]].add(symbol_name)

    return outgoing, incoming


def _format_dependency_line(file_rel: str, symbols: set[str]) -> str:
    symbol_list = ", ".join(sorted(symbols))
    count = len(symbols)
    noun = "symbol" if count == 1 else "symbols"
    if symbol_list:
        return f"  - {file_rel} ({count} {noun}: {symbol_list})"
    return f"  - {file_rel} ({count} {noun})"


def _resolve_file_target(file_part: str) -> tuple[Project | None, str | None, Project | None]:
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


def deps(file: str) -> None:
    """Show dependency graph for file."""
    try:
        proj, rel, current_proj = _resolve_file_target(file)
    except read_replacement.ProjectIndexUnavailable as exc:
        _emit_read_error(
            code=exc.code,
            message=str(exc),
            json_output=False,
            file_part=file,
        )
        return

    if rel is None:
        if current_proj is None:
            _emit_read_error(
                code="no_project",
                message="No project detected.",
                json_output=False,
                file_part=file,
            )
        else:
            hint = _not_indexed_hint(current_proj.hash)
            _emit_read_error(
                code="project_not_indexed" if hint else "file_not_found",
                message=hint if hint else f"File not found in any indexed project: {file}",
                json_output=False,
                file_part=file,
                project_hash=current_proj.hash,
            )
        return

    assert proj is not None
    with db.open_project(proj.hash) as conn:
        outgoing, incoming = _collect_dependency_graph(conn, rel)

    typer.echo(f"Dependency graph for {rel}")
    typer.echo("Dependencies:")
    if outgoing:
        for dep_rel, symbols in sorted(outgoing.items(), key=lambda item: (-len(item[1]), item[0])):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")

    typer.echo("Dependents:")
    if incoming:
        for dep_rel, symbols in sorted(incoming.items(), key=lambda item: (-len(item[1]), item[0])):
            typer.echo(_format_dependency_line(dep_rel, symbols))
    else:
        typer.echo("  (none)")


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
