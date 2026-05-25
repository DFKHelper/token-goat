"""Tests for token_goat.util helpers."""
from __future__ import annotations

import logging
import pathlib
import re

from token_goat.util import ellipsize, get_logger


def test_get_logger_name() -> None:
    """get_logger("foo") returns a Logger whose name is "token_goat.foo"."""
    log = get_logger("foo")
    assert log.name == "token_goat.foo"


def test_get_logger_returns_logger_instance() -> None:
    """get_logger returns a stdlib Logger."""
    log = get_logger("bar")
    assert isinstance(log, logging.Logger)


def test_get_logger_same_instance() -> None:
    """Repeated calls with the same name return the same Logger object."""
    assert get_logger("baz") is get_logger("baz")


def test_get_logger_dotted_name() -> None:
    """Dotted sub-module names are preserved verbatim after the prefix."""
    log = get_logger("languages.html")
    assert log.name == "token_goat.languages.html"


def test_no_bare_git_subprocess_calls_outside_util() -> None:
    """All git invocations must go through util.run_git for consistent kwargs + lock-avoidance."""
    src = pathlib.Path("src/token_goat")
    pattern = re.compile(r'subprocess\.run\s*\(\s*\[\s*["\']git["\']')
    offenders = []
    for py_file in src.rglob("*.py"):
        if py_file.name == "util.py":  # the canonical implementation lives here
            continue
        text = py_file.read_text(encoding="utf-8")
        for m in pattern.finditer(text):
            offenders.append(f"{py_file}:{text[:m.start()].count(chr(10))+1}")
    assert not offenders, (
        f"Bare git subprocess.run found outside util.py: {offenders}. Use util.run_git instead."
    )


class TestEllipsize:
    """ellipsize(s, max_chars) truncates with trailing … when over budget."""

    def test_short_string_unchanged(self) -> None:
        assert ellipsize("hello", 10) == "hello"

    def test_exact_length_unchanged(self) -> None:
        assert ellipsize("hello", 5) == "hello"

    def test_over_budget_truncated(self) -> None:
        result = ellipsize("hello world", 8)
        assert result == "hello w…"
        assert len(result) == 8

    def test_one_over_budget(self) -> None:
        result = ellipsize("abcde", 4)
        assert result == "abc…"
        assert len(result) == 4

    def test_empty_string_unchanged(self) -> None:
        assert ellipsize("", 5) == ""

    def test_result_length_is_max_chars(self) -> None:
        for n in (1, 5, 10, 20):
            s = "x" * (n + 5)
            result = ellipsize(s, n)
            assert len(result) == n, f"max_chars={n} gave length {len(result)}"

    def test_trailing_ellipsis_char(self) -> None:
        result = ellipsize("abcdef", 3)
        assert result.endswith("…")

    def test_max_chars_one(self) -> None:
        result = ellipsize("abc", 1)
        assert result == "…"
