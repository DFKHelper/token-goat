"""Tests for read_replacement module and the read/section CLI commands."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from tokenwise import read_replacement
from tokenwise.parser import index_project

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"
PY_SAMPLE = FIXTURE_DIR / "py_sample"
MD_SAMPLE = FIXTURE_DIR / "md_sample"


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def ts_project(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


@pytest.fixture
def py_project(tmp_path, tmp_data_dir, make_project):
    """Copy py_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root = tmp_path / "py_sample"
    shutil.copytree(PY_SAMPLE, proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


@pytest.fixture
def md_project(tmp_path, tmp_data_dir, make_project):
    """Copy md_sample to tmp dir, index it, return (proj_root, project)."""
    proj_root = tmp_path / "md_sample"
    shutil.copytree(MD_SAMPLE, proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# resolve_file_rel tests
# ---------------------------------------------------------------------------

def test_resolve_exact_match(ts_project):
    _, proj = ts_project
    rel = read_replacement.resolve_file_rel(proj, "index.ts")
    assert rel == "index.ts"


def test_resolve_bare_filename(ts_project):
    _, proj = ts_project
    # bare filename should match
    rel = read_replacement.resolve_file_rel(proj, "index.ts")
    assert rel is not None
    assert rel.endswith("index.ts")


def test_resolve_absolute_path(ts_project):
    proj_root, proj = ts_project
    abs_path = str(proj_root / "index.ts")
    rel = read_replacement.resolve_file_rel(proj, abs_path)
    assert rel == "index.ts"


def test_resolve_garbage_returns_none(ts_project):
    _, proj = ts_project
    rel = read_replacement.resolve_file_rel(proj, "totally_nonexistent_xyz_abc.ts")
    assert rel is None


def test_resolve_ambiguous_bare_filename_returns_none(tmp_path, tmp_data_dir, make_project):
    from tokenwise.parser import index_project

    proj_root = tmp_path / "ambiguous"
    (proj_root / "a").mkdir(parents=True)
    (proj_root / "b").mkdir(parents=True)
    (proj_root / "a" / "index.ts").write_text("export const a = 1;\n", encoding="utf-8")
    (proj_root / "b" / "index.ts").write_text("export const b = 2;\n", encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    assert read_replacement.resolve_file_rel(proj, "index.ts") is None


# ---------------------------------------------------------------------------
# read_symbol tests
# ---------------------------------------------------------------------------

def test_read_symbol_greet_text(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "greet")
    assert result is not None
    assert "function greet" in result["text"]
    assert "return" in result["text"]


def test_read_symbol_greet_lines(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "greet")
    assert result is not None
    # greet is on lines 4-6 per DB
    assert result["start_line"] == 4
    assert result["end_line"] == 6


def test_read_symbol_nonexistent_returns_none(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "__totally_nonexistent__")
    assert result is None


def test_read_symbol_context_lines(ts_project):
    _, proj = ts_project
    result_no_ctx = read_replacement.read_symbol(proj, "index.ts", "greet")
    result_with_ctx = read_replacement.read_symbol(proj, "index.ts", "greet", context_lines=2)
    assert result_with_ctx is not None
    # With context, start_line should be earlier (or equal if already at top)
    assert result_with_ctx["start_line"] <= result_no_ctx["start_line"]
    assert result_with_ctx["end_line"] >= result_no_ctx["end_line"]
    # The snippet must be longer (or equal if clipped at file boundaries)
    assert len(result_with_ctx["text"]) >= len(result_no_ctx["text"])


def test_read_symbol_userservice_class(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "UserService")
    assert result is not None
    assert result["kind"] == "class"
    assert "UserService" in result["text"]


def test_read_symbol_bytes_saved_positive(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "greet")
    assert result is not None
    assert result["bytes_saved"] > 0
    assert result["bytes_total"] > result["bytes_extracted"]


def test_read_symbol_result_fields(ts_project):
    _, proj = ts_project
    result = read_replacement.read_symbol(proj, "index.ts", "greet")
    assert result is not None
    for key in ("file", "symbol", "kind", "start_line", "end_line", "text",
                "signature", "bytes_total", "bytes_extracted", "bytes_saved"):
        assert key in result, f"Missing key: {key}"


# ---------------------------------------------------------------------------
# read_section tests
# ---------------------------------------------------------------------------

def test_read_section_methodology(md_project):
    _, proj = md_project
    result = read_replacement.read_section(proj, "article.md", "Methodology")
    assert result is not None
    assert "Methodology" in result["text"]


def test_read_section_case_insensitive(md_project):
    _, proj = md_project
    result = read_replacement.read_section(proj, "article.md", "methodology")
    assert result is not None
    assert "Methodology" in result["text"]


def test_read_section_nonexistent_returns_none(md_project):
    _, proj = md_project
    result = read_replacement.read_section(proj, "article.md", "Nonexistent Section XYZ")
    assert result is None


def test_read_section_bytes_saved_positive(md_project):
    _, proj = md_project
    result = read_replacement.read_section(proj, "article.md", "Methodology")
    assert result is not None
    assert result["bytes_saved"] > 0


def test_read_section_result_fields(md_project):
    _, proj = md_project
    result = read_replacement.read_section(proj, "article.md", "Methodology")
    assert result is not None
    for key in ("file", "heading", "level", "start_line", "end_line", "text",
                "bytes_total", "bytes_extracted", "bytes_saved"):
        assert key in result, f"Missing key: {key}"


# ---------------------------------------------------------------------------
# CLI tests via typer.testing.CliRunner
# ---------------------------------------------------------------------------

@pytest.fixture
def indexed_ts_cli(ts_project, monkeypatch):
    """Return (proj_root, proj) with cwd set to proj_root."""
    proj_root, proj = ts_project
    monkeypatch.chdir(proj_root)
    return proj_root, proj


@pytest.fixture
def indexed_md_cli(md_project, monkeypatch):
    """Return (proj_root, proj) with cwd set to proj_root."""
    proj_root, proj = md_project
    monkeypatch.chdir(proj_root)
    return proj_root, proj


def test_cli_read_greet_emits_body(indexed_ts_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::greet"])
    assert result.exit_code == 0
    assert "greet" in result.output
    assert "return" in result.output


def test_cli_read_nonexistent_symbol_exit_zero(indexed_ts_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::__totally_nonexistent__"])
    assert result.exit_code == 0


def test_cli_read_missing_separator_exit_2(indexed_ts_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts"])
    assert result.exit_code == 2


def test_cli_section_methodology(indexed_md_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["section", "article.md::Methodology"])
    assert result.exit_code == 0
    assert "Methodology" in result.output


def test_cli_read_json_output(indexed_ts_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "--json", "index.ts::greet"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert data["symbol"] == "greet"
    assert data["kind"] == "function"
    assert "text" in data
    assert "bytes_saved" in data
    assert "start_line" in data
    assert "end_line" in data
    assert data["bytes_saved"] > 0


def test_cli_read_with_session_id(indexed_ts_cli, tmp_data_dir):
    from typer.testing import CliRunner

    from tokenwise import session as session_mod
    from tokenwise.cli import app

    proj_root, _ = indexed_ts_cli
    session_id = "test-phase11-session"
    runner = CliRunner()
    result = runner.invoke(app, ["read", "--session-id", session_id, f"{proj_root / 'index.ts'}::greet"])
    assert result.exit_code == 0

    # Verify the session cache has greet recorded under the canonical relative path.
    entry = session_mod.get_file_entry(session_id, "index.ts")
    assert entry is not None
    assert entry.rel_or_abs == "index.ts"
    assert "greet" in entry.symbols_read


def test_cli_section_json_output(indexed_md_cli):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["section", "--json", "article.md::Methodology"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert data["heading"] == "Methodology"
    assert "text" in data
    assert "bytes_saved" in data
    assert data["bytes_saved"] > 0
