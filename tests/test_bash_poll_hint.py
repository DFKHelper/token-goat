"""Tests for _handle_bash_poll_hint (iter 11 — polling-loop detection advisory)."""
from __future__ import annotations

import time
from typing import Any
from unittest.mock import MagicMock, patch


def _bash_payload(command: str, session_id: str = "sess-poll", cwd: str = "/proj") -> dict[str, Any]:
    return {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "session_id": session_id,
        "cwd": cwd,
    }


def _make_entry(run_count: int, age_secs: float = 5.0) -> Any:
    from token_goat.session import BashEntry
    entry = MagicMock(spec=BashEntry)
    entry.run_count = run_count
    entry.ts = time.time() - age_secs
    entry.output_id = "abc123"
    return entry


class TestHandleBashPollHint:
    def _call(self, command: str, run_count: int = 2, age_secs: float = 5.0) -> Any:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_poll_hint

        entry = _make_entry(run_count, age_secs)

        with (
            patch.object(sess_mod, "safe_load", return_value=MagicMock()),
            patch.object(sess_mod, "lookup_bash_entry", return_value=entry),
            patch("token_goat.bash_cache.command_hash", return_value="deadbeef"),
        ):
            return _handle_bash_poll_hint(_bash_payload(command))

    def test_gh_run_view_triggers_hint(self) -> None:
        resp = self._call("gh run view 12345", run_count=2)
        assert resp is not None

    def test_curl_triggers_hint(self) -> None:
        resp = self._call("curl https://api.example.com/status", run_count=2)
        assert resp is not None

    def test_hint_mentions_run_count(self) -> None:
        resp = self._call("gh run view 12345", run_count=3)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "3" in ctx

    def test_hint_contains_loop_suggestion(self) -> None:
        resp = self._call("gh run view 12345", run_count=2)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "until" in ctx or "loop" in ctx.lower() or "sleep" in ctx

    def test_hint_contains_cached_output_reference(self) -> None:
        resp = self._call("gh run view 12345", run_count=2)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "bash-output" in ctx or "abc123" in ctx

    def test_first_run_no_hint(self) -> None:
        resp = self._call("gh run view 12345", run_count=0)
        assert resp is None

    def test_second_run_no_hint(self) -> None:
        resp = self._call("gh run view 12345", run_count=1)
        assert resp is None

    def test_stale_entry_no_hint(self) -> None:
        resp = self._call("gh run view 12345", run_count=5, age_secs=700.0)
        assert resp is None

    def test_near_stale_boundary_still_hints(self) -> None:
        resp = self._call("gh run view 12345", run_count=5, age_secs=599.0)
        assert resp is not None

    def test_non_polling_command_no_hint(self) -> None:
        resp = self._call("pytest tests/ -q", run_count=3)
        assert resp is None

    def test_no_session_no_hint(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_poll_hint

        with patch.object(sess_mod, "safe_load", return_value=None):
            resp = _handle_bash_poll_hint(_bash_payload("gh run view 12345"))
        assert resp is None

    def test_hint_is_advisory_not_deny(self) -> None:
        resp = self._call("gh run view 12345", run_count=2)
        assert resp is not None
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"

    def test_ping_triggers_hint(self) -> None:
        resp = self._call("ping 8.8.8.8", run_count=2)
        assert resp is not None
