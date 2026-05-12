"""Smoke test for CLI."""
from typer.testing import CliRunner

from cc_saver import cli

runner = CliRunner()


def test_cli_help_runs():
    """Test that cc-saver --help doesn't crash."""
    result = runner.invoke(cli.app, ["--help"])
    assert result.exit_code == 0
    assert "symbol" in result.stdout
    assert "ref" in result.stdout
    assert "semantic" in result.stdout
    assert "map" in result.stdout


def test_doctor_command_runs():
    """Test that cc-saver doctor runs successfully."""
    result = runner.invoke(cli.app, ["doctor"])
    assert result.exit_code == 0
    assert "cc-saver doctor" in result.stdout
    assert "Python:" in result.stdout
    assert "SQLite" in result.stdout


def test_hook_help_runs():
    """Test that cc-saver hook --help shows subcommands."""
    result = runner.invoke(cli.app, ["hook", "--help"])
    assert result.exit_code == 0
    assert "session-start" in result.stdout or "session_start" in result.stdout
