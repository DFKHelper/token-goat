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
    update_session,
    validate_cwd,
)
from .hooks_common import (
    LOG as _LOG,
)


def _nudge_worker_if_down() -> None:
    """Respawn the background worker if its heartbeat file is stale.

    Delegates the staleness decision to
    :func:`worker.is_heartbeat_stale_for_nudge`, which derives the threshold
    from :data:`worker.HEARTBEAT_INTERVAL` and :data:`worker.HEARTBEAT_GRACE_SECONDS`
    — so this nudge stays in lock-step with the watchdog's own freshness
    check, even if a future tune changes the interval. The historical
    hard-coded 65 s threshold drifted from the watchdog's
    ``2 * HEARTBEAT_INTERVAL + GRACE`` formula and would have silently
    stopped nudging if the interval changed.

    A restart throttle prevents tight restart loops if the worker is crashing
    immediately (corrupt DB, bad queue entry). If a worker was nudged and
    respawned within the last WORKER_RESTART_THROTTLE_SECS (30 s), this call
    skips the respawn and lets the previous attempt settle.

    Failures are logged but not raised (fail-soft hook pattern).
    """
    try:
        from . import paths, worker  # noqa: PLC0415

        if not worker.is_heartbeat_stale_for_nudge():
            return

        # Check restart throttle to prevent restart loops on persistent failures.
        sentinel = paths.data_dir() / "sentinels" / "last_worker_restart"
        throttle_secs = getattr(worker, "WORKER_RESTART_THROTTLE_SECS", 30.0)
        try:
            import time  # noqa: PLC0415
            if sentinel.exists():
                age = time.time() - sentinel.stat().st_mtime
                if age < throttle_secs:
                    _LOG.debug(
                        "worker restart throttle: skipping respawn (last attempt %.1f s ago, "
                        "throttle %.1f s)",
                        age, throttle_secs,
                    )
                    return
        except OSError:
            pass  # Ignore sentinel check errors; proceed with respawn attempt.

        _LOG.info("worker heartbeat stale — attempting respawn")
        pid = worker.ensure_running()
        if pid:
            _LOG.info("worker respawned: pid=%s", pid)
            # Update the restart sentinel to mark when the respawn happened.
            try:
                paths.ensure_dir(sentinel.parent)
                paths.atomic_write_text(sentinel, "")
            except OSError:
                pass  # Sentinel update is best-effort.
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
_IMPORT_SCAN_LINE_LIMIT = 200  # cap header scan so giant modules stay fast


def _parse_local_imports(source: str, file_path: str, cwd: str | None) -> list[str]:
    """Parse top-of-file Python import statements and return resolved local file paths.

    Scans the first ``_IMPORT_SCAN_LINE_LIMIT`` lines of *source* for ``import X``
    and ``from X import Y`` statements.  Non-import lines (decorators, ``try:``,
    ``if TYPE_CHECKING:``, class/function definitions) are skipped rather than
    treated as a hard stop, so conditional imports below a ``try``/``if`` block
    are still picked up.  Multi-line parenthesized imports
    (``from foo import (\\n  bar,\\n  baz,\\n)``) and backslash continuations
    are joined before matching.

    Resolves relative imports (``from .foo import bar`` → ``<parent>/foo.py``)
    and top-level project imports (``from token_goat.x import y`` → search for
    ``<project_root>/**/x.py``).  Returns at most ``_PREDICTIVE_SNAPSHOT_CAP``
    unique resolved absolute paths that actually exist on disk.

    Only ``.py`` files are considered; third-party/stdlib imports are silently
    skipped when no matching file is found.  Errors are swallowed (best-effort).
    """
    import re  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    results: list[str] = []
    seen: set[str] = set()
    try:
        src_path = Path(file_path) if Path(file_path).is_absolute() else (
            Path(cwd) / file_path if cwd else Path(file_path)
        )
        src_dir = src_path.parent

        _import_re = re.compile(
            r"^(?:from\s+(\.{0,3}[\w.]*)\s+import\s+[\w*, ]+|import\s+([\w., ]+))\s*$"
        )

        # Pre-pass: stitch multi-line parenthesized imports and backslash
        # continuations into single logical lines so the per-line regex can
        # match them.  Cap the input to the first _IMPORT_SCAN_LINE_LIMIT raw
        # lines so a giant module body cannot make this loop slow.
        raw_lines = source.splitlines()[:_IMPORT_SCAN_LINE_LIMIT]
        logical_lines: list[str] = []
        i = 0
        while i < len(raw_lines):
            line = raw_lines[i]
            stripped = line.strip()
            # Handle ``from foo import (`` continuations: keep consuming until
            # the closing ``)``.
            if "(" in stripped and stripped.count("(") > stripped.count(")") \
                    and stripped.startswith(("from ", "import ")):
                acc = [stripped]
                depth = stripped.count("(") - stripped.count(")")
                i += 1
                while i < len(raw_lines) and depth > 0:
                    nxt = raw_lines[i].strip()
                    acc.append(nxt)
                    depth += nxt.count("(") - nxt.count(")")
                    i += 1
                # Flatten the parenthesized list into ``from foo import a, b, c``.
                joined = " ".join(acc).replace("(", "").replace(")", "")
                # Collapse internal whitespace so the regex matches.
                joined = " ".join(joined.split())
                logical_lines.append(joined)
                continue
            # Handle ``import foo \`` backslash continuations.
            if stripped.endswith("\\"):
                acc = [stripped.rstrip("\\").rstrip()]
                i += 1
                while i < len(raw_lines):
                    nxt = raw_lines[i].strip()
                    if nxt.endswith("\\"):
                        acc.append(nxt.rstrip("\\").rstrip())
                        i += 1
                    else:
                        acc.append(nxt)
                        i += 1
                        break
                logical_lines.append(" ".join(acc))
                continue
            logical_lines.append(stripped)
            i += 1

        # Main pass: scan logical lines for import statements.  Unlike the
        # previous implementation we *continue* on non-import lines instead of
        # breaking, so imports below a ``try:`` block, ``if TYPE_CHECKING:``
        # gate, or decorator stack are still discovered.
        for logical in logical_lines:
            if not logical or logical.startswith("#"):
                continue
            m = _import_re.match(logical)
            if not m:
                # Not an import line — skip rather than abort the scan.
                continue

            module_str = m.group(1) if m.group(1) is not None else m.group(2)
            if not module_str:
                continue

            for mod in module_str.split(","):
                mod = mod.strip()
                if not mod:
                    continue
                candidate: Path | None = None
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
                    if not candidate.exists():
                        candidate = None
                else:
                    # Absolute import: try direct path relative to cwd/project
                    search_base = Path(cwd) if cwd else src_dir
                    c1 = search_base / (mod.replace(".", "/") + ".py")
                    if c1.exists():
                        candidate = c1
                    else:
                        # Try one level up (common for src-layout projects)
                        c2 = search_base.parent / (mod.replace(".", "/") + ".py")
                        if c2.exists():
                            candidate = c2

                if candidate is not None:
                    resolved = str(candidate)
                    if resolved not in seen:
                        seen.add(resolved)
                        results.append(resolved)
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
            from . import session as _session  # noqa: PLC0415
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
                    # Tag the snapshot as "predictive" so a subsequent diff
                    # hint built against it can be counted as a predictive
                    # prefetch hit in `token-goat stats`.  The default kind
                    # ("read") would mark this as a normal post-read snapshot
                    # and lose the attribution.
                    result = snapshots.store(
                        session_id, target_path, content, kind="predictive",
                    )
                    if result:
                        _LOG.debug(
                            "predictive-snapshot: stored %s for %s",
                            sanitize_log_str(target_path), sanitize_log_str(file_path),
                        )
                        # Persist the snapshot's content sha so a later diff
                        # hint can verify integrity before firing.  Best-effort:
                        # a session-cache write failure is logged but does not
                        # break the predictive snapshot — the snapshot itself
                        # is still useful, just unverified.
                        try:
                            _session.set_snapshot_sha(
                                session_id, target_path, result.content_sha,
                            )
                        except Exception:  # noqa: BLE001
                            _LOG.debug(
                                "predictive-snapshot: sha persist failed for %s",
                                sanitize_log_str(target_path), exc_info=True,
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
        def _record_edit(cache):  # noqa: ARG001
            session.mark_file_edited(session_id, file_path, cache=cache)
        update_session(session_id, _record_edit)

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
