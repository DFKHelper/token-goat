"""Tests for JestFilter, VitestFilter, and ESLintFilter."""
from __future__ import annotations

from filter_test_helpers import apply_filter as _compress

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# JestFilter
# ---------------------------------------------------------------------------


class TestJestFilterDispatch:
    def test_jest_direct(self) -> None:
        assert bc.select_filter(["jest"]) is not None
        assert bc.select_filter(["jest"]).name == "jest"  # type: ignore[union-attr]

    def test_jest_via_npx(self) -> None:
        f = bc.select_filter(["npx", "jest"])
        assert f is not None and f.name == "jest"

    def test_mocha_dispatches_to_jest(self) -> None:
        f = bc.select_filter(["mocha", "tests/*.spec.js"])
        assert f is not None and f.name == "jest"

    def test_vitest_does_not_dispatch_to_jest(self) -> None:
        # vitest now has its own VitestFilter; must not fall through to jest.
        f = bc.select_filter(["vitest"])
        assert f is not None and f.name == "vitest"


class TestJestFilterPassCollapse:
    JEST = bc.JestFilter()

    def test_pass_lines_collapsed_to_count(self) -> None:
        lines = [f"PASS  src/module{i}.test.js" for i in range(8)]
        text = "\n".join(lines) + "\nTest Suites: 8 passed, 8 total\n"
        result = _compress(self.JEST, text)
        assert "PASS  src/module0.test.js" not in result
        assert "collapsed 8 PASS" in result
        assert "Test Suites: 8 passed" in result

    def test_single_pass_singular_label(self) -> None:
        result = _compress(self.JEST, "PASS  src/foo.test.js\n")
        assert "collapsed 1 PASS file" in result

    def test_pass_line_with_check_mark(self) -> None:
        # ✓ / √ file-level headers are also collapsed.
        text = "✓ src/foo.test.js\n✓ src/bar.test.js\nTests: 2 passed\n"
        result = _compress(self.JEST, text)
        assert "✓ src/foo.test.js" not in result
        assert "collapsed 2 PASS file" in result


class TestJestFilterFailBlock:
    JEST = bc.JestFilter()

    def test_fail_block_kept_verbatim(self) -> None:
        text = (
            "FAIL src/auth.test.js\n"
            "  ● login › returns 401 for bad password\n"
            "\n"
            "    Expected: 401\n"
            "    Received: 200\n"
            "\n"
            "Test Suites: 1 failed, 1 total\n"
        )
        result = _compress(self.JEST, text, exit_code=1)
        assert "FAIL src/auth.test.js" in result
        assert "Expected: 401" in result
        assert "Received: 200" in result

    def test_mixed_pass_and_fail(self) -> None:
        text = (
            "PASS src/a.test.js\n"
            "PASS src/b.test.js\n"
            "FAIL src/c.test.js\n"
            "  ● bad thing\n"
            "\n"
            "Test Suites: 2 passed, 1 failed, 3 total\n"
        )
        result = _compress(self.JEST, text, exit_code=1)
        assert "PASS src/a.test.js" not in result
        assert "collapsed 2 PASS" in result
        assert "FAIL src/c.test.js" in result
        assert "bad thing" in result


class TestJestFilterTickCollapse:
    JEST = bc.JestFilter()

    def test_passing_ticks_collapsed(self) -> None:
        text = (
            "PASS src/foo.test.js\n"
            "  ✓ does something (3 ms)\n"
            "  ✓ does another thing (5 ms)\n"
            "Tests: 2 passed, 2 total\n"
        )
        result = _compress(self.JEST, text)
        assert "✓ does something" not in result
        assert "collapsed 2 passing tick" in result

    def test_fail_block_ticks_kept(self) -> None:
        # ✓ lines inside a FAIL block must survive.
        text = (
            "FAIL src/foo.test.js\n"
            "  ✓ passing test (2 ms)\n"
            "  × failing test\n"
        )
        result = _compress(self.JEST, text, exit_code=1)
        assert "✓ passing test" in result


class TestJestFilterConsoleLogs:
    JEST = bc.JestFilter()

    def test_console_log_block_collapsed(self) -> None:
        text = (
            "PASS src/foo.test.js\n"
            "  console.log src/util.js:12\n"
            "    debug info line 1\n"
            "    debug info line 2\n"
            "    debug info line 3\n"
            "Tests: 1 passed\n"
        )
        result = _compress(self.JEST, text)
        assert "debug info line 1" not in result
        assert "collapsed" in result and "console output line" in result

    def test_console_warn_collapsed(self) -> None:
        text = (
            "  console.warn src/warn.js:5\n"
            "    something deprecation\n"
            "Tests: 1 passed\n"
        )
        result = _compress(self.JEST, text)
        assert "something deprecation" not in result
        assert "console output line" in result

    def test_non_console_lines_kept(self) -> None:
        text = "PASS src/foo.test.js\nconsole in name but not pattern\nTests: 1 passed\n"
        result = _compress(self.JEST, text)
        assert "console in name but not pattern" in result


class TestJestFilterSummaryKept:
    JEST = bc.JestFilter()

    def test_summary_lines_always_kept(self) -> None:
        text = "\n".join([
            "PASS src/a.test.js",
            "PASS src/b.test.js",
            "Test Suites: 2 passed, 2 total",
            "Tests:       10 passed, 10 total",
            "Snapshots:   0 total",
            "Time:        3.214 s",
            "Ran all test suites.",
        ])
        result = _compress(self.JEST, text)
        assert "Test Suites: 2 passed" in result
        assert "Tests:       10 passed" in result
        assert "Time:        3.214 s" in result


# ---------------------------------------------------------------------------
# VitestFilter
# ---------------------------------------------------------------------------


class TestVitestFilterDispatch:
    def test_vitest_direct(self) -> None:
        f = bc.select_filter(["vitest"])
        assert f is not None and f.name == "vitest"

    def test_vitest_via_npx(self) -> None:
        f = bc.select_filter(["npx", "vitest"])
        assert f is not None and f.name == "vitest"

    def test_vitest_run_subcommand(self) -> None:
        f = bc.select_filter(["vitest", "run"])
        assert f is not None and f.name == "vitest"


class TestVitestFilterPassCollapse:
    VITEST = bc.VitestFilter()

    def test_pass_file_lines_collapsed(self) -> None:
        text = (
            " ✓ src/foo.test.ts (12.34 ms)\n"
            " ✓ src/bar.test.ts (8.1 ms)\n"
            "Test Files  2 passed (2)\n"
            "Tests       15 passed (15)\n"
            "Duration    0.52 s\n"
        )
        result = _compress(self.VITEST, text)
        assert "✓ src/foo.test.ts" not in result
        assert "collapsed 2 passing file" in result
        assert "Test Files  2 passed" in result
        assert "Duration    0.52 s" in result

    def test_single_pass_singular_label(self) -> None:
        text = " ✓ src/only.test.ts (5 ms)\nTest Files  1 passed (1)\n"
        result = _compress(self.VITEST, text)
        assert "collapsed 1 passing file" in result


class TestVitestFilterFailBlock:
    VITEST = bc.VitestFilter()

    def test_fail_file_kept_verbatim(self) -> None:
        text = (
            " × src/broken.test.ts (100 ms)\n"
            "   AssertionError: expected 1 to equal 2\n"
            "   at Object.<anonymous> (src/broken.test.ts:10:5)\n"
            "\n"
            "Test Files  0 passed | 1 failed (1)\n"
        )
        result = _compress(self.VITEST, text, exit_code=1)
        assert "× src/broken.test.ts" in result
        assert "AssertionError" in result

    def test_mixed_pass_and_fail(self) -> None:
        text = (
            " ✓ src/good.test.ts (5 ms)\n"
            " × src/bad.test.ts (50 ms)\n"
            "   Error: something went wrong\n"
            "\n"
            "Test Files  1 passed | 1 failed (2)\n"
        )
        result = _compress(self.VITEST, text, exit_code=1)
        assert "✓ src/good.test.ts" not in result
        assert "collapsed 1 passing file" in result
        assert "× src/bad.test.ts" in result
        assert "Error: something went wrong" in result


class TestVitestFilterTestTicks:
    VITEST = bc.VitestFilter()

    def test_per_test_ticks_collapsed(self) -> None:
        text = (
            " ✓ src/foo.test.ts (10 ms)\n"
            "   ✓ renders correctly\n"
            "   ✓ handles click\n"
            "   ✓ shows error state\n"
            "Test Files  1 passed (1)\n"
        )
        result = _compress(self.VITEST, text)
        assert "renders correctly" not in result
        assert "collapsed 3 passing tick" in result


class TestVitestFilterSummaryKept:
    VITEST = bc.VitestFilter()

    def test_summary_lines_kept(self) -> None:
        text = (
            " ✓ src/a.test.ts (3 ms)\n"
            "Test Files  1 passed (1)\n"
            "Tests       5 passed (5)\n"
            "Duration    0.3 s\n"
        )
        result = _compress(self.VITEST, text)
        assert "Test Files  1 passed" in result
        assert "Tests       5 passed" in result
        assert "Duration    0.3 s" in result


class TestVitestFilterStdoutCollapse:
    VITEST = bc.VitestFilter()

    def test_stdout_block_collapsed(self) -> None:
        text = (
            " stdout | src/foo.test.ts\n"
            "   debug message 1\n"
            "   debug message 2\n"
            "Test Files  1 passed (1)\n"
        )
        result = _compress(self.VITEST, text)
        assert "debug message 1" not in result
        assert "collapsed" in result and "stdout line" in result


# ---------------------------------------------------------------------------
# ESLintFilter
# ---------------------------------------------------------------------------


class TestESLintFilterDispatch:
    def test_eslint_direct(self) -> None:
        f = bc.select_filter(["eslint"])
        assert f is not None and f.name == "eslint"

    def test_eslint_via_npx(self) -> None:
        f = bc.select_filter(["npx", "eslint"])
        assert f is not None and f.name == "eslint"

    def test_eslint_not_handled_by_linter(self) -> None:
        # ESLintFilter must win over LinterFilter for "eslint".
        f = bc.select_filter(["eslint", "src/", "--ext", ".ts"])
        assert f is not None and f.name == "eslint"


class TestESLintFilterCleanExit:
    ESLINT = bc.ESLintFilter()

    def test_exit_0_collapses_to_terse(self) -> None:
        text = (
            "src/foo.js\n"
            "✖ 0 problems (0 errors, 0 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=0)
        # Should either return the summary line or a terse "no errors" message.
        assert "error" in result.lower() or "problem" in result.lower()
        # Must not retain individual file stanza lines for a clean run.
        assert "src/foo.js" not in result

    def test_exit_0_no_output_returns_no_errors(self) -> None:
        result = _compress(self.ESLINT, "", exit_code=0)
        assert "no errors" in result.lower() or result == ""


class TestESLintFilterZeroProblemFiles:
    ESLINT = bc.ESLintFilter()

    def test_zero_problem_files_dropped(self) -> None:
        text = (
            "src/clean.js\n"
            "\n"
            "src/dirty.js\n"
            "  3:1  error  'foo' is not defined  no-undef\n"
            "\n"
            "✖ 1 problem (1 error, 0 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        assert "src/clean.js" not in result
        assert "src/dirty.js" in result
        assert "'foo' is not defined" in result
        assert "✖ 1 problem" in result


class TestESLintFilterErrorsKept:
    ESLINT = bc.ESLintFilter()

    def test_error_lines_always_kept(self) -> None:
        lines = [f"  {i}:1  error  'x{i}' is not defined  no-undef" for i in range(1, 8)]
        text = "src/messy.js\n" + "\n".join(lines) + "\n✖ 7 problems (7 errors, 0 warnings)\n"
        result = _compress(self.ESLINT, text, exit_code=1)
        # All error lines must survive (errors are never deduplicated).
        for i in range(1, 8):
            assert f"x{i}' is not defined" in result


class TestESLintFilterWarningDedup:
    ESLINT = bc.ESLintFilter()

    def test_repeated_warnings_deduplicated(self) -> None:
        warn_lines = [f"  {i}:1  warning  Missing semicolon  semi" for i in range(1, 9)]
        text = "src/foo.js\n" + "\n".join(warn_lines) + "\n✖ 8 problems (0 errors, 8 warnings)\n"
        result = _compress(self.ESLINT, text, exit_code=1)
        # At most 3 examples kept; remainder summarised.
        semicolon_lines = [ln for ln in result.splitlines() if "Missing semicolon" in ln]
        assert len(semicolon_lines) == 3
        assert "+5 more semi warnings" in result

    def test_warnings_with_few_occurrences_kept_verbatim(self) -> None:
        text = (
            "src/foo.js\n"
            "  1:1  warning  Use === instead of ==  eqeqeq\n"
            "  2:1  warning  Use === instead of ==  eqeqeq\n"
            "✖ 2 problems (0 errors, 2 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        eqeqeq_lines = [ln for ln in result.splitlines() if "eqeqeq" in ln and "warning" in ln]
        assert len(eqeqeq_lines) == 2

    def test_summary_line_always_kept(self) -> None:
        text = (
            "src/foo.js\n"
            "  1:1  error  bad thing  rule-name\n"
            "✖ 1 problem (1 error, 0 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        assert "✖ 1 problem" in result

    def test_mixed_errors_and_warnings(self) -> None:
        text = (
            "src/app.js\n"
            "  1:1  error    'React' must be in scope  react/react-in-jsx-scope\n"
            + "\n".join(
                [f"  {i}:1  warning  Missing semicolon  semi" for i in range(2, 8)]
            )
            + "\n✖ 7 problems (1 error, 6 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        # Error kept.
        assert "react/react-in-jsx-scope" in result
        # Warnings deduped: exactly 3 actual issue lines kept plus 1 summary note.
        semi_issue_lines = [
            ln for ln in result.splitlines()
            if "warning" in ln and "Missing semicolon" in ln
        ]
        assert len(semi_issue_lines) == 3
        assert "+3 more semi warnings" in result


class TestESLintFilterMultipleFiles:
    ESLINT = bc.ESLintFilter()

    def test_multiple_dirty_files_each_get_header(self) -> None:
        text = (
            "src/a.js\n"
            "  1:1  error  bad  rule-a\n"
            "src/b.js\n"
            "  1:1  error  bad  rule-b\n"
            "✖ 2 problems (2 errors, 0 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        assert "src/a.js" in result
        assert "src/b.js" in result

    def test_clean_file_between_dirty_files_dropped(self) -> None:
        text = (
            "src/dirty1.js\n"
            "  1:1  error  bad  rule-x\n"
            "src/clean.js\n"
            "src/dirty2.js\n"
            "  2:1  error  also bad  rule-y\n"
            "✖ 2 problems (2 errors, 0 warnings)\n"
        )
        result = _compress(self.ESLINT, text, exit_code=1)
        assert "src/dirty1.js" in result
        assert "src/clean.js" not in result
        assert "src/dirty2.js" in result
