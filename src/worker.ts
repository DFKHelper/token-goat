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
import { fingerprintFile } from './fingerprint.js'
import { indexFileSync, indexFileEmbeddings, disabledEmbedSha } from './parser.js'
import { getFileEntry } from './index_reader.js'
import { normalizePath } from './paths.js'
import { foldPath, isUnderBlockedRoot } from './util.js'
import { loadConfig } from './config.js'
import { getDb } from './db.js'
import { pathEqClause } from './sql_path.js'
import { removeFileFromIndex, pruneDeletedFiles } from './index_prune.js'
import { cleanup_stale } from './snapshots.js'
import { findProject } from './project.js'

/** Options shared by the in-thread and detached worker entry points. */
export interface WorkerOptions {
  /** Poll interval between drains, in milliseconds. Default 2000. */
  readonly pollIntervalMs?: number
  /** Data directory override (defaults to {@link dataDir}). */
  readonly dataDir?: string
}

const DEFAULT_POLL_INTERVAL_MS = 2000

// Stale session-snapshot sweep runs on the same loop as the dirty-queue drain (see
// runWorkerLoop) but throttled to this interval -- cleanup_stale's own default 24h staleness
// window doesn't need finer-grained sweeping than hourly, and a full directory scan on every
// 2s poll tick would be wasteful.
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
  // NOT normalizePath()'d: the files.path column stores the raw path exactly as the indexer
  // wrote it (see writeParseResult in parser.ts, which never runs it through normalizePath
  // either) -- normalizing here would flip native OS separators (backslashes on Windows) to
  // forward slashes and never match the stored row, always falling through to the INSERT
  // branch below on every call after the first (see the regression test in worker.test.ts).
  const folded = foldPath(absPath)
  const tx = db.transaction((): number => {
    const row = db.prepare(`SELECT retry_count FROM files WHERE ${pathEqClause('path')}`).get(folded) as
      | { retry_count: number | null }
      | undefined
    if (row !== undefined) {
      const next = (row.retry_count ?? 0) + 1
      db.prepare(`UPDATE files SET retry_count = ? WHERE ${pathEqClause('path')}`).run(next, folded)
      return next
    }
    db.prepare('INSERT INTO files (path, retry_count) VALUES (?, 1)').run(absPath)
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
    // See bumpRetryCount's doc comment: no normalizePath() here either, to match the raw form
    // the row was written under.
    const folded = foldPath(absPath)
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
function dirtyQueuePathFor(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
}

/** Parse and deduplicate dirty queue lines. Used by both getDirtyPathsFor and the rename-to-claim drain logic. */
function parseDirtyQueueLines(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
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
 * Run {@link indexFileEmbeddings} for `absPath`, serialized against any other in-flight embed
 * call for the same path (see {@link inFlightEmbeddings}). Errors are swallowed (mirrors the
 * `.catch(() => undefined)` the direct call used before this wrapper existed) so one failed
 * embed never breaks the chain for the next caller.
 */
function embedFileSerialized(absPath: string, dbPath: string, sha: string): Promise<unknown> {
  const key = foldPath(absPath)
  const prior = inFlightEmbeddings.get(key)
  // Dispatch synchronously (no `.then()` hop) when nothing is currently in flight for this
  // path, matching indexFileEmbeddings' previous direct-call timing exactly for the (vastly
  // more common) non-overlapping case -- only a genuinely concurrent second call for the same
  // path pays the extra microtask turn of waiting on `prior`.
  const chained = (
    prior === undefined ? indexFileEmbeddings(absPath, dbPath, sha) : prior.then(() => indexFileEmbeddings(absPath, dbPath, sha))
  ).catch(() => undefined)
  inFlightEmbeddings.set(key, chained)
  void chained.finally(() => {
    // Only clear the slot if nothing newer has been chained onto it since -- otherwise this
    // `finally` (from an OLDER call resolving after a NEWER one already replaced the map entry)
    // would delete the newer call's still-in-flight tracking.
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
  const message = err instanceof Error ? err.message : String(err)
  appendWorkerErrorLog(dir, `${new Date().toISOString()} indexFileSync failed for ${absPath}: ${message}\n`)
}

// A dirty path that exists (fs.existsSync true) but whose fingerprintFile call returns null is
// a transient read failure -- a lock held by an AV scanner/editor/OneDrive sync, a permission
// error, or a race with an external writer -- not a permanent parse/index error. Before this
// fix, processDirtyBatch silently `continue`d past it: the path was dropped from this batch and,
// once drainOnce unconditionally clears the .draining marker right after processDirtyBatch
// returns, it was gone for good with no log entry and no way to retry it short of the file being
// touched again. Log it distinctly from an indexing failure and requeue it so the next drain
// cycle gets another chance once the lock clears.
function logTransientReadFailure(dir: string, absPath: string): void {
  appendWorkerErrorLog(
    dir,
    `${new Date().toISOString()} fingerprintFile returned null for existing file ${absPath} (transient read failure -- requeued for retry)\n`,
  )
}

// Bumps the transient-retry count for `absPath` and decides whether it is still within its
// retry budget. Returns true when the caller should go on to actually requeue the path (append
// it to a dirty queue); false once MAX_TRANSIENT_RETRIES has been exceeded (logging the give-up
// message exactly once, on the cycle the cap is first exceeded). Split out of the old
// requeueDirtyPath so drainOnce can bump the retry counter immediately (once per real failure)
// while deferring the actual queue-file append -- see drainOnce's stage (a)/(b) doc comment for
// why the append must not land in the SAME cycle's live queue.
function bumpAndCheckRetry(dir: string, absPath: string): boolean {
  const dbPath = path.join(dir, 'global.db')
  const attempts = bumpRetryCount(dbPath, absPath)
  if (attempts > MAX_TRANSIENT_RETRIES) {
    // Permanently stuck (e.g. a read lock that never clears): stop requeuing so this path
    // doesn't get hammered every single drain cycle forever. Log exactly once -- on the
    // cycle the cap is first exceeded, not on every subsequent cycle -- so the failure is
    // visible without spamming the log. A future edit to this path re-dirties it through
    // the normal queue-append path (not this function), which gives it a fresh retry budget.
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

// Appends `absPath` to the live dirty queue. Mirrors appendDirtyPath's crash-safe append (mkdir +
// torn-last-line guard) in hooks_index.ts, but is parameterized by `dir` (rather than hardcoding
// dataDir()) so it targets the same queue processDirtyBatch/drainOnce were given -- including an
// isolated dir under test. Best-effort: if the write itself fails, the path is lost for this
// cycle, but the failure is still captured via logTransientReadFailure above.
function appendToDirtyQueue(dir: string, absPath: string): void {
  const queuePath = dirtyQueuePathFor(dir)
  try {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true })
    let leadingNewline = ''
    try {
      const existing = fs.readFileSync(queuePath, 'utf8')
      if (existing.length > 0 && !existing.endsWith('\n')) leadingNewline = '\n'
    } catch {
      // File doesn't exist yet -- nothing to guard against.
    }
    fs.appendFileSync(queuePath, `${leadingNewline}${absPath}\n`)
  } catch {
    // best-effort -- see doc comment above.
  }
}

// Re-adds `absPath` to the live dirty queue after a transient read failure. This is the default
// `requeue` callback processDirtyBatch uses outside of drainOnce (e.g. direct callers/tests);
// drainOnce itself injects a callback that defers the appendToDirtyQueue half -- see its doc
// comment for why.
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
      const entry = getFileEntry(absPath, dbPath)
      // Skip the syntactic reparse when content is byte-identical to what's already indexed
      // (same fingerprint) so a touched-but-unchanged file is not needlessly reparsed.
      const parseUnchanged = entry?.sha === sha
      if (!parseUnchanged) {
        indexFileSync(absPath, dbPath)
      }
      // Embedding freshness is gated INDEPENDENTLY of parse freshness (files.embed_sha, set
      // only after indexFileEmbeddings actually commits -- see its doc comment in parser.ts).
      // If a prior embedding attempt crashed or threw before stamping embed_sha, the parse-sha
      // gate above would otherwise mask that forever: identical content would keep skipping
      // the reparse AND skip re-embedding, leaving chunks permanently stale/missing. Re-check
      // embed_sha against the current sha every time, even when the parse gate above skipped.
      //
      // While embeddings are currently disabled, indexFileEmbeddings stamps embed_sha with
      // disabledEmbedSha(sha) instead of the bare sha (see its doc comment) so this gate can
      // still hold and avoid re-entering indexFileEmbeddings on every drain of an unchanged
      // file -- but a bare-sha match must never satisfy the gate while disabled, or a file
      // that was only ever marker-stamped (never actually embedded) would look "unchanged"
      // the instant embeddings are re-enabled, permanently skipping its real first embed.
      // Optional chaining/fallback here is a defensive test-mock safety net, not a real
      // production path: loadConfig() always returns a fully-populated, schema-validated
      // config object in production. Several existing tests in this file mock loadConfig()
      // with only a partial `{ worker: {...} }` shape (they exercise unrelated gates), so a
      // bare `.indexing.embeddings_enabled` here would throw for those. Default to enabled
      // (true), matching config.ts's own default, so this new gate check is a no-op for tests
      // that never cared about embeddings.
      const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true
      const embedUnchanged =
        parseUnchanged &&
        entry?.embedSha === (embeddingsEnabled ? sha : disabledEmbedSha(sha))
      if (embedUnchanged) {
        // Nothing to do at all: parse and embeddings are both already current for this content.
        return false
      }
      // Embeddings are fired and forgotten here, never awaited: the worker's drain loop is
      // synchronous by design (drainOnce/processDirtyBatch must return instantly so the dirty
      // queue clears promptly), and chunk/vector freshness can safely lag a beat behind symbol
      // freshness since semantic search tolerates staleness in a way exact symbol lookups do
      // not. indexFileEmbeddings already swallows its own errors internally and this .catch is
      // a defensive backstop against a future regression there ever rejecting; returning the
      // promise (rather than voiding it) lets a caller that wants to - such as a test - await
      // it explicitly instead of racing it. Routed through embedFileSerialized so two overlapping
      // drains of the same rapidly re-edited file chain onto one another instead of racing --
      // see its doc comment for the stale-overwrite bug this closes.
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
  // Memoizes findProject(dirname) for this batch only -- findProject re-runs a full ancestor-marker
  // probe (9 markers x existsSync/lstat per level) plus isRepoContainer's readdirSync on every
  // call, and a batch routinely contains many dirty paths under the same directory (or same
  // project tree) that would otherwise repeat that walk once per path for a result
  // (lastKnownProjectRoots) that is only consulted once per PRUNE_EVERY_N_DRAINS drains. Scoped
  // to this function call (not module-level) since a project root learned from one batch's
  // traffic can legitimately go stale by the next batch (e.g. after a project is deleted).
  const projectRootCache = new Map<string, string | null>()
  let indexed = 0
  for (const p of paths) {
    if (!p) continue
    // worker.blocked_roots (set via `token-goat project exclude`) excludes a path prefix from
    // reindexing entirely -- skip before the existence/sha checks so a blocked path is never
    // touched, not even pruned from the index if it happens to have been deleted underneath it.
    if (isUnderBlockedRoot(p, blockedRoots)) continue
    // A dirty path whose file is gone is a deletion to reconcile, not a no-op: prune its stale rows instead of skipping, otherwise `symbol Foo` resolves a deleted file forever.
    if (!fs.existsSync(p)) {
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
    // The read succeeded -- clear any transient-retry count from a prior failure streak so a
    // later failure on this same path (e.g. after a fresh edit) starts from a full budget
    // instead of resuming a much earlier streak (see requeueDirtyPath / bumpRetryCount).
    clearRetryCount(path.join(dir, 'global.db'), p)
    // Opportunistically learn the active project root from this batch's traffic -- see
    // lastKnownProjectRoots' doc comment for why this global, path-keyed queue has no other
    // standing notion of "the current project" for drainOnce's periodic prune sweep to target.
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
    // `false` means the sha-gate skipped a no-op reindex; INDEX_FAILED means the default
    // indexer's catch swallowed a genuine failure (logged separately -- see makeIndexer). Any
    // other return value (including void/undefined from callers that don't bother returning
    // anything) counts as indexed.
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

  // A transient read failure in stage (a) (recovering an abandoned .draining file) must not be
  // requeued straight onto the live dirty.txt: stage (b) below claims that same live queue microseconds
  // later, in this SAME drainOnce call, and would immediately reprocess the path while the
  // lock/condition that caused the original failure has almost certainly not cleared yet --
  // double-bumping its retry count once per cycle instead of once, roughly halving the effective
  // MAX_TRANSIENT_RETRIES budget. Collect this cycle's requeues here and only write them to the
  // live queue once BOTH stages have finished claiming/processing their batches, so a requeued
  // path is guaranteed to wait for the NEXT drainOnce cycle. bumpAndCheckRetry (which increments
  // the retry counter and enforces MAX_TRANSIENT_RETRIES) still runs immediately, at the point of
  // failure -- only the disk append is deferred.
  const deferredRequeues: string[] = []
  const requeueFn = (requeueDir: string, absPath: string): void => {
    if (bumpAndCheckRetry(requeueDir, absPath)) deferredRequeues.push(absPath)
  }

  // (a) Crash recovery: absorb a .draining file abandoned by a previous crashed drain.
  if (fs.existsSync(draining)) {
    let drainingContent: string
    try {
      drainingContent = fs.readFileSync(draining, 'utf8')
    } catch {
      // Genuinely unreadable: quarantine so stage (b)'s claim-rename cannot clobber it, then skip this cycle.
      try {
        fs.renameSync(draining, `${draining}.corrupt-${Date.now()}`)
      } catch {
        // best effort
      }
      return 0
    }
    // Only process this content if it was not already folded into a batch on a prior cycle
    // (see unclearedDrainingSnapshots below). Without this guard, a .draining file that
    // outlives both cleanup attempts (e.g. a persistent Windows sharing violation) would be
    // re-read and its paths reprocessed on every cycle.
    if (unclearedDrainingSnapshots.get(draining) !== drainingContent) {
      processed += processDirtyBatch(parseDirtyQueueLines(drainingContent), indexFn, removeFn, dir, requeueFn)
    }
    // Only clear the recovered file now that its batch has been durably processed (or
    // recognized above as already processed) -- never before -- so a crash partway through
    // processDirtyBatch leaves the .draining file in place for the next startup to recover,
    // instead of deleting it up front and losing every path it named.
    try {
      fs.rmSync(draining, { force: true })
      unclearedDrainingSnapshots.delete(draining)
    } catch {
      try {
        fs.renameSync(draining, `${draining}.corrupt-${Date.now()}`)
        unclearedDrainingSnapshots.delete(draining)
      } catch {
        // Both cleanup attempts failed and the file is still named .draining: remember
        // exactly what we already folded into this cycle's batch so the next cycle can
        // retry cleanup without reprocessing the same paths again.
        unclearedDrainingSnapshots.set(draining, drainingContent)
      }
    }
  }

  // (b) Atomically claim the live queue. A concurrent appendDirtyPath either landed before the rename (its line travels in .draining) or recreates a fresh dirty.txt after it (next cycle) — it can never be deleted unindexed. On Windows a concurrent open-for-append can make rename fail with EPERM/ EBUSY/EEXIST; retry a few times, then defer (return 0 = retry next poll).
  if (fs.existsSync(queuePath)) {
    let claimed = false
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(queuePath, draining)
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
        claimedContent = fs.readFileSync(draining, 'utf8')
        readOk = true
      } catch {
        // read failure is fail-soft: leave the claimed file in place; the next cycle's stage
        // (a) crash recovery will pick it up.
      }
      if (readOk) {
        // Deliberately NOT wrapped in the try above: a throw from processDirtyBatch (e.g. the
        // process crashing mid-batch) must propagate to the caller, not be swallowed as a
        // "read failure", so the cleanup below never runs and the claimed file survives.
        processed += processDirtyBatch(parseDirtyQueueLines(claimedContent), indexFn, removeFn, dir, requeueFn)
        // Only clear the claimed file now that its batch has been durably processed -- never
        // before -- so a crash partway through processDirtyBatch leaves it in place for stage
        // (a) to recover on the next startup instead of losing the paths it named.
        try {
          fs.rmSync(draining, { force: true })
        } catch {
          try {
            fs.renameSync(draining, `${draining}.corrupt-${Date.now()}`)
          } catch {
            // Both cleanup attempts failed: record it the same way stage (a) does, so a
            // leftover .draining file here is recognized as already-processed (and not
            // silently reprocessed) by stage (a)'s crash recovery on the next cycle.
            unclearedDrainingSnapshots.set(draining, claimedContent)
          }
        }
      }
    }
    // If the claim-rename never succeeded after 5 retries, the live queue is left untouched
    // and will be retried on the next poll cycle.
  }

  // (c) Opportunistic prune sweep for renamed/deleted files that never enqueued via the Edit
  // hook path (git mv, git checkout, git clean). Runs after all normal dirty-queue work above,
  // on a low cadence (see PRUNE_EVERY_N_DRAINS' doc comment), so it never delays draining the
  // queue itself and a slow sweep on a huge repo only pushes out the NEXT sweep's schedule, not
  // this cycle's already-completed dirty-queue work.
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

  // Now that both stages above have finished claiming/processing their batches for this cycle,
  // it is safe to actually append this cycle's transient-failure requeues to the live queue --
  // see deferredRequeues' doc comment above for why this must happen last.
  for (const p of deferredRequeues) appendToDirtyQueue(dir, p)

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
 * True only when the pid file exists, names a numeric pid, and that pid maps to
 * a live process. A stale pid file (process gone) reads as not running.
 */
export function isWorkerRunning(dir: string = dataDir()): boolean {
  const pid = readPidFile(dir)
  if (pid === null) return false
  return pidAlive(pid)
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
  const alive = pidAlive(pid)
  if (alive) {
    try {
      process.kill(pid)
    } catch {
      // Race: process exited between the check and the kill. Fall through to pid-file cleanup; report whatever liveness we observed.
    }
  }
  // Only remove the pid file when it still names the pid we just killed -- never unconditionally.
  // A concurrent `worker start` can observe the killed pid as dead and reclaim the slot (via
  // claimWorkerPidFile) with a brand-new daemon's pid between our kill above and this cleanup; an
  // unconditional rmSync here would delete that new daemon's pid file out from under it, orphaning
  // it (no pid file left for a later stopWorker to find), which a subsequent `worker start` would
  // then "fix" by spawning a third daemon -- two live daemons draining the same queue. Same guard
  // style as the exit handler in runDetachedWorkerDaemon.
  if (readPidFile(dir) === pid) {
    try {
      fs.rmSync(workerPidPath(dir), { force: true })
    } catch {
      // best-effort cleanup
    }
  }
  return alive
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
  if (existingPid !== null && pidAlive(existingPid)) {
    return false
  }
  // Stale, dead, or unreadable: reclaim the slot.
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
 * The child runs `node <thisModule> --worker-daemon` with the poll interval and
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
export function startDetachedWorker(opts?: WorkerOptions): number {
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const dir = opts?.dataDir ?? dataDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }

  const child: ChildProcess = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--worker-daemon'],
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
export async function runWorkerLoop(
  dir: string,
  pollIntervalMs: number,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  // Local to this loop invocation (not module-level) so each call starts its own fresh
  // throttle window instead of sharing state across unrelated runWorkerLoop calls (e.g. across
  // tests in the same process).
  let lastSnapshotCleanupMs = 0
  while (!shouldStop()) {
    try {
      drainOnce(dir)
    } catch {
      // A bad batch must not kill the daemon; skip and retry next cycle.
    }
    // Sweep stale session-snapshot directories on the same periodic loop as the dirty-queue
    // drain above, so accumulating session_snapshots/<sessionId>/ dirs get cleaned up on a
    // schedule instead of growing unbounded for the life of the daemon.
    if (Date.now() - lastSnapshotCleanupMs >= SNAPSHOT_CLEANUP_INTERVAL_MS) {
      try {
        cleanup_stale()
      } catch {
        // Best-effort housekeeping; a cleanup failure must not kill the daemon either.
      }
      lastSnapshotCleanupMs = Date.now()
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
  const interval = parseInt(process.env['TG_WORKER_POLL_MS'] ?? '0', 10)
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS
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
  void runWorkerLoop(dir, safeInterval)
}

