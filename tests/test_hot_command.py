"""Tests for `token-goat hot` — cross-session file frequency ranking."""
from __future__ import annotations

import json
import time

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


def _write_session(
    tmp_path,
    session_id: str,
    *,
    cwd: str = "",
    last_active: float | None = None,
    files: dict | None = None,
    edited: dict | None = None,
) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(exist_ok=True)
    now = time.time()
    payload = {
        "schema_version": 1,
        "session_id": session_id,
        "cwd": cwd,
        "last_activity_ts": last_active or now,
        "files": files or {},
        "edited_files": edited or {},
        "hints_emitted": 0,
        "bash_history": {},
        "web_history": {},
    }
    (sessions_dir / f"{session_id}.json").write_text(json.dumps(payload), encoding="utf-8")


class TestHotCommand:
    def test_no_sessions_returns_message(self, tmp_data_dir):
        result = runner.invoke(app, ["hot"])
        assert result.exit_code == 0
        assert "no session" in result.output.lower() or result.output.strip() != ""

    def test_ranks_by_frequency(self, tmp_data_dir, tmp_path, monkeypatch):
        cwd = str(tmp_path)
        monkeypatch.chdir(tmp_path)

        _write_session(tmp_path, "s1", cwd=cwd, files={"src/a.py": 1, "src/b.py": 1})
        _write_session(tmp_path, "s2", cwd=cwd, files={"src/a.py": 1, "src/c.py": 1})
        _write_session(tmp_path, "s3", cwd=cwd, files={"src/a.py": 1})

        result = runner.invoke(app, ["hot"])
        assert result.exit_code == 0
        # a.py should appear before b.py and c.py (3 reads vs 1)
        lines = result.output.splitlines()
        a_idx = next((i for i, line in enumerate(lines) if "a.py" in line), None)
        b_idx = next((i for i, line in enumerate(lines) if "b.py" in line), None)
        assert a_idx is not None
        assert b_idx is not None
        assert a_idx < b_idx

    def test_counts_edits_separately(self, tmp_data_dir, tmp_path, monkeypatch):
        cwd = str(tmp_path)
        monkeypatch.chdir(tmp_path)

        _write_session(tmp_path, "s1", cwd=cwd, files={"src/a.py": 1}, edited={"src/a.py": 1})

        result = runner.invoke(app, ["hot", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.output.strip())
        a_row = next((r for r in rows if "a.py" in r["file"]), None)
        assert a_row is not None
        assert a_row["reads"] >= 1
        assert a_row["edits"] >= 1
        assert a_row["total"] == a_row["reads"] + a_row["edits"]

    def test_json_output_shape(self, tmp_data_dir, tmp_path, monkeypatch):
        cwd = str(tmp_path)
        monkeypatch.chdir(tmp_path)

        _write_session(tmp_path, "s1", cwd=cwd, files={"src/x.py": 1})

        result = runner.invoke(app, ["hot", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.output.strip())
        assert isinstance(rows, list)
        assert len(rows) >= 1
        for r in rows:
            assert "file" in r
            assert "reads" in r
            assert "edits" in r
            assert "total" in r

    def test_limit_option(self, tmp_data_dir, tmp_path, monkeypatch):
        cwd = str(tmp_path)
        monkeypatch.chdir(tmp_path)

        files = {f"src/file{i}.py": 1 for i in range(10)}
        _write_session(tmp_path, "s1", cwd=cwd, files=files)

        result = runner.invoke(app, ["hot", "--limit", "3", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.output.strip())
        assert len(rows) <= 3

    def test_project_filter_excludes_other_projects(self, tmp_data_dir, tmp_path, monkeypatch):
        my_cwd = str(tmp_path / "myproj")
        other_cwd = str(tmp_path / "other")
        monkeypatch.chdir(tmp_path)

        _write_session(tmp_path, "s1", cwd=my_cwd, files={"src/mine.py": 1})
        _write_session(tmp_path, "s2", cwd=other_cwd, files={"src/theirs.py": 1})

        result = runner.invoke(app, ["hot", "--project", my_cwd, "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.output.strip())
        files_found = [r["file"] for r in rows]
        assert any("mine.py" in f for f in files_found)
        assert not any("theirs.py" in f for f in files_found)

    def test_json_mode_no_session_data(self, tmp_data_dir):
        """hot --json with no session data emits [] instead of a text message."""
        result = runner.invoke(app, ["hot", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data == []
