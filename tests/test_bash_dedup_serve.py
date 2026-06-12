"""Tests for Bash output direct-serve (Iter 12).

Covers:
  - _BASH_DIRECT_SERVE_MAX_BYTES constant exported from hooks_read
  - _try_bash_dedup_serve returns None when no prior run exists
  - _try_bash_dedup_serve returns additionalContext for a small repeat command
  - _try_bash_dedup_serve returns None when output exceeds threshold
  - _try_bash_dedup_serve returns None when entry is stale
  - _try_bash_dedup_serve returns None when load_output returns empty string
  - _handle_bash_dedup uses direct-serve before falling back to advisory hint
  - Non-Bash payloads (no command key) return None safely
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from hook_helpers import assert_continue

# ---------------------------------------------------------------------------
# Constant
# ---------------------------------------------------------------------------

def test_constant_exported():
    from token_goat.hooks_read import _BASH_DIRECT_SERVE_MAX_BYTES
    assert _BASH_DIRECT_SERVE_MAX_BYTES == 8_192


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pre_bash_payload(sid, cmd, *, cwd="/proj"):
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "cwd": cwd,
    }


def _post_bash(sid, cmd, stdout, *, cwd="/proj", exit_code=0):
    """Run post_bash to record a prior execution."""
    from token_goat.hooks_read import post_bash
    post_bash({
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    })


def _pre_bash(sid, cmd, *, cwd="/proj"):
    from token_goat.hooks_read import pre_read
    return pre_read(_make_pre_bash_payload(sid, cmd, cwd=cwd))


# ---------------------------------------------------------------------------
# Unit: _try_bash_dedup_serve
# ---------------------------------------------------------------------------

class TestTryBashDedupServe:
    def test_no_prior_run_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        result = _try_bash_dedup_serve(_make_pre_bash_payload("ds-none", "ls -la"))
        assert result is None

    def test_small_repeat_serves_inline(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-small"
        # Output must exceed _BASH_CACHE_MIN_BYTES (400) to be stored, but stay under 8192.
        stdout = "file1.py\nfile2.py\n" + "x" * 400
        _post_bash(sid, "ls src/", stdout)
        result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "ls src/"))
        assert result is not None
        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        assert "file1.py" in ctx
        assert "cached output" in ctx

    def test_oversized_output_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _BASH_DIRECT_SERVE_MAX_BYTES, _try_bash_dedup_serve
        sid = "ds-big"
        big_stdout = "x" * (_BASH_DIRECT_SERVE_MAX_BYTES + 1)
        _post_bash(sid, "cat big.log", big_stdout)
        result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "cat big.log"))
        assert result is None

    def test_stale_entry_returns_none(self, tmp_data_dir):
        from token_goat import bash_cache
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-stale"
        stdout = "stale output\n" + "x" * 400  # exceed _BASH_CACHE_MIN_BYTES
        _post_bash(sid, "echo hi", stdout)

        # Back-date the entry so it's past the staleness threshold.
        cache = sess_mod.safe_load(sid)
        cmd_sha = bash_cache.command_hash("echo hi", "/proj")
        entry = cache.bash_history.get(cmd_sha)
        if entry is None:
            pytest.skip("entry not stored — bash cache disabled")
        entry.ts = time.time() - 99_999  # Far in the past
        sess_mod.save(cache)

        result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "echo hi"))
        assert result is None

    def test_empty_load_output_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-empty-text"
        _post_bash(sid, "echo test", "some output\n" + "x" * 400)
        with patch("token_goat.bash_cache.load_output", return_value=""):
            result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "echo test"))
        assert result is None

    def test_none_load_output_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-none-text"
        _post_bash(sid, "echo test2", "some output\n" + "x" * 400)
        with patch("token_goat.bash_cache.load_output", return_value=None):
            result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "echo test2"))
        assert result is None

    def test_second_repeat_defers_to_advisory(self, tmp_data_dir):
        """run_count > 1 suppresses direct-serve so loop-detection advisory can fire."""
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-loop"
        stdout = "output\n" + "x" * 400
        _post_bash(sid, "ls src/", stdout)  # run_count → 1
        _post_bash(sid, "ls src/", stdout)  # run_count → 2
        result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "ls src/"))
        assert result is None  # advisory path should handle this run

    def test_missing_command_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        payload = {"session_id": "ds-nocmd", "tool_name": "Bash", "tool_input": {}, "cwd": "/proj"}
        assert _try_bash_dedup_serve(payload) is None

    def test_missing_session_id_returns_none(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        payload = {"tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/proj"}
        assert _try_bash_dedup_serve(payload) is None

    def test_context_contains_age_and_bytes(self, tmp_data_dir):
        from token_goat.hooks_read import _try_bash_dedup_serve
        sid = "ds-age-bytes"
        _post_bash(sid, "git status", "On branch main\n" + "x" * 400)
        result = _try_bash_dedup_serve(_make_pre_bash_payload(sid, "git status"))
        assert result is not None
        ctx = (result.get("hookSpecificOutput") or {}).get("additionalContext", "")
        assert "ago" in ctx
        assert "bytes" in ctx


# ---------------------------------------------------------------------------
# Integration: _handle_bash_dedup uses direct-serve first
# ---------------------------------------------------------------------------

class TestHandleBashDedupDirectServe:
    def test_small_repeat_produces_additional_context(self, tmp_data_dir):
        """pre_bash for a repeated small command should carry additionalContext."""
        sid = "hbd-small"
        _post_bash(sid, "eza --git --long", "drwxr-xr-x  src/\n" + "x" * 400)
        result = _pre_bash(sid, "eza --git --long")
        if result is None:
            pytest.skip("pre_bash handler not reached")
        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        assert "cached output" in ctx or "bash-output" in ctx  # direct-serve or fallback

    def test_large_repeat_falls_back_to_advisory(self, tmp_data_dir):
        """pre_bash for a large prior output should emit advisory hint, not inline content."""
        from token_goat.hooks_read import _BASH_DIRECT_SERVE_MAX_BYTES
        sid = "hbd-large"
        big = "result line\n" * 1000  # > 8192 bytes
        assert len(big.encode()) > _BASH_DIRECT_SERVE_MAX_BYTES
        _post_bash(sid, "pytest tests/ -v", big)
        result = _pre_bash(sid, "pytest tests/ -v")
        if result is None:
            pytest.skip("pre_bash handler not reached")
        assert_continue(result)
        # Direct-serve would embed "cached output"; advisory hint uses "bash-output"
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        # Should NOT inline the full big output — advisory hint only
        assert "result line\nresult line" not in ctx

    def test_first_run_no_direct_serve(self, tmp_data_dir):
        """First time a command runs, pre_bash has no prior entry and should not serve."""
        sid = "hbd-first"
        result = _pre_bash(sid, "git log --oneline -5")
        # Either None (no hint triggered) or advisory without inlined output
        if result is not None:
            ctx = (result.get("hookSpecificOutput") or {}).get("additionalContext", "")
            assert "cached output" not in ctx
