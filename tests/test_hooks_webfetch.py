"""Tests for the WebFetch intercept in pre_fetch hook — Phase 14."""
from __future__ import annotations

from tokenwise import hooks_cli

# ---------------------------------------------------------------------------
# 10. pre_fetch with WebFetch on image URL → deny + additionalContext
# ---------------------------------------------------------------------------

class TestPreFetchWebFetchImageUrl:
    def test_image_url_gets_denied(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/photo.jpg"},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result["continue"] is True
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"

    def test_additional_context_mentions_fetch_image(self, tmp_data_dir):
        url = "https://cdn.example.com/banner.png"
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": url},
        }
        result = hooks_cli.pre_fetch(payload)

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "tokenwise fetch-image" in ctx
        assert url in ctx

    def test_hook_event_name_is_correct(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/img.webp"},
        }
        result = hooks_cli.pre_fetch(payload)

        hso = result.get("hookSpecificOutput", {})
        assert hso.get("hookEventName") == "PreToolUse"

    def test_context_mentions_read(self, tmp_data_dir):
        """additionalContext should tell Claude to Read the returned path."""
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/photo.avif"},
        }
        result = hooks_cli.pre_fetch(payload)

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "Read" in ctx

    def test_permission_decision_reason_set(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/img.gif"},
        }
        result = hooks_cli.pre_fetch(payload)

        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecisionReason")


# ---------------------------------------------------------------------------
# 11. pre_fetch with WebFetch on non-image URL → continue:true, no deny
# ---------------------------------------------------------------------------

class TestPreFetchWebFetchNonImageUrl:
    def test_html_url_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/page.html"},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}
        assert "hookSpecificOutput" not in result

    def test_json_url_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://api.example.com/data.json"},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}

    def test_bare_domain_url_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/"},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}


# ---------------------------------------------------------------------------
# 12. pre_fetch with WebFetch and missing url → continue:true
# ---------------------------------------------------------------------------

class TestPreFetchWebFetchNoUrl:
    def test_missing_url_field(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"prompt": "what is this page about?"},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}

    def test_empty_tool_input(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {},
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}

    def test_none_tool_input(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": None,
        }
        result = hooks_cli.pre_fetch(payload)

        assert result == {"continue": True}
