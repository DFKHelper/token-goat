/** Built-bundle smoke test for the queue wake (src/queue_waker.ts): a real `worker start` daemon from dist/token-goat.mjs, a real `hook post_tool_use` Edit call queueing the file, and a real `symbol` lookup resolving it, with the daemon's poll interval set to 30 s so that only the wake can land the edit inside the old 2 s default. tests/worker_wakes_on_edit.test.ts drives the same path from source; this proves the watcher survived bundling and starts in a detached daemon, whose working directory and stdio differ from a test process's. Why didn't a test catch the old wait: tests/worker_daemon_e2e.test.ts seeds the queue with the daemon polling every 200 ms, so how long an edit waited at the production interval was never measured. PROVENANCE: FORMAT-DERIVED for the hook payload: the Claude Code PostToolUse fields (session_id, tool_name, tool_input.file_path, cwd, tool_response) as tests/edit_hook_queues_the_absolute_path.test.ts sends them, from https://code.claude.com/docs/en/hooks. HAND-DERIVED for the one-function source file. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { indexableDir } from './helpers/temp-config.js'

/** Mirrors src/constants.ts's defaultDataDir() for a LOCALAPPDATA/XDG_DATA_HOME of `base`, as tests/worker_daemon_e2e.test.ts does. */
function effectiveDataDir(base: string): string {
  return process.platform === 'win32' ? path.join(base, 'dfk-helper', 'token-goat') : path.join(base, 'token-goat')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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

describe('an edit wakes the detached worker (built bundle)', () => {
  it('indexes a file the post_tool_use hook queued well inside the old 2 s poll, with the daemon polling every 30 s', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wake-bundle-'))
    bases.push(base)
    const env = tgIsolatedEnv(base, { TG_WORKER_POLL_MS: '30000' })
    const repo = indexableDir()
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0)
    let pid: number | undefined
    try {
      const start = runBundle(['worker', 'start'], { cwd: repo, env, timeout: 30_000 })
      expect(start.status, start.stderr).toBe(0)
      pid = parseInt(/pid (\d+)/.exec(start.stdout)?.[1] ?? 'NaN', 10)
      expect(Number.isFinite(pid), start.stdout).toBe(true)
      const heartbeat = path.join(effectiveDataDir(base), 'queue', 'drain-heartbeat')
      const deadline = Date.now() + 15_000
      while (!(fs.existsSync(heartbeat) && fs.readFileSync(heartbeat, 'utf8').trim() === String(pid))) {
        if (Date.now() > deadline) throw new Error('the daemon never wrote its drain heartbeat')
        await sleep(50)
      }
      // Let the first cycle finish, so the edit meets a sleeping daemon rather than one still in its first drain.
      await sleep(500)

      const file = path.join(repo, 'bundleWakeProbe.ts')
      fs.writeFileSync(file, 'export function bundleWakeProbe(): number {\n  return 1\n}\n')
      const payload = { session_id: 'bundle-wake-probe', tool_name: 'Edit', tool_input: { file_path: file }, cwd: repo, tool_response: { output: 'ok' } }
      const hook = runBundle(['hook', 'post_tool_use'], { cwd: repo, env, input: JSON.stringify(payload), timeout: 30_000 })
      expect(hook.status, hook.stderr).toBe(0)
      const queuedAt = performance.now()

      let found = false
      while (!found && performance.now() - queuedAt < 10_000) {
        const sym = runBundle(['symbol', 'bundleWakeProbe'], { cwd: repo, env, timeout: 30_000 })
        found = sym.status === 0 && sym.stdout.includes('bundleWakeProbe')
      }
      const ms = performance.now() - queuedAt
      expect(found, 'the daemon never indexed the edit').toBe(true)
      // The bound includes the `symbol` process that saw it, which is most of it.
      expect(ms, `the edit took ${Math.round(ms)} ms to resolve`).toBeLessThan(2000)
    } finally {
      runBundle(['worker', 'stop'], { cwd: repo, env, timeout: 30_000 })
      const stopped = pid
      if (stopped !== undefined && Number.isFinite(stopped)) {
        const until = Date.now() + 5000
        while (pidAlive(stopped) && Date.now() < until) await sleep(50)
        if (pidAlive(stopped)) process.kill(stopped, 'SIGKILL')
        const killed = Date.now() + 5000
        while (pidAlive(stopped) && Date.now() < killed) await sleep(50)
      }
    }
  }, 60_000)
})
