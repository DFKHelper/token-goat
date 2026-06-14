"""Tests for DiffFilter — plain ``diff`` / ``diff3`` / ``sdiff`` / ``colordiff`` / ``wdiff``.

DiffFilter compresses output from the plain ``diff`` family of tools.  Behaviour:

* **Small diff** (≤ 50 non-empty lines): pass through unchanged.
* **Unified diff** (has ``@@ `` hunk headers in first 20 lines): cap hunks per file
  to ``_DIFF_MAX_HUNKS_PER_FILE`` (3); elide extras with a marker.
  If the diff spans > 20 files emit a stat-only summary instead.
* **Normal diff** (no ``@@ `` markers): deduplicate numeric runs + truncate middle.
"""
from __future__ import annotations

from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

_F = bc.DiffFilter()
_ARGV = ["diff", "a.txt", "b.txt"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compress(stdout: str = "", stderr: str = "", exit_code: int = 0) -> str:
    return _apply(_F, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=_ARGV)


def _unified_file_block(filename: str, n_hunks: int, lines_per_hunk: int = 9) -> str:
    """Build a unified-diff block for one file with *n_hunks* hunks."""
    parts = [f"--- a/{filename}", f"+++ b/{filename}"]
    for i in range(n_hunks):
        start = i * 30 + 1
        parts.append(f"@@ -{start},{lines_per_hunk} +{start},{lines_per_hunk} @@")
        for j in range(lines_per_hunk - 2):
            parts.append(f" context {i}_{j}")
        parts.append(f"-removed_line_{i}")
        parts.append(f"+added_line_{i}")
    return "\n".join(parts)


def _small_unified_diff() -> str:
    """A unified diff with only a few lines — below the 50-line passthrough threshold."""
    return "\n".join([
        "--- a/foo.c",
        "+++ b/foo.c",
        "@@ -1,5 +1,5 @@",
        " int main() {",
        "-    return 0;",
        "+    return 1;",
        " }",
    ])


def _large_unified_few_hunks() -> str:
    """A unified diff with many lines but only 3 hunks — all should be kept."""
    return _unified_file_block("bigfile.c", n_hunks=3, lines_per_hunk=20)


def _large_unified_many_hunks() -> str:
    """A unified diff with 5 hunks in one file — extras beyond 3 should be elided."""
    return _unified_file_block("bigfile.c", n_hunks=5, lines_per_hunk=12)


def _multi_file_diff(n_files: int) -> str:
    """Build a multi-file unified diff with *n_files* files."""
    parts = []
    for f in range(n_files):
        parts.append(f"--- a/file{f}.c")
        parts.append(f"+++ b/file{f}.c")
        parts.append("@@ -1,3 +1,3 @@")
        parts.append(f" context_{f}")
        parts.append(f"-old_{f}")
        parts.append(f"+new_{f}")
    return "\n".join(parts)


def _normal_diff_lines(n: int) -> str:
    """Build a plain (non-unified) diff with *n* changed-line pairs."""
    parts = []
    for i in range(n):
        parts.append(f"{i}c{i}")
        parts.append(f"< old line {i}")
        parts.append("---")
        parts.append(f"> new line {i}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# TestDiffFilterMatches
# ---------------------------------------------------------------------------

class TestDiffFilterMatches:
    def test_matches_diff(self) -> None:
        assert _F.matches(["diff", "a.txt", "b.txt"])

    def test_matches_diff3(self) -> None:
        assert _F.matches(["diff3", "mine.txt", "older.txt", "yours.txt"])

    def test_matches_sdiff(self) -> None:
        assert _F.matches(["sdiff", "a.txt", "b.txt"])

    def test_matches_colordiff(self) -> None:
        assert _F.matches(["colordiff", "-u", "a.py", "b.py"])

    def test_matches_wdiff(self) -> None:
        assert _F.matches(["wdiff", "a.txt", "b.txt"])

    def test_does_not_match_git(self) -> None:
        assert not _F.matches(["git", "diff", "HEAD"])

    def test_does_not_match_patch(self) -> None:
        assert not _F.matches(["patch", "-p1"])

    def test_does_not_match_gdiff(self) -> None:
        # gdiff is not in the binaries set
        assert not _F.matches(["gdiff", "a.txt", "b.txt"])


# ---------------------------------------------------------------------------
# TestDiffFilterDispatch
# ---------------------------------------------------------------------------

class TestDiffFilterDispatch:
    def test_select_filter_diff(self) -> None:
        f = bc.select_filter(["diff", "a.txt", "b.txt"])
        assert isinstance(f, bc.DiffFilter)

    def test_select_filter_colordiff(self) -> None:
        f = bc.select_filter(["colordiff", "-u", "a.txt", "b.txt"])
        assert isinstance(f, bc.DiffFilter)


# ---------------------------------------------------------------------------
# TestDiffFilterSmallPassthrough
# ---------------------------------------------------------------------------

class TestDiffFilterSmallPassthrough:
    """Diffs with ≤ 50 non-empty lines must pass through unchanged."""

    def test_small_unified_diff_passes_through(self) -> None:
        text = _small_unified_diff()
        out = _compress(stdout=text)
        # No compression marker should appear; text returned verbatim.
        assert "token-goat" not in out

    def test_file_header_intact_on_small_diff(self) -> None:
        text = _small_unified_diff()
        out = _compress(stdout=text)
        assert "--- a/foo.c" in out
        assert "+++ b/foo.c" in out

    def test_hunk_content_intact_on_small_diff(self) -> None:
        text = _small_unified_diff()
        out = _compress(stdout=text)
        assert "-    return 0;" in out
        assert "+    return 1;" in out

    def test_empty_input(self) -> None:
        out = _compress(stdout="")
        assert isinstance(out, str)

    def test_single_line_diff(self) -> None:
        out = _compress(stdout="1c1\n< foo\n---\n> bar\n")
        assert isinstance(out, str)
        assert "foo" in out


# ---------------------------------------------------------------------------
# TestDiffFilterUnifiedFewHunks
# ---------------------------------------------------------------------------

class TestDiffFilterUnifiedFewHunks:
    """Unified diffs with ≤ MAX_HUNKS+1 hunks per file keep everything."""

    def test_no_elision_marker_when_few_hunks(self) -> None:
        text = _large_unified_few_hunks()
        out = _compress(stdout=text)
        assert "more hunks" not in out

    def test_file_header_kept(self) -> None:
        text = _large_unified_few_hunks()
        out = _compress(stdout=text)
        assert "--- a/bigfile.c" in out

    def test_all_hunk_removals_kept(self) -> None:
        text = _large_unified_few_hunks()
        out = _compress(stdout=text)
        # All 3 hunks' removed/added lines should be present
        for i in range(3):
            assert f"removed_line_{i}" in out
            assert f"added_line_{i}" in out


# ---------------------------------------------------------------------------
# TestDiffFilterUnifiedHunkElision
# ---------------------------------------------------------------------------

class TestDiffFilterUnifiedHunkElision:
    """Unified diffs with 4+ hunks per file elide the extras."""

    def test_elision_marker_present(self) -> None:
        text = _large_unified_many_hunks()
        out = _compress(stdout=text)
        assert "token-goat" in out
        assert "hunks" in out

    def test_first_hunks_kept(self) -> None:
        text = _large_unified_many_hunks()
        out = _compress(stdout=text)
        # The first 3 hunks' content should survive
        assert "removed_line_0" in out
        assert "removed_line_1" in out
        assert "removed_line_2" in out

    def test_excess_hunks_elided(self) -> None:
        text = _large_unified_many_hunks()
        out = _compress(stdout=text)
        # Hunks beyond the cap should be elided
        assert "removed_line_4" not in out

    def test_file_header_preserved_after_elision(self) -> None:
        text = _large_unified_many_hunks()
        out = _compress(stdout=text)
        assert "--- a/bigfile.c" in out

    def test_elision_note_mentions_count(self) -> None:
        text = _large_unified_many_hunks()
        out = _compress(stdout=text)
        # 6 hunk-blocks (header + 5 hunks); 3 kept → 2 elided
        elision_lines = [ln for ln in out.splitlines() if "elided" in ln]
        assert len(elision_lines) == 1
        assert "+2" in elision_lines[0]


# ---------------------------------------------------------------------------
# TestDiffFilterVeryLargeStat
# ---------------------------------------------------------------------------

class TestDiffFilterVeryLargeStatOnly:
    """Diffs spanning > 20 files degrade to a stat-only summary."""

    def test_stat_only_note_present(self) -> None:
        text = _multi_file_diff(n_files=21)
        out = _compress(stdout=text)
        assert "stat-only" in out or "large diff" in out.lower()

    def test_stat_summary_mentions_file_count(self) -> None:
        text = _multi_file_diff(n_files=21)
        out = _compress(stdout=text)
        assert "21" in out

    def test_each_file_listed_in_stat(self) -> None:
        text = _multi_file_diff(n_files=21)
        out = _compress(stdout=text)
        # At least the first few file names must appear in stat listing
        assert "file0.c" in out
        assert "file20.c" in out

    def test_stat_line_has_adds_dels(self) -> None:
        import re
        text = _multi_file_diff(n_files=21)
        out = _compress(stdout=text)
        # Stat lines are "--- a/file.c  +N -M"
        stat_lines = [ln for ln in out.splitlines() if re.search(r"\+\d+ -\d+", ln)]
        assert len(stat_lines) > 0
        assert stat_lines[0].startswith("---")

    def test_twenty_files_does_not_trigger_stat(self) -> None:
        # Exactly 20 files: no stat-only (boundary is > 20)
        text = _multi_file_diff(n_files=20)
        out = _compress(stdout=text)
        # Stat-only view should NOT be triggered for exactly 20 files
        assert "stat-only" not in out


# ---------------------------------------------------------------------------
# TestDiffFilterNormalDiff
# ---------------------------------------------------------------------------

class TestDiffFilterNormalDiff:
    """Plain (non-unified) diffs with no ``@@ `` headers use dedupe+truncate."""

    def test_normal_diff_signal_kept(self) -> None:
        text = _normal_diff_lines(n=20)
        out = _compress(stdout=text)
        # Signal lines (< old / > new) survive
        assert "old line 0" in out

    def test_large_normal_diff_truncated(self) -> None:
        # 200 changed pairs → 800 lines → truncated middle
        text = _normal_diff_lines(n=200)
        out = _compress(stdout=text)
        # The output must be materially shorter than input
        assert len(out) < len(text)

    def test_no_hunk_header_in_output(self) -> None:
        # Normal diff output has no @@ markers of its own
        text = _normal_diff_lines(n=5)
        out = _compress(stdout=text)
        assert "@@ " not in out


# ---------------------------------------------------------------------------
# TestDiffFilterErrorPassthrough
# ---------------------------------------------------------------------------

class TestDiffFilterErrorPassthrough:
    """Non-zero exit: content is still returned (diff exits 1 when files differ)."""

    def test_error_exit_returns_content(self) -> None:
        # diff(1) exits 1 when files differ — this is normal, not an error.
        text = _small_unified_diff()
        out = _compress(stdout=text, exit_code=1)
        assert "-    return 0;" in out

    def test_stderr_message_preserved(self) -> None:
        err = "diff: a.txt: No such file or directory"
        out = _compress(stderr=err, exit_code=2)
        assert "No such file or directory" in out

    def test_stdout_and_stderr_merged_on_error(self) -> None:
        text = _small_unified_diff()
        err = "Binary files a/icon.png and b/icon.png differ"
        out = _compress(stdout=text, stderr=err, exit_code=1)
        assert "Binary files" in out or "return 0" in out
