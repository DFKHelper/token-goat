"""Token-savings telemetry aggregator."""
from __future__ import annotations

import hashlib
import logging
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from . import db

if TYPE_CHECKING:
    from .render.types import StatsData

# Kinds that track bytes but not (reliable) token counts.
BYTES_MODE_ONLY_KINDS: frozenset[str] = frozenset({"webfetch_image", "gdrive_image"})

_LOG = logging.getLogger("token_goat.stats")

# Cache directory → inferred git root so we don't re-walk on every event.
_git_root_cache: dict[str, str | None] = {}


def _norm_path(p: str) -> str:
    """Normalize to forward slashes with lowercase drive letter."""
    n = p.replace("\\", "/")
    if len(n) >= 2 and n[1] == ":":
        n = n[0].lower() + n[1:]
    return n


def _extract_file_path(kind: str, detail: str | None) -> str | None:
    """Pull the source filesystem path out of a stats detail field.

    image_shrink stores "src -> dest"; everything else is the path directly.
    """
    if not detail:
        return None
    if " -> " in detail and (kind in BYTES_MODE_ONLY_KINDS or kind == "image_shrink"):
        return detail.split(" -> ", 1)[0].strip()
    return detail


def _find_git_root(file_path: str) -> str | None:
    """Walk upward from *file_path* to find the nearest .git directory.

    The result is cached by parent directory so repeated calls for files in
    the same directory cost only a dict lookup.  Returns the normalized path
    of the git root, or ``None`` if no .git ancestor was found within 20 hops.
    """
    parent_dir = str(Path(file_path).parent)
    if parent_dir in _git_root_cache:
        return _git_root_cache[parent_dir]

    p = Path(file_path).parent
    for _ in range(20):
        if (p / ".git").exists():
            _git_root_cache[parent_dir] = _norm_path(str(p))
            return _git_root_cache[parent_dir]
        up = p.parent
        if up == p:
            break
        p = up

    _git_root_cache[parent_dir] = None
    return None


def _infer_project_root(file_path: str, registered_roots: list[str]) -> str | None:
    """Return the project root for *file_path*.

    Walks up the directory tree for a .git ancestor first — that is always
    the most specific boundary and handles repos cloned inside a registered
    parent directory. Falls back to longest-prefix match against registered
    roots for the rare case of non-git projects.
    """
    git_root = _find_git_root(file_path)
    if git_root is not None:
        return git_root

    norm = _norm_path(file_path)
    for root in sorted(registered_roots, key=len, reverse=True):
        root_norm = _norm_path(root).rstrip("/")
        if norm.startswith(root_norm + "/") or norm == root_norm:
            return root

    return None


def _infer_project_root_fast(
    file_path: str,
    sorted_norm_roots: list[tuple[str, str]],
) -> str | None:
    """Fast variant of _infer_project_root for hot loops.

    Accepts *sorted_norm_roots* as a pre-sorted, pre-normalized list of
    ``(original_root, normalized_root)`` pairs (longest first).  Avoids
    re-sorting and re-normalizing registered roots on every call — the caller
    builds this list once before iterating over rows.

    .git walk result is still cached in ``_git_root_cache`` as usual.
    """
    git_root = _find_git_root(file_path)
    if git_root is not None:
        return git_root

    norm = _norm_path(file_path)
    for orig_root, root_norm in sorted_norm_roots:
        if norm.startswith(root_norm + "/") or norm == root_norm:
            return orig_root

    return None


def _root_hash(root: str) -> str:
    """Stable key for a project root that isn't in the projects table."""
    return hashlib.sha1(root.encode()).hexdigest()


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
    """Fetch stats rows from the given connection.

    When *since_ts* is provided only rows at or after that timestamp are
    returned; passing ``None`` returns the full table.
    """
    base = "SELECT ts, kind, tokens_saved, bytes_saved, detail FROM stats"
    if since_ts is not None:
        return conn.execute(f"{base} WHERE ts >= ? ORDER BY ts", (int(since_ts),)).fetchall()
    return conn.execute(f"{base} ORDER BY ts").fetchall()


def summarize(window_days: int = 30) -> StatsSummary:
    """Aggregate stats from global.db + all known per-project DBs over the last N days."""
    t0 = time.time()
    since_ts = (
        (datetime.now() - timedelta(days=window_days)).timestamp()
        if window_days > 0
        else None
    )
    _LOG.debug("summarize started: window=%d days, since_ts=%s", window_days, since_ts)

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
    projects: list[tuple[str, str]] = []
    global_rows: list[sqlite3.Row] = []
    try:
        with db.open_global_readonly() as conn:
            global_rows = list(_read_stats(conn, since_ts))
            for row in global_rows:
                _accumulate(row, by_kind, by_day)
                total_events += 1
                total_bytes += row["bytes_saved"] or 0
                total_tokens += row["tokens_saved"] or 0
            _LOG.debug("global.db: aggregated %d rows", len(global_rows))

            # Pull project list for per-project rollup
            project_rows = conn.execute(
                "SELECT hash, root FROM projects"
            ).fetchall()
            projects = [(r["hash"], r["root"]) for r in project_rows]
            _LOG.debug("found %d projects to aggregate", len(projects))
    except Exception as _exc:  # noqa: BLE001
        _LOG.error("global stats read failed: %s", _exc)

    # Per-project DBs
    projects_aggregated = 0
    for project_hash, project_root in projects:
        try:
            with db.open_project_readonly(project_hash) as conn:
                rows = list(_read_stats(conn, since_ts))
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
                projects_aggregated += 1
                _LOG.debug("project %s: aggregated %d rows", project_hash[:8], len(rows))
        except Exception as _exc:  # noqa: BLE001
            _LOG.error("project stats read failed %s: %s", project_hash[:8], _exc)

    # Attribute global.db events (session hints, image shrink, etc.) to projects
    # by matching each event's file path against registered roots, then falling
    # back to a .git walk for projects opened from a parent directory.
    root_to_hash = {root: h for h, root in projects}
    # Normalized lookup so .git-walk results (always normalized) match DB roots
    # that may use original Windows casing (e.g. "C:/Projects" vs "c:/Projects").
    norm_root_to_hash = {_norm_path(root).rstrip("/"): h for root, h in root_to_hash.items()}
    # Pre-sort and pre-normalize once; avoids O(R·log R + R) work per row in the hot loop.
    sorted_norm_roots: list[tuple[str, str]] = sorted(
        ((root, _norm_path(root).rstrip("/")) for root in root_to_hash),
        key=lambda t: len(t[1]),
        reverse=True,
    )
    for row in global_rows:
        file_path = _extract_file_path(row["kind"], row["detail"])
        if not file_path:
            continue
        root = _infer_project_root_fast(file_path, sorted_norm_roots)
        if root is None:
            continue
        # norm_root is already in norm_root_to_hash; avoid recomputing _norm_path here.
        proj_key = (
            root_to_hash.get(root)
            or norm_root_to_hash.get(_norm_path(root).rstrip("/"))
            or _root_hash(root)
        )
        p = by_project[proj_key]
        p["events"] += 1
        p["bytes_saved"] += row["bytes_saved"] or 0
        p["tokens_saved"] += row["tokens_saved"] or 0
        p["project_root"] = root

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

    elapsed = time.time() - t0
    _LOG.info("summarize completed: events=%d bytes=%.0f tokens=%d projects_read=%d elapsed=%.3fs",
              total_events, total_bytes, total_tokens, projects_aggregated, elapsed)

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

    try:
        date_str = datetime.fromtimestamp(row["ts"]).strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        # Malformed or out-of-range timestamp — skip day bucketing for this row.
        _LOG.debug("skipping day accumulation: invalid ts=%r", row["ts"])
        return
    d = by_day[date_str]
    d["events"] += 1
    d["bytes_saved"] += bytes_saved
    d["tokens_saved"] += tokens_saved


def _fmt_bytes(n: int) -> str:
    """Format byte count as human-readable (B/KB/MB/GB/TB/PB)."""
    value: float = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024:
            return f"{int(value)}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value = value / 1024
    return f"{value:.1f}PB"


def _fmt_tokens(n: int) -> str:
    """Format token count as human-readable (t/kt/Mt/Gt/Tt)."""
    if n < 1000:
        return f"{n}t"
    if n < 1_000_000:
        return f"{n/1000:.1f}kt"
    if n < 1_000_000_000:
        return f"{n/1_000_000:.2f}Mt"
    if n < 1_000_000_000_000:
        return f"{n/1_000_000_000:.2f}Gt"
    return f"{n/1_000_000_000_000:.2f}Tt"


def _short_project(root: str) -> str:
    """Last path component of a project root, for compact display."""
    if not root:
        return "(unknown)"
    cleaned = root.rstrip("/\\")
    sep = "\\" if "\\" in cleaned else "/"
    tail = cleaned.split(sep)[-1] if sep in cleaned else cleaned
    return tail[:28]


def _to_stats_data(summary: StatsSummary) -> StatsData:
    """Convert StatsSummary to the render layer's StatsData."""
    from .render.types import DayStat, KindStat, ProjectStat, StatsData, TotalStats

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
        key=lambda d: d.bytes,
        reverse=True,
    )[:7]

    by_project = [
        ProjectStat(
            project=_short_project(p["project_root"]),
            hash=p["project_hash"][:8],
            path=p["project_root"] or "(unknown)",
            bytes=p["bytes_saved"],
            tokens=p["tokens_saved"],
            events=p["events"],
        )
        for p in summary.by_project
    ][:5]

    return StatsData(
        period_start=period_start,
        period_end=today,
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
    except Exception:  # noqa: BLE001
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
                ("token-goat stats", "bold white"),
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

        img = summary.by_kind.get("image_shrink")
        if img and img["events"] > 0:
            console.print(
                Text(
                    "  note: image token estimates use Claude's vision pricing formula "
                    "(pixel dimensions ÷ 750, capped at 1568 px/side).",
                    style="dim italic",
                )
            )

        hint_gross = summary.by_kind.get("session_hint")
        hint_overhead = summary.by_kind.get("session_hint_overhead")
        if hint_gross and hint_overhead:
            console.print(
                Text(
                    "  note: session_hint shows realized savings; session_hint_overhead "
                    "shows injected hint cost; headline totals are net.",
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
                "(no recorded savings yet. token-goat will accumulate stats as it "
                "intercepts reads, image fetches, etc.)",
                style="dim italic",
            )
        )

    return buf.getvalue()
