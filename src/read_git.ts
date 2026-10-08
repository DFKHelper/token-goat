import * as fs from 'node:fs'
import * as path from 'node:path'

import { formatConflicts, formatConflictSummaries, parseConflicts, summarizeFileConflicts } from './conflict_query.js'
import { querySymbols } from './index_reader.js'
import { displaySafeJson, displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { formatSymbolLocation, isVirtualIndexedPath, virtualIndexedScopeNote } from './indexed_source.js'
import type { SymbolEntry } from './parser_types.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import { emitGuarded, guardJsonRows, guardText, readFileText, recordReadStat, sumFileSizes } from './read_commands.js'
import { emit, emitErr } from './emit.js'
import type { GitResult } from './types.js'
import { resolveProjectConfinement, resolveSymbolSpecOrEmitError } from './read_spec.js'
import { trimBlankLines } from './read_suggest.js'
import { FIND_SCAN_LIMIT } from './query_limits.js'
import {
  compileGrepMatcher,
  countNoun,
  excludeTestsHiddenNote,
  isTestFile,
  runGit,
} from './util.js'
import { grepFilteredToEmptyNotice } from './filter_notice.js'
import { walkProject } from './baseline.js'
import { deliveredOutputBytes } from './delivery_cap.js'
import { formatCommandError, formatGitFailure } from './command_error.js'
import { couldNotRead, echoedValue } from './hint_suggestion_guard.js'

export interface ConflictsCliOptions {
  path?: string
  json?: boolean
  summary?: boolean
  context?: number
}

export function runConflicts(opts: ConflictsCliOptions): number {
  let files: string[]
  if (opts.path === undefined) {
    files = walkProject(process.cwd()).files
  } else {
    const abs = path.resolve(opts.path)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      emitErr(formatCommandError(couldNotRead(opts.path)))
      return 1
    }
    files = stat.isDirectory() ? walkProject(abs).files : [abs]
  }

  const contextLines = opts.context !== undefined ? opts.context : 3
  const results: ReturnType<typeof parseConflicts>[] = []
  for (const f of files) {
    const text = readFileText(f)
    if (text === null) continue
    const parsed = parseConflicts(f, text, contextLines)
    if (parsed.regions.length > 0 || parsed.warnings.length > 0) results.push(parsed)
  }

  const fullSourceBytes = sumFileSizes(files)
  const detail = opts.path ?? '.'
  if (opts.json === true) {
    const jsonText = displaySafeJson(opts.summary === true ? results.map(summarizeFileConflicts) : results, 0)
    emit(jsonText)
    recordReadStat('conflicts', fullSourceBytes, jsonText, detail)
  } else if (opts.summary === true) {
    const text = formatConflictSummaries(results.map(summarizeFileConflicts))
    emitGuarded(text, 'conflicts')
    recordReadStat('conflicts', fullSourceBytes, text, detail)
  } else {
    const text = formatConflicts(results)
    emitGuarded(text, 'conflicts')
    recordReadStat('conflicts', fullSourceBytes, text, detail)
  }
  return 0
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

function hunkHeaderRange(m: RegExpExecArray): { start: number; end: number } {
  const newStart = parseInt(m[1]!, 10)
  const newLines = m[2] !== undefined ? parseInt(m[2], 10) : 1
  return newLines === 0
    ? { start: Math.max(newStart, 1), end: Math.max(newStart, 1) }
    : { start: newStart, end: newStart + newLines - 1 }
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// Decodes the C-style quoting git puts around a path with a quote, backslash, control character or (under core.quotePath) non-ASCII byte: `\"`, `\\`, `\t`, `\n` and so on, plus `\ooo` octal bytes that together form UTF-8.
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = []
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted.charAt(i)
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = quoted.charAt(i + 1)
    const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1, i + 4))
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
    } else if (C_ESCAPES[next] !== undefined) {
      bytes.push(C_ESCAPES[next])
      i += 1
    } else {
      bytes.push(92)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// The new-side path of a `+++ ` header line, or null for a header that is not a b/ path. Git appends a trailing TAB after an unquoted path containing a space, and wraps a path with special characters in double quotes.
function newSidePath(line: string): string | null {
  const quoted = /^\+\+\+ "b\/(.*)"$/.exec(line)
  if (quoted !== null) return unquoteGitPath(quoted[1] ?? '')
  const plain = /^\+\+\+ b\/(.+?)\t?$/.exec(line)
  return plain === null ? null : (plain[1] ?? null)
}

export function parseDiffHunks(diffText: string): Map<string, Array<{ start: number; end: number }>> {
  const hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
  let currentFile: string | null = null
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      currentFile = newSidePath(line)
      continue
    }
    if (line === '+++ /dev/null') {
      currentFile = null
      continue
    }
    const hunkMatch = HUNK_HEADER_RE.exec(line)
    if (hunkMatch !== null && currentFile !== null) {
      const range = hunkHeaderRange(hunkMatch)
      const existing = hunksByFile.get(currentFile)
      if (existing !== undefined) {
        existing.push(range)
      } else {
        hunksByFile.set(currentFile, [range])
      }
    }
  }
  return hunksByFile
}

// New-side paths of files the diff reports as renamed or mode-changed with no content change: their `diff --git` block carries no `+++` header and no hunks, which is not the same as a file git gave no hunks for (an added or unpaired one), so they contribute no changed symbols.
export function parseHunklessFiles(diffText: string): Set<string> {
  const hunkless = new Set<string>()
  let path: string | null = null
  let metadataOnly = false
  let hasContent = false
  const flush = (): void => {
    if (path !== null && metadataOnly && !hasContent) hunkless.add(path)
  }
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush()
      const header = /^diff --git "?a\/.*?"? "?b\/(.*?)"?$/.exec(line)
      path = header === null ? null : line.endsWith('"') ? unquoteGitPath(header[1] ?? '') : (header[1] ?? null)
      metadataOnly = false
      hasContent = false
    } else if (line.startsWith('rename to ')) {
      const to = line.slice('rename to '.length)
      path = to.startsWith('"') && to.endsWith('"') && to.length > 1 ? unquoteGitPath(to.slice(1, -1)) : to
      metadataOnly = true
    } else if (line.startsWith('new mode ')) {
      metadataOnly = true
    } else if (line.startsWith('+++ ') || line.startsWith('Binary files ') || line === 'GIT binary patch') {
      hasContent = true
    }
  }
  flush()
  return hunkless
}

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Bounds the stdin batch of HEAD~n candidates in buildChangedRefHint.
const CHANGED_HINT_BATCH = 512

// `git cat-file --batch-check` answers `<oid> <type> <size>` for an object it found and `<query> missing` or `<query> ambiguous` otherwise.
function batchRowResolved(row: string | undefined): boolean {
  return row !== undefined && /^[0-9a-f]{40,64} /.test(row)
}

// Whether `ref` resolves and the first (deepest) candidate that does, from one `cat-file --batch-check` spawn. A batch git refused or cut short falls back to one `rev-parse --verify` per name, the behaviour before the batch existed, so a git that lacks the batch mode still gets its hint.
function resolveHintRefs(cwd: string, ref: string, candidates: readonly string[]): { refResolves: boolean; suggestedRef: string | null } {
  const batch = runGit(['cat-file', '--batch-check'], { cwd, input: `${[ref, ...candidates].join('\n')}\n` })
  const rows = batch.stdout.split(/\r?\n/)
  if (batch.exitCode === 0 && rows.length >= candidates.length + 1) {
    return { refResolves: batchRowResolved(rows[0]), suggestedRef: candidates.find((_, i) => batchRowResolved(rows[i + 1])) ?? null }
  }
  const resolves = (name: string): boolean => runGit(['rev-parse', '--verify', '--quiet', name], { cwd }).exitCode === 0
  if (resolves(ref)) return { refResolves: true, suggestedRef: null }
  return { refResolves: false, suggestedRef: candidates.find((c) => resolves(c)) ?? null }
}

function buildChangedRefHint(cwd: string, ref: string): string | null {
  const countResult = runGit(['rev-list', '--count', 'HEAD'], { cwd })
  if (countResult.exitCode !== 0) {
    return null
  }
  const commitCount = Number.parseInt(countResult.stdout.trim(), 10)
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    return null
  }
  // A ref with a line break would split into two queries and misalign the answers; git would refuse it as an argument anyway.
  if (/[\r\n]/.test(ref)) {
    return null
  }
  // One spawn answers whether the ref resolves and which HEAD~n is the oldest that does: HEAD~n follows first parents, so on a linear history the deepest candidate resolves first and a merge-heavy one is bounded by the batch, not by a spawn per candidate.
  const candidates: string[] = []
  for (let n = commitCount - 1; n >= 1 && candidates.length < CHANGED_HINT_BATCH; n--) {
    candidates.push(`HEAD~${n}`)
  }
  const answer = resolveHintRefs(cwd, ref, candidates)
  if (answer.refResolves) {
    return null
  }
  let suggestedRef = answer.suggestedRef
  if (suggestedRef === null) {
    suggestedRef = EMPTY_TREE_HASH
  }
  const commitWord = commitCount === 1 ? '1 commit' : `${commitCount} commits`
  return `Hint: this repo has only ${commitWord}; ${echoedValue(ref)} does not exist. Try: token-goat changed --since ${suggestedRef}`
}

function refIsSafe(ref: string): boolean {
  return !ref.startsWith('-')
}

function emitUnsafeRef(ref: string): void {
  emitErr(formatCommandError(`Refusing a git ref that starts with '-': ${ref}`))
}

// The diff `changed` replaces is one shell command, so it is priced like every shell saving: by what the harness would have delivered of it, not by its full size. `git diff --name-only` lists paths relative to the repository top level whatever the cwd, so every git call that takes those names back as pathspecs must run from the top level too (resolveProjectRoot is that top level inside a repository), and must match them literally.
function literalPathspec(file: string): string {
  return `:(literal)${file}`
}

// A pathspec of only a renamed file's new name hides the old path from git, which then diffs the file as wholly added and every symbol in it reads as changed. Adding each rename's old path lets `-M` pair them, so the diff carries only the real edits.
function withRenameSources(cwd: string, ref: string, files: readonly string[]): string[] {
  const wanted = new Set(files)
  const paths = [...files]
  try {
    const result = runGit(['diff', ref, '--name-status', '-M'], { cwd })
    if (result.exitCode !== 0) return paths
    const unquote = (f: string): string => (f.startsWith('"') && f.endsWith('"') && f.length > 1 ? unquoteGitPath(f.slice(1, -1)) : f)
    for (const row of result.stdout.split(/\r?\n/)) {
      const [status, from, to] = row.split('\t')
      if (status?.startsWith('R') !== true || from === undefined || to === undefined) continue
      if (wanted.has(unquote(to))) paths.push(unquote(from))
    }
  } catch {
    // Without the rename sources the diff degrades to the new-name-only view.
  }
  return paths
}

// The zero-context diff of `files`; a wholly-added file in it (`--- /dev/null`) may be a rename whose old path the pathspec hid, so only then are the rename sources looked up and the diff taken again with them.
function unifiedDiffOf(cwd: string, ref: string, files: readonly string[], extraArgs: readonly string[] = []): GitResult {
  const run = (paths: readonly string[]): GitResult => runGit(['diff', ref, '-M', '--unified=0', ...extraArgs, '--', ...paths.map(literalPathspec)], { cwd })
  const first = run(files)
  if (first.exitCode !== 0 || !first.stdout.includes('--- /dev/null')) return first
  const paths = withRenameSources(cwd, ref, files)
  return paths.length > files.length ? run(paths) : first
}

function changedDiffBaselineBytes(cwd: string, ref: string, files: readonly string[]): number {
  if (files.length === 0) return 0
  try {
    const result = unifiedDiffOf(cwd, ref, files)
    if (result.exitCode === 0) return deliveredOutputBytes(Buffer.byteLength(result.stdout, 'utf8'))
  } catch {
    // Fall through to the 0 baseline below.
  }
  return 0
}

export interface ChangedOptions {
  ref?: string
  symbolMode?: boolean
  json?: boolean
  projectRoot?: string
  grep?: string
  excludeTests?: boolean
}

export function runChanged(opts: ChangedOptions = {}): number {
  const ref = opts.ref ?? 'HEAD~5'
  if (!refIsSafe(ref)) {
    emitUnsafeRef(ref)
    return 1
  }
  // Symbol mode answers from the machine-wide index, unlike the file list, which git reads from the working tree, so only it refuses a root outside what indexing.cross_project_symbols = false admits.
  const projectDenial = opts.symbolMode === true ? resolveProjectConfinement(opts.projectRoot).denial : null
  if (projectDenial !== null) {
    emitErr(formatCommandError(projectDenial))
    return 1
  }
  const cwd = opts.projectRoot ?? process.cwd()

  let changedFiles: string[]
  try {
    const result = runGit(['diff', ref, '--name-only'], { cwd })
    if (result.exitCode !== 0) {
      emitErr(formatGitFailure('diff', result.stderr))
      const hint = buildChangedRefHint(cwd, ref)
      if (hint !== null) {
        emitErr(formatCommandError(hint))
      }
      return 1
    }
    // A name with a quote, backslash or control character comes back C-quoted even with core.quotePath off.
    changedFiles = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((f) => (f.startsWith('"') && f.endsWith('"') && f.length > 1 ? unquoteGitPath(f.slice(1, -1)) : f))
  } catch {
    emitErr(formatCommandError(`Could not run git diff against ${echoedValue(ref)}`))
    return 1
  }

  const emptyEnvelope = (): number => {
    emit(displaySafeJson({ items: [], truncated: false, totalCount: 0 }))
    return 0
  }

  if (changedFiles.length === 0) {
    if (opts.json === true) return emptyEnvelope()
    emit('No files changed.')
    return 0
  }

  const preGrepFileCount = changedFiles.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  if (matchesGrep !== undefined) changedFiles = changedFiles.filter((f) => matchesGrep(f))
  if (matchesGrep !== undefined && changedFiles.length === 0) {
    if (opts.json === true) return emptyEnvelope()
    emit(grepFilteredToEmptyNotice(preGrepFileCount, opts.grep ?? '', 'changed file', 'changed files'))
    return 0
  }

  const postGrepFileCount = changedFiles.length
  let hiddenTestFiles = 0
  if (opts.excludeTests === true) {
    const kept = changedFiles.filter((f) => !isTestFile(f))
    hiddenTestFiles = changedFiles.length - kept.length
    changedFiles = kept
  }
  if (changedFiles.length === 0 && hiddenTestFiles > 0) {
    if (opts.json === true) return emptyEnvelope()
    const grepRemoved = preGrepFileCount - postGrepFileCount
    if (matchesGrep !== undefined && grepRemoved > 0) {
      emit(
        `No non-test files matched --grep ${displaySafeText(opts.grep ?? '')} ` +
          `(${excludeTestsHiddenNote(hiddenTestFiles)}; ${countNoun(grepRemoved, 'other changed file')} did not match the filter)`,
      )
      return 0
    }
    emit(`No non-test files changed (${excludeTestsHiddenNote(hiddenTestFiles)})`)
    return 0
  }

  // Resolved here, after every early return, so a failed diff or an empty change list never pays the `git rev-parse --show-toplevel` spawn.
  const projectRoot = resolveProjectRoot({ project: cwd })
  if (opts.symbolMode === true) {
    let hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
    let hunklessFiles = new Set<string>()
    let symbolDiffBaselineBytes = 0
    try {
      const diffResult = unifiedDiffOf(projectRoot, ref, changedFiles, ['--src-prefix=a/', '--dst-prefix=b/'])
      if (diffResult.exitCode === 0) {
        hunksByFile = parseDiffHunks(diffResult.stdout)
        hunklessFiles = parseHunklessFiles(diffResult.stdout)
        symbolDiffBaselineBytes = deliveredOutputBytes(Buffer.byteLength(diffResult.stdout, 'utf8'))
      }
    } catch {
      // Hunk-level diff unavailable — fall back to file-level scoping below.
    }

    const allSymbols: SymbolEntry[] = []
    for (const f of changedFiles) {
      if (hunklessFiles.has(f)) continue
      const fileSymbols = querySymbols({ filePath: resolveIndexPath(f, projectRoot), limit: FIND_SCAN_LIMIT })
      const hunks = hunksByFile.get(f)
      const scoped =
        hunks === undefined || isVirtualIndexedPath(f)
          ? fileSymbols
          : fileSymbols.filter((s: SymbolEntry) => hunks.some((h) => h.start <= s.lineEnd && h.end >= s.lineStart))
      allSymbols.push(...scoped)
    }
    if (allSymbols.length === 0) {
      if (opts.json === true) return emptyEnvelope()
      emit('No symbols changed.')
      return 0
    }
    const symbolFullBytes = symbolDiffBaselineBytes
    if (opts.json === true) {
      const capped = guardJsonRows(allSymbols)
      const text = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
      emit(text)
      recordReadStat('changed_lookup', symbolFullBytes, text, ref)
      return 0
    }
    const symbolText = allSymbols.map((s) => `${s.name} (${s.kind}) — ${formatSymbolLocation(toDisplayPath(projectRoot, s.filePath), s.lineStart)}`).join('\n')
    for (const s of allSymbols) {
      emit(`${displaySafeText(s.name)} (${displaySafeText(s.kind)}) — ${formatSymbolLocation(displaySafeText(toDisplayPath(projectRoot, s.filePath)), s.lineStart)}`)
    }
    recordReadStat('changed_lookup', symbolFullBytes, symbolText, ref)
    return 0
  }

  const fullBytes = changedDiffBaselineBytes(projectRoot, ref, changedFiles)
  if (opts.json === true) {
    const capped = guardJsonRows(changedFiles)
    const text = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
    emit(text)
    recordReadStat('changed_lookup', fullBytes, text, ref)
    return 0
  }
  for (const f of changedFiles) {
    emit(f)
  }
  recordReadStat('changed_lookup', fullBytes, changedFiles.join('\n'), ref)
  return 0
}

export interface DiffOptions {
  spec: string
  ref?: string
  json?: boolean
  projectRoot?: string
}

function splitDiffHunks(diffText: string): {
  preamble: string
  hunks: Array<{ text: string; start: number; end: number }>
} {
  const lines = diffText.split(/\r?\n/)
  let preambleEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (HUNK_HEADER_RE.test(lines[i]!)) {
      preambleEnd = i
      break
    }
  }
  const preamble = lines.slice(0, preambleEnd).join('\n')
  const hunks: Array<{ text: string; start: number; end: number }> = []
  let i = preambleEnd
  while (i < lines.length) {
    const line = lines[i]!
    const m = HUNK_HEADER_RE.exec(line)
    if (m === null) {
      i++
      continue
    }
    const range = hunkHeaderRange(m)
    const bodyLines = [line]
    let j = i + 1
    while (j < lines.length && !HUNK_HEADER_RE.test(lines[j]!)) {
      bodyLines.push(lines[j]!)
      j++
    }
    if (j >= lines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
    hunks.push({ text: bodyLines.join('\n'), start: range.start, end: range.end })
    i = j
  }
  return { preamble, hunks }
}

export function runDiff(opts: DiffOptions): number {
  if (opts.ref !== undefined && !refIsSafe(opts.ref)) {
    emitUnsafeRef(opts.ref)
    return 1
  }
  const match = resolveSymbolSpecOrEmitError('diff', opts.spec, opts.projectRoot)
  if (match === null) return 1
  const cwd = opts.projectRoot ?? process.cwd()

  const diffArgs =
    opts.ref !== undefined
      ? ['diff', opts.ref, '--unified=0', '--', match.filePath]
      : ['diff', '--unified=0', '--', match.filePath]
  let diffResult
  try {
    diffResult = runGit(diffArgs, { cwd })
  } catch {
    emitErr(formatCommandError(`Could not run git diff for ${echoedValue(match.filePath)}`))
    return 1
  }
  if (diffResult.exitCode !== 0) {
    emitErr(formatGitFailure('diff', diffResult.stderr))
    return 1
  }

  if (diffResult.stdout.trim() === '') {
    emit(`No changes to ${echoedValue(match.name)} in ${echoedValue(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}.`)
    return 0
  }

  const { hunks } = splitDiffHunks(diffResult.stdout)
  const diffFileScoped = isVirtualIndexedPath(match.filePath)
  const overlapping = diffFileScoped ? hunks : hunks.filter((h) => h.start <= match.lineEnd && h.end >= match.lineStart)

  if (overlapping.length === 0) {
    emit(`No changes to ${echoedValue(match.name)} (lines ${match.lineStart}-${match.lineEnd}) in ${echoedValue(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}.`)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(overlapping.map((h) => ({ start: h.start, end: h.end, text: h.text })))
    emit(
      displaySafeJson(
        {
          symbol: match.name,
          file: match.filePath,
          lineStart: match.lineStart,
          lineEnd: match.lineEnd,
          hunks: capped.items,
          truncated: capped.truncated,
          totalCount: capped.totalCount,
        }),
    )
    return 0
  }

  const header = `# ${displaySafeText(match.name)} (${displaySafeText(match.kind)}) — ${formatSymbolLocation(displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)), match.lineStart, match.lineEnd)}`
  const diffNote = diffFileScoped ? [virtualIndexedScopeNote(displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)), 'these hunks cover the whole file rather than this symbol alone')] : []
  emit(guardText([header, ...diffNote, ...overlapping.map((h) => h.text)].join('\n'), 'diff'))
  return 0
}

export interface LogOptions {
  spec: string
  ref?: string
  json?: boolean
  projectRoot?: string
  maxCount?: number
}

interface LogEntry {
  hash: string
  author: string
  date: string
  message: string
  diff: string
}

const DEFAULT_LOG_MAX_COUNT = 20

function parseLogDashLOutput(stdout: string): LogEntry[] {
  const lines = stdout.split(/\r?\n/)
  const commitHeaderRe = /^commit ([0-9a-f]{40})/
  const entries: LogEntry[] = []
  let i = 0
  while (i < lines.length) {
    const headerMatch = commitHeaderRe.exec(lines[i]!)
    if (headerMatch === null) {
      i++
      continue
    }
    const hash = headerMatch[1]!
    let author = ''
    let date = ''
    let j = i + 1
    while (j < lines.length && !commitHeaderRe.test(lines[j]!)) {
      const line = lines[j]!
      if (line.startsWith('diff --git')) break
      if (author === '' && line.startsWith('Author:')) author = line.slice('Author:'.length).trim()
      else if (date === '' && line.startsWith('Date:')) date = line.slice('Date:'.length).trim()
      j++
    }
    const messageLines: string[] = []
    for (let k = i + 1; k < j; k++) {
      const line = lines[k]!
      if (line.startsWith('Author:') || line.startsWith('Date:')) continue
      messageLines.push(line.startsWith('    ') ? line.slice(4) : line)
    }
    const message = trimBlankLines(messageLines).join('\n')

    let k = j
    while (k < lines.length && !commitHeaderRe.test(lines[k]!)) k++
    const diff = lines.slice(j, k).join('\n')

    entries.push({ hash, author, date, message, diff })
    i = k
  }
  return entries
}

export function runLog(opts: LogOptions): number {
  if (opts.ref !== undefined && !refIsSafe(opts.ref)) {
    emitUnsafeRef(opts.ref)
    return 1
  }
  const match = resolveSymbolSpecOrEmitError('log', opts.spec, opts.projectRoot)
  if (match === null) return 1
  const cwd = opts.projectRoot ?? process.cwd()
  const maxCount = opts.maxCount ?? DEFAULT_LOG_MAX_COUNT

  const fileScoped = isVirtualIndexedPath(match.filePath)
  const logArgs = fileScoped
    ? ['log', `--max-count=${maxCount}`, ...(opts.ref !== undefined ? [opts.ref] : []), '--', match.filePath]
    : [
        'log',
        `-L${match.lineStart},${match.lineEnd}:${match.filePath}`,
        `--max-count=${maxCount}`,
        ...(opts.ref !== undefined ? [opts.ref] : []),
      ]
  let logResult
  try {
    logResult = runGit(logArgs, { cwd })
  } catch {
    emitErr(formatCommandError(`Could not run git log for ${echoedValue(match.filePath)}`))
    return 1
  }
  if (logResult.exitCode !== 0) {
    emitErr(formatGitFailure('log', logResult.stderr))
    return 1
  }

  if (logResult.stdout.trim() === '') {
    emit(`No history for ${echoedValue(match.name)} (lines ${match.lineStart}-${match.lineEnd}) in ${echoedValue(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}.`)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(parseLogDashLOutput(logResult.stdout))
    emit(
      displaySafeJson(
        {
          symbol: match.name,
          file: match.filePath,
          lineStart: match.lineStart,
          lineEnd: match.lineEnd,
          commits: capped.items,
          truncated: capped.truncated,
          totalCount: capped.totalCount,
        }),
    )
    return 0
  }

  const header = `# ${displaySafeText(match.name)} (${displaySafeText(match.kind)}) — ${formatSymbolLocation(displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)), match.lineStart, match.lineEnd)}`
  const logNote = fileScoped ? [virtualIndexedScopeNote(displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)), 'this history covers the whole file rather than this symbol alone')] : []
  emit(guardText([header, ...logNote, logResult.stdout].join('\n'), 'diff'))
  return 0
}
