"""Tests for ``token-goat skeleton`` when handed a directory instead of a file.

These exercise the directory-listing fallback in ``read_commands.stub_view``
without spinning up a real SQLite index or the parser/indexer.  The DB seams
(``_resolve_file_target`` / ``_all_indexed_projects`` / ``_indexed_paths_under``
/ ``db.open_project_readonly``) are stubbed, so the whole module runs in a few
milliseconds — no ``slow`` marker required.

Regression target: ``token-goat skeleton "src/app/(dashboard)"`` previously
exited 1 with "File not found in any indexed project" when the argument was a
directory, handing the agent a dead end.  It must now list the indexed files
under the directory and exit 0.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from types import SimpleNamespace

import pytest
import typer

from token_goat import read_commands
from token_goat.project import Project

_PROJ = Project(root=Path("/repo"), hash="deadbeef", marker="pyproject.toml")


def _no_file_target() -> read_commands._FileTarget:
    """Resolution result where nothing matched, with a current project set."""
    return read_commands._FileTarget(project=None, rel_path=None, current_project=_PROJ)


@pytest.fixture
def patch_no_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force ``_resolve_file_target`` to report 'no file matched'."""
    monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _file: _no_file_target())


def test_directory_with_indexed_files_lists_them(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    patch_no_file: None,
) -> None:
    """A directory prefix with indexed files lists them and exits 0."""
    files = ["src/app/(dashboard)/layout.tsx", "src/app/(dashboard)/page.tsx"]
    monkeypatch.setattr(read_commands, "_all_indexed_projects", list)
    monkeypatch.setattr(
        read_commands,
        "_indexed_paths_under",
        lambda _proj, prefix: list(files) if prefix == "src/app/(dashboard)/" else [],
    )

    # Returns normally (no typer.Exit) — that is exit 0 in a direct call.
    read_commands.stub_view("src/app/(dashboard)")

    captured = capsys.readouterr()
    assert "is a directory. Indexed files under it:" in captured.out
    assert "  src/app/(dashboard)/layout.tsx" in captured.out
    assert "  src/app/(dashboard)/page.tsx" in captured.out
    assert captured.err == ""


def test_directory_with_no_indexed_files(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    patch_no_file: None,
) -> None:
    """A real directory with no indexed files reports that and exits 0."""
    empty_dir = tmp_path / "emptydir"
    empty_dir.mkdir()
    monkeypatch.setattr(read_commands, "_all_indexed_projects", list)
    monkeypatch.setattr(read_commands, "_indexed_paths_under", lambda _proj, _prefix: [])

    read_commands.stub_view(str(empty_dir))

    captured = capsys.readouterr()
    assert "is a directory with no indexed files." in captured.out
    assert captured.err == ""


def test_nonexistent_path_preserves_file_not_found(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    patch_no_file: None,
) -> None:
    """A path that is neither a file nor a directory keeps the exit-1 error."""
    monkeypatch.setattr(read_commands, "_all_indexed_projects", list)
    monkeypatch.setattr(read_commands, "_indexed_paths_under", lambda _proj, _prefix: [])

    with pytest.raises(typer.Exit) as exc_info:
        read_commands.stub_view("does/not/exist-xyzzy")

    assert exc_info.value.exit_code == 1
    assert "File not found in any indexed project" in capsys.readouterr().out


def test_actual_file_still_renders_skeleton(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A genuine file argument still renders its symbol skeleton (no regression)."""
    target = read_commands._FileTarget(project=_PROJ, rel_path="src/foo.py", current_project=_PROJ)
    monkeypatch.setattr(read_commands, "_resolve_file_target", lambda _file: target)

    rows = [
        {"name": "do_thing", "kind": "function", "line": 10, "signature": "def do_thing(x):"},
    ]

    @contextlib.contextmanager
    def _fake_conn(_hash: str):  # noqa: ANN202 — test-local context manager
        yield SimpleNamespace(execute=lambda *_a, **_k: SimpleNamespace(fetchall=lambda: rows))

    monkeypatch.setattr(read_commands.db, "open_project_readonly", _fake_conn)

    read_commands.stub_view("src/foo.py")

    captured = capsys.readouterr()
    assert "# Skeleton: src/foo.py" in captured.out
    assert "do_thing" in captured.out
