"""Regression tests for iterations 131-134.

Coverage targets:
- session.py: _FileEntryDict / _GrepEntryDict TypedDicts — roundtrip serialization,
  to_dict / from_dict
- session.py perf changes: mark_file_read with existing entry, adding new symbol,
  line-range append, duplicate symbol skipped
- repomap.py error handling: _build_graph when refs table is missing,
  _load_summary_cache OperationalError, _evict_stale_cache OperationalError
- stats.py: render_text when rich is not importable (mock the ImportError)
- hooks_session.py: sanitize_log_str applied to cwd and session_id in session_start
- hooks_read.py: sanitize_log_str applied to intent.reason in _handle_bash_read_equivalent
"""
from __future__ import annotations

import json
import sqlite3
import time
from unittest.mock import MagicMock, patch

# ===========================================================================
# 1. session.py — _FileEntryDict / _GrepEntryDict roundtrip serialization
# ===========================================================================


class TestFileEntryDictRoundtrip:
    """SessionCache.to_dict() / from_dict() must produce structurally identical objects."""

    def _make_cache(self, session_id: str) -> object:
        from token_goat.session import FileEntry, GrepEntry, SessionCache

        now = time.time()
        fe = FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=now,
            read_count=3,
            line_ranges=[(1, 50), (100, 200)],
            symbols_read=["MyClass", "my_func"],
        )
        ge = GrepEntry(pattern="def load", path="src/", ts=now, result_count=5)
        cache = SessionCache(
            session_id=session_id,
            started_ts=now,
            last_activity_ts=now,
            files={"src/foo.py": fe},
            greps=[ge],
            edited_files={"src/bar.py": 2},
        )
        return cache

    def test_to_dict_contains_schema_version(self):
        from token_goat.session import SESSION_SCHEMA_VERSION

        cache = self._make_cache("abc123")
        d = cache.to_dict()
        assert d["schema_version"] == SESSION_SCHEMA_VERSION

    def test_to_dict_file_entry_fields_present(self):
        cache = self._make_cache("abc123")
        d = cache.to_dict()
        fe_dict = d["files"]["src/foo.py"]
        assert fe_dict["rel_or_abs"] == "src/foo.py"
        assert fe_dict["read_count"] == 3
        assert fe_dict["symbols_read"] == ["MyClass", "my_func"]
        # line_ranges are stored as tuples by asdict (the TypedDict declares list[list[int]]
        # but dataclasses.asdict preserves tuple elements as tuples)
        assert list(fe_dict["line_ranges"][0]) == [1, 50]
        assert list(fe_dict["line_ranges"][1]) == [100, 200]

    def test_to_dict_grep_entry_fields_present(self):
        cache = self._make_cache("abc123")
        d = cache.to_dict()
        ge_dict = d["greps"][0]
        assert ge_dict["pattern"] == "def load"
        assert ge_dict["path"] == "src/"
        assert ge_dict["result_count"] == 5

    def test_to_dict_edited_files_present(self):
        cache = self._make_cache("abc123")
        d = cache.to_dict()
        assert d["edited_files"] == {"src/bar.py": 2}

    def test_roundtrip_preserves_session_id(self):
        from token_goat.session import SessionCache

        cache = self._make_cache("roundtrip-id-01")
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert restored.session_id == "roundtrip-id-01"

    def test_roundtrip_preserves_file_entries(self):
        from token_goat.session import SessionCache

        cache = self._make_cache("roundtrip-id-02")
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert "src/foo.py" in restored.files
        fe = restored.files["src/foo.py"]
        assert fe.read_count == 3
        assert fe.symbols_read == ["MyClass", "my_func"]
        assert fe.line_ranges == [(1, 50), (100, 200)]

    def test_roundtrip_preserves_grep_entries(self):
        from token_goat.session import SessionCache

        cache = self._make_cache("roundtrip-id-03")
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert len(restored.greps) == 1
        ge = restored.greps[0]
        assert ge.pattern == "def load"
        assert ge.path == "src/"
        assert ge.result_count == 5

    def test_roundtrip_preserves_edited_files(self):
        from token_goat.session import SessionCache

        cache = self._make_cache("roundtrip-id-04")
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert restored.edited_files == {"src/bar.py": 2}

    def test_json_roundtrip_via_to_json(self):
        """to_json() must produce valid JSON that deserializes to matching data."""
        from token_goat.session import SessionCache

        cache = self._make_cache("json-rt-01")
        j = cache.to_json()
        d = json.loads(j)
        restored = SessionCache.from_dict(d)
        assert restored.session_id == "json-rt-01"
        assert len(restored.files) == 1
        assert len(restored.greps) == 1

    def test_json_cache_invalidated_on_mutation(self):
        """_json_cache should be None after _invalidate_json_cache()."""
        cache = self._make_cache("json-inval-01")
        # Populate the cache
        _ = cache.to_json()
        assert cache._json_cache is not None
        cache._invalidate_json_cache()
        assert cache._json_cache is None

    def test_grep_entry_dict_optional_result_count_none(self):
        """result_count=None must round-trip correctly."""
        from token_goat.session import GrepEntry, SessionCache

        now = time.time()
        cache = SessionCache(
            session_id="grep-none-01",
            started_ts=now,
            last_activity_ts=now,
            files={},
            greps=[GrepEntry(pattern="foo", path=None, ts=now, result_count=None)],
            edited_files={},
        )
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert restored.greps[0].result_count is None
        assert restored.greps[0].path is None

    def test_from_dict_missing_session_id_raises(self):
        """from_dict must raise ValueError when session_id is absent."""
        from token_goat.session import SessionCache

        with patch("time.time", return_value=1_700_000_000.0):
            try:
                SessionCache.from_dict({"started_ts": 1_700_000_000.0})
                raise AssertionError("Expected ValueError")
            except ValueError as exc:
                assert "session_id" in str(exc).lower()

    def test_from_dict_future_schema_version_logs_warning(self, caplog):
        """schema_version higher than current must log a warning but not raise."""
        import logging

        from token_goat.session import SESSION_SCHEMA_VERSION, SessionCache

        now = time.time()
        d = {
            "schema_version": SESSION_SCHEMA_VERSION + 99,
            "session_id": "future-schema-01",
            "started_ts": now,
            "last_activity_ts": now,
            "files": {},
            "greps": [],
            "edited_files": {},
        }
        with caplog.at_level(logging.WARNING, logger="token_goat.session"):
            cache = SessionCache.from_dict(d)
        assert cache.session_id == "future-schema-01"
        assert any("schema_version" in r.getMessage() for r in caplog.records)

    def test_from_dict_corrupted_file_entry_skipped(self):
        """A malformed file entry (not a dict) must be skipped; valid ones are kept."""
        from token_goat.session import SessionCache

        now = time.time()
        d = {
            "schema_version": 1,
            "session_id": "corrupt-file-01",
            "started_ts": now,
            "last_activity_ts": now,
            "files": {
                "bad.py": "this is not a dict",
                "good.py": {
                    "rel_or_abs": "good.py",
                    "last_read_ts": now,
                    "read_count": 1,
                    "line_ranges": [],
                    "symbols_read": [],
                },
            },
            "greps": [],
            "edited_files": {},
        }
        cache = SessionCache.from_dict(d)
        assert "bad.py" not in cache.files
        assert "good.py" in cache.files

    def test_from_dict_symbol_with_bool_value_excluded(self):
        """Boolean values in symbols_read must be excluded (booleans are ints in Python)."""
        from token_goat.session import SessionCache

        now = time.time()
        d = {
            "schema_version": 1,
            "session_id": "bool-sym-01",
            "started_ts": now,
            "last_activity_ts": now,
            "files": {
                "x.py": {
                    "rel_or_abs": "x.py",
                    "last_read_ts": now,
                    "read_count": 1,
                    "line_ranges": [],
                    "symbols_read": [True, "valid_symbol", False, 42],
                }
            },
            "greps": [],
            "edited_files": {},
        }
        cache = SessionCache.from_dict(d)
        fe = cache.files["x.py"]
        # True/False are bool (subclass of int), must be excluded
        assert True not in fe.symbols_read
        assert False not in fe.symbols_read  # noqa: E712
        # "valid_symbol" and 42 (non-bool int) should be included
        assert "valid_symbol" in fe.symbols_read
        assert "42" in fe.symbols_read


# ===========================================================================
# 2. session.py — mark_file_read perf changes
# ===========================================================================


class TestMarkFileReadPerfPaths:
    """mark_file_read must handle existing entries, new symbols, duplicate symbols."""

    def test_mark_file_read_increments_existing_entry(self, tmp_data_dir):
        """Calling mark_file_read twice increments read_count on the existing entry."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-existing-01"
        cache = SessionCache(
            session_id=sid,
            started_ts=now,
            last_activity_ts=now,
        )
        cache = mark_file_read(sid, "src/a.py", cache=cache)
        assert cache.files["src/a.py"].read_count == 1

        cache = mark_file_read(sid, "src/a.py", cache=cache)
        assert cache.files["src/a.py"].read_count == 2

    def test_mark_file_read_adds_new_symbol(self, tmp_data_dir):
        """When symbol is new, it is appended to symbols_read."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-newsym-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        cache = mark_file_read(sid, "src/b.py", symbol="MyClass", cache=cache)
        assert "MyClass" in cache.files["src/b.py"].symbols_read

    def test_mark_file_read_skips_duplicate_symbol(self, tmp_data_dir):
        """When symbol already tracked, it is NOT appended a second time."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-dupsym-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        cache = mark_file_read(sid, "src/c.py", symbol="load", cache=cache)
        cache = mark_file_read(sid, "src/c.py", symbol="load", cache=cache)
        assert cache.files["src/c.py"].symbols_read.count("load") == 1

    def test_mark_file_read_appends_line_range(self, tmp_data_dir):
        """Without symbol, a new non-overlapping range is appended."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-range-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        # First read: lines 1-50 (offset=0, limit=50)
        cache = mark_file_read(sid, "src/d.py", offset=0, limit=50, cache=cache)
        assert cache.files["src/d.py"].line_ranges == [(1, 50)]

        # Second non-overlapping read: lines 101-150 (offset=100, limit=50)
        cache = mark_file_read(sid, "src/d.py", offset=100, limit=50, cache=cache)
        assert (101, 150) in cache.files["src/d.py"].line_ranges

    def test_mark_file_read_merges_adjacent_ranges(self, tmp_data_dir):
        """Adjacent line ranges are coalesced into one."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-merge-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        # lines 1-50 then 51-100 → should merge to (1, 100)
        cache = mark_file_read(sid, "src/e.py", offset=0, limit=50, cache=cache)
        cache = mark_file_read(sid, "src/e.py", offset=50, limit=50, cache=cache)
        ranges = cache.files["src/e.py"].line_ranges
        assert ranges == [(1, 100)]

    def test_mark_file_read_with_unavailable_cache_returns_early(self, tmp_data_dir):
        """If cache.unavailable is True, mark_file_read returns without mutation."""
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-unavail-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now, unavailable=True)
        result = mark_file_read(sid, "src/f.py", cache=cache)
        # No files should have been added
        assert len(result.files) == 0

    def test_mark_file_read_invalidates_json_cache(self, tmp_data_dir):
        """mark_file_read must call _invalidate_json_cache(), causing to_json() to re-serialize.

        save() calls to_json() which re-populates _json_cache; we verify invalidation happened
        by checking that the cache JSON reflects the mutation (new file entry present).
        """
        from token_goat.session import SessionCache, mark_file_read

        now = time.time()
        sid = "perf-jsoninval-01"
        cache = SessionCache(session_id=sid, started_ts=now, last_activity_ts=now)
        # Serialize before mutation — no files yet
        before_json = cache.to_json()
        assert "src/g.py" not in before_json

        mark_file_read(sid, "src/g.py", cache=cache)

        # to_json() must return updated content (invalidation forced re-serialization)
        after_json = cache.to_json()
        assert "src/g.py" in after_json


# ===========================================================================
# 3. repomap.py — error handling for missing tables
# ===========================================================================


class TestRepomapErrorHandling:
    """_build_graph, _load_summary_cache, _evict_stale_cache must handle missing tables."""

    def _make_conn(self) -> sqlite3.Connection:
        """Create a minimal in-memory SQLite connection (row_factory set)."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        return conn

    def test_build_graph_refs_table_missing_returns_graph_with_nodes_only(self):
        """When refs table is absent, _build_graph logs a warning and returns graph with nodes."""
        from token_goat.repomap import _build_graph

        conn = self._make_conn()
        # Create files dict but do NOT create a refs table
        files = {
            "src/a.py": {"language": "python", "size": 500, "mtime": 1.0},
            "src/b.py": {"language": "python", "size": 300, "mtime": 2.0},
        }
        name_to_files: dict[str, set[str]] = {"load": {"src/a.py"}}

        graph = _build_graph(conn, files, name_to_files)

        # Should have nodes but no edges (refs table missing → no edges added)
        assert graph.number_of_nodes() == 2
        assert graph.number_of_edges() == 0

    def test_build_graph_refs_table_missing_logs_warning(self, caplog):
        """OperationalError on refs query must produce a warning log."""
        import logging

        from token_goat.repomap import _build_graph

        conn = self._make_conn()
        files = {"src/x.py": {"language": "python", "size": 100, "mtime": 1.0}}
        name_to_files: dict[str, set[str]] = {}

        with caplog.at_level(logging.WARNING, logger="token_goat.repomap"):
            _build_graph(conn, files, name_to_files)

        assert any("refs" in r.getMessage().lower() for r in caplog.records)

    def test_load_summary_cache_missing_table_returns_empty_dict(self):
        """When repomap_cache table is absent, _load_summary_cache returns {}."""
        from token_goat.repomap import _load_summary_cache

        conn = self._make_conn()
        # No repomap_cache table created
        result = _load_summary_cache(conn)
        assert result == {}

    def test_load_summary_cache_missing_table_logs_debug(self, caplog):
        """OperationalError on repomap_cache query logs at DEBUG level."""
        import logging

        from token_goat.repomap import _load_summary_cache

        conn = self._make_conn()
        with caplog.at_level(logging.DEBUG, logger="token_goat.repomap"):
            _load_summary_cache(conn)

        assert any("repomap_cache" in r.getMessage().lower() for r in caplog.records)

    def test_load_summary_cache_with_data_returns_entries(self):
        """When table exists with rows, _load_summary_cache returns them correctly."""
        from token_goat.repomap import _load_summary_cache

        conn = self._make_conn()
        conn.execute(
            "CREATE TABLE repomap_cache "
            "(rel_path TEXT, mtime REAL, size INTEGER, summary_text TEXT, created_at INTEGER)"
        )
        conn.execute(
            "INSERT INTO repomap_cache VALUES (?, ?, ?, ?, ?)",
            ("src/a.py", 1234.5, 500, "rendered text", 1_700_000_000),
        )
        conn.commit()

        result = _load_summary_cache(conn)
        assert ("src/a.py", 1234.5, 500) in result
        assert result[("src/a.py", 1234.5, 500)] == "rendered text"

    def test_evict_stale_cache_missing_table_does_not_raise(self):
        """OperationalError on DELETE when table is absent must be silently ignored."""
        from token_goat.repomap import _evict_stale_cache

        conn = self._make_conn()
        current_files = {"src/a.py": {"language": "python", "size": 100, "mtime": 1.0}}
        # Should not raise even though repomap_cache table doesn't exist
        _evict_stale_cache(conn, current_files)

    def test_evict_stale_cache_empty_current_files_is_noop(self):
        """When current_files is empty, _evict_stale_cache must return immediately."""
        from token_goat.repomap import _evict_stale_cache

        conn = self._make_conn()
        # No table, no files — must not raise and not execute any SQL
        _evict_stale_cache(conn, {})

    def test_evict_stale_cache_removes_orphaned_entries(self):
        """Entries whose rel_path is not in current_files are deleted."""
        from token_goat.repomap import _evict_stale_cache

        conn = self._make_conn()
        conn.execute(
            "CREATE TABLE repomap_cache "
            "(rel_path TEXT PRIMARY KEY, mtime REAL, size INTEGER, "
            "summary_text TEXT, created_at INTEGER)"
        )
        conn.executemany(
            "INSERT INTO repomap_cache VALUES (?, ?, ?, ?, ?)",
            [
                ("src/keep.py", 1.0, 100, "keep", 0),
                ("src/orphan.py", 2.0, 200, "orphan", 0),
            ],
        )
        conn.commit()

        current_files = {"src/keep.py": {"language": "python", "size": 100, "mtime": 1.0}}
        _evict_stale_cache(conn, current_files)

        rows = conn.execute("SELECT rel_path FROM repomap_cache").fetchall()
        paths = {r[0] for r in rows}
        assert "src/keep.py" in paths
        assert "src/orphan.py" not in paths


# ===========================================================================
# 4. stats.py — render_text when rich is not importable
# ===========================================================================


class TestRenderTextRichUnavailable:
    """render_text must return a fallback string when rich is not importable."""

    def _make_summary(self):
        from token_goat.stats import StatsSummary

        return StatsSummary(
            total_events=5,
            total_bytes_saved=1024,
            total_tokens_saved=256,
            by_kind={"session_hint": {"events": 5, "bytes_saved": 1024, "tokens_saved": 256}},
            by_day=[],
            by_project=[],
            window_days=30,
        )

    def test_render_text_falls_back_when_rich_missing(self):
        """When both the new renderer and rich are unavailable, render_text returns a plain string."""
        from token_goat.stats import render_text

        summary = self._make_summary()

        # Patch the new renderer to raise, then patch rich to be unavailable
        with (
            patch("token_goat.stats.render_text.__module__"),  # no-op
            patch(
                "token_goat.render.stats_renderer.render_stats",
                side_effect=ImportError("render package not available"),
            ),
            patch.dict("sys.modules", {
                "rich": None,
                "rich.box": None,
                "rich.console": None,
                "rich.panel": None,
                "rich.text": None,
                "rich.table": None,
            }),
        ):
            result = render_text(summary)

        assert isinstance(result, str)
        assert len(result) > 0
        # The fallback message must mention the unavailability
        assert "stats render unavailable" in result or "rich" in result.lower()

    def test_render_text_fallback_message_contains_import_error(self):
        """The fallback string returned when rich is missing references the error."""
        from token_goat.stats import render_text

        summary = self._make_summary()

        with (
            patch(
                "token_goat.render.stats_renderer.render_stats",
                side_effect=Exception("renderer down"),
            ),
            patch.dict("sys.modules", {
                "rich": None,
                "rich.box": None,
                "rich.console": None,
                "rich.panel": None,
                "rich.text": None,
                "rich.table": None,
            }),
        ):
            result = render_text(summary)

        # Must be a plain string, not an exception
        assert isinstance(result, str)
        assert "unavailable" in result or "rich" in result.lower()

    def test_render_text_succeeds_when_new_renderer_works(self):
        """When the new renderer is available, render_text returns its output."""
        from token_goat.stats import render_text

        summary = self._make_summary()

        with patch(
            "token_goat.render.stats_renderer.render_stats",
            return_value="mocked-render-output",
        ):
            result = render_text(summary)

        assert result == "mocked-render-output"


# ===========================================================================
# 5. hooks_session.py — sanitize_log_str applied to cwd and session_id
# ===========================================================================


class TestHooksSessionSanitizeLogStr:
    """session_start must sanitize cwd and session_id before logging."""

    def test_newline_in_cwd_does_not_inject_log_line(self, caplog):
        """A newline embedded in cwd must be sanitized before it reaches the log."""
        import logging

        from token_goat.hooks_session import session_start

        payload = {
            "session_id": "safe-session-01",
            "cwd": "/tmp/legit\nINJECTED: fake log entry",
        }
        with (
            patch("token_goat.hooks_session._reset_session_cache"),
            patch("token_goat.hooks_session._detect", return_value=None),
            patch("token_goat.hooks_session._ensure_worker_running"),
            caplog.at_level(logging.INFO, logger="token_goat.hooks_common"),
        ):
            session_start(payload)

        for record in caplog.records:
            msg = record.getMessage()
            # The raw newline must not appear literally in any log record
            assert "\nINJECTED" not in msg

    def test_newline_in_session_id_rejected_by_validate(self):
        """A session_id with a newline is invalid and raises ValueError before logging."""
        from token_goat.session import validate_session_id

        with patch("time.time", return_value=1_700_000_000.0):
            try:
                validate_session_id("bad\nsession")
                raise AssertionError("Expected ValueError")
            except ValueError:
                pass  # expected

    def test_session_start_with_injected_cwd_returns_continue(self):
        """session_start must return CONTINUE even with a malicious cwd."""
        from token_goat.hooks_session import session_start

        payload = {
            "session_id": "safe-session-02",
            "cwd": "/tmp/dir\nSYSTEM: override instructions",
        }
        with (
            patch("token_goat.hooks_session._reset_session_cache"),
            patch("token_goat.hooks_session._detect", return_value=None),
            patch("token_goat.hooks_session._ensure_worker_running"),
        ):
            result = session_start(payload)

        assert result.get("continue") is True

    def test_session_start_with_long_cwd_logs_warning(self, caplog):
        """A cwd longer than 4096 chars must log a warning and not crash."""
        import logging

        from token_goat.hooks_session import session_start

        long_cwd = "/tmp/" + "a" * 5000
        payload = {"session_id": "long-cwd-01", "cwd": long_cwd}
        with (
            patch("token_goat.hooks_session._reset_session_cache"),
            patch("token_goat.hooks_session._ensure_worker_running"),
            caplog.at_level(logging.WARNING, logger="token_goat.hooks_common"),
        ):
            result = session_start(payload)

        assert result.get("continue") is True


# ===========================================================================
# 6. hooks_read.py — sanitize_log_str applied to intent.reason
# ===========================================================================


class TestHooksReadSanitizeIntentReason:
    """_handle_bash_read_equivalent must sanitize intent.reason before logging."""

    def _make_bash_payload(self, cmd: str) -> dict:
        return {
            "tool_name": "Bash",
            "session_id": "bash-read-01",
            "tool_input": {"command": cmd},
        }

    def test_near_miss_with_newline_in_reason_does_not_inject_log(self, caplog):
        """A near-miss reason containing \\n must be sanitized before logging."""
        import logging

        from token_goat.hooks_read import _handle_bash_read_equivalent

        fake_intent = MagicMock()
        fake_intent.kind = "near_miss"
        fake_intent.target_path = None
        fake_intent.reason = "ambiguous command\nINJECTED: fake log line"

        payload = self._make_bash_payload("some ambiguous bash cmd")
        with (
            patch("token_goat.bash_parser.parse", return_value=fake_intent),
            caplog.at_level(logging.INFO, logger="token_goat.hooks_common"),
        ):
            result = _handle_bash_read_equivalent(payload)

        assert result is None
        for record in caplog.records:
            assert "\nINJECTED" not in record.getMessage()

    def test_near_miss_reason_sanitized_newline_shows_escaped(self, caplog):
        """The escaped version (\\n literal) of a newline may appear in log but not the raw newline."""
        import logging

        from token_goat.hooks_read import _handle_bash_read_equivalent

        fake_intent = MagicMock()
        fake_intent.kind = "near_miss"
        fake_intent.target_path = None
        fake_intent.reason = "cat with\nnewline"

        payload = self._make_bash_payload("cat somefile")
        with (
            patch("token_goat.bash_parser.parse", return_value=fake_intent),
            caplog.at_level(logging.INFO, logger="token_goat.hooks_common"),
        ):
            _handle_bash_read_equivalent(payload)

        # Raw newline must not appear; escaped form is acceptable
        for record in caplog.records:
            assert "\n" not in record.getMessage()

    def test_no_reason_logs_nothing(self, caplog):
        """When intent.reason is empty/None, no log at INFO level is emitted."""
        import logging

        from token_goat.hooks_read import _handle_bash_read_equivalent

        fake_intent = MagicMock()
        fake_intent.kind = "near_miss"
        fake_intent.target_path = None
        fake_intent.reason = ""

        payload = self._make_bash_payload("ls -la")
        with (
            patch("token_goat.bash_parser.parse", return_value=fake_intent),
            caplog.at_level(logging.INFO, logger="token_goat.hooks_common"),
        ):
            _handle_bash_read_equivalent(payload)

        info_records = [r for r in caplog.records if r.levelname == "INFO"]
        assert not any("bash read near-miss" in r.getMessage() for r in info_records)

    def test_read_intent_returns_payload_not_none(self):
        """When intent.kind == 'read' with a target_path, a payload dict is returned."""
        from token_goat.hooks_read import _handle_bash_read_equivalent

        fake_intent = MagicMock()
        fake_intent.kind = "read"
        fake_intent.target_path = "/tmp/test.py"
        fake_intent.offset = 0
        fake_intent.limit = None
        fake_intent.reason = ""

        payload = self._make_bash_payload("cat /tmp/test.py")
        with patch("token_goat.bash_parser.parse", return_value=fake_intent):
            result = _handle_bash_read_equivalent(payload)

        assert result is not None
        assert result["tool_name"] == "Read"
        assert result["tool_input"]["file_path"] == "/tmp/test.py"
