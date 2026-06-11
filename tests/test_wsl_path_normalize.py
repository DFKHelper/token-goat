"""Tests for WSL path normalization via util.normalize_path and paths.normalize_key.

Verifies that /mnt/c/... (WSL form) and C:\\ (Windows form) produce the same
canonical key, fixing silent lookup failures when running token-goat under WSL
with Windows-path project roots stored in the session/DB layers.
"""
from __future__ import annotations

from pathlib import Path

from token_goat import paths
from token_goat.util import normalize_path


class TestNormalizePath:
    """util.normalize_path converts WSL and Windows paths to a canonical form."""

    # ------------------------------------------------------------------
    # WSL /mnt/<drive>/... → <drive>:/...
    # ------------------------------------------------------------------

    def test_wsl_c_drive(self) -> None:
        """WSL /mnt/c/... converts to c:/..."""
        assert normalize_path("/mnt/c/foo") == "c:/foo"

    def test_wsl_path_with_subdirs(self) -> None:
        """WSL path with nested subdirectories converts correctly."""
        assert normalize_path("/mnt/c/Users/zelys/project/src/foo.py") == "c:/Users/zelys/project/src/foo.py"

    def test_wsl_uppercase_c_drive(self) -> None:
        """WSL /mnt/C/... (uppercase drive) normalizes to c:/... — drive lowercased.

        Regression: the pre-fix regex was ``[a-z]`` only, so an uppercase /mnt/C/
        path matched neither the WSL branch (regex miss) nor the Windows
        drive-lowercasing branch (s[1] != ':'), and was returned fully
        unnormalized, violating the documented WSL-conversion + lowercasing
        contract and fragmenting the session/cache key for the same physical file.
        """
        assert normalize_path("/mnt/C/bar") == "c:/bar"

    def test_wsl_uppercase_d_drive(self) -> None:
        """WSL /mnt/D/... (uppercase non-C drive) normalizes to d:/..."""
        assert normalize_path("/mnt/D/workspace") == "d:/workspace"

    def test_wsl_uppercase_and_lowercase_same_key(self) -> None:
        """/mnt/C/foo/bar and /mnt/c/foo/bar collapse to one canonical key."""
        assert normalize_path("/mnt/C/foo/bar") == normalize_path("/mnt/c/foo/bar")

    def test_wsl_d_drive(self) -> None:
        """WSL /mnt/d/... converts to d:/..."""
        assert normalize_path("/mnt/d/workspace") == "d:/workspace"

    def test_wsl_root_only(self) -> None:
        """WSL /mnt/c/ (root only) converts to c:/."""
        result = normalize_path("/mnt/c/")
        assert result == "c:/"

    def test_wsl_empty_rest(self) -> None:
        """/mnt/c with no trailing slash converts to c:/ (empty rest after drive)."""
        result = normalize_path("/mnt/c/")
        assert result.startswith("c:")

    # ------------------------------------------------------------------
    # Windows C:\\... → c:/...
    # ------------------------------------------------------------------

    def test_windows_backslash_path(self) -> None:
        r"""C:\foo\bar normalizes to c:/foo/bar."""
        assert normalize_path(r"C:\foo\bar") == "c:/foo/bar"

    def test_windows_mixed_slashes(self) -> None:
        r"""C:\foo/bar (mixed separators) normalizes to c:/foo/bar."""
        assert normalize_path(r"C:\foo/bar") == "c:/foo/bar"

    def test_windows_uppercase_drive(self) -> None:
        """Uppercase drive letter is lowercased."""
        assert normalize_path("C:/foo/bar") == "c:/foo/bar"

    def test_windows_already_lowercase_drive(self) -> None:
        """Lowercase drive letter is preserved."""
        assert normalize_path("c:/foo/bar") == "c:/foo/bar"

    # ------------------------------------------------------------------
    # Already-normalized form → unchanged
    # ------------------------------------------------------------------

    def test_already_normalized_unchanged(self) -> None:
        """Already-normalized c:/foo/bar is returned unchanged."""
        assert normalize_path("c:/foo/bar") == "c:/foo/bar"

    def test_already_normalized_deep(self) -> None:
        """Deep already-normalized path is returned unchanged."""
        p = "c:/Projects/token-goat/src/token_goat/util.py"
        assert normalize_path(p) == p

    # ------------------------------------------------------------------
    # Non-/mnt/ POSIX paths → unchanged
    # ------------------------------------------------------------------

    def test_posix_absolute_unchanged(self) -> None:
        """/home/user/project is returned unchanged (no drive conversion)."""
        assert normalize_path("/home/user/project") == "/home/user/project"

    def test_posix_mnt_non_drive_unchanged(self) -> None:
        """/mnt/data/stuff is left alone (not a single-letter drive mount)."""
        assert normalize_path("/mnt/data/stuff") == "/mnt/data/stuff"

    def test_posix_mnt_multisegment_unchanged(self) -> None:
        """/mnt/storage/repo is left alone (multi-char mount point name)."""
        assert normalize_path("/mnt/storage/repo") == "/mnt/storage/repo"

    def test_posix_relative_unchanged(self) -> None:
        """Relative POSIX paths are returned unchanged."""
        assert normalize_path("src/foo.py") == "src/foo.py"

    # ------------------------------------------------------------------
    # pathlib.Path input accepted
    # ------------------------------------------------------------------

    def test_pathlib_path_input(self) -> None:
        """normalize_path accepts a pathlib.Path object."""
        result = normalize_path(Path("src/foo.py"))
        assert result == "src/foo.py"

    # ------------------------------------------------------------------
    # Equivalence: WSL and Windows forms map to the same key
    # ------------------------------------------------------------------

    def test_wsl_and_windows_same_key(self) -> None:
        """WSL /mnt/c/foo/bar and C:\\foo\\bar produce identical canonical keys."""
        wsl_form = normalize_path("/mnt/c/foo/bar")
        win_form = normalize_path(r"C:\foo\bar")
        assert wsl_form == win_form

    def test_wsl_path_with_embedded_backslash(self) -> None:
        r"""Regression P3-8: /mnt/c/foo\bar (WSL path with Windows separator) normalizes to c:/foo/bar.

        Before the fix, backslash→slash replacement was in the else-branch so it only ran
        for non-WSL paths.  A mixed-separator WSL path like /mnt/c/foo\bar matched the WSL
        regex, so rest captured 'foo\bar', and the result was 'c:/foo\bar' (backslash intact).
        After the fix, backslash replacement runs BEFORE the WSL check so all separators
        are already forward-slashes when the regex fires.
        """
        assert normalize_path("/mnt/c/foo\\bar") == "c:/foo/bar"

    def test_wsl_path_with_multiple_embedded_backslashes(self) -> None:
        r"""Regression P3-8: /mnt/c/a\b\c fully normalized to c:/a/b/c."""
        assert normalize_path("/mnt/c/a\\b\\c") == "c:/a/b/c"


class TestNormalizeKeyDelegates:
    """paths.normalize_key delegates to normalize_path and handles WSL paths."""

    def test_wsl_path_via_normalize_key(self) -> None:
        """/mnt/c/foo converted to c:/foo by normalize_key."""
        assert paths.normalize_key("/mnt/c/foo") == "c:/foo"

    def test_windows_path_via_normalize_key(self) -> None:
        r"""C:\foo\bar converted to c:/foo/bar by normalize_key."""
        assert paths.normalize_key(r"C:\foo\bar") == "c:/foo/bar"

    def test_already_normalized_via_normalize_key(self) -> None:
        """Already-normalized path is unchanged via normalize_key."""
        assert paths.normalize_key("c:/foo/bar") == "c:/foo/bar"

    def test_posix_path_via_normalize_key(self) -> None:
        """/home/user/proj is unchanged via normalize_key."""
        assert paths.normalize_key("/home/user/proj") == "/home/user/proj"


class TestSessionPathNormalization:
    """session.mark_file_read uses normalize_key so WSL and Windows paths alias."""

    def test_wsl_and_windows_paths_same_entry(self, tmp_data_dir) -> None:
        """Marking a file under both WSL form and Windows form hits the same entry."""
        from token_goat import session

        sid = "wsl_norm_test_01"
        session.mark_file_read(sid, "/mnt/c/foo/bar.py")
        cache = session.mark_file_read(sid, r"C:\foo\bar.py")
        # Both forms should resolve to the same dict entry
        assert len(cache.files) == 1

    def test_wsl_path_key_normalized(self, tmp_data_dir) -> None:
        """WSL /mnt/c/... path stored with normalized c:/... key."""
        from token_goat import session

        sid = "wsl_norm_test_02"
        cache = session.mark_file_read(sid, "/mnt/c/projects/main.py")
        assert "c:/projects/main.py" in cache.files

    def test_windows_path_key_normalized(self, tmp_data_dir) -> None:
        r"""Windows C:\... path stored with normalized c:/... key."""
        from token_goat import session

        sid = "wsl_norm_test_03"
        cache = session.mark_file_read(sid, r"C:\projects\main.py")
        assert "c:/projects/main.py" in cache.files
