"""Tests for `token-goat export`."""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def indexed_proj(tmp_path, tmp_data_dir, make_project, monkeypatch):
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)

    from token_goat.parser import index_project

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# JSON format
# ---------------------------------------------------------------------------

def test_export_json_default(indexed_proj, monkeypatch):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["export"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert isinstance(data, list)
    # ts_sample has symbols; at minimum one should be present
    assert len(data) >= 1
    first = data[0]
    assert set(first.keys()) == {"name", "kind", "file", "start_line", "end_line", "parent_name"}
    assert isinstance(first["start_line"], int)


def test_export_json_explicit_format(indexed_proj, monkeypatch):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["export", "--format", "json"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert isinstance(data, list)


def test_export_json_empty_db(tmp_path, tmp_data_dir, make_project, monkeypatch):
    proj_root = tmp_path / "empty"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    from token_goat import db as _db

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    # Create the project DB with schema but insert no symbols
    with _db.open_project(proj.hash) as _conn:
        pass

    result = runner.invoke(cli.app, ["export"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data == []


def test_export_json_no_db_at_all(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """When no DB exists yet (never indexed), export emits an empty array."""
    proj_root = tmp_path / "fresh"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    monkeypatch.chdir(proj_root)
    make_project(proj_root)  # register project but do NOT index

    result = runner.invoke(cli.app, ["export"])
    assert result.exit_code == 0
    assert json.loads(result.output) == []


# ---------------------------------------------------------------------------
# CSV format
# ---------------------------------------------------------------------------

def test_export_csv(indexed_proj, monkeypatch):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["export", "--format", "csv"])
    assert result.exit_code == 0
    lines = result.output.splitlines()
    assert lines[0] == "name,kind,file,start_line,end_line,parent_name"
    assert len(lines) > 1
    reader = csv.DictReader(result.output.splitlines())
    rows = list(reader)
    assert len(rows) >= 1
    assert "name" in rows[0]
    assert "kind" in rows[0]
    assert "file" in rows[0]


def test_export_csv_empty_db(tmp_path, tmp_data_dir, make_project, monkeypatch):
    proj_root = tmp_path / "empty"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    from token_goat import db as _db

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    with _db.open_project(proj.hash) as _conn:
        pass

    result = runner.invoke(cli.app, ["export", "--format", "csv"])
    assert result.exit_code == 0
    lines = [ln for ln in result.output.splitlines() if ln]
    # Only the header row when no symbols
    assert lines == ["name,kind,file,start_line,end_line,parent_name"]


# ---------------------------------------------------------------------------
# ctags format
# ---------------------------------------------------------------------------

def test_export_ctags(indexed_proj, monkeypatch):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["export", "--format", "ctags"])
    assert result.exit_code == 0
    lines = result.output.splitlines()
    assert any(ln.startswith("!_TAG_FILE_SORTED") for ln in lines)
    # Symbol lines: tab-separated name, file, lineno;"<kind>
    sym_lines = [ln for ln in lines if not ln.startswith("!")]
    assert len(sym_lines) >= 1
    parts = sym_lines[0].split("\t")
    assert len(parts) >= 3
    # Third field should be "<lineno>;\""
    assert parts[2].endswith(';"') or ';"' in parts[2]


def test_export_ctags_empty(tmp_path, tmp_data_dir, make_project, monkeypatch):
    proj_root = tmp_path / "empty"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    from token_goat import db as _db

    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    with _db.open_project(proj.hash) as _conn:
        pass

    result = runner.invoke(cli.app, ["export", "--format", "ctags"])
    assert result.exit_code == 0
    lines = [ln for ln in result.output.splitlines() if ln]
    # Only header tags, no symbol lines
    assert all(ln.startswith("!") for ln in lines)


def test_export_ctags_parent(indexed_proj, monkeypatch):
    """Methods on a class should include class:<parent_name> field."""
    proj_root, proj = indexed_proj
    monkeypatch.chdir(proj_root)

    from token_goat import db as _db

    with _db.open_project_readonly(proj.hash) as conn:
        rows = conn.execute(
            "SELECT s.name FROM symbols s JOIN symbols p ON p.id = s.parent_id LIMIT 1"
        ).fetchall()
    if not rows:
        pytest.skip("no nested symbols in ts_sample")

    result = runner.invoke(cli.app, ["export", "--format", "ctags"])
    assert result.exit_code == 0
    lines = result.output.splitlines()
    sym_lines = [ln for ln in lines if not ln.startswith("!")]
    has_class_field = any("\tclass:" in ln for ln in sym_lines)
    assert has_class_field


# ---------------------------------------------------------------------------
# --output flag
# ---------------------------------------------------------------------------

def test_export_output_file(indexed_proj, monkeypatch, tmp_path):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    out_file = tmp_path / "out.json"
    result = runner.invoke(cli.app, ["export", "--output", str(out_file)])
    assert result.exit_code == 0
    assert out_file.exists()
    data = json.loads(out_file.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    # stderr message (typer runner mixes stdout/stderr by default, so check output contains it)
    assert "exported" in result.output


def test_export_csv_output_file(indexed_proj, monkeypatch, tmp_path):
    proj_root, _ = indexed_proj
    monkeypatch.chdir(proj_root)
    out_file = tmp_path / "symbols.csv"
    result = runner.invoke(cli.app, ["export", "--format", "csv", "--output", str(out_file)])
    assert result.exit_code == 0
    assert out_file.exists()
    content = out_file.read_text(encoding="utf-8")
    assert content.startswith("name,kind,file")


# ---------------------------------------------------------------------------
# --project flag
# ---------------------------------------------------------------------------

def test_export_project_flag(indexed_proj, tmp_path, tmp_data_dir):
    proj_root, _ = indexed_proj
    result = runner.invoke(cli.app, ["export", "--project", str(proj_root)])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert isinstance(data, list)
    assert len(data) >= 1


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------

def test_export_invalid_format(tmp_path, tmp_data_dir, make_project, monkeypatch):
    proj_root = tmp_path / "p"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    monkeypatch.chdir(proj_root)
    make_project(proj_root)
    result = runner.invoke(cli.app, ["export", "--format", "xml"])
    assert result.exit_code == 1


def test_export_no_project(tmp_path, monkeypatch, tmp_data_dir):
    """Exits with 1 when not in any project."""
    bare = tmp_path / "bare"
    bare.mkdir()
    monkeypatch.chdir(bare)
    result = runner.invoke(cli.app, ["export"])
    assert result.exit_code == 1
