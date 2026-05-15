"""Session hook helpers."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .hooks_common import CONTINUE
from .project import Project, find_project

_LOG = logging.getLogger("token_goat.hooks")


def _reset_session_cache(session_id: str | None) -> None:
    """Reset session cache for /clear, /compact, fresh-start events."""
    if not session_id:
        return
    from . import session  # noqa: PLC0415

    session.reset_session(session_id)


def _detect(payload: dict[str, Any]) -> Project | None:
    """Detect the current project from cwd. Returns None if not in a project root."""
    cwd = payload.get("cwd")
    if not cwd:
        return None
    return find_project(Path(cwd))


def _auto_index_if_needed(proj: Project) -> None:
    """Auto-index unindexed projects on first contact."""
    try:
        from . import db, worker  # noqa: PLC0415

        if not db.project_has_files(proj.hash):
            pid = worker.spawn_index_detached(str(proj.root), proj.hash)
            if pid:
                _LOG.info(
                    "session-start: auto-indexing %s in background (pid=%s)",
                    proj.root,
                    pid,
                )
    except Exception:  # noqa: BLE001
        _LOG.exception("auto-index spawn failed")


def _ensure_worker_running() -> None:
    """Watchdog: start or verify worker daemon is alive."""
    try:
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        if pid:
            _LOG.info("session-start: worker pid=%s", pid)
    except Exception:  # noqa: BLE001
        _LOG.exception("watchdog failed")


def session_start(payload: dict[str, Any]) -> dict[str, Any]:
    """Reset session cache and ensure worker daemon is running."""
    session_id = payload.get("session_id")
    cwd = payload.get("cwd")
    _LOG.info("session-start: session_id=%s cwd=%s", session_id, cwd)

    _reset_session_cache(session_id)

    proj = _detect(payload)
    if proj:
        _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash[:8])
        # Mark user activity so the worker's periodic-reindex window stays
        # anchored to projects actually in use.
        from . import db  # noqa: PLC0415

        db.touch_project_last_seen(proj.hash)
        _auto_index_if_needed(proj)

    _ensure_worker_running()
    return CONTINUE()
