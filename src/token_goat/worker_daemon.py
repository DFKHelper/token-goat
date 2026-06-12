"""Worker daemon runtime and maintenance helpers.

The worker runs as a *separate process* rather than a background thread in the
hook process for two reasons:

1. **Hook latency** — every tool call (Read, Write, Bash, …) spawns a fresh
   hook process.  A heavy background thread inside that process would add
   startup cost to every hook invocation.  A long-lived separate process pays
   the startup cost once and then idles between dirty-queue drains.

2. **Lifetime independence** — hook processes are short-lived (one per tool
   call).  Dirty-queue processing, periodic reindexing, and maintenance tasks
   can outlast any individual hook.  A separate daemon process survives hook
   process exits without needing to transfer work across process boundaries.
"""
from __future__ import annotations

import atexit
import contextlib
import ctypes
import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from . import worker as _worker
from .util import get_logger

if TYPE_CHECKING:
    from .worker import CleanupStats, DirtyQueueEntry

# ---------------------------------------------------------------------------
# Watchdog thread
# ---------------------------------------------------------------------------

# Sentinel returned by _read_pid_from_file when the PID file is absent or unreadable.
_PID_UNKNOWN = -1


def _read_pid_from_file() -> int:
    """Return the PID written by the worker, or _PID_UNKNOWN if unavailable.

    Handles both the legacy plain-integer format (``"12345"``) and the current
    JSON format written by :func:`token_goat.worker._write_pid`:
    ``{"pid": N, "started_at": "...", "interpreter": "...", "version": "..."}``.
    """
    from . import paths  # noqa: PLC0415
    from . import worker as _w  # noqa: PLC0415

    try:
        pid, _interp = _w._read_pid_info(paths.worker_pid_path().read_text(encoding="utf-8"))
        return pid
    except (OSError, ValueError):
        return _PID_UNKNOWN


def _pid_is_alive(pid: int) -> bool:
    """Return True if *pid* is a running process.

    Uses psutil when available (always the case since it is a hard dependency);
    falls back to os.kill(pid, 0) on POSIX or OpenProcess on Windows.
    PermissionError / AccessDenied means the process exists but we cannot
    inspect it — treat as alive.
    """
    try:
        import psutil  # noqa: PLC0415

        return psutil.pid_exists(pid)
    except ImportError:
        pass
    # Fallback: POSIX os.kill signal-0 probe
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True  # process exists but no permission
    except (ProcessLookupError, OSError):
        return False


class WatchdogThread(threading.Thread):
    """Background thread that monitors a worker process and restarts it on unexpected exit.

    The watchdog polls every *poll_interval* seconds to check whether the worker
    PID is still alive.  When the PID disappears and the watchdog has not been
    signalled to stop (indicating a graceful shutdown), it waits *retry_delay*
    seconds, then calls *launch_fn()* to start a fresh worker.  It tracks
    restart attempts inside a sliding window of *window_secs* seconds and gives
    up after *max_retries* restarts within that window to avoid a tight restart
    loop on a broken worker.

    Args:
        pid_file_reader: Callable that returns the current worker PID (int), or
            _PID_UNKNOWN (-1) when the PID file is absent or unreadable.
        launch_fn: Callable that starts the worker and returns its PID (or None
            on failure).  Called from the watchdog thread on each restart.
        max_retries: Maximum number of restarts allowed within *window_secs*.
            Default 5.
        window_secs: Sliding window duration (seconds) for the retry counter.
            Default 600 (10 minutes).
        retry_delay: Seconds to wait after detecting an unexpected exit before
            calling *launch_fn*.  Default 5.
        poll_interval: Seconds between liveness checks.  Default 2.
    """

    def __init__(
        self,
        pid_file_reader: Callable[[], int],
        launch_fn: Callable[[], int | None],
        *,
        max_retries: int = 5,
        window_secs: float = 600.0,
        retry_delay: float = 5.0,
        poll_interval: float = 2.0,
        on_latch: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(name="token-goat-watchdog", daemon=True)
        self._pid_file_reader = pid_file_reader
        self._launch_fn = launch_fn
        self._max_retries = max_retries
        self._window_secs = window_secs
        self._retry_delay = retry_delay
        self._poll_interval = poll_interval
        self._on_latch = on_latch
        self._stop_event = threading.Event()
        # List of monotonic timestamps for each restart attempt (used for window eviction).
        self._restart_times: list[float] = []

    def stop(self) -> None:
        """Signal the watchdog to exit cleanly.  Non-blocking."""
        self._stop_event.set()

    def _retries_in_window(self) -> int:
        """Return the count of restart attempts within the current window."""
        cutoff = time.monotonic() - self._window_secs
        self._restart_times = [t for t in self._restart_times if t >= cutoff]
        return len(self._restart_times)

    def run(self) -> None:
        """Main watchdog loop.  Runs in a background daemon thread."""
        _LOG.debug("watchdog thread started")
        watched_pid: int = _PID_UNKNOWN
        try:
            while not self._stop_event.is_set():
                self._stop_event.wait(timeout=self._poll_interval)
                if self._stop_event.is_set():
                    break

                current_pid = self._pid_file_reader()

                # If we have a valid PID and the worker just came up (or we
                # haven't tracked one yet), latch onto it.
                if current_pid != _PID_UNKNOWN and current_pid != watched_pid:
                    watched_pid = current_pid
                    if self._on_latch is not None:
                        with contextlib.suppress(Exception):
                            self._on_latch()

                # If we don't have a PID to watch yet, nothing to do.
                if watched_pid == _PID_UNKNOWN:
                    continue

                # Check liveness.
                if _pid_is_alive(watched_pid):
                    continue

                # PID is gone.  If the stop event is set this is a graceful
                # shutdown — do not restart.
                if self._stop_event.is_set():
                    break

                # Unexpected exit detected.
                _LOG.warning(
                    "watchdog: worker pid=%d exited unexpectedly; considering restart",
                    watched_pid,
                )

                retries = self._retries_in_window()
                if retries >= self._max_retries:
                    _LOG.error(
                        "watchdog: %d restarts in %.0fs window; giving up to prevent restart loop",
                        retries,
                        self._window_secs,
                    )
                    break

                # Wait before restarting to avoid a tight loop.
                _LOG.info(
                    "watchdog: waiting %.1fs before restart attempt %d/%d",
                    self._retry_delay,
                    retries + 1,
                    self._max_retries,
                )
                self._stop_event.wait(timeout=self._retry_delay)
                if self._stop_event.is_set():
                    break

                # Attempt restart.
                _LOG.info(
                    "watchdog: restarting worker (attempt %d/%d)",
                    retries + 1,
                    self._max_retries,
                )
                try:
                    new_pid = self._launch_fn()
                except Exception:  # noqa: BLE001
                    _LOG.exception("watchdog: launch_fn raised during restart attempt")
                    new_pid = None

                if new_pid is not None:
                    _LOG.info("watchdog: worker restarted, new pid=%d", new_pid)
                    watched_pid = new_pid
                else:
                    _LOG.warning("watchdog: restart attempt returned no PID; will retry")
                    # Keep watched_pid as-is (the dead PID) so the next poll
                    # re-enters the "PID gone" branch and can reach the max_retries
                    # check rather than falling through to the _PID_UNKNOWN early exit.

                self._restart_times.append(time.monotonic())

        except Exception:  # noqa: BLE001
            _LOG.exception("watchdog thread crashed — watchdog disabled for this session")
        finally:
            _LOG.debug("watchdog thread exiting")

_LOG = get_logger("worker")

# Module-level stop event used by signal handlers.  Set by _install_signal_handlers
# so that SIGTERM/SIGINT causes the main loop to exit cleanly after the current
# work unit finishes, rather than calling sys.exit() mid-index which can leave
# SQLite WAL writes partially committed.
_daemon_stop_event: threading.Event | None = None


def cleanup_on_startup() -> CleanupStats:
    """Delegate startup cleanup to the worker core implementation."""
    return _worker.cleanup_on_startup()


def _reindex_active_projects() -> None:
    """Delegate periodic reindexing to the worker core implementation."""
    _worker._reindex_active_projects()


def _process_dirty_entries(entries: list[DirtyQueueEntry]) -> None:
    """Delegate dirty-queue processing to the worker core implementation."""
    _worker._process_dirty_entries(entries)


def _graceful_shutdown(signum: int, frame: object) -> None:
    """Signal handler: request a clean shutdown by setting the stop event.

    Called on SIGTERM and SIGINT.  Rather than calling ``sys.exit()``
    immediately — which can interrupt an in-progress ``index_project`` call
    mid-write and corrupt the SQLite WAL — this handler sets the module-level
    ``_daemon_stop_event`` so the main loop exits cleanly after the current
    work unit finishes.

    The PID file is also cleared here as a belt-and-suspenders measure: the
    try/finally in ``run_daemon`` removes it on normal exit, but the explicit
    removal here covers the edge case where the signal arrives while the main
    loop is blocked in a long sleep (``stop_event.wait``).

    Note on ``pythonw.exe`` (Windows GUI subsystem): this process receives no
    console-control events, so SIGTERM / SIGINT never arrive via the terminal.
    The Windows-specific ``SetConsoleCtrlHandler`` path in
    :func:`_install_windows_console_handler` handles CTRL_CLOSE_EVENT /
    CTRL_SHUTDOWN_EVENT instead.  When the parent kills the process via
    ``TerminateProcess``, Python's atexit hooks do *not* run — this is a
    Windows OS limitation and is not fixable in user-space.  The PID file will
    be cleaned up on the *next* worker startup via ``cleanup_on_startup()``.
    """
    _LOG.debug("received signal %d; requesting clean shutdown", signum)
    global _daemon_stop_event  # noqa: PLW0603
    if _daemon_stop_event is not None:
        _daemon_stop_event.set()
    else:
        # No stop event available (e.g. signal arrived before run_daemon
        # initialised _daemon_stop_event). Fall back to the old behaviour so
        # the process still terminates on signal.
        with contextlib.suppress(Exception):
            _worker._clear_pid()
        sys.exit(0)


def _install_signal_handlers(stop_event: threading.Event | None = None) -> None:
    """Register SIGTERM/SIGINT handlers that exit cleanly, suppressing errors on platforms
    where the signal module exists but signal installation is restricted (e.g. non-main threads).

    On POSIX systems SIGTERM is the standard graceful-termination signal; wiring
    it explicitly ensures the PID file is removed even when the process is stopped
    by a service manager (systemd, launchd) or ``kill <pid>``.

    On Windows ``pythonw.exe`` (GUI subsystem, no console attached), neither
    SIGTERM nor SIGINT arrives via the terminal — console-control events are
    handled separately by :func:`_install_windows_console_handler`.

    The *stop_event* is stored in the module-level ``_daemon_stop_event`` so the
    signal handler can set it without requiring a closure.  When *stop_event* is
    None the handler falls back to ``sys.exit`` (backward-compatible for callers
    that do not supply a stop event, e.g. tests).
    """
    global _daemon_stop_event  # noqa: PLW0603
    _daemon_stop_event = stop_event
    for sig in (signal.SIGTERM, signal.SIGINT):
        if hasattr(signal, sig.name):
            with contextlib.suppress(ValueError, AttributeError):
                signal.signal(sig, _graceful_shutdown)


def _install_windows_console_handler(stop_event=None) -> None:
    """Register a Windows console-control handler via SetConsoleCtrlHandler.

    Handles CTRL_CLOSE_EVENT (2) and CTRL_SHUTDOWN_EVENT (6).  On either event
    the handler sets *stop_event* (if provided) so the main loop can exit
    gracefully, then calls _clear_pid() directly as a belt-and-suspenders
    cleanup.  Returning True from the callback gives Windows up to 5 s of grace
    before it force-terminates the process.

    The entire registration is wrapped in try/except so that environments that
    don't support the call (e.g. no console attached under pythonw.exe) fall
    back silently rather than breaking the daemon.
    """
    _CTRL_CLOSE_EVENT = 2
    _CTRL_SHUTDOWN_EVENT = 6

    # HandlerRoutine prototype: BOOL WINAPI HandlerRoutine(DWORD dwCtrlType)
    _HandlerProto = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_ulong)

    def _handler(ctrl_type: int) -> bool:
        if ctrl_type in (_CTRL_CLOSE_EVENT, _CTRL_SHUTDOWN_EVENT):
            _LOG.debug(
                "Windows console-control event %d received; initiating clean shutdown",
                ctrl_type,
            )
            if stop_event is not None:
                stop_event.set()
            with contextlib.suppress(Exception):
                _worker._clear_pid()
            return True  # handled — gives up to 5 s before forced kill
        return False  # not handled — pass to next handler

    try:
        _cb = _HandlerProto(_handler)
        result = ctypes.windll.kernel32.SetConsoleCtrlHandler(_cb, True)
        if result:
            # Keep the callback object alive for the process lifetime to prevent
            # the GC from collecting the ctypes function pointer while it is still
            # registered with the OS.
            _install_windows_console_handler._keepalive = _cb  # type: ignore[attr-defined]  # storing keepalive as function attribute; functions accept arbitrary attrs at runtime
            _LOG.debug("Windows console-control handler registered")
        else:
            _LOG.debug(
                "SetConsoleCtrlHandler returned 0 (no console attached or permission denied); skipping"
            )
    except Exception:  # noqa: BLE001
        _LOG.debug("Windows console-control handler registration failed; falling back to no-op")


def _timed_cycle(label: str, fn: Callable[[], None]) -> None:
    """Run *fn*, logging elapsed time on success and exception details on failure.

    Both periodic cycle functions share this pattern: record a start timestamp,
    call the work function, and emit a timed completion or exception log.  Extracted
    to avoid duplicating the ``t0``/``try``/``except`` boilerplate in every cycle.
    """
    _LOG.info("starting %s", label)
    t0 = time.time()
    try:
        fn()
    except Exception:  # noqa: BLE001
        _LOG.exception("%s failed after %.2fs", label, time.time() - t0)
    else:
        _LOG.info("%s completed in %.2fs", label, time.time() - t0)


def _run_maintenance_cycle() -> None:
    """Execute one periodic maintenance cycle, logging duration and results."""
    _LOG.info("starting maintenance cycle")
    t0 = time.time()
    try:
        s = cleanup_on_startup()
    except Exception:  # noqa: BLE001
        _LOG.exception("periodic maintenance failed after %.2fs", time.time() - t0)
    else:
        elapsed = time.time() - t0
        if any(s.values()):
            _LOG.info("periodic maintenance completed in %.2fs: %s", elapsed, s)
        else:
            _LOG.debug("periodic maintenance completed in %.2fs (no actions needed)", elapsed)


def _run_reindex_cycle() -> None:
    """Execute one periodic reindex cycle, logging duration and any failure."""
    _timed_cycle("periodic reindex cycle", _reindex_active_projects)


def _detect_upgrade() -> bool:
    """Return True when a package version or code fingerprint change is detected.

    Compares the currently installed version/fingerprint against the values
    captured at daemon boot.  Returns False when either snapshot is unavailable
    (fresh install with no prior boot record) so the daemon does not restart
    unnecessarily on the very first run.

    Returning True signals the caller loop to break and set restart_for_upgrade;
    the daemon exits cleanly and the autostart mechanism (registry key on Windows,
    systemd unit on Linux) relaunches it so the new code loads without any
    in-process restart attempt.
    """
    current_version = _worker._installed_version()
    current_fp = _worker._package_fingerprint()
    version_changed = (
        _worker._BOOTED_VERSION is not None
        and current_version is not None
        and current_version != _worker._BOOTED_VERSION
    )
    code_changed = (
        _worker._BOOTED_FINGERPRINT is not None
        and current_fp is not None
        and current_fp != _worker._BOOTED_FINGERPRINT
    )
    if version_changed or code_changed:
        _LOG.info(
            "token-goat %s changed on disk (version %s -> %s); restarting worker to load new code",
            "version" if version_changed else "code",
            _worker._BOOTED_VERSION,
            current_version,
        )
        return True
    return False


def run_daemon(stop_event=None) -> None:
    """Main loop: heartbeat + dirty-queue processing + periodic maintenance."""
    _worker._setup_logging()

    claim_fd = _worker._try_claim_worker_slot()
    if claim_fd is None:
        # Read the PID file to surface the conflicting interpreter — this is the
        # cross-interpreter duplicate guard.  Two workers started from different
        # Python executables (e.g. project venv vs system Python) share the same
        # data directory and therefore contend for the same claim file.  Logging
        # the PID + interpreter of the winner lets the user immediately identify
        # the duplicate via `token-goat doctor` or the log file.
        try:
            from . import paths as _paths  # noqa: PLC0415
            _pid_text = _paths.worker_pid_path().read_text(encoding="utf-8")
            _pid, _exe = _worker._read_pid_info(_pid_text)
            if _exe:
                _LOG.warning(
                    "another token-goat worker is already running (PID %d, interpreter %s); exiting",
                    _pid, _exe,
                )
            else:
                _LOG.info("another worker holds the slot (PID %d); exiting", _pid)
        except (OSError, ValueError):
            _LOG.info("another worker holds the slot; exiting")
        return

    # Belt-and-suspenders: ensure the PID file is removed even if the process is
    # killed via a signal path that bypasses the try/finally below (e.g. pythonw.exe
    # CTRL_CLOSE_EVENT with a very short grace window, or SIGKILL on POSIX).
    atexit.register(_worker._clear_pid)

    # try/finally so the claim file is always released, even if startup raises before the main loop.
    restart_for_upgrade = False
    watchdog: WatchdogThread | None = None
    try:
        _worker._clear_pid()
        _worker._write_pid()

        # Post-write race guard: re-read the PID file and verify it contains
        # OUR PID.  If another process raced and overwrote it between our
        # _try_claim_worker_slot (which is the authoritative mutex) and
        # _write_pid, exit rather than running two main loops.  This is
        # belt-and-suspenders — _try_claim_worker_slot already uses O_EXCL
        # so this case should be theoretically impossible, but the verification
        # costs one file-read and makes the invariant explicit and testable.
        try:
            from . import paths as _paths  # noqa: PLC0415
            _written_text = _paths.worker_pid_path().read_text(encoding="utf-8")
            _written_pid, _written_exe = _worker._read_pid_info(_written_text)
            if _written_pid != os.getpid():
                _LOG.error(
                    "PID file contains PID %d after write but our PID is %d; "
                    "another process won the startup race — exiting",
                    _written_pid, os.getpid(),
                )
                return
        except (OSError, ValueError) as _e:
            _LOG.warning("could not verify PID file after write: %s; continuing", _e)

        _worker._heartbeat()
        _worker._register_autostart()

        # Start the auto-restart watchdog unless disabled in config.  The watchdog
        # thread monitors the worker PID file and calls spawn_detached() if the
        # PID disappears without a graceful-stop signal.  It is a daemon thread so
        # it cannot block process exit; the finally block always calls watchdog.stop()
        # to distinguish graceful shutdown from an unexpected exit.
        try:
            from . import config as _cfg  # noqa: PLC0415
            _watchdog_enabled = _cfg.load().worker.watchdog_enabled
        except Exception:  # noqa: BLE001
            _watchdog_enabled = True  # fail-open: default to enabled

        if _watchdog_enabled:
            watchdog = WatchdogThread(
                pid_file_reader=_read_pid_from_file,
                launch_fn=_worker.spawn_detached,
            )
            watchdog.start()
            _LOG.debug("watchdog thread started")

        stats = cleanup_on_startup()
        if any(stats.values()):
            _LOG.info("startup cleanup: %s", stats)
        else:
            _LOG.debug("startup cleanup: no actions needed")

        last_heartbeat = time.time()
        last_maintenance = time.time()
        last_periodic_reindex = time.time()
        last_version_check = time.time()
        last_gc_projects = time.time()
        # Consecutive zero-entry drains; drives adaptive back-off so a long-idle worker wakes less often.
        consecutive_empty_drains = 0
        _LOG.debug(
            "worker main loop initialized: heartbeat=%.1fs maintenance=%.1fs reindex=%.1fs",
            _worker.HEARTBEAT_INTERVAL,
            _worker.MAINTENANCE_INTERVAL,
            _worker.PERIODIC_REINDEX_INTERVAL,
        )

        def should_stop() -> bool:
            """Return True when the caller has signalled the worker to shut down."""
            return stop_event is not None and stop_event.is_set()

        # Pass the stop_event to the signal installer so SIGTERM/SIGINT sets it
        # instead of calling sys.exit() mid-index.  The Windows console handler
        # already accepts stop_event directly.
        _install_signal_handlers(stop_event=stop_event)
        if sys.platform == "win32":
            _install_windows_console_handler(stop_event=stop_event)
        _LOG.info("worker started, pid=%s", os.getpid())

        while not should_stop():
            now = time.time()

            if now - last_heartbeat >= _worker.HEARTBEAT_INTERVAL:
                _worker._heartbeat()
                last_heartbeat = now
                _LOG.debug("worker heartbeat written")

            entries = _worker.drain_dirty_queue()
            if entries:
                _LOG.debug("found %d dirty queue entries, processing", len(entries))
                _process_dirty_entries(entries)
                # Real work resets the idle counter so the next poll runs at the baseline interval, never slowed by stale back-off from a prior quiet stretch.
                consecutive_empty_drains = 0
            elif entries is None:
                # Drain deferred (queue existed but couldn't be claimed) — work is still pending, so don't let this count as an idle cycle and slow back-off.
                consecutive_empty_drains = 0
            else:
                consecutive_empty_drains += 1

            if now - last_maintenance >= _worker.MAINTENANCE_INTERVAL:
                _run_maintenance_cycle()
                last_maintenance = now

            if now - last_periodic_reindex >= _worker.PERIODIC_REINDEX_INTERVAL:
                _run_reindex_cycle()
                last_periodic_reindex = now

            if now - last_version_check >= _worker.VERSION_CHECK_INTERVAL:
                if _detect_upgrade():
                    restart_for_upgrade = True
                    break
                last_version_check = now

            if now - last_gc_projects >= _worker.GC_PROJECTS_INTERVAL:
                _timed_cycle("gc orphaned projects", _worker._gc_orphaned_projects)  # type: ignore[arg-type]
                last_gc_projects = now

            sleep_for = _worker.adaptive_poll_interval(consecutive_empty_drains)
            if stop_event is not None:
                stop_event.wait(timeout=sleep_for)
            else:
                time.sleep(sleep_for)
    finally:
        _LOG.info("worker shutting down, pid=%s", os.getpid())
        # Signal the watchdog before clearing the PID file so it knows this is a
        # graceful exit and does not attempt a spurious respawn.
        if watchdog is not None:
            watchdog.stop()
        _worker._clear_pid()
        with contextlib.suppress(OSError):
            os.close(claim_fd)
        with contextlib.suppress(OSError):
            _worker._worker_claim_path().unlink()

    if restart_for_upgrade:
        _LOG.info("respawning worker with updated code")
        _worker.spawn_detached()


# ---------------------------------------------------------------------------
# Duplicate daemon kill (used by `token-goat worker --kill-duplicate`)
# ---------------------------------------------------------------------------

def kill_duplicate_daemon() -> str:
    """Kill a running worker whose interpreter path differs from the current Python executable.

    Returns a human-readable status line describing what was done:
    - "Killed duplicate daemon (PID NNN, interpreter /path/to/python)"
    - "No duplicate daemon found."
    - "No running worker found." (PID file absent or process dead)
    - "Worker interpreter unknown (legacy pid file format)."

    The kill is platform-appropriate: ``SIGTERM`` on POSIX, ``TerminateProcess``
    via ctypes on Windows.  The function never raises; all errors are returned
    as descriptive strings so the CLI can print them without crashing.
    """
    from . import paths  # noqa: PLC0415
    from . import worker as _w  # noqa: PLC0415

    pid_path = paths.worker_pid_path()
    if not pid_path.exists():
        return "No running worker found."

    try:
        pid_text = pid_path.read_text(encoding="utf-8")
        pid, worker_interp = _w._read_pid_info(pid_text)
    except (OSError, ValueError) as exc:
        return f"No running worker found (pid file unreadable: {exc})."

    if not _pid_is_alive(pid):
        with contextlib.suppress(OSError):
            pid_path.unlink()
        return "No running worker found."

    if worker_interp is None:
        return "Worker interpreter unknown (legacy pid file format)."

    def _norm(p: str) -> str:
        return p.replace("\\", "/").casefold() if sys.platform == "win32" else p

    if _norm(worker_interp) == _norm(sys.executable):
        return "No duplicate daemon found."

    # The running worker uses a different interpreter — kill it.
    try:
        if sys.platform == "win32":
            PROCESS_TERMINATE = 0x0001
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if handle:
                ctypes.windll.kernel32.TerminateProcess(handle, 1)
                ctypes.windll.kernel32.CloseHandle(handle)
            else:
                return f"Could not open process PID {pid} for termination (OpenProcess returned NULL)."
        else:
            import signal as _signal  # noqa: PLC0415
            os.kill(pid, _signal.SIGTERM)
    except OSError as exc:
        return f"Failed to kill PID {pid}: {exc}."

    # Remove the stale PID file so subsequent is_worker_alive() / --check calls reflect the kill immediately; on POSIX the process may linger but heartbeat freshness prevents a false positive.
    with contextlib.suppress(OSError):
        pid_path.unlink()

    return f"Killed duplicate daemon (PID {pid}, interpreter {worker_interp})."


# ---------------------------------------------------------------------------
# Worker status query (used by `token-goat worker --status`)
# ---------------------------------------------------------------------------

def query_worker_status() -> dict[str, object]:
    """Return a dict describing current worker status.

    Keys:
        running (bool): True if the worker process appears to be alive.
        pid (int | None): PID from the pid file, or None.
        interpreter (str | None): Python executable path from the pid file, or None.
        started_at (str | None): ISO-format start timestamp from the pid file, or None.
        autostart (str | None): 'systemd', 'registry', 'xdg', or None.
        autostart_active (bool | None): True/False/None (None = unknown).
        pool_size (int): Configured max_pool_workers from config (default 4).
        last_log_line (str | None): Last non-empty line from today's log file.
    """
    from . import paths  # noqa: PLC0415

    pid: int | None = None
    interpreter: str | None = None
    started_at: str | None = None
    running = False

    pid_path = paths.worker_pid_path()
    if pid_path.exists():
        try:
            import json as _json  # noqa: PLC0415

            from . import worker as _w  # noqa: PLC0415
            pid_text = pid_path.read_text(encoding="utf-8")
            pid_raw, interp = _w._read_pid_info(pid_text)
            if pid_raw != _PID_UNKNOWN:
                pid = pid_raw
                interpreter = interp
                running = _pid_is_alive(pid_raw)
                # Extract started_at from the JSON payload if present.
                try:
                    data = _json.loads(pid_text.strip())
                    started_at = data.get("started_at") or None
                except (ValueError, KeyError):
                    pass
        except (OSError, ValueError):
            pass

    # Fall back to the simple reader when the above block didn't populate pid.
    if pid is None:
        raw_pid = _read_pid_from_file()
        if raw_pid != _PID_UNKNOWN:
            pid = raw_pid
            running = _pid_is_alive(raw_pid)

    # Pool size from config (fail-soft: return the default if config unavailable).
    pool_size: int = 4
    try:
        from . import config as _cfg  # noqa: PLC0415
        pool_size = _cfg.load().worker.max_pool_workers
    except Exception:  # noqa: BLE001
        pass

    autostart: str | None = None
    autostart_active: bool | None = None

    if sys.platform == "win32":
        autostart = "registry"
        try:
            import winreg  # type: ignore[import]

            from . import install  # noqa: PLC0415
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                install._HKCU_RUN_PATH,
                0,
                winreg.KEY_READ,
            ) as key:
                try:
                    winreg.QueryValueEx(key, install.TASK_WORKER)
                    autostart_active = True
                except FileNotFoundError:
                    autostart_active = False
        except Exception:  # noqa: BLE001
            autostart_active = None
    elif sys.platform.startswith("linux") or sys.platform == "darwin":
        from . import install  # noqa: PLC0415
        if install._systemd_service_path().exists():
            autostart = "systemd"
            try:
                import subprocess  # noqa: PLC0415
                result = subprocess.run(
                    ["systemctl", "--user", "is-active", f"{install.SYSTEMD_SERVICE_NAME}.service"],
                    capture_output=True,
                    timeout=5,
                )
                autostart_active = result.returncode == 0
            except Exception:  # noqa: BLE001
                autostart_active = None
        else:
            from . import install as _inst  # noqa: PLC0415
            xdg_path = _inst._xdg_desktop_path() if hasattr(_inst, "_xdg_desktop_path") else None
            if xdg_path and xdg_path.exists():
                autostart = "xdg"
                autostart_active = True
            else:
                autostart = None
                autostart_active = False

    last_log_line: str | None = None
    try:
        import datetime  # noqa: PLC0415
        today = datetime.date.today().strftime("%Y-%m-%d")
        log_file = paths.logs_dir() / f"{today}.log"
        if log_file.exists():
            text = log_file.read_text(encoding="utf-8", errors="replace")
            lines = [ln for ln in text.splitlines() if ln.strip()]
            if lines:
                last_log_line = lines[-1]
    except Exception:  # noqa: BLE001
        pass

    return {
        "running": running,
        "pid": pid,
        "interpreter": interpreter,
        "started_at": started_at,
        "autostart": autostart,
        "autostart_active": autostart_active,
        "pool_size": pool_size,
        "last_log_line": last_log_line,
    }
