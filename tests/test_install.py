"""Tests for token_goat.install."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import token_goat.install as install_mod
from token_goat import install

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_home(tmp_path: Path) -> Path:
    """Return a fake home directory rooted at tmp_path/home."""
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    return home


def _patch_home(monkeypatch, home: Path):
    """Monkeypatch Path.home() to return *home* and re-derive token_goat.install functions."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))


# ---------------------------------------------------------------------------
# 1. patch_settings_json — missing file creates valid JSON with our hooks
# ---------------------------------------------------------------------------


def test_patch_settings_json_missing_file(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    ok, detail = install.patch_settings_json()

    assert ok is True
    settings_path = home / ".claude" / "settings.json"
    assert settings_path.exists()
    data = json.loads(settings_path.read_text())

    hooks = data["hooks"]
    assert "SessionStart" in hooks
    assert "PreToolUse" in hooks
    assert "PostToolUse" in hooks

    # Check at least one hook command references token_goat
    ss_hooks = hooks["SessionStart"][0]["hooks"]
    assert any("token_goat" in h["command"] for h in ss_hooks)

    # Permission allowlist
    assert "Bash(token-goat:*)" in data["permissions"]["allow"]


# ---------------------------------------------------------------------------
# 2. patch_settings_json — preserves existing unrelated hooks
# ---------------------------------------------------------------------------


def test_patch_settings_json_preserves_existing_hooks(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    existing = {
        "hooks": {
            "PostToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "other-tool hook bash", "timeout": 1000}
                    ],
                }
            ]
        }
    }
    (claude_dir / "settings.json").write_text(json.dumps(existing), encoding="utf-8")

    ok, _ = install.patch_settings_json()

    assert ok is True
    data = json.loads((claude_dir / "settings.json").read_text())
    post_entries = data["hooks"]["PostToolUse"]
    commands_flat = [h["command"] for entry in post_entries for h in entry.get("hooks", [])]
    # Existing unrelated entry must survive
    assert any("other-tool" in c for c in commands_flat)
    # Our entries must be present too
    assert any("token_goat" in c for c in commands_flat)


# ---------------------------------------------------------------------------
# 3. patch_settings_json — idempotent (running twice produces same result)
# ---------------------------------------------------------------------------


def test_patch_settings_json_idempotent(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    install.patch_settings_json()
    install.patch_settings_json()

    data = json.loads((home / ".claude" / "settings.json").read_text())
    ss_entries = data["hooks"]["SessionStart"]
    # Should only have ONE token-goat SessionStart entry, not two
    cc_commands = [
        h["command"]
        for entry in ss_entries
        for h in entry.get("hooks", [])
        if "token_goat" in h["command"]
    ]
    assert len(cc_commands) == 1, f"expected 1, got {len(cc_commands)}: {cc_commands}"


# ---------------------------------------------------------------------------
# 4. unpatch_settings_json — removes our entries cleanly
# ---------------------------------------------------------------------------


def test_unpatch_settings_json_removes_token_goat(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    install.patch_settings_json()
    install.unpatch_settings_json()

    settings_path = home / ".claude" / "settings.json"
    data = json.loads(settings_path.read_text())
    hooks = data.get("hooks", {})
    for event, entries in hooks.items():
        for entry in entries:
            for h in entry.get("hooks", []):
                assert "token_goat" not in h.get("command", ""), (
                    f"token-goat found in event {event}: {h}"
                )


# ---------------------------------------------------------------------------
# 5. patch_claude_md — missing file creates file with delimited block
# ---------------------------------------------------------------------------


def test_patch_claude_md_missing_file(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_claude_md()
    md_path = home / ".claude" / "CLAUDE.md"
    assert md_path.exists()
    content = md_path.read_text()
    assert install.CLAUDE_MD_BEGIN in content
    assert install.CLAUDE_MD_END in content
    assert "token-goat" in content


# ---------------------------------------------------------------------------
# 6. patch_claude_md — existing file without our block gets it appended
# ---------------------------------------------------------------------------


def test_patch_claude_md_appends_to_existing(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    existing_content = "# My existing CLAUDE.md\n\nSome prior content.\n"
    (claude_dir / "CLAUDE.md").write_text(existing_content, encoding="utf-8")

    install.patch_claude_md()
    content = (claude_dir / "CLAUDE.md").read_text()

    assert "My existing CLAUDE.md" in content
    assert install.CLAUDE_MD_BEGIN in content
    assert install.CLAUDE_MD_END in content


# ---------------------------------------------------------------------------
# 7. patch_claude_md — existing file WITH our block gets it replaced (idempotent)
# ---------------------------------------------------------------------------


def test_patch_claude_md_replaces_existing_block(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_claude_md()
    install.patch_claude_md()

    md_path = home / ".claude" / "CLAUDE.md"
    content = md_path.read_text()
    assert content.count(install.CLAUDE_MD_BEGIN) == 1
    assert content.count(install.CLAUDE_MD_END) == 1


# ---------------------------------------------------------------------------
# 8. unpatch_claude_md — removes the block
# ---------------------------------------------------------------------------


def test_unpatch_claude_md_removes_block(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_claude_md()
    install.unpatch_claude_md()

    md_path = home / ".claude" / "CLAUDE.md"
    content = md_path.read_text()
    assert install.CLAUDE_MD_BEGIN not in content
    assert install.CLAUDE_MD_END not in content


# ---------------------------------------------------------------------------
# 9. write_skill — creates SKILL.md under ~/.claude/skills/token-goat/
# ---------------------------------------------------------------------------


def test_write_skill(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.write_skill()
    skill_path = home / ".claude" / "skills" / "token-goat" / "SKILL.md"
    assert skill_path.exists()
    content = skill_path.read_text()
    assert "name: token-goat" in content
    assert "description:" in content


# ---------------------------------------------------------------------------
# 10. remove_skill — deletes the skill directory
# ---------------------------------------------------------------------------


def test_remove_skill(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.write_skill()
    skill_dir = home / ".claude" / "skills" / "token-goat"
    assert skill_dir.exists()

    install.remove_skill()
    assert not skill_dir.exists()


# ---------------------------------------------------------------------------
# 11. install_worker_task — writes HKCU Run key (mocked)
# ---------------------------------------------------------------------------


def test_install_worker_task_correct_args(monkeypatch):
    """install_worker_task uses HKCU Run registry key (not schtasks), verified via mock."""
    written = {}

    class FakeKey:
        pass

    class FakeWinreg:
        HKEY_CURRENT_USER = "HKCU"
        REG_SZ = 1
        KEY_SET_VALUE = 2

        def OpenKey(self, hive, path, reserved, access):  # noqa: N802
            return FakeKey()

        def SetValueEx(self, key, name, reserved, reg_type, value):  # noqa: N802
            written[name] = value

        def CloseKey(self, key):  # noqa: N802
            pass

    fake_winreg = FakeWinreg()

    import sys
    import types
    fake_module = types.ModuleType("winreg")
    fake_module.HKEY_CURRENT_USER = fake_winreg.HKEY_CURRENT_USER
    fake_module.REG_SZ = fake_winreg.REG_SZ
    fake_module.KEY_SET_VALUE = fake_winreg.KEY_SET_VALUE
    fake_module.OpenKey = fake_winreg.OpenKey
    fake_module.SetValueEx = fake_winreg.SetValueEx
    fake_module.CloseKey = fake_winreg.CloseKey

    monkeypatch.setitem(sys.modules, "winreg", fake_module)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")
    monkeypatch.setattr(sys, "platform", "win32")

    ok, out = install.install_worker_task()

    assert ok is True
    assert install.TASK_WORKER in written
    assert "--daemon" in written[install.TASK_WORKER]
    assert "token_goat" in written[install.TASK_WORKER]


def test_registry_is_isolated_in_tests():
    r"""Regression guard: no test may touch the real Windows registry.

    test_install_uninstall_round_trip runs install_all()/uninstall_all(),
    which call winreg.SetValueEx/DeleteValue on HKCU\...\Run directly. With
    winreg unmocked, that wrote — then DELETED — the user's real
    `token-goat-worker` autostart entry on every `pytest` run. The
    isolate_registry autouse fixture swaps in an in-memory fake; this guards
    that it is active so the regression cannot silently return.
    """
    import sys

    winreg = sys.modules.get("winreg")
    assert winreg is not None, "winreg must be stubbed into sys.modules during tests"
    assert type(winreg).__name__ == "_FakeWinreg", (
        f"winreg in tests must be the in-memory fake, got {type(winreg)!r} — "
        "a test could mutate the real registry"
    )
    # It round-trips a write / read / delete entirely in memory.
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Probe", 0, winreg.KEY_SET_VALUE)
    winreg.SetValueEx(key, "probe", 0, winreg.REG_SZ, "v")
    assert winreg.QueryValueEx(key, "probe")[0] == "v"
    winreg.DeleteValue(key, "probe")
    winreg.CloseKey(key)


# ---------------------------------------------------------------------------
# 12. task_exists — reports based on subprocess return code
# ---------------------------------------------------------------------------


def test_task_exists_true(monkeypatch):
    monkeypatch.setattr(install, "_run_schtasks", lambda args: (0, "task found"))
    assert install.task_exists("some-task") is True


def test_task_exists_false(monkeypatch):
    monkeypatch.setattr(install, "_run_schtasks", lambda args: (1, "not found"))
    assert install.task_exists("some-task") is False


# ---------------------------------------------------------------------------
# 13. Full round-trip: install_all + uninstall_all
# ---------------------------------------------------------------------------


def test_install_uninstall_round_trip(tmp_path, monkeypatch, tmp_data_dir):
    """install_all creates files; uninstall_all removes them. Full hermetic round-trip."""
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    bin_dir = home / ".local" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    current_bin = bin_dir / "token-goat.exe"
    current_hook = bin_dir / "token-goat-hook.exe"
    current_worker = bin_dir / "token-goat-worker.exe"
    legacy_bin = bin_dir / "tokenwise.exe"
    legacy_hook = bin_dir / "tokenwise-hook.exe"
    legacy_worker = bin_dir / "tokenwise-worker.exe"
    for path in (current_bin, current_hook, current_worker, legacy_bin, legacy_hook, legacy_worker):
        path.write_text("launcher", encoding="utf-8")

    launcher_paths = {
        "token-goat": current_bin,
        "token-goat-hook": current_hook,
        "token-goat-worker": current_worker,
        "tokenwise": legacy_bin,
        "tokenwise-hook": legacy_hook,
        "tokenwise-worker": legacy_worker,
    }
    monkeypatch.setattr(install.shutil, "which", lambda name: str(launcher_paths[name]) if name in launcher_paths else None)

    # Mock schtasks so no real Windows calls happen
    def fake_schtasks(args):
        if args[0] == "/Query":
            return 1, "not found"
        return 0, "SUCCESS"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks)

    # Mock worker.ensure_running so no real process is spawned
    fake_worker = MagicMock()
    fake_worker.ensure_running.return_value = 12345
    monkeypatch.setattr(install_mod, "paths", install_mod.paths)

    with (
        patch("token_goat.install.paths.ensure_dirs"),
        patch("token_goat.worker.ensure_running", return_value=12345),
    ):
        install_result = install.install_all()

    # settings.json, CLAUDE.md, skill must exist
    settings_path = home / ".claude" / "settings.json"
    md_path = home / ".claude" / "CLAUDE.md"
    skill_path = home / ".claude" / "skills" / "token-goat" / "SKILL.md"

    assert settings_path.exists(), "settings.json not created"
    assert md_path.exists(), "CLAUDE.md not created"
    assert skill_path.exists(), "SKILL.md not created"

    assert "ok" in install_result["settings.json"]
    assert "ok" in install_result["CLAUDE.md"]
    assert "ok" in install_result["skill"]
    assert install_result["legacy launchers"].startswith("removed — ")
    assert not legacy_bin.exists()
    assert not legacy_hook.exists()
    assert not legacy_worker.exists()
    assert current_bin.exists()
    assert current_hook.exists()
    assert current_worker.exists()

    for path in (legacy_bin, legacy_hook, legacy_worker):
        path.write_text("launcher", encoding="utf-8")

    # --- uninstall ---
    def fake_schtasks_with_exists(args):
        if args[0] == "/Query":
            return 0, "found"
        return 0, "DELETED"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks_with_exists)

    with patch("token_goat.install.paths.worker_pid_path", return_value=tmp_path / "worker.pid"):
        uninstall_result = install.uninstall_all(purge=False)

    # token-goat hooks gone from settings.json
    data = json.loads(settings_path.read_text())
    hooks = data.get("hooks", {})
    for _event, entries in hooks.items():
        for entry in entries:
            for h in entry.get("hooks", []):
                assert "token_goat" not in h.get("command", "")

    # CLAUDE.md block gone
    md_content = md_path.read_text()
    assert install.CLAUDE_MD_BEGIN not in md_content

    # Skill dir gone
    assert not skill_path.exists()
    assert uninstall_result["legacy launchers"].startswith("removed — ")
    assert not legacy_bin.exists()
    assert not legacy_hook.exists()
    assert not legacy_worker.exists()


# ---------------------------------------------------------------------------
# Regression: _strip_token_goat_entries deduplicates on re-install
# ---------------------------------------------------------------------------


def test_strip_deduplicates_on_reinstall(tmp_path, monkeypatch):
    """Running patch_settings_json twice must not leave duplicate hook entries."""
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    install.patch_settings_json()
    install.patch_settings_json()

    data = json.loads((home / ".claude" / "settings.json").read_text())
    pre_entries = data["hooks"].get("PreToolUse", [])
    all_commands = [h["command"] for entry in pre_entries for h in entry.get("hooks", [])]
    tg_commands = [c for c in all_commands if "token_goat" in c]

    assert len(tg_commands) == len(set(tg_commands)), (
        f"duplicate token-goat PreToolUse commands after re-install: {tg_commands}"
    )


# ---------------------------------------------------------------------------
# Linux autostart: install_linux_autostart
# ---------------------------------------------------------------------------


def test_install_linux_autostart_windows_skips(monkeypatch):
    """install_linux_autostart returns success-skipped on Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    ok, out = install.install_linux_autostart()
    assert ok is True
    assert "skipped" in out


def test_install_linux_autostart_systemd(tmp_path, monkeypatch):
    """install_linux_autostart writes a systemd unit and calls enable when systemd is available."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(install, "_systemd_user_available", lambda: True)

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        class R:
            returncode = 0
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, out = install.install_linux_autostart()

    assert ok is True
    assert "systemd" in out
    svc_path = install._systemd_service_path()
    assert svc_path.exists()
    content = svc_path.read_text()
    assert "token_goat" in content or "token-goat" in content
    assert "WantedBy=default.target" in content
    # daemon-reload and enable must have been called
    cmds_flat = [" ".join(c) for c in calls]
    assert any("daemon-reload" in c for c in cmds_flat)
    assert any("enable" in c for c in cmds_flat)


def test_install_linux_autostart_xdg_fallback(tmp_path, monkeypatch):
    """install_linux_autostart falls back to XDG autostart when systemd is unavailable."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)

    ok, out = install.install_linux_autostart()

    assert ok is True
    desktop = install._xdg_autostart_path()
    assert desktop.exists()
    content = desktop.read_text()
    assert "[Desktop Entry]" in content
    assert "Exec=" in content


def test_install_linux_autostart_idempotent(tmp_path, monkeypatch):
    """install_linux_autostart can be called twice without error."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)

    install.install_linux_autostart()
    ok, out = install.install_linux_autostart()

    assert ok is True
    assert install._xdg_autostart_path().exists()


def test_uninstall_linux_autostart_removes_files(tmp_path, monkeypatch):
    """uninstall_linux_autostart removes service and desktop files."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)

    install.install_linux_autostart()
    assert install._xdg_autostart_path().exists()

    # systemctl won't be available; suppress that failure path
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **kw: type("R", (), {"returncode": 1})())
    removed = install.uninstall_linux_autostart()

    assert not install._xdg_autostart_path().exists()
    assert any(str(install._xdg_autostart_path()) in r for r in removed)


def test_uninstall_linux_autostart_windows_noop(monkeypatch):
    """uninstall_linux_autostart is a no-op on Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    assert install.uninstall_linux_autostart() == []


# ---------------------------------------------------------------------------
# macOS autostart: install_mac_autostart / uninstall_mac_autostart
# ---------------------------------------------------------------------------


def test_install_mac_autostart_windows_skips(monkeypatch):
    """install_mac_autostart returns success-skipped on Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    ok, out = install.install_mac_autostart()
    assert ok is True
    assert "skipped" in out


def test_install_mac_autostart_writes_plist(tmp_path, monkeypatch):
    """install_mac_autostart writes a valid LaunchAgent plist and calls launchctl."""
    import sys
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    # stub paths.logs_dir() to point into tmp_path
    import token_goat.paths as tg_paths
    monkeypatch.setattr(tg_paths, "logs_dir", lambda: tmp_path / "logs")

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        class R:
            returncode = 0
            stderr = b""
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, out = install.install_mac_autostart()

    assert ok is True
    assert "LaunchAgent" in out
    plist_path = install._launchd_plist_path()
    assert plist_path.exists()
    content = plist_path.read_text()
    assert install.LAUNCHD_PLIST_NAME in content
    assert "RunAtLoad" in content
    assert "token_goat" in content or "token-goat" in content
    # launchctl load must have been called
    cmds_flat = [" ".join(c) for c in calls]
    assert any("launchctl" in c and "load" in c for c in cmds_flat)


def test_install_mac_autostart_idempotent(tmp_path, monkeypatch):
    """install_mac_autostart can be called twice without error."""
    import sys
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    import token_goat.paths as tg_paths
    monkeypatch.setattr(tg_paths, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **kw: type("R", (), {"returncode": 0, "stderr": b""})())

    install.install_mac_autostart()
    ok, out = install.install_mac_autostart()

    assert ok is True
    assert install._launchd_plist_path().exists()


def test_uninstall_mac_autostart_removes_plist(tmp_path, monkeypatch):
    """uninstall_mac_autostart removes the plist and calls launchctl unload."""
    import sys
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    import token_goat.paths as tg_paths
    monkeypatch.setattr(tg_paths, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **kw: type("R", (), {"returncode": 0, "stderr": b""})())

    install.install_mac_autostart()
    plist_path = install._launchd_plist_path()
    assert plist_path.exists()

    removed = install.uninstall_mac_autostart()

    assert not plist_path.exists()
    assert any(str(plist_path) in r for r in removed)


def test_uninstall_mac_autostart_windows_noop(monkeypatch):
    """uninstall_mac_autostart is a no-op on Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    assert install.uninstall_mac_autostart() == []


def test_check_mac_autostart_reports_status(tmp_path, monkeypatch):
    """_check_mac_autostart returns 'not installed' then 'installed' after plist written."""
    import sys
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    assert install._check_mac_autostart() == "not installed"

    import token_goat.paths as tg_paths
    monkeypatch.setattr(tg_paths, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **kw: type("R", (), {"returncode": 0, "stderr": b""})())
    install.install_mac_autostart()

    assert install._check_mac_autostart() == "installed"


# ---------------------------------------------------------------------------
# Linux update cron: install_linux_update_cron
# ---------------------------------------------------------------------------


def test_install_linux_update_cron_windows_skips(monkeypatch):
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    ok, out = install.install_linux_update_cron()
    assert ok is True
    assert "skipped" in out


def test_install_linux_update_cron_adds_entry(monkeypatch):
    """install_linux_update_cron writes a cron entry idempotently."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    written = {}

    def fake_run(cmd, **kwargs):
        cmd_str = " ".join(str(c) for c in cmd)
        class R:
            returncode = 0
            stdout = ""
        if "crontab" in cmd_str and "-l" in cmd_str:
            R.stdout = ""
        if "crontab" in cmd_str and kwargs.get("input"):
            written["crontab"] = kwargs["input"]
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, out = install.install_linux_update_cron()

    assert ok is True
    assert install.CRON_JOB_MARKER in written["crontab"]
    assert "uv tool upgrade token-goat" in written["crontab"]


def test_install_linux_update_cron_deduplicates(monkeypatch):
    """install_linux_update_cron does not add duplicate entries."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    existing_cron = f"0 3 * * 0 uv tool upgrade token-goat {install.CRON_JOB_MARKER}\n"
    written = {}

    def fake_run(cmd, **kwargs):
        cmd_str = " ".join(str(c) for c in cmd)
        class R:
            returncode = 0
            stdout = existing_cron
        if "crontab" in cmd_str and kwargs.get("input"):
            written["crontab"] = kwargs["input"]
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    install.install_linux_update_cron()

    cron_out = written.get("crontab", "")
    assert cron_out.count(install.CRON_JOB_MARKER) == 1


def test_uninstall_linux_update_cron_removes_entry(monkeypatch):
    """uninstall_linux_update_cron strips the marker line from crontab."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    existing = (
        "0 0 * * * /usr/bin/true\n"
        f"0 3 * * 0 uv tool upgrade token-goat {install.CRON_JOB_MARKER}\n"
    )
    written = {}

    def fake_run(cmd, **kwargs):
        cmd_str = " ".join(str(c) for c in cmd)
        class R:
            returncode = 0
            stdout = existing
        if "crontab" in cmd_str and kwargs.get("input"):
            written["crontab"] = kwargs["input"]
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    result = install.uninstall_linux_update_cron()

    assert "removed" in result
    out = written.get("crontab", "")
    assert install.CRON_JOB_MARKER not in out
    assert "/usr/bin/true" in out


# ---------------------------------------------------------------------------
# check_status: platform-appropriate keys
# ---------------------------------------------------------------------------


def test_check_status_windows_keys(monkeypatch):
    """check_status includes Windows-specific keys on win32."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(install, "_check_settings_json", lambda: "ok")
    monkeypatch.setattr(install, "_check_claude_md", lambda: "ok")
    monkeypatch.setattr(install, "_check_skill", lambda: "ok")
    monkeypatch.setattr(install, "_check_worker_task", lambda: "installed")
    monkeypatch.setattr(install, "_check_update_task", lambda: "installed")
    monkeypatch.setattr(install, "_check_codex_config", lambda: "ok")

    status = install.check_status()

    assert "worker autostart (HKCU Run)" in status
    assert "update task (schtasks)" in status
    assert "worker autostart" not in [k for k in status if "HKCU" not in k]


def test_check_status_linux_keys(monkeypatch):
    """check_status includes Linux-specific keys on non-Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "_check_settings_json", lambda: "ok")
    monkeypatch.setattr(install, "_check_claude_md", lambda: "ok")
    monkeypatch.setattr(install, "_check_skill", lambda: "ok")
    monkeypatch.setattr(install, "_check_linux_autostart", lambda: "installed")
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "installed")
    monkeypatch.setattr(install, "_check_codex_config", lambda: "ok")

    status = install.check_status()

    assert "worker autostart" in status
    assert "update cron" in status
    assert "worker autostart (HKCU Run)" not in status
    assert "update task (schtasks)" not in status


# ---------------------------------------------------------------------------
# install_all: Linux dispatches to linux autostart + cron
# ---------------------------------------------------------------------------


def test_install_all_linux_dispatches(tmp_path, monkeypatch):
    """install_all on Linux calls install_linux_autostart and install_linux_update_cron."""
    import sys
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    linux_autostart_calls = []
    linux_cron_calls = []

    monkeypatch.setattr(
        install, "install_linux_autostart",
        lambda: (linux_autostart_calls.append(1), (True, "autostart ok"))[1],
    )
    monkeypatch.setattr(
        install, "install_linux_update_cron",
        lambda: (linux_cron_calls.append(1), (True, "cron ok"))[1],
    )

    with (
        patch("token_goat.install.paths.ensure_dirs"),
        patch("token_goat.worker.ensure_running", return_value=99),
    ):
        result = install.install_all()

    assert linux_autostart_calls, "install_linux_autostart was not called"
    assert linux_cron_calls, "install_linux_update_cron was not called"
    assert "autostart: worker" in result
    assert "cron: update" in result
    assert "task: worker" not in result
    assert "task: update" not in result
