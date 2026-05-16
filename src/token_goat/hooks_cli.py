"""Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}."""
from __future__ import annotations

__all__ = [
    "EVENTS",
    "HookPayload",
    "HookResponse",
    "denormalize_response",
    "dispatch",
    "emit",
    "fail_soft",
    "normalize_payload",
    "pre_compact",
    "read_payload",
    "safe_run",
]

import contextlib
import functools
import json
import logging
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any, ParamSpec, TypedDict, TypeVar, cast

from . import hooks_edit, hooks_fetch, hooks_read, hooks_session, paths
from .hooks_common import CONTINUE, HookResponse


class HookPayload(TypedDict, total=False):
    """Base hook payload structure (optional fields depend on hook event)."""

    session_id: str
    cwd: str
    turn_id: str
    tool_name: str
    tool_input: dict[str, Any]
    file_path: str
    file_content: str
    line_number: int

_LOG = logging.getLogger("token_goat.hooks")

# Cached log-path date string — invalidated when the calendar date rolls over.
# Avoids a datetime.now() call on every hook dispatch (hooks fire on every
# Read/Write/Edit/Bash tool use; the date string changes at most once a day).
_log_date_cached: str = ""


def _setup_logging() -> None:
    """Idempotent: daily-rotated log file in logs/.

    In sandboxed environments (e.g. Codex unelevated) the log directory may be
    read-only or inaccessible.  Fall back to a NullHandler so the hook still
    runs and returns ``{"continue": true}`` instead of failing on logger setup.

    The log-path date string is cached in ``_log_date_cached`` and only
    recomputed when the calendar date actually changes, avoiding a
    ``datetime.now()`` call on every hook dispatch.
    """
    global _log_date_cached  # noqa: PLW0603
    today = datetime.now().strftime("%Y-%m-%d")
    if _LOG.handlers and today == _log_date_cached:
        return
    # Either first call or the day has rolled over — (re-)attach the handler.
    _LOG.handlers.clear()
    _log_date_cached = today
    try:
        paths.ensure_dirs()
        log_path = paths.logs_dir() / f"{today}.log"
        paths.roll_log_if_oversized(log_path, paths.LOG_FILE_MAX_BYTES)
        handler: logging.Handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    except OSError:
        handler = logging.NullHandler()
    _LOG.addHandler(handler)
    _LOG.setLevel(logging.INFO)


def normalize_payload(payload: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate harness-specific payloads to token-goat's internal format.

    Codex sends snake_case keys for some fields and uses 'turn_id'; Claude uses
    camelCase. token-goat handlers work with the Claude shape internally.
    Most fields (session_id, cwd, tool_name, tool_input) are already identical
    between the two harnesses — nothing needs remapping in the inbound direction.
    Output normalization (camelCase → snake_case) is handled by denormalize_response.
    """
    # Both harnesses share the same inbound field names; no transformation needed.
    return payload


def _translate_hso_to_codex(hso: dict[str, Any]) -> dict[str, Any]:
    """Convert camelCase hookSpecificOutput keys to snake_case for Codex wire format."""
    camel_to_snake = {
        "additionalContext": "additional_context",
        "updatedInput": "updated_input",
        "permissionDecision": "permission_decision",
        "permissionDecisionReason": "permission_decision_reason",
        "hookEventName": "hook_event_name",
    }
    translated = dict(hso)
    for camel_key, snake_key in camel_to_snake.items():
        if camel_key in translated:
            translated[snake_key] = translated.pop(camel_key)
    return translated


def denormalize_response(response: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate token-goat's internal response format to harness-specific wire format.

    Claude: hookSpecificOutput.{additionalContext, updatedInput, permissionDecision, ...}
    Codex:  hookSpecificOutput.{additional_context, updated_input, permission_decision, ...}

    Accepts ``dict[str, Any]`` (the enriched result from ``dispatch`` which adds
    ``_tg_elapsed_ms``) rather than the narrower ``HookResponse`` TypedDict, so
    the diagnostic key is preserved in the output.
    """
    if harness != "codex":
        return response

    hso = response.get("hookSpecificOutput")
    if not isinstance(hso, dict):
        return response

    result = dict(response)
    result["hookSpecificOutput"] = _translate_hso_to_codex(hso)
    return result


_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024  # 10 MB — guard against runaway harness output

# Hook dispatch timing thresholds (milliseconds).
# Hooks slower than HOOK_SLOW_MS are logged at WARNING level; hooks between
# HOOK_MODERATE_MS and HOOK_SLOW_MS are logged at DEBUG with a "moderate" tag.
_HOOK_SLOW_MS = 500
_HOOK_MODERATE_MS = 100


def read_payload(input_file: Path | None = None) -> dict[str, Any]:
    """Read JSON payload from stdin (or a file, for testing).

    Always returns a dict. Coerces non-dict JSON (``null``, lists, scalars)
    to ``{}`` so handlers can safely call ``payload.get(...)``.
    Catches JSON decode errors and returns empty dict instead of crashing.

    Enforces a 10 MB size cap on the raw input to prevent a malicious or
    runaway harness from causing an OOM condition by sending an unbounded payload.
    """
    try:
        if input_file is not None:
            raw = input_file.read_text(encoding="utf-8")
            if len(raw.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
                _LOG.warning(
                    "hook payload from file too large (%d bytes > %d limit); ignoring",
                    len(raw.encode("utf-8")),
                    _MAX_PAYLOAD_BYTES,
                )
                return {}
            data = json.loads(raw)
        else:
            raw = sys.stdin.read(_MAX_PAYLOAD_BYTES + 1)
            if len(raw) > _MAX_PAYLOAD_BYTES:
                _LOG.warning(
                    "hook payload from stdin too large (> %d bytes); ignoring",
                    _MAX_PAYLOAD_BYTES,
                )
                return {}
            if not raw.strip():
                return {}
            data = json.loads(raw)
    except json.JSONDecodeError as e:
        _LOG.warning("failed to decode JSON payload: %s", e)
        return {}
    except OSError as e:
        _LOG.warning("failed to read payload from file: %s", e)
        return {}
    return data if isinstance(data, dict) else {}


def emit(result: dict[str, Any]) -> None:
    """Write the hook result to stdout as JSON, swallowing every output error.

    Forces UTF-8 on stdout (Windows defaults to cp1252 which can't encode → and
    other punctuation we use in hints). Never raises: a broken pipe, missing
    buffer, or closed stream simply ends the call without surfacing an error
    to the harness, which would otherwise see the hook as failed.
    """
    payload = json.dumps(result, ensure_ascii=False)
    # Preferred: raw bytes through .buffer so UTF-8 is correct on Windows.
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        with contextlib.suppress(Exception):
            sys.stdout.buffer.flush()
        return
    except Exception as e:  # noqa: BLE001
        _LOG.debug("emit: binary write failed, trying text fallback: %s", e)
    # Fallback: text-mode write.
    with contextlib.suppress(Exception):
        sys.stdout.write(payload)
        with contextlib.suppress(Exception):
            sys.stdout.flush()


def safe_run(event: str, input_file: Path | None = None, harness: str = "claude") -> None:
    """Run a hook event end-to-end with absolute fail-soft semantics.

    Catches every exception (including BaseException) so the process always
    exits with code 0, no matter what. On failure we still emit a valid
    ``{"continue": true}`` response so the harness has something to parse,
    and we log a one-line diagnostic to stderr so the harness's
    hook-error display has the cause if you go looking for it.
    """
    result: dict[str, Any] = dict(CONTINUE())
    try:
        raw = read_payload(input_file)
        payload = normalize_payload(raw, harness)
        dispatched = dispatch(event, payload)
        result = dict(denormalize_response(dispatched, harness))
    except BaseException as exc:  # noqa: BLE001 — bulletproof
        msg = f"token-goat hook {event} failed: {type(exc).__name__}: {exc}"
        with contextlib.suppress(Exception):
            print(msg, file=sys.stderr)
        with contextlib.suppress(Exception):
            # Attempt to persist to log file even if normal setup failed.
            _setup_logging()
            _LOG.error("%s", msg, exc_info=True)
        result = dict(CONTINUE())
    emit(result)


_P = ParamSpec("_P")
_HookHandler = TypeVar("_HookHandler", bound=Callable[[dict[str, Any]], HookResponse])

# Type alias for the wrapped handler signature — avoids repeating the long form.
_WrappedHandler = Callable[[dict[str, Any]], HookResponse]


def fail_soft(handler: _HookHandler) -> _HookHandler:
    """Decorator: wrap hook handler to never raise or crash the harness.

    CRITICAL INVARIANT: A broken token-goat hook must NEVER interrupt Claude Code's work.
    This decorator guarantees:
      1. Returns {'continue': True} even if handler raises/crashes.
      2. Logs exception without surfacing it to the caller.
      3. Exits with code 0 (no error signal to harness).

    Used on all hook dispatchers to ensure harness resilience.
    """
    @functools.wraps(handler)
    def wrapper(payload: dict[str, Any]) -> HookResponse:
        """Invoke *handler* and return its result, suppressing all exceptions.

        On any unhandled exception: logs the crash at ERROR level (with handler
        name, session ID, and CWD for triage), then returns a safe
        ``{"continue": True}`` response so the harness is never blocked.
        """
        try:
            return handler(payload)
        except Exception as exc:  # noqa: BLE001 — fail-soft is the entire point
            payload_dict = payload if isinstance(payload, dict) else {}
            session_id: str = payload_dict.get("session_id", "")
            cwd: str = payload_dict.get("cwd", "")
            session_tag = f" session={session_id[:16]}" if session_id else ""
            cwd_tag = f" cwd={cwd}" if cwd else ""
            handler_name = getattr(handler, "__name__", repr(handler))
            err_summary = f"{type(exc).__name__}: {exc}"
            with contextlib.suppress(Exception):
                _LOG.exception(
                    "hook handler crashed: handler=%s%s%s error=%s",
                    handler_name,
                    session_tag,
                    cwd_tag,
                    err_summary,
                )
            # Return a safe CONTINUE-shaped response with diagnostic fields attached.
            err_response: HookResponse = {
                "continue": True,
                "_tg_error": err_summary,
                "_tg_handler": handler_name,
            }
            return err_response

    # cast is correct here: functools.wraps preserves the signature but Python's
    # type system cannot express "same callable type with wrapped body", so we
    # assert the identity to satisfy _HookHandler at call sites.
    return cast(_HookHandler, wrapper)

session_start = fail_soft(hooks_session.session_start)
pre_read = fail_soft(hooks_read.pre_read)
pre_fetch = fail_soft(hooks_fetch.pre_fetch)
post_edit = fail_soft(hooks_edit.post_edit)
post_read = fail_soft(hooks_read.post_read)


# --- dispatcher entry point used by cli.py ---

@fail_soft
def pre_compact(payload: dict[str, Any]) -> HookResponse:
    """PreCompact hook: inject a session manifest as systemMessage before compaction.

    The compaction LLM receives the manifest in its context and includes it in
    the summary, so edited files and accessed symbols survive the compaction.
    Configurable via config.toml [compact_assist] or TOKEN_GOAT_COMPACT_ASSIST=0.
    """
    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415

    cfg = config_mod.load().compact_assist
    if not cfg.enabled:
        return CONTINUE()

    trigger_raw = payload.get("trigger", "manual")
    trigger = str(trigger_raw) if trigger_raw is not None else "manual"
    if not cfg.triggers or trigger not in cfg.triggers:
        _LOG.info("pre-compact: skipping (trigger=%s not in %s)", trigger, cfg.triggers)
        return CONTINUE()

    session_id = payload.get("session_id")
    if not session_id:
        return CONTINUE()

    from . import session as session_mod  # noqa: PLC0415

    try:
        session_mod.validate_session_id(session_id)
    except ValueError as exc:
        _LOG.warning("pre-compact: invalid session_id rejected: %s", exc)
        return CONTINUE()

    n_events = compact_mod.event_count(session_id)
    if n_events < cfg.min_events:
        _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events)
        return CONTINUE()

    manifest = compact_mod.build_manifest(session_id, max_tokens=cfg.max_manifest_tokens)
    if not manifest:
        return CONTINUE()

    _LOG.info(
        "pre-compact: injecting manifest (%d chars, trigger=%s, events=%d)",
        len(manifest), trigger, n_events,
    )
    return {"continue": True, "systemMessage": manifest}


EVENTS: dict[str, Callable[[dict[str, Any]], HookResponse]] = {
    "session-start": session_start,
    "pre-read": pre_read,
    "pre-fetch": pre_fetch,
    "post-edit": post_edit,
    "post-read": post_read,
    "pre-compact": pre_compact,
}


def dispatch(event: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a hook event. Always returns at minimum {'continue': True}.

    The return type is ``dict[str, Any]`` rather than ``HookResponse`` because
    this function appends the ``_tg_elapsed_ms`` diagnostic key, which is not
    part of the ``HookResponse`` TypedDict schema.  Callers that need to pass
    the result to ``emit()`` can do so directly since ``emit`` accepts
    ``dict[str, Any]``.
    """
    _setup_logging()
    handler = EVENTS.get(event)
    if handler is None:
        _LOG.warning("unknown hook event: %s", event)
        return dict(CONTINUE())
    _LOG.debug("hook %s started", event)
    t0 = time.monotonic()
    result: dict[str, Any] = dict(handler(payload))
    elapsed_ms = (time.monotonic() - t0) * 1000
    if elapsed_ms >= _HOOK_SLOW_MS:
        _LOG.warning("hook %s slow: %.1fms (check for blockage or I/O delays)", event, elapsed_ms)
    else:
        speed_tag = "moderate" if elapsed_ms >= _HOOK_MODERATE_MS else "fast"
        _LOG.debug("hook %s completed in %.1fms (%s)", event, elapsed_ms, speed_tag)
    result["_tg_elapsed_ms"] = round(elapsed_ms, 2)
    return result
