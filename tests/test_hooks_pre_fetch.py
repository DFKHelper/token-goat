"""Tests for the pre_fetch hook handler — Phase 13 Drive intercept."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import assert_deny as _assert_deny

from token_goat import gdrive, hooks_cli

# ---------------------------------------------------------------------------
# 10. Non-Drive tool passes through unchanged
# ---------------------------------------------------------------------------

class TestPreFetchNonDriveTool:
    def test_non_drive_tool_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "some_file.txt"},
        }
        result = hooks_cli.pre_fetch(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_bash_tool_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        }
        result = hooks_cli.pre_fetch(payload)
        _assert_continue(result)

    def test_empty_payload_passes_through(self, tmp_data_dir):
        result = hooks_cli.pre_fetch({})
        _assert_continue(result)


# ---------------------------------------------------------------------------
# 11. Drive tool with no creds → pass-through (don't deny, can't help)
# ---------------------------------------------------------------------------

class TestPreFetchDriveNoCreds:
    def test_drive_download_no_creds_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "abc123"},
        }
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_drive_read_file_no_creds_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__read_file_content",
            "tool_input": {"file_id": "xyz789"},
        }
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)


# ---------------------------------------------------------------------------
# 12. Drive tool with creds + file_id → deny + redirect
# ---------------------------------------------------------------------------

class TestPreFetchDriveWithCreds:
    def _fake_creds(self):
        return MagicMock()

    def test_download_tool_with_file_id_gets_denied(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "testfile123"},
        }
        fake_creds = self._fake_creds()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        _assert_deny(result)
        hso = result.get("hookSpecificOutput", {})
        assert "token-goat gdrive-fetch testfile123" in hso.get("additionalContext", "")

    def test_read_file_tool_with_file_id_gets_denied(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__read_file_content",
            "tool_input": {"file_id": "readfile456"},
        }
        fake_creds = self._fake_creds()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        _assert_deny(result)
        hso = result.get("hookSpecificOutput", {})
        assert "token-goat gdrive-fetch readfile456" in hso.get("additionalContext", "")

    def test_additional_context_mentions_cached_path_hint(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "img001"},
        }
        fake_creds = self._fake_creds()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "Read" in ctx  # tells Claude to Read the returned path
        assert "auto-shrunk" in ctx

    def test_hook_event_name_is_correct(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "evt001"},
        }
        fake_creds = self._fake_creds()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        hso = result.get("hookSpecificOutput", {})
        assert hso.get("hookEventName") == "PreToolUse"

    def test_file_id_from_fileid_field(self, tmp_data_dir):
        """fileId (camelCase) should also be detected."""
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"fileId": "camel001"},
        }
        fake_creds = self._fake_creds()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        assert "camel001" in hso.get("additionalContext", "")


# ---------------------------------------------------------------------------
# 13. Drive tool with no file_id → pass-through
# ---------------------------------------------------------------------------

class TestPreFetchDriveNoFileId:
    def test_drive_tool_no_file_id_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"something_else": "value"},
        }
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_drive_tool_empty_tool_input_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {},
        }
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)


# ---------------------------------------------------------------------------
# 14. Malicious file_id injection: invalid IDs must not reach the hook message
# ---------------------------------------------------------------------------

class TestPreFetchMaliciousFileId:
    """A file_id with shell metacharacters or path traversal must be rejected
    (pass-through) rather than embedded in additionalContext where it could
    be executed or misinterpreted by the LLM."""

    def _denied_result_for_id(self, file_id: str, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": file_id},
        }
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            return hooks_cli.pre_fetch(payload)

    def test_backtick_injection_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("`evil`", tmp_data_dir)
        # Should NOT deny (no embed into context) — falls through as continue:true
        _assert_continue(result)

    def test_command_substitution_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("$(rm -rf /)", tmp_data_dir)
        _assert_continue(result)

    def test_path_traversal_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("../../etc/passwd", tmp_data_dir)
        _assert_continue(result)

    def test_null_byte_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("abc\x00def", tmp_data_dir)
        _assert_continue(result)

    def test_newline_injection_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("abc\necho injected", tmp_data_dir)
        _assert_continue(result)

    def test_too_long_id_passes_through(self, tmp_data_dir):
        result = self._denied_result_for_id("a" * 200, tmp_data_dir)
        _assert_continue(result)

    def test_valid_alphanumeric_id_still_denied(self, tmp_data_dir):
        """A valid file_id should still trigger the deny+redirect response."""
        result = self._denied_result_for_id("ValidFile123-abc", tmp_data_dir)
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        assert "ValidFile123-abc" in hso.get("additionalContext", "")


# ---------------------------------------------------------------------------
# Dispatcher integration
# ---------------------------------------------------------------------------

class TestPreFetchDispatcher:
    def test_dispatch_pre_fetch_non_drive_tool(self, tmp_data_dir):
        payload = {"tool_name": "Write", "tool_input": {"file_path": "x.py"}}
        result = hooks_cli.dispatch("pre-fetch", payload)
        _assert_continue(result)

    def test_dispatch_pre_fetch_drive_with_creds_denies(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "dispatch_test_id"},
        }
        fake_creds = MagicMock()
        with patch("google.auth.default", return_value=(fake_creds, "proj")):
            result = hooks_cli.dispatch("pre-fetch", payload)

        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"

    def test_crash_in_handler_returns_continue(self, tmp_data_dir):
        """Even if the handler raises internally, fail-soft must return continue:true."""
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {"file_id": "crash_test"},
        }
        with patch.object(gdrive, "get_credentials", side_effect=RuntimeError("boom")):
            result = hooks_cli.dispatch("pre-fetch", payload)

        assert result["continue"] is True
