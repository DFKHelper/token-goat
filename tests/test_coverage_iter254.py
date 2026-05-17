"""Tests for iter254: sanitize_log_str strips Unicode bidirectional control characters."""

from __future__ import annotations

from token_goat.hooks_common import sanitize_log_str

# ---------------------------------------------------------------------------
# Unicode bidirectional override stripping
# ---------------------------------------------------------------------------


class TestSanitizeLogStrBidiStripping:
    """sanitize_log_str must strip Unicode bidi control characters that can cause
    log viewers and terminals to display misleading text."""

    def test_strips_right_to_left_override(self):
        """U+202E RIGHT-TO-LEFT OVERRIDE must be removed."""
        # A classic bidi attack: U+202E makes "evil.exe" render as "exe.live"
        value = "evil‮.exe"
        result = sanitize_log_str(value)
        assert "‮" not in result
        assert result == "evil.exe"

    def test_strips_left_to_right_mark(self):
        """U+200E LEFT-TO-RIGHT MARK must be removed."""
        value = "path‎to/file"
        result = sanitize_log_str(value)
        assert "‎" not in result
        assert result == "pathto/file"

    def test_strips_right_to_left_mark(self):
        """U+200F RIGHT-TO-LEFT MARK must be removed."""
        value = "some‏value"
        result = sanitize_log_str(value)
        assert "‏" not in result
        assert result == "somevalue"

    def test_strips_left_to_right_embedding(self):
        """U+202A LEFT-TO-RIGHT EMBEDDING must be removed."""
        value = "‪embedded"
        result = sanitize_log_str(value)
        assert "‪" not in result
        assert result == "embedded"

    def test_strips_right_to_left_embedding(self):
        """U+202B RIGHT-TO-LEFT EMBEDDING must be removed."""
        value = "‫embedded"
        result = sanitize_log_str(value)
        assert "‫" not in result
        assert result == "embedded"

    def test_strips_pop_directional_formatting(self):
        """U+202C POP DIRECTIONAL FORMATTING must be removed."""
        value = "text‬more"
        result = sanitize_log_str(value)
        assert "‬" not in result
        assert result == "textmore"

    def test_strips_left_to_right_override(self):
        """U+202D LEFT-TO-RIGHT OVERRIDE must be removed."""
        value = "‭overridden"
        result = sanitize_log_str(value)
        assert "‭" not in result
        assert result == "overridden"

    def test_strips_left_to_right_isolate(self):
        """U+2066 LEFT-TO-RIGHT ISOLATE must be removed."""
        value = "⁦isolated"
        result = sanitize_log_str(value)
        assert "⁦" not in result
        assert result == "isolated"

    def test_strips_right_to_left_isolate(self):
        """U+2067 RIGHT-TO-LEFT ISOLATE must be removed."""
        value = "⁧isolated"
        result = sanitize_log_str(value)
        assert "⁧" not in result
        assert result == "isolated"

    def test_strips_first_strong_isolate(self):
        """U+2068 FIRST STRONG ISOLATE must be removed."""
        value = "⁨fsi"
        result = sanitize_log_str(value)
        assert "⁨" not in result
        assert result == "fsi"

    def test_strips_pop_directional_isolate(self):
        """U+2069 POP DIRECTIONAL ISOLATE must be removed."""
        value = "pdi⁩end"
        result = sanitize_log_str(value)
        assert "⁩" not in result
        assert result == "pdiend"

    def test_strips_multiple_bidi_chars_in_one_string(self):
        """Multiple bidi control characters in the same string are all removed."""
        value = "‪text‮‏more‬"
        result = sanitize_log_str(value)
        for ch in "‪‮‏‬":
            assert ch not in result
        assert result == "textmore"

    def test_bidi_stripping_and_newline_stripping_both_apply(self):
        """Bidi stripping and newline escaping both apply in the same call."""
        value = "line1\n‮line2"
        result = sanitize_log_str(value)
        assert "\n" not in result
        assert "\\n" in result
        assert "‮" not in result

    def test_clean_string_unmodified(self):
        """A string with no control characters passes through unchanged."""
        value = "normal/path/to/file.py"
        assert sanitize_log_str(value) == value

    def test_max_len_still_enforced_after_bidi_removal(self):
        """Truncation to max_len is applied after bidi characters are stripped."""
        # Build a string with bidi chars that, after stripping, exceeds max_len
        base = "a" * 50 + "‮" * 10
        result = sanitize_log_str(base, max_len=20)
        # bidi stripped → "a" * 50, then truncated to 20 + ellipsis
        assert len(result) <= 21  # 20 chars + "…"
        assert "‮" not in result
