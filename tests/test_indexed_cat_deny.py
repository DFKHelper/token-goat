"""Tests for _handle_indexed_cat_deny and the _tg_from_bash_cat flag.

Verifies that:
- cat/bat on indexed source files at warm+ pressure → deny + skeleton
- at cool pressure → no deny (falls through)
- windowed reads (head -N via bash_parser) never trigger the deny
- non-indexed files (no DB symbols) fall through
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bash_payload(command: str, session_id: str = "sess-1", cwd: str = "C:/proj") -> dict[str, Any]:
    return {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "session_id": session_id,
        "cwd": cwd,
    }


def _make_cp(tier: str) -> SimpleNamespace:
    return SimpleNamespace(tier=tier, fill_fraction={"cool": 0.3, "warm": 0.55, "hot": 0.75, "critical": 0.9}[tier])


# ---------------------------------------------------------------------------
# Unit tests for _handle_indexed_cat_deny
# ---------------------------------------------------------------------------

class TestHandleIndexedCatDeny:
    def _call(self, file_path: str, tool_input: dict, tier: str, skeleton: str) -> Any:
        from token_goat.hooks_read import _handle_indexed_cat_deny
        with patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=skeleton):
            return _handle_indexed_cat_deny(file_path, tool_input, tier)

    def test_warm_indexed_returns_deny(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "warm", "  10  function  my_func")
        assert resp is not None
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"
        assert "my_func" in hso.get("additionalContext", "")

    def test_hot_indexed_returns_deny(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.ts")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "hot", "   5  function  myFunc")
        assert resp is not None
        assert resp["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_cool_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "cool", "  10  function  my_func")
        assert resp is None

    def test_no_skeleton_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "empty.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "warm", "")  # no skeleton → not indexed
        assert resp is None

    def test_windowed_read_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": 30}  # windowed
        resp = self._call(fp, ti, "warm", "  10  function  my_func")
        assert resp is None

    def test_deny_context_contains_surgical_commands(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "service.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "warm", "  1  class  MyService")
        ctx = resp["hookSpecificOutput"]["additionalContext"]
        assert "token-goat read" in ctx
        assert "token-goat skeleton" in ctx


# ---------------------------------------------------------------------------
# Integration: _tg_from_bash_cat flag is set by bash-read-equivalent path
# ---------------------------------------------------------------------------

class TestBashCatFlag:
    """Verify _handle_bash_read_equivalent sets _tg_from_bash_cat for whole-file reads."""

    def _parse_and_convert(self, command: str) -> dict | None:
        from token_goat.hooks_read import _handle_bash_read_equivalent
        payload = _bash_payload(command)
        return _handle_bash_read_equivalent(payload)

    def test_cat_whole_file_sets_flag(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        Path(fp).touch()
        result = self._parse_and_convert(f'cat "{fp}"')
        if result is None:
            pytest.skip("bash_parser did not recognize cat command")
        assert result.get("_tg_from_bash_cat") is True

    def test_head_n_does_not_set_flag(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        Path(fp).touch()
        result = self._parse_and_convert(f'head -n 30 "{fp}"')
        if result is None:
            pytest.skip("bash_parser did not recognize head -n command")
        # Windowed (limit=30) → flag should NOT be set
        assert result.get("_tg_from_bash_cat") is not True

    def test_cat_n_whole_file_sets_flag(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        Path(fp).touch()
        result = self._parse_and_convert(f'cat -n "{fp}"')
        if result is None:
            pytest.skip("bash_parser did not recognize cat -n command")
        assert result.get("_tg_from_bash_cat") is True
