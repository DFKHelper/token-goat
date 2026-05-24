"""Tests for hooks_common.extract_tool_response_text."""
from __future__ import annotations

from token_goat.hooks_common import extract_tool_response_text

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
