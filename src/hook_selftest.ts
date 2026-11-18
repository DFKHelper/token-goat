/** The install self-test: run each registered hook command the way its host does, through the same shell, with a harmless payload, then run it again with the native client made unresolvable to prove the Node route. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildGuardedCommand, guardVersionOf, parseGuardedCommand, stringLiterals, wrappedNodeArgv, type GuardShell } from './hook_guard.js'
import { HOOK_PROBE_ENV } from './stats.js'
import { resolveWindowsBash } from './shell.js'
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

/** The host's shell run: Git Bash (or `/bin/sh`) for the sh form, Windows PowerShell 5.1 for the other. null when this machine has no such shell. */
export const realShellRunner: ShellRunner = (shell, command, input) => {
  let program: string
  let args: string[]
  if (shell === 'sh') {
    const bash = process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'
    if (bash === null) return null
    program = bash
    args = ['-c', command]
  } else {
    // Windows PowerShell 5.1 is the oldest shell the PowerShell guard must run in; no other platform registers that form.
    if (process.platform !== 'win32') return null
    program = windowsPowerShellPath()
    args = powerShellTextQueryArgs(command)
  }
  const r = spawnSync(program, args, { input, encoding: 'utf8', env: { ...process.env, [HOOK_PROBE_ENV]: '1' }, timeout: SELFTEST_TIMEOUT_MS, windowsHide: true, cwd: os.tmpdir(), maxBuffer: 8 * 1024 * 1024 })
  if (r.error !== undefined) return { status: null, stdout: '', stderr: String(r.error.message) }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
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

/** Whether `stdout` is an answer the host accepts: JSON objects, one per line (an async event answers `{"async":true}` first), or nothing at all for the harnesses whose answer is empty. */
function validAnswer(harness: string | undefined, stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return harness === 'kimi'
  return lines.every((line) => {
    try {
      const v: unknown = JSON.parse(line)
      return v !== null && typeof v === 'object' && !Array.isArray(v)
    } catch {
      return false
    }
  })
}

/** Whether the notice at `marker` is the guard's own: the client writes the same file (route startup, node-argv) when it ran but its relay failed under load, which is not a fall-through. */
function guardWroteNotice(marker: string): boolean {
  try {
    return fs.readFileSync(marker, 'utf8').includes('"route":"guard"')
  } catch {
    return false
  }
}

/** Run each guarded command on the exe route as registered and on the Node route with the client unresolvable, and report what failed. An unguarded command is skipped. */
export function selftestRegisteredCommands(commands: readonly string[]): SelftestOutcome {
  const failures: string[] = []
  const skipped: string[] = []
  let tested = 0
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-'))
  try {
    for (const command of new Set(commands)) {
      const parsed = parseGuardedCommand(command)
      if (parsed === undefined || parsed.kind !== 'v1') {
        skipped.push(parsed === undefined ? 'not the guarded form' : `guard ${parsed.kind}`)
        continue
      }
      const harness = flagValue(parsed.native, '--harness')
      const event = flagValue(parsed.native, '--event') ?? 'unknown'
      const input = JSON.stringify({ hook_event_name: event, session_id: 'tg-selftest' })
      const label = `${harness ?? 'hook'} ${event}`
      const markerBefore = fs.existsSync(parsed.marker)
      const exe = runner(parsed.shell, command, input)
      if (exe === null) {
        skipped.push(`${label}: no ${parsed.shell === 'sh' ? 'POSIX shell (Git Bash)' : 'PowerShell'} on this machine`)
        continue
      }
      const problem = (run: ShellRun, route: string): string | undefined =>
        run.status !== 0 ? `${label} (${route}): exit ${String(run.status)}: ${run.stderr.trim().slice(0, 300)}` : validAnswer(harness, run.stdout) ? undefined : `${label} (${route}): not a valid answer: ${run.stdout.trim().slice(0, 200)}`
      const exeProblem = problem(exe, 'native client')
      if (exeProblem !== undefined) failures.push(exeProblem)
      else if (!markerBefore && guardWroteNotice(parsed.marker)) failures.push(`${label}: nothing could run, so the command fell through to the safe answer`)

      const marker = path.join(scratch, `marker-${String(tested)}`)
      const unresolvable = path.join(scratch, 'no-such-dir', path.basename(parsed.native[0]!))
      const viaNode = buildGuardedCommand({ shell: parsed.shell, native: [unresolvable, ...parsed.native.slice(1)], safe: parsed.safe, marker })
      if (wrappedNodeArgv(parsed.native).length === 0) {
        skipped.push(`${label}: no Node route registered`)
        continue
      }
      const node = runner(parsed.shell, viaNode, input)
      if (node === null) continue
      const nodeProblem = problem(node, 'Node route')
      if (nodeProblem !== undefined) failures.push(nodeProblem)
      else if (fs.existsSync(marker)) failures.push(`${label} (Node route): the Node shim could not run, so the command fell through to the safe answer`)
      tested++
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return { failures, tested, skipped }
}

/** Throw a {@link HookSelftestError} naming every failure when `commands` do not pass the self-test; `where` names the config the caller keeps as it was. */
export function assertRegisteredCommandsWork(commands: readonly string[], where: string): SelftestOutcome {
  const outcome = selftestRegisteredCommands(commands)
  if (outcome.failures.length > 0) {
    throw new HookSelftestError(`the hook commands written to ${where} failed their self-test, so the previous registration was kept: ${outcome.failures.join('; ')}`)
  }
  return outcome
}

/** The guarded commands a config file's text holds: every string literal that starts like a guard. */
export function guardedCommandsInText(raw: string): string[] {
  return stringLiterals(raw).filter((lit) => guardVersionOf(lit) !== undefined)
}

/** A file's bytes, undefined when it is absent, and null when it exists but cannot be read as a file (a directory, no permission): the caller's own error for that case must still be the one raised. */
function snapshot(file: string): Buffer | undefined | null {
  if (!fs.existsSync(file)) return undefined
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/** Run `write`, which writes `files`, then self-test every guarded command they now hold; on a failure put every file back as it was (or absent) and rethrow. A file that cannot be read leaves `write` unverified: it raises its own error. */
export function verifiedInstall<T>(files: readonly string[], write: () => T): T {
  const before = files.map(snapshot)
  if (before.includes(null)) return write()
  const result = write()
  const after = files.map(snapshot)
  if (files.every((_f, i) => before[i] !== undefined && after[i] !== undefined && after[i] !== null && before[i]!.equals(after[i]!))) return result
  const commands = after.flatMap((buf) => (buf === undefined || buf === null ? [] : guardedCommandsInText(buf.toString('utf8'))))
  try {
    assertRegisteredCommandsWork(commands, files.join(', '))
  } catch (e) {
    files.forEach((f, i) => {
      if (before[i] !== undefined && before[i] !== null) fs.writeFileSync(f, before[i]!)
      else fs.rmSync(f, { force: true })
    })
    throw e
  }
  return result
}
