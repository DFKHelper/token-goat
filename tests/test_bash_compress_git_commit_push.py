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
