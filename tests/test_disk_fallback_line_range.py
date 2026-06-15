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

from unittest.mock import patch

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


# Just over the indexer's default 2048 KB (2,097,152 B) skip cap *and* the read
# path's 2 MB ``_read_file_lines`` cap, spread across many short lines so a 1-10
# line read returns tiny content.  The file is skipped at index time, so its size
# never costs parse latency; the fallback streams and stops at the requested end.
_OVER_CAP_LINES = 60_000  # 60k * ~36 B ≈ 2.16 MB


def _line_text(i: int) -> str:
    """Deterministic content for 1-based line *i* (35 chars, no newline)."""
    return f"L{i:05d} " + "x" * 28


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
    big = root / oversized
    big.write_text("\n".join(_line_text(i) for i in range(1, _OVER_CAP_LINES + 1)), encoding="utf-8")

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


# ---------------------------------------------------------------------------
# Disk fallback succeeds on an over-cap file
# ---------------------------------------------------------------------------

def test_line_range_disk_fallback_reads_over_cap_file(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """``read "huge.js::1-10"`` on a skipped file streams lines from disk."""
    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

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


def test_line_range_disk_fallback_json_envelope(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """``read --json "huge.js::1-3"`` reports a ``disk_fallback`` flag and text."""
    import json as _json

    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

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

def test_line_range_disk_fallback_bounded(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """A >5000-line span on an unindexed file is refused with a clear error."""
    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "huge.js::1-6000"])

    assert result.exit_code == 2, result.output
    out = result.output
    assert "5000-line disk-fallback cap" in out
    assert "6000 lines" in out
    # It must error before emitting any file content.
    assert "[disk-fallback:" not in out


def test_line_range_disk_fallback_bounded_json(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """The bounded error surfaces structurally under ``--json``."""
    import json as _json

    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "--json", "huge.js::1-6000"])

    assert result.exit_code == 2, result.output
    payload = _json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "disk_fallback_range_too_large"


# ---------------------------------------------------------------------------
# No regression for indexed files
# ---------------------------------------------------------------------------

def test_line_range_indexed_file_no_fallback(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """An indexed file still reads from the index — no disk-fallback banner."""
    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

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

def test_line_range_nonexistent_file_still_not_found(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """A line-range read of a file that exists nowhere keeps the not-found path."""
    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "ghost.js::1-10"])

    assert result.exit_code == 0, result.output
    out = result.output
    assert "File not found in any indexed project" in out
    assert "disk-fallback" not in out


def test_line_range_disk_fallback_refuses_path_escape(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """A ``../`` escape needle never resolves outside the project root."""
    root, _proj = _index_with_multiline_over_cap(tmp_path, make_project)
    # A secret file sitting beside (outside) the project root.
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET\n", encoding="utf-8")
    monkeypatch.chdir(root)

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
