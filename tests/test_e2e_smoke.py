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

import pytest
from typer.testing import CliRunner

import token_goat.paths as paths
from token_goat import cli, hooks_cli, hooks_edit, worker

runner = CliRunner()

# One case per source language adapter that extracts symbols. The chain under
# test (hook -> queue -> worker drain -> index -> CLI query) is identical for
# every language, but each routes through its own tree-sitter adapter — so a
# regression in any single adapter would slip past a Python-only smoke test.
# (filename, source content, symbol name as the extractor records it)
_LANG_CASES = [
    pytest.param(
        "widget.py", "def assemble_widget():\n    return 42\n", "assemble_widget",
        id="python",
    ),
    pytest.param(
        "widget.ts", "export function assembleWidget() {\n    return 42;\n}\n", "assembleWidget",
        id="typescript",
    ),
    pytest.param(
        "widget.go", "package main\n\nfunc AssembleWidget() int {\n    return 42\n}\n", "AssembleWidget",
        id="go",
    ),
    pytest.param(
        "widget.rs", "fn assemble_widget() -> i32 {\n    42\n}\n", "assemble_widget",
        id="rust",
    ),
]


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


@pytest.mark.parametrize("filename,content,symbol", _LANG_CASES)
def test_edit_to_query_end_to_end(filename, content, symbol, tmp_path, tmp_data_dir, monkeypatch):
    """A first edit to a never-indexed project flows hook -> queue -> worker -> query.

    Parameterized per language so each tree-sitter adapter is exercised through
    the full chain, not just the Python one.
    """
    monkeypatch.setattr(hooks_edit, "_nudge_worker_if_down", lambda: None)
    # The worker's memory guard checks the test runner's RSS (can exceed 500 MB in a
    # full suite run), which would skip indexing and break Leg 2.  Disable the guard
    # here — this test exercises indexing correctness, not memory pressure behavior.
    monkeypatch.setattr(worker, "_is_under_memory_pressure", lambda: False)

    proj_root = _make_project(tmp_path)
    src = proj_root / filename
    src.write_text(content, encoding="utf-8")

    # Leg 1: the post-edit hook resolves the project and appends to the queue.
    _post_edit(proj_root, src)
    assert paths.dirty_queue_path().exists(), "post-edit hook did not write the dirty queue"

    # Leg 2: the worker drains the queue and runs a first full index.
    entries = _drain_and_index()
    assert entries, "worker.drain_dirty_queue returned nothing the hook had enqueued"
    assert entries[0]["path"] == filename

    # Leg 3: the CLI query surfaces the symbol from the freshly-built index.
    monkeypatch.chdir(proj_root)
    result = runner.invoke(cli.app, ["symbol", symbol, "--json"])
    assert result.exit_code == 0, result.stdout
    payload = json.loads(result.stdout)
    # Unified envelope: {"query":..., "results":[...], "total":N}
    rows = payload["results"] if isinstance(payload, dict) else payload
    assert any(
        r["name"] == symbol and r["file"] == filename for r in rows
    ), f"symbol not queryable after end-to-end flow ({filename}): {result.stdout!r}"


def test_incremental_edit_propagates_end_to_end(tmp_path, tmp_data_dir, monkeypatch):
    """A *second* edit to an already-indexed project flows through the incremental
    leg of the same chain — _process_dirty_entries runs index_project(full=False)
    once the project is registered, a different branch from the first-index path."""
    monkeypatch.setattr(hooks_edit, "_nudge_worker_if_down", lambda: None)
    monkeypatch.setattr(worker, "_is_under_memory_pressure", lambda: False)

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
    payload = json.loads(result.stdout)
    # Unified envelope: {"query":..., "results":[...], "total":N}
    rows = payload["results"] if isinstance(payload, dict) else payload
    assert any(r["name"] == "paint_widget" for r in rows), (
        f"newly-added symbol not queryable after incremental end-to-end flow: {result.stdout!r}"
    )


def test_stale_worker_is_respawned_end_to_end(tmp_path, tmp_data_dir, monkeypatch):
    """A stale heartbeat drives the real recovery chain end-to-end:
    post-edit hook -> _nudge_worker_if_down -> worker.ensure_running -> spawn_detached.

    Every leg runs for real except the final spawn_detached, which is stubbed so
    the test never launches a detached process. The dispatcher-level tests stub
    ensure_running wholesale and the worker tests stub the watchdog that calls
    it — nothing chains the watchdog to ensure_running's crashed/hung/busy state
    machine. This does.
    """
    import os
    import time as _time

    # Stale heartbeat + no pid file => ensure_running sees no healthy/live worker
    # and falls through to spawn_detached.
    paths.ensure_dirs()
    hb = paths.worker_heartbeat_path()
    hb.write_text("stale", encoding="utf-8")
    old = _time.time() - 600
    os.utime(hb, (old, old))

    spawned: list[bool] = []
    monkeypatch.setattr(worker, "spawn_detached", lambda: (spawned.append(True), 4321)[1])

    proj_root = _make_project(tmp_path)
    src = proj_root / "widget.py"
    src.write_text("def assemble_widget():\n    return 42\n", encoding="utf-8")

    # Real post-edit hook -> real nudge -> real ensure_running -> stubbed spawn.
    _post_edit(proj_root, src)

    assert spawned == [True], (
        "a stale-heartbeat worker must be respawned through the real recovery chain"
    )
