"""Tests for `token-goat changed` — get_changed_symbols + read_commands.changed."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

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
    @pytest.fixture(autouse=True)
    def _isolate_db(self, tmp_data_dir):
        """Redirect DB writes to a temp dir so tests don't touch the production database.

        changed() calls db.record_stat() → open_global() on every invocation.
        Without isolation the wal_checkpoint(TRUNCATE) on close takes 5-9 s on Windows.
        """

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


# ---------------------------------------------------------------------------
# Helpers for DB-backed (--symbol) mode tests
# ---------------------------------------------------------------------------


def _make_db_diff(entries: list[tuple[str, int, int]]) -> str:
    """Build a minimal unified diff for DB-mode tests: (file, new_start, new_count) tuples."""
    lines: list[str] = []
    current_file: str | None = None
    for file, new_start, new_count in entries:
        if file != current_file:
            lines.append(f"--- a/{file}")
            lines.append(f"+++ b/{file}")
            current_file = file
        lines.append(f"@@ -1,1 +{new_start},{new_count} @@")
    return "\n".join(lines) + "\n"


def _make_fake_project(root: str = "/fake/repo") -> MagicMock:
    """Return a minimal fake Project object."""
    fake_proj = MagicMock()
    fake_proj.hash = "deadbeef" * 5
    fake_proj.root = Path(root)
    return fake_proj


def _make_conn_ctx(rows_by_file: dict[str, list[str]]) -> MagicMock:
    """Return a context manager mock for open_project_readonly.

    *rows_by_file* maps file_rel -> list of symbol names to return from fetchall().
    Each call to conn.execute().fetchall() cycles through the files in order.
    """
    conn_mock = MagicMock()

    # Build a queue of fetchall() results, one per file queried.
    result_queue = list(rows_by_file.values())
    call_index = [0]

    def fake_fetchall() -> list[MagicMock]:
        idx = call_index[0]
        call_index[0] += 1
        if idx >= len(result_queue):
            return []
        names = result_queue[idx]
        rows = []
        for name in names:
            row = MagicMock()
            row.__getitem__ = lambda self, key, n=name: n if key == "name" else None
            rows.append(row)
        return rows

    conn_mock.execute.return_value.fetchall.side_effect = fake_fetchall
    conn_ctx = MagicMock()
    conn_ctx.__enter__ = lambda s: conn_mock
    conn_ctx.__exit__ = MagicMock(return_value=False)
    return conn_ctx


# ---------------------------------------------------------------------------
# Unit tests for get_changed_symbols_db
# ---------------------------------------------------------------------------


class TestGetChangedSymbolsDb:
    """Unit tests — mock git and DB so no real repo or index is needed."""

    def test_basic_returns_file_grouped_symbols(self):
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([("src/auth.py", 10, 5)])
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({"src/auth.py": ["login", "logout"]})

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo", since_ref="HEAD~1")

        assert len(result) == 1
        entry = result[0]
        assert entry["file"] == "src/auth.py"
        assert entry["symbols"] == ["login", "logout"]
        assert entry["symbol_count"] == 2

    def test_multiple_files(self):
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([
            ("src/a.py", 1, 3),
            ("src/b.py", 20, 2),
        ])
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({
            "src/a.py": ["func_a"],
            "src/b.py": ["func_b", "helper"],
        })

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo")

        files = [r["file"] for r in result]
        assert "src/a.py" in files
        assert "src/b.py" in files
        b_entry = next(r for r in result if r["file"] == "src/b.py")
        assert b_entry["symbol_count"] == 2

    def test_empty_diff_returns_empty(self):
        from token_goat.git_history import get_changed_symbols_db

        with patch("token_goat.git_history._run_git", return_value=""):
            result = get_changed_symbols_db("/fake/repo")
        assert result == []

    def test_git_error_returns_empty(self):
        from token_goat.git_history import get_changed_symbols_db

        with patch("token_goat.git_history._run_git", return_value=None):
            result = get_changed_symbols_db("/fake/repo")
        assert result == []

    def test_no_project_returns_empty(self):
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([("src/x.py", 1, 1)])
        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=None),
        ):
            result = get_changed_symbols_db("/not/a/project")
        assert result == []

    def test_file_with_no_indexed_symbols_excluded(self):
        """Files where no DB symbols overlap the changed range are omitted."""
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([("src/unindexed.py", 5, 3)])
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({"src/unindexed.py": []})

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo")

        assert result == []

    def test_limit_caps_file_count(self):
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([(f"src/f{i}.py", 1, 1) for i in range(10)])
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({f"src/f{i}.py": [f"sym{i}"] for i in range(10)})

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo", limit=3)

        assert len(result) <= 3

    def test_pure_deletion_hunk_handled(self):
        """A hunk with count=0 (pure deletion) should not crash."""
        from token_goat.git_history import get_changed_symbols_db

        # @@ -5,3 +5,0 @@ — pure deletion, new_count=0
        diff = "--- a/src/x.py\n+++ b/src/x.py\n@@ -5,3 +5,0 @@\n"
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({"src/x.py": []})

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo")
        assert isinstance(result, list)

    def test_results_sorted_by_file(self):
        from token_goat.git_history import get_changed_symbols_db

        diff = _make_db_diff([
            ("src/z.py", 1, 1),
            ("src/a.py", 1, 1),
        ])
        fake_proj = _make_fake_project()
        conn_ctx = _make_conn_ctx({
            "src/z.py": ["z_func"],
            "src/a.py": ["a_func"],
        })

        with (
            patch("token_goat.git_history._run_git", return_value=diff),
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        ):
            result = get_changed_symbols_db("/fake/repo")

        files = [r["file"] for r in result]
        assert files == sorted(files)


# ---------------------------------------------------------------------------
# Unit tests for read_commands.changed(symbol_mode=True)
# ---------------------------------------------------------------------------


class TestReadCommandsChangedSymbolMode:
    """Unit tests for the --symbol output path in read_commands.changed()."""

    @pytest.fixture(autouse=True)
    def _isolate_db(self, tmp_data_dir):
        """Redirect DB writes to a temp dir so tests don't touch the production database.

        changed() calls db.record_stat() → open_global() on every invocation.
        Without isolation the wal_checkpoint(TRUNCATE) on close takes 5-9 s on Windows.
        """

    def _make_file_entries(self) -> list[dict]:
        return [
            {"file": "src/auth.py", "symbols": ["login", "logout"], "symbol_count": 2},
            {"file": "src/utils.py", "symbols": ["helper"], "symbol_count": 1},
        ]

    def test_text_output_symbol_mode(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols_db", return_value=self._make_file_entries()),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False, symbol_mode=True)
        out = capsys.readouterr().out

        assert "2 files changed since HEAD~1" in out
        assert "src/auth.py" in out
        assert "login()" in out
        assert "logout()" in out
        assert "2 symbols changed" in out
        assert "src/utils.py" in out
        assert "helper()" in out
        assert "1 symbol changed" in out

    def test_json_output_symbol_mode(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols_db", return_value=self._make_file_entries()),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=True, symbol_mode=True)
        out = capsys.readouterr().out
        data = json.loads(out)

        assert data["since"] == "HEAD~1"
        assert data["count"] == 2
        assert "files" in data
        assert len(data["files"]) == 2

    def test_no_changes_symbol_mode(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols_db", return_value=[]),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False, symbol_mode=True)
        out = capsys.readouterr().out
        assert "No symbol changes since HEAD~1" in out
        assert "--symbol mode" in out

    def test_no_changes_json_symbol_mode(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        with (
            patch("token_goat.git_history.get_changed_symbols_db", return_value=[]),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=True, symbol_mode=True)
        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["count"] == 0
        assert data["files"] == []

    def test_singular_noun_one_file(self, capsys: pytest.CaptureFixture[str]):
        from token_goat.read_commands import changed

        entries = [{"file": "src/x.py", "symbols": ["foo"], "symbol_count": 1}]
        with (
            patch("token_goat.git_history.get_changed_symbols_db", return_value=entries),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False, symbol_mode=True)
        out = capsys.readouterr().out
        assert "1 file changed since" in out
        assert "1 files changed" not in out

    def test_symbol_mode_false_uses_hunk_mode(self, capsys: pytest.CaptureFixture[str]):
        """Ensure symbol_mode=False still routes to the git hunk-based path."""
        from token_goat.read_commands import changed

        hunk_entries = [{"file": "src/x.py", "symbol": "foo", "lines_added": 3, "lines_removed": 1}]
        with (
            patch("token_goat.git_history.get_changed_symbols", return_value=hunk_entries),
            patch("os.getcwd", return_value="/fake/repo"),
        ):
            changed(since_ref="HEAD~1", json_output=False, symbol_mode=False)
        out = capsys.readouterr().out
        # Hunk mode output format: "N symbol change(s) since ..."
        assert "symbol change" in out
        assert "foo" in out
