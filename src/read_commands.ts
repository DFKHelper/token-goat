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
import { SKIP_DIRS, walkProject } from './baseline.js'
import { querySymbols, queryRefs, queryRefCounts, searchSymbolsFts, getFileEntry, countSymbols, countRefs } from './index_reader.js'
import { resolveIndexPath } from './paths.js'
import { indexFileSync } from './parser.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
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
import { loadAll as loadAllYaml } from 'js-yaml'
import { parseOpenApiSpec, extractOperations, formatOpenApiOutline, findOperation, formatOperationDetail, operationLabel } from './openapi_query.js'
import { listZipEntries, extractZipEntry, formatZipList } from './archive_query.js'
import {
  isGhAvailable,
  isGhAuthenticated,
  parseGithubRepoFromRemoteUrl,
  parsePrSliceArg,
  fetchPrFiles,
  fetchPrDiff,
  fetchPrComments,
  fetchPrDescription,
  extractFileDiff,
  formatFilesSlice,
  formatCommentsSlice,
  formatDescriptionSlice,
} from './pr_slice.js'
import { getSqliteSchema, formatSqliteSchema, runReadOnlySqliteQuery, formatSqliteQueryTable } from './sqlite_query.js'
import { parseCoverageReport, filterCoverageGapsByFile, formatCoverageGaps } from './coverage_query.js'
import { parseConflicts, summarizeFileConflicts, formatConflicts, formatConflictSummaries } from './conflict_query.js'
import { extractPdfMeta, extractPdfOutline, extractPdfText, type PdfMeta, type PdfOutlineEntry } from './pdf_extract.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat } from './stats.js'
import { WHOLE_FILE_NOTE_SYMBOL, getNote, isNoteStale, listNotes } from './notes.js'
import { isTsPath, resolveTypedRefs } from './ts_refs.js'

// ---- constants --------------------------------------------------------------

const DIDYOUMEAN_LIMIT = 5
const MIN_REVERSE_MATCH_LEN = 3 // reverse ("query contains symbol") containment only -- below this, short indexed names like `b`/`n` match nearly any query
const GREP_MAX_LINES = 200
// Symbol rows scanned when matching `find <pattern>` by substring — large enough to cover
// this tool's own index (thousands of symbols) without paging.
const FIND_SCAN_LIMIT = 20_000
// `refs --top` exists specifically for high-fanout symbols (hundreds+ of references) and
// aggregates by file before truncating, so it must scan far more rows than the default
// per-line `refs` cap (100, sized for "read these individually"). queryRefs orders rows by
// file_path then line -- an alphabetical, not count-based, ordering -- so applying the
// default 100-row cap ahead of the by-file grouping silently drops every ref in
// alphabetically-later files (regardless of how many refs they actually hold) before the
// count comparison ever happens, producing a "top files by reference count" that is really
// just "top files among whichever ones sort first alphabetically". Large enough to cover any
// realistic single-symbol fanout in this codebase without paging.
const REFS_TOP_SCAN_LIMIT = 20_000

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

/** Raw-bytes counterpart to {@link readFileText}, for binary formats (zip-format archives)
 * that must never be decoded as UTF-8 before parsing -- decoding first would corrupt any byte
 * sequence that isn't valid UTF-8, which is the common case for compressed/binary member data. */
function readFileBytes(p: string): Buffer | null {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
}

/** True when re-encoding `buf`'s lossy UTF-8 decode reproduces the exact original bytes --
 * i.e. `buf` is valid UTF-8 text, not binary data that merely decodes without throwing (Node's
 * UTF-8 decoder never throws; it substitutes U+FFFD for invalid sequences instead). */
function isValidUtf8(buf: Buffer): boolean {
  return Buffer.compare(Buffer.from(buf.toString('utf-8'), 'utf-8'), buf) === 0
}

/**
 * Symbols indexed with an empty stored `body` (e.g. HTML/Liquid heading symbols produced by
 * `sectionsToHeadingSymbols`, which store `body: ''`) need their content re-read from disk by
 * line range instead of rendering blank. Shared by runSymbol, runRead, and runBrief so all
 * three read surfaces resolve empty-body symbols the same way.
 */
export function resolveBody(entry: { body: string; filePath: string; lineStart: number; lineEnd: number }): string {
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
export function healStaleIndex(resolvedPath: string): void {
  const entry = getFileEntry(resolvedPath)
  if (entry === null) {
    // Never indexed. If the file is actually present on disk, parse it once on demand so
    // symbol/read/skeleton/outline can serve a surgical slice instead of returning "no symbols"
    // and forcing the caller to fall back to a full-file Read/grep -- the exact token cost this
    // tool exists to avoid. This is the common case for a project whose background worker never
    // ran (or hasn't caught up) and for a freshly-created/renamed file: real sessions repeatedly
    // hit "not found -> full Read" here. fingerprintFile doubles as the on-disk probe -- it
    // returns null for a missing/unreadable path, so an absent file (or a bare name that resolves
    // to nothing, as in unit tests) is skipped cleanly with no parse and no dirty-queue enqueue.
    if (fingerprintFile(resolvedPath) === null) return
    try {
      indexFileSync(resolvedPath, globalDbPath())
      enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
    } catch {
      // Best-effort: leave it unindexed; the caller emits its normal "no symbols" message rather
      // than crashing a surgical-read command on a parse failure.
    }
    return
  }
  if (entry.sha === '') return
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null || diskSha === entry.sha) return
  try {
    indexFileSync(resolvedPath, globalDbPath())
    enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
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

export function didYouMean(candidates: string[]): string {
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
    let text = `No matches for '${opts.name ?? '*'}'`
    // --json callers parse this string as an error message, not human-facing prose -- keep it
    // byte-identical to before and only append the suggestion in text mode.
    if (opts.name !== undefined && opts.json !== true) {
      // Same near-name mechanism as `find`: scan the index and match by case-insensitive
      // substring in either direction, so a typo'd or partial name still gets a cheap next
      // step instead of dead-ending into a full-file Read or a wide Grep.
      const nameLower = opts.name.toLowerCase()
      const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
      const rawSymbols = querySymbols({ limit: FIND_SCAN_LIMIT, rootDir })
      const candidates = [
        ...new Set(
          rawSymbols
            .filter((s) => {
              const symLower = s.name.toLowerCase()
              return (
                symLower.includes(nameLower) ||
                (symLower.length >= MIN_REVERSE_MATCH_LEN && nameLower.includes(symLower))
              )
            })
            .map((s) => s.name),
        ),
      ]
        // Closest length to the query first (didYouMean only keeps the first DIDYOUMEAN_LIMIT,
        // so ordering decides what survives). Ordinal (not locale-aware) tiebreak -- an
        // unlocaled localeCompare() sorts differently across Node's small-icu vs full-icu builds
        // and different system default locales, making this truncation-affecting ranking
        // nondeterministic across machines/CI runners.
        .sort((a, b) => {
          const diff = Math.abs(a.length - nameLower.length) - Math.abs(b.length - nameLower.length)
          if (diff !== 0) return diff
          return a < b ? -1 : a > b ? 1 : 0
        })
      text += candidates.length > 0 ? `\n${didYouMean(candidates)}` : `\nTry: token-goat semantic "${opts.name}"`
    }
    return { text, code: 1 }
  }

  const fullSourceBytes = sumFileSizes(results.map((s) => s.filePath))

  if (opts.json === true) {
    const capped = guardJsonRows(results)
    // `results` is already truncated by querySymbols's own SQL `LIMIT` (opts.limit, or the
    // default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length)
    // is not the real number of matching symbols -- countSymbols reruns the same filters with
    // no LIMIT to report an honest total, the same distinction json_query's --head already
    // makes (its totalCount survives --head unlike this one used to).
    const trueTotal = countSymbols(queryOpts)
    const payload = { items: capped.items, truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
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
  /**
   * `file::symbol`, `file@N-M` / `file@N` (line range), a bare file path, or -- new -- a
   * comma-separated symbol list (`file::a,b,c`) to fetch several symbol bodies in one call,
   * mirroring `refs`'s multi-symbol grammar. See {@link runReadMulti}.
   */
  spec: string
  json?: boolean
  contextLines?: number
  forceRefresh?: boolean
  /** Add per-symbol reference count and doc-coverage flag, same as `skeleton`/`outline`'s `--stats`. */
  stats?: boolean
  /**
   * Project root to scope symbol resolution to. Defaults to `process.cwd()`; same field name
   * as {@link SemanticOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g.
   * an MCP server launched from an opaque directory) should pass the actual workspace root
   * explicitly -- otherwise a bare/partial file spec can resolve against the wrong project,
   * or an ambiguous symbol name can match a same-named definition in an unrelated project.
   */
  projectRoot?: string
  /**
   * Internal only -- set by {@link runReadMulti} on each per-symbol recursive `runRead` call so
   * the single-symbol path skips its own `recordReadStat`. Without this, N symbols from the
   * same file would each record a stat against the full file size, inflating the recorded
   * token-savings by a factor of N for what is really one read. `runReadMulti` records the stat
   * itself, once, for the whole multi-symbol call. Not a CLI/MCP-facing option.
   */
  suppressStat?: boolean
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

// A `file::symbol` read whose "symbol" is actually a bare numeric line spec -- `120`, `120-140`,
// `120:140`, or `120,140` -- is almost certainly an agent reaching for a line-range read with the
// `::` symbol separator instead of the documented `@` form (`file@120-140`). Rather than fail with
// "Symbol 'X' not found" and force a fall back to `sed`/full Read (extra round-trips, wasted
// tokens), recognize the numeric shape and serve those lines. This is only ever consulted AFTER
// symbol resolution has already found no matching symbol, so it can never shadow a real definition
// (and no valid identifier is all-digits anyway). Returns null for anything that is not a pure
// numeric range.
function parseColonLineRange(symbol: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:[-:,](\d+))?$/.exec(symbol)
  if (m === null) return null
  const start = parseInt(m[1]!, 10)
  const end = m[2] !== undefined ? parseInt(m[2], 10) : start
  return { start, end }
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
  // Prefer the real `parent` column (populated by the regex adapters via makeLineSymbol/
  // makeSpanSymbol -- see db.ts's SCHEMA_SQL comment for the full history of why this needed its
  // own column). KEEP the docstring-as-parent fallback below: a row indexed by an older binary
  // (or not yet reindexed since the migration) has `parent: ''` but may still carry the old
  // overloaded value in `docstring`, and dropping the fallback would break qualified lookup for
  // those pre-existing rows until the next reindex.
  // Defensive `?? ''`: SymbolEntry.parent is a required field for every real indexed row (see
  // index_reader.ts's `row.parent ?? ''` coalesce at the DB boundary), but a caller constructing
  // a SymbolEntry-shaped object by hand (a test double, an older SDK/plugin caller) may still omit
  // it -- treat that the same as an empty parent rather than throwing.
  const parent = (entry.parent ?? '').trim()
  if (parent !== '') return parent
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

function resolveSymbolSpec(spec: string, forceRefresh?: boolean, projectRoot?: string): SymbolResolution {
  const { file, symbol } = parseReadSpec(spec)
  if (symbol === undefined || symbol === '') return { kind: 'none' }

  const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
  if (forceRefresh === true) {
    indexFileSync(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
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
    // record the parent class name directly in the method symbol's `parent` column (see
    // makeLineSymbol/makeSpanSymbol in languages/common.ts). Fall back to `docstring` for a row
    // indexed before the `parent` column existed (or not yet reindexed since) -- see the same
    // reasoning in findParentName above. Match on either signal so both regex adapters
    // (parent/docstring) and tree-sitter/flat-emitter adapters (line-containment) disambiguate
    // correctly instead of silently falling through to candidates[0] (the first same-named
    // method, regardless of which class was actually requested).
    const symBaseLower = symBase.toLowerCase()
    const scoped = candidates.filter((c) => {
      const cParent = c.parent ?? ''
      if (cParent.toLowerCase() === symBaseLower) return true
      if (cParent === '' && c.docstring.toLowerCase() === symBaseLower) return true
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

  // Multi-symbol form: `file::a,b,c`. Guarded against the numeric line-range spec `file::N,M`
  // (parseColonLineRange, consulted a few lines below on a resolution miss) so a comma there is
  // never misread as two symbol names -- `parseColonLineRange(symbol) === null` fails fast for
  // the numeric form and falls straight through to the existing single-symbol path, which still
  // reaches the `::N,M` fallback later exactly as before.
  if (symbol !== undefined && symbol !== '' && symbol.includes(',') && parseColonLineRange(symbol) === null) {
    const multiSymbols = symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (multiSymbols.length > 1) return runReadMulti(file, multiSymbols, opts)
  }

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
    // Ergonomic fallback: `read "file::120-140"` (or `::120:140` / `::120,140` / `::120`) is an
    // agent using the `::` symbol separator for a line range. Serve the lines instead of failing
    // to a sed/full-Read round-trip. Only reached once no symbol matched, so a real definition is
    // never shadowed.
    const lineSpec = parseColonLineRange(symbol)
    if (lineSpec !== null) {
      return runLineRange({ file, start: lineSpec.start, end: lineSpec.end }, opts)
    }
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
    const closes = querySymbols({ filePath: resolved, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
    if (closes.length > 0) messages.push(didYouMean(closes))
    return { text: messages.join('\n'), code: 1 }
  }

  const match = resolution.entry
  const fullSourceBytes = sumFileSizes([match.filePath])

  // Only queried when --stats is actually requested -- an extra DB round trip the common
  // (non-stats) path shouldn't pay for. Same call shape as prepareSymbolListing's ref-count
  // lookup for skeleton/outline.
  const refCounts =
    opts.stats === true
      ? queryRefCounts([match.name], globalDbPath(), resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }))
      : undefined

  if (opts.json === true) {
    // Serialize the resolved body, not the raw row. `symbols.body` is stored empty for symbols
    // an extractor emits without text and for any symbol over parser.ts's MAX_SYMBOL_BODY_CHARS
    // (deliberately elided so it can be re-derived here rather than stored truncated). Emitting
    // the row verbatim would hand a JSON consumer `"body": ""` for those, which is the one
    // output shape with no honest signal that the text is available elsewhere -- the text form
    // below already resolves it.
    const text = JSON.stringify(
      {
        ...match,
        body: resolveBody(match),
        ...(refCounts !== undefined ? { refCount: refCounts.get(match.name) ?? 0 } : {}),
      },
      null,
      2,
    )
    if (opts.suppressStat !== true) recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
    return { text, code: 0 }
  }

  const body = resolveBody(match)

  const bodyLen = match.lineEnd - match.lineStart + 1
  const statsStr = formatStatsSuffix(refCounts, match)
  const lines: string[] = [
    `# ${bodyLen} lines (~${Math.ceil(body.length / 4)} tok)${statsStr}`,
    body,
  ]
  const warning = staleWarning(match.filePath)
  const text = guardText(warning + trimBlankLines(lines).join('\n'), 'symbol')
  if (opts.suppressStat !== true) recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

/**
 * Handle ``token-goat read "file::a,b,c"`` -- fetch several symbol bodies from one file in a
 * single call, mirroring `refs`'s comma-separated multi-symbol grammar (see
 * {@link parseMultiRefsSpec}). Delegates each symbol to a recursive {@link runRead} call
 * (`suppressStat: true`) rather than reimplementing resolution, so ambiguity handling,
 * not-found + did-you-mean, and JSON shape all come from the exact same code path the
 * single-symbol form already exercises -- a failure to resolve one symbol is reported inline
 * instead of aborting the whole call, same as `runRefs`'s per-symbol handling.
 */
function runReadMulti(file: string, symbols: string[], opts: ReadOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const sym of symbols) {
    const sub = runRead({ ...opts, spec: `${file}::${sym}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real
      // JSON per symbol, never an embedded string -- a failed sub-call has no JSON body of its
      // own, so it is represented by its plain-text error instead.
      jsonOut[sym] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${sym}:\n${sub.text}`)
  }

  // Count the file's on-disk size once for the whole multi-symbol call, not once per symbol --
  // each sub-call already skipped its own recordReadStat via suppressStat for exactly this
  // reason (see ReadOptions.suppressStat).
  if (anyFound) {
    const fullSourceBytes = sumFileSizes([resolveIndexPath(file, opts.projectRoot ?? process.cwd())])
    const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
    recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
    return { text, code: 0 }
  }

  const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
  return { text, code: 1 }
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
    // readSection returns null both when the file is unreadable (missing, permissions, etc.)
    // and when the file exists but the heading isn't in it -- distinguish the two so a bad
    // path doesn't masquerade as a missing section (an agent debugging "section not found"
    // wastes turns hunting for a heading that was never the actual problem).
    if (!fs.existsSync(filePath)) {
      return { text: `File not found: '${filePath}'`, code: 1 }
    }
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
  /**
   * Group references by file (count only, no per-line context) and show only the top N files
   * by reference count. For a high-fanout symbol (hundreds of refs across dozens of files --
   * e.g. a widely-extended base class or widely-implemented interface) the normal per-line
   * output degrades into the unusable wall of text this tool exists to prevent; this mode stays
   * surgical by trading per-line context for a ranked-by-fanout summary. Independent of
   * `--callers`: when both are set, `--top` wins for text output (its summary supersedes the
   * caller-grouped per-line view; the choice is between them, not a composition of both).
   */
  top?: number
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
  // Same reasoning: --top 0 (or negative) is never a meaningful request -- reject explicitly
  // rather than silently rendering an empty summary.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }

  const { file, symbols } = parseMultiRefsSpec(opts.spec)
  if (symbols.length <= 1) return runRefsSingle(opts)

  // Every entry uses the same envelope shape as the single-symbol `refs`/`symbol`/`skeleton`/
  // `outline` JSON output ({ items, truncated, totalCount }), whether or not it was truncated —
  // a JSON consumer should never have to branch on shape depending on truncation. `--top` opts
  // into a distinct, deliberately different envelope ({ fileCounts, totalFiles, totalRefs,
  // shown }) since the caller explicitly asked for the grouped summary shape instead.
  const jsonOut: Record<string, RefsJsonEntry> = {}
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
    else if (opts.top !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT
    const results = applyTypedRefsTier(sym, file, queryRefs(queryOpts))
    if (results.length > 0) anyFound = true
    refFilePaths.push(...results.map((r) => r.filePath))
    if (opts.json === true) {
      if (opts.top !== undefined) {
        jsonOut[sym] = topFilesJsonPayload(results, opts.top)
      } else {
        // `results` is already truncated by queryRefs's own SQL `LIMIT` (opts.limit, or the
        // default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length)
        // is not the real number of matching refs -- countRefs reruns the same filters with no
        // LIMIT to report an honest total (same fix as runSymbol's countSymbols call).
        const capped = guardJsonRows(results)
        const trueTotal = countRefs(queryOpts)
        jsonOut[sym] = { items: capped.items, truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
      }
      continue
    }
    if (results.length === 0) {
      lines.push(`${sym}: (no references found)`)
      continue
    }
    lines.push(`${sym}:`)
    if (opts.top !== undefined) {
      lines.push(...renderTopFilesSummary(results, opts.top))
    } else if (opts.callers === true) {
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
  else if (opts.top !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT

  const results = applyTypedRefsTier(symName, defFileHint, queryRefs(queryOpts))

  if (results.length === 0) {
    emitErr(`No references found for '${symName}'`)
    return 1
  }

  const fullSourceBytes = sumFileSizes(results.map((r) => r.filePath))

  if (opts.json === true) {
    let payload: RefsJsonEntry
    if (opts.top !== undefined) {
      payload = topFilesJsonPayload(results, opts.top)
    } else {
      // Same "SQL LIMIT applied before totalCount is taken" fix as runRefs's per-symbol branch above.
      const capped = guardJsonRows(results)
      const trueTotal = countRefs(queryOpts)
      payload = { items: capped.items, truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
    }
    const text = JSON.stringify(payload, null, 2)
    emit(text)
    recordReadStat('symbol_read', fullSourceBytes, text, symName)
    return 0
  }

  const lines =
    opts.top !== undefined
      ? renderTopFilesSummary(results, opts.top)
      : opts.callers === true
        ? renderCallerGroups(results)
        : results.map((ref) => `${ref.filePath}:${ref.line}: ${ref.context}`)
  const text = lines.join('\n')
  emitGuarded(text, 'symbol')
  recordReadStat('symbol_read', fullSourceBytes, text, symName)
  return 0
}

interface FileRefCount {
  readonly file: string
  readonly count: number
}

/** Groups `refs` by file, counting occurrences per file and sorting by count descending (ties broken alphabetically by path for stable output). */
function groupRefsByFile(refs: RefEntry[]): FileRefCount[] {
  const byFile = new Map<string, number>()
  for (const ref of refs) byFile.set(ref.filePath, (byFile.get(ref.filePath) ?? 0) + 1)
  return [...byFile.entries()]
    .map(([file, count]) => ({ file, count }))
    // Ordinal (not locale-aware) tiebreak -- an unlocaled localeCompare() sorts differently across Node's small-icu vs full-icu builds and different system default locales, making the truncation-affecting top-N ranking nondeterministic across machines/CI runners.
    .sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** Renders the `--top N` grouped-by-file summary: a header line with total refs/files, then one `count  file` line per shown file, then an elision note naming exactly how many files and refs were dropped (never a silent truncation -- see this repo's no-silent-caps convention). */
function renderTopFilesSummary(refs: RefEntry[], topN: number): string[] {
  const grouped = groupRefsByFile(refs)
  const shown = grouped.slice(0, topN)
  const lines = [`${refs.length} references across ${grouped.length} files (showing top ${shown.length})`]
  for (const { file, count } of shown) lines.push(`  ${count}  ${file}`)
  const omittedFiles = grouped.length - shown.length
  if (omittedFiles > 0) {
    const shownRefs = shown.reduce((sum, g) => sum + g.count, 0)
    lines.push(`  ...(${omittedFiles} more files, ${refs.length - shownRefs} more references elided; use a higher --top to see more)`)
  }
  return lines
}

/** The `--top N` JSON envelope: ranked-by-count file list plus the totals needed to know how much was elided, without ever including a per-reference line (that's the point of the mode). */
interface RefsTopJsonEntry {
  readonly fileCounts: FileRefCount[]
  readonly totalFiles: number
  readonly totalRefs: number
  readonly shown: number
}

function topFilesJsonPayload(refs: RefEntry[], topN: number): RefsTopJsonEntry {
  const grouped = groupRefsByFile(refs)
  const shown = grouped.slice(0, topN)
  return { fileCounts: shown, totalFiles: grouped.length, totalRefs: refs.length, shown: shown.length }
}

type RefsJsonEntry = { items: RefEntry[]; truncated: boolean; totalCount: number } | RefsTopJsonEntry

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
 * extension, and a recognized-but-unsupported language (Scala, Lua, Elixir, Dart, Zig, R --
 * see {@link unsupportedLanguageName}) all currently produce zero symbol rows and
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
 * Upper bound on the number of symbols fetched in one SQL query for a single file's
 * `skeleton`/`outline`. The old hard `limit: 500` silently dropped every symbol past the 500th
 * on large files -- a 5000-line demonolith indexes to thousands of symbols -- and still reported
 * `truncated: false` with an honest-looking header, because the token-budget overflow guard
 * (guardJsonRows/guardText) only ever saw the pre-capped 500 rows and computed its
 * `truncated`/`totalCount` from that truncated slice. This cap is set high enough that the
 * overflow guard, not this SQL LIMIT, is the real limiter for realistic files. A file whose
 * symbol count genuinely exceeds THIS cap too is flagged via the fetch-one-past-the-cap
 * detection below, which also re-queries with countSymbols (no LIMIT) so `totalCount` stays
 * honest even past this cap, rather than just moving the same silent-lie cliff higher. (Same
 * "SQL LIMIT applied before the count is taken" truncation-lie shape already fixed for
 * symbol/refs/refs --top/grep --json.)
 */
const SKELETON_SYMBOL_CAP = 5000

/**
 * Whether a symbol's `docstring` field holds an actual doc comment.
 *
 * The column is overloaded: the regex-parsed adapters (php/csharp/kotlin/swift/scala/...)
 * store the *parent class name* there, because their class symbol is a single-line span at the
 * header that never contains the method body, so line-containment can't recover the parent (see
 * {@link findParentName}). Treating that bare name as documentation made every nested symbol in
 * those languages report `documented` when it has no doc comment at all -- a false positive, and
 * worse than the missing-docstring case because it asserts something untrue.
 *
 * A real doc comment is never a single bare identifier, so {@link PARENT_IDENTIFIER_RE} -- the
 * same test `findParentName` already uses to recognize the parent convention -- separates them.
 */
function hasRealDocstring(docstring: string): boolean {
  const doc = docstring.trim()
  return doc !== '' && !PARENT_IDENTIFIER_RE.test(doc)
}

/**
 * Render the trailing `--stats` annotation (`  [N refs, documented|undocumented]`) shared by
 * `skeleton`, `outline`, and `read`'s text output. Returns `''` when `refCounts` is `undefined`
 * (i.e. `--stats` wasn't requested), so callers can always append the result unconditionally.
 */
function formatStatsSuffix(refCounts: Map<string, number> | undefined, sym: { name: string; docstring: string }): string {
  return refCounts !== undefined
    ? `  [${refCounts.get(sym.name) ?? 0} refs, ${hasRealDocstring(sym.docstring) ? 'documented' : 'undocumented'}]`
    : ''
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
): { kind: 'empty'; text: string } | { kind: 'ok'; resolved: string; filtered: SymbolEntry[]; refCounts: Map<string, number> | undefined; fullSourceBytes: number; symbolsTruncated: boolean; trueSymbolCount: number | undefined } {
  const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
  if (opts.forceRefresh === true) {
    indexFileSync(resolved, globalDbPath())
    enqueueDirtyPathSafe(resolved, { alreadyResolved: true })
  } else {
    // Self-heal a stale index before querying below, so skeleton/outline serve fresh data
    // instead of the caller having to fall back to a stale-index warning.
    healStaleIndex(resolved)
  }
  // Fetch one past the cap so a file that genuinely has more than SKELETON_SYMBOL_CAP symbols can
  // be flagged as truncated honestly, instead of the old `limit: 500` that dropped the overflow
  // silently and still reported truncated:false.
  const fetched = querySymbols({ filePath: resolved, limit: SKELETON_SYMBOL_CAP + 1 })
  const symbolsTruncated = fetched.length > SKELETON_SYMBOL_CAP
  const symbols = symbolsTruncated ? fetched.slice(0, SKELETON_SYMBOL_CAP) : fetched
  // When the cap is actually hit, `symbols.length` (and anything downstream computed from it) is
  // no longer the true count -- it's just SKELETON_SYMBOL_CAP. Re-query with no LIMIT (same
  // "SQL LIMIT applied before the count is taken" fix already applied to runSymbol/countSymbols)
  // so the JSON payload's totalCount stays honest instead of silently re-lying at the new,
  // higher cap the way the old hard `limit: 500` used to.
  const trueSymbolCount = symbolsTruncated ? countSymbols({ filePath: resolved }) : undefined

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

  return { kind: 'ok', resolved, filtered, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount }
}

/** Handle ``token-goat skeleton file``. */
export function runSkeleton(opts: SkeletonOptions): { text: string; code: number } {
  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, filtered, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount } = prep

  if (opts.json === true) {
    const rows = filtered.map((s) => ({
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
    }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('stub_view', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const totalLines = filtered.length > 0 ? Math.max(...filtered.map((s) => s.lineEnd)) : 0
  const lines: string[] = [`# Skeleton: ${opts.file}  (${filtered.length} symbols, ${totalLines} lines)`]
  for (const sym of filtered) {
    const lineStr = sym.lineStart.toString().padStart(6)
    const statsStr = formatStatsSuffix(refCounts, sym)
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
  const { resolved, filtered, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount } = prep

  if (opts.json === true) {
    const rows =
      refCounts !== undefined
        ? filtered.map((s) => ({
            ...s,
            refCount: refCounts.get(s.name) ?? 0,
            hasDoc: hasRealDocstring(s.docstring),
          }))
        : filtered
    const capped = guardJsonRows(rows)
    const payload = {
      items: capped.items,
      truncated: capped.truncated || symbolsTruncated,
      totalCount: symbolsTruncated ? Math.max(trueSymbolCount ?? 0, capped.totalCount) : capped.totalCount,
    }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('outline', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const lines: string[] = [`# Outline: ${opts.file}  (${filtered.length} symbols)`]
  for (const sym of filtered) {
    const rangeStr = `${sym.lineStart.toString().padStart(4)}-${sym.lineEnd.toString().padEnd(6)}`
    const kindStr = sym.kind.padEnd(14)
    const bodyLen = sym.lineEnd - sym.lineStart + 1
    // Same overloaded-column guard as the stats flag: a bare parent name is not a doc comment
    // and must not be rendered as one (see hasRealDocstring).
    const docFirst = hasRealDocstring(sym.docstring) ? `  # ${sym.docstring.split('\n')[0] ?? ''}` : ''
    const statsStr = formatStatsSuffix(refCounts, sym)
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
    // csv_query carries a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry, but
    // nothing here ever called recordStat -- the csv-query bucket in `token-goat stats --full`
    // stayed permanently zero regardless of real usage, the same class of registry/producer
    // desync previously fixed for map_lookup/changed_lookup (see
    // project_runchanged_missing_stat memory). "Full source" is the on-disk size of the CSV
    // file actually queried, mirroring recordReadStat's fullSourceBytes convention elsewhere in
    // this file.
    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      // queryCsv already applies --head to `result.rows` before returning, so a bare
      // rowsJson.length (== capped.totalCount below) would report the head-limited count, not
      // the true number of matching rows -- result.totalRows (computed pre-head inside queryCsv)
      // is the only honest total. Same fix shape as runQueryCommand's json-query/yaml-query and
      // symbol/refs's SQL-LIMIT totalCount fix.
      const rowsJson = result.rows.map((r) => Object.fromEntries(result.header.map((h, i) => [h, r[i]])))
      const headTruncated = result.rows.length < result.totalRows
      const capped = guardJsonRows(rowsJson)
      const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount: result.totalRows })
      emit(jsonText)
      recordReadStat('csv_query', fullSourceBytes, jsonText, opts.file)
    } else {
      const tableText = formatCsvTable(result)
      emit(tableText)
      recordReadStat('csv_query', fullSourceBytes, tableText, opts.file)
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
    // csv_profile never had a live recordStat call, the same class of registry/producer desync
    // fixed for csv_query above (see that function's doc comment) -- the csv-profile bucket in
    // `token-goat stats --full` stayed permanently zero regardless of real usage. "Full source"
    // is the on-disk size of the CSV file actually profiled, mirroring runCsvQuery's convention.
    const fullSourceBytes = sumFileSizes([opts.file])
    const profileText = formatCsvProfile(profiles)
    emit(profileText)
    recordReadStat('csv_profile', fullSourceBytes, profileText, opts.file)
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

/** Shared body for ``json-outline``/``yaml-outline``: read file, parse via the given
 * format-specific parser, then delegate to outlineJson/formatJsonOutline. Parameterized by
 * `parse` (the format's parse function), `formatLabel` (used in the parse-error message), and
 * `kind` (the recordReadStat kind, matching stats.ts's KIND_TO_SOURCE/COMMAND_KINDS entry for
 * this command -- same "read replacement" shape as runCsvQuery/runCoverageReportGaps). */
function runOutlineCommand(opts: JsonOutlineCliOptions, parse: (text: string) => unknown, formatLabel: string, kind: string): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let data: unknown
  try {
    data = parse(text)
  } catch {
    emitErr(`Failed to parse ${formatLabel}: ${opts.file}`)
    return 1
  }

  const outline = outlineJson(data)
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(outline)
    emit(jsonText)
    recordReadStat(kind, fullSourceBytes, jsonText, opts.file)
  } else {
    const text2 = formatJsonOutline(outline)
    emit(text2)
    recordReadStat(kind, fullSourceBytes, text2, opts.file)
  }
  return 0
}

/** Handle ``token-goat json-outline file``: structural summary of a JSON document without
 * dumping it -- element count + key/type shape for an array, top-level key types/sizes for
 * an object. */
export function runJsonOutline(opts: JsonOutlineCliOptions): number {
  return runOutlineCommand(opts, JSON.parse, 'JSON', 'json_outline')
}

export interface JsonQueryCliOptions {
  file: string
  path: string
  head?: string
  json?: boolean
}

/** Shared body for ``json-query``/``yaml-query``: read file, parse via the given
 * format-specific parser, then delegate to queryJson. Parameterized by `parse` (the format's
 * parse function), `formatLabel` (used in the parse-error message), `guardTag` (passed to
 * emitGuarded so plain-text output is capped/labeled per-command), and `kind` (the
 * recordReadStat kind, matching stats.ts's KIND_TO_SOURCE/COMMAND_KINDS entry for this
 * command -- same "read replacement" shape as runCsvQuery/runCoverageReportGaps). */
function runQueryCommand(
  opts: JsonQueryCliOptions,
  parse: (text: string) => unknown,
  formatLabel: string,
  guardTag: string,
  kind: string,
): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let data: unknown
  try {
    data = parse(text)
  } catch {
    emitErr(`Failed to parse ${formatLabel}: ${opts.file}`)
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
    const fullSourceBytes = sumFileSizes([opts.file])

    if (!result.fanned) {
      const value = result.items[0]
      const valueText = opts.json === true ? JSON.stringify(value) : JSON.stringify(value, null, 2)
      emit(valueText)
      recordReadStat(kind, fullSourceBytes, valueText, opts.file)
      return 0
    }

    const totalCount = result.items.length
    const limited = head !== undefined ? result.items.slice(0, head) : result.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const capped = guardJsonRows(limited)
      const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount })
      emit(jsonText)
      recordReadStat(kind, fullSourceBytes, jsonText, opts.file)
    } else {
      const lines = limited.map((item) => JSON.stringify(item))
      if (headTruncated) {
        lines.push(`...(${totalCount - limited.length} more items elided; use --head to see more)`)
      }
      const plainText = lines.join('\n')
      emitGuarded(plainText, guardTag)
      recordReadStat(kind, fullSourceBytes, plainText, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

/** Handle ``token-goat json-query file path``: extract one value or a projected/filtered
 * subset from a JSON document by dot-path spec (`[n]` index, `[*]` wildcard,
 * `[field=value]` filter), instead of a raw Read. */
export function runJsonQuery(opts: JsonQueryCliOptions): number {
  return runQueryCommand(opts, JSON.parse, 'JSON', 'json-query', 'json_query')
}

/** Parses YAML text, handling multi-document streams (`---`-separated) via js-yaml's loadAll -- a single-document file (the overwhelming majority) unwraps to its one value so path queries work directly against it, while a genuine multi-doc stream (k8s manifests, etc.) stays an array so the existing [n]/[*] json_query.ts grammar indexes into documents for free. */
function parseYamlDocument(text: string): unknown {
  const docs = loadAllYaml(text)
  return docs.length === 1 ? docs[0] : docs
}

/** Handle ``token-goat yaml-outline file``: structural summary of a YAML document, reusing json_query.ts's outlineJson (a parsed YAML document is the same array/object/scalar shape as parsed JSON). */
export function runYamlOutline(opts: JsonOutlineCliOptions): number {
  return runOutlineCommand(opts, parseYamlDocument, 'YAML', 'yaml_outline')
}

/** Handle ``token-goat yaml-query file path``: extract one value or a projected/filtered subset from a YAML document by dot-path, reusing json_query.ts's queryJson (same grammar as json-query). */
export function runYamlQuery(opts: JsonQueryCliOptions): number {
  return runQueryCommand(opts, parseYamlDocument, 'YAML', 'yaml-query', 'yaml_query')
}

export interface OpenApiOutlineCliOptions {
  file: string
  json?: boolean
}

/** Shared read-parse-extract path for the openapi-outline/openapi-op commands: reads `file`,
 * parses it as an OpenAPI/Swagger spec (JSON or YAML), and extracts its operations. Emits the
 * appropriate CLI error and returns `null` on either failure, mirroring each command's own
 * pre-extraction error handling exactly so callers can just `if (operations === null) return 1`. */
function loadOpenApiOperations(file: string): ReturnType<typeof extractOperations> | null {
  const text = readFileText(file)
  if (text === null) {
    emitErr(`Could not read: ${file}`)
    return null
  }

  let spec: unknown
  try {
    spec = parseOpenApiSpec(text, file)
  } catch {
    emitErr(`Failed to parse OpenAPI spec (not valid JSON or YAML): ${file}`)
    return null
  }

  return extractOperations(spec)
}

/** Handle ``token-goat openapi-outline file``: one compact line per operation (method, path,
 * operationId, summary, tags) instead of a raw Read of a multi-thousand-line OpenAPI/Swagger
 * spec (JSON or YAML). */
export function runOpenApiOutline(opts: OpenApiOutlineCliOptions): number {
  const operations = loadOpenApiOperations(opts.file)
  if (operations === null) return 1
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(operations)
    emit(jsonText)
    recordReadStat('openapi_outline', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatOpenApiOutline(operations)
    emitGuarded(text, 'openapi-outline')
    recordReadStat('openapi_outline', fullSourceBytes, text, opts.file)
  }
  return 0
}

export interface OpenApiOpCliOptions {
  file: string
  operation: string
  json?: boolean
}

/** Handle ``token-goat openapi-op file operationId-or-"METHOD path"``: full detail (parameters,
 * request body schema, response schemas per status code, description) for exactly one operation
 * instead of a raw Read. Lookup tries an exact `operationId` match first, then a `METHOD path`
 * match -- same exact-then-fallback shape as `read`/`symbol`'s resolution elsewhere in this file. */
export function runOpenApiOp(opts: OpenApiOpCliOptions): number {
  const operations = loadOpenApiOperations(opts.file)
  if (operations === null) return 1
  const match = findOperation(operations, opts.operation)

  if (match === undefined) {
    const messages = [`Operation '${opts.operation}' not found in '${opts.file}'`]
    const closes = operations.map(operationLabel)
    if (closes.length > 0) messages.push(didYouMean(closes))
    emitErr(messages.join('\n'))
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(match)
    emit(jsonText)
    recordReadStat('openapi_op', fullSourceBytes, jsonText, opts.operation)
  } else {
    const text = formatOperationDetail(match)
    emitGuarded(text, 'openapi-op')
    recordReadStat('openapi_op', fullSourceBytes, text, opts.operation)
  }
  return 0
}

export interface ZipListCliOptions {
  file: string
  json?: boolean
}

/** Handle ``token-goat zip-list archive``: entry paths + sizes inside a zip-format archive
 * (.zip/.jar/.whl/.vsix/.nupkg are all zip containers under the hood) instead of a raw Read
 * or an unzip -l shell-out. Reads the archive's central directory only -- no member is
 * decompressed just to list it. */
export function runZipList(opts: ZipListCliOptions): number {
  const data = readFileBytes(opts.file)
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ReturnType<typeof listZipEntries>
  try {
    entries = listZipEntries(data)
  } catch {
    emitErr(`Failed to read archive (not a valid zip-format file): ${opts.file}`)
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(entries)
    emit(jsonText)
    recordReadStat('zip_list', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatZipList(entries)
    emitGuarded(text, 'zip-list')
    recordReadStat('zip_list', fullSourceBytes, text, opts.file)
  }
  return 0
}

export interface ZipReadCliOptions {
  file: string
  entry: string
  json?: boolean
}

/** Handle ``token-goat zip-read archive entry``: extract and print exactly one entry's text
 * content from a zip-format archive instead of extracting the whole archive to disk. A binary
 * member (content that isn't valid UTF-8 text) is reported with the same
 * `[binary content elided by token-goat]` marker filters.ts uses for binary output elsewhere in
 * this codebase, rather than dumping raw bytes or crashing on the utf-8 decode. */
export function runZipRead(opts: ZipReadCliOptions): number {
  const data = readFileBytes(opts.file)
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ReturnType<typeof listZipEntries>
  let content: Uint8Array | undefined
  try {
    entries = listZipEntries(data)
    content = extractZipEntry(data, opts.entry)
  } catch {
    emitErr(`Failed to read archive (not a valid zip-format file): ${opts.file}`)
    return 1
  }

  // A directory entry (e.g. `dir/`) still matches extractZipEntry's exact-name filter and
  // decompresses to a defined, zero-length Uint8Array -- not `undefined` -- so without this
  // check it would silently "succeed" with empty output instead of reporting that the requested
  // entry is a directory, not a readable file.
  const matchedEntry = entries.find((e) => e.path === opts.entry)
  if (matchedEntry?.isDirectory === true) {
    emitErr(`Entry '${opts.entry}' is a directory, not a file, in '${opts.file}'`)
    return 1
  }

  if (content === undefined) {
    const messages = [`Entry '${opts.entry}' not found in '${opts.file}'`]
    const closes = entries.map((e) => e.path)
    if (closes.length > 0) messages.push(didYouMean(closes))
    emitErr(messages.join('\n'))
    return 1
  }

  const buf = Buffer.from(content)
  const text = isValidUtf8(buf) ? buf.toString('utf-8') : '[binary content elided by token-goat]'
  const fullSourceBytes = sumFileSizes([opts.file])

  if (opts.json === true) {
    const jsonText = JSON.stringify({ path: opts.entry, text })
    emit(jsonText)
    recordReadStat('zip_read', fullSourceBytes, jsonText, opts.entry)
  } else {
    emitGuarded(text, 'zip-read')
    recordReadStat('zip_read', fullSourceBytes, text, opts.entry)
  }
  return 0
}

export interface PrSliceCliOptions {
  pr: string
  slice: string
  repo?: string
  json?: boolean
  projectRoot?: string
}

/** Handle ``token-goat pr-slice <pr> <slice>``: fetch and format exactly one slice of a GitHub
 * PR via `gh` -- `files` (changed files with +/- counts), `diff:<path>` (one file's diff hunk),
 * `comments` (review comments), or `description` (title/body/metadata) -- instead of a raw
 * `gh pr view`/`gh pr diff` dump. Resolves the target repo from `--repo`, falling back to the
 * current directory's `origin` git remote when omitted. */
export function runPrSlice(opts: PrSliceCliOptions): number {
  const parsed = parsePrSliceArg(opts.slice)
  if (parsed === null) {
    emitErr(`Invalid slice '${opts.slice}' -- expected one of: files, diff:<path>, comments, description`)
    return 1
  }

  if (!isGhAvailable()) {
    emitErr('gh (GitHub CLI) not found on PATH -- install it from https://cli.github.com and run `gh auth login`')
    return 1
  }

  let repo = opts.repo
  if (repo === undefined) {
    const cwd = opts.projectRoot ?? process.cwd()
    let remoteUrl = ''
    try {
      const result = runGit(['remote', 'get-url', 'origin'], { cwd })
      if (result.exitCode === 0) remoteUrl = result.stdout.trim()
    } catch {
      // Fall through to the resolution-failure error below.
    }
    const resolved = remoteUrl.length > 0 ? parseGithubRepoFromRemoteUrl(remoteUrl) : null
    if (resolved === null) {
      emitErr("Could not resolve a GitHub repo from the current directory's git remote 'origin' -- pass --repo owner/repo")
      return 1
    }
    repo = resolved
  }

  if (!isGhAuthenticated()) {
    emitErr('gh is not authenticated -- run `gh auth login`')
    return 1
  }

  try {
    switch (parsed.kind) {
      case 'files': {
        const files = fetchPrFiles(opts.pr, repo)
        // pr-slice carries a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry
        // (pr_slice), but nothing here ever called recordStat -- the pr-slice bucket in
        // `token-goat stats --full` stayed permanently zero regardless of real usage, the same
        // class of registry/producer desync previously fixed for
        // map_lookup/changed_lookup/csv_query/brief_view/gdrive_sections (see
        // project_runchanged_missing_stat memory). "Full source" is the raw fetched GH API
        // payload (what a manual `gh pr view --json files` dump would be) vs the formatted/
        // guarded slice actually emitted, mirroring recordReadStat's convention elsewhere in
        // this file.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(files), 'utf8')
        if (opts.json === true) {
          const capped = guardJsonRows(files)
          const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} files`)
        } else {
          const text = formatFilesSlice(files)
          emitGuarded(text, 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} files`)
        }
        return 0
      }
      case 'diff': {
        const diffText = fetchPrDiff(opts.pr, repo)
        const fileDiff = extractFileDiff(diffText, parsed.path)
        if (fileDiff === null) {
          emitErr(`No diff found for '${parsed.path}' in PR #${opts.pr}`)
          return 1
        }
        // "Full source" is the whole multi-file PR diff fetched before slicing down to one
        // file's hunk -- see the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(diffText, 'utf8')
        if (opts.json === true) {
          const jsonText = JSON.stringify({ path: parsed.path, diff: fileDiff })
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} diff:${parsed.path}`)
        } else {
          emitGuarded(fileDiff, 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, fileDiff, `${repo}#${opts.pr} diff:${parsed.path}`)
        }
        return 0
      }
      case 'comments': {
        const comments = fetchPrComments(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(comments), 'utf8')
        if (opts.json === true) {
          const capped = guardJsonRows(comments)
          const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} comments`)
        } else {
          const text = formatCommentsSlice(comments)
          emitGuarded(text, 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} comments`)
        }
        return 0
      }
      case 'description': {
        const desc = fetchPrDescription(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(desc), 'utf8')
        if (opts.json === true) {
          const jsonText = JSON.stringify(desc)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} description`)
        } else {
          const text = formatDescriptionSlice(desc)
          emitGuarded(text, 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} description`)
        }
        return 0
      }
    }
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface SqliteSchemaCliOptions {
  file: string
  json?: boolean
}

/** Handle ``token-goat sqlite-schema file``: structural summary of a SQLite database --
 * tables/views with column list (name/type/nullable/PK), indexes, foreign keys, and row
 * counts -- instead of a raw Read (useless on binary bytes) or shelling out to the sqlite3
 * CLI. Mirrors runJsonOutline's "summary, not a dump" shape for SQLite structure. */
export function runSqliteSchema(opts: SqliteSchemaCliOptions): number {
  try {
    const schema = getSqliteSchema(opts.file)
    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      const jsonText = JSON.stringify(schema)
      emit(jsonText)
      recordReadStat('sqlite_schema', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = formatSqliteSchema(schema)
      emit(text)
      recordReadStat('sqlite_schema', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface SqliteQueryCliOptions {
  file: string
  sql: string
  head?: string
  json?: boolean
}

/** Handle ``token-goat sqlite-query file sql``: run a read-only SELECT against a SQLite
 * database and return rows in token-goat's standard tabular/JSON convention (mirrors
 * csv-query's --json / --head / overflow-guard shaping). Rejects any non-SELECT statement,
 * multi-statement injection, and anything that isn't demonstrably read-only -- see
 * sqlite_query.ts's module doc for the full defense-in-depth rationale. This is a
 * surgical-extraction tool, not a general SQL execution surface. */
export function runSqliteQuery(opts: SqliteQueryCliOptions): number {
  let head: number | undefined
  try {
    head = opts.head !== undefined ? requireNonNegativeStrictInt('--head', opts.head) : undefined
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }

  try {
    const result = runReadOnlySqliteQuery(opts.file, opts.sql)
    const totalCount = result.rows.length
    const headTruncated = head !== undefined && result.rows.length > head
    const rows = head !== undefined ? result.rows.slice(0, head) : result.rows

    const fullSourceBytes = sumFileSizes([opts.file])
    if (opts.json === true) {
      // totalCount must come from `result.rows.length` (captured above, before --head slices
      // `rows`) -- capped.totalCount would report the already-head-limited row count instead of
      // the true result size, same lie as runCsvQuery's --head/--json bug.
      const capped = guardJsonRows(rows)
      const jsonText = JSON.stringify({
        columns: result.columns,
        items: capped.items,
        truncated: capped.truncated || headTruncated || result.rowCapped,
        totalCount,
        rowCapped: result.rowCapped,
      })
      emit(jsonText)
      recordReadStat('sqlite_query', fullSourceBytes, jsonText, opts.file)
    } else {
      const text = formatSqliteQueryTable({ ...result, rows }, { headTruncated })
      emit(text)
      recordReadStat('sqlite_query', fullSourceBytes, text, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
}

export interface CoverageReportGapsCliOptions {
  file: string
  fileFilter?: string
  json?: boolean
}

/** Handle ``token-goat coverage-report-gaps file``: extracts and prints only the uncovered
 * lines/functions/branches ("the gaps") from a code-coverage report -- LCOV `.info` text or
 * Istanbul/nyc `coverage-final.json` / `coverage-summary.json` -- instead of a raw Read of what
 * can be a multi-thousand-line report. `--file` narrows to one source file's gaps (matched
 * exact-or-suffix against the report's own per-file path keys, see
 * filterCoverageGapsByFile). A report with zero gaps anywhere prints one clear message rather
 * than an empty or confusing listing. */
export function runCoverageReportGaps(opts: CoverageReportGapsCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let report: ReturnType<typeof parseCoverageReport>
  try {
    report = parseCoverageReport(text)
  } catch (e) {
    emitErr(`Failed to parse coverage report (not valid LCOV or Istanbul JSON): ${opts.file}\n${extractErrorMessage(e)}`)
    return 1
  }

  const scoped = opts.fileFilter !== undefined ? filterCoverageGapsByFile(report, opts.fileFilter) : report

  // coverage-report-gaps reads a full LCOV/Istanbul coverage report and emits only the narrower
  // uncovered-lines slice -- the same "read replacement" shape as csv-query -- but never called
  // recordStat, so the coverage_report_gaps bucket in `token-goat stats --full` stayed
  // permanently zero regardless of real usage (same class of gap fixed for
  // csv_query/map_lookup/changed_lookup; see project_runchanged_missing_stat memory).
  // "Full source" is the on-disk size of the coverage report actually read, mirroring
  // recordReadStat's fullSourceBytes convention elsewhere in this file.
  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(scoped)
    emit(jsonText)
    recordReadStat('coverage_report_gaps', fullSourceBytes, jsonText, opts.file)
  } else {
    const text = formatCoverageGaps(scoped)
    emitGuarded(text, 'coverage-report-gaps')
    recordReadStat('coverage_report_gaps', fullSourceBytes, text, opts.file)
  }
  return 0
}

export interface ConflictsCliOptions {
  path?: string
  json?: boolean
  summary?: boolean
}

/** Handle ``token-goat conflicts [path]``: unresolved git merge-conflict markers
 * (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`, both plain two-way and diff3 three-way)
 * instead of a raw Read or grep for `<<<<<<<`. `path` may be a single file, a directory (scanned
 * via {@link walkProject}, same bounded walker `map`/`todo` use), or omitted entirely (scans the
 * whole project from cwd) -- mirrors text_commands.ts's `collectTodoFiles`'s file-vs-directory-
 * vs-omitted resolution. Only files with at least one conflict region or malformed-marker
 * warning are reported; a fully clean scan prints one clear message. `--summary` narrows each
 * region to its line range and side labels, omitting the ours/base/theirs content. */
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

  const results: ReturnType<typeof parseConflicts>[] = []
  for (const f of files) {
    const text = readFileText(f)
    if (text === null) continue
    const parsed = parseConflicts(f, text)
    if (parsed.regions.length > 0 || parsed.warnings.length > 0) results.push(parsed)
  }

  const fullSourceBytes = sumFileSizes(files)
  const detail = opts.path ?? '.'
  if (opts.json === true) {
    const jsonText = JSON.stringify(opts.summary === true ? results.map(summarizeFileConflicts) : results)
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
  // brief carries a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry (brief_view),
  // but nothing here ever called recordStat -- the brief bucket in `token-goat stats --full`
  // stayed permanently zero regardless of real usage, the same class of registry/producer
  // desync previously fixed for map_lookup/changed_lookup/csv_query (see
  // project_runchanged_missing_stat memory). "Full source" is the on-disk size of the file the
  // resolved symbol lives in, mirroring recordReadStat's fullSourceBytes convention elsewhere in
  // this file -- brief folds a symbol read + callers lookup + section lookup into that one file.
  const fullSourceBytes = sumFileSizes([match.filePath])

  if (opts.json === true) {
    const result: BriefResult = {
      symbol: match,
      callers: shown,
      totalCallers,
      truncated,
      section,
    }
    const jsonText = JSON.stringify(result, null, 2)
    emit(jsonText)
    recordReadStat('brief_view', fullSourceBytes, jsonText, opts.spec)
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

  const text = guardText(trimBlankLines(lines).join('\n'), 'symbol')
  emit(text)
  recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
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
/** Matches a unified-diff hunk header (`@@ -a,b +c,d @@`); shared by parseDiffHunks and splitDiffHunks. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

/**
 * Computes a hunk's new-side line range from its header match. A pure-deletion hunk (new-side
 * count of 0) has no new-side lines to report; it is anchored to its single insertion point
 * instead, so a symbol sitting at that point still counts as touched.
 */
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
    // Handle deleted files: +++ /dev/null resets currentFile
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
    const symbolFullBytes = sumFileSizes(changedFiles.map((f) => resolveIndexPath(f, projectRoot)))
    if (opts.json === true) {
      const capped = guardJsonRows(allSymbols)
      const text = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2)
      emit(text)
      recordReadStat('changed_lookup', symbolFullBytes, text, ref)
      return 0
    }
    const symbolText = allSymbols.map((s) => `${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}`).join('\n')
    for (const s of allSymbols) {
      emit(`${s.name} (${s.kind}) — ${s.filePath}:${s.lineStart}`)
    }
    recordReadStat('changed_lookup', symbolFullBytes, symbolText, ref)
    return 0
  }

  const fullBytes = sumFileSizes(changedFiles.map((f) => resolveIndexPath(f, projectRoot)))
  if (opts.json === true) {
    const capped = guardJsonRows(changedFiles)
    const text = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2)
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
/**
 * Shared spec-resolution path for symbol-scoped git commands (runDiff, runLog): requires a
 * `file::symbol` spec (not just a bare file), resolves it via resolveSymbolSpec, and emits the
 * standard ambiguous/did-you-mean error (same shape as runRead's own branches) on failure.
 * Returns null on any failure so callers can just `if (r === null) return 1`.
 */
function resolveSymbolSpecOrEmitError(
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

  if (resolution.kind === 'ambiguous') {
    // Same hard-refuse shape as runRead's ambiguous branch -- never guess which candidate the
    // caller meant.
    emitErr(formatAmbiguity(resolution.symbol, resolution.file, resolution.candidates))
    return null
  }

  if (resolution.kind === 'none') {
    // Same "not found" + did-you-mean shape as runRead's none branch.
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
    const closes = querySymbols({ filePath: resolved, limit: DIDYOUMEAN_LIMIT }).map((s) => s.name)
    if (closes.length > 0) messages.push(didYouMean(closes))
    emitErr(messages.join('\n'))
    return null
  }

  return resolution.entry
}

export function runDiff(opts: DiffOptions): number {
  const match = resolveSymbolSpecOrEmitError('diff', opts.spec, opts.projectRoot)
  if (match === null) return 1
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

// ---- log --------------------------------------------------------------------

export interface LogOptions {
  spec: string
  ref?: string
  json?: boolean
  projectRoot?: string
  maxCount?: number
}

/** One commit's entry from `--json` output of {@link runLog}. */
interface LogEntry {
  hash: string
  author: string
  date: string
  message: string
  diff: string
}

/** `--max-count` used by `runLog` when the caller doesn't pass one explicitly. */
const DEFAULT_LOG_MAX_COUNT = 20

/**
 * Parse `git log -L <range>:<file>` stdout into one entry per matching commit. Each commit
 * block starts with a `commit <sha40>` line and runs up to (but not including) the next
 * `commit <sha40>` line or end of output. Within a block: `Author:`/`Date:` come verbatim from
 * their header lines; the commit message is every line between the header block and the first
 * `diff --git` line, with git's 4-space indent stripped; everything from `diff --git` onward is
 * kept as the raw per-commit diff text. Unlike `splitDiffHunks`, this makes no attempt to
 * further parse the diff body -- `git log -L` already scopes each commit's diff to just the
 * requested line range, so there is no hunk-vs-symbol-range intersection left to do.
 *
 * Edge cases this has to tolerate: a symbol added in its very first commit still gets a normal
 * entry (the diff is a pure-addition hunk, same shape as any other); a symbol that was added
 * and never touched again simply yields a single entry; a merge or rename commit still starts
 * with a `commit <sha40>` header, so it parses the same as any other entry (its diff body may
 * just look different, which this function doesn't inspect).
 */
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
    // Scan the header block (Author/Date/blank/indented message lines) until either the diff
    // body starts or the next commit block begins -- whichever comes first.
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

/**
 * Handle ``token-goat log "file::symbol" [ref]`` -- git commit history scoped to one symbol's
 * indexed line range, via git's own `git log -L <start>,<end>:<file>` line-range history
 * feature, instead of a raw `git log -- file` dump of every commit that ever touched the whole
 * file. Resolves the spec exactly like `runDiff` (same ambiguous/none error shapes, via
 * `resolveSymbolSpec`). Unlike `runDiff`, no manual hunk-vs-symbol-range intersection is
 * needed here: `-L` tracks the requested line range through history itself, adjusting line
 * numbers for earlier commits that shifted content above/below the range -- far more accurate
 * than intersecting per-commit diffs against a fixed range after the fact.
 */
export function runLog(opts: LogOptions): number {
  const match = resolveSymbolSpecOrEmitError('log', opts.spec, opts.projectRoot)
  if (match === null) return 1
  const cwd = opts.projectRoot ?? process.cwd()
  const maxCount = opts.maxCount ?? DEFAULT_LOG_MAX_COUNT

  // No `--` pathspec separator here (unlike runDiff's `git diff`) -- `-L<range>:<file>` already
  // embeds the file, and git log rejects a `-L<range>:<file>` combined with a separate pathspec.
  const logArgs = [
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
    emitErr(`git log failed: ${logResult.stderr}`)
    return 1
  }

  if (logResult.stdout.trim() === '') {
    emit(`No history for '${match.name}' (lines ${match.lineStart}-${match.lineEnd}) in '${match.filePath}'.`)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(parseLogDashLOutput(logResult.stdout))
    emit(
      JSON.stringify(
        {
          symbol: match.name,
          file: match.filePath,
          lineStart: match.lineStart,
          lineEnd: match.lineEnd,
          commits: capped.items,
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
  emit(guardText([header, logResult.stdout].join('\n'), 'diff'))
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
    // Same {items, truncated, totalCount} envelope guardJsonRows uses for symbol/refs/skeleton/
    // outline's --json mode -- a bare truncated array here would silently hand a JSON consumer
    // fewer hits than actually matched with no way to tell "capped by --max-lines" apart from
    // "there just weren't more".
    const payload: JsonRowCapResult<GrepHit> = { items: truncated, truncated: hits.length > maxLines, totalCount: hits.length }
    emit(JSON.stringify(payload, null, 2))
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

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(e)) {
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
  // A file that is neither readable from disk nor present in the index is a bad path (typo,
  // wrong cwd), not a file that legitimately has zero exports -- report it the same way
  // imports/deps already do. A file indexed but since deleted from disk must NOT hit this
  // branch: `symbols` still has rows for it, so the command falls through and reports from the
  // index instead of erroring.
  if (text === null && symbols.length === 0) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
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
 * Split `s` on top-level commas only, ignoring commas nested inside `{...}` groups. Used to
 * enumerate a Rust `use` brace group's selectors without splitting inside a nested group
 * (`io::{self, Read}` inside `std::{fs, io::{self, Read}}` must stay one selector).
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim() !== '') parts.push(cur)
  return parts
}

/**
 * Expand a Rust `use base::{selector, selector, ...}` brace group into one fully-qualified
 * target per selector, recursing into nested groups (`std::{fs, io::{self, Read}}` ->
 * `std::fs`, `std::io`, `std::io::Read`). `self` resolves to `base` itself (the group's own
 * module), and a rename (`Read as R`) resolves to the original name, matching what call sites
 * actually reference.
 */
function expandRustUseGroup(base: string, inner: string): string[] {
  const results: string[] = []
  for (const part of splitTopLevelCommas(inner)) {
    const trimmed = part.trim()
    if (trimmed === '' || trimmed === 'self') {
      if (trimmed === 'self') results.push(base)
      continue
    }
    const nested = /^([\w:]+)::\{([\s\S]*)\}$/.exec(trimmed)
    if (nested) {
      results.push(...expandRustUseGroup(`${base}::${nested[1] ?? ''}`, nested[2] ?? ''))
      continue
    }
    const name = (trimmed.split(/\s+as\s+/)[0] ?? '').trim()
    if (name === '' || name === 'self') { results.push(base); continue }
    results.push(`${base}::${name}`)
  }
  return results
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

  // `.mts`/`.cts` (explicit-ESM/explicit-CJS TypeScript sources) are real, recognized source
  // extensions elsewhere in this codebase -- parser_types.ts's EXTENSION_LANGUAGE map and
  // ts_refs.ts's TS_EXTENSIONS both already treat them as TypeScript -- but this list omitted
  // them, so a .mts/.cts file's imports fell through to the far weaker generic
  // `import|require|use|#include` fallback below instead of the dedicated multi-form TS/JS
  // matcher (fromRe/bareRe/reqRe/dynRe).
  // `.vue`/`.svelte`/`.astro` single-file components embed plain ES-module import syntax inside
  // their `<script>` (or, for Astro, `---` frontmatter) block -- previously listed in the generic
  // fallback's own doc comment as one of the languages it was expected to cover, but that
  // fallback's capture class `[^'">;]+` does not stop at `{`, so a named import
  // (`import { ref } from 'vue'`) fabricated the non-actionable blob "{ ref } from 'vue" instead
  // of the real target "vue", and a default import (`import Foo from './Foo.vue'`) fared no
  // better ("Foo from"). Routing these three extensions through the same multi-form TS/JS matcher
  // used above extracts the real module targets; it operates on whole-file text already (not
  // scoped to the script block), but import/require syntax doesn't otherwise occur in the
  // surrounding template/markup, so this is safe.
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'].includes(e)) {
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
      if (imp) {
        // Drop a trailing `#` line comment before splitting -- a module name never contains `#`,
        // so anything from the first one is a comment (`import os  # the os module`), not part of
        // the module. Without this the comment text is folded into the module name for the common
        // no-alias case (the `as`-split below only incidentally strips it when an alias is present).
        const spec = (imp[1] ?? '').split('#')[0] ?? ''
        for (const part of spec.split(',')) push(part.trim().split(/\s+as\s+/)[0])
      }
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
    // The optional visibility prefix must also cover Rust's restricted-visibility forms
    // (`pub(crate) use`, `pub(super) use`, `pub(in crate::x) use`) -- all idiomatic for scoped
    // re-exports -- not just bare `pub use`. A plain `pub\s+` can't consume the `(crate)`/`(super)`
    // parenthetical, so `use` never sat at the anchored position and every restricted-visibility
    // re-export silently reported zero imports/deps.
    for (const line of lines) {
      // `use std::{fs, io};` -- Rust's idiomatic multi-selector grouped import, at least as
      // common as the plain form -- previously fell through to the bare-use branch below, whose
      // `[^;{]+` character class stops at `{` and so captured only the truncated,
      // non-actionable prefix `std::` while silently dropping every selector actually imported
      // (the same brace-truncation gap already fixed for Scala's `import foo.{A, B}`).
      const groupM = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::\{([\s\S]*)\}/.exec(line)
      if (groupM) {
        for (const t of expandRustUseGroup(groupM[1] ?? '', groupM[2] ?? '')) push(t)
        continue
      }
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;{]+)/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.java') {
    for (const line of lines) {
      const m = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(line)
      if (m) { push(m[1]); continue }
      // `module foo.bar { requires baz.qux; }` -- a JPMS module-info.java's declared module
      // dependencies -- use a keyword ("requires") this branch's `import`-only regex never
      // matches, so a module-info.java (the authoritative dependency list for a Java 9+ module)
      // silently reported zero imports/deps despite it being the one file where that list is
      // actually declared.
      const req = /^\s*requires\s+(?:transitive\s+|static\s+)*([\w.]+)\s*;/.exec(line)
      if (req) push(req[1])
    }
  } else if (e === '.rb' || e === '.rake') {
    // `.rake` (Rake task files) is plain Ruby, sharing this file's `require_relative` form --
    // without `.rake` here, extractImports fell through to the generic `import|require|use`
    // fallback below, which matches bare `require 'x'` but not `require_relative 'x'` (the
    // `_relative` suffix breaks the fallback's `require\s+` anchor), silently dropping the
    // idiomatic `require_relative 'lib/foo'` pattern from every `.rake` file's import list.
    for (const line of lines) {
      const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (e === '.cs') {
    // C# `using` directives don't fall through to the generic `import|require|use|#include`
    // fallback branch below - "using" doesn't contain "use" as a substring (u-s-i vs u-s-e), so
    // without this branch every .cs file silently reported zero imports/deps despite csharp.ts's
    // language adapter (USING_RE) already extracting these same directives for the symbol index.
    // The optional `global\s+` prefix covers C# 10's file-scoped implicit usings (`global using
    // System;`), idiomatically consolidated into a single GlobalUsings.cs -- without it, a
    // global-using file (a real, common file shape in any modern .NET project) silently
    // reported zero imports, mirroring the same fix in csharp.ts's USING_RE.
    // The optional trailing `(?:=\s*(...))?` covers a `using` *alias* directive (`using Project
    // = PC.MyCompany.Project;` / `using MyList = System.Collections.Generic.List<int>;`), a
    // common form for disambiguating or shortening a long/colliding namespace or type. Without
    // it, the plain capture group's `\s*;` had to sit immediately after the alias name, but a
    // real alias line has ` = <target>;` there instead -- the whole regex failed to match at
    // all (not just truncated), so an aliased using directive silently reported zero
    // imports/deps. When an alias target is present, push it (the real dependency) rather than
    // the local alias name, mirroring how other alias-bearing branches above (Kotlin's `as`,
    // Rust's `as`) resolve to the referenced target, not the local binding.
    for (const line of lines) {
      const m = /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*(?:=\s*([\w.<>,\s]+))?\s*;/.exec(line)
      if (m) push(m[2] ?? m[1])
    }
  } else if (e === '.php') {
    // PHP's require_once/include_once are the idiomatic form (avoids double-inclusion) -- far
    // more common in real code than bare require/include -- but the generic `import|require|
    // use|#include` fallback below requires whitespace immediately after the matched keyword,
    // so "require_once 'x.php'" never matches at all (the `_once` suffix sits where `\s+` is
    // expected): every require_once/include_once line silently reported zero imports/deps.
    // Mirrors php.ts's REQUIRE_RE/USE_RE, which already extract these same directives correctly
    // for the symbol index. The optional `\(?` / trailing `\)?` also cover the equally common
    // function-call form `require_once('x.php')`, which the earlier whitespace-only pattern
    // still missed even after fixing the bare form.
    for (const line of lines) {
      const req = /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/.exec(line)
      if (req) { push(req[1]); continue }
      // `use App\{Foo, Bar};` -- PHP 7's group-use declaration, idiomatic when importing
      // several classes from one namespace -- never matched the plain `use` regex below at all:
      // its `[\w\\]+` char class stops at `{`, leaving `{Foo, Bar}` where `(?:\s+as\s+\w+)?\s*;`
      // is anchored, so the whole line was silently dropped (not merely truncated). Mirrors
      // php.ts's GROUP_USE_RE, which has the same fix for the symbol index.
      const groupUse = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)\\\{([^}]*)\}/.exec(line)
      if (groupUse) {
        const base = groupUse[1] ?? ''
        for (const part of (groupUse[2] ?? '').split(',')) {
          const trimmed = part.trim().replace(/^(?:function|const)\s+/, '')
          if (trimmed === '') continue
          const name = (trimmed.split(/\s+as\s+/)[0] ?? '').trim()
          if (name !== '') push(`${base}\\${name}`)
        }
        continue
      }
      // `use function Foo\bar;` / `use const Foo\BAR;` -- PHP 7's single-symbol imports;
      // without the optional prefix, `([\w\\]+)` captured "function"/"const" as the target and
      // then failed to match the trailing `;`, silently dropping the whole line. Mirrors
      // php.ts's USE_RE, which has the same fix for the symbol index.
      const use = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*;/.exec(line)
      if (use) push(use[1])
    }
  } else if (['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'].includes(e)) {
    for (const line of lines) {
      const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.sh', '.bash'].includes(e)) {
    // Bash's idiomatic cross-file dependency mechanism is sourcing another script, via either
    // the `source foo.sh` builtin or the POSIX dot form `. foo.sh` -- neither matches the generic
    // `import|require|use|#include` fallback below: "source" isn't in its keyword set at all, and
    // a bare `.` isn't a word character for the fallback's lookbehind/keyword match to key off.
    // So every .sh/.bash file silently reported zero imports/deps despite sourcing being the one
    // real cross-file dependency shell scripts actually have. Anchored at line start (mirrors the
    // other line-anchored branches above) since mid-line `source`/`.` usage is far rarer than the
    // idiomatic standalone form.
    for (const line of lines) {
      const m = /^\s*(?:source|\.)\s+['"]?([^\s'";]+)['"]?/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.ps1', '.psm1'].includes(e)) {
    // PowerShell's idiomatic import forms ("Import-Module Foo", "using module Foo") don't fall
    // through to the generic `import|require|use|#include` fallback below: PowerShell keywords
    // are case-insensitive and commonly capitalized ("Import-Module"), but the fallback regex is
    // lowercase-only, and "using" doesn't contain "use" as a substring (u-s-i vs u-s-e) -- the
    // same reason .cs's `using` directives needed their own branch. Without this, every .ps1/
    // .psm1 file silently reported zero imports/deps.
    for (const line of lines) {
      const importMod = /^\s*Import-Module\s+(?:-Name\s+)?['"]?([^\s'";]+)/i.exec(line)
      if (importMod) { push(importMod[1]); continue }
      const usingMod = /^\s*using\s+module\s+['"]?([^\s'";]+)/i.exec(line)
      if (usingMod) { push(usingMod[1]); continue }
      const dotSource = /^\s*\.\s+['"]?([^\s'";]+\.psm?1)['"]?\s*$/i.exec(line)
      if (dotSource) push(dotSource[1])
    }
  } else if (e === '.mk') {
    // GNU/BSD Make's `include`/`-include`/`sinclude` directives are this language's exact
    // analogue of an import statement, but "include" (no leading `#`) doesn't match the generic
    // `import|require|use|#include` fallback's `#include` alternative -- the same
    // substring-mismatch gap already fixed for .cs's `using` and .ps1's `Import-Module`. Without
    // this branch every Makefile silently reported zero imports/deps despite `include` being
    // idiomatic for splitting a build into multiple .mk files. `runImports`/`runDeps` map a bare
    // `Makefile`/`GNUmakefile`/`BSDmakefile` basename (no real extension) to this synthetic
    // `.mk` key via {@link importsExtensionFor} so those files reach this branch too.
    // Directive lines are ` *`-indented (spaces only, never a leading tab -- a tab-indented line
    // is always a recipe handed to the shell, never a make directive, mirroring
    // makefile_idx.ts's DEFINE_LINE_RE guard), and may list multiple targets on one line
    // (`include foo.mk bar.mk`).
    for (const line of lines) {
      const m = /^ *(?:-include|sinclude|include)\s+(.+)$/.exec(line)
      if (m) {
        // Drop a trailing `#` comment before splitting targets on whitespace -- Make treats `#`
        // as a comment start, so without this each comment word (and the bare `#`) is mis-extracted
        // as a phantom include target (`include config.mk # optional` -> config.mk, #, optional).
        const targets = (m[1] ?? '').split('#')[0] ?? ''
        for (const target of targets.split(/\s+/)) push(target)
      }
    }
  } else if (e === '.zig') {
    // Zig's sole import mechanism is the `@import("path")` builtin, which the generic
    // `import|require|use|#include` fallback below never matches: the `@` prefix and the `(`
    // that immediately follows `import` (rather than the `\s+` the fallback requires) both
    // block it, so every .zig file silently reported zero imports/deps despite zig.ts already
    // indexing the file's symbols -- the same substring/whitespace-mismatch gap already fixed
    // for .cs's `using`, .ps1's `Import-Module`, and .mk's `include`. Multiple `@import` calls
    // can share a line (e.g. two `const x = @import(...)` statements), so scan globally.
    for (const line of lines) {
      const re = /@import\s*\(\s*"([^"]+)"\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (e === '.r') {
    // R loads packages/files via the call forms `library(pkg)`, `require(pkg)` (both accept the
    // name bare or quoted) and `source("file.R")` -- none of which the generic
    // `import|require|use|#include` fallback below matches: `library`/`source` aren't in its
    // keyword set at all, and `require(` puts a `(` where the fallback's `\s+` is expected. So
    // every .r file silently reported zero imports/deps despite r.ts already indexing its
    // symbols. Match the call anywhere on the line (nested forms like
    // `suppressMessages(library(x))` are idiomatic) and capture the first argument.
    for (const line of lines) {
      const re = /\b(?:library|require|source)\s*\(\s*["']?([A-Za-z0-9_./\\-]+)["']?/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (e === '.lua') {
    // Lua's idiomatic module load is `require("mod")` -- the parenthesized, quoted form. The
    // generic `import|require|use|#include` fallback only matches the paren-LESS `require "mod"`
    // (its `\s+` can't precede the `(`), so the far more common `require("mod")`/`require('mod')`
    // form reported zero imports/deps despite lua.ts already indexing the file's symbols. Accept
    // both an optional `(` and either quote style, and scan globally (a line can require twice).
    for (const line of lines) {
      const re = /\brequire\s*\(?\s*["']([^"']+)["']/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) push(m[1])
    }
  } else if (['.scala', '.sc'].includes(e)) {
    // Scala's idiomatic multi-selector import (`import foo.bar.{A, B, C}`) isn't handled by the
    // generic `import|require|use|#include` fallback below: its capture class `[^'">;]+` doesn't
    // stop at `{`, so the whole grouped form is captured verbatim as one non-actionable blob
    // (`foo.bar.{A, B, C}`) instead of the three real import targets actually being imported --
    // the same brace-truncation gap already fixed for scala.ts's symbol-index extractor and for
    // Rust's `use foo::{A, B}` here above. Mirrors scala.ts's BRACE_IMPORT_RE/IMPORT_RE handling:
    // a selector may be a rename (`Old => New`, resolved to the left-hand original, matching what
    // call sites actually reference) or the wildcard `_` (kept as `base._` rather than a bogus
    // per-underscore entry).
    for (const line of lines) {
      const stripped = line.trim()
      const braceM = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)\.\{([^}]*)\}/.exec(stripped)
      if (braceM) {
        const base = braceM[1] ?? ''
        for (const sel of (braceM[2] ?? '').split(',')) {
          const original = sel.trim().split(/\s*=>\s*/)[0]?.trim() ?? ''
          if (original === '') continue
          push(original === '_' ? `${base}._` : `${base}.${original}`)
        }
        continue
      }
      const m = /^import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\._)?)/.exec(stripped)
      if (m) push(m[1])
    }
  } else if (['.ex', '.exs'].includes(e)) {
    // Elixir references other modules via `alias`/`import`/`require`/`use`. The generic
    // `import|require|use|#include` fallback catches the last three, but NOT `alias` -- the most
    // common cross-module form in idiomatic Elixir -- so aliased dependencies were silently
    // dropped despite elixir.ts already indexing the file's symbols. Handle all four here, and
    // expand the grouped `alias Foo.{Bar, Baz}` form into `Foo.Bar`/`Foo.Baz` rather than
    // capturing a truncated `Foo.` prefix.
    for (const line of lines) {
      const m = /^\s*(?:alias|import|require|use)\s+([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*)(?:\.\{([^}]*)\})?/.exec(line)
      if (m === null) continue
      const base = m[1] ?? ''
      const group = m[2]
      if (group !== undefined && group.trim() !== '') {
        for (const part of group.split(',')) push(`${base}.${part.trim()}`)
      } else {
        push(base)
      }
    }
  } else if (['.kt', '.kts'].includes(e)) {
    // Kotlin's own symbol/import extractor (kotlin.ts's IMPORT_RE) stops matching once the
    // import path itself ends, so an aliased import (`import foo.Bar as Baz`, idiomatic when two
    // imported names collide) resolves to the clean "foo.Bar". The generic
    // `import|require|use|#include` fallback below has no such stop condition -- its greedy
    // `[^'">;]+` capture class happily swallows the trailing " as Baz" too, so it reported the
    // whole "foo.Bar as Baz" as a single, non-actionable import target instead of the real
    // dependency, diverging from what the symbol index itself already extracts for the same
    // file. Mirrors kotlin.ts's IMPORT_RE exactly (including its wildcard-import support) so
    // `token-goat imports`/`deps` agrees with the symbol index.
    const re = /^import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\.\*)?)/
    for (const line of lines) {
      const m = re.exec(line.trim())
      if (m) push(m[1])
    }
  } else if (e === '.swift') {
    // Same gap as Kotlin above, mirrored from swift.ts's IMPORT_RE: Swift's submodule-import
    // form (`import class UIKit.UIView`, importing just one member of a module) has its leading
    // keyword (class/struct/enum/protocol/func/var/let/typealias) consumed by the dedicated
    // extractor before the real target is captured, but the generic
    // `import|require|use|#include` fallback below has no such stop condition and greedily
    // captures "class UIKit.UIView" verbatim as the import target instead of the real
    // "UIKit.UIView" dependency -- diverging from the symbol index for the same file.
    const re =
      /^(?:@testable\s+)?import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/
    for (const line of lines) {
      const m = re.exec(line.trim())
      if (m) push(m[1])
    }
  } else if (e === '.hs') {
    // Haskell's `import` line commonly carries leading modifiers before the real module target --
    // `qualified` (by far the most idiomatic form for a name-colliding import) and Safe Haskell's
    // `safe`, in either order (`import qualified Data.Map as Map`, `import safe qualified
    // Data.Set as Set`), or GHC 9's postfix `import Data.Map qualified as Map`. The generic
    // `import|require|use|#include` fallback below has no stop condition for any of this: its
    // greedy `[^'">;]+` capture class swallows the whole rest of the line verbatim ("qualified
    // Data.Map as Map") as a single, non-actionable import target instead of the real "Data.Map"
    // dependency -- the same keyword-swallowing gap already fixed for Kotlin's `as`-alias and
    // Swift's submodule-import forms above. `hiding`/`(selectors)` clauses are dropped the same
    // way those two branches drop their own trailing modifiers -- the capture class stops at the
    // first non-identifier character after the module path.
    const re = /^import\s+(?:safe\s+)?(?:qualified\s+)?([A-Za-z_][A-Za-z0-9_.']*)/
    for (const line of lines) {
      const m = re.exec(line.trim())
      if (m) push(m[1])
    }
  } else if (['.tf', '.tfvars', '.hcl'].includes(e)) {
    // Terraform's dependency mechanism is module composition (`module "foo" { source =
    // "./modules/foo" }`), not an import/require/use keyword -- the generic
    // `import|require|use|#include` fallback below has no keyword that matches "source" at all,
    // so every .tf/.tfvars/.hcl file reported zero imports/deps despite this being the one
    // idiomatic cross-file dependency Terraform actually has.
    for (const line of lines) {
      const m = /^\s*source\s*=\s*"([^"]+)"/.exec(line)
      if (m) push(m[1])
    }
  } else if (['.css', '.scss', '.sass', '.less'].includes(e)) {
    // CSS/Sass/Less `@import` accepts a bare-quoted form (`@import "x.css";`) the generic
    // fallback below happens to match correctly (its "import" substring-match lines up with the
    // quote), but also the `url(...)` function form (`@import url("x.css");` / bare
    // `@import url(x.css);`) that the fallback mangles: its capture class excludes quotes/`>`/`;`
    // but not `(`/`)`, so it captures the literal text `url(` or `url(x.css)` instead of the path
    // inside. Sass's `@use`/`@forward` module directives (a distinct keyword the fallback's
    // `import|require|use|#include` set doesn't cover as its own alternative, though "use" as a
    // substring of "@use" happens to still match) are also handled explicitly here for clarity.
    for (const line of lines) {
      const urlForm = /@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(line)
      if (urlForm) { push(urlForm[1]); continue }
      if (/^\s*@import\b/.test(line)) {
        // Legacy CSS/Sass allows several comma-separated targets on one @import line
        // (`@import "reset", "base", "layout";`); a single `.exec()` capturing one quoted
        // group would silently drop every target after the first, so scan globally for every
        // quoted segment on the line instead.
        const re = /['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        let any = false
        while ((m = re.exec(line)) !== null) { push(m[1]); any = true }
        if (any) continue
      }
      const useForward = /@(?:use|forward)\s+['"]([^'"]+)['"]/.exec(line)
      if (useForward) push(useForward[1])
    }
  } else if (['.graphql', '.gql'].includes(e)) {
    // GraphQL's idiomatic cross-file dependency mechanism is the `# import` pragma
    // (`# import FragmentName from "./someFragment.graphql"`) -- graphql_idx.ts's own
    // GRAPHQL_IMPORT_RE already extracts this as an AdapterImport for the symbol index -- but
    // this generic keyword-substring fallback below mismatches it the same way the .vue/.svelte
    // named-import fallback used to (fixed in 626fa5bc): the pragma has free-form text
    // ("FragmentName from ") between the `import` keyword and the quoted path, and the fallback's
    // capture class `[^'">;]+` starts capturing right after `import` (there's no quote directly
    // after it) instead of at the actual quoted target, so it fabricated the non-actionable blob
    // "FragmentName from " instead of the real target "./someFragment.graphql". Mirrors
    // GRAPHQL_IMPORT_RE's shape (optional leading whitespace, `#`, optional whitespace, `import`,
    // then anything up to the first quote) so `token-goat imports`/`deps` agrees with the symbol
    // index.
    const re = /^[ \t]*#[ \t]*import\b(?:[^"'\n]*)?['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(m[1])
  } else if (e === '.liquid') {
    // Liquid's `{% include %}`/`{% render %}`/`{% section %}` tags are its idiomatic cross-file
    // dependency mechanism -- liquid.ts's own INCLUDE_RE/RENDER_RE/SECTION_RE already extract
    // these same tags as AdapterImport entries for the symbol index -- but none of
    // "include"/"render"/"section" match the generic `import|require|use|#include` fallback
    // below: there's no leading `#`, and none of those three words is itself "import"/"require"/
    // "use" as a substring, the same keyword-mismatch gap already fixed for .cs's `using`, .ps1's
    // `Import-Module`, .mk's `include`, and .tf's `source =`. Without this branch every .liquid
    // file silently reported zero imports/deps. Mirrors liquid.ts's own regex shape (an
    // optional `-` for whitespace-control tags, either quote style) so `token-goat
    // imports`/`deps` agrees with the symbol index.
    const re = /{%-?\s*(?:include|render|section)\s+(['"])((?:(?!\1)[\s\S])+?)\1/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) push(m[2])
  } else {
    // Covers languages with no dedicated branch above (Dart, Apex, HTML,
    // Proto, SQL, Vue/Svelte/Astro, ...) whose import syntax happens to use one of
    // these bare keywords. The negative lookbehind guards against the keyword appearing as a
    // substring of an unrelated word -- without it, "use" inside "because"/"house"/"reuse" (or
    // any prose/comment containing one) matched just as readily as a real `use Foo.Bar`
    // directive, fabricating phantom import entries. `#include`'s leading `#` is itself already
    // a non-word character, so the lookbehind (which only excludes a *word* char immediately
    // before the match) doesn't block it.
    for (const line of lines) {
      const m = /(?<![A-Za-z0-9_])(?:import|require|use|#include)\s+['"<]?([^'">;]+)/.exec(line)
      if (m) push(m[1])
    }
  }
  return found
}

/**
 * {@link extractImports}'s dispatch key, derived from `filePath` rather than a bare
 * `path.extname()` call: a `Makefile`/`GNUmakefile`/`BSDmakefile` (mirrors parser_types.ts's
 * FILENAME_LANGUAGE basename map) has no real file extension, so `path.extname()` alone always
 * yields `''` for it -- routing to extractImports' generic fallback, which requires a literal
 * `#include` and never matches Make's own `include`/`-include`/`sinclude` directives. Maps such
 * a basename to the synthetic `.mk` key extractImports' Makefile branch dispatches on; every
 * other path falls through to its real `path.extname()`.
 */
export function importsExtensionFor(filePath: string): string {
  const base = path.basename(filePath).toLowerCase()
  if (base === 'makefile' || base === 'gnumakefile' || base === 'bsdmakefile') return '.mk'
  return path.extname(filePath)
}

/** Handle ``token-goat imports file``. */
export function runImports(opts: ImportsExportsOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  const imports = extractImports(text, importsExtensionFor(opts.file))

  if (imports.length === 0) {
    emit(`No imports found in '${opts.file}'`)
    return 0
  }

  const fullSourceBytes = sumFileSizes([opts.file])

  if (opts.json === true) {
    const capped = guardJsonRows(imports)
    const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2)
    emit(jsonText)
    recordReadStat('imports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = imports.map((imp) => `import  ${imp}`)
  for (const line of outLines) {
    emit(line)
  }
  recordReadStat('imports', fullSourceBytes, outLines.join('\n'), opts.file)
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
  /** Emit machine-readable JSON instead of the human-formatted preview blocks, matching every other surgical-read command's --json convention (symbol, skeleton, outline, refs). */
  json?: boolean
}

// Ported from cli.ts's cmdSemantic, which used to throw a CliError (caught by the generic
// `guard` wrapper, which prefixes it with "token-goat: " before printing to stderr) on a
// no-matches miss instead of returning a code. The "token-goat: " prefix is baked into the
// returned text here so the CLI's output stays byte-identical to that historical path.
async function runSemantic(query: string, opts: SemanticOptions): Promise<{ text: string; code: number }> {
  // Same reasoning as runSymbol above: a limit of 0 (or negative) would silently query for
  // zero results instead of surfacing a clear "you asked for nothing" error.
  if (opts.limit !== undefined && opts.limit <= 0) {
    const message = `--limit must be a positive number, got: ${opts.limit}`
    if (opts.json === true) {
      return { text: JSON.stringify({ error: message }, null, 2), code: 1 }
    }
    return { text: message, code: 1 }
  }

  const n = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : 20

  // A caller-supplied projectRoot must be an absolute, existing directory -- otherwise
  // searchSemantic silently finds nothing under the bogus root and this function falls back to
  // the (now project-scoped) FTS search using that same bogus root, which also finds nothing,
  // and the caller gets a plain "no matches" instead of a clear signal that the scope they asked
  // for doesn't exist. Fail loudly instead of silently widening/losing scope.
  if (opts.projectRoot !== undefined) {
    if (!path.isAbsolute(opts.projectRoot) || !fs.existsSync(opts.projectRoot) || !fs.statSync(opts.projectRoot).isDirectory()) {
      const message = `token-goat: projectRoot must be an absolute, existing directory, got '${opts.projectRoot}'`
      if (opts.json === true) {
        return { text: JSON.stringify({ error: message }, null, 2), code: 1 }
      }
      return { text: message, code: 1 }
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
    if (opts.json === true) {
      const items = hits.map((h) => ({
        filePath: h.filePath,
        name: null,
        kind: null,
        startLine: h.startLine,
        endLine: h.endLine,
        distance: h.distance,
        preview: previewLines(h.text, 3),
      }))
      // Same {items, truncated, totalCount} envelope guardJsonRows returns for symbol/refs/
      // skeleton/outline's --json mode (see the comment at the grep --json call site) -- a bare
      // {source, items} payload would silently hand a JSON consumer fewer hits than actually
      // matched with no way to tell "capped by the overflow guard" apart from "there just
      // weren't more", and would let `--limit 500 --json` emit an unbounded payload.
      const capped = guardJsonRows(items)
      const text = JSON.stringify({ source: 'embeddings', ...capped }, null, 2)
      recordReadStat('semantic_search', sumFileSizes(hits.map((h) => h.filePath)), text, query)
      return { text, code: 0 }
    }
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
    if (opts.json === true) {
      const text = JSON.stringify({ source: 'fts', items: [], truncated: false, totalCount: 0 }, null, 2)
      return { text, code: 1 }
    }
    return { text: `token-goat: no matches for '${query}'`, code: 1 }
  }
  if (opts.json === true) {
    const items = results.map((s) => ({
      filePath: s.filePath,
      name: s.name,
      kind: s.kind,
      startLine: s.lineStart,
      endLine: s.lineEnd,
      distance: null,
      preview: previewLines(s.body, 3),
    }))
    const capped = guardJsonRows(items)
    const text = JSON.stringify({ source: 'fts', ...capped }, null, 2)
    recordReadStat('semantic_search', sumFileSizes(results.map((s) => s.filePath)), text, query)
    return { text, code: 0 }
  }
  const blocks = results.map((s) => `${symbolHeader(s)}\n${previewLines(s.body, 3)}`)
  const text = guardText(blocks.join('\n\n'), 'semantic')
  recordReadStat('semantic_search', sumFileSizes(results.map((s) => s.filePath)), text, query)
  return { text, code: 0 }
}


// ---- notes (note-get / note-list) -------------------------------------------
//
// note-add is a write (like insert-section/replace) and lives in cli.ts alongside those
// sibling write commands; note-get/note-list are read-only surgical extraction, following
// the same run*(opts) => { text, code } convention every other read command in this file uses.

export interface NoteGetOptions {
  file: string
  symbol?: string
  json?: boolean
  projectRoot?: string
}

/**
 * `token-goat note-get <file> [--symbol NAME]`: read back the note attached to a file (or one
 * specific indexed symbol within it), flagging whether it has gone stale (see notes.ts's
 * isNoteStale) since it was written. A miss reports which attachment point was searched rather
 * than a bare "not found", since a note-get for the wrong --symbol (or a file with only a
 * whole-file note) is the most likely real-world miss.
 */
export function runNoteGet(opts: NoteGetOptions): { text: string; code: number } {
  const resolvedPath = resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())
  healStaleIndex(resolvedPath)
  const symbol = opts.symbol ?? WHOLE_FILE_NOTE_SYMBOL
  const note = getNote(resolvedPath, symbol)
  if (note === null) {
    const where = opts.symbol !== undefined ? ` for symbol '${opts.symbol}'` : ' (whole-file note)'
    return { text: `No note found for '${opts.file}'${where}`, code: 1 }
  }

  const stale = isNoteStale(note)
  if (opts.json === true) {
    const payload = {
      filePath: note.filePath,
      symbol: note.symbol === WHOLE_FILE_NOTE_SYMBOL ? null : note.symbol,
      content: note.content,
      stale,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    }
    const text = JSON.stringify(payload, null, 2)
    recordStat('note_read')
    return { text, code: 0 }
  }

  const target = note.symbol === WHOLE_FILE_NOTE_SYMBOL ? opts.file : `${opts.file}::${note.symbol}`
  const staleTag = stale ? ' [STALE — code changed since this note was written]' : ''
  const text = `# note — ${target}${staleTag}\n${note.content}`
  recordStat('note_read')
  return { text, code: 0 }
}

export interface NoteListOptions {
  staleOnly?: boolean
  json?: boolean
}

/**
 * `token-goat note-list [--stale-only]`: list every recorded architecture note, or (with
 * --stale-only) just the subset whose stored fingerprint no longer matches the current index --
 * i.e. the code they describe has changed since the note was written. Never deletes or rewrites
 * a note; this is a read-only discovery surface for the mechanical staleness signal.
 */
export function runNoteList(opts: NoteListOptions = {}): { text: string; code: number } {
  const withStale = listNotes().map((note) => ({ note, stale: isNoteStale(note) }))
  const filtered = opts.staleOnly === true ? withStale.filter((n) => n.stale) : withStale

  if (opts.json === true) {
    const items = filtered.map(({ note, stale }) => ({
      filePath: note.filePath,
      symbol: note.symbol === WHOLE_FILE_NOTE_SYMBOL ? null : note.symbol,
      stale,
      updatedAt: note.updatedAt,
    }))
    recordStat('note_list')
    return { text: JSON.stringify(items, null, 2), code: 0 }
  }

  recordStat('note_list')
  if (filtered.length === 0) {
    return { text: opts.staleOnly === true ? 'No stale notes.' : 'No notes recorded.', code: 0 }
  }
  const lines = filtered.map(({ note, stale }) => {
    const target = note.symbol === WHOLE_FILE_NOTE_SYMBOL ? note.filePath : `${note.filePath}::${note.symbol}`
    return `${stale ? '[STALE] ' : ''}${target}`
  })
  return { text: lines.join('\n'), code: 0 }
}
export { querySymbols, queryRefs, readSection, listSections, extractSection, runSemantic }
