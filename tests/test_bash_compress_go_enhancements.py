"""Tests for GoTestFilter iteration-105 enhancements."""
from __future__ import annotations

from token_goat.bash_compress import GoTestFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return GoTestFilter().compress(inp, "", 0, argv or ["go", "test", "./..."])


# ---------------------------------------------------------------------------
# === RUN / PAUSE / CONT suppression
# ---------------------------------------------------------------------------

class TestGoRunPauseContSuppression:
    def test_run_lines_suppressed(self) -> None:
        inp = "\n".join([
            "=== RUN   TestFoo",
            "--- PASS: TestFoo (0.00s)",
            "ok  github.com/org/pkg  0.001s",
        ])
        out = _compress(inp)
        # Assert the actual RUN line is absent (note text contains "=== RUN" — check lines only)
        assert not any(line.startswith("=== RUN") for line in out.splitlines())

    def test_pause_lines_suppressed(self) -> None:
        inp = "\n".join([
            "=== RUN   TestBar",
            "=== PAUSE TestBar",
            "=== CONT  TestBar",
            "--- PASS: TestBar (0.00s)",
            "ok  github.com/org/pkg  0.001s",
        ])
        out = _compress(inp)
        assert not any(line.startswith("=== PAUSE") for line in out.splitlines())

    def test_cont_lines_suppressed(self) -> None:
        inp = "\n".join([
            "=== RUN   TestBaz",
            "=== PAUSE TestBaz",
            "=== CONT  TestBaz",
            "--- PASS: TestBaz (0.00s)",
            "ok  github.com/org/pkg  0.001s",
        ])
        out = _compress(inp)
        assert not any(line.startswith("=== CONT") for line in out.splitlines())


# ---------------------------------------------------------------------------
# Package summary lines kept
# ---------------------------------------------------------------------------

class TestGoPackageSummaryLines:
    def test_ok_package_summary_kept(self) -> None:
        inp = "\n".join([
            "=== RUN   TestFoo",
            "--- PASS: TestFoo (0.00s)",
            "ok  github.com/org/pkg  0.123s",
        ])
        out = _compress(inp)
        assert "ok  github.com/org/pkg  0.123s" in out

    def test_fail_package_line_kept(self) -> None:
        inp = "\n".join([
            "=== RUN   TestFoo",
            "--- FAIL: TestFoo (0.01s)",
            "    foo_test.go:5: assertion failed",
            "FAIL\tgithub.com/org/pkg\t0.123s",
        ])
        out = _compress(inp)
        assert "FAIL\tgithub.com/org/pkg\t0.123s" in out


# ---------------------------------------------------------------------------
# Aggregate summary for multi-package runs
# ---------------------------------------------------------------------------

class TestGoAggregateMultiPackage:
    def test_aggregate_summary_two_packages(self) -> None:
        # Mixed pass/fail → aggregate line appended
        inp = "\n".join([
            "ok  github.com/org/pkga  0.1s",
            "FAIL\tgithub.com/org/pkgb\t0.2s",
            "FAIL",
        ])
        out = _compress(inp)
        assert "packages passed" in out
        assert "packages failed" in out

    def test_no_aggregate_single_package(self) -> None:
        inp = "ok  github.com/org/pkg  0.123s"
        out = _compress(inp)
        assert "packages passed" not in out
        assert "packages failed" not in out
