"""Tests for worker_daemon — loop-level branches not covered by test_worker.py."""
from __future__ import annotations

import ctypes
import sys
import threading
from unittest.mock import patch

import pytest

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
        # Don't let the daemon install real SIGTERM/SIGINT handlers — under xdist
        # the worker subprocess receives SIGTERM from the controller at shutdown,
        # and a handler that does sys.exit(0) takes the worker down hard before
        # execnet can flush its IPC channel ("node down: Not properly terminated").
        patch.object(daemon, "_install_signal_handlers"),
        # _try_claim_worker_slot is patched to return integer 3 as a sentinel,
        # but the daemon's finally-block then does os.close(3). Under xdist that
        # fd is execnet's IPC channel — closing it crashes the worker even
        # though contextlib.suppress(OSError) catches the resulting bad-fd
        # error. Patch os.close to a no-op so the sentinel cannot collide with
        # a real fd.
        patch("os.close"),
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


# ---------------------------------------------------------------------------
# run_daemon — claim-file cleanup when startup raises before the main loop
# ---------------------------------------------------------------------------


def test_run_daemon_releases_claim_file_when_startup_raises(tmp_data_dir):
    """If startup raises before the main loop, run_daemon must still release the claim file.

    Regression test: the claim-file cleanup lives in a `finally`, but its `try`
    used to start *after* _write_pid / _register_autostart / cleanup_on_startup.
    An exception in any of those escaped before the try, so the finally never
    ran and the worker slot stayed claimed — wedging every future worker start.
    """
    claim_path = worker._worker_claim_path()

    with patch.object(worker, "_write_pid", side_effect=RuntimeError("startup boom")):  # noqa: SIM117
        with pytest.raises(RuntimeError, match="startup boom"):
            daemon.run_daemon()

    assert not claim_path.exists(), "claim file leaked — run_daemon did not release the worker slot"


# ---------------------------------------------------------------------------
# run_daemon — a deferred drain must not accumulate idle back-off
# ---------------------------------------------------------------------------


def test_run_daemon_deferred_drain_does_not_accumulate_backoff(tmp_data_dir):
    """A deferred drain (drain_dirty_queue returns None) must not count as an idle cycle.

    Regression test: drain_dirty_queue returns None when the dirty queue could
    not be claimed (work still pending). run_daemon must reset the idle counter
    on None, not increment it — otherwise adaptive back-off slows re-indexing
    while a burst of edits keeps colliding with the queue file.
    """
    stop = threading.Event()
    poll_args: list[int] = []

    def _fake_adaptive(consecutive_empty: int) -> float:
        poll_args.append(consecutive_empty)
        if len(poll_args) >= 4:
            stop.set()
        return 0.001

    with (
        patch.object(worker, "HEARTBEAT_INTERVAL", 9999.0),
        patch.object(worker, "MAINTENANCE_INTERVAL", 9999.0),
        patch.object(worker, "PERIODIC_REINDEX_INTERVAL", 9999.0),
        patch.object(worker, "VERSION_CHECK_INTERVAL", 9999.0),
        patch.object(worker, "drain_dirty_queue", return_value=None),
        patch.object(worker, "adaptive_poll_interval", _fake_adaptive),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "cleanup_on_startup", return_value={}),
    ):
        daemon.run_daemon(stop_event=stop)

    assert poll_args, "loop never ran"
    assert all(n == 0 for n in poll_args), (
        f"deferred drains accumulated idle back-off instead of resetting it: {poll_args}"
    )


# ---------------------------------------------------------------------------
# Windows console-control handler
# ---------------------------------------------------------------------------


def _capture_ctrl_handler(fake_set_ctrl_handler):
    """Helper: call _install_windows_console_handler with the given fake and return captured cb."""
    captured = []

    def _spy(cb, add):
        captured.append(cb)
        return fake_set_ctrl_handler(cb, add)

    with patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", _spy):
        return captured


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_ctrl_close_sets_stop_event(tmp_data_dir):
    """CTRL_CLOSE_EVENT (2) sets stop_event and calls _clear_pid."""
    _CTRL_CLOSE_EVENT = 2
    stop = threading.Event()
    captured_callback = []

    def _fake_set_ctrl_handler(cb, add):
        captured_callback.append(cb)
        return 1

    # Keep the _clear_pid patch active while invoking the callback — the handler
    # closes over _worker._clear_pid at call time, so the patch must still be in effect.
    with (
        patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", _fake_set_ctrl_handler),
        patch.object(worker, "_clear_pid") as mock_clear,
    ):
        daemon._install_windows_console_handler(stop_event=stop)
        assert captured_callback, "SetConsoleCtrlHandler was never called"
        result = captured_callback[0](ctypes.c_ulong(_CTRL_CLOSE_EVENT))
        assert result is True, "handler must return True to signal the event was handled"
        assert stop.is_set(), "stop_event must be set on CTRL_CLOSE_EVENT"
        mock_clear.assert_called()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_ctrl_shutdown_sets_stop_event(tmp_data_dir):
    """CTRL_SHUTDOWN_EVENT (6) sets stop_event and calls _clear_pid."""
    _CTRL_SHUTDOWN_EVENT = 6
    stop = threading.Event()
    captured_callback = []

    def _fake_set_ctrl_handler(cb, add):
        captured_callback.append(cb)
        return 1

    with (
        patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", _fake_set_ctrl_handler),
        patch.object(worker, "_clear_pid") as mock_clear,
    ):
        daemon._install_windows_console_handler(stop_event=stop)
        assert captured_callback, "SetConsoleCtrlHandler was never called"
        result = captured_callback[0](ctypes.c_ulong(_CTRL_SHUTDOWN_EVENT))
        assert result is True, "handler must return True to signal the event was handled"
        assert stop.is_set(), "stop_event must be set on CTRL_SHUTDOWN_EVENT"
        mock_clear.assert_called()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_unhandled_event_returns_false(tmp_data_dir):
    """Unrecognised ctrl events (e.g. CTRL_C_EVENT=0) return False to pass to next handler."""
    _CTRL_C_EVENT = 0
    captured_callback = []

    def _fake_set_ctrl_handler(cb, add):
        captured_callback.append(cb)
        return 1

    with patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", _fake_set_ctrl_handler):
        daemon._install_windows_console_handler()
        assert captured_callback
        result = captured_callback[0](ctypes.c_ulong(_CTRL_C_EVENT))
        assert result is False, "unhandled events must return False"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_registration_failure_is_silent(tmp_data_dir):
    """If SetConsoleCtrlHandler raises (e.g. no console under pythonw.exe), no exception escapes."""
    with patch.object(
        ctypes.windll.kernel32,
        "SetConsoleCtrlHandler",
        side_effect=OSError("no console"),
    ):
        daemon._install_windows_console_handler()  # must not raise


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_returns_zero_is_silent(tmp_data_dir):
    """If SetConsoleCtrlHandler returns 0 (failed), the function completes without raising."""
    with patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", return_value=0):
        daemon._install_windows_console_handler()  # must not raise


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only: SetConsoleCtrlHandler")
def test_windows_console_handler_no_stop_event_still_calls_clear_pid(tmp_data_dir):
    """When stop_event=None, CTRL_CLOSE_EVENT still calls _clear_pid directly."""
    _CTRL_CLOSE_EVENT = 2
    captured_callback = []

    def _fake_set_ctrl_handler(cb, add):
        captured_callback.append(cb)
        return 1

    with (
        patch.object(ctypes.windll.kernel32, "SetConsoleCtrlHandler", _fake_set_ctrl_handler),
        patch.object(worker, "_clear_pid") as mock_clear,
    ):
        daemon._install_windows_console_handler(stop_event=None)
        assert captured_callback
        captured_callback[0](ctypes.c_ulong(_CTRL_CLOSE_EVENT))
        mock_clear.assert_called()


# ---------------------------------------------------------------------------
# atexit registration in run_daemon
# ---------------------------------------------------------------------------


def test_run_daemon_registers_atexit_clear_pid(tmp_data_dir):
    """run_daemon registers _clear_pid with atexit unconditionally (POSIX + Windows).

    Patches token_goat.worker_daemon.atexit (the module-level name used in run_daemon)
    rather than the stdlib atexit module directly, so the spy sees the call.
    The assertion checks that atexit.register was called with whatever object is
    currently bound to worker._clear_pid at run time (real function or mock).
    """
    stop = threading.Event()
    stop.set()

    registered_funcs: list = []

    def _spy_register(fn, *args, **kwargs):
        registered_funcs.append(fn)

    with (
        patch("token_goat.worker_daemon.atexit") as mock_atexit,
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_write_pid"),
        patch.object(worker, "_register_autostart"),
        patch.object(daemon, "_install_signal_handlers"),
        patch.object(daemon, "_install_windows_console_handler"),
        patch("os.close"),
        patch("time.sleep"),
    ):
        mock_atexit.register.side_effect = _spy_register
        # Capture whatever _clear_pid resolves to inside the patch context
        # (could be a mock from a prior patch layer or the real function).
        expected_clear_pid = worker._clear_pid
        daemon.run_daemon(stop_event=stop)

    assert expected_clear_pid in registered_funcs, (
        "run_daemon must register _clear_pid with atexit on all platforms"
    )
