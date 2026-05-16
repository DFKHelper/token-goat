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
import xml.sax.saxutils
from datetime import datetime
from pathlib import Path

from . import paths

# Markers for idempotent Codex AGENTS.md patching
CODEX_AGENTS_BEGIN = "<!-- token-goat-codex-begin -->"
CODEX_AGENTS_END = "<!-- token-goat-codex-end -->"

_LOG = logging.getLogger("token_goat.install")

# Markers for idempotent CLAUDE.md patching
CLAUDE_MD_BEGIN = "<!-- token-goat-begin -->"
CLAUDE_MD_END = "<!-- token-goat-end -->"

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
    import time as _time  # noqa: PLC0415
    t0 = _time.monotonic()
    code, out = _run_schtasks(args)
    elapsed_ms = (_time.monotonic() - t0) * 1000
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
        except Exception as e:
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

    cmd_args = paths.python_runner_argv("worker", "--daemon")
    exec_str = " ".join(cmd_args)

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
            "RestartSec=10\n\n"
            "[Install]\n"
            "WantedBy=default.target\n",
            encoding="utf-8",
        )
        _LOG.info("systemd service file written: %s", svc_path)
        try:
            import time as _time  # noqa: PLC0415
            t0 = _time.monotonic()
            reload_r = subprocess.run(
                ["systemctl", "--user", "daemon-reload"],
                capture_output=True,
                timeout=10,
            )
            reload_ms = (_time.monotonic() - t0) * 1000
            if reload_r.returncode != 0:
                _LOG.warning(
                    "systemctl daemon-reload exited %d (%.0fms): %s",
                    reload_r.returncode, reload_ms,
                    (reload_r.stderr or b"").decode(errors="replace").strip(),
                )
            else:
                _LOG.debug("systemctl daemon-reload ok (%.0fms)", reload_ms)

            t1 = _time.monotonic()
            enable_r = subprocess.run(
                ["systemctl", "--user", "enable", SYSTEMD_SERVICE_NAME],
                capture_output=True,
                timeout=10,
            )
            enable_ms = (_time.monotonic() - t1) * 1000
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
    ``'``, or ``"``.  Standard library ``xml.sax.saxutils.escape`` covers the
    mandatory set; the extra ``{'"': "&quot;", "'": "&apos;"}`` mapping extends
    it to attribute-safe output (not strictly required for element text, but
    harmless and future-proof).
    """
    return xml.sax.saxutils.escape(s, {'"': "&quot;", "'": "&apos;"})


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
    subprocess.run(
        ["launchctl", "unload", str(plist_path)],
        capture_output=True,
        timeout=10,
    )
    try:
        r = subprocess.run(
            ["launchctl", "load", str(plist_path)],
            capture_output=True,
            timeout=10,
        )
        if r.returncode != 0:
            err = (r.stderr or b"").decode(errors="replace").strip()
            return False, f"launchctl load failed: {err}"
        return True, f"LaunchAgent installed: {plist_path}"
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
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


def _hooks_block(binary: str | None = None) -> dict[str, list[dict[str, object]]]:
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
                "matcher": "Read",
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
    data = json.loads(settings_path.read_text(encoding="utf-8"))
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
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        # Strip any prior token-goat entries, then append fresh ones
        kept = _strip_token_goat_entries(existing_entries)
        existing_hooks[event] = kept + entries
    current["hooks"] = existing_hooks

    # Permission allowlist
    raw_perms = current.get("permissions", {})
    perms: dict[str, object] = raw_perms if isinstance(raw_perms, dict) else {}
    raw_allowed = perms.get("allow", [])
    allowed: list[str] = list(raw_allowed) if isinstance(raw_allowed, list) else []
    if "Bash(token-goat:*)" not in allowed:
        allowed.append("Bash(token-goat:*)")
    perms["allow"] = allowed
    current["permissions"] = perms

    _write_settings_json(settings_path, current)
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
            pattern = re.compile(
                re.escape(begin_marker) + r".*?" + re.escape(end_marker),
                re.DOTALL,
            )
            updated = pattern.sub(block, existing)
        else:
            if not existing.endswith("\n"):
                existing += "\n"
            updated = existing + "\n" + block + "\n"
    else:
        updated = block + "\n"

    md_path.write_text(updated, encoding="utf-8")
    return str(md_path)


def _unpatch_md_block(md_path: Path, begin_marker: str, end_marker: str, not_found_msg: str) -> str:
    """Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.

    Returns a status string.  Extracted to eliminate the identical removal
    pattern duplicated in ``unpatch_claude_md`` and ``unpatch_codex_agents_md``.
    """
    if not md_path.exists():
        return not_found_msg
    content = md_path.read_text(encoding="utf-8")
    pattern = re.compile(
        r"\n*" + re.escape(begin_marker) + r".*?" + re.escape(end_marker) + r"\n*",
        re.DOTALL,
    )
    new = pattern.sub("\n", content).strip()
    md_path.write_text(new + "\n" if new else "", encoding="utf-8")
    return str(md_path)


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
| Read one section of a doc | `token-goat section "README.md::Install"` | `Read README.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `token-goat map --budget 4000` | Recursive `ls` plus multiple `Read` calls |

Add `--all-projects` to `token-goat symbol` for cross-repo lookups.

Read is the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- It is an image you need to see visually. The shrink runs automatically. Just Read it.

Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts during code work mean you are reaching for Read or Grep where token-goat would apply.
"""


def patch_claude_md() -> str:
    """Add or update the token-goat block in ~/.claude/CLAUDE.md, idempotently."""
    return _patch_md_block(claude_md_path(), CLAUDE_MD_BEGIN, CLAUDE_MD_END, CLAUDE_MD_CONTENT)


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
| Read one section of a doc | `token-goat section "README.md::Install"` | `Read README.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `Grep` |
| Get oriented in an unfamiliar repo | `token-goat map --budget 4000` | Recursive `ls` plus multiple `Read` calls |
| See what you have already touched | `token-goat session-touched` | Re-reading and hoping you remember |

Add `--all-projects` to `token-goat symbol` to search every indexed repo at once.

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


def _codex_hooks_block(binary: str | None = None) -> dict[str, list[dict[str, object]]]:
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
                        "command": runner("hook", "post-read", "--harness", "codex"),
                        "timeout": 2000,
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
        existing_hooks[event] = kept + entries
    existing["hooks"] = existing_hooks

    cfg_path.write_text(tomli_w.dumps(existing), encoding="utf-8")
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

    cfg_path.write_text(tomli_w.dumps(existing), encoding="utf-8")
    return str(cfg_path)


CODEX_AGENTS_MD_CONTENT = """\
## token-goat - route code reads through token-goat first (Codex)

token-goat is installed. Before you run `rg`, `grep`, `cat`, `head`, `bat`, or any Bash read of a source file, check whether a token-goat command does the same job for a fraction of the tokens. Route through token-goat by default. Skipping it burns context you will need later in the session.

| Goal | Do this | Not this |
|------|---------|----------|
| Find a function, class, or type | `token-goat symbol getUser` | `rg "getUser"` (10 to 50x more tokens) |
| Read one function or method body | `token-goat read "src/auth.py::login"` | `cat src/auth.py` (about 85% more tokens) |
| Read one section of a doc | `token-goat section "README.md::Install"` | `cat README.md` |
| Find code by meaning, not name | `token-goat semantic "rate limit retry"` | Several rounds of `rg` |
| Get oriented in an unfamiliar repo | `token-goat map --budget 4000` | `ls -R` plus multiple `cat` calls |

Add `--all-projects` to `token-goat symbol` for cross-repo lookups.

Plain Bash reads are the right call when:
- The file is under about 200 lines and you need the whole thing.
- The file has never been indexed (new path, scratch script, untracked draft).
- You need exact bytes to build an `apply_patch` hunk that must match the file verbatim.

Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts during code work mean you are reaching for `rg` or `cat` where a token-goat command would apply.
"""


def patch_codex_agents_md() -> str:
    """Append/replace the delimited token-goat block in ~/.codex/AGENTS.md."""
    return _patch_md_block(
        codex_agents_path(), CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, CODEX_AGENTS_MD_CONTENT
    )


def unpatch_codex_agents_md() -> str:
    """Remove the token-goat block from ~/.codex/AGENTS.md."""
    return _unpatch_md_block(
        codex_agents_path(), CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, "codex AGENTS.md not found"
    )


# ---------------------------------------------------------------------------
# Integration status check
# ---------------------------------------------------------------------------


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
    for _event, entries in hooks.items():
        entry_list = entries if isinstance(entries, list) else []
        for entry in entry_list:
            if not isinstance(entry, dict):
                continue
            for h in (entry.get("hooks", []) or []):
                if isinstance(h, dict) and "token_goat" in str(h.get("command", "")):
                    return "installed"
    return "not installed"


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


def _check_worker_task() -> str:
    """Return 'installed' if the HKCU Run key for the worker exists."""
    if sys.platform != "win32":
        return "n/a (non-Windows)"
    try:
        import winreg  # type: ignore[import]
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_READ,
        )
        try:
            winreg.QueryValueEx(key, TASK_WORKER)
            winreg.CloseKey(key)
            return "installed"
        except FileNotFoundError:
            winreg.CloseKey(key)
            return "not installed"
    except Exception as e:  # noqa: BLE001
        return f"error reading HKCU\\Run ({e})"


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
    hooks = data.get("hooks", {})
    for _event, entries in hooks.items():
        for entry in entries:
            for h in entry.get("hooks", []):
                if "token_goat" in h.get("command", ""):
                    return "installed"
    return "not installed"


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
# Top-level install / uninstall
# ---------------------------------------------------------------------------


def install_all(
    install_codex: bool = False,
    install_opencode: bool = False,
    install_openclaw: bool = False,
) -> dict[str, str]:
    """Run the full install. Returns a dict of step -> result string."""
    paths.ensure_dirs()
    result: dict[str, str] = {}

    settings_ok, settings_detail = patch_settings_json()
    result["settings.json"] = ("ok" if settings_ok else "FAIL") + f" — {settings_detail}"

    md_out = patch_claude_md()
    result["CLAUDE.md"] = f"ok — {md_out}"

    skill_path = write_skill()
    result["skill"] = f"ok — {skill_path}"

    if sys.platform == "win32":
        worker_ok, worker_out = install_worker_task()
        result["task: worker"] = ("ok" if worker_ok else "FAIL") + f" — {worker_out[:200]}"
        update_ok, update_out = install_update_task()
        result["task: update"] = ("ok" if update_ok else "FAIL") + f" — {update_out[:200]}"
    elif sys.platform == "darwin":
        worker_ok, worker_out = install_mac_autostart()
        result["autostart: worker"] = ("ok" if worker_ok else "FAIL") + f" — {worker_out[:200]}"
        update_ok, update_out = install_linux_update_cron()
        result["cron: update"] = ("ok" if update_ok else "FAIL") + f" — {update_out[:200]}"
    else:
        worker_ok, worker_out = install_linux_autostart()
        result["autostart: worker"] = ("ok" if worker_ok else "FAIL") + f" — {worker_out[:200]}"
        update_ok, update_out = install_linux_update_cron()
        result["cron: update"] = ("ok" if update_ok else "FAIL") + f" — {update_out[:200]}"

    # Spawn the worker right now (fail-soft)
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        result["worker"] = f"spawned, pid={pid}" if pid else "spawn failed"
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"FAIL — {e}"

    removed_launchers = _remove_legacy_launchers()
    result["legacy launchers"] = (
        "removed — " + ", ".join(removed_launchers) if removed_launchers else "none found"
    )

    if install_codex:
        binary = token_goat_hook_binary()
        try:
            result["codex: config.toml"] = f"ok — {patch_codex_config(binary)}"
        except Exception as e:  # noqa: BLE001
            result["codex: config.toml"] = f"FAIL — {e}"
        try:
            result["codex: AGENTS.md"] = f"ok — {patch_codex_agents_md()}"
        except Exception as e:  # noqa: BLE001
            result["codex: AGENTS.md"] = f"FAIL — {e}"

    if install_opencode or install_openclaw:
        from . import bridges  # noqa: PLC0415

    if install_opencode:
        try:
            result["opencode: plugin"] = f"ok — {bridges.install_opencode_plugin()}"
        except Exception as e:  # noqa: BLE001
            result["opencode: plugin"] = f"FAIL — {e}"

    if install_openclaw:
        try:
            result["openclaw: plugin"] = f"ok — {bridges.install_openclaw_plugin()}"
        except Exception as e:  # noqa: BLE001
            result["openclaw: plugin"] = f"FAIL — {e}"

    return result


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

    result: dict[str, str] = {}

    try:
        result["worker"] = _stop_worker()
    except Exception as e:  # noqa: BLE001
        result["worker"] = f"stop failed: {e}"

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

    result["settings.json"] = f"unpatched — {unpatch_settings_json()}"
    result["CLAUDE.md"] = f"unpatched — {unpatch_claude_md()}"
    result["skill"] = f"removed — {remove_skill()}"
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

    return result
