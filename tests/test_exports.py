"""Tests for the `token-goat exports` command and db.get_file_exports helper."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_exports_project(
    tmp_path: Path,
    tmp_data_dir: object,
    make_project: object,
    content: str,
    filename: str = "sample.py",
) -> tuple[Path, object]:
    """Create a minimal indexed project with one Python file containing *content*."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "exports_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / filename).write_text(content, encoding="utf-8")
    proj = make_project(proj_root)  # type: ignore[operator]
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# db.get_file_exports unit tests
# ---------------------------------------------------------------------------


class TestGetFileExports:
    def test_public_symbols_returned(self, tmp_path, tmp_data_dir, make_project):
        """Public (non-underscore) top-level symbols are returned."""
        content = (
            "def public_func():\n"
            "    pass\n"
            "\n"
            "class PublicClass:\n"
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        names = {r["name"] for r in rows}
        assert "public_func" in names
        assert "PublicClass" in names

    def test_private_symbols_excluded(self, tmp_path, tmp_data_dir, make_project):
        """Symbols starting with _ are excluded from exports."""
        content = (
            "def public_func():\n"
            "    pass\n"
            "\n"
            "def _private_func():\n"
            "    pass\n"
            "\n"
            "class _PrivateClass:\n"
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        names = {r["name"] for r in rows}
        assert "public_func" in names
        assert "_private_func" not in names
        assert "_PrivateClass" not in names

    def test_methods_excluded(self, tmp_path, tmp_data_dir, make_project):
        """Methods inside a class are not included (only top-level symbols)."""
        content = (
            "class MyClass:\n"
            "    def method(self):\n"
            "        pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        names = {r["name"] for r in rows}
        assert "MyClass" in names
        assert "method" not in names

    def test_dunder_all_restricts_exports(self, tmp_path, tmp_data_dir, make_project):
        """When __all__ is defined, only listed names are returned."""
        content = (
            '__all__ = ["visible_func"]\n'
            "\n"
            "def visible_func():\n"
            "    pass\n"
            "\n"
            "def hidden_func():\n"
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        names = {r["name"] for r in rows}
        assert "visible_func" in names
        assert "hidden_func" not in names

    def test_empty_file_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """An empty (or comment-only) file returns an empty list."""
        content = "# no functions here\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        assert rows == []

    def test_nonexistent_file_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """Querying a non-indexed file returns [] without raising."""
        content = "def foo(): pass\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "does_not_exist.py")
        assert rows == []

    def test_result_sorted_by_line(self, tmp_path, tmp_data_dir, make_project):
        """Results are sorted by start_line ascending."""
        content = (
            "def alpha(): pass\n"
            "def beta(): pass\n"
            "def gamma(): pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        lines = [int(r["start_line"]) for r in rows]
        assert lines == sorted(lines)

    def test_row_has_expected_keys(self, tmp_path, tmp_data_dir, make_project):
        """Each row contains name, kind, start_line, end_line, docstring."""
        content = "def my_func():\n    pass\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db

        rows = db.get_file_exports(proj.hash, "sample.py")
        assert len(rows) >= 1
        row = rows[0]
        for key in ("name", "kind", "start_line", "end_line", "docstring"):
            assert key in row


# ---------------------------------------------------------------------------
# exports() integration tests — text output
# ---------------------------------------------------------------------------


class TestExportsTextOutput:
    def test_basic_text_output(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """exports lists public top-level symbols with line ranges."""
        content = (
            'def greet(name: str) -> str:\n'
            '    """Greet someone."""\n'
            '    return f"hello {name}"\n'
            "\n"
            "class Service:\n"
            '    """A service."""\n'
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "Exports:" in out
        assert "greet" in out
        assert "Service" in out
        assert "public symbol" in out

    def test_private_excluded_from_text(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Private symbols do not appear in text output."""
        content = (
            "def public_api():\n"
            "    pass\n"
            "\n"
            "def _internal():\n"
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "public_api" in out
        assert "_internal" not in out

    def test_no_public_symbols_message(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """When no public symbols exist, a helpful message is emitted."""
        content = (
            "def _only_private():\n"
            "    pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "No public symbols" in out or "0 public" in out or "No" in out

    def test_file_not_found_exits(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """exports on an unindexed file exits with an error."""
        import click

        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        with pytest.raises((SystemExit, click.exceptions.Exit)):
            exports("nonexistent_file.py")

    def test_singular_symbol_count(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Singular 'symbol' used when exactly one public symbol is present."""
        content = "def only_one(): pass\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        # Should say "1 public symbol" not "1 public symbols"
        assert "1 public symbol" in out
        assert "1 public symbols" not in out

    def test_docstring_shown_in_text(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Docstring first-line is included in text output."""
        content = (
            'def documented():\n'
            '    """Does the thing."""\n'
            '    pass\n'
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "Does the thing." in out


# ---------------------------------------------------------------------------
# exports() integration tests — JSON output
# ---------------------------------------------------------------------------


class TestExportsJsonOutput:
    def test_json_structure(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has file + symbols array with required keys."""
        content = (
            'def alpha():\n'
            '    """Alpha."""\n'
            '    pass\n'
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "file" in data
        assert "symbols" in data
        assert isinstance(data["symbols"], list)
        assert len(data["symbols"]) >= 1
        sym = data["symbols"][0]
        for key in ("name", "kind", "start_line", "end_line", "docstring"):
            assert key in sym

    def test_json_private_excluded(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output excludes underscore-prefixed symbols."""
        content = (
            "def pub(): pass\n"
            "def _priv(): pass\n"
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        names = {s["name"] for s in data["symbols"]}
        assert "pub" in names
        assert "_priv" not in names

    def test_json_empty_returns_empty_list(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output when no public symbols: empty symbols list."""
        content = "# nothing\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert data["symbols"] == []

    def test_json_docstring_present(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output includes docstring when present."""
        content = (
            'def greet():\n'
            '    """Greet the world."""\n'
            '    pass\n'
        )
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["symbols"]) >= 1
        assert data["symbols"][0]["docstring"] == "Greet the world."

    def test_json_no_docstring_is_null(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has docstring=null when no docstring is present."""
        content = "def no_doc():\n    pass\n"
        proj_root, proj = _make_exports_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import exports

        exports(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["symbols"]) >= 1
        assert data["symbols"][0]["docstring"] is None
