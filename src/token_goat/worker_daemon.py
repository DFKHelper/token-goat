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

import contextlib
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


def _install_signal_handlers() -> None:
    """Register SIGTERM/SIGINT handlers that exit cleanly, suppressing errors on platforms
    where the signal module exists but signal installation is restricted (e.g. non-main threads).
    """
    for sig in (signal.SIGTERM, signal.SIGINT):
        if hasattr(signal, sig.name):
            with contextlib.suppress(ValueError, AttributeError):
                signal.signal(sig, lambda *_: sys.exit(0))


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
