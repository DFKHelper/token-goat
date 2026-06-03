"""Cross-harness tool name consistency tests.

Asserts that:
1. Every harness-specific tool-name map's *values* are valid canonical tool names
   (prevents silent typos like "Webfetch" instead of "WebFetch").
2. The canonical tool set lives in exactly one place: hook_registry.CANONICAL_TOOLS.
3. Each harness covers at least its declared minimum set of canonical tools.

When adding a new tool to CANONICAL_TOOLS, add it to the appropriate harness
coverage sets below if that harness should handle it.  The tests fail fast
if a map value is not in CANONICAL_TOOLS, so typos are caught immediately.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING

import pytest

from token_goat import bridges, hook_registry
from token_goat.hook_registry import CANONICAL_TOOLS

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_ts_tool_to_tg(ts_source: str) -> dict[str, str]:
    """Parse the TOOL_TO_TG constant from an embedded TypeScript source string.

    Extracts ``{ key: "Value", ... }`` entries from the first ``TOOL_TO_TG``
    block in *ts_source*.  Returns a dict of ts_tool_name -> canonical_name.
    """
    match = re.search(
        r'const TOOL_TO_TG:\s*Record<string,\s*string>\s*=\s*\{([^}]+)\}',
        ts_source,
    )
    if not match:
        return {}
    result: dict[str, str] = {}
    for line in match.group(1).split("\n"):
        # Match lines like:  read: "Read",  or  apply_patch: "Edit",
        m = re.match(r'\s*(\w+):\s*"([^"]+)"', line)
        if m:
            result[m.group(1)] = m.group(2)
    return result


def _get_codex_tool_map() -> dict[str, str]:
    """Import the private Codex tool-name map from hooks_cli."""
    from token_goat.hooks_cli import _CODEX_TOOL_NAME_MAP  # noqa: PLC0415
    return dict(_CODEX_TOOL_NAME_MAP)


def _get_gemini_tool_map() -> dict[str, str]:
    """Import the private Gemini tool-name map from hooks_cli."""
    from token_goat.hooks_cli import _GEMINI_TOOL_NAME_MAP  # noqa: PLC0415
    return dict(_GEMINI_TOOL_NAME_MAP)


# ---------------------------------------------------------------------------
# CANONICAL_TOOLS is the single source of truth
# ---------------------------------------------------------------------------


class TestCanonicalToolsDefinition:
    def test_canonical_tools_exported_from_hook_registry(self) -> None:
        """CANONICAL_TOOLS must be reachable via hook_registry.__all__."""
        assert "CANONICAL_TOOLS" in hook_registry.__all__

    def test_canonical_tools_is_frozenset(self) -> None:
        assert isinstance(CANONICAL_TOOLS, frozenset)

    def test_canonical_tools_not_empty(self) -> None:
        assert len(CANONICAL_TOOLS) > 0

    def test_canonical_tools_contains_core_nine(self) -> None:
        """The nine tools present since the project's first public release."""
        expected = {"Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "WebFetch", "Grep", "Skill"}
        assert expected == CANONICAL_TOOLS, (
            f"CANONICAL_TOOLS changed unexpectedly.\n"
            f"Expected: {sorted(expected)}\n"
            f"Got:      {sorted(CANONICAL_TOOLS)}"
        )

    def test_hooks_cli_tg_known_tools_matches_canonical(self) -> None:
        """hooks_cli._TG_KNOWN_TOOLS must be the same object as CANONICAL_TOOLS."""
        from token_goat.hooks_cli import _TG_KNOWN_TOOLS  # noqa: PLC0415
        assert _TG_KNOWN_TOOLS is CANONICAL_TOOLS, (
            "_TG_KNOWN_TOOLS in hooks_cli.py must import and reference "
            "hook_registry.CANONICAL_TOOLS, not redefine it."
        )


# ---------------------------------------------------------------------------
# All map values must be valid canonical names
# ---------------------------------------------------------------------------


class TestToolMapValuesAreCanonical:
    """Every value in every harness-specific tool-name map must appear in
    CANONICAL_TOOLS.  This catches typos (e.g. 'WebFetch' vs 'Webfetch') and
    new tool names added to maps without first updating CANONICAL_TOOLS."""

    def test_codex_map_values_are_canonical(self) -> None:
        codex_map = _get_codex_tool_map()
        assert codex_map, "Codex tool map is empty — import may have failed"
        bad = {v for v in codex_map.values() if v not in CANONICAL_TOOLS}
        assert not bad, (
            f"Codex tool map contains values not in CANONICAL_TOOLS: {sorted(bad)}\n"
            f"Either fix the map value or add the tool to CANONICAL_TOOLS."
        )

    def test_gemini_map_values_are_canonical(self) -> None:
        gemini_map = _get_gemini_tool_map()
        assert gemini_map, "Gemini tool map is empty — import may have failed"
        bad = {v for v in gemini_map.values() if v not in CANONICAL_TOOLS}
        assert not bad, (
            f"Gemini tool map contains values not in CANONICAL_TOOLS: {sorted(bad)}\n"
            f"Either fix the map value or add the tool to CANONICAL_TOOLS."
        )

    def test_opencode_bridge_map_values_are_canonical(self) -> None:
        ts_map = _extract_ts_tool_to_tg(bridges.OPENCODE_PLUGIN_TS)
        assert ts_map, "Could not parse TOOL_TO_TG from OPENCODE_PLUGIN_TS — regex may need updating"
        bad = {v for v in ts_map.values() if v not in CANONICAL_TOOLS}
        assert not bad, (
            f"opencode bridge TOOL_TO_TG contains values not in CANONICAL_TOOLS: {sorted(bad)}\n"
            f"Either fix the bridge map value or add the tool to CANONICAL_TOOLS."
        )

    def test_openclaw_bridge_map_values_are_canonical(self) -> None:
        ts_map = _extract_ts_tool_to_tg(bridges.OPENCLAW_PLUGIN_TS)
        assert ts_map, "Could not parse TOOL_TO_TG from OPENCLAW_PLUGIN_TS — regex may need updating"
        bad = {v for v in ts_map.values() if v not in CANONICAL_TOOLS}
        assert not bad, (
            f"openclaw bridge TOOL_TO_TG contains values not in CANONICAL_TOOLS: {sorted(bad)}\n"
            f"Either fix the bridge map value or add the tool to CANONICAL_TOOLS."
        )


# ---------------------------------------------------------------------------
# Minimum coverage per harness
# ---------------------------------------------------------------------------
#
# These sets document the minimum tools each harness is expected to route.
# They are deliberately conservative — not "must cover all 9" but "must cover
# the subset this harness actually supports".  If a harness gains a new tool,
# add it here (and to the harness map) so future regressions are caught.


#: Tools that Codex supports.  Codex has no Read (uses Bash+cat), no Skill.
#: MultiEdit maps through apply_patch → Edit rather than as a distinct entry.
_CODEX_MIN_COVERAGE: frozenset[str] = frozenset({"Bash", "Edit", "Glob", "Grep", "WebFetch", "Write"})

#: Tools that Gemini CLI supports.  Gemini has no Skill or MultiEdit.
_GEMINI_MIN_COVERAGE: frozenset[str] = frozenset({"Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "Write"})

#: opencode has no Write (write is not a distinct opencode tool; edits go through
#: edit/apply_patch).  No MultiEdit or Skill.
_OPENCODE_MIN_COVERAGE: frozenset[str] = frozenset({"Bash", "Edit", "Glob", "Grep", "Read", "WebFetch"})

#: openclaw has no MultiEdit or Skill.
_OPENCLAW_MIN_COVERAGE: frozenset[str] = frozenset(
    {"Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "Write"}
)


class TestHarnessCoverageMinimums:
    """Each harness must route at least its declared minimum tool set.

    These tests catch regressions where a tool entry is accidentally removed
    from a harness map without a corresponding update to the minimum set.
    """

    def test_codex_covers_minimum_tools(self) -> None:
        codex_map = _get_codex_tool_map()
        covered = set(codex_map.values())
        missing = _CODEX_MIN_COVERAGE - covered
        assert not missing, (
            f"Codex tool map is missing expected tools: {sorted(missing)}\n"
            f"Add mappings for these tools or update _CODEX_MIN_COVERAGE."
        )

    def test_gemini_covers_minimum_tools(self) -> None:
        gemini_map = _get_gemini_tool_map()
        covered = set(gemini_map.values())
        missing = _GEMINI_MIN_COVERAGE - covered
        assert not missing, (
            f"Gemini tool map is missing expected tools: {sorted(missing)}\n"
            f"Add mappings for these tools or update _GEMINI_MIN_COVERAGE."
        )

    def test_opencode_bridge_covers_minimum_tools(self) -> None:
        ts_map = _extract_ts_tool_to_tg(bridges.OPENCODE_PLUGIN_TS)
        covered = set(ts_map.values())
        missing = _OPENCODE_MIN_COVERAGE - covered
        assert not missing, (
            f"opencode bridge TOOL_TO_TG is missing expected tools: {sorted(missing)}\n"
            f"Add mappings for these tools or update _OPENCODE_MIN_COVERAGE."
        )

    def test_openclaw_bridge_covers_minimum_tools(self) -> None:
        ts_map = _extract_ts_tool_to_tg(bridges.OPENCLAW_PLUGIN_TS)
        covered = set(ts_map.values())
        missing = _OPENCLAW_MIN_COVERAGE - covered
        assert not missing, (
            f"openclaw bridge TOOL_TO_TG is missing expected tools: {sorted(missing)}\n"
            f"Add mappings for these tools or update _OPENCLAW_MIN_COVERAGE."
        )


# ---------------------------------------------------------------------------
# Cross-harness: all declared minimums use only canonical names
# ---------------------------------------------------------------------------


class TestMinimumCoverageSetsAreCanonical:
    """The _*_MIN_COVERAGE constants themselves must reference only valid tool names.

    This prevents the minimum sets from going stale if a tool is renamed in
    CANONICAL_TOOLS without updating these constants.
    """

    @pytest.mark.parametrize("name,coverage_set", [
        ("Codex", _CODEX_MIN_COVERAGE),
        ("Gemini", _GEMINI_MIN_COVERAGE),
        ("opencode", _OPENCODE_MIN_COVERAGE),
        ("openclaw", _OPENCLAW_MIN_COVERAGE),
    ])
    def test_min_coverage_set_is_subset_of_canonical(
        self, name: str, coverage_set: frozenset[str]
    ) -> None:
        bad = coverage_set - CANONICAL_TOOLS
        assert not bad, (
            f"{name} minimum coverage set references tool(s) not in CANONICAL_TOOLS: {sorted(bad)}"
        )
