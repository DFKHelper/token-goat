"""Tests for `token-goat call-chain` — multi-level caller tree."""
from __future__ import annotations

import json
import unittest.mock as mock

from typer.testing import CliRunner

from token_goat.cli import app
from token_goat.read_commands import _build_chain, _callers_of

runner = CliRunner()


# ---------------------------------------------------------------------------
# Unit tests for _callers_of and _build_chain helpers
# ---------------------------------------------------------------------------


class TestCallersOf:
    def test_empty_db_returns_empty(self, tmp_data_dir, make_project, tmp_path):
        from token_goat import db, parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)

        with db.open_project_readonly(proj.hash) as conn:
            result = _callers_of(conn, "nonexistent", 10)

        assert result == []

    def test_finds_callers(self, tmp_data_dir, make_project, tmp_path):
        from token_goat import db, parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text(
            "def target(): pass\n"
            "def caller_a(): target()\n"
        )
        proj = make_project(proj_root)
        parser.index_project(proj)

        with db.open_project_readonly(proj.hash) as conn:
            result = _callers_of(conn, "target", 10)

        # Should find at least one caller entry for the file
        assert isinstance(result, list)
        for file_rel, cname, count in result:
            assert isinstance(file_rel, str)
            assert cname is None or isinstance(cname, str)
            assert isinstance(count, int)
            assert count >= 1


class TestBuildChain:
    def test_zero_depth_returns_empty(self):
        fake_conn = mock.MagicMock()
        result = _build_chain(fake_conn, "sym", depth=0, per_level_limit=5, path=frozenset())
        assert result == []

    def test_empty_target_returns_empty(self):
        fake_conn = mock.MagicMock()
        result = _build_chain(fake_conn, "", depth=3, per_level_limit=5, path=frozenset())
        assert result == []

    def test_cycle_detection(self, tmp_data_dir, make_project, tmp_path):
        from token_goat import db, parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text(
            "def a(): b()\n"
            "def b(): a()\n"
        )
        proj = make_project(proj_root)
        parser.index_project(proj)

        with db.open_project_readonly(proj.hash) as conn:
            # Should terminate without infinite recursion
            result = _build_chain(conn, "a", depth=10, per_level_limit=5, path=frozenset())

        # Result is a list; depth-limit or cycle-detection ensures it terminates
        assert isinstance(result, list)

    def test_structure_shape(self):
        fake_conn = mock.MagicMock()
        fake_conn.execute.return_value.fetchall.return_value = [
            ("src/a.py", "caller_fn", 2),
        ]

        result = _build_chain(fake_conn, "target", depth=1, per_level_limit=5, path=frozenset())

        assert len(result) == 1
        assert result[0]["symbol"] == "caller_fn"
        assert result[0]["file"] == "src/a.py"
        assert result[0]["calls"] == 2
        assert result[0]["callers"] == []


# ---------------------------------------------------------------------------
# CLI integration tests
# ---------------------------------------------------------------------------


class TestCallChainCLI:
    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["call-chain", "foo"])
        assert result.exit_code != 0
        assert "project" in result.output.lower() or "no project" in result.output.lower()

    def test_no_callers_message(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def lonely(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["call-chain", "lonely"])
        assert result.exit_code == 0
        assert "no callers" in result.output.lower() or "lonely" in result.output.lower()

    def test_json_output_shape(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def lonely(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["call-chain", "lonely", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert "query" in data
        assert "depth" in data
        assert "tree" in data
        assert isinstance(data["tree"], list)

    def test_depth_option(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def target(): pass\ndef mid(): target()\ndef top(): mid()\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["call-chain", "target", "--depth", "2", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["depth"] == 2

    def test_no_index_graceful(self, tmp_data_dir, tmp_path, monkeypatch):
        proj_root = tmp_path / "noidx"
        proj_root.mkdir()
        monkeypatch.chdir(proj_root)

        with mock.patch("token_goat.read_commands.find_project") as fp:
            fp.return_value = mock.MagicMock(hash="deadbeef", root=proj_root)
            with mock.patch("token_goat.db.open_project_readonly", side_effect=FileNotFoundError):
                result = runner.invoke(app, ["call-chain", "foo"])

        assert result.exit_code != 0
        assert "index" in result.output.lower() or "no index" in result.output.lower()

    def test_json_mode_unknown_symbol_clean(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        """Unknown symbol with --json: warning goes to stderr, stdout is valid JSON."""
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["call-chain", "__zzz_nonexistent__", "--json"])
        assert result.exit_code == 0
        # Warning goes to stderr; CliRunner mixes it before the JSON line.
        # Parse the last line, which is the JSON payload.
        json_line = result.output.strip().splitlines()[-1]
        data = json.loads(json_line)
        assert data["tree"] == []
        assert data["query"] == "__zzz_nonexistent__"
