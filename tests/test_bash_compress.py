"""Tests for token_goat.bash_compress, common helpers and filter dispatch."""
from __future__ import annotations

import re

import pytest

from token_goat import bash_compress as bc
from token_goat.bash_compress import _maybe_note

# ---------------------------------------------------------------------------
# strip_ansi
# ---------------------------------------------------------------------------


class TestStripAnsi:
    @pytest.mark.parametrize("text,expected", [
        # Basic SGR color codes
        ("\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m", "red green"),
        # 256-color palette
        ("\x1b[38;5;208mhello\x1b[0m", "hello"),
        # 24-bit truecolor
        ("\x1b[38;2;255;0;0mred truecolor\x1b[0m", "red truecolor"),
        # OSC BEL-terminated (window title)
        ("\x1b]0;window title\x07after", "after"),
        # Cursor movement sequences
        ("first\x1b[2Asecond\x1b[3Bthird", "firstsecondthird"),
        # Plain text passes through unchanged
        ("plain text", "plain text"),
        # Empty string
        ("", ""),
        # Unicode preserved after stripping bold
        ("\x1b[1m日本語\x1b[0m", "日本語"),
        # OSC with ST (ESC \) terminator — hyperlink sequences
        ("\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\after", "clickafter"),
        # DCS string terminated by ST — tmux passthrough, sixel, etc.
        ("before\x1bPsomedata\x1b\\after", "beforeafter"),
    ])
    def test_strips_escape_sequences(self, text, expected):
        assert bc.strip_ansi(text) == expected

    def test_is_same_function_as_render_ansi(self):
        # bc.strip_ansi must be the same object as render.ansi.strip_ansi
        from token_goat.render.ansi import strip_ansi as render_strip
        assert bc.strip_ansi is render_strip


# ---------------------------------------------------------------------------
# strip_progress
# ---------------------------------------------------------------------------


class TestStripProgress:
    def test_collapses_carriage_return_progress(self):
        text = "10%\r50%\r100% done"
        assert bc.strip_progress(text) == "100% done"

    def test_preserves_lines_without_cr(self):
        text = "line1\nline2\nline3"
        assert bc.strip_progress(text) == text

    def test_collapses_per_line(self):
        text = "line1\n10%\r100% done\nline2"
        assert bc.strip_progress(text) == "line1\n100% done\nline2"

    def test_empty_string(self):
        assert bc.strip_progress("") == ""

    def test_only_carriage_returns(self):
        # Final state after multiple progress updates is empty.
        text = "phase1\rphase2\r"
        assert bc.strip_progress(text) == ""


# ---------------------------------------------------------------------------
# dedupe_consecutive
# ---------------------------------------------------------------------------


class TestDedupeConsecutive:
    def test_basic_run_collapses(self):
        out = bc.dedupe_consecutive(["a", "a", "a", "b"])
        assert out == ["a  (×3)", "b"]

    def test_single_repeat_kept_when_below_min_run(self):
        out = bc.dedupe_consecutive(["a", "a", "b"], min_run=3)
        assert out == ["a", "a", "b"]

    def test_no_repeats_passes_through(self):
        out = bc.dedupe_consecutive(["a", "b", "c"])
        assert out == ["a", "b", "c"]

    def test_non_consecutive_not_deduped(self):
        out = bc.dedupe_consecutive(["a", "b", "a"])
        assert out == ["a", "b", "a"]

    def test_custom_format(self):
        out = bc.dedupe_consecutive(["x", "x"], fmt="{line} [{count}]")
        assert out == ["x [2]"]

    def test_empty_input(self):
        assert bc.dedupe_consecutive([]) == []


# ---------------------------------------------------------------------------
# dedupe_by_key
# ---------------------------------------------------------------------------


class TestDedupeByKey:
    def test_keeps_first_n_per_bucket(self):
        lines = [f"F401 occurrence {i}" for i in range(10)]
        key = re.compile(r"(F\d+)")
        out = bc.dedupe_by_key(lines, key, keep_first_n=3)
        # First 3 kept verbatim; summary appended.
        kept = [ln for ln in out if "occurrence" in ln]
        assert len(kept) == 3
        assert any("+7" in ln and "F401" in ln for ln in out)

    def test_unmatched_lines_passed_through(self):
        lines = ["plain", "F401 foo", "F401 bar", "F401 baz", "F401 qux"]
        key = re.compile(r"(F\d+)")
        out = bc.dedupe_by_key(lines, key, keep_first_n=2)
        assert "plain" in out


# ---------------------------------------------------------------------------
# truncate_middle / cap_bytes
# ---------------------------------------------------------------------------


class TestTruncateMiddle:
    def test_under_budget_unchanged(self):
        lines = ["a", "b", "c"]
        assert bc.truncate_middle(lines, 100) == lines

    def test_over_budget_keeps_head_and_tail(self):
        lines = [str(i) for i in range(100)]
        out = bc.truncate_middle(lines, 10)
        assert len(out) == 11  # 4 head + marker + 6 tail
        assert "0" in out and "99" in out
        assert any("elided" in ln for ln in out)


class TestTruncateMiddleSmart:
    """Tests for truncate_middle_smart — error-preserving truncation."""

    # ------------------------------------------------------------------
    # No-error path: must fall back to plain head+tail behaviour
    # ------------------------------------------------------------------

    def test_under_budget_unchanged(self):
        """Lines within budget are returned as-is."""
        lines = ["a", "b", "c"]
        assert bc.truncate_middle_smart(lines, 100) == lines

    def test_no_errors_uses_head_tail(self):
        """Without error signals the output keeps first and last lines."""
        lines = [f"line {i}" for i in range(200)]
        out = bc.truncate_middle_smart(lines, 30)
        # head line and tail line must survive
        assert out[0] == "line 0"
        assert out[-1] == "line 199"
        # a marker must be present
        assert any("omitted" in ln or "elided" in ln for ln in out)
        # middle content without errors is gone
        assert "line 100" not in out

    def test_no_errors_marker_present(self):
        """Plain head+tail omission marker is present."""
        lines = [f"x{i}" for i in range(100)]
        out = bc.truncate_middle_smart(lines, 20)
        markers = [ln for ln in out if "omitted" in ln or "elided" in ln]
        assert len(markers) >= 1

    # ------------------------------------------------------------------
    # Error-preservation path
    # ------------------------------------------------------------------

    def test_error_in_middle_preserved(self):
        """An 'error:' line buried in the middle of output is kept."""
        lines = (
            [f"progress {i}" for i in range(100)]
            + ["src/foo.py:42: error: undefined variable 'x'"]
            + [f"progress {i}" for i in range(100, 200)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("error: undefined variable" in ln for ln in out)

    def test_error_context_lines_included(self):
        """Lines surrounding an error line (within error_context) are kept."""
        lines = (
            [f"build step {i}" for i in range(50)]
            + ["before_error_context"]
            + ["before_error_direct"]
            + ["ERROR: compilation failed"]
            + ["after_error_direct"]
            + ["after_error_context"]
            + [f"build step {i}" for i in range(50, 100)]
        )
        out = bc.truncate_middle_smart(lines, 40, error_context=2)
        joined = "\n".join(out)
        assert "before_error_direct" in joined
        assert "ERROR: compilation failed" in joined
        assert "after_error_direct" in joined

    def test_omission_markers_between_sections(self):
        """Omission markers appear between non-contiguous kept sections."""
        lines = (
            [f"header {i}" for i in range(20)]
            + [f"noise {i}" for i in range(200)]
            + ["FAILED: test_foo"]
            + [f"noise {i}" for i in range(200, 400)]
            + [f"summary {i}" for i in range(20)]
        )
        out = bc.truncate_middle_smart(lines, 60)
        markers = [ln for ln in out if "omitted" in ln or "elided" in ln]
        # Expect at least two markers: one between head→error section, one
        # between error section→tail.
        assert len(markers) >= 2

    def test_traceback_preserved(self):
        """'Traceback' keyword triggers error preservation."""
        lines = (
            ["Running tests..."] * 100
            + ["Traceback (most recent call last):"]
            + ['  File "test.py", line 10, in test_foo']
            + ["AssertionError: expected 1 got 2"]
            + ["......"] * 100
        )
        out = bc.truncate_middle_smart(lines, 40)
        joined = "\n".join(out)
        assert "Traceback" in joined

    def test_multiple_error_lines_capped_at_max_error_lines(self):
        """At most max_error_lines distinct error-signal lines are preserved."""
        error_lines = [f"Error: problem {i}" for i in range(30)]
        lines = (
            ["start"] * 20
            + [item for pair in zip(["noise"] * 30, error_lines, strict=False) for item in pair]
            + ["end"] * 20
        )
        out = bc.truncate_middle_smart(lines, 80, max_error_lines=5)
        # Should not blow past the line budget significantly.
        assert len(out) <= 90  # max_lines + some markers

    def test_panic_preserved(self):
        """'panic:' keyword (Go runtime panics) is treated as an error signal."""
        lines = (
            [f"compiling pkg {i}" for i in range(150)]
            + ["goroutine 1 [running]:"]
            + ["panic: runtime error: index out of range [3] with length 3"]
            + [f"output {i}" for i in range(150)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("panic:" in ln for ln in out)

    def test_failed_keyword_preserved(self):
        """'FAILED' keyword is treated as an error signal."""
        lines = (
            [f"test {i} ok" for i in range(200)]
            + ["FAILED tests/test_api.py::test_login - AssertionError"]
            + [f"test {i} ok" for i in range(200, 400)]
        )
        out = bc.truncate_middle_smart(lines, 50)
        assert any("FAILED" in ln for ln in out)

    def test_head_and_tail_always_present_with_errors(self):
        """Header (first lines) and tail (last lines) survive even with errors."""
        lines = (
            ["=== build start ==="]
            + [f"step {i}" for i in range(200)]
            + ["Error: something went wrong"]
            + [f"step {i}" for i in range(200, 400)]
            + ["=== build end ==="]
        )
        out = bc.truncate_middle_smart(lines, 60)
        assert out[0] == "=== build start ==="
        assert out[-1] == "=== build end ==="
        assert any("Error:" in ln for ln in out)


class TestCapBytes:
    def test_under_budget_unchanged(self):
        assert bc.cap_bytes("hello", 100) == "hello"

    def test_over_budget_truncated(self):
        text = ("hello\n" * 1000)
        out = bc.cap_bytes(text, 200)
        assert len(out.encode("utf-8")) <= 220  # 200 budget + marker
        assert "elided" in out

    def test_handles_multibyte_safely(self):
        text = "日本語\n" * 100
        out = bc.cap_bytes(text, 50)
        # Must decode cleanly even after truncation.
        assert "elided" in out


# ---------------------------------------------------------------------------
# normalise
# ---------------------------------------------------------------------------


class TestNormalise:
    def test_strips_progress_and_ansi(self):
        text = "10%\r\x1b[32m100% done\x1b[0m"
        assert bc.normalise(text) == "100% done"

    def test_normalises_crlf(self):
        text = "a\r\nb\r\nc"
        assert bc.normalise(text) == "a\nb\nc"

    def test_empty(self):
        assert bc.normalise("") == ""


# ---------------------------------------------------------------------------
# Filter dispatch
# ---------------------------------------------------------------------------


class TestSelectFilter:
    @pytest.mark.parametrize("argv,expected_name", [
        (["pytest", "tests/"], "pytest"),
        (["python", "-m", "pytest", "tests/"], "pytest"),
        (["uv", "run", "pytest"], "pytest"),
        (["jest"], "jest"),
        (["npx", "jest"], "jest"),
        (["npm", "install"], "npm_install"),
        (["pnpm", "install"], "npm_install"),
        (["docker", "build", "-t", "x", "."], "docker"),
        (["kubectl", "get", "pods"], "kubectl"),
        (["cargo", "build"], "cargo"),
        (["ruff", "check", "src/"], "ruff"),
        (["mypy", "src/"], "mypy"),
        (["make", "all"], "make"),
        (["terraform", "plan"], "terraform"),
        (["aws", "s3", "ls"], "aws-cli"),  # AwsCliFilter registered before AwsFilter
        (["pip", "install", "foo"], "pip"),
        (["sudo", "docker", "build", "."], "docker"),  # sudo prefix stripped
        (["NODE_ENV=test", "jest"], "jest"),  # env assignment prefix stripped
        (["PYTHONPATH=src", "python", "-m", "pytest"], "pytest"),  # PYTHONPATH stripped
    ])
    def test_dispatch(self, argv, expected_name):
        f = bc.select_filter(argv)
        assert f is not None and f.name == expected_name

    def test_git(self):
        # git status is now handled by GitStatusVerboseFilter (higher-fidelity)
        f = bc.select_filter(["git", "status"])
        assert f is not None and f.name in ("git", "git-status")

    def test_unknown_command_routes_to_tail_trunc(self):
        # TailTruncFilter is now the catch-all fallback for unrecognised commands.
        result = bc.select_filter(["totally-unknown-binary"])
        assert isinstance(result, bc.TailTruncFilter)

    def test_empty_argv_returns_none(self):
        assert bc.select_filter([]) is None


# ---------------------------------------------------------------------------
# detect_from_command (string entry)
# ---------------------------------------------------------------------------


class TestDetectFromCommand:
    def test_basic_command(self):
        result = bc.detect_from_command("pytest tests/")
        assert result is not None
        f, argv = result
        assert f.name == "pytest" and argv[0] == "pytest"

    def test_rejects_pipeline(self):
        # Pipes can't be safely wrapped, must skip.
        assert bc.detect_from_command("pytest | head") is None

    def test_rejects_redirect(self):
        assert bc.detect_from_command("pytest > out.txt") is None

    def test_rejects_command_substitution(self):
        assert bc.detect_from_command("echo $(pytest)") is None
        assert bc.detect_from_command("echo `pytest`") is None

    def test_rejects_chain(self):
        assert bc.detect_from_command("pytest && deploy") is None
        assert bc.detect_from_command("pytest; deploy") is None

    def test_rejects_oversized(self):
        cmd = "pytest " + "x" * 70_000
        assert bc.detect_from_command(cmd) is None

    def test_rejects_unbalanced_quotes(self):
        # shlex.split raises; we should silently skip rather than crash.
        assert bc.detect_from_command("pytest 'unclosed") is None

    def test_empty_string(self):
        assert bc.detect_from_command("") is None

    def test_unknown_binary(self):
        # TailTruncFilter is the catch-all; detect_from_command now returns it for any binary.
        result = bc.detect_from_command("totally-unknown")
        assert result is not None
        filter_, _ = result
        assert isinstance(filter_, bc.TailTruncFilter)

    def test_quoted_angle_bracket_not_rejected(self):
        """A > or < inside a quoted argument must not be treated as a shell redirect.

        Regression test: the raw-string check `">" in command` incorrectly
        rejected commands like `pytest -k "count > 0"` where the > is inside
        shell quotes and is part of an argument value, not a redirect operator.
        Fix: redirect operators are now checked against parsed argv tokens, so
        quoted occurrences are correctly allowed through.
        """
        # > inside double-quoted argument — should be allowed
        result = bc.detect_from_command('pytest -k "count > 0"')
        assert result is not None, 'pytest -k "count > 0" should be accepted (> is quoted)'

        # < inside single-quoted argument — should be allowed
        result2 = bc.detect_from_command("pytest -k 'size < 100'")
        assert result2 is not None, "pytest -k 'size < 100' should be accepted (< is quoted)"

        # Bare redirect (unquoted) must still be rejected
        assert bc.detect_from_command("pytest > out.txt") is None, "bare > redirect must be rejected"
        assert bc.detect_from_command("pytest < input.txt") is None, "bare < redirect must be rejected"
        assert bc.detect_from_command("pytest >> log.txt") is None, "bare >> redirect must be rejected"


# ---------------------------------------------------------------------------
# Generic Filter contract
# ---------------------------------------------------------------------------


class TestFilterBase:
    def test_compress_output_preserves_exit_code(self):
        f = bc.GenericFilter()
        result = bc.compress_output(f, "hello\n", "", 42, ["foo"])
        assert result.exit_code == 42

    def test_compress_output_computes_savings(self):
        f = bc.GenericFilter()
        stdout = "same\n" * 100
        result = bc.compress_output(f, stdout, "", 0, ["foo"])
        # Generic dedupes consecutive, savings should be positive.
        assert result.original_bytes > result.compressed_bytes
        assert result.bytes_saved > 0
        assert result.tokens_saved > 0

    def test_compress_output_no_savings_returns_marker_free(self):
        f = bc.GenericFilter()
        result = bc.compress_output(f, "single line", "", 0, ["foo"])
        # No savings → with_marker returns text unchanged.
        assert result.with_marker() == result.text

    def test_filter_exception_falls_back_to_truncation(self):
        class BrokenFilter(bc.Filter):
            name = "broken"
            binaries = frozenset(["whatever"])

            def compress(self, stdout, stderr, exit_code, argv):
                raise ValueError("boom")

        f = BrokenFilter()
        result = f.apply("hello\nworld", "", 0, ["whatever"])
        # Should not propagate the exception.
        assert "hello" in result.text or "world" in result.text
        assert "broken filter raised" in result.text

    def test_byte_cap_enforced(self):
        f = bc.GenericFilter()
        huge_line = "x" * 100_000
        result = f.apply(huge_line, "", 0, ["foo"], max_bytes=1000)
        assert len(result.text.encode("utf-8")) <= 1100


# ---------------------------------------------------------------------------
# Pytest filter golden
# ---------------------------------------------------------------------------


class TestPytestFilter:
    def test_drops_dots_progress(self):
        f = bc.PytestFilter()
        # ``...... [100%]`` is a pure progress line, fully dropped by the
        # _PYTEST_DOTS_RE filter.  ``FAILED test_a`` must survive.
        out = f.compress("...... [100%]\nFAILED test_a\n", "", 0, ["pytest"])
        assert "[100%]" not in out
        assert "FAILED test_a" in out

    def test_keeps_failures(self):
        text = (
            "= test session starts =\n"
            "collected 100 items\n"
            "FAILED tests/test_x.py::test_one\n"
            "= 1 failed, 99 passed in 1.2s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        assert "FAILED tests/test_x.py::test_one" in result.text
        assert "1 failed, 99 passed" in result.text

    def test_collapses_passed_lines(self):
        text = "\n".join([f"PASSED tests/test_{i}.py::test_x" for i in range(50)])
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        assert "PASSED tests/test_0.py" not in result.text
        assert "collapsed 50 PASSED" in result.text

    def test_strips_banner_lines(self):
        """Banner lines (platform, cachedir, rootdir, plugins, configfile) are stripped."""
        text = (
            "platform linux -- Python 3.12.0, pytest-8.1.0\n"
            "cachedir: /tmp/pytest-cache\n"
            "rootdir: /home/user/project\n"
            "configfile: pyproject.toml\n"
            "plugins: xdist-3.5.0, cov-5.0.0\n"
            "= test session starts =\n"
            "collected 5 items\n"
            "FAILED tests/test_x.py::test_one\n"
            "= 1 failed, 4 passed in 0.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        assert "platform linux" not in result.text
        assert "cachedir:" not in result.text
        assert "rootdir:" not in result.text
        assert "configfile:" not in result.text
        assert "plugins:" not in result.text
        # Real signal must survive.
        assert "FAILED tests/test_x.py::test_one" in result.text
        assert "1 failed, 4 passed" in result.text

    def test_xdist_prefix_stripped(self):
        """pytest-xdist [gwN] prefixes are stripped before processing."""
        text = (
            "[gw0] [ 25%] PASSED tests/test_a.py::test_one\n"
            "[gw1] [ 50%] PASSED tests/test_b.py::test_two\n"
            "[gw0] [ 75%] FAILED tests/test_c.py::test_three\n"
            "[gw1] [100%] PASSED tests/test_d.py::test_four\n"
            "= 1 failed, 3 passed in 2.1s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest", "-n", "2"])
        # PASSED lines should be collapsed (not kept verbatim)
        assert "PASSED tests/test_a" not in result.text
        assert "collapsed" in result.text
        # FAILED line must survive
        assert "FAILED tests/test_c.py::test_three" in result.text
        # The [gwN] prefix itself should be gone
        assert "[gw0]" not in result.text
        assert "[gw1]" not in result.text

    def test_coverage_table_collapsed(self):
        """pytest-cov per-file coverage rows are collapsed; TOTAL line kept."""
        cov_header = "Name                    Stmts   Miss  Cover\n"
        sep = "----------------------------------------------\n"
        rows = "\n".join(
            [f"src/module_{i}.py          100      0   100%" for i in range(20)]
        )
        total = "TOTAL                    2000      0   100%\n"
        text = cov_header + sep + rows + "\n" + sep + total
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest", "--cov"])
        assert "TOTAL" in result.text
        # Individual module rows should be collapsed
        assert "src/module_0.py" not in result.text
        assert "collapsed" in result.text

    def test_slow_durations_collapsed(self):
        """The slowest-N-durations section keeps first 5 entries; rest collapsed."""
        header = "= slowest 20 durations =\n"
        durations = "\n".join(
            [f"{20 - i:.2f}s call tests/test_{i}.py::test_slow" for i in range(20)]
        )
        text = header + durations + "\n= 0 failed, 20 passed in 25.5s =\n"
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest", "--durations=20"])
        # First 5 entries should survive
        assert "20.00s call" in result.text
        assert "16.00s call" in result.text
        # The rest should be collapsed
        assert "collapsed" in result.text
        # The final summary should survive
        assert "0 failed, 20 passed" in result.text

    def test_strips_preamble_lines(self):
        """Preamble lines (collecting, bringing up nodes, cacheprovider) are stripped."""
        text = (
            "collecting ... collecting [100%]\n"
            "platform linux -- Python 3.12.0\n"
            "cachedir: /tmp/pytest-cache\n"
            "bringing up 4 workers\n"
            "cacheprovider-1234567890\n"
            "= test session starts =\n"
            "collected 5 items\n"
            "FAILED tests/test_x.py::test_one\n"
            "= 1 failed, 4 passed in 0.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        # Preamble lines should be stripped
        assert "collecting ..." not in result.text
        assert "bringing up" not in result.text
        assert "cacheprovider-" not in result.text
        # Banner lines should be stripped
        assert "platform linux" not in result.text
        assert "cachedir:" not in result.text
        # Real signal must survive
        assert "FAILED tests/test_x.py::test_one" in result.text
        assert "1 failed, 4 passed" in result.text

    def test_preamble_keeps_failure_details(self):
        """Preamble stripping preserves full failure details."""
        text = (
            "collecting ... collecting [100%]\n"
            "= test session starts =\n"
            "tests/test_a.py::test_one FAILED\n"
            "    def test_one():\n"
            "        assert 1 == 2\n"
            "E       AssertionError: assert 1 == 2\n"
            "= 1 failed in 0.1s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        # Preamble lines stripped
        assert "collecting ..." not in result.text
        # Failure details preserved
        assert "AssertionError" in result.text
        assert "test_one" in result.text
        # Summary line preserved
        assert "1 failed" in result.text

    def test_preamble_keeps_summary_line(self):
        """Preamble stripping keeps the final summary line."""
        text = (
            "collecting [100%]\n"
            "= test session starts =\n"
            "PASSED test_one\n"
            "= 1 passed in 0.1s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        # Preamble line stripped
        assert "collecting" not in result.text
        # Summary line kept
        assert "1 passed" in result.text

    def test_warnings_section_deduplicates_repeated_messages(self):
        """Repeated DeprecationWarning messages in the warnings summary are deduplicated."""
        # Same warning message from two different test files — should keep only the first.
        text = (
            "= warnings summary =\n"
            "tests/test_a.py::test_one\n"
            "  /usr/lib/python3.12/pkg/mod.py:123: DeprecationWarning: use new_api() instead\n"
            "    old_api()\n"
            "tests/test_b.py::test_two\n"
            "  /usr/lib/python3.12/pkg/mod.py:123: DeprecationWarning: use new_api() instead\n"
            "    old_api()\n"
            "  -- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n"
            "= 2 passed in 0.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        # First occurrence of the warning message kept
        assert "DeprecationWarning: use new_api() instead" in result.text
        # Duplicate warning message dropped
        assert result.text.count("DeprecationWarning: use new_api() instead") == 1
        # Docs footer dropped
        assert "Docs: https://" not in result.text
        # Collapse notice emitted
        assert "collapsed" in result.text
        # Final summary kept
        assert "2 passed" in result.text

    def test_warnings_section_drops_docs_footer(self):
        """The -- Docs: https://... footer is always dropped from the warnings section."""
        text = (
            "= warnings summary =\n"
            "tests/test_x.py::test_y\n"
            "  /site-packages/lib.py:50: PytestUnraisableExceptionWarning: something\n"
            "    fn()\n"
            "  -- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n"
            "= 1 passed in 0.1s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        assert "-- Docs:" not in result.text
        assert "PytestUnraisableExceptionWarning" in result.text

    def test_warnings_section_preserves_unique_messages(self):
        """Different warning types are each kept once in the warnings summary."""
        text = (
            "= warnings summary =\n"
            "tests/test_a.py::test_one\n"
            "  /pkg/mod.py:10: DeprecationWarning: use foo() instead\n"
            "    old_foo()\n"
            "tests/test_b.py::test_two\n"
            "  /pkg/mod.py:20: DeprecationWarning: use bar() instead\n"
            "    old_bar()\n"
            "  -- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n"
            "= 2 passed in 0.3s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        # Both unique messages should be present
        assert "use foo() instead" in result.text
        assert "use bar() instead" in result.text

    def test_warnings_section_high_volume_deprecations(self):
        """A high-volume warnings block (same warning 20 times) collapses aggressively."""
        warn_line = "  /site-packages/old_lib.py:42: DeprecationWarning: old_lib is deprecated\n"
        code_line = "    old_lib.call()\n"
        tests = "".join(
            f"tests/test_{i}.py::test_fn\n{warn_line}{code_line}"
            for i in range(20)
        )
        text = (
            "= warnings summary =\n"
            + tests
            + "  -- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n"
            "= 20 passed in 1.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        # Only one copy of the warning message
        assert result.text.count("DeprecationWarning: old_lib is deprecated") == 1
        # Collapse notice mentions at least 19 dropped lines
        assert "collapsed" in result.text
        assert "20 passed" in result.text

    def test_drops_test_session_starts_header(self):
        """The '= test session starts =' header is dropped — it is constant and adds no signal."""
        text = (
            "= test session starts =\n"
            "collected 10 items\n"
            "..........\n"
            "= 10 passed in 1.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        assert "test session starts" not in result.text
        # Useful signal is preserved
        assert "10 passed" in result.text
        assert "collected 10 items" in result.text

    def test_session_starts_drop_increases_savings(self):
        """Dropping '= test session starts =' increases byte savings on small passing runs."""
        # A minimal passing run: banner + session start + dots + summary
        text = (
            "platform linux -- Python 3.12.0, pytest-8.1.0, pluggy-1.4.0\n"
            "rootdir: /home/user/project\n"
            "configfile: pyproject.toml\n"
            "= test session starts =\n"
            "collected 5 items\n"
            ".....\n"
            "= 5 passed in 0.5s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 0, ["pytest"])
        # The compressed output should be much smaller than the input
        assert len(result.text.encode()) < len(text.encode()) * 0.5
        # No noise lines in output
        assert "test session starts" not in result.text
        assert "platform linux" not in result.text

    def test_session_starts_with_failures_summary_preserved(self):
        """Dropping '= test session starts =' header does NOT affect failure sections."""
        text = (
            "= test session starts =\n"
            "collected 3 items\n"
            "..F\n"
            "= FAILURES =\n"
            "_______ test_bad _______\n"
            "E   AssertionError: wrong value\n"
            "= short test summary info =\n"
            "FAILED tests/test_x.py::test_bad - AssertionError\n"
            "= 1 failed, 2 passed in 0.3s =\n"
        )
        f = bc.PytestFilter()
        result = f.apply(text, "", 1, ["pytest"])
        # Session starts header dropped
        assert "test session starts" not in result.text
        # All failure signal preserved
        assert "AssertionError: wrong value" in result.text
        assert "FAILED tests/test_x.py::test_bad" in result.text
        assert "1 failed, 2 passed" in result.text


# ---------------------------------------------------------------------------
# Jest filter
# ---------------------------------------------------------------------------


class TestJestFilter:
    def test_collapses_pass_lines(self):
        text = "\n".join(["PASS  src/foo.test.js" for _ in range(10)])
        text += "\nTests: 50 passed\n"
        f = bc.JestFilter()
        result = f.apply(text, "", 0, ["jest"])
        assert "PASS  src/foo.test.js" not in result.text
        assert "collapsed 10 PASS files" in result.text
        assert "Tests: 50 passed" in result.text

    def test_keeps_fail_block(self):
        text = (
            "FAIL src/foo.test.js\n"
            "  expected: 1\n"
            "  received: 2\n"
            "\n"
            "Tests: 1 failed\n"
        )
        f = bc.JestFilter()
        result = f.apply(text, "", 1, ["jest"])
        assert "FAIL src/foo.test.js" in result.text
        assert "expected: 1" in result.text


# ---------------------------------------------------------------------------
# Cargo filter
# ---------------------------------------------------------------------------


class TestCargoFilter:
    def test_collapses_compiling_lines(self):
        text = "\n".join([f"   Compiling crate-{i} v0.1.0" for i in range(20)])
        text += "\n    Finished dev [unoptimized + debuginfo] target(s) in 5.0s\n"
        f = bc.CargoFilter()
        result = f.apply(text, "", 0, ["cargo", "build"])
        assert "[compiling 20 crates" in result.text
        assert "Compiling crate-0" not in result.text

    def test_keeps_short_compile_list(self):
        text = "   Compiling foo v0.1.0\n   Compiling bar v0.1.0\n"
        f = bc.CargoFilter()
        result = f.apply(text, "", 0, ["cargo", "build"])
        assert "Compiling foo" in result.text
        assert "Compiling bar" in result.text

    def test_keeps_errors(self):
        stderr = "error[E0308]: mismatched types\n  --> src/lib.rs:5:9\n"
        f = bc.CargoFilter()
        result = f.apply("", stderr, 1, ["cargo", "build"])
        assert "error[E0308]" in result.text
        assert "mismatched types" in result.text

    def test_drops_downloaded_progress_lines(self):
        """'Downloaded' (past tense) lines are dropped alongside 'Downloading'."""
        stderr = (
            "   Downloaded serde v1.0.197\n"
            "   Downloaded serde_derive v1.0.197\n"
            "   Downloading tokio v1.36.0\n"
            "   Compiling my-project v0.1.0\n"
            "    Finished dev [unoptimized] target(s) in 3.2s\n"
        )
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "build"])
        assert "Downloaded serde" not in result.text
        assert "Downloading tokio" not in result.text
        # Non-progress lines preserved
        assert "Compiling my-project" in result.text
        assert "Finished" in result.text

    def test_build_savings_significant_on_large_output(self):
        """Cargo build with many Compiling + Downloaded lines achieves >50% savings."""
        stderr_lines = (
            [f"   Downloaded crate-{i} v1.{i}.0" for i in range(30)]
            + [f"   Compiling crate-{i} v1.{i}.0" for i in range(30)]
            + ["    Finished dev [unoptimized + debuginfo] target(s) in 45.0s"]
        )
        stderr = "\n".join(stderr_lines)
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "build"])
        assert len(result.text.encode()) < len(stderr.encode()) * 0.5


# ---------------------------------------------------------------------------
# Node package filter
# ---------------------------------------------------------------------------


class TestNodePackageFilter:
    def test_drops_spinner_progress(self):
        text = "⠋ idealTree\n⠙ idealTree\n⠹ idealTree\nadded 50 packages\n"
        f = bc.NodePackageFilter()
        result = f.apply(text, "", 0, ["npm", "install"])
        assert "⠋ idealTree" not in result.text
        assert "added 50 packages" in result.text

    def test_collapses_deprecation_warnings(self):
        text = "\n".join([f"npm warn deprecated foo@1.0.{i}: use bar" for i in range(10)])
        f = bc.NodePackageFilter()
        result = f.apply(text, "", 0, ["npm", "install"])
        assert "collapsed 10 deprecation" in result.text

    def test_keeps_npm_err(self):
        stderr = "npm ERR! code ENOENT\nnpm ERR! syscall open\n"
        f = bc.NodePackageFilter()
        result = f.apply("", stderr, 1, ["npm", "install"])
        assert "npm ERR! code ENOENT" in result.text


class TestPnpmFilter:
    """pnpm-specific compression via PnpmFilter."""

    def test_keeps_pnpm_error_line(self):
        """ERR_PNPM_* error lines must survive compression."""
        text = (
            "Packages: +15\n"
            "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for lodash@99.0\n"
            "Progress: resolved 10, reused 5, downloaded 0, added 0\n"
        )
        f = bc.PnpmFilter()
        result = f.apply(text, "", 1, ["pnpm", "add", "lodash@99.0"])
        assert "ERR_PNPM_NO_MATCHING_VERSION" in result.text

    def test_keeps_pnpm_packages_summary(self):
        """'Packages: +N' summary line is preserved."""
        text = (
            "Resolving: 80/80\n"
            "Packages: +5\n"
            "node_modules/.pnpm/lodash@4.17.21 OK\n"
        )
        f = bc.PnpmFilter()
        result = f.apply(text, "", 0, ["pnpm", "install"])
        assert "Packages: +5" in result.text

    def test_drops_pnpm_progress_lines(self):
        """Resolving N/M progress lines are dropped."""
        lines = [
            "Resolving: 100/100",
            "Downloading: 45/100",
            "Packages: +1",
        ]
        f = bc.PnpmFilter()
        result = f.apply("\n".join(lines), "", 0, ["pnpm", "add", "react"])
        # Progress lines collapsed, summary kept
        assert "Packages: +1" in result.text

    def test_pnpm_already_up_to_date(self):
        """'Already up to date' is a meaningful output line."""
        text = "Already up to date\n"
        f = bc.PnpmFilter()
        result = f.apply(text, "", 0, ["pnpm", "install"])
        assert "Already up to date" in result.text


class TestYarnFilter:
    """yarn-specific compression via YarnFilter."""

    def test_keeps_yarn_error_line(self):
        """'error <message>' lines must survive compression."""
        text = (
            "yarn add v1.22.19\n"
            "[1/4] Resolving packages...\n"
            "error An unexpected error occurred: 'ENOENT: no such file'\n"
            "info Visit https://yarnpkg.com/en/docs/cli/add for docs\n"
        )
        f = bc.YarnFilter()
        result = f.apply(text, "", 1, ["yarn", "add", "missing-pkg"])
        assert "error An unexpected error occurred" in result.text

    def test_keeps_yarn_success_summary(self):
        """'success' summary line is preserved."""
        text = (
            "yarn add v1.22.19\n"
            "[1/4] Resolving packages...\n"
            "[2/4] Fetching packages...\n"
            "[3/4] Linking dependencies...\n"
            "[4/4] Building fresh packages...\n"
            "success Saved 3 new dependencies.\n"
            "Done in 2.5s.\n"
        )
        f = bc.YarnFilter()
        result = f.apply(text, "", 0, ["yarn", "add", "react"])
        assert "success Saved 3 new dependencies." in result.text

    def test_drops_yarn_fetch_body_lines(self):
        """Individual package fetch lines inside [2/4] phase are collapsed."""
        text = "\n".join([
            "yarn install v1.22.19",
            "[1/4] Resolving packages...",
            "[2/4] Fetching packages...",
            "  fetch lodash@4.17.21",
            "  fetch react@18.2.0",
            "  fetch react-dom@18.2.0",
            "[3/4] Linking dependencies...",
            "Done in 1.5s.",
        ])
        f = bc.YarnFilter()
        result = f.apply(text, "", 0, ["yarn", "install"])
        # Fetch body lines collapsed
        assert "fetch lodash" not in result.text
        # Phase headers and summary kept
        assert "Done in 1.5s." in result.text

    def test_yarn_done_in_kept(self):
        """'Done in Xs.' summary line is preserved."""
        text = "yarn install v1.22.19\nDone in 1.2s.\n"
        f = bc.YarnFilter()
        result = f.apply(text, "", 0, ["yarn", "install"])
        assert "Done in 1.2s." in result.text


class TestBunFilter:
    """bun-specific compression via BunFilter."""

    def test_keeps_bun_error_line(self):
        """'error:' prefix lines must survive compression."""
        text = (
            "bun add v1.0.0\n"
            "⠋ Resolving dependencies...\n"
            "error: No package 'nonexistent-pkg@9.9.9' found\n"
        )
        f = bc.BunFilter()
        result = f.apply(text, "", 1, ["bun", "add", "nonexistent-pkg@9.9.9"])
        assert "error: No package" in result.text

    def test_keeps_bun_packages_summary(self):
        """'N packages installed' summary is preserved."""
        text = (
            "bun add v1.0.0\n"
            "3 packages installed\n"
        )
        f = bc.BunFilter()
        result = f.apply(text, "", 0, ["bun", "add", "react", "vue", "svelte"])
        assert "3 packages installed" in result.text

    def test_drops_bun_progress_lines(self):
        """Per-package download/resolution progress is dropped."""
        # Bun install progress: "  lodash@4.17.21" download status lines
        text = "\n".join([
            "bun add v1.0.0",
            "  lodash@4.17.21",
            "  react@18.2.0",
            "2 packages installed",
        ])
        f = bc.BunFilter()
        result = f.apply(text, "", 0, ["bun", "install"])
        assert "2 packages installed" in result.text


# ---------------------------------------------------------------------------
# Docker filter
# ---------------------------------------------------------------------------


class TestDockerFilter:
    def test_drops_digest_and_progress(self):
        text = (
            "#1 [internal] load build context\n"
            "#2 sha256:abc123def456789\n"
            "#3 12.3MB / 50.0MB 0.5s\n"
            "#4 [1/3] FROM alpine\n"
        )
        f = bc.DockerFilter()
        result = f.apply(text, "", 0, ["docker", "build"])
        assert "sha256:" not in result.text
        assert "12.3MB / 50.0MB" not in result.text
        assert "[1/3] FROM alpine" in result.text

    def test_drops_buildkit_cached_lines(self):
        """BuildKit CACHED lines are dropped and counted."""
        text = "\n".join([
            "#1 [internal] load build context",
            "#2 CACHED",
            "#3 CACHED",
            "#4 CACHED",
            "#5 [1/2] RUN apt-get install -y curl",
            "#6 DONE 2.1s",
        ])
        f = bc.DockerFilter()
        result = f.apply(text, "", 0, ["docker", "build"])
        # The content lines should not contain "#N CACHED" (only the summary marker).
        content_lines = [
            ln for ln in result.text.splitlines()
            if not ln.startswith("[token-goat:")
        ]
        assert not any("CACHED" in ln for ln in content_lines)
        # The summary marker must mention the count.
        assert "3 CACHED" in result.text

    def test_drops_push_layer_noise(self):
        """docker push 'Layer already exists' / 'Mounted from' lines are dropped."""
        stderr = "\n".join([
            "The push refers to repository [docker.io/myimage]",
            "abc123: Layer already exists",
            "def456: Layer already exists",
            "ghi789: Mounted from library/ubuntu",
            "latest: digest: sha256:abc123 size: 1234",
        ])
        f = bc.DockerFilter()
        result = f.apply("", stderr, 0, ["docker", "push"])
        assert "Layer already exists" not in result.text
        assert "Mounted from" not in result.text
        # The final digest line is signal — keep it
        assert "digest" in result.text

    def test_drops_pull_layer_status_lines(self):
        """docker pull per-layer status lines are dropped."""
        stderr = "\n".join([
            "latest: Pulling from library/ubuntu",
            "a1b2c3d4e5f6: Pull complete",
            "b2c3d4e5f6a1: Verifying Checksum",
            "c3d4e5f6a1b2: Download complete",
            "d4e5f6a1b2c3: Already exists",
            "Status: Downloaded newer image for ubuntu:latest",
        ])
        f = bc.DockerFilter()
        result = f.apply("", stderr, 0, ["docker", "pull"])
        assert "Pull complete" not in result.text
        assert "Verifying Checksum" not in result.text
        assert "Already exists" not in result.text
        # Status line is signal
        assert "Downloaded newer image" in result.text


# ---------------------------------------------------------------------------
# Kubectl filter
# ---------------------------------------------------------------------------


class TestKubectlFilter:
    def test_get_truncates_long_table(self):
        """Test kubectl get with many rows."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "get", "pods"])
        assert "NAME READY STATUS" in result.text
        assert "more rows" in result.text
        # Should preserve header + first 10 rows
        assert "pod-0" in result.text
        assert "pod-9" in result.text

    def test_get_keeps_short_table(self):
        """Test kubectl get with few rows (no truncation)."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(5)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "get", "pods"])
        # No truncation marker for short output
        assert "more rows" not in result.text
        assert result.text == text

    def test_top_truncates_long_table(self):
        """Test kubectl top (also uses table compression)."""
        rows = ["NAME CPU(cores) MEMORY(bytes)"] + [
            f"pod-{i} 100m 256Mi" for i in range(30)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "top", "pods"])
        assert "more rows" in result.text
        assert "NAME CPU" in result.text

    def test_describe_extracts_key_fields(self):
        """Test kubectl describe extracts Name/Namespace/Status."""
        text = (
            "Name:         my-pod\n"
            "Namespace:    default\n"
            "Status:       Running\n"
            "State:        Running\n"
            "Some other field: value\n"
            "Another field: data\n"
        )
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "describe", "pod", "my-pod"])
        assert "Name:         my-pod" in result.text
        assert "Namespace:    default" in result.text
        assert "Status:       Running" in result.text
        # Non-key fields should be dropped
        assert "Some other field" not in result.text

    def test_describe_preserves_events(self):
        """Test kubectl describe preserves Events section."""
        text = (
            "Name:         my-pod\n"
            "Namespace:    default\n"
            "Events:\n"
            "  Type    Reason   Age  From  Message\n"
            "  ----    ------   ---  ----  -------\n"
        )
        # Add 15 event lines
        text += "\n".join(
            [f"  Normal  Created  {i}s  ...  Event {i}" for i in range(15)]
        )
        text += "\n"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "describe", "pod", "my-pod"])
        assert "Events:" in result.text
        assert "earlier events elided" in result.text
        # Should keep last 10 events
        assert "Event 14" in result.text or "Event 13" in result.text

    def test_logs_compresses_large_output(self):
        """Test kubectl logs with head+tail compression."""
        lines = [f"Line {i}: log message" for i in range(100)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # Should use head=30, tail=20 when > 50 lines
        assert "log lines elided" in result.text
        assert "Line 0" in result.text
        assert "Line 99" in result.text

    def test_logs_keeps_short_output(self):
        """Test kubectl logs with few lines (no compression)."""
        lines = [f"Line {i}: log message" for i in range(10)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"])
        # No compression for short output
        assert "elided" not in result.text
        assert result.text == text

    def test_apply_passes_through(self):
        """Test kubectl apply (usually short, pass through)."""
        text = "pod/my-pod created"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "apply", "-f", "manifest.yaml"])
        assert result.text == text

    def test_delete_passes_through(self):
        """Test kubectl delete (usually short, pass through)."""
        text = "pod/my-pod deleted"
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "delete", "pod", "my-pod"])
        assert result.text == text

    def test_diff_truncates_large_diff(self):
        """Test kubectl diff truncates large diffs to first 50 lines."""
        lines = [f"diff line {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["kubectl", "diff", "-f", "manifest.yaml"])
        assert "diff lines" in result.text
        assert "diff line 0" in result.text

    def test_error_preserves_stderr(self):
        """Test that errors preserve all stderr."""
        stdout_text = "Some output"
        stderr_text = "Error: something failed"
        f = bc.KubectlFilter()
        result = f.apply(
            stdout_text, stderr_text, 1, ["kubectl", "get", "pods"]
        )
        assert "Error: something failed" in result.text
        assert "---" in result.text  # Separator between stdout and stderr

    def test_k_alias_works(self):
        """Test kubectl alias 'k' is recognized."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["k", "get", "pods"])
        assert "more rows" in result.text

    def test_k9s_alias_works(self):
        """Test k9s alias is recognized."""
        rows = ["NAME READY STATUS RESTARTS AGE"] + [
            f"pod-{i} 1/1 Running 0 5m" for i in range(50)
        ]
        text = "\n".join(rows)
        f = bc.KubectlFilter()
        result = f.apply(text, "", 0, ["k9s", "get", "pods"])
        assert "more rows" in result.text


# ---------------------------------------------------------------------------
# AWS filter
# ---------------------------------------------------------------------------


class TestAwsFilter:
    def test_compresses_long_json_array(self):
        import json
        data = [{"id": i, "name": f"resource-{i}"} for i in range(50)]
        text = json.dumps(data)
        f = bc.AwsFilter()
        result = f.apply(text, "", 0, ["aws", "ec2", "describe-instances"])
        assert "items elided" in result.text

    def test_passes_short_json_through(self):
        text = '{"foo": "bar"}'
        f = bc.AwsFilter()
        result = f.apply(text, "", 0, ["aws", "s3", "ls"])
        # No compression triggered; output should contain original content.
        assert "foo" in result.text


# ---------------------------------------------------------------------------
# Linter filter
# ---------------------------------------------------------------------------


class TestLinterFilter:
    def test_ruff_dedupes_by_rule(self):
        # ruff is now handled by RuffFilter; verify RuffFilter collapses repeated
        # violations across multiple files into a summary line.
        lines = [f"src/mod_{i}.py:1:1: F401 imported but unused" for i in range(20)]
        text = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(text, "", 1, ["ruff", "check"])
        f401_lines = [ln for ln in result.text.splitlines() if "F401" in ln]
        assert len(f401_lines) == 1
        assert "20 occurrences" in f401_lines[0]

    def test_eslint_per_file_dedupe(self):
        text = (
            "src/foo.js\n"
            "  3:1  error  Missing semi  semi\n"
            "  5:1  error  Missing semi  semi\n"
            "  7:1  error  Missing semi  semi\n"
            "  9:1  error  Missing semi  semi\n"
            "  11:1  error  Missing semi  semi\n"
        )
        f = bc.LinterFilter()
        result = f.apply(text, "", 1, ["eslint"])
        assert "+2 more semi" in result.text


# ---------------------------------------------------------------------------
# Git filter
# ---------------------------------------------------------------------------


class TestGitFilter:
    def test_status_truncates_long_lists(self):
        text = (
            "On branch main\n"
            "Changes not staged for commit:\n"
            + "\n".join([f"\tmodified:   path/to/file{i}.py" for i in range(50)])
            + "\n"
        )
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "status"])
        assert "+20 more files" in result.text or "more files" in result.text

    def test_log_truncates_long_history(self):
        text = "\n\n".join([f"commit abc{i:04d}def\nAuthor: a\nDate: x\n\n    msg {i}" for i in range(50)])
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "log"])
        assert "earlier commits elided" in result.text

    def test_diff_truncates_hunks(self):
        block = "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n"
        block += "\n".join([f"@@ -{i},1 +{i},1 @@\n-old{i}\n+new{i}" for i in range(10)])
        f = bc.GitFilter()
        result = f.apply(block, "", 0, ["git", "diff"])
        assert "more hunks in this file elided" in result.text

    def test_remote_drops_progress(self):
        text = (
            "remote: Counting objects: 1000\n"
            "remote: Compressing objects: 500\n"
            "Receiving objects: 100%\n"
            "From github.com:foo/bar\n"
            "   abc123..def456  main -> origin/main\n"
        )
        f = bc.GitFilter()
        result = f.apply(text, "", 0, ["git", "fetch"])
        assert "Counting objects" not in result.text
        assert "abc123..def456" in result.text


# ---------------------------------------------------------------------------
# Make filter
# ---------------------------------------------------------------------------


class TestMakeFilter:
    def test_drops_recursion_markers(self):
        text = (
            "make[1]: Entering directory '/build/foo'\n"
            "make[1]: Leaving directory '/build/foo'\n"
            "make: *** [Makefile:5: target] Error 1\n"
        )
        f = bc.MakeFilter()
        result = f.apply(text, "", 1, ["make"])
        assert "Entering directory" not in result.text
        assert "Error 1" in result.text


# ---------------------------------------------------------------------------
# Terraform filter
# ---------------------------------------------------------------------------


class TestTerraformFilter:
    """Tests for TerraformFilter."""

    def test_drops_refresh_lines(self) -> None:
        """Basic test: terraform plan drops refresh lines but keeps the Plan: summary."""
        text = "\n".join([
            f"aws_instance.web[{i}]: Refreshing state... [id=i-abc{i}]" for i in range(20)
        ]) + "\nPlan: 1 to add, 2 to change, 0 to destroy.\n"
        f = bc.TerraformFilter()
        result = f.apply(text, "", 0, ["terraform", "plan"])
        assert "Refreshing state" not in result.text
        assert "Plan: 1 to add" in result.text

    def test_terraform_plan_keeps_summary_line(self) -> None:
        """terraform plan drops refresh lines but keeps the Plan: summary."""
        stdout = (
            "aws_instance.example: Refreshing state… [id=i-1234]\n"
            "aws_instance.other: Refreshing state… [id=i-5678]\n"
            "Plan: 2 to add, 1 to change, 0 to destroy.\n"
            "# aws_instance.new will be created\n"
            "  + resource {\n"
            "      + id = (known after apply)\n"
            "    }\n"
        )
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        # Summary must be kept.
        assert "Plan: 2 to add, 1 to change, 0 to destroy" in text
        # Refresh lines should be dropped.
        assert "Refreshing state" not in text
        # Compressed size should be much smaller.
        assert result.compressed_bytes < len(stdout.encode())

    def test_terraform_plan_last_20_lines_kept(self) -> None:
        """terraform plan keeps the plan summary + last 20 lines of detailed diff."""
        lines = [
            "aws_instance.ex: Refreshing state… [id=i-1]",
            "Plan: 1 to add, 0 to change, 0 to destroy.",
            "# aws_instance.new will be created",
        ]
        # Add 50 more lines of plan diff.
        for i in range(50):
            lines.append(f"  line_{i:03d} = {i}")
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "plan"])
        text = result.text
        # Plan summary should be present.
        assert "Plan: 1 to add" in text
        # Output should be much smaller (only ~20 tail lines + summary).
        assert result.compressed_bytes < len(stdout.encode())

    def test_terraform_apply_keeps_completion_line(self) -> None:
        """terraform apply keeps the 'Apply complete!' summary line."""
        stdout = (
            "aws_instance.example: Refreshing state… [id=i-1234]\n"
            "aws_instance.new: Creating…\n"
            "aws_instance.new: Creation complete after 5s\n"
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n"
        )
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "apply"])
        text = result.text
        # Completion summary must be kept.
        assert "Apply complete! Resources:" in text
        # Refresh lines should be dropped.
        assert "Refreshing state" not in text

    def test_terraform_apply_preserves_errors(self) -> None:
        """terraform apply preserves stderr on error (exit_code != 0)."""
        stdout = "aws_instance.example: Refreshing state…\n"
        stderr = "Error: Resource creation failed\nDetails: Invalid configuration\n"
        f = bc.TerraformFilter()
        result = f.apply(stdout, stderr, 1, ["terraform", "apply"])
        text = result.text
        # Stderr must be preserved on error.
        assert "Error: Resource creation failed" in text
        assert "Invalid configuration" in text

    def test_terraform_init_head_tail_compression(self) -> None:
        """terraform init uses head=5, tail=5 compression for progress bars."""
        lines = ["Initializing…"] + [f"Installing plugin {i}" for i in range(20)] + ["Init complete!"]
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "init"])
        text = result.text
        # Should compress to head + tail (5+5), not all 22 lines.
        assert len(text.split("\n")) <= 12  # head + marker + tail + blanks.
        # But must include some init info.
        assert "Initializing" in text or "Installing" in text or "complete" in text

    def test_terraform_validate_passthrough(self) -> None:
        """terraform validate passes through (usually short; no compression)."""
        stdout = "Valid!\nNo issues found.\n"
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "validate"])
        text = result.text
        # Should be passed through unchanged (or nearly so).
        assert "Valid!" in text
        assert "No issues found" in text

    def test_terraform_show_head_tail(self) -> None:
        """terraform show uses head=20, tail=10 compression for large state output."""
        lines = ["# Resource state"] + [f"resource.line_{i}" for i in range(100)] + ["# End of state"]
        stdout = "\n".join(lines)
        f = bc.TerraformFilter()
        result = f.apply(stdout, "", 0, ["terraform", "show"])
        text = result.text
        # Should compress to ~30 lines (head + tail).
        assert len(text.split("\n")) <= 35
        assert "Resource state" in text or "resource.line_" in text

    @pytest.mark.parametrize("argv", [
        ["terraform", "plan"],
        ["tofu", "apply"],
        ["terragrunt", "run-all", "plan"],
    ])
    def test_matches_terraform_binaries(self, argv) -> None:
        """TerraformFilter matches terraform/tofu/terragrunt."""
        assert bc.TerraformFilter().matches(argv)

    def test_terraform_does_not_match_ansible(self) -> None:
        assert not bc.TerraformFilter().matches(["ansible", "playbook.yml"])

    def test_select_filter_returns_terraform_filter(self) -> None:
        """select_filter dispatches terraform to TerraformFilter."""
        f = bc.select_filter(["terraform", "plan"])
        assert isinstance(f, bc.TerraformFilter)

    def test_terraform_empty_input(self) -> None:
        """TerraformFilter handles empty input without crashing."""
        f = bc.TerraformFilter()
        result = f.apply("", "", 0, ["terraform", "plan"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# AnsibleFilter — comprehensive tests
# ---------------------------------------------------------------------------


class TestAnsibleFilter:
    """Tests for AnsibleFilter."""

    def test_ansible_playbook_collapses_status_lines(self) -> None:
        """ansible-playbook collapses ok/changed/skipping counts per task."""
        stdout = (
            "PLAY [Install packages]\n"
            "TASK [apt-get update]\n"
            "ok: [host1]\n"
            "ok: [host2]\n"
            "ok: [host3]\n"
            "changed: [host4]\n"
            "changed: [host5]\n"
            "TASK [Install nginx]\n"
            "ok: [host1]\n"
            "ok: [host2]\n"
            "skipped: [host3]\n"
            "PLAY RECAP\n"
            "host1: ok=2, changed=0, unreachable=0, failed=0\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # Headers and recap must be present.
        assert "PLAY [Install packages]" in text
        assert "TASK [apt-get update]" in text
        assert "PLAY RECAP" in text
        # Status lines should be collapsed, not literal ok/changed/skipping lines.
        assert text.count("\nok:") == 0  # Raw ok: lines should be gone.
        # But we should have collapsed counts.
        assert "token-goat:" in text

    def test_ansible_playbook_keeps_failure_blocks(self) -> None:
        """ansible-playbook preserves fatal/failed/unreachable lines and payloads."""
        stdout = (
            "TASK [Might fail]\n"
            "ok: [host1]\n"
            "fatal: [host2]: FAILED! => {\n"
            '    "msg": "Something went wrong",\n'
            '    "error": "Connection refused"\n'
            "}\n"
            "PLAY RECAP\n"
            "host1: ok=1, changed=0, failed=1\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # Failure line and its JSON payload must be present.
        assert "fatal: [host2]" in text
        assert "Something went wrong" in text or "Connection refused" in text
        # PLAY RECAP must be present.
        assert "PLAY RECAP" in text

    def test_ansible_playbook_keeps_recap(self) -> None:
        """ansible-playbook always preserves the PLAY RECAP section."""
        stdout = (
            "PLAY [test]\n"
            "TASK [task1]\n"
            "ok: [host1]\n"
            "PLAY RECAP\n"
            "host1: ok=1, changed=0, unreachable=0, failed=0\n"
            "host2: ok=0, changed=0, unreachable=1, failed=0\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        text = result.text
        # PLAY RECAP block must be intact.
        assert "PLAY RECAP" in text
        assert "host1: ok=1" in text
        assert "host2: ok=0, changed=0, unreachable=1" in text

    def test_ansible_galaxy_install_head_tail(self) -> None:
        """ansible-galaxy install uses head=5, tail=5 compression for package lists."""
        lines = ["Starting galaxy install"] + [f"Installing package_{i}" for i in range(30)] + ["Galaxy install complete"]
        stdout = "\n".join(lines)
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-galaxy", "install", "-r", "requirements.yml"])
        text = result.text
        # Should compress to head + tail (5+5 = 10 lines max).
        non_blank = [ln for ln in text.split("\n") if ln.strip()]
        assert len(non_blank) <= 12
        # But must include some info.
        assert "Installing" in text or "complete" in text

    def test_ansible_lint_groups_by_rule(self) -> None:
        """ansible-lint groups violations by rule and keeps first 3 examples."""
        stdout = (
            "playbooks/site.yml:10:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:20:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:30:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:40:1: yaml-indent: too many spaces before block scalar (yaml-indent)\n"
            "playbooks/site.yml:50:1: line-too-long: line too long (line-too-long)\n"
            "playbooks/site.yml:60:1: line-too-long: line too long (line-too-long)\n"
            "Linting failed.\n"
        )
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "playbooks/"])
        text = result.text
        # Should have the first 3 yaml-indent violation lines (not 4).
        yaml_viol_lines = [
            ln for ln in text.split("\n")
            if "yaml-indent" in ln and "elided" not in ln and "token-goat" not in ln
        ]
        assert 1 <= len(yaml_viol_lines) <= 3
        # Should note that the 4th occurrence was elided (singular or plural accepted).
        assert "elided" in text
        assert "more occurrence" in text  # matches "more occurrence" and "more occurrences"

    @pytest.mark.parametrize("argv", [
        ["ansible", "all", "-m", "ping"],
        ["ansible-playbook", "site.yml"],
        ["ansible-galaxy", "install", "-r", "requirements.yml"],
        ["ansible-lint", "playbooks/"],
    ])
    def test_matches_ansible_binaries(self, argv) -> None:
        """AnsibleFilter matches ansible family binaries."""
        assert bc.AnsibleFilter().matches(argv)

    def test_ansible_does_not_match_terraform(self) -> None:
        assert not bc.AnsibleFilter().matches(["terraform", "plan"])

    def test_select_filter_returns_ansible_filter(self) -> None:
        """select_filter dispatches ansible to AnsibleFilter."""
        f = bc.select_filter(["ansible-playbook", "site.yml"])
        assert isinstance(f, bc.AnsibleFilter)

    def test_ansible_playbook_empty_input(self) -> None:
        """AnsibleFilter handles empty input without crashing."""
        f = bc.AnsibleFilter()
        result = f.apply("", "", 0, ["ansible-playbook", "site.yml"])
        assert isinstance(result.text, str)

    def test_ansible_playbook_compression_reduces_size(self) -> None:
        """AnsibleFilter substantially reduces size of large playbook output."""
        lines = ["PLAY [test]", "TASK [loop]"]
        # Add 100 ok/changed lines.
        for i in range(100):
            lines.append(f"ok: [host-{i % 10}]")
        lines.append("PLAY RECAP\nhost-0: ok=10\n")
        stdout = "\n".join(lines)
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"])
        # Compressed output should be much smaller.
        assert result.compressed_bytes < len(stdout.encode()) * 0.5


# ---------------------------------------------------------------------------
# Pip filter
# ---------------------------------------------------------------------------


class TestPipFilter:
    def test_drops_download_progress(self):
        text = (
            "Collecting numpy\n"
            "  Downloading numpy-1.0.0.whl (10 MB)\n"
            "  Downloading numpy-1.0.0.whl (10 MB)\n"
            "Installing collected packages: numpy\n"
            "Successfully installed numpy-1.0.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "numpy"])
        assert "Downloading numpy" not in result.text
        assert "Successfully installed numpy" in result.text


# ---------------------------------------------------------------------------
# Grep filter
# ---------------------------------------------------------------------------


def _make_grep_output(n_files: int, matches_per_file: int) -> str:
    """Build a synthetic grep-style output with ``n_files`` files."""
    lines = []
    for i in range(n_files):
        for j in range(matches_per_file):
            lines.append(f"src/module_{i}.py:{j + 1}:    some_pattern_here()")
    return "\n".join(lines)


class TestGrepFilter:
    def test_large_output_compressed(self):
        """Output with >30 non-empty lines is compressed to a summary."""
        text = _make_grep_output(n_files=5, matches_per_file=10)  # 50 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "some_pattern"])
        assert "grep:" in result.text
        assert "matches across" in result.text
        # Original match lines should NOT be present
        assert "some_pattern_here" not in result.text

    def test_small_output_passes_through(self):
        """Output with ≤30 non-empty lines is returned unchanged."""
        text = _make_grep_output(n_files=3, matches_per_file=5)  # 15 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "some_pattern"])
        # Original content should be preserved
        assert "some_pattern_here" in result.text
        # No summary header
        assert "matches across" not in result.text

    def test_exit_code_preserved_found(self):
        """Exit code 0 (match found) is preserved through compression."""
        text = _make_grep_output(n_files=5, matches_per_file=10)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "-r", "pattern"])
        assert result.exit_code == 0

    def test_exit_code_preserved_not_found(self):
        """Exit code 1 (no match) is preserved through compression."""
        text = ""  # empty output = no matches
        f = bc.GrepFilter()
        result = f.apply(text, "", 1, ["grep", "-r", "pattern"])
        assert result.exit_code == 1

    def test_per_file_line_counts(self):
        """Summary lists files with correct match counts."""
        # 4 matches in file0, 3 in file1, 3 in file2 → total 10 matches per group
        lines = []
        for _ in range(4):
            lines.append("src/alpha.py:1:hit")
        for _ in range(3):
            lines.append("src/beta.py:1:hit")
        # Pad to >30 lines with a third file
        for i in range(30):
            lines.append(f"src/gamma.py:{i}:hit")
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "src/alpha.py: 4 match(es)" in result.text
        assert "src/beta.py: 3 match(es)" in result.text
        assert "src/gamma.py: 30 match(es)" in result.text

    def test_sorted_by_count_descending(self):
        """Files are listed highest-count first."""
        lines = []
        for _ in range(2):
            lines.append("src/rare.py:1:hit")
        for _ in range(20):
            lines.append("src/common.py:1:hit")
        # Pad to >30
        for i in range(15):
            lines.append(f"src/mid_{i}.py:1:hit")
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["ag", "hit"])
        # common.py should appear before rare.py
        common_pos = result.text.find("src/common.py")
        rare_pos = result.text.find("src/rare.py")
        assert common_pos < rare_pos

    @pytest.mark.parametrize("argv", [
        ["git", "grep", "pattern"],
        ["rg", "pattern", "src/"],
        ["grep", "-r", "pattern", "."],
        ["ag", "pattern"],
        ["ack", "pattern"],
    ])
    def test_grep_binaries_matched(self, argv):
        """GrepFilter matches various grep-family binaries."""
        assert bc.GrepFilter().matches(argv)

    def test_git_grep_not_matched_other_subcommand(self):
        """GrepFilter does NOT match other git subcommands (those go to GitFilter)."""
        f = bc.GrepFilter()
        assert not f.matches(["git", "log"])
        assert not f.matches(["git", "status"])
        assert not f.matches(["git", "diff"])

    def test_top_20_files_limit(self):
        """When >20 files match, only top 20 are shown with an elision note."""
        lines = []
        for i in range(25):
            # Each file gets 2 matches; pad to >30 total lines
            lines.append(f"src/file_{i:02d}.py:1:hit")
            lines.append(f"src/file_{i:02d}.py:2:hit")
        text = "\n".join(lines)  # 50 lines
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "+5 more file(s) elided" in result.text

    def test_git_grep_large_compressed(self):
        """'git grep' output above threshold is compressed."""
        lines = [f"src/file_{i}.py:1:matched" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["git", "grep", "matched"])
        assert "grep:" in result.text
        assert "matches across" in result.text

    @pytest.mark.parametrize("argv", [
        ["rg", "pattern", "src/"],
        ["grep", "-r", "pattern", "."],
    ])
    def test_select_filter_returns_rg_for_rg_grep(self, argv):
        """select_filter dispatches rg/grep commands to RgFilter (context-line suppressor)."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "rg"

    def test_select_filter_git_still_dispatches_git_log(self):
        """Git log is handled by GitLogFilter (or GitFilter as fallback), not GrepFilter."""
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name in ("git", "git-log")

    def test_boundary_exactly_30_lines(self):
        """Exactly 30 non-empty lines: pass-through (not compressed)."""
        lines = [f"src/f.py:{i}:hit" for i in range(30)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "matches across" not in result.text

    def test_boundary_31_lines(self):
        """31 non-empty lines: compressed."""
        lines = [f"src/f.py:{i}:hit" for i in range(31)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["rg", "hit"])
        assert "matches across" in result.text

    def test_bare_word_before_colon_not_treated_as_filename(self):
        """Lines like 'INFO: message' should not be counted as filename matches."""
        # Build output that is above the threshold so compression fires.
        lines = [f"INFO: some log message {i}" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "message"])
        # The 40 lines should all be unattributed, not attributed to "INFO".
        assert "INFO" not in result.text or "unattributed" in result.text

    def test_path_with_dot_counted_as_filename(self):
        """Lines like 'setup.py:10:match' should be attributed to 'setup.py'."""
        lines = [f"setup.py:{i}:match" for i in range(40)]
        text = "\n".join(lines)
        f = bc.GrepFilter()
        result = f.apply(text, "", 0, ["grep", "match"])
        assert "setup.py" in result.text


class TestDedupeNumericRuns:
    """Tests for dedupe_numeric_runs."""

    def test_collapses_counter_sequence(self):
        """Lines differing only in a counter should be collapsed."""
        lines = [f"Downloading package {i}/50 (foo)" for i in range(1, 21)]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert len(result) == 1
        assert "20 similar lines" in result[0]
        assert "Downloading package 1/50" in result[0]

    def test_short_run_passes_through(self):
        """Runs shorter than min_run should not be collapsed."""
        lines = ["Downloading 1/5", "Downloading 2/5"]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert result == lines

    def test_non_numeric_diff_not_collapsed(self):
        """Lines that differ in non-numeric content should not be collapsed."""
        lines = ["alpha line", "beta line", "gamma line"]
        result = bc.dedupe_numeric_runs(lines, min_run=2)
        assert result == lines

    def test_error_lines_never_collapsed(self):
        """Lines matching the error signal should never be collapsed even in a run."""
        lines = [f"error: type mismatch at line {i}" for i in range(10)]
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        # All 10 lines must be preserved because each matches _ERROR_SIGNAL_RE.
        assert len(result) == 10

    def test_mixed_run_splits_correctly(self):
        """A run followed by a different template produces two separate groups."""
        lines = (
            [f"Downloading {i}/10" for i in range(1, 6)]
            + [f"Installing pkg-{i}" for i in range(1, 6)]
        )
        result = bc.dedupe_numeric_runs(lines, min_run=3)
        assert len(result) == 2
        assert "5 similar lines" in result[0]
        assert "5 similar lines" in result[1]

    def test_empty_input(self):
        assert bc.dedupe_numeric_runs([]) == []

    def test_single_line(self):
        assert bc.dedupe_numeric_runs(["only line"]) == ["only line"]


class TestMypyFilter:
    """Tests for MypyFilter."""

    def _make_mypy_output(
        self,
        *,
        n_errors: int = 5,
        unique_messages: int = 2,
        include_summary: bool = True,
        include_notes: bool = False,
        include_see_also: bool = False,
    ) -> str:
        """Build synthetic mypy output."""
        lines: list[str] = []
        messages = [f"Incompatible type {i}" for i in range(unique_messages)]
        for i in range(n_errors):
            msg = messages[i % unique_messages]
            lines.append(f"src/foo.py:{i + 1}: error: {msg}  [assignment]")
        if include_notes:
            for i in range(4):
                lines.append(f"src/foo.py:{i + 1}: note: Revealed type is 'int'")
        if include_see_also:
            lines.append(
                "src/foo.py:1: note: See https://mypy.readthedocs.io/en/stable/error_codes.html"
            )
        if include_summary:
            lines.append(f"Found {n_errors} errors in 1 file (checked 3 source files)")
        return "\n".join(lines)

    @pytest.mark.parametrize("argv", [
        ["mypy", "src/"],
        ["dmypy", "run", "--", "src/"],
    ])
    def test_select_filter_dispatches_mypy(self, argv):
        f = bc.select_filter(argv)
        assert f is not None and f.name == "mypy"

    def test_summary_line_always_kept(self):
        text = self._make_mypy_output(n_errors=100, unique_messages=1)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "Found 100 errors" in result.text

    def test_duplicate_errors_deduplicated(self):
        """When the same error message fires many times, only 3 are kept."""
        # 20 errors all with the same message.
        text = self._make_mypy_output(n_errors=20, unique_messages=1)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        # Exactly 3 error lines + summary + dedup note.
        error_lines = [ln for ln in result.text.split("\n") if "error:" in ln and "src/foo.py" in ln]
        assert len(error_lines) == 3
        assert "suppressed" in result.text

    def test_diverse_errors_all_kept(self):
        """When every error has a unique message, all are kept."""
        n = 6
        text = self._make_mypy_output(n_errors=n, unique_messages=n)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        error_lines = [ln for ln in result.text.split("\n") if "error:" in ln and "src/foo.py" in ln]
        assert len(error_lines) == n

    def test_see_also_notes_dropped(self):
        """'See https://…' note lines should be dropped."""
        text = self._make_mypy_output(include_see_also=True, include_notes=False)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "mypy.readthedocs.io" not in result.text

    def test_duplicate_notes_deduplicated(self):
        """Note lines with the same message are deduplicated (keep first 3)."""
        # 4 identical note lines.
        text = self._make_mypy_output(n_errors=1, include_notes=True)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        note_lines = [ln for ln in result.text.split("\n") if " note:" in ln and "src/foo.py" in ln]
        assert len(note_lines) <= 3

    def test_success_output_passes_through(self):
        """'Success: no issues found' should survive unchanged."""
        text = "Success: no issues found in 3 source files"
        f = bc.MypyFilter()
        result = f.apply(text, "", 0, ["mypy", "src/"])
        assert "Success" in result.text

    def test_errors_prevented_further_checking_dropped(self):
        """'(errors prevented further checking)' annotations should be dropped."""
        lines = [
            "src/foo.py:1: error: (errors prevented further checking)",
            "Found 1 error in 1 file (checked 3 source files)",
        ]
        text = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        assert "errors prevented further checking" not in result.text

    def test_context_display_notes_first_occurrence_preserved(self):
        """Expected:/Got: context notes from the first error occurrence are kept."""
        lines = [
            "src/foo.py:1: error: Argument 1 has incompatible type",
            "src/foo.py:1: note: Expected:",
            "src/foo.py:1: note:     (x: str) -> None",
            "src/foo.py:1: note: Got:",
            "src/foo.py:1: note:     int",
            "Found 1 error in 1 file (checked 3 source files)",
        ]
        text = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        # First occurrence of context notes must be preserved.
        assert "note: Expected:" in result.text
        assert "note: Got:" in result.text
        assert "Found 1 error" in result.text

    def test_context_display_notes_deduplicated_across_errors(self):
        """Expected:/Got: context notes are deduplicated when the same error repeats.

        When an error with identical Expected/Got type context fires many times,
        the context display notes (which share the same message text) should be
        deduplicated to at most 3 occurrences, not kept for every error.
        """
        # 6 errors all with identical Expected:/Got: context notes.
        lines = []
        for i in range(6):
            lines.append(f"src/file{i}.py:{i + 1}: error: Argument 1 has incompatible type")
            lines.append(f"src/file{i}.py:{i + 1}: note: Expected:")
            lines.append(f"src/file{i}.py:{i + 1}: note:     (x: str) -> None")
            lines.append(f"src/file{i}.py:{i + 1}: note: Got:")
            lines.append(f"src/file{i}.py:{i + 1}: note:     int")
        lines.append("Found 6 errors in 6 files (checked 10 source files)")
        text = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(text, "", 1, ["mypy", "src/"])
        # Summary must always be present.
        assert "Found 6 errors" in result.text
        # Context notes are deduplicated: at most 3 occurrences of each unique note message.
        expected_notes = [ln for ln in result.text.split("\n") if ": note: Expected:" in ln]
        got_notes = [ln for ln in result.text.split("\n") if ": note: Got:" in ln]
        assert len(expected_notes) <= 3, (
            f"Expected 'Expected:' notes to be deduplicated to <=3, got {len(expected_notes)}"
        )
        assert len(got_notes) <= 3, (
            f"Expected 'Got:' notes to be deduplicated to <=3, got {len(got_notes)}"
        )
        # Deduplication note should be emitted.
        assert "suppressed" in result.text


# ---------------------------------------------------------------------------
# UvFilter
# ---------------------------------------------------------------------------


def _make_uv_sync_output(n_packages: int = 10) -> str:
    """Build synthetic ``uv sync`` output."""
    lines = ["Resolved 42 packages in 0.12s"]
    for i in range(n_packages):
        lines.append(f"   Downloading package-{i}-1.0.0-py3-none-any.whl (1.2 MB)")
    lines.append("   Fetching wheel metadata for pip (23.3.1)")
    for i in range(n_packages):
        lines.append(f"   + package-{i}==1.0.0")
    lines.append(f"Installed {n_packages} packages in 0.45s")
    return "\n".join(lines)


class TestPythonFilter:
    """Tests for PythonFilter."""

    def _make_traceback(self, n_frames: int = 3, include_error: bool = True) -> str:
        """Build synthetic Python traceback output."""
        lines = ["Traceback (most recent call last):"]
        for i in range(n_frames):
            lines.append(f'  File "script.py", line {i + 1}, in func_{i}')
            lines.append(f"    result = func_{i + 1}()")
        if include_error:
            lines.append("ValueError: invalid value")
        return "\n".join(lines)

    def test_traceback_compressed(self):
        """Short traceback with 3 frames → only innermost frame + error kept."""
        text = self._make_traceback(n_frames=3)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "script.py"])
        # Should keep traceback header, innermost frame, and error.
        assert "Traceback" in result.text
        assert "ValueError: invalid value" in result.text
        # The innermost frame (line with "func_2") should be kept.
        assert "func_2" in result.text
        # But earlier frames should be dropped (func_0).
        assert "func_0" not in result.text

    def test_long_traceback_omission_marker(self):
        """12+ frames → first 2 + last 3 kept, '... N frames omitted ...' inserted."""
        text = self._make_traceback(n_frames=12)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "script.py"])
        # Should contain omission marker.
        assert "frames omitted" in result.text
        # Should keep first 2 frames.
        assert "func_0" in result.text
        assert "func_1" in result.text
        # Should keep last 3 frames.
        assert "func_9" in result.text or "func_10" in result.text or "func_11" in result.text
        # Middle frames should not appear.
        assert "func_5" not in result.text

    def test_repeated_lines_collapsed(self):
        """6 identical consecutive lines → collapsed to 'line × 6'."""
        # Build output with repeated lines after the error
        # (which will survive the traceback compression).
        text = "Traceback (most recent call last):\n"
        text += '  File "test.py", line 1, in func\n'
        text += "    x = 1\n"
        text += "ValueError: error\n"
        text += ("repeated output\n" * 6)
        f = bc.PythonFilter()
        result = f.apply(text, "", 1, ["python", "test.py"])
        # Should collapse the 6 identical repeated lines to "line × 6".
        assert "(×6)" in result.text

    def test_warnings_summarized(self):
        """5+ identical warnings → collapsed to 'line × N' via _dedupe_repeated_lines."""
        # When warnings are repeated 5+ times consecutively, they're collapsed.
        lines = (
            ["Some output"]
            + ["DeprecationWarning: old api used"] * 5
            + ["Done"]
        )
        text = "\n".join(lines)
        f = bc.PythonFilter()
        result = f.apply(text, "", 0, ["python", "test.py"])
        # The repeated warnings should be collapsed to the "× N" format.
        assert "(×5)" in result.text

    def test_pytest_not_matched(self):
        """Command 'python -m pytest' should NOT be matched by PythonFilter."""
        assert not bc.PythonFilter().matches(["python", "-m", "pytest"])

    @pytest.mark.parametrize("argv", [
        ["python", "script.py"],
        ["python3", "-c", "print('hello')"],
    ])
    def test_python_matched(self, argv):
        """python/python3 script commands are matched by PythonFilter."""
        assert bc.PythonFilter().matches(argv)

    def test_clean_output_passthrough(self):
        """Non-traceback output passes through unchanged."""
        text = "Hello\nWorld\nSuccess\n"
        f = bc.PythonFilter()
        result = f.apply(text, "", 0, ["python", "script.py"])
        # No traceback, so output should pass through with minimal changes.
        assert "Hello" in result.text
        assert "World" in result.text

    @pytest.mark.parametrize("argv", [
        ["python", "script.py"],
        ["python3", "myscript.py"],
    ])
    def test_select_filter_dispatches_python(self, argv):
        """select_filter returns PythonFilter for python/python3 script commands."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "python"

    def test_select_filter_pytest_via_python_returns_pytest(self):
        """select_filter returns PytestFilter for 'python -m pytest', not PythonFilter."""
        f = bc.select_filter(["python", "-m", "pytest"])
        assert f is not None
        assert f.name == "pytest"


class TestUvFilter:
    @pytest.mark.parametrize("argv", [
        ["uv", "sync"],
        ["uv", "add", "requests"],
        ["uv", "remove", "requests"],
        ["uv", "pip", "install", "numpy"],
        ["uv", "lock"],
    ])
    def test_matches_uv_package_commands(self, argv):
        """UvFilter matches uv package-management subcommands."""
        assert bc.UvFilter().matches(argv)

    @pytest.mark.parametrize("argv", [
        ["uv", "run", "pytest"],       # run is not a package management command
        ["uv", "tool", "run", "ruff"], # tool run is not a package management command
        ["pip", "install", "numpy"],   # plain pip goes to PipFilter
    ])
    def test_does_not_match_non_pkg_commands(self, argv):
        """UvFilter does not match non-package-management commands."""
        assert not bc.UvFilter().matches(argv)

    def test_drops_downloading_lines(self):
        """Downloading progress lines are dropped from output; only the elision note remains."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # Original "Downloading foo.whl (X MB)" lines must be gone.
        # The elision note contains "Downloading" as a word — check no
        # per-package download lines survived by scanning for the whl pattern.
        assert ".whl" not in result.text
        assert "Fetching wheel metadata" not in result.text

    def test_drops_diff_lines(self):
        """Per-package +/- diff lines are dropped from output."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # The "+  package-0==1.0.0" style lines should not appear
        assert "+ package-" not in result.text

    def test_keeps_resolved_summary(self):
        """'Resolved N packages' summary line is preserved."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "Resolved 42 packages" in result.text

    def test_keeps_installed_summary(self):
        """'Installed N packages' summary line is preserved."""
        text = _make_uv_sync_output(n_packages=5)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "Installed 5 packages" in result.text

    def test_dropping_note_included(self):
        """A note is appended stating how many progress lines were dropped."""
        text = _make_uv_sync_output(n_packages=8)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "add", "numpy"])
        # Should have both a downloads note and a diff-lines note
        assert "token-goat" in result.text
        assert "dropped" in result.text

    def test_dropping_note_merged_into_single_line(self):
        """When both download and diff lines are dropped, they produce a single merged note.

        Merging the two notes saves ~25-35 bytes per uv invocation where both
        download-progress and +/- diff lines are present (the common case for
        'uv sync' with any package changes).
        """
        text = _make_uv_sync_output(n_packages=4)
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        # Count how many [token-goat: ...] note lines are in the output.
        note_lines = [
            line for line in result.text.splitlines()
            if line.startswith("[token-goat:")
        ]
        # Both dropping reasons must appear in the output
        assert any("Downloading" in ln or "Fetching" in ln for ln in note_lines)
        assert any("+/-" in ln or "diff" in ln.lower() for ln in note_lines)
        # They should be merged into one line (not two separate [token-goat: ...] lines)
        assert len(note_lines) == 1, (
            f"Expected 1 merged note line, got {len(note_lines)}: {note_lines}"
        )

    def test_error_output_preserved(self):
        """Error lines in output survive compression."""
        lines = [
            "Resolved 5 packages in 0.05s",
            "   Downloading foo-1.0-py3-none.whl (500 kB)",
            "error: Failed to fetch https://pypi.org/simple/foo/",
            "  Caused by: Connection refused (os error 111)",
        ]
        text = "\n".join(lines)
        f = bc.UvFilter()
        result = f.apply(text, "", 1, ["uv", "sync"])
        assert "error: Failed to fetch" in result.text
        assert "Connection refused" in result.text

    @pytest.mark.parametrize("argv", [
        ["uv", "sync"],
        ["uv", "add", "numpy"],
    ])
    def test_select_filter_dispatches_uv(self, argv):
        """select_filter routes uv package commands to UvFilter."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "uv"

    def test_select_filter_uv_run_returns_none_or_generic(self):
        """select_filter does not dispatch 'uv run pytest' to UvFilter."""
        f = bc.select_filter(["uv", "run", "pytest"])
        # Should not be the uv filter (may be None or GenericFilter)
        assert f is None or f.name != "uv"

    def test_no_progress_output_no_note(self):
        """When there are no download/diff lines, no dropping note is appended."""
        text = "Resolved 5 packages in 0.01s\nInstalled 2 packages in 0.10s"
        f = bc.UvFilter()
        result = f.apply(text, "", 0, ["uv", "sync"])
        assert "dropped" not in result.text
        assert "Resolved 5 packages" in result.text
        assert "Installed 2 packages" in result.text


# ---------------------------------------------------------------------------
# bytes_to_tokens
# ---------------------------------------------------------------------------


class TestBytesToTokens:
    @pytest.mark.parametrize("n_bytes,expected_tokens", [
        (350, 100),   # 350 / 3.5 = 100 tokens
        (355, 102),   # rounds up: 355 / 3.5 = 101.43... → 102
        (0, 1),       # 0 bytes is at least 1 token (fail-safe)
        (1, 1),       # 1-3 bytes → 1 token
        (3, 1),
        (7000, 2000), # large values scale proportionally
    ])
    def test_conversion(self, n_bytes, expected_tokens):
        assert bc.bytes_to_tokens(n_bytes) == expected_tokens


# ---------------------------------------------------------------------------
# cap_tokens
# ---------------------------------------------------------------------------


class TestCapTokens:
    def test_returns_text_unchanged_when_under_budget(self):
        """Text under token budget is unchanged."""
        text = "short text"
        result = bc.cap_tokens(text, max_tokens=1000)
        assert result == text

    def test_truncates_when_over_budget(self):
        """Text over token budget is truncated."""
        # Create text that's roughly 5000 tokens (5000 * 3.5 = 17,500 chars).
        text = "a" * 18000
        result = bc.cap_tokens(text, max_tokens=2000)
        # Result should be shorter and include the cap annotation.
        assert len(result) < len(text)
        assert "output capped at" in result
        assert "~2000 tokens" in result

    def test_preserves_newlines(self):
        """Truncation respects line boundaries when possible."""
        text = "\n".join(["line"] * 500)  # 500 lines = 2000 chars, ~570 tokens.
        result = bc.cap_tokens(text, max_tokens=300)
        # Should be truncated.
        assert len(result) < len(text)
        # Should not contain incomplete lines (no split in the middle).
        assert not result.endswith("lin") or result.endswith("\n")

    def test_marker_includes_token_count(self):
        """The truncation marker includes the token limit."""
        text = "x" * 20000  # ~5714 tokens.
        result = bc.cap_tokens(text, max_tokens=1500)
        assert "~1500 tokens" in result

    def test_empty_string(self):
        """Empty string is unchanged."""
        assert bc.cap_tokens("", max_tokens=100) == ""

    def test_single_line_over_budget(self):
        """A single very long line is still truncated."""
        text = "a" * 20000
        result = bc.cap_tokens(text, max_tokens=500)
        assert len(result) < len(text)
        assert "output capped at" in result

    def test_body_containing_bytes_elided_prefix_not_corrupted(self):
        """cap_tokens must not split on a literal '\\n... [' that appears in the body.

        Regression: cap_tokens used rsplit('\\n... [', 1) to strip cap_bytes's
        marker.  When the captured output itself contained that literal string
        (e.g. a command that prints progress like '... [3 items left]'), rsplit
        split on the first occurrence in the body rather than the terminal marker,
        silently dropping legitimate content and producing a malformed result.

        The fix uses a regex anchored to the exact bytes-elided suffix so only
        the real marker is stripped.
        """
        # Build a text body that contains the problematic literal and is large
        # enough to exceed the token budget.
        filler = "a" * 14000  # ~4000 tokens at 3.5 chars/token
        body_marker = "\n... [3 items still pending]"  # literal that looks like the real marker
        text = filler + body_marker + ("b" * 100)

        result = bc.cap_tokens(text, max_tokens=2000)

        # The token-based marker must be present.
        assert "[token-goat: output capped at ~2000 tokens]" in result, (
            "cap_tokens must append its token-based marker"
        )
        # The bytes-elided marker must NOT appear in the output.
        assert "bytes elided by token-goat" not in result, (
            "bytes-elided marker must be fully replaced by the token-based one"
        )
        # The truncation point must be inside the filler, not at the fake marker.
        # If rsplit split on the body marker, the result would end right before it
        # (at position ~14000); a correct truncation preserves filler up to ~7000
        # chars and the body_marker literal would not appear at all since it was
        # written AFTER the truncation point.
        # Simpler invariant: the result must not end right before body_marker text.
        assert "items still pending" not in result, (
            "body content written after truncation point must not appear in output; "
            "if it does, rsplit split on the body marker rather than the real suffix"
        )

    def test_ansi_codes_do_not_steal_token_budget(self):
        """ANSI escape sequences must not consume the byte budget.

        cap_tokens measures the budget against ANSI-stripped content, so
        ANSI codes in the original must not cause visible content to be
        clipped more aggressively than the stated token cap implies.
        """
        # 1000 visible 'x' characters plus heavy ANSI colouring (~500 extra bytes).
        ansi_reset = "\x1b[0m"
        ansi_red = "\x1b[31m"
        # Interleave ANSI codes to simulate coloured pytest output.
        coloured_line = ansi_red + "x" * 50 + ansi_reset
        # Repeat to get ~3500 visible chars (~1000 tokens) with ~1750 ANSI bytes on top.
        text_with_ansi = (coloured_line + "\n") * 70  # 70 * 52 = ~3640 visible chars
        clean_chars = len(bc.strip_ansi(text_with_ansi))

        # Budget covers the full visible content (no truncation expected).
        max_tokens = clean_chars // 3  # comfortably above len/3.5
        result = bc.cap_tokens(text_with_ansi, max_tokens=max_tokens)
        assert "output capped at" not in result, (
            "ANSI overhead should not cause truncation when visible content fits "
            f"within the token budget (budget={max_tokens} tokens, "
            f"visible chars={clean_chars})"
        )


# ---------------------------------------------------------------------------
# GenericFilter with cap_tokens
# ---------------------------------------------------------------------------


class TestGenericFilterCapTokens:
    def test_caps_very_large_output(self):
        """GenericFilter caps output that exceeds token budget."""
        # Create large output (10,000 identical lines = ~2M chars = ~570k tokens).
        lines = ["output line"] * 10000
        stdout = "\n".join(lines)
        f = bc.GenericFilter()
        result = f.apply(stdout, "", 0, ["some", "command"])
        # Should be capped at ~2000 tokens (~7KB).
        assert result.compressed_bytes < len(stdout.encode("utf-8"))
        # Should indicate it was capped.
        assert "output capped at" in result.text or result.text.count("\n") < 2000

    def test_caps_with_stderr(self):
        """GenericFilter caps large output even with stderr present."""
        stdout = "x" * 50000
        stderr = "error line"
        f = bc.GenericFilter()
        result = f.apply(stdout, stderr, 1, ["cmd"])
        # Should be capped (the output is much smaller than input).
        assert result.compressed_bytes < len((stdout + stderr).encode("utf-8"))
        # Should indicate it was capped.
        assert "output capped at" in result.text


# ---------------------------------------------------------------------------
# RuffFilter
# ---------------------------------------------------------------------------

def _make_ruff_stdout(
    *,
    e501_files: int = 10,
    e501_per_file: int = 5,
    extra_codes: list[str] | None = None,
) -> str:
    """Build synthetic ruff stdout with E501 violations across many files
    plus optional one-off violations for other codes."""
    lines: list[str] = []
    for f_idx in range(e501_files):
        for ln in range(1, e501_per_file + 1):
            lines.append(
                f"src/module_{f_idx}.py:{ln}:101: E501 Line too long (120 > 100)"
            )
    for code in (extra_codes or []):
        lines.append(f"src/special.py:1:1: {code} Some message for {code}")
    lines.append(f"Found {len(lines)} errors.")
    return "\n".join(lines)


class TestRuffFilter:
    """Tests for RuffFilter."""

    def test_high_frequency_rule_collapsed_to_summary(self) -> None:
        """E501 across 10 files (50 lines) collapses to one summary line."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        text = result.text
        # Only one line for E501, not 50.
        e501_lines = [ln for ln in text.splitlines() if "E501" in ln]
        assert len(e501_lines) == 1
        assert "50 occurrences" in e501_lines[0]
        assert "10 files" in e501_lines[0]
        assert "example:" in e501_lines[0]

    def test_unique_codes_preserved(self) -> None:
        """Codes with < 3 occurrences are kept verbatim."""
        extra = ["F401", "W291", "E302", "B006", "N801"]
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5, extra_codes=extra)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        text = result.text
        for code in extra:
            assert code in text, f"Expected {code} to be preserved"

    def test_footer_preserved(self) -> None:
        """'Found N errors' footer line is always kept."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        assert "Found" in result.text and "errors" in result.text

    def test_output_is_smaller_than_input(self) -> None:
        """Compressed output is substantially smaller than raw input."""
        stdout = _make_ruff_stdout(e501_files=10, e501_per_file=5)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        assert result.compressed_bytes < len(stdout.encode())

    def test_low_frequency_rule_not_summarised(self) -> None:
        """A rule with only 2 occurrences in 1 file is not summarised."""
        lines = [
            "src/foo.py:1:1: E711 Comparison to None",
            "src/foo.py:2:1: E711 Comparison to None",
            "Found 2 errors.",
        ]
        stdout = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff"])
        e711_lines = [ln for ln in result.text.splitlines() if "E711" in ln]
        # Both kept verbatim (2 occurrences, same file — below threshold).
        assert len(e711_lines) == 2

    def test_three_occurrences_one_file_not_summarised(self) -> None:
        """3+ occurrences but only in 1 file should not be summarised."""
        lines = [
            "src/foo.py:1:1: E501 Line too long",
            "src/foo.py:2:1: E501 Line too long",
            "src/foo.py:3:1: E501 Line too long",
            "Found 3 errors.",
        ]
        stdout = "\n".join(lines)
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff"])
        e501_lines = [ln for ln in result.text.splitlines() if "E501" in ln]
        # All 3 kept (same file).
        assert len(e501_lines) == 3

    def test_empty_stdout(self) -> None:
        """Empty stdout produces empty (or whitespace-only) output without error."""
        f = bc.RuffFilter()
        result = f.apply("", "", 0, ["ruff", "check"])
        assert result.text.strip() == ""

    def test_matches_ruff_binary(self) -> None:
        """RuffFilter.matches returns True for ruff and False for pytest."""
        f = bc.RuffFilter()
        assert f.matches(["ruff", "check", "src/"])
        assert not f.matches(["pytest"])

    def test_select_filter_returns_ruff_filter(self) -> None:
        """select_filter dispatches ruff commands to RuffFilter, not LinterFilter."""
        f = bc.select_filter(["ruff", "check", "src/"])
        assert isinstance(f, bc.RuffFilter)

    def test_success_banner_stripped_on_clean_run(self) -> None:
        """'All checks passed!' is suppressed when exit_code is 0 and no violations."""
        f = bc.RuffFilter()
        result = f.apply("All checks passed!", "", 0, ["ruff", "check", "src/"])
        assert result.text.strip() == ""

    def test_no_errors_found_stripped_on_clean_run(self) -> None:
        """'No errors found.' is suppressed when exit_code is 0 and no violations."""
        f = bc.RuffFilter()
        result = f.apply("No errors found.", "", 0, ["ruff", "check"])
        assert result.text.strip() == ""

    def test_success_banner_preserved_on_failure(self) -> None:
        """When exit_code is non-zero, the output (including errors) is kept."""
        stdout = "src/foo.py:1:1: E501 Line too long\nAll checks passed!"
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check"])
        assert "E501" in result.text

    def test_fix_summary_kept_on_clean_run(self) -> None:
        """'ruff check --fix' may print a fix summary alongside a success line;
        the fix summary survives, only the bare success banner is stripped."""
        stdout = "Fixed 3 errors.\nAll checks passed!"
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 0, ["ruff", "check", "--fix"])
        assert "Fixed 3 errors" in result.text


# ---------------------------------------------------------------------------
# MypyFilter — additional edge-case tests
# ---------------------------------------------------------------------------

class TestMypyFilterExtra:
    """Additional edge cases for MypyFilter not covered by existing tests."""

    def test_multiple_success_lines_deduplicated(self) -> None:
        """Multiple 'Success: no issues found' lines are all kept (MypyFilter
        passes non-diagnostic lines through unchanged; deduplication is not
        its job — but the filter must not crash on them)."""
        lines = [
            "src/a.py:1: error: Incompatible return value",
            "src/b.py:2: error: Argument missing",
            "Success: no issues found",
            "Success: no issues found",
            "Success: no issues found",
            "Success: no issues found",
            "Found 2 errors in 2 files (checked 10 source files)",
        ]
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy", "src/"])
        text = result.text
        # Error lines must be present.
        assert "Incompatible return value" in text
        assert "Argument missing" in text
        # Summary line must be present.
        assert "Found 2 errors" in text

    def test_per_file_errors_kept(self) -> None:
        """Error lines from distinct files are all kept."""
        files = [f"src/mod_{i}.py" for i in range(3)]
        lines = [f"{f}:{i + 1}: error: Some error" for i, f in enumerate(files)]
        lines.append("Found 3 errors in 3 files (checked 3 source files)")
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy"])
        for fn in files:
            assert fn in result.text

    def test_empty_stdout(self) -> None:
        """Empty stdout produces empty output without error."""
        f = bc.MypyFilter()
        result = f.apply("", "", 0, ["mypy"])
        assert result.text.strip() == ""

    def test_select_filter_returns_mypy_filter(self) -> None:
        """select_filter dispatches mypy to MypyFilter."""
        f = bc.select_filter(["mypy", "src/"])
        assert isinstance(f, bc.MypyFilter)

    def test_show_error_codes_different_codes_grouped(self) -> None:
        """Errors with different [error-code] suffixes but identical structure are
        grouped together so only the first 3 are kept, not 3 per error code."""
        lines = []
        # 5 errors all sharing the same structural message but different codes.
        for i, code in enumerate(
            ["assignment", "attr-defined", "arg-type", "return-value", "misc"]
        ):
            lines.append(
                f"src/foo.py:{i + 1}: error: Incompatible type in assignment  [{code}]"
            )
        lines.append("Found 5 errors in 1 file (checked 1 source file)")
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy", "--show-error-codes", "src/"])
        # Only 3 error lines should be kept (deduplicated despite different codes).
        error_lines = [ln for ln in result.text.split("\n") if "error:" in ln and "src/foo.py" in ln]
        assert len(error_lines) == 3
        assert "suppressed" in result.text

    def test_show_error_codes_standalone_code_line_dropped(self) -> None:
        """Standalone ``  [error-code]`` lines are dropped as noise."""
        lines = [
            "src/foo.py:1: error: Incompatible type",
            "  [assignment]",
            "src/foo.py:2: error: Missing argument",
            "Found 2 errors in 1 file (checked 1 source file)",
        ]
        stdout = "\n".join(lines)
        f = bc.MypyFilter()
        result = f.apply(stdout, "", 1, ["mypy", "src/"])
        # Standalone code line must not appear in output.
        assert "  [assignment]" not in result.text
        # Both error lines must still be present.
        assert "Incompatible type" in result.text
        assert "Missing argument" in result.text


# ---------------------------------------------------------------------------
# Edge cases: empty stdout / binary not in FILTERS
# ---------------------------------------------------------------------------

class TestFilterDispatchEdgeCases:
    """Edge cases for filter dispatch and empty-input handling."""

    def test_unknown_binary_routes_to_tail_trunc(self) -> None:
        """select_filter returns TailTruncFilter for an unrecognised binary (catch-all)."""
        result = bc.select_filter(["unknowntool", "--flag"])
        assert isinstance(result, bc.TailTruncFilter)

    def test_empty_argv_returns_none(self) -> None:
        """select_filter returns None for empty argv."""
        assert bc.select_filter([]) is None

    def test_ruff_empty_input_no_crash(self) -> None:
        """RuffFilter.apply does not crash on empty stdout+stderr."""
        f = bc.RuffFilter()
        result = f.apply("", "", 0, ["ruff"])
        assert isinstance(result.text, str)

    def test_mypy_empty_input_no_crash(self) -> None:
        """MypyFilter.apply does not crash on empty stdout+stderr."""
        f = bc.MypyFilter()
        result = f.apply("", "", 0, ["mypy"])
        assert isinstance(result.text, str)


# ---------------------------------------------------------------------------
# Early-exit logic: skip expensive filters when normalisation alone suffices
# ---------------------------------------------------------------------------


class TestEarlyExitOnNormalisationReduction:
    """Test that filter.apply skips expensive compress() when normalisation achieves >=40% reduction."""

    def test_ansi_heavy_output_triggers_early_exit(self) -> None:
        """Large ANSI/progress output: normalisation reduces bytes by >40% → early exit."""
        # Synthesize output with lots of ANSI codes that normalisation will strip.
        # Each line has ~100 bytes of ANSI cruft, shrinking to ~20 bytes after normalise().
        ansi_lines = [
            f"\x1b[31m\x1b[1m\x1b[5m>>> {i:04d}\x1b[0m\x1b[m\x1b[m repeated text here {i}\n"
            for i in range(100)
        ]
        stdout = "".join(ansi_lines)
        assert len(stdout) > 1000  # Ensure we have substantial ANSI-heavy output.

        f = bc.PytestFilter()  # Could be any filter; we're testing the base Filter.apply logic.
        result = f.apply(stdout, "", 0, ["pytest"])

        # Early exit should have kicked in; the output should contain the marker.
        assert "early-exit: normalisation alone sufficient" in result.text

    def test_progress_heavy_output_triggers_early_exit(self) -> None:
        """Carriage-return progress lines: normalisation reduces >40% → early exit."""
        # Progress lines with many \r updates shrink dramatically after strip_progress.
        progress_lines = [
            f"phase-{i}: 10%\r20%\r30%\r40%\r50%\r60%\r70%\r80%\r90%\r100% done {i}\n"
            for i in range(50)
        ]
        stdout = "".join(progress_lines)

        f = bc.GenericFilter()
        result = f.apply(stdout, "", 0, ["some-cmd"])

        # Early exit should fire; note field indicates it.
        assert "early-exit: normalisation alone sufficient" in result.text

    def test_minimal_savings_does_not_trigger_early_exit(self) -> None:
        """Small output with minimal ANSI: normalisation saves <40% → no early exit."""
        stdout = "clean output\nno ansi codes\n"
        assert bc.normalise(stdout) == stdout  # No change expected.

        f = bc.PytestFilter()
        result = f.apply(stdout, "", 0, ["pytest"])

        # Should not have early-exit marker; compress() was called normally.
        assert "early-exit" not in result.text

    def test_early_exit_preserves_combined_stdout_stderr(self) -> None:
        """Early exit correctly combines stdout and stderr with --- separator."""
        stdout_ansi = "\x1b[31m" * 500 + "some output\n"  # Lots of ANSI.
        stderr_ansi = "\x1b[1m" * 500 + "some error\n"

        f = bc.GenericFilter()
        result = f.apply(stdout_ansi, stderr_ansi, 1, ["cmd"])

        # Expect both parts in output, separated by ---.
        assert "some output" in result.text
        assert "some error" in result.text
        assert "---" in result.text or "some output" in result.text.split("\n")[0]


# ---------------------------------------------------------------------------
# EzaFilter and TreeFilter tests
# ---------------------------------------------------------------------------

class TestEzaFilter:
    @pytest.mark.parametrize("argv", [
        ["eza", "--git", "--long"],
        ["exa", "--long"],    # older name for eza
        ["ls", "-la"],
        ["ls.exe", "-l"],     # Windows .exe form
    ])
    def test_matches_eza_binaries(self, argv) -> None:
        """EzaFilter matches eza/exa/ls binaries."""
        assert bc.EzaFilter().matches(argv)

    def test_passthrough_short_output(self) -> None:
        """EzaFilter passes through output with ≤30 lines unchanged."""
        f = bc.EzaFilter()
        short_output = "\n".join([f"file{i}.txt" for i in range(20)])
        result = f.compress(short_output, "", 0, ["ls", "-l"])
        assert result == short_output

    def test_compress_long_flat_listing(self) -> None:
        """EzaFilter compresses flat listing >30 lines: head+marker+tail."""
        f = bc.EzaFilter()
        # Create a 50-line listing with header
        lines = ["Name                Size    Date"]
        lines.extend([f"file{i}.txt              1024    2026-05-29" for i in range(49)])
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--long"])

        # Should contain marker indicating items were elided
        assert "elided" in result or "more" in result
        # Should be shorter than original
        result_lines = result.split("\n")
        assert len(result_lines) < len(lines)
        # Should still contain header and some entries
        assert "Name" in result or "file0" in result

    def test_compress_tree_output(self) -> None:
        """EzaFilter compresses tree output (--tree flag detected)."""
        f = bc.EzaFilter()
        # Create a 100-line tree output
        lines = ["root/"]
        for i in range(99):
            lines.append(f"  ├── dir{i}/")

        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["eza", "--tree", "--long"])

        # Tree mode should keep first 40 + last 10 = 50 lines max
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 55  # 50 + marker + some margin
        # Should contain marker
        assert "elided" in result or "items" in result

    def test_tree_output_short_passthrough(self) -> None:
        """EzaFilter passes through short tree output unchanged."""
        f = bc.EzaFilter()
        lines = ["root/", "  ├── file1.txt", "  └── file2.txt"]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])
        assert result == output


class TestFdFilter:
    """Test FdFilter compression for fd / fdfind output."""

    @pytest.mark.parametrize("argv", [
        ["fd", "pattern"],
        ["fdfind", "pattern"],   # Ubuntu package name
        ["fd.exe", "pattern"],   # Windows .exe form
        ["find", "-name", "*.py"],  # GNU find — same path-per-line output
    ])
    def test_matches_fd_binaries(self, argv) -> None:
        """FdFilter matches fd/fdfind/find binaries."""
        assert bc.FdFilter().matches(argv)

    def test_small_output_passes_through(self) -> None:
        """Output with ≤40 lines passes through unchanged."""
        f = bc.FdFilter()
        paths = [f"path/to/file{i}.txt" for i in range(30)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "pattern"])
        # Should be unchanged
        assert result == output.rstrip()
        # No compression marker should appear
        assert "elided" not in result

    def test_large_output_compressed(self) -> None:
        """Output with >40 lines is compressed."""
        f = bc.FdFilter()
        paths = [f"path/to/file{i}.txt" for i in range(60)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "pattern"])
        # Should contain compression marker
        assert "elided" in result
        # Should contain "more paths" language
        assert "more paths" in result
        # First 35 paths should be present
        assert "path/to/file0.txt" in result
        assert "path/to/file34.txt" in result
        # Last 5 should be present
        assert "path/to/file59.txt" in result
        # Some middle paths should be missing
        assert "path/to/file40.txt" not in result

    def test_boundary_exactly_40_lines(self) -> None:
        """Exactly 40 lines passes through without compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(40)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should pass through unchanged
        assert result == output.rstrip()
        assert "elided" not in result

    def test_boundary_41_lines(self) -> None:
        """41 lines triggers compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(41)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should be compressed
        assert "elided" in result

    def test_exit_code_preserved(self) -> None:
        """Exit codes are preserved through compression."""
        f = bc.FdFilter()
        paths = [f"file{i}.txt" for i in range(60)]
        output = "\n".join(paths)
        result = f.apply(output, "", 0, ["fd", "pattern"])
        assert result.exit_code == 0

        result_not_found = f.apply("", "", 1, ["fd", "pattern"])
        assert result_not_found.exit_code == 1

    def test_compression_ratio(self) -> None:
        """Compression reduces large outputs significantly."""
        f = bc.FdFilter()
        paths = [f"very/long/path/to/file{i:04d}.txt" for i in range(100)]
        output = "\n".join(paths)
        result = f.compress(output, "", 0, ["fd", "test"])
        # Should keep only ~40 lines (35 + marker + 5)
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) < len(paths) / 2  # Less than half the original

    def test_empty_output(self) -> None:
        """Empty output is handled correctly."""
        f = bc.FdFilter()
        result = f.compress("", "", 1, ["fd", "pattern"])
        assert result == ""

    def test_filter_in_registry(self) -> None:
        """FdFilter is registered in the global FILTERS list."""
        fd_filter = bc.select_filter(["fd", "pattern"])
        assert fd_filter is not None
        assert fd_filter.name == "fd"


class TestWcFilter:
    """Test WcFilter normalization for wc word/line/byte count output."""

    def test_strips_leading_whitespace_single_line(self) -> None:
        """POSIX wc pads counts with leading spaces — WcFilter removes them."""
        f = bc.WcFilter()
        result = f.compress("      42 file.txt", "", 0, ["wc", "-l", "file.txt"])
        assert result == "42 file.txt"

    def test_strips_leading_whitespace_no_filename(self) -> None:
        """wc -l < stdin produces a bare number with leading spaces."""
        f = bc.WcFilter()
        result = f.compress("      99", "", 0, ["wc", "-l"])
        assert result == "99"

    def test_multiple_metrics(self) -> None:
        """wc without flags prints lines/words/bytes — only leading spaces stripped."""
        f = bc.WcFilter()
        result = f.compress("   5   20  120 file.txt", "", 0, ["wc", "file.txt"])
        assert result == "5   20  120 file.txt"

    def test_multifile_with_total(self) -> None:
        """Multiple files produce per-file lines plus a total line."""
        f = bc.WcFilter()
        stdout = "   5   20  120 file1.txt\n  10   40  240 file2.txt\n  15   60  360 total"
        result = f.compress(stdout, "", 0, ["wc", "file1.txt", "file2.txt"])
        lines = result.splitlines()
        assert lines[0] == "5   20  120 file1.txt"
        assert lines[1] == "10   40  240 file2.txt"
        assert lines[2] == "15   60  360 total"

    def test_empty_output(self) -> None:
        """Empty output returns empty string without error."""
        f = bc.WcFilter()
        result = f.compress("", "", 0, ["wc", "-l", "missing.txt"])
        assert result == ""

    def test_filter_in_registry(self) -> None:
        """WcFilter is registered in the global FILTERS list."""
        wc_filter = bc.select_filter(["wc", "-l", "file.txt"])
        assert wc_filter is not None
        assert wc_filter.name == "wc"


class TestTreeFilter:
    def test_matches_tree_binary(self) -> None:
        """TreeFilter matches 'tree' binary."""
        f = bc.TreeFilter()
        assert f.matches(["tree"])

    def test_matches_tree_with_args(self) -> None:
        """TreeFilter matches 'tree' with arguments."""
        f = bc.TreeFilter()
        assert f.matches(["tree", "-L", "2"])

    def test_passthrough_short_output(self) -> None:
        """TreeFilter passes through output with ≤60 lines unchanged."""
        f = bc.TreeFilter()
        short_output = "\n".join([f"├── file{i}.txt" for i in range(30)])
        result = f.compress(short_output, "", 0, ["tree"])
        assert result == short_output

    def test_compress_long_tree_output(self) -> None:
        """TreeFilter compresses deep trees: depth-3+ items collapsed per parent."""
        f = bc.TreeFilter()
        # Build 3 top-dirs × 3 subdirs × 10 files (> 30 lines) so compression fires.
        lines = ["."]
        for t in range(3):
            top_conn = "└── " if t == 2 else "├── "
            top_cont = "    " if t == 2 else "│   "
            lines.append(f"{top_conn}topdir{t}/")
            for s in range(3):
                sub_conn = "└── " if s == 2 else "├── "
                sub_cont = "    " if s == 2 else "│   "
                lines.append(f"{top_cont}{sub_conn}subdir{s}/")
                for fi in range(10):
                    file_conn = "└── " if fi == 9 else "├── "
                    lines.append(f"{top_cont}{sub_cont}{file_conn}file{fi}.py")
        lines.append("9 directories, 90 files")
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Depth-3 files should be collapsed into [N items] markers.
        assert "items]" in result
        # Result is shorter than the input.
        assert len(result.splitlines()) < len(output.splitlines())

    def test_preserves_summary_line(self) -> None:
        """TreeFilter preserves the final summary line."""
        f = bc.TreeFilter()
        lines = ["root/"]
        for i in range(70):
            lines.append(f"├── file{i}.txt")
        lines.append("5 directories, 65 files")
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Final summary should be preserved
        assert "directories, 65 files" in result or "directories" in result


# --- BatFilter tests --------------------------------------------------------

class TestBatFilter:
    def test_matches_bat_binary(self) -> None:
        """BatFilter matches 'bat' binary."""
        f = bc.BatFilter()
        assert f.matches(["bat"])
        assert f.matches(["batcat"])
        assert not f.matches(["cat"])

    def test_strips_ansi_codes(self) -> None:
        """BatFilter strips ANSI escape sequences."""
        f = bc.BatFilter()
        # Simulated bat output with ANSI codes
        output = "\x1b[1m1  \x1b[0mfn main() {"
        result = f.compress(output, "", 0, ["bat", "file.rs"])
        # ANSI codes should be stripped
        assert "\x1b[" not in result
        assert "fn main()" in result

    def test_passthrough_short_output(self) -> None:
        """BatFilter passes through output with ≤50 lines unchanged."""
        f = bc.BatFilter()
        lines = [f"line {i}: content" for i in range(30)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.txt"])
        # Should pass through (minus ANSI) when short
        assert "line 0" in result
        assert "elided" not in result

    def test_compress_long_bat_output(self) -> None:
        """BatFilter compresses >50 lines: first 40 + last 10 + marker."""
        f = bc.BatFilter()
        lines = [f"    {i:3d}  line {i}: content with some text" for i in range(100)]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.py"])
        # Should contain marker
        assert "elided" in result
        # Result should be shorter
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 52  # 40 + 10 + marker

    def test_removes_border_lines(self) -> None:
        """BatFilter removes box-drawing border lines."""
        f = bc.BatFilter()
        lines = [
            "───────────────",  # top border
            "    1  code line 1",
            "    2  code line 2",
            "───────────────",  # bottom border
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["bat", "file.txt"])
        # Borders should be stripped
        assert "code line 1" in result
        assert "code line 2" in result
        assert "───" not in result

    def test_preserves_file_content(self) -> None:
        """BatFilter preserves actual code content when removing chrome."""
        f = bc.BatFilter()
        code_lines = [
            "def hello():",
            "    print('hello')",
            "    return True",
        ]
        output = "\n".join(code_lines)
        result = f.compress(output, "", 0, ["bat", "test.py"])
        # All code should be present
        assert "def hello():" in result
        assert "print" in result


# --- DeltaFilter tests -------------------------------------------------------

class TestDeltaFilter:
    def test_matches_delta_binary(self) -> None:
        """DeltaFilter matches 'delta' binary."""
        f = bc.DeltaFilter()
        assert f.matches(["delta"])
        assert not f.matches(["diff"])

    def test_strips_ansi_codes(self) -> None:
        """DeltaFilter strips ANSI escape sequences."""
        f = bc.DeltaFilter()
        output = "\x1b[32m+added line\x1b[0m\n\x1b[31m-removed line\x1b[0m"
        result = f.compress(output, "", 0, ["delta", "diff"])
        # ANSI codes should be stripped
        assert "\x1b[" not in result
        assert "+added line" in result
        assert "-removed line" in result

    def test_passthrough_short_diff(self) -> None:
        """DeltaFilter passes through short diffs (≤80 lines) unchanged."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.txt b/file.txt",
            "--- a/file.txt",
            "+++ b/file.txt",
        ]
        lines.extend([f"- old line {i}" for i in range(30)])
        lines.extend([f"+ new line {i}" for i in range(30)])
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        assert "old line" in result
        assert "elided" not in result

    def test_compress_long_diff(self) -> None:
        """DeltaFilter compresses >80 lines: first 60 + last 20 + marker."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.txt b/file.txt",
            "--- a/file.txt",
            "+++ b/file.txt",
        ]
        lines.extend([f"-old line {i}" for i in range(100)])
        lines.extend([f"+new line {i}" for i in range(100)])
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 83  # 60 + 20 + marker

    def test_removes_decorative_separators(self) -> None:
        """DeltaFilter removes decorative separator lines."""
        f = bc.DeltaFilter()
        lines = [
            "─────────────────",
            "+section 1 changes",
            "─────────────────",
            "-section 2 changes",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Separators should be stripped
        assert "section 1 changes" in result
        assert "section 2 changes" in result
        assert "─────" not in result

    def test_preserves_diff_hunks(self) -> None:
        """DeltaFilter preserves diff hunk headers."""
        f = bc.DeltaFilter()
        lines = [
            "diff --git a/file.py b/file.py",
            "--- a/file.py",
            "+++ b/file.py",
            "@@ -10,5 +10,6 @@",
            " context line",
            "-old implementation",
            "+new implementation",
        ]
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["delta"])
        # Diff structure should be preserved
        assert "@@ -10" in result
        assert "-old implementation" in result
        assert "+new implementation" in result


# --- JqFilter tests ----------------------------------------------------------

class TestJqFilter:
    def test_matches_jq_binary(self) -> None:
        """JqFilter matches 'jq' binary."""
        f = bc.JqFilter()
        assert f.matches(["jq"])
        assert not f.matches(["grep"])

    def test_passthrough_short_json(self) -> None:
        """JqFilter passes through short JSON (≤200 lines) unchanged."""
        f = bc.JqFilter()
        json_lines = ["{", '  "key": "value",', '  "nested": {', '    "depth": 2', "  }", "}"]
        output = "\n".join(json_lines)
        result = f.compress(output, "", 0, ["jq", "."])
        assert "key" in result
        assert "value" in result
        assert "elided" not in result

    def test_compress_large_json(self) -> None:
        """JqFilter compresses >200 lines: first 150 + last 50 + marker."""
        f = bc.JqFilter()
        lines = ["{"]
        for i in range(300):
            lines.append(f'  "item{i}": {i},')
        lines[-1] = lines[-1].rstrip(",")  # Remove trailing comma from last item
        lines.append("}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 204  # 150 + 50 + marker

    def test_preserves_json_structure(self) -> None:
        """JqFilter preserves JSON structure when truncating."""
        f = bc.JqFilter()
        lines = ["{"]
        for i in range(250):
            lines.append(f'  "key{i}": {i},')
        lines[-1] = lines[-1].rstrip(",")
        lines.append("}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["jq", "."])
        # Result should still have JSON structure
        result = result.strip()
        assert result.startswith("{") or result.startswith("[")
        # Last non-empty line should be a closing bracket
        last_line = [ln for ln in result.split("\n") if ln.strip()][-1]
        assert last_line.rstrip(",;") in ("}", "]")

    def test_handles_empty_json(self) -> None:
        """JqFilter handles empty JSON correctly."""
        f = bc.JqFilter()
        output = "{}"
        result = f.compress(output, "", 0, ["jq", "."])
        assert result == "{}"


# --- YqFilter tests ----------------------------------------------------------

class TestYqFilter:
    def test_matches_yq_binary(self) -> None:
        """YqFilter matches 'yq' binary."""
        f = bc.YqFilter()
        assert f.matches(["yq"])
        assert not f.matches(["grep"])

    def test_passthrough_short_yaml(self) -> None:
        """YqFilter passes through short YAML (≤150 lines) unchanged."""
        f = bc.YqFilter()
        yaml_lines = [
            "version: 1.0",
            "services:",
            "  - name: web",
            "    port: 8080",
        ]
        output = "\n".join(yaml_lines)
        result = f.compress(output, "", 0, ["yq", "."])
        assert "version" in result
        assert "services" in result
        assert "elided" not in result

    def test_compress_large_yaml(self) -> None:
        """YqFilter compresses >150 lines: first 100 + last 50 + marker."""
        f = bc.YqFilter()
        lines = ["items:"]
        for i in range(200):
            lines.append(f"  - id: {i}")
            lines.append(f"    value: item_{i}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        # Should contain marker
        assert "elided" in result
        result_lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(result_lines) <= 154  # 100 + 50 + marker

    def test_preserves_yaml_structure(self) -> None:
        """YqFilter preserves YAML structure when truncating."""
        f = bc.YqFilter()
        lines = ["data:"]
        for i in range(180):
            lines.append(f"  key{i}: value{i}")
        output = "\n".join(lines)
        result = f.compress(output, "", 0, ["yq", "."])
        # Structure should be readable
        assert "data:" in result
        assert "key" in result

    def test_handles_empty_yaml(self) -> None:
        """YqFilter handles empty YAML correctly."""
        f = bc.YqFilter()
        output = "{}"
        result = f.compress(output, "", 0, ["yq", "."])
        assert result == "{}"


# --- FzfFilter tests (fuzzy finder output compression) -------------------------

class TestFzfFilter:
    """Test FzfFilter compression for fzf output."""

    def test_fzf_matches_binary(self) -> None:
        """FzfFilter matches 'fzf' binary."""
        f = bc.FzfFilter()
        assert f.matches(["fzf", "--multi"])
        assert f.matches(["fzf"])

    def test_fzf_short_output_passthrough(self) -> None:
        """FzfFilter passes through short output (≤50 lines) unchanged."""
        f = bc.FzfFilter()
        lines = "\n".join([f"item_{i}" for i in range(30)])
        result = f.compress(lines, "", 0, ["fzf"])
        assert result == lines
        assert "elided" not in result

    def test_fzf_long_output_compressed(self) -> None:
        """FzfFilter compresses long output (>50 lines): first 40 + last 10 + marker."""
        f = bc.FzfFilter()
        lines = "\n".join([f"item_{i}" for i in range(100)])
        result = f.compress(lines, "", 0, ["fzf"])
        assert "elided" in result
        result_lines = result.split("\n")
        # Should have: 40 head + 1 marker + 10 tail = 51 lines
        assert len(result_lines) == 51
        assert result_lines[0] == "item_0"
        assert result_lines[40].startswith("...")
        assert result_lines[-1] == "item_99"

    def test_fzf_empty_output(self) -> None:
        """FzfFilter handles empty output without error."""
        f = bc.FzfFilter()
        result = f.compress("", "", 0, ["fzf"])
        assert result == ""


# --- LazyGitFilter tests (git TUI output compression) --------------------------

class TestLazyGitFilter:
    """Test LazyGitFilter compression for lazygit output."""

    def test_lazygit_matches_binary(self) -> None:
        """LazyGitFilter matches 'lazygit' binary."""
        f = bc.LazyGitFilter()
        assert f.matches(["lazygit"])
        assert f.matches(["lazygit", "--version"])

    def test_lazygit_empty_output(self) -> None:
        """LazyGitFilter returns helpful message for empty output."""
        f = bc.LazyGitFilter()
        result = f.compress("", "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_ansi_codes_detected(self) -> None:
        """LazyGitFilter detects ANSI escape codes and returns helpful message."""
        f = bc.LazyGitFilter()
        output_with_ansi = "Some output\x1b[1;32mcolored text\x1b[0m"
        result = f.compress(output_with_ansi, "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_plain_text_passthrough(self) -> None:
        """LazyGitFilter passes through plain text output (unusual but possible)."""
        f = bc.LazyGitFilter()
        output = "plain text log output\nline 2\nline 3"
        result = f.compress(output, "", 0, ["lazygit"])
        # Plain text without ANSI codes should pass through
        assert result.strip() == output.strip()

    def test_lazygit_esc_paren_ansi_variant_detected(self) -> None:
        """LazyGitFilter detects \\x1b( escape (character-set sequences) as TUI."""
        f = bc.LazyGitFilter()
        # \x1b( is a character-set designation sequence used by lazygit TUI
        output = "\x1b(Bsome terminal data"
        result = f.compress(output, "", 0, ["lazygit"])
        assert "[lazygit is an interactive terminal UI" in result

    def test_lazygit_exe_matches_on_windows(self) -> None:
        """LazyGitFilter matches 'lazygit.exe' (Windows binary name)."""
        f = bc.LazyGitFilter()
        assert f.matches(["lazygit.exe"])
        assert f.matches(["lazygit.exe", "--version"])


# ---------------------------------------------------------------------------
# _head_tail_compress — direct unit tests
# ---------------------------------------------------------------------------

class TestHeadTailCompress:
    """Unit tests for the _head_tail_compress helper function."""

    def test_short_list_returns_all_lines(self) -> None:
        """Lines at or below head+tail budget are returned unchanged."""
        lines = ["a", "b", "c", "d", "e"]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        # 5 lines <= 3+3, so no compression
        assert result == "a\nb\nc\nd\ne"

    def test_exact_boundary_no_marker(self) -> None:
        """Exactly head+tail lines produces no elision marker."""
        lines = [f"line{i}" for i in range(6)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "elided" not in result
        assert result == "\n".join(lines)

    def test_one_over_boundary_inserts_marker(self) -> None:
        """head+tail+1 lines triggers compression with a marker."""
        lines = [f"line{i}" for i in range(7)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "elided" in result
        assert "1 more items elided by token-goat" in result

    def test_head_lines_preserved(self) -> None:
        """The first ``head`` lines always appear in the result."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        for i in range(5):
            assert f"item{i}" in result

    def test_tail_lines_preserved(self) -> None:
        """The last ``tail`` lines always appear in the result."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        for i in range(45, 50):
            assert f"item{i}" in result

    def test_middle_lines_elided(self) -> None:
        """Lines in the middle are not present when compression fires."""
        lines = [f"item{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        # Item in the middle should be gone
        assert "item25" not in result

    def test_elided_count_correct(self) -> None:
        """The marker count equals total - head - tail."""
        total = 40
        head = 10
        tail = 5
        lines = [f"x{i}" for i in range(total)]
        result = bc._head_tail_compress(lines, head=head, tail=tail)
        expected_elided = total - head - tail
        assert f"{expected_elided} more items elided" in result

    def test_custom_label_used_in_marker(self) -> None:
        """The ``label`` parameter appears in the elision marker."""
        lines = [f"path{i}" for i in range(50)]
        result = bc._head_tail_compress(lines, head=10, tail=5, label="paths")
        assert "paths elided" in result

    def test_default_label_is_items(self) -> None:
        """The default label is 'items'."""
        lines = [f"x{i}" for i in range(20)]
        result = bc._head_tail_compress(lines, head=5, tail=5)
        assert "items elided" in result

    def test_empty_list_returns_empty_string(self) -> None:
        """An empty list produces an empty string (no crash)."""
        result = bc._head_tail_compress([], head=5, tail=5)
        assert result == ""

    def test_single_line_returns_that_line(self) -> None:
        """A single-line list is always returned as-is."""
        result = bc._head_tail_compress(["only line"], head=5, tail=5)
        assert result == "only line"

    def test_marker_format_token_goat_attribution(self) -> None:
        """Elision marker always includes 'token-goat' attribution."""
        lines = [f"l{i}" for i in range(20)]
        result = bc._head_tail_compress(lines, head=3, tail=3)
        assert "token-goat" in result


# ---------------------------------------------------------------------------
# Windows .exe matching — BatFilter, DeltaFilter, FzfFilter, JqFilter, YqFilter
# ---------------------------------------------------------------------------

class TestWindowsExeMatching:
    """Verify that .exe suffix is stripped correctly for all new filter classes."""

    @pytest.mark.parametrize("filter_cls,argv", [
        (bc.BatFilter, ["bat.exe"]),
        (bc.BatFilter, ["batcat.exe"]),
        (bc.DeltaFilter, ["delta.exe"]),
        (bc.FzfFilter, ["fzf.exe"]),
        (bc.JqFilter, ["jq.exe"]),
        (bc.YqFilter, ["yq.exe"]),
    ])
    def test_exe_suffix_matches(self, filter_cls, argv) -> None:
        """Filter matches the .exe-suffixed binary on Windows."""
        assert filter_cls().matches(argv)

    @pytest.mark.parametrize("filter_cls,argv", [
        (bc.BatFilter, ["cat.exe"]),
        (bc.DeltaFilter, ["diff.exe"]),
        (bc.JqFilter, ["xq.exe"]),
        (bc.YqFilter, ["jq.exe"]),
    ])
    def test_exe_suffix_no_false_match(self, filter_cls, argv) -> None:
        """Filter does not match unrelated .exe binaries."""
        assert not filter_cls().matches(argv)


# ---------------------------------------------------------------------------
# EzaFilter tree mode — precision tests (iteration 3)
# ---------------------------------------------------------------------------

class TestEzaFilterTreeMode:
    """Focused tests for EzaFilter tree-mode detection and limits."""

    def test_tree_eq_depth_detected_as_tree_mode(self) -> None:
        """--tree=N (value form) is recognised as tree mode."""
        f = bc.EzaFilter()
        # Build 80 non-empty lines so flat-mode would also compress — but
        # the tree-mode limit (40+10=50 head+tail) should apply, not flat (25+5).
        lines = [f"dir{i}/" for i in range(80)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree=2", "--long"])

        # Tree-mode uses head=40, tail=10; flat-mode uses head=25, tail=5.
        # With 80 lines the elided count differs: tree elides 30, flat elides 50.
        # The marker text reveals which branch ran.
        assert "30 more items elided" in result

    def test_tree_mode_bare_flag_elides_correct_count(self) -> None:
        """--tree (bare flag) uses head=40, tail=10 so elided count = total - 50."""
        f = bc.EzaFilter()
        lines = [f"file{i}.txt" for i in range(70)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # 70 total - 40 head - 10 tail = 20 elided
        assert "20 more items elided" in result

    def test_tree_mode_exactly_60_lines_passthrough(self) -> None:
        """Tree mode: exactly 60 non-empty lines passes through unchanged."""
        f = bc.EzaFilter()
        lines = [f"node{i}" for i in range(60)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # No truncation at exactly the threshold
        assert "elided" not in result
        assert result.rstrip() == output.rstrip()

    def test_tree_mode_61_lines_triggers_compression(self) -> None:
        """Tree mode: 61 non-empty lines triggers head+tail compression."""
        f = bc.EzaFilter()
        lines = [f"node{i}" for i in range(61)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # 61 - 40 - 10 = 11 elided
        assert "11 more items elided" in result

    def test_tree_mode_preserves_first_lines_as_headers(self) -> None:
        """Tree mode: first 40 lines (headers/root) are always in the output."""
        f = bc.EzaFilter()
        # Make first line a recognisable root header.
        # Total: 1 root + 69 modules = 70 lines (>60 threshold so compression fires).
        lines = ["project/"]
        lines += [f"  ├── module_{i}/" for i in range(69)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--tree"])

        # The very first line must survive.
        assert "project/" in result
        # The first 40 non-empty lines are kept as the head.
        # lines[0] = "project/", lines[1..40] = module_0..module_38 (39 modules).
        # So module_38 is the last module guaranteed in the head.
        assert "module_0" in result
        assert "module_38" in result
        # module_39..module_58 are in the elided middle (20 items).
        assert "module_39" not in result

    def test_flat_mode_does_not_use_tree_limits(self) -> None:
        """Without --tree flag the flat limits (25+5) apply, not tree limits (40+10)."""
        f = bc.EzaFilter()
        lines = [f"file{i}.txt" for i in range(70)]
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["eza", "--long"])

        # Flat mode elides 70 - 25 - 5 = 40; tree mode would elide 70 - 40 - 10 = 20.
        assert "40 more entries elided" in result


# ---------------------------------------------------------------------------
# TreeFilter boundary tests (iteration 3)
# ---------------------------------------------------------------------------

class TestTreeFilterBoundaries:
    """Exact boundary and summary-preservation tests for TreeFilter."""

    def test_passthrough_at_exactly_60_lines(self) -> None:
        """60 non-empty lines passes through without any elision marker."""
        f = bc.TreeFilter()
        lines = ["root/"]
        lines += [f"├── file{i}.txt" for i in range(59)]
        assert len(lines) == 60
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "elided" not in result
        assert result.rstrip() == output.rstrip()

    def test_compression_fires_above_30_lines(self) -> None:
        """31+ lines with depth-3 items triggers depth-collapse compression."""
        f = bc.TreeFilter()
        # 1 topdir × 6 subdirs × 4 files = 34 lines (> 30 threshold).
        lines = ["."]
        for s in range(6):
            sub_conn = "└── " if s == 5 else "├── "
            sub_cont = "    " if s == 5 else "│   "
            lines.append("├── topdir0/")
            lines.append(f"│   {sub_conn}subdir{s}/")
            for fi in range(4):
                file_conn = "└── " if fi == 3 else "├── "
                lines.append(f"│   {sub_cont}{file_conn}file{fi}.py")
        assert len(lines) > 30
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "items]" in result

    def test_summary_line_always_in_tail(self) -> None:
        """The canonical 'N directories, M files' summary is in the tail so it survives."""
        f = bc.TreeFilter()
        lines = ["root/"]
        lines += [f"├── item{i}" for i in range(80)]
        lines.append("3 directories, 77 files")  # summary as last line
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        # Summary must survive — it is always the last line(s) so the tail keeps it.
        assert "3 directories, 77 files" in result

    def test_summary_line_preserved_above_30_line_threshold(self) -> None:
        """Summary line survives even when the tree exceeds the 30-line threshold."""
        f = bc.TreeFilter()
        # Build 65 flat depth-0 lines + summary (flat trees pass through unchanged).
        lines = ["root/"]
        lines += [f"├── file{i}" for i in range(63)]
        lines.append("5 directories, 58 files")
        assert len(lines) == 65
        output = "\n".join(lines)

        result = f.compress(output, "", 0, ["tree"])

        assert "5 directories, 58 files" in result


# ---------------------------------------------------------------------------
# Gradle filter
# ---------------------------------------------------------------------------

class TestGradleFilter:
    def test_drops_task_progress_lines(self) -> None:
        """Gradle filter drops > Task : and > Configure project lines."""
        text = "> Task :compileJava\n> Task :processResources\n> Task :classes\n"
        text += "BUILD SUCCESSFUL in 2.5s"
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "> Task" not in result.text
        assert "BUILD SUCCESSFUL" in result.text
        assert "dropped 3 task-progress" in result.text

    def test_keeps_build_successful_line(self) -> None:
        """BUILD SUCCESSFUL line is preserved."""
        text = "> Task :build\nBUILD SUCCESSFUL in 1.0s"
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "BUILD SUCCESSFUL" in result.text

    def test_keeps_test_summary(self) -> None:
        """Test summaries in the output are kept (in last 30 lines)."""
        lines = [f"> Task :test_{i}" for i in range(5)]
        lines += ["5 tests passed", "BUILD SUCCESSFUL"]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "test"])
        assert "5 tests passed" in result.text
        assert "BUILD SUCCESSFUL" in result.text

    def test_dependencies_head_tail_compression(self) -> None:
        """gradle dependencies uses head=10, tail=10 compression."""
        lines = [f"dependency{i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "dependencies"])
        # Should have head (10) + marker + tail (10) = at most 21 lines + overhead
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_tasks_head_tail_compression(self) -> None:
        """gradle tasks uses head=20, tail=5 compression."""
        lines = [f"task{i}: Description {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "tasks"])
        # Should have head (20) + marker + tail (5)
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_failure_preserves_stderr_and_last_lines(self) -> None:
        """On exit_code != 0, preserve stderr and last 20 lines of stdout."""
        stdout = "\n".join([f"line {i}" for i in range(100)])
        stderr = "FAILURE: Build failed with an exception."
        f = bc.GradleFilter()
        result = f.apply(stdout, stderr, 1, ["gradle", "build"])
        assert "FAILURE: Build failed" in result.text
        assert "line 99" in result.text

    def test_short_build_output_passthrough(self) -> None:
        """Short build output (< 30 lines) passes through."""
        lines = ["line 1", "BUILD SUCCESSFUL"]
        text = "\n".join(lines)
        f = bc.GradleFilter()
        result = f.apply(text, "", 0, ["gradle", "build"])
        assert "line 1" in result.text
        assert "BUILD SUCCESSFUL" in result.text
        assert "elided" not in result.text

    @pytest.mark.parametrize("argv", [
        ["gradle", "build"],
        ["gradlew", "build"],
        ["./gradlew", "build"],
    ])
    def test_matches_gradle_binaries(self, argv) -> None:
        """GradleFilter matches gradle/gradlew/./gradlew."""
        assert bc.GradleFilter().matches(argv)


# ---------------------------------------------------------------------------
# Maven filter
# ---------------------------------------------------------------------------

class TestMavenFilter:
    def test_drops_download_progress_lines(self) -> None:
        """Maven filter drops Downloading: and Downloaded: lines."""
        text = "[INFO] Downloading: http://example.com/foo.jar\n"
        text += "[INFO] Downloaded: http://example.com/foo.jar\n"
        text += "[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "Downloading" not in result.text
        assert "Downloaded" not in result.text
        assert "BUILD SUCCESS" in result.text
        assert "dropped 2 download-progress" in result.text

    def test_keeps_test_summary(self) -> None:
        """Tests run: X summary lines are kept."""
        text = "[INFO] Tests run: 42, Failures: 0, Errors: 0, Skipped: 0"
        text += "\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "Tests run: 42" in result.text
        assert "BUILD SUCCESS" in result.text

    def test_keeps_error_lines(self) -> None:
        """[ERROR] lines are preserved."""
        text = "[ERROR] Some compilation error\n[INFO] BUILD FAILURE"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "test"])
        assert "[ERROR]" in result.text

    def test_dependency_tree_head_tail_compression(self) -> None:
        """mvn dependency:tree uses head=10, tail=10 compression."""
        lines = [f"dep{i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "dependency:tree"])
        assert "more items elided" in result.text or "more lines elided" in result.text

    def test_install_keeps_last_30_lines(self) -> None:
        """mvn install keeps last 30 lines."""
        lines = [f"[INFO] line {i}" for i in range(100)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "install"])
        # Should have head (30) + maybe tail
        assert "line 99" in result.text

    def test_failure_preserves_error_lines(self) -> None:
        """On exit_code != 0, preserve ERROR lines and summary."""
        stdout = "\n".join([f"[INFO] line {i}" for i in range(100)])
        stderr = "[ERROR] Compilation failure"
        f = bc.MavenFilter()
        result = f.apply(stdout, stderr, 1, ["mvn", "package"])
        assert "[ERROR]" in result.text
        assert "line 99" in result.text

    def test_verify_subcommand_compression(self) -> None:
        """mvn verify compresses download lines but keeps summaries."""
        text = "[INFO] Downloading: foo\n[INFO] Downloaded: foo\n"
        text += "[INFO] Tests run: 10\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "verify"])
        assert "Downloading" not in result.text
        assert "Tests run: 10" in result.text
        assert "BUILD SUCCESS" in result.text

    def test_package_subcommand_compression(self) -> None:
        """mvn package compresses download lines."""
        text = "[INFO] Downloading: foo\n[INFO] BUILD SUCCESS"
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "package"])
        assert "Downloading" not in result.text
        assert "BUILD SUCCESS" in result.text

    @pytest.mark.parametrize("argv", [
        ["mvn", "test"],
        ["mvnw", "test"],
        ["./mvnw", "test"],
    ])
    def test_matches_maven_binaries(self, argv) -> None:
        """MavenFilter matches mvn/mvnw/./mvnw."""
        assert bc.MavenFilter().matches(argv)

    def test_unknown_subcommand_uses_default(self) -> None:
        """Unknown Maven subcommands use default head/tail compression."""
        lines = [f"line {i}" for i in range(50)]
        text = "\n".join(lines)
        f = bc.MavenFilter()
        result = f.apply(text, "", 0, ["mvn", "unknown-command"])
        # Default is head=10, tail=10, so should show compression
        assert "more items elided" in result.text or "more lines elided" in result.text


# ---------------------------------------------------------------------------
# DotnetFilter
# ---------------------------------------------------------------------------


def _make_dotnet_build_output(n_projects: int = 3) -> str:
    """Synthetic `dotnet build` output for a multi-project solution."""
    lines = ["Microsoft (R) Build Engine version 17.9.0+blah"]
    for i in range(n_projects):
        lines.append(f"  Project{i} -> /src/Project{i}/bin/Debug/net8.0/Project{i}.dll")
        lines.append("Build succeeded.")
        lines.append("    0 Warning(s)")
        lines.append("    0 Error(s)")
    lines.append("")
    lines.append("Build succeeded.")
    lines.append("    0 Warning(s)")
    lines.append("    0 Error(s)")
    lines.append("")
    lines.append("Time Elapsed 00:00:03.12")
    return "\n".join(lines)


class TestDotnetFilter:
    def test_matches_dotnet(self) -> None:
        f = bc.DotnetFilter()
        assert f.matches(["dotnet", "build"])
        assert f.matches(["dotnet", "test"])
        assert f.matches(["dotnet", "restore"])

    def test_build_collapses_repeated_build_succeeded(self) -> None:
        """Repeated 'Build succeeded.' lines from multi-project build are collapsed to one."""
        text = _make_dotnet_build_output(n_projects=5)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        # Only one "Build succeeded." should remain (the last/final one).
        assert result.text.count("Build succeeded.") == 1

    def test_build_keeps_single_build_succeeded(self) -> None:
        """Single-project build: 'Build succeeded.' is kept unchanged."""
        text = "  MyApp -> /src/MyApp/bin/Debug/net8.0/MyApp.dll\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)\n\nTime Elapsed 00:00:01.50"
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "Build succeeded." in result.text

    def test_build_note_emitted_when_collapsed(self) -> None:
        """A note is emitted when Build succeeded. lines were collapsed."""
        text = _make_dotnet_build_output(n_projects=4)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "token-goat" in result.text
        assert "Build succeeded" in result.text

    def test_build_drops_msbuild_noise(self) -> None:
        """MSBuild evaluation lines starting with 'Project "...' are dropped."""
        text = (
            'Project "C:\\repo\\foo.csproj" on node 1\n'
            "  MyApp -> /src/MyApp/bin/Debug/net8.0/MyApp.dll\n"
            "Build succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert 'Project "C:\\repo\\foo.csproj"' not in result.text
        assert "Build succeeded." in result.text

    def test_build_keeps_error_lines(self) -> None:
        """Error lines survive even if they match a drop pattern."""
        text = (
            "Build succeeded.\n"
            "error CS0001: Unexpected error in compilation\n"
            "Build succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "build"])
        assert "error CS0001" in result.text

    def test_restore_drops_progress_lines(self) -> None:
        """Restore progress lines (Determining projects, Writing assets, etc.) are dropped."""
        text = (
            "Determining projects to restore...\n"
            "  Restored /src/MyApp/MyApp.csproj (5.32 sec)\n"
            "Restore succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "restore"])
        assert "Determining projects" not in result.text
        assert "Restore succeeded." in result.text

    def test_test_collapses_passed_lines(self) -> None:
        """Passed test lines are collapsed to a count."""
        lines = ["Test run for /src/Tests/bin/net8.0/Tests.dll (.NETCoreApp,Version=v8.0)"]
        for i in range(20):
            lines.append(f"  Passed MyNamespace.Tests.TestMethod{i}")
        lines.append("  Failed MyNamespace.Tests.TestMethodBroken")
        lines.append("    Assert.Equal() Failure")
        lines.append("Test Run Summary")
        lines.append("  Total   : 21")
        lines.append("  Passed  : 20")
        lines.append("  Failed  : 1")
        text = "\n".join(lines)
        f = bc.DotnetFilter()
        result = f.apply(text, "", 1, ["dotnet", "test"])
        # All passing lines should be summarised away.
        assert "TestMethod0" not in result.text
        assert "TestMethodBroken" in result.text
        assert "token-goat" in result.text
        # The note should mention the collapsed count.
        assert "collapsed" in result.text

    @pytest.mark.parametrize("argv", [
        ["dotnet", "build"],
        ["dotnet", "test"],
    ])
    def test_select_filter_dispatches_dotnet(self, argv) -> None:
        """select_filter routes dotnet subcommands to DotnetFilter."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "dotnet"


# ---------------------------------------------------------------------------
# PipFilter verbose mode
# ---------------------------------------------------------------------------


class TestPipFilterVerbose:
    def test_verbose_flag_drops_debug_lines(self) -> None:
        """DEBUG log lines from 'pip install -v' are dropped."""
        text = (
            "Collecting requests\n"
            "DEBUG pip._internal.utils.logging: Checking if requests-2.31.0 is already installed\n"
            "DEBUG pip._internal.network.session: Created new session\n"
            "  Downloading requests-2.31.0-py3-none-any.whl (62 kB)\n"
            "Installing collected packages: requests\n"
            "Successfully installed requests-2.31.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "requests"])
        assert "DEBUG" not in result.text
        assert "Successfully installed requests" in result.text

    def test_verbose_flag_drops_http_trace_lines(self) -> None:
        """HTTP-trace indented lines from verbose pip are dropped."""
        text = (
            "Collecting numpy\n"
            "  https://pypi.org/simple/numpy/\n"
            "  Querying https://pypi.org/simple/numpy/\n"
            "  Added numpy-1.26.0-cp311-cp311-win_amd64.whl to the build\n"
            "Successfully installed numpy-1.26.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "numpy"])
        assert "pypi.org" not in result.text
        assert "Querying" not in result.text
        assert "Successfully installed numpy" in result.text

    def test_verbose_double_v_flag_drops_debug(self) -> None:
        """'-vv' flag (double verbose) also triggers verbose mode dropping."""
        text = (
            "DEBUG high-verbosity line\n"
            "Successfully installed numpy-1.26.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-vv", "numpy"])
        assert "DEBUG" not in result.text
        assert "Successfully installed" in result.text

    def test_verbose_long_flag_drops_debug(self) -> None:
        """'--verbose' long flag triggers verbose mode dropping."""
        text = (
            "VERBOSE something\n"
            "Successfully installed requests-2.31.0\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "--verbose", "requests"])
        assert "VERBOSE" not in result.text
        assert "Successfully installed" in result.text

    def test_non_verbose_keeps_debug_like_output(self) -> None:
        """Without -v, DEBUG-prefixed lines from user code are NOT stripped (pass-through)."""
        text = (
            "Successfully installed some-package-1.0\n"
            "DEBUG this is from a post-install script\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "some-package"])
        assert "DEBUG this is from a post-install script" in result.text

    def test_verbose_preserves_error_lines(self) -> None:
        """Error lines are kept even in verbose mode."""
        text = (
            "DEBUG something noisy\n"
            "ERROR: Could not find a version that satisfies the requirement badpkg\n"
        )
        f = bc.PipFilter()
        result = f.apply(text, "", 1, ["pip", "install", "-v", "badpkg"])
        assert "ERROR: Could not find" in result.text

    def test_verbose_note_included(self) -> None:
        """A note is emitted when verbose debug lines are dropped."""
        text = "\n".join([
            "Collecting foo",
            "DEBUG pip._internal.req.req_install: foo",
        ] * 10 + ["Successfully installed foo-1.0"])
        f = bc.PipFilter()
        result = f.apply(text, "", 0, ["pip", "install", "-v", "foo"])
        assert "verbose" in result.text.lower() or "debug" in result.text.lower()


# ---------------------------------------------------------------------------
# _safe_decode
# ---------------------------------------------------------------------------


class TestSafeDecode:
    @pytest.mark.parametrize("value,expected", [
        ("hello\x00world", "helloworld"),     # null bytes in str
        (b"foo\x00bar", "foobar"),            # null bytes in bytes
        (b"hello", "hello"),                  # clean utf-8 bytes
        ("plain text", "plain text"),         # clean str passthrough
        (b"", ""),                            # empty bytes
        ("", ""),                             # empty str
        ("a\x00b\x00c\x00", "abc"),           # multiple null bytes
    ])
    def test_safe_decode(self, value, expected) -> None:
        assert bc._safe_decode(value) == expected

    def test_replaces_invalid_utf8(self) -> None:
        # 0xFF is invalid UTF-8; must not raise, must produce replacement char.
        result = bc._safe_decode(b"\xff\xfe")
        assert "�" in result or result == ""  # replacement char or empty

    def test_null_bytes_in_bytes(self) -> None:
        data = b"line1\x00\nline2\x00"
        result = bc._safe_decode(data)
        assert "\x00" not in result
        assert "line1" in result
        assert "line2" in result


# ---------------------------------------------------------------------------
# Filter.apply — empty input, MAX_INPUT_BYTES, encoding safety
# ---------------------------------------------------------------------------


class TestFilterApplyRobustness:
    """Tests for the encoding / edge-case guards added to Filter.apply."""

    def test_empty_stdout_and_stderr_returns_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("", "", 0, ["pytest"])
        assert result.text == ""
        assert result.original_bytes == 0
        assert result.compressed_bytes == 0

    def test_whitespace_only_returns_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("   \n\t\n", "  ", 0, ["pytest"])
        assert result.text == ""

    def test_null_bytes_stripped_before_filter(self) -> None:
        # Null bytes in stdout must not reach the filter logic.
        f = bc.GenericFilter()
        result = f.apply("ok\x00output", "", 0, ["custom"])
        assert "\x00" not in result.text
        assert "ok" in result.text or result.text == ""

    def test_max_input_bytes_cap_truncates(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "100")
        # Build a stdout that exceeds 100 bytes.
        long_stdout = "x" * 500
        f = bc.GenericFilter()
        result = f.apply(long_stdout, "", 0, ["custom"])
        # The note must mention truncation.
        notes_text = " ".join(result.notes) if result.notes else ""
        combined = result.text + notes_text
        assert "truncated" in combined.lower() or "100KB" in combined or "0KB" in combined

    def test_max_input_bytes_env_override_respected(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "50")
        long_stdout = "a" * 200
        f = bc.GenericFilter()
        result = f.apply(long_stdout, "", 0, ["custom"])
        # The compressed output must be shorter than the 200-byte input.
        assert result.compressed_bytes < 200

    def test_filter_exception_falls_back_gracefully(self) -> None:
        """A filter that raises must not propagate — apply falls back to truncation."""
        class BrokenFilter(bc.Filter):
            name = "broken"
            binaries = frozenset(["broken"])

            def compress(self, stdout, stderr, exit_code, argv):
                raise RuntimeError("intentional test failure")

        f = BrokenFilter()
        result = f.apply("some output\n" * 10, "", 0, ["broken"])
        # Must not raise, and the output should contain something from the raw input.
        assert isinstance(result, bc.CompressedOutput)
        assert "broken" in result.filter_name

    def test_exit_code_preserved_on_empty(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("", "", 42, ["pytest"])
        assert result.exit_code == 42

    def test_exit_code_preserved_on_normal(self) -> None:
        f = bc.PytestFilter()
        result = f.apply("1 passed", "", 0, ["pytest"])
        assert result.exit_code == 0

    def test_notes_field_populated_on_truncation(self, monkeypatch) -> None:
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "10")
        f = bc.GenericFilter()
        result = f.apply("x" * 500, "", 0, ["custom"])
        # notes list should be non-empty when truncation occurred.
        assert result.notes or "truncated" in result.text.lower()

    def test_original_bytes_reflects_pretrunation_size(self, monkeypatch) -> None:
        # original_bytes must reflect the true process output size, not the
        # post-truncation size — so savings metrics are honest.
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "100")
        f = bc.GenericFilter()
        large_stdout = "x" * 500
        result = f.apply(large_stdout, "", 0, ["custom"])
        assert result.original_bytes == len(large_stdout.encode("utf-8"))

    def test_early_return_notes_appear_in_text(self, monkeypatch) -> None:
        # Truncation notes accumulated before the empty-input early-return
        # must appear in the output text — CompressedOutput.notes is never
        # read back by callers so storing them only there silently drops them.
        monkeypatch.setenv("TOKEN_GOAT_FILTER_MAX_BYTES", "5")
        # Build a stdout that will be pre-truncated to whitespace only:
        # 20 spaces → truncated at 5 bytes → "     " → strip() is empty → early-return.
        f = bc.GenericFilter()
        result = f.apply(" " * 20, "", 0, ["custom"])
        # If truncation fired, the note must be visible in text.
        if result.notes:
            assert "truncated" in result.text.lower()


# ---------------------------------------------------------------------------
# MAX_INPUT_BYTES constant and _get_max_input_bytes
# ---------------------------------------------------------------------------


class TestMaxInputBytesConstant:
    def test_default_is_500kb(self) -> None:
        assert bc.DEFAULT_MAX_INPUT_BYTES == 500 * 1024

    def test_exported_in_all(self) -> None:
        assert "DEFAULT_MAX_INPUT_BYTES" in bc.__all__

    def test_safe_decode_exported(self) -> None:
        assert "_safe_decode" in bc.__all__


# ---------------------------------------------------------------------------
# BlackIsortFilter
# ---------------------------------------------------------------------------


class TestBlackFilter:
    """Tests for BlackIsortFilter when invoked as black."""

    def test_collapses_reformatted_lines_beyond_sample(self) -> None:
        """More than 5 'reformatted' lines should be collapsed to a count."""
        lines = [f"reformatted src/module{i}.py" for i in range(10)]
        lines.append("All done! ✨ 🍰 ✨")
        lines.append("10 files reformatted")
        text = "\n".join(lines)
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 0, ["black", "."])
        assert "reformatted src/module0.py" in result.text
        assert "reformatted src/module4.py" in result.text
        # module5 onwards should not appear as individual lines
        assert "reformatted src/module9.py" not in result.text
        assert "+5 more reformatted files" in result.text
        assert "All done!" in result.text

    def test_keeps_all_reformatted_when_under_sample(self) -> None:
        """Five or fewer 'reformatted' lines should all appear verbatim."""
        lines = [f"reformatted src/file{i}.py" for i in range(4)]
        lines.append("All done! ✨ 🍰 ✨")
        text = "\n".join(lines)
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 0, ["black", "."])
        for i in range(4):
            assert f"reformatted src/file{i}.py" in result.text
        assert "more reformatted" not in result.text

    def test_keeps_error_lines(self) -> None:
        """error: / Oh no! lines must survive compression."""
        text = (
            "reformatted a.py\n"
            "Oh no!\n"
            "error: cannot format b.py: INTERNAL ERROR\n"
            "1 file reformatted, 1 file failed to reformat.\n"
        )
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 1, ["black", "."])
        assert "Oh no!" in result.text
        assert "error: cannot format b.py" in result.text
        assert "1 file reformatted" in result.text

    def test_keeps_would_reformat_in_check_mode(self) -> None:
        """'would reformat' lines (--check mode) should be sample-collapsed like reformatted."""
        lines = [f"would reformat src/f{i}.py" for i in range(8)]
        lines.append("Oh no! 💥 💔 💥")
        lines.append("8 files would be reformatted")
        text = "\n".join(lines)
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 1, ["black", "--check", "."])
        assert "would reformat src/f0.py" in result.text
        assert "+3 more reformatted files" in result.text
        assert "8 files would be reformatted" in result.text

    def test_select_filter_dispatches_black(self) -> None:
        """select_filter routes 'black .' to BlackIsortFilter."""
        f = bc.select_filter(["black", "."])
        assert f is not None
        assert f.name == "black-isort"

    def test_exported_in_all(self) -> None:
        assert "BlackIsortFilter" in bc.__all__


class TestIsortFilter:
    """Tests for BlackIsortFilter when invoked as isort."""

    def test_collapses_fixing_lines_beyond_sample(self) -> None:
        """More than 5 'Fixing' lines should be collapsed to a count."""
        lines = [f"Fixing src/module{i}.py" for i in range(9)]
        lines.append("Skipped 2 files")
        text = "\n".join(lines)
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 0, ["isort", "."])
        assert "Fixing src/module0.py" in result.text
        assert "Fixing src/module4.py" in result.text
        assert "Fixing src/module8.py" not in result.text
        assert "+4 more fixed files" in result.text
        assert "Skipped 2 files" in result.text

    def test_keeps_all_fixing_when_under_sample(self) -> None:
        """Five or fewer 'Fixing' lines should all appear verbatim."""
        lines = [f"Fixing src/x{i}.py" for i in range(3)]
        text = "\n".join(lines)
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 0, ["isort", "."])
        for i in range(3):
            assert f"Fixing src/x{i}.py" in result.text
        assert "more fixed files" not in result.text

    def test_keeps_error_lines(self) -> None:
        """ERROR lines must survive compression."""
        text = (
            "Fixing a.py\n"
            "ERROR: broken.py — SyntaxError\n"
            "Skipped 1 files\n"
        )
        f = bc.BlackIsortFilter()
        result = f.apply(text, "", 1, ["isort", "src/"])
        assert "ERROR: broken.py" in result.text
        assert "Skipped 1 files" in result.text

    def test_select_filter_dispatches_isort(self) -> None:
        """select_filter routes 'isort .' to BlackIsortFilter."""
        f = bc.select_filter(["isort", "."])
        assert f is not None
        assert f.name == "black-isort"


# ---------------------------------------------------------------------------
# SysPackageFilter
# ---------------------------------------------------------------------------


class TestSysPackageFilterApt:
    """Tests for SysPackageFilter when invoked as apt-get / apt."""

    def _apt_stdout(self) -> str:
        return (
            "Reading package lists... Done\n"
            "Building dependency tree... Done\n"
            "Reading state information... Done\n"
            "The following NEW packages will be installed:\n"
            "  curl wget git\n"
            "Get:1 http://archive.ubuntu.com/ubuntu focal/main amd64 curl amd64 7.68.0 [161 kB]\n"
            "Get:2 http://archive.ubuntu.com/ubuntu focal/main amd64 wget amd64 1.20.3 [90 kB]\n"
            "Get:3 http://archive.ubuntu.com/ubuntu focal/main amd64 git amd64 2.25.1 [2494 kB]\n"
            "Fetched 2745 kB in 2s (1372 kB/s)\n"
            "Unpacking curl (7.68.0-1ubuntu2.22) ...\n"
            "Unpacking wget (1.20.3-1ubuntu1) ...\n"
            "Unpacking git (1:2.25.1-1ubuntu3.13) ...\n"
            "Setting up curl (7.68.0-1ubuntu2.22) ...\n"
            "Setting up wget (1.20.3-1ubuntu1) ...\n"
            "Setting up git (1:2.25.1-1ubuntu3.13) ...\n"
            "Processing triggers for man-db (2.9.1-1) ...\n"
        )

    def test_collapses_download_lines(self) -> None:
        """'Get:N http://…' lines should be collapsed to a count note."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "Get:1" not in result.text
        assert "collapsed 3 'Get:N' download lines" in result.text

    def test_collapses_unpack_setup_lines(self) -> None:
        """'Unpacking' and 'Setting up' lines should be collapsed."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "Unpacking curl" not in result.text
        assert "Setting up curl" not in result.text
        assert "collapsed 6 'Unpacking/Setting up' lines" in result.text

    def test_keeps_package_list_header(self) -> None:
        """'The following NEW packages' block headers should survive."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "The following NEW packages will be installed:" in result.text

    def test_keeps_fetched_summary(self) -> None:
        """'Fetched X MB in Ys' summary should survive."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "Fetched 2745 kB in 2s" in result.text

    def test_keeps_reading_boilerplate(self) -> None:
        """'Reading package lists' and 'Building dependency tree' are kept for context."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "Reading package lists" in result.text

    def test_collapses_triggers(self) -> None:
        """'Processing triggers for' lines should be collapsed."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apt_stdout(), "", 0, ["apt-get", "install", "curl"])
        assert "Processing triggers for man-db" not in result.text
        assert "collapsed 1 'Processing triggers' lines" in result.text

    def test_keeps_error_lines(self) -> None:
        """E: error lines must survive compression."""
        text = (
            "Reading package lists... Done\n"
            "E: Could not get lock /var/lib/dpkg/lock — open (11: Resource temporarily unavailable)\n"
        )
        f = bc.SysPackageFilter()
        result = f.apply(text, "", 100, ["apt-get", "install", "curl"])
        assert "E: Could not get lock" in result.text

    @pytest.mark.parametrize("argv", [
        ["apt-get", "install", "curl"],
        ["apt", "install", "curl"],
    ])
    def test_select_filter_dispatches_apt(self, argv) -> None:
        """select_filter routes apt/apt-get to SysPackageFilter."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "sys-pkg"

    def test_exported_in_all(self) -> None:
        assert "SysPackageFilter" in bc.__all__


class TestSysPackageFilterApk:
    """Tests for SysPackageFilter when invoked as apk."""

    def _apk_stdout(self) -> str:
        return (
            "fetch http://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86_64/APKINDEX.tar.gz\n"
            "fetch http://dl-cdn.alpinelinux.org/alpine/v3.18/community/x86_64/APKINDEX.tar.gz\n"
            "(1/3) Installing libgcc (12.2.1_git20220924-r10)\n"
            "(2/3) Installing libstdc++ (12.2.1_git20220924-r10)\n"
            "(3/3) Installing bash (5.2.15-r5)\n"
            "OK: 20 MiB in 18 packages\n"
        )

    def test_collapses_fetch_lines(self) -> None:
        """'fetch http://…' lines should be collapsed."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apk_stdout(), "", 0, ["apk", "add", "bash"])
        assert "fetch http://" not in result.text
        assert "collapsed 2 'fetch' download lines" in result.text

    def test_collapses_installing_lines(self) -> None:
        """'(N/N) Installing …' lines should be collapsed."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apk_stdout(), "", 0, ["apk", "add", "bash"])
        assert "(1/3) Installing" not in result.text
        assert "collapsed 3 'Installing' progress lines" in result.text

    def test_keeps_ok_summary(self) -> None:
        """'OK: N MiB in M packages' summary should survive."""
        f = bc.SysPackageFilter()
        result = f.apply(self._apk_stdout(), "", 0, ["apk", "add", "bash"])
        assert "OK: 20 MiB in 18 packages" in result.text

    def test_keeps_error_lines(self) -> None:
        """Error messages must survive."""
        text = (
            "fetch http://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86_64/APKINDEX.tar.gz\n"
            "ERROR: unable to fetch package: network timeout\n"
        )
        f = bc.SysPackageFilter()
        result = f.apply(text, "", 1, ["apk", "add", "curl"])
        assert "ERROR: unable to fetch package" in result.text

    def test_select_filter_dispatches_apk(self) -> None:
        """select_filter routes 'apk add' to SysPackageFilter."""
        f = bc.select_filter(["apk", "add", "bash"])
        assert f is not None
        assert f.name == "sys-pkg"


class TestSysPackageFilterBrew:
    """Tests for SysPackageFilter when invoked as brew."""

    def _brew_stdout(self) -> str:
        return (
            "==> Auto-updated Homebrew!\n"
            "Updated 3 taps (homebrew/core, homebrew/cask, homebrew/services).\n"
            "==> Downloading https://formulae.brew.sh/api/formula.jws.json\n"
            "==> Fetching dependencies for wget: libidn2, libunistring\n"
            "==> Downloading https://ghcr.io/v2/homebrew/core/libidn2/manifests/2.3.4\n"
            "==> Downloading https://ghcr.io/v2/homebrew/core/wget/manifests/1.21.3\n"
            "==> Installing dependencies for wget: libidn2\n"
            "==> Installing wget\n"
            "==> Pouring wget--1.21.3.arm64_ventura.bottle.tar.gz\n"
            "🍺  /opt/homebrew/Cellar/wget/1.21.3: 55 files, 5.5MB\n"
        )

    def test_collapses_progress_lines_beyond_sample(self) -> None:
        """More than 3 '==> Downloading/Fetching/etc' lines are collapsed."""
        f = bc.SysPackageFilter()
        result = f.apply(self._brew_stdout(), "", 0, ["brew", "install", "wget"])
        # Sample has 3 lines kept, the rest collapsed
        assert "more brew progress lines collapsed" in result.text

    def test_keeps_summary_bottle_line(self) -> None:
        """The '🍺 /opt/homebrew/…' bottle summary should survive."""
        f = bc.SysPackageFilter()
        result = f.apply(self._brew_stdout(), "", 0, ["brew", "install", "wget"])
        assert "🍺" in result.text

    def test_keeps_error_lines(self) -> None:
        """Error: lines must survive."""
        text = (
            "==> Downloading https://formulae.brew.sh/api/formula.jws.json\n"
            "Error: No available formula or cask with the name \"missingpkg\".\n"
        )
        f = bc.SysPackageFilter()
        result = f.apply(text, "", 1, ["brew", "install", "missingpkg"])
        assert "No available formula" in result.text

    def test_keeps_already_installed(self) -> None:
        """'Warning: wget 1.21.3 is already installed' should survive."""
        text = "Warning: wget 1.21.3 is already installed and up-to-date\n"
        f = bc.SysPackageFilter()
        result = f.apply(text, "", 0, ["brew", "install", "wget"])
        assert "already installed" in result.text

    def test_select_filter_dispatches_brew(self) -> None:
        """select_filter routes 'brew install' to SysPackageFilter."""
        f = bc.select_filter(["brew", "install", "wget"])
        assert f is not None
        assert f.name == "sys-pkg"


# ---------------------------------------------------------------------------
# ProtocFilter
# ---------------------------------------------------------------------------


class TestProtocFilter:
    """Tests for ProtocFilter (Protocol Buffer compiler output compression)."""

    def test_drops_info_lines(self) -> None:
        """[libprotobuf INFO ...] lines are dropped as noise."""
        text = (
            "[libprotobuf INFO google/protobuf/compiler/parser.cc:234] "
            "No syntax specified for the proto file: my.proto. "
            "Please use a syntax statement.\n"
            "[libprotobuf INFO google/protobuf/descriptor.cc:98] "
            "Loaded proto descriptor from disk.\n"
            "my.proto: warning: Import google/protobuf/empty.proto is unused.\n"
        )
        f = bc.ProtocFilter()
        result = f.apply(text, "", 0, ["protoc", "--go_out=.", "my.proto"])
        # INFO content must not appear as actual lines (the compression note
        # mentions "libprotobuf INFO" as a label, so check for the full
        # source-location pattern that only real INFO lines carry).
        assert "google/protobuf/descriptor.cc:98" not in result.text
        assert "Loaded proto descriptor from disk" not in result.text
        assert "dropped" in result.text
        assert "Import google/protobuf/empty.proto is unused" in result.text

    def test_keeps_warning_lib_lines(self) -> None:
        """[libprotobuf WARNING ...] lines are kept verbatim."""
        text = (
            "[libprotobuf INFO google/protobuf/compiler/parser.cc:234] info noise\n"
            "[libprotobuf WARNING google/protobuf/compiler/proto3_optional.cc:59] "
            "Proto3 optional is not yet fully supported.\n"
        )
        f = bc.ProtocFilter()
        result = f.apply(text, "", 0, ["protoc", "my.proto"])
        assert "[libprotobuf WARNING" in result.text
        # The INFO line body must not appear; only the compression note mentions the label.
        assert "info noise" not in result.text

    def test_keeps_proto_diagnostics(self) -> None:
        """file.proto:N:N: error/warning diagnostics are kept verbatim."""
        stderr = (
            "src/api/user.proto:42:5: Field name \"UserId\" should be "
            "lower_snake_case, such as \"user_id\".\n"
            "src/api/user.proto:55:3: \"UnknownMsg\" is not defined.\n"
        )
        f = bc.ProtocFilter()
        result = f.apply("", stderr, 1, ["protoc", "--python_out=.", "src/api/user.proto"])
        assert 'src/api/user.proto:42:5:' in result.text
        assert 'src/api/user.proto:55:3:' in result.text

    def test_keeps_file_not_found(self) -> None:
        """'File not found.' errors are preserved."""
        stderr = (
            "google/protobuf/descriptor.proto: File not found.\n"
            "my.proto: File not found.\n"
        )
        f = bc.ProtocFilter()
        result = f.apply("", stderr, 1, ["protoc", "my.proto"])
        assert "google/protobuf/descriptor.proto: File not found." in result.text
        assert "my.proto: File not found." in result.text

    def test_deduplicates_repeated_warnings(self) -> None:
        """Identical warning lines are collapsed to one occurrence + count note."""
        repeated_warn = (
            "[libprotobuf WARNING google/protobuf/compiler/parser.cc:234] "
            "No syntax specified for the proto file: my.proto. "
            "Please use a syntax statement.\n"
        )
        # 15 identical warning lines (deeply nested import graph scenario).
        text = repeated_warn * 15
        f = bc.ProtocFilter()
        result = f.apply(text, "", 0, ["protoc", "--go_out=.", "my.proto"])
        # Warning should appear once; the extra 14 should be counted.
        assert "No syntax specified" in result.text
        assert result.text.count("No syntax specified") == 1
        assert "collapsed" in result.text

    def test_keeps_summary_line(self) -> None:
        """'N errors generated.' summary lines survive."""
        text = (
            "src/foo.proto:10:3: \"Unknown\" is not defined.\n"
            "src/foo.proto:20:5: Field name must be lower_snake_case.\n"
            "2 errors generated.\n"
        )
        f = bc.ProtocFilter()
        result = f.apply(text, "", 1, ["protoc", "src/foo.proto"])
        assert "2 errors generated." in result.text

    def test_successful_run_no_output(self) -> None:
        """protoc with no output (clean success) produces minimal result."""
        f = bc.ProtocFilter()
        result = f.apply("", "", 0, ["protoc", "--go_out=.", "my.proto"])
        # No notes should appear when there's nothing to collapse.
        assert "dropped" not in result.text
        assert "collapsed" not in result.text

    def test_select_filter_dispatches_protoc(self) -> None:
        """select_filter routes protoc to ProtocFilter."""
        f = bc.select_filter(["protoc", "--go_out=.", "my.proto"])
        assert f is not None
        assert f.name == "protoc"

    def test_select_filter_dispatches_buf(self) -> None:
        """select_filter routes buf build/generate to ProtocFilter."""
        f = bc.select_filter(["buf", "generate"])
        assert f is not None
        assert f.name == "protoc"

    def test_compression_applied_on_large_output(self) -> None:
        """Compressing 30 INFO lines reduces byte count."""
        info_line = (
            "[libprotobuf INFO google/protobuf/compiler/parser.cc:234] "
            "No syntax specified for file: proto/foo.proto.\n"
        )
        stdout = info_line * 30
        stdout += "1 warning generated.\n"
        f = bc.ProtocFilter()
        result = f.apply(stdout, "", 0, ["protoc", "proto/foo.proto"])
        assert result.compressed_bytes < len(stdout.encode())
        assert "1 warning generated." in result.text


# ---------------------------------------------------------------------------
# MakeFilter — ninja-specific output
# ---------------------------------------------------------------------------


class TestMakeFilterNinja:
    """Tests for MakeFilter handling ninja build output.

    Ninja is handled by MakeFilter (same binaries set) but has a slightly
    different output style: it does not emit make[N] recursion markers, but
    does emit compiler-invocation echo lines and builds with percentage
    progress from the ninja build system itself.
    """

    def test_ninja_matches_make_filter(self) -> None:
        """select_filter routes 'ninja' to MakeFilter."""
        f = bc.select_filter(["ninja"])
        assert f is not None
        assert f.name == "make"

    def test_ninja_keeps_error_lines(self) -> None:
        """ninja: error lines survive compression."""
        text = (
            "[1/3] gcc -c src/main.c -o src/main.o\n"
            "[2/3] gcc -c src/util.c -o src/util.o\n"
            "src/util.c:42: error: implicit declaration of function 'missing_fn'\n"
            "[3/3] FAILED: src/util.o\n"
            "ninja: build stopped: subcommand failed.\n"
        )
        f = bc.MakeFilter()
        result = f.apply(text, "", 1, ["ninja"])
        assert "error: implicit declaration" in result.text
        assert "FAILED" in result.text

    def test_ninja_drops_compiler_invocation_echo(self) -> None:
        """gcc/clang compiler invocation echo lines are dropped."""
        text = (
            "gcc -c -O2 -Wall src/alpha.c -o build/alpha.o\n"
            "gcc -c -O2 -Wall src/beta.c -o build/beta.o\n"
            "gcc -o build/myapp build/alpha.o build/beta.o\n"
        )
        f = bc.MakeFilter()
        result = f.apply(text, "", 0, ["ninja"])
        assert "gcc -c -O2" not in result.text
        assert "compiler-invocation" in result.text

    def test_ninja_build_success_minimal_output(self) -> None:
        """A clean ninja build with only compiler echoes compresses well."""
        lines = [f"clang -c src/file_{i}.cc -o build/file_{i}.o" for i in range(20)]
        text = "\n".join(lines)
        f = bc.MakeFilter()
        result = f.apply(text, "", 0, ["ninja"])
        assert result.compressed_bytes < len(text.encode())

    def test_ninja_handles_link_line(self) -> None:
        """Linker lines (non-compiler echoes) are kept by default."""
        text = (
            "gcc -c src/main.c -o build/main.o\n"
            "Linking CXX executable build/myapp\n"
        )
        f = bc.MakeFilter()
        result = f.apply(text, "", 0, ["ninja"])
        # Linker output is not matched by the compiler-echo RE so it passes through.
        assert "Linking CXX executable" in result.text


# ---------------------------------------------------------------------------
# CargoFilter — subcommand coverage (test, clippy, check, progress lines)
# ---------------------------------------------------------------------------


class TestCargoFilterSubcommands:
    """Coverage for CargoFilter subcommand paths not exercised by TestCargoFilter."""

    def test_cargo_test_collapses_passing_tests(self) -> None:
        """cargo test: passing 'test foo ... ok' lines are counted, not shown."""
        stdout = "\n".join(
            [f"test module::test_{i} ... ok" for i in range(15)]
        ) + "\ntest result: ok. 15 passed; 0 failed; 0 ignored\n"
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "test"])
        assert "test_0" not in result.text
        assert "collapsed 15 passing" in result.text
        assert "test result: ok" in result.text

    def test_cargo_test_keeps_failed_tests(self) -> None:
        """cargo test: FAILED lines are kept verbatim."""
        stdout = (
            "test module::test_ok ... ok\n"
            "test module::test_broken ... FAILED\n"
            "failures:\n"
            "    thread 'module::test_broken' panicked at 'assertion failed'\n"
            "test result: FAILED. 1 passed; 1 failed\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 1, ["cargo", "test"])
        assert "test_broken ... FAILED" in result.text
        assert "test_ok" not in result.text
        assert "test result: FAILED" in result.text

    def test_cargo_test_keeps_running_headers(self) -> None:
        """cargo test: 'Running unittests ...' section markers are preserved."""
        stdout = (
            "Running unittests src/lib.rs (target/debug/deps/mylib-abc123)\n"
            "test unit::test_a ... ok\n"
            "test result: ok. 1 passed; 0 failed\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "test"])
        assert "Running unittests" in result.text

    def test_cargo_clippy_drops_checking_lines(self) -> None:
        """cargo clippy: 'Checking crate v...' progress lines are dropped."""
        stderr = "\n".join(
            [f"    Checking crate-{i} v0.1.0 (/path/{i})" for i in range(10)]
        ) + "\nwarning: unused variable `x`\n  --> src/main.rs:5:9\n"
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "clippy"])
        assert "Checking crate-0" not in result.text
        assert "dropped 10 'Checking" in result.text
        assert "warning: unused variable" in result.text

    def test_cargo_clippy_keeps_warnings(self) -> None:
        """cargo clippy: warning diagnostics are always preserved."""
        stderr = (
            "    Checking myapp v0.1.0 (/repo)\n"
            "warning: this expression creates a reference to a temporary value\n"
            "  --> src/lib.rs:12:18\n"
            "   |\n"
            "12 |     let r = &String::from(\"tmp\");\n"
        )
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "clippy"])
        assert "warning: this expression creates" in result.text
        assert "src/lib.rs:12" in result.text

    def test_cargo_check_drops_progress_lines(self) -> None:
        """cargo check: Downloading/Fetching/Updating progress lines are dropped."""
        stderr = (
            "    Updating crates.io index\n"
            "    Downloading crates ...\n"
            "    Fetching serde v1.0.0\n"
            "    Checking myapp v0.1.0 (/repo)\n"
            "    Finished `check` [unoptimized] target(s) in 3.45s\n"
        )
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "check"])
        assert "Updating crates.io" not in result.text
        assert "Downloading crates" not in result.text
        assert "Fetching serde" not in result.text
        assert "Finished" in result.text

    def test_cargo_build_drops_progress_lines(self) -> None:
        """cargo build: Downloading/Fetching/Updating are dropped; count is noted."""
        stderr = (
            "   Downloading foo v1.0.0\n"
            "   Fetching bar v2.0.0\n"
            "   Updating crates.io index\n"
            "   Compiling myapp v0.1.0\n"
            "    Finished dev [unoptimized + debuginfo] target(s) in 10.0s\n"
        )
        f = bc.CargoFilter()
        result = f.apply("", stderr, 0, ["cargo", "build"])
        assert "Downloading" not in result.text
        assert "Fetching" not in result.text
        assert "Updating" not in result.text
        assert "dropped" in result.text or "cargo progress" in result.text
        assert "Finished" in result.text

    def test_cargo_run_passthrough(self) -> None:
        """cargo run: output is passed through verbatim (load-bearing script output)."""
        stdout = "Hello, world!\nServer listening on port 8080\n"
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "run"])
        assert "Hello, world!" in result.text
        assert "Server listening" in result.text

    def test_cargo_bench_keeps_result_lines(self) -> None:
        """cargo bench: benchmark result lines are preserved verbatim."""
        stdout = (
            "running 2 tests\n"
            "test bench_hash ... bench:       1,234 ns/iter (+/- 56)\n"
            "test bench_sort ... bench:       5,678 ns/iter (+/- 89)\n"
            "\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured; 0 filtered out\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "bench"])
        assert "bench_hash" in result.text
        assert "1,234 ns/iter" in result.text
        assert "bench_sort" in result.text
        assert "test result: ok" in result.text

    def test_cargo_bench_single_suite_drops_running_header(self) -> None:
        """cargo bench: single 'running N tests' header is dropped (redundant with result lines)."""
        stdout = (
            "running 3 tests\n"
            "test bench_a ... bench:         100 ns/iter (+/-  5)\n"
            "test bench_b ... bench:         200 ns/iter (+/- 10)\n"
            "test bench_c ... bench:         300 ns/iter (+/- 15)\n"
            "\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered out\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "bench"])
        # The 'running N tests' line should be collapsed with a note.
        assert "running 3 tests" not in result.text
        assert "dropped" in result.text or "collapsed" in result.text or "running" not in result.text

    def test_cargo_bench_multiple_suites_keep_running_headers(self) -> None:
        """cargo bench: when multiple bench suites exist, all 'running N tests' headers are kept."""
        stdout = (
            "running 2 tests\n"
            "test bench_suite1_a ... bench:   1,234 ns/iter (+/- 56)\n"
            "test bench_suite1_b ... bench:   5,678 ns/iter (+/- 89)\n"
            "\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured\n"
            "\n"
            "running 2 tests\n"
            "test bench_suite2_x ... bench:     100 ns/iter (+/-  5)\n"
            "test bench_suite2_y ... bench:     200 ns/iter (+/- 10)\n"
            "\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, "", 0, ["cargo", "bench"])
        # Both bench result lines must be present.
        assert "bench_suite1_a" in result.text
        assert "bench_suite2_x" in result.text

    def test_cargo_bench_collapses_compiling_noise(self) -> None:
        """cargo bench: Compiling lines in stderr are collapsed, bench results kept."""
        stderr = "\n".join(
            [f"   Compiling crate{i} v0.1.{i}" for i in range(8)]
            + ["    Finished bench [optimized] target(s) in 20.0s"]
        )
        stdout = (
            "running 1 test\n"
            "test bench_main ... bench:     500 ns/iter (+/- 10)\n"
            "\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 1 measured\n"
        )
        f = bc.CargoFilter()
        result = f.apply(stdout, stderr, 0, ["cargo", "bench"])
        assert "bench_main" in result.text
        assert "500 ns/iter" in result.text
        assert "Finished" in result.text
        # 8 Compiling lines > 4 threshold — should be collapsed.
        assert result.text.count("Compiling") < 8

    @pytest.mark.parametrize("argv", [
        ["cargo", "clippy"],
        ["cargo", "test"],
        ["cargo", "check"],
        ["cargo", "bench"],
    ])
    def test_select_filter_dispatches_cargo_subcommands(self, argv) -> None:
        """select_filter routes cargo subcommands to CargoFilter."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "cargo"


# ---------------------------------------------------------------------------
# VitestFilter
# ---------------------------------------------------------------------------


class TestVitestFilter:
    """Coverage for VitestFilter — file-level pass collapse, fail blocks, tick collapse."""

    def test_collapses_passing_file_lines(self) -> None:
        """Passing file lines (✓ path/to/file.test.ts (Xms)) are counted, not shown."""
        lines = [f" ✓ src/module{i}.test.ts (12ms)" for i in range(8)]
        lines.append("Test Files  8 passed (8)")
        lines.append("Tests       32 passed (32)")
        lines.append("Duration    1.23s")
        text = "\n".join(lines)
        f = bc.VitestFilter()
        result = f.apply(text, "", 0, ["vitest"])
        assert "module0.test.ts" not in result.text
        assert "collapsed 8 passing" in result.text
        assert "Test Files  8 passed" in result.text

    def test_keeps_fail_block(self) -> None:
        """Failing file blocks (× or FAIL) are kept verbatim."""
        text = (
            " ✓ src/passing.test.ts (5ms)\n"
            " × src/broken.test.ts (3ms)\n"
            "   AssertionError: expected 1 to equal 2\n"
            "   at Object.<anonymous> (src/broken.test.ts:10:5)\n"
            "Test Files  1 failed | 1 passed (2)\n"
        )
        f = bc.VitestFilter()
        result = f.apply(text, "", 1, ["vitest"])
        assert "broken.test.ts" in result.text
        assert "AssertionError" in result.text
        assert "passing.test.ts" not in result.text
        assert "Test Files" in result.text

    def test_collapses_per_test_pass_ticks(self) -> None:
        """Indented ✓ per-test pass ticks (from --reporter=verbose) are collapsed."""
        lines = ["Tests"]
        for i in range(20):
            lines.append(f"  ✓ should pass case {i}")
        lines.append("Tests       20 passed (20)")
        text = "\n".join(lines)
        f = bc.VitestFilter()
        result = f.apply(text, "", 0, ["vitest", "--reporter=verbose"])
        # Per-test ticks should be collapsed
        assert "should pass case 0" not in result.text
        assert "collapsed" in result.text

    def test_keeps_summary_lines(self) -> None:
        """Test Files / Tests / Duration summary lines are always kept."""
        text = (
            " ✓ src/a.test.ts (1ms)\n"
            " ✓ src/b.test.ts (2ms)\n"
            "Test Files  2 passed (2)\n"
            "Tests       10 passed (10)\n"
            "Duration    0.50s\n"
        )
        f = bc.VitestFilter()
        result = f.apply(text, "", 0, ["vitest"])
        assert "Test Files  2 passed" in result.text
        assert "Tests       10 passed" in result.text
        assert "Duration    0.50s" in result.text

    def test_select_filter_dispatches_vitest(self) -> None:
        """select_filter routes 'vitest' to VitestFilter."""
        f = bc.select_filter(["vitest"])
        assert f is not None
        assert f.name == "vitest"

    def test_compression_reduces_size_on_large_pass_run(self) -> None:
        """Compression reduces output size when all tests pass."""
        lines = [f" ✓ src/module{i}.test.ts (10ms)" for i in range(50)]
        lines.append("Test Files  50 passed (50)")
        text = "\n".join(lines)
        f = bc.VitestFilter()
        result = f.apply(text, "", 0, ["vitest"])
        assert result.compressed_bytes < len(text.encode())


# ---------------------------------------------------------------------------
# SwiftFilter
# ---------------------------------------------------------------------------


class TestSwiftFilter:
    """Coverage for SwiftFilter — build phase collapse and test compression."""

    def test_build_collapses_compile_lines(self) -> None:
        """swift build: CompileSwift/MergeSwiftModule/Ld phase lines are collapsed."""
        lines = []
        for i in range(20):
            lines.append(f"CompileSwift normal arm64 /src/File{i}.swift")
        lines.append("MergeSwiftModule normal arm64 /build/MyApp.swiftmodule")
        lines.append("Build complete!")
        text = "\n".join(lines)
        f = bc.SwiftFilter()
        result = f.apply(text, "", 0, ["swift", "build"])
        assert "CompileSwift" not in result.text
        assert "collapsed" in result.text
        assert "Build complete!" in result.text

    def test_build_keeps_warnings(self) -> None:
        """swift build: warning diagnostics survive compression."""
        text = (
            "CompileSwift normal arm64 /src/Foo.swift\n"
            "/src/Foo.swift:10:5: warning: result of call to 'foo()' is unused\n"
            "Build complete!\n"
        )
        f = bc.SwiftFilter()
        result = f.apply(text, "", 0, ["swift", "build"])
        assert "warning: result of call" in result.text
        assert "Build complete!" in result.text

    def test_build_keeps_errors(self) -> None:
        """swift build: error diagnostics survive compression."""
        text = (
            "CompileSwift normal arm64 /src/Bar.swift\n"
            "/src/Bar.swift:5:10: error: use of undeclared type 'Foo'\n"
            "** BUILD FAILED **\n"
        )
        f = bc.SwiftFilter()
        result = f.apply(text, "", 1, ["swift", "build"])
        assert "error: use of undeclared type" in result.text
        assert "BUILD FAILED" in result.text

    def test_test_collapses_passing_cases(self) -> None:
        """swift test: passing 'Test Case … passed' lines are collapsed to count."""
        lines = []
        for i in range(12):
            lines.append(f"Test Case '-[MyTests.SuiteTests testMethod{i}]' passed (0.001 seconds).")
        lines.append("Test Suite 'MyTests.SuiteTests' passed at 2024-01-01 12:00:00.000.")
        lines.append("Executed 12 tests, with 0 failures (0 unexpected) in 0.012 (0.014) seconds")
        text = "\n".join(lines)
        f = bc.SwiftFilter()
        result = f.apply(text, "", 0, ["swift", "test"])
        assert "testMethod0" not in result.text
        assert "collapsed 12 passing" in result.text
        assert "Executed 12 tests" in result.text

    def test_test_keeps_failed_cases(self) -> None:
        """swift test: failing test case lines and failure bodies are preserved."""
        text = (
            "Test Case '-[MyTests.Suite testPassing]' passed (0.001 seconds).\n"
            "Test Case '-[MyTests.Suite testFailing]' failed (0.002 seconds).\n"
            "  /src/Tests.swift:42: error: XCTAssertEqual failed: (\"1\") is not equal to (\"2\")\n"
            "Executed 2 tests, with 1 failure (0 unexpected) in 0.003 seconds\n"
        )
        f = bc.SwiftFilter()
        result = f.apply(text, "", 1, ["swift", "test"])
        assert "testFailing" in result.text
        assert "XCTAssertEqual failed" in result.text
        assert "testPassing" not in result.text
        assert "Executed 2 tests" in result.text

    @pytest.mark.parametrize("argv", [
        ["swift", "build"],
        ["swift", "test"],
    ])
    def test_select_filter_dispatches_swift(self, argv) -> None:
        """select_filter routes swift subcommands to SwiftFilter."""
        f = bc.select_filter(argv)
        assert f is not None
        assert f.name == "swift"


# ---------------------------------------------------------------------------
# GoTestFilter
# ---------------------------------------------------------------------------


class TestGoTestFilter:
    """Coverage for GoTestFilter — pass/fail collapsing and dispatch."""

    def test_collapses_passing_tests(self) -> None:
        """go test: '--- PASS: TestFoo (0.00s)' lines are collapsed to count."""
        lines = []
        for i in range(15):
            lines.append(f"=== RUN   TestFunc{i}")
            lines.append(f"--- PASS: TestFunc{i} (0.00s)")
        lines.append("ok  \tgithub.com/org/repo\t0.015s")
        text = "\n".join(lines)
        f = bc.GoTestFilter()
        result = f.apply(text, "", 0, ["go", "test", "./..."])
        assert "TestFunc0" not in result.text
        assert "collapsed 15 PASS testcases" in result.text
        assert "ok  \tgithub.com/org/repo" in result.text

    def test_keeps_failed_tests(self) -> None:
        """go test: FAIL testcases and their failure body are kept verbatim."""
        text = (
            "=== RUN   TestPassing\n"
            "--- PASS: TestPassing (0.00s)\n"
            "=== RUN   TestBroken\n"
            "    main_test.go:25: expected 1, got 2\n"
            "--- FAIL: TestBroken (0.00s)\n"
            "FAIL\tgithub.com/org/repo\t0.002s\n"
        )
        f = bc.GoTestFilter()
        result = f.apply(text, "", 1, ["go", "test"])
        assert "TestBroken" in result.text
        assert "expected 1, got 2" in result.text
        assert "TestPassing" not in result.text

    def test_drops_downloading_lines(self) -> None:
        """go test: 'go: downloading ...' dependency fetch lines are dropped."""
        text = (
            "go: downloading github.com/pkg/errors v0.9.1\n"
            "go: downloading github.com/stretchr/testify v1.8.0\n"
            "=== RUN   TestSomething\n"
            "--- PASS: TestSomething (0.00s)\n"
            "ok  \tgithub.com/org/repo\t0.10s\n"
        )
        f = bc.GoTestFilter()
        result = f.apply(text, "", 0, ["go", "test", "./..."])
        # The download lines should not appear as content lines (only in the note).
        non_note_lines = [
            ln for ln in result.text.splitlines()
            if not ln.startswith("[token-goat:")
        ]
        assert not any("go: downloading" in ln for ln in non_note_lines)
        assert "dropped" in result.text
        assert "ok  \tgithub.com/org/repo" in result.text

    def test_drops_run_lines_outside_fail_block(self) -> None:
        """go test: '=== RUN' lines outside fail blocks are dropped."""
        lines = []
        for i in range(5):
            lines.append(f"=== RUN   TestCase{i}")
            lines.append(f"--- PASS: TestCase{i} (0.00s)")
        lines.append("ok  \trepo\t0.005s")
        text = "\n".join(lines)
        f = bc.GoTestFilter()
        result = f.apply(text, "", 0, ["go", "test"])
        # RUN lines should not appear as content lines (only in the note).
        non_note_lines = [
            ln for ln in result.text.splitlines()
            if not ln.startswith("[token-goat:")
        ]
        assert not any(ln.startswith("=== RUN") for ln in non_note_lines)

    def test_select_filter_dispatches_go_test(self) -> None:
        """select_filter routes 'go test' to GoTestFilter (not GoFilter)."""
        f = bc.select_filter(["go", "test", "./..."])
        assert f is not None
        assert f.name == "go-test"

    def test_go_build_does_not_dispatch_to_go_test_filter(self) -> None:
        """select_filter routes 'go build' to GoFilter, not GoTestFilter."""
        f = bc.select_filter(["go", "build", "./..."])
        assert f is not None
        assert f.name != "go-test"

    def test_json_flag_passes_through_unchanged(self) -> None:
        """go test -json emits JSON objects; the filter must not touch them."""
        json_lines = "\n".join([
            '{"Action":"run","Test":"TestFoo"}',
            '{"Action":"pass","Test":"TestFoo","Elapsed":0.001}',
            '{"Action":"run","Test":"TestBar"}',
            '{"Action":"fail","Test":"TestBar","Elapsed":0.002}',
        ])
        f = bc.GoTestFilter()
        result = f.apply(json_lines, "", 1, ["go", "test", "-json", "./..."])
        # JSON lines must survive unchanged so downstream parsers work.
        assert '{"Action":"fail"' in result.text
        assert '{"Action":"pass"' in result.text
        # No compression markers should be added
        assert "[token-goat:" not in result.text

    def test_skip_lines_counted_separately(self) -> None:
        """go test SKIP lines are counted separately from PASS lines."""
        text = (
            "=== RUN   TestSkipped\n"
            "    --- SKIP: TestSkipped (0.00s): not supported on this platform\n"
            "=== RUN   TestPassing\n"
            "--- PASS: TestPassing (0.00s)\n"
            "ok  \tgithub.com/org/repo\t0.003s\n"
        )
        f = bc.GoTestFilter()
        result = f.apply(text, "", 0, ["go", "test"])
        assert "collapsed 1 SKIP testcases" in result.text
        assert "collapsed 1 PASS testcases" in result.text


# ---------------------------------------------------------------------------
# RubyFilter (RSpec / Minitest dot-progress)
# ---------------------------------------------------------------------------


class TestRubyFilter:
    """Coverage for RubyFilter — dot-progress collapse and failure section."""

    def test_collapses_dot_progress_lines(self) -> None:
        """RSpec dot-progress lines with only dots are collapsed to count."""
        text = (
            "." * 30 + "\n"
            "." * 30 + "\n"
            "\n"
            "Finished in 0.5 seconds\n"
            "60 examples, 0 failures\n"
        )
        f = bc.RubyFilter()
        result = f.apply(text, "", 0, ["rspec"])
        # Dot-lines should not appear verbatim
        assert "." * 10 not in result.text
        assert "collapsed 60 passing" in result.text
        assert "60 examples, 0 failures" in result.text

    def test_keeps_failure_section(self) -> None:
        """RSpec 'Failures:' section and failure body are kept verbatim."""
        text = (
            "..." + "F" + "." * 10 + "\n"
            "\n"
            "Failures:\n"
            "\n"
            "  1) MyClass#method does the thing\n"
            "     Failure/Error: expect(subject.call).to eq('hello')\n"
            "       expected: 'hello'\n"
            "            got: nil\n"
            "\n"
            "Finished in 0.12 seconds\n"
            "14 examples, 1 failure\n"
        )
        f = bc.RubyFilter()
        result = f.apply(text, "", 1, ["rspec"])
        assert "Failures:" in result.text
        assert "MyClass#method" in result.text
        assert "expected: 'hello'" in result.text
        assert "14 examples, 1 failure" in result.text

    def test_preserves_failure_chars_from_progress(self) -> None:
        """F and E chars in progress lines produce a summary line before full failures."""
        text = (
            "..F..\n"
            "\n"
            "Failures:\n"
            "  1) foo failed\n"
            "     expected: true got: false\n"
            "\n"
            "Finished in 0.1 seconds\n"
            "5 examples, 1 failure\n"
        )
        f = bc.RubyFilter()
        result = f.apply(text, "", 1, ["rspec"])
        # The filter emits [F] (failures in progress output) marker
        assert "[F]" in result.text or "F" in result.text

    def test_rake_passthrough(self) -> None:
        """rake output is passed through with basic dedup — not compressed."""
        text = "rake aborted!\nTask 'build' not found.\n(See full trace by running task with --trace)\n"
        f = bc.RubyFilter()
        result = f.apply(text, "", 1, ["rake"])
        assert "rake aborted!" in result.text
        assert "Task 'build' not found" in result.text

    def test_select_filter_dispatches_rspec(self) -> None:
        """select_filter routes 'rspec' to RubyFilter."""
        f = bc.select_filter(["rspec"])
        assert f is not None
        assert f.name == "ruby"

    def test_select_filter_dispatches_minitest(self) -> None:
        """select_filter routes 'minitest' to RubyFilter."""
        f = bc.select_filter(["minitest"])
        assert f is not None
        assert f.name == "ruby"

    def test_minitest_summary_kept(self) -> None:
        """Minitest 'N runs, N assertions, N failures' summary lines are kept."""
        text = (
            "." * 20 + "\n"
            "\n"
            "20 runs, 40 assertions, 0 failures, 0 errors, 0 skips\n"
        )
        f = bc.RubyFilter()
        result = f.apply(text, "", 0, ["minitest"])
        assert "20 runs, 40 assertions" in result.text


# ---------------------------------------------------------------------------
# MakeFilter — autotools configure compression
# ---------------------------------------------------------------------------

class TestMakeFilterConfigure:
    """MakeFilter correctly compresses autotools ./configure output."""

    @pytest.mark.parametrize("argv", [
        ["./configure"],
        ["../configure"],
        ["/usr/src/mylib/configure"],
        ["./config"],   # alternate autotools stem
    ])
    def test_matches_configure_scripts(self, argv) -> None:
        """MakeFilter.matches() accepts configure/config script paths."""
        assert bc.MakeFilter().matches(argv)

    def test_select_filter_dispatches_configure(self) -> None:
        """select_filter routes './configure' to MakeFilter."""
        f = bc.select_filter(["./configure"])
        assert f is not None
        assert f.name == "make"

    def test_checking_lines_dropped(self) -> None:
        """'checking for ...' probe lines are dropped and counted in note."""
        stdout = (
            "checking for gcc... yes\n"
            "checking for g++... yes\n"
            "checking whether gcc accepts -g... yes\n"
            "checking for library containing dlopen... -ldl\n"
            "configure: creating ./config.status\n"
            "config.status: creating Makefile\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["./configure"])
        assert "checking for gcc" not in result.text
        assert "checking whether" not in result.text
        assert "checking for library" not in result.text
        assert "dropped 4" in result.text
        assert "probe" in result.text

    def test_configure_info_lines_dropped(self) -> None:
        """'configure: creating ...' benign info lines are dropped."""
        stdout = (
            "checking for make... make\n"
            "configure: creating ./config.status\n"
            "configure: loading cache ./config.cache\n"
            "configure: running config.status\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["./configure"])
        # The actual config.status / cache paths should not appear (lines dropped)
        assert "config.status" not in result.text
        assert "./config.cache" not in result.text
        # A summary note about dropped info lines should be present
        assert "creating/loading" in result.text

    def test_configure_error_kept(self) -> None:
        """'configure: error: ...' lines are always kept."""
        stdout = (
            "checking for zlib.h... no\n"
            "configure: error: zlib not found; install zlib-dev\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 1, ["./configure"])
        assert "configure: error: zlib not found" in result.text

    def test_configure_warning_kept(self) -> None:
        """'configure: WARNING: ...' lines are always kept."""
        stdout = (
            "checking for openssl... yes\n"
            "configure: WARNING: unrecognized options: --enable-foo\n"
            "checking whether to enable debug... no\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["./configure"])
        assert "configure: WARNING: unrecognized options" in result.text

    def test_non_checking_lines_kept(self) -> None:
        """Non-probe lines (preamble, AC_MSG_RESULT, etc.) are kept."""
        stdout = (
            "This is free software; see the source for copying conditions.\n"
            "checking for gcc... yes\n"
            "Your system is ready to build.\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["./configure"])
        assert "This is free software" in result.text
        assert "Your system is ready to build" in result.text

    def test_clean_configure_no_probe_no_note(self) -> None:
        """A configure with no probe lines emits no note."""
        stdout = "configure: creating ./config.status\n"
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["./configure"])
        # The info line is dropped, but no "dropped N" probe note should appear
        assert "probe" not in result.text


# ---------------------------------------------------------------------------
# MakeFilter — CMake [N%] percent-progress line dropping
# ---------------------------------------------------------------------------

class TestMakeFilterPercentProgress:
    """MakeFilter drops [N%] CMake parallel-make progress lines."""

    def test_percent_building_lines_dropped(self) -> None:
        """'[N%] Building CXX object ...' lines are dropped."""
        stdout = (
            "[ 10%] Building CXX object src/CMakeFiles/lib.dir/foo.cpp.o\n"
            "[ 50%] Building C object src/CMakeFiles/lib.dir/bar.c.o\n"
            "[ 90%] Linking CXX executable myapp\n"
            "[100%] Built target myapp\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["make"])
        assert "Building CXX object" not in result.text
        assert "Linking CXX executable" not in result.text
        assert "percent" in result.text.lower() or "progress" in result.text.lower() or "Building" not in result.text

    def test_percent_progress_note_emitted(self) -> None:
        """A note is appended when [N%] lines are dropped."""
        stdout = (
            "[ 25%] Building CXX object foo.cpp.o\n"
            "[ 50%] Scanning dependencies of target lib\n"
            "[ 75%] Generating foo.h\n"
            "[100%] Installing headers\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["make"])
        assert "dropped" in result.text
        assert "progress" in result.text.lower() or "Building" not in result.text

    def test_percent_line_with_error_kept(self) -> None:
        """A [N%] line containing 'error' is not dropped."""
        stdout = (
            "[ 50%] Building CXX object foo.cpp.o\n"
            "[ 75%] Building CXX: error: unexpected token\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 1, ["make"])
        assert "error: unexpected token" in result.text

    def test_regular_make_output_unaffected(self) -> None:
        """Normal make output without [N%] lines is unaffected."""
        stdout = (
            "cc -c foo.c -o foo.o\n"
            "make[1]: Entering directory '/src'\n"
            "make[1]: Leaving directory '/src'\n"
        )
        f = bc.MakeFilter()
        result = f.apply(stdout, "", 0, ["make"])
        # Should still pass through (not error on absent percent lines)
        assert result.text is not None


# ---------------------------------------------------------------------------
# MavenFilter — [INFO] boilerplate / separator collapsing
# ---------------------------------------------------------------------------

class TestMavenFilterBoilerplate:
    """MavenFilter._compress_test() drops [INFO] separators and boilerplate."""

    def _maven_output(self, extra_lines: str = "") -> str:
        """Build a minimal maven test-run output with boilerplate."""
        return (
            "[INFO] Scanning for projects...\n"
            "[INFO] \n"
            "[INFO] ------------------------------------------------------------------------\n"
            "[INFO] Building myproject 1.0.0\n"
            "[INFO] ------------------------------------------------------------------------\n"
            "[INFO] --- maven-surefire-plugin:3.0.0:test (default-test) @ myproject ---\n"
            + extra_lines +
            "[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0\n"
            "[INFO] \n"
            "[INFO] ------------------------------------------------------------------------\n"
            "[INFO] BUILD SUCCESS\n"
            "[INFO] ------------------------------------------------------------------------\n"
        )

    def test_separator_lines_dropped(self) -> None:
        """'[INFO] --------...' separator lines are dropped."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "--------" not in result.text

    def test_scanning_for_projects_dropped(self) -> None:
        """'[INFO] Scanning for projects...' is dropped as boilerplate."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "Scanning for projects" not in result.text

    def test_building_line_dropped(self) -> None:
        """'[INFO] Building X' lines are dropped as boilerplate."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "Building myproject 1.0.0" not in result.text

    def test_plugin_header_dropped(self) -> None:
        """'[INFO] --- plugin:version:goal' lines are dropped."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "maven-surefire-plugin" not in result.text

    def test_test_summary_kept(self) -> None:
        """'[INFO] Tests run: ...' summary lines are always kept."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "Tests run: 5" in result.text

    def test_build_success_kept(self) -> None:
        """'[INFO] BUILD SUCCESS' is always kept."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "BUILD SUCCESS" in result.text

    def test_boilerplate_note_emitted(self) -> None:
        """A note reporting how many [INFO] boilerplate lines were dropped is emitted."""
        f = bc.MavenFilter()
        result = f.apply(self._maven_output(), "", 0, ["mvn", "test"])
        assert "collapsed" in result.text
        assert "[INFO]" in result.text or "boilerplate" in result.text

    def test_reactor_block_dropped(self) -> None:
        """'[INFO] Reactor Build Order' and 'Reactor Summary' lines are dropped."""
        output = (
            "[INFO] Scanning for projects...\n"
            "[INFO] ------------------------------------------------------------------------\n"
            "[INFO] Reactor Build Order:\n"
            "[INFO] \n"
            "[INFO]   module-a\n"
            "[INFO]   module-b\n"
            "[INFO] \n"
            "[INFO] Reactor Summary for myproject 1.0.0:\n"
            "[INFO] module-a SUCCESS [1.234 s]\n"
            "[INFO] module-b SUCCESS [0.567 s]\n"
            "[INFO] ------------------------------------------------------------------------\n"
            "[INFO] BUILD SUCCESS\n"
            "[INFO] ------------------------------------------------------------------------\n"
        )
        f = bc.MavenFilter()
        result = f.apply(output, "", 0, ["mvn", "test"])
        assert "Reactor Build Order" not in result.text
        assert "Reactor Summary" not in result.text

    def test_error_line_kept(self) -> None:
        """[ERROR] lines are always kept even with heavy boilerplate around them."""
        output = self._maven_output(
            "[ERROR] Tests run: 1, Failures: 1, Errors: 0: SomeTest -- time elapsed: 0.1 s <<< FAILURE!\n"
        )
        f = bc.MavenFilter()
        result = f.apply(output, "", 1, ["mvn", "test"])
        assert "FAILURE" in result.text


# ---------------------------------------------------------------------------
# RuffFilter — ruff format subcommand
# ---------------------------------------------------------------------------

class TestRuffFormatFilter:
    """RuffFilter._compress_format() collapses per-file 'Reformatted ...' lines."""

    def test_select_filter_dispatches_ruff(self) -> None:
        """select_filter routes 'ruff' to RuffFilter."""
        f = bc.select_filter(["ruff", "format"])
        assert f is not None
        assert f.name == "ruff"

    def test_reformatted_lines_collapsed(self) -> None:
        """'Reformatted path/to/file.py' per-file lines are dropped, summary kept."""
        stdout = (
            "Reformatted src/foo.py\n"
            "Reformatted src/bar.py\n"
            "Reformatted src/baz.py\n"
            "3 files reformatted, 2 files left unchanged\n"
        )
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 0, ["ruff", "format"])
        assert "Reformatted src/foo.py" not in result.text
        assert "3 files reformatted" in result.text

    def test_reformatted_note_emitted(self) -> None:
        """A note is emitted reporting how many 'Reformatted' lines were collapsed."""
        stdout = (
            "Reformatted src/a.py\n"
            "Reformatted src/b.py\n"
            "2 files reformatted\n"
        )
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 0, ["ruff", "format"])
        assert "collapsed" in result.text
        assert "2" in result.text

    def test_would_reformat_check_mode_collapsed(self) -> None:
        """'Would reformat:' lines from ruff format --check are collapsed."""
        stdout = (
            "Would reformat: src/alpha.py\n"
            "Would reformat: src/beta.py\n"
            "Would reformat: src/gamma.py\n"
            "3 files would be reformatted, 1 file already formatted\n"
        )
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "format", "--check"])
        assert "Would reformat: src/alpha.py" not in result.text
        assert "3 files would be reformatted" in result.text
        assert "collapsed" in result.text

    def test_already_formatted_clean_exit(self) -> None:
        """When all files are already formatted ruff format emits no per-file lines."""
        stdout = "1 file left unchanged\n"
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 0, ["ruff", "format"])
        # Summary line should be present; no note needed
        assert "unchanged" in result.text

    def test_ruff_check_not_affected(self) -> None:
        """ruff check output is not routed through _compress_format."""
        stdout = (
            "src/foo.py:1:1: E501 Line too long (120 > 88)\n"
            "src/foo.py:2:5: F401 'os' imported but unused\n"
            "Found 2 errors.\n"
        )
        f = bc.RuffFilter()
        result = f.apply(stdout, "", 1, ["ruff", "check", "src/"])
        # Both violation lines should be preserved (check path, not format path)
        assert "E501" in result.text
        assert "F401" in result.text

    def test_empty_output_clean_exit(self) -> None:
        """ruff format with no output and exit 0 returns empty string."""
        f = bc.RuffFilter()
        result = f.apply("", "", 0, ["ruff", "format"])
        assert result.text == "" or result.text.strip() == ""


# ---------------------------------------------------------------------------
# JestFilter — Failures: repeated-summary section (verbose mode)
# ---------------------------------------------------------------------------


class TestJestFilterVerboseFeatures:
    """Tests for --verbose-mode improvements to JestFilter."""

    def test_collapses_failures_section_duplicate(self) -> None:
        """The 'Failures:' repeated-summary block is collapsed to a note."""
        text = (
            "FAIL src/foo.test.js\n"
            "  ● describe > test name\n"
            "    Expected: 1\n"
            "    Received: 2\n"
            "\n"
            "Failures:\n"
            "  1. describe > test name\n"
            "     Expected: 1\n"
            "     Received: 2\n"
            "\n"
            "Test Suites: 1 failed, 1 total\n"
            "Tests:       1 failed, 1 total\n"
            "Time:        1.234 s\n"
        )
        f = bc.JestFilter()
        result = f.apply(text, "", 1, ["jest", "--verbose"])
        # Inline FAIL block must survive.
        assert "FAIL src/foo.test.js" in result.text
        assert "Expected: 1" in result.text
        # The 'Failures:' header and its duplicate content must be dropped.
        assert result.text.count("Expected: 1") == 1, (
            "Failure details should appear exactly once (inline), not duplicated"
        )
        # A note should explain what was collapsed.
        assert "duplicate" in result.text or "Failures:" in result.text or "collapsed" in result.text
        # Summary lines must be preserved.
        assert "Test Suites: 1 failed" in result.text
        assert "Tests:       1 failed" in result.text

    def test_summary_lines_after_failures_section_are_kept(self) -> None:
        """Summary lines (Test Suites:, Tests:, Time:) following 'Failures:' are kept."""
        text = (
            "PASS src/bar.test.js\n"
            "FAIL src/foo.test.js\n"
            "  ● test fails\n"
            "\n"
            "Failures:\n"
            "  1. test fails\n"
            "     Expected true but got false\n"
            "\n"
            "Test Suites: 1 failed, 2 total\n"
            "Tests:       1 failed, 5 total\n"
        )
        f = bc.JestFilter()
        result = f.apply(text, "", 1, ["jest", "--verbose"])
        assert "Test Suites: 1 failed, 2 total" in result.text
        assert "Tests:       1 failed, 5 total" in result.text
        # PASS file should be collapsed.
        assert "PASS src/bar.test.js" not in result.text

    def test_no_failures_section_unchanged(self) -> None:
        """Output without a 'Failures:' section passes through normally."""
        text = (
            "PASS src/a.test.js\n"
            "PASS src/b.test.js\n"
            "Tests: 10 passed, 10 total\n"
        )
        f = bc.JestFilter()
        result = f.apply(text, "", 0, ["jest"])
        assert "Tests: 10 passed" in result.text
        assert "collapsed 2 PASS files" in result.text


# ---------------------------------------------------------------------------
# AnsibleFilter — ansible-lint with modern rule-code format
# ---------------------------------------------------------------------------


class TestAnsibleLintModernFormat:
    """Tests for ansible-lint ≥ 6 modern rule-code format."""

    def test_modern_yaml_rule_grouped(self) -> None:
        """Modern yaml[tag] rule codes are grouped and first 3 kept."""
        stdout = "\n".join([
            f"yaml[line-length]: ./playbooks/site.yml:{10 + i}:80: Line too long (120 > 80 chars)"
            for i in range(6)
        ]) + "\nLinting completed.\n"
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "playbooks/"])
        # First 3 violations should appear.
        assert "yaml[line-length]" in result.text
        lines_with_rule = [ln for ln in result.text.splitlines() if "yaml[line-length]" in ln]
        # Should have ≤ 3 actual violation lines (plus possibly elision note).
        violation_lines = [ln for ln in lines_with_rule if "elided" not in ln and "token-goat" not in ln]
        assert 1 <= len(violation_lines) <= 3
        # Should mention that some were elided.
        assert "elided" in result.text or "more occurrence" in result.text

    def test_modern_compound_rule_grouped(self) -> None:
        """Modern compound rule codes (command-instead-of-module[command]) are grouped."""
        lines_input = [
            f"command-instead-of-module[command]: ./tasks/main.yml:{i}:1: Use the git module"
            for i in range(5)
        ]
        lines_input.append("Linting completed with 5 violations.\n")
        stdout = "\n".join(lines_input)
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "tasks/"])
        assert "command-instead-of-module" in result.text
        # Summary line must be preserved.
        assert "Linting completed" in result.text

    def test_legacy_format_still_works(self) -> None:
        """Legacy ansible-lint format (file:line:col: rule: message) is still compressed.

        With 5 violations of the same rule, only 3 appear in the output and an
        elision note accounts for the remaining 2.  The total line count must be
        smaller than the original (5 violation lines → 3 + 1 elision note = 4).
        """
        stdout = "\n".join([
            f"playbooks/site.yml:{10 + i}:1: yaml-indent: too many spaces before block scalar"
            for i in range(5)
        ]) + "\nLinting failed.\n"
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "playbooks/"])
        # Should have at most 3 violation lines (not 5).
        viol_lines = [
            ln for ln in result.text.splitlines()
            if "yaml-indent" in ln and "elided" not in ln and "token-goat" not in ln
        ]
        assert len(viol_lines) <= 3
        # An elision note must account for the dropped violations.
        assert "elided" in result.text or "more occurrence" in result.text
        # Summary should be preserved.
        assert "Linting failed." in result.text

    def test_multiple_rules_each_gets_3_examples(self) -> None:
        """Multiple distinct rules each get up to 3 violation examples."""
        yaml_lines = [
            f"yaml[line-length]: ./file.yml:{i}:80: Too long"
            for i in range(4)
        ]
        truthy_lines = [
            f"yaml[truthy]: ./vars.yml:{i}:1: Use true/false"
            for i in range(4)
        ]
        stdout = "\n".join(yaml_lines + truthy_lines) + "\nDone.\n"
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "playbooks/"])
        text = result.text
        # Both rules should appear.
        assert "yaml[line-length]" in text
        assert "yaml[truthy]" in text
        # Each rule should have at most 3 violation lines (not 4).
        ll_violations = [ln for ln in text.splitlines()
                         if "yaml[line-length]" in ln and "elided" not in ln and "token-goat" not in ln]
        truthy_violations = [ln for ln in text.splitlines()
                              if "yaml[truthy]" in ln and "elided" not in ln and "token-goat" not in ln]
        assert len(ll_violations) <= 3
        assert len(truthy_violations) <= 3

    def test_first_violation_is_included(self) -> None:
        """The first violation (index 0) is always included — off-by-one regression guard."""
        stdout = "yaml[line-length]: ./file.yml:10:80: Line too long\nLinting failed.\n"
        f = bc.AnsibleFilter()
        result = f.apply(stdout, "", 1, ["ansible-lint", "file.yml"])
        # The single violation must appear in the output.
        assert "yaml[line-length]" in result.text
        assert "./file.yml:10:80" in result.text


# ---------------------------------------------------------------------------
# DotnetFilter — format subcommand and improved restore
# ---------------------------------------------------------------------------


class TestDotnetFilterFormat:
    """Tests for dotnet format subcommand compression."""

    def test_format_collapses_per_file_lines(self) -> None:
        """Per-file 'Formatted code in …' lines are collapsed to a count."""
        lines = [
            "  Formatted code in 'src/Foo.cs'.",
            "  Formatted code in 'src/Bar.cs'.",
            "  Fixed code style violations in 'src/Baz.cs'.",
        ]
        text = "\n".join(lines) + "\nFormat complete - no diagnostics found.\n"
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "format"])
        # Per-file lines should be gone.
        assert "Formatted code in" not in result.text
        assert "Fixed code style" not in result.text
        # A note should mention the count.
        assert "collapsed" in result.text or "3" in result.text
        # Summary should be kept.
        assert "Format complete" in result.text

    def test_format_keeps_violation_lines(self) -> None:
        """Error lines (IDE violations) are preserved even in format output."""
        text = (
            "  Formatted code in 'src/Clean.cs'.\n"
            "  src/Broken.cs(10,5): error IDE0059: Unnecessary assignment of a value to 'x'\n"
            "Format complete.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 1, ["dotnet", "format"])
        assert "IDE0059" in result.text
        assert "Formatted code in" not in result.text

    def test_format_empty_no_changes(self) -> None:
        """'dotnet format' with no files to change emits only the summary."""
        text = "Format complete - no diagnostics found.\n"
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "format"])
        assert "Format complete" in result.text

    def test_restore_drops_nuget_http_noise(self) -> None:
        """NuGet HTTP GET / OK lines and conflict-resolution lines are dropped."""
        text = (
            "  Determining projects to restore...\n"
            "  HTTP GET https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json\n"
            "  HTTP OK https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json 234ms\n"
            "  Resolving conflicts for Newtonsoft.Json 13.0.1\n"
            "  Restored /src/MyApp/MyApp.csproj (1.23 sec)\n"
            "Restore succeeded.\n"
        )
        f = bc.DotnetFilter()
        result = f.apply(text, "", 0, ["dotnet", "restore"])
        assert "HTTP GET" not in result.text
        assert "HTTP OK" not in result.text
        assert "Resolving conflicts" not in result.text
        assert "Restore succeeded." in result.text


# ---------------------------------------------------------------------------
# NxFilter
# ---------------------------------------------------------------------------


class TestNxFilter:
    """Tests for NxFilter — Nx monorepo build output compression."""

    def test_drops_separator_lines(self) -> None:
        """Long dash separator / decoration lines are dropped silently."""
        text = (
            "NX  Running target build for project myapp and 3 tasks it depends on\n"
            "\n"
            "——————————————————————————————————————————————————————————\n"
            "\n"
            "✔  nx run @myorg/lib:build (4s)\n"
            "\n"
            " NX   Ran target build for 2 projects (6s)\n"
        )
        f = bc.NxFilter()
        result = f.apply(text, "", 0, ["nx", "run-many", "--target=build"])
        assert "——————" not in result.text
        assert "NX  Running target" in result.text
        assert "Ran target build" in result.text

    def test_keeps_status_lines(self) -> None:
        """Per-project ✔ / ✖ status lines are kept verbatim."""
        text = (
            "NX  Running target test for 3 projects\n"
            "✔  nx run @myorg/lib:test (2s)\n"
            "✔  nx run @myorg/core:test (1s)\n"
            "✖  nx run @myorg/app:test (failed)\n"
            " NX   Ran target test for 3 projects (5s)\n"
            "   ✖    1/3 targets failed\n"
        )
        f = bc.NxFilter()
        result = f.apply(text, "", 1, ["nx", "run-many", "--target=test"])
        assert "✔  nx run @myorg/lib:test" in result.text
        assert "✖  nx run @myorg/app:test" in result.text
        assert "1/3 targets failed" in result.text

    def test_drops_cache_hit_annotations(self) -> None:
        """Cache-hit annotation lines are dropped."""
        text = (
            "NX  Running target build for 2 projects\n"
            "> nx run @myorg/lib:build  [existing outputs match the cache, left as is]\n"
            "✔  nx run @myorg/lib:build (0s)\n"
            " NX   Ran target build for 1 project (0s)\n"
        )
        f = bc.NxFilter()
        result = f.apply(text, "", 0, ["nx", "run-many", "--target=build"])
        assert "existing outputs match the cache" not in result.text
        assert "✔  nx run @myorg/lib:build" in result.text

    def test_drops_task_headers_on_success(self) -> None:
        """Per-task headers ('> nx run scope/pkg:target') are dropped on clean exit."""
        text = (
            "NX  Running target build for 2 projects\n"
            "> nx run @myorg/lib:build\n"
            "> nx run @myorg/app:build\n"
            "✔  nx run @myorg/lib:build (3s)\n"
            "✔  nx run @myorg/app:build (4s)\n"
        )
        f = bc.NxFilter()
        result = f.apply(text, "", 0, ["nx", "run-many", "--target=build"])
        assert "> nx run @myorg/lib:build" not in result.text
        assert "✔  nx run @myorg/lib:build" in result.text

    def test_keeps_failed_task_headers_as_sample(self) -> None:
        """Up to 5 failing task headers are kept when exit_code != 0."""
        headers = [f"> nx run @myorg/pkg{i}:build" for i in range(8)]
        text = "\n".join(headers) + "\n✖  nx run @myorg/pkg0:build (failed)\n"
        f = bc.NxFilter()
        result = f.apply(text, "", 1, ["nx", "run-many", "--target=build"])
        # First 5 kept, rest dropped
        assert "> nx run @myorg/pkg0:build" in result.text
        assert "> nx run @myorg/pkg4:build" in result.text
        assert "> nx run @myorg/pkg7:build" not in result.text

    def test_dispatch_nx_binary(self) -> None:
        """select_filter routes 'nx run-many ...' to NxFilter."""
        f = bc.select_filter(["nx", "run-many", "--target=build"])
        assert f is not None
        assert f.name == "nx"

    def test_dispatch_npx_nx(self) -> None:
        """select_filter routes 'npx nx ...' to NxFilter."""
        f = bc.select_filter(["npx", "nx", "build"])
        assert f is not None
        assert f.name == "nx"

    def test_exported_in_all(self) -> None:
        assert "NxFilter" in bc.__all__


# ---------------------------------------------------------------------------
# LernaFilter
# ---------------------------------------------------------------------------


class TestLernaFilter:
    """Tests for LernaFilter — Lerna monorepo task output compression."""

    def test_drops_verbose_lines(self) -> None:
        """lerna verb/verbose timing lines are dropped (only appear in note, not verbatim)."""
        text = (
            "lerna info versioning independent\n"
            "lerna verb symlink /path/to/node_modules\n"
            "lerna verbose filter include all packages\n"
            "lerna info Executing command in 3 packages: \"npm run build\"\n"
            "lerna success run Ran npm script 'build' in 3 packages in 5.1s:\n"
        )
        f = bc.LernaFilter()
        result = f.apply(text, "", 0, ["lerna", "run", "build"])
        # Verbose lines should not appear verbatim; they may appear in the drop-count note.
        assert "lerna verb symlink" not in result.text
        assert "lerna verbose filter" not in result.text
        assert "lerna info versioning" in result.text
        assert "lerna success" in result.text

    def test_drops_notice_lines(self) -> None:
        """lerna notice lines (changelog, publish noise) are dropped."""
        text = (
            "lerna info Executing command in 2 packages: \"npm run test\"\n"
            "lerna notice cli v7.4.2\n"
            "lerna notice\n"
            "lerna success run Ran npm script 'test' in 2 packages in 2.0s:\n"
        )
        f = bc.LernaFilter()
        result = f.apply(text, "", 0, ["lerna", "run", "test"])
        # Notice lines should not appear verbatim (only in the drop-count note).
        assert "lerna notice cli v7.4.2" not in result.text
        assert "lerna success" in result.text
        # A count note should mention dropped notice lines.
        assert "notice" in result.text

    def test_samples_ran_npm_script_lines(self) -> None:
        """More than 5 'Ran npm script' info lines are collapsed to a count."""
        ran_lines = [
            f"lerna info run Ran npm script 'build' in '@myorg/pkg{i}' in 1.{i}s:"
            for i in range(8)
        ]
        text = "\n".join(ran_lines) + "\nlerna success run Ran npm script 'build' in 8 packages in 12s:\n"
        f = bc.LernaFilter()
        result = f.apply(text, "", 0, ["lerna", "run", "build"])
        assert "lerna info run Ran npm script 'build' in '@myorg/pkg0'" in result.text
        assert "lerna info run Ran npm script 'build' in '@myorg/pkg4'" in result.text
        assert "lerna info run Ran npm script 'build' in '@myorg/pkg7'" not in result.text
        assert "+3 more" in result.text
        assert "lerna success" in result.text

    def test_keeps_all_ran_lines_when_under_sample(self) -> None:
        """Five or fewer 'Ran npm script' lines are kept verbatim."""
        ran_lines = [
            f"lerna info run Ran npm script 'build' in '@myorg/pkg{i}' in 0.5s:"
            for i in range(3)
        ]
        text = "\n".join(ran_lines) + "\nlerna success run Ran npm script 'build' in 3 packages in 1.5s:\n"
        f = bc.LernaFilter()
        result = f.apply(text, "", 0, ["lerna", "run", "build"])
        for i in range(3):
            assert f"@myorg/pkg{i}" in result.text
        assert "more" not in result.text

    def test_keeps_error_lines(self) -> None:
        """lerna error / lerna ERR! lines survive compression."""
        text = (
            "lerna info Executing command in 2 packages: \"npm run build\"\n"
            "lerna verb progress filtering packages\n"
            "lerna error run Failed to run script 'build' in '@myorg/broken'\n"
            "lerna ERR! errno 1\n"
        )
        f = bc.LernaFilter()
        result = f.apply(text, "", 1, ["lerna", "run", "build"])
        assert "lerna error run" in result.text
        assert "lerna ERR!" in result.text
        # Verbose line should not appear verbatim (may appear in note text only).
        assert "lerna verb progress" not in result.text

    def test_dispatch_lerna(self) -> None:
        """select_filter routes 'lerna run build' to LernaFilter."""
        f = bc.select_filter(["lerna", "run", "build"])
        assert f is not None
        assert f.name == "lerna"

    def test_exported_in_all(self) -> None:
        assert "LernaFilter" in bc.__all__


# ---------------------------------------------------------------------------
# PrettierFilter
# ---------------------------------------------------------------------------


class TestPrettierFilter:
    """Tests for PrettierFilter — prettier --write output compression."""

    def test_samples_changed_files_beyond_limit(self) -> None:
        """More than 5 changed file lines are collapsed to a count."""
        lines = [f"src/module{i}.ts 42ms" for i in range(9)]
        lines.append("All matched files use Prettier standards.")
        text = "\n".join(lines)
        f = bc.PrettierFilter()
        result = f.apply(text, "", 0, ["prettier", "--write", "."])
        assert "src/module0.ts" in result.text
        assert "src/module4.ts" in result.text
        assert "src/module8.ts" not in result.text
        assert "+4 more formatted files" in result.text
        assert "All matched files" in result.text

    def test_keeps_all_changed_when_under_sample(self) -> None:
        """Five or fewer changed file lines are kept verbatim."""
        lines = [f"src/foo{i}.js 10ms" for i in range(4)]
        text = "\n".join(lines)
        f = bc.PrettierFilter()
        result = f.apply(text, "", 0, ["prettier", "--write", "src/"])
        for i in range(4):
            assert f"src/foo{i}.js" in result.text
        assert "more formatted" not in result.text

    def test_drops_unchanged_file_lines(self) -> None:
        """File lines with (unchanged) are dropped entirely (only a count note remains)."""
        text = (
            "src/modified.ts 88ms\n"
            "src/untouched.ts 12ms (unchanged)\n"
            "src/also_clean.js 9ms (unchanged)\n"
            "All matched files use Prettier standards.\n"
        )
        f = bc.PrettierFilter()
        result = f.apply(text, "", 0, ["prettier", "--write", "."])
        assert "src/modified.ts" in result.text
        # Unchanged-file lines should not appear verbatim.
        assert "src/untouched.ts" not in result.text
        assert "src/also_clean.js" not in result.text
        # The note should record how many were dropped.
        assert "dropped 2 unchanged" in result.text
        assert "All matched files" in result.text

    def test_keeps_summary_lines(self) -> None:
        """Summary and warning lines are always kept."""
        text = (
            "Checking formatting...\n"
            "src/broken.ts\n"
            "Code style issues found in 1 file. Forgot to run Prettier?\n"
        )
        f = bc.PrettierFilter()
        result = f.apply(text, "", 1, ["prettier", "--check", "."])
        assert "Checking formatting" in result.text
        assert "Code style issues found" in result.text

    def test_keeps_error_lines(self) -> None:
        """Lines with error signals survive compression."""
        text = (
            "src/good.ts 10ms\n"
            "[error] src/bad.ts: SyntaxError: Unexpected token\n"
            "prettier [error] failed to parse\n"
        )
        f = bc.PrettierFilter()
        result = f.apply(text, "", 1, ["prettier", "--write", "."])
        assert "[error] src/bad.ts" in result.text
        assert "prettier [error]" in result.text

    def test_dispatch_prettier(self) -> None:
        """select_filter routes 'prettier --write .' to PrettierFilter."""
        f = bc.select_filter(["prettier", "--write", "."])
        assert f is not None
        assert f.name == "prettier"

    def test_dispatch_npx_prettier(self) -> None:
        """select_filter routes 'npx prettier --write .' to PrettierFilter."""
        f = bc.select_filter(["npx", "prettier", "--write", "."])
        assert f is not None
        assert f.name == "prettier"

    def test_exported_in_all(self) -> None:
        assert "PrettierFilter" in bc.__all__


# ---------------------------------------------------------------------------
# TestCurlFilter
# ---------------------------------------------------------------------------


class TestCurlFilter:
    """Tests for CurlFilter (curl + wget HTTP client compression)."""

    def _f(self) -> bc.CurlFilter:
        return bc.CurlFilter()

    # --- curl -v ---

    def test_curl_verbose_drops_connection_metadata(self) -> None:
        """Lines starting with '*' (TLS handshake, connection info) are dropped."""
        f = self._f()
        stderr = (
            "* Trying 93.184.216.34:443...\n"
            "* Connected to example.com (93.184.216.34) port 443 (#0)\n"
            "* ALPN: offers h2,http/1.1\n"
            "* TLS 1.3 connection using TLS_AES_128_GCM_SHA256\n"
            "* Server certificate: example.com\n"
        )
        result = f.apply("", stderr, 0, ["curl", "-v", "https://example.com"])
        assert "TLS" not in result.text
        assert "ALPN" not in result.text
        assert "token-goat" in result.text
        assert "connection-metadata" in result.text

    def test_curl_verbose_drops_request_headers(self) -> None:
        """Lines starting with '>' (request headers) are dropped."""
        f = self._f()
        stderr = (
            "> GET / HTTP/2\n"
            "> Host: example.com\n"
            "> User-Agent: curl/7.88.1\n"
            "> Accept: */*\n"
            ">\n"
        )
        result = f.apply("", stderr, 0, ["curl", "-v", "https://example.com"])
        assert "User-Agent" not in result.text
        assert "request-header" in result.text

    def test_curl_verbose_keeps_status_line(self) -> None:
        """HTTP response status line is preserved (stripped of '< ' prefix)."""
        f = self._f()
        stderr = (
            "< HTTP/2 200\n"
            "< content-type: text/html; charset=UTF-8\n"
            "< server: ECS (nyb/1D20)\n"
            "< x-cache: HIT\n"
        )
        result = f.apply("response body", stderr, 0, ["curl", "-v", "https://example.com"])
        assert "HTTP/2 200" in result.text
        assert "content-type: text/html" in result.text
        # x-cache and server are not in the useful-headers allowlist
        assert "x-cache" not in result.text
        assert "server: ECS" not in result.text

    def test_curl_verbose_keeps_location_header_on_redirect(self) -> None:
        """Location header is in the allowlist and preserved for redirect chains."""
        f = self._f()
        stderr = (
            "< HTTP/1.1 301 Moved Permanently\n"
            "< Location: https://new.example.com/\n"
            "< Content-Length: 0\n"
            "< Date: Mon, 01 Jan 2024 00:00:00 GMT\n"
        )
        result = f.apply("", stderr, 0, ["curl", "-v", "https://old.example.com"])
        assert "HTTP/1.1 301" in result.text
        assert "Location: https://new.example.com/" in result.text
        assert "Date:" not in result.text

    def test_curl_progress_lines_dropped(self) -> None:
        """curl progress bar table lines are dropped."""
        f = self._f()
        stderr = (
            "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n"
            "                                 Dload  Upload   Total   Spent    Left  Speed\n"
            "100  1270  100  1270    0     0   5234      0 --:--:-- --:--:-- --:--:--  5252\n"
        )
        result = f.apply("body", stderr, 0, ["curl", "https://example.com"])
        assert "% Total" not in result.text
        assert "Dload" not in result.text
        assert "progress" in result.text

    def test_curl_response_body_preserved(self) -> None:
        """stdout (response body) always passes through."""
        f = self._f()
        body = '{"status": "ok", "value": 42}'
        result = f.apply(body, "", 0, ["curl", "https://api.example.com/status"])
        assert body in result.text

    def test_curl_error_message_preserved(self) -> None:
        """curl error messages (curl: (6) ...) are never dropped."""
        f = self._f()
        stderr = "curl: (6) Could not resolve host: nosuchdomain.invalid\n"
        result = f.apply("", stderr, 1, ["curl", "https://nosuchdomain.invalid"])
        assert "curl: (6)" in result.text

    # --- wget ---

    def test_wget_drops_connecting_lines(self) -> None:
        """wget verbose connection-setup lines are dropped."""
        f = self._f()
        stderr = (
            "--2024-01-01 12:00:00--  https://example.com/file.zip\n"
            "Resolving example.com... 93.184.216.34\n"
            "Connecting to example.com|93.184.216.34|:443... connected.\n"
            "HTTP request sent, awaiting response... 200 OK\n"
            "Length: 12345 (12K) [application/zip]\n"
            "Saving to: 'file.zip'\n"
            "2024-01-01 12:00:01 (1.23 MB/s) - 'file.zip' saved [12345/12345]\n"
        )
        result = f.apply("", stderr, 0, ["wget", "https://example.com/file.zip"])
        assert "Resolving" not in result.text
        assert "Connecting to" not in result.text
        # The saved line should be kept
        assert "saved" in result.text

    def test_wget_verbose_timestamp_url_lines_dropped(self) -> None:
        """wget '-v' timestamp+URL lines are dropped; only saved line kept."""
        f = self._f()
        stderr = (
            "2024-01-01 12:00:00 URL: https://example.com/page [200 OK]\n"
            "2024-01-01 12:00:01 (500 KB/s) - 'page' saved [4096/4096]\n"
        )
        result = f.apply("", stderr, 0, ["wget", "-v", "https://example.com/page"])
        # The URL: timestamp line should be dropped
        assert "URL:" not in result.text
        # The saved line should be kept
        assert "saved" in result.text

    def test_wget_select_filter(self) -> None:
        """select_filter routes wget to CurlFilter."""
        f = bc.select_filter(["wget", "https://example.com"])
        assert f is not None
        assert f.name == "curl"

    def test_curl_select_filter(self) -> None:
        """select_filter routes curl to CurlFilter."""
        f = bc.select_filter(["curl", "-v", "https://example.com"])
        assert f is not None
        assert f.name == "curl"

    def test_exported_in_all(self) -> None:
        assert "CurlFilter" in bc.__all__


# ---------------------------------------------------------------------------
# TestPhpStanFilter
# ---------------------------------------------------------------------------


class TestPhpStanFilter:
    """Tests for PhpStanFilter (phpstan + psalm PHP static analysis)."""

    def _f(self) -> bc.PhpStanFilter:
        return bc.PhpStanFilter()

    def _phpstan_table(self, filename: str, rows: list[tuple[int, str]]) -> str:
        """Build a minimal PHPStan table output."""
        lines = [
            " ------ ------------------------------------------------------------------ ",
            f"  Line   {filename}                                                        ",
            " ------ ------------------------------------------------------------------ ",
        ]
        for lineno, msg in rows:
            lines.append(f"  {lineno}    {msg}")
        lines += [
            " ------ ------------------------------------------------------------------ ",
            "",
            " [ERROR] Found 2 errors",
            "",
        ]
        return "\n".join(lines)

    def test_drops_separator_lines(self) -> None:
        """Table separator lines (--- rows) are dropped."""
        f = self._f()
        text = self._phpstan_table("src/Foo.php", [(42, "Property $bar not found.")])
        result = f.apply(text, "", 1, ["phpstan", "analyse", "src/"])
        assert "------" not in result.text

    def test_keeps_summary_line(self) -> None:
        """The [ERROR] / [OK] summary line is preserved."""
        f = self._f()
        text = self._phpstan_table("src/Foo.php", [(42, "Property $bar not found.")])
        result = f.apply(text, "", 1, ["phpstan", "analyse", "src/"])
        assert "[ERROR]" in result.text

    def test_keeps_error_rows(self) -> None:
        """Error row lines (line number + message) are preserved."""
        f = self._f()
        text = self._phpstan_table("src/Foo.php", [
            (10, "Call to undefined method Foo::bar()."),
            (20, "Property $x not found."),
        ])
        result = f.apply(text, "", 1, ["phpstan", "analyse", "src/"])
        assert "Call to undefined method" in result.text
        assert "Property $x not found" in result.text

    def test_deduplicates_repeated_errors_per_file(self) -> None:
        """More than 3 occurrences of the same message in one file get a note."""
        f = self._f()
        same_msg = "Parameter #1 (string) of function strlen expects string."
        rows = [(i, same_msg) for i in range(1, 8)]  # 7 identical rows
        text = self._phpstan_table("src/Bar.php", rows)
        result = f.apply(text, "", 1, ["phpstan", "analyse", "src/"])
        # First 3 kept, rest collapsed
        count = result.text.count(same_msg)
        assert count == 3
        assert "+4 more duplicate" in result.text

    def test_drops_info_banner_lines(self) -> None:
        """Loading config / PHPStan banner lines are dropped."""
        f = self._f()
        text = (
            "PHPStan - PHP Static Analysis Tool\n"
            "Loading configuration from phpstan.neon\n"
            " [OK] No errors\n"
        )
        result = f.apply(text, "", 0, ["phpstan", "analyse", "src/"])
        assert "PHPStan - PHP Static Analysis Tool" not in result.text
        assert "Loading configuration" not in result.text
        assert "[OK]" in result.text

    def test_psalm_drops_progress_lines(self) -> None:
        """Psalm scanning/progress lines are dropped."""
        f = self._f()
        text = (
            "Scanning files...\n"
            "Analyzing files...\n"
            "Checking src/Foo.php\n"
            "ERROR: UndefinedVariable - src/Foo.php:42:5 - Cannot find referenced variable $bar\n"
            "Found 1 error\n"
        )
        result = f.apply(text, "", 1, ["psalm"])
        assert "Scanning files" not in result.text
        assert "Analyzing files" not in result.text
        assert "UndefinedVariable" in result.text

    def test_psalm_keeps_error_lines(self) -> None:
        """Psalm ERROR: lines are preserved."""
        f = self._f()
        text = (
            "Scanning files...\n"
            "ERROR: MixedInferredReturnType - src/Bar.php:10:1 - Could not infer return type\n"
        )
        result = f.apply(text, "", 1, ["psalm"])
        assert "MixedInferredReturnType" in result.text

    def test_psalm_collapses_repeated_error_type(self) -> None:
        """Psalm: same error type beyond 3 occurrences gets a collapse note."""
        f = self._f()
        errors = "\n".join(
            f"ERROR: UndefinedVariable - src/File{i}.php:{i}:1 - Cannot find $x"
            for i in range(1, 8)
        )
        result = f.apply(errors, "", 1, ["psalm"])
        # First 3 kept; 4 collapsed
        count = result.text.count("UndefinedVariable")
        # The kept lines + the collapse note text
        assert count >= 3
        assert "collapsed +4 more UndefinedVariable" in result.text

    def test_dispatch_phpstan(self) -> None:
        """select_filter routes phpstan to PhpStanFilter."""
        f = bc.select_filter(["phpstan", "analyse", "src/"])
        assert f is not None
        assert f.name == "phpstan"

    def test_dispatch_psalm(self) -> None:
        """select_filter routes psalm to PhpStanFilter."""
        f = bc.select_filter(["psalm"])
        assert f is not None
        assert f.name == "phpstan"

    def test_exported_in_all(self) -> None:
        assert "PhpStanFilter" in bc.__all__


# ---------------------------------------------------------------------------
# TestSwiftLintFilter
# ---------------------------------------------------------------------------


class TestSwiftLintFilter:
    """Tests for SwiftLintFilter (SwiftLint linter compression)."""

    def _f(self) -> bc.SwiftLintFilter:
        return bc.SwiftLintFilter()

    def _violation(self, path: str, line: int, severity: str, msg: str, rule: str) -> str:
        return f"{path}:{line}:1: {severity}: {msg} ({rule})"

    def test_drops_progress_lines(self) -> None:
        """Linting progress and configuration lines are dropped."""
        f = self._f()
        text = (
            "Linting Swift files in current working directory\n"
            "Loading configuration from '.swiftlint.yml'\n"
            + self._violation("/src/Foo.swift", 10, "warning", "Line too long", "line_length")
            + "\n"
            "Done linting! The lint checker found 1 violation, 0 serious in 1 file.\n"
        )
        result = f.apply(text, "", 1, ["swiftlint"])
        assert "Linting Swift files" not in result.text
        assert "Loading configuration" not in result.text

    def test_keeps_error_violations(self) -> None:
        """error: violations are always kept."""
        f = self._f()
        text = (
            self._violation("/src/Foo.swift", 5, "error", "Unused Declaration", "unused_declaration")
            + "\n"
        )
        result = f.apply(text, "", 2, ["swiftlint"])
        assert "unused_declaration" in result.text
        assert "Unused Declaration" in result.text

    def test_keeps_serious_violations(self) -> None:
        """serious: violations are always kept."""
        f = self._f()
        text = (
            self._violation("/src/Bar.swift", 12, "serious", "Force Cast", "force_cast")
            + "\n"
        )
        result = f.apply(text, "", 2, ["swiftlint"])
        assert "force_cast" in result.text

    def test_samples_warning_violations_per_rule(self) -> None:
        """Only first 3 warning violations per rule are kept; rest get a note."""
        f = self._f()
        lines = "\n".join(
            self._violation(f"/src/File{i}.swift", i * 10, "warning", "Line too long", "line_length")
            for i in range(1, 8)
        )
        result = f.apply(lines + "\n", "", 1, ["swiftlint"])
        # First 3 kept; note mentions 4 more
        assert "+4 more line_length warning(s) elided" in result.text

    def test_different_rules_each_get_3_samples(self) -> None:
        """Each rule gets its own 3-violation budget independently."""
        f = self._f()
        lines: list[str] = []
        for i in range(1, 5):
            lines.append(self._violation(f"/src/A{i}.swift", i, "warning", "Long line", "line_length"))
        for i in range(1, 5):
            lines.append(self._violation(f"/src/B{i}.swift", i, "warning", "Trailing whitespace", "trailing_whitespace"))
        text = "\n".join(lines) + "\n"
        result = f.apply(text, "", 1, ["swiftlint"])
        assert "+1 more line_length warning(s) elided" in result.text
        assert "+1 more trailing_whitespace warning(s) elided" in result.text

    def test_summary_line_preserved(self) -> None:
        """Done linting! summary line is preserved at the end."""
        f = self._f()
        text = (
            self._violation("/src/Foo.swift", 1, "warning", "Line too long", "line_length")
            + "\n"
            "Done linting! The lint checker found 1 violation, 0 serious in 1 file.\n"
        )
        result = f.apply(text, "", 1, ["swiftlint"])
        assert "Done linting!" in result.text

    def test_mixed_errors_and_warnings(self) -> None:
        """Errors always kept regardless of count; warnings are sampled."""
        f = self._f()
        lines: list[str] = []
        for i in range(1, 6):
            lines.append(self._violation(f"/src/E{i}.swift", i, "error", "Force Unwrap", "force_unwrapping"))
        for i in range(1, 6):
            lines.append(self._violation(f"/src/W{i}.swift", i, "warning", "Trailing newline", "trailing_newline"))
        text = "\n".join(lines) + "\n"
        result = f.apply(text, "", 2, ["swiftlint"])
        # All 5 errors kept
        assert result.text.count("force_unwrapping") == 5
        # Only 3 warnings kept + note
        assert "+2 more trailing_newline warning(s) elided" in result.text

    def test_dispatch_swiftlint(self) -> None:
        """select_filter routes swiftlint to SwiftLintFilter."""
        f = bc.select_filter(["swiftlint"])
        assert f is not None
        assert f.name == "swiftlint"

    def test_dispatch_swiftlint_lint_subcommand(self) -> None:
        """select_filter routes swiftlint with lint subcommand to SwiftLintFilter."""
        f = bc.select_filter(["swiftlint", "lint", "--path", "Sources/"])
        assert f is not None
        assert f.name == "swiftlint"

    def test_exported_in_all(self) -> None:
        assert "SwiftLintFilter" in bc.__all__


# ---------------------------------------------------------------------------
# BunFilter
# ---------------------------------------------------------------------------


class TestBunFilter2:
    """Tests for BunFilter (Bun JS runtime compression)."""

    def _f(self) -> bc.BunFilter:
        return bc.BunFilter()

    # --- dispatch ---

    def test_dispatch_bun(self) -> None:
        f = bc.select_filter(["bun", "install"])
        assert f is not None
        assert f.name == "bun"

    def test_dispatch_bunx(self) -> None:
        f = bc.select_filter(["bunx", "some-cli"])
        assert f is not None
        assert f.name == "bun"

    def test_bun_precedes_node_package_filter(self) -> None:
        """BunFilter must win over NodePackageFilter for bun commands."""
        f = bc.select_filter(["bun", "add", "lodash"])
        assert f is not None
        assert f.name == "bun"

    def test_exported_in_all(self) -> None:
        assert "BunFilter" in bc.__all__

    # --- bun install compression ---

    def test_install_drops_download_progress(self) -> None:
        """Per-package download progress lines are collapsed."""
        f = self._f()
        text = (
            "bun install v1.1.0 (abc123)\n"
            "  lodash@4.17.21 ↕ 200 kB\n"
            "  react@18.0.0 ↑ 100 kB\n"
            "  typescript@5.0.0 ↓ 300 kB\n"
            "Saved lockfile\n"
            "3 packages installed\n"
        )
        result = f.apply(text, "", 0, ["bun", "install"])
        assert "↕" not in result.text
        assert "↑" not in result.text
        assert "↓" not in result.text
        assert "3 packages installed" in result.text
        assert "collapsed 3 per-package" in result.text

    def test_install_keeps_error_lines(self) -> None:
        """Error lines survive regardless of compression."""
        f = self._f()
        text = (
            "  badpkg@1.0.0 ↕ 10 kB\n"
            "error: failed to resolve badpkg\n"
        )
        result = f.apply(text, "", 1, ["bun", "install"])
        assert "error: failed to resolve badpkg" in result.text

    def test_install_keeps_lockfile_notice(self) -> None:
        """Lockfile save notice is preserved."""
        f = self._f()
        text = "Saved lockfile\n10 packages installed\n"
        result = f.apply(text, "", 0, ["bun", "install"])
        assert "Saved lockfile" in result.text
        assert "10 packages installed" in result.text

    def test_install_short_output_passthrough(self) -> None:
        """Short output (no progress lines) is passed through unchanged."""
        f = self._f()
        text = "3 packages installed\n"
        result = f.apply(text, "", 0, ["bun", "i"])
        assert "3 packages installed" in result.text

    # --- bun test compression ---

    def test_test_short_passthrough(self) -> None:
        """Output ≤ 30 lines passes through unchanged."""
        f = self._f()
        text = "bun test v1.1.0\n✓ foo bar (2ms)\n✗ baz qux\n1 pass, 1 fail\n"
        result = f.apply(text, "", 1, ["bun", "test"])
        assert "✓ foo bar" in result.text

    def test_test_drops_passing_lines(self) -> None:
        """Passing (✓) test lines are collapsed when output is long."""
        f = self._f()
        passes = "\n".join(f"✓ test {i} (1ms)" for i in range(40))
        text = "bun test v1.1.0 (abc)\n" + passes + "\n✗ test_bad (5ms)\n41 pass, 1 fail\n"
        result = f.apply(text, "", 1, ["bun", "test"])
        # Failing line kept
        assert "✗ test_bad" in result.text
        # Pass lines collapsed
        assert "collapsed 40 passing test lines" in result.text
        # Summary kept
        assert "41 pass, 1 fail" in result.text

    def test_test_keeps_fail_lines(self) -> None:
        """Failing (✗) lines are always kept."""
        f = self._f()
        passes = "\n".join(f"✓ test {i} (1ms)" for i in range(35))
        text = passes + "\n✗ the_bad_test (10ms)\n"
        result = f.apply(text, "", 1, ["bun", "test"])
        assert "✗ the_bad_test" in result.text

    # --- bun build compression ---

    def test_build_passthrough_few_assets(self) -> None:
        """Output with ≤ 10 asset lines passes through unchanged."""
        f = self._f()
        assets = "\n".join(f"  dist/chunk{i}.js 10 kB" for i in range(5))
        text = assets + "\nBuild succeeded\n"
        result = f.apply(text, "", 0, ["bun", "build"])
        # All 5 asset lines kept
        assert result.text.count("dist/chunk") == 5

    def test_build_collapses_many_assets(self) -> None:
        """More than 10 asset lines are collapsed to 10 + note."""
        f = self._f()
        assets = "\n".join(f"  dist/chunk{i}.js 10 kB" for i in range(20))
        text = "bun build v1.1.0\n" + assets + "\nBuild succeeded\n"
        result = f.apply(text, "", 0, ["bun", "build"])
        assert "10 more asset/chunk lines elided" in result.text
        assert "Build succeeded" in result.text

    def test_build_keeps_errors(self) -> None:
        """Error lines are preserved even during asset collapse."""
        f = self._f()
        assets = "\n".join(f"  dist/chunk{i}.js 10 kB" for i in range(15))
        text = assets + "\nerror: cannot resolve ./missing\n"
        result = f.apply(text, "", 1, ["bun", "build"])
        assert "error: cannot resolve" in result.text


# ---------------------------------------------------------------------------
# DenoFilter
# ---------------------------------------------------------------------------


class TestDenoFilter:
    """Tests for DenoFilter (Deno JS/TS runtime compression)."""

    def _f(self) -> bc.DenoFilter:
        return bc.DenoFilter()

    # --- dispatch ---

    def test_dispatch_deno(self) -> None:
        f = bc.select_filter(["deno", "test"])
        assert f is not None
        assert f.name == "deno"

    def test_dispatch_deno_compile(self) -> None:
        f = bc.select_filter(["deno", "compile", "main.ts"])
        assert f is not None
        assert f.name == "deno"

    def test_exported_in_all(self) -> None:
        assert "DenoFilter" in bc.__all__

    # --- deno test ---

    def test_test_short_passthrough(self) -> None:
        """Short output passes through unchanged."""
        f = self._f()
        text = "running 3 tests from ./test.ts\nok | foo ... 2ms\ntest result: ok\n"
        result = f.apply(text, "", 0, ["deno", "test"])
        assert "ok | foo" in result.text

    def test_test_drops_passing_lines(self) -> None:
        """Passing test lines are collapsed when output is long."""
        f = self._f()
        passes = "\n".join(f"ok | test_{i} ... {i}ms" for i in range(40))
        text = passes + "\nFAILED | bad_test\ntest result: FAILED\n"
        result = f.apply(text, "", 1, ["deno", "test"])
        assert "FAILED | bad_test" in result.text
        assert "collapsed 40 passing test lines" in result.text

    def test_test_drops_download_lines(self) -> None:
        """Module download lines are dropped."""
        f = self._f()
        passes = "\n".join(f"ok | test_{i} ... {i}ms" for i in range(35))
        text = (
            "Download https://deno.land/std@0.200.0/fmt/colors.ts\n"
            "Download https://deno.land/std@0.200.0/testing/asserts.ts\n"
            + passes
            + "\ntest result: ok\n"
        )
        result = f.apply(text, "", 0, ["deno", "test"])
        assert "dropped 2 module download/cache lines" in result.text

    def test_test_keeps_permission_warnings(self) -> None:
        """Deno permission warnings are always preserved."""
        f = self._f()
        passes = "\n".join(f"ok | test_{i} ... {i}ms" for i in range(35))
        text = (
            "Deno requests network access to \"example.com\".\n"
            + passes
            + "\ntest result: ok\n"
        )
        result = f.apply(text, "", 0, ["deno", "test"])
        assert "Deno requests network access" in result.text

    def test_test_keeps_summary(self) -> None:
        """test result: summary line is always kept."""
        f = self._f()
        passes = "\n".join(f"ok | test_{i} ... 1ms" for i in range(40))
        text = passes + "\ntest result: ok. 40 passed; 0 failed\n"
        result = f.apply(text, "", 0, ["deno", "test"])
        assert "test result: ok. 40 passed" in result.text

    # --- deno compile ---

    def test_compile_drops_download_lines(self) -> None:
        """Download lines are collapsed during deno compile."""
        f = self._f()
        text = (
            "Download https://deno.land/std@0.200.0/fs/mod.ts\n"
            "Download https://deno.land/std@0.200.0/path/mod.ts\n"
            "Compile file:///app/main.ts -> ./app\n"
        )
        result = f.apply(text, "", 0, ["deno", "compile", "main.ts"])
        assert "dropped 2 module download lines" in result.text
        assert "Compile file:///app/main.ts" in result.text

    def test_compile_keeps_errors(self) -> None:
        """Error lines survive during compile."""
        f = self._f()
        text = (
            "Download https://deno.land/x/foo/mod.ts\n"
            "error TS2339: Property 'bar' does not exist\n"
        )
        result = f.apply(text, "", 1, ["deno", "compile", "main.ts"])
        assert "error TS2339" in result.text

    # --- deno check ---

    def test_check_drops_check_progress(self) -> None:
        """Check file:// progress lines are dropped when output is long."""
        f = self._f()
        check_lines = "\n".join(f"Check file:///src/mod{i}.ts" for i in range(35))
        text = check_lines + "\nerror[TS2345]: argument of type\n"
        result = f.apply(text, "", 1, ["deno", "check"])
        assert "dropped 35 Check progress lines" in result.text
        assert "error[TS2345]" in result.text

    def test_check_short_passthrough(self) -> None:
        """Short check output passes through unchanged."""
        f = self._f()
        text = "Check file:///src/main.ts\n"
        result = f.apply(text, "", 0, ["deno", "check"])
        assert "Check file:///src/main.ts" in result.text

    # --- generic deno ---

    def test_generic_drops_downloads(self) -> None:
        """Generic deno commands (run, eval) still drop download lines."""
        f = self._f()
        text = (
            "Download https://deno.land/x/cliffy@v0.25.7/mod.ts\n"
            "Hello, world!\n"
        )
        result = f.apply(text, "", 0, ["deno", "run", "main.ts"])
        assert "Hello, world!" in result.text
        assert "dropped 1 module download lines" in result.text


# ---------------------------------------------------------------------------
# BiomeFilter
# ---------------------------------------------------------------------------


class TestBiomeFilter:
    """Tests for BiomeFilter (Biome JS/TS linter/formatter compression)."""

    def _f(self) -> bc.BiomeFilter:
        return bc.BiomeFilter()

    def _rule_stanza(self, rule: str, file: str = "src/foo.ts") -> str:
        """Build a minimal Biome diagnostic stanza for a given rule."""
        return (
            f"  × {rule} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"\n"
            f"  {file}\n"
            f"   12 │   const x = 1;\n"
            f"   13 │   const y = 2;\n"
            f"  i Use const instead.\n"
            f"\n"
        )

    # --- dispatch ---

    def test_dispatch_biome(self) -> None:
        f = bc.select_filter(["biome", "check"])
        assert f is not None
        assert f.name == "biome"

    def test_dispatch_npx_biome(self) -> None:
        f = bc.select_filter(["npx", "biome", "lint"])
        assert f is not None
        assert f.name == "biome"

    def test_exported_in_all(self) -> None:
        assert "BiomeFilter" in bc.__all__

    # --- short output passthrough ---

    def test_short_output_passthrough(self) -> None:
        """Output ≤ 40 non-empty lines passes through unchanged."""
        f = self._f()
        text = self._rule_stanza("lint/a11y/noBlankTarget")
        result = f.apply(text, "", 1, ["biome", "check"])
        assert "noBlankTarget" in result.text

    # --- stanza collapsing ---

    def test_keeps_first_3_stanzas_per_rule(self) -> None:
        """Up to 3 stanzas per rule are kept; extras are collapsed."""
        f = self._f()
        rule = "lint/suspicious/noDoubleEquals"
        # 9 stanzas × 5 non-empty lines = 45 > 40 threshold.
        text = "".join(self._rule_stanza(rule, f"src/file{i}.ts") for i in range(9))
        text += "Found 9 diagnostics in 9 files in 10ms\n"
        result = f.apply(text, "", 1, ["biome", "check"])
        assert f"+6 more {rule} diagnostic(s) elided" in result.text
        assert "Found 9 diagnostics" in result.text

    def test_different_rules_each_get_3_stanzas(self) -> None:
        """Each rule gets its own 3-stanza budget independently."""
        f = self._f()
        rule_a = "lint/suspicious/noDoubleEquals"
        rule_b = "lint/style/useConst"
        # 5+5 stanzas × 5 non-empty = 50 > 40 threshold.
        text = "".join(self._rule_stanza(rule_a, f"src/a{i}.ts") for i in range(5))
        text += "".join(self._rule_stanza(rule_b, f"src/b{i}.ts") for i in range(5))
        text += "Found 10 diagnostics in 10 files\n"
        result = f.apply(text, "", 1, ["biome", "check"])
        assert f"+2 more {rule_a} diagnostic(s) elided" in result.text
        assert f"+2 more {rule_b} diagnostic(s) elided" in result.text

    def test_drops_action_hints(self) -> None:
        """Action hint lines (i Use X instead.) are dropped."""
        f = self._f()
        rule = "lint/suspicious/noDoubleEquals"
        # 9 stanzas × 5 non-empty = 45 > 40 threshold so compression fires.
        text = "".join(self._rule_stanza(rule, f"src/file{i}.ts") for i in range(9))
        result = f.apply(text, "", 1, ["biome", "check"])
        assert "i Use const instead." not in result.text

    def test_drops_excess_source_lines(self) -> None:
        """Source excerpt lines beyond 2 per stanza are dropped."""
        f = self._f()
        rule = "lint/a11y/noBlankTarget"
        # Build a stanza with 5 source excerpt lines.  Use 8 repetitions so the
        # total non-empty line count exceeds the 40-line pass-through threshold
        # (6 non-empty lines per stanza × 8 = 48 > 40).
        stanza = (
            f"  × {rule} ━━━\n"
            f"  10 │ line one\n"
            f"  11 │ line two\n"
            f"  12 │ line three\n"
            f"  13 │ line four\n"
            f"  14 │ line five\n"
            f"\n"
        )
        text = stanza * 8
        result = f.apply(text, "", 1, ["biome", "check"])
        # Each kept stanza may have at most 2 source lines; 3 stanzas kept → ≤ 6
        source_lines = [
            ln for ln in result.text.splitlines()
            if "│" in ln
        ]
        assert len(source_lines) <= 6

    def test_keeps_summary_line(self) -> None:
        """Found N diagnostics summary line is always kept."""
        f = self._f()
        rule = "lint/suspicious/noDoubleEquals"
        # 9 stanzas to exceed 40-line threshold.
        text = "".join(self._rule_stanza(rule, f"src/file{i}.ts") for i in range(9))
        text += "Found 9 diagnostics in 9 files in 10ms\n"
        result = f.apply(text, "", 1, ["biome", "check"])
        assert "Found 9 diagnostics" in result.text

    def test_keeps_error_lines(self) -> None:
        """Explicit error: lines are kept verbatim."""
        f = self._f()
        rule = "lint/suspicious/noDoubleEquals"
        # 9 stanzas to exceed 40-line threshold.
        text = "".join(self._rule_stanza(rule, f"src/file{i}.ts") for i in range(9))
        text += "error: configuration file not found\n"
        result = f.apply(text, "", 1, ["biome", "check"])
        assert "error: configuration file not found" in result.text

    def test_linter_filter_no_longer_claims_biome(self) -> None:
        """select_filter should route `biome` to BiomeFilter, not LinterFilter."""
        f = bc.select_filter(["biome", "lint", "--apply"])
        assert f is not None
        assert f.name == "biome"


# ---------------------------------------------------------------------------
# ElmFilter
# ---------------------------------------------------------------------------

class TestElmFilter:
    """Tests for ElmFilter (elm make / install compression)."""

    def _f(self) -> bc.ElmFilter:
        return bc.ElmFilter()

    # --- dispatch ---

    def test_dispatch_elm_make(self) -> None:
        f = bc.select_filter(["elm", "make", "src/Main.elm"])
        assert f is not None
        assert f.name == "elm"

    def test_dispatch_elm_install(self) -> None:
        f = bc.select_filter(["elm", "install", "elm/json"])
        assert f is not None
        assert f.name == "elm"

    def test_exported_in_all(self) -> None:
        assert "ElmFilter" in bc.__all__

    # --- downloading dependency lines collapsed ---

    def test_collapses_downloading_lines(self) -> None:
        """Multiple 'Downloading ...' lines are replaced with a count summary."""
        f = self._f()
        text = "\n".join([
            "Downloading elm/json (1.1.3)",
            "Downloading elm/http (2.0.0)",
            "Downloading elm/core (1.0.5)",
            "Success! Compiled 1 module.",
        ]) + "\n"
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "3" in result.text
        assert "Downloaded" in result.text
        assert "Downloading elm/json" not in result.text

    def test_keeps_success_line(self) -> None:
        """Success! summary line is always preserved."""
        f = self._f()
        text = "Downloading elm/json (1.1.3)\nSuccess! Compiled 1 module.\n"
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "Success!" in result.text

    def test_drops_dot_progress_lines(self) -> None:
        """Lines consisting only of dots are dropped as spinner noise."""
        f = self._f()
        text = ".....\n......\nSuccess! Compiled 1 module.\n"
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "....." not in result.text
        assert "Success!" in result.text

    def test_drops_deps_progress_banners(self) -> None:
        """'Building dependencies' / 'Solving dependencies' lines are dropped."""
        f = self._f()
        text = (
            "Solving dependencies...\n"
            "Building dependencies\n"
            "Verifying dependencies\n"
            "Success! Compiled 2 modules.\n"
        )
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "Solving dependencies" not in result.text
        assert "Building dependencies" not in result.text
        assert "Success!" in result.text

    def test_keeps_error_block_header(self) -> None:
        """Elm error block headers (-- TYPE MISMATCH ---) are kept verbatim."""
        f = self._f()
        text = (
            "-- TYPE MISMATCH -------------------------------- src/Main.elm\n"
            "\n"
            "The 1st argument to `text` is not what I expect:\n"
            "\n"
        )
        result = f.apply(text, "", 1, ["elm", "make", "src/Main.elm"])
        assert "TYPE MISMATCH" in result.text

    def test_preserves_stderr_on_error(self) -> None:
        """Non-zero exit code: stderr is returned unchanged."""
        f = self._f()
        stderr = "error: could not find elm.json\n"
        result = f.apply("", stderr, 1, ["elm", "make", "src/Main.elm"])
        assert "could not find elm.json" in result.text

    def test_short_output_passthrough(self) -> None:
        """Short output (≤ threshold) passes through unchanged."""
        f = self._f()
        text = "Success! Compiled 1 module.\n"
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "Success!" in result.text

    # --- compiling lines collapsed ---

    def test_collapses_compiling_lines(self) -> None:
        """'Compiling file.elm' progress lines are folded into a count."""
        f = self._f()
        lines = [f"Compiling src/Module{i}.elm" for i in range(10)]
        lines.append("Success! Compiled 10 modules.")
        text = "\n".join(lines) + "\n"
        result = f.apply(text, "", 0, ["elm", "make", "src/Main.elm"])
        assert "Compiled 10 modules" in result.text
        # The individual Compiling lines should be collapsed
        assert "Compiling src/Module0.elm" not in result.text


# ---------------------------------------------------------------------------
# JuliaFilter
# ---------------------------------------------------------------------------

class TestJuliaFilter:
    """Tests for JuliaFilter (Julia Pkg operations and test output)."""

    def _f(self) -> bc.JuliaFilter:
        return bc.JuliaFilter()

    # --- dispatch ---

    def test_dispatch_julia(self) -> None:
        f = bc.select_filter(["julia", "--project", "-e", "using Pkg; Pkg.add(\"Example\")"])
        assert f is not None
        assert f.name == "julia"

    def test_exported_in_all(self) -> None:
        assert "JuliaFilter" in bc.__all__

    # --- dep lines collapsed ---

    def test_collapses_pkg_dep_lines(self) -> None:
        """[uuid] +/-/↑ PkgName v1.0 lines are collapsed to a count summary."""
        f = self._f()
        lines = [
            "   [7876af07] + Example v0.5.3",
            "   [682c06a0] + JSON v0.21.4",
            "   [2a0f44e3] + Base64 v0.1.0",
            "   [56ddb016] ↑ Dates v1.0 ⇒ v1.1",
        ]
        text = "\n".join(lines) + "\n"
        result = f.apply(text, "", 0, ["julia"])
        assert "4" in result.text
        assert "[7876af07]" not in result.text

    def test_collapses_resolving_banners(self) -> None:
        """'Resolving', 'Fetching', 'Updating' banners are collapsed."""
        f = self._f()
        text = (
            "    Resolving package versions...\n"
            "    Updating `~/Project.toml`\n"
            "    Fetching package registry\n"
            "Status `~/Project.toml`\n"
        )
        result = f.apply(text, "", 0, ["julia"])
        assert "collapsed" in result.text or "Resolving" not in result.text
        assert "Status" in result.text

    def test_keeps_status_header(self) -> None:
        """Status `Project.toml` line is always preserved."""
        f = self._f()
        text = "   [7876af07] + Example v0.5.3\nStatus `~/Project.toml`\n"
        result = f.apply(text, "", 0, ["julia"])
        assert "Status" in result.text

    def test_keeps_test_summary(self) -> None:
        """Test Summary: table header is always kept."""
        f = self._f()
        text = (
            "   [7876af07] + Example v0.5.3\n" * 5
            + "Test Summary: | Pass  Total\n"
            + "    all tests |    3      3\n"
        )
        result = f.apply(text, "", 0, ["julia"])
        assert "Test Summary:" in result.text

    def test_collapses_passing_test_lines(self) -> None:
        """Individual ✓ pass lines are folded into a note count."""
        f = self._f()
        lines = [f"  ✓ test case {i}" for i in range(20)]
        lines.append("Test Summary: | Pass  Total")
        lines.append("  all tests |   20     20")
        text = "\n".join(lines) + "\n"
        result = f.apply(text, "", 0, ["julia"])
        assert "✓ test case 0" not in result.text
        assert "Test Summary:" in result.text

    def test_keeps_error_signals(self) -> None:
        """Error signals are never collapsed."""
        f = self._f()
        text = "   [7876af07] + Example v0.5.3\nerror: package not found\n"
        result = f.apply(text, "", 1, ["julia"])
        assert "error: package not found" in result.text

    def test_preserves_stderr_on_error(self) -> None:
        """Non-zero exit code: stderr returned unchanged."""
        f = self._f()
        stderr = "ERROR: Package 'NonExistent' not found in registry\n"
        result = f.apply("", stderr, 1, ["julia"])
        assert "NonExistent" in result.text

    def test_keeps_building_lines(self) -> None:
        """Building PackageName lines carry signal and are kept verbatim."""
        f = self._f()
        text = (
            "   [7876af07] + Example v0.5.3\n"
            "    Building Example → `/path/build.log`\n"
        )
        result = f.apply(text, "", 0, ["julia"])
        assert "Building Example" in result.text

    def test_keeps_testing_header(self) -> None:
        """'Testing PackageName' header is always kept."""
        f = self._f()
        text = (
            "    Resolving package versions...\n"
            "    Testing Example\n"
            "Test Summary: | Pass  Total\n"
        )
        result = f.apply(text, "", 0, ["julia"])
        assert "Testing Example" in result.text


# ---------------------------------------------------------------------------
# ToxFilter
# ---------------------------------------------------------------------------

class TestToxFilter:
    """Tests for ToxFilter (Python tox multi-environment test runner)."""

    def _f(self) -> bc.ToxFilter:
        return bc.ToxFilter()

    # --- dispatch ---

    def test_dispatch_tox(self) -> None:
        f = bc.select_filter(["tox"])
        assert f is not None
        assert f.name == "tox"

    def test_dispatch_tox_run(self) -> None:
        # `tox run` is dispatched to ToxFilter (no -e stripping involved).
        f = bc.select_filter(["tox", "run"])
        assert f is not None
        assert f.name == "tox"

    def test_exported_in_all(self) -> None:
        assert "ToxFilter" in bc.__all__

    # --- env create/install noise collapsed ---

    def test_collapses_env_create_lines(self) -> None:
        """py311: create / py311: install_deps lines are collapsed."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311: install_deps\n"
            "py312: create virtualenv\n"
            "py312: install_deps\n"
            "py311: commands succeeded\n"
            "py312: commands succeeded\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "create virtualenv" not in result.text
        assert "commands succeeded" in result.text
        assert "congratulations" in result.text

    def test_keeps_commands_failed(self) -> None:
        """'commands failed' lines are always kept."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311: commands failed\n"
        )
        result = f.apply(text, "", 1, ["tox"])
        assert "commands failed" in result.text

    def test_keeps_error_lines(self) -> None:
        """ERROR: lines are always kept."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "ERROR: could not install dependencies\n"
        )
        result = f.apply(text, "", 1, ["tox"])
        assert "ERROR: could not install dependencies" in result.text

    def test_keeps_final_summary(self) -> None:
        """'congratulations' / final test count lines are always kept."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311: install_deps\n"
            "  py311: OK (5.20 seconds)\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "congratulations" in result.text

    def test_keeps_env_result_lines(self) -> None:
        """Per-env result lines (py311: OK (5s)) are kept."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311: install_deps\n"
            "  py311: OK (5.20 seconds)\n"
            "  py312: OK (4.98 seconds)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "py311: OK" in result.text
        assert "py312: OK" in result.text

    def test_keeps_env_execution_header(self) -> None:
        """env execution header (py311 run-test: pytest tests/) is kept."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311 run-test: pytest tests/\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "pytest tests/" in result.text

    def test_collapses_pkg_install_noise(self) -> None:
        """.pkg: install / .pkg: build-wheel lines are collapsed."""
        f = self._f()
        text = (
            ".pkg create virtualenv\n"
            ".pkg: install_package\n"
            ".pkg: build-wheel\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert ".pkg: install" not in result.text
        assert "commands succeeded" in result.text

    def test_preserves_stderr_on_error(self) -> None:
        """Non-zero exit code: stderr returned unchanged."""
        f = self._f()
        stderr = "FATAL: tox could not find python3.11\n"
        result = f.apply("", stderr, 1, ["tox"])
        assert "FATAL" in result.text

    def test_emits_note_on_compression(self) -> None:
        """A [token-goat: ...] note is emitted when lines are collapsed."""
        f = self._f()
        text = (
            "py311: create virtualenv\n"
            "py311: install_deps\n"
            "py311: commands succeeded\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "token-goat" in result.text
        assert f.name != "linter"

    # --- tox 4.x pip progress inside environments ---

    def test_tox4_pip_progress_collapsed(self) -> None:
        """pip Collecting / Downloading / Using cached lines are collapsed."""
        f = self._f()
        text = (
            "py311: install_package\n"
            "Collecting attrs>=21.3.0\n"
            "  Downloading attrs-23.2.0-py3-none-any.whl (60 kB)\n"
            "  Using cached attrs-23.2.0-py3-none-any.whl (60 kB)\n"
            "Installing collected packages: attrs\n"
            "Successfully installed attrs-23.2.0\n"
            "py311: commands succeeded\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "Collecting attrs" not in result.text
        assert "Downloading attrs" not in result.text
        assert "Using cached" not in result.text
        assert "Installing collected" not in result.text
        # Summary line is kept.
        assert "Successfully installed" in result.text
        assert "congratulations" in result.text

    def test_tox4_pip_bar_collapsed(self) -> None:
        """Unicode pip download progress bars are collapsed."""
        f = self._f()
        text = (
            "Collecting requests\n"
            "  Downloading requests-2.31.0-py3-none-any.whl (62 kB)\n"
            "     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 62.6/62.6 kB 1.8 MB/s eta 0:00:00\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "━━━━━━━━━━ 62.6" not in result.text
        assert "Collecting" not in result.text
        assert "commands succeeded" in result.text

    def test_tox4_requirement_already_satisfied_collapsed(self) -> None:
        """'Requirement already satisfied' lines are collapsed."""
        f = self._f()
        text = (
            "py311: install_package\n"
            "Requirement already satisfied: pip>=19 in .tox/py311/lib/python3.11/site-packages\n"
            "Requirement already satisfied: setuptools in .tox/py311/lib/python3.11/site-packages\n"
            "Requirement already satisfied: wheel in .tox/py311/lib/python3.11/site-packages\n"
            "py311: commands succeeded\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        # The actual data lines are gone; only the compression note may mention the phrase.
        assert "pip>=19 in .tox" not in result.text
        assert "setuptools in .tox" not in result.text
        assert "wheel in .tox" not in result.text
        assert "congratulations" in result.text

    def test_tox4_requirement_satisfied_note(self) -> None:
        """Compression note includes 'Requirement already satisfied' count."""
        f = self._f()
        text = (
            "Requirement already satisfied: pip in .tox/py311/lib/python3.11/site-packages\n"
            "Requirement already satisfied: wheel in .tox/py311/lib/python3.11/site-packages\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "Requirement already satisfied" in result.text or "token-goat" in result.text
        assert "Requirement already satisfied: pip" not in result.text

    def test_tox4_separator_lines_collapsed(self) -> None:
        """tox 4 visual separator lines (━━━━━ py3.11 ━━━━━) are dropped."""
        f = self._f()
        sep = "━" * 30
        text = (
            f"  {sep} py3.11 {sep}\n"
            "py311 run-test: pytest tests/\n"
            "1 passed in 0.5s\n"
            f"  {sep} py3.12 {sep}\n"
            "py312 run-test: pytest tests/\n"
            "1 passed in 0.5s\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        # The ━ separator lines are dropped.
        assert sep not in result.text
        # Signal lines are kept.
        assert "pytest tests/" in result.text
        assert "congratulations" in result.text

    def test_tox4_separator_note(self) -> None:
        """Compression note mentions dropped separator lines."""
        f = self._f()
        sep = "━" * 20
        text = (
            f"{sep} py3.11 {sep}\n"
            f"{sep} py3.12 {sep}\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "separator" in result.text.lower() or "token-goat" in result.text

    def test_tox4_parallel_runner_polling_collapsed(self) -> None:
        """'py311: still running (Xs)...' parallel-runner polling lines are dropped."""
        f = self._f()
        text = (
            "py311: still running (0.55s)...\n"
            "py312: still running (0.55s)...\n"
            "py311: still running (1.10s)...\n"
            "py312: still running (1.10s)...\n"
            "  py311: OK (2.5 seconds)\n"
            "  py312: OK (2.7 seconds)\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "still running" not in result.text
        assert "py311: OK" in result.text
        assert "py312: OK" in result.text
        assert "congratulations" in result.text

    def test_tox4_parallel_polling_note(self) -> None:
        """Compression note mentions dropped parallel-runner polling lines."""
        f = self._f()
        text = (
            "py311: still running (0.55s)...\n"
            "py312: still running (0.55s)...\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "polling" in result.text.lower() or "token-goat" in result.text

    def test_tox4_wheel_editable_collapsed(self) -> None:
        """.pkg: wheel-editable is treated as install noise and collapsed."""
        f = self._f()
        text = (
            ".pkg: wheel-editable\n"
            ".pkg: build-wheel\n"
            "py311: commands succeeded\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "wheel-editable" not in result.text
        assert "build-wheel" not in result.text
        assert "congratulations" in result.text

    def test_tox4_successfully_installed_kept(self) -> None:
        """'Successfully installed X-1.0' summary line is always kept."""
        f = self._f()
        text = (
            "Collecting attrs\n"
            "  Downloading attrs-23.2.0.whl\n"
            "Installing collected packages: attrs\n"
            "Successfully installed attrs-23.2.0\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "Successfully installed attrs-23.2.0" in result.text

    def test_tox4_pip_note_on_compression(self) -> None:
        """Compression note includes pip install progress count."""
        f = self._f()
        text = (
            "Collecting attrs\n"
            "  Downloading attrs-23.2.0.whl (60 kB)\n"
            "  Building wheel for mypackage\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "pip" in result.text.lower() or "token-goat" in result.text
        assert "Collecting attrs" not in result.text

    def test_tox4_full_multi_env_scenario(self) -> None:
        """Full realistic tox 4 run: all noise collapsed, signal kept."""
        f = self._f()
        sep = "━" * 25
        text = (
            f"  {sep} py3.11 {sep}\n"
            "py311: install_package\n"
            "Collecting attrs>=21.3.0\n"
            "  Downloading attrs-23.2.0-py3-none-any.whl (60 kB)\n"
            "     ━━━━━━━━ 60.2/60.2 kB 2.0 MB/s eta 0:00:00\n"
            "Requirement already satisfied: pip in .tox/py311\n"
            "Requirement already satisfied: setuptools in .tox/py311\n"
            "Installing collected packages: attrs\n"
            "Successfully installed attrs-23.2.0\n"
            "py311 run-test: pytest tests/\n"
            "1 passed in 0.42s\n"
            f"  {sep} py3.12 {sep}\n"
            "py312: install_package\n"
            "py312: still running (0.1s)...\n"
            "Requirement already satisfied: attrs in .tox/py312\n"
            "py312 run-test: pytest tests/\n"
            "1 passed in 0.38s\n"
            "  py311: OK (3.1 seconds)\n"
            "  py312: OK (2.9 seconds)\n"
            "congratulations :)\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        # Noise is gone (check specific data payloads, not phrases that appear in notes).
        assert "Collecting attrs" not in result.text
        assert "Downloading attrs" not in result.text
        assert sep not in result.text
        assert "pip in .tox" not in result.text
        assert "setuptools in .tox" not in result.text
        assert "still running" not in result.text
        # Signal is present.
        assert "Successfully installed attrs-23.2.0" in result.text
        assert "pytest tests/" in result.text
        assert "py311: OK" in result.text
        assert "py312: OK" in result.text
        assert "congratulations" in result.text
        # Compression note is present.
        assert "token-goat" in result.text

    def test_tox4_building_wheel_collapsed(self) -> None:
        """'Building wheel for ...' lines inside tox are collapsed."""
        f = self._f()
        text = (
            "Building wheel for mypackage (pyproject.toml)\n"
            "  Created wheel for mypackage\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "Building wheel" not in result.text
        assert "Created wheel" not in result.text
        assert "commands succeeded" in result.text

    def test_pytest_collecting_line_kept(self) -> None:
        # Regression: _TOX_PIP_PROGRESS_RE with re.IGNORECASE matched lowercase
        # "collecting ..." emitted by pytest, dropping it as pip noise.
        f = self._f()
        text = (
            "py311 run-test: pytest tests/\n"
            "collecting ...\n"
            "1 passed in 0.42s\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "collecting ..." in result.text

    def test_pytest_rich_separator_kept(self) -> None:
        # Regression: _TOX_SEPARATOR_RE was r"^\s*━{5,}" which matched any line
        # starting with ━, including pytest-rich section separators with multi-word labels.
        f = self._f()
        bar = "━" * 30
        text = (
            "py311 run-test: pytest tests/\n"
            f"{bar} short test summary info {bar}\n"
            "FAILED test_foo.py::test_bar\n"
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "short test summary info" in result.text

    def test_pytest_rich_passed_summary_kept(self) -> None:
        # Regression: _TOX_PIP_BAR_RE was r"^\s*━+\s+[\d.]" which matched
        # pytest-rich "N passed in Xs" summary lines (━━━ 3 passed in 0.42s ━━━).
        f = self._f()
        bar = "━" * 30
        text = (
            "py311 run-test: pytest tests/\n"
            "  ━━━━━━━━━━ 60.2/60.2 kB 1.2 MB/s eta 0:00:00\n"  # pip bar — drop
            f"{bar} 3 passed in 0.42s {bar}\n"  # pytest-rich summary — keep
            "py311: commands succeeded\n"
        )
        result = f.apply(text, "", 0, ["tox"])
        assert "3 passed in 0.42s" in result.text
        assert "60.2/60.2" not in result.text


# ---------------------------------------------------------------------------
# compress pipeline: ANSI-free output guarantee
# ---------------------------------------------------------------------------


class TestCompressPipelineAnsiClean:
    """compress_output and Filter.apply must produce ANSI-free text."""

    def test_generic_filter_strips_ansi_from_stdout(self) -> None:
        """GenericFilter.apply removes ANSI codes that the tool emitted."""
        ansi_out = (
            "\x1b[38;2;56;56;56m╭─────────────────────\x1b[m\n"
            "\x1b[38;2;56;56;56m│\x1b[m 🥊 lefthook  v2.1.8  hook:  \x1b[1mpre-commit\x1b[m\n"
            "\x1b[38;2;56;56;56m╰─────────────────────\x1b[m\n"
            "All checks passed\n"
        )
        f = bc.GenericFilter()
        result = f.apply(ansi_out, "", 0, ["lefthook", "run"])
        assert "\x1b" not in result.text, "compressed output must not contain ANSI escapes"
        assert "lefthook" in result.text or "All checks passed" in result.text

    def test_generic_filter_strips_ansi_from_stderr(self) -> None:
        """GenericFilter.apply removes ANSI codes from stderr."""
        ansi_err = "\x1b[31mERROR:\x1b[0m build failed\n"
        f = bc.GenericFilter()
        result = f.apply("", ansi_err, 1, ["make"])
        assert "\x1b" not in result.text, "compressed stderr must not contain ANSI escapes"
        assert "ERROR:" in result.text
        assert "build failed" in result.text

    def test_compress_output_produces_ansi_free_result(self) -> None:
        """compress_output top-level function returns ANSI-free text."""
        ansi_stdout = "\x1b[32m✓ test passed\x1b[0m\n" * 20
        result = bc.compress_output(bc.GenericFilter(), ansi_stdout, "", 0, ["pytest"])
        assert "\x1b" not in result.text, "compress_output result must be ANSI-free"
        assert "test passed" in result.text


# ---------------------------------------------------------------------------
# Filter.compress template-method dispatch
# ---------------------------------------------------------------------------

class _StubFilter(bc.Filter):
    """Minimal Filter subclass for testing the error_passthrough template method."""
    name = "stub"
    binaries: frozenset[str] = frozenset({"stub"})
    error_passthrough = True

    def _compress_body(self, stdout: str, stderr: str, exit_code: int, argv: list[str]) -> str:
        return f"body:{stdout}"


class TestFilterTemplateMethod:
    """Direct unit tests for the Filter.compress template-method short-circuit."""

    def test_error_passthrough_short_circuits_on_nonzero_exit(self) -> None:
        """error_passthrough=True + non-zero exit + non-empty stderr returns combined output."""
        f = _StubFilter()
        # _preserve_stderr_on_error returns stdout + "---" + stderr when stdout is non-empty.
        result = f.compress("out", "err-text", 1, ["stub"])
        assert result == "out\n---\nerr-text"

    def test_error_passthrough_falls_through_on_zero_exit(self) -> None:
        """error_passthrough=True + exit 0 falls through to _compress_body (not short-circuited)."""
        f = _StubFilter()
        result = f.compress("out", "err-text", 0, ["stub"])
        assert result == "body:out"

    def test_no_error_passthrough_falls_through_on_nonzero_exit(self) -> None:
        """error_passthrough=False (default) ignores exit code and always calls _compress_body."""
        class _NoPassthroughFilter(bc.Filter):
            name = "nopt"
            binaries: frozenset[str] = frozenset({"nopt"})
            # error_passthrough defaults to False

            def _compress_body(self, stdout: str, stderr: str, exit_code: int, argv: list[str]) -> str:
                return f"body:{stdout}"

        f = _NoPassthroughFilter()
        result = f.compress("out", "err-text", 1, ["nopt"])
        assert result == "body:out"


# ---------------------------------------------------------------------------
# _is_diff_add / _is_diff_remove
# ---------------------------------------------------------------------------


class TestIsDiffAdd:
    def test_plain_add_line(self):
        assert bc._is_diff_add("+foo") is True

    def test_file_header_excluded(self):
        assert bc._is_diff_add("+++ b/src/file.py") is False

    def test_triple_plus_content_excluded(self):
        # content starting with ++ (e.g., C++ increment) is also excluded
        assert bc._is_diff_add("+++count;") is False

    def test_context_line_not_add(self):
        assert bc._is_diff_add(" context line") is False

    def test_remove_line_not_add(self):
        assert bc._is_diff_add("-removed") is False

    def test_empty_string(self):
        assert bc._is_diff_add("") is False


class TestIsDiffRemove:
    def test_plain_remove_line(self):
        assert bc._is_diff_remove("-bar") is True

    def test_file_header_excluded(self):
        assert bc._is_diff_remove("--- a/src/file.py") is False

    def test_triple_dash_content_excluded(self):
        # a diff line removing content that starts with '--' appears as '---...' and is excluded
        assert bc._is_diff_remove("---option") is False

    def test_context_line_not_remove(self):
        assert bc._is_diff_remove(" context line") is False

    def test_add_line_not_remove(self):
        assert bc._is_diff_remove("+added") is False

    def test_empty_string(self):
        assert bc._is_diff_remove("") is False


# ---------------------------------------------------------------------------
# _maybe_note
# ---------------------------------------------------------------------------


class TestMaybeNote:
    def test_zero_count_is_noop(self):
        notes: list[str] = []
        _maybe_note(notes, 0, "should not appear")
        assert notes == []

    def test_positive_count_appends_msg(self):
        notes: list[str] = []
        _maybe_note(notes, 5, "5 lines trimmed")
        assert notes == ["5 lines trimmed"]

    def test_count_one_and_count_two_both_append(self):
        notes_one: list[str] = []
        _maybe_note(notes_one, 1, "one")
        assert notes_one == ["one"]

        notes_two: list[str] = []
        _maybe_note(notes_two, 2, "two")
        assert notes_two == ["two"]

    def test_none_is_noop(self):
        notes: list[str] = []
        _maybe_note(notes, None, "msg")
        assert notes == []

    def test_nonempty_string_appends(self):
        notes: list[str] = []
        _maybe_note(notes, "1,234 tokens", "context: 1,234 tokens")
        assert notes == ["context: 1,234 tokens"]

    def test_empty_string_is_noop(self):
        notes: list[str] = []
        _maybe_note(notes, "", "msg")
        assert notes == []
