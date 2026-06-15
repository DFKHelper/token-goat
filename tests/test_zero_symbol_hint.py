"""Tests for the zero-indexed-symbols hint guard.

When a `token-goat symbol NAME --file F` lookup misses, or `token-goat outline F`
finds nothing, the post-miss guidance must not point at `skeleton`/`outline` for a
file that has zero indexed symbols (a config file, an empty module, or content the
parser could not extract anything from) — running it would just print an empty list.
These tests cover db.count_symbols_for_file, the skeleton-or-empty hint helper, the
scoped-file resolver, the symbol --file miss path, and the outline zero-symbol branch.
"""
from __future__ import annotations

import json

import pytest

# app.py carries one real symbol; config_blank.py is indexed but symbol-free.
_FILES = {
    "app.py": "def handler():\n    return 1\n",
    "config_blank.py": "# config only, no indexed symbols here\n",
}


def _make_zsh_project(tmp_path, make_project, files=None):
    """Index a throwaway project containing *files* (rel name -> content)."""
    from token_goat.parser import index_project

    files = _FILES if files is None else files
    proj_root = tmp_path / "zsh_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    for name, content in files.items():
        path = proj_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# Preconditions: count_symbols_for_file distinguishes symbol-free from missing
# ---------------------------------------------------------------------------

class TestCountSymbolsForFile:
    def test_counts_distinguish_symbol_and_blank_files(self, tmp_path, tmp_data_dir, make_project):
        from token_goat import db

        _root, proj = _make_zsh_project(tmp_path, make_project)
        # The file with a function has at least one symbol; the comment-only file
        # is indexed (resolvable) but yields zero symbols.
        assert db.count_symbols_for_file(proj.hash, "app.py") >= 1
        assert db.count_symbols_for_file(proj.hash, "config_blank.py") == 0

    def test_missing_db_returns_zero(self, tmp_data_dir):
        from token_goat import db

        # A project hash with no DB on disk must read as 0, not raise.
        assert db.count_symbols_for_file("deadbeef" * 8, "whatever.py") == 0


# ---------------------------------------------------------------------------
# skeleton_or_empty_hint + resolve_scoped_file helpers
# ---------------------------------------------------------------------------

class TestHintHelpers:
    def test_skeleton_hint_for_file_with_symbols(self, tmp_path, tmp_data_dir, make_project):
        from token_goat import read_commands

        _root, proj = _make_zsh_project(tmp_path, make_project)
        hint = read_commands.skeleton_or_empty_hint(proj.hash, "app.py")
        assert "skeleton" in hint
        assert "app.py" in hint
        assert "no indexed symbols" not in hint

    def test_note_for_zero_symbol_file(self, tmp_path, tmp_data_dir, make_project):
        from token_goat import read_commands

        _root, proj = _make_zsh_project(tmp_path, make_project)
        hint = read_commands.skeleton_or_empty_hint(proj.hash, "config_blank.py")
        assert "no indexed symbols" in hint
        assert "config_blank.py" in hint
        # The misleading skeleton suggestion must be gone for a symbol-free file.
        assert "skeleton" not in hint

    def test_resolve_scoped_file_single_match(self, tmp_path, tmp_data_dir, make_project):
        from token_goat import read_commands

        _root, proj = _make_zsh_project(tmp_path, make_project)
        assert read_commands.resolve_scoped_file(proj.hash, "%app.py%") == "app.py"
        # Resolves a symbol-free file too — it queries the files table, not symbols.
        assert read_commands.resolve_scoped_file(proj.hash, "%config_blank.py%") == "config_blank.py"

    def test_resolve_scoped_file_ambiguous_and_missing_return_none(self, tmp_path, tmp_data_dir, make_project):
        from token_goat import read_commands

        _root, proj = _make_zsh_project(tmp_path, make_project)
        # ".py" matches both files — ambiguous scope must not resolve to one.
        assert read_commands.resolve_scoped_file(proj.hash, "%.py%") is None
        # A scope matching no indexed file resolves to None (unchanged miss path).
        assert read_commands.resolve_scoped_file(proj.hash, "%nosuchfile.py%") is None


# ---------------------------------------------------------------------------
# symbol --file miss path (CLI)
# ---------------------------------------------------------------------------

class TestSymbolFileScopeMiss:
    def _invoke(self, monkeypatch, proj_root, args):
        from typer.testing import CliRunner

        from token_goat.cli import app

        monkeypatch.chdir(proj_root)
        return CliRunner().invoke(app, args)

    def test_file_with_symbols_shows_skeleton_hint(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        result = self._invoke(monkeypatch, proj_root, ["symbol", "nonexistent", "app.py"])
        assert result.exit_code == 1, result.output
        assert "No symbol 'nonexistent' found" in result.output
        assert "skeleton" in result.output
        assert "no indexed symbols" not in result.output

    def test_zero_symbol_file_shows_note(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        result = self._invoke(monkeypatch, proj_root, ["symbol", "nonexistent", "config_blank.py"])
        assert result.exit_code == 1, result.output
        assert "no indexed symbols" in result.output
        # The skeleton suggestion must be suppressed for the symbol-free file.
        assert "token-goat skeleton" not in result.output

    def test_unmatched_file_scope_unchanged(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        result = self._invoke(monkeypatch, proj_root, ["symbol", "anything", "nosuchfile.py"])
        assert result.exit_code == 1, result.output
        assert "No symbol 'anything' found in files matching 'nosuchfile.py'" in result.output
        # No file resolved, so neither the skeleton hint nor the note appears.
        assert "skeleton" not in result.output
        assert "no indexed symbols" not in result.output

    def test_zero_symbol_file_json_carries_file_hint(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        result = self._invoke(
            monkeypatch, proj_root, ["symbol", "--json", "nonexistent", "config_blank.py"]
        )
        data = json.loads(result.output.strip())
        assert data["total"] == 0
        assert "no indexed symbols" in data["file_hint"]


# ---------------------------------------------------------------------------
# outline zero-symbol branch
# ---------------------------------------------------------------------------

class TestOutlineZeroSymbol:
    def test_outline_zero_symbol_file_emits_note(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline

        outline(str(proj_root / "config_blank.py"))
        out, err = capsys.readouterr()
        combined = out + err
        assert "no indexed symbols" in combined
        # The generic "run index --full" guidance does not apply to an indexed,
        # symbol-free file, so it must not be shown here.
        assert "index --full" not in combined

    def test_outline_filtered_symbols_keeps_existing_message(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        # app.py HAS a symbol; --min-lines filters it out so rows_with_depth is
        # empty while count > 0. The branch must keep the original message, not
        # claim the file has no indexed symbols.
        proj_root, _proj = _make_zsh_project(tmp_path, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline

        outline(str(proj_root / "app.py"), min_lines=100)
        out, err = capsys.readouterr()
        combined = out + err
        assert "No indexed top-level symbols found" in combined
        assert "no indexed symbols —" not in combined


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
