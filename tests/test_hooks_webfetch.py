"""Tests for the WebFetch intercept in pre_fetch hook — Phase 14."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import assert_deny as _assert_deny

from token_goat import hooks_cli, session, web_cache

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

        _assert_deny(result)

    def test_additional_context_mentions_fetch_image(self, tmp_data_dir):
        url = "https://cdn.example.com/banner.png"
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": url},
        }
        result = hooks_cli.pre_fetch(payload)

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "token-goat fetch-image" in ctx
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

        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_json_url_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://api.example.com/data.json"},
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)

    def test_bare_domain_url_passes_through(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/"},
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)


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

        _assert_continue(result)

    def test_empty_tool_input(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {},
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)

    def test_none_tool_input(self, tmp_data_dir):
        payload = {
            "tool_name": "WebFetch",
            "tool_input": None,
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)


# ---------------------------------------------------------------------------
# 13. pre_fetch with WebFetch on previously-fetched URL → dedup hint injected
# ---------------------------------------------------------------------------

_DEDUP_URL = "https://docs.example.com/api/reference"
_LARGE_BODY_BYTES = 5000  # above _WEB_DEDUP_MIN_BYTES (1024)


def _seed_web_session(sid: str, *, body_bytes: int = _LARGE_BODY_BYTES) -> str:
    """Record a web fetch in the session cache and return the output_id."""
    url_sha = web_cache.url_hash(_DEDUP_URL)
    output_id = f"{sid[:16]}-0000000099999-{url_sha}"
    session.mark_web_fetch(
        session_id=sid,
        url_sha=url_sha,
        url_preview=_DEDUP_URL,
        output_id=output_id,
        body_bytes=body_bytes,
        status_code=200,
        truncated=False,
    )
    return output_id


class TestPreFetchWebFetchDedup:
    """pre_fetch injects a recall hint when the URL was already fetched this session."""

    def _payload(self, url: str = _DEDUP_URL) -> dict:
        return {
            "tool_name": "WebFetch",
            "tool_input": {"url": url},
            "session_id": "dedup-test-session",
        }

    def test_cache_hit_injects_hint(self, tmp_data_dir):
        """When a URL was fetched before, pre_fetch must inject an additionalContext hint."""
        sid = "dedup-test-session"
        output_id = _seed_web_session(sid)

        result = hooks_cli.pre_fetch(self._payload())

        # Hook must continue (not deny) but include an advisory hint
        assert result.get("continue") is True
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert output_id in ctx, f"output_id {output_id!r} not in hint: {ctx!r}"
        assert "token-goat web-output" in ctx

    def test_cache_hit_hint_mentions_age(self, tmp_data_dir):
        """Hint text must tell the model how long ago the fetch happened."""
        sid = "dedup-test-session"
        _seed_web_session(sid)

        result = hooks_cli.pre_fetch(self._payload())

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "age ~" in ctx

    def test_cache_hit_hint_mentions_byte_size(self, tmp_data_dir):
        """Hint text must include body size so model can judge recall value."""
        sid = "dedup-test-session"
        _seed_web_session(sid)

        result = hooks_cli.pre_fetch(self._payload())

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "B" in ctx  # byte size shown as e.g. "5,000B"

    def test_cache_miss_passes_through(self, tmp_data_dir):
        """A URL that was never fetched must not produce a hint — just CONTINUE."""
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://new.example.com/never-fetched"},
            "session_id": "dedup-test-session",
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_no_session_id_passes_through(self, tmp_data_dir):
        """Without a session_id, the hook must fall back to CONTINUE cleanly."""
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": _DEDUP_URL},
            # no session_id key
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)

    def test_small_body_no_hint(self, tmp_data_dir):
        """Bodies below the dedup threshold (1 KB) must not generate a hint."""
        sid = "dedup-small-session"
        _seed_web_session(sid, body_bytes=100)  # below _WEB_DEDUP_MIN_BYTES

        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": _DEDUP_URL},
            "session_id": sid,
        }
        result = hooks_cli.pre_fetch(payload)

        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_image_url_still_denied_not_dedup(self, tmp_data_dir):
        """Image URLs must take the image-redirect path, not the dedup path."""
        img_url = "https://example.com/photo.jpg"
        # Seed the image URL as if it had been fetched (it shouldn't matter)
        sid = "dedup-test-session"
        url_sha = web_cache.url_hash(img_url)
        session.mark_web_fetch(
            session_id=sid,
            url_sha=url_sha,
            url_preview=img_url,
            output_id="img-output-001",
            body_bytes=50000,
            status_code=200,
            truncated=False,
        )
        payload = {
            "tool_name": "WebFetch",
            "tool_input": {"url": img_url},
            "session_id": sid,
        }
        result = hooks_cli.pre_fetch(payload)

        # Must be denied (image redirect), not a dedup hint
        _assert_deny(result)
        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "token-goat fetch-image" in ctx

    def test_hint_does_not_start_with_note(self, tmp_data_dir):
        """Dedup hint text must not start with 'Note:' (consistent with bash/grep hints)."""
        sid = "dedup-test-session"
        _seed_web_session(sid)

        result = hooks_cli.pre_fetch(self._payload())

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert ctx, "Expected a non-empty additionalContext"
        assert not ctx.startswith("Note:"), f"Hint starts with 'Note:': {ctx[:60]!r}"
