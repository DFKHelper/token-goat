"""Tests for render.ansi colour helpers — bg() and lerp_rgb().

These two functions had no callers in the test suite and showed as uncovered.
"""
from __future__ import annotations

from token_goat.render.ansi import bg, lerp_rgb


class TestBg:
    """bg() returns a 24-bit background-colour escape sequence."""

    def test_returns_escape_sequence(self) -> None:
        assert bg(0, 128, 255) == "\x1b[48;2;0;128;255m"

    def test_black(self) -> None:
        assert bg(0, 0, 0) == "\x1b[48;2;0;0;0m"

    def test_white(self) -> None:
        assert bg(255, 255, 255) == "\x1b[48;2;255;255;255m"


class TestLerpRgb:
    """lerp_rgb() linearly interpolates two RGB tuples component-wise."""

    def test_t_zero_returns_a(self) -> None:
        a, b = (10, 20, 30), (100, 200, 255)
        assert lerp_rgb(a, b, 0.0) == (10, 20, 30)

    def test_t_one_returns_b(self) -> None:
        a, b = (10, 20, 30), (100, 200, 255)
        assert lerp_rgb(a, b, 1.0) == (100, 200, 255)

    def test_midpoint(self) -> None:
        result = lerp_rgb((0, 0, 0), (100, 200, 50), 0.5)
        assert result == (50, 100, 25)

    def test_all_three_components_interpolated(self) -> None:
        t = 0.2
        a, b = (0, 0, 0), (255, 100, 50)
        result = lerp_rgb(a, b, t)
        assert result == (round(255 * t), round(100 * t), round(50 * t))
