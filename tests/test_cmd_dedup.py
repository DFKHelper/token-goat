"""Tests for repeated-command output deduplication in post_bash (Iter 20).

Covers:
  - Constants _CMD_DEDUP_MIN_BYTES and _CMD_DEDUP_MAX_CMDS are exported
  - First call with large stdout passes through (not suppressed)
  - Second call with identical stdout is suppressed with one-liner
  - Second call with changed stdout is NOT suppressed, passes through
  - Small stdout (< 500 bytes) is not deduplicated even on repeat
  - exit_code=1 repeat is not deduplicated
  - No session_id → not deduplicated
  - Changed stdout updates the hash (third call with original stdout → no match)
"""
from __future__ import annotations

import hashlib
import time
from unittest.mock import MagicMock, patch

import pytest

from token_goat.session import SessionCache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LARGE_OUT = "x" * 600  # >= _CMD_DEDUP_MIN_BYTES (100)
_SMALL_OUT = "y" * 50   # < _CMD_DEDUP_MIN_BYTES
_CMD = "git status"
_SID = "test-cmd-dedup-session"
_CWD = "/tmp"


def _make_payload(
    cmd: str,
    stdout: str,
    *,
    sid: str = _SID,
    exit_code: int | None = 0,
    stderr: str = "",
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        "cwd": _CWD,
    }


def _sys_msg(result: dict) -> str | None:
    return result.get("systemMessage")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

def test_constants_exported():
    from token_goat.hooks_read import _CMD_DEDUP_MAX_CMDS, _CMD_DEDUP_MIN_BYTES  # noqa: PLC0415
    assert _CMD_DEDUP_MIN_BYTES == 100
    assert _CMD_DEDUP_MAX_CMDS == 50


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh_cache():
    """Return a fresh SessionCache with a deterministic session ID."""
    now = time.time()
    return SessionCache(session_id=_SID, started_ts=now, last_activity_ts=now)


class TestCmdDedup:
    def _call_post_bash(self, payload: dict, cache):
        """Invoke post_bash with the session module patched to use *cache* in-memory.

        bash_cache is imported lazily inside post_bash, so we patch it at its
        true location (token_goat.bash_cache) rather than as a hooks_read attribute.
        """
        from token_goat import hooks_read

        sess_mod = MagicMock()
        sess_mod.safe_load.return_value = cache
        sess_mod.lookup_bash_entry.return_value = None
        sess_mod.mark_bash_run.return_value = cache
        sess_mod.save.return_value = None

        with (
            patch.object(hooks_read, "_get_session", return_value=sess_mod),
            patch("token_goat.bash_cache.store_output", return_value=None),
            patch("token_goat.bash_cache.write_sidecar", return_value=None),
        ):
            result = hooks_read.post_bash(payload)
        return result

    def test_first_call_passes_through(self, fresh_cache):
        """Large stdout on first run → not suppressed."""
        payload = _make_payload(_CMD, _LARGE_OUT)
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        assert _sys_msg(result) is None or "[token-goat] output unchanged" not in _sys_msg(result)

    def test_second_identical_call_suppressed(self, fresh_cache):
        """Second call with identical large stdout → suppressed with one-liner."""
        # Manually seed the hash so the second call sees a match.
        fresh_cache.cmd_output_hashes[_CMD] = hashlib.sha256(_LARGE_OUT.encode()).hexdigest()

        payload = _make_payload(_CMD, _LARGE_OUT)
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is not None
        assert "[token-goat] output unchanged from previous run" in msg
        # Should include line count
        assert "lines" in msg

    def test_changed_stdout_not_suppressed(self, fresh_cache):
        """Second call with different stdout → NOT suppressed, passes through."""
        fresh_cache.cmd_output_hashes[_CMD] = hashlib.sha256(_LARGE_OUT.encode()).hexdigest()

        changed_out = "z" * 600
        payload = _make_payload(_CMD, changed_out)
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is None or "[token-goat] output unchanged" not in (msg or "")

    def test_small_stdout_not_deduplicated(self, fresh_cache):
        """stdout < 500 bytes → dedup guard skips even on repeat."""
        fresh_cache.cmd_output_hashes[_CMD] = hashlib.sha256(_SMALL_OUT.encode()).hexdigest()

        payload = _make_payload(_CMD, _SMALL_OUT)
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is None or "[token-goat] output unchanged" not in (msg or "")

    def test_exit_code_nonzero_not_deduplicated(self, fresh_cache):
        """exit_code=1 → dedup guard skips even on identical repeat."""
        fresh_cache.cmd_output_hashes[_CMD] = hashlib.sha256(_LARGE_OUT.encode()).hexdigest()

        payload = _make_payload(_CMD, _LARGE_OUT, exit_code=1)
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is None or "[token-goat] output unchanged" not in (msg or "")

    def test_no_session_id_not_deduplicated(self, fresh_cache):
        """Empty session_id → dedup guard skips entirely."""
        fresh_cache.cmd_output_hashes[_CMD] = hashlib.sha256(_LARGE_OUT.encode()).hexdigest()

        payload = _make_payload(_CMD, _LARGE_OUT, sid="")
        result = self._call_post_bash(payload, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is None or "[token-goat] output unchanged" not in (msg or "")

    def test_changed_stdout_updates_hash(self, fresh_cache):
        """After a changed run, the stored hash reflects the new content.
        A third call with the original output should not match (hash updated)."""
        original_hash = hashlib.sha256(_LARGE_OUT.encode()).hexdigest()
        fresh_cache.cmd_output_hashes[_CMD] = original_hash

        changed_out = "z" * 600

        # Call with changed output — should pass through and update hash to changed_out.
        payload_changed = _make_payload(_CMD, changed_out)
        self._call_post_bash(payload_changed, fresh_cache)

        # Now the stored hash should be for changed_out, not _LARGE_OUT.
        stored = fresh_cache.cmd_output_hashes.get(_CMD)
        new_expected = hashlib.sha256(changed_out.encode()).hexdigest()
        assert stored == new_expected, f"Hash should have updated to changed output, got {stored!r}"

        # Third call with original output → should NOT match (hash was updated to changed_out).
        payload_orig = _make_payload(_CMD, _LARGE_OUT)
        result = self._call_post_bash(payload_orig, fresh_cache)
        assert result.get("continue") is True
        msg = _sys_msg(result)
        assert msg is None or "[token-goat] output unchanged" not in (msg or "")


# ---------------------------------------------------------------------------
# Session-cache unit: cmd_output_hashes field round-trips through to_dict/from_dict
# ---------------------------------------------------------------------------

class TestSessionCacheCmdOutputHashes:
    def test_field_default_empty(self):
        now = time.time()
        cache = SessionCache(session_id="sid", started_ts=now, last_activity_ts=now)
        assert cache.cmd_output_hashes == {}

    def test_round_trip_serialization(self):
        now = time.time()
        cache = SessionCache(session_id="sid", started_ts=now, last_activity_ts=now)
        cache.cmd_output_hashes["git status"] = "abc123"
        cache.cmd_output_hashes["npm test"] = "def456"

        d = cache.to_dict()
        assert d["cmd_output_hashes"] == {"git status": "abc123", "npm test": "def456"}

        cache2 = SessionCache.from_dict(d)
        assert cache2.cmd_output_hashes == {"git status": "abc123", "npm test": "def456"}

    def test_from_dict_missing_key_defaults_empty(self):
        """Older session JSON without cmd_output_hashes loads without error."""
        now = time.time()
        cache = SessionCache(session_id="sid", started_ts=now, last_activity_ts=now)
        d = cache.to_dict()
        del d["cmd_output_hashes"]
        cache2 = SessionCache.from_dict(d)
        assert cache2.cmd_output_hashes == {}


# ---------------------------------------------------------------------------
# Regression tests for peer-review fixes
# ---------------------------------------------------------------------------

class TestCmdDedupRegressions:
    def _call_post_bash(self, payload: dict, cache):
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_read

        sess_mod = MagicMock()
        sess_mod.safe_load.return_value = cache
        sess_mod.lookup_bash_entry.return_value = None
        sess_mod.mark_bash_run.return_value = cache
        sess_mod.save.return_value = None

        with (
            patch.object(hooks_read, "_get_session", return_value=sess_mod),
            patch("token_goat.bash_cache.store_output", return_value=None),
            patch("token_goat.bash_cache.write_sidecar", return_value=None),
        ):
            result = hooks_read.post_bash(payload)
        return result, sess_mod

    def test_threshold_100_catches_git_status_sized_output(self, fresh_cache):
        """Regression: threshold was 500, which excluded git status (~120-300 bytes).
        Must now fire for output between 100 and 500 bytes."""
        # Simulate a 150-byte git status output
        git_status_out = "On branch main\nnothing to commit, working tree clean\n" + "x" * 90
        assert 100 <= len(git_status_out) < 500, f"fixture size wrong: {len(git_status_out)}"
        fresh_cache.cmd_output_hashes["git status"] = hashlib.sha256(git_status_out.encode()).hexdigest()

        payload = _make_payload("git status", git_status_out)
        result, _ = self._call_post_bash(payload, fresh_cache)
        msg = result.get("systemMessage") or ""
        assert "[token-goat] output unchanged from previous run" in msg

    def test_no_match_path_saves_session(self, fresh_cache):
        """Regression: the NO MATCH path originally relied on the bash-cache block to
        persist the session, which was not guaranteed. Now save() is called explicitly."""
        stdout = _LARGE_OUT
        payload = _make_payload(_CMD, stdout)
        _, sess_mod = self._call_post_bash(payload, fresh_cache)
        # save() must have been called at least once in the no-match path
        assert sess_mod.save.called, "session.save() must be called after hash update"
