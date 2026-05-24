"""Tests for read_commands helpers — Item 15: --no-header / TTY auto-detection."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

import pytest

from token_goat.read_commands import _emit_text_result

# ---------------------------------------------------------------------------
# Item 15 — _emit_text_result header suppression
# ---------------------------------------------------------------------------

def test_emit_no_header_flag_suppresses(capsys: pytest.CaptureFixture[str]) -> None:
    """--no-header always suppresses the ## header regardless of TTY state."""
    with patch.object(sys.stdout, "isatty", return_value=True):
        _emit_text_result("body text", "src/foo.py", "my_func", "symbol", no_header=True)
    out = capsys.readouterr().out
    assert "##" not in out
    assert "body text" in out


def test_emit_tty_shows_header(capsys: pytest.CaptureFixture[str]) -> None:
    """In a TTY context with no_header=False, the ## header is prepended."""
    with patch.object(sys.stdout, "isatty", return_value=True):
        _emit_text_result("body text", "src/foo.py", "my_func", "symbol", no_header=False)
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0] == "## src/foo.py — symbol: my_func"
    assert "body text" in out


def test_emit_non_tty_suppresses_header_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    """In a non-TTY context (pipe/capture), header is suppressed even with no_header=False."""
    with patch.object(sys.stdout, "isatty", return_value=False):
        _emit_text_result("body text", "src/foo.py", "my_func", "symbol", no_header=False)
    out = capsys.readouterr().out
    assert "##" not in out
    assert "body text" in out


def test_emit_section_header_label(capsys: pytest.CaptureFixture[str]) -> None:
    """The header uses the separator_label passed in (e.g. 'heading' for section)."""
    with patch.object(sys.stdout, "isatty", return_value=True):
        _emit_text_result("section body", "README.md", "Install", "heading", no_header=False)
    out = capsys.readouterr().out
    assert "## README.md — heading: Install" in out


# ---------------------------------------------------------------------------
# Integration: read / section CLI commands pass no_header correctly
# ---------------------------------------------------------------------------

def _make_mock_result(text: str = "result text", bytes_total: int = 1000, bytes_extracted: int = 50) -> dict:
    return {
        "text": text,
        "start_line": 1,
        "end_line": 5,
        "bytes_total": bytes_total,
        "bytes_extracted": bytes_extracted,
        "bytes_saved": bytes_total - bytes_extracted,
    }


def _make_file_target(rel_path: str = "src/foo.py") -> MagicMock:
    proj = MagicMock()
    proj.hash = "abc123"
    proj.root = MagicMock()
    ft = MagicMock()
    ft.rel_path = rel_path
    ft.project = proj
    return ft


def test_run_read_like_command_no_header_non_tty(capsys: pytest.CaptureFixture[str]) -> None:
    """_run_read_like_command with no_header=True never emits a ## line."""
    from token_goat.read_commands import _run_read_like_command  # noqa: PLC0415

    mock_result = _make_mock_result()
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch.object(sys.stdout, "isatty", return_value=False),
    ):
        _run_read_like_command(
            target="src/foo.py::my_func",
            session_id=None,
            json_output=False,
            context_lines=0,
            separator_label="symbol",
            missing_label="Symbol",
            stat_kind="read_replacement",
            reader=mock_reader,
            no_header=True,
        )

    out = capsys.readouterr().out
    assert "##" not in out
    assert "result text" in out


def test_run_read_like_command_with_header_tty(capsys: pytest.CaptureFixture[str]) -> None:
    """_run_read_like_command with no_header=False in TTY emits the ## header."""
    from token_goat.read_commands import _run_read_like_command  # noqa: PLC0415

    mock_result = _make_mock_result()
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch.object(sys.stdout, "isatty", return_value=True),
    ):
        _run_read_like_command(
            target="src/foo.py::my_func",
            session_id=None,
            json_output=False,
            context_lines=0,
            separator_label="symbol",
            missing_label="Symbol",
            stat_kind="read_replacement",
            reader=mock_reader,
            no_header=False,
        )

    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0] == "## src/foo.py — symbol: my_func"
    assert "result text" in out
