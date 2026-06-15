"""Tests for GhFilter base64 content-field redaction."""
from __future__ import annotations

import base64
import json

from token_goat.bash_compress import GhFilter, _redact_gh_base64_content


def _b64(text: str) -> str:
    """Return base64-encoded version of text with trailing newline (GitHub style)."""
    return base64.b64encode(text.encode()).decode() + "\n"


# Build a blob long enough to exceed the 200-char minimum.
_LONG_B64 = _b64("x" * 300)
assert len(_LONG_B64) > 200


class TestRedactGhBase64Content:
    """Unit tests for the _redact_gh_base64_content helper."""

    def test_single_object_content_replaced(self) -> None:
        payload = {"name": "README.md", "content": _LONG_B64, "sha": "abc123"}
        stdout = json.dumps(payload, indent=2)
        result = _redact_gh_base64_content(stdout)
        parsed = json.loads(result)
        assert parsed["name"] == "README.md"
        assert parsed["sha"] == "abc123"
        assert "<base64 content:" in parsed["content"]
        assert "bytes decoded" in parsed["content"]

    def test_decoded_byte_count_accurate(self) -> None:
        raw = b"Hello, World! " * 30  # ensure > 200 chars b64-encoded
        encoded = base64.b64encode(raw).decode() + "\n"
        payload = {"content": encoded}
        result = _redact_gh_base64_content(json.dumps(payload))
        parsed = json.loads(result)
        assert f"{len(raw)} bytes decoded" in parsed["content"]

    def test_array_elements_redacted(self) -> None:
        items = [
            {"name": "file1.py", "content": _LONG_B64},
            {"name": "file2.py", "content": _LONG_B64},
        ]
        stdout = json.dumps(items, indent=2)
        result = _redact_gh_base64_content(stdout)
        parsed = json.loads(result)
        assert len(parsed) == 2
        for item in parsed:
            assert "<base64 content:" in item["content"]

    def test_array_mixed_elements_passthrough(self) -> None:
        items = [
            {"name": "file1.py", "content": _LONG_B64},
            "just a string",
        ]
        stdout = json.dumps(items)
        result = _redact_gh_base64_content(stdout)
        parsed = json.loads(result)
        assert "<base64 content:" in parsed[0]["content"]
        assert parsed[1] == "just a string"

    def test_short_content_not_redacted(self) -> None:
        payload = {"content": "c2hvcnQ="}  # base64 for "short" — under 200 chars
        stdout = json.dumps(payload)
        result = _redact_gh_base64_content(stdout)
        assert result == stdout

    def test_non_base64_content_not_redacted(self) -> None:
        long_val = "this is not base64: " + "hello world " * 20
        payload = {"content": long_val}
        stdout = json.dumps(payload)
        result = _redact_gh_base64_content(stdout)
        assert result == stdout

    def test_malformed_json_passthrough(self) -> None:
        not_json = "not json at all { content: broken"
        result = _redact_gh_base64_content(not_json)
        assert result == not_json

    def test_empty_stdout_passthrough(self) -> None:
        assert _redact_gh_base64_content("") == ""
        assert _redact_gh_base64_content("   ") == "   "

    def test_non_json_object_passthrough(self) -> None:
        plain = "just a plain string"
        assert _redact_gh_base64_content(plain) == plain

    def test_object_without_content_field_unchanged(self) -> None:
        payload = {"name": "README.md", "sha": "abc123", "size": 42}
        stdout = json.dumps(payload)
        result = _redact_gh_base64_content(stdout)
        assert result == stdout

    def test_pretty_printed_output_stays_pretty(self) -> None:
        payload = {"content": _LONG_B64, "sha": "def456"}
        stdout = json.dumps(payload, indent=2)
        result = _redact_gh_base64_content(stdout)
        assert "\n" in result  # re-serialized with indent=2

    def test_compact_output_stays_compact(self) -> None:
        payload = {"content": _LONG_B64, "sha": "def456"}
        stdout = json.dumps(payload)  # no indent → compact
        result = _redact_gh_base64_content(stdout)
        assert "\n" not in result  # no newlines in compact form


class TestGhFilterBase64Integration:
    """Integration tests: GhFilter.compress() redacts base64 via gh api flow."""

    def setup_method(self) -> None:
        self.flt = GhFilter()

    def test_gh_api_contents_redacted(self) -> None:
        payload = {"name": "main.py", "content": _LONG_B64, "sha": "abc"}
        stdout = json.dumps(payload, indent=2)
        result = self.flt.compress(stdout, "", 0, ["gh", "api", "repos/o/r/contents/main.py"])
        assert "<base64 content:" in result

    def test_gh_api_non_contents_passthrough(self) -> None:
        stdout = json.dumps({"id": 1, "name": "my-repo"})
        result = self.flt.compress(stdout, "", 0, ["gh", "api", "repos/o/r"])
        assert "my-repo" in result
        assert "<base64" not in result
