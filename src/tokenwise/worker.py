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
from typing import TypedDict

import psutil

from . import db, parser, paths
from .project import Project


class CleanupStats(TypedDict):
    """Result of cleanup_on_startup operation."""

    stale_locks_cleared: int
    logs_deleted: int
    image_bytes_evicted: int
    image_files_evicted: int
    stats_rows_pruned: int

_LOG = logging.getLogger("tokenwise.worker")

# Heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30.0
# Dirty queue poll interval
POLL_INTERVAL = 2.0
# Periodic maintenance interval (cleanup tasks)
MAINTENANCE_INTERVAL = 300.0  # 5 min
# How often to incrementally re-index active projects.
# Longer than MAINTENANCE_INTERVAL so it does not compete with dirty-queue processing.
PERIODIC_REINDEX_INTERVAL = 600.0  # 10 min
# Skip re-indexing any project that has grown beyond this many files.
# Guards against accidentally indexing a huge directory and thrashing disk.
PERIODIC_REINDEX_MAX_FILES = 500
# Only periodically re-index projects seen within this window. Bounds the sweep
# to projects actually in use — the `projects` table accumulates every project
# tokenwise has ever touched, and reindexing all of them would be wasteful.
PERIODIC_REINDEX_ACTIVE_WINDOW = 7 * 24 * 3600.0  # 7 days

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


def _worker_claim_path() -> Path:
    """Path to the atomic single-worker claim file."""
    return paths.locks_dir() / "worker.claim"


def _proc_create_time(pid: int) -> float | None:
    """Return the process creation time, or None if the process is gone."""
    try:
        return psutil.Process(pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _worker_claim_is_stale(claim_path: Path) -> bool:
    """True only if the claim's owning process is definitely gone.

    The claim records ``pid\\ncreate_time``. It is stale iff that *exact*
    process is no longer alive — either dead, or the PID was recycled to a
    different process (detected via create-time mismatch). The owning worker
    holds the claim for its whole lifetime, so "owner process alive" is the
    one true liveness signal — no heartbeat or grace-window heuristics needed,
    which is what made the previous version misjudge healthy long-running
    workers as stale.

    An empty / malformed claim is treated as NOT stale: the owner is mid-startup
    (the gap between the O_EXCL create and the single write is microscopic), and
    reclaiming that window would re-open the race this mechanism closes.
    """
    try:
        pid_str, ct_str = claim_path.read_text(encoding="utf-8").split("\n", 1)
        pid, claimed_ct = int(pid_str), float(ct_str.strip())
    except (OSError, ValueError):
        return False  # empty/malformed — owner mid-startup, not stale
    actual_ct = _proc_create_time(pid)
    if actual_ct is None:
        return True  # owner process is gone — reclaim
    # PID alive — stale only if it was recycled to a different process.
    return abs(actual_ct - claimed_ct) > 1.0


def _try_claim_worker_slot() -> int | None:
    """Atomically claim the single-worker slot. Returns an open fd, or None.

    Uses ``os.open(O_CREAT | O_EXCL)`` as a cross-platform mutex — exactly one
    process can create the claim file. Returns None if another *live* worker
    already holds it. A claim left by a crashed worker is reclaimed once.

    This closes the TOCTOU race in the old ``is_worker_alive()`` →
    ``_write_pid()`` sequence, where two workers starting in the same window
    both saw "no worker alive" and both ran the main loop.
    """
    claim_path = _worker_claim_path()
    claim_path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in (1, 2):
        try:
            fd = os.open(str(claim_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            create_time = _proc_create_time(os.getpid()) or time.time()
            # Single write — keeps the empty-claim window microscopic.
            os.write(fd, f"{os.getpid()}\n{create_time}".encode())
            return fd
        except FileExistsError:
            if attempt == 1 and _worker_claim_is_stale(claim_path):
                _LOG.info("removing stale worker claim file")
                with contextlib.suppress(OSError):
                    claim_path.unlink()
                continue  # retry the atomic create once
            return None  # a live worker holds the slot (or lost the retry race)
        except OSError as e:
            _LOG.warning("failed to claim worker slot: %s", e)
            return None
    return None


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
    _LOG.info("drained dirty queue: %d entries", len(entries))
    return entries


# ---------------------------------------------------------------------------
# Self-healing
# ---------------------------------------------------------------------------

def cleanup_on_startup() -> CleanupStats:
    """Run all the self-healing tasks. Returns a stats dict."""
    stats: CleanupStats = {
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


# A spawn marker older than this is treated as stale (hung index) — a fresh
# spawn is then allowed. Longer than any realistic first-index run.
INDEX_SPAWN_TTL = 600.0  # 10 min


def _index_spawn_active(marker: Path) -> bool:
    """True if *marker* records an index spawn that is still running and fresh.

    The marker holds ``pid\\ntimestamp``. It is "active" only if the timestamp
    is within INDEX_SPAWN_TTL *and* the PID is still alive — so a completed or
    crashed index naturally frees the slot for the next legitimate spawn.
    """
    try:
        pid_str, ts_str = marker.read_text(encoding="utf-8").split("\n", 1)
        pid, ts = int(pid_str), float(ts_str.strip())
    except (OSError, ValueError):
        return False  # missing or malformed marker — not active
    if time.time() - ts > INDEX_SPAWN_TTL:
        return False  # stale — a hung index; allow a fresh spawn
    return psutil.pid_exists(pid)


def spawn_index_detached(project_root: str, project_hash: str) -> int | None:
    """Spawn `tokenwise index --full` from the given project root, detached.

    Used by the SessionStart hook to auto-populate a project's symbol DB the
    first time tokenwise sees that project. Runs in the background; the user
    or agent's subsequent tokenwise commands work as soon as it finishes.

    **Idempotent.** If an index for this project was recently spawned and is
    still running, this is a no-op. Without the guard, every SessionStart hook
    Popen's another ``index --full``; concurrent indexers contend on the 30 s
    writer lock, time out, exit *without writing*, so ``file_count`` stays 0
    and the next session spawns yet another — a runaway pileup (observed in
    the field: 44 concurrent processes, ~41 GB paged memory).

    Uses ``pythonw.exe -m tokenwise.cli`` rather than the launcher .exe so
    AV/EDR products don't behavior-flag the spawn.
    """
    from . import paths  # noqa: PLC0415

    marker = paths.locks_dir() / f"{project_hash}.indexing"
    if _index_spawn_active(marker):
        _LOG.info(
            "auto-index skipped for %s — an index spawn is already running",
            project_hash[:8],
        )
        return None

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
    except (OSError, FileNotFoundError) as e:
        _LOG.error("failed to spawn auto-index: %s", e)
        return None

    # Record the spawn so concurrent SessionStart hooks don't pile on. The
    # marker self-expires via PID-liveness + TTL — no explicit cleanup needed.
    with contextlib.suppress(OSError):
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{proc.pid}\n{time.time()}", encoding="utf-8")
    return proc.pid


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

    # Atomically claim the single-worker slot. Closes the startup race where
    # two workers both passed is_worker_alive() and both ran the main loop —
    # observed in the field as duplicate daemons draining the same queue.
    claim_fd = _try_claim_worker_slot()
    if claim_fd is None:
        _LOG.info("another worker holds the slot; exiting")
        return

    # We own the slot — take ownership of the pid/heartbeat files too.
    _clear_pid()
    _write_pid()
    _heartbeat()

    # Self-healing on startup
    stats = cleanup_on_startup()
    if any(stats.values()):
        _LOG.info("startup cleanup: %s", stats)

    last_heartbeat = time.time()
    last_maintenance = time.time()
    last_periodic_reindex = time.time()

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

            # Re-index recently-active projects on a longer cadence — catches
            # edits made outside Claude Code that never hit the dirty queue.
            if now - last_periodic_reindex >= PERIODIC_REINDEX_INTERVAL:
                try:
                    _reindex_active_projects()
                except Exception:  # noqa: BLE001
                    _LOG.exception("periodic reindex cycle failed")
                last_periodic_reindex = now

            time.sleep(POLL_INTERVAL)
    finally:
        _LOG.info("worker shutting down, pid=%s", os.getpid())
        _clear_pid()
        with contextlib.suppress(OSError):
            os.close(claim_fd)
        with contextlib.suppress(OSError):
            _worker_claim_path().unlink()


def _reindex_active_projects() -> None:
    """Incrementally re-index every recently-active project.

    Runs on the PERIODIC_REINDEX_INTERVAL cadence (10 min). Covers ALL projects
    — not just marker='manual' skills/plugins — whose ``last_seen`` falls within
    PERIODIC_REINDEX_ACTIVE_WINDOW. This is what catches edits made *outside*
    Claude Code (e.g. in an IDE): those never fire the post_edit hook, so they
    never reach the dirty queue, and without this sweep the project's symbol
    index would drift stale until the file happened to be edited through Claude.

    Incremental: unchanged files are skipped with no I/O beyond a stat() call.
    Projects larger than PERIODIC_REINDEX_MAX_FILES are skipped to bound disk
    load. ``last_seen`` is bumped by the SessionStart hook, so the active window
    tracks real user activity instead of growing without bound.
    """
    cutoff = int(time.time() - PERIODIC_REINDEX_ACTIVE_WINDOW)
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
        if row["file_count"] > PERIODIC_REINDEX_MAX_FILES:
            _LOG.warning(
                "periodic reindex: skipping %s (%d files > %d limit)",
                row["root"],
                row["file_count"],
                PERIODIC_REINDEX_MAX_FILES,
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
