"""Tests for worker_daemon — loop-level branches not covered by test_worker.py."""
from __future__ import annotations

import threading
from unittest.mock import patch

import token_goat.worker as worker
import token_goat.worker_daemon as daemon

# ---------------------------------------------------------------------------
# Thin delegate functions
# ---------------------------------------------------------------------------


def test_reindex_active_projects_delegate(tmp_data_dir):
    """worker_daemon._reindex_active_projects() delegates to worker._reindex_active_projects."""
    called = threading.Event()

    def _fake():
        called.set()

    with patch.object(worker, "_reindex_active_projects", _fake):
        daemon._reindex_active_projects()

    assert called.is_set()


def test_process_dirty_entries_delegate(tmp_data_dir):
    """worker_daemon._process_dirty_entries() delegates to worker._process_dirty_entries."""
    captured = []

    def _fake(entries):
        captured.extend(entries)

    entries = [{"path": "foo.py", "project_hash": "abc", "project_root": "/p", "project_marker": ".git", "ts": 0.0}]
    with patch.object(worker, "_process_dirty_entries", _fake):
        daemon._process_dirty_entries(entries)

    assert captured == entries


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _base_patches(**overrides):
    """Return a dict of common patch targets for run_daemon loop tests."""
    defaults = {
        "HEARTBEAT_INTERVAL": 9999.0,
        "MAINTENANCE_INTERVAL": 9999.0,
        "PERIODIC_REINDEX_INTERVAL": 9999.0,
        "VERSION_CHECK_INTERVAL": 9999.0,
        "POLL_INTERVAL": 0.001,
    }
    defaults.update(overrides)
    return defaults


# ---------------------------------------------------------------------------
# run_daemon — startup cleanup log path
# ---------------------------------------------------------------------------


def test_run_daemon_logs_startup_cleanup(tmp_data_dir):
    """When startup cleanup reclaims something, the log path is hit (line 48)."""
    stop = threading.Event()
    stop.set()  # exit immediately after setup

    cleanup_result = {"stale_locks": 1, "stale_index_markers": 0}

    with (
        patch.object(worker, "cleanup_on_startup", return_value=cleanup_result),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_clear_pid"),
        patch.object(worker, "_write_pid"),
        patch.object(worker, "_register_autostart"),
        patch("time.sleep"),
    ):
        daemon.run_daemon(stop_event=stop)


# ---------------------------------------------------------------------------
# run_daemon — heartbeat fires inside the loop
# ---------------------------------------------------------------------------


def test_run_daemon_heartbeat_fires(tmp_data_dir):
    """Heartbeat branch executes when HEARTBEAT_INTERVAL elapses (lines 74-75)."""
    stop = threading.Event()
    heartbeat_called = threading.Event()
    call_count = [0]

    def _fake_heartbeat():
        call_count[0] += 1
        if call_count[0] >= 2:
            heartbeat_called.set()
            stop.set()

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 0.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 9999.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "_heartbeat", _fake_heartbeat),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "cleanup_on_startup", return_value={}),
    ):
        daemon.run_daemon(stop_event=stop)

    assert heartbeat_called.is_set(), "heartbeat was not fired inside the loop"


# ---------------------------------------------------------------------------
# run_daemon — dirty entries processed
# ---------------------------------------------------------------------------


def test_run_daemon_processes_dirty_entries(tmp_data_dir):
    """When drain_dirty_queue returns entries, _process_dirty_entries is called (line 79)."""
    stop = threading.Event()
    processed = threading.Event()

    fake_entry = {"path": "x.py", "project_hash": "h", "project_root": "/r", "project_marker": ".git", "ts": 0.0}
    drain_calls = [0]

    def _fake_drain():
        drain_calls[0] += 1
        if drain_calls[0] == 1:
            return [fake_entry]
        stop.set()
        return []

    def _fake_process(entries):
        processed.set()

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 9999.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "drain_dirty_queue", _fake_drain),
        patch.object(worker, "_process_dirty_entries", _fake_process),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", return_value={}),
    ):
        daemon.run_daemon(stop_event=stop)

    assert processed.is_set(), "_process_dirty_entries was not called"


# ---------------------------------------------------------------------------
# run_daemon — maintenance cycle (success and exception paths)
# ---------------------------------------------------------------------------


def test_run_daemon_maintenance_cycle_no_actions(tmp_data_dir):
    """Maintenance cycle with empty CleanupStats hits the debug-log branch (line 88)."""
    stop = threading.Event()
    maintenance_calls = [0]

    def _fake_cleanup():
        maintenance_calls[0] += 1
        if maintenance_calls[0] >= 2:
            stop.set()
        return {}  # no actions — triggers the else-branch

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 0.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", _fake_cleanup),
    ):
        daemon.run_daemon(stop_event=stop)


def test_run_daemon_maintenance_cycle_with_actions(tmp_data_dir):
    """Maintenance cycle with non-empty CleanupStats hits the info-log branch (line 86)."""
    stop = threading.Event()
    maintenance_calls = [0]

    def _fake_cleanup():
        maintenance_calls[0] += 1
        if maintenance_calls[0] >= 2:
            stop.set()
        return {"stale_locks": 1}  # non-empty — triggers the if-branch

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 0.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", _fake_cleanup),
    ):
        daemon.run_daemon(stop_event=stop)


def test_run_daemon_maintenance_exception_swallowed(tmp_data_dir):
    """Exception in maintenance cycle is caught and logged, not propagated (lines 89-90)."""
    stop = threading.Event()
    maintenance_calls = [0]

    def _fake_cleanup():
        maintenance_calls[0] += 1
        # Call 1 = startup (not in try/except) → succeed
        # Call 2 = maintenance loop → raise (covered by the loop's try/except)
        # Call 3+ = stop
        if maintenance_calls[0] == 1:
            return {}
        if maintenance_calls[0] >= 3:
            stop.set()
            return {}
        raise RuntimeError("maintenance exploded")

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 0.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", _fake_cleanup),
    ):
        daemon.run_daemon(stop_event=stop)  # must not raise


# ---------------------------------------------------------------------------
# run_daemon — periodic reindex exception path
# ---------------------------------------------------------------------------


def test_run_daemon_periodic_reindex_exception_swallowed(tmp_data_dir):
    """Exception in _reindex_active_projects is caught and logged (lines 96-97)."""
    stop = threading.Event()
    reindex_calls = [0]

    def _fake_reindex():
        reindex_calls[0] += 1
        if reindex_calls[0] >= 2:
            stop.set()
            return
        raise RuntimeError("reindex boom")

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 9999.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 0.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "POLL_INTERVAL", 0.001),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "_reindex_active_projects", _fake_reindex),
    ):
        daemon.run_daemon(stop_event=stop)  # must not raise
