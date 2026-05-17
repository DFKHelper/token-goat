"""Tests for centralized _error / _warn helpers and DB-error handling in cli.py.

Note: typer's CliRunner merges stdout and stderr into result.output by default,
so assertions check result.output for both Error:/Warning: prefixes and messages.
The _error/_warn unit tests use capsys to verify direct stderr writes.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from token_goat import cli
from token_goat import db as _db

runner = CliRunner()


# ---------------------------------------------------------------------------
# _error / _warn helpers — direct unit tests via capsys
# ---------------------------------------------------------------------------

class TestErrorHelper:
    """_error() writes 'Error: <msg>' to stderr."""

    def test_error_goes_to_stderr(self, capsys):
        cli._error("something went wrong")
        captured = capsys.readouterr()
        assert "something went wrong" in captured.err

    def test_error_has_prefix(self, capsys):
        cli._error("boom")
        captured = capsys.readouterr()
        assert "Error:" in captured.err

    def test_error_prefix_and_message_on_same_line(self, capsys):
        cli._error("boom")
        captured = capsys.readouterr()
        line = captured.err.strip()
        assert "Error:" in line
        assert "boom" in line

    def test_error_no_stdout_output(self, capsys):
        cli._error("silent stdout")
        captured = capsys.readouterr()
        assert captured.out == ""


class TestWarnHelper:
    """_warn() writes 'Warning: <msg>' to stderr."""

    def test_warn_goes_to_stderr(self, capsys):
        cli._warn("something is off")
        captured = capsys.readouterr()
        assert "something is off" in captured.err

    def test_warn_has_prefix(self, capsys):
        cli._warn("heads up")
        captured = capsys.readouterr()
        assert "Warning:" in captured.err

    def test_warn_no_stdout_output(self, capsys):
        cli._warn("quiet")
        captured = capsys.readouterr()
        assert captured.out == ""


# ---------------------------------------------------------------------------
# symbol command — no project detected
# ---------------------------------------------------------------------------

class TestSymbolNoProject:
    """'symbol' without a detected project exits non-zero with 'Error:' prefix."""

    def test_no_project_exits_nonzero(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["symbol", "SomeClass"], catch_exceptions=False)
        assert result.exit_code != 0

    def test_no_project_error_prefix_in_output(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["symbol", "SomeClass"], catch_exceptions=False)
        assert "Error:" in result.output

    def test_no_project_message_mentions_project(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["symbol", "SomeClass"], catch_exceptions=False)
        assert "project" in result.output.lower()


# ---------------------------------------------------------------------------
# ref command — no project detected
# ---------------------------------------------------------------------------

class TestRefNoProject:
    """'ref' without a detected project exits non-zero with 'Error:' prefix."""

    def test_no_project_exits_nonzero(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["ref", "someFunc"], catch_exceptions=False)
        assert result.exit_code != 0

    def test_no_project_error_prefix_in_output(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["ref", "someFunc"], catch_exceptions=False)
        assert "Error:" in result.output


# ---------------------------------------------------------------------------
# symbol command — DB corruption / unavailable
# ---------------------------------------------------------------------------

@pytest.mark.skip(
    reason="Patches on token_goat.project.find_project / token_goat.db.open_project "
    "don't propagate to the symbol CLI under Python 3.13 + Typer + the full CI "
    "suite (the same tests pass in isolation on 3.12). Tracked as a CI-only "
    "flake; the underlying CLI error path is exercised by integration tests."
)
class TestSymbolDBError:
    """'symbol' shows a helpful 'run index' message when the project DB is unavailable."""

    def test_db_corruption_shows_helpful_message(self):
        fake_proj = MagicMock()
        fake_proj.hash = "abc123"

        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project", side_effect=_db.DBCorruptionError("DB unrecoverable")),
        ):
            result = runner.invoke(cli.app, ["symbol", "SomeClass"], catch_exceptions=False)

        assert result.exit_code != 0
        assert "Error:" in result.output
        assert "index" in result.output.lower()

    def test_db_busy_error_shows_helpful_message(self):
        fake_proj = MagicMock()
        fake_proj.hash = "abc123"

        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project", side_effect=_db.DBBusyError("locked")),
        ):
            result = runner.invoke(cli.app, ["symbol", "SomeClass"], catch_exceptions=False)

        assert result.exit_code != 0
        assert "Error:" in result.output
        assert "index" in result.output.lower()


# ---------------------------------------------------------------------------
# ref command — DB error
# ---------------------------------------------------------------------------

@pytest.mark.skip(
    reason="Same CI-only flake as TestSymbolDBError above — patches on "
    "token_goat.project.find_project don't propagate under Python 3.13 + "
    "Typer + the full CI suite."
)
class TestRefDBError:
    """'ref' shows a helpful 'run index' message when the project DB is unavailable."""

    def test_db_corruption_shows_helpful_message(self):
        fake_proj = MagicMock()
        fake_proj.hash = "abc123"

        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.db.open_project", side_effect=_db.DBCorruptionError("DB unrecoverable")),
        ):
            result = runner.invoke(cli.app, ["ref", "someFunc"], catch_exceptions=False)

        assert result.exit_code != 0
        assert "Error:" in result.output
        assert "index" in result.output.lower()


# ---------------------------------------------------------------------------
# index command — no project / invalid root
# ---------------------------------------------------------------------------

class TestIndexErrors:
    """'index' error paths show 'Error:' prefix and exit non-zero."""

    def test_no_project_exits_nonzero(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["index"], catch_exceptions=False)
        assert result.exit_code != 0

    def test_no_project_error_prefix_in_output(self):
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["index"], catch_exceptions=False)
        assert "Error:" in result.output

    def test_invalid_root_path_exits_nonzero(self, tmp_path):
        nonexistent = str(tmp_path / "does_not_exist")
        result = runner.invoke(cli.app, ["index", "--root", nonexistent], catch_exceptions=False)
        assert result.exit_code != 0
        assert "Error:" in result.output
