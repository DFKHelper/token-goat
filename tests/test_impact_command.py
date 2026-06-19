"""Tests for `token-goat impact` — blast-radius view."""
from __future__ import annotations

import json
import unittest.mock as mock

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


class TestImpactCLI:
    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["impact", "foo"])
        assert result.exit_code != 0
        assert "project" in result.output.lower() or "no project" in result.output.lower()

    def test_no_index_graceful(self, tmp_data_dir, tmp_path, monkeypatch):
        proj_root = tmp_path / "noidx"
        proj_root.mkdir()
        monkeypatch.chdir(proj_root)

        with mock.patch("token_goat.read_commands.find_project") as fp:
            fp.return_value = mock.MagicMock(hash="deadbeef", root=proj_root)
            with mock.patch("token_goat.db.open_project_readonly", side_effect=FileNotFoundError):
                result = runner.invoke(app, ["impact", "foo"])

        assert result.exit_code != 0
        assert "index" in result.output.lower()

    def test_json_output_shape(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def target(): pass\ndef user(): target()\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["impact", "target", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert "symbol" in data
        assert "direct_callers" in data
        assert "ref_count" in data
        assert "test_files" in data
        assert "callers" in data
        assert isinstance(data["callers"], list)
        assert isinstance(data["test_files"], list)
        assert data["symbol"] == "target"

    def test_text_output_has_symbol(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["impact", "foo"])
        assert result.exit_code == 0
        assert "foo" in result.output

    def test_callers_counted(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text(
            "def target(): pass\n"
            "def caller_a(): target()\n"
            "def caller_b(): target()\n"
        )
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["impact", "target", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["ref_count"] >= 2

    def test_fewer_callers_for_unused_symbol(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text(
            "def orphan(): pass\n"
            "def called(): pass\n"
            "def user_a(): called()\n"
            "def user_b(): called()\n"
        )
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result_orphan = runner.invoke(app, ["impact", "orphan", "--json"])
        result_called = runner.invoke(app, ["impact", "called", "--json"])
        assert result_orphan.exit_code == 0
        assert result_called.exit_code == 0
        orphan_data = json.loads(result_orphan.output.strip())
        called_data = json.loads(result_called.output.strip())
        # called() is referenced by user_a and user_b; orphan() is not called by anyone
        assert called_data["ref_count"] > orphan_data["ref_count"]
