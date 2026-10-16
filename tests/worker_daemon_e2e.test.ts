/** End-to-end proof that `token-goat worker start` actually keeps a background daemon running and draining the dirty queue, against the BUILT bundle (dist/token-goat.mjs). Regression for: {@link import('../src/worker.js').startDetachedWorker} spawns `node <bundle> --worker-daemon`, but the bundle's real entrypoint (main.ts -> cli.ts::run()) used to call commander's `parseAsync()` unconditionally, with no pre-check for `--worker-daemon` -- commander has no such registered option or command, so it rejected the flag as unknown and the freshly-spawned daemon child exited (code 1) before ever reaching the daemon loop. `token-goat worker start` reported a pid (the spawn call itself succeeds and returns a pid even for a child that is about to crash), but `token-goat worker status` moments later reported "not running" -- the entire detached background-indexing feature was silently non-functional. A unit test that mocks the daemon dispatch (as worker_daemon.test.ts and most of worker.test.ts do) cannot catch this: the bug is in argv wiring at the real process entrypoint, which only spawning the actual built bundle exercises. This test drives `worker start` for real, confirms the daemon process is still alive well past the point the old bug already killed it, then proves it does real work by seeding a real dirty-queue entry and confirming the running daemon (not a manual `index` call) drains it. */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { appendDirtyQueuePaths } from '../src/dirty_queue.js'
import { BUNDLE, readCoreBundleText, runBundle as sharedRunBundle, tgIsolatedEnv, type RunResult } from './helpers/bundle.js'

function runBundle(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  return sharedRunBundle(args, { cwd, env, timeout: 30000 })
}

/** `pollMs` is forwarded to the daemon as TG_WORKER_POLL_MS, so the drain assertions below do not have to wait out the 2000ms production default. */
function tgEnv(base: string, pollMs?: number): NodeJS.ProcessEnv {
  return tgIsolatedEnv(base, pollMs === undefined ? undefined : { TG_WORKER_POLL_MS: String(pollMs) })
}

/** Mirrors src/constants.ts's private defaultDataDir() platform join, so this test can locate the same queue/dirty.txt and global.db the daemon uses without importing constants.ts -- that module caches its DATA_DIR once at first import from whatever LOCALAPPDATA/XDG_DATA_HOME the test worker process happened to start with, not the per-test temp base this file passes to the spawned bundle. darwin now also honors an XDG_DATA_HOME override (same env this helper's caller already sets) before falling back to the Library/Application Support path -- matching defaultDataDir()'s darwin branch fix (was previously HOME-only, always ignoring the override this file already passed). */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  if (process.platform === 'darwin') return path.join(base, 'token-goat')
  return path.join(base, 'token-goat')
}

/** Signal-0 liveness probe, mirroring worker_lifecycle.ts's own pidAlive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll `check` every 50ms until it returns true. Throws with `label` once `timeoutMs` elapses; that bound is a hang backstop for a daemon that is alive and silent, never a measurement, and nothing in this file asserts on how long a wait took. */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    }
    await sleep(50)
  }
}

/** Wait until `file` has been replaced `rewrites` times since this call, or fail as soon as the daemon `pid` is gone. Every worker cycle replaces the drain heartbeat through a rename, even with an empty queue, so its identity changes once per cycle. The wait ends on that event and measures nothing; an observer that stalls across two rewrites counts one, which only makes it wait longer. */
async function waitForDaemonRewrites(file: string, rewrites: number, pid: number): Promise<void> {
  const identity = (): string => {
    try {
      const st = fs.statSync(file, { bigint: true })
      return `${st.ino}:${st.mtimeNs}`
    } catch {
      return ''
    }
  }
  let last = identity()
  let seen = 0
  await waitForDaemon(`${rewrites} drain heartbeat rewrites`, DAEMON_WAIT_BACKSTOP_MS, pid, () => {
    const now = identity()
    if (now !== '' && now !== last) {
      last = now
      seen++
    }
    return seen >= rewrites
  })
}

/** A preload (`node --import`) that appends the delay of every `setTimeout` call to `<TG_E2E_TIMER_LOG>.<pid>`. Provenance: HAND-DERIVED; it wraps the global `setTimeout` that worker's queue waker calls as `setTimeout(done, ms)` (src/queue_waker.ts), so the file holds the exact interval each worker cycle asked to sleep, read from the real daemon process instead of inferred from how long cycles took. */
const TIMER_LOG_PRELOAD = [
  "import { openSync, writeSync } from 'node:fs'",
  'let fd = -1',
  'const base = process.env.TG_E2E_TIMER_LOG',
  'const real = globalThis.setTimeout',
  'globalThis.setTimeout = function (fn, ms, ...rest) {',
  "  try { if (base) { if (fd < 0) fd = openSync(base + '.' + process.pid, 'a'); writeSync(fd, String(ms) + '\\n') } } catch {}",
  '  return real.call(this, fn, ms, ...rest)',
  '}',
  '',
].join('\n')

/** Every delay the daemon `pid` passed to `setTimeout`, in call order, from the log the preload wrote. */
function recordedTimerDelays(logBase: string, pid: number): number[] {
  try {
    return fs.readFileSync(`${logBase}.${pid}`, 'utf8').split('\n').filter((l) => l !== '').map(Number)
  } catch {
    return []
  }
}


/** Hang backstop for every wait on the live daemon: the same 45000ms as each test's own budget, so the budget reports a slow daemon and these only fire for a daemon that is alive and silent. Each wait already ends at once, naming the cause, when the daemon process is gone, so a smaller number here only converted load into failure (the daemon taking over 15000ms to reach its first heartbeat on a loaded machine). Moved 15000/20000 -> 45000: the daemon took over 15000 ms to reach its first heartbeat on a loaded Windows pre-push. */
const DAEMON_WAIT_BACKSTOP_MS = 45000

/** Poll interval handed to the daemon under test. Fast enough that the drain assertion resolves in well under the 2000ms production default, which is what makes that assertion able to detect the default being forced back on. */
const DAEMON_POLL_MS = 200

/** The main test's poll interval: a value no other timer in the daemon uses and no default of this codebase, so seeing it in the recorded timer delays can only mean TG_WORKER_POLL_MS travelled from the `worker start` environment to the loop's sleep. */
const CADENCE_POLL_MS = 237

const tempDirs: string[] = []
function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Best-effort cleanup on Windows if daemon process still has handles
    }
  }
})

describe('detached worker daemon (built bundle)', () => {
  it('bundle contains the real daemon dispatch, not a tree-shaken/unwired stub', () => {
    const bundle = readCoreBundleText()
    // Would be absent from the shipped artifact if runDetachedWorkerDaemon were ever removed or if esbuild tree-shook it out for being unreachable from the entrypoint again.
    expect(bundle).toContain('runDetachedWorkerDaemon')
  })

  it(
    '`worker start` stays alive well past the point the old bug killed it, the daemon cycles at the interval it was given',
    async () => {
      const dataBase = mkIsolated('tg-daemon-data-')
      const repo = mkIsolated('tg-daemon-repo-')
      const probe = mkIsolated('tg-daemon-probe-')
      const env = tgEnv(dataBase, CADENCE_POLL_MS)
      // The preload goes into `worker start` only: the daemon it spawns inherits the environment, and every later command runs without it.
      const preload = path.join(probe, 'timer-log.mjs')
      fs.writeFileSync(preload, TIMER_LOG_PRELOAD)
      const timerLog = path.join(probe, 'timers')
      const startEnv = { ...env, NODE_OPTIONS: `${env['NODE_OPTIONS'] ?? ''} --import ${pathToFileURL(preload).href}`.trim(), TG_E2E_TIMER_LOG: timerLog }
      let pid: number | undefined
      let stop: RunResult

      try {
        // 1. Start the daemon for real, through the actual CLI command a user would run.
        const start = runBundle(['worker', 'start'], startEnv, repo)
        expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
        const m = start.stdout.match(/pid (\d+)/)
        expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
        pid = parseInt((m as RegExpMatchArray)[1], 10)

        // 2. Wait for positive proof the child reached the daemon loop rather than for a fixed interval: runDetachedWorkerDaemon writes its own pid to queue/drain-heartbeat as its first act, so that file naming this pid can only happen on the far side of the argv dispatch the pre-fix bug died at (commander rejected --worker-daemon and the process exited before ever reaching the loop). A dead child never writes it, so that failure still fails here, as soon as the process is seen to be gone.
        const heartbeat = path.join(effectiveDataDir(dataBase), 'queue', 'drain-heartbeat')
        await waitForDaemonHeartbeat(dataBase, pid)

        expect(
          pidAlive(pid),
          'daemon pid is dead -- --worker-daemon was likely rejected by commander again',
        ).toBe(true)

        const status = runBundle(['worker', 'status'], env, repo)
        expect(status.stdout).toContain('Worker is running.')

        // 3. The cycle cadence: TG_WORKER_POLL_MS has to reach the daemon through `worker start`, which used to hardcode the 2000ms default into the child's env regardless of what it inherited. Two heartbeat rewrites after the first mean the daemon has finished at least one between-cycle sleep, so its setTimeout delay is in the log by then; the assertion is on that recorded value, not on how long anything took. With the bug back the daemon asks for 2000, this value never appears, and the assertion fails on every run.
        await waitForDaemonRewrites(heartbeat, 2, pid)
        const delays = recordedTimerDelays(timerLog, pid)
        expect(
          delays,
          `the daemon never asked to sleep ${CADENCE_POLL_MS}ms between cycles -- TG_WORKER_POLL_MS is being ignored again (timer delays it set: ${delays.join(', ')})`,
        ).toContain(CADENCE_POLL_MS)

      } finally {
        // Clean teardown on every path, including a `worker start` whose output never parsed, so this test never leaks a real background process.
        stop = await shutDownDaemon(env, repo, dataBase, pid)
      }
      expect(stop.stdout).toMatch(/Worker stopped\.|No running worker\./)
    },
    45000,
  )

  // The drain proofs below each start their own daemon and own a share of the sequential CLI spawns, so no single test's 45000ms budget has to cover every `symbol` lookup of the old one-test version: that sum, not any one wait, was what a loaded Windows machine ran out of.
  it(
    'the running daemon drains a seeded queue entry into symbols and refs',
    async () => {
      // Provenance: HAND-DERIVED. The fixture is source text written for this test, with the symbol names it must produce read off the text itself.
      await withDrainedDaemon({ 'daemon_e2e_sample.ts': 'export function daemonDrainedSymbol(): number {\n  return 1\n}\nexport function daemonCaller(): number {\n  return daemonDrainedSymbol()\n}\n' }, (env, repo) => {
        const sym = runBundle(['symbol', 'daemonDrainedSymbol'], env, repo)
        expect(sym.status, `symbol stderr: ${sym.stderr}`).toBe(0)
        expect(sym.stdout).toContain('daemonDrainedSymbol')

        // Provenance: HAND-DERIVED. The seeded file calls daemonDrainedSymbol from daemonCaller, so a daemon that writes symbols but drops the refs rows leaves `callers` empty while `symbol` above still resolves.
        const callers = runBundle(['callers', 'daemonDrainedSymbol'], env, repo)
        expect(callers.status, `callers stderr: ${callers.stderr}`).toBe(0)
        expect(callers.stdout).toContain('daemonCaller')
      })
    },
    45000,
  )

  // Regex-adapter languages load through parser.ts's dynamic import (loadRegexExtractors), which the drain loop awaits before its first cycle. Miss that await and the daemon indexes these files to nothing, while the tree-sitter file in the test above still resolves -- so only these prove the lazy load reached the daemon.
  it(
    'the running daemon drains files of lazily loaded adapters (Fortran, Salesforce Aura)',
    async () => {
      // Provenance: HAND-DERIVED. Source text written for this test, with the names it must produce read off the text itself.
      await withDrainedDaemon({
        'daemon_e2e_sample.f90': 'subroutine daemon_drained_fortran(x)\n  integer :: x\n  x = 1\nend subroutine daemon_drained_fortran\n',
        'daemon_e2e_sample.cmp': '<aura:component>\n  <aura:attribute name="daemonDrainedAttr" type="String"/>\n</aura:component>\n',
      }, (env, repo) => {
        const fortranSym = runBundle(['symbol', 'daemon_drained_fortran'], env, repo)
        expect(fortranSym.status, `symbol stderr: ${fortranSym.stderr}`).toBe(0)
        expect(fortranSym.stdout).toContain('daemon_drained_fortran')

        // The Salesforce frontend adapters load through the same lazy path as the registry; an Aura attribute resolving proves the daemon awaited that load too.
        const auraSym = runBundle(['symbol', 'daemonDrainedAttr'], env, repo)
        expect(auraSym.status, `symbol stderr: ${auraSym.stderr}`).toBe(0)
        expect(auraSym.stdout).toContain('daemonDrainedAttr')
      })
    },
    45000,
  )

  // Regression: the daemon inherited the working directory of whatever started it. `worker start` and the hook auto-restart both run inside the user's project, and on Windows a working directory is an open handle, so a daemon started from a throwaway directory (an evaluation harness's per-run working copy) kept that directory undeletable until the daemon died.
  it(
    '`worker start` run from a throwaway directory leaves that directory deletable while the daemon lives',
    async () => {
      const dataBase = mkIsolated('tg-daemon-data-')
      const trigger = mkIsolated('tg-daemon-trigger-')
      const env = tgEnv(dataBase, DAEMON_POLL_MS)
      let pid: number | undefined
      try {
        const start = runBundle(['worker', 'start'], env, trigger)
        expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
        const m = start.stdout.match(/pid (\d+)/)
        expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
        pid = parseInt((m as RegExpMatchArray)[1], 10)
        await waitForDaemonHeartbeat(dataBase, pid)
        expectDirectoryReleasedBy(pid, trigger)
      } finally {
        // Run from the data base: the trigger directory is gone once the assertion above has passed.
        await shutDownDaemon(env, dataBase, dataBase, pid)
      }
    },
    45000,
  )

  // The same, for a daemon nothing spawned with a working directory of its own: an older client, or someone running `--worker-daemon` by hand. The daemon's own entry has to move off the directory it was started in.
  it(
    'a daemon started directly with --worker-daemon moves off the directory it was started in',
    async () => {
      const dataBase = mkIsolated('tg-daemon-data-')
      const trigger = mkIsolated('tg-daemon-trigger-')
      const dataDir = effectiveDataDir(dataBase)
      fs.mkdirSync(dataDir, { recursive: true })
      const child = spawn(process.execPath, [BUNDLE, '--worker-daemon'], {
        cwd: trigger,
        env: { ...tgEnv(dataBase, DAEMON_POLL_MS), TG_WORKER_DATA_DIR: dataDir },
        stdio: 'ignore',
        windowsHide: true,
      })
      const pid = child.pid
      try {
        expect(pid, 'spawning the bundle produced no pid').toBeDefined()
        await waitForDaemonHeartbeat(dataBase, pid as number)
        expectDirectoryReleasedBy(pid as number, trigger)
      } finally {
        await stopDaemon(pid)
      }
    },
    45000,
  )
})

/** Start a real daemon through `worker start`, write `files` (name -> text) into a repo and queue them with the producer the hooks use, wait for the daemon to drain the queue, then run `lookups`. The daemon is shut down on every path. */
async function withDrainedDaemon(files: Record<string, string>, lookups: (env: NodeJS.ProcessEnv, repo: string) => void): Promise<void> {
  const dataBase = mkIsolated('tg-daemon-data-')
  const repo = mkIsolated('tg-daemon-repo-')
  const env = tgEnv(dataBase, DAEMON_POLL_MS)
  let pid: number | undefined
  try {
    const start = runBundle(['worker', 'start'], env, repo)
    expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
    const m = start.stdout.match(/pid (\d+)/)
    expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
    pid = parseInt((m as RegExpMatchArray)[1], 10)
    await waitForDaemonHeartbeat(dataBase, pid)
    const written = Object.entries(files).map(([name, text]) => {
      const file = path.join(repo, name)
      fs.writeFileSync(file, text)
      return file
    })
    // The queue producer the hooks use, which appends in one write and writes again when the daemon claims the queue under it, so a claim can never take a half-written queue.
    const queueDir = path.join(effectiveDataDir(dataBase), 'queue')
    expect(appendDirtyQueuePaths(effectiveDataDir(dataBase), written)).toBe(true)
    // The wait ends when the queue is gone: a drain renames dirty.txt to dirty.txt.draining, indexes the batch, and only then removes that file, so no queue file left means the batch was committed. Embeddings are off for the suite, so nothing requeues behind it.
    await waitForDaemon('the running daemon to drain the seeded queue entries', DAEMON_WAIT_BACKSTOP_MS, pid, () => !fs.readdirSync(queueDir).some((name) => name.startsWith('dirty.txt')))
    // One lookup per fixture, after the drain: a daemon that drained into a stub, or dropped refs or a lazily loaded adapter's rows, fails right here rather than being waited on.
    lookups(env, repo)
  } finally {
    await shutDownDaemon(env, repo, dataBase, pid)
  }
}

/** Wait until the daemon `pid` has written its drain heartbeat: `runDetachedWorkerDaemon` writes it only after it has moved to its own working directory, so a heartbeat naming `pid` means that move has already happened. */
async function waitForDaemonHeartbeat(dataBase: string, pid: number): Promise<void> {
  const heartbeat = path.join(effectiveDataDir(dataBase), 'queue', 'drain-heartbeat')
  await waitForDaemon('the daemon to write its drain heartbeat', DAEMON_WAIT_BACKSTOP_MS, pid, () => {
    try {
      return fs.readFileSync(heartbeat, 'utf8').trim() === String(pid)
    } catch {
      return false
    }
  })
}

/** `waitFor` for a condition only the live daemon `pid` can bring about: the wait also ends, with a failure naming the cause, the moment that process is gone, so a daemon that crashed is reported at once instead of after the whole backstop. */
async function waitForDaemon(label: string, timeoutMs: number, pid: number, check: () => boolean): Promise<void> {
  await waitFor(label, timeoutMs, () => {
    if (check()) return true
    if (!pidAlive(pid)) throw new Error(`the daemon (pid ${pid}) exited while waiting for: ${label}`)
    return false
  })
}

/** Stop whatever daemon a test started, on any path. The pid file is read before `worker stop` removes it, because it is the only record of the daemon when `worker start` failed before its output could be parsed; both pids are then terminated if still alive. Returns the `worker stop` result. */
async function shutDownDaemon(env: NodeJS.ProcessEnv, cwd: string, dataBase: string, startedPid: number | undefined): Promise<RunResult> {
  let recorded: number | undefined
  try {
    const raw = fs.readFileSync(path.join(effectiveDataDir(dataBase), 'worker.pid'), 'utf8').trim()
    if (/^\d+$/.test(raw)) recorded = parseInt(raw, 10)
  } catch {
    // no pid file: nothing recorded one
  }
  try {
    return runBundle(['worker', 'stop'], env, cwd)
  } finally {
    for (const pid of new Set([startedPid, recorded])) await stopDaemon(pid)
  }
}

/** Assert the live daemon `pid` does not hold `dir` as its working directory. On Windows that handle is what blocks deleting `dir`, so the delete is the assertion; Linux lets a working directory be deleted, so there the kernel's record of it is checked first. macOS offers neither cheaply, and there only the delete runs. */
function expectDirectoryReleasedBy(pid: number, dir: string): void {
  expect(pidAlive(pid), 'the daemon died before its working directory could be checked').toBe(true)
  if (process.platform === 'linux') {
    expect(fs.readlinkSync(`/proc/${pid}/cwd`)).not.toBe(fs.realpathSync(dir))
  }
  // Retries absorb a brief handle from a virus scanner or indexer; a directory pinned as a working directory stays pinned through all of them.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  expect(fs.existsSync(dir)).toBe(false)
}

/** Terminate a daemon a test started, so no test leaves a real background process behind. */
async function stopDaemon(pid: number | undefined): Promise<void> {
  if (pid === undefined || !pidAlive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
  await waitFor('the daemon to exit', 5000, () => !pidAlive(pid)).catch(() => undefined)
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

// POSIX only: a mode bit is how this platform refuses a directory write, and root ignores it. Windows refuses through an ACL, which tests/worker_unwritable_data_dir.test.ts covers through the same probe.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('`worker start` on a data directory mode 0555 (built bundle)', () => {
  // Regression: the daemon was spawned before the first write into the directory, so the pid-file claim threw EACCES with the child still referenced, and `worker start` hung on it until the timeout.
  it('exits promptly with the directory named, and writes no pid file', () => {
    const dataBase = mkIsolated('tg-daemon-ro-')
    const repo = mkIsolated('tg-daemon-ro-repo-')
    const dir = effectiveDataDir(dataBase)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o555)
    try {
      const res = runBundle(['worker', 'start'], tgEnv(dataBase), repo)
      expect(res.status).toBe(1)
      expect(res.stderr).toContain(`${dir} cannot be written`)
      expect(fs.existsSync(path.join(dir, 'worker.pid'))).toBe(false)
    } finally {
      fs.chmodSync(dir, 0o755)
    }
  })
})
