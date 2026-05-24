"""Doctor CLI helpers."""
from __future__ import annotations

import contextlib
import sqlite3
import time
from datetime import date
from pathlib import Path

import typer

from .util import _humanize_bytes as _humanize_bytes_doctor


def _cache_dir_stats(d: Path) -> tuple[int, int, int | None]:
    """Return ``(total_bytes, file_count, oldest_age_seconds_or_None)`` for *d*.

    Walks a single directory level — none of the cache directories the doctor
    inspects are nested.  ``session_snapshots/`` is the one exception (one
    subdir per session); we descend one level for it.  Symlinks are skipped
    defensively.  Raises :class:`OSError` only when the directory itself
    cannot be enumerated; per-file errors are silently skipped because the
    caller treats unreadable individual entries as zero-sized.
    """
    total_bytes = 0
    file_count = 0
    oldest_mtime: float | None = None
    now = time.time()
    for entry in d.iterdir():
        try:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                # One-level descent for session_snapshots/<session_id>/...
                for child in entry.iterdir():
                    if child.is_symlink() or not child.is_file():
                        continue
                    try:
                        st = child.stat()
                    except OSError:
                        continue
                    total_bytes += st.st_size
                    file_count += 1
                    if oldest_mtime is None or st.st_mtime < oldest_mtime:
                        oldest_mtime = st.st_mtime
                continue
            if not entry.is_file():
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            total_bytes += st.st_size
            file_count += 1
            if oldest_mtime is None or st.st_mtime < oldest_mtime:
                oldest_mtime = st.st_mtime
        except OSError:
            continue
    oldest_age = int(now - oldest_mtime) if oldest_mtime is not None else None
    return total_bytes, file_count, oldest_age



def doctor(  # noqa: C901
    fix: bool = typer.Option(  # noqa: B008
        False, "--fix", help="Clear stale index-spawn markers that doctor flags."
    ),
    crashes: bool = typer.Option(  # noqa: B008
        False, "--crashes", help="Show the last 5 hook crash entries from hooks-stderr.log."
    ),
) -> None:
    """Diagnose indexing health.

    Pass ``--fix`` to also clear the stale ``.indexing`` spawn markers doctor
    flags — the same reaping the worker does on startup, available on demand
    for when the worker is down.

    Pass ``--crashes`` to tail the last 5 entries from hooks-stderr.log so
    hook crash backtraces are visible without manually opening the log file.
    """
    import importlib
    import subprocess
    import sys

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

    typer.echo("\ntoken-goat doctor\n")

    # ------------------------------------------------------------------
    # 1. Versions
    # ------------------------------------------------------------------
    typer.echo("Versions")
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    ok("Python", py_ver)
    try:
        import importlib.metadata

        cc_ver = importlib.metadata.version("token-goat")
    except importlib.metadata.PackageNotFoundError:
        cc_ver = "unknown"
    ok("token-goat", cc_ver)
    try:
        uv_out = subprocess.run(
            ["uv", "--version"], capture_output=True, text=True, timeout=5
        )
        ok("uv", uv_out.stdout.strip() or "installed")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        flag("uv", "not found", warn=True)

    # ------------------------------------------------------------------
    # 1b. Detected harnesses
    # ------------------------------------------------------------------
    try:
        from . import install as _install  # noqa: PLC0415

        harnesses = _install.detect_harnesses()
        ok("harnesses detected", ", ".join(harnesses) if harnesses else "none")
    except Exception as _e:  # noqa: BLE001
        flag("harnesses detected", f"error — {_e}", warn=True)

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
        """Test whether SQLite WAL journal mode is available on this filesystem.

        Creates a temporary on-disk database (WAL requires a real file — not
        ``:memory:``), applies ``PRAGMA journal_mode = WAL``, and checks whether
        SQLite confirmed the switch.  The temp file is cleaned up in a
        ``finally`` block even if the PRAGMA or ``conn.close()`` raises.
        Returns ``False`` on any exception (e.g. read-only filesystem, OS
        restrictions on file-locking) so the doctor check degrades gracefully.
        """
        # Use mkstemp so the OS-allocated fd is closed before sqlite3 opens the
        # file.  Wrapping everything in try/finally guarantees the temp file is
        # deleted even if the PRAGMA or conn.close() raises, closing the window
        # where an exception would leave a permanent temp file behind.
        import os  # noqa: PLC0415

        fd, tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        wal_conn: sqlite3.Connection | None = None
        try:
            wal_conn = sqlite3.connect(tmp_db_path, isolation_level=None)
            actual_mode: str = wal_conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            return actual_mode == "wal"
        except (sqlite3.Error, OSError):
            return False
        finally:
            with contextlib.suppress(Exception):
                if wal_conn is not None:
                    wal_conn.close()
            Path(tmp_db_path).unlink(missing_ok=True)

    ext_check_conn = sqlite3.connect(":memory:", isolation_level=None)
    if _wal_supported():
        ok("WAL", "yes")
    else:
        flag("WAL", "not supported or errored")
    try:
        ext_check_conn.enable_load_extension(True)
        ext_check_conn.enable_load_extension(False)
        ok("extensions", "yes")
        ext_ok = True
    except (AttributeError, sqlite3.OperationalError) as e:
        flag("extensions", f"no — {e}")
        ext_ok = False
    ext_check_conn.close()

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
    # Probe codec availability, not just import — image_shrink defaults to
    # WebP encoding (~39% smaller than JPEG on screenshots), so missing
    # libwebp on Linux source builds silently breaks the shrink pipeline.
    try:
        import PIL  # noqa: PLC0415
        from PIL import Image, features  # noqa: PLC0415

        ok("Pillow", PIL.__version__)
        codec_status = []
        for codec, label in (("webp", "WebP"), ("jpg", "JPEG"), ("zlib", "PNG")):
            if features.check(codec):
                codec_status.append(f"{label}=ok")
            else:
                codec_status.append(f"{label}=MISSING")
        # Smoke-test actual encode for the default lossy format so a half-broken
        # libwebp (loadable but encode-broken) surfaces here.
        try:
            import io  # noqa: PLC0415

            buf = io.BytesIO()
            Image.new("RGB", (4, 4), (200, 100, 50)).save(buf, "WEBP", quality=80)
            codec_status.append("WebP-encode=ok")
        except Exception as exc:  # noqa: BLE001
            codec_status.append(f"WebP-encode=FAIL ({type(exc).__name__})")
        joined = ", ".join(codec_status)
        if "MISSING" in joined or "FAIL" in joined:
            flag(
                "Pillow codecs",
                f"{joined} — see README 'Image support' for platform install hints",
                warn=True,
            )
        else:
            ok("Pillow codecs", joined)
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
            import winreg

            _rk = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_READ,
            )
            _val, _ = winreg.QueryValueEx(_rk, "token-goat-worker")
            winreg.CloseKey(_rk)
            ok("token-goat-worker", f"Run key: {_val}")
        except FileNotFoundError:
            flag("token-goat-worker", "NOT INSTALLED (run `token-goat install`)", warn=True)
        except Exception as _e:  # noqa: BLE001
            flag("token-goat-worker", f"registry error: {_e}", warn=True)
    elif _sys.platform == "darwin":
        from . import install as _install  # noqa: PLC0415

        _plist = _install._launchd_plist_path()
        if _plist.exists():
            ok("token-goat-worker", f"LaunchAgent: {_plist}")
        else:
            flag("token-goat-worker", "LaunchAgent NOT INSTALLED (run `token-goat install`)", warn=True)
    else:
        from . import install as _install  # noqa: PLC0415

        _systemd = _install._systemd_service_path()
        _xdg = _install._xdg_autostart_path()
        if _systemd.exists():
            ok("token-goat-worker", f"systemd user service: {_systemd}")
        elif _xdg.exists():
            ok("token-goat-worker", f"XDG autostart: {_xdg}")
        else:
            flag("token-goat-worker", "autostart NOT INSTALLED (run `token-goat install`)", warn=True)

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
    # 13. New-cache stores (bash outputs, web outputs, session snapshots)
    # ------------------------------------------------------------------
    # Surfaces the disk-store stats added by the bash-output / WebFetch /
    # diff-aware-re-read features so a long-lived install can be inspected
    # for runaway growth without grep-ing the data directory by hand.
    typer.echo("\nCaches")
    for label, dir_name, cap_bytes in (
        ("bash outputs", "bash_outputs", 16 * 1024 * 1024),
        ("web outputs", "web_outputs", 32 * 1024 * 1024),
        ("session snapshots", "session_snapshots", None),
    ):
        d = paths.data_dir() / dir_name
        if not d.exists():
            ok(label, "(not yet created)")
            continue
        try:
            total_bytes, file_count, oldest_age = _cache_dir_stats(d)
        except OSError as e:
            flag(label, f"unreadable — {e}", warn=True)
            continue
        if file_count == 0:
            ok(label, "0 files (empty)")
            continue
        age_str = f", oldest {oldest_age // 3600}h ago" if oldest_age is not None else ""
        size_str = _humanize_bytes_doctor(total_bytes)
        if cap_bytes is not None and total_bytes > int(cap_bytes * 1.1):
            # 10% over the cap is the eviction's grace window; beyond that
            # the periodic sweep should have caught up by now.
            flag(label, f"{file_count} files, {size_str}{age_str} (over cap)", warn=True)
        else:
            ok(label, f"{file_count} files, {size_str}{age_str}")

    # ------------------------------------------------------------------
    # 14. Stats summary
    # ------------------------------------------------------------------
    typer.echo("\nStats")
    # doctor only reads here — use the read-only opener. open_global() runs
    # PRAGMA integrity_check on connect, which is multi-second on a large
    # global.db; a diagnostic must not pay that cost or create the DB.
    try:
        with _db.open_global_readonly() as conn:
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
    except FileNotFoundError:
        ok("(none)", "no recorded savings yet")
    except Exception as e:  # noqa: BLE001
        flag("stats", str(e), warn=True)

    # ------------------------------------------------------------------
    # 14b. Cumulative-savings projection (item 11)
    # ------------------------------------------------------------------
    # Estimate monthly cost savings assuming $3/1M input tokens and reading
    # the cumulative tokens_saved + the age of the oldest stats row.
    # This is intentionally a rough projection — the point is a ballpark
    # "are you getting value?" number, not an invoice.
    _COST_PER_1M_TOKENS: float = 3.0  # USD, conservative Claude input price
    try:
        with _db.open_global_readonly() as _proj_conn:
            # Oldest stats row gives elapsed time; sum gives total savings.
            _proj_row = _proj_conn.execute(
                "SELECT SUM(tokens_saved), MIN(ts), MAX(ts) FROM stats"
            ).fetchone()
        if _proj_row and _proj_row[0] and _proj_row[1] and _proj_row[2]:
            _total_tokens = int(_proj_row[0])
            _oldest_ts = float(_proj_row[1])
            _newest_ts = float(_proj_row[2])
            _elapsed_days = (_newest_ts - _oldest_ts) / 86400.0
            if _elapsed_days >= 1.0:
                _tokens_per_day = _total_tokens / _elapsed_days
                _tokens_per_month = _tokens_per_day * 30
                _usd_per_month = (_tokens_per_month / 1_000_000) * _COST_PER_1M_TOKENS
                ok(
                    "projected savings",
                    f"${_usd_per_month:.2f}/month at current rate "
                    f"({_tokens_per_month:,.0f} tokens/month, ${_COST_PER_1M_TOKENS}/1M)",
                )
            else:
                ok("projected savings", "< 1 day of data — check back tomorrow")
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass

    # ------------------------------------------------------------------
    # 15. Recent hook crashes (item 9) — only shown with --crashes
    # ------------------------------------------------------------------
    if crashes:
        typer.echo("\nRecent hook crashes")
        try:
            crash_log = paths.hooks_stderr_log_path()
            if not crash_log.exists():
                ok("(none)", "hooks-stderr.log not found")
            else:
                raw_text = crash_log.read_text(encoding="utf-8", errors="replace")
                # Each crash is a block starting with "token-goat hook" and
                # followed by a traceback. Split on that prefix to get blocks.
                blocks = [b.strip() for b in raw_text.split("\ntoken-goat hook") if b.strip()]
                # Re-add the stripped prefix to all but the first block.
                if raw_text.startswith("token-goat hook"):
                    # First block already has the prefix
                    display_blocks = [("token-goat hook " + b if i > 0 else b) for i, b in enumerate(blocks)]
                else:
                    display_blocks = [("token-goat hook " + b) for b in blocks]
                last_5 = display_blocks[-5:] if len(display_blocks) > 5 else display_blocks
                if not last_5:
                    ok("(none)", "log exists but contains no crash entries")
                else:
                    typer.echo(f"  (showing last {len(last_5)} of {len(display_blocks)} crash block(s))")
                    for block in last_5:
                        for line in block.splitlines()[:6]:
                            typer.echo(f"  {line}")
                        typer.echo("  ---")
        except Exception as e:  # noqa: BLE001
            flag("crashes", str(e), warn=True)

    typer.echo("")
