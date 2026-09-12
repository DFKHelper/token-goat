/**
 * Every enqueue path must revive a dead worker, not just `hooks_edit.ts`'s.
 *
 * `ensureWorkerAlive` (auto-heal: spawn a fresh detached worker if none is running) had exactly
 * one caller in `src/` -- `hooks_edit.ts::postEditHandler`, the Claude Code / Codex post-edit hook.
 * Every OTHER path that appends to the dirty queue (a Bash-hook file rewrite, `token-goat replace`,
 * `write-file`, `read_commands.ts`'s self-heal enqueue, `fold_delivery.ts`) never called it: if the
 * worker had died (crash, a manual kill, a machine sleep/wake race) before one of those paths ran,
 * the file it just enqueued sat in `queue/dirty.txt` forever with nothing ever draining it, and
 * nothing about the CLI call itself failing or warning -- the command reported success. The fix
 * moves the `ensureWorkerAlive` call into `hooks_index.ts::enqueueDirtyPathSafe`, the one function
 * every one of those paths already calls to append the entry in the first place.
 *
 * Driven against the REAL built bundle with a REAL dead worker (a stale pid file naming a pid that
 * is not running) and `TOKEN_GOAT_NO_WORKER_SPAWN` explicitly unset (deleted, not merely left
 * `undefined`, since it would otherwise inherit '1' from this suite's own
 * tests/setup/isolate-home.ts through `spawnSync`'s env spread) -- this is the one test in this
 * repo that deliberately lets `token-goat` spawn a real detached worker process, and it cleans up
 * with `worker stop` in `finally` the same way `worker_daemon_e2e.test.ts` does.
 *
 * Provenance: CAPTURE. `token-goat replace` is run for real against a real file, and the daemon's
 * own heartbeat file is polled for real, not asserted on the source implementing this fix.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runBundle(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
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

async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    await sleep(50)
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
    const repo = mkIsolated('tg-enqueue-revive-repo-')
    // Real spawn is what this test is about: unset the isolation env this suite's own
    // tests/setup/isolate-home.ts pins to '1' in THIS process, or it would ride along via
    // spawnSync's `...process.env` spread and silently make ensureWorkerAlive a no-op.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dataBase, USERPROFILE: dataBase, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }
    delete env['TOKEN_GOAT_NO_WORKER_SPAWN']

    const dataDir = effectiveDataDir(dataBase)
    const queueDir = path.join(dataDir, 'queue')
    fs.mkdirSync(queueDir, { recursive: true })
    // A stale pid file naming a pid that is certainly not running: isWorkerRunning must see this
    // as dead, not accidentally alive (a real running pid would make ensureWorkerAlive correctly
    // no-op, and this test would then prove nothing).
    const deadPid = 999999
    fs.writeFileSync(path.join(queueDir, 'worker.pid'), `${deadPid}\n`)

    const target = path.join(repo, 'sample.ts')
    fs.writeFileSync(target, 'export const before = 1\n')

    const indexed = runBundle(['index', '.', '--walk'], env, repo)
    expect(indexed.status, `index failed: ${indexed.stderr.slice(0, 400)}`).toBe(0)

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

      // The actual point of the fix: a heartbeat only a freshly spawned daemon writes.
      const heartbeat = path.join(queueDir, 'drain-heartbeat')
      await waitFor('a fresh worker (spawned by the replace call, not by hand) to write its heartbeat', 15000, () => {
        try {
          const pid = parseInt(fs.readFileSync(heartbeat, 'utf8').trim(), 10)
          return Number.isFinite(pid) && pid !== deadPid
        } catch {
          return false
        }
      })

      const status = runBundle(['worker', 'status'], env, repo)
      expect(status.stdout).toContain('Worker is running.')
    } finally {
      runBundle(['worker', 'stop'], env, repo)
    }
  }, 30000)

  it('calibration: with the dead pid left in place and no enqueue call, the worker never comes alive on its own', async () => {
    const dataBase = mkIsolated('tg-enqueue-revive-calib-data-')
    const repo = mkIsolated('tg-enqueue-revive-calib-repo-')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dataBase, USERPROFILE: dataBase, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }
    delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
    const dataDir = effectiveDataDir(dataBase)
    const queueDir = path.join(dataDir, 'queue')
    fs.mkdirSync(queueDir, { recursive: true })
    fs.writeFileSync(path.join(queueDir, 'worker.pid'), '999999\n')

    // Give it the same window the real test waits up to, doing nothing in between: if a worker
    // came alive here, something ELSE in this environment spawns it and the test above would
    // prove nothing.
    await sleep(500)
    const status = runBundle(['worker', 'status'], env, repo)
    expect(status.stdout).not.toContain('Worker is running.')
  })
})
