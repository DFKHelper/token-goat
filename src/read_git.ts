import * as fs from 'node:fs'
import * as path from 'node:path'

import { formatConflicts, formatConflictSummaries, parseConflicts, summarizeFileConflicts } from './conflict_query.js'
import { querySymbols } from './index_reader.js'
import { displaySafeJson, displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { formatSymbolLocation, isVirtualIndexedPath, virtualIndexedScopeNote } from './indexed_source.js'
import type { SymbolEntry } from './parser_types.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import {
  emit,
  emitErr,
  emitGuarded,
  guardJsonRows,
  guardText,
  readFileText,
  recordReadStat,
  resolveSymbolSpecOrEmitError,
  sumFileSizes,
  trimBlankLines,
  FIND_SCAN_LIMIT,
} from './read_commands.js'
import {
  compileGrepMatcher,
  countNoun,
  excludeTestsHiddenNote,
  grepFilteredToEmptyNotice,
  isTestFile,
  runGit,
} from './util.js'
import { walkProject } from './baseline.js'

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
      emitErr(`Could not read: ${opts.path}`)
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

export function parseDiffHunks(diffText: string): Map<string, Array<{ start: number; end: number }>> {
  const hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
  let currentFile: string | null = null
  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileMatch) {
      currentFile = fileMatch[1] ?? null
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

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function buildChangedRefHint(cwd: string, ref: string): string | null {
  const countResult = runGit(['rev-list', '--count', 'HEAD'], { cwd })
  if (countResult.exitCode !== 0) {
    return null
  }
  const commitCount = Number.parseInt(countResult.stdout.trim(), 10)
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    return null
  }
  const refResolves = runGit(['rev-parse', '--verify', '--quiet', ref], { cwd })
  if (refResolves.exitCode === 0) {
    return null
  }
  let suggestedRef: string | null = null
  for (let n = commitCount - 1; n >= 1; n--) {
    const candidate = `HEAD~${n}`
    const candidateResolves = runGit(['rev-parse', '--verify', '--quiet', candidate], { cwd })
    if (candidateResolves.exitCode === 0) {
      suggestedRef = candidate
      break
    }
  }
  if (suggestedRef === null) {
    suggestedRef = EMPTY_TREE_HASH
  }
  const commitWord = commitCount === 1 ? '1 commit' : `${commitCount} commits`
  return `Hint: this repo has only ${commitWord}; '${ref}' does not exist. Try: token-goat changed --since ${suggestedRef}`
}

function refIsSafe(ref: string): boolean {
  return !ref.startsWith('-')
}

function emitUnsafeRef(ref: string): void {
  emitErr(`Refusing a git ref that starts with '-': ${ref}`)
}

function changedDiffBaselineBytes(cwd: string, ref: string, files: readonly string[]): number {
  if (files.length === 0) return 0
  try {
    const result = runGit(['diff', ref, '--unified=0', '--', ...files], { cwd })
    if (result.exitCode === 0) return Buffer.byteLength(result.stdout, 'utf8')
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
  const cwd = opts.projectRoot ?? process.cwd()
  const projectRoot = resolveProjectRoot({ project: cwd })

  let changedFiles: string[]
  try {
    const result = runGit(['diff', ref, '--name-only'], { cwd })
    if (result.exitCode !== 0) {
      emitErr(`git diff failed: ${result.stderr}`)
      const hint = buildChangedRefHint(cwd, ref)
      if (hint !== null) {
        emitErr(hint)
      }
      return 1
    }
    changedFiles = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  } catch {
    emitErr(`Could not run git diff against '${ref}'`)
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
        `No non-test files matched --grep ${opts.grep ?? ''} ` +
          `(${excludeTestsHiddenNote(hiddenTestFiles)}; ${countNoun(grepRemoved, 'other changed file')} did not match the filter)`,
      )
      return 0
    }
    emit(`No non-test files changed (${excludeTestsHiddenNote(hiddenTestFiles)})`)
    return 0
  }

  if (opts.symbolMode === true) {
    let hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
    let symbolDiffBaselineBytes = 0
    try {
      const diffResult = runGit(['diff', ref, '--unified=0', '--', ...changedFiles], { cwd })
      if (diffResult.exitCode === 0) {
        hunksByFile = parseDiffHunks(diffResult.stdout)
        symbolDiffBaselineBytes = Buffer.byteLength(diffResult.stdout, 'utf8')
      }
    } catch {
      // Hunk-level diff unavailable — fall back to file-level scoping below.
    }

    const allSymbols: SymbolEntry[] = []
    for (const f of changedFiles) {
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

  const fullBytes = changedDiffBaselineBytes(cwd, ref, changedFiles)
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
    emitErr(`Could not run git diff for '${match.filePath}'`)
    return 1
  }
  if (diffResult.exitCode !== 0) {
    emitErr(`git diff failed: ${diffResult.stderr}`)
    return 1
  }

  if (diffResult.stdout.trim() === '') {
    emit(`No changes to '${displaySafeText(match.name)}' in '${displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}'.`)
    return 0
  }

  const { hunks } = splitDiffHunks(diffResult.stdout)
  const diffFileScoped = isVirtualIndexedPath(match.filePath)
  const overlapping = diffFileScoped ? hunks : hunks.filter((h) => h.start <= match.lineEnd && h.end >= match.lineStart)

  if (overlapping.length === 0) {
    emit(`No changes to '${displaySafeText(match.name)}' (lines ${match.lineStart}-${match.lineEnd}) in '${displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}'.`)
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
    emitErr(`Could not run git log for '${match.filePath}'`)
    return 1
  }
  if (logResult.exitCode !== 0) {
    emitErr(`git log failed: ${displaySafeText(logResult.stderr)}`)
    return 1
  }

  if (logResult.stdout.trim() === '') {
    emit(`No history for '${displaySafeText(match.name)}' (lines ${match.lineStart}-${match.lineEnd}) in '${displaySafeText(toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath))}'.`)
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
