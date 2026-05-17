"""Tests for token_goat.db."""
from __future__ import annotations

import os
import sqlite3
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
