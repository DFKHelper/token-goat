"""Tests covering sanitize_log_str bidi chars, paths.open_log_file, db indexes,
session.load with corrupt JSON, compact event_count / build_manifest,
hints.build_read_hint, cli exit codes, and read_replacement types."""
from __future__ import annotations

import logging
import os
import sqlite3
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat.hooks_common import _BIDI_CONTROLS, sanitize_log_str

# ---------------------------------------------------------------------------
# 1. sanitize_log_str bidi character stripping
# ---------------------------------------------------------------------------

class TestSanitizeLogStrBidiChars:
    """Individual bidi control chars and combined cases."""

    def test_u202a_left_to_right_embedding_stripped(self):
        # U+202A LEFT-TO-RIGHT EMBEDDING
        ch = "‪"
        result = sanitize_log_str(f"before{ch}after")
        assert ch not in result
        assert result == "beforeafter"

    def test_u200f_right_to_left_mark_stripped(self):
        # U+200F RIGHT-TO-LEFT MARK
        ch = "‏"
        result = sanitize_log_str(f"hello{ch}world")
        assert ch not in result
        assert result == "helloworld"

    def test_u2066_left_to_right_isolate_stripped(self):
        # U+2066 LEFT-TO-RIGHT ISOLATE
        ch = "⁦"
        result = sanitize_log_str(f"open{ch}close")
        assert ch not in result
        assert result == "openclose"

    def test_u202e_right_to_left_override_stripped(self):
        # U+202E RIGHT-TO-LEFT OVERRIDE — classic "evil.exe" attack vector
        ch = "‮"
        result = sanitize_log_str(f"exe.{ch}live")
        assert ch not in result
        assert result == "exe.live"

    def test_u200e_left_to_right_mark_stripped(self):
        # U+200E LEFT-TO-RIGHT MARK
        ch = "‎"
        result = sanitize_log_str(f"a{ch}b")
        assert ch not in result
        assert result == "ab"

    def test_normal_ascii_unchanged(self):
        text = "hello world 123 !@#"
        assert sanitize_log_str(text) == text

    def test_mixed_bidi_and_ascii_cleaned(self):
        # Mix multiple bidi chars with ASCII content
        bad = "file‮‏‪name.txt"
        result = sanitize_log_str(bad)
        for ch in _BIDI_CONTROLS:
            assert ch not in result
        assert "file" in result
        assert "name.txt" in result

    def test_all_bidi_controls_stripped_completely(self):
        # All 11 bidi controls concatenated together
        blob = "A" + "".join(_BIDI_CONTROLS) + "Z"
        result = sanitize_log_str(blob)
        assert result == "AZ"

    def test_newline_stripped_independently(self):
        # Newlines are stripped separately from bidi chars
        result = sanitize_log_str("line1\nline2")
        assert "\n" not in result
        assert "line1" in result
        assert "line2" in result

    def test_bidi_inside_path_neutralised(self):
        path = "/tmp/‮evil‏/file.log"
        result = sanitize_log_str(path)
        assert "‮" not in result
        assert "‏" not in result
        assert "/tmp/" in result

    def test_truncation_applied_after_stripping(self):
        # Build a string that is longer than max_len after stripping
        text = "x" * 300
        result = sanitize_log_str(text, max_len=100)
        assert len(result) <= 101 + 1  # 100 chars + "…"
        assert result.endswith("…")


# ---------------------------------------------------------------------------
# 2. paths.open_log_file
# ---------------------------------------------------------------------------

class TestOpenLogFile:
    """open_log_file returns a usable handler and honours POSIX 0o600 perms."""

    def test_returns_handler_on_windows(self, tmp_path):
        from token_goat.paths import open_log_file
        log_file = tmp_path / "test.log"
        handler = open_log_file(log_file)
        try:
            assert handler is not None
            assert isinstance(handler, (logging.FileHandler, logging.StreamHandler))
        finally:
            handler.close()

    def test_handler_is_writable(self, tmp_path):
        from token_goat.paths import open_log_file
        log_file = tmp_path / "writable.log"
        handler = open_log_file(log_file)
        try:
            logger = logging.getLogger("test_open_log_file_writable")
            logger.addHandler(handler)
            logger.setLevel(logging.DEBUG)
            logger.debug("test message iter275")
            logger.removeHandler(handler)
        finally:
            handler.close()
        # File should exist after writing
        assert log_file.exists()

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions only")
    def test_posix_file_created_with_0o600(self, tmp_path):
        from token_goat.paths import open_log_file
        log_file = tmp_path / "secure.log"
        handler = open_log_file(log_file)
        try:
            # Force flush so the file is on disk
            pass
        finally:
            handler.close()
        stat_result = os.stat(log_file)
        mode = stat_result.st_mode & 0o777
        assert mode == 0o600, f"Expected 0o600 but got {oct(mode)}"

    @pytest.mark.skipif(sys.platform == "win32", reason="POSIX only")
    def test_posix_handler_attribute_set(self, tmp_path):
        from token_goat.paths import open_log_file
        log_file = tmp_path / "attr.log"
        handler = open_log_file(log_file)
        try:
            # On POSIX we attach baseFilename so callers can inspect the path
            assert hasattr(handler, "baseFilename")
            assert str(log_file) in handler.baseFilename
        finally:
            handler.close()

    def test_nonexistent_parent_raises(self, tmp_path):
        from token_goat.paths import open_log_file
        log_file = tmp_path / "no_such_dir" / "sub" / "test.log"
        # open_log_file does NOT create parents — it should raise OSError
        with pytest.raises(OSError):
            open_log_file(log_file)


# ---------------------------------------------------------------------------
# 3. db.py indexes — verify expected indexes exist after open_project
# ---------------------------------------------------------------------------

class TestDbIndexes:
    """After open_project, the expected indexes exist on core tables."""

    def _get_indexes(self, conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
        return {row[0] for row in rows}

    def test_symbols_name_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_symbols_name" in indexes

    def test_symbols_file_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx2").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_symbols_file" in indexes

    def test_refs_symbol_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx3").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_refs_symbol" in indexes

    def test_sections_file_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx4").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_sections_file" in indexes

    def test_sections_heading_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx5").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_sections_heading" in indexes

    def test_stats_ts_index_exists(self, tmp_path):
        import hashlib

        from token_goat import db, paths
        fake_hash = hashlib.sha1(b"test_iter275_idx6").hexdigest()
        with patch.object(paths, "data_dir", return_value=tmp_path), db.open_project(fake_hash) as conn:
            indexes = self._get_indexes(conn)
        assert "idx_stats_ts" in indexes


# ---------------------------------------------------------------------------
# 4. session.load with corrupt JSON
# ---------------------------------------------------------------------------

class TestSessionLoadCorruptJson:
    """load() returns a fresh empty session instead of raising on bad JSON."""

    def _make_session_file(self, tmp_path: Path, content: str, session_id: str) -> Path:
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        p = sessions_dir / f"{session_id}.json"
        p.write_text(content, encoding="utf-8")
        return p

    def test_corrupt_json_returns_fresh_cache(self, tmp_path):
        from token_goat import paths, session
        sid = "testsess275aaa"
        self._make_session_file(tmp_path, "not json {", sid)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            cache = session.load(sid)
        assert cache.session_id == sid
        assert cache.files == {}
        assert cache.greps == []

    def test_empty_json_object_returns_fresh_cache(self, tmp_path):
        from token_goat import paths, session
        sid = "testsess275bbb"
        # {} is valid JSON but missing session_id — triggers ValueError in from_dict
        self._make_session_file(tmp_path, "{}", sid)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            cache = session.load(sid)
        # Should return a fresh cache for the requested session_id
        assert cache.session_id == sid
        assert cache.files == {}

    def test_truncated_json_returns_fresh_cache(self, tmp_path):
        from token_goat import paths, session
        sid = "testsess275ccc"
        self._make_session_file(tmp_path, '{"session_id": "', sid)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            cache = session.load(sid)
        assert cache.session_id == sid

    def test_corrupt_json_does_not_raise(self, tmp_path):
        from token_goat import paths, session
        sid = "testsess275ddd"
        self._make_session_file(tmp_path, "!!!not_json_at_all!!!", sid)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            # Must not raise
            cache = session.load(sid)
        assert isinstance(cache.session_id, str)

    def test_missing_file_returns_fresh_cache(self, tmp_path):
        from token_goat import paths, session
        sid = "testsess275eee"
        # Don't create the file at all
        (tmp_path / "sessions").mkdir(parents=True, exist_ok=True)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            cache = session.load(sid)
        assert cache.session_id == sid
        assert not cache.unavailable


# ---------------------------------------------------------------------------
# 5. compact.event_count and build_manifest
# ---------------------------------------------------------------------------

class TestCompactEventCount:
    """event_count reflects the number of file reads, greps, and edits."""

    def _make_session(self, tmp_path: Path, sid: str, n_files: int = 0) -> None:
        from token_goat.session import FileEntry, SessionCache
        now = time.time()
        files = {}
        for i in range(n_files):
            key = f"src/file{i}.py"
            files[key] = FileEntry(
                rel_or_abs=key,
                last_read_ts=now,
                read_count=1,
                line_ranges=[(1, 50)],
                symbols_read=[],
            )
        cache = SessionCache(
            session_id=sid,
            started_ts=now,
            last_activity_ts=now,
            files=files,
        )
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        p = sessions_dir / f"{sid}.json"
        p.write_text(cache.to_json(), encoding="utf-8")

    def test_event_count_with_five_file_reads(self, tmp_path):
        from token_goat import compact, paths
        sid = "compact275aaa"
        self._make_session(tmp_path, sid, n_files=5)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            count = compact.event_count(sid)
        assert count == 5

    def test_event_count_zero_for_empty_session(self, tmp_path):
        from token_goat import compact, paths
        sid = "compact275bbb"
        self._make_session(tmp_path, sid, n_files=0)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            count = compact.event_count(sid)
        assert count == 0

    def test_event_count_invalid_session_id_returns_zero(self, tmp_path):
        from token_goat import compact, paths
        with patch.object(paths, "data_dir", return_value=tmp_path):
            count = compact.event_count("../../../etc/passwd")
        assert count == 0

    def test_build_manifest_no_edited_files(self, tmp_path):
        from token_goat import compact, paths
        sid = "compact275ccc"
        self._make_session(tmp_path, sid, n_files=2)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            manifest = compact.build_manifest(sid)
        # Should have something (files were read)
        assert isinstance(manifest, str)
        assert len(manifest) > 0
        assert "Token-Goat" in manifest

    def test_build_manifest_empty_session_returns_empty(self, tmp_path):
        from token_goat import compact, paths
        sid = "compact275ddd"
        self._make_session(tmp_path, sid, n_files=0)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            manifest = compact.build_manifest(sid)
        # No file activity → empty manifest
        assert manifest == ""

    def test_build_manifest_with_count_matches_event_count(self, tmp_path):
        from token_goat import compact, paths
        sid = "compact275eee"
        self._make_session(tmp_path, sid, n_files=3)
        with patch.object(paths, "data_dir", return_value=tmp_path):
            manifest, count = compact.build_manifest_with_count(sid)
        assert count == 3
        assert isinstance(manifest, str)

    def test_build_manifest_invalid_session_returns_empty(self, tmp_path):
        from token_goat import compact, paths
        with patch.object(paths, "data_dir", return_value=tmp_path):
            result = compact.build_manifest("../traversal")
        assert result == ""


# ---------------------------------------------------------------------------
# 6. hints.build_read_hint
# ---------------------------------------------------------------------------

class TestBuildReadHint:
    """build_read_hint returns None for missing session/file and hints for cached files."""

    def test_no_session_id_returns_none(self):
        from token_goat.hints import build_read_hint
        result = build_read_hint(
            session_id=None,
            file_path="/some/file.py",
            offset=0,
            limit=100,
            cwd="/tmp",
        )
        assert result is None

    def test_empty_file_path_returns_none(self):
        from token_goat.hints import build_read_hint
        result = build_read_hint(
            session_id="hint275aaa",
            file_path="",
            offset=0,
            limit=100,
            cwd="/tmp",
        )
        assert result is None

    def test_cached_file_entry_produces_hint(self, tmp_path):
        from token_goat import paths
        from token_goat.hints import build_read_hint
        from token_goat.session import FileEntry, SessionCache

        sid = "hint275bbb"
        now = time.time()
        fname = "src/mymodule.py"
        entry = FileEntry(
            rel_or_abs=fname,
            last_read_ts=now,
            read_count=2,
            line_ranges=[(1, 2000)],
            symbols_read=[],
        )
        cache = SessionCache(
            session_id=sid,
            started_ts=now,
            last_activity_ts=now,
            files={fname: entry},
        )

        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        (sessions_dir / f"{sid}.json").write_text(cache.to_json(), encoding="utf-8")

        with patch.object(paths, "data_dir", return_value=tmp_path):
            hint = build_read_hint(
                session_id=sid,
                file_path=fname,
                offset=0,
                limit=500,
                cwd=str(tmp_path),
                cache=cache,
            )

        assert hint is not None
        assert "mymodule.py" in hint

    def test_no_cache_entry_no_cwd_returns_none(self):
        from token_goat.hints import build_read_hint
        # No session cache entry, no valid cwd — should return None safely
        result = build_read_hint(
            session_id="hint275ccc",
            file_path="/nonexistent/path/foo.py",
            offset=0,
            limit=100,
            cwd=None,
        )
        assert result is None

    def test_hint_tokens_saved_is_int(self, tmp_path):
        from token_goat import paths
        from token_goat.hints import build_read_hint
        from token_goat.session import FileEntry, SessionCache

        sid = "hint275ddd"
        now = time.time()
        fname = "src/big.py"
        entry = FileEntry(
            rel_or_abs=fname,
            last_read_ts=now,
            read_count=1,
            line_ranges=[(1, 2000)],
            symbols_read=[],
        )
        cache = SessionCache(
            session_id=sid,
            started_ts=now,
            last_activity_ts=now,
            files={fname: entry},
        )
        with patch.object(paths, "data_dir", return_value=tmp_path):
            hint = build_read_hint(
                session_id=sid,
                file_path=fname,
                offset=0,
                limit=2000,
                cwd=str(tmp_path),
                cache=cache,
            )
        if hint is not None:
            assert isinstance(hint.tokens_saved, int)


# ---------------------------------------------------------------------------
# 7. cli.py exit codes via CliRunner
# ---------------------------------------------------------------------------

class TestCliExitCodes:
    """Commands with invalid or traversal session-id should exit with code 1."""

    def test_invalid_session_id_exits_1_on_session_touched(self):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["session-touched", "--session-id", "../../etc/passwd"],
        )
        assert result.exit_code == 1

    def test_path_traversal_session_id_exits_1_on_compact_hint(self):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["compact-hint", "--session-id", "../../evil"],
        )
        assert result.exit_code == 1

    def test_empty_session_id_exits_1_on_session_touched(self):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["session-touched", "--session-id", ""])
        assert result.exit_code == 1

    def test_session_id_with_slash_exits_1_on_session_touched(self):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["session-touched", "--session-id", "foo/bar"],
        )
        assert result.exit_code == 1

    def test_session_id_with_null_byte_exits_1_on_compact_hint(self):
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["compact-hint", "--session-id", "foo\x00bar"],
        )
        assert result.exit_code == 1

    def test_valid_session_id_does_not_produce_invalid_error(self, tmp_path):
        from typer.testing import CliRunner

        from token_goat import paths
        from token_goat.cli import app

        runner = CliRunner()
        # A valid session ID should not produce an "invalid session ID" error
        with patch.object(paths, "data_dir", return_value=tmp_path):
            result = runner.invoke(
                app,
                ["session-touched", "--session-id", "validid12345"],
            )
        assert "invalid session ID" not in (result.output or "")


# ---------------------------------------------------------------------------
# 8. read_replacement types
# ---------------------------------------------------------------------------

class TestReadReplacementTypes:
    """SymbolResult and SectionResult TypedDicts have the expected keys."""

    def test_symbol_result_has_expected_keys(self):
        from token_goat.read_replacement import SymbolResult
        # TypedDict keys are accessible via __annotations__
        keys = set(SymbolResult.__annotations__)
        assert "file" in keys
        assert "symbol" in keys
        assert "kind" in keys
        assert "start_line" in keys
        assert "end_line" in keys
        assert "text" in keys
        assert "bytes_saved" in keys

    def test_section_result_has_expected_keys(self):
        from token_goat.read_replacement import SectionResult
        keys = set(SectionResult.__annotations__)
        assert "file" in keys
        assert "heading" in keys
        assert "level" in keys
        assert "start_line" in keys
        assert "end_line" in keys
        assert "text" in keys

    def test_symbol_result_instantiation(self):
        from token_goat.read_replacement import SymbolResult
        # TypedDict is a plain dict at runtime
        obj: SymbolResult = {
            "file": "src/foo.py",
            "symbol": "MyClass",
            "kind": "class",
            "start_line": 10,
            "end_line": 50,
            "text": "class MyClass: pass",
            "signature": None,
            "bytes_total": 1000,
            "bytes_extracted": 100,
            "bytes_saved": 900,
        }
        assert obj["file"] == "src/foo.py"
        assert obj["symbol"] == "MyClass"
        assert obj["bytes_saved"] == 900

    def test_section_result_instantiation(self):
        from token_goat.read_replacement import SectionResult
        obj: SectionResult = {
            "file": "docs/README.md",
            "heading": "Installation",
            "level": 2,
            "start_line": 5,
            "end_line": 30,
            "text": "## Installation\n...",
            "bytes_total": 500,
            "bytes_extracted": 100,
            "bytes_saved": 400,
        }
        assert obj["heading"] == "Installation"
        assert obj["level"] == 2

    def test_find_in_all_projects_callable(self):
        from token_goat.read_replacement import find_in_all_projects
        # Should be callable; returning None is valid when no project is indexed
        assert callable(find_in_all_projects)

    def test_resolve_file_rel_callable(self):
        from token_goat.read_replacement import resolve_file_rel
        assert callable(resolve_file_rel)

    def test_invalidate_file_cache_callable(self):
        from token_goat.read_replacement import invalidate_file_cache
        assert callable(invalidate_file_cache)

    def test_read_symbol_callable(self):
        from token_goat.read_replacement import read_symbol
        assert callable(read_symbol)

    def test_read_section_callable(self):
        from token_goat.read_replacement import read_section
        assert callable(read_section)
