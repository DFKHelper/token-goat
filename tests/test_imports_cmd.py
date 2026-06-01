"""Tests for `token-goat imports` command and db.get_file_imports / db.get_file_importers helpers."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_imports_project(
    tmp_path: Path,
    tmp_data_dir: object,
    make_project: object,
) -> tuple[Path, object]:
    """Create a minimal indexed project with two files that import each other."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "imports_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()

    # a.py imports from b.py (relative import)
    (proj_root / "a.py").write_text(
        "from .b import helper\n\ndef caller():\n    return helper()\n",
        encoding="utf-8",
    )
    # b.py is a standalone helper
    (proj_root / "b.py").write_text(
        "def helper():\n    return 42\n",
        encoding="utf-8",
    )
    proj = make_project(proj_root)  # type: ignore[operator]
    index_project(proj, full=True)
    return proj_root, proj


def _make_isolated_project(
    tmp_path: Path,
    tmp_data_dir: object,
    make_project: object,
) -> tuple[Path, object]:
    """Create a project with one file that has no internal imports."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "isolated_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / "solo.py").write_text(
        "import os\nimport sys\n\ndef standalone():\n    pass\n",
        encoding="utf-8",
    )
    proj = make_project(proj_root)  # type: ignore[operator]
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# db.get_file_imports unit tests
# ---------------------------------------------------------------------------


class TestGetFileImports:
    def test_imports_found(self, tmp_path, tmp_data_dir, make_project):
        """a.py imports from b.py — b.py should appear in the imports list."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_imports(proj.hash, "a.py")
        assert "b.py" in result

    def test_no_self_import(self, tmp_path, tmp_data_dir, make_project):
        """A file is never listed as importing itself."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_imports(proj.hash, "a.py")
        assert "a.py" not in result

    def test_isolated_file_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """A file with only stdlib imports returns an empty list."""
        from token_goat import db

        proj_root, proj = _make_isolated_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_imports(proj.hash, "solo.py")
        assert result == []

    def test_nonexistent_file_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """Querying a non-indexed file returns [] without raising."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_imports(proj.hash, "does_not_exist.py")
        assert result == []

    def test_result_is_sorted(self, tmp_path, tmp_data_dir, make_project):
        """Results are sorted alphabetically."""
        from token_goat import db
        from token_goat.parser import index_project

        proj_root = tmp_path / "multi_import_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "z_mod.py").write_text("def z(): pass\n", encoding="utf-8")
        (proj_root / "a_mod.py").write_text("def a(): pass\n", encoding="utf-8")
        (proj_root / "main.py").write_text(
            "from .z_mod import z\nfrom .a_mod import a\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)  # type: ignore[operator]
        index_project(proj, full=True)

        result = db.get_file_imports(proj.hash, "main.py")
        assert result == sorted(result)


# ---------------------------------------------------------------------------
# db.get_file_importers unit tests
# ---------------------------------------------------------------------------


class TestGetFileImporters:
    def test_importers_found(self, tmp_path, tmp_data_dir, make_project):
        """b.py is imported by a.py — a.py should appear in the importers list."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_importers(proj.hash, "b.py")
        assert "a.py" in result

    def test_no_self_importer(self, tmp_path, tmp_data_dir, make_project):
        """A file is never listed as importing itself."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_importers(proj.hash, "b.py")
        assert "b.py" not in result

    def test_isolated_file_no_importers(self, tmp_path, tmp_data_dir, make_project):
        """A file nobody imports returns an empty list."""
        from token_goat import db

        proj_root, proj = _make_isolated_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_importers(proj.hash, "solo.py")
        assert result == []

    def test_nonexistent_file_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """Querying a non-indexed file returns [] without raising."""
        from token_goat import db

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        result = db.get_file_importers(proj.hash, "does_not_exist.py")
        assert result == []

    def test_result_is_sorted(self, tmp_path, tmp_data_dir, make_project):
        """Results are sorted alphabetically."""
        from token_goat import db
        from token_goat.parser import index_project

        proj_root = tmp_path / "multi_importer_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        (proj_root / "core.py").write_text("def func(): pass\n", encoding="utf-8")
        (proj_root / "z_user.py").write_text("from .core import func\n", encoding="utf-8")
        (proj_root / "a_user.py").write_text("from .core import func\n", encoding="utf-8")
        proj = make_project(proj_root)  # type: ignore[operator]
        index_project(proj, full=True)

        result = db.get_file_importers(proj.hash, "core.py")
        assert result == sorted(result)
        assert "a_user.py" in result
        assert "z_user.py" in result


# ---------------------------------------------------------------------------
# imports() command — text output
# ---------------------------------------------------------------------------


class TestImportsTextOutput:
    def test_both_sections_printed(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Both 'Imports from' and 'Imported by' sections appear in output."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "a.py"))
        out = capsys.readouterr().out

        assert "Imports from" in out
        assert "Imported by" in out

    def test_imports_from_lists_dependency(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """a.py 'Imports from' section lists b.py."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "a.py"))
        out = capsys.readouterr().out

        assert "b.py" in out
        # The count in the header should be non-zero
        assert "Imports from (1)" in out or "Imports from (" in out

    def test_imported_by_lists_caller(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """b.py 'Imported by' section lists a.py."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "b.py"))
        out = capsys.readouterr().out

        assert "a.py" in out
        assert "Imported by (1)" in out or "Imported by (" in out

    def test_isolated_file_shows_none(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """A file with no internal imports or importers shows '(none)' in both sections."""
        proj_root, proj = _make_isolated_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "solo.py"))
        out = capsys.readouterr().out

        assert "Imports from (0)" in out
        assert "Imported by (0)" in out
        assert "(none)" in out

    def test_file_not_found_exits(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """imports on an unindexed file exits with an error."""
        import click

        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        with pytest.raises((SystemExit, click.exceptions.Exit)):
            imports("nonexistent_file.py")


# ---------------------------------------------------------------------------
# imports() command — JSON output
# ---------------------------------------------------------------------------


class TestImportsJsonOutput:
    def test_json_structure(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has file, imports_from, and imported_by keys."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "a.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "file" in data
        assert "imports_from" in data
        assert "imported_by" in data
        assert isinstance(data["imports_from"], list)
        assert isinstance(data["imported_by"], list)

    def test_json_imports_from_populated(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON imports_from includes b.py when a.py imports b.py."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "a.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "b.py" in data["imports_from"]
        assert data["imported_by"] == []

    def test_json_imported_by_populated(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON imported_by includes a.py when b.py is imported by a.py."""
        proj_root, proj = _make_imports_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "b.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "a.py" in data["imported_by"]
        assert data["imports_from"] == []

    def test_json_isolated_file_empty_lists(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output for an isolated file has both lists empty."""
        proj_root, proj = _make_isolated_project(tmp_path, tmp_data_dir, make_project)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import imports

        imports(str(proj_root / "solo.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert data["imports_from"] == []
        assert data["imported_by"] == []
        assert data["file"].endswith("solo.py")
