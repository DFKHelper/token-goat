"""Tests for `token-goat tokens` — per-file token footprint command."""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


def _setup(tmp_path, make_project, files: dict[str, str]) -> Path:
    """Create a fake project with .git and write files under it."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    make_project(root)
    return root


class TestTokensCommand:
    def test_no_project_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["tokens"])
        assert result.exit_code != 0

    def test_basic_output_has_header_and_total(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/a.py": "x = 1\n" * 20, "src/b.py": "y = 2\n" * 5})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "**/*.py"])
        assert result.exit_code == 0
        assert "File" in result.output
        assert "Tokens" in result.output
        assert "total" in result.output.lower()

    def test_larger_file_appears_first(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/big.py": "x = 1\n" * 100, "src/small.py": "y = 2\n"})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "**/*.py"])
        assert result.exit_code == 0
        big_idx = result.output.find("big.py")
        small_idx = result.output.find("small.py")
        assert big_idx < small_idx

    def test_asc_reverses_order(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/big.py": "x = 1\n" * 100, "src/small.py": "y = 2\n"})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "**/*.py", "--asc"])
        assert result.exit_code == 0
        big_idx = result.output.find("big.py")
        small_idx = result.output.find("small.py")
        assert small_idx < big_idx

    def test_top_limits_rows(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        files = {f"src/f{i}.py": "x\n" * (10 + i) for i in range(8)}
        root = _setup(tmp_path, make_project, files)
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "**/*.py", "--top", "3"])
        assert result.exit_code == 0
        data_lines = [
            ln for ln in result.output.splitlines()
            if ".py" in ln and "Total" not in ln and "File" not in ln and "---" not in ln
        ]
        assert len(data_lines) == 3

    def test_json_output_shape(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/a.py": "hello world\n" * 10})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "src/*.py", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert "total_tokens" in data
        assert "files" in data
        assert isinstance(data["files"], list)
        row = data["files"][0]
        assert "file" in row and "tokens" in row and "lines" in row

    def test_json_tokens_positive(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/a.py": "a = 1\n" * 30})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "src/*.py", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["total_tokens"] > 0
        assert data["files"][0]["tokens"] > 0

    def test_tree_mode_shows_directories(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {
            "src/core/a.py": "x\n" * 20,
            "src/core/b.py": "y\n" * 10,
            "tests/test_a.py": "z\n" * 5,
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "**/*.py", "--tree"])
        assert result.exit_code == 0
        assert "/" in result.output or "\\" in result.output
        assert "Total:" in result.output

    def test_tree_mode_includes_tok_label(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/a.py": "x = 1\n" * 50})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "src/*.py", "--tree"])
        assert result.exit_code == 0
        assert "tok" in result.output

    def test_no_files_exits_cleanly(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {"src/a.py": "x\n"})
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "nonexistent_dir/*.py"])
        assert result.exit_code == 0

    def test_top_shows_fewer_than_total(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        files = {f"f{i}.py": "x\n" * i for i in range(1, 7)}
        root = _setup(tmp_path, make_project, files)
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "*.py", "--top", "3", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert len(data["files"]) == 3
        assert data["total_files"] == 6

    def test_asc_with_top_shows_smallest(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project, {
            "tiny.py": "x\n",
            "medium.py": "x\n" * 50,
            "big.py": "x\n" * 200,
        })
        monkeypatch.chdir(root)
        result = runner.invoke(app, ["tokens", "*.py", "--asc", "--top", "2", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert len(data["files"]) == 2
        names = [f["file"] for f in data["files"]]
        # Ascending order + top 2 should give the 2 smallest files, starting from smallest
        assert any("tiny" in n for n in names)
        assert not any("big" in n for n in names)
