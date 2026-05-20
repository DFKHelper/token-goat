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
    "HookPayload",
    "HookResponse",
    "HookSpecificOutputContext",
    "HookSpecificOutputDeny",
    "HookSpecificOutputUpdate",
    "LOG",
    "deny_redirect",
    "get_session_context",
    "get_tool_input",
    "is_real_int",
    "pre_tool_use_with_context",
    "pre_tool_use_with_update",
    "record_hint_stat_pair",
    "sanitize_log_str",
    "sanitize_opt",
    "validate_cwd",
]

import logging
from pathlib import Path
from typing import Any, TypedDict, TypeGuard, cast

# ---------------------------------------------------------------------------
# Typed shape for inbound hook payloads
# ---------------------------------------------------------------------------

class HookPayload(TypedDict, total=False):
    """Typed shape for the JSON object received on stdin by every hook handler.

    All fields are optional (``total=False``) because the harness may omit any
    field, and hooks must degrade gracefully when fields are absent.  The subset
    of fields here covers all keys accessed by the token-goat hook layer; unknown
    harness-specific keys are accepted at runtime (TypedDict does not reject
    extra keys).
    """

    session_id: str
    cwd: str
    turn_id: str
    tool_name: str
    tool_input: dict[str, Any]
    file_path: str
    file_content: str
    line_number: int
    result_count: int
    trigger: str


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


def get_session_context(payload: HookPayload) -> tuple[str | None, str | None]:
    """Return ``(session_id, cwd)`` from a hook payload, or ``(None, None)`` for missing keys.

    Eliminates the repeated pair::

        session_id = payload.get("session_id")
        cwd = payload.get("cwd")

    across hook handler bodies.  Both fields are optional in the harness protocol
    (``HookPayload`` uses ``total=False``), so either or both may be absent.
    """
    session_id = cast("str | None", payload.get("session_id"))
    cwd = cast("str | None", payload.get("cwd"))
    if session_id is None:
        LOG.debug("get_session_context: session_id absent from payload (tool=%s)", sanitize_opt(payload.get("tool_name")))
    if cwd is None:
        LOG.debug("get_session_context: cwd absent from payload (tool=%s)", sanitize_opt(payload.get("tool_name")))
    return session_id, cwd


def get_tool_input(payload: HookPayload | None) -> dict[str, Any]:
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


# Unicode bidirectional control characters that can cause log viewers to
# display misleading text by overriding rendering direction.  A malicious
# filename containing U+202E (RIGHT-TO-LEFT OVERRIDE) could make "evil.exe"
# appear as "exe.live" in a terminal or log viewer.  Strip them all.
_BIDI_CONTROLS = (
    "‎",  # LEFT-TO-RIGHT MARK
    "‏",  # RIGHT-TO-LEFT MARK
    "‪",  # LEFT-TO-RIGHT EMBEDDING
    "‫",  # RIGHT-TO-LEFT EMBEDDING
    "‬",  # POP DIRECTIONAL FORMATTING
    "‭",  # LEFT-TO-RIGHT OVERRIDE
    "‮",  # RIGHT-TO-LEFT OVERRIDE
    "⁦",  # LEFT-TO-RIGHT ISOLATE
    "⁧",  # RIGHT-TO-LEFT ISOLATE
    "⁨",  # FIRST STRONG ISOLATE
    "⁩",  # POP DIRECTIONAL ISOLATE
)


def sanitize_log_str(value: str, max_len: int = 200) -> str:
    """Sanitize a user-controlled string before embedding it in a log message.

    Strips embedded newlines and carriage returns that could inject fake log
    entries into the log file.  Also removes Unicode bidirectional control
    characters (U+200E/F, U+202A-E, U+2066-2069) that can cause log viewers
    and terminals to display misleading text by overriding rendering direction.
    Truncates to *max_len* to prevent log flooding.  The returned string is
    safe to pass to any %-style log call.
    """
    sanitized = value.replace("\n", "\\n").replace("\r", "\\r")
    for ch in _BIDI_CONTROLS:
        sanitized = sanitized.replace(ch, "")
    if len(sanitized) > max_len:
        sanitized = sanitized[:max_len] + "…"
    return sanitized


def sanitize_opt(value: object) -> str:
    """Sanitize an optional log value: convert to str, strip injections, return "" for falsy.

    Eliminates the repeated ``sanitize_log_str(str(x or ""))`` pattern across hook
    modules.  Calling ``sanitize_opt(x)`` is equivalent to::

        sanitize_log_str(str(x)) if x else ""

    Unlike a bare ``sanitize_log_str(str(x or ""))``, this helper also handles the
    case where *x* is ``0`` or ``False`` (falsy non-None values) — they are treated
    the same as ``None`` and return ``""``.  Hook payload fields for session IDs,
    paths, and tool names are always strings; a numeric or boolean value means the
    field was absent or malformed, so collapsing it to ``""`` is correct.

    Args:
        value: Any value from a hook payload (session_id, cwd, tool_name, …).

    Returns:
        A sanitized string safe for use in log messages, or ``""`` if *value* is falsy.
    """
    if not value:
        return ""
    if not isinstance(value, str):
        LOG.debug(
            "sanitize_opt: coercing non-string payload field %s(%r) to str",
            type(value).__name__,
            sanitize_log_str(str(value)),
        )
    return sanitize_log_str(str(value))


def record_hint_stat_pair(kind: str, hint: object, detail: str) -> None:
    """Record a matched-pair of stat rows for a hint: the gross saving plus the injection overhead.

    Every dedup / diff / session hint saves tokens by suppressing a re-read or
    re-run, but the hint text itself costs tokens to inject.  Honest accounting
    requires both rows so ``token-goat stats`` can net them out.

    This helper centralises the five-line block that previously appeared
    identically in ``_handle_bash_dedup``, ``_handle_grep_dedup``,
    ``_handle_web_dedup``, ``_try_diff_hint``, and ``_record_session_hint_impact``.
    Each site only differs in the *kind* string and the *detail* label; the
    arithmetic and the two ``db.record_stat`` calls are always the same.

    Args:
        kind:   Base stat kind for the saving row (e.g. ``"bash_dedup_hint"``).
                The overhead row is recorded under ``kind + "_overhead"``
                automatically.
        hint:   The hint object — must have a numeric ``tokens_saved`` attribute
                (any :class:`~hints.ReadHint` / :class:`~hints.DedupHint`
                subclass), and must support ``len()`` so the injection byte cost
                can be measured.  Accepts ``object`` so callers that pass a
                typed hint subclass do not need a cast.
        detail: Short string stored in the stat row for triage (path, pattern,
                URL, or command preview).  Callers are responsible for
                sanitising it before passing — use :func:`sanitize_log_str`.
    """
    from . import db  # noqa: PLC0415
    from .hints import CHARS_PER_TOKEN  # noqa: PLC0415

    realized_tokens: int = getattr(hint, "tokens_saved", 0)
    injection_bytes: int = len(hint)  # type: ignore[arg-type]
    injection_cost_tokens = max(1, int(injection_bytes / CHARS_PER_TOKEN))
    db.record_stat(
        None,
        kind,
        bytes_saved=realized_tokens * 4,
        tokens_saved=realized_tokens,
        detail=detail,
    )
    db.record_stat(
        None,
        kind + "_overhead",
        bytes_saved=-injection_bytes,
        tokens_saved=-injection_cost_tokens,
        detail=detail,
    )


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


# Maximum byte length accepted for a ``cwd`` value from an untrusted hook
# payload.  Matches PATH_MAX on Linux; well above any real working-directory
# path on Windows.  Prevents large Path object allocations from adversarial input.
_MAX_CWD_LEN: int = 4096


def validate_cwd(cwd: object, *, caller: str = "hook") -> Path | None:
    """Validate a ``cwd`` value from an untrusted hook payload.

    Returns a :class:`pathlib.Path` when *cwd* is a non-empty string that is
    not too long, is absolute, and names an existing directory.  Returns
    ``None`` and logs a warning otherwise.

    This replicates — and centralises — the guard in
    :func:`hooks_session._detect` so that every hook handler that resolves a
    project from ``cwd`` applies the same checks.  Without this guard a
    malicious harness payload could supply a relative traversal string (e.g.
    ``../../sensitive``) or an excessively long value (100 KB+) that would
    be silently handed to :func:`project.find_project`.

    Args:
        cwd:    The raw ``cwd`` field from the hook payload (may be any type).
        caller: Short label used in warning log messages (e.g. ``"post-edit"``).

    Returns:
        A validated :class:`pathlib.Path`, or ``None`` if validation fails.
    """
    if not cwd or not isinstance(cwd, str):
        return None
    if len(cwd) > _MAX_CWD_LEN:
        LOG.warning(
            "%s: cwd too long (%d chars > %d limit); ignoring",
            caller,
            len(cwd),
            _MAX_CWD_LEN,
        )
        return None
    cwd_path = Path(cwd)
    if not cwd_path.is_absolute():
        LOG.warning(
            "%s: cwd is not an absolute path (%r); ignoring",
            caller,
            sanitize_log_str(cwd),
        )
        return None
    try:
        if not cwd_path.is_dir():
            LOG.warning(
                "%s: cwd %r is not an existing directory; ignoring",
                caller,
                sanitize_log_str(cwd),
            )
            return None
    except (OSError, ValueError) as exc:
        LOG.warning(
            "%s: could not stat cwd %r: %s; ignoring",
            caller,
            sanitize_log_str(cwd),
            exc,
        )
        return None
    return cwd_path


def is_real_int(value: object) -> TypeGuard[int]:
    """Return *True* when *value* is a genuine ``int``, not a ``bool``.

    Python's ``bool`` subclasses ``int``, so a plain ``isinstance(x, int)``
    check accepts ``True`` / ``False``.  Call-sites that guard untrusted
    payload fields against accidental bool values previously repeated the
    same two-clause idiom:

    .. code-block:: python

        isinstance(x, int) and not isinstance(x, bool)

    This predicate names the intent, documents the gotcha, and guarantees all
    sites apply the guard identically.  Returning a ``TypeGuard[int]`` lets
    type-checkers narrow the value to ``int`` in the branch where this
    returns ``True``.
    """
    return isinstance(value, int) and not isinstance(value, bool)
