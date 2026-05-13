from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Optional


@dataclass
class Sparklines:
    events: list[float]
    bytes: list[float]
    tokens: list[float]


@dataclass
class TotalStats:
    events: int
    bytes: int
    tokens: int
    # % change vs the equivalent prior period, e.g. 12 means +12%. Omit if unavailable.
    events_delta: Optional[float] = None
    bytes_delta: Optional[float] = None
    tokens_delta: Optional[float] = None
    # 8+ recent data points for mini sparklines under each KPI. Omit to skip sparkline row.
    sparklines: Optional[Sparklines] = None


@dataclass
class KindStat:
    kind: str
    bytes: int
    tokens: int
    events: int
    # Set True for kinds like image_shrink where vision token counts are model-specific
    # and not reliably measurable. Renders the tokens column as "—".
    bytes_mode_only: bool = False


@dataclass
class DayStat:
    date: str  # YYYY-MM-DD
    bytes: int
    tokens: int
    events: int


@dataclass
class ProjectStat:
    project: str
    hash: str   # short session/commit id shown in the tree path line
    path: str
    bytes: int
    tokens: int
    events: int


@dataclass
class StatsData:
    period_start: date
    period_end: date
    totals: TotalStats
    # Sorted desc by bytes. Pass all rows — renderer applies no top-N limit here.
    by_kind: list[KindStat]
    # Sorted desc by bytes. Caller decides top-N before passing in.
    by_day: list[DayStat]
    # Sorted desc by bytes. Caller decides top-N before passing in.
    by_project: list[ProjectStat]
