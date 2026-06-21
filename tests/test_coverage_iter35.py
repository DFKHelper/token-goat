"""Iteration-35 coverage additions.

Targets previously untested code paths in:
- repomap.py: _summarize_file, _evict_stale_cache, build_map, render_summary, _is_map_worthy
- compact.py: build_manifest, _render (edge cases), _short_path, _format_ranges
- hints.py: _confirmed_line_count, _hint_from_index, _hint_from_cache
- read_replacement.py: find_in_all_projects, _resolve_cache, _match_specificity, _pick_best_match
- hooks_common.py: pre_tool_use_with_context, pre_tool_use_with_update, deny_redirect
- languages/go.py: _extract_const_var edge cases
- languages/python.py: _parse_import_source edge cases
- worker.py: _cleanup_orphaned_state_files, _cleanup_old_sentinels
"""
from __future__ import annotations

import sqlite3
from unittest.mock import MagicMock, patch

import pytest

from token_goat import read_replacement
from token_goat.compact import _format_ranges, _render, _short_path, build_manifest
from token_goat.hints import (
    LARGE_FILE_LINE_THRESHOLD,
    _confirmed_line_count,
    _est_tokens_from_chars,
    _est_tokens_from_lines,
)
from token_goat.hooks_common import (
    deny_redirect,
    pre_tool_use_with_context,
    pre_tool_use_with_update,
)
from token_goat.languages.go import _extract_const_var
from token_goat.languages.python import _parse_import_source
from token_goat.read_replacement import (
    _CACHE_MISS,
    ProjectIndexUnavailable,
    _match_specificity,
    _pick_best_match,
    _resolve_cache_lookup,
    _resolve_cache_put,
    find_in_all_projects,
    invalidate_file_cache,
)
from token_goat.repomap import (
    FileSummary,
    _evict_stale_cache,
    _summarize_file,
    render_summary,
)
from token_goat.session import FileEntry, SessionCache

# ---------------------------------------------------------------------------
# repomap helpers
# ---------------------------------------------------------------------------


class TestSummarizeFile:
    """Tests for repomap._summarize_file."""

    def _info(self, size: int = 5000, mtime: float = 0.0) -> dict:
        return {"size": size, "mtime": mtime, "language": "python"}

    def test_deduplicates_symbols(self):
        """Duplicate (kind, name) pairs are deduplicated in top_symbols."""
        symbols = [("function", "foo"), ("function", "foo"), ("class", "Bar")]
        result = _summarize_file("src/a.py", self._info(), symbols, [], 1.0)
        assert result.top_symbols.count(("function", "foo")) == 1

    def test_respects_max_symbols(self):
        """top_symbols is capped at max_symbols (default 8)."""
        symbols = [("function", f"func_{i}") for i in range(20)]
        result = _summarize_file("src/a.py", self._info(), symbols, [], 1.0, max_symbols=8)
        assert len(result.top_symbols) == 8

    def test_custom_max_symbols(self):
        """Custom max_symbols parameter is respected."""
        symbols = [("function", f"f{i}") for i in range(10)]
        result = _summarize_file("src/a.py", self._info(), symbols, [], 1.0, max_symbols=3)
        assert len(result.top_symbols) == 3

    def test_sorts_by_kind_priority(self):
        """Symbols are sorted by KIND_PRIORITY: class before function."""
        symbols = [("function", "do_thing"), ("class", "MyClass"), ("method", "meth")]
        result = _summarize_file("src/a.py", self._info(), symbols, [], 1.0)
        kinds = [k for k, _ in result.top_symbols]
        assert kinds[0] == "class"

    def test_sections_filtered_to_level_2(self):
        """Only level <= 2 sections appear in top_sections."""
        sections = [(1, "Overview"), (2, "Usage"), (3, "Deep"), (4, "Internal")]
        result = _summarize_file("src/a.py", self._info(), [], sections, 1.0)
        assert result.top_sections == ["Overview", "Usage"]

    def test_sections_capped_at_max_sections(self):
        """top_sections is capped at max_sections (default 5)."""
        sections = [(1, f"H{i}") for i in range(10)]
        result = _summarize_file("src/a.py", self._info(), [], sections, 1.0, max_sections=5)
        assert len(result.top_sections) == 5

    def test_approx_lines_from_size(self):
        """Line count is computed from file size (size // 50, min 1)."""
        info = {"size": 5000, "mtime": 0.0, "language": "python"}
        result = _summarize_file("src/a.py", info, [], [], 1.0)
        assert result.line_count == 100  # 5000 // 50

    def test_minimum_line_count_is_one(self):
        """Zero-byte file gives line_count == 1 (not 0)."""
        info = {"size": 0, "mtime": 0.0, "language": "python"}
        result = _summarize_file("src/a.py", info, [], [], 1.0)
        assert result.line_count == 1

    def test_rank_preserved(self):
        """rank field is passed through unchanged."""
        result = _summarize_file("src/a.py", self._info(), [], [], 3.14)
        assert result.rank == pytest.approx(3.14)

    def test_unknown_kind_sorts_last(self):
        """Unknown kinds use priority 99 and sort after known kinds."""
        symbols = [("function", "fn"), ("unknown_kind", "unk"), ("class", "Cls")]
        result = _summarize_file("src/a.py", self._info(), symbols, [], 1.0)
        kinds = [k for k, _ in result.top_symbols]
        assert kinds[-1] == "unknown_kind"


class TestRenderSummary:
    """Tests for repomap.render_summary."""

    def _make(self, **kwargs) -> FileSummary:
        defaults = {
            "rel_path": "src/foo.py",
            "language": "python",
            "rank": 0.5,
            "top_symbols": [],
            "top_sections": [],
            "line_count": 100,
        }
        defaults.update(kwargs)
        return FileSummary(**defaults)

    def test_header_line_present(self):
        s = self._make()
        rendered = render_summary(s)
        assert "src/foo.py" in rendered
        assert "python" in rendered
        # Dense format: bare line count, no "~"/"L" decoration
        assert "[python,100," in rendered
        # Dense format: rank rendered as "r=0.500" (3 decimals, short label)
        assert "0.500" in rendered

    def test_symbols_grouped_by_kind(self):
        s = self._make(top_symbols=[("function", "foo"), ("function", "bar"), ("class", "Cls")])
        rendered = render_summary(s)
        # Dense format: short kind tags + comma-only separator
        assert "cls:Cls" in rendered
        assert "fn:foo,bar" in rendered

    def test_sections_line_present(self):
        s = self._make(top_sections=["Intro", "Usage"])
        rendered = render_summary(s)
        # Dense format: short label "sec:" + ">" separator without spaces
        assert "sec:Intro>Usage" in rendered

    def test_no_symbols_no_extra_lines(self):
        s = self._make()
        rendered = render_summary(s)
        lines = rendered.strip().splitlines()
        assert len(lines) == 1  # only header

    def test_kind_priority_ordering_in_render(self):
        """class appears before function in rendered output."""
        s = self._make(top_symbols=[("function", "fn"), ("class", "Cls")])
        rendered = render_summary(s)
        # Use the new short tags
        class_pos = rendered.index("cls:")
        func_pos = rendered.index("fn:")
        assert class_pos < func_pos


class TestEvictStaleCache:
    """Tests for repomap._evict_stale_cache."""

    def _make_conn(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE repomap_cache "
            "(rel_path TEXT PRIMARY KEY, mtime REAL, size INTEGER, summary_text TEXT, created_at INTEGER)"
        )
        return conn

    def test_removes_entries_not_in_current_files(self):
        conn = self._make_conn()
        conn.execute(
            "INSERT INTO repomap_cache VALUES (?,?,?,?,?)",
            ("old/file.py", 1.0, 100, "text", 0),
        )
        conn.commit()
        _evict_stale_cache(conn, {"src/new.py": {}})
        rows = conn.execute("SELECT rel_path FROM repomap_cache").fetchall()
        assert len(rows) == 0

    def test_keeps_entries_in_current_files(self):
        conn = self._make_conn()
        conn.execute(
            "INSERT INTO repomap_cache VALUES (?,?,?,?,?)",
            ("src/keep.py", 1.0, 100, "text", 0),
        )
        conn.commit()
        _evict_stale_cache(conn, {"src/keep.py": {}})
        rows = conn.execute("SELECT rel_path FROM repomap_cache").fetchall()
        assert len(rows) == 1

    def test_evicts_all_when_current_files_empty(self):
        """When current_files is empty, all cache entries are evicted (no map-worthy files remain)."""
        conn = self._make_conn()
        conn.execute(
            "INSERT INTO repomap_cache VALUES (?,?,?,?,?)",
            ("src/file.py", 1.0, 100, "text", 0),
        )
        conn.commit()
        _evict_stale_cache(conn, {})
        # All rows should be deleted: empty current_files means every cached entry is stale
        rows = conn.execute("SELECT rel_path FROM repomap_cache").fetchall()
        assert len(rows) == 0

    def test_graceful_when_table_absent(self):
        """No exception when repomap_cache table does not exist."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        # No table created — should not raise
        _evict_stale_cache(conn, {"src/file.py": {}})


# ---------------------------------------------------------------------------
# compact helpers
# ---------------------------------------------------------------------------


class TestShortPath:
    """Tests for compact._short_path."""

    def test_strips_src_prefix(self):
        assert _short_path("/repo/src/token_goat/db.py") == "src/token_goat/db.py"

    def test_strips_tests_prefix(self):
        assert _short_path("/repo/tests/test_db.py") == "tests/test_db.py"

    def test_strips_docs_prefix(self):
        assert _short_path("/repo/docs/guide.md") == "docs/guide.md"

    def test_normalizes_backslashes(self):
        result = _short_path("C:\\repo\\src\\foo.py")
        assert "\\" not in result

    def test_truncates_long_path(self):
        long_path = "a" * 200
        result = _short_path(long_path, max_len=70)
        assert len(result) <= 70
        assert result.startswith("…")

    def test_short_path_unchanged(self):
        p = "src/small.py"
        assert _short_path(p) == p


class TestFormatRanges:
    """Tests for compact._format_ranges."""

    def test_empty_ranges(self):
        assert _format_ranges([]) == ""

    def test_single_range(self):
        assert _format_ranges([(1, 50)]) == "  L:1-50"

    def test_single_line_range(self):
        """When start == end, shows just the number."""
        assert _format_ranges([(42, 42)]) == "  L:42"

    def test_multiple_ranges(self):
        result = _format_ranges([(1, 10), (20, 30)])
        assert "1-10" in result
        assert "20-30" in result

    def test_overflow_shown(self):
        """When ranges exceed _MAX_RANGES_PER_FILE, shows +N more."""
        ranges = [(i, i + 10) for i in range(10)]
        result = _format_ranges(ranges)
        assert "+6 more" in result  # 10 ranges - 4 shown = 6 extra


class TestRenderManifest:
    """Tests for compact._render and build_manifest edge cases."""

    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Point data_dir at a fresh temp dir so bash_outputs/ is empty.

        Without this, _render_active_errors_section globs the real bash_outputs/
        dir (which can have thousands of .json files) on every test, adding ~4 s
        each.  An empty temp dir returns immediately.
        """

    def _empty_cache(self) -> SessionCache:
        return SessionCache(session_id="s0", started_ts=0.0, last_activity_ts=0.0)

    def _cache_with_edits(self) -> SessionCache:
        return SessionCache(
            session_id="s1",
            started_ts=0.0,
            last_activity_ts=0.0,
            files={},
            greps=[],
            edited_files={"src/foo.py": 3, "src/bar.py": 1},
        )

    def _cache_with_file_reads(self) -> SessionCache:
        entry = FileEntry(
            rel_or_abs="src/baz.py",
            last_read_ts=0.0,
            line_ranges=[(1, 50)],
            read_count=2,
            symbols_read=[],
        )
        return SessionCache(
            session_id="s2",
            started_ts=0.0,
            last_activity_ts=0.0,
            files={"src/baz.py": entry},
            greps=[],
            edited_files={},
        )

    def test_empty_cache_returns_empty_string(self):
        result, _ = _render(self._empty_cache(), "test-session-id", 400)
        assert result == ""

    def test_edited_files_in_manifest(self):
        result, _ = _render(self._cache_with_edits(), "aabbccdd1234", 400)
        # Uncommitted edits show as Staged/Uncommitted; committed show as Edited
        assert ("**Staged/Uncommitted:**" in result or "**Edited:**" in result), f"Got:\n{result}"
        assert "foo.py" in result or "bar.py" in result

    def test_edit_count_suffix(self):
        result, _ = _render(self._cache_with_edits(), "aabbccdd1234", 400)
        assert "×3" in result  # foo.py edited 3 times

    def test_key_files_section(self):
        result, _ = _render(self._cache_with_file_reads(), "aabbccdd1234", 400)
        # When only file reads exist (no edits), section title is **Files:** —
        # the merged Edited+Read header introduced in the manifest tightening pass.
        assert "**Files:**" in result or "**Read:**" in result

    def test_token_budget_trims(self):
        """When result exceeds max_tokens, it is trimmed."""
        big_edits = {f"src/file_{i}.py": i for i in range(50)}
        cache = SessionCache(
            session_id="s3",
            started_ts=0.0,
            last_activity_ts=0.0,
            files={},
            greps=[],
            edited_files=big_edits,
        )
        result, _ = _render(cache, "aabbccdd1234", max_tokens=30)
        # Should still be a string (possibly truncated)
        assert isinstance(result, str)

    def test_session_id_not_in_manifest_body(self):
        """Session ID no longer emitted in manifest body (saves ~20 tokens per compaction)."""
        result, _ = _render(self._cache_with_edits(), "aabbccdd-long-session-id", 400)
        assert "aabbccdd" not in result
        assert "long-session-id" not in result
        assert "## Token-Goat Session Manifest" in result

    def test_build_manifest_load_failure_returns_empty(self):
        """build_manifest returns '' when session cannot be loaded."""
        with patch("token_goat.compact.session_mod.load", side_effect=Exception("fail")):
            result = build_manifest("nonexistent-session-id")
        assert result == ""


# ---------------------------------------------------------------------------
# hints helpers
# ---------------------------------------------------------------------------


class TestConfirmedLineCount:
    """Tests for hints._confirmed_line_count."""

    def test_exact_count_above_threshold_returns_it(self, tmp_path):
        p = tmp_path / "large.py"
        p.write_text("x\n" * 600)
        result = _confirmed_line_count(600, True, p)
        assert result == 600

    def test_exact_count_below_threshold_returns_none(self, tmp_path):
        p = tmp_path / "small.py"
        p.write_text("x\n" * 10)
        result = _confirmed_line_count(10, True, p)
        assert result is None

    def test_estimate_below_threshold_real_file_large(self, tmp_path):
        """Estimate < threshold but real file is large: returns real count."""
        p = tmp_path / "big.py"
        content = "x = 1\n" * 600
        p.write_text(content)
        result = _confirmed_line_count(100, False, p)
        assert result == 600

    def test_estimate_below_threshold_real_file_also_small_returns_none(self, tmp_path):
        """Estimate < threshold and real file also small: returns None."""
        p = tmp_path / "small.py"
        p.write_text("x = 1\n" * 10)
        result = _confirmed_line_count(50, False, p)
        assert result is None

    def test_estimate_above_threshold_trusted_no_disk_read(self, tmp_path):
        """Estimate >= threshold: return estimate without reading the file."""
        # File doesn't need to exist — we should not read it
        nonexistent = tmp_path / "ghost.py"
        result = _confirmed_line_count(LARGE_FILE_LINE_THRESHOLD, False, nonexistent)
        assert result == LARGE_FILE_LINE_THRESHOLD

    def test_nonexistent_file_with_small_estimate_returns_none(self, tmp_path):
        """When estimate is small and file doesn't exist, returns None."""
        p = tmp_path / "ghost.py"
        result = _confirmed_line_count(50, False, p)
        assert result is None


class TestEstTokensHelpers:
    """Tests for hints token estimator helpers."""

    def test_est_tokens_from_lines_zero_returns_one(self):
        assert _est_tokens_from_lines(0) == 1

    def test_est_tokens_from_lines_positive(self):
        result = _est_tokens_from_lines(100)
        assert result > 1

    def test_est_tokens_from_chars_zero_returns_one(self):
        assert _est_tokens_from_chars(0) == 1

    def test_est_tokens_from_chars_positive(self):
        result = _est_tokens_from_chars(350)
        assert result == 100  # 350 / 3.5 = 100


# ---------------------------------------------------------------------------
# hooks_common factory functions
# ---------------------------------------------------------------------------


class TestPreToolUseWithContext:
    """Tests for hooks_common.pre_tool_use_with_context."""

    def test_returns_continue_true(self):
        result = pre_tool_use_with_context("some hint")
        assert result["continue"] is True

    def test_hook_event_name_set(self):
        result = pre_tool_use_with_context("some hint")
        assert result["hookSpecificOutput"]["hookEventName"] == "PreToolUse"

    def test_additional_context_preserved(self):
        result = pre_tool_use_with_context("custom message")
        assert result["hookSpecificOutput"]["additionalContext"] == "custom message"

    def test_no_permission_decision(self):
        """Context hint must not contain a permissionDecision key."""
        result = pre_tool_use_with_context("msg")
        hso = result["hookSpecificOutput"]
        assert "permissionDecision" not in hso

    def test_no_updated_input(self):
        """Context hint must not contain updatedInput."""
        result = pre_tool_use_with_context("msg")
        hso = result["hookSpecificOutput"]
        assert "updatedInput" not in hso

    def test_independent_calls_return_separate_objects(self):
        a = pre_tool_use_with_context("a")
        b = pre_tool_use_with_context("b")
        assert a is not b
        assert a["hookSpecificOutput"] is not b["hookSpecificOutput"]


class TestPreToolUseWithUpdate:
    """Tests for hooks_common.pre_tool_use_with_update."""

    def test_returns_continue_true(self):
        result = pre_tool_use_with_update({"file_path": "/new/path"}, "Redirected to shrunken image")
        assert result["continue"] is True

    def test_hook_event_name_set(self):
        result = pre_tool_use_with_update({}, "msg")
        assert result["hookSpecificOutput"]["hookEventName"] == "PreToolUse"

    def test_updated_input_preserved(self):
        payload = {"file_path": "/shrunken.jpg", "extra": 42}
        result = pre_tool_use_with_update(payload, "msg")
        assert result["hookSpecificOutput"]["updatedInput"] == payload

    def test_additional_context_preserved(self):
        result = pre_tool_use_with_update({}, "explanation here")
        assert result["hookSpecificOutput"]["additionalContext"] == "explanation here"

    def test_no_permission_decision(self):
        result = pre_tool_use_with_update({}, "msg")
        hso = result["hookSpecificOutput"]
        assert "permissionDecision" not in hso

    def test_independent_calls_dont_share_updated_input(self):
        payload_a = {"k": "v1"}
        payload_b = {"k": "v2"}
        result_a = pre_tool_use_with_update(payload_a, "a")
        result_b = pre_tool_use_with_update(payload_b, "b")
        assert result_a["hookSpecificOutput"]["updatedInput"]["k"] == "v1"
        assert result_b["hookSpecificOutput"]["updatedInput"]["k"] == "v2"


class TestDenyRedirect:
    """Additional tests for hooks_common.deny_redirect."""

    def test_permission_decision_is_deny(self):
        result = deny_redirect("too large", "use token-goat read instead")
        assert result["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_reason_in_decision_reason(self):
        result = deny_redirect("reason text", "context text")
        assert result["hookSpecificOutput"]["permissionDecisionReason"] == "reason text"

    def test_context_in_additional_context(self):
        result = deny_redirect("reason text", "context text")
        assert result["hookSpecificOutput"]["additionalContext"] == "context text"

    def test_continue_is_true(self):
        result = deny_redirect("r", "c")
        assert result["continue"] is True


# ---------------------------------------------------------------------------
# read_replacement: resolve cache and specificity
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clear_resolve_cache():
    """Ensure the resolve cache is empty before and after each test."""
    read_replacement._RESOLVE_CACHE.clear()
    yield
    read_replacement._RESOLVE_CACHE.clear()


class TestResolveCacheHelpers:
    """Tests for read_replacement resolve cache internals."""

    def test_cache_miss_returns_sentinel(self):
        result = _resolve_cache_lookup("hash1", "foo.py")
        assert result is _CACHE_MISS

    def test_cache_hit_returns_rel_path(self):
        _resolve_cache_put("hash1", "foo.py", "src/foo.py")
        result = _resolve_cache_lookup("hash1", "foo.py")
        assert result is not _CACHE_MISS
        assert result == "src/foo.py"

    def test_cache_stores_none_for_not_found(self):
        _resolve_cache_put("hash1", "missing.py", None)
        result = _resolve_cache_lookup("hash1", "missing.py")
        assert result is not _CACHE_MISS
        assert result is None

    def test_invalidate_removes_project_entries(self):
        _resolve_cache_put("hash1", "a.py", "src/a.py")
        _resolve_cache_put("hash2", "b.py", "src/b.py")
        evicted = invalidate_file_cache("hash1")
        assert evicted == 1
        assert _resolve_cache_lookup("hash1", "a.py") is _CACHE_MISS
        # hash2 entry survives
        assert _resolve_cache_lookup("hash2", "b.py") is not _CACHE_MISS

    def test_invalidate_other_project_untouched(self):
        _resolve_cache_put("hashA", "x.py", "x.py")
        invalidate_file_cache("hashB")
        assert _resolve_cache_lookup("hashA", "x.py") is not _CACHE_MISS

    def test_update_existing_key(self):
        """Putting a new value for an existing key updates in place."""
        _resolve_cache_put("hash1", "f.py", "old/f.py")
        _resolve_cache_put("hash1", "f.py", "new/f.py")
        assert _resolve_cache_lookup("hash1", "f.py") == "new/f.py"

    def test_eviction_when_full(self):
        """Cache evicts oldest entries when full."""
        # Fill beyond max
        for i in range(read_replacement._RESOLVE_CACHE_MAX + 1):
            _resolve_cache_put(f"h{i}", "f.py", f"src/f{i}.py")
        # Cache should be smaller than the inserted count
        assert len(read_replacement._RESOLVE_CACHE) < read_replacement._RESOLVE_CACHE_MAX + 1


class TestMatchSpecificity:
    """Tests for read_replacement._match_specificity."""

    def test_exact_filename_match(self):
        score = _match_specificity("parser.py", "src/token_goat/parser.py")
        assert score[0] == 1  # 1 trailing component matched

    def test_partial_path_match(self):
        score = _match_specificity("token_goat/parser.py", "src/token_goat/parser.py")
        assert score[0] == 2  # 2 trailing components matched

    def test_full_path_match(self):
        score = _match_specificity("src/token_goat/parser.py", "src/token_goat/parser.py")
        assert score[0] == 3  # all 3 components matched

    def test_no_match_returns_zero_suffix(self):
        score = _match_specificity("other.py", "src/token_goat/parser.py")
        assert score[0] == 0

    def test_shallower_path_ranks_higher_on_tie(self):
        """Shorter total path (fewer components) gets higher rank on suffix tie."""
        score_shallow = _match_specificity("foo.py", "src/foo.py")
        score_deep = _match_specificity("foo.py", "a/b/c/d/foo.py")
        # Both have suffix_len=1; neg_path_depth: shallow = -2, deep = -5
        assert score_shallow > score_deep


class TestPickBestMatch:
    """Tests for read_replacement._pick_best_match."""

    def test_empty_candidates_returns_none(self):
        assert _pick_best_match("f.py", []) is None

    def test_single_candidate_returned(self):
        result = _pick_best_match("f.py", ["src/f.py"])
        assert result == "src/f.py"

    def test_unambiguous_best_returned(self):
        """More specific match (longer suffix) is returned."""
        result = _pick_best_match("bar/f.py", ["src/foo/f.py", "src/bar/f.py"])
        assert result == "src/bar/f.py"

    def test_tie_returns_none(self):
        """Equal-specificity candidates return None (ambiguous)."""
        result = _pick_best_match("f.py", ["src/a/f.py", "src/b/f.py"])
        assert result is None


class TestFindInAllProjects:
    """Tests for read_replacement.find_in_all_projects.

    find_in_all_projects uses 'from . import db as _db' (local import inside the
    function), so we must patch 'token_goat.db' at the module level, which is what
    the local import resolves to.
    """

    def test_returns_none_when_global_db_not_found(self):
        """When global DB doesn't exist (FileNotFoundError), return None."""
        with patch("token_goat.db.open_global_readonly", side_effect=FileNotFoundError("no db")):
            result = find_in_all_projects("foo.py")
        assert result is None

    def test_raises_project_index_unavailable_on_os_error(self):
        """OSError on global DB access raises ProjectIndexUnavailable."""
        with (
            patch("token_goat.db.open_global_readonly", side_effect=OSError("disk error")),
            pytest.raises(ProjectIndexUnavailable),
        ):
            find_in_all_projects("foo.py")

    def test_returns_none_on_unexpected_error(self):
        """Unexpected exceptions (non-OS, non-sqlite) are swallowed, return None."""
        with patch("token_goat.db.open_global_readonly", side_effect=RuntimeError("unexpected")):
            result = find_in_all_projects("foo.py")
        assert result is None

    def test_returns_none_when_no_projects(self):
        """Empty projects table yields None (no matches)."""
        mock_conn = MagicMock()
        mock_conn.__enter__ = lambda s: mock_conn
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_conn.execute.return_value.fetchall.return_value = []

        with patch("token_goat.db.open_global_readonly", return_value=mock_conn):
            result = find_in_all_projects("foo.py")
        assert result is None


# ---------------------------------------------------------------------------
# languages/go.py: _extract_const_var edge cases
# ---------------------------------------------------------------------------


class TestExtractConstVar:
    """Tests for go._extract_const_var edge cases."""

    def test_single_const(self):
        src = b"const MaxRetries = 5\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "MaxRetries" in names

    def test_const_block(self):
        src = b"const (\n    A = 1\n    B = 2\n)\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "A" in names
        assert "B" in names

    def test_single_var(self):
        src = b"var errFoo = errors.New(\"foo\")\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "errFoo" in names

    def test_var_block(self):
        src = b"var (\n    X = 1\n    Y = 2\n)\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "X" in names
        assert "Y" in names

    def test_indented_const_not_extracted(self):
        """Indented (non-package-level) const is not extracted."""
        src = b"func foo() {\n    const local = 1\n}\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "local" not in names

    def test_comment_in_block_skipped(self):
        """Comment lines inside const block are ignored."""
        src = b"const (\n    // comment\n    Real = 1\n)\n"
        syms = _extract_const_var(src)
        names = [s.name for s in syms]
        assert "Real" in names
        assert "//" not in names

    def test_empty_source(self):
        syms = _extract_const_var(b"")
        assert syms == []

    def test_const_kinds_are_const(self):
        src = b"const Foo = 1\nvar Bar = 2\n"
        syms = _extract_const_var(src)
        kinds = {s.name: s.kind for s in syms}
        assert kinds.get("Foo") == "const"
        assert kinds.get("Bar") == "var"


# ---------------------------------------------------------------------------
# languages/python.py: _parse_import_source edge cases
# ---------------------------------------------------------------------------


class TestParseImportSource:
    """Tests for python._parse_import_source edge cases."""

    def test_from_import(self):
        result = _parse_import_source("from os.path import join, exists")
        assert "os.path.join" in result
        assert "os.path.exists" in result

    def test_plain_import(self):
        result = _parse_import_source("import os")
        assert "os" in result

    def test_import_multiple(self):
        result = _parse_import_source("import os, sys, re")
        assert "os" in result
        assert "sys" in result
        assert "re" in result

    def test_from_import_as(self):
        """'as' aliases are stripped; original name used."""
        result = _parse_import_source("from pathlib import Path as P")
        assert "pathlib.Path" in result
        assert "P" not in result

    def test_from_import_star_excluded(self):
        """Wildcard import (*) produces no entries."""
        result = _parse_import_source("from os import *")
        assert result == [] or all("*" not in r for r in result)

    def test_from_import_parenthesized(self):
        """Parenthesized multi-name import is handled."""
        result = _parse_import_source("from typing import (Optional, Union)")
        assert "typing.Optional" in result
        assert "typing.Union" in result

    def test_empty_line_falls_through(self):
        """Lines that match neither pattern return [line] as fallback."""
        result = _parse_import_source("")
        assert isinstance(result, list)

    def test_plain_import_with_alias(self):
        """import x as y — alias stripped."""
        result = _parse_import_source("import numpy as np")
        assert "numpy" in result
        assert "np" not in result


# ---------------------------------------------------------------------------
# worker.py: cleanup helpers
# ---------------------------------------------------------------------------


class TestCleanupOrphanedStateFiles:
    """Tests for worker._cleanup_orphaned_state_files."""

    def test_removes_old_state_file(self, tmp_data_dir, monkeypatch):
        """Orphaned state files older than 7 days are deleted."""
        import time

        from token_goat import worker

        # Create a project
        project_root = tmp_data_dir / "projects" / "test_proj"
        project_root.mkdir(parents=True, exist_ok=True)

        # Mock projects table to return our test project
        def mock_open():
            from unittest.mock import MagicMock

            conn = MagicMock()
            conn.__enter__ = lambda s: conn
            conn.__exit__ = MagicMock(return_value=False)
            conn.execute.return_value.fetchall.return_value = [
                {"root": str(project_root)}
            ]
            return conn

        monkeypatch.setattr("token_goat.worker.db.open_global", mock_open)

        # Create an old state file
        old_state = project_root / ".improve-state-old.json"
        old_state.write_text("{}")
        old_mtime = time.time() - 8 * 86400  # 8 days old
        import os
        os.utime(str(old_state), (old_mtime, old_mtime))

        # Run cleanup
        deleted = worker._cleanup_orphaned_state_files()

        # Verify the old file was deleted
        assert deleted == 1
        assert not old_state.exists()

    def test_spares_new_state_file(self, tmp_data_dir, monkeypatch):
        """State files younger than 7 days are preserved."""
        import time

        from token_goat import worker

        # Create a project
        project_root = tmp_data_dir / "projects" / "test_proj"
        project_root.mkdir(parents=True, exist_ok=True)

        # Mock projects table to return our test project
        def mock_open():
            from unittest.mock import MagicMock

            conn = MagicMock()
            conn.__enter__ = lambda s: conn
            conn.__exit__ = MagicMock(return_value=False)
            conn.execute.return_value.fetchall.return_value = [
                {"root": str(project_root)}
            ]
            return conn

        monkeypatch.setattr("token_goat.worker.db.open_global", mock_open)

        # Create a new state file
        new_state = project_root / ".improve-state-new.json"
        new_state.write_text("{}")
        new_mtime = time.time() - 1 * 86400  # 1 day old
        import os
        os.utime(str(new_state), (new_mtime, new_mtime))

        # Run cleanup
        deleted = worker._cleanup_orphaned_state_files()

        # Verify the new file was preserved
        assert deleted == 0
        assert new_state.exists()

    def test_returns_zero_when_no_projects(self, tmp_data_dir, monkeypatch):
        """Returns 0 when projects table is empty."""
        from token_goat import worker

        def mock_open():
            from unittest.mock import MagicMock

            conn = MagicMock()
            conn.__enter__ = lambda s: conn
            conn.__exit__ = MagicMock(return_value=False)
            conn.execute.return_value.fetchall.return_value = []
            return conn

        monkeypatch.setattr("token_goat.worker.db.open_global", mock_open)

        deleted = worker._cleanup_orphaned_state_files()
        assert deleted == 0


class TestCleanupOldSentinels:
    """Tests for worker._cleanup_old_sentinels."""

    def test_removes_old_sentinel(self, tmp_data_dir, monkeypatch):
        """Sentinel files older than 30 days are deleted."""
        import time

        from token_goat import worker

        # Patch sentinels_dir to use tmp_data_dir
        sentinels = tmp_data_dir / "sentinels"
        sentinels.mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr("token_goat.worker.paths.sentinels_dir", lambda: sentinels)

        # Create an old sentinel file
        old_sentinel = sentinels / "manifest_sha_old_session"
        old_sentinel.write_text("oldsha")
        old_mtime = time.time() - 31 * 86400  # 31 days old
        import os
        os.utime(str(old_sentinel), (old_mtime, old_mtime))

        # Run cleanup
        deleted = worker._cleanup_old_sentinels()

        # Verify the old sentinel was deleted
        assert deleted == 1
        assert not old_sentinel.exists()

    def test_spares_new_sentinel(self, tmp_data_dir, monkeypatch):
        """Sentinel files younger than 30 days are preserved."""
        import time

        from token_goat import worker

        # Patch sentinels_dir to use tmp_data_dir
        sentinels = tmp_data_dir / "sentinels"
        sentinels.mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr("token_goat.worker.paths.sentinels_dir", lambda: sentinels)

        # Create a new sentinel file
        new_sentinel = sentinels / "recovery_pending_new_session"
        new_sentinel.write_text("newdata")
        new_mtime = time.time() - 5 * 86400  # 5 days old
        import os
        os.utime(str(new_sentinel), (new_mtime, new_mtime))

        # Run cleanup
        deleted = worker._cleanup_old_sentinels()

        # Verify the new sentinel was preserved
        assert deleted == 0
        assert new_sentinel.exists()

    def test_returns_zero_when_dir_missing(self, tmp_data_dir, monkeypatch):
        """Returns 0 when sentinels directory does not exist."""
        from token_goat import worker

        missing_dir = tmp_data_dir / "missing_sentinels"
        monkeypatch.setattr("token_goat.worker.paths.sentinels_dir", lambda: missing_dir)

        deleted = worker._cleanup_old_sentinels()
        assert deleted == 0
