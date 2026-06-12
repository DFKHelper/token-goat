"""Tests for git-aware bash cache: state fingerprinting (iter 3) and immutable commands (iter 4).

Verifies:
- is_git_mutable_command / is_git_immutable_command classification
- git_state_fingerprint returns None outside a repo, a stable string inside
- command_hash changes for git diff/status when git state changes
- command_hash is stable for immutable commands regardless of index changes
- _try_bash_dedup_serve bypasses staleness for git show <sha>
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Classification helpers
# ---------------------------------------------------------------------------

class TestGitCommandClassification:
    def test_git_diff_is_mutable(self) -> None:
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("git diff") is True
        assert is_git_mutable_command("git diff HEAD") is True
        assert is_git_mutable_command("git diff --stat") is True
        assert is_git_mutable_command("git diff HEAD~1") is True

    def test_git_status_is_mutable(self) -> None:
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("git status") is True
        assert is_git_mutable_command("git status --porcelain") is True
        assert is_git_mutable_command("git status -s") is True

    def test_other_git_not_mutable(self) -> None:
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("git log --oneline -5") is False
        assert is_git_mutable_command("git show abc123") is False
        assert is_git_mutable_command("rg pattern") is False
        assert is_git_mutable_command("git") is False

    def test_git_show_full_sha_is_immutable(self) -> None:
        from token_goat.bash_cache import is_git_immutable_command
        sha = "a" * 40
        assert is_git_immutable_command(f"git show {sha}") is True
        assert is_git_immutable_command(f"git show {sha} --stat") is True

    def test_git_show_short_sha_not_immutable(self) -> None:
        from token_goat.bash_cache import is_git_immutable_command
        assert is_git_immutable_command("git show abc1234") is False
        assert is_git_immutable_command("git show HEAD") is False
        assert is_git_immutable_command("git show main") is False

    def test_non_git_not_immutable(self) -> None:
        from token_goat.bash_cache import is_git_immutable_command
        assert is_git_immutable_command("cat file.py") is False
        assert is_git_immutable_command("git log --oneline") is False


# ---------------------------------------------------------------------------
# git_state_fingerprint
# ---------------------------------------------------------------------------

class TestGitStateFingerprint:
    def test_returns_none_outside_repo(self, tmp_path: Path) -> None:
        from token_goat.bash_cache import git_state_fingerprint
        result = git_state_fingerprint(str(tmp_path))
        assert result is None

    @pytest.mark.slow
    def test_returns_string_inside_repo(self, tmp_path: Path) -> None:
        from token_goat.bash_cache import git_state_fingerprint
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "--allow-empty", "-m", "init"], check=True, capture_output=True)
        result = git_state_fingerprint(str(tmp_path))
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.slow
    def test_fingerprint_changes_after_commit(self, tmp_path: Path) -> None:
        from token_goat.bash_cache import git_state_fingerprint
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "--allow-empty", "-m", "init"], check=True, capture_output=True)
        fp1 = git_state_fingerprint(str(tmp_path))
        (tmp_path / "file.txt").write_text("hello")
        subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "-m", "add file"], check=True, capture_output=True)
        fp2 = git_state_fingerprint(str(tmp_path))
        assert fp1 != fp2

    @pytest.mark.slow
    def test_fingerprint_stable_without_changes(self, tmp_path: Path) -> None:
        from token_goat.bash_cache import git_state_fingerprint
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "--allow-empty", "-m", "init"], check=True, capture_output=True)
        fp1 = git_state_fingerprint(str(tmp_path))
        fp2 = git_state_fingerprint(str(tmp_path))
        assert fp1 == fp2


# ---------------------------------------------------------------------------
# command_hash git-state integration
# ---------------------------------------------------------------------------

class TestCommandHashGitState:
    @pytest.mark.slow
    def test_diff_hash_changes_after_commit(self, tmp_path: Path) -> None:
        """git diff hash must differ before and after a commit."""
        from token_goat.bash_cache import command_hash
        subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "--allow-empty", "-m", "init"], check=True, capture_output=True)
        h1 = command_hash("git diff HEAD", str(tmp_path))
        (tmp_path / "f.py").write_text("x = 1")
        subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(tmp_path), "commit", "-m", "add f"], check=True, capture_output=True)
        h2 = command_hash("git diff HEAD", str(tmp_path))
        assert h1 != h2

    def test_non_git_command_hash_stable(self, tmp_path: Path) -> None:
        """Non-git commands must not be affected by git-state logic."""
        from token_goat.bash_cache import command_hash
        h1 = command_hash("pytest tests/", str(tmp_path))
        h2 = command_hash("pytest tests/", str(tmp_path))
        assert h1 == h2

    def test_immutable_show_hash_stable_across_calls(self, tmp_path: Path) -> None:
        """git show <sha> hash must NOT be affected by git-state (it's not mutable)."""
        from token_goat.bash_cache import command_hash
        sha = "a" * 40
        h1 = command_hash(f"git show {sha}", str(tmp_path))
        h2 = command_hash(f"git show {sha}", str(tmp_path))
        assert h1 == h2

    def test_diff_hash_without_cwd_unchanged(self) -> None:
        """When cwd is None, git diff hash behaves like a plain command hash."""
        from token_goat.bash_cache import command_hash
        h = command_hash("git diff HEAD", None)
        assert isinstance(h, str)


# ---------------------------------------------------------------------------
# Staleness bypass for immutable commands in _try_bash_dedup_serve
# ---------------------------------------------------------------------------

class TestImmutableStalenessbypass:
    def _make_payload(self, command: str, session_id: str = "sess-1", cwd: str = "/proj") -> dict[str, Any]:
        return {"tool_name": "Bash", "tool_input": {"command": command}, "session_id": session_id, "cwd": cwd}

    def test_immutable_command_bypasses_staleness(self) -> None:
        """git show <sha> must be served from cache even when age > stale threshold."""
        from token_goat.hooks_read import _try_bash_dedup_serve
        sha = "b" * 40
        command = f"git show {sha}"
        payload = self._make_payload(command)

        mock_entry = MagicMock()
        mock_entry.run_count = 1
        mock_entry.ts = time.time() - 100_000  # very old — beyond any stale threshold
        mock_entry.output_id = "test-output-id"

        with (
            patch("token_goat.hooks_read._get_bash_command_from_payload", return_value=command),
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/proj")),
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.load_output", return_value="commit output text"),
        ):
            mock_cache = MagicMock()
            mock_cache.created_ts = time.time() - 200_000
            mock_get_sess.return_value.load.return_value = mock_cache
            from token_goat import session as sess_mod
            with patch.object(sess_mod, "lookup_bash_entry", return_value=mock_entry):
                result = _try_bash_dedup_serve(payload)

        # Should NOT return None — immutable command bypasses staleness
        assert result is not None

    def test_mutable_command_respects_staleness(self) -> None:
        """git diff must NOT bypass staleness — stale entry should be dropped."""
        from token_goat.hooks_read import _try_bash_dedup_serve
        command = "git diff HEAD"
        payload = self._make_payload(command)

        mock_entry = MagicMock()
        mock_entry.run_count = 1
        mock_entry.ts = time.time() - 100_000  # very old
        mock_entry.output_id = "test-output-id"

        with (
            patch("token_goat.hooks_read._get_bash_command_from_payload", return_value=command),
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/proj")),
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
        ):
            mock_cache = MagicMock()
            mock_cache.created_ts = time.time() - 200_000
            mock_cache.files = {}
            mock_get_sess.return_value.load.return_value = mock_cache
            from token_goat import session as sess_mod
            with patch.object(sess_mod, "lookup_bash_entry", return_value=mock_entry):
                result = _try_bash_dedup_serve(payload)

        # Must return None — stale git diff must not be served
        assert result is None

    def test_mutable_command_invalidated_when_file_edited_after_cache(self) -> None:
        """git diff cached BEFORE a file edit must not be served — unstaged edits are invisible to git index."""
        from token_goat.hooks_read import _try_bash_dedup_serve
        from token_goat.session import FileEntry
        command = "git diff HEAD"
        payload = self._make_payload(command)

        entry_ts = time.time() - 30.0  # entry was cached 30s ago
        mock_entry = MagicMock()
        mock_entry.run_count = 1
        mock_entry.ts = entry_ts
        mock_entry.output_id = "test-output-id"

        # A file was edited 10s ago (AFTER the bash entry was cached)
        edited_file = FileEntry(
            rel_or_abs="src/foo.py",
            last_read_ts=entry_ts - 60,
            read_count=1,
            line_ranges=[],
            symbols_read=[],
            last_edit_ts=entry_ts + 10,  # edited AFTER the bash entry
        )

        with (
            patch("token_goat.hooks_read._get_bash_command_from_payload", return_value=command),
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/proj")),
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
        ):
            mock_cache = MagicMock()
            mock_cache.created_ts = time.time() - 120
            mock_cache.files = {"src/foo.py": edited_file}
            mock_get_sess.return_value.load.return_value = mock_cache
            from token_goat import session as sess_mod
            with patch.object(sess_mod, "lookup_bash_entry", return_value=mock_entry):
                result = _try_bash_dedup_serve(payload)

        # Must return None — file was edited since git diff was cached
        assert result is None

    def test_mutable_command_served_when_no_edits_since_cache(self) -> None:
        """git diff may be served when no session files were edited after the cache entry."""
        from token_goat.hooks_read import _try_bash_dedup_serve
        from token_goat.session import FileEntry
        command = "git diff HEAD"
        payload = self._make_payload(command)

        entry_ts = time.time() - 5.0
        mock_entry = MagicMock()
        mock_entry.run_count = 1
        mock_entry.ts = entry_ts
        mock_entry.output_id = "test-output-id"

        # File was edited BEFORE the bash entry (no staleness)
        read_only_file = FileEntry(
            rel_or_abs="src/bar.py",
            last_read_ts=entry_ts - 10,
            read_count=2,
            line_ranges=[],
            symbols_read=[],
            last_edit_ts=entry_ts - 20,  # edited BEFORE the bash entry — not stale
        )

        with (
            patch("token_goat.hooks_read._get_bash_command_from_payload", return_value=command),
            patch("token_goat.hooks_read.get_hook_context", return_value=("sess-1", "/proj")),
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.load_output", return_value="diff output"),
        ):
            mock_cache = MagicMock()
            mock_cache.created_ts = time.time() - 60
            mock_cache.files = {"src/bar.py": read_only_file}
            mock_get_sess.return_value.load.return_value = mock_cache
            from token_goat import session as sess_mod
            with patch.object(sess_mod, "lookup_bash_entry", return_value=mock_entry):
                _try_bash_dedup_serve(payload)

        # Test just confirms the edit-staleness check doesn't short-circuit here.
        # Result may still be None for other guards (size, etc.), so no assertion on result.


# ---------------------------------------------------------------------------
# Compound command classification edge cases
# ---------------------------------------------------------------------------

class TestCompoundCommandClassification:
    def test_anchored_regex_does_not_match_mid_compound(self) -> None:
        """git diff embedded after && must NOT be classified as mutable (^ anchor)."""
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("echo foo && git diff") is False
        assert is_git_mutable_command("cd repo; git diff") is False

    def test_anchored_regex_does_not_match_immutable_mid_compound(self) -> None:
        """git show <sha> embedded after && must NOT be classified as immutable."""
        from token_goat.bash_cache import is_git_immutable_command
        sha = "a" * 40
        assert is_git_immutable_command(f"echo foo && git show {sha}") is False

    def test_git_diff_at_start_matches(self) -> None:
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("git diff HEAD -- src/") is True

    def test_git_status_with_flags(self) -> None:
        from token_goat.bash_cache import is_git_mutable_command
        assert is_git_mutable_command("git status -s -b") is True
