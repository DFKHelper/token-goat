"""Tests for Codex install/uninstall — Phase 18."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from token_goat import install

# ---------------------------------------------------------------------------
# 1. patch_codex_config on missing file → creates valid TOML with our hooks
# ---------------------------------------------------------------------------


def test_patch_codex_config_creates_file(patched_home, monkeypatch):
    cfg_path = install.patch_codex_config("token-goat")

    p = Path(cfg_path)
    assert p.exists()
    content = p.read_text(encoding="utf-8")
    assert "token_goat" in content
    assert "SessionStart" in content or "session-start" in content


# ---------------------------------------------------------------------------
# 2. patch_codex_config on existing config with other hooks → preserves them
# ---------------------------------------------------------------------------


def test_patch_codex_config_preserves_existing(patched_home, monkeypatch):
    import tomli_w

    home = patched_home

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

    install.patch_codex_config("token-goat")

    import tomllib

    content = tomllib.loads((codex_dir / "config.toml").read_text(encoding="utf-8"))
    pre_entries = content["hooks"]["PreToolUse"]
    all_commands = [h["command"] for e in pre_entries for h in e.get("hooks", [])]
    assert any("other-tool" in c for c in all_commands), "existing hook was lost"
    assert any("token_goat" in c for c in all_commands), "token-goat hook not added"


# ---------------------------------------------------------------------------
# 3. patch_codex_config is idempotent
# ---------------------------------------------------------------------------


def test_patch_codex_config_idempotent(patched_home, monkeypatch):
    import tomllib

    home = patched_home

    install.patch_codex_config("token-goat")
    install.patch_codex_config("token-goat")

    cfg_path = home / ".codex" / "config.toml"
    content = tomllib.loads(cfg_path.read_text(encoding="utf-8"))

    # SessionStart should have exactly ONE token-goat entry
    ss_entries = content["hooks"].get("SessionStart", [])
    tw_cmds = [
        h["command"]
        for e in ss_entries
        for h in e.get("hooks", [])
        if "token_goat" in h["command"]
    ]
    assert len(tw_cmds) == 1, f"expected 1 token-goat SessionStart entry, got {len(tw_cmds)}"


def test_patch_codex_config_total_count_stable_across_three_installs(patched_home, monkeypatch):
    """patch_codex_config three times → token-goat hook count must be stable.

    Parallel to ``test_verify_install_idempotent_count_stable`` on the Claude
    side.  Previously only SessionStart had per-event coverage; this catches
    drift across the full event registry (PreToolUse, PostToolUse, PreCompact).
    """
    install.patch_codex_config("token-goat")
    count_first = install._codex_config_token_goat_count()
    install.patch_codex_config("token-goat")
    count_second = install._codex_config_token_goat_count()
    install.patch_codex_config("token-goat")
    count_third = install._codex_config_token_goat_count()
    assert count_first == count_second == count_third, (
        f"non-idempotent: {count_first} → {count_second} → {count_third}"
    )
    assert count_first > 0, "fresh codex install should produce >=1 hook entry"


def test_codex_config_token_goat_count_zero_when_absent(patched_home):
    """_codex_config_token_goat_count returns 0 when the config doesn't exist.

    Guards the helper's tolerance contract — verify/plan should never crash
    just because codex was never installed.
    """
    # patched_home gives us a fresh ~/.codex directory that doesn't exist yet.
    assert install._codex_config_token_goat_count() == 0


# ---------------------------------------------------------------------------
# 4. unpatch_codex_config removes only token-goat entries
# ---------------------------------------------------------------------------


def test_unpatch_codex_config_removes_token_goat(patched_home, monkeypatch):
    import tomllib  # noqa: PLC0415

    import tomli_w  # noqa: PLC0415

    home = patched_home

    # Pre-install a config with both token-goat and an unrelated hook
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

    install.patch_codex_config("token-goat")
    install.unpatch_codex_config()

    content = tomllib.loads((codex_dir / "config.toml").read_text(encoding="utf-8"))
    all_cmds = [
        h["command"]
        for entries in content.get("hooks", {}).values()
        for e in entries
        for h in e.get("hooks", [])
    ]
    assert not any("token_goat" in c for c in all_cmds), "token-goat entry not removed"
    assert any("other-tool" in c for c in all_cmds), "unrelated entry was removed"


# ---------------------------------------------------------------------------
# 5. patch_codex_agents_md creates the file with delimited block
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_creates_file(patched_home):
    home = patched_home

    install.patch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    assert md_path.exists()
    content = md_path.read_text(encoding="utf-8")
    assert install.CODEX_AGENTS_BEGIN in content
    assert install.CODEX_AGENTS_END in content
    assert "token-goat" in content
    assert "Get-Content" in content


# ---------------------------------------------------------------------------
# 6. unpatch_codex_agents_md removes the block
# ---------------------------------------------------------------------------


def test_unpatch_codex_agents_md_removes_block(patched_home):
    home = patched_home

    install.patch_codex_agents_md()
    install.unpatch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    content = md_path.read_text(encoding="utf-8")
    assert install.CODEX_AGENTS_BEGIN not in content
    assert install.CODEX_AGENTS_END not in content


# ---------------------------------------------------------------------------
# 7. patch_codex_agents_md is idempotent (running twice → one block)
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_idempotent(patched_home):
    home = patched_home

    install.patch_codex_agents_md()
    install.patch_codex_agents_md()

    md_path = home / ".codex" / "AGENTS.md"
    content = md_path.read_text(encoding="utf-8")
    assert content.count(install.CODEX_AGENTS_BEGIN) == 1
    assert content.count(install.CODEX_AGENTS_END) == 1


def test_patch_codex_agents_md_strips_legacy_tokenwise_block(patched_home):
    """An AGENTS.md written under the old ``tokenwise`` binary name still
    contains a ``<!-- tokenwise-codex-begin -->...-end -->`` block instructing
    Codex to use the wrong binary. The modern installer must strip it so the
    file ends up with only the up-to-date ``token-goat`` routing table.
    """
    home = patched_home

    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    legacy_block = (
        f"{install.LEGACY_CODEX_AGENTS_BEGIN}\n"
        "## tokenwise - route code reads through tokenwise first (Codex)\n\n"
        "| Goal | Do this | Not this |\n"
        "|------|---------|----------|\n"
        "| Find a function | `tokenwise symbol X` | `rg X` |\n"
        f"{install.LEGACY_CODEX_AGENTS_END}\n"
    )
    md_path = codex_dir / "AGENTS.md"
    md_path.write_text(legacy_block, encoding="utf-8")

    install.patch_codex_agents_md()
    content = md_path.read_text(encoding="utf-8")

    assert install.CODEX_AGENTS_BEGIN in content
    assert install.CODEX_AGENTS_END in content
    assert install.LEGACY_CODEX_AGENTS_BEGIN not in content
    assert install.LEGACY_CODEX_AGENTS_END not in content
    assert "tokenwise symbol X" not in content


def test_patch_codex_agents_md_legacy_strip_is_idempotent(patched_home):
    """Two installs in a row leave one modern block and no legacy artifacts."""
    home = patched_home

    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    seed = (
        f"{install.LEGACY_CODEX_AGENTS_BEGIN}\n"
        f"legacy body\n"
        f"{install.LEGACY_CODEX_AGENTS_END}\n"
    )
    md_path = codex_dir / "AGENTS.md"
    md_path.write_text(seed, encoding="utf-8")

    install.patch_codex_agents_md()
    install.patch_codex_agents_md()
    content = md_path.read_text(encoding="utf-8")

    assert content.count(install.CODEX_AGENTS_BEGIN) == 1
    assert content.count(install.CODEX_AGENTS_END) == 1
    assert install.LEGACY_CODEX_AGENTS_BEGIN not in content
    assert install.LEGACY_CODEX_AGENTS_END not in content


# ---------------------------------------------------------------------------
# 8. patch_codex_agents_md appends to existing file without our block
# ---------------------------------------------------------------------------


def test_patch_codex_agents_md_appends(patched_home):
    home = patched_home

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


def test_install_all_codex_flag(patched_home, monkeypatch):
    home = patched_home
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    def fake_schtasks(args):
        if args[0] == "/Query":
            return 1, "not found"
        return 0, "SUCCESS"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks)

    with (
        patch("token_goat.install.paths.ensure_dirs"),
        patch("token_goat.worker.ensure_running", return_value=99999),
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


def test_uninstall_all_codex_flag(patched_home, monkeypatch, tmp_path):
    import tomllib

    home = patched_home
    monkeypatch.setattr(install, "token_goat_binary", lambda: "token-goat")

    def fake_schtasks(args):
        return 0, "ok"

    monkeypatch.setattr(install, "_run_schtasks", fake_schtasks)

    # Install Codex first
    with (
        patch("token_goat.install.paths.ensure_dirs"),
        patch("token_goat.worker.ensure_running", return_value=99999),
    ):
        install.install_all(install_codex=True)

    # Now uninstall with codex=True
    with patch("token_goat.install.paths.worker_pid_path", return_value=tmp_path / "w.pid"):
        result = install.uninstall_all(codex=True)

    assert "codex: config.toml" in result
    assert "codex: AGENTS.md" in result

    # Verify token-goat entries are gone from config.toml
    cfg_path = home / ".codex" / "config.toml"
    if cfg_path.exists():
        content = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
        all_cmds = [
            h["command"]
            for entries in content.get("hooks", {}).values()
            for e in entries
            for h in e.get("hooks", [])
        ]
        assert not any("token_goat" in c for c in all_cmds)

    # Verify AGENTS.md block is gone
    md_path = home / ".codex" / "AGENTS.md"
    if md_path.exists():
        content = md_path.read_text(encoding="utf-8")
        assert install.CODEX_AGENTS_BEGIN not in content


# ---------------------------------------------------------------------------
# 11. detect_harnesses: codex detected when CODEX_HOME is set
# ---------------------------------------------------------------------------


def test_detect_harnesses_codex_home_env(monkeypatch):
    """detect_harnesses should include 'codex' when CODEX_HOME env var is set."""
    monkeypatch.setenv("CODEX_HOME", "/some/codex/path")
    # Patch opencode/openclaw dirs so only the env-var path fires
    monkeypatch.setattr(install, "codex_dir", lambda: Path("/nonexistent-codex-dir-xyz"))
    result = install.detect_harnesses()
    assert "claude" in result
    assert "codex" in result


def test_detect_harnesses_codex_dir_present(monkeypatch, tmp_path):
    """detect_harnesses should include 'codex' when ~/.codex/ exists."""
    monkeypatch.delenv("CODEX_HOME", raising=False)
    codex_fake = tmp_path / ".codex"
    codex_fake.mkdir()
    monkeypatch.setattr(install, "codex_dir", lambda: codex_fake)
    result = install.detect_harnesses()
    assert "codex" in result


def test_detect_harnesses_no_codex(monkeypatch, tmp_path):
    """detect_harnesses should not include 'codex' when neither env var nor dir present."""
    monkeypatch.delenv("CODEX_HOME", raising=False)
    # Point codex_dir at a non-existent path
    monkeypatch.setattr(install, "codex_dir", lambda: tmp_path / "no-such-dir")
    result = install.detect_harnesses()
    assert "claude" in result
    assert "codex" not in result
