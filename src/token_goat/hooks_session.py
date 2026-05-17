"""Session lifecycle hook handlers: session-start and project auto-detection.

``session_start`` fires on every new Claude Code session (SessionStart event).
It performs three ordered actions:

1. **Cache reset** — clears the per-session JSON cache for this session ID so
   stale line-range data from a previous run does not trigger false re-read hints.

2. **Project detection + auto-indexing** — resolves ``cwd`` from the harness
   payload to a project root.  If the project has never been indexed, a detached
   background ``token-goat index`` subprocess is spawned so the first Read of the
   session already has symbols available.  ``db.touch_project_last_seen`` is also
   called so the worker's periodic-reindex prioritises recently used projects.

3. **Worker watchdog** — calls ``worker.ensure_running()`` to start (or confirm)
   the background daemon.  The worker handles dirty-queue draining, LRU image
   eviction, log rotation, and stale-lock cleanup; it must be alive before any
   post-edit hooks fire.

``cwd`` validation is intentional: the field comes from an untrusted harness
payload, so empty, non-directory, and excessively long values are rejected before
being passed to ``find_project``.
"""
from __future__ import annotations

__all__ = ["session_start"]

from typing import TYPE_CHECKING

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    sanitize_opt,
    validate_cwd,
)
from .hooks_common import (
    LOG as _LOG,
)

if TYPE_CHECKING:
    # ``project`` pulls in ``hashlib`` (~6 ms cold) plus the marker regexes,
    # which are only needed when ``session-start`` actually fires.  The other
    # five hook events never touch this module's helpers, so defer the import.
    from .project import Project


def _reset_session_cache(session_id: str | None) -> None:
    """Reset session cache for /clear, /compact, fresh-start events."""
    if not session_id:
        return
    from . import session  # noqa: PLC0415

    session.reset_session(session_id)


def _detect(payload: HookPayload) -> Project | None:
    """Detect the current project from cwd. Returns None if not in a project root.

    Validates *cwd* via :func:`hooks_common.validate_cwd` before handing it to
    ``find_project``.  The ``cwd`` field comes from the harness payload (external
    input), so a malformed value — an empty string, a non-directory path, a
    relative path, or an excessively long value — is rejected before
    ``find_project`` is allowed to walk arbitrary filesystem locations.
    """
    cwd_path = validate_cwd(payload.get("cwd"), caller="session-start")
    if cwd_path is None:
        return None
    from .project import find_project  # noqa: PLC0415

    return find_project(cwd_path)


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
        else:
            _LOG.debug(
                "session-start: project %s already indexed; skipping auto-index",
                proj.hash[:8],
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


def session_start(payload: HookPayload) -> HookResponse:
    """Reset session cache and ensure worker daemon is running."""
    session_id, cwd = get_session_context(payload)
    _LOG.info("session-start: session_id=%s cwd=%s", sanitize_opt(session_id), sanitize_opt(cwd))

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
