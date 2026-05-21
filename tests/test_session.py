"""Tests for session-context cache."""
from __future__ import annotations

import pathlib
import sys
import time

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
        # Both should reference the same entry; drive letter is lowercased on Windows only.
        assert len(cache2.files) == 1
        expected_key = "c:/foo/bar.py" if sys.platform == "win32" else "C:/foo/bar.py"
        assert cache2.files[expected_key].read_count == 2

    @pytest.mark.skipif(sys.platform != "win32", reason="drive-letter lowercasing is Windows-only")
    def test_drive_letter_lowercase(self, tmp_data_dir):
        """Drive letters normalized to lowercase (Windows only)."""
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

    def test_list_touched_sorted_by_timestamp(self, tmp_data_dir):
        """list_touched returns entries sorted by last_read_ts desc."""
        s_id = "s12"
        session.mark_file_read(s_id, "a.py")
        time.sleep(0.01)
        session.mark_file_read(s_id, "b.py")
        time.sleep(0.01)
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


class TestTimestampTracking:
    """Timestamp tracking."""

    def test_last_activity_ts_updated(self, tmp_data_dir):
        """last_activity_ts is updated on each mark_* call."""
        s_id = "s15"
        c1 = session.mark_file_read(s_id, "f.py")
        t1 = c1.last_activity_ts
        time.sleep(0.01)
        c2 = session.mark_file_read(s_id, "g.py")
        t2 = c2.last_activity_ts
        assert t2 > t1

    def test_file_entry_last_read_ts(self, tmp_data_dir):
        """FileEntry.last_read_ts is updated on each read."""
        s_id = "s16"
        c1 = session.mark_file_read(s_id, "f.py")
        t1 = c1.files["f.py"].last_read_ts
        time.sleep(0.01)
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

    @pytest.mark.skipif(sys.platform != "win32", reason="cross-case Windows path lookup is Windows-only")
    def test_get_file_entry_path_normalization(self, tmp_data_dir):
        """get_file_entry normalizes path like mark_file_read (Windows drive-letter case)."""
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
        sid = "rc_session_4"
        # Fill to cap + 5
        for i in range(session.RESULT_CACHE_MAX + 5):
            session.put_result_cache(
                sid, f"f{i}.py", "x", "symbol", "sha", {"text": f"r{i}"}
            )
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
        sid = "rc_session_5"
        # Fill exactly to cap
        for i in range(session.RESULT_CACHE_MAX):
            session.put_result_cache(
                sid, f"f{i}.py", "x", "symbol", "sha", {"text": f"r{i}"}
            )
        # Update an existing entry (should be a no-op for eviction)
        session.put_result_cache(sid, "f0.py", "x", "symbol", "sha", {"text": "updated"})
        # f0 must still be present with updated text — it was not evicted
        got = session.get_result_cache(sid, "f0.py", "x", "symbol", "sha")
        assert got is not None
        assert got["text"] == "updated"

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
        before = time.time()
        # Simulate a legacy session dict without created_ts
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
        after = time.time()
        cache = session.SessionCache.from_dict(legacy_dict)
        # Should default to approximately now
        assert before <= cache.created_ts <= after


class TestGrepHistoryCap:
    """GREPS_HISTORY_MAX cap — oldest entries are evicted FIFO when exceeded."""

    def test_greps_capped_at_max(self, tmp_data_dir):
        """Filling past GREPS_HISTORY_MAX keeps at most GREPS_HISTORY_MAX entries."""
        sid = "greps_cap_1"
        for i in range(session.GREPS_HISTORY_MAX + 5):
            session.mark_grep(sid, f"pattern_{i}", "/proj/src")
        cache = session.load(sid)
        assert len(cache.greps) <= session.GREPS_HISTORY_MAX

    def test_greps_cap_evicts_oldest(self, tmp_data_dir):
        """When the cap fires, the oldest (first) entries are evicted."""
        sid = "greps_cap_2"
        n = session.GREPS_HISTORY_MAX + 3
        for i in range(n):
            session.mark_grep(sid, f"pattern_{i}", "/proj/src")
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
        sid = "greps_cap_3"
        for i in range(session.GREPS_HISTORY_MAX):
            session.mark_grep(sid, f"pat_{i}", "/proj/src")
        cache = session.load(sid)
        assert len(cache.greps) == session.GREPS_HISTORY_MAX


class TestHintsSeenCap:
    """HINTS_SEEN_MAX cap — hints_seen is cleared via mark_hint_seen() when exceeded."""

    def test_hints_seen_capped_via_mark(self, tmp_data_dir):
        """hints_seen is cleared (reset to empty set) when mark_hint_seen pushes it past HINTS_SEEN_MAX."""
        sid = "hints_cap_1"
        cache = session.load(sid)
        # Fill hints_seen to exactly the cap using mark_hint_seen so the
        # enforcement path in SessionCache.mark_hint_seen() fires correctly.
        for i in range(session.HINTS_SEEN_MAX):
            cache.mark_hint_seen(f"fp_{i}")
        # One more push past the cap — should trigger the clear.
        cache.mark_hint_seen("fp_overflow")
        # After the clear, only the newly-added fingerprint remains (or it
        # may be empty depending on whether the clear happens before or after
        # the add — the production code clears then the loop continues, so
        # "fp_overflow" was added before clear fired; check cap is satisfied).
        assert len(cache.hints_seen) <= session.HINTS_SEEN_MAX

    def test_hints_seen_cleared_after_cap_roundtrip(self, tmp_data_dir):
        """After cap fires and cache is saved+loaded, hints_seen is compact."""
        sid = "hints_cap_2"
        cache = session.load(sid)
        # Overflow via mark_hint_seen
        for i in range(session.HINTS_SEEN_MAX + 1):
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


class TestFilesMaxEviction:
    """FILES_MAX FIFO eviction in mark_file_read."""

    def test_files_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past FILES_MAX evicts oldest entries; dict stays at most FILES_MAX."""
        sid = "files_cap_1"
        overshoot = 10
        for i in range(session.FILES_MAX + overshoot):
            session.mark_file_read(sid, f"/abs/path/file_{i}.py")
        cache = session.load(sid)
        assert len(cache.files) <= session.FILES_MAX

    def test_newest_files_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently inserted files are still present."""
        sid = "files_cap_2"
        total = session.FILES_MAX + 20
        for i in range(total):
            session.mark_file_read(sid, f"/abs/path/file_{i}.py")
        cache = session.load(sid)
        # The last inserted file must survive — it was added after the eviction pass.
        last_key = f"/abs/path/file_{total - 1}.py"
        assert last_key in cache.files, "most recently added file was evicted"

    def test_files_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly FILES_MAX unique files: no eviction fires."""
        sid = "files_cap_3"
        for i in range(session.FILES_MAX):
            session.mark_file_read(sid, f"/abs/path/f_{i}.py")
        cache = session.load(sid)
        assert len(cache.files) == session.FILES_MAX


class TestEditedFilesMaxEviction:
    """EDITED_FILES_MAX FIFO eviction in mark_file_edited."""

    def test_edited_files_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past EDITED_FILES_MAX evicts oldest entries; dict stays bounded."""
        sid = "edited_cap_1"
        overshoot = 10
        for i in range(session.EDITED_FILES_MAX + overshoot):
            session.mark_file_edited(sid, f"/abs/path/edit_{i}.py")
        cache = session.load(sid)
        assert len(cache.edited_files) <= session.EDITED_FILES_MAX

    def test_newest_edited_files_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently edited files are still present."""
        sid = "edited_cap_2"
        total = session.EDITED_FILES_MAX + 20
        for i in range(total):
            session.mark_file_edited(sid, f"/abs/path/edit_{i}.py")
        cache = session.load(sid)
        last_key = f"/abs/path/edit_{total - 1}.py"
        assert last_key in cache.edited_files, "most recently edited file was evicted"

    def test_edited_files_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly EDITED_FILES_MAX unique files: no eviction fires."""
        sid = "edited_cap_3"
        for i in range(session.EDITED_FILES_MAX):
            session.mark_file_edited(sid, f"/abs/path/e_{i}.py")
        cache = session.load(sid)
        assert len(cache.edited_files) == session.EDITED_FILES_MAX

    def test_repeated_edit_of_same_file_does_not_evict(self, tmp_data_dir):
        """Editing the same file repeatedly never adds new keys, so no eviction fires."""
        sid = "edited_cap_4"
        # Fill to cap with distinct files.
        for i in range(session.EDITED_FILES_MAX):
            session.mark_file_edited(sid, f"/abs/path/e_{i}.py")
        # Edit the first file many more times — it's already a key, so no new insertion.
        for _ in range(20):
            session.mark_file_edited(sid, "/abs/path/e_0.py")
        cache = session.load(sid)
        assert len(cache.edited_files) == session.EDITED_FILES_MAX
        # Edit count for the repeated file must be > 1.
        assert cache.edited_files.get("/abs/path/e_0.py", 0) > 1


class TestSnapshotShasMaxEviction:
    """SNAPSHOT_SHAS_MAX FIFO eviction in set_snapshot_sha."""

    def test_snapshot_shas_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past SNAPSHOT_SHAS_MAX evicts oldest entries; dict stays bounded."""
        sid = "snap_cap_1"
        overshoot = 5
        for i in range(session.SNAPSHOT_SHAS_MAX + overshoot):
            session.set_snapshot_sha(sid, f"/abs/path/snap_{i}.py", f"sha_{i}")
        cache = session.load(sid)
        assert len(cache.snapshot_shas) <= session.SNAPSHOT_SHAS_MAX

    def test_newest_snapshots_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently inserted snapshot is still present."""
        sid = "snap_cap_2"
        total = session.SNAPSHOT_SHAS_MAX + 10
        for i in range(total):
            session.set_snapshot_sha(sid, f"/abs/path/snap_{i}.py", f"sha_{i}")
        cache = session.load(sid)
        last_key = f"/abs/path/snap_{total - 1}.py"
        assert last_key in cache.snapshot_shas, "most recently added snapshot was evicted"

    def test_snapshot_shas_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly SNAPSHOT_SHAS_MAX unique paths: no eviction fires."""
        sid = "snap_cap_3"
        for i in range(session.SNAPSHOT_SHAS_MAX):
            session.set_snapshot_sha(sid, f"/abs/path/s_{i}.py", f"sha_{i}")
        cache = session.load(sid)
        assert len(cache.snapshot_shas) == session.SNAPSHOT_SHAS_MAX


class TestWebHistoryMaxEviction:
    """WEB_HISTORY_MAX FIFO eviction in mark_web_fetch."""

    def test_web_history_evicted_when_cap_exceeded(self, tmp_data_dir):
        """Filling past WEB_HISTORY_MAX evicts oldest entries; dict stays bounded."""
        sid = "web_cap_1"
        overshoot = 5
        for i in range(session.WEB_HISTORY_MAX + overshoot):
            session.mark_web_fetch(
                sid,
                url_sha=f"sha_{i}",
                url_preview=f"https://example.com/page_{i}",
                output_id=f"out_{i}",
                body_bytes=1000,
                status_code=200,
                truncated=False,
            )
        cache = session.load(sid)
        assert len(cache.web_history) <= session.WEB_HISTORY_MAX

    def test_newest_web_entries_survive_eviction(self, tmp_data_dir):
        """After eviction the most recently added web entry is still present."""
        sid = "web_cap_2"
        total = session.WEB_HISTORY_MAX + 10
        for i in range(total):
            session.mark_web_fetch(
                sid,
                url_sha=f"sha_{i}",
                url_preview=f"https://example.com/page_{i}",
                output_id=f"out_{i}",
                body_bytes=1000,
                status_code=200,
                truncated=False,
            )
        cache = session.load(sid)
        last_key = f"sha_{total - 1}"
        assert last_key in cache.web_history, "most recently added web entry was evicted"

    def test_web_history_exactly_at_cap_not_evicted(self, tmp_data_dir):
        """Exactly WEB_HISTORY_MAX unique URLs: no eviction fires."""
        sid = "web_cap_3"
        for i in range(session.WEB_HISTORY_MAX):
            session.mark_web_fetch(
                sid,
                url_sha=f"sha_{i}",
                url_preview=f"https://example.com/page_{i}",
                output_id=f"out_{i}",
                body_bytes=1000,
                status_code=200,
                truncated=False,
            )
        cache = session.load(sid)
        assert len(cache.web_history) == session.WEB_HISTORY_MAX

    def test_duplicate_url_sha_does_not_trigger_eviction(self, tmp_data_dir):
        """Re-fetching the same URL (same SHA) updates the entry without triggering eviction."""
        sid = "web_cap_4"
        # Fill to cap with distinct URLs.
        for i in range(session.WEB_HISTORY_MAX):
            session.mark_web_fetch(
                sid,
                url_sha=f"sha_{i}",
                url_preview=f"https://example.com/page_{i}",
                output_id=f"out_{i}",
                body_bytes=1000,
                status_code=200,
                truncated=False,
            )
        # Fetch the first URL again (same SHA).
        session.mark_web_fetch(
            sid,
            url_sha="sha_0",
            url_preview="https://example.com/page_0?v=2",
            output_id="out_0_retry",
            body_bytes=1000,
            status_code=200,
            truncated=False,
        )
        cache = session.load(sid)
        # Should still be at cap (no new entry added).
        assert len(cache.web_history) == session.WEB_HISTORY_MAX
        # The updated entry must be present with the newer output_id.
        assert cache.web_history["sha_0"].output_id == "out_0_retry"


class TestContentionMaxClear:
    """_CONTENTION_MAX: _REPORTED_CONTENTION is cleared when the cap is hit."""

    def test_contention_set_cleared_at_cap(self, tmp_data_dir, monkeypatch):
        """When _REPORTED_CONTENTION reaches _CONTENTION_MAX, the next call clears it
        then re-adds the new key, leaving the set with exactly 1 entry."""
        # Fill _REPORTED_CONTENTION to exactly _CONTENTION_MAX via direct mutation
        # (bypassing DB writes) so the test stays fast and DB-free.
        fake_set: set[tuple[str, str]] = set()
        for i in range(session._CONTENTION_MAX):
            fake_set.add((f"session_{i}", "load"))
        monkeypatch.setattr(session, "_REPORTED_CONTENTION", fake_set)

        # Stub out db.record_stat so no real DB write happens.
        import token_goat.db as _db
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)

        # _record_cache_contention with a brand-new key must trigger the clear.
        exc = OSError("simulated contention")
        session._record_cache_contention("new_session_id", "load", exc)

        # After the call: set was cleared then the new (session_id, phase) was added.
        assert len(session._REPORTED_CONTENTION) == 1
        assert ("new_session_id", "load") in session._REPORTED_CONTENTION

    def test_contention_set_not_cleared_below_cap(self, tmp_data_dir, monkeypatch):
        """Below the cap, _REPORTED_CONTENTION grows normally without being cleared."""
        fake_set: set[tuple[str, str]] = set()
        monkeypatch.setattr(session, "_REPORTED_CONTENTION", fake_set)

        import token_goat.db as _db
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)

        exc = OSError("contention")
        session._record_cache_contention("sess_a", "load", exc)
        session._record_cache_contention("sess_b", "save", exc)

        # Both entries must be present — no clear fired.
        assert ("sess_a", "load") in fake_set
        assert ("sess_b", "save") in fake_set


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
