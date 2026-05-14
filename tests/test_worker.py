"""Tests for tokenwise.worker — Phase 9."""
from __future__ import annotations

import os
import threading
import time
from unittest.mock import MagicMock, patch

import tokenwise.paths as paths
from tokenwise import worker

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

def test_is_worker_alive_current_process(tmp_data_dir):
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
    from tokenwise import db as _db
    from tokenwise.project import project_hash as ph_fn

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


# ---------------------------------------------------------------------------
# 9. run_daemon smoke test — stop_event shuts it down, PID file is cleaned up
# ---------------------------------------------------------------------------

def test_run_daemon_stop_event(tmp_data_dir):
    stop = threading.Event()

    # Set the stop event after a short delay from a background thread
    def _stopper():
        time.sleep(0.3)
        stop.set()

    t = threading.Thread(target=_stopper, daemon=True)
    t.start()

    worker.run_daemon(stop_event=stop)
    t.join(timeout=5.0)

    # PID file must be cleaned up after exit
    assert not paths.worker_pid_path().exists()
    assert not paths.worker_heartbeat_path().exists()
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

    fd = worker._try_claim_worker_slot()
    assert fd is None, "empty claim must be treated as owner-mid-startup, not stale"
    claim.unlink(missing_ok=True)


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

def test_ensure_running_already_alive(tmp_data_dir):
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


class TestWorkerSelfHeal:
    """ensure_running() must respawn a crashed or hung worker, but never
    disturb a healthy-but-busy one (which would orphan it or spawn a
    duplicate that just loses the claim race)."""

    def test_is_tokenwise_worker_false_for_dead_pid(self, tmp_data_dir):
        # 999999999 is not a real PID — cmdline lookup fails → not a worker.
        assert worker._is_tokenwise_worker(999999999) is False

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

def test_spawn_detached_mocked(tmp_data_dir):
    """spawn_detached should return the PID returned by Popen."""
    fake_proc = MagicMock()
    fake_proc.pid = 12345

    with patch("tokenwise.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_detached()

    assert pid == 12345
    mock_popen.assert_called_once()
    cmd_arg = mock_popen.call_args[0][0]
    # Prefer the windowless tokenwise-worker binary (or fall back to tokenwise);
    # either way the trailing args are stable.
    assert cmd_arg[-2:] == ["worker", "--daemon"]
    assert "tokenwise" in cmd_arg[0].lower()


# ---------------------------------------------------------------------------
# spawn_index_detached — idempotency guard against the 44-process pileup
# ---------------------------------------------------------------------------

def test_spawn_index_detached_writes_marker(tmp_data_dir):
    """First spawn for a project Popens an index and records a spawn marker."""
    fake_proc = MagicMock()
    fake_proc.pid = 55501

    with patch("tokenwise.worker.subprocess.Popen", return_value=fake_proc):
        pid = worker.spawn_index_detached("C:/proj", "hashAAA")

    assert pid == 55501
    marker = paths.locks_dir() / "hashAAA.indexing"
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

    with patch("tokenwise.worker.subprocess.Popen") as mock_popen:
        pid = worker.spawn_index_detached("C:/proj", "hashBBB")

    assert pid is None, "spawn must be skipped while an index is already running"
    mock_popen.assert_not_called()


def test_spawn_index_detached_respawns_when_marker_stale(tmp_data_dir):
    """A stale marker (timestamp older than the TTL) must not block a new spawn."""
    marker = paths.locks_dir() / "hashCCC.indexing"
    marker.parent.mkdir(parents=True, exist_ok=True)
    stale_ts = time.time() - (worker.INDEX_SPAWN_TTL + 60)
    marker.write_text(f"{os.getpid()}\n{stale_ts}", encoding="utf-8")

    fake_proc = MagicMock()
    fake_proc.pid = 55503
    with patch("tokenwise.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_index_detached("C:/proj", "hashCCC")

    assert pid == 55503
    mock_popen.assert_called_once()


def test_spawn_index_detached_respawns_when_pid_dead(tmp_data_dir):
    """A marker whose PID is no longer alive must not block a new spawn."""
    marker = paths.locks_dir() / "hashDDD.indexing"
    marker.parent.mkdir(parents=True, exist_ok=True)
    # PID 1 with a port-style high number that is almost certainly not alive;
    # use a fresh timestamp so only the dead-PID condition is under test.
    dead_pid = 999999999
    marker.write_text(f"{dead_pid}\n{time.time()}", encoding="utf-8")

    fake_proc = MagicMock()
    fake_proc.pid = 55504
    with patch("tokenwise.worker.subprocess.Popen", return_value=fake_proc) as mock_popen:
        pid = worker.spawn_index_detached("C:/proj", "hashDDD")

    assert pid == 55504
    mock_popen.assert_called_once()


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

def test_is_worker_alive_fresh_heartbeat_mtime(tmp_data_dir):
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
        from tokenwise import db as _db
        from tokenwise.parser import index_project
        from tokenwise.project import canonicalize, make_project_at, project_hash

        proj_root = tmp_path / "code"
        proj_root.mkdir()
        (proj_root / "mod.py").write_text("def f():\n    return 1\n", encoding="utf-8")
        ph = project_hash(canonicalize(proj_root))
        index_project(make_project_at(proj_root), full=True)
        with _db.open_global() as gconn:
            self._register_project(gconn, ph, proj_root.as_posix(), ".git", 1)

        with patch("tokenwise.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_called_once()

    def test_reindexes_manual_project(self, tmp_data_dir, tmp_path):
        from tokenwise import db as _db
        from tokenwise.project import canonicalize, project_hash

        skill_root = tmp_path / "skills"
        skill_root.mkdir()
        (skill_root / "tool.md").write_text("# Tool\n\n## Section\n\nContent.\n", encoding="utf-8")
        ph = project_hash(canonicalize(skill_root))

        with _db.open_global() as gconn:
            self._register_project(gconn, ph, skill_root.as_posix(), "manual", 1)

        # First index so there is a project DB to update
        from tokenwise.parser import index_project
        from tokenwise.project import make_project_at
        index_project(make_project_at(skill_root), full=True)

        # Now call the sweep — should run without raising
        worker._reindex_active_projects()

    def test_skips_project_outside_active_window(self, tmp_data_dir, tmp_path):
        """A project not seen within PERIODIC_REINDEX_ACTIVE_WINDOW is skipped."""
        from tokenwise import db as _db
        from tokenwise.project import project_hash

        old_root = tmp_path / "dormant"
        old_root.mkdir()
        ph = project_hash(old_root.resolve())
        # last_seen well outside the active window
        stale_ts = int(time.time() - worker.PERIODIC_REINDEX_ACTIVE_WINDOW - 3600)
        with _db.open_global() as gconn:
            self._register_project(gconn, ph, str(old_root), ".git", 5, last_seen=stale_ts)

        with patch("tokenwise.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_not_called()

    def test_skips_project_exceeding_file_cap(self, tmp_data_dir, tmp_path, monkeypatch):
        from tokenwise import db as _db
        from tokenwise.project import project_hash

        big_root = tmp_path / "huge"
        big_root.mkdir()
        ph = project_hash(big_root.resolve())
        with _db.open_global() as gconn:
            # Register with file_count > cap
            self._register_project(gconn, ph, str(big_root), "manual", 9999)

        monkeypatch.setattr(worker, "PERIODIC_REINDEX_MAX_FILES", 500)

        with patch("tokenwise.parser.index_project") as mock_index:
            worker._reindex_active_projects()
            mock_index.assert_not_called()

    def test_one_project_failing_does_not_block_others(self, tmp_data_dir, tmp_path):
        from tokenwise import db as _db
        from tokenwise.project import canonicalize, make_project_at, project_hash

        good_root = tmp_path / "good"
        good_root.mkdir()
        (good_root / "skill.md").write_text("# Good\n", encoding="utf-8")
        bad_root = tmp_path / "bad"
        bad_root.mkdir()

        good_ph = project_hash(canonicalize(good_root))
        bad_ph = project_hash(canonicalize(bad_root))

        from tokenwise.parser import index_project
        index_project(make_project_at(good_root), full=True)

        with _db.open_global() as gconn:
            self._register_project(gconn, bad_ph, bad_root.as_posix(), "manual", 1)
            self._register_project(gconn, good_ph, good_root.as_posix(), "manual", 1)

        call_log: list[str] = []

        original_index = __import__("tokenwise.parser", fromlist=["index_project"]).index_project

        def _patched_index(proj, **kw):
            if proj.hash == bad_ph:
                raise RuntimeError("simulated index failure")
            call_log.append(proj.hash)
            return original_index(proj, **kw)

        with patch("tokenwise.parser.index_project", side_effect=_patched_index):
            worker._reindex_active_projects()  # must not raise

        # good project was still processed despite bad project failing
        assert good_ph in call_log

    def test_global_db_error_is_swallowed(self, tmp_data_dir, monkeypatch):
        from tokenwise import db as _db

        def _boom(*a, **kw):
            raise RuntimeError("DB gone")

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
