"""Regression guard for unbounded global.db WAL growth.

A heavy multi-agent session drove ``global.db-wal`` to 11 GB: every hook writes
stat rows to ``global.db``, and passive autocheckpoints were perpetually blocked
by overlapping readers, so the WAL file only ever grew.  Once it was multi-GB
every connection that scanned it stalled for minutes, which is what made
``/compact`` (and every other hook) hang.

The fix has two halves, each guarded here:

1. Every connection sets ``PRAGMA journal_size_limit`` so the WAL *file* is
   truncated back down after a checkpoint instead of staying at its peak size.
2. The worker force-runs a ``wal_checkpoint(TRUNCATE)`` on ``global.db`` every
   maintenance cycle, draining the WAL on a schedule no matter how a burst
   behaved.

These tests fail on the pre-fix code (``journal_size_limit`` defaulted to -1
and ``worker._checkpoint_global_wal`` did not exist) and pass on the fixed code.
"""
from __future__ import annotations

import sqlite3

import token_goat.paths as paths
from token_goat import db, worker


def test_global_connection_caps_wal_file_size(tmp_data_dir):
    """global.db connections must set a positive journal_size_limit."""
    with db.open_global() as conn:
        limit = conn.execute("PRAGMA journal_size_limit").fetchone()[0]
    assert limit == db.WAL_SIZE_LIMIT_BYTES
    # -1 is SQLite's default and the dangerous value: with no limit the WAL
    # file is never truncated by a checkpoint and can grow without bound.
    assert limit > 0


def test_project_connection_caps_wal_file_size(tmp_data_dir):
    """Per-project DB connections must cap the WAL file size too."""
    project_hash = "a" * 40  # valid lowercase-hex SHA-1 shape
    with db.open_project(project_hash) as conn:
        limit = conn.execute("PRAGMA journal_size_limit").fetchone()[0]
    assert limit == db.WAL_SIZE_LIMIT_BYTES


def _global_wal_path():
    p = paths.global_db_path()
    return p.with_name(p.name + "-wal")


def test_checkpoint_global_wal_drains_a_bloated_wal(tmp_data_dir):
    """worker._checkpoint_global_wal must drain a WAL that grew under contention."""
    with db.open_global() as conn:
        conn.execute("CREATE TABLE wal_bloat (blob BLOB)")

    wal = _global_wal_path()

    # Pin the WAL with a long-lived read transaction: while it is open no
    # checkpoint can reset the WAL, so the writes below accumulate in the -wal
    # file exactly as they did during the real 11 GB incident.
    reader = sqlite3.connect(str(paths.global_db_path()), isolation_level=None)
    try:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM wal_bloat").fetchone()

        payload = b"x" * 4096
        with db.open_global() as writer:
            writer.executemany(
                "INSERT INTO wal_bloat (blob) VALUES (?)",
                # 150 rows × 4 KB = ~630 KB in the WAL, enough to exceed 500 KB.
                # Original 1200 rows (4.9 MB) proved the same assertion at 8× the I/O cost.
                [(payload,)] * 150,
            )

        bloated = wal.stat().st_size
        assert bloated > 500_000, f"WAL did not grow as expected: {bloated} bytes"

        # Release the read snapshot but keep the connection open, so the -wal
        # file is not deleted by a last-connection-close before the checkpoint.
        reader.rollback()

        reclaimed = worker._checkpoint_global_wal()
        after = wal.stat().st_size if wal.exists() else 0
    finally:
        reader.close()

    assert after < bloated, f"WAL not drained: {after} >= {bloated}"
    assert after < 100_000, f"WAL still large after checkpoint: {after} bytes"
    assert reclaimed > 0


def test_checkpoint_is_wired_into_the_maintenance_cycle(tmp_data_dir):
    """The checkpoint must run from cleanup_on_startup (the 5-min worker cycle).

    cleanup_on_startup records each task's result under its stat key only when
    the task ran without raising, so the presence of ``wal_bytes_reclaimed`` in
    the returned stats proves the checkpoint task is wired in and executed.
    """
    with db.open_global() as conn:
        conn.execute("SELECT 1")

    stats = worker.cleanup_on_startup()

    assert "wal_bytes_reclaimed" in stats
