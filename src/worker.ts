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

/** Absolute path to the dirty queue file for `dir`. */
function dirtyQueuePathFor(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
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
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Remove the dirty queue file for `dir` (idempotent). */
function clearDirtyQueueFor(dir: string): void {
  try {
    fs.rmSync(dirtyQueuePathFor(dir), { force: true })
  } catch {
    // best-effort: a locked/already-removed queue must not crash the loop
  }
}

/**
 * Build the index callback the drain loop uses by default: parse each changed
 * file and write its symbol/ref rows into the index DB at `dbPath`. A parse or
 * read failure on one file is swallowed so a single bad file never aborts the
 * batch or crashes the drain loop.
 */
function makeIndexer(dbPath: string): (absPath: string, sha: string) => void {
  return (absPath) => {
    try {
      indexFileSync(absPath, dbPath)
    } catch {
      // One bad file must not abort the rest of the batch.
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
): number {
  let indexed = 0
  for (const p of paths) {
    if (!p || !fs.existsSync(p)) continue
    const sha = fingerprintFile(p)
    if (sha === null) continue
    index(p, sha)
    indexed += 1
  }
  return indexed
}

/**
 * Run one drain cycle for `dir`: snapshot the queue, process it, clear it.
 *
 * Returns the number of paths processed. Clears the queue only when it held
 * entries, so an empty poll leaves the (absent) file untouched. When no `index`
 * callback is injected, files are indexed into `dir`'s `global.db` (the real
 * shipping path); in production `dir` is the data dir, so this is
 * {@link globalDbPath}.
 */
export function drainOnce(dir: string, index?: (absPath: string, sha: string) => void): number {
  const paths = getDirtyPathsFor(dir)
  if (paths.length === 0) return 0
  const indexed = processDirtyBatch(paths, index ?? makeIndexer(path.join(dir, 'global.db')))
  clearDirtyQueueFor(dir)
  return indexed
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
      // Race: process exited between the check and the kill. Fall through to
      // pid-file cleanup; report whatever liveness we observed.
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
