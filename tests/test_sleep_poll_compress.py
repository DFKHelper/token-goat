"""Tests for sleep / watch / poll-loop output suppression (Iter 16).

Covers:
  - _sleep_cmd_type: detects sleep N / Ns / Nm / Nh; rejects non-sleep, multi-arg
  - _watch_cmd_info: detects watch -n N / --interval N; extracts watched command
  - _is_poll_loop_cmd: detects while/until + sleep; rejects pure loops without sleep
  - post_bash integration: sleep with empty stdout → silent CONTINUE (no systemMessage)
  - post_bash integration: sleep with non-empty stdout → one-liner emitted
  - post_bash integration: watch -n 2 → suppressed with one-liner
  - post_bash integration: watch --interval 5 → suppressed with one-liner
  - post_bash integration: while/until + sleep → poll-loop one-liner
  - post_bash integration: echo hello (non-sleep) → not intercepted
  - post_bash integration: non-zero exit code sleep → passes through unchanged
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _is_poll_loop_cmd, _sleep_cmd_type, _watch_cmd_info
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_post_bash_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    stderr: str = "",
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


# ---------------------------------------------------------------------------
# _sleep_cmd_type unit tests
# ---------------------------------------------------------------------------


class TestSleepCmdType:
    def test_plain_integer(self):
        assert _sleep_cmd_type(["sleep", "5"]) == "sleep"

    def test_seconds_suffix(self):
        assert _sleep_cmd_type(["sleep", "30s"]) == "sleep"

    def test_minutes_suffix(self):
        assert _sleep_cmd_type(["sleep", "2m"]) == "sleep"

    def test_hours_suffix(self):
        assert _sleep_cmd_type(["sleep", "1h"]) == "sleep"

    def test_decimal_seconds(self):
        assert _sleep_cmd_type(["sleep", "0.5"]) == "sleep"

    def test_zero(self):
        assert _sleep_cmd_type(["sleep", "0"]) == "sleep"

    def test_non_sleep_cmd(self):
        assert _sleep_cmd_type(["echo", "hello"]) is None

    def test_empty_argv(self):
        assert _sleep_cmd_type([]) is None

    def test_sleep_no_arg(self):
        assert _sleep_cmd_type(["sleep"]) is None

    def test_sleep_multiple_args(self):
        # GNU sleep accepts multiple durations; we only target the single-arg form
        assert _sleep_cmd_type(["sleep", "1", "2"]) is None

    def test_sleep_invalid_duration(self):
        assert _sleep_cmd_type(["sleep", "abc"]) is None

    def test_windows_exe_suffix(self):
        assert _sleep_cmd_type(["sleep.exe", "5"]) == "sleep"

    def test_full_path(self):
        assert _sleep_cmd_type(["/usr/bin/sleep", "10"]) == "sleep"

    def test_sleep_infinity(self):
        assert _sleep_cmd_type(["sleep", "infinity"]) == "sleep"


# ---------------------------------------------------------------------------
# _watch_cmd_info unit tests
# ---------------------------------------------------------------------------


class TestWatchCmdInfo:
    def test_basic_watch(self):
        assert _watch_cmd_info(["watch", "./check.sh"]) == "./check.sh"

    def test_watch_n_flag(self):
        assert _watch_cmd_info(["watch", "-n", "2", "./check.sh"]) == "./check.sh"

    def test_watch_interval_flag(self):
        assert _watch_cmd_info(["watch", "--interval", "5", "./status.sh"]) == "./status.sh"

    def test_watch_mixed_flags(self):
        assert _watch_cmd_info(["watch", "-n", "1", "-d", "ls", "-la"]) == "ls -la"

    def test_watch_no_command(self):
        assert _watch_cmd_info(["watch", "-n", "5"]) is None

    def test_non_watch_cmd(self):
        assert _watch_cmd_info(["sleep", "5"]) is None

    def test_empty_argv(self):
        assert _watch_cmd_info([]) is None

    def test_watch_exe_suffix(self):
        assert _watch_cmd_info(["watch.exe", "-n", "3", "cmd"]) == "cmd"

    def test_watch_chgexit_boolean_flag(self):
        # --chgexit is a boolean flag (no argument); the command after it must be detected
        assert _watch_cmd_info(["watch", "--chgexit", "./check.sh"]) == "./check.sh"


# ---------------------------------------------------------------------------
# _is_poll_loop_cmd unit tests
# ---------------------------------------------------------------------------


class TestIsPollLoopCmd:
    def test_while_true_sleep(self):
        assert _is_poll_loop_cmd("while true; do sleep 1; done") is True

    def test_until_sleep(self):
        assert _is_poll_loop_cmd("until ./check.sh; do sleep 2; done") is True

    def test_while_with_break_and_sleep(self):
        assert _is_poll_loop_cmd("while true; do ./check.sh && break; sleep 2; done") is True

    def test_no_while_or_until(self):
        assert _is_poll_loop_cmd("sleep 5") is False

    def test_while_without_sleep(self):
        assert _is_poll_loop_cmd("while true; do echo hi; done") is False

    def test_plain_sleep(self):
        assert _is_poll_loop_cmd("sleep 30") is False

    def test_echo_cmd(self):
        assert _is_poll_loop_cmd("echo hello") is False


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------


class TestSleepSuppressIntegration:
    """post_bash integration tests for sleep / watch / poll-loop suppression."""

    def test_sleep_empty_stdout_silent(self, tmp_path, tmp_data_dir):
        """sleep with empty stdout → CONTINUE with no systemMessage."""
        sid = "sess-sp-1"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(sid, "sleep 5", "", str(tmp_path))
        result = hooks_read.post_bash(payload)
        assert result.get("continue") is True
        assert _sys_msg(result) == ""

    def test_sleep_nonempty_stdout_one_liner(self, tmp_path, tmp_data_dir):
        """sleep with non-empty stdout → one-liner systemMessage emitted."""
        sid = "sess-sp-2"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(sid, "sleep 30", "Sleeping 30 seconds...\n", str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat]" in msg
        assert "sleep 30" in msg
        assert "suppressed" in msg

    def test_watch_n_flag_suppressed(self, tmp_path, tmp_data_dir):
        """watch -n 2 ./check.sh → suppressed with one-liner containing the watched command."""
        sid = "sess-sp-3"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "watch -n 2 ./check.sh", "Every 2.0s: ./check.sh\nOK\n", str(tmp_path)
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] watch:" in msg
        assert "check.sh" in msg
        assert "suppressed" in msg

    def test_watch_interval_flag_suppressed(self, tmp_path, tmp_data_dir):
        """watch --interval 5 ./status.sh → suppressed with one-liner."""
        sid = "sess-sp-4"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "watch --interval 5 ./status.sh", "status: ok\n", str(tmp_path)
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] watch:" in msg
        assert "status.sh" in msg
        assert "suppressed" in msg

    def test_poll_loop_suppressed(self, tmp_path, tmp_data_dir):
        """while + sleep → poll-loop one-liner with exit code."""
        sid = "sess-sp-5"
        _bootstrap_session(sid)
        cmd = "while true; do sleep 1; done"
        payload = _make_post_bash_payload(sid, cmd, "iteration 1\niteration 2\n", str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] poll loop detected" in msg
        assert "condensed" in msg
        assert "exit code" in msg

    def test_echo_not_intercepted(self, tmp_path, tmp_data_dir):
        """echo hello (non-sleep command) → not intercepted by the sleep/watch/poll block."""
        sid = "sess-sp-6"
        _bootstrap_session(sid)
        # echo hello produces tiny output; the hook should NOT emit a sleep/watch message
        payload = _make_post_bash_payload(sid, "echo hello", "hello\n", str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "watch:" not in msg
        assert "poll loop detected" not in msg
        # "suppressed" might appear in other hook messages but the sleep block must not fire
        assert "sleep" not in msg.lower() or "token-goat" not in msg

    def test_sleep_nonzero_exit_passes_through(self, tmp_path, tmp_data_dir):
        """Non-zero exit code sleep → NOT intercepted; output passes through."""
        sid = "sess-sp-7"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "sleep 5", "", str(tmp_path), exit_code=1
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # The sleep/watch block must NOT fire for failed commands
        assert "poll loop" not in msg
        assert "watch:" not in msg
        # A failed sleep with empty output: no sleep-suppress one-liner
        assert "[token-goat] sleep" not in msg
