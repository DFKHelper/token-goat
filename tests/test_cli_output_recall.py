"""Direct unit tests for the _run_output_recall_command helper (DRY#5)."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from token_goat.cli import _run_output_recall_command


class _FakeSidecar(SimpleNamespace):
    """Mimics a BashOutputMeta / WebOutputMeta dataclass for sidecar tests."""


def _make_cache_module(
    body: str | None = "line1\nline2\nline3",
    meta: dict | None = None,
    sidecar: object | None = None,
) -> MagicMock:
    mod = MagicMock()
    mod.load_output.return_value = body
    mod.load_output_meta.return_value = meta
    mod.read_sidecar.return_value = sidecar
    return mod


def test_helper_directly_plain_text(capsys: pytest.CaptureFixture[str]) -> None:
    """Plain-text recall returns the full body when no slicing flags are set and
    the output is below the smart-default threshold."""
    cache = _make_cache_module(body="alpha\nbeta\ngamma")
    with patch("token_goat.db.record_stat") as mock_db:
        _run_output_recall_command(
            output_id="sess-abc-001",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    assert "alpha" in captured.out
    assert "beta" in captured.out
    assert "gamma" in captured.out
    # record_stat must be called with the correct stat kind
    mock_db.assert_called_once()
    call_args = mock_db.call_args
    assert call_args[0][1] == "bash_output_recall"


def test_helper_directly_grep_filter(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep filters lines correctly."""
    cache = _make_cache_module(body="PASS: foo\nFAIL: bar\nPASS: baz")
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="PASS",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    assert "PASS: foo" in captured.out
    assert "PASS: baz" in captured.out
    assert "FAIL" not in captured.out


def test_helper_directly_json_output(capsys: pytest.CaptureFixture[str]) -> None:
    """JSON mode returns valid JSON with expected keys."""
    sidecar = _FakeSidecar(cmd_preview="pytest tests/", exit_code=0, truncated=False)
    cache = _make_cache_module(
        body="line1\nline2",
        meta={"bytes_stored": 12},
        sidecar=sidecar,
    )
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="out-123",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=True,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
        )
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert data["output_id"] == "out-123"
    assert "numbered_lines" in data
    assert "total_lines" in data
    # sidecar fields written via vars(sidecar)
    assert data["cmd_preview"] == "pytest tests/"
    assert data["exit_code"] == 0
    assert data["bytes_stored"] == 12


def test_helper_directly_not_found() -> None:
    """Missing cache entry raises typer.Exit(1)."""
    import click  # noqa: PLC0415

    cache = _make_cache_module(body=None)
    with patch("token_goat.db.record_stat"), pytest.raises(click.exceptions.Exit) as exc_info:
        _run_output_recall_command(
            output_id="missing",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="no cached output for id: missing",
        )
    assert exc_info.value.exit_code == 1


def test_helper_web_stat_kind(capsys: pytest.CaptureFixture[str]) -> None:
    """web-output recall uses web_output_recall as the stat kind."""
    sidecar = _FakeSidecar(url_preview="https://example.com", status_code=200, truncated=False)
    cache = _make_cache_module(body="hello", sidecar=sidecar)
    with patch("token_goat.db.record_stat") as mock_db:
        _run_output_recall_command(
            output_id="web-001",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="web_output_recall",
            not_found_msg="not found",
        )
    call_args = mock_db.call_args
    assert call_args[0][1] == "web_output_recall"
