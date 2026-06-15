"""Tests for token-goat blame command (git_history.blame_symbol + read_commands.blame)."""
from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import typer

from token_goat.git_history import _parse_blame_porcelain, blame_symbol
from token_goat.read_commands import blame

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PORCELAIN_SAMPLE = (
    "abc123def456789012345678901234567890a1b2 1 42 1\n"
    "author Alice Smith\n"
    "author-mail <alice@example.com>\n"
    "author-time 1704067200\n"
    "author-tz +0000\n"
    "committer Alice Smith\n"
    "committer-mail <alice@example.com>\n"
    "committer-time 1704067200\n"
    "committer-tz +0000\n"
    "summary feat: add login\n"
    "filename src/auth.py\n"
    "\tdef login():\n"
    "abc123def456789012345678901234567890a1b2 2 43\n"
    "\t    pass\n"
)


# ---------------------------------------------------------------------------
# _parse_blame_porcelain unit tests
# ---------------------------------------------------------------------------


class TestParseBlamePorcelain:
    def test_basic_two_lines(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert len(entries) == 2

    def test_line_numbers(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert entries[0]["line_no"] == 42
        assert entries[1]["line_no"] == 43

    def test_commit_hash(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert entries[0]["commit_hash"] == "abc123def456789012345678901234567890a1b2"

    def test_author(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert entries[0]["author"] == "Alice Smith"

    def test_date_format(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        # 1704067200 == 2024-01-01 00:00:00 UTC
        assert entries[0]["date"] == "2024-01-01"

    def test_content_stripped_of_tab(self) -> None:
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert entries[0]["content"] == "def login():"
        assert entries[1]["content"] == "    pass"

    def test_grouped_line_reuses_metadata(self) -> None:
        # Second line has no author header — cache must supply it.
        entries = _parse_blame_porcelain(_PORCELAIN_SAMPLE, start_line=42)
        assert entries[1]["author"] == "Alice Smith"
        assert entries[1]["date"] == "2024-01-01"

    def test_empty_input_returns_empty_list(self) -> None:
        entries = _parse_blame_porcelain("", start_line=1)
        assert entries == []

    def test_malformed_header_skipped(self) -> None:
        raw = "not-a-header\n\tsome content\n"
        entries = _parse_blame_porcelain(raw, start_line=1)
        # No valid blame header found — content line is attached to empty state.
        # The key requirement is no exception is raised.
        assert isinstance(entries, list)


# ---------------------------------------------------------------------------
# blame_symbol — fail-soft behaviour
# ---------------------------------------------------------------------------


class TestBlameSymbol:
    def test_returns_list_on_success(self, tmp_path: Path) -> None:
        with patch("token_goat.git_history._run_git", return_value=_PORCELAIN_SAMPLE):
            result = blame_symbol(tmp_path, "src/auth.py", 42, 43)
        assert isinstance(result, list)
        assert len(result) == 2

    def test_returns_empty_on_git_error(self, tmp_path: Path) -> None:
        with patch("token_goat.git_history._run_git", return_value=None):
            result = blame_symbol(tmp_path, "src/auth.py", 42, 43)
        assert result == []

    def test_returns_empty_on_exception(self, tmp_path: Path) -> None:
        with patch("token_goat.git_history._run_git", side_effect=RuntimeError("no git")):
            result = blame_symbol(tmp_path, "src/auth.py", 42, 43)
        assert result == []

    def test_passes_correct_line_range(self, tmp_path: Path) -> None:
        captured: list[list[str]] = []

        def _capture(args: list[str], **_kw: object) -> str:
            captured.append(args)
            return _PORCELAIN_SAMPLE

        with patch("token_goat.git_history._run_git", side_effect=_capture):
            blame_symbol(tmp_path, "src/auth.py", 10, 20)

        assert captured, "git was never called"
        cmd = captured[0]
        assert "blame" in cmd
        assert "-L10,20" in cmd
        assert "--porcelain" in cmd
        assert "src/auth.py" in cmd


# ---------------------------------------------------------------------------
# read_commands.blame — integration tests with mocked DB + git
# ---------------------------------------------------------------------------

def _make_db_row(line: int = 42, end_line: int = 43) -> MagicMock:
    """Return a mock sqlite3 Row with 'line' and 'end_line' keys."""
    row = MagicMock()
    row.__getitem__ = lambda self, key: {  # type: ignore[misc]
        "line": line, "end_line": end_line
    }[key]
    return row


@contextmanager
def _patch_blame_infra(
    *,
    file_rel: str = "src/auth.py",
    start_line: int = 42,
    end_line: int = 43,
    blame_result: list | None = None,
):
    """Patch the dependencies used by read_commands.blame."""
    db_row = _make_db_row(start_line, end_line)
    if blame_result is None:
        blame_result = [
            {
                "line_no": start_line,
                "commit_hash": "abc123def456789012345678901234567890a1b2",
                "author": "Alice Smith",
                "date": "2024-01-01",
                "content": "def login():",
            }
        ]

    conn_mock = MagicMock()
    conn_mock.execute.return_value.fetchone.return_value = db_row
    conn_ctx = MagicMock()
    conn_ctx.__enter__ = lambda s: conn_mock
    conn_ctx.__exit__ = MagicMock(return_value=False)


    fake_proj = MagicMock()
    fake_proj.hash = "deadbeef" * 5
    fake_proj.root = Path("/fake/root")

    with (
        patch("token_goat.read_commands._resolve_file_target") as mock_resolve,
        patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
        patch("token_goat.git_history.blame_symbol", return_value=blame_result),
    ):
        from token_goat.read_commands import _FileTarget
        mock_resolve.return_value = _FileTarget(
            project=fake_proj,
            rel_path=file_rel,
            current_project=fake_proj,
        )
        yield


class TestBlameCommand:
    def test_invalid_format_exits_2(self, capsys: pytest.CaptureFixture[str]) -> None:
        with pytest.raises((typer.Exit, SystemExit)) as exc_info:
            blame("no_double_colon")
        exc = exc_info.value
        code = exc.exit_code if isinstance(exc, typer.Exit) else exc.code
        assert code == 2

    def test_missing_separator_error_on_stderr(self, capsys: pytest.CaptureFixture[str]) -> None:
        with pytest.raises((typer.Exit, SystemExit)):
            blame("noseparator")
        captured = capsys.readouterr()
        assert "Error" in captured.err
        assert "Error" not in captured.out

    def test_empty_symbol_error_on_stderr(self, capsys: pytest.CaptureFixture[str]) -> None:
        with pytest.raises((typer.Exit, SystemExit)):
            blame("::sym")
        captured = capsys.readouterr()
        assert "Error" in captured.err
        assert "Error" not in captured.out

    def test_text_output_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        with _patch_blame_infra():
            blame("src/auth.py::login")
        out = capsys.readouterr().out
        # Must include short hash, author, date, line number, and content.
        assert "abc123de" in out
        assert "Alice Smith" in out
        assert "2024-01-01" in out
        assert "42" in out
        assert "def login():" in out

    def test_json_output_structure(self, capsys: pytest.CaptureFixture[str]) -> None:
        with _patch_blame_infra():
            blame("src/auth.py::login", json_output=True)
        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["file"] == "src/auth.py"
        assert data["symbol"] == "login"
        assert "start_line" in data
        assert "end_line" in data
        assert isinstance(data["lines"], list)
        assert len(data["lines"]) == 1
        line = data["lines"][0]
        assert line["author"] == "Alice Smith"
        assert line["date"] == "2024-01-01"
        assert line["content"] == "def login():"

    def test_symbol_not_found_emits_error(self, capsys: pytest.CaptureFixture[str]) -> None:

        fake_proj = MagicMock()
        fake_proj.hash = "deadbeef" * 5
        fake_proj.root = Path("/fake/root")

        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchone.return_value = None
        conn_ctx = MagicMock()
        conn_ctx.__enter__ = lambda s: conn_mock
        conn_ctx.__exit__ = MagicMock(return_value=False)

        from token_goat.read_commands import _FileTarget

        with (
            patch("token_goat.read_commands._resolve_file_target") as mock_resolve,
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
            patch(
                "token_goat.read_commands._close_symbol_matches", return_value=[]
            ),
        ):
            mock_resolve.return_value = _FileTarget(
                project=fake_proj, rel_path="src/auth.py", current_project=fake_proj
            )
            with pytest.raises((typer.Exit, SystemExit)):
                blame("src/auth.py::nonexistent")

        out = capsys.readouterr().out
        assert "not found" in out.lower() or "symbol" in out.lower()

    def test_git_not_available_graceful_fallback(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """When blame_symbol returns [], emit an error and exit 0 (not crash)."""
        with _patch_blame_infra(blame_result=[]):
            with pytest.raises((typer.Exit, SystemExit)) as exc_info:
                blame("src/auth.py::login")
            exc = exc_info.value
            code = exc.exit_code if isinstance(exc, typer.Exit) else exc.code
            # Exit code 0 — graceful, not a fatal error.
            assert code == 0

    def test_json_symbol_not_found(self, capsys: pytest.CaptureFixture[str]) -> None:
        fake_proj = MagicMock()
        fake_proj.hash = "deadbeef" * 5
        fake_proj.root = Path("/fake/root")

        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchone.return_value = None
        conn_ctx = MagicMock()
        conn_ctx.__enter__ = lambda s: conn_mock
        conn_ctx.__exit__ = MagicMock(return_value=False)

        from token_goat.read_commands import _FileTarget

        with (
            patch("token_goat.read_commands._resolve_file_target") as mock_resolve,
            patch("token_goat.db.open_project_readonly", return_value=conn_ctx),
            patch("token_goat.read_commands._close_symbol_matches", return_value=[]),
        ):
            mock_resolve.return_value = _FileTarget(
                project=fake_proj, rel_path="src/auth.py", current_project=fake_proj
            )
            with pytest.raises((typer.Exit, SystemExit)):
                blame("src/auth.py::nonexistent", json_output=True)

        out = capsys.readouterr().out
        data = json.loads(out)
        assert data["ok"] is False
        assert data["error"]["code"] == "symbol_not_found"
