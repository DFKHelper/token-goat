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

import { BUNDLE } from './helpers/bundle.js'

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

function tgEnv(base: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: base, XDG_DATA_HOME: base }
}

/**
 * Mirrors src/constants.ts's private defaultDataDir() platform join, so this test can locate
 * the same queue/dirty.txt and global.db the daemon uses without importing constants.ts --
 * that module caches its DATA_DIR once at first import from whatever LOCALAPPDATA/XDG_DATA_HOME
 * the test worker process happened to start with, not the per-test temp base this file passes
 * to the spawned bundle.
 */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  if (process.platform === 'darwin') return path.join(base, 'Library', 'Application Support', 'token-goat')
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
    const bundle = fs.readFileSync(BUNDLE, 'utf8')
    // Would be absent from the shipped artifact if runDetachedWorkerDaemon were ever removed
    // or if esbuild tree-shook it out for being unreachable from the entrypoint again.
    expect(bundle).toContain('runDetachedWorkerDaemon')
  })

  it(
    '`worker start` stays alive well past the point the old bug killed it, and the running daemon drains real work',
    async () => {
      const dataBase = mkIsolated('tg-daemon-data-')
      const repo = mkIsolated('tg-daemon-repo-')
      const env = tgEnv(dataBase)
      let pid: number | undefined

      try {
        // 1. Start the daemon for real, through the actual CLI command a user would run.
        const start = runBundle(['worker', 'start'], env, repo)
        expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
        const m = start.stdout.match(/pid (\d+)/)
        expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
        pid = parseInt((m as RegExpMatchArray)[1], 10)

        // 2. Wait well past the point the pre-fix bug would already have killed the child --
        // that death was near-instant (commander rejects --worker-daemon and the process exits
        // before ever reaching the daemon loop), so any positive wait exposes it. Use a
        // generous margin against process-spawn/scheduling jitter.
        await sleep(2000)

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

        // Default poll interval is 2000ms (no CLI override exists); wait past two full cycles
        // with margin for cold-start native-module (better-sqlite3/tree-sitter) overhead.
        await sleep(5000)

        const sym = runBundle(['symbol', 'daemonDrainedSymbol'], env, repo)
        expect(sym.status, `symbol lookup stderr: ${sym.stderr}`).toBe(0)
        expect(sym.stdout).toContain('daemonDrainedSymbol')
      } finally {
        // 4. Clean teardown so this test never leaks a real background process.
        const stop = runBundle(['worker', 'stop'], env, repo)
        expect(stop.stdout).toMatch(/Worker stopped\.|No running worker\./)
        await sleep(300)
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
