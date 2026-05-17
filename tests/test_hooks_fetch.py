"""Tests for hooks_fetch.py — Drive / WebFetch pre-fetch interception.

These tests focus on hint generation for the *Drive* path; the WebFetch path is
covered by tests/test_image_shrink.py and tests/test_webfetch.py.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from token_goat import hooks_fetch


def _make_payload(file_id: str, name: str | None = None) -> dict:
    """Build a synthetic Drive MCP tool payload."""
    tool_input: dict = {"file_id": file_id}
    if name is not None:
        tool_input["name"] = name
    return {
        "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
        "tool_input": tool_input,
    }


class TestDriveInterceptMarkdownHint:
    def test_markdown_filename_adds_sections_hint(self, tmp_data_dir):
        with (
            patch("google.auth.default", return_value=(MagicMock(), "proj")),
        ):
            resp = hooks_fetch.pre_fetch(_make_payload("file_abc", name="spec.md"))

        # deny_redirect returns a structured response — drill into its context to
        # verify the sections hint is present.
        text = str(resp)
        assert "gdrive-sections file_abc" in text
        assert "gdrive-fetch file_abc" in text  # fallback also offered

    def test_non_markdown_filename_no_sections_hint(self, tmp_data_dir):
        with (
            patch("google.auth.default", return_value=(MagicMock(), "proj")),
        ):
            resp = hooks_fetch.pre_fetch(_make_payload("file_abc", name="photo.jpg"))

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_missing_filename_no_sections_hint(self, tmp_data_dir):
        with (
            patch("google.auth.default", return_value=(MagicMock(), "proj")),
        ):
            resp = hooks_fetch.pre_fetch(_make_payload("file_abc"))

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_no_creds_continues_without_intercept(self, tmp_data_dir):
        # When credentials are unavailable the hook returns CONTINUE so Drive
        # MCP can handle the call directly (token-goat is a no-op fall-through).
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            resp = hooks_fetch.pre_fetch(_make_payload("file_abc", name="spec.md"))

        text = str(resp)
        # CONTINUE response: no denial / redirect text — just a continue payload.
        assert "gdrive-fetch" not in text
        assert "gdrive-sections" not in text

    def test_overlong_filename_rejected_no_hint(self, tmp_data_dir):
        # A 1000-char name must not be embedded; sections hint should be omitted.
        long_name = ("a" * 999) + ".md"
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_fetch.pre_fetch(_make_payload("file_abc", name=long_name))

        text = str(resp)
        # Hint suppressed because filename was too long to safely embed.
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_non_string_filename_rejected_no_hint(self, tmp_data_dir):
        payload = _make_payload("file_abc")
        payload["tool_input"]["name"] = 42  # type: ignore[index]
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_fetch.pre_fetch(payload)

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text


class TestDriveInterceptFileId:
    def test_invalid_file_id_continues(self, tmp_data_dir):
        # File id with path separators must be rejected (validation guard) and the
        # hook falls through with CONTINUE so the Drive MCP errors normally.
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_fetch.pre_fetch(_make_payload("../etc/passwd"))

        text = str(resp)
        assert "gdrive-fetch" not in text

    def test_empty_file_id_continues(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {},
        }
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_fetch.pre_fetch(payload)

        text = str(resp)
        assert "gdrive-fetch" not in text
