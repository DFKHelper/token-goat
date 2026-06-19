"""Tests for `token-goat dead` — unreferenced symbol detection."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


def _make_row(name: str, kind: str, file_rel: str, line: int) -> sqlite3.Row:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE t (name TEXT, kind TEXT, file_rel TEXT, line INT)")
    conn.execute("INSERT INTO t VALUES (?, ?, ?, ?)", (name, kind, file_rel, line))
    row = conn.execute("SELECT * FROM t").fetchone()
    conn.close()
    return row


def _rows(*specs: tuple[str, str, str, int]) -> list[sqlite3.Row]:
    if not specs:
        return []
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE t (name TEXT, kind TEXT, file_rel TEXT, line INT)")
    conn.executemany("INSERT INTO t VALUES (?, ?, ?, ?)", specs)
    rows = conn.execute("SELECT * FROM t").fetchall()
    conn.close()
    return rows


def _make_project_stub(tmp_path: Path, make_project) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    make_project(root)
    return root


class TestDeadCommand:
    def test_no_dead_symbols_reports_clean(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        with patch("token_goat.cli._query_project", return_value=[]):
            result = runner.invoke(app, ["dead"])
        assert result.exit_code == 0
        assert "No unreferenced" in result.output

    def test_dead_symbol_shown_in_output(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(("orphan_fn", "function", "src/foo.py", 42))
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["dead"])
        assert result.exit_code == 0
        assert "orphan_fn" in result.output
        assert "src/foo.py" in result.output

    def test_entry_point_names_excluded(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(
            ("main", "function", "src/app.py", 1),
            ("__main__", "function", "src/app.py", 5),
            ("app", "function", "src/app.py", 10),
            ("create_app", "function", "src/app.py", 15),
            ("real_dead", "function", "src/app.py", 20),
        )
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["dead", "--json"])
        assert result.exit_code == 0
        names = [item["name"] for item in json.loads(result.output)]
        for skip_name in ("main", "__main__", "app", "create_app"):
            assert skip_name not in names
        assert "real_dead" in names

    def test_json_empty_results(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        with patch("token_goat.cli._query_project", return_value=[]):
            result = runner.invoke(app, ["dead", "--json"])
        assert result.exit_code == 0
        assert result.output.strip() == "[]"

    def test_json_output_shape(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(("unused_cls", "class", "src/models.py", 10))
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["dead", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert isinstance(data, list)
        assert data[0]["name"] == "unused_cls"
        assert "kind" in data[0] and "file" in data[0] and "line" in data[0]

    def test_top_limits_results(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(*[(f"fn_{i}", "function", "src/a.py", i) for i in range(10)])
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["dead", "--top", "3", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert len(data) == 3

    def test_no_project_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["dead"])
        assert result.exit_code != 0
