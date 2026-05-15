"""Edit hook helpers."""
from __future__ import annotations

import logging
from typing import Any

from . import paths

_LOG = logging.getLogger("tokenwise.hooks")


def _nudge_worker_if_down() -> None:
    """Respawn the worker if its heartbeat has gone stale."""
    import time  # noqa: PLC0415

    try:
        hb_path = paths.worker_heartbeat_path()
        try:
            fresh = (time.time() - hb_path.stat().st_mtime) <= 65.0
        except OSError:
            fresh = False
        if fresh:
            return
        from . import worker  # noqa: PLC0415

        worker.ensure_running()
    except Exception:  # noqa: BLE001
        _LOG.exception("worker nudge failed")


def _enqueue_for_reindex(file_path: str, cwd: str | None) -> None:
    """Resolve *file_path* to (project_hash, rel_path) and append to the dirty queue."""
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    from .project import find_project  # noqa: PLC0415

    abs_path = Path(file_path)
    search_root = abs_path.parent if abs_path.is_absolute() else Path(cwd or ".")
    project = find_project(search_root)
    if project is None:
        return
    if not abs_path.is_absolute():
        abs_path = (project.root / file_path).resolve()
    try:
        rel = abs_path.relative_to(project.root).as_posix()
    except ValueError:
        return

    queue_path = paths.dirty_queue_path()
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {
            "path": rel,
            "project_hash": project.hash,
            "project_root": project.root.as_posix(),
            "project_marker": project.marker,
            "ts": time.time(),
        }
    )
    try:
        with queue_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as e:
        _LOG.warning("failed to enqueue %s for reindex: %s", rel, e)


def post_edit(payload: dict[str, Any]) -> dict[str, Any]:
    """Post-edit hook: record edited files + queue them for incremental reindex."""
    from . import session  # noqa: PLC0415

    session_id = payload.get("session_id")
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path")

    if session_id and file_path:
        session.mark_file_edited(session_id, file_path)

    if file_path:
        _enqueue_for_reindex(file_path, payload.get("cwd"))
        _nudge_worker_if_down()

    return {"continue": True}
