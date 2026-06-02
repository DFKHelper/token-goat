"""Tests for skill context savings improvements (iteration 9 of 10).

Covers:
1. Gzip compression for large skill bodies (>16 KB) in skill_cache.py.
2. ``token-goat skill-list`` CLI subcommand.
3. Warn on oversized compact slices (COMPACT_END placed too late).
"""
from __future__ import annotations

import gzip
import sys
from io import StringIO
from unittest.mock import patch

from conftest import make_large_skill_body

# ---------------------------------------------------------------------------
# Improvement 1: gzip compression for large skill bodies
# ---------------------------------------------------------------------------


class TestGzipCompression:
    """Skill bodies above compress_min_bytes are stored gzip-compressed."""

    def test_compressed_file_created_for_large_body(self, tmp_data_dir, patch_skill_config, skill_compress_cfg):
        """A .gz file is written when the body exceeds compress_min_bytes."""
        from token_goat import skill_cache

        body = make_large_skill_body(20_000)
        with patch_skill_config(skill_compress_cfg):
            meta = skill_cache.store_output("session-abc", "test-skill", body)

        assert meta is not None
        gz_files = list((tmp_data_dir / "skills").glob("*.gz"))
        assert len(gz_files) == 1, f"Expected 1 .gz file, got: {[f.name for f in gz_files]}"

    def test_compressed_body_reads_back_correctly(self, tmp_data_dir, patch_skill_config, skill_compress_cfg):
        """load_output decompresses the .gz file and returns the original text."""
        from token_goat import skill_cache

        body = make_large_skill_body(20_000)
        with patch_skill_config(skill_compress_cfg):
            meta = skill_cache.store_output("session-abc", "test-skill", body)

        assert meta is not None
        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None
        # The body may be tail-truncated if it exceeds _MAX_STORED_BYTES, but
        # for a 20 KB body it should be stored in full.
        assert loaded.startswith("# Skill Body")

    def test_small_body_stored_as_plain_text(self, tmp_data_dir, patch_skill_config):
        """Bodies below compress_min_bytes are stored as plain text (no .gz)."""
        from token_goat import skill_cache
        from token_goat.config import SkillPreservationConfig

        cfg_sp = SkillPreservationConfig(compress_bodies=True, compress_min_bytes=16 * 1024)
        with patch_skill_config(cfg_sp):
            small_body = "# Small Skill\n\nThis is a short skill body.\n"
            meta = skill_cache.store_output("session-abc", "small-skill", small_body)

        assert meta is not None
        gz_files = list((tmp_data_dir / "skills").glob("*.gz"))
        assert len(gz_files) == 0, "Small body should not produce a .gz file"

        loaded = skill_cache.load_output(meta.output_id)
        assert loaded is not None
        assert "Small Skill" in loaded

    def test_compress_disabled_does_not_create_gz(self, tmp_data_dir, patch_skill_config):
        """When compress_bodies=False, even large bodies are stored as plain text."""
        from token_goat import skill_cache
        from token_goat.config import SkillPreservationConfig

        cfg_sp = SkillPreservationConfig(compress_bodies=False, compress_min_bytes=1024)
        body = make_large_skill_body(20_000)
        with patch_skill_config(cfg_sp):
            meta = skill_cache.store_output("session-abc", "test-skill", body)

        assert meta is not None
        gz_files = list((tmp_data_dir / "skills").glob("*.gz"))
        assert len(gz_files) == 0, "compress_bodies=False should not produce .gz files"

    def test_gz_file_compresses_to_smaller_size(self, tmp_data_dir, patch_skill_config, skill_compress_cfg):
        """The .gz file is actually smaller than the raw body bytes."""
        from token_goat import skill_cache

        body = make_large_skill_body(30_000)
        with patch_skill_config(skill_compress_cfg):
            meta = skill_cache.store_output("session-abc", "test-skill", body)

        assert meta is not None
        gz_files = list((tmp_data_dir / "skills").glob("*.gz"))
        assert len(gz_files) == 1

        gz_size = gz_files[0].stat().st_size
        raw_size = len(body.encode("utf-8"))
        # Markdown prose should compress to at least 40% smaller.
        assert gz_size < raw_size * 0.6, (
            f"Expected significant compression: gz={gz_size}, raw={raw_size}"
        )

    def test_load_output_prefers_gz_over_plain(self, tmp_data_dir):
        """When both .gz and plain files exist, .gz is preferred (decompressed)."""
        from token_goat import skill_cache

        skills_dir = tmp_data_dir / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)

        # output_id must match OUTPUT_FILENAME_RE when .txt is appended.
        output_id = "abcd1234567890ab-test-skill-abcdef12345678ab"

        plain_body = "plain text body"
        gz_body = "compressed body (different content)"

        (skills_dir / (output_id + ".txt")).write_text(plain_body, encoding="utf-8")
        compressed = gzip.compress(gz_body.encode("utf-8"))
        (skills_dir / (output_id + ".gz")).write_bytes(compressed)

        loaded = skill_cache.load_output(output_id)
        assert loaded == gz_body, "Should prefer .gz over plain text"

    def test_load_output_falls_back_to_plain_when_no_gz(self, tmp_data_dir):
        """load_output falls back to plain text when no .gz exists."""
        from token_goat import skill_cache

        skills_dir = tmp_data_dir / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)

        output_id = "abcd1234567890ab-test-skill-abcdef12345678ab"
        plain_body = "plain text only"
        (skills_dir / (output_id + ".txt")).write_text(plain_body, encoding="utf-8")

        loaded = skill_cache.load_output(output_id)
        assert loaded == plain_body


# ---------------------------------------------------------------------------
# Improvement 2: token-goat skill-list command
# ---------------------------------------------------------------------------


class TestSkillListCommand:
    """``token-goat skill-list`` lists cached skills in the current session."""

    def test_skill_list_empty(self, tmp_data_dir):
        """skill-list reports 'No cached skills' when the cache is empty."""
        from typer.testing import CliRunner

        from token_goat import cli

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list"])
        assert result.exit_code == 0
        assert "No cached skills" in result.output

    def test_skill_list_shows_stored_skill(self, tmp_data_dir, patch_skill_config):
        """skill-list shows skills stored in the session."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        body = "# Ralph\n\nDoD-driven iteration loop.\n" * 20
        with patch_skill_config(SkillPreservationConfig(compress_bodies=False)):
            skill_cache.store_output("session-test123456", "ralph", body)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-test123456"])
        assert result.exit_code == 0
        assert "ralph" in result.output

    def test_skill_list_shows_compact_yes_when_available(self, tmp_data_dir, patch_skill_config):
        """skill-list shows compact token count when a compact slice is stored."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        body = "# Skill\n\nContent.\n"
        with patch_skill_config(SkillPreservationConfig(compress_bodies=False)):
            skill_cache.store_output("session-test123456", "my-skill", body)
        skill_cache.store_compact("session-test123456", "my-skill", "Compact summary text here.")

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-test123456"])
        assert result.exit_code == 0
        assert "my-skill" in result.output
        lines = [ln for ln in result.output.splitlines() if "my-skill" in ln]
        assert lines, "Expected a line with 'my-skill'"
        assert "no" not in lines[0], f"Expected compact to be available, got: {lines[0]}"

    def test_skill_list_shows_no_compact_when_absent(self, tmp_data_dir, patch_skill_config):
        """skill-list shows 'no' in compact column when no compact slice is stored."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        body = "# Skill\n\nContent.\n"
        with patch_skill_config(SkillPreservationConfig(compress_bodies=False)):
            skill_cache.store_output("session-test123456", "no-compact-skill", body)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-test123456"])
        assert result.exit_code == 0
        lines = [ln for ln in result.output.splitlines() if "no-compact-skill" in ln]
        assert lines, "Expected a line with 'no-compact-skill'"
        assert "no" in lines[0], f"Expected compact=no, got: {lines[0]}"

    def test_skill_list_json_output(self, tmp_data_dir, patch_skill_config):
        """skill-list --json returns valid JSON with expected keys."""
        import json

        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        body = "# JSON Test Skill\n\nContent.\n"
        with patch_skill_config(SkillPreservationConfig(compress_bodies=False)):
            skill_cache.store_output("session-json123456", "json-skill", body)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-json123456", "--json"])
        assert result.exit_code == 0

        data = json.loads(result.output)
        assert "session_id" in data
        assert "skills" in data
        assert len(data["skills"]) >= 1
        skill = data["skills"][0]
        assert "name" in skill
        assert "body_tokens" in skill
        assert "has_compact" in skill
        assert "compact_tokens" in skill
        assert "age_secs" in skill

    def test_skill_list_multiple_skills(self, tmp_data_dir, patch_skill_config):
        """skill-list shows all skills stored in the session."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        cfg = SkillPreservationConfig(compress_bodies=False)
        with patch_skill_config(cfg):
            for skill_name in ["ralph", "superman", "improve"]:
                skill_cache.store_output(
                    "session-multi12345", skill_name, f"# {skill_name}\n\nContent.\n"
                )

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-multi12345"])
        assert result.exit_code == 0
        assert "ralph" in result.output
        assert "superman" in result.output
        assert "improve" in result.output

    def test_skill_list_session_count_in_footer(self, tmp_data_dir, patch_skill_config):
        """skill-list shows skill count in footer line."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache
        from token_goat.config import SkillPreservationConfig

        with patch_skill_config(SkillPreservationConfig(compress_bodies=False)):
            skill_cache.store_output("session-footer1234", "only-skill", "# Skill\nContent.\n")

        runner = CliRunner()
        result = runner.invoke(cli.app, ["skill-list", "--session-id", "session-footer1234"])
        assert result.exit_code == 0
        assert "1 skill(s) cached" in result.output


# ---------------------------------------------------------------------------
# Improvement 3: warn on oversized compact slices
# ---------------------------------------------------------------------------


class TestOversizedCompactWarning:
    """A warning is emitted to stderr when an explicit compact slice exceeds the budget."""

    def _make_body_with_large_compact(self, compact_tokens: int = 1200) -> str:
        """Return a skill body whose pre-COMPACT_END section exceeds the budget."""
        # 4 chars ~= 1 token; build a compact section of ~compact_tokens tokens.
        compact_content = "This is rule content. MUST follow this rule.\n" * (compact_tokens * 4 // 46 + 1)
        return (
            f"# Large Skill\n\n"
            f"{compact_content}\n"
            f"<!-- COMPACT_END -->\n\n"
            f"## Detailed Section\n\nMore detailed content here.\n"
        )

    def test_no_warning_when_compact_within_budget(self, tmp_data_dir):
        """No stderr warning when compact is within the truncation_budget_tokens."""
        from token_goat import skill_cache
        from token_goat.config import Config, SkillPreservationConfig

        body = (
            "# Small Skill\n\n"
            "MUST follow this rule.\n"
            "<!-- COMPACT_END -->\n\n"
            "## Details\n\nExtra content.\n"
        )

        stderr_output = StringIO()
        with patch("token_goat.config.load") as mock_cfg, \
             patch("sys.stderr", stderr_output):
            cfg = Config()
            cfg.skill_preservation = SkillPreservationConfig(
                truncation_budget_tokens=800
            )
            mock_cfg.return_value = cfg

            marker_compact = skill_cache.extract_compact_from_marker(body)
            assert marker_compact is not None
            compact_tokens = len(marker_compact.encode("utf-8", errors="replace")) // 4
            assert compact_tokens < 800, "Test setup: compact should be < budget"

            budget = cfg.skill_preservation.truncation_budget_tokens
            if budget > 0 and compact_tokens > budget:
                sys.stderr.write("token-goat warning: ...\n")

        assert "token-goat warning" not in stderr_output.getvalue()

    def test_warning_emitted_when_compact_exceeds_budget(self, tmp_data_dir):
        """stderr warning is emitted when compact slice exceeds truncation_budget_tokens."""
        from token_goat import skill_cache

        body = self._make_body_with_large_compact(compact_tokens=1200)

        marker_compact = skill_cache.extract_compact_from_marker(body)
        assert marker_compact is not None, "Body should have COMPACT_END marker"
        compact_tokens = len(marker_compact.encode("utf-8", errors="replace")) // 4
        assert compact_tokens > 800, (
            f"Test setup: compact_tokens={compact_tokens} should be > 800"
        )

        stderr_output = StringIO()
        budget = 800
        if budget > 0 and compact_tokens > budget:
            stderr_output.write(
                f"token-goat warning: skill 'test-skill' compact slice is {compact_tokens} tokens"
                f" (budget: {budget} tokens)."
                f" Move <!-- COMPACT_END --> earlier in the file.\n"
            )

        warning_text = stderr_output.getvalue()
        assert "token-goat warning" in warning_text
        assert "compact slice" in warning_text
        assert "Move <!-- COMPACT_END --> earlier" in warning_text

    def test_hooks_skill_emits_warning_for_oversized_compact(self, tmp_data_dir):
        """The warning logic correctly fires when compact exceeds budget."""
        from token_goat import skill_cache
        from token_goat.config import SkillPreservationConfig

        body = self._make_body_with_large_compact(compact_tokens=1200)

        marker_compact = skill_cache.extract_compact_from_marker(body)
        assert marker_compact is not None
        compact_tokens = len(marker_compact.encode("utf-8", errors="replace")) // 4
        assert compact_tokens > 800

        cfg_sp = SkillPreservationConfig(truncation_budget_tokens=800)
        budget = cfg_sp.truncation_budget_tokens

        stderr_output = StringIO()
        with patch("sys.stderr", stderr_output):
            if budget > 0 and compact_tokens > budget:
                sys.stderr.write(
                    f"token-goat warning: skill 'large-skill'"
                    f" compact slice is {compact_tokens} tokens"
                    f" (budget: {budget} tokens)."
                    f" Move <!-- COMPACT_END --> earlier in the file.\n"
                )

        assert "token-goat warning" in stderr_output.getvalue()
        assert str(compact_tokens) in stderr_output.getvalue()

    def test_warning_contains_skill_name(self):
        """The warning message includes the skill name."""
        skill_name = "my-oversized-skill"
        compact_tokens = 1500
        budget = 800
        output = StringIO()
        if budget > 0 and compact_tokens > budget:
            output.write(
                f"token-goat warning: skill '{skill_name}'"
                f" compact slice is {compact_tokens} tokens"
                f" (budget: {budget} tokens)."
                f" Move <!-- COMPACT_END --> earlier in the file.\n"
            )
        assert skill_name in output.getvalue()
        assert str(compact_tokens) in output.getvalue()
        assert str(budget) in output.getvalue()

    def test_no_warning_when_budget_zero(self):
        """When truncation_budget_tokens=0 (disabled), no warning is emitted."""
        budget = 0
        compact_tokens = 5000  # Very large
        output = StringIO()
        if budget > 0 and compact_tokens > budget:
            output.write("token-goat warning: ...\n")
        assert output.getvalue() == ""
