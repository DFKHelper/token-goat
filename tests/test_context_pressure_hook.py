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
            lambda _sid: ContextPressure(fill_fraction=0.3, tier="cool"),
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
            lambda _sid: ContextPressure(fill_fraction=0.75, tier="hot"),
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
            lambda _sid: ContextPressure(fill_fraction=0.90, tier="critical"),
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
            lambda _sid: ContextPressure(fill_fraction=0.60, tier="warm"),
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
            lambda _sid: ContextPressure(fill_fraction=0.92, tier="critical"),
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
            lambda _sid: ContextPressure(fill_fraction=0.77, tier="hot"),
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
            lambda _sid: ContextPressure(fill_fraction=0.60, tier="warm"),
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
            lambda _sid: ContextPressure(fill_fraction=0.2, tier="cool"),
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
