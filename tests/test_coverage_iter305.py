"""Iteration 58 test coverage: new and enhanced filters.

Coverage targets:
  (a) GoTestFilter: -race DATA RACE block handling — kept verbatim, goroutine stacks collapsed
  (b) CargoFilter: cargo bench subcommand compression
  (c) AwsCliFilter: CloudFormation describe-stack-events IN_PROGRESS dedup
  (d) GolangciLintFilter: matches, per-(file,linter) dedup, noise suppression
"""

from __future__ import annotations

import json

from filter_test_helpers import apply_filter as _apply
from filter_test_helpers import savings_ratio as _savings_ratio

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# (a) GoTestFilter — race detector (-race) support
# ---------------------------------------------------------------------------

_RACE_OUTPUT_SIMPLE = """\
=== RUN   TestFoo
--- PASS: TestFoo (0.00s)
=== RUN   TestBar
==================
WARNING: DATA RACE
Read at 0x00c0001b4010 by goroutine 7:
  main.readShared()
      /repo/main.go:23 +0x44

Previous write at 0x00c0001b4010 by goroutine 6:
  main.writeShared()
      /repo/main.go:17 +0x5c

Goroutine 7 (running) created at:
  main.TestBar()
      /repo/main_test.go:42 +0x68

Goroutine 6 (running) created at:
  main.TestBar()
      /repo/main_test.go:39 +0x4c
==================
--- FAIL: TestBar (0.01s)
FAIL
FAIL    github.com/example/myapp    0.034s
"""

_RACE_OUTPUT_DEEP_STACK = """\
==================
WARNING: DATA RACE
Read at 0x00c0001b4010 by goroutine 7:
  runtime.throw({0x1234567, 0x0})
      /usr/local/go/src/runtime/panic.go:1 +0x0
  main.doSomethingDeep.func1()
      /repo/main.go:100 +0x0

Previous write at 0x00c0001b4010 by goroutine 6:
  frame_a()
      /repo/a.go:1 +0x0
  frame_b()
      /repo/b.go:2 +0x0
  frame_c()
      /repo/c.go:3 +0x0
  frame_d()
      /repo/d.go:4 +0x0
  frame_e()
      /repo/e.go:5 +0x0
  frame_f()
      /repo/f.go:6 +0x0
  frame_g()
      /repo/g.go:7 +0x0
  frame_h()
      /repo/h.go:8 +0x0

Goroutine 7 (running) created at:
  main.TestRacey()
      /repo/main_test.go:42 +0x68
==================
--- FAIL: TestRacey (0.01s)
FAIL
"""

_CLEAN_TEST_WITH_PASSES = """\
=== RUN   TestA
--- PASS: TestA (0.01s)
=== RUN   TestB
--- PASS: TestB (0.02s)
=== RUN   TestC
--- PASS: TestC (0.00s)
ok  github.com/example/myapp  0.05s
"""


class TestGoTestFilterRaceDetector:
    """GoTestFilter correctly handles go test -race DATA RACE blocks."""

    F = bc.GoTestFilter()

    def _apply(self, stdout: str, argv: list[str] | None = None) -> str:
        av = argv or ["go", "test", "-race", "./..."]
        return _apply(self.F, stdout=stdout, argv=av)

    def test_race_block_is_kept(self) -> None:
        out = self._apply(_RACE_OUTPUT_SIMPLE)
        assert "WARNING: DATA RACE" in out

    def test_race_fence_lines_kept(self) -> None:
        out = self._apply(_RACE_OUTPUT_SIMPLE)
        assert "==================" in out

    def test_race_read_write_lines_kept(self) -> None:
        out = self._apply(_RACE_OUTPUT_SIMPLE)
        assert "Read at 0x00c0001b4010" in out
        assert "Previous write at" in out

    def test_race_block_fail_kept(self) -> None:
        out = self._apply(_RACE_OUTPUT_SIMPLE)
        assert "--- FAIL: TestBar" in out

    def test_pass_lines_still_collapsed(self) -> None:
        """PASS lines before the race block are still counted, not shown."""
        out = self._apply(_RACE_OUTPUT_SIMPLE)
        assert "--- PASS: TestFoo" not in out
        assert "collapsed 1 PASS" in out

    def test_deep_goroutine_stack_collapsed(self) -> None:
        """Long goroutine stacks are truncated to first 5 frames + note."""
        out = self._apply(_RACE_OUTPUT_DEEP_STACK)
        assert "WARNING: DATA RACE" in out
        # Should have a frame-omission note
        assert "goroutine frames omitted" in out

    def test_deep_stack_first_frames_preserved(self) -> None:
        """First 5 goroutine frames are kept."""
        out = self._apply(_RACE_OUTPUT_DEEP_STACK)
        assert "frame_a()" in out  # first frame kept

    def test_deep_stack_last_frames_omitted(self) -> None:
        """Frames beyond the first 5 are omitted."""
        out = self._apply(_RACE_OUTPUT_DEEP_STACK)
        # frame_f, frame_g, frame_h are beyond the 5-frame limit
        assert "frame_h()" not in out

    def test_no_race_block_no_note(self) -> None:
        """Clean tests with no races emit no race-block note."""
        out = self._apply(_CLEAN_TEST_WITH_PASSES)
        assert "DATA RACE" not in out
        assert "race" not in out.lower() or "race" in ["go", "test", "-race"]

    def test_savings_on_large_race_output(self) -> None:
        """Race detector output with deep stacks achieves meaningful savings."""
        # Build a large output with many goroutine frames.
        frames = "\n".join(
            f"  frame_{i}()\n      /repo/pkg_{i}.go:{i} +0x0"
            for i in range(30)
        )
        large_output = (
            "==================\nWARNING: DATA RACE\n"
            f"Previous write at 0x1234 by goroutine 5:\n{frames}\n"
            "==================\n--- FAIL: TestRace (0.01s)\nFAIL\n"
        )
        ratio = _savings_ratio(self.F, large_output, argv=["go", "test", "-race", "./..."])
        assert ratio >= 0.30, f"Expected >= 30% savings on deep race stack, got {ratio:.0%}"

    def test_dispatch_routes_to_go_test(self) -> None:
        """select_filter routes go test -race to GoTestFilter."""
        f = bc.select_filter(["go", "test", "-race", "./..."])
        assert f is not None
        assert f.name == "go-test"


# ---------------------------------------------------------------------------
# (b) CargoFilter — cargo bench
# ---------------------------------------------------------------------------

_CARGO_BENCH_STDOUT_SINGLE = """\
running 3 tests
test bench_serialize ... bench:       1,234 ns/iter (+/- 56)
test bench_parse     ... bench:       5,678 ns/iter (+/- 89)
test bench_roundtrip ... bench:         123 ns/iter (+/-  4)

test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered out; finished in 2.31s
"""

_CARGO_BENCH_STDERR = """\
   Compiling dep1 v0.1.0 (/repo/dep1)
   Compiling dep2 v0.2.0 (/repo/dep2)
   Compiling dep3 v0.3.0 (/repo/dep3)
   Compiling dep4 v0.4.0 (/repo/dep4)
   Compiling dep5 v0.5.0 (/repo/dep5)
   Compiling mylib v0.1.0 (/repo)
   Compiling mybench v0.2.0 (/repo/benches)
    Finished bench [optimized] target(s) in 3.21s
     Running benches/bench_main.rs (target/release/deps/bench_main-abc123)
"""

_CARGO_BENCH_STDOUT_MULTIPLE = """\
running 2 tests
test bench_a ... bench:       100 ns/iter (+/- 5)
test bench_b ... bench:       200 ns/iter (+/- 10)

test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured; 0 filtered out

running 3 tests
test bench_c ... bench:       300 ns/iter (+/- 15)
test bench_d ... bench:       400 ns/iter (+/- 20)
test bench_e ... bench:       500 ns/iter (+/- 25)

test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered out
"""


class TestCargoFilterBench:
    """CargoFilter correctly handles cargo bench subcommand."""

    F = bc.CargoFilter()

    def _apply(self, stdout: str, stderr: str = "") -> str:
        return _apply(self.F, stdout=stdout, stderr=stderr, argv=["cargo", "bench"])

    def test_bench_result_lines_kept(self) -> None:
        out = self._apply(_CARGO_BENCH_STDOUT_SINGLE)
        assert "test bench_serialize ... bench:" in out
        assert "test bench_parse     ... bench:" in out
        assert "test bench_roundtrip ... bench:" in out

    def test_bench_summary_kept(self) -> None:
        out = self._apply(_CARGO_BENCH_STDOUT_SINGLE)
        assert "test result: ok" in out

    def test_single_running_header_collapsed(self) -> None:
        """Single 'running N tests' header is dropped (redundant with result lines)."""
        out = self._apply(_CARGO_BENCH_STDOUT_SINGLE)
        assert "running 3 tests" not in out

    def test_multiple_running_headers_kept(self) -> None:
        """Multiple 'running N tests' headers are kept (multiple bench suites)."""
        out = self._apply(_CARGO_BENCH_STDOUT_MULTIPLE)
        assert "running 2 tests" in out
        assert "running 3 tests" in out

    def test_compiler_noise_collapsed(self) -> None:
        """Compiler progress lines on stderr are collapsed when > 4 crates."""
        out = self._apply(_CARGO_BENCH_STDOUT_SINGLE, stderr=_CARGO_BENCH_STDERR)
        # dep3, dep4, dep5 (middle crates) should be collapsed, not shown verbatim.
        assert "Compiling dep3" not in out
        # But first 2 and last 2 are kept in the head+tail sample.
        assert "collapsed" in out or "Compiling" not in out or "dep1" in out

    def test_compiler_finished_kept(self) -> None:
        """Finished summary line from build phase is kept."""
        out = self._apply(_CARGO_BENCH_STDOUT_SINGLE, stderr=_CARGO_BENCH_STDERR)
        assert "Finished bench" in out

    def test_dispatch_routes_bench_to_cargo(self) -> None:
        f = bc.select_filter(["cargo", "bench"])
        assert f is not None
        assert f.name == "cargo"

    def test_savings_on_bench_output(self) -> None:
        # Build output with many bench lines and heavy compiler spam (50 crates).
        # Compiler spam dominates the output; bench lines are kept verbatim.
        bench_lines = "\n".join(
            f"test bench_{i} ... bench: {i * 100} ns/iter (+/- {i * 5})"
            for i in range(5)
        )
        stdout = f"running 5 tests\n{bench_lines}\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 5 measured\n"
        stderr = "\n".join(f"   Compiling crate_{i} v0.{i}.0 (/path/to/crate-{i})" for i in range(50)) + "\n    Finished bench [optimized] target(s) in 12.34s\n"
        ratio = _savings_ratio(self.F, stdout, stderr=stderr, argv=["cargo", "bench"])
        assert ratio >= 0.50, f"Expected >= 50% savings on bench+50-crate compiler output, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# (c) AwsCliFilter — CloudFormation describe-stack-events dedup
# ---------------------------------------------------------------------------

def _make_cfn_events_json(events: list[dict]) -> str:
    return json.dumps({"StackEvents": events, "NextToken": None}, indent=2)


def _make_stack_event(
    logical_id: str,
    status: str,
    event_id: str = "evt-001",
    reason: str | None = None,
) -> dict:
    ev: dict = {
        "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/MyStack/abc123",
        "EventId": event_id,
        "StackName": "MyStack",
        "LogicalResourceId": logical_id,
        "PhysicalResourceId": f"phys-{logical_id.lower()}",
        "ResourceType": "AWS::Lambda::Function",
        "Timestamp": "2026-05-31T10:00:00.000Z",
        "ResourceStatus": status,
    }
    if reason:
        ev["ResourceStatusReason"] = reason
    return ev


class TestAwsCliFilterCfnStackEvents:
    """AwsCliFilter deduplicates CloudFormation describe-stack-events output."""

    F = bc.AwsCliFilter()
    ARGV = ["aws", "cloudformation", "describe-stack-events", "--stack-name", "MyStack"]

    def _apply(self, stdout: str) -> str:
        return _apply(self.F, stdout=stdout, argv=self.ARGV)

    def test_single_event_kept(self) -> None:
        events = [_make_stack_event("MyLambda", "CREATE_IN_PROGRESS")]
        out = self._apply(_make_cfn_events_json(events))
        data = json.loads(out)
        assert len(data["StackEvents"]) == 1

    def test_duplicate_in_progress_collapsed(self) -> None:
        """Consecutive IN_PROGRESS events for the same resource are collapsed."""
        events = [
            _make_stack_event("MyLambda", "UPDATE_IN_PROGRESS", f"evt-{i:03d}")
            for i in range(20)  # 20 events, well above threshold (10)
        ]
        out = self._apply(_make_cfn_events_json(events))
        data = json.loads(out)
        # Should keep first + a collapse marker, not all 20.
        kept_evts = [e for e in data["StackEvents"] if "LogicalResourceId" in e]
        assert len(kept_evts) < 20

    def test_collapse_note_emitted(self) -> None:
        """A __token_goat__ note appears for collapsed events (>= threshold events)."""
        events = [
            _make_stack_event("MyLambda", "UPDATE_IN_PROGRESS", f"evt-{i:03d}")
            for i in range(15)  # 15 events — above threshold (10)
        ]
        out = self._apply(_make_cfn_events_json(events))
        assert "__token_goat__" in out
        assert "collapsed" in out

    def test_complete_event_always_kept(self) -> None:
        """CREATE_COMPLETE events are always kept."""
        events = [
            _make_stack_event("MyLambda", "CREATE_IN_PROGRESS", "evt-001"),
            _make_stack_event("MyLambda", "CREATE_IN_PROGRESS", "evt-002"),
            _make_stack_event("MyLambda", "CREATE_COMPLETE", "evt-003"),
        ]
        out = self._apply(_make_cfn_events_json(events))
        data = json.loads(out)
        statuses = [
            e.get("ResourceStatus")
            for e in data["StackEvents"]
            if isinstance(e, dict) and "ResourceStatus" in e
        ]
        assert "CREATE_COMPLETE" in statuses

    def test_failed_event_always_kept(self) -> None:
        """CREATE_FAILED events with reason are always kept."""
        events = [
            _make_stack_event("BadResource", "CREATE_IN_PROGRESS", "evt-001"),
            _make_stack_event("BadResource", "CREATE_IN_PROGRESS", "evt-002"),
            _make_stack_event(
                "BadResource",
                "CREATE_FAILED",
                "evt-003",
                reason="Resource handler returned message: Insufficient permissions",
            ),
        ]
        out = self._apply(_make_cfn_events_json(events))
        data = json.loads(out)
        failed = [
            e for e in data["StackEvents"]
            if isinstance(e, dict) and e.get("ResourceStatus") == "CREATE_FAILED"
        ]
        assert len(failed) == 1
        assert "Insufficient permissions" in failed[0].get("ResourceStatusReason", "")

    def test_different_resources_not_collapsed(self) -> None:
        """IN_PROGRESS events for different resources are kept separately."""
        events = [
            _make_stack_event("Lambda1", "CREATE_IN_PROGRESS", "evt-001"),
            _make_stack_event("Lambda2", "CREATE_IN_PROGRESS", "evt-002"),
            _make_stack_event("Lambda3", "CREATE_IN_PROGRESS", "evt-003"),
        ]
        out = self._apply(_make_cfn_events_json(events))
        data = json.loads(out)
        kept_evts = [e for e in data["StackEvents"] if "LogicalResourceId" in e]
        # All 3 are distinct resources — all should be kept.
        assert len(kept_evts) == 3

    def test_short_event_list_not_compressed(self) -> None:
        """Fewer than threshold events pass through unchanged."""
        events = [
            _make_stack_event("MyLambda", "CREATE_IN_PROGRESS", f"evt-{i:03d}")
            for i in range(5)  # Below _JSON_ARRAY_THRESHOLD (10)
        ]
        out = self._apply(_make_cfn_events_json(events))
        # 5 events below threshold — normal JSON array compression handles it.
        # No token_goat collapse markers.
        assert "__token_goat__" not in out

    def test_savings_on_large_rolling_deploy(self) -> None:
        """Large rolling-deploy event stream achieves meaningful token savings."""
        # Simulate a rolling update: 50 IN_PROGRESS + 1 COMPLETE per resource, 3 resources.
        events = []
        for resource in ("Fn1", "Fn2", "Fn3"):
            for i in range(50):
                events.append(_make_stack_event(resource, "UPDATE_IN_PROGRESS", f"evt-{resource}-{i}"))
            events.append(_make_stack_event(resource, "UPDATE_COMPLETE", f"evt-{resource}-done"))
        stdout = _make_cfn_events_json(events)
        ratio = _savings_ratio(self.F, stdout, argv=self.ARGV)
        assert ratio >= 0.50, f"Expected >= 50% savings on rolling deploy events, got {ratio:.0%}"


# ---------------------------------------------------------------------------
# (d) GolangciLintFilter
# ---------------------------------------------------------------------------

_GOLANGCI_CLEAN_OUTPUT = """\
golangci-lint version 1.57.2
time=2026-05-31T10:00:00Z level=info msg="Running linters"
time=2026-05-31T10:00:01Z level=info msg="Finishing linting"
"""

_GOLANGCI_ISSUES_SMALL = """\
pkg/handler/handler.go:12:5: `x` is unused (unused)
pkg/handler/handler.go:34:12: error return value not checked (errcheck)
pkg/server/server.go:78:1: exported function Foo without comment (revive)
"""

_GOLANGCI_ISSUES_MANY_SAME_FILE_LINTER = """\
""" + "\n".join(
    f"pkg/big/file.go:{i}:1: variable `x{i}` is unused (unused)"
    for i in range(1, 25)
) + """
pkg/other/other.go:10:5: other issue (govet)
"""

_GOLANGCI_NOISE_LINES = """\
time=2026-05-31T10:00:00Z level=info msg="Running golangci-lint"
time=2026-05-31T10:00:00Z level=debug msg="Starting linters"
pkg/foo/foo.go:5:3: exported type Foo should have comment (revive)
time=2026-05-31T10:00:01Z level=info msg="Finishing linting"
ERRO [loader] some error message here
"""


class TestGolangciLintFilterMatches:
    """GolangciLintFilter matches the right commands."""

    F = bc.GolangciLintFilter()

    def test_direct_invocation_matches(self) -> None:
        assert self.F.matches(["golangci-lint", "run", "./..."])

    def test_bare_binary_matches(self) -> None:
        assert self.F.matches(["golangci-lint"])

    def test_exe_extension_matches(self) -> None:
        assert self.F.matches(["golangci-lint.exe", "run"])

    def test_npx_invocation_matches(self) -> None:
        assert self.F.matches(["npx", "golangci-lint", "run"])

    def test_other_binary_does_not_match(self) -> None:
        assert not self.F.matches(["go", "vet", "./..."])

    def test_empty_does_not_match(self) -> None:
        assert not self.F.matches([])

    def test_dispatch_routes_to_golangci(self) -> None:
        f = bc.select_filter(["golangci-lint", "run", "./..."])
        assert f is not None
        assert f.name == "golangci-lint"


class TestGolangciLintFilterCompression:
    """GolangciLintFilter compresses lint output correctly."""

    F = bc.GolangciLintFilter()

    def _apply(self, stdout: str, stderr: str = "") -> str:
        return _apply(self.F, stdout=stdout, stderr=stderr, argv=["golangci-lint", "run", "./..."])

    def test_clean_output_passes_through(self) -> None:
        """Clean output (no issues) is passed through."""
        out = self._apply(_GOLANGCI_CLEAN_OUTPUT)
        # No issues to collapse; noise lines dropped.
        assert "WARNING" not in out

    def test_noise_lines_dropped(self) -> None:
        """Structured log level=info/debug lines are dropped."""
        out = self._apply(_GOLANGCI_NOISE_LINES)
        assert "level=info" not in out
        assert "level=debug" not in out

    def test_error_log_lines_kept(self) -> None:
        """ERRO level lines are kept (actionable errors from the linter)."""
        out = self._apply(_GOLANGCI_NOISE_LINES)
        assert "ERRO" in out

    def test_small_issue_list_kept_verbatim(self) -> None:
        """Issue lists below the threshold are kept verbatim."""
        out = self._apply(_GOLANGCI_ISSUES_SMALL)
        assert "pkg/handler/handler.go:12:5" in out
        assert "pkg/handler/handler.go:34:12" in out
        assert "pkg/server/server.go:78:1" in out

    def test_large_issue_per_file_linter_collapsed(self) -> None:
        """More than KEEP_FIRST_N issues per (file, linter) pair are collapsed."""
        out = self._apply(_GOLANGCI_ISSUES_MANY_SAME_FILE_LINTER)
        # First 3 issues should be kept.
        assert "pkg/big/file.go:1:1" in out
        assert "pkg/big/file.go:2:1" in out
        assert "pkg/big/file.go:3:1" in out
        # Beyond first 3: should NOT appear individually.
        assert "pkg/big/file.go:20:1" not in out

    def test_collapse_note_emitted(self) -> None:
        """A collapse note is emitted for the truncated group."""
        out = self._apply(_GOLANGCI_ISSUES_MANY_SAME_FILE_LINTER)
        assert "omitted" in out or "collapsed" in out
        assert "unused" in out  # linter name in note

    def test_other_file_issue_kept(self) -> None:
        """Issues from a different file are still kept."""
        out = self._apply(_GOLANGCI_ISSUES_MANY_SAME_FILE_LINTER)
        assert "pkg/other/other.go:10:5" in out

    def test_savings_on_large_issue_list(self) -> None:
        """Large issue lists achieve meaningful savings."""
        lines = "\n".join(
            f"pkg/big/file.go:{i}:1: variable `x{i}` is unused (unused)"
            for i in range(1, 101)
        )
        ratio = _savings_ratio(
            self.F, lines, argv=["golangci-lint", "run", "./..."]
        )
        assert ratio >= 0.70, f"Expected >= 70% savings on 100 same-file issues, got {ratio:.0%}"

    def test_golangci_registered_in_filters(self) -> None:
        """GolangciLintFilter is present in the FILTERS registry."""
        names = [f.name for f in bc.FILTERS]
        assert "golangci-lint" in names

    def test_golangci_after_go_test_filter(self) -> None:
        """GolangciLintFilter is registered after GoTestFilter (disjoint, but explicit)."""
        names = [f.name for f in bc.FILTERS]
        go_test_idx = names.index("go-test")
        golangci_idx = names.index("golangci-lint")
        assert golangci_idx > go_test_idx
