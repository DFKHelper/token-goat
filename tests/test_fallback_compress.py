"""Tests for _fallback_truncate and _cap_long_lines improvements.

Verifies that:
1. _fallback_truncate collapses consecutive identical lines before truncating,
   so more unique signal fits in the line budget.
2. _cap_long_lines truncates pathologically long individual lines with an
   inline marker, keeping byte usage bounded.
"""

from token_goat.bash_compress import (
    _FALLBACK_MAX_LINE_CHARS,
    _cap_long_lines,
    _fallback_truncate,
)

# ---------------------------------------------------------------------------
# _cap_long_lines
# ---------------------------------------------------------------------------

class TestCapLongLines:
    def test_short_lines_unchanged(self):
        lines = ["hello", "world", "a" * 100]
        assert _cap_long_lines(lines) == lines

    def test_long_line_is_capped(self):
        long = "x" * 500
        result = _cap_long_lines([long])
        assert len(result) == 1
        assert result[0].startswith("x" * _FALLBACK_MAX_LINE_CHARS)
        assert "chars elided" in result[0]

    def test_long_line_truncated_to_max_chars_prefix(self):
        long = "A" * 600
        result = _cap_long_lines([long], max_chars=200)
        assert result[0][:200] == "A" * 200
        assert "400 chars elided" in result[0]

    def test_exact_boundary_not_capped(self):
        line = "B" * _FALLBACK_MAX_LINE_CHARS
        result = _cap_long_lines([line])
        assert result == [line]

    def test_one_over_boundary_is_capped(self):
        line = "C" * (_FALLBACK_MAX_LINE_CHARS + 1)
        result = _cap_long_lines([line])
        assert "chars elided" in result[0]

    def test_empty_list(self):
        assert _cap_long_lines([]) == []

    def test_mixed_lines(self):
        short = "ok"
        long = "Z" * 800
        result = _cap_long_lines([short, long, short])
        assert result[0] == short
        assert "chars elided" in result[1]
        assert result[2] == short

    def test_custom_max_chars(self):
        lines = ["a" * 10, "b" * 20]
        result = _cap_long_lines(lines, max_chars=15)
        assert result[0] == "a" * 10
        assert result[1].startswith("b" * 15)
        assert "5 chars elided" in result[1]


# ---------------------------------------------------------------------------
# _fallback_truncate: dedup before truncation
# ---------------------------------------------------------------------------

class TestFallbackTruncateDedup:
    def test_consecutive_identical_lines_collapsed(self):
        # 20 identical lines should collapse to 1 summary line, so truncation
        # fires much later and preserves unique content.
        repeated = "\n".join(["error: file not found"] * 20)
        result = _fallback_truncate(repeated, "", max_lines=10)
        # The collapsed summary should appear instead of 20 raw copies.
        assert "(×20)" in result or "(×" in result

    def test_unique_lines_preserved_within_budget(self):
        unique_lines = [f"line {i}" for i in range(8)]
        stdout = "\n".join(unique_lines)
        result = _fallback_truncate(stdout, "", max_lines=20)
        for line in unique_lines:
            assert line in result

    def test_stderr_separator_present(self):
        result = _fallback_truncate("out", "err", max_lines=10)
        assert "---" in result
        assert "out" in result
        assert "err" in result

    def test_empty_stderr_no_separator(self):
        result = _fallback_truncate("just stdout", "", max_lines=10)
        assert "---" not in result

    def test_long_lines_capped_before_counting(self):
        # A very long line should be capped so its character count doesn't
        # inflate the byte budget before the line-count truncation.
        long_line = "X" * 2000
        stdout = "\n".join([long_line] * 5 + ["short line"])
        result = _fallback_truncate(stdout, "", max_lines=20)
        # The long line should have been capped
        assert "chars elided" in result
        assert "short line" in result

    def test_dedup_expands_effective_line_budget(self):
        # 100 identical lines deduped to 1. After dedup we have 1 noise + 4 unique = 5 lines.
        # max_lines=12 → max_lines//2=6 per stream, which fits all 5 lines without elision.
        # Without dedup, 104 lines with budget 6 would elide all the unique lines.
        noise = ["same warning"] * 100
        unique = [f"unique_{i}" for i in range(4)]
        stdout = "\n".join(noise + unique)
        result = _fallback_truncate(stdout, "", max_lines=12)
        # After dedup the noise collapses; all unique lines should be present.
        for u in unique:
            assert u in result

    def test_empty_streams(self):
        result = _fallback_truncate("", "", max_lines=10)
        assert result == ""
