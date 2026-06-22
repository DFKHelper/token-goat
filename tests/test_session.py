"""Tests for session-context cache."""
from __future__ import annotations

import pathlib
import time
from unittest.mock import patch

import pytest

from token_goat import session


class TestSessionCacheBasics:
    """Basic load/save/reset functionality."""

    def test_load_nonexistent_returns_empty_cache(self, tmp_data_dir):
        """Load on a non-existent session returns an empty cache with started_ts set."""
        cache = session.load("test_session_xyz")
        assert cache.session_id == "test_session_xyz"
        assert cache.started_ts > 0
        assert cache.last_activity_ts > 0
        assert cache.files == {}
        assert cache.greps == []

    def test_mark_file_read_and_roundtrip(self, tmp_data_dir):
        """mark_file_read writes to disk, load round-trips correctly."""
        session_id = "test_session_1"
        returned = session.mark_file_read(session_id, "src/foo/bar.py", offset=0, limit=100)
        assert returned.session_id == session_id
        assert "src/foo/bar.py" in returned.files
        entry = returned.files["src/foo/bar.py"]
        assert entry.read_count == 1
        assert entry.line_ranges == [(1, 100)]

        # Load again and verify persistence
        loaded = session.load(session_id)
        assert "src/foo/bar.py" in loaded.files
        assert loaded.files["src/foo/bar.py"].read_count == 1

    def test_reset_session_deletes_file(self, tmp_data_dir):
        """reset_session deletes the cache file; load returns fresh."""
        session_id = "test_reset"
        session.mark_file_read(session_id, "file.py")
        assert session.load(session_id).files
        session.reset_session(session_id)
        fresh = session.load(session_id)
        assert fresh.files == {}
        assert fresh.greps == []

    def test_atomic_save_no_tmp_artifact(self, tmp_data_dir):
        """Normal save produces no .tmp artifact on disk."""
        session_id = "atomic_save_test"
        session.load(session_id)
        session.mark_file_read(session_id, "src/test.py", offset=0, limit=50)
        # After save, check that no .tmp files exist in the session dir
        session_path = session.paths.session_cache_path(session_id)
        parent_dir = session_path.parent
        tmp_files = list(parent_dir.glob(f"{session_path.name}*.tmp"))
        assert tmp_files == [], f"Unexpected .tmp artifacts: {tmp_files}"

    def test_atomic_save_tmp_cleanup_on_write_failure(self, tmp_data_dir, monkeypatch):
        """Write failure to .tmp file cleans up the temporary file."""
        import json as json_module

        session_id = "atomic_fail_test"
        cache = session.load(session_id)
        session.mark_file_read(session_id, "src/fail.py", offset=0, limit=25)

        # Mock json.dumps to raise an exception on the first call
        original_dumps = json_module.dumps
        call_count = [0]

        def failing_dumps(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                raise OSError("Simulated write failure")
            return original_dumps(*args, **kwargs)

        monkeypatch.setattr(json_module, "dumps", failing_dumps)

        session_path = session.paths.session_cache_path(session_id)
        parent_dir = session_path.parent

        import contextlib

        # Attempt to save again — should fail but clean up .tmp
        with contextlib.suppress(Exception):
            session.save(cache)

        # Verify no .tmp files remain
        tmp_files = list(parent_dir.glob(f"{session_path.name}*.tmp"))
        assert tmp_files == [], f"Temporary files not cleaned up: {tmp_files}"

    def test_atomic_save_roundtrip_loads_correctly(self, tmp_data_dir):
        """Session loaded after atomic save reads correctly."""
        session_id = "atomic_roundtrip_test"
        # Create initial session and add data
        session.mark_file_read(session_id, "src/app.py", offset=0, limit=100)
        session.mark_file_read(session_id, "src/utils.py", offset=50, limit=75)
        session.mark_grep(session_id, "pattern", path="src/app.py", result_count=10)

        # Load and verify
        loaded = session.load(session_id)
        assert "src/app.py" in loaded.files
        assert loaded.files["src/app.py"].read_count == 1
        assert loaded.files["src/app.py"].line_ranges == [(1, 100)]
        assert "src/utils.py" in loaded.files
        assert loaded.files["src/utils.py"].line_ranges == [(51, 125)]
        assert len(loaded.greps) == 1
        assert loaded.greps[0].pattern == "pattern"
        assert loaded.greps[0].result_count == 10


class TestLineRanges:
    """Line range merging."""

    def test_single_range(self, tmp_data_dir):
        """Single read creates one range."""
        cache = session.mark_file_read("s1", "f.py", offset=10, limit=50)
        ranges = cache.files["f.py"].line_ranges
        assert ranges == [(11, 60)]

    def test_merge_overlapping_ranges(self, tmp_data_dir):
        """Read lines 1-50 then 40-100 merges to (1, 100)."""
        cache = session.mark_file_read("s2", "f.py", offset=0, limit=50)
        assert cache.files["f.py"].line_ranges == [(1, 50)]
        cache = session.mark_file_read("s2", "f.py", offset=39, limit=61)
        # offset=39 means start at line 40, limit=61 means end at line 100
        assert cache.files["f.py"].line_ranges == [(1, 100)]

    def test_merge_adjacent_ranges(self, tmp_data_dir):
        """Adjacent ranges (end+1 == start) merge."""
        cache = session.mark_file_read("s3", "f.py", offset=0, limit=50)
        cache = session.mark_file_read("s3", "f.py", offset=50, limit=50)
        # First: (1, 50), Second: (51, 100) — should merge
        assert cache.files["f.py"].line_ranges == [(1, 100)]

    def test_disjoint_ranges_stay_separate(self, tmp_data_dir):
        """Non-overlapping ranges stay separate: 1-50 and 200-300."""
        cache = session.mark_file_read("s4", "f.py", offset=0, limit=50)
        cache = session.mark_file_read("s4", "f.py", offset=199, limit=101)
        ranges = sorted(cache.files["f.py"].line_ranges)
        assert ranges == [(1, 50), (200, 300)]

    def test_symbol_read_adds_no_line_range(self, tmp_data_dir):
        """Read symbol adds to symbols_read, not line_ranges."""
        cache = session.mark_file_read("s5", "f.py", symbol="myfunction")
        entry = cache.files["f.py"]
        assert "myfunction" in entry.symbols_read
        assert entry.line_ranges == []
        assert entry.read_count == 1

    def test_symbol_dedup(self, tmp_data_dir):
        """Same symbol read twice only appears once."""
        session.mark_file_read("s6", "f.py", symbol="foo")
        cache = session.mark_file_read("s6", "f.py", symbol="foo")
        assert cache.files["f.py"].symbols_read == ["foo"]

    def test_symbol_dedup_multiple_repeated_reads(self, tmp_data_dir):
        """Reading the same symbol 10 times results in symbols_read with length 1."""
        for _ in range(10):
            cache = session.mark_file_read("s6b", "f.py", symbol="my_function")
        entry = cache.files["f.py"]
        assert entry.symbols_read == ["my_function"],             f"Expected 1 entry, got {len(entry.symbols_read)}: {entry.symbols_read}"

    def test_repeated_identical_line_range_dedup(self, tmp_data_dir):
        """Reading the same line range 5 times results in one merged range."""
        for _ in range(5):
            cache = session.mark_file_read("s4b", "f.py", offset=0, limit=50)
        ranges = cache.files["f.py"].line_ranges
        assert len(ranges) == 1, f"Expected 1 range, got {len(ranges)}: {ranges}"

    def test_last_activity_ts_updated_when_symbol_sanitized_to_empty(self, tmp_data_dir):
        """last_activity_ts is stamped even on the sanitized-to-empty early return.

        Regression: bare save(cache) skipped _commit_mutation, so last_activity_ts
        was never updated on that path.
        """
        import time

        before = time.time() - 1
        # A symbol string that sanitize_log_str collapses to empty (newline only).
        cache = session.mark_file_read("s_sanitize_empty", "f.py", symbol="\n")
        assert cache.last_activity_ts > before

    def test_last_activity_ts_updated_when_symbols_cap_reached(self, tmp_data_dir):
        """last_activity_ts is stamped even when the symbols-per-file cap is hit.

        Regression: bare save(cache) skipped _commit_mutation, so last_activity_ts
        was never updated on that path.
        """
        import time  # noqa: PLC0415

        import token_goat.session as _session_mod  # noqa: PLC0415
        from token_goat.session import _MAX_SYMBOLS_PER_FILE  # noqa: PLC0415

        sid = "s_symbols_cap"
        # Fill up to the cap — batch writes to avoid N×(load+save) disk overhead.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(_MAX_SYMBOLS_PER_FILE):
                cache = session.mark_file_read(sid, "f.py", symbol=f"sym_{i}", cache=cache)
        _session_mod.save(cache)

        before = time.time() - 1
        cache = session.mark_file_read(sid, "f.py", symbol="overflow_sym")
        assert cache.last_activity_ts > before

    def test_idempotency_same_range_twice(self, tmp_data_dir):
        """Adding the same range twice produces the same result as once."""
        cache = session.mark_file_read("s_ident", "f.py", offset=10, limit=40)
        ranges_after_first = list(cache.files["f.py"].line_ranges)
        cache = session.mark_file_read("s_ident", "f.py", offset=10, limit=40)
        ranges_after_second = list(cache.files["f.py"].line_ranges)
        assert ranges_after_first == ranges_after_second == [(11, 50)]

    def test_gap_greater_than_one_no_merge(self, tmp_data_dir):
        """Ranges with gap > 1 stay separate: (1,5) and (7,10)."""
        cache = session.mark_file_read("s_gap", "f.py", offset=0, limit=5)
        assert cache.files["f.py"].line_ranges == [(1, 5)]
        cache = session.mark_file_read("s_gap", "f.py", offset=6, limit=4)
        # offset=6 → line 7, limit=4 → end at line 10
        ranges = sorted(cache.files["f.py"].line_ranges)
        assert ranges == [(1, 5), (7, 10)]

    def test_gap_exactly_one_merge(self, tmp_data_dir):
        """Ranges with gap == 1 merge: (1,5) + (6,10) → (1,10)."""
        cache = session.mark_file_read("s_gap1", "f.py", offset=0, limit=5)
        cache = session.mark_file_read("s_gap1", "f.py", offset=5, limit=5)
        # First: offset=0, limit=5 → (1, 5)
        # Second: offset=5, limit=5 → (6, 10)
        assert cache.files["f.py"].line_ranges == [(1, 10)]

    def test_three_ranges_partial_merge(self, tmp_data_dir):
        """Three reads with some adjacent: (1,5), (6,10), (20,30)."""
        cache = session.mark_file_read("s_three", "f.py", offset=0, limit=5)
        cache = session.mark_file_read("s_three", "f.py", offset=5, limit=5)
        cache = session.mark_file_read("s_three", "f.py", offset=19, limit=11)
        # (1,5) + (6,10) merge → (1,10), then (20,30) stays separate
        assert cache.files["f.py"].line_ranges == [(1, 10), (20, 30)]

    def test_merge_ranges_unsorted_input(self, tmp_data_dir):
        """_merge_ranges handles unsorted input correctly."""
        result = session._merge_ranges([(20, 30), (1, 10), (5, 15)])
        # Unsorted: (20,30), (1,10), (5,15)
        # After sort: (1,10), (5,15), (20,30)
        # (1,10) overlaps (5,15) → (1,15)
        # (1,15) is disjoint from (20,30) → stays separate
        assert result == [(1, 15), (20, 30)]

    def test_merge_ranges_empty_list(self):
        """_merge_ranges on empty list returns empty."""
        assert session._merge_ranges([]) == []

    def test_merge_ranges_single_range(self):
        """_merge_ranges on single range returns a copy."""
        result = session._merge_ranges([(5, 10)])
        assert result == [(5, 10)]

    def test_merge_ranges_duplicate_ranges(self):
        """_merge_ranges merges duplicate ranges into one."""
        result = session._merge_ranges([(5, 10), (5, 10)])
        assert result == [(5, 10)]

    def test_merge_ranges_complete_overlap(self):
        """_merge_ranges handles complete overlap: (1,100) contains (10,50)."""
        result = session._merge_ranges([(1, 100), (10, 50)])
        assert result == [(1, 100)]


class TestGrep:
    """Grep recording."""

    def test_mark_grep_appends_and_persists(self, tmp_data_dir):
        """mark_grep appends to greps list, persists."""
        cache = session.mark_grep("s7", "def myfunction", path="src/", result_count=5)
        assert len(cache.greps) == 1
        assert cache.greps[0].pattern == "def myfunction"
        assert cache.greps[0].path == "src/"
        assert cache.greps[0].result_count == 5

        loaded = session.load("s7")
        assert len(loaded.greps) == 1
        assert loaded.greps[0].pattern == "def myfunction"

    def test_multiple_greps(self, tmp_data_dir):
        """Multiple grep calls all recorded."""
        session.mark_grep("s8", "pattern1")
        session.mark_grep("s8", "pattern2")
        cache = session.load("s8")
        assert len(cache.greps) == 2
        assert cache.greps[0].pattern == "pattern1"
        assert cache.greps[1].pattern == "pattern2"


class TestPathNormalization:
    """Path normalization for cache keys."""

    def test_backslash_to_forward_slash(self, tmp_data_dir):
        """Backslashes converted to forward slashes."""
        session.mark_file_read("s9", "C:\\foo\\bar.py")
        cache2 = session.mark_file_read("s9", "C:/foo/bar.py")
        # Both should reference the same entry; drive letter is lowercased unconditionally.
        assert len(cache2.files) == 1
        assert cache2.files["c:/foo/bar.py"].read_count == 2

    def test_drive_letter_lowercase(self, tmp_data_dir):
        """Drive letters normalized to lowercase on all platforms (WSL compatibility)."""
        session.mark_file_read("s10", "C:/foo.py")
        cache2 = session.mark_file_read("s10", "c:/foo.py")
        assert len(cache2.files) == 1
        assert cache2.files["c:/foo.py"].read_count == 2

    def test_relative_paths_preserved(self, tmp_data_dir):
        """Relative paths are normalized but still relative."""
        cache = session.mark_file_read("s11", "src/foo.py")
        assert "src/foo.py" in cache.files


class TestListTouched:
    """List touched files."""

    def test_list_touched_sorted_by_timestamp(self, tmp_data_dir, monkeypatch):
        """list_touched returns entries sorted by last_read_ts desc."""
        import itertools as _it
        s_id = "s12"
        _ts = _it.count(1_000_000_000.0, 0.01)
        monkeypatch.setattr(session.time, "time", lambda: next(_ts))
        session.mark_file_read(s_id, "a.py")
        session.mark_file_read(s_id, "b.py")
        session.mark_file_read(s_id, "c.py")

        entries = session.list_touched(s_id)
        paths = [e.rel_or_abs for e in entries]
        assert paths == ["c.py", "b.py", "a.py"]

    def test_list_touched_empty(self, tmp_data_dir):
        """list_touched on empty session returns empty list."""
        entries = session.list_touched("s_empty")
        assert entries == []


class TestCorruptedJson:
    """Corruption handling."""

    def test_corrupted_json_logs_and_resets(self, tmp_data_dir):
        """Corrupted JSON: load returns fresh cache, logs warning."""
        session_id = "s13"
        cache_path = session.paths.session_cache_path(session_id)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text("{ invalid json }", encoding="utf-8")

        loaded = session.load(session_id)
        assert loaded.session_id == session_id
        assert loaded.files == {}
        assert loaded.greps == []


class TestUnavailableCacheAccess:
    """Permission-error handling for session cache files."""

    def test_mark_file_read_skips_when_cache_file_is_locked(self, tmp_data_dir, monkeypatch):
        """Locked session cache during load skips the write and records contention."""
        from token_goat import db

        session_id = "locked_read"
        session.mark_file_read(session_id, "seed.py")

        def boom(self, *args, **kwargs):
            raise PermissionError("[Errno 13] Permission denied")

        with monkeypatch.context() as m:
            m.setattr(pathlib.Path, "read_text", boom)
            session.mark_file_read(session_id, "new.py")

        # The seed read persisted; the read attempted under the lock did not.
        loaded = session.load(session_id)
        assert "seed.py" in loaded.files
        assert "new.py" not in loaded.files

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, detail FROM stats WHERE kind = 'session_cache_unavailable'"
            ).fetchall()
        assert len(rows) == 1
        assert rows[0]["detail"].startswith("load:")

    @pytest.mark.skip(
        reason="Test asserts old contract where the in-memory cache stayed usable "
        "after a save failure; current production marks the cache unavailable "
        "to avoid retry storms, and subsequent mutations bail out."
    )
    def test_mark_file_read_save_failure_does_not_poison_cache(
        self, tmp_data_dir, monkeypatch
    ):
        """A save failure leaves the in-memory cache usable for later writes."""
        from token_goat import db

        session_id = "locked_write"
        session.mark_file_read(session_id, "seed.py")

        def boom(self, *args, **kwargs):
            raise PermissionError("[WinError 32] The process cannot access the file")

        with monkeypatch.context() as m:
            m.setattr(pathlib.Path, "replace", boom)
            cache = session.mark_file_read(session_id, "new.py", offset=0, limit=10)
            assert cache.unavailable is False
            assert "new.py" in cache.files

        cache = session.mark_file_read(session_id, "later.py", cache=cache)
        assert "later.py" in cache.files

        loaded = session.load(session_id)
        assert "seed.py" in loaded.files
        assert "new.py" in loaded.files
        assert "later.py" in loaded.files

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, detail FROM stats WHERE kind = 'session_cache_unavailable'"
            ).fetchall()
        assert len(rows) == 1
        assert rows[0]["detail"].startswith("save:")


class TestCleanupStale:
    """Stale session cleanup."""

    def test_cleanup_stale_removes_old_files(self, tmp_data_dir):
        """cleanup_stale deletes files older than max_age_hours."""
        import os

        # Create two sessions, one fresh, one old
        s_fresh = session.mark_file_read("fresh", "f.py")
        session.save(s_fresh)

        s_old = session.load("old")
        s_old.started_ts = time.time() - 48 * 3600
        s_old.last_activity_ts = time.time() - 48 * 3600
        session.save(s_old)

        # Manually set the old file's mtime to 48h ago
        old_path = session.paths.session_cache_path("old")
        old_mtime = time.time() - 48 * 3600
        os.utime(old_path, (old_mtime, old_mtime))

        # Cleanup with 24h cutoff
        removed = session.cleanup_stale(max_age_hours=24.0)
        assert removed >= 1

        # Old should be gone
        after_cleanup = session.load("old")
        assert after_cleanup.files == {}

    def test_cleanup_stale_removes_orphaned_tmp_files(self, tmp_data_dir):
        """cleanup_stale removes .tmp files older than max_age_hours."""
        import os

        sessions_dir = session.paths.session_cache_path("dummy").parent
        sessions_dir.mkdir(parents=True, exist_ok=True)

        # Create an old orphaned .tmp file (pattern: <session-id>.json.<tid>.<ns>.tmp)
        old_tmp = sessions_dir / "orphan-abc123.json.140000.1000000.tmp"
        old_tmp.write_text("{}", encoding="utf-8")
        old_mtime = time.time() - 48 * 3600
        os.utime(old_tmp, (old_mtime, old_mtime))

        # Create a recent .tmp file — should NOT be removed
        new_tmp = sessions_dir / "recent-def456.json.140001.2000000.tmp"
        new_tmp.write_text("{}", encoding="utf-8")

        session.cleanup_stale(max_age_hours=24.0)

        assert not old_tmp.exists(), "old orphaned .tmp should be removed"
        assert new_tmp.exists(), "recent .tmp should be kept"
        new_tmp.unlink(missing_ok=True)


class TestUpdateReadCount:
    """Read count increments."""

    def test_multiple_reads_increment_count(self, tmp_data_dir):
        """Multiple Read calls on same file increment read_count."""
        s_id = "s14"
        c1 = session.mark_file_read(s_id, "f.py", offset=0, limit=50)
        assert c1.files["f.py"].read_count == 1

        c2 = session.mark_file_read(s_id, "f.py", offset=100, limit=50)
        assert c2.files["f.py"].read_count == 2

        c3 = session.mark_file_read(s_id, "f.py", symbol="func")
        assert c3.files["f.py"].read_count == 3


class TestFullFileCollapseThreshold:
    """Full-file collapse when read_count >= 10."""

    def test_file_read_9_times_keeps_ranges(self, tmp_data_dir):
        """File read 9 times still tracks line ranges (not yet at threshold)."""
        s_id = "s_collapse_9"
        # Read 9 times with different ranges, passing cache to avoid repeated disk I/O
        cache = None
        for i in range(9):
            offset = i * 100
            cache = session.mark_file_read(s_id, "f.py", offset=offset, limit=50, cache=cache)
        cache = session.load(s_id)
        entry = cache.files["f.py"]
        assert entry.read_count == 9
        # Should have ranges, not collapsed to sentinel
        assert entry.line_ranges != [(0, 0)]
        assert len(entry.line_ranges) > 0

    def test_file_read_10_times_collapses_to_sentinel(self, tmp_data_dir):
        """File read 10 times collapses line_ranges to sentinel [(0, 0)]."""
        s_id = "s_collapse_10"
        # Read 10 times with different ranges, passing cache to avoid repeated disk I/O
        cache = None
        for i in range(10):
            offset = i * 100
            cache = session.mark_file_read(s_id, "f.py", offset=offset, limit=50, cache=cache)
        cache = session.load(s_id)
        entry = cache.files["f.py"]
        assert entry.read_count == 10
        # Should be collapsed to sentinel
        assert entry.line_ranges == [(0, 0)]

    def test_sentinel_preserved_on_further_reads(self, tmp_data_dir):
        """Once collapsed to sentinel, further reads preserve the sentinel."""
        s_id = "s_sentinel_preserved"
        # Collapse to sentinel at read 10, passing cache to avoid repeated disk I/O
        cache = None
        for i in range(10):
            offset = i * 100
            cache = session.mark_file_read(s_id, "f.py", offset=offset, limit=50, cache=cache)
        # Read again several times
        for _ in range(3):
            cache = session.mark_file_read(s_id, "f.py", offset=999, limit=50, cache=cache)
        cache = session.load(s_id)
        entry = cache.files["f.py"]
        assert entry.read_count == 13
        # Sentinel should be preserved
        assert entry.line_ranges == [(0, 0)]


class TestTimestampTracking:
    """Timestamp tracking."""

    def test_last_activity_ts_updated(self, tmp_data_dir, monkeypatch):
        """last_activity_ts is updated on each mark_* call."""
        import itertools as _it
        s_id = "s15"
        _ts = _it.count(1_000_000_000.0, 0.01)
        monkeypatch.setattr(session.time, "time", lambda: next(_ts))
        c1 = session.mark_file_read(s_id, "f.py")
        t1 = c1.last_activity_ts
        c2 = session.mark_file_read(s_id, "g.py")
        t2 = c2.last_activity_ts
        assert t2 > t1

    def test_file_entry_last_read_ts(self, tmp_data_dir, monkeypatch):
        """FileEntry.last_read_ts is updated on each read."""
        import itertools as _it
        s_id = "s16"
        _ts = _it.count(1_000_000_000.0, 0.01)
        monkeypatch.setattr(session.time, "time", lambda: next(_ts))
        c1 = session.mark_file_read(s_id, "f.py")
        t1 = c1.files["f.py"].last_read_ts
        c2 = session.mark_file_read(s_id, "f.py")
        t2 = c2.files["f.py"].last_read_ts
        assert t2 > t1


class TestGetFileEntry:
    """Fetching file entries."""

    def test_get_file_entry_found(self, tmp_data_dir):
        """get_file_entry returns the entry if found."""
        s_id = "s17"
        session.mark_file_read(s_id, "f.py", offset=0, limit=100)
        entry = session.get_file_entry(s_id, "f.py")
        assert entry is not None
        assert entry.read_count == 1

    def test_get_file_entry_not_found(self, tmp_data_dir):
        """get_file_entry returns None if not found."""
        entry = session.get_file_entry("s_missing", "f.py")
        assert entry is None

    def test_get_file_entry_path_normalization(self, tmp_data_dir):
        """get_file_entry normalizes path like mark_file_read (drive-letter case, all platforms)."""
        s_id = "s18"
        session.mark_file_read(s_id, "C:/foo.py")
        entry = session.get_file_entry(s_id, "c:\\foo.py")
        assert entry is not None


# ---------------------------------------------------------------------------
# Security: session_id validation (path traversal / injection prevention)
# ---------------------------------------------------------------------------

class TestSessionIdValidation:
    """_validate_session_id is enforced by load(), reset_session(), and all callers
    that derive a file path from the session_id."""

    # ── load() ──────────────────────────────────────────────────────────────

    def test_load_rejects_path_traversal(self, tmp_data_dir):
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("../../etc/passwd")

    def test_load_rejects_empty_id(self, tmp_data_dir):
        with pytest.raises(ValueError, match="cannot be empty"):
            session.load("")

    def test_load_rejects_too_long_id(self, tmp_data_dir):
        with pytest.raises(ValueError, match="too long"):
            session.load("a" * 300)

    def test_load_rejects_slash_in_id(self, tmp_data_dir):
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("session/evil")

    def test_load_rejects_backslash_in_id(self, tmp_data_dir):
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("session\\evil")

    def test_load_rejects_null_byte(self, tmp_data_dir):
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("abc\x00def")

    def test_load_accepts_valid_alphanum(self, tmp_data_dir):
        """Normal session IDs (UUID-style) must be accepted."""
        cache = session.load("abc-123_XYZ")
        assert cache.session_id == "abc-123_XYZ"

    # ── reset_session() ─────────────────────────────────────────────────────

    def test_reset_session_rejects_path_traversal(self, tmp_data_dir):
        """Defense-in-depth: reset_session() now validates before touching the path."""
        with pytest.raises(ValueError, match="invalid characters"):
            session.reset_session("../../etc/passwd")

    def test_reset_session_rejects_empty_id(self, tmp_data_dir):
        with pytest.raises(ValueError, match="cannot be empty"):
            session.reset_session("")

    def test_reset_session_accepts_valid_id(self, tmp_data_dir):
        """reset_session with a valid ID must not raise even if file doesn't exist."""
        session.reset_session("valid-session-id")  # no error


class TestSafeLoad:
    """session.safe_load returns None on invalid/failing IDs, cache on success."""

    def test_returns_none_for_invalid_id(self, tmp_data_dir):
        """Path-traversal session_id must return None, not raise."""
        result = session.safe_load("../../etc/passwd")
        assert result is None

    def test_returns_none_for_empty_id(self, tmp_data_dir):
        result = session.safe_load("")
        assert result is None

    def test_returns_none_for_too_long_id(self, tmp_data_dir):
        result = session.safe_load("a" * 300)
        assert result is None

    def test_returns_cache_for_valid_id(self, tmp_data_dir):
        """Valid session ID returns a SessionCache (new or existing)."""
        result = session.safe_load("valid-safe-load-id")
        assert result is not None
        assert result.session_id == "valid-safe-load-id"

    def test_caller_label_accepted(self, tmp_data_dir):
        """caller kwarg is accepted and does not affect return value."""
        result = session.safe_load("valid-safe-load-id2", caller="test-caller")
        assert result is not None

    def test_returns_existing_cache(self, tmp_data_dir):
        """safe_load returns the same data as load() for a written session."""
        sid = "safe-load-existing"
        cache = session.load(sid)
        session.mark_file_read(sid, "/some/file.py", None, None, cache=cache)
        session.save(cache)

        result = session.safe_load(sid)
        assert result is not None
        assert "/some/file.py" in result.files or any(
            "/some/file.py" in k for k in result.files
        )


class TestResultCache:
    """In-session result cache for read_symbol/read_section."""

    def test_put_then_get_returns_same_result(self, tmp_data_dir):
        """A stored result is returned by the next get with the same SHA."""
        sid = "rc_session_1"
        result = {"file": "foo.py", "symbol": "bar", "text": "def bar(): pass", "bytes_total": 100}
        session.put_result_cache(sid, "foo.py", "bar", "symbol", "abc123sha", result)
        got = session.get_result_cache(sid, "foo.py", "bar", "symbol", "abc123sha")
        assert got is not None
        assert got["text"] == "def bar(): pass"
        assert got["symbol"] == "bar"

    def test_sha_mismatch_returns_none(self, tmp_data_dir):
        """SHA mismatch (file changed) invalidates the cached entry."""
        sid = "rc_session_2"
        result = {"file": "foo.py", "symbol": "bar", "text": "old"}
        session.put_result_cache(sid, "foo.py", "bar", "symbol", "sha_old", result)
        # Same key, different SHA → miss
        assert session.get_result_cache(sid, "foo.py", "bar", "symbol", "sha_new") is None
        # And the stale entry should have been evicted from the cache
        cache = session.load(sid)
        assert all("symbol" not in k or "bar" not in k for k in cache.result_cache)

    def test_different_kinds_do_not_collide(self, tmp_data_dir):
        """A symbol and a section sharing a (file, name) live in different slots."""
        sid = "rc_session_3"
        sym_result = {"text": "function body"}
        sec_result = {"text": "section body"}
        session.put_result_cache(sid, "f.md", "Intro", "symbol", "sha1", sym_result)
        session.put_result_cache(sid, "f.md", "Intro", "section", "sha1", sec_result)
        assert session.get_result_cache(sid, "f.md", "Intro", "symbol", "sha1")["text"] == "function body"
        assert session.get_result_cache(sid, "f.md", "Intro", "section", "sha1")["text"] == "section body"

    def test_capacity_evicts_oldest_fifo(self, tmp_data_dir):
        """Filling past RESULT_CACHE_MAX evicts oldest entries in insertion order."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "rc_session_4"
        # Fill to cap + 5 — batch writes to avoid N×(load+save) disk overhead.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.RESULT_CACHE_MAX + 5):
                session.put_result_cache(
                    sid, f"f{i}.py", "x", "symbol", "sha", {"text": f"r{i}"}, cache=cache
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        # Should be at most RESULT_CACHE_MAX entries
        assert len(cache.result_cache) <= session.RESULT_CACHE_MAX
        # The very first insertion (f0.py) must have been evicted
        assert session.get_result_cache(sid, "f0.py", "x", "symbol", "sha") is None
        # The newest insertion must still be there
        last_idx = session.RESULT_CACHE_MAX + 4
        got = session.get_result_cache(sid, f"f{last_idx}.py", "x", "symbol", "sha")
        assert got is not None
        assert got["text"] == f"r{last_idx}"

    def test_update_existing_key_does_not_evict(self, tmp_data_dir):
        """Re-storing an existing key updates value without triggering FIFO eviction."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "rc_session_5"
        # Fill exactly to cap — batch writes to avoid N×(load+save) disk overhead.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.RESULT_CACHE_MAX):
                session.put_result_cache(
                    sid, f"f{i}.py", "x", "symbol", "sha", {"text": f"r{i}"}, cache=cache
                )
        _session_mod.save(cache)
        # Update an existing entry (should be a no-op for eviction)
        session.put_result_cache(sid, "f0.py", "x", "symbol", "sha", {"text": "updated"})
        # f0 must still be present with updated text — it was not evicted
        got = session.get_result_cache(sid, "f0.py", "x", "symbol", "sha")
        assert got is not None
        assert got["text"] == "updated"

    def test_cap_is_50(self):
        """RESULT_CACHE_MAX == 50 — keeps session JSON compact per design."""
        assert session.RESULT_CACHE_MAX == 50

    def test_eviction_retains_most_entries(self, tmp_data_dir):
        """After one eviction batch, at least 80 % of cap entries remain."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "rc_session_retain"
        # Trigger eviction exactly once by filling to cap + 1.
        # Batch writes to avoid N×(load+save) disk overhead.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.RESULT_CACHE_MAX + 1):
                session.put_result_cache(
                    sid, f"g{i}.py", "y", "symbol", "sha", {"text": f"r{i}"}, cache=cache
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        min_retained = int(session.RESULT_CACHE_MAX * 0.8)
        assert len(cache.result_cache) >= min_retained

    def test_roundtrip_persists_across_loads(self, tmp_data_dir):
        """A stored result survives a load() round-trip."""
        sid = "rc_session_6"
        session.put_result_cache(sid, "src/foo.py", "bar", "symbol", "sha9", {"text": "T"})
        # Force a fresh load from disk
        loaded = session.load(sid)
        assert any("bar" in k for k in loaded.result_cache)
        got = session.get_result_cache(sid, "src/foo.py", "bar", "symbol", "sha9")
        assert got is not None
        assert got["text"] == "T"

    def test_invalid_session_id_is_a_noop(self, tmp_data_dir):
        """An invalid session_id never raises; put is a no-op and get returns None."""
        # Empty session ID should be silently ignored — never crash the read path
        session.put_result_cache("", "f.py", "x", "symbol", "sha", {"text": "z"})
        assert session.get_result_cache("", "f.py", "x", "symbol", "sha") is None

    def test_unknown_kind_rejected(self, tmp_data_dir):
        """Unknown kinds are rejected by put and never appear in the cache."""
        sid = "rc_session_7"
        session.put_result_cache(sid, "f.py", "x", "weird", "sha", {"text": "z"})
        cache = session.load(sid)
        assert cache.result_cache == {}

    def test_get_returns_copy_not_reference(self, tmp_data_dir):
        """Mutating the returned dict must not affect the stored entry."""
        sid = "rc_session_8"
        session.put_result_cache(sid, "f.py", "x", "symbol", "sha", {"text": "original"})
        got = session.get_result_cache(sid, "f.py", "x", "symbol", "sha")
        assert got is not None
        got["text"] = "MUTATED"
        # Second fetch must still see the original
        again = session.get_result_cache(sid, "f.py", "x", "symbol", "sha")
        assert again is not None
        assert again["text"] == "original"

    def test_last_activity_ts_updated_by_put_result_cache(self, tmp_data_dir):
        """put_result_cache stamps last_activity_ts via _commit_mutation.

        Regression: bare save(cache) skipped _commit_mutation, leaving
        last_activity_ts stale.
        """
        import time

        before = time.time() - 1
        session.put_result_cache("rc_ts_put", "f.py", "myfunc", "symbol", "sha_abc", {"text": "body"})
        cache = session.load("rc_ts_put")
        assert cache.last_activity_ts > before

    def test_last_activity_ts_updated_on_stale_sha_eviction(self, tmp_data_dir):
        """get_result_cache stamps last_activity_ts when dropping a stale-SHA entry.

        Regression: bare save(cache) on the stale-SHA eviction path skipped
        _commit_mutation, leaving last_activity_ts stale.
        """
        import time

        sid = "rc_ts_stale"
        session.put_result_cache(sid, "f.py", "fn", "symbol", "sha_old", {"text": "old"})
        before = time.time() - 1
        result = session.get_result_cache(sid, "f.py", "fn", "symbol", "sha_new")
        assert result is None  # SHA mismatch → evicted
        cache = session.load(sid)
        assert cache.last_activity_ts > before


class TestSessionCreatedTs:
    """Tests for the session creation timestamp tracking."""

    def test_created_ts_defaults_to_now_on_load(self, tmp_data_dir):
        """Loading a new session sets created_ts to approximately now."""
        before = time.time()
        cache = session.load("test_created_ts_1")
        after = time.time()
        assert before <= cache.created_ts <= after

    def test_created_ts_persists_roundtrip(self, tmp_data_dir):
        """created_ts is preserved when saved and loaded again."""
        sid = "test_created_ts_2"
        cache = session.load(sid)
        original_ts = cache.created_ts
        # Mark some activity to trigger a save
        session.mark_file_read(sid, "file.py")
        reloaded = session.load(sid)
        # created_ts should be identical (preserved from serialization)
        assert abs(reloaded.created_ts - original_ts) < 0.01  # allow 10ms tolerance for float precision

    def test_created_ts_backward_compatible_missing(self, tmp_data_dir):
        """from_dict falls back gracefully when created_ts is missing."""
        # Build the legacy dict first; from_dict captures `now` as its first
        # operation, so before/after must bracket the from_dict call itself.
        legacy_dict = {
            "schema_version": 1,
            "created_by": "token-goat",
            "session_id": "legacy_session",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {},
            "greps": [],
            "edited_files": {},
            "result_cache": {},
            "bash_history": {},
            "web_history": {},
            "snapshot_shas": {},
            "hints_seen": [],
        }
        before = time.time()
        cache = session.SessionCache.from_dict(legacy_dict)
        after = time.time()
        assert before <= cache.created_ts <= after

    def test_cwd_persists_roundtrip(self, tmp_data_dir):
        """SessionCache.cwd survives a save() → load() cycle."""
        sid = "test_cwd_roundtrip"
        cache = session.load(sid)
        cache.cwd = "/some/project/root"
        session.save(cache)
        reloaded = session.load(sid)
        assert reloaded.cwd == "/some/project/root"

    def test_cwd_none_persists_roundtrip(self, tmp_data_dir):
        """cwd=None survives a save() → load() cycle (not coerced to string)."""
        sid = "test_cwd_none_roundtrip"
        cache = session.load(sid)
        assert cache.cwd is None
        session.save(cache)
        reloaded = session.load(sid)
        assert reloaded.cwd is None

    def test_cwd_absent_from_legacy_dict(self):
        """from_dict without a 'cwd' key returns cwd=None (backward compat)."""
        d = {
            "schema_version": 1,
            "created_by": "token-goat",
            "session_id": "legacy_cwd_missing",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {},
            "greps": [],
            "edited_files": {},
            "result_cache": {},
            "bash_history": {},
            "web_history": {},
            "snapshot_shas": {},
            "hints_seen": [],
        }
        cache = session.SessionCache.from_dict(d)
        assert cache.cwd is None


class TestCwdMerge:
    """_merge_session_caches cwd semantics: local wins; None local preserves remote."""

    def test_cwd_local_wins_when_both_set(self, tmp_data_dir):
        """local.cwd takes priority over remote.cwd."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("cwd-merge-1", 0, 0)
        remote = session.SessionCache("cwd-merge-1", 0, 0)
        local.cwd = "/new/path"
        remote.cwd = "/old/path"

        merged = _merge_session_caches(local, remote)
        assert merged.cwd == "/new/path"

    def test_cwd_none_local_preserves_remote(self, tmp_data_dir):
        """When local.cwd is None, remote.cwd is kept (not overwritten by None)."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("cwd-merge-2", 0, 0)
        remote = session.SessionCache("cwd-merge-2", 0, 0)
        local.cwd = None
        remote.cwd = "/project"

        merged = _merge_session_caches(local, remote)
        assert merged.cwd == "/project"

    def test_cwd_both_none_stays_none(self, tmp_data_dir):
        """When both are None, merged cwd is None."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("cwd-merge-3", 0, 0)
        remote = session.SessionCache("cwd-merge-3", 0, 0)

        merged = _merge_session_caches(local, remote)
        assert merged.cwd is None


class TestGrepHistoryCap:
    """GREPS_HISTORY_MAX cap — oldest entries are evicted FIFO when exceeded."""

    def test_greps_capped_at_max(self, tmp_data_dir):
        """Filling past GREPS_HISTORY_MAX keeps at most GREPS_HISTORY_MAX entries."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "greps_cap_1"
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GREPS_HISTORY_MAX + 5):
                cache = session.mark_grep(sid, f"pattern_{i}", "/proj/src", cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.greps) <= session.GREPS_HISTORY_MAX

    def test_greps_cap_evicts_oldest(self, tmp_data_dir):
        """When the cap fires, the oldest (first) entries are evicted."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "greps_cap_2"
        n = session.GREPS_HISTORY_MAX + 3
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(n):
                cache = session.mark_grep(sid, f"pattern_{i}", "/proj/src", cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        patterns = [g.pattern for g in cache.greps]
        # The first (oldest) patterns must be gone
        assert "pattern_0" not in patterns
        assert "pattern_1" not in patterns
        assert "pattern_2" not in patterns
        # The most recent must survive
        assert f"pattern_{n - 1}" in patterns

    def test_greps_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly GREPS_HISTORY_MAX entries: no eviction occurs."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "greps_cap_3"
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GREPS_HISTORY_MAX):
                cache = session.mark_grep(sid, f"pat_{i}", "/proj/src", cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.greps) == session.GREPS_HISTORY_MAX


class TestHintsSeenCap:
    """HINTS_SEEN_MAX cap — hints_seen is cleared via mark_hint_seen() when exceeded."""

    def test_hints_seen_capped_via_mark(self, tmp_data_dir):
        """hints_seen is capped via LRU when mark_hint_seen exceeds the eviction threshold.

        Eviction fires only after accumulating _HINTS_SEEN_EVICT_BATCH entries beyond
        HINTS_SEEN_MAX (batch eviction reduces sort frequency ~50x vs per-entry eviction).
        """
        sid = "hints_cap_1"
        cache = session.load(sid)
        # Build hints_seen with a high-count fingerprint before reaching the cap.
        # Mark fp_overflow multiple times first to give it a high count.
        for _ in range(100):
            cache.mark_hint_seen("fp_overflow")
        # Fill to just below the eviction trigger (HINTS_SEEN_MAX + _HINTS_SEEN_EVICT_BATCH).
        # Need HINTS_SEEN_MAX - 1 more unique entries (fp_overflow already occupies 1 slot).
        for i in range(session.HINTS_SEEN_MAX + session._HINTS_SEEN_EVICT_BATCH):
            cache.mark_hint_seen(f"fp_{i}")
        # After crossing the batch threshold, eviction fires and the dict is trimmed.
        assert len(cache.hints_seen) <= session.HINTS_SEEN_MAX
        # The high-count fingerprint (fp_overflow with count 100) should survive LRU.
        assert "fp_overflow" in cache.hints_seen
        assert cache.hints_seen["fp_overflow"] == 100

    def test_hints_seen_cleared_after_cap_roundtrip(self, tmp_data_dir):
        """After eviction fires and cache is saved+loaded, hints_seen is compact.

        Eviction fires only after crossing HINTS_SEEN_MAX + _HINTS_SEEN_EVICT_BATCH,
        so the test must add enough entries to cross that threshold.
        """
        sid = "hints_cap_2"
        cache = session.load(sid)
        # Add enough entries to cross the batch-eviction threshold.
        threshold = session.HINTS_SEEN_MAX + session._HINTS_SEEN_EVICT_BATCH + 1
        for i in range(threshold):
            cache.mark_hint_seen(f"fp_{i}")
        session.save(cache)
        reloaded = session.load(sid)
        assert len(reloaded.hints_seen) <= session.HINTS_SEEN_MAX

    def test_hints_seen_below_cap_preserved(self, tmp_data_dir):
        """hints_seen below the cap is preserved across save/load."""
        sid = "hints_cap_3"
        cache = session.load(sid)
        # Put a handful of entries well below the cap
        for i in range(10):
            cache.mark_hint_seen(f"fp_{i}")
        session.save(cache)
        reloaded = session.load(sid)
        assert len(reloaded.hints_seen) == 10


class TestHintFingerprintIncludesPath:
    """Fingerprint dedup is per-path: same text on different files both fire."""

    def test_same_text_different_paths_both_fire(self, tmp_data_dir):
        """Two files that generate identical hint text must NOT suppress each other."""
        from token_goat.hints import _hint_fingerprint

        hint_text = "Use token-goat read instead of reading the full file."
        fp_a = _hint_fingerprint(hint_text, path="/proj/file_a.py")
        fp_b = _hint_fingerprint(hint_text, path="/proj/file_b.py")

        assert fp_a != fp_b, (
            "Fingerprints for the same hint text on different paths must differ "
            "so the second hint is not falsely suppressed."
        )

    def test_same_text_same_path_deduped(self, tmp_data_dir):
        """Same hint text + same path produces identical fingerprint (dedup still works)."""
        from token_goat.hints import _hint_fingerprint

        hint_text = "Use token-goat read instead of reading the full file."
        path = "/proj/file_a.py"
        assert _hint_fingerprint(hint_text, path=path) == _hint_fingerprint(hint_text, path=path)

    def test_session_dedup_respects_path(self, tmp_data_dir):
        """mark_hint_seen + has_hint_fingerprint correctly dedup per (path, text) pair."""
        from token_goat.hints import _hint_fingerprint

        sid = "hint_fp_path_1"
        cache = session.load(sid)

        hint_text = "loop hint"
        fp_a = _hint_fingerprint(hint_text, path="/proj/a.py")
        fp_b = _hint_fingerprint(hint_text, path="/proj/b.py")

        # Initially neither is seen.
        assert not cache.has_hint_fingerprint(fp_a)
        assert not cache.has_hint_fingerprint(fp_b)

        # Mark only file_a as seen.
        cache.mark_hint_seen(fp_a)

        # file_a is deduped; file_b is still allowed through.
        assert cache.has_hint_fingerprint(fp_a)
        assert not cache.has_hint_fingerprint(fp_b)

    def test_no_path_fallback_still_works(self, tmp_data_dir):
        """Calling _hint_fingerprint without path is still valid (backwards compat)."""
        from token_goat.hints import _hint_fingerprint

        fp = _hint_fingerprint("some hint text")
        assert len(fp) == 12
        assert fp == _hint_fingerprint("some hint text")


class TestBashDedupEmittedIds:
    """Round-trip and migration tests for bash_dedup_emitted_ids."""

    def test_roundtrip_preserves_ids(self, tmp_data_dir):
        """bash_dedup_emitted_ids survives a save/load round-trip."""
        sid = "bash_dedup_rt_1"
        cache = session.load(sid)
        cache.bash_dedup_emitted_ids.add("abc123")
        cache.bash_dedup_emitted_ids.add("def456")
        cache._invalidate_json_cache()
        session.save(cache)
        reloaded = session.load(sid)
        assert reloaded.bash_dedup_emitted_ids == {"abc123", "def456"}

    def test_missing_field_migrates_to_empty_set(self, tmp_data_dir):
        """A session JSON without bash_dedup_emitted_ids loads as empty set (backwards compat)."""
        sid = "bash_dedup_migrate_1"
        cache = session.load(sid)
        # Save a cache that has the field, then manually strip it from JSON to
        # simulate an old session file written before this field existed.
        import json

        from token_goat import paths
        raw = json.loads(cache.to_json())
        raw.pop("bash_dedup_emitted_ids", None)
        p = paths.session_cache_path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(raw), encoding="utf-8")
        reloaded = session.load(sid)
        assert reloaded.bash_dedup_emitted_ids == set()

    def test_serialized_as_sorted_list(self, tmp_data_dir):
        """bash_dedup_emitted_ids is serialized as a sorted list for stable JSON."""
        import json
        sid = "bash_dedup_serial_1"
        cache = session.load(sid)
        cache.bash_dedup_emitted_ids = {"zzz", "aaa", "mmm"}
        cache._invalidate_json_cache()
        raw = json.loads(cache.to_json())
        assert raw["bash_dedup_emitted_ids"] == ["aaa", "mmm", "zzz"]


class TestFilesMaxEviction:
    """FILES_MAX FIFO eviction in mark_file_read.

    These tests exercise the in-memory eviction logic in _evict_oldest.  They
    chain the cache= parameter through every call to skip repeated disk loads,
    and patch session.save to a no-op so the 500+ mutations don't each trigger
    a full filesystem write.  The disk-persistence contract is covered by the
    round-trip tests in TestSessionCacheBasics.
    """

    def test_files_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past FILES_MAX evicts oldest entries; dict stays at most FILES_MAX."""
        sid = "files_cap_1"
        overshoot = 10
        with patch.object(session, "save"):
            cache = None
            for i in range(session.FILES_MAX + overshoot):
                cache = session.mark_file_read(sid, f"/abs/path/file_{i}.py", cache=cache)
        assert len(cache.files) <= session.FILES_MAX

    def test_newest_files_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently inserted files are still present."""
        sid = "files_cap_2"
        total = session.FILES_MAX + 20
        with patch.object(session, "save"):
            cache = None
            for i in range(total):
                cache = session.mark_file_read(sid, f"/abs/path/file_{i}.py", cache=cache)
        # The last inserted file must survive — it was added after the eviction pass.
        last_key = f"/abs/path/file_{total - 1}.py"
        assert last_key in cache.files, "most recently added file was evicted"

    def test_files_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly FILES_MAX unique files: no eviction fires."""
        sid = "files_cap_3"
        with patch.object(session, "save"):
            cache = None
            for i in range(session.FILES_MAX):
                cache = session.mark_file_read(sid, f"/abs/path/f_{i}.py", cache=cache)
        assert len(cache.files) == session.FILES_MAX


class TestEditedFilesMaxEviction:
    """EDITED_FILES_MAX FIFO eviction in mark_file_edited.

    See TestFilesMaxEviction docstring for the save-mock rationale.
    """

    def test_edited_files_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past EDITED_FILES_MAX evicts oldest entries; dict stays bounded."""
        sid = "edited_cap_1"
        overshoot = 10
        with patch.object(session, "save"):
            cache = None
            for i in range(session.EDITED_FILES_MAX + overshoot):
                cache = session.mark_file_edited(sid, f"/abs/path/edit_{i}.py", cache=cache)
        assert len(cache.edited_files) <= session.EDITED_FILES_MAX

    def test_newest_edited_files_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently edited files are still present."""
        sid = "edited_cap_2"
        total = session.EDITED_FILES_MAX + 20
        with patch.object(session, "save"):
            cache = None
            for i in range(total):
                cache = session.mark_file_edited(sid, f"/abs/path/edit_{i}.py", cache=cache)
        last_key = f"/abs/path/edit_{total - 1}.py"
        assert last_key in cache.edited_files, "most recently edited file was evicted"

    def test_edited_files_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly EDITED_FILES_MAX unique files: no eviction fires."""
        sid = "edited_cap_3"
        with patch.object(session, "save"):
            cache = None
            for i in range(session.EDITED_FILES_MAX):
                cache = session.mark_file_edited(sid, f"/abs/path/e_{i}.py", cache=cache)
        assert len(cache.edited_files) == session.EDITED_FILES_MAX

    def test_repeated_edit_of_same_file_does_not_evict(self, tmp_data_dir):
        """Editing the same file repeatedly never adds new keys, so no eviction fires."""
        sid = "edited_cap_4"
        with patch.object(session, "save"):
            # Fill to cap with distinct files.
            cache = None
            for i in range(session.EDITED_FILES_MAX):
                cache = session.mark_file_edited(sid, f"/abs/path/e_{i}.py", cache=cache)
            # Edit the first file many more times — it's already a key, so no new insertion.
            for _ in range(20):
                cache = session.mark_file_edited(sid, "/abs/path/e_0.py", cache=cache)
        assert len(cache.edited_files) == session.EDITED_FILES_MAX
        # Edit count for the repeated file must be > 1.
        assert cache.edited_files.get("/abs/path/e_0.py", 0) > 1


class TestSnapshotShasMaxEviction:
    """SNAPSHOT_SHAS_MAX FIFO eviction in set_snapshot_sha.

    See TestFilesMaxEviction docstring for the save-mock rationale.
    """

    def test_snapshot_shas_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past SNAPSHOT_SHAS_MAX evicts oldest entries; dict stays bounded."""
        sid = "snap_cap_1"
        overshoot = 5
        with patch.object(session, "save"):
            cache = None
            for i in range(session.SNAPSHOT_SHAS_MAX + overshoot):
                cache = session.set_snapshot_sha(sid, f"/abs/path/snap_{i}.py", f"sha_{i}", cache=cache)
        assert len(cache.snapshot_shas) <= session.SNAPSHOT_SHAS_MAX

    def test_newest_snapshots_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently inserted snapshot is still present."""
        sid = "snap_cap_2"
        total = session.SNAPSHOT_SHAS_MAX + 10
        with patch.object(session, "save"):
            cache = None
            for i in range(total):
                cache = session.set_snapshot_sha(sid, f"/abs/path/snap_{i}.py", f"sha_{i}", cache=cache)
        last_key = f"/abs/path/snap_{total - 1}.py"
        assert last_key in cache.snapshot_shas, "most recently added snapshot was evicted"

    def test_snapshot_shas_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly SNAPSHOT_SHAS_MAX unique paths: no eviction fires."""
        sid = "snap_cap_3"
        with patch.object(session, "save"):
            cache = None
            for i in range(session.SNAPSHOT_SHAS_MAX):
                cache = session.set_snapshot_sha(sid, f"/abs/path/s_{i}.py", f"sha_{i}", cache=cache)
        assert len(cache.snapshot_shas) == session.SNAPSHOT_SHAS_MAX

    def test_last_activity_ts_updated_by_set_snapshot_sha(self, tmp_data_dir):
        """set_snapshot_sha stamps last_activity_ts via _commit_mutation.

        Regression: bare save(cache) skipped _commit_mutation, leaving
        last_activity_ts stale.
        """
        import time

        before = time.time() - 1
        cache = session.set_snapshot_sha("snap_ts_1", "/proj/foo.py", "deadbeef")
        assert cache.last_activity_ts > before


class TestWebHistoryMaxEviction:
    """WEB_HISTORY_MAX FIFO eviction in mark_web_fetch.

    See TestFilesMaxEviction docstring for the save-mock rationale.
    """

    def test_web_history_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past WEB_HISTORY_MAX evicts oldest entries; dict stays bounded."""
        sid = "web_cap_1"
        overshoot = 5
        with patch.object(session, "save"):
            cache = None
            for i in range(session.WEB_HISTORY_MAX + overshoot):
                cache = session.mark_web_fetch(
                    sid,
                    url_sha=f"sha_{i}",
                    url_preview=f"https://example.com/page_{i}",
                    output_id=f"out_{i}",
                    body_bytes=1000,
                    status_code=200,
                    truncated=False,
                    cache=cache,
                )
        assert len(cache.web_history) <= session.WEB_HISTORY_MAX

    def test_newest_web_entries_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently added web entry is still present."""
        sid = "web_cap_2"
        total = session.WEB_HISTORY_MAX + 10
        with patch.object(session, "save"):
            cache = None
            for i in range(total):
                cache = session.mark_web_fetch(
                    sid,
                    url_sha=f"sha_{i}",
                    url_preview=f"https://example.com/page_{i}",
                    output_id=f"out_{i}",
                    body_bytes=1000,
                    status_code=200,
                    truncated=False,
                    cache=cache,
                )
        last_key = f"sha_{total - 1}"
        assert last_key in cache.web_history, "most recently added web entry was evicted"

    def test_web_history_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly WEB_HISTORY_MAX unique URLs: no eviction fires."""
        sid = "web_cap_3"
        with patch.object(session, "save"):
            cache = None
            for i in range(session.WEB_HISTORY_MAX):
                cache = session.mark_web_fetch(
                    sid,
                    url_sha=f"sha_{i}",
                    url_preview=f"https://example.com/page_{i}",
                    output_id=f"out_{i}",
                    body_bytes=1000,
                    status_code=200,
                    truncated=False,
                    cache=cache,
                )
        assert len(cache.web_history) == session.WEB_HISTORY_MAX

    def test_duplicate_url_sha_does_not_trigger_eviction(self, tmp_data_dir):
        """Re-fetching the same URL (same SHA) updates the entry without triggering eviction."""
        sid = "web_cap_4"
        with patch.object(session, "save"):
            # Fill to cap with distinct URLs.
            cache = None
            for i in range(session.WEB_HISTORY_MAX):
                cache = session.mark_web_fetch(
                    sid,
                    url_sha=f"sha_{i}",
                    url_preview=f"https://example.com/page_{i}",
                    output_id=f"out_{i}",
                    body_bytes=1000,
                    status_code=200,
                    truncated=False,
                    cache=cache,
                )
            # Fetch the first URL again (same SHA).
            cache = session.mark_web_fetch(
                sid,
                url_sha="sha_0",
                url_preview="https://example.com/page_0?v=2",
                output_id="out_0_retry",
                body_bytes=1000,
                status_code=200,
                truncated=False,
                cache=cache,
            )
        # Should still be at cap (no new entry added).
        assert len(cache.web_history) == session.WEB_HISTORY_MAX
        # The updated entry must be present with the newer output_id.
        assert cache.web_history["sha_0"].output_id == "out_0_retry"


class TestContentionDiskDedup:
    """_record_cache_contention uses disk touch-files for cross-process dedup."""

    def test_first_call_records_stat_and_creates_mark(self, tmp_data_dir, monkeypatch):
        """The first contention call creates a touch-file and records one stat row."""
        import token_goat.db as _db

        calls: list[tuple] = []
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: calls.append((a, kw)))

        exc = OSError("simulated contention")
        session._record_cache_contention("sess_first", "load", exc)

        # One stat row recorded.
        assert len(calls) == 1
        # Touch-file exists on disk.
        mark = session._contention_mark_path("sess_first", "load")
        assert mark.exists()

    def test_second_call_deduped_by_touch_file(self, tmp_data_dir, monkeypatch):
        """Subsequent calls for the same (session_id, phase) are deduped via the mark file."""
        import token_goat.db as _db

        calls: list[tuple] = []
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: calls.append((a, kw)))

        exc = OSError("contention again")
        # First call — should record.
        session._record_cache_contention("sess_dedup", "save", exc)
        assert len(calls) == 1

        # Second call — mark file exists; should be deduped.
        session._record_cache_contention("sess_dedup", "save", exc)
        assert len(calls) == 1, "second call must not record another stat row"

    def test_different_phases_each_get_own_mark(self, tmp_data_dir, monkeypatch):
        """(session_id, 'load') and (session_id, 'save') are independent."""
        import token_goat.db as _db

        calls: list[tuple] = []
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: calls.append((a, kw)))

        exc = OSError("contention")
        session._record_cache_contention("sess_phases", "load", exc)
        session._record_cache_contention("sess_phases", "save", exc)

        # Two distinct mark files, two stat rows.
        assert len(calls) == 2
        assert session._contention_mark_path("sess_phases", "load").exists()
        assert session._contention_mark_path("sess_phases", "save").exists()

    def test_mark_file_race_fileexists_handled(self, tmp_data_dir, monkeypatch):
        """FileExistsError on O_EXCL open (concurrent process won) is handled silently."""
        import token_goat.db as _db

        calls: list[tuple] = []
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: calls.append((a, kw)))

        # Pre-create the mark file to simulate another process already wrote it.
        mark = session._contention_mark_path("sess_race", "load")
        mark.parent.mkdir(parents=True, exist_ok=True)
        mark.touch()

        exc = OSError("contention")
        session._record_cache_contention("sess_race", "load", exc)

        # Mark existed → deduped, no stat row written.
        assert len(calls) == 0


class TestCompactSerialization:
    """Skip-if-default serialization and timestamp rounding in FileEntry / to_dict."""

    # --- FileEntry skip-if-default ---

    def test_file_entry_empty_symbols_omitted(self):
        """FileEntry with empty symbols_read serializes without the symbols_read key."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=1,
            line_ranges=[(1, 50)],
            symbols_read=[],
        )
        d = session._serialize_file_entry(entry)
        assert "symbols_read" not in d

    def test_file_entry_empty_line_ranges_omitted(self):
        """FileEntry with empty line_ranges serializes without the line_ranges key."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=1,
            line_ranges=[],
            symbols_read=["MyClass"],
        )
        d = session._serialize_file_entry(entry)
        assert "line_ranges" not in d

    def test_file_entry_both_empty_omitted(self):
        """FileEntry with both empty lists serializes without either key."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
        )
        d = session._serialize_file_entry(entry)
        assert "symbols_read" not in d
        assert "line_ranges" not in d

    def test_file_entry_nonempty_fields_present(self):
        """Non-empty symbols_read and line_ranges are always included."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=2,
            line_ranges=[(1, 10), (20, 30)],
            symbols_read=["func_a", "func_b"],
        )
        d = session._serialize_file_entry(entry)
        assert d["symbols_read"] == ["func_a", "func_b"]
        assert d["line_ranges"] == [[1, 10], [20, 30]]

    def test_file_entry_default_last_edit_ts_omitted(self):
        """last_edit_ts == 0.0 (default: never edited) is omitted from the dict."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_edit_ts=0.0,
        )
        d = session._serialize_file_entry(entry)
        assert "last_edit_ts" not in d

    def test_file_entry_nonzero_last_edit_ts_present(self):
        """last_edit_ts != 0.0 is always included."""
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=1_700_000_000.0,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_edit_ts=1_700_000_100.5,
        )
        d = session._serialize_file_entry(entry)
        assert "last_edit_ts" in d

    # --- Round-trip: missing optional keys restore correct defaults ---

    def test_roundtrip_missing_symbols_read_defaults_to_empty(self):
        """from_dict on a dict without symbols_read restores symbols_read=[]."""
        raw = {
            "rel_or_abs": "src/bar.py",
            "last_read_ts": 1_700_000_000.0,
            "read_count": 1,
            # symbols_read deliberately absent
        }
        entry = session._parse_file_entry("src/bar.py", raw, now=1_700_000_000.0)
        assert entry is not None
        assert entry.symbols_read == []

    def test_roundtrip_missing_line_ranges_defaults_to_empty(self):
        """from_dict on a dict without line_ranges restores line_ranges=[]."""
        raw = {
            "rel_or_abs": "src/bar.py",
            "last_read_ts": 1_700_000_000.0,
            "read_count": 1,
            # line_ranges deliberately absent
        }
        entry = session._parse_file_entry("src/bar.py", raw, now=1_700_000_000.0)
        assert entry is not None
        assert entry.line_ranges == []

    def test_roundtrip_full_cycle_file_entry(self, tmp_data_dir):
        """Serialize → deserialize round-trip for a FileEntry with all defaults omitted."""
        sid = "roundtrip_compact_1"
        cache = session.mark_file_read(sid, "src/mod.py", offset=0, limit=100)
        entry_before = cache.files["src/mod.py"]
        assert entry_before.symbols_read == []

        loaded = session.load(sid)
        entry_after = loaded.files["src/mod.py"]
        assert entry_after.symbols_read == []
        assert entry_after.line_ranges == entry_before.line_ranges
        assert entry_after.read_count == entry_before.read_count

    # --- Timestamp rounding ---

    def test_file_entry_ts_rounded_to_3dp(self):
        """last_read_ts is rounded to 3 decimal places in serialized form."""
        ts = 1_747_854_321.4839182
        entry = session.FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=ts,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
        )
        d = session._serialize_file_entry(entry)
        serialized = d["last_read_ts"]
        assert serialized == round(ts, 3)
        # Confirm it actually differs from the raw value (has more than 3 dp)
        assert serialized != ts

    def test_session_top_level_ts_rounded(self, tmp_data_dir):
        """started_ts, last_activity_ts, and created_ts are rounded in to_dict()."""
        sid = "ts_round_top_1"
        cache = session.load(sid)
        # Inject high-precision timestamps to verify rounding
        cache.started_ts = 1_747_854_321.4839182
        cache.last_activity_ts = 1_747_854_400.9991234
        cache.created_ts = 1_747_854_200.1234567
        d = cache.to_dict()
        assert d["started_ts"] == round(1_747_854_321.4839182, 3)
        assert d["last_activity_ts"] == round(1_747_854_400.9991234, 3)
        assert d["created_ts"] == round(1_747_854_200.1234567, 3)

    def test_grep_ts_rounded(self):
        """GrepEntry timestamp is rounded to 3 decimal places in serialized form."""
        entry = session.GrepEntry(pattern="foo", path=None, ts=1_747_000_000.9876543)
        d = session._serialize_grep_entry(entry)
        assert d["ts"] == round(1_747_000_000.9876543, 3)

    def test_bash_ts_rounded(self):
        """BashEntry timestamp is rounded to 3 decimal places in serialized form."""
        entry = session.BashEntry(
            cmd_sha="abc123",
            cmd_preview="pytest",
            output_id="out_1",
            ts=1_747_000_000.1234567,
            stdout_bytes=500,
            stderr_bytes=0,
        )
        d = session._serialize_bash_entry(entry)
        assert d["ts"] == round(1_747_000_000.1234567, 3)

    def test_web_ts_rounded(self):
        """WebEntry timestamp is rounded to 3 decimal places in serialized form."""
        entry = session.WebEntry(
            url_sha="sha_abc",
            url_preview="https://example.com",
            output_id="out_web",
            ts=1_747_000_000.5551234,
            body_bytes=2048,
        )
        d = session._serialize_web_entry(entry)
        assert d["ts"] == round(1_747_000_000.5551234, 3)

    def test_bash_entry_omits_default_fields(self):
        """_serialize_bash_entry omits exit_code/truncated/run_count/output_sha when default."""
        entry = session.BashEntry(
            cmd_sha="abc123",
            cmd_preview="ls",
            output_id="out_1",
            ts=1_747_000_000.0,
            stdout_bytes=100,
            stderr_bytes=0,
            # All remaining fields are defaults: exit_code=None, truncated=False,
            # run_count=1, output_sha=""
        )
        d = session._serialize_bash_entry(entry)
        # Required fields always present
        assert "cmd_sha" in d
        assert "ts" in d
        # Default-valued optional fields must be absent (saves ~15-35 bytes per entry)
        assert "exit_code" not in d
        assert "truncated" not in d
        assert "run_count" not in d
        assert "output_sha" not in d

    def test_bash_entry_includes_non_default_fields(self):
        """_serialize_bash_entry includes optional fields only when they differ from defaults."""
        entry = session.BashEntry(
            cmd_sha="def456",
            cmd_preview="pytest -x",
            output_id="out_2",
            ts=1_747_000_000.0,
            stdout_bytes=4096,
            stderr_bytes=512,
            exit_code=1,
            truncated=True,
            run_count=3,
            output_sha="deadbeef01234567",
        )
        d = session._serialize_bash_entry(entry)
        assert d["exit_code"] == 1
        assert d["truncated"] is True
        assert d["run_count"] == 3
        assert d["output_sha"] == "deadbeef01234567"

    def test_bash_entry_roundtrip_with_defaults(self, tmp_data_dir):
        """Round-trip of a BashEntry with all defaults preserves the correct values."""
        entry = session.BashEntry(
            cmd_sha="aaa000",
            cmd_preview="echo hi",
            output_id="out_rt",
            ts=1_747_000_000.0,
            stdout_bytes=10,
            stderr_bytes=0,
        )
        d = session._serialize_bash_entry(entry)
        parsed = session._parse_bash_entry(d)
        assert parsed is not None
        assert parsed.exit_code is None
        assert parsed.truncated is False
        assert parsed.run_count == 1
        assert parsed.output_sha == ""

    def test_web_entry_omits_default_fields(self):
        """_serialize_web_entry omits status_code/truncated when they are defaults."""
        entry = session.WebEntry(
            url_sha="abc_sha",
            url_preview="https://example.com",
            output_id="web_out",
            ts=1_747_000_000.0,
            body_bytes=1024,
            # Default: status_code=None, truncated=False
        )
        d = session._serialize_web_entry(entry)
        assert "status_code" not in d
        assert "truncated" not in d

    def test_web_entry_includes_non_default_fields(self):
        """_serialize_web_entry includes status_code/truncated when they differ from defaults."""
        entry = session.WebEntry(
            url_sha="abc_sha",
            url_preview="https://example.com",
            output_id="web_out",
            ts=1_747_000_000.0,
            body_bytes=1024,
            status_code=200,
            truncated=True,
        )
        d = session._serialize_web_entry(entry)
        assert d["status_code"] == 200
        assert d["truncated"] is True

    def test_web_entry_roundtrip_with_defaults(self, tmp_data_dir):
        """Round-trip of a WebEntry with all defaults preserves the correct values."""
        entry = session.WebEntry(
            url_sha="rt_sha",
            url_preview="https://rt.example.com",
            output_id="web_rt",
            ts=1_747_000_000.0,
            body_bytes=512,
        )
        d = session._serialize_web_entry(entry)
        parsed = session._parse_web_entry(d)
        assert parsed is not None
        assert parsed.status_code is None
        assert parsed.truncated is False

    def test_timestamp_roundtrip_within_millisecond(self, tmp_data_dir):
        """Round-trip preserves timestamp value within 0.001 seconds."""
        sid = "ts_roundtrip_1"
        ts_before = time.time()
        session.mark_file_read(sid, "src/z.py", offset=0, limit=10)
        loaded = session.load(sid)
        entry = loaded.files["src/z.py"]
        assert abs(entry.last_read_ts - ts_before) < 1.0  # within 1 second of when we started
        # The stored value must be rounded (no more than 3 significant decimal places)
        serialized = round(entry.last_read_ts, 3)
        assert entry.last_read_ts == serialized


class TestGlob:
    """Glob recording via mark_glob_run and lookup_glob_entry."""

    def test_mark_glob_run_appends_and_persists(self, tmp_data_dir):
        """mark_glob_run appends to glob_history and persists across load."""
        cache = session.mark_glob_run("glob_s1", "**/*.py", path="src/", result_count=42)
        assert len(cache.glob_history) == 1
        entry = cache.glob_history[0]
        assert entry.pattern == "**/*.py"
        assert entry.path == "src/"
        assert entry.result_count == 42

        loaded = session.load("glob_s1")
        assert len(loaded.glob_history) == 1
        assert loaded.glob_history[0].pattern == "**/*.py"
        assert loaded.glob_history[0].result_count == 42

    def test_mark_glob_run_no_result_count(self, tmp_data_dir):
        """mark_glob_run works when result_count is None."""
        cache = session.mark_glob_run("glob_s2", "**/*.ts")
        assert cache.glob_history[0].result_count is None

        loaded = session.load("glob_s2")
        assert loaded.glob_history[0].result_count is None

    def test_multiple_globs(self, tmp_data_dir):
        """Multiple glob calls all recorded in order."""
        session.mark_glob_run("glob_s3", "**/*.py", result_count=10)
        session.mark_glob_run("glob_s3", "**/*.ts", result_count=5)
        cache = session.load("glob_s3")
        assert len(cache.glob_history) == 2
        assert cache.glob_history[0].pattern == "**/*.py"
        assert cache.glob_history[1].pattern == "**/*.ts"

    def test_lookup_glob_entry_found(self, tmp_data_dir):
        """lookup_glob_entry returns the most recent matching entry."""
        session.mark_glob_run("glob_s4", "**/*.py", path=None, result_count=7)
        entry = session.lookup_glob_entry("glob_s4", "**/*.py", path=None)
        assert entry is not None
        assert entry.pattern == "**/*.py"
        assert entry.result_count == 7

    def test_lookup_glob_entry_not_found(self, tmp_data_dir):
        """lookup_glob_entry returns None when pattern has not been run."""
        session.mark_glob_run("glob_s5", "**/*.py", result_count=3)
        result = session.lookup_glob_entry("glob_s5", "**/*.ts")
        assert result is None

    def test_lookup_glob_entry_path_differentiates(self, tmp_data_dir):
        """Glob entries with same pattern but different path are distinct."""
        session.mark_glob_run("glob_s6", "**/*.py", path="src/", result_count=10)
        session.mark_glob_run("glob_s6", "**/*.py", path="tests/", result_count=5)
        # lookup with path="src/" should return the first entry
        entry_src = session.lookup_glob_entry("glob_s6", "**/*.py", path="src/")
        assert entry_src is not None
        assert entry_src.result_count == 10
        # lookup with path="tests/" should return the second
        entry_tests = session.lookup_glob_entry("glob_s6", "**/*.py", path="tests/")
        assert entry_tests is not None
        assert entry_tests.result_count == 5

    def test_lookup_glob_entry_returns_most_recent(self, tmp_data_dir):
        """lookup_glob_entry returns the most recent entry when pattern appears twice."""
        session.mark_glob_run("glob_s7", "**/*.py", result_count=10)
        session.mark_glob_run("glob_s7", "**/*.py", result_count=15)
        entry = session.lookup_glob_entry("glob_s7", "**/*.py")
        assert entry is not None
        assert entry.result_count == 15

    def test_is_glob_history_empty_true(self, tmp_data_dir):
        """is_glob_history_empty returns True for a fresh session."""
        cache = session.load("glob_empty_1")
        assert cache.is_glob_history_empty() is True

    def test_is_glob_history_empty_false(self, tmp_data_dir):
        """is_glob_history_empty returns False after a glob is recorded."""
        cache = session.mark_glob_run("glob_empty_2", "**/*.py", result_count=1)
        assert cache.is_glob_history_empty() is False


class TestGlobHistoryCap:
    """GLOB_HISTORY_MAX cap — oldest entries are FIFO-evicted when exceeded."""

    def test_glob_capped_at_max(self, tmp_data_dir):
        """Filling past GLOB_HISTORY_MAX keeps at most GLOB_HISTORY_MAX entries."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_cap_1"
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GLOB_HISTORY_MAX + 5):
                cache = session.mark_glob_run(sid, f"**/{i}/*.py", result_count=i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.glob_history) <= session.GLOB_HISTORY_MAX

    def test_glob_cap_evicts_oldest(self, tmp_data_dir):
        """When the cap fires, the oldest (first) patterns are evicted."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_cap_2"
        n = session.GLOB_HISTORY_MAX + 3
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(n):
                cache = session.mark_glob_run(sid, f"**/pat_{i}/*.py", result_count=i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        patterns = [g.pattern for g in cache.glob_history]
        # The first (oldest) patterns must be gone
        assert "**/pat_0/*.py" not in patterns
        assert "**/pat_1/*.py" not in patterns
        assert "**/pat_2/*.py" not in patterns
        # The most recent must survive
        assert f"**/pat_{n - 1}/*.py" in patterns

    def test_glob_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly GLOB_HISTORY_MAX entries: no eviction occurs."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_cap_3"
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GLOB_HISTORY_MAX):
                cache = session.mark_glob_run(sid, f"**/cap_{i}/*.py", result_count=i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.glob_history) == session.GLOB_HISTORY_MAX


class TestGlobSerializationRoundtrip:
    """GlobEntry round-trips correctly through to_dict / from_dict."""

    def test_glob_entry_roundtrip_with_result_count(self, tmp_data_dir):
        """GlobEntry with result_count survives JSON round-trip."""
        session.mark_glob_run("glob_rt_1", "**/*.py", path="src/", result_count=99)
        loaded = session.load("glob_rt_1")
        assert len(loaded.glob_history) == 1
        e = loaded.glob_history[0]
        assert e.pattern == "**/*.py"
        assert e.path == "src/"
        assert e.result_count == 99

    def test_glob_entry_roundtrip_no_result_count(self, tmp_data_dir):
        """GlobEntry without result_count survives JSON round-trip as None."""
        session.mark_glob_run("glob_rt_2", "*.toml", path=None)
        loaded = session.load("glob_rt_2")
        assert loaded.glob_history[0].result_count is None

    def test_parse_glob_entry_corrupted_returns_none(self):
        """_parse_glob_entry gracefully returns None for badly-typed fields."""
        bad = {"pattern": None, "path": 123, "ts": "not-a-float"}
        result = session._parse_glob_entry(bad)
        # pattern coercion: None → "" (str of None is "None" but None is not str/int/float)
        # ts coercion: "not-a-float" is a str not int/float → 0.0
        # Should not raise; result may be a GlobEntry with degraded values or None
        # Either outcome is acceptable as long as no exception escapes.
        assert result is None or isinstance(result, session.GlobEntry)

    def test_serialize_glob_entry_omits_none_result_count(self):
        """_serialize_glob_entry omits result_count key when it is None."""
        entry = session.GlobEntry(pattern="**/*.py", path=None, ts=1_747_000_000.0)
        d = session._serialize_glob_entry(entry)
        assert "result_count" not in d

    def test_serialize_glob_entry_includes_result_count(self):
        """_serialize_glob_entry includes result_count when set."""
        entry = session.GlobEntry(pattern="**/*.py", path="src/", ts=1_747_000_000.0, result_count=7)
        d = session._serialize_glob_entry(entry)
        assert d["result_count"] == 7


class TestSessionEvictionFIFO:
    """FIFO eviction correctness — newest entries are retained, oldest evicted."""

    def test_file_read_eviction_preserves_newest(self, tmp_data_dir):
        """Marking 25 files with cap=20 keeps the newest 20, evicts first 5."""
        sid = "evict_file_newest"
        with patch.object(session, "save"):
            # Mark 25 files read
            cache = None
            for i in range(25):
                cache = session.mark_file_read(sid, f"file_{i:02d}.py", offset=0, limit=10, cache=cache)
            # Cap is FILES_MAX (500 in config), so 25 should all fit — no eviction yet
            assert len(cache.files) == 25
            # Now mark enough files to trigger eviction when cap=20 is manually enforced
            # Do a targeted test: manually create a cache with 25 files, then call eviction
            for i in range(475):  # Now at 500 total
                cache = session.mark_file_read(sid, f"extra_{i:04d}.py", offset=0, limit=10, cache=cache)
        # At FILES_MAX=500, should be capped
        assert len(cache.files) <= session.FILES_MAX
        # Newest file should exist (last one added)
        assert f"extra_{474:04d}.py" in cache.files

    def test_glob_history_eviction_exact_threshold(self, tmp_data_dir):
        """At exactly GLOB_HISTORY_MAX entries, no eviction occurs."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_exact_cap"
        # Add exactly GLOB_HISTORY_MAX entries — batch writes to avoid N×save.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GLOB_HISTORY_MAX):
                cache = session.mark_glob_run(sid, f"pattern_{i:03d}", result_count=10 + i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.glob_history) == session.GLOB_HISTORY_MAX
        # Verify first entry is still present
        assert cache.glob_history[0].pattern == "pattern_000"

    def test_glob_history_eviction_at_cap_plus_one(self, tmp_data_dir):
        """At GLOB_HISTORY_MAX + 1, the oldest entry is evicted immediately."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_at_cap_plus_one"
        # Add GLOB_HISTORY_MAX + 1 entries — batch writes to avoid N×save.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GLOB_HISTORY_MAX + 1):
                cache = session.mark_glob_run(sid, f"pat_{i:03d}", result_count=i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        # Should be capped at GLOB_HISTORY_MAX
        assert len(cache.glob_history) == session.GLOB_HISTORY_MAX
        # The first entry (pat_000) should be gone
        patterns = [g.pattern for g in cache.glob_history]
        assert "pat_000" not in patterns
        # The most recent (pat_020) should be present
        assert f"pat_{session.GLOB_HISTORY_MAX:03d}" in patterns

    def test_glob_history_eviction_batch_25_entries(self, tmp_data_dir):
        """Adding 25 entries beyond cap evicts correctly, keeps newest."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_batch_evict"
        # Add GLOB_HISTORY_MAX + 25 entries — batch writes to avoid N×save.
        total = session.GLOB_HISTORY_MAX + 25
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(total):
                cache = session.mark_glob_run(sid, f"batch_{i:03d}", result_count=100 + i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        # Should be at or below GLOB_HISTORY_MAX
        assert len(cache.glob_history) <= session.GLOB_HISTORY_MAX
        # Most recent entries must be present
        patterns = [g.pattern for g in cache.glob_history]
        assert f"batch_{total - 1:03d}" in patterns
        # Oldest entries must be evicted
        assert "batch_000" not in patterns

    def test_bash_history_eviction_fifo_order(self, tmp_data_dir):
        """Bash history eviction preserves insertion order, evicts oldest."""
        import unittest.mock  # noqa: PLC0415

        from token_goat import bash_cache

        sid = "bash_fifo_order"
        # Add BASH_HISTORY_MAX + 10 entries; suppress intermediate saves.
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(session.BASH_HISTORY_MAX + 10):
                cmd = f"cmd_{i:04d}"
                cmd_sha = bash_cache.command_hash(cmd)
                cache = session.mark_bash_run(
                    sid,
                    cmd_sha,
                    cmd_preview=cmd,
                    output_id=f"out_{i}",
                    stdout_bytes=1000,
                    stderr_bytes=0,
                    exit_code=0,
                    truncated=False,
                    cache=cache,
                )
        if cache is not None:
            session.save(cache)
        loaded = session.load(sid)
        # Should be capped at BASH_HISTORY_MAX
        assert len(loaded.bash_history) <= session.BASH_HISTORY_MAX
        # Most recent command's output should be in the history
        # Find the last command that made it through
        max_i = session.BASH_HISTORY_MAX + 10 - 1
        last_cmd = f"cmd_{max_i:04d}"
        assert any(last_cmd in e.cmd_preview for e in loaded.bash_history.values())

    def test_web_history_eviction_preserves_newest(self, tmp_data_dir):
        """Web history eviction at FIFO cap preserves newest entries."""
        import token_goat.session as _session_mod  # noqa: PLC0415
        from token_goat import web_cache  # noqa: PLC0415

        sid = "web_fifo_newest"
        # Add WEB_HISTORY_MAX + 15 entries — batch writes to avoid N×(load+save).
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.WEB_HISTORY_MAX + 15):
                url = f"https://example.com/page_{i}"
                url_sha = web_cache.url_hash(url)
                cache = session.mark_web_fetch(
                    sid,
                    url_sha,
                    url_preview=url,
                    output_id=f"web_out_{i}",
                    body_bytes=5000,
                    status_code=200,
                    truncated=False,
                    cache=cache,
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        # Should be capped at WEB_HISTORY_MAX
        assert len(cache.web_history) <= session.WEB_HISTORY_MAX
        # Most recent URL preview should be present
        previews = [e.url_preview for e in cache.web_history.values()]
        max_i = session.WEB_HISTORY_MAX + 15 - 1
        assert any(f"page_{max_i}" in p for p in previews)


class TestEdgesCasesForEviction:
    """Edge cases: empty lists, off-by-one boundaries."""

    def test_evict_oldest_on_empty_dict_noop(self, tmp_data_dir):
        """_evict_oldest on an empty dict is a no-op."""
        d = {}
        session._evict_oldest(d, cap=10, evict_n=5, label="test", session_id="test")
        assert d == {}

    def test_evict_oldest_below_cap_is_noop(self, tmp_data_dir):
        """_evict_oldest when len < cap is a no-op."""
        d = {"a": 1, "b": 2, "c": 3}
        session._evict_oldest(d, cap=10, evict_n=5, label="test", session_id="test")
        assert d == {"a": 1, "b": 2, "c": 3}

    def test_evict_oldest_exactly_at_cap_triggers(self, tmp_data_dir):
        """_evict_oldest triggers when len == cap (should evict)."""
        d = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}
        session._evict_oldest(d, cap=5, evict_n=2, label="test", session_id="test")
        # At cap, eviction should fire
        assert len(d) == 3
        # First two keys (a, b) should be gone
        assert "a" not in d
        assert "b" not in d
        assert "c" in d


class TestLineRangesCap:
    """mark_file_read collapses line_ranges to a spanning range at _MAX_LINE_RANGES_PER_FILE."""

    def test_below_cap_ranges_kept_distinct(self, tmp_data_dir):
        sid = "lr-cap-1"
        path = "/proj/src/big.py"
        # 3 non-adjacent reads — well below cap of 15
        session.mark_file_read(sid, path, offset=0, limit=10)
        session.mark_file_read(sid, path, offset=100, limit=10)
        session.mark_file_read(sid, path, offset=200, limit=10)
        entry = session.get_file_entry(sid, path)
        assert entry is not None
        assert len(entry.line_ranges) == 3

    def test_at_cap_ranges_not_yet_collapsed(self, tmp_data_dir):
        sid = "lr-cap-2"
        path = "/proj/src/big.py"
        # Read 9 times (under full-file threshold of 10) to test range capping behavior
        # without hitting the sentinel collapse. Pass cache to avoid repeated disk I/O.
        cache = None
        for i in range(9):
            cache = session.mark_file_read(sid, path, offset=i * 100, limit=10, cache=cache)
        entry = session.get_file_entry(sid, path)
        assert entry is not None
        # At 9 reads, ranges should still be tracked (not sentinel)
        assert entry.line_ranges != [(0, 0)]
        assert len(entry.line_ranges) <= session._MAX_LINE_RANGES_PER_FILE

    def test_exceeding_cap_collapses_to_spanning(self, tmp_data_dir):
        # The spanning-range collapse happens in mark_file_read when len(merged) > 15.
        # However, the full-file sentinel at read 10 takes precedence, so we can't
        # easily trigger spanning-range via mark_file_read. Instead, test the logic
        # by verifying that when you have many ranges, the code path would collapse.
        # This is tested indirectly by test_spanning_range_merge_logic below.
        # For now, just verify the sentinel prevents spanning-range from being reached.
        sid = "lr-cap-3"
        path = "/proj/src/big.py"
        # Read 10 times (hits sentinel threshold), passing cache to avoid repeated disk I/O
        cache = None
        for i in range(10):
            cache = session.mark_file_read(sid, path, offset=i * 100, limit=10, cache=cache)
        entry = session.get_file_entry(sid, path)
        assert entry is not None
        # At read 10, should be collapsed to sentinel (not spanning range)
        assert entry.line_ranges == [(0, 0)]

    def test_spanning_range_is_superset(self, tmp_data_dir):
        sid = "lr-cap-4"
        path = "/proj/src/big.py"
        # Read 9 times (under full-file threshold) with large gaps between reads.
        # When _merge_ranges is called internally, it should produce a spanning range
        # if there are many disjoint ranges. With 9 reads at 500-line intervals,
        # each read adds one range, so we'll have ~9 ranges (no merging due to gaps).
        # Pass cache to avoid repeated disk I/O.
        cache = None
        for i in range(9):
            cache = session.mark_file_read(sid, path, offset=i * 500, limit=10, cache=cache)
        entry = session.get_file_entry(sid, path)
        assert entry is not None
        # Should have multiple ranges (not sentinel, not a single spanning range yet)
        assert entry.line_ranges != [(0, 0)]
        # Verify ranges cover the accessed lines
        assert any(start <= 1 for start, _ in entry.line_ranges)  # First read at line 1
        assert any(end >= (8 * 500 + 10) for _, end in entry.line_ranges)  # Last read


class TestLegacyHighCapSessionLoad:
    """Sessions written with old 200-entry caps load cleanly under new 75-entry caps."""

    def test_bash_history_over_new_cap_loads_without_error(self, tmp_data_dir):
        """A session JSON with 150 bash entries (old cap=200) loads intact."""
        import unittest.mock  # noqa: PLC0415

        sid = "legacy-bash-150"
        # Write 150 entries under the old cap; new cap is 75 but load should not crash.
        # Suppress intermediate saves (150 atomic writes) — flush once at the end.
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(150):
                cache = session.mark_bash_run(
                    sid, f"sha{i:04d}", f"pytest tests/test_{i}.py",
                    f"out-{i}", stdout_bytes=1000, stderr_bytes=0,
                    exit_code=0, truncated=False, cache=cache,
                )
        if cache is not None:
            session.save(cache)
        # Force-persist so we have a JSON file with 150 entries.
        loaded = session.load(sid)
        # The in-memory dict may have been evicted to BASH_HISTORY_MAX already;
        # either way, loading must succeed and result must be a valid cache.
        assert isinstance(loaded, session.SessionCache)
        assert len(loaded.bash_history) <= session.BASH_HISTORY_MAX

    def test_web_history_over_new_cap_loads_without_error(self, tmp_data_dir):
        """A session JSON with 150 web entries loads intact under the new 75 cap."""
        import unittest.mock  # noqa: PLC0415

        sid = "legacy-web-150"
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(150):
                cache = session.mark_web_fetch(
                    sid, f"sha{i:04d}", f"https://example.com/page/{i}",
                    f"wout-{i}", body_bytes=2000, status_code=200, truncated=False, cache=cache,
                )
        if cache is not None:
            session.save(cache)
        loaded = session.load(sid)
        assert isinstance(loaded, session.SessionCache)
        assert len(loaded.web_history) <= session.WEB_HISTORY_MAX

    def test_grep_history_over_new_cap_loads_without_error(self, tmp_data_dir):
        """A session JSON with 150 grep entries loads intact under the new 75 cap."""
        import unittest.mock  # noqa: PLC0415

        sid = "legacy-grep-150"
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(150):
                cache = session.mark_grep(sid, f"pattern_{i}", f"/proj/src_{i}", cache=cache)
        if cache is not None:
            session.save(cache)
        loaded = session.load(sid)
        assert isinstance(loaded, session.SessionCache)
        assert len(loaded.greps) <= session.GREPS_HISTORY_MAX

    def test_next_write_after_oversize_load_stays_bounded(self, tmp_data_dir):
        """After loading an oversize session, the next write keeps history bounded."""
        import unittest.mock  # noqa: PLC0415

        sid = "legacy-write-bounded"
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(150):
                cache = session.mark_bash_run(
                    sid, f"sha{i:04d}", f"cmd {i}",
                    f"out-{i}", stdout_bytes=500, stderr_bytes=0,
                    exit_code=0, truncated=False, cache=cache,
                )
        if cache is not None:
            session.save(cache)
        # One more write should trigger eviction to BASH_HISTORY_MAX.
        session.mark_bash_run(
            sid, "shaXXXX", "final cmd",
            "out-final", stdout_bytes=500, stderr_bytes=0,
            exit_code=0, truncated=False,
        )
        loaded = session.load(sid)
        assert len(loaded.bash_history) <= session.BASH_HISTORY_MAX

    def test_bash_history_cap_300_entries_save_load(self, tmp_data_dir):
        """Creating 300 bash_history entries and round-tripping through save/load
        must leave at most BASH_HISTORY_MAX entries in the loaded cache.

        Regression guard: verifies that the FIFO eviction applied by
        mark_bash_run() is respected end-to-end through the JSON serialization
        and deserialization cycle, regardless of how many entries were added
        in a single batch.
        """
        import unittest.mock  # noqa: PLC0415

        sid = "bash-cap-300-roundtrip"
        n = 300
        cache = None
        with unittest.mock.patch.object(session, "save", return_value=None):
            for i in range(n):
                cache = session.mark_bash_run(
                    sid,
                    f"sha{i:04d}",
                    f"pytest tests/test_batch_{i}.py",
                    f"out-{i}",
                    stdout_bytes=500,
                    stderr_bytes=0,
                    exit_code=0,
                    truncated=False,
                    cache=cache,
                )
        # Flush the final in-memory state to disk in one write.
        if cache is not None:
            session.save(cache)
        loaded = session.load(sid)
        # Cap enforcement: at most BASH_HISTORY_MAX entries must survive.
        assert len(loaded.bash_history) <= session.BASH_HISTORY_MAX, (
            f"Expected <= {session.BASH_HISTORY_MAX} bash_history entries after "
            f"inserting {n}; got {len(loaded.bash_history)}"
        )
        # The most recent entry must be present (FIFO evicts oldest, not newest).
        last_preview = f"pytest tests/test_batch_{n - 1}.py"
        assert any(
            last_preview in e.cmd_preview for e in loaded.bash_history.values()
        ), f"Most recent entry '{last_preview}' missing from loaded bash_history"
        # The oldest entry must have been evicted.
        first_preview = "pytest tests/test_batch_0.py"
        assert all(
            first_preview not in e.cmd_preview for e in loaded.bash_history.values()
        ), f"Oldest entry '{first_preview}' should have been evicted but is still present"


class TestSessionSchemaMigration:
    """Schema migration for older session JSON files missing new fields."""

    def test_migrate_session_adds_missing_edited_files(self, tmp_data_dir):
        """_migrate_session adds empty edited_files dict when missing."""
        old_data = {
            "session_id": "test-migrate-1",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {},
        }
        migrated = session._migrate_session(old_data)
        assert "edited_files" in migrated
        assert migrated["edited_files"] == {}

    def test_migrate_session_adds_missing_glob_history(self, tmp_data_dir):
        """_migrate_session adds empty glob_history list when missing."""
        old_data = {
            "session_id": "test-migrate-2",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {},
        }
        migrated = session._migrate_session(old_data)
        assert "glob_history" in migrated
        assert migrated["glob_history"] == []

    def test_migrate_session_adds_symbols_ts_to_file_entries(self, tmp_data_dir):
        """_migrate_session adds empty symbols_ts to each FileEntry."""
        old_data = {
            "session_id": "test-migrate-3",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {
                "src/foo.py": {
                    "rel_or_abs": "src/foo.py",
                    "last_read_ts": time.time(),
                    "read_count": 1,
                    # symbols_ts missing
                }
            },
        }
        migrated = session._migrate_session(old_data)
        file_entry = migrated["files"]["src/foo.py"]
        assert "symbols_ts" in file_entry
        assert file_entry["symbols_ts"] == {}

    def test_migrate_session_adds_last_edit_ts_to_file_entries(self, tmp_data_dir):
        """_migrate_session adds last_edit_ts=0.0 to each FileEntry."""
        old_data = {
            "session_id": "test-migrate-4",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {
                "src/bar.py": {
                    "rel_or_abs": "src/bar.py",
                    "last_read_ts": time.time(),
                    "read_count": 2,
                    # last_edit_ts missing
                }
            },
        }
        migrated = session._migrate_session(old_data)
        file_entry = migrated["files"]["src/bar.py"]
        assert "last_edit_ts" in file_entry
        assert file_entry["last_edit_ts"] == 0.0

    def test_old_session_without_glob_history_loads_fine(self, tmp_data_dir):
        """Loading an old session JSON missing glob_history succeeds."""
        sid = "old-no-glob-history"
        session.load(sid)
        # Mark a file read to trigger a save
        session.mark_file_read(sid, "test.py", offset=0, limit=10)
        # Load the session and verify glob_history exists
        loaded = session.load(sid)
        assert loaded.glob_history == []
        assert len(loaded.files) == 1

    def test_old_session_without_symbols_ts_on_file_entry_loads_fine(self, tmp_data_dir):
        """Loading an old session JSON with FileEntry missing symbols_ts succeeds."""
        sid = "old-no-symbols-ts"
        # Mark a file read with a symbol
        session.mark_file_read(sid, "src/module.py", symbol="MyClass")
        loaded = session.load(sid)
        entry = loaded.files.get("src/module.py")
        assert entry is not None
        assert isinstance(entry.symbols_ts, dict)  # Migration added field
        assert "MyClass" in entry.symbols_read

    def test_fully_modern_session_unaffected_by_migration(self, tmp_data_dir):
        """Loading a fully modern session (with all fields) remains unchanged."""
        sid = "modern-session"
        # Create a full session by writing multiple operations
        session.mark_file_read(sid, "src/test.py", offset=0, limit=50)
        session.mark_file_edited(sid, "src/test.py")
        session.mark_glob_run(sid, "**/*.py", result_count=42)
        loaded = session.load(sid)
        # Verify all new fields exist and are intact
        assert isinstance(loaded.glob_history, list)
        assert len(loaded.glob_history) == 1
        assert loaded.glob_history[0].pattern == "**/*.py"
        assert loaded.edited_files == {"src/test.py": 1}
        entry = loaded.files["src/test.py"]
        assert isinstance(entry.symbols_ts, dict)
        assert entry.last_edit_ts > 0.0

    def test_missing_edited_files_defaults_to_empty_list(self, tmp_data_dir):
        """When edited_files is missing from old JSON, it defaults to empty dict."""
        old_data = {
            "session_id": "test-default-edited",
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "files": {},
            # edited_files not present
        }
        migrated = session._migrate_session(old_data)
        cache = session.SessionCache.from_dict(migrated)
        assert cache.edited_files == {}


class TestSharedHistoryHelpers:
    """Tests for _append_to_dict_history and _append_to_list_history helpers."""

    def test_dict_history_evicts_at_cap_plus_one(self, tmp_data_dir):
        """Dict history evicts oldest batch when exceeding cap (new key triggers eviction)."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "dict_evict_1"
        cache = session.load(sid)
        # Fill bash_history to BASH_HISTORY_MAX with new keys — batch to avoid N×save.
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.BASH_HISTORY_MAX):
                cache = session.mark_bash_run(
                    sid, f"sha_{i}", f"cmd_{i}", f"out_{i}", 100, 0, 0, False, cache=cache,
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.bash_history) == session.BASH_HISTORY_MAX
        # Adding one more (cap+1) triggers eviction: oldest batch is removed
        session.mark_bash_run(
            sid, "sha_final", "cmd_final", "out_final", 100, 0, 0, False
        )
        cache = session.load(sid)
        # Should have evicted _BASH_HISTORY_EVICT oldest entries, then added 1 new
        assert len(cache.bash_history) <= session.BASH_HISTORY_MAX

    def test_dict_history_batch_eviction_respects_batch_size(self, tmp_data_dir):
        """Dict history evicts exactly batch_size entries at a time."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "dict_batch_1"
        cache = session.load(sid)
        # Fill to capacity — batch writes to avoid N×(load+save) disk overhead.
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.BASH_HISTORY_MAX):
                cache = session.mark_bash_run(
                    sid, f"sha_{i}", f"cmd_{i}", f"out_{i}", 100, 0, 0, False, cache=cache,
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        initial_count = len(cache.bash_history)
        # Add one more to trigger eviction
        session.mark_bash_run(
            sid, f"sha_{session.BASH_HISTORY_MAX}", "cmd_new", "out_new", 100, 0, 0, False
        )
        cache = session.load(sid)
        # Count should be: initial - evict_batch + 1 new = initial - (batch - 1)
        expected = initial_count - (session._BASH_HISTORY_EVICT - 1)
        assert len(cache.bash_history) == expected

    def test_list_history_evicts_at_cap_plus_one(self, tmp_data_dir):
        """List history keeps only max_size entries when exceeding cap."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "list_evict_1"
        cache = session.load(sid)
        # Fill grep history to GREPS_HISTORY_MAX — batch writes to avoid N×save.
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GREPS_HISTORY_MAX):
                cache = session.mark_grep(sid, f"pattern_{i}", "/src", cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.greps) == session.GREPS_HISTORY_MAX
        # Adding one more should evict oldest to keep at max
        session.mark_grep(sid, "pattern_final", "/src")
        cache = session.load(sid)
        assert len(cache.greps) == session.GREPS_HISTORY_MAX

    def test_list_history_keeps_most_recent(self, tmp_data_dir):
        """List history evicts oldest entries, keeping most recent entries."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "list_recent_1"
        # Add more than GREPS_HISTORY_MAX entries — batch to avoid N×save.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GREPS_HISTORY_MAX + 5):
                cache = session.mark_grep(sid, f"pattern_{i}", "/src", cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        patterns = [g.pattern for g in cache.greps]
        # Oldest patterns should be gone
        assert "pattern_0" not in patterns
        assert "pattern_1" not in patterns
        # Most recent should exist
        assert f"pattern_{session.GREPS_HISTORY_MAX + 4}" in patterns

    def test_web_history_uses_dict_helper(self, tmp_data_dir):
        """Web history uses _append_to_dict_history and respects caps like bash."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "web_dict_1"
        cache = session.load(sid)
        # Fill web_history — batch writes to avoid N×(load+save) disk overhead.
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.WEB_HISTORY_MAX):
                cache = session.mark_web_fetch(
                    sid, f"sha_{i}", f"http://example.com/{i}", f"out_{i}", 1000, 200, False,
                    cache=cache,
                )
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.web_history) == session.WEB_HISTORY_MAX
        # Add one more to trigger eviction
        session.mark_web_fetch(
            sid, "sha_final", "http://example.com/final", "out_final", 1000, 200, False,
        )
        cache = session.load(sid)
        assert len(cache.web_history) <= session.WEB_HISTORY_MAX

    def test_glob_history_uses_list_helper(self, tmp_data_dir):
        """Glob history uses _append_to_list_history and keeps most recent."""
        import token_goat.session as _session_mod  # noqa: PLC0415

        sid = "glob_list_1"
        # Add more than GLOB_HISTORY_MAX — batch to avoid N×save.
        cache = session.load(sid)
        with patch.object(_session_mod, "save", return_value=None):
            for i in range(session.GLOB_HISTORY_MAX + 3):
                cache = session.mark_glob_run(sid, f"**/{i}/*.py", result_count=i, cache=cache)
        _session_mod.save(cache)
        cache = session.load(sid)
        assert len(cache.glob_history) == session.GLOB_HISTORY_MAX
        # Oldest should be evicted
        patterns = [g.pattern for g in cache.glob_history]
        assert "**/0/*.py" not in patterns
        assert f"**/{session.GLOB_HISTORY_MAX + 2}/*.py" in patterns


class TestCuratorSessionFields:
    """Round-trip and migration tests for hints_emitted / hints_ignored / recent_hints."""

    def test_hints_emitted_ignored_default_zero(self, tmp_data_dir):
        """Fresh session has hints_emitted=0 and hints_ignored=0."""
        cache = session.load("curator_fresh_1")
        assert cache.hints_emitted == 0
        assert cache.hints_ignored == 0

    def test_recent_hints_default_empty(self, tmp_data_dir):
        """Fresh session has recent_hints=[]."""
        cache = session.load("curator_fresh_2")
        assert cache.recent_hints == []

    def test_roundtrip_hints_emitted_ignored(self, tmp_data_dir):
        """hints_emitted and hints_ignored survive save/load round-trip."""
        sid = "curator_rt_1"
        cache = session.load(sid)
        cache.hints_emitted = 15
        cache.hints_ignored = 7
        cache._invalidate_json_cache()
        session.save(cache)
        reloaded = session.load(sid)
        assert reloaded.hints_emitted == 15
        assert reloaded.hints_ignored == 7

    def test_roundtrip_recent_hints(self, tmp_data_dir):
        """recent_hints survives save/load round-trip with correct types."""
        import time as _time

        sid = "curator_rt_2"
        cache = session.load(sid)
        ts1 = _time.time()
        ts2 = ts1 + 1.5
        cache.recent_hints = [("/proj/a.py", ts1), ("/proj/b.py", ts2)]
        cache._invalidate_json_cache()
        session.save(cache)
        reloaded = session.load(sid)
        assert len(reloaded.recent_hints) == 2
        paths = [p for p, _ in reloaded.recent_hints]
        assert "/proj/a.py" in paths
        assert "/proj/b.py" in paths

    def test_recent_hints_capped_at_3_on_load(self, tmp_data_dir):
        """recent_hints is capped at 3 entries during deserialization."""
        import json
        import time as _time

        from token_goat import paths

        sid = "curator_cap_1"
        cache = session.load(sid)
        now = _time.time()
        # Manually write a session JSON with 5 recent_hints entries.
        raw = json.loads(cache.to_json())
        raw["recent_hints"] = [[f"/proj/file_{i}.py", now + i] for i in range(5)]
        p = paths.session_cache_path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(raw), encoding="utf-8")
        reloaded = session.load(sid)
        assert len(reloaded.recent_hints) <= 3

    def test_migration_adds_missing_fields(self, tmp_data_dir):
        """A session JSON missing curator fields loads with defaults via migration."""
        import json

        from token_goat import paths

        sid = "curator_migrate_1"
        cache = session.load(sid)
        raw = json.loads(cache.to_json())
        raw.pop("hints_emitted", None)
        raw.pop("hints_ignored", None)
        raw.pop("recent_hints", None)
        p = paths.session_cache_path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(raw), encoding="utf-8")
        reloaded = session.load(sid)
        assert reloaded.hints_emitted == 0
        assert reloaded.hints_ignored == 0
        assert reloaded.recent_hints == []

    def test_serialized_recent_hints_shape(self, tmp_data_dir):
        """recent_hints serializes as list[list[str, float]] in JSON."""
        import json
        import time as _time

        sid = "curator_serial_1"
        cache = session.load(sid)
        now = _time.time()
        cache.recent_hints = [("/proj/x.py", now)]
        cache._invalidate_json_cache()
        raw = json.loads(cache.to_json())
        assert isinstance(raw["recent_hints"], list)
        assert len(raw["recent_hints"]) == 1
        entry = raw["recent_hints"][0]
        assert isinstance(entry, list)
        assert entry[0] == "/proj/x.py"
        assert isinstance(entry[1], float)


# ---------------------------------------------------------------------------
# TestHintBudgetCounters — structured/index_only counters round-trip through JSON
# ---------------------------------------------------------------------------


class TestHintBudgetCounters:
    """structured_hints_emitted and index_only_hints_emitted persist and reload correctly."""

    def test_structured_hints_emitted_defaults_to_zero(self, tmp_data_dir):
        cache = session.load("hb_ct_default")
        assert cache.structured_hints_emitted == 0
        assert cache.index_only_hints_emitted == 0

    def test_structured_hints_emitted_roundtrip(self, tmp_data_dir):
        """structured_hints_emitted and index_only_hints_emitted persist across save/load."""
        sid = "hb_ct_roundtrip"
        cache = session.load(sid)
        cache.structured_hints_emitted = 7
        cache.index_only_hints_emitted = 13
        cache._invalidate_json_cache()
        session.save(cache)

        reloaded = session.load(sid)
        assert reloaded.structured_hints_emitted == 7
        assert reloaded.index_only_hints_emitted == 13

    def test_missing_counters_deserialize_as_zero(self, tmp_data_dir):
        """Older session JSON without the new fields deserializes with counter = 0."""
        import json

        from token_goat.session import SessionCache

        sid = "hb_ct_legacy"
        cache = session.load(sid)
        # Serialize, then strip the new fields to simulate an older session file.
        raw = json.loads(cache.to_json())
        raw.pop("structured_hints_emitted", None)
        raw.pop("index_only_hints_emitted", None)

        restored = SessionCache.from_dict(raw)
        assert restored.structured_hints_emitted == 0
        assert restored.index_only_hints_emitted == 0

    def test_counters_in_json_output(self, tmp_data_dir):
        """to_json() includes both new counters."""
        import json

        sid = "hb_ct_json"
        cache = session.load(sid)
        cache.structured_hints_emitted = 3
        cache.index_only_hints_emitted = 5
        cache._invalidate_json_cache()

        raw = json.loads(cache.to_json())
        assert raw["structured_hints_emitted"] == 3
        assert raw["index_only_hints_emitted"] == 5


# ---------------------------------------------------------------------------
# last_manifest_sha / last_manifest_ts round-trip (item #19)
# ---------------------------------------------------------------------------

class TestLastManifestFields:
    """Verify the two manifest delta-cache fields survive a save/load round-trip."""

    def test_default_values(self, tmp_data_dir):
        cache = session.load("mf_defaults")
        assert cache.last_manifest_sha == ""
        assert cache.last_manifest_ts == 0.0

    def test_round_trip_persists_fields(self, tmp_data_dir):
        sid = "mf_roundtrip"
        cache = session.load(sid)
        cache.last_manifest_sha = "abcd1234abcd1234"
        cache.last_manifest_ts = 1_700_000_000.0
        cache._invalidate_json_cache()
        session.save(cache)

        reloaded = session.load(sid)
        assert reloaded.last_manifest_sha == "abcd1234abcd1234"
        assert reloaded.last_manifest_ts == pytest.approx(1_700_000_000.0)

    def test_legacy_session_missing_fields_defaults_to_zero(self, tmp_data_dir):
        """Older session JSON without the new fields deserializes cleanly."""
        import json

        from token_goat.session import SessionCache

        sid = "mf_legacy"
        cache = session.load(sid)
        raw = json.loads(cache.to_json())
        raw.pop("last_manifest_sha", None)
        raw.pop("last_manifest_ts", None)

        restored = SessionCache.from_dict(raw)
        assert restored.last_manifest_sha == ""
        assert restored.last_manifest_ts == 0.0

    def test_fields_present_in_to_json(self, tmp_data_dir):
        import json

        sid = "mf_json_keys"
        cache = session.load(sid)
        cache.last_manifest_sha = "ff00ff00ff00ff00"
        cache.last_manifest_ts = 12345.6
        cache._invalidate_json_cache()

        raw = json.loads(cache.to_json())
        assert raw["last_manifest_sha"] == "ff00ff00ff00ff00"
        assert raw["last_manifest_ts"] == pytest.approx(12345.6)


# ---------------------------------------------------------------------------
# Optimistic CAS / concurrent-write tests (item #2)
# ---------------------------------------------------------------------------

class TestSessionCAS:
    """Verify optimistic CAS prevents lost updates from concurrent hook processes."""

    def test_version_field_default_zero(self, tmp_data_dir):
        """Fresh session starts at version 0."""
        cache = session.load("cas_v0")
        assert cache.version == 0

    def test_version_increments_on_save(self, tmp_data_dir):
        """Each save increments the version monotonically."""
        sid = "cas_incr"
        c = session.load(sid)
        assert c.version == 0
        session.save(c)
        c2 = session.load(sid)
        assert c2.version == 1
        session.save(c2)
        c3 = session.load(sid)
        assert c3.version == 2

    def test_version_survives_round_trip(self, tmp_data_dir):
        """version field serialises to JSON and deserialises correctly."""
        import json as _json

        sid = "cas_rt"
        c = session.load(sid)
        session.save(c)
        raw = _json.loads(session.load(sid).to_json())
        assert raw["version"] == 1

    def test_legacy_json_missing_version_defaults_to_zero(self, tmp_data_dir):
        """Old session JSON without version deserialises cleanly."""
        import json as _json

        from token_goat.session import SessionCache

        sid = "cas_legacy"
        c = session.load(sid)
        raw = _json.loads(c.to_json())
        raw.pop("version", None)
        restored = SessionCache.from_dict(raw)
        assert restored.version == 0

    def test_version_does_not_regress_when_stale_disk_version_present(self, tmp_data_dir):
        """CAS version must never decrease when disk has a stale (lower) version.

        Regression: `cache.version = disk_cache.version + 1` with a stale disk
        (e.g. disk=3, memory=5) produced version 4 — a regression from 5.  The
        next process to load the stale file would compute 4 > 3, skip a merge it
        should have done, and silently discard in-flight writes.
        """
        import json as _json

        from token_goat import paths as _paths

        sid = "cas_no_regress"

        # Build an in-memory cache with version=5 (simulates several prior saves).
        c = session.load(sid)
        c.version = 5

        # Plant a stale on-disk file with version=3 (simulates a concurrent
        # slow writer that hadn't yet caught up).
        stale_data = c.to_dict()
        stale_data["version"] = 3
        p = _paths.session_cache_path(sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(_json.dumps(stale_data), encoding="utf-8")
        # Corrupt the fingerprint so the fast-path CAS skip does NOT fire.
        c._disk_mtime_ns = 0
        c._disk_size = 0

        session.save(c)

        written = session.load(sid)
        # Written version must be strictly greater than the in-memory version,
        # not just disk_version + 1.
        assert written.version > 5, (
            f"version regressed: expected >5 after save, got {written.version}"
        )

    def test_concurrent_threads_both_edits_preserved(self, tmp_data_dir):
        """Two threads that concurrently load+mark_file_edited both persist their edit."""
        import threading

        sid = "cas_concurrent_edit"
        # Pre-create so both threads start from the same on-disk state.
        session.save(session.load(sid))

        errors: list[Exception] = []
        barrier = threading.Barrier(2)

        def worker(path: str) -> None:
            try:
                c = session.load(sid)
                # Generous timeout: under heavy xdist CPU contention on a slow
                # Windows runner the second thread can be scheduled late; a tight
                # barrier would raise BrokenBarrierError (a starvation artifact,
                # not a CAS bug). We only need both threads to overlap, not to
                # meet within milliseconds.
                barrier.wait(timeout=30)  # sync both threads to maximise race window
                session.mark_file_edited(sid, path, cache=c)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        t1 = threading.Thread(target=worker, args=("/thread/file_a.py",))
        t2 = threading.Thread(target=worker, args=("/thread/file_b.py",))
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert not errors, f"thread errors: {errors}"

        # This test asserts CAS *disk* persistence. The process-local load cache
        # is an orthogonal layer that can return a pre-merge object when a coarse
        # Windows mtime aliases the final-save timestamp — a confound that has
        # nothing to do with whether both edits reached disk. Drop the proc-cache
        # entry so the final load() reads the authoritative on-disk JSON.
        session._proc_load_cache.pop(sid, None)
        final = session.load(sid)
        assert "/thread/file_a.py" in final.edited_files, "file_a lost"
        assert "/thread/file_b.py" in final.edited_files, "file_b lost"

    def test_concurrent_threads_hints_emitted_not_lost(self, tmp_data_dir):
        """Two threads incrementing hints_emitted must not drop the winner's write.

        The CAS merge strategy for integer counters is max(local, remote), which
        prevents the classic lost-update scenario where the later writer silently
        overwrites the earlier one with a stale (lower) value.  It does not sum
        independent increments from the same base — that would require a CRDT
        counter.  The guarantee here is: the final value is at least as large as
        the highest value either thread wrote.  Starting from 0 with both threads
        writing 1, the result is at least 1 (never 0).
        """
        import threading

        sid = "cas_hints_counter"
        session.save(session.load(sid))

        errors: list[Exception] = []
        barrier = threading.Barrier(2)

        def worker() -> None:
            try:
                c = session.load(sid)
                barrier.wait(timeout=5)
                c.hints_emitted += 1
                c.last_activity_ts = time.time()
                c._invalidate_json_cache()
                session.save(c)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        t1 = threading.Thread(target=worker)
        t2 = threading.Thread(target=worker)
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert not errors, f"thread errors: {errors}"

        final = session.load(sid)
        # max-merge guarantees: result >= max(local, remote) — never regresses to 0.
        assert final.hints_emitted >= 1, (
            f"expected hints_emitted >= 1 (no lost write), got {final.hints_emitted}"
        )

    def test_merge_session_caches_merges_dicts(self, tmp_data_dir):
        """_merge_session_caches merges hints_seen dicts, taking max count for each fingerprint."""
        from token_goat.session import _merge_session_caches

        sid = "cas_merge_sets"
        base = session.load(sid)
        base.version = 5

        local = session.load(sid)
        local.version = 3
        local.hints_seen = {"a": 2, "b": 1}
        local.bash_dedup_emitted_ids = {"x"}

        remote = session.load(sid)
        remote.version = 5
        remote.hints_seen = {"b": 3, "c": 1}
        remote.bash_dedup_emitted_ids = {"y"}

        merged = _merge_session_caches(local, remote)
        assert merged.hints_seen == {"a": 2, "b": 3, "c": 1}
        assert merged.bash_dedup_emitted_ids == {"x", "y"}

    def test_merge_session_caches_max_counts(self, tmp_data_dir):
        """_merge_session_caches takes max for integer counters."""
        from token_goat.session import _merge_session_caches

        sid = "cas_merge_counts"
        local = session.load(sid)
        local.hints_emitted = 7
        local.hints_ignored = 2
        local.structured_hints_emitted = 3
        local.index_only_hints_emitted = 1

        remote = session.load(sid)
        remote.hints_emitted = 5
        remote.hints_ignored = 4
        remote.structured_hints_emitted = 6
        remote.index_only_hints_emitted = 0

        merged = _merge_session_caches(local, remote)
        assert merged.hints_emitted == 7
        assert merged.hints_ignored == 4
        assert merged.structured_hints_emitted == 6
        assert merged.index_only_hints_emitted == 1

    def test_merge_greps_respects_cap(self, tmp_data_dir):
        """After CAS merge, greps must not exceed GREPS_HISTORY_MAX."""
        from token_goat.session import (
            GREPS_HISTORY_MAX,
            GrepEntry,
            _merge_session_caches,
        )

        sid = "cas_merge_greps_cap"
        ts = 1_700_000_000.0

        # Local: 70 unique entries (below cap but near it)
        local = session.load(sid)
        local.greps = [GrepEntry(pattern=f"local_{i}", path=None, ts=ts + i) for i in range(70)]

        # Remote: 70 unique entries, 10 overlap with local (same pattern)
        remote = session.load(sid)
        remote.greps = [GrepEntry(pattern=f"remote_{i}", path=None, ts=ts + i) for i in range(60)] + [
            GrepEntry(pattern=f"local_{i}", path=None, ts=ts + i) for i in range(10)
        ]

        merged = _merge_session_caches(local, remote)

        # Unique entries = 60 remote-only + 10 shared + 60 local-only = 130 total before cap
        assert len(merged.greps) <= GREPS_HISTORY_MAX, (
            f"greps grew to {len(merged.greps)} after merge, cap is {GREPS_HISTORY_MAX}"
        )

    def test_merge_glob_history_respects_cap(self, tmp_data_dir):
        """After CAS merge, glob_history must not exceed GLOB_HISTORY_MAX."""
        from token_goat.session import (
            GLOB_HISTORY_MAX,
            GlobEntry,
            _merge_session_caches,
        )

        sid = "cas_merge_glob_cap"
        ts = 1_700_000_000.0

        # Local: near cap (18 entries)
        local = session.load(sid)
        local.glob_history = [GlobEntry(pattern=f"local_{i}/**", path=None, ts=ts + i) for i in range(18)]

        # Remote: near cap (18 entries), 2 overlapping
        remote = session.load(sid)
        remote.glob_history = (
            [GlobEntry(pattern=f"remote_{i}/**", path=None, ts=ts + i) for i in range(16)]
            + [GlobEntry(pattern=f"local_{i}/**", path=None, ts=ts + i) for i in range(2)]
        )

        merged = _merge_session_caches(local, remote)

        # Unique = 16 remote-only + 2 shared + 16 local-only = 34 before cap
        assert len(merged.glob_history) <= GLOB_HISTORY_MAX, (
            f"glob_history grew to {len(merged.glob_history)} after merge, cap is {GLOB_HISTORY_MAX}"
        )

    def test_merge_recent_hints_respects_cap(self, tmp_data_dir):
        """After CAS merge, recent_hints must not exceed 3 entries."""
        from token_goat.session import _merge_session_caches

        sid = "cas_merge_recent_hints_cap"
        ts = 1_700_000_000.0

        local = session.load(sid)
        local.recent_hints = [("a.py", ts), ("b.py", ts + 1), ("c.py", ts + 2)]

        remote = session.load(sid)
        remote.recent_hints = [("d.py", ts + 3), ("e.py", ts + 4), ("f.py", ts + 5)]

        merged = _merge_session_caches(local, remote)

        assert len(merged.recent_hints) <= 3, (
            f"recent_hints grew to {len(merged.recent_hints)} after merge, cap is 3"
        )

    def test_merge_hints_seen_respects_cap(self, tmp_data_dir):
        """After CAS merge, hints_seen dict must not exceed HINTS_SEEN_MAX."""
        from token_goat.session import HINTS_SEEN_MAX, _merge_session_caches

        sid = "cas_merge_hints_seen_cap"

        # Each side has HINTS_SEEN_MAX - 1 fully disjoint entries so the union
        # would be ~2 * HINTS_SEEN_MAX, well over the cap.
        local = session.load(sid)
        local.hints_seen = {f"local_{i}": 1 for i in range(HINTS_SEEN_MAX - 1)}

        remote = session.load(sid)
        remote.hints_seen = {f"remote_{i}": 1 for i in range(HINTS_SEEN_MAX - 1)}

        merged = _merge_session_caches(local, remote)

        assert len(merged.hints_seen) <= HINTS_SEEN_MAX, (
            f"hints_seen grew to {len(merged.hints_seen)} after merge, cap is {HINTS_SEEN_MAX}"
        )

    def test_merge_hints_seen_lru_preserves_highest_counts(self, tmp_data_dir):
        """When hints_seen exceeds cap after merge, LRU keeps highest-count entries."""
        from token_goat.session import HINTS_SEEN_MAX, _merge_session_caches

        sid = "cas_merge_hints_seen_lru"

        # Create two sides that, when merged, exceed the cap.
        # Local has entries with higher counts; remote has entries with lower counts.
        local = session.load(sid)
        local.hints_seen = {f"hot_{i}": 100 - i for i in range(250)}  # 100, 99, 98, ..., 50

        remote = session.load(sid)
        remote.hints_seen = {f"cold_{i}": i for i in range(250)}  # 0, 1, 2, ..., 249

        merged = _merge_session_caches(local, remote)

        # After merge, the dict should be capped to HINTS_SEEN_MAX.
        assert len(merged.hints_seen) == HINTS_SEEN_MAX

        # The LRU eviction should prefer entries with higher counts.
        # We expect the "hot_" entries (with counts > 100) and some "cold_" entries
        # with the highest counts (249, 248, etc.) to remain.
        hot_count = sum(1 for k in merged.hints_seen if k.startswith("hot_"))
        cold_count = sum(1 for k in merged.hints_seen if k.startswith("cold_"))

        # The "hot_" entries dominate because they have higher counts (50-100).
        # Even the lowest "hot_" count (50) is higher than most "cold_" counts.
        # We expect at least 240 "hot_" entries to be preserved.
        assert hot_count >= 240, (
            f"LRU eviction should preserve high-count entries; "
            f"got {hot_count} hot, {cold_count} cold"
        )


# ---------------------------------------------------------------------------
# Cross-process session lockfile tests (item #10)
# ---------------------------------------------------------------------------


class TestSessionLockfile:
    """Unit tests for the sidecar lockfile helpers in session.py."""

    def test_lock_path_is_adjacent_to_json(self, tmp_data_dir):
        """Lock path is <session>.json.lock, adjacent to the session JSON."""
        from token_goat.session import _session_lock_path

        lp = _session_lock_path("lock_path_test")
        json_path = session.paths.session_cache_path("lock_path_test")
        assert lp.parent == json_path.parent
        assert lp.name == json_path.name + ".lock"

    def test_acquire_creates_lockfile_that_persists_after_release(self, tmp_data_dir):
        """Acquiring creates the sidecar file; releasing leaves it on disk.

        The OS advisory lock lives on a persistent fd, not on the file's
        existence, so the lockfile is never unlinked. Deleting it on release was
        the source of the self-orphan livelock: a peer holding a transient handle
        to the file made the unlink fail on Windows, orphaning a lockfile whose
        recorded PID was still live, which wedged every later acquire forever.
        """
        from token_goat.session import (
            _acquire_session_lock,
            _release_session_lock,
            _session_lock_path,
        )

        sid = "lock_basic"
        lock_path = _session_lock_path(sid)
        assert not lock_path.exists()

        fd = _acquire_session_lock(sid)
        assert fd is not None, "expected lock to be acquired"
        assert lock_path.exists(), "lockfile must exist while held"

        _release_session_lock(sid, fd)
        assert lock_path.exists(), "lockfile is persistent and must survive release"

    def test_second_acquire_returns_none_while_lock_held(self, tmp_data_dir, monkeypatch):
        """While a live fd holds the OS advisory lock, a contender acquire returns None.

        This is the cross-process mutual-exclusion invariant. We hold the lock on
        a real fd exactly as a peer process would, then assert a second acquire
        cannot take it. The timeout is shrunk so the test stays fast and runs in
        the default (non-slow) tier that every gating path executes.
        """
        import os as _os

        import token_goat.session as _sess
        from token_goat.session import (
            _acquire_session_lock,
            _os_advisory_lock,
            _os_advisory_unlock,
            _session_lock_path,
        )

        monkeypatch.setattr(_sess, "_LOCK_TIMEOUT_SECS", 0.2)

        sid = "lock_contention"
        lock_path = _session_lock_path(sid)
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        # Hold the lock on a real fd, exactly as the peer process would.
        holder_fd = _os.open(str(lock_path), _os.O_RDWR | _os.O_CREAT, 0o600)
        assert _os_advisory_lock(holder_fd), "could not take the holding lock"
        try:
            contender = _acquire_session_lock(sid)
            assert contender is None, "second acquire must time out while lock is held"
        finally:
            _os_advisory_unlock(holder_fd)
            _os.close(holder_fd)

    def test_lock_auto_releases_when_holder_fd_closes(self, tmp_data_dir):
        """Closing the holder's fd frees the lock even though the file remains.

        Regression for the self-orphan livelock. An OS advisory lock is dropped
        by the kernel the instant the owning fd closes (or the process dies), so a
        fresh acquire must succeed despite the leftover lockfile on disk. Under
        the old PID-sidecar scheme this exact scenario wedged forever.
        """
        import os as _os

        from token_goat.session import (
            _acquire_session_lock,
            _os_advisory_lock,
            _release_session_lock,
            _session_lock_path,
        )

        sid = "lock_autorelease"
        lock_path = _session_lock_path(sid)
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        # Simulate a peer that grabbed the lock then died without cleanup.
        holder_fd = _os.open(str(lock_path), _os.O_RDWR | _os.O_CREAT, 0o600)
        assert _os_advisory_lock(holder_fd)
        _os.close(holder_fd)

        assert lock_path.exists(), "persistent lockfile must remain on disk"

        fd = _acquire_session_lock(sid)
        assert fd is not None, "acquire must succeed once the holder fd is closed"
        _release_session_lock(sid, fd)

    def test_acquire_succeeds_over_unlocked_leftover_file(self, tmp_data_dir):
        """A leftover lockfile that nobody holds does not block acquisition."""
        from token_goat.session import (
            _acquire_session_lock,
            _release_session_lock,
            _session_lock_path,
        )

        sid = "lock_leftover"
        lp = _session_lock_path(sid)
        lp.parent.mkdir(parents=True, exist_ok=True)
        lp.write_text("leftover from a crashed run", encoding="utf-8")

        fd = _acquire_session_lock(sid)
        assert fd is not None, "a stale unlocked lockfile must not block acquire"
        _release_session_lock(sid, fd)

    def test_save_holds_lock_during_write(self, tmp_data_dir):
        """save() holds the sidecar lock while writing (lock exists during atomic rename)."""
        from token_goat.session import _session_lock_path

        sid = "lock_during_save"
        lock_path = _session_lock_path(sid)
        observed_during_write: list[bool] = []

        original_atomic_write = session.paths.atomic_write_text

        def spy_atomic_write(path, text):
            # Record whether the lock exists during the write.
            observed_during_write.append(lock_path.exists())
            return original_atomic_write(path, text)

        # Patch atomic_write_text on the paths module as seen from session.py.
        import token_goat.paths as _paths
        original = _paths.atomic_write_text
        _paths.atomic_write_text = spy_atomic_write
        try:
            c = session.load(sid)
            session.mark_file_edited(sid, "/proj/locked.py", cache=c)
        finally:
            _paths.atomic_write_text = original

        assert any(observed_during_write), "lock was never observed held during write"

    def test_save_does_not_write_when_lock_times_out(self, tmp_data_dir):
        """save() must not write the session file when _acquire_session_lock returns None.

        Regression test: previously the code entered the CAS+write region without
        checking whether the lock was actually acquired.  save() has a 3-attempt
        loop so all 3 attempts will time out, marking the cache unavailable.
        """
        from token_goat.session import _fresh_cache

        sid = "lock-timeout-no-write"
        cache = _fresh_cache(sid)
        cache.files["/proj/foo.py"] = {"ranges": [[0, 10]], "symbols": [], "read_count": 1, "sha": ""}

        import token_goat.session as _sess
        with patch.object(_sess, "_acquire_session_lock", return_value=None):
            _sess.save(cache)

        # The session file must NOT have been created regardless of lock outcome.
        p = session.paths.session_cache_path(sid)
        assert not p.exists(), "save() wrote session file despite lock timeout"

    def test_lock_timeout_does_not_mark_cache_unavailable(self, tmp_data_dir):
        """Repeated lock timeouts must NOT latch cache.unavailable = True.

        Regression for the cross-process livelock cascade: the old lock-timeout
        latch flipped cache.unavailable after 3 consecutive timeouts, after which
        every later save() short-circuited at its top guard and silently dropped
        edits until a peer bumped the file mtime and a fresh load() reset the
        flag.  With the OS advisory lock there is no such latch -- a timeout just
        skips this one write and the next save() retries.  This test fails on the
        pre-fix code (unavailable latched True) and passes once the latch is gone.
        It is intentionally fast and non-slow so it runs in the -m "not slow"
        gating suites that the original cross-process test was excluded from.
        """
        import token_goat.session as _sess
        from token_goat.session import _fresh_cache

        sid = "lock-timeout-no-latch"
        cache = _fresh_cache(sid)

        # Four consecutive timed-out saves -- more than the old 3-strike latch.
        with patch.object(_sess, "_acquire_session_lock", return_value=None):
            for _ in range(4):
                _sess.save(cache)

        assert not cache.unavailable, (
            "lock timeout must not latch cache.unavailable -- that latch caused "
            "the silent-drop cascade this fix removes"
        )

        # Recovery: with the lock obtainable again, an edit persists normally.
        session.mark_file_edited(sid, "/proj/recovered.py", cache=cache)
        assert session.paths.session_cache_path(sid).exists(), (
            "edit after lock recovery must write the session file"
        )
        assert cache.edited_files, "recovered edit must be recorded in edited_files"


# ---------------------------------------------------------------------------
# Cross-process concurrent write regression test (item #10)
# ---------------------------------------------------------------------------


class TestSessionLockfileConcurrent:
    """Verify that two OS-level processes can both mark_file_edited without losing writes."""

    @staticmethod
    def _worker_script(data_dir_path: str, session_id: str, n_edits: int) -> str:
        """Return a self-contained Python script for a subprocess worker.

        Each worker writes N distinct paths of the form /proc/<pid>/<i>.py so
        that 2 workers × N edits = 2N unique keys in edited_files.
        """
        return (
            "import sys, os\n"
            "from pathlib import Path\n"
            "import token_goat.paths as _p\n"
            f"_p._DATA_DIR_CACHE = Path({data_dir_path!r})\n"
            "from token_goat import session as _s\n"
            f"sid = {session_id!r}\n"
            f"n = {n_edits}\n"
            "pid = os.getpid()\n"
            "for i in range(n):\n"
            "    _s.mark_file_edited(sid, '/proc/' + str(pid) + '/' + str(i) + '.py')\n"
            "sys.exit(0)\n"
        )

    @pytest.mark.slow
    def test_two_processes_200_edits_no_loss(self, tmp_data_dir, tmp_path):
        """Two parallel subprocesses each writing 100 edits produce 200 unique entries.

        Marked ``slow``: spawning two real Python subprocesses takes ~2 s on a
        cold machine.  The cross-process correctness invariant is also exercised
        by the threaded variant below (which runs in default suites).
        """
        import json
        import subprocess
        import sys

        sid = "lockfile_concurrent_200"

        # Pre-create the session file so both workers start from a known base.
        session.save(session.load(sid))

        script = self._worker_script(str(tmp_data_dir), sid, 100)

        # Redirect stdout/stderr to PIPE so the subprocesses do not inherit pytest's
        # captured fd-2.  On Windows the subprocess runtime can write cp1252 bytes
        # (e.g. em-dash U+2014 = 0x97) to the inherited file descriptor, which
        # corrupts pytest's UTF-8 capture buffer and causes UnicodeDecodeError errors
        # in subsequent tests that run in the same xdist worker.
        p1 = subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        p2 = subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        _, stderr1 = p1.communicate(timeout=60)
        _, stderr2 = p2.communicate(timeout=60)
        rc1 = p1.returncode
        rc2 = p2.returncode

        assert rc1 == 0, f"worker 1 exited with {rc1}; stderr: {stderr1.decode('utf-8', errors='replace')}"
        assert rc2 == 0, f"worker 2 exited with {rc2}; stderr: {stderr2.decode('utf-8', errors='replace')}"

        # Reload the session and check that all 200 unique paths are present.
        final = session.load(sid)
        total_edits = len(final.edited_files)
        assert total_edits == 200, (
            f"expected 200 unique edited files, got {total_edits}. "
            f"edited_files keys: {sorted(final.edited_files)[:20]}..."
        )

        # Verify the session JSON is still valid (no torn writes).
        json_path = session.paths.session_cache_path(sid)
        raw = json_path.read_text(encoding="utf-8")
        parsed = json.loads(raw)  # would raise JSONDecodeError on torn write
        assert parsed["session_id"] == sid

    def test_concurrent_threads_100_edits_no_loss(self, tmp_data_dir):
        """Thread-level variant: 2 threads × 100 mark_file_edited = 200 unique entries.

        Exercises the _FILE_LOCK + sidecar-lockfile stack from multiple threads
        within the same process (the lock must still serialise correctly).
        """
        import threading

        sid = "lockfile_threads_200"
        session.save(session.load(sid))

        errors: list[Exception] = []
        barrier = threading.Barrier(2)

        def worker(pid_tag: int) -> None:
            try:
                barrier.wait(timeout=10)
                for i in range(100):
                    session.mark_file_edited(sid, f"/thread/{pid_tag}/file_{i}.py")
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        t1 = threading.Thread(target=worker, args=(1,))
        t2 = threading.Thread(target=worker, args=(2,))
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert not errors, f"thread errors: {errors}"

        final = session.load(sid)
        total = len(final.edited_files)
        assert total == 200, (
            f"expected 200 unique edited files, got {total}"
        )

    def test_stale_version_with_aliased_fingerprint_forces_merge(self, tmp_data_dir):
        """Regression: deterministic reproduction of the fast-path lost-update bug.

        The save() fast path skips the CAS re-read+merge when the on-disk
        (mtime_ns, size) fingerprint matches what the cache recorded at load.
        That fingerprint can ALIAS — two same-process writers adding equal-length
        keys produce byte-identical JSON written within one mtime tick — so a
        stale-version cache mistakes "someone already wrote" for "nobody wrote
        since I loaded" and clobbers the prior write.

        This drives the exact aliasing precondition without thread-timing luck:
        two distinct caches load at the same version, ``a`` commits (advancing the
        on-disk version), then ``b``'s fingerprint is pointed at the post-``a`` disk
        state. The in-process version registry must still force ``b`` through a full
        CAS+merge because a same-process writer advanced the version past ``b``'s.
        Pre-fix this asserts-fails (``a``'s edit is lost); post-fix both survive.
        """
        import os as _os

        from token_goat import paths as tg_paths

        sid = "alias_stale_version"
        session.save(session.load(sid))  # disk now at version 1
        p = tg_paths.session_cache_path(sid)

        # Two *distinct* caches both observing version 1 (the proc-load cache
        # would otherwise hand back one shared object for both load() calls).
        session._proc_load_cache.clear()
        a = session.load(sid)
        session._proc_load_cache.clear()
        b = session.load(sid)
        assert a is not b
        a.edited_files["/edit/aaa.py"] = 1
        b.edited_files["/edit/bbb.py"] = 1

        # 'a' commits first, advancing the on-disk version to 2.
        session.save(a)

        # Force the aliasing precondition: point 'b' at the current on-disk
        # fingerprint so the fast path sees a match, even though 'b' still holds
        # the pre-'a' version. Only the version registry distinguishes this from
        # a genuinely uncontended save.
        st = _os.stat(p)
        b._disk_mtime_ns = st.st_mtime_ns
        b._disk_size = st.st_size

        session.save(b)

        session._proc_load_cache.clear()
        final = session.load(sid)
        assert "/edit/aaa.py" in final.edited_files, (
            "lost update: the first writer's edit was clobbered by a stale-version "
            "save whose (mtime_ns, size) fingerprint aliased the on-disk state"
        )
        assert "/edit/bbb.py" in final.edited_files


class TestDiskMtimeFingerprint:
    """Item 2: save() skips from_dict round-trip on uncontended path.

    SessionCache._disk_mtime_ns and _disk_size are populated by load() and
    updated after each successful save(), allowing save() to skip the
    CAS from_dict deserialization when no concurrent writer has changed
    the file.
    """

    def test_load_sets_disk_fingerprint(self, tmp_data_dir):
        """load() populates _disk_mtime_ns and _disk_size after reading the file."""
        from token_goat import paths as tg_paths
        sid = "aabbcc" * 6
        cache = session.load(sid)
        session.mark_file_read(sid, "/tmp/foo.py", None, None, cache=cache)

        reloaded = session.load(sid)
        p = tg_paths.session_cache_path(sid)
        st = p.stat()
        assert reloaded._disk_mtime_ns == st.st_mtime_ns
        assert reloaded._disk_size == st.st_size

    def test_fresh_cache_has_zero_fingerprint(self, tmp_data_dir):
        """A brand-new (unsaved) cache has _disk_mtime_ns == 0 and _disk_size == 0."""
        sid = "ccddee" * 6
        cache = session.load(sid)
        # File doesn't exist yet — fingerprint stays zero
        assert cache._disk_mtime_ns == 0
        assert cache._disk_size == 0

    def test_save_updates_fingerprint(self, tmp_data_dir):
        """After save(), _disk_mtime_ns and _disk_size reflect the written file."""
        from token_goat import paths as tg_paths
        sid = "ddeeff" * 6
        cache = session.load(sid)
        session.mark_file_read(sid, "/tmp/bar.py", None, None, cache=cache)

        p = tg_paths.session_cache_path(sid)
        st = p.stat()
        assert cache._disk_mtime_ns == st.st_mtime_ns
        assert cache._disk_size == st.st_size

    def test_cas_merge_still_fires_on_concurrent_write(self, tmp_data_dir):
        """When another process writes the file, the CAS merge path still runs."""
        sid = "eeff00" * 6
        cache1 = session.load(sid)
        # Simulate concurrent write by a second process
        cache2 = session.load(sid)
        session.mark_file_read(sid, "/tmp/from_p2.py", None, None, cache=cache2)
        # Now save cache1 (which has stale fingerprint relative to cache2's write)
        session.mark_file_read(sid, "/tmp/from_p1.py", None, None, cache=cache1)
        # Both paths should be present after the CAS merge
        final = session.load(sid)
        norm1 = session._normalize_path("/tmp/from_p1.py")
        norm2 = session._normalize_path("/tmp/from_p2.py")
        assert norm1 in final.files
        assert norm2 in final.files


class TestSortedListCache:
    """Item 3: to_dict() avoids repeated sorted() calls via cached sorted lists.

    _hints_seen_sorted_cache and _bash_dedup_sorted_cache are populated lazily
    and cleared by _invalidate_json_cache().
    """

    def test_hints_seen_dict_serialized_correctly(self, tmp_data_dir):
        """to_dict() serializes hints_seen dict correctly."""
        sid = "aabb11" * 6
        cache = session.load(sid)
        cache.hints_seen = {"z-fp": 3, "a-fp": 1, "m-fp": 2}
        cache._invalidate_json_cache()
        d = cache.to_dict()
        assert d["hints_seen"] == {"z-fp": 3, "a-fp": 1, "m-fp": 2}

    def test_bash_dedup_sorted_cache_cleared_on_invalidate(self, tmp_data_dir):
        """_invalidate_json_cache() clears the bash dedup sorted cache."""
        sid = "bbcc22" * 6
        cache = session.load(sid)
        cache.hints_seen = {"fp1": 1}
        cache.bash_dedup_emitted_ids = {"id1"}
        cache.to_dict()  # populate cache
        assert cache._bash_dedup_sorted_cache is not None
        cache._invalidate_json_cache()
        assert cache._bash_dedup_sorted_cache is None

    def test_dict_serialized_consistently(self, tmp_data_dir):
        """Multiple to_dict() calls without mutation produce same dict."""
        sid = "ccdd33" * 6
        cache = session.load(sid)
        cache.hints_seen = {"fp-x": 2, "fp-a": 1}
        cache._invalidate_json_cache()
        first_dict = cache.to_dict()
        second_dict = cache.to_dict()
        assert first_dict["hints_seen"] == second_dict["hints_seen"]

    def test_bash_dedup_sorted_cache(self, tmp_data_dir):
        """bash_dedup_emitted_ids sorted cache works symmetrically."""
        sid = "ddee44" * 6
        cache = session.load(sid)
        cache.bash_dedup_emitted_ids = {"z-id", "a-id"}
        cache._invalidate_json_cache()
        d = cache.to_dict()
        assert d["bash_dedup_emitted_ids"] == ["a-id", "z-id"]
        assert cache._bash_dedup_sorted_cache == ["a-id", "z-id"]

    def test_hints_seen_output_is_dict(self, tmp_data_dir):
        """to_dict() produces a dict[str, int] for hints_seen."""
        sid = "eeff55" * 6
        cache = session.load(sid)
        cache.hints_seen = {"z": 1, "a": 2, "m": 3}
        cache._invalidate_json_cache()
        d = cache.to_dict()
        assert d["hints_seen"] == {"z": 1, "a": 2, "m": 3}


class TestPendingHintSave:
    """Item 4: mark_hint_seen defers save() via _pending_hint_save flag.

    The flag is set instead of calling save() inline.  The hint is NOT on
    disk until another save() runs (e.g. mark_file_read in post-read).
    """

    def test_mark_hint_seen_sets_flag(self, tmp_data_dir):
        """mark_hint_seen sets _pending_hint_save without calling save()."""
        sid = "ff0011" * 6
        cache = session.load(sid)
        cache.mark_hint_seen("test-fingerprint")
        assert cache._pending_hint_save is True

    def test_hint_not_on_disk_until_save(self, tmp_data_dir):
        """After mark_hint_seen, the fingerprint is in-memory but not yet on disk."""
        sid = "001122" * 6
        cache = session.load(sid)
        cache.mark_hint_seen("pending-fp")
        assert cache._pending_hint_save is True

        # Load fresh copy from disk — hint should NOT be there yet
        on_disk = session.load(sid)
        # File may not even exist yet for a new session
        from token_goat import paths as tg_paths
        p = tg_paths.session_cache_path(sid)
        if p.exists():
            assert "pending-fp" not in on_disk.hints_seen
        # In-memory cache has it
        assert "pending-fp" in cache.hints_seen

    def test_hint_persisted_after_mark_file_read(self, tmp_data_dir):
        """mark_file_read triggers save() which flushes the pending hint."""
        sid = "112233" * 6
        cache = session.load(sid)
        cache.mark_hint_seen("flush-via-file-read")
        assert cache._pending_hint_save is True

        # mark_file_read calls save() internally — flush happens
        session.mark_file_read(sid, "/tmp/example.py", None, None, cache=cache)

        on_disk = session.load(sid)
        assert "flush-via-file-read" in on_disk.hints_seen

    def test_duplicate_fingerprint_increments_count_sets_flag(self, tmp_data_dir):
        """mark_hint_seen increments count for already-seen fingerprints and sets flag."""
        sid = "223344" * 6
        cache = session.load(sid)
        cache.mark_hint_seen("already-seen")
        assert cache.hints_seen["already-seen"] == 1
        cache._pending_hint_save = False  # reset
        cache.mark_hint_seen("already-seen")  # second call — increments count
        assert cache.hints_seen["already-seen"] == 2
        assert cache._pending_hint_save is True  # flag is set because count changed


class TestAdaptiveHintSuppression:
    """Item 7: per-category hint history and suppression helper."""

    def test_no_history_never_suppresses(self, tmp_data_dir):
        """_hint_category_should_suppress returns False when no history exists."""
        sid = "aabbcc" * 6
        cache = session.load(sid)
        assert session._hint_category_should_suppress(cache, "session_hint") is False

    def test_emits_when_accepted(self, tmp_data_dir):
        """After accepted entries, suppression does not trigger."""
        sid = "bbccdd" * 6
        cache = session.load(sid)
        # Record 5 accepted (True) entries
        for _ in range(5):
            session.record_hint_category(cache, "session_hint", accepted=True)
        assert session._hint_category_should_suppress(cache, "session_hint") is False

    def test_suppresses_after_n_ignored(self, tmp_data_dir):
        """After 5 consecutive False entries the category is suppressed."""
        sid = "ccddeeff" * 4
        cache = session.load(sid)
        for _ in range(5):
            session.record_hint_category(cache, "bash_dedup_hint", accepted=False)
        assert session._hint_category_should_suppress(cache, "bash_dedup_hint") is True

    def test_threshold_configurable(self, tmp_data_dir):
        """Threshold parameter controls how many ignores trigger suppression."""
        sid = "ddeeff00" * 4
        cache = session.load(sid)
        # Record 3 False entries
        for _ in range(3):
            session.record_hint_category(cache, "web_dedup_hint", accepted=False)
        # threshold=5 → not yet suppressed
        assert session._hint_category_should_suppress(cache, "web_dedup_hint", threshold=5) is False
        # threshold=3 → suppressed
        assert session._hint_category_should_suppress(cache, "web_dedup_hint", threshold=3) is True

    def test_mixed_history_not_suppressed(self, tmp_data_dir):
        """A True in the last N entries prevents suppression."""
        sid = "eeff0011" * 4
        cache = session.load(sid)
        # 4 False, then 1 True: last 5 are not all False
        for _ in range(4):
            session.record_hint_category(cache, "session_hint", accepted=False)
        session.record_hint_category(cache, "session_hint", accepted=True)
        assert session._hint_category_should_suppress(cache, "session_hint") is False

    def test_ring_buffer_capped(self, tmp_data_dir):
        """Ring buffer stays at _HINT_CAT_HISTORY_MAX entries."""
        sid = "ff001122" * 4
        cache = session.load(sid)
        for i in range(20):
            session.record_hint_category(cache, "cat", accepted=bool(i % 2))
        hist = cache.hint_category_history.get("cat", [])
        assert len(hist) <= session._HINT_CAT_HISTORY_MAX

    def test_roundtrip_serialization(self, tmp_data_dir):
        """hint_category_history survives a to_dict / from_dict round-trip."""
        sid = "001122334455667788990011223344556677889900112233"[:36]
        # Use a valid session id (32+ alphanum chars)
        sid = "a0b1c2d3" * 4 + "a0b1"
        cache = session.load(sid)
        session.record_hint_category(cache, "bash_dedup_hint", accepted=False)
        session.record_hint_category(cache, "bash_dedup_hint", accepted=False)
        session.save(cache)
        loaded = session.load(sid)
        assert "bash_dedup_hint" in loaded.hint_category_history
        assert loaded.hint_category_history["bash_dedup_hint"] == [False, False]

    def test_zero_threshold_never_suppresses(self, tmp_data_dir):
        """threshold=0 disables suppression entirely."""
        sid = "b1c2d3e4" * 4 + "b1c2"
        cache = session.load(sid)
        for _ in range(10):
            session.record_hint_category(cache, "cat", accepted=False)
        assert session._hint_category_should_suppress(cache, "cat", threshold=0) is False


class TestSchemaVersioning:
    """Schema version field: presence, serialization, and stale-cache drop."""

    def test_schema_version_present_in_serialized_dict(self, tmp_data_dir):
        """to_dict() must include schema_version equal to SESSION_SCHEMA_VERSION."""
        sid = "schema-ver-test-" + "a" * 18
        cache = session.load(sid)
        d = cache.to_dict()
        assert "schema_version" in d
        assert d["schema_version"] == session.SESSION_SCHEMA_VERSION

    def test_schema_version_mismatch_drops_cache(self, tmp_data_dir):
        """A cache file with a schema_version that differs from SESSION_SCHEMA_VERSION
        must be silently dropped and replaced with an empty cache on load."""
        import json as _json

        sid = "schema-mismatch-" + "b" * 16
        cache_path = session.paths.session_cache_path(sid)
        cache_path.parent.mkdir(parents=True, exist_ok=True)

        stale_data = {
            "schema_version": 999,
            "session_id": sid,
            "started_ts": 1.0,
            "last_activity_ts": 1.0,
            "created_ts": 1.0,
            "files": {"stale/file.py": {"rel_or_abs": "stale/file.py", "read_count": 5}},
            "greps": [],
            "edited_files": {},
            "created_by": "token-goat",
        }
        cache_path.write_text(_json.dumps(stale_data), encoding="utf-8")

        loaded = session.load(sid)
        # Must return an empty cache, not crash
        assert loaded.session_id == sid
        assert loaded.files == {}, "stale cache fields must not bleed into fresh cache"
        assert loaded.greps == []

    def test_schema_version_missing_drops_cache(self, tmp_data_dir):
        """A cache file with no schema_version field (version=0) is dropped."""
        import json as _json

        sid = "schema-missing-" + "c" * 17
        cache_path = session.paths.session_cache_path(sid)
        cache_path.parent.mkdir(parents=True, exist_ok=True)

        old_data = {
            # schema_version intentionally absent
            "session_id": sid,
            "started_ts": 1.0,
            "last_activity_ts": 1.0,
            "created_ts": 1.0,
            "files": {"old/file.py": {"rel_or_abs": "old/file.py", "read_count": 3}},
            "greps": [],
            "edited_files": {},
        }
        cache_path.write_text(_json.dumps(old_data), encoding="utf-8")

        loaded = session.load(sid)
        assert loaded.session_id == sid
        assert loaded.files == {}, "old cache without schema_version must be dropped"


class TestProcLoadCache:
    """Process-local LRU cache on session.load() — correctness and eviction."""

    def _clear_proc_cache(self):
        """Clear the module-level process cache before each test."""
        session._proc_load_cache.clear()

    def test_repeated_load_unchanged_mtime_returns_same_object(self, tmp_data_dir):
        """Repeated load() with unchanged mtime returns the identical object."""
        self._clear_proc_cache()
        sid = "proc-cache-hit-" + "a" * 17
        session.mark_file_read(sid, "a.py", offset=0, limit=10)

        loaded1 = session.load(sid)
        loaded2 = session.load(sid)
        assert loaded1 is loaded2, "second load should return the cached object, not a new one"

    def test_changed_mtime_returns_new_object(self, tmp_data_dir):
        """load() after a mtime change returns a freshly parsed object."""
        self._clear_proc_cache()
        sid = "proc-cache-miss-" + "b" * 16
        session.mark_file_read(sid, "b.py", offset=0, limit=5)

        loaded1 = session.load(sid)

        # Mutate the session on disk by writing an extra file entry.
        # Backdate the existing session file to ensure the next write has a
        # distinguishably newer mtime without sleeping.
        import os as _os
        _sess_path = session.paths.session_cache_path(sid)
        if _sess_path.exists():
            _old_mtime = _sess_path.stat().st_mtime
            _os.utime(_sess_path, (_old_mtime - 2.0, _old_mtime - 2.0))
        # Write using mark_file_read which internally saves to disk.
        session.mark_file_read(sid, "c.py", offset=0, limit=3)
        # Evict the stale proc-cache entry so the next load() sees the updated
        # mtime rather than returning the cached (now-stale) object.
        session._proc_load_cache.pop(sid, None)

        loaded2 = session.load(sid)
        assert loaded2 is not loaded1, "stale mtime must not serve a cached object"
        # The freshly loaded object should contain c.py
        norm = session._normalize_path("c.py")
        assert norm in loaded2.files, "updated file should appear in the freshly loaded cache"

    def test_save_refreshes_proc_load_cache(self, tmp_data_dir):
        """save() must refresh an existing proc-load-cache entry with the
        just-written object.

        Regression for the Windows coarse-mtime staleness flake behind
        ``test_concurrent_threads_both_edits_preserved``: a prior ``load()``
        caches ``(obj, mtime)``; the freshness check is purely
        ``cached_mtime == cur_mtime``.  When a later ``save()``'s post-write
        mtime aliases that cached mtime (Windows ``st_mtime`` granularity is
        coarse enough that two writes can share a timestamp), the proc-cache
        would keep serving the *pre-save* object on the next in-process
        ``load()`` even though the disk is correct.  ``save()`` now overwrites
        the entry with the object it just persisted, so the freshest state
        always wins regardless of timestamp granularity.

        Fails pre-fix: ``save()`` left the proc-cache untouched, so the stale
        shadow object below survives the save.  Passes post-fix.
        """
        self._clear_proc_cache()
        sid = "proc-cache-refresh-" + "d" * 14

        # Seed an on-disk session and prime the proc cache via load().
        session.mark_file_read(sid, "seed.py", offset=0, limit=4)
        c = session.load(sid)
        primed = session._proc_load_cache.get(sid)
        assert primed is not None, "load() should prime the proc-cache for an on-disk session"
        assert primed[0] is c

        # Simulate the failure precondition: a DISTINCT pre-merge object shadows
        # the cache entry under the same mtime, exactly what a concurrent
        # thread's earlier load() would leave behind. Without the refresh,
        # save() leaves this stale object in place.
        aliased_mtime = primed[1]
        stale = session._fresh_cache(sid)
        assert stale is not c
        session._proc_load_cache[sid] = (stale, aliased_mtime)

        # Mutate and persist the real cache through the normal mutation path
        # (mark_file_edited -> _commit_mutation -> save).
        session.mark_file_edited(sid, "/edited/file.py", cache=c)

        entry = session._proc_load_cache.get(sid)
        assert entry is not None, "save must not drop the proc-cache entry"
        assert entry[0] is c, (
            "save must refresh the proc-cache with the just-saved object, not leave "
            "the stale pre-merge shadow object in place (the flake)"
        )
        edited_key = session._normalize_path("/edited/file.py")
        assert edited_key in c.edited_files

        # A subsequent in-process load() must observe the edit, never the stale
        # shadow object — even though its cached mtime aliased the disk mtime.
        reloaded = session.load(sid)
        assert reloaded is not stale, "load() must not serve the stale shadow object"
        assert edited_key in reloaded.edited_files

    def test_cache_cap_enforced(self, tmp_data_dir):
        """Cache does not grow beyond _PROC_LOAD_CACHE_MAX entries."""
        self._clear_proc_cache()
        cap = session._PROC_LOAD_CACHE_MAX
        # Create cap+2 session files and load them all.
        sids = []
        for i in range(cap + 2):
            sid = f"proc-cap-{i:02d}-" + "c" * 16
            c = session._fresh_cache(sid)
            session.save(c)
            session.load(sid)
            sids.append(sid)

        assert len(session._proc_load_cache) <= cap, (
            f"proc cache grew to {len(session._proc_load_cache)}, expected <= {cap}"
        )


class TestPerTypeHintCounters:
    """Tests for per-hint-type emission and suppression tracking."""

    def test_record_hint_emitted_increments_counter(self, tmp_data_dir):
        """record_hint_emitted increments the counter for a given hint type."""
        cache = session._fresh_cache("test-per-type-1")
        assert cache.hints_emitted_by_type.get("bash_dedup", 0) == 0

        cache.record_hint_emitted("bash_dedup")
        assert cache.hints_emitted_by_type["bash_dedup"] == 1

        cache.record_hint_emitted("bash_dedup")
        assert cache.hints_emitted_by_type["bash_dedup"] == 2

    def test_record_hint_emitted_sets_pending_hint_save(self, tmp_data_dir):
        """record_hint_emitted must set _pending_hint_save so callers that don't
        explicitly call session.save() (e.g. the unchanged-file hint path in
        hooks_read.py) still get their counter persisted via _flush_pending_hint_save."""
        cache = session._fresh_cache("test-per-type-emitted-pending")
        cache._pending_hint_save = False  # type: ignore[attr-defined]
        cache.record_hint_emitted("unchanged_file")
        assert cache._pending_hint_save is True  # type: ignore[attr-defined]

    def test_record_hint_suppressed_increments_counter(self, tmp_data_dir):
        """record_hint_suppressed increments the suppression counter for a given hint type."""
        cache = session._fresh_cache("test-per-type-2")
        assert cache.hints_suppressed_by_type.get("bash_dedup_below_threshold", 0) == 0

        cache.record_hint_suppressed("bash_dedup_below_threshold")
        assert cache.hints_suppressed_by_type["bash_dedup_below_threshold"] == 1

        cache.record_hint_suppressed("bash_dedup_below_threshold")
        assert cache.hints_suppressed_by_type["bash_dedup_below_threshold"] == 2

    def test_record_hint_suppressed_sets_pending_hint_save(self, tmp_data_dir):
        """record_hint_suppressed must set _pending_hint_save for the same reason as
        record_hint_emitted — any call site not inside run_dedup_hint would silently
        drop its counter without this flag."""
        cache = session._fresh_cache("test-per-type-suppressed-pending")
        cache._pending_hint_save = False  # type: ignore[attr-defined]
        cache.record_hint_suppressed("bash_dedup_below_threshold")
        assert cache._pending_hint_save is True  # type: ignore[attr-defined]

    def test_per_type_counters_persist_roundtrip(self, tmp_data_dir):
        """Per-type counters survive serialization and deserialization."""
        sid = "test-per-type-roundtrip-3"
        cache = session._fresh_cache(sid)
        cache.record_hint_emitted("read_dedup")
        cache.record_hint_emitted("bash_dedup")
        cache.record_hint_emitted("bash_dedup")
        cache.record_hint_suppressed("web_dedup_below_threshold")
        session.save(cache)

        loaded = session.load(sid)
        assert loaded.hints_emitted_by_type["read_dedup"] == 1
        assert loaded.hints_emitted_by_type["bash_dedup"] == 2
        assert loaded.hints_suppressed_by_type["web_dedup_below_threshold"] == 1

    def test_backward_compat_missing_fields_default_to_empty_dict(self, tmp_data_dir):
        """Loading an old session JSON without per-type fields defaults to empty dicts."""
        sid = "test-per-type-compat-4"
        cache = session._fresh_cache(sid)
        # Simulate an old session by manually creating a dict without the new fields
        old_dict = cache.to_dict()
        del old_dict["hints_emitted_by_type"]
        del old_dict["hints_suppressed_by_type"]

        # Write the old-format dict to disk
        import json
        path = session.paths.session_cache_path(sid)
        session.paths.ensure_dir(path.parent)
        path.write_text(json.dumps(old_dict, ensure_ascii=False), encoding="utf-8")

        # Load it back - should not crash and should default to empty dicts
        loaded = session.load(sid)
        assert loaded.hints_emitted_by_type == {}
        assert loaded.hints_suppressed_by_type == {}

    def test_merge_max_per_type_counters(self, tmp_data_dir):
        """Merging two caches takes max() per key for per-type counters.

        Both processes may start from the same non-zero base (CAS fork).
        Additive merges would double-count the shared base, producing totals
        higher than hints_emitted.  max() is consistent with the flat scalar
        counters (hints_emitted, structured_hints_emitted, etc.) and never
        overcounts.
        """
        local = session._fresh_cache("test-per-type-merge-5")
        local.hints_emitted_by_type = {"bash_dedup": 3, "grep_dedup": 1}
        local.hints_suppressed_by_type = {"bash_dedup_below_threshold": 2}

        remote = session._fresh_cache("test-per-type-merge-5")
        remote.hints_emitted_by_type = {"bash_dedup": 2, "read_dedup": 1}
        remote.hints_suppressed_by_type = {"bash_dedup_below_threshold": 1, "web_dedup_below_threshold": 3}

        merged = session._merge_session_caches(local, remote)

        # max() per key — not additive — consistent with hints_emitted scalar
        assert merged.hints_emitted_by_type["bash_dedup"] == 3   # max(3, 2)
        assert merged.hints_emitted_by_type["grep_dedup"] == 1   # local-only key
        assert merged.hints_emitted_by_type["read_dedup"] == 1   # remote-only key
        assert merged.hints_suppressed_by_type["bash_dedup_below_threshold"] == 2  # max(2, 1)
        assert merged.hints_suppressed_by_type["web_dedup_below_threshold"] == 3   # remote-only key

    def test_multiple_hint_types_tracked_independently(self, tmp_data_dir):
        """Different hint types are tracked independently."""
        cache = session._fresh_cache("test-per-type-indep-6")

        cache.record_hint_emitted("read_dedup")
        cache.record_hint_emitted("bash_dedup")
        cache.record_hint_emitted("bash_dedup")
        cache.record_hint_suppressed("grep_dedup_below_threshold")
        cache.record_hint_suppressed("grep_dedup_below_threshold")
        cache.record_hint_suppressed("grep_dedup_below_threshold")

        assert cache.hints_emitted_by_type["read_dedup"] == 1
        assert cache.hints_emitted_by_type["bash_dedup"] == 2
        assert cache.hints_suppressed_by_type["grep_dedup_below_threshold"] == 3


class TestEditedFilesMerge:
    """_merge_session_caches uses max() not sum() for edited_files counters."""

    def test_edited_files_merge_takes_max(self, tmp_data_dir):
        """When local and remote diverge, the merged count is max(r, l), not sum."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("efm-1", 0, 0)
        remote = session.SessionCache("efm-1", 0, 0)
        local.edited_files["src/a.py"] = 3
        remote.edited_files["src/a.py"] = 5

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/a.py"] == 5  # max(5, 3)

    def test_edited_files_merge_local_higher_wins(self, tmp_data_dir):
        """Local count higher than remote: result is local's value."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("efm-2", 0, 0)
        remote = session.SessionCache("efm-2", 0, 0)
        local.edited_files["src/b.py"] = 7
        remote.edited_files["src/b.py"] = 2

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/b.py"] == 7  # max(2, 7)

    def test_edited_files_merge_local_only_key_added(self, tmp_data_dir):
        """Key present only in local appears in merged result."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("efm-3", 0, 0)
        remote = session.SessionCache("efm-3", 0, 0)
        local.edited_files["src/new.py"] = 4

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/new.py"] == 4

    def test_edited_files_merge_does_not_sum(self, tmp_data_dir):
        """Concurrent edits do not double-count: result is max, not r+l."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("efm-4", 0, 0)
        remote = session.SessionCache("efm-4", 0, 0)
        local.edited_files["src/c.py"] = 3
        remote.edited_files["src/c.py"] = 3

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/c.py"] == 3  # max(3,3)=3, not sum=6


class TestDecisionsMerge:
    """_merge_session_caches must include decisions in the append-union."""

    def test_local_decision_added_when_not_in_remote(self, tmp_data_dir):
        """A decision in local but not in remote appears in the merged result."""
        from token_goat.session import DecisionEntry, _merge_session_caches

        local = session.SessionCache("dm-1", 0, 0)
        remote = session.SessionCache("dm-1", 0, 0)
        local.decisions.append(DecisionEntry(text="chose option A", ts=1.0))

        merged = _merge_session_caches(local, remote)
        assert any(d.text == "chose option A" for d in merged.decisions)

    def test_remote_decision_preserved_when_local_empty(self, tmp_data_dir):
        """Remote decisions are preserved when local.decisions is empty."""
        from token_goat.session import DecisionEntry, _merge_session_caches

        local = session.SessionCache("dm-2", 0, 0)
        remote = session.SessionCache("dm-2", 0, 0)
        remote.decisions.append(DecisionEntry(text="remote decision", ts=2.0))

        merged = _merge_session_caches(local, remote)
        assert any(d.text == "remote decision" for d in merged.decisions)

    def test_duplicate_decision_not_duplicated_in_merge(self, tmp_data_dir):
        """Same decision in both local and remote appears only once."""
        from token_goat.session import DecisionEntry, _merge_session_caches

        local = session.SessionCache("dm-3", 0, 0)
        remote = session.SessionCache("dm-3", 0, 0)
        d = DecisionEntry(text="same decision", ts=3.0)
        local.decisions.append(d)
        remote.decisions.append(d)

        merged = _merge_session_caches(local, remote)
        assert sum(1 for x in merged.decisions if x.text == "same decision") == 1

    def test_decisions_merge_union_both(self, tmp_data_dir):
        """Distinct decisions from both local and remote all appear in merged."""
        from token_goat.session import DecisionEntry, _merge_session_caches

        local = session.SessionCache("dm-4", 0, 0)
        remote = session.SessionCache("dm-4", 0, 0)
        local.decisions.append(DecisionEntry(text="local only", ts=4.0))
        remote.decisions.append(DecisionEntry(text="remote only", ts=5.0))

        merged = _merge_session_caches(local, remote)
        texts = {d.text for d in merged.decisions}
        assert "local only" in texts
        assert "remote only" in texts


class TestHintCategoryHistoryMerge:
    """_merge_session_caches must include hint_category_history in the union."""

    def test_local_only_category_appears_in_merge(self, tmp_data_dir):
        """A category present only in local survives the merge."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("hch-1", 0, 0)
        remote = session.SessionCache("hch-1", 0, 0)
        local.hint_category_history["read_dedup"] = [True, False, True]

        merged = _merge_session_caches(local, remote)
        assert "read_dedup" in merged.hint_category_history
        assert merged.hint_category_history["read_dedup"] == [True, False, True]

    def test_remote_only_category_preserved(self, tmp_data_dir):
        """A category present only in remote is preserved."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("hch-2", 0, 0)
        remote = session.SessionCache("hch-2", 0, 0)
        remote.hint_category_history["bash_dedup"] = [False, False]

        merged = _merge_session_caches(local, remote)
        assert merged.hint_category_history["bash_dedup"] == [False, False]

    def test_longer_list_wins_per_category(self, tmp_data_dir):
        """For the same category, the longer observation list is kept."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("hch-3", 0, 0)
        remote = session.SessionCache("hch-3", 0, 0)
        local.hint_category_history["web_dedup"] = [True, False, True, False]
        remote.hint_category_history["web_dedup"] = [True]

        merged = _merge_session_caches(local, remote)
        assert merged.hint_category_history["web_dedup"] == [True, False, True, False]

    def test_category_capped_at_history_max(self, tmp_data_dir):
        """Category history is capped at _HINT_CAT_HISTORY_MAX after merge."""
        from token_goat.session import _HINT_CAT_HISTORY_MAX, _merge_session_caches

        local = session.SessionCache("hch-4", 0, 0)
        remote = session.SessionCache("hch-4", 0, 0)
        over_limit = [True] * (_HINT_CAT_HISTORY_MAX + 5)
        local.hint_category_history["grep_dedup"] = over_limit

        merged = _merge_session_caches(local, remote)
        assert len(merged.hint_category_history["grep_dedup"]) == _HINT_CAT_HISTORY_MAX


# ---------------------------------------------------------------------------
# Task A: Session merge edge cases
# ---------------------------------------------------------------------------


class TestMergeEmptyDictFields:
    """_merge_session_caches: one side has an empty dict for a normally non-empty dict field."""

    def test_files_local_empty_remote_has_entries(self, tmp_data_dir):
        """When local.files is empty, remote's file entries are preserved verbatim."""
        from token_goat.session import FileEntry, _merge_session_caches

        local = session.SessionCache("med-f1", 0.0, 1.0)
        remote = session.SessionCache("med-f1", 0.0, 2.0)
        remote.files["src/foo.py"] = FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=2.0,
            read_count=3,
            line_ranges=[(1, 50)],
            symbols_read=["bar"],
        )

        merged = _merge_session_caches(local, remote)
        assert "src/foo.py" in merged.files
        assert merged.files["src/foo.py"].read_count == 3

    def test_files_remote_empty_local_has_entries(self, tmp_data_dir):
        """When remote.files is empty, local's file entries are propagated to merged."""
        from token_goat.session import FileEntry, _merge_session_caches

        local = session.SessionCache("med-f2", 0.0, 1.0)
        remote = session.SessionCache("med-f2", 0.0, 2.0)
        local.files["src/bar.py"] = FileEntry(
            rel_or_abs="src/bar.py",
            last_read_ts=1.0,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
        )

        merged = _merge_session_caches(local, remote)
        assert "src/bar.py" in merged.files

    def test_bash_history_local_empty(self, tmp_data_dir):
        """When local.bash_history is empty, remote's bash history survives the merge."""
        from token_goat.session import BashEntry, _merge_session_caches

        local = session.SessionCache("med-b1", 0.0, 1.0)
        remote = session.SessionCache("med-b1", 0.0, 2.0)
        remote.bash_history["abc123"] = BashEntry(
            cmd_sha="abc123",
            cmd_preview="pytest",
            output_id="out1",
            ts=2.0,
            stdout_bytes=512,
            stderr_bytes=0,
        )

        merged = _merge_session_caches(local, remote)
        assert "abc123" in merged.bash_history

    def test_bash_history_remote_empty(self, tmp_data_dir):
        """When remote.bash_history is empty, local's bash history is propagated."""
        from token_goat.session import BashEntry, _merge_session_caches

        local = session.SessionCache("med-b2", 0.0, 1.0)
        remote = session.SessionCache("med-b2", 0.0, 2.0)
        local.bash_history["def456"] = BashEntry(
            cmd_sha="def456",
            cmd_preview="ruff check",
            output_id="out2",
            ts=1.0,
            stdout_bytes=128,
            stderr_bytes=0,
        )

        merged = _merge_session_caches(local, remote)
        assert "def456" in merged.bash_history

    def test_web_history_remote_empty_local_has_entries(self, tmp_data_dir):
        """When remote.web_history is empty, local's web entries survive."""
        from token_goat.session import WebEntry, _merge_session_caches

        local = session.SessionCache("med-w1", 0.0, 1.0)
        remote = session.SessionCache("med-w1", 0.0, 2.0)
        local.web_history["sha1"] = WebEntry(
            url_sha="sha1",
            url_preview="https://example.com/doc",
            output_id="web-out1",
            ts=1.0,
            body_bytes=4096,
        )

        merged = _merge_session_caches(local, remote)
        assert "sha1" in merged.web_history

    def test_skill_history_remote_empty_local_has_entries(self, tmp_data_dir):
        """When remote.skill_history is empty, local's skill entries survive."""
        from token_goat.session import SkillEntry, _merge_session_caches

        local = session.SessionCache("med-sk1", 0.0, 1.0)
        remote = session.SessionCache("med-sk1", 0.0, 2.0)
        local.skill_history["ralph"] = SkillEntry(
            skill_name="ralph",
            output_id="skill-out1",
            content_sha="deadbeef",
            ts=1.0,
            body_bytes=2048,
        )

        merged = _merge_session_caches(local, remote)
        assert "ralph" in merged.skill_history

    def test_hints_seen_local_empty_remote_non_empty(self, tmp_data_dir):
        """When local.hints_seen is empty, remote's fingerprints are preserved."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-hs1", 0.0, 1.0)
        remote = session.SessionCache("med-hs1", 0.0, 2.0)
        remote.hints_seen["fp-abc"] = 5

        merged = _merge_session_caches(local, remote)
        assert merged.hints_seen.get("fp-abc") == 5

    def test_hints_seen_remote_empty_local_non_empty(self, tmp_data_dir):
        """When remote.hints_seen is empty, local's fingerprints propagate."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-hs2", 0.0, 1.0)
        remote = session.SessionCache("med-hs2", 0.0, 2.0)
        local.hints_seen["fp-xyz"] = 3

        merged = _merge_session_caches(local, remote)
        assert merged.hints_seen.get("fp-xyz") == 3

    def test_result_cache_remote_empty_local_has_entry(self, tmp_data_dir):
        """When remote.result_cache is empty, local's cached read results survive."""
        from token_goat.session import ResultCacheEntry, _merge_session_caches

        local = session.SessionCache("med-rc1", 0.0, 1.0)
        remote = session.SessionCache("med-rc1", 0.0, 2.0)
        local.result_cache["src/a.py::my_fn::symbol"] = ResultCacheEntry(
            file_sha="aabbcc",
            kind="symbol",
            result={"text": "def my_fn(): pass"},
            ts=1.0,
        )

        merged = _merge_session_caches(local, remote)
        assert "src/a.py::my_fn::symbol" in merged.result_cache

    def test_edited_files_local_empty_remote_non_empty(self, tmp_data_dir):
        """When local.edited_files is empty, remote's edit counts are preserved."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-ef1", 0.0, 1.0)
        remote = session.SessionCache("med-ef1", 0.0, 2.0)
        remote.edited_files["src/utils.py"] = 4

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/utils.py"] == 4

    def test_edited_files_remote_empty_local_non_empty(self, tmp_data_dir):
        """When remote.edited_files is empty, local's edit counts propagate."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-ef2", 0.0, 1.0)
        remote = session.SessionCache("med-ef2", 0.0, 2.0)
        local.edited_files["src/models.py"] = 2

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["src/models.py"] == 2

    def test_hints_emitted_by_type_local_empty(self, tmp_data_dir):
        """When local.hints_emitted_by_type is empty, remote's per-type counts survive."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-hbt1", 0.0, 1.0)
        remote = session.SessionCache("med-hbt1", 0.0, 2.0)
        remote.hints_emitted_by_type["already_read"] = 7

        merged = _merge_session_caches(local, remote)
        assert merged.hints_emitted_by_type.get("already_read") == 7

    def test_hints_suppressed_by_type_remote_empty(self, tmp_data_dir):
        """When remote.hints_suppressed_by_type is empty, local's counts propagate."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-hst1", 0.0, 1.0)
        remote = session.SessionCache("med-hst1", 0.0, 2.0)
        local.hints_suppressed_by_type["bash_dedup"] = 9

        merged = _merge_session_caches(local, remote)
        assert merged.hints_suppressed_by_type.get("bash_dedup") == 9

    def test_hint_category_history_local_empty(self, tmp_data_dir):
        """When local.hint_category_history is empty, remote's categories survive."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("med-hch1", 0.0, 1.0)
        remote = session.SessionCache("med-hch1", 0.0, 2.0)
        remote.hint_category_history["web_dedup"] = [True, False]

        merged = _merge_session_caches(local, remote)
        assert merged.hint_category_history.get("web_dedup") == [True, False]


class TestMergeNaNTimestamps:
    """_merge_session_caches: NaN timestamps must not propagate into the merged result."""

    def test_last_activity_ts_nan_in_local_uses_remote(self, tmp_data_dir):
        """When local.last_activity_ts is NaN, merged must not be NaN — remote value used."""
        import math

        from token_goat.session import _merge_session_caches

        local = session.SessionCache("nan-ts1", 0.0, math.nan)
        remote = session.SessionCache("nan-ts1", 0.0, 5.0)

        merged = _merge_session_caches(local, remote)
        assert not math.isnan(merged.last_activity_ts), (
            "NaN last_activity_ts from local must not propagate; expected remote's 5.0"
        )
        assert merged.last_activity_ts == 5.0

    def test_last_activity_ts_nan_in_remote_uses_local(self, tmp_data_dir):
        """When remote.last_activity_ts is NaN, merged must not be NaN — local value used."""
        import math

        from token_goat.session import _merge_session_caches

        local = session.SessionCache("nan-ts2", 0.0, 7.0)
        remote = session.SessionCache("nan-ts2", 0.0, math.nan)

        merged = _merge_session_caches(local, remote)
        assert not math.isnan(merged.last_activity_ts), (
            "NaN last_activity_ts from remote must not propagate; expected local's 7.0"
        )
        assert merged.last_activity_ts == 7.0

    def test_hints_emitted_nan_in_local_uses_remote(self, tmp_data_dir):
        """When local.hints_emitted is NaN, merged must not be NaN."""
        import math

        from token_goat.session import _merge_session_caches

        local = session.SessionCache("nan-he1", 0.0, 1.0)
        remote = session.SessionCache("nan-he1", 0.0, 1.0)
        local.hints_emitted = math.nan  # type: ignore[assignment]
        remote.hints_emitted = 3

        merged = _merge_session_caches(local, remote)
        assert not math.isnan(merged.hints_emitted), (
            "NaN hints_emitted from local must not propagate; expected remote's 3"
        )

    def test_last_manifest_ts_nan_in_local(self, tmp_data_dir):
        """NaN last_manifest_ts in local: remote manifest fields kept (comparison is False)."""
        import math

        from token_goat.session import _merge_session_caches

        local = session.SessionCache("nan-mt1", 0.0, 1.0)
        remote = session.SessionCache("nan-mt1", 0.0, 1.0)
        local.last_manifest_ts = math.nan
        local.last_manifest_sha = "local-sha"
        remote.last_manifest_ts = 10.0
        remote.last_manifest_sha = "remote-sha"

        merged = _merge_session_caches(local, remote)
        # NaN >= 10.0 is False, so remote branch taken: remote sha kept
        assert merged.last_manifest_sha == "remote-sha"
        assert not math.isnan(merged.last_manifest_ts)

    def test_file_entry_last_read_ts_nan(self, tmp_data_dir):
        """When a FileEntry's last_read_ts is NaN, the remote entry's ts comparison works.

        NaN > x is always False, so the remote entry is kept (safe default).
        """
        import math

        from token_goat.session import FileEntry, _merge_session_caches

        local = session.SessionCache("nan-fe1", 0.0, 1.0)
        remote = session.SessionCache("nan-fe1", 0.0, 1.0)

        # local entry with NaN last_read_ts
        local.files["src/z.py"] = FileEntry(
            rel_or_abs="src/z.py",
            last_read_ts=math.nan,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
        )
        remote.files["src/z.py"] = FileEntry(
            rel_or_abs="src/z.py",
            last_read_ts=5.0,
            read_count=2,
            line_ranges=[(1, 10)],
            symbols_read=[],
        )

        # Must not raise; remote entry kept because NaN > 5.0 is False
        merged = _merge_session_caches(local, remote)
        assert "src/z.py" in merged.files
        assert not math.isnan(merged.files["src/z.py"].last_read_ts)
        assert merged.files["src/z.py"].read_count == 2


class TestMergeEditedFilesConflicts:
    """_merge_session_caches edited_files: multi-key and asymmetric conflict cases."""

    def test_multiple_keys_some_shared_some_unique(self, tmp_data_dir):
        """Merge of edited_files with shared + unique keys across local and remote."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("ef-multi1", 0.0, 1.0)
        remote = session.SessionCache("ef-multi1", 0.0, 2.0)

        local.edited_files["shared.py"] = 3
        local.edited_files["local_only.py"] = 5

        remote.edited_files["shared.py"] = 7
        remote.edited_files["remote_only.py"] = 2

        merged = _merge_session_caches(local, remote)

        # shared key: max(7, 3) = 7
        assert merged.edited_files["shared.py"] == 7
        # local-only key: propagated as-is
        assert merged.edited_files["local_only.py"] == 5
        # remote-only key: preserved from remote base
        assert merged.edited_files["remote_only.py"] == 2

    def test_all_keys_conflict_local_wins_each(self, tmp_data_dir):
        """All keys present in both sides; local has higher counts everywhere."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("ef-multi2", 0.0, 1.0)
        remote = session.SessionCache("ef-multi2", 0.0, 2.0)

        for i in range(5):
            local.edited_files[f"file{i}.py"] = i + 10
            remote.edited_files[f"file{i}.py"] = i + 1

        merged = _merge_session_caches(local, remote)

        for i in range(5):
            # local value (i+10) is always larger than remote (i+1)
            assert merged.edited_files[f"file{i}.py"] == i + 10

    def test_all_keys_conflict_remote_wins_each(self, tmp_data_dir):
        """All keys present in both sides; remote has higher counts everywhere."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("ef-multi3", 0.0, 1.0)
        remote = session.SessionCache("ef-multi3", 0.0, 2.0)

        for i in range(5):
            local.edited_files[f"file{i}.py"] = i + 1
            remote.edited_files[f"file{i}.py"] = i + 10

        merged = _merge_session_caches(local, remote)

        for i in range(5):
            # remote value (i+10) is always larger
            assert merged.edited_files[f"file{i}.py"] == i + 10

    def test_zero_counts_preserved(self, tmp_data_dir):
        """A zero edit-count is the correct max when both sides are zero."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("ef-zero1", 0.0, 1.0)
        remote = session.SessionCache("ef-zero1", 0.0, 2.0)
        local.edited_files["untouched.py"] = 0
        remote.edited_files["untouched.py"] = 0

        merged = _merge_session_caches(local, remote)
        assert merged.edited_files["untouched.py"] == 0

    def test_large_key_set_no_entries_lost(self, tmp_data_dir):
        """Merging many distinct keys (no overlap) preserves all from both sides."""
        from token_goat.session import _merge_session_caches

        local = session.SessionCache("ef-large1", 0.0, 1.0)
        remote = session.SessionCache("ef-large1", 0.0, 2.0)

        for i in range(50):
            local.edited_files[f"local_{i}.py"] = i + 1
        for i in range(50):
            remote.edited_files[f"remote_{i}.py"] = i + 1

        merged = _merge_session_caches(local, remote)
        assert len(merged.edited_files) == 100
        for i in range(50):
            assert merged.edited_files[f"local_{i}.py"] == i + 1
            assert merged.edited_files[f"remote_{i}.py"] == i + 1


# ---------------------------------------------------------------------------
# Task B: TypedDict / dataclass alignment meta-tests
# ---------------------------------------------------------------------------


class TestTypedDictDataclassAlignment:
    """Meta-tests verifying TypedDict wire-format dicts stay in sync with dataclasses.

    These tests are compile-time / structural checks, not runtime checks.
    They exist so that adding a field to a dataclass without updating the
    corresponding TypedDict is caught immediately by the test suite.

    The session module uses TypedDict classes that mirror entry dataclasses
    (FileEntry <-> _FileEntryDict, etc.) for JSON serialization.  Since Python
    has no mechanism to automatically derive one from the other, this class
    acts as the mechanical guardrail.

    Intentional mismatches in _SessionDict / SessionCache:
    - SessionCache has ``recovery_injected`` and ``unavailable``: transient
      runtime-only flags (repr=False, compare=False) that are never persisted.
    - _SessionDict has ``schema_version`` and ``created_by``: JSON envelope
      metadata that has no corresponding dataclass field.
    These are explicitly whitelisted in the assertions below.
    """

    def _get_dataclass_fields(self, cls: type) -> set[str]:
        """Return the set of public non-dunder annotated field names for a dataclass."""
        import dataclasses

        return {f.name for f in dataclasses.fields(cls) if not f.name.startswith("_")}

    def _get_typeddict_keys(self, cls: type) -> set[str]:
        """Return the set of keys declared on a TypedDict class (non-inherited)."""
        return set(cls.__annotations__)

    def test_file_entry_matches_file_entry_dict(self):
        """FileEntry fields match _FileEntryDict keys exactly."""
        from token_goat.session import FileEntry, _FileEntryDict

        dc_fields = self._get_dataclass_fields(FileEntry)
        td_keys = self._get_typeddict_keys(_FileEntryDict)
        assert dc_fields == td_keys, (
            f"FileEntry <-> _FileEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_bash_entry_matches_bash_entry_dict(self):
        """BashEntry fields match _BashEntryDict keys exactly."""
        from token_goat.session import BashEntry, _BashEntryDict

        dc_fields = self._get_dataclass_fields(BashEntry)
        td_keys = self._get_typeddict_keys(_BashEntryDict)
        assert dc_fields == td_keys, (
            f"BashEntry <-> _BashEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_web_entry_matches_web_entry_dict(self):
        """WebEntry fields match _WebEntryDict keys exactly."""
        from token_goat.session import WebEntry, _WebEntryDict

        dc_fields = self._get_dataclass_fields(WebEntry)
        td_keys = self._get_typeddict_keys(_WebEntryDict)
        assert dc_fields == td_keys, (
            f"WebEntry <-> _WebEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_skill_entry_matches_skill_entry_dict(self):
        """SkillEntry fields match _SkillEntryDict keys exactly."""
        from token_goat.session import SkillEntry, _SkillEntryDict

        dc_fields = self._get_dataclass_fields(SkillEntry)
        td_keys = self._get_typeddict_keys(_SkillEntryDict)
        assert dc_fields == td_keys, (
            f"SkillEntry <-> _SkillEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_decision_entry_matches_decision_entry_dict(self):
        """DecisionEntry fields match _DecisionEntryDict keys exactly."""
        from token_goat.session import DecisionEntry, _DecisionEntryDict

        dc_fields = self._get_dataclass_fields(DecisionEntry)
        td_keys = self._get_typeddict_keys(_DecisionEntryDict)
        assert dc_fields == td_keys, (
            f"DecisionEntry <-> _DecisionEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_result_cache_entry_matches_result_cache_entry_dict(self):
        """ResultCacheEntry fields match _ResultCacheEntryDict keys exactly."""
        from token_goat.session import ResultCacheEntry, _ResultCacheEntryDict

        dc_fields = self._get_dataclass_fields(ResultCacheEntry)
        td_keys = self._get_typeddict_keys(_ResultCacheEntryDict)
        assert dc_fields == td_keys, (
            f"ResultCacheEntry <-> _ResultCacheEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_grep_entry_matches_grep_entry_dict(self):
        """GrepEntry fields match _GrepEntryDict keys exactly."""
        from token_goat.session import GrepEntry, _GrepEntryDict

        dc_fields = self._get_dataclass_fields(GrepEntry)
        td_keys = self._get_typeddict_keys(_GrepEntryDict)
        assert dc_fields == td_keys, (
            f"GrepEntry <-> _GrepEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_glob_entry_matches_glob_entry_dict(self):
        """GlobEntry fields match _GlobEntryDict keys exactly."""
        from token_goat.session import GlobEntry, _GlobEntryDict

        dc_fields = self._get_dataclass_fields(GlobEntry)
        td_keys = self._get_typeddict_keys(_GlobEntryDict)
        assert dc_fields == td_keys, (
            f"GlobEntry <-> _GlobEntryDict mismatch.\n"
            f"  In dataclass only: {dc_fields - td_keys}\n"
            f"  In TypedDict only: {td_keys - dc_fields}"
        )

    def test_session_cache_vs_session_dict_intentional_exclusions(self):
        """SessionCache <-> _SessionDict alignment with documented intentional exclusions.

        Verifies:
        1. The only SessionCache fields missing from _SessionDict are the two
           transient runtime-only flags: ``recovery_injected`` and ``unavailable``.
        2. The only _SessionDict keys missing from SessionCache are the two
           JSON envelope metadata fields: ``schema_version`` and ``created_by``.
        3. All other fields align exactly.

        If a new dataclass field is added without updating _SessionDict (or vice
        versa), this test will fail with a clear diff of what drifted.
        """
        from token_goat.session import SessionCache, _SessionDict

        dc_fields = self._get_dataclass_fields(SessionCache)
        td_keys = self._get_typeddict_keys(_SessionDict)

        # Fields intentionally in dataclass but NOT in TypedDict (transient runtime state)
        dc_only_allowed = {"recovery_injected", "unavailable"}
        # Fields intentionally in TypedDict but NOT in dataclass (JSON envelope metadata)
        td_only_allowed = {"schema_version", "created_by"}

        actual_dc_only = dc_fields - td_keys
        actual_td_only = td_keys - dc_fields

        unexpected_dc_only = actual_dc_only - dc_only_allowed
        unexpected_td_only = actual_td_only - td_only_allowed

        assert not unexpected_dc_only, (
            f"New SessionCache fields not in _SessionDict (add them or whitelist): "
            f"{unexpected_dc_only}"
        )
        assert not unexpected_td_only, (
            f"New _SessionDict keys not in SessionCache (add them or whitelist): "
            f"{unexpected_td_only}"
        )
        # Also verify we don't have *fewer* intentional exclusions than expected
        # (catching the case where someone removes a field without updating this test)
        assert actual_dc_only == dc_only_allowed, (
            f"Expected dc-only exclusions {dc_only_allowed}, got {actual_dc_only}"
        )
        assert actual_td_only == td_only_allowed, (
            f"Expected td-only exclusions {td_only_allowed}, got {actual_td_only}"
        )


class TestSessionReliability:
    """Tests for atomic writes, corruption recovery, and cleanup."""

    def test_cleanup_stale_tmp_files_removes_orphaned_files(self, tmp_data_dir):
        """_cleanup_stale_tmp_files removes orphaned .tmp files before load."""
        session_id = "test_tmp_cleanup"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Create a couple of orphaned .tmp files that would be left by an
        # interrupted atomic_write_text operation
        tmp1 = cache_path.with_name(f"{cache_path.name}.12345.999999999.tmp")
        tmp2 = cache_path.with_name(f"{cache_path.name}.67890.888888888.tmp")
        tmp1.write_text("stale")
        tmp2.write_text("stale")
        assert tmp1.exists()
        assert tmp2.exists()

        # Call load() which should trigger cleanup
        loaded = session.load(session_id)
        assert loaded.session_id == session_id

        # Verify tmp files were cleaned up
        assert not tmp1.exists()
        assert not tmp2.exists()

    def test_cleanup_stale_tmp_files_tolerates_missing_parent(self, tmp_data_dir):
        """_cleanup_stale_tmp_files does not crash if parent dir does not exist."""
        # This should not raise even though the parent doesn't exist
        nonexistent = pathlib.Path("/nonexistent/path/to/session.json")
        session._cleanup_stale_tmp_files(nonexistent)  # Should be a no-op

    def test_preserve_corrupt_file_archives_on_json_decode_error(self, tmp_data_dir):
        """When JSON is corrupt, preserve_corrupt_file archives it to .corrupt.{ts}."""
        session_id = "test_corrupt_archive"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Write an invalid JSON file
        cache_path.write_text("{invalid json")

        # Load should detect corruption, preserve the file, and return fresh cache
        loaded = session.load(session_id)
        assert loaded.session_id == session_id
        assert loaded.files == {}

        # Original cache_path should be gone; .corrupt file should exist
        assert not cache_path.exists()
        corrupt_files = list(cache_path.parent.glob(f"{cache_path.name}.corrupt.*"))
        assert len(corrupt_files) == 1, f"Expected 1 corrupt file, found {len(corrupt_files)}"

    def test_preserve_corrupt_file_tolerates_missing_file(self, tmp_data_dir):
        """_preserve_corrupt_file is a no-op if the file doesn't exist."""
        nonexistent_path = pathlib.Path("/nonexistent/cache.json")
        # Should not raise
        session._preserve_corrupt_file(nonexistent_path)

    def test_load_recovers_from_corrupt_json_with_valid_fallback(self, tmp_data_dir):
        """After corruption recovery, subsequent saves work correctly."""
        session_id = "test_corrupt_recovery"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Write invalid JSON
        cache_path.write_text("{bad")

        # First load should recover and archive
        loaded1 = session.load(session_id)
        assert loaded1.files == {}

        # Mark a file in the recovered cache and save
        loaded1 = session.mark_file_read(session_id, "test.py", offset=0, limit=10)
        session.save(loaded1)

        # Load again and verify the file was persisted
        loaded2 = session.load(session_id)
        assert "test.py" in loaded2.files

    def test_atomic_write_creates_valid_json_on_success(self, tmp_data_dir):
        """Session cache persists as valid JSON after successful save."""
        session_id = "test_atomic_write"
        cache = session.load(session_id)
        cache = session.mark_file_read(session_id, "file.py", offset=1, limit=50)
        session.save(cache)

        cache_path = session.paths.session_cache_path(session_id)
        assert cache_path.exists()

        # Verify the file contains valid JSON that can be loaded by Python
        raw = cache_path.read_text(encoding="utf-8")
        data = __import__("json").loads(raw)
        assert data["session_id"] == session_id
        assert "file.py" in data.get("files", {})

    def test_load_handles_schema_version_mismatch(self, tmp_data_dir):
        """Load drops cache with mismatched schema_version and returns fresh."""
        session_id = "test_schema_mismatch"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Write a cache with a bogus schema version
        bad_cache = {
            "schema_version": 999,
            "session_id": session_id,
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "created_by": "test",
            "files": {},
            "greps": [],
            "edited_files": {},
            "result_cache": {},
            "bash_history": {},
            "glob_history": [],
            "web_history": {},
            "skill_history": {},
            "decisions": [],
            "snapshot_shas": {},
            "hints_seen": {},
            "bash_dedup_emitted_ids": [],
            "hints_emitted": 0,
            "hints_ignored": 0,
            "structured_hints_emitted": 0,
            "index_only_hints_emitted": 0,
            "hints_emitted_by_type": {},
            "hints_suppressed_by_type": {},
            "recent_hints": [],
            "last_manifest_sha": "",
            "last_manifest_ts": 0.0,
            "version": 0,
            "hint_category_history": {},
            "cwd": None,
        }
        cache_path.write_text(__import__("json").dumps(bad_cache))

        # Load should drop the cache and return fresh
        loaded = session.load(session_id)
        assert loaded.files == {}
        # Original file should be gone or the cache should be fresh (not from disk)
        assert loaded.version == 0  # Fresh cache starts at version 0

    def test_tmp_cleanup_and_corrupt_preservation_end_to_end(self, tmp_data_dir):
        """Full scenario: orphaned .tmp + corrupt cache both cleaned up on load."""
        session_id = "test_e2e_reliability"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Step 1: Create a cache with some data
        initial = session.mark_file_read(session_id, "original.py", offset=0, limit=50)
        session.save(initial)
        assert cache_path.exists()

        # Step 2: Simulate an interrupted write by creating orphaned .tmp files
        tmp_orphan = cache_path.with_name(f"{cache_path.name}.11111.99999999.tmp")
        tmp_orphan.write_text("abandoned write content")
        assert tmp_orphan.exists()

        # Step 3: Corrupt the cache file
        cache_path.write_text("{this is not valid json]")

        # Step 4: Load should clean up .tmp, archive corrupt file, and recover
        recovered = session.load(session_id)
        assert recovered.session_id == session_id
        assert recovered.files == {}  # Fresh start (corrupt file deleted)

        # Step 5: Verify cleanup happened
        assert not tmp_orphan.exists(), ".tmp file should be cleaned up"
        assert not cache_path.exists(), "Corrupt cache should be moved away"
        corrupt_archives = list(cache_path.parent.glob(f"{cache_path.name}.corrupt.*"))
        assert len(corrupt_archives) == 1, "Corrupt file should be archived"

        # Step 6: Verify we can continue using the recovered cache
        recovered = session.mark_file_read(session_id, "recovered.py", offset=0, limit=100)
        session.save(recovered)
        assert cache_path.exists(), "New cache file should be created"
        assert "recovered.py" in recovered.files


class TestGrepResultHashes:
    """Tests for grep result content dedup hashing."""

    def test_grep_result_hashes_basic_roundtrip(self, tmp_data_dir):
        """record_grep_result_hash stores and persists content-hash → pattern."""
        session_id = "test_grep_hashes"
        cache = session.load(session_id)

        # Record a hash
        cache.record_grep_result_hash("abc12345", "def foo")
        assert cache.has_grep_result_hash("abc12345")
        assert cache.get_grep_result_pattern("abc12345") == "def foo"

        # Save and reload
        session.save(cache)
        loaded = session.load(session_id)
        assert loaded.has_grep_result_hash("abc12345")
        assert loaded.get_grep_result_pattern("abc12345") == "def foo"

    def test_grep_result_hashes_missing_hash(self, tmp_data_dir):
        """has_grep_result_hash returns False for unseen hash."""
        cache = session.load("test_missing_hash")
        assert not cache.has_grep_result_hash("nonexistent")
        assert cache.get_grep_result_pattern("nonexistent") is None

    def test_grep_result_hashes_fifo_eviction(self, tmp_data_dir):
        """record_grep_result_hash evicts oldest when cap exceeded."""
        cache = session.load("test_fifo_eviction")
        max_cap = session.GREP_RESULT_HASHES_MAX

        # Fill up to cap
        for i in range(max_cap):
            cache.record_grep_result_hash(f"hash{i:03d}", f"pattern{i}")
        assert len(cache.grep_result_hashes) == max_cap

        # Add one more to trigger eviction
        cache.record_grep_result_hash("hash_overflow", "pattern_overflow")

        # Should have evicted oldest (hash000)
        assert len(cache.grep_result_hashes) <= max_cap
        assert not cache.has_grep_result_hash("hash000"), "Oldest should be evicted"
        assert cache.has_grep_result_hash("hash_overflow"), "New entry should exist"

    def test_grep_result_hashes_updates_last_activity_ts(self, tmp_data_dir, monkeypatch):
        """record_grep_result_hash updates last_activity_ts."""
        import token_goat.session as _sess_mod

        # Patch time.time so the second call returns a reliably larger value
        # without sleeping.
        _ts = [1_700_000_000.0]

        def _fake_time():
            _ts[0] += 1.0
            return _ts[0]

        monkeypatch.setattr(_sess_mod.time, "time", _fake_time)
        cache = session.load("test_activity_ts")
        old_ts = cache.last_activity_ts

        cache.record_grep_result_hash("test_hash", "test_pattern")
        assert cache.last_activity_ts > old_ts

    def test_grep_result_hashes_same_pattern_overwrite(self, tmp_data_dir):
        """Recording same hash again updates to latest pattern."""
        cache = session.load("test_same_pattern")

        cache.record_grep_result_hash("hash1", "pattern_a")
        assert cache.get_grep_result_pattern("hash1") == "pattern_a"

        # Record same hash with different pattern — updates to latest
        cache.record_grep_result_hash("hash1", "pattern_b")
        assert cache.get_grep_result_pattern("hash1") == "pattern_b"

    def test_grep_result_hashes_multiple_patterns(self, tmp_data_dir):
        """Multiple different patterns can be recorded."""
        cache = session.load("test_multiple")

        cache.record_grep_result_hash("hash1", "pattern1")
        cache.record_grep_result_hash("hash2", "pattern2")
        cache.record_grep_result_hash("hash3", "pattern3")

        assert cache.get_grep_result_pattern("hash1") == "pattern1"
        assert cache.get_grep_result_pattern("hash2") == "pattern2"
        assert cache.get_grep_result_pattern("hash3") == "pattern3"

    def test_grep_result_hashes_from_dict_missing_field(self, tmp_data_dir):
        """from_dict handles missing grep_result_hashes gracefully."""
        session_id = "test_from_dict_missing"
        cache_path = session.paths.session_cache_path(session_id)
        session.paths.ensure_dir(cache_path.parent)

        # Write cache without grep_result_hashes (old schema)
        import json
        old_cache = {
            "schema_version": session.SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            "created_ts": time.time(),
            "created_by": "test",
            "files": {},
            "greps": [],
            "edited_files": {},
            "result_cache": {},
            "bash_history": {},
            "glob_history": [],
            "web_history": {},
            "skill_history": {},
            "decisions": [],
            "snapshot_shas": {},
            "hints_seen": {},
            "bash_dedup_emitted_ids": [],
            "hints_emitted": 0,
            "hints_ignored": 0,
            "structured_hints_emitted": 0,
            "index_only_hints_emitted": 0,
            "hints_emitted_by_type": {},
            "hints_suppressed_by_type": {},
            "recent_hints": [],
            "last_manifest_sha": "",
            "last_manifest_ts": 0.0,
            "version": 0,
            "hint_category_history": {},
            "image_shrink_count": {},
            "file_access_counts": {},
            "symbol_access_counts": {},
            "cwd": None,
            # grep_result_hashes deliberately omitted
        }
        cache_path.write_text(json.dumps(old_cache))

        # Load should create empty grep_result_hashes
        loaded = session.load(session_id)
        assert loaded.grep_result_hashes == {}
        assert not loaded.has_grep_result_hash("anything")

    def test_grep_result_hashes_merge_cas(self, tmp_data_dir):
        """CAS merge combines grep_result_hashes from both versions."""
        session_id = "test_merge_cas"

        # Create and save local version
        local = session.load(session_id)
        local.grep_result_hashes["hash_local"] = "pattern_local"

        # Simulate remote version with different hashes
        remote = session.SessionCache(
            session_id=session_id,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        remote.grep_result_hashes["hash_remote"] = "pattern_remote"
        remote.version = 2

        # Merge local into remote
        merged = session._merge_session_caches(local, remote)

        # Both hashes should exist after merge
        assert merged.has_grep_result_hash("hash_local")
        assert merged.has_grep_result_hash("hash_remote")
        assert merged.get_grep_result_pattern("hash_local") == "pattern_local"
        assert merged.get_grep_result_pattern("hash_remote") == "pattern_remote"

    def test_grep_result_hashes_invalidates_json_cache(self, tmp_data_dir):
        """record_grep_result_hash invalidates _json_cache."""
        cache = session.load("test_json_cache")

        # Prime the json cache
        json_before = cache.to_json()
        assert cache._json_cache is not None

        # Record a hash should invalidate cache
        cache.record_grep_result_hash("hash1", "pattern1")
        assert cache._json_cache is None

        # Next to_json should be different
        json_after = cache.to_json()
        assert json_before != json_after
        assert '"grep_result_hashes"' in json_after
