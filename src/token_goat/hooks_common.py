"""Shared constants and micro-helpers used by all hook modules.

Centralises the three most-repeated patterns across the hook layer:

* ``CONTINUE`` — the canonical ``{"continue": True}`` response dict.  Using the
  constant instead of an inline literal prevents typos, makes intent explicit,
  and means grep can find every early-exit point in one search.

* ``get_tool_input(payload)`` — ``payload.get("tool_input") or {}`` appeared in
  six places across three files.  The helper also guards against the payload
  itself being ``None``, which raw ``payload.get(...)`` would crash on.

* ``_deny_redirect(reason, context)`` — builds the canonical
  ``{"continue": True, "hookSpecificOutput": {"hookEventName": "PreToolUse",
  "permissionDecision": "deny", ...}}`` shape that every interception response
  uses.  Callers supply only the two strings that differ between them.
"""
from __future__ import annotations

import logging
from typing import Any

# All hook modules share one logger so their output appears together in the log.
LOG = logging.getLogger("token_goat.hooks")

# The most common hook response: let the harness proceed unchanged.
# Using a function (not a bare dict) keeps each call site independent — callers
# that mutate the return value won't corrupt subsequent callers.
def CONTINUE() -> dict[str, Any]:  # noqa: N802 — intentional SCREAMING_SNAKE alias
    """Return a fresh ``{"continue": True}`` dict.

    Named in UPPER_CASE to read like a constant at call sites::

        return CONTINUE()

    A factory (not a module-level dict) ensures each caller gets its own object
    and cannot accidentally mutate a shared singleton.
    """
    return {"continue": True}


def get_tool_input(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Return ``payload["tool_input"]`` as a dict, defaulting to ``{}``.

    Handles three degenerate cases without extra ``if`` chains at every call site:
    * payload is ``None``
    * ``tool_input`` key is missing
    * ``tool_input`` value is ``None`` or another falsy non-dict
    """
    if not isinstance(payload, dict):
        return {}
    value = payload.get("tool_input")
    return value if isinstance(value, dict) else {}


def deny_redirect(reason: str, context: str) -> dict[str, Any]:
    """Build the canonical interception response that denies a tool call with a redirect hint.

    Both :func:`hooks_fetch._intercept_drive_download` and
    :func:`hooks_fetch._intercept_webfetch_image` produce identical structure;
    only the ``permissionDecisionReason`` and ``additionalContext`` strings differ.

    Args:
        reason:  Short sentence explaining *why* the tool call was denied.
                 Stored in ``hookSpecificOutput.permissionDecisionReason``.
        context: Longer message (Markdown OK) telling the agent what to do instead.
                 Stored in ``hookSpecificOutput.additionalContext``.

    Returns:
        A fully-formed hook response dict with ``continue: true`` and a deny decision.
    """
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
            "additionalContext": context,
        },
    }
