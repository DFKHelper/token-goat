"""Tests for `token-goat coverage-gaps` — untested function detection."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


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


class TestCoverageGapsCommand:
    def test_no_gaps_reports_clean(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        with patch("token_goat.cli._query_project", return_value=[]):
            result = runner.invoke(app, ["coverage-gaps"])
        assert result.exit_code == 0
        assert "All indexed callables" in result.output

    def test_untested_function_shown(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(("parse_token", "function", "src/auth.py", 55))
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["coverage-gaps"])
        assert result.exit_code == 0
        assert "parse_token" in result.output
        assert "src/auth.py" in result.output

    def test_json_output_shape(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(("build_index", "function", "src/indexer.py", 100))
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["coverage-gaps", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert isinstance(data, list)
        assert data[0]["name"] == "build_index"
        assert {"name", "kind", "file", "line"} <= data[0].keys()

    def test_top_limits_results(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(*[(f"fn_{i}", "function", "src/core.py", i * 10) for i in range(8)])
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["coverage-gaps", "--top", "4", "--json"])
        assert result.exit_code == 0
        assert len(json.loads(result.output)) == 4

    def test_multiple_files_grouped(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        rows = _rows(
            ("alpha", "function", "src/a.py", 1),
            ("beta", "method", "src/b.py", 10),
            ("gamma", "function", "src/a.py", 20),
        )
        with patch("token_goat.cli._query_project", return_value=rows):
            result = runner.invoke(app, ["coverage-gaps"])
        assert result.exit_code == 0
        assert "src/a.py" in result.output
        assert "src/b.py" in result.output
        assert "alpha" in result.output and "gamma" in result.output

    def test_json_empty_results(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _make_project_stub(tmp_path, make_project)
        monkeypatch.chdir(root)
        with patch("token_goat.cli._query_project", return_value=[]):
            result = runner.invoke(app, ["coverage-gaps", "--json"])
        assert result.exit_code == 0
        assert result.output.strip() == "[]"

    def test_no_project_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["coverage-gaps"])
        assert result.exit_code != 0
