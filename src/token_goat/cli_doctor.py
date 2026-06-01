"""Doctor CLI helpers."""
from __future__ import annotations

import contextlib
import sqlite3
import sys
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

    def _check_step(
        label: str,
        fn: Callable[[], object],
        *,
        warn: bool = False,
        time_ms: bool = False,
    ) -> None:
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
        time_ms
            If True, append the elapsed wall-clock time of *fn()* (in ms) to
            the passing message.  Useful for cold-import probes (sqlite-vec,
            fastembed) where a slow load points to a fresh-install model
            download or a slow filesystem — both are operationally relevant
            even though the check itself succeeded.
        """
        try:
            t0 = time.monotonic() if time_ms else 0.0
            result = fn()
            if time_ms:
                elapsed_ms = (time.monotonic() - t0) * 1000
                base = str(result) if result is not None else ""
                ok(label, f"{base} ({elapsed_ms:.0f} ms)" if base else f"{elapsed_ms:.0f} ms")
            else:
                ok(label, str(result) if result is not None else "")
        except Exception as e:  # noqa: BLE001
            flag(label, str(e), warn=warn)

    typer.echo("\ntoken-goat doctor\n")

    # ------------------------------------------------------------------
    # 1. Versions
    # ------------------------------------------------------------------
    typer.echo("Versions")
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info < (3, 11):  # noqa: UP036
        flag("Python", f"{py_ver} — minimum supported is 3.11; upgrade to avoid compatibility issues")
    else:
        ok("Python", py_ver)
    try:
        import importlib.metadata

        cc_ver = importlib.metadata.version("token-goat")
    except importlib.metadata.PackageNotFoundError:
        cc_ver = "unknown"
    ok("token-goat", cc_ver)

    # PyPI version check — non-blocking, 2 s timeout, skip gracefully if offline.
    def _check_pypi_version() -> str:
        import json as _json  # noqa: PLC0415
        import urllib.request  # noqa: PLC0415

        if cc_ver == "unknown":
            return "installed version unknown — skipping"
        try:
            url = "https://pypi.org/pypi/token-goat/json"
            req = urllib.request.Request(url, headers={"User-Agent": "token-goat-doctor/1.0"})
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = _json.loads(resp.read())
            latest = data["info"]["version"]
            if latest == cc_ver:
                return f"{cc_ver} (latest)"
            # Simple version comparison using tuple split on dots.
            def _vtup(v: str) -> tuple[int, ...]:
                try:
                    return tuple(int(x) for x in v.split("."))
                except ValueError:
                    return (0,)
            if _vtup(latest) > _vtup(cc_ver):
                raise ValueError(f"{cc_ver} installed, {latest} available — run `uv tool install --reinstall token-goat`")
            return f"{cc_ver} (PyPI has {latest})"
        except OSError:
            return "PyPI unreachable (offline?)"

    _check_step("token-goat (PyPI)", _check_pypi_version, warn=True)

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

        harnesses_dict = _install.detect_installed_harnesses()
        found = [name for name, installed in harnesses_dict.items() if installed]
        # Return in deterministic order: claude first, then others alphabetically
        if "claude" in found:
            found.remove("claude")
        found = ["claude"] + sorted(found)
        return ", ".join(found) if found else "none"

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

    # Fastembed ONNX model file: models_dir exists is not enough — the embedding
    # path silently degrades to zero-vectors if the .onnx blob is missing.
    # Surface the actual file presence so a fresh-install user without network
    # gets an actionable signal.
    try:
        models_dir = paths.models_dir()
        if models_dir.exists():
            onnx_files = list(models_dir.rglob("*.onnx"))
            if onnx_files:
                total_size = sum(f.stat().st_size for f in onnx_files if f.is_file())
                ok(
                    "fastembed model",
                    f"{len(onnx_files)} onnx file(s), {_humanize_bytes_doctor(total_size)}",
                )
            else:
                flag(
                    "fastembed model",
                    "no .onnx file found in models_dir — semantic search will be unavailable until first download",
                    warn=True,
                )
    except OSError as _e:
        flag("fastembed model", f"could not enumerate models_dir — {_e}", warn=True)

    # ------------------------------------------------------------------
    # 2a. Disk space
    # ------------------------------------------------------------------
    # Token-goat caches (models, images, bash/web outputs, project DBs) can
    # grow to several GB on a busy install.  Warn early if the data directory
    # partition is running low so the user can run `token-goat clean` before
    # hitting an OS-level write error inside a hook.
    typer.echo("\nDisk space")
    try:
        import shutil as _shutil  # noqa: PLC0415

        _data = paths.data_dir()
        # Use the parent if data_dir doesn't exist yet — shutil.disk_usage
        # requires an existing path.
        _check_path = _data if _data.exists() else _data.parent if _data.parent.exists() else Path.cwd()
        _total, _used, _free = _shutil.disk_usage(_check_path)
        _free_mb = _free // (1024 * 1024)
        _total_gb = _total / (1024 ** 3)
        _pct_free = _free / _total * 100 if _total > 0 else 0
        _free_str = f"{_free_mb:,} MB free of {_total_gb:.1f} GB ({_pct_free:.0f}% free) on {_check_path}"
        _WARN_MB = 500
        if _free_mb < _WARN_MB:
            flag(
                "data dir partition",
                f"{_free_str} — below {_WARN_MB} MB; run `token-goat clean` to reclaim cache space",
            )
        elif _free_mb < 2048:
            flag(
                "data dir partition",
                f"{_free_str} — getting low; consider `token-goat clean`",
                warn=True,
            )
        else:
            ok("data dir partition", _free_str)
    except Exception as _e_disk:  # noqa: BLE001
        flag("data dir partition", f"disk_usage failed — {_e_disk}", warn=True)

    # ------------------------------------------------------------------
    # 2b. Installation status — verify token-goat artefacts actually landed in
    # the harness configs.  Doctor previously only checked runtime/cache health;
    # if `token-goat install` had never been run (or had partially failed),
    # nothing surfaced that fact.  Pulls _check_* status strings from install.py
    # so the wire is the same as `token-goat install --verify`.
    # ------------------------------------------------------------------
    typer.echo("\nInstallation")
    try:
        from . import install as _install  # noqa: PLC0415

        # Always check the Claude side (settings.json + CLAUDE.md + skill).
        # Codex side only when the harness is detected, so users without Codex
        # don't see a confusing "codex config: not installed" warning.
        installation_checks: list[tuple[str, str]] = [
            ("settings.json", _install._check_settings_json()),
            ("CLAUDE.md", _install._check_claude_md()),
            ("skill", _install._check_skill()),
        ]
        try:
            harnesses_dict = _install.detect_installed_harnesses()
        except Exception:  # noqa: BLE001 — detect_installed_harnesses is best-effort
            harnesses_dict = {}
        if harnesses_dict.get("codex", False):
            installation_checks.append(("codex config.toml", _install._check_codex_config()))
        if sys.platform == "win32":
            installation_checks.append(("worker autostart", _install._check_worker_task()))
        for label, status in installation_checks:
            if status.startswith("installed"):
                ok(label, status)
            elif status.startswith("not installed"):
                flag(label, status + " — run `token-goat install`", warn=True)
            else:
                flag(label, status, warn=True)
    except Exception as _e:  # noqa: BLE001 — installation check must never abort doctor
        flag("installation", f"check failed — {_e}", warn=True)

    # ------------------------------------------------------------------
    # 2c. Third-party AI tool compatibility hints
    # ------------------------------------------------------------------
    typer.echo("\nThird-party AI tools")
    try:
        from . import install as _install  # noqa: PLC0415

        if _install.detect_aider():
            flag(
                "aider",
                "detected — aider does not support hook-based auto-integration; "
                "add `--read <file>` in your .aider.conf.yml to pass context manually",
                warn=True,
            )
        else:
            ok("aider", "not detected")

        gemini_dir = Path.home() / ".gemini"
        if gemini_dir.exists():
            from . import install as _inst  # noqa: PLC0415
            gemini_status = _inst._check_gemini_settings()  # noqa: SLF001
            if "installed" in gemini_status:
                ok("gemini", f"detected, hooks {gemini_status}")
            else:
                flag(
                    "gemini",
                    f"detected — hooks {gemini_status}; run `token-goat install --target gemini` to install",
                    warn=True,
                )
        else:
            ok("gemini", "not detected")

        if _install.detect_cline():
            ok("cline", "detected — bash output compression active for `cline` commands")
        else:
            ok("cline", "not detected")

        if _install.detect_windsurf():
            ok("windsurf", "detected — bash output compression active for `windsurf` commands")
        else:
            ok("windsurf", "not detected")

        if _install.detect_copilot_cli():
            ok("copilot-cli", "detected — bash output compression active for `copilot` commands")
        else:
            ok("copilot-cli", "not detected")
    except Exception as _e_tools:  # noqa: BLE001
        flag("third-party tools", f"check failed — {_e_tools}", warn=True)

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
        _check_step("sqlite-vec", _check_sqlite_vec, time_ms=True)
    else:
        flag("sqlite-vec", "skipped (no extension support)", warn=True)

    # ------------------------------------------------------------------
    # 5. fastembed
    # ------------------------------------------------------------------
    def _check_fastembed() -> str:
        importlib.import_module("fastembed")
        return "importable"

    # time_ms=True surfaces the cold-import duration: fastembed pulls in
    # onnxruntime, huggingface_hub, and tokenizers, so an "importable" check
    # that takes >1 s is a flag that the venv is on a slow disk or the model
    # cache is being initialised; either way it explains slow first-time
    # `token-goat semantic` invocations.
    _check_step("fastembed", _check_fastembed, time_ms=True)

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
        # Surface the canonical-form input that produced the hash so users
        # can verify drive-letter case, separator style, and symlink-resolved
        # target match expectations.  The full posix string is what gets
        # SHA1-hashed; mismatch here is the source of fragmented indexes.
        ok("canonical_root", proj.root.as_posix())
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
    # 8a. All-projects index health
    # ------------------------------------------------------------------
    # The per-project check above only covers the cwd.  Surfacing all indexed
    # projects lets a user spot a large index they forgot about, detect a DB
    # that went corrupt or missing, and understand the total index footprint.
    typer.echo("\nIndexed projects")
    try:
        with _db.open_global_readonly() as _idx_conn:
            _idx_conn.row_factory = __import__("sqlite3").Row
            _all_projs = _idx_conn.execute("SELECT hash, root FROM projects").fetchall()
        if not _all_projs:
            ok("(none)", "no projects indexed yet — run `token-goat index` inside a project")
        else:
            _total_files_all = 0
            _inaccessible: list[str] = []
            _proj_rows_out: list[str] = []
            for _pr in _all_projs:
                _ph = _pr["hash"]
                _pr_root = _pr["root"]
                _proj_db_path = paths.project_db_path(_ph)
                if not _proj_db_path.exists():
                    _inaccessible.append(f"{_pr_root} (DB missing: {_proj_db_path})")
                    continue
                try:
                    with _db.open_project_readonly(_ph) as _pc:
                        _pfc = _pc.execute("SELECT COUNT(*) FROM files").fetchone()[0]
                    _total_files_all += _pfc
                    _proj_rows_out.append(f"{_pr_root} ({_pfc} files)")
                except Exception as _pe:  # noqa: BLE001
                    _inaccessible.append(f"{_pr_root} ({_pe})")
            ok("total projects", str(len(_all_projs)))
            ok("total indexed files", str(_total_files_all))
            # Show up to 5 projects inline to avoid overwhelming output.
            for _pline in _proj_rows_out[:5]:
                ok("project", _pline)
            if len(_proj_rows_out) > 5:
                ok("...", f"({len(_proj_rows_out) - 5} more — run `token-goat stats --by-project` for full list)")
            for _bad in _inaccessible:
                flag("inaccessible", _bad, warn=True)
    except FileNotFoundError:
        ok("(none)", "no global.db yet — nothing indexed")
    except Exception as _e_idx:  # noqa: BLE001
        flag("index health", str(_e_idx), warn=True)

    # ------------------------------------------------------------------
    # 8a-large. Large file summary across all indexed projects
    # ------------------------------------------------------------------
    # Surfaces how many files across all projects are currently in the skip or
    # symbol-only tiers.  Useful to confirm the thresholds are actually doing
    # something and to spot unexpectedly large files that might need attention.
    typer.echo("\nLarge files (current thresholds)")
    try:
        from . import config as _config_lf  # noqa: PLC0415

        _lf_cfg = _config_lf.load().indexing
        _lf_skip_bytes = _lf_cfg.large_file_skip_kb * 1024
        _lf_symbol_only_bytes = _lf_cfg.large_file_symbol_only_kb * 1024
        _lf_total_skipped = 0
        _lf_total_symbol_only = 0
        _lf_project_count = 0
        try:
            with _db.open_global_readonly() as _lf_gconn:
                _lf_all_projs = _lf_gconn.execute("SELECT hash, root FROM projects").fetchall()
            for _lf_pr in _lf_all_projs:
                _lf_ph = _lf_pr["hash"]
                _lf_db_path = paths.project_db_path(_lf_ph)
                if not _lf_db_path.exists():
                    continue
                try:
                    with _db.open_project_readonly(_lf_ph) as _lf_pc:
                        # Count files over skip threshold
                        _s = _lf_pc.execute(
                            "SELECT COUNT(*) FROM files WHERE size > ?", (_lf_skip_bytes,)
                        ).fetchone()
                        _lf_total_skipped += int(_s[0] if _s else 0)
                        # Count files in the symbol-only tier (> symbol_only but <= skip)
                        _so = _lf_pc.execute(
                            "SELECT COUNT(*) FROM files WHERE size > ? AND size <= ?",
                            (_lf_symbol_only_bytes, _lf_skip_bytes),
                        ).fetchone()
                        _lf_total_symbol_only += int(_so[0] if _so else 0)
                    _lf_project_count += 1
                except Exception:  # noqa: BLE001
                    continue
        except FileNotFoundError:
            pass  # no global.db yet
        if _lf_project_count == 0:
            ok("summary", "no projects indexed yet")
        else:
            ok(
                "symbol-only files",
                f"{_lf_total_symbol_only} (>{_lf_cfg.large_file_symbol_only_kb} KB, "
                f"≤{_lf_cfg.large_file_skip_kb} KB, symbols indexed but not embedded)",
            )
            if _lf_total_skipped > 0:
                flag(
                    "oversized files in index",
                    f"{_lf_total_skipped} files >{_lf_cfg.large_file_skip_kb} KB found in DB "
                    f"(indexed before threshold was applied; re-run `token-goat index --full` to enforce)",
                    warn=True,
                )
            else:
                ok("oversized files in index", "0 (none exceed the skip threshold)")
    except Exception as _e_lf:  # noqa: BLE001
        flag("large files", f"check failed — {_e_lf}", warn=True)

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
        flag("status", "not running — run `token-goat worker --start` to enable incremental indexing", warn=True)

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
    # 13a. Cache hit-rate telemetry (30 d)
    # ------------------------------------------------------------------
    # The cache directories above show *capacity* (size / count) but not how
    # *useful* the cache has been.  A cache that is at 80% of its byte cap but
    # has a 5% hit rate is wasting space; one with a 95% hit rate has the cap
    # tuned right.  Reads `kind`-grouped stats over the trailing 30 days and
    # reports hit / (hit + miss) for the three caches that record both halves:
    #
    #   • image_shrink_cache_hit vs image_shrink (fresh shrink) — content-hash
    #     dedup on the same image showing up twice in a session.
    #   • bash_output_recall vs bash_output_recall_miss — agent calling
    #     `token-goat bash-output <id>` for a known vs an evicted ID.
    #   • web_output_recall vs web_output_recall_miss — same shape for
    #     `token-goat web-output <id>`.
    #
    # Misses are only recorded when [stats] record_zero_savings = true, so a
    # 100% rate may mean "miss telemetry is disabled" rather than "no misses".
    # The note is surfaced inline so the user is not misled.
    typer.echo("\nCache hit rates (30 d)")
    try:
        _cache_cutoff = int(time.time()) - 30 * 86400
        _miss_telemetry_on = False
        try:
            from . import config as _config_for_rate  # noqa: PLC0415

            _miss_telemetry_on = _config_for_rate.load().stats.record_zero_savings
        except Exception:  # noqa: BLE001
            pass
        with _db.open_global_readonly() as conn:
            for cache_label, hit_kind, miss_kind in (
                ("image shrink", "image_shrink_cache_hit", "image_shrink"),
                ("bash recall", "bash_output_recall", "bash_output_recall_miss"),
                ("web recall", "web_output_recall", "web_output_recall_miss"),
            ):
                _hit_row = conn.execute(
                    "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                    (hit_kind, _cache_cutoff),
                ).fetchone()
                _miss_row = conn.execute(
                    "SELECT COUNT(*) FROM stats WHERE kind = ? AND ts >= ?",
                    (miss_kind, _cache_cutoff),
                ).fetchone()
                _hits = int(_hit_row[0] if _hit_row else 0)
                _misses = int(_miss_row[0] if _miss_row else 0)
                _total = _hits + _misses
                if _total == 0:
                    ok(cache_label, "no events")
                    continue
                _rate = _hits / _total
                # For image_shrink the "miss" column is "fresh shrink" — both
                # are productive (a fresh shrink still saves tokens vs a raw
                # image), so a lower rate is not a problem.  The note clarifies
                # the asymmetry.
                if hit_kind == "image_shrink_cache_hit":
                    ok(
                        cache_label,
                        f"{_rate*100:.0f}% ({_hits} hits / {_total} shrinks; "
                        f"misses are fresh shrinks, also productive)",
                    )
                elif _miss_telemetry_on:
                    if _rate < 0.50 and _total >= 10:
                        flag(
                            cache_label,
                            f"{_rate*100:.0f}% ({_hits} hits / {_misses} misses) "
                            "— low; cap may be too small or eviction too aggressive",
                            warn=True,
                        )
                    else:
                        ok(
                            cache_label,
                            f"{_rate*100:.0f}% ({_hits} hits / {_misses} misses)",
                        )
                else:
                    # Misses are not recorded when record_zero_savings=false;
                    # we can still show hit count but not a rate.
                    ok(
                        cache_label,
                        f"{_hits} hits (misses not tracked — set stats.record_zero_savings=true)",
                    )
    except FileNotFoundError:
        ok("(none)", "no global.db yet")
    except Exception as _e_cache_rate:  # noqa: BLE001
        flag("cache hit rates", str(_e_cache_rate), warn=True)

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
        # session_brief (r1): startup git-status orientation brief.
        ok("session_brief.enabled", str(cfg.session_brief.enabled).lower())
        # image_shrink (r1): AVIF/JPEG fallback + decode pixel cap.  Surfaces
        # the format threshold knobs added in run 1 so a user wondering "why
        # is my screenshot still 800 KB" can confirm AVIF is on (or see that
        # libaom is missing via the Pillow codec line above).
        ok("image_shrink.prefer_avif", str(cfg.image_shrink.prefer_avif).lower())
        ok("image_shrink.avif_quality", str(cfg.image_shrink.avif_quality))
        ok("image_shrink.jpeg_quality", str(cfg.image_shrink.jpeg_quality))
        ok("image_shrink.max_image_pixels", str(cfg.image_shrink.max_image_pixels))
        # curator (r2-r3): adaptive hint suppression once the agent ignores too
        # many.  Threshold + sample size answer "why did dedup hints go quiet?".
        ok("curator.enabled", str(cfg.curator.enabled).lower())
        ok("curator.min_samples", str(cfg.curator.min_samples))
        ok("curator.threshold_pct", str(cfg.curator.threshold_pct))
        # hint_budget: hard per-session caps that take over after curator.
        ok("hint_budget.enabled", str(cfg.hint_budget.enabled).lower())
        ok("hint_budget.max_per_session", str(cfg.hint_budget.max_per_session))
        ok(
            "hint_budget.max_structured_per_session",
            str(cfg.hint_budget.max_structured_per_session),
        )
        ok(
            "hint_budget.max_index_only_per_session",
            str(cfg.hint_budget.max_index_only_per_session),
        )
        # repomap (r1): compact-mode file threshold for `token-goat map --compact`.
        ok("repomap.compact_file_threshold", str(cfg.repomap.compact_file_threshold))
        # repomap (r2): exclude test dirs from repo map PageRank computation.
        ok("repomap.exclude_tests", str(cfg.repomap.exclude_tests).lower())
        # stats (r2): record_zero_savings switch.  Suggestion-only hints (zero
        # tokens saved, zero injection cost) skip writing stat rows by default
        # to keep the hot pre-read path cheap.  Surfacing it explicitly avoids
        # a "where did my zero-savings rows go?" investigation.
        ok("stats.record_zero_savings", str(cfg.stats.record_zero_savings).lower())
        # webfetch (security-relevant): URL allowlist / denylist sizes.  Showing
        # the list lengths rather than full contents avoids leaking sensitive
        # internal hostnames into doctor output that the user might paste into
        # a bug report.
        ok("webfetch.allow", f"{len(cfg.webfetch.allow)} pattern(s)")
        ok("webfetch.deny", f"{len(cfg.webfetch.deny)} pattern(s)")
        # indexing: large-file thresholds added in iter 18.
        ok(
            "indexing.large_file_symbol_only_kb",
            f"{cfg.indexing.large_file_symbol_only_kb} KB "
            f"(files larger than this get symbol-only indexing, no embeddings)",
        )
        ok(
            "indexing.large_file_skip_kb",
            f"{cfg.indexing.large_file_skip_kb} KB "
            f"(files larger than this are skipped entirely)",
        )
        # decision log: always-on opt-in CLI feature; surface the per-session
        # cap so the user knows the implicit ceiling.
        try:
            from . import session as _session  # noqa: PLC0415

            ok("decision_log.max_per_session", str(_session.DECISION_HISTORY_MAX))
        except Exception as exc:  # noqa: BLE001
            flag("decision_log.max_per_session", str(exc), warn=True)
    except Exception as e:  # noqa: BLE001
        flag("config load", str(e), warn=True)

    # ------------------------------------------------------------------
    # 13c. Compaction budget utilization (r5 iter 4)
    # ------------------------------------------------------------------
    # Reads compact_manifest stat rows (written by pre_compact hook) and reports
    # p50/p95/max utilization (actual_tokens / budget) over the trailing 30
    # days, plus a manual-vs-auto trigger breakdown.  Answers "are real
    # manifests landing near their budget caps or always under?" so the caps
    # can be tuned against data instead of guessed.  Warns when consistently
    # >95 % (sections being truncated, raise the cap) or <30 % (waste budget,
    # lower the cap).
    typer.echo("\nCompaction utilization (30 d)")
    try:
        _compact_cutoff = int(time.time()) - 30 * 86400
        _compact_rows: list[tuple[int, int, str]] = []
        with _db.open_global_readonly() as conn:
            for _detail_row in conn.execute(
                "SELECT detail FROM stats WHERE kind = ? AND ts >= ?",
                ("compact_manifest", _compact_cutoff),
            ).fetchall():
                _detail = _detail_row[0]
                if not _detail or not isinstance(_detail, str):
                    continue
                # Parse "budget=N,actual=M,trigger=T,events=E" — tolerant to
                # ordering, extra keys, and partial corruption.  Anything that
                # does not yield a positive budget+actual is silently skipped.
                _kv: dict[str, str] = {}
                for _part in _detail.split(","):
                    if "=" in _part:
                        _k, _v = _part.split("=", 1)
                        _kv[_k.strip()] = _v.strip()
                try:
                    _budget = int(_kv.get("budget", "0"))
                    _actual = int(_kv.get("actual", "0"))
                except ValueError:
                    continue
                if _budget <= 0 or _actual < 0:
                    continue
                _trigger = _kv.get("trigger", "unknown")
                _compact_rows.append((_budget, _actual, _trigger))

        if not _compact_rows:
            ok("(none)", "no manifest emits in last 30 d")
        else:
            _utils = sorted(_a / _b for _b, _a, _ in _compact_rows)
            _n = len(_utils)
            # p50/p95 via nearest-rank (no numpy dep): index = ceil(p/100 * n) - 1.
            # Both use the same ceiling formula: (n*p + 99) // 100 - 1.
            _p50 = _utils[max(0, (_n * 50 + 99) // 100 - 1)]
            _p95 = _utils[max(0, (_n * 95 + 99) // 100 - 1)]
            _u_max = _utils[-1]
            ok(
                "emits",
                f"{_n} (p50={_p50*100:.0f}%, p95={_p95*100:.0f}%, max={_u_max*100:.0f}%)",
            )

            # Trigger breakdown — auto-trigger manifests get the multiplier,
            # so their effective budget is larger; separating them avoids
            # blending two distinct distributions into one summary line.
            _by_trigger: dict[str, list[float]] = {}
            for _b, _a, _t in _compact_rows:
                _by_trigger.setdefault(_t, []).append(_a / _b)
            for _t in ("manual", "auto"):
                _vals = _by_trigger.get(_t)
                if _vals:
                    _avg = sum(_vals) / len(_vals)
                    ok(
                        f"{_t} trigger",
                        f"{len(_vals)} emits, avg={_avg*100:.0f}% utilization",
                    )

            # Tier breakdown — group emits by budget bucket so a single
            # outlier budget does not skew the global p50/p95.  Buckets
            # follow the repomap token tiers (300/500/1500/4000+) to surface
            # whether each tier hits its cap consistently.
            _tiers: list[tuple[str, int, int]] = [
                ("≤300", 0, 300),
                ("301-500", 301, 500),
                ("501-1500", 501, 1500),
                (">1500", 1501, 10**9),
            ]
            for _label, _lo, _hi in _tiers:
                _bucket = [
                    _a / _b
                    for _b, _a, _ in _compact_rows
                    if _lo <= _b <= _hi
                ]
                if _bucket:
                    _bucket_avg = sum(_bucket) / len(_bucket)
                    ok(
                        f"tier {_label}",
                        f"{len(_bucket)} emits, avg={_bucket_avg*100:.0f}% utilization",
                    )

            # Warnings — consistent over-utilization means sections are being
            # truncated; consistent under-utilization means the budget cap is
            # too generous and the manifest could afford a wider scope.
            if _p95 > 0.95:
                flag(
                    "utilization",
                    f"p95={_p95*100:.0f}% — manifests routinely hit the budget cap; "
                    "consider raising compact_assist.max_manifest_tokens",
                    warn=True,
                )
            elif _p95 < 0.30 and _n >= 5:
                flag(
                    "utilization",
                    f"p95={_p95*100:.0f}% — manifests rarely fill the budget; "
                    "consider lowering compact_assist.max_manifest_tokens to free context",
                    warn=True,
                )
    except FileNotFoundError:
        ok("(none)", "no global.db yet")
    except Exception as _e_compact:  # noqa: BLE001
        flag("compaction utilization", str(_e_compact), warn=True)

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
