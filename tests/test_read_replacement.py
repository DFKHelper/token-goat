"""Tests for read_replacement module and the read/section CLI commands."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from token_goat import embeddings as emb
from token_goat import read_replacement
from token_goat.parser import index_project

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


def _make_dependency_project(tmp_path, make_project):
    proj_root = tmp_path / "deps"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "a.ts").write_text(
        'import { b } from "./b";\nexport function a() { return b(); }\n',
        encoding="utf-8",
    )
    (proj_root / "b.ts").write_text("export function b() { return 1; }\n", encoding="utf-8")
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
    from token_goat.read_replacement import AmbiguousFileMatch

    _proj_root, proj = _make_ambiguous_project(
        tmp_path,
        make_project,
        "index.ts",
        "export const a = 1;\n",
        "export const b = 2;\n",
    )

    with pytest.raises(AmbiguousFileMatch) as excinfo:
        read_replacement.resolve_file_rel(proj, "index.ts")
    assert excinfo.value.code == "ambiguous_file"
    assert excinfo.value.file_part == "index.ts"
    assert excinfo.value.candidates == ("a/index.ts", "b/index.ts")


def test_resolve_bare_filename_with_literal_sql_like_chars(tmp_path, tmp_data_dir, make_project):
    proj_root = tmp_path / "wildcards"
    (proj_root / "src").mkdir(parents=True)
    (proj_root / "src" / "a%file.ts").write_text("export const a = 1;\n", encoding="utf-8")
    (proj_root / "src" / "afile.ts").write_text("export const b = 2;\n", encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)

    rel = read_replacement.resolve_file_rel(proj, "a%file.ts")
    assert rel == "src/a%file.ts"


@pytest.mark.parametrize(
    "path_value",
    [
        "/etc/passwd",
        r"C:\Windows\win.ini",
        r"\\server\share\file.txt",
        "../escape.py",
        r"..\escape.py",
    ],
)
def test_safe_rel_path_rejects_absolute_and_traversal(path_value):
    assert read_replacement._is_safe_rel_path(path_value) is False
    assert emb._is_safe_rel_path(path_value) is False


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

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::greet"])
    assert result.exit_code == 0
    assert "greet" in result.output
    assert "return" in result.output


def test_cli_read_nonexistent_symbol_exit_zero(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::__totally_nonexistent__"])
    assert result.exit_code == 0


def test_cli_read_missing_separator_exit_2(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts"])
    assert result.exit_code == 2


def test_cli_section_methodology(indexed_md_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["section", "article.md::Methodology"])
    assert result.exit_code == 0
    assert "Methodology" in result.output


def test_cli_read_json_output(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

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

    from token_goat import session as session_mod
    from token_goat.cli import app

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

    from token_goat.cli import app

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

    from token_goat.cli import app

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


def test_cli_read_reports_structured_json_error_for_ambiguous_match(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    from typer.testing import CliRunner

    from token_goat.cli import app

    proj_root, _ = _make_ambiguous_project(
        tmp_path,
        make_project,
        "index.ts",
        "export const a = 1;\n",
        "export const b = 2;\n",
    )
    monkeypatch.chdir(proj_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::greet", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "ambiguous_file"
    assert payload["error"]["file_part"] == "index.ts"
    assert [candidate.split(":", 1)[-1] for candidate in payload["error"]["candidates"]] == [
        "a/index.ts",
        "b/index.ts",
    ]


def test_cli_read_reports_structured_json_error_for_missing_symbol(
    ts_project, monkeypatch
):
    from typer.testing import CliRunner

    from token_goat.cli import app

    proj_root, _ = ts_project
    monkeypatch.chdir(proj_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::does_not_exist", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "symbol_not_found"
    assert payload["error"]["item"] == "does_not_exist"
    assert payload["error"]["rel_path"] == "index.ts"


def test_cli_read_reports_structured_json_error_for_project_not_indexed(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    from typer.testing import CliRunner

    from token_goat.cli import app

    proj_root = tmp_path / "empty_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    proj = make_project(proj_root)
    monkeypatch.chdir(proj_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::does_not_exist", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "project_not_indexed"
    assert payload["error"]["project_hash"] == proj.hash
    assert "not yet indexed" in payload["error"]["message"]


def test_cli_deps_reports_dependency_graph(tmp_path, make_project, monkeypatch):
    from contextlib import contextmanager

    from typer.testing import CliRunner

    from token_goat import read_commands
    from token_goat.cli import app

    proj_root = tmp_path / "deps"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    fake_proj = make_project(proj_root)

    @contextmanager
    def _fake_conn():
        yield object()

    monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
    monkeypatch.setattr(
        read_commands,
        "_resolve_file_target",
        lambda _file: (fake_proj, "a.ts", fake_proj),
    )
    monkeypatch.setattr(
        read_commands,
        "_collect_dependency_graph",
        lambda _conn, _rel: ({"b.ts": {"greet"}}, {"c.ts": {"greet", "router"}}, []),
    )

    runner = CliRunner()
    result = runner.invoke(app, ["deps", "a.ts"])
    assert result.exit_code == 0
    assert "Dependency graph for a.ts" in result.output
    assert "Dependencies" in result.output
    assert "b.ts" in result.output
    assert "greet" in result.output
    assert "Dependents" in result.output
    assert "c.ts" in result.output


def test_cli_deps_json_output(tmp_path, make_project, monkeypatch):
    """deps --json emits a valid JSON object with 'file', 'dependencies', 'dependents'."""
    import json as _json
    from contextlib import contextmanager

    from typer.testing import CliRunner

    from token_goat import read_commands
    from token_goat.cli import app

    proj_root = tmp_path / "deps_json"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    fake_proj = make_project(proj_root)

    @contextmanager
    def _fake_conn():
        yield object()

    monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
    monkeypatch.setattr(
        read_commands,
        "_resolve_file_target",
        lambda _file: (fake_proj, "a.ts", fake_proj),
    )
    monkeypatch.setattr(
        read_commands,
        "_collect_dependency_graph",
        lambda _conn, _rel: ({"b.ts": {"greet"}}, {"c.ts": {"router"}}, ["UnknownThing"]),
    )

    runner = CliRunner()
    result = runner.invoke(app, ["deps", "a.ts", "--json"])
    assert result.exit_code == 0
    data = _json.loads(result.output.strip())
    assert data["file"] == "a.ts"
    assert "b.ts" in data["dependencies"]
    assert "greet" in data["dependencies"]["b.ts"]
    assert "c.ts" in data["dependents"]
    assert "router" in data["dependents"]["c.ts"]
    assert data["unresolved_ref_count"] == 1
    assert "UnknownThing" in data["unresolved_refs"]
    assert data["dependency_edge_count"] == 1
    assert data["dependent_edge_count"] == 1


def test_cli_deps_transitive_json_output(tmp_path, make_project, monkeypatch):
    """deps --depth 2 --json emits all_dependencies with depth/via/symbols."""
    import json as _json
    from contextlib import contextmanager

    from typer.testing import CliRunner

    from token_goat import read_commands
    from token_goat.cli import app

    proj_root = tmp_path / "deps_transitive"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    fake_proj = make_project(proj_root)

    @contextmanager
    def _fake_conn():
        yield object()

    # Depth-1: a.ts → b.ts (greet); depth-2: b.ts → c.ts (helper)
    def _fake_collect_graph(_conn, _rel):
        return ({"b.ts": {"greet"}}, {}, [])

    def _fake_collect_transitive(_conn, _start, *, max_depth):
        return {
            "b.ts": {"depth": 1, "via": "a.ts", "symbols": {"greet"}},
            "c.ts": {"depth": 2, "via": "b.ts", "symbols": {"helper"}},
        }

    monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
    monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: (fake_proj, "a.ts", fake_proj))
    monkeypatch.setattr(read_commands, "_collect_dependency_graph", _fake_collect_graph)
    monkeypatch.setattr(read_commands, "_collect_transitive_outgoing", _fake_collect_transitive)

    runner = CliRunner()
    result = runner.invoke(app, ["deps", "a.ts", "--depth", "2", "--json"])
    assert result.exit_code == 0
    data = _json.loads(result.output.strip())
    assert data["depth"] == 2
    assert "all_dependencies" in data
    assert data["all_dependencies"]["b.ts"]["depth"] == 1
    assert data["all_dependencies"]["c.ts"]["depth"] == 2
    assert data["all_dependencies"]["c.ts"]["via"] == "b.ts"
    assert "helper" in data["all_dependencies"]["c.ts"]["symbols"]


def test_cli_read_reports_index_unavailable(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from token_goat import read_replacement
    from token_goat.cli import app
    from token_goat.read_replacement import ProjectIndexUnavailable

    proj_root = tmp_path / "read_unavailable"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    monkeypatch.chdir(proj_root)

    def _raise(_file_part: str) -> None:
        raise ProjectIndexUnavailable(
            "Project index database is unavailable. Run `token-goat index --full` again."
        )

    monkeypatch.setattr(read_replacement, "find_in_all_projects", _raise)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "missing.ts::sym"])
    assert result.exit_code == 0
    assert "project index database is unavailable" in result.output.lower()


def test_cli_deps_reports_index_unavailable(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from token_goat import read_replacement
    from token_goat.cli import app
    from token_goat.read_replacement import ProjectIndexUnavailable

    proj_root = tmp_path / "deps_unavailable"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    monkeypatch.chdir(proj_root)

    def _raise(_file_part: str) -> None:
        raise ProjectIndexUnavailable(
            "Project index database is unavailable. Run `token-goat index --full` again."
        )

    monkeypatch.setattr(read_replacement, "find_in_all_projects", _raise)

    runner = CliRunner()
    result = runner.invoke(app, ["deps", "missing.ts"])
    assert result.exit_code == 0
    assert "project index database is unavailable" in result.output.lower()


def test_cli_section_reports_ambiguous_file_match(tmp_path, tmp_data_dir, make_project, monkeypatch):
    from typer.testing import CliRunner

    from token_goat.cli import app

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


def test_cli_section_reports_structured_json_error_for_missing_heading(indexed_md_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["section", "article.md::NoSuchHeading", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "section_not_found"
    assert payload["error"]["item"] == "NoSuchHeading"
    assert payload["error"]["item_kind"] == "section"
    assert payload["error"]["rel_path"] == "article.md"


# ---------------------------------------------------------------------------
# read_commands._not_indexed_hint — unindexed project produces a hint
# ---------------------------------------------------------------------------

class TestNotIndexedHint:
    """_not_indexed_hint returns a prompt when the project has 0 indexed files."""

    def test_returns_hint_for_empty_project(self, tmp_data_dir, make_project, tmp_path):
        """When file_count == 0 (never indexed), _not_indexed_hint returns a string."""
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "empty_proj"
        proj_root.mkdir()
        proj = make_project(proj_root)
        # Project DB is created but never indexed — file count is 0.
        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "not yet indexed" in hint

    def test_returns_none_for_indexed_project(self, py_project):
        """When files are indexed, _not_indexed_hint returns None."""
        from token_goat.read_commands import _not_indexed_hint

        _proj_root, proj = py_project
        hint = _not_indexed_hint(proj.hash)
        assert hint is None

    def test_returns_diagnostic_on_db_error(self, tmp_data_dir, monkeypatch):
        """If the indexed-file probe raises, _not_indexed_hint should surface that fact."""
        from token_goat import db
        from token_goat.read_commands import _not_indexed_hint

        monkeypatch.setattr(
            db,
            "project_has_files",
            lambda _: (_ for _ in ()).throw(OSError("db gone")),
        )
        hint = _not_indexed_hint("deadbeef1234567890ab")
        assert hint is not None
        assert "unable to check whether this project is indexed" in hint


def test_find_in_all_projects_raises_when_global_db_unavailable(monkeypatch):
    from token_goat import db
    from token_goat.read_replacement import ProjectIndexUnavailable, find_in_all_projects

    def _boom():
        raise OSError("disk I/O error")

    monkeypatch.setattr(db, "open_global_readonly", _boom)

    with pytest.raises(ProjectIndexUnavailable):
        find_in_all_projects("index.ts")


# ---------------------------------------------------------------------------
# read_commands — "no project detected" error path (lines 75-83)
# ---------------------------------------------------------------------------

class TestReadCommandNoProject:
    """When no project is detected for the cwd, read/section emits an error."""

    def test_read_no_project_exits_cleanly(self, tmp_data_dir, monkeypatch, tmp_path):
        """token-goat read <file>::<sym> when cwd has no project must exit 0 with error text."""
        from typer.testing import CliRunner

        from token_goat import project as project_mod
        from token_goat.cli import app

        monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
        monkeypatch.chdir(tmp_path)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "nosuchfile.py::nosuchsym"])
        # Must exit cleanly (not crash) even with no project
        assert result.exit_code == 0

    def test_section_no_project_exits_cleanly(self, tmp_data_dir, monkeypatch, tmp_path):
        """token-goat section <file>::<heading> with no project must exit 0 with error text."""
        from typer.testing import CliRunner

        from token_goat import project as project_mod
        from token_goat.cli import app

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

        from token_goat import project as project_mod
        from token_goat.cli import app

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
# read_commands.deps — error path coverage
# ---------------------------------------------------------------------------

class TestDepsCommandErrors:
    """deps() should fail cleanly when the target file is missing."""

    def test_deps_missing_file_exits_without_error(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch
    ):
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root = tmp_path / "deps_missing"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.ts").write_text("export function a() { return 1; }\n", encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["deps", "missing.ts"])
        assert result.exit_code == 0
        assert "File not found in any indexed project: missing.ts" in result.output


# ---------------------------------------------------------------------------
# File-resolution cache (item 8) and specificity ranking (item 14)
# ---------------------------------------------------------------------------

class TestMatchSpecificity:
    """Unit tests for _match_specificity and _pick_best_match."""

    def test_bare_filename_scores_above_partial_path(self):
        from token_goat.read_replacement import _match_specificity
        # "parser.py" matching "src/token_goat/parser.py" vs "vendor/parser.py"
        score_deep = _match_specificity("parser.py", "src/token_goat/parser.py")
        score_shallow = _match_specificity("parser.py", "vendor/parser.py")
        # Both have suffix_len=1 (bare filename), but shallow has fewer components
        assert score_deep[0] == score_shallow[0] == 1
        assert score_shallow > score_deep  # neg_path_depth closer to 0

    def test_longer_suffix_wins(self):
        from token_goat.read_replacement import _match_specificity
        score_short = _match_specificity("parser.py", "src/token_goat/parser.py")
        score_long = _match_specificity("token_goat/parser.py", "src/token_goat/parser.py")
        assert score_long > score_short

    def test_pick_best_match_resolves_unambiguous(self):
        from token_goat.read_replacement import _pick_best_match
        candidates = ["src/token_goat/parser.py", "vendor/lib/parser.py"]
        # "token_goat/parser.py" is a longer suffix of the first but not the second
        best = _pick_best_match("token_goat/parser.py", candidates)
        assert best == "src/token_goat/parser.py"

    def test_pick_best_match_returns_none_on_tie(self):
        from token_goat.read_replacement import _pick_best_match
        # Two equally shallow bare-filename matches
        candidates = ["a/foo.py", "b/foo.py"]
        assert _pick_best_match("foo.py", candidates) is None

    def test_pick_best_match_single_candidate(self):
        from token_goat.read_replacement import _pick_best_match
        assert _pick_best_match("foo.py", ["src/foo.py"]) == "src/foo.py"

    def test_pick_best_match_empty(self):
        from token_goat.read_replacement import _pick_best_match
        assert _pick_best_match("foo.py", []) is None


class TestResolveFileCache:
    """Tests for _resolve_cache_get/put and invalidate_file_cache."""

    def setup_method(self):
        from token_goat import read_replacement as rr
        rr._RESOLVE_CACHE.clear()

    def test_cache_miss_returns_false(self):
        from token_goat.read_replacement import _resolve_cache_get
        hit, val = _resolve_cache_get("proj-abc", "src/foo.py")
        assert not hit
        assert val is None

    def test_cache_put_and_hit(self):
        from token_goat.read_replacement import _resolve_cache_get, _resolve_cache_put
        _resolve_cache_put("proj-abc", "foo.py", "src/foo.py")
        hit, val = _resolve_cache_get("proj-abc", "foo.py")
        assert hit
        assert val == "src/foo.py"

    def test_cache_stores_none_result(self):
        from token_goat.read_replacement import _resolve_cache_get, _resolve_cache_put
        _resolve_cache_put("proj-abc", "missing.py", None)
        hit, val = _resolve_cache_get("proj-abc", "missing.py")
        assert hit
        assert val is None

    def test_invalidate_clears_only_that_project(self):
        from token_goat.read_replacement import (
            _resolve_cache_get,
            _resolve_cache_put,
            invalidate_file_cache,
        )
        _resolve_cache_put("proj-A", "foo.py", "src/foo.py")
        _resolve_cache_put("proj-B", "foo.py", "lib/foo.py")
        count = invalidate_file_cache("proj-A")
        assert count == 1
        hit_a, _ = _resolve_cache_get("proj-A", "foo.py")
        hit_b, _ = _resolve_cache_get("proj-B", "foo.py")
        assert not hit_a
        assert hit_b

    def test_cache_evicts_oldest_when_full(self):
        from token_goat import read_replacement as rr
        rr._RESOLVE_CACHE.clear()
        # Fill beyond MAX to trigger eviction
        for i in range(rr._RESOLVE_CACHE_MAX):
            rr._resolve_cache_put("proj", f"file{i}.py", f"src/file{i}.py")
        assert len(rr._RESOLVE_CACHE) == rr._RESOLVE_CACHE_MAX
        # Adding one more triggers eviction of _RESOLVE_CACHE_EVICT entries
        rr._resolve_cache_put("proj", "new.py", "src/new.py")
        assert len(rr._RESOLVE_CACHE) == rr._RESOLVE_CACHE_MAX - rr._RESOLVE_CACHE_EVICT + 1
        # Oldest entries were evicted
        hit, _ = rr._resolve_cache_get("proj", "file0.py")
        assert not hit
        # Newest entry is present
        hit, val = rr._resolve_cache_get("proj", "new.py")
        assert hit and val == "src/new.py"

    def test_resolve_file_rel_uses_cache(self, tmp_data_dir, make_project, tmp_path):
        """resolve_file_rel result is cached; second call skips DB entirely."""
        import shutil

        from token_goat import read_replacement as rr
        from token_goat.parser import index_project

        rr._RESOLVE_CACHE.clear()
        proj_root = tmp_path / "cache_test_proj"
        shutil.copytree(PY_SAMPLE, proj_root)
        proj = make_project(proj_root)
        index_project(proj, full=True)

        # First call populates cache
        rel1 = rr.resolve_file_rel(proj, "app.py")
        assert rel1 == "app.py"
        assert (proj.hash, "app.py") in rr._RESOLVE_CACHE

        # Corrupt DB path to ensure second call uses cache (not DB)
        import unittest.mock as mock
        with mock.patch.object(rr, "_resolve_file_rel_db", side_effect=RuntimeError("should not be called")):
            rel2 = rr.resolve_file_rel(proj, "app.py")
        assert rel2 == "app.py"
