"""Regression tests for input validation and security vulnerabilities."""
from __future__ import annotations

import pytest

from token_goat import db, gdrive, session


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
