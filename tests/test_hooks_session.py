"""Tests for hook integration with session cache."""
from __future__ import annotations

import json
import sys

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_cli, session


class TestPostReadHookIntegration:
    """post_read hook integration."""

    def test_post_read_read_tool(self, tmp_data_dir):
        """post_read with tool_name=Read records to session cache."""
        payload = {
            "session_id": "hook_s1",
            "tool_name": "Read",
            "tool_input": {"file_path": "C:/foo.py", "offset": 0, "limit": 100},
        }
        result = hooks_cli.post_read(payload)
        _assert_continue(result)

        # Verify cache was updated; drive letter is lowercased on Windows, preserved on Linux.
        cache = session.load("hook_s1")
        expected_key = "c:/foo.py" if sys.platform == "win32" else "C:/foo.py"
        assert expected_key in cache.files
        assert cache.files[expected_key].read_count == 1

    def test_post_read_grep_tool(self, tmp_data_dir):
        """post_read with tool_name=Grep records a GrepEntry."""
        payload = {
            "session_id": "hook_s2",
            "tool_name": "Grep",
            "tool_input": {"pattern": "def myfunction", "path": "src/"},
        }
        result = hooks_cli.post_read(payload)
        _assert_continue(result)

        cache = session.load("hook_s2")
        assert len(cache.greps) == 1
        assert cache.greps[0].pattern == "def myfunction"

    def test_post_read_glob_tool(self, tmp_data_dir):
        """post_read with tool_name=Glob (just logs, doesn't crash)."""
        payload = {
            "session_id": "hook_s3",
            "tool_name": "Glob",
            "tool_input": {"pattern": "*.py"},
        }
        result = hooks_cli.post_read(payload)
        _assert_continue(result)

    def test_post_read_no_session_id(self, tmp_data_dir):
        """post_read with no session_id returns continue:true, doesn't crash."""
        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "C:/foo.py", "offset": 0, "limit": 100},
        }
        result = hooks_cli.post_read(payload)
        _assert_continue(result)

    def test_post_read_missing_tool_input(self, tmp_data_dir):
        """post_read with missing tool_input key doesn't crash."""
        payload = {
            "session_id": "hook_s4",
            "tool_name": "Read",
        }
        result = hooks_cli.post_read(payload)
        _assert_continue(result)


class TestSessionStartHookIntegration:
    """session_start hook integration."""

    def test_session_start_resets_cache(self, tmp_data_dir):
        """session_start hook resets the cache for the given session."""
        s_id = "hook_s5"
        # Mark some files
        session.mark_file_read(s_id, "f.py")
        assert session.load(s_id).files

        # Now call session_start
        payload = {"session_id": s_id, "cwd": "/some/path"}
        result = hooks_cli.session_start(payload)
        _assert_continue(result)

        # Cache should be reset
        fresh = session.load(s_id)
        assert fresh.files == {}
        assert fresh.greps == []

    def test_session_start_auto_indexes_without_counting_files(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start should use the cheap project-presence probe, not a full file count."""
        from token_goat import db, worker
        from token_goat.project import find_project

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        proj = find_project(proj_root)
        assert proj is not None

        monkeypatch.setattr(db, "file_count", lambda *_: (_ for _ in ()).throw(RuntimeError("count called")))
        monkeypatch.setattr(db, "touch_project_last_seen", lambda *_: None)

        spawned: list[tuple[str, str]] = []
        monkeypatch.setattr(
            worker,
            "spawn_index_detached",
            lambda root, project_hash: spawned.append((root, project_hash)) or 4321,
        )
        monkeypatch.setattr(worker, "ensure_running", lambda: 99999)

        payload = {"session_id": "hook_s6", "cwd": str(proj_root)}
        result = hooks_cli.session_start(payload)
        _assert_continue(result)
        assert spawned == [(str(proj.root), proj.hash)]


class TestDispatcherPostRead:
    """Test the full dispatcher for post_read."""

    def test_dispatch_post_read_read_event(self, tmp_data_dir):
        """dispatch('post-read', ...) routes to post_read handler."""
        payload = {
            "session_id": "disp_s1",
            "tool_name": "Read",
            "tool_input": {"file_path": "x.py", "offset": 10, "limit": 50},
        }
        result = hooks_cli.dispatch("post-read", payload)
        _assert_continue(result)

        cache = session.load("disp_s1")
        assert "x.py" in cache.files


class TestLockedSessionCacheDispatch:
    """Hook-layer regressions for locked session-cache files."""

    def test_dispatch_post_read_read_survives_locked_save(self, tmp_data_dir, monkeypatch):
        """post-read Read should continue even if the session cache cannot be replaced."""
        from token_goat import db

        session_id = "dispatch_lock_read"
        session.mark_file_read(session_id, "seed.py")

        payload = {
            "session_id": session_id,
            "tool_name": "Read",
            "tool_input": {"file_path": "new.py", "offset": 0, "limit": 50},
        }

        def boom(self, *args, **kwargs):
            raise PermissionError("[WinError 32] The process cannot access the file")

        with monkeypatch.context() as m:
            m.setattr(session.Path, "replace", boom)
            result = hooks_cli.dispatch("post-read", payload)

        _assert_continue(result)

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT detail FROM stats WHERE kind = 'session_cache_unavailable'"
            ).fetchall()
        assert any(row["detail"].startswith("save:") for row in rows)

    def test_dispatch_post_read_grep_survives_locked_load(self, tmp_data_dir, monkeypatch):
        """post-read Grep should continue even if the session cache cannot be read."""
        from token_goat import db

        session_id = "dispatch_lock_grep"
        session.mark_grep(session_id, "seed")

        payload = {
            "session_id": session_id,
            "tool_name": "Grep",
            "tool_input": {"pattern": "needle", "path": "src/"},
            "result_count": 3,
        }

        def boom(self, *args, **kwargs):
            raise PermissionError("[Errno 13] Permission denied")

        with monkeypatch.context() as m:
            m.setattr(session.Path, "read_text", boom)
            result = hooks_cli.dispatch("post-read", payload)

        _assert_continue(result)

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT detail FROM stats WHERE kind = 'session_cache_unavailable'"
            ).fetchall()
        assert any(row["detail"].startswith("load:") for row in rows)


class TestCliCommands:
    """CLI command integration (typer-based, direct)."""

    def test_session_mark_command(self, tmp_data_dir):
        """Test session-mark command via typer."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(
            app,
            ["session-mark", "some/file.py", "-s", "cli_s1", "--offset", "0", "--limit", "50"],
        )
        assert result.exit_code == 0
        assert "ok" in result.stdout

        # Verify it's in the cache
        cache = session.load("cli_s1")
        assert "some/file.py" in cache.files

    def test_session_touched_command_json(self, tmp_data_dir):
        """Test session-touched command with --json."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        s_id = "cli_s2"
        session.mark_file_read(s_id, "a.py", offset=0, limit=100)
        session.mark_file_read(s_id, "b.py", offset=0, limit=50)

        runner = CliRunner()
        result = runner.invoke(app, ["session-touched", "-s", s_id, "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert len(data) == 2
        paths = [entry["path"] for entry in data]
        assert "a.py" in paths
        assert "b.py" in paths

    def test_session_touched_command_plain(self, tmp_data_dir):
        """Test session-touched command with plain output."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        s_id = "cli_s3"
        session.mark_file_read(s_id, "x.py", offset=0, limit=100)

        runner = CliRunner()
        result = runner.invoke(app, ["session-touched", "-s", s_id])
        assert result.exit_code == 0
        assert "x.py" in result.stdout
        assert "reads=1" in result.stdout

    def test_session_touched_empty_session(self, tmp_data_dir):
        """Test session-touched on empty session."""
        from typer.testing import CliRunner

        from token_goat.cli import app


        runner = CliRunner()
        result = runner.invoke(app, ["session-touched", "-s", "empty"])
        assert result.exit_code == 0
        assert "(no files touched in this session)" in result.stdout
