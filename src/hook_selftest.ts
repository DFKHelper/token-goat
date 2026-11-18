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
import { atomicWriteBytes } from './util.js'
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
    // PowerShell 5.1 is the oldest shell the PowerShell guard must run in; no other platform registers it.
    if (process.platform !== 'win32') return null
    program = windowsPowerShellPath()
    args = powerShellTextQueryArgs(command)
  }
  return { program, args, verbatim }
}

const PROBE_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, [HOOK_PROBE_ENV]: '1' })

/** One run in the host shell for the form, as a host spawns a command; null if the shell is absent. */
export const realShellRunner: ShellRunner = (shell, command, input) => {
  const spec = shellSpawn(shell, command)
  if (spec === null) return null
  const r = spawnSync(spec.program, spec.args, {
    input,
    encoding: 'utf8',
    env: PROBE_ENV(),
    timeout: SELFTEST_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
    cwd: os.tmpdir(),
    maxBuffer: 8 * 1024 * 1024,
  })
  if (r.error !== undefined) return { status: null, stdout: '', stderr: String(r.error.message) }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** Runs the JSON jobs on stdin `concurrency` at a time, each under its own timeout; prints results in order. */
export const PARALLEL_HELPER = `
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
// Ends the job's whole tree: a child's own kill reaches only the shell, leaving what it forked running.
const killTree = (child) => {
  const pid = child.pid
  if (Number.isInteger(pid) && pid > 1) {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || process.env.windir || 'C:/Windows'
      const taskkill = path.join(root, 'System32', 'taskkill.exe')
      spawnSync(taskkill, ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 10000 })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch {}
    }
  }
  child.kill()
}
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  const { jobs, concurrency, timeout, cwd } = JSON.parse(raw)
  const out = new Array(jobs.length)
  let next = 0
  let active = 0
  const pump = () => {
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
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      out[i] = r
      active--
      pump()
    }
    // POSIX: its own process group, so the timeout can signal the group; Windows has none and uses taskkill /T
    const detached = process.platform !== 'win32'
    const opts = { cwd, windowsHide: true, windowsVerbatimArguments: job.verbatim, detached }
    // owner: this helper; the child dies when it closes or the timeout below ends its tree
    const child = spawn(job.program, job.args, opts)
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
    child.on('close', (code) => finish({ status: code, stdout, stderr }))
    child.stdin.end(job.input)
  }
  pump()
})
`

export interface Job {
  readonly shell: GuardShell
  readonly command: string
  readonly input: string
}

/** Each job's result in order: real shells in parallel through one helper, an injected runner one by one. */
export function runJobs(jobs: readonly Job[]): (ShellRun | null)[] {
  const sequential = (): (ShellRun | null)[] => jobs.map((j) => runner(j.shell, j.command, j.input))
  if (runner !== realShellRunner || jobs.length < 2) return sequential()
  const specs = jobs.map((j) => shellSpawn(j.shell, j.command))
  const live = specs.flatMap((spec, i) => (spec === null ? [] : [{ i, spec }]))
  if (live.length < 2) return sequential()
  const concurrency = Math.max(1, Math.min(8, os.availableParallelism()))
  const rounds = Math.ceil(live.length / concurrency)
  const helper = spawnSync(process.execPath, ['-e', PARALLEL_HELPER], {
    input: JSON.stringify({
      jobs: live.map(({ i, spec }) => ({ ...spec, input: jobs[i]!.input })),
      concurrency,
      timeout: SELFTEST_TIMEOUT_MS,
      cwd: os.tmpdir(),
    }),
    encoding: 'utf8',
    env: PROBE_ENV(),
    timeout: SELFTEST_TIMEOUT_MS * rounds + 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  let results: ShellRun[] | undefined
  try {
    const parsed: unknown = helper.status === 0 ? JSON.parse(helper.stdout) : undefined
    if (Array.isArray(parsed) && parsed.length === live.length) results = parsed as ShellRun[]
  } catch {
    results = undefined
  }
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
  try {
    return fs.readFileSync(marker, 'utf8').includes('"route":"guard"')
  } catch {
    return false
  }
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
      readonly markerBefore: boolean
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
      const input = JSON.stringify({ hook_event_name: event, session_id: 'tg-selftest' })
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
        markerBefore: fs.existsSync(parsed.marker),
        exe: { shell: parsed.shell, command, input },
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
          : validAnswer(harness, event, run.stdout, parsed.safe)
            ? undefined
            : `${label} (${route}): not a valid answer: ${run.stdout.trim().slice(0, 200)}`
      const exeProblem = problem(exe, 'native client')
      if (exeProblem !== undefined) failures.push(exeProblem)
      else if (!plan.markerBefore && guardWroteNotice(parsed.marker)) {
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

/** Run `write`, self-test its guarded commands; on failure restore every file (or absence) and rethrow. */
export function verifiedInstall<T>(files: readonly string[], write: () => T): T {
  const before = files.map(snapshot)
  if (before.includes(null)) return write()
  const result = write()
  const after = files.map(snapshot)
  // Registrations a newer build wrote stay as it wrote them: this build cannot read their guard.
  files.forEach((f, i) => {
    const was = before[i]
    const newer = was === undefined || was === null ? undefined : newerGuardInText(was.toString('utf8'))
    if (newer === undefined || was === undefined || was === null
      || (after[i] !== undefined && after[i] !== null && was.equals(after[i]!))) return
    atomicWriteBytes(f, was)
    after[i] = was
    process.stderr.write(
      `token-goat: left ${f} as it was: its hooks carry guard version ${String(newer)}, ` +
        `written by a newer token-goat than this one (guard version ${String(GUARD_VERSION)}). ` +
        `Upgrade this install to change them.\n`,
    )
  })
  if (files.every((_f, i) => before[i] !== undefined && after[i] !== undefined && after[i] !== null
    && before[i]!.equals(after[i]!))) return result
  const commands = after.flatMap((buf) =>
    buf === undefined || buf === null ? [] : guardedCommandsInText(buf.toString('utf8')))
  try {
    assertRegisteredCommandsWork(commands, files.join(', '))
  } catch (e) {
    files.forEach((f, i) => {
      if (before[i] !== undefined && before[i] !== null) atomicWriteBytes(f, before[i]!)
      else fs.rmSync(f, { force: true })
    })
    throw e
  }
  return result
}
