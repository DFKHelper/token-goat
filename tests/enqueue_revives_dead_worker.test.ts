/** Every enqueue path must revive a dead worker, not just `hooks_edit.ts`'s. `ensureWorkerAlive` (auto-heal: spawn a fresh detached worker if none is running) had exactly one caller in `src/` -- `hooks_edit.ts::postEditHandler`, the Claude Code / Codex post-edit hook. Every OTHER path that appends to the dirty queue (a Bash-hook file rewrite, `token-goat replace`, `write-file`, `read_commands.ts`'s self-heal enqueue, `fold_delivery.ts`) never called it: if the worker had died (crash, a manual kill, a machine sleep/wake race) before one of those paths ran, the file it just enqueued sat in `queue/dirty.txt` forever with nothing ever draining it, and nothing about the CLI call itself failing or warning -- the command reported success. The fix moves the `ensureWorkerAlive` call into `hooks_index.ts::enqueueDirtyPathSafe`, the one function every one of those paths already calls to append the entry in the first place. Driven against the REAL built bundle with a REAL dead worker (a stale pid file naming a pid that is not running) and `TOKEN_GOAT_NO_WORKER_SPAWN` explicitly unset (deleted, not merely left `undefined`, since it would otherwise inherit '1' from this suite's own tests/setup/isolate-home.ts through `spawnSync`'s env spread) -- this is the one test in this repo that deliberately lets `token-goat` spawn a real detached worker process, and it cleans up with `worker stop` in `finally` the same way `worker_daemon_e2e.test.ts` does. Provenance: CAPTURE. `token-goat replace` is run for real against a real file, and the daemon's own heartbeat file is polled for real, not asserted on the source implementing this fix. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runBundle as sharedRunBundle, type RunResult } from './helpers/bundle.js'
import { indexableDir } from './helpers/temp-config.js'

function runBundle(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  return sharedRunBundle(args, { cwd, env, timeout: 30000 })
}

/** Mirrors constants.ts's defaultDataDir() platform join -- see worker_daemon_e2e.test.ts's identical helper for why this can't just import constants.ts. */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  if (process.platform === 'darwin') return path.join(base, 'token-goat')
  return path.join(base, 'token-goat')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls until `check` is true. `deadline` is an absolute time and only a backstop: a check that can tell the thing it waits for will never happen throws at once instead. */
async function waitFor(label: string, deadline: number, check: () => boolean, state: () => string = () => ''): Promise<void> {
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${label}; ${state()}`)
    await sleep(50)
  }
}

function readPid(file: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
      // best-effort cleanup
    }
  }
})

describe('a CLI enqueue path revives a dead worker (not just the edit hook)', () => {
  it('token-goat replace spawns a fresh worker when the recorded one is dead', async () => {
    const dataBase = mkIsolated('tg-enqueue-revive-data-')
    const repo = indexableDir()
    // Real spawn is what this test is about: unset the isolation env this suite's own tests/setup/isolate-home.ts pins to '1' in THIS process, or it would ride along via spawnSync's `...process.env` spread and silently make ensureWorkerAlive a no-op.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dataBase, USERPROFILE: dataBase, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }
    delete env['TOKEN_GOAT_NO_WORKER_SPAWN']

    const started = Date.now()
    const dataDir = effectiveDataDir(dataBase)
    const queueDir = path.join(dataDir, 'queue')
    const pendingState = (): string => {
      const pid = readPid(path.join(queueDir, 'worker.pid'))
      const beat = readPid(path.join(queueDir, 'drain-heartbeat'))
      return `worker.pid=${String(pid)} alive=${pid === null ? 'n/a' : String(pidAlive(pid))} heartbeat=${String(beat)} alive=${beat === null ? 'n/a' : String(pidAlive(beat))} after ${Date.now() - started}ms`
    }
    fs.mkdirSync(queueDir, { recursive: true })
    // A stale pid file naming a pid that is certainly not running: isWorkerRunning must see this as dead, not accidentally alive (a real running pid would make ensureWorkerAlive correctly no-op, and this test would then prove nothing).
    const deadPid = 999999
    fs.writeFileSync(path.join(queueDir, 'worker.pid'), `${deadPid}\n`)

    const target = path.join(repo, 'sample.ts')
    fs.writeFileSync(target, 'export const before = 1\n')

    // No `index` step: the replace below queues the file for the worker whether or not the project was ever indexed, and an index run would only add parse work that the lowered indexing priority makes slow on a busy machine, which is not what this test measures.

    const oldFrom = path.join(repo, 'old.txt')
    const newFrom = path.join(repo, 'new.txt')
    fs.writeFileSync(oldFrom, 'before = 1')
    fs.writeFileSync(newFrom, 'before = 2')

    try {
      const replaced = runBundle(
        ['replace', target, '--old-from', oldFrom, '--new-from', newFrom],
        env,
        repo,
      )
      expect(replaced.status, `replace failed: ${replaced.stderr.slice(0, 400)}`).toBe(0)
      expect(fs.readFileSync(target, 'utf8')).toContain('before = 2')

      // What takes time is the spawned daemon's cold start to its first drain cycle, which on a busy machine runs at the lowered priority for tens of seconds, so the wait is on the heartbeat a fresh daemon writes. The deadline is a backstop just under the test's own 30 s limit, so that a real failure to revive reports the pending state instead of a bare vitest timeout; a worker that was never spawned leaves no heartbeat and still fails there.
      const heartbeat = path.join(queueDir, 'drain-heartbeat')
      await waitFor('a fresh worker (spawned by the replace call, not by hand) to write its heartbeat', started + 27000, () => {
        const pid = readPid(heartbeat)
        return pid !== null && pid !== deadPid
      }, pendingState)

      const status = runBundle(['worker', 'status'], env, repo)
      expect(status.stdout).toContain('Worker is running.')
    } finally {
      runBundle(['worker', 'stop'], env, repo)
    }
  }, 30000)

  it('calibration: with the dead pid left in place and no enqueue call, the worker never comes alive on its own', async () => {
    const dataBase = mkIsolated('tg-enqueue-revive-calib-data-')
    const repo = indexableDir()
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dataBase, USERPROFILE: dataBase, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }
    delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
    const dataDir = effectiveDataDir(dataBase)
    const queueDir = path.join(dataDir, 'queue')
    fs.mkdirSync(queueDir, { recursive: true })
    fs.writeFileSync(path.join(queueDir, 'worker.pid'), '999999\n')

    // Give it the same window the real test waits up to, doing nothing in between: if a worker came alive here, something ELSE in this environment spawns it and the test above would prove nothing.
    await sleep(500)
    const status = runBundle(['worker', 'status'], env, repo)
    expect(status.stdout).not.toContain('Worker is running.')
  })
})
