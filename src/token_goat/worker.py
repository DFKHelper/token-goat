"""Background worker daemon: dirty-queue polling, self-healing, periodic cleanup."""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import IO, Any, TypedDict, cast

try:
    import psutil
except ModuleNotFoundError:
    class _PsutilNoSuchProcess(Exception):
        """Stub for psutil.NoSuchProcess — raised when a PID has no matching process."""

    class _PsutilAccessDenied(Exception):
        """Stub for psutil.AccessDenied — raised when process info cannot be read."""

    class _PsutilTimeoutExpired(Exception):
        """Stub for psutil.TimeoutExpired — raised when a wait operation times out."""

    class _PsutilShim:
        """Minimal psutil stand-in used when the optional psutil package is absent.

        All pid_exists() calls return False (safe: treats every PID as gone) and
        Process() always raises NoSuchProcess, so callers that catch psutil errors
        work correctly without the real library installed.
        """

        NoSuchProcess = _PsutilNoSuchProcess
        AccessDenied = _PsutilAccessDenied
        TimeoutExpired = _PsutilTimeoutExpired

        def pid_exists(self, pid: int) -> bool:
            """Return False — psutil is unavailable, so we cannot confirm any PID exists."""
            return False

        def Process(self, pid: int) -> object:
            """Raise NoSuchProcess — psutil is unavailable, so no process info can be obtained."""
            raise _PsutilNoSuchProcess(pid)

    psutil = _PsutilShim()  # type: ignore[assignment]

from . import db, parser, paths
from .project import Project


class CleanupStats(TypedDict, total=False):
    """Result of cleanup_on_startup operation."""

    stale_locks_cleared: int
    stale_index_markers_cleared: int
    logs_deleted: int
    image_bytes_evicted: int
    image_files_evicted: int
    stats_rows_pruned: int
    failures: list[str]  # task names that raised during cleanup


class DirtyQueueEntry(TypedDict, total=False):
    """One line from the dirty queue (written by hooks_cli._enqueue_for_reindex)."""

    path: str
    project_hash: str
    project_root: str
    project_marker: str
    ts: float


class _ProjectBucket(TypedDict):
    """Accumulator used inside _process_dirty_entries to group files by project."""

    rels: set[str]
    root: str | None
    marker: str | None


_LOG = logging.getLogger("token_goat.worker")

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
# token-goat has ever touched, and reindexing all of them would be wasteful.
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

# Size cap for the worker-stderr.log crash sink. spawn_detached appends to this
# file on every worker spawn (one per SessionStart hook); the daily-log
# retention sweep never catches it because each append refreshes the mtime. Once
# the file exceeds this size it is rolled over to worker-stderr.prev.log, so the
# crash sink is bounded at ~2x this value while still retaining recent output.
STDERR_LOG_MAX_BYTES = 1_000_000

# Worker timeout: if started but never heartbeats within this many seconds, watchdog clears the PID
WORKER_STARTUP_GRACE = 15.0

# Heartbeat staleness beyond which a *live* worker process is treated as hung
# (not merely busy) and may be reaped. Set far above any legitimate blocking
# operation in the main loop — dirty-queue drains and the bounded periodic
# reindex both finish in well under a minute — so a 15-minute silence from a
# still-running process is unambiguous evidence of a hang.
WORKER_HUNG_THRESHOLD = 900.0

# How often the daemon checks whether it has been replaced on disk by a
# `uv tool install --reinstall`. On a change it hands off to the new code.
VERSION_CHECK_INTERVAL = 60.0


def _installed_version() -> str | None:
    """The token-goat version currently installed on disk.

    Read fresh on every call — unlike ``_BOOTED_VERSION``, which is captured
    once at import — so a long-running worker can notice it has been replaced
    by ``uv tool install --reinstall`` and hand off to the new code.
    """
    try:
        from importlib.metadata import version  # noqa: PLC0415

        return version("token-goat")
    except Exception:  # noqa: BLE001 — PackageNotFoundError or anything else
        return None


def _package_fingerprint() -> str | None:
    """A content fingerprint of the installed token-goat package's code on disk.

    The version-string check alone misses a same-version reinstall — e.g.
    ``uv tool install --reinstall`` during development without a version bump
    rewrites the package files but leaves the version unchanged, so the worker
    keeps running stale code. This hashes (relative path, size, mtime) of every
    ``.py`` file under the package directory, which changes whenever any file is
    rewritten, added, or removed. Best-effort: returns None on any error so the
    daemon falls back to the version-string check rather than crashing.
    """
    try:
        pkg_dir = Path(__file__).parent
        entries = [
            f"{py.relative_to(pkg_dir).as_posix()}:{st.st_size}:{st.st_mtime_ns}"
            for py in sorted(pkg_dir.rglob("*.py"))
            for st in (py.stat(),)
        ]
        return hashlib.sha1("\n".join(entries).encode("utf-8")).hexdigest()
    except Exception:  # noqa: BLE001
        return None


# Version this process booted with. A later _installed_version() that differs
# means the on-disk package was reinstalled under the running worker.
_BOOTED_VERSION = _installed_version()

# Code fingerprint this process booted with. A later _package_fingerprint() that
# differs catches a same-version reinstall that the version check would miss.
_BOOTED_FINGERPRINT = _package_fingerprint()


def _setup_logging() -> None:
    paths.ensure_dirs()
    log_path = paths.logs_dir() / f"{datetime.now():%Y-%m-%d}.log"
    if not _LOG.handlers:
        paths.roll_log_if_oversized(log_path, paths.LOG_FILE_MAX_BYTES)
        handler = logging.FileHandler(log_path, encoding="utf-8")
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        _LOG.addHandler(handler)
        # Console echo only for an interactive run. A detached daemon's stderr
        # is the worker-stderr.log crash sink (see spawn_detached); echoing
        # every INFO line into it would bury a real traceback in routine noise.
        if sys.stderr is not None and sys.stderr.isatty():
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


def drain_dirty_queue() -> list[DirtyQueueEntry]:
    """Atomically claim and return all queued entries.

    The queue is drained by *renaming* dirty.txt to a private ``.draining``
    file before reading it. The previous read-then-truncate lost any line a
    hook appended in the window between the read and the truncate; with the
    rename, a concurrent ``enqueue_dirty`` either appended before the rename
    (its line travels in ``.draining``) or creates a fresh dirty.txt after it
    (picked up next cycle) — it can never be truncated away. A ``.draining``
    file left behind by a worker that crashed mid-drain is recovered on the
    next call.

    Validates each entry is a dict before appending; skips malformed entries
    with a warning.
    """
    _LOG.debug("draining dirty queue")
    p = paths.dirty_queue_path()
    draining = p.with_name(p.name + ".draining")
    raw_lines: list[str] = []

    # Recover entries from a .draining file a previous (crashed) drain abandoned.
    if draining.exists():
        try:
            raw_lines.extend(draining.read_text(encoding="utf-8").splitlines())
            draining.unlink()
            _LOG.debug("recovered %d entries from abandoned .draining file", len(raw_lines))
        except OSError as e:
            _LOG.warning("failed to recover abandoned .draining queue file: %s", e)

    # Atomically claim the live queue. The brief append in enqueue_dirty may
    # still hold dirty.txt open on Windows; retry the rename a few times, then
    # leave the queue for the next poll rather than risk a partial read.
    if p.exists():
        claimed = False
        for _ in range(5):
            try:
                os.replace(p, draining)
                claimed = True
                break
            except OSError:
                time.sleep(0.05)
        if claimed:
            try:
                draining_lines = draining.read_text(encoding="utf-8").splitlines()
                raw_lines.extend(draining_lines)
                draining.unlink()
                _LOG.debug("claimed and read %d fresh queue entries", len(draining_lines))
            except OSError as e:
                _LOG.warning("failed to read/clear drained queue file: %s", e)
        else:
            _LOG.warning("dirty queue busy; deferring drain to next cycle")

    entries: list[DirtyQueueEntry] = []
    malformed_count = 0
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                _LOG.warning("dirty queue entry is not a dict: %s", line[:120])
                malformed_count += 1
                continue
            entries.append(cast(DirtyQueueEntry, entry))
        except json.JSONDecodeError:
            _LOG.warning("bad dirty queue entry (not valid JSON): %s", line[:120])
            malformed_count += 1
    if entries:
        _LOG.info("drained dirty queue: %d valid entries%s", len(entries),
                  f", {malformed_count} malformed" if malformed_count else "")
    return entries


# ---------------------------------------------------------------------------
# Self-healing
# ---------------------------------------------------------------------------

def _cleanup_stale_locks() -> int:
    """Remove stale or malformed lockfiles. Returns count cleared."""
    cleared = 0
    locks = paths.locks_dir()
    if not locks.exists():
        _LOG.debug("locks directory does not exist, skipping cleanup")
        return 0
    total_locks = 0
    for lock_path in locks.glob("*.lock"):
        total_locks += 1
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
                cleared += 1
                reason = "process dead" if dead else "stale (>600s)"
                _LOG.debug("cleared stale lock %s (%s)", lock_path.name, reason)
        except (ValueError, OSError) as e:
            _LOG.debug("removing stale/malformed lock %s: %s", lock_path.name, e)
            try:
                lock_path.unlink()
                cleared += 1
            except OSError as unlink_err:
                _LOG.warning("failed to remove lock %s: %s", lock_path.name, unlink_err)
    if cleared > 0:
        _LOG.debug("stale locks cleanup: cleared %d of %d locks", cleared, total_locks)
    return cleared


def _cleanup_old_logs() -> int:
    """Delete log files older than LOG_RETENTION_DAYS. Returns count deleted."""
    deleted = 0
    logs = paths.logs_dir()
    if not logs.exists():
        _LOG.debug("logs directory does not exist, skipping cleanup")
        return 0
    cutoff = time.time() - LOG_RETENTION_DAYS * 86400
    for log in logs.glob("*.log"):
        try:
            if log.stat().st_mtime < cutoff:
                log.unlink()
                deleted += 1
                _LOG.debug("deleted old log file: %s", log.name)
        except OSError as e:
            _LOG.warning("failed to delete old log %s: %s", log.name, e)
    if deleted > 0:
        _LOG.debug("old logs cleanup: deleted %d files", deleted)
    return deleted


def _prune_stats_table() -> int:
    """Delete stats rows older than STATS_RETENTION_DAYS. Returns row count pruned."""
    from . import db as _db  # noqa: PLC0415
    cutoff_ts = int(time.time() - STATS_RETENTION_DAYS * 86400)
    with _db.open_global() as conn:
        cur = conn.execute("DELETE FROM stats WHERE ts < ?", (cutoff_ts,))
        return cur.rowcount or 0


def cleanup_on_startup() -> CleanupStats:
    """Run all self-healing tasks. Returns stats including any per-task failures."""
    stats: CleanupStats = {
        "stale_locks_cleared": 0,
        "stale_index_markers_cleared": 0,
        "logs_deleted": 0,
        "image_bytes_evicted": 0,
        "image_files_evicted": 0,
        "stats_rows_pruned": 0,
    }
    failures: list[str] = []

    for task_name, task_fn, stat_key in [
        ("stale_locks", _cleanup_stale_locks, "stale_locks_cleared"),
        ("old_logs", _cleanup_old_logs, "logs_deleted"),
        ("stats_prune", _prune_stats_table, "stats_rows_pruned"),
    ]:
        try:
            stats[stat_key] = task_fn()  # type: ignore[literal-required]
        except Exception as exc:  # noqa: BLE001
            _LOG.exception("cleanup task %s failed", task_name)
            failures.append(f"{task_name}: {type(exc).__name__}: {exc}")

    # Stale index-spawn markers — already has its own error handling
    try:
        stats["stale_index_markers_cleared"] = reap_stale_index_markers()
    except Exception as exc:  # noqa: BLE001
        _LOG.exception("cleanup task stale_index_markers failed")
        failures.append(f"stale_index_markers: {type(exc).__name__}: {exc}")

    # Image LRU eviction — already has its own error handling
    try:
        bytes_evicted, files_evicted = evict_image_cache_if_over_limit()
        stats["image_bytes_evicted"] = bytes_evicted
        stats["image_files_evicted"] = files_evicted
    except Exception as exc:  # noqa: BLE001
        _LOG.exception("cleanup task image_eviction failed")
        failures.append(f"image_eviction: {type(exc).__name__}: {exc}")

    if failures:
        stats["failures"] = failures
    return stats


def evict_image_cache_if_over_limit() -> tuple[int, int]:
    """If image cache > IMAGE_CACHE_LIMIT, LRU-evict to IMAGE_CACHE_TARGET.

    Returns (bytes_freed, files_freed).
    """
    img_dir = paths.image_cache_dir()
    if not img_dir.exists():
        _LOG.debug("image cache directory does not exist")
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
        _LOG.debug("image cache size %.1f MB is within limit %.1f MB",
                  total / (1024 * 1024), IMAGE_CACHE_LIMIT / (1024 * 1024))
        return 0, 0
    _LOG.warning("image cache %.1f MB exceeds limit %.1f MB; starting LRU eviction",
                total / (1024 * 1024), IMAGE_CACHE_LIMIT / (1024 * 1024))
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
            _LOG.debug("evicted image cache file: %s (%.1f MB)", f.name, size / (1024 * 1024))
        except OSError as e:
            _LOG.warning("failed to evict cache file %s: %s", f.name, e)
    if bytes_freed > 0:
        _LOG.info("image cache eviction: freed %.1f MB by removing %d files",
                 bytes_freed / (1024 * 1024), files_freed)
    return bytes_freed, files_freed


# ---------------------------------------------------------------------------
# Spawn API (called by SessionStart watchdog)
# ---------------------------------------------------------------------------

def spawn_detached() -> int | None:
    """Spawn the token-goat worker as a detached background process.

    Uses ``pythonw.exe -m token_goat.cli worker --daemon`` rather than the
    launcher .exe so AV/EDR products don't behavior-flag the spawn.
    Returns PID or None on failure.
    """
    from . import paths  # noqa: PLC0415
    cmd = paths.python_runner_argv("worker", "--daemon")

    creationflags = 0
    if sys.platform == "win32":
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        creationflags = 0x00000008 | 0x00000200 | 0x08000000

    # Capture the spawned worker's stderr to a file rather than DEVNULL. A
    # worker that fails before its logging FileHandler is attached — an import
    # error, a crash in _setup_logging — would otherwise die with no trace at
    # all, which is exactly what makes a silent worker death undebuggable.
    stderr_sink: int | IO[Any] = subprocess.DEVNULL
    stderr_file: IO[Any] | None = None
    try:
        stderr_path = paths.logs_dir() / "worker-stderr.log"
        stderr_path.parent.mkdir(parents=True, exist_ok=True)
        paths.roll_log_if_oversized(stderr_path, STDERR_LOG_MAX_BYTES)
        stderr_file = open(stderr_path, "a", encoding="utf-8")  # noqa: SIM115
        stderr_sink = stderr_file
    except OSError as e:
        _LOG.warning("could not open worker stderr log, falling back to DEVNULL: %s", e)

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_sink,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=(sys.platform != "win32"),
        )
        return proc.pid
    except (OSError, FileNotFoundError) as e:
        _LOG.error("failed to spawn worker: %s", e)
        return None
    finally:
        # The child inherited its own handle; the parent's copy is now spare.
        if stderr_file is not None:
            with contextlib.suppress(OSError):
                stderr_file.close()


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


def reap_stale_index_markers() -> int:
    """Delete `.indexing` spawn markers whose index process is gone or hung.

    A marker is kept only while ``_index_spawn_active`` confirms its PID is
    alive *and* within INDEX_SPAWN_TTL — exactly the predicate
    ``spawn_index_detached`` uses to decide a marker means "already indexing".
    Reaping everything that predicate reads as inactive can therefore never
    remove a marker that is still doing its job; it only clears the debris a
    completed or crashed indexer left behind. Returns the number removed.
    """
    locks = paths.locks_dir()
    if not locks.exists():
        return 0
    cleared = 0
    for marker in locks.glob("*.indexing"):
        if _index_spawn_active(marker):
            continue
        try:
            marker.unlink()
            cleared += 1
        except OSError as e:
            _LOG.warning("failed to remove stale index marker %s: %s", marker.name, e)
    return cleared


def spawn_index_detached(project_root: str, project_hash: str) -> int | None:
    """Spawn `token-goat index --full` from the given project root, detached.

    Used by the SessionStart hook to auto-populate a project's symbol DB the
    first time token-goat sees that project. Runs in the background; the user
    or agent's subsequent token-goat commands work as soon as it finishes.

    **Idempotent.** If an index for this project was recently spawned and is
    still running, this is a no-op. Without the guard, every SessionStart hook
    Popen's another ``index --full``; concurrent indexers contend on the 30 s
    writer lock, time out, exit *without writing*, so ``file_count`` stays 0
    and the next session spawns yet another — a runaway pileup (observed in
    the field: 44 concurrent processes, ~41 GB paged memory).

    Uses ``pythonw.exe -m token_goat.cli`` rather than the launcher .exe so
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


def _heartbeat_age() -> float | None:
    """Seconds since the worker last heartbeat, or None if there is no heartbeat file."""
    try:
        return time.time() - paths.worker_heartbeat_path().stat().st_mtime
    except OSError:
        return None


def _is_token_goat_worker(pid: int) -> bool:
    """True if *pid* is a live process whose command line is a token-goat worker.

    Guards against PID recycling: a PID that was recycled to an unrelated
    process after the original worker died must never be terminated.
    """
    try:
        cmdline = " ".join(psutil.Process(pid).cmdline()).lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False
    return "token_goat" in cmdline and "worker" in cmdline


def _live_worker_pid() -> int | None:
    """PID from the pid file, but only if it names a live token-goat-worker process."""
    try:
        pid = int(paths.worker_pid_path().read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return pid if _is_token_goat_worker(pid) else None


def _reap_hung_worker() -> bool:
    """Terminate the worker iff it is alive but its heartbeat proves it is hung.

    Returns True if a process was reaped. A worker whose heartbeat is only
    moderately stale is assumed *busy*, not hung, and is left untouched — only
    a silence beyond WORKER_HUNG_THRESHOLD, which no legitimate main-loop
    operation can produce, justifies killing a live process.
    """
    pid = _live_worker_pid()
    if pid is None:
        return False
    age = _heartbeat_age()
    if age is None or age < WORKER_HUNG_THRESHOLD:
        return False  # no heartbeat file yet, or busy-not-hung — leave it alone
    _LOG.warning("reaping hung worker pid=%s (heartbeat %.0fs stale)", pid, age)
    try:
        proc = psutil.Process(pid)
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except psutil.TimeoutExpired:
            proc.kill()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return True


def ensure_running() -> int | None:
    """Idempotent watchdog: ensure exactly one healthy worker is running.

    Returns the worker PID (existing or freshly spawned), or None on spawn
    failure. Handles four states explicitly:

      * healthy — heartbeat fresh: return its PID, do nothing else.
      * crashed — process gone: clear stale pid/claim state, spawn a new one.
      * hung    — process alive but heartbeat stale beyond any plausible busy
                  period: reap it, then spawn a replacement.
      * busy    — process alive, heartbeat only moderately stale: leave it be.
                  Spawning a duplicate would just lose the claim race and exit,
                  and clearing its pid file would orphan a working daemon.
    """
    if is_worker_alive():
        try:
            return int(paths.worker_pid_path().read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None

    # No *healthy* worker. Reap a hung one if present; otherwise, if a live
    # worker process still exists it is merely busy — don't disturb it.
    reaped = _reap_hung_worker()
    if not reaped:
        busy_pid = _live_worker_pid()
        if busy_pid is not None:
            return busy_pid

    # Either nothing was running, or we just reaped a hung worker. Clear stale
    # pid/claim state so the fresh worker can take the slot cleanly.
    _clear_pid()
    with contextlib.suppress(OSError):
        _worker_claim_path().unlink()
    return spawn_detached()


# ---------------------------------------------------------------------------
# Main run loop (daemon mode)
# ---------------------------------------------------------------------------

def _register_autostart() -> None:
    """Self-register the worker for at-logon autostart (HKCU Run key).

    install_worker_task() otherwise only runs during `token-goat install`; a
    `uv tool install --reinstall` (or a cleared Run key) leaves the worker with
    no autostart, so it survives only as long as a hook keeps respawning it.
    Re-asserting the registration on every startup makes autostart self-healing
    and keeps the registered command current. Fail-soft: a registry error must
    never take the worker down. (Lazy import — install.py imports worker.)
    """
    try:
        from . import install  # noqa: PLC0415

        ok, detail = install.install_worker_task()
        _LOG.info("autostart self-register: %s", detail if ok else f"failed — {detail}")
    except Exception:  # noqa: BLE001
        _LOG.exception("autostart self-register failed")


def run_daemon(stop_event=None) -> None:
    """Compatibility wrapper around :mod:`token_goat.worker_daemon`."""
    from . import worker_daemon  # noqa: PLC0415

    worker_daemon.run_daemon(stop_event=stop_event)


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
    _LOG.debug("starting periodic reindex cycle")
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
        _LOG.debug("periodic reindex: no active projects within window")
        return

    _LOG.info("periodic reindex: %d active project(s) to check", len(rows))
    reindexed_count = 0
    skipped_oversized = 0
    for row in rows:
        if row["file_count"] > PERIODIC_REINDEX_MAX_FILES:
            _LOG.debug(
                "periodic reindex: skipping %s (%d files > %d limit)",
                row["root"],
                row["file_count"],
                PERIODIC_REINDEX_MAX_FILES,
            )
            skipped_oversized += 1
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
                reindexed_count += 1
            else:
                _LOG.debug("periodic reindex: root=%s no changes", row["root"])
        except Exception:  # noqa: BLE001
            _LOG.exception("periodic reindex failed for %s", row["root"])
    _LOG.debug("periodic reindex cycle complete: %d processed, %d skipped (oversized)",
              reindexed_count, skipped_oversized)


def _process_dirty_entries(entries: list[DirtyQueueEntry]) -> None:
    """Re-index files that were marked dirty by Edit/Write hooks."""
    _LOG.debug("processing %d dirty queue entries", len(entries))
    # Group by project_hash, carrying the project root/marker from the first
    # entry that records them. Newer entries (see hooks_cli._enqueue_for_reindex)
    # are self-sufficient: they include project_root/project_marker so a project
    # whose hash is not yet in global.db can still be reconstructed and indexed.
    by_project: dict[str, _ProjectBucket] = {}
    for entry in entries:
        ph = entry.get("project_hash")
        rel = entry.get("path")
        if not ph or not rel:
            _LOG.debug("skipping malformed queue entry (missing hash or path)")
            continue
        if ph not in by_project:
            by_project[ph] = _ProjectBucket(rels=set(), root=None, marker=None)
        bucket = by_project[ph]
        bucket["rels"].add(rel)
        if bucket["root"] is None and entry.get("project_root"):
            bucket["root"] = entry["project_root"]
            bucket["marker"] = entry.get("project_marker") or "manual"

    _LOG.debug("grouped into %d projects", len(by_project))
    # Batch-lookup all project hashes in one global.db query instead of
    # opening global.db once per project (N+1 DB opens).
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

    projects_processed = 0
    for ph, bucket in by_project.items():
        try:
            row = known_projects.get(ph)

            if row:
                project = Project(root=Path(row["root"]), hash=ph, marker=row["marker"])
                # Known project: incremental re-index (SHA-based skip-unchanged logic).
                is_first_index = False
                _LOG.debug("dirty queue: project %s known (root=%s), running incremental index",
                          ph[:8], row["root"])
            elif bucket["root"]:
                # Project not yet registered — the first edit landed before the
                # project was ever indexed. Reconstruct it from the queue entry
                # and run a full index so the edit is not lost.
                # index_project self-registers the project up front.
                project = Project(
                    root=Path(bucket["root"]), hash=ph, marker=bucket["marker"] or "manual"
                )
                is_first_index = True
                _LOG.info(
                    "dirty queue: project %s not yet registered (root=%s); running first index",
                    ph[:8], bucket["root"]
                )
            else:
                # Legacy entry with no project_root recorded — nothing to anchor
                # the reconstruction to. This only happens for entries enqueued
                # before the self-sufficient format; drop with an explicit log.
                _LOG.warning(
                    "dirty queue refers to unknown project hash %s with no root; dropping", ph
                )
                continue

            t0 = time.time()
            result = parser.index_project(project, full=is_first_index)
            elapsed = time.time() - t0
            projects_processed += 1
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
    _LOG.debug("finished processing dirty entries: %d/%d projects reindexed",
              projects_processed, len(by_project))
