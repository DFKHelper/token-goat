import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir, globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { deleteFileEmbeddings } from './embeddings.js'
import { deleteFileRows } from './parser.js'
import { findProject } from './project.js'
import { foldPath } from './util.js'

type DbHandle = ReturnType<typeof getDb>

// Remove every indexed row (symbols, refs, files) and embedding chunk for one file. Shared primitive the full reindex prune and any future vanished-file reconciliation both build on.
// Wrapped in a single transaction (mirroring upsertChunks' pattern in embeddings.ts) so a crash
// or thrown error between the two deletes can never leave orphaned chunks/chunk_vectors rows for
// a files row that no longer exists -- nothing else ever cleans those up, since
// pruneDeletedFiles only iterates `SELECT DISTINCT path FROM files`, which the first delete
// alone (without the second) would already have removed the file from.
export function removeFileFromIndex(db: DbHandle, filePath: string): void {
  const tx = db.transaction(() => {
    deleteFileRows(db, filePath)
    deleteFileEmbeddings(db, filePath)
  })
  tx()
}

// A drive root (`c:/`) or empty prefix would scope the prune to an entire drive across every project in the shared global DB; refuse it so a malformed root can never mass-delete another project's rows.
function isTooShallowToPrune(rootPrefix: string): boolean {
  const segments = rootPrefix.split('/').filter((s) => s.length > 0 && !/^[a-z]:$/i.test(s))
  return segments.length === 0
}

function foldedBounds(rootPrefix: string): { foldedRootPrefix: string; foldedPrefix: string } {
  const prefix = rootPrefix.endsWith('/') ? rootPrefix : `${rootPrefix}/`
  return { foldedRootPrefix: foldPath(rootPrefix), foldedPrefix: foldPath(prefix) }
}

// Scan indexed files under rootPrefix and return the absolute paths whose file no longer exists
// on disk, WITHOUT deleting anything. Shared by pruneDeletedFiles (which deletes them
// immediately) and sweepKnownRoots' anomaly-ratio guard, which needs the count of what *would*
// be deleted before committing to the mutating delete.
function findDeletablePaths(rootPrefix: string, dbPath: string): string[] {
  const { foldedRootPrefix, foldedPrefix } = foldedBounds(rootPrefix)
  const db = getDb(dbPath)
  const rows = db.prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>
  const deletable: string[] = []
  for (const { path: p } of rows) {
    const foldedP = foldPath(p)
    if (foldedP !== foldedRootPrefix && !foldedP.startsWith(foldedPrefix)) continue
    let stillExists: boolean
    try {
      stillExists = fs.statSync(p, { throwIfNoEntry: false }) !== undefined
    } catch {
      // Stat failed for a reason other than "file is gone" (EPERM, EBUSY, an
      // antivirus/search-indexer holding a transient lock, etc.). We can't
      // confirm the file was actually deleted, so don't treat it as deletable
      // this pass -- it will be re-evaluated the next time pruning runs.
      continue
    }
    if (!stillExists) deletable.push(p)
  }
  return deletable
}

/** Count indexed file rows under rootPrefix, folded the same way findDeletablePaths matches them. Used by sweepKnownRoots to size its anomaly-ratio guard. */
export function countFilesUnderRoot(rootPrefix: string, dbPath: string = globalDbPath()): number {
  const { foldedRootPrefix, foldedPrefix } = foldedBounds(rootPrefix)
  const db = getDb(dbPath)
  const rows = db.prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>
  let count = 0
  for (const { path: p } of rows) {
    const foldedP = foldPath(p)
    if (foldedP === foldedRootPrefix || foldedP.startsWith(foldedPrefix)) count += 1
  }
  return count
}

// Remove index rows for files under rootPrefix that no longer exist on disk. Scoped by absolute-path prefix so the shared global DB never prunes another project's rows, and keeps every file still present on disk. Returns the count pruned.
export function pruneDeletedFiles(rootPrefix: string, dbPath: string = globalDbPath()): number {
  if (isTooShallowToPrune(rootPrefix)) return 0
  const db = getDb(dbPath)
  let pruned = 0
  for (const p of findDeletablePaths(rootPrefix, dbPath)) {
    try {
      removeFileFromIndex(db, p)
      pruned += 1
    } catch {
      // Best-effort: one file's delete failure must not abort pruning the rest.
    }
  }
  return pruned
}

/**
 * Record that `filePath`'s project root was just observed alive (an edit was made under it).
 *
 * Feeds {@link sweepKnownRoots}: without a registry of which roots have ever been indexed, the
 * worker's periodic auto-prune sweep would have no safe, bounded set of prefixes to scan --
 * scanning the entire shared `files` table's distinct top-level directories on every cycle, or
 * (worse) pruning against an unscoped drive-root prefix, are exactly what {@link
 * isTooShallowToPrune} exists to prevent. Fail-soft and cheap: called from the edit-hook hot
 * path (throttled by the caller, not here), a no-op when `filePath` isn't under a recognizable
 * project (see {@link findProject}) or resolves to a too-shallow root.
 */
export function recordKnownRoot(filePath: string, dbPath: string = globalDbPath()): void {
  const project = findProject(path.dirname(filePath))
  if (project === null || isTooShallowToPrune(project.root)) return
  const db = getDb(dbPath)
  db.prepare(
    `INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, ?, NULL)
     ON CONFLICT(root) DO UPDATE SET last_seen_ms = excluded.last_seen_ms, first_missing_ms = NULL`,
  ).run(project.root, Date.now())
}

/** How long a known root must read as unreachable, across consecutive sweeps, before it's treated as genuinely gone (renamed/deleted project) rather than a transient outage (sleeping external disk, disconnected network share, an unmounted drive) -- see sweepKnownRoots. */
export const KNOWN_ROOT_MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000

// A live root should only ever lose a handful of files between sweeps under normal churn. If a
// sweep would delete more than this fraction of a *reachable* root's indexed rows in one pass,
// that's far more likely to mean a mount point/subdirectory inside the root went offline than
// that the files were actually deleted -- flag instead of deleting so a human can confirm before
// the rows are gone for good. Does not apply to a root confirmed gone past the grace period
// above: full deletion there is the correct, intended outcome.
const ANOMALY_PRUNE_RATIO = 0.5
// Paired with the ratio above so a small project losing e.g. 2 of its 3 files to normal editing
// churn never gets flagged as an anomaly -- only a genuinely large, suspicious drop does.
const ANOMALY_MIN_COUNT = 20

export interface KnownRootsSweepResult {
  readonly prunedRows: number
  readonly prunedRoots: readonly string[]
  readonly flaggedRoots: readonly string[]
}

/**
 * Auto-prune every known project root's dead file rows, safely, on a schedule.
 *
 * Before this, {@link pruneDeletedFiles} only ever ran via the manual `token-goat index [path]`
 * CLI command -- nothing periodic existed, so a shared `global.db` could (and did) accumulate
 * hundreds of dead rows indefinitely with no automatic recovery. This closes that gap while
 * preserving the safety properties manual pruning already had:
 *
 *  - A root that's merely unreachable this instant (sleeping external disk, disconnected network
 *    share, a drive not yet remounted) is never pruned on first sight -- {@link
 *    KNOWN_ROOT_MISSING_GRACE_MS} must elapse across sweeps before it's treated as genuinely
 *    gone, at which point every row under it is deleted (correct: the root itself no longer
 *    exists) and its {@link recordKnownRoot} tracking row is removed too, so known_roots doesn't
 *    accumulate dead entries forever.
 *  - A root that IS reachable but would still lose an anomalously large fraction of its rows in
 *    one pass ({@link ANOMALY_PRUNE_RATIO} / {@link ANOMALY_MIN_COUNT}) is flagged, not pruned --
 *    that pattern means a mount point/subdirectory inside the root went offline, not that the
 *    files were actually deleted, and blindly pruning would wipe real index rows for content
 *    that's simply unreachable right now.
 *
 * Called from the worker daemon's existing periodic-sweep loop ({@link runWorkerLoop} in
 * worker.ts) on a long cadence -- see KNOWN_ROOTS_SWEEP_INTERVAL_MS there. Never throws.
 */
export function sweepKnownRoots(
  dbPath: string = globalDbPath(),
  opts?: { now?: number; missingGraceMs?: number },
): KnownRootsSweepResult {
  const db = getDb(dbPath)
  const now = opts?.now ?? Date.now()
  const graceMs = opts?.missingGraceMs ?? KNOWN_ROOT_MISSING_GRACE_MS
  const roots = db.prepare('SELECT root, first_missing_ms FROM known_roots').all() as Array<{
    root: string
    first_missing_ms: number | null
  }>

  let prunedRows = 0
  const prunedRoots: string[] = []
  const flaggedRoots: string[] = []

  for (const { root, first_missing_ms: firstMissingMs } of roots) {
    // Defense in depth: recordKnownRoot never writes a too-shallow root, but a hand-edited or
    // otherwise corrupted known_roots row must still never reach a drive-wide prune.
    if (isTooShallowToPrune(root)) continue

    let reachable: boolean
    try {
      reachable = fs.existsSync(root)
    } catch {
      reachable = false
    }

    if (!reachable) {
      if (firstMissingMs === null) {
        db.prepare('UPDATE known_roots SET first_missing_ms = ? WHERE root = ?').run(now, root)
        continue
      }
      if (now - firstMissingMs < graceMs) continue
      const count = pruneDeletedFiles(root, dbPath)
      prunedRows += count
      if (count > 0) prunedRoots.push(root)
      db.prepare('DELETE FROM known_roots WHERE root = ?').run(root)
      continue
    }

    if (firstMissingMs !== null) {
      db.prepare('UPDATE known_roots SET first_missing_ms = NULL WHERE root = ?').run(root)
    }

    const total = countFilesUnderRoot(root, dbPath)
    if (total === 0) continue
    const deletable = findDeletablePaths(root, dbPath)
    if (deletable.length === 0) continue

    if (deletable.length >= ANOMALY_MIN_COUNT && deletable.length / total > ANOMALY_PRUNE_RATIO) {
      flaggedRoots.push(root)
      continue
    }

    for (const p of deletable) {
      try {
        removeFileFromIndex(db, p)
        prunedRows += 1
      } catch {
        // Best-effort: one file's delete failure must not abort the rest of the sweep.
      }
    }
    prunedRoots.push(root)
  }

  return { prunedRows, prunedRoots, flaggedRoots }
}

/** Minimum time between {@link recordKnownRootThrottled} writes, so a burst of edit-hook calls (e.g. a multi-file refactor) doesn't hit the DB on every single one -- roots don't change often enough to need per-edit tracking. */
const KNOWN_ROOT_RECORD_MIN_INTERVAL_MS = 60 * 60 * 1000

function knownRootRecordMarkerPath(dir: string): string {
  return path.join(dir, 'known-root-record.marker')
}

/**
 * Rate-limited wrapper around {@link recordKnownRoot} for the edit-hook hot path.
 *
 * Same marker-file-mtime throttle pattern as ensureWorkerAlive (worker.ts): a fresh marker
 * short-circuits before even resolving `filePath`'s project root, so a burst of edits touches
 * the DB and does the {@link findProject} directory walk at most once per {@link
 * KNOWN_ROOT_RECORD_MIN_INTERVAL_MS}, not on every single edit.
 */
export function recordKnownRootThrottled(
  filePath: string,
  dir: string = dataDir(),
  dbPath: string = globalDbPath(),
): void {
  const markerPath = knownRootRecordMarkerPath(dir)
  try {
    const stat = fs.statSync(markerPath)
    if (Date.now() - stat.mtimeMs < KNOWN_ROOT_RECORD_MIN_INTERVAL_MS) return
  } catch {
    // No marker yet: first check ever for this data dir, proceed.
  }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(markerPath, '')
  } catch {
    // If we can't even write the marker, don't let that block the record below -- worst case we
    // just record more often than intended.
  }
  recordKnownRoot(filePath, dbPath)
}

