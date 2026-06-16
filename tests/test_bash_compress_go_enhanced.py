"""Tests for GoTestFilter enhanced compression (iteration-116)."""
from __future__ import annotations

from token_goat.bash_compress import GoTestFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return GoTestFilter().compress(inp, "", 0, argv or ["go", "test", "./..."])


# ---------------------------------------------------------------------------
# === RUN / PAUSE / CONT suppression (unconditional)
# ---------------------------------------------------------------------------


class TestRunPauseContSuppressed:
    def test_run_suppressed(self) -> None:
        inp = "=== RUN   TestAlpha\n--- PASS: TestAlpha (0.00s)\nok  github.com/x/pkg  0.001s"
        lines = _compress(inp).splitlines()
        assert not any(ln.startswith("=== RUN") for ln in lines)

    def test_pause_suppressed(self) -> None:
        inp = "=== RUN   TestBeta\n=== PAUSE TestBeta\n=== CONT  TestBeta\n--- PASS: TestBeta (0.00s)\nok  github.com/x/pkg  0.001s"
        lines = _compress(inp).splitlines()
        assert not any(ln.startswith("=== PAUSE") for ln in lines)

    def test_cont_suppressed(self) -> None:
        inp = "=== RUN   TestGamma\n=== PAUSE TestGamma\n=== CONT  TestGamma\n--- PASS: TestGamma (0.00s)\nok  github.com/x/pkg  0.001s"
        lines = _compress(inp).splitlines()
        assert not any(ln.startswith("=== CONT") for ln in lines)

    def test_rpc_suppressed_inside_failing_package(self) -> None:
        # RUN/PAUSE/CONT must be suppressed even when surrounded by fail output
        inp = "\n".join([
            "=== RUN   TestFail",
            "=== PAUSE TestFail",
            "=== CONT  TestFail",
            "--- FAIL: TestFail (0.01s)",
            "    fail_test.go:10: boom",
            "FAIL\tgithub.com/x/pkg\t0.01s",
        ])
        lines = _compress(inp).splitlines()
        assert not any(
            ln.startswith("=== RUN") or ln.startswith("=== PAUSE") or ln.startswith("=== CONT")
            for ln in lines
        )


# ---------------------------------------------------------------------------
# Package summary lines preserved
# ---------------------------------------------------------------------------


class TestPackageSummaryPreserved:
    def test_ok_summary_kept(self) -> None:
        inp = "=== RUN   TestX\n--- PASS: TestX (0.00s)\nok  github.com/org/pkg  0.3s"
        assert "ok  github.com/org/pkg  0.3s" in _compress(inp)

    def test_fail_pkg_line_kept(self) -> None:
        inp = "\n".join([
            "=== RUN   TestX",
            "--- FAIL: TestX (0.01s)",
            "    x_test.go:5: oops",
            "FAIL\tgithub.com/org/pkg\t0.01s",
        ])
        assert "FAIL\tgithub.com/org/pkg\t0.01s" in _compress(inp)


# ---------------------------------------------------------------------------
# Failing package: keep --- FAIL + output, suppress --- PASS
# ---------------------------------------------------------------------------


class TestFailingPackageOutput:
    def test_fail_block_kept(self) -> None:
        inp = "\n".join([
            "--- FAIL: TestBad (0.05s)",
            "    bad_test.go:12: expected true, got false",
            "FAIL\tgithub.com/x/pkg\t0.05s",
        ])
        out = _compress(inp)
        assert "--- FAIL: TestBad" in out
        assert "expected true, got false" in out

    def test_pass_suppressed_within_failing_package(self) -> None:
        # A package with both passing and failing tests: --- PASS suppressed
        inp = "\n".join([
            "--- PASS: TestOk (0.00s)",
            "--- FAIL: TestBad (0.05s)",
            "    bad_test.go:12: boom",
            "FAIL\tgithub.com/x/pkg\t0.05s",
        ])
        out = _compress(inp)
        assert "--- PASS: TestOk" not in out
        assert "--- FAIL: TestBad" in out

    def test_fail_output_lines_preserved(self) -> None:
        inp = "\n".join([
            "--- FAIL: TestX (0.01s)",
            "    panic: nil pointer",
            "    goroutine 1 [running]:",
            "FAIL\tgithub.com/x/pkg\t0.01s",
        ])
        out = _compress(inp)
        assert "panic: nil pointer" in out


# ---------------------------------------------------------------------------
# Aggregate summary: multi-package vs single-package
# ---------------------------------------------------------------------------


class TestAggregateMultiPackage:
    def test_mixed_pass_fail_aggregate(self) -> None:
        inp = "\n".join([
            "ok  github.com/x/pkga  0.1s",
            "FAIL\tgithub.com/x/pkgb\t0.2s",
            "FAIL",
        ])
        out = _compress(inp)
        assert "1 packages passed" in out
        assert "1 packages failed" in out

    def test_all_pass_multi_package_aggregate(self) -> None:
        # All packages pass → aggregate still emitted for multi-package
        inp = "\n".join([
            "ok  github.com/x/pkga  0.1s",
            "ok  github.com/x/pkgb  0.2s",
            "ok  github.com/x/pkgc  0.3s",
        ])
        out = _compress(inp)
        assert "3 packages passed" in out
        assert "0 packages failed" in out

    def test_all_fail_multi_package_aggregate(self) -> None:
        # All packages fail → aggregate emitted
        inp = "\n".join([
            "--- FAIL: TestA (0.01s)",
            "    a_test.go:1: err",
            "FAIL\tgithub.com/x/pkga\t0.01s",
            "--- FAIL: TestB (0.01s)",
            "    b_test.go:1: err",
            "FAIL\tgithub.com/x/pkgb\t0.01s",
            "FAIL",
        ])
        out = _compress(inp)
        assert "0 packages passed" in out
        assert "2 packages failed" in out

    def test_exactly_two_packages_aggregate(self) -> None:
        inp = "\n".join([
            "ok  github.com/x/pkga  0.1s",
            "ok  github.com/x/pkgb  0.2s",
        ])
        out = _compress(inp)
        assert "packages passed" in out

    def test_single_package_no_aggregate(self) -> None:
        inp = "ok  github.com/x/pkg  0.3s"
        out = _compress(inp)
        assert "packages passed" not in out
        assert "packages failed" not in out

    def test_single_failing_package_no_aggregate(self) -> None:
        inp = "\n".join([
            "--- FAIL: TestX (0.01s)",
            "    x_test.go:1: fail",
            "FAIL\tgithub.com/x/pkg\t0.01s",
            "FAIL",
        ])
        out = _compress(inp)
        assert "packages passed" not in out
        assert "packages failed" not in out
