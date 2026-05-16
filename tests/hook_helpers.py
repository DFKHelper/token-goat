"""Shared hook-response assertion helpers for all hook test modules.

Kept in a separate importable module (not conftest.py) because pytest's conftest
is injected into the session but is not importable as ``from conftest import …``
on all Python/pytest configurations.

Usage::

    from hook_helpers import assert_continue, assert_deny, run_hook_subprocess
"""
from __future__ import annotations

import json
import subprocess
import sys


def run_hook_subprocess(event: str, payload: dict, *, timeout: int = 30) -> dict:
    """Run ``token-goat hook <event>`` as a subprocess, returning the parsed JSON response.

    Sends *payload* as JSON on stdin and asserts the process exits 0.  Shared
    by ``test_cli_hook_smoke.py`` and ``TestPreReadCli`` so the subprocess
    invocation is not copy-pasted across test modules.

    Args:
        event:   Hook event name, e.g. ``"pre-read"`` or ``"session-start"``.
        payload: Dict that will be JSON-encoded and sent on stdin.
        timeout: Subprocess timeout in seconds (default 30).

    Returns:
        Parsed JSON dict from stdout.

    Raises:
        AssertionError: If the subprocess exits non-zero.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "token_goat.cli", "hook", event],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert proc.returncode == 0, f"hook {event!r} subprocess failed:\nSTDERR: {proc.stderr}"
    return json.loads(proc.stdout)


def assert_continue(result: dict) -> None:
    """Assert ``continue: True``, tolerating extra diagnostic fields from dispatch.

    Centralised here so the identical one-liner does not have to be copy-pasted
    into every hook test module.
    """
    assert result.get("continue") is True


def assert_deny(result: dict) -> None:
    """Assert that a hook response carries a ``permissionDecision: deny`` payload.

    Checks both the outer ``continue: True`` (fail-soft contract) and the inner
    ``hookSpecificOutput.permissionDecision`` field so callers do not need to
    repeat the two-step pattern.
    """
    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput", {})
    assert hso.get("permissionDecision") == "deny"
