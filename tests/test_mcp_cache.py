"""Tests for MCP read-only call cache (iter 6).

Covers:
- is_mcp_read_only classification (read-only vs mutable verbs)
- mcp_hash stability across dict insertion order
- store_mcp_result / load_mcp_result round-trip
- SessionCache.lookup_mcp_output_id / record_mcp_result with FIFO eviction
- _handle_mcp_dedup inline vs pointer hint selection
- _capture_mcp_result end-to-end capture
- post_fetch / pre_fetch integration stubs
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

from token_goat.mcp_cache import (
    MCP_MAX_CACHE_BYTES,
    is_mcp_read_only,
    load_mcp_result,
    mcp_hash,
    store_mcp_result,
)

# ---------------------------------------------------------------------------
# is_mcp_read_only classification
# ---------------------------------------------------------------------------

class TestIsMcpReadOnly:
    def test_list_files_is_read_only(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__list_issues") is True

    def test_get_file_is_read_only(self) -> None:
        assert is_mcp_read_only("mcp__claude_ai_Google_Drive__get_file_metadata") is True

    def test_search_is_read_only(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__search_repositories") is True

    def test_create_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__create_issue") is False

    def test_delete_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__delete_file") is False

    def test_push_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__push_files") is False

    def test_update_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__update_pull_request") is False

    def test_non_mcp_tool_is_false(self) -> None:
        assert is_mcp_read_only("Read") is False
        assert is_mcp_read_only("Bash") is False
        assert is_mcp_read_only("WebFetch") is False

    def test_mcp_without_mutable_verb_is_read_only(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__get_commit") is True

    def test_label_message_is_mutable(self) -> None:
        # label verb is in the blocklist
        assert is_mcp_read_only("mcp__claude_ai_Gmail_GG__label_message") is False

    def test_list_labels_is_read_only(self) -> None:
        # list is not in the blocklist
        assert is_mcp_read_only("mcp__claude_ai_Gmail_GG__list_labels") is True

    def test_add_comment_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__add_issue_comment") is False

    def test_merge_pull_request_is_mutable(self) -> None:
        assert is_mcp_read_only("mcp__plugin_github_github__merge_pull_request") is False


# ---------------------------------------------------------------------------
# mcp_hash stability
# ---------------------------------------------------------------------------

class TestMcpHash:
    def test_same_input_same_hash(self) -> None:
        h1 = mcp_hash("mcp__github__list_issues", {"owner": "foo", "repo": "bar"})
        h2 = mcp_hash("mcp__github__list_issues", {"owner": "foo", "repo": "bar"})
        assert h1 == h2

    def test_insertion_order_invariant(self) -> None:
        # Dict built in different orders → same hash
        h1 = mcp_hash("tool", {"a": 1, "b": 2})
        h2 = mcp_hash("tool", {"b": 2, "a": 1})
        assert h1 == h2

    def test_different_tool_different_hash(self) -> None:
        h1 = mcp_hash("mcp__github__list_issues", {"owner": "foo"})
        h2 = mcp_hash("mcp__github__search_issues", {"owner": "foo"})
        assert h1 != h2

    def test_different_input_different_hash(self) -> None:
        h1 = mcp_hash("tool", {"repo": "a"})
        h2 = mcp_hash("tool", {"repo": "b"})
        assert h1 != h2

    def test_returns_16_hex_chars(self) -> None:
        h = mcp_hash("tool", {})
        assert len(h) == 16
        assert all(c in "0123456789abcdef" for c in h)


# ---------------------------------------------------------------------------
# store_mcp_result / load_mcp_result round-trip
# ---------------------------------------------------------------------------

class TestMcpResultStorage:
    def test_store_and_load_roundtrip(self, tmp_path: Any) -> None:
        result_text = '{"issues": [{"id": 1, "title": "bug"}]}'
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            output_id = store_mcp_result("sess-1", "abc123", result_text, ts=1000.0)
            assert output_id is not None
            loaded = load_mcp_result(output_id)
        assert loaded == result_text

    def test_oversized_result_returns_none(self, tmp_path: Any) -> None:
        big = "x" * (MCP_MAX_CACHE_BYTES + 1)
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            result = store_mcp_result("sess-1", "hash1", big)
        assert result is None

    def test_missing_output_id_returns_none(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            result = load_mcp_result("nonexistent-id")
        assert result is None


# ---------------------------------------------------------------------------
# SessionCache.lookup_mcp_output_id / record_mcp_result
# ---------------------------------------------------------------------------

class TestSessionMcpMethods:
    def _make_cache(self) -> Any:
        from token_goat.session import SessionCache
        return SessionCache("sess-test", 0, 0)

    def test_lookup_unknown_hash_returns_none(self) -> None:
        cache = self._make_cache()
        assert cache.lookup_mcp_output_id("nohash") is None

    def test_record_then_lookup(self) -> None:
        cache = self._make_cache()
        cache.record_mcp_result("h1", "output-id-1")
        assert cache.lookup_mcp_output_id("h1") == "output-id-1"

    def test_fifo_eviction_at_cap(self) -> None:
        from token_goat.session import MCP_RESULT_HASHES_MAX
        cache = self._make_cache()
        # Fill to cap + 1 to trigger eviction
        for i in range(MCP_RESULT_HASHES_MAX + 1):
            cache.record_mcp_result(f"hash{i}", f"id{i}")
        # First entry should have been evicted
        assert cache.lookup_mcp_output_id("hash0") is None
        # Recent entries should still be present
        assert cache.lookup_mcp_output_id(f"hash{MCP_RESULT_HASHES_MAX}") is not None

    def test_serialization_roundtrip(self) -> None:
        from token_goat.session import SessionCache
        cache = self._make_cache()
        cache.record_mcp_result("hashABC", "out-456")
        d = cache.to_dict()
        assert d["mcp_result_hashes"]["hashABC"] == "out-456"
        restored = SessionCache.from_dict(d)
        assert restored.lookup_mcp_output_id("hashABC") == "out-456"

    def test_from_dict_missing_field_defaults_empty(self) -> None:
        from token_goat.session import SessionCache
        cache = self._make_cache()
        d = cache.to_dict()
        d.pop("mcp_result_hashes", None)
        restored = SessionCache.from_dict(d)
        assert restored.mcp_result_hashes == {}


# ---------------------------------------------------------------------------
# _handle_mcp_dedup hint selection
# ---------------------------------------------------------------------------

class TestHandleMcpDedup:
    def _make_payload(self, tool_name: str, tool_input: dict) -> dict[str, Any]:  # type: ignore[type-arg]
        return {"tool_name": tool_name, "tool_input": tool_input, "session_id": "sess-1"}

    def test_no_cached_result_returns_none(self) -> None:
        from token_goat.hooks_fetch import _handle_mcp_dedup
        with patch("token_goat.session.safe_load") as mock_safe_load:
            mock_cache = MagicMock()
            mock_cache.lookup_mcp_output_id.return_value = None
            mock_safe_load.return_value = mock_cache
            result = _handle_mcp_dedup("sess-1", "mcp__github__list_issues", {})
        assert result is None

    def test_inline_small_result(self) -> None:
        from token_goat.hooks_fetch import _handle_mcp_dedup
        small_text = '{"id": 1}'
        with (
            patch("token_goat.session.safe_load") as mock_safe_load,
            patch("token_goat.mcp_cache.load_blob_gz", return_value=small_text),
        ):
            mock_cache = MagicMock()
            mock_cache.lookup_mcp_output_id.return_value = "out-123"
            mock_safe_load.return_value = mock_cache
            result = _handle_mcp_dedup("sess-1", "mcp__github__list_issues", {})
        assert result is not None
        reason = result.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        assert small_text in reason

    def test_pointer_hint_for_large_result(self) -> None:
        from token_goat.hooks_fetch import _MCP_INLINE_THRESHOLD, _handle_mcp_dedup
        large_text = "x" * (_MCP_INLINE_THRESHOLD + 1)
        with (
            patch("token_goat.session.safe_load") as mock_safe_load,
            patch("token_goat.mcp_cache.load_blob_gz", return_value=large_text),
        ):
            mock_cache = MagicMock()
            mock_cache.lookup_mcp_output_id.return_value = "out-large"
            mock_safe_load.return_value = mock_cache
            result = _handle_mcp_dedup("sess-1", "mcp__github__list_issues", {})
        assert result is not None
        reason = result.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        assert "out-large" in reason
        assert large_text not in reason  # large text NOT inlined

    def test_missing_blob_returns_none(self) -> None:
        from token_goat.hooks_fetch import _handle_mcp_dedup
        with (
            patch("token_goat.session.safe_load") as mock_safe_load,
            patch("token_goat.mcp_cache.load_blob_gz", return_value=None),
        ):
            mock_cache = MagicMock()
            mock_cache.lookup_mcp_output_id.return_value = "stale-id"
            mock_safe_load.return_value = mock_cache
            result = _handle_mcp_dedup("sess-1", "mcp__github__list_issues", {})
        assert result is None
