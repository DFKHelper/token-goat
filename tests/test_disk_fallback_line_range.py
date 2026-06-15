"""Tests for the line-range disk fallback on unindexed / over-cap files.

When a file is skipped at index time for exceeding the size cap, the over-cap
hint (:func:`token_goat.read_commands.over_cap_file_hint`) tells users to reach
for ``token-goat read "file::N-M"``.  Those line-range reads used to route through
the index too and miss with a generic "not found", contradicting the hint.  The
fallback (:func:`token_goat.read_commands._find_unindexed_file_on_disk` →
:func:`token_goat.read_commands._run_disk_fallback_line_range`) now streams the
requested lines straight from disk, bounded to 5000 lines, inside the project root
only.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from conftest import make_project_from_root
from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


def _line_text(i: int) -> str:
    """Deterministic content for 1-based line *i* (35 chars, no newline)."""
    return f"L{i:05d} " + "x" * 28


def _make_over_cap_file(root: Path, name: str = "huge.js") -> None:
    """Write *name* under *root*: 100 readable lines, then binary-pad past the cap.

    The indexer skips any file larger than ``MAX_FILE_SIZE`` (2,000,000 B), so the
    file is never parsed — only stat'd.  Appending one long ``x`` run after the
    100th line drives the size to 2.2 MB in a single ``write_bytes`` call
    (microseconds), replacing a 60k-iteration Python string loop while keeping
    lines 1-100 exactly as the assertions expect.  The pad is pure ``x`` bytes, so
    no ``_line_text`` value (each carries an ``L#####`` prefix) ever appears in it.
    """
    body = "\n".join(_line_text(i) for i in range(1, 101)).encode()
    pad = b"\n" + b"x" * (2_200_000 - len(body) - 1)
    (root / name).write_bytes(body + pad)


def _index_with_multiline_over_cap(
    tmp_path, make_project, *, oversized: str = "huge.js", subdir: str = "proj"
):
    """Build and index a project whose *oversized* file exceeds the size cap.

    Unlike the single-blob over-cap fixture, the oversized file has many short
    lines so a narrow line-range read returns small, assertable content.
    ``keeper.py`` stays tiny so the project still indexes cleanly.  *subdir* lets
    callers build several distinct projects under one ``tmp_path`` (e.g. for
    cross-project isolation tests).
    """
    root = tmp_path / subdir
    root.mkdir()
    (root / ".git").mkdir()
    (root / "keeper.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    _make_over_cap_file(root, oversized)

    proj = make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config
    from token_goat.parser import index_project

    with patch.object(_config_mod, "load", return_value=Config()):
        index_project(proj, full=True)
    return root, proj


def _index_clean_project(tmp_path, make_project, *, subdir: str = "projA"):
    """Build and index a small project with no over-cap / unindexed files.

    Serves as the *current* project in cross-project isolation tests: it owns
    nothing the fallback could match, so any hit must have leaked from elsewhere.
    """
    root = tmp_path / subdir
    root.mkdir()
    (root / ".git").mkdir()
    (root / "keeper.py").write_text("def keep():\n    return 1\n", encoding="utf-8")

    proj = make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config
    from token_goat.parser import index_project

    with patch.object(_config_mod, "load", return_value=Config()):
        index_project(proj, full=True)
    return root, proj


@pytest.fixture(scope="module")
def over_cap_root(module_tmp_data_dir, tmp_path_factory):
    """Build and index the shared over-cap project ONCE for the read-only group.

    Seven of the eight tests need the same layout: a tiny ``keeper.py`` that
    indexes cleanly beside a 2.2 MB ``huge.js`` that exceeds the cap and is skipped
    at index time, so every read exercises the disk-fallback surface.  None of
    those tests mutate the indexed DB (they only invoke ``read``), so module scope
    is safe and ``index_project`` is paid once instead of seven times.  The
    cross-project isolation test, which needs two distinct projects, keeps its own
    function-scoped setup.
    """
    import token_goat.config as _config_mod
    from token_goat.config import Config
    from token_goat.parser import index_project

    root = tmp_path_factory.mktemp("over_cap_proj")
    (root / ".git").mkdir()
    (root / "keeper.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    _make_over_cap_file(root, "huge.js")

    proj = make_project_from_root(root)
    with patch.object(_config_mod, "load", return_value=Config()):
        index_project(proj, full=True)
    return root


# ---------------------------------------------------------------------------
# Disk fallback succeeds on an over-cap file
# ---------------------------------------------------------------------------

def test_line_range_disk_fallback_reads_over_cap_file(over_cap_root, monkeypatch):
    """``read "huge.js::1-10"`` on a skipped file streams lines from disk."""
    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "huge.js::1-10"])

    assert result.exit_code == 0, result.output
    out = result.output
    # Disk-fallback banner names the file and flags it as a raw, unindexed read.
    assert "[disk-fallback: huge.js (not indexed)]" in out
    # The requested lines are present; lines outside the range are not.
    assert _line_text(1) in out
    assert _line_text(10) in out
    assert _line_text(11) not in out
    # The contradictory generic miss must not appear.
    assert "File not found in any indexed project" not in out


def test_line_range_disk_fallback_json_envelope(over_cap_root, monkeypatch):
    """``read --json "huge.js::1-3"`` reports a ``disk_fallback`` flag and text."""
    import json as _json

    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "--json", "huge.js::1-3"])

    assert result.exit_code == 0, result.output
    payload = _json.loads(result.output)
    assert payload["disk_fallback"] is True
    assert payload["file"] == "huge.js"
    assert payload["start_line"] == 1
    assert payload["end_line"] == 3
    assert _line_text(2) in payload["text"]


# ---------------------------------------------------------------------------
# Disk fallback is bounded
# ---------------------------------------------------------------------------

def test_line_range_disk_fallback_bounded(over_cap_root, monkeypatch):
    """A >5000-line span on an unindexed file is refused with a clear error."""
    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "huge.js::1-6000"])

    assert result.exit_code == 2, result.output
    out = result.output
    assert "5000-line disk-fallback cap" in out
    assert "6000 lines" in out
    # It must error before emitting any file content.
    assert "[disk-fallback:" not in out


def test_line_range_disk_fallback_bounded_json(over_cap_root, monkeypatch):
    """The bounded error surfaces structurally under ``--json``."""
    import json as _json

    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "--json", "huge.js::1-6000"])

    assert result.exit_code == 2, result.output
    payload = _json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "disk_fallback_range_too_large"


# ---------------------------------------------------------------------------
# No regression for indexed files
# ---------------------------------------------------------------------------

def test_line_range_indexed_file_no_fallback(over_cap_root, monkeypatch):
    """An indexed file still reads from the index — no disk-fallback banner."""
    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "keeper.py::1-2"])

    assert result.exit_code == 0, result.output
    out = result.output
    assert "def keep():" in out
    assert "return 1" in out
    # The indexed happy path must not be routed through the disk fallback.
    assert "disk-fallback" not in out


# ---------------------------------------------------------------------------
# A genuinely missing file still misses
# ---------------------------------------------------------------------------

def test_line_range_nonexistent_file_still_not_found(over_cap_root, monkeypatch):
    """A line-range read of a file that exists nowhere keeps the not-found path."""
    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "ghost.js::1-10"])

    assert result.exit_code == 0, result.output
    out = result.output
    assert "File not found in any indexed project" in out
    assert "disk-fallback" not in out


def test_line_range_disk_fallback_refuses_path_escape(over_cap_root, monkeypatch):
    """A ``../`` escape needle never resolves outside the project root."""
    # A secret file sitting beside (outside) the project root.
    secret = over_cap_root.parent / "secret.txt"
    secret.write_text("TOP SECRET\n", encoding="utf-8")
    monkeypatch.chdir(over_cap_root)

    result = runner.invoke(app, ["read", "../secret.txt::1-1"])

    assert "TOP SECRET" not in result.output
    assert "[disk-fallback:" not in result.output


# ---------------------------------------------------------------------------
# Cross-project isolation: the fallback never reaches a sibling project
# ---------------------------------------------------------------------------

def test_disk_fallback_stays_in_current_project(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """A line-range disk fallback stays inside the *current* project.

    Project A (the cwd) has no ``shared.js``; project B has one as an unindexed,
    over-cap file that exists on disk.  ``read "shared.js::1-5"`` issued from A
    must report a clean miss — confining the scan to the active project is the
    invariant.  Before the fix the fallback scanned *every* indexed project and
    silently served B's content across the boundary.
    """
    root_a, _proj_a = _index_clean_project(tmp_path, make_project, subdir="projA")
    root_b, _proj_b = _index_with_multiline_over_cap(
        tmp_path, make_project, oversized="shared.js", subdir="projB"
    )
    # Precondition: the cross-project file genuinely exists on disk in B, so a
    # leak would be a real disclosure (not a no-op against a missing file).
    assert (root_b / "shared.js").is_file()

    monkeypatch.chdir(root_a)

    result = runner.invoke(app, ["read", "shared.js::1-5"])

    assert result.exit_code == 0, result.output
    out = result.output
    # The read misses inside the current project rather than serving B's file.
    assert "File not found in any indexed project" in out
    # No disk-fallback path was taken, and none of B's content leaked across.
    assert "disk-fallback" not in out
    assert _line_text(1) not in out
    assert _line_text(5) not in out
