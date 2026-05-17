"""Tests for the fancy ANSI stats renderer.

Focuses on the by-source rollup added on top of the existing kind/day/project
sections.  Snapshot-style assertions strip ANSI escapes so the tests survive
palette tweaks while still verifying structural stability (column ordering,
row presence, ordering by bytes, backward-compat fallback).
"""
from __future__ import annotations

from datetime import date

import pytest

from token_goat.render.ansi import strip_ansi
from token_goat.render.stats_renderer import (
    _render_by_source_section,
    _source_color,
    render_stats,
)
from token_goat.render.types import (
    DayStat,
    KindStat,
    ProjectStat,
    SourceStat,
    StatsData,
    TotalStats,
)


def _make_stats(by_source: list[SourceStat] | None = None) -> StatsData:
    """Return a minimal StatsData with optional by_source override."""
    return StatsData(
        period_start=date(2026, 1, 1),
        period_end=date(2026, 1, 31),
        totals=TotalStats(events=10, bytes=10_000, tokens=2_500),
        by_kind=[
            KindStat(kind="image_shrink", bytes=4_000, tokens=0, events=4, bytes_mode_only=True),
            KindStat(kind="read_replacement", bytes=3_000, tokens=750, events=3),
            KindStat(kind="session_hint", bytes=2_000, tokens=500, events=2),
            KindStat(kind="compact_manifest", bytes=1_000, tokens=250, events=1),
        ],
        by_day=[DayStat(date="2026-01-15", bytes=10_000, tokens=2_500, events=10)],
        by_project=[
            ProjectStat(
                project="example",
                hash="abc12345",
                path="/tmp/example",
                bytes=10_000,
                tokens=2_500,
                events=10,
            )
        ],
        by_source=by_source if by_source is not None else [
            SourceStat(source="image",   bytes=4_000, tokens=0,    events=4),
            SourceStat(source="read",    bytes=3_000, tokens=750,  events=3),
            SourceStat(source="hint",    bytes=2_000, tokens=500,  events=2),
            SourceStat(source="compact", bytes=1_000, tokens=250,  events=1),
        ],
    )


class TestBySourceRendering:
    """The "By source" section appears with the expected rows and ordering."""

    def test_section_header_present(self):
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        assert "By source" in plain
        assert "source" in plain  # table header column label

    def test_all_four_sources_render(self):
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        for src in ("image", "hint", "read", "compact"):
            assert src in plain, f"source {src!r} missing from rendered output"

    def test_rows_sorted_desc_by_bytes(self):
        """Largest-byte source must appear before smaller ones in the output."""
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        # Order should be: image (4kB) > read (3kB) > hint (2kB) > compact (1kB)
        idx_image   = plain.index("image")
        idx_read    = plain.index("read")
        idx_hint    = plain.index("hint")
        idx_compact = plain.index("compact")
        assert idx_image < idx_read < idx_hint < idx_compact

    def test_column_layout_matches_other_tables(self):
        """The header row must include data saved / tokens saved / share / events."""
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        assert "savings" in plain
        assert "data saved" in plain
        assert "tokens saved" in plain
        assert "share" in plain
        assert "events" in plain

    def test_unknown_source_falls_back_to_muted(self):
        """A future / unknown source name renders rather than crashing."""
        from token_goat.render.ansi import C
        assert _source_color("future-bucket") == C.TEXT_MUTED

    def test_known_sources_get_distinct_colors(self):
        """The four canonical sources each get a unique colour assignment."""
        colors = {
            _source_color("image"),
            _source_color("hint"),
            _source_color("read"),
            _source_color("compact"),
        }
        assert len(colors) == 4  # all four are visually distinct


class TestBySourceBackwardCompat:
    """Older StatsData snapshots without by_source must still render cleanly."""

    def test_empty_by_source_returns_no_lines(self):
        """An empty by_source list produces no output lines (section is skipped)."""
        stats = _make_stats(by_source=[])
        assert _render_by_source_section(stats) == []

    def test_stats_data_constructs_without_by_source(self):
        """StatsData must accept the legacy positional-arg signature."""
        s = StatsData(
            period_start=date(2026, 1, 1),
            period_end=date(2026, 1, 31),
            totals=TotalStats(events=0, bytes=0, tokens=0),
            by_kind=[],
            by_day=[],
            by_project=[],
        )
        assert s.by_source == []
        assert isinstance(s.by_source, list)

    def test_render_stats_skips_section_when_empty(self):
        """Full render with empty by_source must not crash and must omit the panel."""
        stats = _make_stats(by_source=[])
        out = render_stats(stats)
        plain = strip_ansi(out)
        # Other sections still render.
        assert "By kind" in plain
        # And the absent by_source panel does not leave a stray header.
        assert "By source" not in plain


class TestBySourceFullRender:
    """End-to-end: render_stats glues the by_source panel into the output."""

    def test_by_source_appears_in_full_render(self):
        """When by_source is populated the panel shows up after By kind."""
        out = render_stats(_make_stats())
        plain = strip_ansi(out)
        assert "By source" in plain
        # Sanity: kind section must precede source section in the output.
        assert plain.index("By kind") < plain.index("By source")

    def test_snapshot_structure(self):
        """Stable snapshot of the rendered by_source line count (ANSI-stripped).

        Section header emits: leading-blank + title + rule.  Then 1 table-header
        + 4 data rows.  After ANSI-strip and counting non-blank lines we expect
        title + rule + header + 4 rows = 7 lines.
        """
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        non_blank = [ln for ln in plain.splitlines() if ln.strip()]
        assert len(non_blank) == 7

    @pytest.mark.parametrize("source,expected_bytes,expected_events", [
        ("image",   "4.0 KB", 4),
        ("read",    "3.0 KB", 3),
        ("hint",    "2.0 KB", 2),
        ("compact", "1.0 KB", 1),
    ])
    def test_each_source_shows_correct_bytes(self, source, expected_bytes, expected_events):
        """Bytes-saved magnitude string and event count render next to the source label."""
        out = "\n".join(_render_by_source_section(_make_stats()))
        plain = strip_ansi(out)
        for line in plain.splitlines():
            if source in line:
                assert expected_bytes in line, (
                    f"expected {expected_bytes!r} in {source!r} row: {line!r}"
                )
                assert f"{expected_events}" in line.split()[-1], (
                    f"expected events column {expected_events!r} at end of row: {line!r}"
                )
                return
        pytest.fail(f"source {source!r} not found in output")
