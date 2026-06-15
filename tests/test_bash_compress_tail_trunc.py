"""Tests for TailTruncFilter — safety-net last-resort tail truncation."""
from __future__ import annotations

from token_goat.bash_compress import FILTERS, TailTruncFilter


def _make_stdout(n_lines: int) -> str:
    return "\n".join(f"line {i}" for i in range(n_lines))


class TestTailTruncFilter:
    def setup_method(self) -> None:
        self.flt = TailTruncFilter()

    def test_over_500_lines_truncated(self) -> None:
        stdout = _make_stdout(600)
        result = self.flt.compress(stdout, "", 0, ["somecommand"])
        lines = result.split("\n")
        assert any("lines suppressed" in ln for ln in lines)
        assert "TOKEN_GOAT_BASH_COMPRESS=0" in result

    def test_exactly_501_lines_truncated(self) -> None:
        stdout = _make_stdout(501)
        result = self.flt.compress(stdout, "", 0, ["somecommand"])
        assert "lines suppressed" in result

    def test_exactly_500_lines_passthrough(self) -> None:
        stdout = _make_stdout(500)
        result = self.flt.compress(stdout, "", 0, ["somecommand"])
        assert "lines suppressed" not in result
        assert result == stdout

    def test_under_500_lines_passthrough(self) -> None:
        stdout = _make_stdout(100)
        result = self.flt.compress(stdout, "", 0, ["somecommand"])
        assert result == stdout

    def test_empty_stdout_passthrough(self) -> None:
        result = self.flt.compress("", "", 0, ["cmd"])
        assert result == ""

    def test_suppressed_count_is_correct(self) -> None:
        n = 700
        stdout = _make_stdout(n)
        result = self.flt.compress(stdout, "", 0, ["cmd"])
        expected_suppressed = n - 100
        assert f"{expected_suppressed} lines suppressed" in result

    def test_first_50_lines_preserved(self) -> None:
        stdout = _make_stdout(600)
        result = self.flt.compress(stdout, "", 0, ["cmd"])
        assert "line 0" in result
        assert "line 49" in result

    def test_last_50_lines_preserved(self) -> None:
        stdout = _make_stdout(600)
        result = self.flt.compress(stdout, "", 0, ["cmd"])
        assert "line 550" in result
        assert "line 599" in result

    def test_middle_lines_suppressed(self) -> None:
        stdout = _make_stdout(600)
        result = self.flt.compress(stdout, "", 0, ["cmd"])
        assert "line 50" not in result.split("[")[0]  # before marker
        assert "line 549" not in result.split("]")[-1]  # after marker

    def test_output_line_count_is_101(self) -> None:
        # 50 head + 1 marker + 50 tail = 101 lines
        stdout = _make_stdout(600)
        result = self.flt.compress(stdout, "", 0, ["cmd"])
        assert len(result.split("\n")) == 101

    def test_matches_always_returns_true(self) -> None:
        assert self.flt.matches([]) is True
        assert self.flt.matches(["anything"]) is True
        assert self.flt.matches(["python", "-m", "pytest"]) is True

    def test_binaries_is_empty_frozenset(self) -> None:
        assert TailTruncFilter.binaries == frozenset()

    def test_is_last_in_filters(self) -> None:
        assert isinstance(FILTERS[-1], TailTruncFilter)

    def test_only_one_tail_trunc_filter_in_filters(self) -> None:
        tail_filters = [f for f in FILTERS if isinstance(f, TailTruncFilter)]
        assert len(tail_filters) == 1
