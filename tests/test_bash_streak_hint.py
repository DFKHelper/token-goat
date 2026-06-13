"""Tests for _handle_bash_streak_hint (iter 10 — repeat Bash file-read advisory)."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch


def _bash_payload(command: str, session_id: str = "sess-streak", cwd: str = "C:/proj") -> dict[str, Any]:
    return {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "session_id": session_id,
        "cwd": cwd,
    }


def _make_cache(read_count: int) -> Any:
    import time as _time

    from token_goat.session import FileEntry, SessionCache
    cache = MagicMock(spec=SessionCache)
    cache.last_compact_ts = 0.0  # no compact occurred — hints fire normally
    entry = MagicMock(spec=FileEntry)
    entry.read_count = read_count
    entry.last_read_ts = _time.time()  # post-compact guard: content is in window
    cache.files = {"c:/proj/foo.py": entry}
    return cache


SKELETON = "   10  function  my_func\n   50  function  other_func"


class TestHandleBashStreakHint:
    def _call(self, command: str, read_count: int = 2, skeleton: str = SKELETON) -> Any:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_streak_hint

        cache = _make_cache(read_count)

        with (
            patch.object(sess_mod, "safe_load", return_value=cache),
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=skeleton),
            patch("token_goat.paths.normalize_key", return_value="c:/proj/foo.py"),
        ):
            return _handle_bash_streak_hint(_bash_payload(command))

    def test_third_read_returns_hint(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=2)
        assert resp is not None

    def test_hint_mentions_filename(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=2)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "foo.py" in ctx

    def test_hint_includes_read_count(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=3)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "3" in ctx

    def test_hint_includes_skeleton_when_available(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=2, skeleton=SKELETON)
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "my_func" in ctx

    def test_first_read_returns_none(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=0)
        assert resp is None

    def test_second_read_returns_none(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=1)
        assert resp is None

    def test_no_skeleton_returns_generic_hint(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=2, skeleton="")
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "token-goat" in ctx

    def test_non_read_command_returns_none(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_streak_hint

        cache = _make_cache(5)
        with patch.object(sess_mod, "safe_load", return_value=cache):
            resp = _handle_bash_streak_hint(_bash_payload("pytest tests/"))
        assert resp is None

    def test_hint_is_advisory_not_deny(self) -> None:
        resp = self._call("cat /proj/foo.py", read_count=2)
        assert resp is not None
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"

    def test_no_session_returns_none(self) -> None:
        from token_goat import session as sess_mod
        from token_goat.hooks_read import _handle_bash_streak_hint

        with patch.object(sess_mod, "safe_load", return_value=None):
            resp = _handle_bash_streak_hint(_bash_payload("cat /proj/foo.py"))
        assert resp is None
