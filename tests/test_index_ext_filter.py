"""Tests for index --ext filter and per-extension breakdown in summary output."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from token_goat import cli
from token_goat.parser import IndexProjectResult, iter_source_files

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _make_project_dir(tmp_path: Path) -> Path:
    """Create a small mixed-language project tree."""
    root = tmp_path / "myproject"
    root.mkdir()
    (root / ".git").mkdir()
    (root / "app.py").write_text("def hello(): pass\n")
    (root / "utils.py").write_text("def helper(): pass\n")
    (root / "index.ts").write_text("export function greet() {}\n")
    (root / "style.css").write_text(".foo { color: red; }\n")
    return root


def _make_index_result(**overrides: object) -> IndexProjectResult:
    """Return a minimal IndexProjectResult for CLI snapshot tests."""
    base: IndexProjectResult = {
        "total_files": 4,
        "indexed": 4,
        "skipped_unchanged": 0,
        "errors": 0,
        "languages": ["css", "python", "typescript"],
        "duration_sec": 0.1,
        "total_symbols": 3,
        "large_files": [],
        "ext_counts": {".py": 2, ".ts": 1, ".css": 1},
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


# ---------------------------------------------------------------------------
# iter_source_files -- ext_filter
# ---------------------------------------------------------------------------

class TestIterSourceFilesExtFilter:
    """ext_filter parameter restricts files yielded by iter_source_files."""

    def test_ext_filter_py_only(self, tmp_path, tmp_data_dir, make_project):
        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        results = list(iter_source_files(proj, ext_filter=frozenset({".py"})))
        extensions = {p.suffix.lower() for p in results}

        assert extensions == {".py"}, f"Expected only .py files, got: {extensions}"
        assert len(results) == 2  # app.py + utils.py

    def test_ext_filter_ts_only(self, tmp_path, tmp_data_dir, make_project):
        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        results = list(iter_source_files(proj, ext_filter=frozenset({".ts"})))
        extensions = {p.suffix.lower() for p in results}

        assert extensions == {".ts"}, f"Expected only .ts files, got: {extensions}"

    def test_ext_filter_multiple_exts(self, tmp_path, tmp_data_dir, make_project):
        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        results = list(iter_source_files(proj, ext_filter=frozenset({".py", ".ts"})))
        extensions = {p.suffix.lower() for p in results}

        assert extensions == {".py", ".ts"}
        assert len(results) == 3  # app.py + utils.py + index.ts

    def test_ext_filter_none_returns_all(self, tmp_path, tmp_data_dir, make_project):
        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        all_results = list(iter_source_files(proj))
        filtered_results = list(iter_source_files(proj, ext_filter=None))

        assert len(all_results) == len(filtered_results)

    def test_ext_filter_no_match_returns_empty(self, tmp_path, tmp_data_dir, make_project):
        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        results = list(iter_source_files(proj, ext_filter=frozenset({".rb"})))
        assert results == []


# ---------------------------------------------------------------------------
# index_project -- ext_filter and ext_counts
# ---------------------------------------------------------------------------

class TestIndexProjectExtFilter:
    """index_project respects ext_filter and populates ext_counts."""

    def test_ext_counts_populated(self, tmp_path, tmp_data_dir, make_project):
        from token_goat.parser import index_project

        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        result = index_project(proj, full=True)

        # ext_counts should contain counts for each extension that was actually indexed.
        assert "ext_counts" in result
        ext_counts = result["ext_counts"]
        assert isinstance(ext_counts, dict)
        # The mixed project has .py, .ts, .css files.
        assert ".py" in ext_counts
        assert ext_counts[".py"] == 2  # app.py + utils.py

    def test_ext_filter_limits_indexed_files(self, tmp_path, tmp_data_dir, make_project):
        from token_goat.parser import index_project

        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        result = index_project(proj, full=True, ext_filter=frozenset({".py"}))

        assert result["indexed"] == 2
        assert result["ext_counts"] == {".py": 2}
        # Only Python should appear in languages.
        assert result["languages"] == ["python"]

    def test_ext_filter_ts_only(self, tmp_path, tmp_data_dir, make_project):
        from token_goat.parser import index_project

        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        result = index_project(proj, full=True, ext_filter=frozenset({".ts"}))

        assert result["indexed"] == 1
        assert result["ext_counts"] == {".ts": 1}

    def test_ext_counts_empty_when_nothing_indexed(self, tmp_path, tmp_data_dir, make_project):
        from token_goat.parser import index_project

        root = _make_project_dir(tmp_path)
        proj = make_project(root)

        result = index_project(proj, full=True, ext_filter=frozenset({".rb"}))

        assert result["indexed"] == 0
        assert result["ext_counts"] == {}


# ---------------------------------------------------------------------------
# CLI -- index command with --ext flag and per-extension breakdown
# ---------------------------------------------------------------------------

def _fake_proj():
    proj = MagicMock()
    proj.root = MagicMock()
    proj.root.name = "test-proj"
    proj.hash = "deadbeef"
    return proj


class TestIndexCLI:
    """CLI integration tests for index --ext flag and per-extension breakdown."""

    def test_ext_breakdown_shown_for_multiple_types(self, tmp_path, monkeypatch):
        """Per-extension breakdown appears when multiple extension types are indexed."""
        fake_proj = _fake_proj()
        summary = _make_index_result()

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary),
        ):
            result = runner.invoke(cli.app, ["index"])

        assert result.exit_code == 0, result.output
        assert "by type:" in result.output
        # Check that at least one extension appears in the breakdown
        assert ".py" in result.output

    def test_ext_breakdown_hidden_for_single_type(self, tmp_path, monkeypatch):
        """Per-extension breakdown is suppressed when only one extension was indexed."""
        fake_proj = _fake_proj()
        summary = _make_index_result(
            total_files=2,
            indexed=2,
            languages=["python"],
            ext_counts={".py": 2},
        )

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary),
        ):
            result = runner.invoke(cli.app, ["index"])

        assert result.exit_code == 0, result.output
        assert "by type:" not in result.output

    def test_ext_breakdown_hidden_when_nothing_indexed(self, tmp_path, monkeypatch):
        """No breakdown printed when ext_counts is empty."""
        fake_proj = _fake_proj()
        summary = _make_index_result(
            total_files=0,
            indexed=0,
            languages=[],
            ext_counts={},
        )

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary),
        ):
            result = runner.invoke(cli.app, ["index"])

        assert result.exit_code == 0, result.output
        assert "by type:" not in result.output

    def test_ext_flag_passed_to_index_project(self, tmp_path, monkeypatch):
        """--ext py causes index_project to be called with ext_filter={'.py'}."""
        fake_proj = _fake_proj()
        summary = _make_index_result(indexed=2, ext_counts={".py": 2}, languages=["python"])

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary) as mock_ip,
        ):
            result = runner.invoke(cli.app, ["index", "--ext", "py"])

        assert result.exit_code == 0, result.output
        call_kwargs = mock_ip.call_args[1]
        assert call_kwargs.get("ext_filter") == frozenset({".py"})

    def test_ext_flag_with_dot_prefix(self, tmp_path, monkeypatch):
        """--ext .py (with dot) normalises to '.py' in ext_filter."""
        fake_proj = _fake_proj()
        summary = _make_index_result(indexed=2, ext_counts={".py": 2}, languages=["python"])

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary) as mock_ip,
        ):
            result = runner.invoke(cli.app, ["index", "--ext", ".py"])

        assert result.exit_code == 0, result.output
        call_kwargs = mock_ip.call_args[1]
        assert call_kwargs.get("ext_filter") == frozenset({".py"})

    def test_ext_flag_multiple(self, tmp_path, monkeypatch):
        """Multiple --ext flags produce a frozenset with all extensions."""
        fake_proj = _fake_proj()
        summary = _make_index_result()

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary) as mock_ip,
        ):
            result = runner.invoke(cli.app, ["index", "--ext", "py", "--ext", "ts"])

        assert result.exit_code == 0, result.output
        call_kwargs = mock_ip.call_args[1]
        assert call_kwargs.get("ext_filter") == frozenset({".py", ".ts"})

    def test_no_ext_flag_passes_none(self, tmp_path, monkeypatch):
        """Without --ext, ext_filter is None (all files indexed)."""
        fake_proj = _fake_proj()
        summary = _make_index_result()

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary) as mock_ip,
        ):
            result = runner.invoke(cli.app, ["index"])

        assert result.exit_code == 0, result.output
        call_kwargs = mock_ip.call_args[1]
        assert call_kwargs.get("ext_filter") is None

    def test_ext_breakdown_order_descending(self, tmp_path, monkeypatch):
        """Breakdown lists extensions in descending count order."""
        fake_proj = _fake_proj()
        summary = _make_index_result(
            ext_counts={".py": 10, ".ts": 3, ".css": 1},
        )

        monkeypatch.chdir(tmp_path)
        with (
            patch("token_goat.project.find_project", return_value=fake_proj),
            patch("token_goat.parser.index_project", return_value=summary),
        ):
            result = runner.invoke(cli.app, ["index"])

        assert result.exit_code == 0, result.output
        output = result.output
        assert "by type:" in output
        # Highest count first
        py_pos = output.index(".py")
        ts_pos = output.index(".ts")
        css_pos = output.index(".css")
        assert py_pos < ts_pos < css_pos, "Expected .py before .ts before .css in output"
