"""Tests for read_commands helpers — Item 15: --no-header / TTY auto-detection."""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from token_goat.read_commands import _emit_text_result

FIXTURE_DIR = Path(__file__).parent / "fixtures"

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


# ---------------------------------------------------------------------------
# _apply_context_gutter — context line visual distinction
# ---------------------------------------------------------------------------

def test_apply_context_gutter_no_context() -> None:
    from token_goat.read_commands import _apply_context_gutter
    text = "line1\nline2\nline3"
    result = _apply_context_gutter(text, 0, 0, no_color=False)
    assert result == text


def test_apply_context_gutter_no_color_passthrough() -> None:
    from token_goat.read_commands import _apply_context_gutter
    text = "ctx1\nbody1\nbody2\nctx2"
    result = _apply_context_gutter(text, 1, 1, no_color=True)
    assert result == text


def test_apply_context_gutter_dims_before_and_after() -> None:
    from token_goat.read_commands import _ANSI_DIM, _ANSI_RESET, _apply_context_gutter
    text = "ctx_before\nbody_line\nctx_after"
    result = _apply_context_gutter(text, 1, 1, no_color=False)
    lines = result.split("\n")
    assert _ANSI_DIM in lines[0] and "ctx_before" in lines[0] and _ANSI_RESET in lines[0]
    assert _ANSI_DIM not in lines[1] and "body_line" in lines[1]
    assert _ANSI_DIM in lines[2] and "ctx_after" in lines[2] and _ANSI_RESET in lines[2]


def test_apply_context_gutter_only_before() -> None:
    from token_goat.read_commands import _ANSI_DIM, _apply_context_gutter
    text = "ctx1\nctx2\nbody"
    result = _apply_context_gutter(text, 2, 0, no_color=False)
    lines = result.split("\n")
    assert _ANSI_DIM in lines[0]
    assert _ANSI_DIM in lines[1]
    assert _ANSI_DIM not in lines[2]


def test_apply_context_gutter_only_after() -> None:
    from token_goat.read_commands import _ANSI_DIM, _apply_context_gutter
    text = "body\nctx1\nctx2"
    result = _apply_context_gutter(text, 0, 2, no_color=False)
    lines = result.split("\n")
    assert _ANSI_DIM not in lines[0]
    assert _ANSI_DIM in lines[1]
    assert _ANSI_DIM in lines[2]


def test_emit_text_result_context_gutter_on_tty(capsys: pytest.CaptureFixture[str]) -> None:
    from token_goat.read_commands import _ANSI_DIM
    with patch.object(sys.stdout, "isatty", return_value=True):
        _emit_text_result(
            "before\nbody\nafter",
            "src/foo.py", "my_func", "symbol",
            no_header=True,
            context_before=1, context_after=1, no_color=False,
        )
    out = capsys.readouterr().out
    assert _ANSI_DIM in out
    assert "before" in out
    assert "body" in out
    assert "after" in out


def test_emit_text_result_no_color_suppresses_ansi(capsys: pytest.CaptureFixture[str]) -> None:
    from token_goat.read_commands import _ANSI_DIM
    with patch.object(sys.stdout, "isatty", return_value=True):
        _emit_text_result(
            "before\nbody\nafter",
            "src/foo.py", "my_func", "symbol",
            no_header=True,
            context_before=1, context_after=1, no_color=True,
        )
    out = capsys.readouterr().out
    assert _ANSI_DIM not in out
    assert "before\nbody\nafter" in out


def test_emit_text_result_non_tty_no_ansi(capsys: pytest.CaptureFixture[str]) -> None:
    from token_goat.read_commands import _ANSI_DIM
    with patch.object(sys.stdout, "isatty", return_value=False):
        _emit_text_result(
            "before\nbody\nafter",
            "src/foo.py", "my_func", "symbol",
            no_header=True,
            context_before=1, context_after=1, no_color=False,
        )
    out = capsys.readouterr().out
    assert _ANSI_DIM not in out


# ---------------------------------------------------------------------------
# _context_bounds — derive context_before / context_after from result dict
# ---------------------------------------------------------------------------

def test_context_bounds_no_context() -> None:
    from token_goat.read_commands import _context_bounds
    result = {"start_line": 5, "end_line": 10, "core_start_line": 5, "core_end_line": 10}
    assert _context_bounds(result) == (0, 0)


def test_context_bounds_with_context() -> None:
    from token_goat.read_commands import _context_bounds
    result = {"start_line": 3, "end_line": 12, "core_start_line": 5, "core_end_line": 10}
    assert _context_bounds(result) == (2, 2)


def test_context_bounds_missing_core_fields() -> None:
    from token_goat.read_commands import _context_bounds
    result = {"start_line": 5, "end_line": 10}
    assert _context_bounds(result) == (0, 0)


def test_context_bounds_asymmetric() -> None:
    from token_goat.read_commands import _context_bounds
    result = {"start_line": 1, "end_line": 15, "core_start_line": 4, "core_end_line": 12}
    assert _context_bounds(result) == (3, 3)


# ---------------------------------------------------------------------------
# read_replacement — core_start_line / core_end_line in SymbolResult
# ---------------------------------------------------------------------------

def test_read_symbol_core_lines_no_context(ts_project):
    from token_goat import read_replacement
    result = read_replacement.read_symbol(ts_project, "index.ts", "greet", context_lines=0)
    assert result is not None
    assert result["core_start_line"] == result["start_line"]
    assert result["core_end_line"] == result["end_line"]


def test_read_symbol_core_lines_with_context(ts_project):
    from token_goat import read_replacement
    result = read_replacement.read_symbol(ts_project, "index.ts", "greet", context_lines=2)
    assert result is not None
    assert result["core_start_line"] >= result["start_line"]
    assert result["core_end_line"] <= result["end_line"]
    assert result["core_start_line"] <= result["core_end_line"]


def test_run_read_like_command_no_color_flag(capsys: pytest.CaptureFixture[str]) -> None:
    from token_goat.read_commands import _ANSI_DIM, _run_read_like_command
    mock_result = {
        "text": "before\nbody\nafter",
        "start_line": 3,
        "end_line": 7,
        "core_start_line": 4,
        "core_end_line": 6,
        "bytes_total": 1000,
        "bytes_extracted": 50,
        "bytes_saved": 950,
    }
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
            context_lines=1,
            separator_label="symbol",
            missing_label="Symbol",
            stat_kind="read_replacement",
            reader=mock_reader,
            no_header=True,
            no_color=True,
        )

    out = capsys.readouterr().out
    assert _ANSI_DIM not in out
    assert "before\nbody\nafter" in out


# ---------------------------------------------------------------------------
# stub_view — regression for start_line vs line column name
# ---------------------------------------------------------------------------

@pytest.fixture
def indexed_py_dir(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Small Python project indexed into tmp_data_dir."""
    TS_SAMPLE = FIXTURE_DIR / "ts_sample"
    proj_root = tmp_path / "py_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)
    from token_goat.parser import index_project
    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


def test_stub_view_returns_symbols(indexed_py_dir, tmp_data_dir, monkeypatch, capsys):
    """stub_view must query the 'line' column (not 'start_line') and return symbols.

    Regression: a wrong column name was silently swallowed by the OperationalError
    catch and caused stub_view to always report 'No indexed symbols found'.
    """
    from token_goat import db as _db
    from token_goat.read_commands import stub_view

    proj_root, proj = indexed_py_dir
    monkeypatch.chdir(proj_root)

    # Pick the first file that has at least one indexed symbol.
    with _db.open_project_readonly(proj.hash) as conn:
        row = conn.execute(
            "SELECT file_rel FROM symbols WHERE end_line IS NOT NULL LIMIT 1"
        ).fetchone()
    assert row is not None, "fixture must contain at least one indexable symbol"
    file_rel = row["file_rel"]

    stub_view(str(proj_root / file_rel), json_output=False)
    out = capsys.readouterr().out

    assert "No indexed symbols found" not in out, (
        "stub_view returned no symbols — likely a wrong column name in the SQL query"
    )
    assert "Skeleton:" in out


# ---------------------------------------------------------------------------
# Cross-reference footer wiring in _run_read_like_command
# ---------------------------------------------------------------------------

def _make_mock_result_with_symbol(
    symbol: str = "my_func",
    text: str = "def my_func(): pass",
    bytes_total: int = 1000,
    bytes_extracted: int = 50,
) -> dict:
    return {
        "symbol": symbol,
        "text": text,
        "start_line": 1,
        "end_line": 5,
        "core_start_line": 1,
        "core_end_line": 5,
        "bytes_total": bytes_total,
        "bytes_extracted": bytes_extracted,
        "bytes_saved": bytes_total - bytes_extracted,
    }


def test_callers_footer_appended_in_text_mode(capsys: pytest.CaptureFixture[str]) -> None:
    """footer is appended to text output when callers exist."""
    from token_goat.read_commands import _run_read_like_command

    mock_result = _make_mock_result_with_symbol()
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch(
            "token_goat.read_replacement.format_callers_footer",
            return_value="Refs: bar.py:42",
        ),
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
    assert "Refs: bar.py:42" in out
    assert "my_func" in out  # body still present


def test_callers_footer_absent_in_json_mode(capsys: pytest.CaptureFixture[str]) -> None:
    """footer is NOT added to JSON output."""
    from token_goat.read_commands import _run_read_like_command

    mock_result = _make_mock_result_with_symbol()
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch(
            "token_goat.read_replacement.format_callers_footer",
            return_value="Refs: bar.py:42",
        ),
        patch.object(sys.stdout, "isatty", return_value=False),
    ):
        _run_read_like_command(
            target="src/foo.py::my_func",
            session_id=None,
            json_output=True,
            context_lines=0,
            separator_label="symbol",
            missing_label="Symbol",
            stat_kind="read_replacement",
            reader=mock_reader,
            no_header=True,
        )

    out = capsys.readouterr().out
    data = json.loads(out.strip())
    assert "Refs:" not in data.get("text", "")
    assert "Refs:" not in out  # nowhere in raw JSON output


def test_callers_footer_absent_when_no_callers(capsys: pytest.CaptureFixture[str]) -> None:
    """No footer is appended when format_callers_footer returns empty string."""
    from token_goat.read_commands import _run_read_like_command

    mock_result = _make_mock_result_with_symbol()
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch(
            "token_goat.read_replacement.format_callers_footer",
            return_value="",
        ),
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
    assert "Refs:" not in out
    assert "my_func" in out  # body present


def test_callers_footer_not_called_for_section(capsys: pytest.CaptureFixture[str]) -> None:
    """format_callers_footer is not invoked when separator_label is 'heading'."""
    from token_goat.read_commands import _run_read_like_command

    mock_result = _make_mock_result_with_symbol(text="section body")
    mock_reader = MagicMock(return_value=mock_result)
    file_target = _make_file_target()
    mock_footer = MagicMock(return_value="Refs: bar.py:1")

    with (
        patch("token_goat.read_commands._resolve_file_target", return_value=file_target),
        patch("token_goat.db.record_stat"),
        patch("token_goat.read_commands.session.mark_file_read"),
        patch("token_goat.read_replacement.format_callers_footer", mock_footer),
        patch.object(sys.stdout, "isatty", return_value=False),
    ):
        _run_read_like_command(
            target="README.md::Install",
            session_id=None,
            json_output=False,
            context_lines=0,
            separator_label="heading",
            missing_label="Section",
            stat_kind="section_replacement",
            reader=mock_reader,
            no_header=True,
        )

    mock_footer.assert_not_called()
    out = capsys.readouterr().out
    assert "Refs:" not in out


# ---------------------------------------------------------------------------
# callers command tests
# ---------------------------------------------------------------------------


def test_callers_no_project(capsys: pytest.CaptureFixture[str]) -> None:
    """callers exits with error when no project is found."""
    from click.exceptions import Exit

    from token_goat.read_commands import callers

    with patch("token_goat.read_commands.find_project", return_value=None):
        with pytest.raises(Exit) as exc_info:
            callers("nonexistent_symbol")
        assert exc_info.value.exit_code == 1

    out = capsys.readouterr()
    assert "No project detected" in out.err


def test_callers_empty_project(capsys: pytest.CaptureFixture[str]) -> None:
    """callers returns empty message when project DB has no data."""
    from token_goat.read_commands import callers

    mock_project = MagicMock()
    mock_project.hash = "test123"

    with (
        patch("token_goat.read_commands.find_project", return_value=mock_project),
        patch("token_goat.read_commands.db.open_project_readonly") as mock_db,
        patch("token_goat.read_commands.db.record_stat"),
    ):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = []
        mock_db.return_value.__enter__.return_value = mock_conn

        with patch.object(sys.stdout, "isatty", return_value=False):
            callers("some_symbol")

    out = capsys.readouterr().out
    assert "No callers found for 'some_symbol'" in out


def test_callers_text_output(capsys: pytest.CaptureFixture[str]) -> None:
    """callers groups results by file and caller in text output."""
    from token_goat.read_commands import callers

    mock_project = MagicMock()
    mock_project.hash = "test123"

    rows = [
        MagicMock(file_rel="src/cli.py", line=142, context="install(codex=True)", caller_name="main", caller_kind="function"),
        MagicMock(file_rel="src/cli.py", line=156, context="install(opencode=True)", caller_name="main", caller_kind="function"),
        MagicMock(file_rel="src/hooks.py", line=44, context="install()", caller_name=None, caller_kind=None),
    ]

    with (
        patch("token_goat.read_commands.find_project", return_value=mock_project),
        patch("token_goat.read_commands.db.open_project_readonly") as mock_db,
        patch("token_goat.read_commands.db.record_stat"),
    ):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = rows
        mock_db.return_value.__enter__.return_value = mock_conn

        with patch.object(sys.stdout, "isatty", return_value=False):
            callers("install")

    out = capsys.readouterr().out
    assert "src/cli.py" in out
    assert "main()" in out
    assert "2 calls" in out
    assert "src/hooks.py" in out
    assert "<module level>" in out
    assert "line 142" in out
    assert "line 44" in out


def test_callers_json_output(capsys: pytest.CaptureFixture[str]) -> None:
    """callers returns properly structured JSON."""
    from token_goat.read_commands import callers

    mock_project = MagicMock()
    mock_project.hash = "test123"

    rows = [
        MagicMock(file_rel="src/cli.py", line=142, context="install(codex=True)", caller_name="main", caller_kind="function"),
        MagicMock(file_rel="src/cli.py", line=156, context="install(opencode=True)", caller_name="main", caller_kind="function"),
    ]

    with (
        patch("token_goat.read_commands.find_project", return_value=mock_project),
        patch("token_goat.read_commands.db.open_project_readonly") as mock_db,
        patch("token_goat.read_commands.db.record_stat"),
    ):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = rows
        mock_db.return_value.__enter__.return_value = mock_conn

        with patch.object(sys.stdout, "isatty", return_value=False):
            callers("install", json_output=True)

    out = capsys.readouterr().out
    result = json.loads(out)
    assert result["query"] == "install"
    assert len(result["callers"]) == 1
    assert result["callers"][0]["file"] == "src/cli.py"
    assert result["callers"][0]["caller_name"] == "main"
    assert result["callers"][0]["caller_kind"] == "function"
    assert len(result["callers"][0]["calls"]) == 2
    assert result["callers"][0]["calls"][0]["line"] == 142


def test_callers_limit_respected(capsys: pytest.CaptureFixture[str]) -> None:
    """callers respects the limit parameter."""
    from token_goat.read_commands import callers

    mock_project = MagicMock()
    mock_project.hash = "test123"

    rows = [MagicMock(file_rel="src/cli.py", line=i, context=f"call_{i}", caller_name="func", caller_kind="function") for i in range(1, 4)]

    with (
        patch("token_goat.read_commands.find_project", return_value=mock_project),
        patch("token_goat.read_commands.db.open_project_readonly") as mock_db,
        patch("token_goat.read_commands.db.record_stat"),
    ):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = rows
        mock_db.return_value.__enter__.return_value = mock_conn

        with patch.object(sys.stdout, "isatty", return_value=False):
            callers("symbol", limit=3)

        call_args = mock_conn.execute.call_args
        assert call_args[0][1][-1] == 3  # Last parameter is the limit
