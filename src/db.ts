/**
 * SQLite connection management and index-DB schema.
 *
 * Ports the connection-pragma setup from `db.py` (WAL journal mode, NORMAL
 * synchronous) and the index schema (files / symbols / refs / FTS5) that later
 * layers query. Each database file gets one lazily-opened, cached connection.
 *
 * The connection itself comes from `./sqlite_driver.js`, a thin better-sqlite3-shaped facade over
 * Node's built-in `node:sqlite`; nothing in this file talks to `node:sqlite` directly.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import Database from './sqlite_driver.js'
import type { SqliteDatabase } from './sqlite_driver.js'

import { dataDir, SYMBOL_BODY_CHAR_CAP } from './constants.js'
import { isDotenvPath } from './dotenv_redact.js'
import { safeJoin } from './paths.js'
import { ensureDirSync, foldCase, foldPath, sleepSync } from './util.js'
import { registerReset } from './reset.js'

// ESM has no `require`; build one so we can probe for the optional sqlite-vec package without making it a hard module-resolution dependency.
const _require = createRequire(import.meta.url)

// One Database handle per absolute db path. Keyed by the resolved path so two callers naming the same file via different relative strings share a handle.
const _connections = new Map<string, SqliteDatabase>()

/**
 * Index-DB schema (matches the spec for Layer 2).
 *
 * Tables:
 *   - files   — one row per indexed source file.
 *   - symbols — extracted definitions (functions, classes, types, ...).
 *   - refs    — references/usages of names, for caller lookups.
 *   - chunks  — semantic search chunk metadata (filePath, startLine, endLine, text, kind).
 *   - notes   — file/symbol-attached architecture notes with a staleness fingerprint (notes.ts).
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
  docstring TEXT,
  parent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file_folded ON symbols(TG_LOWER(file_path));
-- Partial index backing checkSymbolBodySize (cli_doctor.ts), which every SessionStart hook runs.
-- Its predicate cannot be served by any index above, so the check had to read the whole symbols
-- table -- 226 MB / 231324 rows here, 229 ms per session start, and the early-exit LIMIT 1 never
-- fires on a healthy index because there is nothing to find. Indexing the *violating* rows only
-- makes the check a lookup into a b-tree that is empty on a healthy index: measured 229 ms -> 0.0
-- ms, 4 KB on disk, and no measurable insert cost (-0.2%, within noise, over 40000 real rows),
-- because SQLite evaluates the predicate and skips the b-tree write for every row under the cap.
-- SQLite uses a partial index only where the query's WHERE implies the index's, so the probe in
-- cli_doctor.ts spells its comparison the same way and against the same constant. That makes the
-- threshold part of the stored schema -- see SYMBOL_BODY_CHAR_CAP in constants.ts for what
-- changing it requires. A query with a lower threshold correctly gets a full scan instead, so no
-- other reader can be served stale rows by this index.
CREATE INDEX IF NOT EXISTS idx_symbols_oversized_body ON symbols(id) WHERE LENGTH(body) > ${SYMBOL_BODY_CHAR_CAP};

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

-- Tracks every project root a hook has ever seen an edit for, so the worker's periodic sweep
-- (sweepKnownRoots in index_prune.ts) knows which roots to auto-prune without scanning the
-- entire shared files table for distinct top-level directories on every cycle. Purely additive
-- (no SCHEMA_VERSION bump needed): last_seen_ms is refreshed on every observed edit,
-- first_missing_ms is set the first sweep that finds the root unreachable and cleared the
-- moment it's seen reachable again -- see sweepKnownRoots' grace-period logic.
CREATE TABLE IF NOT EXISTS known_roots (
  root TEXT PRIMARY KEY,
  last_seen_ms REAL NOT NULL,
  first_missing_ms REAL
);

-- Cross-cache full-text search index for 'token-goat recall' (recall_index.ts). One row
-- per bash-output/web-output/mcp-output blob-store entry (see disk_cache.ts), refreshed
-- in place (ON CONFLICT DO UPDATE) whenever storeBashOutput/storeWebOutput/storeMcpOutput
-- write that entry, so recall never needs a separate rebuild step. row_id is a plain
-- surrogate integer key -- entry_id is the real blob-store id (bash/mcp ids are hex,
-- web ids are the cache's own scheme) and is not unique on its own since bash-output and
-- mcp-output ids share one namespace (BASH_OUTPUT_SUBDIR) while web-output ids are a
-- separate namespace; cache_type disambiguates.
CREATE TABLE IF NOT EXISTS cache_recall (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_type TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  label TEXT,
  content TEXT,
  stored_at REAL,
  UNIQUE(cache_type, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_cache_recall_type ON cache_recall(cache_type);

-- Per-emission ledger for 'token-goat hint-stats' (hint_stats.ts). One row per hint
-- emission event (a hook returning a 'context' HookOutput classified as a discretionary
-- efficiency nudge, as opposed to a mandatory informational injection -- see hint_stats.ts's
-- doc comment for the exact category list and what is deliberately excluded). correlator is a
-- best-effort file-path/output-id substring extracted from the hint's own text, used to check
-- whether a later Bash tool call in the same session actually followed the hint's specific
-- pointer (see resolvePendingHintsForEvent) -- NULL when no such pointer could be extracted,
-- in which case the row is inserted already resolved with acted_on=0 (counted as emitted, never
-- eligible for auto-detected credit). calls_remaining is the countdown of subsequent tool-use
-- events still eligible to resolve this row before it is considered timed out.
CREATE TABLE IF NOT EXISTS hint_emissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  correlator TEXT,
  emitted_at REAL NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  acted_on INTEGER NOT NULL DEFAULT 0,
  calls_remaining INTEGER NOT NULL DEFAULT 0,
  bytes_emitted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hint_emissions_category ON hint_emissions(category);
CREATE INDEX IF NOT EXISTS idx_hint_emissions_session_pending ON hint_emissions(session_id, resolved);

-- Manual efficacy votes for a hint category (token-goat hint-stats --mark-effective/--mark-ineffective),
-- kept separate from hint_emissions' automatic acted_on signal so the two are never silently
-- blended -- see hint_stats.ts's doc comment on why some categories only support this manual signal.
CREATE TABLE IF NOT EXISTS hint_manual_marks (
  category TEXT PRIMARY KEY,
  effective_count INTEGER NOT NULL DEFAULT 0,
  ineffective_count INTEGER NOT NULL DEFAULT 0
);

-- Durable counter backing hint_stats.ts's backoff-threshold probe-recovery schedule: how many
-- CONSECUTIVE suppressed occasions have elapsed for (category, harness) since a hint in this
-- category was last actually shown (either organically, because shouldSuppress no longer holds,
-- or via a prior probe). shouldSuppress itself stays a pure function of hint_emissions -- this
-- table exists only because a suppressed occasion is deliberately never written to
-- hint_emissions (see that table's own comment), so without a separate durable counter here
-- there would be no way to know "how many suppressed occasions have we seen" across the
-- short-lived hook CLI processes that call applyHintTracking. Keyed by (category, harness), not
-- category alone, to match shouldSuppress/categoryStats' own per-harness scoping -- unlike
-- hint_manual_marks (a human-entered vote, deliberately not harness-split).
CREATE TABLE IF NOT EXISTS hint_suppression_probes (
  category TEXT NOT NULL,
  harness TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, harness)
);

-- Free-text architecture/rationale notes (the "why" layer -- see notes.ts), attached either to
-- a whole file (symbol = '') or to one specific indexed symbol within it (symbol = that
-- symbol's name). '' rather than NULL for the whole-file case because SQLite's UNIQUE treats
-- NULLs as pairwise-distinct (never conflicting with each other), which would let note-add
-- accumulate unlimited duplicate whole-file notes for the same file instead of upserting one;
-- '' is a real, comparable value so UNIQUE(file_path, symbol) enforces "at most one note per
-- attachment point" for both cases identically. 'fingerprint' is a SHA-256 digest (see
-- fingerprintContent in fingerprint.ts) captured at write time of exactly what the note
-- describes -- the resolved symbol's current body text for a symbol-scoped note, or a stable
-- digest of the file's current top-level symbol manifest (name:kind:line-range per symbol,
-- sorted) for a file-scoped note -- so 'token-goat note-list --stale-only' can recompute the
-- same fingerprint against the live index later and flag a mismatch (see notes.ts's
-- isNoteStale). Staleness detection is purely advisory: nothing here ever auto-rewrites or
-- deletes a note's content, only flags that the code it describes has moved since it was
-- written -- a human/agent re-review decides what to do with a stale note.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(file_path, symbol)
);
CREATE INDEX IF NOT EXISTS idx_notes_file_folded ON notes(TG_LOWER(file_path));

-- Baseline for skill_version_drift.ts's one-shot nudge: the token-goat CLI version (and its
-- flat command-name set, JSON-encoded) active the moment the token-goat skill's body was
-- last (re)loaded into this session -- see hooks_skill.ts's postSkillHandler. A session that
-- keeps running after the CLI is upgraded has no other way to learn that new surgical-read
-- commands now exist (the skill only re-announces itself on an explicit reload), so
-- checkSkillVersionDrift compares this snapshot against the live command set on each user turn
-- and fires the nudge exactly once (notified_at) per (re)load. session_id is the primary key
-- because only one skill (token-goat) is ever tracked here.
CREATE TABLE IF NOT EXISTS skill_version_snapshots (
  session_id TEXT PRIMARY KEY,
  skill_name TEXT NOT NULL,
  loaded_version TEXT NOT NULL,
  loaded_commands_json TEXT NOT NULL,
  notified_at REAL
);

-- Which embedding stack produced the vectors currently in chunk_vectors -- the model, its
-- pinned revision, and the inference runtime (see embeddingProvenance in embeddings.ts). The
-- vector table itself is vec0(rowid, embedding) and has nowhere to record this, so without
-- this row a database that was embedded by one stack and then added to by another holds two
-- incomparable sets of vectors under one index, with nothing able to tell them apart. That is
-- not hypothetical: global.db is machine-wide across every project on the machine (see
-- constants.ts), so upgrading the runtime, or changing the model or its pinned revision, mixes
-- old and new vectors for as long as the old files go untouched. Measured drift between two
-- runtime versions of the same quantized model is 0.9925-0.9978 cosine on the final vector --
-- small, but enough to reorder near-ties, and invisible to every existing check.
--
-- Single-row by construction (the CHECK pins the key), because there is exactly one vector
-- table per database. An EMPTY table on a database that already holds chunks means the vectors
-- predate this stamp and their provenance is unknowable -- see ensureEmbeddingProvenance, which
-- treats that exactly like a mismatch. That is what makes this work without a migration step.
CREATE TABLE IF NOT EXISTS embedding_provenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provenance TEXT NOT NULL
);
`

// FTS5 is a compile-time-optional SQLite extension. Node's bundled SQLite ships with it enabled, but wrap creation so a build without FTS5 still yields a usable (search-degraded) index DB rather than throwing on open.
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

-- Content-linked FTS5 mirror of cache_recall (recall_index.ts), same shape as symbols_fts
-- above. An INSERT ... ON CONFLICT DO UPDATE against cache_recall fires the AFTER UPDATE
-- trigger (not AFTER INSERT) on the conflicting row, same as any other SQLite upsert, so the
-- delete+reinsert pattern below keeps the fts index correct on a re-indexed (overwritten)
-- entry, not just a brand-new one.
CREATE VIRTUAL TABLE IF NOT EXISTS cache_recall_fts USING fts5(
  label,
  content,
  content='cache_recall',
  content_rowid='row_id'
);
CREATE TRIGGER IF NOT EXISTS cache_recall_ai AFTER INSERT ON cache_recall BEGIN
  INSERT INTO cache_recall_fts(rowid, label, content)
  VALUES (new.row_id, new.label, new.content);
END;
CREATE TRIGGER IF NOT EXISTS cache_recall_ad AFTER DELETE ON cache_recall BEGIN
  INSERT INTO cache_recall_fts(cache_recall_fts, rowid, label, content)
  VALUES ('delete', old.row_id, old.label, old.content);
END;
CREATE TRIGGER IF NOT EXISTS cache_recall_au AFTER UPDATE ON cache_recall BEGIN
  INSERT INTO cache_recall_fts(cache_recall_fts, rowid, label, content)
  VALUES ('delete', old.row_id, old.label, old.content);
  INSERT INTO cache_recall_fts(rowid, label, content)
  VALUES (new.row_id, new.label, new.content);
END;
`

// Bump this the day SCHEMA_SQL changes in a way `CREATE TABLE IF NOT EXISTS` can't express on an already-populated table -- a column add/rename/drop, a type change, a data backfill -- and add the matching step to MIGRATIONS below. It represents the schema as it exists today. v3 -> v4: added cache_recall / cache_recall_fts (token-goat recall). Purely additive -- `CREATE TABLE/VIRTUAL TABLE IF NOT EXISTS` in SCHEMA_SQL/FTS_SQL already handles a pre-existing v3 database, so no MIGRATIONS[3] step is needed (same reasoning as the comment on MIGRATIONS below for a bump with no registered step). v4 -> v5: added hint_emissions / hint_manual_marks (token-goat hint-stats). Purely additive -- `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL already handles a pre-existing v4 database, so no MIGRATIONS[4] step is needed (same reasoning as v3 -> v4 above). v5 -> v6: added hint_suppression_probes (backoff-threshold probe-recovery counter for hint_stats.ts). Purely additive -- `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL already handles a pre-existing v5 database, so no MIGRATIONS[5] step is needed (same reasoning as v4 -> v5 above). v6 -> v7: added skill_version_snapshots (skill_version_drift.ts's one-shot "token-goat was upgraded since you loaded this skill" nudge). Purely additive -- `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL already handles a pre-existing v6 database, so no MIGRATIONS[6] step is needed (same reasoning as v5 -> v6 above). v7 -> v8: added notes (token-goat note-add/note-get/note-list -- file/symbol-attached architecture notes with a staleness fingerprint, see notes.ts). Purely additive -- `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL already handles a pre-existing v7 database, so no MIGRATIONS[7] step is needed (same reasoning as v6 -> v7 above). v8 -> v9: added symbols.parent, separating the "parent container name" the regex adapters used to overload into symbols.docstring from the symbol's real doc comment (see precedingDocComment in parser.ts and makeLineSymbol/makeSpanSymbol/makeSymbolEmitter in languages/common.ts). A pre-existing v8 database's `symbols` table predates the column, so it needs an explicit ALTER TABLE in MIGRATIONS -- not purely additive like v3 -> v8 above. v9 -> v10: added hint_emissions.bytes_emitted, the per-emission spend (byte length of the hint text actually injected into context) recorded alongside the pre-existing bytes-saved figures already tracked in the `stats` table, so `token-goat hint-stats` can answer "are hints net-positive" instead of only measuring their benefit (see applyHintTracking/logHintEmission in hint_stats.ts). Left nullable with no default rather than defaulted to 0, so a pre-existing v9 database's rows -- which predate spend tracking entirely -- read as genuinely unknown spend, not a fake measured zero. A pre-existing v9 database's `hint_emissions` table predates the column, so it needs an explicit ALTER TABLE in MIGRATIONS -- not purely additive like v3 -> v8 above. v11 -> v12: added embedding_provenance (which embedding stack produced the stored vectors, see the table's own comment and ensureEmbeddingProvenance in embeddings.ts). Purely additive -- `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL already handles a pre-existing v11 database, so no MIGRATIONS[11] step is needed. Deliberately no migration step even though existing vectors ARE invalidated by this change: a migration would have to run the invalidation on every database at open time, including ones whose embedding stack is absent and which therefore have nothing to re-embed with. The check belongs where embedding actually happens, and an empty provenance table on a populated index is the signal it keys on.
export const SCHEMA_VERSION = 12 as const

type Migration = (conn: SqliteDatabase) => void

/** Runs `sql` (expected to be an idempotent-in-intent `ALTER TABLE ... ADD COLUMN`), swallowing exactly a "duplicate column" failure -- the column already existing on a fresh database whose CREATE TABLE already includes it -- and rethrowing anything else, so a genuine ALTER TABLE failure is never silently lost. */
function alterTableIdempotent(conn: SqliteDatabase, sql: string): void {
  try {
    conn.exec(sql)
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
  }
}

/**
 * Delete every chunk (and matching vector) belonging to a dotenv file, and clear those files'
 * `embed_sha` so they are re-embedded through the redacting path.
 *
 * Paths are filtered in JS with the same {@link isDotenvPath} predicate the redaction uses, rather
 * than with a `LIKE '%.env%'` pattern, so this covers exactly the file set the fix covers and
 * cannot drift from it. `chunk_vectors` is the optional sqlite-vec virtual table: on a build
 * without the native extension the statement throws at prepare time, which is not a reason to fail
 * the migration -- the chunk rows carrying the secret text are deleted either way, and a vector
 * with no chunk row is unreadable (searchSemantic joins them by rowid).
 */
function purgeDotenvEmbeddings(conn: SqliteDatabase): void {
  let paths: string[]
  try {
    paths = (conn.prepare('SELECT DISTINCT file_path FROM chunks').all() as { file_path: string }[])
      .map((r) => r.file_path)
      .filter(isDotenvPath)
  } catch {
    // No `chunks` table yet (a database created before embeddings existed): nothing to purge.
    return
  }
  if (paths.length === 0) return

  for (const p of paths) {
    try {
      conn.prepare('DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)').run(p)
    } catch {
      // sqlite-vec not loaded on this build; the chunk rows below are still removed.
    }
    conn.prepare('DELETE FROM chunks WHERE file_path = ?').run(p)
    try {
      conn.prepare('UPDATE files SET embed_sha = NULL WHERE path = ?').run(p)
    } catch {
      // Older shape without the column; the v1 -> v2 step adds it, and a file with no embed_sha is
      // never treated as fresh anyway.
    }
  }
}

// Keyed by the FROM version: MIGRATIONS[1] upgrades a v1 database to v2, MIGRATIONS[2] upgrades v2 to v3, and so on. A version with no registered step is a no-op, which also covers a SCHEMA_VERSION bump for a purely additive change already handled by `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL (no ALTER TABLE needed).
const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: adds files.embed_sha, tracked separately from files.sha so embedding freshness can be gated independently of parse freshness (see makeIndexer in worker.ts). A pre-existing v1 database's `files` table predates the column, so it needs an explicit ALTER TABLE here; a brand-new database already has the column from SCHEMA_SQL's CREATE TABLE above, so the ALTER TABLE would fail with "duplicate column name" there -- swallow exactly that error and rethrow anything else, so a genuine ALTER TABLE failure is never silently lost.
  1: (conn) => alterTableIdempotent(conn, 'ALTER TABLE files ADD COLUMN embed_sha TEXT'),
  // v2 -> v3: adds files.retry_count, a durable per-path counter for consecutive transient-read-failure requeues (see MAX_TRANSIENT_RETRIES / requeueDirtyPath / clearRetryCount in worker.ts). Previously this counter lived only in an in-memory Map inside worker.ts, which meant the retry-count reset -- run at the time in the short-lived hook CLI process -- could never actually reach the long-lived detached daemon process's own copy of that Map: they are different Node processes with no shared memory, so the reset was a silent no-op in the real deployed topology. Persisting the counter in `files` makes it visible to both processes via the one thing they do share: the index DB. Same swallow-duplicate-column pattern as v1 -> v2 above.
  2: (conn) => alterTableIdempotent(conn, 'ALTER TABLE files ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0'),
  // v8 -> v9: adds symbols.parent (see SCHEMA_VERSION comment above for why). A pre-existing v8 database's `symbols` table predates the column, so it needs an explicit ALTER TABLE here; a brand-new database already has the column from SCHEMA_SQL's CREATE TABLE above, so the ALTER TABLE would fail with "duplicate column name" there -- swallow exactly that error and rethrow anything else, same pattern as v1 -> v2 / v2 -> v3 above.
  8: (conn) => alterTableIdempotent(conn, "ALTER TABLE symbols ADD COLUMN parent TEXT NOT NULL DEFAULT ''"),
  // v9 -> v10: adds hint_emissions.bytes_emitted (see SCHEMA_VERSION comment above for why). A pre-existing v9 database's `hint_emissions` table predates the column, so it needs an explicit ALTER TABLE here; a brand-new database already has the column from SCHEMA_SQL's CREATE TABLE above, so the ALTER TABLE would fail with "duplicate column name" there -- swallow exactly that error and rethrow anything else, same pattern as v1 -> v2 / v2 -> v3 / v8 -> v9 above.
  9: (conn) => alterTableIdempotent(conn, 'ALTER TABLE hint_emissions ADD COLUMN bytes_emitted INTEGER'),
  // v10 -> v11: purge chunks (and their vectors) for dotenv files. Until this version, a tracked
  // `.env` was chunked and embedded verbatim on the git path, so `semantic` returned its values --
  // see dotenv_redact.ts. Redacting from now on is not enough on its own: the embed-freshness gate
  // (isEmbedFresh in parser.ts) skips a file whose bytes have not changed, so an already-indexed
  // .env would have kept serving its pre-fix chunks indefinitely. Deleting the rows here both
  // removes the stored secrets and, by clearing embed_sha, makes the next drain re-embed the file
  // through the redacting path.
  10: purgeDotenvEmbeddings,
}

// Walks a database from its stamped version up to (but not including) `toVersion`, applying each registered migration step in order. Does not itself touch PRAGMA user_version -- the caller stamps that once every step has run.
function runMigrations(conn: SqliteDatabase, fromVersion: number, toVersion: number): void {
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
/** How long {@link enableWalWithRetry} keeps trying before giving up, matched to `busy_timeout`. */
const WAL_SWITCH_DEADLINE_MS = 15_000

/**
 * Put a connection into WAL mode, waiting out other processes rather than failing on the first
 * refusal.
 *
 * Converting a database's journal mode needs exclusive access, and SQLite answers `SQLITE_BUSY`
 * for that conversion **without consulting the busy handler** -- the wait `busy_timeout` configures
 * applies to ordinary lock contention, not to this. So on a database that does not exist yet, where
 * every process racing to create it runs this conversion, `busy_timeout` cannot help and the losers
 * throw immediately. Reproduced with six processes indexing one new database under load: one threw
 * `database is locked` from this very pragma and dropped the file it was indexing, while the run
 * still exited 0. That is the same silent-file-loss the deferred-`BEGIN` fix in `writeParseResult`
 * removed, arriving by a second and entirely separate route -- which is why the comment that used
 * to sit here, saying moving `busy_timeout` first was mere hardening because it "did not change
 * it", was reporting a real remaining failure as a non-event.
 *
 * A process that loses the race has nothing to fix and nothing to report: whoever won is doing the
 * conversion it wanted done. So each attempt re-reads the mode, and finding `wal` is success no
 * matter who set it. Only a deadline passing with the database still not in WAL is an error, and it
 * carries the last refusal so a genuine permission or filesystem problem is not reported as
 * contention.
 *
 * `budgetMs` exists so the giving-up branch can be reached in a test without spending the real
 * fifteen seconds to get there. Production callers pass nothing and get that full budget.
 */
export function enableWalWithRetry(conn: Pick<SqliteDatabase, 'pragma'>, budgetMs: number = WAL_SWITCH_DEADLINE_MS): void {
  const deadline = Date.now() + budgetMs
  let lastError: unknown
  for (;;) {
    try {
      const mode = conn.pragma('journal_mode = WAL', { simple: true })
      if (String(mode).toLowerCase() === 'wal') return
      lastError = new Error(`got: ${String(mode)}`)
    } catch (e) {
      lastError = e
    }
    // Another process may already have finished the conversion while this one was being refused,
    // in which case there is nothing left to do and no reason to keep waiting.
    try {
      if (String(conn.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') return
    } catch {
      // Reading the mode can fail for the same contention reason; fall through and retry.
    }
    if (Date.now() >= deadline) {
      throw new Error(`db: failed to enable WAL mode (${lastError instanceof Error ? lastError.message : String(lastError)})`)
    }
    sleepSync(25)
  }
}

function initConnection(conn: SqliteDatabase): void {
  // busy_timeout makes a writer wait for a held write lock instead of failing immediately with SQLITE_BUSY; token-goat runs multiple processes against one global.db (worker daemon draining the queue plus CLI hook invocations), so concurrent writers are normal and 15s absorbs contention spikes without hanging.
  // Set FIRST, before any statement that can contend, rather than after the two pragmas below as it
  // used to be. The switch to WAL and the schema creation that follows it both need an exclusive
  // lock, and on a database that does not exist yet every process racing to create it runs both --
  // with the timeout armed only afterwards, those two steps ran with SQLite's default of no wait at
  // all. This is hardening rather than a fix for a reproduced failure: the concurrent-index failure
  // that prompted the look was a deferred-BEGIN upgrade elsewhere (see writeParseResult in
  // parser.ts), and moving this line did not change it.
  conn.pragma('busy_timeout = 15000')
  enableWalWithRetry(conn)
  conn.pragma('synchronous = NORMAL')

  // Custom Unicode-aware LOWER() replacement used by pathEqClause() (sql_path.ts) for case-insensitive-filesystem path comparisons. SQLite's built-in LOWER() only folds ASCII A-Z, which would silently diverge from foldPath()'s JS-side Unicode-aware toLowerCase() for non-ASCII casing (e.g. `Ä` vs `ä`). Wrapping the exact same foldCase() primitive here keeps SQL-side and JS-side folding byte-for-byte consistent. Registered once per connection (not per-query) and marked deterministic so SQLite can use it in query planning the same way it would a built-in function.
  conn.function('TG_LOWER', { deterministic: true }, (value: unknown) =>
    value === null ? null : foldCase(String(value)),
  )

  // A single cheap read on every open -- this runs on the hot path (every hook call, every CLI invocation), so no schema work happens here beyond one PRAGMA read. Anything ABOVE SCHEMA_VERSION means an older binary opened a database written by a newer one (a downgrade, or two globally-installed versions pointed at the same project): refuse rather than risk an old binary misinterpreting or corrupting a schema shape it doesn't understand.
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
    const sqliteVec = _require('sqlite-vec') as { load: (db: SqliteDatabase) => void }
    sqliteVec.load(conn)
    conn.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
         embedding float[384]
       );`,
    )
  } catch {
    // sqlite-vec not installed or extension load failed — semantic search is disabled but every other index feature works.
  }

  // BELOW SCHEMA_VERSION covers two cases identically: a brand-new DB (storedVersion 0, tables just created above) and an old DB from a pre-migration-mechanism release (also storedVersion 0, since older code never stamped it, but already schema-shape-compatible with version 1 -- that constant IS today's schema). Both are stamped current with no real migration step to run. A genuine future gap -- SCHEMA_VERSION bumped for a change `CREATE TABLE IF NOT EXISTS` can't express, e.g. an ALTER TABLE on an existing table -- runs through MIGRATIONS above.
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

/** Resolves `dbPath` and derives its connection-cache key in one step -- shared by getDb and closeDb, which both need the same resolved-path-then-fold sequence to address the same cached handle. */
function connectionKey(dbPath: string): { resolved: string; key: string } {
  const resolved = resolveDbPath(dbPath)
  return { resolved, key: foldPath(resolved) }
}

/**
 * Return the cached {@link SqliteDatabase} for `dbPath`, opening and
 * initializing it on first access.
 *
 * The connection is opened with the schema applied, WAL enabled, and the
 * optional FTS5 / sqlite-vec tables created when available. Subsequent calls
 * with the same resolved path return the same handle.
 */
export function getDb(dbPath: string): SqliteDatabase {
  // Fold only the cache key, not `resolved` itself -- the real-case path is still what gets passed to fs/Database below, so the file is created/opened with whatever casing the caller (or an existing file on disk) actually used.
  const { resolved, key } = connectionKey(dbPath)
  const existing = _connections.get(key)
  if (existing !== undefined) return existing

  // Ensure the parent directory exists before SQLite tries to create the file. Retry on Windows race conditions.
  const dir = path.dirname(resolved)
  try {
    ensureDirSync(dir)
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
  const { key } = connectionKey(dbPath)
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
