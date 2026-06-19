"""Tests for the logfold command — log line compressor."""
from __future__ import annotations

from token_goat.logfold import FoldResult, fold_log, format_fold_text

# ---------------------------------------------------------------------------
# fold_log — core logic
# ---------------------------------------------------------------------------


class TestExactDuplicates:
    def test_single_run(self):
        r = fold_log("a\na\na\n")
        assert r.lines == ["[3x] a"]

    def test_mixed_runs(self):
        r = fold_log("a\na\nb\nb\nb\nc\n")
        assert r.lines == ["[2x] a", "[3x] b", "c"]

    def test_no_duplicates(self):
        r = fold_log("a\nb\nc\n")
        assert r.lines == ["a", "b", "c"]

    def test_single_line(self):
        r = fold_log("only\n")
        assert r.lines == ["only"]

    def test_empty_input(self):
        r = fold_log("")
        assert r.lines == []


class TestNormalization:
    def test_collapses_timestamp_variants(self):
        lines = (
            "2024-01-01T10:00:00Z INFO started\n"
            "2024-01-01T10:00:01Z INFO started\n"
            "2024-01-01T10:00:02Z INFO started\n"
        )
        r = fold_log(lines, normalize=True)
        assert len(r.lines) == 1
        assert r.lines[0].startswith("[3x]")

    def test_collapses_uuid_variants(self):
        lines = (
            "req 550e8400-e29b-41d4-a716-446655440000 processed\n"
            "req 6ba7b810-9dad-11d1-80b4-00c04fd430c8 processed\n"
        )
        r = fold_log(lines, normalize=True)
        assert len(r.lines) == 1

    def test_no_normalize_keeps_distinct(self):
        lines = "10:00:00 INFO start\n10:00:01 INFO start\n"
        r = fold_log(lines, normalize=False)
        assert len(r.lines) == 2

    def test_ip_normalization(self):
        lines = "connection from 1.2.3.4\nconnection from 5.6.7.8\n"
        r = fold_log(lines, normalize=True)
        assert len(r.lines) == 1


class TestTail:
    def test_tail_limits_output(self):
        text = "\n".join(str(i) for i in range(20)) + "\n"
        r = fold_log(text, tail=5)
        assert len(r.lines) == 5

    def test_tail_zero_no_limit(self):
        text = "\n".join(str(i) for i in range(10)) + "\n"
        r = fold_log(text, tail=None)
        assert len(r.lines) == 10


class TestStats:
    def test_reduction_pct(self):
        r = fold_log("x\n" * 10)
        assert r.reduction_pct == 90

    def test_original_count(self):
        r = fold_log("a\nb\nc\n")
        assert r.original_count == 3

    def test_zero_reduction(self):
        r = fold_log("a\nb\nc\n")
        assert r.reduction_pct == 0


# ---------------------------------------------------------------------------
# format_fold_text
# ---------------------------------------------------------------------------


class TestFormatFoldText:
    def test_includes_reduction_note(self):
        r = fold_log("x\n" * 5)
        out = format_fold_text(r)
        assert "reduction" in out and "%" in out

    def test_empty_placeholder(self):
        r = FoldResult(lines=[], original_count=0, output_count=0)
        assert format_fold_text(r) == "(empty)"

    def test_body_before_note(self):
        r = fold_log("hello\nhello\n")
        out = format_fold_text(r)
        assert out.startswith("[2x] hello")
