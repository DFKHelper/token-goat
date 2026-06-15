"""Tests for the over-cap (skipped-large) file hint surfaced by read/symbol/outline.

When a file exists in the project but was skipped during indexing for exceeding
the size cap, ``token-goat read``/``symbol``/``outline`` should explain *why* the
file is unreadable (and point at line-range reads) instead of emitting a generic
"not found" with unrelated "did you mean…?" suggestions.

The indexer records over-cap files in the ``skipped_large_files`` project meta row
(:func:`token_goat.parser.index_project`); the read path consults it on a miss
(:func:`token_goat.read_commands.over_cap_file_hint`).
"""
from __future__ import annotations

import json
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat import db
from token_goat.cli import app
from token_goat.parser import index_project
from token_goat.read_commands import over_cap_file_hint

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Just above both the indexer's default 2048 KB skip cap (2,097,152 bytes) and the
# read path's _MAX_READ_BYTES disk-fallback cap (2,000,000 bytes).  A file this size
# is skipped at index time *and* refused by the on-disk read fallback, which is the
# exact condition that drops a real lookup onto the "not found" path.  The file is
# never parsed (skipped) or read (refused), so the large size adds no test latency.
_OVER_CAP_BYTES = 2_200_000


def _index_with_over_cap(tmp_path, make_project, *, oversized: str = "huge.js"):
    """Build and index a 2-file project where *oversized* exceeds the size cap.

    Indexing runs under the default config (2048 KB skip cap), pinned explicitly so
    the threshold is deterministic regardless of any config.toml on the host.
    ``keeper.py`` stays tiny so the project still indexes cleanly.
    """
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    (root / "keeper.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    big = root / oversized
    big.write_text("// " + "a" * _OVER_CAP_BYTES, encoding="utf-8")

    proj = make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config

    with patch.object(_config_mod, "load", return_value=Config()):
        index_project(proj, full=True)
    return root, proj


def _index_small_only(tmp_path, make_project):
    """Index a project with a single small file and no over-cap files."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / ".git").mkdir()
    (root / "keeper.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    proj = make_project(root)

    import token_goat.config as _config_mod
    from token_goat.config import Config

    with patch.object(_config_mod, "load", return_value=Config()):
        index_project(proj, full=True)
    return root, proj


# ---------------------------------------------------------------------------
# Persistence: index_project writes the skip list to project meta
# ---------------------------------------------------------------------------

def test_index_project_persists_skipped_large_to_meta(tmp_path, tmp_data_dir, make_project):
    """The skipped-large list lands in the ``skipped_large_files`` meta row."""
    _root, proj = _index_with_over_cap(tmp_path, make_project)

    with db.open_project_readonly(proj.hash) as conn:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = ?", ("skipped_large_files",)
        ).fetchone()

    assert row is not None, "expected a skipped_large_files meta row after indexing"
    data = json.loads(row["value"])
    assert any("huge.js" in e["rel_path"] for e in data), data
    assert all(isinstance(e.get("size_bytes"), int) for e in data), data


def test_index_project_persists_empty_list_when_no_over_cap(tmp_path, tmp_data_dir, make_project):
    """A project with no over-cap files records an empty skip list (not absent)."""
    _root, proj = _index_small_only(tmp_path, make_project)

    with db.open_project_readonly(proj.hash) as conn:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = ?", ("skipped_large_files",)
        ).fetchone()

    assert row is not None
    assert json.loads(row["value"]) == []


# ---------------------------------------------------------------------------
# Unit: over_cap_file_hint matching
# ---------------------------------------------------------------------------

def test_over_cap_file_hint_matches_exact_and_basename(tmp_path, tmp_data_dir, make_project):
    """The helper matches by exact path, sub-path, and bare basename; misses cleanly."""
    _root, proj = _index_with_over_cap(tmp_path, make_project)

    assert over_cap_file_hint("huge.js", proj) is not None
    # A fuller path the caller might pass still resolves via the shared basename.
    assert over_cap_file_hint("scripts/huge.js", proj) is not None
    # Genuinely unrelated names do not match.
    assert over_cap_file_hint("nonexistent.py", proj) is None
    # Defensive: no project / empty input never matches.
    assert over_cap_file_hint("huge.js", None) is None
    assert over_cap_file_hint("", proj) is None


def test_over_cap_hint_does_not_match_partial_filename(tmp_path, tmp_data_dir, make_project):
    """A needle that is a substring of a skipped basename must not false-match.

    Regression: the old ``needle in rel_norm`` test fired across filename
    boundaries (``service.py`` inside ``user_service.py``), mislabelling a
    genuine miss as an over-cap skip. The exact basename still matches.
    """
    _root, proj = _index_with_over_cap(tmp_path, make_project, oversized="user_service.py")

    # Sanity: the over-cap file is correctly fixtured (exact basename matches).
    assert over_cap_file_hint("user_service.py", proj) is not None
    # The bug: a partial basename must NOT match across the filename boundary.
    assert over_cap_file_hint("service.py", proj) is None


def test_over_cap_file_hint_message_shape(tmp_path, tmp_data_dir, make_project):
    """The hint names the file, states the 2 MB cap, and points at line-range reads."""
    _root, proj = _index_with_over_cap(tmp_path, make_project)
    msg = over_cap_file_hint("huge.js", proj)
    assert msg is not None
    assert "huge.js" in msg
    assert "was not indexed" in msg
    assert "2 MB" in msg
    assert 'token-goat read "huge.js::1-200"' in msg


# ---------------------------------------------------------------------------
# read / symbol / outline emit the hint on a miss
# ---------------------------------------------------------------------------

def test_read_over_cap_file_emits_size_hint(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """``read "huge.js::Sym"`` on a skipped file emits the size hint, exit 1."""
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "huge.js::MyFunction"])

    assert result.exit_code == 1
    out = result.output
    assert "huge.js" in out
    assert "was not indexed" in out
    assert "line-range reads" in out
    # The generic miss path must be suppressed for over-cap files.
    assert "File not found in any indexed project" not in out


def test_symbol_over_cap_file_emits_size_hint(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """``symbol Sym --file huge.js`` scoped to a skipped file emits the size hint."""
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["symbol", "MyFunction", "huge.js"])

    assert result.exit_code == 1
    out = result.output
    assert "huge.js" in out
    assert "was not indexed" in out
    assert "line-range reads" in out
    assert "No symbol" not in out  # generic file-scoped miss is suppressed


def test_symbol_file_scope_json_over_cap_includes_signal(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """``symbol Sym --file huge.js --json`` surfaces the over-cap miss structurally.

    Regression: without the ``over_cap`` envelope key, an empty JSON result on a
    skipped file was indistinguishable from "symbol simply not in that file".
    """
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["symbol", "MyFunction", "huge.js", "--json"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["results"] == []
    assert payload["total"] == 0
    assert "over_cap" in payload
    assert "was not indexed" in payload["over_cap"]
    assert "huge.js" in payload["over_cap"]


def test_read_over_cap_file_json_envelope(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """``read --json`` reports the over-cap miss with a ``file_over_cap`` code."""
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "--json", "huge.js::MyFunction"])

    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "file_over_cap"
    assert "was not indexed" in payload["error"]["message"]


def test_outline_over_cap_file_emits_size_hint(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """``outline huge.js`` on a skipped file emits the size hint, exit 1."""
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["outline", "huge.js"])

    assert result.exit_code == 1
    out = result.output
    assert "huge.js" in out
    assert "was not indexed" in out
    assert "line-range reads" in out
    assert "File not found in any indexed project" not in out


# ---------------------------------------------------------------------------
# Genuine misses keep the regular "not found" behaviour
# ---------------------------------------------------------------------------

def test_normal_missing_file_still_emits_not_found(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """A file that was never in the project gets the regular miss, not the hint."""
    root, _proj = _index_small_only(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "ghost.py::Thing"])

    # Generic read misses keep their existing exit code (0) — only the new
    # over-cap path escalates to exit 1.
    assert result.exit_code == 0
    out = result.output
    assert "File not found in any indexed project" in out
    assert "was not indexed" not in out
    assert "line-range reads" not in out


def test_over_cap_file_does_not_shadow_unrelated_missing_file(
    tmp_path, tmp_data_dir, make_project, monkeypatch
):
    """With an over-cap file present, an unrelated missing path still misses normally."""
    root, _proj = _index_with_over_cap(tmp_path, make_project)
    monkeypatch.chdir(root)

    result = runner.invoke(app, ["read", "totally-unrelated.py::Thing"])

    # The unrelated miss does not match the skip list, so it stays on the
    # generic path (exit 0, no size hint).
    assert result.exit_code == 0
    out = result.output
    assert "was not indexed" not in out
    assert "File not found in any indexed project" in out
