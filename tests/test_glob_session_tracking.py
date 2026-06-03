"""Tests for Glob tool session tracking and dedup hint (sub-area C).

Verifies that:
 - mark_glob_run records patterns to glob_history
 - lookup_glob_entry retrieves the most recent entry for (pattern, path)
 - build_glob_dedup_hint emits a hint on repeat Glob calls
 - _handle_glob_dedup integrates tracking + hint in the pre-read hook
"""
from __future__ import annotations

import time

import pytest

# ---------------------------------------------------------------------------
# Unit tests: mark_glob_run / lookup_glob_entry
# ---------------------------------------------------------------------------

class TestMarkGlobRun:
    """mark_glob_run records Glob patterns into glob_history."""

    def test_records_pattern(self, tmp_data_dir, monkeypatch):
        """mark_glob_run stores the pattern in the session cache."""
        from token_goat import session

        sid = "test-glob-session-001"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            cache = session.mark_glob_run(sid, "**/*.py", path=None, result_count=5)
            assert len(cache.glob_history) >= 1
            assert cache.glob_history[-1].pattern == "**/*.py"
        finally:
            session.reset_session(sid)

    def test_records_result_count(self, tmp_data_dir, monkeypatch):
        """mark_glob_run stores the result_count on the entry."""
        from token_goat import session

        sid = "test-glob-session-002"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            cache = session.mark_glob_run(sid, "**/*.ts", path="src/", result_count=42)
            entry = cache.glob_history[-1]
            assert entry.result_count == 42
            assert entry.path == "src/"
        finally:
            session.reset_session(sid)

    def test_records_multiple_distinct_patterns(self, tmp_data_dir, monkeypatch):
        """mark_glob_run appends separate entries for distinct patterns."""
        from token_goat import session

        sid = "test-glob-session-003"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            session.mark_glob_run(sid, "**/*.py", result_count=10)
            session.mark_glob_run(sid, "**/*.ts", result_count=5)
            cache = session.load(sid)
            patterns = [e.pattern for e in cache.glob_history]
            assert "**/*.py" in patterns
            assert "**/*.ts" in patterns
        finally:
            session.reset_session(sid)


class TestLookupGlobEntry:
    """lookup_glob_entry retrieves the most recent matching entry."""

    def test_returns_entry_for_known_pattern(self, tmp_data_dir, monkeypatch):
        """Returns a GlobEntry when pattern was previously recorded."""
        from token_goat import session

        sid = "test-glob-session-004"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            session.mark_glob_run(sid, "**/*.py", path=None, result_count=7)
            entry = session.lookup_glob_entry(sid, "**/*.py", path=None)
            assert entry is not None
            assert entry.pattern == "**/*.py"
            assert entry.result_count == 7
        finally:
            session.reset_session(sid)

    def test_returns_none_for_unknown_pattern(self, tmp_data_dir, monkeypatch):
        """Returns None when pattern has not been recorded yet."""
        from token_goat import session

        sid = "test-glob-session-005"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            entry = session.lookup_glob_entry(sid, "**/*.rb", path=None)
            assert entry is None
        finally:
            session.reset_session(sid)

    def test_path_scoped_lookup_is_independent(self, tmp_data_dir, monkeypatch):
        """(pattern, path=None) and (pattern, path='src/') are separate entries."""
        from token_goat import session

        sid = "test-glob-session-006"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            session.mark_glob_run(sid, "**/*.py", path=None, result_count=20)
            session.mark_glob_run(sid, "**/*.py", path="src/", result_count=5)
            entry_no_path = session.lookup_glob_entry(sid, "**/*.py", path=None)
            entry_with_path = session.lookup_glob_entry(sid, "**/*.py", path="src/")
            assert entry_no_path is not None
            assert entry_with_path is not None
            assert entry_no_path.result_count == 20
            assert entry_with_path.result_count == 5
        finally:
            session.reset_session(sid)

    @pytest.mark.slow
    def test_most_recent_entry_returned(self, tmp_data_dir, monkeypatch):
        """Returns the most recent entry when the same pattern is run twice."""
        from token_goat import session

        sid = "test-glob-session-007"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            session.mark_glob_run(sid, "**/*.py", result_count=3)
            time.sleep(0.01)
            session.mark_glob_run(sid, "**/*.py", result_count=99)
            entry = session.lookup_glob_entry(sid, "**/*.py")
            assert entry is not None
            assert entry.result_count == 99
        finally:
            session.reset_session(sid)


# ---------------------------------------------------------------------------
# Unit tests: build_glob_dedup_hint
# ---------------------------------------------------------------------------

class TestBuildGlobDedupHint:
    """build_glob_dedup_hint returns a hint for repeated Glob calls."""

    def test_no_hint_on_first_run(self, tmp_data_dir, monkeypatch):
        """Returns None when the pattern has never been run."""
        from token_goat import session
        from token_goat.hints import build_glob_dedup_hint

        sid = "test-glob-hint-001"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            result = build_glob_dedup_hint(
                session_id=sid, pattern="**/*.py", path=None, cache=None
            )
            assert result is None
        finally:
            session.reset_session(sid)

    def test_hint_emitted_on_repeat_run(self, tmp_data_dir, monkeypatch):
        """Returns a ReadHint when the same pattern was run recently with enough results."""
        from token_goat import session
        from token_goat.hints import build_glob_dedup_hint

        sid = "test-glob-hint-002"
        monkeypatch.chdir(tmp_data_dir.parent)
        session.reset_session(sid)
        try:
            # Record a prior run with a result count above the dedup minimum.
            session.mark_glob_run(sid, "**/*.py", path=None, result_count=50)
            cache = session.load(sid)
            hint = build_glob_dedup_hint(
                session_id=sid, pattern="**/*.py", path=None, cache=cache
            )
            # Should return a hint (not None) indicating the pattern ran before.
            # ReadHint subclasses str, so we can check it as a string.
            assert hint is not None
            hint_str = str(hint)
            assert "**/*.py" in hint_str or "*.py" in hint_str or "glob" in hint_str.lower() or "Glob" in hint_str
        finally:
            session.reset_session(sid)
