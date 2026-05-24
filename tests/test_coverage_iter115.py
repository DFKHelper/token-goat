"""Regression tests for iterations 111-114.

Coverage targets:
- stats.py: _StatsBucket TypedDict structure; _to_stats_data date-parse failure fallback
- repomap.py: graceful degradation when DB tables (symbols, sections, files) are missing
- hooks_cli.py: dispatch() event-name sanitization via safe_event
- webfetch.py: _sanitize_header_value strips \\r and \\n from ETag/Last-Modified
- session.py: _SessionDict TypedDict wire-format roundtrip (to_dict / from_dict symmetry)
- compact.py: heapq.nlargest path for top-k session files when cache has >_MAX_FILES_READ entries
- embeddings.py: embed_texts() generator paths — empty input, dimension mismatch, non-array return
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import date, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# stats.py
# ---------------------------------------------------------------------------


class TestStatsBucketTypedDict:
    """_StatsBucket is a TypedDict with three integer fields.

    These tests verify the accumulator helpers use the right keys and that
    _zero_bucket() returns a properly zeroed value — the minimal interface
    that the rest of stats.py depends on.
    """

    def test_zero_bucket_has_correct_keys(self):
        from token_goat.stats import _zero_bucket

        b = _zero_bucket()
        assert set(b.keys()) == {"events", "bytes_saved", "tokens_saved"}

    def test_zero_bucket_all_zeros(self):
        from token_goat.stats import _zero_bucket

        b = _zero_bucket()
        assert b["events"] == 0
        assert b["bytes_saved"] == 0
        assert b["tokens_saved"] == 0

    def test_inc_bucket_increments_all_fields(self):
        from token_goat.stats import _inc_bucket, _zero_bucket

        b = _zero_bucket()
        _inc_bucket(b, bytes_saved=100, tokens_saved=50)
        assert b["events"] == 1
        assert b["bytes_saved"] == 100
        assert b["tokens_saved"] == 50

    def test_inc_bucket_accumulates_across_calls(self):
        from token_goat.stats import _inc_bucket, _zero_bucket

        b = _zero_bucket()
        _inc_bucket(b, 200, 80)
        _inc_bucket(b, 300, 120)
        assert b["events"] == 2
        assert b["bytes_saved"] == 500
        assert b["tokens_saved"] == 200


class TestToStatsDataDateParseFallback:
    """_to_stats_data must fall back to today when by_day[-1]['date'] is malformed."""

    def _make_summary(self, by_day_date_str: str, window_days: int = 0):
        from token_goat.stats import StatsSummary, _StatsBucket

        day: Any = {"date": by_day_date_str, "events": 1, "bytes_saved": 500, "tokens_saved": 10}
        bucket: _StatsBucket = {"events": 1, "bytes_saved": 500, "tokens_saved": 10}
        return StatsSummary(
            total_events=1,
            total_bytes_saved=500,
            total_tokens_saved=10,
            by_kind={"image_shrink": bucket},
            by_day=[day],
            by_project=[],
            window_days=window_days,
        )

    def test_valid_date_string_parsed_correctly(self):
        from token_goat.stats import _to_stats_data

        summary = self._make_summary("2025-01-15", window_days=0)
        data = _to_stats_data(summary)
        assert data.period_start == date(2025, 1, 15)

    def test_malformed_date_falls_back_to_today(self):
        """A corrupt DB row with an invalid date must not crash — fall back to today."""
        from token_goat.stats import _to_stats_data

        summary = self._make_summary("not-a-date", window_days=0)
        data = _to_stats_data(summary)
        # Should not raise; period_start should be today (fallback)
        assert data.period_start == date.today()

    def test_window_days_positive_ignores_by_day(self):
        """When window_days > 0 the period_start is computed from today, not by_day."""
        from token_goat.stats import _to_stats_data

        summary = self._make_summary("not-a-date", window_days=30)
        data = _to_stats_data(summary)
        expected = date.today() - timedelta(days=30)
        assert data.period_start == expected

    def test_empty_by_day_with_window_zero_falls_back_to_today(self):
        """window_days=0 with empty by_day must also fall back gracefully."""
        from token_goat.stats import StatsSummary, _to_stats_data

        summary = StatsSummary(
            total_events=0,
            total_bytes_saved=0,
            total_tokens_saved=0,
            by_kind={},
            by_day=[],
            by_project=[],
            window_days=0,
        )
        data = _to_stats_data(summary)
        assert data.period_start == date.today()


# ---------------------------------------------------------------------------
# repomap.py — graceful degradation when DB tables are missing
# ---------------------------------------------------------------------------


class TestRepomapGracefulDegradation:
    """_load_project_data must degrade gracefully when auxiliary tables are absent."""

    def _make_conn(self, with_files: bool = True, with_symbols: bool = True, with_sections: bool = True) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        if with_files:
            conn.execute(
                "CREATE TABLE files (rel_path TEXT, language TEXT, size INTEGER, mtime REAL)"
            )
            conn.execute(
                "INSERT INTO files VALUES ('src/a.py', 'python', 500, 1700000000.0)"
            )
        if with_symbols:
            conn.execute(
                "CREATE TABLE symbols (name TEXT, kind TEXT, file_rel TEXT)"
            )
            conn.execute("INSERT INTO symbols VALUES ('my_func', 'function', 'src/a.py')")
        if with_sections:
            conn.execute(
                "CREATE TABLE sections (file_rel TEXT, heading TEXT, level INTEGER, line INTEGER)"
            )
            conn.execute("INSERT INTO sections VALUES ('src/a.py', 'Intro', 1, 1)")
        conn.commit()
        return conn

    def test_missing_symbols_table_does_not_raise(self):
        from token_goat.repomap import _load_project_data

        conn = self._make_conn(with_files=True, with_symbols=False, with_sections=True)
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        assert "src/a.py" in files
        # symbols_by_file should be empty (table absent)
        assert len(symbols_by_file) == 0

    def test_missing_sections_table_does_not_raise(self):
        from token_goat.repomap import _load_project_data

        conn = self._make_conn(with_files=True, with_symbols=True, with_sections=False)
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        assert "src/a.py" in files
        assert len(symbols_by_file) == 1
        # sections_by_file should be empty (table absent)
        assert len(sections_by_file) == 0

    def test_missing_files_table_returns_empty_dicts(self):
        """When the files table itself is missing, return all-empty with no crash."""
        from token_goat.repomap import _load_project_data

        conn = self._make_conn(with_files=False, with_symbols=False, with_sections=False)
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        assert files == {}
        assert len(symbols_by_file) == 0
        assert len(sections_by_file) == 0
        assert len(name_to_files) == 0

    def test_all_tables_present_loads_correctly(self):
        from token_goat.repomap import _load_project_data

        conn = self._make_conn(with_files=True, with_symbols=True, with_sections=True)
        files, symbols_by_file, sections_by_file, name_to_files = _load_project_data(conn)
        assert "src/a.py" in files
        assert files["src/a.py"]["language"] == "python"
        assert ("function", "my_func") in symbols_by_file["src/a.py"]
        assert (1, "Intro") in sections_by_file["src/a.py"]


# ---------------------------------------------------------------------------
# hooks_cli.py — dispatch() event-name sanitization (safe_event)
# ---------------------------------------------------------------------------


class TestDispatchSafeEvent:
    """dispatch() must sanitize the event name before logging it."""

    def test_dispatch_unknown_event_returns_continue(self):
        from token_goat import hooks_cli

        result = hooks_cli.dispatch("totally-unknown-event-xyz", {})
        assert result.get("continue") is True

    def test_dispatch_event_with_newline_sanitized(self, caplog):
        """An event name with \\n must not appear raw in the log — it is sanitized."""
        import logging

        from token_goat import hooks_cli

        with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
            hooks_cli.dispatch("bad-event\nX-Injected: evil", {})
        # The raw newline must not appear in any log record message
        for record in caplog.records:
            assert "\n" not in record.getMessage(), "raw newline leaked into log output"

    def test_dispatch_event_with_cr_sanitized(self, caplog):
        """An event name with \\r must be stripped before logging."""
        import logging

        from token_goat import hooks_cli

        with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
            hooks_cli.dispatch("bad\revent", {})
        for record in caplog.records:
            assert "\r" not in record.getMessage(), "raw CR leaked into log output"

    def test_dispatch_event_name_truncated_in_safe_event(self, caplog):
        """An event name longer than 64 chars must be truncated by sanitize_log_str."""
        import logging

        from token_goat import hooks_cli

        long_event = "A" * 200
        with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
            hooks_cli.dispatch(long_event, {})
        # The raw 200-char string must not appear verbatim
        for record in caplog.records:
            assert long_event not in record.getMessage(), "full overlong event name leaked into log"


# ---------------------------------------------------------------------------
# webfetch.py — _sanitize_header_value
# ---------------------------------------------------------------------------


class TestSanitizeHeaderValue:
    """_sanitize_header_value must strip \\r and \\n from header values."""

    def test_strips_newline(self):
        from token_goat.webfetch import _sanitize_header_value

        result = _sanitize_header_value('abc\nX-Injected: evil')
        assert "\n" not in result
        assert result == "abcX-Injected: evil"

    def test_strips_carriage_return(self):
        from token_goat.webfetch import _sanitize_header_value

        result = _sanitize_header_value('abc\rdef')
        assert "\r" not in result
        assert result == "abcdef"

    def test_strips_both_crlf(self):
        from token_goat.webfetch import _sanitize_header_value

        result = _sanitize_header_value('"etag-value"\r\nX-Evil: injected')
        assert "\r" not in result
        assert "\n" not in result

    def test_truncates_to_max_len(self):
        from token_goat.webfetch import _sanitize_header_value

        long_val = "x" * 600
        result = _sanitize_header_value(long_val, max_len=512)
        assert len(result) == 512

    def test_clean_value_returned_unchanged(self):
        from token_goat.webfetch import _sanitize_header_value

        result = _sanitize_header_value('"abc123"')
        assert result == '"abc123"'

    def test_empty_string_safe(self):
        from token_goat.webfetch import _sanitize_header_value

        assert _sanitize_header_value("") == ""

    def test_write_cache_meta_sanitizes_etag(self, tmp_path):
        """_write_cache_meta must sanitize ETag header before writing to sidecar."""

        import httpx

        from token_goat.webfetch import _write_cache_meta

        cache_file = tmp_path / "cached.jpg"
        cache_file.write_bytes(b"fake")
        headers = httpx.Headers({"etag": '"good"\r\nX-Inject: evil', "last-modified": "Wed, 21 Oct 2023 07:28:00 GMT"})
        _write_cache_meta(cache_file, headers)
        sidecar = cache_file.with_suffix(".jpg.meta")
        assert sidecar.exists()
        meta = json.loads(sidecar.read_text())
        assert "\r" not in meta.get("etag", "")
        assert "\n" not in meta.get("etag", "")


# ---------------------------------------------------------------------------
# session.py — _SessionDict TypedDict wire-format roundtrip
# ---------------------------------------------------------------------------


class TestSessionDictRoundtrip:
    """SessionCache.to_dict() / from_dict() must be symmetric."""

    def _make_cache(self, session_id: str = "test-session-abc") -> Any:
        from token_goat.session import FileEntry, GrepEntry, SessionCache

        now = time.time()
        cache = SessionCache(
            session_id=session_id,
            started_ts=now - 100,
            last_activity_ts=now,
        )
        cache.files["src/a.py"] = FileEntry(
            rel_or_abs="src/a.py",
            last_read_ts=now,
            read_count=3,
            line_ranges=[(1, 50), (100, 150)],
            symbols_read=["MyClass", "my_func"],
        )
        cache.greps.append(GrepEntry(pattern="def foo", path="src/", ts=now, result_count=5))
        cache.edited_files["src/b.py"] = 2
        return cache

    def test_to_dict_has_schema_version(self):
        from token_goat.session import SESSION_SCHEMA_VERSION

        cache = self._make_cache()
        d = cache.to_dict()
        assert d["schema_version"] == SESSION_SCHEMA_VERSION

    def test_to_dict_has_created_by(self):
        cache = self._make_cache()
        d = cache.to_dict()
        assert d["created_by"] == "token-goat"

    def test_to_dict_session_id_preserved(self):
        cache = self._make_cache("roundtrip-session-1")
        d = cache.to_dict()
        assert d["session_id"] == "roundtrip-session-1"

    def test_from_dict_restores_file_entry(self):
        from token_goat.session import SessionCache

        cache = self._make_cache()
        d = cache.to_dict()
        restored = SessionCache.from_dict(d)
        assert "src/a.py" in restored.files
        entry = restored.files["src/a.py"]
        assert entry.read_count == 3
        assert (1, 50) in entry.line_ranges
        assert "MyClass" in entry.symbols_read

    def test_from_dict_restores_grep_entry(self):
        from token_goat.session import SessionCache

        cache = self._make_cache()
        restored = SessionCache.from_dict(cache.to_dict())
        assert len(restored.greps) == 1
        assert restored.greps[0].pattern == "def foo"
        assert restored.greps[0].result_count == 5

    def test_from_dict_restores_edited_files(self):
        from token_goat.session import SessionCache

        cache = self._make_cache()
        restored = SessionCache.from_dict(cache.to_dict())
        assert restored.edited_files.get("src/b.py") == 2

    def test_json_roundtrip_symmetric(self):
        """to_json() -> json.loads() -> from_dict() must reproduce the cache."""
        from token_goat.session import SessionCache

        cache = self._make_cache()
        raw = cache.to_json()
        restored = SessionCache.from_dict(json.loads(raw))
        assert restored.session_id == cache.session_id
        assert len(restored.files) == len(cache.files)
        assert len(restored.greps) == len(cache.greps)


# ---------------------------------------------------------------------------
# compact.py — heapq.nlargest path when files > _MAX_FILES_READ
# ---------------------------------------------------------------------------


class TestCompactHeapqNlargest:
    """_render should use heapq.nlargest to pick top files by read_count when
    there are more than _MAX_FILES_READ entries in the session cache."""

    def _make_session_with_many_files(self, tmp_data_dir, count: int = 15) -> Any:
        from token_goat import session as session_mod

        sid = "compact-nlargest-test"
        cache = session_mod._fresh_cache(sid)
        for i in range(count):
            path = f"src/file_{i:03d}.py"
            cache.files[path] = session_mod.FileEntry(
                rel_or_abs=path,
                last_read_ts=time.time(),
                read_count=i + 1,  # unique counts so nlargest has clear winners
                line_ranges=[],
                symbols_read=[],
            )
        cache.edited_files["src/important.py"] = 1
        return sid, cache

    def test_top_files_by_read_count_selected(self, tmp_data_dir):
        """heapq.nlargest must select the 10 highest read_count files, not just any 10."""
        from token_goat.compact import _render

        sid, cache = self._make_session_with_many_files(tmp_data_dir, count=15)
        manifest, _ = _render(cache, sid, max_tokens=2000)
        # file_014 has read_count=15 (highest) and must appear; file_000 has count=1 (lowest)
        assert "file_014" in manifest, "highest-read_count file must appear in manifest"

    def test_manifest_lists_at_most_max_files_read(self, tmp_data_dir):
        """Even with 20 session files, only _MAX_FILES_READ appear in the Key Files section."""
        from token_goat.compact import _MAX_FILES_READ, _render

        sid, cache = self._make_session_with_many_files(tmp_data_dir, count=20)
        manifest, _ = _render(cache, sid, max_tokens=5000)
        key_files_section = manifest.split("**Files:**")[-1] if "**Files:**" in manifest else ""
        # Count how many "file_NNN" entries are in the Key Files section
        import re
        entries = re.findall(r"file_\d{3}", key_files_section)
        assert len(entries) <= _MAX_FILES_READ

    def test_no_crash_with_exactly_max_files(self, tmp_data_dir):
        """Exactly _MAX_FILES_READ files must produce a valid manifest without errors."""
        from token_goat.compact import _MAX_FILES_READ, _render

        sid, cache = self._make_session_with_many_files(tmp_data_dir, count=_MAX_FILES_READ)
        manifest, _ = _render(cache, sid, max_tokens=2000)
        assert "**Files:**" in manifest


# ---------------------------------------------------------------------------
# embeddings.py — generator expression paths
# ---------------------------------------------------------------------------


class TestEmbedTextsGeneratorPaths:
    """embed_texts() must handle edge-cases in its generator loop."""

    def test_empty_input_returns_empty_list(self):
        """embed_texts([]) must return [] without loading the model."""
        from token_goat.embeddings import embed_texts

        result = embed_texts([])
        assert result == []

    def test_non_array_return_raises_embeddings_unavailable(self):
        """embed_texts() must raise EmbeddingsUnavailable when model.embed() yields
        an object that lacks .tolist() — e.g. a plain string or integer."""
        from token_goat.embeddings import EmbeddingsUnavailable, embed_texts

        # Build a fake model whose embed() yields a plain dict (no .tolist())
        fake_model = MagicMock()
        fake_model.embed.return_value = iter([{"not": "an array"}])

        with patch("token_goat.embeddings._get_model", return_value=fake_model), pytest.raises(EmbeddingsUnavailable, match="non-array"):
            embed_texts(["hello world"])

    def test_dimension_mismatch_raises_embeddings_unavailable(self):
        """embed_texts() must raise EmbeddingsUnavailable when the model returns
        a vector with the wrong number of dimensions (not 384 for the default model)."""
        from token_goat.embeddings import DEFAULT_MODEL, EmbeddingsUnavailable, embed_texts

        wrong_dim_arr = MagicMock()
        wrong_dim_arr.tolist.return_value = [0.1] * 128  # 128 dims, not 384

        fake_model = MagicMock()
        fake_model.embed.return_value = iter([wrong_dim_arr])

        with patch("token_goat.embeddings._get_model", return_value=fake_model), pytest.raises(EmbeddingsUnavailable, match="[Dd]imension"):
            embed_texts(["hello world"], model_name=DEFAULT_MODEL)

    def test_successful_embedding_returns_correct_shape(self):
        """embed_texts() must return one vector per input text with correct dimensionality."""
        from token_goat.embeddings import DEFAULT_DIM, DEFAULT_MODEL, embed_texts

        vec = MagicMock()
        vec.tolist.return_value = [0.01] * DEFAULT_DIM

        fake_model = MagicMock()
        fake_model.embed.return_value = iter([vec, vec])

        with patch("token_goat.embeddings._get_model", return_value=fake_model):
            result = embed_texts(["first text", "second text"], model_name=DEFAULT_MODEL)

        assert len(result) == 2
        assert len(result[0]) == DEFAULT_DIM

    def test_runtime_error_from_embed_raises_embeddings_unavailable(self):
        """If model.embed() raises RuntimeError mid-iteration, wrap it as EmbeddingsUnavailable."""
        from token_goat.embeddings import EmbeddingsUnavailable, embed_texts

        def _bad_iter():
            raise RuntimeError("ONNX session error")
            yield  # make it a generator

        fake_model = MagicMock()
        fake_model.embed.return_value = _bad_iter()

        with patch("token_goat.embeddings._get_model", return_value=fake_model), pytest.raises(EmbeddingsUnavailable, match="iteration failed"):
            embed_texts(["some text"])
