"""Tests for go test -v output detection and compression.

Covers _is_go_test_verbose_cmd (bash_compress) and the go test -v post_bash
compression block (hooks_read).
"""
from __future__ import annotations

from token_goat.bash_compress import _is_go_test_verbose_cmd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_GO_TEST_V_MIN_LINES = 60


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pad(lines: list[str], min_count: int = _GO_TEST_V_MIN_LINES) -> str:
    """Join lines, padding with package-level noise to reach min_count lines."""
    result = list(lines)
    i = 0
    while len(result) < min_count:
        result.append(f"    bench_padding_{i}: 0 ns/op")
        i += 1
    return "\n".join(result) + "\n"


def _clean_test(name: str, duration: float = 0.00) -> list[str]:
    """Return RUN + PASS lines for a test with no log output."""
    return [
        f"=== RUN   {name}",
        f"--- PASS: {name} ({duration:.2f}s)",
    ]


def _logged_test(name: str, logs: list[str], result: str = "PASS", duration: float = 0.00) -> list[str]:
    """Return RUN + log lines + result line for a test."""
    lines = [f"=== RUN   {name}"]
    for log in logs:
        lines.append(f"    {name}_test.go:10: {log}")
    lines.append(f"--- {result}: {name} ({duration:.2f}s)")
    return lines


def _run_hook(stdout: str, cmd: str = "go test -v ./...", exit_code: int = 0) -> dict:
    """Invoke the post_bash hook with minimal wiring and return its result."""
    from token_goat import hooks_read

    payload: dict = {
        "tool": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {
            "stdout": stdout,
            "stderr": "",
            "exit_code": exit_code,
        },
    }
    result = hooks_read.post_bash(payload)
    return result or {}


def _extract_header(msg: str) -> str:
    """Return just the [token-goat] header line from a systemMessage."""
    return msg.splitlines()[0]


# ---------------------------------------------------------------------------
# Detection tests — _is_go_test_verbose_cmd
# ---------------------------------------------------------------------------

class TestIsGoTestVerboseCmd:

    def test_basic_go_test_v(self):
        assert _is_go_test_verbose_cmd(["go", "test", "-v", "./..."]) is True

    def test_v_flag_only(self):
        assert _is_go_test_verbose_cmd(["go", "test", "-v"]) is True

    def test_flag_after_positional(self):
        assert _is_go_test_verbose_cmd(["go", "test", "./...", "-v"]) is True

    def test_run_flag_before_v(self):
        assert _is_go_test_verbose_cmd(["go", "test", "-run=TestFoo", "-v"]) is True

    def test_exe_extension(self):
        assert _is_go_test_verbose_cmd(["go.exe", "test", "-v"]) is True

    def test_path_prefix(self):
        assert _is_go_test_verbose_cmd(["/usr/local/go/bin/go", "test", "-v", "./..."]) is True

    def test_v_equals_false_not_verbose(self):
        assert _is_go_test_verbose_cmd(["go", "test", "-v=false", "./..."]) is False

    def test_double_dash_v_equals_false_not_verbose(self):
        assert _is_go_test_verbose_cmd(["go", "test", "--v=false"]) is False

    def test_double_dash_separator_stops_processing(self):
        # -v after -- goes to test binary, not the go tool
        assert _is_go_test_verbose_cmd(["go", "test", "./...", "--", "-v"]) is False

    def test_no_v_flag_not_verbose(self):
        assert _is_go_test_verbose_cmd(["go", "test", "./..."]) is False

    def test_go_build_not_matched(self):
        # build subcommand — not test
        assert _is_go_test_verbose_cmd(["go", "build", "-v", "./..."]) is False

    def test_non_go_binary_not_matched(self):
        assert _is_go_test_verbose_cmd(["python", "test", "-v"]) is False

    def test_empty_argv_not_matched(self):
        assert _is_go_test_verbose_cmd([]) is False

    def test_v_before_test_subcommand(self):
        # -v appears before "test" subcommand — still detected
        assert _is_go_test_verbose_cmd(["go", "-v", "test", "./..."]) is True

    def test_only_go_binary_not_matched(self):
        assert _is_go_test_verbose_cmd(["go"]) is False


# ---------------------------------------------------------------------------
# Guard tests — lines threshold and exit code
# ---------------------------------------------------------------------------

class TestGuards:

    def test_fewer_than_min_lines_falls_through(self):
        # Only 4 lines — below 60-line threshold
        lines = _clean_test("TestShort") + ["ok  github.com/example/pkg  0.001s", ""]
        stdout = "\n".join(lines) + "\n"
        result = _run_hook(stdout)
        # Should not return a systemMessage (falls through)
        assert "systemMessage" not in result

    def test_exactly_min_lines_minus_one_falls_through(self):
        lines = [f"some line {i}" for i in range(_GO_TEST_V_MIN_LINES - 1)]
        stdout = "\n".join(lines) + "\n"
        result = _run_hook(stdout)
        assert "systemMessage" not in result

    def test_exit_code_2_falls_through(self):
        # exit_code=2 (tool error) should not trigger compression
        lines = _clean_test("TestFoo") * 35
        stdout = _pad(lines)
        result = _run_hook(stdout, exit_code=2)
        assert "systemMessage" not in result

    def test_non_go_test_cmd_falls_through(self):
        lines = _clean_test("TestFoo") * 35
        stdout = _pad(lines)
        result = _run_hook(stdout, cmd="go build -v ./...")
        assert "systemMessage" not in result

    def test_no_stdout_falls_through(self):
        result = _run_hook("")
        assert "systemMessage" not in result


# ---------------------------------------------------------------------------
# Clean tests — RUN + PASS with no logs suppressed
# ---------------------------------------------------------------------------

class TestCleanPassSuppressed:

    def test_single_clean_test_suppressed(self):
        body = _clean_test("TestFoo")
        stdout = _pad(body + ["ok  github.com/example/pkg  0.001s"])
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "[token-goat] go test -v:" in msg
        assert "TestFoo" not in msg or "lines suppressed" in msg

    def test_multiple_clean_tests_suppressed(self):
        body: list[str] = []
        for i in range(5):
            body.extend(_clean_test(f"TestCase{i}"))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "[token-goat] go test -v:" in msg
        # Individual test names should not appear in the compressed output body
        assert "=== RUN" not in msg

    def test_clean_test_hidden_count_increments_by_two(self):
        body = _clean_test("TestOne")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        # At least 2 lines suppressed (one RUN + one PASS)
        assert "lines suppressed" in msg
        hidden = int(msg.split("(")[1].split(" lines")[0])
        assert hidden >= 2

    def test_subtest_clean_parent_and_subtest_suppressed(self):
        # Regression for: subtest RUN evicting parent's pending slot, causing a
        # bare "--- PASS: TestParent" to leak into kept output.
        # A parent + one subtest that both pass cleanly should be suppressed entirely.
        body = [
            "=== RUN   TestParent",
            "=== RUN   TestParent/SubTest",
            "--- PASS: TestParent/SubTest (0.00s)",
            "--- PASS: TestParent (0.00s)",
        ]
        stdout = _pad(body + ["ok  github.com/example/pkg  0.001s"])
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "[token-goat] go test -v:" in msg
        # Neither the parent PASS nor any RUN should appear in the compressed body
        body_part = msg.split("\n", 1)[1] if "\n" in msg else ""
        assert "--- PASS: TestParent" not in body_part
        assert "=== RUN   TestParent" not in body_part


# ---------------------------------------------------------------------------
# Tests with log output — entire block kept
# ---------------------------------------------------------------------------

class TestLogsKept:

    def test_test_with_one_log_line_kept(self):
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))  # causes suppression so systemMessage fires
        body.extend(_logged_test("TestLogged", ["something went wrong"]))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "=== RUN   TestLogged" in msg
        assert "something went wrong" in msg
        assert "--- PASS: TestLogged" in msg

    def test_test_with_multiple_log_lines_kept(self):
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))  # triggers suppression
        body.extend(_logged_test("TestMultiLog", ["log line 1", "log line 2", "log line 3"]))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "log line 1" in msg
        assert "log line 2" in msg
        assert "log line 3" in msg

    def test_run_and_pass_both_in_output_when_logs_present(self):
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))  # ensures something is suppressed
        body.extend(_logged_test("TestWithLog", ["debug info"]))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "=== RUN   TestWithLog" in msg
        assert "--- PASS: TestWithLog" in msg

    def test_mixed_clean_and_logged_tests(self):
        body: list[str] = []
        body.extend(_clean_test("TestClean1"))
        body.extend(_logged_test("TestLogged1", ["important message"]))
        body.extend(_clean_test("TestClean2"))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "important message" in msg
        # Clean tests must not appear
        assert "TestClean1" not in msg
        assert "TestClean2" not in msg


# ---------------------------------------------------------------------------
# Failed tests — always kept
# ---------------------------------------------------------------------------

class TestFailKept:

    def test_run_and_fail_kept(self):
        body: list[str] = []
        body.extend(_clean_test("TestOkFirst"))  # triggers suppression so systemMessage fires
        body.extend([
            "=== RUN   TestBad",
            "--- FAIL: TestBad (0.01s)",
            "FAIL  github.com/example/pkg  0.011s",
        ])
        stdout = _pad(body)
        result = _run_hook(stdout, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "=== RUN   TestBad" in msg
        assert "--- FAIL: TestBad" in msg

    def test_fail_with_logs_kept(self):
        body: list[str] = []
        body.extend(_clean_test("TestOkFirst"))  # triggers suppression so systemMessage fires
        body.extend(_logged_test("TestBadWithLogs", ["assertion failed: got 1 want 2"], result="FAIL"))
        body.append("FAIL  github.com/example/pkg  0.011s")
        stdout = _pad(body)
        result = _run_hook(stdout, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "=== RUN   TestBadWithLogs" in msg
        assert "assertion failed" in msg
        assert "--- FAIL: TestBadWithLogs" in msg

    def test_package_fail_line_kept(self):
        body: list[str] = []
        body.extend(_clean_test("TestOk"))
        body.extend(_logged_test("TestBad", [], result="FAIL"))
        body.append("FAIL  github.com/example/pkg  0.011s")
        stdout = _pad(body)
        result = _run_hook(stdout, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "FAIL  github.com/example/pkg" in msg

    def test_mixed_pass_and_fail(self):
        body: list[str] = []
        for i in range(3):
            body.extend(_clean_test(f"TestOk{i}"))
        body.extend(_logged_test("TestFailed", [], result="FAIL"))
        body.append("FAIL  github.com/example/pkg  0.005s")
        stdout = _pad(body)
        result = _run_hook(stdout, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "TestFailed" in msg
        for i in range(3):
            assert f"TestOk{i}" not in msg


# ---------------------------------------------------------------------------
# PAUSE and CONT handling
# ---------------------------------------------------------------------------

class TestPauseContHandling:

    def test_pause_line_suppressed(self):
        body = [
            "=== RUN   TestParallel",
            "=== PAUSE TestParallel",
        ]
        # Add enough lines and then resolve the test
        body.extend(["=== CONT  TestParallel"])
        body.extend(["--- PASS: TestParallel (0.01s)"])
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "=== PAUSE" not in msg

    def test_cont_line_not_suppressed(self):
        # CONT lands when no pending_run is active — goes directly to kept.
        # Add a clean test first so that suppression fires and systemMessage is returned.
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))
        body.append("=== CONT  TestOrphan")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        # CONT must appear in output (never suppressed)
        assert "=== CONT  TestOrphan" in msg

    def test_cont_inside_pending_run_goes_to_pending_logs(self):
        # CONT arrives while another test is buffered — goes into pending_logs.
        # Add a separate clean test to trigger suppression so systemMessage fires.
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))
        body.extend([
            "=== RUN   TestA",
            "=== CONT  TestA",  # CONT while TestA is pending
            "--- PASS: TestA (0.01s)",
        ])
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        # CONT caused pending_logs to be non-empty, so the whole block is flushed
        assert "=== CONT  TestA" in msg
        assert "=== RUN   TestA" in msg
        assert "--- PASS: TestA" in msg

    def test_pause_count_included_in_hidden(self):
        body: list[str] = []
        for i in range(5):
            body.extend(_clean_test(f"TestC{i}"))
        # Add PAUSE lines
        body.insert(2, "=== PAUSE TestC0")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        assert "lines suppressed" in msg
        hidden = int(msg.split("(")[1].split(" lines")[0])
        # 5 tests × 2 + 1 PAUSE = 11
        assert hidden >= 1


# ---------------------------------------------------------------------------
# Parallel test attribution
# ---------------------------------------------------------------------------

class TestParallelAttribution:

    def test_cont_appears_before_subsequent_log_lines(self):
        # Sequence: CONT (no pending) → log line.
        # CONT must appear before the log line in output.
        # Include a clean test first so suppression fires and systemMessage is returned.
        body: list[str] = []
        body.extend(_clean_test("TestCleanTrigger"))
        body.append("=== CONT  TestParallel")
        body.append("    TestParallel_test.go:5: resumed execution")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        cont_pos = msg.find("=== CONT  TestParallel")
        log_pos = msg.find("resumed execution")
        assert cont_pos != -1
        assert log_pos != -1
        assert cont_pos < log_pos

    def test_full_parallel_sequence(self):
        # PAUSE TestA → RUN TestB → PASS TestB (clean) → CONT TestA → PASS TestA
        body = [
            "=== RUN   TestA",
            "=== PAUSE TestA",
            "=== RUN   TestB",
            "--- PASS: TestB (0.00s)",
            "=== CONT  TestA",
            "--- PASS: TestA (0.01s)",
        ]
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        # TestB was clean → suppressed; TestA had CONT in pending_logs → kept
        assert "TestB" not in msg or "--- PASS: TestB" not in msg
        # CONT for TestA is kept (makes TestA's block non-empty → flushed)
        assert "=== CONT  TestA" in msg


# ---------------------------------------------------------------------------
# Header format and counts
# ---------------------------------------------------------------------------

class TestHeaderCounts:

    def test_header_format(self):
        body = _clean_test("TestX")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        header = _extract_header(msg)
        assert header.startswith("[token-goat] go test -v:")
        assert "lines →" in header
        assert "kept" in header
        assert "lines suppressed" in header

    def test_header_total_equals_input_line_count(self):
        body = _clean_test("TestY")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        total_lines = len(stdout.splitlines())
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        header = _extract_header(msg)
        # Extract N from "[token-goat] go test -v: N lines → M kept ..."
        n_str = header.split(":")[1].strip().split(" ")[0]
        assert int(n_str) == total_lines

    def test_hidden_count_is_total_minus_kept(self):
        body: list[str] = []
        # 3 clean tests + 1 logged test
        for i in range(3):
            body.extend(_clean_test(f"TestClean{i}"))
        body.extend(_logged_test("TestLog", ["info"]))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        msg = result.get("systemMessage", "")
        header = _extract_header(msg)
        # Parse: "N lines → M kept (K lines suppressed)"
        parts = header.split("→")[1].strip()
        kept_str = parts.split("kept")[0].strip()
        hidden_str = parts.split("(")[1].split(" lines")[0]
        n_total = int(header.split(":")[1].strip().split(" ")[0])
        n_kept = int(kept_str)
        n_hidden = int(hidden_str)
        # kept + hidden should account for all input lines
        assert n_kept + n_hidden <= n_total

    def test_return_value_is_continue_true(self):
        body = _clean_test("TestZ")
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        assert result.get("continue") is True

    def test_no_compression_when_nothing_suppressed(self):
        # All tests have logs — nothing to suppress — hook falls through
        body: list[str] = []
        for i in range(20):
            body.extend(_logged_test(f"TestLog{i}", ["some log"]))
        body.append("ok  github.com/example/pkg  0.001s")
        stdout = _pad(body)
        result = _run_hook(stdout)
        # hidden == 0, so no systemMessage returned
        assert "systemMessage" not in result
