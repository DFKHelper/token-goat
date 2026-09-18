/**
 * Outline and skeleton command handlers.
 *
 * Implements token-goat skeleton and token-goat outline, extracting symbol maps
 * without loading full bodies, with multi-file support and filtering.
 */

import type { SymbolEntry } from './parser_types.js'
import { resolveIndexPath, toDisplayPath, displaySafeJson } from './paths.js'
import { querySymbols, countSymbols, queryRefCounts } from './index_reader.js'
import { SKELETON_SYMBOL_CAP, globalDbPath } from './constants.js'
import { compileGrepMatcher, filtersFilteredToEmptyNotice, countNoun } from './util.js'
import { resolveProjectRoot, getDisplayRoot } from './project.js'
import { isVirtualIndexedPath, NOTEBOOK_CELL_LINES_SUFFIX } from './indexed_source.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'

import {
  indexFileSyncPinned,
  healStaleIndex,
  staleWarning,
  guardText,
  noSymbolsMessage,
  formatStatsSuffix,
  firstBodyLine,
  fileIsGone,
  recordReadStat,
  parseMultiFileSpec,
  hasRealDocstring,
  guardJsonRows,
  sumFileSizes,
  confinementRefusal,
  confinedProjectRoot,
} from './read_commands.js'

export interface SkeletonOptions {
  file: string
  json?: boolean
  minLines?: number
  /** Only list symbols whose NAME matches this pattern. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
  /** Internal. Set only by the multi-file path, where several files merge into one payload and each row needs to name its own file. Single-file callers already know the file they asked for, and every extra field per row costs rows under the byte cap. */
  includeFilePath?: boolean
  forceRefresh?: boolean
  stats?: boolean
  /**
   * Project root `file` resolves against when relative. Defaults to `process.cwd()`; same
   * field name as {@link SemanticOptions.projectRoot}. Relevant for callers (e.g. an MCP
   * server) whose cwd is not the workspace root -- a relative `file` would otherwise resolve
   * to the wrong absolute index key and silently match nothing.
   */
  projectRoot?: string
}

export type OutlineOptions = SkeletonOptions

/**
 * Character cap for the per-symbol doc annotation in `outline`'s text mode.
 */
const DOC_SUMMARY_MAX_CHARS = 140

/** Shortest prefix of a doc line that is a complete sentence, or `null` when it has no usable sentence end. */
function firstSentenceEnd(line: string): number | null {
  const MIN_SENTENCE_CHARS = 30
  const ABBREV = /(?:\b(?:e\.g|i\.e|vs|cf|etc|approx|al|Dr|Mr|Ms|St|Fig|No)\.|\b\p{L}\.)$/u
  for (const m of line.matchAll(/[.!?](?=\s|$)/gu)) {
    const end = m.index + 1
    if (end < MIN_SENTENCE_CHARS) continue
    const head = line.slice(0, end)
    if (ABBREV.test(head)) continue
    return end
  }
  return null
}

/** Clip a doc summary line for the outline. */
function clipDocSummary(firstLine: string): string {
  const sentence = firstSentenceEnd(firstLine)
  if (sentence !== null && sentence <= DOC_SUMMARY_MAX_CHARS) {
    return sentence === firstLine.length ? firstLine : `${firstLine.slice(0, sentence)}…`
  }
  if (firstLine.length <= DOC_SUMMARY_MAX_CHARS) return firstLine
  const cut = firstLine.lastIndexOf(' ', DOC_SUMMARY_MAX_CHARS)
  return `${firstLine.slice(0, cut > 40 ? cut : DOC_SUMMARY_MAX_CHARS).trimEnd()}…`
}

export function filteredToEmptyNotice(preFilterCount: number, minLines: number | undefined, grep: string | undefined): string {
  const parts: string[] = []
  if (minLines !== undefined) parts.push(`--min-lines ${minLines}`)
  if (grep !== undefined) parts.push(`--grep ${grep}`)
  return filtersFilteredToEmptyNotice(preFilterCount, parts, 'indexed symbol', 'indexed symbols', 'the file is indexed')
}

export function prepareSymbolListing(
  file: string,
  opts: { minLines?: number; grep?: string; forceRefresh?: boolean; stats?: boolean; projectRoot?: string },
): { kind: 'confined'; text: string } | { kind: 'empty'; text: string } | { kind: 'ok'; resolved: string; displayRoot: string | undefined; filtered: SymbolEntry[]; preFilterCount: number; refCounts: Map<string, number> | undefined; fullSourceBytes: number; symbolsTruncated: boolean; trueSymbolCount: number | undefined; totalLines: number } {
  const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
  const confined = confinementRefusal('This file', resolved, confinedProjectRoot(opts.projectRoot))
  if (confined !== null) return { kind: 'confined', text: confined }
  if (opts.forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
  } else {
    healStaleIndex(resolved)
  }
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const matches = (s: SymbolEntry): boolean =>
    (opts.minLines === undefined || s.lineEnd - s.lineStart + 1 >= opts.minLines) &&
    (matchesGrep === undefined || matchesGrep(s.name))

  // Page the scan rather than filtering one capped window: `--grep` compiles to a JS matcher (a guarded regex, or a substring fallback when the pattern is refused), so no SQL clause can express it, and applying it after `LIMIT SKELETON_SYMBOL_CAP` meant a symbol past the 5000th in source order was cut before the predicate ever saw it -- an empty result byte-identical to an honest no-match, under a notice blaming a filter that never ran. The cap now bounds the *matches* and stops the walk as soon as it has that many, so the common case still costs one query. There is deliberately no second cap on how far the walk may go: `isParseSkipEligible` already refuses to index a file larger than `indexing.large_file_skip_kb`, which bounds how many symbols one file can contribute, and peak memory here is one page plus the matches either way, since bodies for non-matching rows are dropped with the page.
  const filtered: SymbolEntry[] = []
  let scanned = 0
  let matchesTruncated = false
  let totalLines = 0
  for (let offset = 0; ; offset += SKELETON_SYMBOL_CAP) {
    const page = querySymbols({ filePath: resolved, limit: SKELETON_SYMBOL_CAP, offset })
    if (page.length === 0) break
    scanned += page.length
    for (const s of page) {
      // `totalLines` measures the file, not the listing: it is the extent the header names beside the symbol count, and it is taken over every row examined rather than only the ones a cap or filter kept, so a cap no longer shrinks the file's reported size along with the listing.
      if (s.lineEnd > totalLines) totalLines = s.lineEnd
      if (!matches(s)) continue
      if (filtered.length === SKELETON_SYMBOL_CAP) { matchesTruncated = true; break }
      filtered.push(s)
    }
    if (matchesTruncated || page.length < SKELETON_SYMBOL_CAP) break
  }

  if (scanned === 0) {
    return { kind: 'empty', text: noSymbolsMessage(file, resolved) }
  }

  // Only a full match list can hide anything now: the walk runs to the end of the file otherwise, so an empty or short listing is a real verdict on every symbol and needs no count to say so.
  const trueSymbolCount = matchesTruncated ? countSymbols({ filePath: resolved }) : undefined
  const symbolsTruncated = matchesTruncated

  const refCounts =
    opts.stats === true
      ? queryRefCounts(filtered.map((s) => s.name), globalDbPath(), resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }))
      : undefined

  const fullSourceBytes = sumFileSizes([resolved])

  return { kind: 'ok', resolved, displayRoot: getDisplayRoot(opts.projectRoot), filtered, preFilterCount: scanned, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount, totalLines }
}

export function runPerFileListing(
  files: string[],
  run: (file: string) => { text: string; code: number },
  json = false,
): { text: string; code: number } {
  const blocks: string[] = []
  let anyOk = false
  for (const file of files) {
    const r = run(file)
    if (r.code === 0) anyOk = true
    blocks.push(r.text)
  }
  if (json) return mergeListingJson(files, blocks, anyOk)
  return { text: blocks.join('\n\n'), code: anyOk ? 0 : 1 }
}

export function mergeListingJson(files: string[], blocks: string[], anyOk: boolean): { text: string; code: number } {
  const items: unknown[] = []
  const errors: { file: string; message: string }[] = []
  let truncated = false
  let totalCount = 0
  for (const [i, block] of blocks.entries()) {
    const file = files[i] ?? ''
    let parsed: { items?: unknown[]; truncated?: boolean; totalCount?: number } | undefined
    try {
      parsed = JSON.parse(block) as { items?: unknown[]; truncated?: boolean; totalCount?: number }
    } catch {
      parsed = undefined
    }
    if (parsed === undefined || !Array.isArray(parsed.items)) {
      errors.push({ file, message: block.trim() })
      continue
    }
    items.push(...parsed.items)
    if (parsed.truncated === true) truncated = true
    totalCount += parsed.totalCount ?? parsed.items.length
  }
  const payload = { items, truncated, totalCount, ...(errors.length > 0 ? { errors } : {}) }
  return { text: displaySafeJson(payload), code: anyOk ? 0 : 1 }
}

function symbolCountLabel(shown: number, truncated: boolean, trueCount: number | undefined): string {
  if (!truncated || trueCount === undefined || trueCount <= shown) return countNoun(shown, 'symbol')
  return `${shown} of ${countNoun(trueCount, 'symbol')}`
}

export function runSkeleton(opts: SkeletonOptions): { text: string; code: number } {
  const multiFiles = parseMultiFileSpec(opts.file)
  if (multiFiles !== null) return runPerFileListing(multiFiles, (file) => runSkeleton({ ...opts, file, includeFilePath: true }), opts.json === true)

  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'confined' || prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, displayRoot, filtered, preFilterCount, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount, totalLines } = prep

  if (opts.json === true) {
    const rows = filtered.map((s) => ({
      ...(opts.includeFilePath === true ? { filePath: toDisplayPath(displayRoot, s.filePath) } : {}),
      name: s.name,
      kind: s.kind,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      ...(refCounts !== undefined
        ? { refCount: refCounts.get(s.name) ?? 0, hasDoc: hasRealDocstring(s.docstring) }
        : {}),
    }))
    const capped = guardJsonRows(rows)
    const payload = {
      items: capped.items,
      truncated: capped.truncated || symbolsTruncated,
      totalCount: symbolsTruncated ? Math.max(trueSymbolCount ?? 0, capped.totalCount) : capped.totalCount,
      ...(fileIsGone(resolved) ? { deleted: true } : {}),
    }
    const text = displaySafeJson(payload)
    recordReadStat('stub_view', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const lines: string[] = [`# Skeleton: ${opts.file}  (${symbolCountLabel(filtered.length, symbolsTruncated, trueSymbolCount)}, ${countNoun(totalLines, 'line')})`]
  if (filtered.length === 0 && preFilterCount > 0) lines.push(filteredToEmptyNotice(preFilterCount, opts.minLines, opts.grep))
  for (const sym of filtered) {
    const lineStr = sym.lineStart.toString().padStart(6)
    const statsStr = formatStatsSuffix(refCounts, sym)
    lines.push(`  ${lineStr}  ${sym.kind.padEnd(10)}  ${sym.name}  ${firstBodyLine(sym.body)}${statsStr}`)
  }
  const text = guardText(staleWarning(resolved) + lines.join('\n'), 'symbol')
  recordReadStat('stub_view', fullSourceBytes, text, opts.file)
  return { text, code: 0 }
}

export function runOutline(opts: OutlineOptions): { text: string; code: number } {
  const multiFiles = parseMultiFileSpec(opts.file)
  if (multiFiles !== null) return runPerFileListing(multiFiles, (file) => runOutline({ ...opts, file, includeFilePath: true }), opts.json === true)

  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'confined' || prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, displayRoot, filtered, preFilterCount, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount } = prep

  if (opts.json === true) {
    const rows = filtered.map((s) => ({
      ...(opts.includeFilePath === true ? { filePath: toDisplayPath(displayRoot, s.filePath) } : {}),
      name: s.name,
      kind: s.kind,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      docstring: s.docstring,
      parent: s.parent,
      ...(refCounts !== undefined ? { refCount: refCounts.get(s.name) ?? 0, hasDoc: hasRealDocstring(s.docstring) } : {}),
    }))
    const capped = guardJsonRows(rows)
    const payload = {
      items: capped.items,
      truncated: capped.truncated || symbolsTruncated,
      totalCount: symbolsTruncated ? Math.max(trueSymbolCount ?? 0, capped.totalCount) : capped.totalCount,
      ...(fileIsGone(resolved) ? { deleted: true } : {}),
    }
    const text = displaySafeJson(payload)
    recordReadStat('outline', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const lines: string[] = [`# Outline: ${opts.file}  (${symbolCountLabel(filtered.length, symbolsTruncated, trueSymbolCount)})`]
  if (filtered.length === 0 && preFilterCount > 0) lines.push(filteredToEmptyNotice(preFilterCount, opts.minLines, opts.grep))
  for (const sym of filtered) {
    const rangeStr = `${sym.lineStart.toString().padStart(4)}-${sym.lineEnd.toString().padEnd(6)}`
    const kindStr = sym.kind.padEnd(14)
    const bodyLen = sym.lineEnd - sym.lineStart + 1
    const docFirst = hasRealDocstring(sym.docstring) ? `  # ${clipDocSummary(sym.docstring.split('\n')[0] ?? '')}` : ''
    const statsStr = formatStatsSuffix(refCounts, sym)
    const notebookSuffix = isVirtualIndexedPath(sym.filePath) ? NOTEBOOK_CELL_LINES_SUFFIX : ''
    lines.push(`  ${rangeStr}  ${kindStr}  ${sym.name}  (${bodyLen}ℓ)${docFirst}${statsStr}${notebookSuffix}`)
  }
  const text = guardText(staleWarning(resolved) + lines.join('\n'), 'symbol')
  recordReadStat('outline', fullSourceBytes, text, opts.file)
  return { text, code: 0 }
}
