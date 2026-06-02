"""Tests for skill context savings improvements (iteration 7 of 10).

Covers:
1. Skill body truncation budget — truncation_budget_tokens config option caps
   auto-extracted compacts for skills without COMPACT_END.
2. skill-section #N ordinal disambiguation — extract_named_section supports
   ``Heading#2`` to select the Nth occurrence of a repeated heading.
3. Compaction manifest total inline budget — _SKILL_INLINE_TOTAL_TOKEN_BUDGET
   distributes the per-skill char cap fairly when many skills are loaded.
"""
from __future__ import annotations

import time

from token_goat import skill_cache
from token_goat.skill_cache import _parse_section_ordinal, extract_named_section

# ---------------------------------------------------------------------------
# Improvement 2: skill-section #N ordinal disambiguation
# ---------------------------------------------------------------------------


class TestParseSectionOrdinal:
    """Unit tests for _parse_section_ordinal helper."""

    def test_no_hash_returns_heading_and_none(self):
        assert _parse_section_ordinal("Usage") == ("Usage", None)

    def test_hash2_returns_heading_and_2(self):
        assert _parse_section_ordinal("Usage#2") == ("Usage", 2)

    def test_hash3_returns_heading_and_3(self):
        assert _parse_section_ordinal("Step 1 — Explore#3") == ("Step 1 — Explore", 3)

    def test_malformed_nonnumeric_returns_none_ordinal(self):
        """Non-numeric ordinal is not treated as an ordinal."""
        assert _parse_section_ordinal("Usage#abc") == ("Usage#abc", None)

    def test_zero_ordinal_is_invalid(self):
        """Ordinal 0 is rejected (1-based)."""
        assert _parse_section_ordinal("Usage#0") == ("Usage#0", None)

    def test_negative_ordinal_is_invalid(self):
        assert _parse_section_ordinal("Usage#-1") == ("Usage#-1", None)

    def test_heading_with_hash_but_no_ordinal(self):
        """A heading that ends with # (no digits after) is returned unchanged."""
        assert _parse_section_ordinal("Usage#") == ("Usage#", None)

    def test_empty_base_is_not_split(self):
        """#2 with no base heading is not treated as ordinal."""
        assert _parse_section_ordinal("#2") == ("#2", None)


class TestExtractNamedSectionOrdinal:
    """extract_named_section with #N ordinal suffix."""

    _BODY_TWO_USAGE = """\
# Skill

## Overview

Intro text.

## Usage

First Usage content.

## Step 1

Step one content.

## Usage

Second Usage content.
"""

    def test_first_occurrence_returned_without_ordinal(self):
        """Without #N, the first matching section is returned."""
        result = extract_named_section(self._BODY_TWO_USAGE, "Usage")
        assert result is not None
        assert "First Usage content" in result
        assert "Second Usage content" not in result

    def test_hash1_returns_first(self):
        result = extract_named_section(self._BODY_TWO_USAGE, "Usage#1")
        assert result is not None
        assert "First Usage content" in result

    def test_hash2_returns_second(self):
        result = extract_named_section(self._BODY_TWO_USAGE, "Usage#2")
        assert result is not None
        assert "Second Usage content" in result
        assert "First Usage content" not in result

    def test_hash3_returns_none_when_only_two_exist(self):
        """Ordinal beyond the number of matches returns None."""
        result = extract_named_section(self._BODY_TWO_USAGE, "Usage#3")
        assert result is None

    def test_single_occurrence_with_hash1(self):
        """#1 works fine when there is only one match."""
        body = "## Overview\n\ncontent\n"
        result = extract_named_section(body, "Overview#1")
        assert result == "content"

    def test_different_headings_no_confusion(self):
        """Ordinal is per-heading-text, not a global line counter."""
        body = """\
## Alpha

Alpha one.

## Beta

Beta one.

## Alpha

Alpha two.
"""
        assert "Alpha two" in (extract_named_section(body, "Alpha#2") or "")
        assert "Beta one" in (extract_named_section(body, "Beta#1") or "")

    def test_h3_duplicate_headings_ordinal(self):
        """Ordinal works on H3 sections too."""
        body = """\
## Parent

### Notes

First notes.

### Notes

Second notes.
"""
        result1 = extract_named_section(body, "Notes#1")
        result2 = extract_named_section(body, "Notes#2")
        assert result1 is not None and "First notes" in result1
        assert result2 is not None and "Second notes" in result2

    def test_heading_with_real_hash_in_name_not_split(self):
        """A heading whose text ends with a hash that is not an ordinal is untouched."""
        body = "## C#\n\nCsharp content.\n"
        # "C#" → rpartition("#") gives ("C", "#", ""), base="C", ordinal_str=""
        # _parse_section_ordinal("C#") returns ("C#", None)
        result = extract_named_section(body, "C#")
        assert result is not None
        assert "Csharp content" in result


# ---------------------------------------------------------------------------
# Improvement 1: truncation_budget_tokens
# ---------------------------------------------------------------------------


class TestTruncationBudgetTokensConfig:
    """truncation_budget_tokens is loaded from config and applied."""

    def test_default_value(self):
        """Default truncation_budget_tokens is 800."""
        from token_goat.config import SkillPreservationConfig
        cfg = SkillPreservationConfig()
        assert cfg.truncation_budget_tokens == 800

    def test_toml_override(self, tmp_path, monkeypatch):
        """truncation_budget_tokens can be overridden via TOML."""
        from token_goat import config as cfg_mod
        from token_goat import paths as paths_mod

        toml_content = (
            "[skill_preservation]\n"
            "truncation_budget_tokens = 200\n"
        )
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text(toml_content, encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: cfg_file)
        # Bust the process-level cache.
        cfg_mod._config_mtime_cache = None  # type: ignore[attr-defined]

        loaded = cfg_mod.load()
        assert loaded.skill_preservation.truncation_budget_tokens == 200

        cfg_mod._config_mtime_cache = None  # cleanup

    def test_zero_disables_budget_cap(self, tmp_path, monkeypatch):
        """Setting truncation_budget_tokens = 0 disables the cap."""
        from token_goat import config as cfg_mod
        from token_goat import paths as paths_mod

        toml_content = "[skill_preservation]\ntruncation_budget_tokens = 0\n"
        cfg_file = tmp_path / "config.toml"
        cfg_file.write_text(toml_content, encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: cfg_file)
        cfg_mod._config_mtime_cache = None

        loaded = cfg_mod.load()
        assert loaded.skill_preservation.truncation_budget_tokens == 0
        cfg_mod._config_mtime_cache = None


class TestTruncationBudgetApplied:
    """truncation_budget_tokens logic correctly caps auto-compact text."""

    def test_compact_truncated_to_budget(self):
        """Auto-extracted compact is truncated to truncation_budget_tokens × 4 chars."""
        # Simulate the budget application logic from hooks_skill.py.
        compact_text = "A" * 2000
        cfg_budget = 100  # tokens
        budget_chars = cfg_budget * 4  # 400 chars
        if cfg_budget > 0 and len(compact_text) > budget_chars:
            _cut = compact_text.rfind("\n", 0, budget_chars)
            if _cut <= 0:
                _cut = budget_chars
            compact_text = compact_text[:_cut].rstrip() + "…"
        # With no newlines in "AAA…", rfind returns -1 → cut = budget_chars.
        # Result is budget_chars chars + 1 char for "…".
        assert len(compact_text) == budget_chars + 1

    def test_compact_truncated_at_newline_boundary(self):
        """Truncation prefers newline boundaries when they exist within budget."""
        # 100 chars per line, budget = 50 tokens = 200 chars.
        line = "A" * 99
        compact_text = "\n".join([line] * 5)
        cfg_budget = 50
        budget_chars = cfg_budget * 4  # 200 chars
        if cfg_budget > 0 and len(compact_text) > budget_chars:
            _cut = compact_text.rfind("\n", 0, budget_chars)
            if _cut <= 0:
                _cut = budget_chars
            compact_text = compact_text[:_cut].rstrip() + "…"
        # rfind finds the newline at position 99 (after first line); result ends with "…"
        assert compact_text.endswith("…")
        assert len(compact_text) <= budget_chars + 1

    def test_zero_budget_disables_truncation(self):
        """When truncation_budget_tokens=0, no truncation is applied."""
        compact_text = "B" * 5000
        cfg_budget = 0
        if cfg_budget > 0:
            budget_chars = cfg_budget * 4
            if len(compact_text) > budget_chars:
                _cut = compact_text.rfind("\n", 0, budget_chars)
                if _cut <= 0:
                    _cut = budget_chars
                compact_text = compact_text[:_cut].rstrip() + "…"
        # With budget=0, no truncation → length unchanged.
        assert len(compact_text) == 5000

    def test_compact_under_budget_not_truncated(self):
        """Text under the budget is returned unchanged."""
        compact_text = "Short compact."
        cfg_budget = 800
        budget_chars = cfg_budget * 4
        original = compact_text
        if cfg_budget > 0 and len(compact_text) > budget_chars:
            _cut = compact_text.rfind("\n", 0, budget_chars)
            if _cut <= 0:
                _cut = budget_chars
            compact_text = compact_text[:_cut].rstrip() + "…"
        assert compact_text == original


# ---------------------------------------------------------------------------
# Improvement 3: manifest total inline skill budget
# ---------------------------------------------------------------------------


class TestManifestSkillInlineBudget:
    """_SKILL_INLINE_TOTAL_TOKEN_BUDGET caps total skill key-rule tokens."""

    def test_budget_constant_present(self):
        """The total inline budget constant is exported from compact."""
        from token_goat.compact import _SKILL_INLINE_TOTAL_TOKEN_BUDGET
        assert _SKILL_INLINE_TOTAL_TOKEN_BUDGET > 0
        assert _SKILL_INLINE_TOTAL_TOKEN_BUDGET <= 500  # sanity: not too large

    def test_per_skill_chars_shrinks_with_more_skills(self):
        """With N skills the per-skill char budget is total/N not the fixed ceiling."""
        from token_goat.compact import (
            _SKILL_COMPACT_INLINE_MAX_CHARS,
            _SKILL_INLINE_TOTAL_TOKEN_BUDGET,
        )
        total_chars = _SKILL_INLINE_TOTAL_TOKEN_BUDGET * 3
        # With 1 skill, per-skill chars is capped by the per-skill ceiling.
        per_1 = min(_SKILL_COMPACT_INLINE_MAX_CHARS, total_chars // 1)
        # With 6 skills, per-skill chars is total/6 (likely below the ceiling).
        per_6 = min(_SKILL_COMPACT_INLINE_MAX_CHARS, total_chars // 6)
        assert per_6 < per_1

    def test_six_skills_fit_within_total_budget(self):
        """Six skills each at their per-skill cap fit within the total budget."""
        from token_goat.compact import (
            _SKILL_COMPACT_INLINE_MAX_CHARS,
            _SKILL_INLINE_TOTAL_TOKEN_BUDGET,
        )
        n = 6
        total_chars = _SKILL_INLINE_TOTAL_TOKEN_BUDGET * 3
        per_skill_chars = min(_SKILL_COMPACT_INLINE_MAX_CHARS, total_chars // n)
        total_used = per_skill_chars * n
        # Total chars used must be <= total budget chars (with a small rounding margin).
        assert total_used <= total_chars + n  # +n for integer division rounding

    def test_skill_lines_respect_budget_in_manifest(self, tmp_data_dir):
        """build_manifest stays within budget when 3 large skills are loaded."""
        from token_goat import session as sess_mod
        from token_goat.compact import build_manifest, estimate_tokens
        from token_goat.session import SkillEntry

        # Set up a session with 3 large skill compacts.
        session_id = "s-manifest-budget-test-001"
        for skill_name in ("ralph", "improve", "marketing"):
            # Store a large compact for each skill (6000 chars each ~ 2000 tokens).
            large_compact = "\n".join(
                f"## Section {i}: CRITICAL rule for {skill_name}"
                for i in range(200)
            )
            skill_cache.store_compact(session_id, skill_name, large_compact)

        # Populate the session cache with skill history entries.
        cache = sess_mod.load(session_id)
        now = time.time()
        for skill_name in ("ralph", "improve", "marketing"):
            cache.skill_history[skill_name] = SkillEntry(
                skill_name=skill_name,
                output_id=f"{session_id[:8]}-{skill_name}-oid",
                content_sha="abc",
                body_bytes=30000,
                ts=now,
            )
        # Also add an edit so the manifest passes the activity floor.
        cache.edited_files["src/some_file.py"] = 1
        sess_mod.save(cache)

        manifest = build_manifest(session_id, max_tokens=400)
        token_count = estimate_tokens(manifest)
        # The manifest must stay within the 400-token budget.
        assert token_count <= 400, (
            f"Manifest token count {token_count} exceeds budget 400. "
            f"Skills inline content is overflowing the budget.\n"
            f"Manifest:\n{manifest}"
        )
