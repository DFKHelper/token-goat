"""Tests for fail_soft decorator and duplicate try/except removal.

Verifies that:
1. Handlers removed redundant try/except blocks
2. @fail_soft decorator catches and logs exceptions once with full traceback
3. Exceptions escape to @fail_soft and are logged with exc_info=True
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest

from token_goat import hooks_cli

# ---------------------------------------------------------------------------
# Test fail_soft: exception logged once with traceback
# ---------------------------------------------------------------------------


def test_fail_soft_catches_exception_and_logs_with_traceback(caplog):
    """@fail_soft decorator catches exceptions and logs with full traceback."""
    caplog.set_level(logging.ERROR)

    def failing_handler(_payload):
        """Handler that raises an exception."""
        raise ValueError("Intentional test error")

    wrapped = hooks_cli.fail_soft(failing_handler)
    result = wrapped({"session_id": "test-sess", "cwd": "/tmp"})

    # Should return CONTINUE even on failure
    assert result["continue"] is True
    assert result.get("_tg_error") == "ValueError: Intentional test error"

    # Should have logged exactly once with exc_info (traceback)
    error_logs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_logs) == 1
    error_log = error_logs[0]
    assert "hook handler crashed" in error_log.message
    assert "ValueError" in error_log.message
    # exc_info=True is set when logging; check that traceback is in message
    assert "Traceback" in error_log.exc_text or error_log.exc_info is not None


def test_pre_fetch_validates_drive_file_id_without_redundant_try_except(caplog):
    """pre_fetch should let validation exceptions escape to @fail_soft."""
    caplog.set_level(logging.ERROR)

    # Mock gdrive._validate_file_id to raise an exception
    with patch("token_goat.gdrive._validate_file_id", side_effect=ValueError("invalid file_id")):
        result = hooks_cli.pre_fetch({
            "session_id": "test-sess",
            "cwd": "/tmp",
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "malformed-id"},
        })

    # Should return CONTINUE due to @fail_soft
    assert result["continue"] is True

    # Should have logged the exception with full context (from @fail_soft)
    error_logs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_logs) == 1
    assert "hook handler crashed" in error_logs[0].message


def test_pre_fetch_credentials_failure_without_redundant_try_except(caplog):
    """pre_fetch should let credential exceptions escape to @fail_soft."""
    caplog.set_level(logging.ERROR)

    from token_goat import gdrive

    with patch("token_goat.gdrive.get_credentials", side_effect=gdrive.GDriveCredsUnavailable("no creds")):
        result = hooks_cli.pre_fetch({
            "session_id": "test-sess",
            "cwd": "/tmp",
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "file_abc"},
        })

    # Should return CONTINUE due to @fail_soft
    assert result["continue"] is True

    # Should have logged the exception (from @fail_soft)
    error_logs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_logs) == 1


def test_subagent_stop_session_load_failure_without_redundant_try_except(caplog):
    """subagent_stop should let session load exceptions escape to @fail_soft."""
    caplog.set_level(logging.ERROR)

    with patch("token_goat.session.safe_load", side_effect=OSError("cache corrupted")):
        result = hooks_cli.subagent_stop({
            "session_id": "test-sess",
            "cwd": "/tmp",
        })

    # Should return CONTINUE due to @fail_soft
    assert result["continue"] is True

    # Should have logged the exception (from @fail_soft)
    error_logs = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(error_logs) == 1


def test_subagent_stop_git_failure_without_redundant_try_except(caplog, tmp_path):
    """subagent_stop should let git exceptions escape to @fail_soft.

    Verifies that when git subprocess raises an exception, it's caught by
    @fail_soft (not by an inner try/except) and the handler returns CONTINUE.
    """
    caplog.set_level(logging.DEBUG)

    mock_cache = MagicMock()
    mock_cache.edited_files = {"file.py"}

    # Use subprocess.run mock to intercept the git call
    with (
        patch("token_goat.session.safe_load", return_value=mock_cache),
        patch("subprocess.run", side_effect=OSError("git timeout")),
    ):
        result = hooks_cli.subagent_stop({
            "session_id": "test-sess",
            "cwd": str(tmp_path),
        })

    # Should return CONTINUE due to @fail_soft
    assert result["continue"] is True
    # Verify error was caught by @fail_soft
    assert result.get("_tg_error") == "OSError: git timeout"


# ---------------------------------------------------------------------------
# Test that legitimate error handling still works (not deleted)
# ---------------------------------------------------------------------------


def test_post_skill_legitimate_error_handling_preserved(caplog, tmp_path, tmp_data_dir):
    """post_skill should still handle session record errors gracefully (not removed)."""
    caplog.set_level(logging.DEBUG)

    # Mock skill cache to succeed, but session.mark_skill_loaded to fail
    payload = {
        "session_id": "skill-test-sess",
        "cwd": str(tmp_path),
        "tool_name": "Skill",
        "tool_input": {"skill": "test-skill"},
        "tool_response": {
            "text": "X" * 1000,  # Large enough to cache
        },
    }

    with (
        patch("token_goat.config.load") as mock_config,
        patch("token_goat.skill_cache.store_output") as mock_store,
        patch("token_goat.skill_cache.write_sidecar"),
        patch("token_goat.session.mark_skill_loaded", side_effect=OSError("write failed")),
    ):
        mock_config.return_value.skill_preservation.enabled = True
        mock_config.return_value.skill_preservation.max_cache_bytes = 1000000

        mock_meta = MagicMock()
        mock_meta.skill_name = "test-skill"
        mock_meta.output_id = "out-123"
        mock_meta.content_sha = "sha123"
        mock_meta.body_bytes = 1000
        mock_meta.truncated = False
        mock_meta.source_path = ""
        mock_store.return_value = mock_meta

        result = hooks_cli.post_skill(payload)

    # Should return CONTINUE even though session record failed
    assert result["continue"] is True

    # Should have logged the session record failure at DEBUG level (legitimate handling)
    debug_logs = [r for r in caplog.records if r.levelno == logging.DEBUG]
    assert any("session record failed" in r.message for r in debug_logs)


# ---------------------------------------------------------------------------
# Test: handlers without @fail_soft applied directly fail naturally
# ---------------------------------------------------------------------------


def test_unwrapped_handler_raises_when_called_directly():
    """Calling an unwrapped handler directly will raise (not caught by @fail_soft)."""
    from token_goat import hooks_session

    # Call the unwrapped handler directly
    with (
        patch("token_goat.session.safe_load", side_effect=OSError("cache error")),
        pytest.raises(OSError, match="cache error"),
    ):
        hooks_session.subagent_stop({
            "session_id": "test-sess",
            "cwd": "/tmp",
        })


def test_wrapped_handler_via_dispatcher_catches_exception():
    """Calling via hooks_cli (dispatcher) wraps with @fail_soft and catches."""
    with patch("token_goat.session.safe_load", side_effect=OSError("cache error")):
        result = hooks_cli.subagent_stop({
            "session_id": "test-sess",
            "cwd": "/tmp",
        })

    # Should return CONTINUE (caught by @fail_soft)
    assert result["continue"] is True
    assert result.get("_tg_error") == "OSError: cache error"
