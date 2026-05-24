"""Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}."""
from __future__ import annotations

__all__ = [
    "EVENTS",
    "Harness",
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
from typing import Literal, ParamSpec, TypeVar, cast

from . import paths
from .hooks_common import CONTINUE, HookPayload, HookResponse, sanitize_log_str
from .util import get_logger

#: Valid harness identifiers used by :func:`normalize_payload`, :func:`denormalize_response`,
#: and :func:`safe_run`.  Defined as a ``Literal`` so callers get a type error on
#: an unrecognised harness name rather than silently applying the Claude path.
Harness = Literal["claude", "codex"]

_LOG = get_logger("hooks")

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
        handler: logging.Handler = paths.open_log_file(log_path)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    except OSError:
        handler = logging.NullHandler()
    _LOG.addHandler(handler)
    _LOG.setLevel(logging.INFO)


def normalize_payload(payload: HookPayload, harness: Harness = "claude") -> HookPayload:
    """Translate harness-specific payloads to token-goat's internal format.

    Codex sends snake_case keys for some fields and uses 'turn_id'; Claude uses
    camelCase. token-goat handlers work with the Claude shape internally.
    Most fields (session_id, cwd, tool_name, tool_input) are already identical
    between the two harnesses — nothing needs remapping in the inbound direction.
    Output normalization (camelCase → snake_case) is handled by denormalize_response.
    """
    # Both harnesses share the same inbound field names; no transformation needed.
    return payload


#: Mapping of camelCase ``hookSpecificOutput`` keys to their Codex snake_case equivalents.
#: Keyed by the Claude (outbound) name; value is the Codex wire-format name.
_HSO_CAMEL_TO_SNAKE: dict[str, str] = {
    "additionalContext": "additional_context",
    "updatedInput": "updated_input",
    "permissionDecision": "permission_decision",
    "permissionDecisionReason": "permission_decision_reason",
    "hookEventName": "hook_event_name",
}


def _translate_hso_to_codex(hso: dict[str, object]) -> dict[str, object]:
    """Convert camelCase hookSpecificOutput keys to snake_case for Codex wire format."""
    translated = dict(hso)
    for camel_key, snake_key in _HSO_CAMEL_TO_SNAKE.items():
        if camel_key in translated:
            translated[snake_key] = translated.pop(camel_key)
    return translated


def denormalize_response(response: dict[str, object], harness: Harness = "claude") -> dict[str, object]:
    """Translate token-goat's internal response format to harness-specific wire format.

    Claude: hookSpecificOutput.{additionalContext, updatedInput, permissionDecision, ...}
    Codex:  hookSpecificOutput.{additional_context, updated_input, permission_decision, ...}

    Accepts ``dict[str, object]`` (the enriched result from ``dispatch`` which adds
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


def read_payload(input_file: Path | None = None) -> HookPayload:
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
            # Encode to UTF-8 once and reuse the bytes object for both the size
            # check and the warning log so we don't encode twice.
            raw_bytes = raw.encode("utf-8")
            if len(raw_bytes) > _MAX_PAYLOAD_BYTES:
                _LOG.warning(
                    "hook payload from file too large (%d bytes > %d limit); ignoring",
                    len(raw_bytes),
                    _MAX_PAYLOAD_BYTES,
                )
                return {}
            data = json.loads(raw)
        else:
            # Read one byte past the limit so we can detect oversized payloads
            # without reading the entire stream into memory when it's huge.
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
    return cast("HookPayload", data) if isinstance(data, dict) else HookPayload()


def emit(result: dict[str, object]) -> None:
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


def safe_run(event: str, input_file: Path | None = None, harness: Harness = "claude") -> None:
    """Run a hook event end-to-end with absolute fail-soft semantics.

    Catches every exception (including BaseException) so the process always
    exits with code 0, no matter what. On failure we still emit a valid
    ``{"continue": true}`` response so the harness has something to parse,
    and we log a one-line diagnostic to stderr so the harness's
    hook-error display has the cause if you go looking for it.
    """
    result: dict[str, object] = dict(CONTINUE())
    try:
        raw = read_payload(input_file)
        payload = normalize_payload(raw, harness)
        dispatched = dispatch(event, payload)
    except (KeyboardInterrupt, SystemExit):
        # Process-control signals must propagate so the harness can terminate
        # cleanly (e.g. Ctrl+C, or sys.exit() from an internal subprocess).
        raise
    except BaseException as exc:  # noqa: BLE001 — bulletproof
        msg = f"token-goat hook {event} failed: {type(exc).__name__}: {exc}"
        with contextlib.suppress(Exception):
            print(msg, file=sys.stderr)
        with contextlib.suppress(Exception):
            # Attempt to persist to log file even if normal setup failed.
            _setup_logging()
            _LOG.error("%s", msg, exc_info=True)
        emit(result)
        return
    else:
        # Dispatch succeeded — attempt output translation.  A bug in
        # denormalize_response (e.g. a future field that triggers TypeError in
        # _translate_hso_to_codex) must not discard the real dispatch output.
        # If translation fails, emit the un-denormalized dict: the harness sees
        # unexpected keys and ignores them — still better than bare CONTINUE.
        try:
            result = dict(denormalize_response(dispatched, harness))
        except Exception as _denorm_exc:  # noqa: BLE001
            _LOG.warning(
                "denormalize_response failed for %s (%s): %s — emitting raw dispatch output",
                event,
                harness,
                _denorm_exc,
            )
            result = dict(dispatched)
    emit(result)


_P = ParamSpec("_P")
_HookHandler = TypeVar("_HookHandler", bound=Callable[[HookPayload], HookResponse])

# Type alias for the wrapped handler signature — avoids repeating the long form.
_WrappedHandler = Callable[[HookPayload], HookResponse]


def _build_handler_log_tags(payload: HookPayload) -> tuple[str, str]:
    """Extract sanitized session and cwd log tags from a hook payload.

    Sanitizes both strings against log injection (embedded newlines could forge
    fake log entries) and returns them as ``(" session=<id>", " cwd=<path>")``
    prefix strings — empty string when the field is absent.  The leading space
    means callers can concatenate them directly without a join.
    """
    payload_dict = payload if isinstance(payload, dict) else {}
    session_id: str = payload_dict.get("session_id", "")
    cwd: str = payload_dict.get("cwd", "")
    safe_session = sanitize_log_str(session_id[:16]) if session_id else ""
    safe_cwd = sanitize_log_str(cwd) if cwd else ""
    session_tag = f" session={safe_session}" if safe_session else ""
    cwd_tag = f" cwd={safe_cwd}" if safe_cwd else ""
    return session_tag, cwd_tag


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
    def wrapper(payload: HookPayload) -> HookResponse:
        """Invoke *handler* and return its result, suppressing all exceptions.

        On any unhandled exception: logs the crash at ERROR level (with handler
        name, session ID, and CWD for triage), then returns a safe
        ``{"continue": True}`` response so the harness is never blocked.
        """
        try:
            return handler(payload)
        except (KeyboardInterrupt, SystemExit):
            # User Ctrl+C and explicit sys.exit() respect Python convention —
            # let those propagate so the subprocess can terminate cleanly.
            raise
        except BaseException as exc:  # noqa: BLE001 — fail-soft is the entire point
            # Broaden from Exception → BaseException so MemoryError,
            # GeneratorExit, and other rare BaseException subclasses also
            # honour the fail-soft contract (matches safe_run above).
            handler_name = getattr(handler, "__name__", repr(handler))
            err_summary = f"{type(exc).__name__}: {exc}"
            session_tag, cwd_tag = _build_handler_log_tags(payload)
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

# Hook submodules are imported on first dispatch, not at module load time.
# Each event needs only one submodule, so a Bash tool call that triggers
# ``pre-read`` should never pay the import cost of ``hooks_session`` or
# ``hooks_fetch``.  ``_HANDLER_LOOKUP`` maps event names to
# ``(submodule_name, attribute_name)`` pairs; ``_resolve_handler`` imports the
# submodule on demand and wraps the bare handler in ``fail_soft``.  The wrapped
# handler is cached so the import is paid at most once per process.
_HANDLER_LOOKUP: dict[str, tuple[str, str]] = {
    "session-start": ("hooks_session", "session_start"),
    "pre-read": ("hooks_read", "pre_read"),
    "pre-fetch": ("hooks_fetch", "pre_fetch"),
    "post-edit": ("hooks_edit", "post_edit"),
    "post-read": ("hooks_read", "post_read"),
    "post-bash": ("hooks_read", "post_bash"),
    "post-fetch": ("hooks_fetch", "post_fetch"),
    "post-skill": ("hooks_skill", "post_skill"),
}

_HANDLER_CACHE: dict[str, Callable[[HookPayload], HookResponse]] = {}


def _resolve_handler(event: str) -> Callable[[HookPayload], HookResponse] | None:
    """Return the ``fail_soft``-wrapped handler for *event*, importing it lazily."""
    cached = _HANDLER_CACHE.get(event)
    if cached is not None:
        return cached
    lookup = _HANDLER_LOOKUP.get(event)
    if lookup is None:
        return None
    submodule_name, attr_name = lookup
    import importlib  # noqa: PLC0415

    submodule = importlib.import_module(f".{submodule_name}", package=__package__)
    bare_handler = cast(Callable[[HookPayload], HookResponse], getattr(submodule, attr_name))
    wrapped = fail_soft(bare_handler)
    _HANDLER_CACHE[event] = wrapped
    return wrapped


def __getattr__(name: str) -> object:
    """Module-level lazy attribute access for backwards-compatible exports.

    Existing code (and tests) import ``hooks_cli.session_start``,
    ``hooks_cli.pre_read``, etc. directly.  Lazy-resolve those names through
    ``_resolve_handler`` so the relevant submodule is imported only when the
    attribute is first accessed — the dispatcher path itself never reads them.
    """
    event_map = {
        "session_start": "session-start",
        "pre_read": "pre-read",
        "pre_fetch": "pre-fetch",
        "post_edit": "post-edit",
        "post_read": "post-read",
        "post_bash": "post-bash",
        "post_fetch": "post-fetch",
        "post_skill": "post-skill",
    }
    if name in event_map:
        handler = _resolve_handler(event_map[name])
        if handler is not None:
            return handler
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# --- dispatcher entry point used by cli.py ---

@fail_soft
def pre_compact(payload: HookPayload) -> HookResponse:
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
        _LOG.info("pre-compact: skipping (trigger=%s not in %s)", sanitize_log_str(trigger), cfg.triggers)
        return CONTINUE()

    session_id = payload.get("session_id")
    if not session_id:
        return CONTINUE()

    from . import session as session_mod  # noqa: PLC0415

    if session_mod.safe_load(session_id, caller="pre-compact") is None:
        return CONTINUE()

    manifest, n_events = compact_mod.build_manifest_with_count(
        session_id, max_tokens=cfg.max_manifest_tokens
    )
    if n_events < cfg.min_events:
        _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events)
        return CONTINUE()

    if not manifest:
        return CONTINUE()

    _LOG.info(
        "pre-compact: injecting manifest (%d chars, trigger=%s, events=%d)",
        len(manifest), sanitize_log_str(trigger), n_events,
    )
    return {"continue": True, "systemMessage": manifest}


def _make_lazy_proxy(event: str) -> Callable[[HookPayload], HookResponse]:
    """Return a tiny proxy that resolves and calls the real handler lazily.

    Storing these proxies in ``EVENTS`` (a plain dict) keeps the public
    ``hooks_cli.EVENTS`` interface compatible with ``mock.patch.dict`` and any
    ``EVENTS[event]`` lookup, while still deferring the submodule import until
    the *first call* of that proxy.  After the first call the resolved
    ``fail_soft``-wrapped handler is cached in ``_HANDLER_CACHE`` so subsequent
    dispatches incur only a dict lookup plus a function call.
    """
    def _proxy(payload: HookPayload) -> HookResponse:
        handler = _resolve_handler(event)
        if handler is None:
            return CONTINUE()
        return handler(payload)
    _proxy.__name__ = f"_lazy_{event.replace('-', '_')}"
    return _proxy


# ``EVENTS`` is a plain dict for backwards compatibility (mock.patch.dict, in
# tests).  Each value is a lazy proxy that imports its submodule on first call.
EVENTS: dict[str, Callable[[HookPayload], HookResponse]] = {
    "session-start": _make_lazy_proxy("session-start"),
    "pre-read": _make_lazy_proxy("pre-read"),
    "pre-fetch": _make_lazy_proxy("pre-fetch"),
    "post-edit": _make_lazy_proxy("post-edit"),
    "post-read": _make_lazy_proxy("post-read"),
    "post-bash": _make_lazy_proxy("post-bash"),
    "post-fetch": _make_lazy_proxy("post-fetch"),
    "post-skill": _make_lazy_proxy("post-skill"),
    "pre-compact": pre_compact,
}


def dispatch(event: str, payload: HookPayload) -> dict[str, object]:
    """Dispatch a hook event. Always returns at minimum {'continue': True}.

    The return type is ``dict[str, object]`` rather than ``HookResponse`` because
    this function appends the ``_tg_elapsed_ms`` diagnostic key, which is not
    part of the ``HookResponse`` TypedDict schema.  Callers that need to pass
    the result to ``emit()`` can do so directly since ``emit`` accepts
    ``dict[str, object]``.
    """
    _setup_logging()
    safe_event = sanitize_log_str(event, max_len=64)
    handler = EVENTS.get(event)
    if handler is None:
        _LOG.warning("unknown hook event: %s", safe_event)
        return dict(CONTINUE())
    _LOG.debug("hook %s started", safe_event)
    t0 = time.monotonic()
    result: dict[str, object] = dict(handler(payload))
    elapsed_ms = (time.monotonic() - t0) * 1000
    if elapsed_ms >= _HOOK_SLOW_MS:
        _LOG.warning("hook %s slow: %.1fms (check for blockage or I/O delays)", safe_event, elapsed_ms)
    else:
        speed_tag = "moderate" if elapsed_ms >= _HOOK_MODERATE_MS else "fast"
        _LOG.debug("hook %s completed in %.1fms (%s)", safe_event, elapsed_ms, speed_tag)
    result["_tg_elapsed_ms"] = round(elapsed_ms, 2)
    return result
