"""Tests for GitCommitFilter and GitPushFilter."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply(filt: bc.Filter, stdout: str, argv: list[str], stderr: str = "", exit_code: int = 0) -> str:
    return filt.apply(stdout, stderr, exit_code, argv).text


# ---------------------------------------------------------------------------
# GitCommitFilter — dispatch
# ---------------------------------------------------------------------------


class TestGitCommitFilterDispatch:
    def test_registered_before_git_filter(self) -> None:
        f = bc.select_filter(["git", "commit", "-m", "msg"])
        assert f is not None
        assert f.name == "git-commit"

    def test_does_not_match_git_push(self) -> None:
        f = bc.select_filter(["git", "push"])
        assert f is not None
        assert f.name != "git-commit"

    def test_does_not_match_non_git(self) -> None:
        f = bc.GitCommitFilter()
        assert not f.matches(["hg", "commit"])

    def test_does_not_match_git_log(self) -> None:
        f = bc.GitCommitFilter()
        assert not f.matches(["git", "log"])


# ---------------------------------------------------------------------------
# GitCommitFilter — lefthook commit compressed to 1 line
# ---------------------------------------------------------------------------

_LEFTHOOK_COMMIT_OUTPUT = """\
╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
┃  wal-guard ❯
bringing up nodes...
....
4 passed in 4.58s
  ────────────────────────────────────
summary: (done in 5.37 seconds)
✔️ lint (0.11 seconds)
✔️ wal-guard (5.21 seconds)
[main d112339] feat(bash-cache): normalize command strings
 2 files changed, 238 insertions(+), 1 deletion(-)"""


class TestGitCommitFilterLefthook:
    def test_lefthook_passing_compressed_to_one_line(self) -> None:
        f = bc.GitCommitFilter()
        result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"])
        # Must be a single line (no unescaped newlines within the payload)
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) == 1, f"Expected 1 line, got {len(lines)}: {result!r}"

    def test_lefthook_passing_contains_hook_checkmarks(self) -> None:
        f = bc.GitCommitFilter()
        result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"])
        assert "lint" in result
        assert "wal-guard" in result
        assert "✔" in result

    def test_lefthook_passing_contains_commit_ref(self) -> None:
        f = bc.GitCommitFilter()
        result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"])
        assert "d112339" in result
        assert "feat(bash-cache)" in result

    def test_lefthook_passing_contains_files_changed(self) -> None:
        f = bc.GitCommitFilter()
        result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"])
        assert "2 files changed" in result

    def test_lefthook_passing_much_shorter_than_input(self) -> None:
        f = bc.GitCommitFilter()
        result = _apply(f, _LEFTHOOK_COMMIT_OUTPUT, ["git", "commit", "-m", "msg"])
        assert len(result) < len(_LEFTHOOK_COMMIT_OUTPUT) // 2

    def test_lefthook_failing_hook_preserves_error(self) -> None:
        failing_output = """\
╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
error: some lint error on line 42
  ────────────────────────────────────
summary: (done in 1.23 seconds)
✖ lint (1.20 seconds)
✔️ wal-guard (0.03 seconds)"""
        f = bc.GitCommitFilter()
        result = _apply(f, failing_output, ["git", "commit", "-m", "msg"])
        # Error message must be preserved
        assert "lint error on line 42" in result

    def test_no_lefthook_passthrough(self) -> None:
        simple_output = "[main d112339] feat: simple commit\n 1 file changed, 5 insertions(+)"
        f = bc.GitCommitFilter()
        result = _apply(f, simple_output, ["git", "commit", "-m", "msg"])
        assert "d112339" in result
        assert "1 file changed" in result


# ---------------------------------------------------------------------------
# Fixtures shared across GitPushFilter remote-progress tests
# ---------------------------------------------------------------------------

# Realistic small push: 5 lines of intermediate progress per stage (each stage
# would be 100 lines in a real large-repo push — here we use 5 to keep the
# fixture readable while still exercising the compression path).
_REMOTE_PROGRESS_SMALL = """\
Enumerating objects: 5, done.
Counting objects:   0% (1/5)
Counting objects:  20% (1/5)
Counting objects:  40% (2/5)
Counting objects:  60% (3/5)
Counting objects:  80% (4/5)
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects:  33% (1/3)
Compressing objects:  67% (2/3)
Compressing objects: 100% (3/3), done.
Writing objects:  33% (1/3)
Writing objects:  67% (2/3)
Writing objects: 100% (3/3), 1.02 KiB | 1.02 MiB/s, done.
Total 3 (delta 1), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas:   0% (0/1)
remote: Resolving deltas: 100% (1/1), completed with 1 local object.
remote:\x20
remote: Create a pull request for 'feat/new' on GitHub by visiting:
remote:   https://github.com/owner/repo/pull/new/feat/new
remote:\x20
To github.com:owner/repo.git
   7f3a1b2..9c4d5e6  feat/new -> feat/new"""

# Simulate large push: 100 intermediate lines per stage → ~400 lines total
_lines: list[str] = ["Enumerating objects: 1234, done."]
for _pct in range(0, 101):
    _lines.append(f"Counting objects: {_pct}% ({_pct * 10}/1000)")
_lines.append("Counting objects: 100% (1000/1000), done.")
_lines.append("Delta compression using up to 16 threads")
for _pct in range(0, 101):
    _lines.append(f"Compressing objects: {_pct}% ({_pct * 8}/800)")
_lines.append("Compressing objects: 100% (800/800), done.")
for _pct in range(0, 101):
    _lines.append(f"Writing objects: {_pct}% ({_pct * 10}/1000)")
_lines.append("Writing objects: 100% (1000/1000), 12.34 MiB | 5.00 MiB/s, done.")
_lines.append("Total 1000 (delta 500), reused 0 (delta 0), pack-reused 0")
for _pct in range(0, 101):
    _lines.append(f"remote: Resolving deltas: {_pct}% ({_pct * 5}/500)")
_lines.append("remote: Resolving deltas: 100% (500/500), completed with 200 local objects.")
_lines.append("remote: ")
_lines.append("remote: Create a pull request for 'main' on GitHub by visiting:")
_lines.append("remote:   https://github.com/owner/repo/pull/new/main")
_lines.append("remote: ")
_lines.append("To github.com:owner/repo.git")
_lines.append("   abc1234..def5678  main -> main")
_REMOTE_PROGRESS_LARGE = "\n".join(_lines)
del _lines, _pct


# ---------------------------------------------------------------------------
# GitPushFilter — dispatch
# ---------------------------------------------------------------------------


class TestGitPushFilterDispatch:
    def test_registered_before_git_filter(self) -> None:
        f = bc.select_filter(["git", "push"])
        assert f is not None
        assert f.name == "git-push"

    def test_does_not_match_git_commit(self) -> None:
        f = bc.select_filter(["git", "commit", "-m", "x"])
        assert f is not None
        assert f.name != "git-push"

    def test_does_not_match_non_git(self) -> None:
        f = bc.GitPushFilter()
        assert not f.matches(["hg", "push"])

    def test_does_not_match_git_pull(self) -> None:
        f = bc.GitPushFilter()
        assert not f.matches(["git", "pull"])


# ---------------------------------------------------------------------------
# GitPushFilter — push with passing tests compressed
# ---------------------------------------------------------------------------

_PYTEST_DOTS_PASSING = (
    "." * 50 + " [ 10%]\n"
    + "." * 50 + " [ 20%]\n"
    + "." * 50 + " [ 30%]\n"
    + "." * 50 + " [ 40%]\n"
    + "." * 50 + " [ 50%]\n"
    + "." * 50 + " [ 60%]\n"
    + "." * 50 + " [ 70%]\n"
    + "." * 50 + " [ 80%]\n"
    + "." * 50 + " [ 90%]\n"
    + "." * 50 + " [100%]\n"
    + "8333 passed in 9m 21s\n"
    + "   abc123..def456  main -> origin/main"
)


class TestGitPushFilterPassing:
    def test_push_with_passing_tests_compressed(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"])
        lines = [ln for ln in result.split("\n") if ln.strip()]
        # Should be 2 lines or fewer
        assert len(lines) <= 2, f"Expected <=2 lines, got {len(lines)}: {result!r}"

    def test_push_passing_contains_test_count(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"])
        assert "8333" in result
        assert "passed" in result.lower()

    def test_push_passing_contains_ref_update(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"])
        assert "origin/main" in result or "main" in result

    def test_push_passing_much_shorter_than_input(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_PASSING, ["git", "push"])
        assert len(result) < len(_PYTEST_DOTS_PASSING) // 3

    def test_push_no_dots_passthrough(self) -> None:
        simple_output = "   abc123..def456  main -> origin/main\nBranch 'main' set up to track remote branch 'main'."
        f = bc.GitPushFilter()
        result = _apply(f, simple_output, ["git", "push"])
        assert "origin/main" in result


# ---------------------------------------------------------------------------
# GitPushFilter — push with failing tests preserves error
# ---------------------------------------------------------------------------

_PYTEST_DOTS_FAILING = (
    "." * 40 + "F" + "." * 9 + " [ 10%]\n"
    + "." * 50 + " [ 20%]\n"
    + "FAILED tests/test_foo.py::test_bar - AssertionError: expected 1 got 2\n"
    + "." * 48 + "FF [100%]\n"
    + "3 failed, 8330 passed in 9m 45s\n"
    + "   abc123..def456  main -> origin/main"
)


class TestGitPushFilterFailing:
    def test_push_with_failing_tests_preserves_failure_info(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], exit_code=1)
        assert "FAILED" in result or "failed" in result.lower()

    def test_push_failing_contains_error_message(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], exit_code=1)
        assert "AssertionError" in result or "test_bar" in result

    def test_push_failing_strips_dots(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], exit_code=1)
        # The compressed result should not contain lines of pure dots
        dot_lines = [ln for ln in result.split("\n") if bc._PYTEST_DOT_LINE_RE.match(ln)]
        assert len(dot_lines) == 0, f"Found dot lines in compressed output: {dot_lines}"

    def test_push_failing_mentions_count(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _PYTEST_DOTS_FAILING, ["git", "push"], exit_code=1)
        assert "3 failed" in result or "FAILED" in result


# ---------------------------------------------------------------------------
# Edge Case 1: Windows CRLF line endings
# ---------------------------------------------------------------------------


class TestGitCommitFilterCRLF:
    def test_crlf_line_endings_handled(self) -> None:
        """Test that CRLF line endings are properly handled."""
        crlf_output = (
            "╭─────────────────────╮\r\n"
            "│ 🥊 lefthook  v2.1.8  hook:  pre-commit │\r\n"
            "╰─────────────────────╯\r\n"
            "┃  lint ❯\r\n"
            "All checks passed!\r\n"
            "  ────────────────────────────────────\r\n"
            "summary: (done in 5.37 seconds)\r\n"
            "✔️ lint (0.11 seconds)\r\n"
            "✔️ typecheck (0.20 seconds)\r\n"
            "[main d112339] feat: test\r\n"
            " 1 file changed, 10 insertions(+)"
        )
        f = bc.GitCommitFilter()
        result = _apply(f, crlf_output, ["git", "commit", "-m", "msg"])
        # Should not fail and should preserve hook names
        assert "lint" in result
        assert "typecheck" in result
        assert "d112339" in result


# ---------------------------------------------------------------------------
# Edge Case 2: Multiple hook stages (3+ hooks)
# ---------------------------------------------------------------------------


class TestGitCommitFilterMultipleHooks:
    def test_three_hooks_all_pass(self) -> None:
        """Test with 3 hook stages instead of 2."""
        output = """\
╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
┃  typecheck ❯
Type check passed!
┃  format ❯
Formatting check passed!
  ────────────────────────────────────
summary: (done in 10.5 seconds)
✔️ lint (0.11 seconds)
✔️ typecheck (5.20 seconds)
✔️ format (5.19 seconds)
[main abc1234] feat: multi-hook
 3 files changed, 100 insertions(+), 5 deletions(-)"""
        f = bc.GitCommitFilter()
        result = _apply(f, output, ["git", "commit", "-m", "msg"])
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) == 1
        assert "lint" in result
        assert "typecheck" in result
        assert "format" in result
        assert "✔" in result

    def test_four_hooks_one_fails(self) -> None:
        """Test with 4 hook stages, one failing."""
        output = """\
┃  lint ❯
Error on line 42
┃  typecheck ❯
Type check passed!
┃  format ❯
Formatting check passed!
┃  security ❯
Security scan passed!
  ────────────────────────────────────
summary: (done in 15.2 seconds)
✖ lint (1.20 seconds)
✔️ typecheck (5.20 seconds)
✔️ format (3.10 seconds)
✔️ security (5.75 seconds)"""
        f = bc.GitCommitFilter()
        result = _apply(f, output, ["git", "commit", "-m", "msg"])
        # Error should be preserved
        assert "Error on line 42" in result


# ---------------------------------------------------------------------------
# Edge Case 3: commit --amend and --fixup variants
# ---------------------------------------------------------------------------


class TestGitCommitFilterAmendFixup:
    def test_commit_amend_matches(self) -> None:
        """Test that 'git commit --amend' is dispatched to GitCommitFilter."""
        f = bc.select_filter(["git", "commit", "--amend"])
        assert f is not None
        assert f.name == "git-commit"

    def test_commit_fixup_matches(self) -> None:
        """Test that 'git commit --fixup' is dispatched to GitCommitFilter."""
        f = bc.select_filter(["git", "commit", "--fixup=HEAD"])
        assert f is not None
        assert f.name == "git-commit"

    def test_commit_amend_with_message_matches(self) -> None:
        """Test that 'git commit --amend -m msg' is dispatched."""
        f = bc.select_filter(["git", "commit", "--amend", "-m", "fix"])
        assert f is not None
        assert f.name == "git-commit"

    def test_commit_amend_lefthook_compressed(self) -> None:
        """Test that --amend commits with lefthook are compressed."""
        output = """\
╭─────────────────────╮
│ 🥊 lefthook  v2.1.8  hook:  pre-commit │
╰─────────────────────╯
┃  lint ❯
All checks passed!
  ────────────────────────────────────
summary: (done in 0.5 seconds)
✔️ lint (0.45 seconds)
[main d112339] feat: updated
 1 file changed, 2 insertions(+)"""
        f = bc.GitCommitFilter()
        result = _apply(f, output, ["git", "commit", "--amend", "-m", "fix"])
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) == 1
        assert "lint" in result


# ---------------------------------------------------------------------------
# Edge Case 4: Failed hook preserves error block (last 10 lines)
# ---------------------------------------------------------------------------


class TestGitCommitFilterFailedHookErrorPreservation:
    def test_failed_hook_preserves_traceback(self) -> None:
        """Test that failed hook output preserves the error traceback."""
        output = """\
┃  lint ❯
src/module.py:42: Error: undefined name 'foo'
src/module.py:99: Error: unused import 'bar'
Error on line 42
Error on line 99
Some intermediate output
Some more output
The actual traceback starts here
  File "src/module.py", line 42, in <module>
    raise ValueError("Critical error")
ValueError: Critical error
  ────────────────────────────────────
summary: (done in 1.23 seconds)
✖ lint (1.20 seconds)"""
        f = bc.GitCommitFilter()
        result = _apply(f, output, ["git", "commit", "-m", "msg"])
        # The traceback and error should be preserved
        assert "ValueError: Critical error" in result
        assert "File \"src/module.py\", line 42" in result

    def test_failed_hook_multiple_errors_preserved(self) -> None:
        """Test that multiple error messages in failed hook are preserved."""
        output = """\
┃  typecheck ❯
error: Argument 1 to "foo" has incompatible type "str"; expected "int"
error: Name "undefined_var" is not defined
error: Operator "+" not supported for types "str" and "int"
Some output line 1
Some output line 2
Some output line 3
Some output line 4
Some output line 5
Some output line 6
Some output line 7
Traceback (most recent call last):
  File "test.py", line 10, in <module>
    result = func(x)
  File "lib.py", line 5, in func
    return x + "string"
TypeError: unsupported operand type(s) for +
  ────────────────────────────────────
summary: (done in 2.50 seconds)
✖ typecheck (2.40 seconds)"""
        f = bc.GitCommitFilter()
        result = _apply(f, output, ["git", "commit", "-m", "msg"])
        # At least one error line should be preserved
        assert ("TypeError: unsupported operand" in result or
                "error:" in result or
                "Traceback" in result)


# ---------------------------------------------------------------------------
# GitPushFilter — remote/local percentage-progress compression
# ---------------------------------------------------------------------------


class TestGitPushFilterRemoteProgress:
    """Tests for the new remote/local progress compression path."""

    def test_remote_progress_activates_filter(self) -> None:
        """Output with remote progress lines is compressed (not passed through)."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert len(result) < len(_REMOTE_PROGRESS_SMALL)

    def test_intermediate_progress_lines_dropped(self) -> None:
        """Lines like 'Counting objects:  20% (1/5)' are stripped; only final kept."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "Counting objects:  20%" not in result
        assert "Counting objects:  40%" not in result
        assert "Compressing objects:  33%" not in result
        assert "Writing objects:  33%" not in result
        assert "remote: Resolving deltas:   0%" not in result

    def test_final_stage_line_kept(self) -> None:
        """The 100% / 'done' line for each stage is preserved in output."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "Counting objects: 100%" in result
        assert "Compressing objects: 100%" in result
        assert "Writing objects: 100%" in result
        assert "remote: Resolving deltas: 100%" in result

    def test_blank_remote_lines_dropped(self) -> None:
        """Blank 'remote: ' padding lines are not present in compressed output."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        # No line should be exactly "remote:" or "remote: " (just whitespace after colon)
        for ln in result.splitlines():
            assert ln.strip() != "remote:", f"Blank remote line leaked into output: {ln!r}"

    def test_pr_url_kept(self) -> None:
        """GitHub PR-creation URL lines are preserved — they are actionable info."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "https://github.com/owner/repo/pull/new/feat/new" in result

    def test_ref_update_line_kept(self) -> None:
        """The branch ref-update line (SHA range + branch names) is preserved."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "7f3a1b2..9c4d5e6" in result
        assert "feat/new" in result

    def test_to_remote_line_kept(self) -> None:
        """The 'To github.com:...' destination line is preserved."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "To github.com:owner/repo.git" in result

    def test_non_progress_lines_pass_through(self) -> None:
        """Lines unrelated to progress (Total, Delta compression, Enumerating) pass through."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_SMALL, ["git", "push"])
        assert "Enumerating objects: 5, done." in result
        assert "Delta compression using up to 8 threads" in result
        assert "Total 3 (delta 1)" in result

    def test_large_push_compresses_dramatically(self) -> None:
        """A 400-line push output (simulating 14 KB) compresses to ≤20 lines."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_LARGE, ["git", "push"])
        lines = [ln for ln in result.splitlines() if ln.strip()]
        assert len(lines) <= 20, f"Expected ≤20 lines, got {len(lines)}"
        # Still preserves the key outputs
        assert "abc1234..def5678" in result
        assert "https://github.com/owner/repo/pull/new/main" in result

    def test_large_push_final_stage_lines_present(self) -> None:
        """After large push compression, the final-100% line for each stage is present."""
        f = bc.GitPushFilter()
        result = _apply(f, _REMOTE_PROGRESS_LARGE, ["git", "push"])
        assert "Counting objects: 100% (1000/1000), done." in result
        assert "Compressing objects: 100% (800/800), done." in result
        assert "Writing objects: 100% (1000/1000)" in result
        assert "remote: Resolving deltas: 100% (500/500)" in result

    def test_error_line_during_push_kept(self) -> None:
        """error: lines in a push output (e.g. rejected refs) pass through verbatim."""
        output = (
            "Counting objects:   0% (1/10)\n"
            "Counting objects: 100% (10/10), done.\n"
            "error: failed to push some refs to 'github.com:owner/repo.git'\n"
            "hint: Updates were rejected because the remote contains work that you do not have locally.\n"
            "To github.com:owner/repo.git\n"
            " ! [rejected]  main -> main (non-fast-forward)"
        )
        f = bc.GitPushFilter()
        result = _apply(f, output, ["git", "push"], exit_code=1)
        assert "error: failed to push some refs" in result
        assert "hint: Updates were rejected" in result
        assert "[rejected]" in result

    def test_multiremote_both_ref_updates_kept(self) -> None:
        """When multiple ref lines appear they are all preserved."""
        output = (
            "Counting objects: 100% (5/5), done.\n"
            "Writing objects: 100% (5/5), 1.00 KiB | 1.00 MiB/s, done.\n"
            "Total 5 (delta 2), reused 0 (delta 0), pack-reused 0\n"
            "To github.com:owner/repo.git\n"
            "   aaa1111..bbb2222  main -> main\n"
            "   ccc3333..ddd4444  v1.0 -> v1.0"
        )
        f = bc.GitPushFilter()
        result = _apply(f, output, ["git", "push"])
        assert "aaa1111..bbb2222" in result
        assert "ccc3333..ddd4444" in result

    def test_no_progress_lines_passthrough_unchanged(self) -> None:
        """Output with no progress lines is returned unchanged (passthrough guard)."""
        simple = "To github.com:owner/repo.git\n   7f3a1b2..9c4d5e6  main -> main"
        f = bc.GitPushFilter()
        result = _apply(f, simple, ["git", "push"])
        assert result == simple


# ---------------------------------------------------------------------------
# GitPushFilter — pytest pre-push + remote progress combined
# ---------------------------------------------------------------------------


class TestGitPushFilterCombinedPytestAndRemote:
    """When a pre-push hook runs pytest AND the push has remote progress lines."""

    def test_combined_output_compresses_dots_and_remote(self) -> None:
        """Both pytest dots and remote progress lines are collapsed."""
        combined = (
            # Remote progress from the actual push
            "Counting objects:   0% (1/100)\n"
            "Counting objects: 100% (100/100), done.\n"
            "Writing objects: 100% (100/100), 2.00 KiB | 2.00 MiB/s, done.\n"
            "Total 100 (delta 50), reused 0 (delta 0), pack-reused 0\n"
            "remote: Resolving deltas:   0% (0/50)\n"
            "remote: Resolving deltas: 100% (50/50), done.\n"
            "remote: \n"
            # Pytest dot output from the pre-push hook
            + "." * 50 + " [ 50%]\n"
            + "." * 50 + " [100%]\n"
            + "500 passed in 45s\n"
            + "   abc1234..def5678  main -> main"
        )
        f = bc.GitPushFilter()
        result = _apply(f, combined, ["git", "push"])
        # pytest summary preserved
        assert "500 passed" in result
        # ref update preserved
        assert "abc1234..def5678" in result or "main" in result
        # no raw dot lines
        dot_lines = [ln for ln in result.splitlines() if bc._PYTEST_DOT_LINE_RE.match(ln)]
        assert len(dot_lines) == 0


# ---------------------------------------------------------------------------
# CRLF line-ending normalisation warnings (git add / commit / checkout)
#
# Git on Windows emits a two-line warning per touched file:
#   warning: LF will be replaced by CRLF in <path>.
#   The file will have its original line endings in your working directory
# These carry no actionable signal and can appear dozens of times per session.
# ---------------------------------------------------------------------------


_CRLF_PAIR = (
    "warning: LF will be replaced by CRLF in {path}.\n"
    "The file will have its original line endings in your working directory"
)


# Modern git (2.37+) emits a single self-contained line per touched file; this
# is the exact wording produced by git 2.53.0.windows.1.  No continuation line.
_CRLF_MODERN = (
    "warning: in the working copy of '{path}', LF will be replaced by CRLF "
    "the next time Git touches it"
)
_CRLF_MODERN_REVERSE = (
    "warning: in the working copy of '{path}', CRLF will be replaced by LF "
    "the next time Git touches it"
)


class TestStripGitCrlfWarningsHelper:
    def test_strips_pair_and_counts(self) -> None:
        text = (
            _CRLF_PAIR.format(path="a.py") + "\n"
            + _CRLF_PAIR.format(path="b.py") + "\n"
            + _CRLF_PAIR.format(path="c.py")
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 3
        assert cleaned.strip() == ""
        assert "will be replaced" not in cleaned
        assert "original line endings" not in cleaned

    def test_reverse_wording_crlf_to_lf(self) -> None:
        text = (
            "warning: CRLF will be replaced by LF in script.sh.\n"
            "The file will have its original line endings in your working directory"
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 1
        assert cleaned.strip() == ""

    def test_continuation_with_trailing_period(self) -> None:
        text = (
            "warning: LF will be replaced by CRLF in x.txt.\n"
            "The file will have its original line endings in your working directory."
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 1
        assert cleaned.strip() == ""

    def test_real_output_passes_through(self) -> None:
        text = "On branch main\nnothing to commit, working tree clean"
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 0
        assert cleaned == text

    def test_interspersed_real_lines_preserved(self) -> None:
        text = (
            _CRLF_PAIR.format(path="src/a.py") + "\n"
            "Updating files: 100% (42/42), done.\n"
            + _CRLF_PAIR.format(path="src/b.py") + "\n"
            "Switched to branch 'feature'\n"
            + _CRLF_PAIR.format(path="src/c.py")
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 3
        assert "Updating files: 100% (42/42), done." in cleaned
        assert "Switched to branch 'feature'" in cleaned
        assert "will be replaced" not in cleaned
        assert "original line endings" not in cleaned

    def test_orphan_continuation_dropped(self) -> None:
        # A continuation line whose header was already stripped (e.g. split
        # across a truncation boundary) must not survive as noise.
        text = "real output line\nThe file will have its original line endings in your working directory"
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert "real output line" in cleaned
        assert "original line endings" not in cleaned

    def test_no_match_is_zero_cost_identity(self) -> None:
        text = "some unrelated build output\nwith two lines"
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 0
        assert cleaned == text

    # --- Modern git 2.37+ single-line format ------------------------------
    # These exercise the format actually emitted by git 2.53; they fail on
    # the pre-fix regex (which only matched the obsolete two-line pair).

    def test_modern_single_line_stripped_and_counted(self) -> None:
        text = (
            _CRLF_MODERN.format(path="a.py") + "\n"
            + _CRLF_MODERN.format(path="b.py") + "\n"
            + _CRLF_MODERN.format(path="c.py")
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 3
        assert cleaned.strip() == ""
        assert "will be replaced" not in cleaned
        assert "next time Git touches it" not in cleaned

    def test_modern_reverse_wording_crlf_to_lf(self) -> None:
        text = _CRLF_MODERN_REVERSE.format(path="script.sh")
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 1
        assert cleaned.strip() == ""

    def test_modern_trailing_period(self) -> None:
        text = _CRLF_MODERN.format(path="x.txt") + "."
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 1
        assert cleaned.strip() == ""

    def test_modern_interspersed_real_lines_preserved(self) -> None:
        text = (
            _CRLF_MODERN.format(path="src/a.py") + "\n"
            "Updating files: 100% (42/42), done.\n"
            + _CRLF_MODERN.format(path="src/b.py") + "\n"
            "Switched to branch 'feature'\n"
            + _CRLF_MODERN.format(path="src/c.py")
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 3
        assert "Updating files: 100% (42/42), done." in cleaned
        assert "Switched to branch 'feature'" in cleaned
        assert "next time Git touches it" not in cleaned

    def test_modern_crlf_terminated_input(self) -> None:
        # Windows-native git writes \r\n line endings; the helper must still
        # strip the warning when the regex would otherwise see a bare \r before
        # the line anchor.
        text = (
            _CRLF_MODERN.format(path="a.py") + "\r\n"
            + _CRLF_MODERN.format(path="b.py") + "\r\n"
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 2
        assert "next time Git touches it" not in cleaned

    def test_legacy_pair_crlf_terminated_input(self) -> None:
        # The legacy two-line pair, \r\n-terminated, must also strip cleanly.
        text = (
            "warning: LF will be replaced by CRLF in a.py.\r\n"
            "The file will have its original line endings in your working directory\r\n"
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 1
        assert "will be replaced" not in cleaned
        assert "original line endings" not in cleaned

    def test_mixed_modern_and_legacy_formats(self) -> None:
        text = (
            _CRLF_MODERN.format(path="modern.py") + "\n"
            + _CRLF_PAIR.format(path="legacy.py")
        )
        cleaned, count = bc._strip_git_crlf_warnings(text)
        assert count == 2
        assert cleaned.strip() == ""


class TestGitFilterCrlfSuppression:
    def test_git_add_stderr_warnings_stripped(self) -> None:
        # `git add` falls through to GitFilter (name "git"); warnings land on stderr.
        stderr = (
            _CRLF_PAIR.format(path="foo/bar.py") + "\n"
            + _CRLF_PAIR.format(path="foo/baz.py") + "\n"
            + _CRLF_PAIR.format(path="README.md")
        )
        f = bc.select_filter(["git", "add", "-A"])
        assert f is not None and f.name == "git"
        result = f.apply("", stderr, 0, ["git", "add", "-A"]).text
        assert "will be replaced" not in result
        assert "original line endings" not in result

    def test_real_output_survives_with_warnings(self) -> None:
        stdout = "Updating files: 100% (12/12), done."
        stderr = (
            _CRLF_PAIR.format(path="a.py") + "\n"
            + _CRLF_PAIR.format(path="b.py")
        )
        f = bc.GitFilter()
        result = f.apply(stdout, stderr, 0, ["git", "checkout", "main"]).text
        assert "Updating files: 100% (12/12), done." in result
        assert "will be replaced" not in result

    def test_commit_filter_strips_crlf_warnings_on_stderr(self) -> None:
        stdout = "[main d112339] feat: x\n 2 files changed, 4 insertions(+)"
        stderr = (
            _CRLF_PAIR.format(path="src/a.py") + "\n"
            + _CRLF_PAIR.format(path="src/b.py") + "\n"
            + _CRLF_PAIR.format(path="src/c.py")
        )
        result = _apply(bc.GitCommitFilter(), stdout, ["git", "commit", "-m", "x"], stderr=stderr)
        assert "d112339" in result
        assert "will be replaced" not in result
        assert "original line endings" not in result

    def test_git_add_modern_stderr_warnings_stripped(self) -> None:
        # Modern git 2.37+ format through the GitFilter (`git add` → name "git").
        # Fails on the pre-fix regex that only knew the obsolete two-line pair.
        stderr = (
            _CRLF_MODERN.format(path="foo/bar.py") + "\n"
            + _CRLF_MODERN.format(path="foo/baz.py") + "\n"
            + _CRLF_MODERN.format(path="README.md")
        )
        f = bc.select_filter(["git", "add", "-A"])
        assert f is not None and f.name == "git"
        result = f.apply("", stderr, 0, ["git", "add", "-A"]).text
        assert "will be replaced" not in result
        assert "next time Git touches it" not in result

    def test_commit_filter_strips_modern_crlf_warnings(self) -> None:
        stdout = "[main d112339] feat: x\n 2 files changed, 4 insertions(+)"
        stderr = (
            _CRLF_MODERN.format(path="src/a.py") + "\n"
            + _CRLF_MODERN.format(path="src/b.py")
        )
        result = _apply(bc.GitCommitFilter(), stdout, ["git", "commit", "-m", "x"], stderr=stderr)
        assert "d112339" in result
        assert "next time Git touches it" not in result

    def test_modern_crlf_terminated_stderr_through_apply(self) -> None:
        # \r\n-terminated stderr (Windows-native) routed through Filter.apply;
        # normalise() collapses \r\n→\n before the strip runs, so the warning
        # is suppressed.  Fails pre-fix (stripping ran before normalise on \r\n).
        stderr = (
            _CRLF_MODERN.format(path="a.py") + "\r\n"
            + _CRLF_MODERN.format(path="b.py") + "\r\n"
        )
        f = bc.GitFilter()
        result = f.apply("Updating files: 100% (3/3), done.", stderr, 0, ["git", "checkout", "main"]).text
        assert "Updating files: 100% (3/3), done." in result
        assert "next time Git touches it" not in result

    def test_legacy_crlf_terminated_stderr_through_apply(self) -> None:
        # Same path for the legacy two-line pair with \r\n endings.
        stderr = (
            "warning: LF will be replaced by CRLF in a.py.\r\n"
            "The file will have its original line endings in your working directory\r\n"
        )
        f = bc.GitFilter()
        result = f.apply("Updating files: 100% (1/1), done.", stderr, 0, ["git", "checkout", "main"]).text
        assert "Updating files: 100% (1/1), done." in result
        assert "will be replaced" not in result
        assert "original line endings" not in result

    def test_non_git_filter_leaves_phrase_untouched(self) -> None:
        # A non-git command that happens to echo the phrase must not be altered.
        echoed = (
            "warning: LF will be replaced by CRLF in fake.txt.\n"
            "The file will have its original line endings in your working directory"
        )
        # GenericFilter (name "generic") is the universal fallback for any
        # command without a dedicated filter; its name must not start with
        # "git" so the CRLF-suppression gate stays off.
        f = bc.GenericFilter()
        assert not f.name.startswith("git")
        result = f.apply(echoed, "", 0, ["echo", echoed]).text
        assert "will be replaced" in result
        assert "original line endings" in result


# ---------------------------------------------------------------------------
# GitPushFilter — pre-push hook runs a bundler (vite/webpack/esbuild)
# ---------------------------------------------------------------------------

_VITE_PREPUSH_PASSING = (
    "> lefthook run pre-push\n"
    "> build\n"
    "> vite build\n"
    "vite v5.4.2 building for production...\n"
    "transforming (1) index.html\n"
    "transforming (212) src/main.tsx\n"
    "✓ 423 modules transformed.\n"
    "rendering chunks (1)...\n"
    "computing gzip size (1)...\n"
    "dist/index.html                     0.50 kB │ gzip:   0.31 kB\n"
    "dist/assets/index-BH4Mhpqg.css     12.84 kB │ gzip:   3.21 kB\n"
    "dist/assets/vendor-Df9aLp2k.js    142.10 kB │ gzip:  45.88 kB\n"
    "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n"
    "dist/assets/chunk-Aa11Bb22.js      58.04 kB │ gzip:  18.77 kB\n"
    "dist/assets/chunk-Cc33Dd44.js      44.91 kB │ gzip:  14.03 kB\n"
    "dist/assets/chunk-Ee55Ff66.js      31.18 kB │ gzip:   9.55 kB\n"
    "dist/assets/chunk-Gg77Hh88.js      22.07 kB │ gzip:   6.61 kB\n"
    "dist/assets/logo-Ii99Jj00.svg       4.12 kB │ gzip:   1.98 kB\n"
    "dist/assets/font-Kk11Ll22.woff2    18.40 kB\n"
    "✓ built in 8.23s\n"
    "   abc123..def456  main -> origin/main"
)

_VITE_PREPUSH_FAILING = (
    "> lefthook run pre-push\n"
    "> vite build\n"
    "vite v5.4.2 building for production...\n"
    "transforming (212) src/main.tsx\n"
    "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n"
    "error during build:\n"
    "[vite]: Rollup failed to resolve import \"./missing\" from \"src/app.tsx\".\n"
    "  This is most likely unintended because it can break your application.\n"
)

_WEBPACK_PREPUSH = (
    "> husky - pre-push hook\n"
    "> webpack --mode production\n"
    "asset main.js 321 KiB [emitted] [minimized] (name: main)\n"
    "asset vendor.js 142 KiB [emitted] [minimized] (name: vendor)\n"
    "  ./node_modules/react/index.js 190 bytes [built] [code generated]\n"
    "  ./node_modules/react-dom/index.js 4.2 KiB [built] [code generated]\n"
    "  ./node_modules/lodash/lodash.js 540 KiB [built] [code generated]\n"
    "modules by path ./node_modules/ 4.2 MiB\n"
    "runtime modules 1.2 KiB 6 modules\n"
    "webpack 5.89.0 compiled successfully in 4821 ms\n"
    "   abc123..def456  main -> origin/main"
)


class TestGitPushFilterBundler:
    def test_vite_prepush_compressed_small(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) <= 6, f"Expected <=6 lines, got {len(lines)}: {result!r}"

    def test_vite_prepush_drops_asset_rows(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        # No asset-size rows survive.
        assert "gzip:" not in result
        assert "dist/assets/index-Qa83Lm0p.js" not in result
        assert "modules transformed" not in result

    def test_vite_prepush_keeps_summary_marker(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        assert "suppressed" in result
        assert "built in 8.23s" in result

    def test_vite_prepush_keeps_push_ref(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        assert "origin/main" in result

    def test_vite_prepush_keeps_hook_trigger(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        assert "pre-push" in result

    def test_vite_prepush_much_shorter(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_PASSING, ["git", "push"])
        assert len(result) < len(_VITE_PREPUSH_PASSING) // 3

    def test_vite_prepush_failure_preserves_error(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _VITE_PREPUSH_FAILING, ["git", "push"], exit_code=1)
        assert "error during build" in result
        assert "Rollup failed to resolve import" in result
        # Asset rows are still suppressed even on failure.
        assert "gzip:" not in result

    def test_webpack_prepush_compressed(self) -> None:
        f = bc.GitPushFilter()
        result = _apply(f, _WEBPACK_PREPUSH, ["git", "push"])
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) <= 6, f"Expected <=6 lines, got {len(lines)}: {result!r}"
        assert "node_modules" not in result
        assert "compiled successfully" in result
        assert "origin/main" in result

    def test_to_remote_line_passes_through(self) -> None:
        # "To <remote>" header line is git push output and must survive.
        payload = (
            "> lefthook run pre-push\n"
            "> vite build\n"
            "vite v5.4.2 building for production...\n"
            "✓ 423 modules transformed.\n"
            "dist/assets/index-Qa83Lm0p.js     321.26 kB │ gzip:  99.21 kB\n"
            "dist/assets/vendor-Df9aLp2k.js    142.10 kB │ gzip:  45.88 kB\n"
            "✓ built in 8.23s\n"
            "To github.com:owner/repo.git\n"
            "   abc123..def456  main -> origin/main"
        )
        f = bc.GitPushFilter()
        result = _apply(f, payload, ["git", "push"])
        assert "To github.com:owner/repo.git" in result
        assert "origin/main" in result
        assert "gzip:" not in result

    def test_no_bundler_passthrough(self) -> None:
        # Plain push with no bundler block is unchanged.
        simple = "   abc123..def456  main -> origin/main"
        f = bc.GitPushFilter()
        result = _apply(f, simple, ["git", "push"])
        assert result.strip() == simple.strip()
