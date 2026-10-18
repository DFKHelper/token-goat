// Provenance: HAND-DERIVED for the repository, the request and the process-table walk. The gate is tests/helpers/git_gate.ts (CAPTURE, see its header); the daemon is started by the built bundle's own `worker start`, the production path (detached, stdio ignored, pid file claimed); the daemon's command line comes from the production query (src/resident_process.ts::queryProcessCommandLine) and the process table from tests/helpers/copilot_session_start_tree.ts::listProcesses (Get-CimInstance Win32_Process on Windows, `ps -eo pid=,ppid=,args=` elsewhere).
/** `worker stop` leaves nothing of the daemon behind, git included. On Windows `process.kill(pid)` is TerminateProcess and no handler in the daemon runs, so what the daemon started is reaped only by the OS: libuv puts a plain child in a kill-on-close job (libuv 1.51.0 src/win/process.c, read this run), which takes the daemon's direct git with it but not a grandchild of that git (the job allows silent breakaway), and a taskkill /T of the daemon reaches both. The first test holds a real git of a real bundle daemon on tests/helpers/git_gate.ts and asserts that after `stopWorker` the daemon is gone and the gate holds no git, so no git of the daemon survives; on POSIX that fails against a daemon that exits without ending its git, and on Windows it cannot tell a tree kill from a single kill, because the git is the daemon's direct child and the kill-on-close job ends it either way; the second (Windows only) holds a grandchild outside the job and is the one that fails against a bare `process.kill(pid)`. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, describe, expect, it, type TestContext } from 'vitest'

import { appendReconcileRequest } from '../src/dirty_queue.js'
import { killProcessTree } from '../src/process_tree.js'
import { queryProcessCommandLine } from '../src/resident_process.js'
import { readPidFile, stopWorker, workerErrorLogPath, workerPidPath } from '../src/worker_lifecycle.js'
import { BUNDLE, bundleTg, makeBundleProject } from './helpers/bundle.js'
import { listProcesses } from './helpers/copilot_session_start_tree.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { openGitGate, type GitGate } from './helpers/git_gate.js'
import { isWorkerDaemonCommandLine, killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'
import { runTeardown } from './helpers/strict_teardown.js'
import { indexableDir } from './helpers/temp-config.js'
import { claimsToBeWorker } from './helpers/worker_identity.js'

/** The outcome the daemon logs when its 5 s cap ended the git it was holding (src/reconcile_requests.ts::drainReconcileRequestsAsync); tests/worker_reconcile_request_bundle.test.ts matches the same text in the bundle's log. */
const CAP_NOTE = 'git did not answer in time, continuing next cycle'

const roots: string[] = []
const gates: GitGate[] = []
const recorded = new Map<number, string>()
const standIns: ChildProcess[] = []
/** Worker daemons this test started, by pid; each is ended only while its command line is a worker daemon's. */
const daemons: number[] = []
/** Directory watchers this test opened; each is closed in afterEach whatever the body reached. */
const watchers: fs.FSWatcher[] = []

/** The daemon's own account of what became of the reconcile request, from the line src/reconcile_requests.ts::logOutcome appends to worker-errors.log (CAPTURE: the built bundle's daemon wrote it): the text after "reconcile request for <dir>: ", or null while the daemon has logged none. */
function reconcileOutcome(dir: string): string | null {
  let log = ''
  try {
    log = fs.readFileSync(workerErrorLogPath(dir), 'utf8')
  } catch {
    // Not written yet.
  }
  return /reconcile request for .*?: (.*)$/m.exec(log)?.[1]?.trim() ?? null
}

/** Resolves with the daemon's first outcome line for the request, heard as the log changes: the daemon writes one for every way its git can end, so this waits on that event and on no clock. The existing hook timeout is the only bound, for a daemon that never answers. */
function untilReconcileOutcome(dir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const check = (): void => {
      const outcome = reconcileOutcome(dir)
      if (outcome !== null) resolve(outcome)
    }
    const watcher = fs.watch(dir, check)
    watchers.push(watcher)
    watcher.on('error', reject)
    check()
  })
}

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
  return runningAmong([...recorded].map(([pid, args]) => ({ pid, label: args, same: (commandLine) => commandLine === args })))
}

/** Every process this test started that still runs: the recorded ones, and the daemons by their own command line. */
function stillRunning(): string[] {
  const daemonRows = daemons.map((pid) => ({ pid, label: 'a worker daemon', same: isWorkerDaemonCommandLine }))
  return [...survivors(), ...runningAmong(daemonRows)]
}

/** A process to look for: its pid, the text to list it under, and whether a command line read now is still the one it was recorded with. */
interface Watched {
  pid: number
  label: string
  same: (commandLine: string) => boolean
}

/** The watched processes that still run. A table that cannot be read, or that lists the pid with an empty command line, is no evidence of an exit, so that pid stays listed; a table that read fine and lacks the pid, or lists another command line, is the evidence that it is gone. Off Windows a signal-0 probe is the cheap first answer and costs no process, so one process-table read is taken only while some pid still answers, to tell it from a process that reused the number. On Windows signal 0 is no evidence of an exit: it reports ESRCH once the exit code is set, while the process is still listed (measured: the worker daemon listed in the process table after process.kill(pid, 0) threw, and the removal of the directory it had used failed with EPERM at that moment and succeeded 4.2 s later), so the table alone decides there. */
function runningAmong(watched: readonly Watched[]): string[] {
  const answering = process.platform === 'win32' ? [...watched] : watched.filter(({ pid }) => processAlive(pid))
  if (answering.length === 0) return []
  let table: ReturnType<typeof listProcesses> | null
  try {
    table = listProcesses()
  } catch {
    table = null
  }
  return answering.flatMap(({ pid, label, same }) => {
    const entry = table?.get(pid)
    if (table !== null && entry === undefined) return []
    const commandLine = entry?.args.trim() ?? ''
    return commandLine === '' || same(commandLine) ? [`${pid}: ${label}`] : []
  })
}

/** Reads until `read` lists nothing, or until `signal` aborts (the test's timeout or cancellation), and returns what the last read listed. Nothing here decides a pass by a clock: the wait ends on the processes going, however long a slow machine takes, and the test's own cap bounds the failing case. The loop yields through a timer between reads so the gate's own events (a pipe closing) are heard: measured on Windows, a `setImmediate` yield left a closed pipe unheard across four reads of about 2 s each, and a 25 ms timer heard it at once. */
async function untilNothingLeft(read: () => string[], signal?: AbortSignal): Promise<string[]> {
  let left = read()
  while (left.length > 0 && signal?.aborted !== true) {
    try {
      await sleep(25, undefined, { signal })
    } catch {
      return left
    }
    left = read()
  }
  return left
}

/** A timeout names no process, so the test's abort (its timeout or a cancellation) takes one reading of what `read` lists, before the teardown ends anything, and a test that then failed gets it appended to its error message. A reading that throws is reported as such, never as an empty list. */
function nameWhatIsLeft(ctx: TestContext, read: () => string[]): void {
  let seen: string | undefined
  ctx.signal.addEventListener('abort', () => {
    try {
      seen = JSON.stringify(read())
    } catch (error) {
      seen = `unreadable: ${String(error)}`
    }
  }, { once: true })
  ctx.onTestFailed(({ task }) => {
    const error = task.result?.errors?.[0]
    if (error !== undefined && seen !== undefined) error.message = `${error.message}\nstill running when the test timed out: ${seen}`
  })
}

// Every step runs and every failure is reported together (strict_teardown). The processes go first and are waited for until the process table no longer lists them, so the removal has nothing holding it; a removal that still fails is the failure to report, not one to retry. The wait is bounded only by the hook timeout: the hook's own signal ends it there, so no process listing is started after a timed-out hook.
afterEach(async (ctx) => {
  const failures: unknown[] = []
  const run = (steps: ReadonlyArray<() => void>): void => {
    try {
      runTeardown(steps)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const watcher of watchers.splice(0)) watcher.close()
  for (const gate of gates.splice(0)) await gate.dispose().catch((error: unknown) => failures.push(error))
  // One process-table listing, read by the first step that needs it, answers every pid's command line below: the per-pid query starts a PowerShell for each pid on Windows, about 2 s apiece, and a failed listing fails only the step that read it.
  let table: ReturnType<typeof listProcesses> | undefined
  const readCommandLine = (pid: number): string | null => (table ??= listProcesses()).get(pid)?.args ?? null
  try {
    // Whatever the test failed to see ended (a daemon, a held git) is ended by its recorded command line, with its tree, before the directories it holds are removed. A stand-in the body never got to record is ended through the handle that started it.
    run([
      ...[...recorded].filter(([pid]) => processAlive(pid)).map(([pid, args]) => () => void killIfCommandLine(pid, (commandLine) => commandLine.trim() === args, { tree: true, readCommandLine })),
      ...daemons.filter(processAlive).map((pid) => () => void killIfCommandLine(pid, isWorkerDaemonCommandLine, { tree: true, readCommandLine })),
      ...standIns.splice(0).map((daemon) => () => {
        if (daemon.exitCode === null && daemon.signalCode === null) killProcessTree(daemon.pid)
      }),
    ])
    const left = await untilNothingLeft(stillRunning, ctx.signal)
    if (left.length > 0) failures.push(new Error(`still running after the teardown ended them: ${JSON.stringify(left)}`))
    run(roots.splice(0).map((root) => () => fs.rmSync(root, { recursive: true, force: true })))
  } finally {
    recorded.clear()
    daemons.length = 0
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} teardown step(s) failed`)
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

describe('stopping the built worker daemon', () => {
  it('ends the git the daemon holds, not only the daemon', async (ctx) => {
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
    // The gate rides in the environment `worker start` hands the daemon, so every git the daemon starts reads it. The launching CLI starts no git of its own on this path; one would block on the gate for the whole 60 s of the run.
    const gate = await openGitGate()
    gates.push(gate)
    const started = bundleTg(project, { ...env, ...gate.env }, ['worker', 'start'])
    expect(started.status, `worker start failed: ${started.stderr}`).toBe(0)
    const daemonPid = readPidFile(dir)
    expect(daemonPid, 'worker start left no pid file').not.toBeNull()
    // Handed to the reaper at once, so it ends the daemon when a later step fails before the gate is reached; it would otherwise retire itself only after hours.
    daemons.push(daemonPid as number)

    // The daemon's command line comes from the real query now, before the request exists: the query takes 0.8 to 3.6 s here, and once the daemon holds a git its own 5 s cap (src/reconcile_requests.ts) is running beside whatever the test does.
    const query = queryProcessCommandLine(daemonPid as number)
    expect(query.status, 'calibration: the real query found the daemon').toBe('found')
    const daemonLine = query.status === 'found' ? query.commandLine.trim() : ''
    expect(daemonLine, 'calibration: the daemon runs the worker-daemon command line').toMatch(/--worker-daemon/)
    recorded.set(daemonPid as number, daemonLine)
    expect(survivors(), 'calibration: the process table lists the daemon under the line the query returned').toHaveLength(1)

    // The request is appended to a running daemon, which sweeps it on its next cycle: its first git is the one that opens the gate.
    expect(appendReconcileRequest(dir, project)).toBe(true)
    // The event: a git of the daemon has opened the gate and is blocked reading it; nothing else carries the gate, so it is the daemon's own git.
    await gate.reached
    // Read in the same turn as the event and with only the kill between. The daemon's own 5 s cap (src/reconcile_requests.ts) runs from its git's spawn and may have ended that git first on a slow or loaded machine; that is the machine's, not a defect of stop, so the daemon's own account decides, from the log it writes once its git ends and on no clock: its cap note skips this row with the reason, and anything else (a gate released early, a mutant that disposes it right after the event) leaves the git not held and fails the assertion below.
    const held = gate.holding()
    if (!held) {
      const outcome = await untilReconcileOutcome(dir)
      if (outcome === CAP_NOTE) ctx.skip(`the daemon's 5 s git cap ended its git before worker stop ran, so stop has nothing to reap here: ${outcome}`)
    }
    expect(held, 'calibration: a git of the daemon still holds the gate when worker stop runs').toBe(true)

    // The daemon runs on the bundle, so that launcher is the install's; the identity check judges the line the real query returned.
    expect(stopWorker(dir, undefined, { entryScript: BUNDLE, queryCommandLine: () => query }), 'stopWorker found no running worker to stop').toBe(true)
    // stopWorker removes the pid file, and a daemon whose pid file stays absent retires itself after its startup grace (src/worker.ts::runWorkerLoop), which would end it and its git with no help from stop; written back, so only the signal can end the daemon here.
    fs.writeFileSync(workerPidPath(dir), `${daemonPid}\n`)

    // Read until nothing is left, not once: on POSIX the daemon answers SIGTERM by finishing its in-flight work and then exiting through its exit hook, which ends the git it owns, so the processes go a moment after stopWorker returns. Each pass probes the daemon's pid (a process-table read only while it still answers) and the gate for the git, and the loop waits on those two ending, not on a clock or a count; only the test's own cap and its abort end a wait that never finishes. Windows: the held git is the daemon's direct child, so libuv's kill-on-close job ends it with the daemon whatever the taskkill does; this row cannot tell a tree kill from a single kill there, and the grandchild test below is the one that can.
    const leftNow = (): string[] => [...survivors(), ...(gate.holding() ? ['a git still holds the gate'] : [])]
    nameWhatIsLeft(ctx, leftNow)
    const left = await untilNothingLeft(leftNow, ctx.signal)
    expect(left,'the daemon or the git it held is still running after worker stop').toEqual([])
    // The cap may have ended the git just before the kill landed, in which case an empty table says nothing about stop; the daemon's note, written once its git ends, is the only record of that, so a row that finds it cannot claim the property and skips. A cap that fired in the milliseconds before the daemon was killed may leave no note: that window is bounded by one stopWorker call and is not closed here.
    if (reconcileOutcome(dir) === CAP_NOTE) ctx.skip(`the daemon's 5 s git cap ended its git around the time worker stop ran, so what ended the git cannot be told: ${CAP_NOTE}`)
  })
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

describe('stopping a daemon whose child has a child of its own', () => {
  // Windows only: process.kill(pid) is SIGTERM elsewhere, which the real daemon answers by exiting through its exit hook, and a stand-in with no handler would leave its child behind there for a reason that is the stand-in's.
  it.skipIf(process.platform !== 'win32')('ends the grandchild the daemon kill-on-close job does not hold', async (ctx) => {
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

    // The pipe closes only when the daemon, the cmd.exe and ping have all exited, so this wait is the assertion: a bare kill leaves ping holding it. No clock decides it; the test's own cap fails a daemon or ping that never goes, and the failure lists what still runs.
    nameWhatIsLeft(ctx, survivors)
    await everyHolderGone
  })
})

describe('stopping a pid-file pid', () => {
  /** A stand-in recorded for the reaper and the survivors check, with no pid file yet: the caller writes it with claimAsWorker once every wait is behind it. */
  function recordedStandIn(body: string, name: string): { daemon: ChildProcess; launcher: string; dir: string; pid: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), name))
    roots.push(dir)
    const { daemon, launcher } = startStandIn(dir, body)
    const pid = daemon.pid as number
    recorded.set(pid, listProcesses().get(pid)?.args.trim() ?? '')
    return { daemon, launcher, dir, pid }
  }

  /** What startDetachedWorker does right after the spawn: a pid file inside its startup grace is stopWorker's proof that a stand-in with no heartbeat is the worker, so it is written last, with nothing slow between it and stopWorker. */
  function claimAsWorker(dir: string, pid: number): void {
    fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
  }

  it('leaves a live process that is not this install worker alone, and drops the stale pid file', () => {
    const { dir, pid } = recordedStandIn(IDLE_LAUNCHER, 'tg-stop-other-')
    expect(recorded.get(pid), 'calibration: the stand-in is in the process table with its own command line').toMatch(/launcher\.js/)
    claimAsWorker(dir, pid)

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
    const { daemon, dir, pid } = recordedStandIn(process.platform === 'win32' ? GRANDCHILD_LAUNCHER : IDLE_LAUNCHER, 'tg-stop-failed-query-')
    // The bare awaits below (ping's first line, the exit) have no bound of their own: a stand-in that never prints or never exits fails by the test's default cap, which is acceptable as a failure bound and never decides a pass.
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    // Windows: ping prints once it runs, which is the event that the grandchild (outside the daemon kill-on-close job) exists to record and later look for.
    if (process.platform === 'win32') {
      const printed = new Promise<void>((resolve) => daemon.stdout?.once('data', () => resolve()))
      await printed
      const table = listProcesses()
      for (const [childPid, args] of descendantsOf(pid, table)) recorded.set(childPid, args)
      // Checked before the kill, so a miss fails here instead of leaving ping running for an hour.
      expect([...recorded.values()].some((args) => GRANDCHILD_PROCESS.test(args)), 'calibration: the grandchild was recorded').toBe(true)
    }

    claimAsWorker(dir, pid)
    expect(stopWorker(dir, undefined, { queryCommandLine: () => ({ status: 'failed' }) }), 'a failed lookup was read as a gone process and nothing was signalled').toBe(true)

    await exited
    if (process.platform === 'win32') {
      const ping = [...recorded].find(([, args]) => GRANDCHILD_PROCESS.test(args))
      expect(survivors().some((line) => line.startsWith(`${ping?.[0]}: `)), 'the grandchild was ended: the fallback took the tree').toBe(true)
    }
  })
})
