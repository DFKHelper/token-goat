"""Tests for LsFilter — ls/eza/ll/dir directory listing compression."""
from __future__ import annotations

import pytest

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_MARKER_PREFIX = "[token-goat:"


def _make_long_listing(n_entries: int, *, total_line: bool = True) -> str:
    """Build a fake ``ls -la`` output with *n_entries* permission lines."""
    lines: list[str] = []
    if total_line:
        lines.append("total 128")
    for i in range(n_entries):
        lines.append(f"-rw-r--r-- 1 user group 1024 Jan  1 00:00 file{i:03d}.txt")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 1. Short listing passes through unchanged
# ---------------------------------------------------------------------------

class TestLsFilterPassthrough:
    def test_short_listing_unchanged(self) -> None:
        """Output with <=25 lines is returned verbatim."""
        output = _make_long_listing(20, total_line=True)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        assert result == output

    def test_exactly_25_lines_passthrough(self) -> None:
        """Exactly 25 lines is the boundary — must pass through."""
        lines = [f"file{i}" for i in range(25)]
        output = "\n".join(lines)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls"])
        assert result == output

    def test_empty_output_passthrough(self) -> None:
        """Empty stdout/stderr returns empty string without error."""
        f = bc.LsFilter()
        result = f.compress("", "", 0, ["ls"])
        assert result == ""


# ---------------------------------------------------------------------------
# 2. Long listing is truncated
# ---------------------------------------------------------------------------

class TestLsFilterTruncation:
    def test_long_listing_produces_marker(self) -> None:
        """Output >25 lines includes the count marker."""
        output = _make_long_listing(30, total_line=False)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        assert _MARKER_PREFIX in result

    def test_total_line_preserved(self) -> None:
        """The ``total N`` disk-usage line is always kept."""
        output = _make_long_listing(30, total_line=True)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        assert result.startswith("total 128")

    def test_first_10_entries_kept(self) -> None:
        """Exactly 10 entry lines appear before the marker."""
        output = _make_long_listing(30, total_line=False)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        lines = result.splitlines()
        marker_idx = next(i for i, ln in enumerate(lines) if _MARKER_PREFIX in ln)
        assert marker_idx == 10

    def test_marker_count_is_correct(self) -> None:
        """Marker reports the correct number of hidden entries."""
        n_entries = 35
        output = _make_long_listing(n_entries, total_line=False)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        hidden = n_entries - 10
        assert f"{hidden} more entries" in result

    def test_total_line_not_counted_as_entry(self) -> None:
        """``total N`` does not consume one of the 10 kept entry slots."""
        output = _make_long_listing(15, total_line=True)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        # 1 total line + 15 entries = 16 lines > 25? No — 16 <= 25, passes through.
        assert result == output

    def test_total_line_plus_many_entries(self) -> None:
        """With total line + 30 entries (31 lines total), exactly 10 entries kept."""
        output = _make_long_listing(30, total_line=True)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        lines = result.splitlines()
        assert lines[0] == "total 128"
        marker_idx = next(i for i, ln in enumerate(lines) if _MARKER_PREFIX in ln)
        # 1 total + 10 entries + marker
        assert marker_idx == 11


# ---------------------------------------------------------------------------
# 3. Multi-section output
# ---------------------------------------------------------------------------

class TestLsFilterMultiSection:
    def _make_multi_section(self, n_entries_each: int) -> str:
        """Build a two-directory ls output."""
        def section(name: str) -> str:
            entries = [f"-rw-r--r-- 1 u g 0 Jan 1 file{i}" for i in range(n_entries_each)]
            return f"{name}:\ntotal 8\n" + "\n".join(entries)
        return section("./dir1") + "\n\n" + section("./dir2")

    def test_section_headers_preserved(self) -> None:
        """Directory section headers (``./dir1:``) are kept in output."""
        output = self._make_multi_section(20)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la", "dir1", "dir2"])
        assert "./dir1:" in result
        assert "./dir2:" in result

    def test_per_section_truncation(self) -> None:
        """Each section is truncated independently — both markers present."""
        output = self._make_multi_section(20)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la", "dir1", "dir2"])
        assert result.count(_MARKER_PREFIX) == 2


# ---------------------------------------------------------------------------
# 4. Binary / dispatch checks
# ---------------------------------------------------------------------------

class TestLsFilterDispatch:
    @pytest.mark.parametrize("argv", [
        ["ls", "-la"],
        ["ls", "-alh"],
        ["eza", "--git", "--long"],
        ["ll"],
        ["dir"],
    ])
    def test_matches_ls_binaries(self, argv: list[str]) -> None:
        """LsFilter.matches() returns True for ls/eza/ll/dir."""
        assert bc.LsFilter().matches(argv)

    def test_select_filter_routes_ls(self) -> None:
        """select_filter(['ls', '-la']) returns the LsFilter instance."""
        f = bc.select_filter(["ls", "-la"])
        assert f is not None
        assert f.name == "ls"

    def test_select_filter_routes_eza(self) -> None:
        """select_filter(['eza', '--long']) returns the LsFilter instance."""
        f = bc.select_filter(["eza", "--long"])
        assert f is not None
        assert f.name == "ls"



class TestLsFilterSectionHeaderEdgeCases:
    def test_filename_with_colon_not_misidentified_as_section_header(self) -> None:
        """A file named 'file:annotation' must not be mistaken for a section header."""
        # 3-line listing: total line + 2 entries, one filename containing a colon.
        output = (
            "total 8\n"
            "-rw-r--r-- 1 user group 100 Jan  1 file:annotation\n"
            "-rw-r--r-- 1 user group 200 Jan  1 notes.txt"
        )
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        # 3 lines is well under the 25-line passthrough threshold -- output unchanged.
        assert result == output


# ---------------------------------------------------------------------------
# 5. Extension grouping in truncation marker
# ---------------------------------------------------------------------------

class TestLsFilterExtensionGrouping:
    """Extension summary is appended to the hidden-entries marker on truncation."""

    @staticmethod
    def _make_mixed_listing(counts: dict[str, int]) -> str:
        """Build a listing with *counts* files per extension (e.g. {'.py': 18})."""
        lines: list[str] = []
        for ext, n in counts.items():
            for i in range(n):
                fname = f"file{i}{ext}" if ext else f"Makefile{i}"
                lines.append(f"-rw-r--r-- 1 u g 0 Jan 1 {fname}")
        return "\n".join(lines)

    def test_by_type_label_in_marker(self) -> None:
        """Truncated listing >=47 files includes 'by type:' in the marker."""
        output = self._make_mixed_listing({".py": 18, ".js": 12, ".ts": 8, ".json": 5, ".csv": 4})
        assert output.count("\n") + 1 == 47
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls"])
        assert "by type:" in result
        assert ".py×18" in result
        assert ".js×12" in result

    def test_top_4_extensions_plus_other(self) -> None:
        """Only top 4 extensions appear by name; the rest are bucketed as other×N."""
        output = self._make_mixed_listing({".py": 10, ".js": 8, ".ts": 6, ".json": 4, ".txt": 3, ".md": 2})
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls"])
        assert "by type:" in result
        # Top-4 by count: .py .js .ts .json; remaining .txt(3)+.md(2)=5 → other×5
        assert "other×5" in result
        # .txt and .md must NOT appear as named extensions in the summary section
        summary_part = result.split("by type:")[-1] if "by type:" in result else ""
        assert ".txt" not in summary_part
        assert ".md" not in summary_part

    def test_directories_excluded_from_ext_count(self) -> None:
        """Directory entries (leading 'd' permissions) do not appear in ext summary."""
        lines: list[str] = []
        for i in range(20):
            lines.append(f"drwxr-xr-x 2 u g 0 Jan 1 subdir{i}/")
        for i in range(15):
            lines.append(f"-rw-r--r-- 1 u g 0 Jan 1 module{i}.py")
        output = "\n".join(lines)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls", "-la"])
        assert "by type:" in result
        # Only .py files counted — directories contribute nothing.
        assert ".py×15" in result

    def test_no_extension_counted_as_other(self) -> None:
        """Files with no extension (Makefile, LICENSE, etc.) count as other×N."""
        lines = [f"-rw-r--r-- 1 u g 0 Jan 1 Makefile{i}" for i in range(30)]
        output = "\n".join(lines)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls"])
        assert "other×30" in result

    def test_still_shows_10_entries_before_marker(self) -> None:
        """Extension grouping does not reduce the 10-entry truncation window."""
        lines = [f"-rw-r--r-- 1 u g 0 Jan 1 file{i}.py" for i in range(30)]
        output = "\n".join(lines)
        f = bc.LsFilter()
        result = f.compress(output, "", 0, ["ls"])
        result_lines = result.splitlines()
        marker_idx = next(i for i, ln in enumerate(result_lines) if "[token-goat:" in ln)
        assert marker_idx == 10
