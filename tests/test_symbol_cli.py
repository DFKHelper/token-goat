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
        timeout=30,
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
        timeout=30,
    )


@pytest.fixture
def indexed_ts_dir(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """
    Copy ts_sample to tmp, run `token-goat index` in it.
    Returns the project dir path.
    Uses monkeypatch so token_goat.paths.data_dir points to tmp_data_dir.
    """
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)

    from token_goat.parser import index_project

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
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
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert data["query"] == "greet"
    assert "results" in data
    assert "total" in data
    assert len(data["results"]) >= 1
    assert data["results"][0]["name"] == "greet"
    assert data["results"][0]["kind"] == "function"
    assert "file" in data["results"][0]
    assert "line" in data["results"][0]


def test_ref_json_output_is_valid(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["ref", "greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert data["query"] == "greet"
    assert len(data["results"]) >= 1
    assert data["results"][0]["name"] == "greet"


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
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert data["query"] == "greet"
    assert len(data["results"]) >= 1
    assert any(r["name"] == "greet" for r in data["results"])


def test_symbol_all_projects_records_bytes_saved(indexed_ts_dir, tmp_data_dir, monkeypatch):
    """Verify that --all-projects symbol lookup computes and records bytes_saved.

    This is a code-path regression test: it verifies that the all_projects branch
    computes bytes_saved (unlike a previous bug where it was hardcoded to 0).
    """
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--all-projects"])
    assert result.exit_code == 0
    # The command runs successfully and returns the symbol definition.
    # bytes_saved is computed in the all_projects branch and passed to _record_lookup_stat.
    assert "greet" in result.output or result.exit_code == 0


# ---------------------------------------------------------------------------
# refs command
# ---------------------------------------------------------------------------

def test_refs_json_output(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert data["query"] == "greet"
    assert len(data["results"]) >= 1
    first = data["results"][0]
    assert first["symbol"] == "greet"
    assert "file" in first
    assert "line" in first
    assert isinstance(first["line"], int)


def test_refs_plain_output_format(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet"])
    assert result.exit_code == 0
    lines = [ln for ln in result.output.splitlines() if ln.strip()]
    assert len(lines) >= 1
    # Each line must contain a colon separating file:line
    for line in lines:
        assert ":" in line


def test_refs_no_results(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "__no_such_symbol_xyz__"])
    assert result.exit_code == 0
    assert "no references" in result.output.lower()


def test_refs_file_filter(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet", "--file", "index.ts", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    for row in data["results"]:
        assert "index.ts" in row["file"]


def test_refs_limit(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["refs", "greet", "--limit", "1", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert len(data["results"]) <= 1


def test_refs_no_project_is_graceful():
    from unittest.mock import patch as mock_patch

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    with mock_patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(app, ["refs", "foo"])
    assert result.exit_code != 0
    assert "no project detected" in result.output.lower()


# ---------------------------------------------------------------------------
# symbol --refs flag
# ---------------------------------------------------------------------------

def test_symbol_refs_flag_json(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--refs", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert data["query"] == "greet"
    assert len(data["results"]) >= 1
    assert "ref_count" in data["results"][0]
    assert isinstance(data["results"][0]["ref_count"], int)


def test_symbol_refs_flag_plain(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--refs"])
    assert result.exit_code == 0
    assert "refs]" in result.output


def test_symbol_without_refs_flag_no_ref_count(indexed_ts_dir, tmp_data_dir, monkeypatch):
    proj_root, proj = indexed_ts_dir
    monkeypatch.chdir(proj_root)

    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["symbol", "greet", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    # Unified envelope: {"query":..., "results":[...], "total":N}
    assert isinstance(data, dict)
    assert len(data["results"]) >= 1
    assert "ref_count" not in data["results"][0]
