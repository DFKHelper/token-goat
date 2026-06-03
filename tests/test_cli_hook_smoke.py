"""Smoke tests: invoke the CLI hook subcommands via subprocess to verify the full stdin/stdout path."""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from hook_helpers import run_hook_subprocess as _run_hook

pytestmark = pytest.mark.slow

PROJECT_ROOT = Path(__file__).parent.parent


def test_hook_session_start_smoke(tmp_path):
    (tmp_path / ".git").mkdir()
    result = _run_hook("session-start", {"session_id": "smoke", "cwd": str(tmp_path)})
    assert result.get("continue") is True


def test_hook_pre_read_smoke():
    result = _run_hook("pre-read", {"session_id": "s", "tool_name": "Read", "tool_input": {"file_path": "x"}})
    assert result.get("continue") is True


def test_hook_garbage_input_returns_continue(tmp_path):
    """Even if stdin is malformed JSON, the CLI must not crash."""
    result = subprocess.run(
        [sys.executable, "-m", "token_goat", "hook", "session-start"],
        input="not valid json {{",
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        timeout=30,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed.get("continue") is True
