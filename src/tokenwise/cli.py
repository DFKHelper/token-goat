"""Typer CLI with stub subcommands."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

# Force UTF-8 on stdout/stderr (Windows defaults to cp1252 which can't encode
# the punctuation we use in maps, hints, and stats: → ›  etc.).
# `.reconfigure` exists on TextIOWrapper but not on the generic TextIO base.
# contextlib.suppress(AttributeError) handles environments where it isn't there.
with contextlib.suppress(AttributeError, OSError):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
with contextlib.suppress(AttributeError, OSError):
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

import typer

from . import hooks_cli

_LOG = logging.getLogger(__name__)


def _write_raw(text: str) -> None:
    """Write text with truecolor ANSI codes directly, bypassing colorama.

    colorama wraps sys.stdout in a StreamWrapper whose write() either strips
    all ANSI codes (strip=True, piped output) or converts them via Win32 API
    (convert=True, TTY).  Neither path handles 24-bit color: the Win32 path
    iterates semicolon-separated params individually, so fg(31,77,44) becomes
    ANSI red (SGR 31) instead of RGB(31,77,44).

    Fix: unwrap to the raw TextIOWrapper and write bytes directly, letting
    Windows Terminal's native VT processor handle the sequences correctly.
    """
    if os.environ.get("NO_COLOR") or not sys.stdout.isatty():
        text = re.sub(r"\x1b\[[0-9;]*m", "", text)

    stream: Any = sys.stdout
    # colorama.StreamWrapper stores original stream as a name-mangled attr
    if hasattr(stream, "_StreamWrapper__wrapped"):
        stream = stream._StreamWrapper__wrapped  # type: ignore[attr-defined]
    # colorama.AnsiToWin32 stores it as .stream
    while hasattr(stream, "stream"):
        stream = stream.stream  # type: ignore[attr-defined]
    encoded = (text + "\n").encode("utf-8")
    if hasattr(stream, "buffer"):
        stream.buffer.write(encoded)  # type: ignore[attr-defined]
        stream.buffer.flush()  # type: ignore[attr-defined]
    else:
        stream.write(text + "\n")  # type: ignore[attr-defined]
        stream.flush()  # type: ignore[attr-defined]


app = typer.Typer(name="tokenwise", no_args_is_help=True)
hook_app = typer.Typer(name="hook", no_args_is_help=True)
config_app = typer.Typer(name="config", no_args_is_help=True)

app.add_typer(hook_app)
app.add_typer(config_app)


def main() -> None:
    """Process entry point. Wraps ``app()`` so hook subcommands NEVER propagate
    a non-zero exit even when click/typer itself rejects unknown arguments.

    Hook harnesses (Codex in particular) pass version-specific args we can't
    predict; click's ``no_such_option`` raises before our handler runs and
    becomes a top-level ``SystemExit(2)``. Catching it here, emitting a
    ``{"continue": true}`` placeholder, and exiting 0 keeps the harness happy.
    Non-hook commands keep their normal exit behaviour so real CLI usage still
    surfaces bad flags to the user.
    """
    try:
        app()
    except SystemExit as exc:
        code = exc.code
        if not isinstance(code, int) or code == 0:
            raise
        argv = sys.argv[1:] if len(sys.argv) > 1 else []
        is_hook_call = bool(argv) and argv[0] == "hook"
        if not is_hook_call:
            raise
        try:
            sys.stdout.write('{"continue": true}')
            sys.stdout.flush()
        except Exception as e:  # noqa: BLE001
            _LOG.exception("failed to emit hook response: %s", e)
        raise SystemExit(0) from None


def _not_indexed_hint(project_hash: str) -> str | None:
    """Return a one-line hint when this project has no indexed files.

    Distinguishes "no match for that name" from "nothing in the DB yet". Agents
    (especially Codex) otherwise interpret an empty result as "tokenwise is
    failing" and fall back to direct file reads.
    """
    from . import db as _db  # noqa: PLC0415
    try:
        if _db.file_count(project_hash) == 0:
            return (
                "(project not yet indexed. auto-indexing started in the "
                "background on first SessionStart; if it has not finished, "
                "rerun in a moment, or run `tokenwise index --full` to force "
                "synchronous indexing.)"
            )
    except Exception as e:  # noqa: BLE001
        _LOG.warning("failed to check project index status: %s", e)
        return None
    return None


@app.command()
def symbol(
    name: str,
    all_projects: bool = typer.Option(False, "--all-projects"),
    as_json: bool = typer.Option(False, "--json"),
    limit: int = typer.Option(50, "--limit"),
) -> None:
    """Find symbol definition across codebase."""
    from . import db as _db  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    use_tty_color = sys.stdout.isatty() and not as_json

    def _fmt_plain(rows: list[dict]) -> None:
        for row in rows:
            project_prefix = f"[{row.get('project', '')}] " if "project" in row else ""
            sig_part = f"  {row['signature']}" if row.get("signature") else ""
            kind_name = f"{row['kind']} {row['name']}"
            if use_tty_color:
                kind_name = f"\033[90m{kind_name}\033[0m"
                sig_part = f"\033[2m{sig_part}\033[0m"
            typer.echo(f"{project_prefix}{row['file']}:{row['line']}: {kind_name}{sig_part}")

    if all_projects:
        with _db.open_global() as gconn:
            rows_raw = gconn.execute(
                "SELECT sg.project_hash, p.root, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature "
                "FROM symbols_global sg "
                "JOIN projects p ON p.hash = sg.project_hash "
                "WHERE sg.name = ? LIMIT ?",
                (name, limit),
            ).fetchall()
        results = [
            {
                "project": r["root"],
                "file": r["file_rel"],
                "line": r["line"],
                "kind": r["kind"],
                "name": r["name"],
                "signature": r["signature"],
            }
            for r in rows_raw
        ]
        if as_json:
            typer.echo(json.dumps(results))
        elif results:
            _fmt_plain(results)
        else:
            typer.echo(f"No matches for {name!r}")
        return

    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("no project detected, run from a project directory")
        return

    with _db.open_project(proj.hash) as conn:
        rows_raw = conn.execute(
            "SELECT name, kind, file_rel, line, signature FROM symbols WHERE name = ? LIMIT ?",
            (name, limit),
        ).fetchall()

    results = [
        {
            "file": r["file_rel"],
            "line": r["line"],
            "kind": r["kind"],
            "name": r["name"],
            "signature": r["signature"],
        }
        for r in rows_raw
    ]

    if as_json:
        typer.echo(json.dumps(results))
    elif results:
        _fmt_plain(results)
    else:
        hint = _not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        else:
            typer.echo(f"No matches for {name!r}")


@app.command()
def ref(
    name: str,
    as_json: bool = typer.Option(False, "--json"),
    limit: int = typer.Option(100, "--limit"),
) -> None:
    """Find all references to a symbol."""
    from . import db as _db  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("no project detected, run from a project directory")
        return

    with _db.open_project(proj.hash) as conn:
        rows_raw = conn.execute(
            "SELECT file_rel, line, col, context FROM refs WHERE symbol_name = ? LIMIT ?",
            (name, limit),
        ).fetchall()

    results = [
        {
            "name": name,
            "file": r["file_rel"],
            "line": r["line"],
            "col": r["col"],
            "context": r["context"],
        }
        for r in rows_raw
    ]

    if as_json:
        typer.echo(json.dumps(results))
    elif results:
        use_tty_color = sys.stdout.isatty()
        for row in results:
            ctx = f"  {row['context']}" if row.get("context") else ""
            if use_tty_color:
                ctx = f"\033[2m{ctx}\033[0m"
            typer.echo(f"{row['file']}:{row['line']}: ref {name!r}{ctx}")
    else:
        hint = _not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        else:
            typer.echo(f"No references found for {name!r}")


@app.command()
def semantic(
    query: str = typer.Argument(...),
    k: int = typer.Option(5, "-k", help="Top-k results"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Semantic search using local embeddings (fastembed + sqlite-vec)."""
    from . import embeddings  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("No project detected.")
        raise typer.Exit(0)

    try:
        hits = embeddings.semantic_search(proj, query, k=k)
    except embeddings.EmbeddingsUnavailable as e:
        typer.echo(
            f"Embeddings unavailable ({e}). Try `tokenwise index --embeddings` first, "
            "or use `tokenwise symbol`/`tokenwise map` for non-semantic navigation."
        )
        raise typer.Exit(0) from None

    if json_output:
        out = [
            {
                "file": h.file_rel,
                "start": h.start_line,
                "end": h.end_line,
                "kind": h.kind,
                "distance": h.distance,
                "preview": h.text[:200],
            }
            for h in hits
        ]
        typer.echo(json.dumps(out, indent=2))
        return

    if not hits:
        typer.echo("(no results)")
        return
    for h in hits:
        preview = h.text.replace("\n", " ")[:120]
        typer.echo(
            f"{h.file_rel}:{h.start_line}-{h.end_line} ({h.kind}, d={h.distance:.4f})"
        )
        typer.echo(f"  {preview}")


@app.command("map")
def cmd_map(
    budget: int = typer.Option(4000, "--budget", "-b", help="Approximate token budget"),
    json_output: bool = typer.Option(False, "--json", help="Output structured JSON"),
) -> None:
    """Generate a PageRank-ranked, token-budgeted overview of the current project."""
    from . import repomap  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo(
            "No project detected (no .git, package.json, etc. found). "
            "Run from a project directory."
        )
        raise typer.Exit(code=0)

    if json_output:
        data = repomap.build_map_json(proj)
        typer.echo(json.dumps(data, indent=2))
        return

    text = repomap.build_map(proj, budget_tokens=budget)
    typer.echo(text)


@app.command()
def deps(file: str) -> None:
    """Show dependency graph for file."""
    typer.echo("not yet implemented: deps")


@app.command()
def read(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'parser.py::index_project'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Read just <symbol> from <file>, not the whole file."""
    if "::" not in target:
        typer.echo("Error: target must be '<file>::<symbol>'", err=True)
        raise typer.Exit(2)
    file_part, _, symbol_part = target.partition("::")

    from . import read_replacement  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    rel: str | None = None
    if proj is not None:
        rel = read_replacement.resolve_file_rel(proj, file_part)

    if rel is None:
        # Fall back to searching all indexed projects (e.g. skills, plugins)
        cross = read_replacement.find_in_all_projects(file_part)
        if cross is not None:
            proj, rel = cross
        else:
            if proj is None:
                typer.echo("No project detected.", err=True)
            else:
                hint = _not_indexed_hint(proj.hash)
                if hint:
                    typer.echo(hint)
                else:
                    typer.echo(f"File not found in any indexed project: {file_part}", err=True)
            raise typer.Exit(0)

    assert proj is not None  # guaranteed: either cross-project match or we exited above
    result = read_replacement.read_symbol(proj, rel, symbol_part, context_lines=context_lines)
    if result is None:
        typer.echo(f"Symbol not found: {symbol_part} (in {rel})", err=True)
        raise typer.Exit(0)

    if session_id:
        from . import session  # noqa: PLC0415
        with contextlib.suppress(Exception):
            session.mark_file_read(session_id, file_part, symbol=symbol_part)

    from . import db as _db  # noqa: PLC0415
    bytes_saved = result.get("bytes_saved", 0)
    tokens_saved = bytes_saved // 4
    with contextlib.suppress(Exception):
        _db.record_stat(
            proj.hash,
            "read_replacement",
            tokens_saved=tokens_saved,
            bytes_saved=bytes_saved,
            detail=f"{rel}::{symbol_part}",
        )

    if json_output:
        typer.echo(json.dumps(result, indent=2))
        return
    typer.echo(result["text"])


@app.command()
def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Extract just <heading> section from <file>, not the whole file."""
    if "::" not in target:
        typer.echo("Error: target must be '<file>::<heading>'", err=True)
        raise typer.Exit(2)
    file_part, _, heading_part = target.partition("::")

    from . import read_replacement  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    rel: str | None = None
    if proj is not None:
        rel = read_replacement.resolve_file_rel(proj, file_part)

    if rel is None:
        # Fall back to searching all indexed projects (e.g. skills, plugins)
        cross = read_replacement.find_in_all_projects(file_part)
        if cross is not None:
            proj, rel = cross
        else:
            if proj is None:
                typer.echo("No project detected.", err=True)
            else:
                hint = _not_indexed_hint(proj.hash)
                if hint:
                    typer.echo(hint)
                else:
                    typer.echo(f"File not found in any indexed project: {file_part}", err=True)
            raise typer.Exit(0)

    assert proj is not None  # guaranteed: either cross-project match or we exited above
    result = read_replacement.read_section(proj, rel, heading_part, context_lines=context_lines)
    if result is None:
        typer.echo(f"Section not found: {heading_part} (in {rel})", err=True)
        raise typer.Exit(0)

    if session_id:
        from . import session  # noqa: PLC0415
        with contextlib.suppress(Exception):
            session.mark_file_read(session_id, file_part, symbol=heading_part)

    from . import db as _db  # noqa: PLC0415
    bytes_saved = result.get("bytes_saved", 0)
    tokens_saved = bytes_saved // 4
    with contextlib.suppress(Exception):
        _db.record_stat(
            proj.hash,
            "section_replacement",
            tokens_saved=tokens_saved,
            bytes_saved=bytes_saved,
            detail=f"{rel}::{heading_part}",
        )

    if json_output:
        typer.echo(json.dumps(result, indent=2))
        return
    typer.echo(result["text"])


@app.command("session-touched")
def session_touched(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List files already read in the given Claude session."""
    from . import session as session_mod  # noqa: PLC0415

    entries = session_mod.list_touched(session_id)
    if json_output:
        out = [
            {
                "path": e.rel_or_abs,
                "read_count": e.read_count,
                "line_ranges": e.line_ranges,
                "symbols_read": e.symbols_read,
                "last_read_ts": e.last_read_ts,
            }
            for e in entries
        ]
        typer.echo(json.dumps(out, indent=2))
        return
    if not entries:
        typer.echo("(no files touched in this session)")
        return
    for e in entries:
        ranges = ", ".join(f"{s}-{en}" for s, en in e.line_ranges) or "(symbols only)"
        symbols = f" symbols={','.join(e.symbols_read)}" if e.symbols_read else ""
        typer.echo(f"{e.rel_or_abs}  reads={e.read_count}  lines={ranges}{symbols}")


@app.command("session-mark")
def session_mark(
    file_path: str = typer.Argument(...),
    session_id: str = typer.Option(..., "--session-id", "-s"),
    offset: int = typer.Option(0, "--offset"),
    limit: int = typer.Option(0, "--limit", help="0 means unlimited"),
) -> None:
    """Manually mark a file/range as read for the given session. (Mostly used by hooks.)"""
    from . import session as session_mod  # noqa: PLC0415

    session_mod.mark_file_read(session_id, file_path, offset or None, limit or None)
    typer.echo("ok")


@app.command("gdrive-fetch")
def cmd_gdrive_fetch(
    file_id: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Fetch a Google Drive file (image gets auto-shrunk). Returns the local path."""
    from . import gdrive  # noqa: PLC0415

    try:
        path = gdrive.fetch_file(file_id)
    except gdrive.GDriveCredsUnavailable as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(0) from None  # fail-soft: don't break Claude's session
    except Exception as e:  # noqa: BLE001
        typer.echo(f"Drive fetch failed: {e}", err=True)
        raise typer.Exit(0) from None
    if json_output:
        typer.echo(json.dumps({"path": str(path), "size": path.stat().st_size}))
    else:
        typer.echo(str(path))


@app.command("gdrive-auth")
def cmd_gdrive_auth(
    client_secrets: Path | None = typer.Option(None, "--client-secrets", help="Path to OAuth client_secrets.json"),  # noqa: B008
) -> None:
    """One-time Google Drive auth setup. Tries ADC first, then OAuth flow."""
    from . import gdrive  # noqa: PLC0415

    # Check ADC
    creds = gdrive._try_adc()
    if creds is not None:
        typer.echo("Google Application Default Credentials detected. tokenwise gdrive-fetch will work.")
        raise typer.Exit(0)

    # Check existing stored creds
    creds = gdrive._try_stored_oauth()
    if creds is not None:
        typer.echo("Stored OAuth credentials valid. tokenwise gdrive-fetch will work.")
        raise typer.Exit(0)

    # Need to set up OAuth
    if client_secrets is None:
        typer.echo("No credentials available. To set up:")
        typer.echo("")
        typer.echo("Option A (recommended if you have gcloud installed):")
        typer.echo("  gcloud auth application-default login --scopes https://www.googleapis.com/auth/drive.readonly")
        typer.echo("")
        typer.echo("Option B: OAuth client secrets")
        typer.echo("  1. Visit https://console.cloud.google.com/apis/credentials")
        typer.echo("  2. Create OAuth 2.0 Client ID (type: Desktop)")
        typer.echo("  3. Download the JSON, then run:")
        typer.echo("       tokenwise gdrive-auth --client-secrets path/to/client_secret.json")
        typer.echo("")
        typer.echo("Option C: skip — tokenwise gdrive-fetch will fall back to a clear error,")
        typer.echo("and Claude's existing Drive MCP will be used directly (no token-savings).")
        raise typer.Exit(0)

    if not client_secrets.exists():
        typer.echo(f"File not found: {client_secrets}", err=True)
        raise typer.Exit(1)

    try:
        out_path = gdrive.run_oauth_oob_flow(client_secrets)
        typer.echo(f"Credentials saved to {out_path}. tokenwise gdrive-fetch will work.")
    except Exception as e:  # noqa: BLE001
        typer.echo(f"OAuth flow failed: {e}", err=True)
        raise typer.Exit(1) from None


@app.command("fetch-image")
def cmd_fetch_image(
    url: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Fetch an image URL (auto-shrunk). Returns the local cached path."""
    from . import webfetch  # noqa: PLC0415

    try:
        path = webfetch.fetch_url(url)
    except Exception as e:  # noqa: BLE001
        typer.echo(f"WebFetch failed: {e}", err=True)
        raise typer.Exit(0) from None  # fail-soft
    if json_output:
        typer.echo(json.dumps({"path": str(path), "size": path.stat().st_size}))
    else:
        typer.echo(str(path))


@app.command()
def caption_instead(path: str) -> None:
    """Generate text caption instead of image (v2 feature)."""
    typer.echo("v2 feature, not in v1")


@app.command()
def index(
    full: bool = typer.Option(False, "--full"),
    embeddings: bool = typer.Option(False, "--embeddings"),
    root: str | None = typer.Option(None, "--root", help="Index an arbitrary directory (skips project detection)"),
    skills: bool = typer.Option(False, "--skills", help="Index ~/.claude/skills/"),
    plugins: bool = typer.Option(False, "--plugins", help="Index ~/.claude/plugins/"),
) -> None:
    """Rebuild project/global indices."""
    from . import paths as _paths  # noqa: PLC0415
    from .parser import index_project  # noqa: PLC0415
    from .project import Project, find_project, make_project_at  # noqa: PLC0415

    proj: Project | None = None
    if root is not None:
        root_path = Path(root).expanduser().resolve()
        if not root_path.is_dir():
            typer.echo(f"Error: {root_path} is not a directory", err=True)
            raise typer.Exit(2)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing {root_path} ...")
    elif skills:
        root_path = _paths.claude_skills_dir()
        if not root_path.is_dir():
            typer.echo(f"Skills directory not found: {root_path}", err=True)
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing skills: {root_path} ...")
    elif plugins:
        root_path = _paths.claude_plugins_dir()
        if not root_path.is_dir():
            typer.echo(f"Plugins directory not found: {root_path}", err=True)
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing plugins: {root_path} ...")
    else:
        proj = find_project(Path.cwd())
        if proj is None:
            typer.echo("no project detected, run from a project directory")
            return

    assert proj is not None  # guaranteed: all branches either set proj or return/exit early

    def _progress(done: int, total: int) -> None:
        typer.echo(f"  {done}/{total} files processed...", err=True)

    summary = index_project(proj, full=full, progress=_progress)

    langs = ", ".join(summary["languages"]) if summary["languages"] else "none"
    typer.echo(
        f"Indexed {summary['total_files']} files "
        f"({summary['indexed']} indexed, "
        f"{summary['skipped_unchanged']} skipped unchanged, "
        f"{summary['errors']} errors) "
        f"— {langs} "
        f"— in {summary['duration_sec']}s"
    )

    if embeddings:
        from . import embeddings as emb  # noqa: PLC0415
        try:
            result = emb.index_project_embeddings(proj)
            typer.echo(
                f"Embeddings: {result['chunks_embedded']} new, "
                f"{result['chunks_skipped_unchanged']} unchanged "
                f"in {result['duration_sec']}s (model={result['model']})"
            )
        except emb.EmbeddingsUnavailable as e:
            typer.echo(f"Embeddings skipped: {e}")


@app.command()
def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Show cumulative token savings."""
    from . import stats as stats_mod  # noqa: PLC0415

    summary = stats_mod.summarize(window_days=window)
    if json_output:
        import json as jsonmod  # noqa: PLC0415

        typer.echo(
            jsonmod.dumps(
                {
                    "total_events": summary.total_events,
                    "total_bytes_saved": summary.total_bytes_saved,
                    "total_tokens_saved": summary.total_tokens_saved,
                    "by_kind": summary.by_kind,
                    "by_day": summary.by_day,
                    "by_project": summary.by_project,
                    "window_days": summary.window_days,
                },
                indent=2,
            )
        )
        return
    # Write directly, bypassing colorama's AnsiToWin32 wrapper which
    # misinterprets truecolor sequences (splits on `;` and processes
    # the R value as a legacy ANSI color code, turning green into red).
    _write_raw(stats_mod.render_text(summary))


@app.command()
def doctor() -> None:  # noqa: C901
    """Diagnose indexing health."""
    import importlib
    import sqlite3
    import subprocess
    import sys
    import time
    from datetime import date

    import psutil

    from . import db as _db
    from . import paths, project

    def ok(label: str, value: str) -> None:
        typer.echo(f"  {label}: {value}")

    def flag(label: str, value: str, *, warn: bool = False) -> None:
        prefix = "WARN" if warn else "FAIL"
        typer.echo(f"  [{prefix}] {label}: {value}")

    typer.echo("\ntokenwise doctor\n")

    # ------------------------------------------------------------------
    # 1. Versions
    # ------------------------------------------------------------------
    typer.echo("Versions")
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    ok("Python", py_ver)
    try:
        import importlib.metadata
        cc_ver = importlib.metadata.version("tokenwise")
    except Exception:  # noqa: BLE001
        cc_ver = "unknown"
    ok("tokenwise", cc_ver)
    try:
        uv_out = subprocess.run(
            ["uv", "--version"], capture_output=True, text=True, timeout=5
        )
        ok("uv", uv_out.stdout.strip() or "installed")
    except Exception:  # noqa: BLE001
        flag("uv", "not found", warn=True)

    # ------------------------------------------------------------------
    # 2. Paths
    # ------------------------------------------------------------------
    typer.echo("\nPaths")
    path_checks = [
        ("data_dir", paths.data_dir()),
        ("global.db", paths.global_db_path()),
        ("models_dir", paths.models_dir()),
        ("logs_dir", paths.logs_dir()),
    ]
    for label, p in path_checks:
        if p.exists():
            ok(label, str(p))
        else:
            flag(label, f"{p}  (missing)", warn=True)

    # ------------------------------------------------------------------
    # 3. SQLite
    # ------------------------------------------------------------------
    typer.echo("\nSQLite")
    ok("version", sqlite3.sqlite_version)
    # WAL check requires a real file — :memory: always returns "memory" mode.
    import tempfile  # noqa: PLC0415
    _wal_ok = False
    try:
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as _tf:
            _tf_path = _tf.name
        _wconn = sqlite3.connect(_tf_path, isolation_level=None)
        _wal_mode = _wconn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        _wconn.close()
        Path(_tf_path).unlink(missing_ok=True)
        _wal_ok = _wal_mode == "wal"
    except Exception:  # noqa: BLE001
        pass
    conn_test = sqlite3.connect(":memory:", isolation_level=None)
    if _wal_ok:
        ok("WAL", "yes")
    else:
        flag("WAL", "not supported or errored")
    try:
        conn_test.enable_load_extension(True)
        conn_test.enable_load_extension(False)
        ok("extensions", "yes")
        ext_ok = True
    except (AttributeError, sqlite3.OperationalError) as e:
        flag("extensions", f"no — {e}")
        ext_ok = False
    conn_test.close()

    # ------------------------------------------------------------------
    # 4. sqlite-vec
    # ------------------------------------------------------------------
    if ext_ok:
        try:
            import sqlite_vec  # noqa: PLC0415
            conn2 = sqlite3.connect(":memory:", isolation_level=None)
            conn2.enable_load_extension(True)
            sqlite_vec.load(conn2)
            conn2.enable_load_extension(False)
            vec_ver = conn2.execute("SELECT vec_version()").fetchone()[0]
            conn2.close()
            ok("sqlite-vec", vec_ver)
        except Exception as e:  # noqa: BLE001
            flag("sqlite-vec", f"failed — {e}")
    else:
        flag("sqlite-vec", "skipped (no extension support)", warn=True)

    # ------------------------------------------------------------------
    # 5. fastembed
    # ------------------------------------------------------------------
    try:
        importlib.import_module("fastembed")
        ok("fastembed", "importable")
    except ImportError as e:
        flag("fastembed", f"not importable — {e}")

    # ------------------------------------------------------------------
    # 6. Pillow
    # ------------------------------------------------------------------
    try:
        import PIL  # noqa: PLC0415
        ok("Pillow", PIL.__version__)
    except ImportError as e:
        flag("Pillow", f"not importable — {e}")

    # ------------------------------------------------------------------
    # 7. tree-sitter
    # ------------------------------------------------------------------
    try:
        import tree_sitter  # noqa: PLC0415
        ts_ver = getattr(tree_sitter, "__version__", "installed")
        try:
            importlib.import_module("tree_sitter_language_pack")
            ok("tree-sitter", f"{ts_ver} — language-pack importable")
        except ImportError:
            flag("tree-sitter", f"{ts_ver} — tree_sitter_language_pack missing", warn=True)
    except ImportError as e:
        flag("tree-sitter", f"not importable — {e}")

    # ------------------------------------------------------------------
    # 8. Project
    # ------------------------------------------------------------------
    typer.echo("\nProject")
    cwd = Path.cwd()
    ok("cwd", str(cwd))
    proj = project.find_project(cwd)
    if proj is not None:
        ok("detected", f"yes (marker: {proj.marker})")
        ok("hash", f"{proj.hash[:8]}...")
        try:
            with _db.open_project(proj.hash) as conn:
                row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                sv = row[0] if row else "?"
                fc_row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
                fc = fc_row[0] if fc_row else 0
            ok("schema_version", sv)
            ok("file_count", f"{fc} (not yet indexed)" if fc == 0 else str(fc))
        except Exception as e:  # noqa: BLE001
            flag("project db", str(e))
    else:
        flag("detected", "no project marker found in cwd or parents", warn=True)

    # ------------------------------------------------------------------
    # 9. Worker
    # ------------------------------------------------------------------
    typer.echo("\nWorker")
    pid_path = paths.worker_pid_path()
    hb_path = paths.worker_heartbeat_path()
    if pid_path.exists():
        try:
            pid_val = int(pid_path.read_text(encoding="utf-8").strip())
            if psutil.pid_exists(pid_val):
                ok("pid file", f"present (PID {pid_val})")
                if hb_path.exists():
                    hb_age = time.time() - hb_path.stat().st_mtime
                    if hb_age < 120:
                        ok("heartbeat", f"{int(hb_age)}s ago — fresh")
                    else:
                        flag("heartbeat", f"{int(hb_age)}s ago — stale", warn=True)
                else:
                    flag("heartbeat", "missing", warn=True)
            else:
                flag("pid file", f"present but PID {pid_val} not alive", warn=True)
        except Exception as e:  # noqa: BLE001
            flag("pid file", f"unreadable — {e}", warn=True)
    else:
        ok("pid file", "not present")
        ok("status", "not running")

    # ------------------------------------------------------------------
    # 10. Scheduled tasks / autostart
    # ------------------------------------------------------------------
    typer.echo("\nScheduled tasks")
    # Worker uses HKCU Run registry key (no admin required); update uses schtasks WEEKLY.
    import sys as _sys
    if _sys.platform == "win32":
        try:
            import winreg  # type: ignore[import]
            _rk = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_READ,
            )
            _val, _ = winreg.QueryValueEx(_rk, "tokenwise-worker")
            winreg.CloseKey(_rk)
            ok("tokenwise-worker", f"Run key: {_val}")
        except FileNotFoundError:
            flag("tokenwise-worker", "NOT INSTALLED (run `tokenwise install`)", warn=True)
        except Exception as _e:  # noqa: BLE001
            flag("tokenwise-worker", f"registry error: {_e}", warn=True)
    else:
        flag("tokenwise-worker", "non-Windows: skipped", warn=False)

    # ------------------------------------------------------------------
    # 11. Recent log
    # ------------------------------------------------------------------
    typer.echo("\nRecent log")
    today = date.today().strftime("%Y-%m-%d")
    log_file = paths.logs_dir() / f"{today}.log"
    if log_file.exists():
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
            for line in lines[-5:]:
                typer.echo(f"  {line}")
        except Exception as e:  # noqa: BLE001
            flag("log", str(e), warn=True)
    else:
        ok("(none)", "no log for today")

    # ------------------------------------------------------------------
    # 12. Stats summary
    # ------------------------------------------------------------------
    typer.echo("\nStats")
    try:
        with _db.open_global() as conn:
            row = conn.execute(
                "SELECT COUNT(*), SUM(tokens_saved), SUM(bytes_saved) FROM stats"
            ).fetchone()
        if row and row[0]:
            ok("events", str(row[0]))
            ok("tokens saved", str(row[1] or 0))
            ok("bytes saved", str(row[2] or 0))
        else:
            ok("(none)", "no recorded savings yet")
    except Exception as e:  # noqa: BLE001
        flag("stats", str(e), warn=True)

    typer.echo("")


@app.command("install")
def cmd_install(
    codex: bool = typer.Option(False, "--codex", help="Also install Codex CLI integration"),  # noqa: B008
) -> None:
    """One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog."""
    from . import install as inst  # noqa: PLC0415

    result = inst.install_all(install_codex=codex)
    typer.echo("tokenwise install:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")
    typer.echo("")
    typer.echo("All set. tokenwise will be invisible from here on.")
    typer.echo("Run `tokenwise doctor` anytime to check status.")
    typer.echo("Defender exclusion (optional, for max perf):")
    typer.echo(r'  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Zelys\tokenwise"')


@app.command("uninstall")
def cmd_uninstall(
    purge: bool = typer.Option(False, "--purge", help=r"Also delete %LOCALAPPDATA%\tokenwise"),  # noqa: B008
    codex: bool = typer.Option(False, "--codex", help="Also remove Codex CLI integration"),  # noqa: B008
) -> None:
    """Cleanly reverse install."""
    from . import install as inst  # noqa: PLC0415

    result = inst.uninstall_all(purge=purge, codex=codex)
    typer.echo("tokenwise uninstall:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")


@app.command("image-shrink", hidden=True)
def cmd_image_shrink(
    src: Path = typer.Argument(...),  # noqa: B008
    json_output: bool = typer.Option(False, "--json"),  # noqa: B008
) -> None:
    """Manually shrink an image (also used by hooks)."""
    from . import image_shrink  # noqa: PLC0415

    if not src.exists():
        typer.echo(f"File not found: {src}", err=True)
        raise typer.Exit(1)
    out = image_shrink.shrink(src)
    if out is None:
        typer.echo(f"Not shrunk (below threshold or not an image): {src}")
        raise typer.Exit(0)
    stats = image_shrink.stats_for(src, out)
    if json_output:
        import json as _json  # noqa: PLC0415

        typer.echo(
            _json.dumps({"shrunken_path": str(out), **stats})
        )
    else:
        typer.echo(
            f"{src} → {out} "
            f"({stats['src_bytes']:,} → {stats['out_bytes']:,} bytes, "
            f"saved {stats['bytes_saved']:,})"
        )


@app.command("worker", hidden=True)
def cmd_worker(
    daemon: bool = typer.Option(False, "--daemon", help="Run as background daemon (otherwise interactive)"),
) -> None:
    """Internal: background worker daemon. Should be invoked by the SessionStart watchdog, not directly."""
    from . import worker  # noqa: PLC0415

    worker.run_daemon()


# Hook entry points. Each one delegates to hooks_cli.safe_run, which is
# bulletproof: catches BaseException, always emits valid JSON, always exits 0.
# That way a hook never marks itself failed to Claude Code or Codex even when
# the underlying handler trips on an unexpected payload shape or environment.
#
# context_settings tells typer/click to ACCEPT any unknown options or extra
# positional args silently. Codex passes hook-specific args that vary between
# its versions; without this, typer would exit 2 ("No such option ...") before
# safe_run ever runs and the entire hook would appear to fail.

_HARNESS_OPT = typer.Option("claude", "--harness", help="Hook harness: claude or codex")
_INPUT_OPT = typer.Option(None, "--input-file")
_HOOK_CTX = {"ignore_unknown_options": True, "allow_extra_args": True}


@hook_app.command(context_settings=_HOOK_CTX)
def session_start(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: session-start event."""
    hooks_cli.safe_run("session-start", input_file, harness)


@hook_app.command(context_settings=_HOOK_CTX)
def pre_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-read event."""
    hooks_cli.safe_run("pre-read", input_file, harness)


@hook_app.command(context_settings=_HOOK_CTX)
def pre_fetch(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-fetch event."""
    hooks_cli.safe_run("pre-fetch", input_file, harness)


@hook_app.command(context_settings=_HOOK_CTX)
def post_edit(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-edit event."""
    hooks_cli.safe_run("post-edit", input_file, harness)


@hook_app.command(context_settings=_HOOK_CTX)
def post_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-read event."""
    hooks_cli.safe_run("post-read", input_file, harness)


@hook_app.command(context_settings=_HOOK_CTX)
def pre_compact(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-compact event."""
    hooks_cli.safe_run("pre-compact", input_file, harness)


@app.command("compact-hint")
def compact_hint(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = typer.Option(False, "--json"),
    max_tokens: int = typer.Option(400, "--max-tokens", help="Token budget for the manifest"),
) -> None:
    """Show the compaction manifest tokenwise would inject for a session.

    Use this to inspect what the PreCompact hook will emit as systemMessage
    before Claude Code compacts the conversation. Useful for debugging.
    """
    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415

    cfg = config_mod.load().compact_assist

    if json_output:
        import json as _json  # noqa: PLC0415

        n_events = compact_mod.event_count(session_id)
        manifest = compact_mod.build_manifest(session_id, max_tokens=max_tokens)
        typer.echo(_json.dumps({
            "enabled": cfg.enabled,
            "triggers": cfg.triggers,
            "min_events": cfg.min_events,
            "max_manifest_tokens": cfg.max_manifest_tokens,
            "event_count": n_events,
            "would_emit": cfg.enabled and n_events >= cfg.min_events and bool(manifest),
            "manifest": manifest,
        }, indent=2))
        return

    n_events = compact_mod.event_count(session_id)
    typer.echo(f"compact-assist enabled: {cfg.enabled}")
    typer.echo(f"triggers: {', '.join(cfg.triggers)}")
    typer.echo(f"min_events: {cfg.min_events}  |  session events: {n_events}")
    typer.echo("")

    if not cfg.enabled:
        typer.echo("(disabled — set TOKENWISE_COMPACT_ASSIST=1 or edit config.toml to enable)")
        return

    if n_events < cfg.min_events:
        typer.echo(f"(no manifest: {n_events} events < min_events {cfg.min_events})")
        return

    manifest = compact_mod.build_manifest(session_id, max_tokens=max_tokens)
    if not manifest:
        typer.echo("(no manifest: session cache empty)")
        return

    typer.echo("--- manifest that would be injected as systemMessage ---")
    typer.echo(manifest)
    typer.echo("---")
    typer.echo(f"({len(manifest)} chars, ~{len(manifest) // 4} tokens)")


@config_app.command()
def get(key: str) -> None:
    """Get config value."""
    typer.echo("not yet implemented: config get")


@config_app.command()
def set(key: str, value: str) -> None:
    """Set config value."""
    typer.echo("not yet implemented: config set")


if __name__ == "__main__":
    app()
