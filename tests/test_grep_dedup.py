"""Tests for the pre-Grep dedup hint and its session-tracking dependency."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_read, session


def _seed_grep(
    session_id: str,
    pattern: str,
    *,
    path: str | None = None,
    result_count: int = 100,
) -> None:
    """Record a fake Grep invocation in the session for the dedup tests."""
    session.mark_grep(session_id, pattern, path=path, result_count=result_count)


class TestGrepDedupHint:
    def test_repeat_pattern_triggers_hint(self, tmp_data_dir):
        _seed_grep("g-1", "TODO", result_count=200)
        payload = {
            "session_id": "g-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "Grep for `TODO`" in ctx
        assert "200 line(s)" in ctx

    def test_different_pattern_no_hint(self, tmp_data_dir):
        _seed_grep("g-2", "TODO", result_count=200)
        payload = {
            "session_id": "g-2",
            "tool_name": "Grep",
            "tool_input": {"pattern": "FIXME"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_path_scope_distinguishes(self, tmp_data_dir):
        """Same pattern with a different path is treated as a fresh query."""
        _seed_grep("g-3", "TODO", path="src/", result_count=200)
        payload = {
            "session_id": "g-3",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO", "path": "tests/"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_tiny_match_count_no_hint(self, tmp_data_dir):
        """A pattern that matched only a few lines is not worth deduplicating."""
        _seed_grep("g-4", "TODO", result_count=5)
        payload = {
            "session_id": "g-4",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_stale_grep_suppressed(self, tmp_data_dir):
        """A prior Grep older than the stale-age threshold is suppressed."""
        from token_goat import hints

        _seed_grep("g-5", "TODO", result_count=200)
        # Push the entry's timestamp into the past.
        cache = session.load("g-5")
        cache.greps[-1].ts -= hints.STALE_READ_AGE_SECONDS + 100
        session.save(cache)

        payload = {
            "session_id": "g-5",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result
