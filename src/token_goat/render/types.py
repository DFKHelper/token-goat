"""Data-transfer types for the stats renderer.

All types are plain ``dataclasses``.  The rendering pipeline in
``stats_renderer.py`` consumes a ``StatsData`` object populated by
``cli_stats.py``.

Dataclasses:
- ``TotalStats``: Aggregate events/bytes/tokens for a period with optional
  period-over-period deltas and sparkline data.
- ``KindStat``: Per-event-kind breakdown (e.g. Read, image_shrink).
- ``DayStat``: Daily activity row (date string, bytes, tokens, events).
- ``ProjectStat``: Per-project breakdown row.
- ``Sparklines``: Normalised 0–1 float lists for the three KPI mini-charts.
- ``StatsData``: Top-level payload: totals + the three breakdown lists.
"""
from __future__ import annotations

__all__ = ["DayStat", "KindStat", "ProjectStat", "Sparklines", "StatsData", "TotalStats"]

from dataclasses import dataclass
from datetime import date


@dataclass
class Sparklines:
    """Mini sparkline data: normalized 0.0–1.0 values for a small chart (8+ recent data points).

    Each list represents the same time period (daily, weekly, etc.) for one metric type.
    """
    events: list[float]
    bytes: list[float]
    tokens: list[float]


@dataclass
class TotalStats:
    """Aggregate statistics for a reporting period (events, bytes, tokens, and optional deltas).

    Deltas represent percentage change vs. the equivalent prior period (e.g., 12 means +12%).
    Sparklines optionally provide 8+ mini-chart data points for visual trend display.
    """
    events: int
    bytes: int
    tokens: int
    # % change vs the equivalent prior period, e.g. 12 means +12%. Omit if unavailable.
    events_delta: float | None = None
    bytes_delta: float | None = None
    tokens_delta: float | None = None
    # 8+ recent data points for mini sparklines under each KPI. Omit to skip sparkline row.
    sparklines: Sparklines | None = None


@dataclass
class KindStat:
    """Statistics for one event kind (e.g., 'Read', 'image_shrink', 'Grep').

    If bytes_mode_only is True, tokens are not reported (render as "—") because they are
    model-specific and not reliably measurable (used for vision-token kinds like image_shrink).
    """
    kind: str
    bytes: int
    tokens: int
    events: int
    # Set True for kinds like image_shrink where vision token counts are model-specific
    # and not reliably measurable. Renders the tokens column as "—".
    bytes_mode_only: bool = False


@dataclass
class DayStat:
    """Daily statistics: date string (YYYY-MM-DD), bytes processed, tokens saved, event count."""
    date: str  # YYYY-MM-DD
    bytes: int
    tokens: int
    events: int


@dataclass
class ProjectStat:
    """Project-level statistics: name, hash (for tree display), absolute path, and metrics.

    The hash is typically a short session or commit ID shown in the tree path line for identification.
    """
    project: str
    hash: str   # short session/commit id shown in the tree path line
    path: str
    bytes: int
    tokens: int
    events: int


@dataclass
class StatsData:
    """Complete stats payload for a reporting period: totals, by-kind, by-day, and by-project breakdowns.

    by_kind: All rows, sorted desc by bytes (no top-N applied; renderer handles display limits).
    by_day: Caller-filtered top-N rows, sorted desc by bytes.
    by_project: Caller-filtered top-N rows, sorted desc by bytes.
    """
    period_start: date
    period_end: date
    totals: TotalStats
    # Sorted desc by bytes. Pass all rows — renderer applies no top-N limit here.
    by_kind: list[KindStat]
    # Sorted desc by bytes. Caller decides top-N before passing in.
    by_day: list[DayStat]
    # Sorted desc by bytes. Caller decides top-N before passing in.
    by_project: list[ProjectStat]
