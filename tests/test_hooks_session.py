"""Tests for hook integration with session cache."""
from __future__ import annotations

import json
import pathlib

from compact_test_helpers import make_fake_session_cache as _shared_fake_session_cache
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

        # Drive letter is lowercased unconditionally (WSL compatibility).
        cache = session.load("hook_s1")
        assert "c:/foo.py" in cache.files
        assert cache.files["c:/foo.py"].read_count == 1

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

        # 700ms default is too tight for the error-handling path under lock contention; give the background thread enough time.
        monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "5000")

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
        """Build a subprocess.run stub that handles the single `status -z -b` call.

        *status_out* is still passed in ``--porcelain`` line format for
        readability; this helper converts it to NUL-separated ``-z -b`` format.
        """
        def _porcelain_to_z_b(porcelain: str, br: str) -> str:
            """Convert newline-separated porcelain lines to NUL-separated -z -b output."""
            header = f"## {br}"
            parts = [header]
            for line in porcelain.splitlines():
                line = line.rstrip("\n")
                if line:
                    parts.append(line)
            return "\0".join(parts) + ("\0" if len(parts) > 1 else "")

        def _fake_run(cmd, **kwargs):
            r = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
            cmd_str = " ".join(cmd)
            if "-z" in cmd_str and "-b" in cmd_str:
                # New single-call path: git --no-optional-locks status -z -b
                r.stdout = _porcelain_to_z_b(status_out, branch)
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
        # New single-line format uses an em-dash before commits; the SHA prefix
        # is the unambiguous marker that the log section made it into the brief.
        assert " — " in brief
        # The mock's log handler returns the hardcoded "abc1234 some commit"
        # line, which is the unambiguous marker that the log section landed.
        assert "abc1234" in brief

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
        assert " — " in brief
        # The mock's log handler returns the hardcoded "abc1234 some commit"
        # line, which is the unambiguous marker that the log section landed.
        assert "abc1234" in brief


# ---------------------------------------------------------------------------
# Item #9 — _parse_status_z_b unit tests
# ---------------------------------------------------------------------------


class TestParseStatusZB:
    """Unit tests for the ``-z -b`` output parser covering the same fields the
    old two-call (rev-parse + --porcelain) path used."""

    def test_clean_repo(self):
        """Clean working tree: only header field, no status entries."""
        import token_goat.hooks_session as hs_mod
        branch, lines, total = hs_mod._parse_status_z_b("## main...origin/main\0")
        assert branch == "main"
        assert lines == []
        assert total == 0

    def test_branch_with_untracked_and_modified(self):
        """Branch header plus 1 untracked and 1 modified file."""
        import token_goat.hooks_session as hs_mod
        # -z output: header\0XY file\0XY file\0
        output = "## feature/foo...origin/feature/foo\0?? new_file.py\0 M src/bar.py\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "feature/foo"
        assert len(lines) == 2
        assert total == 2
        assert any(ln.startswith("??") for ln in lines)
        assert any(ln[1:2] == "M" for ln in lines)

    def test_detached_head(self):
        """Detached HEAD: branch reported as 'HEAD'."""
        import token_goat.hooks_session as hs_mod
        output = "## HEAD (no branch)\0 M src/foo.py\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "HEAD"
        assert len(lines) == 1
        assert total == 1

    def test_no_commits_yet(self):
        """New repo with no commits: 'No commits yet on <branch>'."""
        import token_goat.hooks_session as hs_mod
        output = "## No commits yet on main\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "main"
        assert lines == []
        assert total == 0

    def test_capped_at_50_entries_total_reported(self):
        """Status list is capped at 50 but total_count reflects the full count."""
        import token_goat.hooks_session as hs_mod
        entries = "".join(f"?? file{i}.py\0" for i in range(80))
        output = f"## main\0{entries}"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "main"
        assert len(lines) == 50
        assert total == 80

    def test_empty_output(self):
        """Empty string (git not a repo / failure) returns safe defaults."""
        import token_goat.hooks_session as hs_mod
        branch, lines, total = hs_mod._parse_status_z_b("")
        assert branch == "unknown"
        assert lines == []
        assert total == 0

    def test_staged_file(self):
        """Staged (index-modified) file is correctly detected."""
        import token_goat.hooks_session as hs_mod
        output = "## main\0M  src/staged.py\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "main"
        assert len(lines) == 1
        assert total == 1
        assert lines[0][:1] == "M"  # staged in index

    def test_rename_old_name_not_counted(self):
        """Rename entries: old-name field must be skipped; total_count reflects
        one entry per rename, not two."""
        import token_goat.hooks_session as hs_mod
        # git status -z -b rename: "R  new.py\0old.py\0" plus an unrelated edit
        output = "## main\0R  new_name.py\0old_name.py\0M  other.py\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert branch == "main"
        assert total == 2, f"Expected 2 (rename + modify), got {total}"
        assert len(lines) == 2
        path_fields = [ln[3:] for ln in lines]  # strip "XY " prefix
        assert "new_name.py" in path_fields
        assert "old_name.py" not in path_fields, "old-name field must be skipped"
        assert "other.py" in path_fields

    def test_copy_old_name_not_counted(self):
        """Copy entries (C XY code) behave the same as renames: source skipped."""
        import token_goat.hooks_session as hs_mod
        output = "## main\0C  dest.py\0source.py\0"
        branch, lines, total = hs_mod._parse_status_z_b(output)
        assert total == 1
        assert len(lines) == 1
        assert lines[0][3:] == "dest.py"


# ---------------------------------------------------------------------------
# Item #9 — TimeoutExpired regression: _build_session_brief returns None
# ---------------------------------------------------------------------------


class TestSessionBriefTimeoutReturnsNone:
    """Regression: when subprocess.run raises TimeoutExpired on the combined
    ``status -z -b`` call, _build_session_brief must return None without
    raising and without leaking open file objects."""

    def test_timeout_returns_none(self, monkeypatch, tmp_path):
        """TimeoutExpired on the status call → None, no exception escapes."""
        import subprocess

        import token_goat.hooks_session as hs_mod

        def _raise_timeout(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout=2.0)

        monkeypatch.setattr(subprocess, "run", _raise_timeout)
        result = hs_mod._build_session_brief(str(tmp_path))
        assert result is None

    def test_timeout_no_exception_propagates(self, monkeypatch, tmp_path):
        """Confirm no exception type escapes — not just TimeoutExpired."""
        import subprocess

        import token_goat.hooks_session as hs_mod

        def _raise_timeout(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout=0.1)

        monkeypatch.setattr(subprocess, "run", _raise_timeout)
        # Must not raise anything at all
        try:
            hs_mod._build_session_brief(str(tmp_path))
        except Exception as exc:  # noqa: BLE001
            raise AssertionError(f"_build_session_brief raised {exc!r} on timeout") from exc


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
        #
        # ``monkeypatch.delitem`` saves the current value and restores it at
        # teardown.  A bare ``del sys.modules[mod]`` would orphan every
        # already-loaded reference in other test modules' namespaces — the next
        # ``import`` would build a fresh class object, breaking ``is``-identity
        # invariants (TypedDict classes are recreated on each module execution)
        # and silently bypassing ``mock.patch`` calls that target the new module
        # while ``from token_goat import compact`` in the caller still points at
        # the old one.  Both failure modes were reproduced as deterministic
        # CI-only failures and traced to this exact site.
        import sys
        for mod_name in ("token_goat.compact", "token_goat.cache_common"):
            if mod_name in sys.modules:
                monkeypatch.delitem(sys.modules, mod_name)

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


# ---------------------------------------------------------------------------
# compact-skip sentinel: written when pre_compact skips due to low activity
# ---------------------------------------------------------------------------


class TestCompactSkipSentinelWrite:
    """Verify that pre_compact writes the sentinel when the manifest is skipped."""

    def _make_fake_session_cache(self):
        return _shared_fake_session_cache()

    def test_sentinel_written_when_no_session(self, tmp_data_dir, monkeypatch):
        """pre_compact writes sentinel when session_id is present but session is empty."""
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_cli, paths

        session_id = "sentinel_session_empty"

        # Stub config to enable compact_assist with a high min_events floor so
        # build_manifest_with_count returns (manifest, 0) and triggers the skip.
        fake_cfg = MagicMock()
        fake_cfg.compact_assist.enabled = True
        fake_cfg.compact_assist.triggers = ["auto"]
        fake_cfg.compact_assist.max_manifest_tokens = 400
        # Explicit float — MagicMock auto-vivified attributes are not comparable to
        # numeric literals (see memory: feedback_mockobject_attribute_trap.md).
        fake_cfg.compact_assist.auto_trigger_multiplier = 1.0
        fake_cfg.compact_assist.min_events = 5  # floor above 0 events → skip

        fake_cache = self._make_fake_session_cache()
        with patch("token_goat.config.load", return_value=fake_cfg), \
             patch("token_goat.session.safe_load", return_value=fake_cache), \
             patch("token_goat.compact.build_manifest_with_count", return_value=("", 0)):

            payload = {"session_id": session_id, "trigger": "auto"}
            result = hooks_cli.pre_compact(payload)

        assert result.get("continue") is True

        # The sentinel file must now exist.
        sentinel = paths.compact_skip_sentinel_path(session_id)
        assert sentinel.exists(), (
            f"compact-skip sentinel not written after low-activity skip; expected {sentinel}"
        )

    def test_sentinel_written_when_manifest_empty(self, tmp_data_dir, monkeypatch):
        """pre_compact writes sentinel when build_manifest_with_count returns empty string."""
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_cli, paths

        session_id = "sentinel_session_manifest_empty"

        fake_cfg = MagicMock()
        fake_cfg.compact_assist.enabled = True
        fake_cfg.compact_assist.triggers = ["auto"]
        fake_cfg.compact_assist.max_manifest_tokens = 400
        # Explicit float — MagicMock auto-vivified attributes are not comparable to
        # numeric literals (see memory: feedback_mockobject_attribute_trap.md).
        fake_cfg.compact_assist.auto_trigger_multiplier = 1.0
        fake_cfg.compact_assist.min_events = 0  # below floor → reaches manifest check

        fake_cache = self._make_fake_session_cache()
        with patch("token_goat.config.load", return_value=fake_cfg), \
             patch("token_goat.session.safe_load", return_value=fake_cache), \
             patch("token_goat.compact.build_manifest_with_count", return_value=("", 0)):

            payload = {"session_id": session_id, "trigger": "auto"}
            result = hooks_cli.pre_compact(payload)

        assert result.get("continue") is True

        sentinel = paths.compact_skip_sentinel_path(session_id)
        assert sentinel.exists(), (
            f"compact-skip sentinel not written after empty manifest; expected {sentinel}"
        )

    def test_sentinel_not_written_when_manifest_emitted(self, tmp_data_dir):
        """pre_compact does NOT write sentinel when a real manifest is injected."""
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_cli, paths

        session_id = "sentinel_session_real_manifest"

        fake_cfg = MagicMock()
        fake_cfg.compact_assist.enabled = True
        fake_cfg.compact_assist.triggers = ["auto"]
        fake_cfg.compact_assist.max_manifest_tokens = 400
        # Explicit float — MagicMock auto-vivified attributes are not comparable to
        # numeric literals (see memory: feedback_mockobject_attribute_trap.md).
        fake_cfg.compact_assist.auto_trigger_multiplier = 1.0
        fake_cfg.compact_assist.min_events = 0

        real_manifest = "## Manifest\n- src/foo.py\n"

        fake_cache = self._make_fake_session_cache()
        with patch("token_goat.config.load", return_value=fake_cfg), \
             patch("token_goat.session.safe_load", return_value=fake_cache), \
             patch("token_goat.compact.build_manifest_with_count", return_value=(real_manifest, 10)):

            payload = {"session_id": session_id, "trigger": "auto"}
            result = hooks_cli.pre_compact(payload)

        assert result.get("continue") is True
        assert result.get("systemMessage") == real_manifest

        sentinel = paths.compact_skip_sentinel_path(session_id)
        assert not sentinel.exists(), (
            "compact-skip sentinel must NOT be written when a real manifest is injected"
        )


class TestRecoveryHintPytestCollapse:
    """_build_recovery_hint collapses green pytest entries when edits are present."""

    # Shared output_id template — short enough for short_output_id to produce
    # a compact suffix, real enough to survive _RECOVERY_MIN_BYTES filtering.
    _OUTPUT_BYTES = 1000  # above _RECOVERY_MIN_BYTES (400)

    def _make_bash_entry(
        self,
        sid: str,
        cmd_preview: str,
        exit_code: int,
        output_id: str | None = None,
    ) -> None:
        """Seed a BashEntry into the session via mark_bash_run."""
        oid = output_id or f"{sid[:16]}-0000000000001-abc123def45678"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="abc123def4567890",
            cmd_preview=cmd_preview,
            output_id=oid,
            stdout_bytes=self._OUTPUT_BYTES,
            stderr_bytes=0,
            exit_code=exit_code,
            truncated=False,
        )

    def test_green_pytest_with_edits_collapses(self, tmp_data_dir):
        """Green pytest + edited file → collapsed '✓ pytest passed @ HH:MM' line."""
        from token_goat import hooks_session

        sid = "pytest-collapse-1"
        self._make_bash_entry(sid, "pytest tests/", exit_code=0)
        session.mark_file_edited(sid, "/proj/src/foo.py")

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "✓ pytest passed @" in hint, f"Expected collapsed line:\n{hint}"
        assert "token-goat bash-output" in hint, f"Recall pointer missing:\n{hint}"
        # Must NOT show the raw cmd_preview in the collapsed form
        assert "`pytest tests/`" not in hint, f"Raw cmd_preview leaked into collapsed line:\n{hint}"

    def test_green_pytest_no_edits_full_pointer(self, tmp_data_dir):
        """Green pytest but NO edited files → full pointer (not collapsed)."""
        from token_goat import hooks_session

        sid = "pytest-collapse-2"
        self._make_bash_entry(sid, "pytest tests/", exit_code=0)
        # No mark_file_edited call — edited_files stays empty.

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "✓ pytest passed @" not in hint, f"Should not collapse without edits:\n{hint}"
        assert "`pytest tests/`" in hint, f"Full pointer missing:\n{hint}"

    def test_red_pytest_with_edits_full_pointer(self, tmp_data_dir):
        """Failed pytest (exit_code=1) + edits → full pointer, not collapsed."""
        from token_goat import hooks_session

        sid = "pytest-collapse-3"
        self._make_bash_entry(sid, "pytest tests/", exit_code=1)
        session.mark_file_edited(sid, "/proj/src/foo.py")

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "✓ pytest passed @" not in hint, f"Collapsed a failing pytest:\n{hint}"
        assert "`pytest tests/`" in hint, f"Full pointer missing:\n{hint}"

    def test_non_pytest_with_edits_full_pointer(self, tmp_data_dir):
        """Non-pytest bash command + edits → always full pointer."""
        from token_goat import hooks_session

        sid = "pytest-collapse-4"
        self._make_bash_entry(sid, "npm run build", exit_code=0)
        session.mark_file_edited(sid, "/proj/src/foo.py")

        hint = hooks_session._build_recovery_hint(sid)
        assert hint is not None
        assert "✓ pytest passed @" not in hint, f"Collapsed a non-pytest command:\n{hint}"
        assert "`npm run build`" in hint, f"Full pointer missing:\n{hint}"

    def test_all_three_prefix_variants_collapse(self, tmp_data_dir):
        """All three pytest prefix variants collapse when green + edits present."""

        from token_goat import hooks_session

        prefixes = [
            "pytest tests/",
            "uv run pytest tests/",
            "python -m pytest tests/",
        ]
        for i, prefix in enumerate(prefixes):
            sid = f"pytest-collapse-prefix-{i}"
            # Use distinct output_ids so mark_bash_run doesn't overwrite via same sha key.
            oid = f"{sid[:16]}-000000000000{i+1}-abc123def45678{i}"
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=f"sha{i:016d}",
                cmd_preview=prefix,
                output_id=oid,
                stdout_bytes=self._OUTPUT_BYTES,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )
            session.mark_file_edited(sid, "/proj/src/foo.py")

            hint = hooks_session._build_recovery_hint(sid)
            assert hint is not None, f"No hint for prefix {prefix!r}"
            assert "✓ pytest passed @" in hint, (
                f"Prefix {prefix!r} not collapsed:\n{hint}"
            )
