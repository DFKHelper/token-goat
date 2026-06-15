"""Tests for the optional FILE positional that scopes ``token-goat symbol``.

``token-goat symbol NAME FILE`` restricts matches to symbols whose ``rel_path``
contains FILE (case-insensitive partial match), so an agent can disambiguate a
symbol name defined in more than one file without guessing which result is the
relevant one.
"""
from __future__ import annotations

import json as _json
import sqlite3

from typer.testing import CliRunner

from token_goat import cli, read_commands


class _FakeProject:
    """Stand-in for ``token_goat.project.Project`` for the CLI tests below."""

    hash = "0" * 64
    root = "/fake/root"
    marker = ".git"


def _rows_in(*file_rels: str) -> list[dict]:
    """Build fake ``_query_project`` rows for ``MyClass`` across the given files."""
    return [
        {"name": "MyClass", "kind": "class", "file_rel": rel, "line": 10, "signature": ""}
        for rel in file_rels
    ]


def _install_query(monkeypatch, rows: list[dict]) -> None:
    """Run the CLI's symbol SQL against an in-memory ``symbols`` table.

    The previous mock returned the canned *rows* verbatim and never honored the
    SQL ``WHERE``/``LIMIT``, which masked the file-scope-after-``LIMIT`` bug. By
    executing the actual query string ``_project_query`` builds against a throwaway
    SQLite table, the filter-then-limit ordering is exercised for real while these
    tests stay fast (no tree-sitter, no disk).
    """
    monkeypatch.setattr(cli, "_require_project", lambda: _FakeProject())
    monkeypatch.setattr(cli, "_project_symbol_pool", lambda h: ["MyClass"])
    monkeypatch.setattr(read_commands, "_not_indexed_hint", lambda h: None)

    def _fake_query(_hash, sql, params):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            "CREATE TABLE symbols "
            "(name TEXT, kind TEXT, file_rel TEXT, line INTEGER, end_line INTEGER, signature TEXT)"
        )
        conn.executemany(
            "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature) "
            "VALUES (:name, :kind, :file_rel, :line, :end_line, :signature)",
            [{"end_line": None, **r} for r in rows],
        )
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    monkeypatch.setattr(cli, "_query_project", _fake_query)


def test_symbol_with_file_scope_filters_to_file(tmp_data_dir, monkeypatch):
    """Two files define ``MyClass``; scoping to file A returns only A's result."""
    _install_query(monkeypatch, _rows_in("src/auth/service.py", "src/admin/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass", "auth/service.py"])

    assert result.exit_code == 0
    assert "src/auth/service.py" in result.stdout
    assert "src/admin/service.py" not in result.stdout


def test_symbol_with_file_scope_partial_path_match(tmp_data_dir, monkeypatch):
    """A partial path ``auth/service.py`` matches the indexed ``src/auth/service.py``."""
    _install_query(monkeypatch, _rows_in("src/auth/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass", "auth/service.py"])

    assert result.exit_code == 0
    assert "src/auth/service.py" in result.stdout


def test_symbol_with_file_scope_no_match(tmp_data_dir, monkeypatch):
    """A FILE scope that matches no result exits 1 with an informative message."""
    _install_query(monkeypatch, _rows_in("src/admin/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass", "billing/service.py"])

    assert result.exit_code == 1
    assert "MyClass" in result.stdout
    assert "billing/service.py" in result.stdout
    # The cross-file close-match suggestion must be suppressed under a file scope.
    assert "Did you mean" not in result.stdout


def test_symbol_without_file_scope_searches_all(tmp_data_dir, monkeypatch):
    """Regression: with no FILE arg, every matching file is returned as before."""
    _install_query(monkeypatch, _rows_in("src/auth/service.py", "src/admin/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass"])

    assert result.exit_code == 0
    assert "src/auth/service.py" in result.stdout
    assert "src/admin/service.py" in result.stdout


def test_symbol_file_scope_json_output(tmp_data_dir, monkeypatch):
    """``--json`` keeps working under a FILE scope: only the matching file is emitted."""
    _install_query(monkeypatch, _rows_in("src/auth/service.py", "src/admin/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass", "auth/service.py", "--json"])

    assert result.exit_code == 0
    payload = _json.loads(result.stdout)
    assert payload["total"] == 1
    assert payload["results"][0]["file"] == "src/auth/service.py"


def test_symbol_file_scope_json_no_match_exits_one(tmp_data_dir, monkeypatch):
    """A no-match FILE scope still emits a valid JSON envelope, then exits 1."""
    _install_query(monkeypatch, _rows_in("src/admin/service.py"))

    result = CliRunner().invoke(cli.app, ["symbol", "MyClass", "billing/service.py", "--json"])

    assert result.exit_code == 1
    payload = _json.loads(result.stdout)
    assert payload["total"] == 0
    assert payload["results"] == []


def test_symbol_file_scope_sql_not_limit_truncated(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Regression: the file scope is pushed into SQL so it applies BEFORE ``LIMIT``.

    Three real files each define ``class Widget``. Scoping to ``file_b.py`` with
    ``--limit 1`` must still return ``file_b.py``. Before the fix, the Python
    filter ran AFTER ``LIMIT 1`` had already truncated the result set to an
    arbitrary single file (``file_a.py`` by rowid), so the target was dropped and
    the command falsely reported "No symbol found". This exercises the genuine
    indexed-DB query path, not a mock.
    """
    from token_goat.parser import index_project  # noqa: PLC0415

    proj_root = tmp_path / "widgets"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    for fname in ("file_a.py", "file_b.py", "file_c.py"):
        (proj_root / fname).write_text("class Widget:\n    pass\n", encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    monkeypatch.chdir(proj_root)
    monkeypatch.setattr(cli, "_require_project", lambda *a, **k: proj)

    result = CliRunner().invoke(cli.app, ["symbol", "Widget", "file_b.py", "--limit", "1"])

    assert result.exit_code == 0, result.stdout
    assert "file_b.py" in result.stdout
    assert "file_a.py" not in result.stdout
    assert "file_c.py" not in result.stdout
