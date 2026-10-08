/** The built bundle's real `--worker-daemon` must retire on its own, on the default path: no injected loop, no stubbed lifecycle. Three ways an abandoned daemon used to live forever, each driven through `worker start` against an isolated data home: `stopWorker` landing before the daemon's first heartbeat, the pid file disappearing, and an empty queue. See tests/worker_retire.test.ts for the same rules at unit level with short periods. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, runBundle as sharedRunBundle, tgIsolatedEnv, type RunResult } from './helpers/bundle.js'
import { indexableDir } from './helpers/temp-config.js'
import { stopWorker, workerPidPath } from '../src/worker_lifecycle.js'

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

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
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
afterEach(() => {
  for (const pid of startedPids.splice(0)) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // a daemon that holds global.db open keeps the folder on Windows; the pid kill above is what matters
    }
  }
})

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
    async () => {
      const dataBase = mkIsolated('tg-retire-e2e-pidfile-')
      const repo = mkIsolated('tg-retire-e2e-repo-')
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' })
      const dir = effectiveDataDir(dataBase)
      const pid = startWorker(env, repo)
      await waitFor('the daemon to write its drain heartbeat', 15000, () => heartbeatNames(dataBase, pid))
      expect(fs.readFileSync(workerPidPath(dir), 'utf8').trim()).toBe(String(pid))

      // What a `rm -rf` of the data home does on Windows to a daemon holding global.db: the pid file goes, the folder stays.
      fs.rmSync(workerPidPath(dir))

      await waitFor('the daemon to retire after its pid file went missing', 30000, () => !alive(pid))
    },
    60000,
  )

  it(
    'exits after the idle period, and the next enqueue starts a fresh one',
    async () => {
      const dataBase = mkIsolated('tg-retire-e2e-idle-')
      const repo = indexableDir()
      // Real spawn is the point: the suite pins TOKEN_GOAT_NO_WORKER_SPAWN=1 in this process and it would ride along into the CLI and turn ensureWorkerAlive into a no-op.
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200', TG_WORKER_IDLE_EXIT_MS: '1500' })
      delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
      const dir = effectiveDataDir(dataBase)
      const pid = startWorker(env, repo)
      await waitFor('the daemon to write its drain heartbeat', 15000, () => heartbeatNames(dataBase, pid))

      await waitFor('the idle daemon to exit', 30000, () => !alive(pid))
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
      await waitFor('an enqueue to start a fresh daemon', 20000, () => {
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
    async () => {
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

      stopWorker(dir)

      await waitFor('the daemon stopped inside its startup grace to die', 15000, () => !alive(pid))
    },
    45000,
  )
})
