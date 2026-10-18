// Provenance: HAND-DERIVED for the repository, the request and the process-table walk. The gate is tests/helpers/git_gate.ts (CAPTURE, see its header); the daemon is started by the built bundle's own `worker start`, the production path (detached, stdio ignored, pid file claimed); the process table comes from tests/helpers/copilot_session_start_tree.ts::listProcesses (Get-CimInstance Win32_Process on Windows, `ps -eo pid=,ppid=,args=` elsewhere).
/** `worker stop` leaves nothing of the daemon behind, git included. On Windows `process.kill(pid)` is TerminateProcess and no handler in the daemon runs, so what the daemon started is reaped only by the OS: libuv puts a plain child in a kill-on-close job (libuv 1.51.0 src/win/process.c, read this run), which takes the daemon's direct git with it but not a grandchild of that git (the job allows silent breakaway), and a taskkill /T of the daemon reaches both. The first test holds a real git of a real bundle daemon on tests/helpers/git_gate.ts and asserts the daemon and every descendant recorded when the gate reported the git are gone after `stopWorker`; the second (Windows only) holds a grandchild outside the job and is the one that fails against a bare `process.kill(pid)`. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { appendReconcileRequest } from '../src/dirty_queue.js'
import { killProcessTree } from '../src/process_tree.js'
import { readPidFile, stopWorker, workerPidPath } from '../src/worker_lifecycle.js'
import { BUNDLE, bundleTg, makeBundleProject } from './helpers/bundle.js'
import { listProcesses } from './helpers/copilot_session_start_tree.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { openGitGate, type GitGate } from './helpers/git_gate.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { indexableDir } from './helpers/temp-config.js'
import { claimsToBeWorker } from './helpers/worker_identity.js'

/** How many process-table reads the survivors check makes before it calls the processes alive. Each read costs a process listing (tens to hundreds of milliseconds), which is the pause between reads; the count, not a clock, bounds the wait. */
const SURVIVOR_READS = 10

const roots: string[] = []
const gates: GitGate[] = []
const recorded = new Map<number, string>()
const standIns: ChildProcess[] = []

/** The process table's descendants of `root`, with their command lines. */
function descendantsOf(root: number, table: ReturnType<typeof listProcesses>): Map<number, string> {
  const found = new Map<number, string>()
  const queue = [root]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const [pid, entry] of table) {
      if (entry.ppid === next && !found.has(pid)) {
        found.set(pid, entry.args.trim())
        queue.push(pid)
      }
    }
  }
  return found
}

/** What is left of the recorded processes: a pid counts only while it still runs the command line recorded for it, so a reused number or a zombie is not a survivor. */
function survivors(): string[] {
  const table = listProcesses()
  return [...recorded].filter(([pid, args]) => table.get(pid)?.args.trim() === args).map(([pid, args]) => `${pid}: ${args}`)
}

afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.dispose()
  // Whatever the test failed to see ended (a daemon, a held git) is ended here by its recorded command line, with its tree, before the directories it holds are removed.
  for (const [pid, args] of recorded) killIfCommandLine(pid, (commandLine) => commandLine.trim() === args, { tree: true })
  recorded.clear()
  // A stand-in the body never got to record is ended through the handle that started it.
  for (const daemon of standIns.splice(0)) if (daemon.exitCode === null && daemon.signalCode === null) killProcessTree(daemon.pid)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

describe('stopping the built worker daemon', () => {
  it('ends the git the daemon holds, not only the daemon', async () => {
    const { root, env: base } = makeBundleProject('tg-stop-reaps-git-')
    // Outside the OS temp directory, which the worker does not enqueue files from (see tests/helpers/temp-config.ts::indexableDir); the home and data directories stay under the temp root.
    const project = indexableDir()
    roots.push(root)
    const env = { ...base, TG_WORKER_POLL_MS: '200' }
    fs.writeFileSync(path.join(project, 'lib.ts'), 'export function stopReapsGitSym(): number {\n  return 1\n}\n')
    git(project, 'init', '-q')
    git(project, 'add', '-A')
    git(project, 'commit', '-qm', 'old')
    const indexed = bundleTg(project, env, ['index', '.'])
    expect(indexed.status, `indexing failed: ${indexed.stderr}`).toBe(0)
    const dbPath = findGlobalDb(root)
    expect(dbPath, 'indexing left no global.db under the isolated home').not.toBeNull()
    const dir = path.dirname(dbPath as string)
    expect(appendReconcileRequest(dir, project)).toBe(true)

    // The gate rides in the environment `worker start` hands the daemon, so every git the daemon starts reads it. The launching CLI starts no git of its own on this path; one would block on the gate for the whole 60 s of the run.
    const gate = await openGitGate()
    gates.push(gate)
    const started = bundleTg(project, { ...env, ...gate.env }, ['worker', 'start'])
    expect(started.status, `worker start failed: ${started.stderr}`).toBe(0)
    const daemonPid = readPidFile(dir)
    expect(daemonPid, 'worker start left no pid file').not.toBeNull()
    // Recorded at once, so the reaper ends the daemon when a later step fails before the gate is reached; it would otherwise retire itself only after hours.
    recorded.set(daemonPid as number, listProcesses().get(daemonPid as number)?.args.trim() ?? '')

    // The event: a git of the daemon has opened the gate and is blocked reading it.
    await gate.reached

    const table = listProcesses()
    recorded.set(daemonPid as number, table.get(daemonPid as number)?.args.trim() ?? '')
    for (const [pid, args] of descendantsOf(daemonPid as number, table)) recorded.set(pid, args)
    expect(recorded.get(daemonPid as number), 'calibration: the daemon is in the process table').toMatch(/--worker-daemon/)
    expect([...recorded.values()].some((args) => /\bgit\b/i.test(args)), `calibration: a git is held under the daemon, found ${JSON.stringify([...recorded.values()])}`).toBe(true)

    // The daemon runs on the bundle, so that launcher is the install's for the identity check; the real command-line query decides.
    expect(stopWorker(dir, undefined, { entryScript: BUNDLE }), 'stopWorker found no running worker to stop').toBe(true)

    // Polled, not awaited: the daemon is detached with its stdio ignored, so the test holds no handle, pipe or file whose closing says it has exited (the gate's connection ends only with the git), and stopWorker removes the pid file itself. The count bounds the wait, never a clock.
    let left: string[] = []
    for (let read = 0; read < SURVIVOR_READS; read++) {
      left = survivors()
      if (left.length === 0) break
    }
    expect(left, 'the daemon or what it started is still running after worker stop').toEqual([])
  }, 120_000)
})

/** A stand-in daemon: the process stopWorker is given, whose child (plain, so libuv puts it in the daemon's kill-on-close job) has a child the job does not hold. The 3601 echoes keep `ping` alive for an hour, so its command line is the only one of the test with that text. The child inherits the daemon's stdout, which the test holds as a pipe: ping's first line says ping is running, and the pipe closes only when the daemon, the cmd.exe and ping have all exited. */
const GRANDCHILD_ARGS = 'ping -n 3601 127.0.0.1'
/** ping's own command line (the process the job does not hold), not the cmd.exe line that carries the same text; ping prints its arguments with the spacing it was started with. */
const GRANDCHILD_PROCESS = /^ping\s+-n 3601 127\.0\.0\.1\s*$/i
const GRANDCHILD_LAUNCHER = `require('node:child_process').spawn('cmd.exe', ['/d', '/c', '${GRANDCHILD_ARGS}'], { stdio: 'inherit', windowsHide: true }); setInterval(() => undefined, 1 << 30)`
/** A stand-in that only idles. */
const IDLE_LAUNCHER = 'setInterval(() => undefined, 1 << 30)'

/** Starts `node <launcher> --worker-daemon` from a launcher file holding `body`, the command line a worker has, so the identity check reads a real process table row; the launcher is the entry script to hand stopWorker. Reaped through its handle in afterEach, and by recorded command line once the body records it. */
function startStandIn(dir: string, body: string): { daemon: ChildProcess; launcher: string } {
  const launcher = path.join(dir, 'launcher.js')
  fs.writeFileSync(launcher, body)
  const daemon = spawn(process.execPath, [launcher, '--worker-daemon'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  standIns.push(daemon)
  expect(daemon.pid, 'spawning the stand-in daemon produced no pid').toBeDefined()
  daemon.stdout?.resume()
  return { daemon, launcher }
}

/** Bounds only the failing case, where the grandchild outlives worker stop and the pipe never closes; a reap that works ends the wait on the pipe closing, however long a slow machine takes, and the test's own cap sits above this. */
const REAP_BACKSTOP_MS = 60_000

describe('stopping a daemon whose child has a child of its own', () => {
  // Windows only: process.kill(pid) is SIGTERM elsewhere, which the real daemon answers by exiting through its exit hook, and a stand-in with no handler would leave its child behind there for a reason that is the stand-in's.
  it.skipIf(process.platform !== 'win32')('ends the grandchild the daemon kill-on-close job does not hold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-tree-'))
    roots.push(dir)
    const { daemon, launcher } = startStandIn(dir, GRANDCHILD_LAUNCHER)
    const daemonPid = daemon.pid as number
    // The two events, both listened for before either can happen: ping printed its first line, and the daemon is gone with its stdout pipe closed (a ChildProcess 'close' waits for the last holder of the pipe, ping included).
    const pingRunning = new Promise<void>((resolve) => daemon.stdout?.on('data', () => resolve()))
    const everyHolderGone = new Promise<void>((resolve) => daemon.once('close', () => resolve()))

    const first = await Promise.race([pingRunning.then(() => 'ping printed'), everyHolderGone.then(() => 'daemon gone')])
    expect(first, 'calibration: the stand-in daemon exited before ping printed its first line').toBe('ping printed')
    const table = listProcesses()
    const found = descendantsOf(daemonPid, table)
    for (const [pid, args] of found) recorded.set(pid, args)
    recorded.set(daemonPid, table.get(daemonPid)?.args.trim() ?? '')
    expect([...found.values()].some((args) => GRANDCHILD_PROCESS.test(args)), `calibration: ${GRANDCHILD_ARGS} runs under the daemon, found ${JSON.stringify([...found.values()])}`).toBe(true)

    // What startDetachedWorker does right after the spawn: a pid file inside its startup grace is stopWorker's proof that the pid is the worker. Written here, after every wait above, so a slow machine cannot age it past the grace before stopWorker reads it.
    fs.writeFileSync(workerPidPath(dir), `${daemonPid}\n`)
    expect(stopWorker(dir, undefined, { entryScript: launcher }), 'stopWorker found no running worker to stop').toBe(true)

    let backstop: NodeJS.Timeout | undefined
    const reaped = await Promise.race([
      everyHolderGone.then(() => true),
      new Promise<boolean>((resolve) => {
        backstop = setTimeout(() => resolve(false), REAP_BACKSTOP_MS)
      }),
    ]).finally(() => clearTimeout(backstop))
    expect(reaped, `the daemon or what it started is still running after worker stop: ${reaped ? '' : JSON.stringify(survivors())}`).toBe(true)
  }, 120_000)
})

describe('stopping a pid-file pid', () => {
  /** A stand-in recorded for the reaper and the survivors check, with a pid file naming it written last, inside the startup grace stopWorker accepts without a heartbeat. */
  function standInWithPidFile(body: string, name: string): { daemon: ChildProcess; launcher: string; dir: string; pid: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
    roots.push(dir)
    const { daemon, launcher } = startStandIn(dir, body)
    const pid = daemon.pid as number
    recorded.set(pid, listProcesses().get(pid)?.args.trim() ?? '')
    fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
    return { daemon, launcher, dir, pid }
  }

  it('leaves a live process that is not this install worker alone, and drops the stale pid file', () => {
    const { dir, pid } = standInWithPidFile(IDLE_LAUNCHER, 'tg-stop-other-')
    expect(recorded.get(pid), 'calibration: the stand-in is in the process table with its own command line').toMatch(/launcher\.js/)

    // The real query reads the stand-in's command line, which is a node script but not this install's launcher: a reused pid looks exactly like this.
    expect(stopWorker(dir), 'a process that is not this install worker was reported stopped').toBe(false)

    expect(survivors(), 'the unrelated process was ended').toHaveLength(1)
    expect(fs.existsSync(workerPidPath(dir)), 'the stale pid file was left naming an unrelated process').toBe(false)
  })

  it('never signals this process, even when the lookup says it is the worker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-self-'))
    roots.push(dir)
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)

    // The lookup is injected to confirm a worker, so only the refusal of the caller's own pid stands between this test runner and the kill.
    expect(stopWorker(dir, undefined, claimsToBeWorker()), 'stopWorker reported it stopped its own process').toBe(false)

    expect(fs.existsSync(workerPidPath(dir)), 'the pid file naming this process was left as a live lease').toBe(false)
  })

  it('falls back to a bare kill, not a tree kill, when the command-line lookup fails', async () => {
    const { daemon, dir } = standInWithPidFile(process.platform === 'win32' ? GRANDCHILD_LAUNCHER : IDLE_LAUNCHER, 'tg-stop-failed-query-')
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    // Windows: ping prints once it runs, which is the event that the grandchild (outside the daemon kill-on-close job) exists to record and later look for.
    if (process.platform === 'win32') {
      const printed = new Promise<void>((resolve) => daemon.stdout?.once('data', () => resolve()))
      await printed
      const table = listProcesses()
      for (const [pid, args] of descendantsOf(daemon.pid as number, table)) recorded.set(pid, args)
    }

    expect(stopWorker(dir, undefined, { queryCommandLine: () => ({ status: 'failed' }) }), 'a failed lookup was read as a gone process and nothing was signalled').toBe(true)

    await exited
    if (process.platform === 'win32') {
      const ping = [...recorded].find(([, args]) => GRANDCHILD_PROCESS.test(args))
      expect(ping, 'calibration: the grandchild was recorded').toBeDefined()
      expect(survivors().some((line) => line.startsWith(`${ping?.[0]}: `)), 'the grandchild was ended: the fallback took the tree').toBe(true)
    }
  }, 120_000)
})
