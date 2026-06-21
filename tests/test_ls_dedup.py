"""Tests for directory-listing dedup (iter 1 — ls/eza/dir fingerprinting)."""
from __future__ import annotations

import os

import pytest

from token_goat.bash_cache import (
    _extract_ls_target,
    command_hash,
    dir_state_fingerprint,
    is_dir_listing_command,
)


class TestIsDirListingCommand:
    @pytest.mark.parametrize("cmd", [
        "ls",
        "ls -la",
        "ls -la /tmp/foo",
        "eza --git --long src/",
        "exa -l",
        "dir C:/Windows",
        "Get-ChildItem .",
        "gci -Path src",
        "  ls  ",  # leading whitespace
    ])
    def test_listing_commands_detected(self, cmd: str) -> None:
        assert is_dir_listing_command(cmd), f"{cmd!r} should be detected as a listing command"

    @pytest.mark.parametrize("cmd", [
        "cat file.py",
        "git status",
        "pytest tests/",
        "npm install",
        "rg TODO src/",
        "ls_extra foo",  # not a bare ls
        "false",
    ])
    def test_non_listing_commands_not_detected(self, cmd: str) -> None:
        assert not is_dir_listing_command(cmd), f"{cmd!r} should not match"


class TestExtractLsTarget:
    def test_bare_ls_falls_back_to_cwd(self) -> None:
        assert _extract_ls_target("ls", "/proj") == "/proj"

    def test_flags_only_falls_back_to_cwd(self) -> None:
        assert _extract_ls_target("ls -la", "/proj") == "/proj"

    def test_path_extracted_after_flags(self) -> None:
        assert _extract_ls_target("ls -la /tmp/foo", "/proj") == "/tmp/foo"

    def test_first_positional_wins(self) -> None:
        assert _extract_ls_target("eza --git src/", "/proj") == "src/"

    def test_no_cwd_bare_returns_none(self) -> None:
        assert _extract_ls_target("ls", None) is None


class TestDirStateFingerprint:
    def test_existing_dir_returns_string(self, tmp_path) -> None:
        fp = dir_state_fingerprint(str(tmp_path))
        assert isinstance(fp, str) and len(fp) > 0

    def test_nonexistent_path_returns_none(self) -> None:
        assert dir_state_fingerprint("/no/such/path/xyz") is None

    def test_file_path_returns_none(self, tmp_path) -> None:
        f = tmp_path / "file.txt"
        f.write_text("hello")
        assert dir_state_fingerprint(str(f)) is None

    def test_fingerprint_changes_after_file_added(self, tmp_path) -> None:
        # Backdate the directory so any subsequent write produces a clearly newer mtime.
        os.utime(tmp_path, (946684800.0, 946684800.0))
        fp1 = dir_state_fingerprint(str(tmp_path))
        (tmp_path / "new_file.txt").write_text("content")
        fp2 = dir_state_fingerprint(str(tmp_path))
        assert fp1 != fp2, "Fingerprint should change when a file is added"

    def test_fingerprint_stable_when_unchanged(self, tmp_path) -> None:
        fp1 = dir_state_fingerprint(str(tmp_path))
        fp2 = dir_state_fingerprint(str(tmp_path))
        assert fp1 == fp2


class TestCommandHashLsDedup:
    def test_same_ls_same_dir_same_hash(self, tmp_path) -> None:
        cwd = str(tmp_path)
        h1 = command_hash("ls -la", cwd)
        h2 = command_hash("ls -la", cwd)
        assert h1 == h2

    def test_ls_hash_changes_after_dir_modified(self, tmp_path) -> None:
        cwd = str(tmp_path)
        # Backdate the directory so any subsequent write produces a clearly newer mtime.
        os.utime(tmp_path, (946684800.0, 946684800.0))
        h1 = command_hash("ls -la", cwd)
        (tmp_path / "added.txt").write_text("x")
        h2 = command_hash("ls -la", cwd)
        assert h1 != h2, "ls hash should change when directory changes"

    def test_ls_different_target_different_hash(self, tmp_path) -> None:
        sub = tmp_path / "sub"
        sub.mkdir()
        h1 = command_hash(f"ls {tmp_path}", str(tmp_path))
        h2 = command_hash(f"ls {sub}", str(tmp_path))
        assert h1 != h2

    def test_non_ls_command_unaffected(self, tmp_path) -> None:
        cwd = str(tmp_path)
        # Backdate the directory; even after a file is added the non-ls hash must not change.
        os.utime(tmp_path, (946684800.0, 946684800.0))
        h1 = command_hash("pytest tests/", cwd)
        (tmp_path / "added.txt").write_text("x")
        h2 = command_hash("pytest tests/", cwd)
        # pytest is not a listing command; hash must not change from dir mtime
        assert h1 == h2

    def test_ls_without_cwd_no_crash(self) -> None:
        # No cwd → no dir fingerprint; should return a stable hash
        h = command_hash("ls -la", None)
        assert isinstance(h, str) and len(h) > 0

    def test_relative_target_resolved_against_cwd(self, tmp_path) -> None:
        # "ls sub/" with cwd=tmp_path must fingerprint tmp_path/sub, not
        # ./sub relative to Python's process cwd (Codex finding 3).
        sub = tmp_path / "sub"
        sub.mkdir()
        cwd = str(tmp_path)
        # Backdate sub so any subsequent write produces a clearly newer mtime.
        os.utime(sub, (946684800.0, 946684800.0))
        h1 = command_hash("ls sub/", cwd)
        (sub / "file.txt").write_text("x")  # change tmp_path/sub, not ./sub
        h2 = command_hash("ls sub/", cwd)
        assert h1 != h2, "Relative target must be resolved against cwd, not Python process cwd"
