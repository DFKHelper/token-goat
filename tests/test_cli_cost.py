"""Tests for `token-goat cost` command."""
from __future__ import annotations

import json
import time

from typer.testing import CliRunner

from token_goat import cli
from token_goat import session as session_mod

runner = CliRunner()


def test_cost_alltime_exits_zero(tmp_data_dir):
    """Test that cost command without --session exits with 0 and shows all-time summary."""
    result = runner.invoke(cli.app, ["cost"])
    assert result.exit_code == 0
    assert "tokens" in result.stdout.lower()
    assert "all-time" in result.stdout.lower()


def test_cost_session_flag_with_valid_session(tmp_data_dir):
    """Test cost command with --session flag and a valid session cache."""
    sessions_dir = tmp_data_dir / "sessions"
    sessions_dir.mkdir(parents=True)

    # Create a minimal session cache
    session_id = "abc123def456789abcdef0123456789"
    ts = time.time()
    session_cache = session_mod.SessionCache(
        session_id=session_id,
        started_ts=ts,
        last_activity_ts=ts,
    )

    # Write to disk
    session_file = sessions_dir / f"{session_id}.json"
    session_file.write_text(json.dumps(session_cache.to_dict()))

    result = runner.invoke(cli.app, ["cost", "--session", session_id])
    assert result.exit_code == 0
    assert "tokens" in result.stdout.lower()
    assert "session" in result.stdout.lower()


def test_cost_session_flag_short_form(tmp_data_dir):
    """Test cost command with --session using short form (8 chars)."""
    sessions_dir = tmp_data_dir / "sessions"
    sessions_dir.mkdir(parents=True)

    # Create a minimal session cache
    session_id = "abc123def456789abcdef0123456789"
    ts = time.time()
    session_cache = session_mod.SessionCache(
        session_id=session_id,
        started_ts=ts,
        last_activity_ts=ts,
    )

    # Write to disk
    session_file = sessions_dir / f"{session_id}.json"
    session_file.write_text(json.dumps(session_cache.to_dict()))

    result = runner.invoke(cli.app, ["cost", "--session", "abc123de"])
    assert result.exit_code == 0
    assert "tokens" in result.stdout.lower()


def test_cost_session_flag_not_found(tmp_data_dir):
    """Test cost command with --session pointing to nonexistent session."""
    sessions_dir = tmp_data_dir / "sessions"
    sessions_dir.mkdir(parents=True)

    result = runner.invoke(cli.app, ["cost", "--session", "nonexistent"])
    assert result.exit_code == 1


def test_cost_contains_tokens_keyword(tmp_data_dir):
    """Test that cost output always contains 'tokens' keyword."""
    result = runner.invoke(cli.app, ["cost"])
    assert result.exit_code == 0
    assert "tokens" in result.stdout.lower()
