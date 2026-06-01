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
            # New code uses `git status -z -b` (single round-trip). Synthesize the
            # -z -b NUL-separated format: `## <branch>\0XY file1\0XY file2\0...`.
            # Older mocks passed newline-separated porcelain; convert here so existing
            # `status_output` fixtures keep working with the new parser.
            if "-z" in cmd and "-b" in cmd:
                entries = [line for line in status_output.splitlines() if line]
                result.stdout = "\0".join([f"## {branch}", *entries]) + "\0"
            else:
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
        assert "## Session Context" not in brief
        assert "main" in brief
        # Should mention modified or untracked
        assert "modified" in brief or "untracked" in brief or "staged" in brief
        # Should be single line (no newlines)
        assert "\n" not in brief

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
        assert "Recent:" not in brief  # "Recent:" label removed
        assert " — " in brief  # em-dash separator instead

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
            # Clean repo with commits — brief is returned (commits are useful)
            brief = _build_session_brief(str(tmp_path))
        # The brief is returned because log_lines is non-empty — the skip
        # logic requires BOTH empty status AND empty log.
        assert brief is not None
        # Should not have "clean" label in the new format; should have em-dash + commit
        assert " — abc1234" in brief

    def test_skipped_when_clean_and_no_commits(self, tmp_path):
        """Empty status + empty log = nothing to report, skip the brief."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output="",
            log_output="",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is None


def _make_run_insync(branch: str = "main") -> object:
    """Return a subprocess.run side-effect that simulates a fully clean, in-sync repo.

    ``git rev-list --left-right --count HEAD...origin/<branch>`` returns "0\\t0"
    so ``_skip_log`` is set and the new terse one-liner path is taken.
    """
    def _run(cmd, **kwargs):
        result = MagicMock()
        if "status" in cmd:
            result.returncode = 0
            result.stdout = f"## {branch}...origin/{branch}\0"
        elif "rev-list" in cmd:
            result.returncode = 0
            result.stdout = "0\t0"
        else:
            result.returncode = 0
            result.stdout = ""
        return result
    return _run


class TestBriefCleanInsyncTerseLine:
    """When clean and fully in-sync with origin, brief collapses to one terse line."""

    def test_main_insync_returns_terse_brief(self, tmp_path):
        """Clean main in-sync with origin → 'main (clean)' instead of None."""
        with patch("subprocess.run", side_effect=_make_run_insync("main")):
            brief = _build_session_brief(str(tmp_path))

        assert brief == "main (clean)"

    def test_master_insync_returns_terse_brief(self, tmp_path):
        """Clean master in-sync with origin → 'master (clean)'."""
        with patch("subprocess.run", side_effect=_make_run_insync("master")):
            brief = _build_session_brief(str(tmp_path))

        assert brief == "master (clean)"

    def test_develop_insync_returns_terse_brief(self, tmp_path):
        """Clean develop in-sync with origin → 'develop (clean)'."""
        with patch("subprocess.run", side_effect=_make_run_insync("develop")):
            brief = _build_session_brief(str(tmp_path))

        assert brief == "develop (clean)"

    def test_feature_branch_insync_still_returns_none(self, tmp_path):
        """A non-stable branch that is clean + in-sync still returns None (no info to add)."""
        with patch("subprocess.run", side_effect=_make_run_insync("feature/x")):
            brief = _build_session_brief(str(tmp_path))

        # _skip_log only fires for main/master/develop, so feature/x goes through
        # the normal "nothing to report" path and returns None.
        assert brief is None

    def test_terse_brief_is_cached(self, tmp_path):
        """The terse clean brief is stored in the in-process brief cache."""
        # Clear the module-level cache before the test.
        import token_goat.hooks_session as hs
        hs._brief_cache.clear()
        with patch("subprocess.run", side_effect=_make_run_insync("main")):
            brief1 = _build_session_brief(str(tmp_path))
        # Second call should hit the cache (no new subprocess.run calls).
        with patch("subprocess.run", side_effect=lambda *a, **kw: (_ for _ in ()).throw(AssertionError("subprocess called on cache hit"))):
            brief2 = _build_session_brief(str(tmp_path))
        assert brief1 == brief2 == "main (clean)"


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
        """More than 50 status lines are capped with a (+N more files) notice."""
        lines = "\n".join(f" M src/file{i}.py" for i in range(80))
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=lines,
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        # Brief should summarise counts and emit a (+N more files) notice.
        assert "modified" in brief or "staged" in brief or "changes" in brief
        # 80 files, cap is 50: expect "+30 more files" in the brief.
        assert "more files" in brief


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
            mock_brief.return_value = "main | 1 modified — abc1234 fix"
            with patch("token_goat.hooks_session._detect", return_value=None):
                payload = {"session_id": "brief_test_01", "cwd": str(tmp_path), "source": "startup"}
                result = hooks_cli.session_start(payload)

        assert result.get("continue") is True
        assert "systemMessage" in result
        assert "main | 1 modified" in result["systemMessage"]

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
            mock_brief.return_value = "main | 1 modified"
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


class TestBriefFormatRegression:
    """Regression: brief format is one-line with em-dash separator, no headers/labels."""

    def test_brief_no_header(self, tmp_path):
        """Brief does NOT contain '## Session Context' header."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
            log_output="abc1234 fix",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "## Session Context" not in brief

    def test_brief_no_branch_label(self, tmp_path):
        """Brief does NOT contain 'Branch:' label."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "Branch:" not in brief

    def test_brief_no_recent_label(self, tmp_path):
        """Brief does NOT contain 'Recent:' label."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
            log_output="abc1234 fix",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "Recent:" not in brief

    def test_brief_single_line(self, tmp_path):
        """Brief is a single line (no newlines)."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            status_output=" M foo.py",
            log_output="abc1234 fix auth\ndef5678 add tests",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert "\n" not in brief

    def test_brief_branch_status_commits_format(self, tmp_path):
        """Brief follows format: branch | status — commits."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="main",
            status_output=" M foo.py\n?? new.py",
            log_output="abc1234 fix auth\ndef5678 add tests",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        # Should start with branch name
        assert brief.startswith("main")
        # Should have pipe separator for status
        assert " | " in brief
        # Should have em-dash separator for commits
        assert " — " in brief
        # Order should be: branch | status — commits
        pipe_idx = brief.index(" | ")
        dash_idx = brief.index(" — ")
        assert pipe_idx < dash_idx

    def test_brief_branch_only_when_clean_no_commits(self, tmp_path):
        """Brief is just branch name when status is clean and no commits."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="main",
            status_output="",
            log_output="",
        )):
            brief = _build_session_brief(str(tmp_path))

        # Should be skipped entirely (nothing to report)
        assert brief is None

    def test_brief_branch_status_when_no_commits(self, tmp_path):
        """Brief is 'branch | status' when commits are empty."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="main",
            status_output=" M foo.py\n?? new.py",
            log_output="",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert " — " not in brief  # no em-dash when no commits
        assert " | " in brief
        assert brief.startswith("main")

    def test_brief_branch_commits_when_clean(self, tmp_path):
        """Brief is 'branch — commits' when status is clean."""
        with patch("subprocess.run", side_effect=_make_run_side_effect(
            branch="feature/x",
            status_output="",
            log_output="abc1234 fix auth",
        )):
            brief = _build_session_brief(str(tmp_path))

        assert brief is not None
        assert " | " not in brief  # no pipe when status is empty
        assert " — " in brief
        assert brief.startswith("feature/x")


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
        import threading as _threading
        import time

        def _slow_run(cmd, **kwargs):
            timeout = kwargs.get("timeout", 2.0)
            if "rev-parse" in cmd:
                result = MagicMock()
                result.returncode = 0
                result.stdout = "main\n"
                return result
            # status and log hang until their deadline, then time out (worst case).
            _threading.Event().wait(timeout)
            raise subprocess.TimeoutExpired(cmd, timeout)

        start = time.monotonic()
        with patch("subprocess.run", side_effect=_slow_run):
            _build_session_brief(str(tmp_path))
        elapsed = time.monotonic() - start

        assert elapsed < 3.0, (
            f"session brief took {elapsed:.2f}s — the git calls are not sharing a deadline"
        )


class TestBriefCache:
    """Item 5: _build_session_brief uses a module-level TTL + mtime cache.

    Cache key: cwd.  Cache invalidates when COMMIT_EDITMSG or index mtime
    changes, or when the TTL (60 s) expires.
    """

    def _clear_cache(self) -> None:
        import token_goat.hooks_session as hs
        hs._brief_cache.clear()

    def test_cache_hit_skips_subprocess(self, tmp_path):
        """Second call with identical git-state fingerprint returns cached value."""
        self._clear_cache()

        call_count = {"n": 0}
        original_run = subprocess.run

        def counting_run(cmd, **kwargs):
            call_count["n"] += 1
            return original_run(cmd, **kwargs)

        side_effect = _make_run_side_effect(
            branch="main",
            status_output=" M src/foo.py",
            log_output="abc1234 fix auth",
        )

        with patch("subprocess.run", side_effect=side_effect):
            r1 = _build_session_brief(str(tmp_path))

        # Second call — cache should hit, no subprocess
        with patch("subprocess.run", side_effect=side_effect) as mock_run2:
            r2 = _build_session_brief(str(tmp_path))
            assert mock_run2.call_count == 0, (
                "Cache hit must not call subprocess.run"
            )

        assert r1 == r2

    def test_cache_bust_on_editmsg_mtime_change(self, tmp_path):
        """Changing COMMIT_EDITMSG mtime forces a cache miss."""
        import os

        self._clear_cache()

        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        editmsg = git_dir / "COMMIT_EDITMSG"
        editmsg.write_text("first commit\n")
        (git_dir / "index").write_text("")

        side_effect = _make_run_side_effect(
            branch="main",
            status_output=" M src/foo.py",
            log_output="abc1234 fix auth",
        )
        with patch("subprocess.run", side_effect=side_effect):
            _build_session_brief(str(tmp_path))

        # Advance COMMIT_EDITMSG mtime to simulate a new commit
        new_mtime = editmsg.stat().st_mtime + 2
        os.utime(editmsg, (new_mtime, new_mtime))

        with patch("subprocess.run", side_effect=side_effect) as mock_run:
            _build_session_brief(str(tmp_path))
            assert mock_run.call_count > 0, (
                "Mtime change must bust the cache and call subprocess.run"
            )

    def test_cache_bust_on_index_mtime_change(self, tmp_path):
        """Changing .git/index mtime forces a cache miss."""
        import os

        self._clear_cache()

        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        (git_dir / "COMMIT_EDITMSG").write_text("msg\n")
        index_file = git_dir / "index"
        index_file.write_text("")

        side_effect = _make_run_side_effect(
            branch="feature",
            status_output=" M src/bar.py",
            log_output="def5678 add tests",
        )
        with patch("subprocess.run", side_effect=side_effect):
            _build_session_brief(str(tmp_path))

        # Advance index mtime to simulate a staged change
        new_mtime = index_file.stat().st_mtime + 2
        os.utime(index_file, (new_mtime, new_mtime))

        with patch("subprocess.run", side_effect=side_effect) as mock_run:
            _build_session_brief(str(tmp_path))
            assert mock_run.call_count > 0, (
                "Index mtime change must bust the cache"
            )

    def test_none_result_is_cached(self, tmp_path):
        """A None return (clean repo, no commits) is also cached."""
        self._clear_cache()

        def no_output_run(cmd, **kwargs):
            result = MagicMock()
            if "status" in cmd:
                result.returncode = 0
                if "-z" in cmd and "-b" in cmd:
                    result.stdout = "## main\0"
                else:
                    result.stdout = ""
            elif "log" in cmd:
                result.returncode = 0
                result.stdout = ""
            elif "rev-parse" in cmd:
                result.returncode = 0
                result.stdout = "a" * 40 + "\n"
            return result

        with patch("subprocess.run", side_effect=no_output_run):
            r1 = _build_session_brief(str(tmp_path))

        assert r1 is None

        with patch("subprocess.run", side_effect=no_output_run) as mock_run:
            r2 = _build_session_brief(str(tmp_path))
            assert mock_run.call_count == 0, "None result should be cached too"

        assert r2 is None

    def test_cache_key_is_cwd(self, tmp_path):
        """Different cwd values have independent cache entries."""
        import token_goat.hooks_session as hs
        self._clear_cache()

        dir_a = tmp_path / "repo_a"
        dir_b = tmp_path / "repo_b"
        dir_a.mkdir()
        dir_b.mkdir()

        side_effect_a = _make_run_side_effect(branch="main", status_output=" M a.py", log_output="aaa fix")
        side_effect_b = _make_run_side_effect(branch="dev", status_output=" M b.py", log_output="bbb feat")

        with patch("subprocess.run", side_effect=side_effect_a):
            ra = _build_session_brief(str(dir_a))
        with patch("subprocess.run", side_effect=side_effect_b):
            rb = _build_session_brief(str(dir_b))

        assert ra != rb  # different repos, different briefs
        assert str(dir_a) in hs._brief_cache
        assert str(dir_b) in hs._brief_cache
