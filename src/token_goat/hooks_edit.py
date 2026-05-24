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


_PREDICTIVE_SNAPSHOT_CAP = 3  # max pre-snapshots per post_edit call


def _parse_local_imports(source: str, file_path: str, cwd: str | None) -> list[str]:
    """Parse top-of-file Python import statements and return resolved local file paths.

    Scans *source* for ``import X`` and ``from X import Y`` lines at the top of the
    file (stops at the first non-import, non-blank, non-comment line).  For each
    module name, resolves relative imports (``from .foo import bar`` →
    ``<parent>/foo.py``) and top-level project imports (``from token_goat.x import y``
    → search for ``<project_root>/**/x.py``).  Returns at most
    ``_PREDICTIVE_SNAPSHOT_CAP`` resolved absolute paths that actually exist on disk.

    Only ``.py`` files are considered; third-party/stdlib imports are silently skipped
    when no matching file is found.  Errors are swallowed (best-effort).
    """
    import re  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    results: list[str] = []
    try:
        src_path = Path(file_path) if Path(file_path).is_absolute() else (
            Path(cwd) / file_path if cwd else Path(file_path)
        )
        src_dir = src_path.parent

        _import_re = re.compile(
            r"^(?:from\s+(\.{0,3}[\w.]*)\s+import\s+[\w*, ]+|import\s+([\w., ]+))\s*$"
        )

        for line in source.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            m = _import_re.match(stripped)
            if not m:
                # Stop scanning at first non-import line
                break

            module_str = m.group(1) if m.group(1) is not None else m.group(2)
            if not module_str:
                continue

            for mod in module_str.split(","):
                mod = mod.strip()
                if not mod:
                    continue
                if mod.startswith("."):
                    # Relative import: resolve against src_dir
                    dots = len(mod) - len(mod.lstrip("."))
                    mod_name = mod.lstrip(".")
                    base = src_dir
                    for _ in range(dots - 1):
                        base = base.parent
                    if mod_name:
                        candidate = base / (mod_name.replace(".", "/") + ".py")
                    else:
                        candidate = base / "__init__.py"
                    if candidate.exists():
                        results.append(str(candidate))
                else:
                    # Absolute import: try direct path relative to cwd/project
                    search_base = Path(cwd) if cwd else src_dir
                    candidate = search_base / (mod.replace(".", "/") + ".py")
                    if candidate.exists():
                        results.append(str(candidate))
                    else:
                        # Try one level up (common for src-layout projects)
                        candidate2 = search_base.parent / (mod.replace(".", "/") + ".py")
                        if candidate2.exists():
                            results.append(str(candidate2))

                if len(results) >= _PREDICTIVE_SNAPSHOT_CAP:
                    return results[:_PREDICTIVE_SNAPSHOT_CAP]

    except Exception:  # noqa: BLE001
        pass

    return results[:_PREDICTIVE_SNAPSHOT_CAP]


def _pre_snapshot_imports(session_id: str, file_path: str, cwd: str | None) -> None:
    """Read the edited .py file, parse its imports, and pre-snapshot imported files.

    Runs in a daemon thread so the hook returns immediately.  Capped at
    ``_PREDICTIVE_SNAPSHOT_CAP`` snapshots to limit I/O cost.  All errors are
    logged at debug level and swallowed per the fail-soft hook pattern.
    """
    import threading  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    def _worker() -> None:
        try:
            from . import snapshots  # noqa: PLC0415

            fp = Path(file_path) if Path(file_path).is_absolute() else (
                Path(cwd) / file_path if cwd else Path(file_path)
            )
            if not fp.exists():
                return
            source = fp.read_text(encoding="utf-8", errors="replace")
            targets = _parse_local_imports(source, file_path, cwd)
            for target_path in targets:
                try:
                    content = Path(target_path).read_bytes()
                    result = snapshots.store(session_id, target_path, content)
                    if result:
                        _LOG.debug(
                            "predictive-snapshot: stored %s for %s",
                            sanitize_log_str(target_path), sanitize_log_str(file_path),
                        )
                except Exception:  # noqa: BLE001
                    _LOG.debug("predictive-snapshot: failed for %s", sanitize_log_str(target_path), exc_info=True)
        except Exception:  # noqa: BLE001
            _LOG.debug("predictive-snapshot: outer failure", exc_info=True)

    t = threading.Thread(target=_worker, daemon=True, name="tg-predictive-snapshot")
    t.start()


def post_edit(payload: HookPayload) -> HookResponse:
    """Post-edit hook: record edited files and queue for incremental re-indexing.

    Two-part hook action:
    1. Records the edited file to the session cache (for compaction manifest and recovery).
    2. Enqueues the file to the dirty-queue and nudges the worker daemon if stale.
    3. For .py files, pre-snapshots locally imported modules in a background thread
       so the diff-aware re-read hint can fire immediately if those files are read next.

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
        # Item 17: predictive pre-snapshot for Python imports
        if session_id and file_path.endswith(".py"):
            _pre_snapshot_imports(session_id, file_path, cwd)
    else:
        _LOG.debug("post-edit: no file_path in payload; nothing to enqueue")

    return CONTINUE()
