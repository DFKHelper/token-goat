"""Tests for UserPromptSubmit and SubagentStop hook handlers (items 5 & 6)."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from token_goat import hooks_cli

# ---------------------------------------------------------------------------
# UserPromptSubmit — no session_id
# ---------------------------------------------------------------------------


def test_user_prompt_submit_no_session_id():
    """Without a session_id, handler returns continue:True with no additionalContext."""
    result = hooks_cli.user_prompt_submit({})
    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput")
    assert hso is None


# ---------------------------------------------------------------------------
# UserPromptSubmit — happy path: branches + edits + last_exit
# ---------------------------------------------------------------------------


def test_user_prompt_submit_additionalContext_format(tmp_path):
    """additionalContext should be in '[branch: X | edits: Y ...]' format."""
    mock_bash_entry = MagicMock()
    mock_bash_entry.ts = 1000.0
    mock_bash_entry.exit_code = 0

    mock_cache = MagicMock()
    mock_cache.edited_files = {"file1.py", "file2.py"}
    mock_cache.bash_history = {"cmd1": mock_bash_entry}

    import token_goat.session as real_session

    with (
        patch("subprocess.run") as mock_run,
        patch.object(real_session, "safe_load", return_value=mock_cache),
    ):
        mock_run.return_value = MagicMock(stdout="feature-branch\n", returncode=0)
        result = hooks_cli.user_prompt_submit({
            "session_id": "test-sess-456",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput")
    # When parts are found, additionalContext is present and bracketed
    if hso:
        ctx = hso.get("additionalContext", "")
        assert ctx.startswith("[")
        assert ctx.endswith("]")
        assert "edits:" in ctx


def test_user_prompt_submit_git_failure_still_returns_continue(tmp_path):
    """git subprocess failure must not crash the hook."""
    import token_goat.session as real_session

    mock_cache = MagicMock()
    mock_cache.edited_files = set()
    mock_cache.bash_history = {}

    with (
        patch("subprocess.run", side_effect=OSError("git not found")),
        patch.object(real_session, "safe_load", return_value=mock_cache),
    ):
        result = hooks_cli.user_prompt_submit({
            "session_id": "test-sess-789",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True


def test_user_prompt_submit_no_session_cache_returns_continue(tmp_path):
    """When session cache is unavailable, handler still returns continue:True."""
    import token_goat.session as real_session

    with (
        patch("subprocess.run", side_effect=OSError("git not found")),
        patch.object(real_session, "safe_load", return_value=None),
    ):
        result = hooks_cli.user_prompt_submit({
            "session_id": "test-sess-000",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True
    # When only git fails AND cache is None, no parts → no hookSpecificOutput
    assert result.get("hookSpecificOutput") is None


# ---------------------------------------------------------------------------
# UserPromptSubmit — short-circuit on trivial prompts (item A12)
# ---------------------------------------------------------------------------


def test_user_prompt_submit_short_prompt_early_returns(tmp_path):
    """Prompts shorter than 8 chars must early-return CONTINUE with no context."""
    for short_prompt in ["k", "yes", "no", "/help", "ok", "y", "       "]:
        result = hooks_cli.user_prompt_submit({
            "session_id": "short-prompt-sess",
            "cwd": str(tmp_path),
            "prompt": short_prompt,
        })
        assert result.get("continue") is True, f"Failed for prompt={short_prompt!r}"
        assert result.get("hookSpecificOutput") is None, (
            f"hookSpecificOutput must be absent for short prompt={short_prompt!r}"
        )


def test_user_prompt_submit_long_enough_prompt_proceeds(tmp_path):
    """Prompts of 8+ chars bypass the short-circuit and proceed normally."""
    mock_bash_entry = MagicMock()
    mock_bash_entry.ts = 1000.0
    mock_bash_entry.exit_code = 0

    mock_cache = MagicMock()
    mock_cache.edited_files = {"a.py"}
    mock_cache.bash_history = {"cmd": mock_bash_entry}

    import token_goat.session as real_session

    with (
        patch("subprocess.run") as mock_run,
        patch.object(real_session, "safe_load", return_value=mock_cache),
    ):
        mock_run.return_value = MagicMock(stdout="main\n", returncode=0)
        result = hooks_cli.user_prompt_submit({
            "session_id": "long-prompt-sess",
            "cwd": str(tmp_path),
            "prompt": "Please fix the login bug",  # 24 chars
        })

    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput")
    # Long prompt proceeds — should produce a context summary
    assert hso is not None
    assert "additionalContext" in hso


# ---------------------------------------------------------------------------
# SubagentStop — no session_id / no cwd
# ---------------------------------------------------------------------------


def test_subagent_stop_no_session_id():
    """Without session_id, handler returns continue:True immediately."""
    result = hooks_cli.subagent_stop({})
    assert result.get("continue") is True


def test_subagent_stop_no_edited_files_skips_flag(tmp_path):
    """When session has no edited files, no flag is written."""
    mock_cache = MagicMock()
    mock_cache.edited_files = set()

    import token_goat.session as real_session

    with patch.object(real_session, "safe_load", return_value=mock_cache):
        result = hooks_cli.subagent_stop({
            "session_id": "sub-sess-001",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True


def test_subagent_stop_disk_changes_no_flag(tmp_path):
    """When git reports disk changes, no hallucination flag is written."""
    mock_cache = MagicMock()
    mock_cache.edited_files = {"some_file.py"}

    import token_goat.session as real_session

    with (
        patch.object(real_session, "safe_load", return_value=mock_cache),
        patch("subprocess.run") as mock_run,
    ):
        # git status --porcelain returns non-empty output → real changes present
        mock_run.return_value = MagicMock(stdout=" M some_file.py\n", returncode=0)
        result = hooks_cli.subagent_stop({
            "session_id": "sub-sess-002",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True


def test_subagent_stop_no_disk_changes_writes_sidecar(tmp_path, monkeypatch):
    """When git status is clean but session has edits, writes a flag record."""
    mock_cache = MagicMock()
    mock_cache.edited_files = {"some_file.py"}

    # Point data_dir to tmp_path so sidecar lands in a controlled location
    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "data_dir", lambda: tmp_path)

    import token_goat.session as real_session

    with (
        patch.object(real_session, "safe_load", return_value=mock_cache),
        patch("subprocess.run") as mock_run,
    ):
        # git status --porcelain returns empty → no changes on disk
        mock_run.return_value = MagicMock(stdout="", returncode=0)
        result = hooks_cli.subagent_stop({
            "session_id": "sub-sess-003",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True

    # Verify sidecar was written under sessions/
    from token_goat.hooks_session import _SUBAGENT_HALLUCINATION_SIDECAR
    sidecar = tmp_path / "sessions" / _SUBAGENT_HALLUCINATION_SIDECAR
    assert sidecar.exists(), "hallucination flag sidecar was not written"
    lines = [ln for ln in sidecar.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["session_id"] == "sub-sess-003"
    assert record["trigger"] == "SubagentStop"


def test_subagent_stop_git_failure_returns_continue(tmp_path):
    """git subprocess failure must not crash the subagent-stop hook."""
    mock_cache = MagicMock()
    mock_cache.edited_files = {"file.py"}

    import token_goat.session as real_session

    with (
        patch.object(real_session, "safe_load", return_value=mock_cache),
        patch("subprocess.run", side_effect=OSError("git timeout")),
    ):
        result = hooks_cli.subagent_stop({
            "session_id": "sub-sess-004",
            "cwd": str(tmp_path),
        })

    assert result.get("continue") is True


# ---------------------------------------------------------------------------
# Integration: dispatch routes correctly
# ---------------------------------------------------------------------------


def test_dispatch_user_prompt_submit_routes(tmp_path):
    """dispatch('user-prompt-submit', payload) always returns continue:True."""
    result = hooks_cli.dispatch("user-prompt-submit", {
        "session_id": "dispatch-test",
        "cwd": str(tmp_path),
    })
    assert result.get("continue") is True


def test_dispatch_subagent_stop_routes(tmp_path):
    """dispatch('subagent-stop', payload) always returns continue:True."""
    result = hooks_cli.dispatch("subagent-stop", {
        "session_id": "dispatch-test-2",
        "cwd": str(tmp_path),
    })
    assert result.get("continue") is True
