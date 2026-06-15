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

    def test_long_oneline_truncated_to_50(self) -> None:
        """--oneline cap is 50 lines (vs 10 for full-format); 80 commits → +30 elided."""
        text = self._make_oneline(80)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        assert "+30 more commits" in result
        assert "abc0000ef" in result  # first commit kept
        assert "abc0079ef" not in result  # last commit elided (beyond cap)

    def test_oneline_autodetected_without_flag(self) -> None:
        """Heuristic: if every line starts with a short hash it is oneline format.
        Uses 60 commits to exceed the 50-line --oneline cap."""
        text = self._make_oneline(60)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log"])
        assert "more commits" in result

    def test_oneline_49_lines_passthrough(self) -> None:
        """49 oneline commits (below the 50-cap) pass through without truncation."""
        text = self._make_oneline(49)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        # All 49 commits should appear with no truncation marker
        assert "more commits" not in result
        for i in range(49):
            assert f"Short commit message {i}" in result

    def test_oneline_exactly_50_passthrough(self) -> None:
        """Exactly 50 oneline commits should pass through without truncation."""
        text = self._make_oneline(50)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        assert "more commits" not in result

    def test_oneline_51_lines_truncated(self) -> None:
        """51 oneline commits (just above the 50-cap) triggers truncation."""
        text = self._make_oneline(51)
        f = bc.GitLogFilter()
        result = _apply(f, text, ["git", "log", "--oneline"])
        assert "+1 more commits" in result


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

    def test_large_stat_dir_rollup(self) -> None:
        # 25 files all under src/ → single rollup line, no individual filenames.
        text = self._make_stat_diff(25)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "src/ (25 files," in result
        assert "file0.py" not in result
        assert "file24.py" not in result

    def test_large_stat_summary_always_present(self) -> None:
        text = self._make_stat_diff(25)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "files changed" in result

    def test_large_stat_pathspec_truncates_not_rollup(self) -> None:
        # With an explicit pathspec (--) individual file listing is kept (truncated).
        text = self._make_stat_diff(25)
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat", "--", "src/"])
        assert "more files changed" in result
        assert "file0.py" in result
        assert "src/ (" not in result

    def test_large_stat_multi_dir_rollup(self) -> None:
        # Files spread across several top-level dirs produce one rollup line each.
        lines = [
            " alpha/a.py | 3 +++",
            " alpha/b.py | 2 ++",
            " beta/c.py | 5 +++++",
            " beta/d.py | 1 +",
            " gamma/e.py | 4 ++++",
        ] * 5  # 25 lines, 3 directories
        summary = " 25 files changed, 75 insertions(+)"
        text = "\n".join(lines) + "\n" + summary
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "alpha/ (" in result
        assert "beta/ (" in result
        assert "gamma/ (" in result
        assert "a.py" not in result

    def test_large_stat_root_files_grouped(self) -> None:
        # Files with no slash in their path go under "(root)".
        root_files = [f" file{i}.txt | 1 +" for i in range(25)]
        summary = " 25 files changed, 25 insertions(+)"
        text = "\n".join(root_files) + "\n" + summary
        f = bc.GitDiffFilter()
        result = _apply(f, text, ["git", "diff", "--stat"])
        assert "(root) (25 files," in result
        assert "file0.txt" not in result


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
        # Per-file listing is collapsed to a grouped count; advice is stripped.
        assert "1 modified" in result
        assert "src/foo.py" not in result
        assert 'use "git add' not in result
        assert 'use "git restore' not in result
        assert "no changes added to commit" not in result

    def test_nothing_to_commit_preserved(self) -> None:
        text = (
            "On branch main\n"
            "nothing to commit, working tree clean\n"
        )
        f = bc.GitStatusVerboseFilter()
        result = _apply(f, text, ["git", "status"])
        # The clean-tree signal is the whole point of the command — keep it.
        assert "nothing to commit, working tree clean" in result
        assert "On branch main" in result

    def test_untracked_list_grouped_to_count(self) -> None:
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
        assert "3 untracked" in result
        assert "new_file_0.py" not in result

    def test_long_untracked_list_grouped_to_count(self) -> None:
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
        assert "15 untracked" in result
        assert "new_file_0.py" not in result
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


# ---------------------------------------------------------------------------
# _is_repetitive_json_hunk
# ---------------------------------------------------------------------------


class TestIsRepetitiveJsonHunk:
    @staticmethod
    def _jsonl_hunk(n: int, keys: dict | None = None) -> list[str]:
        import json
        if keys is None:
            keys = {"ts": "2026-01-01", "entity": "campaign", "success": True}
        return [f'+{json.dumps({**keys, "i": i})}' for i in range(n)]

    def test_returns_false_for_small_hunk(self) -> None:
        lines = self._jsonl_hunk(5)
        assert bc._is_repetitive_json_hunk(lines) is False

    def test_returns_true_for_uniform_jsonl(self) -> None:
        lines = self._jsonl_hunk(50)
        assert bc._is_repetitive_json_hunk(lines) is True

    def test_returns_false_for_plain_code_lines(self) -> None:
        lines = [f"+    result = compute_{i}(x)" for i in range(50)]
        assert bc._is_repetitive_json_hunk(lines) is False

    def test_returns_false_when_key_sets_too_diverse(self) -> None:
        import json
        lines = [f'+{json.dumps({"key_" + str(i): i})}' for i in range(50)]
        assert bc._is_repetitive_json_hunk(lines) is False

    def test_returns_false_for_mixed_json_and_code(self) -> None:
        import json
        json_lines = [f'+{json.dumps({"x": i})}' for i in range(20)]
        code_lines = [f"+x = {i}" for i in range(30)]
        # Only 40% JSON → below 75% threshold
        assert bc._is_repetitive_json_hunk(json_lines + code_lines) is False


# ---------------------------------------------------------------------------
# GitDiffFilter: JSONL hunk → semantic summary
# ---------------------------------------------------------------------------


class TestGitDiffFilterJsonlHunk:
    @staticmethod
    def _make_jsonl_diff(n: int) -> str:
        import json
        record = {"ts": "2026-01-01T00:00:00Z", "entity": "campaign", "op": "create", "success": True}
        added = "\n".join(f'+{json.dumps({**record, "i": i})}' for i in range(n))
        return (
            "diff --git a/audit.jsonl b/audit.jsonl\n"
            "--- a/audit.jsonl\n"
            "+++ b/audit.jsonl\n"
            "@@ -1,3 +1,100 @@\n"
            " existing_line\n"
            + added
        )

    def test_large_jsonl_hunk_gets_semantic_summary(self) -> None:
        diff = self._make_jsonl_diff(100)
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        assert "repetitive JSON/JSONL block" in result
        assert "+100 JSON records added" in result

    def test_semantic_summary_includes_sample_lines(self) -> None:
        diff = self._make_jsonl_diff(100)
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        # Must include at least one actual JSON line as a sample
        assert '{"ts":' in result or '"entity"' in result

    def test_semantic_summary_includes_bash_output_hint(self) -> None:
        diff = self._make_jsonl_diff(100)
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        assert "bash-output" in result

    def test_small_jsonl_hunk_uses_normal_truncation(self) -> None:
        diff = self._make_jsonl_diff(5)
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        assert "repetitive JSON/JSONL block" not in result

    def test_diff_header_preserved_in_semantic_summary(self) -> None:
        diff = self._make_jsonl_diff(100)
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        assert "diff --git a/audit.jsonl" in result

    def test_regression_session_e10faf71_jsonl_pattern(self) -> None:
        """611-line JSONL append (the pattern that caused the 80% compact failure) is compressed to a semantic summary."""
        import json
        record = {
            "ts": "2026-06-08T22:46:10.327Z",
            "run_id": "local-1780958770327",
            "platform": "google_ads",
            "entity_type": "campaign",
            "operation": "create",
            "resource_name": None,
            "campaign_name": None,
            "before": None,
            "after": None,
            "module": "TestModule",
            "success": True,
        }
        added = "\n".join(f'+{json.dumps({**record, "i": i})}' for i in range(611))
        diff = (
            "diff --git a/memory/ads/mutation-audit-log.jsonl b/memory/ads/mutation-audit-log.jsonl\n"
            "--- a/memory/ads/mutation-audit-log.jsonl\n"
            "+++ b/memory/ads/mutation-audit-log.jsonl\n"
            "@@ -2403,3 +2403,611 @@\n"
            " existing_record\n"
            + added
        )
        f = bc.GitDiffFilter()
        result = _apply(f, diff, ["git", "diff"])
        assert "repetitive JSON/JSONL block" in result
        # Result must be dramatically smaller than input
        assert len(result) < len(diff) * 0.1


# ---------------------------------------------------------------------------
# Compound &&-command wrapping
# ---------------------------------------------------------------------------


class TestDetectSingleSegment:
    def test_detects_git_diff(self) -> None:
        result = bc._detect_single_segment("git diff")
        assert result is not None
        filter_, _ = result
        assert filter_.name == "git-diff"

    def test_detects_git_log(self) -> None:
        result = bc._detect_single_segment("git log --oneline -5")
        assert result is not None
        filter_, _ = result
        assert filter_.name == "git-log"

    def test_rejects_pipe_inside_segment(self) -> None:
        assert bc._detect_single_segment("git log | head -10") is None

    def test_rejects_semicolon_inside_segment(self) -> None:
        assert bc._detect_single_segment("git diff; echo done") is None

    def test_rejects_logical_or(self) -> None:
        assert bc._detect_single_segment("git diff || echo failed") is None

    def test_rejects_command_substitution(self) -> None:
        assert bc._detect_single_segment("git log $(git rev-parse HEAD)") is None

    def test_unknown_command_routes_to_tail_trunc(self) -> None:
        # TailTruncFilter is the catch-all; unknown tools no longer return None.
        result = bc._detect_single_segment("my_totally_unregistered_tool --flag")
        assert result is not None
        filter_, _ = result
        assert isinstance(filter_, bc.TailTruncFilter)


class TestTryWrapCompoundSegments:
    @staticmethod
    def _wrapper(filter_name: str, seg: str) -> str | None:
        return f"wrapped[{filter_name}]({seg})"

    def test_wraps_both_segments(self) -> None:
        result = bc.try_wrap_compound_segments(
            "git diff && git log --oneline -5",
            wrapper_args=self._wrapper,
        )
        assert result is not None
        assert "wrapped[git-diff](git diff)" in result
        assert "wrapped[git-log](git log --oneline -5)" in result
        assert " && " in result

    def test_preserves_order(self) -> None:
        result = bc.try_wrap_compound_segments(
            "git diff && git log --oneline -5",
            wrapper_args=self._wrapper,
        )
        assert result is not None
        assert result.index("git-diff") < result.index("git-log")

    def test_unknown_segment_routes_to_tail_trunc(self) -> None:
        # TailTruncFilter is now the catch-all: unknown segments (echo hello)
        # are wrapped with tail-trunc instead of left bare.
        result = bc.try_wrap_compound_segments(
            "git diff && echo hello",
            wrapper_args=self._wrapper,
        )
        assert result is not None
        assert "wrapped[git-diff](git diff)" in result
        # "echo hello" is now wrapped by TailTruncFilter (the catch-all).
        assert "wrapped[tail-trunc](echo hello)" in result

    def test_all_unknown_segments_route_to_tail_trunc(self) -> None:
        # TailTruncFilter is now the catch-all: all-unknown compound commands
        # are wrapped instead of being left unwrapped (returned None).
        result = bc.try_wrap_compound_segments(
            "echo foo && echo bar",
            wrapper_args=self._wrapper,
        )
        assert result is not None
        assert "wrapped[tail-trunc](echo foo)" in result
        assert "wrapped[tail-trunc](echo bar)" in result

    def test_returns_none_for_pipe(self) -> None:
        assert bc.try_wrap_compound_segments("git diff | grep foo", wrapper_args=self._wrapper) is None

    def test_returns_none_for_semicolon(self) -> None:
        assert bc.try_wrap_compound_segments("git diff; git log", wrapper_args=self._wrapper) is None

    def test_returns_none_for_logical_or(self) -> None:
        assert bc.try_wrap_compound_segments("git diff || git log", wrapper_args=self._wrapper) is None

    def test_returns_none_for_single_command(self) -> None:
        assert bc.try_wrap_compound_segments("git diff", wrapper_args=self._wrapper) is None

    def test_three_segment_compound(self) -> None:
        result = bc.try_wrap_compound_segments(
            "git diff && git log --oneline -5 && git status",
            wrapper_args=self._wrapper,
        )
        assert result is not None
        parts = result.split(" && ")
        assert len(parts) == 3

    def test_wrapper_returning_none_leaves_segment_unwrapped(self) -> None:
        def disabled_wrapper(filter_name: str, seg: str) -> str | None:
            if filter_name == "git-diff":
                return None  # simulate disabled filter
            return f"wrapped({seg})"

        result = bc.try_wrap_compound_segments(
            "git diff && git log --oneline -5",
            wrapper_args=disabled_wrapper,
        )
        assert result is not None
        assert result.startswith("git diff")  # left unwrapped
        assert "wrapped(git log" in result

    def test_all_disabled_returns_none(self) -> None:
        result = bc.try_wrap_compound_segments(
            "git diff && git log --oneline -5",
            wrapper_args=lambda f, s: None,  # all disabled
        )
        assert result is None
