"""Tests for skill context savings accuracy improvements (iteration 4).

Covers:
1. Pre-read hook: marketplace cache path detection
   (_detect_skill_name_from_path handles plugins/cache/<mkt>/<plugin>/<ver>/skills/<name>)
2. generate_compact_summary flat-file fallback
   (flat prose / no headings → first prose paragraph included in compact)
3. extract_all_headings with max_level=4 includes H4 headings
4. skill-body / skill-section CLI surface H4 headings in error messages
"""
from __future__ import annotations

from token_goat import hooks_read, skill_cache

# ---------------------------------------------------------------------------
# Improvement 1: marketplace cache path detection in _detect_skill_name_from_path
# ---------------------------------------------------------------------------


class TestMarketplaceCachePathDetection:
    """_detect_skill_name_from_path handles deep marketplace cache layouts."""

    def test_legacy_flat_layout(self):
        """Standard user-skills flat layout still works."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph.md"
        )
        assert result == "ralph"

    def test_legacy_subdir_layout(self):
        """Standard user-skills subdir layout still works."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_legacy_plugin_flat_layout(self):
        """Plugin flat layout (single segment before skills/) still works."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/myplugin/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_marketplace_two_segment_layout(self):
        """Marketplace cache with two segments (marketplace + plugin) before skills/."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/cache/myplugin/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_marketplace_four_segment_layout(self):
        """Marketplace cache with four segments (cache/marketplace/plugin/version)."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/cache/registry.example.com/myplugin/1.0.0/skills/ralph/SKILL.md"
        )
        assert result == "ralph"

    def test_marketplace_hyphenated_plugin_name(self):
        """Hyphenated plugin and skill names are extracted correctly."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/plugins/cache/registry/plugin-name/2.1.3/skills/commit-commands/SKILL.md"
        )
        assert result == "commit-commands"

    def test_windows_marketplace_path(self):
        r"""Windows backslash paths through marketplace cache are resolved."""
        result = hooks_read._detect_skill_name_from_path(
            r"C:\Users\user\.claude\plugins\cache\registry\myplugin\1.0.0\skills\ralph\SKILL.md"
        )
        assert result == "ralph"

    def test_non_skill_file_returns_none(self):
        """Non-skill paths still return None."""
        assert hooks_read._detect_skill_name_from_path("/home/user/.claude/settings.json") is None
        assert hooks_read._detect_skill_name_from_path("/home/user/project/src/main.py") is None
        assert hooks_read._detect_skill_name_from_path("") is None

    def test_case_insensitive_skill_md(self):
        """SKILL.MD (uppercase) is matched case-insensitively."""
        result = hooks_read._detect_skill_name_from_path(
            "/home/user/.claude/skills/ralph/SKILL.MD"
        )
        assert result == "ralph"


# ---------------------------------------------------------------------------
# Improvement 2: generate_compact_summary flat-file fallback
# ---------------------------------------------------------------------------


class TestCompactSummaryFlatFileFallback:
    """generate_compact_summary includes first prose for flat (unstructured) skills."""

    def test_truly_flat_prose_included(self):
        """A skill with only plain prose (no headings, no rule keywords) returns prose snippet."""
        body = (
            "This skill does something very specific for the agent. "
            "When invoked, it configures the session with a particular behavior pattern."
        )
        result = skill_cache.generate_compact_summary(body)
        assert result != ""
        assert "skill does something very specific" in result

    def test_flat_prose_fallback_not_triggered_when_headings_present(self):
        """When headings exist, the prose fallback is suppressed (headings already orient)."""
        body = "## Overview\n\nSome prose.\n\n## Rules\n\nMore prose."
        result = skill_cache.generate_compact_summary(body)
        # Headings are present — fallback should not add redundant prose
        assert "**Sections:**" in result
        # The "Some prose." line (< 20 chars after strip) would be skipped anyway,
        # but even longer lines should not appear separately as the fallback.
        assert result.count("Some prose") == 0

    def test_flat_prose_fallback_not_triggered_when_rules_present(self):
        """When CRITICAL/MUST/NEVER/RULE lines exist, prose fallback is suppressed."""
        body = "CRITICAL: Always do this.\n\nSome long plain prose that could be the fallback."
        result = skill_cache.generate_compact_summary(body)
        assert "CRITICAL" in result
        # Prose fallback not added because rule_lines are non-empty
        assert "Some long plain prose" not in result

    def test_flat_prose_skips_short_lines(self):
        """Lines under 20 chars are too short to be useful prose and are skipped."""
        body = "Short.\n\nThis is a long enough line to serve as the first prose paragraph fallback."
        result = skill_cache.generate_compact_summary(body)
        assert "long enough line" in result
        assert "Short." not in result

    def test_frontmatter_description_plus_flat_prose(self):
        """Frontmatter description + flat prose both appear without duplication."""
        body = (
            "---\n"
            "description: A skill that automates X\n"
            "---\n\n"
            "Use this skill to automate routine tasks in the project with a single invocation."
        )
        result = skill_cache.generate_compact_summary(body)
        assert "A skill that automates X" in result
        assert "automate routine tasks" in result
        # The description field text should not appear twice
        assert result.count("A skill that automates X") == 1

    def test_frontmatter_fields_not_included_in_prose(self):
        """Frontmatter field lines (e.g. 'trigger: ...') are not captured as prose."""
        body = (
            "---\n"
            "description: My skill\n"
            "trigger: when user mentions X\n"
            "---\n\n"
            "This is the actual prose content of the skill body that matters."
        )
        result = skill_cache.generate_compact_summary(body)
        # trigger line must not appear (it is inside frontmatter)
        assert "trigger:" not in result
        assert "actual prose content" in result

    def test_prose_capped_at_400_chars(self):
        """First prose paragraph is capped at 400 characters."""
        body = "x" * 600
        result = skill_cache.generate_compact_summary(body)
        assert len(result) <= 400 + 10  # allow for ellipsis + small overhead

    def test_empty_body_returns_empty(self):
        """Empty body still returns empty string."""
        assert skill_cache.generate_compact_summary("") == ""


# ---------------------------------------------------------------------------
# Improvement 3: extract_all_headings includes H4 headings
# ---------------------------------------------------------------------------


class TestExtractAllHeadingsH4:
    """extract_all_headings returns H4 headings when max_level=4."""

    _BODY = (
        "# Title\n\n"
        "## Section A\n\n"
        "Content A.\n\n"
        "### Subsection A1\n\n"
        "Content A1.\n\n"
        "#### Deep Section A1a\n\n"
        "Deep content.\n\n"
        "## Section B\n\n"
        "Content B.\n"
    )

    def test_max_level_4_includes_h4(self):
        headings = skill_cache.extract_all_headings(self._BODY, max_level=4)
        levels = [lvl for lvl, _ in headings]
        titles = [title for _, title in headings]
        assert 4 in levels
        assert "Deep Section A1a" in titles

    def test_max_level_3_excludes_h4(self):
        headings = skill_cache.extract_all_headings(self._BODY, max_level=3)
        levels = [lvl for lvl, _ in headings]
        assert 4 not in levels
        assert all(lvl <= 3 for lvl in levels)

    def test_default_max_level_excludes_h4(self):
        """Default max_level is 3 so H4 is excluded by default."""
        headings = skill_cache.extract_all_headings(self._BODY)
        assert all(lvl <= 3 for lvl, _ in headings)

    def test_h4_inside_code_block_excluded(self):
        """H4 headings inside fenced code blocks are excluded."""
        body = "## Real\n\n```\n#### Fake\n```\n\n#### Real H4\n\nContent.\n"
        headings = skill_cache.extract_all_headings(body, max_level=4)
        titles = [title for _, title in headings]
        assert "Real H4" in titles
        assert "Fake" not in titles

    def test_empty_body_returns_empty(self):
        assert skill_cache.extract_all_headings("") == []
        assert skill_cache.extract_all_headings("", max_level=4) == []

    def test_h2_h3_h4_ordering_preserved(self):
        """Headings are returned in document order."""
        body = "## A\n### B\n#### C\n## D\n"
        headings = skill_cache.extract_all_headings(body, max_level=4)
        titles = [title for _, title in headings]
        assert titles == ["A", "B", "C", "D"]


# ---------------------------------------------------------------------------
# Improvement 4: extract_named_section reaches H4 sections
# ---------------------------------------------------------------------------


class TestExtractNamedSectionH4:
    """extract_named_section can retrieve H4-level sections."""

    def test_h4_section_extracted(self):
        body = (
            "## Top\n\nTop content.\n\n"
            "### Sub\n\nSub content.\n\n"
            "#### Deep\n\nDeep content here.\n\n"
            "## Next\n\nNext content.\n"
        )
        result = skill_cache.extract_named_section(body, "Deep")
        assert result is not None
        assert "Deep content here." in result

    def test_h2_preferred_over_h4_same_name(self):
        """H2 heading wins over H4 heading with the same name (pass priority order)."""
        body = "## Rules\n\nH2 rules.\n\n#### Rules\n\nH4 rules.\n"
        result = skill_cache.extract_named_section(body, "Rules")
        assert result is not None
        assert "H2 rules." in result
        # H4 subsection should also be included since it is nested under the H2 match
        assert "H4 rules." in result

    def test_h4_section_stops_at_next_h4(self):
        """Section content stops at the next heading at same or higher level."""
        body = "#### Alpha\n\nAlpha content.\n\n#### Beta\n\nBeta content.\n"
        result = skill_cache.extract_named_section(body, "Alpha")
        assert result is not None
        assert "Alpha content." in result
        assert "Beta content." not in result

    def test_nonexistent_section_returns_none(self):
        body = "## Real Section\n\nContent.\n"
        result = skill_cache.extract_named_section(body, "No Such Section")
        assert result is None
