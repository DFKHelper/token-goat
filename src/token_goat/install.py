"""install + uninstall: scheduled tasks, settings.json, CLAUDE.md, skill, permission allowlist."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import TypedDict, cast

from . import paths


class _HookCommandEntry(TypedDict):
    """A single hook command definition in Claude Code / Codex settings.

    Represents one entry in the ``hooks`` list of a matcher block::

        {"type": "command", "command": "token-goat hook pre-read", "timeout": 5000}
    """

    type: str
    command: str
    timeout: int


class _HookMatcherEntry(TypedDict):
    """A single matcher block: one event-pattern → list of hook commands.

    Represents one entry in the per-event list inside the top-level hooks dict::

        {"matcher": "Read", "hooks": [{"type": "command", ...}]}
    """

    matcher: str
    hooks: list[_HookCommandEntry]


# Markers for idempotent Codex AGENTS.md patching
CODEX_AGENTS_BEGIN = "<!-- token-goat-codex-begin -->"
CODEX_AGENTS_END = "<!-- token-goat-codex-end -->"

_LOG = logging.getLogger("token_goat.install")

# Markers for idempotent CLAUDE.md patching
CLAUDE_MD_BEGIN = "<!-- token-goat-begin -->"
CLAUDE_MD_END = "<!-- token-goat-end -->"

# Legacy markers from the pre-rename "tokenwise" era. These blocks describe the
# old binary name and produce incorrect routing instructions; the patch path
# strips them on install so a single install run leaves only the modern block.
LEGACY_CLAUDE_MD_BEGIN = "<!-- tokenwise-begin -->"
LEGACY_CLAUDE_MD_END = "<!-- tokenwise-end -->"
LEGACY_CODEX_AGENTS_BEGIN = "<!-- tokenwise-codex-begin -->"
LEGACY_CODEX_AGENTS_END = "<!-- tokenwise-codex-end -->"

# Scheduled task names (Windows)
TASK_WORKER = "token-goat-worker"
TASK_UPDATE = "token-goat-update"

# Linux autostart constants
SYSTEMD_SERVICE_NAME = "token-goat-worker"
CRON_JOB_MARKER = "# token-goat-autoupdate"

# macOS autostart constants
LAUNCHD_PLIST_NAME = "com.dfkhelper.token-goat-worker"


def claude_dir() -> Path:
    """Return ~/.claude/"""
    return Path.home() / ".claude"


def claude_settings_path() -> Path:
    """Return the path to ~/.claude/settings.json where hooks and permissions are configured."""
    return claude_dir() / "settings.json"


def claude_md_path() -> Path:
    """Return the path to ~/.claude/CLAUDE.md where project memory and instructions live."""
    return claude_dir() / "CLAUDE.md"


def skill_dir() -> Path:
    """Return the directory where the token-goat skill is installed (Claude Code plugins)."""
    return claude_dir() / "skills" / "token-goat"


def token_goat_binary() -> str:
    """Return the path to the token-goat executable. Falls back to 'token-goat' (PATH-resolved)."""
    binary = shutil.which("token-goat")
    if binary:
        return binary
    return "token-goat"


def _launcher_bin_dirs() -> set[Path]:
    """Return bin directories that currently host token-goat launchers."""
    dirs: set[Path] = set()
    for binary_name in ("token-goat", "token-goat-hook", "token-goat-worker"):
        binary = shutil.which(binary_name)
        if not binary:
            continue
        try:
            dirs.add(Path(binary).resolve().parent)
        except OSError:
            dirs.add(Path(binary).parent)
    return dirs


def _remove_legacy_launchers() -> list[str]:
    """Remove legacy tokenwise launchers that live beside token-goat launchers."""
    launcher_dirs = _launcher_bin_dirs()
    if not launcher_dirs:
        return []

    removed: list[str] = []
    for binary_name in ("tokenwise", "tokenwise-hook", "tokenwise-worker"):
        legacy = shutil.which(binary_name)
        if not legacy:
            continue

        legacy_path = Path(legacy)
        try:
            legacy_dir = legacy_path.resolve().parent
        except OSError:
            legacy_dir = legacy_path.parent

        if legacy_dir not in launcher_dirs:
            continue

        try:
            legacy_path.unlink()
            removed.append(str(legacy_path))
            _LOG.info("removed legacy launcher: %s", legacy_path)
        except FileNotFoundError:
            continue
        except OSError as e:
            _LOG.warning("failed to remove legacy launcher %s: %s", legacy_path, e)

    if removed:
        _LOG.info("legacy launchers removed: %d (%s)", len(removed), ", ".join(removed))
    return removed


def _resolve_binary(name: str) -> str:
    """Return *name* from PATH if found, otherwise fall back to ``token_goat_binary()``.

    Used for the windowless GUI-subsystem variants (``token-goat-hook``,
    ``token-goat-worker``) which share the same fall-back logic: if the
    specialised entry point is not on PATH, the standard ``token-goat``
    binary is used instead.
    """
    binary = shutil.which(name)
    return binary if binary else token_goat_binary()


def token_goat_hook_binary() -> str:
    """Path to the windowless (GUI-subsystem) entry for hooks.

    On Windows, this is ``token-goat-hook.exe`` from pyproject ``[project.gui-scripts]``.
    It runs the same code as ``token-goat`` but with the Windows GUI subsystem so no
    console window is allocated when Claude Code spawns it for every hook call.
    Falls back to ``token-goat`` if the windowless variant isn't installed.
    """
    return _resolve_binary("token-goat-hook")


def token_goat_worker_binary() -> str:
    """Windowless entry for the background worker. Falls back to ``token-goat``."""
    return _resolve_binary("token-goat-worker")


# ---------------------------------------------------------------------------
# Small result-formatting helpers
# ---------------------------------------------------------------------------


def _ok_fail(ok: bool, detail: str, *, max_detail: int = 200) -> str:
    """Format a (bool, str) task result as ``"ok — detail"`` or ``"FAIL — detail"``.

    Centralises the repeated pattern in ``install_all`` where every step produces
    a ``tuple[bool, str]`` and needs the same rendering logic.
    """
    prefix = "ok" if ok else "FAIL"
    return f"{prefix} — {detail[:max_detail]}"


def _run_step(result: dict[str, str], key: str, fn: Callable[[], object]) -> None:
    """Run *fn* and record ``"ok — <return value>"`` or ``"FAIL — <exc>"`` in *result[key]*.

    Eliminates the repeated ``try: result[key] = f"ok — {fn()}"; except Exception as e:
    result[key] = f"FAIL — {e}"`` pattern used for optional harness-integration steps
    in :func:`install_all` (codex, opencode, openclaw patches).
    """
    try:
        detail = fn()
        result[key] = f"ok — {detail}"
        _LOG.info("install step ok: %s — %s", key, str(detail)[:200])
    except Exception as e:  # noqa: BLE001
        result[key] = f"FAIL — {e}"
        _LOG.warning("install step failed: %s — %s", key, e)


# ---------------------------------------------------------------------------
# Scheduled Tasks (Windows)
# ---------------------------------------------------------------------------


def _run_schtasks(args: list[str]) -> tuple[int, str]:
    """Wrap schtasks.exe subprocess call."""
    try:
        result = subprocess.run(
            ["schtasks.exe"] + args,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode, (result.stdout or "") + (result.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def task_exists(name: str) -> bool:
    """Check if a Windows scheduled task with the given name exists."""
    code, _ = _run_schtasks(["/Query", "/TN", name])
    return code == 0


def install_worker_task() -> tuple[bool, str]:
    """Register the token-goat worker to run at user logon via the HKCU Run key.

    schtasks ONLOGON requires admin even with /RU on most Windows UAC setups.
    HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run is the standard
    user-scope at-logon mechanism and never needs elevation.

    Command uses ``pythonw.exe -m token_goat.cli worker --daemon`` so AV/EDR
    products don't behavior-flag the at-logon spawn (a tiny launcher .exe in
    a user-writable directory is a textbook payload-drop signature; pythonw
    invoking a module is not).
    """
    cmd = paths.python_runner_command("worker", "--daemon")

    if sys.platform != "win32":
        return True, "non-Windows: skipped"

    try:
        import winreg  # type: ignore[import]
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        )
        winreg.SetValueEx(key, TASK_WORKER, 0, winreg.REG_SZ, cmd)
        winreg.CloseKey(key)
        _LOG.info("HKCU Run key set: key=%s cmd=%s", TASK_WORKER, cmd)
        return True, f"HKCU Run key set: {cmd}"
    except OSError as exc:
        _LOG.warning("failed to set HKCU Run key %s: %s", TASK_WORKER, exc)
        return False, str(exc)


_USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-\\@]{1,128}$')


def _safe_username() -> str:
    """Return the current Windows username if it matches a safe pattern, else empty string.

    USERNAME is pulled from the environment and validated before being passed to
    schtasks /RU.  An attacker who can tamper with the environment could otherwise
    inject unexpected argument values.  We use a strict allowlist (alphanumeric
    plus ``_ . - \\ @``) that covers all realistic Windows usernames including
    domain accounts (``DOMAIN\\user``) and UPN-style accounts (``user@domain``).
    Any value that does not match is silently dropped — schtasks runs without /RU
    in that case, which defaults to the current user, which is the desired behaviour.
    """
    username = (os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()
    if not username:
        return ""
    if not _USERNAME_RE.match(username):
        _LOG.warning(
            "install_update_task: USERNAME %r failed safety check; omitting /RU argument",
            username,
        )
        return ""
    return username


def install_update_task() -> tuple[bool, str]:
    """Create the weekly auto-update scheduled task (Sunday 03:00, user scope)."""
    if sys.platform != "win32":
        return True, "non-Windows: skipped"
    if task_exists(TASK_UPDATE):
        _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"])

    username = _safe_username()
    args = [
        "/Create",
        "/TN", TASK_UPDATE,
        "/SC", "WEEKLY",
        "/D", "SUN",
        "/ST", "03:00",
        "/RL", "LIMITED",
        "/F",
        "/TR", 'cmd /c "uv tool upgrade token-goat"',
    ]
    if username:
        args += ["/RU", username]
    t0 = time.monotonic()
    code, out = _run_schtasks(args)
    elapsed_ms = (time.monotonic() - t0) * 1000
    if code == 0:
        _LOG.info("update task registered: task=%s user=%r (%.0fms)", TASK_UPDATE, username or "<current>", elapsed_ms)
    else:
        _LOG.warning("update task registration failed: task=%s code=%d (%.0fms): %s", TASK_UPDATE, code, elapsed_ms, out.strip())
    return code == 0, out


def uninstall_tasks() -> list[str]:
    """Remove worker Run key + update scheduled task. Returns list of names removed."""
    removed = []

    # Worker: HKCU Run registry key
    if sys.platform == "win32":
        try:
            import winreg  # type: ignore[import]
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_SET_VALUE,
            )
            winreg.DeleteValue(key, TASK_WORKER)
            winreg.CloseKey(key)
            removed.append(TASK_WORKER)
        except FileNotFoundError:
            pass  # key didn't exist
        except OSError as e:
            _LOG.warning("failed to remove registry autostart entry: %s", e)

    # Update task: still a schtasks WEEKLY entry
    if task_exists(TASK_UPDATE):
        code, _ = _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"])
        if code == 0:
            removed.append(TASK_UPDATE)

    return removed


# ---------------------------------------------------------------------------
# Linux autostart (systemd user service + XDG autostart fallback)
# ---------------------------------------------------------------------------


def _systemd_user_dir() -> Path:
    """Return ~/.config/systemd/user/"""
    return Path.home() / ".config" / "systemd" / "user"


def _systemd_service_path() -> Path:
    """Return ~/.config/systemd/user/token-goat-worker.service"""
    return _systemd_user_dir() / f"{SYSTEMD_SERVICE_NAME}.service"


def _xdg_autostart_path() -> Path:
    """Return ~/.config/autostart/token-goat-worker.desktop"""
    return Path.home() / ".config" / "autostart" / "token-goat-worker.desktop"


def _systemd_user_available() -> bool:
    """Return True if systemd --user is running and accepting service management."""
    try:
        r = subprocess.run(
            ["systemctl", "--user", "--no-pager", "is-system-running"],
            capture_output=True,
            timeout=5,
        )
        out = (r.stdout or b"").decode(errors="replace").strip()
        return out in ("running", "degraded")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def install_linux_autostart() -> tuple[bool, str]:
    """Register worker autostart on Linux.

    Tries systemd --user first; falls back to an XDG autostart .desktop file.
    On WSL without systemd the XDG file is written but won't trigger at logon —
    the SessionStart watchdog in hooks_cli ensures the worker runs on every
    Claude Code session regardless.
    """

    if sys.platform == "win32":
        return True, "Windows: skipped"

    import shlex  # noqa: PLC0415

    cmd_args = paths.python_runner_argv("worker", "--daemon")
    # Shell-quote every argument so paths containing spaces (e.g. a home
    # directory like "/home/user name/...") are correctly represented in the
    # systemd unit file's ExecStart= directive and in the XDG .desktop Exec=
    # field.  Both formats accept POSIX shell quoting, and shlex.quote wraps
    # any argument that needs it in single-quotes.
    exec_str = " ".join(shlex.quote(a) for a in cmd_args)

    if _systemd_user_available():
        svc_dir = _systemd_user_dir()
        svc_dir.mkdir(parents=True, exist_ok=True)
        svc_path = _systemd_service_path()
        svc_path.write_text(
            "[Unit]\n"
            "Description=token-goat background worker\n"
            "After=default.target\n\n"
            "[Service]\n"
            "Type=simple\n"
            f"ExecStart={exec_str}\n"
            "Restart=on-failure\n"
            "RestartSec=10\n\n"  # 10 s back-off prevents a crash loop from burning CPU
            "[Install]\n"
            "WantedBy=default.target\n",
            encoding="utf-8",
        )
        _LOG.info("systemd service file written: %s", svc_path)
        try:
            t0 = time.monotonic()
            reload_r = subprocess.run(
                ["systemctl", "--user", "daemon-reload"],
                capture_output=True,
                timeout=10,
            )
            reload_ms = (time.monotonic() - t0) * 1000
            if reload_r.returncode != 0:
                _LOG.warning(
                    "systemctl daemon-reload exited %d (%.0fms): %s",
                    reload_r.returncode, reload_ms,
                    (reload_r.stderr or b"").decode(errors="replace").strip(),
                )
            else:
                _LOG.debug("systemctl daemon-reload ok (%.0fms)", reload_ms)

            t1 = time.monotonic()
            enable_r = subprocess.run(
                ["systemctl", "--user", "enable", SYSTEMD_SERVICE_NAME],
                capture_output=True,
                timeout=10,
            )
            enable_ms = (time.monotonic() - t1) * 1000
            if enable_r.returncode != 0:
                _LOG.warning(
                    "systemctl enable %s exited %d (%.0fms): %s",
                    SYSTEMD_SERVICE_NAME, enable_r.returncode, enable_ms,
                    (enable_r.stderr or b"").decode(errors="replace").strip(),
                )
            else:
                _LOG.info("systemctl enable %s ok (%.0fms)", SYSTEMD_SERVICE_NAME, enable_ms)

            return True, f"systemd user service installed: {svc_path}"
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            _LOG.warning("systemctl unavailable or timed out: %s", e)
            return False, f"systemd enable failed: {e}"

    # Fallback: XDG autostart .desktop file. Works on desktop sessions (GNOME,
    # KDE, XFCE). On WSL the SessionStart watchdog fills the gap.
    desktop = _xdg_autostart_path()
    desktop.parent.mkdir(parents=True, exist_ok=True)
    desktop.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=token-goat worker\n"
        f"Exec={exec_str}\n"
        "Hidden=false\n"
        "NoDisplay=true\n"
        "X-GNOME-Autostart-enabled=true\n",
        encoding="utf-8",
    )
    _LOG.info("XDG autostart file written: %s", desktop)
    return True, (
        f"XDG autostart installed: {desktop} "
        "(SessionStart watchdog also ensures the worker runs)"
    )


def uninstall_linux_autostart() -> list[str]:
    """Remove Linux autostart entries. Returns a list of paths removed."""

    if sys.platform == "win32":
        return []

    removed: list[str] = []

    svc_path = _systemd_service_path()
    if svc_path.exists():
        with contextlib.suppress(FileNotFoundError, subprocess.TimeoutExpired):
            subprocess.run(
                ["systemctl", "--user", "disable", "--now", SYSTEMD_SERVICE_NAME],
                capture_output=True,
                timeout=10,
            )
        try:
            svc_path.unlink()
            subprocess.run(
                ["systemctl", "--user", "daemon-reload"],
                capture_output=True,
                timeout=10,
            )
            removed.append(str(svc_path))
        except OSError as e:
            _LOG.warning("failed to remove systemd service: %s", e)

    desktop = _xdg_autostart_path()
    if desktop.exists():
        try:
            desktop.unlink()
            removed.append(str(desktop))
        except OSError as e:
            _LOG.warning("failed to remove XDG autostart: %s", e)

    return removed


def install_linux_update_cron() -> tuple[bool, str]:
    """Add a weekly Sunday 03:00 cron job to auto-update token-goat."""

    if sys.platform == "win32":
        return True, "Windows: skipped"

    cron_line = f"0 3 * * 0 uv tool upgrade token-goat {CRON_JOB_MARKER}"
    try:
        r = subprocess.run(
            ["crontab", "-l"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        # crontab -l exits 1 with no output on a fresh system that has no crontab yet;
        # treat that as an empty crontab rather than an error.
        existing = r.stdout if r.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return False, f"crontab unavailable: {e}"

    lines = [ln for ln in existing.splitlines() if CRON_JOB_MARKER not in ln]
    lines.append(cron_line)
    new_crontab = "\n".join(lines) + "\n"

    try:
        r2 = subprocess.run(
            ["crontab", "-"],
            input=new_crontab,
            text=True,
            capture_output=True,
            timeout=10,
        )
        if r2.returncode == 0:
            _LOG.info("cron job installed: %s", cron_line)
        else:
            _LOG.warning(
                "crontab write exited %d: %s",
                r2.returncode,
                (r2.stderr or "").strip(),
            )
        return r2.returncode == 0, f"cron job added: {cron_line}"
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        _LOG.warning("crontab write failed: %s", e)
        return False, f"crontab write failed: {e}"


def uninstall_linux_update_cron() -> str:
    """Remove the token-goat cron job."""

    if sys.platform == "win32":
        return "n/a (Windows)"

    try:
        r = subprocess.run(
            ["crontab", "-l"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            return "no crontab found"
        lines = [ln for ln in r.stdout.splitlines() if CRON_JOB_MARKER not in ln]
        subprocess.run(
            ["crontab", "-"],
            input="\n".join(lines) + "\n",
            text=True,
            capture_output=True,
            timeout=10,
        )
        return "cron job removed"
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return f"crontab unavailable: {e}"


# ---------------------------------------------------------------------------
# macOS autostart (launchd user agent)
# ---------------------------------------------------------------------------


def _launchd_plist_path() -> Path:
    """Return ~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist"""
    return Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_PLIST_NAME}.plist"


def _xml_escape(s: str) -> str:
    """Escape a string for safe embedding in XML element content.

    Guards against XML injection in the macOS LaunchAgent plist when a
    command-line argument or file-system path contains ``<``, ``>``, ``&``,
    ``'``, or ``"``.  Uses ``html.escape`` (stdlib) with ``quote=True`` for
    the mandatory set, then normalises Python's ``&#x27;`` back to the
    XML-standard ``&apos;`` so output is attribute-safe and XML-spec-clean.
    """
    import html  # noqa: PLC0415
    return html.escape(s, quote=True).replace("&#x27;", "&apos;")


def install_mac_autostart() -> tuple[bool, str]:
    """Register worker autostart on macOS via a LaunchAgent plist.

    Writes ~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist and
    calls `launchctl load` to activate it immediately.  No admin required —
    LaunchAgents run in user scope.  Idempotent: unloads before re-loading if
    the plist already exists.
    """

    if sys.platform == "win32":
        return True, "Windows: skipped"

    cmd_args = paths.python_runner_argv("worker", "--daemon")
    plist_path = _launchd_plist_path()
    plist_path.parent.mkdir(parents=True, exist_ok=True)

    # XML-escape every argument and path to guard against injection when a
    # homedir or binary path contains characters special to XML (<, >, &, ", ').
    arg_entries = "\n".join(
        f"        <string>{_xml_escape(arg)}</string>" for arg in cmd_args
    )
    log_dir = paths.logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)

    plist_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
        ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n'
        "<dict>\n"
        "    <key>Label</key>\n"
        f"    <string>{_xml_escape(LAUNCHD_PLIST_NAME)}</string>\n"
        "    <key>ProgramArguments</key>\n"
        "    <array>\n"
        f"{arg_entries}\n"
        "    </array>\n"
        "    <key>RunAtLoad</key>\n"
        "    <true/>\n"
        "    <key>KeepAlive</key>\n"
        "    <false/>\n"
        "    <key>StandardOutPath</key>\n"
        f"    <string>{_xml_escape(str(log_dir / 'worker-stdout.log'))}</string>\n"
        "    <key>StandardErrorPath</key>\n"
        f"    <string>{_xml_escape(str(log_dir / 'worker-stderr.log'))}</string>\n"
        "</dict>\n"
        "</plist>\n"
    )
    plist_path.write_text(plist_xml, encoding="utf-8")

    # Unload first (idempotent — ignore errors if not loaded yet)
    unload_r = subprocess.run(
        ["launchctl", "unload", str(plist_path)],
        capture_output=True,
        timeout=10,
    )
    _LOG.debug(
        "launchctl unload %s: exit=%d",
        LAUNCHD_PLIST_NAME,
        unload_r.returncode,
    )
    try:
        r = subprocess.run(
            ["launchctl", "load", str(plist_path)],
            capture_output=True,
            timeout=10,
        )
        if r.returncode != 0:
            err = (r.stderr or b"").decode(errors="replace").strip()
            _LOG.warning("launchctl load %s failed (exit=%d): %s", LAUNCHD_PLIST_NAME, r.returncode, err)
            return False, f"launchctl load failed: {err}"
        _LOG.info("LaunchAgent installed and loaded: %s", plist_path)
        return True, f"LaunchAgent installed: {plist_path}"
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        _LOG.warning("launchctl unavailable for %s: %s", LAUNCHD_PLIST_NAME, e)
        return False, f"launchctl unavailable: {e}"


def uninstall_mac_autostart() -> list[str]:
    """Remove the macOS LaunchAgent plist. Returns a list of paths removed."""

    if sys.platform == "win32":
        return []

    removed: list[str] = []
    plist_path = _launchd_plist_path()
    if plist_path.exists():
        with contextlib.suppress(FileNotFoundError, subprocess.TimeoutExpired):
            subprocess.run(
                ["launchctl", "unload", str(plist_path)],
                capture_output=True,
                timeout=10,
            )
        try:
            plist_path.unlink()
            removed.append(str(plist_path))
            _LOG.info("removed LaunchAgent plist: %s", plist_path)
        except OSError as e:
            _LOG.warning("failed to remove LaunchAgent plist: %s", e)
    return removed


def _check_mac_autostart() -> str:
    """Return the macOS LaunchAgent status string."""
    if sys.platform == "win32":
        return "n/a (Windows)"
    return "installed" if _launchd_plist_path().exists() else "not installed"


def _check_linux_autostart() -> str:
    """Return the Linux autostart status string."""
    if sys.platform == "win32":
        return "n/a (Windows)"
    if _systemd_service_path().exists():
        return "installed (systemd user service)"
    if _xdg_autostart_path().exists():
        return "installed (XDG autostart)"
    return "not installed"


def _check_linux_update_cron() -> str:
    """Return the Linux cron job status string."""
    if sys.platform == "win32":
        return "n/a (Windows)"
    try:
        r = subprocess.run(
            ["crontab", "-l"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if r.returncode != 0:
            return "not installed (no crontab)"
        return "installed" if CRON_JOB_MARKER in r.stdout else "not installed"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "n/a (crontab unavailable)"


# ---------------------------------------------------------------------------
# settings.json patching
# ---------------------------------------------------------------------------


def _hooks_block(binary: str | None = None) -> dict[str, list[_HookMatcherEntry]]:
    """Build the hooks structure token-goat wants to install.

    The ``binary`` parameter is kept for backwards compatibility but unused;
    commands now invoke ``pythonw.exe -m token_goat.cli`` directly. See
    ``paths.python_runner_command`` for why (AV/EDR launcher-binary flagging).
    """
    runner = paths.python_runner_command
    return {
        "SessionStart": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "session-start"),
                        "timeout": 30000,
                    }
                ],
            }
        ],
        "PreToolUse": [
            {
                # ``Bash`` is included so token-goat can rewrite noisy commands
                # (pytest, npm install, docker build, ...) to flow through
                # ``token-goat compress``, which captures stdout/stderr and
                # emits a per-tool compressed view that strips progress bars,
                # dedupes warnings, and surfaces failures first.  Disabled by
                # setting TOKEN_GOAT_BASH_COMPRESS=0.  ``Grep`` is included so
                # the pre-Grep dedup hint fires on repeat ``(pattern, path)``
                # invocations within the staleness window.
                "matcher": "Read|Grep|Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-read"),
                        "timeout": 5000,
                    }
                ],
            },
            {
                "matcher": "mcp__claude_ai_Google_Drive__.*|WebFetch",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-fetch"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "Edit|Write|MultiEdit",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-edit"),
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Read|Grep|Glob",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-read"),
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-bash"),
                        "timeout": 3000,
                    }
                ],
            },
            {
                "matcher": "WebFetch",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-fetch"),
                        "timeout": 3000,
                    }
                ],
            },
        ],
        "PreCompact": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-compact"),
                        "timeout": 5000,
                    }
                ],
            }
        ],
    }


def _strip_token_goat_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    """Remove hook entries belonging to token-goat (for idempotent re-install)."""
    kept: list[dict[str, object]] = []
    for entry in entries:
        raw_hooks = entry.get("hooks", [])
        hook_list: list[dict[str, object]] = raw_hooks if isinstance(raw_hooks, list) else []
        surviving_hooks = [
            h for h in hook_list
            if isinstance(h, dict) and "token_goat" not in str(h.get("command", ""))
        ]
        if surviving_hooks:
            kept.append({"matcher": entry.get("matcher", "*"), "hooks": surviving_hooks})
    return kept


def _read_settings_json(settings_path: Path) -> dict[str, object] | None:
    """Parse *settings_path* as JSON and return the dict.

    Returns ``None`` when the file does not exist (caller should start from
    ``{}``).  Raises ``json.JSONDecodeError`` on malformed content so callers
    can surface an actionable error message rather than silently overwriting.
    Raises ``json.JSONDecodeError`` when the top-level value is not a JSON object
    (e.g. a bare array or string) — settings.json must always be an object.
    """
    if not settings_path.exists():
        return None
    try:
        raw = settings_path.read_text(encoding="utf-8")
    except OSError as e:
        raise OSError(f"could not read settings.json: {e}") from e
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise json.JSONDecodeError(
            f"settings.json must be a JSON object, got {type(data).__name__}",
            str(data),
            0,
        )
    return data


def _write_settings_json(settings_path: Path, data: dict[str, object]) -> None:
    """Write *data* as indented JSON to *settings_path* atomically.

    Uses a temp-file + rename pattern so a crash or kill mid-write never
    leaves a truncated or empty settings.json behind.  The directory is
    created if it does not exist.  Uses indent=2 to match Claude Code's own
    formatting so the file stays human-readable and produces minimal diffs
    when re-applied.
    """
    paths.atomic_write_text(settings_path, json.dumps(data, indent=2))


def patch_settings_json() -> tuple[bool, str]:
    """Add token-goat hooks to ~/.claude/settings.json idempotently. Preserves other hooks."""
    settings_path = claude_settings_path()
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    if settings_path.exists():
        try:
            current = _read_settings_json(settings_path) or {}
        except json.JSONDecodeError:
            return False, "settings.json is malformed JSON"
    else:
        current = {}

    binary = token_goat_hook_binary()
    our_hooks = _hooks_block(binary)

    # Backup before any modification
    if settings_path.exists():
        backup = settings_path.with_suffix(
            f".json.bak.{datetime.now():%Y%m%d-%H%M%S}"
        )
        shutil.copy2(settings_path, backup)

    raw_hooks = current.get("hooks", {})
    existing_hooks: dict[str, list[dict[str, object]]] = raw_hooks if isinstance(raw_hooks, dict) else {}
    hooks_added: list[str] = []
    hooks_replaced: list[str] = []
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        # Strip any prior token-goat entries, then append fresh ones
        kept = _strip_token_goat_entries(existing_entries)
        stripped_count = len(existing_entries) - len(kept)
        existing_hooks[event] = kept + cast(list[dict[str, object]], entries)
        if stripped_count:
            hooks_replaced.append(f"{event}(replaced {stripped_count})")
        else:
            hooks_added.append(event)
    current["hooks"] = existing_hooks
    if hooks_replaced:
        _LOG.info("patch_settings_json: replaced existing entries for: %s", ", ".join(hooks_replaced))
    if hooks_added:
        _LOG.info("patch_settings_json: added new hook entries for: %s", ", ".join(hooks_added))

    # Permission allowlist
    raw_perms = current.get("permissions", {})
    perms: dict[str, object] = raw_perms if isinstance(raw_perms, dict) else {}
    raw_allowed = perms.get("allow", [])
    allowed: list[str] = list(raw_allowed) if isinstance(raw_allowed, list) else []
    perm_added = "Bash(token-goat:*)" not in allowed
    if perm_added:
        allowed.append("Bash(token-goat:*)")
        _LOG.info("patch_settings_json: added permission Bash(token-goat:*)")
    else:
        _LOG.debug("patch_settings_json: permission Bash(token-goat:*) already present")
    perms["allow"] = allowed
    current["permissions"] = perms

    _write_settings_json(settings_path, current)
    _LOG.info("patch_settings_json: wrote %s", settings_path)
    return True, str(settings_path)


def unpatch_settings_json() -> str:
    """Remove token-goat entries from settings.json."""
    settings_path = claude_settings_path()
    if not settings_path.exists():
        return "settings.json not found (nothing to do)"
    try:
        current = _read_settings_json(settings_path) or {}
    except json.JSONDecodeError:
        return "settings.json malformed; not modifying"

    raw_hooks = current.get("hooks", {})
    hooks: dict[str, list[dict[str, object]]] = raw_hooks if isinstance(raw_hooks, dict) else {}
    for event in list(hooks.keys()):
        cleaned = _strip_token_goat_entries(hooks.get(event, []))
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    current["hooks"] = hooks

    raw_perms = current.get("permissions", {})
    perms: dict[str, object] = raw_perms if isinstance(raw_perms, dict) else {}
    raw_allowed = perms.get("allow", [])
    allowed = [a for a in (raw_allowed if isinstance(raw_allowed, list) else []) if a != "Bash(token-goat:*)"]
    perms["allow"] = allowed
    # Drop permissions key entirely if it has no meaningful content left
    if not perms.get("allow") and not perms.get("deny") and not perms.get("ask"):
        current.pop("permissions", None)
    else:
        current["permissions"] = perms

    _write_settings_json(settings_path, current)
    _LOG.info("unpatch_settings_json: wrote %s", settings_path)
    return str(settings_path)


# ---------------------------------------------------------------------------
# Shared markdown-block patching helpers
# ---------------------------------------------------------------------------


def _patch_md_block(md_path: Path, begin_marker: str, end_marker: str, content: str) -> str:
    """Insert or replace a delimited block in a markdown file idempotently.

    Reads *md_path* (creates it if absent), replaces the region between
    *begin_marker* and *end_marker* with *content*, and writes the result back.
    Returns ``str(md_path)``.

    Extracted to eliminate the identical replace-or-append pattern duplicated
    in ``patch_claude_md`` and ``patch_codex_agents_md``.
    """
    md_path.parent.mkdir(parents=True, exist_ok=True)
    block = f"{begin_marker}\n{content}\n{end_marker}"

    if md_path.exists():
        existing = md_path.read_text(encoding="utf-8")
        if begin_marker in existing and end_marker in existing:
            updated = re.sub(
                re.escape(begin_marker) + r".*?" + re.escape(end_marker),
                block,
                existing,
                flags=re.DOTALL,
            )
        elif existing.strip():
            if not existing.endswith("\n"):
                existing += "\n"
            updated = existing + "\n" + block + "\n"
        else:
            # File exists but is whitespace-only (common right after a legacy
            # strip wiped its sole block). Don't preserve the leading blanks.
            updated = block + "\n"
    else:
        updated = block + "\n"

    # Atomic write: a crash mid-write must never leave a truncated CLAUDE.md or
    # AGENTS.md behind.  Use the same temp-file + rename pattern as settings.json.
    paths.atomic_write_text(md_path, updated)
    return str(md_path)


def _unpatch_md_block(md_path: Path, begin_marker: str, end_marker: str, not_found_msg: str) -> str:
    """Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.

    Returns a status string.  Extracted to eliminate the identical removal
    pattern duplicated in ``unpatch_claude_md`` and ``unpatch_codex_agents_md``.
    """
    if not md_path.exists():
        return not_found_msg
    content = md_path.read_text(encoding="utf-8")
    new = re.sub(
        r"\n*" + re.escape(begin_marker) + r".*?" + re.escape(end_marker) + r"\n*",
        "\n",
        content,
        flags=re.DOTALL,
    ).strip()
    # Atomic write: a crash mid-write must never leave a truncated markdown file behind.
    paths.atomic_write_text(md_path, new + "\n" if new else "")
    return str(md_path)


def _strip_legacy_block(md_path: Path, begin_marker: str, end_marker: str) -> bool:
    """Remove a legacy ``tokenwise``-era delimited block from *md_path* if present.

    Returns ``True`` if a block was stripped, ``False`` otherwise. The modern
    patch path calls this before writing its block so a single install run
    leaves only the up-to-date content — even on machines that were installed
    under the old binary name and never had their routing tables migrated.
    """
    if not md_path.exists():
        return False
    content = md_path.read_text(encoding="utf-8")
    if begin_marker not in content or end_marker not in content:
        return False
    new = re.sub(
        r"\n*" + re.escape(begin_marker) + r".*?" + re.escape(end_marker) + r"\n*",
        "\n",
        content,
        flags=re.DOTALL,
    ).strip()
    paths.atomic_write_text(md_path, new + "\n" if new else "")
    return True


# ---------------------------------------------------------------------------
# CLAUDE.md patching
# ---------------------------------------------------------------------------

CLAUDE_MD_CONTENT = """\
## token-goat - route code reads through token-goat first

token-goat is installed. Before you call Read or Grep on a source file, check for a token-goat command that does the same job for a fraction of the tokens. This is the default path, not an optimization. Skipping it burns context you will need later in the session.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `token-goat symbol getUser` | `Grep "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `token-goat read "src/auth.py::login"` | `Read src/auth.py` (about 85% more tokens) |
| Read one method on a class | `token-goat read "src/auth.py::Session.refresh"` | `Read src/auth.py` |
| Read one section of a doc | `token-goat section "README.md::Install"` | `Read README.md` |
| Disambiguate a duplicate heading | `token-goat section "doc.md::Setup#2"` | `Read doc.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `token-goat map --compact` | Recursive `ls` plus multiple `Read` calls |
| Outline a long Google Doc | `token-goat gdrive-sections <file-id>` | Fetching the whole doc |
| Read one TOML/YAML/JSON/INI/.env/Dockerfile block | `token-goat section "pyproject.toml::tool.ruff"` | `Read pyproject.toml` |
| Re-inspect a recent Bash output | `token-goat bash-output <id> --tail 50` | Re-running the same `pytest`/`cargo`/`git log` |
| Re-inspect a recent WebFetch response | `token-goat web-output <id> --grep "TODO"` | Re-fetching the same docs URL |

Modifiers worth knowing: `symbol --all-projects` (cross-repo); `symbol --strict` to opt out of close-match auto-redirect; `map --compact` (300-token budget); `semantic --max-distance 1.0` or `--no-rerank` to widen / tighten results; `bash-output --grep PATTERN` / `web-output --grep PATTERN` to filter cached output. A miss without an unambiguous close match prints "Did you mean…?" suggestions; a unique close match at high confidence is followed transparently with a `(redirected from: ...)` marker. The pre-Bash, pre-Grep, and pre-WebFetch hooks hint when a tool call is about to repeat in the same session.

Read is the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- It is an image you need to see visually. The shrink runs automatically. Just Read it.

Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts during code work mean you are reaching for Read or Grep where token-goat would apply.
"""


def patch_claude_md() -> str:
    """Add or update the token-goat block in ~/.claude/CLAUDE.md, idempotently."""
    md_path = claude_md_path()
    existed = md_path.exists()
    if _strip_legacy_block(md_path, LEGACY_CLAUDE_MD_BEGIN, LEGACY_CLAUDE_MD_END):
        _LOG.info("patch_claude_md: stripped legacy tokenwise block from %s", md_path)
    result = _patch_md_block(md_path, CLAUDE_MD_BEGIN, CLAUDE_MD_END, CLAUDE_MD_CONTENT)
    action = "updated" if existed else "created"
    _LOG.info("patch_claude_md: %s %s", action, md_path)
    return result


def unpatch_claude_md() -> str:
    """Remove the token-goat block from ~/.claude/CLAUDE.md."""
    return _unpatch_md_block(claude_md_path(), CLAUDE_MD_BEGIN, CLAUDE_MD_END, "CLAUDE.md not found")


# ---------------------------------------------------------------------------
# Skill
# ---------------------------------------------------------------------------

SKILL_MD_CONTENT = """\
---
name: token-goat
description: Use BEFORE reaching for Read or Grep on a source file. token-goat commands replace symbol search, single-function reads, doc-section reads, semantic search, and repo overviews at a fraction of the token cost. Hooks handle image shrink, Drive intercept, and read dedup automatically. Skipping token-goat burns session context.
---

# token-goat

token-goat is installed. Route code and content reads through it first. This is the default path, not optional polish. Tokens you spend rereading files or grepping wide are tokens you will not have for the work that matters.

## Automatic. Do not duplicate.

- Large images on Read get redirected to a shrunken cached copy (about 95% fewer tokens).
- Google Drive downloads get redirected to a token-goat fetch that downloads, shrinks, and caches.
- WebFetch on an image URL gets the same treatment.
- Repeat reads of the same file in one session trigger a system reminder so you do not pay twice.

You do not call these. They run on their own.

## What you DO call

Before reaching for Read or Grep on a code file, check this table.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `token-goat symbol getUser` | `Grep "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `token-goat read "src/auth.py::login"` | `Read src/auth.py` (about 85% more tokens) |
| Read one method on a class | `token-goat read "src/auth.py::Session.refresh"` | `Read src/auth.py` |
| Read one section of a doc | `token-goat section "README.md::Install"` | `Read README.md` |
| Disambiguate a duplicate heading | `token-goat section "doc.md::Setup#2"` | `Read doc.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `token-goat map --compact` | Recursive `ls` plus multiple `Read` calls |
| Outline a long Google Doc | `token-goat gdrive-sections <file-id>` | Fetching the whole doc |
| Read one TOML/YAML/JSON/INI/.env/Dockerfile block | `token-goat section "pyproject.toml::tool.ruff"` | `Read pyproject.toml` |
| Re-inspect a recent Bash output | `token-goat bash-output <id> --tail 50` | Re-running `pytest`/`cargo`/`git log` |
| Re-inspect a recent WebFetch response | `token-goat web-output <id> --grep "TODO"` | Re-fetching the same docs URL |
| See what you have already touched | `token-goat session-touched` | Re-reading and hoping you remember |

Modifiers worth knowing: `symbol --all-projects` searches every indexed repo at once; `symbol --strict` disables close-match auto-redirect; `map --compact` fits a 300-token budget; `semantic --max-distance 1.0` widens or `--no-rerank` tightens semantic results; `bash-output --grep PATTERN` / `web-output --grep PATTERN` filter cached output. A miss prints "Did you mean…?" suggestions — try one of those before falling back to `Read`. A unique high-confidence close match is followed transparently with a `(redirected from: ...)` marker.

## When Read is the right call

- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- You need to view an image visually. The shrink already ran. Just Read it.

## Verify the habit

Run `token-goat stats` and watch event counts climb. Flat counts during code work mean you are reaching for Read or Grep where a token-goat command would apply. Run `token-goat doctor` if anything looks wrong.
"""


def write_skill() -> str:
    """Write the token-goat skill to the Claude Code skills directory."""
    sd = skill_dir()
    sd.mkdir(parents=True, exist_ok=True)
    skill_path = sd / "SKILL.md"
    skill_path.write_text(SKILL_MD_CONTENT, encoding="utf-8")
    _LOG.info("skill written: %s (%d bytes)", skill_path, len(SKILL_MD_CONTENT.encode()))
    return str(skill_path)


def remove_skill() -> str:
    """Remove the token-goat skill from the Claude Code skills directory."""
    sd = skill_dir()
    if sd.exists():
        shutil.rmtree(sd, ignore_errors=True)
        return str(sd)
    return "skill dir not found"


# ---------------------------------------------------------------------------
# Codex integration
# ---------------------------------------------------------------------------


def codex_dir() -> Path:
    """Return ~/.codex/"""
    return Path.home() / ".codex"


def codex_config_path() -> Path:
    """Return the path to ~/.codex/config.toml where Codex hooks are configured."""
    return codex_dir() / "config.toml"


def codex_agents_path() -> Path:
    """Return the path to ~/.codex/AGENTS.md where Codex agents are configured."""
    return codex_dir() / "AGENTS.md"


def _codex_hooks_block(binary: str | None = None) -> dict[str, list[_HookMatcherEntry]]:
    """The hooks structure for Codex's config.toml.

    The ``binary`` parameter is kept for backwards compatibility but unused.
    """
    runner = paths.python_runner_command
    return {
        "SessionStart": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "session-start", "--harness", "codex"),
                        "timeout": 30000,
                    }
                ],
            }
        ],
        "PreToolUse": [
            {
                "matcher": "view_image|Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-read", "--harness", "codex"),
                        "timeout": 5000,
                    }
                ],
            },
            {
                "matcher": "mcp__claude_ai_Google_Drive__.*|web_search",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-fetch", "--harness", "codex"),
                        "timeout": 2000,
                    }
                ],
            },
        ],
        "PostToolUse": [
            {
                "matcher": "apply_patch",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-edit", "--harness", "codex"),
                        "timeout": 2000,
                    }
                ],
            },
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "post-bash", "--harness", "codex"),
                        "timeout": 3000,
                    }
                ],
            },
        ],
        "PreCompact": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": runner("hook", "pre-compact", "--harness", "codex"),
                        "timeout": 5000,
                    }
                ],
            }
        ],
    }


def _strip_codex_token_goat_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    """Remove hook entries whose command string contains 'token-goat'."""
    return _strip_token_goat_entries(entries)


def patch_codex_config(binary: str) -> str:
    """Merge token-goat hooks into ~/.codex/config.toml idempotently."""
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    cfg_path = codex_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)

    existing = tomllib.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}

    our_hooks = _codex_hooks_block(binary)
    existing_hooks = existing.get("hooks", {})
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        kept = _strip_codex_token_goat_entries(existing_entries)
        existing_hooks[event] = kept + cast(list[dict[str, object]], entries)
    existing["hooks"] = existing_hooks

    # Atomic write: a crash mid-write must never leave a truncated config.toml behind.
    paths.atomic_write_text(cfg_path, tomli_w.dumps(existing))
    return str(cfg_path)


def unpatch_codex_config() -> str:
    """Remove token-goat entries from ~/.codex/config.toml."""
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    cfg_path = codex_config_path()
    if not cfg_path.exists():
        return "codex config not found"

    existing = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    hooks = existing.get("hooks", {})
    for event in list(hooks.keys()):
        cleaned = _strip_codex_token_goat_entries(hooks[event])
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]
    existing["hooks"] = hooks

    # Atomic write: a crash mid-write must never leave a truncated config.toml behind.
    paths.atomic_write_text(cfg_path, tomli_w.dumps(existing))
    return str(cfg_path)


CODEX_AGENTS_MD_CONTENT = """\
## token-goat - route code reads through token-goat first (Codex)

token-goat is installed. Before you run `rg`, `grep`, `cat`, `head`, `bat`, or any Bash read of a source file, check whether a token-goat command does the same job for a fraction of the tokens. Route through token-goat by default. Skipping it burns context you will need later in the session.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `token-goat symbol getUser` | `rg "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `token-goat read "src/auth.py::login"` | `cat src/auth.py` (about 85% more tokens) |
| Read one method on a class | `token-goat read "src/auth.py::Session.refresh"` | `cat src/auth.py` |
| Read one section of a doc | `token-goat section "README.md::Install"` | `cat README.md` |
| Disambiguate a duplicate heading | `token-goat section "doc.md::Setup#2"` | `cat doc.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `rg` |
| Get oriented in an unfamiliar repo | `token-goat map --compact` | `ls -R` plus multiple `cat` calls |
| Outline a long Google Doc | `token-goat gdrive-sections <file-id>` | Fetching the whole doc |
| Read one TOML/YAML/JSON/INI/.env/Dockerfile block | `token-goat section "pyproject.toml::tool.ruff"` | `cat pyproject.toml` |
| Re-inspect a recent Bash output | `token-goat bash-output <id> --tail 50` | Re-running `pytest`/`cargo`/`git log` |
| Re-inspect a recent WebFetch / web_search response | `token-goat web-output <id> --grep "TODO"` | Re-fetching the same docs URL |

Modifiers worth knowing: `symbol --all-projects` (cross-repo); `symbol --strict` disables close-match auto-redirect; `map --compact` (300-token budget); `semantic --max-distance 1.0` or `--no-rerank` to widen / tighten results; `bash-output --grep PATTERN` / `web-output --grep PATTERN` filter cached output. A miss without an unambiguous close match prints "Did you mean…?" suggestions; a unique high-confidence close match is followed transparently with a `(redirected from: ...)` marker. The pre-Bash, pre-Grep, and pre-WebFetch hooks hint when a tool call is about to repeat in the same session.

Plain Bash reads are the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- You need exact bytes to build an `apply_patch` hunk that must match the file verbatim.

Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts during code work mean you are reaching for `rg` or `cat` where a token-goat command would apply.
"""


def patch_codex_agents_md() -> str:
    """Append/replace the delimited token-goat block in ~/.codex/AGENTS.md."""
    md_path = codex_agents_path()
    if _strip_legacy_block(md_path, LEGACY_CODEX_AGENTS_BEGIN, LEGACY_CODEX_AGENTS_END):
        _LOG.info("patch_codex_agents_md: stripped legacy tokenwise-codex block from %s", md_path)
    return _patch_md_block(
        md_path, CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, CODEX_AGENTS_MD_CONTENT
    )


def unpatch_codex_agents_md() -> str:
    """Remove the token-goat block from ~/.codex/AGENTS.md."""
    return _unpatch_md_block(
        codex_agents_path(), CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, "codex AGENTS.md not found"
    )


# ---------------------------------------------------------------------------
# Integration status check
# ---------------------------------------------------------------------------


def _hooks_contain_token_goat(hooks: dict[str, object]) -> bool:
    """Return True if any hook entry in *hooks* has a command containing 'token_goat'.

    *hooks* is a dict mapping event names to lists of matcher/hook-list entries,
    the same shape used by both settings.json and codex config.toml.  Extracted
    to eliminate the identical nested-loop scan duplicated in
    ``_check_settings_json`` and ``_check_codex_config``.
    """
    for _event, entries in hooks.items():
        entry_list = entries if isinstance(entries, list) else []
        for entry in entry_list:
            if not isinstance(entry, dict):
                continue
            for h in (entry.get("hooks", []) or []):
                if isinstance(h, dict) and "token_goat" in str(h.get("command", "")):
                    return True
    return False


def _check_settings_json() -> str:
    """Return 'installed' if settings.json has token-goat hooks, otherwise 'not installed'."""
    settings_path = claude_settings_path()
    if not settings_path.exists():
        return "not installed (settings.json absent)"
    try:
        data = _read_settings_json(settings_path) or {}
    except json.JSONDecodeError:
        return "error (settings.json malformed)"
    raw_hooks = data.get("hooks", {})
    hooks: dict[str, object] = raw_hooks if isinstance(raw_hooks, dict) else {}
    return "installed" if _hooks_contain_token_goat(hooks) else "not installed"


def _check_claude_md() -> str:
    """Return 'installed' if CLAUDE.md contains the token-goat block."""
    md_path = claude_md_path()
    if not md_path.exists():
        return "not installed (CLAUDE.md absent)"
    content = md_path.read_text(encoding="utf-8")
    if CLAUDE_MD_BEGIN in content:
        return "installed"
    return "not installed"


def _check_skill() -> str:
    """Return 'installed' if the skill directory and SKILL.md exist."""
    skill_path = skill_dir() / "SKILL.md"
    if skill_path.exists():
        return "installed"
    return "not installed"


def _winreg_run_value_exists(value_name: str) -> bool | None:
    """Return True/False if the HKCU Run key can be read, None on error.

    Centralises the winreg open/query/close pattern used by both
    ``_check_worker_task`` (read) and ``install_worker_task`` (write) so
    neither has to manage CloseKey manually in multiple exception branches.
    Returns None when the registry is inaccessible (non-Windows, permission
    error, etc.) so callers can distinguish "absent" from "unreadable".
    """
    try:
        import winreg  # type: ignore[import]
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_READ,
        ) as key:
            try:
                winreg.QueryValueEx(key, value_name)
                return True
            except FileNotFoundError:
                return False
    except ImportError:
        # winreg is only available on Windows; on other platforms return None (unreadable)
        return None
    except OSError:
        return None


def _check_worker_task() -> str:
    """Return 'installed' if the HKCU Run key for the worker exists."""
    if sys.platform != "win32":
        return "n/a (non-Windows)"
    result = _winreg_run_value_exists(TASK_WORKER)
    if result is True:
        return "installed"
    if result is False:
        return "not installed"
    return "error reading HKCU\\Run"


def _check_update_task() -> str:
    """Return 'installed' if the weekly auto-update scheduled task exists."""
    return "installed" if task_exists(TASK_UPDATE) else "not installed"


def _check_codex_config() -> str:
    """Return 'installed' if ~/.codex/config.toml has token-goat hooks."""
    import tomllib  # noqa: PLC0415

    cfg_path = codex_config_path()
    if not cfg_path.exists():
        return "not installed (codex config absent)"
    try:
        data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        return f"error (codex config malformed: {cfg_path})"
    except OSError as e:
        return f"error reading codex config ({cfg_path}): {e}"
    hooks: dict[str, object] = data.get("hooks", {})
    return "installed" if _hooks_contain_token_goat(hooks) else "not installed"


def check_status() -> dict[str, str]:
    """Return a dict of integration name -> status string for display before install/uninstall."""
    status: dict[str, str] = {
        "Claude Code hooks (settings.json)": _check_settings_json(),
        "CLAUDE.md block": _check_claude_md(),
        "skill (SKILL.md)": _check_skill(),
    }
    if sys.platform == "win32":
        status["worker autostart (HKCU Run)"] = _check_worker_task()
        status["update task (schtasks)"] = _check_update_task()
    elif sys.platform == "darwin":
        status["worker autostart (LaunchAgent)"] = _check_mac_autostart()
        status["update cron"] = _check_linux_update_cron()
    else:
        status["worker autostart"] = _check_linux_autostart()
        status["update cron"] = _check_linux_update_cron()
    status["Codex hooks (config.toml)"] = _check_codex_config()
    from . import bridges  # noqa: PLC0415
    status["opencode plugin"] = bridges._check_opencode_plugin()
    status["openclaw plugin"] = bridges._check_openclaw_plugin()
    return status


# ---------------------------------------------------------------------------
# Platform autostart helpers (shared by install_all / uninstall_all)
# ---------------------------------------------------------------------------


def _install_platform_autostart(result: dict[str, str]) -> None:
    """Install platform-appropriate worker autostart and update schedule.

    Mutates *result* in-place with the step keys and formatted outcome strings.
    Extracted from ``install_all`` to eliminate the identical win32/darwin/else
    dispatch that also appears in ``uninstall_all``.
    """
    _LOG.debug("_install_platform_autostart: platform=%s", sys.platform)
    if sys.platform == "win32":
        worker_ok, worker_out = install_worker_task()
        result["task: worker"] = _ok_fail(worker_ok, worker_out)
        update_ok, update_out = install_update_task()
        result["task: update"] = _ok_fail(update_ok, update_out)
    elif sys.platform == "darwin":
        worker_ok, worker_out = install_mac_autostart()
        result["autostart: worker"] = _ok_fail(worker_ok, worker_out)
        cron_ok, cron_out = install_linux_update_cron()
        result["cron: update"] = _ok_fail(cron_ok, cron_out)
    else:
        worker_ok, worker_out = install_linux_autostart()
        result["autostart: worker"] = _ok_fail(worker_ok, worker_out)
        cron_ok, cron_out = install_linux_update_cron()
        result["cron: update"] = _ok_fail(cron_ok, cron_out)


def _uninstall_platform_autostart(result: dict[str, str]) -> None:
    """Remove platform-appropriate worker autostart and update schedule.

    Mutates *result* in-place.  Mirror of ``_install_platform_autostart``.
    """
    _LOG.debug("_uninstall_platform_autostart: platform=%s", sys.platform)
    if sys.platform == "win32":
        removed_tasks = uninstall_tasks()
        result["tasks"] = f"removed: {removed_tasks}"
    elif sys.platform == "darwin":
        removed_mac = uninstall_mac_autostart()
        result["autostart"] = f"removed: {removed_mac}" if removed_mac else "none found"
        result["cron"] = uninstall_linux_update_cron()
    else:
        removed_linux = uninstall_linux_autostart()
        result["autostart"] = f"removed: {removed_linux}" if removed_linux else "none found"
        result["cron"] = uninstall_linux_update_cron()


# ---------------------------------------------------------------------------
# Plan / verify (dry-run preview + post-install self-check)
# ---------------------------------------------------------------------------


class _PlanEntry(TypedDict):
    """One row of an install plan: a file or registry artefact that *would* change.

    Used by :func:`plan_install` (dry-run) and :func:`verify_install` (post-check)
    to give callers a structured, machine-readable view of every artefact the
    installer touches.  The same shape is used in both directions so the CLI
    layer can render either ``--dry-run`` or ``doctor --verify`` output with
    one renderer.

    Fields:
        component:  Human-readable name of the integration step (e.g.
            ``"settings.json"``, ``"worker autostart"``).
        target:     Absolute path or platform-specific identifier of the
            artefact (e.g. ``HKCU\\Software\\Microsoft\\Windows\\
            CurrentVersion\\Run\\token-goat-worker``).
        action:     ``"create"`` / ``"update"`` / ``"already-installed"`` /
            ``"skip"`` for :func:`plan_install`; ``"ok"`` / ``"missing"`` /
            ``"error"`` for :func:`verify_install`.
        detail:     Free-form context (e.g. ``"would patch hooks block"``,
            or an error message).  Truncated to keep output readable.
    """

    component: str
    target: str
    action: str
    detail: str


def _settings_json_token_goat_count() -> int:
    """Return the number of token-goat hook entries currently in settings.json.

    Helper for plan/verify: a fresh install yields 0; an idempotent re-install
    should still yield exactly len(_hooks_block()) regardless of how many
    times install is run.
    """
    settings_path = claude_settings_path()
    if not settings_path.exists():
        return 0
    try:
        data = _read_settings_json(settings_path) or {}
    except (json.JSONDecodeError, OSError):
        return 0
    raw_hooks = data.get("hooks", {})
    hooks: dict[str, object] = raw_hooks if isinstance(raw_hooks, dict) else {}
    count = 0
    for entries in hooks.values():
        entry_list = entries if isinstance(entries, list) else []
        for entry in entry_list:
            if not isinstance(entry, dict):
                continue
            for h in (entry.get("hooks", []) or []):
                if isinstance(h, dict) and "token_goat" in str(h.get("command", "")):
                    count += 1
    return count


def plan_install(
    install_codex: bool = False,
    install_opencode: bool = False,
    install_openclaw: bool = False,
) -> list[_PlanEntry]:
    """Return what :func:`install_all` *would* do, without making any changes.

    Read-only: must never write to disk, registry, schtasks, launchctl, systemd,
    or crontab.  Used by ``token-goat install --dry-run`` so users can confirm
    their config will be merged (not overwritten) and that the right autostart
    mechanism will be picked on their platform.

    Each row is a :class:`_PlanEntry`.  Optional integrations (codex/opencode/
    openclaw) are only included when the corresponding flag is set, matching
    :func:`install_all` semantics.
    """
    plan: list[_PlanEntry] = []

    # 1. settings.json
    settings_path = claude_settings_path()
    if settings_path.exists():
        existing_count = _settings_json_token_goat_count()
        action = "update" if existing_count else "create"
        detail = (
            f"would replace {existing_count} existing token-goat hook entries"
            if existing_count
            else "would add token-goat hooks block (preserving other hooks)"
        )
    else:
        action = "create"
        detail = "file does not exist; would create with token-goat hooks"
    plan.append(_PlanEntry(
        component="settings.json",
        target=str(settings_path),
        action=action,
        detail=detail,
    ))

    # 2. CLAUDE.md
    md_path = claude_md_path()
    if md_path.exists():
        try:
            md_text = md_path.read_text(encoding="utf-8")
        except OSError as e:
            plan.append(_PlanEntry(
                component="CLAUDE.md",
                target=str(md_path),
                action="error",
                detail=f"unreadable: {e}",
            ))
        else:
            has_block = CLAUDE_MD_BEGIN in md_text and CLAUDE_MD_END in md_text
            plan.append(_PlanEntry(
                component="CLAUDE.md",
                target=str(md_path),
                action="update" if has_block else "update",
                detail=(
                    "would replace existing delimited block"
                    if has_block
                    else "would append delimited block"
                ),
            ))
    else:
        plan.append(_PlanEntry(
            component="CLAUDE.md",
            target=str(md_path),
            action="create",
            detail="file does not exist; would create with delimited block",
        ))

    # 3. skill
    skill_md = skill_dir() / "SKILL.md"
    plan.append(_PlanEntry(
        component="skill",
        target=str(skill_md),
        action="update" if skill_md.exists() else "create",
        detail="SKILL.md written under ~/.claude/skills/token-goat/",
    ))

    # 4. platform autostart
    if sys.platform == "win32":
        run_present = _winreg_run_value_exists(TASK_WORKER)
        plan.append(_PlanEntry(
            component="worker autostart",
            target=r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\\" + TASK_WORKER,
            action="update" if run_present else "create",
            detail="HKCU Run registry key (no admin required)",
        ))
        plan.append(_PlanEntry(
            component="update task",
            target=f"schtasks: {TASK_UPDATE}",
            action="update" if task_exists(TASK_UPDATE) else "create",
            detail="weekly Sunday 03:00 schtasks job",
        ))
    elif sys.platform == "darwin":
        plist = _launchd_plist_path()
        plan.append(_PlanEntry(
            component="worker autostart",
            target=str(plist),
            action="update" if plist.exists() else "create",
            detail="LaunchAgent plist (user scope, RunAtLoad)",
        ))
        plan.append(_PlanEntry(
            component="update cron",
            target="crontab (current user)",
            action="update" if CRON_JOB_MARKER in _check_linux_update_cron() else "create",
            detail="weekly Sunday 03:00 cron entry",
        ))
    else:
        if _systemd_user_available():
            svc = _systemd_service_path()
            mechanism = "systemd --user service"
            target = str(svc)
            exists = svc.exists()
        else:
            desktop = _xdg_autostart_path()
            mechanism = "XDG autostart .desktop (systemd --user unavailable)"
            target = str(desktop)
            exists = desktop.exists()
        plan.append(_PlanEntry(
            component="worker autostart",
            target=target,
            action="update" if exists else "create",
            detail=mechanism,
        ))
        plan.append(_PlanEntry(
            component="update cron",
            target="crontab (current user)",
            action="update" if "installed" in _check_linux_update_cron() else "create",
            detail="weekly Sunday 03:00 cron entry",
        ))

    # 5. optional codex
    if install_codex:
        plan.append(_PlanEntry(
            component="codex: config.toml",
            target=str(codex_config_path()),
            action="update" if codex_config_path().exists() else "create",
            detail="merge token-goat hooks into [hooks]",
        ))
        plan.append(_PlanEntry(
            component="codex: AGENTS.md",
            target=str(codex_agents_path()),
            action="update" if codex_agents_path().exists() else "create",
            detail="append/replace delimited block",
        ))

    # 6. optional opencode / openclaw
    if install_opencode or install_openclaw:
        try:
            from . import bridges  # noqa: PLC0415
        except Exception as e:  # noqa: BLE001
            plan.append(_PlanEntry(
                component="bridges",
                target="(import failed)",
                action="error",
                detail=str(e),
            ))
            bridges = None  # type: ignore[assignment]
        if install_opencode and bridges is not None:
            plan.append(_PlanEntry(
                component="opencode: plugin",
                target=str(getattr(bridges, "opencode_plugin_path", lambda: "<unknown>")()),
                action="create",
                detail="would write/refresh TS shim",
            ))
        if install_openclaw and bridges is not None:
            plan.append(_PlanEntry(
                component="openclaw: plugin",
                target=str(getattr(bridges, "openclaw_plugin_path", lambda: "<unknown>")()),
                action="create",
                detail="would write/refresh TS shim",
            ))

    return plan


def verify_install() -> list[_PlanEntry]:
    """Run after :func:`install_all` to confirm each artefact actually landed.

    Read-only.  Distinct from :func:`check_status` (one-line strings) — this
    returns structured rows with an ``ok`` / ``missing`` / ``error`` action so
    callers can detect partial-install scenarios (e.g. Linux box where the
    systemd write succeeded but ``systemctl enable`` silently failed).
    """
    report: list[_PlanEntry] = []

    # 1. settings.json
    settings_path = claude_settings_path()
    count = _settings_json_token_goat_count()
    if not settings_path.exists():
        report.append(_PlanEntry(
            component="settings.json",
            target=str(settings_path),
            action="missing",
            detail="settings.json absent after install",
        ))
    elif count == 0:
        report.append(_PlanEntry(
            component="settings.json",
            target=str(settings_path),
            action="missing",
            detail="no token-goat hook entries found",
        ))
    else:
        report.append(_PlanEntry(
            component="settings.json",
            target=str(settings_path),
            action="ok",
            detail=f"{count} token-goat hook entries present",
        ))

    # 2. CLAUDE.md
    md_path = claude_md_path()
    if not md_path.exists():
        report.append(_PlanEntry(
            component="CLAUDE.md",
            target=str(md_path),
            action="missing",
            detail="CLAUDE.md absent",
        ))
    else:
        try:
            md_text = md_path.read_text(encoding="utf-8")
        except OSError as e:
            report.append(_PlanEntry(
                component="CLAUDE.md",
                target=str(md_path),
                action="error",
                detail=f"unreadable: {e}",
            ))
        else:
            has_block = CLAUDE_MD_BEGIN in md_text and CLAUDE_MD_END in md_text
            report.append(_PlanEntry(
                component="CLAUDE.md",
                target=str(md_path),
                action="ok" if has_block else "missing",
                detail="delimited block present" if has_block else "no token-goat block found",
            ))

    # 3. skill
    skill_md = skill_dir() / "SKILL.md"
    report.append(_PlanEntry(
        component="skill",
        target=str(skill_md),
        action="ok" if skill_md.exists() else "missing",
        detail="SKILL.md present" if skill_md.exists() else "SKILL.md missing",
    ))

    # 4. platform autostart
    if sys.platform == "win32":
        run_present = _winreg_run_value_exists(TASK_WORKER)
        action = (
            "ok" if run_present is True
            else "missing" if run_present is False
            else "error"
        )
        report.append(_PlanEntry(
            component="worker autostart",
            target=r"HKCU\Run\\" + TASK_WORKER,
            action=action,
            detail="HKCU Run key " + (
                "present" if run_present is True
                else "absent" if run_present is False
                else "unreadable"
            ),
        ))
    elif sys.platform == "darwin":
        plist = _launchd_plist_path()
        report.append(_PlanEntry(
            component="worker autostart",
            target=str(plist),
            action="ok" if plist.exists() else "missing",
            detail="LaunchAgent plist " + ("present" if plist.exists() else "absent"),
        ))
    else:
        svc = _systemd_service_path()
        desktop = _xdg_autostart_path()
        if svc.exists():
            report.append(_PlanEntry(
                component="worker autostart",
                target=str(svc),
                action="ok",
                detail="systemd user service installed",
            ))
        elif desktop.exists():
            report.append(_PlanEntry(
                component="worker autostart",
                target=str(desktop),
                action="ok",
                detail="XDG autostart installed",
            ))
        else:
            report.append(_PlanEntry(
                component="worker autostart",
                target=str(svc),
                action="missing",
                detail="neither systemd unit nor XDG .desktop present",
            ))

    return report


# ---------------------------------------------------------------------------
# Top-level install / uninstall
# ---------------------------------------------------------------------------


def install_all(
    install_codex: bool = False,
    install_opencode: bool = False,
    install_openclaw: bool = False,
) -> dict[str, str]:
    """Run the full install. Returns a dict of step -> result string."""
    t0 = time.monotonic()
    _LOG.info(
        "install_all: starting (platform=%s codex=%s opencode=%s openclaw=%s)",
        sys.platform,
        install_codex,
        install_opencode,
        install_openclaw,
    )
    paths.ensure_dirs()
    result: dict[str, str] = {}

    settings_ok, settings_detail = patch_settings_json()
    result["settings.json"] = _ok_fail(settings_ok, settings_detail)
    _LOG.info("install step: settings.json — %s", _ok_fail(settings_ok, settings_detail))

    md_out = patch_claude_md()
    result["CLAUDE.md"] = _ok_fail(True, md_out)
    _LOG.info("install step: CLAUDE.md — %s", _ok_fail(True, md_out))

    skill_path = write_skill()
    result["skill"] = _ok_fail(True, skill_path)
    _LOG.info("install step: skill — %s", _ok_fail(True, skill_path))

    _install_platform_autostart(result)

    # Spawn the worker right now (fail-soft)
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        worker_status = f"spawned, pid={pid}" if pid else "spawn failed"
        result["worker"] = worker_status
        _LOG.info("install step: worker — %s", worker_status)
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"FAIL — {e}"
        _LOG.warning("install step: worker — FAIL: %s", e)

    removed_launchers = _remove_legacy_launchers()
    result["legacy launchers"] = (
        "removed — " + ", ".join(removed_launchers) if removed_launchers else "none found"
    )

    if install_codex:
        binary = token_goat_hook_binary()
        _run_step(result, "codex: config.toml", lambda: patch_codex_config(binary))
        _run_step(result, "codex: AGENTS.md", patch_codex_agents_md)

    if install_opencode or install_openclaw:
        from . import bridges  # noqa: PLC0415

    if install_opencode:
        _run_step(result, "opencode: plugin", bridges.install_opencode_plugin)

    if install_openclaw:
        _run_step(result, "openclaw: plugin", bridges.install_openclaw_plugin)

    codec_report = probe_image_codecs()
    result["image codecs"] = (
        _ok_fail(True, codec_report["summary"])
        if codec_report["ok"]
        else _ok_fail(False, codec_report["summary"])
    )
    _LOG.info("install step: image codecs — %s", result["image codecs"])

    failures = [k for k, v in result.items() if v.startswith("FAIL")]
    elapsed_ms = (time.monotonic() - t0) * 1000
    _LOG.info(
        "install_all: complete in %.0fms — %d steps, %d failure(s)%s",
        elapsed_ms,
        len(result),
        len(failures),
        f": {failures}" if failures else "",
    )
    return result


class _ImageCodecReport(TypedDict):
    ok: bool
    summary: str
    missing: list[str]
    hint: str


def probe_image_codecs() -> _ImageCodecReport:
    """Probe Pillow's image codec availability and return a structured report.

    Why: token-goat's biggest single token win comes from WebP encoding (~39%
    smaller than JPEG on screenshots). On minimal Linux/WSL images, Pillow may
    import but ship without libwebp/libjpeg/zlib bindings, which silently
    breaks the shrink pipeline. Surfacing this at install time — not on first
    image read — lets the user (or an AI driving the install) fix it as part
    of the same task. Same logic powers ``token-goat doctor``.
    """
    report: _ImageCodecReport = {"ok": False, "summary": "", "missing": [], "hint": ""}
    try:
        from PIL import Image, features  # noqa: PLC0415

        parts: list[str] = []
        missing: list[str] = []
        for codec, label in (("webp", "WebP"), ("jpg", "JPEG"), ("zlib", "PNG")):
            if features.check(codec):
                parts.append(f"{label}=ok")
            else:
                parts.append(f"{label}=MISSING")
                missing.append(label)
        try:
            import io  # noqa: PLC0415

            buf = io.BytesIO()
            Image.new("RGB", (4, 4), (200, 100, 50)).save(buf, "WEBP", quality=80)
            parts.append("WebP-encode=ok")
        except Exception as exc:  # noqa: BLE001
            parts.append(f"WebP-encode=FAIL ({type(exc).__name__})")
            if "WebP" not in missing:
                missing.append("WebP")
        summary = ", ".join(parts)
        ok = not missing and "FAIL" not in summary
        hint = ""
        if not ok:
            if sys.platform.startswith("linux"):
                hint = (
                    "Install system codecs and reinstall Pillow:\n"
                    "    sudo apt-get install -y libwebp-dev libjpeg-dev zlib1g-dev   # Debian/Ubuntu/WSL\n"
                    "    sudo dnf install -y libwebp-devel libjpeg-turbo-devel zlib-devel  # Fedora/RHEL\n"
                    "    sudo pacman -S libwebp libjpeg-turbo zlib                        # Arch\n"
                    "    sudo apk add libwebp-dev libjpeg-turbo-dev zlib-dev               # Alpine\n"
                    "    uv tool install --reinstall token-goat"
                )
            elif sys.platform == "darwin":
                hint = (
                    "Install system codecs and reinstall Pillow:\n"
                    "    brew install webp jpeg-turbo\n"
                    "    uv tool install --reinstall token-goat"
                )
            else:
                hint = (
                    "Pillow on Windows ships codecs by default — a missing codec usually means "
                    "Pillow itself is broken. Reinstall: uv tool install --reinstall token-goat"
                )
        report["ok"] = ok
        report["summary"] = summary
        report["missing"] = missing
        report["hint"] = hint
    except ImportError as exc:
        report["summary"] = f"Pillow not importable — {exc}"
        report["missing"] = ["Pillow"]
        report["hint"] = "uv tool install --reinstall token-goat"
    return report


def _stop_worker() -> str:
    """Terminate the background worker if running. Returns a status string."""
    pid_path = paths.worker_pid_path()
    if not pid_path.exists():
        return "stopped"
    import psutil  # noqa: PLC0415
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        if psutil.pid_exists(pid):
            psutil.Process(pid).terminate()
    except (ValueError, OSError, psutil.NoSuchProcess, psutil.AccessDenied) as e:
        _LOG.warning("failed to terminate worker process (pid_path=%s): %s", pid_path, e)
    pid_path.unlink(missing_ok=True)
    return "stopped"


def uninstall_all(
    purge: bool = False,
    codex: bool = False,
    opencode: bool = False,
    openclaw: bool = False,
) -> dict[str, str]:
    """Reverse install. With purge=True also deletes the data directory."""
    t0 = time.monotonic()
    _LOG.info(
        "uninstall_all: starting (platform=%s purge=%s codex=%s opencode=%s openclaw=%s)",
        sys.platform,
        purge,
        codex,
        opencode,
        openclaw,
    )
    result: dict[str, str] = {}

    try:
        result["worker"] = _stop_worker()
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"stop failed: {e}"

    _uninstall_platform_autostart(result)

    result["settings.json"] = _ok_fail(True, f"unpatched — {unpatch_settings_json()}")
    result["CLAUDE.md"] = _ok_fail(True, f"unpatched — {unpatch_claude_md()}")
    result["skill"] = _ok_fail(True, f"removed — {remove_skill()}")
    removed_launchers = _remove_legacy_launchers()
    result["legacy launchers"] = (
        "removed — " + ", ".join(removed_launchers) if removed_launchers else "none found"
    )

    if purge:
        target = paths.data_dir()
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            result["data_dir"] = f"purged — {target}"
        else:
            result["data_dir"] = "already absent"

    if codex:
        result["codex: config.toml"] = unpatch_codex_config()
        result["codex: AGENTS.md"] = unpatch_codex_agents_md()

    if opencode or openclaw:
        from . import bridges  # noqa: PLC0415

    if opencode:
        result["opencode: plugin"] = bridges.uninstall_opencode_plugin()

    if openclaw:
        result["openclaw: plugin"] = bridges.uninstall_openclaw_plugin()

    failures = [k for k, v in result.items() if v.startswith("FAIL")]
    elapsed_ms = (time.monotonic() - t0) * 1000
    _LOG.info(
        "uninstall_all: complete in %.0fms — %d steps, %d failure(s)%s",
        elapsed_ms,
        len(result),
        len(failures),
        f": {failures}" if failures else "",
    )
    return result
