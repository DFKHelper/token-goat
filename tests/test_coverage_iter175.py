"""Regression tests for iterations 171–174.

Coverage targets:
- install.py: _run_step typed as Callable[[], object] — callable invoked, return recorded
- read_replacement.py: _coerce_line / _coerce_end_line isinstance guards — int, None, non-int
- compact.py: _BY_READ_COUNT attrgetter — heapq.nlargest sorts by read_count correctly
- session.py: _merge_ranges len==1 fast path — single-range case works
- session.py: mark_grep — length cap at 200 truncates oversized patterns
- hints.py: _sanitize_hint_path — newlines and CR stripped from path in hint output
- render/stats_renderer.py: _strip_ansi() — ESC sequences stripped from project path
- paths.py: atomic_write_text — OSError during write cleans up tmp and re-raises
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

# ===========================================================================
# 1. install.py — _run_step invokes callable and records return value
# ===========================================================================


class TestRunStep:
    """_run_step must call fn(), record 'ok — <return>' or 'FAIL — <exc>'."""

    def test_successful_callable_recorded_as_ok(self):
        """When fn() returns a value, result[key] is set to 'ok — <value>'."""
        from token_goat.install import _run_step

        result: dict[str, str] = {}
        _run_step(result, "my_step", lambda: "done")
        assert result["my_step"] == "ok — done"

    def test_callable_returning_none_recorded(self):
        """fn() returning None is still recorded as 'ok — None'."""
        from token_goat.install import _run_step

        result: dict[str, str] = {}
        _run_step(result, "none_step", lambda: None)
        assert result["none_step"] == "ok — None"

    def test_callable_raising_exception_recorded_as_fail(self):
        """When fn() raises, result[key] is set to 'FAIL — <exc>'."""
        from token_goat.install import _run_step

        result: dict[str, str] = {}
        _run_step(result, "bad_step", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        assert result["bad_step"].startswith("FAIL — ")
        assert "boom" in result["bad_step"]

    def test_callable_is_actually_called(self):
        """_run_step must invoke fn exactly once."""
        from token_goat.install import _run_step

        mock_fn = MagicMock(return_value="called")
        result: dict[str, str] = {}
        _run_step(result, "mock_step", mock_fn)
        mock_fn.assert_called_once_with()

    def test_multiple_steps_independent(self):
        """Multiple _run_step calls populate different keys independently."""
        from token_goat.install import _run_step

        result: dict[str, str] = {}
        _run_step(result, "step_a", lambda: "alpha")
        _run_step(result, "step_b", lambda: (_ for _ in ()).throw(ValueError("oops")))
        assert result["step_a"] == "ok — alpha"
        assert result["step_b"].startswith("FAIL — ")


# ===========================================================================
# 2. read_replacement.py — _coerce_line and _coerce_end_line
# ===========================================================================


class TestCoerceLine:
    """_coerce_line returns int as-is, default when None or non-int."""

    def test_int_value_returned_unchanged(self):
        from token_goat.read_replacement import _coerce_line

        assert _coerce_line(42, 1) == 42

    def test_zero_int_returned_unchanged(self):
        from token_goat.read_replacement import _coerce_line

        assert _coerce_line(0, 99) == 0

    def test_none_returns_default(self):
        from token_goat.read_replacement import _coerce_line

        assert _coerce_line(None, 5) == 5

    def test_string_int_returns_default(self):
        """A string that looks like an int must still return default (no coercion)."""
        from token_goat.read_replacement import _coerce_line

        assert _coerce_line("10", 7) == 7

    def test_float_returns_default(self):
        """A float is not an int instance — must return default."""
        from token_goat.read_replacement import _coerce_line

        assert _coerce_line(3.0, 2) == 2


class TestCoerceEndLine:
    """_coerce_end_line returns int as-is, None when None or non-int."""

    def test_int_value_returned(self):
        from token_goat.read_replacement import _coerce_end_line

        assert _coerce_end_line(100) == 100

    def test_none_returns_none(self):
        from token_goat.read_replacement import _coerce_end_line

        assert _coerce_end_line(None) is None

    def test_string_returns_none(self):
        from token_goat.read_replacement import _coerce_end_line

        assert _coerce_end_line("50") is None

    def test_float_returns_none(self):
        from token_goat.read_replacement import _coerce_end_line

        assert _coerce_end_line(50.0) is None


# ===========================================================================
# 3. compact.py — _BY_READ_COUNT attrgetter sorts correctly
# ===========================================================================


class TestByReadCount:
    """_BY_READ_COUNT attrgetter must rank FileEntry objects by read_count."""

    def test_nlargest_picks_highest_read_count(self):
        """heapq.nlargest with _BY_READ_COUNT_THEN_TS returns entries ordered by read_count desc."""
        import heapq

        from token_goat.compact import _BY_READ_COUNT_THEN_TS
        from token_goat.session import FileEntry

        now = 0.0
        entries = [
            FileEntry(rel_or_abs="a.py", last_read_ts=now, read_count=1, line_ranges=[], symbols_read=[]),
            FileEntry(rel_or_abs="b.py", last_read_ts=now, read_count=5, line_ranges=[], symbols_read=[]),
            FileEntry(rel_or_abs="c.py", last_read_ts=now, read_count=3, line_ranges=[], symbols_read=[]),
        ]
        top2 = heapq.nlargest(2, entries, key=_BY_READ_COUNT_THEN_TS)
        assert [e.rel_or_abs for e in top2] == ["b.py", "c.py"]

    def test_single_entry_returned_as_top(self):
        import heapq

        from token_goat.compact import _BY_READ_COUNT_THEN_TS
        from token_goat.session import FileEntry

        now = 0.0
        entry = FileEntry(rel_or_abs="only.py", last_read_ts=now, read_count=7, line_ranges=[], symbols_read=[])
        top1 = heapq.nlargest(1, [entry], key=_BY_READ_COUNT_THEN_TS)
        assert top1[0].read_count == 7

    def test_tied_read_counts_all_included(self):
        """When counts tie, nlargest still returns the requested number."""
        import heapq

        from token_goat.compact import _BY_READ_COUNT_THEN_TS
        from token_goat.session import FileEntry

        now = 0.0
        entries = [
            FileEntry(rel_or_abs="x.py", last_read_ts=now, read_count=2, line_ranges=[], symbols_read=[]),
            FileEntry(rel_or_abs="y.py", last_read_ts=now, read_count=2, line_ranges=[], symbols_read=[]),
        ]
        top2 = heapq.nlargest(2, entries, key=_BY_READ_COUNT_THEN_TS)
        assert len(top2) == 2
        assert all(e.read_count == 2 for e in top2)


# ===========================================================================
# 4. session.py — _merge_ranges len==1 fast path
# ===========================================================================


class TestMergeRanges:
    """_merge_ranges must handle edge cases including the single-range fast path."""

    def test_single_range_returns_same(self):
        """A list with exactly one range must be returned as-is (fast path)."""
        from token_goat.session import _merge_ranges

        result = _merge_ranges([(5, 10)])
        assert result == [(5, 10)]

    def test_single_range_returns_copy_not_same_object(self):
        """The fast path must return a new list, not the original."""
        from token_goat.session import _merge_ranges

        original = [(1, 3)]
        result = _merge_ranges(original)
        assert result == original
        assert result is not original

    def test_empty_returns_empty(self):
        from token_goat.session import _merge_ranges

        assert _merge_ranges([]) == []

    def test_two_overlapping_merged(self):
        from token_goat.session import _merge_ranges

        assert _merge_ranges([(1, 10), (5, 15)]) == [(1, 15)]

    def test_two_adjacent_merged(self):
        """Ranges that end/start on consecutive lines are merged."""
        from token_goat.session import _merge_ranges

        assert _merge_ranges([(1, 10), (11, 20)]) == [(1, 20)]

    def test_two_non_overlapping_kept(self):
        from token_goat.session import _merge_ranges

        assert _merge_ranges([(1, 5), (10, 20)]) == [(1, 5), (10, 20)]

    def test_example_from_docstring(self):
        from token_goat.session import _merge_ranges

        assert _merge_ranges([(5, 10), (1, 6), (15, 20)]) == [(1, 10), (15, 20)]


# ===========================================================================
# 5. session.py — mark_grep truncates patterns over 200 chars
# ===========================================================================


class TestMarkGrepLengthCap:
    """mark_grep must cap the stored pattern at 200 characters."""

    def test_short_pattern_stored_unchanged(self, tmp_data_dir):
        """A pattern under 200 chars must be stored as-is."""
        from token_goat import session

        sid = "a" * 64
        cache = session._fresh_cache(sid)
        result = session.mark_grep(sid, "short_pattern", cache=cache)
        assert result.greps[-1].pattern == "short_pattern"

    def test_exact_200_pattern_stored_unchanged(self, tmp_data_dir):
        """A pattern of exactly 200 chars must not be truncated."""
        from token_goat import session

        sid = "b" * 64
        cache = session._fresh_cache(sid)
        pattern = "x" * 200
        result = session.mark_grep(sid, pattern, cache=cache)
        assert result.greps[-1].pattern == pattern
        assert len(result.greps[-1].pattern) == 200

    def test_oversized_pattern_truncated_to_200(self, tmp_data_dir):
        """A pattern over 200 chars must be truncated to exactly 200."""
        from token_goat import session

        sid = "c" * 64
        cache = session._fresh_cache(sid)
        pattern = "y" * 2048
        result = session.mark_grep(sid, pattern, cache=cache)
        stored = result.greps[-1].pattern
        assert len(stored) == 200
        assert stored == pattern[:200]

    def test_201_char_pattern_truncated(self, tmp_data_dir):
        """A pattern of 201 chars (one over the cap) must be truncated."""
        from token_goat import session

        sid = "d" * 64
        cache = session._fresh_cache(sid)
        pattern = "z" * 201
        result = session.mark_grep(sid, pattern, cache=cache)
        assert len(result.greps[-1].pattern) == 200


# ===========================================================================
# 6. hints.py — _sanitize_hint_path strips newlines and CRs
# ===========================================================================


class TestSanitizeHintPath:
    """_sanitize_hint_path must replace newlines and CRs with escaped literals."""

    def test_newline_replaced(self):
        from token_goat.hints import _sanitize_hint_path

        result = _sanitize_hint_path("src/foo\nbar.py")
        assert "\n" not in result
        assert "\\n" in result

    def test_carriage_return_replaced(self):
        from token_goat.hints import _sanitize_hint_path

        result = _sanitize_hint_path("src/foo\rbar.py")
        assert "\r" not in result
        assert "\\r" in result

    def test_crlf_both_replaced(self):
        from token_goat.hints import _sanitize_hint_path

        result = _sanitize_hint_path("path\r\ninjected_hint.py")
        assert "\r" not in result
        assert "\n" not in result

    def test_clean_path_unchanged(self):
        from token_goat.hints import _sanitize_hint_path

        path = "src/token_goat/session.py"
        assert _sanitize_hint_path(path) == path

    def test_long_path_truncated(self):
        """Paths over 300 chars must be truncated."""
        from token_goat.hints import _MAX_HINT_PATH_LEN, _sanitize_hint_path

        long_path = "a" * (_MAX_HINT_PATH_LEN + 50)
        result = _sanitize_hint_path(long_path)
        assert len(result) <= _MAX_HINT_PATH_LEN + 5  # allows for ellipsis char


# ===========================================================================
# 7. render/stats_renderer.py — _strip_ansi removes ESC sequences
# ===========================================================================


class TestStripAnsi:
    """_strip_ansi must remove ANSI/VT escape sequences from strings."""

    def test_basic_color_code_stripped(self):
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        assert _strip_ansi("\x1b[31mred text\x1b[0m") == "red text"

    def test_bold_code_stripped(self):
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        assert _strip_ansi("\x1b[1mbold\x1b[0m") == "bold"

    def test_cursor_control_stripped(self):
        """CSI cursor-move sequences must also be stripped."""
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        result = _strip_ansi("\x1b[2J\x1b[Hclean")
        assert "\x1b" not in result
        assert "clean" in result

    def test_plain_string_unchanged(self):
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        assert _strip_ansi("/home/user/projects/token-goat") == "/home/user/projects/token-goat"

    def test_empty_string(self):
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        assert _strip_ansi("") == ""

    def test_project_path_with_injected_esc(self):
        """A project root path containing ESC bytes must be fully sanitized."""
        from token_goat.render.ansi import strip_ansi as _strip_ansi

        injected = "/home/user/proj\x1b[1;32m"
        result = _strip_ansi(injected)
        assert "\x1b" not in result
        assert result == "/home/user/proj"


# ===========================================================================
# 8. paths.py — atomic_write_text cleans up tmp and re-raises on write error
# ===========================================================================


class TestAtomicWriteTextOsError:
    """atomic_write_text must clean up the tmp file and re-raise on write errors."""

    def test_write_error_reraises(self, tmp_path):
        """An IOError during write must propagate out of atomic_write_text."""
        from token_goat.paths import atomic_write_text

        target = tmp_path / "out.txt"

        original_fdopen = os.fdopen

        def failing_fdopen(fd, *args, **kwargs):
            fh = original_fdopen(fd, *args, **kwargs)

            class FailingFile:
                def write(self, _):
                    raise OSError("simulated disk full")

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    fh.close()
                    return False

            return FailingFile()

        with patch("token_goat.paths.os.fdopen", side_effect=failing_fdopen), pytest.raises(
            OSError, match="simulated disk full"
        ):
            atomic_write_text(target, "hello")

    def test_tmp_file_cleaned_up_after_write_error(self, tmp_path):
        """No .tmp file must remain after a write error."""
        from token_goat.paths import atomic_write_text

        target = tmp_path / "out.txt"

        original_fdopen = os.fdopen

        def failing_fdopen(fd, *args, **kwargs):
            fh = original_fdopen(fd, *args, **kwargs)

            class FailingFile:
                def write(self, _):
                    raise OSError("simulated disk full")

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    fh.close()
                    return False

            return FailingFile()

        with patch("token_goat.paths.os.fdopen", side_effect=failing_fdopen), pytest.raises(OSError):
            atomic_write_text(target, "hello")

        # No .tmp files should remain
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == [], f"Leftover tmp files: {tmp_files}"

    def test_successful_write_creates_file(self, tmp_path):
        """A normal write must succeed and the file must contain the content."""
        from token_goat.paths import atomic_write_text

        target = tmp_path / "success.txt"
        atomic_write_text(target, "expected content")
        assert target.read_text(encoding="utf-8") == "expected content"

    def test_successful_write_no_tmp_remains(self, tmp_path):
        """After a successful write, no .tmp file must remain in the directory."""
        from token_goat.paths import atomic_write_text

        target = tmp_path / "clean.txt"
        atomic_write_text(target, "data")
        tmp_files = list(tmp_path.glob("*.tmp"))
        assert tmp_files == [], f"Leftover tmp files: {tmp_files}"
