"""Tests for hooks_fetch.py — Drive / WebFetch pre-fetch interception.

These tests focus on hint generation for the *Drive* path; the WebFetch path is
covered by tests/test_image_shrink.py and tests/test_webfetch.py.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

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


class TestWebFetchDedupDeny:
    """Pressure-gated WebFetch re-fetch deny (Iter 3)."""

    def _webfetch_payload(self, url: str, prompt: str = "") -> dict:
        return {
            "tool_name": "WebFetch",
            "session_id": "dedup-deny-session",
            "tool_input": {"url": url, "prompt": prompt},
        }

    def _make_entry(self, age_seconds: float = 60, body_bytes: int = 50_000) -> object:
        import time

        from token_goat.session import WebEntry
        return WebEntry(
            url_sha="abc123",
            url_preview="https://example.com/docs",
            output_id="out_abc123456",
            ts=time.time() - age_seconds,
            body_bytes=body_bytes,
            status_code=200,
        )

    def _warm_pressure(self):
        from token_goat.compact import ContextPressure
        return ContextPressure(fill_fraction=0.6, tier="warm")

    def _cool_pressure(self):
        from token_goat.compact import ContextPressure
        return ContextPressure(fill_fraction=0.3, tier="cool")

    def test_deny_fires_at_warm_pressure_with_fresh_cached_entry(self, tmp_data_dir):
        """At warm pressure, a repeat fetch of a large cached URL is denied."""
        from unittest.mock import patch

        entry = self._make_entry()
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        text = str(resp)
        assert "cached body available" in text or "re-fetch blocked" in text
        assert "web-output" in text

    def test_no_deny_at_cool_pressure(self, tmp_data_dir):
        """At cool pressure, no deny is issued even with a cached entry."""
        from unittest.mock import patch

        entry = self._make_entry()
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._cool_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        # Should NOT be a deny for cached body — CONTINUE or a hint
        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    @pytest.mark.parametrize("prompt", [
        "refresh the page content",
        "get the latest version",
        "reload and summarize",
        "check the updated schema",
        "retry the fetch",
    ])
    def test_no_deny_when_bypass_keyword_in_prompt(self, tmp_data_dir, prompt):
        """Prompts containing any bypass keyword skip the deny regardless of pressure."""
        from unittest.mock import patch

        entry = self._make_entry()
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(
                self._webfetch_payload("https://example.com/docs", prompt=prompt)
            )

        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    def test_no_deny_when_entry_is_stale(self, tmp_data_dir):
        """Entry older than STALE_READ_AGE_SECONDS is not used for deny."""
        from unittest.mock import patch

        from token_goat.hints import STALE_READ_AGE_SECONDS

        stale_entry = self._make_entry(age_seconds=STALE_READ_AGE_SECONDS + 60)
        with (
            patch("token_goat.session.lookup_web_entry", return_value=stale_entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    def test_no_deny_when_no_cached_entry(self, tmp_data_dir):
        """First fetch with no cached entry is never denied."""
        from unittest.mock import patch

        with (
            patch("token_goat.session.lookup_web_entry", return_value=None),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/new"))

        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    def test_deny_fires_at_hot_pressure(self, tmp_data_dir):
        """Hot pressure also triggers the deny path."""
        from unittest.mock import patch

        from token_goat.compact import ContextPressure

        hot = ContextPressure(fill_fraction=0.78, tier="hot")
        entry = self._make_entry()
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=hot),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        text = str(resp)
        assert "re-fetch blocked" in text or "cached body available" in text

    def test_no_deny_when_output_id_is_empty(self, tmp_data_dir):
        """An entry with empty output_id must not produce a deny — no valid recovery path."""
        import time
        from unittest.mock import patch

        from token_goat.session import WebEntry

        bad_entry = WebEntry(
            url_sha="abc123",
            url_preview="https://example.com/docs",
            output_id="",  # empty — deserialization edge case
            ts=time.time() - 30,
            body_bytes=50_000,
            status_code=200,
        )
        with (
            patch("token_goat.session.lookup_web_entry", return_value=bad_entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    def test_no_deny_when_session_cache_raises(self, tmp_data_dir):
        """Exception in the deny check must not propagate — returns CONTINUE."""
        from unittest.mock import patch

        with (
            patch("token_goat.session.lookup_web_entry", side_effect=RuntimeError("cache corrupt")),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        hso = resp.get("hookSpecificOutput") or {}
        assert hso.get("permissionDecision") != "deny" or "cached body" not in str(resp)

    @pytest.mark.parametrize("bad_prompt", [{"text": "refresh"}, 0, [], None])
    def test_non_string_prompt_does_not_raise(self, tmp_data_dir, bad_prompt):
        """Non-string prompt values must not cause a TypeError — bypass defaults to False."""
        from unittest.mock import patch

        entry = self._make_entry()
        payload = {
            "tool_name": "WebFetch",
            "session_id": "dedup-deny-session",
            "tool_input": {"url": "https://example.com/docs", "prompt": bad_prompt},
        }
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            # Must not raise; result is deny (bypass=False) or CONTINUE — either is fine.
            resp = hooks_cli.pre_fetch(payload)
        assert isinstance(resp, dict)

    def test_deny_context_contains_web_output_command(self, tmp_data_dir):
        """Deny context must include a usable web-output command with short ID."""
        from unittest.mock import patch

        entry = self._make_entry()
        with (
            patch("token_goat.session.lookup_web_entry", return_value=entry),
            patch("token_goat.compact.get_context_pressure", return_value=self._warm_pressure()),
        ):
            resp = hooks_cli.pre_fetch(self._webfetch_payload("https://example.com/docs"))

        context = str(resp.get("hookSpecificOutput", {}).get("additionalContext", ""))
        assert "web-output" in context
        assert "--grep" in context or "--section" in context


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
        # Fence adds ~70 bytes so 20 KB body stores as ~20.1 KB; accept either rounding
        assert any(s in msg for s in ("20.0 KB", "20 KB", "20.1 KB")), f"Size not in hint: {msg}"
        assert "tokens" in msg.lower(), f"Token estimate not in hint: {msg}"
        # The logged hint mentions --grep as context for what the user can do
        assert "--grep" in msg, f"--grep reference expected in hint: {msg}"
