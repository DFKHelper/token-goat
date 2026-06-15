"""Tests for GoTestFilter — compress go test output."""
from __future__ import annotations

import token_goat.bash_compress as bc

# Minimum lines to defeat the ≤20-line passthrough threshold.
_PAD_COUNT = 25


def _run(lines: list[str]) -> str:
    """Call GoTestFilter.compress directly with stdout only."""
    f = bc.GoTestFilter()
    padded = list(lines)
    i = 0
    while len([ln for ln in padded if ln.strip()]) <= 20:
        padded.append(f"ok  github.com/pad/pkg{i}  0.00{i}s")
        i += 1
    return f.compress("\n".join(padded), "", 0, ["go", "test", "./..."])


def _run_exact(lines: list[str], *, stdout: str = "", stderr: str = "", argv: list[str] | None = None) -> str:
    """Call GoTestFilter.compress with exact lines — no padding."""
    f = bc.GoTestFilter()
    text = "\n".join(lines)
    return f.compress(stdout or text, stderr, 0, argv or ["go", "test", "./..."])


class TestGoTestFilterSuppression:
    """=== RUN and --- PASS lines are dropped; counts reported in notes."""

    def test_run_lines_suppressed(self) -> None:
        out = _run(["=== RUN   TestFoo", "--- PASS: TestFoo (0.01s)"])
        # The note mentions "RUN/PAUSE/CONT" so check no line starts with === RUN
        assert not any(ln.startswith("=== RUN") for ln in out.splitlines())

    def test_pause_lines_suppressed(self) -> None:
        out = _run(["=== PAUSE TestFoo", "--- PASS: TestFoo (0.01s)"])
        assert not any(ln.startswith("=== PAUSE") for ln in out.splitlines())

    def test_cont_lines_suppressed(self) -> None:
        out = _run(["=== CONT  TestFoo", "--- PASS: TestFoo (0.01s)"])
        assert not any(ln.startswith("=== CONT") for ln in out.splitlines())

    def test_pass_lines_suppressed(self) -> None:
        out = _run(["--- PASS: TestFoo (0.01s)", "--- PASS: TestBar (0.02s)"])
        assert "--- PASS:" not in out

    def test_pass_count_in_notes(self) -> None:
        out = _run(["--- PASS: TestFoo (0.01s)", "--- PASS: TestBar (0.02s)"])
        assert "2" in out
        assert "PASS" in out.lower() or "pass" in out.lower() or "collapsed" in out


class TestGoTestFilterKeeps:
    """Lines that must always survive compression."""

    def test_fail_line_kept(self) -> None:
        out = _run(["--- FAIL: TestBad (0.05s)"])
        assert "--- FAIL: TestBad" in out

    def test_ok_summary_kept(self) -> None:
        lines = ["=== RUN   TestFoo"] * 5 + ["--- PASS: TestFoo (0.01s)"] * 5
        lines += ["ok  github.com/foo/bar  0.123s"]
        out = _run(lines)
        assert "ok  github.com/foo/bar  0.123s" in out

    def test_fail_pkg_line_kept(self) -> None:
        out = _run(["--- FAIL: TestBad (0.05s)", "FAIL\tgithub.com/foo/bar\t0.456s"])
        assert "FAIL\tgithub.com/foo/bar" in out

    def test_panic_line_kept(self) -> None:
        out = _run(["panic: runtime error: index out of range"])
        assert "panic: runtime error" in out

    def test_goroutine_line_kept(self) -> None:
        # goroutine lines belong to panic/race stack traces
        out = _run(["panic: nil pointer", "goroutine 1 [running]:"])
        assert "goroutine 1 [running]:" in out


class TestGoTestFilterPassthrough:
    """Edge-case passthrough conditions."""

    def test_empty_output_passthrough(self) -> None:
        out = _run_exact([])
        assert out == ""

    def test_short_output_still_compressed(self) -> None:
        # GoTestFilter compresses even short output (no passthrough threshold)
        lines = ["=== RUN   TestFoo", "--- PASS: TestFoo (0.01s)", "ok  pkg  0.001s"]
        out = _run_exact(lines)
        assert not any(ln.startswith("=== RUN") for ln in out.splitlines())
        assert "--- PASS:" not in out

    def test_json_flag_passthrough(self) -> None:
        raw = '{"Action":"run","Test":"TestFoo"}\n{"Action":"pass","Test":"TestFoo"}'
        f = bc.GoTestFilter()
        out = f.compress(raw, "", 0, ["go", "test", "-json", "./..."])
        assert out == raw

    def test_non_test_subcommand_routes_to_go_filter(self) -> None:
        f = bc.select_filter(["go", "build", "./..."])
        assert f is not None
        assert f.name == "go"


class TestGoTestFilterDispatch:
    """Routing: go test → GoTestFilter; other go subcommands → GoFilter."""

    def test_go_test_routes_to_go_test(self) -> None:
        f = bc.select_filter(["go", "test", "./..."])
        assert f is not None
        assert f.name == "go-test"

    def test_go_test_v_routes_to_go_test(self) -> None:
        f = bc.select_filter(["go", "test", "-v", "./..."])
        assert f is not None
        assert f.name == "go-test"

    def test_go_run_does_not_route_to_go_test(self) -> None:
        f = bc.select_filter(["go", "run", "main.go"])
        assert f is not None
        assert f.name != "go-test"

    def test_go_test_before_go_filter_in_registry(self) -> None:
        names = [f.name for f in bc.FILTERS]
        assert names.index("go-test") < names.index("go")


class TestGoTestFilterRaceDetector:
    """Race detector block handling and goroutine frame collapsing."""

    def test_race_block_preserved(self) -> None:
        """Race blocks with WARNING: DATA RACE and ==================== are kept verbatim."""
        lines = [
            "==================",
            "WARNING: DATA RACE",
            "Write at 0x00c000045280 by goroutine 9:",
            "    runtime.acquirem()",
            "        /usr/local/go/src/runtime/proc.go:123 +0x4c",
            "==================",
        ]
        out = _run(lines)
        # All race block lines should be present
        assert "==================" in out
        assert "WARNING: DATA RACE" in out
        assert "Write at 0x00c000045280" in out
        assert "/usr/local/go/src/runtime/proc.go" in out

    def test_goroutine_frames_collapsed(self) -> None:
        """Race blocks with >5 goroutine frames collapse frames to first 5 + omit note."""
        lines = [
            "==================",
            "WARNING: DATA RACE",
            "Goroutine 9 (running):",
            "    frame1()",
            "    frame2()",
            "    frame3()",
            "    frame4()",
            "    frame5()",
            "    frame6()",
            "    frame7()",
            "    frame8()",
            "Previous read at 0x00c000045280:",
            "    prev_frame()",
            "==================",
        ]
        out = _run(lines)
        # First 5 frames under Goroutine 9 should be present
        assert "frame1()" in out
        assert "frame5()" in out
        # Frames 6 and 7 should be dropped
        assert "frame6()" not in out
        assert "frame7()" not in out
        # Omit marker should be present for collapsed frames
        assert "[token-goat: +3 goroutine frames omitted]" in out

    def test_failing_subtest_preserved(self) -> None:
        """Failing subtests like '--- FAIL: TestParent/SubTest' are kept."""
        lines = [
            "=== RUN   TestParent/SubTest",
            "--- FAIL: TestParent/SubTest (0.05s)",
            "    subtest_error_message.go:42: assertion failed",
        ]
        out = _run(lines)
        # The FAIL line must be kept
        assert "--- FAIL: TestParent/SubTest" in out
        # The error message should also be kept (indented continuation)
        assert "assertion failed" in out

    def test_skip_count_in_notes(self) -> None:
        """--- SKIP: lines are suppressed and count appears in notes."""
        lines = [
            "=== RUN   TestSkip1",
            "--- SKIP: TestSkip1 (0.00s) (reason: not applicable)",
            "=== RUN   TestSkip2",
            "--- SKIP: TestSkip2 (0.00s) (reason: not applicable)",
            "=== RUN   TestPass",
            "--- PASS: TestPass (0.01s)",
        ]
        out = _run(lines)
        # SKIP lines should not appear in output
        assert "--- SKIP:" not in out
        # But the count should be in notes
        assert "2" in out
        assert "skip" in out.lower()
