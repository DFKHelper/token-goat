"""SQLite + sqlite-vec storage layer. Phase 2."""
from __future__ import annotations

import contextlib
import logging
import os
import re
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path

try:
    import sqlite_vec
except ModuleNotFoundError:
    sqlite_vec = None  # type: ignore[assignment]

from . import paths

SCHEMA_VERSION = 2
EMBED_DIM = 384  # BAAI/bge-small-en-v1.5

_LOG = logging.getLogger("token_goat.db")

# Cache integrity check results per DB file to avoid repeated PRAGMA checks
_INTEGRITY_CHECKED: dict[Path, bool] = {}


class DBError(Exception):
    """Base class for token-goat database errors."""


class DBCorruptionError(DBError):
    """DB integrity check failed; file quarantined."""


class DBBusyError(DBError):
    """DB locked or busy; caller may retry."""


class DBReadOnlyError(DBError):
    """DB is in read-only / sandbox mode; writes are silently dropped."""


class VecExtensionUnavailable(DBError):
    """sqlite-vec couldn't be loaded — embeddings disabled."""


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

def _connect(db_path: Path, *, load_vec: bool = True) -> sqlite3.Connection:
    """Open a connection with WAL, foreign keys, and (optional) sqlite-vec.

    Falls back to an *immutable read-only* connection when WAL coordination
    fails (e.g. Codex unelevated sandbox on Windows cannot create the WAL shm
    file).  The fallback connection bypasses WAL entirely and serves all read
    paths; any write attempt will fail with "attempt to write a readonly
    database", which is the correct behaviour for a sandboxed read-only caller.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), isolation_level=None, timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
    except sqlite3.OperationalError as e:
        # INFO (not WARNING): expected in sandboxed contexts like Codex
        # unelevated.  File loggers capture it; lastResort stderr handler
        # suppresses it so CLI output stays clean.
        _LOG.info(
            "WAL coordination unavailable for %s: %s — opening read-only (immutable)",
            db_path.name,
            e,
        )
        with contextlib.suppress(Exception):
            conn.close()
        uri = str(db_path.as_uri()) + "?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=10.0)
        conn.row_factory = sqlite3.Row
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute("PRAGMA busy_timeout = 5000")
        # Validate the fallback open with a real read; SQLite is otherwise lazy
        # and the failure would surface inside the caller's first query.
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    except sqlite3.DatabaseError:
        # Genuine corruption (not WAL/SHM access failure) — close so callers
        # can rename/delete the file, then re-raise.
        conn.close()
        raise
    if load_vec:
        try:
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            _LOG.debug("sqlite-vec loaded for %s", db_path.name)
        except (sqlite3.OperationalError, AttributeError) as e:
            _LOG.warning("sqlite-vec unavailable: %s", e)
    _LOG.debug("connection opened: %s", db_path.name)
    return conn


# ---------------------------------------------------------------------------
# Corruption detection + auto-rebuild
# ---------------------------------------------------------------------------

def _is_transient_db_error(error: sqlite3.DatabaseError) -> bool:
    """Check if a DatabaseError is transient (not evidence of corruption)."""
    msg = str(error).lower()
    return "locked" in msg or "busy" in msg or "i/o" in msg


def _integrity_ok(conn: sqlite3.Connection) -> bool:
    """Return True if the DB is verifiably healthy.

    Note: an exception or "busy/locked" result is NOT evidence of corruption.
    Only an explicit non-"ok" result from PRAGMA integrity_check counts. The
    previous version treated every DatabaseError as corruption, which on
    Windows caused false positives when the worker held the file open during
    indexing. token-goat then tried to quarantine a perfectly healthy DB,
    failed with WinError 5, and surfaced "Exit code: 1" to the agent.
    """
    try:
        row = conn.execute("PRAGMA integrity_check").fetchone()
    except sqlite3.DatabaseError as e:
        if _is_transient_db_error(e):
            return True
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
    line_count     INTEGER,
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

CREATE TABLE IF NOT EXISTS repomap_cache (
    rel_path      TEXT    NOT NULL,
    mtime         REAL    NOT NULL,
    size          INTEGER NOT NULL,
    summary_text  TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (rel_path, mtime, size),
    FOREIGN KEY (rel_path) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repomap_cache_file ON repomap_cache(rel_path);
"""

_EMBEDDINGS_DDL = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    chunk_id  INTEGER PRIMARY KEY,
    embedding FLOAT[{EMBED_DIM}]
);
"""


def _ensure_global_schema(conn: sqlite3.Connection) -> None:
    """Create or verify the global-DB tables and stamp the schema version.

    Safe to call on read-only connections (sandbox mode): DDL is skipped
    silently because the schema was already created by a prior writable open.
    """
    try:
        conn.executescript(_GLOBAL_TABLES)
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
    except sqlite3.OperationalError as e:
        # Read-only fallback connection (sandbox) cannot run DDL. The schema
        # already exists from prior writable opens — read-only callers can
        # proceed against the existing tables.
        if "readonly" in str(e).lower():
            _LOG.debug("global schema ensure skipped (read-only connection): %s", e)
        else:
            raise


def _ensure_project_schema(conn: sqlite3.Connection) -> None:
    """Create or verify the per-project tables including the sqlite-vec embeddings table.

    If the sqlite-vec extension is unavailable the embeddings table creation is
    skipped and a ``embeddings_disabled`` flag is written to the meta table so
    callers can degrade gracefully.  Safe to call on read-only connections.
    """
    try:
        conn.executescript(_PROJECT_TABLES)
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(files)").fetchall()
        }
        if "line_count" not in columns:
            conn.execute("ALTER TABLE files ADD COLUMN line_count INTEGER")
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    except sqlite3.OperationalError as e:
        if "readonly" in str(e).lower():
            _LOG.debug("project schema ensure skipped (read-only connection): %s", e)
            return
        raise
    # Try to create the sqlite-vec virtual table.
    try:
        conn.executescript(_EMBEDDINGS_DDL)
    except sqlite3.OperationalError as e:
        _LOG.warning("embeddings table unavailable: %s", e)
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('embeddings_disabled', '1')"
            )
# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _open_with_rebuild(path: Path, *, load_vec: bool = True) -> sqlite3.Connection:
    """Try _connect(); on DatabaseError, quarantine and retry once.

    Always re-raises if the second attempt also fails so callers get a clear
    exception rather than a silent None or an AttributeError later.
    """
    try:
        return _connect(path, load_vec=load_vec)
    except sqlite3.DatabaseError as exc:
        _LOG.warning("db open failed: %s — attempting quarantine and rebuild", exc)
        _rebuild(path)
        try:
            return _connect(path, load_vec=load_vec)
        except sqlite3.DatabaseError as exc2:
            _LOG.error("db open failed after quarantine attempt: %s", exc2)
            raise DBCorruptionError(
                f"DB unrecoverable after quarantine: {path.name}"
            ) from exc2


# ---------------------------------------------------------------------------
# Public context managers
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def open_global() -> Iterator[sqlite3.Connection]:
    """Yield a connection to global.db with schema applied."""
    path = paths.global_db_path()
    _LOG.info("opening global db: %s", path)
    conn = _open_with_rebuild(path)
    try:
        # Only check integrity once per file per session to avoid repeated PRAGMA checks
        if path not in _INTEGRITY_CHECKED and not _integrity_ok(conn):
            _LOG.info("integrity check failed; quarantining and rebuilding")
            conn.close()
            # Try quarantine; whether it succeeds or fails, just reopen the
            # (possibly-new) file. If quarantine failed (Windows lock), we
            # reopen the original and proceed; better than crashing.
            _rebuild(path)
            conn = _open_with_rebuild(path)
        _INTEGRITY_CHECKED[path] = True
        _ensure_global_schema(conn)
        yield conn
    finally:
        _LOG.debug("closing global db")
        with contextlib.suppress(Exception):
            conn.close()


# Maximum age (seconds) of a writer lock before it is treated as stale.
# A lock older than this is assumed to belong to a crashed process even if the
# PID still exists (e.g. recycled to an unrelated process).
LOCK_STALE_SECONDS = 600  # 10 minutes

_PROJECT_HASH_RE = re.compile(r"^[a-zA-Z0-9_]+$")

# Allowlist of table names permitted in dynamic COUNT queries.
# Using an allowlist instead of relying solely on call-site literals prevents
# SQL injection if _count() is ever called with externally-derived input.
_KNOWN_PROJECT_TABLES = frozenset(
    ["files", "symbols", "refs", "sections", "chunks", "embeddings"]
)


def _validate_project_hash(project_hash: str) -> None:
    """Validate project_hash to prevent path traversal attacks.

    Project hashes should be alphanumeric + underscore (no separators or path components).
    """
    if not project_hash:
        raise ValueError("project_hash cannot be empty")
    if len(project_hash) > 128:
        raise ValueError(f"project_hash too long (max 128 chars): {len(project_hash)}")
    if not _PROJECT_HASH_RE.match(project_hash):
        raise ValueError(f"project_hash must be alphanumeric or underscore: {project_hash!r}")


@contextlib.contextmanager
def open_project(project_hash: str) -> Iterator[sqlite3.Connection]:
    """Yield a connection to a per-project DB with schema applied."""
    _validate_project_hash(project_hash)
    path = paths.project_db_path(project_hash)
    _LOG.info("opening project db: %s (hash=%s)", path, project_hash)
    conn = _open_with_rebuild(path)
    try:
        # Only check integrity once per file per session to avoid repeated PRAGMA checks
        if path not in _INTEGRITY_CHECKED and not _integrity_ok(conn):
            _LOG.info("integrity check failed for project %s; quarantining and rebuilding", project_hash)
            conn.close()
            # Try quarantine; whether it succeeds or fails, just reopen the
            # (possibly-new) file. If quarantine failed (Windows lock), we
            # reopen the original and proceed; better than crashing.
            _rebuild(path)
            conn = _open_with_rebuild(path)
        _INTEGRITY_CHECKED[path] = True
        _ensure_project_schema(conn)
        yield conn
    finally:
        _LOG.debug("closing project db: %s", project_hash)
        with contextlib.suppress(Exception):
            conn.close()


# ---------------------------------------------------------------------------
# Read-only openers (for stats — skip integrity_check + DDL executescript)
# ---------------------------------------------------------------------------

def _connect_readonly(db_path: Path) -> sqlite3.Connection:
    """Open a read-only SQLite connection via URI mode. No WAL, no vec, no DDL.

    Falls back to immutable=1 when the WAL shared-memory file is inaccessible
    (e.g. Codex unelevated sandbox on Windows).  immutable=1 reads the DB file
    directly, bypassing all WAL/SHM coordination — safe for read-only callers.

    SQLite is lazy: ``sqlite3.connect()`` and ``PRAGMA busy_timeout`` do *not*
    actually open the DB file or its WAL sidecars.  A real read (``SELECT FROM
    sqlite_master``) is required to surface "unable to open database file" at
    connect-time so the fallback can take over — otherwise the failure happens
    later inside the caller's query.
    """
    uri_ro = str(db_path.as_uri()) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri_ro, uri=True, isolation_level=None, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        # Force SQLite to actually open the DB file and its WAL sidecars.
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return conn
    except sqlite3.OperationalError as exc:
        _LOG.info(
            "WAL read-only open failed for %s (%s) — retrying in immutable mode",
            db_path.name,
            exc,
        )
        with contextlib.suppress(Exception):
            conn.close()  # type: ignore[possibly-undefined]
        uri_imm = str(db_path.as_uri()) + "?mode=ro&immutable=1"
        conn = sqlite3.connect(uri_imm, uri=True, isolation_level=None, timeout=10.0)
        conn.row_factory = sqlite3.Row
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute("PRAGMA busy_timeout = 5000")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA foreign_keys = ON")
        # Verify the immutable open actually works (same lazy-open reason).
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return conn


@contextlib.contextmanager
def open_global_readonly() -> Iterator[sqlite3.Connection]:
    """Read-only connection to global.db, skipping integrity_check and schema DDL.

    Intended for stats reads where correctness and performance matter more than
    schema migrations. Raises FileNotFoundError if global.db does not exist yet.
    """
    path = paths.global_db_path()
    if not path.exists():
        raise FileNotFoundError(f"global.db not found: {path}")
    conn = _connect_readonly(path)
    try:
        yield conn
    finally:
        with contextlib.suppress(Exception):
            conn.close()


@contextlib.contextmanager
def open_project_readonly(project_hash: str) -> Iterator[sqlite3.Connection]:
    """Read-only connection to a per-project DB, skipping integrity_check and schema DDL.

    Raises FileNotFoundError if the project DB does not exist yet.
    """
    _validate_project_hash(project_hash)
    path = paths.project_db_path(project_hash)
    if not path.exists():
        raise FileNotFoundError(f"project db not found: {path}")
    conn = _connect_readonly(path)
    try:
        yield conn
    finally:
        with contextlib.suppress(Exception):
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

    _validate_project_hash(project_hash)
    lock_path = paths.locks_dir() / f"{project_hash}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_sec
    pid = os.getpid()

    def _stale(lock_text: str) -> bool:
        """Return True if the lock file content represents a stale (dead) lock.

        A lock is stale if: the owning PID no longer exists, the timestamp is
        older than 10 minutes (crash recovery), or the file content is malformed.
        """
        try:
            parts = lock_text.strip().split("\n", 1)
            owner_pid = int(parts[0])
            owner_ts = float(parts[1]) if len(parts) > 1 else 0.0
            if time.time() - owner_ts > LOCK_STALE_SECONDS:
                return True
            return not psutil.pid_exists(owner_pid)
        except (ValueError, IndexError):
            return True  # malformed → treat as stale

    def _try_acquire() -> bool:
        """Attempt a single lock acquisition; return True on success, False if held."""
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
    t0 = time.monotonic()
    waited = False
    holder_pid = None
    while True:
        if _try_acquire():
            acquired = True
            break
        waited = True
        # Capture lock holder info for diagnostics
        if holder_pid is None:
            try:
                lock_text = lock_path.read_text(encoding="utf-8")
                parts = lock_text.strip().split("\n", 1)
                holder_pid = int(parts[0])
            except (OSError, ValueError, IndexError):
                holder_pid = -1
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)

    if not acquired:
        raise TimeoutError(
            f"could not acquire writer lock for project {project_hash[:8]} "
            f"within {timeout_sec}s (held by pid={holder_pid})"
        )
    elapsed = time.monotonic() - t0
    if waited:
        _LOG.info("writer lock acquired for project %s after %.3fs (held by pid=%s)", project_hash[:8], elapsed, holder_pid)
    else:
        _LOG.debug("writer lock acquired for project %s (no contention)", project_hash[:8])
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            lock_path.unlink(missing_ok=True)
        _LOG.debug("writer lock released for project %s", project_hash[:8])


# ---------------------------------------------------------------------------
# Stats helper
# ---------------------------------------------------------------------------

def file_count(project_hash: str) -> int:
    """How many files are indexed for this project. 0 means never indexed."""
    try:
        with open_project(project_hash) as conn:
            row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
            return int(row[0]) if row else 0
    except Exception as exc:  # noqa: BLE001
        _LOG.debug("file_count(%s…) failed, returning 0: %s", project_hash[:8], exc)
        return 0


def project_has_files(project_hash: str) -> bool:
    """Return True when the project DB already contains at least one file row."""
    try:
        with open_project_readonly(project_hash) as conn:
            row = conn.execute("SELECT 1 FROM files LIMIT 1").fetchone()
            return row is not None
    except (FileNotFoundError, sqlite3.Error, OSError):
        return False


def touch_project_last_seen(project_hash: str) -> None:
    """Bump a project's last_seen to mark recent user activity. Best-effort.

    No-op if the project is not yet registered (never indexed) — the first
    index_project() call registers it. Called by the SessionStart hook so the
    worker's periodic-reindex window tracks real user activity rather than the
    worker's own background reindex cadence (which would otherwise keep every
    project "active" forever).
    """
    try:
        with open_global() as conn:
            conn.execute(
                "UPDATE projects SET last_seen = ? WHERE hash = ?",
                (int(time.time()), project_hash),
            )
    except sqlite3.OperationalError as exc:
        # Read-only fallback (sandbox) — expected, telemetry is best-effort.
        if "readonly" in str(exc).lower():
            _LOG.debug("touch_project_last_seen skipped (read-only fallback)")
        else:
            _LOG.error("touch_project_last_seen failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("touch_project_last_seen failed: %s", exc)


def index_health(project_hash: str) -> dict[str, object]:
    """Return health and statistics for a project DB.

    Returns a dict with keys:
        ok (bool), integrity_ok (bool), file_count (int), symbol_count (int),
        ref_count (int), section_count (int), chunk_count (int),
        embedding_count (int), db_size_bytes (int), schema_version (str | None),
        embeddings_disabled (bool)
    """
    db_path = paths.project_db_path(project_hash)
    result: dict[str, object] = {
        "ok": False,
        "integrity_ok": False,
        "file_count": 0,
        "symbol_count": 0,
        "ref_count": 0,
        "section_count": 0,
        "chunk_count": 0,
        "embedding_count": 0,
        "db_size_bytes": 0,
        "schema_version": None,
        "embeddings_disabled": False,
    }
    if not db_path.exists():
        return result
    with contextlib.suppress(OSError):
        result["db_size_bytes"] = db_path.stat().st_size
    try:
        with open_project(project_hash) as conn:
            integrity_row = conn.execute("PRAGMA integrity_check").fetchone()
            result["integrity_ok"] = integrity_row is not None and integrity_row[0] == "ok"

            def _count(table: str) -> int:
                if table not in _KNOWN_PROJECT_TABLES:
                    raise ValueError(f"_count: unknown table name {table!r}")
                row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()  # noqa: S608
                return int(row[0]) if row else 0

            result["file_count"] = _count("files")
            result["symbol_count"] = _count("symbols")
            result["ref_count"] = _count("refs")
            result["section_count"] = _count("sections")
            result["chunk_count"] = _count("chunks")

            with contextlib.suppress(sqlite3.OperationalError):
                result["embedding_count"] = _count("embeddings")

            meta_row = conn.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()
            result["schema_version"] = meta_row["value"] if meta_row else None

            disabled_row = conn.execute(
                "SELECT value FROM meta WHERE key='embeddings_disabled'"
            ).fetchone()
            result["embeddings_disabled"] = disabled_row is not None

            result["ok"] = True
    except (sqlite3.Error, DBError, OSError) as exc:
        _LOG.warning("index_health failed for %s: %s", project_hash[:8], exc)
    return result


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
    except sqlite3.OperationalError as exc:
        # "attempt to write a readonly database" is expected in sandboxed
        # contexts (Codex unelevated) where _connect() falls back to immutable
        # mode.  Drop to debug — telemetry is best-effort.
        if "readonly" in str(exc).lower():
            _LOG.debug("record_stat skipped (read-only fallback): %s", exc)
        else:
            _LOG.error("record_stat failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        _LOG.error("record_stat failed: %s", exc)
