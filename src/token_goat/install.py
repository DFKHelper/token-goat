"""install + uninstall: scheduled tasks, settings.json, CLAUDE.md, skill, permission allowlist."""
from __future__ import annotations

import contextlib
import json
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
from .util import get_logger


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

_LOG = get_logger("install")

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

_HKCU_RUN_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"


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


def _extract_interpreter_from_command(cmd: str) -> str | None:
    """Extract the interpreter path from an autostart command string.

    Handles the ``pythonw.exe -m token_goat.cli ...`` form written by
    :func:`paths.python_runner_command`.  The interpreter is always the first
    token (quoted or unquoted).  Returns ``None`` when extraction fails.
    """
    stripped = cmd.strip()
    if not stripped:
        return None
    # Handle a leading quoted path: "C:/path/pythonw.exe" -m ...
    if stripped.startswith('"'):
        end = stripped.find('"', 1)
        if end != -1:
            return stripped[1:end]
        return None
    # Unquoted: take first whitespace-delimited token
    return stripped.split()[0] if stripped.split() else None


def _read_win_autostart_command() -> str | None:
    """Return the current HKCU Run value for token-goat-worker, or None if absent.

    Read-only.  Returns the raw command string exactly as stored in the registry.
    Returns ``None`` when the key or value does not exist or on read error.
    """
    if sys.platform != "win32":
        return None
    try:
        import winreg  # type: ignore[import]
        key_read = getattr(winreg, "KEY_READ", 0x20019)
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _HKCU_RUN_PATH,
            0,
            key_read,
        ) as key:
            try:
                value, _ = winreg.QueryValueEx(key, TASK_WORKER)
                return str(value)
            except FileNotFoundError:
                return None
    except (ImportError, OSError, AttributeError):
        return None


def _read_linux_autostart_command() -> str | None:
    """Return the ExecStart (systemd) or Exec (XDG) line from the autostart file, or None.

    Read-only.  Returns the raw exec string from whichever autostart mechanism
    is present (systemd user service first, XDG autostart fallback).
    """
    if sys.platform == "win32":
        return None
    svc = _systemd_service_path()
    if svc.exists():
        try:
            content = svc.read_text(encoding="utf-8")
            for line in content.splitlines():
                stripped_line = line.strip()
                if stripped_line.startswith("ExecStart="):
                    return stripped_line[len("ExecStart="):].strip()
        except OSError:
            pass
        return None
    desktop = _xdg_autostart_path()
    if desktop.exists():
        try:
            content = desktop.read_text(encoding="utf-8")
            for line in content.splitlines():
                stripped_line = line.strip()
                if stripped_line.startswith("Exec="):
                    return stripped_line[len("Exec="):].strip()
        except OSError:
            pass
    return None


def _read_mac_autostart_command() -> str | None:
    """Return the first ProgramArguments entry (the interpreter) from the LaunchAgent plist.

    Read-only.  Returns the first ``<string>`` entry in ``ProgramArguments``,
    which is the interpreter path, or None when the plist is absent or unreadable.
    """
    if sys.platform == "win32":
        return None
    plist = _launchd_plist_path()
    if not plist.exists():
        return None
    try:
        content = plist.read_text(encoding="utf-8")
        # Extract all <string> entries following <key>ProgramArguments</key><array>
        import re as _re  # noqa: PLC0415
        m = _re.search(
            r"<key>ProgramArguments</key>\s*<array>(.*?)</array>",
            content,
            _re.DOTALL,
        )
        if not m:
            return None
        strings = _re.findall(r"<string>(.*?)</string>", m.group(1), _re.DOTALL)
        if strings:
            # The first element is the interpreter executable
            return " ".join(strings)  # reconstruct full command
    except OSError:
        pass
    return None


def check_autostart() -> dict[str, str | None]:
    """Return a dict describing the current autostart registration (read-only).

    Keys:
        status:           ``"registered"`` | ``"not registered"`` | ``"n/a"``
        command:          Full registered command string, or ``None``.
        registered_interp: Interpreter path extracted from the registered command, or ``None``.
        current_interp:   Current ``sys.executable`` (the interpreter running now).
        match:            ``"YES"`` | ``"NO"`` | ``"UNKNOWN"`` (when interp cannot be compared).

    No side effects — safe to call at any time.
    """
    current_interp = sys.executable

    if sys.platform == "win32":
        cmd = _read_win_autostart_command()
    elif sys.platform == "darwin":
        cmd = _read_mac_autostart_command()
    else:
        cmd = _read_linux_autostart_command()

    status = "registered" if cmd is not None else "not registered"
    registered_interp = _extract_interpreter_from_command(cmd) if cmd else None

    if registered_interp is None:
        match = "UNKNOWN"
    else:
        # Normalise path separators and case (Windows paths are case-insensitive)
        def _norm(p: str) -> str:
            return p.replace("\\", "/").casefold() if sys.platform == "win32" else p

        match = "YES" if _norm(registered_interp) == _norm(current_interp) else "NO"

    return {
        "status": status,
        "command": cmd,
        "registered_interp": registered_interp,
        "current_interp": current_interp,
        "match": match,
    }


def install_worker_task() -> tuple[bool, str]:
    """Register the token-goat worker to run at user logon via the HKCU Run key.

    schtasks ONLOGON requires admin even with /RU on most Windows UAC setups.
    HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run is the standard
    user-scope at-logon mechanism and never needs elevation.

    Command uses ``pythonw.exe -m token_goat.cli worker --daemon`` so AV/EDR
    products don't behavior-flag the at-logon spawn (a tiny launcher .exe in
    a user-writable directory is a textbook payload-drop signature; pythonw
    invoking a module is not).

    If an existing entry points to a different interpreter, it is replaced and
    a WARNING is logged so the caller can surface a "replacing old entry" notice.
    """
    cmd = paths.python_runner_command("worker", "--daemon")

    if sys.platform != "win32":
        return True, "non-Windows: skipped"

    # Dedup check: warn when replacing an entry that pointed at a different interpreter.
    existing_cmd = _read_win_autostart_command()
    if existing_cmd is not None:
        old_interp = _extract_interpreter_from_command(existing_cmd)
        new_interp = _extract_interpreter_from_command(cmd)
        if old_interp and new_interp:
            def _norm(p: str) -> str:
                return p.replace("\\", "/").casefold()
            if _norm(old_interp) != _norm(new_interp):
                _LOG.warning(
                    "install_worker_task: replacing existing autostart entry "
                    "(old interpreter: %s) with new one (new interpreter: %s)",
                    old_interp, new_interp,
                )

    try:
        import winreg  # type: ignore[import]  # winreg is Windows-only; not in typeshed for cross-platform targets
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _HKCU_RUN_PATH,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(key, TASK_WORKER, 0, winreg.REG_SZ, cmd)
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
            import winreg  # type: ignore[import]  # winreg is Windows-only; not in typeshed for cross-platform targets
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                _HKCU_RUN_PATH,
                0,
                winreg.KEY_SET_VALUE,
            ) as key:
                winreg.DeleteValue(key, TASK_WORKER)
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

    If an existing entry points to a different interpreter, it is replaced and
    a WARNING is logged.
    """

    if sys.platform == "win32":
        return True, "Windows: skipped"

    import shlex  # noqa: PLC0415

    # Dedup check: warn when replacing an entry that pointed at a different interpreter.
    existing_cmd = _read_linux_autostart_command()
    if existing_cmd is not None:
        old_interp = _extract_interpreter_from_command(existing_cmd)
        new_interp = sys.executable
        if old_interp and new_interp:
            def _norm_linux(p: str) -> str:
                return p  # Linux paths are case-sensitive
            if _norm_linux(old_interp) != _norm_linux(new_interp):
                _LOG.warning(
                    "install_linux_autostart: replacing existing autostart entry "
                    "(old interpreter: %s) with new one (new interpreter: %s)",
                    old_interp, new_interp,
                )

    cmd_args = paths.python_runner_argv("worker", "--daemon")
    # Shell-quote every argument so paths containing spaces (e.g. a home
    # directory like "/home/user name/...") are correctly represented in the
    # systemd unit file's ExecStart= directive and in the XDG .desktop Exec=
    # field.  Both formats accept POSIX shell quoting, and shlex.quote wraps
    # any argument that needs it in single-quotes.
    exec_str = " ".join(shlex.quote(a) for a in cmd_args)

    if _systemd_user_available():
        svc_dir = _systemd_user_dir()
        paths.ensure_dir(svc_dir)
        svc_path = _systemd_service_path()
        svc_path.write_text(
            "[Unit]\n"
            "Description=token-goat background worker\n"
            "After=default.target\n"
            "StartLimitIntervalSec=60\n"
            "StartLimitBurst=3\n\n"
            "[Service]\n"
            "Type=simple\n"
            f"ExecStart={exec_str}\n"
            "Restart=on-failure\n"
            "RestartSec=5\n\n"
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

            return True, (
                f"systemd user service installed: {svc_path} — "
                f"run `systemctl --user start {SYSTEMD_SERVICE_NAME}` to start immediately"
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            _LOG.warning("systemctl unavailable or timed out: %s", e)
            return False, f"systemd enable failed: {e}"

    # Fallback: XDG autostart .desktop file. Works on desktop sessions (GNOME,
    # KDE, XFCE). On WSL the SessionStart watchdog fills the gap.
    desktop = _xdg_autostart_path()
    paths.ensure_dir(desktop.parent)
    desktop.write_text(
        "[Desktop Entry]\n"
        "Version=1.0\n"
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

    if not shutil.which("crontab"):
        _LOG.info("crontab not found in PATH; skipping cron install")
        return False, "crontab not available (not found in PATH)"

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

    if not shutil.which("crontab"):
        return "crontab not available (not found in PATH)"

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

    If an existing plist points to a different interpreter, it is replaced and
    a WARNING is logged.
    """

    if sys.platform == "win32":
        return True, "Windows: skipped"

    # Dedup check: warn when replacing an entry that pointed at a different interpreter.
    existing_cmd = _read_mac_autostart_command()
    if existing_cmd is not None:
        old_interp = _extract_interpreter_from_command(existing_cmd)
        new_interp = sys.executable
        if old_interp and new_interp and old_interp != new_interp:
            _LOG.warning(
                "install_mac_autostart: replacing existing autostart entry "
                "(old interpreter: %s) with new one (new interpreter: %s)",
                old_interp, new_interp,
            )

    cmd_args = paths.python_runner_argv("worker", "--daemon")
    plist_path = _launchd_plist_path()
    paths.ensure_dir(plist_path.parent)

    # XML-escape every argument and path to guard against injection when a
    # homedir or binary path contains characters special to XML (<, >, &, ", ').
    arg_entries = "\n".join(
        f"        <string>{_xml_escape(arg)}</string>" for arg in cmd_args
    )
    log_dir = paths.logs_dir()
    paths.ensure_dir(log_dir)

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
        "    <dict>\n"
        "        <key>SuccessfulExit</key>\n"
        "        <false/>\n"
        "    </dict>\n"
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
        return True, (
            f"LaunchAgent installed: {plist_path} — "
            f"run `launchctl list {LAUNCHD_PLIST_NAME}` to confirm it is running"
        )
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


def _write_hook_wrapper() -> Path:
    """Write the persistent hook wrapper script to ``{data_dir}/bin/``.

    The wrapper bridges the ``uv tool install --reinstall`` race window where
    the venv's ``token_goat`` site-packages is briefly absent.  See
    ``paths.hook_wrapper_path`` for full rationale.

    Called from ``install_all`` before ``patch_settings_json`` so the wrapper
    exists by the time hook commands are written.  Idempotent — rewriting is
    safe and picks up any change in the interpreter path.
    """
    wrapper_path = paths.hook_wrapper_path()
    paths.ensure_dir(wrapper_path.parent)
    content = paths.hook_wrapper_content()
    # Write as bytes, not text: content bakes in platform-correct line endings (CRLF on Windows, LF on POSIX); a Windows text-mode write would translate \n -> \r\n on top of the existing \r\n, producing \r\r\n — cmd.exe tolerates the stray CR so forwarding still works, but doctor's byte-exact compare against hook_wrapper_content() then warns "differs from expected" forever, nagging a reinstall that never fixes it.
    paths.atomic_write_bytes(wrapper_path, content.encode("utf-8"))
    if sys.platform != "win32":
        wrapper_path.chmod(0o755)
    _LOG.info("install step: hook wrapper — %s", wrapper_path)
    return wrapper_path


def _hook_runner_command(*subcommand: str) -> str:
    """Return the hook command for ``settings.json``.

    Prefers the persistent wrapper (data_dir/bin/tg-hook.cmd) when it exists,
    so a ``uv tool install --reinstall`` mid-session does not surface a
    transient ``ModuleNotFoundError`` to the user.  Falls back to direct
    ``pythonw -m token_goat.cli`` invocation when the wrapper is absent
    (e.g. first install, or wrapper manually deleted).
    """
    wrapper = paths.hook_wrapper_path()
    if wrapper.exists():
        wrapper_str = str(wrapper).replace("\\", "/")
        quoted_args = " ".join(f'"{a}"' if " " in a else a for a in subcommand)
        return f'"{wrapper_str}" {quoted_args}' if subcommand else f'"{wrapper_str}"'
    return paths.python_runner_command(*subcommand)


def _build_hooks_block(
    runner: Callable[..., str],
    *,
    codex: bool,
) -> dict[str, list[_HookMatcherEntry]]:
    """Derive a hooks structure from :mod:`hook_registry`.

    Drives both ``_hooks_block`` (Claude wire format) and ``_codex_hooks_block``
    (Codex wire format) from the single registry source of truth so adding a
    new hook event only requires editing one place — see
    :mod:`token_goat.hook_registry` for the rationale.

    Args:
        runner: Callable that builds a command string for a hook subcommand.
            For Claude this is the persistent ``tg-hook.cmd`` wrapper; for
            Codex it's the direct ``pythonw -m token_goat.cli`` form (Codex's
            config.toml does not need the wrapper because Codex re-invokes
            hooks through a different code path).
        codex: When True, build the Codex ``config.toml`` shape and append the
            ``--harness codex`` flag to every command.  When False, build the
            Claude ``settings.json`` shape with no extra flags.
    """
    from . import hook_registry  # noqa: PLC0415

    block: dict[str, list[_HookMatcherEntry]] = {}
    events = hook_registry.codex_events() if codex else hook_registry.claude_events()
    for ev in events:
        top_event = ev.codex_event if codex else ev.claude_event
        matcher = ev.codex_matcher if codex else ev.claude_matcher
        timeout = ev.codex_timeout_ms if codex else ev.claude_timeout_ms
        if not top_event:
            continue
        # Codex hooks need the explicit harness flag so the dispatcher knows
        # which wire format to use for the response.
        cmd = (
            runner("hook", ev.name, "--harness", "codex")
            if codex
            else runner("hook", ev.name)
        )
        entry: _HookMatcherEntry = {
            "matcher": matcher,
            "hooks": [{"type": "command", "command": cmd, "timeout": timeout}],
        }
        block.setdefault(top_event, []).append(entry)
    return block


def _hooks_block(binary: str | None = None) -> dict[str, list[_HookMatcherEntry]]:
    """Build the Claude Code settings.json hooks structure.

    Derived from :data:`token_goat.hook_registry.HOOK_EVENTS` — see
    :func:`_build_hooks_block` for the shared implementation.  The ``binary``
    parameter is kept for backwards compatibility but unused; commands now
    invoke ``pythonw.exe -m token_goat.cli`` via the persistent wrapper at
    ``data_dir/bin/tg-hook.cmd``.  See ``paths.hook_wrapper_path`` for why a
    wrapper is needed.  See ``paths.python_runner_command`` for the AV/EDR
    rationale behind ``pythonw -m`` over ``.exe`` shims.
    """
    return _build_hooks_block(_hook_runner_command, codex=False)


# Substrings that identify a hook command as belonging to token-goat.
# - "token_goat" matches the legacy direct ``pythonw -m token_goat.cli`` form.
# - "tg-hook" matches the persistent wrapper at ``data_dir/bin/tg-hook.cmd``
#   (or ``tg-hook.sh`` on POSIX).
_TOKEN_GOAT_HOOK_MARKERS = ("token_goat", "tg-hook")
# Legacy command markers from before the tokenwise -> token-goat rename
# (2026-05-13). Configs patched by old tokenwise builds still carry these; they
# point at a uv-tool path that no longer exists, so they must be stripped on
# re-install/uninstall instead of accumulating as dead duplicate hooks.
_LEGACY_HOOK_MARKERS = ("tokenwise",)


def _is_token_goat_hook(command: str) -> bool:
    """Return True when *command* is one of our *current* hook commands.

    Current-only by design: this drives the "installed?" status checks, so a
    config carrying only stale legacy (pre-rename) entries correctly reports as
    *not* installed and prompts a re-install. Use :func:`_is_managed_hook` for
    the strip path, which must also recognise legacy entries.
    """
    return any(marker in command for marker in _TOKEN_GOAT_HOOK_MARKERS)


def _is_managed_hook(command: str) -> bool:
    """Return True when *command* is a hook token-goat owns and should replace.

    Covers current *and* legacy (pre-rename ``tokenwise``) command markers, so
    the idempotent strip path removes orphaned legacy entries rather than
    leaving them as dead duplicates beside the fresh ones.
    """
    return _is_token_goat_hook(command) or any(
        marker in command for marker in _LEGACY_HOOK_MARKERS
    )


# Claude settings.json permission allowlist entry, plus legacy (pre-rename)
# variants that must be dropped on patch/unpatch so they don't linger as cruft.
_TOKEN_GOAT_PERMISSION = "Bash(token-goat:*)"
_LEGACY_PERMISSIONS = ("Bash(tokenwise:*)",)


def _strip_token_goat_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    """Remove hook entries belonging to token-goat (for idempotent re-install)."""
    kept: list[dict[str, object]] = []
    for entry in entries:
        raw_hooks = entry.get("hooks", [])
        hook_list: list[dict[str, object]] = raw_hooks if isinstance(raw_hooks, list) else []
        surviving_hooks = [
            h for h in hook_list
            if isinstance(h, dict) and not _is_managed_hook(str(h.get("command", "")))
        ]
        if surviving_hooks:
            kept.append({"matcher": entry.get("matcher", "*"), "hooks": surviving_hooks})
    return kept


def _merge_token_goat_hooks(
    existing_hooks: dict[str, list[dict[str, object]]],
    our_hooks: dict[str, list[_HookMatcherEntry]],
) -> tuple[list[str], list[str]]:
    """Idempotently merge *our_hooks* into *existing_hooks* in place.

    For each event in *our_hooks*: strip any prior token-goat entries from the
    existing list, then append the fresh ones.  Returns ``(added, replaced)``
    where each list contains event names suitable for logging.

    Used by both :func:`patch_settings_json` (Claude settings.json) and
    :func:`patch_codex_config` (Codex config.toml) — same shape, two harnesses.
    """
    added: list[str] = []
    replaced: list[str] = []
    for event, entries in our_hooks.items():
        existing_entries = existing_hooks.get(event, [])
        kept = _strip_token_goat_entries(existing_entries)
        stripped_count = len(existing_entries) - len(kept)
        existing_hooks[event] = kept + cast(list[dict[str, object]], entries)
        if stripped_count:
            replaced.append(f"{event}(replaced {stripped_count})")
        else:
            added.append(event)
    return added, replaced


def _strip_token_goat_hooks(hooks: dict[str, list[dict[str, object]]]) -> None:
    """Remove all token-goat entries from *hooks* in place, dropping empty events.

    Used by both :func:`unpatch_settings_json` and :func:`unpatch_codex_config`.
    """
    for event in list(hooks.keys()):
        cleaned = _strip_token_goat_entries(hooks.get(event, []))
        if cleaned:
            hooks[event] = cleaned
        else:
            del hooks[event]


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
    paths.ensure_dir(settings_path.parent)

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
    hooks_added, hooks_replaced = _merge_token_goat_hooks(existing_hooks, our_hooks)
    current["hooks"] = existing_hooks
    if hooks_replaced:
        _LOG.info("patch_settings_json: replaced existing entries for: %s", ", ".join(hooks_replaced))
    if hooks_added:
        _LOG.info("patch_settings_json: added new hook entries for: %s", ", ".join(hooks_added))

    # Permission allowlist — add the current entry, drop any legacy (pre-rename)
    # entries so they don't linger beside it.
    raw_perms = current.get("permissions", {})
    perms: dict[str, object] = raw_perms if isinstance(raw_perms, dict) else {}
    raw_allowed = perms.get("allow", [])
    allowed: list[str] = [
        a for a in (raw_allowed if isinstance(raw_allowed, list) else [])
        if a not in _LEGACY_PERMISSIONS
    ]
    perm_added = _TOKEN_GOAT_PERMISSION not in allowed
    if perm_added:
        allowed.append(_TOKEN_GOAT_PERMISSION)
        _LOG.info("patch_settings_json: added permission %s", _TOKEN_GOAT_PERMISSION)
    else:
        _LOG.debug("patch_settings_json: permission %s already present", _TOKEN_GOAT_PERMISSION)
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
    _strip_token_goat_hooks(hooks)
    current["hooks"] = hooks

    raw_perms = current.get("permissions", {})
    perms: dict[str, object] = raw_perms if isinstance(raw_perms, dict) else {}
    raw_allowed = perms.get("allow", [])
    _drop_perms = {_TOKEN_GOAT_PERMISSION, *_LEGACY_PERMISSIONS}
    allowed = [a for a in (raw_allowed if isinstance(raw_allowed, list) else []) if a not in _drop_perms]
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
    paths.ensure_dir(md_path.parent)
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


def _remove_md_block(md_path: Path, begin_marker: str, end_marker: str) -> bool:
    """Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.

    Returns ``True`` when a block was stripped (file rewritten), ``False`` when
    nothing matched (file unchanged or absent). Shared by :func:`_unpatch_md_block`
    and :func:`_strip_legacy_block` — same regex, same atomic-write contract.
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
    # Atomic write: a crash mid-write must never leave a truncated markdown file behind.
    paths.atomic_write_text(md_path, new + "\n" if new else "")
    return True


def _unpatch_md_block(md_path: Path, begin_marker: str, end_marker: str, not_found_msg: str) -> str:
    """Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.

    Returns a status string.  Extracted to eliminate the identical removal
    pattern duplicated in ``unpatch_claude_md`` and ``unpatch_codex_agents_md``.
    """
    if not md_path.exists():
        return not_found_msg
    _remove_md_block(md_path, begin_marker, end_marker)
    # Always return the path even when no block matched — the caller treats this
    # as "we considered the file" rather than "we mutated it".
    return str(md_path)


def _strip_legacy_block(md_path: Path, begin_marker: str, end_marker: str) -> bool:
    """Remove a legacy ``tokenwise``-era delimited block from *md_path* if present.

    Returns ``True`` if a block was stripped, ``False`` otherwise. The modern
    patch path calls this before writing its block so a single install run
    leaves only the up-to-date content — even on machines that were installed
    under the old binary name and never had their routing tables migrated.
    """
    return _remove_md_block(md_path, begin_marker, end_marker)


# ---------------------------------------------------------------------------
# Routing-table single source of truth
# ---------------------------------------------------------------------------
# Each row: (goal, do_this, not_this_claude_skill, not_this_codex)
# "not_this_claude_skill" is used by both CLAUDE_MD_CONTENT and SKILL_MD_CONTENT.
# "not_this_codex"        is used by CODEX_AGENTS_MD_CONTENT.
_ROUTING_ROWS: list[tuple[str, str, str, str]] = [
    (
        "Find a function, class, or type",
        "`token-goat symbol getUser`",
        '`Grep "getUser"` (10 to 50x more tokens)',
        '`rg "getUser"` (10 to 50x more tokens)',
    ),
    (
        "Read one function or method body",
        '`token-goat read "src/auth.py::login"`',
        "`Read src/auth.py` (about 85% more tokens)",
        "`cat src/auth.py` (about 85% more tokens)",
    ),
    (
        "Read one method on a class",
        '`token-goat read "src/auth.py::Session.refresh"`',
        "`Read src/auth.py`",
        "`cat src/auth.py`",
    ),
    (
        "Read one section of a doc",
        '`token-goat section "README.md::Install"`',
        "`Read README.md`",
        "`cat README.md`",
    ),
    (
        "Disambiguate a duplicate heading",
        '`token-goat section "doc.md::Setup#2"`',
        "`Read doc.md`",
        "`cat doc.md`",
    ),
    (
        "Find code by meaning, not name",
        '`token-goat semantic "rate limit retry"`',
        "Several rounds of `Grep`",
        "Several rounds of `rg`",
    ),
    (
        "Get oriented in an unfamiliar repo",
        "`token-goat map --compact`",
        "Recursive `ls` plus multiple `Read` calls",
        "`ls -R` plus multiple `cat` calls",
    ),
    (
        "Outline a long Google Doc",
        "`token-goat gdrive-sections <file-id>`",
        "Fetching the whole doc",
        "Fetching the whole doc",
    ),
    (
        "Read one TOML/YAML/JSON/INI/.env/Dockerfile block",
        '`token-goat section "pyproject.toml::tool.ruff"`',
        "`Read pyproject.toml`",
        "`cat pyproject.toml`",
    ),
    (
        "Re-inspect a recent Bash output",
        "`token-goat bash-output <id> --tail 50`",
        "Re-running `pytest`/`cargo`/`git log`",
        "Re-running `pytest`/`cargo`/`git log`",
    ),
    (
        "Find all callers of a symbol",
        "`token-goat refs src/auth.py::login --callers`",
        '`Grep "login"` across many files',
        '`rg "login"` across many files',
    ),
    (
        "List symbols changed since a git ref",
        "`token-goat changed --symbol`",
        "Reading the full `git diff`",
        "Reading the full `git diff`",
    ),
    (
        "Read one value from a config file",
        "`token-goat config-get pyproject.toml project.version`",
        "`Read pyproject.toml`",
        "`cat pyproject.toml`",
    ),
    (
        "List all signatures in a file without bodies",
        "`token-goat skeleton src/auth.py`",
        "`Read src/auth.py` (70-90% more tokens)",
        "`cat src/auth.py` (70-90% more tokens)",
    ),
    (
        "List symbols with line ranges and docstrings",
        "`token-goat outline src/auth.py`",
        "`Read src/auth.py`",
        "`cat src/auth.py`",
    ),
    (
        "Read a file on Windows via PowerShell",
        '`token-goat read "src/auth.py::login"` or `token-goat section "README.md::Install"`',
        "`Get-Content src/auth.py`",
        "`Get-Content src/auth.py`",
    ),
]

# Goal text for the WebFetch row differs by harness (Codex adds "/ web_search").
_ROUTING_ROW_WEBFETCH_CLAUDE_SKILL: tuple[str, str, str, str] = (
    "Re-inspect a recent WebFetch response",
    '`token-goat web-output <id> --grep "TODO"`',
    "Re-fetching the same docs URL",
    "Re-fetching the same docs URL",  # not_this_codex unused here
)
_ROUTING_ROW_WEBFETCH_CODEX: tuple[str, str, str, str] = (
    "Re-inspect a recent WebFetch / web_search response",
    '`token-goat web-output <id> --grep "TODO"`',
    "Re-fetching the same docs URL",  # not_this_claude_skill unused here
    "Re-fetching the same docs URL",
)

# Extra row present only in SKILL_MD_CONTENT.
_ROUTING_ROW_SESSION_TOUCHED: tuple[str, str, str, str] = (
    "See what you have already touched",
    "`token-goat session-touched`",
    "Re-reading and hoping you remember",
    "Re-reading and hoping you remember",
)

_ROUTING_TABLE_HEADER = "| Goal | Do this | Not this |\n|------|---------|----------|\n"


def _render_routing_table(rows: list[tuple[str, str, str, str]], *, codex: bool) -> str:
    """Render routing rows as a markdown table string (no trailing newline).

    Each row is ``(goal, do_this, not_this_claude_skill, not_this_codex)``.
    When *codex* is True the fourth element is used; otherwise the third.
    """
    col = 3 if codex else 2
    lines = [_ROUTING_TABLE_HEADER.rstrip("\n")]
    for row in rows:
        lines.append(f"| {row[0]} | {row[1]} | {row[col]} |")
    return "\n".join(lines)


def _claude_skill_routing_rows() -> list[tuple[str, str, str, str]]:
    """Rows for CLAUDE_MD_CONTENT and SKILL_MD_CONTENT (common rows + WebFetch)."""
    return _ROUTING_ROWS + [_ROUTING_ROW_WEBFETCH_CLAUDE_SKILL]


def _codex_routing_rows() -> list[tuple[str, str, str, str]]:
    """Rows for CODEX_AGENTS_MD_CONTENT (common rows + Codex WebFetch)."""
    return _ROUTING_ROWS + [_ROUTING_ROW_WEBFETCH_CODEX]


def _skill_routing_rows() -> list[tuple[str, str, str, str]]:
    """Rows for SKILL_MD_CONTENT (common + WebFetch + session-touched extra row)."""
    return _ROUTING_ROWS + [_ROUTING_ROW_WEBFETCH_CLAUDE_SKILL, _ROUTING_ROW_SESSION_TOUCHED]


# ---------------------------------------------------------------------------
# CLAUDE.md patching
# ---------------------------------------------------------------------------

CLAUDE_MD_CONTENT = (
    "## token-goat - route code reads through token-goat first\n"
    "\n"
    "token-goat is installed. Before you call Read or Grep on a source file, or use"
    " PowerShell `Get-Content` on Windows, check for a token-goat command that does the"
    " same job for a fraction of the tokens. This is the default path, not an optimization."
    " Skipping it burns context you will need later in the session.\n"
    "\n"
    + _render_routing_table(_claude_skill_routing_rows(), codex=False)
    + "\n"
    "\n"
    "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect),"
    " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`"
    " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached"
    " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a"
    " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead"
    " of git hunk context), `refs --callers` (resolve enclosing function name for each reference),"
    " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`"
    " (only show symbols whose body is ≥ N lines)."
    " A miss prints \"Did you mean...?\" suggestions; a unique high-confidence match redirects"
    " transparently with a `(redirected from: ...)` marker. Pre-Bash, pre-Grep, and pre-WebFetch"
    " hooks hint when a tool call is about to repeat.\n"
    "\n"
    "Read is the right call when:\n"
    "- The file is under about 200 lines and you need the whole thing.\n"
    "- The file has never been indexed (new path, scratch script, untracked draft).\n"
    "- It is an image you need to see visually. The shrink runs automatically. Just Read it.\n"
    "\n"
    "Skill commands (after a skill is loaded via Skill tool):\n"
    "- `token-goat skill-body <name>` — print the full cached body for a loaded skill\n"
    "- `token-goat skill-body --compact <name>` — print the compact slice"
    " (post-COMPACT_END rules; far fewer tokens)\n"
    "- `token-goat skill-compact <name>` — alias for skill-body --compact; regenerates and"
    " caches the compact\n"
    "- `token-goat skill-compact --all` — batch-regenerate stale or missing compacts for every"
    " cached skill in the current session; skips skills whose compact is already fresh\n"
    "- `token-goat skill-size [--session-id <id>]` — show body and compact token counts for"
    " all cached skills\n"
    "- `token-goat skill-list [--session-id <id>]` — list loaded skills with compact"
    " availability, token counts, and per-skill compact_stale status\n"
    "- `token-goat skill-list --json [--session-id <id>]` — machine-readable output; each"
    " skill row includes compact_stale (true/false/null) comparing the compact's source SHA"
    " to the current body SHA — null when no compact exists or SHA is unavailable\n"
    "- `token-goat skill-section <name> <heading>` — extract one named section from a skill"
    " body\n"
    "\n"
    "Stale compact advisory: when a skill file is read from disk and the cached compact's"
    " source SHA no longer matches the file's current content SHA, the pre-read hook emits a"
    " `token-goat skill-compact <name>` hint. Run `skill-compact --all` after updating any"
    " skill file to refresh all compacts in one pass.\n"
    "\n"
    "Opt-in config options (set in config.toml or via env vars):\n"
    "- `compact_assist.lazy_skill_injection` (default true) — instead of embedding the full"
    " compact body in the pre-compact manifest, emit a one-line recall pointer"
    " (`token-goat skill-body <name> --compact`). Keeps manifests small; the model fetches"
    " body text on demand. Disable with `TOKEN_GOAT_LAZY_SKILL_INJECTION=0` or"
    " `[compact_assist] lazy_skill_injection = false` to embed compacts inline.\n"
    "- `hints.serve_diff_on_reread` (default false) — when an already-read file is re-read"
    " and its content has changed since the last read, deny the Read tool call and inject a"
    " unified diff instead of the full file. Saves 10-100x tokens when only a few lines"
    " changed. Enable with `TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1` or"
    " `[hints] serve_diff_on_reread = true`.\n"
    "\n"
    "`token-goat stats` groups event kinds into named categories (Read savings, Lookups,"
    " Images, Hints, Bash, Web, Compact / Skills, Other) so the table stays readable even"
    " after many event kinds accumulate. The `By command` breakdown shows which surgical-read"
    " commands (symbol, read, section, semantic, map, skeleton, outline, refs, changed,"
    " config-get) are generating savings.\n"
    "\n"
    "Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts"
    " during code work mean you are reaching for Read or Grep where token-goat would apply.\n"
)


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

SKILL_MD_CONTENT = (
    "---\n"
    "name: token-goat\n"
    "description: Use BEFORE reaching for Read or Grep on a source file, or PowerShell"
    " `Get-Content` on Windows. token-goat commands replace symbol search, single-function"
    " reads, doc-section reads, semantic search, and repo overviews at a fraction of the"
    " token cost. Hooks handle image shrink, Drive intercept, and read dedup automatically."
    " Skipping token-goat burns session context.\n"
    "---\n"
    "\n"
    "# token-goat\n"
    "\n"
    "token-goat is installed. Route code and content reads through it first. This is the"
    " default path, not optional polish. Tokens you spend rereading files or grepping wide"
    " are tokens you will not have for the work that matters.\n"
    "\n"
    "## Automatic. Do not duplicate.\n"
    "\n"
    "- Large images on Read get redirected to a shrunken cached copy (about 95% fewer tokens).\n"
    "- Google Drive downloads get redirected to a token-goat fetch that downloads, shrinks,"
    " and caches.\n"
    "- WebFetch on an image URL gets the same treatment.\n"
    "- Repeat reads of the same file in one session trigger a system reminder so you do not"
    " pay twice.\n"
    "\n"
    "You do not call these. They run on their own.\n"
    "\n"
    "## What you DO call\n"
    "\n"
    "Before reaching for Read or Grep on a code file, or PowerShell `Get-Content` on"
    " Windows, check this table.\n"
    "\n"
    + _render_routing_table(_skill_routing_rows(), codex=False)
    + "\n"
    "\n"
    "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect),"
    " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`"
    " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached"
    " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a"
    " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead"
    " of git hunk context), `refs --callers` (resolve enclosing function name for each reference),"
    " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`"
    " (only show symbols whose body is ≥ N lines)."
    " A miss prints \"Did you mean...?\" suggestions; try one before falling back to `Read`. A"
    " unique high-confidence match redirects transparently with a `(redirected from: ...)` marker.\n"
    "\n"
    "## Skill commands\n"
    "\n"
    "After a skill is loaded via the Skill tool, use these to inspect or recall it:\n"
    "\n"
    "- `token-goat skill-body <name>` — print the full cached body for a loaded skill\n"
    "- `token-goat skill-body --compact <name>` — print the compact slice (post-COMPACT_END rules"
    " only; far fewer tokens)\n"
    "- `token-goat skill-compact <name>` — alias for skill-body --compact; regenerates and caches"
    " the compact\n"
    "- `token-goat skill-compact --all` — batch-regenerate stale or missing compacts for every"
    " cached skill in the current session (skips skills whose compact is already fresh)\n"
    "- `token-goat skill-size [--session-id <id>]` — show body and compact token counts for all"
    " cached skills\n"
    "- `token-goat skill-list [--session-id <id>]` — list loaded skills with compact availability,"
    " token counts, and compact_stale status\n"
    "- `token-goat skill-list --json [--session-id <id>]` — machine-readable output; each skill"
    " row includes compact_stale (true/false/null) — true when the compact's embedded source SHA"
    " does not match the body's current SHA\n"
    "- `token-goat skill-section <name> <heading>` — extract one named section from a skill body\n"
    "\n"
    "Stale compact advisory: when a skill file changes on disk between sessions, the pre-read"
    " hook detects the SHA mismatch and hints `token-goat skill-compact <name>`. Run"
    " `skill-compact --all` after updating skill files to refresh every compact in one pass.\n"
    "\n"
    "## When Read is the right call\n"
    "\n"
    "- The file is under about 200 lines and you need the whole thing.\n"
    "- The file has never been indexed (new path, scratch script, untracked draft).\n"
    "- You need to view an image visually. The shrink already ran. Just Read it.\n"
    "\n"
    "## Verify the habit\n"
    "\n"
    "Run `token-goat stats` and watch event counts climb. Flat counts during code work mean"
    " you are reaching for Read or Grep where a token-goat command would apply. Run"
    " `token-goat doctor` if anything looks wrong. Run `token-goat version` to confirm the"
    " installed version (scriptable; `--json` for structured output).\n"
)


def write_skill() -> str:
    """Write the token-goat skill to the Claude Code skills directory."""
    sd = skill_dir()
    paths.ensure_dir(sd)
    skill_path = sd / "SKILL.md"
    skill_path.write_text(SKILL_MD_CONTENT, encoding="utf-8")
    _LOG.info("skill written: %s (%d bytes)", skill_path, len(SKILL_MD_CONTENT.encode()))
    return str(skill_path)


def pregen_skill_compacts() -> str:
    """Pre-generate compact summaries for every skill file on disk.

    Discovers all skill SKILL.md files under ``claude_skills_dir()`` and
    ``claude_plugins_dir()`` (marketplace layout).  For each skill without an
    up-to-date compact in any session, generates one synchronously and stores it
    under the ``_install`` pseudo-session ID so subsequent ``post_skill``
    invocations find a cache hit via :func:`skill_cache.get_compact_any_session`.

    After the run, writes a sentinel file via :func:`paths.skill_pregen_sentinel_path`
    so ``token-goat doctor`` can surface skills installed after the last pre-gen run.

    Returns a human-readable summary string for the install result dict.
    """
    from . import skill_cache  # noqa: PLC0415

    skills_root = paths.claude_skills_dir()
    plugins_root = paths.claude_plugins_dir()

    # Collect (skill_name, skill_path) pairs.
    skill_files: list[tuple[str, Path]] = []

    # User-installed skills: ~/.claude/skills/<name>/SKILL.md
    if skills_root.is_dir():
        for skill_dir_entry in skills_root.iterdir():
            if not skill_dir_entry.is_dir():
                continue
            skill_name = skill_dir_entry.name
            for candidate in (
                skill_dir_entry / "SKILL.md",
                skill_dir_entry / f"{skill_name}.md",
                skill_dir_entry / skill_name / "SKILL.md",
            ):
                if candidate.is_file():
                    skill_files.append((skill_name, candidate))
                    break

    # Plugin-installed skills: marketplace layout
    # ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
    plugins_cache = plugins_root / "cache"
    if plugins_cache.is_dir():
        with contextlib.suppress(OSError):
            for mkt in plugins_cache.iterdir():
                if not mkt.is_dir():
                    continue
                for plugin_dir_entry in mkt.iterdir():
                    if not plugin_dir_entry.is_dir():
                        continue
                    plugin_name = plugin_dir_entry.name
                    try:
                        versions = sorted(
                            (v for v in plugin_dir_entry.iterdir() if v.is_dir()),
                            reverse=True,
                        )
                    except OSError:
                        continue
                    for ver in versions:
                        ver_skills = ver / "skills"
                        if not ver_skills.is_dir():
                            continue
                        for skill_entry in ver_skills.iterdir():
                            if not skill_entry.is_dir():
                                continue
                            sname = skill_entry.name
                            namespaced = f"{plugin_name}:{sname}"
                            for candidate in (
                                skill_entry / "SKILL.md",
                                skill_entry / f"{sname}.md",
                            ):
                                if candidate.is_file():
                                    skill_files.append((namespaced, candidate))
                                    break
                        break  # use newest version only

    generated = 0
    skipped = 0
    failed = 0
    session_id = "_install"

    for skill_name, skill_path in skill_files:
        try:
            body = skill_path.read_text(encoding="utf-8", errors="replace")
            body_sha = skill_cache.content_hash(body)

            # Check if a fresh compact already exists (any session).
            existing = skill_cache.get_compact_any_session(skill_name)
            if existing:
                compact_sha = skill_cache.extract_compact_source_sha(existing)
                if compact_sha is not None and body_sha.startswith(compact_sha):
                    skipped += 1
                    continue

            # Generate and store the compact.
            compact = skill_cache.generate_compact_summary(body)
            skill_cache.store_compact(session_id, skill_name, compact, source_sha=body_sha)
            generated += 1
        except Exception as exc:  # noqa: BLE001
            _LOG.warning("pregen_skill_compacts: failed for %s: %s", skill_name, exc)
            failed += 1

    # Write sentinel so doctor can detect newly installed skills.
    try:
        sentinel_path = paths.skill_pregen_sentinel_path()
        sentinel_path.parent.mkdir(parents=True, exist_ok=True)
        sentinel_data = json.dumps({
            "ts": time.time(),
            "skill_count": len(skill_files),
            "compact_count": generated + skipped,
        })
        paths.atomic_write_text(sentinel_path, sentinel_data)
    except Exception as exc:  # noqa: BLE001
        _LOG.warning("pregen_skill_compacts: sentinel write failed: %s", exc)

    parts = [f"{generated} generated"]
    if skipped:
        parts.append(f"{skipped} up-to-date")
    if failed:
        parts.append(f"{failed} failed")
    total = len(skill_files)
    return f"{total} skills found — " + ", ".join(parts)


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

    Derived from :data:`token_goat.hook_registry.HOOK_EVENTS` — see
    :func:`_build_hooks_block` for the shared implementation.  The ``binary``
    parameter is kept for backwards compatibility but unused.
    """
    return _build_hooks_block(paths.python_runner_command, codex=True)


def patch_codex_config(binary: str) -> str:
    """Merge token-goat hooks into ~/.codex/config.toml idempotently."""
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    cfg_path = codex_config_path()
    paths.ensure_dir(cfg_path.parent)

    existing = tomllib.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}

    our_hooks = _codex_hooks_block(binary)
    existing_hooks = existing.get("hooks", {})
    _merge_token_goat_hooks(existing_hooks, our_hooks)
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
    _strip_token_goat_hooks(hooks)
    existing["hooks"] = hooks

    # Atomic write: a crash mid-write must never leave a truncated config.toml behind.
    paths.atomic_write_text(cfg_path, tomli_w.dumps(existing))
    return str(cfg_path)


CODEX_AGENTS_MD_CONTENT = (
    "## token-goat - route code reads through token-goat first (Codex)\n"
    "\n"
    "token-goat is installed. Before you run `rg`, `grep`, `cat`, `head`, `bat`,"
    " `Get-Content`, or any Bash read of a source file, check whether a token-goat command"
    " does the same job for a fraction of the tokens. Route through token-goat by default."
    " Skipping it burns context you will need later in the session.\n"
    "\n"
    + _render_routing_table(_codex_routing_rows(), codex=True)
    + "\n"
    "\n"
    "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect),"
    " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`"
    " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached"
    " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a"
    " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead"
    " of git hunk context), `refs --callers` (resolve enclosing function name for each reference),"
    " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`"
    " (only show symbols whose body is ≥ N lines)."
    " A miss prints \"Did you mean...?\" suggestions; a unique high-confidence match redirects"
    " transparently with a `(redirected from: ...)` marker. Pre-Bash, pre-Grep, and pre-WebFetch"
    " hooks hint when a tool call is about to repeat.\n"
    "\n"
    "Plain Bash reads are the right call when:\n"
    "- The file is under about 200 lines and you need the whole thing.\n"
    "- The file has never been indexed (new path, scratch script, untracked draft).\n"
    "- You need exact bytes to build an `apply_patch` hunk that must match the file verbatim.\n"
    "\n"
    "Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts"
    " during code work mean you are reaching for `rg` or `cat` where a token-goat command"
    " would apply.\n"
)


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
# Gemini CLI hook integration
# ---------------------------------------------------------------------------
# Gemini CLI uses ~/.gemini/settings.json (global) or .gemini/settings.json
# (per-project).  The hooks format is structurally identical to Claude Code's
# settings.json — an object mapping event names to arrays of matcher+hook-list
# entries, with JSON on stdin/stdout and exit-code semantics.
#
# Key differences from Claude Code:
#   - Event names: BeforeTool / AfterTool / SessionStart / PreCompress
#     (vs PreToolUse / PostToolUse / SessionStart / PreCompact)
#   - Tool names: run_shell_command, read_file, write_file, replace, glob,
#     grep_search (vs Read, Bash, Edit, Write, Glob, Grep)
#   - Output field: decision: "allow"/"deny" + reason
#     (vs continue: true/false + hookSpecificOutput)
#   - hookSpecificOutput.tool_input merges with model args (same field name)
#
# We use the same subprocess hook protocol (tg-hook.cmd / tg-hook.sh) and
# add a --harness gemini flag so the dispatcher can apply format translation.
# ---------------------------------------------------------------------------

# Gemini CLI tool name → token-goat internal tool name.  Used both for the
# BeforeTool matcher regex and in the bridge payload normalisation layer.
_GEMINI_TOOL_TO_TG: dict[str, str] = {
    "run_shell_command": "Bash",
    "read_file": "Read",
    "read_many_files": "Read",
    "list_directory": "Read",
    "write_file": "Write",
    "replace": "Edit",
    "glob": "Glob",
    "grep_search": "Grep",
    "search_file_content": "Grep",  # legacy alias kept by Gemini CLI
    "web_search": "WebFetch",
    "web_fetch": "WebFetch",
}

# Regex patterns for BeforeTool / AfterTool matchers:
# read-equivalent tools
_GEMINI_READ_MATCHER = (
    "run_shell_command|read_file|read_many_files|list_directory|glob|grep_search|search_file_content"
)
# edit-equivalent tools
_GEMINI_EDIT_MATCHER = "write_file|replace"
# web-fetch equivalent tools
_GEMINI_FETCH_MATCHER = "web_search|web_fetch"


def gemini_dir() -> Path:
    """Return the global Gemini CLI config directory (~/.gemini)."""
    return Path.home() / ".gemini"


def gemini_settings_path() -> Path:
    """Return the path to ~/.gemini/settings.json where Gemini CLI hooks are configured."""
    return gemini_dir() / "settings.json"


def _gemini_hooks_block() -> dict[str, list[_HookMatcherEntry]]:
    """Build the Gemini CLI settings.json hooks structure.

    Gemini CLI uses BeforeTool/AfterTool/SessionStart/PreCompress instead of
    PreToolUse/PostToolUse/SessionStart/PreCompact, but the JSON wire format
    is otherwise identical to Claude Code's settings.json.

    All hook commands get ``--harness gemini`` appended so the dispatcher in
    :mod:`token_goat.hooks_common` can apply any Gemini-specific payload
    translation (tool-name remapping, decision→continue field normalisation).
    """
    runner = _hook_runner_command

    def _entry(matcher: str, event_name: str, timeout: int) -> _HookMatcherEntry:
        cmd = runner("hook", event_name, "--harness", "gemini")
        return {
            "matcher": matcher,
            "hooks": [{"type": "command", "command": cmd, "timeout": timeout}],
        }

    return {
        "SessionStart": [_entry("startup", "session-start", 30000)],
        "BeforeTool": [
            _entry(_GEMINI_READ_MATCHER, "pre-read", 5000),
            _entry(_GEMINI_FETCH_MATCHER, "pre-fetch", 2000),
        ],
        "AfterTool": [
            _entry(_GEMINI_EDIT_MATCHER, "post-edit", 2000),
            _entry(_GEMINI_READ_MATCHER, "post-read", 2000),
            _entry("run_shell_command", "post-bash", 3000),
            _entry(_GEMINI_FETCH_MATCHER, "post-fetch", 3000),
        ],
        "PreCompress": [_entry("*", "pre-compact", 5000)],
    }


def patch_gemini_settings() -> str:
    """Merge token-goat hooks into ~/.gemini/settings.json idempotently.

    Creates the file with an empty JSON object if it does not exist.  Uses the
    same _merge_token_goat_hooks / _strip_token_goat_entries helpers used by
    the Claude and Codex integrations so the idempotency semantics are identical.

    Returns the path of the settings file written.
    """
    settings_path = gemini_settings_path()
    paths.ensure_dir(settings_path.parent)

    existing: dict[str, object] = {}
    if settings_path.exists():
        try:
            raw = settings_path.read_text(encoding="utf-8")
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                existing = parsed
        except (json.JSONDecodeError, OSError) as e:
            _LOG.warning("gemini settings.json read failed, starting fresh: %s", e)

    our_hooks = _gemini_hooks_block()
    existing_hooks_raw = existing.get("hooks", {})
    existing_hooks: dict[str, list[dict[str, object]]] = (
        existing_hooks_raw if isinstance(existing_hooks_raw, dict) else {}
    )
    _merge_token_goat_hooks(existing_hooks, our_hooks)
    existing["hooks"] = existing_hooks

    paths.atomic_write_text(settings_path, json.dumps(existing, indent=2))
    _LOG.info("gemini settings.json written: %s", settings_path)
    return str(settings_path)


def unpatch_gemini_settings() -> str:
    """Remove token-goat entries from ~/.gemini/settings.json.

    Returns a human-readable status string.
    """
    settings_path = gemini_settings_path()
    if not settings_path.exists():
        return "gemini settings.json not found"

    try:
        raw = settings_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError) as e:
        return f"error reading gemini settings.json: {e}"

    if not isinstance(data, dict):
        return "gemini settings.json is not a JSON object; skipped"

    hooks_raw = data.get("hooks", {})
    hooks: dict[str, list[dict[str, object]]] = (
        hooks_raw if isinstance(hooks_raw, dict) else {}
    )
    _strip_token_goat_hooks(hooks)
    data["hooks"] = hooks
    paths.atomic_write_text(settings_path, json.dumps(data, indent=2))
    return str(settings_path)


def _check_gemini_settings() -> str:
    """Return 'installed' if ~/.gemini/settings.json has token-goat hooks."""
    settings_path = gemini_settings_path()
    if not settings_path.exists():
        return "not installed (gemini settings.json absent)"
    try:
        raw = settings_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return "error (gemini settings.json malformed)"
    if not isinstance(data, dict):
        return "error (gemini settings.json not a JSON object)"
    hooks_raw = data.get("hooks", {})
    hooks: dict[str, object] = hooks_raw if isinstance(hooks_raw, dict) else {}
    return "installed" if _hooks_contain_token_goat(hooks) else "not installed"


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
                if isinstance(h, dict) and _is_token_goat_hook(str(h.get("command", ""))):
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

    Uses ``_HKCU_RUN_PATH`` (the shared registry key path constant) with
    ``KEY_READ`` access.  Returns None when the registry is inaccessible
    (non-Windows, permission error, etc.) so callers can distinguish "absent"
    from "unreadable".
    """
    try:
        import winreg  # type: ignore[import]  # winreg is Windows-only; not in typeshed for cross-platform targets
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _HKCU_RUN_PATH,
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


def detect_aider() -> bool:
    """Return True if aider is installed on this machine (binary on PATH or pip package)."""
    if shutil.which("aider"):
        return True
    try:
        import importlib.util  # noqa: PLC0415

        return importlib.util.find_spec("aider") is not None
    except Exception:  # noqa: BLE001
        return False


def detect_cline() -> bool:
    """Return True if Cline (AI coding extension CLI) is on PATH or importable."""
    if shutil.which("cline") or shutil.which("claude-dev"):
        return True
    try:
        import importlib.util  # noqa: PLC0415

        return importlib.util.find_spec("cline") is not None
    except Exception:  # noqa: BLE001
        return False


def detect_windsurf() -> bool:
    """Return True if Windsurf (Codeium AI editor) is on PATH or its config dir exists."""
    if shutil.which("windsurf"):
        return True
    # Windsurf stores its config/extensions in ~/.windsurf or ~/AppData/Roaming/Windsurf
    if (Path.home() / ".windsurf").exists():
        return True
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", ""))
        if appdata and (appdata / "Windsurf").exists():
            return True
    return False


def detect_copilot_cli() -> bool:
    """Return True if the standalone GitHub Copilot CLI binary is on PATH."""
    return bool(shutil.which("copilot") or shutil.which("github-copilot-cli"))


def detect_installed_harnesses() -> dict[str, bool]:
    """Return a dict of harness name -> bool indicating presence on this machine.

    Detection is purely heuristic — a harness is "detected" when one of its
    well-known environment variables or directories is present.

    Harnesses checked:
    - ``claude`` — always present (token-goat only makes sense inside Claude Code).
    - ``aider``   — detected when the ``aider`` binary is on PATH or the package is importable.
    - ``codex``  — detected when ``CODEX_HOME`` env var is set OR ``~/.codex/``
                   exists (Codex CLI stores its config there).
    - ``gemini``  — detected when ``~/.gemini/`` exists (Gemini CLI stores its config there).
    - ``opencode`` — detected when the opencode plugins dir exists.
    - ``openclaw`` — detected when ``~/.openclaw/`` exists.
    - ``pi``       — detected when ``~/.pi/`` exists (pi-coding-agent config dir).
    - ``cline``    — detected when the ``cline`` or ``claude-dev`` binary is on PATH or package is importable.
    - ``windsurf`` — detected when ``windsurf`` binary is on PATH or config dir exists.
    - ``copilot-cli`` — detected when ``copilot`` or ``github-copilot-cli`` binary is on PATH.
    """
    result: dict[str, bool] = {}

    # Claude Code: always present (token-goat only makes sense inside Claude Code).
    result["claude"] = True

    # Aider
    result["aider"] = detect_aider()

    # Codex: env var takes precedence; fall back to directory probe.
    codex_home_env = os.environ.get("CODEX_HOME", "")
    codex_dir_exists = codex_dir().exists()
    result["codex"] = bool(codex_home_env or codex_dir_exists)

    # Gemini CLI: stores config/settings in ~/.gemini/
    result["gemini"] = (Path.home() / ".gemini").exists()

    # opencode and openclaw: check with error handling
    try:
        from . import bridges as _br  # noqa: PLC0415

        result["opencode"] = _br.opencode_plugins_dir().parent.exists()
        result["openclaw"] = (Path.home() / ".openclaw").exists()
        result["pi"] = (Path.home() / ".pi").exists()
    except Exception:  # noqa: BLE001
        result["opencode"] = False
        result["openclaw"] = False
        result["pi"] = False

    # Other harnesses
    result["cline"] = detect_cline()
    result["windsurf"] = detect_windsurf()
    result["copilot-cli"] = detect_copilot_cli()

    return result


def detect_harnesses() -> list[str]:
    """Return a list of harness names that appear to be present on this machine.

    Detection is purely heuristic — a harness is "detected" when one of its
    well-known environment variables or directories is present.  The list is
    ordered for display: Claude Code first (always present when token-goat is
    in use), then others alphabetically.

    This function is kept for backward compatibility; new code should prefer
    :func:`detect_installed_harnesses` which returns a dict[str, bool].
    """
    harnesses_dict = detect_installed_harnesses()
    # Return names of detected harnesses in deterministic order
    found: list[str] = ["claude"]  # always first
    # Append others in alphabetical order
    for name in sorted(harnesses_dict.keys()):
        if name != "claude" and harnesses_dict[name]:
            found.append(name)
    return found


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
    status["Gemini CLI hooks (settings.json)"] = _check_gemini_settings()
    from . import bridges  # noqa: PLC0415
    status["opencode plugin"] = bridges._check_opencode_plugin()
    status["openclaw plugin"] = bridges._check_openclaw_plugin()
    status["pi plugin"] = bridges._check_pi_plugin()
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


def _count_token_goat_hooks(hooks: dict[str, object]) -> int:
    """Return the number of token-goat hook entries in a hooks dict.

    Shared by :func:`_settings_json_token_goat_count` and
    :func:`_codex_config_token_goat_count` — same shape, two harnesses.  The
    structure is ``{event: [{matcher, hooks: [{command, ...}]}, ...], ...}``
    which is identical between Claude's settings.json and Codex's config.toml.
    """
    count = 0
    for entries in hooks.values():
        entry_list = entries if isinstance(entries, list) else []
        for entry in entry_list:
            if not isinstance(entry, dict):
                continue
            for h in (entry.get("hooks", []) or []):
                if isinstance(h, dict) and _is_managed_hook(str(h.get("command", ""))):
                    count += 1
    return count


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
    return _count_token_goat_hooks(hooks)


def _codex_config_token_goat_count() -> int:
    """Return the number of token-goat hook entries currently in codex config.toml.

    Codex-side counterpart of :func:`_settings_json_token_goat_count`.  Used to
    verify that ``patch_codex_config`` is idempotent — a re-install must not
    double the entry count.  Returns 0 when the config is absent or malformed
    so tests can compare counts without special-casing those branches.
    """
    import tomllib  # noqa: PLC0415

    cfg_path = codex_config_path()
    if not cfg_path.exists():
        return 0
    try:
        data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError):
        return 0
    raw_hooks = data.get("hooks", {})
    hooks: dict[str, object] = raw_hooks if isinstance(raw_hooks, dict) else {}
    return _count_token_goat_hooks(hooks)


def plan_install(
    install_codex: bool = False,
    install_opencode: bool = False,
    install_openclaw: bool = False,
    install_pi: bool = False,
    targets: set[str] | None = None,
) -> list[_PlanEntry]:
    """Return what :func:`install_all` *would* do, without making any changes.

    Read-only: must never write to disk, registry, schtasks, launchctl, systemd,
    or crontab.  Used by ``token-goat install --dry-run`` so users can confirm
    their config will be merged (not overwritten) and that the right autostart
    mechanism will be picked on their platform.

    Each row is a :class:`_PlanEntry`.  Optional integrations (codex/opencode/
    openclaw) are only included when the corresponding flag is set, matching
    :func:`install_all` semantics.  *targets* overrides booleans when provided
    (same semantics as :func:`install_all`).
    """
    install_gemini = False
    if targets is not None:
        effective = targets if "all" not in targets else {"claude", "codex", "gemini", "opencode", "openclaw", "pi"}
        install_codex = "codex" in effective
        install_gemini = "gemini" in effective
        install_opencode = "opencode" in effective
        install_openclaw = "openclaw" in effective
        install_pi = "pi" in effective
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

    # 6. optional gemini — BeforeTool/AfterTool/SessionStart/PreCompress hooks
    if install_gemini:
        gs_path = gemini_settings_path()
        if gs_path.exists():
            try:
                gs_raw = gs_path.read_text(encoding="utf-8")
                gs_data = json.loads(gs_raw)
                existing_count = sum(
                    1
                    for entries in (gs_data.get("hooks", {}) or {}).values()
                    if isinstance(entries, list)
                    for e in entries
                    for h in (e.get("hooks", []) if isinstance(e, dict) else [])
                    if isinstance(h, dict) and _is_managed_hook(str(h.get("command", "")))
                )
                action = "update" if existing_count else "create"
                detail = (
                    f"would replace {existing_count} existing token-goat hook entries"
                    if existing_count
                    else "would add token-goat hooks block (preserving other hooks)"
                )
            except (json.JSONDecodeError, OSError):
                action = "update"
                detail = "could not read existing settings; will merge idempotently"
        else:
            action = "create"
            detail = "file does not exist; would create with token-goat hooks"
        plan.append(_PlanEntry(
            component="gemini: hooks",
            target=str(gs_path),
            action=action,
            detail=detail,
        ))

    # 7. optional opencode / openclaw / pi
    if install_opencode or install_openclaw or install_pi:
        try:
            from . import bridges  # noqa: PLC0415
        except Exception as e:  # noqa: BLE001
            plan.append(_PlanEntry(
                component="bridges",
                target="(import failed)",
                action="error",
                detail=str(e),
            ))
            bridges = None  # type: ignore[assignment]  # bridges typed as the bridges module above; reset to None on import failure
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
        if install_pi and bridges is not None:
            plan.append(_PlanEntry(
                component="pi: extension",
                target=str(getattr(bridges, "pi_plugin_path", lambda: "<unknown>")()),
                action="create",
                detail="would write/refresh TS extension",
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

    # 3b. codex config.toml — only verified when the file exists, so users who
    # never ran `install --codex` don't see a noisy "missing" entry.
    codex_cfg = codex_config_path()
    if codex_cfg.exists():
        codex_count = _codex_config_token_goat_count()
        report.append(_PlanEntry(
            component="codex config.toml",
            target=str(codex_cfg),
            action="ok" if codex_count > 0 else "missing",
            detail=(
                f"{codex_count} token-goat hook entries present"
                if codex_count > 0
                else "no token-goat hook entries found"
            ),
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
    install_pi: bool = False,
    targets: set[str] | None = None,
) -> dict[str, str]:
    """Run the full install. Returns a dict of step -> result string.

    *targets* is an optional set of tool names (``claude``, ``codex``,
    ``opencode``, ``openclaw``, ``pi``, ``all``).  When provided it overrides the
    individual boolean flags: passing ``targets={"codex"}`` is equivalent to
    ``install_codex=True`` with all other booleans at their defaults.
    ``targets={"all"}`` enables every optional integration.
    When *targets* is ``None`` the legacy boolean flags are honoured unchanged.

    The ``pi`` target installs the bridge into the global pi extensions
    directory (``~/.pi/agent/extensions``).  For a project-local install, call
    :func:`token_goat.bridges.install_pi_plugin` with a ``target_dir`` directly.
    """
    install_gemini = False
    if targets is not None:
        effective = targets if "all" not in targets else {"claude", "codex", "gemini", "opencode", "openclaw", "pi"}
        install_codex = "codex" in effective
        install_gemini = "gemini" in effective
        install_opencode = "opencode" in effective
        install_openclaw = "openclaw" in effective
        install_pi = "pi" in effective
    t0 = time.monotonic()
    _LOG.info(
        "install_all: starting (platform=%s codex=%s opencode=%s openclaw=%s pi=%s targets=%s)",
        sys.platform,
        install_codex,
        install_opencode,
        install_openclaw,
        install_pi,
        targets,
    )
    paths.ensure_dirs()
    result: dict[str, str] = {}

    # Write the hook wrapper FIRST so patch_settings_json() picks it up.
    try:
        wrapper_path = _write_hook_wrapper()
        result["hook wrapper"] = _ok_fail(True, str(wrapper_path))
    except Exception as e:  # noqa: BLE001
        result["hook wrapper"] = f"FAIL — {e}"
        _LOG.warning("install step: hook wrapper — FAIL: %s", e)

    settings_ok, settings_detail = patch_settings_json()
    result["settings.json"] = _ok_fail(settings_ok, settings_detail)
    _LOG.info("install step: settings.json — %s", _ok_fail(settings_ok, settings_detail))

    md_out = patch_claude_md()
    result["CLAUDE.md"] = _ok_fail(True, md_out)
    _LOG.info("install step: CLAUDE.md — %s", _ok_fail(True, md_out))

    skill_path = write_skill()
    result["skill"] = _ok_fail(True, skill_path)
    _LOG.info("install step: skill — %s", _ok_fail(True, skill_path))

    try:
        pregen_result = pregen_skill_compacts()
        result["skill compact pre-gen"] = _ok_fail(True, pregen_result)
        _LOG.info("install step: skill compact pre-gen — %s", pregen_result)
    except Exception as e:  # noqa: BLE001
        result["skill compact pre-gen"] = f"FAIL — {e}"
        _LOG.warning("install step: skill compact pre-gen — FAIL: %s", e)

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

    if install_gemini:
        _run_step(result, "gemini: hooks", patch_gemini_settings)

    if install_opencode or install_openclaw or install_pi:
        from . import bridges  # noqa: PLC0415

    if install_opencode:
        _run_step(result, "opencode: plugin", bridges.install_opencode_plugin)

    if install_openclaw:
        _run_step(result, "openclaw: plugin", bridges.install_openclaw_plugin)

    if install_pi:
        _run_step(result, "pi: extension", bridges.install_pi_plugin)

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
    gemini: bool = False,
    opencode: bool = False,
    openclaw: bool = False,
    pi: bool = False,
) -> dict[str, str]:
    """Reverse install. With purge=True also deletes the data directory."""
    t0 = time.monotonic()
    _LOG.info(
        "uninstall_all: starting (platform=%s purge=%s codex=%s gemini=%s opencode=%s openclaw=%s pi=%s)",
        sys.platform,
        purge,
        codex,
        gemini,
        opencode,
        openclaw,
        pi,
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

    if gemini:
        result["gemini: hooks"] = _ok_fail(True, f"unpatched — {unpatch_gemini_settings()}")

    if opencode or openclaw or pi:
        from . import bridges  # noqa: PLC0415

    if opencode:
        result["opencode: plugin"] = bridges.uninstall_opencode_plugin()

    if openclaw:
        result["openclaw: plugin"] = bridges.uninstall_openclaw_plugin()

    if pi:
        result["pi: extension"] = bridges.uninstall_pi_plugin()

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
