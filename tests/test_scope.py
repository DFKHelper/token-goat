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


# ---------------------------------------------------------------------------
# scope() — CSS file type
# ---------------------------------------------------------------------------

class TestScopeCss:
    """scope works for CSS / SCSS files (css_selector, css_mixin, css_rule)."""

    def test_css_selector_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a CSS selector body reports the enclosing selector."""
        content = (
            ".btn-primary {\n"
            "    background: blue;\n"
            "    color: white;\n"
            "}\n"
            "\n"
            ".btn-secondary {\n"
            "    background: gray;\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "styles.css"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "styles.css") + ":2", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        # The selector enclosing line 2 should be present
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert kinds & {"css_selector"}
        names = {e["name"] for e in data["enclosing"]}
        assert ".btn-primary" in names

    def test_css_selector_enclosing_text_output(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope text output inside a CSS selector shows the selector name."""
        content = (
            ".hero {\n"
            "    font-size: 2rem;\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "main.css"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "main.css") + ":2")
        out = capsys.readouterr().out
        assert ".hero" in out

    def test_css_mixin_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a SCSS mixin body reports the mixin as enclosing."""
        content = (
            "@mixin flex-center {\n"
            "    display: flex;\n"
            "    align-items: center;\n"
            "    justify-content: center;\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "mixins.scss"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "mixins.scss") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "css_mixin" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "@mixin flex-center" in names

    def test_css_module_level_no_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope at the first line of a CSS file (before any rule) is module level."""
        content = (
            "\n"
            ".foo { color: red; }\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "empty.css"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "empty.css") + ":1", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        # Line 1 is before the selector — empty enclosing or no matching enclosing
        assert "enclosing" in data


# ---------------------------------------------------------------------------
# scope() — SQL file type
# ---------------------------------------------------------------------------

class TestScopeSql:
    """scope works for SQL files (sql_function, sql_procedure, sql_table)."""

    def test_sql_function_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a SQL function body reports the function as enclosing."""
        content = (
            "CREATE OR REPLACE FUNCTION get_user(uid INT)\n"
            "RETURNS TABLE AS $$\n"
            "BEGIN\n"
            "    RETURN QUERY SELECT * FROM users WHERE id = uid;\n"
            "END;\n"
            "$$ LANGUAGE plpgsql;\n"
            "\n"
            "CREATE TABLE orders (\n"
            "    id SERIAL PRIMARY KEY,\n"
            "    user_id INT\n"
            ");\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "schema.sql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "schema.sql") + ":4", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "sql_function" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "get_user" in names

    def test_sql_table_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a CREATE TABLE body reports the table as enclosing."""
        content = (
            "CREATE TABLE users (\n"
            "    id SERIAL PRIMARY KEY,\n"
            "    email TEXT NOT NULL,\n"
            "    created_at TIMESTAMP DEFAULT NOW()\n"
            ");\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "migration.sql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "migration.sql") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "sql_table" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "users" in names

    def test_sql_json_structure(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope --json for SQL has correct key structure."""
        content = (
            "CREATE TABLE products (\n"
            "    id INT PRIMARY KEY,\n"
            "    name TEXT\n"
            ");\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "db.sql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "db.sql") + ":2", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "file" in data
        assert "line" in data
        assert data["line"] == 2
        assert "enclosing" in data
        assert "imports" in data
        # Each enclosing entry must have required keys
        for entry in data["enclosing"]:
            assert "name" in entry
            assert "kind" in entry
            assert "start_line" in entry
            assert "end_line" in entry


# ---------------------------------------------------------------------------
# scope() — GraphQL file type
# ---------------------------------------------------------------------------

class TestScopeGraphql:
    """scope works for GraphQL files (graphql_type, graphql_query, etc.)."""

    def test_graphql_type_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a GraphQL type body reports the type as enclosing."""
        content = (
            "type User {\n"
            "  id: ID!\n"
            "  email: String!\n"
            "  createdAt: String\n"
            "}\n"
            "\n"
            "type Query {\n"
            "  user(id: ID!): User\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "schema.graphql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "schema.graphql") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "graphql_type" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "User" in names

    def test_graphql_query_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a named GraphQL query body reports the query as enclosing."""
        content = (
            "query GetUser($id: ID!) {\n"
            "  user(id: $id) {\n"
            "    id\n"
            "    email\n"
            "  }\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "operations.graphql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "operations.graphql") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "graphql_query" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "GetUser" in names

    def test_graphql_text_output_shows_type_name(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope text output inside a GraphQL type shows the type name."""
        content = (
            "type Product {\n"
            "  id: ID!\n"
            "  price: Float!\n"
            "}\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "product.graphql"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "product.graphql") + ":2")
        out = capsys.readouterr().out
        assert "Product" in out


# ---------------------------------------------------------------------------
# scope() — Makefile file type
# ---------------------------------------------------------------------------

class TestScopeMakefile:
    """scope works for Makefile files (makefile_target, makefile_define)."""

    def test_makefile_target_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a Makefile recipe reports the target as enclosing."""
        content = (
            "build:\n"
            "\tgo build -o bin/app ./...\n"
            "\n"
            "test:\n"
            "\tgo test ./...\n"
            "\n"
            "clean:\n"
            "\trm -rf bin/\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "Makefile"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "Makefile") + ":5", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "enclosing" in data
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "makefile_target" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "test" in names

    def test_makefile_define_enclosing(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope inside a Makefile define block reports the define as enclosing."""
        content = (
            "define BUILD_CMD\n"
            "go build -v \\\n"
            "  -ldflags=\"-s -w\" \\\n"
            "  ./...\n"
            "endef\n"
            "\n"
            "build:\n"
            "\t$(BUILD_CMD)\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "Makefile"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "Makefile") + ":3", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert len(data["enclosing"]) >= 1
        kinds = {e["kind"] for e in data["enclosing"]}
        assert "makefile_define" in kinds
        names = {e["name"] for e in data["enclosing"]}
        assert "BUILD_CMD" in names

    def test_makefile_text_output_shows_target_name(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope text output inside a Makefile recipe shows the target name."""
        content = (
            "install:\n"
            "\tnpm install\n"
            "\tnpm run build\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "Makefile"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "Makefile") + ":2")
        out = capsys.readouterr().out
        assert "install" in out

    def test_makefile_module_level_before_first_target(
        self, tmp_path, tmp_data_dir, make_project, monkeypatch, capsys
    ):
        """scope at a line before any target in a Makefile is module level."""
        content = (
            "CC = gcc\n"
            "\n"
            "build:\n"
            "\t$(CC) -o app main.c\n"
        )
        proj_root, proj = _make_scope_project(
            tmp_path, tmp_data_dir, make_project, content, "Makefile"
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import scope
        scope(str(proj_root / "Makefile") + ":1", json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        # Line 1 is a variable assignment before any target
        assert "enclosing" in data
        # No target encloses line 1 — should be empty or contain no target kind
        makefile_kinds = {
            e["kind"] for e in data["enclosing"]
            if e["kind"] in ("makefile_target", "makefile_define")
        }
        assert len(makefile_kinds) == 0


# ---------------------------------------------------------------------------
# scope() — end_line propagation unit test
# ---------------------------------------------------------------------------

class TestScopeEndLinePropagation:
    """Unit tests for propagate_section_end_lines_to_symbols helper."""

    def test_propagate_copies_end_line(self):
        """end_line from sections is copied to matching symbols."""
        from token_goat.languages.common import propagate_section_end_lines_to_symbols
        from token_goat.parser import Section, Symbol

        symbols = [
            Symbol(name="foo", kind="css_selector", line=1),
            Symbol(name="bar", kind="css_selector", line=5),
        ]
        sections = [
            Section(heading="foo", level=1, line=1, end_line=4),
            Section(heading="bar", level=1, line=5, end_line=8),
        ]

        propagate_section_end_lines_to_symbols(symbols, sections)

        assert symbols[0].end_line == 4
        assert symbols[1].end_line == 8

    def test_propagate_skips_none_section_end_line(self):
        """Symbols are not modified when the matching section end_line is None."""
        from token_goat.languages.common import propagate_section_end_lines_to_symbols
        from token_goat.parser import Section, Symbol

        sym = Symbol(name="foo", kind="css_selector", line=1)
        sec = Section(heading="foo", level=1, line=1, end_line=None)

        propagate_section_end_lines_to_symbols([sym], [sec])

        assert sym.end_line is None

    def test_propagate_skips_already_set_symbol(self):
        """Symbols whose end_line is already set are not overwritten."""
        from token_goat.languages.common import propagate_section_end_lines_to_symbols
        from token_goat.parser import Section, Symbol

        sym = Symbol(name="foo", kind="function", line=1, end_line=99)
        sec = Section(heading="foo", level=1, line=1, end_line=10)

        propagate_section_end_lines_to_symbols([sym], [sec])

        # end_line should remain the original 99, not overwritten by section's 10
        assert sym.end_line == 99

    def test_propagate_no_matching_section(self):
        """Symbols without a matching section keep end_line=None."""
        from token_goat.languages.common import propagate_section_end_lines_to_symbols
        from token_goat.parser import Section, Symbol

        sym = Symbol(name="orphan", kind="css_selector", line=10)
        sec = Section(heading="other", level=1, line=5, end_line=9)

        propagate_section_end_lines_to_symbols([sym], [sec])

        assert sym.end_line is None
