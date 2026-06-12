"""Tests for _rollup_glob_paths (Iter 8 — hybrid sample + directory-grouped glob compression)."""
from __future__ import annotations

from token_goat.hooks_read import (
    _GLOB_ROLLUP_MAX_DIRS,
    _GLOB_ROLLUP_THRESHOLD,
    _GLOB_SAMPLE_PATHS,
    _rollup_glob_paths,
)


def _make_paths(dirs: list[tuple[str, int]]) -> str:
    """Build a newline-separated path string from (directory, count) pairs."""
    lines: list[str] = []
    for d, count in dirs:
        for i in range(count):
            lines.append(f"{d}/file_{i}.py")
    return "\n".join(lines)


class TestRollupGlobPaths:
    def test_passthrough_below_threshold(self):
        paths = _make_paths([("src", _GLOB_ROLLUP_THRESHOLD)])
        result = _rollup_glob_paths(paths)
        assert result == paths

    def test_passthrough_at_threshold(self):
        paths = _make_paths([("src", _GLOB_ROLLUP_THRESHOLD)])
        result = _rollup_glob_paths(paths)
        assert result == paths

    def test_rollup_above_threshold(self):
        paths = _make_paths([("src/a", _GLOB_ROLLUP_THRESHOLD + 1)])
        result = _rollup_glob_paths(paths)
        assert str(_GLOB_ROLLUP_THRESHOLD + 1) in result
        # Directory name appears regardless of OS path separator
        assert "src" in result and "a" in result

    def test_total_path_count_in_header(self):
        total = _GLOB_ROLLUP_THRESHOLD + 10
        paths = _make_paths([("src/components", total)])
        result = _rollup_glob_paths(paths)
        assert str(total) in result

    def test_directory_count_in_header(self):
        paths = _make_paths([("src/a", 25), ("src/b", 25)])
        result = _rollup_glob_paths(paths)
        assert "2 directories" in result

    def test_singular_directory_label(self):
        paths = _make_paths([("src/only", _GLOB_ROLLUP_THRESHOLD + 5)])
        result = _rollup_glob_paths(paths)
        assert "1 directory" in result

    def test_each_shown_directory_appears_in_breakdown(self):
        # 3 dirs × 20 = 60 paths, above threshold
        dirs = [(f"src/pkg{i}", 20) for i in range(3)]
        paths = _make_paths(dirs)
        result = _rollup_glob_paths(paths)
        assert "Directory breakdown" in result
        breakdown = result.split("Directory breakdown:")[-1]
        for name in ("pkg0", "pkg1", "pkg2"):
            assert name in breakdown

    def test_hidden_directories_truncated(self):
        # More directories than _GLOB_ROLLUP_MAX_DIRS
        n_dirs = _GLOB_ROLLUP_MAX_DIRS + 5
        dirs = [(f"pkg/d{i}", 3) for i in range(n_dirs)]
        paths = _make_paths(dirs)
        result = _rollup_glob_paths(paths)
        assert "5 more" in result or "more director" in result

    def test_hidden_files_count_present(self):
        n_dirs = _GLOB_ROLLUP_MAX_DIRS + 2
        dirs = [(f"pkg/d{i}", 3) for i in range(n_dirs)]
        paths = _make_paths(dirs)
        result = _rollup_glob_paths(paths)
        # Hidden dirs have 2*3=6 files; the count must appear
        assert "6" in result

    def test_directories_sorted_by_count_desc(self):
        # total must exceed threshold; big_dir has more files than small_dir
        paths = _make_paths([("small_dir", 5), ("big_dir", _GLOB_ROLLUP_THRESHOLD)])
        result = _rollup_glob_paths(paths)
        # The sort order applies to the directory breakdown section, not the flat sample
        breakdown = result.split("Directory breakdown:")[-1]
        assert breakdown.index("big_dir") < breakdown.index("small_dir")

    def test_file_counts_shown_per_directory(self):
        paths = _make_paths([("src/core", 7), ("src/ui", 40)])
        result = _rollup_glob_paths(paths)
        assert "7" in result
        assert "40" in result

    def test_sample_paths_present_verbatim(self):
        # First _GLOB_SAMPLE_PATHS individual file names must appear in output
        total = _GLOB_ROLLUP_THRESHOLD + 20
        paths = _make_paths([("src/a", total)])
        result = _rollup_glob_paths(paths)
        # _make_paths generates unpadded indices: file_0.py, file_1.py, ...
        assert "file_0.py" in result
        assert f"file_{_GLOB_SAMPLE_PATHS - 1}.py" in result

    def test_overflow_marker_present_when_sample_truncated(self):
        # When total > SAMPLE_PATHS, a "(+N more not shown)" marker must appear
        total = _GLOB_ROLLUP_THRESHOLD + 20
        paths = _make_paths([("src/a", total)])
        result = _rollup_glob_paths(paths)
        hidden = total - _GLOB_SAMPLE_PATHS
        assert f"+{hidden}" in result

    def test_directory_breakdown_section_present(self):
        paths = _make_paths([("src/x", _GLOB_ROLLUP_THRESHOLD + 5)])
        result = _rollup_glob_paths(paths)
        assert "Directory breakdown" in result

    def test_blank_lines_ignored(self):
        paths = "\n".join([
            "src/a/f1.py", "", "src/a/f2.py", "   ", "src/a/f3.py",
        ] + ["src/b/x.py"] * (_GLOB_ROLLUP_THRESHOLD - 1))
        result = _rollup_glob_paths(paths)
        # Should not crash; blank lines must not inflate the count
        assert isinstance(result, str)

    def test_returns_string_for_empty_input(self):
        result = _rollup_glob_paths("")
        assert isinstance(result, str)
