"""Smoke tests for `tokenwise doctor`."""
from __future__ import annotations

import subprocess
import sys


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
