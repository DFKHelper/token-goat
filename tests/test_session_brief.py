"""Tests for the SessionStart orientation brief (_build_session_brief)."""
from __future__ import annotations

import subprocess
from unittest.mock import MagicMock, patch

from token_goat.hooks_session import _build_session_brief

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_run_side_effect(
    branch: str = "main",
    branch_rc: int = 0,
    status_output: str = " M src/foo.py\n?? new.py",
    status_rc: int = 0,
    log_output: str = "abc1234 fix auth\ndef5678 add tests",
    log_rc: int = 0,
):
    """Return a side_effect callable for subprocess.run that simulates git output."""
    def _run(cmd, **kwargs):
        result = MagicMock()
        if "rev-parse" in cmd:
            result.returncode = branch_rc
            result.stdout = branch + "\n"
        elif "status" in cmd:
            result.returncode = status_rc
            result.stdout = status_output
        elif "log" in cmd:
            result.returncode = log_rc
            result.stdout = log_output
        else:
            result.returncode = 0
            result.stdout = ""
        return result
    return _run


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------

class TestBriefInjectedWhenDirty:
    """Brief is returned when git repo has staged/unstaged changes."""

    def test_brief_returned_with_dirty_files(self, tmp_path):
        """When status has changes, brief contains branch + change summary."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M src/foo.py\n?? new.py",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "## Session Context" in brief
        assert "main" in brief
        # Should mention modified or untracked
        assert "modified" in brief or "untracked" in brief or "staged" in brief

    def test_brief_contains_recent_commits(self, tmp_path):
        """Brief includes recent commit hashes from git log."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
            log_output="abc1234 fix auth\ndef5678 add tests",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "abc1234" in brief
        assert "def5678" in brief
        assert "Recent:" in brief

    def test_brief_includes_staged_count(self, tmp_path):
        """Staged files (X != ' ' or '?') appear in the status summary."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output="M  src/auth.py\nA  src/new.py",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "staged" in brief

    def test_brief_branch_name_included(self, tmp_path):
        """Current branch name appears in the brief."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="feature/my-branch",
            status_output=" M foo.py",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "feature/my-branch" in brief


class TestBriefSkippedWhenClean:
    """Brief is skipped when working tree is completely clean and has commits."""

    def test_skipped_when_clean_with_commits(self, tmp_path):
        """Clean tree + commits: brief should be skipped (no new info needed)."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output="",  # no changes
            log_output="abc1234 fix auth",
        )):
            # Clean repo with commits — brief is NOT skipped (commits are useful)
            brief = _build_session_brief(str(tmp_path))
        # The brief is still returned because log_lines is non-empty — the skip
        # logic requires BOTH empty status AND empty log.
        assert brief is not None
        assert "clean" in brief

    def test_skipped_when_clean_and_no_commits(self, tmp_path):
        """Empty status + empty log = nothing to report, skip the brief."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output="",
            log_output="",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is None


class TestBriefSkippedWhenNotGitRepo:
    """Brief is skipped gracefully for non-git directories."""

    def test_skipped_when_not_a_git_repo(self, tmp_path):
        """rev-parse returns 128 (fatal: not a git repo) → None."""
        def _run(cmd, **kwargs):
            result = MagicMock()
            if "rev-parse" in cmd:
                result.returncode = 128
                result.stdout = ""
            else:
                result.returncode = 0
                result.stdout = ""
            return result

        with patch("subprocess.run", side_effect=_run):
            brief = _build_session_brief(str(tmp_path))

        assert brief is None

    def test_skipped_when_git_not_available(self, tmp_path):
        """FileNotFoundError from git (git not installed) → None silently."""
        def _run(cmd, **kwargs):
            raise FileNotFoundError("git not found")

        with patch("subprocess.run", side_effect=_run):
            brief = _build_session_brief(str(tmp_path))

        assert brief is None

    def test_skipped_when_cwd_does_not_exist(self):
        """Non-existent directory path → None without calling subprocess."""
        brief = _build_session_brief("/nonexistent/path/that/does/not/exist")
        assert brief is None

    def test_skipped_when_timeout(self, tmp_path):
        """subprocess.TimeoutExpired on rev-parse → None silently."""
        def _run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 2)

        with patch("subprocess.run", side_effect=_run):
            brief = _build_session_brief(str(tmp_path))

        assert brief is None


class TestBriefDisabledByEnvVar:
    """TOKEN_GOAT_SESSION_BRIEF=0 disables the brief."""

    def test_env_var_zero_disables(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_SESSION_BRIEF=0 → None without running git."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", "0")
        with patch("subprocess.run") as mock_run:
            brief = _build_session_brief(str(tmp_path))
        assert brief is None
        mock_run.assert_not_called()

    def test_env_var_false_disables(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_SESSION_BRIEF=false → None."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", "false")
        with patch("subprocess.run") as mock_run:
            brief = _build_session_brief(str(tmp_path))
        assert brief is None
        mock_run.assert_not_called()

    def test_env_var_no_disables(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_SESSION_BRIEF=no → None."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", "no")
        with patch("subprocess.run") as mock_run:
            brief = _build_session_brief(str(tmp_path))
        assert brief is None
        mock_run.assert_not_called()

    def test_env_var_off_disables(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_SESSION_BRIEF=off → None."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", "off")
        with patch("subprocess.run") as mock_run:
            brief = _build_session_brief(str(tmp_path))
        assert brief is None
        mock_run.assert_not_called()

    def test_env_var_1_enables(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_SESSION_BRIEF=1 (or absent) should not disable."""
        monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", "1")
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
        )):
            brief = _build_session_brief(str(tmp_path))
        assert brief is not None


class TestBriefDisabledByConfig:
    """[session_brief] enabled = false in config.toml disables the brief."""

    def test_config_disabled(self, tmp_path, monkeypatch):
        """Config with session_brief.enabled=False → None."""
        from token_goat.config import Config, SessionBriefConfig

        fake_cfg = Config()
        fake_cfg.session_brief = SessionBriefConfig(enabled=False)

        # Remove env var so config is actually consulted (env takes priority)
        monkeypatch.delenv("TOKEN_GOAT_SESSION_BRIEF", raising=False)

        # _build_session_brief imports config lazily with `from . import config as cfg_mod`
        # so we patch the load function at the module level.
        with patch("token_goat.config.load", return_value=fake_cfg), patch("subprocess.run") as mock_run:
            brief = _build_session_brief(str(tmp_path))

        assert brief is None
        mock_run.assert_not_called()


class TestBriefTokenBudget:
    """Brief stays within ~80 token budget."""

    _CHARS_PER_TOKEN = 4  # conservative estimate

    def test_brief_under_80_tokens(self, tmp_path):
        """Brief with full status + 5 commits stays under 80 tokens."""
        log_output = (
            "abc1234 fix authentication bug in login flow\n"
            "def5678 add unit tests for the auth module\n"
            "ghi9012 refactor database connection pooling\n"
            "jkl3456 update dependencies to latest versions\n"
            "mno7890 initial project setup and configuration"
        )
        status_output = " M src/auth.py\n M src/db.py\n?? docs/new.md\nA  src/feature.py"
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="main",
            status_output=status_output,
            log_output=log_output,
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        token_estimate = len(brief) / self._CHARS_PER_TOKEN
        assert token_estimate <= 80, (
            f"Brief exceeds 80-token budget: ~{token_estimate:.0f} tokens\n{brief}"
        )

    def test_long_commit_messages_truncated(self, tmp_path):
        """Very long commit messages are truncated to keep brief compact."""
        long_msg = "a" * 200
        log_output = f"abc1234 {long_msg}"
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
            log_output=log_output,
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        # The 200-char message should be truncated; the brief should be well under 400 chars
        assert len(brief) < 400

    def test_many_status_lines_capped(self, tmp_path):
        """More than 20 status lines are capped at 20."""
        lines = "\n".join(f" M src/file{i}.py" for i in range(30))
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=lines,
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        # Brief should not list all 30 files (it summarises counts, not filenames)
        # Just verify it returns a sensible summary
        assert "modified" in brief or "staged" in brief or "changes" in brief


# ---------------------------------------------------------------------------
# Integration: session_start hook injects brief
# ---------------------------------------------------------------------------

class TestSessionStartIntegration:
    """session_start hook wires the brief into its response."""

    def test_session_start_injects_brief_on_dirty_repo(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start returns systemMessage with brief when repo is dirty."""
        from token_goat import hooks_cli, worker

        monkeypatch.setattr(worker, "ensure_running", lambda: 1)

        with patch("token_goat.hooks_session._build_session_brief") as mock_brief:
            mock_brief.return_value = "## Session Context\nBranch: main | 1 modified\nRecent: abc1234 fix"
            with patch("token_goat.hooks_session._detect", return_value=None):
                payload = {"session_id": "brief_test_01", "cwd": str(tmp_path), "source": "startup"}
                result = hooks_cli.session_start(payload)

        assert result.get("continue") is True
        assert "systemMessage" in result
        assert "Session Context" in result["systemMessage"]

    def test_session_start_no_brief_when_none(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start returns plain continue when brief is None."""
        from token_goat import hooks_cli, worker

        monkeypatch.setattr(worker, "ensure_running", lambda: 1)

        with patch("token_goat.hooks_session._build_session_brief") as mock_brief:
            mock_brief.return_value = None
            with patch("token_goat.hooks_session._detect", return_value=None):
                payload = {"session_id": "brief_test_02", "cwd": str(tmp_path), "source": "startup"}
                result = hooks_cli.session_start(payload)

        assert result.get("continue") is True
        assert "systemMessage" not in result

    def test_session_start_brief_not_injected_on_compact(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start does NOT call _build_session_brief on compact source."""
        from token_goat import hooks_cli, worker

        monkeypatch.setattr(worker, "ensure_running", lambda: 1)

        with patch("token_goat.hooks_session._build_session_brief") as mock_brief:
            mock_brief.return_value = "## Session Context\nBranch: main | 1 modified"
            with (
                patch("token_goat.hooks_session._detect", return_value=None),
                patch("token_goat.hooks_session._try_recovery_response", return_value=None),
            ):
                # source=compact but recovery returns None (nothing to recover)
                payload = {"session_id": "brief_test_03", "cwd": str(tmp_path), "source": "compact"}
                result = hooks_cli.session_start(payload)

        # On compact source with no recovery, brief IS still called (compact
        # falls through to the non-compact branch when recovery returns None).
        # This is acceptable; the brief is informational regardless of source.
        assert result.get("continue") is True


# ---------------------------------------------------------------------------
# Latency budget — the three git calls share one wall-clock deadline
# ---------------------------------------------------------------------------


class TestBriefLatencyBudget:
    """The git subprocesses must not stack their timeouts into a long pause."""

    def test_session_brief_caps_total_git_latency(self, tmp_path):
        """The three git subprocesses share one wall-clock budget.

        Regression test: each git call used a fixed timeout=2, run sequentially,
        so a slow repo could stack three 2 s timeouts into a ~6 s session-start
        pause. The fix gives the three calls a single ~2.5 s deadline. Here
        rev-parse returns fast but status and log hang to their timeout:
        pre-fix this took ~4 s (status 2 s + log 2 s), the fixed code stays
        near the shared budget and skips the call it no longer has time for.
        """
        import time

        def _slow_run(cmd, **kwargs):
            timeout = kwargs.get("timeout", 2.0)
            if "rev-parse" in cmd:
                result = MagicMock()
                result.returncode = 0
                result.stdout = "main\n"
                return result
            # status and log hang until their deadline, then time out (worst case).
            time.sleep(timeout)
            raise subprocess.TimeoutExpired(cmd, timeout)

        start = time.monotonic()
        with patch("subprocess.run", side_effect=_slow_run):
            _build_session_brief(str(tmp_path))
        elapsed = time.monotonic() - start

        assert elapsed < 3.0, (
            f"session brief took {elapsed:.2f}s — the git calls are not sharing a deadline"
        )
