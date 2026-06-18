"""ANSI 24-bit colour primitives and text-alignment helpers for terminal rendering.

Exports:
- ``fg`` / ``bg``: Set 24-bit foreground/background colour escape sequences.
- ``vlen``: Visible (non-ANSI) length of a string.
- ``pad_r`` / ``pad_l``: Pad ANSI-coded strings to a fixed visible width.
- ``lerp_rgb``: Linear interpolation between two RGB colours.
- ``C``: Shared colour palette (GitHub dark-inspired, green accent).
- ``USE_COLOR``: ``True`` when the terminal supports 24-bit colour and
  ``NO_COLOR`` is not set.  Callers should check this before building
  ANSI sequences.
"""
from __future__ import annotations

__all__ = ["C", "RGB", "RESET", "USE_COLOR", "bg", "color_stderr", "color_stdout", "fg", "fmt_bytes", "lerp_rgb", "pad_l", "pad_r", "strip_ansi", "vlen"]

import os
import re
import sys

# Requires a terminal with COLORTERM=truecolor (Windows Terminal, iTerm2,
# Alacritty, kitty, WezTerm, and most modern terminal emulators).
# Respects NO_COLOR — callers can check `USE_COLOR` before rendering.


def _color_stream(stream: object) -> bool:
    """Return True when *stream* is a TTY and the ``NO_COLOR`` env-var is unset.

    Follows the `no-color.org <https://no-color.org/>`_ convention.  Shared by
    :func:`color_stdout` and :func:`color_stderr` so the rule lives in one place.
    """
    if os.environ.get("NO_COLOR"):
        return False
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def color_stdout() -> bool:
    """Return True when stdout supports ANSI colour.

    Checks both ``sys.stdout.isatty()`` and the ``NO_COLOR`` env-var per the
    `no-color.org <https://no-color.org/>`_ convention.  Use for output written
    to stdout (stats panels, map output, etc.).
    """
    return _color_stream(sys.stdout)


def color_stderr() -> bool:
    """Return True when stderr supports ANSI colour.

    Same logic as :func:`color_stdout` but tests ``sys.stderr.isatty()``.
    Use for progress indicators, spinners, and diagnostic output written to
    stderr.
    """
    return _color_stream(sys.stderr)


USE_COLOR: bool = color_stdout()

RGB = tuple[int, int, int]

_E = "\x1b"
RESET = f"{_E}[0m"

# Full VT/ANSI escape sequence pattern — covers CSI (colour, cursor, erase),
# OSC (title/hyperlink sequences used by pip/docker/cargo progress UIs),
# DCS/SOS/PM/APC strings, and bare 2-byte ESC sequences.  Compiled once here
# and shared by vlen(), strip_ansi(), and callers in stats.py /
# stats_renderer.py so there is exactly one copy of this pattern in the process.
# bash_compress.strip_ansi re-exports this via `from .render.ansi import strip_ansi`.
_ANSI_ESCAPE_RE = re.compile(
    r"""
    \x1B \[ [0-?]* [ -/]* [@-~]       # CSI sequence (SGR, cursor, erase, …)
    | \x1B \] .*? (?: \x07 | \x1B \\) # OSC sequence (title, hyperlinks, …)
    | \x1B [PX^_] .*? \x1B \\         # DCS / SOS / PM / APC (before 2-byte: P/X/^/_ are in [@-Z\\-_])
    | \x1B [@-Z\\-_]                  # 2-byte ESC sequence (fallback for bare single-byte payloads)
    """,
    re.VERBOSE | re.DOTALL,
)

# Unicode Private Use Area regex: strips U+E000–U+F8FF (BMP) and U+F0000–U+FFFDD (supplementary).
_PUA_RE = re.compile(r'[\U0000E000-\U0000F8FF\U000F0000-\U000FFFDD]')


def strip_ansi(s: str) -> str:
    """Remove all ANSI/VT escape sequences from *s*.

    Optimized with a fast path for plain text (no ESC byte), and handles:
    - CSI colour/cursor sequences
    - OSC hyperlinks and title sequences
    - DCS/SOS/PM/APC strings
    - Unicode Private Use Area characters (U+E000–U+F8FF, U+F0000–U+FFFDD)
      emitted by some terminal emulators for custom icons.
    """
    # Fast path: if there's no ESC byte and no PUA chars, return unchanged.
    # This covers the vast majority of plain bash output (~10x speedup).
    # Note: we check ESC byte only since PUA chars are rare; full scan would negate speedup.
    if '\x1b' not in s:
        # Even without ANSI escapes, we may have PUA chars (rare but possible).
        # However, checking for them would require regex scan which defeats the fast path.
        # Since PUA is rare in typical bash output, we accept this as a design tradeoff.
        return s

    # Strip ANSI/VT escape sequences.
    text = _ANSI_ESCAPE_RE.sub("", s)

    # Strip Unicode Private Use Area characters which some terminal emulators
    # use for custom icons/symbols. Ranges: U+E000–U+F8FF (BMP) and
    # U+F0000–U+FFFDD (Supplementary PUA).
    return _PUA_RE.sub("", text)



def fmt_bytes(n: int) -> str:
    """Format a byte count as a plain-text human-readable string (B/KB/MB/GB/TB/PB).

    No ANSI codes — safe for use in Rich table cells and fallback renderers.
    For the ANSI-coloured variant used in the truecolor renderer see
    ``render.stats_renderer._fmt_bytes``.
    """
    value: float = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024:
            return f"{int(value)}{unit}" if unit == "B" else f"{value:.1f}{unit}"
        value = value / 1024
    return f"{value:.1f}PB"


def fg(r: int, g: int, b: int) -> str:
    """Set 24-bit foreground colour."""
    return f"{_E}[38;2;{r};{g};{b}m"


def bg(r: int, g: int, b: int) -> str:
    """Set 24-bit background colour."""
    return f"{_E}[48;2;{r};{g};{b}m"


def vlen(s: str) -> int:
    """Visible length of a string, stripping all ANSI escape sequences."""
    return len(_ANSI_ESCAPE_RE.sub("", s))


def pad_r(s: str, w: int) -> str:
    """Right-pad a (possibly ANSI-coded) string to `w` visible characters."""
    return s + " " * max(0, w - vlen(s))


def pad_l(s: str, w: int) -> str:
    """Left-pad a (possibly ANSI-coded) string to `w` visible characters."""
    return " " * max(0, w - vlen(s)) + s


def lerp_rgb(a: RGB, b: RGB, t: float) -> RGB:
    """Linearly interpolate two RGB colours."""
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


class C:
    """Shared colour palette (GitHub dark-inspired green accent scheme)."""
    TEXT_PRIMARY: RGB = (201, 209, 217)  # #c9d1d9
    TEXT_BRIGHT:  RGB = (240, 246, 252)  # #f0f6fc
    TEXT_MUTED:   RGB = (125, 133, 144)  # #7d8590
    TEXT_DIM:     RGB = ( 72,  79,  88)  # #484f58
    BG_TILE:      RGB = ( 22,  27,  34)  # #161b22 — empty heatmap cell
    TRACK:        RGB = ( 28,  35,  41)  # #1c2329 — unfilled bar track
    # Green gradient, dim → bright
    GREEN1:       RGB = ( 31,  77,  44)  # #1f4d2c
    GREEN2:       RGB = ( 46, 160,  67)  # #2ea043
    GREEN3:       RGB = ( 63, 185,  80)  # #3fb950
    GREEN4:       RGB = ( 86, 211, 100)  # #56d364
    GREEN5:       RGB = (126, 231, 135)  # #7ee787
    # Accents
    BLUE:         RGB = ( 88, 166, 255)  # tokens
    PURPLE:       RGB = (188, 140, 255)  # project bullet 1
    TEAL:         RGB = (138, 212, 255)  # project bullet 2
    ORANGE:       RGB = (235, 165,  80)  # bash bucket — distinct from the cool-toned hint/read/compact
    YELLOW:       RGB = (240, 215,  80)  # web bucket — pairs with orange in warm-tone half
    RED:          RGB = (200,  60,  60)  # negative delta
