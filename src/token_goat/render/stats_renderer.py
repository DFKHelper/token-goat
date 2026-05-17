"""Rich terminal renderer for token-goat stats.

Produces a multi-section ANSI display from a ``StatsData`` payload:

1. **KPI tiles** — three side-by-side cards (data saved, tokens saved, events)
   with period-over-period deltas and optional mini sparklines.
2. **By event kind** — colour-barred table showing savings per tool-call type
   (Read, image_shrink, Grep, etc.).
3. **Activity heatmap** — GitHub-style 12-week heatmap of daily token savings.
4. **By day** — tabular daily breakdown (top N rows by bytes).
5. **By project** — tabular per-project breakdown (top N rows by bytes).
6. **Insights** — motivational copy loaded from ``stats_messages.json``.

Entry point: :func:`render_stats` — returns a ready-to-print ANSI string.

Layout uses ``_CONTENT_W`` (clamped 80–140 columns) and a shared set of
column-width constants so all tables are visually aligned.  Colour values
come from ``ansi.C`` (GitHub dark palette).
"""
from __future__ import annotations

import heapq
import json
import logging
import math
import operator
import shutil
from datetime import date, timedelta
from pathlib import Path
from typing import TypedDict, cast

from .ansi import RESET, RGB, C, bg, fg, lerp_rgb, pad_l, pad_r, strip_ansi, vlen
from .types import DayStat, KindStat, StatsData

_LOG = logging.getLogger("token_goat.render.stats_renderer")

# Module-level key functions — avoids allocating a new lambda object on every
# sort/max call in the hot rendering path.
_key_day_date = operator.attrgetter("date")
_key_day_events = operator.attrgetter("events")
_key_kind_bytes = operator.attrgetter("bytes")
_key_kind_tokens = operator.attrgetter("tokens")


class _InsightsMessages(TypedDict):
    biggestSaver: str
    mostActive: str
    tokenLeader: str


class _StatsMessages(TypedDict):
    bytesModeOnlyNote: str
    sessionHintSplitNote: str
    insights: _InsightsMessages

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


_STATS_MESSAGES_FALLBACK: _StatsMessages = {
    "bytesModeOnlyNote": "tracks bytes, not vision tokens",
    "sessionHintSplitNote": "session_hint shows realized savings; session_hint_overhead shows injected hint cost",
    "insights": {
        "biggestSaver": "Biggest saver  ",
        "mostActive": "Most active    ",
        "tokenLeader": "Token leader   ",
    },
}


def _load_stats_messages() -> _StatsMessages:
    """Load the localised stats copy from the bundled ``stats_messages.json`` file.

    The JSON is co-located with this module (same directory) and contains
    display strings for the Insights section — taglines, motivational quotes,
    and milestone messages keyed by usage tier.

    Falls back to ``_STATS_MESSAGES_FALLBACK`` if the file is missing or
    malformed so a corrupted or absent bundle does not crash the entire module
    at import time and silently fall through to the legacy Rich renderer.
    """
    try:
        return cast(
            _StatsMessages,
            json.loads(Path(__file__).with_name("stats_messages.json").read_text(encoding="utf-8")),
        )
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        _LOG.warning("stats_messages.json unavailable (%s: %s); using built-in fallback", type(exc).__name__, exc)
        return _STATS_MESSAGES_FALLBACK


_STATS_MESSAGES = _load_stats_messages()

# ── Formatters ─────────────────────────────────────────────────────────────────

# Each entry: (threshold, divisor, unit_label, positive_color).
# Tiers are checked from largest to smallest; the last entry has threshold=0
# and is the base (sub-1000) case.
_BYTE_TIERS: list[tuple[int, int, str, RGB]] = [
    (1_000_000_000_000_000, 1_000_000_000_000_000, "PB", C.PURPLE),
    (1_000_000_000_000,     1_000_000_000_000,     "TB", C.BLUE),
    (1_000_000_000,         1_000_000_000,         "GB", C.TEAL),
    (1_000_000,             1_000_000,             "MB", C.GREEN4),
    (1_000,                 1_000,                 "KB", C.TEXT_MUTED),
    (0,                     1,                     "B",  C.TEXT_DIM),
]

_TOKEN_TIERS: list[tuple[int, int, str, RGB]] = [
    (1_000_000_000_000, 1_000_000_000_000, "Tt", C.GREEN5),
    (1_000_000_000,     1_000_000_000,     "Gt", C.TEAL),
    (1_000_000,         1_000_000,         "Mt", C.PURPLE),
    (1_000,             1_000,             "kt", C.BLUE),
    (0,                 1,                 "t",  C.TEXT_DIM),
]


def _fmt_magnitude(
    n: int,
    tiers: list[tuple[int, int, str, RGB]],
    *,
    zero_label: str | None = None,
) -> str:
    """Format an integer as a human-readable magnitude string with ANSI color.

    Both byte and token formatters share this structure: negative values are
    rendered dim with a minus-sign prefix; positive values use escalating colors
    per tier.  The caller supplies the tier table so the thresholds, divisors,
    unit labels, and positive colors can differ between bytes and tokens.

    Args:
        n:          The integer to format.
        tiers:      List of (threshold, divisor, unit, positive_color) tuples,
                    sorted largest-threshold-first.  The last entry must have
                    threshold=0 and acts as the base (sub-1000 or sub-1 k) case.
        zero_label: If provided, ``n == 0`` returns this string verbatim
                    (e.g. ``"0 t"`` for tokens).  Bytes have no special zero.
    """
    if zero_label is not None and n == 0:
        return f"{fg(*C.TEXT_DIM)}{zero_label}{RESET}"
    if n < 0:
        a = -n
        color = C.TEXT_DIM
        for threshold, divisor, unit, _ in tiers:
            if a >= threshold and threshold > 0:
                return f"{fg(*color)}-{a / divisor:,.1f} {unit}{RESET}"
        # base case (threshold == 0)
        _, _, unit, _ = tiers[-1]
        return f"{fg(*color)}-{a} {unit}{RESET}"
    for threshold, divisor, unit, pos_color in tiers:
        if n >= threshold and threshold > 0:
            return f"{fg(*pos_color)}{n / divisor:,.1f} {unit}{RESET}"
    # base case
    _, _, unit, pos_color = tiers[-1]
    return f"{fg(*pos_color)}{n} {unit}{RESET}"


def _fmt_bytes(n: int) -> str:
    """Format a byte count as a human-readable ANSI string (B/KB/MB/GB/…).

    Colour escalates with magnitude: dim (B) → muted (KB) → green (MB) → teal (GB) → blue (TB) → purple (PB).
    Negative values are rendered dim with a leading minus sign.
    """
    return _fmt_magnitude(n, _BYTE_TIERS)


def _fmt_tokens(n: int) -> str:
    """Format a token count as a human-readable ANSI string (t/kt/Mt/Gt/Tt).

    Zero renders as ``"0 t"`` (dim).  Colour escalates with magnitude:
    dim (t) → blue (kt) → purple (Mt) → teal (Gt) → bright-green (Tt).
    """
    return _fmt_magnitude(n, _TOKEN_TIERS, zero_label="0 t")


def _fmt_pct(fraction: float) -> str:
    """Format a 0–1 fraction as a percentage string, e.g. ``0.372`` → ``"37.2%"``."""
    return f"{fraction * 100:.1f}%"


def _fmt_delta(delta: float | None) -> str:
    """Format a period-over-period delta as a coloured ``↑ N%`` / ``↓ N%`` string.

    Returns an empty string when *delta* is ``None`` (data unavailable).
    Positive deltas are green with an up-arrow; negative are red with a down-arrow.
    """
    if delta is None:
        return ""
    up = delta >= 0
    color = C.GREEN5 if up else C.RED
    arrow = "↑" if up else "↓"
    return f" {fg(*color)}{arrow} {abs(round(delta))}%{RESET}"


def _fmt_date(d: date) -> str:
    """Format a ``date`` as an ISO-8601 string (``YYYY-MM-DD``)."""
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
    """Linearly resample *vals* to exactly *length* points.

    Used to stretch or compress sparkline data to a fixed display width.
    Returns ``[0.0] * length`` for an empty input.  When ``len(vals) == length``
    the input is returned as-is (no interpolation needed).
    """
    if not vals:
        return [0.0] * length
    n_vals = len(vals)
    if n_vals == length:
        return list(vals)
    result = []
    for i in range(length):
        src = (i / (length - 1 or 1)) * (n_vals - 1)
        lo = math.floor(src)
        hi = min(n_vals - 1, lo + 1)
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
    """Return a 3-line section header: blank line, title+subtitle, horizontal rule.

    *subtitle* is rendered in muted colour to the right of *title*.
    The rule spans the full content width (``_CONTENT_W``).
    """
    sub = f"  {fg(*C.TEXT_MUTED)}{subtitle}{RESET}" if subtitle else ""
    return [
        "",
        f"{_M}{fg(*C.TEXT_BRIGHT)}{title}{RESET}{sub}",
        _RULE,
    ]


# ── Table header / row helpers ─────────────────────────────────────────────────

def _table_header(first_col_label: str) -> str:
    """Return a single-line table header string with dim ANSI-coded column labels.

    Columns are: *first_col_label* (name), savings bar, data saved, tokens saved,
    share, events — in that order, padded to their respective column widths.
    """
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
    """Render a single data row for the by-kind or by-project tables.

    Args:
        name:           Row label; truncated with ``…`` if longer than ``_COL_NAME``.
        fraction:       Bar fill level 0–1 (relative to the maximum in the section).
        bytes_val:      Bytes saved, formatted by ``_fmt_bytes``.
        tokens:         Tokens saved, formatted by ``_fmt_tokens``.
        events:         Raw event count.
        share:          Fraction of total bytes for this row (used for share-column colour).
        bytes_mode_only: If ``True``, render the tokens column as ``"—"`` (e.g. image_shrink).
        name_prefix:    Optional prefix prepended before *name* (e.g. a bullet character).
        name_color:     RGB colour applied to the name text.
    """
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
    if share_pct < 0:
        share_color: RGB = C.RED
    elif share_pct >= 50:
        share_color = C.GREEN5
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
    """Render the three-column KPI tile box (events / data saved / tokens saved).

    Each tile shows the metric value, an optional period-over-period delta
    (``↑/↓ N%``), and an optional 8-char sparkline when ``totals.sparklines``
    is populated.  The tile frame uses box-drawing characters so it prints
    cleanly on any modern terminal.
    """
    totals = stats.totals
    col_w = (_CONTENT_W - len(_M) * 2) // 3
    inner_w = col_w * 3  # visible width of the three cards combined

    def card(label: str, value: str, delta: str, spark: str | None) -> tuple[str, str, str]:
        """Return three padded rows (label, value+delta, sparkline) for one metric card."""
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
        """Wrap *content* with left/right box-drawing border characters."""
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
    """Render the "By kind" table: one row per event kind, sorted desc by bytes.

    Bar fill is scaled to the largest positive-bytes kind.  Share percentage
    uses absolute-value totals so overhead kinds (negative bytes/tokens) reduce
    the denominator without inflating the dominant kind's share to >100%.
    Appends a footnote for ``bytes_mode_only`` kinds (e.g. image_shrink) and a
    second footnote when both ``session_hint`` and ``session_hint_overhead``
    appear in the same period (explaining the split).
    Returns ``[]`` when ``stats.by_kind`` is empty.
    """
    if not stats.by_kind:
        return []

    lines: list[str] = [*_section_header("By kind"), _table_header("name")]

    # Bar scaling uses positive-only gross so the widest positive bar fills to 100%.
    # Share % uses absolute-value totals so overhead kinds (negative bytes/tokens)
    # reduce the denominator and prevent the dominant positive kind from hitting 100%.
    # Single pass over by_kind to compute all three aggregates and collect metadata.
    _gross_bytes_sum = 0
    _share_bytes_sum = 0
    _share_tokens_sum = 0
    _kind_names: set[str] = set()
    bytes_mode_kinds: list[str] = []
    for _k in stats.by_kind:
        if _k.bytes > 0:
            _gross_bytes_sum += _k.bytes
        _share_bytes_sum += abs(_k.bytes)
        _share_tokens_sum += abs(_k.tokens)
        _kind_names.add(_k.kind)
        if _k.bytes_mode_only:
            bytes_mode_kinds.append(_k.kind)
    gross_bytes = max(_gross_bytes_sum, 1)
    share_bytes_denom = max(_share_bytes_sum, 1)
    share_tokens_denom = _share_tokens_sum

    for k in stats.by_kind:
        if k.bytes_mode_only or share_tokens_denom == 0:
            share = k.bytes / share_bytes_denom
        else:
            share = k.tokens / share_tokens_denom
        bar_fraction = k.bytes / gross_bytes if k.bytes > 0 else 0.0
        lines.append(_table_row(
            k.kind, bar_fraction, k.bytes, k.tokens, k.events, share,
            bytes_mode_only=k.bytes_mode_only,
        ))

    if bytes_mode_kinds:
        names = ", ".join(bytes_mode_kinds)
        msg = (
            f"{_M}{fg(*C.TEXT_DIM)}i  {names} "
            f"{_STATS_MESSAGES['bytesModeOnlyNote']}{RESET}"
        )
        lines.append(msg)

    if "session_hint" in _kind_names and "session_hint_overhead" in _kind_names:
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
    """Map a 0–1 activity intensity to an RGB background colour for heatmap cells.

    Zero (no activity) returns ``C.BG_TILE`` (dark background).
    Non-zero values are interpolated across a 5-stop green gradient
    (``GREEN1`` dim → ``GREEN5`` bright) proportional to *intensity*.
    """
    if intensity <= 0:
        return C.BG_TILE
    stops: list[RGB] = [C.GREEN1, C.GREEN2, C.GREEN3, C.GREEN4, C.GREEN5]
    idx = intensity * (len(stops) - 1)
    lo = math.floor(idx)
    hi = min(len(stops) - 1, lo + 1)
    return lerp_rgb(stops[lo], stops[hi], idx - lo)


def _render_activity_section(stats: StatsData) -> list[str]:
    """Render the GitHub-style weekly activity heatmap and rhythm summary panel.

    The heatmap is a 7-row (Mon–Sun) × N-week grid anchored to the Monday
    before ``stats.period_start``.  Weeks are capped by terminal width (each
    week takes 3 visible chars: 2-char coloured cell + 1 space).  Cell colour
    intensity is proportional to the day's event count relative to the period
    maximum.

    A right-side panel shows: top 3 days by events, and a "Rhythm" summary
    (burst/moderate/steady based on coefficient of variation, plus weekday bias).
    Returns ``[]`` when ``stats.by_day`` is empty.
    """
    if not stats.by_day:
        return []

    sorted_days = sorted(stats.by_day, key=_key_day_date)
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
    top_days = heapq.nlargest(3, active_days, key=_key_day_events)

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
        n_active = len(active_days)
        mean = total_ev / (n_active or 1)
        variance = sum((d.events - mean) ** 2 for d in active_days) / (n_active or 1)
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
        plural = "" if n_active == 1 else "s"
        day_msg = (
            f"{fg(*C.TEXT_MUTED)}{n_active} active day{plural} of "
            f"{total_period_days}{RESET}"
        )
        panel_lines.append(day_msg)

    # Visible width of grid rows: M + "Mon " + n_weeks × 2 cells + (n_weeks-1) spaces
    grid_vis_w = len(_M) + 4 + n_weeks * 2 + (n_weeks - 1)

    active_count = len(active_days)  # also cached as n_active inside the if-block above
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
    """Render the "By day (top 7)" table: one row per day, sorted desc by bytes by the caller.

    Share fraction uses tokens when the period total is non-zero, falling back
    to bytes when all token counts are zero (e.g. an image-only session).
    Returns ``[]`` when ``stats.by_day`` is empty.
    """
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
    """Render the "By project (top 5)" table: one row per project plus a path sub-row.

    Each project bullet is coloured via ``_hash_color`` for visual distinction.
    The sub-row shows the short project hash and absolute path in dim colour.
    Share fraction uses tokens when the cross-project total is non-zero, falling
    back to bytes otherwise.
    Returns ``[]`` when ``stats.by_project`` is empty.
    """
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
        lines.append(f"{_M}  {fg(*C.TEXT_DIM)}└─ {p.hash}  {strip_ansi(p.path)}{RESET}")

    return lines


# ── Section: insights ─────────────────────────────────────────────────────────

def _render_insights_section(stats: StatsData) -> list[str]:
    """Render the "Insights" section: three copy-driven observation bullets.

    Bullets cover: (1) biggest saver by bytes with its share percentage,
    (2) most active day by events, and (3) token leader excluding
    ``bytes_mode_only`` kinds.  Copy strings come from ``_STATS_MESSAGES``
    (loaded from ``stats_messages.json``).
    """
    lines: list[str] = [*_section_header("Insights")]
    bullet = f"{fg(*C.GREEN3)}▸{RESET}"

    def dim(s: str) -> str:
        """Wrap *s* in the muted-text ANSI colour for de-emphasised inline text."""
        return f"{fg(*C.TEXT_MUTED)}{s}{RESET}"

    # Biggest saver by bytes
    top_kind: KindStat | None = max(stats.by_kind, key=_key_kind_bytes, default=None)
    if top_kind:
        share = top_kind.bytes / stats.totals.bytes if stats.totals.bytes > 0 else 0.0
        lines.append(
            f"{_M}{bullet} {dim(_STATS_MESSAGES['insights']['biggestSaver'])}{fg(*C.TEXT_PRIMARY)}{top_kind.kind}{RESET}"
            f"{dim(' — ')}{fg(*C.GREEN5)}{_fmt_pct(share)}{RESET}"
            f"{dim(f' of saved data across {top_kind.events:,} events')}"
        )

    # Most active day
    top_day: DayStat | None = max(stats.by_day, key=_key_day_events, default=None)
    if top_day:
        lines.append(
            f"{_M}{bullet} {dim(_STATS_MESSAGES['insights']['mostActive'])}{fg(*C.TEXT_PRIMARY)}{top_day.date}{RESET}"
            f"{dim(' — ')}{top_day.events:,} events, {_fmt_bytes(top_day.bytes)}{dim(' saved')}"
        )

    # Token leader (excluding bytes_mode_only kinds)
    token_kinds = [k for k in stats.by_kind if not k.bytes_mode_only]
    top_token: KindStat | None = max(token_kinds, key=_key_kind_tokens, default=None)
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
