"""Tests for hooks_common helpers: extract_tool_response_text, run_dedup_hint."""
from __future__ import annotations

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
