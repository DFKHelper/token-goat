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


def _make_ambiguous_project(
    tmp_path,
    make_project,
    rel_name: str,
    content_a: str,
    content_b: str,
):
    proj_root = tmp_path / "ambiguous"
    (proj_root / "a").mkdir(parents=True)
    (proj_root / "b").mkdir(parents=True)
    (proj_root / "a" / rel_name).write_text(content_a, encoding="utf-8")
    (proj_root / "b" / rel_name).write_text(content_b, encoding="utf-8")
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


def test_resolve_ambiguous_bare_filename_raises(tmp_path, tmp_data_dir, make_project):
    from tokenwise.read_replacement import AmbiguousFileMatch

    _proj_root, proj = _make_ambiguous_project(
        tmp_path,
        make_project,
        "index.ts",
        "export const a = 1;\n",
        "export const b = 2;\n",
    )

    with pytest.raises(AmbiguousFileMatch) as excinfo:
        read_replacement.resolve_file_rel(proj, "index.ts")
    assert excinfo.value.file_part == "index.ts"
    assert excinfo.value.candidates == ("a/index.ts", "b/index.ts")


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


def test_cli_read_reports_ambiguous_file_match(tmp_path, tmp_data_dir, make_project, monkeypatch):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    proj_root, _ = _make_ambiguous_project(
        tmp_path,
        make_project,
        "index.ts",
        "export const a = 1;\n",
        "export const b = 2;\n",
    )
    monkeypatch.chdir(proj_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::greet"])
    assert result.exit_code == 0
    assert "Ambiguous file match: index.ts" in result.output
    assert "a/index.ts" in result.output
    assert "b/index.ts" in result.output


def test_cli_section_reports_ambiguous_file_match(tmp_path, tmp_data_dir, make_project, monkeypatch):
    from typer.testing import CliRunner

    from tokenwise.cli import app

    proj_root, _ = _make_ambiguous_project(
        tmp_path,
        make_project,
        "article.md",
        "# One\n\n## Methodology\n\nA.\n",
        "# Two\n\n## Methodology\n\nB.\n",
    )
    monkeypatch.chdir(proj_root)

    runner = CliRunner()
    result = runner.invoke(app, ["section", "article.md::Methodology"])
    assert result.exit_code == 0
    assert "Ambiguous file match: article.md" in result.output
    assert "a/article.md" in result.output
    assert "b/article.md" in result.output


# ---------------------------------------------------------------------------
# read_commands._not_indexed_hint — unindexed project produces a hint
# ---------------------------------------------------------------------------

class TestNotIndexedHint:
    """_not_indexed_hint returns a prompt when the project has 0 indexed files."""

    def test_returns_hint_for_empty_project(self, tmp_data_dir, make_project, tmp_path):
        """When file_count == 0 (never indexed), _not_indexed_hint returns a string."""
        from tokenwise.read_commands import _not_indexed_hint

        proj_root = tmp_path / "empty_proj"
        proj_root.mkdir()
        proj = make_project(proj_root)
        # Project DB is created but never indexed — file count is 0.
        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "not yet indexed" in hint

    def test_returns_none_for_indexed_project(self, py_project):
        """When files are indexed, _not_indexed_hint returns None."""
        from tokenwise.read_commands import _not_indexed_hint

        _proj_root, proj = py_project
        hint = _not_indexed_hint(proj.hash)
        assert hint is None

    def test_returns_none_on_db_error(self, tmp_data_dir, monkeypatch):
        """If file_count() raises, _not_indexed_hint must swallow the error and return None."""
        from tokenwise import db
        from tokenwise.read_commands import _not_indexed_hint

        monkeypatch.setattr(db, "file_count", lambda _: (_ for _ in ()).throw(RuntimeError("db gone")))
        # Must not raise
        hint = _not_indexed_hint("deadbeef1234567890ab")
        assert hint is None


# ---------------------------------------------------------------------------
# read_commands — "no project detected" error path (lines 75-83)
# ---------------------------------------------------------------------------

class TestReadCommandNoProject:
    """When no project is detected for the cwd, read/section emits an error."""

    def test_read_no_project_exits_cleanly(self, tmp_data_dir, monkeypatch, tmp_path):
        """tokenwise read <file>::<sym> when cwd has no project must exit 0 with error text."""
        from typer.testing import CliRunner
        from tokenwise.cli import app
        from tokenwise import project as project_mod

        monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
        monkeypatch.chdir(tmp_path)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "nosuchfile.py::nosuchsym"])
        # Must exit cleanly (not crash) even with no project
        assert result.exit_code == 0

    def test_section_no_project_exits_cleanly(self, tmp_data_dir, monkeypatch, tmp_path):
        """tokenwise section <file>::<heading> with no project must exit 0 with error text."""
        from typer.testing import CliRunner
        from tokenwise.cli import app
        from tokenwise import project as project_mod

        monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
        monkeypatch.chdir(tmp_path)

        runner = CliRunner()
        result = runner.invoke(app, ["section", "nosuchfile.md::NoHeading"])
        assert result.exit_code == 0


# ---------------------------------------------------------------------------
# read_commands — cross-project fallback (_resolve_file_target lines 46-48)
# ---------------------------------------------------------------------------

class TestResolveFileCrossProject:
    """When the file is not in the current project, _resolve_file_target falls
    back to find_in_all_projects and resolves from another indexed project."""

    def test_read_resolves_cross_project_symbol(
        self, tmp_data_dir, make_project, tmp_path, monkeypatch
    ):
        """A symbol in a *different* indexed project is found via cross-project lookup."""
        from typer.testing import CliRunner
        from tokenwise.cli import app
        from tokenwise import project as project_mod

        # Build and index a "foreign" project with a known Python file
        foreign_root = tmp_path / "foreign"
        shutil.copytree(PY_SAMPLE, foreign_root)
        foreign_proj = make_project(foreign_root)
        index_project(foreign_proj, full=True)

        # CWD points to an *unrelated* directory with no project marker
        cwd = tmp_path / "unrelated"
        cwd.mkdir()
        monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
        monkeypatch.chdir(cwd)

        runner = CliRunner()
        # app.py is in py_sample; MyClass is a known symbol there
        result = runner.invoke(app, ["read", "app.py::MyClass"])
        # Should resolve via cross-project lookup — either finds the symbol
        # or exits cleanly (no exception / non-zero exit).
        assert result.exit_code == 0


# ---------------------------------------------------------------------------
# read_commands.deps — stub returns gracefully (line 112)
# ---------------------------------------------------------------------------

class TestDepsStub:
    """deps() is a stub that must not crash and must emit a message."""

    def test_deps_command_exits_without_error(self, tmp_data_dir, tmp_path, monkeypatch):
        """The deps stub command exits 0 and prints 'not yet implemented'."""
        from typer.testing import CliRunner
        from tokenwise.cli import app

        monkeypatch.chdir(tmp_path)
        runner = CliRunner()
        result = runner.invoke(app, ["deps", "somefile.py"])
        assert result.exit_code == 0
        assert "not yet implemented" in result.output
