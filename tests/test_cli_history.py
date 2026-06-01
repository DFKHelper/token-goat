"""Tests for the `token-goat history` command."""
from __future__ import annotations

import json
import time
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from token_goat.cli import app
from token_goat.session import (
    BashEntry,
    GrepEntry,
    SessionCache,
    WebEntry,
)

runner = CliRunner()


def _make_session(
    session_id: str = "test-session-123",
    bash_entries: dict[str, BashEntry] | None = None,
    web_entries: dict[str, WebEntry] | None = None,
    grep_entries: list[GrepEntry] | None = None,
) -> SessionCache:
    """Create a test SessionCache with optional history entries."""
    cache = SessionCache(session_id=session_id, started_ts=time.time(), last_activity_ts=time.time())
    if bash_entries is not None:
        cache.bash_history = bash_entries
    if web_entries is not None:
        cache.web_history = web_entries
    if grep_entries is not None:
        cache.greps = grep_entries or []
    return cache


def test_history_requires_session_id() -> None:
    """Test that history command requires --session-id."""
    result = runner.invoke(app, ["history"])
    assert result.exit_code == 1


def test_history_empty_session_all_sections(capsys: pytest.CaptureFixture[str]) -> None:
    """Test that empty session shows all sections with no error."""
    cache = _make_session()
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123"])
        assert result.exit_code == 0
        assert "## Bash History" in result.stdout
        assert "## Web History" in result.stdout
        assert "## Grep History" in result.stdout
        assert "(no entries)" in result.stdout


def test_history_bash_only() -> None:
    """Test --bash flag shows only bash history."""
    now = time.time()
    bash_entries = {
        "sha1": BashEntry(
            cmd_sha="sha1",
            cmd_preview="pytest tests/",
            output_id="out1",
            ts=now - 60,
            stdout_bytes=1024,
            stderr_bytes=0,
            exit_code=0,
        ),
    }
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash"])
        assert result.exit_code == 0
        assert "## Bash History" in result.stdout
        assert "## Web History" not in result.stdout
        assert "## Grep History" not in result.stdout
        assert "pytest tests/" in result.stdout


def test_history_web_only() -> None:
    """Test --web flag shows only web history."""
    now = time.time()
    web_entries = {
        "sha1": WebEntry(
            url_sha="sha1",
            url_preview="https://example.com/api",
            output_id="web1",
            ts=now - 30,
            body_bytes=2048,
            status_code=200,
        ),
    }
    cache = _make_session(web_entries=web_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--web"])
        assert result.exit_code == 0
        assert "## Web History" in result.stdout
        assert "## Bash History" not in result.stdout
        assert "## Grep History" not in result.stdout
        assert "example.com" in result.stdout


def test_history_grep_only() -> None:
    """Test --grep flag shows only grep history."""
    now = time.time()
    grep_entries = [
        GrepEntry(
            pattern="function.*login",
            path="src/auth.py",
            ts=now - 45,
            result_count=5,
        ),
    ]
    cache = _make_session(grep_entries=grep_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--grep"])
        assert result.exit_code == 0
        assert "## Grep History" in result.stdout
        assert "## Bash History" not in result.stdout
        assert "## Web History" not in result.stdout
        assert "function.*login" in result.stdout
        assert "src/auth.py" in result.stdout
        assert "5 matches" in result.stdout


def test_history_limit_respected() -> None:
    """Test that --limit truncates output correctly."""
    now = time.time()
    bash_entries = {}
    for i in range(5):
        bash_entries[f"sha{i}"] = BashEntry(
            cmd_sha=f"sha{i}",
            cmd_preview=f"cmd_{i}",
            output_id=f"out{i}",
            ts=now - (50 - i * 10),
            stdout_bytes=1024,
            stderr_bytes=0,
            exit_code=0,
        )
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash", "--limit", "2"])
        assert result.exit_code == 0
        # Should show only 2 most recent entries
        lines = [line for line in result.stdout.split("\n") if line.strip().startswith("cmd_")]
        assert len(lines) <= 2


def test_history_json_output_bash() -> None:
    """Test JSON output for bash history."""
    now = time.time()
    bash_entries = {
        "sha1": BashEntry(
            cmd_sha="sha1",
            cmd_preview="pytest tests/",
            output_id="out1",
            ts=now - 60,
            stdout_bytes=1024,
            stderr_bytes=512,
            exit_code=0,
        ),
    }
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "bash" in data
        assert len(data["bash"]) == 1
        assert data["bash"][0]["command"] == "pytest tests/"
        assert data["bash"][0]["exit_code"] == 0
        assert data["bash"][0]["cached"] == "yes"
        assert data["bash"][0]["size_bytes"] == 1536


def test_history_json_output_web() -> None:
    """Test JSON output for web history."""
    now = time.time()
    web_entries = {
        "sha1": WebEntry(
            url_sha="sha1",
            url_preview="https://example.com/api",
            output_id="web1",
            ts=now - 30,
            body_bytes=2048,
            status_code=200,
        ),
    }
    cache = _make_session(web_entries=web_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--web", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "web" in data
        assert len(data["web"]) == 1
        assert "example.com" in data["web"][0]["url"]
        assert data["web"][0]["status_code"] == 200
        assert data["web"][0]["size_kb"] == 2


def test_history_json_output_grep() -> None:
    """Test JSON output for grep history."""
    now = time.time()
    grep_entries = [
        GrepEntry(
            pattern="function.*login",
            path="src/auth.py",
            ts=now - 45,
            result_count=5,
        ),
    ]
    cache = _make_session(grep_entries=grep_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--grep", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "grep" in data
        assert len(data["grep"]) == 1
        assert data["grep"][0]["pattern"] == "function.*login"
        assert data["grep"][0]["path"] == "src/auth.py"
        assert data["grep"][0]["result_count"] == 5


def test_history_all_sections_json() -> None:
    """Test JSON output with all sections populated."""
    now = time.time()
    bash_entries = {
        "bash1": BashEntry(
            cmd_sha="bash1",
            cmd_preview="ls -la",
            output_id="out1",
            ts=now - 60,
            stdout_bytes=512,
            stderr_bytes=0,
            exit_code=0,
        ),
    }
    web_entries = {
        "web1": WebEntry(
            url_sha="web1",
            url_preview="https://docs.example.com",
            output_id="web1",
            ts=now - 30,
            body_bytes=1024,
            status_code=200,
        ),
    }
    grep_entries = [
        GrepEntry(
            pattern="TODO",
            path=None,
            ts=now - 15,
            result_count=3,
        ),
    ]
    cache = _make_session(bash_entries=bash_entries, web_entries=web_entries, grep_entries=grep_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.stdout)
        assert "bash" in data
        assert "web" in data
        assert "grep" in data
        assert len(data["bash"]) == 1
        assert len(data["web"]) == 1
        assert len(data["grep"]) == 1


def test_history_text_format_spacing() -> None:
    """Test that text output properly formats and displays entries."""
    now = time.time()
    bash_entries = {
        "sha1": BashEntry(
            cmd_sha="sha1",
            cmd_preview="pytest tests/test_cli.py -v",
            output_id="out1",
            ts=now - 120,
            stdout_bytes=5 * 1024,
            stderr_bytes=2 * 1024,
            exit_code=0,
        ),
    }
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash"])
        assert result.exit_code == 0
        assert "pytest tests/test_cli.py -v" in result.stdout
        assert "exit=0" in result.stdout
        assert "cached" in result.stdout
        assert "120" in result.stdout  # age in seconds


def test_history_grep_global_pattern() -> None:
    """Test grep entry without path scope (global search)."""
    now = time.time()
    grep_entries = [
        GrepEntry(
            pattern="FIXME",
            path=None,  # Global search
            ts=now - 25,
            result_count=8,
        ),
    ]
    cache = _make_session(grep_entries=grep_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--grep"])
        assert result.exit_code == 0
        assert "FIXME" in result.stdout
        assert "(global)" in result.stdout
        assert "8 matches" in result.stdout


def test_history_bash_uncached_entry() -> None:
    """Test bash entry without output_id (not cached)."""
    now = time.time()
    bash_entries = {
        "sha1": BashEntry(
            cmd_sha="sha1",
            cmd_preview="echo hello",
            output_id="",  # Empty means not cached
            ts=now - 30,
            stdout_bytes=100,
            stderr_bytes=0,
            exit_code=0,
        ),
    }
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash"])
        assert result.exit_code == 0
        assert "not cached" in result.stdout


def test_history_bash_with_exit_code() -> None:
    """Test bash entry formatting with various exit codes."""
    now = time.time()
    bash_entries = {
        "sha1": BashEntry(
            cmd_sha="sha1",
            cmd_preview="failing_command",
            output_id="out1",
            ts=now - 10,
            stdout_bytes=256,
            stderr_bytes=128,
            exit_code=127,  # Command not found
        ),
    }
    cache = _make_session(bash_entries=bash_entries)
    with patch("token_goat.session.safe_load", return_value=cache):
        result = runner.invoke(app, ["history", "--session-id", "test-session-123", "--bash"])
        assert result.exit_code == 0
        assert "exit=127" in result.stdout
