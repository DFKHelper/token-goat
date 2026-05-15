from __future__ import annotations

import json
import math
import shutil
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .ansi import RESET, RGB, C, bg, fg, lerp_rgb, pad_l, pad_r, vlen
from .types import DayStat, KindStat, StatsData

# ── Layout constants ───────────────────────────────────────────────────────────

_TERM_W = shutil.get_terminal_size(fallback=(100, 24)).columns
_CONTENT_W = min(max(_TERM_W, 80), 140)
_M = "  "  # left margin

# Table column visible widths (chars).
# "data saved" = 10, "tokens saved" = 12 — column widths match their headers.
_COL_NAME   = 18
_COL_DATA   = 10
_COL_TOKENS = 12
_COL_SHARE  =  6
_COL_EVENTS =  6
# Gaps: 1 (name→bar) + 2 (bar→data) + 2 (data→tokens) + 2 (tokens→share) + 2 (share→events)
_COLS_FIXED = _COL_NAME + 1 + 2 + _COL_DATA + 2 + _COL_TOKENS + 2 + _COL_SHARE + 2 + _COL_EVENTS
_BAR_W = max(16, _CONTENT_W - len(_M) * 2 - _COLS_FIXED)
_RULE = _M + fg(*C.TEXT_DIM) + "─" * (_CONTENT_W - len(_M) * 2) + RESET


def _load_stats_messages() -> dict[str, Any]:
    return json.loads(Path(__file__).with_name("stats_messages.json").read_text(encoding="utf-8"))


_STATS_MESSAGES = _load_stats_messages()

# ── Formatters ─────────────────────────────────────────────────────────────────

def _fmt_bytes(n: int) -> str:
    # Color escalates with magnitude: dim → green → teal → blue → purple
    if n >= 1_000_000_000_000_000:
        return f"{fg(*C.PURPLE)}{n / 1_000_000_000_000_000:,.1f} PB{RESET}"
    if n >= 1_000_000_000_000:
        return f"{fg(*C.BLUE)}{n / 1_000_000_000_000:,.1f} TB{RESET}"
    if n >= 1_000_000_000:
        return f"{fg(*C.TEAL)}{n / 1_000_000_000:,.1f} GB{RESET}"
    if n >= 1_000_000:
        return f"{fg(*C.GREEN4)}{n / 1_000_000:,.1f} MB{RESET}"
    if n >= 1_000:
        return f"{fg(*C.TEXT_MUTED)}{n / 1_000:,.1f} KB{RESET}"
    return f"{fg(*C.TEXT_DIM)}{n} B{RESET}"


def _fmt_tokens(n: int) -> str:
    # Color escalates with magnitude: dim → blue → purple → teal → green
    if n == 0:
        return f"{fg(*C.TEXT_DIM)}0 t{RESET}"
    if n >= 1_000_000_000_000:
        return f"{fg(*C.GREEN5)}{n / 1_000_000_000_000:,.1f} Tt{RESET}"
    if n >= 1_000_000_000:
        return f"{fg(*C.TEAL)}{n / 1_000_000_000:,.1f} Gt{RESET}"
    if n >= 1_000_000:
        return f"{fg(*C.PURPLE)}{n / 1_000_000:,.1f} Mt{RESET}"
    if n >= 1_000:
        return f"{fg(*C.BLUE)}{n / 1_000:,.1f} kt{RESET}"
    return f"{fg(*C.TEXT_DIM)}{n} t{RESET}"


def _fmt_pct(fraction: float) -> str:
    return f"{fraction * 100:.1f}%"


def _fmt_delta(delta: float | None) -> str:
    if delta is None:
        return ""
    up = delta >= 0
    color = C.GREEN5 if up else C.RED
    arrow = "↑" if up else "↓"
    return f" {fg(*color)}{arrow} {abs(round(delta))}%{RESET}"


def _fmt_date(d: date) -> str:
    return d.isoformat()


# ── Bar renderer ───────────────────────────────────────────────────────────────

_EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"]
_BLOCK = "█"
_GRADIENT: list[RGB] = [C.GREEN1, C.GREEN2, C.GREEN3, C.GREEN4, C.GREEN5]


def _distribute(total: int, n: int) -> list[int]:
    """Distribute `total` chars across `n` gradient stops, extras to later (brighter) stops."""
    if total <= 0 or n <= 0:
        return [0] * max(0, n)
    base = total // n
    rem = total % n
    return [base + (1 if i >= n - rem else 0) for i in range(n)]


def _render_bar(fraction: float, width: int = _BAR_W) -> str:
    """
    Render a uniform-width progress bar with a 5-stop green gradient fill and a dim track.
    Sub-block characters (▏▎▍▌▋▊▉) provide sub-character precision at the boundary.

    Args:
        fraction: Fill level 0–1.
        width:    Total character width; all bars must share the same value for alignment.
    """
    f = max(0.0, min(1.0, fraction))
    raw = f * width
    n_full = math.floor(raw)
    eighths = round((raw - n_full) * 8)

    # Normalize: round-up partial if it reached a full block
    if eighths >= 8:
        n_full += 1
    has_partial = 0 < eighths < 8
    n_track = max(0, width - n_full - (1 if has_partial else 0))

    counts = _distribute(n_full, len(_GRADIENT))
    bar = "".join(
        fg(*_GRADIENT[i]) + _BLOCK * count
        for i, count in enumerate(counts)
        if count > 0
    )

    if has_partial:
        bar += fg(*_GRADIENT[-1]) + _EIGHTHS[eighths - 1]
    if n_track > 0:
        bar += fg(*C.TRACK) + _BLOCK * n_track

    return bar + RESET


# ── Sparkline renderer ─────────────────────────────────────────────────────────

_SPARK = "▁▂▃▄▅▆▇█"


def _resample(vals: list[float], length: int) -> list[float]:
    if not vals:
        return [0.0] * length
    if len(vals) == length:
        return list(vals)
    result = []
    for i in range(length):
        src = (i / (length - 1 or 1)) * (len(vals) - 1)
        lo = math.floor(src)
        hi = min(len(vals) - 1, lo + 1)
        t = src - lo
        result.append(vals[lo] * (1 - t) + vals[hi] * t)
    return result


def _render_sparkline(values: list[float], width: int = 8) -> str:
    """Render an 8-char mini sparkline. Values are resampled and normalised to fill the range."""
    pts = _resample(values, width)
    hi = max(pts) if pts else 1.0
    lo = min(pts) if pts else 0.0
    span = hi - lo or 1.0
    chars = []
    for i, v in enumerate(pts):
        idx = min(7, math.floor(((v - lo) / span) * 8))
        color = lerp_rgb(C.GREEN1, C.GREEN5, i / (width - 1 or 1))
        chars.append(f"{fg(*color)}{_SPARK[idx]}")
    return "".join(chars) + RESET


# ── Section header helper ──────────────────────────────────────────────────────

def _section_header(title: str, subtitle: str = "") -> list[str]:
    sub = f"  {fg(*C.TEXT_MUTED)}{subtitle}{RESET}" if subtitle else ""
    return [
        "",
        f"{_M}{fg(*C.TEXT_BRIGHT)}{title}{RESET}{sub}",
        _RULE,
    ]


# ── Table header / row helpers ─────────────────────────────────────────────────

def _table_header(first_col_label: str) -> str:
    return "".join([
        _M,
        pad_r(f"{fg(*C.TEXT_DIM)}{first_col_label}{RESET}", _COL_NAME),
        " ",
        pad_r(f"{fg(*C.TEXT_DIM)}savings{RESET}", _BAR_W),
        "  ",
        pad_l(f"{fg(*C.TEXT_DIM)}data saved{RESET}", _COL_DATA),
        "  ",
        pad_l(f"{fg(*C.TEXT_DIM)}tokens saved{RESET}", _COL_TOKENS),
        "  ",
        pad_l(f"{fg(*C.TEXT_DIM)}share{RESET}", _COL_SHARE),
        "  ",
        pad_l(f"{fg(*C.TEXT_DIM)}events{RESET}", _COL_EVENTS),
    ])


def _table_row(
    name: str,
    fraction: float,
    bytes_val: int,
    tokens: int,
    events: int,
    share: float,
    bytes_mode_only: bool = False,
    name_prefix: str = "",
    name_color: RGB = C.TEXT_PRIMARY,
) -> str:
    prefix_w = vlen(name_prefix)
    max_name = _COL_NAME - prefix_w
    truncated = (name[: max_name - 1] + "…") if len(name) > max_name else name
    name_str = pad_r(f"{name_prefix}{fg(*name_color)}{truncated}{RESET}", _COL_NAME)

    data_str = pad_l(_fmt_bytes(bytes_val), _COL_DATA)

    if bytes_mode_only:
        tok_str = pad_l(f"{fg(*C.TEXT_DIM)}—{RESET}", _COL_TOKENS)
    else:
        tok_str = pad_l(_fmt_tokens(tokens), _COL_TOKENS)

    share_pct = share * 100
    if share_pct >= 50:
        share_color: RGB = C.GREEN5
    elif share_pct >= 10:
        share_color = C.TEXT_PRIMARY
    else:
        share_color = C.TEXT_MUTED
    share_str = pad_l(f"{fg(*share_color)}{_fmt_pct(share)}{RESET}", _COL_SHARE)

    ev_str = pad_l(f"{fg(*C.TEXT_PRIMARY)}{events:,}{RESET}", _COL_EVENTS)

    parts = [_M, name_str, " ", _render_bar(fraction), "  ", data_str, "  ",
             tok_str, "  ", share_str, "  ", ev_str]
    return "".join(parts)


# ── Section: KPI tiles ─────────────────────────────────────────────────────────

def _render_kpi_section(stats: StatsData) -> list[str]:
    totals = stats.totals
    col_w = (_CONTENT_W - len(_M) * 2) // 3
    inner_w = col_w * 3  # visible width of the three cards combined

    def card(label: str, value: str, delta: str, spark: str | None) -> tuple[str, str, str]:
        return (
            pad_r(f"{fg(*C.TEXT_MUTED)}{label}{RESET}", col_w),
            pad_r(f"{fg(*C.TEXT_BRIGHT)}{value}{RESET}{delta}", col_w),
            pad_r(spark, col_w) if spark is not None else pad_r("", col_w),
        )

    spark = totals.sparklines
    c1 = card("events",       f"{totals.events:,}",           _fmt_delta(totals.events_delta),
              _render_sparkline(spark.events) if spark else None)
    c2 = card("data saved",   _fmt_bytes(totals.bytes),      _fmt_delta(totals.bytes_delta),
              _render_sparkline(spark.bytes)  if spark else None)
    c3 = card("tokens saved", _fmt_tokens(totals.tokens),    _fmt_delta(totals.tokens_delta),
              _render_sparkline(spark.tokens) if spark else None)

    border = fg(*C.TEXT_DIM)
    frame_bar = "─" * (inner_w + 2)  # +2 for single-space padding on each side

    def framed(content: str) -> str:
        return f"{_M}{border}│{RESET} {content} {border}│{RESET}"

    lines = [
        "",
        f"{_M}{border}╭{frame_bar}╮{RESET}",
        framed(c1[0] + c2[0] + c3[0]),  # labels
        framed(c1[1] + c2[1] + c3[1]),  # values + deltas
    ]
    if spark:
        lines.append(framed(c1[2] + c2[2] + c3[2]))
    lines.append(f"{_M}{border}╰{frame_bar}╯{RESET}")
    return lines


# ── Section: by kind ──────────────────────────────────────────────────────────

def _render_by_kind_section(stats: StatsData) -> list[str]:
    if not stats.by_kind:
        return []

    lines: list[str] = [*_section_header("By kind"), _table_header("name")]

    for k in stats.by_kind:
        if k.bytes_mode_only or stats.totals.tokens == 0:
            share = k.bytes / stats.totals.bytes if stats.totals.bytes > 0 else 0.0
        else:
            share = k.tokens / stats.totals.tokens
        lines.append(_table_row(
            k.kind, share, k.bytes, k.tokens, k.events, share,
            bytes_mode_only=k.bytes_mode_only,
        ))

    bytes_mode_kinds = [k.kind for k in stats.by_kind if k.bytes_mode_only]
    if bytes_mode_kinds:
        names = ", ".join(bytes_mode_kinds)
        msg = (
            f"{_M}{fg(*C.TEXT_DIM)}i  {names} "
            f"{_STATS_MESSAGES['bytesModeOnlyNote']}{RESET}"
        )
        lines.append(msg)

    if any(k.kind == "session_hint" for k in stats.by_kind) and any(
        k.kind == "session_hint_overhead" for k in stats.by_kind
    ):
        lines.append(
            f"{_M}{fg(*C.TEXT_DIM)}i  {_STATS_MESSAGES['sessionHintSplitNote']}{RESET}"
        )

    return lines


# ── Section: activity heatmap ─────────────────────────────────────────────────

_PROJECT_COLORS: list[RGB] = [C.PURPLE, C.TEAL, C.BLUE, C.GREEN4, C.TEXT_MUTED]
_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _hash_color(hash_str: str) -> RGB:
    """Stable colour assignment based on hash string."""
    n = sum(ord(c) for c in hash_str)
    return _PROJECT_COLORS[n % len(_PROJECT_COLORS)]


def _heat_cell_color(intensity: float) -> RGB:
    if intensity <= 0:
        return C.BG_TILE
    stops: list[RGB] = [C.GREEN1, C.GREEN2, C.GREEN3, C.GREEN4, C.GREEN5]
    idx = intensity * (len(stops) - 1)
    lo = math.floor(idx)
    hi = min(len(stops) - 1, lo + 1)
    return lerp_rgb(stops[lo], stops[hi], idx - lo)


def _render_activity_section(stats: StatsData) -> list[str]:
    if not stats.by_day:
        return []

    sorted_days = sorted(stats.by_day, key=lambda d: d.date)
    by_date: dict[str, DayStat] = {d.date: d for d in sorted_days}
    max_events = max((d.events for d in sorted_days), default=1) or 1

    # Build 7-row × N-week grid anchored to the Monday before period_start
    period_start = stats.period_start
    period_end = stats.period_end
    dow0 = period_start.weekday()  # Mon=0 (Python weekday already Mon-based)
    grid_start = period_start - timedelta(days=dow0)

    dow_last = period_end.weekday()
    days_spanned = (period_end - grid_start).days + 1 + (6 - dow_last)
    raw_weeks = math.ceil(days_spanned / 7)

    # Cap to what fits in the terminal (each week = 2-char cell + 1 space = 3 chars)
    avail_for_cells = _CONTENT_W - len(_M) - 4  # subtract margin + "Mon " label
    max_weeks = max(1, avail_for_cells // 3)
    n_weeks = min(raw_weeks, max_weeks)
    week_offset = raw_weeks - n_weeks

    # grid[dow][week] — week 0 is oldest displayed week
    grid: list[list[DayStat | None]] = [
        [
            by_date.get((grid_start + timedelta(days=(w + week_offset) * 7 + dow)).isoformat())
            for w in range(n_weeks)
        ]
        for dow in range(7)
    ]

    total_period_days = (period_end - period_start).days + 1
    active_days = [d for d in sorted_days if d.events > 0]
    top_days = sorted(active_days, key=lambda d: -d.events)[:3]

    # Build right panel lines
    panel_lines: list[str] = []
    if top_days:
        panel_lines.append(f"{fg(*C.TEXT_BRIGHT)}Top days{RESET}")
        for d in top_days:
            c: RGB = C.GREEN5 if d.events / max_events > 0.5 else C.GREEN4
            panel_lines.append(
                f"{fg(*C.TEXT_MUTED)}{d.date[5:]}  {fg(*c)}●{RESET}  "
                f"{fg(*C.TEXT_MUTED)}{d.events:,} ev · {RESET}{_fmt_bytes(d.bytes)}"
            )
        panel_lines.append("")
        panel_lines.append(f"{fg(*C.TEXT_BRIGHT)}Rhythm{RESET}")

        total_ev = sum(d.events for d in active_days)
        weekday_ev = sum(
            d.events for d in active_days
            if date.fromisoformat(d.date).weekday() < 5  # Mon–Fri
        )
        mean = total_ev / (len(active_days) or 1)
        variance = sum((d.events - mean) ** 2 for d in active_days) / (len(active_days) or 1)
        cv = math.sqrt(variance) / (mean or 1)

        rhythm = (
            "Burst pattern"   if cv > 1.0 else
            "Moderate bursts" if cv > 0.5 else
            "Steady usage"
        )
        if total_ev == 0:
            weekday_bias = "No data"
        elif weekday_ev / total_ev > 0.8:
            weekday_bias = "Weekday-heavy"
        elif weekday_ev / total_ev > 0.5:
            weekday_bias = "Mostly weekdays"
        else:
            weekday_bias = "Spread across week"

        panel_lines.append(f"{fg(*C.TEXT_MUTED)}{rhythm}{RESET}")
        panel_lines.append(f"{fg(*C.TEXT_MUTED)}{weekday_bias}{RESET}")
        plural = "" if len(active_days) == 1 else "s"
        day_msg = (
            f"{fg(*C.TEXT_MUTED)}{len(active_days)} active day{plural} of "
            f"{total_period_days}{RESET}"
        )
        panel_lines.append(day_msg)

    # Visible width of grid rows: M + "Mon " + n_weeks × 2 cells + (n_weeks-1) spaces
    grid_vis_w = len(_M) + 4 + n_weeks * 2 + (n_weeks - 1)

    active_count = len(active_days)
    plural = "" if active_count == 1 else "s"
    subtitle = (
        f"·  {_fmt_date(period_start)} → {_fmt_date(period_end)}"
        f"  ·  {stats.totals.events:,} events across {active_count} active day{plural}"
    )

    lines: list[str] = [*_section_header("Activity", subtitle)]

    for dow in range(7):
        label = pad_r(f"{fg(*C.TEXT_DIM)}{_DAY_LABELS[dow]}{RESET}", 3)
        cells = " ".join(
            f"{bg(*_heat_cell_color(cell.events / max_events if cell else 0))}  {RESET}"
            for cell in grid[dow]
        )
        left_part = f"{_M}{label} {cells}"
        panel_part = f"  {panel_lines[dow]}" if dow < len(panel_lines) else ""
        lines.append(pad_r(left_part, grid_vis_w) + panel_part)

    # Remaining panel lines below the 7 grid rows
    for i in range(7, len(panel_lines)):
        lines.append(" " * grid_vis_w + f"  {panel_lines[i]}")

    # Legend
    legend_cells = " ".join(
        f"{bg(*_heat_cell_color(t))}  {RESET}"
        for t in [0.0, 0.25, 0.5, 0.75, 1.0]
    )
    lines.append("")
    legend = (
        f"{_M}    {fg(*C.TEXT_DIM)}Less{RESET}  {legend_cells}  "
        f"{fg(*C.TEXT_DIM)}More{RESET}"
    )
    lines.append(legend)

    return lines


# ── Section: by day ───────────────────────────────────────────────────────────

def _render_by_day_section(stats: StatsData) -> list[str]:
    if not stats.by_day:
        return []

    lines: list[str] = [*_section_header("By day (top 7)"), _table_header("date")]

    for d in stats.by_day:
        if stats.totals.tokens > 0:
            share = d.tokens / stats.totals.tokens
        elif stats.totals.bytes > 0:
            share = d.bytes / stats.totals.bytes
        else:
            share = 0.0
        lines.append(_table_row(d.date, share, d.bytes, d.tokens, d.events, share))

    return lines


# ── Section: by project ───────────────────────────────────────────────────────

def _render_by_project_section(stats: StatsData) -> list[str]:
    if not stats.by_project:
        return []

    project_total_bytes = sum(p.bytes for p in stats.by_project)
    project_total_tokens = sum(p.tokens for p in stats.by_project)

    lines: list[str] = [*_section_header("By project (top 5)"), _table_header("project")]

    for p in stats.by_project:
        if project_total_tokens > 0:
            share = p.tokens / project_total_tokens
        elif project_total_bytes > 0:
            share = p.bytes / project_total_bytes
        else:
            share = 0.0
        color = _hash_color(p.hash)
        lines.append(_table_row(
            p.project, share, p.bytes, p.tokens, p.events, share,
            name_prefix=f"{fg(*color)}●{RESET} ",
            name_color=C.TEXT_PRIMARY,
        ))
        lines.append(f"{_M}  {fg(*C.TEXT_DIM)}└─ {p.hash}  {p.path}{RESET}")

    return lines


# ── Section: insights ─────────────────────────────────────────────────────────

def _render_insights_section(stats: StatsData) -> list[str]:
    lines: list[str] = [*_section_header("Insights")]
    bullet = f"{fg(*C.GREEN3)}▸{RESET}"

    def dim(s: str) -> str:
        return f"{fg(*C.TEXT_MUTED)}{s}{RESET}"

    # Biggest saver by bytes
    top_kind: KindStat | None = max(stats.by_kind, key=lambda k: k.bytes, default=None)
    if top_kind:
        share = top_kind.bytes / stats.totals.bytes if stats.totals.bytes > 0 else 0.0
        lines.append(
            f"{_M}{bullet} {dim(_STATS_MESSAGES['insights']['biggestSaver'])}{fg(*C.TEXT_PRIMARY)}{top_kind.kind}{RESET}"
            f"{dim(' — ')}{fg(*C.GREEN5)}{_fmt_pct(share)}{RESET}"
            f"{dim(f' of saved data across {top_kind.events:,} events')}"
        )

    # Most active day
    top_day: DayStat | None = max(stats.by_day, key=lambda d: d.events, default=None)
    if top_day:
        lines.append(
            f"{_M}{bullet} {dim(_STATS_MESSAGES['insights']['mostActive'])}{fg(*C.TEXT_PRIMARY)}{top_day.date}{RESET}"
            f"{dim(' — ')}{top_day.events:,} events, {_fmt_bytes(top_day.bytes)}{dim(' saved')}"
        )

    # Token leader (excluding bytes_mode_only kinds)
    token_kinds = [k for k in stats.by_kind if not k.bytes_mode_only]
    top_token: KindStat | None = max(token_kinds, key=lambda k: k.tokens, default=None)
    if top_token:
        lines.append(
            f"{_M}{bullet} {dim(_STATS_MESSAGES['insights']['tokenLeader'])}{fg(*C.TEXT_PRIMARY)}{top_token.kind}{RESET}"
            f"{dim(' — ')}{_fmt_tokens(top_token.tokens)}"
            f"{dim(f' saved in {top_token.events:,} events')}"
        )

    return lines


# ── Main export ────────────────────────────────────────────────────────────────

def render_stats(stats: StatsData) -> str:
    """
    Render a complete token-goat stats report to a string ready for print().

    Example::

        from render.stats_renderer import render_stats
        stats = build_stats_data(options)
        print(render_stats(stats))
    """
    sections = [
        _render_kpi_section(stats),
        _render_by_kind_section(stats),
        _render_activity_section(stats),
        _render_by_day_section(stats),
        _render_by_project_section(stats),
        _render_insights_section(stats),
        [""],
    ]
    return "\n".join(line for section in sections for line in section)
