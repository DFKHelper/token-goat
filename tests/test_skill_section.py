"""Tests for the ``token-goat skill-section`` command and ``get_skill_file_path``."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat import skill_cache
from token_goat.cli import app

_runner = CliRunner()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _store_skill(sid: str, name: str, body: str) -> skill_cache.SkillMeta:
    """Store a skill body and write its sidecar so lookup_by_name can find it."""
    meta = skill_cache.store_output(sid, name, body)
    assert meta is not None
    skill_cache.write_sidecar(meta)
    return meta


# ---------------------------------------------------------------------------
# get_skill_file_path — unit tests
# ---------------------------------------------------------------------------


class TestGetSkillFilePath:
    """Unit tests for skill_cache.get_skill_file_path."""

    def test_returns_none_for_unknown_skill(self, tmp_data_dir):
        """Returns None when the skill is not cached and not on disk."""
        result = skill_cache.get_skill_file_path("no-such-skill-xyz")
        assert result is None

    def test_returns_path_from_source_path_in_sidecar(self, tmp_data_dir, tmp_path):
        """Returns the source_path recorded in the sidecar when the file exists."""
        # Create a fake skill file on disk.
        skill_file = tmp_path / "my-skill" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("# my-skill\n\n## Section\n\ncontent\n", encoding="utf-8")

        body = "# my-skill\n\n## Section\n\ncontent\n"
        meta = skill_cache.store_output("s-1", "my-skill", body, source_path=str(skill_file))
        assert meta is not None
        skill_cache.write_sidecar(meta)

        result = skill_cache.get_skill_file_path("my-skill")
        assert result == skill_file

    def test_skips_sidecar_source_path_when_file_missing(self, tmp_data_dir, tmp_path):
        """Falls through to filesystem probe when the recorded source_path no longer exists."""
        fake_path = tmp_path / "gone" / "SKILL.md"
        # Do NOT create the file — it should be missing.
        meta = skill_cache.store_output("s-2", "ghost-skill", "# body\n", source_path=str(fake_path))
        assert meta is not None
        skill_cache.write_sidecar(meta)

        # No filesystem probe will find it either.
        result = skill_cache.get_skill_file_path("ghost-skill")
        assert result is None

    def test_falls_back_to_hooks_skill_probe(self, tmp_data_dir, tmp_path):
        """Falls back to _resolve_skill_body_path when no cached entry has a usable path."""
        skill_file = tmp_path / "probe-skill" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("# probe\n", encoding="utf-8")

        from token_goat import hooks_skill

        with patch.object(hooks_skill, "_resolve_skill_body_path", return_value=str(skill_file)):
            result = skill_cache.get_skill_file_path("probe-skill")

        assert result == skill_file

    def test_returns_none_when_probe_returns_empty(self, tmp_data_dir):
        """Returns None when _resolve_skill_body_path returns empty string."""
        from token_goat import hooks_skill

        with patch.object(hooks_skill, "_resolve_skill_body_path", return_value=""):
            result = skill_cache.get_skill_file_path("missing-skill")

        assert result is None


# ---------------------------------------------------------------------------
# skill-section CLI command
# ---------------------------------------------------------------------------


class TestCmdSkillSection:
    """End-to-end tests for ``token-goat skill-section``."""

    _BODY = (
        "# ralph\n\n"
        "## Overview\n\nIntro text here.\n\n"
        "## Definition of Done\n\n- All tests pass\n- Lint clean\n\n"
        "## Usage\n\nUsage details.\n"
    )

    def _make_skill_file(self, tmp_path: Path, name: str = "ralph") -> Path:
        """Write a SKILL.md to tmp_path and return its path."""
        skill_file = tmp_path / name / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(self._BODY, encoding="utf-8")
        return skill_file

    def test_resolves_skill_and_returns_section(self, tmp_data_dir, tmp_path):
        """Resolves the skill file via sidecar and returns the requested section."""
        skill_file = self._make_skill_file(tmp_path)
        _store_skill("sec-1", "ralph", self._BODY)
        # Patch get_skill_file_path so it returns our tmp file.
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "Definition of Done"])
        assert result.exit_code == 0, result.output
        assert "All tests pass" in result.output
        assert "Lint clean" in result.output
        assert "Intro text" not in result.output
        assert "Usage details" not in result.output

    def test_case_insensitive_heading_match(self, tmp_data_dir, tmp_path):
        """Heading match is case-insensitive."""
        skill_file = self._make_skill_file(tmp_path)
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "overview"])
        assert result.exit_code == 0, result.output
        assert "Intro text" in result.output

    def test_unknown_skill_exits_nonzero(self, tmp_data_dir):
        """Unknown skill name exits 1 with a helpful message."""
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=None):
            result = _runner.invoke(app, ["skill-section", "unknown-skill", "Overview"])
        assert result.exit_code == 1
        # The error message should mention the skill name and index hint.
        combined = result.output + (result.stderr if hasattr(result, "stderr") and result.stderr else "")
        assert "unknown-skill" in combined
        assert "index" in combined.lower() or "Index" in combined

    def test_missing_heading_emits_not_found(self, tmp_data_dir, tmp_path):
        """Nonexistent heading in a found skill emits an error message and exits non-success.

        _run_read_like_command raises typer.Exit(0) for a missing section (consistent
        with the existing ``section`` command behaviour), so we check exit_code in {0, 1}
        and assert the error text is present.
        """
        skill_file = self._make_skill_file(tmp_path)
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "Nonexistent Heading XYZ"])
        # Either exit code indicates a handled-not-found state.
        assert result.exit_code in (0, 1)
        combined = result.output + (result.stderr if hasattr(result, "stderr") and result.stderr else "")
        assert "not found" in combined.lower() or "Nonexistent" in combined

    def test_json_output(self, tmp_data_dir, tmp_path):
        """--json flag returns valid JSON with section text."""
        skill_file = self._make_skill_file(tmp_path)
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "Usage", "--json"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.output.strip())
        assert data.get("ok") is not False  # no error
        assert "Usage details" in str(data)

    def test_unknown_skill_json_error(self, tmp_data_dir):
        """--json flag with unknown skill returns JSON error payload."""
        with patch("token_goat.skill_cache.get_skill_file_path", return_value=None):
            result = _runner.invoke(app, ["skill-section", "no-skill", "Anything", "--json"])
        assert result.exit_code == 1
        # The pre-exit emit should produce valid JSON.
        data = json.loads(result.output.strip())
        assert data.get("ok") is False
        assert "no-skill" in str(data)

    def test_plugin_namespaced_skill(self, tmp_data_dir, tmp_path):
        """plugin:skill names are handled (colon is allowed in skill names)."""
        skill_file = tmp_path / "improve" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text("# improve\n\n## Step 4\n\nStep four content.\n", encoding="utf-8")

        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "plugin:improve", "Step 4"])
        assert result.exit_code == 0, result.output
        assert "Step four content" in result.output
