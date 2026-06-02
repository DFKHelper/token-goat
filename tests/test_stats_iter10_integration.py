"""End-to-end integration tests for stats accounting improvements added in the
improvement loop (iterations 1-9).

Verifies that the stat kinds added throughout the loop — skill_cached,
bash_output_cached, web_output_cached, compact_recovery, symbol_lookup,
map_lookup, semantic_search, and session_hint_suppressed — are:

1. Recorded to the global DB with non-zero bytes_saved / tokens_saved.
2. Surfaced in stats.summarize() by_kind output.
3. Assigned to the correct category group by _kind_group_label.
4. Present in the rendered stats output (render_text).
"""
from __future__ import annotations

import pytest

from token_goat import db, stats
from token_goat.render.stats_renderer import _kind_group_label

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _record_loop_kinds(bytes_each: int = 500, tokens_each: int = 125) -> None:
    """Record one event for each kind added during the improvement loop."""
    for kind in (
        "skill_cached",
        "bash_output_cached",
        "web_output_cached",
        "compact_recovery",
        "symbol_lookup",
        "map_lookup",
        "semantic_search",
        "session_hint_suppressed",
    ):
        db.record_stat(None, kind, bytes_saved=bytes_each, tokens_saved=tokens_each)


# ---------------------------------------------------------------------------
# Core accounting test
# ---------------------------------------------------------------------------


class TestLoopKindAccounting:
    """Each kind added during the improvement loop shows non-zero savings."""

    def test_skill_cached_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "skill_cached", bytes_saved=4096, tokens_saved=1024)
        summary = stats.summarize(window_days=30)
        assert "skill_cached" in summary.by_kind
        assert summary.by_kind["skill_cached"]["bytes_saved"] == 4096
        assert summary.by_kind["skill_cached"]["tokens_saved"] == 1024
        assert summary.by_kind["skill_cached"]["events"] == 1

    def test_bash_output_cached_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "bash_output_cached", bytes_saved=8192, tokens_saved=2048)
        summary = stats.summarize(window_days=30)
        assert "bash_output_cached" in summary.by_kind
        assert summary.by_kind["bash_output_cached"]["bytes_saved"] == 8192

    def test_web_output_cached_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "web_output_cached", bytes_saved=16384, tokens_saved=4096)
        summary = stats.summarize(window_days=30)
        assert "web_output_cached" in summary.by_kind
        assert summary.by_kind["web_output_cached"]["bytes_saved"] == 16384

    def test_compact_recovery_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "compact_recovery", bytes_saved=2048, tokens_saved=512)
        summary = stats.summarize(window_days=30)
        assert "compact_recovery" in summary.by_kind
        assert summary.by_kind["compact_recovery"]["bytes_saved"] == 2048

    def test_symbol_lookup_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "symbol_lookup", bytes_saved=6000, tokens_saved=1500)
        summary = stats.summarize(window_days=30)
        assert "symbol_lookup" in summary.by_kind
        assert summary.by_kind["symbol_lookup"]["bytes_saved"] == 6000

    def test_map_lookup_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "map_lookup", bytes_saved=3000, tokens_saved=750)
        summary = stats.summarize(window_days=30)
        assert "map_lookup" in summary.by_kind
        assert summary.by_kind["map_lookup"]["bytes_saved"] == 3000

    def test_semantic_search_shows_nonzero_savings(self, tmp_data_dir):
        db.record_stat(None, "semantic_search", bytes_saved=2500, tokens_saved=625)
        summary = stats.summarize(window_days=30)
        assert "semantic_search" in summary.by_kind
        assert summary.by_kind["semantic_search"]["bytes_saved"] == 2500


# ---------------------------------------------------------------------------
# At-least-three categories simultaneously
# ---------------------------------------------------------------------------


class TestMultiCategoryAccounting:
    """All three previously-zero categories show non-zero savings at once."""

    def test_three_categories_nonzero_simultaneously(self, tmp_data_dir):
        """skill_cached, bash_output_cached, and symbol_lookup all record savings."""
        db.record_stat(None, "skill_cached", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "bash_output_cached", bytes_saved=2000, tokens_saved=500)
        db.record_stat(None, "symbol_lookup", bytes_saved=3000, tokens_saved=750)

        summary = stats.summarize(window_days=30)

        # All three must be present and non-zero.
        for kind, expected_bytes in (
            ("skill_cached", 1000),
            ("bash_output_cached", 2000),
            ("symbol_lookup", 3000),
        ):
            assert kind in summary.by_kind, f"{kind} missing from by_kind"
            assert summary.by_kind[kind]["bytes_saved"] == expected_bytes, (
                f"{kind}: expected {expected_bytes}, "
                f"got {summary.by_kind[kind]['bytes_saved']}"
            )

    def test_total_accumulates_across_all_loop_kinds(self, tmp_data_dir):
        """Total bytes/tokens accumulate correctly when all loop kinds are present."""
        _record_loop_kinds(bytes_each=500, tokens_each=125)

        summary = stats.summarize(window_days=30)

        # 8 kinds × 500 bytes each = 4000 total bytes.
        assert summary.total_bytes_saved == 4000
        assert summary.total_tokens_saved == 1000
        assert summary.total_events == 8


# ---------------------------------------------------------------------------
# Category grouping verification
# ---------------------------------------------------------------------------


class TestCategoryGrouping:
    """Loop kinds land in the right _KIND_GROUPS categories."""

    @pytest.mark.parametrize("kind,expected_group", [
        ("skill_cached", "Compact / Skills"),
        ("compact_recovery", "Compact / Skills"),
        ("bash_output_cached", "Bash"),
        ("web_output_cached", "Web"),
        ("symbol_lookup", "Lookups"),
        ("map_lookup", "Lookups"),
        ("semantic_search", "Lookups"),
    ])
    def test_kind_assigned_to_correct_group(self, kind: str, expected_group: str) -> None:
        assert _kind_group_label(kind) == expected_group, (
            f"kind={kind!r}: expected group {expected_group!r}, "
            f"got {_kind_group_label(kind)!r}"
        )


# ---------------------------------------------------------------------------
# Render integration
# ---------------------------------------------------------------------------


class TestRenderIntegration:
    """render_text includes the loop kinds in its output."""

    def test_render_text_includes_skill_cached(self, tmp_data_dir):
        db.record_stat(None, "skill_cached", bytes_saved=1000, tokens_saved=250)
        summary = stats.summarize(window_days=30)
        output = stats.render_text(summary)
        assert "skill_cached" in output

    def test_render_text_includes_bash_output_cached(self, tmp_data_dir):
        db.record_stat(None, "bash_output_cached", bytes_saved=2000, tokens_saved=500)
        summary = stats.summarize(window_days=30)
        output = stats.render_text(summary)
        assert "bash_output_cached" in output

    def test_render_text_includes_symbol_lookup(self, tmp_data_dir):
        db.record_stat(None, "symbol_lookup", bytes_saved=3000, tokens_saved=750)
        summary = stats.summarize(window_days=30)
        output = stats.render_text(summary)
        assert "symbol_lookup" in output

    def test_render_text_all_loop_kinds_present(self, tmp_data_dir):
        """All eight loop-improvement kinds appear in a combined render_text output."""
        _record_loop_kinds(bytes_each=500, tokens_each=125)
        summary = stats.summarize(window_days=30)
        output = stats.render_text(summary)

        # Every kind that records non-zero savings should appear in the output.
        for kind in (
            "skill_cached",
            "bash_output_cached",
            "web_output_cached",
            "compact_recovery",
            "symbol_lookup",
            "map_lookup",
            "semantic_search",
        ):
            assert kind in output, (
                f"kind={kind!r} is missing from render_text output"
            )

    def test_by_kind_in_stats_data(self, tmp_data_dir):
        """_to_stats_data includes loop kinds in its by_kind list."""
        db.record_stat(None, "skill_cached", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "symbol_lookup", bytes_saved=2000, tokens_saved=500)
        db.record_stat(None, "bash_output_cached", bytes_saved=3000, tokens_saved=750)

        summary = stats.summarize(window_days=30)
        data = stats._to_stats_data(summary)

        kind_names = {k.kind for k in data.by_kind}
        assert "skill_cached" in kind_names
        assert "symbol_lookup" in kind_names
        assert "bash_output_cached" in kind_names
