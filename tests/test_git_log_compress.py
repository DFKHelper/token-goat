"""Tests for git log output compression (Iter 21).

Covers:
  - _is_git_log_cmd: basic detection; excludes non-git-log commands
  - post_bash integration: < 50 lines passes through unchanged
  - post_bash integration: >= 50 lines → compressed with systemMessage
  - post_bash integration: git log -p (patch format) → compressed
  - post_bash integration: exit_code=1 → not compressed (passes through)
  - post_bash integration: systemMessage includes first 5 lines of output
  - post_bash integration: recall hint (bash-output <id>) present when session active
"""
from __future__ import annotations

from token_goat import hooks_read
from token_goat import session as _session_mod
from token_goat.bash_compress import _is_git_log_cmd
from token_goat.session import _fresh_cache

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(
    sid: str,
    cmd: str,
    stdout: str,
    cwd: str,
    *,
    stderr: str = "",
    exit_code: int = 0,
) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        "cwd": cwd,
    }


def _sys_msg(result: dict) -> str:
    return result.get("systemMessage", "")


def _bootstrap_session(sid: str) -> None:
    _session_mod.save(_fresh_cache(sid))


def _make_full_log(n: int) -> str:
    """Generate n fake full-format git log entries (each ~5 lines)."""
    lines: list[str] = []
    for i in range(n):
        sha = f"{'a' * 39}{i % 10}"
        lines += [
            f"commit {sha}",
            "Author: Dev User <dev@example.com>",
            f"Date:   Mon Jan {i + 1:02d} 12:00:00 2024 +0000",
            "",
            f"    Commit message number {i}",
            "",
        ]
    return "\n".join(lines)


def _make_oneline_log(n: int) -> str:
    """Generate n fake --oneline git log entries."""
    return "\n".join(f"abc{i:04d}ef Short commit message {i}" for i in range(n))


# ---------------------------------------------------------------------------
# _is_git_log_cmd unit tests
# ---------------------------------------------------------------------------


class TestIsGitLogCmd:
    def test_basic_git_log(self):
        assert _is_git_log_cmd(["git", "log"]) is True

    def test_git_log_oneline(self):
        assert _is_git_log_cmd(["git", "log", "--oneline"]) is True

    def test_git_log_patch(self):
        assert _is_git_log_cmd(["git", "log", "-p"]) is True

    def test_git_log_stat(self):
        assert _is_git_log_cmd(["git", "log", "--stat"]) is True

    def test_git_log_with_limit(self):
        assert _is_git_log_cmd(["git", "log", "-20"]) is True

    def test_git_log_with_range(self):
        assert _is_git_log_cmd(["git", "log", "main..HEAD"]) is True

    def test_not_git_diff(self):
        assert _is_git_log_cmd(["git", "diff"]) is False

    def test_not_git_status(self):
        assert _is_git_log_cmd(["git", "status"]) is False

    def test_not_echo(self):
        assert _is_git_log_cmd(["echo", "log"]) is False

    def test_empty_argv(self):
        assert _is_git_log_cmd([]) is False

    def test_single_token(self):
        assert _is_git_log_cmd(["git"]) is False

    def test_git_exe_suffix(self):
        assert _is_git_log_cmd(["git.exe", "log", "--oneline"]) is True

    def test_git_full_path(self):
        assert _is_git_log_cmd(["/usr/bin/git", "log"]) is True

    def test_subcommand_case_insensitive(self):
        # Defensive: even if shell normalises to lowercase, LOG should match
        assert _is_git_log_cmd(["git", "LOG"]) is True

    def test_git_log_with_global_flag_C(self) -> None:
        # git -C /some/path log: -C is a value flag (consumes next token)
        assert _is_git_log_cmd(["git", "-C", "/some/path", "log", "--oneline"]) is True

    def test_git_log_with_global_flag_c(self) -> None:
        # git -c key=val log: -c is a value flag (consumes next token)
        assert _is_git_log_cmd(["git", "-c", "user.email=x", "log"]) is True


# ---------------------------------------------------------------------------
# Integration tests via post_bash
# ---------------------------------------------------------------------------


class TestGitLogPostBashIntegration:
    def test_small_output_passes_through(self, tmp_path, tmp_data_dir):
        """< 50 lines of git log output should NOT be compressed."""
        sid = "sess-gl-1"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(10)  # 10 lines — well below threshold
        payload = _make_payload(sid, "git log --oneline", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        # Must not fire the git log compressor
        assert "git log:" not in msg

    def test_large_oneline_compressed(self, tmp_path, tmp_data_dir):
        """>= 50 lines of --oneline output → systemMessage with summary."""
        sid = "sess-gl-2"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(60)  # 60 lines — above threshold
        payload = _make_payload(sid, "git log --oneline", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] git log:" in msg
        assert "commits shown" in msg
        assert "60 lines" in msg

    def test_large_full_format_compressed(self, tmp_path, tmp_data_dir):
        """Full-format git log with >= 50 lines → compressed."""
        sid = "sess-gl-3"
        _bootstrap_session(sid)
        stdout = _make_full_log(10)  # 10 commits × ~6 lines each = 60+ lines
        payload = _make_payload(sid, "git log", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] git log:" in msg
        assert "commits shown" in msg

    def test_git_log_patch_compressed(self, tmp_path, tmp_data_dir):
        """git log -p (patch format) with large output → compressed."""
        sid = "sess-gl-4"
        _bootstrap_session(sid)
        # Build output: full-format headers + patch hunks
        base = _make_full_log(5)
        patch_noise = "\n".join(
            f"+added line {i}\n-removed line {i}" for i in range(30)
        )
        stdout = base + "\n" + patch_noise
        assert len(stdout.splitlines()) >= 50, "test data must exceed threshold"
        payload = _make_payload(sid, "git log -p", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "[token-goat] git log:" in msg

    def test_nonzero_exit_not_compressed(self, tmp_path, tmp_data_dir):
        """exit_code=1 → compressor must not fire."""
        sid = "sess-gl-5"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(60)
        payload = _make_payload(
            sid, "git log --oneline", stdout, str(tmp_path), exit_code=1
        )
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "git log:" not in msg

    def test_first_5_lines_in_message(self, tmp_path, tmp_data_dir):
        """systemMessage must include the first 5 lines of output verbatim."""
        sid = "sess-gl-6"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(60)
        first_lines = stdout.splitlines()[:5]
        payload = _make_payload(sid, "git log --oneline", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        for line in first_lines:
            assert line in msg

    def test_recall_hint_present_with_session(self, tmp_path, tmp_data_dir):
        """When a session is active, systemMessage must contain bash-output recall hint."""
        sid = "sess-gl-7"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(60)
        payload = _make_payload(sid, "git log --oneline", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "bash-output" in msg

    def test_omitted_line_count_in_message(self, tmp_path, tmp_data_dir):
        """systemMessage reports how many lines were omitted."""
        sid = "sess-gl-8"
        _bootstrap_session(sid)
        stdout = _make_oneline_log(60)  # 60 lines total, 5 shown → 55 omitted
        payload = _make_payload(sid, "git log --oneline", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "55 lines omitted" in msg

    def test_commit_count_detected_full_format(self, tmp_path, tmp_data_dir):
        """Commit count from full-format git log (^commit <40-hex>) is reported."""
        sid = "sess-gl-9"
        _bootstrap_session(sid)
        stdout = _make_full_log(10)  # exactly 10 commits
        payload = _make_payload(sid, "git log", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "10 commits shown" in msg

    def test_non_git_log_not_intercepted(self, tmp_path, tmp_data_dir):
        """git diff (not git log) with large output must not trigger git log block."""
        sid = "sess-gl-10"
        _bootstrap_session(sid)
        # Build a large diff-like output
        stdout = "\n".join(f"+line {i}" for i in range(60))
        payload = _make_payload(sid, "git diff", stdout, str(tmp_path))
        result = hooks_read.post_bash(payload)
        msg = _sys_msg(result)
        assert "git log:" not in msg
