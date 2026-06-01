"""Tests for hooks_fetch.py — Drive / WebFetch pre-fetch interception.

These tests focus on hint generation for the *Drive* path; the WebFetch path is
covered by tests/test_image_shrink.py and tests/test_webfetch.py.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from token_goat import hooks_cli


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
            resp = hooks_cli.pre_fetch(_make_payload("file_abc", name="spec.md"))

        # deny_redirect returns a structured response — drill into its context to
        # verify the sections hint is present.
        text = str(resp)
        assert "gdrive-sections file_abc" in text
        assert "gdrive-fetch file_abc" in text  # fallback also offered

    def test_non_markdown_filename_no_sections_hint(self, tmp_data_dir):
        with (
            patch("google.auth.default", return_value=(MagicMock(), "proj")),
        ):
            resp = hooks_cli.pre_fetch(_make_payload("file_abc", name="photo.jpg"))

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_missing_filename_no_sections_hint(self, tmp_data_dir):
        with (
            patch("google.auth.default", return_value=(MagicMock(), "proj")),
        ):
            resp = hooks_cli.pre_fetch(_make_payload("file_abc"))

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_no_creds_continues_without_intercept(self, tmp_data_dir):
        # When credentials are unavailable the hook returns CONTINUE so Drive
        # MCP can handle the call directly (token-goat is a no-op fall-through).
        with patch("google.auth.default", side_effect=Exception("no ADC")):
            resp = hooks_cli.pre_fetch(_make_payload("file_abc", name="spec.md"))

        text = str(resp)
        # CONTINUE response: no denial / redirect text — just a continue payload.
        assert "gdrive-fetch" not in text
        assert "gdrive-sections" not in text

    def test_overlong_filename_rejected_no_hint(self, tmp_data_dir):
        # A 1000-char name must not be embedded; sections hint should be omitted.
        long_name = ("a" * 999) + ".md"
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_cli.pre_fetch(_make_payload("file_abc", name=long_name))

        text = str(resp)
        # Hint suppressed because filename was too long to safely embed.
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text

    def test_non_string_filename_rejected_no_hint(self, tmp_data_dir):
        payload = _make_payload("file_abc")
        payload["tool_input"]["name"] = 42  # type: ignore[index]
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_cli.pre_fetch(payload)

        text = str(resp)
        assert "gdrive-sections" not in text
        assert "gdrive-fetch file_abc" in text


class TestDriveInterceptFileId:
    def test_invalid_file_id_continues(self, tmp_data_dir):
        # File id with path separators must be rejected (validation guard) and the
        # hook falls through with CONTINUE so the Drive MCP errors normally.
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_cli.pre_fetch(_make_payload("../etc/passwd"))

        text = str(resp)
        assert "gdrive-fetch" not in text

    def test_empty_file_id_continues(self, tmp_data_dir):
        payload = {
            "tool_name": "mcp__claude_ai_Google_Drive__download_file_content",
            "tool_input": {},
        }
        with patch("google.auth.default", return_value=(MagicMock(), "proj")):
            resp = hooks_cli.pre_fetch(payload)

        text = str(resp)
        assert "gdrive-fetch" not in text


class TestWebFetchAllowDeny:
    """Item 13: URL allow/deny glob list enforcement in pre_fetch."""

    def _webfetch_payload(self, url: str) -> dict:
        return {"tool_name": "WebFetch", "tool_input": {"url": url}}

    def test_no_restrictions_allows_any_url(self, tmp_data_dir):
        """With empty allow/deny lists, any non-image URL passes through."""
        from unittest.mock import patch

        from token_goat.config import Config

        cfg = Config()  # defaults: empty allow/deny
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/page"))
        # CONTINUE or dedup hint — not a deny
        assert resp.get("continue", True) is True or "allow" not in str(resp).lower()

    def test_deny_pattern_blocks_url(self, tmp_data_dir):
        """URL matching a deny glob is blocked."""
        from unittest.mock import patch

        from token_goat.config import Config, WebFetchConfig

        cfg = Config(webfetch=WebFetchConfig(deny=["https://evil.com/*"]))
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://evil.com/malware"))
        text = str(resp)
        assert "deny" in text.lower() or "blocked" in text.lower() or "deny list" in text.lower()

    def test_deny_pattern_does_not_block_non_matching_url(self, tmp_data_dir):
        """URL not matching the deny glob is allowed."""
        from unittest.mock import patch

        from token_goat.config import Config, WebFetchConfig

        cfg = Config(webfetch=WebFetchConfig(deny=["https://evil.com/*"]))
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://good.com/page"))
        # Should be CONTINUE (not blocked by deny)
        assert resp.get("continue", True) is True

    def test_allow_list_blocks_unlisted_url(self, tmp_data_dir):
        """URL not matching any allow pattern is blocked when allow list is non-empty."""
        from unittest.mock import patch

        from token_goat.config import Config, WebFetchConfig

        cfg = Config(webfetch=WebFetchConfig(allow=["https://trusted.org/*"]))
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://untrusted.io/page"))
        text = str(resp)
        assert "allow" in text.lower() or "blocked" in text.lower()

    def test_allow_list_permits_matching_url(self, tmp_data_dir):
        """URL matching allow pattern is permitted."""
        from unittest.mock import patch

        from token_goat.config import Config, WebFetchConfig

        cfg = Config(webfetch=WebFetchConfig(allow=["https://trusted.org/*"]))
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://trusted.org/docs"))
        # Should be CONTINUE (allowed)
        assert resp.get("continue", True) is True

    def test_deny_checked_before_allow(self, tmp_data_dir):
        """When URL matches both deny and allow, deny wins."""
        from unittest.mock import patch

        from token_goat.config import Config, WebFetchConfig

        cfg = Config(webfetch=WebFetchConfig(
            allow=["https://example.com/*"],
            deny=["https://example.com/bad*"],
        ))
        with patch("token_goat.config.load", return_value=cfg):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/badpath"))
        text = str(resp)
        assert "deny" in text.lower() or "blocked" in text.lower()


class TestWebSizeHint:
    """Tests for the WebFetch size hint emitted after caching large responses."""

    def test_size_hint_emitted_for_large_response(self, tmp_data_dir, caplog):
        """Size hint is logged for responses > 10 KB."""
        import logging
        caplog.set_level(logging.DEBUG)

        body = "X" * (12 * 1024)  # 12 KB, above threshold
        payload = {
            "session_id": "size-hint-1",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/large-doc"},
            "tool_response": {"output": body, "status_code": 200},
        }
        hooks_cli.post_fetch(payload)

        # Check that the size hint was logged
        assert any("web_size_hint" in record.message for record in caplog.records)

    def test_no_size_hint_for_small_response(self, tmp_data_dir, caplog):
        """Size hint is not emitted for responses < 10 KB."""
        import logging
        caplog.set_level(logging.DEBUG)

        body = "X" * (8 * 1024)  # 8 KB, below threshold
        payload = {
            "session_id": "size-hint-2",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/small-doc"},
            "tool_response": {"output": body, "status_code": 200},
        }
        hooks_cli.post_fetch(payload)

        # Check that no size hint was logged
        assert not any("web_size_hint" in record.message for record in caplog.records)

    def test_size_hint_content_correctness(self, tmp_data_dir, caplog):
        """Size hint includes correct byte and token estimates."""
        import logging
        caplog.set_level(logging.DEBUG)

        body = "X" * (20 * 1024)  # 20 KB
        payload = {
            "session_id": "size-hint-3",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/doc"},
            "tool_response": {"output": body, "status_code": 200},
        }
        hooks_cli.post_fetch(payload)

        # Find the size hint log message
        hint_records = [r for r in caplog.records if "web_size_hint" in r.message]
        assert len(hint_records) > 0
        msg = hint_records[0].message

        # Check that size, token estimate, and savings are mentioned
        assert "20.0 KB" in msg or "20 KB" in msg, f"Size not in hint: {msg}"
        assert "tokens" in msg.lower(), f"Token estimate not in hint: {msg}"
        # The logged hint mentions --grep as context for what the user can do
        assert "--grep" in msg, f"--grep reference expected in hint: {msg}"
