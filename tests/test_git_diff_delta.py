"""Tests for git diff delta cache (Iter 14).

Covers:
  - _is_git_diff_target detection
  - _normalize_git_diff_args noise-flag stripping
  - First git diff passes through (no suppression)
  - Second identical git diff suppressed with "unchanged" advisory
  - Second diff with small delta (< 20 lines changed) passes through full diff
  - Second diff with large delta (>= 20 lines) emits summary
  - Changed HEAD sha treated as cache miss (passes through)
  - git diff --stat not intercepted by the delta cache path
  - Exit code != 0 not cached
  - Output < 400 bytes not cached
  - --color=never stripped so bare and colorless commands share the cache key
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.hooks_read import _is_git_diff_target, _normalize_git_diff_args
from token_goat.session import _fresh_cache

_FAKE_SHA = "abc1234567890abc1234567890abc1234567890ab"
_FAKE_SHA_2 = "def1234567890def1234567890def1234567890de"

# A diff large enough to trigger caching (>= 400 bytes).
_BIG_DIFF = "diff --git a/foo.py b/foo.py\nindex 000..111 100644\n--- a/foo.py\n+++ b/foo.py\n" + (
    "+" + "x" * 50 + "\n"
) * 10


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post_bash_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


def _fake_run(sha: str):
    """Return a subprocess.run side-effect that returns *sha* for git rev-parse HEAD."""
    def _run(args, **kwargs):
        m = MagicMock()
        if list(args) == ["git", "rev-parse", "HEAD"]:
            m.returncode = 0
            m.stdout = sha + "\n"
        else:
            m.returncode = 0
            m.stdout = ""
        return m
    return _run


# ---------------------------------------------------------------------------
# Unit tests: _is_git_diff_target
# ---------------------------------------------------------------------------

class TestIsGitDiffTarget:
    def test_bare_git_diff(self):
        assert _is_git_diff_target(["git", "diff"]) is True

    def test_git_diff_head(self):
        assert _is_git_diff_target(["git", "diff", "HEAD"]) is True

    def test_git_diff_cached(self):
        assert _is_git_diff_target(["git", "diff", "--cached"]) is True

    def test_git_diff_sha_range(self):
        assert _is_git_diff_target(["git", "diff", "abc123..def456"]) is True

    def test_git_exe_accepted(self):
        assert _is_git_diff_target(["git.exe", "diff", "HEAD"]) is True

    def test_full_path_git(self):
        assert _is_git_diff_target(["/usr/bin/git", "diff", "HEAD"]) is True

    def test_stat_excluded(self):
        assert _is_git_diff_target(["git", "diff", "--stat"]) is False

    def test_shortstat_excluded(self):
        assert _is_git_diff_target(["git", "diff", "--shortstat"]) is False

    def test_numstat_excluded(self):
        assert _is_git_diff_target(["git", "diff", "--numstat"]) is False

    def test_stat_with_other_flags_excluded(self):
        assert _is_git_diff_target(["git", "diff", "--no-color", "--stat", "HEAD"]) is False

    def test_wrong_subcommand(self):
        assert _is_git_diff_target(["git", "log"]) is False

    def test_not_git(self):
        assert _is_git_diff_target(["svn", "diff"]) is False

    def test_empty_argv(self):
        assert _is_git_diff_target([]) is False

    def test_only_git(self):
        assert _is_git_diff_target(["git"]) is False


# ---------------------------------------------------------------------------
# Unit tests: _normalize_git_diff_args
# ---------------------------------------------------------------------------

class TestNormalizeGitDiffArgs:
    def test_bare_diff_no_args(self):
        assert _normalize_git_diff_args(["git", "diff"]) == ""

    def test_head_arg_preserved(self):
        assert _normalize_git_diff_args(["git", "diff", "HEAD"]) == "HEAD"

    def test_color_never_stripped(self):
        assert _normalize_git_diff_args(["git", "diff", "--color=never", "HEAD"]) == "HEAD"

    def test_no_color_stripped(self):
        assert _normalize_git_diff_args(["git", "diff", "--no-color", "HEAD"]) == "HEAD"

    def test_color_always_stripped(self):
        assert _normalize_git_diff_args(["git", "diff", "--color=always"]) == ""

    def test_color_auto_stripped(self):
        assert _normalize_git_diff_args(["git", "diff", "--color=auto"]) == ""

    def test_bare_color_stripped(self):
        assert _normalize_git_diff_args(["git", "diff", "--color"]) == ""

    def test_non_noise_flags_preserved(self):
        result = _normalize_git_diff_args(["git", "diff", "--cached", "HEAD"])
        assert "--cached" in result
        assert "HEAD" in result

    def test_noise_and_real_flags_mixed(self):
        result = _normalize_git_diff_args(["git", "diff", "--no-color", "--cached"])
        assert "--no-color" not in result
        assert "--cached" in result


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------

class TestGitDiffDeltaCache:
    """Integration tests for the git diff delta cache block in post_bash.

    All tests use ``tmp_data_dir`` for session isolation.
    """

    def test_first_diff_passes_through(self, tmp_path, tmp_data_dir):
        """First git diff: output is not suppressed and cache is populated."""
        sid = "sess-gdd-1"
        _bootstrap_session(sid)
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "unchanged" not in msg.lower()
        assert "suppressed" not in msg.lower()

    def test_second_diff_identical_suppressed(self, tmp_path, tmp_data_dir):
        """Second run of git diff with identical output: suppressed with advisory."""
        sid = "sess-gdd-2"
        _bootstrap_session(sid)
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "unchanged" in msg.lower()

    def test_second_diff_small_delta_passes_through(self, tmp_path, tmp_data_dir):
        """Second diff with < 20 lines changed: full new diff passes through (not summarised)."""
        sid = "sess-gdd-3"
        _bootstrap_session(sid)
        # Add a single new line so delta is 1 (< _GIT_DIFF_SMALL_DELTA=20)
        diff2 = _BIG_DIFF + "+new line added\n"
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", diff2, str(tmp_path))
            )
        msg = _sys_msg(result)
        # Not suppressed and not summarised — full diff passes through
        assert "unchanged" not in msg.lower()
        assert "lines added" not in msg

    def test_second_diff_large_delta_emits_summary(self, tmp_path, tmp_data_dir):
        """Second diff with >= 20 lines changed: emits summary instead of full diff."""
        sid = "sess-gdd-3b"
        _bootstrap_session(sid)
        # Build a second diff with 25 new unique lines (delta >= _GIT_DIFF_SMALL_DELTA=20)
        extra = "".join(f"+unique line {i} abcdefghijklmnop\n" for i in range(25))
        diff2 = _BIG_DIFF + extra
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", diff2, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "lines added" in msg
        assert "lines removed" in msg

    def test_changed_head_sha_cache_miss(self, tmp_path, tmp_data_dir):
        """Different HEAD sha → different cache key → no suppression."""
        sid = "sess-gdd-4"
        _bootstrap_session(sid)
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA_2)):
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "unchanged" not in msg.lower()

    def test_git_diff_stat_not_intercepted(self, tmp_path, tmp_data_dir):
        """git diff --stat is NOT handled by the delta cache (left to GitDiffFilter)."""
        sid = "sess-gdd-5"
        _bootstrap_session(sid)
        stat_out = (" foo.py | 5 +++++\n 1 file changed\n") * 30  # big enough, repeated
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff --stat HEAD", stat_out, str(tmp_path))
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff --stat HEAD", stat_out, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "unchanged since last run" not in msg

    def test_exit_code_nonzero_not_cached(self, tmp_path, tmp_data_dir):
        """Non-zero exit code: output not cached, no suppression on repeat."""
        sid = "sess-gdd-6"
        _bootstrap_session(sid)
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(
                    sid, "git diff HEAD", _BIG_DIFF, str(tmp_path), exit_code=1
                )
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(
                    sid, "git diff HEAD", _BIG_DIFF, str(tmp_path), exit_code=1
                )
            )
        msg = _sys_msg(result)
        assert "unchanged" not in msg.lower()

    def test_small_output_not_cached(self, tmp_path, tmp_data_dir):
        """Output < 400 bytes: not cached, no suppression on repeat."""
        sid = "sess-gdd-7"
        _bootstrap_session(sid)
        tiny = "diff --git a/foo.py b/foo.py\n+one line\n"
        assert len(tiny.encode()) < 400, "test fixture must be < 400 bytes"
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", tiny, str(tmp_path))
            )
            result = hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", tiny, str(tmp_path))
            )
        msg = _sys_msg(result)
        assert "unchanged" not in msg.lower()

    def test_color_flag_stripped_from_key(self, tmp_path, tmp_data_dir):
        """--color=never stripped: first call (bare) and second call (with flag) share cache key."""
        sid = "sess-gdd-8"
        _bootstrap_session(sid)
        with patch("subprocess.run", side_effect=_fake_run(_FAKE_SHA)):
            # Populate cache with bare git diff HEAD
            hooks_read.post_bash(
                _make_post_bash_payload(sid, "git diff HEAD", _BIG_DIFF, str(tmp_path))
            )
            # Second call with --color=never → same effective key → should suppress
            result = hooks_read.post_bash(
                _make_post_bash_payload(
                    sid, "git diff --color=never HEAD", _BIG_DIFF, str(tmp_path)
                )
            )
        msg = _sys_msg(result)
        assert "unchanged" in msg.lower()
