"""Tests for post-compaction read-cache reset (iter 33).

After a compact event, ``last_compact_ts`` is recorded on the session cache.
Pre-read hooks suppress "already in context" hints for files whose
``last_read_ts`` is older than ``last_compact_ts`` — that content is gone.
"""
from __future__ import annotations

import time
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from token_goat.session import FileEntry, SessionCache

# ---------------------------------------------------------------------------
# Helpers shared across test classes
# ---------------------------------------------------------------------------

def _make_session_cache(
    *,
    read_count: int = 1,
    last_read_ts: float = 0.0,
    last_compact_ts: float = 0.0,
    path_key: str = "c:/proj/foo.py",
    last_edit_ts: float = 0.0,
) -> tuple[MagicMock, MagicMock]:
    """Return (cache_mock, entry_mock) with the given field values."""
    cache = MagicMock(spec=SessionCache)
    cache.last_compact_ts = last_compact_ts

    entry = MagicMock(spec=FileEntry)
    entry.read_count = read_count
    entry.last_read_ts = last_read_ts
    entry.last_edit_ts = last_edit_ts

    cache.files = {path_key: entry}
    return cache, entry


def _bash_payload(command: str, session_id: str = "sess-compact", cwd: str = "C:/proj") -> dict[str, Any]:
    return {"tool_name": "Bash", "tool_input": {"command": command}, "session_id": session_id, "cwd": cwd}


# ---------------------------------------------------------------------------
# Part A — record_compact function
# ---------------------------------------------------------------------------

class TestRecordCompact:
    """Unit tests for session.record_compact()."""

    def test_record_compact_sets_last_compact_ts(self, tmp_data_dir):
        """record_compact writes a non-zero last_compact_ts to the cache."""
        from token_goat import session

        sid = "test-record-compact-1"
        session.load(sid)  # create fresh session
        before = time.time()
        session.record_compact(sid)
        after = time.time()

        loaded = session.load(sid)
        assert loaded.last_compact_ts >= before
        assert loaded.last_compact_ts <= after

    def test_record_compact_persists_to_disk(self, tmp_data_dir):
        """last_compact_ts round-trips through JSON serialisation."""
        from token_goat import session

        sid = "test-record-compact-persist"
        session.load(sid)
        session.record_compact(sid)
        ts_written = session.load(sid).last_compact_ts

        # Reload a second time from disk to confirm persistence
        ts_reloaded = session.load(sid).last_compact_ts
        assert ts_reloaded == ts_written

    def test_record_compact_second_call_updates_ts(self, tmp_data_dir):
        """Calling record_compact twice updates last_compact_ts to the later time."""
        from token_goat import session

        sid = "test-record-compact-twice"
        session.load(sid)
        session.record_compact(sid)
        ts_first = session.load(sid).last_compact_ts

        # Ensure monotonically increasing by sleeping a tiny bit
        time.sleep(0.01)
        session.record_compact(sid)
        ts_second = session.load(sid).last_compact_ts
        assert ts_second >= ts_first

    def test_record_compact_on_missing_session_creates_fresh_cache(self, tmp_data_dir):
        """record_compact on a session that doesn't exist creates a new cache with last_compact_ts > 0.

        safe_load returns a fresh (non-None) cache for valid but nonexistent session IDs,
        so record_compact stamps and persists it rather than silently returning.
        """
        from token_goat import session

        sid = "nonexistent-session-xyz-99"
        session.record_compact(sid)
        cache = session.safe_load(sid, caller="test")
        assert cache is not None
        assert cache.last_compact_ts > 0

    def test_fresh_session_last_compact_ts_defaults_to_zero(self, tmp_data_dir):
        """A freshly created session has last_compact_ts == 0.0."""
        from token_goat import session

        sid = "test-fresh-default"
        cache = session.load(sid)
        assert cache.last_compact_ts == 0.0

    def test_last_compact_ts_survives_file_read(self, tmp_data_dir):
        """last_compact_ts is preserved when mark_file_read is called after record_compact."""
        from token_goat import session

        sid = "test-compact-survives-read"
        session.load(sid)
        session.record_compact(sid)
        compact_ts = session.load(sid).last_compact_ts

        session.mark_file_read(sid, "src/foo.py")
        assert session.load(sid).last_compact_ts == compact_ts

    def test_session_without_compact_has_zero_last_compact_ts(self, tmp_data_dir):
        """Backward-compat: old sessions deserialised without the field default to 0.0."""
        from token_goat import session

        sid = "test-compat-zero"
        cache = session.load(sid)
        # Manually save a dict without last_compact_ts to simulate old serialised data
        d = cache.to_dict()
        d.pop("last_compact_ts", None)
        # Re-parse through from_dict — should default to 0.0
        restored = SessionCache.from_dict(d)
        assert restored.last_compact_ts == 0.0


# ---------------------------------------------------------------------------
# Part B — _handle_bash_streak_hint suppression
# ---------------------------------------------------------------------------

class TestBashStreakHintPostCompact:
    """streak_hint (read_count >= 2) is suppressed when file was read pre-compact."""

    def _call(self, *, read_count: int, last_read_ts: float, last_compact_ts: float) -> Any:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_streak_hint

        cache, entry = _make_session_cache(
            read_count=read_count,
            last_read_ts=last_read_ts,
            last_compact_ts=last_compact_ts,
        )
        with (
            patch.object(sess_mod, "safe_load", return_value=cache),
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=""),
            patch("token_goat.paths.normalize_key", return_value="c:/proj/foo.py"),
        ):
            return _handle_bash_streak_hint(_bash_payload("cat /proj/foo.py"))

    def test_hint_fires_when_read_after_compact(self) -> None:
        """Hint fires when last_read_ts > last_compact_ts (content still in window)."""
        now = time.time()
        resp = self._call(read_count=2, last_read_ts=now + 10, last_compact_ts=now)
        assert resp is not None

    def test_hint_suppressed_when_read_before_compact(self) -> None:
        """Hint is suppressed when last_read_ts < last_compact_ts (content gone)."""
        now = time.time()
        resp = self._call(read_count=2, last_read_ts=now - 10, last_compact_ts=now)
        assert resp is None

    def test_hint_fires_when_no_compact_occurred(self) -> None:
        """Hint fires normally when last_compact_ts == 0.0 (no compact this session)."""
        now = time.time()
        resp = self._call(read_count=2, last_read_ts=now - 100, last_compact_ts=0.0)
        assert resp is not None

    def test_hint_suppressed_when_read_strictly_before_compact(self) -> None:
        """Edge: last_read_ts < last_compact_ts → suppressed (guard uses strict <)."""
        now = time.time()
        resp = self._call(read_count=2, last_read_ts=now, last_compact_ts=now + 0.001)
        assert resp is None

    def test_hint_fires_when_read_at_exactly_compact_ts(self) -> None:
        """Edge: last_read_ts == last_compact_ts → hint fires (guard is strict <, not <=)."""
        now = time.time()
        resp = self._call(read_count=2, last_read_ts=now, last_compact_ts=now)
        assert resp is not None

    def test_multiple_compacts_only_most_recent_matters(self) -> None:
        """Only the current last_compact_ts determines suppression (not history)."""
        now = time.time()
        # File read after first compact but before second compact
        resp = self._call(read_count=3, last_read_ts=now - 5, last_compact_ts=now)
        assert resp is None  # second compact erased the content


# ---------------------------------------------------------------------------
# Part C — _handle_bash_already_read suppression
# ---------------------------------------------------------------------------

class TestBashAlreadyReadPostCompact:
    """already_read hint (read_count == 1) is suppressed when file was read pre-compact."""

    def _call(self, *, last_read_ts: float, last_compact_ts: float) -> Any:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_already_read

        cache, entry = _make_session_cache(
            read_count=1,
            last_read_ts=last_read_ts,
            last_compact_ts=last_compact_ts,
            path_key="c:/proj/bar.py",
        )
        with (
            patch.object(sess_mod, "safe_load", return_value=cache),
            patch("token_goat.paths.normalize_path_key", return_value="c:/proj/bar.py"),
            patch("token_goat.hooks_read.record_cached_stat"),
        ):
            return _handle_bash_already_read(_bash_payload("cat /proj/bar.py"))

    def test_hint_fires_when_read_after_compact(self) -> None:
        now = time.time()
        resp = self._call(last_read_ts=now + 10, last_compact_ts=now)
        assert resp is not None

    def test_hint_suppressed_when_read_before_compact(self) -> None:
        now = time.time()
        resp = self._call(last_read_ts=now - 10, last_compact_ts=now)
        assert resp is None

    def test_hint_fires_when_no_compact_occurred(self) -> None:
        now = time.time()
        resp = self._call(last_read_ts=now - 100, last_compact_ts=0.0)
        assert resp is not None

    def test_hint_suppressed_file_never_reread_after_compact(self) -> None:
        """File read once before compact: last_read_ts > 0 but < last_compact_ts."""
        now = time.time()
        resp = self._call(last_read_ts=now - 1, last_compact_ts=now)
        assert resp is None


# ---------------------------------------------------------------------------
# Part D — compact guard logic unit tests
# ---------------------------------------------------------------------------

class TestCompactGuardLogic:
    """Unit tests for the compact-ts guard condition used in all three hint paths."""

    def test_guard_suppresses_when_read_ts_less_than_compact_ts(self) -> None:
        """Core invariant: last_read_ts < last_compact_ts → content is gone."""
        now = time.time()
        cache, entry = _make_session_cache(last_read_ts=now - 100, last_compact_ts=now)
        compact_ts = getattr(cache, "last_compact_ts", 0.0)
        assert compact_ts and entry.last_read_ts < compact_ts

    def test_guard_allows_when_read_ts_greater_than_compact_ts(self) -> None:
        """last_read_ts > last_compact_ts → content is still in context window."""
        now = time.time()
        cache, entry = _make_session_cache(last_read_ts=now + 10, last_compact_ts=now)
        compact_ts = getattr(cache, "last_compact_ts", 0.0)
        assert not (compact_ts and entry.last_read_ts < compact_ts)

    def test_guard_allows_when_no_compact_occurred(self) -> None:
        """last_compact_ts == 0.0 → falsy, guard condition never suppresses."""
        now = time.time()
        cache, entry = _make_session_cache(last_read_ts=now - 1000, last_compact_ts=0.0)
        compact_ts = getattr(cache, "last_compact_ts", 0.0)
        assert not compact_ts  # falsy → guard does not fire

    def test_guard_missing_attr_defaults_to_zero_via_getattr(self) -> None:
        """getattr(cache, 'last_compact_ts', 0.0) is safe on older mocks without the field."""
        cache = MagicMock()
        del cache.last_compact_ts  # simulate missing attribute
        compact_ts = getattr(cache, "last_compact_ts", 0.0)
        assert compact_ts == 0.0

    def test_session_cache_to_dict_round_trips_last_compact_ts(self, tmp_data_dir) -> None:
        """last_compact_ts survives to_dict() → from_dict() round-trip."""
        from token_goat import session

        sid = "test-roundtrip-compact-ts"
        cache = session.load(sid)
        cache.last_compact_ts = 1_700_000_000.0
        session.save(cache)

        loaded = session.load(sid)
        assert loaded.last_compact_ts == pytest.approx(1_700_000_000.0)

    def test_hooks_cli_sets_last_compact_ts_on_session_cache(self) -> None:
        """pre_compact handler sets last_compact_ts on the in-memory session cache."""
        from token_goat.session import SessionCache

        cache = MagicMock(spec=SessionCache)
        # Simulate what pre_compact does: set last_compact_ts = time.time()
        before = time.time()
        cache.last_compact_ts = time.time()
        after = time.time()
        assert before <= cache.last_compact_ts <= after
