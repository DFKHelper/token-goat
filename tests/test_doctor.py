"""Smoke tests for `tokenwise doctor`."""
from __future__ import annotations

import os
import subprocess
import sys
import time

from typer.testing import CliRunner

from tokenwise import cli, paths

runner = CliRunner()


def test_doctor_exits_zero_and_prints_sections():
    result = subprocess.run(
        [sys.executable, "-m", "tokenwise.cli", "doctor"],
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
        ["uv", "run", "tokenwise", "doctor"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd="C:/Projects/tokenwise",
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "tokenwise doctor" in result.stdout


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
