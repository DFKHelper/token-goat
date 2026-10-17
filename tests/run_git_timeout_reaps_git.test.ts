// Real git, real process table: no runGit stub. A git that is blocked for as long as a lock file exists stands in for a slow command; its own trace file says when it started and which pid it had.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveOnPath, sleepSync } from '../src/process_util.js'
import { runGit } from '../src/util.js'

let repo = ''
let tracePath = ''
const savedEnv: Record<string, string | undefined> = {}
const startedPids = new Set<number>()

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Every pid a git of this test announced in its trace file (the sid ends in -P<pid in hex>). */
function tracedPids(): number[] {
  if (!existsSync(tracePath)) return []
  const pids = new Set<number>()
  for (const match of readFileSync(tracePath, 'utf8').matchAll(/"sid":"[^"]*-P([0-9a-f]+)"/g)) pids.add(parseInt(match[1] as string, 16))
  return [...pids]
}

/** Git for Windows installs a launcher at cmd/git.exe that starts the real git as a child. Put it first on PATH so this run uses it whatever order the machine's PATH has. Nothing to do where there is no launcher. */
function putGitLauncherFirst(): void {
  if (process.platform !== 'win32') return
  const found = resolveOnPath('git')
  if (found === null) return
  const dir = path.dirname(found)
  if (path.basename(dir).toLowerCase() === 'cmd') return
  const launcherDir = path.resolve(dir, '..', '..', 'cmd')
  if (existsSync(path.join(launcherDir, 'git.exe'))) setEnv('PATH', `${launcherDir}${path.delimiter}${process.env['PATH'] ?? ''}`)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'tg-rungit-reap-'))
  tracePath = path.join(repo, '..', `${path.basename(repo)}.trace2`)
  expect(runGit(['init', '-q'], { cwd: repo }).exitCode).toBe(0)
})

afterEach(() => {
  // A survivor of a failed run is ended here by the pid it announced, and the lock is dropped so a git still waiting on it ends by itself.
  for (const pid of startedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone: what the test wants
    }
    // The kill is asked for, not done: wait (bounded) until the process is gone, since a live one still holds the directory open.
    for (let waited = 0; waited < 100 && alive(pid); waited++) sleepSync(50)
  }
  startedPids.clear()
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
    delete savedEnv[key]
  }
  rmSync(path.join(repo, '.git', 'packed-refs.lock'), { force: true })
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  rmSync(tracePath, { force: true })
})

describe('runGit timeout', () => {
  it('leaves no git process of the run alive when the timeout ends it', () => {
    putGitLauncherFirst()
    // pack-refs waits for packed-refs.lock for as long as it exists (-1 is "retry indefinitely"), so this git is blocked on a file, not on the clock.
    writeFileSync(path.join(repo, '.git', 'packed-refs.lock'), '')
    setEnv('GIT_TRACE2_EVENT', tracePath)

    let timeoutMs = 1000
    let observed: number[] = []
    // A machine that needs longer than the timeout to start git has no pid to look at yet: widen the timeout until the trace shows git started, never assert on an empty observation.
    for (let attempt = 0; attempt < 6 && observed.length === 0; attempt++, timeoutMs *= 2) {
      const result = runGit(['-c', 'core.packedRefsTimeout=-1', 'pack-refs', '--all'], { cwd: repo, timeoutMs })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(-1)
      observed = tracedPids()
      for (const pid of observed) startedPids.add(pid)
    }
    expect(observed.length, 'git never wrote its trace, so there was no process to check').toBeGreaterThan(0)
    expect(observed.filter(alive)).toEqual([])
  }, 120_000)

  it('still returns a finished command whole when the timeout was not reached', () => {
    const result = runGit(['rev-parse', '--git-dir'], { cwd: repo, timeoutMs: 60_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('.git')
    expect(result.timedOut).toBeUndefined()
  })
})
