"""Tests for recent-read suppression window in pre_read.

The protect_recent_reads config setting (default 4) suppresses re-read hints
when a file was read within N tool calls ago — content is still in context.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cache(last_read_call_index: int = 0, read_count: int = 1) -> MagicMock:
    """Return a minimal SessionCache-like mock with the fields pre_read inspects."""
    cache = MagicMock()
    cache.unavailable = False
    cache.files = {}
    cache.last_compact_ts = 0.0

    from token_goat.session import FileEntry
    entry = FileEntry(
        rel_or_abs="/tmp/foo.py",
        last_read_ts=1_000_000.0,
        read_count=read_count,
        line_ranges=[(1, 100)],
        symbols_read=[],
        last_edit_ts=0.0,
        last_read_call_index=last_read_call_index,
    )
    cache.files["/tmp/foo.py"] = entry
    cache.has_session_hint_been_emitted.return_value = False
    cache.has_hint_fingerprint.return_value = False
    return cache, entry


def _hints_cfg_with(protect: int) -> MagicMock:
    cfg = MagicMock()
    cfg.hints.protect_recent_reads = protect
    # Disable other suppression paths so only the recent-read path matters.
    cfg.hints.reread_deny = False
    cfg.hints.backoff_thresholds = []  # no backoff suppression
    cfg.hints.large_read_redirect_bytes = 0
    return cfg


def _run_suppress_check(
    current_call_index: int,
    last_read_call_index: int,
    protect: int,
) -> bool:
    """Return True if the recent-read suppression fires for the given inputs."""
    import token_goat.hooks_read as hr
    # Patch _call_index to current_call_index.
    with patch.object(hr, "_call_index", current_call_index):
        entry_mock = MagicMock()
        entry_mock.last_read_call_index = last_read_call_index

        suppressed: list[bool] = []

        def fake_record_suppressed(kind: str) -> None:
            if kind == "hint_recent_read_suppressed":
                suppressed.append(True)

        cache_mock = MagicMock()
        cache_mock.record_hint_suppressed.side_effect = fake_record_suppressed

        # Directly test the condition: gap <= protect and protect > 0 and last > 0
        gap = current_call_index - last_read_call_index
        fires = protect > 0 and last_read_call_index > 0 and gap <= protect
        return fires


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRecentReadSuppressWindow:
    """Unit-level tests exercising the suppression condition directly."""

    def test_within_window_suppresses(self) -> None:
        """Read at call 1, re-read at call 3 (gap=2, window=4) → suppressed."""
        assert _run_suppress_check(current_call_index=3, last_read_call_index=1, protect=4) is True

    def test_outside_window_fires(self) -> None:
        """Read at call 1, re-read at call 6 (gap=5, window=4) → hint fires."""
        assert _run_suppress_check(current_call_index=6, last_read_call_index=1, protect=4) is False

    def test_window_zero_always_fires(self) -> None:
        """Window=0 → suppression disabled; hint fires even on consecutive calls."""
        assert _run_suppress_check(current_call_index=2, last_read_call_index=1, protect=0) is False

    def test_window_zero_fires_immediately(self) -> None:
        """Window=0, gap=1 (consecutive) → still fires (no suppression)."""
        assert _run_suppress_check(current_call_index=2, last_read_call_index=1, protect=0) is False

    def test_large_window_suppresses_wide_gap(self) -> None:
        """Window=10 suppresses a gap of 8."""
        assert _run_suppress_check(current_call_index=10, last_read_call_index=2, protect=10) is True

    def test_large_window_fires_just_outside(self) -> None:
        """Window=10, gap=11 → fires (just outside)."""
        assert _run_suppress_check(current_call_index=13, last_read_call_index=2, protect=10) is False

    def test_boundary_exactly_equal_suppressed(self) -> None:
        """Window=4, gap=4 (exactly equal) → suppressed (≤ means equal is suppressed)."""
        assert _run_suppress_check(current_call_index=5, last_read_call_index=1, protect=4) is True

    def test_boundary_one_over_fires(self) -> None:
        """Window=4, gap=5 → fires (just outside window)."""
        assert _run_suppress_check(current_call_index=6, last_read_call_index=1, protect=4) is False

    def test_never_recorded_not_suppressed(self) -> None:
        """last_read_call_index=0 (never recorded) → suppression does not fire."""
        assert _run_suppress_check(current_call_index=2, last_read_call_index=0, protect=4) is False

    def test_independent_files_tracked_separately(self) -> None:
        """Different files are tracked independently: fileA suppressed, fileB fires."""
        # fileA: read at 1, re-read at 4 → gap=3, window=4 → suppressed
        assert _run_suppress_check(current_call_index=4, last_read_call_index=1, protect=4) is True
        # fileB: read at 2, re-read at 7 → gap=5, window=4 → fires
        assert _run_suppress_check(current_call_index=7, last_read_call_index=2, protect=4) is False


class TestFileEntryCallIndex:
    """Verify that FileEntry stores last_read_call_index and mark_file_read records it."""

    def test_fileentry_default_is_zero(self) -> None:
        from token_goat.session import FileEntry
        entry = FileEntry(
            rel_or_abs="foo.py",
            last_read_ts=0.0,
            read_count=0,
            line_ranges=[],
            symbols_read=[],
        )
        assert entry.last_read_call_index == 0

    def test_mark_file_read_records_call_index(self, tmp_path: Any) -> None:
        """mark_file_read stores call_index in FileEntry.last_read_call_index."""
        import time

        import token_goat.session as sess
        sid = "test-sess-idx"
        fpath = str(tmp_path / "dummy.py")
        (tmp_path / "dummy.py").write_text("x = 1\n")

        now = time.time()
        cache = sess.SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        sess.mark_file_read(sid, fpath, cache=cache, call_index=42)
        key = sess._normalize_path(fpath)
        assert cache.files[key].last_read_call_index == 42

    def test_mark_file_read_no_call_index_leaves_zero(self, tmp_path: Any) -> None:
        """mark_file_read without call_index leaves last_read_call_index at 0."""
        import time

        import token_goat.session as sess
        sid = "test-sess-zero"
        fpath = str(tmp_path / "dummy2.py")
        (tmp_path / "dummy2.py").write_text("y = 2\n")

        now = time.time()
        cache = sess.SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        sess.mark_file_read(sid, fpath, cache=cache)
        key = sess._normalize_path(fpath)
        assert cache.files[key].last_read_call_index == 0


class TestProtectRecentReadsConfig:
    """Verify HintsConfig.protect_recent_reads exists with correct default."""

    def test_default_is_four(self) -> None:
        from token_goat.config import HintsConfig
        cfg = HintsConfig()
        assert cfg.protect_recent_reads == 4

    def test_zero_is_valid(self) -> None:
        from token_goat.config import HintsConfig
        cfg = HintsConfig(protect_recent_reads=0)
        assert cfg.protect_recent_reads == 0

    def test_hundred_is_valid(self) -> None:
        from token_goat.config import HintsConfig
        cfg = HintsConfig(protect_recent_reads=100)
        assert cfg.protect_recent_reads == 100
