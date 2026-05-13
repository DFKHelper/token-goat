"""SQLite + sqlite-vec storage layer. Phase 2."""
from __future__ import annotations

import contextlib
import logging
import os
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path

import sqlite_vec

from . import paths

SCHEMA_VERSION = 1
EMBED_DIM = 384  # BAAI/bge-small-en-v1.5

_LOG = logging.getLogger("tokenwise.db")


class VecExtensionUnavailable(Exception):
    """sqlite-vec couldn't be loaded — embeddings disabled."""


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

def _connect(db_path: Path, *, load_vec: bool = True) -> sqlite3.Connection:
    """Open a connection with WAL, foreign keys, and (optional) sqlite-vec."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), isolation_level=None, timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
    except sqlite3.DatabaseError:
        # Close the handle before raising so callers can rename/delete the file.
        conn.close()
        raise
    if load_vec:
        try:
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
        except (sqlite3.OperationalError, AttributeError) as e:
            _LOG.warning("sqlite-vec unavailable: %s", e)
    return conn


# ---------------------------------------------------------------------------
# Corruption detection + auto-rebuild
# ---------------------------------------------------------------------------

def _integrity_ok(conn: sqlite3.Connection) -> bool:
    """Return True if the DB is verifiably healthy.

    Note: an exception or "busy/locked" result is NOT evidence of corruption.
    Only an explicit non-"ok" result from PRAGMA integrity_check counts. The
    previous version treated every DatabaseError as corruption, which on
    Windows caused false positives when the worker held the file open during
    indexing. Tokenwise then tried to quarantine a perfectly healthy DB,
    failed with WinError 5, and surfaced "Exit code: 1" to the agent.
    """
    try:
        row = conn.execute("PRAGMA integrity_check").fetchone()
    except sqlite3.DatabaseError as e:
        msg = str(e).lower()
        if "locked" in msg or "busy" in msg or "i/o" in msg:
            return True  # transient — not corruption
        # Anything else: log but still don't quarantine reflexively.
        _LOG.warning("integrity_check raised (treating as healthy): %s", e)
        return True
    if row is None:
        return True
    return row[0] == "ok"


def _rebuild(db_path: Path) -> bool:
    """Try to quarantine a corrupt file. Returns True on success.

    Never raises. If the file is in use by another process (Windows file
    lock), logs and returns False so callers can continue with the existing
    connection rather than destroying user data.
    """
    if not db_path.exists():
        return False
    bad = db_path.with_suffix(db_path.suffix + f".bad-{int(time.time())}")
    try:
        db_path.rename(bad)
        _LOG.warning("quarantined corrupt db: %s -> %s", db_path, bad)
        return True
    except OSError as e:
        _LOG.error("failed to quarantine %s: %s (continuing with existing DB)", db_path, e)
        return False


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

_GLOBAL_TABLES = """
CREATE TABLE IF NOT EXISTS projects (
    hash       TEXT    PRIMARY KEY,
    root       TEXT    NOT NULL,
    marker     TEXT    NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    languages  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS symbols_global (
    project_hash TEXT NOT NULL,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    file_rel     TEXT NOT NULL,
    line         INTEGER NOT NULL,
    signature    TEXT,
    FOREIGN KEY (project_hash) REFERENCES projects(hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_global_name    ON symbols_global(name);
CREATE INDEX IF NOT EXISTS idx_symbols_global_project ON symbols_global(project_hash);

CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved  INTEGER NOT NULL DEFAULT 0,
    detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_global_ts   ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_global_kind ON stats(kind);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_PROJECT_TABLES = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    rel_path       TEXT    PRIMARY KEY,
    language       TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    mtime          REAL    NOT NULL,
    content_sha256 TEXT    NOT NULL,
    indexed_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    file_rel  TEXT    NOT NULL,
    line      INTEGER NOT NULL,
    col       INTEGER NOT NULL DEFAULT 0,
    end_line  INTEGER,
    signature TEXT,
    parent_id INTEGER,
    FOREIGN KEY (file_rel)   REFERENCES files(rel_path) ON DELETE CASCADE,
    FOREIGN KEY (parent_id)  REFERENCES symbols(id)     ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_rel);

CREATE TABLE IF NOT EXISTS refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_name TEXT    NOT NULL,
    file_rel    TEXT    NOT NULL,
    line        INTEGER NOT NULL,
    col         INTEGER NOT NULL DEFAULT 0,
    context     TEXT,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_name);

CREATE TABLE IF NOT EXISTS sections (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel TEXT    NOT NULL,
    heading  TEXT    NOT NULL,
    level    INTEGER NOT NULL DEFAULT 1,
    line     INTEGER NOT NULL,
    end_line INTEGER,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sections_file    ON sections(file_rel);
CREATE INDEX IF NOT EXISTS idx_sections_heading ON sections(heading);

CREATE TABLE IF NOT EXISTS imports_exports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    target   TEXT    NOT NULL,
    line     INTEGER NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_imex_file ON imports_exports(file_rel);

CREATE TABLE IF NOT EXISTS chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel       TEXT    NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    content_sha256 TEXT    NOT NULL,
    kind           TEXT    NOT NULL,
    text           TEXT    NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_rel);
CREATE INDEX IF NOT EXISTS idx_chunks_sha  ON chunks(content_sha256);

CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved  INTEGER NOT NULL DEFAULT 0,
    detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_ts   ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_kind ON stats(kind);
"""

_EMBEDDINGS_DDL = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    chunk_id  INTEGER PRIMARY KEY,
    embedding FLOAT[{EMBED_DIM}]
);
"""


def _ensure_global_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_GLOBAL_TABLES)
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )


def _ensure_project_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_PROJECT_TABLES)
    # Try to create the sqlite-vec virtual table.
    try:
        conn.executescript(_EMBEDDINGS_DDL)
    except sqlite3.OperationalError as e:
        _LOG.warning("embeddings table unavailable: %s", e)
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('embeddings_disabled', '1')"
        )
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )


# ---------------------------------------------------------------------------
# Public context managers
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def open_global() -> Iterator[sqlite3.Connection]:
    """Yield a connection to global.db with schema applied."""
    path = paths.global_db_path()
    try:
        conn = _connect(path)
    except sqlite3.DatabaseError as exc:
        _LOG.warning("corrupt db at connect time: %s", exc)
        _rebuild(path)
        conn = _connect(path)
    try:
        if not _integrity_ok(conn):
            conn.close()
            # Try quarantine; whether it succeeds or fails, just reopen the
            # (possibly-new) file. If quarantine failed (Windows lock), we
            # reopen the original and proceed; better than crashing.
            _rebuild(path)
            conn = _connect(path)
        _ensure_global_schema(conn)
        yield conn
    finally:
        conn.close()


@contextlib.contextmanager
def open_project(project_hash: str) -> Iterator[sqlite3.Connection]:
    """Yield a connection to a per-project DB with schema applied."""
    path = paths.project_db_path(project_hash)
    try:
        conn = _connect(path)
    except sqlite3.DatabaseError as exc:
        _LOG.warning("corrupt db at connect time: %s", exc)
        _rebuild(path)
        conn = _connect(path)
    try:
        if not _integrity_ok(conn):
            conn.close()
            # Try quarantine; whether it succeeds or fails, just reopen the
            # (possibly-new) file. If quarantine failed (Windows lock), we
            # reopen the original and proceed; better than crashing.
            _rebuild(path)
            conn = _connect(path)
        _ensure_project_schema(conn)
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Writer lockfile
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def project_writer_lock(project_hash: str, timeout_sec: float = 5.0) -> Iterator[None]:
    """File-based writer lock for a project DB.

    Writes <locks_dir>/<hash>.lock containing ``<pid>\\n<timestamp>``.
    Stale locks (>10 min old, or owning PID not alive) are auto-cleared.
    Raises TimeoutError if the lock cannot be acquired within *timeout_sec*.
    """
    import psutil

    lock_path = paths.locks_dir() / f"{project_hash}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_sec
    pid = os.getpid()

    def _stale(lock_text: str) -> bool:
        try:
            parts = lock_text.strip().split("\n", 1)
            owner_pid = int(parts[0])
            owner_ts = float(parts[1]) if len(parts) > 1 else 0.0
            if time.time() - owner_ts > 600:  # 10 min
                return True
            return not psutil.pid_exists(owner_pid)
        except (ValueError, IndexError):
            return True  # malformed → treat as stale

    def _try_acquire() -> bool:
        if lock_path.exists():
            try:
                text = lock_path.read_text(encoding="utf-8")
                if not _stale(text):
                    return False
                # Stale — remove and fall through to create
                lock_path.unlink(missing_ok=True)
            except OSError:
                return False
        try:
            lock_path.write_text(f"{pid}\n{time.time()}", encoding="utf-8")
            return True
        except OSError:
            return False

    acquired = False
    while True:
        if _try_acquire():
            acquired = True
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    if not acquired:
        raise TimeoutError(
            f"could not acquire writer lock for project {project_hash[:8]} "
            f"within {timeout_sec}s"
        )
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            lock_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Stats helper
# ---------------------------------------------------------------------------

def file_count(project_hash: str) -> int:
    """How many files are indexed for this project. 0 means never indexed."""
    try:
        with open_project(project_hash) as conn:
            row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
            return int(row[0]) if row else 0
    except Exception:  # noqa: BLE001
        return 0


def record_stat(
    project_hash: str | None,
    kind: str,
    tokens_saved: int = 0,
    bytes_saved: int = 0,
    detail: str | None = None,
) -> None:
    """Append a row to the stats table of the appropriate DB."""
    ts = int(time.time())
    sql = "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail) VALUES (?, ?, ?, ?, ?)"
    params = (ts, kind, tokens_saved, bytes_saved, detail)
    try:
        if project_hash is not None:
            with open_project(project_hash) as conn:
                conn.execute(sql, params)
        else:
            with open_global() as conn:
                conn.execute(sql, params)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("record_stat failed: %s", exc)
