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
    # normalize_payload stamps _tg_harness; check original keys are preserved
    assert result.get("session_id") == "abc"
    assert result.get("tool_name") == "Bash"
    assert result.get("_tg_harness") == "codex"


def test_normalize_payload_claude():
    payload = {"session_id": "abc", "tool_name": "Read"}
    result = hooks_cli.normalize_payload(payload, harness="claude")
    # normalize_payload stamps _tg_harness; check original keys are preserved
    assert result.get("session_id") == "abc"
    assert result.get("tool_name") == "Read"
    assert result.get("_tg_harness") == "claude"


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


# ---------------------------------------------------------------------------
# 9. denormalize_response: nested dict inside hookSpecificOutput is recursively
#    translated (item 1 — recursive _translate_hso_to_codex)
# ---------------------------------------------------------------------------


def test_denormalize_nested_dict_in_hso():
    """Nested dicts inside hookSpecificOutput must also have camelCase keys translated."""
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "additionalContext": "outer hint",
            "updatedInput": {
                "filePath": "/tmp/img.png",
                "hookEventName": "nested-event",
                "nestedDict": {
                    "permissionDecision": "allow",
                },
            },
        },
    }
    result = hooks_cli.denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    # Top-level translation
    assert "additional_context" in hso
    assert "additionalContext" not in hso
    # First-level nested dict
    updated = hso["updated_input"]
    assert isinstance(updated, dict)
    assert "hook_event_name" in updated, "nested camelCase key not translated"
    assert "hookEventName" not in updated
    # Second-level nested dict
    nested = updated["nestedDict"]
    assert isinstance(nested, dict)
    assert "permission_decision" in nested, "doubly-nested camelCase key not translated"
    assert "permissionDecision" not in nested


def test_denormalize_nested_dict_non_mapped_keys_preserved():
    """Keys not in the camelCase map must be preserved unchanged, even nested."""
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "customField": "value",
            "innerData": {
                "myCustomKey": 42,
                "additionalContext": "nested hint",
            },
        },
    }
    result = hooks_cli.denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    # Non-mapped top-level key preserved as-is
    assert hso.get("customField") == "value"
    inner = hso.get("innerData")
    assert isinstance(inner, dict)
    # Non-mapped key inside nested dict preserved
    assert inner.get("myCustomKey") == 42
    # Mapped key inside nested dict translated
    assert "additional_context" in inner
    assert "additionalContext" not in inner


# ---------------------------------------------------------------------------
# 10. normalize_payload: Codex tool name → PascalCase internal name
# ---------------------------------------------------------------------------


def test_normalize_payload_codex_bash():
    payload = {"tool_name": "bash", "tool_input": {"command": "echo hi"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Bash"
    assert result["tool_input"] == {"command": "echo hi"}


def test_normalize_payload_codex_edit_file():
    payload = {"tool_name": "edit_file", "tool_input": {"file_path": "/src/a.py"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Edit"


def test_normalize_payload_codex_edit_alias():
    """Short alias 'edit' must also map to 'Edit'."""
    payload = {"tool_name": "edit", "tool_input": {"file_path": "/src/a.py"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Edit"


def test_normalize_payload_codex_write_file():
    payload = {"tool_name": "write_file", "tool_input": {"file_path": "/out/b.py", "content": "x=1"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Write"
    # tool_input keys are not remapped for Codex — preserved as-is.
    assert result["tool_input"]["file_path"] == "/out/b.py"


def test_normalize_payload_codex_search_files():
    payload = {"tool_name": "search_files", "tool_input": {"pattern": "import os"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Grep"


def test_normalize_payload_codex_grep_alias():
    """Short alias 'grep' must also map to 'Grep'."""
    payload = {"tool_name": "grep", "tool_input": {"pattern": "TODO"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Grep"


def test_normalize_payload_codex_list_files():
    payload = {"tool_name": "list_files", "tool_input": {"path": "/src"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Glob"


def test_normalize_payload_codex_glob_alias():
    """Short alias 'glob' must also map to 'Glob'."""
    payload = {"tool_name": "glob", "tool_input": {"pattern": "**/*.ts"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Glob"


def test_normalize_payload_codex_web_search():
    payload = {"tool_name": "web_search", "tool_input": {"query": "python asyncio"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "WebFetch"


def test_normalize_payload_codex_unknown_tool_passes_through():
    """An unrecognised Codex tool name must pass through without crashing."""
    payload = {"tool_name": "some_future_tool", "tool_input": {"x": 1}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "some_future_tool"
    assert result["tool_input"] == {"x": 1}


def test_normalize_payload_codex_already_pascal_read_passes_through():
    """PascalCase tool names not in the Codex map pass through unchanged (e.g. 'Read')."""
    payload = {"tool_name": "Read", "tool_input": {"file_path": "/x.py"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Read"


def test_normalize_payload_codex_preserves_other_fields():
    """All non-tool_name fields must be preserved after remapping."""
    payload = {
        "tool_name": "bash",
        "session_id": "sess-1",
        "cwd": "/projects/foo",
        "tool_input": {"command": "ls -la"},
    }
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Bash"
    assert result["session_id"] == "sess-1"
    assert result["cwd"] == "/projects/foo"
    assert result["tool_input"] == {"command": "ls -la"}


# ---------------------------------------------------------------------------
# 11. normalize_payload: Gemini functionCallId → toolUseId normalisation
# ---------------------------------------------------------------------------


def test_normalize_payload_gemini_function_call_id_remapped():
    """Gemini's functionCallId must be remapped to toolUseId."""
    payload = {
        "tool_name": "run_shell_command",
        "functionCallId": "fc-abc-123",
        "tool_input": {"command": "ls"},
    }
    result = hooks_cli.normalize_payload(payload, harness="gemini")
    assert "toolUseId" in result
    assert result["toolUseId"] == "fc-abc-123"
    assert "functionCallId" not in result


def test_normalize_payload_gemini_tool_use_id_not_overwritten():
    """If both functionCallId and toolUseId are present, toolUseId must be kept."""
    payload = {
        "tool_name": "run_shell_command",
        "functionCallId": "fc-old",
        "toolUseId": "tu-preferred",
        "tool_input": {"command": "ls"},
    }
    result = hooks_cli.normalize_payload(payload, harness="gemini")
    assert result["toolUseId"] == "tu-preferred"
    # functionCallId may or may not be present — we only care that toolUseId was not changed.


def test_normalize_payload_gemini_no_function_call_id_unchanged():
    """Payloads without functionCallId must not gain a toolUseId key."""
    payload = {"tool_name": "run_shell_command", "tool_input": {"command": "ls"}}
    result = hooks_cli.normalize_payload(payload, harness="gemini")
    assert "toolUseId" not in result
    assert "functionCallId" not in result


def test_normalize_payload_gemini_function_call_id_with_unknown_tool():
    """functionCallId is remapped even when the tool name is not in the Gemini map."""
    payload = {
        "tool_name": "some_future_tool",
        "functionCallId": "fc-xyz",
        "tool_input": {},
    }
    result = hooks_cli.normalize_payload(payload, harness="gemini")
    assert result["toolUseId"] == "fc-xyz"
    assert "functionCallId" not in result
