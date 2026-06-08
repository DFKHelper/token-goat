"""Tests for Gemini CLI install/uninstall — patch/unpatch/check integration."""
from __future__ import annotations

import json

from token_goat.install import (
    _check_gemini_settings,
    patch_gemini_settings,
    unpatch_gemini_settings,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _all_hook_commands(data: dict) -> list[str]:
    """Return every hook command string present in a settings dict."""
    return [
        h["command"]
        for entries in data.get("hooks", {}).values()
        for e in entries
        for h in e.get("hooks", [])
        if isinstance(h, dict) and "command" in h
    ]


# ---------------------------------------------------------------------------
# 1. patch creates settings.json when it does not exist
# ---------------------------------------------------------------------------


def test_patch_creates_settings_json(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    result = patch_gemini_settings()

    assert settings_file.exists(), "settings.json should have been created"
    assert result == str(settings_file)

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    hooks = data.get("hooks", {})

    assert "BeforeTool" in hooks, "BeforeTool event missing"
    assert "AfterTool" in hooks, "AfterTool event missing"
    assert "SessionStart" in hooks, "SessionStart event missing"
    assert "PreCompress" in hooks, "PreCompress event missing"

    # Every hook entry must have a command referencing the token-goat runner
    for event_entries in hooks.values():
        for entry in event_entries:
            for h in entry.get("hooks", []):
                cmd = h.get("command", "")
                assert "tg-hook" in cmd or "token_goat" in cmd, (
                    f"hook command does not reference token-goat runner: {cmd!r}"
                )


# ---------------------------------------------------------------------------
# 2. patch is idempotent — calling twice does not duplicate entries
# ---------------------------------------------------------------------------


def test_patch_idempotent(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    patch_gemini_settings()
    data_first = json.loads(settings_file.read_text(encoding="utf-8"))
    counts_first = {
        event: len(entries) for event, entries in data_first.get("hooks", {}).items()
    }

    patch_gemini_settings()
    data_second = json.loads(settings_file.read_text(encoding="utf-8"))
    counts_second = {
        event: len(entries) for event, entries in data_second.get("hooks", {}).items()
    }

    assert counts_first == counts_second, (
        f"hook entry counts changed after second patch: {counts_first} → {counts_second}"
    )


# ---------------------------------------------------------------------------
# 3. patch preserves pre-existing non-token-goat hooks
# ---------------------------------------------------------------------------


def test_patch_preserves_existing_hooks(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    existing = {
        "hooks": {
            "BeforeTool": [
                {
                    "matcher": "some_tool",
                    "hooks": [{"type": "command", "command": "other-tool hook pre", "timeout": 1000}],
                }
            ]
        }
    }
    settings_file.write_text(json.dumps(existing), encoding="utf-8")

    patch_gemini_settings()

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    all_cmds = _all_hook_commands(data)

    assert any("other-tool" in c for c in all_cmds), "pre-existing hook was lost"
    assert any("tg-hook" in c or "token_goat" in c for c in all_cmds), "token-goat hook not added"


# ---------------------------------------------------------------------------
# 4. patch handles malformed JSON — starts fresh, writes valid output
# ---------------------------------------------------------------------------


def test_patch_merges_into_malformed_json(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    settings_file.write_text("{ this is not valid json !!!", encoding="utf-8")

    # Must not raise
    patch_gemini_settings()

    assert settings_file.exists()
    data = json.loads(settings_file.read_text(encoding="utf-8"))
    hooks = data.get("hooks", {})
    assert hooks, "hooks should be present after recovery from malformed JSON"
    # Verify token-goat hooks were written
    all_cmds = _all_hook_commands(data)
    assert any("tg-hook" in c or "token_goat" in c for c in all_cmds)


# ---------------------------------------------------------------------------
# 5. unpatch removes token-goat hooks
# ---------------------------------------------------------------------------


def test_unpatch_removes_token_goat_hooks(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    patch_gemini_settings()
    unpatch_gemini_settings()

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    all_cmds = _all_hook_commands(data)
    assert not any("tg-hook" in c or "token_goat" in c for c in all_cmds), (
        "token-goat hooks were not fully removed by unpatch"
    )


# ---------------------------------------------------------------------------
# 6. unpatch preserves non-token-goat hooks
# ---------------------------------------------------------------------------


def test_unpatch_preserves_other_hooks(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    # Seed with a mix: external hook first, then patch adds token-goat
    seed = {
        "hooks": {
            "BeforeTool": [
                {
                    "matcher": "some_tool",
                    "hooks": [{"type": "command", "command": "other-tool hook pre", "timeout": 1000}],
                }
            ]
        }
    }
    settings_file.write_text(json.dumps(seed), encoding="utf-8")

    patch_gemini_settings()
    unpatch_gemini_settings()

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    all_cmds = _all_hook_commands(data)

    assert any("other-tool" in c for c in all_cmds), "non-token-goat hook was removed by unpatch"
    assert not any("tg-hook" in c or "token_goat" in c for c in all_cmds), (
        "token-goat hook still present after unpatch"
    )


# ---------------------------------------------------------------------------
# 7. unpatch on missing file returns a message, does not raise
# ---------------------------------------------------------------------------


def test_unpatch_missing_file(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    result = unpatch_gemini_settings()

    assert isinstance(result, str)
    assert "not found" in result.lower() or result, "expected a 'not found' message"
    # File should still not exist
    assert not settings_file.exists()


# ---------------------------------------------------------------------------
# 8. _check_gemini_settings returns "installed" after patch
# ---------------------------------------------------------------------------


def test_check_status_installed(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    patch_gemini_settings()
    status = _check_gemini_settings()

    assert "installed" in status.lower(), f"expected 'installed' in status, got: {status!r}"
    assert "not installed" not in status.lower(), f"should not contain 'not installed': {status!r}"


# ---------------------------------------------------------------------------
# 9. _check_gemini_settings returns "not installed" when file is missing
# ---------------------------------------------------------------------------


def test_check_status_not_installed(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    status = _check_gemini_settings()

    assert "not installed" in status.lower(), (
        f"expected 'not installed' in status, got: {status!r}"
    )


# ---------------------------------------------------------------------------
# 10. _check_gemini_settings returns "error" for malformed JSON
# ---------------------------------------------------------------------------


def test_check_status_malformed(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    settings_file.write_text("not json at all", encoding="utf-8")
    status = _check_gemini_settings()

    assert "error" in status.lower(), (
        f"expected 'error' in status for malformed JSON, got: {status!r}"
    )


# ---------------------------------------------------------------------------
# 11. Every hook command contains --harness gemini
# ---------------------------------------------------------------------------


def test_hook_commands_have_harness_gemini_flag(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    patch_gemini_settings()

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    all_cmds = _all_hook_commands(data)

    assert all_cmds, "no hook commands found in settings.json"
    for cmd in all_cmds:
        if "tg-hook" in cmd or "token_goat" in cmd:
            assert "--harness gemini" in cmd, (
                f"token-goat hook command is missing '--harness gemini': {cmd!r}"
            )


# ---------------------------------------------------------------------------
# 12. Hook event names are Gemini-format, not Claude-format
# ---------------------------------------------------------------------------


def test_event_names_are_gemini_format(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: settings_file)

    patch_gemini_settings()

    data = json.loads(settings_file.read_text(encoding="utf-8"))
    hook_events = set(data.get("hooks", {}).keys())

    # Gemini-format names must be present
    for expected in ("BeforeTool", "AfterTool", "SessionStart", "PreCompress"):
        assert expected in hook_events, f"Gemini event {expected!r} missing from hooks"

    # Claude-format names must NOT appear
    for claude_name in ("PreToolUse", "PostToolUse", "PreCompact"):
        assert claude_name not in hook_events, (
            f"Claude event name {claude_name!r} should not appear in Gemini settings"
        )


# ---------------------------------------------------------------------------
# 13. `install --target` help advertises every valid target (incl. gemini)
# ---------------------------------------------------------------------------


def test_install_target_help_lists_every_valid_target():
    """The --target help string must name every member of _VALID_TARGETS.

    Regression: gemini is a real install target (_VALID_TARGETS) and is fully
    wired (patch_gemini_settings), but the --target help choices list silently
    omitted it, so `token-goat install --help` advertised no Gemini path and
    the README told users to run a non-existent `install --gemini` flag.
    """
    from typer.testing import CliRunner

    from token_goat import cli
    from token_goat.cli import _VALID_TARGETS

    result = CliRunner().invoke(cli.app, ["install", "--help"])
    assert result.exit_code == 0
    # Typer may wrap/space the help text; strip whitespace before substring checks.
    help_text = " ".join(result.stdout.split())
    for target in _VALID_TARGETS:
        assert target in help_text, (
            f"--target help omits valid target {target!r}; choices list is out of "
            f"sync with _VALID_TARGETS"
        )
