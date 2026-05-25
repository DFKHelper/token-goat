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
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from . import worker as _worker
from .util import get_logger

if TYPE_CHECKING:
    from .worker import CleanupStats, DirtyQueueEntry

_LOG = get_logger("worker")


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
    """Signal handler: clean up the PID file before exiting.

    Called on SIGTERM and SIGINT.  Explicitly removes the PID file as a
    belt-and-suspenders measure alongside the ``atexit.register(_clear_pid)``
    installed by :func:`run_daemon` — atexit fires on ``sys.exit`` (which this
    handler calls), so the cleanup happens twice in the normal path, but only
    the explicit call fires if the process is terminated in a way that bypasses
    atexit (e.g. hard kill before Python's signal-handler dispatch completes on
    some platforms).

    Note on ``pythonw.exe`` (Windows GUI subsystem): this process receives no
    console-control events, so SIGTERM / SIGINT never arrive via the terminal.
    The Windows-specific ``SetConsoleCtrlHandler`` path in
    :func:`_install_windows_console_handler` handles CTRL_CLOSE_EVENT /
    CTRL_SHUTDOWN_EVENT instead.  When the parent kills the process via
    ``TerminateProcess``, Python's atexit hooks do *not* run — this is a
    Windows OS limitation and is not fixable in user-space.  The PID file will
    be cleaned up on the *next* worker startup via ``cleanup_on_startup()``.
    """
    _LOG.debug("received signal %d; initiating clean shutdown", signum)
    with contextlib.suppress(Exception):
        _worker._clear_pid()
    sys.exit(0)


def _install_signal_handlers() -> None:
    """Register SIGTERM/SIGINT handlers that exit cleanly, suppressing errors on platforms
    where the signal module exists but signal installation is restricted (e.g. non-main threads).

    On POSIX systems SIGTERM is the standard graceful-termination signal; wiring
    it explicitly ensures the PID file is removed even when the process is stopped
    by a service manager (systemd, launchd) or ``kill <pid>``.

    On Windows ``pythonw.exe`` (GUI subsystem, no console attached), neither
    SIGTERM nor SIGINT arrives via the terminal — console-control events are
    handled separately by :func:`_install_windows_console_handler`.
    """
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
            _install_windows_console_handler._keepalive = _cb  # type: ignore[attr-defined]
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
        _LOG.info("another worker holds the slot; exiting")
        return

    # Belt-and-suspenders: ensure the PID file is removed even if the process is
    # killed via a signal path that bypasses the try/finally below (e.g. pythonw.exe
    # CTRL_CLOSE_EVENT with a very short grace window, or SIGKILL on POSIX).
    atexit.register(_worker._clear_pid)

    # try/finally so the claim file is always released, even if startup raises before the main loop.
    restart_for_upgrade = False
    try:
        _worker._clear_pid()
        _worker._write_pid()
        _worker._heartbeat()
        _worker._register_autostart()

        stats = cleanup_on_startup()
        if any(stats.values()):
            _LOG.info("startup cleanup: %s", stats)
        else:
            _LOG.debug("startup cleanup: no actions needed")

        last_heartbeat = time.time()
        last_maintenance = time.time()
        last_periodic_reindex = time.time()
        last_version_check = time.time()
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

        _install_signal_handlers()
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

            sleep_for = _worker.adaptive_poll_interval(consecutive_empty_drains)
            if stop_event is not None:
                stop_event.wait(timeout=sleep_for)
            else:
                time.sleep(sleep_for)
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
