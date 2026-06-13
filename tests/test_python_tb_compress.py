"""Tests for Python script traceback compression (Iter 31).

Covers:
- _is_python_script_cmd detection: positive and negative cases
- Guard conditions: exit code, line count, Traceback presence, pytest guard
- Content: last 15 lines in systemMessage, exception in header, bash-output hint
"""
from __future__ import annotations

from unittest.mock import patch

from token_goat.bash_compress import _PYTHON_BIN_RE, _is_python_script_cmd

# ---------------------------------------------------------------------------
# _PYTHON_BIN_RE — module-level regex tests
# ---------------------------------------------------------------------------


def test_python_bin_re_python():
    assert _PYTHON_BIN_RE.match("python")


def test_python_bin_re_python3():
    assert _PYTHON_BIN_RE.match("python3")


def test_python_bin_re_python3_12():
    assert _PYTHON_BIN_RE.match("python3.12")


def test_python_bin_re_py():
    assert _PYTHON_BIN_RE.match("py")


def test_python_bin_re_no_match_pytest():
    assert not _PYTHON_BIN_RE.match("pytest")


def test_python_bin_re_no_match_node():
    assert not _PYTHON_BIN_RE.match("node")


# ---------------------------------------------------------------------------
# _is_python_script_cmd — detection positive cases
# ---------------------------------------------------------------------------


def test_detect_python():
    assert _is_python_script_cmd(["python", "script.py"])


def test_detect_python3():
    assert _is_python_script_cmd(["python3", "script.py"])


def test_detect_python3_12():
    assert _is_python_script_cmd(["python3.12", "script.py"])


def test_detect_py():
    assert _is_python_script_cmd(["py", "script.py"])


def test_detect_python_exe():
    assert _is_python_script_cmd(["python.exe", "script.py"])


def test_detect_python3_exe():
    assert _is_python_script_cmd(["python3.exe", "script.py"])


def test_detect_direct_py_file():
    assert _is_python_script_cmd(["./myscript.py"])


def test_detect_direct_py_file_uppercase():
    # _base lowercases, so SCRIPT.PY → script.py
    assert _is_python_script_cmd(["C:\\path\\SCRIPT.PY"])


def test_detect_direct_py_file_windows_path():
    assert _is_python_script_cmd(["C:\\Users\\user\\project\\run.py", "--arg"])


def test_detect_quoted_path_windows():
    # shlex.split(posix=False) retains surrounding quotes on Windows; strip them before matching
    assert _is_python_script_cmd(['"C:\\Program Files\\Python312\\python.exe"'])


def test_detect_uv_run_python():
    assert _is_python_script_cmd(["uv", "run", "python", "script.py"])


def test_detect_uv_run_python3():
    assert _is_python_script_cmd(["uv", "run", "python3", "script.py"])


def test_detect_uv_run_python3_12():
    assert _is_python_script_cmd(["uv", "run", "python3.12", "script.py"])


def test_detect_uv_run_with_flags():
    # uv run --no-project python script.py
    assert _is_python_script_cmd(["uv", "run", "--no-project", "python", "script.py"])


# ---------------------------------------------------------------------------
# _is_python_script_cmd — detection negative cases
# ---------------------------------------------------------------------------


def test_detect_negative_pytest():
    assert not _is_python_script_cmd(["pytest", "tests/"])


def test_detect_negative_python_m_pytest():
    # python -m pytest should NOT be caught by _is_python_script_cmd alone;
    # the hook checks _is_pytest_command separately
    # but the function itself returns True for `python -m pytest` because
    # the binary IS python — the pytest guard is in hooks_read, not here.
    # So this is NOT a negative — detection function returns True for python binary.
    # The pytest guard in hooks_read prevents the block from firing.
    result = _is_python_script_cmd(["python", "-m", "pytest"])
    assert result is True  # detection passes; pytest guard is in hooks_read


def test_detect_negative_node():
    assert not _is_python_script_cmd(["node", "app.js"])


def test_detect_negative_cargo():
    assert not _is_python_script_cmd(["cargo", "run"])


def test_detect_negative_go():
    assert not _is_python_script_cmd(["go", "run", "."])


def test_detect_negative_empty():
    assert not _is_python_script_cmd([])


def test_detect_negative_uv_run_node():
    assert not _is_python_script_cmd(["uv", "run", "node", "app.js"])


def test_detect_negative_uv_run_missing_args():
    # "uv run" with no further tokens
    assert not _is_python_script_cmd(["uv", "run"])


# ---------------------------------------------------------------------------
# Hook-level compression guard tests
# ---------------------------------------------------------------------------


def _make_payload(
    command: str,
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 1,
    session_id: str | None = None,
) -> dict:
    """Build a minimal HookPayload-like dict for post_bash."""
    return {
        "session_id": session_id or "",
        "cwd": "/tmp",
        "tool_input": {"command": command},
        "tool_response": {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
        },
    }


def _make_stderr(n: int, exc: str = "ValueError: bad input") -> str:
    """Return a realistic Python traceback with exactly n total stderr lines."""
    header = "Traceback (most recent call last):"
    # header=1 line, exc=1 line, frames fill the rest
    frames = [f'  File "script.py", line {i}, in func_{i}' for i in range(1, n - 1)]
    result = "\n".join([header] + frames + [exc])
    assert len(result.splitlines()) == n, f"expected {n} lines, got {len(result.splitlines())}"
    return result


def _run_post_bash(payload: dict) -> dict:
    """Invoke post_bash with session/cache mocked out."""
    from token_goat.hooks_read import post_bash

    with (
        patch("token_goat.hooks_read._get_session", return_value=None),
        patch("token_goat.hooks_read._unwrap_compress_command", side_effect=lambda c: c),
        patch("token_goat.hooks_read._sanitize_surrogates", side_effect=lambda s: s),
        patch("token_goat.hooks_read._apply_output_size_cap", side_effect=lambda o, e: (o, e, False)),
        patch("token_goat.hooks_read._check_ignored_bash_hint"),
        patch("token_goat.hooks_read._is_recon_command", return_value=False),
    ):
        return post_bash(payload)


def test_guard_exit_code_zero_passes_through():
    """exit_code=0 should NOT trigger Python traceback compression."""
    stderr = _make_stderr(30)
    payload = _make_payload("python script.py", stderr=stderr, exit_code=0)
    result = _run_post_bash(payload)
    # Should not have our python crash message
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_exit_code_none_passes_through():
    """exit_code=None (timeout) should not trigger Python traceback compression."""
    stderr = _make_stderr(30)
    payload = _make_payload("python script.py", stderr=stderr, exit_code=None)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_too_few_stderr_lines():
    """Fewer than 25 stderr lines → passes through unchanged."""
    stderr = _make_stderr(20)
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_no_traceback_in_stderr():
    """stderr without 'Traceback' → not intercepted."""
    stderr = "\n".join(["Error: something went wrong"] * 30)
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_pytest_not_intercepted():
    """pytest invocations should not be intercepted by the Python traceback compressor."""
    stderr = _make_stderr(30)
    payload = _make_payload("pytest tests/", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_python_m_pytest_not_intercepted():
    """python -m pytest should be excluded by the pytest guard."""
    stderr = _make_stderr(30)
    payload = _make_payload("python -m pytest tests/", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


def test_guard_non_python_binary_not_intercepted():
    """Non-python commands with tracebacks should not be intercepted."""
    stderr = _make_stderr(30, exc="SomeError: crash")
    payload = _make_payload("node app.js", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" not in msg


# ---------------------------------------------------------------------------
# Content correctness tests
# ---------------------------------------------------------------------------


def test_content_fires_at_25_lines():
    """Exactly 25 stderr lines → compression fires."""
    stderr = _make_stderr(25, exc="RuntimeError: exactly 25 lines")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg


def test_content_exception_in_header():
    """Exception string from last non-empty line appears in header."""
    exc = "KeyError: 'missing_key'"
    stderr = _make_stderr(30, exc=exc)
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert exc in msg


def test_content_last_15_lines_kept():
    """Exactly 15 stderr tail lines appear in the systemMessage body."""
    stderr = _make_stderr(40, exc="TypeError: oops")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    # The tail should contain lines from the traceback body
    tail_lines = stderr.splitlines()[-15:]
    for line in tail_lines:
        assert line in msg


def test_content_suppressed_count_in_header():
    """Header reports correct total line count."""
    n = 35
    stderr = _make_stderr(n, exc="OSError: file not found")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert f"stderr: {n} lines" in msg


def test_content_arrow_in_header():
    """Header uses → 15 kept phrasing."""
    stderr = _make_stderr(30, exc="ValueError: test")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "→ 15 kept" in msg or "15 kept" in msg


def test_content_python3_fires():
    """python3 invocation also triggers compression."""
    stderr = _make_stderr(30, exc="ImportError: no module")
    payload = _make_payload("python3 script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg


def test_content_uv_run_python_fires():
    """uv run python also triggers compression."""
    stderr = _make_stderr(30, exc="AttributeError: bad attr")
    payload = _make_payload("uv run python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg


def test_content_direct_py_file_fires():
    """Direct .py invocation triggers compression."""
    stderr = _make_stderr(30, exc="SyntaxError: invalid syntax")
    payload = _make_payload("./myscript.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg


def test_content_no_bash_output_hint_without_session():
    """Without a session_id, no bash-output hint is included."""
    stderr = _make_stderr(30, exc="ValueError: no session")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1, session_id="")
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg
    assert "bash-output" not in msg


def test_content_continue_true():
    """The hook always returns continue: True."""
    stderr = _make_stderr(30, exc="RuntimeError: test")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=1)
    result = _run_post_bash(payload)
    assert result.get("continue") is True


def test_content_exit_code_2_fires():
    """Non-zero exit codes other than 1 also trigger compression."""
    stderr = _make_stderr(30, exc="SystemExit: 2")
    payload = _make_payload("python script.py", stderr=stderr, exit_code=2)
    result = _run_post_bash(payload)
    msg = result.get("systemMessage", "")
    assert "[token-goat] python crash:" in msg
