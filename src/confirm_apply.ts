/**
 * Small, reusable diff-preview + confirm-before-write helper.
 *
 * Shared shape for any command that proposes whole-file rewrites and needs to
 * show the user exactly what will change before writing: print a
 * unified-diff-style preview (reusing {@link buildLineDiff}), then either
 * apply unconditionally (`opts.yes`), prompt per-file on a TTY, or -- when
 * neither applies (non-interactive, no `--yes`) -- refuse to write and print
 * the diffs as a dry run explaining how to apply.
 *
 * Deliberately minimal: no patch/merge logic, no generic diff library. Just
 * enough to preview + gate a whole-file overwrite. First consumer is
 * `token-goat memory --fix`; written as a standalone module because the
 * advisory CLAUDE.md/memory-migration probe work will need the same
 * preview-then-confirm shape later.
 */

import * as readline from 'node:readline'

import { buildLineDiff } from './hooks_read.js'
import { atomicWriteText } from './util.js'

/** One proposed whole-file rewrite. */
export interface FileChange {
  path: string
  before: string
  after: string
  /** Human label shown in the diff header; defaults to `path`. */
  label?: string
}

export interface ConfirmAndApplyOptions {
  /** Apply every change without prompting (non-interactive / scripted use). */
  yes?: boolean
  /** Override TTY detection (for tests). Defaults to `process.stdin.isTTY === true`. */
  isTTY?: boolean
  /** Injectable y/n prompt (for tests). Defaults to a readline-based stdin prompt. */
  confirm?: (question: string) => Promise<boolean>
  /** Sink for preview/status text. Defaults to `process.stdout.write`. */
  write?: (text: string) => void
}

export interface ConfirmAndApplyResult {
  applied: FileChange[]
  skipped: FileChange[]
  /** True when nothing was written because stdin was not a TTY and `--yes` was absent. */
  dryRun: boolean
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer: string = await new Promise((resolve) => rl.question(question, resolve))
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Preview `changes` as unified diffs, then apply per confirmation rules:
 *
 * - `opts.yes === true`: apply every change, no prompting.
 * - No `--yes` and stdin is a TTY: prompt y/n per file; only confirmed files are written.
 * - No `--yes` and stdin is not a TTY: print diffs only, apply nothing (dry run).
 *
 * Never writes a file that wasn't included in `changes`, and never writes
 * content other than the exact `after` shown in that file's diff.
 */
export async function confirmAndApply(
  changes: FileChange[],
  opts: ConfirmAndApplyOptions = {},
): Promise<ConfirmAndApplyResult> {
  const write = opts.write ?? ((text: string) => { process.stdout.write(text) })
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true
  const confirmFn = opts.confirm ?? defaultConfirm
  const dryRun = opts.yes !== true && !isTTY

  const applied: FileChange[] = []
  const skipped: FileChange[] = []

  for (const change of changes) {
    const label = change.label ?? change.path
    const diff = buildLineDiff(change.before, change.after, label)
    write(`\n${diff}\n`)

    if (opts.yes === true) {
      atomicWriteText(change.path, change.after)
      applied.push(change)
      continue
    }

    if (!isTTY) {
      skipped.push(change)
      continue
    }

    const ok = await confirmFn(`Apply this change to ${label}? [y/N] `)
    if (ok) {
      atomicWriteText(change.path, change.after)
      applied.push(change)
    } else {
      skipped.push(change)
    }
  }

  if (dryRun) {
    write(
      '\nDry run: no files were written (stdin is not a TTY and --yes was not passed).\n' +
        'Re-run with --yes to apply these changes non-interactively.\n',
    )
  }

  return { applied, skipped, dryRun }
}
