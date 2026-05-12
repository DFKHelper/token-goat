"""Tests for Codex install/uninstall — Phase 18."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tokenwise import install

# ---------------------------------------------------------------------------
# Helpers (mirrors test_install.py pattern)
# ---------------------------------------------------------------------------


def _fake_home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    return home


def _patch_home(monkeypatch, home: Path) -> None:
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))


# ---------------------------------------------------------------------------
# 1. patch_codex_config on missing file → creates valid TOML with our hooks
# ---------------------------------------------------------------------------


def test_patch_codex_config_creates_file(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    cfg_path = install.patch_codex_config("tokenwise")

    p = Path(cfg_path)
    assert p.exists()
    content = p.read_text(encoding="utf-8")
    assert "tokenwise" in content
    assert "SessionStart" in content or "session-start" in content


# ---------------------------------------------------------------------------
# 2. patch_codex_config on existing config with other hooks → preserves them
# ---------------------------------------------------------------------------


def test_patch_codex_config_preserves_existing(tmp_path, monkeypatch):
    import tomli_w

    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    # Write an existing config with an unrelated hook
    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    existing = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "other-tool hook bash", "timeout": 1000}
                    ],
                }
            ]
        }
    }
    (codex_dir / "config.toml").write_text(tomli_w.dumps(existing), encoding="utf-8")

    install.patch_codex_config("tokenwise")

    import tomllib

    content = tomllib.loads((codex_dir / "config.toml").read_text(encoding="utf-8"))
    pre_entries = content["hooks"]["PreToolUse"]
    all_commands = [h["command"] for e in pre_entries for h in e.get("hooks", [])]
    assert any("other-tool" in c for c in all_commands), "existing hook was lost"
    assert any("tokenwise" in c for c in all_commands), "tokenwise hook not added"


# ---------------------------------------------------------------------------
# 3. patch_codex_config is idempotent
# ---------------------------------------------------------------------------


def test_patch_codex_config_idempotent(tmp_path, monkeypatch):
    import tomllib

    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_codex_config("tokenwise")
    install.patch_codex_config("tokenwise")

    cfg_path = home / ".codex" / "config.toml"
    content = tomllib.loads(cfg_path.read_text(encoding="utf-8"))

    # SessionStart should have exactly ONE tokenwise entry
    ss_entries = content["hooks"].get("SessionStart", [])
    tw_cmds = [
        h["command"]
        for e in ss_entries
        for h in e.get("hooks", [])
        if "tokenwise" in h["command"]
    ]
    assert len(tw_cmds) == 1, f"expected 1 tokenwise SessionStart entry, got {len(tw_cmds)}"


# ---------------------------------------------------------------------------
# 4. unpatch_codex_config removes only tokenwise entries
# ---------------------------------------------------------------------------


def test_unpatch_codex_config_removes_tokenwise(tmp_path, monkeypatch):
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    # Pre-install a config with both tokenwise and an unrelated hook
    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    existing = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "other-tool hook bash", "timeout": 1000}
                    ],
                }
            ]
        }
    }
    (codex_dir / "config.toml").write_text(tomli_w.dumps(existing), encoding="utf-8")

    install.patch_codex_config("tokenwise")
    install.unpatch_codex_config()

    content = tomllib.loads((codex_dir / "config.toml").read_text(encoding="utf-8"))
    all_cmds = [
        h["command"]
        for entries in content.get("hooks", {}).values()
        for e in entries
        for h in e.get("hooks", [])
    ]
    assert not any("tokenwise" in c for c in all_cmds), "tokenwise entry not removed"
    assert any("other-tool" in c for c in all_cmds), "unrelated entry was removed"


# ---------------------------------------------------------------------------
# 5. patch_codex_agents_md creates the file with delimited block
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_creates_file(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    assert md_path.exists()
    content = md_path.read_text(encoding="utf-8")
    assert install.CODEX_AGENTS_BEGIN in content
    assert install.CODEX_AGENTS_END in content
    assert "tokenwise" in content


# ---------------------------------------------------------------------------
# 6. unpatch_codex_agents_md removes the block
# ---------------------------------------------------------------------------


def test_unpatch_codex_agents_md_removes_block(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_codex_agents_md()
    install.unpatch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    content = md_path.read_text(encoding="utf-8")
    assert install.CODEX_AGENTS_BEGIN not in content
    assert install.CODEX_AGENTS_END not in content


# ---------------------------------------------------------------------------
# 7. patch_codex_agents_md is idempotent (running twice → one block)
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_idempotent(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    install.patch_codex_agents_md()
    install.patch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    content = md_path.read_text(encoding="utf-8")
    assert content.count(install.CODEX_AGENTS_BEGIN) == 1
    assert content.count(install.CODEX_AGENTS_END) == 1


# ---------------------------------------------------------------------------
# 8. patch_codex_agents_md appends to existing file without our block
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_appends(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)

    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    (codex_dir / "AGENTS.md").write_text("# Existing content\n", encoding="utf-8")

    install.patch_codex_agents_md()

    content = (codex_dir / "AGENTS.md").read_text(encoding="utf-8")
    assert "Existing content" in content
    assert install.CODEX_AGENTS_BEGIN in content


# ---------------------------------------------------------------------------
# 9. install_all(install_codex=True) writes both Codex files
# ---------------------------------------------------------------------------


def test_install_all_codex_flag(tmp_path, monkeypatch):
    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "tokenwise_binary", lambda: "tokenwise")

    def fake_schtasks(args):
        if args[0] == "/Query":
            return 1, "not found"
        return 0, "SUCCESS"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks)

    with (
        patch("tokenwise.install.paths.ensure_dirs"),
        patch("tokenwise.worker.ensure_running", return_value=99999),
    ):
        result = install.install_all(install_codex=True)

    assert "codex: config.toml" in result
    assert "codex: AGENTS.md" in result
    assert "ok" in result["codex: config.toml"]
    assert "ok" in result["codex: AGENTS.md"]

    assert (home / ".codex" / "config.toml").exists()
    assert (home / ".codex" / "AGENTS.md").exists()


# ---------------------------------------------------------------------------
# 10. uninstall_all(codex=True) cleans up Codex files
# ---------------------------------------------------------------------------


def test_uninstall_all_codex_flag(tmp_path, monkeypatch):
    import tomllib

    home = _fake_home(tmp_path)
    _patch_home(monkeypatch, home)
    monkeypatch.setattr(install, "tokenwise_binary", lambda: "tokenwise")

    def fake_schtasks(args):
        return 0, "ok"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks)

    # Install Codex first
    with (
        patch("tokenwise.install.paths.ensure_dirs"),
        patch("tokenwise.worker.ensure_running", return_value=99999),
    ):
        install.install_all(install_codex=True)

    # Now uninstall with codex=True
    with patch("tokenwise.install.paths.worker_pid_path", return_value=tmp_path / "w.pid"):
        result = install.uninstall_all(codex=True)

    assert "codex: config.toml" in result
    assert "codex: AGENTS.md" in result

    # Verify tokenwise entries are gone from config.toml
    cfg_path = home / ".codex" / "config.toml"
    if cfg_path.exists():
        content = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
        all_cmds = [
            h["command"]
            for entries in content.get("hooks", {}).values()
            for e in entries
            for h in e.get("hooks", [])
        ]
        assert not any("tokenwise" in c for c in all_cmds)

    # Verify AGENTS.md block is gone
    md_path = home / ".codex" / "AGENTS.md"
    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")
        assert install.CODEX_AGENTS_BEGIN not in content
