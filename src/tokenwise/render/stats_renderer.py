"""Stats renderer — Python port of stats-renderer.ts.

Entry point: render_stats(stats: StatsData) -> str
The returned string is ready for print() and contains ANSI truecolor codes.
Respects NO_COLOR env var — plain text when set or stdout is not a TTY.
"""
from __future__ import annotations

import math
import shutil
from datetime import date, timedelta

from .ansi import RESET, RGB, C, lerp_rgb, pad_l, pad_r, use_color, vlen
from .ansi import bg as _bg
from .ansi import fg as _fg
from .types import DayStat, StatsData

# ── Layout constants ──────────────────────────────────────────────────────────

M = "  "  # left margin

COL_NAME   = 18
COL_DATA   = 10
COL_TOKENS = 12
COL_EVENTS =  6
COL_SHARE  =  6
# gaps: 1 (name→bar) + 2 (bar→data) + 2 (data→tokens) + 2 (tokens→events) + 2 (events→share)
_COLS_FIXED = COL_NAME + 1 + 2 + COL_DATA + 2 + COL_TOKENS + 2 + COL_EVENTS + 2 + COL_SHARE


def _term_w() -> int:
    return shutil.get_terminal_size((100, 24)).columns


def _content_w() -> int:
    return min(max(_term_w(), 80), 140)


def _bar_w() -> int:
    return max(16, _content_w() - len(M) * 2 - _COLS_FIXED)


def _rule() -> str:
    return M + _fg(*C.text_dim) + "─" * (_content_w() - len(M) * 2) + RESET


# ── Formatters ────────────────────────────────────────────────────────────────

def _fmt_bytes(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1_000:
        return f"{n / 1_000:.1f} KB"
    return f"{n} B"


def _fmt_tokens(n: int) -> str:
    if n == 0:
        return f"{_fg(*C.text_dim)}0 t{RESET}"
    if n >= 1_000:
        return f"{n / 1_000:.1f} kt"
    return f"{n} t"


def _fmt_pct(fraction: float) -> str:
    return f"{fraction * 100:.1f}%"


def _fmt_delta(delta: float | None) -> str:
    if delta is None:
        return ""
    up = delta >= 0
    color = C.green5 if up else C.red
    arrow = "↑" if up else "↓"
    return f" {_fg(*color)}{arrow} {abs(round(delta))}%{RESET}"


def _fmt_date(d: date) -> str:
    return d.isoformat()


# ── Bar renderer ──────────────────────────────────────────────────────────────

_EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"]
_BLOCK = "█"
_GRADIENT: list[RGB] = [C.green1, C.green2, C.green3, C.green4, C.green5]


def _distribute(total: int, n: int) -> list[int]:
    if total <= 0 or n <= 0:
        return [0] * max(0, n)
    base = total // n
    rem = total % n
    return [base + (1 if i >= n - rem else 0) for i in range(n)]


def _render_bar(fraction: float, width: int | None = None) -> str:
    if width is None:
        width = _bar_w()
    f = max(0.0, min(1.0, fraction))
    raw = f * width
    n_full = math.floor(raw)
    eighths = round((raw - n_full) * 8)

    if eighths >= 8:
        n_full += 1
        eighths = 0
    has_partial = 0 < eighths < 8
    n_track = max(0, width - n_full - (1 if has_partial else 0))

    counts = _distribute(n_full, len(_GRADIENT))
    bar = "".join(
        _fg(*_GRADIENT[i]) + _BLOCK * n if n > 0 else ""
        for i, n in enumerate(counts)
    )
    if has_partial:
        bar += _fg(*_GRADIENT[-1]) + _EIGHTHS[eighths - 1]
    if n_track > 0:
        bar += _fg(*C.track) + _BLOCK * n_track

    return bar + RESET


# ── Sparkline renderer ────────────────────────────────────────────────────────

_SPARK = "▁▂▃▄▅▆▇█"


def _resample(vals: list[int], length: int) -> list[float]:
    if not vals:
        return [0.0] * length
    if len(vals) == length:
        return [float(v) for v in vals]
    result: list[float] = []
    for i in range(length):
        src = (i / (length - 1 or 1)) * (len(vals) - 1)
        lo = math.floor(src)
        hi = min(len(vals) - 1, lo + 1)
        t = src - lo
        result.append(vals[lo] * (1 - t) + vals[hi] * t)
    return result


def _render_sparkline(values: list[int], width: int = 8) -> str:
    pts = _resample(values, width)
    max_v = max(max(pts), 1)
    min_v = min(pts)
    range_v = max_v - min_v or 1
    chars: list[str] = []
    for i, v in enumerate(pts):
        idx = min(7, math.floor(((v - min_v) / range_v) * 8))
        color = lerp_rgb(C.green1, C.green5, i / (width - 1 or 1))
        chars.append(_fg(*color) + _SPARK[idx])
    return "".join(chars) + RESET


# ── Section header ────────────────────────────────────────────────────────────

def _section_header(title: str, subtitle: str = "") -> list[str]:
    sub = f"  {_fg(*C.text_muted)}{subtitle}{RESET}" if subtitle else ""
    return [
        "",
        f"{M}{_fg(*C.text_bright)}{title}{RESET}{sub}",
        _rule(),
    ]


# ── Table header / row ────────────────────────────────────────────────────────

def _table_header(first_col_label: str) -> str:
    bw = _bar_w()
    return "".join([
        M,
        pad_r(f"{_fg(*C.text_dim)}{first_col_label}{RESET}", COL_NAME),
        " ",
        pad_r(f"{_fg(*C.text_dim)}savings{RESET}", bw),
        "  ",
        pad_l(f"{_fg(*C.text_dim)}data saved{RESET}", COL_DATA),
        "  ",
        pad_l(f"{_fg(*C.text_dim)}tokens saved{RESET}", COL_TOKENS),
        "  ",
        pad_l(f"{_fg(*C.text_dim)}events{RESET}", COL_EVENTS),
        "  ",
        pad_l(f"{_fg(*C.text_dim)}share{RESET}", COL_SHARE),
    ])


def _table_row(
    name: str,
    fraction: float,
    bytes_n: int,
    tokens: int,
    events: int,
    share: float,
    bytes_mode_only: bool = False,
    name_prefix: str = "",
    name_color: RGB | None = None,
) -> str:
    if name_color is None:
        name_color = C.text_primary
    max_name = COL_NAME - vlen(name_prefix)
    truncated = name[:max_name - 1] + "…" if len(name) > max_name else name
    name_str = pad_r(name_prefix + _fg(*name_color) + truncated + RESET, COL_NAME)

    data_str = pad_l(f"{_fg(*C.text_primary)}{_fmt_bytes(bytes_n)}{RESET}", COL_DATA)
    tok_str = (
        pad_l(f"{_fg(*C.text_dim)}—{RESET}", COL_TOKENS) if bytes_mode_only
        else pad_l(f"{_fg(*C.blue)}{_fmt_tokens(tokens)}{RESET}", COL_TOKENS)
    )
    ev_str = pad_l(f"{_fg(*C.text_primary)}{events}{RESET}", COL_EVENTS)

    share_pct = share * 100
    share_color: RGB = (
        C.green5 if share_pct >= 50 else C.text_primary if share_pct >= 10 else C.text_muted
    )
    share_str = pad_l(f"{_fg(*share_color)}{_fmt_pct(share)}{RESET}", COL_SHARE)

    return "".join([
        M, name_str, " ", _render_bar(fraction), "  ",
        data_str, "  ", tok_str, "  ", ev_str, "  ", share_str,
    ])


# ── Section: KPI tiles ────────────────────────────────────────────────────────

def _render_kpi_section(stats: StatsData) -> list[str]:
    totals = stats.totals
    col_w = (_content_w() - len(M) * 2) // 3

    def card(label: str, value: str, delta: str, spark: str | None) -> tuple[str, str, str]:
        return (
            pad_r(f"{_fg(*C.text_muted)}{label}{RESET}", col_w),
            pad_r(f"{_fg(*C.text_bright)}{value}{RESET}{delta}", col_w),
            pad_r(spark, col_w) if spark is not None else pad_r("", col_w),
        )

    sp = totals.sparklines
    c1 = card("events", str(totals.events), _fmt_delta(totals.events_delta),
              _render_sparkline(sp["events"]) if sp else None)
    c2 = card("data saved", _fmt_bytes(totals.bytes), _fmt_delta(totals.bytes_delta),
              _render_sparkline(sp["bytes"]) if sp else None)
    c3 = card("tokens saved", _fmt_tokens(totals.tokens), _fmt_delta(totals.tokens_delta),
              _render_sparkline(sp["tokens"]) if sp else None)

    lines: list[str] = [
        "",
        M + c1[0] + c2[0] + c3[0],
        M + c1[1] + c2[1] + c3[1],
    ]
    if sp:
        lines.append(M + c1[2] + c2[2] + c3[2])
    return lines


# ── Section: by kind ─────────────────────────────────────────────────────────

def _render_by_kind_section(stats: StatsData) -> list[str]:
    if not stats.by_kind:
        return []
    totals = stats.totals
    lines: list[str] = [*_section_header("By kind"), _table_header("name")]

    for k in stats.by_kind:
        share = k.bytes / totals.bytes if totals.bytes > 0 else 0
        lines.append(_table_row(
            k.kind, share, k.bytes, k.tokens, k.events, share,
            bytes_mode_only=k.bytes_mode_only,
        ))

    bm_kinds = [k.kind for k in stats.by_kind if k.bytes_mode_only]
    if bm_kinds:
        names = ", ".join(bm_kinds)
        lines.append(
            f"{M}{_fg(*C.text_dim)}i  {names} tracks bytes, not vision tokens "
            f"(model-specific math){RESET}"
        )
    return lines


# ── Section: activity heatmap ─────────────────────────────────────────────────

_PROJECT_COLORS: list[RGB] = [C.purple, C.teal, C.blue, C.green4, C.text_muted]


def _hash_color(hash_str: str) -> RGB:
    n = sum(ord(c) for c in hash_str)
    return _PROJECT_COLORS[n % len(_PROJECT_COLORS)]


def _heat_cell_color(intensity: float) -> RGB:
    if intensity <= 0:
        return C.bg_tile
    stops: list[RGB] = [C.green1, C.green2, C.green3, C.green4, C.green5]
    idx = intensity * (len(stops) - 1)
    lo = math.floor(idx)
    hi = min(len(stops) - 1, lo + 1)
    return lerp_rgb(stops[lo], stops[hi], idx - lo)


_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _render_activity_section(stats: StatsData) -> list[str]:
    if not stats.by_day:
        return []

    sorted_days = sorted(stats.by_day, key=lambda d: d.date)
    by_date: dict[str, DayStat] = {d.date: d for d in sorted_days}
    max_events = max((d.events for d in sorted_days), default=1) or 1

    # Grid anchored to the Monday before period.start
    first = stats.period.start
    dow0 = first.weekday()  # Monday=0, Sunday=6
    grid_start = first - timedelta(days=dow0)

    last = stats.period.end
    dow_last = last.weekday()
    days_spanned = (last - grid_start).days + 1 + (6 - dow_last)
    raw_weeks = math.ceil(days_spanned / 7)

    avail = _content_w() - len(M) - 4  # subtract margin + "Mon " label
    max_weeks = max(1, avail // 3)
    n_weeks = min(raw_weeks, max_weeks)
    week_offset = raw_weeks - n_weeks

    # grid[dow][week]
    grid: list[list[DayStat | None]] = [
        [
            by_date.get((grid_start + timedelta(days=(w + week_offset) * 7 + dow)).isoformat())
            for w in range(n_weeks)
        ]
        for dow in range(7)
    ]

    total_period_days = (stats.period.end - stats.period.start).days + 1
    active_days = [d for d in sorted_days if d.events > 0]
    top_days = sorted(active_days, key=lambda d: d.events, reverse=True)[:3]

    panel: list[str] = []
    if top_days:
        panel.append(f"{_fg(*C.text_bright)}Top days{RESET}")
        for d in top_days:
            c: RGB = C.green5 if d.events / max_events > 0.5 else C.green4
            panel.append(
                f"{_fg(*C.text_muted)}{d.date[5:]}  {_fg(*c)}●{RESET}  "
                f"{_fg(*C.text_muted)}{d.events} ev · {_fmt_bytes(d.bytes)}{RESET}"
            )
        panel.append("")
        panel.append(f"{_fg(*C.text_bright)}Rhythm{RESET}")

        total_ev = sum(d.events for d in active_days)
        weekday_ev = sum(
            d.events for d in active_days
            if date.fromisoformat(d.date).weekday() < 5
        )
        mean = total_ev / (len(active_days) or 1)
        variance = sum((d.events - mean) ** 2 for d in active_days) / (len(active_days) or 1)
        cv = math.sqrt(variance) / (mean or 1)

        rhythm = "Burst pattern" if cv > 1.0 else "Moderate bursts" if cv > 0.5 else "Steady usage"
        if total_ev == 0:
            weekday_bias = "No data"
        elif weekday_ev / total_ev > 0.8:
            weekday_bias = "Weekday-heavy"
        elif weekday_ev / total_ev > 0.5:
            weekday_bias = "Mostly weekdays"
        else:
            weekday_bias = "Spread across week"

        n_active = len(active_days)
        panel += [
            f"{_fg(*C.text_muted)}{rhythm}{RESET}",
            f"{_fg(*C.text_muted)}{weekday_bias}{RESET}",
            f"{_fg(*C.text_muted)}{n_active} active day{'s' if n_active != 1 else ''} of {total_period_days}{RESET}",
        ]

    # visible width of the grid portion: M + "Mon " + n_weeks×2 + (n_weeks-1) spaces
    grid_vis_w = len(M) + 4 + n_weeks * 2 + (n_weeks - 1)

    n_active_d = len(active_days)
    subtitle = (
        f"·  {_fmt_date(stats.period.start)} → {_fmt_date(stats.period.end)}"
        f"  ·  {stats.totals.events} events across"
        f" {n_active_d} active day{'s' if n_active_d != 1 else ''}"
    )
    lines: list[str] = [*_section_header("Activity", subtitle)]

    for dow in range(7):
        label = pad_r(f"{_fg(*C.text_dim)}{_DAY_LABELS[dow]}{RESET}", 3)
        cells = " ".join(
            _bg(*_heat_cell_color(cell.events / max_events if cell else 0)) + "  " + RESET
            for cell in grid[dow]
        )
        left_part = f"{M}{label} {cells}"
        panel_part = f"  {panel[dow]}" if dow < len(panel) else ""
        lines.append(pad_r(left_part, grid_vis_w) + panel_part)

    for i in range(7, len(panel)):
        lines.append(" " * grid_vis_w + f"  {panel[i]}")

    legend = " ".join(
        _bg(*_heat_cell_color(t)) + "  " + RESET
        for t in [0.0, 0.25, 0.5, 0.75, 1.0]
    )
    lines += [
        "",
        f"{M}    {_fg(*C.text_dim)}Less{RESET}  {legend}  {_fg(*C.text_dim)}More{RESET}",
    ]
    return lines


# ── Section: by day ───────────────────────────────────────────────────────────

def _render_by_day_section(stats: StatsData, top_n: int = 7) -> list[str]:
    if not stats.by_day:
        return []
    totals = stats.totals
    days = sorted(stats.by_day, key=lambda d: d.bytes, reverse=True)[:top_n]
    lines: list[str] = [*_section_header(f"By day (top {top_n})"), _table_header("date")]
    for d in days:
        share = d.bytes / totals.bytes if totals.bytes > 0 else 0
        lines.append(_table_row(d.date, share, d.bytes, d.tokens, d.events, share))
    return lines


# ── Section: by project ───────────────────────────────────────────────────────

def _render_by_project_section(stats: StatsData, top_n: int = 5) -> list[str]:
    if not stats.by_project:
        return []
    projs = stats.by_project[:top_n]
    proj_total = sum(p.bytes for p in projs)
    lines: list[str] = [*_section_header(f"By project (top {top_n})"), _table_header("project")]
    for p in projs:
        share = p.bytes / proj_total if proj_total > 0 else 0
        color = _hash_color(p.hash)
        bullet = f"{_fg(*color)}●{RESET} "
        lines.append(_table_row(
            p.project, share, p.bytes, p.tokens, p.events, share,
            name_prefix=bullet,
        ))
        lines.append(f"{M}  {_fg(*C.text_dim)}└─ {p.hash[:8]}  {p.path}{RESET}")
    return lines


# ── Section: insights ─────────────────────────────────────────────────────────

def _render_insights_section(stats: StatsData) -> list[str]:
    lines: list[str] = [*_section_header("Insights")]
    bullet = f"{_fg(*C.green3)}▸{RESET}"
    totals = stats.totals

    def dim(s: str) -> str:
        return f"{_fg(*C.text_muted)}{s}{RESET}"

    by_kind_sorted = sorted(stats.by_kind, key=lambda k: k.bytes, reverse=True)
    if by_kind_sorted:
        top_kind = by_kind_sorted[0]
        share = top_kind.bytes / totals.bytes if totals.bytes > 0 else 0
        lines.append(
            f"{M}{bullet} {dim('Biggest saver  ')}"
            f"{_fg(*C.text_primary)}{top_kind.kind}{RESET}"
            f"{dim(' — ')}{_fg(*C.green5)}{_fmt_pct(share)}{RESET}"
            f"{dim(f' of saved data across {top_kind.events} events')}"
        )

    if stats.by_day:
        top_day = max(stats.by_day, key=lambda d: d.events)
        lines.append(
            f"{M}{bullet} {dim('Most active    ')}"
            f"{_fg(*C.text_primary)}{top_day.date}{RESET}"
            f"{dim(' — ')}{top_day.events} events, "
            f"{_fg(*C.green5)}{_fmt_bytes(top_day.bytes)}{RESET}{dim(' saved')}"
        )

    token_kinds = [k for k in stats.by_kind if not k.bytes_mode_only]
    if token_kinds:
        top_token = max(token_kinds, key=lambda k: k.tokens)
        lines.append(
            f"{M}{bullet} {dim('Token leader   ')}"
            f"{_fg(*C.text_primary)}{top_token.kind}{RESET}"
            f"{dim(' — ')}{_fg(*C.blue)}{_fmt_tokens(top_token.tokens)}{RESET}"
            f"{dim(f' saved in {top_token.events} events')}"
        )

    return lines


# ── Main export ───────────────────────────────────────────────────────────────

def render_stats(stats: StatsData) -> str:
    """Render a complete stats report to a string ready for print().

    Uses ANSI truecolor when stdout is a TTY and NO_COLOR is unset.
    Falls back to plain text otherwise.
    """
    import re

    sections: list[str] = [
        *_render_kpi_section(stats),
        *_render_by_kind_section(stats),
        *_render_activity_section(stats),
        *_render_by_day_section(stats),
        *_render_by_project_section(stats),
        *_render_insights_section(stats),
    ]

    if stats.totals.events == 0:
        sections += [
            "",
            f"{M}{_fg(*C.text_muted)}(no recorded savings yet — tokenwise will accumulate"
            f" stats as it intercepts reads, image fetches, etc.){RESET}",
        ]

    sections.append("")
    result = "\n".join(sections)
    if not use_color():
        result = re.sub(r"\x1b\[[0-9;]*m", "", result)
    return result
