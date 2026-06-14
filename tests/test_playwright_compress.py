"""Tests for PlaywrightFilter — playwright test output compression."""
from __future__ import annotations

from token_goat.bash_compress import PlaywrightFilter

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_f = PlaywrightFilter()


def _compress(stdout: str = "", stderr: str = "", exit_code: int = 0, argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["playwright", "test"]
    return _f.compress(stdout, stderr, exit_code, argv)


def _pass_line(n: int = 1, browser: str = "chromium", spec: str = "tests/e2e.spec.ts", name: str = "should load") -> str:
    return f"  ✓  {n} [{browser}] › {spec}:3:1 › {name} (1.2s)\n"


def _fail_line(n: int = 1, browser: str = "chromium", spec: str = "tests/e2e.spec.ts", name: str = "should fail") -> str:
    return f"  ✗  {n} [{browser}] › {spec}:10:1 › {name} (2.3s)\n"


# ---------------------------------------------------------------------------
# TestPlaywrightFilterMatches
# ---------------------------------------------------------------------------


class TestPlaywrightFilterMatches:
    def test_playwright_test(self) -> None:
        assert _f.matches(["playwright", "test"])

    def test_playwright_test_with_flags(self) -> None:
        assert _f.matches(["playwright", "test", "--headed", "--workers=4"])

    def test_playwright_install(self) -> None:
        assert _f.matches(["playwright", "install"])

    def test_playwright_codegen(self) -> None:
        assert _f.matches(["playwright", "codegen"])

    def test_playwright_show_trace(self) -> None:
        assert _f.matches(["playwright", "show-trace"])

    def test_playwright_no_subcommand(self) -> None:
        # bare binary should match (help / default output)
        assert _f.matches(["playwright"])

    def test_playwright_exe(self) -> None:
        assert _f.matches(["playwright.exe", "test"])

    def test_npx_playwright_test(self) -> None:
        assert _f.matches(["npx", "playwright", "test"])

    def test_npx_with_flag_playwright_test(self) -> None:
        assert _f.matches(["npx", "--yes", "playwright", "test"])

    def test_bunx_playwright_test(self) -> None:
        assert _f.matches(["bunx", "playwright", "test"])

    def test_pnpx_playwright_test(self) -> None:
        assert _f.matches(["pnpx", "playwright", "test"])

    def test_playwright_publish_does_not_match(self) -> None:
        # "publish" is not in _SUBCMDS — should NOT match
        assert not _f.matches(["playwright", "publish"])

    def test_empty_argv(self) -> None:
        assert not _f.matches([])

    def test_unrelated_binary(self) -> None:
        assert not _f.matches(["pytest", "test"])

    def test_npx_not_playwright(self) -> None:
        assert not _f.matches(["npx", "jest", "--watch"])


# ---------------------------------------------------------------------------
# TestCompressPlaywrightPassLines
# ---------------------------------------------------------------------------


class TestCompressPlaywrightPassLines:
    def test_pass_line_suppressed(self) -> None:
        stdout = _pass_line(1)
        result = _compress(stdout=stdout)
        assert "✓" not in result

    def test_checkmark_variant_suppressed(self) -> None:
        # ✔ (U+2714) is an alternate checkmark used by some playwright reporters
        line = "  ✔  2 [firefox] › tests/foo.spec.ts:5:1 › alt mark (0.5s)\n"
        result = _compress(stdout=line)
        assert "✔" not in result

    def test_multiple_pass_lines_suppressed(self) -> None:
        stdout = "".join(_pass_line(i) for i in range(1, 51))
        result = _compress(stdout=stdout)
        assert "✓" not in result
        assert "suppressed 50" in result

    def test_fail_line_kept(self) -> None:
        stdout = _fail_line(3)
        result = _compress(stdout=stdout)
        assert "✗" in result

    def test_mixed_pass_and_fail(self) -> None:
        stdout = "".join(_pass_line(i) for i in range(1, 5)) + _fail_line(5) + "".join(_pass_line(i) for i in range(6, 10))
        result = _compress(stdout=stdout)
        assert "✗" in result
        assert "✓" not in result
        assert "suppressed 8" in result

    def test_header_kept(self) -> None:
        stdout = "Running 42 tests using 4 workers\n\n" + "".join(_pass_line(i) for i in range(1, 43))
        result = _compress(stdout=stdout)
        assert "Running 42 tests" in result
        assert "✓" not in result  # pass lines must be suppressed

    def test_summary_passed_kept(self) -> None:
        stdout = _pass_line(1) + "\n  1 passed (1.2s)\n"
        result = _compress(stdout=stdout)
        assert "1 passed" in result
        assert "✓" not in result  # pass line must be suppressed

    def test_summary_failed_kept(self) -> None:
        stdout = _fail_line(1) + "\n  1 failed\n  1 passed (2.3s)\n"
        result = _compress(stdout=stdout)
        assert "1 failed" in result
        assert "1 passed" in result

    def test_error_block_kept(self) -> None:
        error_block = (
            "\n    Error: expect(received).toBe(expected)\n"
            "\n    Expected: true\n    Received: false\n"
            "\n      > 5 |   expect(true).toBe(false);\n"
        )
        stdout = _fail_line(1) + error_block
        result = _compress(stdout=stdout)
        assert "Error: expect" in result
        assert "Expected: true" in result

    def test_no_suppression_note_when_nothing_suppressed(self) -> None:
        stdout = "Running 1 tests using 1 workers\n\n  1 failed\n"
        result = _compress(stdout=stdout)
        assert "suppressed" not in result


# ---------------------------------------------------------------------------
# TestCompressPlaywrightInstall
# ---------------------------------------------------------------------------


class TestCompressPlaywrightInstall:
    def test_download_line_suppressed(self) -> None:
        stdout = "Downloading Chromium 121.0.6167.57 (playwright build v1097) from https://playwright.azureedge.net/\n"
        result = _compress(stdout=stdout, argv=["playwright", "install"])
        assert "Downloading Chromium" not in result

    def test_progress_bar_suppressed(self) -> None:
        stdout = "111.2 Mb [====================] 100% 0.0s\n"
        result = _compress(stdout=stdout, argv=["playwright", "install"])
        assert "[===" not in result

    def test_install_line_suppressed(self) -> None:
        stdout = "Installing dependencies...\n"
        result = _compress(stdout=stdout, argv=["playwright", "install"])
        assert "Installing dependencies" not in result

    def test_downloaded_summary_suppressed(self) -> None:
        stdout = "Downloaded chromium v1097 to /home/user/.cache/ms-playwright/chromium-1097\n"
        result = _compress(stdout=stdout, argv=["playwright", "install"])
        assert "Downloaded chromium" not in result

    def test_non_download_line_kept(self) -> None:
        stdout = "Playwright Host validation warning:\n  Missing dependencies for Chromium\n"
        result = _compress(stdout=stdout, argv=["playwright", "install"])
        assert "Host validation warning" in result


# ---------------------------------------------------------------------------
# TestPlaywrightFilterRegressions
# ---------------------------------------------------------------------------


class TestPlaywrightFilterRegressions:
    def test_empty_output(self) -> None:
        result = _compress(stdout="", stderr="")
        assert isinstance(result, str)

    def test_stderr_merged_with_stdout(self) -> None:
        # Playwright sometimes writes pass/fail lines to stderr
        stderr = _fail_line(1)
        result = _compress(stdout="", stderr=stderr)
        assert "✗" in result

    def test_pass_line_without_leading_space_not_suppressed(self) -> None:
        # Only lines with leading whitespace + checkmark are suppressed
        line = "✓ this is a heading line not a test result\n"
        result = _compress(stdout=line)
        # Should NOT be suppressed — no leading space before checkmark
        assert "✓" in result

    def test_large_all_pass_suite(self) -> None:
        n = 500
        stdout = "Running 500 tests using 4 workers\n\n" + "".join(_pass_line(i) for i in range(1, n + 1)) + f"\n  {n} passed (45s)\n"
        result = _compress(stdout=stdout)
        assert "Running 500" in result
        assert f"{n} passed" in result
        assert "✓" not in result
        assert "suppressed 500" in result

    def test_retrying_line_kept(self) -> None:
        # Retry annotation lines should pass through
        line = "  ✗  1 [chromium] › tests/e2e.spec.ts:5:1 › slow test (timeout) - retry #1\n"
        result = _compress(stdout=line)
        assert "retry" in result
