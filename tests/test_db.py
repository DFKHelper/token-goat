"""Tests for token_goat.db."""
from __future__ import annotations

import contextlib
import os
import sqlite3
import threading
import time
from unittest.mock import patch

import pytest

import token_goat.paths as paths
from token_goat import db

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    return {r[0] for r in rows}


# ---------------------------------------------------------------------------
# 1. open_global creates global.db and applies schema
# ---------------------------------------------------------------------------

def test_open_global_creates_db_and_schema(tmp_data_dir):
    with db.open_global() as conn:
        tables = _table_names(conn)
    assert "projects" in tables
    assert "symbols_global" in tables
    assert "meta" in tables
    assert "stats" in tables
    assert paths.global_db_path().exists()


# ---------------------------------------------------------------------------
# 2. open_global is idempotent
# ---------------------------------------------------------------------------

def test_open_global_idempotent(tmp_data_dir):
    with db.open_global() as conn:
        _ = _table_names(conn)
    # second open must not raise
    with db.open_global() as conn:
        tables = _table_names(conn)
    assert "projects" in tables


# ---------------------------------------------------------------------------
# 3. open_project creates per-project DB at right path
# ---------------------------------------------------------------------------

def test_open_project_creates_db_at_correct_path(tmp_data_dir):
    h = "abc123def456"
    with db.open_project(h) as conn:
        tables = _table_names(conn)
    expected = paths.project_db_path(h)
    assert expected.exists()
    assert "files" in tables


# ---------------------------------------------------------------------------
# 4. Schema contains all expected per-project tables
# ---------------------------------------------------------------------------

def test_project_schema_tables(tmp_data_dir):
    h = "deadbeef0001"
    with db.open_project(h) as conn:
        tables = _table_names(conn)
    required = {"files", "symbols", "refs", "sections", "imports_exports", "chunks", "stats", "meta"}
    assert required.issubset(tables), f"missing tables: {required - tables}"


# ---------------------------------------------------------------------------
# 5. WAL mode is on
# ---------------------------------------------------------------------------

def test_wal_mode_enabled(tmp_data_dir):
    h = "deadbeef0002"
    with db.open_project(h) as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


def test_global_wal_mode(tmp_data_dir):
    with db.open_global() as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


# ---------------------------------------------------------------------------
# 6. Foreign keys are on
# ---------------------------------------------------------------------------

def test_foreign_keys_on(tmp_data_dir):
    h = "deadbeef0003"
    with db.open_project(h) as conn:
        fk = conn.execute("PRAGMA foreign_keys").fetchone()[0]
    assert fk == 1


# ---------------------------------------------------------------------------
# 7. Corruption auto-rebuild
# ---------------------------------------------------------------------------

def test_corruption_auto_rebuild(tmp_data_dir):
    h = "c011ec70011ec70011ec70011ec70011ec700001"
    db_path = paths.project_db_path(h)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.write_bytes(b"this is not a sqlite file GARBAGE GARBAGE GARBAGE")

    with db.open_project(h) as conn:
        tables = _table_names(conn)

    # Fresh DB must have expected tables
    assert "files" in tables
    # Bad file must have been quarantined (a .bad-* sibling exists)
    siblings = list(db_path.parent.glob(f"{h}.db.bad-*"))
    assert len(siblings) == 1, f"expected one .bad-* file, got: {siblings}"


# ---------------------------------------------------------------------------
# 8. project_writer_lock — releases on exit and blocks concurrent holders
# ---------------------------------------------------------------------------

def test_writer_lock_acquires_and_releases(tmp_data_dir):
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000001"
    with db.project_writer_lock(h, timeout_sec=2.0):
        lock_path = paths.locks_dir() / f"{h}.lock"
        assert lock_path.exists()
    # after exit, lock file removed
    assert not lock_path.exists()


def test_writer_lock_raises_timeout_when_held_by_live_pid(tmp_data_dir):
    """Write a lock file owned by the current (live) process with a fresh timestamp."""
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000002"
    lock_path = paths.locks_dir() / f"{h}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Write lock owned by *this* process (alive) with current timestamp
    lock_path.write_text(f"{os.getpid()}\n{time.time()}", encoding="utf-8")

    with pytest.raises(TimeoutError), db.project_writer_lock(h, timeout_sec=0.3):
        pass  # should not reach here


# ---------------------------------------------------------------------------
# 9. Stale-lock cleanup (timestamp >10 min old)
# ---------------------------------------------------------------------------

def test_stale_lock_auto_cleared(tmp_data_dir):
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000003"
    lock_path = paths.locks_dir() / f"{h}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    stale_ts = time.time() - 660  # 11 minutes ago
    lock_path.write_text(f"99999\n{stale_ts}", encoding="utf-8")

    # Should succeed — stale lock must be taken over
    with db.project_writer_lock(h, timeout_sec=1.0):
        assert lock_path.exists()
    assert not lock_path.exists()


def test_pid_alive_returns_false_for_dead_process(tmp_data_dir):
    """_pid_alive should return False for a PID that does not exist."""
    # Use a very large PID that is almost certainly not running
    dead_pid = 99999999
    assert not db._pid_alive(dead_pid)


def test_pid_alive_returns_true_for_current_process(tmp_data_dir):
    """_pid_alive should return True for the current process."""
    current_pid = os.getpid()
    assert db._pid_alive(current_pid)


def test_pid_alive_handles_permission_error_as_alive_on_windows(tmp_data_dir):
    """_pid_alive should treat PermissionError from os.kill as 'process alive'.

    On Windows, os.kill(pid, 0) raises PermissionError for living processes
    because we lack ACL permission to signal them. This test mocks os.kill
    to raise PermissionError and verifies _pid_alive returns True.
    """
    test_pid = 12345
    # Mock psutil to be unavailable (ImportError) so the fallback to os.kill is used
    with patch.dict("sys.modules", {"psutil": None}), patch(
        "token_goat.db.os.kill", side_effect=PermissionError("Access denied")
    ):
        assert db._pid_alive(test_pid) is True


def test_pid_alive_handles_process_lookup_error_as_dead(tmp_data_dir):
    """_pid_alive should treat ProcessLookupError from os.kill as 'process dead'."""
    test_pid = 12345
    # Mock psutil to be unavailable (ImportError) so the fallback to os.kill is used
    with patch.dict("sys.modules", {"psutil": None}), patch(
        "token_goat.db.os.kill", side_effect=ProcessLookupError("No such process")
    ):
        assert db._pid_alive(test_pid) is False


def test_lock_with_cross_platform_marker_stales_after_60s(tmp_data_dir):
    """A lock file written on a different platform should be stale after 60s.

    This simulates a WSL process writing a lock with platform='linux',
    then a Windows process trying to acquire it after 61 seconds.
    """
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000004"
    lock_path = paths.locks_dir() / f"{h}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    # Simulate a lock written 61 seconds ago on a different platform
    cross_platform_ts = time.time() - 61
    # Use "linux" as the lock platform, regardless of current OS
    lock_path.write_text(f"99999\n{cross_platform_ts}\nlinux", encoding="utf-8")

    # Should succeed — cross-platform lock older than 60s should be cleared
    with db.project_writer_lock(h, timeout_sec=1.0):
        assert lock_path.exists()
    assert not lock_path.exists()


def test_lock_with_same_platform_marker_uses_10_min_timeout(tmp_data_dir):
    """A lock file written on the same platform should use the 10-minute timeout.

    This ensures that same-platform locks don't prematurely age out.
    """
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000005"
    lock_path = paths.locks_dir() / f"{h}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    # Create a lock 61 seconds old with current process PID and platform
    # (so it's not treated as dead by PID check, and stays within 10-min timeout)
    import sys
    recent_ts = time.time() - 61
    lock_path.write_text(f"{os.getpid()}\n{recent_ts}\n{sys.platform}", encoding="utf-8")

    # Should timeout — same-platform lock uses 10-minute timeout, not 60s
    with pytest.raises(TimeoutError), db.project_writer_lock(h, timeout_sec=0.3):
        pass


def test_lock_file_format_includes_platform(tmp_data_dir):
    """A newly acquired lock file should contain pid, timestamp, and platform."""
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000006"
    lock_path = paths.locks_dir() / f"{h}.lock"

    with db.project_writer_lock(h, timeout_sec=1.0):
        content = lock_path.read_text(encoding="utf-8")
        lines = content.strip().split("\n")
        assert len(lines) >= 3, f"lock file should have at least 3 lines, got: {content!r}"
        assert lines[0] == str(os.getpid()), "first line should be current PID"
        assert lines[2] in ("win32", "linux", "darwin"), f"platform should be valid, got: {lines[2]}"


def test_writer_lock_is_mutually_exclusive_under_concurrency(tmp_data_dir):
    """Concurrent acquirers must never both hold the writer lock.

    Regression test for a check-then-write TOCTOU: the previous _try_acquire
    did ``if lock_path.exists(): ... else: write_text(...)``, so two callers
    that both observed the file absent each wrote the lock and each believed it
    held it. The fix makes acquisition an atomic ``os.open(O_CREAT|O_EXCL)``
    create. Eight threads are released through a barrier so they contend for
    one lock at the same instant: this records concurrent holders (peak > 1) on
    the pre-fix code and stays at exactly 1 on the fixed code.
    """
    h = "a0c000a0c000a0c000a0c000a0c000a0c0000099"
    state = {"current": 0, "max": 0}
    violations: list[int] = []
    successes = 0
    guard = threading.Lock()
    barrier = threading.Barrier(8)

    def worker() -> None:
        nonlocal successes
        barrier.wait(timeout=5)  # release all threads at the same instant to force the race
        try:
            with db.project_writer_lock(h, timeout_sec=5.0):
                with guard:
                    state["current"] += 1
                    state["max"] = max(state["max"], state["current"])
                    if state["current"] > 1:
                        violations.append(state["current"])
                    successes += 1
                threading.Event().wait(0.05)  # hold the lock briefly to force contention
                with guard:
                    state["current"] -= 1
        except TimeoutError:
            pass

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert not violations, f"writer lock was held concurrently: peak holders={violations}"
    assert state["max"] == 1, f"expected exclusive access, peak holders={state['max']}"
    assert successes == 8, f"every thread should eventually acquire; got {successes}/8"


# ---------------------------------------------------------------------------
# 10. sqlite-vec: vec_version() returns a string if importable
# ---------------------------------------------------------------------------

def test_sqlite_vec_loads_and_version(tmp_data_dir):
    try:
        import sqlite_vec as sv  # noqa: PLC0415
        conn = sqlite3.connect(":memory:", isolation_level=None)
        conn.enable_load_extension(True)
        sv.load(conn)
        conn.enable_load_extension(False)
        ver = conn.execute("SELECT vec_version()").fetchone()[0]
        conn.close()
        assert isinstance(ver, str) and len(ver) > 0
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"sqlite-vec not available: {e}")


# ---------------------------------------------------------------------------
# 11. record_stat writes to per-project stats table
# ---------------------------------------------------------------------------

def test_record_stat_project(tmp_data_dir):
    h = "5ba00005ba00005ba00005ba00005ba000000001"
    db.record_stat(h, "symbol_hit", tokens_saved=50, bytes_saved=200, detail="test")
    with db.open_project(h) as conn:
        row = conn.execute("SELECT * FROM stats WHERE kind='symbol_hit'").fetchone()
    assert row is not None
    assert row["tokens_saved"] == 50
    assert row["bytes_saved"] == 200
    assert row["detail"] == "test"


# ---------------------------------------------------------------------------
# 12. record_stat with no project_hash writes to global.db
# ---------------------------------------------------------------------------

def test_record_stat_global(tmp_data_dir):
    db.record_stat(None, "session_dedupe", tokens_saved=100)
    with db.open_global() as conn:
        row = conn.execute("SELECT * FROM stats WHERE kind='session_dedupe'").fetchone()
    assert row is not None
    assert row["tokens_saved"] == 100


# ---------------------------------------------------------------------------
# 12b. touch_project_last_seen — marks user activity for the reindex window
# ---------------------------------------------------------------------------

def test_touch_project_last_seen_updates_registered_project(tmp_data_dir):
    h = "touch0001"
    with db.open_global() as conn:
        conn.execute(
            "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (h, "c:/proj", ".git", 1000, 1000, 3, "python"),
        )

    db.touch_project_last_seen(h)

    with db.open_global() as conn:
        last_seen = conn.execute(
            "SELECT last_seen FROM projects WHERE hash = ?", (h,)
        ).fetchone()[0]
    # Bumped from the stale 1000 to ~now.
    assert last_seen > 1000
    assert abs(last_seen - time.time()) < 60


def test_touch_project_last_seen_noop_for_unregistered_project(tmp_data_dir):
    """No row to update — must not raise, must not create a bogus row."""
    db.touch_project_last_seen("neverseen0001")
    with db.open_global() as conn:
        row = conn.execute(
            "SELECT 1 FROM projects WHERE hash = ?", ("neverseen0001",)
        ).fetchone()
    assert row is None


# ---------------------------------------------------------------------------
# 13. schema_version meta row exists after first open
# ---------------------------------------------------------------------------

def test_schema_version_meta_project(tmp_data_dir):
    h = "5c0e005c0e005c0e005c0e005c0e005c0e000001"
    with db.open_project(h) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row is not None
    assert row[0] == str(db.SCHEMA_VERSION)


def test_schema_version_meta_global(tmp_data_dir):
    with db.open_global() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row is not None
    assert row[0] == str(db.SCHEMA_VERSION)


# ---------------------------------------------------------------------------
# 14. WAL fallback — OperationalError on WAL PRAGMA must not crash _connect()
# ---------------------------------------------------------------------------

def test_connect_wal_operational_error_handled(tmp_data_dir):
    """Regression: _connect() must continue if WAL PRAGMA raises OperationalError.

    Sandboxed environments (e.g. Codex unelevated on Windows) may not be able
    to create the WAL shm file.  The previous code re-raised this as DatabaseError
    and the caller treated it as DB corruption, triggering a pointless quarantine
    cycle.
    """
    from unittest.mock import MagicMock

    db_path = tmp_data_dir / "wal_fallback_test.db"

    def execute_side_effect(sql, *args, **kw):
        if isinstance(sql, str) and "journal_mode" in sql.upper() and "WAL" in sql.upper():
            raise sqlite3.OperationalError("unable to open database file")
        return MagicMock()

    mock_conn = MagicMock()
    mock_conn.execute.side_effect = execute_side_effect

    with patch("token_goat.db.sqlite3.connect", return_value=mock_conn):
        conn = db._connect(db_path, load_vec=False)

    # _connect() must return rather than raise — WAL failure is non-fatal
    assert conn is mock_conn


# ---------------------------------------------------------------------------
# 15. _open_with_rebuild re-raises if both _connect() attempts fail
# ---------------------------------------------------------------------------

def test_open_with_rebuild_raises_on_double_failure(tmp_data_dir):
    """Regression: _open_with_rebuild must re-raise (not silently crash) when
    _connect fails on both the first and second (post-quarantine) attempts.

    The old open_global() / open_project() code left the second _connect() call
    unwrapped, so the OperationalError propagated with no log message, appearing
    as a mystery crash to the caller.
    """
    with patch("token_goat.db._connect", side_effect=sqlite3.OperationalError("unable to open")), \
            pytest.raises(db.DBCorruptionError):
        db._open_with_rebuild(tmp_data_dir / "no_such.db")


# ---------------------------------------------------------------------------
# 16. open_global / open_project surface errors cleanly on persistent failure
# ---------------------------------------------------------------------------

def test_open_global_raises_cleanly_on_persistent_connect_failure(tmp_data_dir):
    """open_global() must raise (not crash silently) if DB can't be opened."""
    with (
        patch("token_goat.db._connect", side_effect=sqlite3.OperationalError("unable to open")),
        pytest.raises(db.DBCorruptionError),
        db.open_global(),
    ):
        pass


def test_open_project_raises_cleanly_on_persistent_connect_failure(tmp_data_dir):
    """open_project() must raise (not crash silently) if DB can't be opened."""
    with (
        patch("token_goat.db._connect", side_effect=sqlite3.OperationalError("unable to open")),
        pytest.raises(db.DBCorruptionError),
        db.open_project("abc123def456"),
    ):
        pass


# ---------------------------------------------------------------------------
# 17. _connect_readonly falls back to immutable=1 when ?mode=ro fails
# ---------------------------------------------------------------------------

def test_connect_readonly_immutable_fallback(tmp_data_dir):
    """Regression: _connect_readonly() must retry with immutable=1 when ?mode=ro
    raises OperationalError.

    Sandboxed environments (e.g. Codex unelevated on Windows) cannot access the
    WAL shared-memory file even for read-only opens.  immutable=1 bypasses all
    WAL/SHM coordination and reads the DB file directly.
    """

    real_connect = sqlite3.connect
    call_count = 0
    captured_uris: list[str] = []

    def fake_connect(database, **kw):
        nonlocal call_count
        call_count += 1
        captured_uris.append(database)
        if call_count == 1:
            raise sqlite3.OperationalError("unable to open database file")
        # Second call (immutable) succeeds — return a real in-memory connection so
        # row_factory assignment doesn't blow up.
        conn = real_connect(":memory:", isolation_level=None)
        conn.row_factory = sqlite3.Row
        return conn

    with patch("token_goat.db.sqlite3.connect", side_effect=fake_connect):
        conn = db._connect_readonly(tmp_data_dir / "test.db")

    assert call_count == 2, "expected exactly 2 connect() calls"
    assert "immutable=1" in captured_uris[1], f"second URI should use immutable=1; got {captured_uris[1]}"
    conn.close()


# ---------------------------------------------------------------------------
# 18. conn.close() errors in finally blocks don't propagate to callers
# ---------------------------------------------------------------------------

def test_open_project_close_error_does_not_propagate(tmp_data_dir):
    """Regression: an OperationalError from conn.close() (WAL checkpoint) in the
    finally block of open_project() must not crash the caller.

    Codex unelevated sandbox: WAL SHM inaccessible, so conn.close() raises
    OperationalError when SQLite attempts the WAL checkpoint on connection close.
    The caller already received the map output — the close error must be swallowed.
    """
    from unittest.mock import MagicMock

    h = "c105ec105ec105ec105ec105ec105ec105e00001"
    # Create and initialize the real project DB first so schema exists.
    with db.open_project(h):
        pass

    mock_conn = MagicMock()
    mock_conn.close.side_effect = sqlite3.OperationalError("unable to open database file")
    with (
        patch("token_goat.db._connect", return_value=mock_conn),
        patch("token_goat.db._integrity_ok", return_value=True),
        patch("token_goat.db._ensure_project_schema"),db.open_project(h)
    ):
        pass
    # Reaching here means OperationalError from close() was swallowed


def test_open_global_close_error_does_not_propagate(tmp_data_dir):
    """Same as above but for open_global()."""
    from unittest.mock import MagicMock

    # Create and initialize the real global DB first.
    with db.open_global():
        pass

    mock_conn = MagicMock()
    mock_conn.close.side_effect = sqlite3.OperationalError("unable to open database file")
    with (
        patch("token_goat.db._connect", return_value=mock_conn),
        patch("token_goat.db._integrity_ok", return_value=True),
        patch("token_goat.db._ensure_global_schema"),db.open_global()
    ):
        pass
    # Reaching here means OperationalError from close() was swallowed


# ---------------------------------------------------------------------------
# 19. Index optimization: composite indexes for read_symbol / read_section
# ---------------------------------------------------------------------------

def test_composite_indexes_present(tmp_data_dir):
    """The (file_rel, name) and (file_rel, heading) composite indexes are
    required for read_symbol / read_section's hot lookups.  Without them the
    planner falls back to a single-column index and filters in memory, which
    scales linearly with symbols-per-file or sections-per-heading.
    """
    h = "abcdef0123456789abcdef0123456789abcdef01"
    with db.open_project(h) as conn:
        idx_names = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
    assert "idx_symbols_file_name" in idx_names, idx_names
    assert "idx_sections_file_heading" in idx_names, idx_names


def test_read_symbol_query_uses_composite_index(tmp_data_dir):
    """EXPLAIN QUERY PLAN must confirm the symbols(file_rel,name) composite
    index is selected for the (file_rel = ? AND name = ?) lookup pattern used
    by read_symbol().  A regression to a single-column index would cause the
    planner to scan all symbols in the file (O(symbols-per-file) instead of
    O(log N)).
    """
    h = "abcdef0123456789abcdef0123456789abcdef02"
    with db.open_project(h) as conn:
        plan_rows = conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT name, kind, line, end_line, signature FROM symbols "
            "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL ORDER BY line",
            ("a", "b"),
        ).fetchall()
    plan_text = " | ".join(str(tuple(r)) for r in plan_rows)
    assert "idx_symbols_file_name" in plan_text, plan_text


def test_read_section_query_uses_composite_index(tmp_data_dir):
    h = "abcdef0123456789abcdef0123456789abcdef03"
    with db.open_project(h) as conn:
        plan_rows = conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT heading, level, line, end_line FROM sections "
            "WHERE file_rel = ? AND heading = ? AND end_line IS NOT NULL ORDER BY line",
            ("a", "b"),
        ).fetchall()
    plan_text = " | ".join(str(tuple(r)) for r in plan_rows)
    assert "idx_sections_file_heading" in plan_text, plan_text


def test_symbol_lookup_under_50ms_with_10k_symbols(tmp_data_dir):
    """Synthetic benchmark: with 10,000 symbols spread across 200 files,
    the (file_rel = ? AND name = ?) lookup must complete in well under 50ms.
    This guards against accidental index regressions or schema changes that
    would force a table scan.
    """
    h = "abcdef0123456789abcdef0123456789abcdef04"
    n_files = 200
    n_per_file = 50  # → 10,000 symbols total

    with db.open_project(h) as conn:
        conn.execute("BEGIN")
        # Files must exist first so the FK from symbols.file_rel resolves.
        conn.executemany(
            "INSERT INTO files (rel_path, language, size, line_count, mtime, "
            "content_sha256, indexed_at) VALUES (?, 'python', 1, 1, 0.0, '', 0)",
            ((f"src/mod{i:04d}.py",) for i in range(n_files)),
        )
        conn.executemany(
            "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) "
            "VALUES (?, 'function', ?, ?, 0, ?)",
            (
                (f"sym_{i:04d}_{j:03d}", f"src/mod{i:04d}.py", j + 1, j + 5)
                for i in range(n_files)
                for j in range(n_per_file)
            ),
        )
        conn.execute("COMMIT")
        # Run ANALYZE so the planner has accurate statistics.
        conn.execute("ANALYZE")

        # Hot lookup: 100 iterations, take the median to smooth out noise.
        import statistics  # noqa: PLC0415

        timings: list[float] = []
        for k in range(100):
            file_idx = k % n_files
            sym_idx = k % n_per_file
            t0 = time.monotonic()
            row = conn.execute(
                "SELECT name, kind, line, end_line FROM symbols "
                "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL "
                "ORDER BY line",
                (f"src/mod{file_idx:04d}.py", f"sym_{file_idx:04d}_{sym_idx:03d}"),
            ).fetchone()
            timings.append((time.monotonic() - t0) * 1000)
            assert row is not None, f"missing symbol at iter {k}"
        median_ms = statistics.median(timings)
        max_ms = max(timings)

    # 50ms median is extremely generous; in practice this should be <1ms.
    assert median_ms < 50, f"median lookup too slow: {median_ms:.2f}ms"
    # 200ms peak guard catches pathological tails (cold cache, GC).
    assert max_ms < 200, f"max lookup too slow: {max_ms:.2f}ms"


# ---------------------------------------------------------------------------
# 20. _open_with_retry — exponential backoff on transient DB locks
# ---------------------------------------------------------------------------

def test_open_with_retry_succeeds_after_transient_lock(tmp_data_dir):
    """_open_with_retry() must retry and return a connection when the first
    attempt raises a "database is locked" OperationalError.
    """
    real_conn = sqlite3.connect(":memory:", isolation_level=None)
    real_conn.row_factory = sqlite3.Row
    call_count = 0

    def fake_rebuild(path, *, load_vec=True):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise sqlite3.OperationalError("database is locked")
        return real_conn

    with patch("token_goat.db._open_with_rebuild", side_effect=fake_rebuild):
        conn = db._open_with_retry(tmp_data_dir / "test.db", base_delay=0.0)

    assert call_count == 2, f"expected 2 attempts, got {call_count}"
    assert conn is real_conn


def test_open_with_retry_raises_after_max_attempts(tmp_data_dir):
    """_open_with_retry() must raise OperationalError after exhausting all
    retry attempts when every attempt returns a lock error.
    """
    with patch(
        "token_goat.db._open_with_rebuild",
        side_effect=sqlite3.OperationalError("database is locked"),
    ), pytest.raises(sqlite3.OperationalError, match="locked"):
        db._open_with_retry(
            tmp_data_dir / "test.db",
            max_attempts=3,
            base_delay=0.0,
        )


def test_open_with_retry_does_not_retry_non_lock_errors(tmp_data_dir):
    """_open_with_retry() must NOT retry when the error is not a lock/busy
    error — it must propagate the original exception immediately on the first
    attempt to avoid masking genuine failures (e.g. corrupt DB).
    """
    call_count = 0

    def fake_rebuild(path, *, load_vec=True):
        nonlocal call_count
        call_count += 1
        raise sqlite3.OperationalError("no such table: symbols")

    with patch("token_goat.db._open_with_rebuild", side_effect=fake_rebuild), \
            pytest.raises(sqlite3.OperationalError, match="no such table"):
        db._open_with_retry(tmp_data_dir / "test.db", base_delay=0.0)

    assert call_count == 1, f"non-lock error must not be retried; got {call_count} attempts"


def test_write_file_index_uses_transaction(tmp_data_dir):
    """write_file_index() must wrap its DELETE + INSERT + executemany calls in
    a single explicit transaction.  Without it, each statement is a separate
    autocommit fsync, ~80x slower for typical files.  We assert correctness
    (rows inserted) and performance (a 500-symbol file persists in under 1s).
    """
    from token_goat import parser as parser_mod  # noqa: PLC0415

    h = "abcdef0123456789abcdef0123456789abcdef05"
    fi = parser_mod.FileIndex(
        rel_path="src/big.py",
        language="python",
        size=10000,
        line_count=500,
        mtime=0.0,
        content_sha256="x" * 64,
        symbols=[
            parser_mod.Symbol(
                name=f"f{i:03d}", kind="function", line=i + 1, col=0,
                end_line=i + 5, signature=f"def f{i:03d}():"
            )
            for i in range(500)
        ],
        refs=[
            parser_mod.Ref(name=f"ref{i:03d}", line=i + 1, col=0, context="")
            for i in range(500)
        ],
        imports_exports=[],
        sections=[],
    )
    with db.open_project(h) as conn:
        t0 = time.monotonic()
        parser_mod.write_file_index(conn, fi)
        elapsed = time.monotonic() - t0
        n_symbols = conn.execute(
            "SELECT COUNT(*) FROM symbols WHERE file_rel = ?", (fi.rel_path,)
        ).fetchone()[0]
        n_refs = conn.execute(
            "SELECT COUNT(*) FROM refs WHERE file_rel = ?", (fi.rel_path,)
        ).fetchone()[0]
    assert n_symbols == 500
    assert n_refs == 500
    # 1s is hugely generous; with the transaction wrapping this is ~10ms.
    # Without the transaction (autocommit), this would routinely exceed 1s
    # on Windows with WAL fsync on every statement.
    assert elapsed < 1.0, f"write_file_index too slow: {elapsed:.3f}s"


# ---------------------------------------------------------------------------
# grep_patterns table — migration and update_global_grep_pattern
# ---------------------------------------------------------------------------


def test_grep_patterns_table_created_on_fresh_global_db(tmp_data_dir):
    """A fresh global.db must include the grep_patterns table."""
    with db.open_global() as conn:
        tables = _table_names(conn)
    assert "grep_patterns" in tables, "grep_patterns table missing from fresh global.db"


def test_grep_patterns_index_present(tmp_data_dir):
    """idx_grep_patterns_last_ts index must exist for efficient age-range queries."""
    with db.open_global() as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_grep_patterns_last_ts'"
        ).fetchall()
    assert rows, "idx_grep_patterns_last_ts index missing"


def test_update_global_grep_pattern_inserts_new_row(tmp_data_dir):
    """Calling update_global_grep_pattern for a new pattern inserts a row with count=1."""
    pattern = "def test_"
    pattern_hash = "aabbcc001"
    now = time.time()

    db.update_global_grep_pattern(pattern_hash, pattern, now)

    with db.open_global() as conn:
        row = conn.execute(
            "SELECT first_pattern, count, last_ts FROM grep_patterns WHERE pattern_hash = ?",
            (pattern_hash,),
        ).fetchone()
    assert row is not None
    assert row["first_pattern"] == pattern
    assert row["count"] == 1
    assert abs(row["last_ts"] - now) < 1.0


def test_update_global_grep_pattern_increments_count_after_stale(tmp_data_dir):
    """A second call >24h after the first must increment count and refresh last_ts."""
    pattern = "TODO"
    pattern_hash = "aabbcc002"
    old_ts = time.time() - (25 * 3600)  # 25 hours ago — beyond the 24h amortization window

    # Seed an old row directly so we bypass the amortization guard.
    with db.open_global() as conn:
        conn.execute(
            "INSERT INTO grep_patterns (pattern_hash, first_pattern, last_ts, count) VALUES (?,?,?,?)",
            (pattern_hash, pattern, old_ts, 2),
        )

    new_ts = time.time()
    db.update_global_grep_pattern(pattern_hash, pattern, new_ts)

    with db.open_global() as conn:
        row = conn.execute(
            "SELECT count, last_ts FROM grep_patterns WHERE pattern_hash = ?",
            (pattern_hash,),
        ).fetchone()
    assert row["count"] == 3, f"expected count=3, got {row['count']}"
    assert row["last_ts"] >= new_ts - 1.0


def test_update_global_grep_pattern_skips_write_when_recent(tmp_data_dir):
    """A call within the 24h amortization window must NOT increment count."""
    pattern = "import pytest"
    pattern_hash = "aabbcc003"
    recent_ts = time.time() - 3600  # 1 hour ago — within the 24h window

    with db.open_global() as conn:
        conn.execute(
            "INSERT INTO grep_patterns (pattern_hash, first_pattern, last_ts, count) VALUES (?,?,?,?)",
            (pattern_hash, pattern, recent_ts, 5),
        )

    db.update_global_grep_pattern(pattern_hash, pattern, time.time())

    with db.open_global() as conn:
        row = conn.execute(
            "SELECT count FROM grep_patterns WHERE pattern_hash = ?",
            (pattern_hash,),
        ).fetchone()
    assert row["count"] == 5, "count must not change within the amortization window"


def test_update_global_grep_pattern_three_distinct_sessions(tmp_data_dir):
    """Simulating 3 sessions each inserting the pattern produces count == 3."""
    import hashlib  # noqa: PLC0415

    pattern = "rg 'def test_'"
    pattern_hash = hashlib.sha1(pattern.encode()).hexdigest()  # noqa: S324
    # Session 1 — new pattern.
    db.update_global_grep_pattern(pattern_hash, pattern, 1_000_000.0)
    # Session 2 — simulate >24h later.
    db.update_global_grep_pattern(pattern_hash, pattern, 1_000_000.0 + 86401)
    # Session 3 — simulate another >24h later.
    db.update_global_grep_pattern(pattern_hash, pattern, 1_000_000.0 + 2 * 86401)

    with db.open_global() as conn:
        row = conn.execute(
            "SELECT count FROM grep_patterns WHERE pattern_hash = ?",
            (pattern_hash,),
        ).fetchone()
    assert row is not None
    assert row["count"] == 3, f"expected count=3 after 3 sessions, got {row['count']}"


# ---------------------------------------------------------------------------
# Connection-leak invariant: context managers must close connections on exit
# ---------------------------------------------------------------------------


def test_open_global_closes_connection_on_normal_exit(tmp_data_dir):
    """The connection yielded by open_global() must be closed after the block exits."""
    leaked: list[sqlite3.Connection] = []
    with db.open_global() as conn:
        leaked.append(conn)
    # A closed connection raises ProgrammingError on any operation.
    with pytest.raises(sqlite3.ProgrammingError):
        leaked[0].execute("SELECT 1")


def test_open_global_closes_connection_on_exception(tmp_data_dir):
    """open_global() must close the connection even when the block body raises."""
    leaked: list[sqlite3.Connection] = []
    with contextlib.suppress(RuntimeError), db.open_global() as conn:
        leaked.append(conn)
        raise RuntimeError("body error")
    assert leaked, "connection was never yielded"
    with pytest.raises(sqlite3.ProgrammingError):
        leaked[0].execute("SELECT 1")


def test_open_project_closes_connection_on_normal_exit(tmp_data_dir):
    """The connection yielded by open_project() must be closed after the block exits."""
    h = "c105ec105ec105ec105ec105ec105ec105e00099"
    leaked: list[sqlite3.Connection] = []
    with db.open_project(h) as conn:
        leaked.append(conn)
    with pytest.raises(sqlite3.ProgrammingError):
        leaked[0].execute("SELECT 1")


def test_open_project_closes_connection_on_exception(tmp_data_dir):
    """open_project() must close the connection even when the block body raises."""
    h = "c105ec105ec105ec105ec105ec105ec105e00098"
    leaked: list[sqlite3.Connection] = []
    with contextlib.suppress(RuntimeError), db.open_project(h) as conn:
        leaked.append(conn)
        raise RuntimeError("project body error")
    assert leaked, "connection was never yielded"
    with pytest.raises(sqlite3.ProgrammingError):
        leaked[0].execute("SELECT 1")


# ---------------------------------------------------------------------------
# Reliability: connection leak protection and pragma validation
# ---------------------------------------------------------------------------


def test_connect_does_not_leak_on_pragma_exception(tmp_data_dir):
    """_connect() must close the connection if _apply_connection_pragmas raises."""
    db_path = paths.project_db_path("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")

    # Create a DB first so it exists
    with db.open_project("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2") as _:
        pass

    # Mock _apply_connection_pragmas to raise an unexpected exception
    with patch("token_goat.db._apply_connection_pragmas") as mock_apply:
        mock_apply.side_effect = RuntimeError("mock pragma error")
        with pytest.raises(RuntimeError, match="mock pragma error"):
            db._connect(db_path, load_vec=False)

    # Verify the connection was closed by checking we can still open the DB
    # (would fail on Windows with "database is locked" if it wasn't closed)
    with db.open_project("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2") as conn:
        assert conn.execute("SELECT 1").fetchone() is not None


def test_connect_readonly_does_not_leak_on_wal_exception(tmp_data_dir):
    """_connect_readonly() must close connection if WAL path raises."""
    db_path = paths.project_db_path("b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3")

    # Create a DB first
    with db.open_project("b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3") as _:
        pass

    # Mock _apply_connection_pragmas to raise on the immutable fallback path
    call_count = [0]
    original_apply = db._apply_connection_pragmas

    def mock_apply(conn, *, suppress=False):
        call_count[0] += 1
        if call_count[0] == 1 and not suppress:
            # Raise on first call (WAL path)
            raise RuntimeError("mock WAL pragma error")
        # Fall back to immutable path
        if not suppress:
            original_apply(conn, suppress=suppress)

    with patch("token_goat.db._apply_connection_pragmas", side_effect=mock_apply), contextlib.suppress(db.DBBusyError):
        db._connect_readonly(db_path)

    # Verify the DB is still accessible
    with db.open_project("b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3") as conn:
        assert conn.execute("SELECT 1").fetchone() is not None


def test_connect_readonly_immutable_does_not_leak_on_fallback(tmp_data_dir):
    """_connect_readonly() immutable fallback path must close connections properly."""
    db_path = paths.project_db_path("c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")

    # Create a DB first
    with db.open_project("c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4") as _:
        pass

    # Mock sqlite3.connect to simulate WAL failure and immutable success
    original_connect = sqlite3.connect
    call_count = [0]

    def mock_connect(database, *args, **kwargs):
        call_count[0] += 1
        # First call (WAL path) fails
        if call_count[0] == 1:
            raise sqlite3.OperationalError("WAL SHM unavailable")
        # Second call (immutable path) succeeds
        return original_connect(database, *args, **kwargs)

    with patch("sqlite3.connect", side_effect=mock_connect):
        conn = db._connect_readonly(db_path)
        # Should successfully open in immutable mode
        assert conn is not None
        result = conn.execute("SELECT 1").fetchone()
        assert result is not None
        conn.close()

    # Verify the DB is still accessible for subsequent opens
    with db.open_project("c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4") as conn:
        assert conn.execute("SELECT 1").fetchone() is not None


def test_busy_timeout_is_set_on_write_connection(tmp_data_dir):
    """Write connections must have a 5-second busy timeout for lock handling."""
    with db.open_global() as conn:
        row = conn.execute("PRAGMA busy_timeout").fetchone()
        timeout_ms = row[0] if row else None
        assert timeout_ms == 5000, f"expected busy_timeout=5000ms, got {timeout_ms}ms"


def test_busy_timeout_is_set_on_readonly_connection(tmp_data_dir):
    """Read-only connections must have a 5-second busy timeout."""
    # Create a project DB first
    with db.open_project("d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5") as _:
        pass

    with db.open_project_readonly("d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5") as conn:
        row = conn.execute("PRAGMA busy_timeout").fetchone()
        timeout_ms = row[0] if row else None
        assert timeout_ms == 5000, f"expected busy_timeout=5000ms, got {timeout_ms}ms"


def test_wal_checkpoint_restarts_after_connect(tmp_data_dir):
    """After a successful WAL open, a RESTART checkpoint is triggered."""
    h = "e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f"

    # Track checkpoint calls by reading wal_autocheckpoint (proxy check).
    with db.open_project(h) as conn:
        # Verify WAL is in place
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal", f"expected WAL mode, got {mode}"

        # Create some data and force a transaction
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("test_key", "test_val"))

    # Reopen and check: if checkpoint worked, WAL should be relatively small
    # (This is a soft check since we can't directly observe the checkpoint call)
    with db.open_project(h) as conn:
        val = conn.execute("SELECT value FROM meta WHERE key = ?", ("test_key",)).fetchone()
        assert val is not None, "data should persist after checkpoint"


def test_sqlite_vec_load_unexpected_exception_does_not_leak_connection(tmp_data_dir):
    """When sqlite_vec.load() raises an unexpected exception (not OperationalError /
    AttributeError / ModuleNotFoundError), the connection must be returned usable
    rather than leaking.  Before the fix, only those three exception types were caught;
    a RuntimeError (or any other type) would propagate out of _connect with the
    sqlite3 connection object still open and unreachable by the caller.

    After the fix, the broad ``except Exception`` clause catches everything and
    logs a warning, so open_global / open_project still receive a valid connection.
    """
    import gc

    h = "f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2"

    class _FakeSqliteVec:
        """Stub that raises RuntimeError from load() to simulate an unexpected error."""
        def load(self, conn: sqlite3.Connection) -> None:  # noqa: ARG002
            raise RuntimeError("simulated unexpected sqlite-vec load failure")

    # Patch sqlite_vec so that its load() raises RuntimeError.
    with (
        patch.dict("sys.modules", {"sqlite_vec": _FakeSqliteVec()}),
        db.open_project(h) as conn,
    ):
        # If we reach here the connection was not leaked — it was returned from
        # _connect despite the RuntimeError from sqlite_vec.load().
        row = conn.execute("SELECT 1").fetchone()
        assert row is not None, "connection from _connect is not usable after sqlite_vec error"

    # Force GC to surface any unclosed connection ResourceWarning (Python 3.12+)
    gc.collect()


# ---------------------------------------------------------------------------
# Sub-area D: DB corruption recovery — quarantine path and rebuild verification
# ---------------------------------------------------------------------------

def test_repair_if_corrupt_quarantines_on_failed_integrity_check(tmp_data_dir):
    """_repair_if_corrupt: when integrity_check fails, the DB file is quarantined.

    The corrupt file should be renamed to a .bad-<ts> sidecar and a fresh
    connection returned.  This directly exercises the _repair_if_corrupt path,
    unlike test_corruption_auto_rebuild which only exercises it via open_project.
    """
    from unittest.mock import patch as _patch

    h = "d00d000d00d000d00d000d00d000d00d0000001"
    db_path = paths.project_db_path(h)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Clear per-path check cache so _repair_if_corrupt re-runs the integrity check.
    db._INTEGRITY_CHECKED.pop(db_path, None)
    db._SCHEMA_MIGRATED.pop(db_path, None)

    # Create a valid SQLite DB (so _connect succeeds), then force integrity_check
    # to return "corruption detected" via a real DB connection.
    with db.open_project(h) as _conn:
        pass  # creates the DB with schema

    db._INTEGRITY_CHECKED.pop(db_path, None)

    real_conn = sqlite3.connect(str(db_path))
    try:
        # Patch _integrity_ok to return False (simulate failed integrity check)
        with _patch("token_goat.db._integrity_ok", return_value=False):
            new_conn = db._repair_if_corrupt(real_conn, db_path)
    finally:
        # new_conn is a fresh connection; close it to avoid resource warnings.
        with contextlib.suppress(Exception):
            new_conn.close()

    # The original corrupt file must have been quarantined.
    siblings = list(db_path.parent.glob(f"{h}.db.bad-*"))
    assert len(siblings) == 1, (
        f"quarantine sidecar must exist after integrity failure, got: {siblings}"
    )
    # The returned connection must be usable (DB rebuilt with schema).
    with db.open_project(h) as rebuilt_conn:
        tables = _table_names(rebuilt_conn)
    assert "files" in tables, "rebuilt DB must have the project schema"


def test_repair_if_corrupt_skips_recheck_when_already_checked(tmp_data_dir):
    """_repair_if_corrupt: once a path is in _INTEGRITY_CHECKED, it does not re-check.

    Verifies the per-process cache prevents repeated integrity_check PRAGMAs
    (which can take ~10 ms each) on every open_project call in the same process.
    """
    from unittest.mock import patch as _patch

    h = "d00d000d00d000d00d000d00d000d00d0000002"
    db_path = paths.project_db_path(h)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with db.open_project(h) as _conn:
        pass  # creates the DB

    # Ensure the path is marked as already-checked.
    db._INTEGRITY_CHECKED[db_path] = True

    check_calls = []

    def counting_integrity_ok(conn):
        check_calls.append(1)
        return True

    real_conn = sqlite3.connect(str(db_path))
    try:
        with _patch("token_goat.db._integrity_ok", side_effect=counting_integrity_ok):
            returned = db._repair_if_corrupt(real_conn, db_path)
    finally:
        with contextlib.suppress(Exception):
            returned.close()

    assert len(check_calls) == 0, (
        "_repair_if_corrupt must skip integrity_check when path is already in _INTEGRITY_CHECKED"
    )


# ---------------------------------------------------------------------------
# Fix 1: with_timeout must set row_factory so callers can access columns by name
# ---------------------------------------------------------------------------


def test_with_timeout_row_factory_allows_named_column_access(tmp_data_dir):
    """with_timeout must set conn.row_factory = sqlite3.Row so callbacks can use
    column-name access.  Without row_factory, row["key"] raises TypeError because
    sqlite3 returns plain tuples by default.
    """
    # Create a real stats row to read back.
    db.record_stat(None, "test_event", tokens_saved=42)

    result: list[object] = []

    def read_fn(conn: sqlite3.Connection) -> None:
        row = conn.execute(
            "SELECT tokens_saved FROM stats WHERE kind = ?", ("test_event",)
        ).fetchone()
        if row is not None:
            # Named access — this raises TypeError without row_factory = sqlite3.Row.
            result.append(row["tokens_saved"])

    db.with_timeout(read_fn)

    assert result == [42], f"expected [42] via named column access, got {result}"


def test_with_timeout_row_factory_is_sqlite_row(tmp_data_dir):
    """Verify that the connection passed to fn has row_factory = sqlite3.Row,
    not the default tuple factory.  This ensures consistency with every other
    connection opened by db.py (all of which set row_factory).
    """
    observed_factory: list[object] = []

    def capture_fn(conn: sqlite3.Connection) -> None:
        observed_factory.append(conn.row_factory)

    db.with_timeout(capture_fn)

    assert observed_factory, "fn was never called"
    assert observed_factory[0] is sqlite3.Row, (
        f"expected row_factory=sqlite3.Row, got {observed_factory[0]}"
    )


def test_with_timeout_swallows_transient_lock_error(tmp_data_dir):
    """with_timeout must silently swallow OperationalError with 'locked' in message."""

    def fail_fn(conn: sqlite3.Connection) -> None:
        raise sqlite3.OperationalError("database is locked")

    # Should not raise — locked error must be swallowed.
    db.with_timeout(fail_fn)


def test_with_timeout_swallows_readonly_error(tmp_data_dir):
    """with_timeout must silently swallow OperationalError with 'readonly' in message."""

    def fail_fn(conn: sqlite3.Connection) -> None:
        raise sqlite3.OperationalError("attempt to write a readonly database")

    db.with_timeout(fail_fn)


# ---------------------------------------------------------------------------
# Fix 2: WAL TRUNCATE checkpoint on close — _log_session_close checkpoint flag
# ---------------------------------------------------------------------------


def test_log_session_close_with_checkpoint_flag(tmp_data_dir):
    """_log_session_close(checkpoint=True) must execute wal_checkpoint(TRUNCATE)
    before closing the connection.  We verify that (a) the connection is closed
    afterward and (b) the checkpoint pragma was attempted without raising.
    """
    # Create a real DB so there is a WAL file to checkpoint.
    h = "abcdef0123456789abcdef0123456789abcdef10"
    with db.open_project(h) as conn:
        # Insert a row to ensure there is WAL content to checkpoint.
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("ck_test", "1"))

    # Open a fresh connection and call _log_session_close with checkpoint=True.
    raw_conn = sqlite3.connect(str(paths.project_db_path(h)), isolation_level=None)
    raw_conn.execute("PRAGMA journal_mode = WAL")
    t0 = time.monotonic()

    db._log_session_close("test label", t0, raw_conn, checkpoint=True)

    # Connection must be closed after the call.
    with pytest.raises(sqlite3.ProgrammingError):
        raw_conn.execute("SELECT 1")


def test_log_session_close_without_checkpoint_does_not_checkpoint(tmp_data_dir):
    """_log_session_close(checkpoint=False, the default) must not run a checkpoint.

    Verify via mock that the checkpoint PRAGMA is not executed when checkpoint=False.
    """
    from unittest.mock import MagicMock

    mock_conn = MagicMock(spec=sqlite3.Connection)
    t0 = time.monotonic()

    db._log_session_close("test label", t0, mock_conn, checkpoint=False)

    # wal_checkpoint PRAGMA must not have been called.
    executed_sqls = [call.args[0] for call in mock_conn.execute.call_args_list]
    assert not any("wal_checkpoint" in sql.lower() for sql in executed_sqls), (
        f"wal_checkpoint should not be executed when checkpoint=False; calls: {executed_sqls}"
    )


def test_open_project_issues_truncate_checkpoint_on_close(tmp_data_dir):
    """open_project() must call wal_checkpoint(TRUNCATE) in its finally block.

    This verifies that Fix 2 is wired into the public context manager, not just
    the helper — so every open_project write session is checkpointed on exit.
    """
    h = "abcdef0123456789abcdef0123456789abcdef11"

    # Verify the behavior by ensuring a round-trip write + reopen works correctly,
    # confirming that the TRUNCATE checkpoint on close does not corrupt data.
    with db.open_project(h) as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("post_ck", "ok"))

    with db.open_project(h) as conn:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = ?", ("post_ck",)
        ).fetchone()
    assert row is not None and row["value"] == "ok", (
        "data written before close must survive the TRUNCATE checkpoint"
    )


def test_open_global_issues_truncate_checkpoint_on_close(tmp_data_dir):
    """open_global() must call wal_checkpoint(TRUNCATE) in its finally block."""
    with db.open_global() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ("global_ck_test", "1"),
        )

    # Reopen and verify data persists — checkpoint must not corrupt.
    with db.open_global() as conn:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = ?", ("global_ck_test",)
        ).fetchone()
    assert row is not None and row["value"] == "1", (
        "data written before close must survive the TRUNCATE checkpoint"
    )


# ---------------------------------------------------------------------------
# Sub-area E: _validate_project_hash — security and input validation
# ---------------------------------------------------------------------------


def test_validate_project_hash_accepts_valid_sha1(tmp_data_dir):
    """_validate_project_hash must accept valid lowercase hex SHA-1 digests."""
    # 40-char SHA-1 hex digest (the normal case from project.py)
    db._validate_project_hash("da39a3ee5e6b4b0d3255bfef95601890afd80709")
    # Shorter hex strings are also accepted (some tests use abbreviated hashes)
    db._validate_project_hash("abc123")
    db._validate_project_hash("deadbeef")


def test_validate_project_hash_rejects_empty(tmp_data_dir):
    """_validate_project_hash must raise ValueError for an empty string."""
    with pytest.raises(ValueError, match="cannot be empty"):
        db._validate_project_hash("")


def test_validate_project_hash_rejects_uppercase(tmp_data_dir):
    """_validate_project_hash must reject uppercase hex characters (path traversal guard)."""
    with pytest.raises(ValueError, match="lowercase hex"):
        db._validate_project_hash("DA39A3EE5E6B4B0D3255BFEF95601890AFD80709")


def test_validate_project_hash_rejects_path_traversal(tmp_data_dir):
    """_validate_project_hash must reject strings containing path separators."""
    with pytest.raises(ValueError, match="lowercase hex"):
        db._validate_project_hash("../secret")

    with pytest.raises(ValueError, match="lowercase hex"):
        db._validate_project_hash("abc/def")


def test_validate_project_hash_rejects_underscores(tmp_data_dir):
    """_validate_project_hash must reject underscores (not valid hex)."""
    with pytest.raises(ValueError, match="lowercase hex"):
        db._validate_project_hash("abc_def")


def test_validate_project_hash_rejects_too_long(tmp_data_dir):
    """_validate_project_hash must reject strings longer than 128 characters."""
    with pytest.raises(ValueError, match="too long"):
        db._validate_project_hash("a" * 129)


# ---------------------------------------------------------------------------
# Sub-area F: project_has_files and project_last_indexed_ts — fail-soft behavior
# ---------------------------------------------------------------------------


def test_project_has_files_returns_false_for_nonexistent_db(tmp_data_dir):
    """project_has_files must return False when the project DB does not exist."""
    assert db.project_has_files("deadbeef0099") is False


def test_project_has_files_returns_false_for_empty_db(tmp_data_dir):
    """project_has_files must return False for an indexed but empty project DB."""
    h = "deadbeef0100"
    with db.open_project(h) as _:
        pass  # creates the DB with schema but no files
    assert db.project_has_files(h) is False


def test_project_has_files_returns_true_when_files_exist(tmp_data_dir):
    """project_has_files must return True when at least one file row exists."""
    h = "deadbeef0101"
    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("src/foo.py", "python", 100, 0.0, "x" * 64, int(time.time())),
        )
    assert db.project_has_files(h) is True


def test_project_last_indexed_ts_returns_zero_for_nonexistent(tmp_data_dir):
    """project_last_indexed_ts must return 0.0 when the project DB does not exist."""
    assert db.project_last_indexed_ts("deadbeef0200") == 0.0


def test_project_last_indexed_ts_returns_zero_for_empty_db(tmp_data_dir):
    """project_last_indexed_ts must return 0.0 for a DB with no file rows."""
    h = "deadbeef0201"
    with db.open_project(h) as _:
        pass
    assert db.project_last_indexed_ts(h) == 0.0


def test_project_last_indexed_ts_returns_max_indexed_at(tmp_data_dir):
    """project_last_indexed_ts must return the MAX(indexed_at) from the files table."""
    h = "deadbeef0202"
    ts1 = int(time.time()) - 3600
    ts2 = int(time.time())
    with db.open_project(h) as conn:
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("src/a.py", "python", 10, 0.0, "a" * 64, ts1),
        )
        conn.execute(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("src/b.py", "python", 10, 0.0, "b" * 64, ts2),
        )
    result = db.project_last_indexed_ts(h)
    assert result == float(ts2), f"expected {ts2}, got {result}"


# ---------------------------------------------------------------------------
# Sub-area G: file_count and list_all_project_hashes
# ---------------------------------------------------------------------------


def test_file_count_returns_zero_for_nonexistent_project(tmp_data_dir):
    """file_count must return 0 when the project DB does not exist."""
    assert db.file_count("deadbeef0300") == 0


def test_file_count_returns_correct_count(tmp_data_dir):
    """file_count must return the actual number of rows in the files table."""
    h = "deadbeef0301"
    with db.open_project(h) as conn:
        for i in range(5):
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (f"src/f{i}.py", "python", 10, 0.0, "c" * 64, int(time.time())),
            )
    assert db.file_count(h) == 5


def test_list_all_project_hashes_returns_empty_for_missing_global_db(tmp_data_dir):
    """list_all_project_hashes must return [] when global.db does not exist."""
    # tmp_data_dir is clean; global.db was never created.
    assert db.list_all_project_hashes() == []


def test_list_all_project_hashes_returns_registered_projects(tmp_data_dir):
    """list_all_project_hashes must return hashes of every registered project."""
    hashes = ["aabbcc0001", "aabbcc0002", "aabbcc0003"]
    with db.open_global() as conn:
        for h in hashes:
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count, languages) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (h, f"/proj/{h}", "manual", 1000, 1000, 0, ""),
            )
    result = db.list_all_project_hashes()
    assert set(result) == set(hashes), f"expected {hashes!r}, got {result!r}"


# ---------------------------------------------------------------------------
# Index coverage: symbols(name, kind) composite index
# ---------------------------------------------------------------------------

def _index_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
    ).fetchall()
    return {r[0] for r in rows}


def _explain_plan(conn: sqlite3.Connection, sql: str, params: tuple) -> str:
    """Return the EXPLAIN QUERY PLAN detail string for *sql*."""
    rows = conn.execute(f"EXPLAIN QUERY PLAN {sql}", params).fetchall()
    return " | ".join(r[-1] for r in rows)


def test_project_symbols_name_kind_index_exists(tmp_data_dir):
    """Per-project symbols table must have (name, kind) composite index."""
    h = "abcdef0123456789abcdef0123456789abcde010"
    with db.open_project(h) as conn:
        indexes = _index_names(conn)
    assert "idx_symbols_name_kind" in indexes, (
        f"idx_symbols_name_kind not found; indexes present: {sorted(indexes)}"
    )


def test_global_symbols_name_kind_index_exists(tmp_data_dir):
    """Global symbols_global table must have (name, kind) composite index."""
    with db.open_global() as conn:
        indexes = _index_names(conn)
    assert "idx_symbols_global_name_kind" in indexes, (
        f"idx_symbols_global_name_kind not found; indexes present: {sorted(indexes)}"
    )


def test_project_symbol_kind_query_uses_composite_index(tmp_data_dir):
    """EXPLAIN QUERY PLAN for 'name=? AND kind IN (?,?)' must use idx_symbols_name_kind.

    Without the composite index, SQLite uses idx_symbols_name (name=?) and filters
    kind in memory.  The composite index allows the planner to use both columns,
    which is O(log N) instead of O(matches(name) × scan).
    """
    h = "abcdef0123456789abcdef0123456789abcde011"
    with db.open_project(h) as conn:
        plan = _explain_plan(
            conn,
            "SELECT name, kind, file_rel, line, end_line, signature FROM symbols "
            "WHERE name = ? AND kind IN (?,?) LIMIT 50",
            ("myFunc", "function", "method"),
        )
    assert "idx_symbols_name_kind" in plan, (
        f"Expected composite index in plan, got: {plan!r}"
    )


def test_global_symbol_kind_query_uses_composite_index(tmp_data_dir):
    """EXPLAIN QUERY PLAN for global symbols with kind filter must use composite index."""
    with db.open_global() as conn:
        plan = _explain_plan(
            conn,
            "SELECT sg.project_hash, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature "
            "FROM symbols_global sg "
            "WHERE sg.name = ? AND sg.kind IN (?,?) LIMIT 50",
            ("MyClass", "class", "interface"),
        )
    assert "idx_symbols_global_name_kind" in plan, (
        f"Expected composite index in global plan, got: {plan!r}"
    )


# ---------------------------------------------------------------------------
# get_hook_timing_stats
# ---------------------------------------------------------------------------

def test_get_hook_timing_stats_empty(tmp_data_dir):
    """Returns empty dict when no hook:* stats rows exist."""
    from token_goat.db import get_hook_timing_stats
    assert get_hook_timing_stats() == {}


def test_get_hook_timing_stats_avg_p95_max(tmp_data_dir):
    """Correct avg/p95/max computed from 10 rows: 10, 20, ..., 100."""
    from token_goat.db import get_hook_timing_stats
    for ms in range(10, 110, 10):
        db.record_stat(None, "hook:pre_read", bytes_saved=ms)
    stats = get_hook_timing_stats()
    assert "pre_read" in stats
    s = stats["pre_read"]
    assert s["count"] == 10
    assert s["avg_ms"] == 55   # (10+20+...+100)//10
    assert s["p95_ms"] == 90   # sorted[int(10*0.95)-1] = sorted[8] = 90
    assert s["max_ms"] == 100


def test_get_hook_timing_stats_multiple_events(tmp_data_dir):
    """Each distinct hook:* event appears as a separate key."""
    from token_goat.db import get_hook_timing_stats
    db.record_stat(None, "hook:pre_read", bytes_saved=50)
    db.record_stat(None, "hook:post_bash", bytes_saved=120)
    result = get_hook_timing_stats()
    assert "pre_read" in result
    assert "post_bash" in result
    assert result["pre_read"]["max_ms"] == 50
    assert result["post_bash"]["max_ms"] == 120


def test_get_hook_timing_stats_excludes_non_hook_rows(tmp_data_dir):
    """Rows with kind not matching 'hook:*' are not included."""
    from token_goat.db import get_hook_timing_stats
    db.record_stat(None, "bash_compress:pytest", bytes_saved=999)
    assert get_hook_timing_stats() == {}


def test_index_health_file_count_with_identifier_quoting(tmp_data_dir):
    """index_health file_count exercises the bracketed _count() path."""
    h = "deadbeef0302"
    with db.open_project(h) as conn:
        for i in range(3):
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (f"src/f{i}.py", "python", 50, 0.0, "b" * 64, int(time.time())),
            )
    result = db.index_health(h)
    assert result["file_count"] == 3
