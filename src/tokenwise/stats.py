"""Token-savings telemetry aggregator."""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from . import db

# Kinds that track bytes but not (reliable) token counts.
BYTES_MODE_ONLY_KINDS: frozenset[str] = frozenset({"image_shrink", "webfetch_image", "gdrive_image"})

_LOG = logging.getLogger("tokenwise.stats")


@dataclass
class StatsSummary:
    """Aggregated statistics across projects and time."""

    total_events: int
    total_bytes_saved: int
    total_tokens_saved: int
    by_kind: dict[str, dict]  # kind -> {events, bytes_saved, tokens_saved}
    by_day: list[dict]  # newest first: {date, events, bytes_saved, tokens_saved}
    by_project: list[dict]  # {project_hash, project_root, events, bytes_saved, tokens_saved}
    window_days: int


def _read_stats(
    conn: sqlite3.Connection, since_ts: float | None
) -> list[sqlite3.Row]:
    """Fetch stats rows from the given connection."""
    if since_ts:
        rows = conn.execute(
            "SELECT ts, kind, tokens_saved, bytes_saved, detail FROM stats WHERE ts >= ? ORDER BY ts",
            (int(since_ts),),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT ts, kind, tokens_saved, bytes_saved, detail FROM stats ORDER BY ts"
        ).fetchall()
    return rows


def summarize(window_days: int = 30) -> StatsSummary:
    """Aggregate stats from global.db + all known per-project DBs over the last N days."""
    since_ts = (
        (datetime.now() - timedelta(days=window_days)).timestamp()
        if window_days > 0
        else None
    )

    by_kind: dict[str, dict] = defaultdict(
        lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0}
    )
    by_day: dict[str, dict] = defaultdict(
        lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0}
    )
    by_project: dict[str, dict] = defaultdict(
        lambda: {"events": 0, "bytes_saved": 0, "tokens_saved": 0, "project_root": ""}
    )
    total_events = 0
    total_bytes = 0
    total_tokens = 0

    # Global DB
    projects = []
    try:
        with db.open_global() as conn:
            for row in _read_stats(conn, since_ts):
                _accumulate(row, by_kind, by_day)
                total_events += 1
                total_bytes += row["bytes_saved"] or 0
                total_tokens += row["tokens_saved"] or 0

            # Pull project list for per-project rollup
            project_rows = conn.execute(
                "SELECT hash, root FROM projects"
            ).fetchall()
            projects = [(r["hash"], r["root"]) for r in project_rows]
    except Exception:  # noqa: BLE001
        _LOG.exception("global stats read failed")

    # Per-project DBs
    for project_hash, project_root in projects:
        try:
            with db.open_project(project_hash) as conn:
                rows = _read_stats(conn, since_ts)
                for row in rows:
                    _accumulate(row, by_kind, by_day)
                    total_events += 1
                    total_bytes += row["bytes_saved"] or 0
                    total_tokens += row["tokens_saved"] or 0
                    p = by_project[project_hash]
                    p["events"] += 1
                    p["bytes_saved"] += row["bytes_saved"] or 0
                    p["tokens_saved"] += row["tokens_saved"] or 0
                    p["project_root"] = project_root
        except Exception:  # noqa: BLE001
            _LOG.exception("project stats read failed: %s", project_hash[:8])

    by_day_list = sorted(
        [{"date": k, **v} for k, v in by_day.items()],
        key=lambda d: d["date"],
        reverse=True,
    )
    by_project_list = sorted(
        [
            {
                "project_hash": k,  # full hash; callers truncate for display
                "project_root": v["project_root"],
                "events": v["events"],
                "bytes_saved": v["bytes_saved"],
                "tokens_saved": v["tokens_saved"],
            }
            for k, v in by_project.items()
        ],
        key=lambda p: p["bytes_saved"],
        reverse=True,
    )

    return StatsSummary(
        total_events=total_events,
        total_bytes_saved=total_bytes,
        total_tokens_saved=total_tokens,
        by_kind=dict(by_kind),
        by_day=by_day_list,
        by_project=by_project_list,
        window_days=window_days,
    )


def _accumulate(row: sqlite3.Row, by_kind: dict, by_day: dict) -> None:
    """Accumulate a stats row into the kind and day dictionaries."""
    kind = row["kind"]
    bytes_saved = row["bytes_saved"] or 0
    tokens_saved = row["tokens_saved"] or 0
    by_kind[kind]["events"] += 1
    by_kind[kind]["bytes_saved"] += bytes_saved
    by_kind[kind]["tokens_saved"] += tokens_saved

    date_str = datetime.fromtimestamp(row["ts"]).strftime("%Y-%m-%d")
    d = by_day[date_str]
    d["events"] += 1
    d["bytes_saved"] += bytes_saved
    d["tokens_saved"] += tokens_saved


def _fmt_bytes(n: int) -> str:
    """Format byte count as human-readable (B/KB/MB/GB)."""
    value: float = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if abs(value) < 1024:
            return f"{int(value)}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value = value / 1024
    return f"{value:.1f}TB"


def _fmt_tokens(n: int) -> str:
    """Format token count as human-readable (t/kt/Mt)."""
    if n < 1000:
        return f"{n}t"
    if n < 1_000_000:
        return f"{n/1000:.1f}kt"
    return f"{n/1_000_000:.2f}Mt"


def _short_project(root: str) -> str:
    """Last path component of a project root, for compact display."""
    if not root:
        return "(unknown)"
    cleaned = root.rstrip("/\\")
    sep = "\\" if "\\" in cleaned else "/"
    tail = cleaned.split(sep)[-1] if sep in cleaned else cleaned
    return tail[:28]


def _to_stats_data(summary: StatsSummary) -> "StatsData":
    """Convert StatsSummary to the render layer's StatsData."""
    from .render.types import DayStat, KindStat, Period, ProjectStat, StatsData, TotalStats

    today = date.today()
    if summary.window_days > 0:
        period_start = today - timedelta(days=summary.window_days)
    elif summary.by_day:
        period_start = date.fromisoformat(summary.by_day[-1]["date"])  # by_day newest-first
    else:
        period_start = today

    by_kind = sorted(
        [
            KindStat(
                kind=k,
                bytes=v["bytes_saved"],
                tokens=v["tokens_saved"],
                events=v["events"],
                bytes_mode_only=k in BYTES_MODE_ONLY_KINDS,
            )
            for k, v in summary.by_kind.items()
        ],
        key=lambda k: k.bytes,
        reverse=True,
    )

    by_day = sorted(
        [
            DayStat(
                date=d["date"],
                bytes=d["bytes_saved"],
                tokens=d["tokens_saved"],
                events=d["events"],
            )
            for d in summary.by_day
        ],
        key=lambda d: d.date,
    )

    by_project = [
        ProjectStat(
            project=_short_project(p["project_root"]),
            hash=p["project_hash"],
            path=p["project_root"] or "(unknown)",
            bytes=p["bytes_saved"],
            tokens=p["tokens_saved"],
            events=p["events"],
        )
        for p in summary.by_project
    ]

    return StatsData(
        period=Period(start=period_start, end=today),
        totals=TotalStats(
            events=summary.total_events,
            bytes=summary.total_bytes_saved,
            tokens=summary.total_tokens_saved,
        ),
        by_kind=by_kind,
        by_day=by_day,
        by_project=by_project,
    )


# Bar character set; finer-grained than █░ for half-block resolution.
_BAR_FILL = "█"
_BAR_PARTIAL = "▏▎▍▌▋▊▉"  # 1/8 through 7/8
_BAR_EMPTY = " "

# Sparkline char set; 0/8 (no value) through 8/8 (max).
_SPARK = " ▁▂▃▄▅▆▇█"


def _bar_text(value: int, max_value: int, width: int = 28) -> tuple[str, str]:
    """Return (bar_string, rich_style) where bar uses 1/8-block resolution.

    Style ramps yellow -> green -> cyan as fill grows, giving the eye a
    quick read of relative magnitude across rows.
    """
    if max_value <= 0 or value <= 0:
        return _BAR_EMPTY * width, "dim"
    fill_units = (value / max_value) * width
    whole = int(fill_units)
    remainder = fill_units - whole
    bar = _BAR_FILL * whole
    if whole < width and remainder > 0:
        idx = max(0, min(6, int(remainder * 8) - 1))
        bar += _BAR_PARTIAL[idx]
        bar += _BAR_EMPTY * (width - whole - 1)
    else:
        bar += _BAR_EMPTY * (width - whole)
    # Color graded by saturation ratio.
    ratio = min(1.0, value / max_value)
    if ratio >= 0.66:
        style = "bold cyan"
    elif ratio >= 0.33:
        style = "bold green"
    else:
        style = "yellow"
    return bar, style


def _sparkline(values: list[int]) -> str:
    """Render a sequence of values as a unicode sparkline."""
    if not values:
        return ""
    hi = max(values)
    if hi <= 0:
        return _SPARK[0] * len(values)
    out = []
    for v in values:
        idx = 0 if v <= 0 else max(1, min(8, round((v / hi) * 8)))
        out.append(_SPARK[idx])
    return "".join(out)


def render_text(
    summary: StatsSummary, *, top_days: int = 7, top_projects: int = 5
) -> str:
    """Render stats using the ANSI truecolor renderer.

    Delegates to render.stats_renderer.render_stats() for the rich visual
    output (gradient bars, heatmap, insights). Falls back to the legacy
    rich-based renderer if the render package is unavailable.
    """
    try:
        from .render.stats_renderer import render_stats
        return render_stats(_to_stats_data(summary))
    except Exception:
        _LOG.debug("new renderer failed, falling back to rich", exc_info=True)

    import io

    from rich.box import ROUNDED
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text

    buf = io.StringIO()
    console = Console(
        file=buf,
        force_terminal=True,
        color_system="truecolor",
        width=80,
        legacy_windows=False,
    )

    window_desc = (
        "all time" if summary.window_days == 0 else f"last {summary.window_days} days"
    )

    # ---- Headline panel ----
    # Keep label+value pairs as single styled segments so substring matches
    # (e.g. "Total: 2 events") survive the ANSI wrapping.
    headline = Text("\n  ", style="")
    headline.append(f"Total: {summary.total_events:,} events", style="bold magenta")
    headline.append("     ", style="")
    headline.append(
        f"{_fmt_bytes(summary.total_bytes_saved)} saved", style="bold green"
    )
    headline.append("     ", style="")
    headline.append(
        f"~{_fmt_tokens(summary.total_tokens_saved)} tokens (estimated)",
        style="bold cyan",
    )
    headline.append("\n", style="")

    console.print(
        Panel(
            headline,
            title=Text.assemble(
                ("tokenwise stats", "bold white"),
                ("  ·  ", "dim"),
                (window_desc, "cyan"),
            ),
            title_align="left",
            border_style="bright_cyan",
            box=ROUNDED,
            padding=(0, 1),
        )
    )

    # ---- By kind ----
    if summary.by_kind:
        console.print()
        console.print(Text("By kind:", style="bold"))
        kinds_sorted = sorted(
            summary.by_kind,
            key=lambda k: summary.by_kind[k]["bytes_saved"],
            reverse=True,
        )
        max_bytes = max(
            (summary.by_kind[k]["bytes_saved"] for k in kinds_sorted), default=0
        )
        tbl = Table(
            show_header=True,
            header_style="bold dim",
            show_lines=False,
            show_edge=False,
            box=None,
            pad_edge=False,
            padding=(0, 1),
        )
        tbl.add_column("kind", style="white", no_wrap=True, width=18)
        tbl.add_column("savings (relative)", no_wrap=True, width=28)
        tbl.add_column("bytes", justify="right", style="bold green", width=10)
        tbl.add_column("tokens", justify="right", style="bold cyan", width=10)
        tbl.add_column("events", justify="right", style="dim", width=7)
        for kind in kinds_sorted:
            v = summary.by_kind[kind]
            bar, bar_style = _bar_text(v["bytes_saved"], max_bytes)
            tbl.add_row(
                kind,
                Text(bar, style=bar_style),
                _fmt_bytes(v["bytes_saved"]),
                _fmt_tokens(v["tokens_saved"]),
                f"{v['events']} ev",
            )
        console.print(tbl)

        # Hint when image_shrink shows 0 tokens. Not a bug; we track bytes
        # for images because vision-token cost is model-specific.
        img = summary.by_kind.get("image_shrink")
        if img and img["events"] > 0 and img["tokens_saved"] == 0:
            console.print(
                Text(
                    "  note: image_shrink tracks bytes, not vision tokens "
                    "(model-specific math).",
                    style="dim italic",
                )
            )

    # ---- Activity sparkline (last 7 days, oldest -> newest) ----
    if summary.by_day:
        days_for_spark = summary.by_day[:top_days]
        # by_day is newest-first; reverse for left-to-right time progression.
        days_chrono = list(reversed(days_for_spark))
        spark_values = [d["events"] for d in days_chrono]
        spark = _sparkline(spark_values)
        date_range = (
            f"{days_chrono[0]['date']} -> {days_chrono[-1]['date']}"
            if len(days_chrono) > 1
            else days_chrono[0]["date"]
        )
        console.print()
        spark_line = Text()
        spark_line.append("Activity ", style="bold")
        spark_line.append(f"({date_range})  ", style="dim")
        spark_line.append(spark, style="bold green")
        console.print(spark_line)

    # ---- By day (top N) ----
    if summary.by_day:
        console.print()
        console.print(Text(f"By day (top {top_days}):", style="bold"))
        days = summary.by_day[:top_days]
        max_bytes = max((d["bytes_saved"] for d in days), default=0)
        tbl = Table(
            show_header=True,
            header_style="bold dim",
            show_edge=False,
            box=None,
            pad_edge=False,
            padding=(0, 1),
        )
        tbl.add_column("date", style="white", no_wrap=True, width=18)
        tbl.add_column("savings (relative)", no_wrap=True, width=28)
        tbl.add_column("bytes", justify="right", style="bold green", width=10)
        tbl.add_column("tokens", justify="right", style="bold cyan", width=10)
        tbl.add_column("events", justify="right", style="dim", width=7)
        for d in days:
            bar, bar_style = _bar_text(d["bytes_saved"], max_bytes)
            tbl.add_row(
                d["date"],
                Text(bar, style=bar_style),
                _fmt_bytes(d["bytes_saved"]),
                _fmt_tokens(d["tokens_saved"]),
                f"{d['events']} ev",
            )
        console.print(tbl)

    # ---- By project ----
    if summary.by_project:
        console.print()
        console.print(Text(f"By project (top {top_projects}):", style="bold"))
        projs = summary.by_project[:top_projects]
        max_bytes = max((p["bytes_saved"] for p in projs), default=0)
        tbl = Table(
            show_header=True,
            header_style="bold dim",
            show_edge=False,
            box=None,
            pad_edge=False,
            padding=(0, 1),
        )
        tbl.add_column("project", style="white", no_wrap=True, width=18)
        tbl.add_column("savings (relative)", no_wrap=True, width=28)
        tbl.add_column("bytes", justify="right", style="bold green", width=10)
        tbl.add_column("tokens", justify="right", style="bold cyan", width=10)
        tbl.add_column("events", justify="right", style="dim", width=7)
        for p in projs:
            label = _short_project(p["project_root"])
            bar, bar_style = _bar_text(p["bytes_saved"], max_bytes)
            tbl.add_row(
                label,
                Text(bar, style=bar_style),
                _fmt_bytes(p["bytes_saved"]),
                _fmt_tokens(p["tokens_saved"]),
                f"{p['events']} ev",
            )
        console.print(tbl)
        # Hash + full path under each row, dimmed.
        for p in projs:
            console.print(
                Text("    ", style="")
                + Text(f"{p['project_hash'][:8]}  ", style="dim cyan")
                + Text(p["project_root"] or "(unknown)", style="dim")
            )

    if summary.total_events == 0:
        console.print()
        console.print(
            Text(
                "(no recorded savings yet. tokenwise will accumulate stats as it "
                "intercepts reads, image fetches, etc.)",
                style="dim italic",
            )
        )

    return buf.getvalue()
