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
        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=skeleton),
            patch("token_goat.db.record_stat"),
        ):
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


# ---------------------------------------------------------------------------
# Unit tests for _handle_indexed_cat_advisory (cool-tier non-blocking nudge)
# ---------------------------------------------------------------------------

class _FakeCache:
    """Minimal session cache implementing only the dedup surface emit_if_new_hint touches."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self.emitted: list[str] = []

    def has_hint_fingerprint(self, fp: str) -> bool:
        return fp in self._seen

    def mark_hint_seen(self, fp: str) -> None:
        self._seen.add(fp)

    def record_hint_emitted(self, stat_key: str) -> None:
        self.emitted.append(stat_key)


class TestHandleIndexedCatAdvisory:
    def _call(self, file_path: str, tool_input: dict, skeleton: str, cache: Any) -> Any:
        from token_goat.hooks_read import _handle_indexed_cat_advisory
        with (
            patch("token_goat.hooks_read._try_get_inline_skeleton", return_value=skeleton),
            patch("token_goat.db.record_stat"),
        ):
            return _handle_indexed_cat_advisory(file_path, tool_input, cache)

    def test_indexed_whole_file_returns_advisory(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "  10  function  my_func", _FakeCache())
        assert resp is not None
        # Advisory is non-blocking: a context hint, NOT a deny.
        hso = resp.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"
        ctx = hso.get("additionalContext", "")
        assert "token-goat read" in ctx
        assert "my_func" in ctx
        assert "foo.py" in ctx

    def test_advisory_names_the_exact_read_command(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "service.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "  1  class  MyService", _FakeCache())
        ctx = resp["hookSpecificOutput"]["additionalContext"]
        assert f'token-goat read "{fp}::<symbol>"' in ctx
        assert "token-goat skeleton" in ctx

    def test_non_indexed_file_returns_none(self, tmp_path: Path) -> None:
        # README.md / non-source: no skeleton from the index → no hint.
        fp = str(tmp_path / "README.md")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "", _FakeCache())  # empty skeleton == not indexed
        assert resp is None

    def test_windowed_read_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": 30}  # head -n 30
        resp = self._call(fp, ti, "  10  function  my_func", _FakeCache())
        assert resp is None

    def test_offset_windowed_read_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": 10, "limit": None}  # tail -n +10
        resp = self._call(fp, ti, "  10  function  my_func", _FakeCache())
        assert resp is None

    def test_dedup_second_call_returns_none(self, tmp_path: Path) -> None:
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        cache = _FakeCache()
        first = self._call(fp, ti, "  10  function  my_func", cache)
        assert first is not None
        # Same (file, hint) fingerprint already recorded → suppressed.
        second = self._call(fp, ti, "  10  function  my_func", cache)
        assert second is None
        assert cache.emitted == ["indexed_cat_advisory"]

    def test_none_cache_returns_none(self, tmp_path: Path) -> None:
        # emit_if_new_hint returns False when cache is None → no hint.
        fp = str(tmp_path / "foo.py")
        ti: dict[str, Any] = {"file_path": fp, "offset": None, "limit": None}
        resp = self._call(fp, ti, "  10  function  my_func", None)
        assert resp is None


class TestIndexedCatAdvisoryEndToEnd:
    """Drive _handle_indexed_cat_advisory against a *real* indexed project (no skeleton mock)."""

    def test_real_indexed_file_emits_advisory(self, py_project_tuple: Any) -> None:
        from token_goat.hooks_read import _handle_indexed_cat_advisory

        proj_root, _proj = py_project_tuple
        app_py = str(proj_root / "app.py")
        ti: dict[str, Any] = {"file_path": app_py, "offset": None, "limit": None}
        resp = _handle_indexed_cat_advisory(app_py, ti, _FakeCache())
        assert resp is not None
        ctx = resp["hookSpecificOutput"]["additionalContext"]
        # Pulled from the live index: UserService/greet are real symbols in app.py.
        assert "UserService" in ctx
        assert 'token-goat read "' in ctx

    def test_real_non_source_file_no_advisory(self, py_project_tuple: Any) -> None:
        from token_goat.hooks_read import _handle_indexed_cat_advisory

        proj_root, _proj = py_project_tuple
        # A plain text file the indexer has no symbols for → no hint.
        plain = proj_root / "notes.txt"
        plain.write_text("just some notes, not source\n", encoding="utf-8")
        ti: dict[str, Any] = {"file_path": str(plain), "offset": None, "limit": None}
        resp = _handle_indexed_cat_advisory(str(plain), ti, _FakeCache())
        assert resp is None
