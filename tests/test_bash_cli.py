"""Smoke tests for the bash-output, web-output, and bash-history CLI commands."""
from __future__ import annotations

import json
from unittest.mock import patch

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
        # The displayed output must contain exactly HEAD + 1 marker + TAIL content lines.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid])
        assert result.exit_code == 0
        content_lines = [ln for ln in result.stdout.rstrip("\n").splitlines() if not ln.startswith("# cached")]
        assert len(content_lines) == _SMART_DEFAULT_HEAD + 1 + _SMART_DEFAULT_TAIL

    def test_full_flag_returns_everything(self, tmp_data_dir):
        # --full must suppress smart default and return all lines.
        n = _SMART_DEFAULT_THRESHOLD + 50
        oid = _seed_large_bash(n_lines=n)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--full"])
        assert result.exit_code == 0
        content_lines = [ln for ln in result.stdout.rstrip("\n").splitlines() if not ln.startswith("# cached")]
        assert len(content_lines) == n
        assert "token-goat:" not in result.stdout

    def test_tail_flag_bypasses_smart_default(self, tmp_data_dir):
        # --tail given explicitly — smart default must NOT apply on top of it.
        oid = _seed_large_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--tail", "5"])
        assert result.exit_code == 0
        content_lines = [ln for ln in result.stdout.rstrip("\n").splitlines() if not ln.startswith("# cached")]
        assert len(content_lines) == 5
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
        content_lines = [ln for ln in result.stdout.rstrip("\n").splitlines() if not ln.startswith("# cached")]
        assert len(content_lines) == n
        assert "token-goat:" not in result.stdout

    def test_web_tail_flag_bypasses_smart_default(self, tmp_data_dir):
        oid = _seed_web_large()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--tail", "3"])
        assert result.exit_code == 0
        content_lines = [ln for ln in result.stdout.rstrip("\n").splitlines() if not ln.startswith("# cached")]
        assert len(content_lines) == 3
        assert "token-goat:" not in result.stdout

    def test_web_grep_flag_bypasses_smart_default(self, tmp_data_dir):
        oid = _seed_web_large()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--grep", "WEB_END"])
        assert result.exit_code == 0
        assert "WEB_END" in result.stdout
        assert "token-goat:" not in result.stdout


# ---------------------------------------------------------------------------
# --section flag for bash-output and web-output
# ---------------------------------------------------------------------------


def _seed_sectioned_bash(session_id: str = "sec-bash") -> str:
    body = (
        "## Build\n"
        "building project\n"
        "build succeeded\n"
        "## Tests\n"
        "running pytest\n"
        "5 passed\n"
        "## Deploy\n"
        "pushing image\n"
    )
    meta = bash_cache.store_output(session_id, "make all", body, "", 0)
    assert meta is not None
    bash_cache.write_sidecar(meta)
    return meta.output_id


def _seed_sectioned_web(session_id: str = "sec-web") -> str:
    body = (
        "## Install\n"
        "pip install foo\n"
        "## Usage\n"
        "foo --help\n"
        "## Changelog\n"
        "1.2.0 released\n"
    )
    meta = web_cache.store_output(session_id, "https://docs.example.com/", body, 200)
    assert meta is not None
    web_cache.write_sidecar(meta)
    return meta.output_id


class TestSectionFlagBashOutput:
    def test_section_extracts_named_section(self, tmp_data_dir):
        oid = _seed_sectioned_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--section", "Tests"])
        assert result.exit_code == 0
        assert "running pytest" in result.stdout
        assert "5 passed" in result.stdout
        assert "building project" not in result.stdout
        assert "pushing image" not in result.stdout

    def test_section_not_found_exits_error(self, tmp_data_dir):
        oid = _seed_sectioned_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--section", "Nonexistent"])
        assert result.exit_code != 0

    def test_section_combined_with_grep(self, tmp_data_dir):
        oid = _seed_sectioned_bash()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--section", "Build", "--grep", "succeeded"])
        assert result.exit_code == 0
        assert "build succeeded" in result.stdout
        assert "building project" not in result.stdout


class TestSectionFlagWebOutput:
    def test_section_extracts_named_section(self, tmp_data_dir):
        oid = _seed_sectioned_web()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--section", "Usage"])
        assert result.exit_code == 0
        assert "foo --help" in result.stdout
        assert "pip install foo" not in result.stdout
        assert "1.2.0 released" not in result.stdout

    def test_section_not_found_exits_error(self, tmp_data_dir):
        oid = _seed_sectioned_web()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--section", "Nonexistent"])
        assert result.exit_code != 0

    def test_section_combined_with_grep(self, tmp_data_dir):
        oid = _seed_sectioned_web()
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", oid, "--section", "Changelog", "--grep", "1.2"])
        assert result.exit_code == 0
        assert "1.2.0 released" in result.stdout
        assert "pip install" not in result.stdout


# ---------------------------------------------------------------------------
# bash_output_recall stat recording
# ---------------------------------------------------------------------------

class TestBashOutputRecallStat:
    """cmd_bash_output records a bash_output_recall stat on every successful recall.

    Savings model: saved_bytes = len(full_body) - len(returned_slice).
    A full unsliced recall returns everything → saved = 0 (honest).
    A sliced recall returns a strict subset → saved > 0 (real saving).
    An invalid / missing id exits with error and records nothing.
    """

    def _body(self) -> str:
        """100-line body, each line "line NNN\\n"."""
        return "\n".join(f"line {i:03d}" for i in range(1, 101))

    def _seed_body(self, body: str, command: str = "pytest -v") -> str:
        meta = bash_cache.store_output("recall-sess", command, body, "", 0)
        assert meta is not None
        bash_cache.write_sidecar(meta)
        return meta.output_id

    def test_sliced_recall_records_nonzero_saving(self, tmp_data_dir):
        """A --head slice returns fewer bytes than the full body → saved > 0."""
        body = self._body()
        oid = self._seed_body(body)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["bash-output", oid, "--head", "5"])

        assert result.exit_code == 0

        recall_rows = [r for r in recorded if r["kind"] == "bash_output_recall"]
        assert len(recall_rows) == 1, "expected exactly one bash_output_recall stat row"
        row = recall_rows[0]

        # The full body is much larger than 5 lines → bytes_saved must be > 0.
        assert row["bytes_saved"] > 0, "sliced recall must record positive bytes_saved"
        assert row["tokens_saved"] > 0, "sliced recall must record positive tokens_saved"
        # tokens_saved must use the canonical max(1, bytes // 3 + 1) formula.
        bs = row["bytes_saved"]
        assert row["tokens_saved"] == (max(1, bs // 3 + 1) if bs > 0 else 0)

        # Verify the arithmetic: saved = full_body_bytes - returned_slice_bytes.
        full_bytes = len(body.encode())
        returned_slice = "\n".join(body.splitlines()[:5])
        returned_bytes = len(returned_slice.encode())
        expected_saved = full_bytes - returned_bytes
        assert row["bytes_saved"] == expected_saved

    def test_full_recall_records_zero_saving(self, tmp_data_dir):
        """A --full recall returns everything → saved = 0 (honest)."""
        body = self._body()
        oid = self._seed_body(body)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["bash-output", oid, "--full"])

        assert result.exit_code == 0

        recall_rows = [r for r in recorded if r["kind"] == "bash_output_recall"]
        assert len(recall_rows) == 1, "expected exactly one bash_output_recall stat row"
        assert recall_rows[0]["bytes_saved"] == 0, "full recall must record zero bytes_saved"
        assert recall_rows[0]["tokens_saved"] == 0, "full recall must record zero tokens_saved"

    def test_invalid_id_records_recall_miss(self, tmp_data_dir):
        """An invalid id exits with error, records bash_output_recall_miss (not _recall)."""
        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({
                "kind": kind, "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved, "detail": detail,
            })

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["bash-output", "no-such-id-deadbeef"])

        assert result.exit_code != 0

        # No successful recall row for a missing id.
        recall_rows = [r for r in recorded if r["kind"] == "bash_output_recall"]
        assert recall_rows == [], "invalid id must not record a successful recall stat"

        # But a recall_miss row IS written so adoption telemetry can surface
        # the stale/wrong-id rate.  Always zero savings.
        miss_rows = [r for r in recorded if r["kind"] == "bash_output_recall_miss"]
        assert len(miss_rows) == 1, "invalid id must record exactly one recall_miss row"
        assert miss_rows[0]["bytes_saved"] == 0
        assert miss_rows[0]["tokens_saved"] == 0
        # detail carries (a truncated form of) the requested id for diagnosis.
        assert "no-such-id-deadbeef" in (miss_rows[0]["detail"] or "")

    def test_empty_body_records_zero_without_error(self, tmp_data_dir):
        """An empty cached output: saved = 0 with no division-by-zero or crash."""
        meta = bash_cache.store_output("recall-empty", "true", "", "", 0)
        assert meta is not None
        # An empty body is below the storage threshold; write the file manually.
        from token_goat.paths import data_dir
        out_dir = data_dir() / "bash_outputs"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{meta.output_id}.txt").write_text("", encoding="utf-8")

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["bash-output", meta.output_id, "--full"])

        assert result.exit_code == 0

        recall_rows = [r for r in recorded if r["kind"] == "bash_output_recall"]
        assert len(recall_rows) == 1
        assert recall_rows[0]["bytes_saved"] == 0
        assert recall_rows[0]["tokens_saved"] == 0

    def test_kind_to_source_maps_bash_output_recall(self):
        """bash_output_recall must be in _KIND_TO_SOURCE → SOURCE_BASH."""
        from token_goat.stats import SOURCE_BASH, kind_to_source
        assert kind_to_source("bash_output_recall") == SOURCE_BASH


# ---------------------------------------------------------------------------
# web_output_recall stat recording
# ---------------------------------------------------------------------------

class TestWebOutputRecallStat:
    """cmd_web_output records a web_output_recall stat on every successful recall.

    Same semantics as bash_output_recall — full recall = 0, slice = > 0,
    invalid id = nothing.
    """

    def _body(self) -> str:
        return "\n".join(f"<p>line {i:03d}</p>" for i in range(1, 101))

    def _seed_body(self, body: str) -> str:
        meta = web_cache.store_output("recall-web-sess", "https://example.com/doc", body, 200)
        assert meta is not None
        web_cache.write_sidecar(meta)
        return meta.output_id

    def test_sliced_recall_records_nonzero_saving(self, tmp_data_dir):
        """A --head slice returns fewer bytes than the full body → saved > 0."""
        body = self._body()
        oid = self._seed_body(body)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["web-output", oid, "--head", "5"])

        assert result.exit_code == 0

        recall_rows = [r for r in recorded if r["kind"] == "web_output_recall"]
        assert len(recall_rows) == 1, "expected exactly one web_output_recall stat row"
        row = recall_rows[0]

        assert row["bytes_saved"] > 0
        assert row["tokens_saved"] > 0
        bs = row["bytes_saved"]
        assert row["tokens_saved"] == (max(1, bs // 3 + 1) if bs > 0 else 0)

        full_bytes = len(body.encode())
        returned_slice = "\n".join(body.splitlines()[:5])
        returned_bytes = len(returned_slice.encode())
        expected_saved = full_bytes - returned_bytes
        assert row["bytes_saved"] == expected_saved

    def test_full_recall_records_zero_saving(self, tmp_data_dir):
        """A --full recall returns everything → saved = 0."""
        body = self._body()
        oid = self._seed_body(body)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["web-output", oid, "--full"])

        assert result.exit_code == 0

        recall_rows = [r for r in recorded if r["kind"] == "web_output_recall"]
        assert len(recall_rows) == 1
        assert recall_rows[0]["bytes_saved"] == 0
        assert recall_rows[0]["tokens_saved"] == 0

    def test_invalid_id_records_recall_miss(self, tmp_data_dir):
        """An invalid id exits with error, records web_output_recall_miss (not _recall)."""
        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({
                "kind": kind, "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved, "detail": detail,
            })

        with patch("token_goat.db.record_stat", side_effect=capture):
            runner = CliRunner()
            result = runner.invoke(app, ["web-output", "no-such-id-deadbeef"])

        assert result.exit_code != 0
        recall_rows = [r for r in recorded if r["kind"] == "web_output_recall"]
        assert recall_rows == []

        # The new contract: an invalid id writes one web_output_recall_miss
        # row (zero savings, used for adoption telemetry).
        miss_rows = [r for r in recorded if r["kind"] == "web_output_recall_miss"]
        assert len(miss_rows) == 1, "invalid id must record exactly one recall_miss row"
        assert miss_rows[0]["bytes_saved"] == 0
        assert miss_rows[0]["tokens_saved"] == 0
        assert "no-such-id-deadbeef" in (miss_rows[0]["detail"] or "")

    def test_kind_to_source_maps_web_output_recall(self):
        """web_output_recall must be in _KIND_TO_SOURCE → SOURCE_WEB."""
        from token_goat.stats import SOURCE_WEB, kind_to_source
        assert kind_to_source("web_output_recall") == SOURCE_WEB


# ---------------------------------------------------------------------------
# Case-insensitive --grep (default) and --case-sensitive flag
# ---------------------------------------------------------------------------

class TestGrepCaseInsensitive:
    """--grep is case-insensitive by default; --case-sensitive restores old behaviour."""

    def _seed_mixed_case(self) -> str:
        meta = bash_cache.store_output(
            "ci-sess", "make test",
            "PASSED: auth_test\nfailed: db_test\nPASSED: api_test\n", "", 0,
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)
        return meta.output_id

    def test_grep_case_insensitive_by_default(self, tmp_data_dir):
        oid = self._seed_mixed_case()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "passed"])
        assert result.exit_code == 0
        assert "PASSED: auth_test" in result.stdout
        assert "PASSED: api_test" in result.stdout
        assert "failed: db_test" not in result.stdout

    def test_grep_case_sensitive_flag_excludes_mismatched_case(self, tmp_data_dir):
        oid = self._seed_mixed_case()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "passed", "--case-sensitive"])
        assert result.exit_code == 0
        assert "PASSED" not in result.stdout
        assert "failed: db_test" not in result.stdout

    def test_grep_case_sensitive_flag_matches_exact_case(self, tmp_data_dir):
        oid = self._seed_mixed_case()
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", oid, "--grep", "PASSED", "--case-sensitive"])
        assert result.exit_code == 0
        assert "PASSED: auth_test" in result.stdout
        assert "PASSED: api_test" in result.stdout
        assert "failed: db_test" not in result.stdout

    def test_web_output_grep_case_insensitive_by_default(self, tmp_data_dir):
        meta = web_cache.store_output(
            "ci-web-sess", "https://example.com/api",
            "Error: connection refused\nerror: timeout\nOK: 200\n", 200,
        )
        assert meta is not None
        web_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", meta.output_id, "--grep", "error"])
        assert result.exit_code == 0
        assert "Error: connection refused" in result.stdout
        assert "error: timeout" in result.stdout
        assert "OK: 200" not in result.stdout


# ---------------------------------------------------------------------------
# Age header in text mode
# ---------------------------------------------------------------------------

class TestOutputAgeHeader:
    """bash-output and web-output prepend a '# cached X ago' header in text mode."""

    def test_bash_output_shows_age_header(self, tmp_data_dir):
        meta = bash_cache.store_output("age-sess", "pytest -v", "some output\n", "", 0)
        assert meta is not None
        bash_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", meta.output_id])
        assert result.exit_code == 0
        first_line = result.stdout.splitlines()[0]
        assert first_line.startswith("# cached")
        assert "exit=0" in first_line
        assert "pytest -v" in first_line

    def test_web_output_shows_age_header(self, tmp_data_dir):
        meta = web_cache.store_output("age-web-sess", "https://example.com/doc", "body text\n", 200)
        assert meta is not None
        web_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", meta.output_id])
        assert result.exit_code == 0
        first_line = result.stdout.splitlines()[0]
        assert first_line.startswith("# cached")
        assert "status=200" in first_line
        assert "example.com" in first_line

    def test_age_header_absent_in_json_mode(self, tmp_data_dir):
        meta = bash_cache.store_output("age-json-sess", "echo hi", "hi\n", "", 0)
        assert meta is not None
        bash_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", meta.output_id, "--json"])
        assert result.exit_code == 0
        payload = json.loads(result.stdout)
        assert "output_id" in payload
        assert not result.stdout.startswith("# cached")

    def test_age_header_no_crash_without_sidecar(self, tmp_data_dir):
        meta = bash_cache.store_output("age-nosidecar", "ls -la", "file1\nfile2\n", "", 0)
        assert meta is not None
        runner = CliRunner()
        result = runner.invoke(app, ["bash-output", meta.output_id])
        assert result.exit_code == 0
        assert "file1" in result.stdout


# ---------------------------------------------------------------------------
# web-output --from-session
# ---------------------------------------------------------------------------

class TestWebOutputFromSession:
    """--from-session lists all web outputs for a given session."""

    def test_from_session_lists_matching_entries(self, tmp_data_dir):
        m1 = web_cache.store_output("sess-abc123", "https://example.com/p1", "body1\n", 200)
        m2 = web_cache.store_output("sess-abc123", "https://example.com/p2", "body2\n", 200)
        web_cache.store_output("other-sess-xyz", "https://other.com/p", "other\n", 200)
        assert m1 is not None and m2 is not None
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--from-session", "sess-abc123"])
        assert result.exit_code == 0
        assert m1.output_id in result.stdout
        assert m2.output_id in result.stdout
        assert "other.com" not in result.stdout

    def test_from_session_empty_when_no_match(self, tmp_data_dir):
        web_cache.store_output("sess-xyz999", "https://example.com/p", "body\n", 200)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--from-session", "nonexistent-session"])
        assert result.exit_code == 0
        assert "no web outputs" in result.stdout.lower()

    def test_from_session_json_output(self, tmp_data_dir):
        meta = web_cache.store_output("sess-json42", "https://example.com/api", "data\n", 200)
        assert meta is not None
        web_cache.write_sidecar(meta)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--from-session", "sess-json42", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.stdout)
        assert isinstance(rows, list)
        assert any(r["output_id"] == meta.output_id for r in rows)

    def test_missing_output_id_without_from_session_errors(self, tmp_data_dir):
        runner = CliRunner()
        result = runner.invoke(app, ["web-output"])
        assert result.exit_code != 0


# ---------------------------------------------------------------------------
# bash-history display: command truncation and exit code format
# ---------------------------------------------------------------------------

class TestBashHistoryDisplay:
    """bash-history truncates long commands to 100 chars and shows [exit:N]."""

    def _seed_cmd(self, command: str, exit_code: int = 0, session_id: str = "hist-disp") -> str:
        meta = bash_cache.store_output(
            session_id, command, "output line\n" * 100, "", exit_code,
        )
        assert meta is not None
        bash_cache.write_sidecar(meta)
        return meta.output_id

    def test_long_command_truncated_to_100_chars(self, tmp_data_dir):
        """Commands longer than 100 chars are truncated with '…' in text output."""
        long_cmd = "rg " + "A" * 120  # well over 100 chars
        oid = self._seed_cmd(long_cmd)
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        # Find the line for our entry
        lines = [ln for ln in result.stdout.splitlines() if oid in ln]
        assert len(lines) == 1, f"expected exactly one line with oid, got: {result.stdout}"
        line = lines[0]
        # Extract the command portion (after the age column)
        # The display is: oid  size  age  [exit:N]  cmd
        # Command must end with '…' and not exceed 100 display chars of the original command
        assert "…" in line
        # The preview shown should not exceed 100 chars (plus the appended '…')
        # Find position of the preview by splitting on the last '  ' block before the cmd
        after_age = line.split("s ago")[-1].strip()
        # Strip exit code if present
        if after_age.startswith("[exit:"):
            after_age = after_age.split("]", 1)[-1].strip()
        assert len(after_age) <= 101  # 100 chars + '…'

    def test_short_command_not_truncated(self, tmp_data_dir):
        """Commands under 100 chars are shown in full without truncation."""
        short_cmd = "pytest -v tests/"
        oid = self._seed_cmd(short_cmd, session_id="hist-short")
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        lines = [ln for ln in result.stdout.splitlines() if oid in ln]
        assert len(lines) == 1
        assert short_cmd in lines[0]
        # No truncation marker for a short command
        assert "…" not in lines[0] or short_cmd in lines[0]

    def test_exit_code_shown_for_nonzero(self, tmp_data_dir):
        """Non-zero exit codes appear as [exit:N] in the history line."""
        oid = self._seed_cmd("npm test", exit_code=1, session_id="hist-fail")
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        lines = [ln for ln in result.stdout.splitlines() if oid in ln]
        assert len(lines) == 1
        assert "[exit:1]" in lines[0]

    def test_exit_code_zero_shown(self, tmp_data_dir):
        """Zero exit code is also shown as [exit:0]."""
        oid = self._seed_cmd("make build", exit_code=0, session_id="hist-pass")
        runner = CliRunner()
        result = runner.invoke(app, ["bash-history"])
        assert result.exit_code == 0
        lines = [ln for ln in result.stdout.splitlines() if oid in ln]
        assert len(lines) == 1
        assert "[exit:0]" in lines[0]


# ---------------------------------------------------------------------------
# web-history display: content_type in JSON output
# ---------------------------------------------------------------------------

class TestWebHistoryContentType:
    """web-history JSON output includes content_type from sidecar."""

    def _seed_web(self, url: str, content_type: str | None, session_id: str = "wh-ct") -> str:
        meta = web_cache.store_output(
            session_id, url, "body content " * 200, 200,
            content_type=content_type,
        )
        assert meta is not None
        web_cache.write_sidecar(meta)
        return meta.output_id

    def test_json_includes_content_type(self, tmp_data_dir):
        """web-history --json includes content_type field when available."""
        oid = self._seed_web("https://api.example.com/data", "application/json")
        runner = CliRunner()
        result = runner.invoke(app, ["web-history", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.stdout)
        row = next((r for r in rows if r["output_id"] == oid), None)
        assert row is not None, "expected entry for stored web output"
        assert row.get("content_type") == "application/json"

    def test_json_content_type_none_when_not_provided(self, tmp_data_dir):
        """web-history --json shows content_type as null when not stored."""
        oid = self._seed_web("https://example.com/page", None, session_id="wh-no-ct")
        runner = CliRunner()
        result = runner.invoke(app, ["web-history", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.stdout)
        row = next((r for r in rows if r["output_id"] == oid), None)
        assert row is not None
        assert row.get("content_type") is None
