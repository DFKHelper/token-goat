/**
 * Diagnostic, inspection, packaging, and budgeting command handlers.
 *
 * Implements token-goat coverage-report-gaps, conflicts, screenshot,
 * pack, tokens, budget, and failures.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { CliError, out, err, requireInt, requirePositiveInt, requireNonNegativeInt } from './cli.js'
import { displaySafeJson, displaySafePath, displaySafeText } from './paths.js'
import { runCoverageReportGaps, runConflicts, runScreenshot } from './read_commands.js'
import { collectFiles, collectFromStdin, formatPack, scanSecrets, estimateBudget, formatBudgetText } from './pack.js'
import { loadConfig } from './config.js'
import {
  extractFailures,
  formatFailuresJson,
  formatFailuresText,
  failureSignatures,
  computeFailureDelta,
  formatFailureDeltaJson,
  formatFailureDeltaText,
} from './failures.js'
import { findProject } from './project.js'
import { DEFAULT_FAILURES_STATE_KEY, loadFailureSnapshot, saveFailureSnapshot } from './failures_state.js'

export function cmdCoverageReportGaps(file: string, opts: { file?: string; json?: boolean }): void {
  process.exitCode = runCoverageReportGaps({
    file,
    ...(opts.file !== undefined ? { fileFilter: opts.file } : {}),
    ...(opts.json === true ? { json: true } : {}),
  })
}

export function cmdConflicts(targetPath: string | undefined, opts: { json?: boolean; summary?: boolean; context?: string }): void {
  process.exitCode = runConflicts({
    ...(targetPath !== undefined ? { path: targetPath } : {}),
    ...(opts.json === true ? { json: true } : {}),
    ...(opts.summary === true ? { summary: true } : {}),
    ...(opts.context !== undefined ? { context: parseInt(opts.context, 10) } : {}),
  })
}

export async function cmdScreenshot(
  url: string,
  destPath: string,
  opts: { executablePath?: string; width?: string; height?: string; fullPage?: boolean },
): Promise<void> {
  out(await runScreenshot(url, destPath, opts))
}

/**
 * Expand a list of literal paths and/or glob patterns relative to `root`.
 * Patterns that don't contain glob metacharacters (*, ?, {) are kept as-is.
 * Absolute paths are preserved; relative matches are resolved to absolute paths.
 *
 * `globFnOverride` exists only for unit tests that need to exercise glob branching (e.g. the
 * large-match-set path below) without writing real files to disk; production callers never
 * pass it, so the real `fs.globSync` is always used.
 */
export function expandGlobs(
  root: string,
  patterns: string[],
  globFnOverride?: (pattern: string, opts: { cwd: string }) => string[],
): string[] {
  const out: string[] = []
  const globFn =
    globFnOverride ??
    ((fs as unknown as Record<string, unknown>)['globSync'] as
      | ((pattern: string, opts: { cwd: string }) => string[])
      | undefined)
  for (const p of patterns) {
    if (globFn !== undefined && (p.includes('*') || p.includes('?') || p.includes('{'))) {
      try {
        const hits = globFn(p, { cwd: root })
        // Plain loop instead of out.push(...array): spreading a large glob match set (e.g.
        // `**/*` on a big project) as call arguments blows the engine's call-stack limit well
        // within realistic file counts (RangeError: Maximum call stack size exceeded), which
        // this function's own try/catch then silently swallows as "not a valid glob, fall
        // through to literal path" -- turning a huge, legitimate match set into zero matched
        // files instead of throwing or reporting the real count.
        for (const h of hits) out.push(path.isAbsolute(h) ? h : path.join(root, h))
        continue
      } catch {
        // fall through to literal path
      }
    }
    out.push(path.isAbsolute(p) ? p : path.join(root, p))
  }
  return out
}

/** Reads .tokengoatignore from the project root and returns its non-blank, non-comment lines as glob patterns. Returns undefined if the file doesn't exist. */
export function readIgnoreFile(root: string): string[] | undefined {
  const ignorePath = path.join(root, '.tokengoatignore')
  let raw: string
  try {
    raw = fs.readFileSync(ignorePath, 'utf8')
  } catch {
    return undefined
  }
  const patterns = raw
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => ln.length > 0 && !ln.startsWith('#'))
  return patterns.length > 0 ? patterns : undefined
}

export function cmdPack(
  patterns: string[] | undefined,
  opts: {
    format?: string
    lineNumbers?: boolean
    instructionFile?: string
    output?: string
    ignore?: boolean
    stripComments?: boolean
    scanSecrets?: boolean
    budget?: string
  },
): void {
  const root = process.cwd()
  const style = opts.format === 'xml' ? 'xml' : opts.format === 'text' ? 'plain' : 'markdown'
  const ignorePatterns = opts.ignore !== false ? readIgnoreFile(root) : undefined
  const collectOpts = {
    ...(opts.stripComments === true ? { do_strip_comments: true as const } : {}),
    ...(ignorePatterns !== undefined ? { ignore_patterns: ignorePatterns } : {}),
  }
  const patternList = patterns ?? []
  const expandedList = patternList.length > 0 ? expandGlobs(root, patternList) : []
  if (patternList.length > 0 && expandedList.length === 0) {
    throw new CliError(`no files matched: ${patternList.join(' ')}`)
  }
  const result =
    expandedList.length > 0
      ? collectFiles(root, expandedList, collectOpts)
      : collectFromStdin(root, collectOpts)
  if (opts.budget !== undefined) {
    const budgetN = requireInt('--budget', opts.budget)
    if (result.total_tokens > budgetN) {
      err(`token-goat: pack: token count ${result.total_tokens} exceeds budget ${budgetN}`)
      process.exitCode = 3
      return
    }
  }
  if (opts.scanSecrets === true) {
    const hits = scanSecrets(result.files)
    if (hits.length > 0) {
      for (const hit of hits) {
        // rel_path is a repository path. kind is a SECRET_PATTERNS key, so escaping it is a no-op today: it is escaped anyway so that making that table configurable later cannot reopen this line.
        err(`token-goat: secret in ${displaySafePath(hit.rel_path)}:${hit.line}: ${displaySafeText(hit.kind)}`)
      }
      process.exitCode = 2
      return
    }
  }
  let instruction: string | undefined
  if (opts.instructionFile !== undefined) {
    instruction = fs.readFileSync(opts.instructionFile, 'utf8')
  }
  const formatted = formatPack(result, style, {
    ...(opts.lineNumbers === true ? { line_numbers: true } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
  })
  if (opts.output !== undefined) {
    fs.writeFileSync(opts.output, formatted, 'utf8')
  } else {
    out(formatted)
  }
}

export function cmdTokens(
  patterns: string[] | undefined,
  opts: { tree?: boolean; top?: string; asc?: boolean; json?: boolean },
): void {
  const root = process.cwd()
  const result = estimateBudget(root, expandGlobs(root, patterns ?? []))
  let entries = [...result.entries]
  if (opts.asc === true) entries.reverse()
  const eligibleCount = entries.length
  if (opts.top !== undefined) entries = entries.slice(0, requireNonNegativeInt('--top', opts.top))
  const truncated = entries.length < eligibleCount
  if (opts.json === true) {
    // `total_tokens`/`total_lines` have always described the whole matched set, not the rows in
    // `entries`. That is fine on a complete result and actively misleading on a capped one: three
    // entries printed beside a total spanning hundreds of files reads as three files that sum to
    // it. The added fields say which of the two the reader is looking at.
    out(displaySafeJson({ entries, truncated, totalCount: eligibleCount, total_tokens: result.total_tokens, total_lines: result.total_lines }))
    return
  }
  if (opts.tree === true) {
    const dirs = new Map<string, typeof entries>()
    for (const e of entries) {
      const dir = path.dirname(e.rel_path)
      if (!dirs.has(dir)) dirs.set(dir, [])
      dirs.get(dir)!.push(e)
    }
    const lines: string[] = []
    for (const [dir, dirEntries] of dirs) {
      const dirTokens = dirEntries.reduce((s, e) => s + e.tokens, 0)
      const pct = result.total_tokens > 0 ? Math.round((dirTokens / result.total_tokens) * 100) : 0
      lines.push(`${dir}/ (${dirTokens} tokens, ${pct}%)`)
      for (const e of dirEntries) {
        lines.push(`  ${path.basename(e.rel_path).padEnd(30)}  ${String(e.tokens).padStart(8)} tokens`)
      }
    }
    out(lines.join('\n'))
    return
  }
  if (entries.length === 0) {
    out('No files matched.')
    return
  }
  // Reduce instead of Math.max(...array): spreading a large project's file list as call
  // arguments blows the engine's call-stack limit (RangeError) well within realistic file
  // counts -- mirrors the same fix in pack.ts's formatBudgetText.
  const colW = entries.reduce((max, e) => Math.max(max, e.rel_path.length), 4)
  const lines = [
    `${'File'.padEnd(colW)}  ${'~Tokens'.padStart(8)}  ${'Lines'.padStart(6)}`,
    `${'-'.repeat(colW)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`,
  ]
  for (const e of entries) {
    lines.push(`${e.rel_path.padEnd(colW)}  ${String(e.tokens).padStart(8)}  ${String(e.lines).padStart(6)}`)
  }
  if (truncated) {
    lines.push(`...and ${eligibleCount - entries.length} more (raise --top to see them).`)
  }
  out(lines.join('\n'))
}

export function cmdBudget(
  patterns: string[],
  opts: { context?: string; json?: boolean },
): void {
  const root = process.cwd()
  const result = estimateBudget(root, expandGlobs(root, patterns))
  if (opts.json === true) {
    out(displaySafeJson(result))
  } else {
    // Falls back to the configured context.model_window_tokens (in thousands, matching
    // --context's own units) so the % line shows up without requiring --context on every call.
    const contextK = opts.context !== undefined
      ? requirePositiveInt('--context', opts.context)
      : Math.round(loadConfig().context.model_window_tokens / 1000)
    out(formatBudgetText(result, contextK))
  }
}

export function cmdFailures(
  src: string | undefined,
  opts: { runner?: string; json?: boolean; delta?: boolean; key?: string },
): void {
  const text = src !== undefined ? fs.readFileSync(src, 'utf8') : fs.readFileSync(0, 'utf8')
  const result = extractFailures(text, opts.runner !== undefined ? { runner: opts.runner } : {})

  if (opts.delta !== true) {
    out(opts.json === true ? formatFailuresJson(result) : formatFailuresText(result))
    return
  }

  // --delta needs a project identity to scope the persisted baseline to (see
  // failures_state.ts's module doc for why project hash + an explicit --key, not a
  // (sessionId, bash_id) pair, is the right key here).
  const project = findProject(process.cwd())
  if (project === null) {
    throw new Error('token-goat failures --delta requires a project root (git repo, package.json, etc.) from cwd to scope the saved baseline')
  }
  const key = opts.key ?? DEFAULT_FAILURES_STATE_KEY
  const signatures = failureSignatures(result)
  const prior = loadFailureSnapshot(project.hash, key)
  const delta = computeFailureDelta(prior?.signatures ?? null, signatures)
  saveFailureSnapshot(project.hash, key, { signatures, runner: result.runner, storedAt: Date.now() })
  out(opts.json === true ? formatFailureDeltaJson(delta, result.runner) : formatFailureDeltaText(delta, result.runner))
}
