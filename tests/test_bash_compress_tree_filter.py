"""Tests for TreeFilter — tree command output compression."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_tree(top_dirs: int, subdirs_each: int, files_each: int, *, summary: bool = True) -> str:
    """Build synthetic tree output with three levels of depth.

    Structure::

        .
        ├── topdir0/            ← depth 1 (kept)
        │   ├── subdir0/        ← depth 2 (kept)
        │   │   ├── file0.py    ← depth 3 (collapsed)
        │   │   └── file1.py    ← depth 3 (collapsed)
        │   └── subdir1/        ← depth 2 (kept)
        │       └── file0.py    ← depth 3 (collapsed)
        └── topdir1/            ← depth 1 (kept)
            ...
    """
    lines = ["."]
    for t in range(top_dirs):
        is_last_top = t == top_dirs - 1
        top_conn = "└── " if is_last_top else "├── "
        top_cont = "    " if is_last_top else "│   "
        lines.append(f"{top_conn}topdir{t}/")
        for s in range(subdirs_each):
            is_last_sub = s == subdirs_each - 1
            sub_conn = "└── " if is_last_sub else "├── "
            sub_cont = "    " if is_last_sub else "│   "
            lines.append(f"{top_cont}{sub_conn}subdir{s}/")
            for f in range(files_each):
                is_last_file = f == files_each - 1
                file_conn = "└── " if is_last_file else "├── "
                lines.append(f"{top_cont}{sub_cont}{file_conn}file{f}.py")
    total_dirs = top_dirs * (1 + subdirs_each)
    total_files = top_dirs * subdirs_each * files_each
    if summary:
        lines.append(f"\n{total_dirs} directories, {total_files} files")
    return "\n".join(lines)


def _shallow_tree(n_files: int) -> str:
    """Build a shallow tree (depth 1 only) with *n_files* entries."""
    lines = ["."]
    for i in range(n_files):
        conn = "└── " if i == n_files - 1 else "├── "
        lines.append(f"{conn}file{i}.py")
    lines.append(f"\n0 directories, {n_files} files")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 1. Short tree passthrough
# ---------------------------------------------------------------------------

class TestTreeFilterPassthrough:
    def test_short_tree_unchanged(self) -> None:
        """Tree output with <=30 lines is returned verbatim."""
        output = _shallow_tree(20)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert result == output

    def test_exactly_30_lines_passthrough(self) -> None:
        """Exactly 30 lines is the boundary — must pass through unchanged."""
        # Build a clean 30-line tree with no trailing blank to avoid normalisation drift.
        lines = ["."] + [("├── " if i < 28 else "└── ") + f"file{i}.py" for i in range(29)]
        output30 = "\n".join(lines)
        assert len(output30.splitlines()) == 30
        f = bc.TreeFilter()
        result = f.compress(output30, "", 0, ["tree"])
        assert result == output30

    def test_empty_tree_passthrough(self) -> None:
        """A tree with only root and summary passes through."""
        output = ".\n\n0 directories, 0 files"
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert result == output


# ---------------------------------------------------------------------------
# 2. detect() method
# ---------------------------------------------------------------------------

class TestTreeFilterDetect:
    def test_detect_true_for_tree_output(self) -> None:
        """detect() returns True when lines contain tree connector characters."""
        lines = [".", "├── src/", "│   └── main.py", "└── README.md"]
        f = bc.TreeFilter()
        assert f.detect(lines) is True

    def test_detect_false_for_ls_output(self) -> None:
        """detect() returns False for plain ls -la output."""
        lines = [
            "total 128",
            "-rw-r--r-- 1 user group 1024 Jan  1 file.py",
            "-rw-r--r-- 1 user group 2048 Jan  1 README.md",
        ]
        f = bc.TreeFilter()
        assert f.detect(lines) is False

    def test_detect_false_for_empty(self) -> None:
        """detect() returns False for empty input."""
        f = bc.TreeFilter()
        assert f.detect([]) is False


# ---------------------------------------------------------------------------
# 3. Deep tree compression
# ---------------------------------------------------------------------------

class TestTreeFilterCompression:
    def test_deep_tree_collapses_depth3_items(self) -> None:
        """Items at depth >=3 are replaced with '[N items]' markers."""
        output = _make_tree(top_dirs=3, subdirs_each=2, files_each=5)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert "[" in result and "items]" in result
        # Original depth-3 filenames must not appear in compressed output.
        assert "file0.py" not in result

    def test_depth2_items_kept(self) -> None:
        """Items at depth 1 and 2 are preserved verbatim."""
        output = _make_tree(top_dirs=3, subdirs_each=2, files_each=5)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert "topdir0/" in result
        assert "subdir0/" in result

    def test_summary_line_always_kept(self) -> None:
        """The 'N directories, M files' summary line is always present in output."""
        output = _make_tree(top_dirs=3, subdirs_each=2, files_each=5)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert "directories," in result
        assert "files" in result

    def test_collapse_count_accurate(self) -> None:
        """The [N items] count matches the number of depth-3 entries under each parent."""
        # 1 topdir × 6 subdirs × 4 files = 34 lines (> 30 threshold).
        output = _make_tree(top_dirs=1, subdirs_each=6, files_each=4)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        # Every subdir has 4 depth-3 files → every marker shows [4 items].
        assert "[4 items]" in result

    def test_multiple_parents_independent_counts(self) -> None:
        """Each depth-2 parent gets its own accurate [N items] count."""
        # 4 topdirs × 2 subdirs × 3 files = 43 lines (> 30 threshold).
        output = _make_tree(top_dirs=4, subdirs_each=2, files_each=3)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        # 8 total subdirs each with 3 depth-3 files → 8 markers of [3 items].
        assert result.count("[3 items]") == 8

    def test_tree_without_summary_still_compresses(self) -> None:
        """Compression works even when there is no 'N directories, M files' line."""
        output = _make_tree(top_dirs=3, subdirs_each=2, files_each=5, summary=False)
        f = bc.TreeFilter()
        result = f.compress(output, "", 0, ["tree"])
        assert "items]" in result
        assert "file0.py" not in result

    def test_binary_dispatch_routes_tree(self) -> None:
        """select_filter(['tree']) returns the TreeFilter instance."""
        flt = bc.select_filter(["tree"])
        assert flt is not None
        assert flt.name == "tree"
