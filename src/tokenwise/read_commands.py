"""Command helpers for the read/section/deps CLI path."""
from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from pathlib import Path

import typer

from . import db, read_replacement, session
from .project import Project, find_project

_LOG = logging.getLogger("tokenwise.read_commands")


def _not_indexed_hint(project_hash: str) -> str | None:
    """Return a one-line hint when this project has no indexed files."""
    try:
        if db.file_count(project_hash) == 0:
            return (
                "(project not yet indexed. auto-indexing started in the "
                "background on first SessionStart; if it has not finished, "
                "rerun in a moment, or run `tokenwise index --full` to force "
                "synchronous indexing.)"
            )
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("failed to check project index status: %s", exc)
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
    typer.echo("not yet implemented: deps")


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
