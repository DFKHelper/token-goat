/**
 * SQLite connection management and index-DB schema.
 *
 * Ports the connection-pragma setup from `db.py` (WAL journal mode, NORMAL
 * synchronous) and the index schema (files / symbols / refs / FTS5) that later
 * layers query. Each database file gets one lazily-opened, cached connection.
 *
 * better-sqlite3 is a CommonJS module that exports a default constructor; under
 * NodeNext + `allowSyntheticDefaultImports` the default import binds correctly.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

import { dataDir } from './constants.js'
import { safeJoin } from './paths.js'
import { foldCase, foldPath } from './util.js'
import { registerReset } from './reset.js'

// ESM has no `require`; build one so we can probe for the optional sqlite-vec package without making it a hard module-resolution dependency.
const _require = createRequire(import.meta.url)

// One Database handle per absolute db path. Keyed by the resolved path so two callers naming the same file via different relative strings share a handle.
const _connections = new Map<string, BetterSqlite3Database>()

/**
 * Index-DB schema (matches the spec for Layer 2).
 *
 * Tables:
 *   - files   — one row per indexed source file.
 *   - symbols — extracted definitions (functions, classes, types, ...).
 *   - refs    — references/usages of names, for caller lookups.
 *   - chunks  — semantic search chunk metadata (filePath, startLine, endLine, text, kind).
 *   - symbols_fts — FTS5 mirror of symbols for full-text name/body search.
 *
 * The FTS5 table is content-linked to `symbols` (external-content) so the row
 * data lives once in `symbols`; triggers keep the index in sync on write.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  sha TEXT,
  mtime REAL,
  language TEXT,
  indexed_at REAL,
  embed_sha TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);
-- Expression index on TG_LOWER(path) -- see pathEqClause (sql_path.ts) and TG_LOWER's
-- registration above. TG_LOWER is registered { deterministic: true }, which is required for
-- SQLite to index an expression at all; without it CREATE INDEX on a function call throws
-- "non-deterministic functions prohibited in index expressions". Because pathEqClause emits
-- this exact 'TG_LOWER(path) = ?' text for every case-insensitive-filesystem query, the planner
-- matches it against this index and uses SEARCH instead of a full table SCAN, without requiring
-- any writer to populate a separate folded column (verified via EXPLAIN QUERY PLAN in
-- db.test.ts / sql_path.test.ts). CREATE INDEX IF NOT EXISTS is purely additive and safe to run
-- against an already-populated table on every connection open, unlike an ALTER TABLE column add
-- -- no MIGRATIONS entry or SCHEMA_VERSION bump is needed for this index.
CREATE INDEX IF NOT EXISTS idx_files_path_folded ON files(TG_LOWER(path));

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT,
  name TEXT,
  kind TEXT,
  line_start INTEGER,
  line_end INTEGER,
  body TEXT,
  docstring TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file_folded ON symbols(TG_LOWER(file_path));

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT,
  name TEXT,
  line INTEGER,
  col INTEGER,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_path);
CREATE INDEX IF NOT EXISTS idx_refs_file_folded ON refs(TG_LOWER(file_path));

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  text TEXT,
  kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_file_folded ON chunks(TG_LOWER(file_path));
`

// FTS5 is a compile-time-optional SQLite extension. better-sqlite3 ships with it enabled, but wrap creation so a build without FTS5 still yields a usable (search-degraded) index DB rather than throwing on open.
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  body,
  docstring,
  content='symbols',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, body, docstring)
  VALUES (new.id, new.name, new.body, new.docstring);
END;
CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, body, docstring)
  VALUES ('delete', old.id, old.name, old.body, old.docstring);
END;
CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, body, docstring)
  VALUES ('delete', old.id, old.name, old.body, old.docstring);
  INSERT INTO symbols_fts(rowid, name, body, docstring)
  VALUES (new.id, new.name, new.body, new.docstring);
END;
`

// Bump this the day SCHEMA_SQL changes in a way `CREATE TABLE IF NOT EXISTS` can't express on an
// already-populated table -- a column add/rename/drop, a type change, a data backfill -- and add
// the matching step to MIGRATIONS below. It represents the schema as it exists today.
export const SCHEMA_VERSION = 3 as const

type Migration = (conn: BetterSqlite3Database) => void

// Keyed by the FROM version: MIGRATIONS[1] upgrades a v1 database to v2, MIGRATIONS[2] upgrades
// v2 to v3, and so on. A version with no registered step is a no-op, which also covers a
// SCHEMA_VERSION bump for a purely additive change already handled by `CREATE TABLE IF NOT
// EXISTS` in SCHEMA_SQL (no ALTER TABLE needed).
const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: adds files.embed_sha, tracked separately from files.sha so embedding freshness
  // can be gated independently of parse freshness (see makeIndexer in worker.ts). A pre-existing
  // v1 database's `files` table predates the column, so it needs an explicit ALTER TABLE here;
  // a brand-new database already has the column from SCHEMA_SQL's CREATE TABLE above, so the
  // ALTER TABLE would fail with "duplicate column name" there -- swallow exactly that error and
  // rethrow anything else, so a genuine ALTER TABLE failure is never silently lost.
  1: (conn) => {
    try {
      conn.exec('ALTER TABLE files ADD COLUMN embed_sha TEXT')
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
    }
  },
  // v2 -> v3: adds files.retry_count, a durable per-path counter for consecutive
  // transient-read-failure requeues (see MAX_TRANSIENT_RETRIES / requeueDirtyPath /
  // resetTransientRetryCount in worker.ts). Previously this counter lived only in an
  // in-memory Map inside worker.ts, which meant resetTransientRetryCount -- called from
  // appendDirtyPath (hooks_index.ts) in the short-lived hook CLI process -- could never
  // actually reach the long-lived detached daemon process's own copy of that Map: they are
  // different Node processes with no shared memory, so the reset was a silent no-op in the
  // real deployed topology. Persisting the counter in `files` makes it visible to both
  // processes via the one thing they do share: the index DB. Same swallow-duplicate-column
  // pattern as v1 -> v2 above.
  2: (conn) => {
    try {
      conn.exec('ALTER TABLE files ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0')
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
    }
  },
}

// Walks a database from its stamped version up to (but not including) `toVersion`, applying each
// registered migration step in order. Does not itself touch PRAGMA user_version -- the caller
// stamps that once every step has run.
function runMigrations(conn: BetterSqlite3Database, fromVersion: number, toVersion: number): void {
  for (let v = fromVersion; v < toVersion; v++) {
    MIGRATIONS[v]?.(conn)
  }
}

/**
 * Apply pragmas + schema to a freshly opened connection.
 *
 * WAL journal mode allows a reader to proceed while a writer holds the file;
 * NORMAL synchronous trades a small durability window for far fewer fsyncs,
 * which matters on the hot hook path. FTS5 and the optional sqlite-vec table
 * are best-effort: a SQLite build lacking either still yields a working DB.
 */
function initConnection(conn: BetterSqlite3Database): void {
  const walMode = conn.pragma('journal_mode = WAL', { simple: true })
  if (String(walMode).toLowerCase() !== 'wal') {
    throw new Error(`db: failed to enable WAL mode (got: ${walMode})`)
  }
  conn.pragma('synchronous = NORMAL')
  // busy_timeout makes a writer wait for a held write lock instead of failing immediately with SQLITE_BUSY; token-goat runs multiple processes against one global.db (worker daemon draining the queue plus CLI hook invocations), so concurrent writers are normal and 15s absorbs contention spikes without hanging.
  conn.pragma('busy_timeout = 15000')

  // Custom Unicode-aware LOWER() replacement used by pathEqClause() (sql_path.ts) for
  // case-insensitive-filesystem path comparisons. SQLite's built-in LOWER() only folds
  // ASCII A-Z, which would silently diverge from foldPath()'s JS-side Unicode-aware
  // toLowerCase() for non-ASCII casing (e.g. `Ä` vs `ä`). Wrapping the exact same
  // foldCase() primitive here keeps SQL-side and JS-side folding byte-for-byte
  // consistent. Registered once per connection (not per-query) and marked deterministic
  // so SQLite can use it in query planning the same way it would a built-in function.
  conn.function('TG_LOWER', { deterministic: true }, (value: unknown) =>
    value === null ? null : foldCase(String(value)),
  )

  // A single cheap read on every open -- this runs on the hot path (every hook call, every CLI
  // invocation), so no schema work happens here beyond one PRAGMA read. Anything ABOVE
  // SCHEMA_VERSION means an older binary opened a database written by a newer one (a downgrade,
  // or two globally-installed versions pointed at the same project): refuse rather than risk an
  // old binary misinterpreting or corrupting a schema shape it doesn't understand.
  const storedVersion = Number(conn.pragma('user_version', { simple: true }))
  if (storedVersion > SCHEMA_VERSION) {
    throw new Error(
      `db: index schema version ${storedVersion} is newer than this token-goat build supports (expected ${SCHEMA_VERSION}). ` +
        `Update token-goat, or delete the stale index database and let it rebuild.`,
    )
  }

  conn.exec(SCHEMA_SQL)

  try {
    conn.exec(FTS_SQL)
  } catch {
    // FTS5 unavailable in this SQLite build — search falls back to LIKE in higher layers. The base tables are still usable.
  }

  // sqlite-vec is an optional dependency; the vec0 virtual table only exists when the package is installed and its extension can be loaded. Wrap the entire load+create so a missing package or load failure is non-fatal.
  try {
    // Dynamic require so a missing package does not break module resolution.
    const sqliteVec = _require('sqlite-vec') as { load: (db: BetterSqlite3Database) => void }
    sqliteVec.load(conn)
    conn.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
         embedding float[384]
       );`,
    )
  } catch {
    // sqlite-vec not installed or extension load failed — semantic search is disabled but every other index feature works.
  }

  // BELOW SCHEMA_VERSION covers two cases identically: a brand-new DB (storedVersion 0, tables
  // just created above) and an old DB from a pre-migration-mechanism release (also storedVersion
  // 0, since older code never stamped it, but already schema-shape-compatible with version 1 --
  // that constant IS today's schema). Both are stamped current with no real migration step to
  // run. A genuine future gap -- SCHEMA_VERSION bumped for a change `CREATE TABLE IF NOT EXISTS`
  // can't express, e.g. an ALTER TABLE on an existing table -- runs through MIGRATIONS above.
  if (storedVersion < SCHEMA_VERSION) {
    runMigrations(conn, storedVersion, SCHEMA_VERSION)
    conn.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
}

/**
 * Resolve a db path argument to an absolute path under the data directory.
 *
 * A bare filename (no directory separator) is placed in {@link dataDir}; an
 * already-absolute or explicitly-relative path is resolved as given so callers
 * can point at a temp file in tests.
 */
function resolveDbPath(dbPath: string): string {
  if (path.isAbsolute(dbPath)) return dbPath
  if (dbPath.includes('/') || dbPath.includes('\\')) return path.resolve(dbPath)
  return safeJoin(dataDir(), dbPath)
}

/**
 * Return the cached {@link BetterSqlite3Database} for `dbPath`, opening and
 * initializing it on first access.
 *
 * The connection is opened with the schema applied, WAL enabled, and the
 * optional FTS5 / sqlite-vec tables created when available. Subsequent calls
 * with the same resolved path return the same handle.
 */
export function getDb(dbPath: string): BetterSqlite3Database {
  const resolved = resolveDbPath(dbPath)
  // Fold only the cache key, not `resolved` itself -- the real-case path is still what
  // gets passed to fs/Database below, so the file is created/opened with whatever casing
  // the caller (or an existing file on disk) actually used.
  const key = foldPath(resolved)
  const existing = _connections.get(key)
  if (existing !== undefined) return existing

  // Ensure the parent directory exists before SQLite tries to create the file. Retry on Windows race conditions.
  const dir = path.dirname(resolved)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }

  const conn = new Database(resolved)
  try {
    initConnection(conn)
  } catch (e) {
    // A setup step (WAL pragma, schema exec, ...) failed after the handle was already
    // opened. Close it before propagating so the failure does not leak a file descriptor.
    try {
      conn.close()
    } catch {
      // Best-effort: the original setup error is what matters to the caller.
    }
    throw e
  }
  _connections.set(key, conn)
  return conn
}

/**
 * Close the cached connection for `dbPath` if one is open. No-op otherwise.
 */
export function closeDb(dbPath: string): void {
  const resolved = resolveDbPath(dbPath)
  const key = foldPath(resolved)
  const conn = _connections.get(key)
  if (conn === undefined) return
  try {
    conn.close()
  } catch {
    // Already closed or close raced with another caller — the handle is gone either way, so dropping it from the map is the only thing that matters.
  }
  _connections.delete(key)
}

/**
 * Close every open connection and clear the cache.
 *
 * Registered with {@link registerReset} so tests start from a clean slate, and
 * usable directly for process shutdown.
 */
export function closeAllDbs(): void {
  for (const conn of _connections.values()) {
    try {
      conn.close()
    } catch {
      // Best-effort: continue closing the rest even if one handle errors.
    }
  }
  _connections.clear()
}

registerReset(closeAllDbs)
