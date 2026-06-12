"""Tests for iter 9: MCP stale-state invalidation after mutation tool calls."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# SessionCache.clear_mcp_result_hashes
# ---------------------------------------------------------------------------

class TestClearMcpResultHashes:
    def _make_cache(self, hashes: dict) -> Any:
        from token_goat.session import SessionCache
        cache = MagicMock(spec=SessionCache)
        cache.mcp_result_hashes = dict(hashes)
        cache._invalidate_json_cache = MagicMock()
        # Replicate the real method
        def clear_mcp_result_hashes():
            import time
            count = len(cache.mcp_result_hashes)
            if count:
                cache.mcp_result_hashes.clear()
                cache.last_activity_ts = time.time()
                cache._invalidate_json_cache()
            return count
        cache.clear_mcp_result_hashes = clear_mcp_result_hashes
        return cache

    def test_real_method_clears_all_entries(self) -> None:

        from token_goat.session import SessionCache
        # Build a minimal real SessionCache instance
        cache = SessionCache.__new__(SessionCache)
        # Set required fields directly
        cache.mcp_result_hashes = {"hash1": "oid1", "hash2": "oid2"}
        cache.last_activity_ts = 0.0
        cache._json_cache = None
        cache.clear_mcp_result_hashes()
        assert cache.mcp_result_hashes == {}

    def test_real_method_returns_count(self) -> None:
        from token_goat.session import SessionCache
        cache = SessionCache.__new__(SessionCache)
        cache.mcp_result_hashes = {"a": "1", "b": "2", "c": "3"}
        cache.last_activity_ts = 0.0
        cache._json_cache = None
        count = cache.clear_mcp_result_hashes()
        assert count == 3

    def test_real_method_returns_zero_when_empty(self) -> None:
        from token_goat.session import SessionCache
        cache = SessionCache.__new__(SessionCache)
        cache.mcp_result_hashes = {}
        cache.last_activity_ts = 0.0
        cache._json_cache = None
        count = cache.clear_mcp_result_hashes()
        assert count == 0


# ---------------------------------------------------------------------------
# _invalidate_mcp_cache integration
# ---------------------------------------------------------------------------

class TestInvalidateMcpCache:
    def _call(self, session_id: str, tool_name: str, cache_hashes: dict) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_fetch import _invalidate_mcp_cache

        mock_cache = MagicMock()
        mock_cache.mcp_result_hashes = dict(cache_hashes)

        def clear_mcp_result_hashes():
            count = len(mock_cache.mcp_result_hashes)
            mock_cache.mcp_result_hashes.clear()
            return count

        mock_cache.clear_mcp_result_hashes = clear_mcp_result_hashes

        with (
            patch.object(sess_mod, "safe_load", return_value=mock_cache),
            patch.object(sess_mod, "save") as mock_save,
        ):
            _invalidate_mcp_cache(session_id, tool_name)
            return mock_save, mock_cache

    def test_clears_hashes_and_saves(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_fetch import _invalidate_mcp_cache

        mock_cache = MagicMock()
        mock_cache.mcp_result_hashes = {"h1": "o1", "h2": "o2"}

        def clear_mcp_result_hashes():
            count = len(mock_cache.mcp_result_hashes)
            mock_cache.mcp_result_hashes.clear()
            return count

        mock_cache.clear_mcp_result_hashes = clear_mcp_result_hashes

        with (
            patch.object(sess_mod, "safe_load", return_value=mock_cache),
            patch.object(sess_mod, "save") as mock_save,
        ):
            _invalidate_mcp_cache("sess-inv1", "mcp__github__create_issue")
            assert mock_cache.mcp_result_hashes == {}
            mock_save.assert_called_once_with(mock_cache)

    def test_no_save_when_empty(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_fetch import _invalidate_mcp_cache

        mock_cache = MagicMock()
        mock_cache.mcp_result_hashes = {}
        mock_cache.clear_mcp_result_hashes = lambda: 0

        with (
            patch.object(sess_mod, "safe_load", return_value=mock_cache),
            patch.object(sess_mod, "save") as mock_save,
        ):
            _invalidate_mcp_cache("sess-inv2", "mcp__github__delete_file")
            mock_save.assert_not_called()

    def test_no_crash_when_session_missing(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_fetch import _invalidate_mcp_cache

        with patch.object(sess_mod, "safe_load", return_value=None):
            _invalidate_mcp_cache("sess-missing", "mcp__github__create_issue")  # should not raise


# ---------------------------------------------------------------------------
# post_fetch dispatch: mutation tools trigger invalidation, read-only capture
# ---------------------------------------------------------------------------

class TestPostFetchMcpDispatch:
    def _make_payload(self, tool_name: str, result: str = "ok") -> dict[str, Any]:
        return {
            "tool_name": tool_name,
            "tool_input": {"owner": "org", "repo": "repo"},
            "tool_response": {"output": result},
            "session_id": "sess-disp1",
            "cwd": "/proj",
        }

    def test_mutation_tool_triggers_invalidation(self) -> None:
        from token_goat.hooks_fetch import post_fetch

        with (
            patch("token_goat.hooks_fetch._invalidate_mcp_cache") as mock_inv,
            patch("token_goat.hooks_fetch._capture_mcp_result") as mock_cap,
            patch("token_goat.hooks_fetch.get_hook_context", return_value=("sess-disp1", "/proj")),
        ):
            post_fetch(self._make_payload("mcp__plugin_github_github__create_issue"))
            mock_inv.assert_called_once()
            mock_cap.assert_not_called()

    def test_read_only_tool_triggers_capture(self) -> None:
        from token_goat.hooks_fetch import post_fetch

        with (
            patch("token_goat.hooks_fetch._invalidate_mcp_cache") as mock_inv,
            patch("token_goat.hooks_fetch._capture_mcp_result") as mock_cap,
            patch("token_goat.hooks_fetch.get_hook_context", return_value=("sess-disp1", "/proj")),
        ):
            post_fetch(self._make_payload("mcp__plugin_github_github__list_issues"))
            mock_cap.assert_called_once()
            mock_inv.assert_not_called()
