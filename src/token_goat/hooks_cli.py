"""Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}."""
from __future__ import annotations

__all__ = [
    "EVENTS",
    "Harness",
    "HookPayload",
    "HookResponse",
    "_SkipResult",
    "_check_compact_skip_sentinel",
    "_check_compact_skip_sentinel_detail",
    "_current_harness",
    "_current_session_counts",
    "_is_noop_session",
    "_read_sentinel_counts",
    "_write_compact_skip_sentinel",
    "denormalize_response",
    "dispatch",
    "emit",
    "fail_soft",
    "get_hook_context_remaining_ms",
    "normalize_payload",
    "pre_compact",
    "read_payload",
    "safe_run",
]

import asyncio
import contextlib
import contextvars
import functools
import json
import logging
import os
import sys
import threading
import time
import traceback
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Final, Literal, ParamSpec, TypeVar, cast

from . import paths
from .hook_registry import CANONICAL_TOOLS
from .hooks_common import CONTINUE, HookPayload, HookResponse, sanitize_log_str
from .util import configure_stdout_encoding, get_logger, json_dumps_utf8, sanitize_surrogates

if TYPE_CHECKING:
    from pathlib import Path

# Ensure UTF-8 encoding on stdout/stderr for Windows cp1252 terminals.
configure_stdout_encoding()

#: Valid harness identifiers used by :func:`normalize_payload`, :func:`denormalize_response`,
#: and :func:`safe_run`.  Defined as a ``Literal`` so callers get a type error on
#: an unrecognised harness name rather than silently applying the Claude path.
Harness = Literal["claude", "codex", "gemini"]

_LOG = get_logger("hooks")

# Cached log-path date string — invalidated when the calendar date rolls over.
# Avoids a datetime.now() call on every hook dispatch (hooks fire on every
# Read/Write/Edit/Bash tool use; the date string changes at most once a day).
_log_date_cached: str = ""

# Context-local watchdog budget tracking: stores (start_time_s, budget_ms, event_name)
# for the currently-executing hook. Used by DB layers to apply shorter timeouts
# when running inside a hook handler (where watchdog budget is limited).
# None when not inside a hook, or when the hook has not been initialized yet.
_hook_context: contextvars.ContextVar[tuple[float, int, str] | None] = contextvars.ContextVar(
    "tg_hook_context", default=None
)

# Context-local harness identifier set by safe_run before dispatching.
# Allows inner handlers to read the active harness without threading it through
# every function signature.  Defaults to "claude" so any call that bypasses
# safe_run (e.g. direct dispatch() in tests) gets sensible behaviour.
_current_harness: contextvars.ContextVar[Harness] = contextvars.ContextVar(
    "tg_current_harness", default="claude"
)


def _setup_logging() -> None:
    """Idempotent: daily-rotated log file in logs/.

    In sandboxed environments (e.g. Codex unelevated) the log directory may be
    read-only or inaccessible.  Fall back to a NullHandler so the hook still
    runs and returns ``{"continue": true}`` instead of failing on logger setup.

    The log-path date string is cached in ``_log_date_cached`` and only
    recomputed when the calendar date actually changes, avoiding a
    ``datetime.now()`` call on every hook dispatch.
    """
    global _log_date_cached
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

    Codex sends snake_case tool names (e.g. ``bash``, ``edit_file``, ``write_file``)
    where Claude uses PascalCase (``Bash``, ``Edit``, ``Write``).  Codex also uses
    ``turn_id`` instead of a message ID.  The inbound field names for ``session_id``,
    ``cwd``, and ``tool_input`` are identical between the two harnesses, so only the
    tool name needs remapping.

    Gemini CLI uses snake_case tool names (e.g. ``run_shell_command``, ``replace``) and
    may include a ``functionCallId`` field instead of ``toolUseId``.  Both fields are
    normalised to ``toolUseId`` so downstream handlers see a consistent shape.

    Output normalisation (camelCase → snake_case for Codex; ``continue``/``decision``
    for Gemini) is handled by :func:`denormalize_response`.

    Validates that the payload has a non-empty tool_name (required by all handlers).
    On invalid payload, logs a warning and returns an empty dict so handlers degrade
    gracefully (no-op with continue:true).
    """
    # Schema check: payload must be a dict with a valid tool_name.
    if not isinstance(payload, dict):
        _LOG.warning("normalize_payload: payload is not a dict; received %s", type(payload).__name__)
        return cast("HookPayload", {})

    if not payload:
        _LOG.warning("normalize_payload: payload is empty")
        return cast("HookPayload", {})

    tool_name = payload.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name.strip():
        # Non-tool lifecycle events (SessionStart, UserPromptSubmit, SubagentStop,
        # PreCompact, Stop) legitimately carry no ``tool_name``; this is the normal
        # payload shape for them, not an error.  A single session start fans out into
        # dozens of such events, so logging at WARNING produced 45+ identical noise
        # lines per SessionStart.  DEBUG keeps the signal for operators chasing a
        # genuinely malformed tool payload without spamming the log on every clean run.
        _LOG.debug(
            "normalize_payload: tool_name missing or invalid; received %s",
            repr(tool_name),
        )
        return cast("HookPayload", {})

    if harness == "codex":
        # Remap Codex snake_case tool names to token-goat PascalCase internal names.
        mapped = _CODEX_TOOL_NAME_MAP.get(tool_name)
        if mapped is None:
            # Warn at WARNING so operators can see unknown tools in logs rather than
            # having them silently pass through to handlers that may not recognise them.
            if tool_name not in _TG_KNOWN_TOOLS:
                _LOG.warning(
                    "normalize_payload: unknown Codex tool %r — passing through unrecognised",
                    tool_name,
                )
            else:
                _LOG.debug("normalize_payload: Codex tool %r already PascalCase — passing through", tool_name)
        else:
            payload = dict(payload)
            payload["tool_name"] = mapped
        payload = dict(payload)
        payload["_tg_harness"] = harness
        return cast("HookPayload", payload)

    if harness == "gemini":
        # Remap Gemini tool names to token-goat internal names.
        mapped = _GEMINI_TOOL_NAME_MAP.get(tool_name)
        if mapped is None:
            _LOG.warning(
                "normalize_payload: unknown Gemini tool %r — passing through unrecognised",
                tool_name,
            )
        else:
            payload = dict(payload)
            payload["tool_name"] = mapped
            # Remap tool_input keys for the translated tool.
            raw_input = payload.get("tool_input") or {}
            if isinstance(raw_input, dict):
                key_map = _GEMINI_INPUT_KEY_MAP.get(mapped, {})
                if key_map:
                    new_input = {}
                    for k, v in raw_input.items():
                        new_input[key_map.get(k, k)] = v
                    payload["tool_input"] = new_input
        # Gemini may send functionCallId instead of toolUseId — normalise to toolUseId.
        if "functionCallId" in payload and "toolUseId" not in payload:
            payload = dict(payload)
            payload["toolUseId"] = payload.pop("functionCallId")
        payload = dict(payload)
        payload["_tg_harness"] = harness
        return cast("HookPayload", payload)

    # Claude harness: field names already match the internal shape; no transformation needed.
    # Still stamp the harness so downstream handlers can read it without needing the ContextVar.
    payload = dict(payload)
    payload["_tg_harness"] = harness
    return cast("HookPayload", payload)


#: Mapping of camelCase ``hookSpecificOutput`` keys to their Codex snake_case equivalents.
#: NOTE: Codex 0.137.0+ uses camelCase throughout ``hookSpecificOutput``, so this
#: table is no longer applied in ``denormalize_response``.  Kept for reference.
_HSO_CAMEL_TO_SNAKE: dict[str, str] = {
    "additionalContext": "additional_context",
    "updatedInput": "updated_input",
    "permissionDecision": "permission_decision",
    "permissionDecisionReason": "permission_decision_reason",
    "hookEventName": "hook_event_name",
}


#: Canonical set of PascalCase tool names that token-goat handlers recognise.
#: Used by normalize_payload to distinguish known pass-through names (e.g. a
#: harness that already sends PascalCase) from genuinely unknown tools that
#: warrant a WARNING so operators can spot mapping gaps.
#: Source of truth: hook_registry.CANONICAL_TOOLS — imported above.
_TG_KNOWN_TOOLS: frozenset[str] = CANONICAL_TOOLS


# Codex tool name → token-goat internal tool name.
# Codex uses lowercase/snake_case names; token-goat handlers expect PascalCase.
# Keys cover the canonical Codex names plus common short aliases that some
# Codex versions emit (e.g. "edit" alongside "edit_file").
_CODEX_TOOL_NAME_MAP: dict[str, str] = {
    "bash": "Bash",
    "edit_file": "Edit",
    "edit": "Edit",
    "write_file": "Write",
    "search_files": "Grep",
    "grep": "Grep",
    "list_files": "Glob",
    "glob": "Glob",
    "web_search": "WebFetch",
}

# Gemini CLI tool name → token-goat internal tool name.
# Gemini's tool names follow snake_case; token-goat uses PascalCase.
_GEMINI_TOOL_NAME_MAP: dict[str, str] = {
    "run_shell_command": "Bash",
    "read_file": "Read",
    "read_many_files": "Read",
    "list_directory": "Read",
    "write_file": "Write",
    "replace": "Edit",
    "glob": "Glob",
    "grep_search": "Grep",
    "search_file_content": "Grep",
    "web_search": "WebFetch",
    "web_fetch": "WebFetch",
}

# Gemini tool_input key → token-goat tool_input key, per remapped tool.
# Only keys that differ between Gemini and token-goat need to appear here.
_GEMINI_INPUT_KEY_MAP: dict[str, dict[str, str]] = {
    "Read": {"path": "file_path"},
    "Write": {"path": "file_path"},
    "Edit": {"path": "file_path", "old_str": "old_string", "new_str": "new_string"},
    "Grep": {"query": "pattern"},
}


def _translate_hso_to_codex(hso: dict[str, object]) -> dict[str, object]:
    """No longer called — Codex 0.137.0+ uses camelCase in hookSpecificOutput; kept for reference."""
    translated: dict[str, object] = {}
    for key, val in hso.items():
        new_key = _HSO_CAMEL_TO_SNAKE.get(key, key)
        if isinstance(val, dict):
            translated[new_key] = _translate_hso_to_codex(val)
        else:
            translated[new_key] = val
    return translated


def _codex_hook_event_name(event: str) -> str:
    """Resolve the Codex hookEventName const (e.g. "pre-read" → "PreToolUse") from the hook registry."""
    from . import hook_registry as _reg  # lazy: avoids top-level circular-import risk
    ev = _reg._BY_NAME.get(event)
    if ev is None:
        return ""
    return ev.claude_event or ev.codex_event or ""


def denormalize_response(
    response: dict[str, object],
    harness: Harness = "claude",
    event: str = "",
) -> dict[str, object]:
    """Translate token-goat's internal response dict to the harness wire format."""
    if harness == "codex":
        # All Codex output schemas declare additionalProperties:false — _tg_* keys from dispatch() cause "hook returned invalid JSON output".
        result: dict[str, object] = {k: v for k, v in response.items() if not k.startswith("_tg_")}
        # Codex requires hookEventName as a typed const in every hookSpecificOutput shape; inject it when absent.
        hso = result.get("hookSpecificOutput")
        if isinstance(hso, dict) and "hookEventName" not in hso:
            hen = _codex_hook_event_name(event)
            if hen:
                result["hookSpecificOutput"] = {"hookEventName": hen, **hso}
        return result

    if harness == "gemini":
        out: dict[str, object] = {}
        # Map continue→decision: False→"deny", True (or absent)→"allow".
        # For SessionStart/PreCompress Gemini treats decision as advisory, but
        # emitting it is harmless and keeps the wire shape uniform.
        continue_val = response.get("continue", True)
        out["decision"] = "allow" if continue_val else "deny"
        # Gemini natively renders a top-level ``systemMessage`` (SessionStart
        # git brief, PreCompress compaction manifest). Preserve it — dropping it
        # silently discarded token-goat's entire compaction manifest and the
        # session-start orientation brief for every Gemini user.
        sysmsg = response.get("systemMessage")
        if isinstance(sysmsg, str) and sysmsg:
            out["systemMessage"] = sysmsg
        hso = response.get("hookSpecificOutput")
        if isinstance(hso, dict):
            # ``reason`` is only surfaced by Gemini on a *deny* (sent to the
            # agent as a tool error); on an allow it is advisory and ignored.
            # Context injection (session memory, post-read/skill hints) MUST
            # therefore ride ``hookSpecificOutput.additionalContext`` — Gemini's
            # native channel ("injected as the first turn" at SessionStart,
            # "appended to the tool result" at AfterTool). Flattening
            # additionalContext into ``reason`` silently dropped every hint on
            # the allow path, where token-goat emits virtually all of them.
            add_ctx = hso.get("additionalContext")
            if isinstance(add_ctx, str) and add_ctx:
                out["hookSpecificOutput"] = {"additionalContext": add_ctx}
            reason = hso.get("permissionDecisionReason")
            if reason:
                out["reason"] = reason
        # Pass through diagnostic fields for debugging.
        for k in ("_tg_elapsed_ms", "_tg_handler", "_tg_error"):
            if k in response:
                out[k] = response[k]
        return out

    return response


_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024  # 10 MB — guard against runaway harness output

# Hook dispatch timing thresholds (milliseconds).
# Hooks slower than HOOK_SLOW_MS are logged at WARNING level; hooks between
# HOOK_MODERATE_MS and HOOK_SLOW_MS are logged at DEBUG with a "moderate" tag.
_HOOK_SLOW_MS = 500
_HOOK_MODERATE_MS = 100

# Watchdog budget for a single hook handler.  Set to 4x the slow threshold so
# a "slow but legitimate" handler completes well within the budget, while a
# genuinely hung handler (deadlock, blocked I/O on a dead socket, etc.) is
# abandoned before it can stall the agent.  signal.alarm is POSIX-only and
# cannot be used here — Windows is a first-class target — so dispatch runs
# the handler in a daemon thread and stops waiting for it past the budget.
_HOOK_WATCHDOG_MS = _HOOK_SLOW_MS * 4

# Operator-tunable bounds for the watchdog budget.  100ms is a hard floor so a
# bad env value can't make every hook trip the watchdog on the first sleep; the
# 30s ceiling caps the worst-case agent stall from a wedged handler at half a
# minute.  Outside this range we clamp rather than reject so a fat-fingered
# value still produces sane behavior (fail-soft over fail-loud).
_HOOK_WATCHDOG_MS_FLOOR: Final[int] = 100
_HOOK_WATCHDOG_MS_CEIL: Final[int] = 30_000

#: Environment variable that overrides :data:`_HOOK_WATCHDOG_MS` per-invocation.
#: Read on every dispatch (cheap — ``os.environ.get`` is a dict lookup) so an
#: operator can re-tune the budget by editing settings.json without restarting
#: the agent.  Invalid/blank values silently fall back to the compiled default.
_ENV_HOOK_WATCHDOG_MS: Final[str] = "TOKEN_GOAT_HOOK_WATCHDOG_MS"


def _resolved_watchdog_ms() -> int:
    """Return the effective watchdog budget in milliseconds.

    Three-layer resolution:
      1. Env var :data:`_ENV_HOOK_WATCHDOG_MS`, clamped to
         ``[_HOOK_WATCHDOG_MS_FLOOR, _HOOK_WATCHDOG_MS_CEIL]``.
      2. Per-project config value from ``config.load().hooks.watchdog_ms``
         (has a process-level mtime cache — costs one ``os.stat`` per call).
      3. Compile-time constant :data:`_HOOK_WATCHDOG_MS` — terminal fallback
         when ``config.load()`` raises.

    Any parse failure on Layer 1 (non-numeric, negative) also falls back to
    :data:`_HOOK_WATCHDOG_MS` directly (skipping Layer 2) since bad env values
    indicate a misconfiguration, not an absent config file.
    """
    raw = os.environ.get(_ENV_HOOK_WATCHDOG_MS, "").strip()
    if not raw:
        # Layer 2: per-project config baseline before the compile-time constant.
        try:
            from .config import load as _load_cfg
            return _load_cfg().hooks.watchdog_ms
        except Exception:
            return _HOOK_WATCHDOG_MS
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return _HOOK_WATCHDOG_MS
    if parsed <= 0:
        return _HOOK_WATCHDOG_MS
    # Clamp to the operator-safe band.  We deliberately clamp rather than
    # raise: a hook firing on every tool call must not crash on a bad env
    # value, and the clamped behavior is still observable + correctable.
    if parsed < _HOOK_WATCHDOG_MS_FLOOR:
        return _HOOK_WATCHDOG_MS_FLOOR
    if parsed > _HOOK_WATCHDOG_MS_CEIL:
        return _HOOK_WATCHDOG_MS_CEIL
    return parsed


def get_hook_context_remaining_ms() -> int:
    """Return milliseconds remaining until the hook watchdog deadline.

    If called outside a hook, returns a large number (1000000 ms).
    If called inside a hook and the deadline has passed, returns 0.
    Useful for DB layers to apply shorter timeouts when running hot against
    the watchdog budget.
    """
    ctx = _hook_context.get()
    if ctx is None:
        return 1_000_000
    start_time_s, budget_ms, _event_name = ctx
    elapsed_ms = (time.monotonic() - start_time_s) * 1000
    remaining = max(0, budget_ms - elapsed_ms)
    return int(remaining)


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
    except UnicodeDecodeError as e:
        # Raised by read_text(encoding="utf-8") on files containing non-UTF-8
        # bytes (e.g. a binary file accidentally sent as the hook payload, or a
        # file written in a legacy encoding).  Return {} so the dispatcher can
        # fall through to the CONTINUE safety net rather than crashing.
        _LOG.warning("hook payload file contains non-UTF-8 bytes: %s", e)
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
    try:
        payload = json_dumps_utf8(result)
    except (TypeError, ValueError):
        # Non-serializable value in result (e.g. datetime, set, bytes from a
        # handler bug).  Fall back to default=str so the harness always receives
        # valid JSON rather than a silent empty response.
        payload = json_dumps_utf8(result, default=str)
    # Preferred: raw bytes through .buffer so UTF-8 is correct on Windows.
    try:
        sys.stdout.buffer.write(payload.encode("utf-8"))
        with contextlib.suppress(Exception):
            sys.stdout.buffer.flush()
        return
    except Exception as e:
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
    _current_harness.set(harness)
    try:
        raw = read_payload(input_file)
        payload = normalize_payload(raw, harness)
        dispatched = dispatch(event, payload)
    except (KeyboardInterrupt, SystemExit):
        # Process-control signals must propagate so the harness can terminate
        # cleanly (e.g. Ctrl+C, or sys.exit() from an internal subprocess).
        raise
    except BaseException as exc:
        msg = f"token-goat hook {event} failed: {type(exc).__name__}: {exc}"
        # Sanitize surrogates at the message boundary so that every downstream
        # consumer (stderr print, logger, crash-sink write) receives valid UTF-8.
        # On Windows, a path with non-UTF-8 bytes produces surrogate-escape chars
        # in str(exc); without sanitization the print() or file write would raise
        # UnicodeEncodeError and the crash would be silently lost.
        safe_msg = sanitize_surrogates(msg)
        with contextlib.suppress(Exception):
            print(safe_msg, file=sys.stderr)
        with contextlib.suppress(Exception):
            # Attempt to persist to log file even if normal setup failed.
            _setup_logging()
            _LOG.error("%s", safe_msg, exc_info=True)
        # Dedicated crash sink: append msg + traceback to hooks-stderr.log so
        # hook crashes are not silently lost when the harness redirects stderr
        # to nul:/dev/null.  This must never raise — any write failure is
        # swallowed so the fail-soft contract (always returns continue:true)
        # is preserved.
        try:
            sink = paths.hooks_stderr_log_path()
            paths.ensure_dir(sink.parent)
            paths.roll_log_if_oversized(sink, paths.HOOKS_STDERR_LOG_MAX_BYTES)
            tb = traceback.format_exc()
            # safe_msg was sanitized above; only tb needs sanitization here.
            safe_tb = sanitize_surrogates(tb)
            # Prepend a structured JSON header so entries are machine-parseable.
            # Use locals() to recover raw/session_id regardless of which
            # statement inside the try block raised.
            _raw: dict = locals().get("raw") or {}  # type: ignore[assignment]  # locals().get() returns object; we know "raw" is always dict or absent here
            _sid = str(_raw.get("session_id", ""))[:16]
            header = json.dumps(
                {"ts": time.time(), "event": event, "sid": _sid, "err": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            )
            with sink.open("a", encoding="utf-8") as fh:
                fh.write(header + "\n" + safe_msg + "\n" + safe_tb + "\n")
        except Exception:
            pass
        emit(result)
        return
    else:
        # Dispatch succeeded — attempt output translation.  A bug in
        # denormalize_response (e.g. a future field that triggers TypeError in
        # _translate_hso_to_codex) must not discard the real dispatch output.
        # If translation fails, emit the un-denormalized dict: the harness sees
        # unexpected keys and ignores them — still better than bare CONTINUE.
        try:
            result = dict(denormalize_response(dispatched, harness, event))
        except Exception as _denorm_exc:
            _LOG.warning(
                "denormalize_response failed for %s (%s): %s — emitting raw dispatch output",
                event,
                harness,
                _denorm_exc,
            )
            result = dict(dispatched)
    emit(result)
    # Best-effort: record hook timing AFTER emit() so the stat write never adds
    # latency visible to the harness.  bytes_saved stores elapsed_ms as an int
    # so SQL aggregates (AVG/MAX) work without a schema change.
    with contextlib.suppress(Exception):
        _elapsed_ms = result.get("_tg_elapsed_ms")
        if isinstance(_elapsed_ms, (int, float)):
            from . import db as _db
            _db.record_stat(
                None,
                f"hook:{sanitize_log_str(event, max_len=48)}",
                bytes_saved=int(_elapsed_ms),
            )


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
        except BaseException as exc:
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
    return cast("_HookHandler", wrapper)

# Hook submodules are imported on first dispatch, not at module load time.
# Each event needs only one submodule, so a Bash tool call that triggers
# ``pre-read`` should never pay the import cost of ``hooks_session`` or
# ``hooks_fetch``.  ``_HANDLER_LOOKUP`` maps event names to
# ``(submodule_name, attribute_name)`` pairs; ``_resolve_handler`` imports the
# submodule on demand and wraps the bare handler in ``fail_soft``.  The wrapped
# handler is cached so the import is paid at most once per process.
#
# Derived from :mod:`token_goat.hook_registry` — the single source of truth
# for hook event names, handler modules, and CLI wiring.  Adding a new event
# only requires editing ``hook_registry.HOOK_EVENTS``.
from . import hook_registry as _hook_registry  # noqa: E402

_HANDLER_LOOKUP: dict[str, tuple[str, str]] = _hook_registry.handler_lookup()

_HANDLER_CACHE: dict[str, Callable[[HookPayload], HookResponse]] = {}


def _resolve_handler(event: str) -> Callable[[HookPayload], HookResponse] | None:
    """Return the ``fail_soft``-wrapped handler for *event*, importing it lazily.

    Returns None (not raises) on import or attribute errors so the dispatcher
    can fall through to the CONTINUE safety net rather than surfacing an
    unhandled ImportError or AttributeError to the caller.
    """
    cached = _HANDLER_CACHE.get(event)
    if cached is not None:
        return cached
    lookup = _HANDLER_LOOKUP.get(event)
    if lookup is None:
        return None
    submodule_name, attr_name = lookup
    import importlib

    try:
        submodule = importlib.import_module(f".{submodule_name}", package=__package__)
        bare_handler = cast("Callable[[HookPayload], HookResponse]", getattr(submodule, attr_name))
    except (ImportError, AttributeError) as exc:
        _LOG.error(
            "_resolve_handler: failed to load %s.%s for event %r: %s",
            submodule_name,
            attr_name,
            event,
            exc,
        )
        return None
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
    # Derived from :mod:`token_goat.hook_registry` so this map stays in sync
    # with ``_HANDLER_LOOKUP`` automatically.  See module docstring on
    # :mod:`hook_registry` for why this matters.
    event_map = _hook_registry.lazy_attr_map()
    if name in event_map:
        handler = _resolve_handler(event_map[name])
        if handler is not None:
            return handler
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# --- dispatcher entry point used by cli.py ---

# Default TTL for the compact-skip sentinel.  The runtime value can be tuned via
# ``[compact_assist] compact_skip_ttl_secs`` — see ``config.CompactAssistConfig``.
# The constant is preserved as the fall-back used when config has not been
# loaded yet (e.g. test paths that exercise ``_check_compact_skip_sentinel``
# directly without going through ``pre_compact``).
_COMPACT_SKIP_TTL_SECS: float = 300.0  # 5 minutes


def _compact_skip_ttl_secs() -> float:
    """Return the active TTL for the compact-skip sentinel.

    Resolves from ``[compact_assist] compact_skip_ttl_secs`` when the config
    module is importable, falling back to ``_COMPACT_SKIP_TTL_SECS`` otherwise.
    Wrapped in a broad try/except because this helper is called on the hot
    sentinel-fast-path: a config load failure must never crash the hook, and a
    sane default is always preferable to falling through to the slow path on a
    transient TOML parse error.
    """
    try:
        from . import config as config_mod

        ttl = float(config_mod.load().compact_assist.compact_skip_ttl_secs)
        if 0.0 < ttl <= 3600.0:  # mirror validator clamp; reject NaN/inf via comparison
            return ttl
    except Exception:
        pass
    return _COMPACT_SKIP_TTL_SECS


class _SkipResult:
    """Lightweight result object returned by :func:`_check_compact_skip_sentinel_detail`.

    Attributes:
        should_skip:  True when the sentinel is fresh and the hook should short-circuit.
        reason:       Human-readable skip reason string, or empty string when not skipping.
                      Possible values:
                      - ``"ttl_not_expired"``        — sentinel is fresh and within TTL
                      - ``"fingerprint_match"``       — (reserved; currently unused by the
                                                         mtime-based sentinel, kept for
                                                         forward compatibility)
                      - ``"noop_session"``            — session has zero activity
                      - ``""``                         — sentinel is absent or busted
        age_secs:     Age of the sentinel file in seconds (0.0 when no sentinel).
    """

    __slots__ = ("age_secs", "reason", "should_skip")

    def __init__(self, should_skip: bool, reason: str, age_secs: float) -> None:
        self.should_skip = should_skip
        self.reason = reason
        self.age_secs = age_secs

    # Boolean coercion so old code that does ``if _check_compact_skip_sentinel(...)``
    # still works when we expose a detail wrapper.
    def __bool__(self) -> bool:
        return self.should_skip


def _read_sentinel_counts(sentinel_path: object) -> tuple[int | None, int | None]:
    """Read the ``edited_count`` and ``bash_count`` stored in *sentinel_path*.

    The sentinel file is JSON when written by :func:`_write_compact_skip_sentinel`.
    Legacy sentinels written by ``touch()`` (empty or non-JSON) return
    ``(None, None)`` — the caller treats ``None`` as "no count available" and
    skips the count-comparison gate.

    Returns ``(edited_count, bash_count)`` as integers, or ``(None, None)``
    on any parse error.
    """
    import json as _json
    try:
        raw = sentinel_path.read_text(encoding="utf-8").strip()  # type: ignore[union-attr,attr-defined]  # sentinel_path typed as Path | None; caller guarantees it exists here
        if not raw:
            return None, None
        data = _json.loads(raw)
        edited = data.get("edited_count")
        bash = data.get("bash_count")
        if isinstance(edited, int) and isinstance(bash, int):
            return edited, bash
    except Exception:
        pass
    return None, None


def _current_session_counts(session_id: str) -> tuple[int, int]:
    """Return ``(edited_count, bash_count)`` for *session_id* from the session JSON.

    Loads the session cache at the JSON level (no heavy deserialization) to
    extract the two count fields.  Returns ``(0, 0)`` on any load failure so
    the count comparison always has a baseline.

    This function is called on the sentinel hot-path; it reads one JSON file
    and does minimal work — no DB, no tree-sitter, no embeddings.
    """
    try:
        import json as _json

        session_file = paths.session_cache_path(session_id)
        raw = session_file.read_text(encoding="utf-8")
        data = _json.loads(raw)
        edited = data.get("edited_files", {})
        bash = data.get("bash_history", {})
        edited_count = len(edited) if isinstance(edited, dict) else 0
        bash_count = len(bash) if isinstance(bash, dict) else 0
        return edited_count, bash_count
    except Exception:
        return 0, 0


def _check_compact_skip_sentinel(session_id: str) -> bool:
    """Return True if a fresh compact-skip sentinel exists for *session_id*.

    This is the legacy boolean interface; it delegates to
    :func:`_check_compact_skip_sentinel_detail` and returns only the
    ``should_skip`` flag.  New code should use the detail variant.
    """
    return _check_compact_skip_sentinel_detail(session_id).should_skip


def _check_compact_skip_sentinel_detail(session_id: str) -> _SkipResult:
    """Return a :class:`_SkipResult` describing whether and why the sentinel is fresh.

    Reads only ``paths`` (already imported at module load) on the fast path —
    no other token_goat module is touched when the sentinel is absent or stale.
    The sentinel is considered fresh when all of the following hold:

    1. **TTL**: sentinel age is within the configured TTL (default 300 s).
    2. **Activity floor (mtime)**: session JSON mtime is not newer than the
       sentinel mtime (guards against edits that occurred after sentinel write).
    3. **Activity floor (counts)**: the session's current ``edited_count`` and
       ``bash_count`` match the values stored inside the sentinel JSON.  If the
       session has more edits or bash commands than when the sentinel was written
       it means real work happened, and the manifest should be regenerated.
       Sentinels written by older code (no JSON content) skip this check so
       the upgrade is backwards-compatible.

    Negative-age defence: if the sentinel mtime is in the future (clock skew,
    NTP step, manually edited file), log a warning and return ``False`` so the
    slow path rebuilds the manifest.

    Any filesystem error (missing file, permission denied, stat failure) returns
    a not-skipping result so the normal path runs.
    """
    try:
        sentinel = paths.compact_skip_sentinel_path(session_id)
    except ValueError:
        return _SkipResult(False, "", 0.0)
    try:
        sentinel_mtime = sentinel.stat().st_mtime
    except OSError:
        return _SkipResult(False, "", 0.0)

    now = time.time()
    age = now - sentinel_mtime
    if age < -1.0:
        # Future-dated sentinel: genuine clock skew (NTP step, manual edit, or
        # stale file from another machine).  Sub-second negative ages are normal
        # Windows filesystem/wall-clock jitter and are treated as age ~= 0.
        _LOG.warning(
            "compact-skip sentinel mtime is in the future session=%s skew=%.0fs"
            " — ignoring sentinel, falling back to full pre-compact path",
            session_id[:16], -age,
        )
        return _SkipResult(False, "", 0.0)
    if age >= _compact_skip_ttl_secs():
        _LOG.debug(
            "compact-skip sentinel expired session=%s age=%.0fs ttl=%.0fs",
            session_id[:16], age, _compact_skip_ttl_secs(),
        )
        return _SkipResult(False, "", age)

    # Activity floor (mtime): any session-state update since the sentinel was
    # written should bust the cache.
    try:
        session_file = paths.session_cache_path(session_id)
    except ValueError:
        # Bad session_id (path traversal etc.) — no manifest to be had.
        return _SkipResult(True, "ttl_not_expired", age)
    try:
        session_mtime = session_file.stat().st_mtime
    except OSError:
        # No session file → nothing to invalidate against.  Skip is safe.
        return _SkipResult(True, "ttl_not_expired", age)

    # +2.0 s grace handles the case where the sentinel was written immediately
    # after a session save in the same hook firing — filesystem mtime
    # resolution on Windows (FAT/exFAT) is 2 s; on NTFS/ext4 it is ~ns.
    if session_mtime > sentinel_mtime + 2.0:
        _LOG.debug(
            "compact-skip sentinel busted by mtime activity session=%s"
            " (session_mtime=%.3f > sentinel_mtime=%.3f)",
            session_id[:16], session_mtime, sentinel_mtime,
        )
        return _SkipResult(False, "", age)

    # Activity floor (counts): read edited_count + bash_count from the sentinel
    # JSON and compare against the live session.  A count increase since the
    # sentinel was written means real work happened regardless of mtime resolution.
    sentinel_edited, sentinel_bash = _read_sentinel_counts(sentinel)
    if sentinel_edited is not None and sentinel_bash is not None:
        current_edited, current_bash = _current_session_counts(session_id)
        if current_edited > sentinel_edited or current_bash > sentinel_bash:
            _LOG.debug(
                "compact-skip sentinel busted by count increase session=%s"
                " edited=%d→%d bash=%d→%d",
                session_id[:16],
                sentinel_edited, current_edited,
                sentinel_bash, current_bash,
            )
            return _SkipResult(False, "", age)

    _LOG.debug(
        "compact-skip sentinel fresh session=%s age=%.0fs reason=ttl_not_expired",
        session_id[:16], age,
    )
    return _SkipResult(True, "ttl_not_expired", age)


def _write_compact_skip_sentinel(
    session_id: str,
    *,
    edited_count: int = 0,
    bash_count: int = 0,
) -> None:
    """Write the compact-skip sentinel for *session_id* with activity counts.

    Stores ``edited_count`` and ``bash_count`` inside the sentinel so
    :func:`_check_compact_skip_sentinel_detail` can detect activity that
    happened after the sentinel was written even when the session file's
    mtime resolution is coarse (FAT32: 2 s).

    Creates the ``compact_skip/`` directory as needed.  Errors are silently
    swallowed — a failure to write the sentinel only means the next call pays
    the full import cost instead of taking the fast path; the hook still
    returns ``{"continue": true}`` correctly.
    """
    import json as _json
    try:
        sentinel = paths.compact_skip_sentinel_path(session_id)
        paths.ensure_dir(sentinel.parent)
        payload = _json.dumps(
            {"edited_count": edited_count, "bash_count": bash_count},
            separators=(",", ":"),
        )
        paths.atomic_write_text(sentinel, payload)
    except Exception:
        pass


def _write_precompact_estimate(session_id: str, cache: object) -> None:
    """Write a JSON sentinel with the bytes estimate for the pre-compact session.

    Called from ``pre_compact`` immediately after the session cache is loaded —
    at that point ``bash_history`` and ``web_history`` still hold the
    pre-compaction data.  After compaction Claude Code may start a *new* session
    so the post-compact ``SessionStart`` handler cannot reconstruct this
    estimate from the (empty) new session cache.

    The sentinel is keyed by the *pre-compact* session ID.  The
    ``_try_recovery_response`` function in ``hooks_session.py`` looks for the
    most recently written sentinel so it works even when the session ID changes
    after compaction.

    Errors are silently swallowed — this is advisory telemetry only.
    """
    import json as _json
    import time as _time

    try:
        bash_hist: dict = getattr(cache, "bash_history", None) or {}
        web_hist: dict = getattr(cache, "web_history", None) or {}
        bytes_estimate = 0
        for be in bash_hist.values():
            bytes_estimate += getattr(be, "stdout_bytes", 0) + getattr(be, "stderr_bytes", 0)
        for we in web_hist.values():
            bytes_estimate += getattr(we, "body_bytes", 0)
        payload = _json.dumps(
            {
                "bytes_estimate": max(0, bytes_estimate),
                "bash_count": len(bash_hist),
                "web_count": len(web_hist),
                "session_id": session_id,
                "ts": _time.time(),
            },
            separators=(",", ":"),
        )
        sentinel = paths.precompact_estimate_path(session_id)
        paths.ensure_dir(sentinel.parent)
        paths.atomic_write_text(sentinel, payload)
        _LOG.debug(
            "pre-compact: wrote estimate sentinel session=%s bytes=%d bash=%d web=%d",
            session_id[:16], max(0, bytes_estimate), len(bash_hist), len(web_hist),
        )
    except Exception:
        _LOG.debug("pre-compact: estimate sentinel write failed", exc_info=True)


def _is_noop_session(cache: object) -> bool:
    """Return True when the session has no meaningful activity worth manifesting.

    A session is a noop when ALL of the following hold:
    - zero edited files
    - zero bash commands
    - zero symbols accessed (all file entries have empty ``symbols_read``)

    This is the cheapest possible check: three attribute reads and a loop over
    what is usually an empty dict.  Called before any heavy manifest rendering
    so the PreCompact hook can skip even the manifest fingerprint computation.
    """
    edited: dict = getattr(cache, "edited_files", None) or {}
    if edited:
        return False
    bash: dict = getattr(cache, "bash_history", None) or {}
    if bash:
        return False
    files: dict = getattr(cache, "files", None) or {}
    for entry in files.values():
        syms = getattr(entry, "symbols_read", None)
        if syms:
            return False
    return True


@fail_soft
def pre_compact(payload: HookPayload) -> HookResponse:
    """PreCompact hook: inject a session manifest as systemMessage before compaction.

    The compaction LLM receives the manifest in its context and includes it in
    the summary, so edited files and accessed symbols survive the compaction.
    Configurable via config.toml [compact_assist] or TOKEN_GOAT_COMPACT_ASSIST=0.

    Fast path: when a fresh compact-skip sentinel exists for this session (written
    on a previous call that determined the session had too little activity to
    warrant a manifest), return immediately without importing any heavy modules.
    This saves ~150 ms of Python import overhead on near-fresh sessions.
    """
    # --- Sentinel fast-path (before any heavy imports) ---
    session_id = payload.get("session_id")
    if session_id:
        skip_result = _check_compact_skip_sentinel_detail(str(session_id))
        if skip_result.should_skip:
            _LOG.debug(
                "pre-compact: sentinel fast-path session=%s reason=%s age=%.0fs",
                str(session_id)[:16], skip_result.reason, skip_result.age_secs,
            )
            return CONTINUE()

    from . import compact as compact_mod
    from . import config as config_mod

    cfg = config_mod.load().compact_assist
    if not cfg.enabled:
        if session_id:
            _write_compact_skip_sentinel(str(session_id))
        return CONTINUE()

    trigger_raw = payload.get("trigger", "manual")
    trigger = str(trigger_raw) if trigger_raw is not None else "manual"
    if not cfg.triggers or trigger not in cfg.triggers:
        _LOG.info("pre-compact: skipping (trigger=%s not in %s)", sanitize_log_str(trigger), cfg.triggers)
        if session_id:
            _write_compact_skip_sentinel(str(session_id))
        return CONTINUE()

    if not session_id:
        return CONTINUE()

    from . import session as session_mod

    session_cache = session_mod.safe_load(session_id, caller="pre-compact")
    if session_cache is None:
        _write_compact_skip_sentinel(str(session_id))
        return CONTINUE()

    # --- Cross-session manifest deduplication ---
    # Write this session's file coverage so concurrent sessions can read it,
    # then merge all live session manifests to avoid duplicating coverage
    # when two Claude Code windows work on the same project simultaneously.
    cwd = payload.get("cwd")
    if cwd:
        try:
            from pathlib import Path as _Path

            from .project import canonicalize as _canon
            from .project import project_hash as _ph
            from .session import FileEntry as _FileEntry
            _proj_hash = _ph(_canon(_Path(str(cwd))))
            _session_files = [
                {"rel_path": e.rel_or_abs, "hit_count": e.read_count, "last_read_ts": e.last_read_ts}
                for e in (getattr(session_cache, "files", None) or {}).values()
                if getattr(e, "rel_or_abs", "")
            ]
            compact_mod.write_session_manifest(_proj_hash, str(session_id), {
                "session_id": str(session_id),
                "files": _session_files,
                "updated_at": time.time(),
            })
            _all_manifests = compact_mod.read_all_session_manifests(_proj_hash)
            _merged = compact_mod.merge_session_manifests(_all_manifests, budget_tokens=200)
            _current_files: dict[str, object] = getattr(session_cache, "files", {}) or {}
            for _mentry in _merged:
                _rel = _mentry.get("rel_path", "")
                if _rel and _rel not in _current_files:
                    _current_files[_rel] = _FileEntry(
                        rel_or_abs=_rel,
                        last_read_ts=float(_mentry.get("last_read_ts", 0.0)),
                        read_count=int(_mentry.get("hit_count", 1)),
                        line_ranges=[],
                        symbols_read=[],
                    )
            session_cache.files = _current_files  # type: ignore[assignment]
        except Exception:
            _LOG.debug("pre-compact: cross-session dedup failed", exc_info=True)

    # --- Noop session fast-path ---
    # If the session has zero edits, zero bash commands, and zero symbols
    # accessed there is nothing worth preserving.  Skip manifest construction
    # entirely and write the sentinel with current counts so the next
    # PreCompact doesn't have to re-check.
    #
    # Guard: only apply when min_events >= 1.  When min_events is 0 the caller
    # explicitly requested "always run"; skip the noop gate so test code that
    # uses min_events=0 with mock sessions still reaches build_manifest_with_count.
    if cfg.min_events >= 1 and _is_noop_session(session_cache):
        _LOG.debug(
            "pre-compact: skipping — noop session (no edits, no bash, no symbols) session=%s",
            str(session_id)[:16],
        )
        _write_compact_skip_sentinel(str(session_id), edited_count=0, bash_count=0)
        return CONTINUE()

    # Write the pre-compact bytes estimate sentinel so that the post-compact
    # SessionStart handler can read it when building the recovery_pending sidecar.
    # The session cache has live bash/web history HERE but will be a fresh empty
    # cache in the new post-compact session.  Storing the estimate now prevents
    # _check_recovery_pending from computing 0 when it reads from the empty cache.
    _write_precompact_estimate(str(session_id), session_cache)

    # Compute adaptive budget based on session complexity.
    # This replaces the fixed config value as the base — complex sessions with
    # many edited files, symbols accessed, and bash history get more space.
    age_seconds = time.time() - session_cache.created_ts
    base_tokens = compact_mod.compute_adaptive_budget(session_cache, age_seconds=age_seconds)
    _LOG.debug(
        "pre-compact: adaptive budget computed from session complexity: %d tokens",
        base_tokens,
    )

    # Pressure-aware sizing multiplier: auto-triggered compaction means Claude Code's context
    # is near-full and the harness is forced to compact.  A larger manifest at that
    # moment is net-positive — every preserved fact saves a subsequent re-read.
    # Manual /compact, by contrast, fires while the agent still has headroom, so
    # we skip the multiplier to avoid wasting tokens the user might use elsewhere.
    # Use get_auto_trigger_multiplier to select per-harness defaults if not explicitly set.
    multiplier = compact_mod.get_auto_trigger_multiplier(
        config_explicit_multiplier=cfg.auto_trigger_multiplier
    )
    if trigger == "auto" and multiplier > 1.0:
        pre_clamp_tokens = int(base_tokens * multiplier)
        _LOG.info(
            "pre-compact: auto-trigger detected — boosting manifest budget %d → %d (×%.2f)",
            base_tokens, pre_clamp_tokens, multiplier,
        )
    else:
        pre_clamp_tokens = base_tokens

    # Hard ceiling: prevent unbounded manifests. Clamp to either config max or 1200,
    # whichever is configured. Adaptive budget already returns [200, 800], so this
    # only caps the multiplier-amplified value.
    hard_max = max(cfg.max_manifest_tokens, 1200)
    effective_tokens = min(pre_clamp_tokens, hard_max)

    _manifest_t0 = time.perf_counter()
    manifest, n_events = compact_mod.build_manifest_with_count(
        session_id, max_tokens=effective_tokens
    )
    _manifest_ms = (time.perf_counter() - _manifest_t0) * 1000
    _manifest_tokens = compact_mod.estimate_tokens(manifest) if manifest else 0
    _LOG.debug(
        "pre-compact: built manifest in %.0fms (%d tokens)",
        _manifest_ms, _manifest_tokens,
    )

    # Compute counts once for sentinel writes below.
    _sentinel_edited = len(getattr(session_cache, "edited_files", None) or {})
    _sentinel_bash = len(getattr(session_cache, "bash_history", None) or {})

    if n_events < cfg.min_events:
        _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events)
        _write_compact_skip_sentinel(
            str(session_id), edited_count=_sentinel_edited, bash_count=_sentinel_bash,
        )
        return CONTINUE()

    if not manifest:
        _LOG.debug(
            "pre-compact: manifest builder returned empty string (events=%d session=%s); skipping injection",
            n_events, str(session_id)[:16],
        )
        _write_compact_skip_sentinel(
            str(session_id), edited_count=_sentinel_edited, bash_count=_sentinel_bash,
        )
        return CONTINUE()

    _LOG.info(
        "pre-compact: injecting manifest (%d chars, trigger=%s, events=%d)",
        len(manifest), sanitize_log_str(trigger), n_events,
    )

    # Manifest-budget envelope telemetry (r5 iter 4): record an informational
    # stat row capturing budget vs. realised token cost.  ``token-goat doctor``
    # reads these rows to surface p50/p95/max utilization over the trailing 30
    # days, so the budget caps can be tuned against real data instead of
    # guessed.  Best-effort — a stat-write failure never blocks the manifest
    # injection.
    try:
        from . import db

        actual_tokens = compact_mod.estimate_tokens(manifest)
        detail = (
            f"budget={effective_tokens},actual={actual_tokens},"
            f"trigger={trigger},events={n_events}"
        )
        db.record_stat(
            None, "compact_manifest", tokens_saved=0, bytes_saved=0, detail=detail
        )
    except Exception:
        _LOG.debug("pre-compact: telemetry record failed", exc_info=True)

    # Reset context-growth tracking so threshold advisories restart cleanly in
    # the post-compact session (the cache is preserved across compaction).
    try:
        session_cache.turns_since_last_compact = 0
        session_cache.last_context_advisory_threshold = None
        # Snapshot the current pressure total as the new baseline.  After this
        # point get_context_pressure subtracts it, so the fill fraction measures
        # only incremental load since this compaction — preventing the session
        # from being permanently pinned to "critical" for its entire remaining life.
        from .compact import _pressure_raw_total as _prt
        session_cache.pressure_baseline_tokens = _prt(session_cache)
        session_mod.save(session_cache)
        # Stamp last_compact_ts via the canonical helper so pre_read can suppress
        # "already in context" hints for files whose content is gone post-compact.
        session_mod.record_compact(session_id)
    except Exception:
        _LOG.debug("pre-compact: context tracking reset failed", exc_info=True)

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
# tests).  Each value is a lazy proxy that imports its submodule on first call;
# ``pre-compact`` is the exception — its handler lives in this module directly,
# so we register the real function (no lazy proxy needed).
#
# Derived from :mod:`token_goat.hook_registry` so adding a new event only
# requires editing one place.  See the module docstring on
# :mod:`hook_registry` for context.
EVENTS: dict[str, Callable[[HookPayload], HookResponse]] = {
    name: _make_lazy_proxy(name) for name in _HANDLER_LOOKUP
}
EVENTS["pre-compact"] = pre_compact


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
    # Re-read the env on every dispatch (cheap dict lookup) so operators can
    # widen the budget on slow Windows boxes without restarting the agent.
    watchdog_ms = _resolved_watchdog_ms()
    timeout_s = watchdog_ms / 1000.0
    # Run the handler in a daemon thread so a hung handler cannot block the dispatcher; asyncio.wait_for raises TimeoutError precisely at the budget instead of relying on is_alive() after an unguaranteed join.
    async def _run_async() -> dict[str, object]:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, object]] = loop.create_future()

        def _run_handler() -> None:
            try:
                # Set hook context so DB layers can query the remaining watchdog budget.
                _hook_context.set((t0, watchdog_ms, safe_event))
                try:
                    result = dict(handler(payload))
                finally:
                    _hook_context.set(None)
            except BaseException:
                # Top-level safety net: catch exceptions from handlers whose fail_soft is missing or ineffective.
                _LOG.exception("handler %s raised; relying on dispatcher safety net", safe_event)
                result = dict(CONTINUE())

            def _set() -> None:
                if not fut.done():
                    fut.set_result(result)

            with contextlib.suppress(RuntimeError):  # loop closed after timeout — normal on watchdog trip
                loop.call_soon_threadsafe(_set)

        worker = threading.Thread(target=_run_handler, name=f"tg-hook-{safe_event}", daemon=True)
        worker.start()

        try:
            result = await asyncio.wait_for(fut, timeout=timeout_s)
            elapsed_ms = (time.monotonic() - t0) * 1000
            if elapsed_ms >= _HOOK_SLOW_MS:
                _LOG.warning("hook %s slow: %.1fms (check for blockage or I/O delays)", safe_event, elapsed_ms)
            else:
                speed_tag = "moderate" if elapsed_ms >= _HOOK_MODERATE_MS else "fast"
                _LOG.debug("hook %s completed in %.1fms (%s)", safe_event, elapsed_ms, speed_tag)
            result["_tg_elapsed_ms"] = round(elapsed_ms, 2)
            # Every valid hook response must carry {"continue": True}; a handler returning an unexpected shape must not block the harness.
            result.setdefault("continue", True)
            return result
        except TimeoutError:
            _LOG.warning(
                "hook %s watchdog tripped after %.0fms — abandoning wait (handler continues in background)",
                safe_event,
                watchdog_ms,
            )
            watchdog_result: dict[str, object] = dict(CONTINUE())
            watchdog_result["_tg_elapsed_ms"] = round((time.monotonic() - t0) * 1000, 2)
            watchdog_result["_tg_watchdog_tripped"] = True
            watchdog_result["_tg_watchdog_budget_ms"] = watchdog_ms
            return watchdog_result

    return asyncio.run(_run_async())
