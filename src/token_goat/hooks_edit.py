"""Post-edit hook handler: session recording and incremental re-indexing.

``post_edit`` runs after every Write, Edit, and MultiEdit tool call.  It does
two things:

1. **Session recording** — marks the edited file in the per-session JSON cache
   so the compaction manifest knows which files changed, and so post-compact
   recovery can highlight them.

2. **Incremental re-indexing** — resolves the file to a project, appends its
   relative path to ``queue/dirty.txt``, and nudges the background worker if its
   heartbeat file is stale (>65 s old).  The worker drains the queue every 2 s,
   SHA-checks each file, and re-runs tree-sitter extraction only for changed
   files — avoiding a full-project walk on every keystroke.

Failures at any step are logged but never raised; the hook always returns
CONTINUE so a broken index pipeline cannot interrupt the agent.
"""
from __future__ import annotations

__all__ = ["post_edit"]

from .hooks_common import (
    CONTINUE,
    HookPayload,
    HookResponse,
    get_session_context,
    get_tool_input,
    sanitize_log_str,
    validate_cwd,
)
from .hooks_common import (
    LOG as _LOG,
)


def _nudge_worker_if_down() -> None:
    """Respawn the background worker if its heartbeat file is stale.

    The worker daemon updates a heartbeat file every 2 seconds. If the mtime is
    >65 seconds old, the worker is assumed dead and a respawn is attempted.
    Failures are logged but not raised (fail-soft hook pattern).
    """
    import time  # noqa: PLC0415

    from . import paths  # noqa: PLC0415

    try:
        hb_path = paths.worker_heartbeat_path()
        try:
            fresh = (time.time() - hb_path.stat().st_mtime) <= 65.0
        except OSError:
            fresh = False
        if fresh:
            return
        _LOG.info("worker heartbeat stale — attempting respawn")
        from . import worker  # noqa: PLC0415

        pid = worker.ensure_running()
        if pid:
            _LOG.info("worker respawned: pid=%s", pid)
        else:
            _LOG.warning("worker nudge: ensure_running returned no pid (already running or failed)")
    except Exception:  # noqa: BLE001
        _LOG.exception("worker nudge failed")


def _enqueue_for_reindex(file_path: str, cwd: str | None) -> None:
    """Queue a file for background re-indexing after edit.

    Resolves the file path to an absolute path within a project, then enqueues
    it to the dirty-file queue (queue/dirty.txt) so the background worker can
    reindex it on the next cycle. If the file is outside any indexed project,
    this is silently skipped (no error raised).

    Args:
        file_path: Absolute or relative path to the edited file.
        cwd: Current working directory (used to resolve relative paths).
    """
    from pathlib import Path  # noqa: PLC0415

    from . import worker  # noqa: PLC0415
    from .project import find_project  # noqa: PLC0415

    abs_path = Path(file_path)
    if abs_path.is_absolute():
        search_root = abs_path.parent
    else:
        cwd_path = validate_cwd(cwd, caller="post-edit")
        if cwd_path is None:
            _LOG.debug("post-edit: no valid cwd for relative file_path %s; skipping enqueue", sanitize_log_str(file_path))
            return
        search_root = cwd_path
    project = find_project(search_root)
    if project is None:
        _LOG.debug(
            "post-edit: %s is outside any indexed project; skipping reindex enqueue",
            sanitize_log_str(file_path),
        )
        return
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return

    try:
        worker.enqueue_dirty(
            rel,
            project.hash,
            project_root=project.root.as_posix(),
            project_marker=project.marker,
        )
    except OSError as e:
        _LOG.warning("failed to enqueue %s for reindex: %s", rel, e)


def post_edit(payload: HookPayload) -> HookResponse:
    """Post-edit hook: record edited files and queue for incremental re-indexing.

    Two-part hook action:
    1. Records the edited file to the session cache (for compaction manifest and recovery).
    2. Enqueues the file to the dirty-queue and nudges the worker daemon if stale.

    The worker then re-indexes only the changed file, avoiding full-project reindexing.
    Always returns CONTINUE() per fail-soft hook pattern; failures are logged but never raised.
    """
    from . import session  # noqa: PLC0415

    session_id, cwd = get_session_context(payload)
    tool_input = get_tool_input(payload)
    file_path = tool_input.get("file_path")

    if session_id and file_path:
        cache = session.load(session_id)
        session.mark_file_edited(session_id, file_path, cache=cache)

    if file_path:
        _LOG.debug("post-edit: enqueuing %s for reindex", sanitize_log_str(file_path))
        _enqueue_for_reindex(file_path, cwd)
        _nudge_worker_if_down()
    else:
        _LOG.debug("post-edit: no file_path in payload; nothing to enqueue")

    return CONTINUE()
