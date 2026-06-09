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
    result = extract_tool_response_text(_payload(items))
    assert "kept" in result
    assert "should be skipped" not in result


def test_mcp_array_no_type_key_included():
    """Items that omit the type field entirely (older harnesses) are included."""
    items = [
        {"text": "legacy item"},
        {"type": "text", "text": "typed item"},
    ]
    result = extract_tool_response_text(_payload(items))
    assert "legacy item" in result
    assert "typed item" in result


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
    monkeypatch.setattr(_session, "save", lambda _c: None)

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
    monkeypatch.setattr(_session, "save", lambda _c: None)
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
    monkeypatch.setattr(_session, "save", lambda _c: None)
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


def test_run_dedup_hint_saves_cache_when_hint_emitted(monkeypatch):
    """run_dedup_hint must call session.save(cache) when the builder returns a hint.

    Regression: the function never called session.save after the builder mutated
    the cache (bash_dedup_emitted_ids, hints_emitted_by_type, etc.), so all
    mutations were discarded at hook-process exit.  The same bash output could
    then generate a dedup hint on every subsequent call for the entire session.
    """
    import token_goat.db as _db  # noqa: PLC0415
    import token_goat.hints as _hints  # noqa: PLC0415
    import token_goat.session as _session  # noqa: PLC0415

    fake_cache = object()
    save_calls: list[object] = []

    monkeypatch.setattr(_session, "load", lambda sid: fake_cache)
    monkeypatch.setattr(_session, "save", lambda c: save_calls.append(c))
    monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)
    monkeypatch.setattr(_hints, "CHARS_PER_TOKEN", 4)

    payload = _sid_payload("test-save-on-emit")
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: _FakeHint("cached result", tokens_saved=50),
        stat_kind="bash_dedup_hint",
        detail="cmd",
    )

    assert result is not None, "hint must be emitted"
    assert len(save_calls) == 1, "session.save must be called once when hint is emitted"
    assert save_calls[0] is fake_cache, "session.save must receive the same cache object"


def test_run_dedup_hint_saves_cache_when_builder_returns_none(monkeypatch):
    """run_dedup_hint must call session.save even when builder returns None.

    Regression: suppression paths mutate hints_suppressed_by_type on the cache
    but those counters were silently discarded at process exit because save was
    only called on the emit path.  Save must be unconditional so suppression
    counters survive the hook process boundary.
    """
    import token_goat.session as _session  # noqa: PLC0415

    fake_cache = object()
    save_calls: list[object] = []

    monkeypatch.setattr(_session, "load", lambda sid: fake_cache)
    monkeypatch.setattr(_session, "save", lambda c: save_calls.append(c))

    payload = _sid_payload("test-save-on-none")
    result = run_dedup_hint(
        payload,
        builder=lambda sid, cache: None,
        stat_kind="bash_dedup_hint",
        detail="cmd",
    )

    assert result is None
    assert len(save_calls) == 1, "session.save must be called even when builder returns None"
    assert save_calls[0] is fake_cache, "session.save must receive the same cache object"


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
    # No hookSpecificOutput and no _tg_* keys → equivalent content, _tg_* would be stripped.
    resp = {"continue": True}
    result = denormalize_response(resp, harness="codex")
    assert result.get("continue") is True
    assert "hookSpecificOutput" not in result


def test_denormalize_response_codex_preserves_camel_and_existing_snake():
    # Codex 0.137.0+ uses camelCase — all keys pass through unchanged.
    resp = {
        "continue": True,
        "hookSpecificOutput": {
            "hook_event_name": "PreToolUse",
            "additionalContext": "hint",
        },
    }
    result = denormalize_response(resp, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["hook_event_name"] == "PreToolUse"
    assert hso["additionalContext"] == "hint"


def test_denormalize_response_mixed_keys_all_preserved():
    # No translation occurs; both camelCase and any pre-existing snake_case pass through.
    resp = {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additional_context": "mixed",
        },
    }
    result = denormalize_response(resp, harness="codex")
    hso = result["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["additional_context"] == "mixed"


def test_denormalize_response_updated_input_preserved_for_codex():
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
    assert hso["updatedInput"] == {"file_path": "/shrunk.png"}
    assert hso["additionalContext"] == "image shrunk"
    assert "updated_input" not in hso
    assert "additional_context" not in hso


def test_denormalize_response_permission_decision_preserved_for_codex():
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
    assert hso["permissionDecision"] == "deny"
    assert hso["permissionDecisionReason"] == "blocked"
    assert "permission_decision" not in hso


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


def test_structured_file_hint_no_overhead_by_default(monkeypatch, tmp_path):
    """structured_file_hint is always tokens_saved=0 (advisory).

    By default (record_zero_savings=False), record_hint_stat_pair must write no
    DB rows at all — neither a savings row nor an overhead row.  This ensures the
    stat is net-neutral rather than net-negative in default installations.

    The overhead only appears when record_zero_savings=True is explicitly opted in,
    which is documented in stats.py's structured_file_hint comment.
    """
    from unittest.mock import patch

    from token_goat import config as _config
    from token_goat.hints import ReadHint
    from token_goat.hooks_common import record_hint_stat_pair

    with patch("token_goat.db.record_stat") as mock_record_stat:
        mock_config = _config.Config()
        # Confirm record_zero_savings is False by default (the default constructor).
        assert mock_config.stats.record_zero_savings is False
        monkeypatch.setattr(_config, "load", lambda: mock_config)

        # Simulate what build_structured_file_hint returns: tokens_saved=0.
        hint = ReadHint(
            "📄 large json (120KB) — use `token-goat read \"file.json::Key.path\"` or jq",
            0,
        )
        record_hint_stat_pair("structured_file_hint", hint, "file.json")

        # Zero-saving hints must not write any rows when record_zero_savings=False.
        assert mock_record_stat.call_count == 0, (
            "structured_file_hint (tokens_saved=0) must not write saving or overhead rows "
            "when record_zero_savings=False; overhead only appears when opted in"
        )


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


# ---------------------------------------------------------------------------
# normalize_payload schema validation
# ---------------------------------------------------------------------------


class TestNormalizePayloadValidation:
    """Test that normalize_payload validates the payload schema."""

    def test_valid_payload_returns_unchanged(self) -> None:
        """Valid payload with tool_name passes through; _tg_harness is stamped."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"session_id": "s1", "tool_name": "Read", "tool_input": "file.txt"}
        result = normalize_payload(payload)
        assert result.get("session_id") == "s1"
        assert result.get("tool_name") == "Read"
        assert result.get("_tg_harness") == "claude"

    def test_empty_dict_returns_empty(self) -> None:
        """Empty dict payload is rejected."""
        from token_goat.hooks_cli import normalize_payload

        result = normalize_payload({})
        assert result == {}

    def test_non_dict_payload_returns_empty(self) -> None:
        """Non-dict payload (list, string, None) is rejected."""
        from token_goat.hooks_cli import normalize_payload

        assert normalize_payload([]) == {}
        assert normalize_payload("string") == {}
        assert normalize_payload(None) == {}

    def test_missing_tool_name_returns_empty(self) -> None:
        """Payload without tool_name is rejected."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"session_id": "s1", "tool_input": "file.txt"}
        result = normalize_payload(payload)
        assert result == {}

    def test_empty_tool_name_returns_empty(self) -> None:
        """Payload with empty tool_name is rejected."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"session_id": "s1", "tool_name": ""}
        result = normalize_payload(payload)
        assert result == {}

    def test_whitespace_tool_name_returns_empty(self) -> None:
        """Payload with whitespace-only tool_name is rejected."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"session_id": "s1", "tool_name": "   "}
        result = normalize_payload(payload)
        assert result == {}

    def test_non_string_tool_name_returns_empty(self) -> None:
        """Payload with non-string tool_name is rejected."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"session_id": "s1", "tool_name": 123}
        result = normalize_payload(payload)
        assert result == {}

    def test_valid_payload_with_minimal_fields(self) -> None:
        """Valid payload needs only tool_name; _tg_harness is stamped."""
        from token_goat.hooks_cli import normalize_payload

        payload = {"tool_name": "Bash"}
        result = normalize_payload(payload)
        assert result.get("tool_name") == "Bash"
        assert result.get("_tg_harness") == "claude"


# ---------------------------------------------------------------------------
# load_session_safe — fail-soft session loader
# ---------------------------------------------------------------------------

class TestLoadSessionSafe:
    """Tests for hooks_common.load_session_safe."""

    def test_returns_fresh_cache_for_unknown_session(self, tmp_data_dir) -> None:
        """load_session_safe returns a fresh SessionCache for an unknown session ID.

        session.load() itself creates a fresh empty cache when the file is missing,
        so load_session_safe passes it through (does not suppress the fresh object).
        """
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        result = load_session_safe("no-such-session-id-xyz-9999")
        # Returns a fresh (non-None) SessionCache — same as session.load() behaviour
        assert result is not None
        assert isinstance(result, sess.SessionCache)

    def test_returns_session_cache_on_success(self, tmp_data_dir) -> None:
        """load_session_safe returns a SessionCache when the session exists on disk."""
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        sid = "test-load-session-safe-ok"
        cache = sess.load(sid)
        sess.save(cache)

        result = load_session_safe(sid)
        assert result is not None
        assert isinstance(result, sess.SessionCache)

    def test_returns_none_on_oserror(self, tmp_data_dir, monkeypatch) -> None:
        """load_session_safe returns None when session.load raises OSError."""
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        monkeypatch.setattr(sess, "load", lambda sid: (_ for _ in ()).throw(OSError("disk gone")))

        result = load_session_safe("any-session-id")
        assert result is None

    def test_returns_none_on_value_error(self, tmp_data_dir, monkeypatch) -> None:
        """load_session_safe returns None when session.load raises ValueError (corrupt JSON)."""
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        monkeypatch.setattr(sess, "load", lambda sid: (_ for _ in ()).throw(ValueError("bad json")))

        result = load_session_safe("any-session-id")
        assert result is None

    def test_returns_none_on_unexpected_exception(self, tmp_data_dir, monkeypatch) -> None:
        """load_session_safe returns None on any unexpected exception (broad except)."""
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        monkeypatch.setattr(sess, "load", lambda sid: (_ for _ in ()).throw(RuntimeError("unexpected")))

        result = load_session_safe("any-session-id")
        assert result is None

    def test_does_not_raise(self, tmp_data_dir, monkeypatch) -> None:
        """load_session_safe never raises; it is a strict fail-soft function."""
        from token_goat import session as sess
        from token_goat.hooks_common import load_session_safe

        # Cause a completely unexpected exception type
        monkeypatch.setattr(sess, "load", lambda sid: (_ for _ in ()).throw(MemoryError("OOM")))

        # Must not raise
        result = load_session_safe("any-id")
        assert result is None


# ---------------------------------------------------------------------------
# record_cached_stat — bytes_saved / tokens_saved accounting
# ---------------------------------------------------------------------------

class TestRecordCachedStatSavingsAccounting:
    """record_cached_stat should pass actual bytes_saved and derived tokens_saved
    to db.record_stat.  Prior to the fix both fields were hard-coded to 0."""

    def _capture_record_stat_calls(self, monkeypatch):
        """Return (calls list, patcher).  Each call is a dict with the kwargs
        passed to db.record_stat."""
        calls = []

        def _fake_record_stat(project_hash, kind, bytes_saved=0, tokens_saved=0, detail=None):
            calls.append({
                "kind": kind,
                "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved,
                "detail": detail,
            })

        import token_goat.db as _db
        monkeypatch.setattr(_db, "record_stat", _fake_record_stat)
        return calls

    def test_bash_output_cached_records_nonzero_bytes(self, monkeypatch):
        """bash_output_cached should record the actual byte count of cached output."""
        from token_goat.hooks_common import record_cached_stat

        calls = self._capture_record_stat_calls(monkeypatch)
        record_cached_stat("bash_output_cached", "pytest --tb=short", bytes_saved=4096)

        assert len(calls) == 1
        assert calls[0]["kind"] == "bash_output_cached"
        assert calls[0]["bytes_saved"] == 4096
        assert calls[0]["tokens_saved"] == max(1, 4096 // 3 + 1)  # 1366

    def test_skill_cached_records_nonzero_bytes(self, monkeypatch):
        """skill_cached should record the actual body size of the cached skill."""
        from token_goat.hooks_common import record_cached_stat

        calls = self._capture_record_stat_calls(monkeypatch)
        record_cached_stat("skill_cached", "ralph", bytes_saved=32768)

        assert len(calls) == 1
        assert calls[0]["kind"] == "skill_cached"
        assert calls[0]["bytes_saved"] == 32768
        assert calls[0]["tokens_saved"] == max(1, 32768 // 3 + 1)  # 10923

    def test_tokens_saved_uses_canonical_formula(self, monkeypatch):
        """tokens_saved must use max(1, bytes // 3 + 1) — the same formula as compact.estimate_tokens."""
        from token_goat.hooks_common import record_cached_stat

        calls = self._capture_record_stat_calls(monkeypatch)
        record_cached_stat("bash_output_cached", "some-cmd", bytes_saved=7)

        # max(1, 7 // 3 + 1) = max(1, 3) = 3
        assert calls[0]["tokens_saved"] == max(1, 7 // 3 + 1)  # 3

    def test_zero_bytes_saved_when_omitted(self, monkeypatch):
        """Callers that don't pass bytes_saved get 0 (backwards-compatible)."""
        from token_goat.hooks_common import record_cached_stat

        calls = self._capture_record_stat_calls(monkeypatch)
        record_cached_stat("glob_result_cache_hit", "**/*.py")

        assert calls[0]["bytes_saved"] == 0
        assert calls[0]["tokens_saved"] == 0

    def test_negative_bytes_clamped_to_zero(self, monkeypatch):
        """A negative bytes_saved value should be clamped to 0 — never negative
        bytes or tokens should reach the DB."""
        from token_goat.hooks_common import record_cached_stat

        calls = self._capture_record_stat_calls(monkeypatch)
        record_cached_stat("bash_output_cached", "cmd", bytes_saved=-100)

        assert calls[0]["bytes_saved"] == 0
        assert calls[0]["tokens_saved"] == 0

    def test_db_error_is_swallowed(self, monkeypatch):
        """A DB failure must not propagate — record_cached_stat is fail-soft."""
        import token_goat.db as _db
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("DB gone")))

        from token_goat.hooks_common import record_cached_stat
        # Must not raise
        record_cached_stat("bash_output_cached", "cmd", bytes_saved=1024)
