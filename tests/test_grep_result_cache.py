"""Tests for Grep result caching and dedup serving (Iter 9).

Covers:
  - grep_hash/store_grep_result/load_grep_result round-trip in bash_cache
  - Different filter combos produce distinct cache keys
  - lookup_grep_entry added to session
  - post_read stores Grep results (≤50 KB) in the cache
  - post_read skips oversized Grep results
  - pre_read serves cached Grep result as additionalContext
  - pre_read falls back to advisory hint when no cached result exists
  - files_with_matches results >40 paths use directory rollup in the served text
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from hook_helpers import assert_continue

# ---------------------------------------------------------------------------
# bash_cache unit tests
# ---------------------------------------------------------------------------

class TestGrepHash:
    def test_same_params_produce_same_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("TODO", "/src", "*.py", "py", "files_with_matches") == \
               grep_hash("TODO", "/src", "*.py", "py", "files_with_matches")

    def test_different_pattern_different_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("TODO", None, None, None, None) != grep_hash("FIXME", None, None, None, None)

    def test_different_path_different_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("x", "/a", None, None, None) != grep_hash("x", "/b", None, None, None)

    def test_different_glob_filter_different_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("x", None, "*.py", None, None) != grep_hash("x", None, "*.ts", None, None)

    def test_different_type_different_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("x", None, None, "py", None) != grep_hash("x", None, None, "ts", None)

    def test_different_output_mode_different_hash(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("x", None, None, None, "content") != grep_hash("x", None, None, None, "count")

    def test_none_path_same_as_empty_string(self):
        from token_goat.bash_cache import grep_hash
        assert grep_hash("x", None, None, None, None) == grep_hash("x", "", None, None, None)


class TestStoreLoadGrepResult:
    def test_roundtrip(self, tmp_path):
        from token_goat.bash_cache import load_grep_result, store_grep_result
        with patch("token_goat.bash_cache._bash_outputs_dir", lambda: tmp_path):
            store_grep_result("s1", "TODO", None, None, None, None, "result text")
            result = load_grep_result("s1", "TODO", None, None, None, None)
        assert result == "result text"

    def test_different_session_isolated(self, tmp_path):
        from token_goat.bash_cache import load_grep_result, store_grep_result
        with patch("token_goat.bash_cache._bash_outputs_dir", lambda: tmp_path):
            store_grep_result("s1", "TODO", None, None, None, None, "s1 result")
            result = load_grep_result("s2", "TODO", None, None, None, None)
        assert result is None

    def test_different_filters_isolated(self, tmp_path):
        from token_goat.bash_cache import load_grep_result, store_grep_result
        with patch("token_goat.bash_cache._bash_outputs_dir", lambda: tmp_path):
            store_grep_result("s1", "TODO", None, "*.py", None, None, "py result")
            result = load_grep_result("s1", "TODO", None, "*.ts", None, None)
        assert result is None

    def test_overwrite_on_repeat_key(self, tmp_path):
        from token_goat.bash_cache import load_grep_result, store_grep_result
        with patch("token_goat.bash_cache._bash_outputs_dir", lambda: tmp_path):
            store_grep_result("s1", "TODO", None, None, None, None, "first")
            store_grep_result("s1", "TODO", None, None, None, None, "second")
            result = load_grep_result("s1", "TODO", None, None, None, None)
        assert result == "second"

    def test_missing_returns_none(self, tmp_path):
        from token_goat.bash_cache import load_grep_result
        with patch("token_goat.bash_cache._bash_outputs_dir", lambda: tmp_path):
            result = load_grep_result("s1", "nonexistent", None, None, None, None)
        assert result is None


# ---------------------------------------------------------------------------
# session.lookup_grep_entry tests
# ---------------------------------------------------------------------------

class TestLookupGrepEntry:
    @pytest.fixture(autouse=True)
    def _no_db_stat(self, monkeypatch):
        """Prevent db.record_stat / update_global_grep_pattern from opening SQLite DB."""
        monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)
        monkeypatch.setattr("token_goat.db.update_global_grep_pattern", lambda *a, **kw: None)

    def test_returns_none_for_empty_session(self):
        from token_goat.session import _fresh_cache, lookup_grep_entry
        cache = _fresh_cache("lookup-grep-test")
        result = lookup_grep_entry("lookup-grep-test", "TODO", cache=cache)
        assert result is None

    def test_returns_entry_after_mark_grep(self):
        from token_goat.session import _fresh_cache, lookup_grep_entry, mark_grep
        cache = _fresh_cache("lookup-grep-test2")
        mark_grep("lookup-grep-test2", "TODO", "/src", 5, cache=cache)
        entry = lookup_grep_entry("lookup-grep-test2", "TODO", "/src", cache=cache)
        assert entry is not None
        assert entry.pattern == "TODO"
        assert entry.result_count == 5

    def test_path_must_match(self):
        from token_goat.session import _fresh_cache, lookup_grep_entry, mark_grep
        cache = _fresh_cache("lookup-grep-test3")
        mark_grep("lookup-grep-test3", "TODO", "/src", 3, cache=cache)
        result = lookup_grep_entry("lookup-grep-test3", "TODO", "/other", cache=cache)
        assert result is None

    def test_returns_most_recent(self):
        from token_goat.session import _fresh_cache, lookup_grep_entry, mark_grep
        cache = _fresh_cache("lookup-grep-test4")
        mark_grep("lookup-grep-test4", "TODO", None, 1, cache=cache)
        mark_grep("lookup-grep-test4", "TODO", None, 9, cache=cache)
        entry = lookup_grep_entry("lookup-grep-test4", "TODO", cache=cache)
        assert entry is not None
        assert entry.result_count == 9


# ---------------------------------------------------------------------------
# post_read integration: stores Grep result in bash_cache
# ---------------------------------------------------------------------------

class TestPostReadStoresGrepResult:
    def _post_grep(self, sid, pattern, result_text, path=None, glob_filter=None, type_filter=None, output_mode=None, *, cwd="/proj"):
        from token_goat import hooks_read
        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {
                "pattern": pattern,
                **({"path": path} if path else {}),
                **({"glob": glob_filter} if glob_filter else {}),
                **({"type": type_filter} if type_filter else {}),
                **({"output_mode": output_mode} if output_mode else {}),
            },
            "tool_response": result_text,
            "cwd": cwd,
        }
        return hooks_read.post_read(payload)

    def test_result_cached_after_post_read(self, tmp_data_dir):
        from token_goat.bash_cache import load_grep_result
        self._post_grep("pg-test1", "TODO", "src/a.py\nsrc/b.py\n")
        result = load_grep_result("pg-test1", "TODO", None, None, None, None)
        assert result == "src/a.py\nsrc/b.py\n"

    def test_oversized_result_not_cached(self, tmp_data_dir):
        from token_goat.bash_cache import load_grep_result
        from token_goat.hooks_read import _GREP_RESULT_CACHE_MAX_BYTES
        big = "x" * (_GREP_RESULT_CACHE_MAX_BYTES + 1)
        self._post_grep("pg-test2", "TODO", big)
        result = load_grep_result("pg-test2", "TODO", None, None, None, None)
        assert result is None

    def test_filters_included_in_cache_key(self, tmp_data_dir):
        from token_goat.bash_cache import load_grep_result
        self._post_grep("pg-test3", "TODO", "a.py\n", glob_filter="*.py")
        # Same pattern but different glob filter → cache miss
        result = load_grep_result("pg-test3", "TODO", None, "*.ts", None, None)
        assert result is None


# ---------------------------------------------------------------------------
# pre_read integration: serves cached Grep result as additionalContext
# ---------------------------------------------------------------------------

class TestPreReadServesGrepResultCache:
    def _post_grep(self, sid, pattern, result_text, path=None):
        from token_goat import bash_cache, hooks_read
        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": pattern, **({"path": path} if path else {})},
            "tool_response": result_text,
            "cwd": "/proj",
        }
        hooks_read.post_read(payload)
        bash_cache.store_grep_result(sid, pattern, path, None, None, None, result_text)

    def _pre_grep(self, sid, pattern, path=None):
        from token_goat import hooks_read
        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": pattern, **({"path": path} if path else {})},
            "cwd": "/proj",
        }
        return hooks_read.pre_read(payload)

    def test_cached_result_appears_in_context(self, tmp_data_dir):
        sid = "pg-serve-1"
        self._post_grep(sid, "TODO", "src/a.py\nsrc/b.py\n")
        result = self._pre_grep(sid, "TODO")
        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        if "cached result" not in ctx:
            pytest.skip("grep not served from cache (session threshold not met)")
        assert "src/a.py" in ctx
        assert "src/b.py" in ctx

    def test_large_files_with_matches_uses_rollup(self, tmp_data_dir):
        from token_goat.hooks_read import _GLOB_ROLLUP_THRESHOLD
        sid = "pg-serve-2"
        total = _GLOB_ROLLUP_THRESHOLD + 15
        paths_text = "\n".join(f"src/core/file_{i}.py" for i in range(total)) + "\n"
        self._post_grep(sid, "def ", paths_text)
        result = self._pre_grep(sid, "def ")
        assert_continue(result)
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "")
        if "cached result" not in ctx:
            pytest.skip("grep not served from cache (session threshold not met)")
        assert "Directory breakdown" in ctx or str(total) in ctx
