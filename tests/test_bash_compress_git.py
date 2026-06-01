"""Tests for dedicated git sub-filters: GitLogFilter, GitDiffFilter,
GitStatusVerboseFilter, and GitBlameFilter."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _apply(filt: bc.Filter, stdout: str, argv: list[str], stderr: str = "") -> str:
    return filt.apply(stdout, stderr, 0, argv).text


# ---------------------------------------------------------------------------
# GitLogFilter
# ---------------------------------------------------------------------------


class TestGitLogFilterDispatch:
    def test_registered_before_git_filter(self) -> None:
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name == "git-log"

    def test_does_not_match_other_git_subcommands(self) -> None:
        assert bc.select_filter(["git", "status"]) is not None
        assert bc.select_filter(["git", "status"]).name != "git-log"  # type: ignore[union-attr]

    def test_does_not_match_non_git(self) -> None:
        f = bc.GitLogFilter()
        assert not f.matches(["hg", "log"])


class TestGitLogFilterOneline:
    def _make_oneline(self, n: int) -> str:
        return "\n".join(f"abc{i:04d}ef Short commit message {i}" for i in range(n))

    def test_short_oneline_passthrough(self) -> None:
        text = self._make_oneline(10)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        for i in range(10):
            assert f"Short commit message {i}" in result

    def test_long_oneline_truncated_to_20(self) -> None:
        text = self._make_oneline(50)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        assert "+30 more commits" in result
        assert "abc0000ef" in result  # first commit kept
        assert "abc0049ef" not in result  # last commit elided

    def test_oneline_autodetected_without_flag(self) -> None:
        """Heuristic: if every line starts with a short hash it is oneline format."""
        text = self._make_oneline(35)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log"])
        assert "more commits" in result


class TestGitLogFilterFullFormat:
    @staticmethod
    def _make_commits(n: int) -> str:
        blocks = []
        for i in range(n):
            blocks.append(
                f"commit abc{i:04d}ef1234567890\n"
                f"Author: Dev User <dev@example.com>\n"
                f"Date:   Mon Jan {i+1:02d} 10:00:00 2025 +0000\n"
                f"\n"
                f"    Fix bug number {i}\n"
            )
        return "\n".join(blocks)

    def test_short_log_passthrough(self) -> None:
        text = self._make_commits(5)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log"])
        assert "Fix bug number 0" in result
        assert "Fix bug number 4" in result

    def test_long_log_collapsed_to_one_liners(self) -> None:
        text = self._make_commits(20)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log"])
        # Each commit should now be a condensed entry (no multi-line blocks)
        lines = [ln for ln in result.split("\n") if ln.strip()]
        # Collapsed: should have fewer lines than original
        original_lines = [ln for ln in text.split("\n") if ln.strip()]
        assert len(lines) < len(original_lines)
        # First commit hash should still appear
        assert "abc0000ef" in result

    def test_merge_commits_preserved(self) -> None:
        text = (
            "commit abcdef1234567890\n"
            "Merge: aaa bbb\n"
            "Author: User <u@e.com>\n"
            "Date:   Mon Jan 01 10:00:00 2025 +0000\n"
            "\n"
            "    Merge branch feature\n"
        ) * 15
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log"])
        assert "Merge:" in result


class TestGitLogFilterPatch:
    @staticmethod
    def _make_patch_log(n_patch_lines: int) -> str:
        diff_lines = "\n".join(
            f"+line {i}" for i in range(n_patch_lines)
        )
        return (
            "commit abcdef1234567890\n"
            "Author: User <u@e.com>\n"
            "Date:   Mon Jan 01 10:00:00 2025 +0000\n"
            "\n"
            "    Big change\n"
            "\n"
            "diff --git a/foo.py b/foo.py\n"
            "--- a/foo.py\n"
            "+++ b/foo.py\n"
            "@@ -1,5 +1,5 @@\n"
            + diff_lines
        )

    def test_small_patch_passthrough(self) -> None:
        text = self._make_patch_log(10)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "-p"])
        assert "patch: " not in result

    def test_large_patch_collapsed(self) -> None:
        text = self._make_patch_log(60)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "-p"])
        assert "patch:" in result and "omitted by token-goat" in result


class TestGitLogFilterStat:
    @staticmethod
    def _make_stat_log(n_files: int) -> str:
        stat_lines = "\n".join(
            f" src/file{i}.py | 5 +++++" for i in range(n_files)
        )
        return (
            "commit abcdef1234567890\n"
            "Author: User <u@e.com>\n"
            "Date:   Mon Jan 01 10:00:00 2025 +0000\n"
            "\n"
            "    Refactor many files\n"
            "\n"
            + stat_lines
            + f"\n {n_files} files changed, {n_files * 5} insertions(+)"
        )

    def test_small_stat_passthrough(self) -> None:
        text = self._make_stat_log(5)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--stat"])
        assert "file0.py" in result

    def test_large_stat_collapsed(self) -> None:
        text = self._make_stat_log(30)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--stat"])
        assert "more stat lines omitted" in result


# ---------------------------------------------------------------------------
# GitDiffFilter
# ---------------------------------------------------------------------------


class TestGitDiffFilterDispatch:
    def test_registered_for_diff(self) -> None:
        f = bc.select_filter(["git", "diff"])
        assert f is not None
        assert f.name == "git-diff"

    def test_registered_for_show(self) -> None:
        f = bc.select_filter(["git", "show"])
        assert f is not None
        assert f.name == "git-diff"

    def test_does_not_match_git_log(self) -> None:
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name != "git-diff"


class TestGitDiffFilterBinary:
    def test_binary_file_collapsed_to_summary(self) -> None:
        text = (
            "diff --git a/image.png b/image.png\n"
            "index abc123..def456 100644\n"
            "Binary files a/image.png and b/image.png differ\n"
        )
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff"])
        assert "Binary files a/image.png and b/image.png differ" in result
        # Index line may be dropped; what matters is the summary survives.
        assert "diff --git a/image.png" in result

    def test_non_binary_unchanged(self) -> None:
        text = (
            "diff --git a/foo.py b/foo.py\n"
            "--- a/foo.py\n"
            "+++ b/foo.py\n"
            "@@ -1,3 +1,3 @@\n"
            "-old\n"
            "+new\n"
        )
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff"])
        assert "-old" in result
        assert "+new" in result


class TestGitDiffFilterLargeHunk:
    @staticmethod
    def _make_large_hunk_diff(n_changed: int) -> str:
        hunk_lines = "\n".join(f"+line {i}" for i in range(n_changed))
        return (
            "diff --git a/big.py b/big.py\n"
            "--- a/big.py\n"
            "+++ b/big.py\n"
            "@@ -1,100 +1,100 @@\n"
            " context\n"
            + hunk_lines
        )

    def test_small_hunk_passthrough(self) -> None:
        text = self._make_large_hunk_diff(10)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff"])
        assert "lines omitted by token-goat" not in result

    def test_large_hunk_truncated(self) -> None:
        text = self._make_large_hunk_diff(80)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff"])
        assert "omitted by token-goat" in result

    def test_header_lines_preserved(self) -> None:
        text = self._make_large_hunk_diff(80)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff"])
        assert "diff --git a/big.py" in result
        assert "--- a/big.py" in result
        assert "+++ b/big.py" in result


class TestGitDiffFilterStat:
    @staticmethod
    def _make_stat_diff(n_files: int) -> str:
        stat_lines = "\n".join(
            f" src/module/file{i}.py | {i + 1} {'+'*(i+1)}" for i in range(n_files)
        )
        adds = sum(i + 1 for i in range(n_files))
        return (
            stat_lines
            + f"\n {n_files} files changed, {adds} insertions(+)"
        )

    def test_small_stat_passthrough(self) -> None:
        text = self._make_stat_diff(5)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "file0.py" in result

    def test_large_stat_collapsed(self) -> None:
        text = self._make_stat_diff(25)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "more files changed" in result
        # First 10 files should be present.
        assert "file0.py" in result
        # Files beyond head should be omitted.
        assert "file24.py" not in result


# ---------------------------------------------------------------------------
# GitStatusVerboseFilter
# ---------------------------------------------------------------------------


class TestGitStatusVerboseFilterDispatch:
    def test_registered_for_status(self) -> None:
        f = bc.select_filter(["git", "status"])
        assert f is not None
        assert f.name == "git-status"


class TestGitStatusVerboseFilterShort:
    def test_short_format_passthrough(self) -> None:
        """Short/porcelain format is already compact — passes through unchanged."""
        text = (
            "M  src/foo.py\n"
            "?? src/bar.py\n"
            "D  src/old.py\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        assert "src/foo.py" in result
        assert "src/bar.py" in result
        assert "src/old.py" in result


class TestGitStatusVerboseFilterFull:
    def test_strips_advice_lines(self) -> None:
        text = (
            "On branch main\n"
            "Changes not staged for commit:\n"
            '  (use "git add <file>..." to update what will be committed)\n'
            '  (use "git restore <file>..." to discard changes in working directory)\n'
            "\tmodified:   src/foo.py\n"
            "\n"
            "no changes added to commit (use \"git add\" and/or \"git commit -a\")\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        assert "src/foo.py" in result
        assert 'use "git add' not in result
        assert 'use "git restore' not in result
        assert "no changes added to commit" not in result

    def test_nothing_to_commit_stripped(self) -> None:
        text = (
            "On branch main\n"
            "nothing to commit, working tree clean\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        assert "nothing to commit" not in result
        assert "On branch main" in result

    def test_short_untracked_list_kept(self) -> None:
        files = "\n".join(f"\t    new_file_{i}.py" for i in range(3))
        text = (
            "On branch main\n"
            "Untracked files:\n"
            '  (use "git add <file>..." to include in what will be committed)\n'
            + files
            + "\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        assert "new_file_0.py" in result
        assert "new_file_2.py" in result

    def test_long_untracked_list_truncated(self) -> None:
        files = "\n".join(f"\tnew_file_{i}.py" for i in range(15))
        text = (
            "On branch main\n"
            "Untracked files:\n"
            '  (use "git add <file>..." to include in what will be committed)\n'
            + files
            + "\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        assert "new_file_0.py" in result
        assert "more untracked files" in result
        assert "new_file_14.py" not in result


# ---------------------------------------------------------------------------
# GitBlameFilter
# ---------------------------------------------------------------------------


class TestGitBlameFilterDispatch:
    def test_registered_for_blame(self) -> None:
        f = bc.select_filter(["git", "blame"])
        assert f is not None
        assert f.name == "git-blame"

    def test_does_not_match_other_git_subcommands(self) -> None:
        f = bc.select_filter(["git", "log"])
        assert f is not None
        assert f.name != "git-blame"


class TestGitBlameFilterAnnotated:
    @staticmethod
    def _make_annotated(commit: str, author: str, n_lines: int) -> str:
        """Build annotated blame output with *n_lines* consecutive lines for one commit."""
        rows: list[str] = []
        for i in range(n_lines):
            rows.append(
                f"{commit} (Author Name {author} 2025-01-01 10:00:00 +0000 {i + 1})"
                f"    def function_{i}(): pass"
            )
        return "\n".join(rows)

    def test_single_commit_run_collapsed(self) -> None:
        text = self._make_annotated("^abc1234", "Alice", 20)
        f = bc.GitBlameFilter()
        result = _apply(f, text, ["git", "blame"])
        # Only first line kept verbatim; rest collapsed.
        assert "more lines by" in result
        lines = [ln for ln in result.split("\n") if ln.strip()]
        assert len(lines) < 20

    def test_multiple_authors_all_represented(self) -> None:
        alice_block = self._make_annotated("^abc1234", "Alice", 10)
        bob_block = self._make_annotated("^def5678", "Bob", 10)
        text = alice_block + "\n" + bob_block
        f = bc.GitBlameFilter()
        result = _apply(f, text, ["git", "blame"])
        assert "abc1234" in result
        assert "def5678" in result

    def test_short_blame_passthrough(self) -> None:
        """Single line per author block — nothing to collapse."""
        text = (
            "^abc1234 (Alice 2025-01-01 10:00:00 +0000  1)    line1\n"
            "^def5678 (Bob   2025-01-02 10:00:00 +0000  2)    line2\n"
            "^ghi9012 (Carol 2025-01-03 10:00:00 +0000  3)    line3\n"
        )
        f = bc.GitBlameFilter()
        result = _apply(f, text, ["git", "blame"])
        # All three hashes should appear.
        assert "abc1234" in result
        assert "def5678" in result
        assert "ghi9012" in result


class TestGitBlameFilterPorcelain:
    @staticmethod
    def _make_porcelain(commit: str, author: str, n_lines: int) -> str:
        """Build porcelain blame output for *n_lines* consecutive lines."""
        rows: list[str] = []
        for i in range(n_lines):
            rows.extend([
                f"{(commit * (40 // len(commit) + 1))[:40]} {i + 1} {i + 1}",
                f"author {author}",
                "author-mail <dev@example.com>",
                "author-time 1700000000",
                "author-tz +0000",
                "committer A. Name",
                "committer-mail <c@example.com>",
                "committer-time 1700000000",
                "committer-tz +0000",
                f"summary Fix something {i}",
                "filename src/module.py",
                f"\tcode line {i}",
            ])
        return "\n".join(rows)

    def test_porcelain_run_collapsed(self) -> None:
        text = self._make_porcelain("abcdef12", "Dev Name", 5)
        f = bc.GitBlameFilter()
        result = _apply(f, text, ["git", "blame", "--porcelain"])
        # Should be shorter than the original.
        assert len(result.split("\n")) < len(text.split("\n"))


# ---------------------------------------------------------------------------
# Integration: filter dispatch consistency
# ---------------------------------------------------------------------------


class TestGitFilterFallback:
    """Ensure GitFilter still handles subcommands not claimed by the new filters."""

    def test_git_fetch_still_routes_to_git_filter(self) -> None:
        f = bc.select_filter(["git", "fetch"])
        assert f is not None
        assert f.name == "git"

    def test_git_push_routes_to_git_push_filter(self) -> None:
        f = bc.select_filter(["git", "push"])
        assert f is not None
        assert f.name == "git-push"

    def test_git_ls_files_still_routes_to_git_filter(self) -> None:
        f = bc.select_filter(["git", "ls-files"])
        assert f is not None
        assert f.name == "git"
