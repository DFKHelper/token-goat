"""Smoke tests for the bash-output and bash-history CLI commands."""
from __future__ import annotations

import json

from typer.testing import CliRunner

from token_goat import bash_cache
from token_goat.cli import app


def _seed(session_id: str = "cli-1", command: str = "pytest -v") -> str:
    """Store a cached output and return its ID."""
    meta = bash_cache.store_output(
        session_id, command,
        "line 1\nline 2\nfailing test\nline 4\n", "", 1,
    )
    assert meta is not None
    bash_cache.write_sidecar(meta)
    return meta.output_id


class TestBashOutputCli:
    def test_retrieves_cached_body(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        assert "failing test" in result.stdout
        assert "line 1" in result.stdout

    def test_grep_filter(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "failing"])
        assert result.exit_code == 0
        assert "failing test" in result.stdout
        assert "line 1" not in result.stdout

    def test_head_limits_output(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--head", "2"])
        assert result.exit_code == 0
        assert "line 1" in result.stdout
        assert "line 4" not in result.stdout

    def test_missing_id_returns_error(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", "nonexistent-id"])
        assert result.exit_code != 0

    def test_json_includes_metadata(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert payload["output_id"] == oid
        assert "failing test" in payload["text"]
        assert "exit_code" in payload

    def test_json_numbered_lines_match_original(self, tmp_data_dir):
        """`numbered_lines` carries the original line number for each kept line.

        Even when `--head`/`--tail`/`--grep` slice the output, every entry
        carries its 1-based offset into the *original* body so an agent can
        follow up with a positional slicer that maps to the on-disk file.
        """
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "failing", "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert payload["total_lines"] == 4
        # Only one line matches "failing", and it's the 3rd line of the body.
        numbered = payload["numbered_lines"]
        assert len(numbered) == 1
        assert numbered[0]["text"] == "failing test"
        assert numbered[0]["lineno"] == 3


class TestBashHistoryCli:
    def test_empty_history(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        assert "no cached" in result.stdout.lower()

    def test_lists_entries(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        assert oid in result.stdout

    def test_json_listing(self, tmp_data_dir):
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history", "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert any(row["output_id"] == oid for row in payload)
