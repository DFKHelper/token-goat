"""Worker daemon runtime and maintenance helpers."""
from __future__ import annotations

import contextlib
import logging
import os
import signal
import sys
import time
from typing import TYPE_CHECKING

from . import worker as _worker

if TYPE_CHECKING:
    from .worker import CleanupStats, DirtyQueueEntry

_LOG = logging.getLogger("token_goat.worker")


def cleanup_on_startup() -> CleanupStats:
    """Delegate startup cleanup to the worker core implementation."""
    return _worker.cleanup_on_startup()


def _reindex_active_projects() -> None:
    """Delegate periodic reindexing to the worker core implementation."""
    _worker._reindex_active_projects()


def _process_dirty_entries(entries: list[DirtyQueueEntry]) -> None:
    """Delegate dirty-queue processing to the worker core implementation."""
    _worker._process_dirty_entries(entries)


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
    else:
        _LOG.debug("startup cleanup: no actions needed")

    last_heartbeat = time.time()
    last_maintenance = time.time()
    last_periodic_reindex = time.time()
    last_version_check = time.time()
    restart_for_upgrade = False
    _LOG.debug("worker main loop initialized: heartbeat=%.1fs maintenance=%.1fs reindex=%.1fs",
              _worker.HEARTBEAT_INTERVAL, _worker.MAINTENANCE_INTERVAL, _worker.PERIODIC_REINDEX_INTERVAL)

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
                _LOG.debug("worker heartbeat written")

            entries = _worker.drain_dirty_queue()
            if entries:
                _LOG.debug("found %d dirty queue entries, processing", len(entries))
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
                        "token-goat %s changed on disk (version %s -> %s); "
                        "restarting worker to load new code",
                        "version" if version_changed else "code",
                        _worker._BOOTED_VERSION,
                        current,
                    )
                    restart_for_upgrade = True
                    break
                last_version_check = now

            if stop_event is not None:
                stop_event.wait(timeout=_worker.POLL_INTERVAL)
            else:
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
