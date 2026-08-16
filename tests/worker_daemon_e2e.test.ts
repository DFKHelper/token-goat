/**
 * End-to-end proof that `token-goat worker start` actually keeps a background
 * daemon running and draining the dirty queue, against the BUILT bundle
 * (dist/token-goat.mjs).
 *
 * Regression for: {@link import('../src/worker.js').startDetachedWorker} spawns
 * `node <bundle> --worker-daemon`, but the bundle's real entrypoint
 * (main.ts -> cli.ts::run()) used to call commander's `parseAsync()`
 * unconditionally, with no pre-check for `--worker-daemon` -- commander has no
 * such registered option or command, so it rejected the flag as unknown and
 * the freshly-spawned daemon child exited (code 1) before ever reaching the
 * daemon loop. `token-goat worker start` reported a pid (the spawn call
 * itself succeeds and returns a pid even for a child that is about to crash),
 * but `token-goat worker status` moments later reported "not running" -- the
 * entire detached background-indexing feature was silently non-functional.
 *
 * A unit test that mocks the daemon dispatch (as worker_daemon.test.ts and
 * most of worker.test.ts do) cannot catch this: the bug is in argv wiring at
 * the real process entrypoint, which only spawning the actual built bundle
 * exercises. This test drives `worker start` for real, confirms the daemon
 * process is still alive well past the point the old bug already killed it,
 * then proves it does real work by seeding a real dirty-queue entry and
 * confirming the running daemon (not a manual `index` call) drains it.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, CORE_BUNDLE } from './helpers/bundle.js'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runBundle(args: string[], env: NodeJS.ProcessEnv, cwd: string): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** `pollMs` is forwarded to the daemon as TG_WORKER_POLL_MS, so the drain assertions below do not have to wait out the 2000ms production default. */
function tgEnv(base: string, pollMs?: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: base,
    USERPROFILE: base,
    LOCALAPPDATA: base,
    XDG_DATA_HOME: base,
    ...(pollMs === undefined ? {} : { TG_WORKER_POLL_MS: String(pollMs) }),
  }
}

/**
 * Mirrors src/constants.ts's private defaultDataDir() platform join, so this test can locate
 * the same queue/dirty.txt and global.db the daemon uses without importing constants.ts --
 * that module caches its DATA_DIR once at first import from whatever LOCALAPPDATA/XDG_DATA_HOME
 * the test worker process happened to start with, not the per-test temp base this file passes
 * to the spawned bundle. darwin now also honors an XDG_DATA_HOME override (same env this
 * helper's caller already sets) before falling back to the Library/Application Support path --
 * matching defaultDataDir()'s darwin branch fix (was previously HOME-only, always ignoring the
 * override this file already passed).
 */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  if (process.platform === 'darwin') return path.join(base, 'token-goat')
  return path.join(base, 'token-goat')
}

/** Signal-0 liveness probe, mirroring worker.ts's own pidAlive. */
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

/**
 * Poll `check` every 50ms until it returns true, then return how long that took. Throws with
 * `label` once `timeoutMs` elapses.
 *
 * Every wait in this file used to be a fixed sleep sized to the worst case with a generous
 * margin on top -- 2000ms to see the daemon survive, 5000ms to see it drain, 300ms to see it
 * die. That is 7.3s of wall clock spent waiting for things that are typically done in a fraction
 * of it, and the margins existed precisely because a fixed sleep is also the flakiest possible
 * way to wait: too short and it fails on a slow machine, too long and it still tells you nothing
 * about when the condition actually became true. Polling is both faster and stricter, since the
 * elapsed time it returns can itself be asserted on.
 */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<number> {
  const start = Date.now()
  for (;;) {
    if (check()) return Date.now() - start
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`)
    }
    await sleep(50)
  }
}

/** Poll interval handed to the daemon under test. Fast enough that the drain assertion resolves in well under the 2000ms production default, which is what makes that assertion able to detect the default being forced back on. */
const DAEMON_POLL_MS = 200

const tempDirs: string[] = []
function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('detached worker daemon (built bundle)', () => {
  it('bundle contains the real daemon dispatch, not a tree-shaken/unwired stub', () => {
    const bundle = fs.readFileSync(CORE_BUNDLE, 'utf8')
    // Would be absent from the shipped artifact if runDetachedWorkerDaemon were ever removed
    // or if esbuild tree-shook it out for being unreachable from the entrypoint again.
    expect(bundle).toContain('runDetachedWorkerDaemon')
  })

  it(
    '`worker start` stays alive well past the point the old bug killed it, and the running daemon drains real work',
    async () => {
      const dataBase = mkIsolated('tg-daemon-data-')
      const repo = mkIsolated('tg-daemon-repo-')
      const env = tgEnv(dataBase, DAEMON_POLL_MS)
      let pid: number | undefined

      try {
        // 1. Start the daemon for real, through the actual CLI command a user would run.
        const start = runBundle(['worker', 'start'], env, repo)
        expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
        const m = start.stdout.match(/pid (\d+)/)
        expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
        pid = parseInt((m as RegExpMatchArray)[1], 10)

        // 2. Wait for positive proof the child reached the daemon loop rather than for a fixed
        // interval: runDetachedWorkerDaemon writes its own pid to queue/drain-heartbeat as its
        // first act, so that file naming this pid can only happen on the far side of the argv
        // dispatch the pre-fix bug died at (commander rejected --worker-daemon and the process
        // exited before ever reaching the loop). A dead child never writes it, so that failure
        // still fails here -- as a timeout rather than a liveness assertion.
        const heartbeat = path.join(effectiveDataDir(dataBase), 'queue', 'drain-heartbeat')
        const daemonPid = pid
        await waitFor('the daemon to write its drain heartbeat', 15000, () => {
          try {
            return fs.readFileSync(heartbeat, 'utf8').trim() === String(daemonPid)
          } catch {
            return false
          }
        })

        expect(
          pidAlive(pid),
          'daemon pid is dead -- --worker-daemon was likely rejected by commander again',
        ).toBe(true)

        const status = runBundle(['worker', 'status'], env, repo)
        expect(status.stdout).toContain('Worker is running.')

        // 3. Prove it does real work, not just "a process that stays alive": seed a real
        // dirty-queue entry for a fixture file directly on disk (bypassing any manual `index`
        // call) and confirm the ALREADY-RUNNING daemon drains it on its own poll cycle.
        const srcFile = path.join(repo, 'daemon_e2e_sample.ts')
        fs.writeFileSync(srcFile, 'export function daemonDrainedSymbol(): number {\n  return 1\n}\n')

        const queueDir = path.join(effectiveDataDir(dataBase), 'queue')
        fs.mkdirSync(queueDir, { recursive: true })
        fs.writeFileSync(path.join(queueDir, 'dirty.txt'), `${srcFile}\n`)

        let sym: RunResult | undefined
        const drainMs = await waitFor('the running daemon to drain the seeded queue entry', 20000, () => {
          sym = runBundle(['symbol', 'daemonDrainedSymbol'], env, repo)
          return sym.status === 0 && sym.stdout.includes('daemonDrainedSymbol')
        })
        expect(sym?.stdout).toContain('daemonDrainedSymbol')

        // The drain landing this fast is itself the assertion that TG_WORKER_POLL_MS reached the
        // daemon. `worker start` used to hardcode the 2000ms default into the child's env
        // regardless of what it inherited, so the variable the daemon reads was a no-op on the
        // only path that actually starts one. With that bug back, the first poll cycle alone puts
        // this past the bound; DAEMON_POLL_MS is an order of magnitude under it.
        expect(
          drainMs,
          `drain took ${drainMs}ms, past the 2000ms default floor -- TG_WORKER_POLL_MS is being ignored again`,
        ).toBeLessThan(1500)
      } finally {
        // 4. Clean teardown so this test never leaks a real background process.
        const stop = runBundle(['worker', 'stop'], env, repo)
        expect(stop.stdout).toMatch(/Worker stopped\.|No running worker\./)
        const stopped = pid
        if (stopped !== undefined) {
          // Give SIGTERM a moment to land, but stop waiting the instant it has: the SIGKILL below
          // is the backstop for a daemon that ignores it, not the expected path.
          await waitFor('the stopped daemon to exit', 5000, () => !pidAlive(stopped)).catch(() => 0)
        }
        if (pid !== undefined && pidAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }
    },
    45000,
  )
})
