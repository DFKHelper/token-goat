"""Smoke tests for `cc-saver doctor`."""
from __future__ import annotations

import subprocess
import sys


def test_doctor_exits_zero_and_prints_sections():
    result = subprocess.run(
        [sys.executable, "-m", "cc_saver.cli", "doctor"],
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


def test_doctor_via_entry_point():
    """Run via the installed entry point (uv tool run)."""
    result = subprocess.run(
        ["uv", "run", "cc-saver", "doctor"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd="C:/Projects/cc-saver",
    )
    assert result.returncode == 0, (
        f"doctor exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "cc-saver doctor" in result.stdout
