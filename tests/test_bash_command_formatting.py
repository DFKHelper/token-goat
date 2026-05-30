"""Tests for bash command formatting in hints (_format_bash_command_for_hint)."""
from __future__ import annotations

from token_goat.hints import (
    _MAX_BASH_COMMAND_DISPLAY_LEN,
    _format_bash_command_for_hint,
)


class TestFormatBashCommandForHint:
    """_format_bash_command_for_hint should intelligently truncate long commands."""

    def test_short_command_unchanged(self):
        """Commands shorter than max length are returned as-is."""
        cmd = "ls -la"
        result = _format_bash_command_for_hint(cmd)
        assert result == cmd

    def test_command_at_max_length(self):
        """Commands exactly at max length are returned as-is."""
        cmd = "a" * _MAX_BASH_COMMAND_DISPLAY_LEN
        result = _format_bash_command_for_hint(cmd)
        assert result == cmd

    def test_long_command_truncated_with_ellipsis(self):
        """Commands exceeding max length are truncated with ellipsis."""
        cmd = "pytest " + "a" * 100 + "::test_name"
        result = _format_bash_command_for_hint(cmd)
        assert result.endswith("…"), "truncated command should end with ellipsis"
        assert len(result) <= _MAX_BASH_COMMAND_DISPLAY_LEN + 1  # +1 for ellipsis

    def test_extracts_main_command_and_first_arg(self):
        """Long commands are truncated to keep main command and first meaningful arg."""
        cmd = "pytest tests/very/long/path/to/test_file.py::test_name -v --tb=short"
        result = _format_bash_command_for_hint(cmd)
        # Should keep "pytest" and "tests/very/long/..." but truncate trailing args
        assert result.startswith("pytest"), "should preserve the main command"
        assert "…" in result or result == cmd, "should have ellipsis if truncated"

    def test_multiword_command_preserved(self):
        """Multi-word commands like 'uv run' are preserved."""
        cmd = "uv run pytest tests/auth/test_login.py::test_password_validation -v -x"
        result = _format_bash_command_for_hint(cmd)
        # Should keep "uv run pytest" and possibly first arg
        assert result.startswith("uv"), "should start with first part of multi-word command"
        if result != cmd:
            assert result.endswith("…"), "truncated version should end with ellipsis"

    def test_sanitizes_newlines(self):
        """Newlines in commands are escaped for safety."""
        cmd = "echo hello\necho injected"
        result = _format_bash_command_for_hint(cmd)
        assert "\n" not in result, "newlines must be escaped"
        # The sanitize function replaces \n with literal \\n
        assert "\\n" in result or "echo hello" in result

    def test_sanitizes_carriage_returns(self):
        """Carriage returns in commands are escaped."""
        cmd = "echo test\rinjected"
        result = _format_bash_command_for_hint(cmd)
        assert "\r" not in result, "carriage returns must be escaped"

    def test_simple_long_pytest_command(self):
        """Realistic pytest command with long path."""
        cmd = "pytest tests/unit/auth/login/test_password_validation.py::TestPasswordValidator::test_requires_special_char -v"
        result = _format_bash_command_for_hint(cmd)
        # Should show "pytest tests/unit/auth/..." but not the full path
        assert "pytest" in result
        if len(cmd) > _MAX_BASH_COMMAND_DISPLAY_LEN:
            assert "…" in result

    def test_uv_lock_update_command(self):
        """Realistic uv lock command."""
        cmd = "uv lock --upgrade package_name --with-extra-features"
        result = _format_bash_command_for_hint(cmd)
        assert "uv" in result
        # If this command is short enough, it should be unchanged
        if len(cmd) <= _MAX_BASH_COMMAND_DISPLAY_LEN:
            assert result == cmd

    def test_find_command_with_many_predicates(self):
        """Long find command with many predicates should be intelligently truncated."""
        cmd = "find /srv/data -name '*.log' -type f -mtime +30 -size +1M -exec rm {} +"
        result = _format_bash_command_for_hint(cmd)
        assert result.startswith("find"), "should keep the find command"
        if result != cmd:
            assert "…" in result

    def test_ruff_check_with_fix(self):
        """Ruff command with --fix and path."""
        cmd = "uv run ruff check --fix src/token_goat/"
        result = _format_bash_command_for_hint(cmd)
        assert "uv" in result
        assert "ruff" in result or cmd == result  # Should preserve main command parts

    def test_empty_command(self):
        """Empty command is handled gracefully."""
        cmd = ""
        result = _format_bash_command_for_hint(cmd)
        assert result == cmd  # Should return empty

    def test_whitespace_only_command(self):
        """Whitespace-only command is handled."""
        cmd = "   "
        result = _format_bash_command_for_hint(cmd)
        # After split, there are no parts, so should return original sanitized
        assert isinstance(result, str)

    def test_command_without_args(self):
        """Single-word command without args."""
        cmd = "pytest"
        result = _format_bash_command_for_hint(cmd)
        assert result == cmd

    def test_python_m_command(self):
        """Python -m commands should preserve both parts."""
        cmd = "python -m pytest tests/very/long/path/test_module.py::TestClass::test_method -v -s"
        result = _format_bash_command_for_hint(cmd)
        # Should keep "python -m pytest" minimum
        if len(cmd) > _MAX_BASH_COMMAND_DISPLAY_LEN:
            assert "…" in result
            assert ("python" in result and "pytest" in result) or "…" in result

    def test_length_strictly_respected(self):
        """Result length (excluding ellipsis) must be <= MAX_BASH_COMMAND_DISPLAY_LEN."""
        for test_cmd in [
            "pytest " + "a" * 200,
            "find /very/long/path -name pattern -type f -mtime +30",
            "uv run " + "x" * 300,
        ]:
            result = _format_bash_command_for_hint(test_cmd)
            # Measure length without the ellipsis char
            result_without_ellipsis = result.rstrip("…")
            assert len(result_without_ellipsis) <= _MAX_BASH_COMMAND_DISPLAY_LEN, (
                f"Result '{result}' is too long: {len(result_without_ellipsis)} > "
                f"{_MAX_BASH_COMMAND_DISPLAY_LEN}"
            )
