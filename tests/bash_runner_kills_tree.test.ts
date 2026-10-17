// A command that is ended must take everything it started with it: on a timeout, and when token-goat itself is interrupted or terminated. The runner killed only the shell it spawned (child.kill), so a grandchild such as a `find /` walk lived on, reparented to init, long after the timeout reported 124. Provenance: HAND-DERIVED. The tree is built by this file's own scripts (shell -> node parent -> node grandchild) and the grandchild's pid is read back from the file it writes about itself, so nothing here restates the runner's kill logic. Windows cannot deliver INT, TERM or HUP to a process, so the signal and group-kill tests are POSIX only; the timeout and listener tests run on both, and the once-only rule is in process_tree_once.test.ts.
import type * as ChildProcessModule from 'node:child_process'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { run, runRaw } from '../src/bash_runner.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Every tree kill goes through spawnSync (ps on POSIX, taskkill on Windows), so counting those calls is a clock-free, immediate signal that the runner ended the tree itself rather than leaving it to the grandchild's own directory check.
const passes = vi.hoisted(() => [] as string[])
// Every child the runner starts, in order, so a test can watch the shell's own events.
const spawned = vi.hoisted(() => [] as ChildProcess[])
const treeWalks = (): string[] => passes.filter((file) => file === 'ps' || /taskkill/i.test(file))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const counting = ((file: string, ...rest: unknown[]) => {
    passes.push(file)
    return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof real.spawnSync
  const recording = ((...args: unknown[]) => {
    const child = (real.spawn as (...a: unknown[]) => ChildProcess)(...args)
    spawned.push(child)
    return child
  }) as typeof real.spawn
  return { ...real, spawn: recording, spawnSync: counting }
})

// Taken before any test fakes the timers, so the polling below keeps real time while the runner's own timeout is the faked one.
const realSetTimeout = globalThis.setTimeout
const pause = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))

const RUNNER_TIMEOUT_SECONDS = 600

// Polls until the condition holds. The only bound is vitest's per-test timeout, so a slow machine is not failed by a clock of this file's own.
async function pollUntil(check: () => boolean): Promise<void> {
  while (!check()) await pause(25)
}

const alive = processAlive

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
}

// Both scripts end on their own when their directory is deleted, so a test that dies midway cannot leave either one running past its cleanup.
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const dir = process.argv[2]
spawn(process.execPath, [process.argv[3], dir], { stdio: 'ignore' })
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`
const GRANDCHILD_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
fs.writeFileSync(path.join(dir, 'gc.tmp'), String(process.pid))
fs.renameSync(path.join(dir, 'gc.tmp'), path.join(dir, 'gc.pid'))
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`
// The parent hands the grandchild its own stdout and stderr and exits once the grandchild has recorded its pid, so the shell is gone while a descendant still holds the pipes the capture path reads. The grandchild is detached because libuv on Windows puts every non-detached child in a kill-on-close job object, so it would die with its parent and release the pipes (measured: a plain spawn from node, no token-goat code, saw the pipes close and the pid dead within 20 ms of the parent's exit; detached, the pid stayed alive and the pipes open).
const ORPHANING_PARENT_SCRIPT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
spawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }).unref()
setInterval(() => {
  if (!fs.existsSync(path.join(process.argv[2], 'gc.pid'))) return
  fs.writeFileSync(path.join(process.argv[2], 'parent.pid'), String(process.pid))
  process.exit(0)
}, 20)
`
// The root stays alive and starts the orphaning parent, which leaves once the holder has recorded its pid: the holder is then reparented away from the root while the root, and the pipes the holder inherited, are still live.
const ALIVE_ROOT_SCRIPT = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
spawn(process.execPath, [process.argv[4], process.argv[2], process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()
setInterval(() => { if (!fs.existsSync(process.argv[2])) process.exit(0) }, 200)
`
const quoted = (p: string): string => JSON.stringify(p.replace(/\\/g, '/'))

let dir: string | undefined
let isolatedBase: string | undefined
let pending: Promise<number> | undefined
let grandchildPid: number | undefined
const hosts: ChildProcess[] = []

afterEach(async () => {
  // A test that failed before the timeout fired still has a run waiting on its fake timer: fire it so the runner ends its own tree.
  if (vi.isFakeTimers()) vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const c of hosts.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  }
  if (grandchildPid !== undefined) killIfCommandLine(grandchildPid, (cmd) => cmd.includes('grandchild.cjs'))
  grandchildPid = undefined
  // Deleting the directory ends the parent script, which releases any pipe it still holds so a run left pending can settle.
  for (const d of [dir, isolatedBase]) {
    if (d !== undefined) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  dir = undefined
  isolatedBase = undefined
  if (pending !== undefined) {
    await pending
    pending = undefined
  }
})

function treeCommand(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-tree-'))
  const parent = path.join(dir, 'parent.cjs')
  const grandchild = path.join(dir, 'grandchild.cjs')
  fs.writeFileSync(parent, PARENT_SCRIPT)
  fs.writeFileSync(grandchild, GRANDCHILD_SCRIPT)
  return `${quoted(process.execPath)} ${quoted(parent)} ${quoted(dir)} ${quoted(grandchild)}`
}

async function grandchildIsRunning(): Promise<number> {
  const pidFile = path.join(dir!, 'gc.pid')
  await pollUntil(() => fs.existsSync(pidFile))
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  grandchildPid = pid
  expect(alive(pid), 'the grandchild is not running before it is ended').toBe(true)
  return pid
}

/** The built CLI running the tree command, as a child of this test: the process whose death the grandchild must not survive. */
async function startHost(options: { detached?: boolean } = {}): Promise<{ host: ChildProcess; pid: number }> {
  const command = treeCommand()
  isolatedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-host-'))
  const host = spawn(process.execPath, [BUNDLE, 'compress', '-c', command], { stdio: 'ignore', windowsHide: true, env: tgIsolatedEnv(isolatedBase), ...options })
  hosts.push(host)
  const pid = await grandchildIsRunning()
  return { host, pid }
}

describe('a timed-out command leaves no process behind', () => {
  it('the capture path (run) kills the grandchild with the shell', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = run(treeCommand(), { filterName: 'generic', timeout: RUNNER_TIMEOUT_SECONDS, writeStdout: () => {}, writeStderr: () => {} })
    pending = started
    const pid = await grandchildIsRunning()
    passes.length = 0
    vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
    // The tree kill is synchronous inside the timer callback, so this fails by assertion the moment the walk is missing.
    expect(treeWalks().length, `the timeout ended no process tree (spawnSync saw ${JSON.stringify(passes)})`).toBeGreaterThan(0)
    expect(await started).toBe(124)
    pending = undefined
    await pollUntil(() => !alive(pid))
  })

  it('the streaming path (runRaw) kills the grandchild with the shell', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = runRaw(treeCommand(), RUNNER_TIMEOUT_SECONDS)
    pending = started
    const pid = await grandchildIsRunning()
    passes.length = 0
    vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
    expect(await started).toBe(124)
    pending = undefined
    expect(treeWalks().length, `the timeout ended no process tree (spawnSync saw ${JSON.stringify(passes)})`).toBeGreaterThan(0)
    await pollUntil(() => !alive(pid))
  })
})

describe('a timeout settles even when the shell has already exited', () => {
  it('the capture path returns 124 although a descendant still holds its pipes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-tree-'))
    const parent = path.join(dir, 'parent.cjs')
    const holder = path.join(dir, 'holder.cjs')
    fs.writeFileSync(parent, ORPHANING_PARENT_SCRIPT)
    fs.writeFileSync(holder, GRANDCHILD_SCRIPT)
    const started = run(`${quoted(process.execPath)} ${quoted(parent)} ${quoted(dir)} ${quoted(holder)}`, { filterName: 'generic', timeout: RUNNER_TIMEOUT_SECONDS, writeStdout: () => {}, writeStderr: () => {} })
    pending = started
    await grandchildIsRunning()
    const parentPidFile = path.join(dir, 'parent.pid')
    await pollUntil(() => fs.existsSync(parentPidFile) && !alive(Number(fs.readFileSync(parentPidFile, 'utf8'))))
    // One more turn so the runner has seen the shell's exit event before the timeout fires.
    await new Promise<void>((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
    expect(await started).toBe(124)
    pending = undefined
  })
})

describe('a timeout settles while the shell is still alive', () => {
  it('the capture path stops reading the pipes a reparented descendant holds, once the killed shell has exited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-tree-'))
    const root = path.join(dir, 'root.cjs')
    const orphaning = path.join(dir, 'parent.cjs')
    const holder = path.join(dir, 'holder.cjs')
    fs.writeFileSync(root, ALIVE_ROOT_SCRIPT)
    fs.writeFileSync(orphaning, ORPHANING_PARENT_SCRIPT)
    fs.writeFileSync(holder, GRANDCHILD_SCRIPT)
    spawned.length = 0
    const started = run(`${quoted(process.execPath)} ${quoted(root)} ${quoted(dir)} ${quoted(holder)} ${quoted(orphaning)}`, { filterName: 'generic', timeout: RUNNER_TIMEOUT_SECONDS, writeStdout: () => {}, writeStderr: () => {} })
    pending = started
    const shell = spawned[0] as ChildProcess
    await grandchildIsRunning()
    // The holder is only out of the shell's tree once the process that started it has gone.
    const parentPidFile = path.join(dir, 'parent.pid')
    await pollUntil(() => fs.existsSync(parentPidFile) && !alive(Number(fs.readFileSync(parentPidFile, 'utf8'))))
    vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
    // Registered after the runner's own listener, so the runner has acted on the exit by the time this one runs.
    await exitOf(shell)
    expect(shell.stdout?.destroyed, 'the shell is gone but the runner still reads its stdout').toBe(true)
    expect(shell.stderr?.destroyed, 'the shell is gone but the runner still reads its stderr').toBe(true)
    expect(await started).toBe(124)
    pending = undefined
  })
})

describe.skipIf(process.platform === 'win32')('an interrupted token-goat leaves no process behind', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('%s to the CLI ends the grandchild and the CLI dies of the signal', async (signal) => {
    const { host, pid } = await startHost()
    const exited = exitOf(host)
    host.kill(signal)
    expect(await exited, 'the CLI did not die of the signal it was sent').toEqual({ code: null, signal })
    await pollUntil(() => !alive(pid))
  })

  it('a group-wide SIGKILL, as a harness sends it, reaches the grandchild because the shell stays in the CLI\'s group', async () => {
    const { host, pid } = await startHost({ detached: true })
    // The group kill below can only reach the grandchild if it shares the CLI's group, which a detached shell would not: check that directly, before anything is killed.
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    expect(pgid, 'the grandchild is not in the CLI\'s process group').toBe(host.pid)
    const exited = exitOf(host)
    process.kill(-(host.pid as number), 'SIGKILL')
    await exited
    await pollUntil(() => !alive(pid))
  })
})

describe('the exit and signal hooks come off with the child', () => {
  it('a finished run leaves the process listener counts where they were', async () => {
    const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const before = events.map((e) => process.listenerCount(e))
    const code = await run(`${quoted(process.execPath)} -e ""`, { filterName: 'generic', timeout: RUNNER_TIMEOUT_SECONDS, writeStdout: () => {}, writeStderr: () => {} })
    expect(code).toBe(0)
    expect(events.map((e) => process.listenerCount(e))).toEqual(before)
  })

  it('a live run holds one hook for each of exit, SIGINT, SIGTERM and SIGHUP until it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const before = events.map((e) => process.listenerCount(e))
    const started = run(treeCommand(), { filterName: 'generic', timeout: RUNNER_TIMEOUT_SECONDS, writeStdout: () => {}, writeStderr: () => {} })
    pending = started
    await grandchildIsRunning()
    events.forEach((e, k) => expect(process.listenerCount(e), `no ${e} hook while a child is live`).toBe(before[k]! + 1))
    vi.advanceTimersByTime(RUNNER_TIMEOUT_SECONDS * 1000)
    expect(await started).toBe(124)
    pending = undefined
    expect(events.map((e) => process.listenerCount(e))).toEqual(before)
  })
})
