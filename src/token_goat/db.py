"""SQLite + sqlite-vec storage layer for token-goat's indexed project data.

Two database files are managed here:

- ``global.db`` — project registry, global symbol snapshot, and cumulative stats.
  Opened with ``open_global()`` / ``open_global_readonly()``.
- ``projects/{hash}.db`` — per-project files, symbols, refs, sections, chunks,
  and sqlite-vec embeddings. Opened with ``open_project()`` / ``open_project_readonly()``.

Key design decisions:

**WAL mode + fallback**: All writable connections enable WAL so readers don't block
writers. On sandboxed systems (e.g. Codex unelevated on Windows) WAL SHM file
creation fails; ``_connect()`` falls back to ``immutable=1`` URI mode so reads
still work while writes silently fail (expected in that context).

**Corruption auto-recovery**: ``_repair_if_corrupt()`` runs ``PRAGMA integrity_check``
once per path per process. A genuine failure triggers ``_rebuild()`` which renames
the corrupt file to ``*.bad-<ts>`` and opens a fresh (empty) DB. Transient errors
(locked, busy, I/O) are not treated as corruption — they return True from
``_integrity_ok()`` so the caller retries normally.

**Read-only openers**: ``open_global_readonly()`` and ``open_project_readonly()``
skip integrity_check and DDL entirely — used by ``stats.py`` to avoid the multi-
second overhead of N integrity_checks when only read access is needed.

**File-based writer lock**: ``project_writer_lock()`` uses a PID + timestamp
lockfile rather than SQLite's ``BEGIN EXCLUSIVE`` so the worker can detect and
clear stale locks from crashed processes without blocking indefinitely.
"""
from __future__ import annotations

__all__ = [
    "EMBED_DIM",
    "LOCK_CROSS_PLATFORM_STALE_SECONDS",
    "LOCK_STALE_SECONDS",
    "SCHEMA_VERSION",
    "DBBusyError",
    "DBCorruptionError",
    "DBError",
    "DBReadOnlyError",
    "VecExtensionUnavailable",
    "file_count",
    "fts_available",
    "get_compression_stats",
    "get_entry_scores",
    "get_file_exports",
    "get_file_importers",
    "get_file_imports",
    "get_refs_with_callers",
    "get_symbol_callers",
    "get_symbol_refs",
    "get_type_definitions",
    "index_health",
    "list_all_project_hashes",
    "open_global",
    "open_global_readonly",
    "open_project",
    "open_project_readonly",
    "project_has_files",
    "project_last_indexed_ts",
    "project_writer_lock",
    "record_stat",
    "touch_project_last_seen",
    "update_global_grep_pattern",
    "with_timeout",
]

import contextlib
import math
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Final

from . import paths
from .util import get_logger, normalize_path

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

SCHEMA_VERSION: Final[int] = 2
EMBED_DIM: Final[int] = 384  # BAAI/bge-small-en-v1.5

_LOG = get_logger("db")

# Cache integrity check results per DB file to avoid repeated PRAGMA checks.
# Keys are absolute Path objects; values are always True (only passing checks
# are cached — a corrupt DB is quarantined and the key is evicted by _rebuild()
# so the replacement file gets a fresh check on its first open).
_INTEGRITY_CHECKED: dict[Path, bool] = {}

# Cache which project DB paths have already had their schema migrated (line_count
# column check).  Avoids running PRAGMA table_info(files) on every open() call
# once the migration has been confirmed.  Keyed on absolute Path.
# _rebuild() also evicts entries from this dict so a freshly quarantined+reopened
# DB always re-runs the migration check rather than assuming it is already done.
_SCHEMA_MIGRATED: dict[Path, bool] = {}
# Tracks which DB paths have had the last_access_epoch stats migration applied this process.
_STATS_EPOCH_MIGRATED: set[Path] = set()


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

def _close_conn(conn: sqlite3.Connection | None) -> None:
    """Close *conn*, silently suppressing any exception.

    Accepts ``None`` so callers can safely pass a connection variable that may
    not have been assigned yet (e.g. when ``sqlite3.connect()`` itself raises
    before the local is bound).  Repeated pattern: every context-manager finally
    block needs to close the connection without surfacing errors (e.g.
    already-closed, OS-level errors on Windows when the file is locked).
    """
    if conn is None:
        return
    with contextlib.suppress(Exception):
        conn.close()


# Cap the WAL file size.  ``journal_size_limit`` makes SQLite truncate the
# ``-wal`` file back down to this size whenever a checkpoint resets it.  Without
# it the WAL file only ever grows: under a heavy multi-agent burst whose passive
# autocheckpoints are perpetually blocked by overlapping readers, ``global.db-wal``
# reached 11 GB, after which every connection that scanned the WAL stalled for
# minutes.  64 MB is generous headroom over the ~4 MB the default 1000-page
# autocheckpoint normally holds.
WAL_SIZE_LIMIT_BYTES: Final[int] = 64 * 1024 * 1024


def _apply_connection_pragmas(conn: sqlite3.Connection, *, suppress: bool = False) -> None:
    """Apply the standard read/write PRAGMA settings to *conn*.

    PRAGMAs applied:

    * ``busy_timeout``   — back off instead of raising immediately when another
                           writer holds the lock.
    * ``synchronous``    — NORMAL gives a good safety/performance balance; FULL
                           is unnecessarily slow for our single-writer pattern.
    * ``foreign_keys``   — enforce FK constraints so accidental orphan rows are
                           caught at insert time rather than silently ignored.
    * ``cache_size``     — 64 MB page cache (negative value = KB).  Default is
                           only 2 MB; larger cache cuts repeated disk reads for
                           read-heavy symbol/embedding lookups.
    * ``temp_store``     — keep temp tables and sort buffers in memory rather
                           than on disk; important for ORDER BY / GROUP BY over
                           embedding results.
    * ``mmap_size``      — map up to 128 MB of the DB file into the process
                           address space so sequential scans avoid system-call
                           overhead on hot pages.
    * ``journal_size_limit`` — truncate the WAL file back to
                           ``WAL_SIZE_LIMIT_BYTES`` after each checkpoint so it
                           cannot grow without bound under reader contention.

    ``suppress=True`` wraps the block in ``contextlib.suppress(sqlite3.OperationalError)``
    for the immutable-fallback paths where PRAGMAs may not be accepted.
    """
    def _apply() -> None:
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA cache_size = -65536")   # 64 MB (value in KB when negative)
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.execute("PRAGMA mmap_size = 134217728")  # 128 MB
        conn.execute(f"PRAGMA journal_size_limit = {WAL_SIZE_LIMIT_BYTES}")

    if suppress:
        with contextlib.suppress(sqlite3.OperationalError):
            _apply()
    else:
        _apply()


def _connect(db_path: Path, *, load_vec: bool = True) -> sqlite3.Connection:
    """Open a connection with WAL, foreign keys, and (optional) sqlite-vec.

    Falls back to an *immutable read-only* connection when WAL coordination
    fails (e.g. Codex unelevated sandbox on Windows cannot create the WAL shm
    file).  The fallback connection bypasses WAL entirely and serves all read
    paths; any write attempt will fail with "attempt to write a readonly
    database", which is the correct behaviour for a sandboxed read-only caller.
    """
    paths.ensure_dir(db_path.parent)
    conn = sqlite3.connect(str(db_path), isolation_level=None, timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("PRAGMA journal_mode = WAL").fetchone()
        actual_mode = row[0] if row else "unknown"
        if actual_mode != "wal":
            _LOG.debug(
                "journal_mode for %s: requested WAL but got %r (network/FAT volume?)",
                db_path.name,
                actual_mode,
            )
        else:
            _LOG.debug("journal_mode for %s: WAL confirmed", db_path.name)
        _apply_connection_pragmas(conn)
        # Best-effort checkpoint: move WAL frames to the DB without waiting for readers.
        # PASSIVE never blocks — it checkpoints whatever frames are available immediately.
        # RESTART/TRUNCATE would block for busy_timeout (5 s) when any reader holds a snapshot,
        # making every open_global() call expensive under concurrent read load.
        # The worker's periodic TRUNCATE and the per-connection journal_size_limit handle
        # WAL size bounds; we do not need a blocking checkpoint on every connection open.
        try:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        except sqlite3.OperationalError as e:
            _LOG.debug("WAL checkpoint failed (non-fatal): %s", e)
    except sqlite3.OperationalError as e:
        # INFO (not WARNING): expected in sandboxed contexts like Codex
        # unelevated.  File loggers capture it; lastResort stderr handler
        # suppresses it so CLI output stays clean.
        _LOG.info(
            "WAL coordination unavailable for %s: %s — opening read-only (immutable)",
            db_path.name,
            e,
        )
        _close_conn(conn)
        uri = str(db_path.as_uri()) + "?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            _apply_connection_pragmas(conn, suppress=True)
            # Validate the fallback open with a real read; SQLite is otherwise lazy
            # and the failure would surface inside the caller's first query.
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        except Exception as e:
            # Catch all exceptions here to avoid leaking the fallback connection.
            _close_conn(conn)
            raise
    except sqlite3.DatabaseError:
        # Genuine corruption (not WAL/SHM access failure) — close so callers
        # can rename/delete the file, then re-raise.
        _close_conn(conn)
        raise
    except Exception:
        # Catch any other exception (e.g., from _apply_connection_pragmas) to avoid leaking.
        _close_conn(conn)
        raise
    if load_vec:
        try:
            import sqlite_vec
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            _LOG.debug("sqlite-vec loaded for %s", db_path.name)
        except Exception as e:
            _LOG.warning("sqlite-vec unavailable: %s", e)
    _LOG.debug("connection opened: %s", db_path.name)
    return conn


# ---------------------------------------------------------------------------
# Corruption detection + auto-rebuild
# ---------------------------------------------------------------------------

def _is_transient_db_error(error: sqlite3.DatabaseError) -> bool:
    """Check if a DatabaseError is transient (not evidence of corruption)."""
    lowered = str(error).lower()
    return "locked" in lowered or "busy" in lowered or "i/o" in lowered


def _is_readonly_or_transient(error: sqlite3.OperationalError) -> bool:
    """Return True when *error* is a read-only sandbox or transient lock/busy condition.

    Both ``touch_project_last_seen`` and ``record_stat`` treat these identically:
    log at DEBUG and silently drop the write, because telemetry is best-effort and
    sandbox environments (Codex unelevated) are expected to be read-only.
    """
    lowered = str(error).lower()
    return "locked" in lowered or "busy" in lowered or "i/o" in lowered or "readonly" in lowered


# Item 20: Timeout wrapper for hook-context DB writes to prevent blocking the harness.
# Hooks run synchronously before/during tool calls; a 10s+ block on Windows when a
# writer holds the lock can freeze the agent. This wrapper sets a 2s busy_timeout
# so hooks fail fast and let the harness continue.


def with_timeout(fn: Callable[[sqlite3.Connection], None], timeout_s: float = 2.0) -> None:
    """Execute a callable with a short DB timeout, swallowing transient lock errors.

    Item 20: On Windows, long-lived writer locks can cause a single hook write to
    block for >10s. This wrapper opens a connection with a 2s timeout (rather than
    the default 5s) so hooks fail fast instead of stalling the harness.

    Args:
        fn:        Callable that accepts a single sqlite3.Connection and performs
                   the desired read/write operation.
        timeout_s: Timeout in seconds before giving up on a locked DB. Default is
                   2.0; set higher for non-hook contexts.

    Silently swallows ``OperationalError`` containing "busy", "locked", or "i/o"
    (expected in contention or sandbox contexts), and logs other errors at WARNING
    so they surface without crashing the hook.
    """
    timeout_ms = int(timeout_s * 1000)
    try:
        # Open a temporary connection with the short timeout and execute the operation.
        paths.ensure_dir(paths.global_db_path().parent)
        conn = sqlite3.connect(str(paths.global_db_path()), isolation_level=None, timeout=timeout_s)
        conn.row_factory = sqlite3.Row  # callers may access result columns by name
        try:
            conn.execute(f"PRAGMA busy_timeout = {timeout_ms}")
            fn(conn)
        finally:
            conn.close()
    except sqlite3.OperationalError as exc:
        if _is_readonly_or_transient(exc):
            _LOG.debug("with_timeout write skipped (transient): %s", exc)
        else:
            _LOG.warning("with_timeout write failed: %s", exc)
    except Exception as exc:
        _LOG.warning("with_timeout failed: %s", exc)


def _best_effort_write(fn: Callable[[], None], label: str) -> None:
    """Execute *fn* as a best-effort DB write, swallowing expected sandbox errors.

    On read-only (sandboxed) connections an ``OperationalError`` whose message
    contains "readonly", "locked", "busy", or "i/o" is downgraded to DEBUG and
    silently dropped — telemetry writes are best-effort.  Any other error is
    logged at ERROR so real failures surface.  Used by ``touch_project_last_seen``
    and ``record_stat`` to avoid duplicating the identical three-clause handler.
    """
    try:
        fn()
    except sqlite3.OperationalError as exc:
        if _is_readonly_or_transient(exc):
            _LOG.debug("%s skipped (read-only or transient): %s", label, exc)
        else:
            _LOG.error("%s failed: %s", label, exc)
    except Exception as exc:
        _LOG.error("%s failed: %s", label, exc)


def _integrity_ok(conn: sqlite3.Connection) -> bool:
    """Return True if the DB is verifiably healthy.

    Note: an exception or "busy/locked" result is NOT evidence of corruption.
    Only an explicit non-"ok" result from PRAGMA integrity_check counts. The
    previous version treated every DatabaseError as corruption, which on
    Windows caused false positives when the worker held the file open during
    indexing. token-goat then tried to quarantine a perfectly healthy DB,
    failed with WinError 5, and surfaced "Exit code: 1" to the agent.

    Counterintuitively, we return True (healthy) even when the PRAGMA raises.
    The reasoning: if we cannot run the check, we have no evidence of corruption,
    only evidence of a transient or access problem. Quarantining on uncertainty
    destroys data; the caller will surface the real error when it next queries.
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
        _LOG.error("quarantined corrupt db: %s -> %s", db_path, bad)
        # Invalidate per-path caches so the rebuilt DB gets fresh checks.
        _INTEGRITY_CHECKED.pop(db_path, None)
        _SCHEMA_MIGRATED.pop(db_path, None)
    except OSError as e:
        _LOG.error("failed to quarantine %s: %s (continuing with existing DB)", db_path, e)
        return False
    else:
        return True


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------


def _get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    """Return the value for *key* from the meta table, or None if absent."""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row is not None else None


def _get_project_root(project_hash: str) -> Path | None:
    """Fetch the project root path from global DB, normalized to Path.

    Returns Path to the project root on success, None if the project is not
    registered or any error occurs (fail-soft).
    """
    try:
        with open_global_readonly() as gconn:
            proj_row = gconn.execute(
                "SELECT root FROM projects WHERE hash = ?",
                (project_hash,),
            ).fetchone()
        return Path(normalize_path(str(proj_row["root"]))) if proj_row else None
    except Exception:
        return None


_GLOBAL_TABLES = """
-- Cross-session Grep pattern frequency index.  One row per unique pattern hash;
-- updated (amortized) by session.mark_grep so hints.py can nudge toward semantic
-- search for patterns seen across N sessions.
CREATE TABLE IF NOT EXISTS grep_patterns (
    pattern_hash  TEXT    PRIMARY KEY,  -- SHA1 hex of the raw pattern string
    first_pattern TEXT    NOT NULL,     -- original pattern text (truncated to 200 chars)
    last_ts       REAL    NOT NULL,     -- Unix timestamp of last seen occurrence
    count         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_grep_patterns_last_ts ON grep_patterns(last_ts);

-- Registry of every project token-goat has indexed, keyed by SHA1(canonical_path).
CREATE TABLE IF NOT EXISTS projects (
    hash       TEXT    PRIMARY KEY,
    root       TEXT    NOT NULL,
    marker     TEXT    NOT NULL,  -- detection marker type, e.g. 'pyproject', 'package.json', 'manual'
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    languages  TEXT    NOT NULL DEFAULT ''  -- comma-separated language names for quick display
);

-- Snapshot of top-level symbols across all projects, used for cross-project symbol lookup.
-- Populated by the indexer; queried by 'token-goat symbol --all-projects'.
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
-- Composite (name, kind) for 'token-goat symbol NAME --type TYPE --all-projects':
--   SELECT … FROM symbols_global sg WHERE sg.name = ? AND sg.kind IN (…)
-- Mirrors idx_symbols_name_kind on the per-project symbols table.
CREATE INDEX IF NOT EXISTS idx_symbols_global_name_kind ON symbols_global(name, kind);

-- Cumulative token/byte savings events, one row per hook intercept or CLI read.
-- Queried by 'token-goat stats' to compute total savings across all sessions.
CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT    NOT NULL,  -- event type, e.g. 'image_shrink', 'symbol_read', 'section_read'
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved  INTEGER NOT NULL DEFAULT 0,
    detail       TEXT               -- optional JSON or human-readable annotation
);
CREATE INDEX IF NOT EXISTS idx_stats_global_ts   ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_global_kind ON stats(kind);

-- Key/value store for global configuration and version stamps (e.g. schema_version).
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Tracks how many times a needle (symbol/file/section name) was searched without a hit.
-- Enables proactive hints after repeated misses on the same target.
-- Rows are deleted on successful resolution so the counter resets after a hit.
CREATE TABLE IF NOT EXISTS miss_patterns (
    needle          TEXT    NOT NULL,
    file_hint       TEXT    NOT NULL DEFAULT '',
    miss_count      INTEGER NOT NULL DEFAULT 1,
    last_miss_epoch REAL    NOT NULL,
    PRIMARY KEY (needle, file_hint)
);
"""

_PROJECT_TABLES = """
-- Key/value store for per-project metadata (e.g. schema_version, project root).
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per indexed source file; tracks mtime and SHA so the worker skips
-- files that have not changed since the last index pass.
CREATE TABLE IF NOT EXISTS files (
    rel_path       TEXT    PRIMARY KEY,
    language       TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    line_count     INTEGER,
    mtime          REAL    NOT NULL,
    content_sha256 TEXT    NOT NULL,
    indexed_at     INTEGER NOT NULL
);

-- Named code symbols (functions, classes, types, constants) extracted by tree-sitter.
-- parent_id links nested symbols to their enclosing scope (e.g. method → class).
-- Queried by 'token-goat symbol' and 'token-goat read'.
CREATE TABLE IF NOT EXISTS symbols (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    file_rel  TEXT    NOT NULL,
    line      INTEGER NOT NULL,
    col       INTEGER NOT NULL DEFAULT 0,
    end_line  INTEGER,
    signature TEXT,
    parent_id INTEGER,  -- enclosing symbol id, NULL for top-level
    FOREIGN KEY (file_rel)   REFERENCES files(rel_path) ON DELETE CASCADE,
    FOREIGN KEY (parent_id)  REFERENCES symbols(id)     ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_rel);
-- Composite (file_rel, name) for read_symbol's primary access pattern:
--   SELECT … FROM symbols WHERE file_rel = ? AND name = ?
-- Without this, the planner picks idx_symbols_file then filters by name in
-- memory, which scans every symbol in the file.  EXPLAIN QUERY PLAN before:
--   'SEARCH symbols USING INDEX idx_symbols_file (file_rel=?)'
-- After: 'SEARCH symbols USING INDEX idx_symbols_file_name (file_rel=? AND name=?)'
CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_rel, name);
-- Composite (name, kind) for 'token-goat symbol NAME --type TYPE' queries:
--   SELECT … FROM symbols WHERE name = ? AND kind IN (…)
-- Without this, the planner uses idx_symbols_name then filters kind in memory.
-- EXPLAIN QUERY PLAN before: 'SEARCH symbols USING INDEX idx_symbols_name (name=?)'
-- After: 'SEARCH symbols USING INDEX idx_symbols_name_kind (name=? AND kind=?)'
-- New indexers (sql_table, graphql_type, css_class, proto_message, etc.) add many
-- distinct kind values; this index ensures --type filters stay O(log N) regardless
-- of how many new kinds are registered.
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);

-- Call-site references: every identifier followed by '(' that appears in the project.
-- Used for "find usages" and to build the PageRank graph in repomap.py.
CREATE TABLE IF NOT EXISTS refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_name TEXT    NOT NULL,
    file_rel    TEXT    NOT NULL,
    line        INTEGER NOT NULL,
    col         INTEGER NOT NULL DEFAULT 0,
    context     TEXT,  -- surrounding line text for display
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_name);

-- Document sections extracted from Markdown headings and similar structural markers.
-- Queried by 'token-goat section' to serve one heading's content without reading
-- the whole file.
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
-- Composite (file_rel, heading) for read_section's primary access pattern.
-- Without this, the planner uses idx_sections_heading (which can match many
-- "Install"/"Usage" headings across the project) and filters by file in
-- memory.  The composite seeks directly to the (file, heading) pair.
CREATE INDEX IF NOT EXISTS idx_sections_file_heading ON sections(file_rel, heading);

-- Import and export declarations, one row per statement.
-- kind is 'import', 'export', or 'reexport'; target is the module path or symbol name.
CREATE TABLE IF NOT EXISTS imports_exports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    target   TEXT    NOT NULL,
    line     INTEGER NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_imex_file ON imports_exports(file_rel);

-- Fixed-size text chunks feeding the embedding pipeline.  Each chunk is a
-- contiguous slice of a source file; content_sha256 allows the embedder to skip
-- chunks whose text hasn't changed since the last embedding pass.
CREATE TABLE IF NOT EXISTS chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel       TEXT    NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    content_sha256 TEXT    NOT NULL,
    kind           TEXT    NOT NULL,  -- e.g. 'symbol', 'section', 'block'
    text           TEXT    NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_rel);
CREATE INDEX IF NOT EXISTS idx_chunks_sha  ON chunks(content_sha256);

-- Per-project savings events, mirroring the global stats table.
-- Allows per-project breakdown in 'token-goat stats'.
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

-- Cached per-file summaries for the repomap PageRank overview.  Keyed on
-- (rel_path, mtime, size) so entries are invalidated automatically when a file
-- changes without requiring an explicit cache-bust step.
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

_CHUNKS_FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 1'
);
"""


def _ensure_global_schema(conn: sqlite3.Connection) -> None:
    """Create or verify the global-DB tables and stamp the schema version.

    Safe to call on read-only connections (sandbox mode): DDL is skipped
    silently because the schema was already created by a prior writable open.
    """
    try:
        conn.executescript(_GLOBAL_TABLES)
        if _get_meta(conn, "schema_version") is None:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
        db_path = paths.global_db_path()
        if db_path not in _STATS_EPOCH_MIGRATED:
            global_stats_cols = {row["name"] for row in conn.execute("PRAGMA table_info(stats)").fetchall()}
            if "last_access_epoch" not in global_stats_cols:
                _LOG.info("schema migration: adding last_access_epoch column to global stats table")
                conn.execute("ALTER TABLE stats ADD COLUMN last_access_epoch REAL")
            _STATS_EPOCH_MIGRATED.add(db_path)
    except sqlite3.OperationalError as e:
        # Read-only fallback connection (sandbox) cannot run DDL. The schema
        # already exists from prior writable opens — read-only callers can
        # proceed against the existing tables.
        if _is_readonly_or_transient(e):
            _LOG.debug("global schema ensure skipped (read-only connection): %s", e)
            return
        raise


def _ensure_project_schema(conn: sqlite3.Connection, *, db_path: Path | None = None) -> None:
    """Create or verify the per-project tables including the sqlite-vec embeddings table.

    If the sqlite-vec extension is unavailable the embeddings table creation is
    skipped and a ``embeddings_disabled`` flag is written to the meta table so
    callers can degrade gracefully.  Safe to call on read-only connections.

    *db_path* is used to cache the ``line_count`` migration check so that
    ``PRAGMA table_info(files)`` runs at most once per DB path per process
    lifetime.  When ``db_path`` is None the check is always performed (safe
    but slightly slower — only happens for callers that don't pass the path).
    """
    try:
        conn.executescript(_PROJECT_TABLES)
        # Check for the line_count migration at most once per path per process.
        if db_path is None or db_path not in _SCHEMA_MIGRATED:
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(files)").fetchall()
            }
            if "line_count" not in columns:
                _LOG.info(
                    "schema migration: adding line_count column to files table%s",
                    f" ({db_path.name})" if db_path else "",
                )
                conn.execute("ALTER TABLE files ADD COLUMN line_count INTEGER")
            if db_path is None or db_path not in _STATS_EPOCH_MIGRATED:
                stats_cols = {row["name"] for row in conn.execute("PRAGMA table_info(stats)").fetchall()}
                if "last_access_epoch" not in stats_cols:
                    _LOG.info(
                        "schema migration: adding last_access_epoch column to stats table%s",
                        f" ({db_path.name})" if db_path else "",
                    )
                    conn.execute("ALTER TABLE stats ADD COLUMN last_access_epoch REAL")
                if db_path is not None:
                    _STATS_EPOCH_MIGRATED.add(db_path)
            if db_path is not None:
                _SCHEMA_MIGRATED[db_path] = True
        # INSERT OR REPLACE (not INSERT OR IGNORE) so the version row is
        # always current after a schema upgrade. The global schema uses plain
        # INSERT (first-write-wins) because global.db has no migrations yet;
        # per-project DBs use OR REPLACE to overwrite the version from any
        # older schema written by a previous token-goat release.
        existing_ver = _get_meta(conn, "schema_version")
        if existing_ver is not None and existing_ver != str(SCHEMA_VERSION):
            _LOG.info(
                "schema upgrade: %s -> %s%s",
                existing_ver,
                SCHEMA_VERSION,
                f" ({db_path.name})" if db_path else "",
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    except sqlite3.OperationalError as e:
        if _is_readonly_or_transient(e):
            _LOG.debug("project schema ensure skipped (read-only connection): %s", e)
            return
        raise  # not a readonly situation — propagate to surface the real error
    # Try to create the sqlite-vec virtual table.
    try:
        conn.executescript(_EMBEDDINGS_DDL)
    except sqlite3.OperationalError as e:
        _LOG.warning("embeddings table unavailable: %s", e)
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('embeddings_disabled', '1')"
            )
    try:
        conn.executescript(_CHUNKS_FTS_DDL)
        # COUNT(*) on an FTS5 external-content table reads the content table rows,
        # not FTS index entries, so it cannot detect whether the index was populated.
        # Use a meta marker set after the first successful rebuild instead.
        fts_init = conn.execute("SELECT 1 FROM meta WHERE key='fts_initialized'").fetchone()
        if fts_init is None:
            conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
            conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('fts_initialized', '1')")
    except sqlite3.OperationalError as e:
        _LOG.warning("chunks_fts table unavailable: %s", e)
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('fts_disabled', '1')")
# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _open_with_retry(
    path: Path,
    *,
    load_vec: bool = True,
    max_attempts: int = 3,
    base_delay: float = 0.1,
) -> sqlite3.Connection:
    """Attempt _open_with_rebuild() with exponential backoff on transient locks.

    Only ``sqlite3.OperationalError`` messages containing "locked" or "busy"
    are retried — genuine corruption errors propagate immediately so the
    caller's quarantine-and-rebuild logic still fires.
    """
    last_exc: sqlite3.OperationalError | None = None
    for attempt in range(max_attempts):
        try:
            return _open_with_rebuild(path, load_vec=load_vec)
        except sqlite3.OperationalError as exc:
            msg = str(exc).lower()
            if "locked" not in msg and "busy" not in msg:
                raise
            last_exc = exc
            delay = base_delay * (2 ** attempt)
            _LOG.warning(
                "db locked (%s), retrying in %.2fs (attempt %d/%d)",
                exc,
                delay,
                attempt + 1,
                max_attempts,
            )
            time.sleep(delay)
    # All retries exhausted — raise the last lock error.
    raise last_exc  # type: ignore[misc]  # mypy cannot prove last_exc is non-None; loop runs >= 1 iteration so it always is


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
        _LOG.info("retrying db open after quarantine: %s", path.name)
        try:
            return _connect(path, load_vec=load_vec)
        except sqlite3.DatabaseError as exc2:
            _LOG.error("db open failed after quarantine attempt: %s", exc2)
            raise DBCorruptionError(
                f"DB unrecoverable after quarantine: {path.name}"
            ) from exc2


def _repair_if_corrupt(conn: sqlite3.Connection, path: Path) -> sqlite3.Connection:
    """Run an integrity check; if it fails, quarantine *path* and open a fresh connection.

    Only runs once per path per process lifetime (results cached in
    ``_INTEGRITY_CHECKED``).  Returns the original *conn* when the check passes
    or is already cached; returns a new connection when the file was quarantined.
    The old connection is closed before quarantine so Windows file locks don't
    block the rename.
    """
    if path in _INTEGRITY_CHECKED:
        return conn
    if _integrity_ok(conn):
        _INTEGRITY_CHECKED[path] = True
        return conn
    # Integrity check failed — quarantine and reopen.
    _LOG.error("db integrity check failed, quarantining %s", path)
    conn.close()
    # Whether quarantine succeeds or fails, reopen: if quarantine failed (Windows
    # lock), we reopen the original and proceed rather than crashing.
    _rebuild(path)
    new_conn = _open_with_rebuild(path)
    _INTEGRITY_CHECKED[path] = True
    return new_conn


# ---------------------------------------------------------------------------
# Public context managers
# ---------------------------------------------------------------------------

def _log_session_close(
    label: str,
    t0: float,
    conn: sqlite3.Connection | None,
    *,
    checkpoint: bool = False,
) -> None:
    """Log session duration, optionally checkpoint WAL, and close *conn*.

    Shared by ``open_global`` and ``open_project`` to avoid duplicating the
    identical timing/warning pattern in both finally blocks.  A session that
    took 1 s or more is logged at DEBUG so the elapsed time is available when
    debug logging is enabled without adding stderr noise to short-lived CLI
    commands.

    When *checkpoint* is True, a best-effort ``PRAGMA wal_checkpoint(PASSIVE)``
    is executed before closing the connection.  PASSIVE moves as many WAL frames
    as possible to the database without waiting for any active readers — it never
    blocks and returns immediately even if some frames cannot be moved.  WAL size
    bounds come from ``journal_size_limit`` on every connection and the worker's
    periodic TRUNCATE checkpoint; the on-close PASSIVE is supplementary cleanup
    that avoids blocking the caller when concurrent readers are present.  Errors
    are suppressed — a failed checkpoint is not fatal; the WAL will be cleaned up
    by the next successful checkpoint or by the worker's maintenance cycle.  Not
    set for read-only connections (checkpoint on a read-only connection is a no-op
    and can raise ``OperationalError`` on some platforms).
    """
    session_ms = (time.monotonic() - t0) * 1000
    if session_ms >= 1000:
        _LOG.debug("%s session slow: %.1fms total", label, session_ms)
    else:
        _LOG.debug("closing %s (session %.1fms)", label, session_ms)
    if checkpoint and conn is not None:
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
    _close_conn(conn)


@contextlib.contextmanager
def open_global() -> Iterator[sqlite3.Connection]:
    """Yield a connection to global.db with schema applied."""
    path = paths.global_db_path()
    t0 = time.monotonic()
    _LOG.debug("opening global db: %s", path)
    conn = _open_with_retry(path)
    try:
        conn = _repair_if_corrupt(conn, path)
        _ensure_global_schema(conn)
        _LOG.debug("global db ready in %.1fms", (time.monotonic() - t0) * 1000)
        yield conn
    finally:
        _log_session_close("global db", t0, conn, checkpoint=True)


# Maximum age (seconds) of a writer lock before it is treated as stale.
# A lock older than this is assumed to belong to a crashed process even if the
# PID still exists (e.g. recycled to an unrelated process). 10 minutes is chosen
# to be longer than the slowest realistic full reindex (large monorepos with
# embeddings), so a legitimately running worker is never falsely evicted.
LOCK_STALE_SECONDS: Final[int] = 600  # 10 minutes

# Cross-platform lock timeout: if a lock was written on a different platform
# (e.g. WSL wrote "linux", Windows is reading), PID validation is unreliable.
# Treat such locks as stale after 60 seconds instead of 10 minutes.
LOCK_CROSS_PLATFORM_STALE_SECONDS: Final[int] = 60

# Project hashes are SHA-1 hex digests (40 lowercase hex chars).  The previous
# pattern accepted uppercase letters and underscores which can never appear in a
# real SHA-1 output and widened the allowlist unnecessarily.  Tightening to
# lowercase hex prevents any non-hash value from passing validation while
# remaining compatible with every hash produced by project.py.
_PROJECT_HASH_RE = re.compile(r"^[0-9a-f]+$")

# Allowlist of table names permitted in dynamic COUNT queries.
# Using an allowlist instead of relying solely on call-site literals prevents
# SQL injection if _count() is ever called with externally-derived input.
_KNOWN_PROJECT_TABLES = frozenset(
    ["files", "symbols", "refs", "sections", "chunks", "embeddings", "chunks_fts"]
)


def _validate_project_hash(project_hash: str) -> None:
    """Validate project_hash to prevent path traversal attacks.

    Hashes are SHA-1 hex digests (lowercase [0-9a-f]+), so any value containing
    uppercase letters, underscores, or path separators is provably not a real hash.
    """
    if not project_hash:
        raise ValueError("project_hash cannot be empty")
    if len(project_hash) > 128:
        raise ValueError(f"project_hash too long (max 128 chars): {len(project_hash)}")
    if not _PROJECT_HASH_RE.match(project_hash):
        raise ValueError(f"project_hash must be lowercase hex (SHA-1 digest): {project_hash!r}")


@contextlib.contextmanager
def open_project(project_hash: str) -> Iterator[sqlite3.Connection]:
    """Yield a connection to a per-project DB with schema applied."""
    _validate_project_hash(project_hash)
    path = paths.project_db_path(project_hash)
    t0 = time.monotonic()
    _LOG.debug("opening project db: %s (hash=%s)", path, project_hash)
    conn = _open_with_retry(path)
    try:
        conn = _repair_if_corrupt(conn, path)
        _ensure_project_schema(conn, db_path=path)
        _LOG.debug("project db ready in %.1fms (hash=%s)", (time.monotonic() - t0) * 1000, project_hash[:8])
        yield conn
    finally:
        _log_session_close(f"project db {project_hash[:8]}", t0, conn, checkpoint=True)


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
    conn: sqlite3.Connection | None = None
    uri_ro = str(db_path.as_uri()) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri_ro, uri=True, isolation_level=None, timeout=10.0)
        conn.row_factory = sqlite3.Row
        _apply_connection_pragmas(conn)
        # Force SQLite to actually open the DB file and its WAL sidecars.
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    except Exception as exc:
        # Catch all exceptions from the WAL path to ensure we close the connection
        # and attempt fallback. This includes OperationalError, DatabaseError, and
        # any other exceptions (e.g., from _apply_connection_pragmas).
        _LOG.info(
            "WAL read-only open failed for %s (%s) — retrying in immutable mode",
            db_path.name,
            exc,
        )
        _close_conn(conn)
        conn = None
        uri_imm = str(db_path.as_uri()) + "?mode=ro&immutable=1"
        try:
            conn = sqlite3.connect(uri_imm, uri=True, isolation_level=None, timeout=10.0)
            conn.row_factory = sqlite3.Row
            _apply_connection_pragmas(conn, suppress=True)
            # Verify the immutable open actually works (same lazy-open reason).
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        except (sqlite3.DatabaseError, Exception) as exc2:
            # Catch both DatabaseError and any other exception to avoid leaking the connection.
            _close_conn(conn)
            if isinstance(exc2, sqlite3.DatabaseError):
                raise DBBusyError(
                    f"read-only connection failed for {db_path.name}: {exc2}"
                ) from exc2
            raise
        else:
            return conn
    else:
        return conn


@contextlib.contextmanager
def _open_readonly_ctx(path: Path) -> Iterator[sqlite3.Connection]:
    """Shared context manager: connect *path* read-only, yield, close on exit.

    Extracted to eliminate the identical try/finally pattern duplicated across
    open_global_readonly() and open_project_readonly(). Callers are responsible
    for existence checks (and their distinct error messages) before calling this.
    """
    conn = _connect_readonly(path)
    try:
        yield conn
    finally:
        _close_conn(conn)


@contextlib.contextmanager
def open_global_readonly() -> Iterator[sqlite3.Connection]:
    """Read-only connection to global.db, skipping integrity_check and schema DDL.

    Intended for stats reads where correctness and performance matter more than
    schema migrations. Raises FileNotFoundError if global.db does not exist yet.
    """
    path = paths.global_db_path()
    if not path.exists():
        raise FileNotFoundError(f"global.db not found: {path}")
    with _open_readonly_ctx(path) as conn:
        yield conn


@contextlib.contextmanager
def open_project_readonly(project_hash: str) -> Iterator[sqlite3.Connection]:
    """Read-only connection to a per-project DB, skipping integrity_check and schema DDL.

    Raises FileNotFoundError if the project DB does not exist yet.
    """
    _validate_project_hash(project_hash)
    path = paths.project_db_path(project_hash)
    if not path.exists():
        raise FileNotFoundError(f"project db not found: {path}")
    with _open_readonly_ctx(path) as conn:
        yield conn


# ---------------------------------------------------------------------------
# Writer lockfile
# ---------------------------------------------------------------------------


def _pid_alive(pid: int) -> bool:
    """Check if a process with the given PID is still alive.

    On Windows, os.kill(pid, 0) raises PermissionError for living processes
    because Windows doesn't allow signal 0 to processes without the right ACL.
    This function handles that correctly:

    - First, tries psutil.pid_exists() if available (recommended).
    - Falls back to os.kill(pid, 0) with proper Windows PermissionError handling:
      - ProcessLookupError: PID is dead.
      - PermissionError: Windows says process exists (we lack permission to signal it).
      - Other OSError: Assume dead to avoid false positives.
    """
    try:
        import psutil
        return psutil.pid_exists(pid)
    except ImportError:
        pass

    # Fallback: use os.kill(pid, 0) to check if PID is alive.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Windows: PermissionError means the process exists but we lack ACL permission.
        return True
    except OSError:
        return False
    else:
        return True


@contextlib.contextmanager
def project_writer_lock(project_hash: str, timeout_sec: float = 5.0) -> Iterator[None]:
    """File-based writer lock for a project DB.

    Writes <locks_dir>/<hash>.lock containing ``<pid>\\n<timestamp>\\n<platform>``.
    Stale locks (>10 min old, or owning PID not alive) are auto-cleared.
    Cross-platform locks (written on different OS) are stale after 60s.
    Raises TimeoutError if the lock cannot be acquired within *timeout_sec*.
    """
    _validate_project_hash(project_hash)
    lock_path = paths.locks_dir() / f"{project_hash}.lock"
    paths.ensure_dir(lock_path.parent)
    deadline = time.monotonic() + timeout_sec
    pid = os.getpid()
    current_platform = sys.platform

    def _stale(lock_text: str) -> bool:
        """Return True if the lock file content represents a stale (dead) lock.

        A lock is stale if:
        - The owning PID no longer exists, OR
        - The timestamp is older than 10 minutes (crash recovery), OR
        - The lock was written on a different platform AND is older than 60 seconds.

        Empty/malformed content is the microsecond window between the O_EXCL
        create and the owner's ``os.write`` — it is NOT treated as stale, so a
        concurrent acquirer cannot unlink a lock that is being populated. The
        file's mtime is the fallback: a process that crashed inside that window
        leaves an empty file whose mtime ages out, so the lock still self-heals.
        """
        try:
            lines = lock_text.strip().split("\n")
            owner_pid = int(lines[0])
            owner_ts = float(lines[1]) if len(lines) > 1 else 0.0
            owner_platform = lines[2] if len(lines) > 2 else None

            # Check if lock is older than normal timeout.
            if time.time() - owner_ts > LOCK_STALE_SECONDS:
                return True

            # If lock was written on a different platform, use shorter timeout.
            if owner_platform and owner_platform != current_platform:
                return time.time() - owner_ts > LOCK_CROSS_PLATFORM_STALE_SECONDS

            # Check if owning process is still alive.
            return not _pid_alive(owner_pid)
        except (ValueError, IndexError):
            try:
                age = time.time() - lock_path.stat().st_mtime
            except OSError:
                return False
            return age > LOCK_STALE_SECONDS

    def _try_acquire() -> bool:
        """Attempt a single lock acquisition via an atomic O_EXCL create.

        ``os.open(O_CREAT | O_EXCL)`` makes *creation* the mutex — exactly one
        caller can create the lock file. The previous check-then-write
        (``if lock_path.exists(): ... else: write_text(...)``) had a TOCTOU
        window: two callers that both observed the file absent each wrote it
        and each believed it held the lock. Mirrors ``worker._try_claim_worker_slot``.
        """
        for attempt in (1, 2):
            try:
                # 0o600: owner-only — the lock file contains a PID, timestamp,
                # and platform string that should not be visible to other local
                # users on multi-user systems.
                fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                try:
                    text = lock_path.read_text(encoding="utf-8")
                except OSError as e:
                    _LOG.debug("lock read failed for %s: %s", lock_path.name, e)
                    return False
                if not _stale(text):
                    return False
                if attempt == 2:
                    return False  # cleared a stale lock once already; let the caller re-loop
                # Stale — log at info (clearing another PID's lock is notable) and remove
                _LOG.info("clearing stale writer lock for project %s (lock content: %s)",
                          project_hash[:8], text.strip()[:60])
                with contextlib.suppress(FileNotFoundError):
                    lock_path.unlink()
                continue  # retry the atomic create once
            except OSError as e:
                _LOG.debug("lock create failed for %s: %s", lock_path.name, e)
                return False
            # We hold the lock — record owner pid + timestamp + platform, then release the fd.
            try:
                os.write(fd, f"{pid}\n{time.time()}\n{current_platform}".encode())
            finally:
                os.close(fd)
            return True
        return False

    acquired = False
    t0 = time.monotonic()
    waited = False
    holder_pid = None
    retries = 0
    while True:
        if _try_acquire():
            acquired = True
            break
        waited = True
        retries += 1
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
        _LOG.info(
            "writer lock acquired for project %s after %.3fs (retries=%d, held by pid=%s)",
            project_hash[:8], elapsed, retries, holder_pid,
        )
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
    except FileNotFoundError:
        # DB does not exist yet — normal for un-indexed projects; not worth logging.
        return 0
    except Exception as exc:
        # Log at WARNING: returning 0 here is indistinguishable from "never indexed"
        # to callers, so a silent swallow can trigger unnecessary full reindexes.
        _LOG.warning("file_count(%s…) failed, returning 0: %s", project_hash[:8], exc)
        return 0


def count_symbols_for_file(project_hash: str, file_rel: str) -> int:
    """How many symbols are indexed for a single file. 0 means the file is indexed
    but yielded no symbols — a config file, an empty module, or content the parser
    could not extract anything structural from. Distinct from "file not indexed".
    """
    try:
        with open_project_readonly(project_hash) as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM symbols WHERE file_rel = ?",
                (file_rel,),
            ).fetchone()
            return int(row[0]) if row else 0
    except FileNotFoundError:
        return 0  # DB does not exist yet — normal for un-indexed projects
    except Exception as exc:
        _LOG.warning(
            "count_symbols_for_file(%s…, %s) failed, returning 0: %s",
            project_hash[:8], file_rel, exc,
        )
        return 0


def project_has_files(project_hash: str) -> bool:
    """Return True when the project DB already contains at least one file row."""
    try:
        with open_project_readonly(project_hash) as conn:
            return conn.execute("SELECT 1 FROM files LIMIT 1").fetchone() is not None
    except FileNotFoundError:
        return False
    except (sqlite3.Error, OSError) as e:
        _LOG.debug("project_is_indexed(%s…) failed: %s", project_hash[:8], e)
        return False


def project_last_indexed_ts(project_hash: str) -> float:
    """Return the Unix timestamp of the most-recently-indexed file in *project_hash*.

    Queries ``MAX(indexed_at)`` from the ``files`` table of the project DB.
    Returns 0.0 when the project has no indexed files, the DB does not exist,
    or any error occurs (fail-soft — callers treat 0.0 as "never indexed").

    Intended for freshness checks that want to know how stale the index is
    relative to wall-clock time, e.g.::

        age_hours = (time.time() - db.project_last_indexed_ts(proj.hash)) / 3600

    The underlying column is ``INTEGER NOT NULL`` (Unix epoch seconds at
    index time), so the returned float is second-precision.
    """
    try:
        with open_project_readonly(project_hash) as conn:
            row = conn.execute("SELECT MAX(indexed_at) FROM files").fetchone()
            if row is None or row[0] is None:
                return 0.0
            return float(row[0])
    except FileNotFoundError:
        return 0.0  # DB does not exist yet — normal for un-indexed projects
    except (sqlite3.Error, OSError) as e:
        _LOG.debug("project_last_indexed_ts(%s…) failed: %s", project_hash[:8], e)
        return 0.0


def list_all_project_hashes() -> list[str]:
    """Return the hash of every project registered in the global DB.

    Used by cross-project operations (e.g. ``token-goat semantic --all-projects``)
    to iterate all known project DBs.  Returns an empty list when the global DB
    does not exist or is unreadable — callers must gracefully handle the empty case.
    """
    try:
        with open_global_readonly() as conn:
            rows = conn.execute("SELECT hash FROM projects").fetchall()
        return [str(r["hash"]) for r in rows]
    except FileNotFoundError:
        return []
    except (DBError, sqlite3.Error, OSError) as exc:
        _LOG.debug("list_all_project_hashes: global DB unavailable: %s", exc)
        return []


def touch_project_last_seen(project_hash: str) -> None:
    """Bump a project's last_seen to mark recent user activity. Best-effort.

    No-op if the project is not yet registered (never indexed) — the first
    index_project() call registers it. Called by the SessionStart hook so the
    worker's periodic-reindex window tracks real user activity rather than the
    worker's own background reindex cadence (which would otherwise keep every
    project "active" forever).
    """
    def _do() -> None:
        with open_global() as conn:
            conn.execute(
                "UPDATE projects SET last_seen = ? WHERE hash = ?",
                (int(time.time()), project_hash),
            )

    _best_effort_write(_do, "touch_project_last_seen")


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
                """Return the row count for *table* in the current project DB.

                Raises ``ValueError`` for unknown table names (allowlist guard
                against SQL injection since the name is interpolated directly
                into the query via ``_KNOWN_PROJECT_TABLES``).
                """
                if table not in _KNOWN_PROJECT_TABLES:
                    raise ValueError(f"_count: unknown table name {table!r}")
                row = conn.execute(f'SELECT COUNT(*) FROM [{table}]').fetchone()
                return int(row[0]) if row else 0

            result["file_count"] = _count("files")
            result["symbol_count"] = _count("symbols")
            result["ref_count"] = _count("refs")
            result["section_count"] = _count("sections")
            result["chunk_count"] = _count("chunks")

            with contextlib.suppress(sqlite3.OperationalError):
                result["embedding_count"] = _count("embeddings")

            result["schema_version"] = _get_meta(conn, "schema_version")
            result["embeddings_disabled"] = _get_meta(conn, "embeddings_disabled") is not None

            result["ok"] = True
    except (sqlite3.Error, DBError, OSError) as exc:
        _LOG.warning("index_health failed for %s: %s", project_hash[:8], exc)
    return result


def fts_available(project_hash: str) -> bool:
    """Return True if the FTS5 index is usable for this project."""
    try:
        with open_project_readonly(project_hash) as conn:
            val = conn.execute("SELECT value FROM meta WHERE key='fts_disabled'").fetchone()
            return val is None
    except Exception:
        return False


_MAX_STAT_KIND_LEN: int = 64
_MAX_STAT_DETAIL_LEN: int = 512
_MISS_NEEDLE_MAX: int = 512
_MISS_FILE_HINT_MAX: int = 512

# Amortization threshold: only update global.db when the stored last_ts is
# older than this many seconds.  Prevents hot-path writes on every grep call
# for frequently repeated patterns (e.g. `rg "TODO"` at session start).
_GREP_PATTERN_WRITE_STALE_SECS: Final[float] = 24 * 3600  # 24 hours


def update_global_grep_pattern(pattern_hash: str, pattern_text: str, now: float) -> None:
    """Upsert a grep pattern row in global.db::grep_patterns, amortized.

    Only writes when the pattern is new OR the stored ``last_ts`` is more than
    ``_GREP_PATTERN_WRITE_STALE_SECS`` old.  This amortizes the write cost to
    ~1 write per day per unique pattern, keeping the hot pre-Grep hook path fast.

    The caller is responsible for filtering out low-result patterns before
    calling this function (gate on ``result_count >= _GREP_DEDUP_MIN_RESULT_COUNT``
    in session.mark_grep).

    Best-effort: any DB error is swallowed so a broken global.db cannot
    interrupt the agent's Grep call.
    """
    def _do() -> None:
        with open_global() as conn:
            row = conn.execute(
                "SELECT last_ts FROM grep_patterns WHERE pattern_hash = ?",
                (pattern_hash,),
            ).fetchone()
            if row is not None:
                age = now - float(row[0])
                if age < _GREP_PATTERN_WRITE_STALE_SECS:
                    # Recent enough — skip the write entirely.
                    return
            # UPSERT: insert new row or refresh last_ts and increment count.
            conn.execute(
                """
                INSERT INTO grep_patterns (pattern_hash, first_pattern, last_ts, count)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(pattern_hash) DO UPDATE SET
                    last_ts = excluded.last_ts,
                    count   = grep_patterns.count + 1
                """,
                (pattern_hash, pattern_text, now),
            )

    _best_effort_write(_do, "update_global_grep_pattern")


def record_stat(
    project_hash: str | None,
    kind: str,
    tokens_saved: int = 0,
    bytes_saved: int = 0,
    detail: str | None = None,
) -> None:
    """Append a row to the stats table of the appropriate DB.

    *kind* is truncated to ``_MAX_STAT_KIND_LEN`` (64) characters and *detail*
    to ``_MAX_STAT_DETAIL_LEN`` (512) characters before the INSERT.  Both fields
    can originate from external hook payloads (file paths, symbol names) so
    bounding them prevents unbounded DB growth from adversarial or pathologically
    long inputs.
    """
    ts = int(time.time())
    # Truncate caller-supplied strings to prevent unbounded DB row growth from
    # hook payloads containing very long file paths or symbol names.
    if len(kind) > _MAX_STAT_KIND_LEN:
        kind = kind[:_MAX_STAT_KIND_LEN]
    if detail is not None and len(detail) > _MAX_STAT_DETAIL_LEN:
        detail = detail[:_MAX_STAT_DETAIL_LEN]
    sql = "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail, last_access_epoch) VALUES (?, ?, ?, ?, ?, ?)"
    params = (ts, kind, tokens_saved, bytes_saved, detail, time.time())
    def _do() -> None:
        if project_hash is not None:
            with open_project(project_hash) as conn:
                conn.execute(sql, params)
        else:
            with open_global() as conn:
                conn.execute(sql, params)

    _best_effort_write(_do, "record_stat")


def record_miss(needle: str, file_hint: str = "") -> None:
    """Increment the miss counter for *(needle, file_hint)* in the global DB.

    Uses an upsert so the first call inserts with miss_count=1 and subsequent
    calls atomically increment.  Both strings are truncated to bounded lengths
    so adversarial or pathologically long inputs don't cause unbounded row growth.
    """
    needle = needle[:_MISS_NEEDLE_MAX]
    file_hint = file_hint[:_MISS_FILE_HINT_MAX]
    now = time.time()

    def _do() -> None:
        with open_global() as conn:
            conn.execute(
                """
                INSERT INTO miss_patterns (needle, file_hint, miss_count, last_miss_epoch)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(needle, file_hint) DO UPDATE SET
                    miss_count = miss_count + 1,
                    last_miss_epoch = excluded.last_miss_epoch
                """,
                (needle, file_hint, now),
            )

    _best_effort_write(_do, "record_miss")


def get_miss_count(needle: str, file_hint: str = "") -> int:
    """Return the current miss count for *(needle, file_hint)*; 0 if not found."""
    needle = needle[:_MISS_NEEDLE_MAX]
    file_hint = file_hint[:_MISS_FILE_HINT_MAX]
    try:
        with open_global_readonly() as conn:
            row = conn.execute(
                "SELECT miss_count FROM miss_patterns WHERE needle = ? AND file_hint = ?",
                (needle, file_hint),
            ).fetchone()
        return int(row["miss_count"]) if row else 0
    except Exception:
        return 0


def reset_miss(needle: str, file_hint: str = "") -> None:
    """Delete the miss-pattern row for *(needle, file_hint)* on a successful resolve.

    Resetting on success means the counter only reflects *consecutive* misses,
    so a needle that was eventually found won't keep triggering hints in future
    sessions.
    """
    needle = needle[:_MISS_NEEDLE_MAX]
    file_hint = file_hint[:_MISS_FILE_HINT_MAX]

    def _do() -> None:
        with open_global() as conn:
            conn.execute(
                "DELETE FROM miss_patterns WHERE needle = ? AND file_hint = ?",
                (needle, file_hint),
            )

    _best_effort_write(_do, "reset_miss")


def get_symbol_callers(
    project_hash: str,
    symbol_name: str,
    limit: int = 3,
) -> list[dict[str, object]]:
    """Return up to *limit*+1 call-site rows for *symbol_name* in the project.

    Each row is a dict with keys ``"file_rel"`` (str) and ``"line"`` (int).
    Returning *limit*+1 rows allows the caller to detect "and more" without a
    separate COUNT query — when ``len(result) > limit`` the caller knows there
    are additional callers beyond what is shown.

    Returns an empty list on any DB error (fail-soft: a broken refs table must
    not interrupt the agent's read).  Also returns ``[]`` when the project DB
    does not exist (not yet indexed).
    """
    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT file_rel, line FROM refs WHERE symbol_name = ? "
                "ORDER BY file_rel, line LIMIT ?",
                (symbol_name, limit + 1),
            ).fetchall()
        return [{"file_rel": str(r["file_rel"]), "line": int(r["line"])} for r in rows]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def get_file_exports(
    project_hash: str,
    file_rel: str,
) -> list[dict[str, object]]:
    """Return public symbols exported from *file_rel* in the given project.

    A symbol is considered public when:
    - its name does **not** start with ``_``, and
    - its kind is not ``"method"`` (methods are class-nested, even when
      ``parent_id IS NULL`` in older index builds).

    If the source file defines an ``__all__`` list, only the names present
    in that list are returned.  ``__all__`` is parsed directly from the
    source (via ``ast``) rather than the index, because it is a module-level
    variable assignment and is not always indexed as a symbol.

    Each returned dict has keys:
    ``"name"`` (str), ``"kind"`` (str), ``"start_line"`` (int),
    ``"end_line"`` (int | None), ``"docstring"`` (str | None).

    Returns an empty list on any DB or I/O error (fail-soft).
    """
    import ast as _ast

    # Kinds that count as "top-level structural symbols" — excludes "method"
    # which the Python extractor promotes with parent_id=NULL in some builds.
    _TOP_LEVEL_KINDS = frozenset({
        "function", "async_function", "class", "interface", "struct", "trait",
        "enum", "type_alias", "constructor",
    })

    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT name, kind, line AS start_line, end_line "
                "FROM symbols "
                "WHERE file_rel = ? AND end_line IS NOT NULL "
                "ORDER BY line",
                (file_rel,),
            ).fetchall()
    except FileNotFoundError:
        return []
    except Exception:
        return []

    # Build lookup of public top-level symbol rows by name.
    symbol_map: dict[str, dict[str, object]] = {}
    for r in rows:
        name = str(r["name"])
        kind = str(r["kind"])
        if name.startswith("_"):
            continue
        if kind not in _TOP_LEVEL_KINDS:
            continue
        symbol_map[name] = {
            "name": name,
            "kind": kind,
            "start_line": int(r["start_line"]),
            "end_line": int(r["end_line"]) if r["end_line"] is not None else None,
            "docstring": None,
        }

    # Try to find the source file and detect __all__ via AST.
    exported_names: set[str] | None = None
    try:
        project_root = _get_project_root(project_hash)
        if project_root is not None:
            abs_path = project_root / file_rel
            source_text = abs_path.read_text(encoding="utf-8", errors="replace")
            tree = _ast.parse(source_text, mode="exec")
            for node in _ast.walk(tree):
                if (
                    isinstance(node, _ast.Assign)
                    and any(
                        isinstance(t, _ast.Name) and t.id == "__all__"
                        for t in node.targets
                    )
                    and isinstance(node.value, (_ast.List, _ast.Tuple))
                ):
                    exported_names = {
                        elt.value
                        for elt in node.value.elts
                        if isinstance(elt, _ast.Constant) and isinstance(elt.value, str)
                    }
                    break
    except Exception:
        pass

    if exported_names is not None:
        # Return only symbols that appear in __all__ AND are indexed.
        result = [symbol_map[n] for n in exported_names if n in symbol_map]
        result.sort(key=lambda d: int(d["start_line"]))  # type: ignore[call-overload]
        return result

    # No __all__: return all public top-level symbols sorted by line.
    return list(symbol_map.values())


def get_symbol_refs(
    project_hash: str,
    file_path: str,
    symbol_name: str,
    limit: int = 50,
) -> list[dict[str, object]]:
    """Return call-site rows for *symbol_name* defined in *file_path*.

    Looks up all refs where the symbol name matches *symbol_name* and the
    symbol is defined in a file whose path matches *file_path* (partial
    ``LIKE`` match).  Each row is a dict with keys ``"path"`` (str),
    ``"line"`` (int), and ``"context"`` (str | None).

    Returns an empty list on any DB error (fail-soft).  Also returns ``[]``
    when the project DB does not exist (not yet indexed).
    """
    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT r.file_rel AS path, r.line, r.context "
                "FROM refs r "
                "WHERE r.symbol_name = ? "
                "  AND EXISTS ("
                "      SELECT 1 FROM symbols s "
                "      WHERE s.name = r.symbol_name "
                "        AND s.file_rel LIKE ?"
                "  ) "
                "ORDER BY r.file_rel, r.line "
                "LIMIT ?",
                (symbol_name, f"%{file_path}%", limit),
            ).fetchall()
        return [
            {
                "path": str(r["path"]),
                "line": int(r["line"]),
                "context": r["context"],
            }
            for r in rows
        ]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def get_refs_with_callers(
    project_hash: str,
    file_path: str,
    symbol_name: str,
    limit: int = 50,
) -> list[dict[str, object]]:
    """Return call-site rows for *symbol_name* with enclosing function resolution.

    Like :func:`get_symbol_refs`, but each row also includes ``"caller_name"``
    (str | None) and ``"caller_kind"`` (str | None) — the innermost enclosing
    function or method that contains the reference line.  When a ref is at
    module level or no enclosing function can be found, both fields are ``None``.

    Resolution is pure SQL: for each ref row we find the deepest symbol in the
    same file whose ``line <= ref.line <= end_line`` and whose ``kind`` is
    ``"function"``, ``"async_function"``, ``"method"``, or ``"constructor"``.
    If multiple symbols share the same start line (overloads, decorators), the
    one with the highest ``id`` (latest inserted) wins via ``ORDER BY id DESC``.

    Returns an empty list on any DB error (fail-soft).
    """
    _FUNCTION_KINDS = ("function", "async_function", "method", "constructor")
    kinds_placeholders = ",".join("?" * len(_FUNCTION_KINDS))

    query = f"""
        SELECT
            r.file_rel  AS path,
            r.line,
            r.context,
            (
                SELECT s.name
                FROM symbols s
                WHERE s.file_rel = r.file_rel
                  AND s.kind IN ({kinds_placeholders})
                  AND s.line <= r.line
                  AND (s.end_line IS NULL OR s.end_line >= r.line)
                ORDER BY s.line DESC, s.id DESC
                LIMIT 1
            ) AS caller_name,
            (
                SELECT s.kind
                FROM symbols s
                WHERE s.file_rel = r.file_rel
                  AND s.kind IN ({kinds_placeholders})
                  AND s.line <= r.line
                  AND (s.end_line IS NULL OR s.end_line >= r.line)
                ORDER BY s.line DESC, s.id DESC
                LIMIT 1
            ) AS caller_kind
        FROM refs r
        WHERE r.symbol_name = ?
          AND EXISTS (
              SELECT 1 FROM symbols s
              WHERE s.name = r.symbol_name
                AND s.file_rel LIKE ?
          )
        ORDER BY r.file_rel, r.line
        LIMIT ?
    """
    params = (*_FUNCTION_KINDS, *_FUNCTION_KINDS, symbol_name, f"%{file_path}%", limit)

    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            {
                "path": str(r["path"]),
                "line": int(r["line"]),
                "context": r["context"],
                "caller_name": r["caller_name"],
                "caller_kind": r["caller_kind"],
            }
            for r in rows
        ]
    except FileNotFoundError:
        return []
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Type definitions query
# ---------------------------------------------------------------------------

# Regex patterns to detect Python type-like constructs from a class definition header
# and body. These run on the first few lines of a class body to classify it.
_RE_TYPED_DICT_BASE = re.compile(r"\bTypedDict\b")
_RE_PROTOCOL_BASE = re.compile(r"\bProtocol\b")
_RE_DATACLASS_DECO = re.compile(r"@\s*dataclass\b")
_RE_NAMEDTUPLE_ASSIGN = re.compile(r"\bnamedtuple\s*\(")
_RE_NAMEDTUPLE_TYPED = re.compile(r"\bNamedTuple\b")
_RE_PYDANTIC_BASE = re.compile(
    r"\b(?:BaseModel|RootModel|BaseSettings|SQLModel|GenericModel)\b"
)
# Matches a field annotation line inside a class body: `    field_name: SomeType`
# (indented by at least one space, followed by an identifier, then a colon)
_RE_FIELD_LINE = re.compile(r"^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*:")

# Maximum source lines to scan above a class definition to detect @dataclass
_DECO_SCAN_LINES = 6
# Maximum source lines to scan inside a class body to extract fields
_FIELD_SCAN_LINES = 80


def _classify_class(
    source_lines: list[str],
    start_line: int,
    end_line: int,
) -> tuple[str, list[str]]:
    """Classify a class symbol and extract its field names.

    *source_lines* is the full file as a list (0-indexed).
    *start_line* and *end_line* are 1-based.

    Returns ``(type_kind, fields)`` where *type_kind* is one of:
    ``"TypedDict"``, ``"Protocol"``, ``"dataclass"``, ``"namedtuple"``,
    ``"NamedTuple"``, ``"pydantic"``, or ``""`` (plain class, not a type def).

    Fields are extracted from annotation lines inside the class body
    (``field_name: SomeType`` pattern).
    """
    n = len(source_lines)
    # 0-based index of the class header line
    header_idx = max(0, start_line - 1)

    # Scan decorator lines above the class header for @dataclass
    scan_start = max(0, header_idx - _DECO_SCAN_LINES)
    header_region = "\n".join(source_lines[scan_start : header_idx + 1])

    # Collect body text from the lines following the header
    body_end = min(n, end_line)
    body_start = header_idx + 1
    body_lines = source_lines[body_start : min(body_end, body_start + _FIELD_SCAN_LINES)]

    # --- classify ---
    type_kind = ""
    if _RE_TYPED_DICT_BASE.search(header_region):
        type_kind = "TypedDict"
    elif _RE_NAMEDTUPLE_ASSIGN.search(header_region):
        type_kind = "namedtuple"
    elif _RE_NAMEDTUPLE_TYPED.search(header_region):
        type_kind = "NamedTuple"
    elif _RE_PROTOCOL_BASE.search(header_region):
        type_kind = "Protocol"
    elif _RE_DATACLASS_DECO.search(header_region):
        type_kind = "dataclass"
    elif _RE_PYDANTIC_BASE.search(header_region):
        type_kind = "pydantic"

    # --- extract fields from body annotation lines ---
    fields: list[str] = []
    if type_kind:
        for line in body_lines:
            m = _RE_FIELD_LINE.match(line)
            if m:
                name = m.group(1)
                # Skip dunder names and private names
                if not name.startswith("_"):
                    fields.append(name)

    return type_kind, fields


def get_type_definitions(
    project_hash: str,
    file_path: str | None = None,
) -> list[dict[str, object]]:
    """Return type definition symbols (TypedDict, Protocol, dataclass, namedtuple, Pydantic)
    from the indexed project.

    When *file_path* is ``None``, searches across all files in the project.
    When *file_path* is set, restricts results to that file (partial LIKE match).

    Each returned dict has keys:
    ``"name"`` (str), ``"type_kind"`` (str), ``"file"`` (str),
    ``"start_line"`` (int), ``"fields"`` (list[str]).

    Returns an empty list on any DB or I/O error (fail-soft).
    """
    try:
        with open_project_readonly(project_hash) as conn:
            if file_path is not None:
                rows = conn.execute(
                    "SELECT name, kind, file_rel, line, end_line "
                    "FROM symbols "
                    "WHERE kind = 'class' AND file_rel LIKE ? AND end_line IS NOT NULL "
                    "ORDER BY file_rel, line",
                    (f"%{file_path}%",),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT name, kind, file_rel, line, end_line "
                    "FROM symbols "
                    "WHERE kind = 'class' AND end_line IS NOT NULL "
                    "ORDER BY file_rel, line",
                ).fetchall()
    except FileNotFoundError:
        return []
    except Exception:
        return []

    if not rows:
        return []

    # Get the project root so we can read source files.
    project_root = _get_project_root(project_hash)

    # Group rows by file_rel to minimise file reads.
    from collections import defaultdict as _defaultdict

    rows_by_file: dict[str, list[object]] = _defaultdict(list)
    for row in rows:
        rows_by_file[str(row["file_rel"])].append(row)

    results: list[dict[str, object]] = []
    for file_rel, file_rows in rows_by_file.items():
        # Read source lines for this file once.
        source_lines: list[str] = []
        if project_root is not None:
            try:
                abs_path = project_root / file_rel
                source_lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                pass

        for row in file_rows:
            start = int(row["line"])  # type: ignore[index]
            end = int(row["end_line"])  # type: ignore[index]
            name = str(row["name"])  # type: ignore[index]

            if source_lines:
                type_kind, fields = _classify_class(source_lines, start, end)
            else:
                type_kind, fields = "", []

            if not type_kind:
                continue  # plain class — skip

            results.append({
                "name": name,
                "type_kind": type_kind,
                "file": file_rel,
                "start_line": start,
                "fields": fields,
            })

    return results


# ---------------------------------------------------------------------------
# Import graph queries
# ---------------------------------------------------------------------------

def _import_stem(target: str) -> str | None:
    """Extract the module stem from a relative import target string.

    A relative import target starts with one or more leading dots.  The stem is
    the first identifier component after the dots, which names the module file.

    Examples::

        ``..db``              → ``"db"``
        ``..db.SomeClass``    → ``"db"``
        ``.project.Project``  → ``"project"``
        ``.util``             → ``"util"``
        ``typer``             → ``None``  (absolute import — no stem)

    Returns ``None`` for absolute imports (no leading dot) or empty targets.
    """
    stripped = target.lstrip(".")
    if not stripped or stripped == target:
        # No leading dot → absolute import; stem does not map to a project file.
        return None
    return stripped.split(".")[0]


def get_file_imports(
    project_hash: str,
    file_rel: str,
) -> list[str]:
    """Return project-internal files that *file_rel* imports from (outgoing, one level).

    Queries the ``imports_exports`` table for relative import targets recorded
    for *file_rel*, resolves each to a concrete ``file_rel`` path by matching the
    module stem against known project files, and returns the sorted, deduplicated
    list of resolved paths.

    Only relative imports (targets starting with ``.``) are considered; stdlib /
    third-party absolute imports are excluded because they have no ``file_rel`` in
    the project DB.

    Returns an empty list on any DB error (fail-soft) or when the project DB
    does not exist (not yet indexed).
    """
    try:
        with open_project_readonly(project_hash) as conn:
            # Collect all relative import targets for this file.
            target_rows = conn.execute(
                "SELECT DISTINCT target FROM imports_exports "
                "WHERE file_rel = ? AND kind = 'import' AND target LIKE '.%' "
                "ORDER BY target",
                (file_rel,),
            ).fetchall()
            if not target_rows:
                return []

            # Build a set of all .py file paths in the project for fast lookup.
            all_files: set[str] = {
                str(r["rel_path"])
                for r in conn.execute(
                    "SELECT rel_path FROM files WHERE rel_path LIKE '%.py'",
                ).fetchall()
            }

        resolved: set[str] = set()
        for row in target_rows:
            stem = _import_stem(str(row["target"]))
            if stem is None:
                continue
            # Match files whose last path component equals <stem>.py.
            suffix = f"/{stem}.py"
            for candidate in all_files:
                if candidate.endswith(suffix) or candidate == f"{stem}.py":
                    if candidate != file_rel:
                        resolved.add(candidate)
                    break
        return sorted(resolved)
    except FileNotFoundError:
        return []
    except Exception:
        return []


def get_file_importers(
    project_hash: str,
    file_rel: str,
) -> list[str]:
    """Return project-internal files that import *file_rel* (incoming, one level).

    Queries ``imports_exports`` for rows whose ``target`` resolves to *file_rel*,
    covering both relative imports (e.g. ``..db``, ``.db.Symbol``) and absolute
    package imports (e.g. ``token_goat.db``, ``token_goat.db.Symbol``).

    The match is stem-based: the stem of *file_rel* (e.g. ``"db"`` from
    ``src/token_goat/db.py``) is matched against the first identifier component of
    each import target.  Both ``..db`` and ``token_goat.db`` produce stem ``"db"``.

    Returns a sorted, deduplicated list of ``file_rel`` paths that import this
    file.  Returns an empty list on any DB error (fail-soft) or when the project
    DB does not exist (not yet indexed).
    """
    # Extract the stem of the queried file.
    # ``src/token_goat/db.py`` → ``"db"``
    # ``db.py`` → ``"db"``
    raw_stem = file_rel.rsplit("/", 1)[-1]
    raw_stem = raw_stem.removesuffix(".py")
    if not raw_stem:
        return []
    stem = raw_stem

    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                # Match relative imports: .stem  ..stem  ...stem  (with optional .Symbol suffix)
                # Match absolute imports: ends with .<stem>  or .<stem>.<Symbol>
                "SELECT DISTINCT file_rel FROM imports_exports "
                "WHERE kind = 'import' AND file_rel != ? AND ("
                "  target = '.' || ? "
                "  OR target LIKE '.' || ? || '.%' "
                "  OR target = '..' || ? "
                "  OR target LIKE '..' || ? || '.%' "
                "  OR target = '...' || ? "
                "  OR target LIKE '...' || ? || '.%' "
                "  OR target = ? "
                "  OR target LIKE '%.' || ? "
                "  OR target LIKE '%.' || ? || '.%' "
                ") "
                "ORDER BY file_rel",
                (
                    file_rel,
                    stem, stem,           # .stem  .stem.X
                    stem, stem,           # ..stem  ..stem.X
                    stem, stem,           # ...stem  ...stem.X
                    stem,                 # bare absolute: stem (unlikely but safe)
                    stem,                 # ends with .stem
                    stem,                 # ends with .stem.X
                ),
            ).fetchall()
        return [str(r["file_rel"]) for r in rows]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def get_compression_stats(session_id: str | None = None) -> dict:
    """Return focused compression metrics from the global stats table.

    When *session_id* is provided the query is restricted to events recorded
    since that session's ``started_ts``; pass ``None`` for all-time aggregates.

    Returns a dict with keys:
      tokens_saved        – sum of tokens_saved across positive (non-overhead) rows
      outputs_compressed  – count of bash_output_cached events
      reread_denies       – count of reread_deny events
      images_shrunk       – count of image_shrink / image_shrink_cache_hit events
      top_filters         – top-3 kinds by tokens_saved: [{"filter": str, "tokens_saved": int}]
    """
    since_ts: float | None = None
    if session_id is not None:
        try:
            from .session import safe_load as _safe_load
            _cache = _safe_load(session_id, caller="get_compression_stats")
            if _cache is not None:
                since_ts = _cache.started_ts
        except Exception:
            pass

    ts_clause = "AND ts >= ?" if since_ts is not None else ""
    base_params: tuple = (since_ts,) if since_ts is not None else ()

    try:
        with open_global_readonly() as conn:
            _row = conn.execute(
                f"SELECT COALESCE(SUM(tokens_saved),0) FROM stats WHERE tokens_saved > 0 AND kind NOT LIKE '%_overhead' {ts_clause}",
                base_params,
            ).fetchone()
            tokens_saved = int(_row[0]) if _row else 0

            _row = conn.execute(
                f"SELECT COUNT(*) FROM stats WHERE kind = 'bash_output_cached' {ts_clause}",
                base_params,
            ).fetchone()
            outputs_compressed = int(_row[0]) if _row else 0

            _row = conn.execute(
                f"SELECT COUNT(*) FROM stats WHERE kind = 'reread_deny' {ts_clause}",
                base_params,
            ).fetchone()
            reread_denies = int(_row[0]) if _row else 0

            _row = conn.execute(
                f"SELECT COUNT(*) FROM stats WHERE kind IN ('image_shrink','image_shrink_cache_hit') {ts_clause}",
                base_params,
            ).fetchone()
            images_shrunk = int(_row[0]) if _row else 0

            _rows = conn.execute(
                f"SELECT kind, SUM(tokens_saved) AS ts_sum FROM stats WHERE tokens_saved > 0 AND kind NOT LIKE '%_overhead' {ts_clause} GROUP BY kind ORDER BY ts_sum DESC LIMIT 3",
                base_params,
            ).fetchall()
            top_filters = [{"filter": str(r[0]), "tokens_saved": int(r[1])} for r in _rows]
    except Exception:
        return {"tokens_saved": 0, "outputs_compressed": 0, "reread_denies": 0, "images_shrunk": 0, "top_filters": []}

    return {
        "tokens_saved": tokens_saved,
        "outputs_compressed": outputs_compressed,
        "reread_denies": reread_denies,
        "images_shrunk": images_shrunk,
        "top_filters": top_filters,
    }



def get_hook_timing_stats(window_days: int = 7) -> dict[str, dict[str, int]]:
    """Return per-hook-event timing stats from the stats table.

    Queries rows where ``kind LIKE 'hook:%'``; ``bytes_saved`` stores
    elapsed_ms written by ``hooks_cli.safe_run`` after each dispatch.

    Args:
        window_days: Look-back window in days.  0 = all time.

    Returns:
        Mapping of event name (stripped of ``hook:`` prefix) →
        ``{count, avg_ms, p95_ms, max_ms}``.
    """
    since_ts = time.time() - (window_days * 86400) if window_days > 0 else 0.0
    result: dict[str, dict[str, int]] = {}
    try:
        with open_global_readonly() as conn:
            rows = conn.execute(
                "SELECT kind, bytes_saved FROM stats WHERE kind LIKE 'hook:%' AND ts >= ? ORDER BY kind",
                (since_ts,),
            ).fetchall()
    except Exception:
        return result
    by_event: dict[str, list[int]] = {}
    for row in rows:
        event = str(row[0])[5:]  # strip leading "hook:"
        ms = max(0, int(row[1]))
        by_event.setdefault(event, []).append(ms)
    for event, values in by_event.items():
        values.sort()
        n = len(values)
        avg_ms = sum(values) // n
        p95_ms = values[max(0, int(n * 0.95) - 1)]
        max_ms = values[-1]
        result[event] = {"count": n, "avg_ms": avg_ms, "p95_ms": p95_ms, "max_ms": max_ms}
    return result


def get_entry_scores(project_hash: str) -> dict[str, float]:
    """Return file_rel → importance score for use by compact manifest trim ordering.

    Score = hit_count * exp(-lambda * age_days) where lambda=0.1 and age_days is
    derived from last_access_epoch. When last_access_epoch is NULL, age_days=30.
    Keys are the raw ``detail`` values from the stats table (typically file paths
    recorded by read/section/symbol events). Returns an empty dict on any error.
    """
    _LAMBDA = 0.1
    _NULL_AGE_DAYS = 30.0
    now = time.time()
    result: dict[str, float] = {}
    try:
        with open_project_readonly(project_hash) as conn:
            rows = conn.execute(
                "SELECT detail, COUNT(*) AS hit_count, MAX(last_access_epoch) AS last_access "
                "FROM stats WHERE detail IS NOT NULL GROUP BY detail"
            ).fetchall()
        for row in rows:
            file_rel = str(row["detail"])
            hit_count = int(row["hit_count"])
            last_access = row["last_access"]
            age_days = (now - float(last_access)) / 86400.0 if last_access is not None else _NULL_AGE_DAYS
            result[file_rel] = hit_count * math.exp(-_LAMBDA * age_days)
    except Exception:
        pass
    return result
