"""Tests for token-goat bash-output --full and --diff flags."""
from __future__ import annotations

import pytest
from typer.testing import CliRunner

from token_goat import bash_cache
from token_goat.cli import app

runner = CliRunner()


@pytest.fixture(autouse=True)
def _no_db_stat(monkeypatch):
    """Prevent db.record_stat from opening the global SQLite DB during tests."""
    monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)

# Enough lines to trigger the smart-default trimming (threshold = 30 + 80 = 110).
_MANY = 200


def _store(session_id: str, command: str, body: str) -> str:
    """Store *body* as stdout and return the output_id."""
    meta = bash_cache.store_output(session_id, command, body, "", 0, min_cache_bytes=0)
    assert meta is not None, "store_output returned None"
    return meta.output_id


def _large_body(n: int = _MANY) -> str:
    """Return an n-line body large enough to be trimmed by _apply_smart_default."""
    return "\n".join(f"line {i}" for i in range(n))


def test_full_returns_all_lines(tmp_path):
    """--full must return every stored line without the elision marker."""
    body = _large_body()
    oid = _store("sess_full", "echo test", body)
    result = runner.invoke(app, ["bash-output", oid, "--full"])
    assert result.exit_code == 0, result.output
    for i in range(_MANY):
        assert f"line {i}" in result.output
    assert "elided" not in result.output


def test_diff_shows_plus_lines_for_stripped_content(tmp_path):
    """--diff must include '+' lines for content that trimming removed."""
    body = _large_body()
    oid = _store("sess_diff", "echo test", body)
    result = runner.invoke(app, ["bash-output", oid, "--diff"])
    assert result.exit_code == 0, result.output
    # Middle lines are elided by the smart default but present in the full body,
    # so the diff must contain at least one '+line NNN' for a mid-range line.
    plus_lines = [ln for ln in result.output.splitlines() if ln.startswith("+") and not ln.startswith("+++")]
    assert len(plus_lines) > 0, "expected '+' lines in diff output"
    # A mid-range line (e.g. line 50) must appear as a '+' addition.
    assert any("line 50" in ln for ln in plus_lines)


def test_full_and_diff_together_gives_error(tmp_path):
    """Combining --full and --diff must exit with code 1 and print an error."""
    body = _large_body()
    oid = _store("sess_both", "echo test", body)
    result = runner.invoke(app, ["bash-output", oid, "--full", "--diff"])
    assert result.exit_code == 1
    assert "--full" in result.output or "--diff" in result.output


def test_missing_id_gives_not_found(tmp_path):
    """A non-existent output_id must produce exit code 1 without crashing."""
    result = runner.invoke(app, ["bash-output", "nonexistent_id_xyz", "--diff"])
    assert result.exit_code == 1
    assert "no cached output" in result.output.lower() or "not found" in result.output.lower()


def test_full_on_short_entry_passes_through_cleanly(tmp_path):
    """--full on a short entry (below trimming threshold) must return the body unchanged."""
    # 10 lines is well below the 110-line smart-default threshold.
    body = "\n".join(f"short {i}" for i in range(10))
    oid = _store("sess_short", "echo short", body)
    result = runner.invoke(app, ["bash-output", oid, "--full"])
    assert result.exit_code == 0, result.output
    for i in range(10):
        assert f"short {i}" in result.output
    assert "elided" not in result.output


def test_diff_on_short_entry_reports_no_diff(tmp_path):
    """--diff on a short entry must report that no trimming occurred (no crash, no diff lines)."""
    body = "\n".join(f"short {i}" for i in range(10))
    oid = _store("sess_short_diff", "echo short", body)
    result = runner.invoke(app, ["bash-output", oid, "--diff"])
    assert result.exit_code == 0, result.output
    # No '+'/'-' diff lines expected — the smart default is a no-op for short output.
    plus_minus = [ln for ln in result.output.splitlines() if ln.startswith(("+", "-")) and not ln.startswith(("+++", "---"))]
    assert len(plus_minus) == 0, f"unexpected diff lines: {plus_minus}"


def test_diff_missing_id_exits_one():
    """--diff with a bad id must exit 1 regardless of other flags."""
    result = runner.invoke(app, ["bash-output", "bad_id_abc", "--diff"])
    assert result.exit_code == 1
