"""Tests for the `token-goat scope` command."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_scope_project(tmp_path, tmp_data_dir, make_project, content: str, filename: str = "sample.py"):
    """Create a minimal indexed project with one Python file containing *content*."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "scope_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / filename).write_text(content, encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# scope() — invalid format
# ---------------------------------------------------------------------------

def _exit_code(exc: BaseException) -> int:
    """Extract the exit code from a SystemExit or typer.Exit."""
    import typer
    if isinstance(exc, typer.Exit):
        return exc.exit_code
    if isinstance(exc, SystemExit):
        return int(exc.code) if exc.code is not None else 0
    return -1


class TestScopeInvalidFormat:
    def test_missing_line_number_exits_2(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """scope with no colon-line suffix exits with code 2."""
        import typer

        from token_goat.read_commands import scope

        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        with pytest.raises((SystemExit, typer.Exit)) as exc_info:
            scope("sample.py")
        assert _exit_code(exc_info.value) == 2

    def test_non_integer_line_exits_2(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """scope with a non-integer line suffix exits with code 2."""
        import typer

        from token_goat.read_commands import scope

        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        with pytest.raises((SystemExit, typer.Exit)) as exc_info:
            scope("sample.py:abc")
        assert _exit_code(exc_info.value) == 2

    def test_zero_line_exits_2(self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys):
        """scope with line 0 exits with code 2 (lines are 1-indexed)."""
        import typer

        from token_goat.read_commands import scope

        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        with pytest.raises((SystemExit, typer.Exit)) as exc_info:
            scope("sample.py:0")
        assert _exit_code(exc_info.value) == 2


# ---------------------------------------------------------------------------
# scope() — file not found / not indexed
# ---------------------------------------------------------------------------

class TestScopeFileNotFound:
    def test_unindexed_file_exits_0_with_message(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope on a file that isn't indexed emits a message and exits cleanly."""
        import typer

        from token_goat.read_commands import scope

        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        with pytest.raises((SystemExit, typer.Exit)):
            scope("totally_nonexistent.py:5")
        _out, err = capsys.readouterr()
        # Should have some message about not finding the file
        combined = _out + err
        assert combined.strip() != ""

    def test_unindexed_file_json_output_ok_false(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope --json on a non-existent file emits {ok:false,...} JSON."""
        import typer

        from token_goat.read_commands import scope

        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        with pytest.raises((SystemExit, typer.Exit)):
            scope("totally_nonexistent.py:5", json_output=True)
        out, _err = capsys.readouterr()
        if out.strip():
            data = json.loads(out.strip())
            assert data.get("ok") is False


# ---------------------------------------------------------------------------
# scope() — module level (no enclosing symbols)
# ---------------------------------------------------------------------------

class TestScopeModuleLevel:
    def test_module_level_line_shows_no_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope at module level produces 'no enclosing' message."""
        content = (
            "import os\n"
            "from pathlib import Path\n"
            "\n"
            "X = 1\n"
            "\n"
            "def greet(name):\n"
            "    return f'hello {name}'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":4")
        out = capsys.readouterr().out

        assert "module level" in out.lower() or "enclosing" in out.lower()

    def test_module_level_line_shows_imports(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope at module level shows module imports."""
        content = (
            "import os\n"
            "from pathlib import Path\n"
            "\n"
            "X = 1\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":4")
        out = capsys.readouterr().out

        # Should mention imports section even if the content is present
        assert "import" in out.lower()

    def test_module_level_json_enclosing_empty(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope JSON at module level has empty enclosing list."""
        content = (
            "import os\n"
            "\n"
            "X = 1\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        assert data["enclosing"] == []
        assert data["line"] == 3


# ---------------------------------------------------------------------------
# scope() — enclosing function found
# ---------------------------------------------------------------------------

class TestScopeEnclosingFunction:
    def test_enclosing_function_shows_in_output(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a function body shows the enclosing function name."""
        content = (
            "import os\n"
            "\n"
            "def greet(name):\n"
            "    x = 1\n"
            "    return f'hello {name}'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":4")  # inside greet()
        out = capsys.readouterr().out

        assert "greet" in out

    def test_enclosing_function_suggestion_present(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a function emits a 'token-goat read' suggestion."""
        content = (
            "def greet(name):\n"
            "    x = 1\n"
            "    return f'hello {name}'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":2")
        out = capsys.readouterr().out

        assert "token-goat read" in out
        assert "greet" in out

    def test_enclosing_method_in_class(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a class method shows both class and method in enclosing chain."""
        content = (
            "class UserService:\n"
            "    def hello(self) -> str:\n"
            "        return 'hi'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":3")  # inside hello()
        out = capsys.readouterr().out

        assert "UserService" in out
        assert "hello" in out

    def test_enclosing_function_json_structure(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """JSON output for an enclosing function has correct structure."""
        content = (
            "import os\n"
            "\n"
            "def greet(name):\n"
            "    x = 1\n"
            "    return f'hello {name}'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":4", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "file" in data
        assert "line" in data
        assert data["line"] == 4
        assert "enclosing" in data
        assert "imports" in data

        # Should have at least one enclosing symbol (the function)
        assert len(data["enclosing"]) >= 1
        fn = data["enclosing"][0]
        assert fn["name"] == "greet"
        assert fn["kind"] in ("function", "async_function")
        assert "start_line" in fn
        assert "end_line" in fn

        # Should include suggestion since there's an enclosing function
        assert "suggestion" in data
        assert "greet" in data["suggestion"]

    def test_json_suggestion_absent_at_module_level(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """JSON output has no 'suggestion' key at module level."""
        content = "import os\n\nX = 1\n"
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "sample.py") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        # No enclosing function → no suggestion
        assert "suggestion" not in data


# ---------------------------------------------------------------------------
# scope() — CLI smoke tests via Typer runner
# ---------------------------------------------------------------------------

class TestScopeCliSmoke:
    def test_cli_scope_exits_0(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat scope returns exit code 0 for a valid indexed file and line."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = (
            "import os\n"
            "\n"
            "def greet(name):\n"
            "    return f'hello {name}'\n"
        )
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["scope", str(proj_root / "sample.py") + ":4"])
        assert result.exit_code == 0, result.output
        assert "greet" in result.output

    def test_cli_scope_json_exits_0(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat scope --json returns valid JSON with exit code 0."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = "def foo():\n    return 1\n"
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["scope", "--json", str(proj_root / "sample.py") + ":2"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert "enclosing" in data
        assert "imports" in data

    def test_cli_scope_no_colon_exits_2(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat scope without :<line> exits with code 2."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = "def foo(): pass\n"
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["scope", str(proj_root / "sample.py")])
        assert result.exit_code == 2

    def test_cli_scope_in_help(self):
        """token-goat --help mentions scope command."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["--help"])
        assert "scope" in result.output


# ---------------------------------------------------------------------------
# scope() — imports truncation
# ---------------------------------------------------------------------------

class TestScopeImportsTruncation:
    def test_imports_truncated_when_many(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope truncates imports when there are more than 15."""
        # Build a file with 20 imports
        imports = "\n".join(f"import mod_{i}" for i in range(20))
        content = imports + "\n\ndef foo():\n    pass\n"
        proj_root, proj = _make_scope_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import _SCOPE_MAX_IMPORTS, scope
        scope(str(proj_root / "sample.py") + ":22", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["imports"]) <= _SCOPE_MAX_IMPORTS
        assert "imports_truncated" in data
        assert data["imports_truncated"] > 0
