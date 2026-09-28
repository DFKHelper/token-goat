/** Finding, starting and stopping the background worker daemon: its pid and stamp files, the drain heartbeat that proves it is alive, its error log, and the detached spawn. Kept apart from worker.ts, which holds the drain itself, so a hook that only checks the daemon is alive never loads the indexer. */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dataDir } from './constants.js'
import { displaySafeText } from './paths.js'
import { atomicWriteText, ensureDirSync, extractErrorMessage } from './util.js'

/** Options shared by the in-thread and detached worker entry points. */
export interface WorkerOptions {
  /** Poll interval between drains, in milliseconds. Default 2000. */
  readonly pollIntervalMs?: number
  /** Data directory override (defaults to {@link dataDir}). */
  readonly dataDir?: string
}

const DEFAULT_POLL_INTERVAL_MS = 2000

/** Resolve the poll interval a worker should use: an explicit caller-supplied value first, then a positive-integer `TG_WORKER_POLL_MS`, then the default. Anything else in the env var (empty, non-numeric, zero, negative) is ignored rather than trusted. Shared by {@link startDetachedWorker} and worker.ts::runDetachedWorkerDaemon so the two ends agree on what a valid interval is: the parent can never forward a value the child would reject and silently swap for the default. The parent used to skip the env entirely and hardcode the default into the child's environment, which made `TG_WORKER_POLL_MS` a no-op on the normal `worker start` path even though the daemon itself reads it. */
export function resolvePollIntervalMs(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const parsed = parseInt(process.env['TG_WORKER_POLL_MS'] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS
}

/** How old the drain-heartbeat marker (see drainHeartbeatPathFor) may get before hasFreshWorkerHeartbeat stops counting the pid it names as a running worker: 30x the 2 s default poll interval, a generous margin against a slow cycle on a large repo. */
const WORKER_HEARTBEAT_STALE_MS = 60_000

const WORKER_HEARTBEAT_REFRESH_MS = 5_000

const WORKER_STARTUP_GRACE_MS = 10_000

const heartbeatWriteTimes = new Map<string, number>()

/** Absolute path to the drain-heartbeat marker for `dir`, touched at the end of every `drainOnce` cycle (whether or not anything was processed) so a doctor check can distinguish "worker process alive" from "worker actually still draining" -- a deadlocked or wedged loop keeps its pid alive without ever reaching the touch below. */
export function drainHeartbeatPathFor(dir: string): string {
  return path.join(dir, 'queue', 'drain-heartbeat')
}

/** Rewrite the drain heartbeat with this process's pid. Written through a temp file and a rename rather than in place: `writeFileSync` truncates before it writes, and a reader in another process landing in that window read an empty file, so hasFreshWorkerHeartbeat reported a live worker as dead. */
export function writeDrainHeartbeat(dir: string, force = false): void {
  const now = Date.now()
  if (!force && now - (heartbeatWriteTimes.get(dir) ?? 0) < WORKER_HEARTBEAT_REFRESH_MS) return
  try {
    atomicWriteText(drainHeartbeatPathFor(dir), `${process.pid}\n`)
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

/** Absolute path to the worker pid file for `dir`. */
export function workerPidPath(dir: string = dataDir()): string {
  return path.join(dir, 'worker.pid')
}

/** Absolute path to the sibling file recording which on-disk bundle the running daemon was spawned from -- a separate file rather than a second line in worker.pid so an older token-goat reading the pid file with a strict `/^\d+$/` check keeps working unchanged. */
export function workerStampPath(dir: string = dataDir()): string {
  return path.join(dir, 'worker.stamp')
}

/** Absolute path to the worker's incremental-index error log for `dir`. Appended to (never truncated) whenever worker.ts::makeIndexer's default callback swallows a per-file indexing failure. This is the only place such a failure is ever discoverable: the detached worker process spawned by {@link startDetachedWorker} runs with `stdio: 'ignore'`, so anything the worker process writes to stdout/stderr is silently discarded. */
export function workerErrorLogPath(dir: string): string {
  return path.join(dir, 'worker-errors.log')
}

/** Flatten `line` to exactly one physical line, ending in exactly one newline. Every caller builds its line by interpolating two values a repository controls: the path of the file that failed, and the error message, which for a parse failure quotes the file's own bytes. A newline in either one forges log entries, so a line that reads like a token-goat diagnostic can be written by naming a file after one. Escaping rather than stripping keeps the log honest about what the name was, and routing through displaySafeText covers the markers as well as the control characters -- escaping only the newline left `[tg]` and `[token-goat` intact, which is the half of the threat this comment describes. Nothing in src/ reads this file back today: an earlier version of this comment claimed `doctor` and `bridges-status` did, and they only tell the user where to look. It is written for a person reading it directly, which is a weaker exposure than a parsed one but not a reason to forge entries into it. */
export function oneLogLine(line: string): string {
  // displaySafeText covers both halves at once: the control characters this escaped by hand, and the `[tg]`/`[token-goat` markers the docstring above states the threat for but the hand-rolled escape never touched.
  return displaySafeText(line.replace(/[\n\r]+$/, '')) + '\n'
}

/** Append one failure line to the error log for `dir`. Best-effort: a failure to write the log itself must not throw back out of the indexer's own catch handler. */
export function appendWorkerErrorLog(dir: string, line: string): void {
  try {
    fs.appendFileSync(workerErrorLogPath(dir), oneLogLine(line))
  } catch {
    // best-effort: nothing more we can do if even the log write itself fails.
  }
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

/** Read the pid recorded in the worker pid file, or null when absent/malformed. */
export function readPidFile(dir: string): number | null {
  try {
    const raw = fs.readFileSync(workerPidPath(dir), 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    return parseInt(raw, 10)
  } catch {
    return null
  }
}

/** Is a detached worker currently running for this project? True only when the pid file names a live process that has recently written a PID-bound heartbeat. This rejects a stale PID whose number was reused by an unrelated process. */
export function isWorkerRunning(dir: string = dataDir()): boolean {
  const pid = readPidFile(dir)
  if (pid === null) return false
  return pidAlive(pid) && hasFreshWorkerHeartbeat(dir, pid)
}

/** Absolute path to the auto-heal rate-limit marker for `dir`. */
function workerHealthCheckMarkerPath(dir: string): string {
  return path.join(dir, 'worker-healthcheck.marker')
}

/** Minimum time between {@link ensureWorkerAlive} liveness checks, so a burst of edit-hook calls (e.g. a multi-file refactor) doesn't re-check the pid file and attempt a respawn on every single one -- one check per interval is enough to notice and heal a dead daemon promptly. */
const WORKER_HEALTHCHECK_MIN_INTERVAL_MS = 5 * 60 * 1000

/** Best-effort auto-heal: if the detached worker for `dir` isn't running, start a fresh one. Before this, {@link startDetachedWorker} was only ever invoked from the `worker start` CLI command -- nothing anywhere restarted a daemon that died (crash, a manual `taskkill`, machine sleep/wake races, anything). A dead worker stayed dead indefinitely: the dirty queue kept accumulating, `token-goat read`/`symbol`/`section`/`outline` kept serving stale index content with no automatic recovery, until a human happened to notice and ran `worker start` by hand. Called from {@link postEditHandler in hooks_edit.ts}, the hot path where real work is actually queued for the worker to drain, self-rate-limited via a marker-file mtime ({@link WORKER_HEALTHCHECK_MIN_INTERVAL_MS}) so it isn't re-triggered on every hook call. Fail-soft throughout: marker-file I/O errors, spawn failures, and a lost {@link claimWorkerPidFile} race against a worker that started in the same instant are all swallowed -- this function's job is to nudge a dead worker back to life, never to guarantee one is running or to throw out of a hook handler. */
export function ensureWorkerAlive(dir: string = dataDir()): void {
  // Test-isolation escape hatch: this is the one auto-heal path that fires as an incidental side effect of exercising unrelated code (any test that drives postEditHandler), not a deliberate "test worker spawning" call -- without this, every such test spawned a REAL detached daemon child process, relying only on that daemon's own data-dir-deleted self-check to eventually notice and exit rather than never spawning it in the first place. tests/setup/isolate-home.ts pins TOKEN_GOAT_NO_WORKER_SPAWN='1' for exactly this reason; a test that deliberately wants real spawning through this function (worker.test.ts's own ensureWorkerAlive suite) opts back out by setting the var itself, the same override pattern used for the harness/embeddings pins. Never gates startDetachedWorker itself -- the explicit `worker start` CLI command and dedicated daemon e2e tests call that directly and must still spawn for real.
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
    // If we can't even write the marker, don't let that block the liveness check below -- worst case we just check more often than intended.
  }
  // Read the pid once and judge only that pid: re-reading it at stop time would pick up a replacement another hook just spawned, which has not written its heartbeat yet, and tear down its pid file, leaving two daemons draining one queue.
  const livePid = readPidFile(dir)
  if (livePid !== null && pidAlive(livePid) && hasFreshWorkerHeartbeat(dir, livePid)) {
    // A live daemon keeps running the bundle it was spawned from, so after an upgrade or a rebuilt dist/token-goat.mjs it runs the pre-upgrade code until stopped; stop it the way `worker stop` does and spawn a fresh one.
    if (workerBundleMatches(dir)) return
    stopWorker(dir, livePid)
    // The pid file naming anyone else now means another hook already replaced the daemon; spawning too would start a second one.
    const nowPid = readPidFile(dir)
    if (nowPid !== null && nowPid !== livePid) return
  }
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

/** Kill the detached worker for this project, if one is running. Returns true when a live worker was found and signalled; false when no pid file existed or the recorded pid was already dead. The pid file is removed in both the killed and stale cases so the slate is clean afterwards. */
export function stopWorker(dir: string = dataDir(), expectedPid?: number): boolean {
  const pid = readPidFile(dir)
  if (pid === null) return false
  // If the caller judged a specific pid mismatched/stale earlier and the pid file now names someone else, another hook already raced ahead of us (stopped it and spawned a replacement); do nothing rather than tearing down that replacement's pid file before it can prove itself alive.
  if (expectedPid !== undefined && pid !== expectedPid) return false
  const running = isWorkerRunning(dir)
  if (running) {
    try {
      process.kill(pid)
    } catch {
      // Race: process exited between the check and the kill. Fall through to pid-file cleanup; report whatever liveness we observed.
    }
  }
  // Only remove the pid file when it still names the pid we just killed -- never unconditionally. A concurrent `worker start` can observe the killed pid as dead and reclaim the slot (via claimWorkerPidFile) with a brand-new daemon's pid between our kill above and this cleanup; an unconditional rmSync here would delete that new daemon's pid file out from under it, orphaning it (no pid file left for a later stopWorker to find), which a subsequent `worker start` would then "fix" by spawning a third daemon -- two live daemons draining the same queue. Same guard style as the exit handler in worker.ts::runDetachedWorkerDaemon.
  if (readPidFile(dir) === pid) {
    try {
      fs.rmSync(workerPidPath(dir), { force: true })
    } catch {
      // best-effort cleanup
    }
  }
  return running
}

/** Thrown by {@link startDetachedWorker} when it loses the {@link claimWorkerPidFile} startup race to a daemon that already holds the pid-file slot (a genuine already-running worker, or a concurrent `worker start` invocation that won the race first). */
export class WorkerAlreadyRunningError extends Error {
  constructor(message = 'worker already running') {
    super(message)
    this.name = 'WorkerAlreadyRunningError'
  }
}

/** Thrown by {@link startDetachedWorker}, before anything is spawned, when the data directory refuses a write: the worker keeps its pid file, queue and index there, so a daemon started against it could only fail, with no pid file for `worker stop` to find it by. */
export class WorkerDataDirUnwritableError extends Error {
  constructor(dir: string, cause: unknown) {
    super(`the data directory ${displaySafeText(dir)} cannot be written (${extractErrorMessage(cause)}), and the worker keeps its pid file, queue and index there; make it writable and run \`token-goat worker start\` again`, { cause })
    this.name = 'WorkerDataDirUnwritableError'
  }
}

/** The error writing a file into `dir` raises, or undefined when the write succeeds. A real write rather than an access() check, because on Windows access() consults only the read-only attribute and passes a directory whose ACL denies the write. */
export function dataDirWriteRefusal(dir: string): unknown {
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
  } catch (e) {
    return e
  }
  try {
    fs.rmSync(probe, { force: true })
  } catch {
    // Best-effort: the write succeeded, which is all this asks.
  }
  return undefined
}

/** Kill a daemon {@link startDetachedWorker} spawned but cannot keep, and drop the parent's reference to it so the calling process can exit. */
function discardSpawnedWorker(child: ChildProcess, pid: number): void {
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
  child.unref()
}

/** Atomically claim the worker pid file for `pid`, closing the TOCTOU race where two near-simultaneous `worker start` invocations could otherwise both pass an {@link isWorkerRunning} pre-check and then unconditionally overwrite each other's pid file -- orphaning whichever daemon lost, with no pid file left pointing at it for a later {@link stopWorker} to find. Uses exclusive-create (`wx`) so only one writer can ever create the file fresh; a losing writer sees `EEXIST` instead of silently clobbering the winner's entry, and then checks whether the pid already recorded there is a live process: - alive: refuse -- a real daemon already holds the slot. Returns false. - dead/stale/unreadable: safe to reclaim -- remove the stale file and retry the exclusive create once. Exported for tests; the boolean return lets {@link startDetachedWorker} decide whether to kill the child process it just spawned when it loses the race. */
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
  // Stale, dead, or unreadable: reclaim the slot. Never signal the pid it names: this path is reached only when that pid proves no worker lease, which is what a daemon killed without its exit handler leaves behind once the OS reuses its pid, so a kill here lands on an unrelated process. A superseded daemon that is still running exits on its own at its next poll (see worker.ts::runWorkerLoop).
  try {
    fs.rmSync(pidPath, { force: true })
  } catch {
    // best-effort
  }
  try {
    fs.writeFileSync(pidPath, `${pid}\n`, { flag: 'wx' })
    return true
  } catch (e2) {
    // Lost a second, much narrower race on the reclaim retry itself: be conservative and report already-running rather than clobber whoever just won it.
    if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e2
  }
}

/** The script the daemon child must be spawned on: the CLI launcher sitting next to this module, when there is one. `fileURLToPath(import.meta.url)` is not it, and only looked like it while the core build emitted a single file. Under `splitting: true` this module's code lands in a hashed chunk, which has no entrypoint of its own: spawning it starts a process that loads a library and exits without ever reaching the `--worker-daemon` dispatch, so `worker start` reported a pid for a child that was already dead and no drain heartbeat ever appeared. Every chunk is emitted beside the launcher, so resolving it by name is stable however the bundler arranges the code, and it re-enables the V8 compile cache for the child as a side benefit. Falls back to this module's own path for a non-bundled (source) run, where no launcher exists beside it. */
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

/** Identity of the bundle a freshly spawned daemon would run right now: the entry script path plus its size and mtime, cheap enough (one stat) to call from the hot `ensureWorkerAlive` path on every hook invocation. Falls back to the bare path if the file is momentarily unreadable, which just makes the next comparison a mismatch rather than throwing. Exported so a test can stamp a fixture pid file with the exact value the real code would compare against. */
export function currentDaemonStamp(): string {
  const entry = daemonEntryScript()
  try {
    const st = fs.statSync(entry)
    return `${entry}|${st.size}|${Math.trunc(st.mtimeMs)}`
  } catch {
    return entry
  }
}

/** True when the daemon behind `dir` needs no restart: either its stamp names the exact bundle {@link currentDaemonStamp} resolves to right now, or its stamp names a different install's entry script entirely -- two installs (e.g. a global npm install and a worktree/temp-copy dist/) sharing one data dir must never restart each other's daemon just because their entry paths differ. False (restart) only for a missing/unparseable stamp (pre-upgrade pid-file format) or a stamp naming this same entry script with a different size/mtime (this install was rebuilt or upgraded). */
function workerBundleMatches(dir: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(workerStampPath(dir), 'utf8').trim()
  } catch {
    return false
  }
  const parts = raw.split('|')
  if (parts.length !== 3) return false
  const [entry, sizeStr, mtimeStr] = parts
  if (entry !== daemonEntryScript()) return true
  const size = Number(sizeStr)
  const mtimeMs = Number(mtimeStr)
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return false
  try {
    const st = fs.statSync(entry)
    return st.size === size && Math.trunc(st.mtimeMs) === mtimeMs
  } catch {
    return false
  }
}

/** Spawn the drain loop as a detached child process and record its pid. The child runs `node <CLI entry> --worker-daemon` (see {@link daemonEntryScript}) with the poll interval and data dir passed via env (a detached process cannot share `workerData`). The child is `unref`'d so the launching CLI can exit immediately. Returns the child pid (or throws if the spawn itself fails synchronously). The pid file is claimed via {@link claimWorkerPidFile} AFTER the child is spawned (a detached child's real pid can't be known beforehand) but BEFORE it is `unref`'d or returned to the caller: if the claim loses the race to an already-running daemon, the just-spawned duplicate child is killed immediately and {@link WorkerAlreadyRunningError} is thrown, so no orphaned second daemon is ever left running. */
export function startDetachedWorker(opts?: WorkerOptions): number {
  const pollIntervalMs = resolvePollIntervalMs(opts?.pollIntervalMs)
  // Absolute, because the daemon is not started in this process's directory: a relative TG_WORKER_DATA_DIR would name a different directory there from the one it names here.
  const dir = path.resolve(opts?.dataDir ?? dataDir())
  try {
    ensureDirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }
  // Asked before spawning, because nothing after the spawn can undo it cleanly: the pid-file claim below was the first write, so an unwritable directory threw there with a daemon already running and still referenced, which hung `worker start` and left the daemon with no pid file for `worker stop` to find.
  const refusal = dataDirWriteRefusal(dir)
  if (refusal !== undefined) throw new WorkerDataDirUnwritableError(dir, refusal)

  // Never the caller's directory. The caller is usually a hook running inside the user's project, and on Windows a working directory is an open handle, so a daemon that inherited one kept a throwaway working copy undeletable for as long as it lived. The temp directory, where the hook server sits for the same reason, and not the data directory: `uninstall --purge` and a test's teardown delete that one right after `worker stop`, and a daemon still exiting from inside it made the delete fail. The data directory, created just above, only when TEMP names a directory that is gone, since a spawn into a missing directory starts nothing. (Kept out of the options object below: esbuild ships a comment written there in the hook bundle.)
  const cwd = fs.existsSync(os.tmpdir()) ? os.tmpdir() : dir
  const child: ChildProcess = spawn(
    process.execPath,
    [daemonEntryScript(), '--worker-daemon'],
    {
      cwd,
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
  // A spawn that cannot start returns a child with no pid and emits the cause as an 'error' event after this function returns, outside every caller's try/catch. Unheard, that event is an uncaught exception that crashes the hook whose ensureWorkerAlive asked. The throw below already reports the failure, which ensureWorkerAlive logs, and no pid file is claimed, so its next check retries.
  child.on('error', () => undefined)

  const pid = child.pid
  if (pid === undefined) {
    throw new Error('startDetachedWorker: spawn produced no pid')
  }

  let claimed: boolean
  try {
    claimed = claimWorkerPidFile(dir, pid)
  } catch (e) {
    discardSpawnedWorker(child, pid)
    throw e
  }
  if (!claimed) {
    discardSpawnedWorker(child, pid)
    throw new WorkerAlreadyRunningError()
  }

  // Best-effort: a failed write here just leaves the stamp missing, which workerBundleMatches already treats as a mismatch on the next check -- no worse than before this daemon ever stamped anything.
  try {
    fs.writeFileSync(workerStampPath(dir), currentDaemonStamp())
  } catch {
    // best-effort
  }

  child.unref()
  return pid
}
