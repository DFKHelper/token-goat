"""Tests for skill_cache.score_compact() — compact quality scoring.

Covers:
A. score_compact returns expected keys and field types.
B. Coverage ratio bounds (too-small, ideal range, too-large).
C. Heading / non-empty-section counting (code-block-aware).
D. Goal-marker detection (COMPACT_END, frontmatter description).
E. Rule-line detection (CRITICAL/MUST/NEVER/RULE keywords).
F. End-to-end: score is higher for a well-formed compact than a stub.
G. Edge cases: empty compact, empty body, stub compact.
"""
from __future__ import annotations

import pytest

from token_goat.skill_cache import score_compact

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MINIMAL_BODY = "x" * 3000  # ~1000 tokens


def _make_compact(*, headings: int = 3, fill_lines: int = 5, rule: bool = True) -> str:
    """Build a compact text string with the given characteristics."""
    lines: list[str] = []
    for i in range(headings):
        lines.append(f"## Section {i + 1}")
        lines.extend([f"Content line {j}" for j in range(fill_lines)])
    if rule:
        lines.append("CRITICAL: never skip this step")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Sub-area A — score_compact returns required keys with correct types
# ---------------------------------------------------------------------------


class TestScoreCompactReturnShape:
    def test_required_keys_present(self) -> None:
        result = score_compact("## Heading\nSome content.", _MINIMAL_BODY)
        for key in (
            "score",
            "coverage_ratio",
            "non_empty_sections",
            "has_goal_marker",
            "headings_count",
            "has_rule_lines",
            "issues",
        ):
            assert key in result, f"key {key!r} missing from score_compact result"

    def test_score_is_int_in_range(self) -> None:
        result = score_compact("## Heading\nSome content.", _MINIMAL_BODY)
        assert isinstance(result["score"], int)
        assert 0 <= result["score"] <= 100

    def test_coverage_ratio_is_float_capped_at_one(self) -> None:
        result = score_compact("x" * 999, "x" * 100)  # compact > body
        assert isinstance(result["coverage_ratio"], float)
        assert result["coverage_ratio"] <= 1.0

    def test_issues_is_list_of_strings(self) -> None:
        result = score_compact("## Heading\nSome content.", _MINIMAL_BODY)
        assert isinstance(result["issues"], list)
        for item in result["issues"]:
            assert isinstance(item, str)


# ---------------------------------------------------------------------------
# Sub-area B — Coverage ratio scoring
# ---------------------------------------------------------------------------


class TestCoverageRatioScoring:
    def test_stub_compact_gets_low_score(self) -> None:
        # Compact that is < 5% of body should score lower than ideal compact.
        tiny_compact = "## Note\nSee skill."
        big_body = "x" * 30_000
        stub_result = score_compact(tiny_compact, big_body)
        assert stub_result["score"] < 50, (
            f"stub compact (tiny relative to body) should score < 50, got {stub_result['score']}"
        )
        # coverage_ratio should be very small
        assert stub_result["coverage_ratio"] < 0.05

    def test_verbose_compact_gets_lower_score(self) -> None:
        # compact that is > 80% of body should score lower than an ideal compact
        body = "x" * 300
        verbose_compact = "x" * 260  # ~87% of body
        ideal_compact = "x" * 90   # 30% of body — ideal range

        verbose_result = score_compact(verbose_compact, body)
        ideal_result = score_compact(ideal_compact, body)
        assert ideal_result["score"] >= verbose_result["score"]

    def test_ideal_range_gets_positive_bonus(self) -> None:
        # A compact in 10-50% coverage range should score ≥ 65 (base 50 + 15 bonus)
        body = "x" * 3000
        ideal_compact = _make_compact(headings=3, fill_lines=5, rule=True)
        # ~270 chars / 9000 chars body = 3% — but add more content to get to ideal
        ideal_compact_padded = ideal_compact + "\n" + ("y " * 200)
        result = score_compact(ideal_compact_padded, body)
        # Score should be in upper half of range
        assert result["score"] >= 55, (
            f"ideal-range compact should score ≥ 55, got {result['score']}"
        )


# ---------------------------------------------------------------------------
# Sub-area C — Heading and non-empty-section counting
# ---------------------------------------------------------------------------


class TestHeadingAndSectionCounting:
    def test_counts_headings_correctly(self) -> None:
        compact = "## Section 1\nContent.\n\n## Section 2\nContent.\n\n# Top\nContent."
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["headings_count"] == 3

    def test_headings_inside_fenced_blocks_excluded(self) -> None:
        compact = "## Real Heading\nContent.\n```\n## Not A Heading\n```\n"
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["headings_count"] == 1

    def test_non_empty_sections_counts_sections_with_content(self) -> None:
        compact = "## Has Content\nSome text here.\n\n## Empty Section\n"
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["non_empty_sections"] == 1
        assert result["headings_count"] == 2

    def test_all_sections_with_content(self) -> None:
        compact = "## A\nContent A.\n\n## B\nContent B.\n"
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["non_empty_sections"] == 2

    def test_compact_with_no_headings_gets_penalty(self) -> None:
        no_headings = "Just some plain text without any structure."
        result = score_compact(no_headings, _MINIMAL_BODY)
        assert result["headings_count"] == 0
        assert "no headings" in " ".join(result["issues"])


# ---------------------------------------------------------------------------
# Sub-area D — Goal-marker detection
# ---------------------------------------------------------------------------


class TestGoalMarkerDetection:
    def test_compact_end_marker_in_body_detected(self) -> None:
        body_with_marker = "## Intro\nSome text.\n<!-- COMPACT_END -->\n## More\nStuff."
        compact = "## Intro\nSome text."
        result = score_compact(compact, body_with_marker)
        assert result["has_goal_marker"] is True

    def test_frontmatter_description_detected(self) -> None:
        body_with_frontmatter = "---\ndescription: My skill does X.\n---\n## Section\nContent."
        compact = "## Section\nContent."
        result = score_compact(compact, body_with_frontmatter)
        assert result["has_goal_marker"] is True

    def test_plain_body_no_marker(self) -> None:
        plain_body = "## Section\nContent without markers."
        compact = "## Section\nContent."
        result = score_compact(compact, plain_body)
        assert result["has_goal_marker"] is False


# ---------------------------------------------------------------------------
# Sub-area E — Rule-line detection
# ---------------------------------------------------------------------------


class TestRuleLineDetection:
    @pytest.mark.parametrize("keyword", ["CRITICAL", "MUST", "NEVER", "RULE"])
    def test_rule_keyword_detected(self, keyword: str) -> None:
        compact = f"## Section\n{keyword}: do this important thing."
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["has_rule_lines"] is True

    def test_no_rule_lines_when_absent(self) -> None:
        compact = "## Section\nOrdinary content line."
        result = score_compact(compact, _MINIMAL_BODY)
        assert result["has_rule_lines"] is False

    def test_rule_line_gives_score_bonus(self) -> None:
        body = _MINIMAL_BODY
        with_rule = "## Section\nContent.\nCRITICAL: key directive."
        without_rule = "## Section\nContent.\nOrdinary text."
        with_score = score_compact(with_rule, body)
        without_score = score_compact(without_rule, body)
        assert with_score["score"] >= without_score["score"]


# ---------------------------------------------------------------------------
# Sub-area F — Well-formed compact scores better than stub
# ---------------------------------------------------------------------------


class TestScoreOrdering:
    def test_wellformed_beats_stub(self) -> None:
        body = _MINIMAL_BODY
        # Well-formed: ~30% of body, 3 sections, rule lines
        well_formed = _make_compact(headings=3, fill_lines=10, rule=True) + "\n" + ("w " * 150)
        # Stub: near-empty
        stub = "## Note\nSee skill."
        well_score = score_compact(well_formed, body)
        stub_score = score_compact(stub, body)
        assert well_score["score"] > stub_score["score"], (
            f"well-formed compact ({well_score['score']}) should score "
            f"higher than stub ({stub_score['score']})"
        )

    def test_curated_beats_uncurated(self) -> None:
        body_with_marker = _MINIMAL_BODY + "\n<!-- COMPACT_END -->"
        body_without_marker = _MINIMAL_BODY
        compact = _make_compact(headings=3, fill_lines=10, rule=True)
        curated_score = score_compact(compact, body_with_marker)
        uncurated_score = score_compact(compact, body_without_marker)
        assert curated_score["score"] >= uncurated_score["score"]


# ---------------------------------------------------------------------------
# Sub-area G — Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_empty_compact_returns_zero_score(self) -> None:
        result = score_compact("", _MINIMAL_BODY)
        # Empty compact should score very low (the stub penalty fires)
        assert result["score"] <= 40

    def test_empty_body_does_not_crash(self) -> None:
        # Body can be empty if this is called defensively
        result = score_compact("## Section\nContent.", "")
        # coverage_ratio capped at 1.0 because body is near-zero length
        assert result["coverage_ratio"] <= 1.0
        assert "score" in result

    def test_compact_equals_body_gets_low_score(self) -> None:
        body = "x" * 600
        result = score_compact(body, body)
        assert result["coverage_ratio"] == 1.0
        assert "barely smaller" in " ".join(result["issues"])
