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
