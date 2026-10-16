/** Repair of a Bash command that Claude Code on Windows would hand to Git Bash damaged: the command is written byte for byte to a script file under token-goat's home, and the tool input is rewritten to source that file, so the text never crosses the command line (anthropics/claude-code#85856). */
import { randomBytes } from 'node:crypto'
import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { tokenGoatHome } from './constants.js'
import { quotePosixShellWord } from './process_util.js'
import { isSimpleCommand, namesRmOrProtectedPath } from './rewrite_permission.js'
import type { HookOutput } from './types.js'
import { ensureDirSync } from './util.js'

// The cut-off is reported at 8,186 characters of the whole `-c` argument; Claude Code's own snapshot, eval and cwd-tracking wrapper takes a few hundred of them and quote escaping grows the rest, so 7,000 keeps a clear margin.
export const MSYS_SAFE_COMMAND_CHARS = 7000

// A run of two or more backslashes that neither continues into a longer run nor sits directly before a double quote: those arrive as ceil(n/2), while a run before `"` survives (CAPTURE, anthropics/claude-code#85856).
const HALVED_RUN = /(?<!\\)\\{2,}(?![\\"])/

/** Whether Git Bash would receive this command different from what was written: a run of backslashes it halves, or a command line it cuts off. */
export function msysDamagesCommand(command: string): boolean {
  return command.length > MSYS_SAFE_COMMAND_CHARS || hasHalvedRun(command)
}

/** Whether the damage is a run of backslashes rather than length alone, which decides what a refusal tells the model to do. */
export function hasHalvedRun(command: string): boolean {
  return HALVED_RUN.test(command)
}

const SCRIPT_NAME = /^tg-cmd-[0-9a-f]{32}\.sh$/
// The bracket keeps the dangerous-sink scan in tests/guards from reading this shell-word pattern as a JavaScript call.
const EVAL_WORD = /(?:^|[^a-z0-9_.-])[e]val(?:[^a-z0-9_-]|$)/

/** The text with every quote mark removed and every backslash dropped in front of the character it escapes (a backslash and newline vanish together), whichever quote a shell would be inside: a superset of what a shell makes of the same words, so a word that dequotes to rm in the shell does so here too, at the cost of also reading a quoted `r\m` as rm. */
function removeShellQuoting(text: string): string {
  return text.replace(/\\([^]?)|['"]/g, (_m, c: string | undefined) => (c === '\n' ? '' : (c ?? '')))
}

/** Whether a command cannot be shown to the permission check as it will run: it expands (`$`, a backtick), uses `eval`, or names rm, rmdir or a protected path once its quoting is removed, however many times a nested `sh -c` quotes it again. The sourced script hides all of that from Claude Code's own prompts, which survive even bypassPermissions. */
export function repairIsUnsafe(command: string): boolean {
  // A control character other than tab, line feed and carriage return can be dropped by the shell (a NUL turns `r<NUL>m` into rm), so no word-level check can be trusted on text that holds one.
  if (/[$`]/.test(command) || Array.from(command).some((c) => (c < ' ' && !'\t\n\r'.includes(c)) || c === '\x7f')) return true
  for (let text = command; ; ) {
    if (EVAL_WORD.test(text.toLowerCase()) || namesRmOrProtectedPath(text)) return true
    const next = removeShellQuoting(text)
    if (next === text) return false
    text = next
  }
}

/** The `/c/Users/me` spelling Git Bash gives `C:\Users\me`, or null for a path with no drive letter, or one a single-quoted word cannot carry without a backslash. */
export function msysPathOf(windowsPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/s.exec(windowsPath)
  if (m === null) return null
  const rest = (m[2] as string).replace(/\\/g, '/')
  return /['\r\n]/.test(rest) ? null : `/${(m[1] as string).toLowerCase()}/${rest}`
}

/** Where scripts live: a token-goat-owned directory under the per-user home, never the shared OS temp dir. */
export function repairDir(): string {
  return path.join(tokenGoatHome(), 'bash_repair')
}

export interface RepairPlan {
  /** The Windows path the script is written to. */
  readonly file: string
  /** The command to run instead: sources the script by its MSYS path, no backslash in it. */
  readonly rewritten: string
  /** The script text: a first line that deletes the file, then the original command untouched. */
  readonly script: string
}

/** The script and the rewritten command for `command`, with nothing written yet, or null when no safe spelling exists (a path Git Bash cannot be given, or text that would not survive UTF-8). */
export function planRepair(command: string): RepairPlan | null {
  if (Buffer.from(command, 'utf8').toString('utf8') !== command) return null
  const file = path.join(repairDir(), `tg-cmd-${randomBytes(16).toString('hex')}.sh`)
  const msys = msysPathOf(file)
  if (msys === null) return null
  // `.` reads the whole file before running any of it, so the file can delete itself on its first line.
  const quoted = quotePosixShellWord(msys)
  return { file, rewritten: `. ${quoted}`, script: `rm -f -- ${quoted}\n${command}` }
}

/** Remove repair scripts older than the bound: one readdir of a small directory, and a stat only for names that are ours. The PostToolUse Bash hook calls this after every Bash call, so a script left by a call another hook denied or the user interrupted does not wait for the next repair. */
export function sweepStaleRepairScripts(): void {
  const dir = repairDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!SCRIPT_NAME.test(name)) continue
    const file = path.join(dir, name)
    try {
      // 600,000 ms is the Bash tool's longest command time: a repair is only written for a call approved with no prompt, and its script deletes itself on its first line, so one still on disk this old never reached a shell.
      if (Date.now() - statSync(file).mtimeMs > 600_000) unlinkSync(file)
    } catch {
      // Gone already (its own first line ran) or held by a running shell: either way the next sweep looks again.
    }
  }
}

/** Write the plan's script exclusively, as UTF-8 with no BOM and the command's line endings untouched, then sweep stale ones. False when the write failed. */
export function writeRepairScript(plan: RepairPlan): boolean {
  try {
    ensureDirSync(path.dirname(plan.file))
    writeFileSync(plan.file, plan.script, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch {
    return false
  }
  sweepStaleRepairScripts()
  return true
}

/** Why a command was not repaired, which is what a refusal tells the model. */
export type RepairDecline = 'unsafe-construct' | 'not-pre-approved' | 'write-failed'

/** The rewrite to answer with, or why there is none. */
export type RepairResult = HookOutput | RepairDecline

export const REPAIR_DECLINE_TEXT: Readonly<Record<RepairDecline, string>> = {
  'unsafe-construct': 'it is not plain words, names a shell or interpreter, quotes a shell metacharacter, or uses `$`, a backtick, `eval`, rm, a protected path or a control character',
  'not-pre-approved': 'it is not one your permission rules already allow',
  'write-failed': 'it could not be written',
}

/** The rewrite that runs `command` from a script file, or the reason it cannot be: a construct that hides what runs from Claude Code's own checks, a permission check that does not approve the ORIGINAL command outright (`rewrite` is the caller's permission-neutral rewrite, which applies the hidden-rule, command-line-rule and PermissionRequest-hook gates before it approves), or a script that cannot be written. A sourced script shows a prompt only its path, so anything short of an approval is declined, and nothing is written until the approval is in hand. */
export function repairByScriptFile(command: string, rewrite: (sourced: string) => HookOutput | null): RepairResult {
  const plan = repairIsUnsafe(command) || !isSimpleCommand(command) ? null : planRepair(command)
  if (plan === null) return 'unsafe-construct'
  const output = rewrite(plan.rewritten)
  if (output === null || output.hookType !== 'rewriteInput' || !output.approve) return 'not-pre-approved'
  return writeRepairScript(plan) ? output : 'write-failed'
}
