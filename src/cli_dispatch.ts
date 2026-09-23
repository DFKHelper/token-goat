/**
 * Shared CLI execution and dispatch helpers.
 */

import * as fs from 'node:fs'
import { displaySafeText } from './paths.js'
import { extractErrorMessage } from './util.js'
import { extraFileArgsNote } from './read_commands.js'
import { out, err, CliError } from './cli.js'

export function readStdinPaths(): string[] {
  if (process.stdin.isTTY) {
    throw new CliError('--stdin requires piped input, e.g. `git diff --name-only | token-goat affected --stdin`')
  }
  let raw: string
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch (e) {
    throw new CliError(`could not read the file list from stdin: ${extractErrorMessage(e)}`)
  }
  return raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export function runExit(fn: () => number): void {
  try {
    process.exitCode = fn()
  } catch (e) {
    err(`token-goat: ${displaySafeText(extractErrorMessage(e))}`)
    process.exitCode = 1
  }
}

/**
 * Same adapter as `runExit`, but for the `run*` handlers that return `{ text, code }`
 * instead of printing directly. Writes `text` to stdout on success (code 0) or stderr
 * otherwise, then maps `code` onto `process.exitCode` — preserving which stream each
 * handler's message goes to (these handlers only ever write to one stream per call).
 */
export function runExitText(fn: () => { text: string; code: number }): void {
  try {
    const { text, code } = fn()
    ;(code === 0 ? out : err)(text)
    process.exitCode = code
  } catch (e) {
    err(`token-goat: ${displaySafeText(extractErrorMessage(e))}`)
    process.exitCode = 1
  }
}

export type ExtraArgsNoteOpts = { noun?: 'file' | 'spec'; mergeable?: boolean }

export function noteExtraFileArgs(
  command: string,
  first: string,
  extras: string[] | undefined,
  fn: () => { text: string; code: number },
  opts: ExtraArgsNoteOpts = {},
): { text: string; code: number } {
  const result = fn()
  if (extras === undefined || extras.length === 0) return result
  return { text: `${extraFileArgsNote(command, first, extras, opts)}\n${result.text}`, code: result.code }
}

export function emitExtraFileArgsNote(command: string, first: string, extras: string[] | undefined, opts: ExtraArgsNoteOpts = {}): void {
  if (extras === undefined || extras.length === 0) return
  out(extraFileArgsNote(command, first, extras, opts))
}

// Parses a --limit/--top style numeric CLI flag, rejecting a non-numeric value with a clean CliError instead of letting NaN flow into a downstream SQL LIMIT bind (which SQLite rejects with an opaque "datatype mismatch" error). These three live here rather than in cli.ts because cli.ts already imports from this module: callers reach them either directly or through cli.ts's re-export, and a single definition means a fix to the parse cannot land on one import path and miss the other.
export function requireInt(flag: string, raw: string): number {
  // Only accept exact integer literals (optional leading minus, followed by digits)
  if (!/^-?\d+$/.test(raw)) {
    throw new CliError(`${flag} must be a number, got: "${raw}"`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new CliError(`${flag} must be a number, got: "${raw}"`)
  }
  return n
}

// Same numeric parse as requireInt, plus a sign check. Every current --limit/--top flag feeds either a SQL `LIMIT ?` bind or a `.slice(0, n)` row cap, and a negative value breaks both in the opposite direction from what the flag promises: SQLite treats a negative LIMIT as "no limit" (LIMIT -1 returns every row instead of none), and `.slice(0, -1)` silently reinterprets as "everything except the last element" per JS's slice-from-the-end semantics. Zero is fine (both SQL and slice() correctly return nothing for 0), so only strictly-negative is rejected.
export function requireNonNegativeInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n < 0) {
    throw new CliError(`${flag} must be a non-negative number, got: "${raw}"`)
  }
  return n
}

export function requirePositiveInt(flag: string, raw: string): number {
  const n = requireInt(flag, raw)
  if (n <= 0) {
    throw new CliError(`${flag} must be a positive number, got: "${raw}"`)
  }
  return n
}

