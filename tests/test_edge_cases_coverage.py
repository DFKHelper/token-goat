"""Tests for edge cases and error conditions in core modules.

This suite closes gaps in test coverage for validation functions,
error paths, and boundary conditions.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from token_goat import bash_parser, gdrive, session


class TestSessionValidation:
    """Test session ID validation and error handling."""

    def test_load_empty_session_id_raises(self, tmp_data_dir):
        """load() with empty session_id raises ValueError."""
        with pytest.raises(ValueError, match="session_id cannot be empty"):
            session.load("")

    def test_load_too_long_session_id_raises(self, tmp_data_dir):
        """load() with session_id > 128 chars raises ValueError."""
        long_id = "a" * 129
        with pytest.raises(ValueError, match="session_id too long"):
            session.load(long_id)

    def test_load_invalid_session_id_chars_raises(self, tmp_data_dir):
        """load() with invalid chars (e.g., /) in session_id raises ValueError."""
        with pytest.raises(ValueError, match="session_id contains invalid characters"):
            session.load("session/with/slashes")

    def test_load_session_with_path_traversal_chars_raises(self, tmp_data_dir):
        """load() rejects session IDs with path traversal attempts."""
        with pytest.raises(ValueError, match="session_id contains invalid characters"):
            session.load("../../../etc/passwd")

    def test_mark_file_read_validates_session_id(self, tmp_data_dir):
        """mark_file_read() validates session_id before writing."""
        with pytest.raises(ValueError, match="session_id contains invalid characters"):
            session.mark_file_read("bad@session", "file.py")

    def test_mark_file_read_empty_session_id_raises(self, tmp_data_dir):
        """mark_file_read() with empty session_id raises ValueError."""
        with pytest.raises(ValueError, match="session_id cannot be empty"):
            session.mark_file_read("", "file.py")

    def test_mark_grep_validates_session_id(self, tmp_data_dir):
        """mark_grep() validates session_id before writing."""
        with pytest.raises(ValueError, match="session_id contains invalid characters"):
            session.mark_grep("bad$id", "pattern", "file.py")

    def test_reset_session_with_valid_id(self, tmp_data_dir):
        """reset_session() with valid ID deletes cache file."""
        session_id = "test_valid_reset"
        session.mark_file_read(session_id, "file.py")
        loaded = session.load(session_id)
        assert loaded.files
        session.reset_session(session_id)
        fresh = session.load(session_id)
        assert fresh.files == {}


class TestSessionCacheCorruption:
    """Test session cache recovery from corruption."""

    def test_load_corrupted_json_returns_fresh_cache(self, tmp_data_dir):
        """load() handles malformed JSON gracefully, returns empty cache."""
        session_id = "test_corrupt"
        cache_path = Path(__file__).parent.parent / "tmp_data" / "sessions" / f"{session_id}.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text("{ invalid json }", encoding="utf-8")

        loaded = session.load(session_id)
        assert loaded.session_id == session_id
        assert loaded.files == {}
        assert loaded.greps == []

    def test_load_corrupted_json_missing_field_returns_fresh(self, tmp_data_dir):
        """load() recovers from JSON missing required fields."""
        session_id = "test_missing_field"
        cache_path = Path(__file__).parent.parent / "tmp_data" / "sessions" / f"{session_id}.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"session_id": session_id}), encoding="utf-8")

        loaded = session.load(session_id)
        assert loaded.session_id == session_id
        assert loaded.files == {}

    def test_load_corrupted_json_wrong_type_returns_fresh(self, tmp_data_dir):
        """load() handles non-dict JSON payload gracefully."""
        session_id = "test_wrong_type"
        cache_path = Path(__file__).parent.parent / "tmp_data" / "sessions" / f"{session_id}.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")

        loaded = session.load(session_id)
        assert loaded.session_id == session_id
        assert loaded.files == {}


class TestBashParserEdgeCases:
    """Test bash_parser edge cases and malformed input."""

    def test_parse_invalid_shlex_returns_unknown(self):
        """parse() returns kind='unknown' on shlex parsing error."""
        result = bash_parser.parse("echo 'unclosed quote")
        assert result.kind == "unknown"

    def test_parse_head_with_negative_limit(self):
        """parse() handles negative line counts."""
        result = bash_parser.parse("head -n -5 file.txt")
        assert result.kind == "read"
        assert result.target_path == "file.txt"
        assert result.limit == -5


    def test_parse_head_with_non_numeric_lines_ignores(self):
        """parse() gracefully ignores non-numeric -n values."""
        result = bash_parser.parse("head -n xyz file.txt")
        assert result.kind == "read"
        assert result.target_path == "file.txt"
        assert result.limit is None

    def test_parse_tail_with_multiple_files_picks_first(self):
        """parse() for tail with multiple files picks first."""
        result = bash_parser.parse("tail -n 10 file1.txt file2.txt")
        assert result.kind == "read"
        assert result.target_path == "file1.txt"
        assert result.limit == 10


    def test_parse_time_prefix_stripped(self):
        """parse() strips time prefix."""
        result = bash_parser.parse("time cat important.txt")
        assert result.kind == "read"
        assert result.target_path == "important.txt"

    def test_parse_nice_prefix_stripped(self):
        """parse() strips nice prefix."""
        result = bash_parser.parse("nice grep pattern file.txt")
        assert result.kind == "grep"
        assert result.pattern == "pattern"

    def test_parse_exec_prefix_stripped(self):
        """parse() strips exec prefix."""
        result = bash_parser.parse("exec cat file.txt")
        assert result.kind == "read"
        assert result.target_path == "file.txt"


class TestGDriveValidation:
    """Test Google Drive file ID validation."""

    def test_validate_file_id_empty_raises(self):
        """_validate_file_id rejects empty string."""
        with pytest.raises(ValueError, match="file_id cannot be empty"):
            gdrive._validate_file_id("")

    def test_validate_file_id_too_long_raises(self):
        """_validate_file_id rejects IDs > 128 chars."""
        long_id = "a" * 129
        with pytest.raises(ValueError, match="file_id too long"):
            gdrive._validate_file_id(long_id)

    def test_validate_file_id_invalid_chars_raises(self):
        """_validate_file_id rejects special characters."""
        with pytest.raises(ValueError, match="file_id contains invalid characters"):
            gdrive._validate_file_id("abc/def")

    def test_validate_file_id_rejects_path_traversal(self):
        """_validate_file_id rejects path traversal attempts."""
        with pytest.raises(ValueError, match="file_id contains invalid characters"):
            gdrive._validate_file_id("../../../etc/passwd")

    def test_validate_file_id_allows_base64url_chars(self):
        """_validate_file_id allows alphanumeric, hyphen, underscore."""
        # Should not raise
        gdrive._validate_file_id("abc123-_XYZ789")




class TestSessionLineRangeMerging:
    """Test edge cases in line range merging logic."""

    def test_merge_overlapping_ranges(self, tmp_data_dir):
        """mark_file_read merges overlapping ranges correctly."""
        session_id = "test_merge"
        # Read lines 1-50
        cache1 = session.mark_file_read(session_id, "file.py", offset=0, limit=50)
        assert cache1.files["file.py"].line_ranges == [(1, 50)]

        # Read lines 40-70 (overlaps)
        cache2 = session.mark_file_read(session_id, "file.py", offset=39, limit=31)
        assert cache2.files["file.py"].line_ranges == [(1, 70)]

    def test_merge_adjacent_ranges(self, tmp_data_dir):
        """mark_file_read merges adjacent ranges into one."""
        session_id = "test_adjacent"
        # Read lines 1-50
        session.mark_file_read(session_id, "file.py", offset=0, limit=50)
        # Read lines 51-100
        cache = session.mark_file_read(session_id, "file.py", offset=50, limit=50)
        assert cache.files["file.py"].line_ranges == [(1, 100)]

    def test_read_count_increments(self, tmp_data_dir):
        """mark_file_read increments read_count on each call."""
        session_id = "test_count"
        cache1 = session.mark_file_read(session_id, "file.py", offset=0, limit=10)
        assert cache1.files["file.py"].read_count == 1

        cache2 = session.mark_file_read(session_id, "file.py", offset=100, limit=10)
        assert cache2.files["file.py"].read_count == 2


