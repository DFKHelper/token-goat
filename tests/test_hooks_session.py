"""Tests for hook integration with session cache."""
from __future__ import annotations

import json
import pathlib
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
            m.setattr(pathlib.Path, "replace", boom)
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
            m.setattr(pathlib.Path, "read_text", boom)
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


# ---------------------------------------------------------------------------
# #26 — skip git log when on clean main
# ---------------------------------------------------------------------------


class TestSessionBriefSkipsLogOnCleanMain:
    """_build_session_brief skips git log when branch is clean main synced to origin."""

    # Real 40-char hex SHAs are required to satisfy the SHA-guard in _build_session_brief
    REAL_SHA = "a" * 40  # valid 40-char hex string

    def _make_fake_run(self, branch: str, status_out: str, local_sha: str, origin_sha: str):
        """Build a subprocess.run stub that returns proper SHAs for rev-parse calls."""
        def _fake_run(cmd, **kwargs):
            r = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            cmd_str = " ".join(cmd)
            if "--abbrev-ref" in cmd_str:
                r.stdout = branch + "\n"
            elif "--porcelain" in cmd_str:
                r.stdout = status_out
            elif "rev-parse" in cmd_str and "origin/" in cmd_str:
                r.stdout = origin_sha + "\n"
            elif "rev-parse" in cmd_str:
                r.stdout = local_sha + "\n"
            elif "log" in cmd_str:
                r.stdout = "abc1234 some commit\n"
            return r
        return _fake_run

    def test_clean_main_synced_to_origin_skips_log(self, monkeypatch, tmp_path):
        """Clean main branch matching origin with real SHAs → log not included."""
        import subprocess
        monkeypatch.setattr(
            subprocess, "run",
            self._make_fake_run("main", "", self.REAL_SHA, self.REAL_SHA),
        )
        import token_goat.hooks_session as hs_mod
        brief = hs_mod._build_session_brief(str(tmp_path))
        # Clean main at origin → brief is None (nothing to report) or no Recent: line
        assert brief is None or "Recent:" not in (brief or "")

    def test_dirty_main_includes_log(self, monkeypatch, tmp_path):
        """Dirty working tree on main → skip logic does not fire; log IS included."""
        import subprocess
        monkeypatch.setattr(
            subprocess, "run",
            self._make_fake_run("main", " M src/foo.py\n", self.REAL_SHA, self.REAL_SHA),
        )
        import token_goat.hooks_session as hs_mod
        brief = hs_mod._build_session_brief(str(tmp_path))
        assert brief is not None
        assert "Recent:" in brief

    def test_feature_branch_includes_log(self, monkeypatch, tmp_path):
        """Non-main branch → skip logic never fires; log always included."""
        import subprocess
        monkeypatch.setattr(
            subprocess, "run",
            self._make_fake_run("feature/my-branch", "", self.REAL_SHA, self.REAL_SHA),
        )
        import token_goat.hooks_session as hs_mod
        brief = hs_mod._build_session_brief(str(tmp_path))
        assert brief is not None
        assert "Recent:" in brief


# ---------------------------------------------------------------------------
# Deferred import isolation — compact/cache_common must not load on SessionStart
# ---------------------------------------------------------------------------


class TestDeferredImports:
    """Heavy modules (compact, cache_common) must not be imported during a
    plain SessionStart (non-compact source).  They are only needed when the
    recovery-hint path runs, i.e. source == "compact" with a live session."""

    def test_compact_not_imported_on_session_start(self, tmp_data_dir, monkeypatch):
        """compact module is NOT imported as a side-effect of importing hooks_session."""
        # Remove cached modules so we get a clean import slate for hooks_session.
        # We do NOT remove hooks_session itself — the module may already be loaded
        # by other tests.  What matters is that compact stays absent unless the
        # compact path runs.
        import sys
        for mod in list(sys.modules):
            if mod in ("token_goat.compact", "token_goat.cache_common"):
                del sys.modules[mod]

        # Re-import hooks_session to ensure module-level code re-runs cleanly.
        import importlib

        import token_goat.hooks_session as hs_mod
        importlib.reload(hs_mod)

        # Now fire a plain startup — should NOT trigger compact or cache_common.
        payload = {"session_id": "deferred_test_1", "cwd": str(tmp_data_dir), "source": "startup"}
        result = hs_mod.session_start(payload)
        assert result.get("continue") is True

        # compact and cache_common must still be absent (or at most absent — another
        # test in the same process may have loaded them, so we only assert they were
        # not loaded as a direct consequence of this code path when starting clean).
        # The reliable check: reload drops them, session_start with source=startup
        # must not re-introduce them.  We verify by checking sys.modules AFTER the
        # fresh reload + startup call.  If they appear now, they were pulled in by
        # the startup path.
        assert "token_goat.compact" not in sys.modules, (
            "compact was imported during a non-compact SessionStart — deferred import missing"
        )
        assert "token_goat.cache_common" not in sys.modules, (
            "cache_common was imported during a non-compact SessionStart — deferred import missing"
        )
