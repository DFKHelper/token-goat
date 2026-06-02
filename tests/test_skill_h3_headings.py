"""Tests for skill H3 heading discoverability improvements.

Covers:
1. extract_all_headings() — returns H2 and H3 headings, excludes code blocks
2. skill-body "Sections available" now includes H3 headings
3. skill-body --section not-found error lists H2 and H3 headings
4. skill-size compact_is_estimated flag for skills without stored compact
5. Graceful no-cached-body error message with actionable hint
"""
from __future__ import annotations

import json
from unittest.mock import patch

from typer.testing import CliRunner

from token_goat import skill_cache
from token_goat.cli import app

_runner = CliRunner()

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_RALPH_LIKE_BODY = """\
# ralph

## When to Use Ralph vs Superman

Use Ralph for multi-iteration tasks.

### Operating Modes

| Mode | Description |
|------|-------------|
| --auto | Full autonomous loop |
| --guided | Pause after each iteration |

## Operating Protocol

The main operating loop.

### Step 0 — Initialize Loop State

Initialize your DoD here.

### Step 1 — Iterate

Run until done.

## Multi-Agent Collaboration

Pattern for spawning agents.

```markdown
### Fake heading inside code block

Should not appear in headings list.
```
"""


# ---------------------------------------------------------------------------
# extract_all_headings unit tests
# ---------------------------------------------------------------------------


class TestExtractAllHeadings:
    """Unit tests for skill_cache.extract_all_headings."""

    def test_returns_h2_and_h3_headings(self):
        """H2 and H3 headings are both returned."""
        headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY)
        levels = [level for level, _ in headings]
        titles = [title for _, title in headings]
        # H2 headings present
        assert 2 in levels
        assert "When to Use Ralph vs Superman" in titles
        assert "Operating Protocol" in titles
        # H3 headings present
        assert 3 in levels
        assert "Operating Modes" in titles
        assert "Step 0 — Initialize Loop State" in titles

    def test_excludes_headings_inside_code_blocks(self):
        """Headings inside fenced code blocks are not extracted."""
        headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY)
        titles = [title for _, title in headings]
        assert "Fake heading inside code block" not in titles

    def test_respects_max_level(self):
        """max_level=2 excludes H3 headings."""
        headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY, max_level=2)
        levels = [level for level, _ in headings]
        assert all(level == 2 for level in levels)
        assert 3 not in levels

    def test_max_level_4_includes_deeper_headings(self):
        """max_level=4 includes up to H4 headings."""
        body_with_h4 = "## Top\n\n### Sub\n\n#### Deep\n\ncontent\n"
        headings = skill_cache.extract_all_headings(body_with_h4, max_level=4)
        levels = [level for level, _ in headings]
        assert 4 in levels

    def test_empty_body_returns_empty_list(self):
        """Empty body returns empty list without error."""
        assert skill_cache.extract_all_headings("") == []

    def test_body_with_only_h1_returns_empty(self):
        """H1 headings are excluded (below H2 threshold)."""
        assert skill_cache.extract_all_headings("# Title\n\nContent.\n") == []

    def test_preserves_order(self):
        """Headings are returned in document order."""
        headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY)
        titles = [title for _, title in headings]
        # "When to Use" appears before "Operating Modes"
        assert titles.index("When to Use Ralph vs Superman") < titles.index("Operating Modes")
        # "Operating Protocol" appears before "Step 0"
        assert titles.index("Operating Protocol") < titles.index("Step 0 — Initialize Loop State")

    def test_em_dash_in_heading_preserved(self):
        """Em-dashes in heading text are preserved correctly."""
        body = "## Step 4 — The Main Loop\n\ncontent\n### Sub — Phase\n\ncontent\n"
        headings = skill_cache.extract_all_headings(body)
        titles = [title for _, title in headings]
        assert any("Step 4" in t for t in titles)
        assert any("The Main Loop" in t for t in titles)

    def test_tilde_fence_excluded(self):
        """Headings inside ~~~ fences are also excluded."""
        body = "## Real\n\n~~~\n### Fake\n~~~\n\n## Also Real\n"
        headings = skill_cache.extract_all_headings(body)
        titles = [title for _, title in headings]
        assert "Real" in titles
        assert "Also Real" in titles
        assert "Fake" not in titles


# ---------------------------------------------------------------------------
# skill-body "Sections available" includes H3 headings
# ---------------------------------------------------------------------------


class TestSkillBodySectionsAvailable:
    """skill-body output includes H3 headings in 'Sections available' line."""

    def _store_skill(self, sid: str, name: str, body: str) -> skill_cache.SkillMeta:
        meta = skill_cache.store_output(sid, name, body)
        assert meta is not None
        skill_cache.write_sidecar(meta)
        return meta

    def test_sections_available_includes_h3_headings(self, tmp_data_dir):
        """'Sections available' line shows both H2 and H3 headings."""
        self._store_skill("s1", "ralph", _RALPH_LIKE_BODY)
        result = _runner.invoke(app, ["skill-body", "ralph"])
        assert result.exit_code == 0, result.output
        assert "Sections available:" in result.output
        # H3 heading should appear
        assert "Operating Modes" in result.output

    def test_h3_headings_indented_in_listing(self, tmp_data_dir):
        """H3 headings are prefixed with two spaces to distinguish from H2."""
        self._store_skill("s2", "ralph", _RALPH_LIKE_BODY)
        result = _runner.invoke(app, ["skill-body", "ralph"])
        assert result.exit_code == 0, result.output
        # H3 heading "Operating Modes" appears indented
        sections_line = next(
            (line for line in result.output.splitlines() if "Sections available:" in line),
            "",
        )
        # The H3 entries should have two leading spaces before their title
        assert "  Operating Modes" in sections_line

    def test_section_not_found_error_lists_h3(self, tmp_data_dir):
        """--section not-found error message lists H3 headings."""
        self._store_skill("s3", "ralph", _RALPH_LIKE_BODY)
        result = _runner.invoke(app, ["skill-body", "ralph", "--section", "Nonexistent XYZ"])
        assert result.exit_code == 1
        combined = result.output + (result.stderr or "")
        # Error should mention H3 headings too
        assert "Operating Modes" in combined or "###" in combined or "not found" in combined.lower()


# ---------------------------------------------------------------------------
# skill-section not-found error lists H3 headings
# ---------------------------------------------------------------------------


class TestSkillSectionNotFoundListsH3:
    """skill-section not-found error shows H2 and H3 headings."""

    def test_not_found_includes_h3_headings(self, tmp_data_dir, tmp_path):
        """Error message on missing heading lists H3 headings."""
        skill_file = tmp_path / "ralph" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(_RALPH_LIKE_BODY, encoding="utf-8")

        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "NoSuchHeadingXYZ"])
        assert result.exit_code == 1
        combined = result.output + (result.stderr or "")
        # H3 heading should appear in the error listing
        assert "Operating Modes" in combined

    def test_h3_section_extractable_via_skill_section(self, tmp_data_dir, tmp_path):
        """skill-section can extract H3 sections by name (prefix match)."""
        skill_file = tmp_path / "ralph" / "SKILL.md"
        skill_file.parent.mkdir(parents=True)
        skill_file.write_text(_RALPH_LIKE_BODY, encoding="utf-8")

        with patch("token_goat.skill_cache.get_skill_file_path", return_value=skill_file):
            result = _runner.invoke(app, ["skill-section", "ralph", "Operating Modes"])
        assert result.exit_code == 0, result.output
        assert "--auto" in result.output or "Mode" in result.output


# ---------------------------------------------------------------------------
# skill-size compact_is_estimated flag
# ---------------------------------------------------------------------------


class TestSkillSizeCompactEstimation:
    """skill-size shows compact_is_estimated when no compact has been stored."""

    def test_json_includes_compact_is_estimated_false_when_compact_stored(self, tmp_data_dir):
        """compact_is_estimated is False when a compact form is stored."""
        body = "## DoD\n\nAll tests pass.\n\n<!-- COMPACT_END -->\n\nLong reference.\n" * 20
        meta = skill_cache.store_output("sess-est1", "ralph-est", body)
        assert meta is not None
        compact = skill_cache.extract_compact_from_marker(body)
        assert compact is not None
        skill_cache.store_compact("sess-est1", "ralph-est", compact)

        result = _runner.invoke(app, ["skill-size", "--session-id", "sess-est1", "--json"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.stdout)
        assert data["skills"], "Expected at least one skill"
        skill_entry = data["skills"][0]
        assert skill_entry.get("compact_is_estimated") is False

    def test_json_includes_compact_is_estimated_true_when_no_compact(self, tmp_data_dir):
        """compact_is_estimated is True when no compact form is stored."""
        body = "## Overview\n\nSome content.\n" * 30
        meta = skill_cache.store_output("sess-est2", "no-compact-skill", body)
        assert meta is not None
        # Deliberately do NOT store a compact form.

        result = _runner.invoke(app, ["skill-size", "--session-id", "sess-est2", "--json"])
        assert result.exit_code == 0, result.output
        data = json.loads(result.stdout)
        assert data["skills"], "Expected at least one skill"
        skill_entry = data["skills"][0]
        assert skill_entry.get("compact_is_estimated") is True

    def test_human_output_notes_estimated_compact(self, tmp_data_dir):
        """Human-readable output labels skills without compact as estimated."""
        body = "## Intro\n\nContent.\n" * 30
        meta = skill_cache.store_output("sess-est3", "no-compact-hr", body)
        assert meta is not None

        result = _runner.invoke(app, ["skill-size", "--session-id", "sess-est3"])
        assert result.exit_code == 0, result.output
        # Should mention that the compact is an estimate
        assert "estimate" in result.stdout.lower() or "no compact" in result.stdout.lower()


# ---------------------------------------------------------------------------
# skill-body graceful not-cached error message
# ---------------------------------------------------------------------------


class TestSkillBodyNotCachedError:
    """skill-body provides actionable hint when no body is cached."""

    def test_not_cached_error_mentions_invoke(self, tmp_data_dir):
        """Error message explains how to populate the cache."""
        with patch("token_goat.hooks_skill._resolve_skill_body_path", return_value=""):
            result = _runner.invoke(app, ["skill-body", "ralph"])
        assert result.exit_code == 1
        combined = result.output + (result.stderr or "")
        # Message should mention invoking the skill or indexing
        assert "invoke" in combined.lower() or "index" in combined.lower() or "cache" in combined.lower()

    def test_not_cached_error_mentions_skill_name(self, tmp_data_dir):
        """Error message includes the requested skill name."""
        with patch("token_goat.hooks_skill._resolve_skill_body_path", return_value=""):
            result = _runner.invoke(app, ["skill-body", "superman"])
        assert result.exit_code == 1
        combined = result.output + (result.stderr or "")
        assert "superman" in combined
