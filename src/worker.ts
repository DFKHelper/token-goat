/**
 * Background worker — drain the dirty queue and re-index changed files.
 *
 * Ports the daemon loop of `worker.py` to the TypeScript surface: {@link
 * startDetachedWorker} spawns a long-lived detached child process that
 * outlives the launching CLI invocation. Its PID is recorded in a pid file
 * so a later {@link stopWorker} / {@link isWorkerRunning} can find it.
 *
 * The loop itself: read `{dataDir}/queue/dirty.txt`, parse each changed path,
 * and write its symbol/ref rows into the index DB via {@link indexFileSync}.
 * Processed entries are cleared from the queue before sleeping `pollIntervalMs`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dataDir, globalDbPath } from './constants.js'
import { fileIsAbsent, fingerprintFile } from './fingerprint.js'
import { indexFileSync, indexFileEmbeddings, indexedPathSpellingIsStale, isEmbedFresh, isParseSkipEligible } from './parser.js'
import { embeddingsDepsAvailable } from './embeddings.js'
import { getFileEntry } from './index_reader.js'
import { normalizePath } from './paths.js'
import { ensureDirSync, foldPath, isUnderBlockedRoot, extractErrorMessage } from './util.js'
import { loadConfig } from './config.js'
import { getDb } from './db.js'
import { pathEqClause } from './sql_path.js'
import { removeFileFromIndex, pruneDeletedFiles, sweepExpiredKnownRootMarkers, sweepKnownRoots } from './index_prune.js'
import { cleanup_stale } from './snapshots.js'
import { sweepCacheRoots } from './disk_cache.js'
import { findProject } from './project.js'
import { registerReset } from './reset.js'

/** Options shared by the in-thread and detached worker entry points. */
export interface WorkerOptions {
  /** Poll interval between drains, in milliseconds. Default 2000. */
  readonly pollIntervalMs?: number
  /** Data directory override (defaults to {@link dataDir}). */
  readonly dataDir?: string
}

const DEFAULT_POLL_INTERVAL_MS = 2000

/**
 * Resolve the poll interval a worker should use: an explicit caller-supplied value first, then a
 * positive-integer `TG_WORKER_POLL_MS`, then the default. Anything else in the env var (empty,
 * non-numeric, zero, negative) is ignored rather than trusted.
 *
 * Shared by {@link startDetachedWorker} and {@link runDetachedWorkerDaemon} so the two ends agree
 * on what a valid interval is: the parent can never forward a value the child would reject and
 * silently swap for the default. The parent used to skip the env entirely and hardcode the
 * default into the child's environment, which made `TG_WORKER_POLL_MS` a no-op on the normal
 * `worker start` path even though the daemon itself reads it.
 */
export function resolvePollIntervalMs(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const parsed = parseInt(process.env['TG_WORKER_POLL_MS'] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS
}
export const WORKER_HEARTBEAT_STALE_MS = 60_000
const WORKER_HEARTBEAT_REFRESH_MS = 5_000
const WORKER_STARTUP_GRACE_MS = 10_000

// Stale session-snapshot sweep runs on the same loop as the dirty-queue drain (see runWorkerLoop) but throttled to this interval -- cleanup_stale's own default 24h staleness window doesn't need finer-grained sweeping than hourly, and a full directory scan on every 2s poll tick would be wasteful.
const SNAPSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/**
 * How many {@link drainOnce} cycles to skip between opportunistic
 * {@link pruneDeletedFiles} sweeps. A `git mv`, directory rename, `git checkout <branch>`,
 * or `git clean` never fires an Edit hook for the paths it touches, so a plain dirty-queue
 * drain (which only reconciles a deletion when the exact old path was enqueued) never
 * notices those rows are gone and they orphan in the index forever. `pruneDeletedFiles`
 * walks every indexed path under a project root and stats each one to catch this — too
 * expensive to repeat on every ~2s poll tick, so it only runs every Nth cycle (mirrors
 * SNAPSHOT_CLEANUP_INTERVAL_MS's throttling above, keyed on drain-cycle count here instead
 * of wall time since the trigger is "enough drain activity", not "enough time elapsed").
 */
const PRUNE_EVERY_N_DRAINS = 30

/**
 * Per-dataDir drain-cycle counters, so unrelated worker instances (distinct test dirs, or a
 * future multi-dataDir setup) don't share a single global cadence.
 */
const drainCycleCounts = new Map<string, number>()
const heartbeatWriteTimes = new Map<string, number>()

/**
 * Per-dataDir last-known project root, opportunistically learned from the dirty paths
 * {@link processDirtyBatch} actually processes. The dirty queue is global and path-keyed (one
 * shared `dataDir`, not one per project — see the module doc comment), so there is no
 * standing notion of "the active project" for the periodic prune sweep to target; the files
 * currently flowing through the queue are the closest available signal for which project is
 * active. This is deliberately best-effort: a rename/delete that happens without any other
 * Edit-hook traffic in between won't be pruned until the NEXT unrelated edit in that project
 * re-establishes the project root, which is an acceptable trade-off for orphaned rows that
 * would otherwise never be cleaned up at all.
 */
const lastKnownProjectRoots = new Map<string, string>()

/**
 * Tracks '.draining' files whose content was already folded into a batch by
 * {@link drainOnce} but could not be removed or quarantined (both cleanup
 * attempts failed, e.g. a persistent Windows sharing violation). Keyed by the
 * '.draining' file's absolute path, valued by the exact content already
 * processed. Without this, a `.draining` file that survives a full drain
 * cycle unchanged would be re-read and its paths reprocessed on every
 * subsequent cycle until cleanup finally succeeds.
 */
const unclearedDrainingSnapshots = new Map<string, string>()

/**
 * Identity-plus-content stamp for a draining file, used as the {@link unclearedDrainingSnapshots}
 * value. Content alone is not enough to decide "we already folded this file in": a *different*
 * file reusing the same `.draining` name can hold byte-identical content, which is the common
 * case rather than a rare one, since re-editing the same source file queues the same path again.
 * A stale snapshot matching that way makes stage (a) skip a batch nobody processed -- reachable
 * when a crash between stage (b)'s claim-rename and its batch leaves the claimed file unprocessed.
 * mtime and size separate the two: cycles are seconds apart, so a recreated file differs.
 */
function drainingSnapshotStamp(file: string, content: string): string {
  let identity = 'unknown'
  try {
    const stat = fs.statSync(file)
    identity = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
  } catch {
    // Unstattable: fall back to content-only matching, which is the previous behavior.
  }
  return `${identity}::${content}`
}

/** How many times stage (a) re-reads a `.draining` file before treating it as genuinely unreadable. Mirrors stage (b)'s claim-rename retry budget. */
const DRAINING_READ_ATTEMPTS = 5
/** Delay between the stage (a) read retries above, in milliseconds. */
const DRAINING_READ_RETRY_DELAY_MS = 50

/**
 * List every live draining-recovery file for `queuePath`: the primary
 * `dirty.txt.draining` name, plus any `.alt-<ts>` fallback claimed by stage
 * (b) when the primary name was still occupied by a file a previous cycle
 * could not clean up (see drainOnce's stage (b) comment). Excludes
 * `.corrupt-*` quarantine files, which are deliberately abandoned and must
 * never be reprocessed. Without recovering every fallback file (not just the
 * first), a single stuck primary `.draining` file could starve the rest of
 * the queue from ever draining.
 */
function listDrainingFiles(queuePath: string): string[] {
  const dir = path.dirname(queuePath)
  const base = `${path.basename(queuePath)}.draining`
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name === base || (name.startsWith(`${base}.alt-`) && !name.includes('.corrupt-')))
    .sort()
    .map((name) => path.join(dir, name))
}

/**
 * Cap on consecutive transient-read-failure requeues for the same path (see
 * {@link requeueDirtyPath}). Without this, a file with a permanently stuck read lock (or
 * any other per-file failure that never clears) gets requeued forever, every ~2s drain
 * cycle, with no cap and no throttled visibility into the fact that it's stuck.
 */
const MAX_TRANSIENT_RETRIES = 5

/**
 * Read and increment `files.retry_count` for `absPath` in the index DB at `dbPath`, creating a
 * placeholder `files` row (every other column left unset) if the path has never been indexed
 * yet. Returns the count AFTER incrementing.
 *
 * Persisted in the index DB rather than an in-memory Map so the count survives across the
 * hook-process/daemon-process boundary -- see {@link resetTransientRetryCount}'s doc comment
 * for the cross-process bug this closes. Matched by the same folded-path convention as every
 * other file_path/path comparison in this codebase (see {@link foldPath}, {@link
 * pathEqClause}), so a case-variant reference to the same file on a case-insensitive
 * filesystem shares one counter. Wrapped in a transaction so the read-then-write is atomic
 * against a concurrent writer (the daemon and a CLI hook process both have DB access).
 */
function bumpRetryCount(dbPath: string, absPath: string): number {
  const db = getDb(dbPath)
  // The files.path column stores paths normalized by normalizePath() (forward slashes) -- every real writer (hooks_edit.ts's postEditHandler, cli.ts's cmdIndex via resolveIndexPath) normalizes before the path ever reaches the queue or the indexer; see sql_path.ts's projectScopeClause doc for the same invariant stated from the SQL side. Normalize defensively here too so correctness doesn't silently depend on every future caller remembering to pre-normalize -- a caller that passed a native backslash path straight through used to always miss the SELECT and fall into the INSERT branch below instead of matching the existing row (see the regression test in worker.test.ts).
  const normalized = normalizePath(absPath)
  const folded = foldPath(normalized)
  const tx = db.transaction((): number => {
    const row = db.prepare(`SELECT retry_count FROM files WHERE ${pathEqClause('path')}`).get(folded) as
      | { retry_count: number | null }
      | undefined
    if (row !== undefined) {
      const next = (row.retry_count ?? 0) + 1
      db.prepare(`UPDATE files SET retry_count = ? WHERE ${pathEqClause('path')}`).run(next, folded)
      return next
    }
    db.prepare('INSERT INTO files (path, retry_count) VALUES (?, 1)').run(normalized)
    return 1
  })
  return tx()
}

/**
 * Reset `files.retry_count` to 0 for `absPath` in the index DB at `dbPath`. Best-effort: a DB
 * error here (e.g. the DB does not exist yet) must not block the caller's own already-completed
 * work. No-op if the path has no `files` row yet -- nothing to reset.
 */
function clearRetryCount(dbPath: string, absPath: string): void {
  try {
    const db = getDb(dbPath)
    // See bumpRetryCount's doc comment: normalize defensively to match the normalized form
    // the row was written under.
    const folded = foldPath(normalizePath(absPath))
    db.prepare(`UPDATE files SET retry_count = 0 WHERE ${pathEqClause('path')}`).run(folded)
  } catch {
    // best-effort -- see doc comment above.
  }
}

/**
 * Clear any transient-retry count for `absPath`, giving it a fresh retry budget.
 *
 * Called from {@link appendDirtyPath} (`hooks_index.ts`) whenever an edit freshly dirties a
 * path, so a path that previously exhausted {@link MAX_TRANSIENT_RETRIES} (e.g. during a long
 * antivirus/OneDrive lock episode) does not inherit that exhausted counter on its next,
 * unrelated failure streak after the file is edited again.
 *
 * Persisted to the index DB (files.retry_count), NOT an in-memory Map: appendDirtyPath runs in
 * the short-lived hook CLI process, while the drain loop that reads the retry count
 * (requeueDirtyPath, via processDirtyBatch/drainOnce) runs in the long-lived detached daemon --
 * a separate Node process with its own heap. A reset that only mutated a module-level Map here
 * would be invisible to the daemon's own copy of that Map and would silently do nothing in the
 * real deployed topology: an already-exhausted path would stay permanently given-up-on even
 * after being freshly edited. Going through the index DB, which both processes already share
 * for every other cross-process-visible field (files.sha, files.embed_sha), makes the reset
 * actually observable on the daemon's next drain cycle. `dbPath` defaults to the global index
 * DB every real caller uses; tests pass an isolated dir's DB explicitly to prove the DB write is
 * what unblocks retries, not any process-local cache.
 */
export function resetTransientRetryCount(absPath: string, dbPath: string = globalDbPath()): void {
  clearRetryCount(dbPath, absPath)
}

/** Absolute path to the dirty queue file for `dir`. */
export function dirtyQueuePathFor(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
}

/** Absolute path to the drain-heartbeat marker for `dir`, touched at the end of every `drainOnce` cycle (whether or not anything was processed) so a doctor check can distinguish "worker process alive" from "worker actually still draining" -- a deadlocked or wedged loop keeps its pid alive without ever reaching the touch below. */
export function drainHeartbeatPathFor(dir: string): string {
  return path.join(dir, 'queue', 'drain-heartbeat')
}

function writeDrainHeartbeat(dir: string, force = false): void {
  const now = Date.now()
  if (!force && now - (heartbeatWriteTimes.get(dir) ?? 0) < WORKER_HEARTBEAT_REFRESH_MS) return
  try {
    ensureDirSync(path.dirname(drainHeartbeatPathFor(dir)))
    fs.writeFileSync(drainHeartbeatPathFor(dir), `${process.pid}\n`)
    heartbeatWriteTimes.set(dir, now)
  } catch {
    // Best-effort liveness signal; failed heartbeat writes must not stop indexing.
  }
}

function hasFreshWorkerHeartbeat(dir: string, pid: number): boolean {
  try {
    const heartbeatPath = drainHeartbeatPathFor(dir)
    if (Date.now() - fs.statSync(heartbeatPath).mtimeMs > WORKER_HEARTBEAT_STALE_MS) return false
    return fs.readFileSync(heartbeatPath, 'utf8').trim() === String(pid)
  } catch {
    return false
  }
}

function pidFileIsWithinStartupGrace(dir: string): boolean {
  try {
    return Date.now() - fs.statSync(workerPidPath(dir)).mtimeMs < WORKER_STARTUP_GRACE_MS
  } catch {
    return false
  }
}

/**
 * Parse and deduplicate dirty queue lines. Used by both getDirtyPathsFor and the rename-to-claim
 * drain logic, and reused by hooks_index.getDirtyPaths so the informational pre-compact snapshot
 * dedupes on the same case-folded key as the real reindex drain rather than an exact-string match
 * that missed case-variant duplicates on Windows/macOS.
 */
/**
 * Marks a queue line whose path could not survive the plain one-path-per-line format.
 *
 * A raw line is an absolute normalized path, which always begins with a slash or a drive letter, so
 * a leading `!` cannot collide with one. The decoder also requires what follows to parse as a JSON
 * string, so a hand-written or legacy line that happens to start with `!` is left alone rather than
 * discarded.
 */
const ENCODED_LINE_MARKER = '!'

/**
 * Render one path as a queue line.
 *
 * Almost every path is written as itself: that keeps the file byte-identical to what earlier builds
 * produced, which matters because a queue left behind by an older build is read by this one. Only a
 * path the format genuinely cannot hold is encoded -- one containing a line break, which would
 * become two entries, or one whose first or last character is whitespace, which the reader's trim
 * would quietly turn into a different path.
 */
export function encodeDirtyQueueLine(absPath: string): string {
  const needsEncoding = /[\r\n]/.test(absPath) || absPath !== absPath.trim()
  return needsEncoding ? ENCODED_LINE_MARKER + JSON.stringify(absPath) : absPath
}

/** Undo {@link encodeDirtyQueueLine}, leaving anything that is not a well-formed encoded line as it is. */
function decodeDirtyQueueLine(line: string): string {
  if (!line.startsWith(ENCODED_LINE_MARKER)) return line
  try {
    const decoded: unknown = JSON.parse(line.slice(ENCODED_LINE_MARKER.length))
    return typeof decoded === 'string' ? decoded : line
  } catch {
    return line
  }
}

export function parseDirtyQueueLines(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = decodeDirtyQueueLine(line.trim())
    if (trimmed === '') continue
    // On case-insensitive filesystems (Windows/macOS), deduplicate by case-folded form so "C:\Projects\file.ts" and "c:\projects\file.ts" are recognized as the same entry. normalizePath only lowercases the drive letter, so we fold the entire normalized path for dedup.
    const normalized = normalizePath(trimmed)
    const dedupeKey = foldPath(normalized)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(trimmed)
  }
  return out
}

/** Absolute path to the worker pid file for `dir`. */
export function workerPidPath(dir: string = dataDir()): string {
  return path.join(dir, 'worker.pid')
}

/**
 * Read every queued dirty path for `dir`, deduplicated, in insertion order.
 *
 * Mirrors `hooks_index.getDirtyPaths` but is parameterised on the data dir so
 * the detached worker (which may run with a different cwd) reads the same file.
 * Returns `[]` when the queue file is absent.
 */
export function getDirtyPathsFor(dir: string): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(dirtyQueuePathFor(dir), 'utf8')
  } catch {
    return []
  }
  return parseDirtyQueueLines(raw)
}


/**
 * Absolute path to the worker's incremental-index error log for `dir`. Appended to (never
 * truncated) whenever {@link makeIndexer}'s default callback swallows a per-file indexing
 * failure. This is the only place such a failure is ever discoverable: the detached worker
 * process spawned by {@link startDetachedWorker} runs with `stdio: 'ignore'`, so anything the
 * worker process writes to stdout/stderr is silently discarded.
 */
function workerErrorLogPath(dir: string): string {
  return path.join(dir, 'worker-errors.log')
}

/**
 * Cap on worker-errors.log's size before {@link cleanupWorkerStateFiles} rotates (truncates) it.
 * Mirrors disk_cache.ts's pruneBlobs size/age-cutoff pattern for keeping other accumulating
 * state bounded over a long-lived daemon's lifetime -- nothing previously rotated this file, so
 * it could otherwise grow unbounded across a project's entire index lifetime.
 */
const WORKER_ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * How old a `.draining.corrupt-<timestamp>` quarantine file (see drainOnce's cleanup-failure
 * fallback) must be before {@link cleanupWorkerStateFiles} removes it. Mirrors disk_cache.ts's
 * pruneBlobs age cutoff and snapshots.ts's cleanup_stale 24h window, scaled up: a quarantine file
 * is kept around long enough to be manually inspected after a persistent lock/corruption issue,
 * not treated as routine cache churn.
 */
const CORRUPT_QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Best-effort housekeeping for the worker's own accumulating state files under `dir`:
 *  - rotates (truncates) `worker-errors.log` once it exceeds {@link WORKER_ERROR_LOG_MAX_BYTES}.
 *  - removes `.corrupt-*` dirty-queue quarantine files older than
 *    {@link CORRUPT_QUARANTINE_MAX_AGE_MS}.
 *  - removes expired `known-root-record-*.marker` throttle files (see
 *    {@link sweepExpiredKnownRootMarkers}).
 * None had any rotation/cleanup before this, so all could grow unbounded over a project's
 * index lifetime. Mirrors the size/age-cutoff cleanup pattern already used elsewhere in this
 * codebase for other accumulating state (disk_cache.ts's pruneBlobs, snapshots.ts's
 * cleanup_stale). Fail-soft: never throws. Called on the same periodic sweep as cleanup_stale in
 * {@link runWorkerLoop}; exported so tests can drive it directly without waiting on real time.
 */
export function cleanupWorkerStateFiles(dir: string): void {
  try {
    const logPath = workerErrorLogPath(dir)
    const stat = fs.statSync(logPath)
    if (stat.size > WORKER_ERROR_LOG_MAX_BYTES) {
      fs.writeFileSync(
        logPath,
        `${new Date().toISOString()} worker-errors.log rotated (exceeded ${WORKER_ERROR_LOG_MAX_BYTES} bytes)\n`,
      )
    }
  } catch {
    // Missing log file, or a stat/write failure -- nothing to rotate.
  }
  try {
    const queueDir = path.dirname(dirtyQueuePathFor(dir))
    const cutoff = Date.now() - CORRUPT_QUARANTINE_MAX_AGE_MS
    for (const file of fs.readdirSync(queueDir)) {
      if (!file.includes('.corrupt-')) continue
      const full = path.join(queueDir, file)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
      } catch {
        // best-effort per-file cleanup -- one bad quarantine file must not abort the sweep.
      }
    }
  } catch {
    // Missing queue dir, or a readdir failure -- nothing to clean.
  }
  // Third accumulating state file, in the data dir rather than the queue dir: one throttle marker per directory ever edited, with no reaper of its own.
  sweepExpiredKnownRootMarkers(dir)
}

/**
 * Sentinel returned by {@link makeIndexer}'s default callback when `indexFileSync` (or the
 * sha-gate lookup preceding it) throws. Distinct from the sha-gate's own `false` no-op-skip
 * return so {@link processDirtyBatch} never conflates "nothing needed reindexing" with "indexing
 * was attempted and failed" -- both must be excluded from the indexed count, but only the latter
 * is a real problem worth logging.
 */
const INDEX_FAILED = Symbol('indexFailed')

/**
 * Chains concurrent {@link indexFileEmbeddings} calls for the same file so they resolve in
 * submission order rather than completion order.
 *
 * makeIndexer's default callback fires embedding off without awaiting it (see its doc comment --
 * the drain loop must return instantly), so two drains of a rapidly re-edited file can spawn two
 * concurrent `indexFileEmbeddings` promises for the same path. Without serialization, if the
 * OLDER call (started first, with now-stale content) happens to finish AFTER the newer one, its
 * stale chunks/vectors silently overwrite the fresher ones -- a last-writer-wins bug that
 * nothing self-corrects until the next edit touches the file again. Keyed by the case-folded
 * path (matching {@link foldPath}'s convention used everywhere else in this file for path
 * identity) so same-file concurrency is serialized while different files still embed in
 * parallel. Cleared once a chain settles and nothing newer has been chained onto it, so this map
 * does not grow unbounded over a long-lived daemon's lifetime.
 */
const inFlightEmbeddings = new Map<string, Promise<unknown>>()

/**
 * Resolve once every embedding call currently tracked in {@link inFlightEmbeddings} has settled
 * -- including one still waiting on the global concurrency slot (see {@link embedFileSerialized}),
 * since a slot's entry is added to the map at dispatch time regardless of whether it started
 * immediately or was queued behind the cap. makeIndexer fires embedding fire-and-forget by
 * design (the drain loop must return instantly -- see its doc comment), so a caller that needs
 * embeddings to have actually completed before proceeding (e.g. a test asserting on embed_sha, or
 * one that closes the index DB right after draining and would otherwise race a queued embed call
 * that hasn't even opened its DB connection yet) can await this instead of guessing at timing.
 */
export function pendingEmbeddings(): Promise<unknown> {
  return Promise.allSettled([...inFlightEmbeddings.values()])
}

/**
 * Global concurrency gate for embedding pipelines across ALL files, honoring
 * `config.worker.max_pool_workers`. {@link inFlightEmbeddings} only serializes duplicate work on
 * the SAME file -- a dirty batch of N distinct changed files previously fired N concurrent
 * `indexFileEmbeddings` transformer-inference pipelines with no cap at all, which can spike
 * CPU/memory proportionally to batch size. `activeEmbedSlots` tracks how many pipelines are
 * currently running; `embedSlotWaiters` holds resolvers for callers queued behind the cap, woken
 * one at a time (FIFO) as slots free up in {@link makeReleaseEmbedSlot}.
 */
let activeEmbedSlots = 0
const embedSlotWaiters: Array<() => void> = []

/**
 * Bumped by the reset below. A release closure carries the epoch it was created under, so an embed
 * that was already running when the reset fired cannot decrement the counter the reset just zeroed.
 */
let embedSlotEpoch = 0

/** Release a slot claimed inline in {@link embedFileSerialized}, waking the next queued waiter. */
function makeReleaseEmbedSlot(): () => void {
  const epoch = embedSlotEpoch
  return () => {
    // A pre-reset embed settling after the reset used to decrement the fresh counter, taking it
    // negative -- and a negative count means `activeEmbedSlots < limit` stays true for one extra
    // caller per stale task, so the global cap this gate exists to enforce was quietly loosened
    // for the rest of the process. The dispatch it belonged to is gone; its release is too.
    if (epoch !== embedSlotEpoch) return
    activeEmbedSlots -= 1
    const next = embedSlotWaiters.shift()
    if (next) next()
  }
}

// This counter is intentionally a single process-wide value (not scoped per-file or per-dir like inFlightEmbeddings/lastKnownProjectRoots above) since the concurrency cap it enforces is a real, global daemon-lifetime resource limit. That also means it can leak across test cases that dispatch a real (unresolved-by-test-end) embed call without awaiting it to settle -- register it with the shared reset registry so tests can restore a clean slate via clearModuleCaches() rather than each test needing its own bespoke workaround.
registerReset(() => {
  embedSlotEpoch += 1
  activeEmbedSlots = 0
  embedSlotWaiters.length = 0
  // inFlightEmbeddings has to go with them. A call that arrived while the cap was full returns a
  // promise whose only way to settle is the closure sitting in embedSlotWaiters, so dropping that
  // array orphans the promise for good: its `.finally` never runs, its map entry never clears, and
  // pendingEmbeddings() -- which waits on exactly those values -- never resolves. Clearing the map
  // is what makes the "clean slate" above true rather than only true for the counter.
  inFlightEmbeddings.clear()
})

/**
 * Run {@link indexFileEmbeddings} for `absPath`, serialized against any other in-flight embed
 * call for the same path (see {@link inFlightEmbeddings}) AND capped globally across all files by
 * {@link acquireEmbedSlot}/{@link makeReleaseEmbedSlot}. Errors are swallowed (mirrors the
 * `.catch(() => undefined)` the direct call used before this wrapper existed) so one failed
 * embed never breaks the chain for the next caller.
 */
function embedFileSerialized(absPath: string, dbPath: string, sha: string): Promise<unknown> {
  const key = foldPath(absPath)
  const prior = inFlightEmbeddings.get(key)
  const dir = path.dirname(dbPath)
  // Unlike a parse failure (logged via logIndexFailure/INDEX_FAILED above), indexFileEmbeddings swallows its own errors internally with no log path at all -- and the background daemon runs with stdio: 'ignore' (see startDetachedWorker), so a thrown embedding error previously produced zero observable trace anywhere. Route it through the same worker-errors.log appendWorkerErrorLog uses for indexing failures so it is at least discoverable after the fact, instead of vanishing silently.
  const onEmbedError = (err: unknown): void => {
    const message = extractErrorMessage(err)
    appendWorkerErrorLog(dir, `${new Date().toISOString()} indexFileEmbeddings failed for ${absPath}: ${message}\n`)
  }
  // Defensive fallback (matches config.ts's own default of 4): several existing tests in this file mock loadConfig() with only a partial `{ worker: { blocked_roots: [...] } }` shape (see makeIndexer's embeddingsEnabled comment above for the same pattern), so a bare `.max_pool_workers` here would be `undefined` for those and silently block every embed call forever (0 < undefined is false, so nothing would ever dispatch or queue). loadConfig() always returns a fully-populated, schema-validated config object in production.
  const limit = loadConfig().worker.max_pool_workers ?? 4
  // Dispatches the actual embed call once a global slot is available, releasing it as soon as that call settles (success or failure) so it frees up for the next queued file regardless of outcome. Release is attached as a sibling `.then(release, release)` on the SAME promise `indexFileEmbeddings` returns (rather than wrapped via `.finally()` into a new promise that `runEmbed` then returns) so it costs no extra microtask hop on the chain the rest of this function builds on top of `runEmbed()`'s return value -- preserving indexFileEmbeddings' previous direct-call timing (including for tests that assert on it without awaiting extra ticks) for the common case where a slot is immediately free. Only when the global cap is already saturated does this queue in embedSlotWaiters, deferring dispatch until a running embed elsewhere finishes and calls its release closure.
  const dispatchEmbed = (): Promise<unknown> => {
    const result = indexFileEmbeddings(absPath, dbPath, sha, onEmbedError)
    const release = makeReleaseEmbedSlot()
    result.then(release, release)
    return result
  }
  const runEmbed = (): Promise<unknown> => {
    if (activeEmbedSlots < limit) {
      activeEmbedSlots += 1
      return dispatchEmbed()
    }
    return new Promise<unknown>((resolve) => {
      embedSlotWaiters.push(() => {
        activeEmbedSlots += 1
        resolve(dispatchEmbed())
      })
    })
  }
  const chained = (prior === undefined ? runEmbed() : prior.then(runEmbed)).catch(() => undefined)
  inFlightEmbeddings.set(key, chained)
  void chained.finally(() => {
    // Only clear the slot if nothing newer has been chained onto it since -- otherwise this `finally` (from an OLDER call resolving after a NEWER one already replaced the map entry) would delete the newer call's still-in-flight tracking.
    if (inFlightEmbeddings.get(key) === chained) inFlightEmbeddings.delete(key)
  })
  return chained
}

/**
 * Append one failure line to the error log for `dir`. Best-effort: a failure to write the log
 * itself must not throw back out of the indexer's own catch handler.
 */
function appendWorkerErrorLog(dir: string, line: string): void {
  try {
    fs.appendFileSync(workerErrorLogPath(dir), line)
  } catch {
    // best-effort: nothing more we can do if even the log write itself fails.
  }
}

function logIndexFailure(dir: string, absPath: string, err: unknown): void {
  const message = extractErrorMessage(err)
  appendWorkerErrorLog(dir, `${new Date().toISOString()} indexFileSync failed for ${absPath}: ${message}\n`)
}

// A dirty path that exists (fs.existsSync true) but whose fingerprintFile call returns null is a transient read failure -- a lock held by an AV scanner/editor/OneDrive sync, a permission error, or a race with an external writer -- not a permanent parse/index error. Before this fix, processDirtyBatch silently `continue`d past it: the path was dropped from this batch and, once drainOnce unconditionally clears the .draining marker right after processDirtyBatch returns, it was gone for good with no log entry and no way to retry it short of the file being touched again. Log it distinctly from an indexing failure and requeue it so the next drain cycle gets another chance once the lock clears.
function logTransientReadFailure(dir: string, absPath: string): void {
  appendWorkerErrorLog(
    dir,
    `${new Date().toISOString()} fingerprintFile returned null for existing file ${absPath} (transient read failure -- requeued for retry)\n`,
  )
}

// Bumps the transient-retry count for `absPath` and decides whether it is still within its retry budget. Returns true when the caller should go on to actually requeue the path (append it to a dirty queue); false once MAX_TRANSIENT_RETRIES has been exceeded (logging the give-up message exactly once, on the cycle the cap is first exceeded). Split out of the old requeueDirtyPath so drainOnce can bump the retry counter immediately (once per real failure) while deferring the actual queue-file append -- see drainOnce's stage (a)/(b) doc comment for why the append must not land in the SAME cycle's live queue.
function bumpAndCheckRetry(dir: string, absPath: string): boolean {
  const dbPath = path.join(dir, 'global.db')
  const attempts = bumpRetryCount(dbPath, absPath)
  if (attempts > MAX_TRANSIENT_RETRIES) {
    // Permanently stuck (e.g. a read lock that never clears): stop requeuing so this path doesn't get hammered every single drain cycle forever. Log exactly once -- on the cycle the cap is first exceeded, not on every subsequent cycle -- so the failure is visible without spamming the log. A future edit to this path re-dirties it through the normal queue-append path (not this function), which gives it a fresh retry budget.
    if (attempts === MAX_TRANSIENT_RETRIES + 1) {
      appendWorkerErrorLog(
        dir,
        `${new Date().toISOString()} giving up on ${absPath} after ${MAX_TRANSIENT_RETRIES} consecutive transient read failures -- no longer retrying automatically (will retry again if the file changes)\n`,
      )
    }
    return false
  }
  return true
}

// Appends `absPath` to the live dirty queue. Mirrors appendDirtyPath's crash-safe append (mkdir + torn-last-line guard) in hooks_index.ts, but is parameterized by `dir` (rather than hardcoding dataDir()) so it targets the same queue processDirtyBatch/drainOnce were given -- including an isolated dir under test. Best-effort: if the write itself fails, the path is lost for this cycle, but the failure is still captured via logTransientReadFailure above.
function appendToDirtyQueue(dir: string, absPath: string): void {
  const queuePath = dirtyQueuePathFor(dir)
  try {
    ensureDirSync(path.dirname(queuePath))
    let leadingNewline = ''
    try {
      const existing = fs.readFileSync(queuePath, 'utf8')
      if (existing.length > 0 && !existing.endsWith('\n')) leadingNewline = '\n'
    } catch {
      // File doesn't exist yet -- nothing to guard against.
    }
    fs.appendFileSync(queuePath, `${leadingNewline}${encodeDirtyQueueLine(absPath)}\n`)
  } catch {
    // best-effort -- see doc comment above.
  }
}

// Re-adds `absPath` to the live dirty queue after a transient read failure. This is the default `requeue` callback processDirtyBatch uses outside of drainOnce (e.g. direct callers/tests); drainOnce itself injects a callback that defers the appendToDirtyQueue half -- see its doc comment for why.
function requeueDirtyPath(dir: string, absPath: string): void {
  if (bumpAndCheckRetry(dir, absPath)) appendToDirtyQueue(dir, absPath)
}

/**
 * Build the index callback the drain loop uses by default: parse each changed
 * file and write its symbol/ref rows into the index DB at `dbPath`. A parse or
 * read failure on one file is swallowed so a single bad file never aborts the
 * batch or crashes the drain loop -- but the failure is logged to
 * {@link workerErrorLogPath} and signalled via the {@link INDEX_FAILED} sentinel so
 * `processDirtyBatch` never counts it as a successful index. The file's `files.sha` row is left
 * exactly as it was before this attempt, so if the file is ever touched again the sha-gate below
 * will not match its (still un-indexed) content and a reindex will be retried automatically.
 */
export function makeIndexer(dbPath: string): (absPath: string, sha: string) => unknown {
  const dir = path.dirname(dbPath)
  return (absPath, sha) => {
    try {
      // Skip-eligibility must be checked UNCONDITIONALLY, before the parseUnchanged sha-gate: a file that becomes skip-eligible purely from a config change (same sha) would otherwise never reach indexFileSync's purge at all, leaving symbols/refs/files rows stale forever. Guard on ixCfgForSkip !== undefined for tests that mock loadConfig with a partial { worker: {...} } shape.
      const ixCfgForSkip = loadConfig().indexing
      if (ixCfgForSkip !== undefined && isParseSkipEligible(absPath, ixCfgForSkip)) {
        // Purging stale rows is real work: unlike the `false` sha-gate skip below, this must
        // count as "indexed" in processDirtyBatch's tally.
        removeFileFromIndex(getDb(dbPath), absPath)
        return true
      }
      const entry = getFileEntry(absPath, dbPath)
      // Skip the syntactic reparse when content is byte-identical to what's already indexed
      // (same fingerprint) so a touched-but-unchanged file is not needlessly reparsed.
      // ...and not when the row's own spelling has gone stale under a case-only rename, which
      // leaves the content identical and would otherwise pin the old spelling in place forever.
      // See indexedPathSpellingIsStale.
      const parseUnchanged =
        entry?.sha === sha && !(entry !== null && indexedPathSpellingIsStale(entry.filePath, absPath))
      if (!parseUnchanged) {
        indexFileSync(absPath, dbPath)
      }
      // Embedding freshness is gated INDEPENDENTLY of parse freshness (files.embed_sha, set only after indexFileEmbeddings actually commits -- see its doc comment in parser.ts). If a prior embedding attempt crashed or threw before stamping embed_sha, the parse-sha gate above would otherwise mask that forever: identical content would keep skipping the reparse AND skip re-embedding, leaving chunks permanently stale/missing. Re-check embed_sha against the current sha every time, even when the parse gate above skipped. While embeddings are currently disabled, indexFileEmbeddings stamps embed_sha with disabledEmbedSha(sha) instead of the bare sha (see its doc comment) so this gate can still hold and avoid re-entering indexFileEmbeddings on every drain of an unchanged file -- but a bare-sha match must never satisfy the gate while disabled, or a file that was only ever marker-stamped (never actually embedded) would look "unchanged" the instant embeddings are re-enabled, permanently skipping its real first embed. Optional chaining/fallback here is a defensive test-mock safety net, not a real production path: loadConfig() always returns a fully-populated, schema-validated config object in production. Several existing tests in this file mock loadConfig() with only a partial `{ worker: {...} }` shape (they exercise unrelated gates), so a bare `.indexing.embeddings_enabled` here would throw for those. Default to enabled (true), matching config.ts's own default, so this new gate check is a no-op for tests that never cared about embeddings.
      const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true
      // depsAvailable lets isEmbedFresh distinguish a file that was skipped only because the optional embedding deps were absent (stamped an `unavailable:` marker) from one that was really embedded: the marker stays "fresh" while deps are still missing, but forces a re-embed the moment the model + sqlite-vec become usable.
      const depsAvailable = embeddingsEnabled && embeddingsDepsAvailable(getDb(dbPath))
      const embedUnchanged =
        parseUnchanged && isEmbedFresh(entry?.embedSha, sha, embeddingsEnabled, depsAvailable)
      if (embedUnchanged) {
        // Nothing to do at all: parse and embeddings are both already current for this content.
        return false
      }
      // Embeddings are fired and forgotten here, never awaited: the worker's drain loop is synchronous by design (drainOnce/processDirtyBatch must return instantly so the dirty queue clears promptly), and chunk/vector freshness can safely lag a beat behind symbol freshness since semantic search tolerates staleness in a way exact symbol lookups do not. indexFileEmbeddings already swallows its own errors internally, and embedFileSerialized ends its chain with a .catch so the promise returned here can never reject -- that backstop lives there, not on this line, and removing it would leave this un-awaited call able to take the daemon down with an unhandled rejection. Returning the promise (rather than voiding it) lets a caller that wants to - such as a test - await it explicitly instead of racing it. Routed through embedFileSerialized so two overlapping drains of the same rapidly re-edited file chain onto one another instead of racing -- see its doc comment for the stale-overwrite bug this closes.
      return embedFileSerialized(absPath, dbPath, sha)
    } catch (err) {
      // One bad file must not abort the rest of the batch -- but a swallowed failure must not be
      // silently indistinguishable from a successful index either. See the doc comment above.
      logIndexFailure(dir, absPath, err)
      return INDEX_FAILED
    }
  }
}

// Build the remove callback the drain loop uses by default: drop the index rows and embedding chunks for a path whose file has vanished from disk, reconciling deletions. A failure on one path is swallowed so a single bad delete never aborts the batch or crashes the drain loop.
function makeRemover(dbPath: string): (absPath: string) => void {
  return (absPath) => {
    try {
      removeFileFromIndex(getDb(dbPath), absPath)
    } catch {
      // One failed delete must not abort the rest of the batch.
    }
  }
}

/**
 * Process one batch of dirty paths.
 *
 * For each path: skip if the file no longer exists or cannot be fingerprinted,
 * otherwise re-index it. The default `index` callback parses the file and
 * writes its rows into the global index DB; tests inject their own callback to
 * observe the plumbing in isolation. Returns the number of paths actually
 * (re)indexed -- a path whose callback returns `false` (the default indexer's
 * sha-gate skip for byte-identical content) or `INDEX_FAILED` (the default
 * indexer's sentinel for a swallowed, logged indexing failure -- see
 * makeIndexer) is visited but not counted.
 *
 * Exported for unit tests so the drain logic can be exercised without a thread.
 */
export function processDirtyBatch(
  paths: string[],
  index: (absPath: string, sha: string) => unknown = makeIndexer(globalDbPath()),
  remove: (absPath: string) => void = makeRemover(globalDbPath()),
  dir: string = dataDir(),
  requeue: (dir: string, absPath: string) => void = requeueDirtyPath,
): number {
  const blockedRoots = loadConfig().worker.blocked_roots
  // Memoizes findProject(dirname) for this batch only -- findProject re-runs a full ancestor-marker probe (9 markers x existsSync/lstat per level) plus isRepoContainer's readdirSync on every call, and a batch routinely contains many dirty paths under the same directory (or same project tree) that would otherwise repeat that walk once per path for a result (lastKnownProjectRoots) that is only consulted once per PRUNE_EVERY_N_DRAINS drains. Scoped to this function call (not module-level) since a project root learned from one batch's traffic can legitimately go stale by the next batch (e.g. after a project is deleted).
  const projectRootCache = new Map<string, string | null>()
  let indexed = 0
  for (const p of paths) {
    if (!p) continue
    writeDrainHeartbeat(dir)
    // worker.blocked_roots (set via `token-goat project exclude`) excludes a path prefix from reindexing entirely -- skip before the existence/sha checks so a blocked path is never touched, not even pruned from the index if it happens to have been deleted underneath it.
    if (isUnderBlockedRoot(p, blockedRoots)) continue
    // A dirty path whose file is gone is a deletion to reconcile, not a no-op: prune its stale rows instead of skipping, otherwise `symbol Foo` resolves a deleted file forever. fileIsAbsent, not fs.existsSync: existsSync answers false for a locked or permission-denied file exactly as it does for a missing one, so a file held open by an AV scanner or sitting behind a deny ACE would have had its symbols, references, sections and embedding chunks deleted while it was still on disk -- silently, and with no way back until something edited it again. That is the same class of transient failure the fingerprint branch immediately below already logs and requeues, so an unreadable file now falls through to it instead of being pruned.
    if (fileIsAbsent(p)) {
      remove(p)
      continue
    }
    const sha = fingerprintFile(p)
    if (sha === null) {
      // The file exists but couldn't be read right now (lock/permission/race) -- see
      // logTransientReadFailure's doc comment. Log and requeue instead of silently dropping it.
      logTransientReadFailure(dir, p)
      requeue(dir, p)
      continue
    }
    // The read succeeded -- clear any transient-retry count from a prior failure streak so a later failure on this same path (e.g. after a fresh edit) starts from a full budget instead of resuming a much earlier streak (see requeueDirtyPath / bumpRetryCount).
    clearRetryCount(path.join(dir, 'global.db'), p)
    // Opportunistically learn the active project root from this batch's traffic -- see lastKnownProjectRoots' doc comment for why this global, path-keyed queue has no other standing notion of "the current project" for drainOnce's periodic prune sweep to target.
    try {
      const dirname = path.dirname(p)
      let root: string | null
      if (projectRootCache.has(dirname)) {
        root = projectRootCache.get(dirname) ?? null
      } else {
        const project = findProject(dirname)
        root = project?.root ?? null
        projectRootCache.set(dirname, root)
      }
      if (root) lastKnownProjectRoots.set(dir, root)
    } catch {
      // best-effort signal only -- never let project-root discovery abort a real index.
    }
    // `false` means the sha-gate skipped a no-op reindex; INDEX_FAILED means the default indexer's catch swallowed a genuine failure (logged separately -- see makeIndexer). Any other return value (including void/undefined from callers that don't bother returning anything) counts as indexed.
    const result = index(p, sha)
    if (result !== false && result !== INDEX_FAILED) indexed += 1
  }
  return indexed
}

/** Synchronous 50ms sleep for the Windows rename-retry loop (mirrors Python's time.sleep(0.05)). Uses Atomics.wait on a SharedArrayBuffer to block without spinning; silently skips on platforms where SAB is unavailable. */
function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // SAB unavailable or other atomics error: skip sleep
  }
}

/**
 * Run one drain cycle for `dir`: atomically claim the dirty queue, process it.
 *
 * Atomically renames the live queue to a .draining file so that concurrent
 * appendDirtyPath calls either land before the rename (and travel with it) or
 * recreate a fresh queue after it (picked up on the next poll). This is the
 * Python original's rename-to-claim pattern, preventing lost updates.
 *
 * Recovers from crashes by absorbing an abandoned .draining file at startup.
 * On Windows, rename can fail with EPERM if the file is open for append; the
 * loop retries 5 times with 50ms sleeps before deferring (returning 0).
 *
 * Each stage's claimed/recovered file is only cleared (rm'd or quarantined)
 * AFTER its batch has been durably processed by {@link processDirtyBatch} --
 * never before. If the process dies partway through a batch (SIGTERM, a
 * crash, or this daemon being killed as a duplicate after losing the
 * {@link claimWorkerPidFile} startup race), the .draining file is still on
 * disk for the next startup's crash recovery to pick back up, instead of
 * having already been deleted while the paths it named were never indexed.
 *
 * Returns the number of paths processed. When no `index` callback is injected,
 * files are indexed into `dir`'s `global.db` (the real shipping path); in
 * production `dir` is the data dir, so this is {@link globalDbPath}.
 */
export function drainOnce(
  dir: string,
  index?: (absPath: string, sha: string) => unknown,
  remove?: (absPath: string) => void,
): number {
  const queuePath = dirtyQueuePathFor(dir)
  const draining = `${queuePath}.draining`
  const dbPath = path.join(dir, 'global.db')
  const indexFn = index ?? makeIndexer(dbPath)
  const removeFn = remove ?? makeRemover(dbPath)
  let processed = 0

  // A transient read failure in stage (a) (recovering an abandoned .draining file) must not be requeued straight onto the live dirty.txt: stage (b) below claims that same live queue microseconds later, in this SAME drainOnce call, and would immediately reprocess the path while the lock/condition that caused the original failure has almost certainly not cleared yet -- double-bumping its retry count once per cycle instead of once, roughly halving the effective MAX_TRANSIENT_RETRIES budget. Collect this cycle's requeues here and only write them to the live queue once BOTH stages have finished claiming/processing their batches, so a requeued path is guaranteed to wait for the NEXT drainOnce cycle. bumpAndCheckRetry (which increments the retry counter and enforces MAX_TRANSIENT_RETRIES) still runs immediately, at the point of failure -- only the disk append is deferred.
  const deferredRequeues: string[] = []
  const requeueFn = (requeueDir: string, absPath: string): void => {
    if (bumpAndCheckRetry(requeueDir, absPath)) deferredRequeues.push(absPath)
  }

  // (a) Crash recovery: absorb any `.draining` (and `.draining.alt-*` fallback) files abandoned by a previous crashed or stuck drain. Multiple files can accumulate when a Windows sharing violation keeps the primary `.draining` name locked across cycles (see stage (b)'s fallback-claim comment) -- recover every one of them, not just the first, so a single stuck file can never starve the rest of the queue from ever draining.
  const liveDrainingFiles = listDrainingFiles(queuePath)
  // Drop snapshots for draining files that no longer exist. An entry is only added when both cleanup attempts failed, and is otherwise removed when its file is cleared -- but a file deleted or quarantined by anything else leaves its entry behind forever, so the map grows without bound across cycles and each value holds a whole queue file's contents. A stale entry is also wrong, not merely large: if a later cycle recreates the same draining name with byte-identical content, the leftover snapshot makes the guard below skip a batch that was never processed.
  const liveDrainingSet = new Set(liveDrainingFiles)
  for (const key of unclearedDrainingSnapshots.keys()) {
    if (!liveDrainingSet.has(key) && key.startsWith(`${queuePath}.draining`)) unclearedDrainingSnapshots.delete(key)
  }
  for (const drainingFile of liveDrainingFiles) {
    let drainingContent: string | null = null
    // A read failure here is not proof the file is corrupt: on Windows an antivirus scan or another process holding the file open fails the read while a rename still succeeds, and quarantining on the first failure loses every path the file named, permanently -- listDrainingFiles excludes `.corrupt-` names from recovery and cleanupWorkerStateFiles deletes them after 30 days. Retry on the same schedule stage (b) uses for its claim rename before concluding the file is genuinely unreadable.
    for (let attempt = 0; attempt < DRAINING_READ_ATTEMPTS; attempt++) {
      try {
        drainingContent = fs.readFileSync(drainingFile, 'utf8')
        break
      } catch {
        if (attempt < DRAINING_READ_ATTEMPTS - 1) sleepSyncMs(DRAINING_READ_RETRY_DELAY_MS)
      }
    }
    if (drainingContent === null) {
      // Still unreadable after every retry: quarantine so it cannot collide with a future claim, then skip it this cycle.
      try {
        fs.renameSync(drainingFile, `${drainingFile}.corrupt-${Date.now()}`)
        // The file is gone under its old name, so any snapshot keyed to it now describes a path that no longer exists.
        unclearedDrainingSnapshots.delete(drainingFile)
      } catch {
        // best effort
      }
      continue
    }
    // Only process this content if it was not already folded into a batch on a prior cycle (see unclearedDrainingSnapshots below). Without this guard, a draining file that outlives both cleanup attempts (e.g. a persistent Windows sharing violation) would be re-read and its paths reprocessed on every cycle.
    if (unclearedDrainingSnapshots.get(drainingFile) !== drainingSnapshotStamp(drainingFile, drainingContent)) {
      processed += processDirtyBatch(parseDirtyQueueLines(drainingContent), indexFn, removeFn, dir, requeueFn)
    }
    // Only clear the recovered file now that its batch has been durably processed (or recognized above as already processed) -- never before -- so a crash partway through processDirtyBatch leaves the file in place for the next startup to recover, instead of deleting it up front and losing every path it named.
    try {
      fs.rmSync(drainingFile, { force: true })
      unclearedDrainingSnapshots.delete(drainingFile)
    } catch {
      try {
        fs.renameSync(drainingFile, `${drainingFile}.corrupt-${Date.now()}`)
        unclearedDrainingSnapshots.delete(drainingFile)
      } catch {
        // Both cleanup attempts failed and the file is still stuck: remember exactly what we already folded into this cycle's batch so the next cycle can retry cleanup without reprocessing the same paths again.
        unclearedDrainingSnapshots.set(drainingFile, drainingSnapshotStamp(drainingFile, drainingContent))
      }
    }
  }

  // (b) Atomically claim the live queue. A concurrent appendDirtyPath either landed before the rename (its line travels in .draining) or recreates a fresh dirty.txt after it (next cycle) — it can never be deleted unindexed. On Windows a concurrent open-for-append can make rename fail with EPERM/ EBUSY/EEXIST; retry a few times, then defer (return 0 = retry next poll).
  if (fs.existsSync(queuePath)) {
    // If the primary `.draining` name is still occupied by a file the loop above could not clean up (both rmSync and rename-to-corrupt failed -- typically a Windows sharing violation from something else holding it open), claiming into that same name would collide forever and starve the live queue indefinitely. Claim into a distinct `.alt-<ts>` name instead; listDrainingFiles recovers it on a future cycle.
    const claimTarget = fs.existsSync(draining) ? `${draining}.alt-${Date.now()}` : draining
    let claimed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(queuePath, claimTarget)
        claimed = true
        break
      } catch {
        sleepSyncMs(50)
      }
    }
    if (claimed) {
      let claimedContent = ''
      let readOk = false
      try {
        claimedContent = fs.readFileSync(claimTarget, 'utf8')
        readOk = true
      } catch {
        // read failure is fail-soft: leave the claimed file in place; the next cycle's stage
        // (a) crash recovery will pick it up.
      }
      if (readOk) {
        // Deliberately NOT wrapped in the try above: a throw from processDirtyBatch (e.g. the process crashing mid-batch) must propagate to the caller, not be swallowed as a "read failure", so the cleanup below never runs and the claimed file survives.
        processed += processDirtyBatch(parseDirtyQueueLines(claimedContent), indexFn, removeFn, dir, requeueFn)
        // Re-read the claimed file ONE more time, right before deleting it, to catch a path appended by a writer that raced the claim-rename above. The rename-to-claim pattern assumes no other writer can touch the live queue's underlying file once it has been renamed to the claim target -- but that isn't guaranteed on Windows (FILE_SHARE_DELETE lets a concurrent open-for-append follow the same underlying file object across the rename) or on POSIX (a narrow rename/open race exists there too). A dirty path appended during that window would otherwise be silently deleted along with the rest of this cycle's already-processed content and never reindexed. Forward anything found beyond what was already processed back into the live queue so the next drain cycle picks it up.
        try {
          const recheck = fs.readFileSync(claimTarget, 'utf8')
          if (recheck !== claimedContent) {
            const extra = recheck.startsWith(claimedContent) ? recheck.slice(claimedContent.length) : recheck
            for (const p of parseDirtyQueueLines(extra)) appendToDirtyQueue(dir, p)
          }
        } catch {
          // best-effort recheck -- if the claimed file vanished or became unreadable between
          // the read above and now, there is nothing more we can safely recover here.
        }
        // Only clear the claimed file now that its batch has been durably processed -- never before -- so a crash partway through processDirtyBatch leaves it in place for stage (a) to recover on the next startup instead of losing the paths it named.
        try {
          fs.rmSync(claimTarget, { force: true })
        } catch {
          try {
            fs.renameSync(claimTarget, `${claimTarget}.corrupt-${Date.now()}`)
          } catch {
            // Both cleanup attempts failed: record it the same way stage (a) does, so a leftover file here is recognized as already-processed (and not silently reprocessed) by stage (a)'s crash recovery on the next cycle.
            unclearedDrainingSnapshots.set(claimTarget, drainingSnapshotStamp(claimTarget, claimedContent))
          }
        }
      }
    }
    // If the claim-rename never succeeded after 5 retries, the live queue is left untouched
    // and will be retried on the next poll cycle.
  }

  // (c) Opportunistic prune sweep for renamed/deleted files that never enqueued via the Edit hook path (git mv, git checkout, git clean). Runs after all normal dirty-queue work above, on a low cadence (see PRUNE_EVERY_N_DRAINS' doc comment), so it never delays draining the queue itself and a slow sweep on a huge repo only pushes out the NEXT sweep's schedule, not this cycle's already-completed dirty-queue work.
  const cycle = (drainCycleCounts.get(dir) ?? 0) + 1
  drainCycleCounts.set(dir, cycle)
  if (cycle % PRUNE_EVERY_N_DRAINS === 0) {
    const root = lastKnownProjectRoots.get(dir)
    if (root !== undefined) {
      try {
        pruneDeletedFiles(root, dbPath)
      } catch {
        // Best-effort housekeeping; a prune failure must not kill the drain loop.
      }
    }
  }

  // Now that both stages above have finished claiming/processing their batches for this cycle, it is safe to actually append this cycle's transient-failure requeues to the live queue -- see deferredRequeues' doc comment above for why this must happen last.
  for (const p of deferredRequeues) appendToDirtyQueue(dir, p)

  // Touch the heartbeat marker last even when the queue was empty, and keep it fresh during
  // long batches through processDirtyBatch.
  writeDrainHeartbeat(dir, true)

  return processed
}

/** Is `pid` a live process? Uses signal 0 (probe) — no signal is delivered. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Read the pid recorded in the worker pid file, or null when absent/malformed.
 */
function readPidFile(dir: string): number | null {
  try {
    const raw = fs.readFileSync(workerPidPath(dir), 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    return parseInt(raw, 10)
  } catch {
    return null
  }
}

/**
 * Is a detached worker currently running for this project?
 *
 * True only when the pid file names a live process that has recently written a
 * PID-bound heartbeat. This rejects a stale PID whose number was reused by an
 * unrelated process.
 */
export function isWorkerRunning(dir: string = dataDir()): boolean {
  const pid = readPidFile(dir)
  if (pid === null) return false
  return pidAlive(pid) && hasFreshWorkerHeartbeat(dir, pid)
}

/** Absolute path to the auto-heal rate-limit marker for `dir`. */
function workerHealthCheckMarkerPath(dir: string): string {
  return path.join(dir, 'worker-healthcheck.marker')
}

/**
 * Minimum time between {@link ensureWorkerAlive} liveness checks, so a burst of edit-hook calls
 * (e.g. a multi-file refactor) doesn't re-check the pid file and attempt a respawn on every
 * single one -- one check per interval is enough to notice and heal a dead daemon promptly.
 */
const WORKER_HEALTHCHECK_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * Best-effort auto-heal: if the detached worker for `dir` isn't running, start a fresh one.
 *
 * Before this, {@link startDetachedWorker} was only ever invoked from the `worker start` CLI
 * command -- nothing anywhere restarted a daemon that died (crash, a manual `taskkill`, machine
 * sleep/wake races, anything). A dead worker stayed dead indefinitely: the dirty queue kept
 * accumulating, `token-goat read`/`symbol`/`section`/`outline` kept serving stale index content
 * with no automatic recovery, until a human happened to notice and ran `worker start` by hand.
 *
 * Called from {@link postEditHandler in hooks_edit.ts}, the hot path where real work is actually
 * queued for the worker to drain, self-rate-limited via a marker-file mtime ({@link
 * WORKER_HEALTHCHECK_MIN_INTERVAL_MS}) so it isn't re-triggered on every hook call. Fail-soft
 * throughout: marker-file I/O errors, spawn failures, and a lost {@link claimWorkerPidFile} race
 * against a worker that started in the same instant are all swallowed -- this function's job is
 * to nudge a dead worker back to life, never to guarantee one is running or to throw out of a
 * hook handler.
 */
export function ensureWorkerAlive(dir: string = dataDir()): void {
  // Test-isolation escape hatch: this is the one auto-heal path that fires as an incidental side
  // effect of exercising unrelated code (any test that drives postEditHandler), not a deliberate
  // "test worker spawning" call -- without this, every such test spawned a REAL detached daemon
  // child process, relying only on that daemon's own data-dir-deleted self-check to eventually
  // notice and exit rather than never spawning it in the first place. tests/setup/isolate-home.ts
  // pins TOKEN_GOAT_NO_WORKER_SPAWN='1' for exactly this reason; a test that deliberately wants
  // real spawning through this function (worker.test.ts's own ensureWorkerAlive suite) opts back
  // out by setting the var itself, the same override pattern used for the harness/embeddings
  // pins. Never gates startDetachedWorker itself -- the explicit `worker start` CLI command and
  // dedicated daemon e2e tests call that directly and must still spawn for real.
  if (process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] === '1') return
  const markerPath = workerHealthCheckMarkerPath(dir)
  try {
    const stat = fs.statSync(markerPath)
    if (Date.now() - stat.mtimeMs < WORKER_HEALTHCHECK_MIN_INTERVAL_MS) return
  } catch {
    // No marker yet: first check ever for this data dir, proceed.
  }
  try {
    ensureDirSync(dir)
    fs.writeFileSync(markerPath, '')
  } catch {
    // If we can't even write the marker, don't let that block the liveness check below --
    // worst case we just check more often than intended.
  }
  if (isWorkerRunning(dir)) return
  try {
    startDetachedWorker({ dataDir: dir })
  } catch (e) {
    if (e instanceof WorkerAlreadyRunningError) return
    try {
      appendWorkerErrorLog(
        dir,
        `${new Date().toISOString()} ensureWorkerAlive: auto-restart failed: ${extractErrorMessage(e)}\n`,
      )
    } catch {
      // best-effort
    }
  }
}

/**
 * Kill the detached worker for this project, if one is running.
 *
 * Returns true when a live worker was found and signalled; false when no pid
 * file existed or the recorded pid was already dead. The pid file is removed in
 * both the killed and stale cases so the slate is clean afterwards.
 */
export function stopWorker(dir: string = dataDir()): boolean {
  const pid = readPidFile(dir)
  if (pid === null) return false
  const running = isWorkerRunning(dir)
  if (running) {
    try {
      process.kill(pid)
    } catch {
      // Race: process exited between the check and the kill. Fall through to pid-file cleanup; report whatever liveness we observed.
    }
  }
  // Only remove the pid file when it still names the pid we just killed -- never unconditionally. A concurrent `worker start` can observe the killed pid as dead and reclaim the slot (via claimWorkerPidFile) with a brand-new daemon's pid between our kill above and this cleanup; an unconditional rmSync here would delete that new daemon's pid file out from under it, orphaning it (no pid file left for a later stopWorker to find), which a subsequent `worker start` would then "fix" by spawning a third daemon -- two live daemons draining the same queue. Same guard style as the exit handler in runDetachedWorkerDaemon.
  if (readPidFile(dir) === pid) {
    try {
      fs.rmSync(workerPidPath(dir), { force: true })
    } catch {
      // best-effort cleanup
    }
  }
  return running
}

/**
 * Thrown by {@link startDetachedWorker} when it loses the {@link claimWorkerPidFile} startup
 * race to a daemon that already holds the pid-file slot (a genuine already-running worker, or a
 * concurrent `worker start` invocation that won the race first).
 */
export class WorkerAlreadyRunningError extends Error {
  constructor(message = 'worker already running') {
    super(message)
    this.name = 'WorkerAlreadyRunningError'
  }
}

/**
 * Atomically claim the worker pid file for `pid`, closing the TOCTOU race where two
 * near-simultaneous `worker start` invocations could otherwise both pass an
 * {@link isWorkerRunning} pre-check and then unconditionally overwrite each other's pid file --
 * orphaning whichever daemon lost, with no pid file left pointing at it for a later
 * {@link stopWorker} to find.
 *
 * Uses exclusive-create (`wx`) so only one writer can ever create the file fresh; a losing
 * writer sees `EEXIST` instead of silently clobbering the winner's entry, and then checks
 * whether the pid already recorded there is a live process:
 *
 *   - alive: refuse -- a real daemon already holds the slot. Returns false.
 *   - dead/stale/unreadable: safe to reclaim -- remove the stale file and retry the exclusive
 *     create once.
 *
 * Exported for tests; the boolean return lets {@link startDetachedWorker} decide whether to kill
 * the child process it just spawned when it loses the race.
 */
export function claimWorkerPidFile(dir: string, pid: number): boolean {
  const pidPath = workerPidPath(dir)
  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const existingPid = readPidFile(dir)
  if (
    existingPid !== null
    && pidAlive(existingPid)
    && (hasFreshWorkerHeartbeat(dir, existingPid) || pidFileIsWithinStartupGrace(dir))
  ) {
    return false
  }
  // Stale, dead, or unreadable: reclaim the slot.
  if (existingPid !== null && pidAlive(existingPid) && existingPid !== pid && existingPid !== process.pid) {
    try {
      process.kill(existingPid, 'SIGTERM')
    } catch {
      // best-effort
    }
  }
  try {
    fs.rmSync(pidPath, { force: true })
  } catch {
    // best-effort
  }
  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { flag: 'wx' })
    return true
  } catch (e2) {
    // Lost a second, much narrower race on the reclaim retry itself: be conservative and
    // report already-running rather than clobber whoever just won it.
    if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e2
  }
}

/**
 * Spawn the drain loop as a detached child process and record its pid.
 *
 * The child runs `node <CLI entry> --worker-daemon` (see {@link daemonEntryScript}) with the poll interval and
 * data dir passed via env (a detached process cannot share `workerData`). The
 * child is `unref`'d so the launching CLI can exit immediately. Returns the
 * child pid (or throws if the spawn itself fails synchronously).
 *
 * The pid file is claimed via {@link claimWorkerPidFile} AFTER the child is spawned (a detached
 * child's real pid can't be known beforehand) but BEFORE it is `unref`'d or returned to the
 * caller: if the claim loses the race to an already-running daemon, the just-spawned duplicate
 * child is killed immediately and {@link WorkerAlreadyRunningError} is thrown, so no orphaned
 * second daemon is ever left running.
 */
/**
 * The script the daemon child must be spawned on: the CLI launcher sitting next to this module,
 * when there is one.
 *
 * `fileURLToPath(import.meta.url)` is not it, and only looked like it while the core build emitted
 * a single file. Under `splitting: true` this module's code lands in a hashed chunk, which has no
 * entrypoint of its own: spawning it starts a process that loads a library and exits without ever
 * reaching the `--worker-daemon` dispatch, so `worker start` reported a pid for a child that was
 * already dead and no drain heartbeat ever appeared. Every chunk is emitted beside the launcher,
 * so resolving it by name is stable however the bundler arranges the code, and it re-enables the
 * V8 compile cache for the child as a side benefit. Falls back to this module's own path for a
 * non-bundled (source) run, where no launcher exists beside it.
 */
function daemonEntryScript(): string {
  const self = fileURLToPath(import.meta.url)
  const launcher = path.join(path.dirname(self), 'token-goat.mjs')
  try {
    if (fs.existsSync(launcher)) return launcher
  } catch {
    // An unreadable dist dir is no reason to fail the spawn -- fall through to the module path.
  }
  return self
}

export function startDetachedWorker(opts?: WorkerOptions): number {
  const pollIntervalMs = resolvePollIntervalMs(opts?.pollIntervalMs)
  const dir = opts?.dataDir ?? dataDir()
  try {
    ensureDirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [daemonEntryScript(), '--worker-daemon'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        TG_WORKER_POLL_MS: String(pollIntervalMs),
        TG_WORKER_DATA_DIR: dir,
      },
    },
  )

  const pid = child.pid
  if (pid === undefined) {
    throw new Error('startDetachedWorker: spawn produced no pid')
  }

  if (!claimWorkerPidFile(dir, pid)) {
    try {
      process.kill(pid)
    } catch {
      // already gone
    }
    child.unref()
    throw new WorkerAlreadyRunningError()
  }

  child.unref()
  return pid
}

/**
 * The drain loop itself.
 *
 * Sleeps between cycles via a Promise + setTimeout so the thread/process stays
 * responsive to termination. `shouldStop` lets callers (and tests) break the
 * loop deterministically; in the worker-thread case it is wired to a message
 * from the parent.
 */
// How often the worker loop auto-prunes dead file rows across every known project root (see sweepKnownRoots in index_prune.ts). Deliberately much longer than SNAPSHOT_CLEANUP_INTERVAL_MS -- a full existence-check pass over every indexed file under every known root is heavier than the snapshot sweep, and dead-row accumulation is a slow-moving problem that doesn't need a tight cadence to stay bounded.
const KNOWN_ROOTS_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function runWorkerLoop(
  dir: string,
  pollIntervalMs: number,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  // Local to this loop invocation (not module-level) so each call starts its own fresh throttle window instead of sharing state across unrelated runWorkerLoop calls (e.g. across tests in the same process).
  let lastSnapshotCleanupMs = 0
  let lastKnownRootsSweepMs = 0
  while (!shouldStop()) {
    // Self-terminate once this daemon's own data dir no longer exists: a caller that spawned a
    // detached daemon against an ephemeral/scratch data dir (e.g. `token-goat index --walk` in a
    // temp directory during dogfooding or a test run) and then deletes that directory without an
    // explicit `worker stop` leaves the daemon with nothing left to poll -- `dirty.txt`/the pid
    // file/global.db are all gone, so every subsequent drainOnce/cleanup call below is pure
    // wasted work against a directory that will never come back. Without this check the daemon
    // runs forever (confirmed in practice: 524 stray `--worker-daemon` processes accumulated over
    // two weeks of dogfooding/test scratch-dir cleanup with no corresponding `worker stop`).
    if (!fs.existsSync(dir)) break
    try {
      drainOnce(dir)
    } catch {
      // A bad batch must not kill the daemon; skip and retry next cycle.
    }
    // Sweep stale session-snapshot directories on the same periodic loop as the dirty-queue drain above, so accumulating session_snapshots/<sessionId>/ dirs get cleaned up on a schedule instead of growing unbounded for the life of the daemon.
    if (Date.now() - lastSnapshotCleanupMs >= SNAPSHOT_CLEANUP_INTERVAL_MS) {
      try {
        cleanup_stale()
      } catch {
        // Best-effort housekeeping; a cleanup failure must not kill the daemon either.
      }
      // Rotate/prune the worker's own accumulating state files (worker-errors.log, .corrupt-* quarantine files) on the same periodic cadence -- see cleanupWorkerStateFiles' doc comment.
      try {
        cleanupWorkerStateFiles(dir)
      } catch {
        // Best-effort housekeeping; a cleanup failure must not kill the daemon either.
      }
      // Age out the id-keyed disk caches on the same cadence. storeBlob prunes the subdir it writes, but session state is written outside that funnel and so had no reaper at all -- see sweepCacheRoots' doc comment. `dataDir()` is passed as a second root because older versions kept these caches there.
      try {
        sweepCacheRoots([dataDir()])
      } catch {
        // Best-effort housekeeping; a cleanup failure must not kill the daemon either.
      }
      lastSnapshotCleanupMs = Date.now()
    }
    // Auto-prune dead file rows across every known project root -- see sweepKnownRoots' docstring for the safety guarantees (grace period before treating an unreachable root as gone, anomaly-ratio guard against a mount-point outage under a live root). This is what keeps the shared global.db from silently accumulating dead rows indefinitely the way it used to, when pruning only ever ran via a manually-invoked `token-goat index`.
    if (Date.now() - lastKnownRootsSweepMs >= KNOWN_ROOTS_SWEEP_INTERVAL_MS) {
      try {
        const result = sweepKnownRoots(path.join(dir, 'global.db'))
        if (result.flaggedRoots.length > 0) {
          appendWorkerErrorLog(
            dir,
            `${new Date().toISOString()} sweepKnownRoots flagged ${result.flaggedRoots.length} root(s) for anomalously large dead-row ratio (skipped, not pruned): ${result.flaggedRoots.join(', ')}\n`,
          )
        }
      } catch {
        // Best-effort housekeeping; a sweep failure must not kill the daemon either.
      }
      lastKnownRootsSweepMs = Date.now()
    }
    if (shouldStop()) break
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/**
 * Run the detached daemon's drain loop in the current (main-thread) process.
 *
 * Reads its poll interval and data dir from the `TG_WORKER_POLL_MS` /
 * `TG_WORKER_DATA_DIR` env vars set by {@link startDetachedWorker} on the child
 * it spawns, registers a SIGTERM handler for a clean exit, and starts {@link
 * runWorkerLoop} without awaiting it -- the loop's own setTimeout chain keeps
 * the event loop (and therefore the process) alive indefinitely.
 *
 * This must be called explicitly by the CLI entrypoint (`cli.ts`'s `run()`)
 * when `--worker-daemon` is present in argv, BEFORE commander ever sees argv:
 * `--worker-daemon` is not a registered commander option or command anywhere
 * in `buildProgram`, so letting commander parse first makes it reject the
 * flag as unknown and the freshly-spawned daemon child exits immediately.
 * This is the sole trigger point for the daemon loop in the shipped CLI --
 * nothing else should call it, since {@link runWorkerLoop} would then be
 * running twice against the same dirty queue.
 *
 * Registers a `process.on('exit', ...)` handler that clears this daemon's own pid file so any
 * exit path other than a clean {@link stopWorker} call (the SIGTERM handler above, an uncaught
 * exception, or the process simply crashing) doesn't leave a stale pid file behind forever. The
 * handler only removes the file when it still names this exact process -- never unconditionally
 * -- so a daemon that lost the {@link claimWorkerPidFile} startup race (and was killed as a
 * duplicate) or was already stopped and superseded by a newer daemon can never clobber the
 * *current* owner's pid file on its own delayed exit.
 */
export function runDetachedWorkerDaemon(): void {
  const dir = process.env['TG_WORKER_DATA_DIR'] ?? dataDir()
  const safeInterval = resolvePollIntervalMs()
  process.on('SIGTERM', () => process.exit(0))
  process.on('exit', () => {
    if (readPidFile(dir) === process.pid) {
      try {
        fs.rmSync(workerPidPath(dir), { force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })
  writeDrainHeartbeat(dir, true)
  void runWorkerLoop(dir, safeInterval)
}
