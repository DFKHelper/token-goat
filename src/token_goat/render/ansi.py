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

import os
import re
import sys

# Requires a terminal with COLORTERM=truecolor (Windows Terminal, iTerm2,
# Alacritty, kitty, WezTerm, and most modern terminal emulators).
# Respects NO_COLOR — callers can check `USE_COLOR` before rendering.
USE_COLOR: bool = not os.environ.get("NO_COLOR") and sys.stdout.isatty()

RGB = tuple[int, int, int]

_E = "\x1b"
RESET = f"{_E}[0m"


def fg(r: int, g: int, b: int) -> str:
    """Set 24-bit foreground colour."""
    return f"{_E}[38;2;{r};{g};{b}m"


def bg(r: int, g: int, b: int) -> str:
    """Set 24-bit background colour."""
    return f"{_E}[48;2;{r};{g};{b}m"


def vlen(s: str) -> int:
    """Visible length of a string, stripping all ANSI escape sequences."""
    return len(re.sub(r"\x1b\[[0-9;]*m", "", s))


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
    RED:          RGB = (200,  60,  60)  # negative delta
