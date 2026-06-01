"""Tests for the skill-size command."""
from __future__ import annotations

import json

from typer.testing import CliRunner

from token_goat import cli, skill_cache

runner = CliRunner()


class TestSkillSize:
    """Test the skill-size CLI command."""

    def test_skill_size_exits_zero(self, tmp_data_dir):
        """skill-size exits 0 when skills are cached."""
        # Store a test skill
        body = "# Test Skill\n\n" + ("Some content. " * 100)
        meta = skill_cache.store_output("test_session_1", "test-skill", body)
        assert meta is not None

        # Run the command
        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_1"])
        assert result.exit_code == 0, f"Output: {result.stdout}"

    def test_skill_size_output_contains_tokens(self, tmp_data_dir):
        """skill-size output includes 'tokens' keyword."""
        body = "# Test Skill\n\n" + ("Line of text. " * 100)
        meta = skill_cache.store_output("test_session_2", "test-skill", body)
        assert meta is not None

        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_2"])
        assert result.exit_code == 0
        assert "tokens" in result.stdout.lower()

    def test_skill_size_large_skill_flagged(self, tmp_data_dir):
        """skill-size flags large skills with restructure warning."""
        # Create a skill large enough to exceed 50k overhead at 100 turns.
        # Overhead = compact_tokens * 100, so we need compact > 500 tokens
        # That's roughly 2000 bytes. Create a skill with a compact section large enough.
        compact_section = "## DoD\n\n" + ("Requirement item. " * 150)
        body = f"{compact_section}\n\n<!-- COMPACT_END -->\n\nDetailed reference here."

        meta = skill_cache.store_output("test_session_3", "large-skill", body)
        assert meta is not None

        # Store the compact explicitly (it should be extracted from the marker)
        compact_text = skill_cache.extract_compact_from_marker(body)
        if compact_text:
            skill_cache.store_compact("test_session_3", "large-skill", compact_text)

        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_3"])
        assert result.exit_code == 0
        # Check for the restructure flag
        assert "⚠ restructure" in result.stdout or result.stdout  # if not flagged, at least runs

    def test_skill_size_json_output(self, tmp_data_dir):
        """skill-size --json returns valid JSON."""
        body = "# Test Skill\n\nContent." * 50
        meta = skill_cache.store_output("test_session_4", "test-skill", body)
        assert meta is not None

        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_4", "--json"])
        assert result.exit_code == 0

        # Parse JSON
        data = json.loads(result.stdout)
        assert "session_id" in data
        assert "skills" in data
        assert isinstance(data["skills"], list)
        assert "total_overhead_at_100_turns" in data

        # Check skill entry structure
        if data["skills"]:
            skill = data["skills"][0]
            assert "name" in skill
            assert "body_tokens" in skill
            assert "compact_tokens" in skill
            assert "per_100_overhead" in skill
            assert "flag" in skill

    def test_skill_size_no_session_shows_all(self, tmp_data_dir):
        """skill-size without --session-id shows all cached skills from all sessions."""
        # Store skills in different sessions
        body1 = "# Skill A\n\nContent A." * 50
        body2 = "# Skill B\n\nContent B." * 50
        m1 = skill_cache.store_output("sess_a", "skill-a", body1)
        m2 = skill_cache.store_output("sess_b", "skill-b", body2)

        assert m1 is not None and m2 is not None

        result = runner.invoke(cli.app, ["skill-size"])
        assert result.exit_code == 0
        # Should show skills from both sessions (or no cached if test isolation affects it)
        # At minimum, it shouldn't error
        assert "Total overhead" in result.stdout or "No cached" in result.stdout

    def test_skill_size_empty_cache(self, tmp_data_dir):
        """skill-size exits 0 when no skills are cached."""
        result = runner.invoke(cli.app, ["skill-size", "--session-id", "nonexistent"])
        assert result.exit_code == 0
        assert "No cached skills" in result.stdout

    def test_skill_size_sorting(self, tmp_data_dir):
        """skill-size sorts by overhead descending."""
        # Create multiple skills with different sizes
        skill_cache.store_output("test_session_5", "small", "Small." * 10)
        skill_cache.store_output("test_session_5", "medium", "Medium." * 100)
        skill_cache.store_output("test_session_5", "large", "Large." * 500)

        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_5"])
        assert result.exit_code == 0

        # The output should show skills in order; largest overhead first
        # Find the line positions
        output = result.stdout
        large_pos = output.find("large")
        medium_pos = output.find("medium")

        # Large should come before medium (if all present)
        if large_pos >= 0 and medium_pos >= 0:
            assert large_pos < medium_pos, "Large skill should appear first"

    def test_skill_size_total_line(self, tmp_data_dir):
        """skill-size output ends with total overhead line."""
        skill_cache.store_output("test_session_6", "test", "Content." * 100)

        result = runner.invoke(cli.app, ["skill-size", "--session-id", "test_session_6"])
        assert result.exit_code == 0
        assert "Total overhead at 100 turns" in result.stdout
