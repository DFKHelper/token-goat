"""Tests for the `token-goat types` command and helpers."""
from __future__ import annotations

import json

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_types_project(tmp_path, tmp_data_dir, make_project, content: str, filename: str = "sample.py"):
    """Create a minimal indexed project with one Python file containing *content*."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "types_proj"
    proj_root.mkdir(parents=True, exist_ok=True)
    (proj_root / ".git").mkdir(exist_ok=True)
    (proj_root / filename).write_text(content, encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# db.get_type_definitions unit tests
# ---------------------------------------------------------------------------

class TestGetTypeDefinitions:
    """Unit tests for db.get_type_definitions."""

    def test_typed_dict_found(self, tmp_path, tmp_data_dir, make_project):
        """TypedDict subclass is detected and returned."""
        content = (
            "from typing import TypedDict\n"
            "\n"
            "class UserConfig(TypedDict):\n"
            "    name: str\n"
            "    age: int\n"
            "    active: bool\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)

        names = [r["name"] for r in results]
        assert "UserConfig" in names
        entry = next(r for r in results if r["name"] == "UserConfig")
        assert entry["type_kind"] == "TypedDict"
        assert "name" in entry["fields"]
        assert "age" in entry["fields"]
        assert "active" in entry["fields"]

    def test_dataclass_found(self, tmp_path, tmp_data_dir, make_project):
        """@dataclass-decorated class is detected and returned."""
        content = (
            "from dataclasses import dataclass\n"
            "\n"
            "@dataclass\n"
            "class Point:\n"
            "    x: float\n"
            "    y: float\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)

        names = [r["name"] for r in results]
        assert "Point" in names
        entry = next(r for r in results if r["name"] == "Point")
        assert entry["type_kind"] == "dataclass"
        assert "x" in entry["fields"]
        assert "y" in entry["fields"]

    def test_protocol_found(self, tmp_path, tmp_data_dir, make_project):
        """Protocol subclass is detected and returned."""
        content = (
            "from typing import Protocol\n"
            "\n"
            "class Readable(Protocol):\n"
            "    def read(self) -> str: ...\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)

        names = [r["name"] for r in results]
        assert "Readable" in names
        entry = next(r for r in results if r["name"] == "Readable")
        assert entry["type_kind"] == "Protocol"

    def test_namedtuple_found(self, tmp_path, tmp_data_dir, make_project):
        """NamedTuple (typed) subclass is detected and returned."""
        content = (
            "from typing import NamedTuple\n"
            "\n"
            "class Color(NamedTuple):\n"
            "    r: int\n"
            "    g: int\n"
            "    b: int\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)

        names = [r["name"] for r in results]
        assert "Color" in names
        entry = next(r for r in results if r["name"] == "Color")
        assert entry["type_kind"] == "NamedTuple"
        assert "r" in entry["fields"]
        assert "g" in entry["fields"]
        assert "b" in entry["fields"]

    def test_plain_class_excluded(self, tmp_path, tmp_data_dir, make_project):
        """Plain classes (no type base/decorator) are excluded from results."""
        content = (
            "class PlainService:\n"
            "    def run(self) -> None:\n"
            "        pass\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)

        names = [r["name"] for r in results]
        assert "PlainService" not in names

    def test_no_type_defs_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        """File with only functions and plain classes returns an empty list."""
        content = (
            "def helper() -> None:\n"
            "    pass\n"
            "\n"
            "class Ordinary:\n"
            "    pass\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)
        assert results == []

    def test_file_path_filter(self, tmp_path, tmp_data_dir, make_project):
        """file_path parameter restricts results to the matching file."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "filter_proj"
        proj_root.mkdir(parents=True, exist_ok=True)
        (proj_root / ".git").mkdir(exist_ok=True)

        (proj_root / "models.py").write_text(
            "from typing import TypedDict\n\nclass Cfg(TypedDict):\n    x: int\n",
            encoding="utf-8",
        )
        (proj_root / "other.py").write_text(
            "from typing import TypedDict\n\nclass Other(TypedDict):\n    y: str\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)

        from token_goat import db
        results = db.get_type_definitions(proj.hash, file_path="models.py")
        names = [r["name"] for r in results]
        assert "Cfg" in names
        assert "Other" not in names

    def test_project_wide_search(self, tmp_path, tmp_data_dir, make_project):
        """Omitting file_path returns results from all files in the project."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "wide_proj"
        proj_root.mkdir(parents=True, exist_ok=True)
        (proj_root / ".git").mkdir(exist_ok=True)

        (proj_root / "a.py").write_text(
            "from typing import TypedDict\n\nclass Alpha(TypedDict):\n    a: int\n",
            encoding="utf-8",
        )
        (proj_root / "b.py").write_text(
            "from dataclasses import dataclass\n\n@dataclass\nclass Beta:\n    b: str\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)

        from token_goat import db
        results = db.get_type_definitions(proj.hash)
        names = [r["name"] for r in results]
        assert "Alpha" in names
        assert "Beta" in names


# ---------------------------------------------------------------------------
# read_commands.types() integration tests — text output
# ---------------------------------------------------------------------------

class TestTypesTextOutput:
    def test_types_typed_dict(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """types() emits TypedDict entries with field names."""
        content = (
            "from typing import TypedDict\n"
            "\n"
            "class Config(TypedDict):\n"
            "    host: str\n"
            "    port: int\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "TypedDict" in out
        assert "Config" in out
        assert "host" in out
        assert "port" in out

    def test_types_dataclass(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """types() emits dataclass entries with field names."""
        content = (
            "from dataclasses import dataclass\n"
            "\n"
            "@dataclass\n"
            "class Rect:\n"
            "    width: float\n"
            "    height: float\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "dataclass" in out
        assert "Rect" in out
        assert "width" in out
        assert "height" in out

    def test_no_type_defs_message(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """types() emits a friendly message when no type definitions are found."""
        content = "def helper(): pass\n\nclass Plain:\n    pass\n"
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "No type definitions" in out

    def test_project_wide_no_file(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """types() with no file argument searches the whole project."""
        content = (
            "from typing import TypedDict\n"
            "\n"
            "class Opts(TypedDict):\n"
            "    verbose: bool\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types()  # no file — project-wide
        out = capsys.readouterr().out

        assert "TypedDict" in out
        assert "Opts" in out


# ---------------------------------------------------------------------------
# read_commands.types() integration tests — JSON output
# ---------------------------------------------------------------------------

class TestTypesJsonOutput:
    def test_json_structure(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has project + types array with required keys."""
        content = (
            "from typing import TypedDict\n"
            "\n"
            "class Item(TypedDict):\n"
            "    sku: str\n"
            "    qty: int\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "project" in data
        assert "types" in data
        assert isinstance(data["types"], list)
        assert len(data["types"]) >= 1
        entry = data["types"][0]
        assert "name" in entry
        assert "type_kind" in entry
        assert "file" in entry
        assert "start_line" in entry
        assert "fields" in entry
        assert entry["name"] == "Item"
        assert entry["type_kind"] == "TypedDict"
        assert "sku" in entry["fields"]
        assert "qty" in entry["fields"]

    def test_json_no_types_returns_empty_list(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output returns empty types list when no type definitions exist."""
        content = "def fn(): pass\n"
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert data["types"] == []

    def test_json_project_wide(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output project-wide includes types from multiple files."""
        from token_goat.parser import index_project

        proj_root = tmp_path / "json_wide"
        proj_root.mkdir(parents=True, exist_ok=True)
        (proj_root / ".git").mkdir(exist_ok=True)
        (proj_root / "a.py").write_text(
            "from typing import TypedDict\n\nclass A(TypedDict):\n    v: int\n",
            encoding="utf-8",
        )
        (proj_root / "b.py").write_text(
            "from dataclasses import dataclass\n\n@dataclass\nclass B:\n    w: str\n",
            encoding="utf-8",
        )
        proj = make_project(proj_root)
        index_project(proj, full=True)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import types
        types(json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        names = [t["name"] for t in data["types"]]
        assert "A" in names
        assert "B" in names


# ---------------------------------------------------------------------------
# CLI smoke tests via Typer test client
# ---------------------------------------------------------------------------

class TestTypesCliSmoke:
    def test_cli_types_file(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat types <file> exits 0 for an indexed Python file with type defs."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = (
            "from typing import TypedDict\n"
            "\n"
            "class Spec(TypedDict):\n"
            "    name: str\n"
            "    value: int\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["types", str(proj_root / "sample.py")])
        assert result.exit_code == 0, result.output
        assert "TypedDict" in result.output
        assert "Spec" in result.output

    def test_cli_types_json(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat types --json returns valid JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = (
            "from dataclasses import dataclass\n"
            "\n"
            "@dataclass\n"
            "class Box:\n"
            "    w: int\n"
            "    h: int\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["types", "--json", str(proj_root / "sample.py")])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert "types" in data
        names = [t["name"] for t in data["types"]]
        assert "Box" in names

    def test_cli_types_no_file_project_wide(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat types with no file argument does a project-wide search."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = (
            "from typing import Protocol\n"
            "\n"
            "class Writer(Protocol):\n"
            "    def write(self, data: bytes) -> int: ...\n"
        )
        proj_root, proj = _make_types_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["types"])
        assert result.exit_code == 0, result.output
        assert "Protocol" in result.output
        assert "Writer" in result.output
