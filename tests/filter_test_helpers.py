"""Shared helpers for bash_compress filter tests.

Centralises the ``_apply`` / ``_savings_ratio`` helpers that were previously
copy-pasted into every ``test_bash_compress_*.py`` module.  Import them as:

    from filter_test_helpers import apply_filter, savings_ratio

The old module-local names ``_apply`` and ``_savings_ratio`` can be aliased at
the import site to keep diff noise low::

    from filter_test_helpers import apply_filter as _apply
    from filter_test_helpers import savings_ratio as _savings_ratio
"""
from __future__ import annotations

from token_goat import bash_compress as bc


def apply_filter(
    filter_: bc.Filter,
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    """Run *filter_.apply()* and return the compressed text.

    When *argv* is ``None`` the filter's own ``.name`` attribute is used as
    the sole argv element — the minimum needed for most dispatch checks.
    """
    if argv is None:
        argv = [filter_.name]
    return filter_.apply(stdout, stderr, exit_code, argv).text


def savings_ratio(
    filter_: bc.Filter,
    stdout: str,
    stderr: str = "",
    argv: list[str] | None = None,
) -> float:
    """Return the byte-savings fraction in the range 0.0–1.0.

    Convenience wrapper around ``filter_.apply(...).percent_saved / 100.0``
    used by savings-ratio assertion tests.
    """
    if argv is None:
        argv = [filter_.name]
    return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0


class FilterTestMixin:
    """Mixin providing shared test methods for bash-compress filter test classes.

    Inherit alongside a class that defines a class-level ``F`` attribute
    (a ``bc.Filter`` instance).  The mixin's tests run as part of the
    inheriting class's pytest collection automatically.

    Usage::

        class TestMyFilter(FilterTestMixin):
            F = bc.MyFilter()
            ...
    """

    F: bc.Filter  # subclass must define this

    def test_empty_input(self) -> None:
        """Filter must return a str (not raise) on empty input."""
        out = apply_filter(self.F, "")
        assert isinstance(out, str)

    def test_empty_output(self) -> None:
        """Filter must return a str (not raise) when stdout is empty string."""
        result = apply_filter(self.F, stdout="")
        assert isinstance(result, str)
