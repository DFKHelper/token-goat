import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadConfig } from './config.js'
import { globalDbPath } from './constants.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { querySymbols } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { displaySafeJson, displaySafeText, resolveIndexPath, toDisplayPath } from './paths.js'
import { getDisplayRoot, isInsideRoot, resolveProjectRoot } from './project.js'
import {
  emitErr,
  findSpecSeparator,
  guardText,
  healStaleIndex,
  indexFileSyncPinned,
  readFileText,
  resolveAgainstProjectRoot,
  type ReadOptions,
} from './read_commands.js'
import {
  didYouMean,
  endsWithPathBoundary,
  formatCrossFileLead,
  rankSimilarNames,
} from './read_suggest.js'
import { countNoun, foldPath } from './util.js'

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

const FIND_SCAN_LIMIT = 20_000
const PARENT_IDENTIFIER_RE = /^[\w$]+$/

export type SymbolResolution =
  | { kind: 'ok'; entry: SymbolEntry }
  | { kind: 'confined'; message: string }
  | { kind: 'ambiguous'; symbol: string; file: string; candidates: SymbolEntry[] }
  | { kind: 'none' }

export function parseReadSpec(spec: string): { file: string; symbol?: string } {
  const colonIdx = findSpecSeparator(spec)
  if (colonIdx === -1) return { file: spec }
  return { file: spec.slice(0, colonIdx), symbol: spec.slice(colonIdx + 2) }
}

export function parseCrossFileMultiSpec(spec: string): { file: string; symbol: string }[] | null {
  const segments = spec.split(',')
  if (segments.length < 2) return null
  if (findSpecSeparator(segments[0]!) === -1) return null
  if (segments.filter((seg) => findSpecSeparator(seg) !== -1).length < 2) return null

  let currentFile: string | undefined
  const pairs: { file: string; symbol: string }[] = []
  for (const rawSeg of segments) {
    const seg = rawSeg.trim()
    const idx = findSpecSeparator(seg)
    if (idx !== -1) {
      currentFile = seg.slice(0, idx)
      const sym = seg.slice(idx + 2)
      if (sym.length > 0) pairs.push({ file: currentFile, symbol: sym })
      continue
    }
    if (currentFile !== undefined && seg.length > 0) pairs.push({ file: currentFile, symbol: seg })
  }
  return pairs.length > 1 ? pairs : null
}

export function parseMultiFileSpec(spec: string): string[] | null {
  if (!spec.includes(',')) return null
  if (fileExists(spec)) return null
  if (findSpecSeparator(spec) !== -1) return null
  const parts = spec.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return parts.length > 1 ? parts : null
}

export function extraFileArgsNote(
  command: string,
  first: string,
  extras: readonly string[],
  opts: { noun?: 'file' | 'spec'; mergeable?: boolean } = {},
): string {
  const noun = opts.noun ?? 'file'
  const head = `Note: ${extras.length} extra ${noun} argument(s) ignored (${extras.join(', ')}).`
  if (opts.mergeable === false) return `${head} ${command} takes one ${noun} at a time.`
  return `${head} ${command} reads one ${noun}, or a comma-separated list: token-goat ${command} "${[first, ...extras].join(',')}"`
}

export function parseLineRange(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null) return null
  if (fileExists(spec)) return null
  if (m[1]!.includes('::')) return null
  const start = parseInt(m[2]!, 10)
  const end = m[3] !== undefined ? parseInt(m[3], 10) : start
  return { file: m[1]!, start, end }
}

export function parseColonLineRange(symbol: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:[-:,](\d+))?$/.exec(symbol)
  if (m === null) return null
  const start = parseInt(m[1]!, 10)
  const end = m[2] !== undefined ? parseInt(m[2], 10) : start
  return { start, end }
}

export function runLineRange(
  range: { file: string; start: number; end: number },
  opts: ReadOptions,
): { text: string; code: number } {
  const { file, start, end } = range
  const diskPath = resolveAgainstProjectRoot(file, opts.projectRoot)
  if (start < 1) {
    return { text: `Invalid line range: start must be >= 1 (got ${start})`, code: 1 }
  }
  if (end < start) {
    return { text: `Invalid line range: end (${end}) is before start (${start})`, code: 1 }
  }
  const text = readFileText(diskPath)
  if (text === null) {
    return { text: `Could not read: ${file}`, code: 1 }
  }
  const allLines = text.split(/\r?\n/)
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    return { text: `Line ${start} is past end of file (${countNoun(allLines.length, 'line')}): ${file}`, code: 1 }
  }
  const clampedEnd = Math.min(end, allLines.length)
  const slice = allLines.slice(start - 1, clampedEnd)
  if (opts.json === true) {
    return { text: displaySafeJson({ file, start, end: clampedEnd, lines: slice }), code: 0 }
  }
  const tok = Math.ceil(slice.join('\n').length / 4)
  return {
    text: guardText(
      [`# lines ${start}-${clampedEnd} of ${allLines.length} (~${tok} tok)`, slice.join('\n')].join('\n'),
      'lines',
    ),
    code: 0,
  }
}

export function findParentName(entry: SymbolEntry, fileSymbols: SymbolEntry[]): string | null {
  let best: SymbolEntry | null = null
  for (const s of fileSymbols) {
    const sameSpan = s.lineStart === entry.lineStart && s.lineEnd === entry.lineEnd
    if (sameSpan) continue
    if (s.lineStart <= entry.lineStart && s.lineEnd >= entry.lineEnd) {
      if (best === null || s.lineStart > best.lineStart) best = s
    }
  }
  if (best !== null) return best.name
  const parent = (entry.parent ?? '').trim()
  if (parent !== '') return parent
  const doc = entry.docstring.trim()
  if (doc !== '' && PARENT_IDENTIFIER_RE.test(doc)) return doc
  return null
}

export function formatAmbiguity(symbol: string, file: string, candidates: SymbolEntry[], explicitRoot?: string, commandName = 'read'): string {
  const multiFile = new Set(candidates.map((c) => c.filePath)).size > 1
  const displayRoot = getDisplayRoot(explicitRoot)
  const lines = [
    `Ambiguous symbol '${displaySafeText(symbol)}' in '${displaySafeText(file)}': ${countNoun(candidates.length, 'definition')} match. ` +
      `Retry with one of the qualified commands below to pick one:`,
  ]
  const fileSymCache = new Map<string, SymbolEntry[]>()
  const getFileSyms = (filePath: string): SymbolEntry[] => {
    let fileSyms = fileSymCache.get(filePath)
    if (fileSyms === undefined) {
      fileSyms = querySymbols({ filePath, limit: FIND_SCAN_LIMIT })
      fileSymCache.set(filePath, fileSyms)
    }
    return fileSyms
  }
  const parents = candidates.map((c) => findParentName(c, getFileSyms(c.filePath)))
  const plainQualifiers = candidates.map((c, i) => (parents[i] !== null ? `${parents[i]}.${symbol}` : symbol))
  const qualifierCounts = new Map<string, number>()
  const fileGroupSize = new Map<string, number>()
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const key = `${c.filePath} ${plainQualifiers[i]}`
    qualifierCounts.set(key, (qualifierCounts.get(key) ?? 0) + 1)
    fileGroupSize.set(c.filePath, (fileGroupSize.get(c.filePath) ?? 0) + 1)
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const parent = parents[i]!
    const plainQualifier = plainQualifiers[i]!
    const collides =
      (qualifierCounts.get(`${c.filePath} ${plainQualifier}`) ?? 0) > 1 ||
      (parent === null && (fileGroupSize.get(c.filePath) ?? 0) > 1)
    const qualifier = collides ? `${plainQualifier}@${c.lineStart}` : plainQualifier
    const retryFile = multiFile ? toDisplayPath(displayRoot, c.filePath) : file
    const label = multiFile ? `${toDisplayPath(displayRoot, c.filePath)}::${qualifier}` : qualifier
    lines.push(`  - ${label} (line ${c.lineStart})  ->  token-goat ${commandName} "${retryFile}::${qualifier}"`)
  }
  return lines.join('\n')
}

export function confinedProjectRoot(explicitRoot?: string): string | null {
  if (loadConfig().indexing.cross_project_symbols) return null
  return resolveProjectRoot(explicitRoot !== undefined && explicitRoot.trim().length > 0 ? { project: explicitRoot } : {})
}

export function isProjectRootAllowed(candidateRoot: string, baseConfinedRoot: string): boolean {
  if (isInsideRoot(candidateRoot, baseConfinedRoot)) return true
  const allowedRoots = loadConfig().mcp.allowed_roots
  if (allowedRoots.length > 0 && allowedRoots.some((allowed) => isInsideRoot(candidateRoot, path.resolve(allowed)))) {
    return true
  }
  return false
}

export function confinementRefusal(label: string, resolved: string, root: string | null): string | null {
  if (root === null || isInsideRoot(resolved, root)) return null
  return `${label} is outside this project root, and indexing.cross_project_symbols = false confines symbol lookups to it: ${toDisplayPath(root, resolved)}`
}

export function fileConfinementRefusal(label: string, file: string, projectRoot: string | undefined): string | null {
  const root = confinedProjectRoot(projectRoot)
  if (root === null) return null
  return confinementRefusal(label, resolveIndexPath(file, projectRoot ?? process.cwd()), root)
}

export function resolveSymbolSpec(spec: string, forceRefresh?: boolean, projectRoot?: string): SymbolResolution {
  const { file, symbol: rawSymbol } = parseReadSpec(spec)
  if (rawSymbol === undefined || rawSymbol === '') return { kind: 'none' }

  const anchorMatch = /^(.+)@(\d+)$/.exec(rawSymbol)
  const symbol = anchorMatch !== null ? anchorMatch[1]! : rawSymbol
  const lineAnchor = anchorMatch !== null ? parseInt(anchorMatch[2]!, 10) : undefined

  const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
  const confined = confinementRefusal('This file', resolved, confinedProjectRoot(projectRoot))
  if (confined !== null) return { kind: 'confined', message: confined }
  if (forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
  } else {
    healStaleIndex(resolved)
  }

  const finalize = (cands: SymbolEntry[], displaySymbol: string): SymbolResolution => {
    const seen = new Set<string>()
    const distinct: SymbolEntry[] = []
    for (const c of cands) {
      const key = `${c.filePath}|${c.lineStart}|${c.lineEnd}`
      if (seen.has(key)) continue
      seen.add(key)
      distinct.push(c)
    }
    const anchored = lineAnchor === undefined ? distinct : distinct.filter((c) => c.lineStart === lineAnchor)
    if (anchored.length === 0) return { kind: 'none' }
    if (anchored.length === 1) return { kind: 'ok', entry: anchored[0]! }
    return { kind: 'ambiguous', symbol: displaySymbol, file, candidates: anchored }
  }

  if (symbol.includes('.')) {
    const exactMatch = querySymbols({ name: symbol, filePath: resolved, limit: 10 })
    if (exactMatch.length > 0) {
      return finalize(exactMatch, symbol)
    }
  }

  const dotParts = symbol.split('.')
  const [symBase, methodName] =
    dotParts.length > 1
      ? [dotParts[0] ?? symbol, dotParts[dotParts.length - 1]]
      : [symbol, undefined]

  const lookupName = methodName ?? symBase
  let candidates = querySymbols({ name: lookupName, filePath: resolved, limit: 10 })
  if (candidates.length === 0) {
    const foldedFile = foldPath(file)
    const baseName = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
    candidates = querySymbols({
      name: lookupName,
      limit: 50,
      ...(baseName !== '' ? { fileBaseName: baseName } : {}),
      ...(projectRoot !== undefined ? { rootDir: projectRoot } : {}),
    }).filter((s) => {
      const foldedFilePath = foldPath(s.filePath)
      return (
        foldedFilePath === foldedFile ||
        endsWithPathBoundary(foldedFilePath, foldedFile) ||
        endsWithPathBoundary(foldedFile, foldedFilePath)
      )
    })
  }

  if (methodName !== undefined && candidates.length > 1) {
    const containerBaseName = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
    const containers = querySymbols({
      name: symBase,
      limit: 50,
      ...(containerBaseName !== '' ? { fileBaseName: containerBaseName } : {}),
      ...(projectRoot !== undefined ? { rootDir: projectRoot } : {}),
    })
    const symBaseLower = symBase.toLowerCase()
    const scoped = candidates.filter((c) => {
      const cParent = c.parent ?? ''
      if (cParent.toLowerCase() === symBaseLower) return true
      if (cParent === '' && c.docstring.toLowerCase() === symBaseLower) return true
      return containers.some(
        (cls) =>
          cls.filePath === c.filePath &&
          !(cls.lineStart === c.lineStart && cls.lineEnd === c.lineEnd) &&
          c.lineStart >= cls.lineStart &&
          c.lineEnd <= cls.lineEnd,
      )
    })
    if (scoped.length > 0) candidates = scoped
  }

  return finalize(candidates, lookupName)
}

export function resolveSymbolSpecOrEmitError(
  commandName: string,
  spec: string,
  projectRoot: string | undefined,
): SymbolEntry | null {
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') {
    emitErr(`'token-goat ${commandName}' requires a 'file::symbol' spec (got '${spec}')`)
    return null
  }

  const resolution = resolveSymbolSpec(spec, undefined, projectRoot)

  if (resolution.kind === 'confined') {
    emitErr(resolution.message)
    return null
  }

  if (resolution.kind === 'ambiguous') {
    emitErr(
      formatAmbiguity(
        resolution.symbol,
        resolution.file,
        resolution.candidates,
        projectRoot,
        commandName,
      ),
    )
    return null
  }

  if (resolution.kind === 'none') {
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const crossFileLead = formatCrossFileLead(commandName, symbol, file, projectRoot)
    if (crossFileLead !== '') messages.push(crossFileLead)
    const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const closes = rankSimilarNames(scanned, symbol)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (scanned.length > 0) messages.push(`Try: token-goat outline ${file}`)
    emitErr(messages.join('\n'))
    return null
  }

  return resolution.entry
}
