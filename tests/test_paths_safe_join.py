"""Tests for paths.safe_join — the canonical user-controlled path-join helper."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from token_goat import paths


@pytest.fixture()
def base(tmp_path: Path) -> Path:
    """A temporary base directory for safe_join tests."""
    d = tmp_path / "cache"
    d.mkdir()
    return d


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------


def test_safe_join_simple(base: Path) -> None:
    """A plain alphanumeric fragment joins correctly."""
    result = paths.safe_join(base, "abc123")
    assert result == (base / "abc123").resolve()
    assert result.is_relative_to(base.resolve())


def test_safe_join_with_ext(base: Path) -> None:
    """Fragment + ext combines correctly."""
    result = paths.safe_join(base, "myfile", ext=".json")
    assert result.name == "myfile.json"
    assert result.is_relative_to(base.resolve())


def test_safe_join_hyphen_underscore(base: Path) -> None:
    """Hyphens and underscores are allowed in fragments."""
    result = paths.safe_join(base, "session-abc_123", ext=".txt")
    assert result.name == "session-abc_123.txt"


def test_safe_join_dotted_fragment(base: Path) -> None:
    """A fragment with an embedded dot (like 'file.mark') is accepted."""
    result = paths.safe_join(base, "myfile.mark")
    assert result.name == "myfile.mark"


# ---------------------------------------------------------------------------
# Null-byte rejection
# ---------------------------------------------------------------------------


def test_safe_join_rejects_null_byte(base: Path) -> None:
    """Fragments with embedded null bytes must be rejected."""
    with pytest.raises(ValueError, match="null byte"):
        paths.safe_join(base, "valid\x00evil")


def test_safe_join_rejects_null_byte_at_start(base: Path) -> None:
    with pytest.raises(ValueError, match="null byte"):
        paths.safe_join(base, "\x00evil")


# ---------------------------------------------------------------------------
# Traversal rejection (POSIX-style)
# ---------------------------------------------------------------------------


def test_safe_join_rejects_dotdot_posix(base: Path) -> None:
    """Classic POSIX traversal via ``../`` must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "../../etc/passwd")


def test_safe_join_rejects_dotdot_simple(base: Path) -> None:
    """A bare ``..`` must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "..")


def test_safe_join_rejects_dotdot_nested(base: Path) -> None:
    """Nested traversal must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "subdir/../../../etc/shadow")


# ---------------------------------------------------------------------------
# Traversal rejection (Windows-style)
# ---------------------------------------------------------------------------


def test_safe_join_rejects_dotdot_windows(base: Path) -> None:
    """Windows-style traversal using backslash must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "..\\..\\windows\\system32")


# ---------------------------------------------------------------------------
# Absolute path rejection
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX absolute path test")
def test_safe_join_rejects_posix_absolute(base: Path) -> None:
    """A POSIX absolute path as fragment must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "/etc/passwd")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows absolute path test")
def test_safe_join_rejects_windows_absolute(base: Path) -> None:
    """A Windows drive-rooted path as fragment must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "C:\\Windows\\System32")


# ---------------------------------------------------------------------------
# Colon rejection (Windows-illegal; Codex session IDs can contain colons)
# ---------------------------------------------------------------------------


def test_safe_join_rejects_colon_in_fragment(base: Path) -> None:
    """A fragment containing a colon must always be rejected.

    Codex session IDs may contain ``:``.  On Windows, ``path / "C:/evil"``
    silently produces an absolute path, escaping the base directory.  We
    reject colons unconditionally so callers must sanitize before calling
    ``safe_join``.
    """
    with pytest.raises(ValueError, match="colon"):
        paths.safe_join(base, "session:abc")


def test_safe_join_rejects_codex_style_session_id(base: Path) -> None:
    """Codex-style ``<uuid>:<counter>`` session IDs are rejected."""
    with pytest.raises(ValueError, match="colon"):
        paths.safe_join(base, "01abc123-def4-5678-90ab-cdef01234567:1")


# ---------------------------------------------------------------------------
# Empty fragment rejection
# ---------------------------------------------------------------------------


def test_safe_join_rejects_empty_fragment(base: Path) -> None:
    """An empty fragment must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "")
