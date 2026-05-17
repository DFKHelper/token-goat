"""Session hook helpers."""
from __future__ import annotations

from pathlib import Path

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    sanitize_log_str,
    sanitize_opt,
)
from .hooks_common import (
    LOG as _LOG,
)
from .project import Project, find_project


def _reset_session_cache(session_id: str | None) -> None:
    """Reset session cache for /clear, /compact, fresh-start events."""
    if not session_id:
        return
    from . import session  # noqa: PLC0415

    session.reset_session(session_id)


def _detect(payload: HookPayload) -> Project | None:
    """Detect the current project from cwd. Returns None if not in a project root.

    Validates *cwd* before handing it to ``find_project``.  The ``cwd`` field
    comes from the harness payload (external input), so a malformed value — an
    empty string, a non-directory path, or an excessively long value — is
    rejected here rather than letting ``find_project`` walk arbitrary filesystem
    locations.  The length cap (4096 chars) matches PATH_MAX on Linux and is
    well above any real working directory path on Windows (32 767 chars is the
    theoretical Windows maximum, but practical paths are far shorter; we cap at
    4096 to match POSIX expectations and avoid allocating large Path objects from
    untrusted input).
    """
    cwd = payload.get("cwd")
    if not cwd or not isinstance(cwd, str):
        return None
    if len(cwd) > 4096:
        _LOG.warning("session-start: cwd too long (%d chars); ignoring", len(cwd))
        return None
    cwd_path = Path(cwd)
    try:
        if not cwd_path.is_dir():
            _LOG.warning("session-start: cwd %r is not an existing directory; ignoring", sanitize_log_str(cwd))
            return None
    except (OSError, ValueError) as exc:
        _LOG.warning("session-start: could not stat cwd %r: %s; ignoring", sanitize_log_str(cwd), exc)
        return None
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
