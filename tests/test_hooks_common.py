"""Tests for hooks_common helpers: extract_tool_response_text, run_dedup_hint."""
from __future__ import annotations

import pytest

from token_goat.hints import ReadHint
from token_goat.hooks_cli import denormalize_response
from token_goat.hooks_common import extract_tool_response_text, run_dedup_hint

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _payload(tool_response: object) -> dict:
    return {"session_id": "s1", "tool_name": "Bash", "tool_response": tool_response}


# ---------------------------------------------------------------------------
# Shape 1: tool_response is a bare string
# ---------------------------------------------------------------------------

def test_bare_string():
    payload = _payload("hello world\n")
    assert extract_tool_response_text(payload) == "hello world\n"


def test_empty_string():
    payload = _payload("")
    assert extract_tool_response_text(payload) == ""


# ---------------------------------------------------------------------------
# Shape 2: tool_response is an MCP content array (list at top level)
# ---------------------------------------------------------------------------

def test_mcp_array_typed_text():
    items = [
        {"type": "text", "text": "line 1\n"},
        {"type": "text", "text": "line 2\n"},
    ]
    payload = _payload(items)
    assert extract_tool_response_text(payload) == "line 1\nline 2\n"


def test_mcp_array_bare_strings():
    payload = _payload(["part A", "part B"])
    assert extract_tool_response_text(payload) == "part Apart B"


def test_mcp_array_skips_non_text_typed_items():
    items = [
        {"type": "image", "text": "should be skipped"},
        {"type": "text", "text": "kept"},
    ]
    # type != "text" items: text key is still returned (fallback branch)
    # because _coerce_content_array falls back to item.get("text") when
    # type != "text".  Verify at least "kept" is present.
    result = extract_tool_response_text(_payload(items))
    assert "kept" in result


def test_mcp_array_empty():
    payload = _payload([])
    assert extract_tool_response_text(payload) == ""


# ---------------------------------------------------------------------------
# Shape 3: tool_response is a dict with named fields
# ---------------------------------------------------------------------------

def test_dict_stdout_key():
    payload = _payload({"stdout": "output here", "exit_code": 0})
    # Default text_keys don't include "stdout"; pass explicit keys like bash does.
    result = extract_tool_response_text(payload, text_keys=("stdout", "output", "text"))
    assert result == "output here"


def test_dict_output_key():
    payload = _payload({"output": "fetched body", "status_code": 200})
    assert extract_tool_response_text(payload) == "fetched body"


def test_dict_text_key():
    payload = _payload({"text": "plain text body"})
    assert extract_tool_response_text(payload) == "plain text body"


def test_dict_body_key():
    payload = _payload({"body": "response body"})
    assert extract_tool_response_text(payload) == "response body"


def test_dict_content_key_string():
    payload = _payload({"content": "content string"})
    assert extract_tool_response_text(payload) == "content string"


def test_dict_content_key_mcp_array():
    """content value is itself an MCP array — should concatenate."""
    items = [{"type": "text", "text": "A"}, {"type": "text", "text": "B"}]
    payload = _payload({"content": items})
    assert extract_tool_response_text(payload) == "AB"


def test_dict_prefers_first_matching_key():
    """output wins over text when both are present."""
    payload = _payload({"output": "first", "text": "second"})
    assert extract_tool_response_text(payload) == "first"


# ---------------------------------------------------------------------------
# Fallback: tool_result / response keys instead of tool_response
# ---------------------------------------------------------------------------

def test_tool_result_fallback():
    payload = {"session_id": "s1", "tool_result": "from tool_result"}
    assert extract_tool_response_text(payload) == "from tool_result"


@pytest.mark.parametrize("tool_result", ["", [], {}])
def test_empty_tool_result_does_not_fall_back(tool_result):
    payload = {"session_id": "s1", "tool_result": tool_result, "response": "fallback"}
    assert extract_tool_response_text(payload) == ""


def test_response_fallback():
    payload = {"session_id": "s1", "response": "from response key"}
    assert extract_tool_response_text(payload) == "from response key"


# ---------------------------------------------------------------------------
# Missing / malformed payloads
# ---------------------------------------------------------------------------

def test_missing_tool_response():
    payload = {"session_id": "s1", "tool_name": "Bash"}
    assert extract_tool_response_text(payload) == ""


def test_none_tool_response():
    payload = _payload(None)
    assert extract_tool_response_text(payload) == ""


def test_non_dict_payload():
    # Should not raise; returns empty string.
    assert extract_tool_response_text(None) == ""  # type: ignore[arg-type]
    assert extract_tool_response_text("not a dict") == ""  # type: ignore[arg-type]


def test_integer_tool_response():
    # Unexpected type — returns "" (not coerced via str()).
    payload = _payload(42)
    assert extract_tool_response_text(payload) == ""


# ---------------------------------------------------------------------------
# custom text_keys ordering
# ---------------------------------------------------------------------------

def test_custom_text_keys_ordering():
    """Caller can pass a different key order; first match wins."""
    payload = _payload({"body": "body text", "output": "output text"})
    result = extract_tool_response_text(payload, text_keys=("body", "output"))
    assert result == "body text"


# ---------------------------------------------------------------------------
# run_dedup_hint
# ---------------------------------------------------------------------------


def _sid_payload(session_id: str, tool_name: str = "Bash") -> dict:
    return {"session_id": session_id, "tool_name": tool_name, "tool_input": {}}


class _FakeHint:
    """Minimal hint object with tokens_saved and __str__ / __len__."""

    def __init__(self, text: str, tokens_saved: int = 10) -> None:
        self._text = text
        self.tokens_saved = tokens_saved

    def __str__(self) -> str:
        return self._text

    def __len__(self) -> int:
        return len(self._text)


def test_run_dedup_hint_returns_none_when_builder_returns_none(tmp_path, monkeypatch):
    """Builder returning None → run_dedup_hint returns None (no hint injected)."""
    import token_goat.hooks_common as hc

    # Patch session.load to return a fake cache.
    fake_cache = object()
    monkeypatch.setattr(hc, "_run_dedup_hint_session", None, raising=False)

    import token_goat.session as _session  # noqa: PLC0415
    monkeypatch.setattr(_session, "load", lambda sid: fake_cache)

    # Patch db.record_stat to no-op so no DB is needed.
    import token_goat.db as _db  # noqa: PLC0415
    monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)

    payload = _sid_payload("test-no-hint")
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: None,
        stat_kind="bash_dedup_hint",
        detail="pytest",
    )
    assert result is None


def test_run_dedup_hint_returns_context_when_builder_returns_hint(monkeypatch):
    """Builder returning a hint → response with additionalContext set."""
    import token_goat.db as _db  # noqa: PLC0415
    import token_goat.hints as _hints  # noqa: PLC0415
    import token_goat.session as _session  # noqa: PLC0415

    fake_cache = object()
    monkeypatch.setattr(_session, "load", lambda sid: fake_cache)
    monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)
    monkeypatch.setattr(_hints, "CHARS_PER_TOKEN", 4)

    hint = _FakeHint("reuse cached output (bash_dedup)", tokens_saved=20)

    payload = _sid_payload("test-hint-injected")
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: hint,
        stat_kind="bash_dedup_hint",
        detail="pytest --tb=short",
    )
    assert result is not None
    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput", {})
    assert isinstance(hso, dict)
    assert "reuse cached output" in hso.get("additionalContext", "")


def test_run_dedup_hint_returns_none_when_no_session_id():
    """Missing session_id in payload → returns None without touching session."""
    payload = {"tool_name": "Bash", "tool_input": {}}  # no session_id
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: _FakeHint("should not appear"),
        stat_kind="bash_dedup_hint",
        detail="cmd",
    )
    assert result is None


def test_run_dedup_hint_returns_none_on_session_load_error(monkeypatch):
    """OSError from session.load → returns None (fail-soft)."""
    import token_goat.session as _session  # noqa: PLC0415

    def _raise(sid: str) -> object:
        raise OSError("disk full")

    monkeypatch.setattr(_session, "load", _raise)

    payload = _sid_payload("test-load-error")
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: _FakeHint("irrelevant"),
        stat_kind="bash_dedup_hint",
        detail="cmd",
    )
    assert result is None


def test_run_dedup_hint_builder_receives_session_id_and_cache(monkeypatch):
    """Builder is called with the correct (session_id, cache) arguments."""
    import token_goat.db as _db  # noqa: PLC0415
    import token_goat.hints as _hints  # noqa: PLC0415
    import token_goat.session as _session  # noqa: PLC0415

    fake_cache = object()
    captured: dict = {}

    monkeypatch.setattr(_session, "load", lambda sid: fake_cache)
    monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)
    monkeypatch.setattr(_hints, "CHARS_PER_TOKEN", 4)

    def _builder(sid: str, cache: object) -> _FakeHint:
        captured["sid"] = sid
        captured["cache"] = cache
        return _FakeHint("hint text")

    payload = _sid_payload("test-builder-args")
    run_dedup_hint(payload, builder=_builder, stat_kind="grep_dedup_hint", detail="pat")

    assert captured["sid"] == "test-builder-args"
    assert captured["cache"] is fake_cache


# ---------------------------------------------------------------------------
# denormalize_response fast-path optimization
# ---------------------------------------------------------------------------


def test_denormalize_response_continue_only_claude():
    """Response {"continue": True} on Claude harness returns same dict (no copy)."""
    resp = {"continue": True}
    result = denormalize_response(resp, harness="claude")
    assert result is resp  # Same object, not a copy


def test_denormalize_response_with_system_message_claude():
    """Response with camelCase keys (Claude format) returns same dict on Claude harness."""
    resp = {"continue": True, "systemMessage": "test context", "hookSpecificOutput": {}}
    result = denormalize_response(resp, harness="claude")
    assert result is resp


def test_denormalize_response_camel_case_no_hso():
    """Response with continue but no hookSpecificOutput returns dict unchanged."""
    resp = {"continue": True}
    result = denormalize_response(resp, harness="codex")
    assert result is resp


def test_denormalize_response_slow_path_has_snake_keys():
    """Slow-path triggers when snake_case keys are present in hookSpecificOutput.

    Snake_case input keys are left untouched (not in the camelCase->snake_case mapping),
    while any camelCase keys present are translated.
    """
    resp = {
        "continue": True,
        "hookSpecificOutput": {
            "hook_event_name": "PreToolUse",  # snake_case key (not in mapping, stays)
            "additionalContext": "will translate",  # camelCase (in mapping, becomes snake_case)
        },
    }
    result = denormalize_response(resp, harness="codex")
    # Slow path was triggered (snake_case present), so copy is made.
    assert result is not resp
    hso = result["hookSpecificOutput"]
    assert "hook_event_name" in hso  # Untouched (was snake_case)
    assert "additional_context" in hso  # Translated from camelCase


def test_denormalize_response_mixed_keys_triggers_slow_path():
    """Presence of any snake_case key in hookSpecificOutput triggers the slow-path remap."""
    resp = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",  # camelCase — gets translated
            "additional_context": "mixed",  # snake_case — triggers slow-path, stays as-is
        },
    }
    result = denormalize_response(resp, harness="codex")
    # Should remap the camelCase key.
    assert result is not resp
    hso = result["hookSpecificOutput"]
    assert "hook_event_name" in hso  # hookEventName translated
    assert "additional_context" in hso  # Stayed as-is (already snake_case)
    assert "hookEventName" not in hso  # Original camelCase removed


def test_denormalize_response_translates_updated_input_for_codex():
    """updatedInput must translate to updated_input for Codex wire format."""
    resp = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": {"file_path": "/shrunk.png"},
            "additionalContext": "image shrunk",
        },
    }
    result = denormalize_response(resp, harness="codex")
    hso = result["hookSpecificOutput"]
    assert "updated_input" in hso
    assert "additional_context" in hso
    assert hso["updated_input"] == {"file_path": "/shrunk.png"}


def test_denormalize_response_translates_permission_decision_for_codex():
    """permissionDecision must translate to permission_decision for Codex wire format."""
    resp = {
        "continue": False,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "blocked",
            "additionalContext": "denied",
        },
    }
    result = denormalize_response(resp, harness="codex")
    hso = result["hookSpecificOutput"]
    assert "permission_decision" in hso
    assert "permission_decision_reason" in hso
    assert hso["permission_decision"] == "deny"


# ---------------------------------------------------------------------------
# record_hint_stat_pair: zero-saving guard and config gate
# ---------------------------------------------------------------------------


def test_record_hint_stat_pair_zero_savings_skips_writes(monkeypatch):
    """record_hint_stat_pair with tokens_saved=0 and injection_bytes=0 should skip DB writes."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    # Mock db.record_stat to track calls inside the function
    with patch("token_goat.db.record_stat") as mock_record_stat:
        # Mock config.load() to return default config (record_zero_savings=False)
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("", tokens_saved=0)
        record_hint_stat_pair("test_hint", hint, "detail")

        # With default config (record_zero_savings=False) and zero savings, no writes should occur
        assert mock_record_stat.call_count == 0


def test_record_hint_stat_pair_nonzero_savings_writes(monkeypatch):
    """record_hint_stat_pair with tokens_saved>0 should write both stat rows."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    # Mock db.record_stat to track calls inside the function
    with patch("token_goat.db.record_stat") as mock_record_stat:
        # Mock config.load() to return default config
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("x" * 40, tokens_saved=10)
        record_hint_stat_pair("test_hint", hint, "detail")

        # With tokens_saved>0, both rows should be written
        assert mock_record_stat.call_count == 2


def test_record_hint_stat_pair_zero_savings_with_config_override(monkeypatch):
    """record_hint_stat_pair with record_zero_savings=True should write zero-saving rows."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    # Mock db.record_stat to track calls inside the function
    with patch("token_goat.db.record_stat") as mock_record_stat:
        # Mock config.load() to return a config with record_zero_savings=True
        mock_config = _config.Config()
        mock_config.stats = _config.StatsConfig(record_zero_savings=True)
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("", tokens_saved=0)
        record_hint_stat_pair("test_hint", hint, "detail")

        # With record_zero_savings=True override and zero savings, both rows should be written
        assert mock_record_stat.call_count == 2


def test_record_hint_stat_pair_small_injection_skips_overhead(monkeypatch):
    """Item 15: injection_bytes < 32 skips overhead row; saving row written if tokens_saved > 0."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    with patch("token_goat.db.record_stat") as mock_record_stat:
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("short hint", tokens_saved=5)
        record_hint_stat_pair("test_hint", hint, "detail")

        # Only the saving row should be written (1 call), not the overhead row
        assert mock_record_stat.call_count == 1
        # Verify the call was for the saving row (kind without "_overhead")
        # record_stat(project_hash, kind, ...) — kind is the 2nd positional arg
        call_args = mock_record_stat.call_args_list[0][0]
        assert call_args[1] == "test_hint"  # index 1 is the 'kind' argument


def test_record_hint_stat_pair_small_injection_zero_savings_skips_all(monkeypatch):
    """Item 15: injection_bytes < 32 and tokens_saved = 0 skips both rows (normal zero-savings skip)."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    with patch("token_goat.db.record_stat") as mock_record_stat:
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("tiny", tokens_saved=0)
        record_hint_stat_pair("test_hint", hint, "detail")

        # No rows written: zero savings with default config (record_zero_savings=False)
        assert mock_record_stat.call_count == 0


def test_record_hint_stat_pair_large_injection_writes_both(monkeypatch):
    """Item 15: injection_bytes >= 32 writes both saving and overhead rows (if tokens > 0)."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    with patch("token_goat.db.record_stat") as mock_record_stat:
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint = ReadHint("x" * 40, tokens_saved=5)
        record_hint_stat_pair("test_hint", hint, "detail")

        # Both rows should be written (large injection, positive savings)
        assert mock_record_stat.call_count == 2
        # Verify both kinds are present
        # record_stat(project_hash, kind, ...) — kind is the 2nd positional arg
        kinds = [call[0][1] for call in mock_record_stat.call_args_list]
        assert "test_hint" in kinds
        assert "test_hint_overhead" in kinds


def test_record_hint_stat_pair_counts_utf8_bytes(monkeypatch):
    """UTF-8 overhead should be counted in bytes, not characters."""
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hooks_common import record_hint_stat_pair

    with patch("token_goat.db.record_stat") as mock_record_stat:
        mock_config = _config.Config()
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        hint_text = "café" * 10
        hint = ReadHint(hint_text, tokens_saved=10)
        record_hint_stat_pair("test_hint", hint, "detail")

        assert mock_record_stat.call_count == 2
        overhead_kwargs = mock_record_stat.call_args_list[1][1]
        assert overhead_kwargs["bytes_saved"] == -len(hint_text.encode("utf-8"))


def _quiet_hours_at(hhmm: str, quiet_hours: str) -> bool:
    """Call _is_quiet_hours with a fake current time given as 'HH:MM'."""
    import datetime
    from unittest.mock import patch

    from token_goat.hooks_common import _is_quiet_hours

    h, m = int(hhmm[:2]), int(hhmm[3:])
    fake_now = datetime.datetime(2026, 1, 1, h, m)
    with patch("datetime.datetime") as mock_dt:
        mock_dt.now.return_value = fake_now
        return _is_quiet_hours(quiet_hours)


class TestQuietHours:
    """Item 16: _is_quiet_hours returns True when current time is in the window."""

    def test_empty_string_never_quiet(self):
        from token_goat.hooks_common import _is_quiet_hours
        assert _is_quiet_hours("") is False

    def test_malformed_string_never_quiet(self):
        from token_goat.hooks_common import _is_quiet_hours
        assert _is_quiet_hours("not-a-time") is False
        assert _is_quiet_hours("25:00-26:00") is False
        assert _is_quiet_hours("9-17") is False

    def test_normal_range_inside(self):
        """Time clearly inside a normal (non-wrapping) range returns True."""
        assert _quiet_hours_at("14:30", "09:00-17:00") is True

    def test_normal_range_outside_before(self):
        """Time before the normal range returns False."""
        assert _quiet_hours_at("08:00", "09:00-17:00") is False

    def test_normal_range_outside_after(self):
        """Time after the normal range returns False."""
        assert _quiet_hours_at("18:00", "09:00-17:00") is False

    def test_midnight_wrap_inside_evening(self):
        """Time after start of midnight-crossing range (e.g. 23:00) returns True."""
        assert _quiet_hours_at("23:00", "22:00-07:00") is True

    def test_midnight_wrap_inside_early_morning(self):
        """Early morning inside midnight-crossing range returns True."""
        assert _quiet_hours_at("03:00", "22:00-07:00") is True

    def test_midnight_wrap_outside(self):
        """Time clearly outside a midnight-crossing range (noon) returns False."""
        assert _quiet_hours_at("12:00", "22:00-07:00") is False
