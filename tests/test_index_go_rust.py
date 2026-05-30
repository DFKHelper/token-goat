"""Integration tests for Go and Rust index pipeline."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from token_goat import db
from token_goat.parser import index_project

FIXTURE_DIR = Path(__file__).parent / "fixtures"
GO_SAMPLE = FIXTURE_DIR / "go_sample"
RUST_SAMPLE = FIXTURE_DIR / "rust_sample"


@pytest.fixture
def go_project(tmp_path, tmp_data_dir, make_project):
    proj_root = tmp_path / "go_sample"
    shutil.copytree(GO_SAMPLE, proj_root)
    return make_project(proj_root)


@pytest.fixture
def rust_project(tmp_path, tmp_data_dir, make_project):
    proj_root = tmp_path / "rust_sample"
    shutil.copytree(RUST_SAMPLE, proj_root)
    return make_project(proj_root)


# ---------------------------------------------------------------------------
# Go project indexing
# ---------------------------------------------------------------------------


def test_go_index_runs(go_project):
    summary = index_project(go_project, full=True)
    assert summary["total_files"] >= 1
    assert summary["indexed"] >= 1
    assert summary["errors"] == 0
    assert "go" in summary["languages"]


def test_go_index_populates_symbols(go_project):
    index_project(go_project, full=True)
    with db.open_project(go_project.hash) as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM symbols")}
    assert "main" in names
    assert "NewServer" in names
    assert "Server" in names


def test_go_index_populates_imports(go_project):
    index_project(go_project, full=True)
    with db.open_project(go_project.hash) as conn:
        targets = {
            r["target"]
            for r in conn.execute("SELECT target FROM imports_exports WHERE kind='import'")
        }
    assert "fmt" in targets
    assert "errors" in targets


def test_go_index_symbol_kinds(go_project):
    index_project(go_project, full=True)
    with db.open_project(go_project.hash) as conn:
        rows = conn.execute("SELECT name, kind FROM symbols").fetchall()
    kind_by_name = {r["name"]: r["kind"] for r in rows}
    assert kind_by_name.get("Server") == "type"
    assert kind_by_name.get("Handler") == "interface"
    assert kind_by_name.get("Version") == "const"
    assert kind_by_name.get("defaultPort") == "var"
    assert kind_by_name.get("NewServer") == "function"
    assert kind_by_name.get("Run") == "method"


def test_go_index_updates_global_registry(go_project):
    index_project(go_project, full=True)
    with db.open_global() as gconn:
        row = gconn.execute(
            "SELECT * FROM projects WHERE hash=?", (go_project.hash,)
        ).fetchone()
    assert row is not None
    assert "go" in row["languages"]


# ---------------------------------------------------------------------------
# Rust project indexing
# ---------------------------------------------------------------------------


def test_rust_index_runs(rust_project):
    summary = index_project(rust_project, full=True)
    assert summary["total_files"] >= 1
    assert summary["indexed"] >= 1
    assert summary["errors"] == 0
    assert "rust" in summary["languages"]


def test_rust_index_populates_symbols(rust_project):
    index_project(rust_project, full=True)
    with db.open_project(rust_project.hash) as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM symbols")}
    assert "main" in names
    assert "Server" in names
    assert "new" in names
    assert "run" in names


def test_rust_index_populates_imports(rust_project):
    index_project(rust_project, full=True)
    with db.open_project(rust_project.hash) as conn:
        targets = {
            r["target"]
            for r in conn.execute("SELECT target FROM imports_exports WHERE kind='import'")
        }
    assert any("HashMap" in t for t in targets)
    assert any("fmt" in t for t in targets)


def test_rust_index_symbol_kinds(rust_project):
    index_project(rust_project, full=True)
    with db.open_project(rust_project.hash) as conn:
        rows = conn.execute("SELECT name, kind FROM symbols").fetchall()
    kind_by_name: dict[str, list[str]] = {}
    for r in rows:
        kind_by_name.setdefault(r["name"], []).append(r["kind"])

    assert "type" in kind_by_name.get("Server", [])
    assert "interface" in kind_by_name.get("Handler", [])
    assert "enum" in kind_by_name.get("Error", [])
    assert "const" in kind_by_name.get("VERSION", [])
    assert "method" in kind_by_name.get("new", [])
    assert "method" in kind_by_name.get("run", [])


def test_rust_index_updates_global_registry(rust_project):
    index_project(rust_project, full=True)
    with db.open_global() as gconn:
        row = gconn.execute(
            "SELECT * FROM projects WHERE hash=?", (rust_project.hash,)
        ).fetchone()
    assert row is not None
    assert "rust" in row["languages"]


def test_rust_index_trait_methods(rust_project):
    index_project(rust_project, full=True)
    with db.open_project(rust_project.hash) as conn:
        rows = conn.execute("SELECT name, kind FROM symbols WHERE name='serve'").fetchall()
    assert rows, "trait method 'serve' should be indexed"
    assert any(r["kind"] == "method" for r in rows)


def test_rust_index_static(rust_project):
    index_project(rust_project, full=True)
    with db.open_project(rust_project.hash) as conn:
        rows = conn.execute("SELECT name, kind FROM symbols WHERE name='MAX_CONNECTIONS'").fetchall()
    assert rows, "static MAX_CONNECTIONS should be indexed"
    assert rows[0]["kind"] == "const"
