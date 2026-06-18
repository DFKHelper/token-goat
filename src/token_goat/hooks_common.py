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

Adaptive Hook Timeout
---------------------
When a hook subprocess hits the watchdog timeout, an adaptive mechanism doubles
the timeout for the remainder of the session (capped at 30000 ms) to recover on
slow CI machines or during cold-cache scenarios.  This per-session state is
stored in module-level variables and reset on successful hook completion.

TypedDicts
----------
This module defines the typed shapes for the three ``hookSpecificOutput``
variants that token-goat produces, plus the ``ContinueResponse`` used when the
hook passes through unchanged.  These types are exported for use by the rest of
the hook layer (``hooks_cli``, ``hooks_read``, ``hooks_fetch``, …) so that
every response-builder has a precise return type instead of ``dict[str, Any]``.
"""
from __future__ import annotations

from .util import get_logger

__all__ = [
    "CONTINUE",
    "LOG",
    "HookPayload",
    "HookResponse",
    "HookSpecificOutputContext",
    "HookSpecificOutputDeny",
    "HookSpecificOutputUpdate",
    "_is_quiet_hours",
    "bytes_to_tokens",
    "deny_redirect",
    "emit_if_new_hint",
    "extract_tool_response_text",
    "get_effective_watchdog_ms",
    "get_hook_context",
    "get_session_context",
    "get_tool_input",
    "is_real_int",
    "load_session_safe",
    "pre_tool_use_with_context",
    "pre_tool_use_with_update",
    "record_cached_stat",
    "record_hint_stat_pair",
    "record_watchdog_timeout",
    "run_dedup_hint",
    "sanitize_log_str",
    "sanitize_opt",
    "update_session",
    "validate_cwd",
]

from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, TypedDict, TypeGuard, cast

if TYPE_CHECKING:
    from collections.abc import Callable

    from .session import SessionCache

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
    tool_response: object
    tool_result: object
    response: object
    file_path: str
    file_content: str
    line_number: int
    result_count: int
    trigger: str
    # Harness-specific ID fields: Claude/Codex use toolUseId; Gemini uses
    # functionCallId.  normalize_payload remaps the latter to the former so
    # downstream handlers always see toolUseId when present.
    toolUseId: str
    functionCallId: str
    # Internal metadata stamped by normalize_payload — not present in the raw
    # harness payload, only in the normalized form seen by hook handlers.
    _tg_harness: str


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
LOG = get_logger("hooks")

# ---------------------------------------------------------------------------
# Adaptive hook watchdog timeout state
# ---------------------------------------------------------------------------

# Module-level state for adaptive timeout: when a hook subprocess times out,
# the effective timeout is doubled (capped at 30 s) for subsequent calls in
# the same session. This adapts to slow CI machines or cold-cache environments.
_effective_watchdog_ms: int = 5000  # Will be overridden by config on first call to get_effective_watchdog_ms()
_consecutive_timeouts: int = 0
_timeout_configured: bool = False


def get_effective_watchdog_ms() -> int:
    """Return the current effective hook watchdog timeout in milliseconds.

    On first invocation, loads the [hooks].watchdog_ms value from config (or the
    default 5000 ms), with env-var TOKEN_GOAT_HOOK_WATCHDOG_MS taking precedence.
    The value is clamped to [100, 30000].

    On subsequent invocations within the same process, returns the adapted value
    (which may have been doubled due to timeouts).
    """
    global _effective_watchdog_ms, _timeout_configured

    if not _timeout_configured:
        try:
            from . import config
            _effective_watchdog_ms = config.load().hooks.watchdog_ms
            LOG.debug("hook watchdog initialized: %d ms", _effective_watchdog_ms)
        except Exception:
            _effective_watchdog_ms = 5000
            LOG.debug("hook watchdog config load failed, using default 5000 ms")
        _timeout_configured = True

    return _effective_watchdog_ms


def record_watchdog_timeout() -> None:
    """Record a hook subprocess timeout and adapt the effective timeout upward.

    When called, doubles the effective timeout (up to the 30 s cap) and logs
    the adjustment. This per-session adaptation helps recovery on slow CI
    machines or during cold-cache scenarios.

    The adaptive state is in-process memory — each fresh Python process starts
    fresh with the configured baseline.
    """
    global _effective_watchdog_ms, _consecutive_timeouts

    _consecutive_timeouts += 1
    old_ms = _effective_watchdog_ms
    _effective_watchdog_ms = min(_effective_watchdog_ms * 2, 30_000)

    LOG.warning(
        "hook subprocess timeout (attempt %d); doubling watchdog: %d ms → %d ms",
        _consecutive_timeouts,
        old_ms,
        _effective_watchdog_ms,
    )


# The most common hook response: let the harness proceed unchanged.
# Using a function (not a bare dict) keeps each call site independent — callers
# that mutate the return value won't corrupt subsequent callers.
def CONTINUE() -> HookResponse:
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


def get_hook_context(payload: HookPayload) -> tuple[str | None, str | None]:
    """Return ``(session_id, cwd)`` or ``(None, None)`` when *session_id* is absent.

    Strict variant of :func:`get_session_context`: returns ``(None, None)`` when
    ``session_id`` is missing, because a session context without a session ID is
    unusable for any cache/hint operation.  ``cwd`` is returned as-is (may be
    ``None``) when a session ID is present, so callers that need ``cwd`` can still
    distinguish "no session" from "session present but cwd unknown".

    Typical usage eliminates the three-line guard pattern that appeared in every
    hook handler::

        # Before:
        session_id, _cwd = get_session_context(payload)
        if not session_id:
            _LOG.debug("post-X: no session_id; ...")
            return CONTINUE()

        # After:
        session_id, _cwd = get_hook_context(payload)
        if session_id is None:
            return CONTINUE()

    The ``get_session_context`` call inside this helper already emits the
    DEBUG-level ``session_id absent`` log, so callers do not need to repeat it.
    """
    session_id, cwd = get_session_context(payload)
    if session_id is None:
        return None, None
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
    modules. Handles ``0`` / ``False`` (falsy non-None values) the same as ``None``.

    Args:
        value: Any value from a hook payload (session_id, cwd, tool_name, …).

    Returns:
        A sanitized string safe for use in log messages, or ``""`` if *value* is falsy.
    """
    if not value:
        return ""
    str_value = str(value)
    if not isinstance(value, str):
        LOG.debug(
            "sanitize_opt: coercing non-string payload field %s(%r) to str",
            type(value).__name__, sanitize_log_str(str_value),
        )
    return sanitize_log_str(str_value)


def bytes_to_tokens(byte_count: int) -> int:
    """Convert a byte count to an approximate token count (minimum 1).

    Uses the same ``CHARS_PER_TOKEN`` constant (3.5) as the rest of the hint
    layer.  The ``max(1, ...)`` guard ensures zero-length injections still
    record at least one token of overhead — consistent with the inline formula
    it replaces.
    """
    from .hints import CHARS_PER_TOKEN

    return max(1, int(byte_count / CHARS_PER_TOKEN))


def _is_quiet_hours(quiet_hours: str) -> bool:
    """Return True when the current local time falls within the *quiet_hours* window.

    *quiet_hours* must be a non-empty string in ``"HH:MM-HH:MM"`` 24-hour format.
    Midnight wrap-around is supported: ``"22:00-07:00"`` suppresses from 10 pm
    to 7 am (crossing midnight).  Returns False for empty / malformed strings so
    the feature is a no-op when not configured.
    """
    import datetime
    import re as _re

    if not quiet_hours:
        return False
    m = _re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", quiet_hours.strip())
    if not m:
        return False
    try:
        start_h = int(m.group(1))
        start_m = int(m.group(2))
        end_h = int(m.group(3))
        end_m = int(m.group(4))
        hour_valid = 0 <= start_h < 24 and 0 <= end_h < 24
        minute_valid = 0 <= start_m < 60 and 0 <= end_m < 60
        if not (hour_valid and minute_valid):
            return False
    except ValueError:
        return False

    now = datetime.datetime.now()
    current_minutes = now.hour * 60 + now.minute
    window_start = start_h * 60 + start_m
    window_end = end_h * 60 + end_m

    if window_start <= window_end:
        # Normal range (same day): e.g. 09:00-17:00
        return window_start <= current_minutes < window_end
    # Midnight-crossing range: e.g. 22:00-07:00
    return current_minutes >= window_start or current_minutes < window_end


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
                subclass). Its string value is measured to account for the
                injection byte cost. Accepts ``object`` so callers that pass a
                typed hint subclass do not need a cast.
        detail: Short string stored in the stat row for triage (path, pattern,
                URL, or command preview).  Callers are responsible for
                sanitising it before passing — use :func:`sanitize_log_str`.
    """
    from . import config, db

    cfg = config.load()

    # Item 16: quiet-hours suppression.  When the current local time falls
    # inside the configured quiet window, skip the stat-record (the hint was
    # already suppressed upstream; this just avoids the SQLite write overhead).
    if _is_quiet_hours(cfg.hints.quiet_hours):
        return

    realized_tokens: int = getattr(hint, "tokens_saved", 0)
    injection_text = str(hint)
    injection_bytes: int = len(injection_text.encode("utf-8"))
    injection_cost_tokens = bytes_to_tokens(injection_bytes)

    # Skip writing stat rows for zero-saving hints (large-file nudges, lockfile
    # hints) unless explicitly enabled via config. These hint types don't realize
    # any token savings and are purely advisory; recording them adds SQLite write
    # overhead (~0.5–1 ms each) on the hot pre-read path without actionable signal.
    # Session-level hint count is tracked separately in session.hints_emitted.
    if realized_tokens == 0 and injection_bytes == 0 and not cfg.stats.record_zero_savings:
        return

    # Item 15: Skip writing the overhead row when injection_bytes < 32 and tokens_saved > 0.
    # Small injection hints (e.g., "you already read this file" nudges) have
    # negligible overhead cost; skipping their overhead row measurement removes
    # ~30% of SQLite write traffic on the hot pre-read path without losing
    # material insight. The saving row is still written when tokens_saved > 0,
    # since that represents real value captured.
    if injection_bytes < 32 and realized_tokens > 0:
        db.record_stat(
            None,
            kind,
            bytes_saved=realized_tokens * 4,
            tokens_saved=realized_tokens,
            detail=detail,
        )
        return

    # For zero savings, skip rows unless record_zero_savings config is enabled
    if realized_tokens == 0 and not cfg.stats.record_zero_savings:
        return

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


def record_cached_stat(kind: str, detail: str, bytes_saved: int = 0) -> None:
    """Record a stat row for a cache-capture event (bash/web/skill).

    All three post-capture handlers (``hooks_read``, ``hooks_fetch``,
    ``hooks_skill``) call this helper after storing output to disk.

    ``bytes_saved`` should be the byte length of the content that was stored
    (and therefore no longer needs to be re-read or re-run by the agent).
    Tokens are estimated at 4 bytes per token.  Callers that do not know the
    size may omit the argument, which records zero savings (backwards-compatible
    behaviour preserved for ``glob_result_cache_hit`` and similar events).

    Args:
        kind:        Stat kind string (e.g. ``"bash_output_cached"``,
                     ``"web_output_cached"``, ``"skill_cached"``).
        detail:      Short sanitised label for triage (command preview, URL,
                     skill name).  Callers must sanitise with
                     :func:`sanitize_log_str` before passing.
        bytes_saved: Byte length of the cached content.  Defaults to 0.
    """
    _bs = max(0, bytes_saved)
    tokens = max(1, _bs // 3 + 1) if _bs > 0 else 0
    try:
        from . import db

        db.record_stat(None, kind, bytes_saved=max(0, bytes_saved), tokens_saved=tokens, detail=detail)
    except Exception:
        LOG.debug("record_cached_stat(%s): stat record failed", kind, exc_info=True)


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


def load_session_safe(session_id: str) -> SessionCache | None:
    """Load the session cache, returning None on any error (fail-soft).

    Centralises the ``try: session.load(session_id) except ...: return None``
    pattern that appears in 6+ places across hook_read.py, hooks_edit.py,
    hints.py, and other modules.  Avoids repeated error handling boilerplate
    and ensures consistent fail-soft behaviour — any OSError, ValueError, or
    JSON corruption silently returns None so hooks never abort on cache issues.

    Args:
        session_id: The session ID string (from the hook payload).

    Returns:
        The loaded :class:`session.SessionCache` on success, or ``None`` if the
        session cannot be loaded for any reason.
    """
    from . import session

    try:
        return session.load(session_id)
    except (OSError, ValueError):
        return None
    except Exception:
        return None


def update_session(session_id: str, fn: Callable[[SessionCache], None]) -> bool:
    """Load session cache, call a mutation function, and save — fail-soft pattern.

    Centralises the load→mutate→save pattern that appears across multiple hook
    handlers (hooks_edit.py, hooks_read.py, hooks_common.py).  The pattern is:

    .. code-block:: python

        cache = load_session_safe(session_id)
        if cache is not None:
            fn(cache)  # mutate in place
            session.save(cache)

    This helper eliminates the boilerplate and ensures consistent error handling
    across call sites.  Failures at any step are logged at debug level and
    swallowed (fail-soft) so the hook never aborts on cache issues.

    Args:
        session_id: The session ID string (from the hook payload).
        fn:         Callable that receives the loaded cache and mutates it in place.
                    Called only if the cache loads successfully; signature is
                    ``fn(cache: SessionCache) -> None``.  Exceptions raised by
                    *fn* are caught and logged.

    Returns:
        ``True`` if the cache was loaded, mutated, and saved successfully.
        ``False`` if the load failed or *fn* raised an exception.
    """
    from . import session

    cache = load_session_safe(session_id)
    if cache is None:
        return False

    try:
        fn(cache)
    except Exception:
        LOG.debug("update_session: mutation function failed", exc_info=True)
        return False

    try:
        session.save(cache)
        return True
    except Exception:
        LOG.debug("update_session: save failed", exc_info=True)
        return False


def _coerce_content_array(items: list[object]) -> str:
    """Concatenate text from an MCP-style ``content`` array.

    Each item is either a ``{"type": "text", "text": "..."}`` dict or a bare
    string.  Non-text items are silently skipped.
    """
    parts: list[str] = []
    for item in items:
        if isinstance(item, dict):
            if item.get("type") in ("text", None):
                txt: str | None = item.get("text")  # type: ignore[assignment]  # dict.get() returns Any; annotating narrower than Any requires this suppression
            else:
                txt = None
            if isinstance(txt, str):
                parts.append(txt)
        elif isinstance(item, str):
            parts.append(item)
    return "".join(parts)


def extract_tool_response_text(
    payload: HookPayload,
    *,
    text_keys: tuple[str, ...] = ("output", "text", "body", "content", "response"),
) -> str:
    """Extract the primary text body from a PostToolUse payload.

    Handles every shape the harness and MCP adapters produce:

    1. ``payload["tool_response"]`` is a **str** — returned as-is.
    2. ``payload["tool_response"]`` is a **list** — treated as an MCP
       ``content`` array of ``{"type": "text", "text": "..."}`` items.
    3. ``payload["tool_response"]`` is a **dict** — probed at each key in
       *text_keys* in order; the first str value wins.  If a key yields a
       list it is treated as an MCP content array.
    4. Fallbacks: ``tool_result``, ``response`` at the top level (older
       harness builds that promote the result up one level).

    Returns ``""`` when nothing decodable is present — callers that need a
    minimum-size guard compare ``len(result) >= min_bytes`` themselves.

    This helper eliminates the near-identical walking logic that previously
    lived in ``hooks_read._extract_bash_response``,
    ``hooks_fetch._extract_web_response``, and
    ``hooks_skill._extract_skill_body``.
    """
    raw_resp: object = payload.get("tool_response") if isinstance(payload, dict) else None
    if raw_resp is None and isinstance(payload, dict):
        for key in ("tool_result", "response"):
            if key in payload:
                candidate = payload[key]
                if candidate is not None:
                    raw_resp = candidate
                    break

    if isinstance(raw_resp, str):
        return raw_resp

    if isinstance(raw_resp, list):
        return _coerce_content_array(raw_resp)

    if isinstance(raw_resp, dict):
        for key in text_keys:
            val = raw_resp.get(key)
            if isinstance(val, str):
                return val
            if isinstance(val, list):
                result = _coerce_content_array(val)
                if result:
                    return result

    return ""


class _DedupeHintBuilder(Protocol):
    """Callable that returns a hint object (with ``tokens_saved``) or ``None``."""

    def __call__(self, session_id: str, cache: object) -> object | None: ...


def emit_if_new_hint(
    cache: object | None,
    fingerprint: str,
    hint_text: str,
    stat_key: str,
    context_parts: list[str],
) -> bool:
    """Append *hint_text* to *context_parts* and record metrics iff *fingerprint* is new.

    Centralises the three-step dedup→emit pattern used across hooks_read.py,
    hooks_grep_symbol_redirect, and hints.py:

    1. Check if fingerprint already seen via :meth:`cache.has_hint_fingerprint`
    2. Record it via :meth:`cache.mark_hint_seen`
    3. Increment the per-type counter via :meth:`cache.record_hint_emitted`

    Returns True when the hint was appended, False when suppressed or cache is None.

    This helper is intentionally simpler than ``_emit_dedup_budgeted_hint`` in
    hooks_read.py — it has no budget checking, verbose-stub fallback, or stat recording.
    Use it for lightweight one-shot hints (surgical suggestions, git history, symbol
    redirects) that don't compete for session-wide quota.  For heavyweight hints with
    budget constraints (index-only, structured-file), use ``_emit_dedup_budgeted_hint``
    instead.

    Args:
        cache:          Session cache or ``None`` (returns False if ``None``).
        fingerprint:    Unique key for this hint — dedup is skipped when the
                        fingerprint is already in ``cache.hints_seen``.
        hint_text:      Text to append to *context_parts* when new.
        stat_key:       Stat kind string for ``record_hint_emitted``, e.g.
                        ``"surgical_read_suggestion"`` or ``"git_history"``.
        context_parts:  List to append *hint_text* to; mutated in place.

    Returns:
        ``True`` when the hint was appended, ``False`` when suppressed or cache is None.
    """
    if cache is None:
        return False
    try:
        has_hint_fp = cache.has_hint_fingerprint(fingerprint)  # type: ignore[attr-defined]  # cache typed as object by load_session_safe(); SessionCache has this method at runtime
    except (AttributeError, TypeError):
        return False

    if has_hint_fp:
        return False

    context_parts.append(hint_text)
    try:
        cache.mark_hint_seen(fingerprint)  # type: ignore[attr-defined]  # cache typed as object; SessionCache method, guarded by try/except
        cache.record_hint_emitted(stat_key)  # type: ignore[attr-defined]  # same
    except (AttributeError, TypeError):
        pass
    return True


def run_dedup_hint(
    payload: HookPayload,
    *,
    builder: _DedupeHintBuilder,
    stat_kind: str,
    detail: str,
    log_label: str | None = None,
) -> HookResponse | None:
    """Shared skeleton for the four pre-hook dedup handlers.

    Loads the session cache, calls *builder* to produce a hint, records the
    stat pair, logs, and returns a :func:`pre_tool_use_with_context` response —
    or ``None`` when no hint is available so the caller can fall through to
    ``CONTINUE``.

    Args:
        payload:    The raw hook payload dict (must contain ``session_id``).
        builder:    Callable ``(session_id, cache) -> hint | None``.  Each
                    dedup handler closes over its tool-specific arguments
                    (command/pattern/url) and passes a two-arg lambda here.
        stat_kind:  Base stat kind string, e.g. ``"bash_dedup_hint"``.  The
                    overhead counter is recorded under ``stat_kind + "_overhead"``
                    by :func:`record_hint_stat_pair`.
        detail:     Short string stored in the stat row detail column.  Callers
                    should sanitize via :func:`sanitize_log_str` before passing.
        log_label:  Optional prefix for the ``LOG.info`` call
                    (e.g. ``"pre-read"``).  Defaults to ``"pre-hook"``.

    Returns:
        A ``HookResponse`` with ``additionalContext`` set to the hint text, or
        ``None`` when the session cannot be loaded or the builder returns ``None``.
    """
    from . import session

    session_id, _cwd = get_session_context(payload)
    if not session_id:
        return None

    cache = load_session_safe(session_id)
    if cache is None:
        return None

    hint = builder(session_id, cache)

    # Persist mutations made by the builder (bash_dedup_emitted_ids, budget counters,
    # hints_seen, hints_suppressed_by_type, etc.) before the hook process exits.
    # Without this, every field the builder touched is silently discarded at process
    # exit.  Save unconditionally: the suppression path (hint is None) also mutates
    # hints_suppressed_by_type and those counters must survive the process boundary.
    session.save(cache)

    if hint is None:
        return None

    record_hint_stat_pair(stat_kind, hint, detail)
    LOG.info(
        "%s: %s injected (tokens_saved=%d)",
        log_label or "pre-hook",
        stat_kind,
        getattr(hint, "tokens_saved", 0),
    )
    return pre_tool_use_with_context(str(hint))
