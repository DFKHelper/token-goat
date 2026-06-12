"""Tests for context-pressure threshold wiring in the pre_read hook.

Verifies that:
- cool tier passes threshold=500 to build_read_hint
- warm tier passes threshold=350
- hot tier passes threshold=200
- critical tier passes threshold=50
- warm tier injects a gentle context-warming note
- hot tier injects a context-pressure note
- critical tier injects a context-pressure urgency note
"""
from __future__ import annotations

import os
import tempfile

from token_goat import hooks_cli, session


class TestContextPressureThreshold:
    """pre_read adapts the surgical-read threshold based on context pressure tier."""

    def _make_tmp_py(self) -> str:
        """Write a small Python file and return its path."""
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="wb") as f:
            f.write(b"x = 1\n" * 10)
            return f.name

    def _run_pre_read(self, session_id: str, file_path: str) -> dict:
        session.mark_file_read(session_id, file_path, offset=0, limit=10)
        payload = {
            "session_id": session_id,
            "tool_name": "Read",
            "tool_input": {"file_path": file_path},
            "cwd": os.path.dirname(file_path),
        }
        return hooks_cli.pre_read(payload)

    def test_cool_tier_uses_default_threshold(self, tmp_data_dir, monkeypatch):
        """At cool context pressure, build_read_hint receives threshold=500 (default)."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.3, tier="cool"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)

        calls: list[int] = []

        def capture_brh(**kwargs):
            calls.append(kwargs.get("large_file_line_threshold", -1))
            return None

        monkeypatch.setattr(_hints_mod, "build_read_hint", capture_brh)

        path = self._make_tmp_py()
        try:
            self._run_pre_read("ctx-cool-threshold", path)
        finally:
            os.unlink(path)

        assert any(t == 500 for t in calls), f"Expected threshold=500 in calls {calls}"

    def test_hot_tier_uses_200_threshold(self, tmp_data_dir, monkeypatch):
        """At hot context pressure, build_read_hint receives threshold=200."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.75, tier="hot"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)

        calls: list[int] = []

        def capture_brh(**kwargs):
            calls.append(kwargs.get("large_file_line_threshold", -1))
            return None

        monkeypatch.setattr(_hints_mod, "build_read_hint", capture_brh)

        path = self._make_tmp_py()
        try:
            self._run_pre_read("ctx-hot-threshold", path)
        finally:
            os.unlink(path)

        assert any(t == 200 for t in calls), f"Expected threshold=200 in calls {calls}"

    def test_critical_tier_uses_50_threshold(self, tmp_data_dir, monkeypatch):
        """At critical context pressure, build_read_hint receives threshold=50."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.90, tier="critical"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)

        calls: list[int] = []

        def capture_brh(**kwargs):
            calls.append(kwargs.get("large_file_line_threshold", -1))
            return None

        monkeypatch.setattr(_hints_mod, "build_read_hint", capture_brh)

        path = self._make_tmp_py()
        try:
            self._run_pre_read("ctx-critical-threshold", path)
        finally:
            os.unlink(path)

        assert any(t == 50 for t in calls), f"Expected threshold=50 in calls {calls}"

    def test_warm_tier_uses_350_threshold(self, tmp_data_dir, monkeypatch):
        """At warm context pressure, build_read_hint receives threshold=350."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.60, tier="warm"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)

        calls: list[int] = []

        def capture_brh(**kwargs):
            calls.append(kwargs.get("large_file_line_threshold", -1))
            return None

        monkeypatch.setattr(_hints_mod, "build_read_hint", capture_brh)

        path = self._make_tmp_py()
        try:
            self._run_pre_read("ctx-warm-threshold", path)
        finally:
            os.unlink(path)

        assert any(t == 350 for t in calls), f"Expected threshold=350 in calls {calls}"

    def test_critical_tier_injects_urgency_note(self, tmp_data_dir, monkeypatch):
        """At critical pressure, a CONTEXT CRITICAL urgency note appears in the output."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.92, tier="critical"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        # No build_read_hint hint so the urgency note is the only possible output.
        monkeypatch.setattr(_hints_mod, "build_read_hint", lambda **_kw: None)

        path = self._make_tmp_py()
        try:
            result = self._run_pre_read("ctx-critical-urgency", path)
        finally:
            os.unlink(path)

        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "CONTEXT CRITICAL" in ctx, (
            f"Expected 'CONTEXT CRITICAL' in additionalContext. Got: {ctx!r}"
        )

    def test_hot_tier_injects_pressure_note(self, tmp_data_dir, monkeypatch):
        """At hot pressure, a context pressure note appears in the output."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.77, tier="hot"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        monkeypatch.setattr(_hints_mod, "build_read_hint", lambda **_kw: None)

        path = self._make_tmp_py()
        try:
            result = self._run_pre_read("ctx-hot-urgency", path)
        finally:
            os.unlink(path)

        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "Context pressure" in ctx, (
            f"Expected 'Context pressure' in additionalContext. Got: {ctx!r}"
        )

    def test_warm_tier_injects_context_warming_note(self, tmp_data_dir, monkeypatch):
        """At warm pressure, a gentle context-warming note appears in the output."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.60, tier="warm"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        monkeypatch.setattr(_hints_mod, "build_read_hint", lambda **_kw: None)

        path = self._make_tmp_py()
        try:
            result = self._run_pre_read("ctx-warm-warming", path)
        finally:
            os.unlink(path)

        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "Context warming" in ctx, (
            f"Expected 'Context warming' in additionalContext. Got: {ctx!r}"
        )

    def test_cool_tier_does_not_inject_urgency_note(self, tmp_data_dir, monkeypatch):
        """At cool pressure, no context-pressure urgency note is injected."""
        import token_goat.hints as _hints_mod
        from token_goat.compact import ContextPressure

        monkeypatch.setattr(
            "token_goat.compact.get_context_pressure",
            lambda _sid, **_kw: ContextPressure(fill_fraction=0.2, tier="cool"),
        )
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
        monkeypatch.setattr(_hints_mod, "build_read_hint", lambda **_kw: None)

        path = self._make_tmp_py()
        try:
            result = self._run_pre_read("ctx-cool-no-urgency", path)
        finally:
            os.unlink(path)

        # Should be a plain CONTINUE (no additionalContext) at cool tier
        hso = result.get("hookSpecificOutput") or {}
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "CONTEXT CRITICAL" not in ctx
        assert "Context pressure" not in ctx
        assert "Context warming" not in ctx


class TestTierForFractionBoundaries:
    """The extracted tier_for_fraction helper is the single source of truth for
    the fraction->tier mapping. Boundaries are inclusive at the lower edge of
    each band: cool <0.50, warm [0.50,0.70), hot [0.70,0.85), critical >=0.85.
    """

    def test_boundary_mapping(self):
        from token_goat.compact import (
            CONTEXT_TIER_CRITICAL,
            CONTEXT_TIER_HOT,
            CONTEXT_TIER_WARM,
            tier_for_fraction,
        )

        # Constants pin the band edges.
        assert (CONTEXT_TIER_WARM, CONTEXT_TIER_HOT, CONTEXT_TIER_CRITICAL) == (
            0.50,
            0.70,
            0.85,
        )

        cases = [
            (0.0, "cool"),
            (0.49, "cool"),
            (0.50, "warm"),
            (0.69, "warm"),
            (0.70, "hot"),
            (0.84, "hot"),
            (0.85, "critical"),
            (1.0, "critical"),
            (1.5, "critical"),
        ]
        for fill, expected in cases:
            assert tier_for_fraction(fill) == expected, (
                f"tier_for_fraction({fill}) should be {expected!r}"
            )

    def test_constants_drive_the_boundaries(self):
        """The mapping is defined in terms of the named constants, not bare
        literals: a value just below each constant lands in the lower band, and
        the constant value itself lands in the upper band."""
        from token_goat.compact import (
            CONTEXT_TIER_CRITICAL,
            CONTEXT_TIER_HOT,
            CONTEXT_TIER_WARM,
            tier_for_fraction,
        )

        assert tier_for_fraction(CONTEXT_TIER_WARM - 0.001) == "cool"
        assert tier_for_fraction(CONTEXT_TIER_WARM) == "warm"
        assert tier_for_fraction(CONTEXT_TIER_HOT - 0.001) == "warm"
        assert tier_for_fraction(CONTEXT_TIER_HOT) == "hot"
        assert tier_for_fraction(CONTEXT_TIER_CRITICAL - 0.001) == "hot"
        assert tier_for_fraction(CONTEXT_TIER_CRITICAL) == "critical"


class TestPressureBaselineCompactionReset:
    """Test suite for pressure_baseline_tokens compaction reset feature.

    Verifies that the baseline-subtraction mechanism correctly resets context
    pressure after compaction, preventing false "critical" readings on sessions
    that have already compacted.
    """

    def test_raw_total_formula(self):
        """Test _pressure_raw_total computes the correct token sum.

        Formula: skill_tokens + CATALOG_TOKENS + bash_count*500 + web_count*1000 + read_count*200
        """
        import time

        from token_goat.compact import CATALOG_TOKENS, _pressure_raw_total
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-formula",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        # Set up known counts
        cache.loaded_skill_total_tokens = 100
        cache.bash_history = {f"h{i}": {"cmd": "x", "ts": 1.0} for i in range(3)}
        cache.web_history = {f"w{i}": {"url": "http://x", "ts": 1.0} for i in range(2)}
        cache.files = {f"f{i}.py": {} for i in range(5)}

        raw = _pressure_raw_total(cache)
        expected = 100 + CATALOG_TOKENS + 3 * 500 + 2 * 1000 + 5 * 200
        assert raw == expected, f"Expected {expected}, got {raw}"

    def test_baseline_subtraction_drops_fill(self):
        """Test that setting baseline_tokens to raw_total resets fill to 0.

        High-activity cache initially registers high fill; after setting
        pressure_baseline_tokens to the raw total, fill drops to 0 and tier
        becomes "cool".
        """
        import time

        from token_goat.compact import (
            _pressure_raw_total,
            get_context_pressure,
        )
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-baseline-drop",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        # Add enough bash entries to push fill above threshold
        cache.bash_history = {f"h{i}": {"cmd": "x", "ts": 1.0} for i in range(20)}
        cache.loaded_skill_total_tokens = 0

        # Assert cache is at elevated pressure before baseline is set
        pressure_before = get_context_pressure(cache=cache)
        assert pressure_before.fill_fraction > 0.0, "Cache should have positive fill before baseline"

        # Set baseline to current raw total
        cache.pressure_baseline_tokens = _pressure_raw_total(cache)

        # Assert fill drops to 0 (or effectively 0 due to max(0, ...))
        pressure_after = get_context_pressure(cache=cache)
        assert pressure_after.fill_fraction == 0.0, f"Fill should be 0, got {pressure_after.fill_fraction}"
        assert pressure_after.tier == "cool", f"Tier should be 'cool', got {pressure_after.tier}"

    def test_baseline_subtraction_incremental(self):
        """Test that new activity is measured against the baseline.

        Simulate post-compact state: set pressure_baseline_tokens, then add
        incremental activity. Verify fill_fraction = new_tokens / CONTEXT_AUTOCOMPACT_TOKENS.
        """
        import time

        import pytest

        from token_goat.compact import (
            CONTEXT_AUTOCOMPACT_TOKENS,
            _pressure_raw_total,
            get_context_pressure,
        )
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-incremental",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        # Build baseline from some initial state
        cache.bash_history = {f"h{i}": {"cmd": "x", "ts": 1.0} for i in range(10)}
        baseline_raw = _pressure_raw_total(cache)
        cache.pressure_baseline_tokens = baseline_raw

        # Add 1 new bash entry = 500 additional tokens
        cache.bash_history["h_new"] = {"cmd": "echo hi", "ts": 1.0}

        raw = _pressure_raw_total(cache)
        effective = raw - cache.pressure_baseline_tokens
        expected_fill = max(0, effective) / CONTEXT_AUTOCOMPACT_TOKENS

        pressure = get_context_pressure(cache=cache)
        assert pressure.fill_fraction == pytest.approx(expected_fill, rel=1e-6)
        # Verify it's approximately 500 / 660_000
        assert pressure.fill_fraction == pytest.approx(500 / CONTEXT_AUTOCOMPACT_TOKENS, rel=1e-6)

    def test_baseline_zero_initially(self):
        """Test that new SessionCache instances start with pressure_baseline_tokens=0."""
        import time

        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-zero",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        assert cache.pressure_baseline_tokens == 0, "New cache should have baseline=0"

    def test_serialization_roundtrip(self):
        """Test that pressure_baseline_tokens survives to_dict/from_dict roundtrip."""
        import time

        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-serialize",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        cache.pressure_baseline_tokens = 12345

        # Convert to dict
        d = cache.to_dict()
        assert "pressure_baseline_tokens" in d, "Dict should contain pressure_baseline_tokens"
        assert d["pressure_baseline_tokens"] == 12345

        # Roundtrip back
        cache2 = SessionCache.from_dict(d)
        assert cache2.pressure_baseline_tokens == 12345

    def test_negative_raw_total_floors_to_zero(self):
        """Test that a stale baseline higher than raw_total floors at 0.

        If pressure_baseline_tokens > _pressure_raw_total(cache), the fill
        should floor at 0 (not go negative).
        """
        import time

        from token_goat.compact import get_context_pressure
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-floor",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        # Set a very high baseline
        cache.pressure_baseline_tokens = 999_999_999

        # Cache has minimal activity
        cache.bash_history = {"h0": {"cmd": "x", "ts": 1.0}}

        pressure = get_context_pressure(cache=cache)
        assert pressure.fill_fraction == 0.0, f"Fill should floor at 0, got {pressure.fill_fraction}"
        assert pressure.tier == "cool"

    def test_baseline_with_multiple_sources(self):
        """Test baseline subtraction with activity across all sources.

        Verify formula with skill tokens, bash, web, and file reads all present.
        """
        import time

        import pytest

        from token_goat.compact import _pressure_raw_total, get_context_pressure
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-multi-source",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        cache.loaded_skill_total_tokens = 200
        cache.bash_history = {f"h{i}": {"cmd": "x", "ts": 1.0} for i in range(5)}
        cache.web_history = {f"w{i}": {"url": "http://x", "ts": 1.0} for i in range(3)}
        cache.files = {f"f{i}.py": {} for i in range(10)}

        # Get the raw total before setting baseline
        raw_before_baseline = _pressure_raw_total(cache)

        # Set baseline to 30% of raw total
        baseline_thirty_percent = int(raw_before_baseline * 0.3)
        cache.pressure_baseline_tokens = baseline_thirty_percent

        # Get pressure: should be 70% of pre-baseline fill
        pressure = get_context_pressure(cache=cache)
        expected_raw = raw_before_baseline
        expected_effective = expected_raw - baseline_thirty_percent
        expected_fill = expected_effective / 660_000  # CONTEXT_AUTOCOMPACT_TOKENS

        assert pressure.fill_fraction == pytest.approx(expected_fill, rel=1e-6)

    def test_baseline_persists_across_activity(self):
        """Test that baseline does not change when new activity is added.

        Once baseline is set, it remains fixed as new bash/web/read entries
        are added. The fill should increase incrementally.
        """
        import time

        from token_goat.compact import _pressure_raw_total, get_context_pressure
        from token_goat.session import SessionCache

        cache = SessionCache(
            session_id="test-persist",
            started_ts=time.time(),
            last_activity_ts=time.time(),
            created_ts=time.time(),
        )
        cache.bash_history = {f"h{i}": {"cmd": "x", "ts": 1.0} for i in range(2)}
        baseline = _pressure_raw_total(cache)
        cache.pressure_baseline_tokens = baseline

        pressure1 = get_context_pressure(cache=cache)
        assert pressure1.fill_fraction == 0.0

        # Add new bash entry
        cache.bash_history["h_new"] = {"cmd": "y", "ts": 1.0}
        pressure2 = get_context_pressure(cache=cache)
        # Fill should now reflect the new 500-token entry
        assert pressure2.fill_fraction > 0.0, "Fill should increase with new activity"
        assert pressure2.fill_fraction < 0.001, "Fill should be small (500/660000 ≈ 0.00075)"


class TestObservedToolTokensMeasuredPath:
    """_pressure_raw_total uses observed_tool_tokens when >0; falls back to proxies otherwise."""

    def _make_cache(self, **kw):
        import time

        from token_goat.session import SessionCache
        return SessionCache(session_id="test-obs", started_ts=time.time(), last_activity_ts=time.time(), created_ts=time.time(), **kw)

    def test_measured_path_overrides_proxies(self):
        from token_goat.compact import _pressure_raw_total
        cache = self._make_cache()
        # Add bash/web/file entries that would give proxy > 0
        cache.bash_history = {"h1": {}, "h2": {}}
        cache.web_history = {"w1": {}}
        cache.files = {"f1": {}}
        cache.observed_tool_tokens = 99_000
        result = _pressure_raw_total(cache)
        from token_goat.compact import CATALOG_TOKENS
        assert result == CATALOG_TOKENS + 99_000

    def test_proxy_fallback_when_observed_zero(self):
        from token_goat.compact import CATALOG_TOKENS, _pressure_raw_total
        cache = self._make_cache()
        cache.bash_history = {"h1": {}}
        cache.observed_tool_tokens = 0
        proxy_result = _pressure_raw_total(cache)
        assert proxy_result == CATALOG_TOKENS + 500  # 1 bash entry × 500

    def test_measured_path_excluded_when_observed_zero(self):
        from token_goat.compact import _pressure_raw_total
        cache = self._make_cache()
        cache.observed_tool_tokens = 0
        cache.web_history = {"w1": {}, "w2": {}}
        result = _pressure_raw_total(cache)
        from token_goat.compact import CATALOG_TOKENS
        assert result == CATALOG_TOKENS + 2 * 1_000  # proxy: 2 web × 1000

    def test_get_context_pressure_uses_measured_fill(self):
        from token_goat.compact import (
            CATALOG_TOKENS,
            CONTEXT_AUTOCOMPACT_TOKENS,
            get_context_pressure,
        )
        cache = self._make_cache()
        # Set observed so CATALOG_TOKENS + observed == exactly half capacity.
        cache.observed_tool_tokens = CONTEXT_AUTOCOMPACT_TOKENS // 2 - CATALOG_TOKENS
        cp = get_context_pressure(cache=cache)
        assert abs(cp.fill_fraction - 0.5) < 0.001
        assert cp.tier == "warm"

    def test_observed_tokens_serialise_round_trip(self):
        cache = self._make_cache()
        cache.observed_tool_tokens = 12_345
        from token_goat.session import SessionCache
        restored = SessionCache.from_dict(cache.to_dict())
        assert restored.observed_tool_tokens == 12_345

    def test_observed_tokens_defaults_to_zero_on_missing_key(self):
        cache = self._make_cache()
        d = cache.to_dict()
        del d["observed_tool_tokens"]
        from token_goat.session import SessionCache
        restored = SessionCache.from_dict(d)
        assert restored.observed_tool_tokens == 0

    def test_observed_tokens_clamped_to_nonneg(self):
        cache = self._make_cache()
        d = cache.to_dict()
        d["observed_tool_tokens"] = -500
        from token_goat.session import SessionCache
        restored = SessionCache.from_dict(d)
        assert restored.observed_tool_tokens == 0

    def test_measured_plus_baseline_gives_correct_delta(self):
        """Post-compact: baseline absorbs old observed; new reads add incremental fill."""
        from token_goat.compact import _pressure_raw_total, get_context_pressure
        cache = self._make_cache()
        cache.observed_tool_tokens = 50_000
        # Simulate pre_compact snapshot
        cache.pressure_baseline_tokens = _pressure_raw_total(cache)
        assert get_context_pressure(cache=cache).fill_fraction == 0.0
        # Simulate new reads after compact
        cache.observed_tool_tokens += 33_000
        cp = get_context_pressure(cache=cache)
        from token_goat.compact import CONTEXT_AUTOCOMPACT_TOKENS
        expected = 33_000 / CONTEXT_AUTOCOMPACT_TOKENS
        assert abs(cp.fill_fraction - expected) < 0.001
