"""Token-savings telemetry aggregator."""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

from . import db

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
                "project_hash": k[:8],
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
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}{unit}"
        n = n / 1024
    return f"{n:.1f}TB"


def _fmt_tokens(n: int) -> str:
    """Format token count as human-readable (t/kt/Mt)."""
    if n < 1000:
        return f"{n}t"
    if n < 1_000_000:
        return f"{n/1000:.1f}kt"
    return f"{n/1_000_000:.2f}Mt"


def render_text(
    summary: StatsSummary, *, top_days: int = 7, top_projects: int = 5
) -> str:
    """Format stats as plain text for `tokenwise stats` command."""
    out = []
    window_desc = (
        "all time" if summary.window_days == 0 else f"last {summary.window_days} days"
    )
    out.append(f"tokenwise stats ({window_desc})")
    out.append("")
    out.append(
        f"Total: {summary.total_events:,} events, {_fmt_bytes(summary.total_bytes_saved)} saved (~{_fmt_tokens(summary.total_tokens_saved)} tokens)"
    )
    out.append("")

    if summary.by_kind:
        out.append("By kind:")
        for kind in sorted(
            summary.by_kind, key=lambda k: summary.by_kind[k]["bytes_saved"], reverse=True
        ):
            v = summary.by_kind[kind]
            out.append(
                f"  {kind:24} events={v['events']:5d}  bytes={_fmt_bytes(v['bytes_saved']):>9}  tokens={_fmt_tokens(v['tokens_saved']):>9}"
            )
        out.append("")

    if summary.by_day:
        out.append(f"By day (top {top_days}):")
        for d in summary.by_day[:top_days]:
            out.append(
                f"  {d['date']}  events={d['events']:5d}  bytes={_fmt_bytes(d['bytes_saved']):>9}  tokens={_fmt_tokens(d['tokens_saved']):>9}"
            )
        out.append("")

    if summary.by_project:
        out.append(f"By project (top {top_projects}):")
        for p in summary.by_project[:top_projects]:
            root = p["project_root"] or "(unknown)"
            out.append(f"  {p['project_hash']}  {root}")
            out.append(
                f"    events={p['events']:5d}  bytes={_fmt_bytes(p['bytes_saved']):>9}  tokens={_fmt_tokens(p['tokens_saved']):>9}"
            )

    if summary.total_events == 0:
        out.append(
            "(no recorded savings yet — tokenwise will accumulate stats as it intercepts reads, image fetches, etc.)"
        )

    return "\n".join(out)
