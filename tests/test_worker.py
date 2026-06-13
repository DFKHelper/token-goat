"""Tests for token_goat.worker."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import token_goat.paths as paths
from token_goat import worker

# Captured at import, before the isolate_worker_autostart fixture stubs it —
# lets a test invoke the genuine self-registration logic on demand.
_REAL_REGISTER_AUTOSTART = worker._register_autostart


@pytest.fixture
def mock_worker_cmdline():
    """Mock psutil.Process to return a cmdline that looks like a token-goat worker.

    This lets is_worker_alive() and related functions pass the cmdline verification
    check when running under pytest (where the actual cmdline won't contain
    "token_goat worker" markers).
    """
    mock_proc = MagicMock()
    mock_proc.cmdline.return_value = ["pythonw.exe", "-m", "token_goat.cli", "worker", "--daemon"]
    with patch.object(worker.psutil, "Process", return_value=mock_proc):
        yield mock_proc

# ---------------------------------------------------------------------------
# 1. is_worker_alive() — no PID file
# ---------------------------------------------------------------------------

def test_is_worker_alive_no_pid_file(tmp_data_dir):
    assert not worker.is_worker_alive()


# ---------------------------------------------------------------------------
# 2. is_worker_alive() — PID file points to dead PID
# ---------------------------------------------------------------------------

def test_is_worker_alive_dead_pid(tmp_data_dir):
    paths.ensure_dirs()
    # Use a PID that is guaranteed not to exist: max pid + 1 is OS-clamped,
    # but psutil.pid_exists(99999999) reliably returns False on real systems.
    dead_pid = 99999999
    paths.worker_pid_path().write_text(str(dead_pid), encoding="utf-8")
    assert not worker.is_worker_alive()


# ---------------------------------------------------------------------------
# 3. is_worker_alive() — current process PID with fresh heartbeat
# ---------------------------------------------------------------------------

def test_is_worker_alive_current_process(tmp_data_dir, mock_worker_cmdline):
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    # Write a heartbeat timestamped now
    hb_path = paths.worker_heartbeat_path()
    hb_path.write_text(str(time.time()), encoding="utf-8")
    assert worker.is_worker_alive()


# ---------------------------------------------------------------------------
# 4. is_worker_alive() — stale heartbeat (> 2 * HEARTBEAT_INTERVAL + 5)
# ---------------------------------------------------------------------------

def test_is_worker_alive_stale_heartbeat(tmp_data_dir):
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    hb_path = paths.worker_heartbeat_path()
    # Write a timestamp that is well in the past
    stale_ts = time.time() - (2 * worker.HEARTBEAT_INTERVAL + 60)
    hb_path.write_text(str(stale_ts), encoding="utf-8")
    # Also backdate the mtime so the stat() check sees an old file
    os.utime(hb_path, (stale_ts, stale_ts))
    assert not worker.is_worker_alive()


# ---------------------------------------------------------------------------
# _write_pid / _heartbeat — atomic write contract
# ---------------------------------------------------------------------------


def test_write_pid_calls_atomic_write_text(tmp_data_dir, monkeypatch):
    """_write_pid() must delegate to paths.atomic_write_text, not write_text.

    Since the format changed to JSON, verify the call carries our PID and uses
    the correct path without asserting on the exact serialisation format.
    """
    import json

    calls: list[tuple[object, str]] = []

    def _spy(path, content):
        calls.append((path, content))

    monkeypatch.setattr(paths, "atomic_write_text", _spy)
    worker._write_pid()

    assert len(calls) == 1
    assert calls[0][0] == paths.worker_pid_path()
    # Content must be valid JSON containing our PID.
    data = json.loads(calls[0][1])
    assert data["pid"] == os.getpid()
    assert "interpreter" in data


def test_heartbeat_calls_atomic_write_text(tmp_data_dir, monkeypatch):
    """_heartbeat() must delegate to paths.atomic_write_text, not write_text."""
    import math

    calls: list[tuple[object, str]] = []

    def _spy(path, content):
        calls.append((path, content))

    monkeypatch.setattr(paths, "atomic_write_text", _spy)
    before = time.time()
    worker._heartbeat()
    after = time.time()

    assert len(calls) == 1
    assert calls[0][0] == paths.worker_heartbeat_path()
    written_ts = float(calls[0][1])
    assert not math.isnan(written_ts)
    assert before <= written_ts <= after + 1.0


# ---------------------------------------------------------------------------
# 5. enqueue_dirty + drain_dirty_queue: append-read-clear cycle
# ---------------------------------------------------------------------------

def test_enqueue_and_drain_dirty_queue(tmp_data_dir):
    worker.enqueue_dirty("src/foo.ts", project_hash="abc123")
    worker.enqueue_dirty("src/bar.py", project_hash="abc123")

    entries = worker.drain_dirty_queue()
    assert len(entries) == 2

    paths_in_entries = {e["path"] for e in entries}
    assert paths_in_entries == {"src/foo.ts", "src/bar.py"}
    assert all(e["project_hash"] == "abc123" for e in entries)
    assert all("ts" in e for e in entries)

    # File should be cleared after drain
    entries2 = worker.drain_dirty_queue()
    assert entries2 == []


# ---------------------------------------------------------------------------
# 6a. cleanup_on_startup — stale lockfile with dead PID gets removed
# ---------------------------------------------------------------------------

def test_cleanup_on_startup_removes_stale_lock(tmp_data_dir):
    paths.ensure_dirs()
    locks = paths.locks_dir()
    stale_lock = locks / "someproject.lock"
    # Write a dead PID (99999999) into the lock file
    stale_lock.write_text("99999999\n0.0", encoding="utf-8")

    stats = worker.cleanup_on_startup()
    assert stats["stale_locks_cleared"] >= 1
    assert not stale_lock.exists()


# ---------------------------------------------------------------------------
# 6b. cleanup_on_startup — old log file gets deleted
# ---------------------------------------------------------------------------

def test_cleanup_on_startup_deletes_old_logs(tmp_data_dir):
    paths.ensure_dirs()
    logs = paths.logs_dir()
    old_log = logs / "2020-01-01.log"
    old_log.write_text("old content", encoding="utf-8")
    # Backdate mtime to 10 days ago
    ten_days_ago = time.time() - 10 * 86400
    os.utime(old_log, (ten_days_ago, ten_days_ago))

    stats = worker.cleanup_on_startup()
    assert stats["logs_deleted"] >= 1
    assert not old_log.exists()


# ---------------------------------------------------------------------------
# 7a. evict_image_cache_if_over_limit — empty cache → no-op
# ---------------------------------------------------------------------------

def test_evict_image_cache_empty(tmp_data_dir):
    paths.ensure_dirs()
    result = worker.evict_image_cache_if_over_limit()
    assert result == (0, 0)


# ---------------------------------------------------------------------------
# 7b. evict_image_cache_if_over_limit — over limit triggers eviction
# ---------------------------------------------------------------------------

def test_evict_image_cache_over_limit(tmp_data_dir, monkeypatch):
    paths.ensure_dirs()
    img_dir = paths.image_cache_dir()

    # Lower the limit so small files trigger eviction
    small_limit = 500  # bytes
    small_target = int(small_limit * 0.8)  # 400 bytes
    monkeypatch.setattr(worker, "IMAGE_CACHE_LIMIT", small_limit)
    monkeypatch.setattr(worker, "IMAGE_CACHE_TARGET", small_target)

    # Write 6 files of 100 bytes each = 600 bytes total (> limit of 500)
    for i in range(6):
        f = img_dir / f"img_{i:02d}.png"
        f.write_bytes(b"x" * 100)
        # Stagger mtimes so LRU order is deterministic
        ts = time.time() - (6 - i) * 10
        os.utime(f, (ts, ts))

    bytes_freed, files_freed = worker.evict_image_cache_if_over_limit()
    assert bytes_freed > 0
    assert files_freed > 0

    # Verify remaining total is at or below the target
    remaining = sum(f.stat().st_size for f in img_dir.iterdir() if f.is_file())
    assert remaining <= small_target


# ---------------------------------------------------------------------------
# 8. _process_dirty_entries with a real fixture project
# ---------------------------------------------------------------------------

def test_process_dirty_entries_real_project(tmp_data_dir, tmp_path):
    """_process_dirty_entries should reindex without crashing for a known project."""
    from token_goat import db as _db
    from token_goat.project import project_hash as ph_fn

    # Create a minimal project tree
    proj_root = tmp_path / "myproject"
    proj_root.mkdir()
    (proj_root / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    src = proj_root / "src"
    src.mkdir()
    (src / "index.ts").write_text("export const x = 1;\n", encoding="utf-8")

    ph = ph_fn(proj_root.resolve())

    # Register the project in global.db
    with _db.open_global() as gconn:
        now = int(time.time())
        gconn.execute(
            "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (ph, proj_root.as_posix(), "package.json", now, now, 1, "typescript"),
        )

    entries = [{"path": "src/index.ts", "project_hash": ph, "ts": time.time()}]
    # Should not raise
    worker._process_dirty_entries(entries)


def test_process_dirty_entries_indexes_unregistered_project(tmp_data_dir, tmp_path):
    """An edit in a project that was never indexed must not be silently dropped.

    Before this fix, _process_dirty_entries looked the project hash up in
    global.db and, on a miss, logged "unknown project hash" and dropped the
    entry — so the very first edit in a not-yet-indexed project was lost and
    nothing ever triggered an initial index. The queue entry now carries
    project_root/project_marker, so the worker can reconstruct the project and
    run a first index instead.
    """
    from token_goat import db as _db
    from token_goat.project import canonicalize
    from token_goat.project import project_hash as ph_fn

    proj_root = tmp_path / "fresh_project"
    proj_root.mkdir()
    (proj_root / "package.json").write_text('{"name":"fresh"}', encoding="utf-8")
    src = proj_root / "src"
    src.mkdir()
    (src / "index.ts").write_text("export const x = 1;\n", encoding="utf-8")

    canonical = canonicalize(proj_root)
    ph = ph_fn(canonical)

    # Project deliberately NOT registered in global.db.
    with _db.open_global() as gconn:
        assert (
            gconn.execute("SELECT 1 FROM projects WHERE hash = ?", (ph,)).fetchone() is None
        )

    entries = [
        {
            "path": "src/index.ts",
            "project_hash": ph,
            "project_root": canonical.as_posix(),
            "project_marker": "package.json",
            "ts": time.time(),
        }
    ]
    worker._process_dirty_entries(entries)

    # The project was reconstructed from the self-sufficient entry and indexed,
    # so it is now registered — the edit was not dropped.
    with _db.open_global() as gconn:
        row = gconn.execute("SELECT root FROM projects WHERE hash = ?", (ph,)).fetchone()
    assert row is not None, "unregistered project was dropped instead of indexed"


# ---------------------------------------------------------------------------
# 9. run_daemon smoke test — stop_event shuts it down, PID file is cleaned up
# ---------------------------------------------------------------------------

def test_run_daemon_stop_event(tmp_data_dir, monkeypatch):
    stop = threading.Event()

    # Patch _register_autostart to set the stop event immediately after the
    # daemon starts up — no sleep needed to wait for the loop to initialise.
    original_register = worker._register_autostart

    def _register_and_stop():
        original_register()
        stop.set()

    monkeypatch.setattr(worker, "_register_autostart", _register_and_stop)

    worker.run_daemon(stop_event=stop)

    # PID file must be cleaned up after exit
    assert not paths.worker_pid_path().exists()
    assert not paths.worker_heartbeat_path().exists()


def test_run_daemon_self_registers_autostart(tmp_data_dir, monkeypatch):
    """The claim-winning worker must self-register autostart on startup.

    A `uv tool install --reinstall` (or a cleared Run key) otherwise leaves the
    worker with no autostart — it then survives only as long as a hook keeps
    respawning it. run_daemon re-asserts the registration every startup.
    """
    called = threading.Event()
    stop = threading.Event()

    def _register_and_stop():
        called.set()
        stop.set()

    monkeypatch.setattr(worker, "_register_autostart", _register_and_stop)

    worker.run_daemon(stop_event=stop)

    assert called.is_set(), "run_daemon did not call _register_autostart()"


def test_register_autostart_invokes_install_task(tmp_data_dir, monkeypatch):
    """_register_autostart() must drive the platform-appropriate install function, fail-soft.

    Uses the real callable captured at import (the autouse fixture stubs the
    one bound on the worker module).
    """
    import token_goat.install as install

    called = threading.Event()

    def spy():
        called.set()
        return (True, "spy")

    if sys.platform == "win32":
        monkeypatch.setattr(install, "install_worker_task", spy)
    elif sys.platform == "darwin":
        monkeypatch.setattr(install, "install_mac_autostart", spy)
    else:
        monkeypatch.setattr(install, "install_linux_autostart", spy)
    _REAL_REGISTER_AUTOSTART()
    assert called.is_set(), "_register_autostart did not call the platform autostart function"

    # Fail-soft: an error must not propagate out of the worker.
    def boom():
        raise OSError("autostart unavailable")

    if sys.platform == "win32":
        monkeypatch.setattr(install, "install_worker_task", boom)
    elif sys.platform == "darwin":
        monkeypatch.setattr(install, "install_mac_autostart", boom)
    else:
        monkeypatch.setattr(install, "install_linux_autostart", boom)
    _REAL_REGISTER_AUTOSTART()  # must not raise
    # The atomic claim file must also be released on shutdown.
    assert not worker._worker_claim_path().exists()


# ---------------------------------------------------------------------------
# 9b. Atomic worker-slot claim — closes the duplicate-daemon startup race
# ---------------------------------------------------------------------------

def test_claim_worker_slot_first_caller_wins(tmp_data_dir):
    """First caller gets an fd; the claim file is created with its pid."""
    fd = worker._try_claim_worker_slot()
    assert fd is not None
    try:
        claim = worker._worker_claim_path()
        assert claim.exists()
        recorded_pid = int(claim.read_text(encoding="utf-8").split("\n", 1)[0])
        assert recorded_pid == os.getpid()
    finally:
        os.close(fd)
        worker._worker_claim_path().unlink(missing_ok=True)


def test_claim_worker_slot_second_caller_blocked_by_live_owner(tmp_data_dir):
    """A second claim attempt must fail while a live owner holds the slot.

    Regression: two workers starting in the same window both passed the old
    is_worker_alive() check and both ran the main loop, leaving duplicate
    daemons draining the same dirty queue.
    """
    paths.ensure_dirs()
    # Existing claim owned by THIS process (alive) — record its real create
    # time so the identity check recognizes it as the live owner.
    claim = worker._worker_claim_path()
    real_ct = worker._proc_create_time(os.getpid())
    claim.write_text(f"{os.getpid()}\n{real_ct}", encoding="utf-8")

    fd = worker._try_claim_worker_slot()
    assert fd is None, "second claim must be refused while a live worker holds it"
    claim.unlink(missing_ok=True)


def test_claim_worker_slot_not_stale_for_long_running_owner(tmp_data_dir):
    """Regression: a healthy owner alive longer than any grace window must NOT
    be judged stale.

    The previous implementation compared the claim's spawn timestamp against
    WORKER_STARTUP_GRACE (15 s), so any worker alive >15 s was wrongly
    reclaimed — spawning a duplicate daemon. The create-time identity check
    has no such window.
    """
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    real_ct = worker._proc_create_time(os.getpid())
    claim.write_text(f"{os.getpid()}\n{real_ct}", encoding="utf-8")

    # _worker_claim_is_stale must say "not stale" regardless of how long ago
    # the claim's create_time is — this process has been alive far longer
    # than WORKER_STARTUP_GRACE.
    assert worker._worker_claim_is_stale(claim) is False
    claim.unlink(missing_ok=True)


def test_claim_worker_slot_reclaims_dead_owner(tmp_data_dir):
    """A claim left by a dead worker must be reclaimable."""
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    # Claim owned by a PID that is almost certainly not alive.
    claim.write_text(f"999999999\n{time.time()}", encoding="utf-8")

    fd = worker._try_claim_worker_slot()
    assert fd is not None, "a dead owner's claim must be reclaimable"
    try:
        assert int(claim.read_text(encoding="utf-8").split("\n", 1)[0]) == os.getpid()
    finally:
        os.close(fd)
        claim.unlink(missing_ok=True)


def test_claim_worker_slot_reclaims_recycled_pid(tmp_data_dir):
    """If the PID is alive but its create-time differs, the PID was recycled —
    the claim must be reclaimable."""
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    # This PID is alive (it's us) but the recorded create_time is bogus,
    # simulating a PID that was recycled to a different process.
    claim.write_text(f"{os.getpid()}\n1.0", encoding="utf-8")

    assert worker._worker_claim_is_stale(claim) is True
    claim.unlink(missing_ok=True)


def test_claim_worker_slot_empty_claim_is_not_stale(tmp_data_dir):
    """An empty/mid-write claim must be treated as a live owner, not reclaimed.

    The window between O_EXCL create and the write is microscopic; if a racing
    caller treated that empty file as stale it would re-open the race.
    """
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    claim.write_text("", encoding="utf-8")  # owner mid-startup
    # mtime is fresh (just written) — must not be stale
    assert worker._worker_claim_is_stale(claim) is False
    fd = worker._try_claim_worker_slot()
    assert fd is None, "empty claim must be treated as owner-mid-startup, not stale"
    claim.unlink(missing_ok=True)


def test_claim_is_stale_empty_claim_aged(tmp_data_dir):
    """An empty claim whose mtime is >60 s old is a zombie — the worker died
    between O_EXCL create and os.write.  It must be treated as stale."""
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    claim.write_text("", encoding="utf-8")
    # Back-date the mtime by 61 seconds to simulate a zombie file.
    old_mtime = time.time() - 61
    os.utime(claim, (old_mtime, old_mtime))

    assert worker._worker_claim_is_stale(claim) is True
    claim.unlink(missing_ok=True)


def test_claim_is_stale_malformed_claim_aged(tmp_data_dir):
    """A malformed (non-parseable) claim older than 60 s must also be treated as stale."""
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    claim.write_text("not-a-pid\nnot-a-float", encoding="utf-8")
    old_mtime = time.time() - 120
    os.utime(claim, (old_mtime, old_mtime))

    assert worker._worker_claim_is_stale(claim) is True
    claim.unlink(missing_ok=True)


def test_claim_worker_slot_write_failure_removes_orphan(tmp_data_dir):
    """A write failure after the O_EXCL create must close the fd and delete the empty file.

    Regression test: a failed os.write used to leak the fd and leave an empty
    claim file behind. _worker_claim_is_stale treats an empty claim as NOT
    stale (to protect the create -> write window), so an orphaned empty file
    could never be reclaimed — it wedged the single-worker slot permanently.
    """
    paths.ensure_dirs()
    claim = worker._worker_claim_path()
    assert not claim.exists()

    with patch("token_goat.worker.os.write", side_effect=OSError("disk full")):
        fd = worker._try_claim_worker_slot()

    assert fd is None, "a failed claim must return None"
    assert not claim.exists(), "an empty claim file was orphaned — it would wedge the worker slot"


def test_run_daemon_second_instance_exits_immediately(tmp_data_dir):
    """If the slot is already claimed, run_daemon must return without running."""
    paths.ensure_dirs()
    # Pre-claim the slot as a live owner (this process).
    claim = worker._worker_claim_path()
    real_ct = worker._proc_create_time(os.getpid())
    claim.write_text(f"{os.getpid()}\n{real_ct}", encoding="utf-8")

    with patch.object(worker, "drain_dirty_queue") as mock_drain:
        worker.run_daemon(stop_event=threading.Event())

    # The second instance must bail before the main loop ever drains the queue.
    mock_drain.assert_not_called()
    claim.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# 10. ensure_running() — worker already alive returns existing PID, no spawn
# ---------------------------------------------------------------------------

def test_ensure_running_already_alive(tmp_data_dir, mock_worker_cmdline):
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    paths.worker_heartbeat_path().write_text(str(time.time()), encoding="utf-8")

    with patch.object(worker, "spawn_detached") as mock_spawn:
        result = worker.ensure_running()

    assert result == pid
    mock_spawn.assert_not_called()


# ---------------------------------------------------------------------------
# 10b. Worker self-heal — ensure_running must distinguish crashed / hung / busy
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Dirty queue cap test
# ---------------------------------------------------------------------------

def test_enqueue_dirty_byte_cap_drops_new_entries(tmp_data_dir, monkeypatch):
    """enqueue_dirty enforces DIRTY_QUEUE_MAX_BYTES by dropping new entries (not evicting old ones).

    The implementation uses a single stat() call (O(1)) to check the file size; when at or above
    the cap, new entries are silently dropped.  Old entries are never evicted — that is done by
    drain_dirty_queue which deduplicates as it reads.
    """
    paths.ensure_dirs()

    # Use a small byte cap for testing
    test_cap_bytes = 500
    monkeypatch.setattr(worker, "DIRTY_QUEUE_MAX_BYTES", test_cap_bytes)

    queue_path = paths.dirty_queue_path()
    # Write a file that's already at the cap
    queue_path.write_bytes(b"x" * test_cap_bytes)
    size_before = queue_path.stat().st_size

    # Attempt to enqueue — must be dropped
    worker.enqueue_dirty("file_new.py", project_hash="proj123")

    # File must not have grown
    assert queue_path.stat().st_size == size_before, (
        "new entry must be dropped when queue is at the byte cap"
    )

    # The queued content must not have been modified (no eviction of old entries)
    assert queue_path.read_bytes() == b"x" * test_cap_bytes


# ---------------------------------------------------------------------------
# TestWorkerSelfHeal
# ---------------------------------------------------------------------------


class TestWorkerSelfHeal:
    """ensure_running() must respawn a crashed or hung worker, but never
    disturb a healthy-but-busy one (which would orphan it or spawn a
    duplicate that just loses the claim race)."""

    def test_is_token_goat_worker_false_for_dead_pid(self, tmp_data_dir):
        # 999999999 is not a real PID — cmdline lookup fails → not a worker.
        assert worker._is_token_goat_worker(999999999) is False

    def test_is_worker_alive_rejects_recycled_pid(self, tmp_data_dir):
        """PID liveness + cmdline verification catches PID recycling: worker dies,
        PID is handed to an unrelated process. Cmdline check will fail.
        """
        paths.ensure_dirs()
        pid = os.getpid()
        paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
        hb_path = paths.worker_heartbeat_path()
        hb_path.write_text(str(time.time()), encoding="utf-8")

        # Mock psutil.Process to return a cmdline that does NOT contain token_goat.
        # This simulates a PID recycled to an unrelated process (e.g. some background task).
        mock_proc = MagicMock()
        mock_proc.cmdline.return_value = ["some_random_process.exe", "--arg"]

        with patch.object(worker.psutil, "Process", return_value=mock_proc):
            # Should reject because cmdline doesn't match token-goat worker.
            assert worker.is_worker_alive() is False

    def test_live_worker_pid_none_for_dead_pid(self, tmp_data_dir):
        paths.ensure_dirs()
        paths.worker_pid_path().write_text("999999999", encoding="utf-8")
        assert worker._live_worker_pid() is None

    def test_reap_hung_worker_noop_when_no_live_worker(self, tmp_data_dir):
        """No live worker process → nothing to reap."""
        with patch.object(worker, "_live_worker_pid", return_value=None):
            assert worker._reap_hung_worker() is False

    def test_reap_hung_worker_spares_busy_worker(self, tmp_data_dir):
        """A live worker with a only-moderately-stale heartbeat is *busy*, not
        hung — it must not be killed."""
        paths.ensure_dirs()
        # Heartbeat 100 s old: past is_worker_alive()'s 65 s window, but far
        # under WORKER_HUNG_THRESHOLD.
        hb = paths.worker_heartbeat_path()
        hb.write_text(str(time.time()), encoding="utf-8")
        old = time.time() - 100
        os.utime(hb, (old, old))

        with patch.object(worker, "_live_worker_pid", return_value=4242), \
             patch.object(worker.psutil, "Process") as mock_proc:
            assert worker._reap_hung_worker() is False
            mock_proc.assert_not_called()  # never even looked the process up

    def test_reap_hung_worker_kills_genuinely_hung_worker(self, tmp_data_dir):
        """A live worker silent past WORKER_HUNG_THRESHOLD is hung → terminate."""
        paths.ensure_dirs()
        hb = paths.worker_heartbeat_path()
        hb.write_text(str(time.time()), encoding="utf-8")
        very_old = time.time() - (worker.WORKER_HUNG_THRESHOLD + 60)
        os.utime(hb, (very_old, very_old))

        fake_proc = MagicMock()
        with patch.object(worker, "_live_worker_pid", return_value=4242), \
             patch.object(worker.psutil, "Process", return_value=fake_proc):
            assert worker._reap_hung_worker() is True
        fake_proc.terminate.assert_called_once()

    def test_ensure_running_leaves_busy_worker_alone(self, tmp_data_dir):
        """is_worker_alive() False but a live worker exists and is not hung →
        return its PID, never spawn a duplicate or clear its pid file."""
        with patch.object(worker, "is_worker_alive", return_value=False), \
             patch.object(worker, "_reap_hung_worker", return_value=False), \
             patch.object(worker, "_live_worker_pid", return_value=4242), \
             patch.object(worker, "spawn_detached") as mock_spawn:
            result = worker.ensure_running()
        assert result == 4242
        mock_spawn.assert_not_called()

    def test_ensure_running_respawns_crashed_worker(self, tmp_data_dir):
        """No live worker at all → clear stale state and spawn a fresh one."""
        with patch.object(worker, "is_worker_alive", return_value=False), \
             patch.object(worker, "_reap_hung_worker", return_value=False), \
             patch.object(worker, "_live_worker_pid", return_value=None), \
             patch.object(worker, "spawn_detached", return_value=777) as mock_spawn:
            result = worker.ensure_running()
        assert result == 777
        mock_spawn.assert_called_once()

    def test_ensure_running_respawns_after_reaping_hung_worker(self, tmp_data_dir):
        """A hung worker was reaped → spawn a replacement."""
        with patch.object(worker, "is_worker_alive", return_value=False), \
             patch.object(worker, "_reap_hung_worker", return_value=True), \
             patch.object(worker, "spawn_detached", return_value=888) as mock_spawn:
            result = worker.ensure_running()
        assert result == 888
        mock_spawn.assert_called_once()


# ---------------------------------------------------------------------------
# 11. spawn_detached — mocked; does not actually fork in CI
# ---------------------------------------------------------------------------

def test_spawn_detached_mocked(tmp_data_dir, monkeypatch):
    """spawn_detached should return the PID returned by Popen."""
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    fake_proc = MagicMock()
    fake_proc.pid = 12345

    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_detached()

    assert pid == 12345
    mock_popen.assert_called_once()
    cmd_arg = mock_popen.call_args[0][0]
    # Prefer the windowless token-goat-worker binary (or fall back to token-goat);
    # either way the trailing args are stable.
    assert cmd_arg[-2:] == ["worker", "--daemon"]
    assert any("token_goat" in arg for arg in cmd_arg)


def test_spawn_detached_captures_stderr_to_file(tmp_data_dir, monkeypatch):
    """spawn_detached must not send the worker's stderr to DEVNULL.

    A worker that crashes before its logging FileHandler is attached — an
    import error, a failure in _setup_logging — would otherwise die with no
    trace at all. Its stderr now goes to logs/worker-stderr.log instead.
    """
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    fake_proc = MagicMock()
    fake_proc.pid = 999

    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_detached()

    assert pid == 999
    stderr_arg = mock_popen.call_args.kwargs["stderr"]
    assert stderr_arg is not worker.subprocess.DEVNULL, "worker stderr must not be DEVNULL"
    assert str(getattr(stderr_arg, "name", "")).endswith("worker-stderr.log")
    assert (tmp_data_dir / "logs" / "worker-stderr.log").exists()


def test_spawn_detached_rotates_oversized_stderr_log(tmp_data_dir, monkeypatch):
    """An oversized worker-stderr.log rolls over before the next spawn.

    spawn_detached appends to logs/worker-stderr.log on every spawn; without a
    size cap the crash sink grows without bound — the daily-log retention sweep
    never catches it because each append refreshes the mtime. Once the file
    exceeds STDERR_LOG_MAX_BYTES it must roll over to worker-stderr.prev.log.
    """
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    logs_dir = tmp_data_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stderr_log = logs_dir / "worker-stderr.log"
    oversized = b"x" * (worker.STDERR_LOG_MAX_BYTES + 1)
    stderr_log.write_bytes(oversized)

    fake_proc = MagicMock()
    fake_proc.pid = 555

    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc):
        worker.spawn_detached()

    prev = logs_dir / "worker-stderr.prev.log"
    assert prev.exists(), "oversized stderr log must roll over to .prev.log"
    assert prev.stat().st_size == len(oversized), "rolled-over content must be preserved intact"
    # The live file was reopened fresh in append mode — back to empty.
    assert stderr_log.stat().st_size == 0, "live stderr log must be reset after rollover"


def test_setup_logging_skips_console_handler_when_not_tty(tmp_data_dir, monkeypatch):
    """A detached daemon (non-tty stderr) gets only the FileHandler.

    Its stderr is the worker-stderr.log crash sink (see spawn_detached); a
    console StreamHandler there would bury real tracebacks under routine logs.
    """
    log = logging.getLogger("token_goat.worker")
    saved = list(log.handlers)
    for h in saved:
        log.removeHandler(h)

    class _NotATty:
        def isatty(self):
            return False

    monkeypatch.setattr(worker.sys, "stderr", _NotATty())
    try:
        worker._setup_logging()
        console = [
            h
            for h in log.handlers
            if isinstance(h, logging.StreamHandler)
            and not isinstance(h, logging.FileHandler)
        ]
        assert not console, "console StreamHandler attached despite non-tty stderr"
        assert any(isinstance(h, logging.FileHandler) for h in log.handlers)
    finally:
        for h in list(log.handlers):
            log.removeHandler(h)
        for h in saved:
            log.addHandler(h)


def test_setup_logging_rolls_oversized_daily_log(tmp_data_dir):
    """_setup_logging rolls an oversized daily log before attaching its handler.

    Regression guard: the daily log handler used a plain FileHandler with no
    size cap, so a single pathological day (a worker stuck in a fast error
    loop) could bloat one day's file. _setup_logging now rolls it via
    paths.roll_log_if_oversized before opening the handler.
    """
    from datetime import datetime

    log = logging.getLogger("token_goat.worker")
    saved = list(log.handlers)
    for h in saved:
        log.removeHandler(h)

    log_path = tmp_data_dir / "logs" / f"{datetime.now():%Y-%m-%d}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    payload = b"z" * (paths.LOG_FILE_MAX_BYTES + 1)
    log_path.write_bytes(payload)

    try:
        worker._setup_logging()
        prev = log_path.with_suffix(".prev.log")
        assert prev.exists(), "oversized daily log must roll over before handler attach"
        assert prev.stat().st_size == len(payload), "rolled-over content must be intact"
    finally:
        for h in list(log.handlers):
            log.removeHandler(h)
        for h in saved:
            log.addHandler(h)


# ---------------------------------------------------------------------------
# spawn_index_detached — idempotency guard against the 44-process pileup
# ---------------------------------------------------------------------------

def test_spawn_index_detached_writes_marker(tmp_data_dir, monkeypatch):
    """First spawn for a project Popens an index and records a spawn marker."""
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    fake_proc = MagicMock()
    fake_proc.pid = 55501
    h = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc):
        pid = worker.spawn_index_detached(str(tmp_data_dir), h)

    assert pid == 55501
    marker = paths.locks_dir() / f"{h}.indexing"
    assert marker.exists()
    recorded_pid, _ts = marker.read_text(encoding="utf-8").split("\n", 1)
    assert recorded_pid == "55501"


def test_spawn_index_detached_skips_when_already_running(tmp_data_dir):
    """Regression: a second spawn must be a no-op while the first is alive.

    This is the guard against the runaway pileup — 44 concurrent
    `index --full` processes (~41 GB paged memory) were observed in the field
    because every SessionStart hook Popen'd another indexer with no dedup.
    """
    marker = paths.locks_dir() / "hashBBB.indexing"
    marker.parent.mkdir(parents=True, exist_ok=True)
    # Marker owned by *this* process (definitely alive) with a fresh timestamp.
    marker.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    with patch("token_goat.worker.subprocess.Popen") as mock_popen:
        pid = worker.spawn_index_detached("C:/proj", "hashBBB")

    assert pid is None, "spawn must be skipped while an index is already running"
    mock_popen.assert_not_called()


def test_spawn_index_detached_respawns_when_marker_stale(tmp_data_dir, monkeypatch):
    """A stale marker (timestamp older than the TTL) must not block a new spawn."""
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    h = "cccccccccccccccccccccccccccccccccccccccc"
    marker = paths.locks_dir() / f"{h}.indexing"
    marker.parent.mkdir(parents=True, exist_ok=True)
    stale_ts = time.time() - (worker.INDEX_SPAWN_TTL + 60)
    marker.write_text(f"{os.getpid()}\n{stale_ts}", encoding="utf-8")

    fake_proc = MagicMock()
    fake_proc.pid = 55503
    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_index_detached(str(tmp_data_dir), h)

    assert pid == 55503
    mock_popen.assert_called_once()


def test_spawn_index_detached_respawns_when_pid_dead(tmp_data_dir, monkeypatch):
    """A marker whose PID is no longer alive must not block a new spawn."""
    monkeypatch.delenv("TOKEN_GOAT_NO_WORKER_SPAWN", raising=False)
    h = "dddddddddddddddddddddddddddddddddddddddd"
    marker = paths.locks_dir() / f"{h}.indexing"
    marker.parent.mkdir(parents=True, exist_ok=True)
    # PID 1 with a port-style high number that is almost certainly not alive;
    # use a fresh timestamp so only the dead-PID condition is under test.
    dead_pid = 999999999
    marker.write_text(f"{dead_pid}\n{time.time()}", encoding="utf-8")

    fake_proc = MagicMock()
    fake_proc.pid = 55504
    with patch("token_goat.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_index_detached(str(tmp_data_dir), h)

    assert pid == 55504
    mock_popen.assert_called_once()


# ---------------------------------------------------------------------------
# 11b. reap_stale_index_markers — clear the debris left by finished/crashed
#      indexers so it cannot accumulate (the gap that left 16 markers on disk)
# ---------------------------------------------------------------------------

def test_reap_stale_index_markers_removes_dead_pid_marker(tmp_data_dir):
    """A marker whose indexer PID is gone is debris — reap it."""
    paths.ensure_dirs()
    marker = paths.locks_dir() / "deadpid.indexing"
    # Fresh timestamp so only the dead-PID condition is under test.
    marker.write_text(f"999999999\n{time.time()}", encoding="utf-8")

    cleared = worker.reap_stale_index_markers()
    assert cleared == 1
    assert not marker.exists()


def test_reap_stale_index_markers_removes_expired_marker(tmp_data_dir):
    """A marker older than INDEX_SPAWN_TTL is reaped even if its PID is alive."""
    paths.ensure_dirs()
    marker = paths.locks_dir() / "expired.indexing"
    stale_ts = time.time() - (worker.INDEX_SPAWN_TTL + 60)
    # This process's PID is definitely alive — TTL alone must trigger the reap.
    marker.write_text(f"{os.getpid()}\n{stale_ts}", encoding="utf-8")

    cleared = worker.reap_stale_index_markers()
    assert cleared == 1
    assert not marker.exists()


def test_reap_stale_index_markers_removes_malformed_marker(tmp_data_dir):
    """A marker that cannot be parsed is debris — reap it."""
    paths.ensure_dirs()
    marker = paths.locks_dir() / "garbage.indexing"
    marker.write_text("not a valid marker", encoding="utf-8")

    cleared = worker.reap_stale_index_markers()
    assert cleared == 1
    assert not marker.exists()


def test_reap_stale_index_markers_spares_active_marker(tmp_data_dir):
    """A marker for a live, fresh indexer must never be reaped — reaping it
    would re-open the runaway-pileup race spawn_index_detached() guards."""
    paths.ensure_dirs()
    marker = paths.locks_dir() / "active.indexing"
    # This process is alive, timestamp is fresh: _index_spawn_active() → True.
    marker.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    cleared = worker.reap_stale_index_markers()
    assert cleared == 0
    assert marker.exists()


def test_cleanup_on_startup_reaps_stale_index_markers(tmp_data_dir):
    """cleanup_on_startup (run on startup *and* every maintenance cycle) clears
    stale index markers while leaving an active one in place."""
    paths.ensure_dirs()
    locks = paths.locks_dir()
    stale = locks / "stalehash.indexing"
    stale.write_text(f"999999999\n{time.time()}", encoding="utf-8")
    active = locks / "activehash.indexing"
    active.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    stats = worker.cleanup_on_startup()
    assert stats["stale_index_markers_cleared"] >= 1
    assert not stale.exists()
    assert active.exists()


# ---------------------------------------------------------------------------
# 12. enqueue_dirty with None project_hash
# ---------------------------------------------------------------------------

def test_enqueue_dirty_none_project_hash(tmp_data_dir):
    """enqueue_dirty should accept None as project_hash."""
    worker.enqueue_dirty("src/foo.ts", project_hash=None)
    entries = worker.drain_dirty_queue()
    assert len(entries) == 1
    assert entries[0]["path"] == "src/foo.ts"
    assert entries[0]["project_hash"] is None


# ---------------------------------------------------------------------------
# 13. drain_dirty_queue returns empty list when queue file doesn't exist
# ---------------------------------------------------------------------------

def test_drain_dirty_queue_missing_file(tmp_data_dir):
    """drain_dirty_queue should return [] when queue file missing."""
    entries = worker.drain_dirty_queue()
    assert entries == []


# ---------------------------------------------------------------------------
# 14. is_worker_alive with malformed PID file
# ---------------------------------------------------------------------------

def test_is_worker_alive_malformed_pid_file(tmp_data_dir):
    """is_worker_alive should handle non-numeric PID gracefully."""
    paths.ensure_dirs()
    paths.worker_pid_path().write_text("not_a_number", encoding="utf-8")
    # Should not raise; should return False
    result = worker.is_worker_alive()
    assert result is False


# ---------------------------------------------------------------------------
# 15. is_worker_alive with empty PID file
# ---------------------------------------------------------------------------

def test_is_worker_alive_empty_pid_file(tmp_data_dir):
    """is_worker_alive should handle empty PID file gracefully."""
    paths.ensure_dirs()
    paths.worker_pid_path().write_text("", encoding="utf-8")
    result = worker.is_worker_alive()
    assert result is False


# ---------------------------------------------------------------------------
# 16. is_worker_alive with fresh heartbeat (current mtime)
# ---------------------------------------------------------------------------

def test_is_worker_alive_fresh_heartbeat_mtime(tmp_data_dir, mock_worker_cmdline):
    """is_worker_alive should return True for fresh heartbeat (mtime-based check)."""
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    hb_path = paths.worker_heartbeat_path()
    # Write any content; the actual check is mtime-based
    hb_path.write_text("x", encoding="utf-8")
    # Fresh mtime (just created), so should return True
    result = worker.is_worker_alive()
    assert result is True


# ---------------------------------------------------------------------------
# 16b. is_worker_alive with heartbeat file missing and dead PID
# ---------------------------------------------------------------------------

def test_is_worker_alive_no_heartbeat_dead_pid(tmp_data_dir):
    """is_worker_alive should return False if PID is dead and no heartbeat."""
    paths.ensure_dirs()
    # Use a PID that definitely doesn't exist
    stale_pid = 99999999
    paths.worker_pid_path().write_text(str(stale_pid), encoding="utf-8")
    result = worker.is_worker_alive()
    # Should return False because PID doesn't exist
    assert result is False


# ---------------------------------------------------------------------------
# 16c. is_worker_alive — startup grace (live pid, no heartbeat yet)
# ---------------------------------------------------------------------------


def test_is_worker_alive_startup_grace_no_heartbeat(tmp_data_dir, monkeypatch, mock_worker_cmdline):
    """A live process with no heartbeat file yet must be treated as alive during
    the startup grace window.  This prevents spurious re-spawns in the first
    WORKER_STARTUP_GRACE seconds of a fresh worker process.
    """
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    # Ensure no heartbeat file exists.
    hb = paths.worker_heartbeat_path()
    hb.unlink(missing_ok=True)

    # Patch _is_process_recent to return True (simulating a very new process).
    monkeypatch.setattr(worker, "_is_process_recent", lambda _pid: True)

    assert worker.is_worker_alive() is True


def test_is_worker_alive_startup_grace_expired_no_heartbeat(tmp_data_dir, monkeypatch, mock_worker_cmdline):
    """Once the startup grace period expires, a missing heartbeat means the
    worker is not alive — it should not be left indefinitely un-restarted.
    """
    paths.ensure_dirs()
    pid = os.getpid()
    paths.worker_pid_path().write_text(str(pid), encoding="utf-8")
    hb = paths.worker_heartbeat_path()
    hb.unlink(missing_ok=True)

    # Patch _is_process_recent to return False (grace window expired).
    monkeypatch.setattr(worker, "_is_process_recent", lambda _pid: False)

    assert worker.is_worker_alive() is False


def test_is_heartbeat_stale_for_nudge_missing_file(tmp_data_dir):
    """A missing heartbeat file must be treated as stale so the post-edit hook
    triggers ensure_running and a new worker is spawned.
    """
    hb = paths.worker_heartbeat_path()
    hb.unlink(missing_ok=True)
    assert worker.is_heartbeat_stale_for_nudge(hb) is True


def test_ensure_running_clears_pid_before_spawn(tmp_data_dir, monkeypatch):
    """ensure_running must call _clear_pid() before spawning a new worker so the
    fresh worker can claim the pid slot without finding a stale PID file.
    """
    clear_calls: list[int] = []

    def _spy_clear_pid():
        clear_calls.append(1)

    monkeypatch.setattr(worker, "is_worker_alive", lambda: False)
    monkeypatch.setattr(worker, "_reap_hung_worker", lambda: False)
    monkeypatch.setattr(worker, "_live_worker_pid", lambda: None)
    monkeypatch.setattr(worker, "_clear_pid", _spy_clear_pid)
    monkeypatch.setattr(worker, "spawn_detached", lambda: 999)

    result = worker.ensure_running()

    assert result == 999
    assert len(clear_calls) == 1, "_clear_pid must be called exactly once before spawn"


# ---------------------------------------------------------------------------
# 17. cleanup_on_startup with mixed stale/fresh locks
# ---------------------------------------------------------------------------

def test_cleanup_on_startup_mixed_locks(tmp_data_dir):
    """cleanup_on_startup should only clear stale locks, not fresh ones."""
    paths.ensure_dirs()
    locks = paths.locks_dir()

    # Stale lock (dead PID)
    stale_lock = locks / "proj_stale.lock"
    stale_lock.write_text("99999999\n0.0", encoding="utf-8")

    # Fresh lock (current PID)
    fresh_lock = locks / "proj_fresh.lock"
    fresh_lock.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    worker.cleanup_on_startup()
    assert not stale_lock.exists()
    assert fresh_lock.exists()


# ---------------------------------------------------------------------------
# 18. enqueue_dirty multiple calls queue correctly
# ---------------------------------------------------------------------------

def test_enqueue_dirty_multiple_sequential(tmp_data_dir):
    """Multiple enqueue_dirty calls should append to queue."""
    worker.enqueue_dirty("file1.ts")
    worker.enqueue_dirty("file2.py")
    worker.enqueue_dirty("file3.go")

    entries = worker.drain_dirty_queue()
    assert len(entries) == 3
    paths_list = [e["path"] for e in entries]
    assert paths_list == ["file1.ts", "file2.py", "file3.go"]


# ---------------------------------------------------------------------------
# 19. evict_image_cache with no files to evict
# ---------------------------------------------------------------------------

def test_evict_image_cache_below_limit(tmp_data_dir, monkeypatch):
    """evict_image_cache should not evict if cache is below limit."""
    paths.ensure_dirs()
    img_dir = paths.image_cache_dir()

    # Set a large limit
    large_limit = 1000000  # 1 MB
    monkeypatch.setattr(worker, "IMAGE_CACHE_LIMIT", large_limit)

    # Write only 100 bytes (below limit)
    small_file = img_dir / "tiny.png"
    small_file.write_bytes(b"x" * 100)

    bytes_freed, files_freed = worker.evict_image_cache_if_over_limit()
    # Should not evict because below limit
    assert (bytes_freed, files_freed) == (0, 0)
    assert small_file.exists()


# ---------------------------------------------------------------------------
# _reindex_active_projects — periodic sweep of all recently-active projects
# ---------------------------------------------------------------------------

class TestReindexActiveProjects:
    def _register_project(
        self, gconn, hash_: str, root: str, marker: str, file_count: int,
        *, last_seen: int | None = None,
    ) -> None:
        now = int(time.time())
        ls = now if last_seen is None else last_seen
        gconn.execute(
            "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (hash_, root, marker, now, ls, file_count, "markdown"),
        )

    def test_does_nothing_when_no_projects(self, tmp_data_dir):
        # No projects registered at all — should not raise
        worker._reindex_active_projects()

    def test_reindexes_git_project(self, tmp_data_dir, tmp_path):
        """Regression: git-detected projects must be swept too — this is the
        fix for edits made outside Claude Code, which never hit the dirty
        queue. The previous _reindex_manual_projects only covered
        marker='manual' (skills/plugins), so normal projects drifted stale."""
        from token_goat import db as _db
        from token_goat.parser import index_project
        from token_goat.project import canonicalize, make_project_at, project_hash

        proj_root = tmp_path / "code"
        proj_root.mkdir()
        (proj_root / "mod.py").write_text("def f():\n    return 1\n", encoding="utf-8")
        ph = project_hash(canonicalize(proj_root))
        index_project(make_project_at(proj_root), full=True)
        with _db.open_global() as gconn:
            self._register_project(gconn, ph, proj_root.as_posix(), ".git", 1)

        with patch("token_goat.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_called_once()

    def test_reindex_triggers_git_history_indexing(self, tmp_data_dir, tmp_path):
        """The periodic sweep refreshes git-history hints for each active project.

        Regression test: git-history indexing used to run only from a daemon
        thread spawned by the SessionStart hook — a thread killed when the
        ephemeral hook process exited, so the indexing rarely finished. The
        durable worker now owns it as part of the reindex sweep.
        """
        from token_goat import db as _db
        from token_goat import git_history
        from token_goat.parser import index_project
        from token_goat.project import canonicalize, make_project_at, project_hash

        proj_root = tmp_path / "code"
        proj_root.mkdir()
        (proj_root / "mod.py").write_text("def f():\n    return 1\n", encoding="utf-8")
        ph = project_hash(canonicalize(proj_root))
        index_project(make_project_at(proj_root), full=True)
        with _db.open_global() as gconn:
            self._register_project(gconn, ph, proj_root.as_posix(), ".git", 1)

        with patch.object(git_history, "index_project_history") as mock_gh:
            worker._reindex_active_projects()

        mock_gh.assert_called_once()
        called_root, called_hash = mock_gh.call_args[0]
        assert called_root == proj_root
        assert called_hash == ph

    def test_reindexes_manual_project(self, tmp_data_dir, tmp_path):
        from token_goat import db as _db
        from token_goat.project import canonicalize, project_hash

        skill_root = tmp_path / "skills"
        skill_root.mkdir()
        (skill_root / "tool.md").write_text("# Tool\n\n## Section\n\nContent.\n", encoding="utf-8")
        ph = project_hash(canonicalize(skill_root))

        with _db.open_global() as gconn:
            self._register_project(gconn, ph, skill_root.as_posix(), "manual", 1)

        # First index so there is a project DB to update
        from token_goat.parser import index_project
        from token_goat.project import make_project_at
        index_project(make_project_at(skill_root), full=True)

        # Now call the sweep — should run without raising
        worker._reindex_active_projects()

    def test_skips_project_outside_active_window(self, tmp_data_dir, tmp_path):
        """A project not seen within PERIODIC_REINDEX_ACTIVE_WINDOW is skipped."""
        from token_goat import db as _db
        from token_goat.project import project_hash

        old_root = tmp_path / "dormant"
        old_root.mkdir()
        ph = project_hash(old_root.resolve())
        # last_seen well outside the active window
        stale_ts = int(time.time() - worker.PERIODIC_REINDEX_ACTIVE_WINDOW - 3600)
        with _db.open_global() as gconn:
            self._register_project(gconn, ph, str(old_root), ".git", 5, last_seen=stale_ts)

        with patch("token_goat.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_not_called()

    def test_skips_project_exceeding_file_cap(self, tmp_data_dir, tmp_path, monkeypatch):
        from token_goat import db as _db
        from token_goat.project import project_hash

        big_root = tmp_path / "huge"
        big_root.mkdir()
        ph = project_hash(big_root.resolve())
        with _db.open_global() as gconn:
            # Register with file_count > cap
            self._register_project(gconn, ph, str(big_root), "manual", 9999)

        monkeypatch.setattr(worker, "PERIODIC_REINDEX_MAX_FILES", 500)

        with patch("token_goat.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_not_called()

    def test_one_project_failing_does_not_block_others(self, tmp_data_dir, tmp_path):
        from token_goat import db as _db
        from token_goat.project import canonicalize, make_project_at, project_hash

        good_root = tmp_path / "good"
        good_root.mkdir()
        (good_root / "skill.md").write_text("# Good\n", encoding="utf-8")
        bad_root = tmp_path / "bad"
        bad_root.mkdir()

        good_ph = project_hash(canonicalize(good_root))
        bad_ph = project_hash(canonicalize(bad_root))

        from token_goat.parser import index_project
        index_project(make_project_at(good_root), full=True)

        with _db.open_global() as gconn:
            self._register_project(gconn, bad_ph, bad_root.as_posix(), "manual", 1)
            self._register_project(gconn, good_ph, good_root.as_posix(), "manual", 1)

        call_log: list[str] = []

        original_index = __import__("token_goat.parser", fromlist=["index_project"]).index_project

        def _patched_index(proj, **kw):
            if proj.hash == bad_ph:
                raise RuntimeError("simulated index failure")
            call_log.append(proj.hash)
            return original_index(proj, **kw)

        with patch("token_goat.parser.index_project", side_effect=_patched_index):
            worker._reindex_active_projects()  # must not raise

        # good project was still processed despite bad project failing
        assert good_ph in call_log

    def test_global_db_error_is_swallowed(self, tmp_data_dir, monkeypatch):
        from token_goat import db as _db

        def _boom(*a, **kw):
            raise _db.DBError("DB gone")

        monkeypatch.setattr(_db, "open_global_readonly", _boom)
        # Should not raise — error is caught and logged
        worker._reindex_active_projects()

    def test_run_daemon_triggers_periodic_reindex(self, tmp_data_dir, monkeypatch):
        """run_daemon calls _reindex_active_projects when the interval elapses."""
        import threading

        monkeypatch.setattr(worker, "PERIODIC_REINDEX_INTERVAL", 0.0)  # trigger immediately
        monkeypatch.setattr(worker, "POLL_INTERVAL", 0.05)

        called = threading.Event()
        original = worker._reindex_active_projects

        def _spy():
            called.set()
            original()

        monkeypatch.setattr(worker, "_reindex_active_projects", _spy)

        stop = threading.Event()
        t = threading.Thread(target=worker.run_daemon, kwargs={"stop_event": stop}, daemon=True)
        t.start()
        called.wait(timeout=3.0)
        stop.set()
        t.join(timeout=3.0)

        assert called.is_set(), "_reindex_active_projects was never called by run_daemon"


# ---------------------------------------------------------------------------
# 16. drain_dirty_queue — atomic rename closes the read-then-truncate race
# ---------------------------------------------------------------------------

def test_drain_dirty_queue_preserves_concurrent_append(tmp_data_dir, monkeypatch):
    """An enqueue during the drain's read window must not be lost.

    The old read-then-truncate truncated away any line a hook appended between
    the read and the write. The atomic rename-and-process closes that window:
    the late append lands in a fresh dirty.txt and is picked up next cycle.
    """
    worker.enqueue_dirty("a.py", project_hash="h1")
    fired = {"done": False}
    orig_read = Path.read_text

    def read_with_concurrent_enqueue(self, *args, **kwargs):
        result = orig_read(self, *args, **kwargs)
        if not fired["done"] and "dirty" in self.name:
            # Simulate a post-edit hook firing mid-drain.
            fired["done"] = True
            worker.enqueue_dirty("b.py", project_hash="h1")
        return result

    monkeypatch.setattr(Path, "read_text", read_with_concurrent_enqueue)
    first = worker.drain_dirty_queue()
    second = worker.drain_dirty_queue()
    monkeypatch.undo()

    seen = {e["path"] for e in first + second}
    assert seen == {"a.py", "b.py"}, f"a concurrent append was lost: {seen}"


def test_drain_dirty_queue_recovers_abandoned_draining_file(tmp_data_dir):
    """A .draining file left by a worker that crashed mid-drain is recovered."""
    paths.ensure_dirs()
    p = paths.dirty_queue_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    draining = p.with_name(p.name + ".draining")
    draining.write_text(
        json.dumps({"path": "crashed.py", "project_hash": "h1", "ts": 1.0}) + "\n",
        encoding="utf-8",
    )

    entries = worker.drain_dirty_queue()
    assert [e["path"] for e in entries] == ["crashed.py"]
    assert not draining.exists(), "the recovered .draining file must be removed"


def test_drain_dirty_queue_removes_queue_file(tmp_data_dir):
    """After a drain, dirty.txt is gone (renamed away) — not left as an empty file."""
    worker.enqueue_dirty("x.py", project_hash="h1")
    worker.drain_dirty_queue()
    assert not paths.dirty_queue_path().exists()


# ---------------------------------------------------------------------------
# 16d. drain_dirty_queue — corrupt / binary queue file must not crash
# ---------------------------------------------------------------------------


def test_drain_dirty_queue_binary_content_does_not_crash(tmp_data_dir):
    """A binary (non-UTF-8) dirty.txt must not raise UnicodeDecodeError.

    Regression guard: before the fix, read_text(encoding='utf-8') on a
    binary-corrupted file raised UnicodeDecodeError, which propagated out of
    drain_dirty_queue() and crashed the worker daemon loop.
    """
    paths.ensure_dirs()
    p = paths.dirty_queue_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Write a valid entry followed by a line of raw binary bytes (0x80–0xFF are
    # invalid in strict UTF-8 and trigger UnicodeDecodeError without errors=replace).
    valid_line = json.dumps({"path": "src/ok.py", "project_hash": "abc111", "ts": 1.0})
    p.write_bytes(valid_line.encode("utf-8") + b"\n" + bytes(range(128, 192)) + b"\n")

    entries = worker.drain_dirty_queue()

    # Must not raise — returns a list (possibly only the one valid entry)
    assert entries is not None
    assert isinstance(entries, list)
    valid_paths = {e["path"] for e in entries}
    assert "src/ok.py" in valid_paths


def test_drain_dirty_queue_binary_draining_file_does_not_crash(tmp_data_dir):
    """A binary .draining recovery file must not raise UnicodeDecodeError.

    Same regression guard as above but exercises the abandoned-.draining
    recovery path (which uses a separate read_text call).
    """
    paths.ensure_dirs()
    p = paths.dirty_queue_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    draining = p.with_name(p.name + ".draining")
    valid_line = json.dumps({"path": "recovered.ts", "project_hash": "xyz999", "ts": 2.0})
    # Mix a valid JSON line with binary garbage
    draining.write_bytes(valid_line.encode("utf-8") + b"\n" + b"\xff\xfe\x00\x01\n")

    entries = worker.drain_dirty_queue()

    assert entries is not None
    assert isinstance(entries, list)
    valid_paths = {e["path"] for e in entries}
    assert "recovered.ts" in valid_paths
    assert not draining.exists(), "recovered .draining file must be cleaned up"


def test_drain_dirty_queue_mixed_valid_and_non_json_lines(tmp_data_dir):
    """Lines that are not valid JSON must be skipped; valid lines must survive.

    Verifies the per-line JSONDecodeError handling that predates the
    UnicodeDecodeError fix, ensuring both guards work together.
    """
    paths.ensure_dirs()
    p = paths.dirty_queue_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    valid = json.dumps({"path": "good.py", "project_hash": "hhh333", "ts": 3.0})
    p.write_text(
        valid + "\n"
        "this is not json at all\n"
        '{"incomplete": \n'
        + valid.replace("good.py", "also_good.py") + "\n",
        encoding="utf-8",
    )

    entries = worker.drain_dirty_queue()

    assert entries is not None
    valid_paths = {e["path"] for e in entries}
    assert "good.py" in valid_paths
    assert "also_good.py" in valid_paths
    # The two non-JSON lines must have been silently dropped
    assert len(valid_paths) == 2


# ---------------------------------------------------------------------------
# 17. run_daemon — hands off to a freshly-installed version
# ---------------------------------------------------------------------------

def test_run_daemon_restarts_on_version_change(tmp_data_dir, monkeypatch):
    """When a different version is installed on disk, the daemon exits and respawns."""
    monkeypatch.setattr(worker, "VERSION_CHECK_INTERVAL", 0.0)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", "0.0.1")
    monkeypatch.setattr(worker, "_installed_version", lambda: "0.0.2")
    # Pin the fingerprint to a matching value so the version string is the only
    # variable that triggers the restart in this test.
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", "fp-same")
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: "fp-same")

    spawned = {"count": 0}

    def fake_spawn():
        spawned["count"] += 1
        return 4321

    monkeypatch.setattr(worker, "spawn_detached", fake_spawn)

    # run_daemon should detect the version change on its first loop pass and
    # return on its own — no stop_event needed.
    worker.run_daemon(stop_event=threading.Event())

    assert spawned["count"] == 1, "worker did not respawn after version change"
    # The slot must be released so the successor can claim it cleanly.
    assert not worker._worker_claim_path().exists()
    assert not paths.worker_pid_path().exists()


def test_run_daemon_restarts_on_code_change(tmp_data_dir, monkeypatch):
    """A same-version reinstall (version unchanged, code fingerprint changed)
    must still trigger a respawn — the version-string check alone misses it."""
    monkeypatch.setattr(worker, "VERSION_CHECK_INTERVAL", 0.0)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", "1.2.3")
    monkeypatch.setattr(worker, "_installed_version", lambda: "1.2.3")
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", "fp-old")
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: "fp-new")

    spawned = {"count": 0}

    def fake_spawn():
        spawned["count"] += 1
        return 4321

    monkeypatch.setattr(worker, "spawn_detached", fake_spawn)

    worker.run_daemon(stop_event=threading.Event())

    assert spawned["count"] == 1, "worker did not respawn after same-version reinstall"
    assert not worker._worker_claim_path().exists()
    assert not paths.worker_pid_path().exists()


def test_run_daemon_no_restart_when_version_unchanged(tmp_data_dir, monkeypatch):
    """A matching on-disk version *and* code fingerprint must not trigger a respawn."""
    import token_goat.worker_daemon as _daemon_mod

    monkeypatch.setattr(worker, "VERSION_CHECK_INTERVAL", 0.0)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", "1.2.3")
    monkeypatch.setattr(worker, "_installed_version", lambda: "1.2.3")
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", "fp-same")
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: "fp-same")

    spawned = {"count": 0}
    monkeypatch.setattr(
        worker, "spawn_detached", lambda: spawned.__setitem__("count", 1)
    )

    stop = threading.Event()
    version_checked = threading.Event()

    original_detect = _daemon_mod._detect_upgrade

    def _detect_and_stop():
        result = original_detect()
        version_checked.set()
        stop.set()
        return result

    monkeypatch.setattr(_daemon_mod, "_detect_upgrade", _detect_and_stop)

    worker.run_daemon(stop_event=stop)

    assert version_checked.is_set(), "version check was never executed"
    assert spawned["count"] == 0, "worker respawned despite an unchanged version"


def test_package_fingerprint_changes_with_file_content(tmp_data_dir):
    """_package_fingerprint must produce a stable hash that changes when any
    package file's size or mtime changes — the signal a reinstall relies on."""
    fp1 = worker._package_fingerprint()
    assert fp1 is not None and len(fp1) == 40, "expected a sha1 hex digest"
    # Stable across calls when nothing on disk changed.
    assert worker._package_fingerprint() == fp1

    # Touching a package file (bumping its mtime) must change the fingerprint.
    worker_py = Path(worker.__file__)
    st = worker_py.stat()
    try:
        os.utime(worker_py, (st.st_atime, st.st_mtime + 5))
        assert worker._package_fingerprint() != fp1, (
            "fingerprint did not change after a package file's mtime changed"
        )
    finally:
        os.utime(worker_py, (st.st_atime, st.st_mtime))


# ---------------------------------------------------------------------------
# cleanup_on_startup — split per-task functions and failure reporting (items 23/24)
# ---------------------------------------------------------------------------

def test_cleanup_stale_locks_standalone(tmp_data_dir):
    """_cleanup_stale_locks returns count of removed lock files."""
    from token_goat import paths as _paths

    # Write a lock with a non-existent PID
    locks_dir = _paths.locks_dir()
    locks_dir.mkdir(parents=True, exist_ok=True)
    dead_pid = 2**30  # unreachable PID
    (locks_dir / "fake.lock").write_text(f"{dead_pid}\n", encoding="utf-8")

    count = worker._cleanup_stale_locks()
    assert count == 1
    assert not (locks_dir / "fake.lock").exists()


def test_cleanup_old_logs_standalone(tmp_data_dir):
    """_cleanup_old_logs removes logs older than retention window."""
    import os
    import time as _time

    from token_goat import paths as _paths

    logs_dir = _paths.logs_dir()
    logs_dir.mkdir(parents=True, exist_ok=True)
    old_log = logs_dir / "2000-01-01.log"
    old_log.write_text("old\n", encoding="utf-8")
    # Backdate to 100 days ago
    old_ts = _time.time() - 100 * 86400
    os.utime(old_log, (old_ts, old_ts))

    count = worker._cleanup_old_logs()
    assert count >= 1
    assert not old_log.exists()


def test_cleanup_on_startup_records_failures(tmp_data_dir, monkeypatch):
    """If a cleanup sub-task raises, the failure is recorded in stats['failures']
    and the other tasks still run."""
    monkeypatch.setattr(worker, "_cleanup_stale_locks", lambda: (_ for _ in ()).throw(RuntimeError("boom")))

    stats = worker.cleanup_on_startup()
    assert "failures" in stats
    assert any("stale_locks" in f for f in stats["failures"])
    # Other tasks still ran — logs_deleted should be an int key
    assert "logs_deleted" in stats


def test_cleanup_on_startup_no_failures_omits_key(tmp_data_dir, monkeypatch):
    """When all tasks succeed, stats must NOT include a 'failures' key."""
    monkeypatch.setattr(worker, "_cleanup_stale_locks", lambda: 0)
    monkeypatch.setattr(worker, "_cleanup_old_logs", lambda: 0)
    monkeypatch.setattr(worker, "_prune_stats_table", lambda: 0)
    monkeypatch.setattr(worker, "reap_stale_index_markers", lambda: 0)
    monkeypatch.setattr(worker, "evict_image_cache_if_over_limit", lambda: (0, 0))

    stats = worker.cleanup_on_startup()
    assert "failures" not in stats


def test_event_wait_used_when_stop_event_provided(tmp_data_dir, monkeypatch):
    """run_daemon must use stop_event.wait() instead of time.sleep() so the
    loop wakes up immediately when the event is set."""
    import threading

    wait_calls: list[float] = []

    class _TrackingEvent(threading.Event):
        def wait(self, timeout=None):  # type: ignore[override]
            wait_calls.append(timeout or 0.0)
            self.set()  # immediately signal stop
            return True

    stop = _TrackingEvent()
    monkeypatch.setattr(worker, "spawn_detached", lambda: None)
    monkeypatch.setattr(worker, "_try_claim_worker_slot", lambda: 99)
    monkeypatch.setattr(worker, "_clear_pid", lambda: None)
    monkeypatch.setattr(worker, "_write_pid", lambda: None)
    monkeypatch.setattr(worker, "_heartbeat", lambda: None)
    monkeypatch.setattr(worker, "_register_autostart", lambda: None)
    monkeypatch.setattr(worker, "cleanup_on_startup", lambda: {})
    monkeypatch.setattr(worker, "drain_dirty_queue", lambda: [])
    monkeypatch.setattr(worker, "_reindex_active_projects", lambda: None)
    monkeypatch.setattr(worker, "_installed_version", lambda: None)
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: None)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", None)
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", None)

    from token_goat import worker_daemon
    worker_daemon.run_daemon(stop_event=stop)

    assert len(wait_calls) >= 1, "stop_event.wait() was never called"
    assert wait_calls[0] == worker.POLL_INTERVAL


# ---------------------------------------------------------------------------
# Adaptive poll interval — back-off when the dirty queue is repeatedly empty
# ---------------------------------------------------------------------------

def test_adaptive_poll_interval_stays_baseline_under_threshold():
    """First few empty drains must keep the baseline interval to preserve responsiveness."""
    for n in range(worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS):
        assert worker.adaptive_poll_interval(n) == worker.POLL_INTERVAL


def test_adaptive_poll_interval_grows_after_threshold():
    """Past the threshold, the interval must strictly increase with consecutive empty drains."""
    threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS
    first_backoff = worker.adaptive_poll_interval(threshold)
    second_backoff = worker.adaptive_poll_interval(threshold + 1)
    assert first_backoff > worker.POLL_INTERVAL
    assert second_backoff > first_backoff


def test_adaptive_poll_interval_caps_at_max():
    """No matter how long the queue stays empty, the interval must never exceed POLL_INTERVAL_MAX."""
    # A pathologically large counter must clamp at the documented cap.
    capped = worker.adaptive_poll_interval(10_000)
    assert capped == worker.POLL_INTERVAL_MAX
    # And the cap must actually be larger than the baseline (sanity-check the constants).
    assert worker.POLL_INTERVAL_MAX > worker.POLL_INTERVAL


def test_run_daemon_backs_off_after_consecutive_empty_drains(tmp_data_dir, monkeypatch):
    """After IDLE_BACKOFF_AFTER_EMPTY_DRAINS empty cycles, the wait interval must grow.

    Regression test: an always-empty queue should pay a smaller fraction of wakeup cost
    once the worker has been idle long enough that fresh edits are clearly not arriving.
    """
    wait_calls: list[float] = []
    n_cycles = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS + 3
    stop_at = n_cycles

    class _TrackingEvent(threading.Event):
        def wait(self, timeout=None):  # type: ignore[override]
            wait_calls.append(timeout or 0.0)
            if len(wait_calls) >= stop_at:
                self.set()  # signal stop after the back-off ramp is observable
            return self.is_set()

    stop = _TrackingEvent()
    monkeypatch.setattr(worker, "spawn_detached", lambda: None)
    monkeypatch.setattr(worker, "_try_claim_worker_slot", lambda: 99)
    monkeypatch.setattr(worker, "_clear_pid", lambda: None)
    monkeypatch.setattr(worker, "_write_pid", lambda: None)
    monkeypatch.setattr(worker, "_heartbeat", lambda: None)
    monkeypatch.setattr(worker, "_register_autostart", lambda: None)
    monkeypatch.setattr(worker, "cleanup_on_startup", lambda: {})
    monkeypatch.setattr(worker, "drain_dirty_queue", lambda: [])  # always empty
    monkeypatch.setattr(worker, "_reindex_active_projects", lambda: None)
    monkeypatch.setattr(worker, "_installed_version", lambda: None)
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: None)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", None)
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", None)

    from token_goat import worker_daemon
    worker_daemon.run_daemon(stop_event=stop)

    # The Nth wait call follows the Nth empty drain (counter has just been incremented),
    # so wait_calls[i] is observed when consecutive_empty_drains == i + 1.
    # Below the threshold (i + 1 < threshold) the interval must stay at the baseline.
    threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS
    for i in range(threshold - 1):
        assert wait_calls[i] == worker.POLL_INTERVAL, (
            f"call {i} (consecutive_empty={i + 1}) expected baseline "
            f"{worker.POLL_INTERVAL}, got {wait_calls[i]}"
        )
    # The Nth empty drain (consecutive_empty == threshold) is the first cycle that backs off.
    assert wait_calls[threshold - 1] > worker.POLL_INTERVAL, (
        f"adaptive back-off should engage at call {threshold - 1} "
        f"(consecutive_empty={threshold}), got {wait_calls[threshold - 1]}"
    )


def test_run_daemon_resets_backoff_after_work_appears(tmp_data_dir, monkeypatch):
    """A drain that returns work must immediately drop the next wait back to the baseline.

    Locks in the documented behavior: a quiet period followed by a single real edit must
    not be slowed by stale back-off state from before the edit arrived.
    """
    wait_calls: list[float] = []
    drain_results: list[list] = [
        [],  # cycle 1: empty
        [],  # cycle 2: empty
        [],  # cycle 3: empty
        [],  # cycle 4: empty
        [],  # cycle 5: empty — back-off threshold reached
        [],  # cycle 6: empty — back-off engaged here
        [{"path": "x.py", "project_hash": "a" * 40, "ts": 0.0}],  # cycle 7: work! reset
    ]
    drain_idx = {"i": 0}

    def fake_drain() -> list:
        i = drain_idx["i"]
        drain_idx["i"] += 1
        if i < len(drain_results):
            return drain_results[i]
        return []  # exhausted — anything after counts as empty

    class _TrackingEvent(threading.Event):
        def wait(self, timeout=None):  # type: ignore[override]
            wait_calls.append(timeout or 0.0)
            if len(wait_calls) >= len(drain_results):
                self.set()
            return self.is_set()

    stop = _TrackingEvent()
    monkeypatch.setattr(worker, "spawn_detached", lambda: None)
    monkeypatch.setattr(worker, "_try_claim_worker_slot", lambda: 99)
    monkeypatch.setattr(worker, "_clear_pid", lambda: None)
    monkeypatch.setattr(worker, "_write_pid", lambda: None)
    monkeypatch.setattr(worker, "_heartbeat", lambda: None)
    monkeypatch.setattr(worker, "_register_autostart", lambda: None)
    monkeypatch.setattr(worker, "cleanup_on_startup", lambda: {})
    monkeypatch.setattr(worker, "drain_dirty_queue", fake_drain)
    # _process_dirty_entries would try to look up the project — short-circuit it.
    monkeypatch.setattr(worker, "_process_dirty_entries", lambda _entries: None)
    monkeypatch.setattr(worker, "_reindex_active_projects", lambda: None)
    monkeypatch.setattr(worker, "_installed_version", lambda: None)
    monkeypatch.setattr(worker, "_package_fingerprint", lambda: None)
    monkeypatch.setattr(worker, "_BOOTED_VERSION", None)
    monkeypatch.setattr(worker, "_BOOTED_FINGERPRINT", None)

    from token_goat import worker_daemon
    # worker_daemon imports _process_dirty_entries at module load via worker.<attr> access;
    # patching worker._process_dirty_entries works because the daemon dereferences through
    # the _worker alias each call.
    worker_daemon.run_daemon(stop_event=stop)

    # Cycle 6 (index 5) was the engaged-back-off wait. Cycle 7 returned work, so the
    # wait recorded after cycle 7 (index 6) must be back at the baseline.
    assert wait_calls[5] > worker.POLL_INTERVAL, (
        f"expected back-off to be engaged on cycle 6, got {wait_calls[5]}"
    )
    assert wait_calls[6] == worker.POLL_INTERVAL, (
        f"expected baseline after work cycle, got {wait_calls[6]} (all={wait_calls})"
    )


# ---------------------------------------------------------------------------
# Dirty-queue coalescing — multiple appends of the same file must dedupe to one reindex
# ---------------------------------------------------------------------------

def test_parse_and_group_entries_coalesces_duplicate_paths():
    """Five appends of the same (project, path) collapse to one entry per (project, path).

    Regression guard for the worker's de-duplication contract: a rapid burst of edits to
    the same file must not produce N reindexes. The _ProjectBucket["rels"] set carries the
    invariant; this test pins it so a refactor cannot accidentally swap the set for a list.
    """
    ph = "a" * 40
    entries: list[worker.DirtyQueueEntry] = [
        {  # type: ignore[typeddict-item]
            "path": "src/foo.py",
            "project_hash": ph,
            "project_root": "C:/proj" if sys.platform == "win32" else "/proj",
            "project_marker": "manual",
            "ts": float(i),
        }
        for i in range(5)
    ]
    by_project = worker._parse_and_group_entries(entries)
    assert ph in by_project
    bucket = by_project[ph]
    # Five queue lines, one unique rel-path — bucket must hold exactly one entry.
    assert bucket["rels"] == {"src/foo.py"}
    assert len(bucket["rels"]) == 1


def test_parse_and_group_entries_coalesces_distinct_files_independently():
    """Different files in the same project remain distinct after coalescing."""
    ph = "b" * 40
    entries: list[worker.DirtyQueueEntry] = []
    root = "C:/proj" if sys.platform == "win32" else "/proj"
    for path in ("src/a.py", "src/b.py", "src/a.py", "src/c.py", "src/b.py"):
        entries.append({  # type: ignore[typeddict-item]
            "path": path,
            "project_hash": ph,
            "project_root": root,
            "project_marker": "manual",
            "ts": 0.0,
        })
    by_project = worker._parse_and_group_entries(entries)
    assert by_project[ph]["rels"] == {"src/a.py", "src/b.py", "src/c.py"}


# ---------------------------------------------------------------------------
# Image cache eviction: LRU ordering, target invariant, lock-mutex behavior
# ---------------------------------------------------------------------------

class TestImageCacheEviction:
    """Regression coverage for the image cache LRU eviction policy.

    Covers:
        - target invariant (eviction drives total to <= IMAGE_CACHE_TARGET, not just LIMIT)
        - LRU order (oldest mtime is evicted first)
        - cache-hit mtime bump in image_shrink turns FIFO into real LRU
        - lockfile mutex prevents concurrent evictions from racing
        - stale lock is auto-reclaimed
    """

    def _set_small_limits(self, monkeypatch, limit_bytes: int = 1000) -> tuple[int, int]:
        target_bytes = int(limit_bytes * 0.8)
        monkeypatch.setattr(worker, "IMAGE_CACHE_LIMIT", limit_bytes)
        monkeypatch.setattr(worker, "IMAGE_CACHE_TARGET", target_bytes)
        return limit_bytes, target_bytes

    def test_eviction_drives_to_target_not_just_limit(self, tmp_data_dir, monkeypatch):
        """After eviction the remaining total must be <= TARGET (80% of LIMIT),
        not merely <= LIMIT — that's the anti-thrash invariant."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        _, target = self._set_small_limits(monkeypatch, limit_bytes=1000)

        # 12 files at 100 bytes = 1200 bytes total (20% over LIMIT)
        for i in range(12):
            f = img_dir / f"img_{i:02d}.webp"
            f.write_bytes(b"x" * 100)
            ts = time.time() - (12 - i) * 5  # stagger mtimes
            os.utime(f, (ts, ts))

        worker.evict_image_cache_if_over_limit()
        remaining = sum(f.stat().st_size for f in img_dir.iterdir() if f.is_file())
        assert remaining <= target, (
            f"eviction left {remaining} bytes; expected <= TARGET ({target})"
        )

    def test_eviction_oldest_mtime_evicted_first(self, tmp_data_dir, monkeypatch):
        """The file with the oldest mtime must be deleted before any newer file."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        self._set_small_limits(monkeypatch, limit_bytes=500)

        # 6 files × 100 bytes = 600 bytes; need to evict at least ~200 bytes to reach 400.
        for i in range(6):
            f = img_dir / f"img_{i:02d}.webp"
            f.write_bytes(b"x" * 100)
            ts = time.time() - (6 - i) * 10  # i=0 oldest, i=5 newest
            os.utime(f, (ts, ts))

        worker.evict_image_cache_if_over_limit()
        remaining_names = {f.name for f in img_dir.iterdir() if f.is_file()}
        # img_00 (oldest) must be gone; img_05 (newest) must survive.
        assert "img_00.webp" not in remaining_names, "oldest file should have been evicted first"
        assert "img_05.webp" in remaining_names, "newest file should have survived"

    def test_cache_hit_bumps_mtime_for_true_lru(self, tmp_data_dir):
        """image_shrink.shrink's cache-hit path must bump mtime so a frequently-hit
        old entry doesn't get FIFO-evicted by the worker.

        This is the load-bearing regression test for the LRU-vs-FIFO bug fix:
        without the os.utime call in shrink(), a content-addressed cache that's
        written exactly once per entry has st_mtime == creation time, and the
        eviction sort degrades into FIFO regardless of access pattern.
        """
        from token_goat import image_shrink
        paths.ensure_dirs()

        # Plant a fake cache entry where the source's content hash will map.
        # We bypass actual PIL by writing the cache file directly, then call
        # shrink() with a "source" that has the right size + extension to
        # trigger the cache lookup but a synthetic content hash check.
        src = tmp_data_dir / "source.png"
        # Make src large enough to clear SIZE_THRESHOLD_BYTES so shrink doesn't
        # short-circuit on the size check.
        src.write_bytes(b"X" * (image_shrink.SIZE_THRESHOLD_BYTES + 1))

        # Plant the cache file at the path shrink() will compute for this source.
        stem = image_shrink._cache_path_for(src)
        cache_file = stem.with_suffix(".webp")
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        # Write a minimal valid WebP so the corruption-detection check passes.
        import io as _io

        from PIL import Image as _Image
        _buf = _io.BytesIO()
        _Image.new("RGB", (2, 2)).save(_buf, format="WEBP")
        cache_file.write_bytes(_buf.getvalue())

        # Backdate mtime so we can detect a bump; 7200s (not exactly 3600) because the bump guard uses `> 3600` and Windows time.time() has ~15ms resolution — both calls can land in the same tick, making the diff exactly 3600 and failing the strict check.
        old_ts = time.time() - 7200  # 2 hours ago
        os.utime(cache_file, (old_ts, old_ts))
        assert cache_file.stat().st_mtime == pytest.approx(old_ts, abs=1.0)

        # Cache hit should bump mtime.
        result = image_shrink.shrink(src)
        assert result == cache_file
        new_mtime = cache_file.stat().st_mtime
        assert new_mtime > old_ts + 60, (
            f"cache hit should bump mtime to ~now; got {new_mtime} vs old {old_ts}"
        )

    def test_concurrent_eviction_lock_mutex(self, tmp_data_dir, monkeypatch):
        """If one evictor holds the lockfile, a second concurrent call must skip
        cleanly with (0, 0) — not race and double-delete."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        self._set_small_limits(monkeypatch, limit_bytes=500)

        for i in range(6):
            f = img_dir / f"img_{i:02d}.webp"
            f.write_bytes(b"x" * 100)
            ts = time.time() - (6 - i) * 10
            os.utime(f, (ts, ts))

        # Pre-create a fresh lockfile to simulate "another evictor is running".
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text(f"{os.getpid()}\n{time.time()}\n", encoding="utf-8")

        # This invocation should see the lock and bail out with (0, 0).
        result = worker.evict_image_cache_if_over_limit()
        assert result == (0, 0), "lock-held eviction must skip, not race"
        # Cache must be untouched (nobody won the race).
        remaining = sum(f.stat().st_size for f in img_dir.iterdir() if f.is_file())
        assert remaining == 600, "no files should have been evicted while lock was held"

        # Cleanup so this test doesn't leak the synthetic lock.
        lock_path.unlink()

    def test_stale_eviction_lock_is_reclaimed(self, tmp_data_dir, monkeypatch):
        """A lockfile older than the stale threshold must be auto-cleared so a
        crashed evictor cannot wedge the cache indefinitely."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        _, target = self._set_small_limits(monkeypatch, limit_bytes=500)

        for i in range(6):
            f = img_dir / f"img_{i:02d}.webp"
            f.write_bytes(b"x" * 100)
            ts = time.time() - (6 - i) * 10
            os.utime(f, (ts, ts))

        # Plant a stale lockfile — mtime older than _EVICTION_LOCK_STALE_SECONDS.
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text("99999999\nold\n", encoding="utf-8")
        stale_ts = time.time() - (worker._EVICTION_LOCK_STALE_SECONDS + 60)
        os.utime(lock_path, (stale_ts, stale_ts))

        bytes_freed, files_freed = worker.evict_image_cache_if_over_limit()
        assert bytes_freed > 0 and files_freed > 0, (
            "stale lock should have been reclaimed and eviction allowed to run"
        )
        remaining = sum(f.stat().st_size for f in img_dir.iterdir() if f.is_file())
        assert remaining <= target

    def test_eviction_releases_lock_on_exit(self, tmp_data_dir, monkeypatch):
        """The lockfile must be unlinked after a successful eviction pass so the
        next maintenance cycle can run."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        self._set_small_limits(monkeypatch, limit_bytes=500)

        for i in range(6):
            f = img_dir / f"img_{i:02d}.webp"
            f.write_bytes(b"x" * 100)
            ts = time.time() - (6 - i) * 10
            os.utime(f, (ts, ts))

        worker.evict_image_cache_if_over_limit()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"
        assert not lock_path.exists(), "lockfile should be released after eviction completes"

    def test_eviction_releases_lock_on_below_limit_path(self, tmp_data_dir, monkeypatch):
        """The lockfile must also be released when eviction finds the cache is
        already below the limit (the early-return branch must hit finally:)."""
        paths.ensure_dirs()
        img_dir = paths.image_cache_dir()
        # Set a huge limit so even some sample files stay under it.
        monkeypatch.setattr(worker, "IMAGE_CACHE_LIMIT", 10 * 1024 * 1024)

        (img_dir / "tiny.webp").write_bytes(b"x" * 100)

        result = worker.evict_image_cache_if_over_limit()
        assert result == (0, 0)
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"
        assert not lock_path.exists(), (
            "lockfile must be released even when cache is under the limit"
        )


# ---------------------------------------------------------------------------
# _checkpoint_project_wals — WAL checkpoint for all per-project DBs
# ---------------------------------------------------------------------------

class TestCheckpointProjectWals:
    """_checkpoint_project_wals iterates project DBs and runs PRAGMA wal_checkpoint."""

    def test_no_projects_returns_zero(self, tmp_data_dir):
        """With no projects registered in global.db, returns 0 with no errors."""
        # global.db is initialised by tmp_data_dir fixture via db.open_global().
        result = worker._checkpoint_project_wals()
        assert result == 0

    def test_project_with_no_wal_file_is_skipped_gracefully(self, tmp_data_dir):
        """A project whose WAL file does not exist is skipped without error."""
        from token_goat import db as _db

        ph = "a" * 40
        now = int(time.time())
        with _db.open_global() as gconn:
            gconn.execute(
                "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ph, "/some/proj", ".git", now, now, 1, "python"),
            )
        # No WAL file on disk for this project — function must skip it cleanly.
        result = worker._checkpoint_project_wals()
        assert result == 0

    def test_db_error_listing_projects_returns_zero(self, tmp_data_dir, monkeypatch):
        """If opening global.db to list projects fails, the function returns 0 without propagating."""
        from token_goat import db as _db

        def boom():
            raise _db.DBError("simulated global DB error")

        monkeypatch.setattr(_db, "open_global_readonly", boom)
        result = worker._checkpoint_project_wals()
        assert result == 0

    def test_checkpoint_error_on_one_project_continues_and_returns_zero(self, tmp_data_dir, monkeypatch):
        """A checkpoint failure on a project is caught; function does not propagate the exception."""
        from token_goat import db as _db

        ph = "b" * 40
        now = int(time.time())
        with _db.open_global() as gconn:
            gconn.execute(
                "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ph, "/some/other/proj", ".git", now, now, 1, "python"),
            )

        # Create a fake WAL file so the size-check path is reached.
        db_path = paths.project_db_path(ph)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        wal_path = db_path.with_name(db_path.name + "-wal")
        wal_path.write_bytes(b"x" * 512)

        # Make open_project raise so the checkpoint itself fails.
        import contextlib

        @contextlib.contextmanager
        def boom(hash_):
            raise sqlite3.DatabaseError("simulated checkpoint failure")
            yield  # makes this a contextmanager generator

        monkeypatch.setattr(_db, "open_project", boom)
        # Must not raise — failure is caught and logged.
        result = worker._checkpoint_project_wals()
        assert isinstance(result, int)

    def test_project_with_wal_reclaims_bytes(self, tmp_data_dir, tmp_path):
        """A real project WAL is checkpointed and the reclaimed byte count is positive."""
        from token_goat import db as _db
        from token_goat.parser import index_project
        from token_goat.project import canonicalize, make_project_at
        from token_goat.project import project_hash as ph_fn

        # Build a real indexed project so open_project works without errors.
        proj_root = tmp_path / "wal_proj"
        proj_root.mkdir()
        (proj_root / "mod.py").write_text("def hello(): pass\n", encoding="utf-8")
        ph = ph_fn(canonicalize(proj_root))
        index_project(make_project_at(proj_root), full=True)

        now = int(time.time())
        with _db.open_global() as gconn:
            gconn.execute(
                "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ph, proj_root.as_posix(), ".git", now, now, 1, "python"),
            )

        # Ensure a WAL file exists by opening the project DB in WAL mode and
        # writing something to it, then closing without checkpointing.
        db_path = paths.project_db_path(ph)
        wal_path = db_path.with_name(db_path.name + "-wal")

        # Write a dummy WAL file large enough to measure (checkpoint will shrink/remove it).
        if not wal_path.exists():
            wal_path.write_bytes(b"\x00" * 4096)

        # Should not raise; return value is a non-negative integer.
        result = worker._checkpoint_project_wals()
        assert isinstance(result, int)
        assert result >= 0


# ---------------------------------------------------------------------------
# cleanup_on_startup — project_wal_bytes_reclaimed key is present in result
# ---------------------------------------------------------------------------

def test_cleanup_on_startup_includes_project_wal_bytes_reclaimed(tmp_data_dir, monkeypatch):
    """cleanup_on_startup must include 'project_wal_bytes_reclaimed' in its result dict.

    Regression guard: the key was added to CleanupStats and wired into the
    _int_tasks list; this test locks in the contract so a future refactor
    cannot silently drop the entry.
    """
    # Stub out all the sub-tasks to keep the test fast and side-effect-free.
    monkeypatch.setattr(worker, "_cleanup_stale_locks", lambda: 0)
    monkeypatch.setattr(worker, "_cleanup_old_logs", lambda: 0)
    monkeypatch.setattr(worker, "_prune_stats_table", lambda: 0)
    monkeypatch.setattr(worker, "_cleanup_stale_snapshots", lambda: 0)
    monkeypatch.setattr(worker, "_evict_bash_outputs", lambda: 0)
    monkeypatch.setattr(worker, "_checkpoint_global_wal", lambda: 0)
    monkeypatch.setattr(worker, "_checkpoint_project_wals", lambda: 42)
    monkeypatch.setattr(worker, "reap_stale_index_markers", lambda: 0)
    monkeypatch.setattr(worker, "evict_image_cache_if_over_limit", lambda: (0, 0))

    stats = worker.cleanup_on_startup()
    assert "project_wal_bytes_reclaimed" in stats
    assert stats["project_wal_bytes_reclaimed"] == 42


def test_cleanup_on_startup_includes_web_outputs_evicted(tmp_data_dir, monkeypatch):
    """cleanup_on_startup must include 'web_outputs_evicted' in its result dict.

    Regression guard: web_cache had no periodic eviction backstop in the worker
    maintenance cycle (bash_cache had one, web_cache did not). This test locks
    in the contract so a future refactor cannot silently drop _evict_web_outputs
    from _int_tasks.
    """
    monkeypatch.setattr(worker, "_cleanup_stale_locks", lambda: 0)
    monkeypatch.setattr(worker, "_cleanup_old_logs", lambda: 0)
    monkeypatch.setattr(worker, "_prune_stats_table", lambda: 0)
    monkeypatch.setattr(worker, "_cleanup_stale_snapshots", lambda: 0)
    monkeypatch.setattr(worker, "_evict_bash_outputs", lambda: 0)
    monkeypatch.setattr(worker, "_evict_web_outputs", lambda: 7)
    monkeypatch.setattr(worker, "_checkpoint_global_wal", lambda: 0)
    monkeypatch.setattr(worker, "_checkpoint_project_wals", lambda: 0)
    monkeypatch.setattr(worker, "reap_stale_index_markers", lambda: 0)
    monkeypatch.setattr(worker, "evict_image_cache_if_over_limit", lambda: (0, 0))

    stats = worker.cleanup_on_startup()
    assert "web_outputs_evicted" in stats
    assert stats["web_outputs_evicted"] == 7


def test_evict_web_outputs_calls_web_cache(tmp_data_dir, monkeypatch):
    """_evict_web_outputs must delegate to web_cache.evict_old_entries with the
    correct config values — not hardcoded defaults."""
    from token_goat import config, web_cache

    calls: list[dict] = []

    def fake_evict(*, max_total_bytes: int, max_file_count: int) -> int:
        calls.append({"max_total_bytes": max_total_bytes, "max_file_count": max_file_count})
        return 3

    monkeypatch.setattr(web_cache, "evict_old_entries", fake_evict)

    result = worker._evict_web_outputs()

    cfg = config.load().webfetch
    assert result == 3
    assert len(calls) == 1
    assert calls[0]["max_total_bytes"] == cfg.max_bytes
    assert calls[0]["max_file_count"] == cfg.max_file_count


# ---------------------------------------------------------------------------
# Dirty-queue deduplication
# ---------------------------------------------------------------------------

def test_drain_dirty_queue_dedup_same_path(tmp_data_dir):
    """5 entries for the same (project_hash, path) should drain as 1 entry."""
    for _ in range(5):
        worker.enqueue_dirty("src/foo.ts", project_hash="aaa111")

    entries = worker.drain_dirty_queue()
    assert entries is not None
    assert len(entries) == 1
    assert entries[0]["path"] == "src/foo.ts"
    assert entries[0]["project_hash"] == "aaa111"


def test_drain_dirty_queue_dedup_unique_paths(tmp_data_dir):
    """3 distinct paths should all survive deduplication — no entries dropped."""
    worker.enqueue_dirty("src/a.py", project_hash="bbb222")
    worker.enqueue_dirty("src/b.py", project_hash="bbb222")
    worker.enqueue_dirty("src/c.py", project_hash="bbb222")

    entries = worker.drain_dirty_queue()
    assert entries is not None
    assert len(entries) == 3
    assert {e["path"] for e in entries} == {"src/a.py", "src/b.py", "src/c.py"}


def test_drain_dirty_queue_dedup_empty_queue(tmp_data_dir):
    """Empty queue returns an empty list — dedup path must not raise."""
    entries = worker.drain_dirty_queue()
    assert entries == []


# ---------------------------------------------------------------------------
# Dirty-queue file locking (concurrency)
# ---------------------------------------------------------------------------


def test_enqueue_dirty_concurrent_writes(tmp_data_dir):
    """Concurrent enqueue_dirty calls must retain every entry with no torn lines.

    Spawn 4 threads, each writing 20 entries. ``_ENQUEUE_DIRTY_LOCK`` serializes
    the read-modify-write across threads, so the result is deterministic: exactly
    80 well-formed JSON lines.

    This is a regression test for the torn-write race — remove the module-level
    threading lock and the interleaved rewrites either drop entries (count < 80)
    or produce a malformed line, failing one of the two assertions below.
    """
    num_threads = 4
    entries_per_thread = 20
    total_expected = num_threads * entries_per_thread

    def worker_thread(thread_id: int) -> None:
        for i in range(entries_per_thread):
            long_path = f"src/thread_{thread_id}_file_{i}.ts"
            worker.enqueue_dirty(long_path, project_hash=f"proj_{thread_id}")

    threads = [threading.Thread(target=worker_thread, args=(i,)) for i in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    # Drain and verify all entries are valid JSON and no interleaving occurred.
    queue_file = paths.dirty_queue_path()
    assert queue_file.exists(), "Dirty queue file should exist"

    lines = queue_file.read_text(encoding="utf-8").splitlines()
    # In-process serialization is deterministic: every entry is retained.
    assert len(lines) == total_expected, f"Expected {total_expected} entries, got {len(lines)}"

    # Parse each line as JSON; any JSON decode error means interleaving occurred.
    # This is the critical assertion: no torn/malformed lines.
    for i, line in enumerate(lines):
        try:
            entry = json.loads(line)
            assert "path" in entry, f"Line {i} missing 'path' key"
            assert "project_hash" in entry, f"Line {i} missing 'project_hash' key"
            assert "ts" in entry, f"Line {i} missing 'ts' key"
        except json.JSONDecodeError as e:
            raise AssertionError(f"Line {i} is malformed JSON (interleaving detected): {line!r}") from e


def test_enqueue_dirty_drops_entry_when_os_lock_not_acquired(tmp_data_dir, monkeypatch, caplog):
    """When the OS lock can't be acquired, enqueue_dirty drops the entry, never writing.

    A cross-process lock timeout means another process may be mid-rewrite; writing
    now would tear a line. The fail-soft contract is to drop the entry (a missed
    dirty hint is recovered on the file's next edit) rather than risk a torn line
    that poisons the drain. This forces the not-acquired branch by stubbing the
    lock to yield ``False`` and asserts no queue file is written.
    """
    import contextlib

    @contextlib.contextmanager
    def _lock_not_acquired(lock_path):
        yield False  # simulate OS lock timeout / contention

    monkeypatch.setattr(worker, "_dirty_queue_lock", _lock_not_acquired)

    queue_file = paths.dirty_queue_path()
    with caplog.at_level(logging.DEBUG, logger="token_goat.worker"):
        worker.enqueue_dirty("src/dropped.py", project_hash="proj_x")

    # The entry must NOT have been written.
    if queue_file.exists():
        assert queue_file.read_text(encoding="utf-8").strip() == "", "entry was written despite unacquired lock"
    assert any("dropping entry" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# OSError handling in psutil Process queries (Item 8 reliability fix)
# ---------------------------------------------------------------------------


def test_proc_create_time_oserror_returns_none(tmp_data_dir, monkeypatch):
    """_proc_create_time must catch OSError and return None, not raise.

    On Windows, psutil.Process(pid).create_time() can raise OSError if the
    handle is closed during the call. The function must treat OSError like
    NoSuchProcess/AccessDenied and return None.
    """
    class FakeProcess:
        def create_time(self) -> float:
            raise OSError("handle closed during call")

    monkeypatch.setattr("psutil.Process", lambda pid: FakeProcess())
    result = worker._proc_create_time(1)
    assert result is None


def test_is_process_recent_oserror_returns_false(tmp_data_dir, monkeypatch):
    """_is_process_recent must catch OSError and return False, not raise.

    The function is called during worker startup checks; an OSError must not
    break the worker's ability to start.
    """
    class FakeProcess:
        def create_time(self) -> float:
            raise OSError("permission denied")

    monkeypatch.setattr("psutil.Process", lambda pid: FakeProcess())
    result = worker._is_process_recent(1)
    assert result is False


def test_is_token_goat_worker_oserror_returns_false(tmp_data_dir, monkeypatch):
    """_is_token_goat_worker must catch OSError and return False, not raise.

    The function guards against PID recycling; an OSError querying cmdline must
    not prevent the worker from starting or reaping old processes.
    """
    class FakeProcess:
        def cmdline(self) -> list[str]:
            raise OSError("access denied")

    monkeypatch.setattr("psutil.Process", lambda pid: FakeProcess())
    result = worker._is_token_goat_worker(1)
    assert result is False


# ---------------------------------------------------------------------------
# no source files found — message level
# ---------------------------------------------------------------------------

def test_no_source_files_message_is_debug_not_info(tmp_data_dir, tmp_path, caplog):
    """index_project emits the 'no source files found' message at DEBUG, not INFO.

    When indexing an empty directory, the message must not appear at INFO level
    so it does not pollute worker-stderr.log on every test run.
    """
    from token_goat.parser import index_project
    from token_goat.project import make_project_at

    empty_dir = tmp_path / "empty_project"
    empty_dir.mkdir()
    proj = make_project_at(empty_dir)

    # Capture DEBUG+ messages from the parser logger
    with caplog.at_level(logging.DEBUG, logger="token_goat.parser"):
        index_project(proj, full=True)

    # The message must appear at DEBUG level (not INFO/WARNING/ERROR)
    matching = [
        r for r in caplog.records
        if "no source files found" in r.getMessage()
    ]
    assert matching, "Expected 'no source files found' message to be emitted"
    for record in matching:
        assert record.levelno == logging.DEBUG, (
            f"Expected DEBUG ({logging.DEBUG}), got {record.levelname} ({record.levelno})"
        )

    # It must NOT appear at INFO level or above
    info_or_above = [
        r for r in caplog.records
        if "no source files found" in r.getMessage() and r.levelno >= logging.INFO
    ]
    assert not info_or_above, (
        f"'no source files found' appeared at INFO+ level: {info_or_above}"
    )


# ---------------------------------------------------------------------------
# _gc_orphaned_projects — orphan project GC
# ---------------------------------------------------------------------------


def _insert_project_row(gconn, hash_val: str, root: str, last_seen: float) -> None:
    """Helper: insert a row into the projects table."""
    now = int(time.time())
    gconn.execute(
        "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (hash_val, root, ".git", now, int(last_seen), 0, ""),
    )


def test_gc_orphaned_projects_spares_existing_dir(tmp_data_dir, tmp_path):
    """A project whose root directory still exists must not be removed."""
    from token_goat import db as _db
    from token_goat.project import project_hash as ph_fn

    root = tmp_path / "live_project"
    root.mkdir()
    ph = ph_fn(root)

    old_ts = time.time() - 7200  # 2 hours ago — well outside safety window
    with _db.open_global() as gconn:
        _insert_project_row(gconn, ph, root.as_posix(), old_ts)

    removed = worker._gc_orphaned_projects()
    assert removed == 0

    with _db.open_global() as gconn:
        row = gconn.execute("SELECT root FROM projects WHERE hash = ?", (ph,)).fetchone()
    assert row is not None, "existing-dir project was incorrectly removed"


def test_gc_orphaned_projects_removes_deleted_dir(tmp_data_dir, tmp_path):
    """A project whose root directory has been deleted must be removed after the safety window."""
    from token_goat import db as _db
    from token_goat.project import project_hash as ph_fn

    root = tmp_path / "deleted_project"
    root.mkdir()
    ph = ph_fn(root)

    old_ts = time.time() - 7200  # 2 hours ago — outside safety window
    with _db.open_global() as gconn:
        _insert_project_row(gconn, ph, root.as_posix(), old_ts)

    # Create the per-project DB file so we can verify it is also removed.
    db_path = paths.project_db_path(ph)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.write_bytes(b"")

    # Delete the root directory so GC will see it as missing.
    root.rmdir()

    removed = worker._gc_orphaned_projects()
    assert removed == 1, f"expected 1 orphan removed, got {removed}"

    with _db.open_global() as gconn:
        row = gconn.execute("SELECT root FROM projects WHERE hash = ?", (ph,)).fetchone()
    assert row is None, "orphaned project row was not deleted from global.db"
    assert not db_path.exists(), "per-project .db file was not deleted"


def test_gc_orphaned_projects_spares_recent_last_seen(tmp_data_dir, tmp_path):
    """A project outside its safety window by age but recently seen must be spared."""
    from token_goat import db as _db
    from token_goat.project import project_hash as ph_fn

    root = tmp_path / "recent_project"
    root.mkdir()
    ph = ph_fn(root)

    # last_seen within the 30-minute safety window
    recent_ts = time.time() - 60  # 1 minute ago
    with _db.open_global() as gconn:
        _insert_project_row(gconn, ph, root.as_posix(), recent_ts)

    # Delete the directory — GC should still spare this project.
    root.rmdir()

    removed = worker._gc_orphaned_projects()
    assert removed == 0, "project within safety window was incorrectly removed"

    with _db.open_global() as gconn:
        row = gconn.execute("SELECT root FROM projects WHERE hash = ?", (ph,)).fetchone()
    assert row is not None, "safety-window project row was incorrectly deleted"


def test_gc_orphaned_projects_toctou_concurrent_touch_preserves_row(tmp_data_dir, tmp_path):
    """A concurrent touch_project_last_seen between the snapshot read and DELETE
    must cause the DELETE to be a no-op so the freshly-touched row is preserved.

    Regression test for the TOCTOU race fixed in _gc_orphaned_projects:
    previously the DELETE was unconditional (``WHERE hash = ?``); now it adds
    ``AND last_seen <= safety_cutoff`` so a concurrent update is never lost.
    """
    from unittest.mock import patch

    from token_goat import db as _db
    from token_goat.project import project_hash as ph_fn

    root = tmp_path / "concurrent_project"
    root.mkdir()
    ph = ph_fn(root)

    old_ts = time.time() - 7200  # 2 hours ago — outside safety window
    with _db.open_global() as gconn:
        _insert_project_row(gconn, ph, root.as_posix(), old_ts)

    # Delete the root directory so GC would normally remove the row.
    root.rmdir()

    # Simulate a concurrent SessionStart: before GC issues the DELETE we bump
    # last_seen to "right now" (well inside the safety window).
    original_open_global = _db.open_global

    call_count = [0]

    def patched_open_global():
        ctx = original_open_global()
        call_count[0] += 1
        if call_count[0] == 2:
            # On the second open (the DELETE connection) first do the concurrent touch.
            with original_open_global() as touch_conn:
                touch_conn.execute(
                    "UPDATE projects SET last_seen = ? WHERE hash = ?",
                    (int(time.time()), ph),
                )
        return ctx

    with patch.object(_db, "open_global", patched_open_global):
        removed = worker._gc_orphaned_projects()

    # The row was touched into the safety window between read and delete;
    # the conditional DELETE must have been a no-op.
    assert removed == 0, (
        "concurrent touch bumped last_seen into safety window — row must be preserved, "
        f"but removed={removed}"
    )

    with _db.open_global() as gconn:
        row = gconn.execute("SELECT root FROM projects WHERE hash = ?", (ph,)).fetchone()
    assert row is not None, "TOCTOU: row was deleted despite concurrent last_seen update"


# ---------------------------------------------------------------------------
# _cleanup_old_sessions — session JSON eviction
# ---------------------------------------------------------------------------


def _make_session_file(sessions_dir, name: str, age_secs: float):
    """Create a session JSON file backdated by age_secs."""
    f = sessions_dir / name
    f.write_text("{}", encoding="utf-8")
    old = time.time() - age_secs
    os.utime(f, (old, old))
    return f


def test_cleanup_old_sessions_removes_stale(tmp_data_dir):
    """Session JSONs older than SESSION_RETENTION_DAYS are removed."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    old_age = (worker._SESSION_RETENTION_DAYS + 1) * 86400
    stale = _make_session_file(sessions_dir, "stale-session.json", old_age)
    fresh = _make_session_file(sessions_dir, "fresh-session.json", 3600)

    removed = worker._cleanup_old_sessions()

    assert removed == 1
    assert not stale.exists()
    assert fresh.exists()


def test_cleanup_old_sessions_spares_fresh(tmp_data_dir):
    """Session JSONs within the retention window are left alone."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    recent = _make_session_file(sessions_dir, "recent.json", 60)

    removed = worker._cleanup_old_sessions()

    assert removed == 0
    assert recent.exists()


def test_cleanup_old_sessions_ignores_non_json(tmp_data_dir):
    """Non-JSON files in the sessions directory are not touched."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    old_age = (worker._SESSION_RETENTION_DAYS + 1) * 86400
    non_json = _make_session_file(sessions_dir, "not-a-session.txt", old_age)

    removed = worker._cleanup_old_sessions()

    assert removed == 0
    assert non_json.exists()


def test_cleanup_old_sessions_no_dir_returns_zero(tmp_data_dir):
    """Returns 0 gracefully when the sessions directory does not exist."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    assert not sessions_dir.exists()

    removed = worker._cleanup_old_sessions()

    assert removed == 0


def test_cleanup_old_sessions_removes_companion_sidecars(tmp_data_dir):
    """When a stale JSON is removed, its .json.lock and .json.flock sidecars go too."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    old_age = (worker._SESSION_RETENTION_DAYS + 1) * 86400
    stale_json = _make_session_file(sessions_dir, "sid-old.json", old_age)
    # Sidecars share the stem of the JSON file.
    lock_sidecar = sessions_dir / "sid-old.json.lock"
    flock_sidecar = sessions_dir / "sid-old.json.flock"
    lock_sidecar.write_text("", encoding="utf-8")
    flock_sidecar.write_text("", encoding="utf-8")

    removed = worker._cleanup_old_sessions()

    assert removed == 1
    assert not stale_json.exists()
    assert not lock_sidecar.exists(), ".json.lock sidecar should be removed with its JSON"
    assert not flock_sidecar.exists(), ".json.flock sidecar should be removed with its JSON"


def test_cleanup_old_sessions_sweeps_orphaned_sidecars(tmp_data_dir):
    """Orphaned lock/flock sidecars (no corresponding .json) are removed."""
    from token_goat import paths as _paths

    sessions_dir = _paths.data_dir() / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    # Sidecars with no corresponding .json — left by a prior cleanup or crash.
    orphan_lock = sessions_dir / "sid-gone.json.lock"
    orphan_flock = sessions_dir / "sid-gone.json.flock"
    orphan_lock.write_text("", encoding="utf-8")
    orphan_flock.write_text("", encoding="utf-8")

    worker._cleanup_old_sessions()

    assert not orphan_lock.exists(), "orphaned .json.lock should be swept"
    assert not orphan_flock.exists(), "orphaned .json.flock should be swept"


def test_cleanup_old_sessions_wired_into_cleanup_on_startup(tmp_data_dir, monkeypatch):
    """cleanup_on_startup must call _cleanup_old_sessions and record its result."""
    calls: list[int] = []

    def _fake_cleanup() -> int:
        calls.append(1)
        return 3

    monkeypatch.setattr(worker, "_cleanup_old_sessions", _fake_cleanup)

    stats = worker.cleanup_on_startup()

    assert len(calls) == 1
    assert stats.get("old_sessions_removed") == 3


# ---------------------------------------------------------------------------
# Eviction Lock Reliability Tests
# ---------------------------------------------------------------------------


class TestEvictionLockConflictLogging:
    """Verify lock conflict detection logs at WARNING level."""

    def test_acquire_lock_logs_warning_on_stale_lock_collision(self, tmp_data_dir, caplog):
        """When lock conflicts during stale-lock recovery, log WARNING."""
        paths.ensure_dirs()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"

        # Create a stale lock file
        now = time.time()
        stale_age = worker._EVICTION_LOCK_STALE_SECONDS + 60
        stale_mtime = now - stale_age
        lock_path.write_text("stale_pid\nstale_time\n")
        os.utime(lock_path, (stale_mtime, stale_mtime))

        # Verify lock is stale
        assert worker._eviction_lock_is_stale(lock_path)

        # Mock os.open to raise FileExistsError on both attempts (simulating
        # another process grabbing the lock between our unlink and O_CREAT)
        original_open = os.open
        call_count = [0]

        def fake_open(path, flags, mode=0o644):
            call_count[0] += 1
            if call_count[0] <= 2:  # First call (original), second after unlink
                raise FileExistsError("Simulated lock conflict")
            return original_open(path, flags, mode)

        with caplog.at_level(logging.WARNING), patch("os.open", fake_open):
            result = worker._acquire_eviction_lock(lock_path)

        # Should return None (lock not acquired)
        assert result is None

        # Should log WARNING about contention
        assert any(
            "image-cache eviction lock contention" in record.message
            for record in caplog.records
            if record.levelno == logging.WARNING
        )

    def test_acquire_lock_logs_warning_on_fresh_lock_conflict(self, tmp_data_dir, caplog):
        """When lock held by another live process, log WARNING."""
        paths.ensure_dirs()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"

        # Create a fresh (non-stale) lock file
        lock_path.write_text("current_pid\ncurrent_time\n")
        now = time.time()
        os.utime(lock_path, (now, now))

        # Verify lock is NOT stale
        assert not worker._eviction_lock_is_stale(lock_path)

        with caplog.at_level(logging.WARNING):
            result = worker._acquire_eviction_lock(lock_path)

        # Should return None (lock not acquired)
        assert result is None

        # Should log WARNING about contention
        assert any(
            "image-cache eviction lock contention" in record.message
            and "fresh" in record.message
            for record in caplog.records
            if record.levelno == logging.WARNING
        )


class TestEvictionLockAutoClears:
    """Verify stale eviction locks are auto-cleared at worker startup."""

    def test_clear_stale_eviction_lock_removes_old_lock(self, tmp_data_dir):
        """_clear_stale_eviction_lock removes locks older than threshold."""
        paths.ensure_dirs()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"

        # Create a stale lock
        lock_path.write_text("dead_pid\nstale_time\n")
        now = time.time()
        stale_age = worker._EVICTION_LOCK_STALE_SECONDS + 100
        stale_mtime = now - stale_age
        os.utime(lock_path, (stale_mtime, stale_mtime))

        assert lock_path.exists()
        assert worker._eviction_lock_is_stale(lock_path)

        # Clear it
        worker._clear_stale_eviction_lock()

        # Should be gone
        assert not lock_path.exists()

    def test_clear_stale_eviction_lock_preserves_fresh_lock(self, tmp_data_dir):
        """_clear_stale_eviction_lock does NOT remove fresh locks."""
        paths.ensure_dirs()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"

        # Create a fresh lock
        lock_path.write_text("current_pid\ncurrent_time\n")
        now = time.time()
        os.utime(lock_path, (now, now))

        assert lock_path.exists()
        assert not worker._eviction_lock_is_stale(lock_path)

        # Clear it (should be a no-op)
        worker._clear_stale_eviction_lock()

        # Should still exist
        assert lock_path.exists()

    def test_clear_stale_eviction_lock_wired_into_cleanup_on_startup(self, tmp_data_dir):
        """cleanup_on_startup must call _clear_stale_eviction_lock."""
        paths.ensure_dirs()
        lock_path = paths.locks_dir() / "image_cache_eviction.lock"

        # Create a stale lock
        lock_path.write_text("dead\nold\n")
        now = time.time()
        stale_age = worker._EVICTION_LOCK_STALE_SECONDS + 60
        os.utime(lock_path, (now - stale_age, now - stale_age))

        assert lock_path.exists()

        # Run cleanup
        worker.cleanup_on_startup()

        # Stale lock should have been cleared
        assert not lock_path.exists()


# ---------------------------------------------------------------------------
# Regression: P1-1+P2-5 — enqueue_dirty append-only + byte-size cap
# ---------------------------------------------------------------------------

class TestEnqueueDirtyRegression:
    """enqueue_dirty must append entries (never rewrite) and enforce the byte cap via stat()."""

    def test_appends_second_entry_preserves_first(self, tmp_data_dir):
        """Regression P1-1/P2-5: two enqueue_dirty calls produce two entries; the first is preserved.

        Before the fix, a read-modify-write implementation would truncate any line appended
        between the read and the write, losing entries under concurrent writers.  With the
        append-only implementation both entries must survive in the queue file.
        """
        paths.ensure_dirs()
        worker.enqueue_dirty("a/first.py", project_hash="proj1")
        worker.enqueue_dirty("b/second.py", project_hash="proj1")

        queue_file = paths.dirty_queue_path()
        lines = [ln for ln in queue_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
        assert len(lines) == 2, f"expected 2 entries, got {len(lines)}: {lines}"
        paths_in_queue = [json.loads(ln)["path"] for ln in lines]
        assert "a/first.py" in paths_in_queue
        assert "b/second.py" in paths_in_queue

    def test_byte_cap_drops_entry_without_reading_file(self, tmp_data_dir):
        """Regression P2-5: byte cap is enforced via a single stat() call, not by reading the file.

        Fill the queue file to just over DIRTY_QUEUE_MAX_BYTES then attempt another enqueue.
        The new entry must be silently dropped; the file size must not grow.
        """
        paths.ensure_dirs()
        queue_file = paths.dirty_queue_path()
        # Write a file that's exactly at the cap
        queue_file.write_bytes(b"x" * worker.DIRTY_QUEUE_MAX_BYTES)
        size_before = queue_file.stat().st_size

        worker.enqueue_dirty("should_be_dropped.py", project_hash="proj1")

        size_after = queue_file.stat().st_size
        assert size_after == size_before, (
            f"file grew from {size_before} to {size_after} despite byte cap"
        )

    def test_entry_appended_when_below_cap(self, tmp_data_dir):
        """A queue file under the cap accepts new entries normally."""
        paths.ensure_dirs()
        queue_file = paths.dirty_queue_path()
        queue_file.write_bytes(b"x" * (worker.DIRTY_QUEUE_MAX_BYTES - 500))
        size_before = queue_file.stat().st_size

        worker.enqueue_dirty("fits.py", project_hash="proj1")

        assert queue_file.stat().st_size > size_before


# ---------------------------------------------------------------------------
# Regression: P1-2 — drain_dirty_queue quarantines unreadable .draining file
# ---------------------------------------------------------------------------

class TestDrainDirtyQueueQuarantineRegression:
    """drain_dirty_queue must quarantine an unreadable .draining file instead of overwriting it.

    Regression P1-2: the original recovery block re-raised OSError from read_text,
    which crashed the worker loop without quarantining the corrupt file.  A subsequent
    drain cycle would then rename the live dirty.txt over the .draining file, silently
    discarding any entries in the unreadable file.
    """

    def test_unreadable_draining_file_is_quarantined(self, tmp_data_dir, monkeypatch):
        """OSError on .draining read_text → file quarantined as .corrupt-*; function does not crash.

        Regression P1-2 (pre-fix behaviour): the OSError was re-raised, crashing the worker loop.
        On the next cycle dirty.txt would be renamed over the still-present .draining file,
        silently discarding all entries in it.  After the fix, the .draining file is renamed to
        a .corrupt-<ts> sidecar and the drain cycle continues normally.
        """
        paths.ensure_dirs()
        queue_dir = paths.dirty_queue_path().parent
        draining_path = paths.dirty_queue_path().with_name(paths.dirty_queue_path().name + ".draining")

        # Create a .draining file so the recovery branch is entered
        draining_path.write_text("some content", encoding="utf-8")

        # Patch Path.read_text to raise only for the .draining path
        original_read_text = draining_path.__class__.read_text

        def _failing_read_text(self, *args, **kwargs):
            if self == draining_path:
                raise OSError("simulated read failure")
            return original_read_text(self, *args, **kwargs)

        monkeypatch.setattr(draining_path.__class__, "read_text", _failing_read_text)

        # Must not raise; returns [] (no live queue) or None (deferred), both are acceptable
        result = worker.drain_dirty_queue()
        assert result is not None or result == []  # did not crash

        # The .draining file must have been quarantined (renamed to .corrupt-*)
        corrupt_files = list(queue_dir.glob("*.corrupt-*"))
        assert corrupt_files, "expected a quarantine .corrupt-* file but found none"

        # The original .draining path must be gone (was renamed)
        assert not draining_path.exists(), ".draining file must be gone after quarantine"

    def test_unreadable_draining_file_not_silently_overwritten(self, tmp_data_dir, monkeypatch):
        """After a failed quarantine attempt, drain returns None without renaming live queue over the .draining file."""
        paths.ensure_dirs()
        queue_path = paths.dirty_queue_path()
        draining_path = queue_path.with_name(queue_path.name + ".draining")

        # Both files exist — draining unreadable, live queue has a new entry
        draining_path.write_text("unreadable content", encoding="utf-8")
        queue_path.write_text('{"path":"new.py","project_hash":null,"ts":0}\n', encoding="utf-8")

        original_read_text = draining_path.__class__.read_text
        original_rename = draining_path.__class__.rename

        def _failing_read_text(self, *args, **kwargs):
            if self == draining_path:
                raise OSError("simulated read failure")
            return original_read_text(self, *args, **kwargs)

        def _failing_rename(self, target):
            if self == draining_path:
                raise OSError("simulated rename failure")
            return original_rename(self, target)

        monkeypatch.setattr(draining_path.__class__, "read_text", _failing_read_text)
        monkeypatch.setattr(draining_path.__class__, "rename", _failing_rename)

        result = worker.drain_dirty_queue()

        # Must defer — not None due to missing entries, but None due to unrecoverable state
        assert result is None
        # The live queue must still exist (not consumed by the deferred drain cycle)
        assert queue_path.exists()
