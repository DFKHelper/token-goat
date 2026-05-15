"""Doctor CLI helpers."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import typer


def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
) -> None:
    """Diagnose indexing health.

    Pass ``--fix`` to also clear the stale ``.indexing`` spawn markers doctor
    flags — the same reaping the worker does on startup, available on demand
    for when the worker is down.
    """
    import importlib
    import sqlite3
    import subprocess
    import sys
    import time

    import psutil

    from . import db as _db
    from . import paths, project

    def ok(label: str, value: str) -> None:
        """Print a passing doctor-check line (plain indented ``label: value``)."""
        typer.echo(f"  {label}: {value}")

    def flag(label: str, value: str, *, warn: bool = False) -> None:
        """Print a failing or warning doctor-check line prefixed with [FAIL] or [WARN]."""
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

    def _wal_supported() -> bool:
        try:
            with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
                tf_path = tf.name
            conn = sqlite3.connect(tf_path, isolation_level=None)
            mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            conn.close()
            Path(tf_path).unlink(missing_ok=True)
            return mode == "wal"
        except Exception:  # noqa: BLE001
            return False

    conn_test = sqlite3.connect(":memory:", isolation_level=None)
    if _wal_supported():
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

    # Worker claim file — the authoritative single-worker lock. A stale claim
    # left by a crashed worker is auto-reclaimed on the next spawn, but it is
    # worth surfacing so an unexpected one is visible.
    from . import worker as _worker  # noqa: PLC0415

    claim_path = _worker._worker_claim_path()
    if not claim_path.exists():
        ok("claim file", "not present")
    elif _worker._worker_claim_is_stale(claim_path):
        flag("claim file", "stale (owner gone) — auto-reclaimed on next spawn", warn=True)
    else:
        try:
            claim_pid = int(claim_path.read_text(encoding="utf-8").split("\n", 1)[0])
            ok("claim file", f"held by live PID {claim_pid}")
        except (OSError, ValueError):
            ok("claim file", "held (owner mid-startup)")

    # Index-spawn markers (locks/{hash}.indexing). A stale marker is harmless
    # — _index_spawn_active() ignores it — but a pile of them hints at indexers
    # that crashed or were killed. With --fix, reap them here (the same logic
    # the worker runs on startup) rather than only reporting them.
    locks_dir = paths.locks_dir()
    if fix:
        reaped = _worker.reap_stale_index_markers()
        ok("index markers", f"reaped {reaped} stale marker(s)")
    markers = sorted(locks_dir.glob("*.indexing")) if locks_dir.exists() else []
    if not markers:
        ok("index markers", "none")
    else:
        for m in markers:
            if _worker._index_spawn_active(m):
                ok("index marker", f"{m.stem[:8]} — index spawn active")
            else:
                flag("index marker", f"{m.stem[:8]} — stale, safe to delete", warn=True)

    # ------------------------------------------------------------------
    # 10. Dirty queue
    # ------------------------------------------------------------------
    typer.echo("\nDirty queue")
    queue_path = paths.dirty_queue_path()
    if not queue_path.exists():
        ok("depth", "0 (no queue file)")
    else:
        try:
            depth = sum(
                1 for ln in queue_path.read_text(encoding="utf-8").splitlines() if ln.strip()
            )
        except OSError as e:
            flag("depth", f"unreadable — {e}", warn=True)
        else:
            if depth == 0:
                ok("depth", "0 (empty)")
            elif depth < 200:
                ok("depth", f"{depth} pending (worker drains on next poll)")
            else:
                flag("depth", f"{depth} pending — worker may be down or behind", warn=True)

    # ------------------------------------------------------------------
    # 11. Scheduled tasks / autostart
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
    # 12. Recent log
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
    # 13. Stats summary
    # ------------------------------------------------------------------
    typer.echo("\nStats")
    try:
        with _db.open_global() as conn:
            row = conn.execute(
                "SELECT COUNT(*), SUM(tokens_saved), SUM(bytes_saved) FROM stats"
            ).fetchone()
            cache_row = conn.execute(
                "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                ("session_cache_unavailable", int(time.time()) - 3600),
            ).fetchone()
        if row and row[0]:
            ok("events", str(row[0]))
            ok("tokens saved", str(row[1] or 0))
            ok("bytes saved", str(row[2] or 0))
        else:
            ok("(none)", "no recorded savings yet")
        if cache_row and cache_row[0]:
            flag(
                "session-cache",
                f"{cache_row[0]} contention event(s) in the last hour",
                warn=True,
            )
        else:
            ok("session-cache", "no contention events in the last hour")
    except Exception as e:  # noqa: BLE001
        flag("stats", str(e), warn=True)

    typer.echo("")
