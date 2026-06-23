"""Regression tests for browser automation hint features.

Feature #1 — browser_evaluate large-output hint (post_fetch)
Feature #3 — snapshot redundancy hint (pre_fetch)
Feature #4 — harness duplication hint (pre_fetch)
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers to build minimal HookPayload dicts
# ---------------------------------------------------------------------------

def _pre_payload(tool_name: str, tool_input: dict | None = None, session_id: str = "sess-test") -> dict:
    return {
        "tool_name": tool_name,
        "tool_input": tool_input or {},
        "session_id": session_id,
    }


def _post_payload(tool_name: str, tool_response: str = "", session_id: str = "sess-test") -> dict:
    return {
        "tool_name": tool_name,
        "tool_input": {},
        "tool_response": tool_response,
        "session_id": session_id,
    }


def _make_cache(seen: set[str] | None = None):
    """Return a minimal SessionCache-like mock."""
    cache = MagicMock()
    _seen: set[str] = seen if seen is not None else set()
    cache.has_hint_fingerprint.side_effect = lambda fp: fp in _seen
    def _mark(fp: str) -> None:
        _seen.add(fp)
    cache.mark_hint_seen.side_effect = _mark
    cache.record_hint_emitted.return_value = None
    return cache


# ---------------------------------------------------------------------------
# Feature #1 — browser_evaluate large-output hint
# ---------------------------------------------------------------------------

class TestBrowserEvalLargeOutput:
    EVAL_TOOL = "mcp__plugin_playwright_playwright__browser_evaluate"
    ALT_TOOL = "mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script"

    def _run_post(self, tool_name: str, response_text: str, session_id: str = "s1"):
        import token_goat.hooks_fetch as hf
        payload = _post_payload(tool_name, tool_response=response_text, session_id=session_id)
        cache = _make_cache()

        with (
            patch("token_goat.hooks_fetch.get_hook_context", return_value=(session_id, "/cwd")),
            patch("token_goat.hooks_fetch._capture_mcp_result"),
            patch("token_goat.mcp_cache.is_mcp_read_only", return_value=True),
            patch("token_goat.session.safe_load", return_value=cache),
            patch("token_goat.hooks_common.record_hint_stat_pair"),
        ):
            result = hf.post_fetch(payload)

        return result, cache

    def test_large_result_emit_hint(self):
        big_text = "x" * 5000
        result, cache = self._run_post(self.EVAL_TOOL, big_text)
        # Always returns CONTINUE
        assert result.get("continue") is True or result == {} or result is not None
        # mark_hint_seen called means hint was emitted
        cache.mark_hint_seen.assert_called_once()
        fp = cache.mark_hint_seen.call_args[0][0]
        assert "browser_eval_large" in fp

    def test_small_result_no_hint(self):
        small_text = "x" * 100
        result, cache = self._run_post(self.EVAL_TOOL, small_text)
        cache.mark_hint_seen.assert_not_called()

    def test_alt_tool_large_result_emits(self):
        big_text = "y" * 5000
        result, cache = self._run_post(self.ALT_TOOL, big_text)
        cache.mark_hint_seen.assert_called_once()

    def test_hint_fires_at_most_once_per_session(self):
        """Second call with same session_id should be suppressed by dedup."""
        import token_goat.hooks_fetch as hf
        big_text = "x" * 5000
        payload = _post_payload(self.EVAL_TOOL, tool_response=big_text, session_id="s-dedup")
        _seen: set[str] = set()
        cache = _make_cache(seen=_seen)

        with (
            patch("token_goat.hooks_fetch.get_hook_context", return_value=("s-dedup", "/cwd")),
            patch("token_goat.hooks_fetch._capture_mcp_result"),
            patch("token_goat.mcp_cache.is_mcp_read_only", return_value=True),
            patch("token_goat.session.safe_load", return_value=cache),
            patch("token_goat.hooks_common.record_hint_stat_pair"),
        ):
            hf.post_fetch(payload)
            call_count_after_first = cache.mark_hint_seen.call_count
            hf.post_fetch(payload)
            call_count_after_second = cache.mark_hint_seen.call_count

        assert call_count_after_first == 1
        # Second call: fingerprint already in _seen, so mark_hint_seen not called again
        assert call_count_after_second == 1


# ---------------------------------------------------------------------------
# Feature #3 — snapshot redundancy hint
# ---------------------------------------------------------------------------

class TestSnapshotRedundancy:
    SNAP_TOOL = "mcp__plugin_playwright_playwright__browser_snapshot"
    DEVTOOLS_SNAP = "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot"

    def _run_pre(self, tool_name: str, session_id: str = "snap-sess", tool_input: dict | None = None):
        import token_goat.hooks_fetch as hf
        payload = _pre_payload(tool_name, tool_input=tool_input or {}, session_id=session_id)
        cache = _make_cache()

        with (
            patch("token_goat.hooks_fetch.get_hook_context", return_value=(session_id, "/cwd")),
            patch("token_goat.hooks_fetch.get_session_context", return_value=(session_id, "/cwd")),
            patch("token_goat.hooks_fetch.get_tool_input", return_value=tool_input or {}),
            patch("token_goat.session.safe_load", return_value=cache),
            patch("token_goat.hooks_common.record_hint_stat_pair"),
            patch("token_goat.mcp_cache.is_mcp_read_only", return_value=False),
        ):
            result = hf.pre_fetch(payload)

        return result, cache

    def test_rapid_re_snapshot_emits_hint(self):
        import token_goat.hooks_fetch as hf
        # Seed _last_snapshot_ts with a recent timestamp for this session
        sid = "snap-rapid"
        hf._last_snapshot_ts[sid] = (time.monotonic() - 5.0, self.SNAP_TOOL)

        _, cache = self._run_pre(self.SNAP_TOOL, session_id=sid)
        cache.mark_hint_seen.assert_called_once()
        fp = cache.mark_hint_seen.call_args[0][0]
        assert "snapshot_redundancy" in fp

    def test_slow_re_snapshot_no_hint(self):
        import token_goat.hooks_fetch as hf
        # Seed with a timestamp 40s ago — beyond the 30s threshold
        sid = "snap-slow"
        hf._last_snapshot_ts[sid] = (time.monotonic() - 40.0, self.SNAP_TOOL)

        _, cache = self._run_pre(self.SNAP_TOOL, session_id=sid)
        cache.mark_hint_seen.assert_not_called()

    def test_first_snapshot_no_hint(self):
        import token_goat.hooks_fetch as hf
        sid = "snap-first"
        # Remove any prior state
        hf._last_snapshot_ts.pop(sid, None)

        _, cache = self._run_pre(self.SNAP_TOOL, session_id=sid)
        cache.mark_hint_seen.assert_not_called()

    def test_different_tool_no_hint(self):
        """If the second snapshot call uses a different tool, no hint fires."""
        import token_goat.hooks_fetch as hf
        sid = "snap-diff-tool"
        hf._last_snapshot_ts[sid] = (time.monotonic() - 5.0, self.DEVTOOLS_SNAP)

        _, cache = self._run_pre(self.SNAP_TOOL, session_id=sid)
        cache.mark_hint_seen.assert_not_called()


# ---------------------------------------------------------------------------
# Feature #4 — harness duplication hint
# ---------------------------------------------------------------------------

class TestHarnessDuplication:
    # Use non-snapshot tools so Feature #3 (snapshot redundancy) doesn't interfere.
    PW_TOOL = "mcp__plugin_playwright_playwright__browser_click"
    DT_TOOL = "mcp__plugin_chrome-devtools-mcp_chrome-devtools__click"

    def _run_pre(self, tool_name: str, session_id: str):
        import token_goat.hooks_fetch as hf
        payload = _pre_payload(tool_name, session_id=session_id)
        cache = _make_cache()

        with (
            patch("token_goat.hooks_fetch.get_hook_context", return_value=(session_id, "/cwd")),
            patch("token_goat.hooks_fetch.get_session_context", return_value=(session_id, "/cwd")),
            patch("token_goat.hooks_fetch.get_tool_input", return_value={}),
            patch("token_goat.session.safe_load", return_value=cache),
            patch("token_goat.hooks_common.record_hint_stat_pair"),
            patch("token_goat.mcp_cache.is_mcp_read_only", return_value=False),
        ):
            result = hf.pre_fetch(payload)

        return result, cache

    def test_both_harnesses_emit_hint(self):
        import token_goat.hooks_fetch as hf
        sid = "hdup-both"
        hf._session_harnesses.pop(sid, None)

        # First call: playwright only — no hint
        _, cache1 = self._run_pre(self.PW_TOOL, session_id=sid)
        cache1.mark_hint_seen.assert_not_called()

        # Second call: devtools added — hint fires
        _, cache2 = self._run_pre(self.DT_TOOL, session_id=sid)
        cache2.mark_hint_seen.assert_called_once()
        fp = cache2.mark_hint_seen.call_args[0][0]
        assert "harness_dup" in fp

    def test_same_harness_twice_no_hint(self):
        import token_goat.hooks_fetch as hf
        sid = "hdup-same"
        hf._session_harnesses.pop(sid, None)

        _, cache1 = self._run_pre(self.PW_TOOL, session_id=sid)
        _, cache2 = self._run_pre(self.PW_TOOL, session_id=sid)
        cache1.mark_hint_seen.assert_not_called()
        cache2.mark_hint_seen.assert_not_called()

    def test_hint_fires_only_once(self):
        """Third call after both harnesses seen must not re-emit."""
        import token_goat.hooks_fetch as hf
        sid = "hdup-once"
        hf._session_harnesses.pop(sid, None)

        _seen_fps: set[str] = set()

        for tool in (self.PW_TOOL, self.DT_TOOL, self.PW_TOOL):
            payload = _pre_payload(tool, session_id=sid)
            cache = _make_cache(seen=_seen_fps)
            with (
                patch("token_goat.hooks_fetch.get_hook_context", return_value=(sid, "/cwd")),
                patch("token_goat.hooks_fetch.get_session_context", return_value=(sid, "/cwd")),
                patch("token_goat.hooks_fetch.get_tool_input", return_value={}),
                patch("token_goat.session.safe_load", return_value=cache),
                patch("token_goat.hooks_common.record_hint_stat_pair"),
                patch("token_goat.mcp_cache.is_mcp_read_only", return_value=False),
            ):
                hf.pre_fetch(payload)

        # Exactly one fingerprint recorded across all three calls
        assert len(_seen_fps) == 1
        assert any("harness_dup" in fp for fp in _seen_fps)
