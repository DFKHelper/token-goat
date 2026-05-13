"""Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}."""
from __future__ import annotations

import contextlib
import json
import logging
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from . import paths
from .project import Project, find_project

_LOG = logging.getLogger("tokenwise.hooks")


def _setup_logging() -> None:
    """Idempotent: daily-rotated log file in logs/."""
    paths.ensure_dirs()
    log_path = paths.logs_dir() / f"{datetime.now():%Y-%m-%d}.log"
    if not _LOG.handlers:
        handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        _LOG.addHandler(handler)
        _LOG.setLevel(logging.INFO)


def normalize_payload(payload: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate harness-specific payloads to tokenwise's internal format.

    Codex sends snake_case keys for some fields and uses 'turn_id'; Claude uses
    camelCase. tokenwise handlers work with the Claude shape internally.
    Most fields (session_id, cwd, tool_name, tool_input) are already identical
    between the two harnesses — nothing needs renaming in the input direction.
    """
    if harness == "codex":
        # turn_id is Codex-only — keep it in payload; no other remapping needed.
        return payload
    return payload


def denormalize_response(response: dict[str, Any], harness: str = "claude") -> dict[str, Any]:
    """Translate tokenwise's internal response format to harness-specific wire format.

    Claude: hookSpecificOutput.{additionalContext, updatedInput, permissionDecision, ...}
    Codex:  hookSpecificOutput.{additional_context, updated_input, permission_decision, ...}
    """
    if harness != "codex":
        return response
    hso = response.get("hookSpecificOutput")
    if not isinstance(hso, dict):
        return response
    translated = dict(hso)
    rename_map = {
        "additionalContext": "additional_context",
        "updatedInput": "updated_input",
        "permissionDecision": "permission_decision",
        "permissionDecisionReason": "permission_decision_reason",
        "hookEventName": "hook_event_name",
    }
    for old, new in rename_map.items():
        if old in translated:
            translated[new] = translated.pop(old)
    new_response = dict(response)
    new_response["hookSpecificOutput"] = translated
    return new_response


def read_payload(input_file: Path | None = None) -> dict[str, Any]:
    """Read JSON payload from stdin (or a file, for testing).

    Always returns a dict. Coerces non-dict JSON (``null``, lists, scalars)
    to ``{}`` so handlers can safely call ``payload.get(...)``.
    """
    if input_file is not None:
        data = json.loads(input_file.read_text(encoding="utf-8"))
    else:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        data = json.loads(raw)
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
    except Exception:  # noqa: BLE001
        pass
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
    result: dict[str, Any] = {"continue": True}
    try:
        raw = read_payload(input_file)
        payload = normalize_payload(raw, harness)
        result = dispatch(event, payload)
        result = denormalize_response(result, harness)
    except BaseException as exc:  # noqa: BLE001 — bulletproof
        with contextlib.suppress(Exception):
            print(
                f"tokenwise hook {event} failed: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
        result = {"continue": True}
    emit(result)


def fail_soft(handler: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Decorator: never raise. Log everything, always return {'continue': True}."""

    def wrapper(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return handler(payload)
        except Exception:  # noqa: BLE001 — fail-soft is the entire point
            with contextlib.suppress(Exception):
                _LOG.exception("hook handler crashed: payload=%s", json.dumps(payload)[:500])
            return {"continue": True}

    return wrapper


# --- handlers (stubs for later phases, but real fail-soft wrappers) ---


@fail_soft
def session_start(payload: dict[str, Any]) -> dict[str, Any]:
    """Reset session cache and ensure worker daemon is running."""
    session_id = payload.get("session_id")
    cwd = payload.get("cwd")
    _LOG.info("session-start: session_id=%s cwd=%s", session_id, cwd)

    # Reset session cache (covers /clear, /compact, fresh-start)
    if session_id:
        try:
            from . import session  # noqa: PLC0415

            session.reset_session(session_id)
        except Exception:  # noqa: BLE001
            _LOG.exception("failed to reset session cache")

    # Project detection + auto-index on first contact with an unindexed project.
    # Without this the symbol/read/section/ref commands have no data to return,
    # which downstream agents (especially Codex) interpret as "DB is failing"
    # instead of "not indexed yet". Detached subprocess; returns immediately.
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        try:
            from . import db, worker  # noqa: PLC0415

            if db.file_count(proj.hash) == 0:
                pid = worker.spawn_index_detached(str(proj.root))
                if pid:
                    _LOG.info(
                        "session-start: auto-indexing %s in background (pid=%s)",
                        proj.root, pid,
                    )
        except Exception:  # noqa: BLE001
            _LOG.exception("auto-index spawn failed")

    # Watchdog: ensure worker daemon is alive
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        if pid:
            _LOG.info("session-start: worker pid=%s", pid)
    except Exception:  # noqa: BLE001
        _LOG.exception("watchdog failed")

    return {"continue": True}


@fail_soft
def pre_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 10: session-cache hints. Phase 12 (image shrink) wires in here too.

    Also handles Codex's Bash tool when the command is a read-equivalent
    (cat/head/tail/bat/…). In that case a synthetic Read payload is built and
    the function calls itself recursively so all image-shrink and hint logic
    fires identically regardless of harness.
    """
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")

    # Codex path: Bash command that is really a Read
    if tool_name == "Bash":
        from . import bash_parser  # noqa: PLC0415

        cmd = (payload.get("tool_input") or {}).get("command", "")
        intent = bash_parser.parse(cmd)
        if intent.kind == "read" and intent.target_path:
            synthetic = dict(payload)
            synthetic["tool_name"] = "Read"
            synthetic["tool_input"] = {
                "file_path": intent.target_path,
                "offset": intent.offset,
                "limit": intent.limit,
            }
            return pre_read(synthetic)
        # Grep/glob via Bash: could mark session but can't rewrite the command easily. Pass through.
        return {"continue": True}

    if tool_name != "Read":
        return {"continue": True}

    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path")
    if not file_path:
        return {"continue": True}

    session_id = payload.get("session_id")
    cwd = payload.get("cwd")

    # --- Phase 12: image-shrink ---
    from . import image_shrink  # noqa: PLC0415

    if image_shrink.is_image_path(file_path):
        try:
            shrunken = image_shrink.shrink(Path(file_path))
            if shrunken is not None:
                from . import db  # noqa: PLC0415

                img_stats = image_shrink.stats_for(Path(file_path), shrunken)
                # Conservative token estimate. Assumes the image would have been
                # base64-encoded inline in the Claude prompt content (typical for
                # Read on a local image). Roughly 1 token per 4 base64 chars.
                # For pure vision-tokenized embeds this undersells.
                tokens_saved_estimate = img_stats["bytes_saved"] // 4
                with contextlib.suppress(Exception):
                    db.record_stat(
                        None,
                        "image_shrink",
                        bytes_saved=img_stats["bytes_saved"],
                        tokens_saved=tokens_saved_estimate,
                        detail=f"{file_path} -> {shrunken.name}",
                    )
                new_input = dict(tool_input)
                new_input["file_path"] = str(shrunken)
                return {
                    "continue": True,
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "updatedInput": new_input,
                        "additionalContext": (
                            f"Note: image auto-shrunk by tokenwise "
                            f"({img_stats['src_bytes']:,} → {img_stats['out_bytes']:,} bytes, "
                            f"~{img_stats['bytes_saved']:,} bytes saved). "
                            f"Original: {file_path}"
                        ),
                    },
                }
        except Exception:  # noqa: BLE001
            _LOG.exception("image-shrink failed during pre-read")
            # fall through to hint logic

    # --- existing hint logic ---
    hint = build_read_hint(
        session_id=session_id,
        file_path=file_path,
        offset=tool_input.get("offset"),
        limit=tool_input.get("limit"),
        cwd=cwd,
    )
    if not hint:
        return {"continue": True}

    # Record a session_hint stat event so users see Tokenwise working on
    # plain code reads (not only image shrinks). The agent MAY heed the
    # hint (narrower offset/limit, or `tokenwise read`); we don't observe
    # what it does next. Assume a conservative 25% effective avoidance of
    # the would-be read. Marked "estimated" in stats output.
    with contextlib.suppress(Exception):
        from . import db  # noqa: PLC0415

        file_size = 0
        with contextlib.suppress(OSError):
            file_size = Path(file_path).stat().st_size
        est_bytes = file_size // 4
        est_tokens = est_bytes // 4
        db.record_stat(
            None,
            "session_hint",
            bytes_saved=est_bytes,
            tokens_saved=est_tokens,
            detail=f"{file_path}",
        )

    return {
        "continue": True,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": hint,
        },
    }


@fail_soft
def pre_fetch(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 13+14: deny Drive/WebFetch image tools, redirect to tokenwise shims."""
    tool_name = payload.get("tool_name", "")

    # --- Drive intercept (Phase 13) ---
    _DRIVE_TOOLS = (
        "mcp__claude_ai_Google_Drive__download_file_content",
        "mcp__claude_ai_Google_Drive__read_file_content",
    )
    if tool_name in _DRIVE_TOOLS:
        tool_input = payload.get("tool_input") or {}
        file_id = tool_input.get("file_id") or tool_input.get("fileId") or tool_input.get("id")
        if not file_id:
            return {"continue": True}

        # Only intercept if tokenwise has working Drive credentials; otherwise pass through
        from . import gdrive  # noqa: PLC0415

        try:
            gdrive.get_credentials()
        except gdrive.GDriveCredsUnavailable:
            return {"continue": True}

        return {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "tokenwise redirects Drive image downloads to its shrink+cache shim",
                "additionalContext": (
                    f"tokenwise intercepted a Drive download to save tokens. "
                    f"Run this Bash instead: `tokenwise gdrive-fetch {file_id}` — "
                    f"it returns a local cached path you can then Read (images are auto-shrunk)."
                ),
            },
        }

    # --- WebFetch intercept (Phase 14) ---
    if tool_name == "WebFetch":
        tool_input = payload.get("tool_input") or {}
        url = tool_input.get("url")
        if not url:
            return {"continue": True}

        from . import webfetch  # noqa: PLC0415

        if not webfetch.is_image_url(url):
            return {"continue": True}

        return {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "tokenwise redirects image URLs to its shrink+cache shim",
                "additionalContext": (
                    f"tokenwise intercepted a WebFetch to an image URL to save tokens. "
                    f"Run this Bash instead: `tokenwise fetch-image '{url}'` — "
                    f"it downloads, shrinks, caches, and returns a local path you can then Read."
                ),
            },
        }

    return {"continue": True}


@fail_soft
def post_edit(payload: dict[str, Any]) -> dict[str, Any]:
    """Post-edit hook. Reserved for future symbol-invalidation work.

    Currently a no-op. Edits do not generate stat events because Tokenwise
    has no savings to claim on a write; the headline counters track real
    or estimated savings only.
    """
    return {"continue": True}


@fail_soft
def post_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 7: record Read/Grep calls to session cache."""
    from . import session  # noqa: PLC0415

    session_id = payload.get("session_id")
    if not session_id:
        return {"continue": True}

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}

    if tool_name == "Read":
        file_path = tool_input.get("file_path")
        if file_path:
            offset = tool_input.get("offset")
            limit = tool_input.get("limit")
            session.mark_file_read(session_id, file_path, offset, limit)
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern")
        path = tool_input.get("path")
        result_count = payload.get("result_count")
        if pattern:
            session.mark_grep(session_id, pattern, path, result_count)
    elif tool_name == "Glob":
        pass  # just log it

    return {"continue": True}


def _detect(payload: dict[str, Any]) -> Project | None:
    cwd = payload.get("cwd")
    if not cwd:
        return None
    return find_project(Path(cwd))


# --- dispatcher entry point used by cli.py ---

EVENTS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "session-start": session_start,
    "pre-read": pre_read,
    "pre-fetch": pre_fetch,
    "post-edit": post_edit,
    "post-read": post_read,
}


def dispatch(event: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Dispatch a hook event. Always returns at minimum {'continue': True}."""
    _setup_logging()
    handler = EVENTS.get(event)
    if handler is None:
        _LOG.warning("unknown hook event: %s", event)
        return {"continue": True}
    return handler(payload)
