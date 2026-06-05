"""Tests for worker_daemon — loop-level branches not covered by test_worker.py."""
from __future__ import annotations

import ctypes
import os
import signal
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


# ---------------------------------------------------------------------------
# SIGTERM handler — POSIX only
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only: SIGTERM not wired on Windows")
def test_install_signal_handlers_wires_sigterm_on_posix() -> None:
    """_install_signal_handlers registers _graceful_shutdown for SIGTERM on POSIX."""
    registered: dict[int, object] = {}

    def _fake_signal(sig: int, handler: object) -> object:
        registered[sig] = handler
        return signal.SIG_DFL

    with patch("token_goat.worker_daemon.signal") as mock_signal_mod:
        mock_signal_mod.SIGTERM = signal.SIGTERM
        mock_signal_mod.SIGINT = signal.SIGINT
        mock_signal_mod.signal.side_effect = _fake_signal
        mock_signal_mod.SIG_DFL = signal.SIG_DFL
        daemon._install_signal_handlers()

    assert signal.SIGTERM in registered, "_install_signal_handlers must wire SIGTERM on POSIX"
    assert registered[signal.SIGTERM] is daemon._graceful_shutdown, (
        "SIGTERM must be mapped to _graceful_shutdown, not a bare sys.exit lambda"
    )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only")
def test_graceful_shutdown_clears_pid_before_exit() -> None:
    """_graceful_shutdown calls _worker._clear_pid() then sys.exit(0)."""
    # Explicitly reset _daemon_stop_event to None so we exercise the else-branch
    # regardless of xdist worker state (a prior test may have set the event).
    with (
        patch.object(daemon, "_daemon_stop_event", None),
        patch.object(worker, "_clear_pid") as mock_clear,
        patch("sys.exit") as mock_exit,
    ):
        daemon._graceful_shutdown(signal.SIGTERM, None)

    mock_clear.assert_called_once()
    mock_exit.assert_called_once_with(0)


# ---------------------------------------------------------------------------
# WatchdogThread tests
# ---------------------------------------------------------------------------


def test_watchdog_restarts_on_unexpected_exit(tmp_data_dir):
    """WatchdogThread calls launch_fn when the watched PID disappears without a graceful stop."""
    # Use a two-phase reader: first return our live PID so the watchdog latches,
    # then return a dead PID to simulate unexpected worker exit.
    _DEAD_PID = 999997
    current_pid = [os.getpid()]  # start: alive
    launched = threading.Event()

    original_pid_alive = daemon._pid_is_alive

    def _patched_pid_alive(pid: int) -> bool:
        if pid == _DEAD_PID:
            return False
        return original_pid_alive(pid)

    def _fake_pid_reader() -> int:
        return current_pid[0]

    def _fake_launch() -> int | None:
        launched.set()
        return os.getpid()  # return a new valid PID

    latched = threading.Event()

    with patch.object(daemon, "_pid_is_alive", _patched_pid_alive):
        wd = daemon.WatchdogThread(
            pid_file_reader=_fake_pid_reader,
            launch_fn=_fake_launch,
            retry_delay=0.05,
            poll_interval=0.02,
            on_latch=latched.set,
        )
        wd.start()

        # Wait for the watchdog to latch onto our live PID (replaces sleep(0.1)).
        assert latched.wait(timeout=2.0), "watchdog did not latch onto live PID"

        # Switch to the dead PID to simulate unexpected worker exit.
        current_pid[0] = _DEAD_PID

        # Watchdog should detect the vanished PID and call launch_fn.
        assert launched.wait(timeout=2.0), "watchdog did not restart the worker after unexpected exit"

        wd.stop()
        wd.join(timeout=1.0)


def test_watchdog_stops_after_max_retries(tmp_data_dir):
    """WatchdogThread stops calling launch_fn once max_retries is exhausted in the window."""
    launch_count = [0]
    # Use a PID that is definitely dead (very large number unlikely to be a running process).
    _DEAD_PID = 999999

    # Patch _pid_is_alive so that _DEAD_PID always appears dead.
    original_pid_alive = daemon._pid_is_alive

    def _patched_pid_alive(pid: int) -> bool:
        if pid == _DEAD_PID:
            return False
        return original_pid_alive(pid)

    def _fake_pid_reader() -> int:
        return _DEAD_PID  # always return the dead PID so the watchdog latches and retries

    def _fake_launch() -> int | None:
        launch_count[0] += 1
        return None  # keep returning None — watchdog keeps the dead PID and retries

    with patch.object(daemon, "_pid_is_alive", _patched_pid_alive):
        wd = daemon.WatchdogThread(
            pid_file_reader=_fake_pid_reader,
            launch_fn=_fake_launch,
            max_retries=3,
            window_secs=60.0,
            retry_delay=0.01,
            poll_interval=0.02,
        )
        wd.start()

        # Watchdog should stop on its own after max_retries.
        wd.join(timeout=5.0)

    # The watchdog should have stopped on its own (thread finished).
    assert not wd.is_alive(), "watchdog thread should have stopped after exhausting max_retries"
    assert launch_count[0] >= 3, f"expected at least 3 launch attempts, got {launch_count[0]}"


def test_watchdog_graceful_stop_prevents_restart(tmp_data_dir):
    """Calling watchdog.stop() before PID disappears prevents spurious restart."""
    _DEAD_PID = 999996
    current_pid = [os.getpid()]  # start: alive
    launched = threading.Event()

    original_pid_alive = daemon._pid_is_alive

    def _patched_pid_alive(pid: int) -> bool:
        if pid == _DEAD_PID:
            return False
        return original_pid_alive(pid)

    def _fake_pid_reader() -> int:
        return current_pid[0]

    def _fake_launch() -> int | None:
        launched.set()
        return os.getpid()

    latched = threading.Event()

    with patch.object(daemon, "_pid_is_alive", _patched_pid_alive):
        wd = daemon.WatchdogThread(
            pid_file_reader=_fake_pid_reader,
            launch_fn=_fake_launch,
            retry_delay=0.05,
            poll_interval=0.02,
            on_latch=latched.set,
        )
        wd.start()

        # Wait for the watchdog to latch onto our live PID (replaces sleep(0.1)).
        assert latched.wait(timeout=2.0), "watchdog did not latch onto live PID"

        # Signal graceful stop BEFORE making the PID disappear.
        wd.stop()

        # Now simulate PID gone — watchdog must ignore it since stop() was called.
        current_pid[0] = _DEAD_PID

        wd.join(timeout=1.0)

    assert not launched.is_set(), "watchdog must not restart after graceful stop() was called"


def test_watchdog_disabled_by_config(tmp_data_dir):
    """run_daemon does not start a watchdog when worker.watchdog_enabled=False."""
    import token_goat.config as _config_mod

    stop = threading.Event()
    stop.set()

    mock_wd_instances = []

    class _TrackedWatchdog(daemon.WatchdogThread):
        def __init__(self, **kwargs):
            mock_wd_instances.append(self)
            super().__init__(**kwargs)

        def start(self):
            pass  # prevent actual thread start

        def stop(self):
            pass

    from token_goat.config import Config, WorkerConfig
    fake_cfg = Config()
    fake_cfg.worker = WorkerConfig(watchdog_enabled=False)

    with (
        patch("token_goat.worker_daemon.WatchdogThread", _TrackedWatchdog),
        patch.object(_config_mod, "load", return_value=fake_cfg),
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_clear_pid"),
        patch.object(worker, "_write_pid"),
        patch.object(worker, "_register_autostart"),
        patch.object(daemon, "_install_signal_handlers"),
        patch("os.close"),
    ):
        daemon.run_daemon(stop_event=stop)

    assert len(mock_wd_instances) == 0, "WatchdogThread must not be instantiated when watchdog_enabled=False"


def test_watchdog_stop_called_on_graceful_daemon_shutdown(tmp_data_dir):
    """run_daemon calls watchdog.stop() in its finally block on graceful shutdown."""
    import token_goat.config as _config_mod

    stop = threading.Event()
    stop.set()

    stop_called = threading.Event()

    class _FakeWatchdog:
        def __init__(self, **kwargs):
            pass

        def start(self):
            pass

        def stop(self):
            stop_called.set()

    from token_goat.config import Config, WorkerConfig
    fake_cfg = Config()
    fake_cfg.worker = WorkerConfig(watchdog_enabled=True)

    with (
        patch("token_goat.worker_daemon.WatchdogThread", _FakeWatchdog),
        patch.object(_config_mod, "load", return_value=fake_cfg),
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_clear_pid"),
        patch.object(worker, "_write_pid"),
        patch.object(worker, "_register_autostart"),
        patch.object(daemon, "_install_signal_handlers"),
        patch("os.close"),
    ):
        daemon.run_daemon(stop_event=stop)

    assert stop_called.is_set(), "run_daemon must call watchdog.stop() in finally block"


def test_watchdog_pid_unknown_does_not_trigger_restart(tmp_data_dir):
    """WatchdogThread does not call launch_fn when PID file reader always returns _PID_UNKNOWN."""
    launched = threading.Event()
    polled = threading.Event()
    poll_count = [0]

    def _fake_pid_reader() -> int:
        poll_count[0] += 1
        if poll_count[0] >= 5:
            polled.set()
        return daemon._PID_UNKNOWN

    def _fake_launch() -> int | None:
        launched.set()
        return None

    wd = daemon.WatchdogThread(
        pid_file_reader=_fake_pid_reader,
        launch_fn=_fake_launch,
        retry_delay=0.01,
        poll_interval=0.02,
    )
    wd.start()

    # Wait for at least 5 poll cycles to confirm no restart was triggered.
    polled.wait(timeout=2.0)
    wd.stop()
    wd.join(timeout=1.0)

    assert not launched.is_set(), "watchdog must not restart when no PID has been latched"


def test_watchdog_launch_fn_exception_does_not_crash_watchdog(tmp_data_dir):
    """A crashing launch_fn is caught; the watchdog continues operating."""
    call_count = [0]
    _DEAD_PID = 999998

    original_pid_alive = daemon._pid_is_alive

    def _patched_pid_alive(pid: int) -> bool:
        if pid == _DEAD_PID:
            return False
        return original_pid_alive(pid)

    def _fake_pid_reader() -> int:
        return _DEAD_PID  # always return the dead PID

    def _bad_launch() -> int | None:
        call_count[0] += 1
        raise RuntimeError("launch exploded")

    with patch.object(daemon, "_pid_is_alive", _patched_pid_alive):
        wd = daemon.WatchdogThread(
            pid_file_reader=_fake_pid_reader,
            launch_fn=_bad_launch,
            max_retries=2,
            retry_delay=0.01,
            poll_interval=0.02,
        )
        wd.start()

        # Watchdog should call launch_fn, catch the exception, and eventually give up.
        wd.join(timeout=3.0)

    assert not wd.is_alive(), "watchdog should stop after max_retries even when launch_fn raises"
    assert call_count[0] >= 1, "launch_fn should have been called at least once"


# ---------------------------------------------------------------------------
# JSON PID file format and cross-interpreter startup guard
# ---------------------------------------------------------------------------


def test_read_pid_info_legacy_plain_int():
    """_read_pid_info parses the legacy plain-integer PID file format."""
    pid, interpreter = worker._read_pid_info("12345")
    assert pid == 12345
    assert interpreter is None


def test_read_pid_info_legacy_plain_int_with_newline():
    """_read_pid_info handles a trailing newline in the legacy format."""
    pid, interpreter = worker._read_pid_info("98765\n")
    assert pid == 98765
    assert interpreter is None


def test_read_pid_info_json_format():
    """_read_pid_info parses the new JSON PID file format and returns interpreter path."""
    import json
    payload = json.dumps({
        "pid": 42,
        "started_at": "2026-06-03T12:00:00",
        "interpreter": "/usr/bin/python3",
        "version": "1.0.1",
    })
    pid, interpreter = worker._read_pid_info(payload)
    assert pid == 42
    assert interpreter == "/usr/bin/python3"


def test_read_pid_info_json_missing_interpreter():
    """_read_pid_info returns None for interpreter when the key is absent from JSON."""
    import json
    payload = json.dumps({"pid": 7, "started_at": "2026-06-03T12:00:00"})
    pid, interpreter = worker._read_pid_info(payload)
    assert pid == 7
    assert interpreter is None


def test_read_pid_info_malformed_raises_value_error():
    """_read_pid_info raises ValueError on completely malformed input."""
    import pytest
    with pytest.raises(ValueError):
        worker._read_pid_info("not-a-number")


def test_write_pid_writes_json_format(tmp_data_dir):
    """_write_pid() writes a JSON object containing pid and interpreter."""
    import json
    worker._write_pid()
    pid_path = worker.paths.worker_pid_path()
    assert pid_path.exists(), "PID file must exist after _write_pid()"
    raw = pid_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    assert data["pid"] == os.getpid()
    assert "interpreter" in data
    assert data["interpreter"] == sys.executable
    assert "started_at" in data
    assert "version" in data


def test_write_pid_readable_by_read_pid_info(tmp_data_dir):
    """_read_pid_info can round-trip a PID file written by _write_pid()."""
    worker._write_pid()
    raw = worker.paths.worker_pid_path().read_text(encoding="utf-8")
    pid, interpreter = worker._read_pid_info(raw)
    assert pid == os.getpid()
    assert interpreter == sys.executable


def test_run_daemon_exits_when_live_pid_holds_slot(tmp_data_dir):
    """run_daemon exits immediately (returns without starting the loop) when another live
    worker holds the claim slot.

    This is the cross-interpreter duplicate guard: even if the competing process
    was started from a different Python executable, it already holds the O_EXCL
    claim file and the current process must not start a second main loop.
    """
    # Simulate another worker winning the claim slot by patching
    # _try_claim_worker_slot to return None (the "already claimed" path).
    loop_entered = threading.Event()

    original_drain = worker.drain_dirty_queue

    def _spy_drain():
        loop_entered.set()
        return original_drain()

    with (
        patch.object(worker, "_try_claim_worker_slot", return_value=None),
        patch.object(worker, "drain_dirty_queue", _spy_drain),
    ):
        daemon.run_daemon()

    assert not loop_entered.is_set(), (
        "run_daemon must not enter the main loop when the claim slot is already held"
    )


def test_run_daemon_logs_interpreter_when_slot_held(tmp_data_dir, caplog):
    """run_daemon logs the competing interpreter path (WARNING level) when the slot is held
    and the PID file contains JSON with an interpreter field.

    This verifies the cross-interpreter duplicate-daemon diagnostic.
    """
    import json
    import logging

    # Write a JSON PID file with a fake interpreter path.
    fake_pid = os.getpid()  # use a known-live PID so psutil.pid_exists is happy
    fake_exe = "/fake/python/bin/pythonw.exe"
    pid_payload = json.dumps({
        "pid": fake_pid,
        "started_at": "2026-06-03T00:00:00",
        "interpreter": fake_exe,
        "version": "1.0.0",
    })
    # Ensure the locks dir exists and write the fake PID file.
    pid_path = worker.paths.worker_pid_path()
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(pid_payload, encoding="utf-8")

    with (
        patch.object(worker, "_try_claim_worker_slot", return_value=None),
        caplog.at_level(logging.WARNING, logger="token_goat.worker"),
    ):
        daemon.run_daemon()

    # The WARNING must mention the competing interpreter.
    warning_lines = [r.message for r in caplog.records if r.levelno >= logging.WARNING]
    assert any(fake_exe in msg for msg in warning_lines), (
        f"Expected a WARNING mentioning {fake_exe!r}; got: {warning_lines}"
    )


def test_run_daemon_exits_cleanly_on_pid_race_window(tmp_data_dir):
    """run_daemon exits if the PID file contains a different PID after _write_pid() —
    detecting a theoretically-impossible but defensively-guarded startup race.

    The O_EXCL claim file prevents two workers from reaching _write_pid() simultaneously,
    but the post-write verification is a belt-and-suspenders guard that makes the
    invariant testable.
    """
    loop_entered = threading.Event()

    # Patch _write_pid to write a DIFFERENT PID than os.getpid()
    def _fake_write_pid():
        # Write PID 1 (init/systemd — always present, never us).
        import json as _json  # noqa: PLC0415
        payload = _json.dumps({
            "pid": 1,
            "started_at": "2026-06-03T00:00:00",
            "interpreter": "/other/python",
            "version": "1.0.0",
        })
        worker.paths.atomic_write_text(worker.paths.worker_pid_path(), payload)

    original_drain = worker.drain_dirty_queue

    def _spy_drain():
        loop_entered.set()
        return original_drain()

    with (
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_write_pid", _fake_write_pid),
        patch.object(worker, "_clear_pid"),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_register_autostart"),
        patch.object(daemon, "_install_signal_handlers"),
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "drain_dirty_queue", _spy_drain),
        patch("os.close"),
    ):
        daemon.run_daemon()

    assert not loop_entered.is_set(), (
        "run_daemon must exit before the main loop when the PID file does not match our PID"
    )


def test_run_daemon_proceeds_when_pid_matches(tmp_data_dir):
    """run_daemon enters the main loop normally when the PID file contains our own PID."""
    stop = threading.Event()
    stop.set()

    with (
        patch.object(worker, "_try_claim_worker_slot", return_value=3),
        patch.object(worker, "_clear_pid"),
        patch.object(worker, "_write_pid", lambda: worker.paths.atomic_write_text(
            worker.paths.worker_pid_path(),
            __import__("json").dumps({
                "pid": os.getpid(),
                "started_at": "2026-06-03T00:00:00",
                "interpreter": sys.executable,
                "version": "1.0.0",
            })
        )),
        patch.object(worker, "_heartbeat"),
        patch.object(worker, "_register_autostart"),
        patch.object(daemon, "_install_signal_handlers"),
        patch.object(worker, "cleanup_on_startup", return_value={}),
        patch.object(worker, "drain_dirty_queue", return_value=[]),
        patch("os.close"),
    ):
        daemon.run_daemon(stop_event=stop)
    # Test passes if run_daemon completes without error (the stop event exits it)


# ---------------------------------------------------------------------------
# kill_duplicate_daemon tests
# ---------------------------------------------------------------------------


def _write_json_pid(pid_path, pid: int, interpreter: str, started_at: str = "2026-06-03T00:00:00+00:00") -> None:
    """Helper: write a JSON-format PID file."""
    import json
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(
        json.dumps({"pid": pid, "started_at": started_at, "interpreter": interpreter, "version": "1.0.0"}),
        encoding="utf-8",
    )


def test_kill_duplicate_no_pid_file(tmp_data_dir):
    """kill_duplicate_daemon returns 'No running worker found.' when no pid file exists."""
    result = daemon.kill_duplicate_daemon()
    assert result == "No running worker found."


def test_kill_duplicate_pid_not_alive(tmp_data_dir):
    """kill_duplicate_daemon returns 'No running worker found.' when pid file exists but process is dead."""
    pid_path = worker.paths.worker_pid_path()
    _write_json_pid(pid_path, pid=999997, interpreter="/other/python")

    with patch.object(daemon, "_pid_is_alive", return_value=False):
        result = daemon.kill_duplicate_daemon()

    assert result == "No running worker found."


def test_kill_duplicate_same_interpreter_no_kill(tmp_data_dir):
    """kill_duplicate_daemon returns 'No duplicate daemon found.' when interpreter matches."""
    pid_path = worker.paths.worker_pid_path()
    _write_json_pid(pid_path, pid=os.getpid(), interpreter=sys.executable)

    with patch.object(daemon, "_pid_is_alive", return_value=True):
        result = daemon.kill_duplicate_daemon()

    assert result == "No duplicate daemon found."


def test_kill_duplicate_legacy_pid_format(tmp_data_dir):
    """kill_duplicate_daemon handles a legacy plain-integer PID file gracefully."""
    pid_path = worker.paths.worker_pid_path()
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text("12345", encoding="utf-8")

    with patch.object(daemon, "_pid_is_alive", return_value=True):
        result = daemon.kill_duplicate_daemon()

    assert result == "Worker interpreter unknown (legacy pid file format)."


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-specific kill path")
def test_kill_duplicate_different_interpreter_windows(tmp_data_dir):
    """kill_duplicate_daemon calls TerminateProcess on Windows when interpreter differs."""
    fake_pid = 54321
    other_interp = r"C:\Python311\pythonw.exe"
    pid_path = worker.paths.worker_pid_path()
    _write_json_pid(pid_path, pid=fake_pid, interpreter=other_interp)

    import ctypes as _ctypes
    fake_handle = 9999
    open_calls = []
    terminate_calls = []
    close_calls = []

    with (
        patch.object(daemon, "_pid_is_alive", return_value=True),
        patch.object(_ctypes.windll.kernel32, "OpenProcess", side_effect=lambda *a, **k: (open_calls.append(a), fake_handle)[1]),
        patch.object(_ctypes.windll.kernel32, "TerminateProcess", side_effect=lambda *a, **k: terminate_calls.append(a) or True),
        patch.object(_ctypes.windll.kernel32, "CloseHandle", side_effect=lambda *a, **k: close_calls.append(a)),
    ):
        result = daemon.kill_duplicate_daemon()

    assert "Killed duplicate daemon" in result
    assert str(fake_pid) in result
    assert other_interp in result
    assert len(terminate_calls) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-specific kill path")
def test_kill_duplicate_different_interpreter_posix(tmp_data_dir):
    """kill_duplicate_daemon sends SIGTERM on POSIX when interpreter differs."""
    fake_pid = 54321
    other_interp = "/other/python3"
    pid_path = worker.paths.worker_pid_path()
    _write_json_pid(pid_path, pid=fake_pid, interpreter=other_interp)

    kill_calls = []

    with (
        patch.object(daemon, "_pid_is_alive", return_value=True),
        patch("os.kill", side_effect=lambda pid, sig: kill_calls.append((pid, sig))),
    ):
        result = daemon.kill_duplicate_daemon()

    assert "Killed duplicate daemon" in result
    assert str(fake_pid) in result
    assert other_interp in result
    import signal as _sig
    assert kill_calls == [(fake_pid, _sig.SIGTERM)]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-specific kill path")
def test_kill_duplicate_os_error_returns_message(tmp_data_dir):
    """kill_duplicate_daemon returns an error message (not raise) when os.kill fails."""
    fake_pid = 54321
    other_interp = "/other/python3"
    pid_path = worker.paths.worker_pid_path()
    _write_json_pid(pid_path, pid=fake_pid, interpreter=other_interp)

    with (
        patch.object(daemon, "_pid_is_alive", return_value=True),
        patch("os.kill", side_effect=OSError("permission denied")),
    ):
        result = daemon.kill_duplicate_daemon()

    assert "Failed to kill" in result
    assert str(fake_pid) in result


# ---------------------------------------------------------------------------
# query_worker_status enhanced fields tests
# ---------------------------------------------------------------------------


def test_query_worker_status_includes_interpreter_and_started_at(tmp_data_dir):
    """query_worker_status returns interpreter and started_at from the JSON pid file."""
    import json
    fake_pid = os.getpid()  # use our PID so psutil.pid_exists returns True
    fake_interp = "/fake/pythonw.exe"
    fake_ts = "2026-06-03T10:00:00+00:00"
    pid_path = worker.paths.worker_pid_path()
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(
        json.dumps({"pid": fake_pid, "started_at": fake_ts, "interpreter": fake_interp, "version": "1.0.0"}),
        encoding="utf-8",
    )

    with patch.object(daemon, "_pid_is_alive", return_value=True):
        info = daemon.query_worker_status()

    assert info["pid"] == fake_pid
    assert info["interpreter"] == fake_interp
    assert info["started_at"] == fake_ts
    assert info["running"] is True


def test_query_worker_status_pool_size_from_config(tmp_data_dir):
    """query_worker_status returns pool_size from config.worker.max_pool_workers."""
    import token_goat.config as _cfg_mod
    from token_goat.config import Config, WorkerConfig
    fake_cfg = Config()
    fake_cfg.worker = WorkerConfig(max_pool_workers=6)

    with patch.object(_cfg_mod, "load", return_value=fake_cfg):
        info = daemon.query_worker_status()

    assert info["pool_size"] == 6


def test_query_worker_status_pool_size_default_on_config_error(tmp_data_dir):
    """query_worker_status returns pool_size=4 (default) when config load fails."""
    with patch("token_goat.worker_daemon._pid_is_alive", return_value=False):
        import token_goat.config as _cfg_mod
        with patch.object(_cfg_mod, "load", side_effect=RuntimeError("config broken")):
            info = daemon.query_worker_status()

    assert info["pool_size"] == 4


def test_query_worker_status_no_pid_file(tmp_data_dir):
    """query_worker_status returns running=False, pid=None when no pid file exists."""
    info = daemon.query_worker_status()
    assert info["running"] is False
    assert info["pid"] is None
    assert info["interpreter"] is None
    assert info["started_at"] is None
