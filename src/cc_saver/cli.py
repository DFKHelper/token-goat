"""Typer CLI with stub subcommands."""
from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path

import typer

from . import hooks_cli

app = typer.Typer(name="cc-saver", no_args_is_help=True)
hook_app = typer.Typer(name="hook", no_args_is_help=True)
config_app = typer.Typer(name="config", no_args_is_help=True)

app.add_typer(hook_app)
app.add_typer(config_app)


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
            f"Embeddings unavailable ({e}). Try `cc-saver index --embeddings` first, "
            "or use `cc-saver symbol`/`cc-saver map` for non-semantic navigation."
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
def deps(file: str):
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
    if proj is None:
        typer.echo("No project detected.", err=True)
        raise typer.Exit(0)

    rel = read_replacement.resolve_file_rel(proj, file_part)
    if rel is None:
        typer.echo(f"File not found in indexed project: {file_part}", err=True)
        raise typer.Exit(0)

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
    if proj is None:
        typer.echo("No project detected.", err=True)
        raise typer.Exit(0)

    rel = read_replacement.resolve_file_rel(proj, file_part)
    if rel is None:
        typer.echo(f"File not found in indexed project: {file_part}", err=True)
        raise typer.Exit(0)

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
):
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
):
    """Manually mark a file/range as read for the given session. (Mostly used by hooks.)"""
    from . import session as session_mod  # noqa: PLC0415

    session_mod.mark_file_read(session_id, file_path, offset or None, limit or None)
    typer.echo("ok")


@app.command()
def gdrive_fetch(file_id: str):
    """Fetch image from Google Drive by ID."""
    typer.echo("not yet implemented: gdrive-fetch")


@app.command()
def fetch_image(url: str):
    """Cache image from URL locally."""
    typer.echo("not yet implemented: fetch-image")


@app.command()
def caption_instead(path: str):
    """Generate text caption instead of image (v2 feature)."""
    typer.echo("v2 feature, not in v1")


@app.command()
def index(
    full: bool = typer.Option(False, "--full"),
    embeddings: bool = typer.Option(False, "--embeddings"),
) -> None:
    """Rebuild project/global indices."""
    from .parser import index_project  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    proj = find_project(Path.cwd())
    if proj is None:
        typer.echo("no project detected, run from a project directory")
        return

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
def stats():
    """Show token savings and cache stats."""
    typer.echo("not yet implemented: stats")


@app.command()
def doctor():  # noqa: C901
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

    typer.echo("\ncc-saver doctor\n")

    # ------------------------------------------------------------------
    # 1. Versions
    # ------------------------------------------------------------------
    typer.echo("Versions")
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    ok("Python", py_ver)
    try:
        import importlib.metadata
        cc_ver = importlib.metadata.version("cc-saver")
    except Exception:  # noqa: BLE001
        cc_ver = "unknown"
    ok("cc-saver", cc_ver)
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
            importlib.import_module("tree_sitter_languages")
            ok("tree-sitter", f"{ts_ver} — language-pack importable")
        except ImportError:
            flag("tree-sitter", f"{ts_ver} — tree_sitter_languages missing", warn=True)
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
    # 10. Scheduled tasks
    # ------------------------------------------------------------------
    typer.echo("\nScheduled tasks")
    try:
        sched_out = subprocess.run(
            ["schtasks", "/query", "/tn", "cc-saver-worker"],
            capture_output=True, text=True, timeout=10,
        )
        if sched_out.returncode == 0:
            lines = [ln.strip() for ln in sched_out.stdout.splitlines() if ln.strip()]
            state_line = next(
                (ln for ln in lines if "Status" in ln or "Ready" in ln or "Running" in ln), None
            )
            ok("cc-saver-worker", state_line or "found")
        else:
            flag("cc-saver-worker", "NOT INSTALLED (run `cc-saver install`)", warn=True)
    except Exception:  # noqa: BLE001
        flag("cc-saver-worker", "NOT INSTALLED (run `cc-saver install`)", warn=True)

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


@app.command()
def install():
    """Install hook entrypoints and Windows Scheduled Task."""
    typer.echo("not yet implemented: install")


@app.command()
def uninstall(purge: bool = typer.Option(False, "--purge")):
    """Uninstall hook entrypoints and Scheduled Task."""
    typer.echo("not yet implemented: uninstall")


@app.command("worker", hidden=True)
def cmd_worker(
    daemon: bool = typer.Option(False, "--daemon", help="Run as background daemon (otherwise interactive)"),
) -> None:
    """Internal: background worker daemon. Should be invoked by the SessionStart watchdog, not directly."""
    from . import worker  # noqa: PLC0415

    worker.run_daemon()


@hook_app.command()
def session_start(input_file: Path | None = typer.Option(None, "--input-file")):  # noqa: B008
    """Hook: session-start event."""
    try:
        payload = hooks_cli.read_payload(input_file)
        result = hooks_cli.dispatch("session-start", payload)
    except Exception:  # noqa: BLE001
        result = {"continue": True}
    hooks_cli.emit(result)


@hook_app.command()
def pre_read(input_file: Path | None = typer.Option(None, "--input-file")):  # noqa: B008
    """Hook: pre-read event."""
    try:
        payload = hooks_cli.read_payload(input_file)
        result = hooks_cli.dispatch("pre-read", payload)
    except Exception:  # noqa: BLE001
        result = {"continue": True}
    hooks_cli.emit(result)


@hook_app.command()
def pre_fetch(input_file: Path | None = typer.Option(None, "--input-file")):  # noqa: B008
    """Hook: pre-fetch event."""
    try:
        payload = hooks_cli.read_payload(input_file)
        result = hooks_cli.dispatch("pre-fetch", payload)
    except Exception:  # noqa: BLE001
        result = {"continue": True}
    hooks_cli.emit(result)


@hook_app.command()
def post_edit(input_file: Path | None = typer.Option(None, "--input-file")):  # noqa: B008
    """Hook: post-edit event."""
    try:
        payload = hooks_cli.read_payload(input_file)
        result = hooks_cli.dispatch("post-edit", payload)
    except Exception:  # noqa: BLE001
        result = {"continue": True}
    hooks_cli.emit(result)


@hook_app.command()
def post_read(input_file: Path | None = typer.Option(None, "--input-file")):  # noqa: B008
    """Hook: post-read event."""
    try:
        payload = hooks_cli.read_payload(input_file)
        result = hooks_cli.dispatch("post-read", payload)
    except Exception:  # noqa: BLE001
        result = {"continue": True}
    hooks_cli.emit(result)


@config_app.command()
def get(key: str):
    """Get config value."""
    typer.echo("not yet implemented: config get")


@config_app.command()
def set(key: str, value: str):
    """Set config value."""
    typer.echo("not yet implemented: config set")


if __name__ == "__main__":
    app()
