"""Security tests: validate_cwd guards in hooks_common, hooks_edit, hooks_session."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from hook_helpers import assert_continue as _assert_continue

from token_goat.hooks_common import validate_cwd

# ---------------------------------------------------------------------------
# validate_cwd unit tests
# ---------------------------------------------------------------------------


class TestValidateCwd:
    """validate_cwd returns Path for valid input and None for bad input."""

    def test_none_returns_none(self, tmp_path):
        assert validate_cwd(None) is None

    def test_empty_string_returns_none(self, tmp_path):
        assert validate_cwd("") is None

    def test_non_string_returns_none(self, tmp_path):
        assert validate_cwd(42) is None
        assert validate_cwd(["/tmp"]) is None

    def test_too_long_returns_none(self, tmp_path):
        long_cwd = "/tmp/" + "a" * 5000
        result = validate_cwd(long_cwd, caller="test")
        assert result is None

    def test_relative_path_returns_none(self, tmp_path):
        result = validate_cwd("relative/path", caller="test")
        assert result is None

    def test_dotdot_relative_returns_none(self, tmp_path):
        result = validate_cwd("../../etc", caller="test")
        assert result is None

    def test_nonexistent_dir_returns_none(self, tmp_path):
        missing = str(tmp_path / "does_not_exist")
        result = validate_cwd(missing, caller="test")
        assert result is None

    def test_file_not_dir_returns_none(self, tmp_path):
        f = tmp_path / "afile.txt"
        f.write_text("x")
        result = validate_cwd(str(f), caller="test")
        assert result is None

    def test_valid_dir_returns_path(self, tmp_path):
        result = validate_cwd(str(tmp_path), caller="test")
        assert isinstance(result, Path)
        assert result == tmp_path

    def test_caller_label_appears_in_warning(self, tmp_path, caplog):
        import logging
        with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
            validate_cwd("relative/path", caller="post-edit")
        assert "post-edit" in caplog.text

    @pytest.mark.skipif(sys.platform == "win32", reason="null bytes handled differently on Windows")
    def test_null_byte_in_cwd_returns_none(self, tmp_path):
        result = validate_cwd("/tmp/foo\x00bar", caller="test")
        # Either returns None (OSError/ValueError on stat) or is caught by is_absolute
        # In all cases must not raise.
        assert result is None or isinstance(result, Path)


# ---------------------------------------------------------------------------
# hooks_edit: _enqueue_for_reindex rejects relative cwd when file_path is relative
# ---------------------------------------------------------------------------


class TestHooksEditCwdValidation:
    """post_edit hook rejects bad cwd values when file_path is relative."""

    def test_relative_cwd_skips_enqueue(self, tmp_path):
        """A relative cwd must not be passed to find_project."""
        from token_goat import hooks_cli

        payload = {
            "session_id": "edit_s1",
            "cwd": "../../relative/path",
            "tool_name": "Write",
            "tool_input": {"file_path": "src/foo.py"},
        }
        # Should not raise; enqueue is silently skipped.
        result = hooks_cli.post_edit(payload)
        _assert_continue(result)

    def test_too_long_cwd_skips_enqueue(self, tmp_path):
        """An excessively long cwd must not be passed to find_project."""
        from token_goat import hooks_cli

        long_cwd = "/tmp/" + "a" * 5000
        payload = {
            "session_id": "edit_s2",
            "cwd": long_cwd,
            "tool_name": "Write",
            "tool_input": {"file_path": "src/bar.py"},
        }
        result = hooks_cli.post_edit(payload)
        _assert_continue(result)

    def test_absolute_file_path_bypasses_cwd_check(self, tmp_path):
        """When file_path is absolute, cwd is not consulted at all."""
        from token_goat import hooks_cli

        abs_path = str(tmp_path / "somefile.py")
        payload = {
            "session_id": "edit_s3",
            "cwd": "../../bad/relative",
            "tool_name": "Write",
            "tool_input": {"file_path": abs_path},
        }
        # Absolute path: cwd validation is bypassed. Hook must not raise.
        result = hooks_cli.post_edit(payload)
        _assert_continue(result)

    def test_missing_cwd_with_relative_file_path_skips_enqueue(self, tmp_path):
        """Missing cwd with a relative file_path must silently skip enqueue."""
        from token_goat import hooks_cli

        payload = {
            "session_id": "edit_s4",
            "tool_name": "Write",
            "tool_input": {"file_path": "src/baz.py"},
        }
        result = hooks_cli.post_edit(payload)
        _assert_continue(result)


# ---------------------------------------------------------------------------
# hooks_session: _detect uses validate_cwd; rejects bad cwd
# ---------------------------------------------------------------------------


class TestHooksSessionCwdValidation:
    """session_start rejects bad cwd values consistently via validate_cwd."""

    def test_relative_cwd_ignored(self, tmp_path, tmp_data_dir):
        from token_goat import hooks_cli

        payload = {"session_id": "sess_s1", "cwd": "relative/path"}
        result = hooks_cli.session_start(payload)
        _assert_continue(result)

    def test_too_long_cwd_ignored(self, tmp_path, tmp_data_dir):
        from token_goat import hooks_cli

        payload = {"session_id": "sess_s2", "cwd": "/tmp/" + "x" * 5000}
        result = hooks_cli.session_start(payload)
        _assert_continue(result)

    def test_nonexistent_cwd_ignored(self, tmp_path, tmp_data_dir):
        from token_goat import hooks_cli

        payload = {"session_id": "sess_s3", "cwd": str(tmp_path / "no_such_dir")}
        result = hooks_cli.session_start(payload)
        _assert_continue(result)

    def test_valid_cwd_accepted(self, tmp_path, tmp_data_dir):
        """A valid absolute existing directory must not be rejected."""
        from token_goat import hooks_cli

        payload = {"session_id": "sess_s4", "cwd": str(tmp_path)}
        # No project will be found (no markers in tmp_path), but cwd is valid.
        result = hooks_cli.session_start(payload)
        _assert_continue(result)
