/** The built bundle's real `--worker-daemon` must retire on its own, on the default path: no injected loop, no stubbed lifecycle. Three ways an abandoned daemon used to live forever, each driven through `worker start` against an isolated data home: `stopWorker` landing before the daemon's first heartbeat, the pid file disappearing, and an empty queue. See tests/worker_retire.test.ts for the same rules at unit level with short periods. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, runBundle as sharedRunBundle, tgIsolatedEnv, type RunResult } from './helpers/bundle.js'
import { isWorkerDaemonCommandLine, killAllIfCommandLine } from './helpers/kill_if_command_line.js'
import { indexableDir } from './helpers/temp-config.js'
import { stopWorker, WORKER_STARTUP_GRACE_MS, workerPidPath } from '../src/worker_lifecycle.js'

/** Dirty paths queued behind a running daemon: enough that one drain cycle takes longer than the startup grace. */
const MID_DRAIN_FILES = 12000
const MID_DRAIN_WRITE_BATCH = 128

function runBundle(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  return sharedRunBundle(args, { cwd, env, timeout: 30000 })
}

/** Mirrors constants.ts's defaultDataDir() platform join; see worker_daemon_e2e.test.ts for why it cannot be imported. */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  return path.join(base, 'token-goat')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Resolves once `check` holds. It has no deadline of its own, so a slow machine only makes it take longer: the wait ends on the event, on `abandon` naming that the event can no longer come (the process waited on has died), or on `signal`, which the test's own timeout aborts. */
async function waitFor(label: string, signal: AbortSignal, check: () => boolean, abandon?: () => string | null): Promise<void> {
  while (!check()) {
    const reason = abandon?.() ?? null
    if (reason !== null) throw new Error(`${reason} while waiting for: ${label}`)
    if (signal.aborted) throw new Error(`the test ended while waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Names a daemon that has exited, for a wait that needs it running. */
function exitedNote(pid: number): () => string | null {
  return () => (alive(pid) ? null : `the daemon (pid ${pid}) exited`)
}

function heartbeatNames(dataBase: string, pid: number): boolean {
  try {
    return fs.readFileSync(path.join(effectiveDataDir(dataBase), 'queue', 'drain-heartbeat'), 'utf8').trim() === String(pid)
  } catch {
    return false
  }
}

const tempDirs: string[] = []
const startedPids: number[] = []
function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Only pids this file started: a daemon that retired is already gone, and one that did not is killed so a failing run never leaves it behind. */
function reapStarted(readCommandLine?: (pid: number) => string | null): void {
  killAllIfCommandLine(startedPids.splice(0), isWorkerDaemonCommandLine, readCommandLine === undefined ? {} : { readCommandLine })
}

afterEach(() => {
  try {
    reapStarted()
  } finally {
    for (const d of tempDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      } catch {
        // a daemon that holds global.db open keeps the folder on Windows; the pid kill above is what matters
      }
    }
  }
})

/** The test saw `pid` exit, so its number is free for the OS to give to any other process, and the cleanup above must neither read nor signal whatever holds it now. A stranger whose command line the query cannot read makes killIfCommandLine throw, because it cannot be told from a daemon that is still running. */
function observedGone(pid: number): void {
  const at = startedPids.indexOf(pid)
  if (at !== -1) startedPids.splice(at, 1)
}

function startWorker(env: NodeJS.ProcessEnv, cwd: string): number {
  const start = runBundle(['worker', 'start'], env, cwd)
  expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
  const m = start.stdout.match(/pid (\d+)/)
  expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
  const pid = parseInt((m as RegExpMatchArray)[1]!, 10)
  startedPids.push(pid)
  return pid
}

describe('the built daemon retires on its own', () => {
  it(
    'exits after its pid file is deleted, without a stop',
    async (ctx) => {
      const dataBase = mkIsolated('tg-retire-e2e-pidfile-')
      const repo = mkIsolated('tg-retire-e2e-repo-')
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' })
      const dir = effectiveDataDir(dataBase)
      const pid = startWorker(env, repo)
      await waitFor('the daemon to write its drain heartbeat', ctx.signal, () => heartbeatNames(dataBase, pid), exitedNote(pid))
      expect(fs.readFileSync(workerPidPath(dir), 'utf8').trim()).toBe(String(pid))

      // What a `rm -rf` of the data home does on Windows to a daemon holding global.db: the pid file goes, the folder stays.
      fs.rmSync(workerPidPath(dir))

      await waitFor('the daemon to retire after its pid file went missing', ctx.signal, () => !alive(pid))
      observedGone(pid)
      expect(startedPids, 'a pid seen to exit is not examined again').not.toContain(pid)
    },
    60000,
  )

  it(
    'exits within the startup grace plus 5 s of its pid file going missing, even while a long drain is running',
    async (ctx) => {
      const dataBase = mkIsolated('tg-retire-e2e-middrain-')
      const repo = mkIsolated('tg-retire-e2e-middrain-repo-')
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' })
      const dir = effectiveDataDir(dataBase)
      const pid = startWorker(env, repo)
      await waitFor('the daemon to write its drain heartbeat', ctx.signal, () => heartbeatNames(dataBase, pid), exitedNote(pid))

      // Enough dirty paths that one drain cycle outlasts the grace: the daemon checks its pid file between cycles, so a pid file removed mid-cycle used to be noticed only when the cycle ended.
      const queued: string[] = []
      for (let base = 0; base < MID_DRAIN_FILES; base += MID_DRAIN_WRITE_BATCH) {
        const writes: Promise<void>[] = []
        const batchEnd = Math.min(base + MID_DRAIN_WRITE_BATCH, MID_DRAIN_FILES)
        for (let i = base; i < batchEnd; i++) {
          const file = path.join(repo, `queued_${i}.ts`)
          queued.push(file)
          writes.push(fs.promises.writeFile(file, `export const q${i} = ${i}\n`))
        }
        await Promise.all(writes)
      }
      fs.appendFileSync(path.join(dir, 'queue', 'dirty.txt'), `${queued.join('\n')}\n`)
      await waitFor('the daemon to claim the queue into a drain', ctx.signal, () => fs.existsSync(path.join(dir, 'queue', 'dirty.txt.draining')), exitedNote(pid))

      fs.rmSync(workerPidPath(dir))
      const removedAt = Date.now()
      await waitFor('the daemon to retire after its pid file went missing', ctx.signal, () => !alive(pid))
      const retiredAfterMs = Date.now() - removedAt
      observedGone(pid)
      expect(retiredAfterMs, `the daemon outlived its pid file by ${retiredAfterMs} ms`).toBeLessThanOrEqual(WORKER_STARTUP_GRACE_MS + 5000)
      const liveQueue = path.join(dir, 'queue', 'dirty.txt')
      expect(fs.existsSync(liveQueue), 'the retiring drain must hand back its unreached paths').toBe(true)
      expect(fs.readFileSync(liveQueue, 'utf8').trim()).not.toBe('')
    },
    60000,
  )

  it(
    'exits after the idle period, and the next enqueue starts a fresh one',
    async (ctx) => {
      const dataBase = mkIsolated('tg-retire-e2e-idle-')
      const repo = indexableDir()
      // Real spawn is the point: the suite pins TOKEN_GOAT_NO_WORKER_SPAWN=1 in this process and it would ride along into the CLI and turn ensureWorkerAlive into a no-op.
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200', TG_WORKER_IDLE_EXIT_MS: '1500' })
      delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
      const dir = effectiveDataDir(dataBase)
      const pid = startWorker(env, repo)
      await waitFor('the daemon to write its drain heartbeat', ctx.signal, () => heartbeatNames(dataBase, pid), exitedNote(pid))

      await waitFor('the idle daemon to exit', ctx.signal, () => !alive(pid))
      observedGone(pid)
      expect(startedPids, 'a pid seen to exit is not examined again').not.toContain(pid)
      // Its exit handler removes the pid file it owned, so the next ensureWorkerAlive sees no daemon.
      expect(fs.existsSync(workerPidPath(dir)), 'a retired daemon left its pid file behind').toBe(false)

      // The commands after the retirement run without the short idle period, so the daemon they start is still there to be seen.
      const laterEnv = { ...env }
      delete laterEnv['TG_WORKER_IDLE_EXIT_MS']
      const target = path.join(repo, 'idle_respawn_sample.ts')
      fs.writeFileSync(target, 'export const idleRespawn = 1\n')
      const oldFrom = path.join(repo, 'old.txt')
      const newFrom = path.join(repo, 'new.txt')
      fs.writeFileSync(oldFrom, 'idleRespawn = 1')
      fs.writeFileSync(newFrom, 'idleRespawn = 2')
      const replaced = runBundle(['replace', target, '--old-from', oldFrom, '--new-from', newFrom], laterEnv, repo)
      expect(replaced.status, `replace failed: ${replaced.stderr.slice(0, 400)}`).toBe(0)

      let fresh: number | undefined
      await waitFor('an enqueue to start a fresh daemon', ctx.signal, () => {
        try {
          const pidNow = parseInt(fs.readFileSync(path.join(dir, 'queue', 'drain-heartbeat'), 'utf8').trim(), 10)
          if (Number.isFinite(pidNow) && pidNow !== pid) {
            fresh = pidNow
            return true
          }
        } catch {
          // not written yet
        }
        return false
      })
      if (fresh !== undefined) startedPids.push(fresh)
      expect(runBundle(['worker', 'status'], laterEnv, repo).stdout).toContain('Worker is running.')
    },
    90000,
  )

  it(
    'is killed by a stop that lands before its first heartbeat, instead of being left running with no pid file',
    async (ctx) => {
      const dataBase = mkIsolated('tg-retire-e2e-race-')
      const dir = effectiveDataDir(dataBase)
      fs.mkdirSync(dir, { recursive: true })
      const child = spawn(process.execPath, [BUNDLE, '--worker-daemon'], {
        cwd: os.tmpdir(),
        env: { ...tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' }), TG_WORKER_DATA_DIR: dir },
        stdio: 'ignore',
        windowsHide: true,
      })
      const pid = child.pid as number
      expect(pid, 'spawning the bundle produced no pid').toBeDefined()
      startedPids.push(pid)
      // What startDetachedWorker does right after the spawn. The child has not booted, so it has written no heartbeat: the same state a CPU-starved daemon is in when `worker stop` arrives.
      fs.writeFileSync(workerPidPath(dir), `${pid}\n`)

      // The daemon runs on the bundle, not on the launcher this test process would resolve from source, so the identity check is told which launcher is the install's.
      stopWorker(dir, undefined, { entryScript: BUNDLE })

      await waitFor('the daemon stopped inside its startup grace to die', ctx.signal, () => !alive(pid))
      observedGone(pid)
      expect(startedPids, 'a pid seen to exit is not examined again').not.toContain(pid)
    },
    45000,
  )
})

describe('the cleanup of the pids this file started', () => {
  it('does not read or signal a pid it saw exit, whose number another process may hold by now', () => {
    // The stand-in is a live process holding the number, as a stranger does after the daemon's exit; its command line is unreadable, which makes killIfCommandLine throw for any pid still listed.
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true })
    try {
      const pid = stranger.pid as number
      const reads: number[] = []
      const unreadable = (p: number): null => {
        reads.push(p)
        return null
      }
      startedPids.push(pid)
      expect(() => reapStarted(unreadable), 'control: a listed pid that is alive and unreadable stops the cleanup').toThrow(/could not be read/)
      expect(reads).toStrictEqual([pid])

      reads.length = 0
      startedPids.push(pid)
      observedGone(pid)
      reapStarted(unreadable)
      expect(reads, 'a pid seen to exit was read anyway').toStrictEqual([])
    } finally {
      stranger.kill('SIGKILL')
    }
  })
})
