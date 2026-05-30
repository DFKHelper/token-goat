"""Tests for the 'token-goat sessions' and 'token-goat sessions-show' commands."""
from __future__ import annotations

import json
import time

from typer.testing import CliRunner

from token_goat.cli import app


def _write_session(tmp_path, session_id: str, *, cwd: str = "", last_active: float | None = None,
                   files: dict | None = None, edited: dict | None = None,
                   hints: int = 0, bash: dict | None = None, web: dict | None = None) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(exist_ok=True)
    now = time.time()
    payload = {
        "schema_version": 1,
        "created_by": "token-goat",
        "session_id": session_id,
        "started_ts": (last_active or now) - 60,
        "last_activity_ts": last_active or now,
        "created_ts": (last_active or now) - 60,
        "cwd": cwd,
        "files": files or {},
        "edited_files": edited or {},
        "hints_emitted": hints,
        "hints_ignored": 0,
        "greps": [],
        "bash_history": bash or {},
        "web_history": web or {},
        "skill_history": {},
        "decisions": [],
        "result_cache": {},
        "glob_history": [],
        "snapshot_shas": {},
        "hints_seen": {},
        "bash_dedup_emitted_ids": [],
        "structured_hints_emitted": 0,
        "index_only_hints_emitted": 0,
        "hints_emitted_by_type": {},
        "hints_suppressed_by_type": {},
        "recent_hints": [],
        "last_manifest_sha": "",
        "last_manifest_ts": 0.0,
        "version": 1,
        "hint_category_history": {},
        "image_shrink_count": {},
    }
    f = sessions_dir / f"{session_id}.json"
    f.write_text(json.dumps(payload), encoding="utf-8")


class TestSessionsCommand:
    def test_empty_sessions(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["sessions"])
        assert result.exit_code == 0
        assert "no sessions" in result.stdout.lower()

    def test_lists_sessions(self, tmp_data_dir):
        _write_session(tmp_data_dir, "abc123", cwd="/projects/myapp", hints=5)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions"])
        assert result.exit_code == 0
        assert "abc123" in result.stdout
        assert "myapp" in result.stdout

    def test_sorts_newest_first(self, tmp_data_dir):
        now = time.time()
        _write_session(tmp_data_dir, "older-session", cwd="/p/a", last_active=now - 7200)
        _write_session(tmp_data_dir, "newer-session", cwd="/p/b", last_active=now - 60)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions"])
        assert result.exit_code == 0
        newer_pos = result.stdout.find("newer-session")
        older_pos = result.stdout.find("older-session")
        assert newer_pos < older_pos

    def test_limit_flag(self, tmp_data_dir):
        now = time.time()
        for i in range(5):
            _write_session(tmp_data_dir, f"sess-{i:03d}", last_active=now - i * 10)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions", "--limit", "2"])
        assert result.exit_code == 0
        # Only 2 data rows + header + separator
        data_lines = [line for line in result.stdout.splitlines() if "sess-" in line]
        assert len(data_lines) == 2

    def test_json_output(self, tmp_data_dir):
        _write_session(tmp_data_dir, "json-test-sess", cwd="/p/proj", hints=3,
                       files={"a.py": {"rel_or_abs": "a.py", "last_read_ts": 0, "read_count": 2}},
                       edited={"b.py": 1})
        runner = CliRunner()
        result = runner.invoke(app, ["sessions", "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert isinstance(payload, list)
        assert len(payload) == 1
        row = payload[0]
        assert row["session_id"] == "json-test-sess"
        assert row["file_count"] == 1
        assert row["edit_count"] == 1
        assert row["hints_emitted"] == 3

    def test_project_filter_matches(self, tmp_data_dir):
        _write_session(tmp_data_dir, "match-sess", cwd="/projects/alpha")
        _write_session(tmp_data_dir, "nomatch-sess", cwd="/projects/beta")
        runner = CliRunner()
        result = runner.invoke(app, ["sessions", "--project", "/projects/alpha"])
        assert result.exit_code == 0
        assert "match-sess" in result.stdout
        assert "nomatch-sess" not in result.stdout

    def test_project_filter_no_results(self, tmp_data_dir):
        _write_session(tmp_data_dir, "any-sess", cwd="/projects/other")
        runner = CliRunner()
        result = runner.invoke(app, ["sessions", "--project", "/projects/nonexistent"])
        assert result.exit_code == 0
        assert "no sessions" in result.stdout.lower()

    def test_shows_edit_and_hint_counts(self, tmp_data_dir):
        _write_session(tmp_data_dir, "counts-sess", edited={"x.py": 7, "y.py": 3}, hints=12)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions"])
        assert result.exit_code == 0
        assert "counts-sess" in result.stdout
        # edit count should be 10 (7+3), hints 12
        assert "10" in result.stdout
        assert "12" in result.stdout


class TestSessionsShowCommand:
    def test_shows_session_details(self, tmp_data_dir):
        _write_session(
            tmp_data_dir, "detail-sess", cwd="/projects/demo",
            files={"main.py": {"rel_or_abs": "main.py", "last_read_ts": time.time(), "read_count": 3}},
            edited={"main.py": 2},
            hints=4,
        )
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "detail-sess"])
        assert result.exit_code == 0
        assert "detail-sess" in result.stdout
        assert "/projects/demo" in result.stdout
        assert "main.py" in result.stdout

    def test_prefix_match(self, tmp_data_dir):
        _write_session(tmp_data_dir, "abcdef123456", cwd="/p/x")
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "abcdef"])
        assert result.exit_code == 0
        assert "abcdef123456" in result.stdout

    def test_ambiguous_prefix_errors(self, tmp_data_dir):
        _write_session(tmp_data_dir, "prefix-alpha", cwd="/p/a")
        _write_session(tmp_data_dir, "prefix-beta", cwd="/p/b")
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "prefix"])
        assert result.exit_code != 0
        assert "ambiguous" in result.output.lower()

    def test_missing_session_errors(self, tmp_data_dir):
        _write_session(tmp_data_dir, "some-other-session")
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "does-not-exist"])
        assert result.exit_code != 0
        assert "no session found" in result.output.lower()

    def test_json_output(self, tmp_data_dir):
        _write_session(tmp_data_dir, "json-show-sess", cwd="/p/x", hints=7)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "json-show-sess", "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert payload["session_id"] == "json-show-sess"
        assert payload["hints_emitted"] == 7

    def test_shows_bash_history(self, tmp_data_dir):
        bash = {"sha1": {"cmd_sha": "sha1", "cmd_preview": "pytest -v", "output_id": "o1",
                          "ts": time.time(), "stdout_bytes": 100, "stderr_bytes": 0, "run_count": 2}}
        _write_session(tmp_data_dir, "bash-hist-sess", bash=bash)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "bash-hist-sess"])
        assert result.exit_code == 0
        assert "pytest -v" in result.stdout
        assert "Bash history" in result.stdout

    def test_shows_web_history(self, tmp_data_dir):
        web = {"sha1": {"url_sha": "sha1", "url_preview": "https://example.com/docs",
                        "output_id": "w1", "ts": time.time(), "body_bytes": 500}}
        _write_session(tmp_data_dir, "web-hist-sess", web=web)
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "web-hist-sess"])
        assert result.exit_code == 0
        assert "example.com" in result.stdout
        assert "Web history" in result.stdout

    def test_no_sessions_dir(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["sessions-show", "anything"])
        # No sessions dir at all → error
        assert result.exit_code != 0
