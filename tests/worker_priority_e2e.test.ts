/** The built bundle's real worker daemon must run below normal CPU priority, on the default path: no injected callback, no stubbed lifecycle. The daemon is background work nobody is waiting on, and at normal priority it competes with the user's own programs for as long as it lives. Two ways it is started are driven here: `worker start` (the CLI launcher, which the hooks reach through ensureWorkerAlive) and the argv the Copilot session-start shim spawns directly (`--worker-daemon --claim-worker`, src/bridges/copilot_session_start.ts). Provenance: HAND-DERIVED. The expected value comes from Node's documented priority scale (os.constants.priority: a larger number is a lower priority), not from the code under test. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE, runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { isWorkerDaemonCommandLine, killAllIfCommandLine } from './helpers/kill_if_command_line.js'

// tg-no-regex-preload

/** Mirrors constants.ts's defaultDataDir() platform join; see worker_daemon_e2e.test.ts for why it cannot be imported. */
function effectiveDataDir(base: string): string {
  if (process.platform === 'win32') return path.join(base, 'dfk-helper', 'token-goat')
  return path.join(base, 'token-goat')
}

/** Poll until the condition holds; the per-test timeout is the only bound, so a slow machine is not failed by a clock of this file's own. */
async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 50))
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

/** Only pids and data dirs this file started: a daemon that is still running at the end of a failed test is stopped, not left behind. `worker stop` first, because a `worker start` that timed out or printed something unexpected leaves a daemon whose pid this file never saw; then each known pid with its whole tree. */
afterEach(() => {
  for (const dataBase of tempDirs.filter((d) => d.includes('tg-priority-e2e-start-') || d.includes('tg-priority-e2e-shim-'))) {
    try {
      runBundle(['worker', 'stop'], { cwd: os.tmpdir(), env: tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' }), timeout: 30000 })
    } catch {
      // best effort: the pid kill below is the backstop
    }
  }
  try {
    killAllIfCommandLine(startedPids.splice(0), isWorkerDaemonCommandLine, { tree: true })
  } finally {
    for (const d of tempDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      } catch {
        // a daemon that holds global.db open keeps the folder on Windows; the kill above is what matters
      }
    }
  }
})

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL

/** `os.getPriority(pid)` on Linux reads one thread, the main one. The nice value of every thread of the process is in /proc/<pid>/task/<tid>/stat, field 19, which is index 16 after the `)` that closes the command name. */
function linuxThreadNices(pid: number): Map<string, number> {
  const nices = new Map<string, number>()
  for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8')
      nices.set(tid, Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]))
    } catch {
      // the thread ended between the listing and the read
    }
  }
  return nices
}

function expectBelowNormal(pid: number): void {
  expect(os.getPriority(pid), 'the daemon runs at normal priority or above').toBeGreaterThanOrEqual(BELOW_NORMAL)
  if (process.platform !== 'linux') return
  const nices = linuxThreadNices(pid)
  expect(nices.size, 'no thread of the daemon could be read').toBeGreaterThan(0)
  const normal = [...nices].filter(([, nice]) => nice < BELOW_NORMAL).map(([tid, nice]) => `${tid}:${nice}`)
  expect(normal, 'threads of the daemon still at normal priority (tid:nice)').toEqual([])
}

describe('the built worker daemon runs below normal priority', () => {
  it(
    'when started by `worker start`',
    async () => {
      const dataBase = mkIsolated('tg-priority-e2e-start-')
      const repo = mkIsolated('tg-priority-e2e-repo-')
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' })
      const start = runBundle(['worker', 'start'], { cwd: repo, env, timeout: 30000 })
      expect(start.status, `worker start stderr: ${start.stderr}`).toBe(0)
      const m = start.stdout.match(/pid (\d+)/)
      expect(m, `unexpected worker start output: ${JSON.stringify(start.stdout)}`).not.toBeNull()
      const pid = parseInt((m as RegExpMatchArray)[1]!, 10)
      startedPids.push(pid)
      await waitFor(() => heartbeatNames(dataBase, pid))
      expectBelowNormal(pid)
    },
    60000,
  )

  it(
    'when spawned directly the way the Copilot session-start shim does',
    async () => {
      const dataBase = mkIsolated('tg-priority-e2e-shim-')
      const env = tgIsolatedEnv(dataBase, { TG_WORKER_POLL_MS: '200' })
      // The suite pins TOKEN_GOAT_NO_WORKER_SPAWN=1 in this process, and a daemon that claims its own slot checks it and leaves at once; the shim only spawns it when the variable is not 1.
      delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
      const child = spawn(process.execPath, [BUNDLE, '--worker-daemon', '--claim-worker'], { cwd: os.tmpdir(), env, stdio: 'ignore', windowsHide: true })
      const pid = child.pid as number
      expect(pid, 'spawning the bundle produced no pid').toBeDefined()
      startedPids.push(pid)
      await waitFor(() => heartbeatNames(dataBase, pid))
      expectBelowNormal(pid)
    },
    60000,
  )
})
