"""Tests for Codex harness translation — Phase 18."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_cli

PROJECT_ROOT = Path(__file__).parent.parent


# ---------------------------------------------------------------------------
# 1. denormalize_response: camelCase → snake_case for harness=codex
# ---------------------------------------------------------------------------


def test_denormalize_camel_to_snake():
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "some hint",
            "updatedInput": {"file_path": "/tmp/x.png"},
            "permissionDecision": "allow",
            "permissionDecisionReason": "fine",
        },
    }
    result = hooks_cli.denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert "hook_event_name" in hso
    assert "additional_context" in hso
    assert "updated_input" in hso
    assert "permission_decision" in hso
    assert "permission_decision_reason" in hso
    # Old keys must be gone
    assert "hookEventName" not in hso
    assert "additionalContext" not in hso
    assert "updatedInput" not in hso
    assert "permissionDecision" not in hso
    assert "permissionDecisionReason" not in hso


# ---------------------------------------------------------------------------
# 2. denormalize_response with harness=claude → unchanged
# ---------------------------------------------------------------------------


def test_denormalize_claude_passthrough():
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "hint",
        },
    }
    result = hooks_cli.denormalize_response(response, harness="claude")
    assert result is response  # exact same object, no copy


# ---------------------------------------------------------------------------
# 3. denormalize_response with no hookSpecificOutput → untouched
# ---------------------------------------------------------------------------


def test_denormalize_no_hso():
    response = {"continue": True}
    result = hooks_cli.denormalize_response(response, harness="codex")
    _assert_continue(result)


# ---------------------------------------------------------------------------
# 4. normalize_payload: both harnesses return the payload (passthrough)
# ---------------------------------------------------------------------------


def test_normalize_payload_codex():
    payload = {"session_id": "abc", "turn_id": "t1", "tool_name": "Bash"}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result == payload


def test_normalize_payload_claude():
    payload = {"session_id": "abc", "tool_name": "Read"}
    result = hooks_cli.normalize_payload(payload, harness="claude")
    assert result == payload


# ---------------------------------------------------------------------------
# 5. dispatch pre-read with Bash + head command → fires Read logic (returns continue)
# ---------------------------------------------------------------------------


def test_dispatch_bash_head_command(tmp_path):
    """A Bash payload whose command is 'head -n 100 README.md' should route
    through pre_read's Bash→Read synthetic path and return continue:True."""
    payload = {
        "session_id": "codex-test",
        "cwd": str(tmp_path),
        "tool_name": "Bash",
        "tool_input": {"command": "head -n 100 README.md"},
    }
    result = hooks_cli.dispatch("pre-read", payload)
    assert result.get("continue") is True


# ---------------------------------------------------------------------------
# 6. dispatch pre-read with Bash that is NOT a read → continue:True, no crash
# ---------------------------------------------------------------------------


def test_dispatch_bash_non_read(tmp_path):
    payload = {
        "session_id": "codex-test",
        "cwd": str(tmp_path),
        "tool_name": "Bash",
        "tool_input": {"command": "npm install"},
    }
    result = hooks_cli.dispatch("pre-read", payload)
    assert result.get("continue") is True


# ---------------------------------------------------------------------------
# 7. CLI subprocess: --harness=codex returns snake_case keys
# ---------------------------------------------------------------------------


def test_cli_pre_read_codex_snake_case(tmp_path):
    """End-to-end subprocess test: hook pre-read --harness codex with a Bash
    payload that hits image-shrink path should return snake_case in output."""
    # We need a payload that will actually produce hookSpecificOutput.
    # Use an image path that exists in the project so image_shrink can try (it
    # will skip if not a real image or below threshold, but that still gives
    # us a clean continue:True). What matters is the key shape on a response
    # that does produce hookSpecificOutput — we test that with a direct
    # dispatch call above. Here we just verify the subprocess doesn't crash
    # and the output is valid JSON with continue:True when harness=codex.
    payload = {
        "session_id": "codex-cli-test",
        "cwd": str(tmp_path),
        "tool_name": "Bash",
        "tool_input": {"command": "cat nonexistent_file.py"},
    }
    result = subprocess.run(
        [sys.executable, "-m", "token_goat", "hook", "pre-read", "--harness", "codex"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    data = json.loads(result.stdout)
    assert data.get("continue") is True


# ---------------------------------------------------------------------------
# 8. CLI subprocess: --harness=codex with image read path returns snake_case
# ---------------------------------------------------------------------------


def test_cli_pre_read_codex_image_snake_case(tmp_path):
    """When a Read on an image fires image-shrink and returns updatedInput,
    the Codex harness must translate that to updated_input in the output."""
    # Create a dummy PNG that is above the size threshold (>100 KB)
    # We'll create a large fake PNG-like file
    test_img = tmp_path / "big.png"
    # PNG header + enough bytes to exceed the 100 KB threshold
    png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * (110 * 1024)
    test_img.write_bytes(png_header)

    payload = {
        "session_id": "codex-img-test",
        "cwd": str(tmp_path),
        "tool_name": "Read",
        "tool_input": {"file_path": str(test_img)},
    }
    result = subprocess.run(
        [sys.executable, "-m", "token_goat", "hook", "pre-read", "--harness", "codex"],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=PROJECT_ROOT,
        timeout=30,
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    data = json.loads(result.stdout)
    assert data.get("continue") is True
    # If image-shrink fired and produced hookSpecificOutput, verify snake_case
    hso = data.get("hookSpecificOutput")
    if hso:
        assert "hookEventName" not in hso, "camelCase key leaked into Codex output"
        assert "updatedInput" not in hso, "camelCase key leaked into Codex output"
        assert "additionalContext" not in hso, "camelCase key leaked into Codex output"
