"""Tests for .tokengoatignore support and custom exclusion patterns."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.parser import (
    _matches_ignore_pattern,
    iter_source_files,
    load_project_ignore_patterns,
)
from token_goat.project import make_project_at


def test_load_patterns_no_file(tmp_path: Path) -> None:
    """Returns [] when .tokengoatignore does not exist."""
    patterns = load_project_ignore_patterns(tmp_path)
    assert patterns == []


def test_load_patterns_empty_file(tmp_path: Path) -> None:
    """Returns [] for an empty file."""
    ignore_file = tmp_path / ".tokengoatignore"
    ignore_file.write_text("")
    patterns = load_project_ignore_patterns(tmp_path)
    assert patterns == []


def test_load_patterns_comments_and_blanks(tmp_path: Path) -> None:
    """Strips comments and blank lines, preserves literal '#' in patterns."""
    ignore_file = tmp_path / ".tokengoatignore"
    ignore_file.write_text(
        "# This is a comment\n"
        "*.log\n"
        "\n"
        "  # indented comment\n"
        "dist/**\n"
        "  \n"
        "src/generated/*.ts  # inline comment\n"
        "path/to/file#name\n"  # '#' without preceding whitespace — not a comment
    )
    patterns = load_project_ignore_patterns(tmp_path)
    assert patterns == ["*.log", "dist/**", "src/generated/*.ts", "path/to/file#name"]


def test_load_patterns_unreadable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returns [] gracefully when file is unreadable."""
    ignore_file = tmp_path / ".tokengoatignore"
    ignore_file.write_text("*.log")
    # Mock Path.read_text to raise OSError
    original_read = Path.read_text
    def mock_read(self, *args, **kwargs):
        if self.name == ".tokengoatignore":
            raise OSError("permission denied")
        return original_read(self, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", mock_read)
    patterns = load_project_ignore_patterns(tmp_path)
    assert patterns == []


def test_matches_ignore_pattern_basename_only() -> None:
    """Pattern matches basename: *.log matches app.log."""
    patterns = ["*.log"]
    assert _matches_ignore_pattern("app.log", patterns) is True
    assert _matches_ignore_pattern("logs/app.log", patterns) is True
    assert _matches_ignore_pattern("app.py", patterns) is False


def test_matches_ignore_pattern_full_path() -> None:
    """Pattern matches full relative path: dist/** matches dist/bundle.js."""
    patterns = ["dist/**"]
    assert _matches_ignore_pattern("dist/bundle.js", patterns) is True
    assert _matches_ignore_pattern("dist/subdir/app.js", patterns) is True
    assert _matches_ignore_pattern("src/dist/app.js", patterns) is False


def test_matches_ignore_pattern_path_prefix() -> None:
    """Pattern matches relative path: src/generated/*.ts matches src/generated/foo.ts."""
    patterns = ["src/generated/*.ts"]
    assert _matches_ignore_pattern("src/generated/foo.ts", patterns) is True
    assert _matches_ignore_pattern("src/generated/bar.ts", patterns) is True
    assert _matches_ignore_pattern("src/foo.ts", patterns) is False


def test_matches_ignore_pattern_backslash_separator() -> None:
    """Normalizes backslash to forward slash before matching."""
    patterns = ["dist/**"]
    assert _matches_ignore_pattern("dist\\bundle.js", patterns) is True
    assert _matches_ignore_pattern("dist\\sub\\app.js", patterns) is True


def test_matches_ignore_pattern_no_patterns() -> None:
    """Returns False when patterns list is empty."""
    assert _matches_ignore_pattern("anything.log", []) is False


def test_matches_ignore_pattern_multiple_patterns() -> None:
    """Matches any pattern in the list."""
    patterns = ["*.log", "*.tmp", "build/**"]
    assert _matches_ignore_pattern("app.log", patterns) is True
    assert _matches_ignore_pattern("temp.tmp", patterns) is True
    assert _matches_ignore_pattern("build/output.js", patterns) is True
    assert _matches_ignore_pattern("app.py", patterns) is False


@pytest.mark.slow
def test_iter_source_files_respects_ignore_patterns(tmp_path: Path) -> None:
    """Files matching ignore patterns are skipped by iter_source_files."""
    # Create a simple project structure
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')")
    (tmp_path / "src" / "generated.py").write_text("# autogen")
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "app.log").write_text("log content")
    (tmp_path / ".tokengoatignore").write_text("src/generated.py\n*.log")

    proj = make_project_at(tmp_path)
    patterns = load_project_ignore_patterns(tmp_path)
    files = list(iter_source_files(proj, ignore_patterns=patterns))

    # Convert to relative paths for easier assertion
    rel_paths = sorted(p.relative_to(tmp_path).as_posix() for p in files)

    assert "src/main.py" in rel_paths
    assert "src/generated.py" not in rel_paths  # matched by pattern
    assert "logs/app.log" not in rel_paths  # matched by pattern


@pytest.mark.slow
def test_iter_source_files_without_ignore_patterns(tmp_path: Path) -> None:
    """iter_source_files includes all indexable files when no patterns are provided."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')")
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "app.log").write_text("log content")

    proj = make_project_at(tmp_path)
    files = list(iter_source_files(proj))

    rel_paths = sorted(p.relative_to(tmp_path).as_posix() for p in files)
    assert "src/main.py" in rel_paths
    # app.log is skipped because .log is not an indexed extension, not because of patterns


@pytest.mark.slow
def test_iter_source_files_empty_patterns(tmp_path: Path) -> None:
    """iter_source_files works with empty patterns list."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')")

    proj = make_project_at(tmp_path)
    files = list(iter_source_files(proj, ignore_patterns=[]))

    rel_paths = [p.relative_to(tmp_path).as_posix() for p in files]
    assert "src/main.py" in rel_paths
