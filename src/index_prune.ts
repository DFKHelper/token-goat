import * as fs from 'node:fs'

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { deleteFileEmbeddings } from './embeddings.js'
import { isTooShallowToPrune } from './known_roots.js'
import { deleteFileRows } from './parser.js'
import { isUnderSystemTemp } from './project.js'
import { foldPath, normalizePath } from './util.js'

// Re-exported so the many callers and tests that have always imported the known-root writer from
// this module keep working after it moved to known_roots.js -- the split was made to break an
// import cycle, not to re-point every call site.

type DbHandle = ReturnType<typeof getDb>

// Remove every indexed row (symbols, refs, files) and embedding chunk for one file. Shared primitive the full reindex prune and any future vanished-file reconciliation both build on. Wrapped in a single transaction (mirroring upsertChunks' pattern in embeddings.ts) so a crash or thrown error between the two deletes can never leave orphaned chunks/chunk_vectors rows for a files row that no longer exists -- nothing else ever cleans those up, since pruneDeletedFiles only iterates `SELECT DISTINCT path FROM files`, which the first delete alone (without the second) would already have removed the file from.
export function removeFileFromIndex(db: DbHandle, filePath: string): void {
  const tx = db.transaction(() => {
    deleteFileRows(db, filePath)
    deleteFileEmbeddings(db, filePath)
  })
  // `.immediate()` -- BEGIN IMMEDIATE. The driver issues a plain call as a deferred BEGIN,
  // which takes a read snapshot first and only asks for the write lock at the first writing
  // statement. SQLite refuses that upgrade with SQLITE_BUSY straight away instead of consulting
  // the busy handler, so `busy_timeout` does nothing for it and a concurrent writer fails outright.
  // This database is shared by the worker daemon, the hook processes and the CLI at once, so that
  // is an ordinary situation rather than a rare one. See writeParseResult in parser.ts.
  tx.immediate()
}


function foldedBounds(rootPrefix: string): { foldedRootPrefix: string; foldedPrefix: string } {
  // Normalize before folding: foldPath only lowercases, and a row written from a raw OS path keeps
  // its backslashes while every root arrives forward-slashed, so folding alone never matches the
  // two -- the prefix scan comes back empty and every caller reports a clean nothing-to-do.
  const normalized = normalizePath(rootPrefix)
  const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`
  return { foldedRootPrefix: foldPath(normalized), foldedPrefix: foldPath(prefix) }
}

function allIndexedPaths(dbPath: string): string[] {
  const db = getDb(dbPath)
  const rows = db.prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>
  return rows.map((r) => r.path)
}

// Every distinct indexed path folded under rootPrefix, WITHOUT filtering by disk existence. Shared by findDeletablePaths and countFilesUnderRoot so both match the same fold/prefix rule.
function foldedPathsUnderRoot(rootPrefix: string, dbPath: string): string[] {
  const { foldedRootPrefix, foldedPrefix } = foldedBounds(rootPrefix)
  return allIndexedPaths(dbPath).filter((p) => {
    const foldedP = foldPath(normalizePath(p))
    return foldedP === foldedRootPrefix || foldedP.startsWith(foldedPrefix)
  })
}

// Scan indexed files under rootPrefix and return the absolute paths whose file no longer exists on disk, WITHOUT deleting anything. Shared by pruneDeletedFiles (which deletes them immediately) and sweepKnownRoots' anomaly-ratio guard, which needs the count of what *would* be deleted before committing to the mutating delete.
function findDeletablePaths(rootPrefix: string, dbPath: string): string[] {
  const deletable: string[] = []
  for (const p of foldedPathsUnderRoot(rootPrefix, dbPath)) {
    let stillExists: boolean
    try {
      // isFile, not mere existence: `files` rows are source files, and a path now occupied by a
      // directory (or a symlink to one) means the indexed file is gone even though something answers
      // at that path. Bare existence kept its symbols, references and embedding chunks in the index
      // forever, with no event that could ever clear them.
      const st = fs.statSync(p, { throwIfNoEntry: false })
      stillExists = st !== undefined && st.isFile()
    } catch {
      // Stat failed for a reason other than "file is gone" (EPERM, EBUSY, an antivirus/search-indexer holding a transient lock, etc.). We can't confirm the file was actually deleted, so don't treat it as deletable this pass -- it will be re-evaluated the next time pruning runs.
      continue
    }
    if (!stillExists) deletable.push(p)
  }
  return deletable
}

/** Count indexed file rows under rootPrefix, folded the same way findDeletablePaths matches them. Used by sweepKnownRoots to size its anomaly-ratio guard. */
export function countFilesUnderRoot(rootPrefix: string, dbPath: string = globalDbPath()): number {
  return foldedPathsUnderRoot(rootPrefix, dbPath).length
}

function removeFilesBestEffort(db: DbHandle, paths: string[]): string[] {
  const removed: string[] = []
  for (const p of paths) {
    try {
      removeFileFromIndex(db, p)
      removed.push(p)
    } catch {
      // Best-effort: one file's delete failure must not abort pruning the rest.
    }
  }
  return removed
}

// Same as removeFilesBestEffort, but re-checks disk existence immediately before each delete. findDeletablePaths' scan and this loop's deletes are not one atomic step -- across a large root the gap between "checked, file was gone" and "actually delete the row" can be wide enough for the file to be recreated and reindexed by a concurrent writer (an edit hook, a second worker/CLI invocation, a git checkout) in between. Without this recheck, deleteFileRows deletes unconditionally by path and would wipe that freshly-written row, silently losing the new content. This can only shrink the race window (down to the gap between this statSync and the delete itself), not eliminate it -- true atomicity would need a DB-level guard -- but it closes the far wider window that findDeletablePaths' full-scan-then-delete-all shape otherwise leaves open. Used only where "gone from disk" is the deletion trigger (pruneDeletedFiles, sweepKnownRoots's live-root branch); pruneSystemTempFiles intentionally does NOT use this since its rows are stale regardless of current disk existence.
function removeDeletedFilesBestEffort(db: DbHandle, paths: string[]): string[] {
  // Checked immediately before each delete, one path at a time. Filtering the whole list first and
  // deleting afterwards left the first path's window open across every remaining stat AND every
  // delete -- the full-scan-then-delete-all shape this exists to avoid, just one stage later. Now
  // the window really is the gap between one path's stat and its own delete, as described above.
  const removed: string[] = []
  for (const p of paths) {
    let gone: boolean
    try {
      const st = fs.statSync(p, { throwIfNoEntry: false })
      gone = st === undefined || !st.isFile()
    } catch {
      // Can't confirm the file is actually gone (EPERM/EBUSY/etc) -- don't delete this pass.
      continue
    }
    if (!gone) continue
    try {
      removeFileFromIndex(db, p)
      removed.push(p)
    } catch {
      // Best-effort: one file's delete failure must not abort pruning the rest.
    }
  }
  return removed
}

// Remove index rows for files under rootPrefix that no longer exist on disk. Scoped by absolute-path prefix so the shared global DB never prunes another project's rows, and keeps every file still present on disk. Returns the count pruned.
export function pruneDeletedFiles(rootPrefix: string, dbPath: string = globalDbPath()): number {
  if (isTooShallowToPrune(rootPrefix)) return 0
  const db = getDb(dbPath)
  return removeDeletedFilesBestEffort(db, findDeletablePaths(rootPrefix, dbPath)).length
}

/**
 * Remove every indexed row under a newly excluded root, whether or not the files still exist.
 *
 * `token-goat project exclude <path>` stopped future indexing but left whatever was already
 * indexed exactly where it was, so a directory of credentials excluded after a first index stayed
 * readable through `symbol` indefinitely. Existence-based pruning cannot do this job: the files
 * are still on disk, which is the whole point -- they are excluded, not deleted. Same shape as
 * {@link pruneSystemTempFiles}, whose rows are also stale regardless of what is on disk.
 *
 * Refuses a root shallow enough to span a drive, for the reason {@link isTooShallowToPrune} gives.
 * Returns the paths removed.
 */
export function pruneBlockedRoot(rootPrefix: string, dbPath: string = globalDbPath()): string[] {
  // The caller is a CLI argument run through path.resolve, so on Windows it arrives with
  // backslashes while every stored path is normalized. foldPath only lowercases, so without this
  // the prefix match silently finds nothing and the command reports a clean purge of zero files.
  const normalized = normalizePath(rootPrefix)
  if (isTooShallowToPrune(normalized)) return []
  return removeFilesBestEffort(getDb(dbPath), foldedPathsUnderRoot(normalized, dbPath))
}

/** The indexed paths {@link pruneBlockedRoot} would remove, without removing them. For a dry run. */
export function findFilesUnderBlockedRoot(rootPrefix: string, dbPath: string = globalDbPath()): string[] {
  const normalized = normalizePath(rootPrefix)
  if (isTooShallowToPrune(normalized)) return []
  return foldedPathsUnderRoot(normalized, dbPath)
}

// Scan all indexed files and return the absolute paths that live under the OS system temp directory (see isUnderSystemTemp's docstring), WITHOUT deleting anything. Unlike findDeletablePaths this isn't scoped to a rootPrefix -- system temp is inherently ephemeral, so any indexed row under it is stale regardless of which scratch checkout produced it. Exported so cmdProject's --dry-run can report what would be pruned before committing.
export function findSystemTempFiles(dbPath: string = globalDbPath()): string[] {
  return allIndexedPaths(dbPath).filter((p) => isUnderSystemTemp(p))
}

// Remove index rows for every indexed file under the OS system temp directory -- the retroactive half of the system-temp pollution fix (the prevention half gates hooks_edit.ts's dirty-queue enqueue). Returns the pruned paths.
export function pruneSystemTempFiles(dbPath: string = globalDbPath()): string[] {
  const db = getDb(dbPath)
  return removeFilesBestEffort(db, findSystemTempFiles(dbPath))
}

/**
 * Every distinct `chunks.file_path` with no matching row in `files`, without deleting anything.
 *
 * Chunks are only ever written after their file's `files` row exists (the worker indexes
 * synchronously first, then fires the embed), so a chunk without a file row is always damage --
 * a crash between the two deletes in an older, non-transactional `removeFileFromIndex`, a prune
 * racing a lagging embed for a path just deleted, or any other half-applied removal.
 *
 * Such a row is unreachable by every existing prune, because {@link allIndexedPaths} enumerates
 * `SELECT DISTINCT path FROM files`: once the file row is gone, no sweep can even name the path,
 * so {@link pruneDeletedFiles}, {@link pruneBlockedRoot} and {@link pruneSystemTempFiles} all
 * report a clean nothing-to-do while the chunk keeps its text and its vector and keeps being
 * served by `semantic`. Only `reclaim --rebuild`, which wipes the entire index, cleared them.
 */
export function findOrphanedChunkPaths(dbPath: string = globalDbPath()): string[] {
  return orphanedChunkGroups(getDb(dbPath)).map((g) => g.representative)
}

/**
 * One orphaned file, with every raw `chunks.file_path` spelling that belongs to it.
 *
 * Grouped by folded-and-normalized path rather than by raw spelling for two separate reasons.
 * Reporting: on a case-insensitive filesystem `C:/x.ts` and `c:/x.ts` are one file, and counting
 * both made `project prune` claim two files where it had cleared one. Deletion: {@link
 * deleteFileEmbeddings} folds the spelling it is handed but does not normalize it, so a row
 * written with backslashes and a row written with forward slashes are two different deletes even
 * though they are the same file. Deleting only the representative would leave the other spelling
 * behind, and it would come back as an orphan on every future sweep, forever.
 */
function orphanedChunkGroups(db: DbHandle): Array<{ representative: string; spellings: string[] }> {
  const known = new Set(
    (db.prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>).map((r) =>
      foldPath(normalizePath(r.path)),
    ),
  )
  const rows = db.prepare('SELECT DISTINCT file_path FROM chunks').all() as Array<{ file_path: string }>
  const byFolded = new Map<string, { representative: string; spellings: string[] }>()
  for (const { file_path: raw } of rows) {
    const folded = foldPath(normalizePath(raw))
    if (known.has(folded)) continue
    const group = byFolded.get(folded)
    if (group === undefined) byFolded.set(folded, { representative: raw, spellings: [raw] })
    else group.spellings.push(raw)
  }
  return [...byFolded.values()]
}

/**
 * Delete the chunks and vectors {@link findOrphanedChunkPaths} finds. Returns the paths cleared.
 *
 * The scan and the deletes run inside one `BEGIN IMMEDIATE` transaction, taking the write lock
 * before reading rather than after. Reading first and deleting after -- the shape {@link
 * removeDeletedFilesBestEffort} is stuck with, because its condition lives on disk where no
 * database lock can cover it -- leaves a window in which another process reindexes a path this
 * one just observed as orphaned, restoring its `files` row and rewriting its chunks, and then
 * this delete wipes the live rows it never looked at. That window is real here: the worker fires
 * embeddings without awaiting them, so a rewrite can land at any moment. This condition lives
 * entirely in the same database as the delete, so unlike the disk case it can simply be made
 * atomic instead of merely narrowed.
 */
export function pruneOrphanedChunks(dbPath: string = globalDbPath()): string[] {
  const db = getDb(dbPath)
  const removed: string[] = []
  const run = db.transaction(() => {
    for (const group of orphanedChunkGroups(db)) {
      try {
        for (const spelling of group.spellings) deleteFileEmbeddings(db, spelling)
        removed.push(group.representative)
      } catch {
        // Best-effort, same contract as removeFilesBestEffort: one path's failure must not abort
        // the rest. Caught here rather than allowed to propagate, so one bad row cannot roll back
        // every good delete in the batch.
      }
    }
  })
  run.immediate()
  return removed
}

/**
 * Delete vectors whose `chunks` row is gone.
 *
 * Two writers create them, both deliberately: `deleteFileEmbeddings` makes its vector delete
 * conditional on `chunk_vectors` being usable but its chunk delete unconditional, and
 * `purgeDotenvEmbeddings` catches a failed vector delete and clears the chunk row regardless. Both
 * are right to -- leaking a chunk row is worse than leaking a vector, since the chunk row is what
 * every scoped query reads. But the leftover vector is then unreachable by every other sweep in
 * this file and in embeddings.ts: `pruneOrphanedChunks`, `pruneDeletedFiles`, `resetAllEmbeddings`
 * and `resetEmbeddingsForKinds` all take their population from `chunks` or `files` rows, which for
 * an orphan are by definition already deleted. Only a full `reclaimIndex({rebuild: true})` -- which
 * truncates every derived table for every project on the machine -- clears them today.
 *
 * Unreclaimed, they cost twice. They inflate the on-disk `chunk_vectors` size that `doctor` reports
 * without being able to attribute, and every KNN pass spends candidate slots on rows that join to
 * nothing: `fetchScopedHits` drops them silently, so the loss is invisible at every surface. The
 * leak is monotonic and has no ceiling, which is why this runs on the same schedule as the others
 * rather than waiting for a rebuild someone has to ask for.
 *
 * Point-deletes by rowid rather than `rowid IN (subquery)`, for the `xBestIndex` reason
 * `deleteFileEmbeddings` documents: a subquery is opaque to the vec0 planner and degrades to a scan
 * of the whole index. The whole body is wrapped in one try, which is also the usability probe --
 * an install without sqlite-vec throws `no such table` or `no such module: vec0` on the first
 * statement, and has no vectors to reclaim either way.
 */
export function pruneOrphanedVectors(dbPath: string = globalDbPath()): number {
  const db = getDb(dbPath)
  try {
    const ids = db
      .prepare('SELECT v.rowid AS id FROM chunk_vectors v LEFT JOIN chunks c ON c.id = v.rowid WHERE c.id IS NULL')
      .pluck()
      .all() as number[]
    if (ids.length === 0) return 0
    const deleteVector = db.prepare('DELETE FROM chunk_vectors WHERE rowid = ?')
    db.transaction(() => {
      for (const id of ids) deleteVector.run(id)
    }).immediate()
    return ids.length
  } catch {
    return 0
  }
}


/** How long a known root must read as unreachable, across consecutive sweeps, before it's treated as genuinely gone (renamed/deleted project) rather than a transient outage (sleeping external disk, disconnected network share, an unmounted drive) -- see sweepKnownRoots. */
export const KNOWN_ROOT_MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000

// A live root should only ever lose a handful of files between sweeps under normal churn. If a sweep would delete more than this fraction of a *reachable* root's indexed rows in one pass, that's far more likely to mean a mount point/subdirectory inside the root went offline than that the files were actually deleted -- flag instead of deleting so a human can confirm before the rows are gone for good. Does not apply to a root confirmed gone past the grace period above: full deletion there is the correct, intended outcome.
const ANOMALY_PRUNE_RATIO = 0.5
// Paired with the ratio above so a small project losing e.g. 2 of its 3 files to normal editing
// churn never gets flagged as an anomaly -- only a genuinely large, suspicious drop does.
const ANOMALY_MIN_COUNT = 20

export interface KnownRootsSweepResult {
  readonly prunedRows: number
  readonly prunedRoots: readonly string[]
  readonly flaggedRoots: readonly string[]
  /** Paths whose embedding chunks outlived their `files` row -- see {@link findOrphanedChunkPaths}. */
  readonly prunedOrphanChunkPaths: readonly string[]
  /** Vectors whose `chunks` row was already gone -- see {@link pruneOrphanedVectors}. */
  readonly prunedOrphanVectors: number
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
 * worker.ts) on a long cadence -- see KNOWN_ROOTS_SWEEP_INTERVAL_MS there, and on demand from
 * `token-goat project prune`. Never throws.
 *
 * With `dryRun`, every branch below reaches the same decision and writes nothing: no row is
 * deleted, no grace timestamp is stamped or cleared, and the two orphan passes are skipped
 * because they mutate unconditionally. The result then reports what a real sweep would do.
 * `prunedRows` is a count of rows found deletable rather than of deletes performed, which is the
 * same number the real pass writes except where the recheck-before-delete in
 * {@link removeDeletedFilesBestEffort} catches a file recreated in between -- so it is an upper
 * bound, and the preview says "would" for exactly that reason.
 */
export function sweepKnownRoots(
  dbPath: string = globalDbPath(),
  opts?: { now?: number; missingGraceMs?: number; dryRun?: boolean },
): KnownRootsSweepResult {
  const db = getDb(dbPath)
  const now = opts?.now ?? Date.now()
  const graceMs = opts?.missingGraceMs ?? KNOWN_ROOT_MISSING_GRACE_MS
  const dryRun = opts?.dryRun === true
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
      // isDirectory, not mere existence. A project root replaced by a regular file answers
      // existsSync, so the live-root branch below ran against a root whose every indexed child is
      // missing: the anomaly ratio hit 100%, the root was flagged instead of pruned, and it stayed
      // flagged on every later sweep. The rows were then unreachable by any code path -- the
      // missing-root grace that would have pruned them is skipped precisely because the root
      // "exists".
      reachable = fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() === true
    } catch {
      reachable = false
    }

    if (!reachable) {
      if (firstMissingMs === null) {
        if (!dryRun) db.prepare('UPDATE known_roots SET first_missing_ms = ? WHERE root = ?').run(now, root)
        continue
      }
      if (now - firstMissingMs < graceMs) continue
      // Counted, not deleted, under dryRun: findDeletablePaths is pruneDeletedFiles' own read-only half, so the preview and the real pass agree by sharing the scan rather than by restating its rule.
      const count = dryRun ? findDeletablePaths(root, dbPath).length : pruneDeletedFiles(root, dbPath)
      prunedRows += count
      if (count > 0) prunedRoots.push(root)
      if (!dryRun) db.prepare('DELETE FROM known_roots WHERE root = ?').run(root)
      continue
    }

    if (firstMissingMs !== null && !dryRun) {
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

    prunedRows += dryRun ? deletable.length : removeDeletedFilesBestEffort(db, deletable).length
    prunedRoots.push(root)
  }

  // Unscoped, like pruneSystemTempFiles: an orphaned chunk has no file row, so it belongs to no
  // known root and no per-root branch above could ever reach it. Runs last so any file row the
  // loop just deleted has already released its chunks through removeFileFromIndex's transaction,
  // leaving only genuinely half-applied leftovers for this pass to clear.
  const prunedOrphanChunkPaths = dryRun ? findOrphanedChunkPaths(dbPath) : pruneOrphanedChunks(dbPath)
  // After the chunk sweep, not before: that pass deletes chunk rows, and any vector it could not
  // delete alongside them becomes an orphan this pass then collects in the same run.
  // No read-only counterpart exists for the vector pass, and inventing one would restate sqlite-vec's own join rather than share it. A preview reports 0 and says so at the call site rather than guessing a number.
  const prunedOrphanVectors = dryRun ? 0 : pruneOrphanedVectors(dbPath)

  return { prunedRows, prunedRoots, flaggedRoots, prunedOrphanChunkPaths, prunedOrphanVectors }
}


export interface ProjectIndexConsumer {
  root: string
  fileCount: number
}

/**
 * Top project roots by indexed file count in the database.
 * Used by doctor to name the heaviest projects contributing to an oversized global.db.
 */
export function findTopIndexedProjects(dbPath: string = globalDbPath(), limit = 3): ProjectIndexConsumer[] {
  try {
    const db = getDb(dbPath)
    const hasRoots = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='known_roots'").get()
    if (!hasRoots) return []
    const rawRoots = (db.prepare('SELECT root FROM known_roots').all() as { root: string }[]).map((r) => r.root)
    // Canonicalize through the same normalizePath/foldPath the rest of the pruner uses: a root stored with backslashes or a mixed-case drive must still match the forward-slash `files.path` rows, and case-folding must follow the filesystem, not an unconditional lowercase.
    const seen = new Map<string, string>()
    for (const r of rawRoots) {
      const norm = normalizePath(r).replace(/\/+$/, '')
      const lower = foldPath(norm)
      if (!seen.has(lower)) seen.set(lower, norm)
    }
    const results: ProjectIndexConsumer[] = []
    for (const root of seen.values()) {
      const count = (
        db.prepare("SELECT count(*) as c FROM files WHERE path LIKE ? || '/%' OR path = ?").get(root, root) as {
          c: number
        }
      ).c
      if (count > 0) results.push({ root, fileCount: count })
    }
    results.sort((a, b) => b.fileCount - a.fileCount)
    // A root nested inside another indexed root is the same tree counted twice; keep the outer one, which already holds the inner files.
    const unique: ProjectIndexConsumer[] = []
    for (const res of results) {
      const isDuplicate = unique.some((u) => {
        const r1 = foldPath(u.root)
        const r2 = foldPath(res.root)
        return r1.startsWith(r2 + '/') || r2.startsWith(r1 + '/')
      })
      if (!isDuplicate) unique.push(res)
      if (unique.length >= limit) break
    }
    return unique.slice(0, limit)
  } catch {
    return []
  }
}


