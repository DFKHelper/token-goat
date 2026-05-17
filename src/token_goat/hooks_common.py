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

TypedDicts
----------
This module defines the typed shapes for the three ``hookSpecificOutput``
variants that token-goat produces, plus the ``ContinueResponse`` used when the
hook passes through unchanged.  These types are exported for use by the rest of
the hook layer (``hooks_cli``, ``hooks_read``, ``hooks_fetch``, …) so that
every response-builder has a precise return type instead of ``dict[str, Any]``.
"""
from __future__ import annotations

__all__ = [
    "CONTINUE",
    "HookResponse",
    "HookSpecificOutputContext",
    "HookSpecificOutputDeny",
    "HookSpecificOutputUpdate",
    "LOG",
    "deny_redirect",
    "get_tool_input",
    "pre_tool_use_with_context",
    "pre_tool_use_with_update",
    "sanitize_log_str",
]

import logging
from typing import Any, TypedDict

# ---------------------------------------------------------------------------
# Typed shapes for hookSpecificOutput payloads
# ---------------------------------------------------------------------------

class HookSpecificOutputDeny(TypedDict):
    """Shape produced by :func:`deny_redirect` — deny a tool call with a redirect hint."""

    hookEventName: str
    permissionDecision: str
    permissionDecisionReason: str
    additionalContext: str


class HookSpecificOutputContext(TypedDict):
    """Shape produced by :func:`pre_tool_use_with_context` — inject an additionalContext hint."""

    hookEventName: str
    additionalContext: str


class HookSpecificOutputUpdate(TypedDict):
    """Shape produced by :func:`pre_tool_use_with_update` — rewrite tool input and inject a hint."""

    hookEventName: str
    updatedInput: dict[str, object]
    additionalContext: str


# HookResponse — the top-level response type returned by every hook handler.
# Defined here (not in hooks_cli) so hook submodules can import it without
# creating a circular dependency (hooks_cli imports all hook submodules).
#
# All fields are optional (total=False) because a handler may return only
# {"continue": True} or may add systemMessage / hookSpecificOutput / diagnostics.
# The hookSpecificOutput field accepts any of the three typed sub-shapes
# (HookSpecificOutputDeny, HookSpecificOutputContext, HookSpecificOutputUpdate)
# as well as arbitrary dicts for forward compatibility.
HookResponse = TypedDict(
    "HookResponse",
    {
        "continue": bool,
        "systemMessage": str,
        # hookSpecificOutput may be any of the three concrete sub-shapes produced
        # by this module, or an arbitrary dict for forward compatibility with new
        # harness-specific keys.  Using a Union here lets mypy verify that all
        # three builders (deny_redirect, pre_tool_use_with_context,
        # pre_tool_use_with_update) produce a compatible type without requiring a
        # cast, while still accepting unknown shapes via the trailing dict[str, Any].
        "hookSpecificOutput": HookSpecificOutputDeny | HookSpecificOutputContext | HookSpecificOutputUpdate | dict[str, Any],
        # Diagnostic fields — ignored by the harness, useful for tests/logging.
        "_tg_elapsed_ms": float,
        "_tg_handler": str,
        "_tg_error": str,
    },
    total=False,
)

# All hook modules share one logger so their output appears together in the log.
LOG = logging.getLogger("token_goat.hooks")

# The most common hook response: let the harness proceed unchanged.
# Using a function (not a bare dict) keeps each call site independent — callers
# that mutate the return value won't corrupt subsequent callers.
def CONTINUE() -> HookResponse:  # noqa: N802 — intentional SCREAMING_SNAKE alias
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


def deny_redirect(reason: str, context: str) -> HookResponse:
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
        A fully-typed hook response with ``continue: true`` and a deny decision.
    """
    hso = HookSpecificOutputDeny(
        hookEventName="PreToolUse",
        permissionDecision="deny",
        permissionDecisionReason=reason,
        additionalContext=context,
    )
    return {"continue": True, "hookSpecificOutput": hso}


def pre_tool_use_with_context(additional_context: str) -> HookResponse:
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
        A fully-typed hook response with ``continue: true`` and the hint.
    """
    hso = HookSpecificOutputContext(
        hookEventName="PreToolUse",
        additionalContext=additional_context,
    )
    return {"continue": True, "hookSpecificOutput": hso}


def sanitize_log_str(value: str, max_len: int = 200) -> str:
    """Sanitize a user-controlled string before embedding it in a log message.

    Strips embedded newlines and carriage returns that could inject fake log
    entries into the log file, and truncates to *max_len* to prevent log
    flooding.  The returned string is safe to pass to any %-style log call.
    """
    sanitized = value.replace("\n", "\\n").replace("\r", "\\r")
    if len(sanitized) > max_len:
        sanitized = sanitized[:max_len] + "…"
    return sanitized


def pre_tool_use_with_update(updated_input: dict[str, object], additional_context: str) -> HookResponse:
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
                            Values are typed as ``object`` (arbitrary JSON).
        additional_context: Message explaining the redirect (Markdown OK).

    Returns:
        A fully-typed hook response with ``continue: true``, updated input, and the hint.
    """
    hso = HookSpecificOutputUpdate(
        hookEventName="PreToolUse",
        updatedInput=updated_input,
        additionalContext=additional_context,
    )
    return {"continue": True, "hookSpecificOutput": hso}
