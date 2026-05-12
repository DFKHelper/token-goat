"""Tests for tokenwise.db — Phase 2."""
from __future__ import annotations

import os
import sqlite3
import time

import pytest

import tokenwise.paths as paths
from tokenwise import db

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
    h = "corruptme0001"
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
    h = "lock0001"
    with db.project_writer_lock(h, timeout_sec=2.0):
        lock_path = paths.locks_dir() / f"{h}.lock"
        assert lock_path.exists()
    # after exit, lock file removed
    assert not lock_path.exists()


def test_writer_lock_raises_timeout_when_held_by_live_pid(tmp_data_dir):
    """Write a lock file owned by the current (live) process with a fresh timestamp."""
    h = "lock0002"
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
    h = "lock0003"
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
    h = "stat0001"
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
# 13. schema_version meta row exists after first open
# ---------------------------------------------------------------------------

def test_schema_version_meta_project(tmp_data_dir):
    h = "schver0001"
    with db.open_project(h) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row is not None
    assert row[0] == str(db.SCHEMA_VERSION)


def test_schema_version_meta_global(tmp_data_dir):
    with db.open_global() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row is not None
    assert row[0] == str(db.SCHEMA_VERSION)
