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

/** Host shell per form: Git Bash or `/bin/sh` (sh), cmd.exe (cmd), PowerShell 5.1 (other); null if absent. */
export const realShellRunner: ShellRunner = (shell, command, input) => {
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
  const r = spawnSync(program, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, [HOOK_PROBE_ENV]: '1' },
    timeout: SELFTEST_TIMEOUT_MS,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    cwd: os.tmpdir(),
    maxBuffer: 8 * 1024 * 1024,
  })
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

/** Host-accepted `stdout`: JSON objects per line (async events send `{"async":true}` first), or empty. */
function validAnswer(harness: string | undefined, event: string, stdout: string, safe: string): boolean {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  // A harness whose own safe answer is empty (Kimi) accepts empty output, a Node-only command included.
  if (lines.length === 0) return harness === 'kimi' || safe === ''
  // Claude Code reads a pre_compact hook's raw stdout as the summarizer's instructions, so plain text is its answer.
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
      const label = `${harness ?? 'hook'} ${event}`
      const markerBefore = fs.existsSync(parsed.marker)
      const exe = runner(parsed.shell, command, input)
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
      else if (!markerBefore && guardWroteNotice(parsed.marker)) {
        failures.push(`${label}: nothing could run, so the command fell through to the safe answer`)
      }

      if (!parsed.native.includes('--')) {
        // A Node-only registration has no client to make unresolvable: the run above is its Node route.
        tested++
        continue
      }
      const marker = path.join(scratch, `marker-${String(tested)}`)
      const unresolvable = path.join(scratch, 'no-such-dir', path.basename(parsed.native[0]!))
      const viaNode = buildGuardedCommand({
        shell: parsed.shell,
        native: [unresolvable, ...parsed.native.slice(1)],
        safe: parsed.safe,
        marker,
      })
      if (wrappedNodeArgv(parsed.native).length === 0) {
        skipped.push(`${label}: no Node route registered`)
        continue
      }
      const node = runner(parsed.shell, viaNode, input)
      if (node === null) continue
      const nodeProblem = problem(node, 'Node route')
      if (nodeProblem !== undefined) failures.push(nodeProblem)
      else if (fs.existsSync(marker)) {
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
    fs.writeFileSync(f, was)
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
      if (before[i] !== undefined && before[i] !== null) fs.writeFileSync(f, before[i]!)
      else fs.rmSync(f, { force: true })
    })
    throw e
  }
  return result
}
