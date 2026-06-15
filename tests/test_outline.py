"""Tests for the `token-goat outline` command and helpers."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"
PY_SAMPLE = FIXTURE_DIR / "py_sample"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_outline_project(tmp_path, tmp_data_dir, make_project, content: str, filename: str = "sample.py"):
    """Create a minimal indexed project with one Python file containing *content*."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "outline_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / filename).write_text(content, encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# _extract_docstring_first_line unit tests
# ---------------------------------------------------------------------------

class TestExtractDocstringFirstLine:
    """Unit tests for _extract_docstring_first_line."""

    def _call(self, source: str, start: int, end: int) -> str | None:
        from token_goat.read_commands import _extract_docstring_first_line
        lines = source.splitlines()
        return _extract_docstring_first_line(lines, start, end)

    def test_python_triple_quote_double(self):
        src = "def foo():\n    \"\"\"Do something.\"\"\"\n    pass\n"
        result = self._call(src, 1, 3)
        assert result == "Do something."

    def test_python_triple_quote_single(self):
        src = "def foo():\n    '''Do something.'''\n    pass\n"
        result = self._call(src, 1, 3)
        assert result == "Do something."

    def test_python_triple_quote_multiline_opening(self):
        src = 'def foo():\n    """Multi-line.\n    Second line.\n    """\n    pass\n'
        result = self._call(src, 1, 5)
        assert result == "Multi-line."

    def test_hash_comment(self):
        src = "def foo():\n    # Return something.\n    return 1\n"
        result = self._call(src, 1, 3)
        assert result == "Return something."

    def test_double_slash_comment(self):
        src = "function foo() {\n    // Does the thing.\n    return 1;\n}\n"
        result = self._call(src, 1, 4)
        assert result == "Does the thing."

    def test_block_comment_slash_star(self):
        src = "function foo() {\n    /* Summary. */\n    return 1;\n}\n"
        result = self._call(src, 1, 4)
        assert result == "Summary. */"

    def test_no_docstring_returns_none(self):
        src = "def foo():\n    return 1\n"
        result = self._call(src, 1, 2)
        assert result is None

    def test_truncates_long_docstring(self):
        long_doc = "A" * 200
        src = f'def foo():\n    """{long_doc}"""\n    pass\n'
        from token_goat.read_commands import _OUTLINE_DOCSTRING_MAX_CHARS
        result = self._call(src, 1, 3)
        assert result is not None
        assert len(result) <= _OUTLINE_DOCSTRING_MAX_CHARS

    def test_empty_triple_quote_opening_skips_to_body(self):
        # Empty opening """ line followed by real content on next.
        src = 'def foo():\n    """\n    Description here.\n    """\n    pass\n'
        result = self._call(src, 1, 5)
        assert result == "Description here."

    def test_empty_lines_skipped_before_docstring(self):
        src = "def foo():\n\n    # After blank.\n    return 1\n"
        result = self._call(src, 1, 4)
        assert result == "After blank."


# ---------------------------------------------------------------------------
# _format_outline_line unit tests
# ---------------------------------------------------------------------------

class TestFormatOutlineLine:
    def test_basic_format(self):
        from token_goat.read_commands import _format_outline_line
        line = _format_outline_line("foo", "function", 10, 20, None)
        assert "10-20" in line
        assert "function" in line
        assert "foo" in line

    def test_docstring_appended(self):
        from token_goat.read_commands import _format_outline_line
        line = _format_outline_line("bar", "class", 5, 50, "Does stuff.")
        assert "# Does stuff." in line

    def test_no_docstring_no_hash(self):
        from token_goat.read_commands import _format_outline_line
        line = _format_outline_line("baz", "function", 1, 5, None)
        assert "#" not in line


# ---------------------------------------------------------------------------
# outline() integration tests — text output
# ---------------------------------------------------------------------------

class TestOutlineTextOutput:
    def test_outline_basic(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """outline lists top-level functions and classes with line ranges."""
        content = (
            'def greet(name: str) -> str:\n'
            '    """Greet the user.\"\"\"\n'
            '    return f"hello, {name}"\n'
            '\n'
            'class Service:\n'
            '    """A service class.\"\"\"\n'
            '    pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "Outline:" in out
        assert "greet" in out
        assert "Service" in out
        # Docstring first-lines should appear
        assert "Greet the user." in out
        assert "A service class." in out

    def test_outline_excludes_methods(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """outline must not list class methods as top-level symbols."""
        content = (
            'class Foo:\n'
            '    def bar(self) -> None:\n'
            '        pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        assert "Foo" in out
        assert "bar" not in out

    def test_outline_no_symbols(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """outline on a file with no structural symbols emits a helpful message without raising."""
        content = "# Just a comment\nX = 1\nY = 2\n"
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"))
        out, err = capsys.readouterr()
        # Should emit a "no symbols" message on stdout (not an error exit).
        combined = out + err
        assert "No" in combined

    def test_outline_file_not_found(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """outline on an unindexed file exits with an error message."""
        import click
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, "def foo(): pass\n")
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        with pytest.raises((SystemExit, click.exceptions.Exit)):
            outline("totally_nonexistent_file.py")
        out, _err = capsys.readouterr()
        assert "not found" in out.lower() or "No" in out


# ---------------------------------------------------------------------------
# outline() integration tests — JSON output
# ---------------------------------------------------------------------------

class TestOutlineJsonOutput:
    def test_json_output_structure(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has file + symbols array with required keys."""
        content = (
            'def alpha():\n'
            '    """Alpha function.\"\"\"\n'
            '    pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out

        data = json.loads(out.strip())
        assert "file" in data
        assert "symbols" in data
        assert isinstance(data["symbols"], list)
        assert len(data["symbols"]) >= 1
        sym = data["symbols"][0]
        assert sym["name"] == "alpha"
        assert sym["kind"] == "function"
        assert "start_line" in sym
        assert "end_line" in sym
        assert sym["docstring"] == "Alpha function."

    def test_json_no_symbols_returns_empty_list(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output returns empty symbols list when file has no structural symbols."""
        content = "X = 1\nY = 2\n"
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline

        # This may raise SystemExit (no symbols) or return empty list.
        try:
            outline(str(proj_root / "sample.py"), json_output=True)
            out = capsys.readouterr().out
            if out.strip():
                data = json.loads(out.strip())
                assert data["symbols"] == []
        except SystemExit:
            pass  # acceptable: file has no indexable symbols at all

    def test_json_no_docstring_is_null(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output has docstring=null when no docstring is present."""
        content = "def no_doc():\n    pass\n"
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out
        data = json.loads(out.strip())
        sym = data["symbols"][0]
        assert sym["docstring"] is None


# ---------------------------------------------------------------------------
# CLI smoke — token-goat outline via Typer test client
# ---------------------------------------------------------------------------

class TestOutlineCliSmoke:
    def test_cli_outline_smoke(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat outline returns exit code 0 for an indexed Python file."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = (
            'def foo():\n'
            '    """Foo does stuff.\"\"\"\n'
            '    return 42\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["outline", str(proj_root / "sample.py")])
        assert result.exit_code == 0, result.output
        assert "foo" in result.output

    def test_cli_outline_json_smoke(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """token-goat outline --json returns valid JSON."""
        from typer.testing import CliRunner

        from token_goat.cli import app

        content = 'def bar():\n    """Bar.\"\"\"\n    return 1\n'
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        runner = CliRunner()
        result = runner.invoke(app, ["outline", "--json", str(proj_root / "sample.py")])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert "symbols" in data


# ---------------------------------------------------------------------------
# Sub-area A: line counts and --max-depth
# ---------------------------------------------------------------------------

class TestOutlineLineCount:
    """Verify that outline emits line counts per symbol."""

    def test_text_output_shows_line_count(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """outline text output includes '(N lines)' for each symbol."""
        content = (
            'def short():\n'       # 1
            '    pass\n'           # 2
            '\n'                   # 3
            'class Big:\n'         # 4
            '    def m(self):\n'   # 5
            '        pass\n'       # 6
            '\n'                   # 7
            '    def n(self):\n'   # 8
            '        pass\n'       # 9
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"))
        out = capsys.readouterr().out

        # short() spans lines 1-2 → 2 lines; Big spans 4-9 → 6 lines
        assert "lines)" in out, f"Expected '(N lines)' in output, got:\n{out}"

    def test_json_output_has_line_count_field(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output includes a 'line_count' key for each symbol."""
        content = (
            'def alpha():\n'
            '    return 1\n'
            '\n'
            'def beta():\n'
            '    return 2\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), json_output=True)
        out = capsys.readouterr().out
        data = json.loads(out.strip())
        assert len(data["symbols"]) >= 1
        for sym in data["symbols"]:
            assert "line_count" in sym, f"Missing line_count in symbol: {sym}"
            assert sym["line_count"] == sym["end_line"] - sym["start_line"] + 1


class TestOutlineMaxDepth:
    """Verify --max-depth flag limits or expands nesting."""

    def test_default_depth_zero_excludes_methods(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Default depth (0) only shows top-level symbols, not methods."""
        content = (
            'class MyClass:\n'
            '    def method_one(self):\n'
            '        pass\n'
            '    def method_two(self):\n'
            '        pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), max_depth=0)
        out = capsys.readouterr().out

        assert "MyClass" in out
        assert "method_one" not in out
        assert "method_two" not in out

    def test_max_depth_one_includes_methods(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """max_depth=1 includes methods (depth 1) inside classes."""
        content = (
            'class MyClass:\n'
            '    def method_one(self):\n'
            '        pass\n'
            '    def method_two(self):\n'
            '        pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), max_depth=1)
        out = capsys.readouterr().out

        assert "MyClass" in out
        assert "method_one" in out
        assert "method_two" in out

    def test_max_depth_json_has_depth_field(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """JSON output with max_depth includes a 'depth' field for each symbol."""
        content = (
            'class Container:\n'
            '    def run(self):\n'
            '        pass\n'
        )
        proj_root, proj = _make_outline_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), json_output=True, max_depth=1)
        out = capsys.readouterr().out
        data = json.loads(out.strip())
        assert "symbols" in data
        names = {s["name"]: s["depth"] for s in data["symbols"]}
        assert "Container" in names
        assert names["Container"] == 0
        if "run" in names:
            assert names["run"] == 1
