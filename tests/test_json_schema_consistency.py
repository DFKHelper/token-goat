"""Tests for JSON schema consistency across token-goat commands.

All commands with --json should emit a unified envelope:
    {"query": "...", "results": [...], "total": N, ...command-specific fields...}

Tests also cover the --quiet flag for suppressing non-essential output.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"
PY_SAMPLE = FIXTURE_DIR / "py_sample"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def indexed_py_dir(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Copy py_sample to tmp, index it, and chdir into it."""
    proj_root = tmp_path / "py_sample"
    shutil.copytree(PY_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)
    from token_goat.parser import index_project
    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


@pytest.fixture
def indexed_ts_dir(tmp_path, tmp_data_dir, make_project, monkeypatch):
    """Copy ts_sample to tmp, index it, and chdir into it."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    (proj_root / ".git").mkdir(exist_ok=True)
    from token_goat.parser import index_project
    monkeypatch.chdir(proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _invoke(runner, args):
    from token_goat.cli import app
    return runner.invoke(app, args)


def _assert_envelope(data: object, query: str) -> dict:
    """Assert the unified JSON envelope shape and return the dict."""
    assert isinstance(data, dict), f"Expected dict envelope, got {type(data).__name__}: {data!r}"
    assert "query" in data, f"Missing 'query' key: {data.keys()}"
    assert "results" in data, f"Missing 'results' key: {data.keys()}"
    assert "total" in data, f"Missing 'total' key: {data.keys()}"
    assert data["query"] == query, f"Expected query={query!r}, got {data['query']!r}"
    assert isinstance(data["results"], list), "results must be a list"
    assert data["total"] == len(data["results"]), (
        f"total ({data['total']}) must equal len(results) ({len(data['results'])})"
    )
    return data


# ---------------------------------------------------------------------------
# symbol --json: unified envelope
# ---------------------------------------------------------------------------

class TestSymbolJsonSchema:
    """symbol --json emits unified envelope."""

    def test_symbol_json_envelope_shape(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["symbol", "greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "greet")
        # Results have the expected fields
        assert len(d["results"]) >= 1
        r = d["results"][0]
        assert "name" in r
        assert "kind" in r
        assert "file" in r
        assert "line" in r

    def test_symbol_json_no_results_envelope(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["symbol", "__no_such_symbol_xyz__", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "__no_such_symbol_xyz__")
        assert d["total"] == 0
        assert d["results"] == []

    def test_symbol_json_total_matches_results_len(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["symbol", "greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert data["total"] == len(data["results"])


# ---------------------------------------------------------------------------
# refs --json (plain symbol): unified envelope
# ---------------------------------------------------------------------------

class TestRefsPlainJsonSchema:
    """refs <symbol> --json (plain, no ::) emits unified envelope."""

    def test_refs_plain_json_envelope_shape(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "greet")
        assert len(d["results"]) >= 1

    def test_refs_plain_json_no_results_envelope(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "__no_such_xyz__", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "__no_such_xyz__")
        assert d["total"] == 0


# ---------------------------------------------------------------------------
# refs --json (:: format): unified envelope + backward-compat fields
# ---------------------------------------------------------------------------

class TestRefsFileSymbolJsonSchema:
    """refs <file>::<symbol> --json emits unified envelope with backward-compat fields."""

    def test_refs_file_symbol_envelope_shape(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "index.ts::greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "index.ts::greet")
        # Backward-compat: file, symbol, refs all still present
        assert "file" in d
        assert "symbol" in d
        assert "refs" in d
        assert d["symbol"] == "greet"
        assert isinstance(d["refs"], list)
        # refs is the same list as results
        assert d["refs"] == d["results"]

    def test_refs_file_symbol_no_results_envelope(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "index.ts::__no_such_xyz__", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        d = _assert_envelope(data, "index.ts::__no_such_xyz__")
        assert d["total"] == 0
        assert d["refs"] == []


# ---------------------------------------------------------------------------
# outline --json: unified envelope + backward-compat symbols field
# ---------------------------------------------------------------------------

class TestOutlineJsonSchema:
    """outline --json emits unified envelope."""

    def test_outline_json_envelope_shape(self, indexed_py_dir, tmp_data_dir):
        from typer.testing import CliRunner
        proj_root, _proj = indexed_py_dir
        runner = CliRunner()
        # Find a Python file to outline
        py_files = list(proj_root.glob("*.py"))
        assert py_files, "No .py files in py_sample"
        target = py_files[0].name
        result = _invoke(runner, ["outline", target, "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        # outline uses file as query equivalent
        assert isinstance(data, dict)
        assert "file" in data
        assert "symbols" in data  # backward-compat key
        assert "results" in data
        assert "total" in data
        assert data["total"] == len(data["results"])
        assert data["symbols"] == data["results"]

    def test_outline_json_empty_file_envelope(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """outline of a file with no indexable symbols returns empty envelope."""
        from token_goat.parser import index_project
        proj_root = tmp_path / "empty_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        # A file with only comments — no functions/classes
        (proj_root / "empty.py").write_text("# just a comment\n", encoding="utf-8")
        proj = make_project(proj_root)
        index_project(proj, full=True)
        monkeypatch.chdir(proj_root)
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["outline", "empty.py", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert isinstance(data, dict)
        assert "total" in data
        assert "results" in data
        assert data["total"] == 0
        assert data["results"] == []


# ---------------------------------------------------------------------------
# changed --json: unified envelope + backward-compat fields
# ---------------------------------------------------------------------------

class TestChangedJsonSchema:
    """changed --json emits unified envelope."""

    def test_changed_json_envelope_shape(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["changed", "--since", "HEAD~1", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert isinstance(data, dict)
        assert "query" in data
        assert "results" in data
        assert "total" in data
        assert data["total"] == len(data["results"])
        # Backward-compat fields
        assert "since" in data
        assert "count" in data
        assert data["count"] == data["total"]
        # "symbols" alias still present (default mode)
        assert "symbols" in data
        assert data["symbols"] == data["results"]

    def test_changed_json_symbol_mode_envelope(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["changed", "--since", "HEAD~1", "--symbol", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert isinstance(data, dict)
        assert "results" in data
        assert "total" in data
        # "files" alias still present (--symbol mode)
        assert "files" in data
        assert data["files"] == data["results"]


# ---------------------------------------------------------------------------
# Cross-command: all JSON commands return consistent {query, results, total}
# ---------------------------------------------------------------------------

class TestCrossCommandJsonConsistency:
    """All JSON-capable commands return the same envelope keys."""

    REQUIRED_KEYS = {"query", "results", "total"}

    def test_symbol_has_required_keys(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["symbol", "greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert self.REQUIRED_KEYS.issubset(data.keys())

    def test_refs_plain_has_required_keys(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert self.REQUIRED_KEYS.issubset(data.keys())

    def test_refs_file_symbol_has_required_keys(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "index.ts::greet", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert self.REQUIRED_KEYS.issubset(data.keys())

    def test_changed_has_required_keys(self, indexed_ts_dir, tmp_data_dir):
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["changed", "--since", "HEAD~1", "--json"])
        assert result.exit_code == 0
        data = json.loads(result.output.strip())
        assert self.REQUIRED_KEYS.issubset(data.keys())


# ---------------------------------------------------------------------------
# --quiet flag: suppress non-essential output
# ---------------------------------------------------------------------------

class TestQuietFlag:
    """--quiet suppresses header/summary lines without affecting results."""

    def test_symbol_quiet_no_output_on_empty(self, indexed_ts_dir, tmp_data_dir):
        """symbol --quiet with no results produces no output (no 'No matches' line)."""
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["symbol", "__no_such_symbol_xyz__", "--quiet"])
        assert result.exit_code == 0
        assert result.output.strip() == ""

    def test_symbol_quiet_still_shows_results(self, indexed_ts_dir, tmp_data_dir):
        """symbol --quiet shows results but no additional header lines."""
        from typer.testing import CliRunner
        runner = CliRunner()
        # With results: should still print them, just no count header
        result = _invoke(runner, ["symbol", "greet"])
        result_quiet = _invoke(runner, ["symbol", "greet", "--quiet"])
        assert result.exit_code == 0
        assert result_quiet.exit_code == 0
        # Both should have results (symbol found)
        assert "greet" in result.output
        assert "greet" in result_quiet.output

    def test_outline_quiet_suppresses_header(self, indexed_py_dir, tmp_data_dir):
        """outline --quiet suppresses the '# Outline:' header line."""
        from typer.testing import CliRunner
        proj_root, _proj = indexed_py_dir
        runner = CliRunner()
        py_files = list(proj_root.glob("*.py"))
        assert py_files
        target = py_files[0].name

        result_normal = _invoke(runner, ["outline", target])
        result_quiet = _invoke(runner, ["outline", target, "--quiet"])

        assert result_normal.exit_code == 0
        assert result_quiet.exit_code == 0

        # Normal output has the # Outline header
        assert "# Outline:" in result_normal.output
        # Quiet output does NOT have the header
        assert "# Outline:" not in result_quiet.output

    def test_outline_quiet_json_unaffected(self, indexed_py_dir, tmp_data_dir):
        """outline --json --quiet produces identical JSON (quiet is for plain text only)."""
        from typer.testing import CliRunner
        proj_root, _proj = indexed_py_dir
        runner = CliRunner()
        py_files = list(proj_root.glob("*.py"))
        assert py_files
        target = py_files[0].name

        result_json = _invoke(runner, ["outline", target, "--json"])
        result_json_quiet = _invoke(runner, ["outline", target, "--json", "--quiet"])

        assert result_json.exit_code == 0
        assert result_json_quiet.exit_code == 0
        # JSON output should be identical
        assert json.loads(result_json.output.strip()) == json.loads(result_json_quiet.output.strip())

    def test_refs_quiet_no_output_on_empty(self, indexed_ts_dir, tmp_data_dir):
        """refs --quiet with no results produces no output."""
        from typer.testing import CliRunner
        runner = CliRunner()
        result = _invoke(runner, ["refs", "__no_such_symbol_xyz__", "--quiet"])
        assert result.exit_code == 0
        assert result.output.strip() == ""

    def test_changed_quiet_suppresses_count_header(self, indexed_ts_dir, tmp_data_dir):
        """changed --quiet suppresses the '{N} symbol changes since ...' count line."""
        from typer.testing import CliRunner
        runner = CliRunner()
        result_normal = _invoke(runner, ["changed", "--since", "HEAD~1"])
        result_quiet = _invoke(runner, ["changed", "--since", "HEAD~1", "--quiet"])

        assert result_normal.exit_code == 0
        assert result_quiet.exit_code == 0

        # Normal output contains the count summary like "N symbol changes since HEAD~1"
        # or "N files changed since HEAD~1"
        normal_lines = [ln.strip() for ln in result_normal.output.splitlines() if ln.strip()]
        quiet_lines = [ln.strip() for ln in result_quiet.output.splitlines() if ln.strip()]

        # Quiet should have fewer or equal lines (no summary line)
        assert len(quiet_lines) <= len(normal_lines)

        # The "since HEAD~1" summary line should not appear in quiet output
        # (normal has it; quiet doesn't)
        if normal_lines:
            # If normal output has summary line (contains "since"), quiet must not start with it
            summary_in_normal = any("since" in ln for ln in normal_lines)
            if summary_in_normal:
                assert not any("symbol change" in ln for ln in quiet_lines), (
                    f"--quiet should suppress count summary, got: {quiet_lines}"
                )
