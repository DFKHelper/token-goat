/**
 * Background worker — drain the dirty queue and re-index changed files.
 *
 * Ports the daemon loop of `worker.py` to the TypeScript surface, in two forms:
 *
 *   - {@link startWorker} runs the drain loop in an in-process Node worker
 *     thread (`node:worker_threads`). Best for an embedding process that wants
 *     the worker to die with it.
 *   - {@link startDetachedWorker} spawns a long-lived detached child process
 *     that outlives the launching CLI invocation. Its PID is recorded in a
 *     pid file so a later {@link stopWorker} / {@link isWorkerRunning} can find
 *     it.
 *
 * The loop itself: read `{dataDir}/queue/dirty.txt`, parse each changed path,
 * and write its symbol/ref rows into the index DB via {@link indexFileSync}.
 * Processed entries are cleared from the queue before sleeping `pollIntervalMs`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

import { dataDir, globalDbPath } from './constants.js'
import { fingerprintFile } from './fingerprint.js'
import { indexFileSync } from './parser.js'
import { getFileEntry } from './index_reader.js'
import { normalizePath } from './paths.js'
import { foldPath } from './util.js'
import { getDb } from './db.js'
import { removeFileFromIndex } from './index_prune.js'

/** Options shared by the in-thread and detached worker entry points. */
export interface WorkerOptions {
  /** Poll interval between drains, in milliseconds. Default 2000. */
  readonly pollIntervalMs?: number
  /** Data directory override (defaults to {@link dataDir}). */
  readonly dataDir?: string
}

/** Handle for a worker started via {@link startWorker}. */
export interface WorkerHandle {
  /** Always null for worker threads (they share the host process's PID). */
  readonly pid: number | null
  /** The worker thread's id within this process. */
  readonly threadId: number
  /** Terminate the worker thread and resolve once it has exited. */
  stop(): Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 2000

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
 * Build the index callback the drain loop uses by default: parse each changed
 * file and write its symbol/ref rows into the index DB at `dbPath`. A parse or
 * read failure on one file is swallowed so a single bad file never aborts the
 * batch or crashes the drain loop.
 */
function makeIndexer(dbPath: string): (absPath: string, sha: string) => void {
  return (absPath, sha) => {
    try {
      // Skip files whose content is byte-identical to what's already indexed (same fingerprint) so a touched-but-unchanged file is not needlessly reparsed.
      if (getFileEntry(absPath, dbPath)?.sha === sha) return
      indexFileSync(absPath, dbPath)
    } catch {
      // One bad file must not abort the rest of the batch.
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
 * observe the plumbing in isolation. Returns the number of paths indexed.
 *
 * Exported for unit tests so the drain logic can be exercised without a thread.
 */
export function processDirtyBatch(
  paths: string[],
  index: (absPath: string, sha: string) => void = makeIndexer(globalDbPath()),
  remove: (absPath: string) => void = makeRemover(globalDbPath()),
): number {
  let indexed = 0
  for (const p of paths) {
    if (!p) continue
    // A dirty path whose file is gone is a deletion to reconcile, not a no-op: prune its stale rows instead of skipping, otherwise `symbol Foo` resolves a deleted file forever.
    if (!fs.existsSync(p)) {
      remove(p)
      continue
    }
    const sha = fingerprintFile(p)
    if (sha === null) continue
    index(p, sha)
    indexed += 1
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
 * Returns the number of paths processed. When no `index` callback is injected,
 * files are indexed into `dir`'s `global.db` (the real shipping path); in
 * production `dir` is the data dir, so this is {@link globalDbPath}.
 */
export function drainOnce(
  dir: string,
  index?: (absPath: string, sha: string) => void,
  remove?: (absPath: string) => void,
): number {
  const queuePath = dirtyQueuePathFor(dir)
  const draining = `${queuePath}.draining`
  let rawSnapshot = ''

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
    // Only fold this content into the batch if it was not already queued for processing
    // on a prior cycle (see unclearedDrainingSnapshots below). Without this guard, a
    // .draining file that outlives both cleanup attempts (e.g. a persistent Windows
    // sharing violation) would be re-read and its paths reprocessed on every cycle.
    if (unclearedDrainingSnapshots.get(draining) !== drainingContent) {
      rawSnapshot += drainingContent
    }
    // Read succeeded; lines are safely in rawSnapshot. Best-effort remove so they are not reprocessed; if removal fails (e.g. a Windows sharing violation) quarantine the file out of stage (b)'s way but do NOT discard the data already read.
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
      try {
        rawSnapshot += fs.readFileSync(draining, 'utf8')
        fs.rmSync(draining, { force: true })
      } catch {
        // read/clear failure is fail-soft
      }
    } else if (rawSnapshot === '') {
      return 0 // queue busy and nothing recovered; retry next poll
    }
  }

  if (rawSnapshot.trim() === '') return 0
  const paths = parseDirtyQueueLines(rawSnapshot)
  const dbPath = path.join(dir, 'global.db')
  return processDirtyBatch(paths, index ?? makeIndexer(dbPath), remove ?? makeRemover(dbPath))
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
  try {
    fs.rmSync(workerPidPath(dir), { force: true })
  } catch {
    // best-effort cleanup
  }
  return alive
}

/**
 * Start the drain loop in an in-process worker thread.
 *
 * The thread re-imports this module; the `isMainThread === false` branch at the
 * bottom runs {@link runWorkerLoop}. Stopping the returned handle terminates
 * the thread.
 */
export function startWorker(opts?: WorkerOptions): WorkerHandle {
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const dir = opts?.dataDir ?? dataDir()

  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { pollIntervalMs, dataDir: dir },
  })

  return {
    pid: null,
    threadId: worker.threadId,
    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        worker.once('exit', () => resolve())
        void worker.terminate()
      })
    },
  }
}

/**
 * Spawn the drain loop as a detached child process and record its pid.
 *
 * The child runs `node <thisModule> --worker-daemon` with the poll interval and
 * data dir passed via env (a detached process cannot share `workerData`). The
 * child is `unref`'d so the launching CLI can exit immediately. Returns the
 * child pid (or throws if the spawn itself fails synchronously).
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
  fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
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
  while (!shouldStop()) {
    try {
      drainOnce(dir)
    } catch {
      // A bad batch must not kill the daemon; skip and retry next cycle.
    }
    if (shouldStop()) break
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/**
 * Worker-thread / daemon entry point.
 *
 * Runs only when this module is loaded off the main thread (via {@link
 * startWorker}) or as the detached daemon child (`--worker-daemon`). The thread
 * case reads config from `workerData`; the daemon case reads it from env.
 */
function workerEntry(): void {
  if (!isMainThread) {
    const wd = (workerData ?? {}) as { pollIntervalMs?: number; dataDir?: string }
    const dir = wd.dataDir ?? dataDir()
    const interval = wd.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    let stop = false
    const onStop = (msg: string) => {
      if (msg === 'stop') {
        stop = true
        parentPort?.removeListener('message', onStop)
      }
    }
    parentPort?.on('message', onStop)
    void runWorkerLoop(dir, interval, () => stop)
    return
  }
  if (process.argv.includes('--worker-daemon')) {
    const dir = process.env['TG_WORKER_DATA_DIR'] ?? dataDir()
    const interval = parseInt(process.env['TG_WORKER_POLL_MS'] ?? '0', 10)
    const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS
    process.on('SIGTERM', () => process.exit(0))
    void runWorkerLoop(dir, safeInterval)
  }
}

workerEntry()
