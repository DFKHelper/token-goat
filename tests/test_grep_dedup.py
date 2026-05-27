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
        assert "Grep `TODO`" in ctx or "Grep for `TODO`" in ctx
        assert "200 matches" in ctx

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
        """A pattern with fewer than minimum matches is not worth deduplicating."""
        _seed_grep("g-4", "TODO", result_count=4)
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

    def test_grep_dedup_min_matches_default(self, tmp_data_dir, monkeypatch):
        """Grep with fewer than 5 matches (default min) should not produce hint."""
        # Default threshold is 5
        _seed_grep("g-6", "SPECIFIC", result_count=4)
        payload = {
            "session_id": "g-6",
            "tool_name": "Grep",
            "tool_input": {"pattern": "SPECIFIC"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_grep_dedup_min_matches_at_threshold(self, tmp_data_dir):
        """Grep with exactly the min match count should produce hint."""
        _seed_grep("g-7", "TODO", result_count=5)
        payload = {
            "session_id": "g-7",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "Grep `TODO`" in ctx or "Grep for `TODO`" in ctx
        assert "5 matches" in ctx

    def test_grep_dedup_min_matches_env_override(self, tmp_data_dir, monkeypatch):
        """Environment variable TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES overrides config."""
        monkeypatch.setenv("TOKEN_GOAT_GREP_DEDUP_MIN_MATCHES", "0")
        # With min=0, even a single match should produce a hint (if non-stale)
        _seed_grep("g-8", "RARE", result_count=1)
        payload = {
            "session_id": "g-8",
            "tool_name": "Grep",
            "tool_input": {"pattern": "RARE"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "Grep `RARE`" in ctx or "Grep for `RARE`" in ctx
        assert "1 match" in ctx
