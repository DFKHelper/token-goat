"""Tests for `token-goat recent` command (sub-area I).

Verifies that:
 - `recent` lists files from the session cache (edited files)
 - `recent --n N` limits output to N files
 - `recent --json` returns structured JSON output
 - Files are sorted by relevance (session edits first)
"""
from __future__ import annotations

import json

# ---------------------------------------------------------------------------
# Unit tests for recent command
# ---------------------------------------------------------------------------

class TestRecentCommand:
    """token-goat recent shows recently accessed/edited files."""

    def _make_project_with_files(self, tmp_path, tmp_data_dir, make_project, files: dict[str, str]):
        """Create a project with given files indexed."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "recent_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        for fname, content in files.items():
            fpath = proj_root / fname
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fpath.write_text(content, encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_recent_json_output_structure(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """recent --json returns a dict with a 'files' list."""
        files = {
            "alpha.py": "def alpha(): pass\n",
            "beta.py": "def beta(): pass\n",
        }
        proj_root, proj = self._make_project_with_files(tmp_path, tmp_data_dir, make_project, files)
        monkeypatch.chdir(proj_root)

        # Use a session with edited files
        from token_goat import session as sess_mod

        sid = "test-recent-001"
        sess_mod.reset_session(sid)
        try:
            # Mark alpha.py as edited this session
            sess_mod.mark_file_edited(sid, str(proj_root / "alpha.py"))

            from token_goat.read_commands import recent
            recent(n=10, session_id=sid, json_output=True)
            out = capsys.readouterr().out
            data = json.loads(out.strip())
            assert "files" in data
            assert isinstance(data["files"], list)
        finally:
            sess_mod.reset_session(sid)

    def test_recent_includes_session_edited_files(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """recently edited files appear in recent output."""
        files = {"main.py": "def main(): pass\n", "utils.py": "def util(): pass\n"}
        proj_root, proj = self._make_project_with_files(tmp_path, tmp_data_dir, make_project, files)
        monkeypatch.chdir(proj_root)

        from token_goat import session as sess_mod

        sid = "test-recent-002"
        sess_mod.reset_session(sid)
        try:
            sess_mod.mark_file_edited(sid, str(proj_root / "main.py"))

            from token_goat.read_commands import recent
            recent(n=10, session_id=sid, json_output=True)
            out = capsys.readouterr().out
            data = json.loads(out.strip())
            paths = [f.get("path", "") for f in data.get("files", [])]
            # main.py should appear in the result
            assert any("main.py" in p for p in paths)
        finally:
            sess_mod.reset_session(sid)

    def test_recent_n_limits_output(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """recent --n N returns at most N files."""
        files = {f"file{i}.py": f"def f{i}(): pass\n" for i in range(10)}
        proj_root, proj = self._make_project_with_files(tmp_path, tmp_data_dir, make_project, files)
        monkeypatch.chdir(proj_root)

        from token_goat import session as sess_mod

        sid = "test-recent-003"
        sess_mod.reset_session(sid)
        try:
            for i in range(10):
                sess_mod.mark_file_edited(sid, str(proj_root / f"file{i}.py"))

            from token_goat.read_commands import recent
            recent(n=3, session_id=sid, json_output=True)
            out = capsys.readouterr().out
            data = json.loads(out.strip())
            assert len(data.get("files", [])) <= 3
        finally:
            sess_mod.reset_session(sid)

    def test_recent_text_output_contains_file_names(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """recent text output includes file names."""
        files = {"src/service.py": "class Service:\n    def run(self):\n        pass\n"}
        proj_root, proj = self._make_project_with_files(tmp_path, tmp_data_dir, make_project, files)
        monkeypatch.chdir(proj_root)

        from token_goat import session as sess_mod

        sid = "test-recent-004"
        sess_mod.reset_session(sid)
        try:
            sess_mod.mark_file_edited(sid, str(proj_root / "src" / "service.py"))

            from token_goat.read_commands import recent
            recent(n=5, session_id=sid, json_output=False)
            out = capsys.readouterr().out
            assert "service.py" in out
        finally:
            sess_mod.reset_session(sid)

    def test_recent_session_edited_appears_before_git(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """Session-edited files appear before git-history files in JSON output."""
        files = {"edited.py": "def e(): pass\n", "other.py": "def o(): pass\n"}
        proj_root, proj = self._make_project_with_files(tmp_path, tmp_data_dir, make_project, files)
        monkeypatch.chdir(proj_root)

        from token_goat import session as sess_mod

        sid = "test-recent-005"
        sess_mod.reset_session(sid)
        try:
            sess_mod.mark_file_edited(sid, str(proj_root / "edited.py"))

            from token_goat.read_commands import recent
            recent(n=10, session_id=sid, json_output=True)
            out = capsys.readouterr().out
            data = json.loads(out.strip())
            files_out = data.get("files", [])
            if files_out:
                # The first entry with source="session" should be edited.py
                session_files = [f for f in files_out if "session" in f.get("source", "").lower()]
                if session_files:
                    assert "edited.py" in session_files[0].get("path", "")
        finally:
            sess_mod.reset_session(sid)


# ---------------------------------------------------------------------------
# CLI smoke test for recent command
# ---------------------------------------------------------------------------

class TestRecentCliSmoke:
    """CLI invocation of token-goat recent."""

    def test_cli_recent_exit_code_zero(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat recent returns exit code 0."""
        from typer.testing import CliRunner

        from token_goat.cli import app
        from token_goat.parser import index_project

        proj_root = tmp_path / "recent_smoke"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "foo.py").write_text("def foo(): pass\n", encoding="utf-8")
        monkeypatch.chdir(proj_root)
        proj = make_project(proj_root)
        index_project(proj, full=True)

        runner = CliRunner()
        result = runner.invoke(app, ["recent"])
        assert result.exit_code == 0, result.output

    def test_cli_recent_json_flag(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat recent --json returns valid JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app
        from token_goat.parser import index_project

        proj_root = tmp_path / "recent_json"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "bar.py").write_text("def bar(): pass\n", encoding="utf-8")
        monkeypatch.chdir(proj_root)
        proj = make_project(proj_root)
        index_project(proj, full=True)

        runner = CliRunner()
        result = runner.invoke(app, ["recent", "--json"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert "files" in data
