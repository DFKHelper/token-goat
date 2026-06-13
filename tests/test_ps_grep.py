"""Tests for Windows/PowerShell grep-equivalent parsing in bash_parser.parse()."""

import pytest

from token_goat import bash_parser


class TestFindstrParse:
    @pytest.mark.parametrize(
        "command, expected_pattern, expected_path",
        [
            ('findstr "pattern" file.py', "pattern", "file.py"),
            ('findstr /i "hello" src/main.py', "hello", "src/main.py"),
            ('findstr /r /i "regex" file.txt', "regex", "file.txt"),
            # /c:"..." embeds the pattern; file.py is the target path
            ('findstr /c:"literal string" file.py', "literal string", "file.py"),
            # flag after positional pattern
            ('findstr "pattern" /i file.py', "pattern", "file.py"),
        ],
    )
    def test_findstr_produces_grep_intent(self, command: str, expected_pattern: str, expected_path: str | None) -> None:
        intent = bash_parser.parse(command)
        assert intent.kind == "grep"
        assert intent.pattern == expected_pattern
        assert intent.target_path == expected_path

    def test_findstr_no_args_returns_unknown(self) -> None:
        intent = bash_parser.parse("findstr")
        assert intent.kind == "unknown"

    def test_findstr_only_flags_returns_unknown(self) -> None:
        intent = bash_parser.parse("findstr /i /r")
        assert intent.kind == "unknown"


class TestFindstrParseEdgeCases:
    def test_help_flag_returns_unknown(self) -> None:
        intent = bash_parser._parse_findstr("findstr", ["/?"])
        assert intent.kind == "unknown"

    def test_c_flag_extracts_pattern(self) -> None:
        intent = bash_parser._parse_findstr("findstr", ["/c:hello world", "file.txt"])
        assert intent.kind == "grep"
        assert intent.pattern == "hello world"
        assert intent.target_path == "file.txt"

    def test_c_flag_uppercase(self) -> None:
        intent = bash_parser._parse_findstr("findstr", ["/C:error", "log.txt"])
        assert intent.kind == "grep"
        assert intent.pattern == "error"


class TestSelectStringParse:
    @pytest.mark.parametrize(
        "command, expected_pattern, expected_path",
        [
            ('sls "hello" file.py', "hello", "file.py"),
            ('Select-String "error" log.txt', "error", "log.txt"),
            ("Select-String -Pattern foo -Path bar.py", "foo", "bar.py"),
            ("sls -Pattern TODO src/main.py", "TODO", "src/main.py"),
            ('Select-String -CaseSensitive "Error" app.log', "Error", "app.log"),
            # -LiteralPath variant
            ("Select-String -Pattern foo -LiteralPath bar.py", "foo", "bar.py"),
        ],
    )
    def test_select_string_produces_grep_intent(self, command: str, expected_pattern: str, expected_path: str | None) -> None:
        intent = bash_parser.parse(command)
        assert intent.kind == "grep"
        assert intent.pattern == expected_pattern
        assert intent.target_path == expected_path

    def test_sls_no_args_returns_unknown(self) -> None:
        intent = bash_parser.parse("sls")
        assert intent.kind == "unknown"

    def test_select_string_only_flags_returns_unknown(self) -> None:
        intent = bash_parser.parse("Select-String -CaseSensitive")
        assert intent.kind == "unknown"
