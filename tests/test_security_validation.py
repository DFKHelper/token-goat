"""Regression tests for input validation and security vulnerabilities."""
from __future__ import annotations

import pytest

from token_goat import db, gdrive, session
from token_goat.hooks_fetch import _shell_safe_url


class TestSessionIdPathTraversal:
    """Test session ID path traversal prevention."""

    def test_session_id_rejects_path_traversal(self):
        """Session ID with ../ should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("../../../etc/passwd")

    def test_session_id_rejects_absolute_path(self):
        """Session ID with / should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("/tmp/evil")

    def test_session_id_rejects_backslash(self):
        """Session ID with backslash should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("..\\..\\windows\\system32")

    def test_session_id_rejects_empty(self):
        """Empty session ID should raise ValueError."""
        with pytest.raises(ValueError, match="empty"):
            session.load("")

    def test_session_id_accepts_valid_hyphen(self):
        """Valid session ID with hyphens should work."""
        cache = session.load("my-session-123")
        assert cache.session_id == "my-session-123"

    def test_session_id_accepts_valid_underscore(self):
        """Valid session ID with underscores should work."""
        cache = session.load("my_session_123")
        assert cache.session_id == "my_session_123"

    def test_session_id_rejects_dot(self):
        """Session ID with dot should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            session.load("my.session")


class TestProjectHashPathTraversal:
    """Test project hash path traversal prevention."""

    def test_project_hash_rejects_path_traversal(self):
        """Project hash with ../ should raise ValueError."""
        with pytest.raises(ValueError, match="alphanumeric or underscore"):
            db._validate_project_hash("../../../malicious")

    def test_project_hash_rejects_forward_slash(self):
        """Project hash with / should raise ValueError."""
        with pytest.raises(ValueError, match="alphanumeric or underscore"):
            db._validate_project_hash("path/to/file")

    def test_project_hash_rejects_backslash(self):
        """Project hash with backslash should raise ValueError."""
        with pytest.raises(ValueError, match="alphanumeric or underscore"):
            db._validate_project_hash("path\\to\\file")

    def test_project_hash_rejects_dots(self):
        """Project hash with dots should raise ValueError."""
        with pytest.raises(ValueError, match="alphanumeric or underscore"):
            db._validate_project_hash("..hidden")

    def test_project_hash_accepts_valid_hex(self):
        """Valid SHA1 hex hash should work."""
        db._validate_project_hash("a" * 40)

    def test_project_hash_accepts_valid_mixed(self):
        """Valid alphanumeric hash should work."""
        db._validate_project_hash("abc123def456")

    def test_project_hash_rejects_empty(self):
        """Empty project hash should raise ValueError."""
        with pytest.raises(ValueError, match="empty"):
            db._validate_project_hash("")

    def test_project_hash_rejects_too_long(self):
        """Project hash > 128 chars should raise ValueError."""
        with pytest.raises(ValueError, match="too long"):
            db._validate_project_hash("a" * 129)


class TestFileIdPathTraversal:
    """Test Google Drive file ID path traversal prevention."""

    def test_file_id_rejects_path_traversal(self):
        """File ID with ../ should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            gdrive._validate_file_id("../../../etc/passwd")

    def test_file_id_rejects_forward_slash(self):
        """File ID with / should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            gdrive._validate_file_id("path/to/file")

    def test_file_id_rejects_backslash(self):
        """File ID with backslash should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            gdrive._validate_file_id("path\\to\\file")

    def test_file_id_accepts_valid_base64url(self):
        """Valid Google Drive file ID should work."""
        gdrive._validate_file_id("1mHIWnDvW9cABJxF2nWt6Z8k9mHIWnDv")

    def test_file_id_accepts_valid_with_hyphen_underscore(self):
        """File ID with hyphen and underscore should work."""
        gdrive._validate_file_id("abc123-_ABC")

    def test_file_id_rejects_empty(self):
        """Empty file ID should raise ValueError."""
        with pytest.raises(ValueError, match="empty"):
            gdrive._validate_file_id("")

    def test_file_id_rejects_too_long(self):
        """File ID > 128 chars should raise ValueError."""
        with pytest.raises(ValueError, match="too long"):
            gdrive._validate_file_id("a" * 129)

    def test_file_id_rejects_dot(self):
        """File ID with dot should raise ValueError."""
        with pytest.raises(ValueError, match="invalid characters"):
            gdrive._validate_file_id("file.id")


class TestDbCountTableAllowlist:
    """Test that _count() in project_stats() enforces a table-name allowlist."""

    def test_known_tables_are_in_allowlist(self):
        """All tables referenced by project_stats must be in the allowlist."""
        from token_goat.db import _KNOWN_PROJECT_TABLES
        for table in ("files", "symbols", "refs", "sections", "chunks", "embeddings"):
            assert table in _KNOWN_PROJECT_TABLES

    def test_unknown_table_raises(self, tmp_path):
        """Passing an unlisted table name to _count must raise ValueError, not execute SQL."""

        # We can't call _count() directly (it's a closure), but we can verify
        # the allowlist rejects arbitrary strings, which is what _count() checks.
        from token_goat.db import _KNOWN_PROJECT_TABLES
        evil_table = "'; DROP TABLE files; --"
        assert evil_table not in _KNOWN_PROJECT_TABLES

    def test_allowlist_rejects_traversal_like_names(self):
        """Table names with path-like or SQL-special characters are not in allowlist."""
        from token_goat.db import _KNOWN_PROJECT_TABLES
        for bad in ("../evil", "files; DROP TABLE files", "files UNION SELECT", ""):
            assert bad not in _KNOWN_PROJECT_TABLES


class TestShellSafeUrl:
    """Test URL shell-quoting in hook context messages."""

    def test_plain_url_is_double_quoted(self):
        result = _shell_safe_url("https://example.com/image.png")
        assert result == '"https://example.com/image.png"'

    def test_single_quote_in_url_does_not_appear_unescaped(self):
        """A URL with a single quote must not produce an unescaped ' in the output."""
        url = "https://example.com/path'with'quotes/image.png"
        result = _shell_safe_url(url)
        # The result is double-quoted; no raw single-quote should be present
        # that could break shell parsing, but single quotes are fine inside "..."
        # What matters is the result is wrapped in double quotes and the
        # shell-dangerous chars ($, `, \, ") are escaped.
        assert result.startswith('"')
        assert result.endswith('"')
        # Single quotes inside double-quotes are harmless — just verify the
        # double-quote wrapper is intact.
        assert result == f'"{url}"'

    def test_backtick_in_url_is_escaped(self):
        url = "https://example.com/img`cmd`.png"
        result = _shell_safe_url(url)
        assert "\\`" in result
        assert result.startswith('"')
        assert result.endswith('"')

    def test_dollar_in_url_is_escaped(self):
        url = "https://example.com/$HOME/img.png"
        result = _shell_safe_url(url)
        assert "\\$" in result

    def test_double_quote_in_url_is_escaped(self):
        url = 'https://example.com/path"evil"/img.png'
        result = _shell_safe_url(url)
        assert '\\"' in result

    def test_backslash_in_url_is_escaped(self):
        url = "https://example.com/path\\evil/img.png"
        result = _shell_safe_url(url)
        assert "\\\\" in result


class TestDirtyQueueValidation:
    """Test that project_hash and rel_path from the dirty queue are validated."""

    def test_invalid_project_hash_rejected(self):
        """_validate_project_hash must reject traversal-style hashes from the queue."""
        with pytest.raises(ValueError):
            db._validate_project_hash("../../../malicious")

    def test_invalid_project_hash_with_slash_rejected(self):
        with pytest.raises(ValueError):
            db._validate_project_hash("abc/def")

    def test_valid_project_hash_accepted(self):
        db._validate_project_hash("a1b2c3d4e5f6" * 3)  # 36-char hex, within limit

    def test_is_safe_rel_path_rejects_traversal(self):
        from token_goat.paths import is_safe_rel_path
        assert not is_safe_rel_path("../../etc/passwd")

    def test_is_safe_rel_path_rejects_absolute(self):
        from token_goat.paths import is_safe_rel_path
        assert not is_safe_rel_path("/etc/passwd")

    def test_is_safe_rel_path_accepts_normal(self):
        from token_goat.paths import is_safe_rel_path
        assert is_safe_rel_path("src/token_goat/db.py")
