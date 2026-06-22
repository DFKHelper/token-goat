"""Tests for _handle_bash_range_read_hint (iter 8 — sed/awk windowed read advisory)."""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest


def _bash_payload(command: str, session_id: str = "sess-1", cwd: str = "C:/proj") -> dict[str, Any]:
    return {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "session_id": session_id,
        "cwd": cwd,
    }


SKELETON = "   10  function  my_func\n   50  function  other_func"


class TestHandleBashRangeReadHint:
    @pytest.fixture(autouse=True)
    def _no_db_stat(self, monkeypatch):
        """Prevent db.record_stat from running expensive SQLite integrity checks."""
        monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)

    def _call(self, command: str, skeleton: str = SKELETON, target: str = "/proj/foo.py") -> Any:
        from dataclasses import replace

        from token_goat import bash_parser
        from token_goat.hooks_read import _handle_bash_range_read_hint

        intent_override = bash_parser.parse(command)
        if intent_override.kind == "read" and intent_override.target_path is None:
            intent_override = replace(intent_override, target_path=target)

        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=skeleton),
            patch("token_goat.bash_parser.parse", return_value=intent_override),
        ):
            return _handle_bash_range_read_hint(_bash_payload(command))

    def test_sed_range_indexed_returns_hint(self) -> None:
        resp = self._call("sed -n '10,30p' /proj/foo.py")
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "foo.py" in ctx
        assert "my_func" in ctx

    def test_hint_contains_line_range(self) -> None:
        from dataclasses import replace

        from token_goat import bash_parser
        from token_goat.hooks_read import _handle_bash_range_read_hint

        cmd = "sed -n '10,30p' /proj/foo.py"
        intent = replace(bash_parser.parse(cmd), target_path="/proj/foo.py")
        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=SKELETON),
            patch("token_goat.bash_parser.parse", return_value=intent),
        ):
            resp = _handle_bash_range_read_hint(_bash_payload(cmd))
        assert resp is not None
        ctx = resp.get("additionalContext", "") or resp.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "10" in ctx

    def test_whole_file_cat_returns_none(self) -> None:
        from dataclasses import replace

        from token_goat import bash_parser
        from token_goat.hooks_read import _handle_bash_range_read_hint

        cmd = "cat /proj/foo.py"
        intent = replace(bash_parser.parse(cmd), target_path="/proj/foo.py")
        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=SKELETON),
            patch("token_goat.bash_parser.parse", return_value=intent),
        ):
            resp = _handle_bash_range_read_hint(_bash_payload(cmd))
        assert resp is None

    def test_no_skeleton_returns_none(self) -> None:
        resp = self._call("sed -n '5,15p' /proj/foo.py", skeleton="")
        assert resp is None

    def test_grep_command_returns_none(self) -> None:
        from token_goat.hooks_read import _handle_bash_range_read_hint

        cmd = "rg 'def my_func' /proj/foo.py"
        with patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=SKELETON):
            resp = _handle_bash_range_read_hint(_bash_payload(cmd))
        assert resp is None

    def test_hint_is_advisory_not_deny(self) -> None:
        resp = self._call("sed -n '10,30p' /proj/foo.py")
        assert resp is not None
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"

    def test_head_n_with_offset_returns_hint(self) -> None:
        from dataclasses import replace

        from token_goat import bash_parser
        from token_goat.hooks_read import _handle_bash_range_read_hint

        cmd = "head -n 20 /proj/foo.py"
        intent = replace(bash_parser.parse(cmd), target_path="/proj/foo.py")
        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=SKELETON),
            patch("token_goat.bash_parser.parse", return_value=intent),
        ):
            resp = _handle_bash_range_read_hint(_bash_payload(cmd))
        assert resp is not None
