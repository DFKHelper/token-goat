"""Smoke tests for the bash-output, web-output, and bash-history CLI commands."""
from __future__ import annotations

import json

from typer.testing import CliRunner

from token_goat import bash_cache, web_cache
from token_goat.cli import _SMART_DEFAULT_HEAD, _SMART_DEFAULT_TAIL, _SMART_DEFAULT_THRESHOLD, app


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


def _seed_large_bash(n_lines: int = _SMART_DEFAULT_THRESHOLD + 50, suffix: str = "DONE") -> str:
    """Store a bash output with n_lines lines and a distinctive last line."""
    body_lines = [f"line {i}" for i in range(1, n_lines)]
    body_lines.append(suffix)
    meta = bash_cache.store_output(
        "large-sess", "pytest -v", "\n".join(body_lines), "", 0,
    )
    assert meta is not None
    bash_cache.write_sidecar(meta)
    return meta.output_id


def _seed_web_large(n_lines: int = _SMART_DEFAULT_THRESHOLD + 50, suffix: str = "WEB_END") -> str:
    """Store a web output with n_lines lines and a distinctive last line."""
    body_lines = [f"html line {i}" for i in range(1, n_lines)]
    body_lines.append(suffix)
    meta = web_cache.store_output(
        "large-web-sess", "https://example.com/big", "\n".join(body_lines), 200,
    )
    assert meta is not None
    web_cache.write_sidecar(meta)
    return meta.output_id


class TestSmartDefaultBashOutput:
    """Smart-default head+tail slicing for bash-output with no flags."""

    def test_small_output_returned_in_full(self, tmp_data_dir):
        # 4-line body is well under the threshold — must not be elided.
        oid = _seed()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        assert "line 1" in result.stdout
        assert "line 4" in result.stdout
        assert "token-goat" not in result.stdout

    def test_large_output_shows_head_and_tail(self, tmp_data_dir):
        # n_lines > threshold — smart default must elide the middle.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        assert "line 1" in result.stdout
        assert "DONE" in result.stdout
        assert "token-goat:" in result.stdout
        assert "elided" in result.stdout
        assert "--full" in result.stdout

    def test_large_output_head_line_count(self, tmp_data_dir):
        # The displayed output must contain exactly HEAD + 1 marker + TAIL lines.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        lines = result.stdout.rstrip("\n").splitlines()
        assert len(lines) == _SMART_DEFAULT_HEAD + 1 + _SMART_DEFAULT_TAIL

    def test_full_flag_returns_everything(self, tmp_data_dir):
        # --full must suppress smart default and return all lines.
        n = _SMART_DEFAULT_THRESHOLD + 50
        oid = _seed_large_bash(n_lines=n)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--full"])
        assert result.exit_code == 0
        lines = result.stdout.rstrip("\n").splitlines()
        assert len(lines) == n
        assert "token-goat:" not in result.stdout

    def test_tail_flag_bypasses_smart_default(self, tmp_data_dir):
        # --tail given explicitly — smart default must NOT apply on top of it.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--tail", "5"])
        assert result.exit_code == 0
        lines = result.stdout.rstrip("\n").splitlines()
        assert len(lines) == 5
        assert "token-goat:" not in result.stdout

    def test_grep_flag_bypasses_smart_default(self, tmp_data_dir):
        # --grep given — smart default must NOT stack on top.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "DONE"])
        assert result.exit_code == 0
        assert "DONE" in result.stdout
        assert "token-goat:" not in result.stdout

    def test_elision_marker_states_total_and_flag(self, tmp_data_dir):
        # Marker line must mention the total count and the --full flag.
        n = _SMART_DEFAULT_THRESHOLD + 50
        oid = _seed_large_bash(n_lines=n)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        marker_lines = [ln for ln in result.stdout.splitlines() if "token-goat:" in ln]
        assert len(marker_lines) == 1
        marker = marker_lines[0]
        assert str(n) in marker
        assert "--full" in marker


class TestSmartDefaultWebOutput:
    """Smart-default head+tail slicing for web-output with no flags."""

    def test_small_web_output_returned_in_full(self, tmp_data_dir):
        meta = web_cache.store_output("small-web", "https://x.com/p", "line\n" * 4, 200)
        assert meta is not None
        web_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", meta.output_id])
        assert result.exit_code == 0
        assert "token-goat:" not in result.stdout

    def test_large_web_output_shows_head_and_tail(self, tmp_data_dir):
        oid = _seed_web_large()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid])
        assert result.exit_code == 0
        assert "html line 1" in result.stdout
        assert "WEB_END" in result.stdout
        assert "token-goat:" in result.stdout
        assert "elided" in result.stdout

    def test_web_full_flag_returns_everything(self, tmp_data_dir):
        n = _SMART_DEFAULT_THRESHOLD + 50
        oid = _seed_web_large(n_lines=n)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--full"])
        assert result.exit_code == 0
        lines = result.stdout.rstrip("\n").splitlines()
        assert len(lines) == n
        assert "token-goat:" not in result.stdout

    def test_web_tail_flag_bypasses_smart_default(self, tmp_data_dir):
        oid = _seed_web_large()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--tail", "3"])
        assert result.exit_code == 0
        lines = result.stdout.rstrip("\n").splitlines()
        assert len(lines) == 3
        assert "token-goat:" not in result.stdout

    def test_web_grep_flag_bypasses_smart_default(self, tmp_data_dir):
        oid = _seed_web_large()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--grep", "WEB_END"])
        assert result.exit_code == 0
        assert "WEB_END" in result.stdout
        assert "token-goat:" not in result.stdout
