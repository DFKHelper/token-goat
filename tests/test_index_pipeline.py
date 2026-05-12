"""Tests for the full index pipeline (index_project + DB writes)."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from cc_saver import db
from cc_saver.parser import index_file, index_project, write_file_index
from cc_saver.project import Project, canonicalize, project_hash

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"
PY_SAMPLE = FIXTURE_DIR / "py_sample"


def _make_project(root: Path) -> Project:
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


@pytest.fixture
def ts_project(tmp_path, tmp_data_dir):
    """Copy ts_sample fixture to tmp dir and return a Project."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    return _make_project(proj_root)


@pytest.fixture
def py_project(tmp_path, tmp_data_dir):
    """Copy py_sample fixture to tmp dir and return a Project."""
    proj_root = tmp_path / "py_sample"
    shutil.copytree(PY_SAMPLE, proj_root)
    return _make_project(proj_root)


# ---------------------------------------------------------------------------
# Full indexing
# ---------------------------------------------------------------------------

def test_full_index_ts_runs(ts_project):
    summary = index_project(ts_project, full=True)
    assert summary["total_files"] >= 1
    assert summary["indexed"] >= 1
    assert summary["errors"] == 0
    assert "typescript" in summary["languages"]


def test_full_index_ts_populates_files_table(ts_project):
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        count = conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]
    assert count >= 1


def test_full_index_ts_populates_symbols_table(ts_project):
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        count = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        names = {r["name"] for r in conn.execute("SELECT name FROM symbols")}
    assert count >= 4  # greet, UserService, hello, User, UserId
    assert "greet" in names
    assert "UserService" in names


def test_full_index_ts_populates_refs_table(ts_project):
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        count = conn.execute("SELECT COUNT(*) FROM refs").fetchone()[0]
        ref_names = {r["symbol_name"] for r in conn.execute("SELECT symbol_name FROM refs")}
    assert count >= 1
    assert "greet" in ref_names


def test_full_index_ts_populates_imports_exports(ts_project):
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        imports = conn.execute(
            "SELECT COUNT(*) FROM imports_exports WHERE kind='import'"
        ).fetchone()[0]
        exports = conn.execute(
            "SELECT COUNT(*) FROM imports_exports WHERE kind='export'"
        ).fetchone()[0]
    assert imports >= 2  # node:path, express
    assert exports >= 1


def test_full_index_py_runs(py_project):
    summary = index_project(py_project, full=True)
    assert summary["indexed"] >= 1
    assert "python" in summary["languages"]


def test_full_index_py_populates_symbols(py_project):
    index_project(py_project, full=True)
    with db.open_project(py_project.hash) as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM symbols")}
    assert "greet" in names
    assert "UserService" in names
    assert "__init__" in names


# ---------------------------------------------------------------------------
# Global registry updated
# ---------------------------------------------------------------------------

def test_full_index_updates_global_projects(ts_project):
    index_project(ts_project, full=True)
    with db.open_global() as gconn:
        row = gconn.execute(
            "SELECT * FROM projects WHERE hash=?", (ts_project.hash,)
        ).fetchone()
    assert row is not None
    assert row["root"] == ts_project.root.as_posix()


def test_full_index_updates_global_symbols(ts_project):
    index_project(ts_project, full=True)
    with db.open_global() as gconn:
        count = gconn.execute(
            "SELECT COUNT(*) FROM symbols_global WHERE project_hash=?", (ts_project.hash,)
        ).fetchone()[0]
    assert count >= 4


# ---------------------------------------------------------------------------
# Incremental indexing
# ---------------------------------------------------------------------------

def test_incremental_skips_unchanged_files(ts_project):
    index_project(ts_project, full=True)
    summary2 = index_project(ts_project, full=False)
    assert summary2["skipped_unchanged"] > 0
    assert summary2["indexed"] == 0


def test_incremental_reindexes_modified_file(ts_project):
    index_project(ts_project, full=True)
    # Modify index.ts
    ts_file = ts_project.root / "index.ts"
    original = ts_file.read_bytes()
    ts_file.write_bytes(original + b"\nexport function extra() {}\n")
    summary2 = index_project(ts_project, full=False)
    assert summary2["indexed"] >= 1


def test_incremental_replaces_symbols_for_modified_file(ts_project):
    index_project(ts_project, full=True)
    # Verify "extra" doesn't exist yet
    with db.open_project(ts_project.hash) as conn:
        count_before = conn.execute(
            "SELECT COUNT(*) FROM symbols WHERE name='extra'"
        ).fetchone()[0]
    assert count_before == 0

    # Add "extra" function and re-index
    ts_file = ts_project.root / "index.ts"
    ts_file.write_bytes(ts_file.read_bytes() + b"\nexport function extra() {}\n")
    index_project(ts_project, full=False)

    with db.open_project(ts_project.hash) as conn:
        count_after = conn.execute(
            "SELECT COUNT(*) FROM symbols WHERE name='extra'"
        ).fetchone()[0]
    assert count_after >= 1


# ---------------------------------------------------------------------------
# write_file_index replaces stale rows
# ---------------------------------------------------------------------------

def test_write_file_index_replaces_old_symbols(ts_project):
    """write_file_index on same rel_path should DELETE old symbols first."""
    index_project(ts_project, full=True)

    with db.open_project(ts_project.hash) as conn:
        count_before = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        assert count_before > 0

    # Call index_file + write_file_index again — should not double-count
    fp = ts_project.root / "index.ts"
    fi = index_file(ts_project, fp)
    assert fi is not None
    with db.open_project(ts_project.hash) as conn:
        write_file_index(conn, fi)
        count_after = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]

    assert count_after == count_before  # same count, not doubled


# ---------------------------------------------------------------------------
# Summary dict structure
# ---------------------------------------------------------------------------

def test_summary_has_required_keys(ts_project):
    summary = index_project(ts_project, full=True)
    required = {"total_files", "indexed", "skipped_unchanged", "errors", "languages", "duration_sec"}
    assert required.issubset(summary.keys())


def test_summary_duration_is_positive(ts_project):
    summary = index_project(ts_project, full=True)
    assert summary["duration_sec"] > 0
