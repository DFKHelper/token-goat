"""Tests for token_goat.util helpers."""
from __future__ import annotations

import io
import logging
import pathlib
import re
from unittest import mock

from token_goat.util import (
    configure_stdout_encoding,
    ellipsize,
    get_logger,
    sanitize_control_chars,
    strip_ansi,
    utf8_bytes,
)


def test_get_logger_name() -> None:
    """get_logger("foo") returns a Logger whose name is "token_goat.foo"."""
    log = get_logger("foo")
    assert log.name == "token_goat.foo"

def test_get_logger_returns_logger_instance() -> None:
    """get_logger returns a stdlib Logger."""
    log = get_logger("bar")
    assert isinstance(log, logging.Logger)

def test_get_logger_same_instance() -> None:
    """Repeated calls with the same name return the same Logger object."""
    assert get_logger("baz") is get_logger("baz")

def test_get_logger_dotted_name() -> None:
    """Dotted sub-module names are preserved verbatim after the prefix."""
    log = get_logger("languages.html")
    assert log.name == "token_goat.languages.html"

def test_no_bare_git_subprocess_calls_outside_util() -> None:
    """All git invocations must go through util.run_git for consistent kwargs + lock-avoidance."""
    src = pathlib.Path("src/token_goat")
    pattern = re.compile(r'subprocess\.run\s*\(\s*\[\s*["\']git["\']')
    offenders = []
    for py_file in src.rglob("*.py"):
        if py_file.name == "util.py":  # the canonical implementation lives here
            continue
        text = py_file.read_text(encoding="utf-8")
        for m in pattern.finditer(text):
            offenders.append(f"{py_file}:{text[:m.start()].count(chr(10))+1}")
    assert not offenders, (
        f"Bare git subprocess.run found outside util.py: {offenders}. Use util.run_git instead."
    )

class TestEllipsize:
    """ellipsize(s, max_chars) truncates with trailing … when over budget."""

    def test_short_string_unchanged(self) -> None:
        assert ellipsize("hello", 10) == "hello"

    def test_exact_length_unchanged(self) -> None:
        assert ellipsize("hello", 5) == "hello"

    def test_over_budget_truncated(self) -> None:
        result = ellipsize("hello world", 8)
        assert result == "hello w…"
        assert len(result) == 8

    def test_one_over_budget(self) -> None:
        result = ellipsize("abcde", 4)
        assert result == "abc…"
        assert len(result) == 4

    def test_empty_string_unchanged(self) -> None:
        assert ellipsize("", 5) == ""

    def test_result_length_is_max_chars(self) -> None:
        for n in (1, 5, 10, 20):
            s = "x" * (n + 5)
            result = ellipsize(s, n)
            assert len(result) == n, f"max_chars={n} gave length {len(result)}"

    def test_trailing_ellipsis_char(self) -> None:
        result = ellipsize("abcdef", 3)
        assert result.endswith("…")

    def test_max_chars_one(self) -> None:
        result = ellipsize("abc", 1)
        assert result == "…"

class TestStripAnsiUtil:
    """strip_ansi is importable from util and removes ANSI escape sequences."""

    def test_removes_sgr_codes(self) -> None:
        """Basic SGR colour codes are stripped."""
        assert strip_ansi("\x1b[31mred\x1b[0m") == "red"

    def test_removes_truecolor_codes(self) -> None:
        """24-bit truecolor codes (lefthook/delta style) are stripped."""
        text = "\x1b[38;2;56;56;56m╭─────────────\x1b[m"
        assert strip_ansi(text) == "╭─────────────"

    def test_removes_osc_sequences(self) -> None:
        """OSC title/hyperlink sequences are stripped."""
        assert strip_ansi("\x1b]0;window title\x07after") == "after"

    def test_idempotent(self) -> None:
        """Applying strip_ansi twice produces the same result as once."""
        text = "\x1b[1mbold\x1b[0m plain"
        once = strip_ansi(text)
        assert strip_ansi(once) == once

    def test_empty_string(self) -> None:
        """strip_ansi of an empty string returns an empty string."""
        assert strip_ansi("") == ""

    def test_plain_text_unchanged(self) -> None:
        """Plain text without escape sequences is returned unchanged."""
        assert strip_ansi("hello world") == "hello world"

    def test_is_same_object_as_render_ansi(self) -> None:
        """util.strip_ansi must re-export the same function as render.ansi.strip_ansi."""
        from token_goat.render.ansi import strip_ansi as render_strip
        assert strip_ansi is render_strip

    def test_fast_path_no_escape_byte(self) -> None:
        """Plain text with no ESC byte returns immediately without regex."""
        # This test validates the performance optimization — plain text
        # should return unchanged without running the regex engine.
        text = "hello world 123 !@# $%^&*()"
        result = strip_ansi(text)
        assert result is text  # Same object (early return)

    def test_hyperlink_osc_stripped(self) -> None:
        """OSC hyperlink sequences are stripped, leaving only visible text."""
        # Format: OSC 8 hyperlink is \x1b]8;;URL\x07text\x1b]8;;\x07
        text = "\x1b]8;;https://example.com\x07click me\x1b]8;;\x07"
        assert strip_ansi(text) == "click me"

    def test_multiple_hyperlinks(self) -> None:
        """Multiple hyperlinks in one string are all stripped."""
        text = "\x1b]8;;http://a.com\x07link1\x1b]8;;\x07 and \x1b]8;;http://b.com\x07link2\x1b]8;;\x07"
        assert strip_ansi(text) == "link1 and link2"

    def test_hyperlink_with_bel_terminator(self) -> None:
        """OSC sequences using BEL (\\x07) as terminator are handled."""
        text = "prefix \x1b]8;;http://example.com\x07link\x1b]8;;\x07 suffix"
        assert strip_ansi(text) == "prefix link suffix"

    def test_hyperlink_with_st_terminator(self) -> None:
        """OSC sequences using ST (ESC \\) as terminator are handled."""
        text = "prefix \x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\ suffix"
        assert strip_ansi(text) == "prefix link suffix"

    def test_pua_characters_stripped_with_ansi(self) -> None:
        """PUA characters are stripped when ANSI escapes are present."""
        # PUA stripping is implemented alongside ANSI stripping, so
        # PUA chars are only removed when there are also ANSI escapes.
        # This is a design tradeoff: checking for PUA alone would negate the fast-path speedup.
        text = "[32m" + chr(0xE000) + "green[0m"
        result = strip_ansi(text)
        assert result == "green"
        assert chr(0xE000) not in result

    def test_supplementary_pua_stripped_with_ansi(self) -> None:
        """Supplementary PUA characters are stripped when ANSI escapes are present."""
        # U+F0000 is at the boundary of supplementary PUA range (U+F0000-U+FFFDD)
        text = "[31m" + chr(0xF0000) + "red[0m"
        result = strip_ansi(text)
        assert result == "red"
        assert chr(0xF0000) not in result

    def test_pua_in_ansi_rich_output(self) -> None:
        """PUA characters mixed with ANSI codes are both stripped."""
        text = "[32mgreen[0m" + chr(0xE500) + "[1micon[0m"
        result = strip_ansi(text)
        assert result == "greenicon"
        assert "" not in result
        assert chr(0xE500) not in result

    def test_preserves_non_pua_unicode(self) -> None:
        """Non-PUA Unicode characters like emoji are preserved."""
        text = "test ✓ success 🎉"
        assert strip_ansi(text) == text

    def test_osc_with_semicolon_parameters(self) -> None:
        """OSC sequences with parameters are stripped correctly."""
        # OSC 9 (iTerm2 growl notifications) with parameters
        text = "\x1b]9;4;1;Title\x07body text"
        result = strip_ansi(text)
        # The OSC sequence should be gone, only the body text remains
        assert "Title" not in result
        assert "body text" in result

class TestSanitizeControlChars:
    """sanitize_control_chars removes non-printable control characters."""

    def test_removes_c0_control_chars(self) -> None:
        """C0 control characters (U+0000–U+001F except tabs/newlines) are stripped."""
        # Bell (0x07), backspace (0x08), form feed (0x0C), shift-in (0x0F)
        text = "hello\x07world\x08test\x0cform\x0fout"
        result = sanitize_control_chars(text)
        assert result == "helloworldtestformout"

    def test_preserves_tab(self) -> None:
        """Tab character (U+0009) is preserved."""
        text = "hello\tworld"
        assert sanitize_control_chars(text) == text

    def test_preserves_newline(self) -> None:
        """Newline character (U+000A) is preserved."""
        text = "hello\nworld"
        assert sanitize_control_chars(text) == text

    def test_preserves_carriage_return(self) -> None:
        """Carriage return character (U+000D) is preserved."""
        text = "hello\rworld"
        assert sanitize_control_chars(text) == text

    def test_removes_c1_control_chars(self) -> None:
        """C1 control characters (U+0080–U+009F) are stripped."""
        # NEL (0x85), IND (0x84), HTS (0x88)
        text = "hello\x85world\x84test\x88form"
        result = sanitize_control_chars(text)
        assert result == "helloworldtestform"

    def test_preserves_box_drawing_chars(self) -> None:
        """Box-drawing characters (U+2500–U+257F) are preserved."""
        # Horizontal line, vertical line, corners, etc.
        text = "╭─────────────╮\n│ content    │\n╰─────────────╯"
        result = sanitize_control_chars(text)
        assert result == text

    def test_preserves_unicode_emoji(self) -> None:
        """Multi-byte Unicode characters like emoji are preserved."""
        text = "test ✓ success"
        assert sanitize_control_chars(text) == text

    def test_mixed_control_and_valid_chars(self) -> None:
        """Mix of control chars and valid text is handled correctly."""
        text = "hello\x00world\x07test\tgood\nend"
        result = sanitize_control_chars(text)
        assert result == "helloworldtest\tgood\nend"

    def test_idempotent(self) -> None:
        """Applying sanitize_control_chars twice produces the same result."""
        text = "hello\x00world\x07test"
        once = sanitize_control_chars(text)
        twice = sanitize_control_chars(once)
        assert twice == once

    def test_empty_string(self) -> None:
        """Empty string returns empty string."""
        assert sanitize_control_chars("") == ""

    def test_plain_text_unchanged(self) -> None:
        """Plain ASCII text without control chars is unchanged."""
        assert sanitize_control_chars("hello world") == "hello world"

    def test_null_byte_removed(self) -> None:
        """Null byte (U+0000) is removed."""
        assert sanitize_control_chars("hel\x00lo") == "hello"

    def test_all_tabs_newlines_preserved(self) -> None:
        """Tabs and newlines together are preserved."""
        text = "a\tb\nc\td\n"
        assert sanitize_control_chars(text) == text

    def test_cjk_characters_preserved(self) -> None:
        """CJK (East Asian) characters are preserved."""
        text = "hello 中文 world"
        assert sanitize_control_chars(text) == text

class TestConfigureStdoutEncoding:
    """configure_stdout_encoding reconfigures stdout/stderr for UTF-8."""

    def test_noop_when_stdout_none(self) -> None:
        """No error when stdout is None."""
        with mock.patch("sys.stdout", None):
            # Should not raise
            configure_stdout_encoding()

    def test_noop_when_no_reconfigure_method(self) -> None:
        """No error when stdout has no reconfigure method."""
        fake_stdout = io.StringIO()
        # StringIO doesn't have reconfigure
        with mock.patch("sys.stdout", fake_stdout):
            # Should not raise
            configure_stdout_encoding()

    def test_calls_reconfigure_on_stdout(self) -> None:
        """reconfigure is called on stdout when available."""
        fake_stdout = mock.MagicMock()
        fake_stdout.reconfigure = mock.MagicMock()
        with mock.patch("sys.stdout", fake_stdout):
            configure_stdout_encoding()
            fake_stdout.reconfigure.assert_called_once_with(encoding="utf-8", errors="replace")

    def test_calls_reconfigure_on_stderr(self) -> None:
        """reconfigure is called on stderr when available."""
        fake_stderr = mock.MagicMock()
        fake_stderr.reconfigure = mock.MagicMock()
        with mock.patch("sys.stderr", fake_stderr):
            configure_stdout_encoding()
            fake_stderr.reconfigure.assert_called_once_with(encoding="utf-8", errors="replace")

    def test_handles_oserror(self) -> None:
        """OSError from reconfigure is silently caught."""
        fake_stdout = mock.MagicMock()
        fake_stdout.reconfigure = mock.MagicMock(side_effect=OSError("test error"))
        with mock.patch("sys.stdout", fake_stdout):
            # Should not raise
            configure_stdout_encoding()

    def test_handles_attribute_error(self) -> None:
        """AttributeError from reconfigure is silently caught."""
        fake_stdout = mock.MagicMock()
        fake_stdout.reconfigure = mock.MagicMock(side_effect=AttributeError("test error"))
        with mock.patch("sys.stdout", fake_stdout):
            # Should not raise
            configure_stdout_encoding()

    def test_continues_on_first_failure(self) -> None:
        """If stdout reconfigure fails, stderr reconfigure still runs."""
        fake_stdout = mock.MagicMock()
        fake_stdout.reconfigure = mock.MagicMock(side_effect=OSError("stdout broken"))
        fake_stderr = mock.MagicMock()
        fake_stderr.reconfigure = mock.MagicMock()
        with mock.patch("sys.stdout", fake_stdout), mock.patch("sys.stderr", fake_stderr):
            configure_stdout_encoding()
            # Both should have been called even though stdout failed
            fake_stdout.reconfigure.assert_called_once()
            fake_stderr.reconfigure.assert_called_once()

class TestUtf8Bytes:
    """utf8_bytes(s) encodes a str to UTF-8 bytes with surrogate replacement."""

    def test_ascii_string(self) -> None:
        """ASCII strings encode to identical bytes."""
        assert utf8_bytes("hello") == b"hello"

    def test_empty_string(self) -> None:
        """Empty string encodes to empty bytes."""
        assert utf8_bytes("") == b""

    def test_multibyte_unicode(self) -> None:
        """Multi-byte characters are encoded correctly."""
        # 'é' is 2 bytes in UTF-8; 'café' is 5 bytes
        assert utf8_bytes("café") == "café".encode()
        assert len(utf8_bytes("café")) == 5

    def test_emoji(self) -> None:
        """4-byte emoji characters are encoded correctly."""
        result = utf8_bytes("hi 🎉")
        assert result == "hi 🎉".encode()
        assert len(result) == 7  # 2 + 1 (space) + 4 (emoji)

    def test_return_type_is_bytes(self) -> None:
        """Return type is always bytes."""
        assert isinstance(utf8_bytes("test"), bytes)

    def test_surrogate_replaced_not_raised(self) -> None:
        """Lone surrogates (from subprocess surrogate-escape) are replaced, not raised."""
        # Python's surrogate-escape mechanism produces \\udcXX chars which are
        # not valid Unicode code points.  utf8_bytes must not raise UnicodeEncodeError.
        surrogate_str = "\udcff\udcfe"
        # Must not raise — the key invariant is no UnicodeEncodeError.
        result = utf8_bytes(surrogate_str)
        assert isinstance(result, bytes)
        # Each surrogate is replaced (exact replacement byte depends on platform
        # and Python version; we only assert no exception and valid bytes output).
        assert len(result) >= 2  # at least one byte per surrogate

    def test_byte_length_matches_encode(self) -> None:
        """len(utf8_bytes(s)) always equals len(s.encode('utf-8', errors='replace'))."""
        samples = ["", "hello", "café", "日本語", "hi 🎉", "line1\nline2"]
        for s in samples:
            assert len(utf8_bytes(s)) == len(s.encode("utf-8", errors="replace"))

    def test_in_all(self) -> None:
        """utf8_bytes is exported via __all__ in util."""
        from token_goat import util
        assert "utf8_bytes" in util.__all__
