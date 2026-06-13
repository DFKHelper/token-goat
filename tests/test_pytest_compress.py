"""Tests for pytest failure traceback suppression (Iter 18).

Covers:
  - _compress_pytest_failures: unit tests for the compression helper
  - post_bash integration: guard conditions, cache storage, non-pytest bypass
"""
from __future__ import annotations

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_failures_output(n_failures: int, *, extra_bytes: int = 0) -> str:
    """Build realistic pytest output with n_failures inside a FAILURES section."""
    lines = [
        "=========================== test session starts ============================\n",
        "collected 4 items\n",
        "\n",
        "================================ FAILURES =================================\n",
    ]
    for i in range(1, n_failures + 1):
        lines.append(f"____________________ test_func_{i} ____________________\n")
        lines.append("\n")
        lines.append(f"    def test_func_{i}():\n")
        lines.append(f">       assert {i} == 0\n")
        lines.append(f"E       AssertionError: assert {i} == 0\n")
        lines.append("\n")
        lines.append(f"tests/test_example.py:{i * 5}: AssertionError\n")
    lines.append("==================== short test summary info ====================\n")
    for i in range(1, n_failures + 1):
        lines.append(f"FAILED tests/test_example.py::test_func_{i} - AssertionError\n")
    passed = 3
    lines.append(f"=========== {n_failures} failed, {passed} passed in 0.45s ===========\n")
    result = "".join(lines)
    if extra_bytes:
        result += "x" * extra_bytes
    return result


def _make_post_bash_payload(sid, cmd, stdout, *, exit_code=1, cwd="/proj"):
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


def _large_failures_output(n: int = 1) -> str:
    """Return failures output that is >= 2000 bytes."""
    return _make_failures_output(n, extra_bytes=2000)


# ---------------------------------------------------------------------------
# Unit: _compress_pytest_failures
# ---------------------------------------------------------------------------

class TestCompressPytestFailures:
    @pytest.fixture(autouse=True)
    def _import(self):
        from token_goat.hooks_read import _compress_pytest_failures
        self.fn = _compress_pytest_failures

    def test_no_failed_marker_returns_same_object(self):
        stdout = "3 passed in 0.12s\n"
        result = self.fn(stdout, None)
        assert result is stdout

    def test_no_traceback_seps_returns_same_object(self):
        # Has FAILED but no ___ sep lines (e.g. only the short summary)
        stdout = "FAILED tests/test_foo.py::test_bar\n1 failed in 0.5s\n"
        result = self.fn(stdout, None)
        assert result is stdout

    def test_single_failure_header_present(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, None)
        assert "[token-goat] pytest: 1 failure detected" in result

    def test_single_failure_uses_singular(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, None)
        assert "1 failure detected" in result
        assert "1 failures detected" not in result

    def test_traceback_body_suppressed(self):
        stdout = _make_failures_output(1)
        assert "assert 1 == 0" in stdout  # sanity: body is in input
        result = self.fn(stdout, None)
        assert "assert 1 == 0" not in result

    def test_stub_line_present(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, None)
        assert "traceback omitted" in result
        assert "test_func_1" in result

    def test_summary_line_preserved(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, None)
        assert "1 failed" in result
        assert "passed in" in result

    def test_short_test_summary_preserved(self):
        stdout = _make_failures_output(2)
        result = self.fn(stdout, None)
        assert "FAILED tests/test_example.py::test_func_1" in result
        assert "FAILED tests/test_example.py::test_func_2" in result

    def test_three_failures_header_count(self):
        stdout = _make_failures_output(3)
        result = self.fn(stdout, None)
        assert "3 failures detected" in result

    def test_three_failures_uses_plural(self):
        stdout = _make_failures_output(3)
        result = self.fn(stdout, None)
        assert "3 failures detected" in result

    def test_output_id_in_header(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, "abc123xyz")
        assert "bash-output abc123xyz" in result

    def test_output_id_none_no_recall_hint(self):
        stdout = self.fn(_make_failures_output(1), None)
        assert "bash-output" not in stdout

    def test_section_header_kept(self):
        stdout = _make_failures_output(1)
        result = self.fn(stdout, None)
        # The FAILURES section header and short test summary headers must survive
        assert "FAILURES" in result
        assert "short test summary" in result


# ---------------------------------------------------------------------------
# Integration: post_bash guard conditions
# ---------------------------------------------------------------------------

class TestPostBashPytestCompress:
    def test_short_output_not_compressed(self, tmp_data_dir):
        """Output < 2000 bytes with failures passes through without traceback compression."""
        from token_goat.hooks_read import post_bash
        stdout = _make_failures_output(1)  # no extra_bytes → well under 2000
        assert len(stdout) < 2000, f"fixture unexpectedly large: {len(stdout)}"
        payload = _make_post_bash_payload("pc-short", "pytest tests/", stdout)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "tracebacks suppressed" not in msg

    def test_large_failures_compressed(self, tmp_data_dir):
        """Output >= 2000 bytes with FAILED markers is compressed."""
        from token_goat.hooks_read import post_bash
        stdout = _large_failures_output(1)
        assert len(stdout) >= 2000
        payload = _make_post_bash_payload("pc-large", "pytest tests/", stdout)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "tracebacks suppressed" in msg

    def test_exit_code_1_intercepted(self, tmp_data_dir):
        """pytest exit code 1 (failures present) is intercepted by compression."""
        from token_goat.hooks_read import post_bash
        stdout = _large_failures_output(1)
        payload = _make_post_bash_payload("pc-exit1", "pytest tests/", stdout, exit_code=1)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "tracebacks suppressed" in msg

    def test_recall_id_in_system_message(self, tmp_data_dir):
        """bash-output <id> is present in systemMessage when session stores the output."""
        from token_goat.hooks_read import post_bash
        stdout = _large_failures_output(1)
        payload = _make_post_bash_payload("pc-recall", "pytest tests/", stdout)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "bash-output" in msg

    def test_non_pytest_command_not_intercepted(self, tmp_data_dir):
        """A non-pytest command with FAILED in stdout is not compressed."""
        from token_goat.hooks_read import post_bash
        stdout = _large_failures_output(1)
        payload = _make_post_bash_payload("pc-nopty", "rg FAILED src/", stdout, exit_code=0)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "tracebacks suppressed" not in msg

    def test_large_output_no_failures_not_intercepted(self, tmp_data_dir):
        """Large pytest output with no FAILED markers is not compressed."""
        from token_goat.hooks_read import post_bash
        stdout = "3 passed in 0.12s\n" + "x" * 2100
        payload = _make_post_bash_payload("pc-nofail", "pytest tests/", stdout, exit_code=0)
        result = post_bash(payload)
        msg = result.get("systemMessage") or ""
        assert "tracebacks suppressed" not in msg
