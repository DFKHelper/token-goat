"""Tests for NgFilter — Angular CLI (ng build / test / serve) output compression."""
from __future__ import annotations

from token_goat.bash_compress import NgFilter, select_filter

# ---------------------------------------------------------------------------
# Fixtures — realistic Angular CLI output samples
# ---------------------------------------------------------------------------

_BUILD_NEW_STYLE_FEW_CHUNKS = """\
Application bundle generation complete. [5.678 seconds]

Initial chunk files | Names         | Raw Size | Estimated Transfer Size
main.abc123.js      | main          | 172.29 kB |                45.14 kB
polyfills.def456.js | polyfills     |  36.22 kB |                11.53 kB
runtime.ghi789.js   | runtime       |   6.15 kB |                 2.79 kB

                    | Initial Total | 214.66 kB |                59.46 kB

Build at: 2024-01-15T10:30:01.000Z - Hash: abc123def456 - Time: 5678ms
"""

# Build with many lazy chunks (the compression target).
_BUILD_NEW_STYLE_MANY_LAZY = """\
Application bundle generation complete. [8.234 seconds]

Initial chunk files        | Names         | Raw Size | Estimated Transfer Size
main.c6bca98f.js           | main          |   1.20 MB |               250.00 kB
polyfills.7ecad3e2.js      | polyfills     |  36.22 kB |                11.53 kB
runtime.5cef19f8.js        | runtime       |   6.15 kB |                 2.79 kB

                           | Initial Total |   1.24 MB |               264.32 kB

Lazy chunk files           | Names         | Raw Size | Estimated Transfer Size
feature-a.aa111111.js      | feature-a     |  52.10 kB |                14.23 kB
feature-b.bb222222.js      | feature-b     |  41.23 kB |                11.45 kB
feature-c.cc333333.js      | feature-c     |  38.50 kB |                10.20 kB
feature-d.dd444444.js      | feature-d     |  35.11 kB |                 9.80 kB
feature-e.ee555555.js      | feature-e     |  29.88 kB |                 8.22 kB
feature-f.ff666666.js      | feature-f     |  27.44 kB |                 7.91 kB
feature-g.gg777777.js      | feature-g     |  23.12 kB |                 6.55 kB
feature-h.hh888888.js      | feature-h     |  21.03 kB |                 5.98 kB
feature-i.ii999999.js      | feature-i     |  19.67 kB |                 5.44 kB

Build at: 2024-01-15T10:30:01.000Z - Hash: c6bca98f - Time: 8234ms
"""

_BUILD_OLD_WEBPACK_FEW = """\
chunk {0} polyfills.js (polyfills) 141 kB [initial] [rendered]
chunk {1} main.js (main) 5.39 MB [initial] [rendered]
chunk {2} styles.js (styles) 1.25 MB [initial] [rendered]
Date: 2024-01-01T00:00:00.000Z - Hash: abc123 - Time: 45678ms
"""

_BUILD_OLD_WEBPACK_MANY = """\
chunk {0} polyfills.js (polyfills) 141 kB [initial] [rendered]
chunk {1} main.js (main) 5.39 MB [initial] [rendered]
chunk {2} styles.js (styles) 1.25 MB [initial] [rendered]
chunk {3} vendor.js (vendor) 6.06 MB [initial] [rendered]
chunk {4} runtime.js (runtime) 6.22 kB [initial] [rendered]
chunk {5} feature-a.js (feature-a) 52 kB [initial] [rendered]
chunk {6} feature-b.js (feature-b) 48 kB [initial] [rendered]
chunk {7} feature-c.js (feature-c) 38 kB [initial] [rendered]
chunk {8} feature-d.js (feature-d) 29 kB [initial] [rendered]
chunk {9} feature-e.js (feature-e) 22 kB [initial] [rendered]
Date: 2024-01-01T00:00:00.000Z - Hash: deadbeef - Time: 62345ms
"""

_BUILD_BUDGET_WARNING = """\
Application bundle generation complete. [12.345 seconds]

Initial chunk files | Names | Raw Size | Estimated Transfer Size
main.bigapp.js      | main  |   5.39 MB |                 1.20 MB

                    | Initial Total |   5.39 MB |                1.20 MB

Warning: bundle initial exceeded maximum budget. Budget 1.00 MB was not met by 4.39 MB with a total of 5.39 MB.

Build at: 2024-01-15T12:00:00.000Z - Hash: bigapp123 - Time: 12345ms
"""

_BUILD_WITH_PROGRESS = """\
- Generating browser application bundles (phase: building)...
Building...
Application bundle generation complete. [3.210 seconds]

Initial chunk files | Names  | Raw Size | Estimated Transfer Size
main.xyz.js         | main   |  50.00 kB |                12.00 kB

Build at: 2024-01-15T09:00:00.000Z - Hash: xyz789 - Time: 3210ms
"""

_TEST_KARMA_OUTPUT = """\
✔ Browser application bundle generation complete.

09 01 2024 10:30:00.000:INFO [karma]: Karma v6.4.2 server started at http://localhost:9876/
09 01 2024 10:30:00.123:INFO [karma-server]: Karma v6.4.2 server started at http://localhost:9876/
09 01 2024 10:30:00.456:INFO [launcher]: Starting browser ChromeHeadless
09 01 2024 10:30:01.234:INFO [Chrome Headless 120.0.0.0 (Linux x86_64)]: Connected on socket abc123
Chrome Headless 120.0.0.0 (Linux x86_64): Executed 134 of 134 SUCCESS (1.234 secs / 0.987 secs)
TOTAL: 134 SUCCESS
"""

_TEST_KARMA_FAILURE = """\
09 01 2024 10:30:00.000:INFO [karma]: Karma v6.4.2 server started at http://localhost:9876/
09 01 2024 10:30:00.456:INFO [launcher]: Starting browser ChromeHeadless
Chrome Headless 120.0.0.0 (Linux x86_64): Executed 10 of 10 (2 FAILED) (0.456 secs / 0.321 secs)
TOTAL: 2 FAILED, 8 SUCCESS
"""

_FILTER = NgFilter()


def _compress(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    if argv is None:
        argv = ["ng", "build"]
    return _FILTER.compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# TestDispatch
# ---------------------------------------------------------------------------

class TestDispatch:
    def test_ng_build_matched(self) -> None:
        f = select_filter(["ng", "build"])
        assert f is not None
        assert f.name == "ng"

    def test_ng_serve_matched(self) -> None:
        f = select_filter(["ng", "serve"])
        assert f is not None
        assert f.name == "ng"

    def test_ng_test_matched(self) -> None:
        f = select_filter(["ng", "test"])
        assert f is not None
        assert f.name == "ng"

    def test_ng_generate_matched(self) -> None:
        f = select_filter(["ng", "generate", "component", "foo"])
        assert f is not None
        assert f.name == "ng"

    def test_unrelated_binary_not_matched(self) -> None:
        f = select_filter(["node", "server.js"])
        assert f is None or f.name != "ng"


# ---------------------------------------------------------------------------
# TestBuildSummaryLines
# ---------------------------------------------------------------------------

class TestBuildSummaryLines:
    def test_bundle_complete_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "Application bundle generation complete." in out

    def test_build_at_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "Build at:" in out

    def test_date_line_kept_webpack(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_FEW)
        assert "Date:" in out

    def test_hash_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "Hash:" in out


# ---------------------------------------------------------------------------
# TestChunkTableFewRows (≤6 rows — all kept)
# ---------------------------------------------------------------------------

class TestChunkTableFewRows:
    def test_table_header_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "Initial chunk files" in out

    def test_all_rows_kept_when_few(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "main.abc123.js" in out
        assert "polyfills.def456.js" in out
        assert "runtime.ghi789.js" in out

    def test_no_collapse_note_when_few(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_FEW_CHUNKS)
        assert "collapsed" not in out


# ---------------------------------------------------------------------------
# TestChunkTableManyRows (>6 lazy chunks — middle collapsed)
# ---------------------------------------------------------------------------

class TestChunkTableManyRows:
    def test_collapse_note_present(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        assert "collapsed" in out

    def test_collapse_note_not_doubled(self) -> None:
        # Regression: _emit_notes appended a trailing duplicate after _flush_rows
        # already wrote an inline per-section note.
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        assert out.count("collapsed") == 1

    def test_first_rows_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        # First 3 lazy chunks must survive.
        assert "feature-a.aa111111.js" in out
        assert "feature-b.bb222222.js" in out
        assert "feature-c.cc333333.js" in out

    def test_last_rows_kept(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        # Last 3 lazy chunks must survive.
        assert "feature-g.gg777777.js" in out
        assert "feature-h.hh888888.js" in out
        assert "feature-i.ii999999.js" in out

    def test_middle_rows_dropped(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        # Middle chunks should be collapsed (not verbatim in output).
        assert "feature-d.dd444444.js" not in out
        assert "feature-e.ee555555.js" not in out
        assert "feature-f.ff666666.js" not in out

    def test_initial_chunks_still_present(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        # Initial chunk section has ≤3 rows, all kept.
        assert "main.c6bca98f.js" in out
        assert "polyfills.7ecad3e2.js" in out

    def test_build_summary_still_present(self) -> None:
        out = _compress(stdout=_BUILD_NEW_STYLE_MANY_LAZY)
        assert "Build at:" in out


# ---------------------------------------------------------------------------
# TestWebpackChunkCollapse
# ---------------------------------------------------------------------------

class TestWebpackChunkCollapse:
    def test_few_chunks_all_kept(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_FEW)
        assert "chunk {0}" in out
        assert "chunk {1}" in out
        assert "chunk {2}" in out
        assert "collapsed" not in out

    def test_many_chunks_first_kept(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_MANY)
        assert "chunk {0}" in out
        assert "chunk {1}" in out
        assert "chunk {2}" in out

    def test_many_chunks_last_kept(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_MANY)
        assert "chunk {8}" in out
        assert "chunk {9}" in out

    def test_many_chunks_middle_collapsed(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_MANY)
        assert "collapsed" in out
        # Middle chunks 3-6 should be collapsed.
        assert "chunk {3}" not in out
        assert "chunk {5}" not in out

    def test_date_line_kept_after_webpack(self) -> None:
        out = _compress(stdout=_BUILD_OLD_WEBPACK_MANY)
        assert "Date:" in out
        assert "Hash: deadbeef" in out


# ---------------------------------------------------------------------------
# TestBudgetWarning
# ---------------------------------------------------------------------------

class TestBudgetWarning:
    def test_budget_warning_always_kept(self) -> None:
        out = _compress(stdout=_BUILD_BUDGET_WARNING)
        assert "Warning: bundle initial exceeded maximum budget" in out

    def test_build_summary_kept_with_warning(self) -> None:
        out = _compress(stdout=_BUILD_BUDGET_WARNING)
        assert "Build at:" in out


# ---------------------------------------------------------------------------
# TestBuildProgressLines
# ---------------------------------------------------------------------------

class TestBuildProgressLines:
    def test_dash_generating_dropped(self) -> None:
        out = _compress(stdout=_BUILD_WITH_PROGRESS)
        assert "- Generating browser application bundles" not in out

    def test_building_dots_dropped(self) -> None:
        out = _compress(stdout=_BUILD_WITH_PROGRESS)
        assert "Building..." not in out

    def test_summary_still_present(self) -> None:
        out = _compress(stdout=_BUILD_WITH_PROGRESS)
        assert "Application bundle generation complete." in out

    def test_token_goat_note_mentions_progress(self) -> None:
        out = _compress(stdout=_BUILD_WITH_PROGRESS)
        assert "dropped" in out


# ---------------------------------------------------------------------------
# TestNgTestKarmaCompression
# ---------------------------------------------------------------------------

class TestNgTestKarmaCompression:
    def _compress_test(self, stdout: str = "", stderr: str = "") -> str:
        return _FILTER.compress(stdout, stderr, 0, ["ng", "test"])

    def test_karma_info_lines_dropped(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_OUTPUT)
        assert "Karma v6.4.2 server started" not in out
        assert "Starting browser" not in out
        assert "Connected on socket" not in out

    def test_karma_result_kept(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_OUTPUT)
        assert "Executed 134 of 134 SUCCESS" in out

    def test_karma_result_with_info_prefix_kept(self) -> None:
        # Regression: result line with INFO [Chrome...] prefix was dropped by the
        # noise guard before the result guard could fire.
        lines = [
            "INFO [karma-server]: Karma v6.4.3 server started.",
            "INFO [launcher]: Launching browsers Chrome with concurrency unlimited",
            "INFO [Chrome 120.0.0.0]: Executed 134 of 134 SUCCESS (1.234 secs / 0.987 secs)",
            "TOTAL: 134 SUCCESS",
        ]
        out = self._compress_test(stdout="\n".join(lines))
        assert "Executed 134 of 134 SUCCESS" in out

    def test_karma_total_kept(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_OUTPUT)
        assert "TOTAL: 134 SUCCESS" in out

    def test_bundle_complete_kept(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_OUTPUT)
        assert "Browser application bundle generation complete" in out

    def test_karma_failure_result_kept(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_FAILURE)
        assert "Executed 10 of 10 (2 FAILED)" in out

    def test_karma_failure_total_kept(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_FAILURE)
        assert "TOTAL: 2 FAILED" in out

    def test_note_mentions_karma_lines_dropped(self) -> None:
        out = self._compress_test(stdout=_TEST_KARMA_OUTPUT)
        assert "Karma" in out or "dropped" in out


# ---------------------------------------------------------------------------
# TestErrorExitPassthrough
# ---------------------------------------------------------------------------

class TestErrorExitPassthrough:
    def test_error_exit_preserves_stderr(self) -> None:
        stderr = "ERROR: src/app/app.component.ts:5:3 - error TS2339: Property 'x' does not exist."
        out = _FILTER.compress("", stderr, 1, ["ng", "build"])
        assert "error TS2339" in out

    def test_error_exit_includes_stdout_if_present(self) -> None:
        stdout = "Compiling..."
        stderr = "ERROR: Type check failed."
        out = _FILTER.compress(stdout, stderr, 1, ["ng", "build"])
        assert "Type check failed." in out
