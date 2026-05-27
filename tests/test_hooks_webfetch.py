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
        # Hint renders the short id (…<last8>), not the full output_id
        from token_goat.cache_common import short_output_id
        assert short_output_id(output_id) in ctx, f"short id for {output_id!r} not in hint: {ctx!r}"
        assert "token-goat web-output" in ctx

    def test_cache_hit_hint_mentions_age(self, tmp_data_dir):
        """Hint text must tell the model how long ago the fetch happened."""
        import re as _re
        sid = "dedup-test-session"
        _seed_web_session(sid)

        result = hooks_cli.pre_fetch(self._payload())

        ctx = result.get("hookSpecificOutput", {}).get("additionalContext", "")
        # Assert the age-suffix concept (Ns inside parens), not the exact
        # "age ~Ns" wording — that prefix was trimmed for token savings.
        assert _re.search(r"\(\d+s\):", ctx), f"expected '(Ns):' age suffix in hint: {ctx!r}"

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


# ---------------------------------------------------------------------------
# _check_url_allowdeny unit tests
# ---------------------------------------------------------------------------

class TestCheckUrlAllowDeny:
    """Unit tests for the deny/allow glob-pattern gating in pre_fetch."""

    def _invoke(self, url: str, *, allow: list[str] | None = None, deny: list[str] | None = None) -> object:
        """Call _check_url_allowdeny with patched config."""
        import unittest.mock as mock

        from token_goat import hooks_fetch
        from token_goat.config import Config, WebFetchConfig

        wf = WebFetchConfig(allow=allow or [], deny=deny or [])
        cfg = mock.MagicMock(spec=Config)
        cfg.webfetch = wf

        with mock.patch("token_goat.config.load", return_value=cfg):
            return hooks_fetch._check_url_allowdeny(url)

    def test_no_lists_passes_everything(self):
        """Empty deny + empty allow → all URLs pass."""
        assert self._invoke("https://example.com/page") is None

    def test_deny_match_blocks_url(self):
        """URL matching a deny pattern → HookResponse deny (not None)."""
        result = self._invoke("https://evil.com/bad", deny=["*evil.com*"])
        assert result is not None
        reason = result.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        assert "deny" in reason.lower() or "block" in reason.lower() or "deny list" in reason.lower()

    def test_deny_match_takes_priority_over_allow(self):
        """URL that matches both deny and allow → blocked (deny wins)."""
        result = self._invoke("https://example.com/path", deny=["*example.com*"], allow=["*example.com*"])
        assert result is not None

    def test_allow_match_passes_url(self):
        """Non-empty allow list + URL that matches → pass (returns None)."""
        result = self._invoke("https://docs.python.org/3/", allow=["*docs.python.org*"])
        assert result is None

    def test_allow_miss_blocks_url(self):
        """Non-empty allow list + URL that does NOT match → blocked."""
        result = self._invoke("https://random-site.io/", allow=["*docs.python.org*"])
        assert result is not None
        reason = result.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
        assert "allow" in reason.lower()

    def test_empty_deny_nonempty_allow_passes_matching(self):
        """No deny, non-empty allow — URL in allow list passes."""
        assert self._invoke("https://github.com/foo", allow=["*github.com*"]) is None

    def test_empty_deny_nonempty_allow_blocks_nonmatching(self):
        """No deny, non-empty allow — URL not in allow list is blocked."""
        result = self._invoke("https://example.com/", allow=["*github.com*"])
        assert result is not None

    def test_deny_non_match_passes(self):
        """URL that does NOT match any deny pattern → passes."""
        assert self._invoke("https://safe.com/page", deny=["*evil.com*"]) is None
