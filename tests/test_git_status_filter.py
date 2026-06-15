"""Tests for verbose ``git status`` collapsing in :class:`GitStatusVerboseFilter`.

The filter detects full ``git status`` output and collapses each change
section's per-file listing to a grouped count, strips boilerplate advice
lines, and preserves branch / tracking / clean-tree / merge-conflict lines.
Short and porcelain forms are already compact and pass through unchanged.
"""
from __future__ import annotations

from token_goat import bash_compress as bc


def _apply(stdout: str, argv: list[str], stderr: str = "") -> str:
    return bc.GitStatusVerboseFilter().apply(stdout, stderr, 0, argv).text


_VERBOSE = (
    "On branch main\n"
    "Your branch is up to date with 'origin/main'.\n"
    "\n"
    "Changes to be committed:\n"
    '  (use "git restore --staged <file>..." to unstage)\n'
    "\tmodified:   src/a.py\n"
    "\tnew file:   src/b.py\n"
    "\n"
    "Changes not staged for commit:\n"
    '  (use "git add <file>..." to update what will be committed)\n'
    '  (use "git restore <file>..." to discard changes in working directory)\n'
    "\tmodified:   src/c.py\n"
    "\tmodified:   src/d.py\n"
    "\tdeleted:    src/e.py\n"
    "\n"
    "Untracked files:\n"
    '  (use "git add <file>..." to include in what will be committed)\n'
    "\tf.py\n"
    "\tg.py\n"
    "\th.py\n"
    "\n"
    'no changes added to commit (use "git add" and/or "git commit -a")\n'
)


class TestDispatch:
    def test_git_status_routes_to_filter(self) -> None:
        f = bc.select_filter(["git", "status"])
        assert f is not None
        assert f.name == "git-status"


class TestVerboseCollapse:
    def test_sections_collapse_to_grouped_counts(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        # Per-section grouped counts replace the individual file listings.
        assert "1 modified, 1 new file" in result
        assert "2 modified, 1 deleted" in result

    def test_individual_filenames_are_dropped(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        for name in ("src/a.py", "src/b.py", "src/c.py", "src/e.py", "f.py"):
            assert name not in result

    def test_advice_lines_stripped(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        assert 'use "git ' not in result
        assert "no changes added to commit" not in result

    def test_section_headers_preserved(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        assert "Changes to be committed:" in result
        assert "Changes not staged for commit:" in result
        assert "Untracked files:" in result

    def test_blank_runs_squeezed(self) -> None:
        text = "On branch main\n\n\n\n\nUntracked files:\n\tx.py\n"
        result = _apply(text, ["git", "status"])
        assert "\n\n\n" not in result


class TestUntrackedCount:
    def test_untracked_count_reported(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        assert "3 untracked" in result


class TestBranchPreserved:
    def test_branch_and_tracking_lines_kept(self) -> None:
        result = _apply(_VERBOSE, ["git", "status"])
        assert "On branch main" in result
        assert "Your branch is up to date with 'origin/main'." in result

    def test_head_detached_kept(self) -> None:
        text = (
            "HEAD detached at 1a2b3c4\n"
            "\n"
            "Changes not staged for commit:\n"
            '  (use "git add <file>..." to update what will be committed)\n'
            "\tmodified:   src/x.py\n"
        )
        result = _apply(text, ["git", "status"])
        assert "HEAD detached at 1a2b3c4" in result
        assert "1 modified" in result


class TestNothingToCommit:
    def test_clean_tree_line_preserved(self) -> None:
        text = (
            "On branch main\n"
            "Your branch is up to date with 'origin/main'.\n"
            "\n"
            "nothing to commit, working tree clean\n"
        )
        result = _apply(text, ["git", "status"])
        assert "nothing to commit, working tree clean" in result
        assert "On branch main" in result


class TestMergeConflictPreserved:
    def test_unmerged_entries_kept_verbatim(self) -> None:
        text = (
            "On branch main\n"
            "You have unmerged paths.\n"
            '  (fix conflicts and run "git commit")\n'
            '  (use "git merge --abort" to abort the merge)\n'
            "\n"
            "Unmerged paths:\n"
            '  (use "git add <file>..." to mark resolution)\n'
            "\tboth modified:   src/conflict.py\n"
            "\tboth added:      src/new_conflict.py\n"
            "\n"
            'no changes added to commit (use "git add" and/or "git commit -a")\n'
        )
        result = _apply(text, ["git", "status"])
        # Conflict markers and the specific files survive — never collapsed.
        assert "You have unmerged paths." in result
        assert "Unmerged paths:" in result
        assert "both modified:   src/conflict.py" in result
        assert "both added:      src/new_conflict.py" in result
        # Advice is still stripped.
        assert 'use "git add <file>..." to mark resolution' not in result


class TestShortAndPorcelainPassthrough:
    def test_short_format_passthrough(self) -> None:
        text = "M  src/foo.py\n?? src/bar.py\nD  src/old.py\n"
        result = _apply(text, ["git", "status", "--short"])
        assert "src/foo.py" in result
        assert "src/bar.py" in result
        assert "src/old.py" in result

    def test_short_flag_forces_passthrough_even_for_verboseish_text(self) -> None:
        # Body sniffing would treat this as verbose; the -s flag must win.
        text = "On branch main\n\nUntracked files:\n\tx.py\n"
        result = _apply(text, ["git", "status", "-s"])
        assert result.strip() == text.strip()

    def test_porcelain_passthrough(self) -> None:
        text = "M  src/foo.py\nA  src/added.py\n?? src/new.py\n"
        result = _apply(text, ["git", "status", "--porcelain"])
        assert "src/added.py" in result
        assert "src/new.py" in result

    def test_porcelain_v2_passthrough_via_flag(self) -> None:
        # Porcelain v2 rows ("1 .M ...") are not caught by the body sniffer,
        # so the --porcelain= flag is what triggers passthrough.
        text = (
            "1 .M N... 100644 100644 100644 1111111 2222222 src/foo.py\n"
            "? src/untracked.py\n"
        )
        result = _apply(text, ["git", "status", "--porcelain=v2"])
        assert "src/foo.py" in result
        assert "src/untracked.py" in result
