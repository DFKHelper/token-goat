"""Tests for token-goat refs <file>::<symbol> command."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def indexed_ts_dir(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Copy ts_sample to tmp, index it, and chdir into it."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)

    from token_goat.parser import index_project

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# db.get_symbol_refs
# ---------------------------------------------------------------------------


def test_get_symbol_refs_returns_list(indexed_ts_dir, tmp_data_dir):
    """get_symbol_refs returns a list (possibly empty) without raising."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_symbol_refs(proj.hash, "index.ts", "greet")
    assert isinstance(rows, list)


def test_get_symbol_refs_finds_callers(indexed_ts_dir, tmp_data_dir):
    """greet is called at line 11 of index.ts — get_symbol_refs finds it."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_symbol_refs(proj.hash, "index.ts", "greet")
    # greet is called inside UserService.hello — at least one ref expected
    assert len(rows) >= 1
    row = rows[0]
    assert "path" in row
    assert "line" in row
    assert isinstance(row["line"], int)
    assert "context" in row


def test_get_symbol_refs_unknown_symbol_returns_empty(indexed_ts_dir, tmp_data_dir):
    """A symbol that doesn't exist yields an empty list, not an exception."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_symbol_refs(proj.hash, "index.ts", "__no_such_symbol_xyz__")
    assert rows == []


def test_get_symbol_refs_unknown_project_returns_empty(tmp_data_dir):
    """A non-existent project hash returns [] (fail-soft, no FileNotFoundError)."""
    from token_goat import db

    rows = db.get_symbol_refs("nonexistent_project_hash_abc123", "index.ts", "greet")
    assert rows == []


def test_get_symbol_refs_respects_limit(indexed_ts_dir, tmp_data_dir):
    """limit=1 returns at most 1 row."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_symbol_refs(proj.hash, "index.ts", "greet", limit=1)
    assert len(rows) <= 1


# ---------------------------------------------------------------------------
# read_commands.refs — plain text output
# ---------------------------------------------------------------------------


def test_refs_command_finds_results(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """refs index.ts::greet prints at least one result line."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet"])
    assert result.exit_code == 0
    output = result.output
    # Header line shows count
    assert "reference" in output.lower()
    # At least one file:line: entry
    lines = [ln for ln in output.splitlines() if ":" in ln and not ln.startswith("#")]
    assert len(lines) >= 1


def test_refs_command_output_format(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """Each result line has path:line: context format."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet"])
    assert result.exit_code == 0
    ref_lines = [
        ln for ln in result.output.splitlines()
        if ln and ":" in ln and "reference" not in ln.lower()
    ]
    for line in ref_lines:
        # Expect at least "path:line" pattern
        parts = line.split(":")
        assert len(parts) >= 2, f"Expected path:line format, got: {line!r}"


def test_refs_command_no_refs(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """A symbol with no callers prints 'No references found'."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::__no_such_symbol_xyz__"])
    assert result.exit_code == 0
    assert "no references" in result.output.lower()


def test_refs_command_invalid_format(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """A plain symbol name without :: produces an error (not treated as file::symbol)."""
    # The existing refs command handles plain symbols (no ::).
    # When :: is present but malformed (empty parts), read_commands.refs raises.
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    # Empty symbol part after ::
    result = runner.invoke(app, ["refs", "index.ts::"])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# --json mode
# ---------------------------------------------------------------------------


def test_refs_json_output(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--json returns a valid JSON object with file, symbol, and refs keys."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert "file" in data
    assert "symbol" in data
    assert "refs" in data
    assert data["symbol"] == "greet"
    assert isinstance(data["refs"], list)


def test_refs_json_refs_have_expected_keys(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """Each entry in the refs list has path, line, and context keys."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    if data["refs"]:
        row = data["refs"][0]
        assert "path" in row
        assert "line" in row
        assert isinstance(row["line"], int)
        assert "context" in row


def test_refs_json_no_refs(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--json with no results returns an empty refs list, not an error."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::__no_such_symbol_xyz__", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert data["refs"] == []


# ---------------------------------------------------------------------------
# Backward compat: plain refs command still works
# ---------------------------------------------------------------------------


def test_refs_plain_symbol_still_works(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """refs greet (no ::) still works via the existing code path."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet"])
    assert result.exit_code == 0
    # Should find at least one result since greet is called in index.ts
    lines = [ln for ln in result.output.splitlines() if ln.strip()]
    assert len(lines) >= 1


# ---------------------------------------------------------------------------
# --callers flag — db.get_refs_with_callers
# ---------------------------------------------------------------------------


def test_get_refs_with_callers_returns_list(indexed_ts_dir, tmp_data_dir):
    """get_refs_with_callers returns a list without raising."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_refs_with_callers(proj.hash, "index.ts", "greet")
    assert isinstance(rows, list)


def test_get_refs_with_callers_row_keys(indexed_ts_dir, tmp_data_dir):
    """Each row has path, line, context, caller_name, caller_kind keys."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_refs_with_callers(proj.hash, "index.ts", "greet")
    assert len(rows) >= 1
    row = rows[0]
    assert "path" in row
    assert "line" in row
    assert "context" in row
    assert "caller_name" in row
    assert "caller_kind" in row


def test_get_refs_with_callers_finds_enclosing_method(indexed_ts_dir, tmp_data_dir):
    """greet called inside UserService.hello — caller_name should be 'hello'."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_refs_with_callers(proj.hash, "index.ts", "greet")
    # greet is called at line 11 inside UserService.hello
    assert len(rows) >= 1
    # At least one row should have a non-None caller_name (enclosing function found)
    callers_found = [r for r in rows if r["caller_name"] is not None]
    assert len(callers_found) >= 1, "Expected at least one row with enclosing function resolved"
    caller_names = {r["caller_name"] for r in callers_found}
    # The enclosing method is 'hello'
    assert "hello" in caller_names, f"Expected 'hello' in caller names, got: {caller_names}"


def test_get_refs_with_callers_unknown_symbol_returns_empty(indexed_ts_dir, tmp_data_dir):
    """Unknown symbol returns empty list (fail-soft)."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_refs_with_callers(proj.hash, "index.ts", "__no_such_symbol_xyz__")
    assert rows == []


def test_get_refs_with_callers_unknown_project_returns_empty(tmp_data_dir):
    """Non-existent project returns [] (fail-soft)."""
    from token_goat import db

    rows = db.get_refs_with_callers("nonexistent_project_hash_abc123", "index.ts", "greet")
    assert rows == []


def test_get_refs_with_callers_respects_limit(indexed_ts_dir, tmp_data_dir):
    """limit=1 returns at most 1 row."""
    from token_goat import db

    _proj_root, proj = indexed_ts_dir
    rows = db.get_refs_with_callers(proj.hash, "index.ts", "greet", limit=1)
    assert len(rows) <= 1


# ---------------------------------------------------------------------------
# --callers CLI flag
# ---------------------------------------------------------------------------


def test_refs_callers_flag_output_format(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--callers groups results by file and shows caller names."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet", "--callers"])
    assert result.exit_code == 0
    output = result.output
    # Header: count + symbol
    assert "reference" in output.lower()
    # File group header: a line ending with ':'
    file_header_lines = [ln for ln in output.splitlines() if ln.endswith(":") and not ln.startswith(" ")]
    assert len(file_header_lines) >= 1, f"Expected file group header, output:\n{output}"
    # Indented caller entry
    indented_lines = [ln for ln in output.splitlines() if ln.startswith("  ")]
    assert len(indented_lines) >= 1, f"Expected indented caller lines, output:\n{output}"
    # Each indented line should contain 'at line'
    for line in indented_lines:
        assert "at line" in line, f"Expected 'at line N' in: {line!r}"


def test_refs_callers_flag_shows_enclosing_method(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--callers output includes the enclosing method name 'hello'."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet", "--callers"])
    assert result.exit_code == 0
    # The ref inside UserService.hello should appear as 'hello() at line N'
    assert "hello()" in result.output, f"Expected 'hello()' in output:\n{result.output}"


def test_refs_callers_no_refs(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--callers with no results prints 'No references found'."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::__no_such_symbol_xyz__", "--callers"])
    assert result.exit_code == 0
    assert "no references" in result.output.lower()


def test_refs_callers_requires_file_symbol_format(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--callers on a plain symbol (no ::) exits with an error."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet", "--callers"])
    assert result.exit_code != 0


def test_refs_callers_json_includes_caller_fields(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """--callers --json includes caller_name and caller_kind fields in each ref."""
    import json

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "index.ts::greet", "--callers", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert "refs" in data
    assert len(data["refs"]) >= 1
    row = data["refs"][0]
    assert "caller_name" in row, f"Expected 'caller_name' key in {row}"
    assert "caller_kind" in row, f"Expected 'caller_kind' key in {row}"
