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
