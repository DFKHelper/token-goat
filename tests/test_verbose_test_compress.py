"""Tests for verbose pytest PASSED-line suppression.

Covers:
  - _is_verbose_test_cmd: detects pytest -v, pytest --verbose, uv run pytest -v,
    python -m pytest -v, python3 -m pytest -v → True
  - _is_verbose_test_cmd: plain pytest (no -v), rg, jest → False
  - _VERBOSE_TEST_MIN_LINES constant exported from hooks_read
  - post_bash: verbose pytest with all PASSED → PASSED lines suppressed
  - post_bash: verbose pytest with FAILED lines → FAILED lines preserved
  - post_bash: summary line preserved in compressed output
  - post_bash: short output (< 80 lines) → NOT compressed
  - post_bash: non-verbose pytest (no -v flag) → NOT compressed
  - post_bash: exit_code=2 (collection error) → NOT compressed
  - post_bash: "N PASSED lines suppressed" in systemMessage
  - post_bash: line count header in systemMessage
  - post_bash: bash-output recall hint when session active
  - post_bash: no session → no recall hint, still compresses
  - post_bash: zero PASSED lines → no compression (falls through)
"""
from __future__ import annotations

import uuid

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post_bash_payload(cmd: str, stdout: str, *, exit_code: int = 0, sid: str | None = None, cwd: str = "/proj"):
    return {
        "session_id": sid or "",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


def _make_verbose_pytest_stdout(*, n_passed: int = 90, n_failed: int = 0, include_failures_section: bool = False) -> str:
    """Build a realistic verbose pytest stdout blob."""
    lines: list[str] = [
        "============================= test session starts ==============================",
        "platform linux -- Python 3.12.0, pytest-8.0.0, pluggy-1.4.0",
        "rootdir: /proj",
        f"collected {n_passed + n_failed} items",
        "",
    ]
    for i in range(n_passed):
        lines.append(f"tests/test_foo.py::test_pass_{i} PASSED                          [ {i+1:2d}%]")
    for i in range(n_failed):
        lines.append(f"tests/test_foo.py::test_fail_{i} FAILED                          [{n_passed+i+1:3d}%]")
    lines.append("")
    if include_failures_section and n_failed:
        lines.append("=================================== FAILURES ===================================")
        for i in range(n_failed):
            lines.append(f"_________________________ test_fail_{i} _________________________")
            lines.append("")
            lines.append("    def test_fail_{i}():")
            lines.append("        assert False")
            lines.append("")
            lines.append("E       AssertionError: assert False")
            lines.append("")
    if n_failed:
        lines.append("=========================== short test summary info ============================")
        for i in range(n_failed):
            lines.append(f"FAILED tests/test_foo.py::test_fail_{i} - AssertionError: assert False")
    total_parts = []
    if n_failed:
        total_parts.append(f"{n_failed} failed")
    total_parts.append(f"{n_passed} passed")
    lines.append(f"========================= {', '.join(total_parts)} in 1.23s =========================")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# _is_verbose_test_cmd
# ---------------------------------------------------------------------------

class TestIsVerboseTestCmd:
    def _fn(self, argv):
        from token_goat.bash_compress import _is_verbose_test_cmd
        return _is_verbose_test_cmd(argv)

    def test_pytest_dash_v(self):
        assert self._fn(["pytest", "-v"]) is True

    def test_pytest_verbose_long(self):
        assert self._fn(["pytest", "--verbose"]) is True

    def test_pytest_vv(self):
        assert self._fn(["pytest", "-vv"]) is True

    def test_pytest_vvv(self):
        assert self._fn(["pytest", "-vvv"]) is True

    def test_uv_run_pytest_v(self):
        assert self._fn(["uv", "run", "pytest", "-v"]) is True

    def test_uv_run_pytest_verbose(self):
        assert self._fn(["uv", "run", "pytest", "--verbose"]) is True

    def test_python_m_pytest_v(self):
        assert self._fn(["python", "-m", "pytest", "-v"]) is True

    def test_python3_m_pytest_v(self):
        assert self._fn(["python3", "-m", "pytest", "-v"]) is True

    def test_pytest_no_v_false(self):
        assert self._fn(["pytest"]) is False

    def test_pytest_extra_flags_no_v_false(self):
        assert self._fn(["pytest", "--tb=short", "-x"]) is False

    def test_rg_false(self):
        assert self._fn(["rg", "PASSED"]) is False

    def test_jest_false(self):
        assert self._fn(["jest", "--verbose"]) is False

    def test_empty_false(self):
        assert self._fn([]) is False

    def test_uv_no_pytest_false(self):
        assert self._fn(["uv", "run", "ruff", "-v"]) is False

    def test_python_m_no_pytest_false(self):
        assert self._fn(["python", "-m", "mypy", "-v"]) is False


# ---------------------------------------------------------------------------
# Constant
# ---------------------------------------------------------------------------

def test_verbose_test_min_lines_constant():
    from token_goat.hooks_read import _VERBOSE_TEST_MIN_LINES
    assert _VERBOSE_TEST_MIN_LINES == 80


# ---------------------------------------------------------------------------
# post_bash integration
# ---------------------------------------------------------------------------

def test_passed_lines_suppressed_in_message(tmp_data_dir):
    """100-line verbose pytest with all PASSED → PASSED lines removed from systemMessage."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    assert len(stdout.splitlines()) >= 80  # pre-condition
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" in msg
    # No individual PASSED progress lines in compressed output
    for line in msg.splitlines():
        assert "PASSED" not in line or "suppressed" in line or "passed" in line.lower()


def test_failed_lines_preserved(tmp_data_dir):
    """FAILED lines must not be stripped from the compressed output."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=85, n_failed=3)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, exit_code=1))
    msg = resp.get("systemMessage", "")
    assert "FAILED" in msg


def test_summary_line_preserved(tmp_data_dir):
    """The final '= N passed in Xs =' summary line must appear in compressed output."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "passed" in msg.lower()
    assert "in 1.23s" in msg


def test_n_passed_suppressed_count_in_message(tmp_data_dir):
    """systemMessage must report how many PASSED lines were suppressed."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "90 PASSED lines suppressed" in msg


def test_line_count_header_in_message(tmp_data_dir):
    """systemMessage must include 'N lines → M kept' header."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    total = len(stdout.splitlines())
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert f"{total} lines" in msg
    assert "kept" in msg


def test_short_output_not_compressed(tmp_data_dir):
    """Output with fewer than 80 lines must pass through without suppression."""
    from token_goat.hooks_read import post_bash
    # Build a short verbose run (10 PASSED tests)
    stdout = _make_verbose_pytest_stdout(n_passed=10)
    assert len(stdout.splitlines()) < 80  # pre-condition
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" not in msg


def test_non_verbose_pytest_not_compressed(tmp_data_dir):
    """Plain 'pytest' without -v must not trigger verbose suppression."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" not in msg


def test_exit_code_2_not_compressed(tmp_data_dir):
    """exit_code=2 (collection error) must bypass verbose suppression."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, exit_code=2))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" not in msg


def test_recall_hint_when_session_active(tmp_data_dir):
    """When session is active, systemMessage must include bash-output recall hint."""
    from token_goat.hooks_read import post_bash
    sid = f"test-{uuid.uuid4().hex[:8]}"
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, sid=sid))
    msg = resp.get("systemMessage", "")
    assert "bash-output" in msg


def test_no_session_no_recall_hint_still_compresses(tmp_data_dir):
    """Without a session, no recall hint but suppression still fires."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, sid=None))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" in msg
    assert "bash-output" not in msg


def test_uv_run_pytest_v_compressed(tmp_data_dir):
    """uv run pytest -v should also trigger suppression."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("uv run pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" in msg


def test_python_m_pytest_v_compressed(tmp_data_dir):
    """python -m pytest -v should trigger suppression."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("python -m pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" in msg


def test_zero_passed_lines_no_compression(tmp_data_dir):
    """When output has no PASSED lines (all FAILED), do not emit verbose suppression message."""
    from token_goat.hooks_read import post_bash
    # Build output with only FAILED lines (no PASSED)
    lines = ["============================= test session starts =============================="]
    lines += ["platform linux -- Python 3.12.0"] * 2
    lines += ["collected 90 items", ""]
    for i in range(90):
        lines.append(f"tests/test_foo.py::test_fail_{i} FAILED                          [{i+1:3d}%]")
    lines += ["", "=========================== 90 failed in 2.34s ==========================="]
    stdout = "\n".join(lines)
    assert len(stdout.splitlines()) >= 80
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, exit_code=1))
    msg = resp.get("systemMessage", "")
    # No suppression because nothing to suppress
    assert "PASSED lines suppressed" not in msg


def test_failures_section_preserved(tmp_data_dir):
    """FAILURES section content must survive suppression."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=85, n_failed=2, include_failures_section=True)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout, exit_code=1))
    msg = resp.get("systemMessage", "")
    assert "FAILURES" in msg
    assert "AssertionError" in msg


def test_continue_always_true(tmp_data_dir):
    """Hook must always return {continue: True} — never block."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90)
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    assert resp.get("continue") is True


def test_trailing_newline_preserved(tmp_data_dir):
    """systemMessage filtered body must end with \\n when original stdout ended with \\n."""
    from token_goat.hooks_read import post_bash
    stdout = _make_verbose_pytest_stdout(n_passed=90) + "\n"
    assert stdout.endswith("\n")  # pre-condition: stdout has trailing newline
    resp = post_bash(_make_post_bash_payload("pytest -v", stdout))
    msg = resp.get("systemMessage", "")
    assert "PASSED lines suppressed" in msg  # compression fired
    # Strip the recall hint suffix (everything after the last newline that has "[Full output:")
    body = msg.split("[Full output:")[0] if "[Full output:" in msg else msg
    assert body.endswith("\n"), f"Expected trailing newline in body, got {body[-10]!r}"
