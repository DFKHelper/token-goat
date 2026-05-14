"""End-to-end smoke test: post-edit hook -> dirty queue -> worker drain -> CLI query.

Each leg of this chain has unit coverage elsewhere (test_hooks_dispatcher,
test_worker, test_index_pipeline, test_symbol_cli), but nothing exercises them
*chained* as the single flow a real edit actually travels. This test wires the
real components together — real post-edit hook, real on-disk dirty queue, real
SQLite + tree-sitter indexing, real Typer CLI — in a tmp data dir, and asserts a
symbol written to a source file becomes queryable. The only thing stubbed is the
hook's worker-nudge: the test drives the worker by hand, so the nudge is
silenced to stop it spawning a real detached process.
"""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

import tokenwise.paths as paths
from tokenwise import cli, hooks_cli, worker

runner = CliRunner()


def _make_project(tmp_path: Path) -> Path:
    """A real project directory with a .git marker so find_project resolves it."""
    proj_root = tmp_path / "sample_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    return proj_root


def _post_edit(proj_root: Path, src: Path) -> None:
    """Fire the real post-edit hook for a file in the project."""
    hooks_cli.post_edit(
        {
            "session_id": "e2e",
            "cwd": str(proj_root),
            "tool_input": {"file_path": str(src)},
        }
    )


def _drain_and_index() -> list[dict]:
    """Run the worker's drain + reindex legs, exactly as run_daemon's loop does."""
    entries = worker.drain_dirty_queue()
    worker._process_dirty_entries(entries)
    return entries


def test_edit_to_query_end_to_end(tmp_path, tmp_data_dir, monkeypatch):
    """A first edit to a never-indexed project flows hook -> queue -> worker -> query."""
    monkeypatch.setattr(hooks_cli, "_nudge_worker_if_down", lambda: None)

    proj_root = _make_project(tmp_path)
    src = proj_root / "widget.py"
    src.write_text("def assemble_widget():\n    return 42\n", encoding="utf-8")

    # Leg 1: the post-edit hook resolves the project and appends to the queue.
    _post_edit(proj_root, src)
    assert paths.dirty_queue_path().exists(), "post-edit hook did not write the dirty queue"

    # Leg 2: the worker drains the queue and runs a first full index.
    entries = _drain_and_index()
    assert entries, "worker.drain_dirty_queue returned nothing the hook had enqueued"
    assert entries[0]["path"] == "widget.py"

    # Leg 3: the CLI query surfaces the symbol from the freshly-built index.
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["symbol", "assemble_widget", "--json"])
    assert result.exit_code == 0, result.stdout
    rows = json.loads(result.stdout)
    assert any(
        r["name"] == "assemble_widget" and r["file"] == "widget.py" for r in rows
    ), f"symbol not queryable after end-to-end flow: {result.stdout!r}"


def test_incremental_edit_propagates_end_to_end(tmp_path, tmp_data_dir, monkeypatch):
    """A *second* edit to an already-indexed project flows through the incremental
    leg of the same chain — _process_dirty_entries runs index_project(full=False)
    once the project is registered, a different branch from the first-index path."""
    monkeypatch.setattr(hooks_cli, "_nudge_worker_if_down", lambda: None)

    proj_root = _make_project(tmp_path)
    src = proj_root / "widget.py"
    src.write_text("def assemble_widget():\n    return 42\n", encoding="utf-8")

    # First edit + index: registers the project in global.db.
    _post_edit(proj_root, src)
    _drain_and_index()

    # Second edit: add a new symbol the first index never saw.
    src.write_text(
        "def assemble_widget():\n    return 42\n\n\ndef paint_widget():\n    return 7\n",
        encoding="utf-8",
    )
    _post_edit(proj_root, src)
    entries = _drain_and_index()
    assert entries, "second post-edit did not re-enqueue the file"

    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["symbol", "paint_widget", "--json"])
    assert result.exit_code == 0, result.stdout
    rows = json.loads(result.stdout)
    assert any(r["name"] == "paint_widget" for r in rows), (
        f"newly-added symbol not queryable after incremental end-to-end flow: {result.stdout!r}"
    )
