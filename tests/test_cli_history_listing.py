"""Direct unit tests for the _run_history_listing_command helper (DRY#6)."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from token_goat.cli import _run_history_listing_command


def _make_cache_module(entries: list[dict] | None = None, sidecar: object | None = None) -> MagicMock:
    mod = MagicMock()
    mod.list_outputs.return_value = entries if entries is not None else []
    mod.read_sidecar.return_value = sidecar
    return mod


def _entry(output_id: str = "abc123", size_bytes: int = 1024, mtime: float = 0.0) -> dict:
    return {"output_id": output_id, "size_bytes": size_bytes, "mtime": mtime}


# ---------------------------------------------------------------------------
# Empty-state
# ---------------------------------------------------------------------------

def test_empty_state_prints_message(capsys: pytest.CaptureFixture[str]) -> None:
    cache = _make_cache_module(entries=[])
    _run_history_listing_command(
        cache,
        json_output=False,
        limit=20,
        empty_msg="(nothing here)",
        json_sidecar_fields=lambda s: {},
        format_entry=lambda oid, size, age, s: f"{oid}",
    )
    assert "(nothing here)" in capsys.readouterr().out


def test_empty_state_json_returns_empty_list(capsys: pytest.CaptureFixture[str]) -> None:
    cache = _make_cache_module(entries=[])
    _run_history_listing_command(
        cache,
        json_output=True,
        limit=20,
        empty_msg="(nothing here)",
        json_sidecar_fields=lambda s: {},
        format_entry=lambda oid, size, age, s: "",
    )
    out = json.loads(capsys.readouterr().out)
    assert out == []


# ---------------------------------------------------------------------------
# Limit
# ---------------------------------------------------------------------------

def test_limit_truncates_entries(capsys: pytest.CaptureFixture[str]) -> None:
    entries = [_entry(output_id=f"id{i}") for i in range(10)]
    cache = _make_cache_module(entries=entries)
    _run_history_listing_command(
        cache,
        json_output=False,
        limit=3,
        empty_msg="",
        json_sidecar_fields=lambda s: {},
        format_entry=lambda oid, size, age, s: oid,
    )
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 3
    assert out[0] == "id0"


def test_limit_zero_shows_all(capsys: pytest.CaptureFixture[str]) -> None:
    entries = [_entry(output_id=f"id{i}") for i in range(5)]
    cache = _make_cache_module(entries=entries)
    _run_history_listing_command(
        cache,
        json_output=False,
        limit=0,
        empty_msg="",
        json_sidecar_fields=lambda s: {},
        format_entry=lambda oid, size, age, s: oid,
    )
    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 5


# ---------------------------------------------------------------------------
# Plain-text format_entry callback
# ---------------------------------------------------------------------------

def test_format_entry_receives_correct_args(capsys: pytest.CaptureFixture[str]) -> None:
    sidecar = SimpleNamespace(cmd_preview="echo hi", exit_code=0)
    cache = _make_cache_module(entries=[_entry("myid", size_bytes=512)], sidecar=sidecar)
    seen: list[tuple] = []

    def _fmt(oid: str, size: int, age: int, s: object) -> str:
        seen.append((oid, size, s))
        return f"{oid}:{size}"

    _run_history_listing_command(
        cache,
        json_output=False,
        limit=20,
        empty_msg="",
        json_sidecar_fields=lambda s: {},
        format_entry=_fmt,
    )
    assert len(seen) == 1
    assert seen[0][0] == "myid"
    assert seen[0][1] == 512
    assert seen[0][2] is sidecar
    assert "myid:512" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# JSON output — sidecar fields merged
# ---------------------------------------------------------------------------

def test_json_merges_sidecar_fields(capsys: pytest.CaptureFixture[str]) -> None:
    sidecar = SimpleNamespace(url_preview="https://example.com", status_code=200, truncated=False)
    cache = _make_cache_module(entries=[_entry("webid")], sidecar=sidecar)

    _run_history_listing_command(
        cache,
        json_output=True,
        limit=20,
        empty_msg="",
        json_sidecar_fields=lambda s: {
            "url_preview": s.url_preview,  # type: ignore[attr-defined]
            "status_code": s.status_code,  # type: ignore[attr-defined]
        },
        format_entry=lambda oid, size, age, s: "",
    )
    rows = json.loads(capsys.readouterr().out)
    assert len(rows) == 1
    assert rows[0]["url_preview"] == "https://example.com"
    assert rows[0]["status_code"] == 200


def test_json_no_sidecar_omits_extra_fields(capsys: pytest.CaptureFixture[str]) -> None:
    cache = _make_cache_module(entries=[_entry("noid")], sidecar=None)

    _run_history_listing_command(
        cache,
        json_output=True,
        limit=20,
        empty_msg="",
        json_sidecar_fields=lambda s: {"url_preview": s.url_preview},  # type: ignore[attr-defined]
        format_entry=lambda oid, size, age, s: "",
    )
    rows = json.loads(capsys.readouterr().out)
    assert "url_preview" not in rows[0]
    assert rows[0]["output_id"] == "noid"
