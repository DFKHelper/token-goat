/** Diagnostic, inspection, packaging, and budgeting command handlers. Implements token-goat coverage-report-gaps, conflicts, screenshot, pack, tokens, budget, and failures. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { CliError, formatCommandError, out, err, requireInt, requirePositiveInt, requireNonNegativeInt } from './cli.js'
import { displaySafeJson, displaySafePath, displaySafeText } from './paths.js'
import { runScreenshot } from './read_commands.js'
import { runCoverageReportGaps } from './read_inspect.js'
import { runConflicts } from './read_git.js'
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
import { sourceLines } from './source_lines.js'
import { DEFAULT_FAILURES_STATE_KEY, loadFailureSnapshot, saveFailureSnapshot } from './failures_state.js'
import { DEFAULT_TIMEOUT_SECONDS, run } from './bash_runner.js'
import { redactSecrets } from './secret_redact.js'
import { quoteCmdWord, quotePosixShellWord } from './process_util.js'
import { wrappedShell } from './shell.js'
import { assertReadAllowed } from './read_deny.js'

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

/** Expand a list of literal paths and/or glob patterns relative to `root`. Patterns that don't contain glob metacharacters (*, ?, {) are kept as-is. Absolute paths are preserved; relative matches are resolved to absolute paths. `globFnOverride` exists only for unit tests that need to exercise glob branching (e.g. the large-match-set path below) without writing real files to disk; production callers never pass it, so the real `fs.globSync` is always used. */
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
        // Plain loop instead of out.push(...array): spreading a large glob match set (e.g. `**/*` on a big project) as call arguments blows the engine's call-stack limit well within realistic file counts (RangeError: Maximum call stack size exceeded), which this function's own try/catch then silently swallows as "not a valid glob, fall through to literal path" -- turning a huge, legitimate match set into zero matched files instead of throwing or reporting the real count.
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
  const patterns = sourceLines(raw)
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
      err(formatCommandError(`pack: token count ${result.total_tokens} exceeds budget ${budgetN}`))
      process.exitCode = 3
      return
    }
  }
  if (opts.scanSecrets === true) {
    const hits = scanSecrets(result.files)
    if (hits.length > 0) {
      for (const hit of hits) {
        // rel_path is a repository path. kind is a SECRET_PATTERNS key, so escaping it is a no-op today: it is escaped anyway so that making that table configurable later cannot reopen this line.
        err(formatCommandError(`secret in ${displaySafePath(hit.rel_path)}:${hit.line}: ${displaySafeText(hit.kind)}`))
      }
      process.exitCode = 2
      return
    }
  }
  let instruction: string | undefined
  if (opts.instructionFile !== undefined) {
    assertReadAllowed(opts.instructionFile)
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
    // `total_tokens`/`total_lines` have always described the whole matched set, not the rows in `entries`. That is fine on a complete result and actively misleading on a capped one: three entries printed beside a total spanning hundreds of files reads as three files that sum to it. The added fields say which of the two the reader is looking at.
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
  // Reduce instead of Math.max(...array): spreading a large project's file list as call arguments blows the engine's call-stack limit (RangeError) well within realistic file counts -- mirrors the same fix in pack.ts's formatBudgetText.
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
    // Falls back to the configured context.model_window_tokens (in thousands, matching --context's own units) so the % line shows up without requiring --context on every call.
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
  if (src !== undefined) assertReadAllowed(src)
  const text = src !== undefined ? fs.readFileSync(src, 'utf8') : fs.readFileSync(0, 'utf8')
  const result = extractFailures(text, opts.runner !== undefined ? { runner: opts.runner } : {})

  if (opts.delta !== true) {
    out(opts.json === true ? formatFailuresJson(result) : formatFailuresText(result))
    return
  }

  // --delta needs a project identity to scope the persisted baseline to (see failures_state.ts's module doc for why project hash + an explicit --key, not a (sessionId, bash_id) pair, is the right key here).
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

/** Exit status for every outcome that is not a pass: a failing, timed-out, killed or unstartable command. */
export const GATE_FAIL_EXIT = 2

/** Lines of wrapped output printed when no test-runner failure format parses. */
export const GATE_TAIL_LINES = 20

/** Named filter that leaves the output unchanged, so the failure parser reads what the command printed. */
const GATE_FILTER = 'passthrough'

export interface GateOptions {
  /** Wall-clock limit for the wrapped command, in seconds; the runner kills the whole tree on expiry. */
  timeout?: number
}

/** An argument the shell `gate` would run under cannot carry whole; the message is the one line printed. */
export class GateArgumentRefused extends Error {}

/** Words needing no quoting under cmd.exe: no `%`, `=`, `,` or `;`, which it expands or reads as separators. */
const CMD_PLAIN_WORD = /^[A-Za-z0-9_@+:./\\-]+$/

/** Quotes for `shell`: one word as a shell line, several as argv. Throws GateArgumentRefused for cmd.exe. */
export function gateCommandLine(
  words: readonly string[],
  shell: string | boolean = wrappedShell(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (words.length <= 1) return words[0] ?? ''
  if (platform === 'win32' && shell === true) {
    return words.map((w) => {
      if (CMD_PLAIN_WORD.test(w)) return w
      const quoted = quoteCmdWord(w, env)
      if (quoted === null)
        throw new GateArgumentRefused(
          'gate: no Git Bash was found, and cmd.exe cannot pass an argument with a defined %NAME%, a line ' +
          'break or a stray ' +
          'metacharacter whole; install Git for Windows or give one quoted command line',
        )
      return quoted
    }).join(' ')
  }
  let prefix = true
  return words.map((w) => {
    const assignment = prefix ? POSIX_ASSIGNMENT.exec(w) : null
    if (assignment === null) prefix = false
    return assignment === null ? quotePosixWord(w) : `${assignment[1]}=${quotePosixWord(assignment[2] ?? '')}`
  }).join(' ')
}

/** A leading `NAME=value` word: NAME a shell identifier, so the shell reads an environment assignment. */
const POSIX_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

/** One word as the POSIX shell reads it: bare when plain, else wrapped whole in single quotes. */
function quotePosixWord(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : quotePosixShellWord(w)
}

/** Run argv words after `gate --`: exit 2 with one line, running nothing, when the shell cannot carry them. */
export async function runGateArgv(
  words: readonly string[],
  shell: string | boolean = wrappedShell(),
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  let line: string
  try {
    line = gateCommandLine(words, shell, platform)
  } catch (e) {
    if (!(e instanceof GateArgumentRefused)) throw e
    process.stderr.write(`${displaySafeText(e.message)}\n`)
    return GATE_FAIL_EXIT
  }
  return runGate(line)
}

/** Run `command` and return the gate verdict: 0 when it exits 0, GATE_FAIL_EXIT for any other outcome. */
export async function runGate(command: string, options: GateOptions = {}): Promise<number> {
  if (command.trim() === '') {
    process.stderr.write('usage: token-goat gate -- <command>\n')
    return GATE_FAIL_EXIT
  }
  const captured: string[] = []
  const capture = (chunk: string): void => {
    captured.push(chunk)
  }
  let code: number
  try {
    code = await run(command, {
      filterName: GATE_FILTER,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      writeStdout: capture,
      writeStderr: capture,
      endTreeAfterExit: true,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    process.stderr.write(`gate: could not run the command (${displaySafeText(redactSecrets(message).text)})\n`)
    return GATE_FAIL_EXIT
  }
  if (code === 0) return 0
  // One redaction feeds both the failing test name and the output tail.
  process.stderr.write(failureReport(code, redactSecrets(captured.join('')).text))
  return GATE_FAIL_EXIT
}

/** Stderr lines for a failed run: the first failing test if the output parses, else exit code and tail. */
function failureReport(code: number, output: string): string {
  const [first] = extractFailures(output).blocks
  if (first !== undefined) {
    return `gate: failed (exit ${code}); first failing test: ${displaySafeText(first.name)}\n`
  }
  const tail = output.trimEnd().split('\n').slice(-GATE_TAIL_LINES)
  return `gate: failed (exit ${code}); last ${tail.length} lines of output:\n${tail.join('\n')}\n`
}

/** Read-only: edits no file, runs no program, changes no config, note, memory or index. Unsure: not listed. */
export const READ_ONLY_COMMANDS: readonly string[] = [
  'csv-profile', 'csv-query', 'html-outline', 'html-query', 'json-outline', 'json-query', 'permissions suggest',
  'version', 'xml-outline', 'xml-query', 'yaml-outline', 'yaml-query', 'zip-list', 'zip-read',
]

/** Not read-only: a write, a program run, a network fetch, a config or note change, or an unverified read. */
export const NOT_READ_ONLY_COMMANDS: readonly string[] = [
  'arch', 'baseline', 'bash-history', 'bash-output', 'bridges-status', 'brief', 'budget', 'call-chain',
  'callers', 'capabilities', 'commands', 'compact-hint', 'context-for', 'cost', 'coverage-gaps',
  'coverage-report-gaps', 'dead', 'deps', 'describe', 'docx-outline', 'docx-tables', 'docx-text', 'exports',
  'failures', 'find', 'grep', 'history', 'hot', 'ignores', 'image-diff', 'image-meta', 'impact', 'imports',
  'listing-size', 'locate', 'lockdeps', 'logfold',
  'manifest-sweep', 'map', 'mcp-history', 'mcp-output', 'mcp-status', 'note-get', 'note-list', 'openapi-op',
  'openapi-outline', 'outline', 'peek', 'pdf-meta', 'pdf-outline', 'permissions', 'pptx-notes', 'pptx-outline',
  'pptx-slide', 'pptx-text', 'read', 'recall', 'recent', 'refs', 'resume', 'scope', 'search', 'section',
  'semantic', 'session-outline', 'session-schema', 'session-slice', 'session-summary', 'similar', 'skeleton',
  'skill-body', 'skill-diff', 'skill-history', 'skill-list', 'skill-section', 'stats', 'statusline', 'symbol',
  'test-for', 'todo', 'trace', 'transcript', 'transcript-outline', 'types', 'web-history', 'web-output',
  'xlsx-columns', 'xlsx-head',
  'xlsx-query', 'xlsx-range', 'xlsx-sheets', 'tokens',
  'affected', 'answer', 'ask', 'audit', 'blame', 'bench', 'bootstrap-audit', 'cache-audit', 'changed',
  'clean-cache', 'compact-doc', 'compress', 'compress-text', 'config', 'context-stats', 'diff',
  'dep-docs', 'doctor',
  'fetch-image', 'gate', 'gdrive-sections', 'handoff-create', 'handoff-resolve', 'hint-stats',
  'hook', 'hook-server', 'image-slice', 'image-text', 'importers', 'index', 'insert-section', 'install', 'log',
  'mcp-audit', 'mcp-serve', 'memory', 'note', 'note-add', 'pack', 'pdf-extract', 'pdf-locate', 'php-lint',
  'pr-slice', 'project', 'prune-cache', 'reclaim-index', 'reconcile', 'replace', 'retrieve', 'screenshot',
  'session-audit', 'sharepoint-resolve', 'skill-compact', 'skill-size', 'sqlite-query', 'sqlite-schema',
  'sqlite-tables', 'uninstall', 'upgrade', 'video-chapters', 'waste', 'worker', 'write-file',
  'conflicts', 'html-lint',
  'worker start', 'worker stop', 'worker status', 'hook-server run', 'hook-server status', 'hook-server stop',
  'config-get',
]

/** Never listed: each writes, runs a program or changes settings, whatever the tables above say. */
export const WRITE_CAPABLE_COMMANDS: readonly string[] = [
  'index', 'install', 'uninstall', 'upgrade', 'doctor', 'gate', 'compress', 'pack', 'memory', 'config',
  'note', 'project', 'write-file', 'replace', 'insert-section', 'clean-cache', 'prune-cache',
  'reclaim-index', 'hook',
]

/** Names among `registered` in neither table: each is a command added without a read-only decision. */
export function unclassifiedCommands(registered: readonly string[]): string[] {
  const known = new Set([...READ_ONLY_COMMANDS, ...NOT_READ_ONLY_COMMANDS])
  return registered.filter((name) => !known.has(name))
}

/** Settings fragment: one space-wildcard Bash allow rule per read-only command. */
export function permissionSuggestionJson(): string {
  const allow = [...READ_ONLY_COMMANDS].sort().map((name) => `Bash(token-goat ${name} *)`)
  return `${JSON.stringify({ permissions: { allow } }, null, 2)}\n`
}
