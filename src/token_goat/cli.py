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

from . import hooks_cli, read_commands

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


app = typer.Typer(name="token-goat", no_args_is_help=True)
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
        hint = read_commands._not_indexed_hint(proj.hash)
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
        hint = read_commands._not_indexed_hint(proj.hash)
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
            f"Embeddings unavailable ({e}). Try `token-goat index --embeddings` first, "
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
    read_commands.deps(file)


@app.command()
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


@app.command()
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
        typer.echo(f"File not found: {client_secrets}", err=True)
        raise typer.Exit(1)

    try:
        out_path = gdrive.run_oauth_oob_flow(client_secrets)
        typer.echo(f"Credentials saved to {out_path}. token-goat gdrive-fetch will work.")
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
    from . import cli_stats  # noqa: PLC0415

    cli_stats.stats(window=window, json_output=json_output)


@app.command()
def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
) -> None:
    from . import cli_doctor  # noqa: PLC0415

    cli_doctor.doctor(fix=fix)


@app.command("install")
def cmd_install(
    codex: bool = typer.Option(False, "--codex", help="Also install Codex CLI integration"),  # noqa: B008
) -> None:
    """One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog."""
    from . import install as inst  # noqa: PLC0415

    result = inst.install_all(install_codex=codex)
    typer.echo("token-goat install:")
    for step, detail in result.items():
        typer.echo(f"  {step}: {detail}")
    typer.echo("")
    typer.echo("All set. token-goat will be invisible from here on.")
    typer.echo("Run `token-goat doctor` anytime to check status.")
    typer.echo("Defender exclusion (optional, for max perf):")
    typer.echo(r'  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Zelys\token-goat"')


@app.command("uninstall")
def cmd_uninstall(
    purge: bool = typer.Option(False, "--purge", help=r"Also delete %LOCALAPPDATA%\Zelys\token-goat"),  # noqa: B008
    codex: bool = typer.Option(False, "--codex", help="Also remove Codex CLI integration"),  # noqa: B008
) -> None:
    """Cleanly reverse install."""
    from . import install as inst  # noqa: PLC0415

    result = inst.uninstall_all(purge=purge, codex=codex)
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
