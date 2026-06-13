"""Rich terminal renderer for token-goat stats.

Produces a multi-section ANSI display from a ``StatsData`` payload:

1. **KPI tiles** — three side-by-side cards (data saved, tokens saved, events)
   with period-over-period deltas and optional mini sparklines.
2. **By event kind** — colour-barred table showing savings per tool-call type
   (Read, image_shrink, Grep, etc.).
3. **By source** — collapsed view of the four user-facing mechanisms (image
   / hint / read / compact) plus an ``other`` catch-all.
4. **By day** — tabular daily breakdown (top N rows by bytes).
5. **By project** — tabular per-project breakdown (top N rows by bytes).
6. **Insights** — motivational copy loaded from ``stats_messages.json``.

Entry point: :func:`render_stats` — returns a ready-to-print ANSI string.

Layout uses ``_CONTENT_W`` (clamped 80–140 columns) and a shared set of
column-width constants so all tables are visually aligned.  Colour values
come from ``ansi.C`` (GitHub dark palette).
"""
from __future__ import annotations

__all__ = ["render_stats"]

import json
import math
import operator
import shutil
from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import TypedDict, cast

from ..util import get_logger
from .ansi import RESET, RGB, C, fg, lerp_rgb, pad_l, pad_r, strip_ansi, vlen
from .types import CommandStat, DayStat, KindStat, ProjectStat, SourceStat, StatsData

_LOG = get_logger("render.stats_renderer")

# Module-level key functions — avoids allocating a new lambda object on every
# sort/max call in the hot rendering path.
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
_TRACK = "░"  # light-shade for unfilled track — visually distinct from █ without relying on color
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
        bar += fg(*C.TRACK) + _TRACK * n_track

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


# ── Shared share-fraction helper ─────────────────────────────────────────────


def _token_or_byte_share(
    item_tokens: int,
    item_bytes: int,
    total_tokens: int,
    total_bytes: int,
) -> float:
    """Return the share fraction for one item relative to period totals.

    Prefers the token denominator when the period has any token savings, falling
    back to bytes when all token counts are zero (e.g. an image-only session).
    Returns 0.0 when both denominators are zero.

    Extracted to eliminate the identical 6-line if/elif/else block that appeared
    in ``_render_by_day_section`` and ``_render_by_project_section``.
    """
    if total_tokens > 0:
        return item_tokens / total_tokens
    if total_bytes > 0:
        return item_bytes / total_bytes
    return 0.0


def _bar_fraction(item_bytes: int, gross_bytes: int) -> float:
    """Savings-bar fill fraction. Positive-only: overhead rows render as empty bar.

    *gross_bytes* (sum of all positive bytes, clamped to >= 1) is the reference
    so the dominant positive item fills to 100%.
    """
    return item_bytes / gross_bytes if item_bytes > 0 else 0.0


def _compute_share_denominators(items: Iterable[object]) -> tuple[int, int, int]:
    """Single-pass aggregation → ``(gross_bytes, share_bytes_denom, share_tokens_denom)``.

    Each *item* must expose ``.bytes`` and ``.tokens`` (KindStat, SourceStat, …):

    * ``gross_bytes`` — sum of strictly positive ``.bytes`` (clamped >= 1) for
      bar-scaling so the dominant positive row fills 100%.
    * ``share_bytes_denom`` — sum of ``abs(.bytes)`` (clamped >= 1), share fallback.
    * ``share_tokens_denom`` — sum of ``abs(.tokens)`` (NOT clamped); callers
      test ``== 0`` to fall back to byte-share.

    Extracted from the identical three-formula idiom previously inlined in
    ``_render_by_kind_section`` and ``_render_by_source_section``.
    """
    gross_bytes_sum = 0
    share_bytes_sum = 0
    share_tokens_sum = 0
    for item in items:
        b = item.bytes  # type: ignore[attr-defined]  # items typed as Iterable[object]; callers pass KindStat/SourceStat/DayStat which all expose .bytes
        t = item.tokens  # type: ignore[attr-defined]  # same — all stat row types expose .tokens
        if b > 0:
            gross_bytes_sum += b
        share_bytes_sum += abs(b)
        share_tokens_sum += abs(t)
    return max(gross_bytes_sum, 1), max(share_bytes_sum, 1), share_tokens_sum


def _abs_share(item_bytes: int, item_tokens: int, share_bytes_denom: int, share_tokens_denom: int) -> float:
    """Share fraction using absolute-value denominators (kind/source pattern).

    Prefers tokens when non-zero; otherwise falls back to bytes.  Mirrors
    ``_token_or_byte_share`` but reuses pre-computed *abs* denominators so the
    kind/source sections do not re-aggregate inside the sort closure.
    """
    if share_tokens_denom == 0:
        return item_bytes / share_bytes_denom
    return item_tokens / share_tokens_denom


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

# Category groups for the "By kind" table.  Each entry is (label, set-of-kinds).
# Kinds not matched by any group fall into the last catch-all group.
# The order controls the visual order of group headers in the table.
_KIND_GROUPS: list[tuple[str, frozenset[str]]] = [
    ("Read savings", frozenset({
        "read_replacement", "section_replacement", "symbol_read",
        "section_read", "stub_view", "outline", "exports",
    })),
    ("Lookups", frozenset({
        "symbol_lookup", "semantic_search", "map_lookup",
    })),
    ("Images", frozenset({
        "image_shrink", "gdrive_image", "webfetch_image", "image_shrink_skipped",
    })),
    ("Hints", frozenset({
        "session_hint", "session_hint_overhead",
        "read_dedup_hint", "grep_dedup_hint", "diff_hint",
        "predictive_prefetch_hit", "read_partial_overlap_hint",
    })),
    ("Bash", frozenset({
        "bash_dedup_hint", "bash_output_cached", "bash_output_recall",
        "bash_output_recall_miss", "bash_dedup_stale",
        "bash_range_read_hint", "bash_streak_hint", "bash_poll_hint",
        "env_probe_cache_hit", "git_diff_scope_hint", "dep_list_cache_hit",
        "bash_read_equiv_already_read", "bash_grep_result_cache_hit",
        "git_diff_context_trimmed",
    })),
    ("Web", frozenset({
        "web_dedup_hint", "web_output_cached", "web_output_recall",
        "web_output_recall_miss", "web_dedup_stale",
    })),
    ("Compact / Skills", frozenset({
        "compact_manifest", "compact_assist", "compact_recovery",
        "skill_body_recall", "skill_compact_served", "skill_cached",
        "resume_packet", "decision_log",
    })),
    ("Other", frozenset()),  # catch-all: kinds not in any group above
]


def _kind_group_label(kind: str) -> str:
    """Return the group label for *kind*, falling back to ``"Other"`` for dynamic kinds
    such as ``bash_compress:pytest`` that don't appear in the static set.

    Dynamic ``bash_compress:*`` kinds are routed to the Bash group by prefix.
    """
    if kind.startswith("bash_compress:"):
        return "Bash"
    for label, members in _KIND_GROUPS:
        if label == "Other":
            continue
        if kind in members:
            return label
    return "Other"


def _group_separator(label: str) -> str:
    """Return a dim group-label separator line for the by-kind table."""
    return f"{_M}  {fg(*C.TEXT_DIM)}{label}{RESET}"


def _render_by_kind_section(stats: StatsData) -> list[str]:
    """Render the "By kind" table with category grouping.

    Kinds are grouped into named categories (Read savings, Lookups, Images, Hints,
    Bash, Web, Compact/Skills, Other).  Within each category rows are ordered by
    share, largest first.  Groups with no data are omitted entirely.

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
    gross_bytes, share_bytes_denom, share_tokens_denom = _compute_share_denominators(stats.by_kind)
    _kind_names = {k.kind for k in stats.by_kind}
    bytes_mode_kinds = [k.kind for k in stats.by_kind if k.bytes_mode_only]

    def _share(k: KindStat) -> float:
        """Fraction of the period total this kind represents (see section docstring).

        Bytes-mode-only kinds (e.g. image_shrink) ignore the token denominator
        because they have no meaningful token count; falling through to the
        absolute-byte share keeps the column truthful for those rows.
        """
        if k.bytes_mode_only:
            return k.bytes / share_bytes_denom
        return _abs_share(k.bytes, k.tokens, share_bytes_denom, share_tokens_denom)

    # Build a lookup: group_label -> [KindStat], sorted by share desc within each group.
    by_group: dict[str, list[KindStat]] = {}
    for k in stats.by_kind:
        grp = _kind_group_label(k.kind)
        by_group.setdefault(grp, []).append(k)
    for grp_kinds in by_group.values():
        grp_kinds.sort(key=_share, reverse=True)

    # Emit groups in the canonical order defined by _KIND_GROUPS.
    first_group = True
    for group_label, _ in _KIND_GROUPS:
        group_kinds = by_group.get(group_label)
        if not group_kinds:
            continue
        if not first_group:
            lines.append("")  # blank line between groups
        first_group = False
        lines.append(_group_separator(group_label))
        for k in group_kinds:
            share = _share(k)
            lines.append(_table_row(
                k.kind, _bar_fraction(k.bytes, gross_bytes), k.bytes, k.tokens, k.events, share,
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


# ── Section: by source ────────────────────────────────────────────────────────

# Distinct palette for the four user-facing source buckets.  Falls back to the
# muted-text colour for unknown / future sources so they still render rather
# than going silently grey-on-grey or crashing.
_SOURCE_COLORS: dict[str, RGB] = {
    "image":   C.PURPLE,
    "hint":    C.BLUE,
    "read":    C.GREEN4,
    "compact": C.TEAL,
    "bash":    C.ORANGE,
    "web":     C.YELLOW,
    "other":   C.TEXT_MUTED,
}


def _source_color(source: str) -> RGB:
    """Return the palette colour for a source name, falling back to muted."""
    return _SOURCE_COLORS.get(source, C.TEXT_MUTED)


def _render_by_source_section(stats: StatsData) -> list[str]:
    """Render the "By source" table: one row per source bucket.

    Sources are the four user-facing mechanisms (image / hint / read / compact)
    plus an ``other`` catch-all.  Rows render bytes saved, tokens saved, share
    of the period total, and an event count using the same column layout as the
    by-kind / by-day / by-project sections.

    Each source name is prefixed with a coloured bullet (``●``) drawn from the
    distinct ``_SOURCE_COLORS`` palette so the four mechanisms are visually
    separable at a glance, mirroring the by-project bullet treatment.

    Returns ``[]`` when ``stats.by_source`` is empty so older callers that
    construct ``StatsData`` without a by_source rollup still render cleanly.
    """
    if not stats.by_source:
        return []

    lines: list[str] = [*_section_header("By source"), _table_header("source")]

    # Bar scaling: positive-only gross so the widest positive bar reaches 100%.
    # Share %: absolute-value totals so any overhead rows (negative bytes) shrink
    # the denominator instead of pushing the dominant positive row past 100%.
    gross_bytes, share_bytes_denom, share_tokens_denom = _compute_share_denominators(stats.by_source)

    def _share(s: SourceStat) -> float:
        """Fraction of the period total this source represents."""
        return _abs_share(s.bytes, s.tokens, share_bytes_denom, share_tokens_denom)

    # Rows are ordered by share of the period total, largest first.
    for s in sorted(stats.by_source, key=_share, reverse=True):
        share = _share(s)
        color = _source_color(s.source)
        lines.append(_table_row(
            s.source, _bar_fraction(s.bytes, gross_bytes), s.bytes, s.tokens, s.events, share,
            name_prefix=f"{fg(*color)}●{RESET} ",
            name_color=C.TEXT_PRIMARY,
        ))

    return lines


def _render_by_command_section(stats: StatsData) -> list[str]:
    """Render the "By command" table: one row per CLI command.

    CLI commands (symbol, read, section, semantic, outline, refs, exports, skeleton, map)
    are aggregated by the commands that save the most tokens. Rows render bytes saved,
    tokens saved, share of the period total, and an event count using the same column
    layout as the by-kind / by-day / by-project sections.

    Returns ``[]`` when ``stats.by_command`` is empty so older callers that construct
    ``StatsData`` without a by_command rollup still render cleanly.
    """
    if not stats.by_command:
        return []

    lines: list[str] = [*_section_header("By command"), _table_header("command")]

    # Bar scaling: positive-only gross so the widest positive bar reaches 100%.
    gross_bytes, share_bytes_denom, share_tokens_denom = _compute_share_denominators(stats.by_command)

    def _share(c: CommandStat) -> float:
        """Fraction of the period total this command represents."""
        return _abs_share(c.bytes, c.tokens, share_bytes_denom, share_tokens_denom)

    # Rows are ordered by share of the period total, largest first.
    for c in sorted(stats.by_command, key=_share, reverse=True):
        share = _share(c)
        lines.append(_table_row(
            c.command, _bar_fraction(c.bytes, gross_bytes), c.bytes, c.tokens, c.events, share,
            name_color=C.TEXT_PRIMARY,
        ))

    return lines


# ── Shared: project bullet colours ─────────────────────────────────────────────────

_PROJECT_COLORS: list[RGB] = [C.PURPLE, C.TEAL, C.BLUE, C.GREEN4, C.TEXT_MUTED]


def _hash_color(hash_str: str) -> RGB:
    """Stable colour assignment based on hash string."""
    n = sum(ord(c) for c in hash_str)
    return _PROJECT_COLORS[n % len(_PROJECT_COLORS)]


# ── Section: by day ───────────────────────────────────────────────────────────

def _render_by_day_section(stats: StatsData) -> list[str]:
    """Render the "By day" table: one row per day, ordered latest-first by date.

    Share fraction uses tokens when the period total is non-zero, falling back
    to bytes when all token counts are zero (e.g. an image-only session).
    Returns ``[]`` when ``stats.by_day`` is empty.
    """
    if not stats.by_day:
        return []

    lines: list[str] = [*_section_header("By day"), _table_header("date")]

    def _share(d: DayStat) -> float:
        """Fraction of the period total this day represents (see section docstring)."""
        return _token_or_byte_share(d.tokens, d.bytes, stats.totals.tokens, stats.totals.bytes)

    # Rows are ordered newest-first so the most recent activity is at the top.
    for d in sorted(stats.by_day, key=lambda d: d.date, reverse=True):
        share = _share(d)
        lines.append(_table_row(d.date, share, d.bytes, d.tokens, d.events, share))

    return lines


# ── Section: by project ───────────────────────────────────────────────────────

def _render_by_project_section(stats: StatsData) -> list[str]:
    """Render the "By project (top 5)" table: one row per project (ordered by share) plus a path sub-row.

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
    lines: list[str] = [*_section_header(f"By project (top {len(stats.by_project)})"), _table_header("project")]

    def _share(p: ProjectStat) -> float:
        """Fraction of the cross-project total this project represents."""
        return _token_or_byte_share(p.tokens, p.bytes, project_total_tokens, project_total_bytes)

    # Rows are ordered by share of the cross-project total, largest first.
    for p in sorted(stats.by_project, key=_share, reverse=True):
        share = _share(p)
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


# ── Report header ──────────────────────────────────────────────────────────────

def _render_header(stats: StatsData) -> list[str]:
    """Return the report header line: name, version, and window label.

    ``stats.version`` is the installed package version; omitted when empty.
    ``stats.window_label`` is "last N days" or "all time"; omitted when empty.
    """
    line = f"{_M}{fg(*C.TEXT_BRIGHT)}token-goat{RESET}"
    if stats.version:
        line += f"  {fg(*C.TEXT_MUTED)}v{stats.version}{RESET}"
    if stats.window_label:
        line += f"  {fg(*C.TEXT_DIM)}·  {stats.window_label}{RESET}"
    return [line]


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
        _render_header(stats),
        _render_kpi_section(stats),
        _render_by_kind_section(stats),
        _render_by_source_section(stats),
        _render_by_command_section(stats),
        _render_by_day_section(stats),
        _render_by_project_section(stats),
        _render_insights_section(stats),
        [""],
    ]
    return "\n".join(line for section in sections for line in section)
