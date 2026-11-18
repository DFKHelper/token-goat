// Provenance: the trace2 `sid` parsed below is FORMAT-DERIVED from the example events in git's trace2 documentation (Documentation/technical/api-trace2.adoc, e.g. `20190408T191610.507018Z-H9b68c35f-P000059a8`; the page itself calls the sid only "a unique string"), plus a CAPTURE from Git 2.53.0.windows.1. That the P part is the process id in hex, and that a child git's sid is its parent's sid with its own component appended (so the last -P part is the git that wrote the line), is read from git's trace2/tr2_sid.c (master, fetched and read). Platform: on Linux and macOS git is not a launcher, so this test passes before and after the fix there; the red proof against the old code is Windows-only. Real git, real process table: no runGit stub. A git that is blocked for as long as a lock file exists stands in for a slow command; its own trace file says when it started and which pid it had.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { killAllIfCommandLine, type KillOptions } from './helpers/kill_if_command_line.js'
import { spawnOwnedDecoy } from './helpers/owner_tied_decoy.js'
import { resolveOnPath, sleepSync } from '../src/process_util.js'
import { runGit } from '../src/util.js'

const TEST_BUDGET_MS = 120_000
let repo = ''
let tracePath = ''
const savedEnv: Record<string, string | undefined> = {}
const startedPids = new Set<number>()

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}

// HAND-DERIVED: a git process starts with the git executable, bare or by path, quoted or not; a vitest worker or node child starts with node.
function isGitCommandLine(commandLine: string): boolean {
  return /^["']?(?:[^"']*[/\\])?git(?:\.exe)?["']?(?:\s|$)/i.test(commandLine.trim())
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pids whose git reported finishing in the trace file: a git that ran `exit` is gone, so a live process holding its number is a stranger. */
function exitedPids(): Set<number> {
  const pids = new Set<number>()
  if (!existsSync(tracePath)) return pids
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    const match = /"event":"exit","sid":"[^"]*-P([0-9a-f]+)"/.exec(line)
    if (match !== null) pids.add(parseInt(match[1] as string, 16))
  }
  return pids
}

/** Ends the gits this run announced. A command line that reads back empty (Windows hides some) says nothing about whose process it is, so a pid this run's own trace announced and never reported as exited stands in for it; a line that reads back and is not git's is still a stranger, and an unreadable pid the trace reports as exited is not tied, so it throws instead of being killed. */
function endStartedGits(opts: KillOptions = {}): void {
  const exited = exitedPids()
  killAllIfCommandLine(startedPids, isGitCommandLine, { ...opts, tied: (pid) => startedPids.has(pid) && !exited.has(pid) })
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
  try {
    // A passing run leaves these pids dead, and the OS may have given a number to a new process since (on Windows a killed stranger exits with code 1, as a vitest worker did): only a process whose command line is still git is signalled. A pid whose command line cannot be read throws, after every other pid was tried.
    const live = [...startedPids].filter(alive)
    endStartedGits()
    // The kill is asked for, not done: wait (bounded) until the processes are gone, since a live one still holds the directory open.
    for (const pid of live) {
      for (let waited = 0; waited < 100 && alive(pid); waited++) sleepSync(50)
    }
  } finally {
    // A throw above still reaches the rest of the cleanup: the environment is restored, the pids forgotten and the files removed before it surfaces.
    startedPids.clear()
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key] as string
      delete savedEnv[key]
    }
    rmSync(path.join(repo, '.git', 'packed-refs.lock'), { force: true })
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(tracePath, { force: true })
  }
})

describe('runGit timeout', () => {
  it('leaves no git process of the run alive when the timeout ends it', () => {
    putGitLauncherFirst()
    // pack-refs waits for packed-refs.lock for as long as it exists (-1 is "retry indefinitely"), so this git is blocked on a file, not on the clock.
    writeFileSync(path.join(repo, '.git', 'packed-refs.lock'), '')
    setEnv('GIT_TRACE2_EVENT', tracePath)

    // The timeout firing is the behaviour under test and spawnSync cannot be told to fire it on an event, so the call is repeated with a timeout that doubles until git's trace shows it started: a slow machine just takes more turns and never fails on slowness. A synchronous loop cannot be cut short by vitest's timeout, so the loop stops itself at the budget this test is given (each call is capped to what is left of it); that deadline can trip only when git never starts, since the timeout doubles until it does.
    let timeoutMs = 1000
    let observed: number[] = []
    const stopAt = Date.now() + TEST_BUDGET_MS - 20_000
    while (observed.length === 0 && Date.now() < stopAt) {
      const result = runGit(['-c', 'core.packedRefsTimeout=-1', 'pack-refs', '--all'], { cwd: repo, timeoutMs: Math.max(1, Math.min(timeoutMs, stopAt - Date.now())) })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(-1)
      observed = tracedPids()
      for (const pid of observed) startedPids.add(pid)
      timeoutMs *= 2
    }
    expect(observed.length, 'git never wrote its trace, so there was no process to check').toBeGreaterThan(0)
    expect(observed.filter(alive)).toEqual([])
  }, TEST_BUDGET_MS)

  // CAPTURE: the trace line a finished git writes, from git 2.53.0.windows.1 run with GIT_TRACE2_EVENT=<file> on `git rev-parse --git-dir`: {"event":"exit","sid":"20261019T031616.726603Z-H55886333-P00026b84","thread":"main",...,"code":0}; the sid's P part is the pid in hex (here 0x26b84).
  const traceLine = (event: string, pid: number): string => `{"event":"${event}","sid":"20261019T031616.726603Z-H55886333-P${pid.toString(16).padStart(8, '0')}","thread":"main"}\n`
  const unreadable: KillOptions = { readCommandLine: () => null }

  it('ends a recorded git whose command line reads back empty while the trace has it running', async () => {
    const stand = spawnOwnedDecoy(['--rungit-stand-in'])
    try {
      const gone = new Promise<void>((resolve) => stand.once('exit', () => resolve()))
      startedPids.add(stand.pid as number)
      writeFileSync(tracePath, traceLine('start', stand.pid as number))
      expect(() => endStartedGits(unreadable)).not.toThrow()
      await gone
    } finally {
      if (stand.exitCode === null && stand.signalCode === null) stand.kill('SIGKILL')
    }
  })

  it('leaves a recorded pid alone, and throws, once the trace reports that git exited', () => {
    const stand = spawnOwnedDecoy(['--rungit-stand-in'])
    try {
      startedPids.add(stand.pid as number)
      writeFileSync(tracePath, traceLine('start', stand.pid as number) + traceLine('exit', stand.pid as number))
      expect(() => endStartedGits(unreadable)).toThrow()
      expect(stand.exitCode === null && stand.signalCode === null, 'a process the trace reported as exited was signalled').toBe(true)
    } finally {
      startedPids.delete(stand.pid as number)
      if (stand.exitCode === null && stand.signalCode === null) stand.kill('SIGKILL')
    }
  })

  it('still returns a finished command whole when the timeout was not reached', () => {
    const result = runGit(['rev-parse', '--git-dir'], { cwd: repo, timeoutMs: 60_000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('.git')
    expect(result.timedOut).toBeUndefined()
  })
})
