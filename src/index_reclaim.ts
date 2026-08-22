/**
 * Index-space reclamation (`token-goat reclaim-index`).
 *
 * Recovery path for an index DB that has grown far past a healthy size. Size
 * is not only a disk concern: every write transaction against `global.db`
 * scales with it, and once a write outlasts db.ts's 15s `busy_timeout` the
 * failure surfaces to the user as an unexplained "database is locked" and as
 * multi-second stalls during `token-goat index`. Historically that happened
 * because {@link extractJsonSymbols} stored each minified-JSON key's whole
 * source line — i.e. the whole file — as its `symbols.body`, growing the index
 * quadratically in file size (see MAX_SYMBOL_BODY_CHARS in parser.ts).
 *
 * Two levels, because they address different halves of the problem:
 *
 * - Default: checkpoint the WAL and `VACUUM`. Reclaims pages already freed by
 *   deletes. Cheap, non-destructive, but recovers nothing from rows that are
 *   still present and still oversized.
 * - `--rebuild`: additionally drop every parsed row (files/symbols/refs/chunks
 *   and their vector + FTS mirrors) before vacuuming, so the next index run
 *   re-derives them under current parser rules. This is what actually shrinks
 *   an index bloated by a since-fixed extractor bug, since the offending rows
 *   are re-parsed rather than merely compacted. It is non-destructive in the
 *   sense that matters: everything dropped is derived data, recomputable from
 *   the source tree. User-authored state (notes, stats, hint history, recall
 *   cache) is deliberately left untouched.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDb } from './db.js'
import { globalDbPath } from './constants.js'
import { isWorkerRunning } from './worker.js'

/** Outcome of a {@link reclaimIndex} run. */
export interface ReclaimResult {
  /** Size of the DB plus its WAL before the run, in bytes. */
  beforeBytes: number
  /** Size of the DB plus its WAL after the run, in bytes. */
  afterBytes: number
  /** Rows dropped, per table. Empty unless `rebuild` was requested. */
  dropped: Record<string, number>
  /** Whether derived rows were dropped (vs. a vacuum-only run). */
  rebuilt: boolean
  /** True when SQLite declined to truncate the WAL because a reader held it. */
  checkpointBusy: boolean
  /**
   * True when VACUUM could not acquire its exclusive lock and was skipped.
   *
   * Reported rather than thrown, because by the time VACUUM runs the `--rebuild` deletes have
   * already committed: throwing here would abandon a half-finished recovery behind a stack
   * trace, when in fact the expensive and irreversible part succeeded and only the (freely
   * repeatable) space-reclaim step is outstanding. Re-running `reclaim-index` later completes it.
   */
  vacuumDeferred: boolean
}

/** Derived-row tables cleared by a `--rebuild`, in an order that respects reads between them. */
const DERIVED_TABLES = ['chunk_vectors', 'chunks', 'refs', 'symbols', 'files'] as const

/** Bytes on disk for the DB and its sidecar WAL (the WAL can itself be tens of MB). */
function indexSizeBytes(dbPath: string): number {
  let total = 0
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      total += fs.statSync(p).size
    } catch {
      // Missing WAL (or missing DB on a first run) simply contributes nothing.
    }
  }
  return total
}

/** True when `table` exists in this DB. `chunk_vectors` is absent on installs without sqlite-vec. */
function tableExists(db: ReturnType<typeof getDb>, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(table) as { present?: number } | undefined
  return row?.present === 1
}

/**
 * Reclaim space in the index DB, optionally rebuilding derived rows first.
 *
 * Returns before/after sizes so the caller can report what was actually
 * recovered rather than asserting success blindly.
 */
export function reclaimIndex(dbPath: string, opts: { rebuild?: boolean } = {}): ReclaimResult {
  const rebuild = opts.rebuild === true
  const beforeBytes = indexSizeBytes(dbPath)
  const db = getDb(dbPath)
  const dropped: Record<string, number> = {}

  if (rebuild) {
    // One transaction so a failure partway through cannot leave `files` rows claiming a
    // freshness SHA for symbols that were already deleted -- that combination would make the
    // next index run's SHA gate skip the very files whose symbols are gone, silently leaving
    // them unsearchable until each one happens to be edited.
    db.transaction(() => {
      for (const table of DERIVED_TABLES) {
        if (!tableExists(db, table)) continue
        const before = (db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c
        db.prepare(`DELETE FROM "${table}"`).run()
        dropped[table] = before
      }
    }).immediate()
    // `.immediate()` -- BEGIN IMMEDIATE. better-sqlite3 issues a plain call as a deferred BEGIN,
    // which takes a read snapshot first and only asks for the write lock at the first writing
    // statement. SQLite refuses that upgrade with SQLITE_BUSY straight away instead of consulting
    // the busy handler, so `busy_timeout` does nothing for it. This transaction is the worst
    // instance of that shape in the codebase, because it opens with an explicit
    // `SELECT count(*)`: the stale snapshot is taken deliberately, one statement before the
    // first DELETE. Measured against a held write lock, the deferred form failed in 176 ms with
    // "database is locked" while a 15 s busy_timeout was armed, and the immediate form waited
    // and succeeded. The comment further down this file already calls this "the operation most
    // likely to lose a 15s busy_timeout race against an active writer" -- it was losing it
    // without ever entering the race. See writeParseResult in parser.ts.
    // The symbols_fts mirror is content-linked to `symbols` and maintained by AFTER DELETE
    // triggers, so the delete above already removed its entries. Rebuild its internal b-tree
    // anyway: FTS5 leaves tombstones behind on delete, and this is the one moment where
    // compacting them costs nothing extra because a VACUUM follows immediately.
    if (tableExists(db, 'symbols_fts')) {
      try {
        db.prepare(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`).run()
      } catch {
        // A build without FTS5, or an fts table in an unexpected state: the vacuum below is
        // still worth doing, and search degrades rather than failing the whole reclaim.
      }
    }
  }

  // Fold the WAL back into the main DB first. VACUUM rewrites the main file only, so an
  // unchecked WAL (88 MB, in the case that motivated this command) would otherwise survive the
  // vacuum and understate the reclaim. wal_checkpoint returns a busy indicator instead of
  // throwing when a reader blocks truncation, so read it rather than assuming success.
  const checkpointBusy = walCheckpointBusy(db)
  // VACUUM cannot run inside a transaction, hence its position outside the block above.
  const vacuumDeferred = !vacuumOrDefer(db)
  const finalCheckpointBusy = walCheckpointBusy(db)

  return {
    beforeBytes,
    afterBytes: indexSizeBytes(dbPath),
    dropped,
    rebuilt: rebuild,
    checkpointBusy: checkpointBusy || finalCheckpointBusy,
    vacuumDeferred,
  }
}

/**
 * Run VACUUM, returning whether it succeeded rather than throwing on lock contention.
 *
 * Deliberately a single attempt. SQLite's own `busy_timeout` (set on the shared connection)
 * already retries internally for its full window, so an extra retry loop here would not add
 * patience -- it would multiply an already-long wait by the attempt count while the user stares
 * at a hung command. What is actually missing is the honest outcome: VACUUM runs *after* the
 * `--rebuild` deletes have committed, so throwing would abandon a successful, irreversible
 * recovery behind a stack trace over its freely-repeatable final step. Only lock contention is
 * absorbed; any other SQLite error is a real fault and rethrows.
 */
function vacuumOrDefer(db: ReturnType<typeof getDb>): boolean {
  try {
    db.exec('VACUUM')
    return true
  } catch (err) {
    const code = (err as { code?: string }).code ?? ''
    // Match both families by prefix. Matching SQLITE_BUSY loosely but SQLITE_LOCKED exactly would
    // swallow SQLITE_BUSY_SNAPSHOT while rethrowing SQLITE_LOCKED_SHAREDCACHE -- an accidental
    // asymmetry, since both extended codes mean the same thing here: someone else holds the lock.
    if (!code.startsWith('SQLITE_BUSY') && !code.startsWith('SQLITE_LOCKED')) throw err
    return false
  }
}

/**
 * Run a truncating WAL checkpoint, reporting whether SQLite declined it.
 *
 * `pragma wal_checkpoint(TRUNCATE)` yields `busy = 1` (not an exception) when a concurrent
 * reader prevents truncation. Swallowing that would let the command report a reclaim that
 * silently left the WAL in place.
 */
function walCheckpointBusy(db: ReturnType<typeof getDb>): boolean {
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }>
  return rows[0]?.busy === 1
}

/** Format a byte count as MB with one decimal, for human-readable reporting. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** CLI entry point for `token-goat reclaim-index`. */
export function cmdReclaimIndex(opts: {
  rebuild?: boolean
  dbPath?: string
  json?: boolean
  force?: boolean
}): void {
  const dbPath = opts.dbPath ?? globalDbPath()

  // Refuse to run against a DB a live worker daemon is writing to. Nothing here corrupts data
  // under concurrency -- SQLite's own locking holds -- but the reported outcome becomes false:
  // the worker can repopulate rows in the window between the delete transaction committing and
  // VACUUM running, so the command would claim to have dropped derived rows and reclaimed space
  // while a rebuild is already underway underneath it. VACUUM also needs an exclusive lock and
  // is the operation most likely to lose a 15s busy_timeout race against an active writer.
  // --force exists because the pid file can outlive a killed daemon.
  if (opts.force !== true && isWorkerRunning(path.dirname(dbPath))) {
    throw new Error(
      'reclaim-index: the worker daemon is running and writing to this index. ' +
        "Stop it first with 'token-goat worker stop', then re-run. " +
        'Pass --force to proceed anyway (results may be inaccurate if the worker is really live).',
    )
  }

  const result = reclaimIndex(dbPath, { rebuild: opts.rebuild === true })

  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ dbPath, ...result }, null, 2) + '\n')
    return
  }

  const freed = result.beforeBytes - result.afterBytes
  process.stdout.write(`reclaim-index: ${dbPath}\n`)
  process.stdout.write(
    `  ${mb(result.beforeBytes)} -> ${mb(result.afterBytes)} (freed ${mb(freed)})\n`,
  )
  if (result.rebuilt) {
    for (const [table, n] of Object.entries(result.dropped)) {
      process.stdout.write(`  dropped ${n} row(s) from ${table}\n`)
    }
    // Say this explicitly: after a rebuild the index is intentionally empty, and a user who
    // runs a `symbol`/`read` query before reindexing would otherwise read the empty result as
    // the reclaim having destroyed something.
    process.stdout.write(
      `  derived rows dropped -- run 'token-goat index' in each project to rebuild them\n`,
    )
  }
  if (result.vacuumDeferred) {
    // Not a failure of the run: the deletes committed, only the page-reclaim is outstanding.
    // Naming the follow-up command matters, because the on-disk size will not have moved and
    // that otherwise reads as "the command did nothing".
    process.stdout.write(
      `  note: VACUUM could not get an exclusive lock and was skipped, so on-disk size may be ` +
        `unchanged. The index itself was reclaimed; re-run 'token-goat reclaim-index' once ` +
        `nothing else is using the database to release the freed pages\n`,
    )
  }
  if (result.checkpointBusy) {
    process.stdout.write(
      `  note: a concurrent reader blocked WAL truncation, so some space may still be held in ${path.basename(dbPath)}-wal\n`,
    )
  }
}
