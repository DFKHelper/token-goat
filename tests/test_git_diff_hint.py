"""Tests for Iter 4 — scoped-diff hint for large unscoped git diff output.

Covers:
  - is_unscoped_git_diff positive cases (git diff, git diff HEAD, flags, refs)
  - is_unscoped_git_diff negative cases (already scoped, unrelated commands)
  - build_scoped_diff_hint formatting (size, file list, overflow)
  - post_bash integration: hint fires when output is large and edits are present
  - post_bash integration: hint suppressed when output too small
  - post_bash integration: hint suppressed when 0 edited files
  - post_bash integration: hint suppressed when > 10 edited files
  - post_bash integration: hint suppressed for already-scoped diff
  - "git_diff_scope_hint" stat kind is in the "Bash" renderer group
"""
from __future__ import annotations

import pytest

from token_goat.bash_cache import is_unscoped_git_diff
from token_goat.hints import build_scoped_diff_hint

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_post_bash_payload(sid: str, cmd: str, stdout: str, *, cwd: str = "/proj", exit_code: int = 0) -> dict:
    return {
        "session_id": sid,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
        "cwd": cwd,
    }


# ---------------------------------------------------------------------------
# is_unscoped_git_diff — positive
# ---------------------------------------------------------------------------

class TestIsUnscopedGitDiff:
    @pytest.mark.parametrize("cmd", [
        "git diff",
        "git diff HEAD",
        "git diff --stat",
        "git diff --cached",
        "git diff HEAD~2",
        "git diff HEAD~1 HEAD",
        "git diff origin/main",
        "  git diff  ",
        "git diff --name-only",
    ])
    def test_unscoped_commands_detected(self, cmd: str) -> None:
        assert is_unscoped_git_diff(cmd), f"{cmd!r} should be detected as an unscoped git diff"

    @pytest.mark.parametrize("cmd", [
        "git diff -- src/foo.py",
        "git diff HEAD -- foo.py",
        "git diff HEAD~1 -- src/bar.py tests/test_bar.py",
        "git diff --cached -- setup.cfg",
        "ls -la",
        "git status",
        "git show abc123",
        "grep -r pattern src/",
    ])
    def test_scoped_or_unrelated_not_detected(self, cmd: str) -> None:
        assert not is_unscoped_git_diff(cmd), f"{cmd!r} should NOT be detected as an unscoped git diff"


# ---------------------------------------------------------------------------
# build_scoped_diff_hint — formatting
# ---------------------------------------------------------------------------

class TestBuildScopedDiffHint:
    def test_three_files_all_listed(self) -> None:
        files = ["src/foo.py", "src/bar.py", "tests/test_foo.py"]
        hint = build_scoped_diff_hint(5120, files)
        assert "5.0 KB" in hint
        assert "3 file(s)" in hint
        assert "src/foo.py" in hint
        assert "src/bar.py" in hint
        assert "tests/test_foo.py" in hint
        assert "git diff --" in hint
        assert "and" not in hint

    def test_six_files_overflow(self) -> None:
        files = [f"src/file{i}.py" for i in range(6)]
        hint = build_scoped_diff_hint(8192, files)
        assert "8.0 KB" in hint
        assert "6 file(s)" in hint
        assert "+1 more" in hint
        for i in range(5):
            assert f"src/file{i}.py" in hint
        assert "src/file5.py" not in hint
        # The git diff command line must be copy-pasteable — overflow note on a separate line
        diff_line = next(ln for ln in hint.splitlines() if "git diff --" in ln)
        assert "and" not in diff_line, "overflow note must not appear inside the git diff command line"

    def test_size_formatted_as_kb(self) -> None:
        hint = build_scoped_diff_hint(12288, ["src/a.py"])
        assert "12.0 KB" in hint

    def test_hint_prefix(self) -> None:
        hint = build_scoped_diff_hint(4096, ["src/x.py"])
        assert hint.startswith("[tg]")


# ---------------------------------------------------------------------------
# post_bash integration
# ---------------------------------------------------------------------------

_BIG_DIFF = "diff --git a/src/foo.py b/src/foo.py\n" + ("+" * 4200)


class TestPostBashScopedDiffHint:
    def test_hint_fires_for_large_diff_with_edits(self, tmp_data_dir, make_session) -> None:
        """Hint is injected when output > 4096 bytes and 1–10 edited files exist."""
        from token_goat.hooks_read import post_bash

        sid = "diff-hint-1"
        make_session(sid, edits=3)

        payload = _make_post_bash_payload(sid, "git diff", _BIG_DIFF)
        result = post_bash(payload)

        assert result is not None
        msg = result.get("systemMessage", "")
        assert "[tg]" in msg
        assert "git diff --" in msg
        assert "3 file(s)" in msg

    def test_hint_suppressed_when_output_too_small(self, tmp_data_dir, make_session) -> None:
        """Output below 4096 bytes must not trigger the hint."""
        from token_goat.hooks_read import post_bash

        sid = "diff-hint-2"
        make_session(sid, edits=2)

        small_stdout = "diff --git a/x.py b/x.py\n+one line\n"
        payload = _make_post_bash_payload(sid, "git diff", small_stdout)
        result = post_bash(payload)

        msg = result.get("systemMessage", "")
        assert "git diff --" not in msg

    def test_hint_suppressed_when_no_edited_files(self, tmp_data_dir, make_session) -> None:
        """No edited files in session → no hint."""
        from token_goat.hooks_read import post_bash

        sid = "diff-hint-3"
        make_session(sid, edits=0)

        payload = _make_post_bash_payload(sid, "git diff", _BIG_DIFF)
        result = post_bash(payload)

        msg = result.get("systemMessage", "")
        assert "git diff --" not in msg

    def test_hint_suppressed_when_too_many_edited_files(self, tmp_data_dir, make_session) -> None:
        """More than 10 edited files → no hint (too many to suggest a useful scope)."""
        from token_goat import session
        from token_goat.hooks_read import post_bash

        sid = "diff-hint-4"
        # make_session edits param generates generic names; use mark_file_edited for 11
        make_session(sid)
        cache = session.load(sid)
        for i in range(11):
            session.mark_file_edited(sid, f"/proj/src/f{i}.py", cache=cache)
        session.save(cache)

        payload = _make_post_bash_payload(sid, "git diff", _BIG_DIFF)
        result = post_bash(payload)

        msg = result.get("systemMessage", "")
        assert "git diff --" not in msg

    def test_hint_suppressed_for_already_scoped_diff(self, tmp_data_dir, make_session) -> None:
        """git diff -- src/foo.py is already scoped; no hint should fire."""
        from token_goat.hooks_read import post_bash

        sid = "diff-hint-5"
        make_session(sid, edits=2)

        payload = _make_post_bash_payload(sid, "git diff -- src/foo.py", _BIG_DIFF)
        result = post_bash(payload)

        msg = result.get("systemMessage", "")
        assert "git diff --" not in msg or "already" not in msg
        # Stricter: the hint prefix must not appear
        assert "[tg] Large diff" not in msg


# ---------------------------------------------------------------------------
# Stats group membership
# ---------------------------------------------------------------------------

class TestGitDiffScopeHintStatGroup:
    def test_git_diff_scope_hint_in_bash_group(self) -> None:
        from token_goat.render.stats_renderer import _kind_group_label
        assert _kind_group_label("git_diff_scope_hint") == "Bash"
