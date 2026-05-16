"""Shared hook-response assertion helpers for all hook test modules.

Kept in a separate importable module (not conftest.py) because pytest's conftest
is injected into the session but is not importable as ``from conftest import …``
on all Python/pytest configurations.

Usage::

    from hook_helpers import assert_continue, assert_deny
"""
from __future__ import annotations


def assert_continue(result: dict) -> None:
    """Assert ``continue: True``, tolerating extra diagnostic fields from dispatch.

    Centralised here so the identical one-liner does not have to be copy-pasted
    into every hook test module.
    """
    assert result.get("continue") is True


def assert_deny(result: dict) -> None:
    """Assert that a hook response carries a ``permissionDecision: deny`` payload.

    Checks both the outer ``continue: True`` (fail-soft contract) and the inner
    ``hookSpecificOutput.permissionDecision`` field so callers do not need to
    repeat the two-step pattern.
    """
    assert result.get("continue") is True
    hso = result.get("hookSpecificOutput", {})
    assert hso.get("permissionDecision") == "deny"
