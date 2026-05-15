"""Worker daemon runtime and maintenance helpers."""
from __future__ import annotations

import contextlib
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any

from . import db, parser
from .project import Project
from .worker import CleanupStats, DirtyQueueEntry, _ProjectBucket
from . import worker as _worker

_LOG = logging.getLogger("tokenwise.worker")


def cleanup_on_startup() -> CleanupStats:
    """Run all the self-healing tasks. Returns a stats dict."""
    stats: CleanupStats = {
        "stale_locks_cleared": 0,
        "stale_index_markers_cleared": 0,
        "logs_deleted": 0,
        "image_bytes_evicted": 0,
        "image_files_evicted": 0,
        "stats_rows_pruned": 0,
    }

    # 1. Stale lockfile cleanup
    locks = _worker.paths.locks_dir()
    if locks.exists():
        for lock_path in locks.glob("*.lock"):
            try:
                content = lock_path.read_text(encoding="utf-8")
                pid_str = content.split("\n", 1)[0].strip()
                if not pid_str:
                    raise ValueError("empty PID in lock file")
                pid = int(pid_str)
                dead = not _worker.psutil.pid_exists(pid)
                old = time.time() - lock_path.stat().st_mtime > 600
                if dead or old:
                    lock_path.unlink()
                    stats["stale_locks_cleared"] += 1
            except (ValueError, OSError) as e:
                # Malformed lock or unable to read — remove it
                _LOG.debug("removing stale/malformed lock %s: %s", lock_path.name, e)
                try:
                    lock_path.unlink()
                    stats["stale_locks_cleared"] += 1
                except OSError as unlink_err:
                    _LOG.warning("failed to remove lock %s: %s", lock_path.name, unlink_err)

    # 1b. Stale index-spawn marker cleanup.
    stats["stale_index_markers_cleared"] = _worker.reap_stale_index_markers()

    # 2. Log rotation: delete logs older than LOG_RETENTION_DAYS
    logs = _worker.paths.logs_dir()
    if logs.exists():
        cutoff = time.time() - _worker.LOG_RETENTION_DAYS * 86400
        for log in logs.glob("*.log"):
            try:
                if log.stat().st_mtime < cutoff:
                    log.unlink()
                    stats["logs_deleted"] += 1
            except OSError:
                pass

    # 3. Image cache LRU eviction (size-based)
    bytes_evicted, files_evicted = _worker.evict_image_cache_if_over_limit()
    stats["image_bytes_evicted"] = bytes_evicted
    stats["image_files_evicted"] = files_evicted

    # 4. Stats table pruning.
    try:
        cutoff_ts = int(time.time() - _worker.STATS_RETENTION_DAYS * 86400)
        with db.open_global() as conn:
            cur = conn.execute("DELETE FROM stats WHERE ts < ?", (cutoff_ts,))
            stats["stats_rows_pruned"] = cur.rowcount or 0
    except Exception:  # noqa: BLE001
        _LOG.exception("stats prune failed")

    return stats


def _reindex_active_projects() -> None:
    """Incrementally re-index every recently-active project."""
    cutoff = int(time.time() - _worker.PERIODIC_REINDEX_ACTIVE_WINDOW)
    try:
        with db.open_global_readonly() as gconn:
            rows = gconn.execute(
                "SELECT hash, root, marker, file_count FROM projects WHERE last_seen >= ?",
                (cutoff,),
            ).fetchall()
    except Exception:  # noqa: BLE001
        _LOG.exception("could not query active projects for reindex")
        return

    if not rows:
        return

    _LOG.info("periodic reindex: %d active project(s) to check", len(rows))
    for row in rows:
        if row["file_count"] > _worker.PERIODIC_REINDEX_MAX_FILES:
            _LOG.warning(
                "periodic reindex: skipping %s (%d files > %d limit)",
                row["root"],
                row["file_count"],
                _worker.PERIODIC_REINDEX_MAX_FILES,
            )
            continue
        proj = Project(root=Path(row["root"]), hash=row["hash"], marker=row["marker"])
        try:
            summary = parser.index_project(proj, full=False)
            if summary["indexed"] > 0 or summary["errors"] > 0:
                _LOG.info(
                    "periodic reindex: root=%s indexed=%d skipped=%d errors=%d dur=%.2fs",
                    row["root"],
                    summary["indexed"],
                    summary["skipped_unchanged"],
                    summary["errors"],
                    summary["duration_sec"],
                )
            else:
                _LOG.debug("periodic reindex: root=%s no changes", row["root"])
        except Exception:  # noqa: BLE001
            _LOG.exception("periodic reindex failed for %s", row["root"])


def _process_dirty_entries(entries: list[DirtyQueueEntry]) -> None:
    """Re-index files that were marked dirty by Edit/Write hooks."""
    by_project: dict[str, _ProjectBucket] = {}
    for entry in entries:
        ph = entry.get("project_hash")
        rel = entry.get("path")
        if not ph or not rel:
            continue
        if ph not in by_project:
            by_project[ph] = _ProjectBucket(rels=set(), root=None, marker=None)
        bucket = by_project[ph]
        bucket["rels"].add(rel)
        if bucket["root"] is None and entry.get("project_root"):
            bucket["root"] = entry["project_root"]
            bucket["marker"] = entry.get("project_marker") or "manual"

    all_hashes = list(by_project.keys())
    known_projects: dict[str, Any] = {}
    if all_hashes:
        ph_placeholders = ",".join("?" for _ in all_hashes)
        with db.open_global() as gconn:
            for row in gconn.execute(
                f"SELECT hash, root, marker FROM projects WHERE hash IN ({ph_placeholders})",  # noqa: S608
                all_hashes,
            ):
                known_projects[row["hash"]] = row

    for ph, bucket in by_project.items():
        try:
            row = known_projects.get(ph)

            if row:
                project = Project(root=Path(row["root"]), hash=ph, marker=row["marker"])
                is_first_index = False
            elif bucket["root"]:
                project = Project(
                    root=Path(bucket["root"]), hash=ph, marker=bucket["marker"] or "manual"
                )
                is_first_index = True
                _LOG.info(
                    "dirty queue: project %s not yet registered; running first index", ph[:8]
                )
            else:
                _LOG.warning(
                    "dirty queue refers to unknown project hash %s with no root; dropping", ph
                )
                continue

            t0 = time.time()
            result = parser.index_project(project, full=is_first_index)
            elapsed = time.time() - t0
            if result["errors"] > 0:
                _LOG.warning(
                    "reindexed %d/%d files in project %s after dirty queue drain"
                    " (errors=%d dur=%.2fs)",
                    result["indexed"],
                    result["total_files"],
                    ph[:8],
                    result["errors"],
                    elapsed,
                )
            else:
                _LOG.info(
                    "reindexed %d/%d files in project %s after dirty queue drain (dur=%.2fs)",
                    result["indexed"],
                    result["total_files"],
                    ph[:8],
                    elapsed,
                )
        except Exception:  # noqa: BLE001
            _LOG.exception("failed to reindex project %s from dirty queue", ph)


def run_daemon(stop_event=None) -> None:
    """Main loop: heartbeat + dirty-queue processing + periodic maintenance."""
    _worker._setup_logging()

    claim_fd = _worker._try_claim_worker_slot()
    if claim_fd is None:
        _LOG.info("another worker holds the slot; exiting")
        return

    _worker._clear_pid()
    _worker._write_pid()
    _worker._heartbeat()
    _worker._register_autostart()

    stats = cleanup_on_startup()
    if any(stats.values()):
        _LOG.info("startup cleanup: %s", stats)

    last_heartbeat = time.time()
    last_maintenance = time.time()
    last_periodic_reindex = time.time()
    last_version_check = time.time()
    restart_for_upgrade = False

    def should_stop() -> bool:
        """Return True when the caller has signalled the worker to shut down."""
        return stop_event is not None and stop_event.is_set()

    if hasattr(signal, "SIGTERM"):
        with contextlib.suppress(ValueError, AttributeError):
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if hasattr(signal, "SIGINT"):
        with contextlib.suppress(ValueError, AttributeError):
            signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

    _LOG.info("worker started, pid=%s", os.getpid())

    try:
        while not should_stop():
            now = time.time()

            if now - last_heartbeat >= _worker.HEARTBEAT_INTERVAL:
                _worker._heartbeat()
                last_heartbeat = now

            entries = _worker.drain_dirty_queue()
            if entries:
                _process_dirty_entries(entries)

            if now - last_maintenance >= _worker.MAINTENANCE_INTERVAL:
                _LOG.info("starting maintenance cycle")
                try:
                    s = cleanup_on_startup()
                    if any(s.values()):
                        _LOG.info("periodic maintenance completed: %s", s)
                    else:
                        _LOG.debug("periodic maintenance completed (no actions needed)")
                except Exception:  # noqa: BLE001
                    _LOG.exception("periodic maintenance failed")
                last_maintenance = now

            if now - last_periodic_reindex >= _worker.PERIODIC_REINDEX_INTERVAL:
                try:
                    _reindex_active_projects()
                except Exception:  # noqa: BLE001
                    _LOG.exception("periodic reindex cycle failed")
                last_periodic_reindex = now

            if now - last_version_check >= _worker.VERSION_CHECK_INTERVAL:
                current = _worker._installed_version()
                current_fp = _worker._package_fingerprint()
                version_changed = (
                    _worker._BOOTED_VERSION is not None
                    and current is not None
                    and current != _worker._BOOTED_VERSION
                )
                code_changed = (
                    _worker._BOOTED_FINGERPRINT is not None
                    and current_fp is not None
                    and current_fp != _worker._BOOTED_FINGERPRINT
                )
                if version_changed or code_changed:
                    _LOG.info(
                        "tokenwise %s changed on disk (version %s -> %s); "
                        "restarting worker to load new code",
                        "version" if version_changed else "code",
                        _worker._BOOTED_VERSION,
                        current,
                    )
                    restart_for_upgrade = True
                    break
                last_version_check = now

            time.sleep(_worker.POLL_INTERVAL)
    finally:
        _LOG.info("worker shutting down, pid=%s", os.getpid())
        _worker._clear_pid()
        with contextlib.suppress(OSError):
            os.close(claim_fd)
        with contextlib.suppress(OSError):
            _worker._worker_claim_path().unlink()

    if restart_for_upgrade:
        _LOG.info("respawning worker with updated code")
        _worker.spawn_detached()
