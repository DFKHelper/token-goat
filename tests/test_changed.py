"""Tests for `token-goat changed` — get_changed_symbols + read_commands.changed."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from conftest import make_git_repo

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_diff_output(entries: list[tuple[str, str, int, int]]) -> str:
    """Build a minimal unified diff string for the given (file, symbol, added, removed) tuples.

    Each entry produces a ``+++ b/<file>`` header plus a hunk line that names the
    symbol in the hunk context.  The added/removed counts are embedded in the hunk
    range markers so the parser can read them back.
    """
    lines: list[str] = []
    current_file: str | None = None
    for file, symbol, added, removed in entries:
        if file != current_file:
            lines.append(f"--- a/{file}")
            lines.append(f"+++ b/{file}")
            current_file = file
        lines.append(f"@@ -{1},{removed} +{1},{added} @@ def {symbol}:")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Unit tests for get_changed_symbols
# ---------------------------------------------------------------------------


class TestGetChangedSymbols:
    """Unit tests — mock the underlying git call so no real repo is needed."""

    def _patch_run_git(self, diff_text: str):
        """Return a context manager that makes _run_git return diff_text."""
        return patch(
            "token_goat.git_history._run_git",
            return_value=diff_text,
        )

    def test_basic_changes_found(self):
        from token_goat.git_history import get_changed_symbols

        diff = _make_diff_output([
            ("src/foo.py", "bar", 5, 2),
            ("src/foo.py", "baz", 3, 1),
        ])
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo", since_ref="HEAD~3")

        assert len(result) == 2
        # Results sorted by (file, symbol)
        files = [r["file"] for r in result]
        assert "src/foo.py" in files
        symbols = {r["symbol"] for r in result}
        assert {"bar", "baz"} == symbols

    def test_lines_added_removed_correct(self):
        from token_goat.git_history import get_changed_symbols

        diff = _make_diff_output([("src/util.py", "helper", 7, 3)])
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo")

        assert len(result) == 1
        entry = result[0]
        assert entry["lines_added"] == 7
        assert entry["lines_removed"] == 3

    def test_dedup_sums_counts(self):
        """Multiple hunks touching the same symbol should be merged."""
        from token_goat.git_history import get_changed_symbols

        # Two hunks in same file for same symbol
        diff = (
            "--- a/src/thing.py\n"
            "+++ b/src/thing.py\n"
            "@@ -1,2 +1,4 @@ def my_func:\n"
            "@@ -20,1 +22,3 @@ def my_func:\n"
        )
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo")

        assert len(result) == 1
        entry = result[0]
        assert entry["symbol"] == "my_func"
        assert entry["lines_added"] == 4 + 3  # 4 from first hunk, 3 from second
        assert entry["lines_removed"] == 2 + 1

    def test_no_changes_returns_empty(self):
        from token_goat.git_history import get_changed_symbols

        with self._patch_run_git(""):
            result = get_changed_symbols("/repo")
        assert result == []

    def test_git_error_returns_empty(self):
        """When _run_git returns None (git failure), result is empty."""
        from token_goat.git_history import get_changed_symbols

        with patch("token_goat.git_history._run_git", return_value=None):
            result = get_changed_symbols("/repo")
        assert result == []

    def test_invalid_ref_graceful(self):
        """An invalid ref that makes _run_git return None should return [] not raise."""
        from token_goat.git_history import get_changed_symbols

        with patch("token_goat.git_history._run_git", return_value=None):
            result = get_changed_symbols("/repo", since_ref="nonexistent-ref-xyz")
        assert result == []

    def test_limit_respected(self):
        from token_goat.git_history import get_changed_symbols

        # Generate 10 distinct symbols across two files
        entries = [(f"src/f{i % 3}.py", f"sym{i}", i, 1) for i in range(10)]
        diff = _make_diff_output(entries)
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo", limit=5)
        assert len(result) <= 5

    def test_multiple_files(self):
        from token_goat.git_history import get_changed_symbols

        diff = _make_diff_output([
            ("src/a.py", "func_a", 2, 1),
            ("src/b.py", "func_b", 3, 0),
            ("src/c.py", "func_c", 1, 1),
        ])
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo")

        assert len(result) == 3
        result_files = {r["file"] for r in result}
        assert result_files == {"src/a.py", "src/b.py", "src/c.py"}

    def test_sorted_by_file_then_symbol(self):
        from token_goat.git_history import get_changed_symbols

        diff = _make_diff_output([
            ("src/z.py", "zebra", 1, 0),
            ("src/a.py", "alpha", 1, 0),
            ("src/a.py", "beta", 1, 0),
        ])
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo")

        keys = [(r["file"], r["symbol"]) for r in result]
        assert keys == sorted(keys)

    def test_hunk_with_no_context_ignored(self):
        """Hunk headers with no context text (no symbol name) should be skipped."""
        from token_goat.git_history import get_changed_symbols

        diff = (
            "--- a/src/thing.py\n"
            "+++ b/src/thing.py\n"
            "@@ -1,2 +1,4 @@\n"  # no context after @@
        )
        with self._patch_run_git(diff):
            result = get_changed_symbols("/repo")
        assert result == []

    def test_path_type_accepted(self):
        """Accepts both str and Path for repo_root."""
        from token_goat.git_history import get_changed_symbols

        diff = _make_diff_output([("src/foo.py", "my_func", 1, 1)])
        with self._patch_run_git(diff):
            result_str = get_changed_symbols("/repo", since_ref="HEAD~1")
        with self._patch_run_git(diff):
            result_path = get_changed_symbols(Path("/repo"), since_ref="HEAD~1")
        assert result_str == result_path


# ---------------------------------------------------------------------------
# Integration test — real git repo
# ---------------------------------------------------------------------------


@pytest.mark.slow
class TestGetChangedSymbolsIntegration:
    """Integration tests that create a real git repo."""

    def test_real_diff_finds_symbol(self, tmp_path: Path):
        from token_goat.git_history import get_changed_symbols

        repo = make_git_repo(
            tmp_path,
            commits=[
                ({"src/mod.py": "def hello():\n    return 1\n"}, "first commit"),
                ({"src/mod.py": "def hello():\n    return 2\n"}, "change hello"),
            ],
            init_branch="main",
        )
        result = get_changed_symbols(repo, since_ref="HEAD~1")
        # The diff of HEAD~1..HEAD touches hello(), so it should appear.
        symbols = {r["symbol"] for r in result}
        assert "hello" in symbols

    def test_no_commits_no_error(self, tmp_path: Path):
        """With no commits between since_ref and HEAD, result is empty, no crash."""
        from token_goat.git_history import get_changed_symbols

        repo = make_git_repo(
            tmp_path,
            commits=[
                ({"src/mod.py": "x = 1\n"}, "only commit"),
            ],
            init_branch="main",
        )
        # HEAD~1 doesn't exist — _run_git will return None; should not raise.
        result = get_changed_symbols(repo, since_ref="HEAD~99")
        assert result == []


# ---------------------------------------------------------------------------
# Unit tests for read_commands.changed()
# ---------------------------------------------------------------------------


class TestReadCommandsChanged:
    def _make_entries(self) -> list[dict]:
        return [
            {"file": "src/foo.py", "symbol": "my_func", "lines_added": 5, "lines_removed": 2},
            {"file": "src/bar.py", "symbol": "other", "lines_added": 1, "lines_removed": 0},
        ]

    def test_text_output(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.read_commands.changed.__wrapped__", create=True),
            patch("token_goat.git_history.get_changed_symbols", return_value=self._make_entries()),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~5", json_output=False)
        out = capsys.readouterr().out
        assert "2 symbol changes since HEAD~5" in out
        assert "my_func" in out
        assert "+5" in out
        assert "-2" in out

    def test_json_output(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols", return_value=self._make_entries()),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~3", json_output=True)
        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["since"] == "HEAD~3"
        assert data["count"] == 2
        assert len(data["symbols"]) == 2

    def test_no_changes_message(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols", return_value=[]),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False)
        out = capsys.readouterr().out
        assert "No symbol changes since HEAD~1" in out

    def test_no_changes_json(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols", return_value=[]),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=True)
        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["count"] == 0
        assert data["symbols"] == []

    def test_single_change_singular_noun(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        entries = [{"file": "src/x.py", "symbol": "foo", "lines_added": 1, "lines_removed": 0}]
        with (
            patch("token_goat.git_history.get_changed_symbols", return_value=entries),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False)
        out = capsys.readouterr().out
        # "1 symbol change" not "1 symbol changes"
        assert "1 symbol change since" in out
        assert "1 symbol changes" not in out
