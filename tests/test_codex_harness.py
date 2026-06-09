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
# 1. denormalize_response: Codex path preserves camelCase keys unchanged
# ---------------------------------------------------------------------------


def test_denormalize_codex_preserves_camel_case():
    # Codex 0.137.0+ uses camelCase in hookSpecificOutput — keys must not be converted.
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
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["additionalContext"] == "some hint"
    assert hso["updatedInput"] == {"file_path": "/tmp/x.png"}
    assert hso["permissionDecision"] == "allow"
    assert hso["permissionDecisionReason"] == "fine"
    # No snake_case conversion must have occurred
    assert "additional_context" not in hso
    assert "updated_input" not in hso
    assert "permission_decision" not in hso


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
# 3. denormalize_response with no hookSpecificOutput → _tg_* keys stripped, continue preserved
# ---------------------------------------------------------------------------


def test_denormalize_no_hso():
    response = {"continue": True, "_tg_elapsed_ms": 12, "_tg_handler": "pre_read"}
    result = hooks_cli.denormalize_response(response, harness="codex")
    _assert_continue(result)
    assert "_tg_elapsed_ms" not in result
    assert "_tg_handler" not in result


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
# 7. CLI subprocess: --harness=codex strips _tg_* keys and returns continue:True
# ---------------------------------------------------------------------------


def test_cli_pre_read_codex_no_tg_keys(tmp_path):
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
    assert not any(k.startswith("_tg_") for k in data), f"_tg_* key leaked into Codex output: {list(data)}"


# ---------------------------------------------------------------------------
# 8. CLI subprocess: --harness=codex image read preserves camelCase + injects hookEventName
# ---------------------------------------------------------------------------


def test_cli_pre_read_codex_image_camel_case(tmp_path):
    test_img = tmp_path / "big.png"
    test_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (110 * 1024))

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
    assert not any(k.startswith("_tg_") for k in data), f"_tg_* key leaked: {list(data)}"
    hso = data.get("hookSpecificOutput")
    if hso:
        # camelCase must be preserved; snake_case must not appear
        assert "updatedInput" in hso or "additionalContext" in hso or "hookEventName" in hso
        assert "updated_input" not in hso
        assert "additional_context" not in hso


# ---------------------------------------------------------------------------
# 9. denormalize_response: all camelCase keys inside hookSpecificOutput are preserved
# ---------------------------------------------------------------------------


def test_denormalize_nested_dict_in_hso():
    # Codex 0.137.0+ uses camelCase — no translation at any nesting level.
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "additionalContext": "outer hint",
            "updatedInput": {
                "filePath": "/tmp/img.png",
                "hookEventName": "nested-event",
                "nestedDict": {"permissionDecision": "allow"},
            },
        },
    }
    result = hooks_cli.denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["additionalContext"] == "outer hint"
    assert "additional_context" not in hso
    updated = hso["updatedInput"]
    assert isinstance(updated, dict)
    assert updated["filePath"] == "/tmp/img.png"
    assert updated["hookEventName"] == "nested-event"
    assert "hook_event_name" not in updated
    nested = updated["nestedDict"]
    assert nested["permissionDecision"] == "allow"
    assert "permission_decision" not in nested


def test_denormalize_nested_dict_non_mapped_keys_preserved():
    # All keys (known or unknown) must pass through unchanged for Codex.
    response = {
        "continue": True,
        "hookSpecificOutput": {
            "customField": "value",
            "innerData": {"myCustomKey": 42, "additionalContext": "nested hint"},
        },
    }
    result = hooks_cli.denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["customField"] == "value"
    inner = hso["innerData"]
    assert inner["myCustomKey"] == 42
    assert inner["additionalContext"] == "nested hint"
    assert "additional_context" not in inner


# ---------------------------------------------------------------------------
# 10. denormalize_response: _tg_* diagnostic keys stripped for Codex
# ---------------------------------------------------------------------------


def test_denormalize_codex_strips_tg_diagnostic_keys():
    # _tg_elapsed_ms/_tg_handler are added by dispatch(); all Codex schemas have
    # additionalProperties:false so any unknown key causes "hook returned invalid JSON output".
    response = {
        "continue": True,
        "_tg_elapsed_ms": 42,
        "_tg_handler": "pre_read",
        "_tg_error": None,
        "hookSpecificOutput": {"additionalContext": "hint"},
    }
    result = hooks_cli.denormalize_response(response, harness="codex", event="pre-read")
    assert result["continue"] is True
    assert "_tg_elapsed_ms" not in result
    assert "_tg_handler" not in result
    assert "_tg_error" not in result


# ---------------------------------------------------------------------------
# 11. denormalize_response: hookEventName injected when absent
# ---------------------------------------------------------------------------


def test_denormalize_codex_injects_hook_event_name():
    # Codex requires hookEventName as a const field in every hookSpecificOutput shape.
    response = {"continue": True, "hookSpecificOutput": {"additionalContext": "hint"}}
    result = hooks_cli.denormalize_response(response, harness="codex", event="pre-read")
    hso = result["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["additionalContext"] == "hint"


def test_denormalize_codex_hook_event_name_not_overwritten():
    # If hookEventName is already present, do not overwrite it.
    response = {"continue": True, "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "x"}}
    result = hooks_cli.denormalize_response(response, harness="codex", event="pre-read")
    assert result["hookSpecificOutput"]["hookEventName"] == "SessionStart"


def test_denormalize_codex_session_start_event_name():
    response = {"continue": True, "hookSpecificOutput": {"additionalContext": "brief"}}
    result = hooks_cli.denormalize_response(response, harness="codex", event="session-start")
    assert result["hookSpecificOutput"]["hookEventName"] == "SessionStart"


def test_denormalize_codex_unknown_event_no_injection():
    # Unknown event → hookEventName must NOT be injected (would be wrong value).
    response = {"continue": True, "hookSpecificOutput": {"additionalContext": "x"}}
    result = hooks_cli.denormalize_response(response, harness="codex", event="unknown-event-xyz")
    assert "hookEventName" not in result["hookSpecificOutput"]


# ---------------------------------------------------------------------------
# 12. normalize_payload: Codex tool name → PascalCase internal name
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


def test_normalize_payload_codex_unknown_tool_logs_warning(caplog):
    """An unrecognised Codex tool name (not a known PascalCase name) must log at WARNING."""
    import logging

    payload = {"tool_name": "some_future_codex_tool", "tool_input": {"x": 1}}
    with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
        hooks_cli.normalize_payload(payload, harness="codex")
    assert any(
        "some_future_codex_tool" in r.message and r.levelno >= logging.WARNING
        for r in caplog.records
    ), "expected WARNING log for unknown Codex tool"


def test_normalize_payload_codex_already_pascal_read_passes_through():
    """PascalCase tool names not in the Codex map pass through unchanged (e.g. 'Read')."""
    payload = {"tool_name": "Read", "tool_input": {"file_path": "/x.py"}}
    result = hooks_cli.normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Read"


def test_normalize_payload_codex_known_pascal_tool_no_warning(caplog):
    """A known PascalCase tool passed by Codex must NOT trigger a WARNING — only DEBUG."""
    import logging

    payload = {"tool_name": "Read", "tool_input": {"file_path": "/x.py"}}
    with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
        hooks_cli.normalize_payload(payload, harness="codex")
    assert not any(
        "Read" in r.message and r.levelno >= logging.WARNING
        for r in caplog.records
    ), "known PascalCase tool must not produce a WARNING"


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
