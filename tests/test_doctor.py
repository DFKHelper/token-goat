"""Smoke tests for `token-goat doctor`."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from typer.testing import CliRunner

from token_goat import cli, paths

runner = CliRunner()


def test_doctor_exits_zero_and_prints_sections():
    result = subprocess.run(
        [sys.executable, "-m", "token_goat.cli", "doctor"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    out = result.stdout
    assert "Python:" in out
    assert "SQLite" in out
    assert "Project" in out
    # Worker self-heal + queue diagnostics added alongside the watchdog work.
    assert "claim file" in out
    assert "index marker" in out  # "index markers: none" or per-marker "index marker:"
    assert "Dirty queue" in out


def test_doctor_via_entry_point():
    """Run via the installed entry point (uv tool run)."""
    result = subprocess.run(
        ["uv", "run", "token-goat", "doctor"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(Path(__file__).parent.parent),
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "token-goat doctor" in result.stdout


def test_doctor_fix_reaps_stale_index_markers(tmp_data_dir):
    """`doctor --fix` clears stale `.indexing` markers but spares active ones.

    This is the on-demand counterpart to the worker's startup reaping — it
    closes the gap that left 16 stale markers on disk with nothing to clear
    them while the worker was down.
    """
    paths.ensure_dirs()
    locks = paths.locks_dir()
    stale = locks / "stalehash.indexing"
    stale.write_text(f"999999999\n{time.time()}", encoding="utf-8")
    active = locks / "activehash.indexing"
    active.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    result = runner.invoke(cli.app, ["doctor", "--fix"])
    assert result.exit_code == 0, result.stdout
    assert "reaped" in result.stdout
    assert not stale.exists(), "stale marker should have been reaped"
    assert active.exists(), "an active index marker must not be reaped"


def test_doctor_without_fix_leaves_markers_untouched(tmp_data_dir):
    """Plain `doctor` only reports — it must not delete any markers."""
    paths.ensure_dirs()
    stale = paths.locks_dir() / "stalehash.indexing"
    stale.write_text(f"999999999\n{time.time()}", encoding="utf-8")

    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0, result.stdout
    assert "reaped" not in result.stdout
    assert stale.exists(), "doctor without --fix must not delete markers"


# ---------------------------------------------------------------------------
# Branch coverage for individual doctor checks (using CliRunner + mocks)
# ---------------------------------------------------------------------------


class TestDoctorBranches:
    """Cover specific error/warn branches that the subprocess smoke tests miss."""

    def _run(self, monkeypatch_fn=None, extra_args=None):
        args = ["doctor"] + (extra_args or [])
        return runner.invoke(cli.app, args)

    def test_token_goat_version_unknown_on_import_error(self, tmp_data_dir):
        """When the package metadata isn't found, version is shown as 'unknown'."""
        import importlib.metadata
        from unittest.mock import patch
        with patch.object(
            importlib.metadata,
            "version",
            side_effect=importlib.metadata.PackageNotFoundError("token-goat"),
        ):
            result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "unknown" in result.stdout

    def test_uv_not_found_shown_as_warn(self, tmp_data_dir):
        """When uv is not on PATH, doctor shows a WARN for it."""
        import subprocess as sp
        from unittest.mock import patch
        with patch.object(sp, "run", side_effect=FileNotFoundError("uv not found")):
            result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "[WARN]" in result.stdout or "WARN" in result.stdout

    def test_pid_alive_fresh_heartbeat(self, tmp_data_dir):
        """PID exists and heartbeat is fresh → ok lines for both."""

        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        paths.worker_heartbeat_path().write_text("x", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert str(pid) in result.stdout

    def test_pid_alive_stale_heartbeat(self, tmp_data_dir):
        """PID exists but heartbeat is old → WARN stale."""
        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        hb = paths.worker_heartbeat_path()
        hb.write_text("x", encoding="utf-8")
        os.utime(hb, (0.0, 0.0))  # epoch → ancient

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "stale" in result.stdout

    def test_pid_alive_missing_heartbeat(self, tmp_data_dir):
        """PID exists but no heartbeat file → WARN missing."""
        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        # No heartbeat file written

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "missing" in result.stdout or "heartbeat" in result.stdout.lower()

    def test_dead_pid_shown_as_warn(self, tmp_data_dir):
        """PID file present but process is gone → WARN."""
        paths.ensure_dirs()
        paths.worker_pid_path().write_text("99999999", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "99999999" in result.stdout

    def test_dirty_queue_empty_file(self, tmp_data_dir):
        """Queue file exists but has no non-blank lines → depth 0."""
        paths.ensure_dirs()
        paths.dirty_queue_path().write_text("   \n\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "0" in result.stdout

    def test_dirty_queue_moderate_depth(self, tmp_data_dir):
        """Queue with < 200 entries shows depth + 'pending' message."""
        paths.ensure_dirs()
        import json as _json
        lines = "\n".join(_json.dumps({"path": f"f{i}.py"}) for i in range(10))
        paths.dirty_queue_path().write_text(lines + "\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "pending" in result.stdout

    def test_dirty_queue_large_depth_warns(self, tmp_data_dir):
        """Queue with >= 200 entries triggers a WARN."""
        paths.ensure_dirs()
        import json as _json
        lines = "\n".join(_json.dumps({"path": f"f{i}.py"}) for i in range(250))
        paths.dirty_queue_path().write_text(lines + "\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "250" in result.stdout

    def test_stats_contention_events_shown(self, tmp_data_dir):
        """When session-cache contention events exist, doctor flags them."""
        import time as _time

        from token_goat import db as _db

        paths.ensure_dirs()
        with _db.open_global() as conn:
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (int(_time.time()), "session_cache_unavailable", 0, 0),
            )

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "contention" in result.stdout

    def test_stats_no_events(self, tmp_data_dir):
        """When stats table is empty, doctor shows 'no recorded savings yet'."""
        paths.ensure_dirs()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "no recorded savings yet" in result.stdout

    def test_project_db_file_count_zero_shows_not_yet_indexed(self, tmp_data_dir, tmp_path):
        """Project found but file_count == 0 → '(not yet indexed)' label."""
        (tmp_path / ".git").mkdir()
        import os as _os
        orig_cwd = _os.getcwd()
        try:
            _os.chdir(tmp_path)
            result = runner.invoke(cli.app, ["doctor"])
        finally:
            _os.chdir(orig_cwd)

        assert result.exit_code == 0
        assert "not yet indexed" in result.stdout

    def test_claim_file_stale_warns(self, tmp_data_dir):
        """Stale claim file (dead PID) shows a WARN."""
        from token_goat import worker as _worker
        paths.ensure_dirs()
        claim = _worker._worker_claim_path()
        claim.write_text("99999999\n0.0", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "stale" in result.stdout

    def test_claim_file_live_pid_shown(self, tmp_data_dir):
        """Live-PID claim file shows the PID in the output."""
        from token_goat import worker as _worker
        paths.ensure_dirs()
        claim = _worker._worker_claim_path()
        pid = os.getpid()
        # Claim file format: "pid\ncreate_time" — use actual process creation
        # time so _worker_claim_is_stale does not flag this as recycled.
        try:
            import psutil
            create_time = psutil.Process(pid).create_time()
        except Exception:
            create_time = 0.0
        claim.write_text(f"{pid}\n{create_time}", encoding="utf-8")

        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert str(pid) in result.stdout
