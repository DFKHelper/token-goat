"""Tests for partial-overlap Read hint (iter 9)."""
from __future__ import annotations


def _ctx(result: dict) -> str:
    return result.get("hookSpecificOutput", {}).get("additionalContext", "")


class TestHandlePartialOverlapHint:
    def test_partial_overlap_emits_hint(self, tmp_data_dir):
        """Read range partially overlapping cached range emits advisory hint."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_partial_overlap_hint

        sid = "poh-1"
        path = "/proj/src/foo.py"
        # Cache lines 1-100 (offset=0, limit=100)
        sess.mark_file_read(sid, path, offset=0, limit=100)
        entry = sess.get_file_entry(sid, path)

        # Request lines 51-200 (offset=50, limit=150) — partial overlap with 1-100
        tool_input = {"file_path": path, "offset": 50, "limit": 150}
        result = _handle_partial_overlap_hint(path, tool_input, entry)
        assert result is not None, "should emit hint for partial overlap"
        ctx = _ctx(result)
        assert "already in context" in ctx
        assert "foo.py" in ctx
        assert result.get("action") != "deny"

    def test_no_overlap_returns_none(self, tmp_data_dir):
        """Read range with no cached overlap returns None."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_partial_overlap_hint

        sid = "poh-2"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path, offset=0, limit=50)  # lines 1-50
        entry = sess.get_file_entry(sid, path)

        # Request lines 51-100 (offset=50, limit=50) — no overlap
        tool_input = {"file_path": path, "offset": 50, "limit": 50}
        result = _handle_partial_overlap_hint(path, tool_input, entry)
        assert result is None, "no overlap means no hint"

    def test_fully_covered_returns_none(self, tmp_data_dir):
        """Fully covered range returns None (deny handler's job)."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_partial_overlap_hint

        sid = "poh-3"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path, offset=0, limit=200)  # lines 1-200
        entry = sess.get_file_entry(sid, path)

        # Request lines 50-100 (offset=49, limit=51) — fully inside 1-200
        tool_input = {"file_path": path, "offset": 49, "limit": 51}
        result = _handle_partial_overlap_hint(path, tool_input, entry)
        assert result is None, "fully covered — deny handler handles it"

    def test_suggests_correct_offset_limit(self, tmp_data_dir):
        """Hint contains the correct narrowed offset/limit for the uncovered tail."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_partial_overlap_hint

        sid = "poh-4"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path, offset=0, limit=100)  # lines 1-100
        entry = sess.get_file_entry(sid, path)

        # Request lines 51-200 (offset=50, limit=150)
        tool_input = {"file_path": path, "offset": 50, "limit": 150}
        result = _handle_partial_overlap_hint(path, tool_input, entry)
        ctx = _ctx(result)
        # Uncovered: lines 101-200 → offset=100, limit=100
        assert "offset=100" in ctx
        assert "limit=100" in ctx

    def test_unbounded_read_returns_none(self, tmp_data_dir):
        """Unbounded reads (no limit) are skipped."""
        import token_goat.session as sess
        from token_goat.hooks_read import _handle_partial_overlap_hint

        sid = "poh-5"
        path = "/proj/src/foo.py"
        sess.mark_file_read(sid, path, offset=0, limit=50)
        entry = sess.get_file_entry(sid, path)

        tool_input = {"file_path": path, "offset": 25}  # no limit
        result = _handle_partial_overlap_hint(path, tool_input, entry)
        assert result is None, "unbounded reads skipped"

    def test_no_entry_returns_none(self, tmp_data_dir):
        """No session entry → None."""
        from token_goat.hooks_read import _handle_partial_overlap_hint

        tool_input = {"file_path": "/proj/src/foo.py", "offset": 0, "limit": 100}
        result = _handle_partial_overlap_hint("/proj/src/foo.py", tool_input, None)
        assert result is None


class TestPartialOverlapStatGroup:
    def test_stat_in_hints_group(self):
        from token_goat.render.stats_renderer import _kind_group_label
        assert _kind_group_label("read_partial_overlap_hint") == "Hints"
