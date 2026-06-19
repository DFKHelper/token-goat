"""Tests for `token-goat note` — persistent per-project note management."""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


def _setup(tmp_path: Path, make_project) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    make_project(root)
    return root


class TestNoteCommand:
    def test_no_project_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["note", "list"])
        assert result.exit_code != 0

    def test_set_and_list(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "set", "my-key", "hello world"])
        assert r.exit_code == 0, r.output
        r2 = runner.invoke(app, ["note", "list"])
        assert r2.exit_code == 0
        assert "my-key" in r2.output
        assert "hello world" in r2.output

    def test_get_existing_key(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "goal", "ship the feature"])
        r = runner.invoke(app, ["note", "get", "goal"])
        assert r.exit_code == 0
        assert "ship the feature" in r.output

    def test_get_missing_key_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "get", "does-not-exist"])
        assert r.exit_code != 0

    def test_unset_removes_key(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "temp", "value"])
        runner.invoke(app, ["note", "unset", "temp"])
        r = runner.invoke(app, ["note", "list"])
        assert r.exit_code == 0
        assert "temp" not in r.output

    def test_clear_removes_all(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "a", "one"])
        runner.invoke(app, ["note", "set", "b", "two"])
        runner.invoke(app, ["note", "clear"])
        r = runner.invoke(app, ["note", "list"])
        assert r.exit_code == 0
        assert "No notes" in r.output

    def test_list_empty_project(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "list"])
        assert r.exit_code == 0
        assert "No notes" in r.output

    def test_list_json_output(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "x", "42"])
        r = runner.invoke(app, ["note", "list", "--json"])
        assert r.exit_code == 0
        data = json.loads(r.output.strip())
        assert isinstance(data, dict)
        assert data.get("x") == "42"

    def test_invalid_key_rejected(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "set", "bad key!", "value"])
        assert r.exit_code != 0

    def test_unknown_subcommand_rejected(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "frobnicate"])
        assert r.exit_code != 0

    def test_set_missing_key_exits_nonzero(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        r = runner.invoke(app, ["note", "set"])
        assert r.exit_code != 0

    def test_multiple_notes_stored_independently(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "k1", "v1"])
        runner.invoke(app, ["note", "set", "k2", "v2"])
        r = runner.invoke(app, ["note", "list"])
        assert "k1" in r.output
        assert "k2" in r.output

    def test_overwrite_existing_key(self, tmp_path, monkeypatch, tmp_data_dir, make_project):
        root = _setup(tmp_path, make_project)
        monkeypatch.chdir(root)
        runner.invoke(app, ["note", "set", "x", "first"])
        runner.invoke(app, ["note", "set", "x", "second"])
        r = runner.invoke(app, ["note", "get", "x"])
        assert "second" in r.output
        assert "first" not in r.output
