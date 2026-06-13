"""Tests for the large plain-text stdout fallback compressor (Iter 19).

The compressor fires in post_bash AFTER all specialized handlers when:
  - stdout is non-empty
  - stdout has >= _LARGE_STDOUT_LINE_THRESHOLD (200) lines
  - exit_code is None or 0

Failure exit codes pass through unchanged for debugging.
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.hooks_read import _LARGE_STDOUT_LINE_THRESHOLD
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_stdout(n: int) -> str:
    """Return plain-text stdout with exactly *n* distinct lines."""
    return "\n".join(f"output line {i}" for i in range(n))


def _make_payload(
    sid: str,
    cmd: str,
    stdout: str,
    *,
    stderr: str = "",
    exit_code: int | None = 0,
    cwd: str = "/tmp",
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


SID = "test-large-stdout-iter19"


# ---------------------------------------------------------------------------
# Unit: guard conditions
# ---------------------------------------------------------------------------

class TestGuardConditions:
    def test_small_stdout_not_intercepted(self):
        """stdout < 200 lines must NOT be compressed."""
        stdout = _make_stdout(_LARGE_STDOUT_LINE_THRESHOLD - 1)  # 199 lines
        payload = _make_payload("", "mycommand", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)

    def test_exact_threshold_compressed(self):
        """stdout == 200 lines must be compressed."""
        stdout = _make_stdout(_LARGE_STDOUT_LINE_THRESHOLD)  # exactly 200
        payload = _make_payload("", "mycommand", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" in _sys_msg(result)

    def test_large_stdout_exit_code_zero_compressed(self):
        """exit_code=0 with >= 200 lines must be compressed."""
        stdout = _make_stdout(250)
        payload = _make_payload("", "mycommand", stdout, exit_code=0)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" in _sys_msg(result)

    def test_large_stdout_exit_code_none_compressed(self):
        """exit_code=None (timeout/no-exit) with >= 200 lines must be compressed."""
        stdout = _make_stdout(250)
        payload = _make_payload("", "mycommand", stdout, exit_code=None)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" in _sys_msg(result)

    def test_large_stdout_exit_code_nonzero_not_compressed(self):
        """exit_code=1 must NOT be compressed — pass through for debugging."""
        stdout = _make_stdout(250)
        payload = _make_payload("", "mycommand", stdout, exit_code=1)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)

    def test_large_stdout_exit_code_2_not_compressed(self):
        """Any non-zero exit code must skip compression."""
        stdout = _make_stdout(300)
        payload = _make_payload("", "mycommand", stdout, exit_code=2)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)

    def test_empty_stdout_not_intercepted(self):
        """Empty stdout must not trigger the compressor."""
        payload = _make_payload("", "mycommand", "", exit_code=0)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)


# ---------------------------------------------------------------------------
# Unit: systemMessage content
# ---------------------------------------------------------------------------

class TestSystemMessageContent:
    def setup_method(self):
        self.n = 250
        self.lines = [f"output line {i}" for i in range(self.n)]
        self.stdout = "\n".join(self.lines)
        payload = _make_payload("", "build --verbose", self.stdout)
        self.result = hooks_read.post_bash(payload)
        self.msg = _sys_msg(self.result)

    def test_total_line_count_in_message(self):
        """systemMessage must report the total line count."""
        assert "250 lines" in self.msg

    def test_first_ten_lines_present(self):
        """First 10 lines must appear verbatim in the systemMessage."""
        for i in range(10):
            assert self.lines[i] in self.msg

    def test_line_index_10_not_in_head(self):
        """Line 11 (index 10) must NOT appear in the head; it is in neither head nor tail."""
        # head is indices 0-9, tail is indices 245-249; index 10 appears nowhere
        assert "output line 10\n" not in self.msg
        # The exact string "output line 10" could appear as part of "output line 100" etc.
        # Be precise: look for the standalone line (it shouldn't be in a 250-line output's tail)
        assert self.lines[10] not in self.msg

    def test_last_five_lines_present(self):
        """Last 5 lines must appear verbatim in the systemMessage."""
        for i in range(245, 250):
            assert self.lines[i] in self.msg

    def test_omitted_count_correct(self):
        """Separator must show 250 - 15 = 235 omitted lines."""
        assert "235 lines omitted" in self.msg

    def test_continue_flag_set(self):
        """Result must carry continue: True so the hook chain continues."""
        assert self.result.get("continue") is True


# ---------------------------------------------------------------------------
# Unit: bash-output recall hint
# ---------------------------------------------------------------------------

class TestBashOutputRecallHint:
    def test_no_session_id_no_recall_hint(self):
        """With no session_id, the recall hint must be absent."""
        stdout = _make_stdout(200)
        payload = _make_payload("", "mycommand", stdout)
        result = hooks_read.post_bash(payload)
        assert "bash-output" not in _sys_msg(result)

    def test_with_session_id_includes_bash_output_hint(self, tmp_path):
        """With a valid session_id, systemMessage must include 'bash-output <id>'."""
        _bootstrap_session(SID)
        stdout = _make_stdout(200)
        payload = _make_payload(SID, "make build", stdout, cwd=str(tmp_path))
        result = hooks_read.post_bash(payload)
        assert "bash-output" in _sys_msg(result)


# ---------------------------------------------------------------------------
# Integration: post_bash with various line counts
# ---------------------------------------------------------------------------

class TestIntegration:
    def test_250_line_stdout_compressed(self):
        """post_bash with 250-line plain stdout must return a compression systemMessage."""
        stdout = _make_stdout(250)
        payload = _make_payload("", "make build", stdout)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] large output:" in msg
        assert "250 lines" in msg

    def test_150_line_stdout_not_compressed(self):
        """post_bash with 150-line stdout must NOT trigger the large-stdout compressor."""
        stdout = _make_stdout(150)
        payload = _make_payload("", "cargo build", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)

    def test_200_line_boundary_compressed(self):
        """Exactly 200 lines is at the threshold — must be compressed."""
        stdout = _make_stdout(200)
        payload = _make_payload("", "mycommand", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" in _sys_msg(result)

    def test_199_line_boundary_not_compressed(self):
        """199 lines is one below the threshold — must NOT be compressed."""
        stdout = _make_stdout(199)
        payload = _make_payload("", "mycommand", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" not in _sys_msg(result)

    def test_large_byte_output_still_compressed(self):
        """200-line output with long lines (> 8 KB total) must still be compressed.
        Regression: a len(stdout) < 8192 byte cap excluded most real build logs."""
        long_line = "x" * 200  # 200 chars per line → ~40 KB total
        stdout = "\n".join(long_line for _ in range(200))
        assert len(stdout) > 8_192, "fixture too small — test is invalid"
        payload = _make_payload("", "make build", stdout)
        result = hooks_read.post_bash(payload)
        assert "[token-goat] large output:" in _sys_msg(result)

    def test_no_session_message_says_preview_not_stored(self):
        """With no session_id, message must say 'preview' not 'stored'.
        Regression: the original code always said 'stored' even when caching was skipped."""
        stdout = _make_stdout(200)
        payload = _make_payload("", "mycommand", stdout)  # session_id=""
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "large output:" in msg
        assert "stored" not in msg
        assert "preview" in msg
