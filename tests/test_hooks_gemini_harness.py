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


def test_normalize_unknown_gemini_tool_logs_warning(caplog):
    """An unrecognised Gemini tool name must log at WARNING so operators can see mapping gaps."""
    import logging

    payload = {"tool_name": "some_future_gemini_tool", "tool_input": {"x": 1}}
    with caplog.at_level(logging.WARNING, logger="token_goat.hooks"):
        normalize_payload(payload, harness="gemini")
    assert any(
        "some_future_gemini_tool" in r.message and r.levelno >= logging.WARNING
        for r in caplog.records
    ), "expected WARNING log for unknown Gemini tool"


def test_normalize_non_dict_payload_returns_empty():
    result = normalize_payload("not a dict", harness="gemini")  # type: ignore[arg-type]
    assert result == {}


def test_normalize_empty_payload_returns_empty():
    result = normalize_payload({}, harness="gemini")
    assert result == {}


def test_normalize_missing_tool_name_returns_empty():
    result = normalize_payload({"tool_input": {}}, harness="gemini")
    assert result == {}


def test_normalize_session_start_payload_emits_no_warning(caplog):
    """SessionStart (and other non-tool lifecycle events) carry no ``tool_name``.

    Regression: this path previously logged at WARNING, so a single session start
    fanning out across ~45 non-tool events spammed 45 identical warnings into the
    log.  The missing-``tool_name`` case is the *expected* shape for these events,
    so normalize_payload must stay silent at WARNING and degrade quietly.
    """
    import logging

    payload = {
        "session_id": "abc-123",
        "source": "startup",
        "cwd": "/some/project",
        "hook_event_name": "SessionStart",
    }
    with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
        result = normalize_payload(payload, harness="claude")
    # Return contract preserved: no tool_name → empty dict.
    assert result == {}
    warnings = [
        r for r in caplog.records if r.levelno >= logging.WARNING and "tool_name" in r.getMessage()
    ]
    assert len(warnings) == 0, (
        f"SessionStart payload must not emit tool_name WARNINGs, got: "
        f"{[r.getMessage() for r in warnings]!r}"
    )
    # The diagnostic is still available at DEBUG for operators chasing malformed payloads.
    assert any(
        "tool_name missing or invalid" in r.getMessage() and r.levelno == logging.DEBUG
        for r in caplog.records
    ), "expected the missing-tool_name diagnostic to remain available at DEBUG level"


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


def test_denormalize_additional_context_preserved_in_hook_specific_output():
    """additionalContext must ride Gemini's native injection channel, not ``reason``.

    Regression: token-goat previously flattened ``hookSpecificOutput.additionalContext``
    into the top-level ``reason`` field. Per the Gemini hooks contract, ``reason``
    is only surfaced on a *deny* (sent to the agent as a tool error); on an allow
    it is advisory and ignored. Context injection must therefore use the native
    ``hookSpecificOutput.additionalContext`` channel ("injected as the first turn"
    at SessionStart, "appended to the tool result" at AfterTool). The old mapping
    silently dropped every session-memory / post-read / skill hint on the allow
    path — which is where token-goat emits virtually all of them.
    """
    response = {
        "continue": True,
        "hookSpecificOutput": {"additionalContext": "hint text here"},
    }
    result = denormalize_response(response, harness="gemini")
    assert result["decision"] == "allow"
    # additionalContext lands in the native channel, NOT reason.
    assert result["hookSpecificOutput"]["additionalContext"] == "hint text here"
    assert "reason" not in result


def test_denormalize_top_level_system_message_preserved():
    """Gemini natively renders a top-level ``systemMessage`` — it must survive.

    Regression: the Gemini denormalize branch dropped the top-level
    ``systemMessage`` entirely, discarding token-goat's PreCompress compaction
    manifest and the SessionStart git-orientation brief for every Gemini user.
    """
    response = {"continue": True, "systemMessage": "## Compaction manifest\nedited: a.py"}
    result = denormalize_response(response, harness="gemini")
    assert result["systemMessage"] == "## Compaction manifest\nedited: a.py"
    assert result["decision"] == "allow"


def test_denormalize_session_start_both_channels_preserved():
    """A SessionStart-shaped response carries brief (systemMessage) + memory (additionalContext).

    Both must reach Gemini intact: the brief via the native top-level
    ``systemMessage`` and the project memory via ``hookSpecificOutput.additionalContext``.
    """
    response = {
        "continue": True,
        "systemMessage": "git brief: on branch main, 2 commits ahead",
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "project memory: ship dates are absolute",
        },
    }
    result = denormalize_response(response, harness="gemini")
    assert result["systemMessage"] == "git brief: on branch main, 2 commits ahead"
    assert (
        result["hookSpecificOutput"]["additionalContext"]
        == "project memory: ship dates are absolute"
    )


def test_denormalize_permission_reason_and_additional_context_both_preserved():
    """On a deny carrying both fields: reason → top-level, additionalContext → native channel.

    They no longer compete for ``reason`` — each rides its own Gemini field, so a
    deny can both block (reason) and inject context (additionalContext).
    """
    response = {
        "continue": False,
        "hookSpecificOutput": {
            "permissionDecisionReason": "explicit deny",
            "additionalContext": "secondary note",
        },
    }
    result = denormalize_response(response, harness="gemini")
    assert result["decision"] == "deny"
    assert result["reason"] == "explicit deny"
    assert result["hookSpecificOutput"]["additionalContext"] == "secondary note"


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
    # Codex 0.137.0+ uses camelCase — keys pass through unchanged.
    response = {
        "continue": True,
        "hookSpecificOutput": {"additionalContext": "ctx", "permissionDecision": "allow"},
    }
    result = denormalize_response(response, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["additionalContext"] == "ctx"
    assert hso["permissionDecision"] == "allow"
    assert "additional_context" not in hso
    assert "permission_decision" not in hso


def test_codex_harness_no_hso_passthrough():
    response = {"continue": True}
    result = denormalize_response(response, harness="codex")
    assert result == {"continue": True}


def test_claude_normalize_no_transformation():
    """Claude harness normalize_payload preserves all original keys and stamps _tg_harness."""
    payload = {"tool_name": "Read", "tool_input": {"file_path": "/src/x.py"}}
    result = normalize_payload(payload, harness="claude")
    assert result.get("tool_name") == "Read"
    assert result.get("tool_input") == {"file_path": "/src/x.py"}
    assert result.get("_tg_harness") == "claude"


def test_codex_normalize_bash_maps_to_pascal():
    """Codex harness normalize_payload must remap 'bash' → 'Bash'."""
    payload = {"tool_name": "bash", "tool_input": {"command": "echo hi"}}
    result = normalize_payload(payload, harness="codex")
    assert result["tool_name"] == "Bash"
    assert result["tool_input"] == {"command": "echo hi"}


# ---------------------------------------------------------------------------
# Gemini tool-map alignment: hooks_cli vs install
# ---------------------------------------------------------------------------


def test_gemini_tool_map_hooks_cli_and_install_agree():
    """hooks_cli._GEMINI_TOOL_NAME_MAP and install._GEMINI_TOOL_TO_TG must map
    the same source keys to the same target values.

    This is a drift-prevention test: both tables exist in separate modules but
    must stay in sync.  If a new Gemini tool is added to one, it must appear
    in both.  The test compares the full key→value mappings so any divergence
    is immediately visible.
    """
    from token_goat.hooks_cli import _GEMINI_TOOL_NAME_MAP
    from token_goat.install import _GEMINI_TOOL_TO_TG

    # Both maps must cover identical source keys.
    assert set(_GEMINI_TOOL_NAME_MAP.keys()) == set(_GEMINI_TOOL_TO_TG.keys()), (
        "Key mismatch between hooks_cli._GEMINI_TOOL_NAME_MAP and install._GEMINI_TOOL_TO_TG.\n"
        f"Only in hooks_cli: {set(_GEMINI_TOOL_NAME_MAP) - set(_GEMINI_TOOL_TO_TG)}\n"
        f"Only in install:   {set(_GEMINI_TOOL_TO_TG) - set(_GEMINI_TOOL_NAME_MAP)}"
    )

    # For every shared key, the target (token-goat PascalCase name) must also match.
    mismatches = {
        k: (_GEMINI_TOOL_NAME_MAP[k], _GEMINI_TOOL_TO_TG[k])
        for k in _GEMINI_TOOL_NAME_MAP
        if _GEMINI_TOOL_NAME_MAP[k] != _GEMINI_TOOL_TO_TG[k]
    }
    assert not mismatches, (
        "Value mismatch between hooks_cli._GEMINI_TOOL_NAME_MAP and install._GEMINI_TOOL_TO_TG.\n"
        f"Differing keys: {mismatches}"
    )


def test_gemini_tool_map_all_values_are_known_tools():
    """Every value in _GEMINI_TOOL_NAME_MAP must be a recognised token-goat tool name."""
    from token_goat.hooks_cli import _GEMINI_TOOL_NAME_MAP, _TG_KNOWN_TOOLS

    unknown = {v for v in _GEMINI_TOOL_NAME_MAP.values() if v not in _TG_KNOWN_TOOLS}
    assert not unknown, (
        f"_GEMINI_TOOL_NAME_MAP maps to unrecognised tool names: {unknown}. "
        "Add them to _TG_KNOWN_TOOLS if intentional."
    )


def test_codex_tool_map_all_values_are_known_tools():
    """Every value in _CODEX_TOOL_NAME_MAP must be a recognised token-goat tool name."""
    from token_goat.hooks_cli import _CODEX_TOOL_NAME_MAP, _TG_KNOWN_TOOLS

    unknown = {v for v in _CODEX_TOOL_NAME_MAP.values() if v not in _TG_KNOWN_TOOLS}
    assert not unknown, (
        f"_CODEX_TOOL_NAME_MAP maps to unrecognised tool names: {unknown}. "
        "Add them to _TG_KNOWN_TOOLS if intentional."
    )
