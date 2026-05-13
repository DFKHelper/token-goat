"""ANSI truecolor utilities — Python port of ansi.ts."""
from __future__ import annotations

import os
import re
import sys

type RGB = tuple[int, int, int]

RESET = "\x1b[0m"


def use_color() -> bool:
    return not os.environ.get("NO_COLOR") and getattr(sys.stdout, "isatty", lambda: False)()


def fg(r: int, g: int, b: int) -> str:
    return f"\x1b[38;2;{r};{g};{b}m"


def bg(r: int, g: int, b: int) -> str:
    return f"\x1b[48;2;{r};{g};{b}m"


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def vlen(s: str) -> int:
    """Visible length of a string, stripping all ANSI escape sequences."""
    return len(_ANSI_RE.sub("", s))


def pad_r(s: str, w: int) -> str:
    return s + " " * max(0, w - vlen(s))


def pad_l(s: str, w: int) -> str:
    return " " * max(0, w - vlen(s)) + s


def lerp_rgb(a: RGB, b: RGB, t: float) -> RGB:
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


class _Palette:
    text_primary: RGB = (201, 209, 217)
    text_bright:  RGB = (240, 246, 252)
    text_muted:   RGB = (125, 133, 144)
    text_dim:     RGB = ( 72,  79,  88)
    bg_tile:      RGB = ( 22,  27,  34)
    track:        RGB = ( 28,  35,  41)
    green1:       RGB = ( 31,  77,  44)
    green2:       RGB = ( 46, 160,  67)
    green3:       RGB = ( 63, 185,  80)
    green4:       RGB = ( 86, 211, 100)
    green5:       RGB = (126, 231, 135)
    blue:         RGB = ( 88, 166, 255)
    purple:       RGB = (188, 140, 255)
    teal:         RGB = (138, 212, 255)
    red:          RGB = (200,  60,  60)


C = _Palette()
