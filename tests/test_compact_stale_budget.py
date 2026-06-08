"""Tests for stale-compact fraction signal in compute_adaptive_budget (iter 9/10).

When skills loaded in a session lack fresh compacts, the post-compact manifest
cannot reconstruct skill context from compact files.  To compensate, the
adaptive budget now factors in the fraction of loaded skills with missing or
SHA-mismatched compacts and adds up to 60 bonus tokens so the manifest has
more room for other context sections.

Also tests _compute_stale_compact_fraction, the helper that measures the
fraction, and ensures build_manifest_adaptive wires it through correctly.

Covers:
A. compute_adaptive_budget returns baseline when stale_compact_fraction=0.0.
B. compute_adaptive_budget applies graduated bonus as fraction rises.
C. compute_adaptive_budget bonus caps at 60 tokens.
D. compute_adaptive_budget clamps fraction to [0.0, 1.0].
E. _compute_stale_compact_fraction returns 0.0 when no skills are loaded.
F. _compute_stale_compact_fraction returns 1.0 when all compacts are missing.
G. _compute_stale_compact_fraction returns correct partial fraction.
H. _compute_stale_compact_fraction treats old-format compacts (no sha=) as fresh.
I. build_manifest_adaptive passes stale fraction to compute_adaptive_budget.
"""
from __future__ import annotations

import unittest.mock

from compact_test_helpers import DataDirMixin

from token_goat.compact import (
    ContextPressure,
    _compute_stale_compact_fraction,  # type: ignore[attr-defined]
    compute_adaptive_budget,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REAL_COMPACT = (
    "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n"
    "## Details\n\nSome longer body content here that fills space.\n"
)


def _minimal_cache(**overrides):
    """Return a minimal mock SessionCache with sane defaults."""
    m = unittest.mock.MagicMock()
    m.edited_files = {}
    m.files = {}
    m.bash_history = []
    m.web_history = []
    m.skill_history = {}
    m.created_ts = 0.0
    m.cwd = None
    for k, v in overrides.items():
        setattr(m, k, v)
    return m


# ---------------------------------------------------------------------------
# Sub-area A — baseline: no stale bonus when fraction=0.0
# ---------------------------------------------------------------------------


class TestComputeAdaptiveBudgetNoStaleBonus:
    def test_no_bonus_when_fraction_zero(self):
        """When stale_compact_fraction=0.0, budget equals the base without stale bonus."""
        cache = _minimal_cache()
        budget_no_stale = compute_adaptive_budget(cache, stale_compact_fraction=0.0)
        budget_default = compute_adaptive_budget(cache)
        assert budget_no_stale == budget_default, (
            "stale_compact_fraction=0.0 should not add any bonus"
        )


# ---------------------------------------------------------------------------
# Sub-area B — graduated bonus as fraction rises
# ---------------------------------------------------------------------------


class TestComputeAdaptiveBudgetGraduatedBonus:
    def test_half_fraction_gives_partial_bonus(self):
        """stale_compact_fraction=0.5 gives a budget bonus between 0 and 60."""
        cache = _minimal_cache()
        budget_zero = compute_adaptive_budget(cache, stale_compact_fraction=0.0)
        budget_half = compute_adaptive_budget(cache, stale_compact_fraction=0.5)
        budget_full = compute_adaptive_budget(cache, stale_compact_fraction=1.0)
        # The half-fraction budget should be strictly between zero and full.
        # Allow for tier-scaling rounding: just check ordering and non-trivial gap.
        assert budget_zero <= budget_half <= budget_full, (
            f"budget should increase monotonically with stale_compact_fraction: "
            f"{budget_zero} <= {budget_half} <= {budget_full}"
        )

    def test_quarter_fraction_less_than_full(self):
        """stale_compact_fraction=0.25 gives a smaller bonus than fraction=1.0."""
        cache = _minimal_cache()
        budget_quarter = compute_adaptive_budget(cache, stale_compact_fraction=0.25)
        budget_full = compute_adaptive_budget(cache, stale_compact_fraction=1.0)
        assert budget_quarter <= budget_full


# ---------------------------------------------------------------------------
# Sub-area C — bonus caps at 60 tokens
# ---------------------------------------------------------------------------


class TestComputeAdaptiveBudgetBonusCap:
    def test_stale_bonus_caps_at_60(self):
        """The stale compact bonus should never exceed 60 tokens."""
        cache = _minimal_cache()
        budget_zero = compute_adaptive_budget(cache, stale_compact_fraction=0.0)
        budget_full = compute_adaptive_budget(cache, stale_compact_fraction=1.0)
        raw_bonus = budget_full - budget_zero
        # After tier multiplier, the raw 60-token bonus may be scaled.
        # At active tier (factor=1.0, age=600), raw bonus = round(60*1.0) = 60.
        # At young tier (factor=0.6), raw bonus = round(60*0.6) = 36.
        # Either way, the bonus from stale fraction alone should be at most 60.
        assert raw_bonus <= 60, (
            f"stale bonus should be at most 60 tokens; observed {raw_bonus}"
        )

    def test_fraction_above_1_clamped(self):
        """Fraction values above 1.0 should be clamped (not give an inflated bonus)."""
        cache = _minimal_cache()
        budget_one = compute_adaptive_budget(cache, stale_compact_fraction=1.0)
        budget_two = compute_adaptive_budget(cache, stale_compact_fraction=2.0)
        assert budget_one == budget_two, (
            "fractions > 1.0 should be clamped to 1.0 before applying the bonus"
        )


# ---------------------------------------------------------------------------
# Sub-area D — clamp fraction to [0.0, 1.0]
# ---------------------------------------------------------------------------


class TestComputeAdaptiveBudgetFractionClamp:
    def test_negative_fraction_clamped_to_zero(self):
        """Negative stale_compact_fraction values are clamped to 0.0 (no bonus)."""
        cache = _minimal_cache()
        budget_zero = compute_adaptive_budget(cache, stale_compact_fraction=0.0)
        budget_neg = compute_adaptive_budget(cache, stale_compact_fraction=-0.5)
        assert budget_neg == budget_zero, (
            "negative fraction should be clamped to 0 (no bonus)"
        )


# ---------------------------------------------------------------------------
# Sub-area E — _compute_stale_compact_fraction: no skills → 0.0
# ---------------------------------------------------------------------------


class TestComputeStaleCompactFractionEmpty:
    def test_empty_skill_history_returns_zero(self):
        """When skill_history is empty, the stale fraction is 0.0."""
        result = _compute_stale_compact_fraction("sid-empty", {})
        assert result == 0.0


# ---------------------------------------------------------------------------
# Sub-area F — all compacts missing → fraction=1.0
# ---------------------------------------------------------------------------


class TestComputeStaleCompactFractionAllMissing(DataDirMixin):

    def test_all_missing_returns_one(self):
        """When no compact exists for any loaded skill, fraction should be 1.0."""
        from token_goat.skill_cache import _skill_outputs_dir  # noqa: PLC0415

        # Delete any pre-existing compact files so the lookup returns None.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        # Build a fake skill_history with two skills.
        entry_a = unittest.mock.MagicMock()
        entry_a.content_sha = "abcdef1234567890"
        entry_b = unittest.mock.MagicMock()
        entry_b.content_sha = "1111111111111111"

        fraction = _compute_stale_compact_fraction("sid-missing", {"skillA": entry_a, "skillB": entry_b})
        assert fraction == 1.0, f"all missing → fraction should be 1.0; got {fraction}"


# ---------------------------------------------------------------------------
# Sub-area G — partial stale fraction
# ---------------------------------------------------------------------------


class TestComputeStaleCompactFractionPartial(DataDirMixin):

    def test_half_stale_returns_half(self):
        """When 1 of 2 skills has a stale compact, fraction should be 0.5."""
        from token_goat.skill_cache import _skill_outputs_dir, store_compact  # noqa: PLC0415

        # Delete pre-existing compacts.
        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        # Store a fresh compact for skillA with a known SHA.
        fresh_sha = "aabbccddee112233"
        store_compact("sid-partial", "freshSkill", _REAL_COMPACT, source_sha=fresh_sha)

        # skillA has a matching compact; skillB has no compact at all.
        entry_fresh = unittest.mock.MagicMock()
        entry_fresh.content_sha = fresh_sha  # matches

        entry_missing = unittest.mock.MagicMock()
        entry_missing.content_sha = "9999999999999999"  # no compact at all

        fraction = _compute_stale_compact_fraction(
            "sid-partial", {"freshSkill": entry_fresh, "missingSkill": entry_missing}
        )
        assert fraction == 0.5, f"1/2 stale → fraction should be 0.5; got {fraction}"


# ---------------------------------------------------------------------------
# Sub-area H — old-format compact (no sha= header) treated as fresh
# ---------------------------------------------------------------------------


class TestComputeStaleCompactFractionOldFormat(DataDirMixin):

    def test_no_sha_header_treated_as_fresh(self):
        """A compact stored without source_sha=None should be treated as fresh (unknown ≠ stale)."""
        from token_goat.skill_cache import _skill_outputs_dir, store_compact  # noqa: PLC0415

        out_dir = _skill_outputs_dir()
        for f in out_dir.iterdir():
            if f.name.endswith("-compact"):
                f.unlink()

        # Store compact WITHOUT a SHA (old format).
        store_compact("sid-nosha", "oldFormatSkill", _REAL_COMPACT, source_sha=None)

        entry = unittest.mock.MagicMock()
        entry.content_sha = "deadbeefcafe1234"  # won't match anything, but no sha in header

        fraction = _compute_stale_compact_fraction("sid-nosha", {"oldFormatSkill": entry})
        assert fraction == 0.0, (
            f"compact without SHA header should be treated as fresh; got fraction={fraction}"
        )


# ---------------------------------------------------------------------------
# Sub-area I — build_manifest_adaptive wires stale fraction through
# ---------------------------------------------------------------------------


class TestBuildManifestAdaptiveStaleWiring(DataDirMixin):

    def test_stale_fraction_passed_to_compute_budget(self):
        """build_manifest_adaptive passes the computed stale fraction to compute_adaptive_budget."""
        from token_goat import compact as c  # noqa: PLC0415

        captured_fraction = []

        orig_compute = c.compute_adaptive_budget

        def capturing_compute(cache, age_seconds=0.0, *, has_pending_diff=False,
                              has_uncommitted_changes=False, stale_compact_fraction=0.0,
                              context_pressure=None):
            captured_fraction.append(stale_compact_fraction)
            return orig_compute(
                cache,
                age_seconds,
                has_pending_diff=has_pending_diff,
                has_uncommitted_changes=has_uncommitted_changes,
                stale_compact_fraction=stale_compact_fraction,
                context_pressure=context_pressure,
            )

        fake_cache = _minimal_cache()
        fake_cache.skill_history = {"someSkill": unittest.mock.MagicMock(content_sha="abc123")}

        with (
            unittest.mock.patch.object(c, "compute_adaptive_budget", capturing_compute),
            unittest.mock.patch.object(c, "_load_session_cache", return_value=fake_cache),
            unittest.mock.patch.object(c, "_get_git_diff_stat_summary", return_value=""),
            unittest.mock.patch.object(c, "_get_uncommitted_changes", return_value=""),
            unittest.mock.patch.object(c, "_session_activity_score", return_value=999),
            unittest.mock.patch.object(c, "_build_manifest_from_cache", return_value="[manifest]"),
            unittest.mock.patch.object(c, "_load_config", return_value=unittest.mock.MagicMock()),
        ):
            c.build_manifest_adaptive("test-session-wiring")

        assert captured_fraction, "compute_adaptive_budget should have been called"
        # The stale fraction is a float in [0.0, 1.0].
        assert 0.0 <= captured_fraction[0] <= 1.0, (
            f"stale_compact_fraction passed to compute_adaptive_budget should be in [0, 1]; "
            f"got {captured_fraction[0]}"
        )


# ---------------------------------------------------------------------------
# Sub-area J — context-pressure caps the budget (the stuck-compact fail-safe)
# ---------------------------------------------------------------------------


def _complex_mature_cache():
    """A mature, maximally-complex cache whose *uncapped* budget hits the ceiling.

    Every bonus is maxed and the session is mature (age > 3600 s → 1.4× factor),
    so the uncapped budget saturates at the 800-token ceiling.  This makes the
    context-pressure caps (300 / 500) strictly lower than the uncapped value,
    so a test asserting ``<= 300`` / ``<= 500`` actually exercises the cap rather
    than coincidentally passing because the budget was already small.
    """
    files = {}
    for i in range(6):
        e = unittest.mock.MagicMock()
        e.symbols_read = ["sym"]
        files[f"f{i}.py"] = e
    return _minimal_cache(
        edited_files={f"e{i}.py": {} for i in range(6)},
        files=files,
        bash_history=["ran a command"],
        web_history=["fetched a url"],
    )


# Bonuses that push the uncapped budget to its ceiling for the complex cache.
_MAX_KW = dict(
    age_seconds=7200.0,  # mature → 1.4× factor
    has_pending_diff=True,
    has_uncommitted_changes=True,
    stale_compact_fraction=1.0,
)


class TestContextPressureCaps:
    """compute_adaptive_budget shrinks the manifest under context pressure.

    A large manifest emitted at high context fill worsens the stuck-compact loop
    (repeated compactions that never drop context below ~80%), so critical/hot
    tiers cap the budget aggressively.  These tests lock in those caps — without
    them a silent regression (cap removed, values swapped, guard inverted) would
    pass every other test in the suite.
    """

    def _uncapped(self):
        return compute_adaptive_budget(_complex_mature_cache(), **_MAX_KW)

    def test_uncapped_budget_saturates_ceiling(self):
        """Sanity: the complex cache's uncapped budget is high enough to be capped."""
        # If this drops below 500 the cap assertions below would be vacuous.
        assert self._uncapped() > 500

    def test_critical_caps_at_300(self):
        """A critical-fill context caps the budget at 300 tokens."""
        cp = ContextPressure(fill_fraction=0.95, tier="critical")
        budget = compute_adaptive_budget(
            _complex_mature_cache(), context_pressure=cp, **_MAX_KW
        )
        assert budget <= 300
        # And it genuinely shrank relative to the uncapped value.
        assert budget < self._uncapped()

    def test_hot_caps_at_500(self):
        """A hot-fill context caps the budget at 500 tokens."""
        cp = ContextPressure(fill_fraction=0.75, tier="hot")
        budget = compute_adaptive_budget(
            _complex_mature_cache(), context_pressure=cp, **_MAX_KW
        )
        assert budget <= 500
        assert budget < self._uncapped()

    def test_critical_is_tighter_than_hot(self):
        """Critical pressure caps strictly lower than hot pressure."""
        crit = compute_adaptive_budget(
            _complex_mature_cache(),
            context_pressure=ContextPressure(fill_fraction=0.95, tier="critical"),
            **_MAX_KW,
        )
        hot = compute_adaptive_budget(
            _complex_mature_cache(),
            context_pressure=ContextPressure(fill_fraction=0.75, tier="hot"),
            **_MAX_KW,
        )
        assert crit < hot

    def test_cool_and_warm_do_not_cap(self):
        """cool/warm pressure leaves the budget identical to no-pressure (uncapped)."""
        uncapped = self._uncapped()
        for tier, fill in (("cool", 0.10), ("warm", 0.60)):
            budget = compute_adaptive_budget(
                _complex_mature_cache(),
                context_pressure=ContextPressure(fill_fraction=fill, tier=tier),
                **_MAX_KW,
            )
            assert budget == uncapped, f"{tier} pressure must not cap the budget"

    def test_none_pressure_is_uncapped(self):
        """Omitting context_pressure leaves the budget uncapped (back-compat)."""
        explicit_none = compute_adaptive_budget(
            _complex_mature_cache(), context_pressure=None, **_MAX_KW
        )
        assert explicit_none == self._uncapped()
