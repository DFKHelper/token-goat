import json

import pytest
from typer.testing import CliRunner

from token_goat import cli, paths

runner = CliRunner()


class TestIndexCheck:
    """Test --check flag for dirty queue status."""

    def test_check_exits_0_when_no_dirty_files(self, tmp_data_dir, tmp_path, make_project):
        """--check exits 0 when dirty queue is empty."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        result = runner.invoke(cli.app, ["index", "--check"])
        assert result.exit_code == 0
        assert "0 files pending" in result.output

    def test_check_exits_1_when_dirty_files_exist(self, tmp_data_dir, tmp_path, make_project):
        """--check exits 1 when dirty queue has pending entries."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Manually write a dirty queue entry
        queue_path = paths.dirty_queue_path()
        paths.ensure_dir(queue_path.parent)
        entry = {"path": "foo.py", "project_hash": "abc123"}
        queue_path.write_text(json.dumps(entry) + "\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["index", "--check"])
        assert result.exit_code == 1
        assert "1 files pending" in result.output

    def test_check_counts_multiple_dirty_files(self, tmp_data_dir, tmp_path, make_project):
        """--check reports correct count of pending files."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Write multiple dirty queue entries
        queue_path = paths.dirty_queue_path()
        paths.ensure_dir(queue_path.parent)
        content = ""
        for i in range(5):
            entry = {"path": f"file{i}.py", "project_hash": f"hash{i}"}
            content += json.dumps(entry) + "\n"
        queue_path.write_text(content, encoding="utf-8")

        result = runner.invoke(cli.app, ["index", "--check"])
        assert result.exit_code == 1
        assert "5 files pending" in result.output


class TestIndexVerbose:
    """Test --verbose flag for per-file output."""

    def test_verbose_shows_indexed_files(self, tmp_data_dir, tmp_path, make_project):
        """--verbose shows each indexed file with symbol count."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Create a simple Python file
        py_file = proj_root / "test.py"
        py_file.write_text("def foo():\n    pass\n\ndef bar():\n    pass\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["index", "--verbose"])
        assert result.exit_code == 0
        assert "indexed:" in result.output
        assert "test.py" in result.output
        # Should show 2 symbols (foo and bar)
        assert "2 symbols" in result.output

    def test_verbose_shows_single_symbol(self, tmp_data_dir, tmp_path, make_project):
        """--verbose shows 'symbol' (singular) when count is 1."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Create a Python file with one function
        py_file = proj_root / "single.py"
        py_file.write_text("def only_one():\n    pass\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["index", "--verbose"])
        assert result.exit_code == 0
        assert "1 symbol" in result.output


class TestIndexSummary:
    """Test final summary line showing indexed/skipped/symbol counts."""

    def test_summary_shows_indexed_count(self, tmp_data_dir, tmp_path, make_project):
        """Summary line shows indexed file count."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Create files
        (proj_root / "test1.py").write_text("def a(): pass\n", encoding="utf-8")
        (proj_root / "test2.py").write_text("def b(): pass\n", encoding="utf-8")

        result = runner.invoke(cli.app, ["index"])
        assert result.exit_code == 0
        # Summary should mention indexed files
        assert "Indexed" in result.output

    def test_summary_shows_symbol_count(self, tmp_data_dir, tmp_path, make_project):
        """Summary line shows total symbol count when >0."""
        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        monkeypatch = pytest.importorskip("_pytest.monkeypatch").MonkeyPatch()
        monkeypatch.chdir(proj_root)
        make_project(proj_root)

        # Create a file with symbols
        (proj_root / "test.py").write_text(
            "def func1(): pass\n\nclass MyClass:\n    def method(self): pass\n",
            encoding="utf-8"
        )

        result = runner.invoke(cli.app, ["index"])
        assert result.exit_code == 0
        # Summary should include symbol count
        assert "symbols" in result.output
