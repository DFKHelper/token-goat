"""Background worker daemon: dirty-queue polling, self-healing, periodic cleanup."""
from __future__ import annotations

import contextlib
import json
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import psutil

from . import db, parser, paths
from .project import Project

_LOG = logging.getLogger("tokenwise.worker")

# Heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30.0
# Dirty queue poll interval
POLL_INTERVAL = 2.0
# Periodic maintenance interval (cleanup tasks)
MAINTENANCE_INTERVAL = 300.0  # 5 min

# How many days of granular stats events to keep in global.db before pruning.
# After this many days, rows are deleted from the stats table to keep the DB
# bounded. Aggregate counts/by-day are computed at query time from the
# remaining window, so historical totals beyond this window simply roll off.
STATS_RETENTION_DAYS = 90

# Image cache eviction threshold (bytes)
IMAGE_CACHE_LIMIT = 500 * 1024 * 1024  # 500 MB
IMAGE_CACHE_TARGET = int(IMAGE_CACHE_LIMIT * 0.8)  # evict to 80%

# Log retention (days)
LOG_RETENTION_DAYS = 7

# Worker timeout: if started but never heartbeats within this many seconds, watchdog clears the PID
WORKER_STARTUP_GRACE = 15.0


def _setup_logging() -> None:
    paths.ensure_dirs()
    log_path = paths.logs_dir() / f"{datetime.now():%Y-%m-%d}.log"
    if not _LOG.handlers:
        handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        _LOG.addHandler(handler)
        # also stream to stderr for daemon visibility
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
        _LOG.addHandler(stream)
        _LOG.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Liveness
# ---------------------------------------------------------------------------

def _is_heartbeat_fresh(hb_path: Path) -> bool:
    """Check if heartbeat file exists and is recent (within 2x interval + grace)."""
    if not hb_path.exists():
        return False
    try:
        last = hb_path.stat().st_mtime
        return time.time() - last <= 2 * HEARTBEAT_INTERVAL + 5
    except OSError:
        return False


def _is_process_recent(pid: int) -> bool:
    """Check if process exists and is younger than startup grace window."""
    try:
        p = psutil.Process(pid)
        age = time.time() - p.create_time()
        return age <= WORKER_STARTUP_GRACE
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def is_worker_alive() -> bool:
    """True if the PID file exists, points to a live process, and heartbeat is fresh."""
    pid_path = paths.worker_pid_path()
    if not pid_path.exists():
        return False
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return False
    if not psutil.pid_exists(pid):
        return False

    # Check heartbeat freshness or startup grace period
    hb_path = paths.worker_heartbeat_path()
    if hb_path.exists():
        return _is_heartbeat_fresh(hb_path)

    # No heartbeat yet — worker is still starting up
    return _is_process_recent(pid)


def _write_pid() -> None:
    """Write the current process ID to the worker PID file for liveness tracking."""
    paths.worker_pid_path().write_text(str(os.getpid()), encoding="utf-8")


def _heartbeat() -> None:
    """Write current timestamp to heartbeat file to indicate the worker is alive."""
    paths.worker_heartbeat_path().write_text(str(time.time()), encoding="utf-8")


def _clear_pid() -> None:
    """Remove PID and heartbeat files to signal the worker is stopping."""
    for p in (paths.worker_pid_path(), paths.worker_heartbeat_path()):
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            _LOG.warning("failed to clear %s: %s", p, e)


# ---------------------------------------------------------------------------
# Dirty queue
# ---------------------------------------------------------------------------

def enqueue_dirty(rel_path: str, project_hash: str | None = None) -> None:
    """Append a dirty path to the queue. Used by hooks after Edit/Write."""
    paths.dirty_queue_path().parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"path": rel_path, "project_hash": project_hash, "ts": time.time()})
    with paths.dirty_queue_path().open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def drain_dirty_queue() -> list[dict]:
    """Read all queued entries and clear the file. Returns the entries.

    Validates each entry is a dict before appending to ensure type safety.
    Skips malformed entries with a warning.
    """
    p = paths.dirty_queue_path()
    if not p.exists():
        return []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
        # truncate the file
        p.write_text("", encoding="utf-8")
    except OSError as e:
        _LOG.warning("failed to read/clear dirty queue: %s", e)
        return []
    entries = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                _LOG.warning("dirty queue entry is not a dict: %s", line[:120])
                continue
            entries.append(entry)
        except json.JSONDecodeError:
            _LOG.warning("bad dirty queue entry (not valid JSON): %s", line[:120])
    return entries


# ---------------------------------------------------------------------------
# Self-healing
# ---------------------------------------------------------------------------

def cleanup_on_startup() -> dict:
    """Run all the self-healing tasks. Returns a stats dict."""
    stats = {
        "stale_locks_cleared": 0,
        "logs_deleted": 0,
        "image_bytes_evicted": 0,
        "image_files_evicted": 0,
        "stats_rows_pruned": 0,
    }

    # 1. Stale lockfile cleanup
    locks = paths.locks_dir()
    if locks.exists():
        for lock_path in locks.glob("*.lock"):
            try:
                content = lock_path.read_text(encoding="utf-8")
                pid_str = content.split("\n", 1)[0].strip()
                if not pid_str:
                    raise ValueError("empty PID in lock file")
                pid = int(pid_str)
                dead = not psutil.pid_exists(pid)
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

    # 2. Log rotation: delete logs older than LOG_RETENTION_DAYS
    logs = paths.logs_dir()
    if logs.exists():
        cutoff = time.time() - LOG_RETENTION_DAYS * 86400
        for log in logs.glob("*.log"):
            try:
                if log.stat().st_mtime < cutoff:
                    log.unlink()
                    stats["logs_deleted"] += 1
            except OSError:
                pass

    # 3. Image cache LRU eviction (size-based)
    bytes_evicted, files_evicted = evict_image_cache_if_over_limit()
    stats["image_bytes_evicted"] = bytes_evicted
    stats["image_files_evicted"] = files_evicted

    # 4. Stats table pruning. read_intercept / tool_use / session_hint events
    # accumulate one row per tool call, so the table grows unboundedly without
    # this. Drops rows older than STATS_RETENTION_DAYS from global.db. Recent
    # data and savings totals are unaffected.
    try:
        from . import db as _db  # noqa: PLC0415
        cutoff_ts = int(time.time() - STATS_RETENTION_DAYS * 86400)
        with _db.open_global() as conn:
            cur = conn.execute("DELETE FROM stats WHERE ts < ?", (cutoff_ts,))
            stats["stats_rows_pruned"] = cur.rowcount or 0
    except Exception:  # noqa: BLE001
        _LOG.exception("stats prune failed")

    return stats


def evict_image_cache_if_over_limit() -> tuple[int, int]:
    """If image cache > IMAGE_CACHE_LIMIT, LRU-evict to IMAGE_CACHE_TARGET.

    Returns (bytes_freed, files_freed).
    """
    img_dir = paths.image_cache_dir()
    if not img_dir.exists():
        return 0, 0
    files = []
    total = 0
    for f in img_dir.iterdir():
        if not f.is_file():
            continue
        try:
            st = f.stat()
            files.append((f, st.st_mtime, st.st_size))
            total += st.st_size
        except OSError:
            continue
    if total <= IMAGE_CACHE_LIMIT:
        return 0, 0
    # Sort oldest first (LRU)
    files.sort(key=lambda x: x[1])
    bytes_freed = 0
    files_freed = 0
    for f, _, size in files:
        if total - bytes_freed <= IMAGE_CACHE_TARGET:
            break
        try:
            f.unlink()
            bytes_freed += size
            files_freed += 1
        except OSError:
            pass
    return bytes_freed, files_freed


# ---------------------------------------------------------------------------
# Spawn API (called by SessionStart watchdog)
# ---------------------------------------------------------------------------

def spawn_detached() -> int | None:
    """Spawn the tokenwise worker as a detached background process.

    Uses ``pythonw.exe -m tokenwise.cli worker --daemon`` rather than the
    launcher .exe so AV/EDR products don't behavior-flag the spawn.
    Returns PID or None on failure.
    """
    from . import paths  # noqa: PLC0415
    cmd = paths.python_runner_argv("worker", "--daemon")

    creationflags = 0
    if sys.platform == "win32":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        creationflags = 0x00000008 | 0x00000200 | 0x08000000

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=(sys.platform != "win32"),
        )
        return proc.pid
    except (OSError, FileNotFoundError) as e:
        _LOG.error("failed to spawn worker: %s", e)
        return None


def spawn_index_detached(project_root: str) -> int | None:
    """Spawn `tokenwise index --full` from the given project root, detached.

    Used by the SessionStart hook to auto-populate a project's symbol DB the
    first time tokenwise sees that project. Runs in the background; the user
    or agent's subsequent tokenwise commands work as soon as it finishes.

    Uses ``pythonw.exe -m tokenwise.cli`` rather than the launcher .exe so
    AV/EDR products don't behavior-flag the spawn.
    """
    from . import paths  # noqa: PLC0415
    cmd = paths.python_runner_argv("index", "--full")

    creationflags = 0
    if sys.platform == "win32":
        creationflags = 0x00000008 | 0x00000200 | 0x08000000

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=project_root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=(sys.platform != "win32"),
        )
        return proc.pid
    except (OSError, FileNotFoundError) as e:
        _LOG.error("failed to spawn auto-index: %s", e)
        return None


def ensure_running() -> int | None:
    """Idempotent watchdog: spawn the worker if it's not already running.

    Returns PID (existing or new).
    """
    if is_worker_alive():
        try:
            return int(paths.worker_pid_path().read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None
    # Stale state — clean up before spawn
    _clear_pid()
    return spawn_detached()


# ---------------------------------------------------------------------------
# Main run loop (daemon mode)
# ---------------------------------------------------------------------------

def run_daemon(stop_event=None) -> None:
    """Main loop: heartbeat + dirty-queue processing + periodic maintenance.

    Exits on SIGTERM/SIGINT or when stop_event is set.
    """
    _setup_logging()

    # Refuse to start if another worker is alive
    if is_worker_alive():
        _LOG.info("another worker is alive; exiting")
        return

    # Take ownership
    _clear_pid()
    _write_pid()
    _heartbeat()

    # Self-healing on startup
    stats = cleanup_on_startup()
    if any(stats.values()):
        _LOG.info("startup cleanup: %s", stats)

    last_heartbeat = time.time()
    last_maintenance = time.time()

    def should_stop() -> bool:
        return stop_event is not None and stop_event.is_set()

    # Best-effort signal handling
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

            # Heartbeat
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                _heartbeat()
                last_heartbeat = now

            # Drain dirty queue
            entries = drain_dirty_queue()
            if entries:
                _process_dirty_entries(entries)

            # Periodic maintenance
            if now - last_maintenance >= MAINTENANCE_INTERVAL:
                try:
                    s = cleanup_on_startup()
                    if any(s.values()):
                        _LOG.info("periodic maintenance: %s", s)
                except Exception:  # noqa: BLE001
                    _LOG.exception("periodic maintenance failed")
                last_maintenance = now

            time.sleep(POLL_INTERVAL)
    finally:
        _LOG.info("worker shutting down, pid=%s", os.getpid())
        _clear_pid()


def _process_dirty_entries(entries: list[dict]) -> None:
    """Re-index files that were marked dirty by Edit/Write hooks."""
    # Group by project_hash
    by_project: dict[str, set[str]] = {}
    for entry in entries:
        ph = entry.get("project_hash")
        rel = entry.get("path")
        if not ph or not rel:
            continue
        by_project.setdefault(ph, set()).add(rel)

    for ph, _rels in by_project.items():
        try:
            # Look up project root from global.db
            with db.open_global() as gconn:
                row = gconn.execute(
                    "SELECT root, marker FROM projects WHERE hash = ?", (ph,)
                ).fetchone()
                if not row:
                    _LOG.warning("dirty queue refers to unknown project hash %s", ph)
                    continue
                project = Project(
                    root=Path(row["root"]),
                    hash=ph,
                    marker=row["marker"],
                )

            # Incremental reindex (full=False uses SHA-based skip-unchanged logic)
            result = parser.index_project(project, full=False)
            _LOG.info(
                "reindexed %d/%d files in project %s after dirty queue drain",
                result["indexed"],
                result["total_files"],
                ph[:8],
            )
        except Exception:  # noqa: BLE001
            _LOG.exception("failed to reindex project %s from dirty queue", ph)
