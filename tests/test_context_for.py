"""Tests for `token-goat context-for` — task-aware context assembly."""
from __future__ import annotations

import json
import unittest.mock as mock

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


class TestContextForCLI:
    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["context-for", "add rate limiting"])
        assert result.exit_code != 0
        assert "project" in result.output.lower() or "no project" in result.output.lower()

    def test_empty_task_error(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        result = runner.invoke(app, ["context-for", "   "])
        assert result.exit_code != 0

    def test_no_results_message(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        with (
            mock.patch("token_goat.read_commands._callers_of", return_value=[]),
            mock.patch("token_goat.embeddings.semantic_search", side_effect=Exception("no embeddings")),
        ):
            result = runner.invoke(app, ["context-for", "zzz_no_match_xqq"])

        assert result.exit_code == 0

    def test_json_output_shape(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text(
            "def process_request(req): pass\n"
            "def handle_auth(token): pass\n"
        )
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        fake_hit = mock.MagicMock()
        fake_hit.file_rel = "a.py"
        fake_hit.text = "def process_request(req): pass\n" * 10
        fake_hit.distance = 0.2
        fake_hit.start_line = 1
        fake_hit.end_line = 2

        with mock.patch("token_goat.embeddings.semantic_search", return_value=[fake_hit]):
            result = runner.invoke(app, ["context-for", "process auth requests", "--json"])

        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert "task" in data
        assert "budget_tokens" in data
        assert "used_tokens" in data
        assert "entries" in data
        assert isinstance(data["entries"], list)
        if data["entries"]:
            e = data["entries"][0]
            assert "file" in e
            assert "est_tokens" in e
            assert "relevance_pct" in e

    def test_budget_respected(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        hits = []
        for i in range(5):
            h = mock.MagicMock()
            h.file_rel = f"src/file{i}.py"
            h.text = "x" * 5000  # ~1667 tokens each (len // 3 + 1)
            h.distance = 0.1 * i
            h.start_line = 1
            h.end_line = 50
            hits.append(h)

        with mock.patch("token_goat.embeddings.semantic_search", return_value=hits):
            result = runner.invoke(app, ["context-for", "something", "--budget", "2000", "--json"])

        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["used_tokens"] <= 2000

    def test_text_output_contains_read_command(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        fake_hit = mock.MagicMock()
        fake_hit.file_rel = "a.py"
        fake_hit.text = "def foo(): pass\n" * 5
        fake_hit.distance = 0.15
        fake_hit.start_line = 1
        fake_hit.end_line = 5

        with mock.patch("token_goat.embeddings.semantic_search", return_value=[fake_hit]):
            result = runner.invoke(app, ["context-for", "fix the foo function"])

        assert result.exit_code == 0
        assert "token-goat read" in result.output

    def test_json_mode_no_results(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        """context-for --json with no matches emits valid JSON, not a text message."""
        from token_goat import parser

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.py").write_text("def foo(): pass\n")
        proj = make_project(proj_root)
        parser.index_project(proj)
        monkeypatch.chdir(proj_root)

        with mock.patch(
            "token_goat.embeddings.semantic_search",
            side_effect=Exception("no embeddings"),
        ):
            result = runner.invoke(app, ["context-for", "zzz_no_match_xqq", "--json"])

        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["entries"] == []
        assert "task" in data
        assert "budget_tokens" in data
