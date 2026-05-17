"""Typer CLI with stub subcommands."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, get_args

if TYPE_CHECKING:
    from .project import Project

# Force UTF-8 on stdout/stderr (Windows defaults to cp1252 which can't encode
# the punctuation we use in maps, hints, and stats: → ›  etc.).
# `.reconfigure` exists on TextIOWrapper but not on the generic TextIO base.
# contextlib.suppress(AttributeError) handles environments where it isn't there.
with contextlib.suppress(AttributeError, OSError):
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
with contextlib.suppress(AttributeError, OSError):
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

import typer

from . import config as config_mod
from . import hooks_cli, read_commands

_LOG = logging.getLogger(__name__)


def _error(msg: str) -> None:
    """Print a user-facing error message to stderr with a consistent 'Error: ' prefix.

    On a TTY the prefix is rendered in red (ANSI 31); in a pipe or when NO_COLOR
    is set the message is plain text so it stays grep-friendly and CI-safe.
    """
    if sys.stderr.isatty() and not os.environ.get("NO_COLOR"):
        prefix = "\033[31mError:\033[0m "
    else:
        prefix = "Error: "
    typer.echo(f"{prefix}{msg}", err=True)


def _warn(msg: str) -> None:
    """Print a user-facing warning to stderr with a consistent 'Warning: ' prefix."""
    if sys.stderr.isatty() and not os.environ.get("NO_COLOR"):
        prefix = "\033[33mWarning:\033[0m "
    else:
        prefix = "Warning: "
    typer.echo(f"{prefix}{msg}", err=True)


def _require_project(
    msg: str = "no project detected — run from a project directory",
) -> Project:
    """Return the current project or exit with code 1.

    Centralises the repeated pattern::

        proj = find_project(Path.cwd())
        if proj is None:
            _error("...")
            raise typer.Exit(1)

    All callers that import ``find_project`` at module scope can use this
    instead; it performs the import lazily so startup time is unaffected.
    """
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    if proj is None:
        _error(msg)
        raise typer.Exit(1)
    return proj


def _emit_json(data: Any, *, indent: int | None = None) -> None:
    """Echo ``data`` as JSON and raise ``typer.Exit(0)``.

    Centralises the repeated ``if json_output: typer.echo(json.dumps(...)); return``
    pattern.  Callers should invoke this inside an ``if json_output:`` block::

        if json_output:
            _emit_json(results)
    """
    typer.echo(json.dumps(data, indent=indent))
    raise typer.Exit(0)


def _query_project(proj_hash: str, sql: str, params: tuple[object, ...]) -> list[Any]:
    """Run a SELECT against the project DB, exiting on DBError.

    Centralises the repeated pattern::

        try:
            with _db.open_project(proj.hash) as conn:
                rows = conn.execute(sql, params).fetchall()
        except _db.DBError as exc:
            _error(f"project index unavailable: {exc}. Run ...")
            raise typer.Exit(1) from None

    Returns the raw sqlite3.Row list on success.
    """
    from . import db as _db  # noqa: PLC0415

    try:
        with _db.open_project(proj_hash) as conn:
            return conn.execute(sql, params).fetchall()
    except _db.DBError as exc:
        _error(f"project index unavailable: {exc}. Run `token-goat index --full` to rebuild.")
        raise typer.Exit(1) from None


app = typer.Typer(name="token-goat", no_args_is_help=True)
hook_app = typer.Typer(name="hook", no_args_is_help=True)
config_app = typer.Typer(name="config", no_args_is_help=True)

app.add_typer(hook_app, hidden=True)
app.add_typer(config_app, rich_help_panel="Config")


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
@app.command(rich_help_panel="Core")
def symbol(
    name: str,
    all_projects: bool = typer.Option(False, "--all-projects"),
    as_json: bool = typer.Option(False, "--json"),
    limit: int = typer.Option(50, "--limit"),
) -> None:
    """Find a symbol definition by name (function, class, method, type, constant, etc.).

    Searches the indexed project for functions, classes, methods, variables, types, and
    other named definitions matching the given name. Use ``--all-projects`` to search
    across all indexed projects (useful for skills and plugins). Use ``--limit`` to
    control max results (default 50)."""
    from . import db as _db  # noqa: PLC0415

    use_tty_color = sys.stdout.isatty() and not as_json

    def _fmt_plain(rows: list[dict]) -> None:
        """Print symbol rows as plain text, optionally with ANSI colour when stdout is a TTY."""
        for row in rows:
            project_prefix = f"[{row.get('project', '')}] " if "project" in row else ""
            sig_part = f"  {row['signature']}" if row.get("signature") else ""
            kind_name = f"{row['kind']} {row['name']}"
            if use_tty_color:
                kind_name = f"\033[90m{kind_name}\033[0m"
                sig_part = f"\033[2m{sig_part}\033[0m"
            typer.echo(f"{project_prefix}{row['file']}:{row['line']}: {kind_name}{sig_part}")

    if all_projects:
        try:
            with _db.open_global() as gconn:
                rows_raw = gconn.execute(
                    "SELECT sg.project_hash, p.root, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature "
                    "FROM symbols_global sg "
                    "JOIN projects p ON p.hash = sg.project_hash "
                    "WHERE sg.name = ? LIMIT ?",
                    (name, limit),
                ).fetchall()
        except _db.DBError as exc:
            _error(f"global index unavailable: {exc}. Run `token-goat index` first.")
            raise typer.Exit(1) from None
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

    proj = _require_project()

    rows_raw = _query_project(
        proj.hash,
        "SELECT name, kind, file_rel, line, signature FROM symbols WHERE name = ? LIMIT ?",
        (name, limit),
    )

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
        hint = read_commands._not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        else:
            typer.echo(f"No matches for {name!r}")


@app.command(rich_help_panel="Core")
def ref(
    name: str,
    as_json: bool = typer.Option(False, "--json"),
    limit: int = typer.Option(100, "--limit"),
) -> None:
    """Find all code references to a symbol by name.

    Locates every place in the codebase where the given symbol is referenced
    (called, imported, assigned, etc.). Results include file path, line number,
    column, and surrounding context. Use ``--limit`` to cap results (default 100)."""
    proj = _require_project()

    rows_raw = _query_project(
        proj.hash,
        "SELECT file_rel, line, col, context FROM refs WHERE symbol_name = ? LIMIT ?",
        (name, limit),
    )

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
        hint = read_commands._not_indexed_hint(proj.hash)
        if hint:
            typer.echo(hint)
        else:
            typer.echo(f"No references found for {name!r}")


@app.command(rich_help_panel="Core")
def semantic(
    query: str = typer.Argument(...),
    k: int = typer.Option(5, "-k", help="Top-k results"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Semantic search using local embeddings (fastembed + sqlite-vec)."""
    from . import embeddings  # noqa: PLC0415

    proj = _require_project()

    try:
        hits = embeddings.semantic_search(proj, query, k=k)
    except embeddings.EmbeddingsUnavailable as e:
        _warn(
            f"embeddings unavailable ({e}). Try `token-goat index --embeddings` first, "
            "or use `token-goat symbol`/`token-goat map` for non-semantic navigation."
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


@app.command("map", rich_help_panel="Core")
def cmd_map(
    budget: int = typer.Option(4000, "--budget", "-b", help="Approximate token budget"),
    json_output: bool = typer.Option(False, "--json", help="Output structured JSON"),
) -> None:
    """Generate a PageRank-ranked, token-budgeted overview of the current project."""
    from . import repomap  # noqa: PLC0415

    proj = _require_project(
        "no project detected (no .git, package.json, etc. found). "
        "Run from a project directory."
    )

    try:
        if json_output:
            data = repomap.build_map_json(proj)
            typer.echo(json.dumps(data, indent=2))
            return
        text = repomap.build_map(proj, budget_tokens=budget)
        typer.echo(text)
    except Exception as exc:  # noqa: BLE001
        _error(f"failed to build repo map: {exc}. Try `token-goat index --full` to rebuild the index.")
        raise typer.Exit(1) from None


@app.command(rich_help_panel="Core")
def deps(
    file: str,
    json_output: bool = typer.Option(False, "--json"),
    depth: int = typer.Option(1, "--depth", "-d", help="Transitive depth (1=direct, 0=unlimited)"),
) -> None:
    """Show the dependency graph (imports and references) for a file.

    Lists all modules and symbols that the given file imports, depends on, or
    references. Use ``--depth`` to control transitive depth (1=direct imports,
    0=unlimited recursion)."""
    read_commands.deps(file, json_output=json_output, depth=depth)


@app.command(rich_help_panel="Core")
def read(
    target: str = typer.Argument(..., help="<file>::<symbol> — e.g., 'parser.py::index_project'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Read just <symbol> from <file>, not the whole file."""
    read_commands.read(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
    )


@app.command(rich_help_panel="Core")
def section(
    target: str = typer.Argument(..., help="<file>::<heading> — e.g., 'README.md::Install'"),
    session_id: str | None = typer.Option(None, "--session-id", "-s"),
    json_output: bool = typer.Option(False, "--json"),
    context_lines: int = typer.Option(0, "--context", "-c", help="Extra lines before/after"),
) -> None:
    """Extract just <heading> section from <file>, not the whole file."""
    read_commands.section(
        target=target,
        session_id=session_id,
        json_output=json_output,
        context_lines=context_lines,
    )


@app.command("session-touched", rich_help_panel="Advanced")
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


@app.command("session-mark", rich_help_panel="Advanced", hidden=True)
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


@app.command("gdrive-fetch", hidden=True)
def cmd_gdrive_fetch(
    file_id: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Fetch a Google Drive file (image gets auto-shrunk). Returns the local path."""
    from . import gdrive  # noqa: PLC0415

    try:
        path = gdrive.fetch_file(file_id)
    except gdrive.GDriveCredsUnavailable as e:
        _warn(str(e))
        raise typer.Exit(0) from None  # fail-soft: don't break Claude's session
    except Exception as e:  # noqa: BLE001
        _warn(f"Drive fetch failed: {e}")
        raise typer.Exit(0) from None
    if json_output:
        typer.echo(json.dumps({"path": str(path), "size": path.stat().st_size}))
    else:
        typer.echo(str(path))


@app.command("gdrive-auth", hidden=True)
def cmd_gdrive_auth(
    client_secrets: Path | None = typer.Option(None, "--client-secrets", help="Path to OAuth client_secrets.json"),  # noqa: B008
) -> None:
    """One-time Google Drive auth setup. Tries ADC first, then OAuth flow."""
    from . import gdrive  # noqa: PLC0415

    # Check ADC
    creds = gdrive._try_adc()
    if creds is not None:
        typer.echo("Google Application Default Credentials detected. token-goat gdrive-fetch will work.")
        raise typer.Exit(0)

    # Check existing stored creds
    creds = gdrive._try_stored_oauth()
    if creds is not None:
        typer.echo("Stored OAuth credentials valid. token-goat gdrive-fetch will work.")
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
        typer.echo("       token-goat gdrive-auth --client-secrets path/to/client_secret.json")
        typer.echo("")
        typer.echo("Option C: skip — token-goat gdrive-fetch will fall back to a clear error,")
        typer.echo("and Claude's existing Drive MCP will be used directly (no token-savings).")
        raise typer.Exit(0)

    if not client_secrets.exists():
        _error(f"file not found: {client_secrets}")
        raise typer.Exit(1)

    try:
        out_path = gdrive.run_oauth_oob_flow(client_secrets)
        typer.echo(f"Credentials saved to {out_path}. token-goat gdrive-fetch will work.")
    except Exception as e:  # noqa: BLE001
        _error(f"OAuth flow failed: {e}")
        raise typer.Exit(1) from None


@app.command("fetch-image", hidden=True)
def cmd_fetch_image(
    url: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Fetch an image URL (auto-shrunk). Returns the local cached path."""
    from . import webfetch  # noqa: PLC0415

    try:
        path = webfetch.fetch_url(url)
    except Exception as e:  # noqa: BLE001
        _warn(f"WebFetch failed: {e}")
        raise typer.Exit(0) from None  # fail-soft
    if json_output:
        typer.echo(json.dumps({"path": str(path), "size": path.stat().st_size}))
    else:
        typer.echo(str(path))


@app.command(hidden=True)
def caption_instead(path: str) -> None:
    """Generate text caption instead of image (v2 feature)."""
    typer.echo("v2 feature, not in v1")


@app.command(rich_help_panel="Core")
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
    from .project import find_project, make_project_at  # noqa: PLC0415

    proj: Project | None = None
    if root is not None:
        root_path = Path(root).expanduser().resolve()
        if not root_path.is_dir():
            _error(f"{root_path} is not a directory")
            raise typer.Exit(2)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing {root_path} ...")
    elif skills:
        root_path = _paths.claude_skills_dir()
        if not root_path.is_dir():
            _error(f"skills directory not found: {root_path}")
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing skills: {root_path} ...")
    elif plugins:
        root_path = _paths.claude_plugins_dir()
        if not root_path.is_dir():
            _error(f"plugins directory not found: {root_path}")
            raise typer.Exit(1)
        proj = make_project_at(root_path)
        typer.echo(f"Indexing plugins: {root_path} ...")
    else:
        proj = find_project(Path.cwd())
        if proj is None:
            _error("no project detected — run from a project directory")
            raise typer.Exit(1)

    assert proj is not None  # guaranteed: all branches either set proj or return/exit early

    def _progress(done: int, total: int) -> None:
        """Emit an indexing progress line to stderr."""
        typer.echo(f"  {done}/{total} files processed...", err=True)

    try:
        summary = index_project(proj, full=full, progress=_progress)
    except Exception as exc:  # noqa: BLE001
        _error(f"indexing failed: {exc}")
        raise typer.Exit(1) from None

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


@app.command(rich_help_panel="Core")
def stats(
    window: int = typer.Option(30, "--window", "-w", help="Days to include (0 = all time)"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Show cumulative token savings."""
    from . import cli_stats  # noqa: PLC0415

    cli_stats.stats(window=window, json_output=json_output)


@app.command(rich_help_panel="Install")
def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
) -> None:
    """Diagnose the health of the token-goat installation and indices.

    Runs checks on Python version, dependencies, database integrity, hook registration,
    worker status, and project indices. Use ``--fix`` to clear stale ``.indexing``
    spawn markers (same reaping the background worker does on startup).
    """
    from . import cli_doctor  # noqa: PLC0415

    cli_doctor.doctor(fix=fix)


@app.command("install", rich_help_panel="Install")
def cmd_install(
    codex: bool = typer.Option(False, "--codex", help="Also install Codex CLI integration"),  # noqa: B008
    opencode: bool = typer.Option(False, "--opencode", help="Also install opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also install openclaw plugin bridge"),  # noqa: B008
) -> None:
    """One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog."""
    from . import install as inst  # noqa: PLC0415

    # Show current integration state before making changes
    status = inst.check_status()
    typer.echo("Current integration status:")
    for integration, state in status.items():
        icon = "+" if state == "installed" else "-"
        typer.echo(f"  [{icon}] {integration}: {state}")
    typer.echo("")

    result = inst.install_all(install_codex=codex, install_opencode=opencode, install_openclaw=openclaw)
    typer.echo("token-goat install:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")
    typer.echo("")
    typer.echo("All set. token-goat will be invisible from here on.")
    typer.echo("Run `token-goat doctor` anytime to check status.")
    typer.echo("Defender exclusion (optional, for max perf):")
    typer.echo(r'  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\dfk-helper\token-goat"')


@app.command("uninstall", rich_help_panel="Install")
def cmd_uninstall(
    purge: bool = typer.Option(False, "--purge", help=r"Also delete %LOCALAPPDATA%\dfk-helper\token-goat"),  # noqa: B008
    codex: bool = typer.Option(False, "--codex", help="Also remove Codex CLI integration"),  # noqa: B008
    opencode: bool = typer.Option(False, "--opencode", help="Also remove opencode plugin bridge"),  # noqa: B008
    openclaw: bool = typer.Option(False, "--openclaw", help="Also remove openclaw plugin bridge"),  # noqa: B008
) -> None:
    """Cleanly reverse install."""
    from . import install as inst  # noqa: PLC0415

    result = inst.uninstall_all(purge=purge, codex=codex, opencode=opencode, openclaw=openclaw)
    typer.echo("token-goat uninstall:")
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
        _error(f"file not found: {src}")
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
    from . import worker_daemon  # noqa: PLC0415

    worker_daemon.run_daemon()


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

_VALID_HARNESSES = get_args(hooks_cli.Harness)


def _parse_harness(raw: str) -> hooks_cli.Harness:
    """Validate and narrow a raw CLI harness string to the ``Harness`` literal type.

    Typer infers the ``harness`` parameter as ``str`` from the option default, so
    mypy cannot prove the value is a valid ``Harness`` literal.  This helper
    performs a runtime check and returns the narrowed type, giving mypy a
    concrete ``Harness`` at every :func:`~token_goat.hooks_cli.safe_run` call site.

    Unknown values fall back to ``"claude"`` (the safe default) so an unrecognised
    ``--harness`` flag from a newer harness version does not abort the hook.
    """
    if raw in _VALID_HARNESSES:
        return raw  # type: ignore[return-value]  # membership check proves the Literal constraint
    _LOG.debug("unknown harness %r; defaulting to 'claude'", raw)
    return "claude"


@hook_app.command(context_settings=_HOOK_CTX)
def session_start(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: session-start event."""
    hooks_cli.safe_run("session-start", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-read event."""
    hooks_cli.safe_run("pre-read", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_fetch(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-fetch event."""
    hooks_cli.safe_run("pre-fetch", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_edit(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-edit event."""
    hooks_cli.safe_run("post-edit", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def post_read(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: post-read event."""
    hooks_cli.safe_run("post-read", input_file, _parse_harness(harness))


@hook_app.command(context_settings=_HOOK_CTX)
def pre_compact(
    input_file: Path | None = _INPUT_OPT,
    harness: str = _HARNESS_OPT,
) -> None:
    """Hook: pre-compact event."""
    hooks_cli.safe_run("pre-compact", input_file, _parse_harness(harness))


@app.command("compact-hint", rich_help_panel="Advanced")
def compact_hint(
    session_id: str = typer.Option(..., "--session-id", "-s", help="Claude session_id"),
    json_output: bool = typer.Option(False, "--json"),
    max_tokens: int = typer.Option(400, "--max-tokens", help="Token budget for the manifest"),
) -> None:
    """Show the compaction manifest token-goat would inject for a session.

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
        typer.echo("(disabled — set TOKEN_GOAT_COMPACT_ASSIST=1 or edit config.toml to enable)")
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


def _config_get_value(config: Any, key: str) -> Any:
    """Retrieve a nested config attribute by dotted key (e.g. ``"compact_assist.enabled"``).

    Walks the dataclass hierarchy attribute-by-attribute and returns the leaf
    value.  Raises ``KeyError`` if any component of *key* is absent.
    """
    target: Any = config
    parts = [part for part in key.split(".") if part]
    if not parts:
        raise KeyError(key)
    for part in parts:
        if not hasattr(target, part):
            raise KeyError(key)
        target = getattr(target, part)
    return target


def _coerce_config_value(current: Any, raw_value: str) -> Any:
    """Coerce *raw_value* (a CLI string) to the same type as *current*.

    Dispatch table:
    - dataclass → parsed from JSON object
    - bool      → accepts ``1/true/yes/on`` or ``0/false/no/off``
    - int       → ``int(raw_value)``
    - list      → JSON array literal or comma-separated string
    - str       → returned as-is (stripped)

    Raises ``ValueError`` for invalid inputs.
    """
    raw_value = raw_value.strip()

    if is_dataclass(current):
        parsed = json.loads(raw_value)
        if not isinstance(parsed, dict):
            raise ValueError("expected a JSON object")
        return current.__class__(**parsed)

    if isinstance(current, bool):
        lowered = raw_value.lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
        raise ValueError("expected a boolean value")

    if isinstance(current, int) and not isinstance(current, bool):
        return int(raw_value)

    if isinstance(current, list):
        if raw_value.startswith("["):
            parsed = json.loads(raw_value)
            if not isinstance(parsed, list):
                raise ValueError("expected a JSON list")
            return [str(item) for item in parsed]
        if not raw_value:
            return []
        return [part.strip() for part in raw_value.split(",") if part.strip()]

    return raw_value


def _config_set_value(config: config_mod.Config, key: str, raw_value: str) -> Any:
    """Set a nested config attribute by dotted key, coercing *raw_value* to the right type.

    Navigates the dataclass hierarchy to the parent of the leaf attribute, calls
    :func:`_coerce_config_value` to convert the string, then uses ``setattr`` to
    mutate *config* in place.  Returns the coerced value so callers can echo it.
    Raises ``KeyError`` if any path component is missing.
    """
    parts = [part for part in key.split(".") if part]
    if not parts:
        raise KeyError(key)

    target: Any = config
    for part in parts[:-1]:
        if not hasattr(target, part):
            raise KeyError(key)
        target = getattr(target, part)

    attr = parts[-1]
    if not hasattr(target, attr):
        raise KeyError(key)

    current = getattr(target, attr)
    updated = _coerce_config_value(current, raw_value)
    setattr(target, attr, updated)
    return updated


@config_app.command(name="list")
def config_list(
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """List all config keys with their current values and defaults."""
    defaults = config_mod.Config()
    current = config_mod.load()

    # Flatten a dataclass to dotted-key -> value pairs
    def _flatten(obj: Any, prefix: str = "") -> list[tuple[str, Any]]:
        """Recursively expand a dataclass into ``(dotted_key, value)`` pairs."""
        from dataclasses import fields as _fields  # noqa: PLC0415
        pairs: list[tuple[str, Any]] = []
        for f in _fields(obj):
            key = f"{prefix}{f.name}" if not prefix else f"{prefix}.{f.name}"
            val = getattr(obj, f.name)
            if is_dataclass(val) and not isinstance(val, type):
                pairs.extend(_flatten(val, prefix=key))
            else:
                pairs.append((key, val))
        return pairs

    default_pairs = dict(_flatten(defaults))
    current_pairs = dict(_flatten(current))

    if json_output:
        out = {
            k: {"value": current_pairs[k], "default": default_pairs[k]}
            for k in current_pairs
        }
        typer.echo(json.dumps(out, ensure_ascii=False, indent=2))
        return

    # Human-readable table
    col_key = max(len(k) for k in current_pairs) + 2
    for k in current_pairs:
        cur = current_pairs[k]
        dflt = default_pairs[k]
        cur_str = json.dumps(cur, ensure_ascii=False)
        dflt_str = json.dumps(dflt, ensure_ascii=False)
        changed = cur != dflt
        marker = "*" if changed else " "
        if sys.stdout.isatty() and not os.environ.get("NO_COLOR"):
            key_fmt = f"\033[36m{k}\033[0m"
            cur_fmt = f"\033[33m{cur_str}\033[0m" if changed else cur_str
        else:
            key_fmt = k
            cur_fmt = cur_str
        typer.echo(f"{marker} {key_fmt:<{col_key + 9}} {cur_fmt}  (default: {dflt_str})")


@config_app.command()
def get(key: str) -> None:
    """Get config value."""
    cfg = config_mod.load()
    try:
        value = _config_get_value(cfg, key)
    except KeyError:
        typer.echo(f"Unknown config key: {key}", err=True)
        raise typer.Exit(2) from None

    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)

    typer.echo(json.dumps(value, ensure_ascii=False, indent=2))


@config_app.command()
def set(key: str, value: str) -> None:
    """Set config value."""
    cfg = config_mod.load()
    try:
        updated = _config_set_value(cfg, key, value)
    except KeyError:
        typer.echo(f"Unknown config key: {key}", err=True)
        raise typer.Exit(2) from None
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        typer.echo(f"Invalid value for {key}: {exc}", err=True)
        raise typer.Exit(2) from None

    config_mod.save(cfg)
    if is_dataclass(updated) and not isinstance(updated, type):
        updated = asdict(updated)
    typer.echo(json.dumps(updated, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    app()
