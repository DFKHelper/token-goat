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


@pytest.mark.skipif(sys.platform != "win32", reason="backslash is not a path separator on Linux/macOS")
def test_safe_join_rejects_dotdot_windows(base: Path) -> None:
    """Windows-style traversal using backslash must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "..\\..\\windows\\system32")


# ---------------------------------------------------------------------------
# Absolute path rejection — platform-neutral
#
# Both POSIX absolute paths ("/etc/passwd") and Windows drive-rooted paths
# ("C:\\Windows\\System32") are rejected on every platform:
#
#   * Windows fragments ("C:\\...") contain a colon and are caught by the
#     colon guard before Path resolution even runs.
#   * POSIX fragments ("/etc/passwd") escape the base directory after
#     resolve() and are caught by the relative_to() traversal guard; on
#     Windows, Path("/etc/passwd").resolve() resolves relative to the CWD
#     drive root, which is still outside *base*.
#
# Neither test needs a platform skip — removing the old @skipif decorators
# makes both run on Windows and Linux CI, giving genuine cross-platform
# coverage.
# ---------------------------------------------------------------------------


def test_safe_join_rejects_posix_absolute(base: Path) -> None:
    """A POSIX absolute path as fragment must be rejected on any platform."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "/etc/passwd")


def test_safe_join_rejects_windows_absolute(base: Path) -> None:
    """A Windows drive-rooted path as fragment must be rejected on any platform.

    The colon guard fires before path resolution, so this is rejected on Linux
    and macOS too — the fragment never reaches Path.resolve().
    """
    with pytest.raises(ValueError):
        paths.safe_join(base, "C:\\Windows\\System32")


# ---------------------------------------------------------------------------
# Absolute path rejection — parametrized across common attack patterns
#
# Covers both path-separator styles and both platforms in a single test body,
# so that any future regression fails for every variant simultaneously on
# every CI platform rather than being hidden by a skipif guard.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fragment",
    [
        # POSIX absolute paths
        "/etc/passwd",
        "/root/.ssh/id_rsa",
        "//server/share",
        # Windows drive-letter paths (colon guard fires first)
        "C:/Windows/System32",
        "C:\\Windows\\System32",
        "D:/secret/file.txt",
        "c:/lower/case/drive",
        # Windows long-path prefix (contains backslash + colon)
        "\\\\?\\C:\\Windows",
        # UNC paths (escape base via traversal guard or colon-free but still absolute)
        "\\\\server\\share\\file",
        "//server/share/file",
    ],
)
def test_safe_join_rejects_absolute_paths(base: Path, fragment: str) -> None:
    """Absolute and UNC fragments are rejected regardless of OS or separator style."""
    with pytest.raises(ValueError):
        paths.safe_join(base, fragment)


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
# Colon rejection — parametrized
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fragment",
    [
        "session:abc",
        "uuid:1",
        "C:/evil",
        "D:\\secret",
        "normal:colon",
        "a:b:c",
    ],
)
def test_safe_join_rejects_colon_parametrized(base: Path, fragment: str) -> None:
    """Any fragment containing a colon is rejected with a clear error message."""
    with pytest.raises(ValueError, match="colon"):
        paths.safe_join(base, fragment)


# ---------------------------------------------------------------------------
# UNC path rejection (documented behavior)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fragment",
    [
        "\\\\server\\share",
        "\\\\server\\share\\nested\\file",
        "//server/share",
        "//server/share/nested/file",
    ],
)
def test_safe_join_rejects_unc_paths(base: Path, fragment: str) -> None:
    """UNC-style network paths (``\\\\server\\share``, ``//server/share``) are rejected.

    UNC paths either contain a colon (if ``\\\\?\\C:\\...`` style) or escape the
    base directory via the traversal guard (the resolved candidate is not under
    *base*).  Both cases raise ``ValueError`` consistently on every platform.
    """
    with pytest.raises(ValueError):
        paths.safe_join(base, fragment)


# ---------------------------------------------------------------------------
# Empty fragment rejection
# ---------------------------------------------------------------------------


def test_safe_join_rejects_empty_fragment(base: Path) -> None:
    """An empty fragment must be rejected."""
    with pytest.raises(ValueError):
        paths.safe_join(base, "")
