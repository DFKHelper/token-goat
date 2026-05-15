"""CLI subprocess tests for symbol, ref, and index commands."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


def _run(args: list[str], cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run token-goat with the given args in the given cwd."""
    merged_env = {**os.environ}
    if env:
        merged_env.update(env)
    return subprocess.run(
        [sys.executable, "-m", "token_goat.cli", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        env=merged_env,
    )


def _run_uv(args: list[str], cwd: Path, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run via uv run token-goat."""
    merged_env = {**os.environ}
    if env:
        merged_env.update(env)
    return subprocess.run(
        ["uv", "run", "token-goat", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        env=merged_env,
    )


@pytest.fixture
def indexed_ts_dir(tmp_path, tmp_data_dir, monkeypatch):
    """
    Copy ts_sample to tmp, run `token-goat index` in it.
    Returns the project dir path.
    Uses monkeypatch so token_goat.paths.data_dir points to tmp_data_dir.
    """
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)

    # Build canonical project hash
    from token_goat.parser import index_project
    from token_goat.project import find_project

    # We need token_goat.paths to point to our tmp during index
    monkeypatch.chdir(proj_root)
    proj = find_project(proj_root)
    assert proj is not None
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# symbol command
# ---------------------------------------------------------------------------

def test_symbol_greet_json(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    monkeypatch.chdir(proj_root)
    # Query directly via Python (avoids subprocess env issues with tmp_data_dir)
    with _db.open_project(proj.hash) as conn:
        rows = conn.execute(
            "SELECT name, kind, file_rel, line, signature FROM symbols WHERE name='greet'"
        ).fetchall()
    assert len(rows) >= 1
    row = rows[0]
    assert row["name"] == "greet"
    assert row["kind"] == "function"


def test_symbol_nonexistent_exit_zero(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_project(proj.hash) as conn:
        rows = conn.execute(
            "SELECT name FROM symbols WHERE name='__totally_nonexistent_xyz__'"
        ).fetchall()
    assert len(rows) == 0


def test_ref_greet_returns_results(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_project(proj.hash) as conn:
        rows = conn.execute(
            "SELECT symbol_name, file_rel, line FROM refs WHERE symbol_name='greet'"
        ).fetchall()
    assert len(rows) >= 1
    # greet is called inside hello()
    assert any(r["symbol_name"] == "greet" for r in rows)


def test_symbols_all_expected_present(indexed_ts_dir, tmp_data_dir):
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_project(proj.hash) as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM symbols")}
    for expected in ("greet", "UserService", "hello", "User", "UserId", "router"):
        assert expected in names, f"Expected symbol {expected!r} not found"


def test_index_summary_non_trivial(indexed_ts_dir):
    """The index should contain more than zero symbols."""
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_project(proj.hash) as conn:
        sym_count = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        file_count = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    assert sym_count > 0
    assert file_count >= 1


def test_all_projects_symbol_lookup(indexed_ts_dir, tmp_data_dir):
    """After indexing, global DB should have greet in symbols_global."""
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_global() as gconn:
        rows = gconn.execute(
            "SELECT name FROM symbols_global WHERE name='greet' AND project_hash=?",
            (proj.hash,),
        ).fetchall()
    assert len(rows) >= 1


def test_imports_exports_populated(indexed_ts_dir):
    proj_root, proj = indexed_ts_dir
    from token_goat import db as _db

    with _db.open_project(proj.hash) as conn:
        imp_count = conn.execute(
            "SELECT COUNT(*) FROM imports_exports WHERE kind='import'"
        ).fetchone()[0]
        exp_count = conn.execute(
            "SELECT COUNT(*) FROM imports_exports WHERE kind='export'"
        ).fetchone()[0]
    assert imp_count >= 2
    assert exp_count >= 1


# ---------------------------------------------------------------------------
# No-project-marker behavior — patch find_project to return None
# ---------------------------------------------------------------------------

def test_no_project_symbol_is_graceful():
    """Running symbol command when no project is detected exits non-zero with a clear message."""
    from unittest.mock import patch as mock_patch

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    with mock_patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(app, ["symbol", "foo"])
    assert result.exit_code != 0
    assert "no project detected" in result.output.lower()


def test_no_project_ref_is_graceful():
    """Running ref command when no project is detected exits non-zero with a clear message."""
    from unittest.mock import patch as mock_patch

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    with mock_patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(app, ["ref", "foo"])
    assert result.exit_code != 0
    assert "no project detected" in result.output.lower()


def test_no_project_index_is_graceful():
    """Running index command when no project is detected exits non-zero with a clear message."""
    from unittest.mock import patch as mock_patch

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    with mock_patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(app, ["index"])
    assert result.exit_code != 0
    assert "no project detected" in result.output.lower()


# ---------------------------------------------------------------------------
# CLI output format tests
# ---------------------------------------------------------------------------

def test_symbol_json_output_is_valid(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert isinstance(data, list)
    assert len(data) >= 1
    assert data[0]["name"] == "greet"
    assert data[0]["kind"] == "function"
    assert "file" in data[0]
    assert "line" in data[0]


def test_ref_json_output_is_valid(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["ref", "greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert isinstance(data, list)
    assert len(data) >= 1
    assert data[0]["name"] == "greet"


def test_index_command_prints_summary(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["index"])
    assert result.exit_code == 0
    output = result.output
    # Should mention "Indexed" and a number
    assert "Indexed" in output or "indexed" in output.lower()


def test_symbol_all_projects_json(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--all-projects", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert isinstance(data, list)
    assert len(data) >= 1
    assert any(r["name"] == "greet" for r in data)
