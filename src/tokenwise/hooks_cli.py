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


def read_payload(input_file: Path | None = None) -> dict[str, Any]:
    """Read JSON payload from stdin (or a file, for testing)."""
    if input_file is not None:
        return json.loads(input_file.read_text(encoding="utf-8"))
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def emit(result: dict[str, Any]) -> None:
    """Write the hook result to stdout as JSON."""
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


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

    # Log project detection
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])

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
    """Phase 10: session-cache hints. Phase 12 (image shrink) wires in here too."""
    from .hints import build_read_hint  # noqa: PLC0415

    tool_name = payload.get("tool_name")
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
                with contextlib.suppress(Exception):
                    db.record_stat(
                        None,
                        "image_shrink",
                        bytes_saved=img_stats["bytes_saved"],
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
    """Phase 3+ (symbol invalidation). Stub for now."""
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
