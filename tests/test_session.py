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
