"""Tests for CypressFilter -- cypress run E2E output compression."""
from __future__ import annotations

from token_goat.bash_compress import CypressFilter

# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------

_f = CypressFilter()


def _compress(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    if argv is None:
        argv = ["cypress", "run"]
    return _f.compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# Representative fixtures
# ---------------------------------------------------------------------------

_BOX_TOP    = "  ┌" + "─" * 36 + "┐\n"
_BOX_BOTTOM = "  └" + "─" * 36 + "┘\n"
_BOX_SIDE   = "  │"
_SEP        = "─" * 40 + "\n"   # pure horizontal-rule separator
_SEP_EQ     = "=" * 40 + "\n"        # equals-sign separator (older Cypress)

_PASS_MARK  = "✓"   # CHECK MARK
_FAIL_MARK  = "✗"   # BALLOT X

_RUN_STARTING_BLOCK = (
    _SEP_EQ
    + "\n"
    + "  (Run Starting)\n"
    + "\n"
    + _BOX_TOP
    + _BOX_SIDE + " Cypress:        13.6.0                     │\n"
    + _BOX_SIDE + " Browser:        Electron 114 (headless)    │\n"
    + _BOX_SIDE + " Specs:          1 found (login.cy.ts)      │\n"
    + _BOX_BOTTOM
    + "\n"
)

_PER_SPEC_HEADER = (
    "\n"
    + _SEP
    + "                              Running:  login.cy.ts    (1 of 1)\n"
    + _SEP
    + "\n"
)

_TESTS_ALL_PASS = (
    "  Login Tests\n"
     f"    {_PASS_MARK} displays login form (234ms)\n"
     f"    {_PASS_MARK} validates email input (456ms)\n"
     "\n"
     "  2 passing (1s)\n"
     "\n"
)

_TESTS_WITH_FAILURE = (
    "  Login Tests\n"
     f"    {_PASS_MARK} displays login form (234ms)\n"
     f"    {_FAIL_MARK} fails on network error (500ms)\n"
     "\n"
     "  1 passing (1s)\n"
     "  1 failing\n"
     "\n"
     "  1) Login Tests\n"
     "       fails on network error:\n"
     "     AssertionError: expected 500 to equal 200\n"
     "\n"
)

_RESULTS_BOX = (
    "  (Results)\n"
     "\n"
    + _BOX_TOP
    + _BOX_SIDE + " Tests:        2   │\n"
    + _BOX_SIDE + " Passing:      2   │\n"
    + _BOX_SIDE + " Failing:      0   │\n"
    + _BOX_SIDE + " Video:        true │\n"
    + _BOX_BOTTOM
    + "\n"
)

_VIDEO_SECTION = (
    "  (Video)\n"
     "\n"
     "  -  Started processing:  Compressing to 32 CRF\n"
     "  -  Compression progress:  11%\n"
     "  -  Compression progress:  53%\n"
     "  -  Compression progress:  100%\n"
     "  -  Finished processing:  /path/to/login.cy.ts.mp4\n"
     "\n"
)

_RUN_FINISHED_BLOCK = (
    "\n"
    + _SEP_EQ
    + "\n"
    + "  (Run Finished)\n"
    + "\n"
    + "\n"
    + "       Spec                   Tests  Passing  Failing\n"
    + _BOX_TOP
    + _BOX_SIDE + f" {_PASS_MARK}  login.cy.ts   00:01   2   2   -  │\n"
    + _BOX_BOTTOM
    + f"    {_PASS_MARK}  All specs passed!   00:01   2   2   -   -   -\n"
    + "\n"
    + _SEP_EQ
)

_FULL_SUCCESS_OUTPUT = (
    _RUN_STARTING_BLOCK
    + _PER_SPEC_HEADER
    + _TESTS_ALL_PASS
    + _RESULTS_BOX
    + _VIDEO_SECTION
    + _RUN_FINISHED_BLOCK
)

_FULL_FAILURE_OUTPUT = (
    _RUN_STARTING_BLOCK
    + _PER_SPEC_HEADER
    + _TESTS_WITH_FAILURE
    + _RESULTS_BOX
    + _VIDEO_SECTION
    + _RUN_FINISHED_BLOCK
)


# ===========================================================================
# 1. matches()
# ===========================================================================


class TestCypressFilterMatches:
    """CypressFilter.matches() -- acceptance and rejection."""

    def test_cypress_run(self) -> None:
        assert _f.matches(["cypress", "run"])

    def test_cypress_open(self) -> None:
        assert _f.matches(["cypress", "open"])

    def test_cypress_bare(self) -> None:
        """Bare `cypress` with no subcommand should match."""
        assert _f.matches(["cypress"])

    def test_cypress_run_with_flags(self) -> None:
        assert _f.matches(["cypress", "run", "--headless", "--browser", "chrome"])

    def test_cypress_exe(self) -> None:
        """Windows .exe suffix must still match."""
        assert _f.matches(["cypress.exe", "run"])

    def test_npx_cypress_run(self) -> None:
        assert _f.matches(["npx", "cypress", "run"])

    def test_npx_flag_cypress_run(self) -> None:
        """npx flags before the package name must be ignored."""
        assert _f.matches(["npx", "--yes", "cypress", "run"])

    def test_bunx_cypress_run(self) -> None:
        assert _f.matches(["bunx", "cypress", "run"])

    def test_pnpx_cypress_run(self) -> None:
        assert _f.matches(["pnpx", "cypress", "run"])

    def test_cypress_verify_no_match(self) -> None:
        """verify is not in SUBCMDS -- should not match."""
        assert not _f.matches(["cypress", "verify"])

    def test_cypress_install_no_match(self) -> None:
        """install is not in SUBCMDS -- should not match."""
        assert not _f.matches(["cypress", "install"])

    def test_empty_argv_no_match(self) -> None:
        assert not _f.matches([])

    def test_playwright_not_matched(self) -> None:
        assert not _f.matches(["playwright", "test"])

    def test_jest_not_matched(self) -> None:
        assert not _f.matches(["jest"])

    def test_npx_jest_not_matched(self) -> None:
        assert not _f.matches(["npx", "jest", "--watchAll"])


# ===========================================================================
# 2. Banner and separator suppression
# ===========================================================================


class TestCypressFilterBannerSuppression:
    """Run Starting box and separator lines are suppressed."""

    def test_run_starting_header_suppressed(self) -> None:
        out = _compress(_RUN_STARTING_BLOCK)
        assert "(Run Starting)" not in out

    def test_box_top_from_banner_suppressed(self) -> None:
        out = _compress(_RUN_STARTING_BLOCK)
        # The banner box top (┌...) must not appear
        assert "┌" + "─" * 36 not in out

    def test_box_metadata_suppressed(self) -> None:
        out = _compress(_RUN_STARTING_BLOCK)
        assert "Cypress:        13.6.0" not in out

    def test_browser_metadata_suppressed(self) -> None:
        out = _compress(_RUN_STARTING_BLOCK)
        assert "Electron 114 (headless)" not in out

    def test_horizontal_separator_suppressed(self) -> None:
        out = _compress(_PER_SPEC_HEADER)
        # Pure ─── separator lines must vanish
        assert "─" * 30 not in out

    def test_equals_separator_suppressed(self) -> None:
        out = _compress("=" * 40 + "\n" + "  some content\n")
        assert "=" * 40 not in out
        assert "some content" in out

    def test_running_spec_header_kept(self) -> None:
        """Running: specname (N of M) must survive."""
        out = _compress(_PER_SPEC_HEADER)
        assert "Running:  login.cy.ts" in out

    def test_banner_note_emitted(self) -> None:
        out = _compress(_RUN_STARTING_BLOCK)
        assert "suppressed" in out
        assert "cypress header/results box lines" in out

    def test_separator_note_emitted(self) -> None:
        out = _compress(_PER_SPEC_HEADER)
        assert "suppressed" in out
        assert "separator lines" in out

    def test_full_success_banner_absent(self) -> None:
        """Full run: Run Starting box must not appear in compressed output."""
        out = _compress(_FULL_SUCCESS_OUTPUT)
        assert "(Run Starting)" not in out
        assert "Cypress:        13.6.0" not in out


# ===========================================================================
# 3. Results box suppression
# ===========================================================================


class TestCypressFilterResultsBox:
    """Per-spec (Results) box is suppressed as redundant with Run Finished."""

    def test_results_header_suppressed(self) -> None:
        out = _compress(_RESULTS_BOX)
        assert "(Results)" not in out

    def test_results_tests_count_suppressed(self) -> None:
        out = _compress(_RESULTS_BOX)
        assert "Tests:        2" not in out

    def test_results_passing_count_suppressed(self) -> None:
        out = _compress(_RESULTS_BOX)
        assert "Passing:      2" not in out

    def test_results_box_note_emitted(self) -> None:
        out = _compress(_RESULTS_BOX)
        assert "suppressed" in out
        assert "cypress header/results box lines" in out

    def test_full_success_results_box_absent(self) -> None:
        out = _compress(_FULL_SUCCESS_OUTPUT)
        assert "(Results)" not in out
        assert "Tests:        2" not in out


# ===========================================================================
# 4. Video section suppression
# ===========================================================================


class TestCypressFilterVideoSection:
    """(Video) section lines are suppressed entirely."""

    def test_video_header_suppressed(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "(Video)" not in out

    def test_compression_progress_suppressed(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Compression progress" not in out

    def test_started_processing_suppressed(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Started processing" not in out

    def test_finished_processing_suppressed(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Finished processing" not in out

    def test_video_note_emitted(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "suppressed" in out
        assert "video processing lines" in out

    def test_run_finished_kept_after_video(self) -> None:
        """(Run Finished) must survive even when it terminates the video section."""
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "(Run Finished)" in out

    def test_summary_table_kept_after_video(self) -> None:
        out = _compress(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "All specs passed!" in out

    def test_no_video_section_ok(self) -> None:
        """Output with no (Video) section must still compress correctly."""
        no_video = _FULL_SUCCESS_OUTPUT.replace(_VIDEO_SECTION, "")
        out = _compress(no_video)
        assert "(Run Finished)" in out
        assert "All specs passed!" in out


# ===========================================================================
# 5. Pass/fail test line handling
# ===========================================================================
        assert "(Run Starting)" not in out  # banner must be suppressed

    def test_error_in_video_section_kept(self) -> None:
        """Regression: error lines inside video section must pass through."""
        out = _compress(
            "  (Video)\n"
            "  - Started processing: MySpec.cy.ts\n"
            "  Error: ffmpeg not found in PATH\n"
            "  (Run Finished)\n"
            "\n"
            "  All specs passed!\n"
        )
        assert "Error: ffmpeg not found" in out

    def test_truncated_video_section_emits_warning(self) -> None:
        """Regression: truncated output (no Run Finished) must emit warning note."""
        out = _compress(
            "  (Video)\n"
            "  - Started processing: MySpec.cy.ts\n"
            "  - Compression: 60%\n"
            # No (Run Finished) — simulate truncated output
        )
        assert "truncated" in out.lower() or "warning" in out.lower()



class TestCypressFilterTestLines:
    """Passing-test suppression and failure preservation."""

    def test_passing_tests_suppressed_on_success(self) -> None:
        out = _compress(_TESTS_ALL_PASS, exit_code=0)
        assert f"    {_PASS_MARK} displays login form (234ms)" not in out

    def test_passing_tests_kept_on_nonzero_exit(self) -> None:
        """When the run fails (exit_code != 0) passing lines must be kept."""
        out = _compress(_TESTS_ALL_PASS, exit_code=1)
        assert f"    {_PASS_MARK} displays login form (234ms)" in out

    def test_failing_test_always_kept(self) -> None:
        out = _compress(_TESTS_WITH_FAILURE, exit_code=1)
        assert f"    {_FAIL_MARK} fails on network error (500ms)" in out

    def test_failing_test_kept_even_with_zero_exit(self) -> None:
        """Defensive: ✗ lines kept even if exit_code is somehow 0."""
        out = _compress(_TESTS_WITH_FAILURE, exit_code=0)
        assert f"    {_FAIL_MARK} fails on network error (500ms)" in out

    def test_pass_summary_kept(self) -> None:
        out = _compress(_TESTS_ALL_PASS, exit_code=0)
        assert "2 passing (1s)" in out

    def test_fail_summary_kept(self) -> None:
        out = _compress(_TESTS_WITH_FAILURE, exit_code=1)
        assert "1 failing" in out

    def test_describe_block_name_kept(self) -> None:
        out = _compress(_TESTS_ALL_PASS, exit_code=0)
        assert "Login Tests" in out

    def test_error_message_kept_on_failure(self) -> None:
        out = _compress(_TESTS_WITH_FAILURE, exit_code=1)
        assert "AssertionError: expected 500 to equal 200" in out

    def test_passing_test_with_error_in_name_kept(self) -> None:
        """Pass line whose name contains 'error' must survive the error guard."""
        tricky = f"    {_PASS_MARK} handles error responses gracefully (100ms)\n"
        out = _compress(tricky, exit_code=0)
        assert "handles error responses gracefully" in out

    def test_pass_note_emitted_on_success(self) -> None:
        out = _compress(_TESTS_ALL_PASS, exit_code=0)
        assert "suppressed" in out
        assert "passing test lines" in out

    def test_no_pass_note_when_exit_nonzero(self) -> None:
        """On a failed run no passing lines are suppressed, so no note."""
        out = _compress(_TESTS_ALL_PASS, exit_code=1)
        assert "passing test lines" not in out


# ===========================================================================
# 6. Run Finished summary is always kept
# ===========================================================================


class TestCypressFilterSummaryKept:
    """Everything inside the Run Finished section is preserved."""

    def test_run_finished_label_kept(self) -> None:
        out = _compress(_RUN_FINISHED_BLOCK)
        assert "(Run Finished)" in out

    def test_summary_box_top_kept(self) -> None:
        """Box-drawing borders in the Run Finished table must be kept."""
        out = _compress(_RUN_FINISHED_BLOCK)
        assert "┌" in out  # ┌ inside the summary table

    def test_all_specs_passed_kept(self) -> None:
        out = _compress(_FULL_SUCCESS_OUTPUT)
        assert "All specs passed!" in out

    def test_spec_row_kept(self) -> None:
        out = _compress(_RUN_FINISHED_BLOCK)
        assert "login.cy.ts" in out

    def test_savings_ratio_full_success(self) -> None:
        """Full-success output must achieve >= 40% line reduction."""
        result_text = _compress(_FULL_SUCCESS_OUTPUT, exit_code=0)
        original_lines = _FULL_SUCCESS_OUTPUT.count("\n")
        result_lines = result_text.count("\n")
        ratio = 1.0 - result_lines / max(original_lines, 1)
        assert ratio >= 0.40, f"Savings {ratio:.0%} < 40%"

    def test_empty_input_no_crash(self) -> None:
        out = _compress("", exit_code=0)
        assert isinstance(out, str)

    def test_stderr_merged(self) -> None:
        """Errors written to stderr must appear in the output."""
        out = _compress("", stderr="CypressError: No tests found\n", exit_code=1)
        assert "CypressError" in out

    def test_full_failure_error_details_kept(self) -> None:
        """On failure, the complete error context must survive."""
        out = _compress(_FULL_FAILURE_OUTPUT, exit_code=1)
        assert "AssertionError: expected 500 to equal 200" in out
        assert "fails on network error" in out
