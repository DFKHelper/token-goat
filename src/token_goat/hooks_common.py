"""Shared constants and micro-helpers used by all hook modules.

Centralises the five most-repeated patterns across the hook layer:

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

__all__ = [
    "CONTINUE",
    "LOG",
    "deny_redirect",
    "get_tool_input",
    "pre_tool_use_with_context",
    "pre_tool_use_with_update",
]

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


def pre_tool_use_with_context(additional_context: str) -> dict[str, Any]:
    """Build a PreToolUse response that injects an ``additionalContext`` hint.

    Used when the hook wants to leave the tool call unchanged but inject a
    message into the agent's context (e.g. session-hint re-read warnings).

    Replaces the repeated inline literal in :func:`hooks_read.pre_read`::

        return {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": str(hint),
            },
        }

    Args:
        additional_context: The message to inject (Markdown OK).

    Returns:
        A fully-formed hook response dict with ``continue: true`` and the hint.
    """
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": additional_context,
        },
    }


def pre_tool_use_with_update(updated_input: dict[str, Any], additional_context: str) -> dict[str, Any]:
    """Build a PreToolUse response that rewrites the tool input and injects a context hint.

    Used when the hook wants to redirect the tool call to a different target
    (e.g. image shrinking replaces the file path with a shrunken copy).

    Replaces the repeated inline literal in :func:`hooks_read._try_shrink_image`::

        return {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": shrink_response,
                "additionalContext": "...",
            },
        }

    Args:
        updated_input:      The modified ``tool_input`` dict to hand back to the harness.
        additional_context: Message explaining the redirect (Markdown OK).

    Returns:
        A fully-formed hook response dict with ``continue: true``, updated input, and the hint.
    """
    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "updatedInput": updated_input,
            "additionalContext": additional_context,
        },
    }
