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
import os
import sys
import threading
import time
import traceback
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Final, Literal, ParamSpec, TypeVar, cast

from . import paths
from .hooks_common import CONTINUE, HookPayload, HookResponse, sanitize_log_str
from .util import get_logger, sanitize_surrogates

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
    """Convert camelCase hookSpecificOutput keys to snake_case for Codex wire format.

    Recursively translates nested dicts so that sub-objects inside
    ``hookSpecificOutput`` (e.g. a nested ``updatedInput`` dict whose values
    are themselves dicts) are also converted.  Non-dict values are left as-is.
    """
    translated: dict[str, object] = {}
    for key, val in hso.items():
        new_key = _HSO_CAMEL_TO_SNAKE.get(key, key)
        # Recurse into nested dicts so translation applies at every level.
        if isinstance(val, dict):
            translated[new_key] = _translate_hso_to_codex(val)
        else:
            translated[new_key] = val
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

    Reads :data:`_ENV_HOOK_WATCHDOG_MS` and clamps to
    ``[_HOOK_WATCHDOG_MS_FLOOR, _HOOK_WATCHDOG_MS_CEIL]``.  Any parse failure
    (non-numeric, negative, blank) falls back to :data:`_HOOK_WATCHDOG_MS`.

    Reading the env per dispatch costs ~1 µs and means an operator can re-tune
    the budget mid-session by editing the agent's settings.json — no restart
    needed.  Tests still monkeypatch ``_HOOK_WATCHDOG_MS`` directly, which
    continues to work because that constant is the fallback.
    """
    raw = os.environ.get(_ENV_HOOK_WATCHDOG_MS, "").strip()
    if not raw:
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
            _raw: dict = locals().get("raw") or {}  # type: ignore[assignment]
            _sid = str(_raw.get("session_id", ""))[:16]
            header = json.dumps(
                {"ts": time.time(), "event": event, "sid": _sid, "err": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            )
            with sink.open("a", encoding="utf-8") as fh:
                fh.write(header + "\n" + safe_msg + "\n" + safe_tb + "\n")
        except Exception:  # noqa: BLE001
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
#
# Derived from :mod:`token_goat.hook_registry` — the single source of truth
# for hook event names, handler modules, and CLI wiring.  Adding a new event
# only requires editing ``hook_registry.HOOK_EVENTS``.
from . import hook_registry as _hook_registry  # noqa: E402

_HANDLER_LOOKUP: dict[str, tuple[str, str]] = _hook_registry.handler_lookup()

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
        from . import config as config_mod  # noqa: PLC0415

        ttl = float(config_mod.load().compact_assist.compact_skip_ttl_secs)
        if 0.0 < ttl <= 3600.0:  # mirror validator clamp; reject NaN/inf via comparison
            return ttl
    except Exception:  # noqa: BLE001
        pass
    return _COMPACT_SKIP_TTL_SECS


def _check_compact_skip_sentinel(session_id: str) -> bool:
    """Return True if a fresh compact-skip sentinel exists for *session_id*.

    Reads only ``paths`` (already imported at module load) on the fast path —
    no other token_goat module is touched when the sentinel is absent or
    stale.  The sentinel is considered fresh when its mtime is within the
    configured TTL (default ``_COMPACT_SKIP_TTL_SECS`` seconds).

    Activity floor (iter 60): the sentinel is invalidated when the session
    JSON file's mtime is newer than the sentinel's mtime.  Every session-state
    update (post-Read, post-Edit, post-Bash, ...) touches the session file, so
    "session file mtime > sentinel mtime" is a sufficient proxy for "the user
    has been active since we wrote the sentinel".  Without this floor a quiet
    session that fires PreCompact once (sentinel written) could suppress every
    PreCompact for the next 5 minutes even after the agent generates dozens of
    edits — exactly when a manifest is most valuable.

    Negative-age defence (iter 60): if the sentinel mtime is in the future
    (clock skew, NTP step, manually edited file), log a warning and return
    False so the slow path rebuilds the manifest.  Mirrors the manifest
    sidecar's negative-age defence in ``compact._read_manifest_sidecar``.

    Any filesystem error (missing file, permission denied, stat failure)
    returns False so the normal path runs.
    """
    try:
        sentinel = paths.compact_skip_sentinel_path(session_id)
    except ValueError:
        return False
    try:
        sentinel_mtime = sentinel.stat().st_mtime
    except OSError:
        return False

    now = time.time()
    age = now - sentinel_mtime
    if age < 0.0:
        # Future-dated sentinel: clock skew, NTP step, manual edit, or a stale
        # file copied from another machine.  Log once per occurrence and fall
        # through to the slow path; the slow path will rewrite the sentinel
        # with a sane mtime on the next no-op exit.
        _LOG.warning(
            "compact-skip sentinel mtime is in the future session=%s skew=%.0fs"
            " — ignoring sentinel, falling back to full pre-compact path",
            session_id[:16], -age,
        )
        return False
    if age >= _compact_skip_ttl_secs():
        return False

    # Activity floor: any session-state update since the sentinel was written
    # should bust the cache.  ``session_cache_path`` returns the JSON we write
    # on every post-tool hook; its mtime tracks "last session activity".
    try:
        session_file = paths.session_cache_path(session_id)
    except ValueError:
        # Bad session_id (path traversal etc.) — already a no-op for the
        # session subsystem, no manifest to be had.  Skip is safe.
        return True
    try:
        session_mtime = session_file.stat().st_mtime
    except OSError:
        # No session file → nothing to invalidate against.  Original behaviour
        # (skip is fine) preserved.
        return True
    # +0.5 s grace handles the case where the sentinel was written immediately
    # after a session save in the same hook firing — filesystem mtime
    # resolution on Windows (FAT/exFAT) is 2 s; on NTFS/ext4 it is ~ns.  The
    # grace prevents a same-tick race from looking like "activity after
    # sentinel" on coarse-resolution clocks.
    if session_mtime > sentinel_mtime + 0.5:
        _LOG.debug(
            "compact-skip sentinel busted by activity session=%s"
            " (session_mtime=%.3f > sentinel_mtime=%.3f)",
            session_id[:16], session_mtime, sentinel_mtime,
        )
        return False
    return True


def _write_compact_skip_sentinel(session_id: str) -> None:
    """Write (or touch) the compact-skip sentinel for *session_id*.

    Creates the ``compact_skip/`` directory as needed.  Errors are silently
    swallowed — a failure to write the sentinel only means the next call pays
    the full import cost instead of taking the fast path; the hook still
    returns ``{"continue": true}`` correctly.
    """
    try:
        sentinel = paths.compact_skip_sentinel_path(session_id)
        paths.ensure_dir(sentinel.parent)
        sentinel.touch()
    except Exception:  # noqa: BLE001
        pass


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
    if session_id and _check_compact_skip_sentinel(str(session_id)):
        _LOG.debug("pre-compact: sentinel fast-path for session=%s", str(session_id)[:16])
        return CONTINUE()

    from . import compact as compact_mod  # noqa: PLC0415
    from . import config as config_mod  # noqa: PLC0415

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

    from . import session as session_mod  # noqa: PLC0415

    if session_mod.safe_load(session_id, caller="pre-compact") is None:
        _write_compact_skip_sentinel(str(session_id))
        return CONTINUE()

    # Pressure-aware sizing: auto-triggered compaction means Claude Code's context
    # is near-full and the harness is forced to compact.  A larger manifest at that
    # moment is net-positive — every preserved fact saves a subsequent re-read.
    # Manual /compact, by contrast, fires while the agent still has headroom, so
    # we keep the base budget to avoid wasting tokens the user might use elsewhere.
    # ``build_manifest`` clamps internally so any out-of-range product is capped.
    base_tokens = cfg.max_manifest_tokens
    # ``isinstance`` guard handles the MagicMock-attribute trap in tests where the
    # config is mocked and auto-vivified attributes are not real floats.  Real
    # configs always populate the field via the loader, so this branch is only
    # entered when something has gone wrong with config construction.
    raw_multiplier = getattr(cfg, "auto_trigger_multiplier", 1.0)
    multiplier = float(raw_multiplier) if isinstance(raw_multiplier, (int, float)) else 1.0
    if trigger == "auto" and multiplier > 1.0:
        effective_tokens = int(base_tokens * multiplier)
        _LOG.info(
            "pre-compact: auto-trigger detected — boosting manifest budget %d → %d (×%.2f)",
            base_tokens, effective_tokens, multiplier,
        )
    else:
        effective_tokens = base_tokens

    manifest, n_events = compact_mod.build_manifest_with_count(
        session_id, max_tokens=effective_tokens
    )
    if n_events < cfg.min_events:
        _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events)
        _write_compact_skip_sentinel(str(session_id))
        return CONTINUE()

    if not manifest:
        _write_compact_skip_sentinel(str(session_id))
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
        from . import db  # noqa: PLC0415

        actual_tokens = compact_mod.estimate_tokens(manifest)
        detail = (
            f"budget={effective_tokens},actual={actual_tokens},"
            f"trigger={trigger},events={n_events}"
        )
        db.record_stat(
            None, "compact_manifest", tokens_saved=0, bytes_saved=0, detail=detail
        )
    except Exception:  # noqa: BLE001
        _LOG.debug("pre-compact: telemetry record failed", exc_info=True)

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
    # Run the handler in a daemon thread so a hung handler cannot block the
    # dispatcher beyond the watchdog budget.  The thread keeps running to
    # completion in the background (preserving fail_soft semantics — the
    # handler's own try/except still fires); we just stop waiting for it.
    # daemon=True ensures the process can exit on Windows even if the thread
    # is wedged on an unkillable syscall.
    handler_result: dict[str, object] = {}
    handler_error: list[BaseException] = []

    def _run_handler() -> None:
        try:
            handler_result.update(dict(handler(payload)))
        except BaseException as exc:  # pragma: no cover — fail_soft catches first
            handler_error.append(exc)

    worker = threading.Thread(
        target=_run_handler,
        name=f"tg-hook-{safe_event}",
        daemon=True,
    )
    worker.start()
    # Re-read the env on every dispatch (cheap dict lookup) so operators can
    # widen the budget on slow Windows boxes without restarting the agent.
    watchdog_ms = _resolved_watchdog_ms()
    timeout_s = watchdog_ms / 1000.0
    worker.join(timeout_s)
    if worker.is_alive():
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
    result: dict[str, object] = dict(handler_result)
    elapsed_ms = (time.monotonic() - t0) * 1000
    if elapsed_ms >= _HOOK_SLOW_MS:
        _LOG.warning("hook %s slow: %.1fms (check for blockage or I/O delays)", safe_event, elapsed_ms)
    else:
        speed_tag = "moderate" if elapsed_ms >= _HOOK_MODERATE_MS else "fast"
        _LOG.debug("hook %s completed in %.1fms (%s)", safe_event, elapsed_ms, speed_tag)
    result["_tg_elapsed_ms"] = round(elapsed_ms, 2)
    # Top-level safety net: every valid hook response must carry {"continue": True}.
    # fail_soft already guarantees this on exception paths, but a handler that
    # returns an unexpected shape (e.g. empty dict, missing key) would otherwise
    # produce a response the harness cannot parse.  Force the field to True so the
    # harness never blocks on a malformed-but-non-crashing handler return.
    result.setdefault("continue", True)
    return result
