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

_LOG = logging.getLogger("cc_saver.hooks")


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
    """Phase 9/15 will spawn the worker watchdog here."""
    _LOG.info("session-start: session_id=%s cwd=%s", payload.get("session_id"), payload.get("cwd"))
    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
    return {"continue": True}


@fail_soft
def pre_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 10 (session-cache hint), Phase 12 (image shrink). Stub for now."""
    return {"continue": True}


@fail_soft
def pre_fetch(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 13 (Drive intercept), Phase 14 (WebFetch intercept). Stub for now."""
    return {"continue": True}


@fail_soft
def post_edit(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 3+ (symbol invalidation). Stub for now."""
    return {"continue": True}


@fail_soft
def post_read(payload: dict[str, Any]) -> dict[str, Any]:
    """Phase 7 (session-mark). Stub for now."""
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
