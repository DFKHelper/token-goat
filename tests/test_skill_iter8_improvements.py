"""Tests for skill context savings improvements (iteration 8 of 10).

Covers:
1. `token-goat doctor` skill cache health section — distinct skill count,
   total bytes, oldest/newest timestamps, and stale-entry detection.
2. Skill stats tracking — SOURCE_SKILL bucket, skill_compact_served kind
   mapping, and stats recording in hooks_skill.
3. Codex bridge skill event verification — post-skill correctly has
   codex_event=None (Codex has no Skill tool), and the bridge registry is
   aligned so Codex users still get all applicable hook events.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Improvement 1: doctor skill cache health section
# ---------------------------------------------------------------------------


class TestDoctorSkillCacheHealth:
    """doctor emits a skill cache health section."""

    @pytest.fixture(autouse=True)
    def _patch_doctor_paths(self, tmp_path, monkeypatch):
        """Redirect data_dir, hook_wrapper_path, and hook_wrapper_content for doctor tests.

        Replaces the repeated 3-line block in every test method::

            monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
            monkeypatch.setattr(paths, "hook_wrapper_path", lambda: tmp_path / "bin" / "tg-hook.cmd")
            monkeypatch.setattr(paths, "hook_wrapper_content", lambda: "")
        """
        from token_goat import paths
        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
        monkeypatch.setattr(paths, "hook_wrapper_path", lambda: tmp_path / "bin" / "tg-hook.cmd")
        monkeypatch.setattr(paths, "hook_wrapper_content", lambda: "")

    def test_doctor_skill_section_present(self, monkeypatch):
        """doctor output contains the 'Skill cache health' heading."""
        from typer.testing import CliRunner

        from token_goat import cli

        runner = CliRunner()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Skill cache health" in result.output

    def test_doctor_skill_section_no_cache(self, monkeypatch):
        """When no skills are cached, doctor shows '(none)' for the skill section."""
        from typer.testing import CliRunner

        from token_goat import cli

        runner = CliRunner()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Skill cache health" in result.output
        assert "no skill bodies cached" in result.output

    def test_doctor_skill_section_with_cached_skills(self, tmp_data_dir):
        """When skills are cached, doctor reports count, bytes, age."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache

        # Store two skills to populate the cache.
        session_id = "s-doctor-skill-test-001"
        body_a = "# Alpha skill\n\n" + "A" * 5000
        body_b = "# Beta skill\n\n" + "B" * 6000
        skill_cache.store_output(session_id, "alpha-skill", body_a)
        skill_cache.store_output(session_id, "beta-skill", body_b)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Skill cache health" in result.output
        # Should show at least 2 skills cached.
        assert "distinct skills" in result.output
        assert "cached entries" in result.output
        assert "total body bytes" in result.output
        assert "oldest entry" in result.output
        assert "newest entry" in result.output

    def test_doctor_skill_stale_detection(self, tmp_path, monkeypatch, tmp_data_dir):
        """When a skill's source file is newer than its cache entry, doctor flags it stale."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache

        # Create a source file on disk.
        src_file = tmp_path / "my-skill.md"
        src_file.write_text("# My Skill\n\n" + "X" * 5000, encoding="utf-8")

        # Store the skill body, recording the source path.
        session_id = "s-doctor-stale-test-001"
        body = src_file.read_text(encoding="utf-8")
        meta = skill_cache.store_output(
            session_id, "my-skill", body, source_path=str(src_file)
        )
        assert meta is not None
        skill_cache.write_sidecar(meta)

        # Now "update" the source file with a future mtime so it's newer than the cache.
        future_ts = time.time() + 3600
        import os
        os.utime(str(src_file), (future_ts, future_ts))

        runner = CliRunner()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Skill cache health" in result.output
        # Should flag the stale entry.
        assert "stale" in result.output.lower()

    def test_doctor_skill_no_stale_when_fresh(self, tmp_path, monkeypatch, tmp_data_dir):
        """When source files are not newer than cache, doctor shows 0 stale entries."""
        from typer.testing import CliRunner

        from token_goat import cli, skill_cache

        # Store a skill without a source_path (no staleness check possible).
        session_id = "s-doctor-fresh-test-001"
        body = "# Fresh skill\n\n" + "F" * 5000
        meta = skill_cache.store_output(session_id, "fresh-skill", body)
        assert meta is not None
        skill_cache.write_sidecar(meta)

        runner = CliRunner()
        result = runner.invoke(cli.app, ["doctor"])
        assert result.exit_code == 0
        assert "Skill cache health" in result.output
        assert "stale entries" in result.output
        # Without a source path, stale check does not fire; should show 0.
        assert "0" in result.output


# ---------------------------------------------------------------------------
# Improvement 2: skill stats tracking — SOURCE_SKILL and skill_compact_served
# ---------------------------------------------------------------------------


class TestSourceSkillBucket:
    """SOURCE_SKILL is exported and skill_compact_served maps to it."""

    def test_source_skill_exported(self):
        """SOURCE_SKILL is accessible from stats module."""
        from token_goat.stats import SOURCE_SKILL
        assert isinstance(SOURCE_SKILL, str)
        assert SOURCE_SKILL == "skill"

    def test_skill_compact_served_maps_to_source_skill(self):
        """skill_compact_served kind maps to SOURCE_SKILL bucket."""
        from token_goat.stats import SOURCE_SKILL, kind_to_source
        assert kind_to_source("skill_compact_served") == SOURCE_SKILL

    def test_skill_cached_maps_to_source_skill(self):
        """skill_cached kind maps to SOURCE_SKILL bucket."""
        from token_goat.stats import SOURCE_SKILL, kind_to_source
        assert kind_to_source("skill_cached") == SOURCE_SKILL

    def test_source_skill_in_kind_to_source(self):
        """Both skill kinds are present in the _KIND_TO_SOURCE mapping."""
        from token_goat.stats import _KIND_TO_SOURCE, SOURCE_SKILL
        assert "skill_compact_served" in _KIND_TO_SOURCE
        assert "skill_cached" in _KIND_TO_SOURCE
        assert _KIND_TO_SOURCE["skill_compact_served"] == SOURCE_SKILL
        assert _KIND_TO_SOURCE["skill_cached"] == SOURCE_SKILL

    def test_source_skill_in_all_exports(self):
        """SOURCE_SKILL appears in stats.__all__."""
        import token_goat.stats as stats_mod
        assert "SOURCE_SKILL" in stats_mod.__all__


class TestSkillCompactStatRecording:
    """_record_skill_compact_stat writes skill_compact_served rows to the DB."""

    def test_record_skill_compact_stat_calls_db(self):
        """_record_skill_compact_stat records with the correct kind and values."""
        from token_goat.hooks_skill import _record_skill_compact_stat

        # Direct call with a real DB mock.
        captured: list[dict] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail):
            captured.append({
                "project_hash": project_hash,
                "kind": kind,
                "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved,
                "detail": detail,
            })

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            _record_skill_compact_stat("ralph", 10000, 2500)

        assert len(captured) == 1
        row = captured[0]
        assert row["kind"] == "skill_compact_served"
        assert row["bytes_saved"] == 10000
        assert row["tokens_saved"] == 2500
        assert "ralph" in row["detail"]

    def test_record_skill_compact_stat_swallows_db_error(self):
        """_record_skill_compact_stat never raises even if the DB fails."""
        from token_goat.hooks_skill import _record_skill_compact_stat

        with patch("token_goat.db.record_stat", side_effect=RuntimeError("DB offline")):
            # Should not raise.
            _record_skill_compact_stat("some-skill", 5000, 1250)

    def test_post_skill_records_compact_stat_for_large_body(self, tmp_data_dir):
        """post_skill records skill_compact_served when it stores a compact for a large body."""
        from token_goat.hooks_skill import post_skill

        # Build a large body with an explicit COMPACT_END marker.
        compact_part = "## Quick Reference\n\nKey rule A.\nKey rule B.\n"
        full_body = compact_part + "\n<!-- COMPACT_END -->\n\n" + "Z" * 5000

        payload = {
            "tool_name": "Skill",
            "tool_input": {"skill": "bigskill"},
            "tool_result": full_body,
            "session_id": "s-post-skill-stat-test-001",
        }

        recorded: list[dict] = []

        def fake_record_stat(project_hash, kind, *, bytes_saved, tokens_saved, detail):
            recorded.append({"kind": kind, "bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.db.record_stat", side_effect=fake_record_stat):
            result = post_skill(payload)

        # Hook should always continue.
        assert result.get("continue", True) is not False

        # skill_compact_served should have been recorded with positive savings.
        compact_rows = [r for r in recorded if r["kind"] == "skill_compact_served"]
        assert len(compact_rows) == 1, f"Expected 1 skill_compact_served row, got: {recorded}"
        assert compact_rows[0]["bytes_saved"] > 0
        assert compact_rows[0]["tokens_saved"] > 0


# ---------------------------------------------------------------------------
# Improvement 3: Codex bridge skill event verification
# ---------------------------------------------------------------------------


class TestCodexBridgeSkillEvents:
    """Verify the Codex bridge handles skill events correctly."""

    def test_post_skill_has_no_codex_event(self):
        """post-skill has codex_event=None because Codex has no Skill tool."""
        from token_goat import hook_registry
        event = hook_registry.lookup("post-skill")
        assert event is not None
        assert event.codex_event is None, (
            "post-skill should not be bridged to Codex — Codex has no Skill tool"
        )

    def test_post_skill_has_claude_event(self):
        """post-skill IS wired for Claude Code (PostToolUse:Skill)."""
        from token_goat import hook_registry
        event = hook_registry.lookup("post-skill")
        assert event is not None
        assert event.claude_event == "PostToolUse"
        assert event.claude_matcher == "Skill"

    def test_codex_events_do_not_include_post_skill(self):
        """codex_events() does not include post-skill."""
        from token_goat import hook_registry
        codex_names = {e.name for e in hook_registry.codex_events()}
        assert "post-skill" not in codex_names

    def test_codex_events_include_core_events(self):
        """Codex users still receive session-start, pre-compact, pre-read, post-edit."""
        from token_goat import hook_registry
        codex_names = {e.name for e in hook_registry.codex_events()}
        required = {"session-start", "pre-compact", "pre-read", "post-edit"}
        missing = required - codex_names
        assert not missing, (
            f"Codex is missing required events: {missing}. "
            f"Codex events: {sorted(codex_names)}"
        )

    def test_harness_property_for_post_skill(self):
        """post-skill harness property returns 'claude' (not 'both' or 'codex')."""
        from token_goat import hook_registry
        event = hook_registry.lookup("post-skill")
        assert event is not None
        assert event.harness == "claude"

    def test_skill_event_comment_in_registry(self):
        """The post-skill registry entry documents why Codex is excluded."""
        # Read the source to verify the explanatory comment is present.
        import pathlib
        registry_src = pathlib.Path(__file__).parent.parent / "src" / "token_goat" / "hook_registry.py"
        content = registry_src.read_text(encoding="utf-8")
        # The comment "Codex has no Skill tool" should appear near the post-skill entry.
        assert "Codex has no Skill tool" in content, (
            "hook_registry.py should document why post-skill is not bridged to Codex"
        )
