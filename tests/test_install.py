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

    # --- uninstall ---
    def fake_schtasks_with_exists(args):
        if args[0] == "/Query":
            return 0, "found"
        return 0, "DELETED"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks_with_exists)

    with patch("token_goat.install.paths.worker_pid_path", return_value=tmp_path / "worker.pid"):
        install.uninstall_all(purge=False)

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
