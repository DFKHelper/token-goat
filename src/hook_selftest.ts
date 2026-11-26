/** Self-test each registered hook: exe route, then Node route with the native client unresolvable. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildGuardedCommand,
  GUARD_VERSION,
  guardVersionOf,
  parseGuardedCommand,
  stringLiterals,
  wrappedNodeArgv,
  type GuardShell,
} from './hook_guard.js'
import { HOOK_PROBE_ENV } from './stats.js'
import { resolveWindowsBash } from './shell.js'
import { atomicWriteBytes, withStagedWrites } from './util.js'
import { powerShellTextQueryArgs, windowsPowerShellPath } from './windows_powershell.js'

/** Thrown by an install whose registered commands failed the self-test; the previous registration was kept. */
export class HookSelftestError extends Error {}

export interface ShellRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs `command` in `shell` with `input` on stdin; the seam a test replaces to simulate a broken command. */
export type ShellRunner = (shell: GuardShell, command: string, input: string) => ShellRun | null

const SELFTEST_TIMEOUT_MS = 60_000

interface ShellSpawn {
  readonly program: string
  readonly args: string[]
  readonly verbatim: boolean
}

/** The host program and arguments for `command` in `shell`; null if that shell is absent. */
function shellSpawn(shell: GuardShell, command: string): ShellSpawn | null {
  let program: string
  let args: string[]
  let verbatim = false
  if (shell === 'cmd') {
    if (process.platform !== 'win32') return null
    program = process.env['ComSpec'] ?? 'cmd.exe'
    // `cmd /d /s /c "<command>"` is how a host's own spawn of a command string reaches cmd.exe.
    args = ['/d', '/s', '/c', `"${command}"`]
    verbatim = true
  } else if (shell === 'sh') {
    const bash = process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'
    if (bash === null) return null
    program = bash
    args = ['-c', command]
  } else {
    // PowerShell 5.1 is the oldest shell the PowerShell guard must run in; no other platform registers it. Availability is the executable's presence, as for the sh branch's resolveWindowsBash(): a platform check alone let a host with no Windows PowerShell folder (or a test that fakes the platform) spawn a missing path and report ENOENT as a failed hook instead of "no PowerShell on this machine".
    if (process.platform !== 'win32') return null
    program = windowsPowerShellPath()
    if (!fs.existsSync(program)) return null
    args = powerShellTextQueryArgs(command)
  }
  return { program, args, verbatim }
}

const PROBE_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, [HOOK_PROBE_ENV]: '1' })

/** Opens one of directShellRun's own scratch files (the shell's stdin, stdout and stderr), never a project file, so read-deny does not apply. */
function openScratch(file: string, flag: 'r' | 'w'): number {
  return fs.openSync(file, flag)
}

/** One direct run in the host shell; a timeout ends only the shell: the fallback if the helper fails. */
export function directShellRun(spec: ShellSpawn, input: string, timeoutMs: number = SELFTEST_TIMEOUT_MS): ShellRun {
  // Files, not pipes: spawnSync returns only when every holder of a pipe has closed it, and a resident server a hook shim started inherits the job's pipes on Windows and keeps them for its whole life. A file has no end to wait for, so the call returns when the shell exits.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-'))
  const fds: number[] = []
  try {
    fs.writeFileSync(path.join(dir, 'in'), input)
    for (const [name, flag] of [['in', 'r'], ['out', 'w'], ['err', 'w']] as const) fds.push(openScratch(path.join(dir, name), flag))
    const r = spawnSync(spec.program, spec.args, {
      stdio: fds as unknown as [number, number, number],
      env: PROBE_ENV(),
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      cwd: os.tmpdir(),
    })
    if (r.error !== undefined) return { status: null, stdout: '', stderr: String(r.error.message) }
    return { status: r.status, stdout: snapshot(path.join(dir, 'out'))?.toString('utf8') ?? '', stderr: snapshot(path.join(dir, 'err'))?.toString('utf8') ?? '' }
  } finally {
    for (const fd of fds) {
      try {
        fs.closeSync(fd)
      } catch {
        // a descriptor already closed must not keep the scratch from being removed
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // a process still holding the scratch is not a failed hook
    }
  }
}

/** One run in the host shell for the form, as a host spawns a command; null if the shell is absent. */
export const realShellRunner: ShellRunner = (shell, command, input) => {
  const spec = shellSpawn(shell, command)
  if (spec === null) return null
  return runInHelper([{ ...spec, input }], 1, SELFTEST_TIMEOUT_MS)?.[0] ?? directShellRun(spec, input)
}

/** Runs the JSON jobs on stdin `concurrency` at a time, each under its own timeout; prints results in order. */
export const PARALLEL_HELPER = `
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const running = new Map()
// How long a job's output may still arrive after the job exited; a process that outlives the job holding its pipes must not hold the job.
const DRAIN_MS = 1000
const closedChildren = new WeakSet()
// Ends the job's whole tree: a child's own kill reaches only the shell, leaving what it forked running.
const killTree = (child) => {
  const pid = child.pid
  // A closed child has no member left holding its streams: nothing to end, and its pid may be a stranger's.
  if (closedChildren.has(child)) return
  const exited = child.exitCode !== null || child.signalCode !== null
  if (Number.isInteger(pid) && pid > 1) {
    if (process.platform === 'win32') {
      // An exited shell's pid may be recycled: its descendants are not ended, they live until they exit.
      if (!exited) {
        const root = process.env.SystemRoot || process.env.windir || 'C:/Windows'
        const taskkill = path.join(root, 'System32', 'taskkill.exe')
        spawnSync(taskkill, ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10000 })
      }
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }
  if (!exited) child.kill()
}
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  const { jobs, concurrency, timeout, cwd } = JSON.parse(raw)
  const out = new Array(jobs.length)
  let aborted = false
  // The message path is the test's and SIGTERM the owner's (spawnSync has no IPC); an abort stops the queue.
  process.on('message', () => {
    aborted = true
    for (const [child, abort] of [...running]) { killTree(child); abort('aborted by the owner') }
  })
  process.on('SIGTERM', () => {
    for (const child of running.keys()) killTree(child)
    process.exit(143)
  })
  let next = 0
  let active = 0
  const pump = () => {
    while (aborted && next < jobs.length) {
      out[next++] = { status: null, stdout: '', stderr: 'aborted by the owner' }
    }
    while (active < concurrency && next < jobs.length) start(next++)
    if (active === 0 && next >= jobs.length) {
      const body = JSON.stringify(out)
      process.stdout.write(body)
    }
  }
  const start = (i) => {
    active++
    const job = jobs[i]
    let stdout = ''
    let stderr = ''
    let settled = false
    let drain
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      running.delete(child)
      out[i] = r
      active--
      pump()
    }
    // POSIX: its own process group, so the timeout can signal the group; Windows has none and uses taskkill /T
    const detached = process.platform !== 'win32'
    const opts = { cwd, windowsHide: true, windowsVerbatimArguments: job.verbatim, detached }
    // owner: this helper; the child dies when it closes or the timeout below ends its tree
    const child = spawn(job.program, job.args, opts)
    running.set(child, (why) => finish({ status: null, stdout, stderr: why }))
    const timer = setTimeout(() => {
      killTree(child)
      finish({ status: null, stdout, stderr: 'timed out after ' + timeout + ' ms' })
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.on('error', () => {})
    child.on('error', (e) => finish({ status: null, stdout: '', stderr: String(e.message) }))
    // A job's own exit settles it after a short drain, not its pipes closing: a hook shim in the job starts the resident server, which on Windows inherits the job's pipe handles and holds them open for its whole life, so 'close' alone waited out the job's full timeout.
    child.on('exit', (code) => {
      if (settled) return
      // It waits one setImmediate after the drain timer so the poll phase delivers pipe data already pending, then destroys the streams.
      drain = setTimeout(() => {
        setImmediate(() => {
          if (settled) return
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          finish({ status: code, stdout, stderr })
        })
      }, DRAIN_MS)
    })
    child.on('close', (code) => {
      closedChildren.add(child)
      finish({ status: code, stdout, stderr })
    })
    child.stdin.end(job.input)
  }
  pump()
})
`

type HelperJob = ShellSpawn & { readonly input: string }

/** The jobs' results through one helper (a timeout ends each job's tree), or undefined if the helper failed. */
function runInHelper(jobs: readonly HelperJob[], concurrency: number, timeout: number): ShellRun[] | undefined {
  const rounds = Math.ceil(jobs.length / concurrency)
  const helper = spawnSync(process.execPath, ['-e', PARALLEL_HELPER], {
    input: JSON.stringify({ jobs, concurrency, timeout, cwd: os.tmpdir() }),
    encoding: 'utf8',
    env: PROBE_ENV(),
    timeout: timeout * rounds + 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    const parsed: unknown = helper.status === 0 ? JSON.parse(helper.stdout) : undefined
    return Array.isArray(parsed) && parsed.length === jobs.length ? (parsed as ShellRun[]) : undefined
  } catch {
    return undefined
  }
}

export interface Job {
  readonly shell: GuardShell
  readonly command: string
  readonly input: string
}

let resultOverride: ((command: string, run: ShellRun | null) => ShellRun | null) | undefined

/** Test seam: rewrites each job's result after its real run, so every job still runs in the real shell. */
export function setHookSelftestResultOverrideForTesting(next: typeof resultOverride): void {
  resultOverride = next
}

/** Each job's result in order: real shells in parallel through one helper, an injected runner one by one. */
export function runJobs(jobs: readonly Job[]): (ShellRun | null)[] {
  const runs = runJobsOnce(jobs)
  const override = resultOverride
  return override === undefined ? runs : runs.map((run, i) => override(jobs[i]!.command, run))
}

function runJobsOnce(jobs: readonly Job[]): (ShellRun | null)[] {
  const sequential = (): (ShellRun | null)[] => jobs.map((j) => runner(j.shell, j.command, j.input))
  if (runner !== realShellRunner || jobs.length < 2) return sequential()
  const specs = jobs.map((j) => shellSpawn(j.shell, j.command))
  const live = specs.flatMap((spec, i) => (spec === null ? [] : [{ i, spec }]))
  if (live.length < 2) return sequential()
  const concurrency = Math.max(1, Math.min(8, os.availableParallelism()))
  const results = runInHelper(
    live.map(({ i, spec }) => ({ ...spec, input: jobs[i]!.input })),
    concurrency,
    SELFTEST_TIMEOUT_MS,
  )
  // The helper itself failing is not a hook failing: run each job directly as before.
  if (results === undefined) return sequential()
  const out: (ShellRun | null)[] = jobs.map(() => null)
  live.forEach(({ i }, k) => { out[i] = results[k]! })
  return out
}

let runner: ShellRunner = realShellRunner

/** Replace the shell runner, or restore the real one with undefined. */
export function setHookSelftestRunnerForTesting(next: ShellRunner | undefined): void {
  runner = next ?? realShellRunner
}

export interface SelftestOutcome {
  readonly failures: string[]
  /** Commands that ran both routes. */
  readonly tested: number
  /** Commands not run, each with why (unguarded form, no shell on this machine). */
  readonly skipped: string[]
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

// CAPTURE: both forms printed by Node 22 on a run of this suite; the hint names whichever --trace-* flag fits.
const NODE_WARNING_LINE = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning: .+$/
const NODE_WARNING_HINT = /^\(Use `node --trace-[a-z-]+ \.\.\.` to show where the warning was created\)$/

/** Stderr without Node's own process-warning lines, which the host's NODE_OPTIONS can add to a healthy hook. */
function withoutNodeWarnings(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !NODE_WARNING_LINE.test(line.trim()) && !NODE_WARNING_HINT.test(line.trim()))
    .join('\n')
    .trim()
}

/** Host-accepted `stdout`: JSON objects per line (async events send `{"async":true}` first), or empty. */
function validAnswer(harness: string | undefined, event: string, stdout: string, safe: string): boolean {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  // A harness whose own safe answer is empty (Kimi) accepts empty output, a Node-only command included.
  if (lines.length === 0) return harness === 'kimi' || safe === ''
  // Claude Code reads a pre_compact hook's raw stdout as the summarizer's instructions: plain text answers.
  if (event === 'pre_compact' && (harness === 'claudecode' || harness === undefined)) return true
  return lines.every((line) => {
    try {
      const v: unknown = JSON.parse(line)
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    } catch {
      return false
    }
  })
}

/** Whether the notice at `marker` is the client's own (its relay failed under load), not a fall-through. */
function guardWroteNotice(marker: string): boolean {
  return snapshot(marker)?.toString('utf8').includes('"route":"guard"') === true
}

/** Run guarded commands on the exe and Node routes (client unresolvable); report failures; skip unguarded. */
export function selftestRegisteredCommands(commands: readonly string[]): SelftestOutcome {
  const failures: string[] = []
  const skipped: string[] = []
  let tested = 0
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-'))
  try {
    interface Plan {
      readonly parsed: Extract<ReturnType<typeof parseGuardedCommand>, { kind: 'v1' }>
      readonly harness: string | undefined
      readonly event: string
      readonly label: string
      readonly input: string
      readonly exeMarker: string
      readonly exe: Job
      readonly nodeMarker: string
      readonly node: Job | undefined
    }
    const plans: Plan[] = []
    for (const command of new Set(commands)) {
      const parsed = parseGuardedCommand(command)
      if (parsed === undefined || parsed.kind !== 'v1') {
        skipped.push(parsed === undefined ? 'not the guarded form' : `guard ${parsed.kind}`)
        continue
      }
      const harness = flagValue(parsed.native, '--harness')
      const nodeArgv = parsed.native.includes('--') ? wrappedNodeArgv(parsed.native) : parsed.native
      const event = flagValue(parsed.native, '--event') ?? nodeArgv[2] ?? 'unknown'
      // A tool name keeps a tool event's payload well formed, so a clean route has nothing to warn about.
      const probe = { hook_event_name: event, session_id: 'tg-selftest', tool_name: 'tg-selftest' }
      const input = JSON.stringify(probe)
      const exeMarker = path.join(scratch, `exe-marker-${String(plans.length)}`)
      const exeCommand = buildGuardedCommand({
        shell: parsed.shell,
        native: parsed.native,
        safe: parsed.safe,
        marker: exeMarker,
      })
      const nodeMarker = path.join(scratch, `marker-${String(plans.length)}`)
      const unresolvable = path.join(scratch, 'no-such-dir', path.basename(parsed.native[0]!))
      const viaNode = parsed.native.includes('--') && nodeArgv.length > 0
        ? buildGuardedCommand({
            shell: parsed.shell,
            native: [unresolvable, ...parsed.native.slice(1)],
            safe: parsed.safe,
            marker: nodeMarker,
          })
        : undefined
      plans.push({
        parsed,
        harness,
        event,
        label: `${harness ?? 'hook'} ${event}`,
        input,
        exeMarker,
        exe: { shell: parsed.shell, command: exeCommand, input },
        nodeMarker,
        node: viaNode === undefined ? undefined : { shell: parsed.shell, command: viaNode, input },
      })
    }
    // Every route of every command runs at once: the runs share nothing but the shells they start in.
    const jobs = plans.flatMap((plan) => (plan.node === undefined ? [plan.exe] : [plan.exe, plan.node]))
    const results = runJobs(jobs)
    let at = 0
    for (const plan of plans) {
      const { parsed, harness, event, label } = plan
      const exe = results[at++]!
      const node = plan.node === undefined ? undefined : results[at++]
      if (exe === null) {
        const shellName = parsed.shell === 'sh'
          ? 'POSIX shell (Git Bash)'
          : parsed.shell === 'cmd' ? 'cmd.exe' : 'PowerShell'
        skipped.push(`${label}: no ${shellName} on this machine`)
        continue
      }
      const problem = (run: ShellRun, route: string): string | undefined =>
        run.status !== 0
          ? `${label} (${route}): exit ${String(run.status)}: ${run.stderr.trim().slice(0, 300)}`
          : withoutNodeWarnings(run.stderr) !== ''
            ? `${label} (${route}): wrote to stderr: ${withoutNodeWarnings(run.stderr).slice(0, 300)}`
            : validAnswer(harness, event, run.stdout, parsed.safe)
              ? undefined
              : `${label} (${route}): not a valid answer: ${run.stdout.trim().slice(0, 200)}`
      const exeProblem = problem(exe, 'native client')
      if (exeProblem !== undefined) failures.push(exeProblem)
      else if (guardWroteNotice(plan.exeMarker)) {
        failures.push(`${label}: nothing could run, so the command fell through to the safe answer`)
      }

      if (!parsed.native.includes('--')) {
        // A Node-only registration has no client to make unresolvable: the run above is its Node route.
        tested++
        continue
      }
      if (plan.node === undefined) {
        skipped.push(`${label}: no Node route registered`)
        continue
      }
      if (node === null || node === undefined) continue
      const nodeProblem = problem(node, 'Node route')
      if (nodeProblem !== undefined) failures.push(nodeProblem)
      else if (fs.existsSync(plan.nodeMarker)) {
        failures.push(
          `${label} (Node route): the Node shim could not run, ` +
            `so the command fell through to the safe answer`,
        )
      }
      tested++
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return { failures, tested, skipped }
}

/** Throw a {@link HookSelftestError} naming each failure if `commands` fail; `where` names the config kept. */
export function assertRegisteredCommandsWork(commands: readonly string[], where: string): SelftestOutcome {
  const outcome = selftestRegisteredCommands(commands)
  if (outcome.failures.length > 0) {
    throw new HookSelftestError(
      `the hook commands written to ${where} failed their self-test, so the previous registration was kept: ` +
        `${outcome.failures.join('; ')}`,
    )
  }
  return outcome
}

/** The guarded commands a config file's text holds: every string literal that starts like a guard. */
export function guardedCommandsInText(raw: string): string[] {
  return stringLiterals(raw).filter((lit) => guardVersionOf(lit) !== undefined)
}

/** Newest guard version `raw` holds if newer than {@link GUARD_VERSION}, else undefined. */
export function newerGuardInText(raw: string): number | undefined {
  const versions = guardedCommandsInText(raw)
    .map((c) => guardVersionOf(c) ?? 0)
    .filter((v) => v > GUARD_VERSION)
  return versions.length === 0 ? undefined : Math.max(...versions)
}

/** A file's bytes; undefined if absent, null if unreadable as a file (the caller's own error is raised). */
function snapshot(file: string): Buffer | undefined | null {
  if (!fs.existsSync(file)) return undefined
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/** Rounds a publish may lose to a second writer before the install gives up without writing. */
const MAX_PUBLISH_ROUNDS = 3

/** Whether two snapshots hold the same bytes (or both none). */
function sameSnapshot(a: Buffer | undefined | null, b: Buffer | undefined | null): boolean {
  return a === b || (a instanceof Buffer && b instanceof Buffer && a.equals(b))
}

/** Run `write` with `files` held back, self-test the commands they carry, then publish them. */
export function verifiedInstall<T>(files: readonly string[], write: () => T): T {
  for (let round = 1; ; round++) {
    const outcome = installRound(files, write)
    if (outcome.raced === undefined) return outcome.result
    // The staged bytes were built from a config another writer has since changed: build them again from it.
    if (round >= MAX_PUBLISH_ROUNDS) {
      throw new HookSelftestError(
        `${outcome.raced} changed under the install ${String(MAX_PUBLISH_ROUNDS)} times while its hooks were ` +
          `checked, so nothing was written to it: run the install again`,
      )
    }
  }
}

/** One probe-then-publish pass; `raced` names the file a second writer changed before it could be published. */
function installRound<T>(files: readonly string[], write: () => T): { result: T; raced?: string } {
  const before = files.map(snapshot)
  if (before.includes(null)) return { result: write() }
  const { result, staged } = withStagedWrites(files, write)
  // A held file is probed from the bytes it was given; a file `write` changed some other way is read off disk.
  const after = files.map((f) => staged.get(f) ?? snapshot(f))
  // limit: compare and rename are two calls, a write between them is lost; revisit-when: a lock exists
  const publish = (): { result: T; raced?: string } => {
    const pending = files.flatMap((f, i) => {
      const bytes = staged.get(f)
      const was = before[i] ?? undefined
      return bytes !== undefined && !(was !== undefined && bytes.equals(was)) ? [{ f, bytes, i }] : []
    })
    const raced = pending.find(({ f, i }) => !sameSnapshot(snapshot(f), before[i]))
    if (raced !== undefined) return { result, raced: raced.f }
    pending.forEach(({ f, bytes }) => atomicWriteBytes(f, bytes))
    return { result }
  }
  // Registrations a newer build wrote stay as it wrote them: this build cannot read their guard.
  files.forEach((f, i) => {
    const was = before[i]
    const newer = was === undefined || was === null ? undefined : newerGuardInText(was.toString('utf8'))
    if (newer === undefined || was === undefined || was === null
      || (after[i] !== undefined && after[i] !== null && was.equals(after[i]!))) return
    // A held write is dropped; a file `write` changed directly is put back.
    if (staged.has(f)) staged.delete(f)
    else atomicWriteBytes(f, was)
    after[i] = was
    process.stderr.write(
      `token-goat: left ${f} as it was: its hooks carry guard version ${String(newer)}, ` +
        `written by a newer token-goat than this one (guard version ${String(GUARD_VERSION)}). ` +
        `Upgrade this install to change them.\n`,
    )
  })
  if (files.every((_f, i) => before[i] !== undefined && after[i] !== undefined && after[i] !== null
    && before[i]!.equals(after[i]!))) {
    return publish()
  }
  const commands = after.flatMap((buf) =>
    buf === undefined || buf === null ? [] : guardedCommandsInText(buf.toString('utf8')))
  try {
    assertRegisteredCommandsWork(commands, files.join(', '))
  } catch (e) {
    files.forEach((f, i) => {
      // A held write was never published, so there is nothing of this install on disk to take back.
      if (staged.has(f)) return
      // Only a file still holding the bytes this install wrote is rolled back: another may have replaced it.
      const now = snapshot(f)
      const wrote = after[i]
      const unchanged = now === wrote || (now instanceof Buffer && wrote instanceof Buffer && now.equals(wrote))
      if (!unchanged) {
        process.stderr.write(`token-goat: left ${f} as it is: another install changed it during the check.\n`)
        return
      }
      if (before[i] !== undefined && before[i] !== null) atomicWriteBytes(f, before[i]!)
      else fs.rmSync(f, { force: true })
    })
    throw e
  }
  return publish()
}
