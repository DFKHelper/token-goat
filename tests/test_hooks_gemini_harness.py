"""Tests for Gemini CLI harness payload normalisation and response denormalisation."""

from token_goat.hooks_cli import denormalize_response, normalize_payload

# ---------------------------------------------------------------------------
# normalize_payload — Gemini harness
# ---------------------------------------------------------------------------


def test_normalize_run_shell_command_maps_to_bash():
    payload = {"tool_name": "run_shell_command", "tool_input": {"command": "ls -la"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Bash"
    # Input key 'command' has no remapping for Bash — preserved as-is.
    assert result["tool_input"] == {"command": "ls -la"}


def test_normalize_read_file_maps_path_to_file_path():
    payload = {"tool_name": "read_file", "tool_input": {"path": "/src/foo.py"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Read"
    assert result["tool_input"] == {"file_path": "/src/foo.py"}


def test_normalize_write_file_maps_path_and_preserves_content():
    payload = {
        "tool_name": "write_file",
        "tool_input": {"path": "/out/bar.py", "content": "x = 1\n"},
    }
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Write"
    assert result["tool_input"] == {"file_path": "/out/bar.py", "content": "x = 1\n"}


def test_normalize_replace_maps_all_keys():
    payload = {
        "tool_name": "replace",
        "tool_input": {"path": "/src/a.py", "old_str": "foo", "new_str": "bar"},
    }
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Edit"
    assert result["tool_input"] == {
        "file_path": "/src/a.py",
        "old_string": "foo",
        "new_string": "bar",
    }


def test_normalize_grep_search_maps_query_to_pattern():
    payload = {"tool_name": "grep_search", "tool_input": {"query": "import os"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Grep"
    assert result["tool_input"] == {"pattern": "import os"}


def test_normalize_search_file_content_also_maps_to_grep():
    payload = {"tool_name": "search_file_content", "tool_input": {"query": "TODO"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Grep"
    assert result["tool_input"] == {"pattern": "TODO"}


def test_normalize_web_search_maps_to_webfetch():
    payload = {"tool_name": "web_search", "tool_input": {"query": "python asyncio"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "WebFetch"
    # No key remapping for WebFetch — input preserved.
    assert result["tool_input"] == {"query": "python asyncio"}


def test_normalize_web_fetch_maps_to_webfetch():
    payload = {"tool_name": "web_fetch", "tool_input": {"url": "https://example.com"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "WebFetch"
    assert result["tool_input"] == {"url": "https://example.com"}


def test_normalize_read_many_files_maps_to_read():
    payload = {"tool_name": "read_many_files", "tool_input": {"paths": ["/a.py", "/b.py"]}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Read"


def test_normalize_list_directory_maps_to_read():
    payload = {"tool_name": "list_directory", "tool_input": {"path": "/src"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Read"


def test_normalize_glob_maps_to_glob():
    payload = {"tool_name": "glob", "tool_input": {"pattern": "**/*.py"}}
    result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "Glob"
    assert result["tool_input"] == {"pattern": "**/*.py"}


def test_normalize_unknown_gemini_tool_passes_through(caplog):
    """An unrecognised Gemini tool name should pass through without raising."""
    import logging

    payload = {"tool_name": "some_future_tool", "tool_input": {"x": 1}}
    with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
        result = normalize_payload(payload, harness="gemini")
    assert result["tool_name"] == "some_future_tool"
    assert result["tool_input"] == {"x": 1}


def test_normalize_non_dict_payload_returns_empty():
    result = normalize_payload("not a dict", harness="gemini")  # type: ignore[arg-type]
    assert result == {}


def test_normalize_empty_payload_returns_empty():
    result = normalize_payload({}, harness="gemini")
    assert result == {}


def test_normalize_missing_tool_name_returns_empty():
    result = normalize_payload({"tool_input": {}}, harness="gemini")
    assert result == {}


# ---------------------------------------------------------------------------
# denormalize_response — Gemini harness
# ---------------------------------------------------------------------------


def test_denormalize_continue_true_produces_allow():
    result = denormalize_response({"continue": True}, harness="gemini")
    assert result == {"decision": "allow"}


def test_denormalize_continue_false_produces_deny():
    result = denormalize_response({"continue": False}, harness="gemini")
    assert result == {"decision": "deny"}


def test_denormalize_missing_continue_defaults_to_allow():
    result = denormalize_response({}, harness="gemini")
    assert result["decision"] == "allow"


def test_denormalize_permission_decision_reason_propagated():
    response = {
        "continue": False,
        "hookSpecificOutput": {"permissionDecisionReason": "blocked by policy"},
    }
    result = denormalize_response(response, harness="gemini")
    assert result["decision"] == "deny"
    assert result["reason"] == "blocked by policy"


def test_denormalize_additional_context_propagated_as_reason():
    response = {
        "continue": True,
        "hookSpecificOutput": {"additionalContext": "hint text here"},
    }
    result = denormalize_response(response, harness="gemini")
    assert result["decision"] == "allow"
    assert result["reason"] == "hint text here"


def test_denormalize_permission_reason_takes_precedence_over_additional_context():
    response = {
        "continue": False,
        "hookSpecificOutput": {
            "permissionDecisionReason": "explicit deny",
            "additionalContext": "secondary note",
        },
    }
    result = denormalize_response(response, harness="gemini")
    assert result["reason"] == "explicit deny"


def test_denormalize_no_hso_no_reason_key():
    result = denormalize_response({"continue": True}, harness="gemini")
    assert "reason" not in result


def test_denormalize_diagnostic_fields_passed_through():
    response = {
        "continue": True,
        "_tg_elapsed_ms": 12.5,
        "_tg_handler": "pre_read",
        "_tg_error": "oops",
    }
    result = denormalize_response(response, harness="gemini")
    assert result["_tg_elapsed_ms"] == 12.5
    assert result["_tg_handler"] == "pre_read"
    assert result["_tg_error"] == "oops"


def test_denormalize_continue_field_not_in_gemini_output():
    """The internal 'continue' key should not bleed through to the Gemini wire format."""
    result = denormalize_response({"continue": True, "_tg_elapsed_ms": 1.0}, harness="gemini")
    assert "continue" not in result


# ---------------------------------------------------------------------------
# Regression: claude and codex harnesses unchanged
# ---------------------------------------------------------------------------


def test_claude_harness_passthrough():
    """Claude harness must return the response unchanged."""
    response = {"continue": True, "hookSpecificOutput": {"additionalContext": "hello"}}
    result = denormalize_response(response, harness="claude")
    assert result is response


def test_codex_harness_translates_hso_keys():
    """Codex harness must translate camelCase hookSpecificOutput keys to snake_case."""
    response = {
        "continue": True,
        "hookSpecificOutput": {"additionalContext": "ctx", "permissionDecision": "allow"},
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert "additional_context" in hso
    assert "permission_decision" in hso
    assert "additionalContext" not in hso


def test_codex_harness_no_hso_passthrough():
    response = {"continue": True}
    result = denormalize_response(response, harness="codex")
    assert result == {"continue": True}


def test_claude_normalize_no_transformation():
    """Claude harness normalize_payload must return the payload unchanged."""
    payload = {"tool_name": "Read", "tool_input": {"file_path": "/src/x.py"}}
    result = normalize_payload(payload, harness="claude")
    assert result is payload


def test_codex_normalize_bash_maps_to_pascal():
    """Codex harness normalize_payload must remap 'bash' → 'Bash'."""
    payload = {"tool_name": "bash", "tool_input": {"command": "echo hi"}}
    result = normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Bash"
    assert result["tool_input"] == {"command": "echo hi"}
