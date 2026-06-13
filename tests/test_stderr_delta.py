"""Tests for repeated-failure stderr delta (Iter 15).

Covers:
  1. First run (no prior entry): stderr passes through unchanged
  2. Second run identical stderr: suppressed with "N lines suppressed"
  3. Second run new stderr lines added: delta shows new lines
  4. Second run with some errors resolved: delta shows resolved lines
  5. exit_code == 0: not intercepted
  6. stderr < 300 bytes: not intercepted
  7. Small delta (< 8 lines total changed): full stderr passes through
  8. Non-failing prior run (exit_code=0): current failing run not intercepted
  9. Large delta (>= 8 lines): delta summary emitted with new/resolved sections
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Stderr large enough to clear the 300-byte gate.
_BIG_STDERR = (
    "FAILED tests/test_foo.py::test_alpha - AssertionError: expected 1 got 2\n"
    "FAILED tests/test_foo.py::test_beta  - AssertionError: expected 3 got 4\n"
    "FAILED tests/test_foo.py::test_gamma - AssertionError: expected 5 got 6\n"
    "FAILED tests/test_foo.py::test_delta - AssertionError: expected 7 got 8\n"
    "FAILED tests/test_foo.py::test_epsilon - AssertionError: expected 9 got 10\n"
    "short test session starts\n"
    "collected 5 items\n"
    "5 failed in 0.42s\n"
)

assert len(_BIG_STDERR) >= 300, "test constant must exceed _STDERR_DELTA_MIN_BYTES=300"

# A stderr with many unique new lines to trigger large-delta path (>= 8 total).
_LARGE_DELTA_NEW_LINES = "".join(
    f"FAILED tests/test_foo.py::test_new_{i} - AssertionError: brand new failure {i}\n"
    for i in range(10)
)


def _make_post_bash_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    stderr: str = "",
    exit_code: int = 1,
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
# Test cases
# ---------------------------------------------------------------------------

class TestStderrDeltaFirstRun:
    """First run: no prior cache entry, output passes through untouched."""

    def test_first_run_no_suppression(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-1"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "pytest tests/", "", str(tmp_path), stderr=_BIG_STDERR
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "suppressed" not in msg
        assert "stderr changed" not in msg
        assert "stderr identical" not in msg


class TestStderrDeltaIdentical:
    """Second run with identical stderr: suppressed with advisory."""

    def test_identical_stderr_suppressed(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-2"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "pytest tests/", "", str(tmp_path), stderr=_BIG_STDERR
        )
        # First run populates the cache
        hooks_read.post_bash(payload)
        # Second run: same stderr → should be suppressed
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "identical to prior run" in msg
        assert "suppressed" in msg

    def test_suppressed_message_includes_line_count(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-2b"
        _bootstrap_session(sid)
        payload = _make_post_bash_payload(
            sid, "pytest tests/", "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Should include the number of suppressed lines
        n_lines = len(_BIG_STDERR.splitlines())
        assert str(n_lines) in msg


class TestStderrDeltaNewLines:
    """Second run with new error lines: delta shows added lines."""

    def test_new_lines_show_in_delta(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-3"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload1)
        # Second run: adds 10 brand-new failure lines (delta >= 8 → summary)
        new_stderr = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=new_stderr
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "stderr changed vs prior run" in msg
        assert "new lines" in msg
        assert "--- New error lines ---" in msg

    def test_new_lines_count_accurate(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-3b"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload1)
        new_stderr = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=new_stderr
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        # 10 new lines were added
        assert "10 new lines" in msg


class TestStderrDeltaResolved:
    """Second run with some errors resolved: delta shows resolved lines."""

    def test_resolved_lines_show_in_delta(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-4"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        # First run: big stderr with many failures
        big_first = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=big_first
        )
        hooks_read.post_bash(payload1)
        # Second run: the "new" failures are gone (resolved), original failures remain
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "stderr changed vs prior run" in msg
        assert "prior error line(s) resolved" in msg


class TestStderrDeltaExitCodeZero:
    """exit_code == 0: delta never fires even if stderr looks large."""

    def test_success_not_intercepted(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-5"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        # First run: failure
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR, exit_code=1
        )
        hooks_read.post_bash(payload1)
        # Second run: same stderr but exit_code=0 (success)
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR, exit_code=0
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "stderr identical" not in msg
        assert "suppressed" not in msg


class TestStderrDeltaSmallStderr:
    """stderr < 300 bytes: delta never fires."""

    def test_small_stderr_not_intercepted(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-6"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        small_stderr = "FAILED tests/test_foo.py::test_x\n1 failed\n"
        assert len(small_stderr) < 300
        payload = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=small_stderr
        )
        hooks_read.post_bash(payload)
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Too small to trigger; should not emit delta advisory
        assert "stderr identical" not in msg
        assert "suppressed" not in msg


class TestStderrDeltaSmallDelta:
    """Small delta (< 8 total changed lines): full stderr passes through."""

    def test_small_delta_passes_through(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-7"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload1)
        # Add 3 unique new lines (delta = 3 < _STDERR_DELTA_SMALL=8)
        tiny_addition = (
            "FAILED tests/test_foo.py::test_new_1 - AssertionError: small delta\n"
            "FAILED tests/test_foo.py::test_new_2 - AssertionError: small delta\n"
            "FAILED tests/test_foo.py::test_new_3 - AssertionError: small delta\n"
        )
        new_stderr = _BIG_STDERR + tiny_addition
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=new_stderr
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        # Small delta: no summary emitted, full stderr passes through
        assert "stderr changed vs prior run" not in msg
        assert "stderr identical" not in msg


class TestStderrDeltaPriorSuccessNotIntercepted:
    """Prior run had exit_code=0: current failing run not intercepted by delta."""

    def test_prior_success_no_delta(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-8"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        # First run: success (exit_code=0), but stderr has content (e.g., warnings)
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR, exit_code=0
        )
        hooks_read.post_bash(payload1)
        # Second run: failure — but prior entry was a success, so no delta should fire
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR, exit_code=1
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "stderr identical" not in msg
        assert "suppressed" not in msg


class TestStderrDeltaLargeDelta:
    """Large delta (>= 8 changed lines): emits summary with new and resolved sections."""

    def test_large_delta_emits_summary(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-9"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload1)
        # 10 new unique lines guarantees delta >= 8
        new_stderr = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=new_stderr
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "[token-goat] stderr changed vs prior run" in msg
        assert "--- New error lines ---" in msg

    def test_resolved_section_present_when_errors_gone(self, tmp_path, tmp_data_dir):
        sid = "sess-sd-9b"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        # First: big stderr with extra lines
        first_stderr = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=first_stderr
        )
        hooks_read.post_bash(payload1)
        # Second: only the original big stderr (10 lines resolved, some remain)
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "prior error line(s) resolved" in msg

    def test_resolved_section_absent_when_only_additions(self, tmp_path, tmp_data_dir):
        """When only new lines appear (none resolved), resolved section is omitted."""
        sid = "sess-sd-9c"
        _bootstrap_session(sid)
        cmd = "pytest tests/"
        payload1 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=_BIG_STDERR
        )
        hooks_read.post_bash(payload1)
        # All original lines kept + 10 new ones → 0 resolved
        new_stderr = _BIG_STDERR + _LARGE_DELTA_NEW_LINES
        payload2 = _make_post_bash_payload(
            sid, cmd, "", str(tmp_path), stderr=new_stderr
        )
        result = hooks_read.post_bash(payload2)
        msg = _sys_msg(result)
        assert "prior error line(s) resolved" not in msg
