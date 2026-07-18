/**
 * CLI command handlers for surgical-read commands.
 *
 * Ports the public command functions from ``read_commands.py`` to TypeScript.
 * The DB-query layer lives in ``index_reader.ts``; section extraction lives in
 * ``section_reader.ts``.  This module owns argument parsing, output formatting,
 * and the "did you mean?" hint logic.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { SKIP_DIRS } from './baseline.js'
import { querySymbols, queryRefs, queryRefCounts, searchSymbolsFts, getFileEntry } from './index_reader.js'
import { resolveIndexPath } from './paths.js'
import { indexFileSync } from './parser.js'
import { appendDirtyPath } from './hooks_index.js'
import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { fingerprintFile } from './fingerprint.js'
import { searchSemantic, mergeNearbyHits, OVER_FETCH_FACTOR, MAX_OVER_FETCH } from './embeddings.js'
import { readSection, listSections, extractSection, findContainingSection } from './section_reader.js'
import type { SectionResult } from './section_reader.js'
import { runGit, ensureNewline, foldPath, escapeRegExp, requireNonNegativeStrictInt, requirePositiveStrictInt, extractErrorMessage } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { resolveProjectRoot } from './project.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'
import { unsupportedLanguageName } from './parser_types.js'
import { loadConfig } from './config.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { resolveCallers } from './graph_commands.js'
import type { CallerEntry } from './graph_commands.js'
import { queryCsv, formatCsvTable, parseWhereSpecs, profileCsv, formatCsvProfile } from './csv_query.js'
import { outlineJson, formatJsonOutline, queryJson } from './json_query.js'
import { extractPdfMeta, extractPdfOutline, extractPdfText, type PdfMeta, type PdfOutlineEntry } from './pdf_extract.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat } from './stats.js'
import { isTsPath, resolveTypedRefs } from './ts_refs.js'

// ---- constants --------------------------------------------------------------

const DIDYOUMEAN_LIMIT = 5
const GREP_MAX_LINES = 200
// Symbol rows scanned when matching `find <pattern>` by substring — large enough to cover
// this tool's own index (thousands of symbols) without paging.
const FIND_SCAN_LIMIT = 20_000

// ---- helpers ----------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function readFileText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Symbols indexed with an empty stored `body` (e.g. HTML/Liquid heading symbols produced by
 * `sectionsToHeadingSymbols`, which store `body: ''`) need their content re-read from disk by
 * line range instead of rendering blank. Shared by runSymbol, runRead, and runBrief so all
 * three read surfaces resolve empty-body symbols the same way.
 */
function resolveBody(entry: { body: string; filePath: string; lineStart: number; lineEnd: number }): string {
  if (entry.body !== '') return entry.body
  const source = readFileText(entry.filePath)
  if (source === null) return entry.body
  return source
    .split(/\r?\n/)
    .slice(Math.max(0, entry.lineStart - 1), entry.lineEnd)
    .join('\n')
}

// The one-line warning prepended by staleWarning() when the on-disk file has changed since the
// index last saw it. Reuses fingerprintFile/files.sha -- the same sha the worker's dirty-queue
// gate (makeIndexer in worker.ts) compares against -- so "stale" here means exactly what it means
// there, rather than reinventing a second freshness signal.
const STALE_WARNING =
  "⚠ STALE: index is older than the file on disk (worker hasn't reindexed yet — retry shortly, or read the file directly)"

/**
 * Returns the STALE_WARNING line (plus trailing newline) when `resolvedPath`'s current on-disk
 * SHA-256 differs from the SHA-256 stamped on its `files` row at the time it was last indexed, or
 * '' when they match, the file isn't indexed, or the on-disk file can't be read. Cheap by design:
 * a single fs.readFileSync + hash, not a reparse, so it's safe to call on every read/outline/
 * skeleton/symbol lookup.
 */
function staleWarning(resolvedPath: string): string {
  const entry = getFileEntry(resolvedPath)
  if (entry === null || entry.sha === '') return ''
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null || diskSha === entry.sha) return ''
  return `${STALE_WARNING}\n`
}

/**
 * Self-heals a stale index entry instead of just warning about it: on the same SHA mismatch
 * {@link staleWarning} detects, synchronously reparses `resolvedPath` in-process via
 * {@link indexFileSync} -- the exact entry point the worker's dirty-queue drain (worker.ts's
 * makeIndexer) and `--force-refresh` already use, so this shares `writeParseResult`'s single
 * DELETE+INSERT transaction and db.ts's WAL journal mode + 15s busy_timeout. A background worker
 * racing to reindex the very same file just makes whichever write goes second wait for the held
 * lock instead of corrupting either write; no new concurrency handling is needed here.
 *
 * MUST be called before the caller's own DB query (querySymbols/etc.) so a successful heal is
 * picked up by that query automatically -- this function does not itself return or re-fetch any
 * rows. Every call site keeps its existing trailing `staleWarning(...)` call unchanged: once the
 * heal has landed, that check naturally finds the sha now matches and emits nothing, so the
 * surgical-read command just serves fresh data instead of a warning telling the agent to burn a
 * full-file read. On a genuine reparse failure (syntax error, unsupported file type, I/O error)
 * this fails safe -- the stale rows are left in place and the trailing `staleWarning(...)` call
 * falls back to the original warning text unchanged. Also enqueues the dirty-queue path on a
 * successful heal, mirroring `--force-refresh`'s own indexFileSync + enqueueDirtyPathSafe pairing
 * (see that function's doc): indexFileSync always wipes `files.embed_sha`, so semantic search
 * needs the same re-embed signal here too. Never throws.
 */
function healStaleIndex(resolvedPath: string): void {
  const entry = getFileEntry(resolvedPath)
  if (entry === null || entry.sha === '') return
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null || diskSha === entry.sha) return
  try {
    indexFileSync(resolvedPath, globalDbPath())
    enqueueDirtyPathSafe(resolvedPath)
  } catch {
    // Fail-safe: leave the stale rows in place. The caller's trailing staleWarning(...) call
    // will detect the still-mismatched sha and fall back to the pre-existing warning text --
    // never let a reparse failure turn a surgical-read command into a hard crash.
  }
}

function emit(text: string): void {
  const out = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(out))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/**
 * Emit text through the overflow guard: caps output at `config.overflow_guard.max_tokens`
 * (when enabled), appending a truncation marker with a hint tailored to `command`.
 * Mirrors the pre-port Python `_emit_text_result` -> `overflow_guard.guard` call, which
 * capped the same three text paths (read's symbol body, read's line-range slice, and
 * section's heading body) before the TS port dropped the wiring. JSON output paths must
 * never call this — line-based truncation would corrupt the JSON payload.
 */
function emitGuarded(text: string, command: string): void {
  emit(guardText(text, command))
}

function guardText(text: string, command: string): string {
  const cfg = loadConfig()
  return cfg.overflow_guard.enabled ? trimToBudget(text, cfg.overflow_guard.max_tokens, command) : text
}

/**
 * JSON-mode counterpart to {@link guardText}: caps a JSON-serializable array at
 * `config.overflow_guard.max_tokens` (when enabled) by dropping trailing whole items rather than
 * truncating text mid-payload. `symbol`/`refs`/`skeleton`/`outline`'s `--json` branches were the
 * one output path the overflow guard didn't reach -- their text-mode siblings already route
 * through {@link guardText}/{@link emitGuarded}, but JSON mode returned the raw, unbounded array.
 */
function guardJsonRows<T>(items: readonly T[]): JsonRowCapResult<T> {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return { items: [...items], truncated: false, totalCount: items.length }
  return capJsonRows(items, cfg.overflow_guard.max_tokens)
}

/**
 * Sum of on-disk byte sizes for a set of file paths, deduplicated so a command that matched
 * several symbols/refs/hits in the same file only counts that file's size once. Used as the
 * "full source" side of a stat's bytes-saved calculation. Best-effort: a path that no longer
 * exists on disk (stale index entry) or can't be stat'd contributes 0 rather than throwing --
 * stat recording must never turn a successful read into a hard error.
 */
function sumFileSizes(filePaths: Iterable<string>): number {
  let total = 0
  for (const fp of new Set(filePaths)) {
    try {
      total += fs.statSync(fp).size
    } catch {
      // Stale index entry pointing at a deleted/moved file — contributes nothing.
    }
  }
  return total
}

/**
 * Records a surgical-read stat event: bytes saved is the full on-disk source size minus the
 * emitted slice, floored at 1 (mirrors image_shrink.ts's recordStat call and the retired
 * Python read_commands.py's `max(1, saved // 3 + 1)` -- this repo drops the //3 constant-token
 * fudge factor in favor of the same bytes/4 approximation image_shrink already uses, for
 * consistency across every recordStat call site). Fail-soft via recordStat itself: never
 * blocks or fails a read on a stats-recording error.
 */
function recordReadStat(kind: string, fullSourceBytes: number, emittedText: string, detail?: string): void {
  const emittedBytes = Buffer.byteLength(emittedText, 'utf8')
  const bytesSaved = Math.max(1, fullSourceBytes - emittedBytes)
  recordStat(kind, bytesSaved, Math.round(bytesSaved / 4), undefined, detail)
}

// Finds the `::` separator in a `file::symbol` or `file::Heading` spec, splitting on the LAST
// occurrence rather than the first: a file path is far more likely to contain a literal `::`
// than a symbol/heading name is. Returns -1 when absent, matching `String.indexOf`'s no-match
// contract so callers can drop straight into their existing `=== -1` checks.
export function findSpecSeparator(spec: string): number {
  return spec.lastIndexOf('::')
}

// True when `full` ends with `suffix` at a path-segment boundary — the suffix is either the
// whole string or immediately preceded by `/` or `\`. A raw `endsWith` would let a requested
// `utils.ts` incorrectly match an indexed `myutils.ts`.
function endsWithPathBoundary(full: string, suffix: string): boolean {
  if (!full.endsWith(suffix)) return false
  if (full.length === suffix.length) return true
  const boundaryChar = full[full.length - suffix.length - 1]
  return boundaryChar === '/' || boundaryChar === '\\'
}

function didYouMean(candidates: string[]): string {
  if (candidates.length === 0) return ''
  const lines = ['Did you mean:']
  for (const c of candidates.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - ${c}`)
  }
  if (candidates.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${candidates.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end)
}

function firstBodyLine(body: string): string {
  return body.split('\n').find((l) => l.trim() !== '') ?? ''
}

// ---- symbol lookup ----------------------------------------------------------

export interface SymbolOptions {
  name?: string
  file?: string
  kind?: string
  limit?: number
  json?: boolean
  context?: number
  /**
   * Project root to scope the search to. Defaults to `process.cwd()`; same field name as
   * {@link SemanticOptions.projectRoot}. When `file` is a relative path, this is the base it
   * resolves against. When no `file` filter is given, this also scopes a bare-name search to
   * the given project instead of matching a same-named symbol anywhere across the machine-wide
   * index -- relevant for callers (e.g. an MCP server) whose cwd is not the workspace root.
   */
  projectRoot?: string
}

/** Handle ``token-goat symbol <name>``. */
export function runSymbol(opts: SymbolOptions): { text: string; code: number } {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero
  // rows regardless of whether the symbol exists -- silently reporting "no matches" for a
  // symbol that's actually indexed. Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    return { text: `--limit must be a positive number, got: ${opts.limit}`, code: 1 }
  }

  const queryOpts: Parameters<typeof querySymbols>[0] = {}
  if (opts.name !== undefined) queryOpts.name = opts.name
  if (opts.file !== undefined) {
    queryOpts.filePath = resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())
    // Self-heal before querying so a stale index serves fresh data instead of a warning.
    healStaleIndex(queryOpts.filePath)
  }
  if (opts.kind !== undefined) queryOpts.kind = opts.kind
  if (opts.limit !== undefined) queryOpts.limit = opts.limit
  // Only scope a bare-name search to projectRoot; when `file` already pins an exact indexed
  // path there's nothing left to disambiguate across projects.
  if (opts.file === undefined && opts.projectRoot !== undefined) queryOpts.rootDir = opts.projectRoot

  const results = querySymbols(queryOpts)

  if (results.length === 0) {
    return { text: `No matches for '${opts.name ?? '*'}'`, code: 1 }
  }

  const fullSourceBytes = sumFileSizes(results.map((s) => s.filePath))

  if (opts.json === true) {
    const capped = guardJsonRows(results)
    const payload = { items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file)
    return { text, code: 0 }
  }

  // Header + short body preview per match (mirrors the richer surface that the native CLI handler used before the two read surfaces were consolidated).
  const blocks = results.map((sym) => {
    const header = `# ${sym.name} (${sym.kind}) — ${sym.filePath}:${sym.lineStart}-${sym.lineEnd}`
    const body = resolveBody(sym)
    const preview = body.split(/\r?\n/).slice(0, 5).join('\n')
    return preview.trim() !== '' ? `${header}\n${preview}` : header
  })
  const warning = opts.file !== undefined ? staleWarning(resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())) : ''
  const text = guardText(warning + blocks.join('\n\n'), 'symbol')
  recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file)
  return { text, code: 0 }
}

// ---- read (symbol body) -----------------------------------------------------

export interface ReadOptions {
  spec: string
  json?: boolean
  contextLines?: number
  forceRefresh?: boolean
  /**
   * Project root to scope symbol resolution to. Defaults to `process.cwd()`; same field name
   * as {@link SemanticOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g.
   * an MCP server launched from an opaque directory) should pass the actual workspace root
   * explicitly -- otherwise a bare/partial file spec can resolve against the wrong project,
   * or an ambiguous symbol name can match a same-named definition in an unrelated project.
   */
  projectRoot?: string
}

function parseReadSpec(spec: string): { file: string; symbol?: string } {
  const colonIdx = findSpecSeparator(spec)
  if (colonIdx === -1) return { file: spec }
  return { file: spec.slice(0, colonIdx), symbol: spec.slice(colonIdx + 2) }
}

// A line-range read spec ends in `@N` (single line) or `@N-M` (inclusive range), e.g. `src/app.ts@10-20`. The `$`-anchored trailing digits mean a real path that ends in an extension (`report@2024.txt`) never matches; only a bare digit suffix triggers a range read.
function parseLineRange(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null) return null
  // If the full spec is a real file (e.g., a file literally named "notes@2024"), treat it as a plain file, not a range.
  if (fileExists(spec)) return null
  const start = parseInt(m[2]!, 10)
  const end = m[3] !== undefined ? parseInt(m[3], 10) : start
  return { file: m[1]!, start, end }
}

// Read an inclusive, 1-indexed line range straight from disk. Index-independent (raw fs read), so it works for files in any project and for paths outside every indexed project root.
function runLineRange(
  range: { file: string; start: number; end: number },
  opts: ReadOptions,
): { text: string; code: number } {
  const { file, start, end } = range
  if (start < 1) {
    return { text: `Invalid line range: start must be >= 1 (got ${start})`, code: 1 }
  }
  if (end < start) {
    return { text: `Invalid line range: end (${end}) is before start (${start})`, code: 1 }
  }
  const text = readFileText(file)
  if (text === null) {
    return { text: `Could not read: ${file}`, code: 1 }
  }
  const allLines = text.split(/\r?\n/)
  // A trailing newline terminates the last line rather than starting a new empty one; drop the phantom empty element split() appends so the line count matches editor/symbol-read conventions.
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    return { text: `Line ${start} is past end of file (${allLines.length} lines): ${file}`, code: 1 }
  }
  const clampedEnd = Math.min(end, allLines.length)
  const slice = allLines.slice(start - 1, clampedEnd)
  if (opts.json === true) {
    return { text: JSON.stringify({ file, start, end: clampedEnd, lines: slice }, null, 2), code: 0 }
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

// Resolves a `file::symbol` spec to its indexed SymbolEntry, including dotted-path ("Class.method")
// disambiguation and the partial-path fallback for an index keyed by a longer relative path.
// Shared by `runRead` and `runBrief` -- do not reimplement this resolution elsewhere.
/**
 * Outcome of resolving a `file::symbol` (or qualified `file::Parent.symbol`) spec:
 *  - `ok`        exactly one distinct definition matched (or a Parent qualifier narrowed
 *                the field to one) — the common, unchanged path.
 *  - `ambiguous` the bare name matched several distinct definitions in the file and no
 *                Parent qualifier disambiguated them. Callers MUST surface an error that
 *                lists every candidate rather than silently return the first row.
 *  - `none`      nothing matched.
 */
type SymbolResolution =
  | { kind: 'ok'; entry: SymbolEntry }
  | { kind: 'ambiguous'; symbol: string; file: string; candidates: SymbolEntry[] }
  | { kind: 'none' }

// Container kinds whose docstring may hold a real doc comment rather than a parent name.
const PARENT_IDENTIFIER_RE = /^[\w$]+$/

/**
 * Best-effort name of the symbol that lexically encloses `entry`, used only to label a
 * candidate in an ambiguity error. Tree-sitter/flat-emitter adapters record the parent via
 * line-containment (the class symbol's range spans the method body), so the tightest
 * enclosing symbol is the parent. Regex-parsed adapters (php/csharp/kotlin/powershell)
 * store the parent class name directly in the method's `docstring` field because their
 * class symbol is a single-line span at the header that never contains the body — fall back
 * to that when it is a bare identifier and no enclosing symbol was found. Returns null for a
 * genuine top-level definition.
 */
function findParentName(entry: SymbolEntry, fileSymbols: SymbolEntry[]): string | null {
  let best: SymbolEntry | null = null
  for (const s of fileSymbols) {
    const sameSpan = s.lineStart === entry.lineStart && s.lineEnd === entry.lineEnd
    if (sameSpan) continue
    if (s.lineStart <= entry.lineStart && s.lineEnd >= entry.lineEnd) {
      if (best === null || s.lineStart > best.lineStart) best = s
    }
  }
  if (best !== null) return best.name
  const doc = entry.docstring.trim()
  if (doc !== '' && PARENT_IDENTIFIER_RE.test(doc)) return doc
  return null
}

/**
 * Render the hard error shown when a bare `file::symbol` lookup matches multiple distinct
 * definitions. Two shapes are handled:
 *  - same-file ambiguity (several classes in one file each defining `compress`): labels stay
 *    bare `Parent.symbol (line N)` and the retry re-targets the original `file` spec, byte-for-
 *    byte unchanged from the pre-fix same-file behavior.
 *  - cross-file ambiguity (two different files each defining a same-named top-level symbol,
 *    where `findParentName` has no cross-file concept of "parent" and returns null for both):
 *    labels are prefixed with the candidate's own indexed file path so the candidates are
 *    visually distinguishable, and the retry targets that candidate's own file path instead of
 *    re-echoing the original ambiguous `file` string (which would just re-enter this same
 *    ambiguous resolution path).
 * A mixed list (some candidates share a same-file parent, others don't, across multiple files)
 * gets file-prefixed labels for every candidate, each with its own working, distinct retry.
 */
function formatAmbiguity(symbol: string, file: string, candidates: SymbolEntry[]): string {
  const multiFile = new Set(candidates.map((c) => c.filePath)).size > 1
  const lines = [
    `Ambiguous symbol '${symbol}' in '${file}': ${candidates.length} definitions match. ` +
      `Retry with one of the qualified commands below to pick one:`,
  ]
  const fileSymCache = new Map<string, SymbolEntry[]>()
  for (const c of candidates) {
    let fileSyms = fileSymCache.get(c.filePath)
    if (fileSyms === undefined) {
      fileSyms = querySymbols({ filePath: c.filePath, limit: 1000 })
      fileSymCache.set(c.filePath, fileSyms)
    }
    const parent = findParentName(c, fileSyms)
    const qualifier = parent !== null ? `${parent}.${symbol}` : symbol
    // Cross-file ambiguity can't be resolved by re-typing the original (still-ambiguous) `file`
    // spec -- retarget the retry at this candidate's own indexed file path so it resolves to
    // exactly this candidate. Same-file ambiguity keeps retrying against the original `file`
    // string, unchanged from the pre-fix behavior.
    const retryFile = multiFile ? c.filePath : file
    const label = multiFile ? `${c.filePath}::${qualifier}` : qualifier
    lines.push(`  - ${label} (line ${c.lineStart})  ->  token-goat read "${retryFile}::${qualifier}"`)
  }
  return lines.join('\n')
}

/**
 * After a `--force-refresh` reparse (`indexFileSync`), enqueue the file to the dirty queue so
 * the background worker re-embeds it on its next drain.
 *
 * `indexFileSync` -> `writeParseResult` deletes and reinserts the file's `files` row without an
 * `embed_sha` value, so a forced synchronous reparse here always wipes `embed_sha` to NULL --
 * without this enqueue, nothing would ever re-stamp it and `token-goat semantic` would keep
 * serving stale embedded content (or silently stop matching this file at all) until some
 * unrelated future edit happened to touch it again. Mirrors what `cmdReplace` (cli.ts) already
 * does after its own write: appending to the dirty queue is enough, since the worker's own
 * embed-freshness gate (`isEmbedFresh`) will see the wiped `embed_sha` as stale and re-embed on
 * its next drain -- semantic search tolerates that lag the same way it tolerates the worker's
 * normal incremental drain latency. Fail-soft: a queue-append failure must not turn a successful
 * force-refresh read into a hard error.
 */
function enqueueDirtyPathSafe(filePath: string): void {
  try {
    appendDirtyPath(filePath)
  } catch {
    // Fail-soft: the reparse already landed either way, just not re-embedded until the next
    // `token-goat index` or edit touches this file again.
  }
}

function resolveSymbolSpec(spec: string, forceRefresh?: boolean, projectRoot?: string): SymbolResolution {
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') return { kind: 'none' }

  const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
  if (forceRefresh === true) {
    indexFileSync(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved)
  } else {
    // Self-heal a stale index before querying below, so runRead/runBrief serve fresh data
    // instead of the caller having to fall back to a stale-index warning.
    healStaleIndex(resolved)
  }

  // Collapse a raw candidate list into a final resolution. Distinct definitions are keyed by
  // their (file,line) span, so a symbol accidentally indexed twice collapses to one row and
  // does not read as ambiguous. Exactly one distinct match -> ok (this preserves the
  // unambiguous single-match behavior byte-for-byte). More than one distinct match -> the
  // hard `ambiguous` error, which is the fix: never silently return candidates[0] when the
  // caller's name genuinely picks out several different definitions.
  const finalize = (cands: SymbolEntry[], displaySymbol: string): SymbolResolution => {
    const seen = new Set<string>()
    const distinct: SymbolEntry[] = []
    for (const c of cands) {
      const key = `${c.filePath}|${c.lineStart}|${c.lineEnd}`
      if (seen.has(key)) continue
      seen.add(key)
      distinct.push(c)
    }
    if (distinct.length === 0) return { kind: 'none' }
    if (distinct.length === 1) return { kind: 'ok', entry: distinct[0]! }
    return { kind: 'ambiguous', symbol: displaySymbol, file, candidates: distinct }
  }

  // Some indexed symbol names legitimately contain dots (TOML sections like "tool.poetry", CSS
  // selectors like ".btn") and must be matched exactly before assuming the dot is a Class.method
  // separator. Try the full unsplit symbol name first; only fall back to dot-split heuristic
  // if the exact match returns nothing.
  if (symbol.includes('.')) {
    const exactMatch = querySymbols({ name: symbol, filePath: resolved, limit: 10 })
    if (exactMatch.length > 0) {
      return finalize(exactMatch, symbol)
    }
  }

  // For a dotted path (e.g. "Session.refresh" or "Outer.Inner.refresh"), the symbol we want is the leaf — the LAST segment — since methods are indexed by their bare name. Using split('.')[1] would pick the middle segment of a 3+ part path and resolve to the wrong symbol (e.g. the inner class instead of its method).
  const dotParts = symbol.split('.')
  const [symBase, methodName] =
    dotParts.length > 1
      ? [dotParts[0] ?? symbol, dotParts[dotParts.length - 1]]
      : [symbol, undefined]

  // When a method name is given (e.g. "Session.refresh"), query for the method name directly. Querying for symBase (the class name) and then searching for methodName among those results always fails because all returned symbols have name === symBase, never name === methodName.
  const lookupName = methodName ?? symBase
  let candidates = querySymbols({ name: lookupName, filePath: resolved, limit: 10 })
  if (candidates.length === 0) {
    // Partial-path fallback: resolve `worker.ts::foo` against an index keyed by `src/worker.ts` by
    // matching on a path-segment boundary when the exact key misses — a raw endsWith would let a
    // requested `utils.ts` match an indexed `myutils.ts`. Fold case on case-insensitive
    // filesystems (Windows/macOS) the same way foldPath/pathEqClause do elsewhere in this
    // codebase (index_prune.ts, walk_index.ts, worker.ts) — this filter runs in plain JS, not
    // SQL, so it is not covered by querySymbols' own COLLATE NOCASE and needs its own fold.
    const foldedFile = foldPath(file)
    candidates = querySymbols({
      name: lookupName,
      limit: 50,
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

  // For a dotted spec ("ClassName.methodName"), symBase names the class/container. When the
  // bare methodName lookup above is ambiguous (multiple same-named methods, e.g. two classes
  // each with their own `refresh`), narrow to candidates whose line range falls inside a
  // symbol named symBase in the same file — otherwise the wrong class's method can win.
  if (methodName !== undefined && candidates.length > 1) {
    const containers = querySymbols({
      name: symBase,
      limit: 50,
      ...(projectRoot !== undefined ? { rootDir: projectRoot } : {}),
    })
    // Regex-parsed languages (php.ts, csharp.ts, kotlin.ts, powershell_idx.ts) store a method's
    // class symbol with lineEnd === lineStart (single-line span at the class header, not the
    // full body), so the line-containment check below always misses for them -- they instead
    // record the parent class name directly in the method symbol's `docstring` field (see
    // makeSymbol in each of those files). Match on either signal so both regex adapters
    // (docstring) and tree-sitter/flat-emitter adapters (line-containment) disambiguate
    // correctly instead of silently falling through to candidates[0] (the first same-named
    // method, regardless of which class was actually requested).
    const symBaseLower = symBase.toLowerCase()
    const scoped = candidates.filter((c) => {
      if (c.docstring.toLowerCase() === symBaseLower) return true
      return containers.some(
        (cls) => cls.filePath === c.filePath && c.lineStart >= cls.lineStart && c.lineEnd <= cls.lineEnd,
      )
    })
    if (scoped.length > 0) candidates = scoped
  }

  // A bare name that still matches several distinct definitions (no Parent qualifier, or a
  // qualifier that failed to narrow) resolves to `ambiguous` here — the leaf name is what the
  // user must re-qualify, so it is the display symbol for the error's `Parent.<leaf>` labels.
  return finalize(candidates, lookupName)
}

/** Handle ``token-goat read "file::symbol"`` and ``token-goat read "file@N-M"``. */
export function runRead(opts: ReadOptions): { text: string; code: number } {
  const range = parseLineRange(opts.spec)
  if (range !== null) return runLineRange(range, opts)

  const { file, symbol } = parseReadSpec(opts.spec)

  if (symbol === undefined || symbol === '') {
    const text = readFileText(file)
    if (text === null) {
      return { text: `Could not read: ${file}`, code: 1 }
    }
    return { text: guardText(text, 'symbol'), code: 0 }
  }

  const resolution = resolveSymbolSpec(opts.spec, opts.forceRefresh, opts.projectRoot)

  if (resolution.kind === 'ambiguous') {
    // Genuine same-file ambiguity (a bare name matching several classes' methods, or a
    // qualifier that failed to narrow): refuse to guess. The error lists every candidate and
    // the qualified retry syntax instead of silently returning the first-ordered row.
    return {
      text: formatAmbiguity(resolution.symbol, resolution.file, resolution.candidates),
      code: 1,
    }
  }

  if (resolution.kind === 'none') {
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
    const closes = querySymbols({ filePath: resolved, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
    if (closes.length > 0) messages.push(didYouMean(closes))
    return { text: messages.join('\n'), code: 1 }
  }

  const match = resolution.entry
  const fullSourceBytes = sumFileSizes([match.filePath])

  if (opts.json === true) {
    const text = JSON.stringify(match, null, 2)
    recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
    return { text, code: 0 }
  }

  const body = resolveBody(match)

  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    `# ${bodyLen} lines (~${Math.ceil(body.length / 4)} tok)`,
    body,
  ]
  const warning = staleWarning(match.filePath)
  const text = guardText(warning + trimBlankLines(lines).join('\n'), 'symbol')
  recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

// ---- section ----------------------------------------------------------------

export interface SectionOptions {
  spec: string
  json?: boolean
  /**
   * Project root a relative file spec resolves against. Defaults to `process.cwd()`; same
   * field name as {@link SemanticOptions.projectRoot}. Relevant for callers (e.g. an MCP
   * server) whose cwd is not the workspace root -- a relative file spec would otherwise
   * resolve on disk relative to the wrong directory.
   */
  projectRoot?: string
}

/** Handle ``token-goat section "file::Heading"``. */
export function runSection(opts: SectionOptions): { text: string; code: number } {
  const colonIdx = findSpecSeparator(opts.spec)
  if (colonIdx === -1) {
    return { text: `Invalid section spec — expected "file::Heading", got: ${opts.spec}`, code: 1 }
  }
  const specFilePath = opts.spec.slice(0, colonIdx)
  // Only resolve against projectRoot when explicitly given and the spec's file part is
  // relative -- an absolute path, or the no-projectRoot default, stays byte-identical to the
  // pre-existing behavior (readSection/listSections resolve a relative path against
  // process.cwd() themselves, same as the CLI always has).
  const filePath =
    opts.projectRoot !== undefined && !path.isAbsolute(specFilePath)
      ? path.resolve(opts.projectRoot, specFilePath)
      : specFilePath
  const heading = opts.spec.slice(colonIdx + 2)

  const result = readSection(filePath, heading)
  if (result === null) {
    const messages = [`Section '${heading}' not found in '${filePath}'`]
    const available = listSections(filePath)
    if (available.length > 0) messages.push(didYouMean(available))
    return { text: messages.join('\n'), code: 1 }
  }

  // A prefix-redirected match (readSection resolved a different heading than the one asked
  // for) is recorded as section_replacement rather than a plain section_read, mirroring the
  // "replacement" framing used by read_replacement for a substituted read elsewhere in this
  // file.
  const kind = result.redirectedFrom !== undefined ? 'section_replacement' : 'section_read'
  const fullSourceBytes = sumFileSizes([filePath])

  if (opts.json === true) {
    const text = JSON.stringify(result, null, 2)
    recordReadStat(kind, fullSourceBytes, text, heading)
    return { text, code: 0 }
  }

  const redirectNote =
    result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  const text = guardText(
    `# ${result.heading} — ${filePath}:${result.lineStart}-${result.lineEnd}${redirectNote}\n${result.content}`,
    'heading',
  )
  recordReadStat(kind, fullSourceBytes, text, heading)
  return { text, code: 0 }
}

// ---- refs -------------------------------------------------------------------

export interface RefsOptions {
  spec: string
  callers?: boolean
  json?: boolean
  limit?: number
}

/**
 * Best-effort "exact" tier for `refs`: name-based matching (via `queryRefs`) conflates two
 * unrelated symbols that happen to share a name -- see `ts_refs.ts`'s module doc. When the
 * symbol's definition is unambiguous (exactly one `querySymbols` hit for `symName`/`file`) and is
 * a TypeScript file, this narrows `results` using the TypeScript compiler API's type checker.
 *
 * Always degrades to `results` unchanged when the tier can't apply: ambiguous or missing
 * definition, non-TS definition file, `typescript` unavailable, or any resolution failure. No CLI
 * flag gates this -- it applies silently whenever the file type qualifies, the same
 * best-available-accuracy pattern `embeddings.ts`'s `isAvailable()`-gated semantic tier uses.
 */
function applyTypedRefsTier(
  symName: string,
  file: string | undefined,
  results: RefEntry[],
): RefEntry[] {
  if (results.length === 0) return results
  try {
    const symbolQueryOpts: Parameters<typeof querySymbols>[0] = { name: symName, limit: 2 }
    if (file !== undefined) symbolQueryOpts.filePath = file
    const defs = querySymbols(symbolQueryOpts)
    if (defs.length !== 1) return results
    const def = defs[0]
    if (def === undefined || !isTsPath(def.filePath)) return results
    const typed = resolveTypedRefs({
      defFile: def.filePath,
      defLineStart: def.lineStart,
      defLineEnd: def.lineEnd,
      symbolName: symName,
      candidates: results,
    })
    return typed ?? results
  } catch {
    return results
  }
}

/** Splits a refs spec into an optional `::`-prefixed file scope and the comma-separated symbol list after it. With no `::`, the whole spec is the comma-separated symbol list; with no comma, a single-element list (the original single-symbol form). */
function parseMultiRefsSpec(spec: string): { file: string | undefined; symbols: string[] } {
  const colonIdx = findSpecSeparator(spec)
  const file = colonIdx === -1 ? undefined : spec.slice(0, colonIdx)
  const symPart = colonIdx === -1 ? spec : spec.slice(colonIdx + 2)
  const symbols = symPart.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return { file, symbols }
}

/** Handle ``token-goat refs <spec>``. A comma-separated spec (`a,b,c` or `file::a,b`) merges the references of several symbols into one call, each group headed by its symbol name; a single symbol keeps the original behavior verbatim via {@link runRefsSingle}. */
export function runRefs(opts: RefsOptions): number {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero
  // rows regardless of whether references exist -- silently reporting "no references found"
  // for a symbol that's actually referenced. Reject it explicitly instead of querying with it.
  // Both callers (this multi-symbol path and the single-symbol runRefsSingle it delegates to)
  // are covered by this one check since runRefsSingle is never called from outside this file.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const { file, symbols } = parseMultiRefsSpec(opts.spec)
  if (symbols.length <= 1) return runRefsSingle(opts)

  // Every entry uses the same envelope shape as the single-symbol `refs`/`symbol`/`skeleton`/
  // `outline` JSON output ({ items, truncated, totalCount }), whether or not it was truncated —
  // a JSON consumer should never have to branch on shape depending on truncation.
  const jsonOut: Record<string, { items: RefEntry[]; truncated: boolean; totalCount: number }> = {}
  let anyFound = false
  const lines: string[] = []
  const refFilePaths: string[] = []
  for (const sym of symbols) {
    const queryOpts: Parameters<typeof queryRefs>[0] = { name: sym }
    // The `file` in `file::symbol` names where the symbol is DEFINED, only used to
    // disambiguate a same-named symbol elsewhere in the index. Callers of it can live
    // anywhere in the codebase, so --callers must never scope the search to that file.
    if (file !== undefined && opts.callers !== true) queryOpts.filePath = resolveIndexPath(file)
    if (opts.limit !== undefined) queryOpts.limit = opts.limit
    const results = applyTypedRefsTier(sym, file, queryRefs(queryOpts))
    if (results.length > 0) anyFound = true
    refFilePaths.push(...results.map((r) => r.filePath))
    if (opts.json === true) {
      const capped = guardJsonRows(results)
      jsonOut[sym] = { items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }
      continue
    }
    if (results.length === 0) {
      lines.push(`${sym}: (no references found)`)
      continue
    }
    lines.push(`${sym}:`)
    if (opts.callers === true) {
      lines.push(...renderCallerGroups(results))
    } else {
      for (const ref of results) lines.push(`  ${ref.filePath}:${ref.line}: ${ref.context}`)
    }
  }
  const fullSourceBytes = sumFileSizes(refFilePaths)
  if (opts.json === true) {
    const text = JSON.stringify(jsonOut, null, 2)
    emit(text)
    if (anyFound) recordReadStat('symbol_read', fullSourceBytes, text, opts.spec)
    return anyFound ? 0 : 1
  }
  const text = lines.join('\n')
  emitGuarded(text, 'symbol')
  if (anyFound) recordReadStat('symbol_read', fullSourceBytes, text, opts.spec)
  return anyFound ? 0 : 1
}

/** Handle ``token-goat refs file::symbol``. */
function runRefsSingle(opts: RefsOptions): number {
  const { file, symbol } = parseReadSpec(opts.spec)
  const symName = symbol ?? file

  const queryOpts: Parameters<typeof queryRefs>[0] = { name: symName }
  // Same reasoning as runRefs above: `file` only disambiguates which same-named symbol
  // this is, by its defining file — it must not restrict --callers to that one file.
  const defFileHint = symbol !== undefined ? resolveIndexPath(file) : undefined
  if (defFileHint !== undefined && opts.callers !== true) queryOpts.filePath = defFileHint
  if (opts.limit !== undefined) queryOpts.limit = opts.limit

  const results = applyTypedRefsTier(symName, defFileHint, queryRefs(queryOpts))

  if (results.length === 0) {
    emitErr(`No references found for '${symName}'`)
    return 1
  }

  const fullSourceBytes = sumFileSizes(results.map((r) => r.filePath))

  if (opts.json === true) {
    const capped = guardJsonRows(results)
    const payload = { items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }
    const text = JSON.stringify(payload, null, 2)
    emit(text)
    recordReadStat('symbol_read', fullSourceBytes, text, symName)
    return 0
  }

  const lines =
    opts.callers === true
      ? renderCallerGroups(results)
      : results.map((ref) => `${ref.filePath}:${ref.line}: ${ref.context}`)
  const text = lines.join('\n')
  emitGuarded(text, 'symbol')
  recordReadStat('symbol_read', fullSourceBytes, text, symName)
  return 0
}

function renderCallerGroups(refs: RefEntry[]): string[] {
  const byFile = new Map<string, RefEntry[]>()
  for (const ref of refs) {
    const bucket = byFile.get(ref.filePath)
    if (bucket !== undefined) {
      bucket.push(ref)
    } else {
      byFile.set(ref.filePath, [ref])
    }
  }
  const lines: string[] = []
  for (const [file, fileRefs] of byFile) {
    lines.push(`${file}:`)
    for (const ref of fileRefs) {
      lines.push(`  :${ref.line}  ${ref.context !== '' ? ref.context : '(module scope)'}`)
    }
  }
  return lines
}

// ---- skeleton / stub_view ---------------------------------------------------

export interface SkeletonOptions {
  file: string
  json?: boolean
  minLines?: number
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

/**
 * "No indexed symbols" is ambiguous on its own: a genuinely empty file, an unrecognized
 * extension, and a recognized-but-unsupported language (Swift, Scala, Lua, Elixir, Dart,
 * Zig, R -- see {@link unsupportedLanguageName}) all currently produce zero symbol rows and
 * look identical from the CLI's perspective. Callers get a clearer diagnostic distinguishing
 * "token-goat can't parse this language at all yet" from a plain empty-index result.
 */
function noSymbolsMessage(displayPath: string, resolvedPath: string): string {
  const lang = unsupportedLanguageName(resolvedPath)
  if (lang !== undefined) {
    return `No indexed symbols found in '${displayPath}' -- ${lang} has no symbol extractor yet, so this file always indexes to 0 symbols regardless of its contents`
  }
  return `No indexed symbols found in '${displayPath}'`
}

/**
 * Shared prologue for `skeleton`/`outline`: resolve the file, optionally reparse it, fetch its
 * indexed symbols, and (on a non-empty result) apply the `--min-lines` filter and optional
 * `--stats` ref-count lookup. Both commands share this exact sequence verbatim; only their JSON
 * row shape and text-line formatting differ, so those stay in each command's own function.
 */
function prepareSymbolListing(
  file: string,
  opts: { minLines?: number; forceRefresh?: boolean; stats?: boolean; projectRoot?: string },
): { kind: 'empty'; text: string } | { kind: 'ok'; resolved: string; filtered: SymbolEntry[]; refCounts: Map<string, number> | undefined; fullSourceBytes: number } {
  const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
  if (opts.forceRefresh === true) {
    indexFileSync(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved)
  } else {
    // Self-heal a stale index before querying below, so skeleton/outline serve fresh data
    // instead of the caller having to fall back to a stale-index warning.
    healStaleIndex(resolved)
  }
  const symbols = querySymbols({ filePath: resolved, limit: 500 })

  if (symbols.length === 0) {
    return { kind: 'empty', text: noSymbolsMessage(file, resolved) }
  }

  const filtered =
    opts.minLines !== undefined
      ? symbols.filter((s) => s.lineEnd - s.lineStart + 1 >= (opts.minLines ?? 0))
      : symbols

  const refCounts =
    opts.stats === true
      ? queryRefCounts(filtered.map((s) => s.name), globalDbPath(), resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }))
      : undefined

  const fullSourceBytes = sumFileSizes([resolved])

  return { kind: 'ok', resolved, filtered, refCounts, fullSourceBytes }
}

/** Handle ``token-goat skeleton file``. */
export function runSkeleton(opts: SkeletonOptions): { text: string; code: number } {
  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, filtered, refCounts, fullSourceBytes } = prep

  if (opts.json === true) {
    const rows = filtered.map((s) => ({
      name: s.name,
      kind: s.kind,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      ...(refCounts !== undefined
        ? { refCount: refCounts.get(s.name) ?? 0, hasDoc: s.docstring.trim().length > 0 }
        : {}),
    }))
    const capped = guardJsonRows(rows)
    const payload = { items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('stub_view', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const totalLines = filtered.length > 0 ? Math.max(...filtered.map((s) => s.lineEnd)) : 0
  const lines: string[] = [`# Skeleton: ${opts.file}  (${filtered.length} symbols, ${totalLines} lines)`]
  for (const sym of filtered) {
    const lineStr = sym.lineStart.toString().padStart(6)
    const statsStr =
      refCounts !== undefined
        ? `  [${refCounts.get(sym.name) ?? 0} refs, ${sym.docstring.trim().length > 0 ? 'documented' : 'undocumented'}]`
        : ''
    lines.push(`  ${lineStr}  ${sym.kind.padEnd(10)}  ${sym.name}  ${firstBodyLine(sym.body)}${statsStr}`)
  }
  const text = guardText(staleWarning(resolved) + lines.join('\n'), 'symbol')
  recordReadStat('stub_view', fullSourceBytes, text, opts.file)
  return { text, code: 0 }
}

// ---- outline ----------------------------------------------------------------

export interface OutlineOptions {
  file: string
  json?: boolean
  minLines?: number
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

/** Handle ``token-goat outline file``. */
export function runOutline(opts: OutlineOptions): { text: string; code: number } {
  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, filtered, refCounts, fullSourceBytes } = prep

  if (opts.json === true) {
    const rows =
      refCounts !== undefined
        ? filtered.map((s) => ({
            ...s,
            refCount: refCounts.get(s.name) ?? 0,
            hasDoc: s.docstring.trim().length > 0,
          }))
        : filtered
    const capped = guardJsonRows(rows)
    const payload = { items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('outline', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const lines: string[] = [`# Outline: ${opts.file}  (${filtered.length} symbols)`]
  for (const sym of filtered) {
    const rangeStr = `${sym.lineStart.toString().padStart(4)}-${sym.lineEnd.toString().padEnd(6)}`
    const kindStr = sym.kind.padEnd(14)
    const bodyLen = sym.lineEnd - sym.lineStart + 1
    const docFirst = sym.docstring ? `  # ${sym.docstring.split('\n')[0] ?? ''}` : ''
    const statsStr =
      refCounts !== undefined
        ? `  [${refCounts.get(sym.name) ?? 0} refs, ${sym.docstring.trim().length > 0 ? 'documented' : 'undocumented'}]`
        : ''
    lines.push(`  ${rangeStr}  ${kindStr}  ${sym.name}  (${bodyLen}ℓ)${docFirst}${statsStr}`)
  }
  const text = guardText(staleWarning(resolved) + lines.join('\n'), 'symbol')
  recordReadStat('outline', fullSourceBytes, text, opts.file)
  return { text, code: 0 }
}

// ---- csv / pdf / screenshot --------------------------------------------------

// Mirrors cli.ts's requireNonNegativeInt (same regex-only-integer validation plus a sign
// check) so csv's `--head` gets the same error behavior as xlsx's `--head`: a clean thrown
// error on a non-numeric or negative value instead of `parseInt` silently producing NaN
// (which downstream `.slice(0, NaN)` turns into "0 rows returned") or a negative count
// (which `.slice(0, -N)` silently reinterprets as "all but the last N rows").
// screenshot --width/--height: parseInt's bare `NaN` result isn't nullish, so it survives the
// `?? 1280`-style fallback in takeScreenshot and reaches Chrome DevTools Protocol, producing an
// opaque `Protocol error (Emulation.setDeviceMetricsOverride)` failure after a full browser
// launch. Validating up front (requirePositiveStrictInt, from util.ts) fails fast with a clear
// CLI error before that launch happens.

interface CsvQueryCliOptions {
  file: string
  columns?: string
  where?: string[]
  head?: string
  json?: boolean
  delimiter?: string
  noHeader?: boolean
}

export function runCsvQuery(opts: CsvQueryCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  const columns = opts.columns
    ? opts.columns
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    : undefined

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }

  try {
    const wheres = parseWhereSpecs(opts.where)
    const result = queryCsv(text, {
      ...(columns !== undefined ? { columns } : {}),
      ...(wheres !== undefined ? { wheres } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
      ...(opts.noHeader === true ? { noHeader: true } : {}),
    })
    if (result.header.length === 0) {
      emit(`No data rows found in ${opts.file}`)
      return 0
    }
    if (opts.json === true) {
      const rowsJson = result.rows.map((r) => Object.fromEntries(result.header.map((h, i) => [h, r[i]])))
      const capped = guardJsonRows(rowsJson)
      emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }))
    } else {
      emit(formatCsvTable(result))
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

interface CsvProfileCliOptions {
  file: string
  delimiter?: string
  noHeader?: boolean
}

export function runCsvProfile(opts: CsvProfileCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  try {
    const profiles = profileCsv(text, {
      ...(opts.delimiter !== undefined ? { delimiter: opts.delimiter } : {}),
      ...(opts.noHeader === true ? { noHeader: true } : {}),
    })
    if (profiles.length === 0) {
      emit(`No data rows found in ${opts.file}`)
      return 0
    }
    emit(formatCsvProfile(profiles))
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface JsonOutlineCliOptions {
  file: string
  json?: boolean
}

/** Handle ``token-goat json-outline file``: structural summary of a JSON document without
 * dumping it -- element count + key/type shape for an array, top-level key types/sizes for
 * an object. */
export function runJsonOutline(opts: JsonOutlineCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    emitErr(`Failed to parse JSON: ${opts.file}`)
    return 1
  }

  const outline = outlineJson(data)
  if (opts.json === true) {
    emit(JSON.stringify(outline))
  } else {
    emit(formatJsonOutline(outline))
  }
  return 0
}

export interface JsonQueryCliOptions {
  file: string
  path: string
  head?: string
  json?: boolean
}

/** Handle ``token-goat json-query file path``: extract one value or a projected/filtered
 * subset from a JSON document by dot-path spec (`[n]` index, `[*]` wildcard,
 * `[field=value]` filter), instead of a raw Read. */
export function runJsonQuery(opts: JsonQueryCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    emitErr(`Failed to parse JSON: ${opts.file}`)
    return 1
  }

  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }

  try {
    const result = queryJson(data, opts.path)

    if (!result.fanned) {
      const value = result.items[0]
      emit(opts.json === true ? JSON.stringify(value) : JSON.stringify(value, null, 2))
      return 0
    }

    const totalCount = result.items.length
    const limited = head !== undefined ? result.items.slice(0, head) : result.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited)
      emit(JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount }))
    } else {
      const lines = limited.map((item) => JSON.stringify(item))
      if (headTruncated) {
        lines.push(`...(${totalCount - limited.length} more items elided; use --head to see more)`)
      }
      emitGuarded(lines.join('\n'), 'json-query')
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

/** Thin async wrapper: reads the PDF off disk and extracts its text. Kept
 * separate from the synchronous run*(opts): number handlers above because
 * pdfjs-dist's parser is async; the caller (cli.ts's cmdPdfExtract) drives
 * it through guard() (which supports async actions) rather than runExit
 * (sync-only). Throws on error, matching this file's extractPdfText
 * contract, rather than returning an exit code. */
export async function runPdfExtractText(file: string, pagesSpec?: string, layout = false): Promise<string> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  const data = fs.readFileSync(file)
  const result = await extractPdfText(new Uint8Array(data), pagesSpec, layout)
  return result.text
}

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfOutline(file: string): Promise<PdfOutlineEntry[]> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  const data = fs.readFileSync(file)
  return extractPdfOutline(new Uint8Array(data))
}

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfMeta(file: string): Promise<PdfMeta> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  const data = fs.readFileSync(file)
  return extractPdfMeta(new Uint8Array(data))
}

/** Thin async wrapper (same rationale as runPdfExtractText above): drives a real
 * headless browser, so it needs guard()'s async support rather than runExit. */
export async function runScreenshot(
  url: string,
  destPath: string,
  opts: { executablePath?: string; width?: string; height?: string; fullPage?: boolean },
): Promise<string> {
  const screenshotOpts: Parameters<typeof takeScreenshot>[2] = {}
  if (opts.executablePath !== undefined) screenshotOpts.executablePath = opts.executablePath
  if (opts.width !== undefined) screenshotOpts.width = requirePositiveStrictInt('--width', opts.width)
  if (opts.height !== undefined) screenshotOpts.height = requirePositiveStrictInt('--height', opts.height)
  if (opts.fullPage !== undefined) screenshotOpts.fullPage = opts.fullPage
  const result = await takeScreenshot(url, destPath, screenshotOpts)
  return `Saved screenshot to ${result.path} (${result.originalBytes} -> ${result.finalBytes} bytes)`
}

interface BriefOptions {
  spec: string
  limit?: number
  json?: boolean
}

interface BriefResult {
  symbol: SymbolEntry
  callers: CallerEntry[]
  totalCallers: number
  truncated: boolean
  section: SectionResult | null
}

/** Handle ``token-goat brief "file::symbol"``: bundles the symbol body, its resolved
 * callers (enclosing-function-aware, via graph_commands.ts's real caller-resolution logic),
 * and its containing doc section (if the file has heading structure) into one response --
 * cutting the common "understand this function" pattern from 2-3 round-trips to 1. */
export function runBrief(opts: BriefOptions): number {
  // Same reasoning as runRefs/runFind/runTypes: a limit of 0 (or negative) would silently
  // slice the caller list down to zero entries instead of surfacing a clear "you asked for
  // nothing" error, consistent with every other --limit flag in this codebase.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  const resolution = resolveSymbolSpec(opts.spec)
  if (resolution.kind === 'ambiguous') {
    emitErr(formatAmbiguity(resolution.symbol, resolution.file, resolution.candidates))
    return 1
  }
  if (resolution.kind === 'none') {
    emitErr(`Symbol not found: ${opts.spec}`)
    return 1
  }
  const match = resolution.entry

  // resolveCallers(name) with no explicit limit still applies its own internal default cap
  // (500, in graph_commands.ts's queryRefs call) -- so callers.length is NOT the true count
  // once more than 500 references exist, despite what an earlier version of this comment
  // claimed. Get the real uncapped total via a separate COUNT(*) query (queryRefCounts,
  // batched GROUP BY, no LIMIT) instead of trusting the capped list's length.
  const callers = resolveCallers(match.name, undefined, match.filePath)
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const totalCallers = queryRefCounts([match.name], globalDbPath(), rootDir).get(match.name) ?? callers.length
  const section = findContainingSection(match.filePath, match.lineStart, match.lineEnd)
  const limit = opts.limit ?? 20
  const shown = callers.slice(0, limit)
  const truncated = totalCallers > shown.length

  if (opts.json === true) {
    const result: BriefResult = {
      symbol: match,
      callers: shown,
      totalCallers,
      truncated,
      section,
    }
    emit(JSON.stringify(result, null, 2))
    return 0
  }

  const body = resolveBody(match)
  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    `# ${match.name}  ${match.kind}  ${match.filePath}:${match.lineStart}-${match.lineEnd}`,
    `# ${bodyLen} lines (~${Math.ceil(body.length / 4)} tok)`,
    body,
    '',
  ]

  lines.push(`Callers (${totalCallers}):`)
  for (const c of shown) {
    lines.push(`  ${c.caller}\t${c.file}:${c.line}`)
  }
  if (truncated) {
    lines.push(`  ...(${totalCallers - shown.length} more elided)`)
  }

  if (section !== null) {
    lines.push('')
    lines.push(`Section: ${section.heading} (lines ${section.lineStart}-${section.lineEnd})`)
  }

  emitGuarded(trimBlankLines(lines).join('\n'), 'symbol')
  return 0
}

// ---- find -------------------------------------------------------------------

export interface FindOptions {
  pattern: string
  json?: boolean
  limit?: number
}

/** Handle ``token-goat find <pattern>``. */
export function runFind(opts: FindOptions): number {
  // A limit of 0 (or negative) would make the `.slice(0, opts.limit)` below always return zero
  // files regardless of whether any match -- silently reporting "no indexed files match" for a
  // pattern that's actually indexed. Reject it explicitly instead of slicing with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  // "find <pattern>" — the command's own help text promises pattern-style matching, not an
  // exact name lookup, so scan the index and match by case-insensitive substring.
  const patternLower = opts.pattern.toLowerCase()
  const rawSymbols = querySymbols({ limit: FIND_SCAN_LIMIT, rootDir: resolveProjectRoot({ project: process.cwd() }) })
  const symbols = rawSymbols.filter((s) =>
    s.name.toLowerCase().includes(patternLower),
  )
  const files = [...new Set(symbols.map((s) => s.filePath))].slice(0, opts.limit ?? 50)
  const truncated = rawSymbols.length === FIND_SCAN_LIMIT

  if (files.length === 0) {
    emitErr(`No indexed files match '${opts.pattern}'`)
    return 1
  }

  if (opts.json === true) {
    emit(JSON.stringify({ files, truncated }, null, 2))
    return 0
  }

  for (const f of files) {
    emit(f)
  }

  if (truncated) {
    emitErr(`Results may be incomplete; index scan hit limit of ${FIND_SCAN_LIMIT} symbols`)
  }

  return 0
}

// ---- section listing --------------------------------------------------------

export interface ListSectionsOptions {
  file: string
  json?: boolean
}

/** Handle ``token-goat section --list file``. */
export function runListSections(opts: ListSectionsOptions): number {
  const sections = listSections(opts.file)

  if (sections.length === 0) {
    emitErr(`No sections found in '${opts.file}'`)
    return 1
  }

  if (opts.json === true) {
    const capped = guardJsonRows(sections)
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
    return 0
  }

  for (const s of sections) {
    emit(s)
  }
  return 0
}

// ---- changed ----------------------------------------------------------------

export interface ChangedOptions {
  ref?: string
  symbolMode?: boolean
  json?: boolean
  projectRoot?: string
}

/**
 * Parse a `git diff --unified=0` (or wider-context) unified diff into a map of file path
 * (matching the relative-path convention of `git diff --name-only`, taken from each hunk's
 * `+++ b/<path>` header) to the changed line ranges on the new/current side of the diff.
 *
 * A pure-deletion hunk (new-side count of 0) has no new-side lines to report; it is anchored
 * to its single insertion point instead, so a symbol sitting at that point still counts as touched.
 */
export function parseDiffHunks(diffText: string): Map<string, Array<{ start: number; end: number }>> {
  const hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
  let currentFile: string | null = null
  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileMatch) {
      currentFile = fileMatch[1] ?? null
      continue
    }
    // Handle deleted files: +++ /dev/null resets currentFile
    if (line === '+++ /dev/null') {
      currentFile = null
      continue
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch !== null && currentFile !== null) {
      const newStart = parseInt(hunkMatch[1]!, 10)
      const newLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1
      const range =
        newLines === 0
          ? { start: Math.max(newStart, 1), end: Math.max(newStart, 1) }
          : { start: newStart, end: newStart + newLines - 1 }
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

/** Handle ``token-goat changed`` (plain file list, or `--symbol` for changed symbols). */
export function runChanged(opts: ChangedOptions = {}): number {
  const ref = opts.ref ?? 'HEAD~5'
  const cwd = opts.projectRoot ?? process.cwd()
  // `git diff --name-only` always reports paths relative to the repo top-level, regardless
  // of which directory git was invoked from. Resolving those paths against `cwd` (which may
  // be a subdirectory when this command is invoked from e.g. `src/`) doubles the subdirectory
  // segment and never matches the index. `resolveProjectRoot` resolves the actual top-level
  // (via `rev-parse --show-toplevel`, falling back to `findProject`/`cwd`) starting from `cwd`
  // as its base, and that is what `resolveIndexPath` below is anchored to; `cwd` is still fine
  // to pass to `runGit` since git resolves the repo from any subdirectory on its own.
  const projectRoot = resolveProjectRoot({ project: cwd })

  let changedFiles: string[]
  try {
    const result = runGit(['diff', ref, '--name-only'], { cwd })
    if (result.exitCode !== 0) {
      emitErr(`git diff failed: ${result.stderr}`)
      return 1
    }
    changedFiles = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  } catch {
    emitErr(`Could not run git diff against '${ref}'`)
    return 1
  }

  if (changedFiles.length === 0) {
    emit('No files changed.')
    return 0
  }

  if (opts.symbolMode === true) {
    // Scope to symbols whose own line range overlaps a changed diff hunk, not every
    // symbol in any file that has any changed line — a one-line edit in a large file
    // shouldn't report the whole file as "changed" at symbol granularity.
    let hunksByFile = new Map<string, Array<{ start: number; end: number }>>()
    try {
      const diffResult = runGit(['diff', ref, '--unified=0'], { cwd })
      if (diffResult.exitCode === 0) {
        hunksByFile = parseDiffHunks(diffResult.stdout)
      }
    } catch {
      // Hunk-level diff unavailable — fall back to file-level scoping below.
    }

    const allSymbols: SymbolEntry[] = []
    for (const f of changedFiles) {
      const fileSymbols = querySymbols({ filePath: resolveIndexPath(f, projectRoot), limit: 1000 })
      const hunks = hunksByFile.get(f)
      // No hunks parsed for this file (rename, binary, or the diff call failed) —
      // fall back to every symbol in the file rather than silently dropping it.
      const scoped =
        hunks === undefined
          ? fileSymbols
          : fileSymbols.filter((s) => hunks.some((h) => h.start <= s.lineEnd && h.end >= s.lineStart))
      allSymbols.push(...scoped)
    }
    if (allSymbols.length === 0) {
      emit('No symbols changed.')
      return 0
    }
    if (opts.json === true) {
      const capped = guardJsonRows(allSymbols)
      emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
      return 0
    }
    for (const s of allSymbols) {
      emit(`${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}`)
    }
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(changedFiles)
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
    return 0
  }
  for (const f of changedFiles) {
    emit(f)
  }
  return 0
}

// ---- diff -------------------------------------------------------------------

export interface DiffOptions {
  spec: string
  ref?: string
  json?: boolean
  projectRoot?: string
}

/**
 * Split a single-file unified diff into its preamble (the `diff --git` / `index` / `---` /
 * `+++` header lines) and its individual `@@` hunks, each carrying both its raw text (for
 * verbatim reprinting) and its new-side line range. Range math mirrors `parseDiffHunks`
 * exactly (a pure-deletion hunk with a new-side count of 0 anchors to its single insertion
 * point) -- this just additionally keeps the hunk body text, which `parseDiffHunks` discards.
 */
function splitDiffHunks(diffText: string): {
  preamble: string
  hunks: Array<{ text: string; start: number; end: number }>
} {
  const lines = diffText.split(/\r?\n/)
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
  let preambleEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (hunkHeaderRe.test(lines[i]!)) {
      preambleEnd = i
      break
    }
  }
  const preamble = lines.slice(0, preambleEnd).join('\n')
  const hunks: Array<{ text: string; start: number; end: number }> = []
  let i = preambleEnd
  while (i < lines.length) {
    const line = lines[i]!
    const m = hunkHeaderRe.exec(line)
    if (m === null) {
      i++
      continue
    }
    const newStart = parseInt(m[1]!, 10)
    const newLines = m[2] !== undefined ? parseInt(m[2], 10) : 1
    const range =
      newLines === 0
        ? { start: Math.max(newStart, 1), end: Math.max(newStart, 1) }
        : { start: newStart, end: newStart + newLines - 1 }
    const bodyLines = [line]
    let j = i + 1
    while (j < lines.length && !hunkHeaderRe.test(lines[j]!)) {
      bodyLines.push(lines[j]!)
      j++
    }
    // A trailing newline in the source diff leaves one phantom empty element at the very end
    // of the final hunk's body after the `split` above -- drop it so it doesn't get reprinted
    // as a stray blank line.
    if (j >= lines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
    hunks.push({ text: bodyLines.join('\n'), start: range.start, end: range.end })
    i = j
  }
  return { preamble, hunks }
}

/**
 * Handle ``token-goat diff "file::symbol" [refA..refB]`` -- show only the git diff hunk(s)
 * whose new-side line range overlaps one symbol's indexed line range, instead of the whole
 * file's diff. Resolves the spec exactly like `runRead` (same ambiguous/none error shapes,
 * via `resolveSymbolSpec`), then scopes `git diff [ref] -- <file>` down to the overlapping
 * hunks via `splitDiffHunks`. No ref given -> plain `git diff -- file` (unstaged working tree
 * vs the index), the same bare-`git diff` default `resume.ts` already uses for its own
 * "uncommitted changes" summary -- there is no existing "vs HEAD~N" precedent for a single
 * current-state diff view the way there is for `changed`'s historical file/symbol listing.
 */
export function runDiff(opts: DiffOptions): number {
  const { file, symbol } = parseReadSpec(opts.spec)
  if (symbol === undefined || symbol === '') {
    emitErr(`'token-goat diff' requires a 'file::symbol' spec (got '${opts.spec}')`)
    return 1
  }

  const resolution = resolveSymbolSpec(opts.spec, undefined, opts.projectRoot)

  if (resolution.kind === 'ambiguous') {
    // Same hard-refuse shape as runRead's ambiguous branch -- never guess which candidate the
    // caller meant.
    emitErr(formatAmbiguity(resolution.symbol, resolution.file, resolution.candidates))
    return 1
  }

  if (resolution.kind === 'none') {
    // Same "not found" + did-you-mean shape as runRead's none branch.
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
    const closes = querySymbols({ filePath: resolved, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
    if (closes.length > 0) messages.push(didYouMean(closes))
    emitErr(messages.join('\n'))
    return 1
  }

  const match = resolution.entry
  const cwd = opts.projectRoot ?? process.cwd()

  // `--unified=0` (no surrounding context lines), same as runChanged's own symbolMode
  // hunk-scoping above: a hunk's line range must precisely bound only the lines that actually
  // changed, or a default-context hunk from an adjacent, unrelated symbol could spuriously
  // overlap this symbol's range just because the two sit close together in the file.
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
    emit(`No changes to '${match.name}' in '${match.filePath}'.`)
    return 0
  }

  const { hunks } = splitDiffHunks(diffResult.stdout)
  const overlapping = hunks.filter((h) => h.start <= match.lineEnd && h.end >= match.lineStart)

  if (overlapping.length === 0) {
    emit(`No changes to '${match.name}' (lines ${match.lineStart}-${match.lineEnd}) in '${match.filePath}'.`)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(overlapping.map((h) => ({ start: h.start, end: h.end, text: h.text })))
    emit(
      JSON.stringify(
        {
          symbol: match.name,
          file: match.filePath,
          lineStart: match.lineStart,
          lineEnd: match.lineEnd,
          hunks: capped.items,
          truncated: capped.truncated,
          totalCount: capped.totalCount,
        },
        null,
        2,
      ),
    )
    return 0
  }

  const header = `# ${match.name} (${match.kind}) — ${match.filePath}:${match.lineStart}-${match.lineEnd}`
  emit(guardText([header, ...overlapping.map((h) => h.text)].join('\n'), 'diff'))
  return 0
}

// ---- grep -------------------------------------------------------------------

export interface GrepOptions {
  pattern: string
  path?: string | string[]
  maxLines?: number
  json?: boolean
  recursive?: boolean
  context?: number
}

interface GrepHit {
  file: string
  line: number
  text: string
  context?: Array<{ line: number; text: string }>
}

/** Handle ``token-goat grep <pattern>``. */
export function runGrep(opts: GrepOptions): number {
  const searchPaths = opts.path === undefined ? [process.cwd()] : Array.isArray(opts.path) ? opts.path : [opts.path]
  const maxLines = opts.maxLines ?? GREP_MAX_LINES
  const contextLines = opts.context ?? 0

  let regex: RegExp
  try {
    regex = new RegExp(opts.pattern)
  } catch {
    emitErr(`Invalid regex: ${opts.pattern}`)
    return 1
  }

  const hits: GrepHit[] = []

  function searchFile(filePath: string): void {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      const lines = text.split(/\r?\n/)
      lines.forEach((lineText, idx) => {
        if (regex.test(lineText)) {
          const hit: GrepHit = { file: filePath, line: idx + 1, text: lineText }
          if (contextLines > 0) {
            const start = Math.max(0, idx - contextLines)
            const end = Math.min(lines.length - 1, idx + contextLines)
            hit.context = []
            for (let i = start; i <= end; i++) {
              hit.context.push({ line: i + 1, text: lines[i] ?? '' })
            }
          }
          hits.push(hit)
        }
      })
    } catch {
      // skip unreadable files
    }
  }

  function searchDir(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const full = path.join(dir, entry)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue
          if (opts.recursive !== false) searchDir(full)
        } else {
          searchFile(full)
        }
      }
    } catch {
      // skip
    }
  }

  for (const searchPath of searchPaths) {
    if (!fileExists(searchPath)) {
      emitErr(`Path not found: ${searchPath}`)
      return 1
    }

    const stat = fs.statSync(searchPath)
    if (stat.isDirectory()) {
      searchDir(searchPath)
    } else {
      searchFile(searchPath)
    }
  }

  if (hits.length === 0) {
    emitErr(`No matches for '${opts.pattern}'`)
    return 1
  }

  const truncated = hits.slice(0, maxLines)

  if (opts.json === true) {
    emit(JSON.stringify(truncated, null, 2))
    return 0
  }

  for (const hit of truncated) {
    if (hit.context !== undefined) {
      for (const ctxLine of hit.context) {
        if (ctxLine.line === hit.line) {
          emit(`${hit.file}:${ctxLine.line}: ${ctxLine.text}`)
        } else {
          emit(`${hit.file}-${ctxLine.line}- ${ctxLine.text}`)
        }
      }
    } else {
      emit(`${hit.file}:${hit.line}: ${hit.text}`)
    }
  }

  if (hits.length > maxLines) {
    emitErr(`... (${hits.length - maxLines} more lines omitted)`)
  }

  return 0
}

// ---- config-get -------------------------------------------------------------

export interface ConfigGetOptions {
  file: string
  key: string
}

// Splits off a trailing inline comment (# or ;) from a TOML/INI value, but only when the
// marker occurs outside a quoted region -- so `"value # not a comment"` keeps its full
// quoted content, while `value # real comment` (unquoted) gets truncated at the marker.
// This mirrors the intent of the section-header comment stripping above, but is quote-aware
// so it doesn't corrupt quoted values that legitimately contain '#' or ';'.
function stripInlineComment(s: string): string {
  let inQuote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuote !== null) {
      // A backslash escapes the next character while inside a quoted region, same as
      // ini_idx.ts's _isEscapedQuote and common.ts's isInsideStringLiteral -- without this,
      // an escaped quote (e.g. `"a\"b"`) is misread as the real closing quote, and the
      // following literal quote reopens a new (unterminated) region, so any '#'/';' later
      // on the line is wrongly treated as still inside quotes and never stripped.
      if (ch === '\\' && i + 1 < s.length) {
        i++
        continue
      }
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '#' || ch === ';') {
      return s.slice(0, i)
    }
  }
  return s
}

// Strips a leading+trailing quote pair from a value only when both ends are present and
// match the same quote character -- e.g. `"value"` -> `value`, but `O'Brien's` (a legitimate
// trailing apostrophe with no matching leading quote) and `"foo'` (mismatched quote
// characters) are both left untouched, since stripping either end independently would
// silently corrupt the value.
function stripPairedQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return s.slice(1, -1)
    }
  }
  return s
}

/**
 * Resolve a scalar value at a dotted path in a YAML document, line-based (no YAML
 * library). Handles flat keys, indentation-nested keys at any consistent indent
 * width, quoted values, and values containing a colon; skips comment and blank
 * lines. Does not handle lists, multi-line/block scalars, flow mappings, inline
 * comments after a value, or a literal dotted key.
 */
function lookupYaml(lines: readonly string[], key: string): string | null {
  const parts = key.split('.')
  let depth = 0
  let parentIndent = -1
  let childIndent = -1
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (depth > 0 && indent <= parentIndent) return null
    if (childIndent !== -1 && indent !== childIndent) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    if (childIndent === -1) childIndent = indent
    const k = trimmed.slice(0, colon).trim()
    if (k !== parts[depth]) continue
    if (depth === parts.length - 1) {
      // Same paired-quote-stripping logic as the TOML/INI path below: YAML's own quoting
      // rules (doubled-quote escapes, flow scalars, etc.) are already out of scope per this
      // function's doc comment, but the independent-single-end stripping this replaced had
      // the identical bug -- e.g. `name: O'Brien's` lost its trailing apostrophe. Paired
      // stripping is strictly safer (it only strips when both ends match), so unifying the
      // fix here cannot regress any previously-correct case.
      return stripPairedQuotes(trimmed.slice(colon + 1).trim())
    }
    parentIndent = indent
    childIndent = -1
    depth++
  }
  return null
}

// Extracts the lines strictly between a YAML frontmatter fence pair (a `---` line as the
// literal first line, followed later by a matching closing `---` line), so callers can run
// a plain YAML key lookup against just that block regardless of the file's extension. Fence
// detection mirrors doc_compact.ts's buildExtractiveCompact: if no closing fence is found,
// return null (treat as "no frontmatter") instead of guessing -- the same choice
// buildExtractiveCompact makes, where an unclosed fence leaves the whole document to be
// processed as normal content rather than silently discarding it as malformed/truncated
// frontmatter.
function extractFrontmatter(lines: readonly string[]): string[] | null {
  if (lines[0]?.trim() !== '---') return null
  let j = 1
  while (j < lines.length && lines[j]?.trim() !== '---') {
    j++
  }
  if (j >= lines.length) return null
  return lines.slice(1, j)
}

/** Handle ``token-goat config-get file key``. */
export function runConfigGet(opts: ConfigGetOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  // YAML frontmatter takes priority over extension-based dispatch: a `.md` file with a
  // `---`-delimited frontmatter block should resolve keys from that block even though its
  // extension would otherwise route to the TOML/INI fallback below. A `.md` file with no
  // frontmatter falls through unchanged to the existing extension-based dispatch.
  const frontmatterLines = extractFrontmatter(text.split(/\r?\n/))
  if (frontmatterLines !== null) {
    const value = lookupYaml(frontmatterLines, opts.key)
    if (value === null) {
      emitErr(`Key '${opts.key}' not found in ${opts.file}`)
      return 1
    }
    emit(value)
    return 0
  }

  const ext = path.extname(opts.file).toLowerCase()

  if (ext === '.json') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = JSON.parse(text)
      for (const part of opts.key.split('.')) {
        if (typeof obj !== 'object' || obj === null) {
          emitErr(`Key '${opts.key}' not found in ${opts.file}`)
          return 1
        }
        obj = obj[part]
        if (obj === undefined) {
          emitErr(`Key '${opts.key}' not found in ${opts.file}`)
          return 1
        }
      }
      emit(JSON.stringify(obj))
      return 0
    } catch {
      emitErr(`Failed to parse JSON: ${opts.file}`)
      return 1
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    const value = lookupYaml(text.split(/\r?\n/), opts.key)
    if (value === null) {
      emitErr(`Key '${opts.key}' not found in ${opts.file}`)
      return 1
    }
    emit(value)
    return 0
  }

  // For TOML/INI: section-aware line-based extraction Split the key into section path and leaf key: "tool.ruff.line-length" -> ["tool.ruff"] + "line-length"
  const keyParts = opts.key.split('.')
  const leafKey = keyParts.at(-1) ?? opts.key
  const sectionPath = keyParts.length > 1 ? keyParts.slice(0, -1).join('.') : null
  const lines = text.split('\n')

  // Build the expected section header(s) for TOML-style [section] or [section.subsection] For a key like "tool.ruff.line-length", look for [tool.ruff] or [tool] followed by [ruff]
  let currentSection = ''
  for (const line of lines) {
    const trimmed = line.trim()

    // Check for section header like [tool.ruff] or [tool.ruff] # comment. A naive
    // trimmed.split(/[#;]/)[0] truncation would also cut a section name that legitimately
    // contains '#' or ';' (both are legal in INI/TOML section names -- see ini_idx.ts's own
    // HEADER_RE), silently dropping the header and making every key nested under it
    // unreachable. Matching this same header regex directly against the untouched line only
    // treats a trailing '#'/';' as a comment when it follows the closing ']'.
    const headerMatch = /^\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/.exec(trimmed)
    if (headerMatch) {
      currentSection = (headerMatch[1] ?? '').trim()
      continue
    }

    // Check we're in the right section. A section-qualified key ("tool.ruff.line-length")
    // must match that exact section. A bare key (no dots) must be genuinely top-level --
    // i.e. appear before any [section] header -- not merely present somewhere inside an
    // unrelated section that happens to declare a same-named key.
    if (currentSection !== (sectionPath ?? '')) {
      continue
    }

    // Look for the leaf key in a key=value line. Allow any amount of whitespace
    // (spaces or tabs) between the key and '=' to support aligned-key formatting
    // (e.g. tox.ini/setup.cfg). leafKey is user-supplied, so escape it before
    // embedding in a RegExp. `\s*` (not `\s+`) preserves the zero-space case.
    if (new RegExp(`^${escapeRegExp(leafKey)}\\s*=`).test(trimmed)) {
      const eqIdx = trimmed.indexOf('=')
      const rawValue = stripInlineComment(trimmed.slice(eqIdx + 1)).trim()
      emit(stripPairedQuotes(rawValue))
      return 0
    }
  }

  emitErr(`Key '${opts.key}' not found in ${opts.file}`)
  return 1
}

// ---- exports/imports --------------------------------------------------------

export interface ImportsExportsOptions {
  file: string
  json?: boolean
}

/**
 * Extract exported symbol names from source text. The tree-sitter indexer
 * stores a symbol's body starting at the inner declaration (e.g. `function`),
 * not the `export` modifier on its parent statement, so a body-prefix heuristic
 * misses real exports — this scans the source so `exports` is functional for the
 * flagship TS/JS case as well as Python, Rust, and Java.
 */
export function extractExportNames(text: string, ext: string): string[] {
  const names: string[] = []
  const push = (s: string | undefined): void => {
    let v = (s ?? '').trim()
    if (v.includes(' as ')) v = v.split(/\s+as\s+/).pop()?.trim() ?? v
    if (v !== '' && v !== 'default' && !names.includes(v)) names.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    const declRe = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
    const defaultRe = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/g
    const namedRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = declRe.exec(text)) !== null) push(m[1])
    while ((m = defaultRe.exec(text)) !== null) push(m[1])
    while ((m = namedRe.exec(text)) !== null) {
      for (const part of (m[1] ?? '').split(',')) push(part)
    }
  } else if (e === '.py') {
    for (const line of lines) {
      const m = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line)
      if (m && !(m[1] ?? '').startsWith('_')) push(m[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const m = /^\s*pub(?:\s*\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|mod|static)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /\bpublic\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/.exec(line)
      if (m) push(m[1])
    }
  }
  return names
}

/** Handle ``token-goat exports file``. */
export function runExports(opts: ImportsExportsOptions): number {
  const symbols = querySymbols({ filePath: resolveIndexPath(opts.file), limit: 500 })
  const kindOf = (name: string): string => symbols.find((s) => s.name === name)?.kind ?? 'export'

  // Index-side heuristic: catches languages whose stored body keeps the `export`/`pub`/`public` modifier, and the mocked unit tests.
  const names: string[] = []
  for (const s of symbols) {
    if (/^(?:export|pub\b|public\b)/.test(s.body.trimStart()) && !names.includes(s.name)) {
      names.push(s.name)
    }
  }
  const ext = path.extname(opts.file).toLowerCase()
  // Source scan: catches tree-sitter languages whose body omits the modifier.
  const text = readFileText(opts.file)
  if (text !== null) {
    if (ext === '.go') {
      for (const s of symbols) if (/^[A-Z]/.test(s.name) && !names.includes(s.name)) names.push(s.name)
    }
    for (const n of extractExportNames(text, ext)) if (!names.includes(n)) names.push(n)
  }

  if (names.length === 0) {
    emit(`No exported symbols found in '${opts.file}'`)
    return 0
  }

  const fullSourceBytes = sumFileSizes([opts.file])

  if (opts.json === true) {
    const jsonText = JSON.stringify(names.map((n) => ({ name: n, kind: kindOf(n) })), null, 2)
    emit(jsonText)
    recordReadStat('exports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = names.map((n) => `${kindOf(n).padEnd(10)} ${n}`)
  for (const line of outLines) {
    emit(line)
  }
  recordReadStat('exports', fullSourceBytes, outLines.join('\n'), opts.file)
  return 0
}

/**
 * Extract import/include module specifiers from source text, covering the
 * bundled tree-sitter languages plus a few common extras. Returns one entry per
 * import in source order, de-duplicated. This is deliberately index-independent:
 * the symbol index does not store import statements as rows for the tree-sitter
 * languages, so a query-only `imports` returned nothing for TS/JS/Python/etc.
 */
export function extractImports(text: string, ext: string): string[] {
  const found: string[] = []
  const push = (s: string | undefined): void => {
    const v = (s ?? '').trim()
    if (v !== '' && !found.includes(v)) found.push(v)
  }
  const e = ext.toLowerCase()
  const lines = text.split(/\r?\n/)

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(e)) {
    // Match against the whole file text (not per-line) so multi-line/Prettier-style
    // import statements (import spanning several lines before `from '...'`) are still
    // found -- mirrors extractExportNames's whole-text approach below.
    const fromRe = /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g
    const bareRe = /^\s*import\s*['"]([^'"]+)['"]/gm
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const matches: Array<{ index: number; value: string }> = []
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = bareRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = reqRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    while ((m = dynRe.exec(text)) !== null) matches.push({ index: m.index, value: m[1] ?? '' })
    matches.sort((a, b) => a.index - b.index)
    for (const match of matches) push(match.value)
  } else if (e === '.py') {
    for (const line of lines) {
      const from = /^\s*from\s+([.\w]+)\s+import\b/.exec(line)
      if (from) { push(from[1]); continue }
      const imp = /^\s*import\s+(.+)$/.exec(line)
      if (imp) for (const part of (imp[1] ?? '').split(',')) push(part.trim().split(/\s+as\s+/)[0])
    }
  } else if (e === '.go') {
    let inBlock = false
    for (const line of lines) {
      if (/^\s*import\s*\(/.test(line)) { inBlock = true; continue }
      if (inBlock) {
        if (/^\s*\)/.test(line)) { inBlock = false; continue }
        const m = /['"]([^'"]+)['"]/.exec(line)
        if (m) push(m[1])
        continue
      }
      const single = /^\s*import\s+(?:[\w.]+\s+)?['"]([^'"]+)['"]/.exec(line)
      if (single) push(single[1])
    }
  } else if (e === '.rs') {
    for (const line of lines) {
      const m = /^\s*(?:pub\s+)?use\s+([^;{]+)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.rb') {
    for (const line of lines) {
      const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(line)
      if (m) push(m[1])
    }
  } else {
    for (const line of lines) {
      const m = /(?:import|require|use|#include)\s+['"<]?([^'">;]+)/.exec(line)
      if (m) push(m[1])
    }
  }
  return found
}

/** Handle ``token-goat imports file``. */
export function runImports(opts: ImportsExportsOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  const imports = extractImports(text, path.extname(opts.file))

  if (imports.length === 0) {
    emit(`No imports found in '${opts.file}'`)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(imports)
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
    return 0
  }

  for (const imp of imports) {
    emit(`import  ${imp}`)
  }
  return 0
}

// ---- re-export underlying layers -------------------------------------------

export type { SymbolEntry, RefEntry }
/**
 * Collect assistant text in order from a Claude Code / subagent JSONL transcript.
 *
 * Each line is one JSON record; keep `type:"assistant"` records and pull their
 * `message.content[]` text blocks (or a plain-string `content`), joined in order.
 * Malformed lines, non-assistant records, and non-text blocks (thinking, tool_use,
 * tool_result) are skipped. Returns the joined text, or '' when nothing matches,
 * which keeps `--transcript` harmless on a file that is not a transcript.
 */
export function extractTranscriptText(jsonl: string): string {
  const collected: string[] = []
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof obj !== 'object' || obj === null) continue
    const rec = obj as Record<string, unknown>
    if (rec['type'] !== 'assistant') continue
    const msg = rec['message']
    if (typeof msg !== 'object' || msg === null) continue
    const content = (msg as Record<string, unknown>)['content']
    if (typeof content === 'string') {
      if (content.length > 0) collected.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].length > 0) {
        collected.push(b['text'])
      }
    }
  }
  return collected.join('\n')
}

/** First `n` lines of a body, for the semantic-search preview. */
function previewLines(body: string, n: number): string {
  return body.split(/\r?\n/).slice(0, n).join('\n')
}

/** `name (kind) — file:start-end` header line for a symbol. */
function symbolHeader(s: SymbolEntry): string {
  return `# ${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}-${s.lineEnd}`
}

interface SemanticOptions {
  limit?: number
  /**
   * Project root to scope the search to. Defaults to `process.cwd()`; same field name as
   * {@link ChangedOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g. an
   * MCP server launched by a client from an opaque directory) should pass the actual
   * workspace root explicitly -- otherwise the search silently scopes to the wrong project
   * (or the whole machine-wide index yields nothing under it).
   */
  projectRoot?: string
}

// Ported from cli.ts's cmdSemantic, which used to throw a CliError (caught by the generic
// `guard` wrapper, which prefixes it with "token-goat: " before printing to stderr) on a
// no-matches miss instead of returning a code. The "token-goat: " prefix is baked into the
// returned text here so the CLI's output stays byte-identical to that historical path.
async function runSemantic(query: string, opts: SemanticOptions): Promise<{ text: string; code: number }> {
  // Same reasoning as runSymbol above: a limit of 0 (or negative) would silently query for
  // zero results instead of surfacing a clear "you asked for nothing" error.
  if (opts.limit !== undefined && opts.limit <= 0) {
    return { text: `--limit must be a positive number, got: ${opts.limit}`, code: 1 }
  }

  const n = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : 20

  // A caller-supplied projectRoot must be an absolute, existing directory -- otherwise
  // searchSemantic silently finds nothing under the bogus root and this function falls back to
  // the (now project-scoped) FTS search using that same bogus root, which also finds nothing,
  // and the caller gets a plain "no matches" instead of a clear signal that the scope they asked
  // for doesn't exist. Fail loudly instead of silently widening/losing scope.
  if (opts.projectRoot !== undefined) {
    if (!path.isAbsolute(opts.projectRoot) || !fs.existsSync(opts.projectRoot) || !fs.statSync(opts.projectRoot).isDirectory()) {
      return {
        text: `token-goat: projectRoot must be an absolute, existing directory, got '${opts.projectRoot}'`,
        code: 1,
      }
    }
  }
  const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })

  // Real embedding-vector similarity search first: chunks/chunk_vectors are populated during
  // indexing whenever indexing.embeddings_enabled is on and the optional @xenova/transformers
  // and sqlite-vec dependencies are present. searchSemantic degrades to an empty array rather
  // than throwing when either is unavailable or nothing has been embedded yet, so this is
  // always safe to try before falling back to keyword search.
  //
  // Over-fetch a larger candidate set (same ratio searchSemantic already uses internally for its
  // own ANN over-fetch) so mergeNearbyHits has headroom to consolidate nearby/overlapping hits
  // in the SAME file before truncation, instead of merging an already-capped set of `n` raw
  // hits — which can silently drop a hit that would have merged, or shrink the result below `n`.
  const overFetchForMerge = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  const rawHits = await searchSemantic(
    getDb(globalDbPath()),
    query,
    overFetchForMerge,
    undefined,
    undefined,
    rootDir,
  )
  const hits = mergeNearbyHits(rawHits).slice(0, n)
  if (hits.length > 0) {
    const blocks = hits.map(
      (h) => `# ${h.filePath}:${h.startLine}-${h.endLine} (distance ${h.distance.toFixed(3)})\n${previewLines(h.text, 3)}`,
    )
    const text = guardText(blocks.join('\n\n'), 'semantic')
    recordReadStat('semantic_search', sumFileSizes(hits.map((h) => h.filePath)), text, query)
    return { text, code: 0 }
  }

  // Fall back to full-text search over symbol names/bodies: no semantic index yet (never
  // indexed with embeddings enabled, or the optional deps are absent), or no hit cleared the
  // distance threshold.
  const results = searchSymbolsFts(query, n, undefined, rootDir)
  if (results.length === 0) {
    return { text: `token-goat: no matches for '${query}'`, code: 1 }
  }
  const blocks = results.map((s) => `${symbolHeader(s)}\n${previewLines(s.body, 3)}`)
  const text = guardText(blocks.join('\n\n'), 'semantic')
  recordReadStat('semantic_search', sumFileSizes(results.map((s) => s.filePath)), text, query)
  return { text, code: 0 }
}

export { querySymbols, queryRefs, readSection, listSections, extractSection, runSemantic }
