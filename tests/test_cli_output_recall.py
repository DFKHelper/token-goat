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


# ---------------------------------------------------------------------------
# Item 7 — --head-tail flag
# ---------------------------------------------------------------------------

def _make_body(n: int) -> str:
    """Return a body with N numbered lines."""
    return "\n".join(f"line {i}" for i in range(1, n + 1))


def test_head_tail_60_lines_truncates(capsys: pytest.CaptureFixture[str]) -> None:
    """60-line body with --head-tail emits first 20 + omission marker + last 20."""
    body = _make_body(60)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # First 20 lines present
    assert lines[0] == "line 1"
    assert lines[19] == "line 20"
    # Omission marker present
    omit_lines = [ln for ln in lines if "lines omitted" in ln]
    assert len(omit_lines) == 1
    assert "20" in omit_lines[0]
    # Last 20 lines present
    assert lines[-1] == "line 60"
    assert lines[-20] == "line 41"
    # Total: 20 + 1 marker + 20 = 41 lines
    assert len(lines) == 41


def test_head_tail_30_lines_no_truncation(capsys: pytest.CaptureFixture[str]) -> None:
    """30-line body with --head-tail is returned unchanged (no omission marker)."""
    body = _make_body(30)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # All 30 lines present, no marker
    assert len(lines) == 30
    assert not any("lines omitted" in ln for ln in lines)


def test_head_tail_exactly_40_lines_no_truncation(capsys: pytest.CaptureFixture[str]) -> None:
    """Exactly 40-line body (== threshold) is returned unchanged."""
    body = _make_body(40)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep=None,
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            head_tail=True,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert len(lines) == 40
    assert not any("lines omitted" in ln for ln in lines)


# ---------------------------------------------------------------------------
# Item 10 — --grep-max N flag
# ---------------------------------------------------------------------------

def _make_grep_body(match_count: int, noise_count: int = 5) -> str:
    """Return a body with match_count MATCH lines interspersed with noise lines."""
    lines = []
    for i in range(1, match_count + 1):
        lines.append(f"MATCH line {i}")
        if i <= noise_count:
            lines.append(f"noise {i}")
    return "\n".join(lines)


def test_grep_max_caps_results(capsys: pytest.CaptureFixture[str]) -> None:
    """50 matches with --grep-max 5 → 5 lines + count header + truncation footer."""
    body = _make_grep_body(50)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="MATCH",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            grep_max=5,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    # First line is the count header
    assert lines[0] == "Match count: 50"
    # Next 5 lines are match lines
    match_lines = [ln for ln in lines[1:] if ln.startswith("MATCH")]
    assert len(match_lines) == 5
    # Footer present
    footer_lines = [ln for ln in lines if "--grep-max 0" in ln]
    assert len(footer_lines) == 1
    assert "50" in footer_lines[0]


def test_grep_max_zero_no_cap(capsys: pytest.CaptureFixture[str]) -> None:
    """--grep-max 0 returns all matching lines with no truncation footer."""
    body = _make_grep_body(50)
    cache = _make_cache_module(body=body)
    with patch("token_goat.db.record_stat"):
        _run_output_recall_command(
            output_id="x",
            head=0,
            tail=0,
            grep="MATCH",
            full=False,
            json_output=False,
            cache_module=cache,
            stat_kind="bash_output_recall",
            not_found_msg="not found",
            grep_max=0,
        )
    out = capsys.readouterr().out
    lines = out.splitlines()
    match_lines = [ln for ln in lines if ln.startswith("MATCH")]
    assert len(match_lines) == 50
    assert not any("--grep-max 0" in ln for ln in lines)


def test_grep_max_default_constant_is_20() -> None:
    """_GREP_MAX_DEFAULT is 20 per the design spec."""
    from token_goat.cli import _GREP_MAX_DEFAULT  # noqa: PLC0415
    assert _GREP_MAX_DEFAULT == 20


def test_apply_grep_cap_no_truncation() -> None:
    """_apply_grep_cap returns unchanged list when matches <= grep_max."""
    from token_goat.cli import _apply_grep_cap  # noqa: PLC0415
    lines = [f"line {i}" for i in range(10)]
    result, footer = _apply_grep_cap(lines, 20)
    assert result == lines
    assert footer == ""


def test_apply_grep_cap_truncates() -> None:
    """_apply_grep_cap truncates and returns footer when matches > grep_max."""
    from token_goat.cli import _apply_grep_cap  # noqa: PLC0415
    lines = [f"line {i}" for i in range(30)]
    result, footer = _apply_grep_cap(lines, 10)
    assert result == lines[:10]
    assert "--grep-max 0" in footer
    assert "30" in footer
