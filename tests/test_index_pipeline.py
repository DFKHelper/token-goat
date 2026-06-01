"""Tests for the full index pipeline (index_project + DB writes)."""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from unittest.mock import patch

from token_goat import db
from token_goat.parser import index_file, index_project, write_file_index

FIXTURE_DIR = Path(__file__).parent / "fixtures"

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


def test_index_registers_project_before_file_walk(ts_project, monkeypatch):
    """The project must land in the global `projects` table BEFORE the file walk.

    Registration used to happen only after the full walk+index completed. For a
    large (or hang-prone) tree that window is minutes long, and the worker's
    dirty-queue drain hits "unknown project hash" for every edit made meanwhile
    — silently dropping it. Registering up front closes that window.
    """
    from token_goat import parser

    real_iter = parser.iter_source_files
    registered_during_walk: dict[str, bool] = {}

    def spy_iter(project, **kwargs):
        with db.open_global() as gconn:
            row = gconn.execute(
                "SELECT 1 FROM projects WHERE hash=?", (project.hash,)
            ).fetchone()
        registered_during_walk["seen"] = row is not None
        return real_iter(project, **kwargs)

    monkeypatch.setattr(parser, "iter_source_files", spy_iter)
    index_project(ts_project, full=True)

    assert registered_during_walk["seen"], (
        "project was not in global.db when the file walk started — mid-index "
        "dirty-queue entries would be dropped as 'unknown project hash'"
    )


def test_iter_source_files_prunes_ignored_directories(tmp_path):
    """The source walker should skip ignored trees without descending into them."""
    from token_goat import parser
    from token_goat.project import make_project_at

    proj_root = tmp_path / "walk_root"
    proj_root.mkdir()
    (proj_root / "src").mkdir()
    (proj_root / "node_modules" / "pkg").mkdir(parents=True)

    keep = proj_root / "src" / "keep.py"
    keep.write_text("print('keep')\n", encoding="utf-8")
    skip = proj_root / "node_modules" / "pkg" / "skip.py"
    skip.write_text("print('skip')\n", encoding="utf-8")

    proj = make_project_at(proj_root)
    rel_paths = {p.relative_to(proj.root).as_posix() for p in parser.iter_source_files(proj)}

    assert "src/keep.py" in rel_paths
    assert "node_modules/pkg/skip.py" not in rel_paths


def test_iter_source_files_skips_generated_lockfiles_and_minified(tmp_path):
    """Lockfiles and minified bundles have indexable extensions but should be skipped.

    ``package-lock.json`` is ``.json``; ``app.min.js`` is ``.js``. Without the
    generated-filename gate, the walker would happily ingest 100k-line lockfiles
    and pollute the symbol table with auto-generated identifiers.
    """
    from token_goat import parser
    from token_goat.project import make_project_at

    proj_root = tmp_path / "gen_root"
    proj_root.mkdir()
    (proj_root / "src").mkdir()

    # Files that SHOULD be indexed
    (proj_root / "src" / "app.py").write_text("def hello(): pass\n", encoding="utf-8")
    (proj_root / "src" / "config.json").write_text('{"k": 1}\n', encoding="utf-8")
    (proj_root / "src" / "real.js").write_text("function f() {}\n", encoding="utf-8")

    # Files that should NOT be indexed
    (proj_root / "package-lock.json").write_text('{"lock": true}\n', encoding="utf-8")
    (proj_root / "uv.lock").write_text("# uv lock\n", encoding="utf-8")
    (proj_root / "yarn.lock").write_text("# yarn lock\n", encoding="utf-8")
    (proj_root / "src" / "app.min.js").write_text("var a=1;\n", encoding="utf-8")
    (proj_root / "src" / "style.min.css").write_text("a{x:1}\n", encoding="utf-8")
    (proj_root / "src" / "app.js.map").write_text('{"version":3}\n', encoding="utf-8")
    (proj_root / "src" / "vendor.bundle.js").write_text("var v=1;\n", encoding="utf-8")
    # OS metadata
    (proj_root / "Thumbs.db").write_text("garbage", encoding="utf-8")

    proj = make_project_at(proj_root)
    rel_paths = {p.relative_to(proj.root).as_posix() for p in parser.iter_source_files(proj)}

    # Real source files survive
    assert "src/app.py" in rel_paths
    assert "src/config.json" in rel_paths
    assert "src/real.js" in rel_paths
    # Generated artifacts are skipped
    assert "package-lock.json" not in rel_paths
    assert "uv.lock" not in rel_paths
    assert "yarn.lock" not in rel_paths
    assert "src/app.min.js" not in rel_paths
    assert "src/style.min.css" not in rel_paths
    assert "src/app.js.map" not in rel_paths
    assert "src/vendor.bundle.js" not in rel_paths
    assert "Thumbs.db" not in rel_paths


def test_is_generated_filename_case_insensitive():
    """Case-insensitive matching prevents Windows-case-mangled lockfiles slipping through."""
    from token_goat.parser import _is_generated_filename

    assert _is_generated_filename("package-lock.json")
    assert _is_generated_filename("Package-Lock.JSON")
    assert _is_generated_filename("UV.LOCK")
    assert _is_generated_filename("app.MIN.JS")
    assert _is_generated_filename("Thumbs.db")
    # Negatives: real source files
    assert not _is_generated_filename("app.js")
    assert not _is_generated_filename("package.json")
    assert not _is_generated_filename("main.py")
    assert not _is_generated_filename("README.md")


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


def test_incremental_prunes_deleted_files(ts_project):
    """Regression: a deleted file must be removed from the index, not lingered.

    Without pruning, `token-goat symbol`/`read`/`map` surface dead paths forever
    after a file is deleted or renamed.
    """
    index_project(ts_project, full=True)

    # Create then index a throwaway file.
    scratch = ts_project.root / "scratch_prune.ts"
    scratch.write_text("export function pruneMarker() {}\n", encoding="utf-8")
    index_project(ts_project, full=False)
    with db.open_project(ts_project.hash) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM files WHERE rel_path='scratch_prune.ts'"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM symbols WHERE name='pruneMarker'"
        ).fetchone()[0] >= 1

    # Delete it and re-index — file and its symbols must be gone.
    scratch.unlink()
    index_project(ts_project, full=False)
    with db.open_project(ts_project.hash) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM files WHERE rel_path='scratch_prune.ts'"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM symbols WHERE name='pruneMarker'"
        ).fetchone()[0] == 0


def test_full_index_prunes_deleted_files(ts_project):
    """Pruning must also apply on a full re-index, not just incremental."""
    scratch = ts_project.root / "scratch_full.ts"
    scratch.write_text("export function fullMarker() {}\n", encoding="utf-8")
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM files WHERE rel_path='scratch_full.ts'"
        ).fetchone()[0] == 1

    scratch.unlink()
    index_project(ts_project, full=True)
    with db.open_project(ts_project.hash) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM files WHERE rel_path='scratch_full.ts'"
        ).fetchone()[0] == 0


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


# ---------------------------------------------------------------------------
# Light indexers (Liquid, Markdown, HTML, JSON)
# ---------------------------------------------------------------------------


def test_liquid_project_index(tmp_path, tmp_data_dir, make_project):
    """Index a Liquid project and verify sections table is populated."""
    proj_root = tmp_path / "liquid_sample"
    shutil.copytree(FIXTURE_DIR / "liquid_sample", proj_root)
    proj = make_project(proj_root)

    summary = index_project(proj, full=True)
    assert summary["indexed"] >= 1
    assert "liquid" in summary["languages"]

    # Verify sections table has entries
    with db.open_project(proj.hash) as conn:
        rows = conn.execute("SELECT COUNT(*) as cnt FROM sections").fetchone()
        assert rows["cnt"] > 0


def test_markdown_project_index(tmp_path, tmp_data_dir, make_project):
    """Index a Markdown project and verify sections table is populated."""
    proj_root = tmp_path / "md_sample"
    shutil.copytree(FIXTURE_DIR / "md_sample", proj_root)
    proj = make_project(proj_root)

    summary = index_project(proj, full=True)
    assert summary["indexed"] >= 1
    assert "markdown" in summary["languages"]

    # Verify sections and symbols have entries
    with db.open_project(proj.hash) as conn:
        sections = conn.execute("SELECT COUNT(*) as cnt FROM sections").fetchone()
        symbols = conn.execute("SELECT COUNT(*) as cnt FROM symbols").fetchone()
        assert sections["cnt"] > 0
        assert symbols["cnt"] > 0


def test_html_project_index(tmp_path, tmp_data_dir, make_project):
    """Index an HTML project and verify symbols table is populated."""
    proj_root = tmp_path / "html_sample"
    shutil.copytree(FIXTURE_DIR / "html_sample", proj_root)
    proj = make_project(proj_root)

    summary = index_project(proj, full=True)
    assert summary["indexed"] >= 1
    assert "html" in summary["languages"]

    # Verify symbols table has id/class entries
    with db.open_project(proj.hash) as conn:
        rows = conn.execute(
            "SELECT COUNT(*) as cnt FROM symbols WHERE kind IN ('html_id', 'html_class')"
        ).fetchone()
        assert rows["cnt"] > 0


# ---------------------------------------------------------------------------
# mtime fast-path
# ---------------------------------------------------------------------------

def test_incremental_mtime_fastpath_bypasses_index_file(ts_project):
    """After a full index, incremental mode must not call index_file for any unchanged file."""
    index_project(ts_project, full=True)
    with patch("token_goat.parser.index_file") as spy:
        summary = index_project(ts_project, full=False)
    assert spy.call_count == 0, (
        f"index_file called {spy.call_count}x — mtime fast-path should have short-circuited all"
    )
    assert summary["skipped_unchanged"] > 0
    assert summary["indexed"] == 0


def test_incremental_mtime_changed_same_content_is_skipped(ts_project):
    """Touching a file (mtime bumped, content identical) counts as skipped_unchanged, not indexed."""
    index_project(ts_project, full=True)

    ts_file = ts_project.root / "index.ts"
    original = ts_file.read_bytes()
    ts_file.write_bytes(original)  # same content
    os.utime(ts_file, (ts_file.stat().st_atime, ts_file.stat().st_mtime + 1.0))

    summary = index_project(ts_project, full=False)
    # mtime differs → index_file runs → SHA matches → skipped_unchanged
    assert summary["indexed"] == 0
    assert summary["skipped_unchanged"] > 0


def test_incremental_mtime_new_file_is_indexed(ts_project):
    """A file added after the initial full index is picked up in the next incremental pass."""
    index_project(ts_project, full=True)
    (ts_project.root / "added.ts").write_text("export function added() {}", encoding="utf-8")
    summary = index_project(ts_project, full=False)
    assert summary["indexed"] >= 1
