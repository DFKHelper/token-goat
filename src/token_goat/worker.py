"""Background worker daemon: dirty-queue polling, self-healing, periodic cleanup."""
from __future__ import annotations

import concurrent.futures
import contextlib
import hashlib
import json
import logging
import operator
import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, TYPE_CHECKING, TypedDict, cast

from .util import env_float, get_logger

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

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

    psutil = _PsutilShim()  # type: ignore[assignment]  # _PsutilShim is a structural stand-in for psutil module; assigned to same name for uniform call sites

from . import db, parser, paths
from .hooks_common import sanitize_log_str
from .project import Project

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator


class CleanupStats(TypedDict, total=False):
    """Result of cleanup_on_startup operation."""

    stale_locks_cleared: int
    stale_index_markers_cleared: int
    logs_deleted: int
    image_bytes_evicted: int
    image_files_evicted: int
    stats_rows_pruned: int
    snapshots_cleared: int
    bash_outputs_evicted: int
    web_outputs_evicted: int
    wal_bytes_reclaimed: int
    project_wal_bytes_reclaimed: int
    orphaned_projects_removed: int
    old_sessions_removed: int
    orphaned_state_files_deleted: int
    old_sentinels_deleted: int
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


_LOG = get_logger("worker")

# Heartbeat interval (seconds)
HEARTBEAT_INTERVAL = 30.0
# Dirty queue poll interval — baseline cadence when the worker is actively draining work.
POLL_INTERVAL = 2.0
# Maximum poll interval (seconds) when the dirty queue has been empty for a long stretch.
# Capped so a freshly enqueued edit still reaches the indexer within this window — long enough
# to meaningfully cut idle wakeups, short enough that interactive feedback stays snappy.
POLL_INTERVAL_MAX = 10.0
# Number of consecutive empty drains before adaptive back-off kicks in. Below this threshold
# the worker stays at POLL_INTERVAL so a single brief lull doesn't slow the next edit's drain.
IDLE_BACKOFF_AFTER_EMPTY_DRAINS = 5
# Periodic maintenance interval (cleanup tasks)
MAINTENANCE_INTERVAL = 300.0  # 5 min
# How often to incrementally re-index active projects.
# Longer than MAINTENANCE_INTERVAL so it does not compete with dirty-queue processing.
PERIODIC_REINDEX_INTERVAL = 600.0  # 10 min
# Skip re-indexing any project that has grown beyond this many files.
# Guards against accidentally indexing a huge directory and thrashing disk.
#
# Tuning note (iter 17): raised from 500 → 2000. The earlier 500-file ceiling
# excluded mid-sized monorepos and frontend projects (a vite/next app with a
# few hundred components plus node_modules-adjacent fixtures easily exceeds
# 500 indexed files). When a project is excluded, the agent loses access to
# `token-goat symbol`/`read`/`section`/`semantic` for that project and falls
# back to the full-file Read tool — the very behaviour token-goat exists to
# avoid. 2000 files keeps a periodic reindex sweep well under a minute on a
# typical SSD while letting realistically-sized real-world projects benefit.
# Tests that assert the old default explicitly monkeypatch this constant so
# they remain pinned to the value they care about.
PERIODIC_REINDEX_MAX_FILES = 2000
# Only periodically re-index projects seen within this window. Bounds the sweep
# to projects actually in use — the `projects` table accumulates every project
# token-goat has ever touched, and reindexing all of them would be wasteful.
PERIODIC_REINDEX_ACTIVE_WINDOW = 7 * 24 * 3600.0  # 7 days

# How many days of granular stats events to keep in global.db before pruning.
# After this many days, rows are deleted from the stats table to keep the DB
# bounded. Aggregate counts/by-day are computed at query time from the
# remaining window, so historical totals beyond this window simply roll off.
STATS_RETENTION_DAYS = 90

# Image cache eviction threshold.  500 MB is large enough to hold thousands of
# compressed screenshots without meaningfully impacting disk usage on a typical
# dev machine, yet small enough that the eviction scan stays fast.  The 80%
# target avoids thrashing: if the limit were the target we would evict one file,
# then immediately hit the limit again on the next write.
IMAGE_CACHE_LIMIT = 500 * 1024 * 1024  # 500 MB
IMAGE_CACHE_TARGET = int(IMAGE_CACHE_LIMIT * 0.8)  # evict to 80% to avoid thrash

# Log retention (days)
LOG_RETENTION_DAYS = 7

# Seconds in one day — used to convert *_RETENTION_DAYS constants to a cutoff
# timestamp without scattering the literal 86400 across multiple functions.
_SECS_PER_DAY = 86_400

# Maximum length of a project_marker value read from the dirty queue.
# project_marker comes from an external file (dirty.txt) and is stored in
# Project.marker and emitted in log messages.  Capping it prevents a crafted
# queue entry from inflating log lines or the projects table with garbage data.
_MAX_QUEUE_MARKER_LEN = 64

# Maximum number of entries to keep in the dirty queue file. When the queue
# grows larger (e.g., worker down for a long time, thousands of auto-saves),
# evict the oldest entries so the queue stays bounded. This prevents unbounded
# disk growth and keeps the queue processing latency predictable. The worker
# drains every 2 s, so 10,000 entries represents ~5 s of rapid edits on a
# heavily loaded machine — ample capacity while still being a safety cap.
DIRTY_QUEUE_MAX_ENTRIES = 10_000
# Byte-size cap for the dirty queue file. Checked via a single stat() call (O(1)) rather than
# reading+counting lines (O(n)). ~200 bytes/entry × 10,000 entries ≈ 2 MB.
DIRTY_QUEUE_MAX_BYTES = 2_000_000

# In-process serialization for dirty-queue appends. The OS file lock (_dirty_queue_lock)
# handles cross-process safety; this lock prevents threads in the same process (test harness,
# in-process plugin bridges) from interleaving their append writes.
_ENQUEUE_DIRTY_LOCK = threading.Lock()

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

# Minimum seconds between worker restart attempts triggered by the post-edit hook
# (_nudge_worker_if_down). Prevents tight restart loops when the worker crashes
# on startup due to a corrupt DB or bad queue entry. The watchdog will still
# restart on the next edit, but at most once per this interval.
WORKER_RESTART_THROTTLE_SECS = 30.0

# Maximum seconds to allow a single file-index call to run before cancelling it.
# Prevents worker hang on pathologically large generated files (e.g. a 50 MB
# minified JS bundle). Overridable via TOKEN_GOAT_INDEX_TIMEOUT_SECS env var.
# The default 30 s gives tree-sitter plenty of time on realistic source files.
INDEX_TIMEOUT_SECS: float = env_float("TOKEN_GOAT_INDEX_TIMEOUT_SECS", 30.0, lo=0.1)

# Worker RSS threshold (MB) above which indexing is suspended and only eviction
# runs, preventing OOM on repos with many large files.
# Overridable via TOKEN_GOAT_MEMORY_PRESSURE_MB env var.
MEMORY_PRESSURE_THRESHOLD_MB: float = env_float("TOKEN_GOAT_MEMORY_PRESSURE_MB", 500.0, lo=1.0)

# Consecutive failures before exponential backoff kicks in (per path).
_BACKOFF_FAILURE_THRESHOLD = 3
# Base back-off delay (seconds); actual delay is 2^(failures - threshold) * base.
_BACKOFF_BASE_SECS = 2.0
# Cap on back-off delay per path.
_BACKOFF_MAX_SECS = 300.0  # 5 minutes

# In-memory per-path failure counters and backoff expiry times.
# Keyed by (project_hash, rel_path) so the same file in different projects
# is tracked independently. Reset when the worker restarts.
_index_failure_counts: dict[tuple[str, str], int] = {}
_index_backoff_until: dict[tuple[str, str], float] = {}


def _installed_version() -> str | None:
    """The token-goat version currently installed on disk.

    Read fresh on every call — unlike ``_BOOTED_VERSION``, which is captured
    once at import — so a long-running worker can notice it has been replaced
    by ``uv tool install --reinstall`` and hand off to the new code.
    """
    try:
        from importlib.metadata import version

        return version("token-goat")
    except Exception:
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
        # Generator expression fed directly into "\n".join — avoids building an
        # intermediate list of N formatted strings before hashing.  The nested
        # `for st in (py.stat(),)` captures the stat() result exactly once per
        # file, the same technique used in the original list comprehension.
        return hashlib.sha1(
            "\n".join(
                f"{py.relative_to(pkg_dir).as_posix()}:{st.st_size}:{st.st_mtime_ns}"
                for py in sorted(pkg_dir.rglob("*.py"))
                for st in (py.stat(),)
            ).encode("utf-8")
        ).hexdigest()
    except (OSError, ValueError) as e:
        # OSError: rglob/stat filesystem errors; ValueError: relative_to() path escapes pkg_dir.
        _LOG.debug("package fingerprint unavailable (falling back to version-string check): %s", e)
        return None


# Version this process booted with. A later _installed_version() that differs
# means the on-disk package was reinstalled under the running worker.
_BOOTED_VERSION = _installed_version()

# Code fingerprint this process booted with. A later _package_fingerprint() that
# differs catches a same-version reinstall that the version check would miss.
_BOOTED_FINGERPRINT = _package_fingerprint()


# ---------------------------------------------------------------------------
# Memory pressure helpers
# ---------------------------------------------------------------------------


def _get_rss_mb() -> float | None:
    """Return the worker process's current RSS in MB, or None if unavailable.

    Uses psutil when available; returns None on the stub shim so callers see
    "unavailable" rather than 0, which they can treat as "not under pressure".
    Falls back to None on any error so the memory guard never blocks indexing
    when the check itself fails.
    """
    try:
        proc = psutil.Process(os.getpid())
        # rss is in bytes on all platforms psutil supports.
        return proc.memory_info().rss / (1024 * 1024)
    except Exception:
        return None


def _is_under_memory_pressure() -> bool:
    """Return True when worker RSS exceeds MEMORY_PRESSURE_THRESHOLD_MB.

    When True the caller should skip CPU/memory-intensive indexing and only
    run lightweight eviction tasks until memory drops back below the threshold.
    Returns False when the RSS cannot be determined (psutil unavailable or
    error) so a degraded environment never incorrectly suppresses indexing.
    """
    rss = _get_rss_mb()
    if rss is None:
        return False
    over = rss > MEMORY_PRESSURE_THRESHOLD_MB
    if over:
        _LOG.warning(
            "memory pressure: RSS=%.1f MB exceeds threshold %.1f MB; "
            "skipping indexing until memory drops",
            rss,
            MEMORY_PRESSURE_THRESHOLD_MB,
        )
    return over


# ---------------------------------------------------------------------------
# Per-file indexing backoff helpers
# ---------------------------------------------------------------------------


def _should_skip_due_to_backoff(project_hash: str, rel_path: str) -> bool:
    """Return True if this (project, path) is in an active backoff window.

    Called before each file index attempt. When True, the caller should skip
    the file entirely this cycle; it will be retried once the backoff expires.
    Logs a debug message so the skip is visible in the worker log.
    """
    key = (project_hash, rel_path)
    until = _index_backoff_until.get(key, 0.0)
    now = time.time()
    if now < until:
        _LOG.debug(
            "backoff active for %s/%s: %.0fs remaining",
            project_hash[:8],
            rel_path,
            until - now,
        )
        return True
    return False


def _record_index_failure(project_hash: str, rel_path: str) -> None:
    """Increment the failure counter for (project, path) and set backoff.

    The first two failures are retried immediately.  Starting at the third
    consecutive failure, exponential back-off is applied:
    ``delay = min(2^(n - threshold) * base, cap)`` where n is the failure count.
    Resets to a clean state when a successful index clears the counter (see
    _record_index_success).
    """
    key = (project_hash, rel_path)
    count = _index_failure_counts.get(key, 0) + 1
    _index_failure_counts[key] = count
    if count >= _BACKOFF_FAILURE_THRESHOLD:
        exponent = count - _BACKOFF_FAILURE_THRESHOLD
        delay = min(_BACKOFF_BASE_SECS ** exponent * _BACKOFF_BASE_SECS, _BACKOFF_MAX_SECS)
        _index_backoff_until[key] = time.time() + delay
        _LOG.warning(
            "index failure #%d for %s/%s; backing off %.0fs",
            count,
            project_hash[:8],
            rel_path,
            delay,
        )


def _record_index_success(project_hash: str, rel_path: str) -> None:
    """Clear the failure counter and backoff for (project, path) after success."""
    key = (project_hash, rel_path)
    _index_failure_counts.pop(key, None)
    _index_backoff_until.pop(key, None)


def _setup_logging() -> None:
    """Configure the worker's logger for the current process.

    Attaches a daily rotating ``FileHandler`` (``logs/{YYYY-MM-DD}.log``) and,
    when running interactively (``stderr.isatty()``), a ``StreamHandler`` for
    console echo.  The detached daemon must not echo to stderr because that
    file is the crash sink (``worker-stderr.log``); mixing routine INFO lines
    with crash tracebacks makes post-mortem diagnosis much harder.

    Idempotent: does nothing if handlers are already attached (guards against
    double-initialisation when the function is called more than once in tests).
    """
    paths.ensure_dirs()
    log_path = paths.logs_dir() / f"{datetime.now():%Y-%m-%d}.log"
    if not _LOG.handlers:
        paths.roll_log_if_oversized(log_path, paths.LOG_FILE_MAX_BYTES)
        handler = paths.open_log_file(log_path)
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

HEARTBEAT_GRACE_SECONDS = 5.0
"""Extra seconds of leniency beyond 2× HEARTBEAT_INTERVAL before a heartbeat is
considered stale.  Accounts for scheduler jitter and slow disk writes without
requiring a large primary interval."""


def heartbeat_stale_threshold() -> float:
    """Seconds after which a heartbeat is considered stale by the watchdog.

    The single source of truth for "is the worker still ticking?": derived
    from :data:`HEARTBEAT_INTERVAL` so a future tune of the interval flows
    through every call site without leaving a stale magic number behind.

    Two intervals of leeway means the watchdog tolerates one missed write
    (e.g. transient disk latency, GC pause, single-cycle worker stall);
    :data:`HEARTBEAT_GRACE_SECONDS` adds a small fixed cushion for scheduler
    jitter so a worker that wakes up exactly on the boundary is not falsely
    declared stale.
    """
    return 2 * HEARTBEAT_INTERVAL + HEARTBEAT_GRACE_SECONDS


def heartbeat_age(hb_path: Path | None = None) -> float | None:
    """Seconds since the heartbeat file was last written, or ``None`` if it does
    not exist (or could not be stat'ed).

    Centralises the ``time.time() - hb_path.stat().st_mtime`` idiom that
    every liveness call site previously inlined — three independent copies
    (``_is_heartbeat_fresh``, ``_heartbeat_age``, ``_nudge_worker_if_down``,
    ``cli_doctor``) had drifted into magic-number duplicates.
    """
    path = hb_path or paths.worker_heartbeat_path()
    try:
        return time.time() - path.stat().st_mtime
    except OSError:
        return None


def is_heartbeat_stale_for_nudge(hb_path: Path | None = None) -> bool:
    """True if the heartbeat is older than :func:`heartbeat_stale_threshold` —
    i.e. the post-edit hook should respawn the worker via
    :func:`ensure_running`.

    A missing heartbeat file is also treated as stale: the worker either
    never started or crashed before its first heartbeat write. The same
    response (try to ensure_running) is correct in both cases.
    """
    age = heartbeat_age(hb_path)
    if age is None:
        return True
    return age > heartbeat_stale_threshold()


def _is_heartbeat_fresh(hb_path: Path) -> bool:
    """Check if heartbeat file exists and is recent (within 2x interval + grace).

    Inverse of :func:`is_heartbeat_stale_for_nudge`, but ``False`` rather
    than ``True`` when the file is missing — the missing-file case here is
    a separate signal handled by :func:`is_worker_alive` (startup grace
    window applies instead).
    """
    if not hb_path.exists():
        return False
    age = heartbeat_age(hb_path)
    if age is None:
        return False
    return age <= heartbeat_stale_threshold()


def _is_process_recent(pid: int) -> bool:
    """Check if process exists and is younger than startup grace window."""
    try:
        p = psutil.Process(pid)
        age = time.time() - p.create_time()
        return age <= WORKER_STARTUP_GRACE
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError) as exc:
        _LOG.debug("_is_process_recent pid=%s err=%s", pid, exc)
        return False


def is_worker_alive() -> bool:
    """True if the PID file exists, points to a live token-goat process, and
    heartbeat is fresh.

    Validates that the PID is still alive. Additionally, verifies the process
    is a token-goat worker (not a recycled PID from an unrelated process) when
    the cmdline can be read. If cmdline cannot be read (permission denied,
    sandboxed, test runner), the presence of a heartbeat file is considered
    sufficient proof of a live worker.

    This catches the race where a worker dies and its PID is recycled to an
    unrelated process (e.g. background task), while remaining lenient for test
    scenarios where we cannot inspect the actual cmdline.
    """
    pid_path = paths.worker_pid_path()
    if not pid_path.exists():
        return False
    try:
        pid, _interp = _read_pid_info(pid_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return False

    if not psutil.pid_exists(pid):
        return False

    # Attempt cmdline verification to catch PID recycling. When running under
    # tests (pytest, etc.) the process won't match "token_goat worker" in the
    # cmdline, but a fresh heartbeat in that case proves a *live* process was
    # checking in, so we accept it.
    try:
        p = psutil.Process(pid)
        cmdline = " ".join(p.cmdline()).lower()
        # If cmdline is readable but doesn't contain token_goat worker, reject
        # (PID was likely recycled to an unrelated process).
        if "token_goat" not in cmdline or "worker" not in cmdline:
            _LOG.debug("is_worker_alive: PID %d is alive but cmdline does not match token-goat worker",
                      pid)
            return False
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        # Cannot read cmdline. In tests or restricted environments, a fresh
        # heartbeat proves a live process was running token-goat logic.
        pass

    # Check heartbeat freshness or startup grace period
    hb_path = paths.worker_heartbeat_path()
    if hb_path.exists():
        return _is_heartbeat_fresh(hb_path)

    # No heartbeat yet — worker is still starting up
    return _is_process_recent(pid)


def _read_pid_info(pid_text: str) -> tuple[int, str | None]:
    """Parse the worker PID file content and return ``(pid, interpreter_or_None)``.

    Accepts two formats:

    * **Legacy** — a bare integer string (``"12345"`` or ``"12345\\n"``).  Returns
      ``(pid, None)`` for backward compatibility with PID files written by older
      versions of token-goat.

    * **JSON** — ``{"pid": N, "started_at": "...", "interpreter": "/path", "version": "..."}``.
      Returns ``(pid, interpreter_path)`` so callers can display which Python
      executable owns the worker slot.

    Raises ``ValueError`` on malformed input so callers can fall through to the
    "pid file unreadable" branch.
    """
    text = pid_text.strip()
    if text.startswith("{"):
        data = json.loads(text)
        pid = int(data["pid"])
        interpreter = data.get("interpreter") or None
        return pid, interpreter
    # Legacy plain-integer format
    return int(text), None


def _write_pid() -> None:
    """Write the current process ID to the worker PID file for liveness tracking.

    The PID file is written as a JSON object so that startup guards can compare
    the running interpreter path against a concurrent process and surface the
    conflict to users via ``token-goat doctor``.  The format is backward-
    compatible: :func:`_read_pid_info` accepts both the new JSON form and the
    legacy plain-integer format written by older versions.
    """
    import importlib.metadata as _meta

    try:
        version = _meta.version("token-goat")
    except _meta.PackageNotFoundError:
        version = "unknown"

    payload = json.dumps({
        "pid": os.getpid(),
        "started_at": datetime.now(tz=UTC).isoformat(),
        "interpreter": sys.executable,
        "version": version,
    })
    paths.atomic_write_text(paths.worker_pid_path(), payload)


def _heartbeat() -> None:
    """Write current timestamp to heartbeat file to indicate the worker is alive."""
    paths.atomic_write_text(paths.worker_heartbeat_path(), str(time.time()))


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
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError) as exc:
        _LOG.debug("_proc_create_time pid=%s err=%s", pid, exc)
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

    An empty / malformed claim is treated as NOT stale during the brief
    startup window (the gap between the O_EXCL create and the single write is
    microscopic). However, if the mtime of the file is older than 60 seconds
    the owner never finished writing — it died mid-startup — so the claim is
    treated as a zombie and cleared.
    """
    try:
        pid_str, ct_str = claim_path.read_text(encoding="utf-8").split("\n", 1)
        pid, claimed_ct = int(pid_str), float(ct_str.strip())
    except (OSError, ValueError):
        # Empty or malformed content.  Check file age to detect zombie claims
        # left by workers that were killed between O_EXCL create and os.write.
        try:
            mtime = os.stat(claim_path).st_mtime
        except OSError:
            return False  # file vanished — treat as not stale (nothing to clear)
        age = time.time() - mtime
        if age > 60:
            _LOG.warning(
                "clearing zombie claim file: %s (mtime age %.1fs)",
                claim_path,
                age,
            )
            return True
        return False  # mid-startup grace window
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
    paths.ensure_dir(claim_path.parent)
    for attempt in (1, 2):
        try:
            # 0o600: owner-only — the claim file holds a PID and process
            # create-time that should not be readable by other local users.
            fd = os.open(str(claim_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
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
        # On write failure, close the fd and remove the empty file: an orphaned empty claim is treated as not-stale and would wedge the worker slot forever.
        try:
            create_time = _proc_create_time(os.getpid()) or time.time()
            os.write(fd, f"{os.getpid()}\n{create_time}".encode())
        except OSError as e:
            os.close(fd)
            with contextlib.suppress(OSError):
                claim_path.unlink()
            _LOG.warning("failed to populate worker claim file: %s", e)
            return None
        return fd
    return None


# ---------------------------------------------------------------------------
# Dirty queue
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _dirty_queue_lock(lock_path: Path) -> Iterator[bool]:
    """Context manager for acquiring an exclusive lock on the dirty queue.

    Uses OS-level locking (fcntl.flock on POSIX, msvcrt.locking on Windows).
    Yields ``True`` when the lock was acquired and ``False`` on timeout/failure
    (still yields, so the caller decides whether to proceed unlocked or drop the
    write). The previous unconditional yield let a Windows lock-timeout writer
    interleave its truncate+rewrite with another writer, producing torn lines.
    """
    fd = None
    lock_acquired = False

    try:
        # Ensure lock file exists
        paths.ensure_dir(lock_path.parent)
        lock_path.touch(exist_ok=True)

        if sys.platform == "win32":
            # Windows: LK_NBLCK with retry loop and 200 ms timeout.
            end_time = time.time() + 0.2
            while True:
                try:
                    fd = os.open(str(lock_path), os.O_RDWR)
                    try:
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        lock_acquired = True
                        break
                    except OSError:
                        os.close(fd)
                        fd = None
                        if time.time() >= end_time:
                            _LOG.debug("dirty queue lock timeout; writing unlocked (best-effort)")
                            break
                        time.sleep(0.001)
                except OSError as e:
                    if time.time() >= end_time:
                        _LOG.debug("failed to open dirty queue lock file: %s (best-effort)", e)
                        break
                    time.sleep(0.001)
        else:
            # POSIX: fcntl.flock (blocking).
            # Use 0o600 (owner-only) so the lock file is not world-readable or
            # world-writable.  0o666 would let any local user truncate or corrupt
            # the lock file, which could disrupt the worker's exclusive-write
            # guarantee on shared systems.
            try:
                fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
                fcntl.flock(fd, fcntl.LOCK_EX)
                lock_acquired = True
            except OSError as e:
                _LOG.debug("fcntl.flock on dirty queue failed: %s; writing unlocked (best-effort)", e)

        yield lock_acquired  # caller decides whether to write when not acquired

    finally:
        if lock_acquired and fd is not None:
            try:
                with contextlib.suppress(OSError):
                    if sys.platform == "win32":
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                with contextlib.suppress(OSError):
                    os.close(fd)
        elif fd is not None:
            with contextlib.suppress(OSError):
                os.close(fd)


def enqueue_dirty(
    rel_path: str,
    project_hash: str | None = None,
    *,
    project_root: str | None = None,
    project_marker: str | None = None,
) -> None:
    """Append a dirty path to the queue. Used by hooks after Edit/Write.

    The optional *project_root* and *project_marker* fields are written when
    the caller has already resolved the project (e.g. the post-edit hook).
    When omitted the worker resolves the project itself from *project_hash*.

    Append-only: never reads or rewrites the existing queue file. This eliminates
    the POSIX rename-vs-truncate race that could lose entries. The byte-size cap
    is enforced via a single stat() call (O(1)) rather than reading all entries.
    Entry deduplication happens in drain_dirty_queue where it's already needed.
    """
    paths.ensure_dir(paths.dirty_queue_path().parent)
    entry: dict[str, object] = {"path": rel_path, "project_hash": project_hash, "ts": time.time()}
    if project_root is not None:
        entry["project_root"] = project_root
    if project_marker is not None:
        entry["project_marker"] = project_marker
    line = json.dumps(entry)

    queue_path = paths.dirty_queue_path()
    lock_path = queue_path.parent / ".dirty_queue.lock"
    with _ENQUEUE_DIRTY_LOCK, _dirty_queue_lock(lock_path) as lock_acquired:
        if not lock_acquired:
            _LOG.debug("dirty queue OS lock not acquired; dropping entry (fail-soft): %s", rel_path)
            return

        # Byte-size cap: single stat() instead of reading all entries.
        with contextlib.suppress(OSError):
            if queue_path.exists() and queue_path.stat().st_size >= DIRTY_QUEUE_MAX_BYTES:
                _LOG.info("dirty queue byte cap reached (%d B); dropping entry: %s", DIRTY_QUEUE_MAX_BYTES, rel_path)
                return

        try:
            with queue_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            _LOG.warning("failed to write dirty queue: %s", e)


def adaptive_poll_interval(consecutive_empty_drains: int) -> float:
    """Return the sleep interval for the daemon main loop given how long it has been idle.

    Stays at :data:`POLL_INTERVAL` until the queue has been empty for
    :data:`IDLE_BACKOFF_AFTER_EMPTY_DRAINS` consecutive drain cycles, then grows linearly
    with the number of additional empty drains, capped at :data:`POLL_INTERVAL_MAX`.

    The linear ramp (rather than exponential) keeps the worst-case latency between an edit
    and its reindex bounded and predictable, while still cutting idle wakeups noticeably for
    a worker that is genuinely idle for minutes at a time. Resets to :data:`POLL_INTERVAL`
    on the very next non-empty drain (caller is responsible for tracking the counter).
    """
    if consecutive_empty_drains < IDLE_BACKOFF_AFTER_EMPTY_DRAINS:
        return POLL_INTERVAL
    # +1 so the first eligible drain steps strictly above POLL_INTERVAL.
    extra = consecutive_empty_drains - IDLE_BACKOFF_AFTER_EMPTY_DRAINS + 1
    return min(POLL_INTERVAL_MAX, POLL_INTERVAL + extra * POLL_INTERVAL)


def drain_dirty_queue() -> list[DirtyQueueEntry] | None:
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
    with a warning.  Binary or non-UTF-8 bytes in the queue file are replaced
    with the Unicode replacement character (``errors="replace"``), so a corrupt
    queue file produces malformed JSON lines (which are counted and skipped)
    rather than raising ``UnicodeDecodeError`` and crashing the worker.

    Returns a (possibly empty) list of entries on a successful drain, or
    ``None`` when the drain was *deferred* — the live dirty.txt existed but
    could not be claimed (a Windows ``ERROR_SHARING_VIOLATION`` from a
    concurrent ``enqueue_dirty``). ``None`` means "work is still pending,
    retry soon"; an empty list means "genuinely nothing queued". The caller
    relies on that distinction so adaptive idle back-off does not treat a
    deferred drain as a quiet cycle.
    """
    _LOG.debug("draining dirty queue")
    p = paths.dirty_queue_path()
    draining = p.with_name(p.name + ".draining")
    raw_lines: list[str] = []
    deferred = False  # set when a live dirty.txt existed but could not be claimed

    # Recover entries from a .draining file a previous (crashed) drain abandoned.
    if draining.exists():
        try:
            raw_lines.extend(draining.read_text(encoding="utf-8", errors="replace").splitlines())
            draining.unlink()
            _LOG.info("recovered %d entries from abandoned .draining file: %s",
                      len(raw_lines), draining.name)
        except OSError as e:
            # Quarantine the unreadable file so the fresh-queue rename below does not silently overwrite it.
            corrupt = draining.with_suffix(f".corrupt-{int(time.time())}")
            try:
                draining.rename(corrupt)
                _LOG.warning("quarantined unreadable .draining file as %s: %s", corrupt.name, e)
            except OSError as rename_err:
                # Can't quarantine — skip this cycle to avoid overwriting the file.
                _LOG.error(
                    "cannot quarantine .draining file, skipping drain cycle: %s (read error: %s)",
                    rename_err, e,
                )
                return None

    # Atomically claim the live queue. On POSIX, os.replace() is atomic even
    # across open writers (they keep appending to the old inode; the rename just
    # redirects the name).  On Windows, a concurrent enqueue_dirty that has
    # dirty.txt open for append will cause os.replace() to fail with
    # ERROR_SHARING_VIOLATION; retry a few times, then defer to the next poll
    # rather than risk a partial read.
    if p.exists():
        claimed = False
        last_replace_err: OSError | None = None
        for _ in range(5):
            try:
                os.replace(p, draining)
                claimed = True
                break
            except OSError as _e:
                last_replace_err = _e
                time.sleep(0.05)
        if claimed:
            try:
                draining_lines = draining.read_text(encoding="utf-8", errors="replace").splitlines()
                raw_lines.extend(draining_lines)
                draining.unlink()
                _LOG.debug("claimed and read %d fresh queue entries", len(draining_lines))
            except OSError as e:
                _LOG.warning("failed to read/clear drained queue file: %s", e)
        else:
            deferred = True
            _LOG.warning(
                "dirty queue busy after 5 retries; deferring drain to next cycle (%s)",
                last_replace_err,
            )

    raw_entries: list[DirtyQueueEntry] = []
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
            raw_entries.append(cast("DirtyQueueEntry", entry))
        except json.JSONDecodeError:
            _LOG.warning("bad dirty queue entry (not valid JSON): %s", line[:120])
            malformed_count += 1

    # Deduplicate by (project_hash, path): rapid auto-save / format-on-save
    # events append the same path many times in one poll cycle, but re-indexing
    # the current file state once is enough.  dict.fromkeys preserves insertion
    # order (first occurrence wins) so the project-root/marker metadata carried
    # by the first entry for each project is retained.
    seen: dict[tuple[str, str], None] = {}
    entries: list[DirtyQueueEntry] = []
    for entry in raw_entries:
        key = (entry.get("project_hash", ""), entry.get("path", ""))
        if key not in seen:
            seen[key] = None
            entries.append(entry)
    dupes = len(raw_entries) - len(entries)

    if entries:
        _LOG.info(
            "drained dirty queue: %d valid entries%s%s",
            len(entries),
            f" ({dupes} dupes removed)" if dupes else "",
            f", {malformed_count} malformed" if malformed_count else "",
        )
        return entries
    if deferred:
        # No entries and the live queue couldn't be claimed — return None so the caller knows work is still pending and doesn't count this as an idle cycle.
        return None
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
    # Cache the current time once before the loop — avoids a syscall per lock file.
    now = time.time()
    for lock_path in locks.glob("*.lock"):
        total_locks += 1
        try:
            content = lock_path.read_text(encoding="utf-8")
            pid_str = content.split("\n", 1)[0].strip()
            if not pid_str:
                raise ValueError(f"empty PID in lock file {lock_path.name!r}")
            pid = int(pid_str)
            owner_is_dead = not psutil.pid_exists(pid)
            lock_is_stale = now - lock_path.stat().st_mtime > db.LOCK_STALE_SECONDS
            if owner_is_dead or lock_is_stale:
                lock_path.unlink()
                cleared += 1
                reason = "owner dead" if owner_is_dead else "stale (>600s)"
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
    cutoff = time.time() - LOG_RETENTION_DAYS * _SECS_PER_DAY
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
    """Delete granular stats events older than STATS_RETENTION_DAYS from global.db.

    Keeps the stats table bounded so long-running daemons don't accumulate
    unbounded history.  Aggregate totals shown by ``token-goat stats`` are
    computed at query time from the rows that remain; events older than the
    retention window simply roll off.  Returns the number of rows deleted.

    Raises ``db.DBError`` or ``sqlite3.DatabaseError`` on DB failure so the
    caller (``cleanup_on_startup``) can record the failure in its summary and
    continue with the remaining tasks.
    """
    from . import db as _db
    cutoff_ts = int(time.time() - STATS_RETENTION_DAYS * _SECS_PER_DAY)
    try:
        with _db.open_global() as conn:
            cur = conn.execute("DELETE FROM stats WHERE ts < ?", (cutoff_ts,))
            pruned = cur.rowcount or 0
            _LOG.debug("stats prune: deleted %d rows older than %d days", pruned, STATS_RETENTION_DAYS)
            return pruned
    except (_db.DBError, sqlite3.DatabaseError, OSError) as exc:
        _LOG.warning("stats prune failed (global.db unavailable): %s", exc)
        raise


def _cleanup_stale_snapshots() -> int:
    """Drop per-session content snapshots older than 24 hours.

    Run from :func:`cleanup_on_startup` because the diff-aware re-read store
    accumulates one directory per session.  Without periodic eviction these
    pile up across long-lived installations even though most are tied to
    sessions that ended hours ago.
    """
    from . import snapshots

    return snapshots.cleanup_stale(max_age_hours=24.0)


def _evict_bash_outputs() -> int:
    """Enforce the on-disk bash-output store byte cap.

    The post-bash hook also calls this opportunistically after every write,
    but the startup pass picks up the slack when many small writes leave the
    directory slightly over budget at shutdown time.  Returns the number of
    cache files removed.
    """
    from . import bash_cache, config

    cfg = config.load().bash_compress
    return bash_cache.evict_old_entries(
        max_total_bytes=cfg.cache_max_bytes,
        max_file_count=cfg.cache_max_file_count,
    )


def _evict_web_outputs() -> int:
    """Enforce the on-disk web-output store byte cap.

    The post-WebFetch hook calls this opportunistically after every write, but
    if that eviction is suppressed by a transient OSError (e.g. AV lock on
    Windows), the directory can silently exceed its byte and file-count caps
    until the next write.  This startup/maintenance pass closes that gap.
    Returns the number of cache files removed.
    """
    from . import config, web_cache

    cfg = config.load().webfetch
    return web_cache.evict_old_entries(
        max_total_bytes=cfg.max_bytes,
        max_file_count=cfg.max_file_count,
    )


def _checkpoint_global_wal() -> int:
    """Force a TRUNCATE checkpoint of global.db's WAL, returning bytes reclaimed.

    Every hook in every project writes stat rows to ``global.db``, so its WAL
    is the one that outgrows passive autocheckpoints under a heavy multi-agent
    burst — each autocheckpoint blocked by an overlapping reader.  Left alone
    the file reached 11 GB, after which every connection that scanned it
    stalled for minutes.  ``db.WAL_SIZE_LIMIT_BYTES`` on every connection caps
    the file; this checkpoint, run from the single long-lived worker on each
    maintenance cycle, is the active backstop that drains it on a schedule.
    """
    wal_path = paths.global_db_path()
    wal_path = wal_path.with_name(wal_path.name + "-wal")
    before = wal_path.stat().st_size if wal_path.exists() else 0
    with db.open_global() as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    after = wal_path.stat().st_size if wal_path.exists() else 0
    reclaimed = max(0, before - after)
    if reclaimed:
        _LOG.info("WAL checkpoint reclaimed %d bytes from global.db-wal", reclaimed)
    return reclaimed


def _checkpoint_project_wals() -> int:
    """TRUNCATE-checkpoint the WAL for every active project DB, returning total bytes reclaimed.

    global.db is checkpointed by ``_checkpoint_global_wal``; per-project DBs are
    written on every reindex pass but never explicitly checkpointed, so their WAL
    files can grow unboundedly when passive autocheckpoints are blocked by readers.
    """
    reclaimed = 0
    try:
        with db.open_global_readonly() as gconn:
            hashes = [
                row[0]
                for row in gconn.execute("SELECT hash FROM projects").fetchall()
            ]
    except (db.DBError, sqlite3.DatabaseError, OSError):
        _LOG.debug("_checkpoint_project_wals: could not list projects; skipping")
        return 0
    for project_hash in hashes:
        db_path = paths.project_db_path(project_hash)
        wal_path = db_path.with_name(db_path.name + "-wal")
        if not wal_path.exists():
            continue
        before = wal_path.stat().st_size
        try:
            with db.open_project(project_hash) as conn:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            _LOG.debug("_checkpoint_project_wals: checkpoint failed for %s", project_hash)
            continue
        after = wal_path.stat().st_size if wal_path.exists() else 0
        reclaimed += max(0, before - after)
    if reclaimed:
        _LOG.info(
            "WAL checkpoint reclaimed %d bytes across %d project DBs",
            reclaimed, len(hashes),
        )
    return reclaimed


# Projects whose root directory has been missing for less than this many seconds
# are spared from GC — covers brief in-progress test runs that create and delete
# temp dirs, as well as network-mounted drives that may be temporarily unavailable.
_GC_PROJECTS_SAFETY_WINDOW = 1800.0  # 30 minutes

# How often to run the orphan-project GC pass in the running daemon (in addition
# to the once-per-startup pass inside cleanup_on_startup).
GC_PROJECTS_INTERVAL = 3600.0  # 1 hour


def _gc_orphaned_projects() -> int:
    """Delete global.db project rows (and their on-disk .db files) whose root dirs no longer exist.

    Safety: projects whose ``last_seen`` timestamp is within the last
    ``_GC_PROJECTS_SAFETY_WINDOW`` seconds are skipped so short-lived test
    temp-dirs and brief network-mount outages are never accidentally pruned.

    Returns the number of project rows removed.
    """
    removed = 0
    now = time.time()
    safety_cutoff = now - _GC_PROJECTS_SAFETY_WINDOW
    try:
        with db.open_global() as gconn:
            rows = gconn.execute(
                "SELECT hash, root, last_seen FROM projects"
            ).fetchall()
    except (db.DBError, sqlite3.DatabaseError, OSError) as exc:
        _LOG.warning("_gc_orphaned_projects: could not read projects table: %s", exc)
        return 0

    for row in rows:
        project_hash = row["hash"]
        root = row["root"]
        last_seen = float(row["last_seen"])

        # Safety window: skip recently-active projects even if the dir is gone.
        if last_seen > safety_cutoff:
            _LOG.debug("_gc_orphaned_projects: skipping recent project %s (last_seen %.0fs ago)", root, now - last_seen)
            continue

        if Path(root).is_dir():
            continue

        # Root directory is gone and outside the safety window — remove the row
        # and the on-disk DB file (plus WAL / SHM sidecars).
        #
        # TOCTOU guard: a concurrent SessionStart may have called
        # touch_project_last_seen() between the snapshot read above and this
        # DELETE.  Restrict the DELETE to rows whose last_seen is still at or
        # before the safety_cutoff so the concurrent touch is not overwritten.
        _LOG.info("_gc_orphaned_projects: removing orphaned project root=%s hash=%s", root, project_hash)
        try:
            with db.open_global() as gconn:
                cur = gconn.execute(
                    "DELETE FROM projects WHERE hash = ? AND last_seen <= ?",
                    (project_hash, safety_cutoff),
                )
                if cur.rowcount == 0:
                    # A concurrent touch bumped last_seen into the safety window;
                    # leave the row in place and skip the DB-file removal.
                    _LOG.debug(
                        "_gc_orphaned_projects: skipping %s — last_seen updated concurrently",
                        project_hash,
                    )
                    continue
        except (db.DBError, sqlite3.DatabaseError, OSError) as exc:
            _LOG.warning("_gc_orphaned_projects: could not delete row for %s: %s", project_hash, exc)
            continue

        # Remove per-project DB files; ignore individual errors so a locked file
        # does not abort cleanup of the remaining orphans.
        try:
            db_path = paths.project_db_path(project_hash)
        except ValueError:
            _LOG.warning("_gc_orphaned_projects: invalid project hash %r — skipping file removal", project_hash)
            removed += 1
            continue
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(db_path) + suffix) if suffix else db_path
            if candidate.exists():
                try:
                    candidate.unlink()
                    _LOG.debug("_gc_orphaned_projects: deleted %s", candidate)
                except OSError as exc:
                    _LOG.warning("_gc_orphaned_projects: could not delete %s: %s", candidate, exc)
        removed += 1

    if removed:
        _LOG.info("_gc_orphaned_projects: removed %d orphaned project(s)", removed)
    return removed


_SESSION_RETENTION_DAYS = 7
# How many days to retain orphaned improve-state files.
_IMPROVE_STATE_RETENTION_DAYS = 7
# How many days to retain sentinel files (manifest_sha, recovery_pending, etc.).
_SENTINEL_RETENTION_DAYS = 30


def _cleanup_orphaned_state_files() -> int:
    """Delete orphaned .improve-state-*.json files older than 7 days.

    The /improve skill creates .improve-state-{slug}.json files to track loop state
    across compactions. When loops complete successfully, they delete the file. When
    loops are interrupted (e.g., user stops the session), the file persists. This
    cleanup task removes files older than _IMPROVE_STATE_RETENTION_DAYS to avoid
    accumulating stale state files.

    Returns:
        Count of deleted files.
    """
    deleted = 0
    now = time.time()
    cutoff = now - _IMPROVE_STATE_RETENTION_DAYS * _SECS_PER_DAY

    # Load project roots from global.db projects table
    try:
        with db.open_global() as gconn:
            rows = gconn.execute("SELECT root FROM projects").fetchall()
    except (db.DBError, sqlite3.DatabaseError, OSError) as exc:
        _LOG.debug("_cleanup_orphaned_state_files: could not read projects table: %s", exc)
        return 0

    for row in rows:
        project_root = row["root"]
        try:
            project_path = Path(project_root)
            if not project_path.is_dir():
                continue
            # Glob for .improve-state-*.json files in the project root
            for state_file in project_path.glob(".improve-state-*.json"):
                try:
                    if state_file.stat().st_mtime < cutoff:
                        state_file.unlink()
                        deleted += 1
                        _LOG.debug("_cleanup_orphaned_state_files: removed %s", state_file.name)
                except OSError as e:
                    _LOG.warning(
                        "failed to remove orphaned state file %s: %s",
                        state_file.name,
                        e,
                    )
        except (OSError, ValueError) as e:
            _LOG.warning("error scanning project root %s for improve-state files: %s", project_root, e)
            # Continue to the next project root; don't fail the whole cleanup
            continue

    if deleted > 0:
        _LOG.info("_cleanup_orphaned_state_files: removed %d orphaned state file(s)", deleted)
    return deleted


def _cleanup_old_sentinels() -> int:
    """Delete sentinel files older than _SENTINEL_RETENTION_DAYS (30 days).

    Sentinel files (manifest_sha_*, recovery_pending_*, etc.) accumulate in the
    sentinels/ directory under the token-goat data directory. Each one is small,
    but long-lived installations can accumulate thousands. This cleanup task
    removes files older than _SENTINEL_RETENTION_DAYS to keep the directory bounded.

    Returns:
        Count of deleted files.
    """
    from . import paths as _paths

    sentinels_dir = _paths.sentinels_dir()
    if not sentinels_dir.is_dir():
        _LOG.debug("sentinels directory does not exist, skipping cleanup")
        return 0

    deleted = 0
    now = time.time()
    cutoff = now - _SENTINEL_RETENTION_DAYS * _SECS_PER_DAY

    try:
        for sentinel_file in sentinels_dir.iterdir():
            try:
                if sentinel_file.stat().st_mtime < cutoff:
                    sentinel_file.unlink()
                    deleted += 1
                    _LOG.debug("_cleanup_old_sentinels: removed %s", sentinel_file.name)
            except OSError as e:
                _LOG.warning("failed to remove sentinel file %s: %s", sentinel_file.name, e)
    except OSError as exc:
        _LOG.debug("_cleanup_old_sentinels: directory scan failed: %s", exc)
        return deleted

    if deleted > 0:
        _LOG.info("_cleanup_old_sentinels: removed %d sentinel file(s)", deleted)
    return deleted


def _cleanup_old_sessions() -> int:
    """Remove session JSON files older than SESSION_RETENTION_DAYS days.

    Session JSONs accumulate indefinitely under ``sessions/`` — one per Claude
    Code session.  Each file is at most a few KB, but long-lived installations
    can accumulate thousands.  Files are safe to remove once the session they
    describe has been over for a week: no running hook will reference a session
    that old.
    """
    from . import paths as _paths

    sessions_dir = _paths.sessions_dir()
    if not sessions_dir.is_dir():
        return 0
    max_age = _SESSION_RETENTION_DAYS * 86400
    now = time.time()
    removed = 0
    try:
        for fp in sessions_dir.iterdir():
            if fp.suffix != ".json":
                continue
            try:
                if now - fp.stat().st_mtime > max_age:
                    fp.unlink()
                    removed += 1
                    _LOG.debug("_cleanup_old_sessions: removed %s", fp.name)
                    # Remove companion lock/flock sidecars for this session so they
                    # do not accumulate after the session JSON is gone.
                    for sidecar_suffix in (".json.lock", ".json.flock"):
                        sidecar = fp.with_suffix(sidecar_suffix)
                        with contextlib.suppress(OSError):
                            sidecar.unlink(missing_ok=True)
            except OSError:
                continue
    except OSError as exc:
        _LOG.debug("_cleanup_old_sessions: directory scan failed: %s", exc)
        return removed
    # Sweep orphaned lock/flock sidecars whose .json was removed in a prior run.
    for sidecar_glob in ("*.json.lock", "*.json.flock"):
        for sidecar in sessions_dir.glob(sidecar_glob):
            stem = sidecar.name.split(".json.")[0]
            if not (sessions_dir / f"{stem}.json").exists():
                with contextlib.suppress(OSError):
                    sidecar.unlink(missing_ok=True)
    if removed > 0:
        _LOG.info("_cleanup_old_sessions: removed %d stale session JSON(s)", removed)
    return removed


def cleanup_on_startup() -> CleanupStats:
    """Run all self-healing tasks on daemon startup. Returns a summary with counts and failures.

    Each task is run independently: a failure in one task is caught, recorded in
    the ``"failures"`` list, and does not prevent remaining tasks from running.
    Tasks run:
    * ``_cleanup_stale_locks``            — remove lock files for dead PIDs or old ages.
    * ``_cleanup_old_logs``               — delete daily log files older than LOG_RETENTION_DAYS.
    * ``_prune_stats_table``              — drop stats rows beyond STATS_RETENTION_DAYS.
    * ``reap_stale_index_markers``        — clear ``*.indexing`` markers for finished/crashed spawns.
    * ``evict_image_cache_if_over_limit`` — LRU-evict images when cache exceeds 500 MB.
    * ``_checkpoint_global_wal``          — TRUNCATE-checkpoint global.db's WAL so it cannot grow unbounded.
    * ``_gc_orphaned_projects``           — delete rows/DBs for projects whose root dirs no longer exist.
    * ``_cleanup_old_sessions``           — delete session JSON files older than SESSION_RETENTION_DAYS days.
    * ``_cleanup_orphaned_state_files``   — delete .improve-state-*.json files older than 7 days.
    * ``_cleanup_old_sentinels``          — delete sentinel files older than 30 days.
    """
    stats: CleanupStats = {
        "stale_locks_cleared": 0,
        "stale_index_markers_cleared": 0,
        "logs_deleted": 0,
        "image_bytes_evicted": 0,
        "image_files_evicted": 0,
        "stats_rows_pruned": 0,
        "orphaned_projects_removed": 0,
        "old_sessions_removed": 0,
        "orphaned_state_files_deleted": 0,
        "old_sentinels_deleted": 0,
    }
    failures: list[str] = []

    # Each entry is (task_name, task_fn, stat_key).  The task_fn return value
    # is an int that maps directly to the named CleanupStats key.  Typing the
    # tuple explicitly lets mypy verify the key is a valid CleanupStats field
    # without a cast or type: ignore on the assignment.
    _int_tasks: list[tuple[str, Callable[[], int], str]] = [
        ("stale_locks", _cleanup_stale_locks, "stale_locks_cleared"),
        ("old_logs", _cleanup_old_logs, "logs_deleted"),
        ("stats_prune", _prune_stats_table, "stats_rows_pruned"),
        ("snapshots", _cleanup_stale_snapshots, "snapshots_cleared"),
        ("bash_outputs", _evict_bash_outputs, "bash_outputs_evicted"),
        ("web_outputs", _evict_web_outputs, "web_outputs_evicted"),
        ("wal_checkpoint", _checkpoint_global_wal, "wal_bytes_reclaimed"),
        ("project_wal_checkpoint", _checkpoint_project_wals, "project_wal_bytes_reclaimed"),
        ("gc_orphaned_projects", _gc_orphaned_projects, "orphaned_projects_removed"),
        ("old_sessions", _cleanup_old_sessions, "old_sessions_removed"),
        ("orphaned_state_files", _cleanup_orphaned_state_files, "orphaned_state_files_deleted"),
        ("old_sentinels", _cleanup_old_sentinels, "old_sentinels_deleted"),
    ]
    for task_name, task_fn, stat_key in _int_tasks:
        try:
            result_int = task_fn()
            stats[stat_key] = result_int  # type: ignore[literal-required]  # key is validated at construction
        except Exception as exc:
            _LOG.exception("cleanup task %s failed", task_name)
            failures.append(f"{task_name}: {type(exc).__name__}: {exc}")

    # Stale index-spawn markers — already has its own error handling
    try:
        stats["stale_index_markers_cleared"] = reap_stale_index_markers()
    except Exception as exc:
        _LOG.exception("cleanup task stale_index_markers failed")
        failures.append(f"stale_index_markers: {type(exc).__name__}: {exc}")

    # Clear stale image-cache eviction lock before attempting eviction
    try:
        _clear_stale_eviction_lock()
    except Exception as exc:
        _LOG.exception("cleanup task clear_stale_eviction_lock failed")
        failures.append(f"clear_stale_eviction_lock: {type(exc).__name__}: {exc}")

    # Image LRU eviction — already has its own error handling
    try:
        bytes_evicted, files_evicted = evict_image_cache_if_over_limit()
        stats["image_bytes_evicted"] = bytes_evicted
        stats["image_files_evicted"] = files_evicted
    except Exception as exc:
        _LOG.exception("cleanup task image_eviction failed")
        failures.append(f"image_eviction: {type(exc).__name__}: {exc}")

    if failures:
        stats["failures"] = failures
    _LOG.info(
        "startup cleanup complete: locks_cleared=%d index_markers_cleared=%d logs_deleted=%d "
        "stats_rows_pruned=%d image_bytes_evicted=%d image_files_evicted=%d "
        "snapshots_cleared=%d bash_outputs_evicted=%d web_outputs_evicted=%d wal_bytes_reclaimed=%d "
        "orphaned_projects_removed=%d old_sessions_removed=%d orphaned_state_files_deleted=%d "
        "old_sentinels_deleted=%d%s",
        stats.get("stale_locks_cleared", 0),
        stats.get("stale_index_markers_cleared", 0),
        stats.get("logs_deleted", 0),
        stats.get("stats_rows_pruned", 0),
        stats.get("image_bytes_evicted", 0),
        stats.get("image_files_evicted", 0),
        stats.get("snapshots_cleared", 0),
        stats.get("bash_outputs_evicted", 0),
        stats.get("web_outputs_evicted", 0),
        stats.get("wal_bytes_reclaimed", 0),
        stats.get("orphaned_projects_removed", 0),
        stats.get("old_sessions_removed", 0),
        stats.get("orphaned_state_files_deleted", 0),
        stats.get("old_sentinels_deleted", 0),
        f" failures={failures}" if failures else "",
    )
    return stats


# Stale eviction lock age.  An eviction pass over a 500 MB cache (thousands of
# small files) finishes in well under 60 s on any commodity disk; if a lockfile
# is older than this, the previous evictor crashed or its host process was killed
# and we should reclaim the lock rather than skip the pass.
_EVICTION_LOCK_STALE_SECONDS = 120.0


def _eviction_lock_is_stale(lock_path: Path, now: float | None = None) -> bool:
    """Return True if *lock_path* is older than ``_EVICTION_LOCK_STALE_SECONDS``."""
    try:
        age = (now if now is not None else time.time()) - lock_path.stat().st_mtime
    except OSError:
        # Lockfile vanished between our check and stat — treat as not-stale; the
        # caller's O_CREAT|O_EXCL retry will resolve the race correctly.
        return False
    return age > _EVICTION_LOCK_STALE_SECONDS


def _acquire_eviction_lock(lock_path: Path) -> int | None:
    """Atomically claim the eviction lock.

    Uses ``os.open(O_CREAT | O_EXCL)`` so two evictors racing for the lock
    cannot both succeed — the loser gets ``FileExistsError`` and bails.  If
    the existing lockfile is stale (older than ``_EVICTION_LOCK_STALE_SECONDS``),
    we unlink it and retry once: this matches the existing project-writer-lock
    pattern in ``db.py`` and keeps a crashed evictor from blocking the cache
    forever.

    Returns the file descriptor of the held lock on success, or ``None`` if
    another evictor is currently running.  The fd is intentionally returned
    rather than closed here so the caller can keep it open for the duration of
    the eviction pass — closing+unlinking together at the end is what makes
    the lock release atomic from a watcher's perspective.
    """
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    # Use 0o600 (owner-only) so the lock file — which contains a PID stamp — is
    # not readable by other local users on multi-user systems.  0o644 would
    # expose the PID, which is a minor information leak and is inconsistent with
    # the owner-only mode used for all other token-goat lock/claim files.
    try:
        fd = os.open(str(lock_path), flags, 0o600)
    except FileExistsError:
        if _eviction_lock_is_stale(lock_path):
            _LOG.info("clearing stale image-cache eviction lock at %s", lock_path)
            with contextlib.suppress(OSError):
                lock_path.unlink()
            try:
                fd = os.open(str(lock_path), flags, 0o600)
            except FileExistsError:
                # Another evictor grabbed it in the gap — that's fine, they win.
                _LOG.warning("image-cache eviction lock contention: another process holds %s", lock_path)
                return None
        else:
            _LOG.warning("image-cache eviction lock contention: another process holds %s (lock is fresh)", lock_path)
            return None
    # Best-effort PID stamp so cli_doctor can identify the holder; not required
    # for correctness.
    with contextlib.suppress(OSError):
        os.write(fd, f"{os.getpid()}\n{time.time()}\n".encode())
    return fd


def _clear_stale_eviction_lock() -> None:
    """Clear stale image-cache eviction lock at startup.

    Runs from cleanup_on_startup to ensure any lock left by a crashed evictor
    does not block cache maintenance for the lifetime of the daemon. Unlike
    _acquire_eviction_lock (which clears a stale lock only when it tries to
    acquire), this proactively removes stale locks at startup so a maintenance
    pass can proceed without waiting for the first (potential) eviction call.

    Never raises; all errors are logged and suppressed.
    """
    lock_path = paths.locks_dir() / "image_cache_eviction.lock"
    if not lock_path.exists():
        return
    try:
        if _eviction_lock_is_stale(lock_path):
            with contextlib.suppress(OSError):
                lock_path.unlink()
            _LOG.info("cleared stale image-cache eviction lock at startup: %s", lock_path)
    except Exception as exc:
        _LOG.debug("_clear_stale_eviction_lock failed: %s", exc)


def evict_image_cache_if_over_limit() -> tuple[int, int]:
    """LRU-evict image cache entries if total size exceeds IMAGE_CACHE_LIMIT.

    Why this does not delegate to ``cache_common.evict_cache_dir``
    --------------------------------------------------------------
    ``cache_common.evict_cache_dir`` is the shared eviction algorithm for the
    bash-output and web-output caches.  The image cache has three structural
    differences that make delegation incompatible without significant rework:

    1. **Two-threshold design.**  ``evict_cache_dir`` takes a single
       ``max_total_bytes`` cap and evicts until the total is *at or under* that
       cap — limit equals target.  The image cache uses a separate
       ``IMAGE_CACHE_TARGET`` (80% of ``IMAGE_CACHE_LIMIT``) to avoid thrash:
       eviction runs only when the limit is exceeded and stops when the target
       is reached, giving a 100 MB headroom buffer.  Adding a ``target_bytes``
       parameter to the shared function would couple it to image-specific
       policy that the bash/web callers do not need.

    2. **Concurrency lock.**  Multiple agents on the same machine share the
       image cache.  This function takes an ``O_CREAT | O_EXCL`` file lock in
       ``paths.locks_dir()`` so concurrent eviction passes skip rather than
       double-scan and race on ``unlink()``.  ``evict_cache_dir`` has no lock
       because the bash/web caches are single-writer (only the session's worker
       or hook writes to them).

    3. **File naming and sidecar conventions.**  ``evict_cache_dir`` scans for
       ``.txt`` body files and deletes their ``.json`` sidecars.  Image cache
       files have content-addressed names with arbitrary image extensions
       (``*.webp``, ``*.jpg``, ``*.png``, ``*.avif``) and no sidecars.

    When ``evict_cache_dir`` gains a ``target_bytes`` parameter and a
    caller-supplied lock mechanism, this function could be refactored to
    delegate.  Until then the separate implementation is the correct choice.

    Threshold and target
    --------------------
    Eviction runs only when the on-disk total exceeds ``IMAGE_CACHE_LIMIT``
    (500 MB) and deletes files until the total drops to ``IMAGE_CACHE_TARGET``
    (80% of the limit, i.e. 400 MB).  The two-threshold design avoids thrashing:
    if the target equalled the limit we would evict one file, then immediately
    hit the limit again on the next write and re-evict.  An 80% target gives
    each maintenance cycle a 100 MB headroom before the next pass is needed.

    Trigger frequency
    -----------------
    Called once per maintenance cycle from ``cleanup_on_startup`` and the
    periodic worker loop (``MAINTENANCE_INTERVAL`` = 5 min).  *Not* called on
    every cache write — pushing the eviction onto a periodic schedule means
    interactive image shrinks never block on a directory scan.

    LRU ordering
    ------------
    Files are sorted by ``st_mtime`` ascending.  Because the cache is
    content-addressed and written exactly once per entry, mtime would normally
    equal creation time and the policy would degrade to FIFO.  To make it a
    true LRU, ``image_shrink.shrink`` bumps mtime on every cache hit via
    ``os.utime``.  This is the most portable per-hit signal available — Windows
    atime is unreliable (often disabled at the volume level via
    ``NtfsDisableLastAccessUpdate``), and atime on Linux is frequently mounted
    with ``noatime``/``relatime`` so it doesn't reliably update on read.

    Race safety
    -----------
    Multiple agents on the same machine can hit cache shrink simultaneously,
    and a long-running maintenance cycle could overlap a worker restart's
    startup sweep.  Eviction takes an ``O_CREAT | O_EXCL`` lockfile in
    ``paths.locks_dir()``; concurrent evictors return ``(0, 0)`` rather than
    double-scanning and racing on ``unlink()`` (which would log a "failed to
    evict" warning for every file the winner already deleted).  Stale locks
    older than ``_EVICTION_LOCK_STALE_SECONDS`` (120 s — well above any
    realistic pass time on a 500 MB cache) are automatically reclaimed so a
    crashed evictor cannot wedge the cache permanently.

    Returns
    -------
    ``(bytes_freed, files_freed)``.  Both values are 0 when the cache is within
    the limit, the cache directory does not exist, or another evictor is
    currently holding the lock.
    """
    img_dir = paths.image_cache_dir()
    if not img_dir.exists():
        _LOG.debug("image cache directory does not exist")
        return 0, 0

    lock_path = paths.locks_dir() / "image_cache_eviction.lock"
    # Ensure the locks directory exists; paths.ensure_dirs() handles this at
    # startup but defending here keeps the function callable from tests and
    # one-shot CLI invocations that bypass the normal startup path.
    with contextlib.suppress(OSError):
        paths.ensure_dir(lock_path.parent)
    lock_fd = _acquire_eviction_lock(lock_path)
    if lock_fd is None:
        _LOG.debug("image cache eviction already in progress; skipping this pass")
        return 0, 0

    try:
        cache_entries: list[tuple[Path, float, int]] = []  # (path, mtime, size_bytes)
        total_bytes = 0
        for f in img_dir.iterdir():
            if not f.is_file():
                continue
            try:
                st = f.stat()
                cache_entries.append((f, st.st_mtime, st.st_size))
                total_bytes += st.st_size
            except OSError:
                continue
        if total_bytes <= IMAGE_CACHE_LIMIT:
            _LOG.debug("image cache size %.1f MB is within limit %.1f MB",
                      total_bytes / (1024 * 1024), IMAGE_CACHE_LIMIT / (1024 * 1024))
            return 0, 0
        _LOG.warning("image cache %.1f MB exceeds limit %.1f MB; starting LRU eviction",
                    total_bytes / (1024 * 1024), IMAGE_CACHE_LIMIT / (1024 * 1024))
        # Sort oldest-accessed first so the least-recently-used files are evicted first.
        cache_entries.sort(key=operator.itemgetter(1))
        bytes_freed = 0
        files_freed = 0
        for f, _, size in cache_entries:
            if total_bytes - bytes_freed <= IMAGE_CACHE_TARGET:
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
    finally:
        # Close the fd first, then unlink — releasing the lock atomically.
        with contextlib.suppress(OSError):
            os.close(lock_fd)
        with contextlib.suppress(OSError):
            lock_path.unlink()


# ---------------------------------------------------------------------------
# Spawn API (called by SessionStart watchdog)
# ---------------------------------------------------------------------------

def _detach_creationflags() -> int:
    """Return the Windows creationflags for a detached background process.

    Combines DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW.
    Returns 0 on non-Windows platforms (the flags are ignored anyway, but
    ``subprocess.Popen`` does not accept non-zero creationflags on POSIX).
    """
    if sys.platform == "win32":
        # DETACHED_PROCESS=0x8 prevents the child from inheriting the parent's
        # console; CREATE_NEW_PROCESS_GROUP=0x200 lets it handle Ctrl+C independently;
        # CREATE_NO_WINDOW=0x8000000 suppresses any console window allocation.
        return 0x00000008 | 0x00000200 | 0x08000000
    return 0


def spawn_detached() -> int | None:
    """Spawn the token-goat worker as a detached background process.

    Uses ``pythonw.exe -m token_goat.cli worker --daemon`` rather than the
    launcher .exe so AV/EDR products don't behavior-flag the spawn.
    Returns PID or None on failure.
    """
    from . import paths
    cmd = paths.python_runner_argv("worker", "--daemon")

    creationflags = _detach_creationflags()

    if os.environ.get("TOKEN_GOAT_NO_WORKER_SPAWN", "").strip().lower() in ("1", "true", "yes", "on"):
        _LOG.debug("spawn_detached suppressed: TOKEN_GOAT_NO_WORKER_SPAWN is set")
        return None

    # Capture the spawned worker's stderr to a file rather than DEVNULL. A
    # worker that fails before its logging FileHandler is attached — an import
    # error, a crash in _setup_logging — would otherwise die with no trace at
    # all, which is exactly what makes a silent worker death undebuggable.
    stderr_sink: int | IO[str] = subprocess.DEVNULL
    stderr_file: IO[str] | None = None
    try:
        stderr_path = paths.logs_dir() / "worker-stderr.log"
        paths.ensure_dir(stderr_path.parent)
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
        _LOG.info("worker spawned: pid=%d cmd=%s", proc.pid, " ".join(cmd))
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

    Also verifies the running process looks like a token-goat indexer (by cmdline)
    to guard against PID recycling: the OS can reuse a finished indexer's PID for
    an unrelated process within the TTL window, which would block fresh indexing
    spawns for up to INDEX_SPAWN_TTL (10 min).  Falls back to trusting the PID
    when cmdline is unreadable (permission denied, sandboxed), same as
    :func:`is_worker_alive`.
    """
    try:
        pid_str, ts_str = marker.read_text(encoding="utf-8").split("\n", 1)
        pid, ts = int(pid_str), float(ts_str.strip())
    except (OSError, ValueError):
        return False  # missing or malformed marker — not active
    if time.time() - ts > INDEX_SPAWN_TTL:
        return False  # stale — a hung index; allow a fresh spawn
    if not psutil.pid_exists(pid):
        return False
    try:
        cmdline = " ".join(psutil.Process(pid).cmdline()).lower()
        if "token_goat" not in cmdline and pid != os.getpid():
            # pid == os.getpid(): marker written by current process (test using os.getpid() as live-PID stand-in); daemon always spawns an external subprocess so this is unreachable in production.
            _LOG.debug("_index_spawn_active: PID %d alive but cmdline lacks token_goat; treating as recycled", pid)
            return False
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        pass  # cannot read cmdline — trust the PID + TTL
    return True


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
            _LOG.debug("index marker %s is still active; skipping", marker.name)
            continue
        try:
            marker.unlink()
            cleared += 1
            _LOG.debug("reaped stale index marker: %s", marker.name)
        except OSError as e:
            _LOG.warning("failed to remove stale index marker %s: %s", marker.name, e)
    if cleared:
        _LOG.info("reaped %d stale index marker(s)", cleared)
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
    from . import db as db_mod
    from . import paths

    # Validate project_hash before using it in the marker path.  Callers like
    # _parse_and_group_entries already validate, but this function is part of
    # the public spawn API and may be called from future code paths without
    # prior validation.  Defense-in-depth: a traversal sequence in project_hash
    # would escape locks_dir() when building the .indexing marker path.
    try:
        db_mod._validate_project_hash(project_hash)
    except ValueError as exc:
        _LOG.warning("spawn_index_detached: rejecting invalid project_hash %r: %s", project_hash, exc)
        return None

    # Validate project_root before using it as cwd in Popen.  project_root can
    # originate from the dirty queue (an external file), so we must confirm it
    # is an absolute path that points to an existing directory before handing it
    # to the OS.  A relative path, a non-directory, or a path constructed from
    # tampered queue data must never become the cwd for a subprocess spawn.
    root_path = Path(project_root)
    if not root_path.is_absolute():
        _LOG.warning(
            "spawn_index_detached: rejecting non-absolute project_root %r for %s",
            project_root, project_hash[:8],
        )
        return None
    try:
        if not root_path.is_dir():
            _LOG.warning(
                "spawn_index_detached: project_root %r is not a directory for %s; skipping",
                project_root, project_hash[:8],
            )
            return None
    except OSError as exc:
        _LOG.warning(
            "spawn_index_detached: could not stat project_root %r for %s: %s",
            project_root, project_hash[:8], exc,
        )
        return None

    marker = paths.locks_dir() / f"{project_hash}.indexing"
    if _index_spawn_active(marker):
        _LOG.info(
            "auto-index skipped for %s — an index spawn is already running",
            project_hash[:8],
        )
        return None

    if os.environ.get("TOKEN_GOAT_NO_WORKER_SPAWN", "").strip().lower() in ("1", "true", "yes", "on"):
        _LOG.debug("spawn_index_detached suppressed: TOKEN_GOAT_NO_WORKER_SPAWN is set")
        return None

    cmd = paths.python_runner_argv("index", "--full")
    creationflags = _detach_creationflags()

    # Open a log file for stderr so we can diagnose spawn failures.
    # Rolling logs are already handled by paths.logs_dir() + daily rotation.
    log_file = None
    try:
        log_path = paths.logs_dir() / "index-spawn.log"
        log_file = open(str(log_path), "a", encoding="utf-8")  # noqa: SIM115
    except OSError as e:
        _LOG.warning("could not open log file for index spawn stderr: %s", e)

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=project_root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=log_file or subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
            start_new_session=(sys.platform != "win32"),
        )
    except (OSError, FileNotFoundError) as e:
        _LOG.error("failed to spawn auto-index: %s", e)
        with contextlib.suppress(OSError):
            if log_file:
                log_file.close()
        return None
    finally:
        # Close the file handle in the parent process; the child inherited it
        # and will have its own reference. Closing early avoids a file handle leak
        # in the parent. On Windows, close_fds=True should prevent the inherit,
        # but on POSIX we explicitly pass the FD so we must close it here.
        with contextlib.suppress(OSError):
            if log_file:
                log_file.close()

    # Record the spawn so concurrent SessionStart hooks don't pile on. The
    # marker self-expires via PID-liveness + TTL — no explicit cleanup needed.
    with contextlib.suppress(OSError):
        paths.atomic_write_text(marker, f"{proc.pid}\n{time.time()}")
    _LOG.info("auto-index spawned for %s (root=%s, pid=%d)", project_hash[:8], project_root, proc.pid)
    return proc.pid


def _heartbeat_age() -> float | None:
    """Seconds since the worker last heartbeat, or None if there is no heartbeat file.

    Thin alias for :func:`heartbeat_age` retained for backward-compat with
    in-module call sites (``_reap_hung_worker``). New code outside this
    module should call the public ``heartbeat_age`` instead.
    """
    return heartbeat_age()


def _is_token_goat_worker(pid: int) -> bool:
    """True if *pid* is a live process whose command line is a token-goat worker.

    Guards against PID recycling: a PID that was recycled to an unrelated
    process after the original worker died must never be terminated.
    """
    try:
        cmdline = " ".join(psutil.Process(pid).cmdline()).lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError) as exc:
        _LOG.debug("_is_token_goat_worker pid=%s err=%s", pid, exc)
        return False
    return "token_goat" in cmdline and "worker" in cmdline


def _live_worker_pid() -> int | None:
    """PID from the pid file, but only if it names a live token-goat-worker process.

    Uses lenient cmdline validation: if cmdline cannot be read (permissions,
    sandboxed, test), the PID is still returned. Rejects only if cmdline is
    readable and definitively does NOT contain "token_goat worker" markers
    (indicating PID recycling).
    """
    try:
        pid, _interp = _read_pid_info(paths.worker_pid_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    # Check if process exists.
    if not psutil.pid_exists(pid):
        return None

    # Attempt cmdline verification. Like is_worker_alive, we only reject if
    # cmdline is readable and doesn't match token-goat markers (PID recycling).
    try:
        p = psutil.Process(pid)
        cmdline = " ".join(p.cmdline()).lower()
        if "token_goat" not in cmdline or "worker" not in cmdline:
            return None  # PID recycled to an unrelated process
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        # Cannot read cmdline; assume it's valid.
        pass

    return pid


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
            _LOG.warning("hung worker pid=%s did not exit after SIGTERM; sending SIGKILL", pid)
            proc.kill()
    except psutil.NoSuchProcess:
        _LOG.debug("hung worker pid=%s already gone by the time we tried to reap it", pid)
    except psutil.AccessDenied as e:
        _LOG.warning("reap hung worker pid=%s: access denied — %s", pid, e)
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

    Under CI (``TOKEN_GOAT_NO_WORKER_SPAWN=1``) the spawn inside
    :func:`spawn_detached` is suppressed so a detached daemon's infinite
    loop cannot hold the GitHub Actions Windows step open until the
    global six-hour timeout fires — see ``spawn_detached`` for the env
    var details.  The watchdog path itself still runs end-to-end so the
    rest of the state machine remains testable.
    """
    if is_worker_alive():
        try:
            pid, _interp = _read_pid_info(paths.worker_pid_path().read_text(encoding="utf-8"))
            return pid
        except (OSError, ValueError) as e:
            _LOG.debug("worker is alive but pid file unreadable: %s", e)
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
    """Self-register the worker for at-logon autostart.

    On Windows: writes the HKCU Run registry key.
    On Linux: writes the systemd user service (or XDG autostart fallback).

    Called on every daemon startup so autostart stays self-healing after a
    `uv tool install --reinstall` or a cleared registry/service entry. Fail-soft:
    an error here must never take the worker down. (Lazy import — install.py
    imports worker.)
    """
    try:
        from . import install

        if sys.platform == "win32":
            ok, detail = install.install_worker_task()
        elif sys.platform == "darwin":
            ok, detail = install.install_mac_autostart()
        else:
            ok, detail = install.install_linux_autostart()
        _LOG.info("autostart self-register: %s", detail if ok else ("failed — " + detail))
    except Exception:
        _LOG.exception("autostart self-register failed")


def run_daemon(stop_event: threading.Event | None = None) -> None:
    """Compatibility wrapper around :mod:`token_goat.worker_daemon`."""
    from . import worker_daemon

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

    if _is_under_memory_pressure():
        _LOG.info("memory pressure: skipping periodic reindex cycle")
        return

    cutoff = int(time.time() - PERIODIC_REINDEX_ACTIVE_WINDOW)
    try:
        with db.open_global_readonly() as gconn:
            rows = gconn.execute(
                "SELECT hash, root, marker, file_count FROM projects WHERE last_seen >= ?",
                (cutoff,),
            ).fetchall()
    except (db.DBError, sqlite3.DatabaseError, OSError):
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
            _LOG.info(
                "periodic reindex: skipping %s — %d files exceeds limit of %d "
                "(set PERIODIC_REINDEX_MAX_FILES higher to include it)",
                row["root"],
                row["file_count"],
                PERIODIC_REINDEX_MAX_FILES,
            )
            skipped_oversized += 1
            continue
        ph = row["hash"]
        if _should_skip_due_to_backoff(ph, "<project>"):
            _LOG.info("backoff: skipping periodic reindex for project %s", ph[:8])
            continue
        proj = Project(root=Path(row["root"]), hash=ph, marker=row["marker"])
        try:
            summary = _run_index_with_timeout(proj, False, INDEX_TIMEOUT_SECS)
            if summary is None:
                # Timeout or error — record failure and move on.
                _record_index_failure(ph, "<project>")
                continue
            _record_index_success(ph, "<project>")
            if summary["indexed"] > 0 or summary["errors"] > 0:  # type: ignore[operator]  # summary is IndexStats TypedDict; mypy cannot prove keys are always present when typed total=False
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
            # Refresh git-history hints in the durable worker — the SessionStart hook used to spawn this on a daemon thread that died with the hook process. index_project_history is idempotent and staleness-gated (1 h).
            from . import git_history

            git_history.index_project_history(proj.root, proj.hash)
        except Exception:
            _LOG.exception("periodic reindex failed for %s", row["root"])
            _record_index_failure(ph, "<project>")
    if skipped_oversized > 0:
        _LOG.info(
            "periodic reindex: skipped %d project(s) with > %d files (increase PERIODIC_REINDEX_MAX_FILES to include them)",
            skipped_oversized, PERIODIC_REINDEX_MAX_FILES,
        )
    _LOG.debug("periodic reindex cycle complete: %d processed, %d skipped (oversized)",
              reindexed_count, skipped_oversized)


def _parse_and_group_entries(entries: list[DirtyQueueEntry]) -> dict[str, _ProjectBucket]:
    """Validate and group raw queue entries by project hash.

    Each entry is validated (project_hash format, safe rel-path) before use
    to guard against a corrupt or tampered queue file directing path
    construction outside expected directories.

    Returns a mapping of project_hash → bucket containing the set of dirty
    rel-paths and the project root/marker harvested from the first entry that
    recorded them.
    """
    # Hoist the import outside the per-entry loop — repeated import machinery
    # lookups inside a tight loop add measurable overhead with large queues.
    from .paths import is_safe_rel_path

    by_project: dict[str, _ProjectBucket] = {}
    for entry in entries:
        ph = entry.get("project_hash")
        rel = entry.get("path")
        if not ph or not rel:
            _LOG.debug("skipping malformed queue entry (missing hash or path)")
            continue
        try:
            db._validate_project_hash(ph)
        except ValueError:
            _LOG.warning("dirty queue: skipping entry with invalid project_hash %r", ph)
            continue
        if not is_safe_rel_path(rel):
            _LOG.warning("dirty queue: skipping entry with unsafe rel path %r", rel)
            continue
        if ph not in by_project:
            by_project[ph] = _ProjectBucket(rels=set(), root=None, marker=None)
        bucket = by_project[ph]
        bucket["rels"].add(rel)
        # Carry the project root/marker from the first entry that records them
        # (see hooks_cli._enqueue_for_reindex).  These allow reconstruction of
        # projects not yet registered in global.db.
        if bucket["root"] is None and entry.get("project_root"):
            bucket["root"] = entry["project_root"]
            # Sanitize the marker: it comes from an external queue file and is later
            # stored in the projects table and emitted in log messages.  Strip
            # newlines/CRs and cap length to prevent log injection or oversized DB rows.
            raw_marker = entry.get("project_marker") or "manual"
            bucket["marker"] = sanitize_log_str(str(raw_marker), max_len=_MAX_QUEUE_MARKER_LEN) or "manual"
    return by_project


def _lookup_known_projects(hashes: list[str]) -> dict[str, sqlite3.Row]:
    """Batch-fetch project rows from global.db for the given hashes.

    Returns a mapping of hash → Row for every hash present in the DB.
    On any DB error, logs a warning and returns an empty dict so callers
    fall back to queue-entry metadata where available.
    """
    if not hashes:
        return {}
    ph_placeholders = ",".join("?" for _ in hashes)
    try:
        with db.open_global() as gconn:
            return {
                row["hash"]: row
                for row in gconn.execute(
                    f"SELECT hash, root, marker FROM projects WHERE hash IN ({ph_placeholders})",
                    hashes,
                )
            }
    except (db.DBError, sqlite3.DatabaseError, OSError) as exc:
        _LOG.warning(
            "dirty queue: global.db lookup failed for %d project(s): %s — "
            "will fall back to queue-entry metadata where available",
            len(hashes), exc,
        )
        return {}


def _resolve_project_from_bucket(
    ph: str, bucket: _ProjectBucket, known_row: sqlite3.Row | None
) -> tuple[Project, bool] | None:
    """Resolve a Project and first-index flag from a dirty-queue bucket.

    Returns ``(project, is_first_index)`` on success, or ``None`` if the
    project cannot be reconstructed (missing or invalid root).

    Three cases:
    - ``known_row`` present → project already registered; use DB root, incremental index.
    - ``bucket["root"]`` present → first edit before first full index; validate the
      root from the queue entry and run a full index.
    - Neither → legacy entry with no root recorded; drop with a warning.
    """
    if known_row:
        project = Project(root=Path(known_row["root"]), hash=ph, marker=known_row["marker"])
        _LOG.debug(
            "dirty queue: project %s known (root=%s), running incremental index",
            ph[:8], known_row["root"],
        )
        return project, False

    if bucket["root"]:
        raw_root = bucket["root"]
        root_candidate = Path(raw_root)
        if not root_candidate.is_absolute():
            _LOG.warning(
                "dirty queue: project %s root %r is not absolute; dropping",
                ph[:8], raw_root,
            )
            return None
        try:
            root_is_dir = root_candidate.is_dir()
        except OSError:
            root_is_dir = False
        if not root_is_dir:
            _LOG.warning(
                "dirty queue: project %s root %r is not an existing directory; dropping",
                ph[:8], raw_root,
            )
            return None
        project = Project(root=root_candidate, hash=ph, marker=bucket["marker"] or "manual")
        _LOG.info(
            "dirty queue: project %s not yet registered (root=%s); running first index",
            ph[:8], bucket["root"],
        )
        return project, True

    # Legacy entry: no root recorded — nothing to anchor the reconstruction to.
    _LOG.warning(
        "dirty queue refers to unknown project hash %s with no root; dropping", ph
    )
    return None


def _get_max_pool_workers() -> int:
    """Return the configured (and ceiling-clamped) max_pool_workers value.

    Reads from config at call time so tests can override it via monkeypatching
    the config without restarting the worker.  Falls back to 1 on any config
    error to preserve the pre-feature behaviour.
    """
    try:
        from . import config as _cfg
        return _cfg.load().worker.max_pool_workers
    except Exception:
        return 1


def _run_index_with_timeout(
    project: Project,
    full: bool,
    timeout: float,
    *,
    max_workers: int | None = None,
) -> dict[str, object] | None:
    """Run ``parser.index_project`` in a thread with a wall-clock timeout.

    Returns the result dict on success, or ``None`` when the call times out
    or raises. Timeout is enforced via :mod:`concurrent.futures`; the indexing
    thread is left to complete naturally in the background (Python threads
    cannot be forcibly killed), but the worker loop is unblocked immediately
    after the timeout so it can process the next project without delay.

    A ``None`` return means the caller should treat this project as a failure
    and record a backoff entry.

    The *max_workers* parameter overrides the pool size for this call; when
    ``None`` (the default) the configured ``worker.max_pool_workers`` value is
    used.  The value is always clamped to [1, WORKER_MAX_POOL_CEILING].
    """
    from . import config as _cfg_mod
    _pool_size = max_workers if max_workers is not None else _get_max_pool_workers()
    _pool_size = max(1, min(_pool_size, _cfg_mod.WORKER_MAX_POOL_CEILING))
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=_pool_size)
    try:
        future = executor.submit(parser.index_project, project, full=full)
        try:
            return future.result(timeout=timeout)  # type: ignore[return-value]  # Future[IndexStats | None] but Future.result() returns the generic param; mypy loses the None from the timeout path
        except concurrent.futures.TimeoutError:
            _LOG.warning(
                "index_project timed out after %.0fs for project %s (root=%s); skipping",
                timeout,
                str(project.hash)[:8],
                project.root,
            )
            return None
        except Exception:
            _LOG.exception(
                "index_project raised for project %s (root=%s)",
                str(project.hash)[:8],
                project.root,
            )
            return None
    finally:
        # shutdown(wait=False) releases the worker thread immediately without
        # blocking until it finishes.  Python threads cannot be forcibly
        # killed, so a timed-out indexing thread will continue running in the
        # background, but the caller is unblocked right away — which is the
        # documented contract of this function.  Using wait=True (the default
        # when exiting a ``with`` block) would defeat the timeout entirely by
        # making the caller wait for the full thread duration on a timeout path.
        executor.shutdown(wait=False)


def _invalidate_skill_cache_entries(entries: list[DirtyQueueEntry]) -> None:
    """Purge skill cache entries for any dirty queue entries that are skill files.

    A skill body file can be edited between two loads of the same skill within
    one session.  Without this step, the worker re-indexes the file but leaves
    the now-stale cached body in ``data_dir()/skills/``.  The next
    ``token-goat skill-body`` recall (or the compaction manifest) would then
    serve the old content.

    The check is cheap: it only reconstructs the full path when the relative
    path contains ``.claude/skills/`` (case-insensitive).  This avoids the
    overhead of calling ``skill_cache.invalidate_for_path`` on every edited
    source file in the project.

    Fail-soft: called inside a broad ``except Exception`` wrapper in the caller.
    """
    # Quick pre-filter: skip the import entirely when no entry looks like a skill.
    _SKILL_HINT = (r"\.claude" + os.sep + "skills").lower()
    _SKILL_HINT_FWD = ".claude/skills"

    candidate_entries = [
        e for e in entries
        if (
            _SKILL_HINT_FWD in (e.get("path") or "").lower()
            or _SKILL_HINT in (e.get("path") or "").lower()
        )
    ]
    if not candidate_entries:
        return

    from . import skill_cache

    for entry in candidate_entries:
        rel = entry.get("path") or ""
        root = entry.get("project_root") or ""
        if not rel:
            continue
        # Build the full path: project_root + rel when root is available,
        # otherwise fall back to using rel alone (hooks always set project_root
        # so this fallback is a belt-and-suspenders guard).
        full_path = str(Path(root) / rel) if root else rel
        n = skill_cache.invalidate_for_path(full_path)
        if n > 0:
            _LOG.info(
                "dirty queue: invalidated %d skill cache entr%s for edited path %s",
                n, "y" if n == 1 else "ies",
                sanitize_log_str(full_path, max_len=120),
            )


def _process_dirty_entries(entries: list[DirtyQueueEntry]) -> None:
    """Re-index files that were marked dirty by Edit/Write/MultiEdit hooks.

    Groups queue entries by project hash to avoid opening the project DB once
    per entry.  For known projects a single incremental ``index_project`` call
    re-indexes all changed files in the batch.  For projects not yet registered
    in global.db (first edit before the first full index), the project is
    reconstructed from the queue-entry metadata and a full index is run so the
    edit is not lost.

    Reliability improvements applied here:

    * **Memory pressure guard** — if RSS exceeds MEMORY_PRESSURE_THRESHOLD_MB,
      indexing is skipped entirely this cycle (eviction-only mode).
    * **Indexing timeout** — each ``index_project`` call is bounded by
      ``INDEX_TIMEOUT_SECS``; a timed-out project is recorded as a failure and
      subject to exponential back-off on subsequent cycles.
    * **Exponential back-off** — after _BACKOFF_FAILURE_THRESHOLD consecutive
      failures for the same project, the project is skipped until the back-off
      window expires.  This prevents a single pathological project from
      monopolising the worker's attention.
    """
    _LOG.debug("processing %d dirty queue entries", len(entries))
    _batch_t0 = time.time()

    # Skill cache invalidation: if any dirty entry is a skill body file, purge
    # its cached body so the stale entry is not served to the agent after the
    # edit.  This runs *before* the re-index so the fresher body is available
    # by the time the next ``token-goat skill-body`` recall fires.  Fail-soft:
    # an import or I/O error here must never block the index path.
    try:
        _invalidate_skill_cache_entries(entries)
    except Exception:
        _LOG.debug("skill cache invalidation failed (non-fatal)", exc_info=True)

    if _is_under_memory_pressure():
        _LOG.info(
            "memory pressure: skipping dirty-queue indexing (%d entries deferred)",
            len(entries),
        )
        return

    by_project = _parse_and_group_entries(entries)
    _LOG.debug("grouped into %d projects", len(by_project))

    known_projects = _lookup_known_projects(list(by_project.keys()))

    projects_processed = 0
    for ph, bucket in by_project.items():
        # Backoff check: use the project hash as a synthetic path key since
        # the dirty-queue drain re-indexes all changed files per project in
        # one call — there is no per-file granularity at this layer.
        if _should_skip_due_to_backoff(ph, "<project>"):
            _LOG.info("backoff: skipping project %s this cycle", ph[:8])
            continue
        try:
            resolved = _resolve_project_from_bucket(ph, bucket, known_projects.get(ph))
            if resolved is None:
                continue
            project, is_first_index = resolved

            t0 = time.time()
            result = _run_index_with_timeout(project, is_first_index, INDEX_TIMEOUT_SECS)
            elapsed = time.time() - t0

            if result is None:
                # Timeout or unhandled exception — treat as failure for backoff.
                _record_index_failure(ph, "<project>")
                continue

            _record_index_success(ph, "<project>")
            projects_processed += 1
            if result["errors"] > 0:  # type: ignore[operator]  # IndexStats TypedDict total=False; key always set by index_project but mypy cannot prove it
                _LOG.warning(
                    "reindexed %d/%d files in project %s after dirty queue drain"
                    " (errors=%d dur=%.2fs)",
                    result["indexed"], result["total_files"], ph[:8], result["errors"], elapsed,
                )
            else:
                _LOG.info(
                    "reindexed %d/%d files in project %s after dirty queue drain (dur=%.2fs)",
                    result["indexed"], result["total_files"], ph[:8], elapsed,
                )
        except Exception:
            _LOG.exception("failed to reindex project %s from dirty queue", ph)
            _record_index_failure(ph, "<project>")
    _batch_elapsed = time.time() - _batch_t0
    _LOG.debug(
        "finished processing dirty entries: %d/%d projects reindexed (batch dur=%.2fs)",
        projects_processed, len(by_project), _batch_elapsed,
    )
