"""Tests for symbol --context N and outline --min-lines N."""
from __future__ import annotations

import json

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_project(tmp_path, tmp_data_dir, make_project, content: str, filename: str = "sample.py"):
    """Create a minimal indexed project with one Python file containing *content*."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    (proj_root / filename).write_text(content, encoding="utf-8")
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# outline --min-lines tests
# ---------------------------------------------------------------------------

class TestOutlineMinLines:
    """Tests for the --min-lines filter on the outline command."""

    # Source content: greet is 3 lines, big_function is 8 lines.
    _CONTENT = (
        'def greet(name: str) -> str:\n'
        '    """Short function.\"\"\"\n'
        '    return f"hello {name}"\n'
        '\n'
        'def big_function() -> None:\n'
        '    """A larger function.\"\"\"\n'
        '    x = 1\n'
        '    y = 2\n'
        '    z = 3\n'
        '    a = 4\n'
        '    b = 5\n'
        '    return\n'
    )

    def test_no_filter_shows_all(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Without --min-lines, all top-level symbols appear."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), min_lines=0)
        out = capsys.readouterr().out

        assert "greet" in out
        assert "big_function" in out

    def test_min_lines_filters_short_symbols(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--min-lines 5 keeps only symbols >= 5 lines (big_function=8, greet=3)."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), min_lines=5)
        out = capsys.readouterr().out

        assert "big_function" in out
        assert "greet" not in out

    def test_min_lines_keeps_exact_match(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--min-lines N keeps symbols with body == N lines (boundary test)."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), min_lines=3)
        out = capsys.readouterr().out

        # greet is exactly 3 lines — must appear
        assert "greet" in out
        assert "big_function" in out

    def test_min_lines_all_filtered(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--min-lines larger than all symbols results in no output (no crash)."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), min_lines=100)
        out, err = capsys.readouterr()
        combined = out + err
        # Should not crash; either empty results message or blank output
        assert "big_function" not in combined
        assert "greet" not in combined

    def test_min_lines_json_output(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--min-lines with --json only returns symbols meeting the threshold."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline
        outline(str(proj_root / "sample.py"), json_output=True, min_lines=5)
        out = capsys.readouterr().out
        data = json.loads(out)

        names = [s["name"] for s in data["symbols"]]
        assert "big_function" in names
        assert "greet" not in names

    def test_min_lines_one_same_as_default(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--min-lines 1 should behave identically to no filter (all symbols >= 1 line)."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import outline

        outline(str(proj_root / "sample.py"), min_lines=0)
        out0 = capsys.readouterr().out

        outline(str(proj_root / "sample.py"), min_lines=1)
        out1 = capsys.readouterr().out

        assert out0 == out1

    def test_min_lines_via_cli_app(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """Verify --min-lines is wired through the Typer app."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["outline", str(proj_root / "sample.py"), "--min-lines", "5"])
        assert result.exit_code == 0, result.output
        assert "big_function" in result.output
        assert "greet" not in result.output


# ---------------------------------------------------------------------------
# symbol --context tests
# ---------------------------------------------------------------------------

class TestSymbolContext:
    """Tests for the --context N flag on the symbol command."""

    _CONTENT = (
        '# header comment\n'
        'CONSTANT = 42\n'
        '\n'
        'def before_func():\n'
        '    pass\n'
        '\n'
        'def target_func(x: int) -> int:\n'
        '    """The target.\"\"\"\n'
        '    return x * 2\n'
        '\n'
        'def after_func():\n'
        '    pass\n'
    )

    def test_context_zero_no_extra_lines(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--context 0 (default) shows only the symbol location line."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func"])
        assert result.exit_code == 0
        # Should contain the location line but NOT source code lines
        assert "target_func" in result.output
        # No line numbers like "     7:" in plain output without context
        assert "return x * 2" not in result.output

    def test_context_positive_shows_surrounding_lines(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--context N shows source lines surrounding the symbol definition."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func", "--context", "2"])
        assert result.exit_code == 0
        # Body of target_func should be visible
        assert "return x * 2" in result.output
        # Context should include lines from the surrounding functions
        assert "target_func" in result.output

    def test_context_includes_lines_before(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--context N includes lines before the symbol start."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func", "--context", "3"])
        assert result.exit_code == 0
        # With 3 context lines before, before_func body (line 5: pass) should appear
        assert "before_func" in result.output or "pass" in result.output

    def test_context_json_adds_context_field(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--context N with --json adds a 'context' field to each result."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func", "--json", "--context", "1"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["total"] >= 1
        first = data["results"][0]
        assert "context" in first
        # Context field should contain the function body
        assert "target_func" in first["context"] or "return x * 2" in first["context"]

    def test_context_json_no_context_without_flag(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Without --context, JSON output does not add a 'context' field."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output)
        assert data["total"] >= 1
        first = data["results"][0]
        # 'context' key should not be present when context_lines=0
        assert "context" not in first

    def test_context_boundary_start_of_file(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--context at the start of file doesn't raise (clips to file start)."""
        # Put a function right at line 1
        content = 'def first_func():\n    return 1\n\ndef second_func():\n    return 2\n'
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, content)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "first_func", "--context", "5"])
        # Must not crash even when N > available lines before
        assert result.exit_code == 0
        assert "first_func" in result.output

    def test_context_line_numbers_in_output(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Context output includes line numbers."""
        proj_root, proj = _make_project(tmp_path, tmp_data_dir, make_project, self._CONTENT)
        monkeypatch.chdir(proj_root)

        from typer.testing import CliRunner

        from token_goat.cli import app

        runner = CliRunner(catch_exceptions=True)
        result = runner.invoke(app, ["symbol", "target_func", "--context", "1"])
        assert result.exit_code == 0
        # Output should contain "N:" line-number prefixes
        assert ":" in result.output  # at minimum, the location line has ":"
        # Check that a numeric line prefix appears (e.g. "7:" for the function)
        lines = result.output.splitlines()
        has_line_number = any(
            part.strip().rstrip(":").isdigit()
            for line in lines
            for part in line.split(":")[:2]
        )
        assert has_line_number
