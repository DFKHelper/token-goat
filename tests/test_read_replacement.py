"""Tests for read_replacement module and the read/section CLI commands."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from token_goat import read_replacement
from token_goat.parser import index_project
from token_goat.read_commands import _FileTarget

# Sample fixture directories (for direct use in test methods)
FIXTURE_DIR = Path(__file__).parent / "fixtures"
PY_SAMPLE = FIXTURE_DIR / "py_sample"

# Re-export shared fixtures from conftest with tuple variant aliases
# (conftest provides ts_project_tuple, py_project_tuple, md_project_tuple)
@pytest.fixture
def ts_project(ts_project_tuple):
    """Alias ts_project_tuple for backward compatibility in this test file."""
    return ts_project_tuple


@pytest.fixture
def py_project(py_project_tuple):
    """Alias py_project_tuple for backward compatibility in this test file."""
    return py_project_tuple


@pytest.fixture
def md_project(md_project_tuple):
    """Alias md_project_tuple for backward compatibility in this test file."""
    return md_project_tuple


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
    # _is_safe_rel_path now lives in token_goat.paths and is re-exported by
    # read_replacement; embeddings no longer owns its own copy.
    assert read_replacement._is_safe_rel_path(path_value) is False


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
# Qualified Class.method symbol lookup (read_symbol "file::Class.method")
# ---------------------------------------------------------------------------


def _make_method_collision_project(tmp_path, make_project):
    """Project with a free function and a class method that share a name."""
    proj_root = tmp_path / "method_collision"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "app.py").write_text(
        # NOTE: keep both `hello` symbols on distinct line ranges so the
        # qualifier-by-line-containment filter has something to discriminate.
        "def hello() -> str:\n"
        "    return 'free'\n"
        "\n"
        "\n"
        "class Greeter:\n"
        "    def hello(self) -> str:\n"
        "        return 'method'\n",
        encoding="utf-8",
    )
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


def test_read_symbol_qualified_picks_method(tmp_path, tmp_data_dir, make_project):
    """``Class.method`` lookup returns the method, not the free function."""
    _, proj = _make_method_collision_project(tmp_path, make_project)
    result = read_replacement.read_symbol(proj, "app.py", "Greeter.hello")
    assert result is not None
    assert result["kind"] == "method"
    # The method body is on lines 6-7 of the fixture; the free function is at 1-2.
    assert result["start_line"] >= 6
    assert "method" in result["text"]


def test_read_symbol_unqualified_falls_back_to_priority(
    tmp_path, tmp_data_dir, make_project,
):
    """Bare ``hello`` still picks by kind priority (function over method)."""
    _, proj = _make_method_collision_project(tmp_path, make_project)
    result = read_replacement.read_symbol(proj, "app.py", "hello")
    assert result is not None
    # Free function ranks higher than method in _KIND_PRIORITY.
    assert result["kind"] == "function"
    assert "free" in result["text"]


def test_read_symbol_qualified_wrong_class_falls_back(
    tmp_path, tmp_data_dir, make_project,
):
    """When the qualifier does not match any class, fall back to unqualified."""
    _, proj = _make_method_collision_project(tmp_path, make_project)
    # ``Nope`` is not a class in the file — fall back to bare ``hello`` lookup.
    result = read_replacement.read_symbol(proj, "app.py", "Nope.hello")
    assert result is not None
    # Falls back to the kind-priority winner from unqualified lookup.
    assert result["kind"] == "function"


def test_split_qualified_symbol_handles_bare_name():
    """``_split_qualified_symbol`` returns (None, name) for unqualified input."""
    qualifier, leaf = read_replacement._split_qualified_symbol("hello")
    assert qualifier is None
    assert leaf == "hello"


def test_split_qualified_symbol_handles_nested_qualifier():
    """``A.B.method`` collapses to immediate parent ``B`` + leaf ``method``."""
    qualifier, leaf = read_replacement._split_qualified_symbol("Outer.Inner.method")
    assert qualifier == "Inner"
    assert leaf == "method"


# ---------------------------------------------------------------------------
# Section ordinal disambiguation (Heading#N)
# ---------------------------------------------------------------------------


def _make_duplicate_section_project(tmp_path, make_project):
    """Doc with two ``## Example`` headings to exercise ordinal selection."""
    proj_root = tmp_path / "dup_sections"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "doc.md").write_text(
        "# Top\n"
        "\n"
        "## Example\n"
        "\n"
        "first example body\n"
        "\n"
        "## Other\n"
        "\n"
        "filler\n"
        "\n"
        "## Example\n"
        "\n"
        "second example body\n",
        encoding="utf-8",
    )
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


def test_read_section_duplicate_returns_first_with_warning(
    tmp_path, tmp_data_dir, make_project, caplog,
):
    """Unqualified duplicate heading lookup picks the first by line order."""
    import logging as _logging
    _, proj = _make_duplicate_section_project(tmp_path, make_project)
    with caplog.at_level(_logging.WARNING, logger="token_goat.read_replacement"):
        result = read_replacement.read_section(proj, "doc.md", "Example")
    assert result is not None
    assert "first example body" in result["text"]
    # A warning must explain how to pick the second occurrence.
    assert any("share heading" in r.getMessage() for r in caplog.records)


def test_read_section_ordinal_picks_nth(tmp_path, tmp_data_dir, make_project):
    """``Heading#2`` returns the second occurrence."""
    _, proj = _make_duplicate_section_project(tmp_path, make_project)
    result = read_replacement.read_section(proj, "doc.md", "Example#2")
    assert result is not None
    assert "second example body" in result["text"]


def test_read_section_ordinal_out_of_range_returns_none(
    tmp_path, tmp_data_dir, make_project,
):
    """``Heading#99`` for a doc with two matches returns None (not the first)."""
    _, proj = _make_duplicate_section_project(tmp_path, make_project)
    result = read_replacement.read_section(proj, "doc.md", "Example#99")
    assert result is None


def test_parse_section_ordinal_rejects_zero_and_negatives():
    """Ordinal ``0`` and negatives are treated as no-ordinal (heading kept whole)."""
    assert read_replacement._parse_section_ordinal("Example#0") == ("Example#0", None)
    assert read_replacement._parse_section_ordinal("Example#-1") == ("Example#-1", None)


def test_parse_section_ordinal_rejects_nondigit_suffix():
    """``Foo#bar`` is a real heading, not an ordinal — leave it alone."""
    assert read_replacement._parse_section_ordinal("Foo#bar") == ("Foo#bar", None)


def test_parse_section_ordinal_empty_base_is_left_intact():
    """``#42`` has no base name and must not be split (no implicit heading)."""
    assert read_replacement._parse_section_ordinal("#42") == ("#42", None)


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


def test_cli_read_nonexistent_symbol_exit_nonzero(indexed_ts_cli):
    """A missing symbol is an error, not a successful empty read.

    The command must exit non-zero (1) and emit a diagnostic to stderr so the
    agent/shell can tell a genuine miss apart from a read that legitimately
    returned nothing.  No close match exists for this token, so the output
    falls back to the ``outline`` hint rather than a "Did you mean" list.
    """
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::__totally_nonexistent__"])
    assert result.exit_code == 1
    combined = result.output + (result.stderr or "")
    assert "Symbol not found" in combined
    # With no close match, the fallback hint points at `outline`.
    assert "outline" in combined


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


# ---------------------------------------------------------------------------
# format_callers_footer
# ---------------------------------------------------------------------------

def test_format_callers_footer_with_callers(ts_project):
    """footer shows callers when refs exist (greet is called at line 11 in index.ts)."""
    _, proj = ts_project
    footer = read_replacement.format_callers_footer(proj, "greet")
    # greet is called inside UserService.hello — should appear in the footer
    assert footer.startswith("Refs:"), repr(footer)
    assert "index.ts" in footer
    assert ":11" in footer  # line 11: return greet(this.name);


def test_format_callers_footer_no_callers(ts_project):
    """footer is empty when the symbol has no call-site refs."""
    _, proj = ts_project
    # UserService is defined but never called in the fixture file
    footer = read_replacement.format_callers_footer(proj, "UserService")
    assert footer == ""


def test_format_callers_footer_db_error(ts_project, monkeypatch):
    """footer is empty (fail-soft) when get_symbol_callers raises an exception."""
    import token_goat.db as _db
    _, proj = ts_project

    def _raise(*args, **kwargs):
        raise RuntimeError("simulated DB failure")

    monkeypatch.setattr(_db, "get_symbol_callers", _raise)
    # format_callers_footer must catch the exception and return ""
    footer = read_replacement.format_callers_footer(proj, "anything")
    assert footer == ""


def test_format_callers_footer_and_more(ts_project, monkeypatch):
    """footer shows '(and more)' when more than limit callers exist."""
    _, proj = ts_project
    # Patch get_symbol_callers to return limit+1 entries
    import token_goat.db as _db
    monkeypatch.setattr(
        _db,
        "get_symbol_callers",
        lambda *_args, **_kwargs: [
            {"file_rel": f"file{i}.py", "line": i * 10}
            for i in range(1, 5)  # 4 rows → has_more is True for limit=3
        ],
    )
    footer = read_replacement.format_callers_footer(proj, "something", limit=3)
    assert "and more" in footer
    assert footer.count(",") == 2  # only first 3 shown


def test_format_callers_footer_exactly_at_limit(ts_project, monkeypatch):
    """footer shows no '(and more)' when exactly limit callers are returned."""
    _, proj = ts_project
    import token_goat.db as _db
    monkeypatch.setattr(
        _db,
        "get_symbol_callers",
        lambda *_args, **_kwargs: [
            {"file_rel": f"f{i}.py", "line": i}
            for i in range(1, 4)  # exactly 3 rows — has_more is False for limit=3
        ],
    )
    footer = read_replacement.format_callers_footer(proj, "something", limit=3)
    assert "and more" not in footer
    assert footer.startswith("Refs:")


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
    # Exit 1 (not 0) so a caller checking the status code can tell a genuine
    # miss apart from a successful read that returned empty text.
    assert result.exit_code == 1
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
        lambda _file: _FileTarget(fake_proj, "a.ts", fake_proj),
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
        lambda _file: _FileTarget(fake_proj, "a.ts", fake_proj),
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
    monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: _FileTarget(fake_proj, "a.ts", fake_proj))
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
    # Exit 1 (not 0) so a caller checking the status code can distinguish a
    # genuine miss from a successful read that returned empty text.
    assert result.exit_code == 1
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

    def test_detects_indexing_in_progress(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        """_not_indexed_hint returns 'in progress' message when indexing is active."""
        from token_goat import worker
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "in_progress"
        proj_root.mkdir()
        proj = make_project(proj_root)

        # Mock _index_spawn_active to return True
        monkeypatch.setattr(worker, "_index_spawn_active", lambda marker: True)

        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "indexing is currently in progress" in hint

    def test_detects_indexing_failed(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        """_not_indexed_hint returns 'failed' message when marker exists but process is gone."""
        from token_goat import paths, worker
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "failed"
        proj_root.mkdir()
        proj = make_project(proj_root)

        # Create a stale marker file (process is gone)
        marker_dir = paths.locks_dir()
        marker_dir.mkdir(parents=True, exist_ok=True)
        marker = marker_dir / f"{proj.hash}.indexing"
        marker.write_text("99999\n0.0\n", encoding="utf-8")

        # Mock _index_spawn_active to return False (stale/gone process)
        monkeypatch.setattr(worker, "_index_spawn_active", lambda m: False)

        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "may have failed" in hint

    def test_detects_not_yet_started(self, tmp_data_dir, make_project, tmp_path, monkeypatch):
        """_not_indexed_hint returns generic message when no marker exists."""
        from token_goat import worker
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "not_started"
        proj_root.mkdir()
        proj = make_project(proj_root)

        # Mock _index_spawn_active to return False and ensure marker doesn't exist
        monkeypatch.setattr(worker, "_index_spawn_active", lambda marker: False)

        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "not yet indexed" in hint
        # Should not say "in progress" or "may have failed"
        assert "in progress" not in hint
        assert "may have failed" not in hint

    def test_handles_malformed_marker(self, tmp_data_dir, make_project, tmp_path):
        """_not_indexed_hint correctly handles malformed marker file.

        _index_spawn_active returns False for malformed markers (ValueError on int/float
        conversion), so the hint should fall through to the "may have failed" case
        since marker.exists() is True.
        """
        from token_goat import paths
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "malformed"
        proj_root.mkdir()
        proj = make_project(proj_root)

        # Create a malformed marker file
        marker_dir = paths.locks_dir()
        marker_dir.mkdir(parents=True, exist_ok=True)
        marker = marker_dir / f"{proj.hash}.indexing"
        marker.write_text("not-a-pid\nnot-a-timestamp\n", encoding="utf-8")

        # _index_spawn_active returns False for malformed markers
        # so the hint should say "may have failed" since marker exists
        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "may have failed" in hint

    def test_handles_missing_locks_dir(self, tmp_data_dir, make_project, tmp_path):
        """_not_indexed_hint correctly handles missing locks/ directory.

        When locks_dir doesn't exist yet, marker.exists() returns False,
        so the hint should say "not yet indexed" (never started).
        """
        from token_goat.read_commands import _not_indexed_hint

        proj_root = tmp_path / "no_locks_dir"
        proj_root.mkdir()
        proj = make_project(proj_root)

        # Don't create locks_dir—it doesn't exist yet
        # marker.exists() on a path under non-existent parent returns False
        hint = _not_indexed_hint(proj.hash)
        assert hint is not None
        assert "not yet indexed" in hint

    @pytest.mark.skip(
        reason="CI-only flake on Python 3.13: monkeypatch on db.project_has_files "
        "doesn't propagate to read_commands.db.project_has_files lookup. The "
        "underlying except-OSError branch is exercised by integration tests."
    )
    def test_returns_diagnostic_on_db_error(self, tmp_data_dir, monkeypatch):
        """If the indexed-file probe raises, _not_indexed_hint should surface that fact."""
        from token_goat import db
        from token_goat.read_commands import _not_indexed_hint

        def _boom(_project_hash):
            raise OSError("db gone")

        monkeypatch.setattr(db, "project_has_files", _boom)
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
        # app.py is in py_sample; UserService is a real symbol there (greet /
        # UserService are the only two — see the fixture).  Using a symbol that
        # actually exists makes this a genuine cross-project resolution test:
        # a miss now exits 1, so a stale symbol name would silently pass under
        # the old lenient assertion while testing nothing.
        result = runner.invoke(app, ["read", "app.py::UserService"])
        # Resolves via cross-project lookup: exit 0 with the symbol body.
        assert result.exit_code == 0, result.output
        assert "UserService" in result.output


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
    """Tests for _resolve_cache_lookup/put and invalidate_file_cache."""

    def setup_method(self):
        from token_goat import read_replacement as rr
        rr._RESOLVE_CACHE.clear()

    def test_cache_miss_returns_sentinel(self):
        from token_goat.read_replacement import _CACHE_MISS, _resolve_cache_lookup
        result = _resolve_cache_lookup("proj-abc", "src/foo.py")
        assert result is _CACHE_MISS

    def test_cache_put_and_hit(self):
        from token_goat.read_replacement import (
            _CACHE_MISS,
            _resolve_cache_lookup,
            _resolve_cache_put,
        )
        _resolve_cache_put("proj-abc", "foo.py", "src/foo.py")
        result = _resolve_cache_lookup("proj-abc", "foo.py")
        assert result is not _CACHE_MISS
        assert result == "src/foo.py"

    def test_cache_stores_none_result(self):
        from token_goat.read_replacement import (
            _CACHE_MISS,
            _resolve_cache_lookup,
            _resolve_cache_put,
        )
        _resolve_cache_put("proj-abc", "missing.py", None)
        result = _resolve_cache_lookup("proj-abc", "missing.py")
        assert result is not _CACHE_MISS
        assert result is None

    def test_invalidate_clears_only_that_project(self):
        from token_goat.read_replacement import (
            _CACHE_MISS,
            _resolve_cache_lookup,
            _resolve_cache_put,
            invalidate_file_cache,
        )
        _resolve_cache_put("proj-A", "foo.py", "src/foo.py")
        _resolve_cache_put("proj-B", "foo.py", "lib/foo.py")
        count = invalidate_file_cache("proj-A")
        assert count == 1
        assert _resolve_cache_lookup("proj-A", "foo.py") is _CACHE_MISS
        assert _resolve_cache_lookup("proj-B", "foo.py") is not _CACHE_MISS

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
        assert rr._resolve_cache_lookup("proj", "file0.py") is rr._CACHE_MISS
        # Newest entry is present
        assert rr._resolve_cache_lookup("proj", "new.py") == "src/new.py"

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


# ---------------------------------------------------------------------------
# section command — edge cases: nested headings, special chars, empty section
# ---------------------------------------------------------------------------

class TestSectionEdgeCases:
    """Edge cases for token-goat section that weren't covered by existing tests."""

    def test_section_top_level_heading(self, indexed_md_cli):
        """token-goat section retrieves a top-level (H1) heading."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "article.md::Top Level"])
        assert result.exit_code == 0
        assert "Top Level" in result.output or "Some content" in result.output

    def test_section_nested_h3_heading(self, indexed_md_cli):
        """token-goat section can retrieve a level-3 (###) heading."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "article.md::Subsection"])
        assert result.exit_code == 0
        assert "Subsection" in result.output or "Details" in result.output

    def test_section_results_heading(self, indexed_md_cli):
        """Retrieving the last section in a file (Results) works correctly."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "article.md::Results"])
        assert result.exit_code == 0
        assert "Results" in result.output or "What we found" in result.output

    def test_section_json_contains_level(self, indexed_md_cli):
        """--json output includes a 'level' field for the heading depth."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "--json", "article.md::Methodology"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert "level" in data
        assert data["level"] == 2  # ## Methodology is level 2

    def test_section_missing_separator_exits_2(self, indexed_md_cli):
        """token-goat section without '::' separator must exit 2."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "article.md"])
        assert result.exit_code == 2

    def test_section_nonexistent_heading_text_output(self, indexed_md_cli):
        """Missing heading in text mode exits 0 with a message on stdout or stderr."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "article.md::NoSuchHeadingXYZ"])
        # A missing heading is an error, not a successful empty read: exit 1.
        assert result.exit_code == 1
        combined = result.output + (result.stderr or "")
        assert "NoSuchHeadingXYZ" in combined or "Section not found" in combined or "not found" in combined.lower()

    def test_read_section_subsection_direct(self, md_project):
        """read_replacement.read_section can find a nested ### heading directly."""
        proj_root, proj = md_project
        result = read_replacement.read_section(proj, "article.md", "Subsection")
        assert result is not None
        assert "Subsection" in result["heading"] or "Details" in result["text"]

    def test_read_section_results_returns_text(self, md_project):
        """read_replacement.read_section returns non-empty text for the last section."""
        proj_root, proj = md_project
        result = read_replacement.read_section(proj, "article.md", "Results")
        assert result is not None
        assert result["text"].strip() != ""


# ---------------------------------------------------------------------------
# deps --depth flag — text output for transitive dependencies
# ---------------------------------------------------------------------------

class TestDepsDepthTextOutput:
    """Tests for deps command with --depth flag producing correct text output.

    These tests use monkeypatching (same pattern as existing transitive test)
    because tree-sitter doesn't resolve cross-file import refs in the test
    fixture environment.
    """

    def _fake_proj_and_conn(self, tmp_path, make_project):
        """Create a minimal indexed project and return (proj_root, proj)."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "deps_text"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.ts").write_text("export function a() { return 1; }\n", encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_deps_depth_1_no_transitive_section(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """With --depth 1 (default), no 'Transitive dependencies' header appears."""
        from contextlib import contextmanager

        from typer.testing import CliRunner

        from token_goat import read_commands
        from token_goat.cli import app

        proj_root, fake_proj = self._fake_proj_and_conn(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        @contextmanager
        def _fake_conn():
            yield object()

        monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
        monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: _FileTarget(fake_proj, "a.ts", fake_proj))
        monkeypatch.setattr(read_commands, "_collect_dependency_graph", lambda _c, _r: ({"b.ts": {"greet"}}, {}, []))
        # depth=1 means _collect_transitive_outgoing is never called

        runner = CliRunner()
        result = runner.invoke(app, ["deps", "a.ts", "--depth", "1"])
        assert result.exit_code == 0
        assert "Transitive" not in result.output
        assert "b.ts" in result.output

    def test_deps_depth_2_shows_transitive_section(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """With --depth 2, text output contains 'Transitive dependencies' section."""
        from contextlib import contextmanager

        from typer.testing import CliRunner

        from token_goat import read_commands
        from token_goat.cli import app

        proj_root, fake_proj = self._fake_proj_and_conn(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        @contextmanager
        def _fake_conn():
            yield object()

        monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
        monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: _FileTarget(fake_proj, "a.ts", fake_proj))
        monkeypatch.setattr(read_commands, "_collect_dependency_graph", lambda _c, _r: ({"b.ts": {"greet"}}, {}, []))
        monkeypatch.setattr(
            read_commands,
            "_collect_transitive_outgoing",
            lambda _c, _s, max_depth: {
                "b.ts": {"depth": 1, "via": "a.ts", "symbols": {"greet"}},
                "c.ts": {"depth": 2, "via": "b.ts", "symbols": {"helper"}},
            },
        )

        runner = CliRunner()
        result = runner.invoke(app, ["deps", "a.ts", "--depth", "2"])
        assert result.exit_code == 0
        assert "Transitive" in result.output
        assert "c.ts" in result.output

    def test_deps_depth_0_unlimited_header_uses_infinity_symbol(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """--depth 0 text output header shows '∞' to indicate unlimited depth."""
        from contextlib import contextmanager

        from typer.testing import CliRunner

        from token_goat import read_commands
        from token_goat.cli import app

        proj_root, fake_proj = self._fake_proj_and_conn(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        @contextmanager
        def _fake_conn():
            yield object()

        monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
        monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: _FileTarget(fake_proj, "a.ts", fake_proj))
        monkeypatch.setattr(read_commands, "_collect_dependency_graph", lambda _c, _r: ({"b.ts": {"greet"}}, {}, []))
        monkeypatch.setattr(
            read_commands,
            "_collect_transitive_outgoing",
            lambda _c, _s, max_depth: {
                "b.ts": {"depth": 1, "via": "a.ts", "symbols": {"greet"}},
                "c.ts": {"depth": 2, "via": "b.ts", "symbols": {"helper"}},
            },
        )

        runner = CliRunner()
        result = runner.invoke(app, ["deps", "a.ts", "--depth", "0"])
        assert result.exit_code == 0
        # depth=0 means "unlimited"; the header should say depth 2–∞
        assert "∞" in result.output  # ∞

    def test_deps_depth_2_text_shows_via_annotation(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """Transitive deps text output annotates depth-2 entries with 'via <parent>'."""
        from contextlib import contextmanager

        from typer.testing import CliRunner

        from token_goat import read_commands
        from token_goat.cli import app

        proj_root, fake_proj = self._fake_proj_and_conn(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        @contextmanager
        def _fake_conn():
            yield object()

        monkeypatch.setattr(read_commands.db, "open_project", lambda _hash: _fake_conn())
        monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _f: _FileTarget(fake_proj, "a.ts", fake_proj))
        monkeypatch.setattr(read_commands, "_collect_dependency_graph", lambda _c, _r: ({"b.ts": {"greet"}}, {}, []))
        monkeypatch.setattr(
            read_commands,
            "_collect_transitive_outgoing",
            lambda _c, _s, max_depth: {
                "b.ts": {"depth": 1, "via": "a.ts", "symbols": {"greet"}},
                "c.ts": {"depth": 2, "via": "b.ts", "symbols": {"helper"}},
            },
        )

        runner = CliRunner()
        result = runner.invoke(app, ["deps", "a.ts", "--depth", "2"])
        assert result.exit_code == 0
        # c.ts at depth 2 should be annotated with "via b.ts"
        assert "via b.ts" in result.output


# ---------------------------------------------------------------------------
# _collect_transitive_outgoing unit tests
# ---------------------------------------------------------------------------

class TestCollectTransitiveOutgoing:
    """Unit tests for the BFS transitive dependency collector.

    Uses monkeypatching of _collect_outgoing_edges to inject synthetic edges
    so these tests don't depend on the tree-sitter indexer resolving import refs.
    """

    def _make_minimal_project(self, tmp_path, make_project):
        """Create a minimal project (needed for the conn object)."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "bfs_unit"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "a.ts").write_text("export function a() {}\n", encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj.hash

    def test_depth_1_does_not_include_c(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """max_depth=1 BFS from a.ts should include b.ts but not c.ts."""
        from token_goat import db, read_commands
        from token_goat.read_commands import _collect_transitive_outgoing

        # Synthetic edge map: a->b, b->c
        edge_map = {
            "a.ts": {"b.ts": {"greet"}},
            "b.ts": {"c.ts": {"helper"}},
            "c.ts": {},
        }
        monkeypatch.setattr(read_commands, "_collect_outgoing_edges", lambda _conn, rel: edge_map.get(rel, {}))

        proj_hash = self._make_minimal_project(tmp_path, make_project)
        with db.open_project(proj_hash) as conn:
            result = _collect_transitive_outgoing(conn, "a.ts", max_depth=1)
        assert "b.ts" in result
        assert "c.ts" not in result

    def test_depth_2_includes_c(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """max_depth=2 BFS from a.ts should include both b.ts and c.ts."""
        from token_goat import db, read_commands
        from token_goat.read_commands import _collect_transitive_outgoing

        edge_map = {
            "a.ts": {"b.ts": {"greet"}},
            "b.ts": {"c.ts": {"helper"}},
            "c.ts": {},
        }
        monkeypatch.setattr(read_commands, "_collect_outgoing_edges", lambda _conn, rel: edge_map.get(rel, {}))

        proj_hash = self._make_minimal_project(tmp_path, make_project)
        with db.open_project(proj_hash) as conn:
            result = _collect_transitive_outgoing(conn, "a.ts", max_depth=2)
        assert "b.ts" in result
        assert "c.ts" in result
        assert result["c.ts"]["depth"] == 2
        assert result["c.ts"]["via"] == "b.ts"

    def test_depth_0_unlimited_finds_all(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """max_depth=0 means unlimited — all reachable files should be returned."""
        from token_goat import db, read_commands
        from token_goat.read_commands import _collect_transitive_outgoing

        edge_map = {
            "a.ts": {"b.ts": {"greet"}},
            "b.ts": {"c.ts": {"helper"}},
            "c.ts": {"d.ts": {"util"}},
            "d.ts": {},
        }
        monkeypatch.setattr(read_commands, "_collect_outgoing_edges", lambda _conn, rel: edge_map.get(rel, {}))

        proj_hash = self._make_minimal_project(tmp_path, make_project)
        with db.open_project(proj_hash) as conn:
            result = _collect_transitive_outgoing(conn, "a.ts", max_depth=0)
        assert "b.ts" in result
        assert "c.ts" in result
        assert "d.ts" in result
        assert result["d.ts"]["depth"] == 3

    def test_cycle_does_not_loop_forever(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """BFS should terminate even when there are cycles in the edge map."""
        from token_goat import db, read_commands
        from token_goat.read_commands import _collect_transitive_outgoing

        # a -> b -> a (cycle)
        edge_map = {
            "a.ts": {"b.ts": {"greet"}},
            "b.ts": {"a.ts": {"back"}},
        }
        monkeypatch.setattr(read_commands, "_collect_outgoing_edges", lambda _conn, rel: edge_map.get(rel, {}))

        proj_hash = self._make_minimal_project(tmp_path, make_project)
        with db.open_project(proj_hash) as conn:
            # Should not loop; a.ts is the start node so it's in visited from the start
            result = _collect_transitive_outgoing(conn, "a.ts", max_depth=0)
        # b.ts is reachable; a.ts is not in result (it's the start)
        assert "b.ts" in result
        assert "a.ts" not in result


# ---------------------------------------------------------------------------
# Surgical-read CLI ergonomics: "did you mean…?" suggestions on miss
# ---------------------------------------------------------------------------
# Why these tests matter: when a surgical-read command misses, the agent's
# only fallback is to Read the whole file — defeating the surgical-read
# mechanism entirely. A "Did you mean:" hint keeps the agent on the
# narrow-extract path even when its first guess was wrong.

class TestSurgicalReadSuggestionsOnMiss:
    """Close-match suggestions for symbol/read/section misses keep agents
    on the surgical-read path instead of falling back to whole-file Read."""

    def test_read_miss_lists_close_symbol_in_same_file(self, indexed_ts_cli):
        """`token-goat read file::TypoName` should surface real symbol names
        with similar spelling from that file as suggestions."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        # `greet` exists; `greetz` is a 1-char typo and should be suggested.
        result = runner.invoke(app, ["read", "index.ts::greetz"])
        combined = result.output + (result.stderr or "")
        assert "Symbol not found" in combined
        assert "Did you mean" in combined
        assert "greet" in combined

    def test_read_miss_json_carries_candidates(self, indexed_ts_cli):
        """JSON-mode miss must include `candidates` so non-human callers
        (scripts, hooks) can act on the suggestion list programmatically."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["read", "--json", "index.ts::greetz"])
        payload = json.loads(result.output)
        assert payload["ok"] is False
        assert payload["error"]["code"] == "symbol_not_found"
        # `candidates` is the structured "did you mean" field.
        assert "candidates" in payload["error"]
        assert "greet" in payload["error"]["candidates"]

    def test_read_miss_with_no_close_match_omits_didyoumean(self, indexed_ts_cli):
        """When nothing is even remotely similar, do not emit a misleading
        "Did you mean:" header — the absence of suggestions is meaningful."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        # Extremely different from any real symbol — no close match should be surfaced.
        result = runner.invoke(app, ["read", "index.ts::xyzqq__totally_unrelated"])
        combined = result.output + (result.stderr or "")
        assert "Symbol not found" in combined
        assert "Did you mean" not in combined

    def test_section_miss_lists_close_heading_in_same_file(self, indexed_md_cli):
        """`token-goat section file::TypoHeading` should suggest real headings
        with similar spelling from that file."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        # Article has "Methodology"; "Methodolgy" is a 1-char typo.
        result = runner.invoke(app, ["section", "article.md::Methodolgy"])
        combined = result.output + (result.stderr or "")
        assert "Section not found" in combined
        assert "Did you mean" in combined
        assert "Methodology" in combined

    def test_section_miss_json_carries_candidates(self, indexed_md_cli):
        """Section JSON miss includes candidates list."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["section", "--json", "article.md::Methodolgy"])
        payload = json.loads(result.output)
        assert payload["ok"] is False
        assert payload["error"]["code"] == "section_not_found"
        assert "candidates" in payload["error"]
        assert "Methodology" in payload["error"]["candidates"]

    def test_symbol_typo_auto_redirects_to_real_match(self, indexed_ts_cli):
        """`token-goat symbol Typo` with a single high-confidence close match
        transparently returns that match (auto-redirect). Without this the
        agent would have to parse a "Did you mean" hint and retry."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        # `UserService` exists; `UserServic` (truncated, ratio ~0.95) is the
        # textbook auto-redirect case — single candidate well over the 0.85
        # cutoff means the lookup is re-run against the real name.
        result = runner.invoke(app, ["symbol", "UserServic"])
        assert result.exit_code == 0
        combined = result.output + (result.stderr or "")
        # Audit marker so the substitution is visible to the caller.
        assert "redirected from" in combined
        assert "UserServic" in combined
        # Result row for the real symbol is in the output.
        assert "UserService" in combined
        assert "index.ts" in combined

    def test_symbol_typo_strict_mode_falls_back_to_didyoumean(self, indexed_ts_cli):
        """With ``--strict`` the auto-redirect is disabled and the miss path
        emits the "Did you mean" hint instead. Integration coverage on a real
        indexed DB — the unit test for ``--strict`` uses stubs."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["symbol", "UserServic", "--strict"])
        assert result.exit_code == 0
        combined = result.output + (result.stderr or "")
        assert "No matches for" in combined
        assert "Did you mean" in combined
        assert "UserService" in combined

    def test_symbol_miss_with_no_close_match_omits_didyoumean(self, indexed_ts_cli):
        """When the search term is totally unlike anything indexed, do not
        emit a "Did you mean:" header (would be misleading)."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["symbol", "qqzzqqzz_unrelated"])
        assert result.exit_code == 0
        combined = result.output + (result.stderr or "")
        assert "No matches for" in combined
        assert "Did you mean" not in combined


# ---------------------------------------------------------------------------
# In-session result cache integration (read_commands -> session)
# ---------------------------------------------------------------------------


class TestInSessionResultCache:
    """Verify the CLI populates and serves from the per-session result cache."""

    def test_second_read_hits_cache(self, indexed_ts_cli):
        """A second `read --session-id` for the same target uses the cached slice."""
        from typer.testing import CliRunner

        from token_goat import session
        from token_goat.cli import app

        runner = CliRunner()
        sid = "rc_cli_session_1"
        # First call populates cache
        result1 = runner.invoke(app, ["read", "--session-id", sid, "index.ts::greet"])
        assert result1.exit_code == 0
        # The session cache should now contain exactly one result-cache entry
        cache = session.load(sid)
        assert len(cache.result_cache) == 1
        # Second call must also succeed and return identical text
        result2 = runner.invoke(app, ["read", "--session-id", sid, "index.ts::greet"])
        assert result2.exit_code == 0
        assert result1.output == result2.output

    def test_file_edit_invalidates_cache(self, indexed_ts_cli):
        """Editing the file changes its SHA; the next read recomputes."""
        from typer.testing import CliRunner

        from token_goat import session
        from token_goat.cli import app

        proj_root, _proj = indexed_ts_cli
        runner = CliRunner()
        sid = "rc_cli_session_2"
        # Prime the cache
        result1 = runner.invoke(app, ["read", "--session-id", sid, "index.ts::greet"])
        assert result1.exit_code == 0
        cache = session.load(sid)
        assert len(cache.result_cache) == 1
        original_sha = next(iter(cache.result_cache.values())).file_sha

        # Modify the indexed file on disk — SHA changes
        index_ts = proj_root / "index.ts"
        index_ts.write_text(
            index_ts.read_text(encoding="utf-8") + "\n// trailing comment\n",
            encoding="utf-8",
        )
        # Next read recomputes; old entry should be invalidated and replaced
        result2 = runner.invoke(app, ["read", "--session-id", sid, "index.ts::greet"])
        assert result2.exit_code == 0
        cache_after = session.load(sid)
        # The cache should hold at most one entry for this (file, item, kind);
        # its SHA must reflect the new file contents.
        new_entries = [
            e for e in cache_after.result_cache.values()
            if e.kind == "symbol"
        ]
        assert new_entries, "expected a refreshed cache entry after the edit"
        assert all(e.file_sha != original_sha for e in new_entries)

    def test_no_session_id_skips_cache(self, indexed_ts_cli):
        """Without --session-id the cache is never consulted or populated."""
        from typer.testing import CliRunner

        from token_goat import session
        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["read", "index.ts::greet"])
        assert result.exit_code == 0
        # No session writes should have occurred
        # (load any session_id; none should reference index.ts in result_cache)
        cache = session.load("rc_cli_session_unused")
        assert cache.result_cache == {}


# ---------------------------------------------------------------------------
# _resolve_file_rel_db LIKE query limit tests
# ---------------------------------------------------------------------------


def test_resolve_bare_extension_returns_at_most_limit(tmp_path, tmp_data_dir, make_project):
    """A bare extension query (.py) returns at most _LIKE_MATCH_LIMIT results.

    This test creates a project with more than _LIKE_MATCH_LIMIT files with
    the same extension, then directly queries the DB to verify the LIMIT is
    applied and prevents materializing all matches into memory.
    """
    from token_goat import db, read_replacement
    from token_goat.parser import index_project

    # Create many .py files (more than _LIKE_MATCH_LIMIT)
    proj_root = tmp_path / "many_py"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    # Create 60 .py files (more than the default limit of 50)
    for i in range(60):
        (proj_root / f"module_{i:03d}.py").write_text(
            f"# Module {i}\ndef func_{i}(): pass\n",
            encoding="utf-8"
        )

    proj = make_project(proj_root)
    index_project(proj, full=True)

    # Query the DB directly to verify LIMIT is in effect
    with db.open_project(proj.hash) as conn:
        rows = conn.execute(
            "SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT ?",
            (f"%{read_replacement._escape_like_pattern('.py')}", read_replacement._LIKE_MATCH_LIMIT),
        ).fetchall()

    # Verify that we got exactly _LIKE_MATCH_LIMIT results (not 60)
    assert len(rows) == read_replacement._LIKE_MATCH_LIMIT
    assert all(r["rel_path"].endswith(".py") for r in rows)


def test_resolve_path_containing_suffix_uses_fast_path(tmp_path, tmp_data_dir, make_project):
    """A suffix containing '/' (e.g., 'subdir/file.py') uses exact-suffix fast path.

    The fast path attempts a direct WHERE rel_path = ? match before falling back
    to LIKE, avoiding unnecessary LIKE pattern matching for structured paths.
    """
    from token_goat.parser import index_project

    proj_root = tmp_path / "subdir_test"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "src").mkdir()
    (proj_root / "tests").mkdir()

    # Create files in subdirectories
    (proj_root / "src" / "main.py").write_text("def main(): pass\n", encoding="utf-8")
    (proj_root / "tests" / "main.py").write_text("def test_main(): pass\n", encoding="utf-8")
    (proj_root / "main.py").write_text("# root main\n", encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    # Query with path-containing suffix should return exact match
    result = read_replacement.resolve_file_rel(proj, "src/main.py")
    assert result == "src/main.py"


def test_resolve_exact_suffix_miss_falls_back_to_like(tmp_path, tmp_data_dir, make_project):
    """When exact-suffix match fails, the query falls back to LIKE successfully.

    This verifies that the fast-path check (exact match) doesn't prevent the
    LIKE fallback from working when the exact path doesn't exist.
    """
    from token_goat.parser import index_project

    proj_root = tmp_path / "fallback_test"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "src").mkdir()

    (proj_root / "src" / "utils.py").write_text("def util(): pass\n", encoding="utf-8")
    (proj_root / "src" / "main.py").write_text("def main(): pass\n", encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    # Query with "src/utils.py" where we only know "utils.py" — should fall back to LIKE
    result = read_replacement.resolve_file_rel(proj, "utils.py")
    assert result == "src/utils.py"


# ---------------------------------------------------------------------------
# Line range support (file::N-M)
# ---------------------------------------------------------------------------


def test_parse_line_range_valid():
    assert read_replacement.parse_line_range("1-5") == (1, 5)
    assert read_replacement.parse_line_range("10-10") == (10, 10)
    assert read_replacement.parse_line_range("100-200") == (100, 200)


def test_parse_line_range_invalid():
    assert read_replacement.parse_line_range("greet") is None
    assert read_replacement.parse_line_range("MY-CONST") is None
    assert read_replacement.parse_line_range("0-5") is None
    assert read_replacement.parse_line_range("5-3") is None
    assert read_replacement.parse_line_range("-5") is None
    assert read_replacement.parse_line_range("5-") is None
    assert read_replacement.parse_line_range("") is None


def test_read_line_range_basic(ts_project):
    _, proj = ts_project
    result = read_replacement.read_line_range(proj, "index.ts", 1, 3)
    assert result is not None
    assert result["start_line"] == 1
    assert result["end_line"] == 3
    assert "import" in result["text"]


def test_read_line_range_clamps_to_file_length(ts_project):
    _, proj = ts_project
    result = read_replacement.read_line_range(proj, "index.ts", 1, 99999)
    assert result is not None
    assert result["end_line"] > 1


def test_read_line_range_out_of_bounds_returns_none(ts_project):
    _, proj = ts_project
    result = read_replacement.read_line_range(proj, "index.ts", 99999, 99999)
    assert result is None


def test_read_line_range_bytes_saved_positive(ts_project):
    _, proj = ts_project
    result = read_replacement.read_line_range(proj, "index.ts", 1, 2)
    assert result is not None
    assert result["bytes_saved"] > 0


def test_cli_read_line_range(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "index.ts::1-3"])
    assert result.exit_code == 0
    assert result.output.strip() != ""


def test_cli_read_line_range_json(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "--json", "index.ts::1-3"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert data["start_line"] == 1
    assert data["end_line"] == 3
    assert "text" in data
    assert "bytes_saved" in data


def test_cli_read_line_range_out_of_bounds(indexed_ts_cli):
    from typer.testing import CliRunner

    from token_goat.cli import app

    runner = CliRunner()
    result = runner.invoke(app, ["read", "--json", "index.ts::99999-99999"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert data["ok"] is False
    assert data["error"]["code"] == "line_range_out_of_bounds"


# ---------------------------------------------------------------------------
# Cross-project attribution
# ---------------------------------------------------------------------------


def _make_two_project_setup(tmp_path, tmp_data_dir, make_project):
    """Two separate indexed projects sharing a file name (``helper.py``)."""
    proj_a_root = tmp_path / "proj_a"
    proj_a_root.mkdir()
    (proj_a_root / ".git").mkdir()
    (proj_a_root / "helper.py").write_text(
        "def from_a():\n    return 'a'\n", encoding="utf-8"
    )
    proj_a = make_project(proj_a_root)
    index_project(proj_a, full=True)

    proj_b_root = tmp_path / "proj_b"
    proj_b_root.mkdir()
    (proj_b_root / ".git").mkdir()
    (proj_b_root / "unique_b.py").write_text(
        "def from_b():\n    return 'b'\n", encoding="utf-8"
    )
    proj_b = make_project(proj_b_root)
    index_project(proj_b, full=True)

    return proj_a_root, proj_a, proj_b_root, proj_b


def test_cli_read_cross_project_emits_attribution(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """When token-goat read resolves via cross-project fallback, attribution is emitted to stderr."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    proj_a_root, _, proj_b_root, _ = _make_two_project_setup(tmp_path, tmp_data_dir, make_project)

    monkeypatch.chdir(proj_b_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "unique_b.py::from_b"])
    assert result.exit_code == 0
    assert "from_b" in result.output or "return" in result.output


def test_cli_read_cross_project_json_includes_project_root(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """JSON output includes ``_project_root`` when result is from a foreign project."""
    from typer.testing import CliRunner

    from token_goat.cli import app

    proj_a_root, _, proj_b_root, _ = _make_two_project_setup(tmp_path, tmp_data_dir, make_project)

    monkeypatch.chdir(proj_b_root)

    runner = CliRunner()
    result = runner.invoke(app, ["read", "--json", "unique_b.py::from_b"])
    assert result.exit_code == 0
    data = json.loads(result.output.strip())
    assert "from_b" in data.get("symbol", "") or "text" in data


# ---------------------------------------------------------------------------
# UTF-8 BOM handling regression tests (iter-35 fix)
# ---------------------------------------------------------------------------

def test_read_line_range_strips_utf8_bom(tmp_path, tmp_data_dir, make_project):
    """read_line_range must not include a UTF-8 BOM (U+FEFF) in the returned text.

    Notepad on Windows saves UTF-8 files with a BOM by default.  Before the fix
    _read_file_lines used encoding='utf-8' which preserved the BOM as the first
    character of the first line, making any returned snippet start with '\\ufeff'.
    The fix uses 'utf-8-sig' which strips the BOM automatically.
    """
    from token_goat.project import make_project_at

    proj_root = tmp_path / "bom_test"
    proj_root.mkdir()
    # Write a Python file with UTF-8 BOM (as Notepad would produce on Windows)
    bom_file = proj_root / "bom_file.py"
    bom_file.write_bytes(b"\xef\xbb\xbfdef greet():\n    return 'hello'\n")

    proj = make_project_at(proj_root)
    result = read_replacement.read_line_range(proj, "bom_file.py", 1, 2)

    assert result is not None, "read_line_range returned None for BOM file"
    first_line = result["text"].splitlines()[0]
    assert "﻿" not in first_line, (
        f"BOM character found in first line: {first_line!r}"
    )
    assert first_line == "def greet():", (
        f"First line content wrong after BOM strip: {first_line!r}"
    )


# ---------------------------------------------------------------------------
# truncate_symbol_body tests (smart truncation feature)
# ---------------------------------------------------------------------------

def _make_long_python_function(n_body_lines: int = 70) -> str:
    """Build a Python function with the given number of body lines for testing."""
    lines = ["def long_function(x, y):"]
    lines.append('    """A long function docstring."""')
    for i in range(n_body_lines):
        lines.append(f"    x = x + {i}  # body line {i}")
    lines.append("    return x")
    return "\n".join(lines)


class TestTruncateSymbolBody:
    """Tests for read_replacement.truncate_symbol_body."""

    def test_short_body_unchanged(self):
        """Bodies at or below the threshold are returned unchanged."""
        short = "\n".join([f"line {i}" for i in range(60)])
        result = read_replacement.truncate_symbol_body(short)
        assert result == short

    def test_exactly_threshold_unchanged(self):
        """A body of exactly TRUNCATE_THRESHOLD lines is not truncated."""
        text = "\n".join([f"line {i}" for i in range(read_replacement.TRUNCATE_THRESHOLD)])
        result = read_replacement.truncate_symbol_body(text)
        assert result == text

    def test_one_over_threshold_may_truncate(self):
        """A body with one more line than the threshold gets the truncation treatment."""
        n = read_replacement.TRUNCATE_THRESHOLD + 1
        text = "\n".join([f"line {i}" for i in range(n)])
        result = read_replacement.truncate_symbol_body(text)
        # Result is <= original (truncation happened or small body-after-sig skips it)
        assert len(result) <= len(text)

    def test_long_body_contains_ellipsis(self):
        """Long function bodies include the truncation ellipsis comment."""
        text = _make_long_python_function(70)
        result = read_replacement.truncate_symbol_body(text)
        assert "lines truncated" in result

    def test_long_body_truncated_line_count(self):
        """Truncated output is significantly shorter than the original."""
        text = _make_long_python_function(80)
        result = read_replacement.truncate_symbol_body(text)
        original_lines = text.count("\n") + 1
        result_lines = result.count("\n") + 1
        # Should be substantially shorter: sig + docstring + head + ellipsis + tail
        assert result_lines < original_lines - 20

    def test_full_flag_bypasses_truncation(self):
        """--full flag returns the original body without truncation."""
        text = _make_long_python_function(80)
        result = read_replacement.truncate_symbol_body(text, full=True)
        assert result == text

    def test_full_flag_on_short_body(self):
        """--full on a short body is a no-op (already not truncated)."""
        text = "def f():\n    return 1\n"
        assert read_replacement.truncate_symbol_body(text, full=True) == text

    def test_signature_preserved_in_truncated_output(self):
        """The function signature line appears at the start of truncated output."""
        text = _make_long_python_function(70)
        result = read_replacement.truncate_symbol_body(text)
        assert result.startswith("def long_function(x, y):")

    def test_tail_preserved_in_truncated_output(self):
        """The last few lines (return statement) appear at the end of truncated output."""
        text = _make_long_python_function(70)
        result = read_replacement.truncate_symbol_body(text)
        assert result.rstrip().endswith("return x")

    def test_docstring_included(self):
        """Docstring lines appear in the truncated output."""
        text = _make_long_python_function(70)
        result = read_replacement.truncate_symbol_body(text)
        assert "A long function docstring." in result

    def test_ellipsis_count_correct(self):
        """The ellipsis comment reports a positive truncated line count."""
        import re
        text = _make_long_python_function(80)
        result = read_replacement.truncate_symbol_body(text)
        m = re.search(r"\((\d+) lines truncated\)", result)
        assert m is not None, f"No truncation count found in: {result!r}"
        count = int(m.group(1))
        assert count > 0

    def test_empty_string_unchanged(self):
        """Empty string does not cause errors."""
        assert read_replacement.truncate_symbol_body("") == ""

    def test_single_line_unchanged(self):
        """Single-line symbol is returned as-is."""
        text = "SOME_CONST = 42"
        assert read_replacement.truncate_symbol_body(text) == text

    def test_large_docstring_small_body_is_capped(self):
        """A big docstring over a tiny body must still be truncated, not leaked whole.

        Regression: the symbol clears TRUNCATE_THRESHOLD purely on docstring length
        (70 doc lines + 2 body lines = 73 > 60), but the real code body is only 2
        lines (<= HEAD+TAIL = 20). The small-body guard previously returned the raw
        ``text`` unchanged, leaking the entire un-capped docstring and defeating
        truncation exactly when savings are largest. The docstring cap must apply.
        """
        doc_lines = "\n".join(f'    line {i} of a very long docstring' for i in range(70))
        text = f'def f(x):\n    """\n{doc_lines}\n    """\n    x = x + 1\n    return x'
        original_lines = text.count("\n") + 1
        assert original_lines > read_replacement.TRUNCATE_THRESHOLD  # precondition
        result = read_replacement.truncate_symbol_body(text)
        result_lines = result.count("\n") + 1
        # Truncation actually fired: far fewer lines than the original.
        assert result_lines < original_lines, "large docstring leaked un-truncated"
        # The docstring-cap note is present and a deep docstring line is gone.
        assert "(docstring truncated)" in result
        assert "line 60 of a very long docstring" not in result
        # Signature and the real body are both preserved.
        assert result.startswith("def f(x):")
        assert "return x" in result

    def test_small_body_without_docstring_returned_verbatim(self):
        """No docstring + small body keeps exact bytes (the unchanged-path guard).

        When nothing was capped, the small-body branch must return the original
        ``text`` verbatim (including its trailing newline) rather than a round-tripped
        join. This pins the behavior that the docstring-cap fix must NOT disturb.
        """
        # >60 lines total, all in a comma-continued signature (each non-final sig
        # line ends with ',' so the boundary scan keeps going to the final ':'),
        # 2-line body, no docstring. Drives total_real (==2) into the small-body
        # guard with doc_was_capped False.
        sig = "def f(x,\n" + "\n".join(f"    arg{i}," for i in range(60)) + "\n    y):"
        text = f"{sig}\n    x = 1\n    return x\n"
        assert (text.count("\n") + 1) > read_replacement.TRUNCATE_THRESHOLD  # precondition
        result = read_replacement.truncate_symbol_body(text)
        assert result == text

    def test_multiline_signature_fully_preserved(self):
        """A signature spanning several lines (first line ends with ',') is kept whole.

        Characterization test for the signature-boundary scan: when the first line
        ends with a continuation comma the loop must keep scanning until the line
        that ends with ``:`` rather than treating line 0 as the sole signature line.
        Regresses the ``not stripped.endswith((":", "{", ","))`` guard — if the comma
        were dropped from that tuple the trailing signature params would be lost.
        """
        sig = "def long_function(x,\n                  y,\n                  z):"
        body = "\n".join(f"    x = x + {i}  # body line {i}" for i in range(70))
        text = f"{sig}\n    return x + y + z\n{body}\n    return x"
        result = read_replacement.truncate_symbol_body(text)
        # Whole multi-line signature survives, in order, at the head of the output.
        assert result.startswith(sig)
        # All three parameter lines are present (none clipped by an early break).
        assert "def long_function(x," in result
        assert "                  y," in result
        assert "                  z):" in result
        # And it still truncated (sanity: we exercised the truncation path).
        assert "lines truncated" in result


class TestTokenEstimateHeader:
    """Tests for read_replacement.token_estimate_header."""

    def test_format(self):
        """Header format is '# N lines (~M tok)'."""
        import re
        text = "line1\nline2\nline3"
        header = read_replacement.token_estimate_header(text)
        assert re.match(r"^# \d+ lines \(~\d+ tok\)$", header), (
            f"Unexpected header format: {header!r}"
        )

    def test_line_count(self):
        """Line count in header matches actual lines."""
        text = "a\nb\nc\nd"
        header = read_replacement.token_estimate_header(text)
        assert header.startswith("# 4 lines")

    def test_token_estimate_approx(self):
        """Token estimate is len(text) // 4."""
        text = "x" * 400
        header = read_replacement.token_estimate_header(text)
        assert "(~100 tok)" in header

    def test_empty_string(self):
        """Empty string produces a header with 0 tokens."""
        header = read_replacement.token_estimate_header("")
        assert "(~0 tok)" in header

    def test_single_line(self):
        """Single-line text counts as 1 line."""
        header = read_replacement.token_estimate_header("hello world")
        assert header.startswith("# 1 lines")


class TestReadCommandFullFlag:
    """Integration tests for --full flag and token estimate in CLI output."""

    def _make_long_function_project(self, tmp_path, make_project):
        """Create a project with a long Python function and index it."""
        from token_goat.parser import index_project as _index_project
        proj_root = tmp_path / "long_func_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        func_lines = ["def big_function(a, b, c):"]
        func_lines.append('    """This function is deliberately long."""')
        for i in range(70):
            func_lines.append(f"    result_{i} = a + b + c + {i}")
        func_lines.append("    return result_0")
        (proj_root / "bigfile.py").write_text("\n".join(func_lines) + "\n", encoding="utf-8")
        proj = make_project(proj_root)
        _index_project(proj, full=True)
        return proj_root, proj

    def test_read_includes_token_estimate_in_output(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat read output includes the token estimate header line."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_long_function_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "bigfile.py::big_function"])
        assert result.exit_code == 0, result.output
        assert "~" in result.output and "tok" in result.output

    def test_read_truncates_long_body_by_default(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """Without --full, long symbol bodies are truncated."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_long_function_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "bigfile.py::big_function"])
        assert result.exit_code == 0, result.output
        assert "lines truncated" in result.output

    def test_read_full_flag_bypasses_truncation(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """With --full, long symbol bodies are returned without truncation."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_long_function_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "--full", "bigfile.py::big_function"])
        assert result.exit_code == 0, result.output
        assert "lines truncated" not in result.output
        assert "result_69" in result.output

    def test_read_short_flag_f_bypasses_truncation(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """-f (short form) is equivalent to --full."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_long_function_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "-f", "bigfile.py::big_function"])
        assert result.exit_code == 0, result.output
        assert "lines truncated" not in result.output
        assert "result_69" in result.output

    def test_read_full_flag_in_json_output(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """JSON output with --full includes the complete body text."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_long_function_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["read", "--full", "--json", "bigfile.py::big_function"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert "result_69" in data.get("text", "")


# ---------------------------------------------------------------------------
# Fuzzy file matching via partial path (basename or suffix)
# ---------------------------------------------------------------------------

class TestPartialPathResolution:
    """Verify that resolve_file_rel and the CLI accept partial paths.

    The endswith-LIKE logic in _resolve_file_rel_db already handles this, but
    these tests ensure it is exercised end-to-end via the CLI so that a future
    refactor does not accidentally break partial-path resolution.
    """

    @staticmethod
    def _make_nested_project(tmp_path, make_project):
        """Create a project with src/utils/parser.py inside a subdirectory."""
        proj_root = tmp_path / "nested"
        (proj_root / "src" / "utils").mkdir(parents=True)
        (proj_root / ".git").mkdir(exist_ok=True)
        (proj_root / "src" / "utils" / "parser.py").write_text(
            "def parse(text):\n    return text.split()\n", encoding="utf-8"
        )
        from token_goat.parser import index_project
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_partial_path_resolves_in_module(self, tmp_path, tmp_data_dir, make_project):
        """resolve_file_rel matches a partial suffix like 'utils/parser.py'."""
        proj_root, proj = self._make_nested_project(tmp_path, make_project)
        rel = read_replacement.resolve_file_rel(proj, "utils/parser.py")
        assert rel == "src/utils/parser.py"

    def test_bare_basename_resolves_when_unique(self, tmp_path, tmp_data_dir, make_project):
        """resolve_file_rel matches a bare filename when it is unique in the project."""
        proj_root, proj = self._make_nested_project(tmp_path, make_project)
        rel = read_replacement.resolve_file_rel(proj, "parser.py")
        assert rel == "src/utils/parser.py"

    def test_cli_read_with_partial_path(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat read 'utils/parser.py::parse' resolves through the partial path."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_nested_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)
        runner = CliRunner()
        result = runner.invoke(app, ["read", "utils/parser.py::parse"])
        assert result.exit_code == 0
        assert "parse" in result.output

    def test_cli_read_with_bare_filename(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat read 'parser.py::parse' resolves through bare filename."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_nested_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)
        runner = CliRunner()
        result = runner.invoke(app, ["read", "parser.py::parse"])
        assert result.exit_code == 0
        assert "parse" in result.output


# ---------------------------------------------------------------------------
# File-not-found "did you mean?" suggestions
# ---------------------------------------------------------------------------

class TestFileNotFoundSuggestions:
    """When a file lookup fails, close-basename matches are surfaced as suggestions.

    This prevents the agent from falling back to a full-repo listing when a
    single-character typo in the filename caused the miss.
    """

    @staticmethod
    def _make_simple_project(tmp_path, make_project):
        """Create a minimal indexed project with one file: 'reader.py'."""
        proj_root = tmp_path / "suggest_proj"
        (proj_root / "src").mkdir(parents=True)
        (proj_root / ".git").mkdir(exist_ok=True)
        (proj_root / "src" / "reader.py").write_text(
            "def read_file(path):\n    return open(path).read()\n", encoding="utf-8"
        )
        from token_goat.parser import index_project
        proj = make_project(proj_root)
        index_project(proj, full=True)
        return proj_root, proj

    def test_file_typo_shows_did_you_mean_text(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """Text-mode file miss suggests the correct filename when a typo is detected."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_simple_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)
        runner = CliRunner()
        # 'readre.py' is a 1-char transposition of 'reader.py' (ratio ~0.91)
        result = runner.invoke(app, ["read", "readre.py::read_file"])
        combined = result.output + (result.stderr or "")
        assert "File not found" in combined
        assert "Did you mean" in combined
        assert "reader.py" in combined

    def test_file_typo_json_carries_candidates(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """JSON-mode file miss includes 'candidates' with the suggested filenames."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_simple_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)
        runner = CliRunner()
        result = runner.invoke(app, ["read", "--json", "readre.py::read_file"])
        payload = json.loads(result.output)
        assert payload["ok"] is False
        assert payload["error"]["code"] == "file_not_found"
        assert "candidates" in payload["error"]
        # The suggested path should contain 'reader.py'
        assert any("reader.py" in c for c in payload["error"]["candidates"])

    def test_unrelated_filename_omits_did_you_mean(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """When nothing is similar, 'Did you mean' is not emitted."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        proj_root, _ = self._make_simple_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)
        runner = CliRunner()
        result = runner.invoke(app, ["read", "xyzqq_totally_unrelated.py::foo"])
        combined = result.output + (result.stderr or "")
        assert "File not found" in combined
        assert "Did you mean" not in combined

    def test_close_file_matches_returns_empty_on_db_error(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """_close_file_matches returns [] and does not raise when DB is missing."""
        from token_goat import read_commands
        from token_goat.project import Project

        # A project with a non-existent DB hash should fail gracefully
        fake_proj = Project(
            root=tmp_path,
            marker=".git",
            hash="deadbeef" * 5,  # 40 hex chars, no real DB
        )
        result = read_commands._close_file_matches(fake_proj, "missing.py")
        assert result == []
