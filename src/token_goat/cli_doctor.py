"""Doctor CLI helpers."""
from __future__ import annotations

import contextlib
import sqlite3
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path

import typer

from . import paths
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


def _render_cache_section(
    label: str,
    dir_name: str,
    cap_bytes: int | None,
    cap_file_count: int | None,
    ok: Callable[[str, str], None],
    # `flag` accepts an optional `warn=True` keyword so the caller can
    # downgrade an over-cap line to a warning. Callable[..., None] is the
    # only way to express that without leaking the inner closure shape.
    flag: Callable[..., None],
) -> None:
    """Render a single cache section for the doctor output.

    Emits an ok/flag line based on cache directory size and file count.
    Caps are optional (None means no cap applies).
    """
    d = paths.data_dir() / dir_name
    if not d.exists():
        ok(label, "(not yet created)")
        return
    try:
        total_bytes, file_count, oldest_age = _cache_dir_stats(d)
    except OSError as e:
        flag(label, f"unreadable — {e}", warn=True)
        return
    if file_count == 0:
        ok(label, "0 files (empty)")
        return
    age_str = f", oldest {oldest_age // 3600}h ago" if oldest_age is not None else ""
    size_str = _humanize_bytes_doctor(total_bytes)
    # Detect over-cap: bytes cap OR file-count cap.  The file-count cap is
    # expressed in .txt bodies; _cache_dir_stats counts ALL files (bodies +
    # sidecars), so compare against cap_file_count * 2 to give a fair
    # threshold that accounts for each body having one sidecar.
    bytes_over = cap_bytes is not None and total_bytes > int(cap_bytes * 1.1)
    count_over = (
        cap_file_count is not None and file_count > cap_file_count * 2 * 1.1
    )
    if bytes_over or count_over:
        # 10% over the cap is the eviction's grace window; beyond that
        # the periodic sweep should have caught up by now.
        flag(label, f"{file_count} files, {size_str}{age_str} (over cap)", warn=True)
    else:
        ok(label, f"{file_count} files, {size_str}{age_str}")


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

    def _check_step(label: str, fn: Callable[[], object], *, warn: bool = False) -> None:
        """Execute a check step, emitting a pass or failure message.

        Wraps the try/except pattern for doctor check steps: calls *fn()*, emits
        a passing message via ``ok(label, str(result))``, and catches exceptions
        to emit a failure message via ``flag(label, str(e), warn=warn)``.

        Parameters
        ----------
        label
            The check label to pass to ok/flag.
        fn
            The callable that performs the check. Its return value is converted
            to a string for the ok message. If None, an empty string is used.
        warn
            If True, failures are emitted as warnings; otherwise as failures.
            Defaults to False.
        """
        try:
            result = fn()
            ok(label, str(result) if result is not None else "")
        except Exception as e:  # noqa: BLE001
            flag(label, str(e), warn=warn)

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

    def _check_uv() -> str:
        uv_out = subprocess.run(
            ["uv", "--version"], capture_output=True, text=True, timeout=5
        )
        return uv_out.stdout.strip() or "installed"

    _check_step("uv", _check_uv, warn=True)

    # ------------------------------------------------------------------
    # 1b. Detected harnesses
    # ------------------------------------------------------------------
    def _check_harnesses() -> str:
        from . import install as _install  # noqa: PLC0415

        harnesses = _install.detect_harnesses()
        return ", ".join(harnesses) if harnesses else "none"

    _check_step("harnesses detected", _check_harnesses, warn=True)

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
    def _check_sqlite_vec() -> object:
        import sqlite_vec  # noqa: PLC0415

        conn2 = sqlite3.connect(":memory:", isolation_level=None)
        conn2.enable_load_extension(True)
        sqlite_vec.load(conn2)
        conn2.enable_load_extension(False)
        vec_ver = conn2.execute("SELECT vec_version()").fetchone()[0]
        conn2.close()
        return vec_ver

    if ext_ok:
        _check_step("sqlite-vec", _check_sqlite_vec)
    else:
        flag("sqlite-vec", "skipped (no extension support)", warn=True)

    # ------------------------------------------------------------------
    # 5. fastembed
    # ------------------------------------------------------------------
    def _check_fastembed() -> str:
        importlib.import_module("fastembed")
        return "importable"

    _check_step("fastembed", _check_fastembed)

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
    # 8b. Hook wrapper
    # Checked before the Worker section: a missing or stale wrapper causes
    # hooks to silently fail, which then manifests as worker symptoms.
    # ------------------------------------------------------------------
    typer.echo("\nHook wrapper")
    wrapper_path = paths.hook_wrapper_path()
    if not wrapper_path.exists():
        flag("exists", f"NOT FOUND at {wrapper_path} — run `token-goat install` to create it")
    else:
        ok("exists", str(wrapper_path))

        # Drift detection: compare on-disk content with what install would write today.
        # Read in binary mode and decode so line endings are preserved verbatim
        # (the wrapper uses CRLF on Windows; Python text-mode open() translates
        # \r\n → \n, which would cause a false "differs" on every Windows install).
        try:
            on_disk = wrapper_path.read_bytes().decode("utf-8", errors="replace")
            expected = paths.hook_wrapper_content()
            if on_disk == expected:
                ok("content", "up to date")
            else:
                flag(
                    "content",
                    "differs from expected — run `token-goat install` to refresh",
                    warn=True,
                )
        except Exception as _e:  # noqa: BLE001
            flag("content", f"could not read — {_e}", warn=True)

        # Functional check: invoke the wrapper with --version and verify a response.
        try:
            _wrap_result = subprocess.run(
                [str(wrapper_path), "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if _wrap_result.returncode == 0 and _wrap_result.stdout.strip():
                ok("invoke", f"ok — {_wrap_result.stdout.strip()[:80]}")
            else:
                flag(
                    "invoke",
                    f"exit {_wrap_result.returncode} — {(_wrap_result.stderr or _wrap_result.stdout).strip()[:120]}",
                    warn=True,
                )
        except FileNotFoundError:
            flag("invoke", "wrapper not executable or not found by shell", warn=True)
        except subprocess.TimeoutExpired:
            flag("invoke", "timed out after 10s", warn=True)
        except Exception as _e:  # noqa: BLE001
            flag("invoke", f"error — {_e}", warn=True)

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
                    # Derive the doctor's freshness threshold from the
                    # worker's authoritative formula rather than a hard-coded
                    # 120s — keeps `doctor` consistent with `_is_heartbeat_fresh`
                    # and `_nudge_worker_if_down` if HEARTBEAT_INTERVAL is ever
                    # tuned.  Doctor is a snapshot rather than a watchdog, so
                    # any age above the stale threshold is reported verbatim.
                    from . import worker as _worker_hb  # noqa: PLC0415

                    hb_age = time.time() - hb_path.stat().st_mtime
                    stale_after = _worker_hb.heartbeat_stale_threshold()
                    if hb_age <= stale_after:
                        ok("heartbeat", f"{int(hb_age)}s ago — fresh")
                    else:
                        flag(
                            "heartbeat",
                            f"{int(hb_age)}s ago — stale "
                            f"(threshold {int(stale_after)}s)",
                            warn=True,
                        )
                else:
                    flag("heartbeat", "missing", warn=True)
            else:
                flag("pid file", f"present but PID {pid_val} not alive", warn=True)
                # Heartbeat age is meaningful even for zombie workers: a very
                # recent heartbeat suggests the process just exited cleanly,
                # while a stale heartbeat (>5 min) with a dead PID strongly
                # suggests the worker crashed or was killed without cleanup.
                if hb_path.exists():
                    try:
                        hb_age = time.time() - hb_path.stat().st_mtime
                        _ZOMBIE_THRESHOLD = 300  # 5 minutes
                        if hb_age > _ZOMBIE_THRESHOLD:
                            flag(
                                "heartbeat",
                                f"{int(hb_age)}s ago — zombie worker (pid gone, heartbeat stale)",
                                warn=True,
                            )
                        else:
                            ok("heartbeat", f"{int(hb_age)}s ago — process recently exited")
                    except OSError:
                        pass  # heartbeat file disappeared between exists() and stat()
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
    # cap_file_count is the max number of .txt body files (each may also have a
    # .json sidecar, so the physical directory-entry count can be up to 2× this).
    # None means no file-count cap applies (e.g. session_snapshots).
    for label, dir_name, cap_bytes, cap_file_count in (
        ("bash outputs", "bash_outputs", 16 * 1024 * 1024, 4096),
        ("web outputs", "web_outputs", 32 * 1024 * 1024, 4096),
        ("session snapshots", "session_snapshots", None, None),
    ):
        _render_cache_section(label, dir_name, cap_bytes, cap_file_count, ok, flag)

    # ------------------------------------------------------------------
    # 13b. Configuration — opt-in flags + their effective values
    # ------------------------------------------------------------------
    # Surfaces the major opt-in flags (compact_assist, skill_preservation,
    # hints.json_sidecar, etc.) with their currently effective values so a
    # confused user (or a future agent) can answer "is feature X actually on?"
    # without grep-ing config.toml.  Honours env-var overrides since `config.load()`
    # applies them before returning the Config object.
    typer.echo("\nConfiguration")
    try:
        from . import config as _config  # noqa: PLC0415

        cfg = _config.load()
        # compact_assist: master switch + the auto-trigger multiplier added in run 1 iter 3.
        ok("compact_assist.enabled", str(cfg.compact_assist.enabled).lower())
        ok(
            "compact_assist.auto_trigger_multiplier",
            f"{cfg.compact_assist.auto_trigger_multiplier:g}",
        )
        ok(
            "compact_assist.max_manifest_tokens",
            str(cfg.compact_assist.max_manifest_tokens),
        )
        # skill_preservation: enabled / cache cap.
        ok("skill_preservation.enabled", str(cfg.skill_preservation.enabled).lower())
        ok(
            "skill_preservation.max_cache_bytes",
            str(cfg.skill_preservation.max_cache_bytes),
        )
        # hints: json_sidecar (r2 iter 1) plus the quiet-hours window if set.
        ok("hints.json_sidecar", str(cfg.hints.json_sidecar).lower())
        if cfg.hints.quiet_hours:
            ok("hints.quiet_hours", cfg.hints.quiet_hours)
        ok(
            "hints.suppress_after_ignored",
            str(cfg.hints.suppress_after_ignored),
        )
        # bash_compress: enabled + max line/byte caps so the user can verify
        # the safety net is intact.
        ok("bash_compress.enabled", str(cfg.bash_compress.enabled).lower())
        ok("bash_compress.max_lines", str(cfg.bash_compress.max_lines))
        # decision log (this iteration): always-on opt-in CLI feature; surface
        # the per-session cap so the user knows the implicit ceiling.
        try:
            from . import session as _session  # noqa: PLC0415

            ok("decision_log.max_per_session", str(_session.DECISION_HISTORY_MAX))
        except Exception as exc:  # noqa: BLE001
            flag("decision_log.max_per_session", str(exc), warn=True)
    except Exception as e:  # noqa: BLE001
        flag("config load", str(e), warn=True)

    # ------------------------------------------------------------------
    # 14. Stats summary + 14b. Cumulative-savings projection (item 11)
    # ------------------------------------------------------------------
    # Both sections read from global.db, so they share a single connection.
    # doctor only reads here — use the read-only opener. open_global() runs
    # PRAGMA integrity_check on connect, which is multi-second on a large
    # global.db; a diagnostic must not pay that cost or create the DB.
    typer.echo("\nStats")
    _row: object = None
    _cache_row: object = None
    _proj_row: object = None
    _top_kinds: list[tuple[str, int]] = []
    _unknown_kinds: list[tuple[str, int]] = []
    _last_write_ts: float | None = None
    try:
        with _db.open_global_readonly() as conn:
            _row = conn.execute(
                "SELECT COUNT(*), SUM(tokens_saved), SUM(bytes_saved) FROM stats"
            ).fetchone()
            _cache_row = conn.execute(
                "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                ("session_cache_unavailable", int(time.time()) - 3600),
            ).fetchone()
            # Oldest stats row gives elapsed time; sum gives total savings.
            _proj_row = conn.execute(
                "SELECT SUM(tokens_saved), MIN(ts), MAX(ts) FROM stats"
            ).fetchone()

            # Top three mechanisms by tokens_saved over the last 30 days.  A
            # quick health signal: an install where one mechanism dominates
            # may be missing adoption of the others (e.g. surgical reads).
            _cutoff = int(time.time()) - 30 * 86400
            _top_kinds = [
                (r[0], int(r[1] or 0))
                for r in conn.execute(
                    "SELECT kind, SUM(tokens_saved) AS s "
                    "FROM stats WHERE ts >= ? "
                    "GROUP BY kind ORDER BY s DESC LIMIT 3",
                    (_cutoff,),
                ).fetchall()
            ]

            # Unknown kinds — anything that lands in SOURCE_OTHER.  A non-zero
            # count means a record_stat call uses a kind name that is not yet
            # in _KIND_TO_SOURCE (or its prefix table); the rows still appear
            # in totals but lose their mechanism attribution in the rollup.
            _all_kinds = [
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT kind FROM stats"
                ).fetchall()
            ]
            from . import stats as _stats_mod  # noqa: PLC0415
            _unknown_kind_names = [
                k for k in _all_kinds
                if _stats_mod.kind_to_source(k) == _stats_mod.SOURCE_OTHER
            ]
            if _unknown_kind_names:
                # Surface up to three with their event counts so the user can
                # tell whether the unmapped kind is a one-off or a leak.
                placeholders = ",".join("?" * len(_unknown_kind_names))
                _unknown_kinds = [
                    (r[0], int(r[1]))
                    for r in conn.execute(
                        f"SELECT kind, COUNT(*) FROM stats "
                        f"WHERE kind IN ({placeholders}) "
                        f"GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 3",
                        tuple(_unknown_kind_names),
                    ).fetchall()
                ]
    except FileNotFoundError:
        ok("(none)", "no recorded savings yet")
    except Exception as e:  # noqa: BLE001
        flag("stats", str(e), warn=True)

    if _row and _row[0]:  # type: ignore[index]
        ok("events", str(_row[0]))  # type: ignore[index]
        ok("tokens saved", str(_row[1] or 0))  # type: ignore[index]
        ok("bytes saved", str(_row[2] or 0))  # type: ignore[index]
    elif _row is not None:
        ok("(none)", "no recorded savings yet")

    # Last-write recency — a stats DB with no fresh rows in the last 24 h on a
    # supposedly-active install is a leading indicator of broken hook wiring.
    if _proj_row and _proj_row[2]:  # type: ignore[index]
        _last_write_ts = float(_proj_row[2])  # type: ignore[index]
        _age_s = max(0.0, time.time() - _last_write_ts)
        if _age_s < 3600:
            ok("last write", f"{_age_s/60:.0f}m ago")
        elif _age_s < 86400:
            ok("last write", f"{_age_s/3600:.1f}h ago")
        elif _age_s < 7 * 86400:
            flag("last write", f"{_age_s/86400:.1f}d ago (no recent activity)", warn=True)
        else:
            flag("last write", f"{_age_s/86400:.0f}d ago (stats DB looks stale)", warn=True)

    # Top 3 mechanisms by tokens_saved in the last 30 days — answers the
    # question "which intercept is paying off the most" at a glance, and
    # surfaces any mechanism that is silently underperforming.
    if _top_kinds:
        for kind_name, tokens in _top_kinds:
            ok(f"top kind: {kind_name}", f"{tokens} tokens (30d)")

    # Unknown-kind leak — surfaces invisible-bucket rows so a new record_stat
    # call site that forgot to register its kind in _KIND_TO_SOURCE gets
    # caught the next time someone runs doctor.
    if _unknown_kinds:
        names = ", ".join(f"{k} ({c})" for k, c in _unknown_kinds)
        flag(
            "unmapped kinds",
            f"{names} (add the base kind to _KIND_TO_SOURCE or a family to _KIND_PREFIX_TO_SOURCE; "
            f"`_overhead` suffix routes via the parent kind automatically)",
            warn=True,
        )
    elif _row and _row[0]:  # type: ignore[index]
        # Only show the all-clear line when there ARE rows; otherwise the
        # absence is just an empty DB, not a successful mapping audit.
        ok("kind coverage", "all kinds mapped to a source bucket")

    if _cache_row and _cache_row[0]:  # type: ignore[index]
        flag(
            "session-cache",
            f"{_cache_row[0]} contention event(s) in the last hour",  # type: ignore[index]
            warn=True,
        )
    elif _cache_row is not None:
        ok("session-cache", "no contention events in the last hour")

    # ------------------------------------------------------------------
    # 14b. Cumulative-savings projection (item 11)
    # ------------------------------------------------------------------
    # Estimate monthly cost savings assuming $3/1M input tokens and reading
    # the cumulative tokens_saved + the age of the oldest stats row.
    # This is intentionally a rough projection — the point is a ballpark
    # "are you getting value?" number, not an invoice.
    _COST_PER_1M_TOKENS: float = 3.0  # USD, conservative Claude input price
    if _proj_row and _proj_row[0] and _proj_row[1] and _proj_row[2]:  # type: ignore[index]
        _total_tokens = int(_proj_row[0])  # type: ignore[index]
        _oldest_ts = float(_proj_row[1])  # type: ignore[index]
        _newest_ts = float(_proj_row[2])  # type: ignore[index]
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

    # ------------------------------------------------------------------
    # 15b. DB contention metric (worker-stderr.log slow-session warnings)
    # ------------------------------------------------------------------
    # Counts "session slow" WARNING lines in worker-stderr.log written in the
    # last 24 h.  Each line represents a DB session that took ≥1 s — on a
    # single-user machine this means a reader was serialised behind a writer
    # (typically a full project reindex holding the connection open).  Surfacing
    # the count lets the user correlate perceived hook latency with real data.
    typer.echo("\nDB contention")
    _worker_stderr = paths.logs_dir() / "worker-stderr.log"
    try:
        if not _worker_stderr.exists():
            ok("slow sessions (24 h)", "0 (no worker-stderr.log)")
        else:
            import re as _re_dc  # noqa: PLC0415
            _SLOW_RE = _re_dc.compile(r"session slow: ([\d.]+)ms", _re_dc.IGNORECASE)
            _cutoff_dc = time.time() - 86400
            _slow_count = 0
            _slow_max_ms = 0.0
            # Parse ISO-8601-ish timestamps at the start of each line.
            # Worker log lines are formatted by Python's logging module:
            # "2026-05-25 12:34:56,789 WARNING … session slow: 2345.6ms …"
            _TS_RE = _re_dc.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
            import datetime  # noqa: PLC0415
            for _line in _worker_stderr.read_text(encoding="utf-8", errors="replace").splitlines():
                _m_slow = _SLOW_RE.search(_line)
                if not _m_slow:
                    continue
                # Check whether this line falls within the last 24 h.
                _m_ts = _TS_RE.match(_line)
                if _m_ts:
                    try:
                        _ts = datetime.datetime.strptime(
                            _m_ts.group(1), "%Y-%m-%d %H:%M:%S"
                        ).replace(tzinfo=datetime.UTC).timestamp()
                        if _ts < _cutoff_dc:
                            continue
                    except ValueError:
                        pass  # unparseable timestamp — include the line anyway
                _slow_count += 1
                try:
                    _ms = float(_m_slow.group(1))
                    if _ms > _slow_max_ms:
                        _slow_max_ms = _ms
                except ValueError:
                    pass
            if _slow_count == 0:
                ok("slow sessions (24 h)", "0 — no contention detected")
            elif _slow_count < 10:
                ok(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — low",
                )
            elif _slow_count < 50:
                flag(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — moderate; large reindexes hold DB open",
                    warn=True,
                )
            else:
                flag(
                    "slow sessions (24 h)",
                    f"{_slow_count} (max {_slow_max_ms:.0f}ms) — HIGH; hooks may stall during reindex",
                    warn=True,
                )
    except Exception as _e_dc:  # noqa: BLE001
        flag("slow sessions (24 h)", f"unreadable — {_e_dc}", warn=True)

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
