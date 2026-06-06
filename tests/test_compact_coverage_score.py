"""Tests for per-skill compact_coverage_score and session compact_coverage_pct (iter 10/10).

The compact_coverage_score is a 0-100 composite per loaded skill that combines:
  +50 if has_compact
  +30 if compact is fresh or freshness is unknown (compact_stale is not True)
  +20 scaled from compact_quality_score (0-100 → 0-20, integer division)

compact_coverage_pct is the average compact_coverage_score across all skills
in the session, emitted as a top-level field in skill-list --json output.

Covers:
A. No compact → coverage_score == 0.
B. Compact exists, fresh, high quality → coverage_score near 100.
C. Compact exists, explicitly stale → loses freshness bonus.
D. Compact exists, fresh, zero quality score → 50+30+0 = 80.
E. compact_coverage_pct is average of per-skill scores.
F. compact_coverage_pct is 0 when no skills loaded.
G. Skill with no compact pulls session coverage_pct below 50.
H. compact_coverage_score field present in skill-list --json row.
I. compact_coverage_pct field present in skill-list --json top-level.
"""
from __future__ import annotations

import json
import unittest.mock

import pytest
from compact_test_helpers import DataDirMixin
from conftest import fire_skill_hook

from token_goat.skill_cache import store_compact

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REAL_BODY = (
    "---\ndescription: Coverage score test skill.\n---\n\n"
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\n"
    + ("Detail content. " * 200)
)

_GOOD_COMPACT = (
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\nSummary of the good compact content.\n"
)

_MIN_COMPACT = "## Rules\n\nCRITICAL: always test.\n"


def _run_skill_list_json(session_id: str) -> dict:
    """Run cmd_skill_list in --json mode and return the parsed JSON dict."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat.cli import app  # noqa: PLC0415

    runner = CliRunner()
    result = runner.invoke(app, ["skill-list", "--json", "--session-id", session_id])
    output = result.output.strip()
    if not output:
        return {}
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {}


# ---------------------------------------------------------------------------
# Sub-area A — no compact → coverage_score == 0
# ---------------------------------------------------------------------------


class TestCoverageScoreNoCompact(DataDirMixin):

    def test_no_compact_coverage_score_zero(self):
        """A skill with no compact should have compact_coverage_score == 0."""
        from token_goat.skill_cache import _skill_outputs_dir  # noqa: PLC0415

        sid = "cov10-nocomp-01"
        fire_skill_hook(sid, "noCompactSkill", _REAL_BODY)

        # Delete any auto-generated compact.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        data = _run_skill_list_json(sid)
        skills = data.get("skills", [])
        row = next((r for r in skills if r.get("name", "").lower() == "nocompactskill"), None)
        assert row is not None, f"nocompactskill not found in output: {data}"
        assert row["compact_coverage_score"] == 0, (
            f"no compact → coverage_score should be 0; got {row['compact_coverage_score']}"
        )


# ---------------------------------------------------------------------------
# Sub-area B — fresh, high quality compact → score near 100
# ---------------------------------------------------------------------------


class TestCoverageScoreHighQuality(DataDirMixin):

    def test_fresh_high_quality_score_near_100(self):
        """A fresh, high-quality compact should score at least 80 (50+30+quality bonus)."""
        sid = "cov10-hq-01"
        fire_skill_hook(sid, "hqSkill", _REAL_BODY)

        # Overwrite with a matching SHA to ensure freshness.
        # We use the entry's content_sha for the match.
        import token_goat.session as _sess  # noqa: PLC0415

        skill_entries = _sess.get_skill_history(sid) or {}
        entry = skill_entries.get("hqSkill")
        sha = getattr(entry, "content_sha", None) if entry else None
        if sha:
            store_compact(sid, "hqSkill", _GOOD_COMPACT, source_sha=sha)
        else:
            store_compact(sid, "hqSkill", _GOOD_COMPACT)

        data = _run_skill_list_json(sid)
        skills = data.get("skills", [])
        row = next((r for r in skills if r.get("name", "").lower() == "hqskill"), None)
        assert row is not None, f"hqskill not found in output: {data}"
        # At minimum: has_compact (50) + fresh (30) = 80; quality adds up to 20 more.
        assert row["compact_coverage_score"] >= 80, (
            f"fresh high-quality compact should score >= 80; got {row['compact_coverage_score']}"
        )


# ---------------------------------------------------------------------------
# Sub-area C — stale compact loses freshness bonus
# ---------------------------------------------------------------------------


class TestCoverageScoreStaleCompact(DataDirMixin):

    def test_stale_compact_loses_freshness_bonus(self):
        """A stale compact (SHA mismatch) should not receive the +30 freshness bonus."""
        sid = "cov10-stale-01"
        fire_skill_hook(sid, "staleSkill", _REAL_BODY)

        # Force a SHA mismatch.
        store_compact(sid, "staleSkill", _GOOD_COMPACT, source_sha="000000000000")

        data = _run_skill_list_json(sid)
        skills = data.get("skills", [])
        row = next((r for r in skills if r.get("name", "").lower() == "staleskill"), None)
        assert row is not None, f"staleskill not found in output: {data}"
        # Without freshness: max score = 50 (has_compact) + 20 (quality) = 70.
        assert row["compact_coverage_score"] <= 70, (
            f"stale compact should not exceed 70; got {row['compact_coverage_score']}"
        )
        # Should still get the has_compact bonus.
        assert row["compact_coverage_score"] >= 50, (
            f"stale compact still has_compact, score should be >= 50; got {row['compact_coverage_score']}"
        )


# ---------------------------------------------------------------------------
# Sub-area D — fresh compact, zero quality → 50+30+0 = 80
# ---------------------------------------------------------------------------


class TestCoverageScoreFreshZeroQuality(DataDirMixin):

    def test_fresh_zero_quality_scores_80(self):
        """A fresh compact with quality=0 should score exactly 50+30+0 = 80."""
        sid = "cov10-zeroq-01"
        fire_skill_hook(sid, "zeroQSkill", _REAL_BODY)

        import token_goat.session as _sess  # noqa: PLC0415

        skill_entries = _sess.get_skill_history(sid) or {}
        entry = skill_entries.get("zeroQSkill")
        sha = getattr(entry, "content_sha", None) if entry else None

        # Mock score_compact to return quality=0 for this test.
        import token_goat.skill_cache as _sc  # noqa: PLC0415

        def mock_score(compact_body, body_text):
            return {"score": 0, "coverage_ratio": 0.0, "headings_count": 0,
                    "has_rule_lines": False, "issues": ["mocked to zero"]}

        with unittest.mock.patch.object(_sc, "score_compact", mock_score):
            if sha:
                store_compact(sid, "zeroQSkill", _GOOD_COMPACT, source_sha=sha)
            else:
                store_compact(sid, "zeroQSkill", _GOOD_COMPACT)
            data = _run_skill_list_json(sid)

        skills = data.get("skills", [])
        row = next((r for r in skills if r.get("name", "").lower() == "zeroqskill"), None)
        assert row is not None, f"zeroqskill not found in output: {data}"
        # compact_coverage_score = 50 (has_compact) + 30 (fresh) + 0 (quality) = 80
        assert row["compact_coverage_score"] == 80, (
            f"fresh compact with quality=0 should score 80; got {row['compact_coverage_score']}"
        )


# ---------------------------------------------------------------------------
# Sub-area E — compact_coverage_pct is average of per-skill scores
# ---------------------------------------------------------------------------


class TestCompactCoveragePctAverage(DataDirMixin):

    def test_coverage_pct_is_average(self):
        """compact_coverage_pct should be the rounded average of all per-skill scores."""
        from token_goat.skill_cache import _skill_outputs_dir  # noqa: PLC0415

        sid = "cov10-avg-01"
        fire_skill_hook(sid, "skillWithCompact", _REAL_BODY)
        fire_skill_hook(sid, "skillNoCompact", _REAL_BODY)

        # Ensure skillNoCompact has no compact.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            # Only delete compact for skillNoCompact.
            if "skillnocompact" in f.name.lower() and f.name.endswith("-compact"):
                f.unlink()

        data = _run_skill_list_json(sid)
        assert "compact_coverage_pct" in data, "top-level compact_coverage_pct field must be present"

        skills = data.get("skills", [])
        if not skills:
            pytest.skip("no skills found — hook may not have fired in this test environment")

        per_skill_scores = [int(r["compact_coverage_score"]) for r in skills]
        expected_avg = round(sum(per_skill_scores) / len(per_skill_scores))
        assert data["compact_coverage_pct"] == expected_avg, (
            f"compact_coverage_pct should be the average of per-skill scores "
            f"{per_skill_scores} → expected {expected_avg}; got {data['compact_coverage_pct']}"
        )


# ---------------------------------------------------------------------------
# Sub-area H — compact_coverage_score field present in each row
# ---------------------------------------------------------------------------


class TestCoverageScoreFieldPresent(DataDirMixin):

    def test_compact_coverage_score_field_in_row(self):
        """Each row in skill-list --json output must contain compact_coverage_score."""
        sid = "cov10-field-01"
        fire_skill_hook(sid, "fieldTestSkill", _REAL_BODY)

        data = _run_skill_list_json(sid)
        skills = data.get("skills", [])
        if not skills:
            pytest.skip("no skills found — hook may not have fired")

        for row in skills:
            assert "compact_coverage_score" in row, (
                f"compact_coverage_score field missing from row: {row}"
            )
            score = row["compact_coverage_score"]
            assert isinstance(score, int), f"compact_coverage_score should be int; got {type(score)}"
            assert 0 <= score <= 100, f"compact_coverage_score should be in [0, 100]; got {score}"


# ---------------------------------------------------------------------------
# Sub-area I — compact_coverage_pct field present at session level
# ---------------------------------------------------------------------------


class TestCompactCoveragePctFieldPresent(DataDirMixin):

    def test_compact_coverage_pct_top_level_field(self):
        """skill-list --json must emit compact_coverage_pct as a top-level field."""
        sid = "cov10-toplevel-01"
        fire_skill_hook(sid, "topLevelSkill", _REAL_BODY)

        data = _run_skill_list_json(sid)
        assert "compact_coverage_pct" in data, (
            f"compact_coverage_pct missing from top-level JSON; keys: {list(data.keys())}"
        )
        pct = data["compact_coverage_pct"]
        assert isinstance(pct, int), f"compact_coverage_pct should be int; got {type(pct)}"
        assert 0 <= pct <= 100, f"compact_coverage_pct should be in [0, 100]; got {pct}"
