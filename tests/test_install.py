"""Tests for token_goat.install."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import token_goat.install as install_mod
from token_goat import install

# ---------------------------------------------------------------------------
# 1. patch_settings_json — missing file creates valid JSON with our hooks
# ---------------------------------------------------------------------------


def test_patch_settings_json_missing_file(patched_home, monkeypatch):
    home = patched_home
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

    # Check at least one hook command references token_goat (or the persistent
    # wrapper at data_dir/bin/tg-hook.cmd, which is the preferred form when
    # the wrapper file exists on disk).
    ss_hooks = hooks["SessionStart"][0]["hooks"]
    assert any(
        ("token_goat" in h["command"]) or ("tg-hook" in h["command"])
        for h in ss_hooks
    )

    # Permission allowlist
    assert "Bash(token-goat:*)" in data["permissions"]["allow"]


# ---------------------------------------------------------------------------
# 2. patch_settings_json — preserves existing unrelated hooks
# ---------------------------------------------------------------------------


def test_patch_settings_json_preserves_existing_hooks(patched_home, monkeypatch):
    home = patched_home
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
    # Our entries must be present too (either direct pythonw form or wrapper)
    assert any(("token_goat" in c) or ("tg-hook" in c) for c in commands_flat)


# ---------------------------------------------------------------------------
# 3. patch_settings_json — idempotent (running twice produces same result)
# ---------------------------------------------------------------------------


def test_patch_settings_json_idempotent(patched_home, monkeypatch):
    home = patched_home
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
        if ("token_goat" in h["command"]) or ("tg-hook" in h["command"])
    ]
    assert len(cc_commands) == 1, f"expected 1, got {len(cc_commands)}: {cc_commands}"


# ---------------------------------------------------------------------------
# 4. unpatch_settings_json — removes our entries cleanly
# ---------------------------------------------------------------------------


def test_unpatch_settings_json_removes_token_goat(patched_home, monkeypatch):
    home = patched_home
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    install.patch_settings_json()
    install.unpatch_settings_json()

    settings_path = home / ".claude" / "settings.json"
    data = json.loads(settings_path.read_text())
    hooks = data.get("hooks", {})
    for event, entries in hooks.items():
        for entry in entries:
            for h in entry.get("hooks", []):
                command = h.get("command", "")
                assert "token_goat" not in command and "tg-hook" not in command, (
                    f"token-goat found in event {event}: {h}"
                )


# ---------------------------------------------------------------------------
# 5. patch_claude_md — missing file creates file with delimited block
# ---------------------------------------------------------------------------


def test_patch_claude_md_missing_file(patched_home):
    home = patched_home

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


def test_patch_claude_md_appends_to_existing(patched_home):
    home = patched_home

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


def test_patch_claude_md_replaces_existing_block(patched_home):
    home = patched_home

    install.patch_claude_md()
    install.patch_claude_md()

    md_path = home / ".claude" / "CLAUDE.md"
    content = md_path.read_text()
    assert content.count(install.CLAUDE_MD_BEGIN) == 1
    assert content.count(install.CLAUDE_MD_END) == 1


# ---------------------------------------------------------------------------
# 8. unpatch_claude_md — removes the block
# ---------------------------------------------------------------------------


def test_unpatch_claude_md_removes_block(patched_home):
    home = patched_home

    install.patch_claude_md()
    install.unpatch_claude_md()

    md_path = home / ".claude" / "CLAUDE.md"
    content = md_path.read_text()
    assert install.CLAUDE_MD_BEGIN not in content
    assert install.CLAUDE_MD_END not in content


# ---------------------------------------------------------------------------
# 8b. patch_claude_md — strips legacy tokenwise block left over from pre-rename
# ---------------------------------------------------------------------------


def test_patch_claude_md_strips_legacy_tokenwise_block(patched_home):
    """A CLAUDE.md installed under the old ``tokenwise`` binary name still
    contains a ``<!-- tokenwise-begin -->...-end -->`` block describing the
    old routing table. Running the modern installer must strip it so the file
    is left with only the up-to-date ``token-goat`` block, not both.
    """
    home = patched_home

    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    legacy_block = (
        f"{install.LEGACY_CLAUDE_MD_BEGIN}\n"
        "## tokenwise - route code reads through tokenwise first\n\n"
        "| Goal | Do this | Not this |\n"
        "|------|---------|----------|\n"
        "| Find a function | `tokenwise symbol X` | `Grep X` |\n"
        f"{install.LEGACY_CLAUDE_MD_END}\n"
    )
    seed = "# My existing CLAUDE.md\n\nSome prior content.\n\n" + legacy_block
    md_path = claude_dir / "CLAUDE.md"
    md_path.write_text(seed, encoding="utf-8")

    install.patch_claude_md()
    content = md_path.read_text()

    # User content survives.
    assert "My existing CLAUDE.md" in content
    # Modern block landed.
    assert install.CLAUDE_MD_BEGIN in content
    assert install.CLAUDE_MD_END in content
    # Legacy fence is gone, and so is the misleading body.
    assert install.LEGACY_CLAUDE_MD_BEGIN not in content
    assert install.LEGACY_CLAUDE_MD_END not in content
    assert "tokenwise symbol X" not in content


def test_patch_claude_md_legacy_strip_is_idempotent(patched_home):
    """Two consecutive installs leave exactly one modern block, no legacy."""
    home = patched_home

    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    seed = (
        f"{install.LEGACY_CLAUDE_MD_BEGIN}\nlegacy body\n{install.LEGACY_CLAUDE_MD_END}\n"
    )
    md_path = claude_dir / "CLAUDE.md"
    md_path.write_text(seed, encoding="utf-8")

    install.patch_claude_md()
    install.patch_claude_md()
    content = md_path.read_text()

    assert content.count(install.CLAUDE_MD_BEGIN) == 1
    assert content.count(install.CLAUDE_MD_END) == 1
    assert install.LEGACY_CLAUDE_MD_BEGIN not in content
    assert install.LEGACY_CLAUDE_MD_END not in content


# ---------------------------------------------------------------------------
# 9. write_skill — creates SKILL.md under ~/.claude/skills/token-goat/
# ---------------------------------------------------------------------------


def test_write_skill(patched_home):
    home = patched_home

    install.write_skill()
    skill_path = home / ".claude" / "skills" / "token-goat" / "SKILL.md"
    assert skill_path.exists()
    content = skill_path.read_text()
    assert "name: token-goat" in content
    assert "description:" in content


# ---------------------------------------------------------------------------
# 10. remove_skill — deletes the skill directory
# ---------------------------------------------------------------------------


def test_remove_skill(patched_home):
    home = patched_home

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
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

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


def test_install_uninstall_round_trip(patched_home, monkeypatch, tmp_data_dir, tmp_path):
    """install_all creates files; uninstall_all removes them. Full hermetic round-trip."""
    home = patched_home
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


def test_strip_deduplicates_on_reinstall(patched_home, monkeypatch):
    """Running patch_settings_json twice must not leave duplicate hook entries."""
    home = patched_home
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
    # Restart directives must be present
    assert "Restart=on-failure" in content
    assert "RestartSec=5" in content
    assert "StartLimitIntervalSec=60" in content
    assert "StartLimitBurst=3" in content
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
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/" + name)

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
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/" + name)

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
    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/" + name)

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


def test_install_all_linux_dispatches(patched_home, monkeypatch):
    """install_all on Linux calls install_linux_autostart and install_linux_update_cron."""
    import sys
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


# ---------------------------------------------------------------------------
# plan_install — dry-run preview, must not touch disk or registry
# ---------------------------------------------------------------------------


def test_plan_install_makes_no_changes(patched_home, monkeypatch):
    """plan_install() is read-only: no files created, no registry / cron / systemd calls."""
    import sys as _sys

    home = patched_home

    # Force Linux branch so we exercise the systemd/XDG path; that branch makes
    # the most subprocess calls and is the easiest to assert against.
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "not installed")
    monkeypatch.setattr(_sys, "platform", "linux")

    # If plan_install accidentally calls a real mutation, we want a loud crash.
    def _explode(*a, **kw):
        raise AssertionError("plan_install must not call install_* / patch_*")

    monkeypatch.setattr(install, "install_linux_autostart", _explode)
    monkeypatch.setattr(install, "install_linux_update_cron", _explode)
    monkeypatch.setattr(install, "patch_settings_json", _explode)
    monkeypatch.setattr(install, "patch_claude_md", _explode)
    monkeypatch.setattr(install, "write_skill", _explode)

    plan = install.plan_install()

    # Nothing was written to ~/.claude/
    assert not (home / ".claude" / "settings.json").exists()
    assert not (home / ".claude" / "CLAUDE.md").exists()
    assert not (home / ".claude" / "skills" / "token-goat" / "SKILL.md").exists()

    # Plan must mention each core component
    components = {row["component"] for row in plan}
    assert "settings.json" in components
    assert "CLAUDE.md" in components
    assert "skill" in components
    assert "worker autostart" in components


def test_plan_install_picks_systemd_when_available(patched_home, monkeypatch):
    """Linux branch: when systemd --user is up, plan recommends a systemd unit."""
    import sys as _sys

    monkeypatch.setattr(install, "_systemd_user_available", lambda: True)
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "not installed")
    monkeypatch.setattr(_sys, "platform", "linux")

    plan = install.plan_install()
    autostart = next(r for r in plan if r["component"] == "worker autostart")
    assert "systemd" in autostart["detail"].lower()
    assert autostart["target"].endswith("token-goat-worker.service")


def test_plan_install_falls_back_to_xdg_without_systemd(patched_home, monkeypatch):
    """Linux branch: when systemd --user is down, plan recommends the XDG fallback."""
    import sys as _sys

    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "not installed")
    monkeypatch.setattr(_sys, "platform", "linux")

    plan = install.plan_install()
    autostart = next(r for r in plan if r["component"] == "worker autostart")
    assert autostart["target"].endswith(".desktop")
    assert "xdg" in autostart["detail"].lower() or "autostart" in autostart["detail"].lower()


def test_plan_install_detects_existing_settings(patched_home, monkeypatch):
    """When settings.json already has token-goat hooks, plan should report 'update'."""
    import sys as _sys

    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "not installed")
    monkeypatch.setattr(_sys, "platform", "linux")
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    # Pre-populate settings.json with token-goat hooks
    install.patch_settings_json()

    plan = install.plan_install()
    settings_row = next(r for r in plan if r["component"] == "settings.json")
    assert settings_row["action"] == "update"
    assert "existing token-goat hook entries" in settings_row["detail"]


def test_plan_install_optional_codex_only_when_flagged(patched_home, monkeypatch):
    """Codex rows appear only when install_codex=True."""
    import sys as _sys

    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_check_linux_update_cron", lambda: "not installed")
    monkeypatch.setattr(_sys, "platform", "linux")

    plan_off = install.plan_install(install_codex=False)
    plan_on = install.plan_install(install_codex=True)
    components_off = {r["component"] for r in plan_off}
    components_on = {r["component"] for r in plan_on}
    assert "codex: config.toml" not in components_off
    assert "codex: AGENTS.md" not in components_off
    assert "codex: config.toml" in components_on
    assert "codex: AGENTS.md" in components_on


# ---------------------------------------------------------------------------
# verify_install — post-install structured self-check
# ---------------------------------------------------------------------------


def test_verify_install_clean_state_all_missing(patched_home, monkeypatch):
    """On a freshly faked home with nothing installed, every component reports 'missing'."""
    import sys as _sys

    monkeypatch.setattr(_sys, "platform", "linux")

    report = install.verify_install()
    actions_by_component = {r["component"]: r["action"] for r in report}
    assert actions_by_component["settings.json"] == "missing"
    assert actions_by_component["CLAUDE.md"] == "missing"
    assert actions_by_component["skill"] == "missing"
    assert actions_by_component["worker autostart"] == "missing"


def test_verify_install_after_install_reports_ok(patched_home, monkeypatch, tmp_data_dir):
    """After an end-to-end install on Linux+systemd, verify reports ok for landed pieces."""
    import sys as _sys

    monkeypatch.setattr(_sys, "platform", "linux")
    monkeypatch.setattr(install, "_systemd_user_available", lambda: True)
    # Avoid real subprocess calls during systemd setup
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **kw: MagicMock(returncode=0, stdout=b"", stderr=b""))

    # Run only the subset of install steps that produce on-disk artefacts we can verify
    install.patch_settings_json()
    install.patch_claude_md()
    install.write_skill()
    install.install_linux_autostart()

    report = install.verify_install()
    actions_by_component = {r["component"]: r["action"] for r in report}
    assert actions_by_component["settings.json"] == "ok"
    assert actions_by_component["CLAUDE.md"] == "ok"
    assert actions_by_component["skill"] == "ok"
    assert actions_by_component["worker autostart"] == "ok"


def test_verify_install_idempotent_count_stable(patched_home, monkeypatch):
    """patch_settings_json twice → verify_install reports the same hook-entry count.

    Guards against the 'each install doubles the hook entries' bug.
    """
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    install.patch_settings_json()
    count_first = install._settings_json_token_goat_count()
    install.patch_settings_json()
    count_second = install._settings_json_token_goat_count()
    install.patch_settings_json()
    count_third = install._settings_json_token_goat_count()
    assert count_first == count_second == count_third
    assert count_first > 0


def test_verify_install_omits_codex_when_absent(patched_home, monkeypatch):
    """verify_install must not include a codex row when codex was never set up.

    Codex is an opt-in integration; users who never ran `install --codex` should
    not see a noisy 'codex config.toml: missing' line in the verify summary.
    """
    import sys as _sys

    monkeypatch.setattr(_sys, "platform", "linux")
    report = install.verify_install()
    components = {r["component"] for r in report}
    assert "codex config.toml" not in components


def test_verify_install_reports_codex_when_installed(patched_home, monkeypatch):
    """verify_install must surface codex config.toml status when codex IS installed."""
    import sys as _sys

    monkeypatch.setattr(_sys, "platform", "linux")
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    # Install codex side so the file exists.
    install.patch_codex_config("token-goat")

    report = install.verify_install()
    actions_by_component = {r["component"]: r["action"] for r in report}
    assert "codex config.toml" in actions_by_component
    assert actions_by_component["codex config.toml"] == "ok"

    # Detail string should include the count
    details_by_component = {r["component"]: r["detail"] for r in report}
    assert "token-goat hook entries present" in details_by_component["codex config.toml"]


def test_probe_image_codecs_ok_when_all_present(monkeypatch):
    """Every codec present + WebP encode works → ok=True, no hint."""
    import PIL.features as pil_features  # noqa: PLC0415

    monkeypatch.setattr(pil_features, "check", lambda _codec: True)
    report = install.probe_image_codecs()
    assert report["ok"] is True
    assert "WebP=ok" in report["summary"]
    assert "WebP-encode=ok" in report["summary"]
    assert report["missing"] == []
    assert report["hint"] == ""


def test_probe_image_codecs_flags_missing_and_emits_hint(monkeypatch):
    """WebP missing → ok=False, missing list populated, hint references a real installer."""
    import PIL.features as pil_features  # noqa: PLC0415

    monkeypatch.setattr(pil_features, "check", lambda codec: codec != "webp")
    report = install.probe_image_codecs()
    assert report["ok"] is False
    assert "WebP" in report["missing"]
    assert "WebP=MISSING" in report["summary"]
    assert any(tok in report["hint"] for tok in ("apt-get", "dnf", "pacman", "brew", "uv tool install"))


# ---------------------------------------------------------------------------
# Hook wrapper — survives the `uv tool install --reinstall` race window
# where the venv's token_goat site-packages module is briefly absent.
# ---------------------------------------------------------------------------


def test_hook_wrapper_content_short_circuits_when_module_absent(tmp_path, monkeypatch):
    """Wrapper script body must emit ``{"continue":true}`` when the sentinel is gone.

    The wrapper is plain text — we don't execute it here (avoids cmd.exe / sh
    coupling), we just assert that the generated script has both the
    short-circuit (echo + exit 0) and the forwarding call (pythonw -m).
    """
    from token_goat import paths as paths_mod  # noqa: PLC0415

    content = paths_mod.hook_wrapper_content()
    # Both branches present, regardless of platform.
    assert '{"continue":true}' in content
    assert "token_goat.cli" in content
    # Sentinel probe must reference token_goat/__init__.py so the wrapper
    # short-circuits when the venv module is missing.
    assert "token_goat" in content
    assert "__init__.py" in content


def test_hook_wrapper_gate_path_exists_for_current_interpreter():
    """Regression: the wrapper must never gate on a non-existent sentinel.

    The previous implementation probed only ``site-packages/token_goat/__init__.py``.
    For an *editable* install that file does not exist (the package is linked via
    a ``.pth`` into ``src/``), so the generator fell back to a guessed path and
    baked an ``if not exist "<phantom>"`` gate that was permanently true — the
    wrapper echoed ``{"continue":true}`` on every call and never forwarded,
    silently disabling every token-goat hook.

    Invariant: if the generated wrapper contains an existence gate, the gated
    path must exist for the interpreter that generated it.  Otherwise the wrapper
    short-circuits on every invocation.  This fails on the pre-fix code under an
    editable install (the project's own dev/CI layout) and passes once the
    sentinel is resolved via ``importlib.util.find_spec``.
    """
    import re  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from token_goat import paths as paths_mod  # noqa: PLC0415

    content = paths_mod.hook_wrapper_content()
    assert "token_goat.cli" in content  # must always forward

    if sys.platform == "win32":
        match = re.search(r'if not exist "([^"]+)"', content)
    else:
        match = re.search(r'if \[ ! -f "([^"]+)" \]', content)

    if match is not None:
        gated = Path(match.group(1))
        assert gated.exists(), (
            f"wrapper gates on non-existent sentinel {gated!r}; it would "
            'short-circuit every hook to {"continue":true}'
        )
        assert gated.name == "__init__.py"
        assert gated.parent.name == "token_goat"


def test_hook_wrapper_ungated_when_no_sentinel_found(tmp_path, monkeypatch):
    """When no existing ``token_goat/__init__.py`` can be located, the wrapper
    must forward unconditionally rather than gate on a phantom path.

    Regression for the editable-install no-op: gating on a non-existent sentinel
    made the wrapper emit ``{"continue":true}`` on every invocation, disabling
    all hooks.  Here we force *both* the ``find_spec`` origin and the
    site-packages fallbacks to miss, and assert the wrapper has no gate and still
    forwards to ``token_goat.cli``.
    """
    import importlib.util as _ilu  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from token_goat import paths as paths_mod  # noqa: PLC0415

    # Point sys.executable at an empty tmp venv so the site-packages fallbacks miss.
    fake_py = tmp_path / "Scripts" / "python.exe"
    fake_py.parent.mkdir(parents=True)
    fake_py.write_text("", encoding="utf-8")
    monkeypatch.setattr(paths_mod.sys, "executable", str(fake_py))

    # Capture the real find_spec BEFORE patching so the delegation branch can't
    # recurse into the patched name (see the builtins.__import__ patch trap).
    _real_find_spec = _ilu.find_spec

    def _fake_find_spec(name, *args, **kwargs):
        if name == "token_goat":
            return _ilu.spec_from_file_location(
                "token_goat", str(tmp_path / "nope" / "__init__.py")
            )
        return _real_find_spec(name, *args, **kwargs)

    monkeypatch.setattr("importlib.util.find_spec", _fake_find_spec)

    content = paths_mod.hook_wrapper_content()

    assert "token_goat.cli" in content
    assert '{"continue":true}' not in content
    if sys.platform == "win32":
        assert "if not exist" not in content
    else:
        assert "! -f" not in content


def test_is_token_goat_hook_recognises_both_markers():
    """``_is_token_goat_hook`` must match both legacy and wrapper forms."""
    assert install._is_token_goat_hook(
        'C:/path/pythonw.exe -m token_goat.cli hook pre-read'
    )
    assert install._is_token_goat_hook(
        '"C:/Users/x/AppData/Local/dfk-helper/token-goat/bin/tg-hook.cmd" hook pre-read'
    )
    assert not install._is_token_goat_hook("other-tool hook bash")
    assert not install._is_token_goat_hook("")


def test_is_token_goat_hook_excludes_legacy_tokenwise():
    """Current-only predicate must NOT match the pre-rename ``tokenwise`` name.

    This is what makes a config carrying only stale legacy entries report as
    *not installed* (and prompt a re-install) rather than masquerading as
    healthy.  Regression guard: a refactor that folds legacy markers back into
    ``_is_token_goat_hook`` would silently break that status signal.
    """
    assert not install._is_token_goat_hook(
        'C:/path/pythonw.exe -m tokenwise.cli hook pre-read'
    )
    assert not install._is_token_goat_hook("Bash(tokenwise:*)")


def test_is_managed_hook_covers_current_and_legacy():
    """The strip predicate owns current *and* legacy (``tokenwise``) commands.

    Drives the idempotent re-install path: legacy entries must be recognised so
    they are removed rather than left as dead duplicates beside the fresh ones.
    """
    # Current forms — same as _is_token_goat_hook.
    assert install._is_managed_hook('pythonw.exe -m token_goat.cli hook pre-read')
    assert install._is_managed_hook('"...\\bin\\tg-hook.cmd" hook pre-read')
    # Legacy pre-rename form — managed-only.
    assert install._is_managed_hook('pythonw.exe -m tokenwise.cli hook pre-read')
    # Unrelated / empty — neither.
    assert not install._is_managed_hook("other-tool hook bash")
    assert not install._is_managed_hook("")


def test_patch_settings_json_strips_legacy_tokenwise_hooks(patched_home, monkeypatch):
    """Re-install must purge orphaned ``tokenwise`` hook + permission cruft.

    Regression for the rename leftover bug: install merged fresh token-goat
    entries but never removed the pre-rename ``tokenwise`` ones, leaving dead
    duplicates in settings.json.
    """
    home = patched_home
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    existing = {
        "hooks": {
            "PostToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "pythonw.exe -m tokenwise.cli hook post-edit",
                            "timeout": 1000,
                        }
                    ],
                }
            ]
        },
        "permissions": {"allow": ["Bash(tokenwise:*)", "Bash(git:*)"]},
    }
    (claude_dir / "settings.json").write_text(json.dumps(existing), encoding="utf-8")

    ok, _ = install.patch_settings_json()
    assert ok is True

    data = json.loads((claude_dir / "settings.json").read_text())
    commands_flat = [
        h["command"]
        for entry in data["hooks"].get("PostToolUse", [])
        for h in entry.get("hooks", [])
    ]
    # Stale legacy hook command is gone.
    assert not any("tokenwise" in c for c in commands_flat)
    # Fresh token-goat hooks are present.
    assert any(("token_goat" in c) or ("tg-hook" in c) for c in commands_flat)

    allowed = data["permissions"]["allow"]
    # Legacy permission dropped, current present exactly once, unrelated kept.
    assert "Bash(tokenwise:*)" not in allowed
    assert allowed.count("Bash(token-goat:*)") == 1
    assert "Bash(git:*)" in allowed


def test_patch_codex_config_strips_legacy_tokenwise_hooks(patched_home, monkeypatch):
    """Codex re-install must purge orphaned ``tokenwise`` hook entries too."""
    import tomllib  # noqa: PLC0415

    home = patched_home
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    existing = (
        "[[hooks.PostToolUse]]\n"
        'matcher = "Bash"\n'
        "[[hooks.PostToolUse.hooks]]\n"
        'type = "command"\n'
        'command = "tokenwise hook post-edit"\n'
    )
    (codex_dir / "config.toml").write_text(existing, encoding="utf-8")

    install.patch_codex_config("token-goat")

    data = tomllib.loads((codex_dir / "config.toml").read_text(encoding="utf-8"))
    commands_flat = [
        h.get("command", "")
        for entry in data.get("hooks", {}).get("PostToolUse", [])
        for h in entry.get("hooks", [])
    ]
    assert commands_flat, "expected token-goat hook entries after patch"
    assert not any("tokenwise" in c for c in commands_flat)
    # Assert on the stable hook markers, not the literal "token-goat" binary/path string: the Codex command is "<interpreter> -m token_goat.cli hook <name> --harness codex", whose only reliable token-goat substring is the module name "token_goat". A bare "token-goat" check passes on Windows only by accident (the uv-tool interpreter path contains the hyphenated project name) and fails on the WSL runner whose venv lives at /tmp/tg-linux-venv. Mirrors the settings.json strip test above.
    assert any(("token_goat" in c) or ("tg-hook" in c) for c in commands_flat)


def test_write_hook_wrapper_byte_faithful_no_crlf_doubling(tmp_data_dir):
    """On-disk wrapper must equal ``hook_wrapper_content()`` byte-for-byte.

    Regression: the wrapper bakes platform-correct line endings (CRLF on
    Windows) into its content string, then was written through a text-mode
    handle that *also* translated ``\\n`` -> ``\\r\\n`` on Windows, doubling
    every CR to ``\\r\\r\\n``. cmd.exe tolerated the stray CR so forwarding still
    worked, but ``token-goat doctor`` compared on-disk vs regenerated content and
    warned "differs from expected" forever, telling the user to reinstall (which
    never fixed it). Writing as bytes preserves the hand-authored endings.
    """
    from token_goat import paths  # noqa: PLC0415

    wrapper_path = install._write_hook_wrapper()
    on_disk = wrapper_path.read_bytes().decode("utf-8")
    # Same process, same find_spec -> the two must be byte-identical.
    assert on_disk == paths.hook_wrapper_content()
    # No doubled carriage returns leaked through, on any platform.
    assert "\r\r\n" not in on_disk


def test_hook_runner_command_prefers_wrapper_when_present(tmp_path, monkeypatch):
    """``_hook_runner_command`` returns the wrapper path when the file exists."""
    from token_goat import paths as paths_mod  # noqa: PLC0415

    fake_wrapper = tmp_path / "bin" / "tg-hook.cmd"
    fake_wrapper.parent.mkdir(parents=True)
    fake_wrapper.write_text("@echo off\r\n", encoding="utf-8")
    monkeypatch.setattr(paths_mod, "hook_wrapper_path", lambda: fake_wrapper)

    cmd = install._hook_runner_command("hook", "session-start")
    assert "tg-hook" in cmd
    assert "session-start" in cmd
    # token_goat.cli must NOT appear — the wrapper hides it.
    assert "token_goat.cli" not in cmd


def test_hook_runner_command_falls_back_when_wrapper_missing(tmp_path, monkeypatch):
    """When the wrapper file is absent, fall back to the direct pythonw form."""
    from token_goat import paths as paths_mod  # noqa: PLC0415

    monkeypatch.setattr(paths_mod, "hook_wrapper_path", lambda: tmp_path / "nope.cmd")

    cmd = install._hook_runner_command("hook", "session-start")
    assert "token_goat.cli" in cmd
    assert "session-start" in cmd


def test_write_hook_wrapper_creates_file_with_expected_content(tmp_path, monkeypatch):
    """``_write_hook_wrapper`` writes a non-empty wrapper script to the data dir."""
    from token_goat import paths as paths_mod  # noqa: PLC0415

    target = tmp_path / "bin" / "tg-hook.cmd"
    monkeypatch.setattr(paths_mod, "hook_wrapper_path", lambda: target)

    written = install._write_hook_wrapper()
    assert written == target
    assert target.exists()
    body = target.read_text(encoding="utf-8")
    assert '{"continue":true}' in body
    assert "token_goat.cli" in body


# ---------------------------------------------------------------------------
# Hook-registration alignment — every event in settings.json must have a
# matching @hook_app.command decorator, or BLOCKING hook events
# (UserPromptSubmit, PostToolUse:Skill) abort the user's operation.
# ---------------------------------------------------------------------------


def test_hooks_block_events_have_typer_subcommands_registered():
    """Every event in ``_hooks_block`` must be a registered ``hook_app`` subcommand.

    Recurring bug class: new hook events get added to ``_hooks_block`` (which
    writes settings.json) and the ``_LAZY_HOOK_HANDLERS`` proxy table in
    ``hooks_cli.py`` without the matching ``@hook_app.command`` decorator in
    ``cli.py``.  Settings.json fires the hook, typer exits 2 with "No such
    command", and Claude Code BLOCKS the operation for events where nonzero
    is treated as blocking (UserPromptSubmit, PostToolUse:Skill, etc.).

    Two prior incidents:
      - user-prompt-submit + subagent-stop (fixed in e53d553)
      - post-skill (fixed in the same series)
    """
    from token_goat.cli import hook_app  # noqa: PLC0415

    # All subcommand names registered with hook_app (typer auto-derives hyphens
    # from underscores in function names; we use the explicit name when given).
    registered: set[str] = set()
    for info in hook_app.registered_commands:
        name = info.name or (info.callback.__name__.replace("_", "-") if info.callback else "")
        if name:
            registered.add(name)

    # Extract all event names from the commands _hooks_block produces.
    block = install._hooks_block()
    referenced: set[str] = set()
    for entries in block.values():
        for entry in entries:
            for h in entry.get("hooks", []):
                cmd = h.get("command", "")
                # Forms we need to parse:
                #   "C:/.../pythonw.exe" -m token_goat.cli hook session-start
                #   "C:/.../tg-hook.cmd" hook session-start
                # Find the literal token "hook" and take the next whitespace-
                # separated arg as the event name.
                parts = cmd.split()
                for i, p in enumerate(parts):
                    if p == "hook" and i + 1 < len(parts):
                        ev = parts[i + 1].strip('"').strip("'")
                        referenced.add(ev)
                        break

    missing = referenced - registered
    assert not missing, (
        f"Hook event(s) referenced in _hooks_block but NOT registered as "
        f"@hook_app.command in cli.py: {sorted(missing)}. "
        f"Add `@hook_app.command(\"<name>\", context_settings=_HOOK_CTX)` "
        f"decorators in cli.py. Settings.json fires these hooks but typer "
        f"will exit 2 with 'No such command' — BLOCKING for "
        f"UserPromptSubmit / PostToolUse:Skill / etc."
    )


def test_hook_registry_alignment_across_all_tables():
    """Every event in ``hook_registry.HOOK_EVENTS`` must appear in all 5 coupled tables.

    The hook_registry consolidation (audit-2026-05-24) made HOOK_EVENTS the
    single source of truth, but five tables still derive from it (or, in the
    case of ``@hook_app.command`` decorators, must stay in sync with it).
    This test verifies all five stay aligned:

      1. ``install._hooks_block()`` — Claude settings.json
      2. ``install._codex_hooks_block()`` — Codex config.toml (codex-only subset)
      3. ``hooks_cli._HANDLER_LOOKUP`` — dispatcher
      4. ``hooks_cli.__getattr__::event_map`` (lazy attr export)
      5. ``@hook_app.command`` decorators in cli.py
    """
    from token_goat import hook_registry, hooks_cli  # noqa: PLC0415
    from token_goat.cli import hook_app  # noqa: PLC0415

    registry_events = set(hook_registry.all_events())
    registry_claude = {e.name for e in hook_registry.claude_events()}
    registry_codex = {e.name for e in hook_registry.codex_events()}

    # --- Table 1: _hooks_block (Claude wire format) ---
    claude_block = install._hooks_block()
    claude_in_block: set[str] = set()
    for entries in claude_block.values():
        for entry in entries:
            for h in entry.get("hooks", []):
                parts = h.get("command", "").split()
                for i, p in enumerate(parts):
                    if p == "hook" and i + 1 < len(parts):
                        claude_in_block.add(parts[i + 1].strip("\"'"))
                        break
    assert claude_in_block == registry_claude, (
        f"_hooks_block events {sorted(claude_in_block)} differ from "
        f"registry.claude_events {sorted(registry_claude)}"
    )

    # --- Table 2: _codex_hooks_block (Codex wire format) ---
    codex_block = install._codex_hooks_block()
    codex_in_block: set[str] = set()
    for entries in codex_block.values():
        for entry in entries:
            for h in entry.get("hooks", []):
                parts = h.get("command", "").split()
                for i, p in enumerate(parts):
                    if p == "hook" and i + 1 < len(parts):
                        codex_in_block.add(parts[i + 1].strip("\"'"))
                        break
    assert codex_in_block == registry_codex, (
        f"_codex_hooks_block events {sorted(codex_in_block)} differ from "
        f"registry.codex_events {sorted(registry_codex)}"
    )

    # --- Table 3: _HANDLER_LOOKUP (dispatcher) ---
    # Excludes pre-compact whose handler lives in hooks_cli itself.
    handler_keys = set(hooks_cli._HANDLER_LOOKUP.keys())
    expected_handler_keys = registry_events - {"pre-compact"}
    assert handler_keys == expected_handler_keys, (
        f"hooks_cli._HANDLER_LOOKUP keys {sorted(handler_keys)} differ from "
        f"registry events (excluding pre-compact) {sorted(expected_handler_keys)}"
    )

    # --- Table 4: __getattr__ event_map (lazy attr export) ---
    lazy_map = hook_registry.lazy_attr_map()
    # Verify every event with a submodule handler is exported by name.
    for ev in hook_registry.HOOK_EVENTS:
        if ev.module == "hooks_cli":
            continue  # pre-compact: already a module attr, no lazy export needed
        assert ev.typer_func in lazy_map, (
            f"event {ev.name!r} not in __getattr__ event_map; "
            f"typer_func {ev.typer_func!r} is missing"
        )
        # Verify the lazy export actually resolves (forces the import path).
        resolved = getattr(hooks_cli, ev.typer_func, None)
        assert resolved is not None, (
            f"hooks_cli.{ev.typer_func} did not resolve via __getattr__; "
            f"check that {ev.module}.{ev.attr} exists"
        )

    # --- Table 5: @hook_app.command decorators in cli.py ---
    registered: set[str] = set()
    for info in hook_app.registered_commands:
        if info.name:
            registered.add(info.name)
        elif info.callback is not None:
            registered.add(info.callback.__name__.replace("_", "-"))
    assert registry_events <= registered, (
        f"Events in hook_registry but missing @hook_app.command in cli.py: "
        f"{sorted(registry_events - registered)}"
    )


def test_hook_registry_codex_subset_of_claude():
    """Every Codex event must also have a definition in the registry.

    Codex events are a *subset* of Claude events (Codex has no Skill tool,
    no UserPromptSubmit equivalent, etc.).  Ensure no codex_event refers to a
    name that isn't a registry event at all.
    """
    from token_goat import hook_registry  # noqa: PLC0415

    claude_events = {e.name for e in hook_registry.claude_events()}
    codex_events = {e.name for e in hook_registry.codex_events()}
    assert codex_events <= claude_events, (
        f"Codex events {sorted(codex_events - claude_events)} not declared as "
        f"Claude events; registry inconsistent."
    )


def test_hook_registry_startup_assertion_catches_drift():
    """Simulating a missing typer subcommand must raise ImportError.

    The startup assertion in cli.py runs once at import time.  Verify the
    same check rejects an obviously-broken state — gives us a fast failure
    if the package is ever imported with a missing decorator.
    """
    import pytest  # noqa: PLC0415

    from token_goat import hook_registry  # noqa: PLC0415

    # Empty registered set must trigger ImportError naming the missing events.
    with pytest.raises(ImportError, match="hook_registry drift"):
        hook_registry.assert_typer_subcommands_aligned(set())

    # Subset that drops just one event must also raise, naming that event.
    all_evts = set(hook_registry.all_events())
    one_missing = all_evts - {"post-skill"}
    with pytest.raises(ImportError, match="post-skill"):
        hook_registry.assert_typer_subcommands_aligned(one_missing)


# ---------------------------------------------------------------------------
# install_linux_update_cron: crontab availability check
# ---------------------------------------------------------------------------


def test_install_linux_update_cron_skips_when_crontab_not_found(monkeypatch):
    """install_linux_update_cron returns a clear message when crontab is absent."""
    import sys  # noqa: PLC0415
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(install.shutil, 'which', lambda name: None if name == 'crontab' else '/usr/bin/' + name)

    ok, msg = install.install_linux_update_cron()

    assert ok is False
    assert 'not available' in msg
    assert 'PATH' in msg


def test_uninstall_linux_update_cron_skips_when_crontab_not_found(monkeypatch):
    """uninstall_linux_update_cron returns a clear message when crontab is absent."""
    import sys  # noqa: PLC0415
    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(install.shutil, 'which', lambda name: None if name == 'crontab' else '/usr/bin/' + name)

    result = install.uninstall_linux_update_cron()

    assert 'not available' in result
    assert 'PATH' in result


# ---------------------------------------------------------------------------
# Linux/macOS autostart: content and reliability improvements
# ---------------------------------------------------------------------------


def test_install_linux_autostart_systemd_message_includes_start_hint(monkeypatch, tmp_path):
    """After systemd install the return message tells the user how to start immediately."""
    import sys

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "_systemd_user_available", lambda: True)
    monkeypatch.setattr(install, "_systemd_user_dir", lambda: tmp_path)
    monkeypatch.setattr(install, "_systemd_service_path", lambda: tmp_path / "token-goat-worker.service")
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *args: ["/usr/bin/python3", "-m", "token_goat.cli", *args],
    )

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, msg = install.install_linux_autostart()

    assert ok is True
    assert "systemctl" in msg
    assert "--user start" in msg
    assert install.SYSTEMD_SERVICE_NAME in msg


def test_install_linux_autostart_systemd_service_has_restart_directives(monkeypatch, tmp_path):
    """Systemd service file includes Restart=on-failure and RestartSec=5."""
    import sys

    svc_path = tmp_path / "token-goat-worker.service"
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "_systemd_user_available", lambda: True)
    monkeypatch.setattr(install, "_systemd_user_dir", lambda: tmp_path)
    monkeypatch.setattr(install, "_systemd_service_path", lambda: svc_path)
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *args: ["/usr/bin/python3", "-m", "token_goat.cli", *args],
    )

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    install.install_linux_autostart()

    content = svc_path.read_text()
    assert "Restart=on-failure" in content
    assert "RestartSec=5" in content


def test_install_linux_autostart_xdg_desktop_has_version(monkeypatch, tmp_path):
    """XDG .desktop file includes Version=1.0 per the Desktop Entry spec."""
    import sys

    desktop_path = tmp_path / "token-goat-worker.desktop"
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_xdg_autostart_path", lambda: desktop_path)
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *args: ["/usr/bin/python3", "-m", "token_goat.cli", *args],
    )

    ok, msg = install.install_linux_autostart()

    assert ok is True
    content = desktop_path.read_text()
    assert "Version=1.0" in content
    assert "X-GNOME-Autostart-enabled=true" in content


def test_install_mac_autostart_keepalive_restarts_on_failure(monkeypatch, tmp_path):
    """macOS LaunchAgent plist uses KeepAlive dict with SuccessfulExit=false (restart on crash)."""
    import sys

    plist_path = tmp_path / "com.dfkhelper.token-goat-worker.plist"
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(install, "_launchd_plist_path", lambda: plist_path)
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(install.paths, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *args: ["/usr/bin/python3", "-m", "token_goat.cli", *args],
    )

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, msg = install.install_mac_autostart()

    assert ok is True
    content = plist_path.read_text()
    # KeepAlive must NOT be a bare <false/> — it should be a dict
    # with SuccessfulExit=false so launchd restarts on crash but not clean exit.
    assert "<key>KeepAlive</key>" in content
    assert "<dict>" in content
    assert "<key>SuccessfulExit</key>" in content
    assert "RunAtLoad" in content
    # Ensure the bare <false/> for KeepAlive is gone
    keepalive_idx = content.index("<key>KeepAlive</key>")
    keepalive_block = content[keepalive_idx:keepalive_idx + 120]
    assert "<false/>" not in keepalive_block or "<dict>" in keepalive_block


def test_install_mac_autostart_message_includes_confirm_hint(monkeypatch, tmp_path):
    """After macOS LaunchAgent install the return message includes a confirmation command."""
    import sys

    plist_path = tmp_path / "com.dfkhelper.token-goat-worker.plist"
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(install, "_launchd_plist_path", lambda: plist_path)
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(install.paths, "logs_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *args: ["/usr/bin/python3", "-m", "token_goat.cli", *args],
    )

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""
        return R()

    monkeypatch.setattr(install.subprocess, "run", fake_run)

    ok, msg = install.install_mac_autostart()

    assert ok is True
    assert "launchctl" in msg
    assert install.LAUNCHD_PLIST_NAME in msg


# ---------------------------------------------------------------------------
# _extract_interpreter_from_command: helper tests
# ---------------------------------------------------------------------------


def test_extract_interpreter_quoted():
    """_extract_interpreter_from_command handles a quoted path at the start."""
    cmd = '"C:/Users/zelys/.venv/Scripts/pythonw.exe" -m token_goat.cli worker --daemon'
    result = install._extract_interpreter_from_command(cmd)
    assert result == "C:/Users/zelys/.venv/Scripts/pythonw.exe"


def test_extract_interpreter_unquoted():
    """_extract_interpreter_from_command handles an unquoted path."""
    cmd = "/usr/bin/python3 -m token_goat.cli worker --daemon"
    result = install._extract_interpreter_from_command(cmd)
    assert result == "/usr/bin/python3"


def test_extract_interpreter_empty():
    """_extract_interpreter_from_command returns None for an empty string."""
    assert install._extract_interpreter_from_command("") is None
    assert install._extract_interpreter_from_command("   ") is None


# ---------------------------------------------------------------------------
# _read_win_autostart_command: reads HKCU Run value
# ---------------------------------------------------------------------------


def test_read_win_autostart_command_present(monkeypatch):
    """_read_win_autostart_command returns the registry value when set."""
    import sys
    import types

    stored_cmd = '"C:/venv/pythonw.exe" -m token_goat.cli worker --daemon'

    fake_reg = types.ModuleType("winreg")
    fake_reg.HKEY_CURRENT_USER = "HKCU"
    fake_reg.KEY_READ = 0x20019

    class _Key:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    fake_reg.OpenKey = lambda hive, path, res, acc: _Key()
    fake_reg.QueryValueEx = lambda key, name: (stored_cmd, 1)

    monkeypatch.setitem(sys.modules, "winreg", fake_reg)
    monkeypatch.setattr(sys, "platform", "win32")

    result = install._read_win_autostart_command()
    assert result == stored_cmd


def test_read_win_autostart_command_absent(monkeypatch):
    """_read_win_autostart_command returns None when the value does not exist."""
    import sys
    import types

    fake_reg = types.ModuleType("winreg")
    fake_reg.HKEY_CURRENT_USER = "HKCU"
    fake_reg.KEY_READ = 0x20019

    class _Key:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    fake_reg.OpenKey = lambda hive, path, res, acc: _Key()
    def _raise(*a):
        raise FileNotFoundError
    fake_reg.QueryValueEx = _raise

    monkeypatch.setitem(sys.modules, "winreg", fake_reg)
    monkeypatch.setattr(sys, "platform", "win32")

    result = install._read_win_autostart_command()
    assert result is None


def test_read_win_autostart_command_non_windows(monkeypatch):
    """_read_win_autostart_command returns None on non-Windows."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    result = install._read_win_autostart_command()
    assert result is None


# ---------------------------------------------------------------------------
# _read_linux_autostart_command: reads from systemd service or XDG desktop
# ---------------------------------------------------------------------------


def test_read_linux_autostart_command_systemd(tmp_path, monkeypatch):
    """_read_linux_autostart_command reads ExecStart from systemd service file."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    svc = tmp_path / "token-goat-worker.service"
    svc.write_text(
        "[Unit]\nDescription=test\n\n[Service]\n"
        "ExecStart=/usr/bin/python3 -m token_goat.cli worker --daemon\n\n"
        "[Install]\nWantedBy=default.target\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(install, "_systemd_service_path", lambda: svc)
    monkeypatch.setattr(install, "_xdg_autostart_path", lambda: tmp_path / "no.desktop")

    result = install._read_linux_autostart_command()
    assert result == "/usr/bin/python3 -m token_goat.cli worker --daemon"


def test_read_linux_autostart_command_xdg(tmp_path, monkeypatch):
    """_read_linux_autostart_command falls back to XDG Exec= when no systemd file."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    desktop = tmp_path / "token-goat-worker.desktop"
    desktop.write_text(
        "[Desktop Entry]\nVersion=1.0\nType=Application\n"
        "Exec=/home/user/venv/bin/python3 -m token_goat.cli worker --daemon\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(install, "_systemd_service_path", lambda: tmp_path / "no.service")
    monkeypatch.setattr(install, "_xdg_autostart_path", lambda: desktop)

    result = install._read_linux_autostart_command()
    assert result == "/home/user/venv/bin/python3 -m token_goat.cli worker --daemon"


def test_read_linux_autostart_command_none(tmp_path, monkeypatch):
    """_read_linux_autostart_command returns None when neither file exists."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(install, "_systemd_service_path", lambda: tmp_path / "no.service")
    monkeypatch.setattr(install, "_xdg_autostart_path", lambda: tmp_path / "no.desktop")

    result = install._read_linux_autostart_command()
    assert result is None


# ---------------------------------------------------------------------------
# check_autostart: high-level status dict
# ---------------------------------------------------------------------------


def test_check_autostart_windows_match(monkeypatch):
    """check_autostart returns YES when registered interpreter matches current."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")

    current = "C:/venv/Scripts/pythonw.exe"
    monkeypatch.setattr(sys, "executable", current)

    cmd = f'"{current}" -m token_goat.cli worker --daemon'
    monkeypatch.setattr(install, "_read_win_autostart_command", lambda: cmd)

    info = install.check_autostart()
    assert info["status"] == "registered"
    assert info["match"] == "YES"
    assert info["registered_interp"] == current
    assert info["current_interp"] == current


def test_check_autostart_windows_mismatch(monkeypatch):
    """check_autostart returns NO when registered interpreter differs from current."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")

    old_interp = "C:/Python312/pythonw.exe"
    new_interp = "C:/venv/Scripts/pythonw.exe"
    monkeypatch.setattr(sys, "executable", new_interp)

    cmd = f'"{old_interp}" -m token_goat.cli worker --daemon'
    monkeypatch.setattr(install, "_read_win_autostart_command", lambda: cmd)

    info = install.check_autostart()
    assert info["status"] == "registered"
    assert info["match"] == "NO"
    assert info["registered_interp"] == old_interp
    assert info["current_interp"] == new_interp


def test_check_autostart_not_registered(monkeypatch):
    """check_autostart returns 'not registered' when no entry exists."""
    import sys
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(install, "_read_win_autostart_command", lambda: None)

    info = install.check_autostart()
    assert info["status"] == "not registered"
    assert info["match"] == "UNKNOWN"
    assert info["registered_interp"] is None


def test_check_autostart_linux_match(monkeypatch):
    """check_autostart returns YES on Linux when interpreters match."""
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    current = "/home/user/.venv/bin/python3"
    monkeypatch.setattr(sys, "executable", current)
    cmd = f"{current} -m token_goat.cli worker --daemon"
    monkeypatch.setattr(install, "_read_linux_autostart_command", lambda: cmd)

    info = install.check_autostart()
    assert info["status"] == "registered"
    assert info["match"] == "YES"


# ---------------------------------------------------------------------------
# install_worker_task: logs WARNING when replacing a different interpreter
# ---------------------------------------------------------------------------


def test_install_worker_task_warns_on_interpreter_change(monkeypatch, caplog):
    """install_worker_task logs a WARNING when an existing entry uses a different interpreter."""
    import logging
    import sys
    monkeypatch.setattr(sys, "platform", "win32")

    old_cmd = '"C:/Python312/pythonw.exe" -m token_goat.cli worker --daemon'
    monkeypatch.setattr(install, "_read_win_autostart_command", lambda: old_cmd)
    monkeypatch.setattr(
        install.paths, "python_runner_command",
        lambda *a: '"C:/venv/Scripts/pythonw.exe" -m token_goat.cli worker --daemon',
    )

    with caplog.at_level(logging.WARNING, logger="token_goat.install"):
        install.install_worker_task()

    assert any(
        "replacing existing autostart entry" in r.message
        and "C:/Python312/pythonw.exe" in r.message
        for r in caplog.records
    )


def test_install_worker_task_no_warn_same_interpreter(monkeypatch, caplog):
    """install_worker_task does NOT warn when the same interpreter is already registered."""
    import logging
    import sys
    monkeypatch.setattr(sys, "platform", "win32")

    same_interp = "C:/venv/Scripts/pythonw.exe"
    same_cmd = f'"{same_interp}" -m token_goat.cli worker --daemon'
    monkeypatch.setattr(install, "_read_win_autostart_command", lambda: same_cmd)
    monkeypatch.setattr(
        install.paths, "python_runner_command",
        lambda *a: same_cmd,
    )

    with caplog.at_level(logging.WARNING, logger="token_goat.install"):
        install.install_worker_task()

    assert not any("replacing existing autostart entry" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# install_linux_autostart: logs WARNING when replacing a different interpreter
# ---------------------------------------------------------------------------


def test_install_linux_autostart_warns_on_interpreter_change(tmp_path, monkeypatch, caplog):
    """install_linux_autostart logs WARNING when replacing an entry with a different interpreter."""
    import logging
    import sys
    monkeypatch.setattr(sys, "platform", "linux")

    old_interp = "/home/user/old-venv/bin/python3"
    old_cmd = f"{old_interp} -m token_goat.cli worker --daemon"
    monkeypatch.setattr(install, "_read_linux_autostart_command", lambda: old_cmd)
    monkeypatch.setattr(sys, "executable", "/home/user/new-venv/bin/python3")

    # Provide XDG path and stub out systemd as unavailable
    desktop = tmp_path / "token-goat-worker.desktop"
    monkeypatch.setattr(install, "_systemd_user_available", lambda: False)
    monkeypatch.setattr(install, "_xdg_autostart_path", lambda: desktop)
    monkeypatch.setattr(install.paths, "ensure_dir", lambda p: None)
    monkeypatch.setattr(
        install.paths, "python_runner_argv",
        lambda *a: ["/home/user/new-venv/bin/python3", "-m", "token_goat.cli", *a],
    )

    with caplog.at_level(logging.WARNING, logger="token_goat.install"):
        ok, _ = install.install_linux_autostart()

    assert ok is True
    assert any(
        "replacing existing autostart entry" in r.message
        and old_interp in r.message
        for r in caplog.records
    )
