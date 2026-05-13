"""Data types consumed by the stats renderer — Python port of types.ts."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass
class TotalStats:
    events: int
    bytes: int
    tokens: int
    events_delta: float | None = None
    bytes_delta: float | None = None
    tokens_delta: float | None = None
    sparklines: dict[str, list[int]] | None = None  # keys: "events", "bytes", "tokens"


@dataclass
class KindStat:
    kind: str
    bytes: int
    tokens: int
    events: int
    bytes_mode_only: bool = False


@dataclass
class DayStat:
    date: str  # YYYY-MM-DD
    bytes: int
    tokens: int
    events: int


@dataclass
class ProjectStat:
    project: str   # display name (last path component)
    hash: str      # full project hash for deterministic colour
    path: str      # full project root path
    bytes: int
    tokens: int
    events: int


@dataclass
class Period:
    start: date
    end: date


@dataclass
class StatsData:
    period: Period
    totals: TotalStats
    by_kind: list[KindStat]        # sorted desc by bytes
    by_day: list[DayStat]          # all days; renderer takes top-N for table, all for heatmap
    by_project: list[ProjectStat]  # sorted desc by bytes; renderer takes top-N
