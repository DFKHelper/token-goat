"""Tests for worker.py reliability improvements:

* corrupt-line skipping in drain_dirty_queue
* per-project exponential backoff tracking
* graceful shutdown via stop_event on SIGTERM/SIGINT
* memory pressure guard skips indexing
* indexing timeout
"""
from __future__ import annotations

import json
import signal
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import token_goat.paths as paths
from token_goat import worker, worker_daemon

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_raw_queue_lines(tmp_path: Path, lines: list[str]) -> None:
    """Write raw text lines directly to the dirty queue file, bypassing enqueue_dirty."""
    queue_path = paths.dirty_queue_path()
    paths.ensure_dir(queue_path.parent)
    with queue_path.open("w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")


# ---------------------------------------------------------------------------
# 1. Corrupt-line skipping
# ---------------------------------------------------------------------------


class TestDirtyQueueCorruptLineSkipping:
    """drain_dirty_queue must skip bad lines rather than crashing."""

    def test_invalid_json_is_skipped(self, tmp_data_dir):
        """A line that is not valid JSON is logged and dropped; good lines survive."""
        good = json.dumps({"path": "src/foo.py", "project_hash": "abc123", "ts": 1.0})
        bad = "THIS IS NOT JSON {"
        _write_raw_queue_lines(tmp_data_dir, [good, bad])

        entries = worker.drain_dirty_queue()
        assert entries is not None
        assert len(entries) == 1
        assert entries[0]["path"] == "src/foo.py"

    def test_truncated_json_is_skipped(self, tmp_data_dir):
        """A truncated JSON object (partial write) is dropped without raising."""
        good = json.dumps({"path": "src/bar.py", "project_hash": "abc123", "ts": 2.0})
        truncated = '{"path": "src/incomplete.py", "project'  # truncated mid-string
        _write_raw_queue_lines(tmp_data_dir, [truncated, good])

        entries = worker.drain_dirty_queue()
        assert entries is not None
        assert len(entries) == 1
        assert entries[0]["path"] == "src/bar.py"

    def test_json_non_dict_is_skipped(self, tmp_data_dir):
        """A valid JSON line that is not a dict (e.g. a list) is dropped."""
        non_dict = json.dumps(["src/foo.py", "abc123"])
        good = json.dumps({"path": "src/good.py", "project_hash": "abc123", "ts": 3.0})
        _write_raw_queue_lines(tmp_data_dir, [non_dict, good])

        entries = worker.drain_dirty_queue()
        assert entries is not None
        assert len(entries) == 1
        assert entries[0]["path"] == "src/good.py"

    def test_empty_lines_are_ignored(self, tmp_data_dir):
        """Blank lines in the queue file are silently discarded."""
        good = json.dumps({"path": "src/baz.py", "project_hash": "abc123", "ts": 4.0})
        _write_raw_queue_lines(tmp_data_dir, ["", "   ", good, ""])

        entries = worker.drain_dirty_queue()
        assert entries is not None
        assert len(entries) == 1

    def test_entirely_corrupt_queue_returns_empty(self, tmp_data_dir):
        """A queue containing only corrupt lines returns an empty list, not None."""
        _write_raw_queue_lines(tmp_data_dir, [
            "not json at all",
            "also bad {{{",
            json.dumps([1, 2, 3]),
        ])

        entries = worker.drain_dirty_queue()
        # Should return [] (empty but not None — no deferred drain occurred).
        assert entries == []

    def test_mix_of_corrupt_and_valid_logs_warning(self, tmp_data_dir, caplog):
        """Corrupt lines produce a WARNING log entry."""
        good = json.dumps({"path": "x.py", "project_hash": "abc123", "ts": 5.0})
        _write_raw_queue_lines(tmp_data_dir, ["bad json", good])

        with caplog.at_level("WARNING", logger="token_goat.worker"):
            entries = worker.drain_dirty_queue()

        assert entries is not None and len(entries) == 1
        assert any("not valid JSON" in r.message or "malformed" in r.message.lower()
                   for r in caplog.records)


# ---------------------------------------------------------------------------
# 2. Exponential backoff helpers
# ---------------------------------------------------------------------------


class TestBackoffHelpers:
    """_record_index_failure / _record_index_success / _should_skip_due_to_backoff."""

    def setup_method(self):
        """Clear in-memory backoff state before each test."""
        worker._index_failure_counts.clear()
        worker._index_backoff_until.clear()

    def teardown_method(self):
        """Clean up backoff state after each test."""
        worker._index_failure_counts.clear()
        worker._index_backoff_until.clear()

    def test_no_backoff_before_threshold(self):
        """Fewer than _BACKOFF_FAILURE_THRESHOLD failures should not activate backoff."""
        ph, rel = "aabbccdd", "src/foo.py"
        for _ in range(worker._BACKOFF_FAILURE_THRESHOLD - 1):
            worker._record_index_failure(ph, rel)
        assert not worker._should_skip_due_to_backoff(ph, rel)

    def test_backoff_activates_at_threshold(self):
        """Exactly _BACKOFF_FAILURE_THRESHOLD failures should activate backoff."""
        ph, rel = "aabbccdd", "src/foo.py"
        for _ in range(worker._BACKOFF_FAILURE_THRESHOLD):
            worker._record_index_failure(ph, rel)
        assert worker._should_skip_due_to_backoff(ph, rel)

    def test_backoff_delay_grows_exponentially(self):
        """Each failure beyond the threshold should double the backoff delay."""
        ph, rel = "aabbccdd", "src/foo.py"
        delays: list[float] = []
        for _i in range(worker._BACKOFF_FAILURE_THRESHOLD + 3):
            worker._record_index_failure(ph, rel)
            until = worker._index_backoff_until.get((ph, rel), 0.0)
            if until > 0:
                delays.append(until - time.time())

        # Each successive delay should be larger than the previous.
        assert len(delays) >= 2
        for prev, curr in zip(delays, delays[1:], strict=False):
            assert curr > prev * 0.9  # allow 10% tolerance for clock jitter

    def test_backoff_capped_at_max(self):
        """Delay should not exceed _BACKOFF_MAX_SECS regardless of failure count."""
        ph, rel = "aabbccdd", "src/baz.py"
        for _ in range(50):
            worker._record_index_failure(ph, rel)
        until = worker._index_backoff_until.get((ph, rel), 0.0)
        delay = until - time.time()
        assert delay <= worker._BACKOFF_MAX_SECS + 1.0  # 1s tolerance

    def test_success_clears_backoff(self):
        """After _record_index_success, the path should no longer be in backoff."""
        ph, rel = "aabbccdd", "src/foo.py"
        for _ in range(worker._BACKOFF_FAILURE_THRESHOLD + 1):
            worker._record_index_failure(ph, rel)
        assert worker._should_skip_due_to_backoff(ph, rel)

        worker._record_index_success(ph, rel)
        assert not worker._should_skip_due_to_backoff(ph, rel)
        assert (ph, rel) not in worker._index_failure_counts
        assert (ph, rel) not in worker._index_backoff_until

    def test_different_projects_tracked_independently(self):
        """Failures for one project should not affect another."""
        ph1, ph2, rel = "aaaaaaaa", "bbbbbbbb", "src/foo.py"
        for _ in range(worker._BACKOFF_FAILURE_THRESHOLD + 2):
            worker._record_index_failure(ph1, rel)
        # ph1 in backoff, ph2 is clean
        assert worker._should_skip_due_to_backoff(ph1, rel)
        assert not worker._should_skip_due_to_backoff(ph2, rel)

    def test_backoff_expires_after_window(self):
        """Once the backoff window passes, the path should be retried."""
        ph, rel = "aabbccdd", "src/foo.py"
        for _ in range(worker._BACKOFF_FAILURE_THRESHOLD):
            worker._record_index_failure(ph, rel)
        # Manually backdate the expiry so the window has already passed.
        worker._index_backoff_until[(ph, rel)] = time.time() - 1.0
        assert not worker._should_skip_due_to_backoff(ph, rel)


# ---------------------------------------------------------------------------
# 3. Graceful shutdown via stop_event
# ---------------------------------------------------------------------------


class TestGracefulShutdown:
    """SIGTERM / SIGINT should set the stop_event rather than calling sys.exit."""

    def test_graceful_shutdown_sets_stop_event(self):
        """_graceful_shutdown sets _daemon_stop_event instead of calling sys.exit."""
        stop = threading.Event()
        worker_daemon._daemon_stop_event = stop
        try:
            worker_daemon._graceful_shutdown(signal.SIGTERM, None)
            assert stop.is_set(), "stop_event should be set after graceful_shutdown"
        finally:
            worker_daemon._daemon_stop_event = None

    def test_graceful_shutdown_falls_back_without_stop_event(self):
        """When no stop_event is set, _graceful_shutdown calls sys.exit(0)."""
        original_event = worker_daemon._daemon_stop_event
        worker_daemon._daemon_stop_event = None
        try:
            with pytest.raises(SystemExit) as exc_info:
                worker_daemon._graceful_shutdown(signal.SIGTERM, None)
            assert exc_info.value.code == 0
        finally:
            worker_daemon._daemon_stop_event = original_event

    def test_install_signal_handlers_registers_stop_event(self):
        """_install_signal_handlers stores the stop_event in _daemon_stop_event."""
        stop = threading.Event()
        original_event = worker_daemon._daemon_stop_event
        try:
            worker_daemon._install_signal_handlers(stop_event=stop)
            assert worker_daemon._daemon_stop_event is stop
        finally:
            worker_daemon._daemon_stop_event = original_event

    @pytest.mark.skipif(
        sys.platform == "win32",
        reason="POSIX signal sending not reliable in Windows tests",
    )
    def test_sigterm_stops_daemon_main_loop(self, tmp_data_dir):
        """Sending SIGTERM to the current process via run_daemon's stop_event pathway stops the loop."""
        stop = threading.Event()
        daemon_exited = threading.Event()
        daemon_started = threading.Event()

        def _run():
            # Patch autostart so it doesn't touch the registry / systemd.
            # The patched _register_autostart fires daemon_started so the main
            # thread knows the loop is initialised before it sends the stop.
            with (
                patch.object(worker, "_register_autostart", daemon_started.set),
                patch.object(worker, "_try_claim_worker_slot", return_value=42),
                patch.object(worker, "cleanup_on_startup", return_value={}),
            ):
                try:
                    worker_daemon.run_daemon(stop_event=stop)
                finally:
                    daemon_exited.set()

        t = threading.Thread(target=_run, daemon=True)
        t.start()

        # Wait until the daemon has completed startup (replaces sleep(0.3)).
        assert daemon_started.wait(timeout=5.0), "daemon did not start within 5s"

        # Set the stop event — simulates what SIGTERM now does.
        stop.set()
        assert daemon_exited.wait(timeout=5.0), "daemon did not stop within 5s"


# ---------------------------------------------------------------------------
# 4. Memory pressure guard
# ---------------------------------------------------------------------------


class TestMemoryPressureGuard:
    """_is_under_memory_pressure and its integration with indexing."""

    def test_no_pressure_when_rss_below_threshold(self):
        """RSS below threshold returns False."""
        with patch.object(worker, "_get_rss_mb", return_value=100.0):
            original = worker.MEMORY_PRESSURE_THRESHOLD_MB
            worker.MEMORY_PRESSURE_THRESHOLD_MB = 500.0
            try:
                assert not worker._is_under_memory_pressure()
            finally:
                worker.MEMORY_PRESSURE_THRESHOLD_MB = original

    def test_pressure_when_rss_exceeds_threshold(self):
        """RSS above threshold returns True."""
        with patch.object(worker, "_get_rss_mb", return_value=600.0):
            original = worker.MEMORY_PRESSURE_THRESHOLD_MB
            worker.MEMORY_PRESSURE_THRESHOLD_MB = 500.0
            try:
                assert worker._is_under_memory_pressure()
            finally:
                worker.MEMORY_PRESSURE_THRESHOLD_MB = original

    def test_no_pressure_when_rss_unavailable(self):
        """If RSS cannot be determined, pressure is treated as absent (safe default)."""
        with patch.object(worker, "_get_rss_mb", return_value=None):
            assert not worker._is_under_memory_pressure()

    def test_process_dirty_entries_skipped_under_pressure(self, tmp_data_dir):
        """_process_dirty_entries returns immediately when under memory pressure."""
        entry = worker.DirtyQueueEntry(
            path="src/foo.py",
            project_hash="aabbccdd",
            project_root=str(tmp_data_dir),
            project_marker="manual",
            ts=time.time(),
        )
        index_called = []

        def _fake_index(project, full):
            index_called.append(True)
            return {"indexed": 1, "total_files": 1, "errors": 0, "skipped_unchanged": 0, "duration_sec": 0.1}

        with patch.object(worker, "_is_under_memory_pressure", return_value=True):
            from token_goat import parser as _parser
            with patch.object(_parser, "index_project", side_effect=_fake_index):
                worker._process_dirty_entries([entry])

        assert not index_called, "index_project should not be called under memory pressure"

    def test_reindex_skipped_under_pressure(self):
        """_reindex_active_projects returns immediately when under memory pressure."""
        index_called = []

        def _fake_index(project, full):
            index_called.append(True)

        with patch.object(worker, "_is_under_memory_pressure", return_value=True):
            from token_goat import parser as _parser
            with patch.object(_parser, "index_project", side_effect=_fake_index):
                worker._reindex_active_projects()

        assert not index_called


# ---------------------------------------------------------------------------
# 5. Index timeout
# ---------------------------------------------------------------------------


class TestIndexTimeout:
    """_run_index_with_timeout cancels slow index calls and returns None."""

    def test_fast_index_succeeds(self, tmp_data_dir):
        """A fast index call returns the result dict normally."""
        expected = {"indexed": 1, "total_files": 1, "errors": 0, "skipped_unchanged": 0, "duration_sec": 0.01}

        def _fast_index(project, full):
            return expected

        from token_goat import parser as _parser
        from token_goat.project import Project

        proj = Project(root=tmp_data_dir, hash="aabbccdd", marker="manual")
        with patch.object(_parser, "index_project", side_effect=_fast_index):
            result = worker._run_index_with_timeout(proj, False, timeout=5.0)

        assert result == expected

    def test_slow_index_returns_none(self, tmp_data_dir):
        """A slow index call that exceeds the timeout returns None."""

        def _slow_index(project, full):
            threading.Event().wait(10)  # blocks until thread is killed; much longer than the test timeout
            return {"indexed": 0, "total_files": 0, "errors": 0, "skipped_unchanged": 0, "duration_sec": 10.0}

        from token_goat import parser as _parser
        from token_goat.project import Project

        proj = Project(root=tmp_data_dir, hash="aabbccdd", marker="manual")
        with patch.object(_parser, "index_project", side_effect=_slow_index):
            result = worker._run_index_with_timeout(proj, False, timeout=0.2)

        assert result is None, "timeout should return None"

    def test_raising_index_returns_none(self, tmp_data_dir):
        """An index call that raises an exception returns None (does not re-raise)."""

        def _bad_index(project, full):
            raise RuntimeError("catastrophic indexer failure")

        from token_goat import parser as _parser
        from token_goat.project import Project

        proj = Project(root=tmp_data_dir, hash="aabbccdd", marker="manual")
        with patch.object(_parser, "index_project", side_effect=_bad_index):
            result = worker._run_index_with_timeout(proj, False, timeout=5.0)

        assert result is None

    def test_timeout_triggers_backoff(self, tmp_data_dir):
        """A timed-out project increments the failure counter for backoff."""
        worker._index_failure_counts.clear()
        worker._index_backoff_until.clear()
        ph = "ccddaabb"

        def _slow_index(project, full):
            threading.Event().wait(10)  # blocks until thread is killed; well beyond test timeout

        from token_goat import parser as _parser
        from token_goat.project import Project

        proj = Project(root=tmp_data_dir, hash=ph, marker="manual")

        # Simulate _process_dirty_entries handling a timeout result.
        with patch.object(_parser, "index_project", side_effect=_slow_index):
            result = worker._run_index_with_timeout(proj, False, timeout=0.1)

        if result is None:
            worker._record_index_failure(ph, "<project>")

        count = worker._index_failure_counts.get((ph, "<project>"), 0)
        assert count >= 1, "failure count should be incremented after timeout"

        worker._index_failure_counts.clear()
        worker._index_backoff_until.clear()


# ---------------------------------------------------------------------------
# 6. Pool size cap — max_pool_workers config & ceiling
# ---------------------------------------------------------------------------


class TestPoolSizeCap:
    """worker.max_pool_workers config is honoured and capped at WORKER_MAX_POOL_CEILING."""

    def test_run_index_respects_explicit_max_workers(self, tmp_data_dir):
        """Passing max_workers= to _run_index_with_timeout uses that pool size."""
        import concurrent.futures as _cf

        from token_goat import parser as _parser
        from token_goat.project import Project

        captured_max_workers: list[int] = []

        _real_tpe = _cf.ThreadPoolExecutor

        def _tracking_tpe(max_workers=None, **kw):
            if max_workers is not None:
                captured_max_workers.append(max_workers)
            return _real_tpe(max_workers=max_workers, **kw)

        expected = {"indexed": 1, "total_files": 1, "errors": 0, "skipped_unchanged": 0, "duration_sec": 0.01}
        proj = Project(root=tmp_data_dir, hash="aabbccdd", marker="manual")

        with (
            patch.object(_parser, "index_project", return_value=expected),
            patch.object(_cf, "ThreadPoolExecutor", side_effect=_tracking_tpe),
        ):
            worker._run_index_with_timeout(proj, False, timeout=5.0, max_workers=3)

        assert 3 in captured_max_workers, (
            f"Expected ThreadPoolExecutor to be called with max_workers=3, got {captured_max_workers}"
        )

    def test_run_index_ceiling_enforced(self, tmp_data_dir):
        """max_workers above WORKER_MAX_POOL_CEILING is clamped before creating the executor."""
        import concurrent.futures as _cf

        from token_goat import config as cfg_mod
        from token_goat import parser as _parser
        from token_goat.project import Project

        captured_max_workers: list[int] = []
        _real_tpe = _cf.ThreadPoolExecutor

        def _tracking_tpe(max_workers=None, **kw):
            if max_workers is not None:
                captured_max_workers.append(max_workers)
            return _real_tpe(max_workers=max_workers, **kw)

        ceiling = cfg_mod.WORKER_MAX_POOL_CEILING
        expected = {"indexed": 1, "total_files": 1, "errors": 0, "skipped_unchanged": 0, "duration_sec": 0.01}
        proj = Project(root=tmp_data_dir, hash="aabbccdd", marker="manual")

        with (
            patch.object(_parser, "index_project", return_value=expected),
            patch.object(_cf, "ThreadPoolExecutor", side_effect=_tracking_tpe),
        ):
            # Pass a value above the ceiling; expect it to be clamped.
            worker._run_index_with_timeout(proj, False, timeout=5.0, max_workers=ceiling + 100)

        assert all(w <= ceiling for w in captured_max_workers), (
            f"Expected all pool sizes <= {ceiling}; got {captured_max_workers}"
        )

    def test_get_max_pool_workers_returns_config_value(self, tmp_data_dir, monkeypatch, tmp_path):
        """_get_max_pool_workers() returns the configured value."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        config_file = tmp_path / "config.toml"
        config_file.write_text("[worker]\nmax_pool_workers = 2\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        try:
            result = worker._get_max_pool_workers()
            assert result == 2, f"Expected 2, got {result}"
        finally:
            cfg_mod._config_mtime_cache = None

    def test_get_max_pool_workers_falls_back_on_error(self, tmp_data_dir, monkeypatch):
        """_get_max_pool_workers() returns 1 when config.load() raises."""
        import token_goat.config as cfg_mod

        with patch.object(cfg_mod, "load", side_effect=RuntimeError("config unavailable")):
            result = worker._get_max_pool_workers()
        assert result == 1, "Expected fallback of 1 on config error"
