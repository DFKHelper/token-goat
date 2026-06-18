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
- ``SourceStat``: Per-source (image/hint/read/compact/other) breakdown row.
- ``Sparklines``: Normalised 0–1 float lists for the three KPI mini-charts.
- ``StatsData``: Top-level payload: totals + the breakdown lists.
"""
from __future__ import annotations

__all__ = [
    "CommandStat",
    "DayStat",
    "KindStat",
    "ProjectStat",
    "SourceStat",
    "Sparklines",
    "StatsData",
    "TotalStats",
]

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
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
class SourceStat:
    """Statistics for one user-facing source bucket (image / hint / read / compact / other).

    Sources collapse the raw event kinds into the four mechanisms token-goat ships
    (plus an ``other`` catch-all).  Renderer consumers can show "image vs hint vs
    read vs compact" without re-walking the underlying DB.
    """
    source: str
    bytes: int
    tokens: int
    events: int


@dataclass
class CommandStat:
    """Statistics for one CLI command (symbol, read, section, semantic, outline, etc.).

    CLI commands may record multiple underlying kinds (e.g., section_replacement +
    section_read both map to the "section" command). This view shows which command
    is most valuable for the user.
    """
    command: str
    bytes: int
    tokens: int
    events: int


@dataclass
class StatsData:
    """Complete stats payload for a reporting period: totals, by-kind, by-day, and by-project breakdowns.

    by_kind: All breakdown rows (no top-N applied); the renderer orders them by share.
    by_day: Caller-filtered top-N rows; the renderer orders them by share.
    by_project: Caller-filtered top-N rows; the renderer orders them by share.
    by_source: Sorted desc by bytes; collapses raw kinds into image/hint/read/compact/other.
        Defaults to empty so older callers that built StatsData before by_source
        shipped still construct without modification.
    by_command: Sorted desc by bytes; breaks down savings by CLI command (symbol, read, section, etc.).
        Defaults to empty so older callers / cached snapshots still load.
    version: Loaded token-goat package version string (e.g. "0.6.1"); "" when unknown.
    """
    period_start: date
    period_end: date
    totals: TotalStats
    # Renderer orders rows by share of savings; input order is not significant.
    # Pass all rows — the renderer applies no top-N limit here.
    by_kind: list[KindStat]
    # Renderer orders rows by share of savings. Caller decides top-N before passing in.
    by_day: list[DayStat]
    # Renderer orders rows by share of savings. Caller decides top-N before passing in.
    by_project: list[ProjectStat]
    # Sorted desc by bytes.  Optional and defaults to empty so older callers /
    # cached StatsData snapshots built before by_source shipped still load.
    by_source: list[SourceStat] = field(default_factory=list)
    # Sorted desc by bytes. Optional and defaults to empty so older callers /
    # cached StatsData snapshots built before by_command shipped still load.
    by_command: list[CommandStat] = field(default_factory=list)
    # Loaded token-goat package version, e.g. "0.6.1".  Defaults to "" so older
    # callers / cached snapshots built before this field shipped still load; the
    # renderer omits the version suffix when it is empty.
    version: str = ""
    # Human-readable window label, e.g. "last 30 days" or "all time".  Defaults
    # to "" so older callers / cached snapshots still load without modification.
    window_label: str = ""
