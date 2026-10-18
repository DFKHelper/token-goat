/** Built-bundle smoke test for the queue wake (src/queue_waker.ts): a real daemon from dist/token-goat.mjs, spawned the way the Copilot session-start shim does and ended through its ChildProcess handle, and a real `hook post_tool_use` Edit call queueing the file, with the daemon's poll interval set to 120 s so that only the wake can index the edit before the deadline. tests/worker_wakes_on_edit.test.ts drives the same path from source; this proves the watcher survived bundling and starts in a detached daemon, whose working directory and stdio differ from a test process's. The oracle is the symbols table in global.db, read directly, rather than a `token-goat symbol` process per poll: a deadline that has to cover a process start each round is a bound on the runner's load as much as on the wake, and the second test proves the hook alone writes no row, so a row can only have come from the daemon. Why didn't a test catch the old wait: tests/worker_daemon_e2e.test.ts seeds the queue with the daemon polling every 200 ms, so how long an edit waited at the production interval was never measured. PROVENANCE: FORMAT-DERIVED for the hook payload: the Claude Code PostToolUse fields (session_id, tool_name, tool_input.file_path, cwd, tool_response) as tests/edit_hook_queues_the_absolute_path.test.ts sends them, from https://code.claude.com/docs/en/hooks. HAND-DERIVED for the one-function source file. */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { stopOwnedChild, trackOwnedChild } from './helpers/stop_owned_child.js'
import { indexableDir } from './helpers/temp-config.js'

/** Mirrors src/constants.ts's defaultDataDir() for a LOCALAPPDATA/XDG_DATA_HOME of `base`, as tests/worker_daemon_e2e.test.ts does. */
function effectiveDataDir(base: string): string {
  return process.platform === 'win32' ? path.join(base, 'dfk-helper', 'token-goat') : path.join(base, 'token-goat')
}

/** How many indexed symbols in the global.db under `base` are named `name`; 0 while the database or its symbols table does not exist yet. Opened read-only and closed each call, so this process never holds the database the daemon writes. */
function indexedSymbolCount(base: string, name: string): number {
  const file = path.join(effectiveDataDir(base), 'global.db')
  if (!fs.existsSync(file)) return 0
  const db = new Database(file, { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE name = ?').get(name) as { c: number }).c
  } catch (err) {
    if (/no such table/.test(String(err))) return 0
    throw err
  } finally {
    db.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const bases: string[] = []
afterEach(() => {
  for (const d of bases.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch {
      // Best effort, as in tests/worker_daemon_e2e.test.ts: on a loaded Windows runner a just-killed daemon's handles (or a scanner's) can outlive the retries, and a leftover temp directory is not what this test measures.
    }
  }
})

/** A git project, an isolated home under a fresh temp base, and the Edit hook run through the bundle for a new one-function file named `name`. */
function setup(prefix: string): { base: string; env: NodeJS.ProcessEnv; repo: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  bases.push(base)
  const env = tgIsolatedEnv(base, { TG_WORKER_POLL_MS: '120000' })
  const repo = indexableDir()
  expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0)
  return { base, env, repo }
}

function editHook(repo: string, env: NodeJS.ProcessEnv, name: string): void {
  const file = path.join(repo, `${name}.ts`)
  fs.writeFileSync(file, `export function ${name}(): number {\n  return 1\n}\n`)
  const payload = { session_id: 'bundle-wake-probe', tool_name: 'Edit', tool_input: { file_path: file }, cwd: repo, tool_response: { output: 'ok' } }
  const hook = runBundle(['hook', 'post_tool_use'], { cwd: repo, env, input: JSON.stringify(payload), timeout: 30_000 })
  expect(hook.status, hook.stderr).toBe(0)
}

describe('an edit wakes the detached worker (built bundle)', () => {
  it('indexes a file the post_tool_use hook queued long before the daemon\'s 120 s poll would', async () => {
    // The daemon is spawned here, the way the Copilot session-start shim spawns it, so this test holds its ChildProcess and ends it through that handle. Started by `worker start` it was only a recorded pid, and ending it meant reading its command line through a PowerShell or ps query; that query returns null for a live process when it fails, and a loaded machine fails it, so the cleanup threw "its command line could not be read" and left the daemon running. tests/worker_daemon_e2e.test.ts keeps the `worker start` path.
    const { base, env, repo } = setup('tg-wake-bundle-')
    // The suite pins TOKEN_GOAT_NO_WORKER_SPAWN=1 in this process, and a daemon that claims its own slot checks it and leaves at once; the hook below keeps the pin so it cannot start a second daemon.
    const daemonEnv = { ...env }
    delete daemonEnv['TOKEN_GOAT_NO_WORKER_SPAWN']
    // owner: this test; detached only to match how the daemon runs for real, dies when stopOwnedChild ends it through this handle at the end of the test (a daemon also retires when its data directory is deleted).
    const child = spawn(process.execPath, [BUNDLE, '--worker-daemon', '--claim-worker'], { cwd: os.tmpdir(), env: daemonEnv, stdio: 'ignore', windowsHide: true, detached: true })
    // Tracked before any wait: the per-test timeout rejects the test while the loops below still run and its finally never does, and the backstop is what then ends the daemon (and so the loops, which watch its exit).
    trackOwnedChild(child)
    const pid = child.pid
    let bodyFinished = false
    try {
      expect(pid, 'spawning the bundle produced no pid').toBeDefined()
      const heartbeat = path.join(effectiveDataDir(base), 'queue', 'drain-heartbeat')
      // Waits end on the daemon's own signs, never on a clock of this file's: the heartbeat names it, or it has exited and the wait says so. The per-test timeout is the only bound.
      while (!(fs.existsSync(heartbeat) && fs.readFileSync(heartbeat, 'utf8').trim() === String(pid))) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('the daemon exited before it wrote its drain heartbeat')
        await sleep(50)
      }
      // Let the first cycle finish, so the edit meets a sleeping daemon rather than one still in its first drain.
      await sleep(500)

      editHook(repo, env, 'bundleWakeProbe')
      // The poll is 120 s, so a timer could never land the edit within this test's own timeout: only the wake can end this loop with a row.
      let count = 0
      while ((count = indexedSymbolCount(base, 'bundleWakeProbe')) === 0) {
        if (child.exitCode !== null || child.signalCode !== null) break
        await sleep(25)
      }
      expect(count, 'the daemon never indexed the edit, so the queue wake did not fire').toBeGreaterThan(0)
      bodyFinished = true
    } finally {
      await stopOwnedChild(child, { graceful: bodyFinished })
    }
  }, 60_000)

  it('leaves the edit unindexed with no daemon running, so the count above can only have come from the daemon', async () => {
    const { base, env, repo } = setup('tg-wake-bundle-none-')
    editHook(repo, env, 'bundleNoWorkerProbe')
    await sleep(1000)
    expect(indexedSymbolCount(base, 'bundleNoWorkerProbe')).toBe(0)
    // The hook did queue the file, so the daemon above had something to wake for and nothing else drained it.
    expect(fs.readFileSync(path.join(effectiveDataDir(base), 'queue', 'dirty.txt'), 'utf8')).toContain('bundleNoWorkerProbe.ts')
    expect(fs.existsSync(path.join(effectiveDataDir(base), 'queue', 'drain-heartbeat'))).toBe(false)
  }, 60_000)
})
