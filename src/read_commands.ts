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
import { redactIfDotenv } from './dotenv_redact.js'
import { querySymbols, queryRefs, queryRefCounts, searchSymbolsFts, getFileEntry, countSymbols, countRefs } from './index_reader.js'
import { normalizePath, resolveIndexPath, toDisplayPath } from './paths.js'
import { indexFileSync } from './parser.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { globalDbPath } from './constants.js'
import { IMPORT_RE as SWIFT_IMPORT_RE, stripLeadingAttributes as stripSwiftImportAttributes } from './languages/swift.js'
import { getDb } from './db.js'
import { fileIsAbsent, fingerprintFile } from './fingerprint.js'
import { searchSemantic, mergeNearbyHits, OVER_FETCH_FACTOR, MAX_OVER_FETCH, isAvailable as embeddingModelAvailable, type SearchHit } from './embeddings.js'
import { searchEvidenceSemantically } from './evidence_cache.js'
import { readSection, listSections, extractSection, findContainingSection } from './section_reader.js'
import type { SectionResult } from './section_reader.js'
import { decodeSource, runGit, ensureNewline, PER_FILE_COUNTERFACTUAL_CEILING, foldPath, escapeRegExp, compileGrepMatcher, grepFilteredToEmptyNotice, filtersFilteredToEmptyNotice, excludeTestsHiddenNote, countNoun, requireNonNegativeStrictInt, requirePositiveStrictInt, extractErrorMessage, buildContextWindow, renderContextWindow, isTestFile, type SourceContextLine } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { getDisplayRoot, isInsideRoot, resolveProjectRoot } from './project.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'
import { unsupportedLanguageName } from './parser_types.js'
import { loadConfig } from './config.js'
import { scanForInjectionPatterns, fenceUntrustedContent, UNTRUSTED_GITHUB_TAG } from './injection_scan.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { resolveCallers, enclosingSymbol, ALL_SYMBOLS_IN_FILE_LIMIT } from './graph_commands.js'
import type { CallerEntry } from './graph_commands.js'
import { queryCsv, formatCsvTable, parseWhereSpecs, profileCsv, formatCsvProfile } from './csv_query.js'
import { outlineJson, formatJsonOutline, queryJson } from './json_query.js'
import {
  outlineXml,
  formatXmlOutline,
  queryXml,
  xmlNodeToJson,
  serializeXmlNode,
  type XmlOutlineSummary,
} from './xml_query.js'
import { loadAll as loadAllYaml } from 'js-yaml'
import { parseOpenApiSpec, extractOperations, formatOpenApiOutline, findOperation, formatOperationDetail, operationLabel } from './openapi_query.js'
import {
  listZipEntries,
  extractZipEntry,
  formatZipList,
  ArchiveDependencyMissingError,
  type ZipEntry,
} from './archive_query.js'
import { MAX_ZIP_INPUT_BYTES, ZipInputTooLargeError, ZipOutputTooLargeError } from './zip_bounds.js'
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
import { extractPdfMeta, extractPdfOutline, extractPdfText, locatePdfPages, type PdfLocateMatch, type PdfMeta, type PdfOutlineEntry } from './pdf_extract.js'
import { isImagePath, probeImageMeta, shrinkImage, ImageDecodeError } from './image_shrink.js'
import { ocrImage, isTextHeavy, isOcrEngineAvailable } from './image_ocr.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat } from './stats.js'
import { WHOLE_FILE_NOTE_SYMBOL, getNote, isNoteStale, listNotes } from './notes.js'
import { isTsPath, resolveTypedRefs } from './ts_refs.js'
import { isIndexEmptyForProject, emptyIndexMessage } from './index_health.js'

// ---- constants --------------------------------------------------------------

const DIDYOUMEAN_LIMIT = 5
/** Body lines shown per `symbol` match before the preview is cut and the cut is announced. */
const SYMBOL_PREVIEW_LINES = 5
/** Qualified retries listed for an ambiguous `section` heading before the tail is summarized. Exported so `insert-section` refuses the same ambiguity with the same shape of message. */
export const AMBIGUOUS_HEADING_LIMIT = 10
// A query this long or longer gets a 2-edit typo budget; below it, 1. See typoBudget.
const TYPO_TWO_EDIT_MIN_LEN = 8
// Past this length a near-miss is no longer plausibly a typo of the same name, so the edit-distance fallback is skipped entirely.
const TYPO_MAX_QUERY_LEN = 64
const MIN_REVERSE_MATCH_LEN = 3 // reverse ("query contains symbol") containment only -- below this, short indexed names like `b`/`n` match nearly any query
const GREP_MAX_LINES = 200
// Symbol rows scanned when matching `find <pattern>` by substring — large enough to cover
// this tool's own index (thousands of symbols) without paging.
const FIND_SCAN_LIMIT = 20_000
// Caps for the JSON/YAML nested-key lookup that runs on a `symbol` miss. 128 KiB skips generated lockfiles (this repo's package-lock.json is ~302 KB) while still covering every hand-written manifest, and 12 files bounds the worst case at ~1.5 MiB of parsing on a path that already lost -- the node cap stops a pathologically deep document from turning a miss into a hang.
const STRUCTURED_MISS_MAX_BYTES = 128 * 1024
const STRUCTURED_MISS_MAX_FILES = 12
const STRUCTURED_MISS_MAX_NODES = 20_000

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

/**
 * Thrown when the identity of the file actually opened does not match the identity captured when
 * that path was validated -- i.e. the object behind the path was swapped between check and use.
 *
 * This is deliberately NOT swallowed by the `catch { return null }` fallbacks around it: a silent
 * "could not read" would make a detected confinement bypass indistinguishable from a missing file.
 */
export class ConfinementIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfinementIdentityError'
  }
}

// Identity pins for the confined read currently executing, keyed by canonical absolute path. Null for every CLI caller, which is the default: the optional chaining in the read helpers below short-circuits before pinKey() runs, so the non-MCP path costs exactly zero extra syscalls and zero extra work.
let activePins: ReadonlyMap<string, string> | null = null

/**
 * Sentinel pin value for a target the confinement gate validated as in-root but could not stat
 * (missing, or any other stat failure) at validation time -- so there is no dev:ino to pin. Absence
 * of a map entry means "confinement is off" or "this path was never gated"; this sentinel is the
 * distinct third state, "confined, in-root, but unpinnable", so a missing map entry can no longer
 * be misread as "unconfined" by a pin-aware read helper. Never collides with a real fileIdentity()
 * value, which is always `${bigint}:${bigint}` (digits and a colon only).
 */
export const ABSENT_PIN = 'ABSENT'

/** Canonical map key for an absolute path. Exported so mcp_server.ts pins with the exact same canonicalization the read side looks up with -- one function, so the two cannot drift the way a duplicated normalisation would. */
export function pinKey(absPath: string): string {
  const normalized = normalizePath(absPath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** `dev:ino` identity string for a bigint stat result. Bigint, not number: a Windows NTFS file index exceeds 2^53, so the ordinary numeric stat would truncate it and could collapse two distinct files onto one identity. */
export function fileIdentity(st: { readonly dev: bigint; readonly ino: bigint }): string {
  return `${st.dev}:${st.ino}`
}

/** Runs `fn` with `pins` installed as the active identity pins, restoring the PREVIOUS pins (not null) in a finally so nesting is safe. Every MCP tool handler is synchronous, so a module-scoped variable is sound here; do not make this async. */
export function withPinnedReads<T>(pins: ReadonlyMap<string, string> | null, fn: () => T): T {
  const previous = activePins
  activePins = pins
  try {
    return fn()
  } finally {
    activePins = previous
  }
}

/**
 * Opens `p`, verifies the OPENED DESCRIPTOR's identity against `pinned`, and returns its bytes.
 *
 * Checking the descriptor rather than the path is the whole point: the confinement gate validated
 * a path, and between that check and this open the path can be repointed at something outside the
 * root. fstat answers "what did I actually open", which a second path-based stat cannot.
 */
function readPinnedBytes(p: string, pinned: string): Buffer {
  // Deliberately a plain O_RDONLY, NOT O_NOFOLLOW. Adding O_NOFOLLOW here looks like free hardening and is not: measured on Linux, opening an ordinary in-root symlink with it fails ELOOP, which this function's caller turns into a silent "could not read" for a file the user is entitled to. It would also buy nothing, since the fstat identity comparison below -- not the open flags -- is what closes the check-vs-use window, and it resolves symlinks the same way the gate's stat did.
  const fd = fs.openSync(p, fs.constants.O_RDONLY)
  try {
    const actual = fileIdentity(fs.fstatSync(fd, { bigint: true }))
    if (actual !== pinned) {
      throw new ConfinementIdentityError(
        `refused: "${p}" changed identity between validation and read (validated ${pinned}, opened ${actual}). ` +
          'The file was replaced or redirected after the confinement check, so the read was not performed.',
      )
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Verifies `p`'s CURRENT identity (via an open+fstat, same technique as {@link readPinnedBytes})
 * matches `pinned`, without reading any content -- used for directories, where `readPinnedBytes`
 * itself cannot be reused because `fs.readFileSync` on a directory fails with EISDIR. Throws
 * {@link ConfinementIdentityError} on a mismatch; returns normally when it matches.
 */
function verifyPinnedIdentity(p: string, pinned: string): void {
  const fd = fs.openSync(p, fs.constants.O_RDONLY)
  try {
    const actual = fileIdentity(fs.fstatSync(fd, { bigint: true }))
    if (actual !== pinned) {
      throw new ConfinementIdentityError(
        `refused: "${p}" changed identity between validation and read (validated ${pinned}, opened ${actual}). ` +
          'The file was replaced or redirected after the confinement check, so the read was not performed.',
      )
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Verifies a target pinned as {@link ABSENT_PIN} is STILL absent from disk. Throws
 * {@link ConfinementIdentityError} when something now exists at `p` -- the create-after-
 * validated-absent race the negative pin exists to catch (an attacker names an in-root path that
 * does not exist yet, waits for the gate to validate it as absent-but-in-root, then creates an
 * out-of-root symlink there before the read runs). Returns normally when still absent, which the
 * caller then treats exactly like the pre-existing "no pin recorded" missing-file path.
 */
function verifyStillAbsent(p: string): void {
  if (fileExists(p)) {
    throw new ConfinementIdentityError(
      `refused: "${p}" was created after being validated as absent (validated missing, now present). ` +
        'Something was created at this path between the confinement check and the read, so the read was not performed.',
    )
  }
}

/** Dispatches a raw pin value to the right check: {@link ABSENT_PIN} verifies `p` is still absent (throwing on a create-after-validate swap), anything else verifies the live identity match via {@link verifyPinnedIdentity}. Shared by runGrep's two top-level-directory checks below so both stay in sync with how the file-read pin sites above interpret the sentinel. */
function verifyPin(p: string, pinned: string): void {
  if (pinned === ABSENT_PIN) {
    verifyStillAbsent(p)
    return
  }
  verifyPinnedIdentity(p, pinned)
}

/**
 * Pin-aware wrapper around `indexFileSync`, used by every read-command call site that can trigger
 * a mid-request reindex (healStaleIndex's self-heal, and each command's `--force-refresh`).
 * Without this wrapper, `indexFileSync` opens `resolvedPath` with its own independent
 * `fs.readFileSync`, which never consults `activePins` -- an MCP caller's confinement pin,
 * validated once against the path before the read command runs, is silently bypassed the moment
 * a stale-index heal or forced reindex kicks in, so a path swapped (e.g. an in-root symlink
 * repointed) between validation and that reindex is never caught. When a pin exists for
 * `resolvedPath`, this verifies it via the same fstat-identity check `readFileBytes` uses (a
 * ConfinementIdentityError propagates up exactly like every other pinned read), then hands the
 * already-verified bytes straight into `indexFileSync` so it never reopens the path itself. With
 * no active pin (every CLI caller, and every MCP call with confinement disabled), this is
 * byte-for-byte the pre-existing behavior: indexFileSync does its own read.
 */
function indexFileSyncPinned(resolvedPath: string, dbPath: string): void {
  const pinned = activePins?.get(pinKey(path.resolve(resolvedPath)))
  if (pinned === undefined) {
    indexFileSync(resolvedPath, dbPath)
    return
  }
  if (pinned === ABSENT_PIN) {
    // Throws if something now exists (the race); otherwise mirrors indexFileSync's own ENOENT
    // handling -- nothing to reindex.
    verifyStillAbsent(resolvedPath)
    return
  }
  let bytes: Buffer
  try {
    bytes = readPinnedBytes(resolvedPath, pinned)
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
    // Once a pin exists, never retry through the unpinned indexFileSync -- that would reopen
    // `resolvedPath` itself with a fresh, unverified fs.readFileSync, exactly the bypass the pin
    // exists to prevent. ENOENT is the one expected failure (the file was genuinely deleted since
    // validation): return cleanly, mirroring indexFileSync's own ENOENT handling. Any other open
    // failure (permission denied, replaced by a directory/device, etc.) is treated as a
    // confinement refusal instead of silently falling back to an unverified raw read.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ConfinementIdentityError(
      `refused: "${resolvedPath}" could not be opened for pinned re-index (${err instanceof Error ? err.message : String(err)}). ` +
        'The file may have changed since validation, so the read was not performed.',
    )
  }
  indexFileSync(resolvedPath, dbPath, bytes)
}

/**
 * Read a file's text for display.
 *
 * Every read command that prints file content comes through here, which is why the dotenv
 * redaction sits at this seam rather than in each command: `read`, `symbol` and the rest print a
 * slice of a live disk read, and the symbol table they slice against stores env keys with empty
 * bodies precisely because the values are not the model's business. A future read command gets
 * the same protection without having to remember it. Nothing here writes back to disk, so
 * redacting the returned text cannot corrupt a file. See dotenv_redact.ts.
 */
function readFileText(p: string): string | null {
  const pinned = activePins?.get(pinKey(path.resolve(p)))
  try {
    if (pinned === ABSENT_PIN) {
      verifyStillAbsent(p)
      return null
    }
    // decodeSource, not a plain utf-8 read: a UTF-16 file (what PowerShell 5.1 writes by default)
    // decodes to NUL-interleaved mojibake that is twice the size and useless to a reader.
    if (pinned !== undefined) return redactIfDotenv(p, decodeSource(readPinnedBytes(p, pinned)))
    return redactIfDotenv(p, decodeSource(fs.readFileSync(p)))
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
    return null
  }
}

/** Raw-bytes counterpart to {@link readFileText}, for binary formats (zip-format archives)
 * that must never be decoded as UTF-8 before parsing -- decoding first would corrupt any byte
 * sequence that isn't valid UTF-8, which is the common case for compressed/binary member data.
 *
 * The only callers are `zip-list`/`zip-read`, so the `MAX_ZIP_INPUT_BYTES` cap lives here rather
 * than in a general-purpose helper: this file's ZIP entries get decompressed downstream, and
 * DEFLATE's worst-case ~1032:1 ratio makes the on-disk (compressed) size the one lever available
 * to bound before any decompression happens at all (see zip_bounds.ts for the decompressed-side
 * bound). The unpinned path stats before reading, so an oversized file is never pulled into
 * memory; the pinned path reads via the fd `readPinnedBytes` already opened for its identity
 * check and rejects by the bytes actually returned; a compressed-input size cap does not carry
 * the same unbounded-allocation risk decompression does, so reading up to the limit before
 * rejecting on that path is an acceptable trade against duplicating `readPinnedBytes`'s fd
 * handling. */
function readFileBytes(p: string): Buffer | null {
  const pinned = activePins?.get(pinKey(path.resolve(p)))
  try {
    if (pinned === ABSENT_PIN) {
      verifyStillAbsent(p)
      return null
    }
    if (pinned !== undefined) {
      const bytes = readPinnedBytes(p, pinned)
      if (bytes.length > MAX_ZIP_INPUT_BYTES) throw new ZipInputTooLargeError(p, bytes.length, MAX_ZIP_INPUT_BYTES)
      return bytes
    }
    const stat = fs.statSync(p)
    if (stat.size > MAX_ZIP_INPUT_BYTES) throw new ZipInputTooLargeError(p, stat.size, MAX_ZIP_INPUT_BYTES)
    return fs.readFileSync(p)
  } catch (err) {
    if (err instanceof ConfinementIdentityError || err instanceof ZipInputTooLargeError) throw err
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

// Prepended instead of STALE_WARNING when the file is not on disk at all. fingerprintFile returns
// null for "deleted" and for "there but unreadable right now" alike, and staleWarning used to treat
// both as "nothing to say" -- so a read of a deleted file returned its indexed body, byte-identical
// to a live read, exit 0, with no sign the file was gone. That is the worst shape this tool can
// take: the caller goes on to edit or quote a file that no longer exists. Only a genuine absence
// gets this line; a lock or permission error still falls through silently, because that file really
// is still there and the index really may still match it.
const DELETED_WARNING =
  '⚠ DELETED: this file is no longer on disk — what follows is what the index last saw of it'

// The same fact as a suffix rather than a banner, for surfaces that render one line per match and
// cannot put a whole-output warning at the top without it applying to every hit. Shares the
// '⚠ DELETED' prefix so callers (and tests) have one marker to look for.
const DELETED_TAG = '⚠ DELETED: file no longer on disk'

/**
 * Is `absPath` gone from disk? Used to tag index rows that outlived their file.
 *
 * Absolute paths only. A bare `symbol NAME` searches every indexed project, so a relative path
 * would be resolved against whatever directory the command happened to run in -- a live file
 * belonging to another project would then read as missing and get labelled deleted. Indexed rows
 * store absolute paths, so this costs nothing in practice; it only refuses to guess when a caller
 * hands over a path whose meaning depends on the current directory. Saying nothing is the right
 * answer there: a false "this file is gone" is worse than the silence this whole change replaces.
 */
function fileIsGone(absPath: string): boolean {
  // A relative path would be resolved against the current directory, which for a symbol search spanning every indexed project is the wrong one -- so it is never judged. Past that, fileIsAbsent answers ENOENT and only ENOENT: a file that is present but unreadable stays silent, the same as before.
  if (!path.isAbsolute(absPath)) return false
  return fileIsAbsent(absPath)
}

/**
 * Returns the STALE_WARNING line (plus trailing newline) when `resolvedPath`'s current on-disk
 * SHA-256 differs from the SHA-256 stamped on its `files` row at the time it was last indexed, the
 * DELETED_WARNING line when the file is gone from disk entirely, or '' when they match, the file
 * isn't indexed, or the file is present but momentarily unreadable. Cheap by design: a single
 * fs.readFileSync + hash, not a reparse, so it's safe to call on every read/outline/skeleton/symbol
 * lookup.
 */
function staleWarning(resolvedPath: string): string {
  const entry = getFileEntry(resolvedPath)
  if (entry === null || entry.sha === '') return ''
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null) {
    // Separate the two reasons fingerprintFile gives up. Gone from disk is a fact worth saying out loud; unreadable-right-now is transient and stays quiet as before.
    return fileIsGone(resolvedPath) ? `${DELETED_WARNING}\n` : ''
  }
  if (diskSha === entry.sha) return ''
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
 * needs the same re-embed signal here too. Best-effort for ordinary parse/I/O failures (never
 * throws for those); a ConfinementIdentityError from the pinned reindex is the one exception --
 * that signals a detected between-check-and-use swap, and the pinning contract requires a
 * detected replacement to be refused rather than silently treated as an ordinary heal failure, so
 * it is rethrown rather than swallowed.
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
      indexFileSyncPinned(resolvedPath, globalDbPath())
      enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
    } catch (err) {
      if (err instanceof ConfinementIdentityError) throw err
      // Best-effort: leave it unindexed; the caller emits its normal "no symbols" message rather
      // than crashing a surgical-read command on a parse failure.
    }
    return
  }
  if (entry.sha === '') return
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null || diskSha === entry.sha) return
  try {
    indexFileSyncPinned(resolvedPath, globalDbPath())
    enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
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
 * Scan `text` and, on a match, return it wrapped in an untrusted-content fence under
 * {@link UNTRUSTED_GITHUB_TAG}. Shared by every `pr-slice` emit site (text and JSON): a PR's
 * title, description, review comments, and diff are all authorable by anyone who opened the PR
 * or left the comment.
 */
function fenceGithubTextIfMatched(text: string): string {
  let matches: string[] = []
  try {
    if (loadConfig().injection.enabled) matches = scanForInjectionPatterns(text)
  } catch {
    matches = []
  }
  if (matches.length === 0) return text
  recordStat('injection_detected', 0, 0, undefined, matches.join(','))
  return fenceUntrustedContent(text, matches, UNTRUSTED_GITHUB_TAG)
}

/**
 * JSON-mode counterpart to {@link guardText}: caps a JSON-serializable array at
 * `config.overflow_guard.max_tokens` (when enabled) by dropping trailing whole items rather than
 * truncating text mid-payload. `symbol`/`refs`/`skeleton`/`outline`'s `--json` branches were the
 * one output path the overflow guard didn't reach -- their text-mode siblings already route
 * through {@link guardText}/{@link emitGuarded}, but JSON mode returned the raw, unbounded array.
 *
 * Exported so `graph_commands.ts` (`types`/`callers`/`dead`/`test-for`) builds the same
 * `{items, truncated, totalCount}` envelope from the same helper rather than reimplementing the
 * cap, which is how the two halves of the envelope migration stay byte-compatible.
 */
export function guardJsonRows<T>(items: readonly T[]): JsonRowCapResult<T> {
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
// Canonical rationale lives with the constant in util.ts; re-exported here under its original name because tests and other modules already import it from this module.
export { PER_FILE_COUNTERFACTUAL_CEILING as SUM_FILE_SIZES_PER_FILE_CEILING } from './util.js'

function sumFileSizes(filePaths: Iterable<string>): number {
  let total = 0
  for (const fp of new Set(filePaths)) {
    try {
      total += Math.min(fs.statSync(fp).size, PER_FILE_COUNTERFACTUAL_CEILING)
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

// Minimum length for a query word to count towards word-level similarity below -- below this,
// short words like "a"/"of" would match almost any candidate. Mirrors MIN_REVERSE_MATCH_LEN's
// role for whole-string reverse containment.
const MIN_WORD_SIMILARITY_LEN = 3

/**
 * Rank `items` by closeness in length to `query` (shortest length-delta first), same tiebreak
 * everywhere it's used: ordinal (not locale-aware) string comparison -- an unlocaled
 * localeCompare() sorts differently across Node's small-icu vs full-icu builds and different
 * system default locales, which would make this truncation-affecting ranking nondeterministic
 * across machines/CI runners. Shared by every "did you mean" candidate list in this file so
 * they all rank the same way; does not mutate `items`.
 */
function sortByLengthCloseness(items: string[], query: string): string[] {
  return [...items].sort((a, b) => {
    const diff = Math.abs(a.length - query.length) - Math.abs(b.length - query.length)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Filter `candidates` to those similar to `query` -- case-insensitive substring match in either
 * direction, with the reverse direction (`query` contains `candidate`) gated at
 * MIN_REVERSE_MATCH_LEN so short indexed names like `b`/`n` don't match nearly every query --
 * then rank by {@link sortByLengthCloseness} and dedupe. This is the near-name scan `runSymbol`
 * used inline before every "did you mean" list in this file grew the same unranked/unfiltered
 * dump: a one-character typo and a nonsense query used to produce byte-identical suggestion
 * lists. Factored out so `read`, `openapi-op`, and `zip-read` misses all get real ranking too,
 * not just `symbol`.
 */
// Levenshtein distance, but bounded: it returns as soon as every cell in a row exceeds `max`, so a comparison against a wildly different name costs a couple of rows instead of a full matrix. Two rolling rows rather than a full grid -- the distance is all that is wanted, never the alignment.
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  if (a === b) return true
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return false
    prev = cur
  }
  return (prev[b.length] ?? Number.MAX_SAFE_INTEGER) <= max
}

// One edit for a short query, two once it is long enough that two typos stay unambiguous. Scaling with length matters because a fixed budget of 2 would make almost every 4-character name a neighbour of every other.
function typoBudget(queryLen: number): number {
  return queryLen >= TYPO_TWO_EDIT_MIN_LEN ? 2 : 1
}

export function rankSimilarNames(candidates: string[], query: string): string[] {
  const queryLower = query.toLowerCase()
  const filtered = candidates.filter((c) => {
    const cLower = c.toLowerCase()
    return cLower.includes(queryLower) || (cLower.length >= MIN_REVERSE_MATCH_LEN && queryLower.includes(cLower))
  })
  // Substring containment cannot reach a typo that drops, swaps, or mistypes a character -- `parseConfg` is neither a substring of `parseConfig` nor the reverse -- which is the single most common way a caller misses a name they already know. The edit-distance pass runs ONLY when containment found nothing, so it can supply an answer where there was none but can never reorder or displace a containment match; a query near nothing still yields nothing, keeping the block a suggestion rather than a net. Queries past TYPO_MAX_QUERY_LEN skip it: at that length a couple of edits no longer means "same name, mistyped", and the scan is not worth paying for.
  if (filtered.length === 0 && queryLower.length <= TYPO_MAX_QUERY_LEN) {
    const budget = typoBudget(queryLower.length)
    const near = candidates.filter((c) => withinEditDistance(c.toLowerCase(), queryLower, budget))
    return sortByLengthCloseness([...new Set(near)], query)
  }
  return sortByLengthCloseness([...new Set(filtered)], query)
}

/**
 * Filter and rank `available` headings by similarity to `query` before handing them to
 * {@link didYouMean}. Unfiltered, every heading in the file was shown regardless of relevance
 * -- a query for "zzzz" printed the exact same candidate list as a genuine near-miss like
 * "Setup", which isn't a "did you mean" suggestion at all, just the full heading dump.
 * Similarity mirrors {@link resolveHeaderPos}'s widened tier in section_reader.ts (a heading
 * is similar if it contains the query as a substring, or every query word is a substring of
 * some word in the heading), so a heading the widened tier would resolve to, or find
 * ambiguous among, always shows up here as a suggestion too. Ranked by
 * closeness in length to the query, same tiebreak as the near-name scan in the `symbol`
 * miss path. Callers pass the ranked result straight to didYouMean, which already caps at
 * DIDYOUMEAN_LIMIT -- no second cap here.
 */
export function filterSimilarHeadings(available: string[], query: string): string[] {
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_WORD_SIMILARITY_LEN)
  const matched = available.filter((heading) => {
    const headingLower = heading.toLowerCase()
    if (headingLower.includes(queryLower)) return true
    if (queryLower.length >= MIN_WORD_SIMILARITY_LEN && queryLower.includes(headingLower)) return true
    if (queryWords.length === 0) return false
    const headingWords = headingLower.split(/[^a-z0-9]+/).filter((w) => w.length > 0)
    // Forward containment only -- see resolveHeaderPos's widened tier in section_reader.ts
    // for why a reverse check would false-positive on unrelated words.
    return queryWords.every((qw) => headingWords.some((hw) => hw.includes(qw)))
  })
  // Containment cannot reach a misspelled heading word: `Instalation` is neither a substring of `Installation` nor the reverse, so a one-character slip in a heading the caller already knows reads exactly like a query about nothing. Mirror the edit-distance fallback rankSimilarNames uses for symbol names, matched WORD-to-word rather than whole-heading, since a heading is usually several words and no realistic typo budget spans the whole string. Runs only when containment found nothing, so it can never reorder or displace a containment match, and a query near no word still yields nothing.
  if (matched.length === 0 && queryWords.length > 0) {
    const near = available.filter((heading) => {
      const headingWords = heading.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0)
      return queryWords.some((qw) => qw.length <= TYPO_MAX_QUERY_LEN && headingWords.some((hw) => withinEditDistance(hw, qw, typoBudget(qw.length))))
    })
    return sortByLengthCloseness(near, query)
  }
  return sortByLengthCloseness(matched, query)
}

export function didYouMean(candidates: string[]): string {
  // Deduplicate first. Headings are not unique within a file -- a changelog carries one `Fixed`
  // per release -- so an unfiltered list printed the same name five times and spent the whole
  // suggestion budget saying one thing. Symbol callers pass names that are already distinct, so
  // this only ever collapses a genuine repeat.
  const unique = [...new Set(candidates)]
  if (unique.length === 0) return ''
  const lines = ['Did you mean:']
  for (const c of unique.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - ${c}`)
  }
  if (unique.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${unique.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

/**
 * Shared by refs/callers/impact/call-chain's bare-name miss path: a typo'd or nonexistent
 * symbol name reads identically to a real symbol with a genuinely empty result set ("no
 * references"/"no callers"), which is the exact "invites deleting live code" trap this file
 * already calls out for `--exclude-tests`. Callers already know the query came back empty
 * (never paid on a successful lookup) and have already established `name` is NOT indexed --
 * this only supplies the `Did you mean:` suggestion, same bounded-scan-then-rank shape as
 * `runSymbol`'s own near-name scan above, scoped to `rootDir` so a same-named symbol in an
 * unrelated project on the same machine (global.db is machine-wide) never leaks in as a
 * suggestion. Returns '' when the index has no near-name candidates -- callers append this
 * directly, so a leading newline is baked in only when there's something to show.
 */
export function unknownSymbolSuggestion(name: string, rootDir: string): string {
  const rawSymbols = querySymbols({ limit: FIND_SCAN_LIMIT, rootDir })
  const candidates = rankSimilarNames(rawSymbols.map((s) => s.name), name)
  return candidates.length > 0 ? `\n${didYouMean(candidates)}` : ''
}

// Shared "file::symbol" spec-format error for `read`/`brief` when the argument has no `::`
// separator and isn't a readable file. The old messages ("Symbol not found" for brief, "Could
// not read" for read) asserted something false -- the name may well be indexed, and the
// argument was never a file at all, so this is a spec-format mistake, not a missing-symbol or
// filesystem problem. Mirrors `similar`/`blame` (graph_commands.ts): a bare name that resolves
// to indexed symbols is pointed at the exact `file::symbol` spec(s) to retry with; one that
// resolves to nothing gets those commands' own "Invalid spec" wording verbatim, rather than a
// third dialect of the same error.
function formatBareNameSpecError(command: string, name: string, projectRoot?: string): string {
  const rootDir = projectRoot ?? resolveProjectRoot({ project: process.cwd() })
  const matches = querySymbols({ name, limit: 50, rootDir })
  const seen = new Set<string>()
  const specs: string[] = []
  for (const m of matches) {
    const spec = `${toDisplayPath(rootDir, m.filePath)}::${m.name}`
    if (seen.has(spec)) continue
    seen.add(spec)
    specs.push(spec)
  }
  if (specs.length === 0) {
    return `Invalid spec - expected "file::symbol", got: ${name}`
  }
  const lines = [`Not a file: '${name}'. Did you mean:`]
  for (const spec of specs.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - token-goat ${command} "${spec}"`)
  }
  if (specs.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${specs.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

// Cross-file "did you mean" lead for the file::symbol not-found path: `formatBareNameSpecError`
// already does a name-keyed, project-scoped lookup for the no-`::`-separator case, but the
// same wrong-file mistake (right symbol name, wrong file in the spec) only got a file-scoped
// same-file fallback -- which can never find a symbol that isn't in that file at all. This
// reuses `formatBareNameSpecError`'s exact query shape/wording so the two "here's the runnable
// spec" messages in this file don't drift into a third dialect. Returns '' if the name isn't
// indexed anywhere.
function formatCrossFileLead(command: string, name: string, excludeFilePath: string, projectRoot?: string): string {
  // Same cwd fallback the sibling same-file lookup a few lines below each call site already
  // uses (`resolveIndexPath(file, opts.projectRoot ?? process.cwd())`) -- deliberately not
  // resolveProjectRoot's own git-toplevel lookup, which would add an unconditional `git
  // rev-parse` call to a path that previously never shelled out at all.
  const rootDir = projectRoot ?? process.cwd()
  const matches = querySymbols({ name, limit: 50, rootDir })
  const excludeResolved = resolveIndexPath(excludeFilePath, rootDir)
  const seen = new Set<string>()
  const specs: string[] = []
  for (const m of matches) {
    if (foldPath(m.filePath) === foldPath(excludeResolved)) continue
    const spec = `${toDisplayPath(rootDir, m.filePath)}::${m.name}`
    if (seen.has(spec)) continue
    seen.add(spec)
    specs.push(spec)
  }
  if (specs.length === 0) return ''
  const firstSpec = specs[0]
  const lines = [`'${name}' is defined in ${firstSpec !== undefined ? firstSpec.split('::')[0] : ''}`]
  for (const spec of specs.slice(0, DIDYOUMEAN_LIMIT)) {
    lines.push(`  - token-goat ${command} "${spec}"`)
  }
  if (specs.length > DIDYOUMEAN_LIMIT) {
    lines.push(`  (${specs.length - DIDYOUMEAN_LIMIT} more not shown)`)
  }
  return lines.join('\n')
}

// Resolves the enclosing symbol for a semantic chunk's line range, keyed off its `startLine`.
//
// Containment rule (documented per the semantic-fields task): a symbol is a candidate only if
// `symbol.lineStart <= chunk.startLine <= symbol.lineEnd` -- the chunk's START line must fall
// strictly inside the symbol's own indexed range. This deliberately does NOT use "nearest
// symbol by start line": a top-of-file chunk (imports/module header, before any symbol starts)
// would otherwise get wrongly labelled with whatever symbol happens to sit below it, even
// though it isn't inside that symbol at all. Chunk boundaries don't always align with symbol
// boundaries (embeddings.ts's chunkFile folds short boundary ranges into neighbors and can
// merge across gaps), so a chunk may overlap zero, one, or several symbols -- using the START
// line is the same "does this line belong to a definition" question `read`/`skeleton` already
// answer elsewhere in this file, and needs no separate end-line/overlap policy.
//
// Among all containing candidates, innermost wins: the smallest range (fewest lines) is
// preferred, e.g. a method chunk resolves to the method itself, not its enclosing class.
function resolveEnclosingSymbol(filePath: string, chunkStartLine: number): { name: string; kind: string } | null {
  // No rootDir scope here: filePath alone already narrows to the exact file the hit came from
  // (an absolute path from the embeddings index), so an additional project-prefix filter is
  // redundant and, worse, can spuriously exclude the very row being looked up whenever the
  // stored/queried root strings don't normalize identically (e.g. a symlinked or 8.3-short
  // temp path) -- the same file_path equality check every other exact-file lookup in this
  // file already relies on without a rootDir filter (see the `resolved` lookups above).
  const symbols = querySymbols({ filePath, limit: 100_000 }, globalDbPath())
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if (s.lineStart <= chunkStartLine && chunkStartLine <= s.lineEnd) {
      if (best === null || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) {
        best = s
      }
    }
  }
  return best === null ? null : { name: best.name, kind: best.kind }
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
  /** Only list symbols whose NAME matches this pattern, project-wide. Regex, falling back to a
   * literal substring match when it does not compile -- see compileGrepMatcher. Mutually
   * exclusive with `name`: an exact `name` match is already pinned to one identifier, so
   * regex-filtering that same fixed name is never useful. */
  grep?: string
  /** `--exclude-tests`: drop symbols DEFINED in a test file (per isTestFile), matching the flag already on refs/callers/dead/semantic. Opt-in; omitted or false leaves output byte-identical to today. Like `--grep`, this filters client-side, so it forces the over-fetch below -- filtering after the SQL LIMIT would let suppressed test symbols occupy slots ahead of the cutoff and silently under-return. */
  excludeTests?: boolean
  /** `--stats`: add a per-result reference count and doc-coverage flag, same shape as read/skeleton/outline's `--stats`. Opt-in; omitted or false leaves output byte-identical to today, and the extra `queryRefCounts` round trip is only paid when this is set. `symbol` is the one command in the family where this matters most for disambiguation -- it can return several same-named candidates across files -- but that is also where its known limitation bites hardest: `queryRefCounts` keys by symbol NAME (project-wide), not by definition site, so several same-named symbols in different files (e.g. under `--grep`) all show the identical count rather than a per-file one. Documented, not fixed, here for the same reason it is not fixed in read/skeleton/outline. */
  stats?: boolean
}

/**
 * Locate `name` as an object key nested at depth >= 2 inside one of the already-indexed
 * JSON/YAML files in `filePaths`, returning the dot-path that `json-query`/`yaml-query`
 * accepts, or `null` when it is not found.
 *
 * Exists because JSON/YAML files are indexed only to depth 1 (top-level keys become
 * `property` symbols; nested keys deliberately do not, or every manifest would flood
 * bare-name lookups with `name`/`version`/`type` rows and duplicate `json-query`). A `symbol
 * better-sqlite3` miss is therefore correct-from-evidence but wrong-in-fact, and its
 * `Did you mean: sql` suggestion actively points away from the answer.
 *
 * Deliberately answers with a real dot-path or with silence -- never a generic "JSON keys
 * aren't symbols" line, which would fire on nearly every miss in nearly every project and
 * bill itself for a saving it did not deliver.
 */
export function findStructuredKeyPath(name: string, filePaths: string[]): { filePath: string; dotPath: string; command: string } | null {
  let filesTried = 0
  for (const filePath of filePaths) {
    if (filesTried >= STRUCTURED_MISS_MAX_FILES) break
    const lower = filePath.toLowerCase()
    const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml')
    if (!isYaml && !lower.endsWith('.json')) continue
    // Size-gate off the stat, before reading: the point of the cap is to never pay to load or parse a lockfile, so checking after readFileText would defeat it.
    let size: number
    try {
      size = fs.statSync(filePath).size
    } catch {
      continue
    }
    if (size > STRUCTURED_MISS_MAX_BYTES) continue
    filesTried += 1
    let data: unknown
    try {
      const text = readFileText(filePath)
      if (text === null) continue
      data = isYaml ? parseYamlDocument(text) : (JSON.parse(text) as unknown)
    } catch {
      // A malformed manifest must never turn a clean miss into an error; the miss message is already correct without this hint.
      continue
    }
    const dotPath = findKeyDotPath(data, name)
    if (dotPath !== null) return { filePath, dotPath, command: isYaml ? 'yaml-query' : 'json-query' }
  }
  return null
}

/** True when `key` can appear unambiguously as a `.`-joined segment in `json_query.ts`'s dot-path grammar: a `.` would be parsed as an extra path separator and a `[`/`]` as a bracket-expression delimiter, so a key containing either cannot be encoded as a plain segment in that grammar. */
function isDotPathSafeKey(key: string): boolean {
  return !key.includes('.') && !key.includes('[') && !key.includes(']')
}

/** Breadth-first search for `name` as an object key at depth >= 2 in a parsed JSON/YAML document, returning its dot-path in `json_query.ts`'s grammar (`a.b`, `a[0].b`). Breadth-first so the shallowest -- and so shortest and least ambiguous -- path wins, and node-capped so a deep document cannot make a failed lookup expensive. A match reachable only through a key containing `.`, `[`, or `]` is skipped rather than returned: such a key is not representable in the dot-path grammar, so emitting it would suggest a command that either fails or silently selects a different value. */
function findKeyDotPath(root: unknown, name: string): string | null {
  const queue: Array<{ value: unknown; prefix: string; depth: number; safe: boolean }> = [
    { value: root, prefix: '', depth: 0, safe: true },
  ]
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) break
    if (visited++ >= STRUCTURED_MISS_MAX_NODES) return null
    const { value, prefix, depth, safe } = node
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) queue.push({ value: value[i], prefix: `${prefix}[${i}]`, depth, safe })
      continue
    }
    if (value === null || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const keySafe = safe && isDotPathSafeKey(key)
      const childPath = prefix === '' ? key : `${prefix}.${key}`
      if (key === name && depth + 1 >= 2 && keySafe) return childPath
      queue.push({ value: child, prefix: childPath, depth: depth + 1, safe: keySafe })
    }
  }
  return null
}

/** Handle ``token-goat symbol <name>``. */
export function runSymbol(opts: SymbolOptions): { text: string; code: number } {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero
  // rows regardless of whether the symbol exists -- silently reporting "no matches" for a
  // symbol that's actually indexed. Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    return { text: `--limit must be a positive number, got: ${opts.limit}`, code: 1 }
  }
  // `--grep` IS the query when there is no exact name to anchor on. Combining it with a name is
  // near-useless -- an exact `name = ?` match is already pinned to one identifier, so
  // regex-filtering that same fixed name either matches everything or nothing -- and more
  // likely a caller mistake than real intent, so reject the combination outright rather than
  // silently pick a winner.
  if (opts.name !== undefined && opts.grep !== undefined) {
    return {
      text: 'symbol: --grep cannot be combined with a name; drop the name to search by pattern, or drop --grep to search by exact name',
      code: 1,
    }
  }
  if (opts.name === undefined && opts.grep === undefined) {
    return { text: 'symbol requires a name or --grep <pattern>', code: 1 }
  }

  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const excludeTests = opts.excludeTests === true

  // `symbol` is the one read command that searches the machine-wide index by default, which is
  // documented and useful on a personal machine and a disclosure channel on a shared one: from any
  // indexed directory, `symbol --grep .` enumerates every symbol of every project ever indexed
  // here, bodies included, without touching the filesystem -- so a directory sandbox around the
  // agent does not contain it. `indexing.cross_project_symbols = false` confines the command to
  // the project it is run from. The confinement has to cover --project and an absolute --file as
  // well, or the setting is bypassed by the same caller it exists to constrain.
  const confinedRoot = confinedProjectRoot()
  if (confinedRoot !== null) {
    const requested = opts.projectRoot
    const projectDenial = requested === undefined ? null : confinementRefusal('--project', requested, confinedRoot)
    if (projectDenial !== null) return { text: projectDenial, code: 1 }
    if (opts.file !== undefined) {
      const fileDenial = confinementRefusal('--file', resolveIndexPath(opts.file, requested ?? process.cwd()), confinedRoot)
      if (fileDenial !== null) return { text: fileDenial, code: 1 }
    }
  }

  const queryOpts: Parameters<typeof querySymbols>[0] = {}
  if (opts.name !== undefined) queryOpts.name = opts.name
  if (opts.file !== undefined) {
    queryOpts.filePath = resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())
    // Self-heal before querying so a stale index serves fresh data instead of a warning.
    healStaleIndex(queryOpts.filePath)
  }
  if (opts.kind !== undefined) queryOpts.kind = opts.kind
  // `--grep` filters client-side on NAME (no regex support in SQL), so the SQL `LIMIT` must
  // scan well past the caller's requested --limit -- otherwise a project whose matching symbols
  // aren't in the first `limit` unfiltered rows silently under-returns. Over-fetch with
  // FIND_SCAN_LIMIT (the same bound the near-name scan below already uses), filter, THEN slice
  // to the real requested limit below: filtering after the slice would return however many of
  // the top-N unfiltered rows happen to match, not N matching rows.
  // `--exclude-tests` filters client-side on file path for the same reason and needs the same
  // headroom: with a plain `--limit N`, N test-file symbols could fill the SQL result set and
  // leave nothing to show after filtering, reporting "no matches" for a symbol that is indexed.
  if (matchesGrep !== undefined || excludeTests) {
    queryOpts.limit = FIND_SCAN_LIMIT
  } else if (opts.limit !== undefined) {
    queryOpts.limit = opts.limit
  }
  // Only scope a bare-name search to projectRoot; when `file` already pins an exact indexed
  // path there's nothing left to disambiguate across projects.
  if (opts.file === undefined && opts.projectRoot !== undefined) queryOpts.rootDir = opts.projectRoot
  // Confinement supplies the scope the caller left open, so a bare-name lookup with no --project
  // searches this project instead of the whole machine.
  if (opts.file === undefined && queryOpts.rootDir === undefined && confinedRoot !== null) queryOpts.rootDir = confinedRoot

  const rawResults = querySymbols(queryOpts)
  const preFilterCount = rawResults.length
  const effectiveLimit = opts.limit ?? 100
  const anyClientFilter = matchesGrep !== undefined || excludeTests
  const filtered = anyClientFilter
    ? rawResults.filter((s) => (matchesGrep === undefined || matchesGrep(s.name)) && !(excludeTests && isTestFile(s.filePath)))
    : rawResults
  const results = anyClientFilter ? filtered.slice(0, effectiveLimit) : filtered

  // How many rows `--exclude-tests` alone removed, counted after any `--grep` so the two filters
  // don't double-report the same row. Only used to explain an empty result below.
  const hiddenByExcludeTests = excludeTests
    ? rawResults.filter((s) => (matchesGrep === undefined || matchesGrep(s.name)) && isTestFile(s.filePath)).length
    : 0

  if (excludeTests && filtered.length === 0 && hiddenByExcludeTests > 0) {
    // The symbol IS indexed, just only ever in test files. Saying "No matches" here would be a
    // lie that stops the caller looking; name the filter that hid them instead.
    const label = opts.name ?? opts.grep ?? '*'
    const notice = `no non-test matches for '${label}' (${excludeTestsHiddenNote(hiddenByExcludeTests)})`
    if (opts.json === true) {
      return { text: JSON.stringify({ items: [], truncated: false, totalCount: 0 }, null, 2), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }

  if (matchesGrep !== undefined && filtered.length === 0 && preFilterCount > 0) {
    // The scope (--file/--kind/--project) genuinely has symbols, but --grep matched none of
    // them -- distinct from the `results.length === 0` branch below, which means there was
    // nothing in scope at all. Same "filtered store renders as populated" trap already fixed
    // for types/dead/exports.
    if (opts.json === true) {
      const text = JSON.stringify({ items: [], truncated: false, totalCount: 0 }, null, 2)
      return { text, code: 0 }
    }
    return { text: grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'symbol', 'symbols'), code: 0 }
  }

  if (results.length === 0) {
    let text = `No matches for '${opts.name ?? opts.grep ?? '*'}'`
    // Resolved once here, before the near-name scan, because both the `Try: semantic` fallback and the trailing empty-index note need the answer -- and the fallback needs it to decide whether to print at all. Still only paid after the query already came back empty, and only in text mode: --json's zero-result string isn't real JSON either way (see the comment below), so appending prose to it wouldn't gain anything and would look like an attempt at a JSON field.
    const emptyIndexRoot = opts.json !== true ? (opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })) : null
    const indexEmpty = emptyIndexRoot !== null && isIndexEmptyForProject(globalDbPath(), emptyIndexRoot)
    // --json callers parse this string as an error message, not human-facing prose -- keep it
    // byte-identical to before and only append the suggestion in text mode.
    if (opts.name !== undefined && emptyIndexRoot !== null) {
      // Same near-name mechanism as `find`: scan the index and match by case-insensitive
      // substring in either direction, so a typo'd or partial name still gets a cheap next
      // step instead of dead-ending into a full-file Read or a wide Grep.
      const rootDir = emptyIndexRoot
      const rawSymbols = querySymbols({ limit: FIND_SCAN_LIMIT, rootDir })
      // An EXACT name match in this scan cannot be a typo: the caller spelled the symbol correctly and the lookup above only came back empty because a scope filter (--kind/--file) narrowed it away. Reporting that as "Did you mean: alphaOne" for the query `alphaOne` prints a correction byte-identical to what was typed, and pairs it with a "No matches" line that reads as proof the symbol does not exist -- so the caller concludes it is absent and falls back to a full Read. Name the scope that hid it instead.
      const exactMatches = rawSymbols.filter((s) => s.name === opts.name)
      if (exactMatches.length > 0) {
        const shown = exactMatches.slice(0, DIDYOUMEAN_LIMIT)
        const where = shown.map((s) => `${s.kind} at ${toDisplayPath(rootDir, s.filePath)}:${s.lineStart}`).join('; ')
        const more = exactMatches.length > shown.length ? ` (+${exactMatches.length - shown.length} more)` : ''
        const flags = [opts.kind !== undefined ? '--kind' : null, opts.file !== undefined ? '--file' : null].filter((f): f is string => f !== null)
        const widen = flags.length > 0 ? `drop ${flags.join('/')} to see it` : 'widen the search scope to see it'
        text += `\n'${opts.name}' IS indexed (${where}${more}) -- ${widen}`
      } else {
        // On an empty index `semantic` fails exactly as `symbol` just did, so suggesting it sends the caller into a second dead end before they ever reach the note below that names the real fix. Suppressed only in that case: with any index at all the fallback is still the right next step.
        const candidates = rankSimilarNames(rawSymbols.map((s) => s.name), opts.name)
        text += candidates.length > 0 ? `\n${didYouMean(candidates)}` : indexEmpty ? '' : `\nTry: token-goat semantic "${opts.name}"`
      }
      // Appended in BOTH branches on purpose: the didYouMean case is exactly the one that needs correcting, since a near-name suggestion ("Did you mean: sql" for `better-sqlite3`) reads as a confident answer and points away from the real one. Candidate files come from the scan already in hand above, so this costs no extra DB round trip.
      const structuredFiles = [...new Set(rawSymbols.map((s) => s.filePath))].sort()
      const hit = findStructuredKeyPath(opts.name, structuredFiles)
      if (hit !== null) {
        const display = toDisplayPath(rootDir, hit.filePath)
        text += `\n'${opts.name}' is a key in ${display} at ${hit.dotPath} -- JSON/YAML keys below the top level are not symbols; read it with: token-goat ${hit.command} ${display} '${hit.dotPath}'`
      }
    }
    if (indexEmpty && emptyIndexRoot !== null) {
      text += `\n${emptyIndexMessage(emptyIndexRoot)}`
    }
    return { text, code: 1 }
  }

  const fullSourceBytes = sumFileSizes(results.map((s) => s.filePath))

  // Shared by both the --json payload and the human blocks below, so a caller-supplied
  // projectRoot (or none) resolves the same way for either output mode.
  const symbolDisplayRoot = getDisplayRoot(opts.projectRoot)

  // Only queried when --stats is actually requested, and only after every early-return above --
  // a zero-result or filtered-to-empty call must not pay for an extra DB round trip. Same call
  // shape as read's single-symbol lookup and prepareSymbolListing's skeleton/outline lookup.
  const refCounts =
    opts.stats === true
      ? queryRefCounts(
          results.map((s) => s.name),
          globalDbPath(),
          resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }),
        )
      : undefined

  if (opts.json === true) {
    const capped = guardJsonRows(results)
    let trueTotal: number
    let truncatedFlag: boolean
    if (anyClientFilter) {
      // No SQL regex support, and no SQL notion of "is a test file" either -- `filtered` is the
      // exact post-filter count within the FIND_SCAN_LIMIT scan window queried above, so it is
      // the honest total for what --grep/--exclude-tests actually matched. countSymbols(queryOpts)
      // would instead report the pre-filter count of the whole kind/file/rootDir scope, which
      // contradicts the filtered rows below.
      trueTotal = filtered.length
      truncatedFlag = capped.truncated || results.length < filtered.length
    } else {
      // `results` is already truncated by querySymbols's own SQL `LIMIT` (opts.limit, or the
      // default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length)
      // is not the real number of matching symbols -- countSymbols reruns the same filters with
      // no LIMIT to report an honest total, the same distinction json_query's --head already
      // makes (its totalCount survives --head unlike this one used to).
      trueTotal = countSymbols(queryOpts)
      truncatedFlag = capped.truncated || trueTotal > results.length
    }
    // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(symbolDisplayRoot, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json.
    const items = capped.items.map((s) => ({
      ...s,
      filePath: toDisplayPath(symbolDisplayRoot, s.filePath),
      // Only present when true, so a result set of live files stays byte-identical to what this
      // command has always emitted and only the genuinely-gone rows grow a field.
      ...(fileIsGone(s.filePath) ? { deleted: true } : {}),
      ...(refCounts !== undefined ? { refCount: refCounts.get(s.name) ?? 0, hasDoc: hasRealDocstring(s.docstring) } : {}),
    }))
    const payload = { items, truncated: truncatedFlag, totalCount: trueTotal }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file ?? opts.grep)
    return { text, code: 0 }
  }

  // Header + short body preview per match (mirrors the richer surface that the native CLI handler used before the two read surfaces were consolidated).
  const blocks = results.map((sym) => {
    const statsStr = formatStatsSuffix(refCounts, sym)
    // Per match, not one banner for the whole result set: a bare `symbol NAME` searches every
    // indexed project, so one hit can be a live file and the next one a checkout that was deleted
    // months ago. A single header line would have to lie about one of them.
    const goneTag = fileIsGone(sym.filePath) ? `  ${DELETED_TAG}` : ''
    const header = `# ${sym.name} (${sym.kind}) — ${toDisplayPath(symbolDisplayRoot, sym.filePath)}:${sym.lineStart}-${sym.lineEnd}${statsStr}${goneTag}`
    const body = resolveBody(sym)
    const bodyLines = body.split(/\r?\n/)
    const preview = bodyLines.slice(0, SYMBOL_PREVIEW_LINES).join('\n')
    // The header states the symbol's real line span, so a five-line preview of a forty-line
    // function looked like the whole thing was five lines long -- a silent cap of exactly the kind
    // truncationFooter below exists to prevent. Say what was cut and how to get the rest.
    const dropped = bodyLines.length - SYMBOL_PREVIEW_LINES
    const elided =
      dropped > 0
        ? `\n  ...(${countNoun(dropped, 'more line')}; full body: token-goat read "${toDisplayPath(symbolDisplayRoot, sym.filePath)}::${sym.name}")`
        : ''
    return preview.trim() !== '' ? `${header}\n${preview}${elided}` : header
  })
  const warning = opts.file !== undefined ? staleWarning(resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())) : ''
  const text = guardText(warning + blocks.join('\n\n'), 'symbol')
  recordReadStat('symbol_lookup', fullSourceBytes, text, opts.name ?? opts.file ?? opts.grep)
  // Under a client-side filter the count is only as complete as the FIND_SCAN_LIMIT window the rows
  // were drawn from, so a scan that filled reports its count as a floor rather than as a total.
  const symbolTotal = (): TruncationTotal =>
    anyClientFilter ? { count: filtered.length, exact: rawResults.length < FIND_SCAN_LIMIT } : { count: countSymbols(queryOpts), exact: true }
  return { text: text + truncationFooter(results.length, effectiveLimit, symbolTotal, 'matches', '--limit'), code: 0 }
}

/**
 * The "you are not seeing all of it" line for a text-mode result set, or an empty string when
 * nothing was dropped.
 *
 * `--json` has always carried an honest `totalCount`; text mode rendered exactly `limit` rows and
 * stopped, which is indistinguishable from "that is all there is" -- `symbol dup` printed 20
 * definitions of 40 with nothing on stdout or stderr to say so. Same no-silent-caps rule the
 * `refs --top` summary and `json-outline`'s `--head` note already follow.
 *
 * `total` is a thunk because computing it costs another count query, and it is only worth paying
 * when the page came back full: a result set shorter than the limit cannot have been truncated.
 * Appended after `guardText`, so the overflow guard cannot trim off the very line that explains
 * the trimming.
 */
function truncationFooter(shown: number, limit: number, total: () => TruncationTotal, plural: string, flag: string): string {
  const notice = truncationNotice(shown, limit, total, plural, flag)
  return notice === null ? '' : `\n\ntoken-goat: ${notice}`
}

/**
 * The honest total behind a truncated page. `exact: false` means the count came from a bounded
 * client-side scan (`--grep`, `--exclude-tests`) that itself filled up, so `count` is a floor and
 * not a total: saying "of 20000" there would trade one silent cap for a confident wrong number.
 */
interface TruncationTotal {
  count: number
  exact: boolean
}

/**
 * The honest reference total for a page of `refs` output.
 *
 * `countRefs` reruns the SQL filters with no LIMIT, which is exact. `--exclude-tests`/`--grep` have
 * no SQL equivalent, so their total is the post-filter count of the REFS_TOP_SCAN_LIMIT window the
 * rows came from -- exact only while that window had room to spare, a floor once it filled.
 */
function refsTotal(clientFiltered: boolean, filteredTotal: number | undefined, shown: number, countExact: () => number, preScanCount: number): TruncationTotal {
  if (!clientFiltered) return { count: countExact(), exact: true }
  return { count: filteredTotal ?? shown, exact: preScanCount < REFS_TOP_SCAN_LIMIT }
}

/** The sentence {@link truncationFooter} wraps, or null when nothing was dropped. See its doc comment. */
function truncationNotice(shown: number, limit: number, total: () => TruncationTotal, plural: string, flag: string): string | null {
  if (shown < limit) return null
  const { count, exact } = total()
  if (count <= shown) return null
  return exact
    ? `showing ${shown} of ${count} ${plural}; rerun with ${flag} ${count} to see them all`
    : `showing ${shown} of at least ${count} ${plural}; rerun with ${flag} ${count} and a narrower filter to see more`
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

// Cross-file multi-spec: `src/a.ts::alphaFn,src/b.ts::betaFn`. Comma-separated segments are walked left to right tracking a "current file" -- a segment containing `::` sets a new current file and contributes its own symbol, a segment with no `::` inherits the current file (so `src/a.ts::alphaFn,src/b.ts::betaFn,gammaFn` reads gammaFn from b.ts). Deliberately returns null (falling through to the existing single-file `parseReadSpec`/`findSpecSeparator` handling, byte-for-byte unchanged) unless at least two segments carry their own `::`, because a spec with only one `::` segment is either the pre-existing single-file `file::a,b` form or the numeric line-range form `file::N,M` -- both already handled correctly by the code below and must not be reinterpreted here. Also declines outright if the first segment has no `::`, so a bare-name spec (no file prefix at all) keeps reaching `formatBareNameSpecError` untouched.
function parseCrossFileMultiSpec(spec: string): { file: string; symbol: string }[] | null {
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

/**
 * Bare multi-FILE spec: `src/a.ts,src/b.ts`. The file-list counterpart of
 * {@link parseCrossFileMultiSpec} (which handles the `file::symbol` pair form) -- this is the one
 * splitter shared by `outline`/`skeleton`/`exports`/`imports`, none of which take a `::` symbol
 * part at all.
 *
 * Declines (returns null, leaving the single-file path byte-for-byte unchanged) when: there is no
 * comma; the spec as written is itself an existing file (a real path may legitimately contain a
 * comma, and that reading must win); any segment carries a `::` (that is the symbol-spec grammar,
 * not a file list); or fewer than two non-empty segments survive trimming.
 */
export function parseMultiFileSpec(spec: string): string[] | null {
  if (!spec.includes(',')) return null
  if (fileExists(spec)) return null
  if (findSpecSeparator(spec) !== -1) return null
  const parts = spec.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return parts.length > 1 ? parts : null
}

/**
 * The note a single-argument read command prints when extra positional arguments were supplied.
 * Space-separated extras are dropped in silence -- an agent would believe it had seen every file
 * or symbol it named. Naming the comma form here is the whole point: it is the grammar that
 * actually reads them all.
 *
 * `noun` matches what the command's argument is called in its own usage line, so `read` says
 * "spec" rather than "file". `mergeable: false` is for the commands that genuinely have no
 * merged form (`symbol`, and `section --list`): suggesting a comma list there would print a
 * command that does not work, which is worse than printing no suggestion at all.
 */
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

// A line-range read spec ends in `@N` (single line) or `@N-M` (inclusive range), e.g. `src/app.ts@10-20`. The `$`-anchored trailing digits mean a real path that ends in an extension (`report@2024.txt`) never matches; only a bare digit suffix triggers a range read. Exported so mcp_server.ts's confinement gate can recognize the exact same range syntax runRead does, instead of restating this regex in a second place (see specFilePart there).
export function parseLineRange(spec: string): { file: string; start: number; end: number } | null {
  const m = /^(.+)@(\d+)(?:-(\d+))?$/.exec(spec)
  if (m === null) return null
  // If the full spec is a real file (e.g., a file literally named "notes@2024"), treat it as a plain file, not a range.
  if (fileExists(spec)) return null
  // A `file::symbol@LINE` anchored symbol spec also matches this regex (the whole spec ends in
  // `@<digits>`), but its `file` capture would be the bogus "file::symbol" string -- decline here
  // so it falls through to the normal `::` symbol-spec path, which is where the anchor actually
  // belongs (see resolveSymbolSpec's own `@<digits>` stripping). A real file-level range spec
  // never contains `::`, so this guard cannot reject one.
  if (m[1]!.includes('::')) return null
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
  // Same projectRoot-vs-cwd resolution as runRead's bare-file branch above; `file@N-M` reaches
  // readFileText by a different path and would otherwise keep the identical escape.
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
  // A trailing newline terminates the last line rather than starting a new empty one; drop the phantom empty element split() appends so the line count matches editor/symbol-read conventions.
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  if (start > allLines.length) {
    return { text: `Line ${start} is past end of file (${countNoun(allLines.length, 'line')}): ${file}`, code: 1 }
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
  | { kind: 'confined'; message: string }
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
function formatAmbiguity(symbol: string, file: string, candidates: SymbolEntry[], explicitRoot?: string, commandName = 'read'): string {
  const multiFile = new Set(candidates.map((c) => c.filePath)).size > 1
  const displayRoot = getDisplayRoot(explicitRoot)
  const lines = [
    `Ambiguous symbol '${symbol}' in '${file}': ${countNoun(candidates.length, 'definition')} match. ` +
      `Retry with one of the qualified commands below to pick one:`,
  ]
  const fileSymCache = new Map<string, SymbolEntry[]>()
  const getFileSyms = (filePath: string): SymbolEntry[] => {
    let fileSyms = fileSymCache.get(filePath)
    if (fileSyms === undefined) {
      // FIND_SCAN_LIMIT, not a bare 1000: both call sites mean "every symbol in this file", and a
      // silent cap makes a symbol past the cutoff read as absent rather than truncated.
      fileSyms = querySymbols({ filePath, limit: FIND_SCAN_LIMIT })
      fileSymCache.set(filePath, fileSyms)
    }
    return fileSyms
  }
  // A retry only needs the `@LINE` anchor when the plain `Parent.symbol` (or bare `symbol`)
  // qualifier would not, by itself, uniquely pick this candidate back out on resubmission. Two
  // ways that happens: (1) two candidates in the same file render the identical qualifier string
  // (rare -- e.g. two same-named classes each with a same-named method), caught by counting
  // qualifier strings per file below; (2) a candidate has no parent at all, and some other
  // candidate shares its file -- resolveSymbolSpec's bare-name lookup does not filter by parent,
  // so retrying with the bare name re-matches every same-named row in that file, parented or not
  // (this is the original bug: a top-level `run` alongside a `cmdUninstall.run` in the same file
  // -- the top-level one's own name is the exact spec that was already ambiguous). A parentless
  // candidate that is the ONLY same-named definition in its file (e.g. each side of a cross-file
  // ambiguity) needs no anchor: the retry's file already disambiguates it.
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
    // Cross-file ambiguity can't be resolved by re-typing the original (still-ambiguous) `file`
    // spec -- retarget the retry at this candidate's own indexed file path so it resolves to
    // exactly this candidate. Same-file ambiguity keeps retrying against the original `file`
    // string, unchanged from the pre-fix behavior.
    const retryFile = multiFile ? toDisplayPath(displayRoot, c.filePath) : file
    const label = multiFile ? `${toDisplayPath(displayRoot, c.filePath)}::${qualifier}` : qualifier
    lines.push(`  - ${label} (line ${c.lineStart})  ->  token-goat ${commandName} "${retryFile}::${qualifier}"`)
  }
  return lines.join('\n')
}

/**
 * The confining project root when `indexing.cross_project_symbols = false`, else null. Resolved
 * once per command so every index-backed lookup answers to the same root.
 */
function confinedProjectRoot(): string | null {
  return loadConfig().indexing.cross_project_symbols ? null : resolveProjectRoot()
}

/**
 * The refusal message for an index-backed lookup at `resolved` when confinement is on, or null
 * when the lookup is allowed. Shared by every command that answers out of the index, so they all
 * refuse with one wording: the index holds symbol bodies for every project ever indexed on this
 * machine and serves them without touching the filesystem, so a directory sandbox around the
 * agent cannot contain it -- each command has to enforce the setting itself or the setting is
 * bypassed by whichever command forgot.
 */
function confinementRefusal(label: string, resolved: string, root: string | null): string | null {
  if (root === null || isInsideRoot(resolved, root)) return null
  return `${label} is outside this project root, and indexing.cross_project_symbols = false confines symbol lookups to it: ${toDisplayPath(root, resolved)}`
}

/** {@link confinementRefusal} for a caller-supplied file spec, resolved the same way the lookup itself resolves it. */
export function fileConfinementRefusal(label: string, file: string, projectRoot: string | undefined): string | null {
  const root = confinedProjectRoot()
  if (root === null) return null
  return confinementRefusal(label, resolveIndexPath(file, projectRoot ?? process.cwd()), root)
}

function resolveSymbolSpec(spec: string, forceRefresh?: boolean, projectRoot?: string): SymbolResolution {
  const { file, symbol: rawSymbol } = parseReadSpec(spec)
  if (rawSymbol === undefined || rawSymbol === '') return { kind: 'none' }

  // A trailing `@<digits>` anchors the spec to one candidate's exact `lineStart`, for the case
  // where no `Parent.symbol` qualifier can disambiguate a top-level definition (it has no
  // parent, so the plain qualifier is identical to the bare name that was already ambiguous).
  // Stripped here, before any lookup, so it composes with both the bare form (`symbol@LINE`) and
  // the dotted form (`Parent.method@LINE`) -- everything below this point operates on the
  // anchor-free `symbol` exactly as it did before anchors existed, and the anchor itself is only
  // consulted once by `finalize` at the very end, to narrow whatever candidates were found.
  const anchorMatch = /^(.+)@(\d+)$/.exec(rawSymbol)
  const symbol = anchorMatch !== null ? anchorMatch[1]! : rawSymbol
  const lineAnchor = anchorMatch !== null ? parseInt(anchorMatch[2]!, 10) : undefined

  const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
  // Refuse before any index work: the resolution below reads bodies straight out of the shared
  // index, so the check has to happen here rather than at each caller's rendering step.
  const confined = confinementRefusal('This file', resolved, confinedProjectRoot())
  if (confined !== null) return { kind: 'confined', message: confined }
  if (forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
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
    // A line anchor narrows an otherwise-ambiguous (or otherwise-fine) candidate list to the one
    // definition that starts on that exact line -- exact equality only, so it reduces to at most
    // one candidate. No match reuses the same "not found" shape as every other no-candidates
    // case in this function (a stale anchor from a moved/deleted definition is not a new kind of
    // failure) rather than inventing a distinct "bad anchor" error.
    const anchored = lineAnchor === undefined ? distinct : distinct.filter((c) => c.lineStart === lineAnchor)
    if (anchored.length === 0) return { kind: 'none' }
    if (anchored.length === 1) return { kind: 'ok', entry: anchored[0]! }
    return { kind: 'ambiguous', symbol: displaySymbol, file, candidates: anchored }
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
    // Narrow to the requested file's final path segment in SQL, not just in the `.filter` below: the query is `ORDER BY file_path, line_start LIMIT 50`, so for a symbol name with more than 50 definitions across the machine-wide index (`run`, `main`, `handler`) the requested file's row was cut before the filter ever saw it and a present symbol reported as missing, purely because its path sorted late. Basename equality holds for both directions of the path-boundary test below (a boundary suffix relation aligns whole segments), so this narrowing cannot drop a row the filter would have kept.
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

  // Cross-file multi-spec `src/a.ts::alphaFn,src/b.ts::betaFn`. Checked before the single-file `parseReadSpec` below because that function's `lastIndexOf('::')` would otherwise fold the whole spec into one bogus file/symbol pair -- see parseCrossFileMultiSpec for why it declines (and falls through here) on every spec the single-file path already handles correctly.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runReadMulti(crossFilePairs, opts)

  const { file, symbol } = parseReadSpec(opts.spec)

  // Multi-symbol form: `file::a,b,c`. Guarded against the numeric line-range spec `file::N,M`
  // (parseColonLineRange, consulted a few lines below on a resolution miss) so a comma there is
  // never misread as two symbol names -- `parseColonLineRange(symbol) === null` fails fast for
  // the numeric form and falls straight through to the existing single-symbol path, which still
  // reaches the `::N,M` fallback later exactly as before.
  if (symbol !== undefined && symbol !== '' && symbol.includes(',') && parseColonLineRange(symbol) === null) {
    const multiSymbols = symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (multiSymbols.length > 1) return runReadMulti(multiSymbols.map((s) => ({ file, symbol: s })), opts)
  }

  if (symbol === undefined || symbol === '') {
    // Only resolve against projectRoot when explicitly given and the path is relative -- same
    // convention as runSection, so absent-projectRoot CLI behavior stays byte-identical
    // (readFileText resolves a relative path against process.cwd() itself, as the CLI always
    // has). Without this the MCP confinement gate validated `<projectRoot>/x` while this read
    // fetched `<server cwd>/x`: two different files, so a relative spec escaped the workspace.
    const text = readFileText(resolveAgainstProjectRoot(file, opts.projectRoot))
    if (text === null) {
      // A bare name (no `::` at all, as opposed to a `file::` with an empty symbol) that isn't
      // a readable file is very likely a symbol name passed without its `file::` prefix --
      // "Could not read" would wrongly frame that as a filesystem problem.
      if (findSpecSeparator(opts.spec) === -1) {
        return { text: formatBareNameSpecError('read', file, opts.projectRoot), code: 1 }
      }
      return { text: `Could not read: ${file}`, code: 1 }
    }
    return { text: guardText(text, 'symbol'), code: 0 }
  }

  const resolution = resolveSymbolSpec(opts.spec, opts.forceRefresh, opts.projectRoot)

  if (resolution.kind === 'confined') return { text: resolution.message, code: 1 }

  if (resolution.kind === 'ambiguous') {
    // Genuine same-file ambiguity (a bare name matching several classes' methods, or a
    // qualifier that failed to narrow): refuse to guess. The error lists every candidate and
    // the qualified retry syntax instead of silently returning the first-ordered row.
    return {
      text: formatAmbiguity(
        resolution.symbol,
        resolution.file,
        resolution.candidates,
        opts.projectRoot,
      ),
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
    const crossFileLead = formatCrossFileLead('read', symbol, file, opts.projectRoot)
    if (crossFileLead !== '') messages.push(crossFileLead)
    const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
    // Query a bounded superset (FIND_SCAN_LIMIT, same bound runSymbol's near-name scan uses)
    // scoped to this one file, THEN rank by similarity and cap at DIDYOUMEAN_LIMIT -- capping
    // in the query itself would return an arbitrary storage-order first-N that can omit the
    // actual closest match entirely.
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const closes = rankSimilarNames(scanned, symbol)
    if (closes.length > 0) messages.push(didYouMean(closes))
    // No candidate resembled the query -- point at the command that lists the file's real
    // symbols instead of leaving the miss with no next step.
    else if (scanned.length > 0) messages.push(`Try: token-goat outline ${file}`)
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
        // The text branch below prepends staleWarning's DELETED line; without this the JSON form
        // would be the one surface that still passes a deleted file's body off as a live read.
        ...(fileIsGone(match.filePath) ? { deleted: true } : {}),
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
    `# ${countNoun(bodyLen, 'line')} (~${Math.ceil(body.length / 4)} tok)${statsStr}`,
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
function runReadMulti(pairs: { file: string; symbol: string }[], opts: ReadOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  // A bare symbol name is only a safe output key when every pair shares one file -- that is the pre-existing single-file `file::a,b` shape, so keying/prefixing by bare name there keeps output byte-for-byte identical to before cross-file specs existed. Once more than one distinct file is involved, two files can legitimately contribute the same symbol name, so the key must be the full `file::symbol` pair or one entry would silently overwrite the other.
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string =>
    distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`

  for (const { file, symbol } of pairs) {
    const sub = runRead({ ...opts, spec: `${file}::${symbol}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    const key = keyFor({ file, symbol })
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real
      // JSON per symbol, never an embedded string -- a failed sub-call has no JSON body of its
      // own, so it is represented by its plain-text error instead.
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  // Count each distinct file's on-disk size once for the whole multi-symbol call, not once per symbol or per file repeat -- each sub-call already skipped its own recordReadStat via suppressStat for exactly this reason (see ReadOptions.suppressStat).
  if (anyFound) {
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, (f) => resolveIndexPath(f, opts.projectRoot ?? process.cwd())))
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
  /**
   * Suppress this call's own `recordReadStat`. Set by {@link runSectionMulti} when delegating
   * to a recursive `runSection` call per heading, so the multi-heading call records exactly
   * one stat for the whole spec instead of one per heading -- same reasoning as
   * {@link ReadOptions.suppressStat} for `runReadMulti`. Not a CLI/MCP-facing option.
   */
  suppressStat?: boolean
}

/**
 * The base a relative file path resolves against on disk. Resolves against `projectRoot` only
 * when one was explicitly given AND the path is relative: an absolute path, or the no-projectRoot
 * default every CLI caller takes, is returned untouched so those paths stay byte-identical to the
 * long-standing behavior of resolving against `process.cwd()` inside the read helpers themselves.
 *
 * This is the execution-side half of the MCP confinement invariant (see `resolveToolRoot` in
 * mcp_server.ts): the gate admits a relative target by resolving it against the project root, so
 * every disk read on that path must resolve it against the same root or the check guards a
 * different file than the one served.
 */
function resolveAgainstProjectRoot(file: string, projectRoot: string | undefined): string {
  return projectRoot !== undefined && !path.isAbsolute(file) ? path.resolve(projectRoot, file) : file
}

/** Handle ``token-goat section "file::Heading"``. */
// True when the file carries a heading whose text is exactly the given spec (case-insensitive, trimmed), optionally with a trailing `#<digits>` ordinal stripped off first. Deliberately literal rather than going through readSection: readSection's prefix and word-subset tiers would happily resolve a comma-separated fragment, which is the very ambiguity this check exists to settle.
function literalHeadingExists(filePath: string, heading: string): boolean {
  const ordinalMatch = /^([^#\r\n]+)#(\d+)$/.exec(heading)
  const base = (ordinalMatch?.[1] ?? heading).trim().toLowerCase()
  if (base.length === 0) return false
  return listSections(filePath, readFileText).some((h) => h.trim().toLowerCase() === base)
}

export function runSection(opts: SectionOptions): { text: string; code: number } {
  // Cross-file multi-spec `src/a.ts::Commands,src/b.ts::Component Map`. Checked before the single-file `::` handling below for the same reason runRead checks it first (see parseCrossFileMultiSpec) -- lastIndexOf('::') would otherwise fold the whole spec into one bogus file/heading pair, and parseCrossFileMultiSpec already declines (falling through here unchanged) for every spec the single-file path below already handles correctly, including the pre-existing same-file `file::A,B` multi-heading form.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runSectionCrossFile(crossFilePairs, opts)

  const colonIdx = findSpecSeparator(opts.spec)
  if (colonIdx === -1) {
    return { text: `Invalid section spec — expected "file::Heading", got: ${opts.spec}`, code: 1 }
  }
  const specFilePath = opts.spec.slice(0, colonIdx)
  // Only resolve against projectRoot when explicitly given and the spec's file part is
  // relative -- an absolute path, or the no-projectRoot default, stays byte-identical to the
  // pre-existing behavior (readSection/listSections resolve a relative path against
  // process.cwd() themselves, same as the CLI always has).
  const filePath = resolveAgainstProjectRoot(specFilePath, opts.projectRoot)
  const heading = opts.spec.slice(colonIdx + 2)

  // Multi-heading form: `file::A,B,C`. Mirrors runRead's `file::a,b,c` multi-symbol grammar
  // (see runReadMulti) -- section headings carry no numeric-range meaning of their own (unlike
  // read's `file::N,M` line-range spec), so no numeric guard is needed before splitting on the
  // comma. Unlike a symbol name, though, a heading may legitimately contain a comma ("## Setup,
  // Teardown"), so a literal heading of that text wins over the multi-heading reading -- same
  // precedence parseHeadingSpec applies to a trailing `#<digits>`. Without this, asking for a
  // present heading returned two unrelated sections with exit 0 and no sign the real one existed.
  if (heading.includes(',') && !literalHeadingExists(filePath, heading)) {
    const multiHeadings = heading.split(',').map((h) => h.trim()).filter((h) => h.length > 0)
    if (multiHeadings.length > 1) return runSectionMulti(specFilePath, filePath, multiHeadings, opts)
  }

  const result = readSection(filePath, heading, readFileText)
  if (result === null) {
    // readSection returns null both when the file is unreadable (missing, permissions, etc.)
    // and when the file exists but the heading isn't in it -- distinguish the two so a bad
    // path doesn't masquerade as a missing section (an agent debugging "section not found"
    // wastes turns hunting for a heading that was never the actual problem).
    if (!fs.existsSync(filePath)) {
      return { text: `File not found: '${filePath}'`, code: 1 }
    }
    // An out-of-range ordinal (`Fixed#9` in a file with five `Fixed` headings) is not a missing
    // heading, and reporting it as one sends the caller hunting for text that is right there. The
    // base spec resolves, and its `occurrences` says how many there really are.
    const ordSpec = /^(.*?)#(\d+)$/.exec(heading)
    const ordBase = ordSpec?.[1]?.trim()
    if (ordBase !== undefined && ordBase.length > 0) {
      const baseResult = readSection(filePath, ordBase, readFileText)
      if (baseResult !== null) {
        const total = baseResult.occurrences?.length ?? 1
        return {
          text:
            `Heading '${ordBase}' has ${countNoun(total, 'occurrence')} in '${specFilePath}'; ` +
            `valid ordinals are #1 to #${total}`,
          code: 1,
        }
      }
    }
    const messages = [`Section '${heading}' not found in '${filePath}'`]
    const allHeadings = listSections(filePath, readFileText)
    const available = filterSimilarHeadings(allHeadings, heading)
    if (available.length > 0) messages.push(didYouMean(available))
    // The similarity filter correctly drops every candidate when the query resembles no heading, which would otherwise leave the miss with no next step -- worse than the unfiltered dump it replaced, since that at least revealed what the file contained. Point at outline (the command that lists headings), mirroring the `Try: token-goat semantic` fallback runSymbol prints for the same shape of dead end. A file with no headings at all is a different answer and gets said outright, because sending the caller to outline there would just print nothing.
    else if (allHeadings.length === 0) messages.push(`'${specFilePath}' has no headings`)
    else messages.push(`Try: token-goat outline ${specFilePath}`)
    return { text: messages.join('\n'), code: 1 }
  }

  // Several headings share this name and the caller did not say which. Returning the first one
  // silently is how `section "CHANGELOG.md::Fixed"` handed back the newest release's entry with
  // no hint that four older ones existed -- the caller cannot tell a lucky hit from a wrong one.
  // Refuse and name the qualified retries, exactly as `read` does for an ambiguous symbol. The
  // ambiguity rides on the result rather than collapsing it to null, so the not-found branch
  // above can never report a heading that is plainly present as missing.
  if (result.occurrences !== undefined) {
    const lines = [
      `Ambiguous heading '${heading}' in '${specFilePath}': ` +
        `${countNoun(result.occurrences.length, 'heading')} match. ` +
        `Retry with one of the qualified commands below to pick one:`,
    ]
    for (const [i, line] of result.occurrences.slice(0, AMBIGUOUS_HEADING_LIMIT).entries()) {
      lines.push(`  - line ${line}  ->  token-goat section "${specFilePath}::${heading}#${i + 1}"`)
    }
    if (result.occurrences.length > AMBIGUOUS_HEADING_LIMIT) {
      lines.push(`  (${result.occurrences.length - AMBIGUOUS_HEADING_LIMIT} more not shown)`)
    }
    return { text: lines.join('\n'), code: 1 }
  }

  // A prefix-redirected match (readSection resolved a different heading than the one asked
  // for) is recorded as section_replacement rather than a plain section_read, mirroring the
  // "replacement" framing used by read_replacement for a substituted read elsewhere in this
  // file.
  const kind = result.redirectedFrom !== undefined ? 'section_replacement' : 'section_read'
  const fullSourceBytes = sumFileSizes([filePath])

  if (opts.json === true) {
    const text = JSON.stringify(result, null, 2)
    if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
    return { text, code: 0 }
  }

  const redirectNote =
    result.redirectedFrom !== undefined ? ` (redirected from: '${result.redirectedFrom}')` : ''
  const text = guardText(
    `# ${result.heading} — ${filePath}:${result.lineStart}-${result.lineEnd}${redirectNote}\n${result.content}`,
    'heading',
  )
  if (opts.suppressStat !== true) recordReadStat(kind, fullSourceBytes, text, heading)
  return { text, code: 0 }
}

/**
 * Handle ``token-goat section "file::A,B,C"`` -- fetch several sections from one file in a
 * single call, mirroring `read`'s comma-separated multi-symbol grammar (see
 * {@link runReadMulti}). Delegates each heading to a recursive {@link runSection} call
 * (`suppressStat: true`) rather than reimplementing resolution, so not-found + did-you-mean
 * and JSON shape all come from the exact same code path the single-heading form already
 * exercises -- a failure to resolve one heading is reported inline instead of aborting the
 * whole call, same as `runReadMulti`'s per-symbol handling.
 */
function runSectionMulti(
  specFilePath: string,
  resolvedFilePath: string,
  headings: string[],
  opts: SectionOptions,
): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const heading of headings) {
    const sub = runSection({ ...opts, spec: `${specFilePath}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real
      // JSON per heading, never an embedded string -- a failed sub-call has no JSON body of
      // its own, so it is represented by its plain-text error instead.
      jsonOut[heading] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${heading}:\n${sub.text}`)
  }

  // Count the file's on-disk size once for the whole multi-heading call, not once per
  // heading -- each sub-call already skipped its own recordReadStat via suppressStat for
  // exactly this reason (see SectionOptions.suppressStat).
  const fullSourceBytes = sumFileSizes([resolvedFilePath])
  const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

/**
 * Handle a cross-file multi-heading spec `src/a.ts::Commands,src/b.ts::Component Map` -- mirrors {@link runReadMulti} exactly (see its docstring), with `symbol` on each pair carrying a heading name instead of a symbol name. Delegates each heading to a recursive {@link runSection} call (`suppressStat: true`), so not-found + did-you-mean and JSON shape all come from the exact same single-heading path `runSectionMulti` already exercises -- a failure to resolve one heading is reported inline instead of aborting the whole call.
 */
function runSectionCrossFile(pairs: { file: string; symbol: string }[], opts: SectionOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  // A bare heading is only a safe output key when every pair shares one file -- that is the pre-existing single-file `file::A,B` shape, so keying by bare heading there keeps output byte-for-byte identical to before cross-file specs existed. Once more than one distinct file is involved, two files can legitimately share a heading name (`## Commands` is common), so the key must be the full `file::heading` pair or one entry would silently overwrite the other -- same reasoning as `runReadMulti`'s `keyFor`.
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string =>
    distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`

  for (const { file, symbol: heading } of pairs) {
    const sub = runSection({ ...opts, spec: `${file}::${heading}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    const key = keyFor({ file, symbol: heading })
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real
      // JSON per heading, never an embedded string -- a failed sub-call has no JSON body of its
      // own, so it is represented by its plain-text error instead.
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  // Resolves the same way runSection resolves its own `filePath` -- relative to projectRoot only when one is given and the path isn't already absolute -- so the byte count backing this call's stat matches what a single-file call against the same path would have counted.
  const resolvePath = (f: string): string =>
    opts.projectRoot !== undefined && !path.isAbsolute(f) ? path.resolve(opts.projectRoot, f) : f

  const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
  if (anyFound) {
    // Count each distinct file's on-disk size once for the whole cross-file call, not once per heading or per file repeat -- each sub-call already skipped its own recordReadStat via suppressStat for exactly this reason (see SectionOptions.suppressStat).
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, resolvePath))
    recordReadStat('section_read', fullSourceBytes, text, opts.spec)
  }
  return { text, code: anyFound ? 0 : 1 }
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
  /**
   * `-C, --context <n>`: lines of real source text to show either side of each reference. The
   * existing per-reference line already answers *where* a symbol is used and names the enclosing
   * symbol, but never shows the call site itself; this adds the surrounding source in `grep -C`'s
   * exact framing (see {@link renderContextWindow}). Defaults to 0, in which case every output
   * byte -- text and JSON alike -- is unchanged.
   */
  context?: number
  /** `--exclude-tests`: drop references whose call site lives in a test file (per isTestFile). Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only list references whose call-site FILE PATH matches this pattern (rows render as `file:line: symbol`, so this is the field each row is keyed on -- matched against the path as RENDERED under displayRoot, so an anchored `--grep "^src/"` matches what the caller sees; the high-value case is a wide-fanout symbol where that drops test/vendored hits). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
  /** Workspace root to scope this lookup to: resolves the `file::symbol` defining-file hint against, and scopes queryRefs' call-site rows to this root (the same `queryOpts.rootDir` mechanism `symbol` uses) so refs from other projects in the shared global index never surface. Optional and unset for CLI callers, who resolve against `process.cwd()` -- see `resolveAgainstProjectRoot`/`SemanticOptions.projectRoot` for the established convention this mirrors. */
  projectRoot?: string
}

/**
 * One reference rendered as `path:line: <enclosing symbol>` (today's line, always emitted
 * verbatim), optionally followed by its `-C` source window. Shared by all three `refs` rendering
 * paths (single, multi-symbol, cross-file) so `-C` cannot drift between them.
 */
// The ONE place every `refs` output path -- text rows, --top summaries, --json payloads, and the --grep filter -- turns a stored absolute path into the path a caller sees. It takes no root argument on purpose: the previous shape passed a root per call site, so runRefsSingle rendered root-relative while the multi-symbol and cross-file paths passed `undefined` and rendered absolute (the same path spelled two ways depending only on how many symbols you asked for), and a filter handed a different root than its renderer silently tested a string the caller could not see (the `--grep "^src/"` matches-nothing bug). Sourcing the root here makes both divergences unrepresentable rather than merely fixed.
function refsDisplayPath(p: string): string {
  return toDisplayPath(getDisplayRoot(), p)
}

function refGrepFilter(grep: string | undefined): ((r: RefEntry) => boolean) | undefined {
  if (grep === undefined) return undefined
  const matches = compileGrepMatcher(grep)
  return (r) => matches(refsDisplayPath(r.filePath))
}

/** JSON reference rows as emitted: `-C` windows attached first (they read from disk, so they need the raw absolute path), then `filePath` rewritten to the same display spelling the text rows use -- root-relative and reproducible rather than absolute and specific to one machine's drive-letter casing, matching what outline/skeleton `--json` already do. */
function refsJsonItems<T extends RefEntry>(items: T[], contextLines: number): (T & { contextLines?: SourceContextLine[] })[] {
  return withContextLines(items, contextLines).map((r) => ({ ...r, filePath: refsDisplayPath(r.filePath) }))
}

function renderRefLines(ref: RefEntry, contextLines: number, indent = '  '): string[] {
  const displayPath = refsDisplayPath(ref.filePath)
  const base = `${indent}${displayPath}:${ref.line}: ${ref.context}`
  const window = buildContextWindow(ref.filePath, ref.line, contextLines)
  if (window === null) return [base]
  return [base, ...renderContextWindow(displayPath, ref.line, window, '', `${indent}  `)]
}

/** Attaches a `contextLines` array to each JSON reference item when `-C` was requested. The pre-existing `context` field (the enclosing symbol NAME) is left untouched -- these are different things and consumers already depend on the old one. */
function withContextLines<T extends RefEntry>(items: T[], contextLines: number): (T & { contextLines?: SourceContextLine[] })[] {
  if (!(contextLines > 0)) return items
  return items.map((r) => ({ ...r, contextLines: buildContextWindow(r.filePath, r.line, contextLines) ?? [] }))
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
/**
 * The root every `refs` query is scoped to. `refs` searches the whole index by symbol NAME, so
 * unlike the file-spec commands it cannot be gated by one path: leaving `rootDir` unset returns
 * reference sites -- path, line and surrounding source context -- from every project on the
 * machine. Falling back to the confining root scopes the search the same way `symbol`'s bare-name
 * path already does.
 */
function refsRootDir(opts: { projectRoot?: string }): string | undefined {
  return opts.projectRoot ?? confinedProjectRoot() ?? undefined
}

/** Every file named by a `refs` spec: the cross-file form's per-pair files, or the single file of a `file::symbol` spec. A bare symbol name contributes none, and is confined by {@link refsRootDir} instead. */
function refsSpecFiles(spec: string): string[] {
  const crossFile = parseCrossFileMultiSpec(spec)
  if (crossFile !== null) return [...new Set(crossFile.map((p) => p.file))]
  const { file } = parseMultiRefsSpec(spec)
  return file === undefined ? [] : [file]
}

/** One name to report references for: the symbol, the file that DEFINES it (used only to disambiguate same-named symbols, never to narrow the query -- and absent for a bare-name spec, which is why it is optional), and the key it is listed under in the output. */
interface RefsTarget {
  file: string | undefined
  symbol: string
  key: string
}

/**
 * Render references for several named targets, one block (or JSON entry) each.
 *
 * Shared by runRefs's same-file multi-symbol path (`file::a,b`, keyed by bare symbol) and
 * runRefsCrossFile's pair path (`a.ts::x,b.ts::y`, keyed by symbol or by the full `file::symbol`
 * pair). Those were two loops written out separately and kept in step by hand, described in
 * runRefsCrossFile's own docblock as mirroring this one -- same query construction, same
 * `--callers`/`--limit`/`--top`/`--grep`/`--exclude-tests`/`--json` handling, differing only in
 * where each target's `file` and output key come from. Keeping two copies of that in step by hand
 * is how they drift, and they already had (see `annotateHiddenByGrep`).
 *
 * Prints directly and returns a bare exit code rather than `{text, code}`, per runRefs's own
 * existing convention.
 */
function renderRefsTargets(
  targets: RefsTarget[],
  opts: RefsOptions,
  {
    annotateHiddenByGrep,
  }: {
    /**
     * Whether a JSON entry filtered by --grep carries a `hiddenByGrep` count.
     *
     * True for the same-file multi-symbol path and false for the cross-file one, which is not a
     * design decision but the drift this consolidation found: the fix that added the key was
     * applied to one of the two mirrored loops and not the other, so `refs "a.ts::x,b.ts::y"
     * --json --grep` still cannot tell "--grep matched none of the N that exist" from a genuine
     * absence. Preserved exactly as-is here rather than quietly corrected, because changing what a
     * command emits is not a refactor's call to make; it is now one flag in one place instead of a
     * silent difference a hundred lines apart.
     */
    annotateHiddenByGrep: boolean
  },
): number {
  // Every entry uses the same envelope shape as the single-symbol `refs`/`symbol`/`skeleton`/
  // `outline` JSON output ({ items, truncated, totalCount }), whether or not it was truncated —
  // a JSON consumer should never have to branch on shape depending on truncation. `--top` opts
  // into a distinct, deliberately different envelope ({ fileCounts, totalFiles, totalRefs,
  // shown }) since the caller explicitly asked for the grouped summary shape instead.
  const jsonOut: Record<string, RefsJsonEntry> = {}
  let anyFound = false
  const lines: string[] = []
  const refFilePaths: string[] = []
  for (const { file, symbol, key } of targets) {
    const queryOpts: Parameters<typeof queryRefs>[0] = { name: symbol }
    // The `file` in `file::symbol` names where the symbol is DEFINED, only used to disambiguate a same-named symbol elsewhere in the index via applyTypedRefsTier below. It must never be passed to queryRefs/countRefs -- refs.file_path there is the file a REFERENCE occurs in, not where the symbol is defined, so doing so would wrongly narrow every result (not just --callers) to same-file references only.
    // --grep needs the same full-headroom query as --exclude-tests -- see runRefsSingle's sibling comment.
    if (opts.excludeTests === true || opts.grep !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT
    else if (opts.limit !== undefined) queryOpts.limit = opts.limit
    else if (opts.top !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT
    const rootDir = refsRootDir(opts)
    if (rootDir !== undefined) queryOpts.rootDir = rootDir
    const scanned = queryRefs(queryOpts)
    const preScanCount = scanned.length
    let results = applyTypedRefsTier(symbol, file, scanned)
    let suppressed = 0
    if (opts.excludeTests === true) {
      const f = applyExcludeTestsFilter(results)
      suppressed = f.suppressed
      results = f.refs
    }
    // --grep narrows by call-site file path, before the requested-limit slice -- see runRefsSingle's sibling comment. It tests the path as refsDisplayPath renders it, the same spelling the rows below show.
    const preGrepCount = results.length
    const matchesGrep = refGrepFilter(opts.grep)
    if (matchesGrep !== undefined) results = results.filter(matchesGrep)
    let filteredTotal: number | undefined
    if (opts.excludeTests === true || matchesGrep !== undefined) filteredTotal = results.length
    if ((opts.excludeTests === true || matchesGrep !== undefined) && opts.top === undefined) {
      results = results.slice(0, opts.limit ?? 100)
    }
    if (results.length > 0) anyFound = true
    refFilePaths.push(...results.map((r) => r.filePath))
    if (opts.json === true) {
      // Same omit-when-zero `hiddenByGrep` the single-spec JSON path emits, per target here: a
      // symbol whose entry is `items: []` because --grep matched none of its references must not
      // be indistinguishable from one that genuinely has none.
      const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
      const withHidden = <T extends object>(payload: T): T => ({ ...payload, ...(annotateHiddenByGrep && hiddenByGrep > 0 ? { hiddenByGrep } : {}) })
      if (opts.top !== undefined) {
        jsonOut[key] = withHidden(topFilesJsonPayload(results, opts.top))
      } else {
        // `results` is already truncated by queryRefs's own SQL `LIMIT` (opts.limit, or the
        // default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length)
        // is not the real number of matching refs -- countRefs reruns the same filters with no
        // LIMIT to report an honest total (same fix as runSymbol's countSymbols call). Under
        // --exclude-tests or --grep, countRefs has no way to rerun that filter, so filteredTotal
        // (the pre-slice filtered count, already scanned with full headroom above) is the honest total.
        const capped = guardJsonRows(results)
        const trueTotal = (opts.excludeTests === true || matchesGrep !== undefined) ? (filteredTotal ?? results.length) : countRefs(queryOpts)
        jsonOut[key] = withHidden({ items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal })
      }
      continue
    }
    if (results.length === 0) {
      // Distinguish "--grep matched none of the N references that do exist" for this target from a genuine absence -- same trap already fixed for dead/deps/types, and checked first so it takes priority over the --exclude-tests message below.
      if (matchesGrep !== undefined && preGrepCount > 0) {
        lines.push(`${key}: ${grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'reference', 'references').trim()}`)
        continue
      }
      // A symbol referenced only from tests must not read as unreferenced here either -- same reasoning as the single-spec path above. Flag-absent output is untouched: suppressed is always 0 then.
      lines.push(opts.excludeTests === true && suppressed > 0 ? `${key}: (no non-test references found; ${excludeTestsHiddenNote(suppressed)})` : `${key}: (no references found)`)
      continue
    }
    lines.push(`${key}:`)
    if (opts.top !== undefined) {
      lines.push(...renderTopFilesSummary(results, opts.top, suppressed))
    } else if (opts.callers === true) {
      if (opts.excludeTests === true && suppressed > 0) lines.push(`  ${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`)
      lines.push(...renderCallerGroups(results, opts.context ?? 0))
    } else {
      if (opts.excludeTests === true && suppressed > 0) lines.push(`  ${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`)
      for (const ref of results) lines.push(...renderRefLines(ref, opts.context ?? 0))
    }
    // Per target, not once for the whole call: each name has its own total, and a single footer
    // under the last block would read as applying to all of them. `--top` renders its own note.
    if (opts.top === undefined) {
      const notice = truncationNotice(
        results.length,
        opts.limit ?? 100,
        () => refsTotal(opts.excludeTests === true || matchesGrep !== undefined, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount),
        'references',
        '--limit',
      )
      if (notice !== null) lines.push(`  token-goat: ${notice}`)
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

  // Same confinement the file-spec read commands enforce, applied before any query: an explicit
  // --project or an out-of-root file in the spec would otherwise re-open the channel that
  // refsRootDir closes for the bare-name form.
  const confinedRoot = confinedProjectRoot()
  if (confinedRoot !== null) {
    const projectDenial = opts.projectRoot === undefined ? null : confinementRefusal('--project', opts.projectRoot, confinedRoot)
    if (projectDenial !== null) {
      emitErr(projectDenial)
      return 1
    }
    for (const file of refsSpecFiles(opts.spec)) {
      const denial = confinementRefusal('This file', resolveIndexPath(file, opts.projectRoot ?? process.cwd()), confinedRoot)
      if (denial !== null) {
        emitErr(denial)
        return 1
      }
    }
  }

  // Cross-file multi-spec `src/a.ts::fnA,src/b.ts::fnB`. Checked before the single-file `::` handling below for the same reason runRead/runSection check it first (see parseCrossFileMultiSpec) -- parseMultiRefsSpec's findSpecSeparator is a lastIndexOf('::'), so a spec crossing a file boundary would otherwise fold into one bogus file/symbol-list pair and silently miss every symbol but the last (the reported bug: `refs "a.ts::x,b.ts::y"` parsed as file=`a.ts::x,b.ts` symbol=`y`, that nonexistent file matched nothing, and a referenced symbol was reported as unreferenced). parseCrossFileMultiSpec already declines (falling through here unchanged) for every spec the single-file path below already handles correctly, including the pre-existing same-file `file::a,b` multi-symbol form.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runRefsCrossFile(crossFilePairs, opts)

  const { file, symbols } = parseMultiRefsSpec(opts.spec)
  if (symbols.length <= 1) return runRefsSingle(opts)

  return renderRefsTargets(
    symbols.map((symbol) => ({ file, symbol, key: symbol })),
    opts,
    { annotateHiddenByGrep: true },
  )
}

/** Cross-file refs, e.g. `src/a.ts::fnA,src/b.ts::fnB`. Renders through the shared renderRefsTargets above, same as runRefs's same-file multi-symbol path -- the two used to be separate loops kept in step by hand. What is local to this form is the `keyFor` rule it shares with runSectionCrossFile/runReadMulti: one distinct file across all pairs keys by bare symbol (matches today's same-file `refs "file::a,b"` output byte-for-byte), more than one keys by the full `file::symbol` pair so two files contributing the same symbol name stay distinct. */
function runRefsCrossFile(pairs: { file: string; symbol: string }[], opts: RefsOptions): number {
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string => (distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`)
  return renderRefsTargets(
    pairs.map((p) => ({ file: p.file, symbol: p.symbol, key: keyFor(p) })),
    opts,
    // Not annotated today; renderRefsTargets's own option doc explains why that is a preserved
    // divergence rather than a decision.
    { annotateHiddenByGrep: false },
  )
}

/** Handle ``token-goat refs file::symbol``. */
function runRefsSingle(opts: RefsOptions): number {
  const { file, symbol } = parseReadSpec(opts.spec)
  const symName = symbol ?? file

  const queryOpts: Parameters<typeof queryRefs>[0] = { name: symName }
  // `file` in `file::symbol` names where the symbol is DEFINED, used only to disambiguate a same-named symbol elsewhere in the index (fed to applyTypedRefsTier's querySymbols({name, filePath}) call below, where filePath genuinely is the defining file). It must never be passed to queryRefs/countRefs: refs.file_path there is the file a REFERENCE occurs in, not where the symbol is defined, so doing so would wrongly narrow every result to same-file references only.
  const defFileHint = symbol !== undefined ? resolveIndexPath(file, opts.projectRoot ?? process.cwd()) : undefined
  // --grep needs the same full-headroom query as --exclude-tests, since it also filters the
  // resolved set client-side (on filePath) AFTER the query -- slicing to the requested limit
  // before it runs would silently under-return by letting non-matching refs occupy slots ahead
  // of the cutoff.
  if (opts.excludeTests === true || opts.grep !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT
  else if (opts.limit !== undefined) queryOpts.limit = opts.limit
  else if (opts.top !== undefined) queryOpts.limit = REFS_TOP_SCAN_LIMIT
  const rootDir = refsRootDir(opts)
  if (rootDir !== undefined) queryOpts.rootDir = rootDir

  const scanned = queryRefs(queryOpts)
  // How full the query window came back, so a client-side filter drawn from a window that filled
  // can report its count as a floor rather than as a total. See {@link refsTotal}.
  const preScanCount = scanned.length
  let results = applyTypedRefsTier(symName, defFileHint, scanned)
  let suppressed = 0
  if (opts.excludeTests === true) {
    const f = applyExcludeTestsFilter(results)
    suppressed = f.suppressed
    results = f.refs
  }
  // --grep narrows by the reference's call-site FILE PATH (the field each row is keyed on: `file:line: symbol`), and runs BEFORE the requested-limit slice below so it selects from the whole (test-filtered) set rather than from an already-capped page. It tests the path as refsDisplayPath renders it, so an anchored pattern matches what the caller sees.
  const preGrepCount = results.length
  const matchesGrep = refGrepFilter(opts.grep)
  if (matchesGrep !== undefined) results = results.filter(matchesGrep)
  let filteredTotal: number | undefined
  if (opts.excludeTests === true || matchesGrep !== undefined) filteredTotal = results.length
  if ((opts.excludeTests === true || matchesGrep !== undefined) && opts.top === undefined) {
    results = results.slice(0, opts.limit ?? 100)
  }

  if (results.length === 0) {
    // Distinguish "--grep matched none of the N references that do exist" from a symbol that
    // genuinely has no references (or none outside tests) -- same "filtered store renders as
    // populated" trap already fixed for dead/deps/types. Checked first so it takes priority
    // over the --exclude-tests message below when both filters are active and --grep is what
    // zeroed the remaining set.
    if (matchesGrep !== undefined && preGrepCount > 0) {
      // Exits 0, so under --json a prose notice would pair a success status with an unparseable
      // body. Same `{items, truncated, totalCount}` envelope the populated branch emits, with the
      // post-filter count; text mode keeps the human notice.
      if (opts.json === true) {
        // `hiddenByGrep` (brief --json's own convention) is what tells the consumer this empty
        // envelope is a filtered view rather than a symbol with no references -- `totalCount: 0`
        // alone reads identically for both.
        emit(JSON.stringify({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preGrepCount }, null, 2))
        return 0
      }
      emit(grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'reference', 'references'))
      return 0
    }
    // "No references found" plus exit 1 for a symbol that IS referenced -- only from tests -- reads as "this symbol is unused", which invites deleting live code. Name the suppressed count so the filtered view is never mistaken for absence. Flag-absent output is untouched: suppressed is always 0 then.
    if (opts.excludeTests === true && suppressed > 0) {
      emitErr(`No non-test references found for '${symName}' (${excludeTestsHiddenNote(suppressed)})`)
      return 1
    }
    // Distinguish "not indexed at all" from "indexed, genuinely zero references" -- the latter
    // keeps today's message byte-identical (see unknownSymbolSuggestion's own doc comment for
    // why this matters). Resolved here rather than hoisted to the top of the function since it's
    // only ever paid once the query already came back empty.
    const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
    if (querySymbols({ name: symName, rootDir, limit: 1 }).length === 0) {
      emitErr(`Symbol not found: ${symName}${unknownSymbolSuggestion(symName, rootDir)}`)
      // Same empty-index note as the "No references found" branch below -- an empty project
      // index makes EVERY symbol look unindexed, so this must still surface the real cause
      // instead of leaving the caller staring at a suggestion-free "not found" for a project
      // that was simply never indexed.
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
    emitErr(`No references found for '${symName}'`)
    // Only paid after the query already came back empty, and only in text mode -- this branch
    // already emits plain prose regardless of --json (there's no separate opts.json check
    // here), so there's no JSON envelope to protect either way.
    if (opts.json !== true) {
      if (isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    }
    return 1
  }

  const fullSourceBytes = sumFileSizes(results.map((r) => r.filePath))

  if (opts.json === true) {
    let payload: RefsJsonEntry
    if (opts.top !== undefined) {
      payload = topFilesJsonPayload(results, opts.top)
    } else {
      // Same "SQL LIMIT applied before totalCount is taken" fix as runRefs's per-symbol branch above.
      // Same --exclude-tests/--grep honest-total reasoning as runRefs's per-symbol branch above.
      const capped = guardJsonRows(results)
      const trueTotal = (opts.excludeTests === true || matchesGrep !== undefined) ? (filteredTotal ?? results.length) : countRefs(queryOpts)
      payload = { items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
    }
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially
    // filtered page carries the count too rather than only the fully emptied one. Spread onto the
    // emitted object rather than into `payload` so both `--top` and per-reference envelopes get it
    // without either shape's interface growing an optional field the other never sets.
    const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
    const text = JSON.stringify({ ...payload, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) }, null, 2)
    emit(text)
    recordReadStat('symbol_read', fullSourceBytes, text, symName)
    return 0
  }

  const lines =
    opts.top !== undefined
      ? renderTopFilesSummary(results, opts.top, suppressed)
      : opts.callers === true
        ? [...(opts.excludeTests === true && suppressed > 0 ? [`${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`] : []), ...renderCallerGroups(results, opts.context ?? 0)]
        : [...(opts.excludeTests === true && suppressed > 0 ? [`${countNoun(results.length, 'reference')} (${excludeTestsHiddenNote(suppressed)})`] : []), ...results.flatMap((ref) => renderRefLines(ref, opts.context ?? 0, ''))]
  // `--top` renders its own elision note; the per-reference modes printed exactly `limit` lines and
  // stopped, so 100 of 150 references read as "these are all of them". Same honest total the --json
  // branch above computes, and only paid when the page came back full.
  const refsFooter = opts.top !== undefined ? '' : truncationFooter(results.length, opts.limit ?? 100, () => refsTotal(opts.excludeTests === true || matchesGrep !== undefined, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount), 'references', '--limit')
  const text = lines.join('\n')
  // Guarded first, footer after: the overflow guard must not be able to trim off the very line
  // that says how much was left out.
  emit(guardText(text, 'symbol') + refsFooter)
  recordReadStat('symbol_read', fullSourceBytes, text + refsFooter, symName)
  return 0
}

interface FileRefCount {
  readonly file: string
  readonly count: number
}

/** `--exclude-tests`: drops references whose call site is a test file, per {@link isTestFile}. Callers must query with enough headroom (REFS_TOP_SCAN_LIMIT) for this to run BEFORE any `--limit`/`--top` slicing, or the flag silently under-returns by letting suppressed test refs occupy slots ahead of the cutoff. */
function applyExcludeTestsFilter(refs: RefEntry[]): { refs: RefEntry[]; suppressed: number } {
  const filtered = refs.filter((r) => !isTestFile(r.filePath))
  return { refs: filtered, suppressed: refs.length - filtered.length }
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

/** Renders the `--top N` grouped-by-file summary: a header line with total refs/files, then one `count  file` line per shown file, then an elision note naming exactly how many files and refs were dropped (never a silent truncation -- see this repo's no-silent-caps convention). `suppressed`, when > 0, appends an additive note naming how many test-file references `--exclude-tests` hid -- omitted entirely (byte-identical to today) whenever it's 0/undefined. */
function renderTopFilesSummary(refs: RefEntry[], topN: number, suppressed?: number): string[] {
  const grouped = groupRefsByFile(refs)
  const shown = grouped.slice(0, topN)
  const suppressedNote = suppressed !== undefined && suppressed > 0 ? ` (${excludeTestsHiddenNote(suppressed)})` : ''
  const lines = [`${countNoun(refs.length, 'reference')} across ${countNoun(grouped.length, 'file')} (showing top ${shown.length})${suppressedNote}`]
  for (const { file, count } of shown) lines.push(`  ${count}  ${refsDisplayPath(file)}`)
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
  // Same display spelling as the text `--top` summary this envelope mirrors -- see refsDisplayPath.
  return { fileCounts: shown.map((g) => ({ ...g, file: refsDisplayPath(g.file) })), totalFiles: grouped.length, totalRefs: refs.length, shown: shown.length }
}

type RefsJsonEntry = { items: RefEntry[]; truncated: boolean; totalCount: number } | RefsTopJsonEntry

function renderCallerGroups(refs: RefEntry[], contextLines = 0): string[] {
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
    const displayPath = refsDisplayPath(file)
    lines.push(`${displayPath}:`)
    for (const ref of fileRefs) {
      lines.push(`  :${ref.line}  ${ref.context !== '' ? ref.context : '(module scope)'}`)
      const window = buildContextWindow(file, ref.line, contextLines)
      if (window !== null) lines.push(...renderContextWindow(displayPath, ref.line, window, '', '    '))
    }
  }
  return lines
}

// ---- skeleton / stub_view ---------------------------------------------------

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

/**
 * "No indexed symbols" is ambiguous on its own: a genuinely empty file, an unrecognized
 * extension, and a recognized-but-unsupported language (Scala, Lua, Elixir, Dart, Zig, R --
 * see {@link unsupportedLanguageName}) all currently produce zero symbol rows and
 * look identical from the CLI's perspective. Callers get a clearer diagnostic distinguishing
 * "token-goat can't parse this language at all yet" from a plain empty-index result.
 */
function noSymbolsMessage(displayPath: string, resolvedPath: string): string {
  // A path that does not exist reads as "this file has no symbols", so a typo or a stale path guess looks like a definitive answer about a real file and the caller stops looking instead of fixing the path. Checked before the language branch: a missing `foo.scala` is a wrong path, not an unsupported extractor. Wording is `exports`/`imports`/`deps`/`test-for`' verbatim, which already close this same gap.
  if (!fs.existsSync(resolvedPath)) {
    return `Could not read: ${displayPath}`
  }
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
    ? `  [${countNoun(refCounts.get(sym.name) ?? 0, 'ref')}, ${hasRealDocstring(sym.docstring) ? 'documented' : 'undocumented'}]`
    : ''
}

/**
 * Shared prologue for `skeleton`/`outline`: resolve the file, optionally reparse it, fetch its
 * indexed symbols, and (on a non-empty result) apply the `--min-lines` filter and optional
 * `--stats` ref-count lookup. Both commands share this exact sequence verbatim; only their JSON
 * row shape and text-line formatting differ, so those stay in each command's own function.
 */
// A file whose symbols were ALL removed by a filter renders as "(0 symbols)", which is the same thing an unindexed or symbol-less file shows -- except that case gets noSymbolsMessage explaining itself, and this one silently looked like a definitive answer about the file. Emitted only when the file genuinely had symbols before filtering, so the honest empty case keeps its own dedicated message untouched.
function filteredToEmptyNotice(preFilterCount: number, minLines: number | undefined, grep: string | undefined): string {
  const parts: string[] = []
  if (minLines !== undefined) parts.push(`--min-lines ${minLines}`)
  if (grep !== undefined) parts.push(`--grep ${grep}`)
  return filtersFilteredToEmptyNotice(preFilterCount, parts, 'indexed symbol', 'indexed symbols', 'the file is indexed')
}

function prepareSymbolListing(
  file: string,
  opts: { minLines?: number; grep?: string; forceRefresh?: boolean; stats?: boolean; projectRoot?: string },
): { kind: 'confined'; text: string } | { kind: 'empty'; text: string } | { kind: 'ok'; resolved: string; displayRoot: string | undefined; filtered: SymbolEntry[]; preFilterCount: number; refCounts: Map<string, number> | undefined; fullSourceBytes: number; symbolsTruncated: boolean; trueSymbolCount: number | undefined } {
  const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
  // Same reason as resolveSymbolSpec's check: the listing below comes out of the shared index.
  const confined = confinementRefusal('This file', resolved, confinedProjectRoot())
  if (confined !== null) return { kind: 'confined', text: confined }
  if (opts.forceRefresh === true) {
    indexFileSyncPinned(resolved, globalDbPath())
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

  // Both filters narrow the same already-fetched set, so they compose: --min-lines then --grep. Applied after the cap slice and after the genuinely-empty check, exactly as --min-lines always has been, so neither the truncation flag nor the no-symbols message changes meaning when --grep is added.
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filtered = symbols.filter(
    (s) =>
      (opts.minLines === undefined || s.lineEnd - s.lineStart + 1 >= opts.minLines) &&
      (matchesGrep === undefined || matchesGrep(s.name)),
  )

  const refCounts =
    opts.stats === true
      ? queryRefCounts(filtered.map((s) => s.name), globalDbPath(), resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }))
      : undefined

  const fullSourceBytes = sumFileSizes([resolved])

  return { kind: 'ok', resolved, displayRoot: getDisplayRoot(opts.projectRoot), filtered, preFilterCount: symbols.length, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount }
}

/**
 * Runs a per-file `{text, code}` command once for each file of a comma-separated multi-file spec
 * and joins the blocks with a blank line. Shared by `skeleton` and `outline` so both get the same
 * ordering, the same block separator, and the same exit rule: 0 when at least one file produced
 * output, 1 only when every file failed (a single unreadable file must not suppress the rest).
 * Each block keeps its own `# Skeleton:`/`# Outline:` header, which is what identifies the file
 * it belongs to.
 */
function runPerFileListing(
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
  // Joining blocks with a blank line is right for text and wrong for JSON: it produces N complete documents back to back, which no parser accepts, so `--json` -- a flag whose only purpose is machine consumption -- failed outright on a multi-file spec. Merge into one document instead. Rows carry their own filePath, so a single flat items array stays unambiguous and the payload keeps the exact shape a single-file call returns, which means a caller does not have to branch on how many files it asked for.
  if (json) return mergeListingJson(files, blocks, anyOk)
  return { text: blocks.join('\n\n'), code: anyOk ? 0 : 1 }
}

/**
 * Merge the per-file JSON payloads of a multi-file listing into one document: items
 * concatenated in the order the files were named, `truncated` true if any file truncated,
 * `totalCount` summed. A file that produced prose rather than JSON (an unreadable path, or
 * one with no indexed symbols -- both legitimate outcomes for one file of several) is
 * reported in an `errors` array rather than being spliced into the document as text, which
 * would break parsing again, or dropped, which would let a failed file read as an empty one.
 * `errors` is omitted entirely when every file succeeded, so the all-ok payload is shaped
 * exactly like a single-file one.
 */
function mergeListingJson(files: string[], blocks: string[], anyOk: boolean): { text: string; code: number } {
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
  return { text: JSON.stringify(payload, null, 2), code: anyOk ? 0 : 1 }
}

/** Handle ``token-goat skeleton file``. Also accepts the family's comma-separated multi-file spec (`a,b,c`), emitting one headed block per file. */
/**
 * How the symbol count is written in a `skeleton` or `outline` header.
 *
 * Plain when everything the file has is being shown. When the per-file cap in
 * {@link SKELETON_SYMBOL_CAP} cut the list short, the header says so and gives the real total,
 * which {@link runSkeletonPrep} already re-queried without a LIMIT for exactly this purpose.
 *
 * Both text headers used to state the capped number as though it were the whole file: a file of
 * 130,000 symbols printed `(5000 symbols)`, with nothing anywhere in the output to suggest
 * otherwise. The `--json` output of the same command reported `truncated: true` and
 * `totalCount: 130000` correctly, so the honest number was computed, carried all the way to the
 * renderer, and then used on only one of the two paths -- and the one it was missing from is the
 * default, and the one an agent reads. This is the same silent-truncation shape the comment on
 * SKELETON_SYMBOL_CAP describes as the reason that cap and its count exist at all.
 */
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
  const { resolved, displayRoot, filtered, preFilterCount, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount } = prep

  if (opts.json === true) {
    // filePath appears when, and only when, the payload can hold more than one file. It identifies which file a row came from -- without it two merged rows both reading lineStart 3 are indistinguishable while meaning different files -- but a single-file caller already knows the file it named, and every field costs rows: guardJsonRows caps by BYTES, so an unconditional path per row pushes real symbols out of a large file listing (the same lever that removing `body` pulled in the other direction). Rendered through toDisplayPath so it is root-relative and reproducible rather than absolute and specific to this machine and drive-letter casing.
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
      // Envelope-level, not per row: this listing is one named file, so the fact belongs to the
      // whole payload. Only added when true, so live output keeps the exact three-key shape
      // tests/json_envelope_shape.test.ts pins.
      ...(fileIsGone(resolved) ? { deleted: true } : {}),
    }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('stub_view', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const totalLines = filtered.length > 0 ? Math.max(...filtered.map((s) => s.lineEnd)) : 0
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

// ---- outline ----------------------------------------------------------------

/**
 * `outline` takes exactly the options `skeleton` does -- same flags on the CLI, same shape through
 * `prepareSymbolListing`. Aliased rather than restated so a field added to one is never silently
 * missing from the other: the two were byte-identical copies, and the pair of `cli.ts` `.action`
 * blocks that build them is likewise line-for-line the same.
 */
export type OutlineOptions = SkeletonOptions

/** Handle ``token-goat outline file``. Also accepts the family's comma-separated multi-file spec (`a,b,c`), emitting one headed block per file. */
export function runOutline(opts: OutlineOptions): { text: string; code: number } {
  const multiFiles = parseMultiFileSpec(opts.file)
  if (multiFiles !== null) return runPerFileListing(multiFiles, (file) => runOutline({ ...opts, file, includeFilePath: true }), opts.json === true)

  const prep = prepareSymbolListing(opts.file, opts)
  if (prep.kind === 'confined' || prep.kind === 'empty') {
    return { text: prep.text, code: 1 }
  }
  const { resolved, displayRoot, filtered, preFilterCount, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount } = prep

  if (opts.json === true) {
    // Project explicitly instead of spreading the row. The spread carried `body` -- the full source of every symbol -- into a payload for the one command whose entire purpose is to map a file WITHOUT its bodies. On src/cli.ts that was 45 KB of the 87 KB payload, and because guardJsonRows caps by bytes, the bodies crowded out symbols: 164 of 504 survived, so asking for machine-readable output silently returned under a third of the map the text form prints in full. An explicit projection also closes the trap that let it in -- a spread type-checks against SymbolEntry no matter what fields get added to it later, so the next new column would have leaked in just as quietly.
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
      // Same envelope-level flag, and same reason, as runSkeleton's payload above.
      ...(fileIsGone(resolved) ? { deleted: true } : {}),
    }
    const text = JSON.stringify(payload, null, 2)
    recordReadStat('outline', fullSourceBytes, text, opts.file)
    return { text, code: 0 }
  }

  const lines: string[] = [`# Outline: ${opts.file}  (${symbolCountLabel(filtered.length, symbolsTruncated, trueSymbolCount)})`]
  if (filtered.length === 0 && preFilterCount > 0) lines.push(filteredToEmptyNotice(preFilterCount, opts.minLines, opts.grep))
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
      // Text mode says "all N data rows were filtered out"; --json needs the same distinction or a consumer sees totalCount 0 for both "the filter matched nothing" and "the file has no data".
      const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount: result.totalRows, ...(result.totalRows === 0 && result.preFilterRows > 0 ? { filteredFromRows: result.preFilterRows } : {}) })
      emit(jsonText)
      recordReadStat('csv_query', fullSourceBytes, jsonText, opts.file)
    } else {
      const tableText = formatCsvTable(result, (opts.where ?? []).map((w) => `--where ${w}`))
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
/** A value js-yaml produced as a plain mapping (not an array, Date, null, or scalar). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

/**
 * Apply YAML merge keys (`<<: *anchor`), which js-yaml 4 leaves as a literal `<<` key rather than
 * folding the anchor's keys into the parent. Precedence follows the spec: a node's own keys win
 * over merged keys, and when `<<` is a list of mappings the earlier ones win over the later. New
 * objects are built throughout so anchor targets shared across the document are never mutated.
 */
function resolveYamlMergeKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveYamlMergeKeys)
  if (!isPlainObject(node)) return node
  const merged: Record<string, unknown> = {}
  const mergeVal = node['<<']
  if (mergeVal !== undefined) {
    const sources = Array.isArray(mergeVal) ? mergeVal : [mergeVal]
    // Apply lowest-precedence first so earlier list entries overwrite later ones.
    for (const src of [...sources].reverse()) {
      const resolved = resolveYamlMergeKeys(src)
      if (isPlainObject(resolved)) Object.assign(merged, resolved)
    }
  }
  // The node's own keys have the highest precedence and overwrite anything merged in.
  for (const [key, value] of Object.entries(node)) {
    if (key === '<<') continue
    merged[key] = resolveYamlMergeKeys(value)
  }
  return merged
}

/** Exported for tests: parse YAML and expand merge keys, the transform `yaml-query` runs on input. */
export function parseYamlDocument(text: string): unknown {
  const docs = loadAllYaml(text).map(resolveYamlMergeKeys)
  // js-yaml's loadAll yields ZERO documents for an empty, whitespace-only or comment-only file. Falling through to the multi-document branch returned `[]`, so yaml-outline announced "array of 0 elements (unknown)" and yaml-query reported "does not exist on array value" for a document that is not an array at all. Per YAML 1.2 an empty node is the null value, which is exactly what an explicit bare `---` document already parses to here, so report the same thing.
  if (docs.length === 0) return null
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

export interface XmlOutlineCliOptions {
  file: string
  json?: boolean
  maxDepth?: number
}

/** Handle ``token-goat xml-outline file``: structural summary of an XML document
 * (element hierarchy, attribute names, child counts) without a raw Read. */
export function runXmlOutline(opts: XmlOutlineCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let summary: XmlOutlineSummary
  try {
    summary = outlineXml(text, { ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}) })
  } catch (e) {
    emitErr(`Failed to parse XML: ${opts.file}\n${extractErrorMessage(e)}`)
    return 1
  }

  const fullSourceBytes = sumFileSizes([opts.file])
  if (opts.json === true) {
    const jsonText = JSON.stringify(summary, null, 2)
    emit(jsonText)
    recordReadStat('xml_outline', fullSourceBytes, jsonText, opts.file)
  } else {
    const outlineText = formatXmlOutline(summary)
    emitGuarded(outlineText, 'xml-outline')
    recordReadStat('xml_outline', fullSourceBytes, outlineText, opts.file)
  }
  return 0
}

export interface XmlQueryCliOptions {
  file: string
  path: string
  head?: string
  json?: boolean
}

/** Handle ``token-goat xml-query file path``: extract elements or attributes from an XML document
 * by tag path / selector instead of a raw Read. */
export function runXmlQuery(opts: XmlQueryCliOptions): number {
  const text = readFileText(opts.file)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
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
    const result = queryXml(text, opts.path)
    const fullSourceBytes = sumFileSizes([opts.file])

    if (result.attributeValues !== undefined) {
      if (result.attributeValues.length === 0) {
        if (opts.json === true) {
          const jsonText = JSON.stringify({ items: [], truncated: false, totalCount: 0 })
          emit(jsonText)
          recordReadStat('xml_query', fullSourceBytes, jsonText, opts.file)
        } else {
          emit(`No attributes matched path: '${opts.path}'`)
        }
        return 0
      }

      if (!result.fanned) {
        const val = result.attributeValues[0] ?? ''
        const outText = opts.json === true ? JSON.stringify(val) : val
        emit(outText)
        recordReadStat('xml_query', fullSourceBytes, outText, opts.file)
        return 0
      }

      const totalCount = result.attributeValues.length
      const limited = head !== undefined ? result.attributeValues.slice(0, head) : result.attributeValues
      const headTruncated = limited.length < totalCount

      if (opts.json === true) {
        const capped = guardJsonRows(limited)
        const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount })
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, opts.file)
      } else {
        const lines = limited.map((item) => item)
        if (headTruncated) {
          lines.push(`...(${totalCount - limited.length} more items elided; use --head to see more)`)
        }
        const plainText = lines.join('\n')
        emitGuarded(plainText, 'xml-query')
        recordReadStat('xml_query', fullSourceBytes, plainText, opts.file)
      }
      return 0
    }

    if (result.items.length === 0) {
      if (opts.json === true) {
        const jsonText = JSON.stringify({ items: [], truncated: false, totalCount: 0 })
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, opts.file)
      } else {
        emit(`No elements matched path: '${opts.path}'`)
      }
      return 0
    }

    if (!result.fanned) {
      const node = result.items[0]!
      if (opts.json === true) {
        const jsonVal = xmlNodeToJson(node)
        const jsonText = JSON.stringify(jsonVal, null, 2)
        emit(jsonText)
        recordReadStat('xml_query', fullSourceBytes, jsonText, opts.file)
      } else {
        const xmlText = serializeXmlNode(node)
        emitGuarded(xmlText, 'xml-query')
        recordReadStat('xml_query', fullSourceBytes, xmlText, opts.file)
      }
      return 0
    }

    const totalCount = result.items.length
    const limited = head !== undefined ? result.items.slice(0, head) : result.items
    const headTruncated = limited.length < totalCount

    if (opts.json === true) {
      const jsonItems = limited.map(xmlNodeToJson)
      const capped = guardJsonRows(jsonItems)
      const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated || headTruncated, totalCount })
      emit(jsonText)
      recordReadStat('xml_query', fullSourceBytes, jsonText, opts.file)
    } else {
      const blocks = limited.map((node) => serializeXmlNode(node))
      if (headTruncated) {
        blocks.push(`...(${totalCount - limited.length} more elements elided; use --head to see more)`)
      }
      const plainText = blocks.join('\n')
      emitGuarded(plainText, 'xml-query')
      recordReadStat('xml_query', fullSourceBytes, plainText, opts.file)
    }
    return 0
  } catch (e) {
    emitErr(extractErrorMessage(e))
    return 1
  }
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
    const closes = rankSimilarNames(operations.map(operationLabel), opts.operation)
    if (closes.length > 0) messages.push(didYouMean(closes))
    // No operation resembled the query -- point at the command that lists them all.
    else if (operations.length > 0) messages.push(`Try: token-goat openapi-outline ${opts.file}`)
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
/** One message for both zip commands: a missing optional dependency reads differently from a
 * corrupt archive, and saying the wrong one sends the reader to the wrong place. */
function archiveReadFailure(err: unknown, file: string): string {
  if (err instanceof ArchiveDependencyMissingError || err instanceof ZipOutputTooLargeError) return err.message
  return `Failed to read archive (not a valid zip-format file): ${file}`
}

export async function runZipList(opts: ZipListCliOptions): Promise<number> {
  let data: Buffer | null
  try {
    data = readFileBytes(opts.file)
  } catch (err) {
    if (err instanceof ZipInputTooLargeError) {
      emitErr(err.message)
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ZipEntry[]
  try {
    entries = await listZipEntries(data)
  } catch (err) {
    emitErr(archiveReadFailure(err, opts.file))
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
export async function runZipRead(opts: ZipReadCliOptions): Promise<number> {
  let data: Buffer | null
  try {
    data = readFileBytes(opts.file)
  } catch (err) {
    if (err instanceof ZipInputTooLargeError) {
      emitErr(err.message)
      return 1
    }
    throw err
  }
  if (data === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }

  let entries: ZipEntry[]
  let content: Uint8Array | undefined
  try {
    entries = await listZipEntries(data)
    content = await extractZipEntry(data, opts.entry)
  } catch (err) {
    emitErr(archiveReadFailure(err, opts.file))
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
    const closes = rankSimilarNames(entries.map((e) => e.path), opts.entry)
    if (closes.length > 0) messages.push(didYouMean(closes))
    // No entry resembled the query -- point at the command that lists the archive's contents.
    else if (entries.length > 0) messages.push(`Try: token-goat zip-list ${opts.file}`)
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
          // Changed-file paths are structured identifiers, not freeform prose, so they are not
          // fenced here the way diff/comments/description text is -- see this file's
          // fenceGithubTextIfMatched doc comment.
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
          const jsonText = JSON.stringify({ path: parsed.path, diff: fenceGithubTextIfMatched(fileDiff) })
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} diff:${parsed.path}`)
        } else {
          emitGuarded(fenceGithubTextIfMatched(fileDiff), 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, fileDiff, `${repo}#${opts.pr} diff:${parsed.path}`)
        }
        return 0
      }
      case 'comments': {
        const comments = fetchPrComments(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(comments), 'utf8')
        if (opts.json === true) {
          const fencedComments = comments.map((c) => ({ ...c, body: fenceGithubTextIfMatched(c.body) }))
          const capped = guardJsonRows(fencedComments)
          const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount })
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} comments`)
        } else {
          const text = formatCommentsSlice(comments)
          emitGuarded(fenceGithubTextIfMatched(text), 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} comments`)
        }
        return 0
      }
      case 'description': {
        const desc = fetchPrDescription(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(desc), 'utf8')
        if (opts.json === true) {
          const fencedDesc = {
            ...desc,
            title: fenceGithubTextIfMatched(desc.title),
            body: desc.body !== null ? fenceGithubTextIfMatched(desc.body) : null,
          }
          const jsonText = JSON.stringify(fencedDesc)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} description`)
        } else {
          const text = formatDescriptionSlice(desc)
          emitGuarded(fenceGithubTextIfMatched(text), 'pr-slice')
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

    // The database file's on-disk size is not a real counterfactual: nobody pastes a binary
    // SQLite file into model context. The one honest baseline is the output the same query
    // would have produced without --head -- a real alternative the user could have run --
    // so bytesSaved reflects only what --head actually avoided emitting, never the size of
    // the database itself.
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
      const uncappedFull = guardJsonRows(result.rows)
      const baselineJsonText = JSON.stringify({
        columns: result.columns,
        items: uncappedFull.items,
        truncated: uncappedFull.truncated || result.rowCapped,
        totalCount,
        rowCapped: result.rowCapped,
      })
      recordReadStat('sqlite_query', Buffer.byteLength(baselineJsonText, 'utf8'), jsonText, opts.file)
    } else {
      const text = formatSqliteQueryTable({ ...result, rows }, { headTruncated })
      emit(text)
      const baselineText = formatSqliteQueryTable({ ...result, rows: result.rows }, { headTruncated: false })
      recordReadStat('sqlite_query', Buffer.byteLength(baselineText, 'utf8'), text, opts.file)
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

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfLocate(
  file: string,
  pattern: string,
  opts: { ignoreCase?: boolean; maxMatches?: number; context?: number; pages?: string },
): Promise<PdfLocateMatch[]> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  const data = fs.readFileSync(file)
  return locatePdfPages(new Uint8Array(data), pattern, opts)
}

export interface ImageMeta {
  width: number
  height: number
  format: string | null
  bytes: number
  sharpAvailable: boolean
  wouldShrink: boolean
  shrunkBytes: number | null
}

/** Thin async wrapper (same rationale as runPdfExtractText above): sharp metadata only -- never runs OCR, a cheap "should I even look at this" probe. `wouldShrink`/`shrunkBytes` reuse shrinkImage (forcing sizeThresholdBytes 0) to report what a real shrink would cost without actually re-encoding for the caller. */
export async function runImageMeta(file: string): Promise<ImageMeta> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  if (!isImagePath(file)) {
    throw new Error(`Not an image file: ${file}`)
  }
  const data = fs.readFileSync(file)
  const bytes = data.length
  let probe: Awaited<ReturnType<typeof probeImageMeta>>
  try {
    probe = await probeImageMeta(data)
  } catch (e) {
    // sharp is installed and rejected the bytes: this is a corrupt/unreadable image, not a missing
    // dependency. Surface it as a real error rather than the "install sharp" notice at exit 0.
    if (e instanceof ImageDecodeError) {
      throw new Error(`${file} is not a readable image: ${e.message}`, { cause: e })
    }
    throw e
  }
  if (probe === null) {
    return { width: 0, height: 0, format: null, bytes, sharpAvailable: false, wouldShrink: false, shrunkBytes: null }
  }
  const shrink = await shrinkImage(data, { sizeThresholdBytes: 0 })
  return {
    width: probe.width,
    height: probe.height,
    format: probe.format,
    bytes,
    sharpAvailable: true,
    wouldShrink: shrink !== null,
    shrunkBytes: shrink !== null ? shrink.shrunkBytes : null,
  }
}

export interface ImageTextResult {
  ocrAvailable: boolean
  confidence: number
  chars: number
  textHeavy: boolean
  text: string | null
}

/** Thin async wrapper (same rationale as runPdfExtractText above): runs OCR via image_ocr.ts's isolated-child-process ocrImage. Honest about low-confidence results -- `text` stays null below isTextHeavy's threshold rather than surfacing noise as content; `confidence`/`chars` are always reported so the caller can see why. */
export async function runImageText(file: string): Promise<ImageTextResult> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  if (!isImagePath(file)) {
    throw new Error(`Not an image file: ${file}`)
  }
  const data = fs.readFileSync(file)
  const ocr = await ocrImage(data)
  if (ocr === null) {
    // A null result means "engine not installed" only when the engine is genuinely absent. If it
    // is present, OCR ran and produced nothing for this input -- a corrupt image, a timeout, an
    // offline model fetch -- which must not be reported as a missing dependency at exit 0.
    if (isOcrEngineAvailable()) {
      throw new Error(`${file} could not be processed by OCR (unreadable image, timeout, or offline model fetch)`)
    }
    return { ocrAvailable: false, confidence: 0, chars: 0, textHeavy: false, text: null }
  }
  const minConfidence = loadConfig().image_shrink.ocr_min_confidence
  const heavy = isTextHeavy(ocr, minConfidence)
  return { ocrAvailable: true, confidence: ocr.confidence, chars: ocr.text.length, textHeavy: heavy, text: heavy ? ocr.text : null }
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
  /**
   * Project root to scope symbol resolution and relative-path resolution to. Defaults to
   * `process.cwd()`; same field name as {@link ReadOptions.projectRoot}. Callers whose cwd is not
   * the workspace root (e.g. an MCP server launched from an opaque directory) should pass the
   * actual workspace root explicitly -- otherwise a relative file spec resolves against the wrong
   * project, and the display paths in the rendered output name a root the caller never asked for.
   */
  projectRoot?: string
  /** `-C, --context <n>`: lines of real call-site source around each entry of the caller block, in `grep -C`'s framing. Defaults to 0 (output unchanged). */
  context?: number
  /** `--exclude-tests`: drop callers whose call SITE is in a test file, matching `refs`/`callers` (which filter the call site) rather than `dead`/`symbol` (which filter the definition). Opt-in; output is byte-identical when omitted. */
  excludeTests?: boolean
  /** `--grep <pattern>`: only show callers whose enclosing caller NAME matches this regex (literal substring if it does not compile) -- narrows a high-fanout symbol's caller block the same way `refs --grep`/`call-chain --grep` narrow theirs, so a symbol with hundreds of callers doesn't need a separate `refs` round-trip just to find the ones that matter. Opt-in; output is byte-identical when omitted. */
  grep?: string
  /** Internal only -- set by {@link runBriefMulti} on each per-symbol recursive `runBriefCore` call so the single-symbol path skips its own `recordReadStat`, same convention as {@link ReadOptions.suppressStat} for `runReadMulti`. Not a CLI/MCP-facing option. */
  suppressStat?: boolean
}

interface BriefResult {
  symbol: SymbolEntry
  callers: CallerEntry[]
  totalCallers: number
  truncated: boolean
  /** How many callers `--exclude-tests` dropped. Omitted entirely when the flag is off or hid nothing, so default output stays byte-identical; present and non-zero it explains a `totalCallers` that would otherwise look inconsistent with an unfiltered `refs` count. */
  hiddenByExcludeTests?: number
  /** How many (post `--exclude-tests`) callers `--grep` dropped. Same omit-when-zero convention as {@link hiddenByExcludeTests}. */
  hiddenByGrep?: number
  section: SectionResult | null
}

/** Core of ``token-goat brief "file::symbol"``: bundles the symbol body, its resolved callers (enclosing-function-aware, via graph_commands.ts's real caller-resolution logic), and its containing doc section (if the file has heading structure) into one response -- cutting the common "understand this function" pattern from 2-3 round-trips to 1. Returns text+code instead of emitting directly so {@link runBrief} can both dispatch to {@link runBriefMulti} for a comma-separated spec and reuse this exact single-symbol path for each sub-call, mirroring runRead/runSection's core-vs-dispatcher split. Note that --limit validation deliberately lives in {@link runBrief}, not here: it is a whole-invocation flag, so validating per sub-call would repeat one usage error once per symbol and frame it as a per-symbol resolution failure. */
function runBriefCore(opts: BriefOptions): { text: string; code: number } {
  const resolution = resolveSymbolSpec(opts.spec, undefined, opts.projectRoot)
  if (resolution.kind === 'confined') return { text: resolution.message, code: 1 }
  if (resolution.kind === 'ambiguous') {
    return {
      // Name the command explicitly: formatAmbiguity defaults to 'read', so brief's retry lines would otherwise tell the user to run `token-goat read`, which answers a different question than the one they asked.
      text: formatAmbiguity(
        resolution.symbol,
        resolution.file,
        resolution.candidates,
        opts.projectRoot,
        'brief',
      ),
      code: 1,
    }
  }
  if (resolution.kind === 'none') {
    // A bare name (no `::` at all) is a spec-format mistake, not evidence the symbol is
    // missing -- see formatBareNameSpecError. A proper `file::symbol` spec that genuinely
    // resolves to nothing keeps the original wording below, untouched.
    if (findSpecSeparator(opts.spec) === -1) {
      return { text: formatBareNameSpecError('brief', opts.spec, opts.projectRoot), code: 1 }
    }
    // Only paid after the query already came back empty, and only in text mode -- this branch's
    // text is emitted verbatim via emitErr regardless of --json (no separate opts.json check
    // exists in runBrief's caller for this path), so there's no JSON envelope to protect either
    // way.
    if (opts.json !== true) {
      const rootDir = resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() })
      if (isIndexEmptyForProject(globalDbPath(), rootDir)) {
        return { text: `Symbol not found: ${opts.spec}\n${emptyIndexMessage(rootDir)}`, code: 1 }
      }
    }
    return { text: `Symbol not found: ${opts.spec}`, code: 1 }
  }
  const match = resolution.entry

  // resolveCallers(name) with no explicit limit still applies its own internal default cap (500, in graph_commands.ts's queryRefs call) -- so a capped callers.length is not the true count once more than 500 references exist. The earlier fix for that took the total from a separate COUNT(*) query (queryRefCounts), but queryRefCounts keys by symbol NAME project-wide while resolveCallers additionally scopes to THIS definition site (filterRefsForSymbol drops refs living in a file that defines its own same-named symbol), so for a name defined in two files brief printed the other definition's callers into its own "Callers (N)" header and invented an "...(N more elided)" tail for rows that were never going to be listed. The scoped scan is the only thing that knows the real total, so it always runs unbounded here and its post-filter length is the total.
  const rootDir = resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() })
  const excludeTests = opts.excludeTests === true
  // The unbounded scan also covers --grep and --exclude-tests, which both filter client-side below -- otherwise a high-fanout symbol's grep match could hide inside the callers that fell past resolveCallers' 500-row default page before the filter ever ran.
  // resolveCallers' last argument makes it scan unbounded instead of stopping at its 500 default, but it does NOT filter -- like runCallers, the test-file drop happens here, on the call SITE (c.file), so a production symbol exercised mostly by tests still yields a full page of real callers rather than whatever survived a pre-filter cap. rootDir is threaded in for the same reason runCallers threads it: it is already resolved, and resolveCallers would otherwise shell out to git a second time for the identical value.
  const allCallers = resolveCallers(match.name, undefined, match.filePath, rootDir, true)
  const testFiltered = excludeTests ? allCallers.filter((c) => !isTestFile(c.file)) : allCallers
  const hiddenByExcludeTests = excludeTests ? allCallers.length - testFiltered.length : 0
  // --grep narrows by the caller's enclosing symbol NAME, same field/convention as
  // runCallers'/call-chain's own --grep -- runs after the exclude-tests drop so both filters
  // compose (grep sees the already test-filtered set, matching runCallers' ordering).
  const preGrepCount = testFiltered.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const callers = matchesGrep !== undefined ? testFiltered.filter((c) => matchesGrep(c.caller)) : testFiltered
  const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - callers.length : 0
  // The unbounded scan above IS the complete in-project, definition-scoped set, so its post-filter length is the true total: it counts exactly the rows that can appear in the list below, which is what the "Callers (N)" header and the "...(N more elided)" tail both describe.
  const totalCallers = callers.length
  const section = findContainingSection(match.filePath, match.lineStart, match.lineEnd, readFileText)
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
    // callers' contextLines attached first (buildContextWindow reads real source off disk and needs the raw absolute `c.file`), THEN both symbol.filePath and callers[].file rewritten to the same root-relative spelling the text block above renders (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing.
    const callersWithContext = (opts.context ?? 0) > 0
      ? shown.map((c) => ({ ...c, contextLines: buildContextWindow(c.file, c.line, opts.context ?? 0) ?? [] }))
      : shown
    const result: BriefResult = {
      symbol: { ...match, filePath: toDisplayPath(rootDir, match.filePath) },
      callers: callersWithContext.map((c) => ({ ...c, file: toDisplayPath(rootDir, c.file) })),
      totalCallers,
      truncated,
      ...(hiddenByExcludeTests > 0 ? { hiddenByExcludeTests } : {}),
      ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}),
      section,
    }
    const jsonText = JSON.stringify(result, null, 2)
    if (opts.suppressStat !== true) recordReadStat('brief_view', fullSourceBytes, jsonText, opts.spec)
    return { text: jsonText, code: 0 }
  }

  const body = resolveBody(match)
  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    `# ${match.name}  ${match.kind}  ${toDisplayPath(rootDir, match.filePath)}:${match.lineStart}-${match.lineEnd}`,
    `# ${countNoun(bodyLen, 'line')} (~${Math.ceil(body.length / 4)} tok)`,
    body,
    '',
  ]

  // An empty caller block reads as "nothing calls this", which for a symbol exercised only by tests is the opposite of the truth and invites deleting live code -- so when the filter is what emptied it, say so instead of showing a bare zero.
  const hiddenNote = excludeTests && hiddenByExcludeTests > 0 ? ` (${excludeTestsHiddenNote(hiddenByExcludeTests)})` : ''
  if (callers.length === 0 && matchesGrep !== undefined && preGrepCount > 0) {
    // Distinguishes "--grep matched none of the N callers that do exist" from a genuinely
    // caller-less symbol -- same "filtered store renders as populated" trap already fixed for
    // refs/callers/dead/types/deps. preGrepCount already reflects --exclude-tests (if both are
    // set), so this fires only once the grep filter is what zeroed the remaining set.
    lines.push(`Callers (0): ${grepFilteredToEmptyNotice(preGrepCount, opts.grep ?? '', 'caller', 'callers').trim()}`)
  } else {
    lines.push(callers.length === 0 && hiddenNote !== ''
      ? `Callers (0): no non-test callers${hiddenNote}`
      : `Callers (${totalCallers}):${hiddenNote}`)
  }
  for (const c of shown) {
    const callerDisplayPath = toDisplayPath(rootDir, c.file)
    lines.push(`  ${c.caller}\t${callerDisplayPath}:${c.line}`)
    // brief's caller block is its OWN rendering site, not a call into runCallers -- `-C` has to be
    // threaded here separately or the flag would silently do nothing for `brief`.
    const window = buildContextWindow(c.file, c.line, opts.context ?? 0)
    if (window !== null) lines.push(...renderContextWindow(callerDisplayPath, c.line, window, '', '    '))
  }
  if (truncated) {
    lines.push(`  ...(${totalCallers - shown.length} more elided)`)
  }

  if (section !== null) {
    lines.push('')
    lines.push(`Section: ${section.heading} (lines ${section.lineStart}-${section.lineEnd})`)
  }

  const text = guardText(trimBlankLines(lines).join('\n'), 'symbol')
  if (opts.suppressStat !== true) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

/** Handle ``token-goat brief "file::a,b,c"`` -- bundle several symbols' body+callers+section views from one file in a single call, mirroring `read`/`section`'s comma-separated multi-spec grammar (see {@link runReadMulti}). Delegates each symbol to a recursive {@link runBriefCore} call (`suppressStat: true`) so ambiguity handling, not-found + did-you-mean, and JSON shape all come from the exact same code path the single-symbol form already exercises -- a failure to resolve one symbol is reported inline instead of aborting the whole call, same as `runReadMulti`'s per-symbol handling. */
function runBriefMulti(file: string, symbols: string[], opts: BriefOptions): { text: string; code: number } {
  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const sym of symbols) {
    const sub = runBriefCore({ ...opts, spec: `${file}::${sym}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real JSON per symbol, never an embedded string -- a failed sub-call has no JSON body of its own, so it is represented by its plain-text error instead.
      jsonOut[sym] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${sym}:\n${sub.text}`)
  }

  // Count the file's on-disk size once for the whole multi-symbol call, not once per symbol -- each sub-call already skipped its own recordReadStat via suppressStat for exactly this reason (see BriefOptions.suppressStat).
  const fullSourceBytes = sumFileSizes([resolveIndexPath(file, opts.projectRoot ?? process.cwd())])
  const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

/** Cross-file brief, e.g. `src/a.ts::fnA,src/b.ts::fnB`. Body mirrors runBriefMulti's own per-symbol loop above (same runBriefCore sub-call, same suppressStat + single fullSourceBytes-over-all-files convention), swapping the shared `file` for each pair's own -- and mirrors runSectionCrossFile/runRefsCrossFile/runReadMulti's `keyFor` rule: one distinct file across all pairs keys by bare symbol (matches today's same-file `brief "file::a,b"` output byte-for-byte), more than one keys by the full `file::symbol` pair so two files contributing the same symbol name stay distinct. */
function runBriefCrossFile(pairs: { file: string; symbol: string }[], opts: BriefOptions): { text: string; code: number } {
  const distinctFiles = new Set(pairs.map((p) => p.file))
  const keyFor = (p: { file: string; symbol: string }): string => (distinctFiles.size === 1 ? p.symbol : `${p.file}::${p.symbol}`)

  let anyFound = false
  const jsonOut: Record<string, unknown> = {}
  const textBlocks: string[] = []

  for (const { file, symbol } of pairs) {
    const key = keyFor({ file, symbol })
    const sub = runBriefCore({ ...opts, spec: `${file}::${symbol}`, suppressStat: true })
    if (sub.code === 0) anyFound = true
    if (opts.json === true) {
      jsonOut[key] = sub.code === 0 ? (JSON.parse(sub.text) as unknown) : { error: sub.text }
      continue
    }
    textBlocks.push(`${key}:\n${sub.text}`)
  }

  const fullSourceBytes = sumFileSizes([...distinctFiles].map((f) => resolveIndexPath(f, opts.projectRoot ?? process.cwd())))
  const text = opts.json === true ? JSON.stringify(jsonOut, null, 2) : textBlocks.join('\n\n')
  if (anyFound) recordReadStat('brief_view', fullSourceBytes, text, opts.spec)
  return { text, code: anyFound ? 0 : 1 }
}

/** Handle ``token-goat brief "file::symbol"``: dispatches to {@link runBriefCrossFile} for a cross-file `a.ts::x,b.ts::y` spec, to {@link runBriefMulti} for a comma-separated same-file `file::a,b` spec, otherwise runs the single-symbol {@link runBriefCore} path, then emits the result -- `emitErr` on a nonzero code, `emit` on success. */
export function runBrief(opts: BriefOptions): number {
  // Same reasoning as runRefs/runFind/runTypes: a limit of 0 (or negative) would silently slice the caller list down to zero entries instead of surfacing a clear "you asked for nothing" error, consistent with every other --limit flag in this codebase. Validated once here rather than inside runBriefCore because --limit applies to the whole invocation, so a multi-symbol spec must report it once, not once per symbol.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }

  // Cross-file multi-spec `src/a.ts::fnA,src/b.ts::fnB`. Checked before the single-file `::` handling below for the same reason runRead/runSection/runRefs check it first (see parseCrossFileMultiSpec) -- parseReadSpec's `lastIndexOf('::')` would otherwise fold a spec crossing a file boundary into one bogus file/symbol-list pair. parseCrossFileMultiSpec already declines (falling through here unchanged) for every spec the single-file path below already handles correctly, including the pre-existing same-file `file::a,b` multi-symbol form.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) {
    const { text, code } = runBriefCrossFile(crossFilePairs, opts)
    if (code === 0) emit(text)
    else emitErr(text)
    return code
  }

  const { file, symbol } = parseReadSpec(opts.spec)
  if (symbol !== undefined && symbol !== '' && symbol.includes(',')) {
    const multiSymbols = symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (multiSymbols.length > 1) {
      const { text, code } = runBriefMulti(file, multiSymbols, opts)
      if (code === 0) emit(text)
      else emitErr(text)
      return code
    }
  }

  const { text, code } = runBriefCore(opts)
  if (code === 0) emit(text)
  else emitErr(text)
  return code
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
  // Resolved once and reused for the query's rootDir scope AND for shortening the printed
  // paths below -- one git shell-out, not two.
  const rootDir = resolveProjectRoot({ project: process.cwd() })
  const patternLower = opts.pattern.toLowerCase()
  const rawSymbols = querySymbols({ limit: FIND_SCAN_LIMIT, rootDir })
  const symbols = rawSymbols.filter((s) =>
    s.name.toLowerCase().includes(patternLower),
  )
  // A substring scan cannot reach a typo that drops, swaps, or mistypes a character: `getUserr`
  // is neither a substring of `getUser` nor the reverse. That is the case this command is most
  // often reached FOR -- it is what the docs point you to when an exact `symbol` lookup misses --
  // so falling back to the same edit-distance ranking `Did you mean:` already uses turns the
  // command's most common failure into an answer. Runs ONLY when the substring pass found
  // nothing, so it can never reorder or displace a real match, and rankSimilarNames itself
  // returns nothing for a query near nothing -- a miss stays a miss rather than becoming noise.
  let fuzzyNames: string[] = []
  if (symbols.length === 0) {
    fuzzyNames = rankSimilarNames(rawSymbols.map((s) => s.name), opts.pattern)
  }
  const matched = fuzzyNames.length > 0
    // Ordered by the ranking, not by index order, so the closest name's files come first.
    ? fuzzyNames.flatMap((n) => rawSymbols.filter((s) => s.name === n))
    : symbols
  const allFiles = [...new Set(matched.map((s) => s.filePath))]
  const files = allFiles.slice(0, opts.limit ?? 50)
  // Two independent ways this answer can be partial, and until now only the first was reported:
  // the symbol scan hit FIND_SCAN_LIMIT, or `--limit` cut the deduplicated file list. A search
  // matching 150 files answered with 50 and `truncated: false`, which told a consumer the list was
  // complete when a third of it was missing.
  const limitDropped = allFiles.length - files.length
  const truncated = rawSymbols.length === FIND_SCAN_LIMIT || limitDropped > 0

  if (files.length === 0) {
    emitErr(`No indexed files match '${opts.pattern}'`)
    return 1
  }

  if (opts.json === true) {
    // Dedicated fields rather than prose folded into an existing one, matching this repo's
    // "add a field, don't rewrite an existing one" convention. Absent on an exact hit, so a
    // consumer can tell a real substring match from a typo-recovered one.
    const fuzzyPayload = fuzzyNames.length > 0 ? { fuzzy: true, matchedNames: fuzzyNames } : {}
    emit(JSON.stringify({ files, truncated, ...fuzzyPayload }, null, 2))
    return 0
  }

  // Say so when the result came from the typo fallback: silently returning files for a name the
  // caller did not type reads as if their spelling was right, and they act on the wrong symbol.
  if (fuzzyNames.length > 0) {
    emitErr(`No symbol name contains '${opts.pattern}'; showing files for the nearest indexed ${fuzzyNames.length === 1 ? 'name' : 'names'}: ${fuzzyNames.join(', ')}`)
  }

  for (const f of files) {
    emit(toDisplayPath(rootDir, f))
  }

  // Two causes, two messages: naming the scan limit for a list that `--limit` cut would send the
  // caller looking for a problem in the index instead of raising the flag they set themselves.
  if (limitDropped > 0) {
    emitErr(`Showing ${files.length} of ${allFiles.length} matching files; rerun with --limit ${allFiles.length} to see them all`)
  }
  if (rawSymbols.length === FIND_SCAN_LIMIT) {
    emitErr(`Results may be incomplete; index scan hit limit of ${FIND_SCAN_LIMIT} symbols`)
  }

  return 0
}

// ---- section listing --------------------------------------------------------

export interface ListSectionsOptions {
  file: string
  json?: boolean
  grep?: string
}

/** Handle ``token-goat section --list file``. */
export function runListSections(opts: ListSectionsOptions): number {
  const sections = listSections(opts.file)

  if (sections.length === 0) {
    // listSections() returns [] both for a path that does not exist and for a real file with
    // no headings, so a typo'd path used to read identically to a genuinely empty doc. Checked
    // here, after the query, because only the empty result needs disambiguating -- wording
    // matches runPdfMeta's `Could not read: ${file}` precedent verbatim.
    if (!fileExists(opts.file)) {
      emitErr(`Could not read: ${opts.file}`)
      return 1
    }
    emitErr(`No sections found in '${opts.file}'`)
    return 1
  }

  // --grep narrows on the heading text, same regex-with-literal-fallback semantics every other
  // --grep flag in this repo uses (compileGrepMatcher). Applied after the genuinely-empty check
  // above, so a filter can only ever narrow a real non-empty result -- never masquerade as one.
  const preFilterCount = sections.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  // A name that occurs more than once is indistinguishable in a bare list, and the `#N` form is
  // the only way to ask for a specific one. Numbered over `sections` and before --grep runs, so
  // narrowing the output never renumbers the ordinals a retry would have to use, and matched
  // against the raw heading text so a filter still means what it always did.
  const totals = new Map<string, number>()
  for (const heading of sections) totals.set(heading, (totals.get(heading) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labelled = sections.map((heading) => {
    const nth = (seen.get(heading) ?? 0) + 1
    seen.set(heading, nth)
    return (totals.get(heading) ?? 1) > 1 ? `${heading}#${nth}` : heading
  })
  const filtered =
    matchesGrep !== undefined
      ? labelled.filter((_, i) => matchesGrep(sections[i] ?? ''))
      : labelled

  if (filtered.length === 0) {
    // The file IS non-empty (preFilterCount > 0, already confirmed above) -- --grep matched none
    // of it. Distinct from the "no sections found" case above, which exits 1 because there was
    // nothing to find at all: this exits 0 with a well-formed empty result, same convention as
    // types/exports/imports/deps' own --grep-filtered-to-empty branch.
    if (opts.json === true) {
      emit(JSON.stringify({ items: [], truncated: false, totalCount: 0 }, null, 2))
      return 0
    }
    emit(grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'section', 'sections'))
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(filtered)
    emit(JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2))
    return 0
  }

  for (const heading of filtered) {
    emit(heading)
  }
  return 0
}

// ---- changed ----------------------------------------------------------------

export interface ChangedOptions {
  ref?: string
  symbolMode?: boolean
  json?: boolean
  projectRoot?: string
  /** Only list changed files whose path matches this pattern. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. In `--symbol` mode this still filters the file path, not the symbol name, since the command's primary listing is files. */
  grep?: string
  /** Drop changed files that live in a test file. Opt-in; output is byte-identical when omitted. Filters the file path, so like `grep` above it applies in `--symbol` mode too -- and it prunes before the per-file index lookup, so a test file is never queried at all. */
  excludeTests?: boolean
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

// Git's well-known empty-tree object hash — always resolvable, used as a diff base when a
// repo has too few commits for any `HEAD~n` (n >= 1) to resolve.
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Builds an extra hint line for a `git diff <ref>` failure caused by the repo simply not
// having enough commits for `ref` to resolve (the default `HEAD~5`, or any positional/--since
// ref a caller passed that outruns history depth). Returns null when the ref failure is not a
// depth issue (e.g. a genuinely malformed ref name), so callers that got a real error don't
// see a misleading suggestion.
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
    // The ref itself is fine — the git diff failure must be something else, don't guess.
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
    // Even HEAD~1 doesn't resolve (a 1-commit repo) — the empty tree is always valid.
    suggestedRef = EMPTY_TREE_HASH
  }
  const commitWord = commitCount === 1 ? '1 commit' : `${commitCount} commits`
  return `Hint: this repo has only ${commitWord}; '${ref}' does not exist. Try: token-goat changed --since ${suggestedRef}`
}

/** Handle ``token-goat changed`` (plain file list, or `--symbol` for changed symbols). */
/**
 * Is `ref` safe to hand git as a positional revision?
 *
 * A ref lands in argv where git expects a revision, but git's own parser still reads a leading `-`
 * there as an option -- so a caller-supplied `--output=<path>` turns `git diff` or `git log` into
 * an arbitrary-file-write primitive (it writes to that path, truncating whatever was there), and
 * `-O<file>` into a read primitive. Neither goes anywhere near the confinement gate, and
 * `--no-ext-diff`/`--no-textconv` in runGit do not cover them: those close the diff-driver
 * command-execution vector, not option injection. Reachable unauthenticated over MCP, where `ref`
 * is a bare optional string. No legitimate revision starts with `-` (git check-ref-format forbids
 * it), so refusing the whole shape costs nothing and closes every flag rather than blacklisting
 * the two that are known to bite.
 *
 * Shared by every command that puts a caller's ref in argv rather than repeated at each one. It
 * lived inline in runChanged, and `diff` and `log` -- which build the same argv shape from the same
 * untrusted string -- were each written without it. One helper means the next ref-taking command
 * cannot omit it by being written the same way.
 */
function refIsSafe(ref: string): boolean {
  return !ref.startsWith('-')
}

/** Report a refused ref on stderr, in one wording for every caller. */
function emitUnsafeRef(ref: string): void {
  emitErr(`Refusing a git ref that starts with '-': ${ref}`)
}

export function runChanged(opts: ChangedOptions = {}): number {
  const ref = opts.ref ?? 'HEAD~5'
  if (!refIsSafe(ref)) {
    emitUnsafeRef(ref)
    return 1
  }
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

  // Every zero-row path below exits 0, so under --json a prose notice would hand the consumer a
  // success status with an unparseable body. Emit the same `{items, truncated, totalCount}`
  // envelope the populated branches do, with `totalCount: 0` -- the post-filter count, never the
  // pre-filter one. Matches the branches already migrated in callers/dead/deps/types; text mode
  // keeps every human notice verbatim.
  const emptyEnvelope = (): number => {
    emit(JSON.stringify({ items: [], truncated: false, totalCount: 0 }, null, 2))
    return 0
  }

  if (changedFiles.length === 0) {
    if (opts.json === true) return emptyEnvelope()
    emit('No files changed.')
    return 0
  }

  // --grep narrows the changed-file list by path, and runs BEFORE any downstream truncation or
  // symbol-mode scoping so it selects from the whole changed set, not an already-capped page.
  const preGrepFileCount = changedFiles.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  if (matchesGrep !== undefined) changedFiles = changedFiles.filter((f) => matchesGrep(f))
  if (matchesGrep !== undefined && changedFiles.length === 0) {
    if (opts.json === true) return emptyEnvelope()
    emit(grepFilteredToEmptyNotice(preGrepFileCount, opts.grep ?? '', 'changed file', 'changed files'))
    return 0
  }

  // --exclude-tests runs at the same point as --grep and composes with it: a file must satisfy
  // both. Checked after --grep so that when both filters are active, the --grep notice wins --
  // the same precedence refs/dead already use.
  const postGrepFileCount = changedFiles.length
  let hiddenTestFiles = 0
  if (opts.excludeTests === true) {
    const kept = changedFiles.filter((f) => !isTestFile(f))
    hiddenTestFiles = changedFiles.length - kept.length
    changedFiles = kept
  }
  if (changedFiles.length === 0 && hiddenTestFiles > 0) {
    if (opts.json === true) return emptyEnvelope()
    // A bare "No files changed." here would read as a clean diff while real changes sit hidden
    // behind the flag. Name the suppressed count instead.
    //
    // When --grep is ALSO active it has already narrowed the set, so "No non-test files changed"
    // would be true only within the --grep scope and false about the diff: `--grep '^tests/'
    // --exclude-tests` on a diff touching both src/ and tests/ empties the list here, and the
    // unqualified wording claims no non-test file changed while src/ files plainly did. Name
    // both filters in that case so the sentence is true of the whole diff, not just the slice
    // --grep left behind.
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
      // FIND_SCAN_LIMIT, not a bare 1000 -- see the note at the other call site: a symbol past the
      // cap would make `changed --symbol` report "No symbols changed." (and `truncated: false`)
      // for a file whose changed symbol is simply beyond the cutoff.
      const fileSymbols = querySymbols({ filePath: resolveIndexPath(f, projectRoot), limit: FIND_SCAN_LIMIT })
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
      if (opts.json === true) return emptyEnvelope()
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
    const symbolText = allSymbols.map((s) => `${s.name} (${s.kind}) — ${toDisplayPath(projectRoot, s.filePath)}:${s.lineStart}`).join('\n')
    for (const s of allSymbols) {
      emit(`${s.name} (${s.kind}) — ${toDisplayPath(projectRoot, s.filePath)}:${s.lineStart}`)
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
    // Same hard-refuse shape as runRead's ambiguous branch -- never guess which candidate the
    // caller meant.
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
    // Same "not found" + did-you-mean shape as runRead's none branch.
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const crossFileLead = formatCrossFileLead(commandName, symbol, file, projectRoot)
    if (crossFileLead !== '') messages.push(crossFileLead)
    const resolved = resolveIndexPath(file, projectRoot ?? process.cwd())
    // Same bounded-scan-then-rank shape as runRead's none branch above.
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const closes = rankSimilarNames(scanned, symbol)
    if (closes.length > 0) messages.push(didYouMean(closes))
    else if (scanned.length > 0) messages.push(`Try: token-goat outline ${file}`)
    emitErr(messages.join('\n'))
    return null
  }

  return resolution.entry
}

export function runDiff(opts: DiffOptions): number {
  if (opts.ref !== undefined && !refIsSafe(opts.ref)) {
    emitUnsafeRef(opts.ref)
    return 1
  }
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
    emit(`No changes to '${match.name}' in '${toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)}'.`)
    return 0
  }

  const { hunks } = splitDiffHunks(diffResult.stdout)
  const overlapping = hunks.filter((h) => h.start <= match.lineEnd && h.end >= match.lineStart)

  if (overlapping.length === 0) {
    emit(`No changes to '${match.name}' (lines ${match.lineStart}-${match.lineEnd}) in '${toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)}'.`)
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

  const header = `# ${match.name} (${match.kind}) — ${toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)}:${match.lineStart}-${match.lineEnd}`
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
  if (opts.ref !== undefined && !refIsSafe(opts.ref)) {
    emitUnsafeRef(opts.ref)
    return 1
  }
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
    emit(`No history for '${match.name}' (lines ${match.lineStart}-${match.lineEnd}) in '${toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)}'.`)
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

  const header = `# ${match.name} (${match.kind}) — ${toDisplayPath(getDisplayRoot(opts.projectRoot), match.filePath)}:${match.lineStart}-${match.lineEnd}`
  emit(guardText([header, logResult.stdout].join('\n'), 'diff'))
  return 0
}

// ---- grep -------------------------------------------------------------------

export interface GrepOptions {
  pattern: string
  path?: string | string[]
  /**
   * Root the search falls back to when `path` is omitted. Defaults to `process.cwd()` (the CLI's
   * long-standing behavior, unchanged when this is absent). An MCP server must pass its resolved
   * project root: without it, a client omitting `path` searched the server process's own cwd with
   * no confinement check at all -- see the invariant on `resolveToolRoot` in mcp_server.ts.
   */
  projectRoot?: string
  maxLines?: number
  json?: boolean
  recursive?: boolean
  context?: number
  symbol?: boolean
}

interface GrepHit {
  file: string
  line: number
  text: string
  context?: Array<{ line: number; text: string }>
  symbol?: { name: string; kind: string; lineStart: number; lineEnd: number } | null
}

/** Normalizes a realpath to one comparable spelling: forward slashes via {@link normalizePath}, plus a case fold on win32 where the filesystem is case-insensitive. */
function foldRealpath(p: string): string {
  const n = normalizePath(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

/** Handle ``token-goat grep <pattern>``. */
export function runGrep(opts: GrepOptions): number {
  const searchPaths =
    opts.path === undefined
      ? [opts.projectRoot ?? process.cwd()]
      : Array.isArray(opts.path)
        ? opts.path
        : [opts.path]
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
      // Pin-aware: consults `activePins` when this exact path was validated and pinned by the
      // MCP confinement gate (see readFileText), so an explicitly-requested `path` argument gets
      // the same swap-between-validate-and-read protection every other surgical-read command
      // gets. Files discovered by searchDir's own recursion below were never individually
      // pinned by the gate -- their protection is the realpath boundary check in searchDir, not
      // this identity check, which only fires for paths the gate itself validated.
      const text = readFileText(filePath)
      if (text === null) return
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
    } catch (err) {
      if (err instanceof ConfinementIdentityError) throw err
      // skip unreadable files
    }
  }

  // True when `candidateReal` (a realpath) is `boundaryReal` itself or nested inside it. Both
  // sides are pre-normalized realpaths, so this is a plain string comparison -- no further
  // symlink resolution needed at the call site.
  function withinRealpathBoundary(candidateReal: string, boundaryReal: string): boolean {
    const cFold = foldRealpath(candidateReal)
    const bFold = foldRealpath(boundaryReal)
    return cFold === bFold || cFold.startsWith(bFold.endsWith('/') ? bFold : `${bFold}/`)
  }

  // Realpaths already visited by the confined walk, folded by `foldRealpath`, so a symlink that
  // resolves back into the tree neither loops forever nor reports the same file twice. Reset
  // before each top-level search path so overlapping explicit `--path` arguments keep their
  // existing independent-walk semantics rather than silently deduplicating against each other.
  let visitedRealDirs = new Set<string>()

  // `boundaryReal` is `dir`'s own top-level search root, realpath-resolved once by the caller.
  // `fs.statSync` (unlike `fs.lstatSync`) follows symlinks, so a directory symlink inside the
  // search root that points outside it would otherwise be silently descended into and its
  // out-of-root contents searched -- a confinement bypass distinct from searchFile's own pin
  // check above (that one guards HOW an explicitly-requested file is opened; this one guards
  // WHICH files a recursive walk enumerates in the first place). The earlier check-then-use
  // shape was itself a TOCTOU window: it validated the symlink PATHNAME and then re-used that
  // same pathname for fs.statSync/recursion, so the link could be repointed outside the root in
  // between. Under confinement the walk now resolves the entry ONCE with fs.realpathSync,
  // boundary-checks that realpath, and then stats/recurses/reads the REALPATH only -- so
  // repointing the LINK afterwards cannot affect the walk, which never references that pathname
  // again. That is the variant this closes, and it is the one the regression test exercises.
  // It does NOT close the resolved-target variant: `target` is a path string, not a pinned
  // descriptor, so fs.statSync(target) and the recursive walk both re-resolve it, and swapping a
  // component of that realpath in between would still be followed. No portable
  // descriptor-relative traversal API exists to eliminate that window, so the recursive entry
  // re-checks the boundary on every call (below) to bound it rather than trusting one check, and
  // the residual race is accepted under a threat model with no concurrent writer inside the
  // confined root. Unconfined CLI grep keeps following the symlink pathname exactly as before,
  // since there is no attacker in that model.
  function searchDir(dir: string, boundaryReal: string): void {
    if (activePins !== null) {
      // Cycle and duplicate protection, confined-only so unconfined output stays byte-identical:
      // a symlink resolving back into the already-walked tree would otherwise recurse forever
      // (a -> b -> a) or report the same files twice via two different pathnames.
      let realDir: string
      try {
        realDir = foldRealpath(fs.realpathSync(dir))
      } catch {
        return
      }
      // Re-checked on every entry, not just at the caller's one-time resolution: `dir` is already a
      // boundary-checked realpath on the recursive path, so this normally re-derives the same string
      // and passes -- it only ever fires if a component of that realpath was swapped between the
      // caller's check and this re-resolution, which is exactly the residual race the docblock above
      // scopes. Cheap enough to pay unconditionally rather than trust the caller's check.
      if (!withinRealpathBoundary(realDir, boundaryReal)) return
      if (visitedRealDirs.has(realDir)) return
      visitedRealDirs.add(realDir)
    }
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('.')) continue
        const full = path.join(dir, entry)
        let lst: fs.Stats
        try {
          lst = fs.lstatSync(full)
        } catch {
          continue
        }
        // Everything below stats, recurses into, and reads `target` -- identical to `full` for an
        // ordinary entry, and the realpath (never the link pathname) for a confined symlink.
        let target = full
        if (lst.isSymbolicLink()) {
          let real: string
          try {
            real = fs.realpathSync(full)
          } catch {
            continue
          }
          if (!withinRealpathBoundary(real, boundaryReal)) continue
          if (activePins !== null) target = real
        }
        let stat: fs.Stats
        try {
          stat = fs.statSync(target)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue
          if (opts.recursive !== false) searchDir(target, boundaryReal)
        } else {
          searchFile(target)
        }
      }
    } catch (err) {
      if (err instanceof ConfinementIdentityError) throw err
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
      // Pin-aware: when this exact top-level directory was validated and pinned by the MCP
      // confinement gate (see confineTargets), verify its identity has not changed since before
      // deriving the search boundary from it below. Without this, a directory swapped to an
      // out-of-root symlink between gate validation and this call would have its (attacker-
      // controlled) realpath silently accepted as the boundary, and the recursive walk below
      // would search outside the root -- searchDir's own lstat/realpath boundary check only
      // guards entries discovered WITHIN the search, not the root of the search itself.
      const pinned = activePins?.get(pinKey(path.resolve(searchPath)))
      if (pinned !== undefined) verifyPin(searchPath, pinned)
      let boundaryReal: string
      try {
        boundaryReal = fs.realpathSync(searchPath)
      } catch (err) {
        // A swap that makes the path unresolvable (e.g. it was replaced with something
        // realpathSync can't stat) is exactly the failure mode this check exists to catch --
        // falling back to path.resolve(searchPath) here would derive the search boundary from
        // an unverified, possibly-attacker-controlled pathname at the one moment something is
        // already known to be wrong. Refuse instead of weakening the boundary; unpinned callers
        // (every CLI invocation, and MCP with confinement disabled) keep the pre-existing
        // resolve-and-continue fallback since there is no pin to have been swapped away from.
        if (pinned === undefined) {
          boundaryReal = path.resolve(searchPath)
        } else {
          throw new ConfinementIdentityError(
            `refused: "${searchPath}" could not be resolved after validation (${String(err)}). ` +
              'The path may have been replaced or redirected after the confinement check, so the search was not performed.',
          )
        }
      }
      // NARROWS, does not close, the finding-2 TOCTOU window: re-verify pinned identity
      // immediately after deriving boundaryReal, so a swap landing between the first
      // verifyPinnedIdentity call above and fs.realpathSync is detected here rather than
      // silently accepted into the search boundary. This does not eliminate the race -- Node
      // has no portable openat-style directory-descriptor traversal API (no `/proc/self/fd` on
      // Windows/macOS, no equivalent Node API on any platform), and this project's CI gates on
      // ubuntu, windows, and macos, so a swap landing in the small residual gap between this
      // second verification and searchDir's first entry read is still possible and undetected.
      if (pinned !== undefined) verifyPin(searchPath, pinned)
      visitedRealDirs = new Set<string>()
      searchDir(searchPath, boundaryReal)
    } else {
      searchFile(searchPath)
    }
  }

  if (hits.length === 0) {
    emitErr(`No matches for '${opts.pattern}'`)
    return 1
  }

  const truncated = hits.slice(0, maxLines)

  if (opts.symbol === true) {
    // Memoize querySymbols per file so N hits in the same file cost one DB query, not N.
    const symbolsByFile = new Map<string, ReturnType<typeof querySymbols>>()
    for (const hit of truncated) {
      let syms = symbolsByFile.get(hit.file)
      if (syms === undefined) {
        syms = querySymbols({ filePath: resolveIndexPath(hit.file), limit: ALL_SYMBOLS_IN_FILE_LIMIT })
        symbolsByFile.set(hit.file, syms)
      }
      const enc = enclosingSymbol(syms, hit.line)
      hit.symbol = enc === null ? null : { name: enc.name, kind: enc.kind, lineStart: enc.lineStart, lineEnd: enc.lineEnd }
    }
  }

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
    const symbolTag = opts.symbol === true && hit.symbol != null ? ` [${hit.symbol.name} (${hit.symbol.kind})]` : ''
    if (hit.context !== undefined) {
      // Same renderer `refs`/`callers` `-C` use, so the three cannot drift into different dialects.
      for (const line of renderContextWindow(hit.file, hit.line, hit.context, symbolTag)) emit(line)
    } else {
      emit(`${hit.file}:${hit.line}: ${hit.text}${symbolTag}`)
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
  /**
   * Project root a relative `file` resolves against. Defaults to `process.cwd()`; same field name
   * as {@link ReadOptions.projectRoot}. Relevant for callers (e.g. an MCP server) whose cwd is not
   * the workspace root -- a relative `file` would otherwise be read from, and indexed against, a
   * directory the caller never named.
   */
  projectRoot?: string
  /**
   * Only list rows whose primary string matches this pattern -- the exported symbol NAME for
   * `exports`, the imported MODULE SPECIFIER for `imports`. Regex, falling back to a literal
   * substring match when it does not compile -- see compileGrepMatcher.
   */
  grep?: string
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

/**
 * Multi-file dispatcher for the two emit-directly listing commands (`exports`, `imports`).
 * Unlike `skeleton`/`outline` these print as they go rather than returning text, so each block is
 * headed by an explicit `# <Label>: <file>` line here -- without it the concatenated single-file
 * output gives no way to tell which file a given row came from. Exit 0 when any file succeeded,
 * mirroring {@link runPerFileListing}.
 */
function runPerFileEmitting(files: string[], label: string, run: (file: string) => number): number {
  let anyOk = false
  files.forEach((file, i) => {
    if (i > 0) emit('')
    emit(`# ${label}: ${file}`)
    if (run(file) === 0) anyOk = true
  })
  return anyOk ? 0 : 1
}

/** Handle ``token-goat exports file``. Also accepts the family's comma-separated multi-file spec (`a,b,c`), emitting one headed block per file. */
export function runExports(opts: ImportsExportsOptions): number {
  const multiFiles = parseMultiFileSpec(opts.file)
  if (multiFiles !== null) return runPerFileEmitting(multiFiles, 'Exports', (file) => runExports({ ...opts, file }))

  const confined = fileConfinementRefusal('This file', opts.file, opts.projectRoot)
  if (confined !== null) {
    emitErr(confined)
    return 1
  }

  const diskPath = resolveAgainstProjectRoot(opts.file, opts.projectRoot)
  const symbols = querySymbols({ filePath: resolveIndexPath(diskPath), limit: 500 })
  const kindOf = (name: string): string => symbols.find((s) => s.name === name)?.kind ?? 'export'
  // Unlike kindOf's loose `?? 'export'` fallback, an unmatched name (one that only came from the
  // source-text scan, with no corresponding index row) must report no location at all -- never a
  // fabricated value borrowed from an unrelated symbol.
  const locOf = (name: string): { lineStart: number; lineEnd: number } | null => {
    const s = symbols.find((sym) => sym.name === name)
    return s === undefined ? null : { lineStart: s.lineStart, lineEnd: s.lineEnd }
  }

  // Index-side heuristic: catches languages whose stored body keeps the `export`/`pub`/`public` modifier, and the mocked unit tests.
  const names: string[] = []
  for (const s of symbols) {
    if (/^(?:export|pub\b|public\b)/.test(s.body.trimStart()) && !names.includes(s.name)) {
      names.push(s.name)
    }
  }
  const ext = path.extname(opts.file).toLowerCase()
  // Source scan: catches tree-sitter languages whose body omits the modifier.
  const text = readFileText(diskPath)
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

  // --grep narrows on NAME, applied before any output (JSON or text) is built -- there is no
  // further truncation step downstream for `exports` to run ahead of.
  const preFilterCount = names.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredNames = matchesGrep !== undefined ? names.filter((n) => matchesGrep(n)) : names

  const fullSourceBytes = sumFileSizes([diskPath])

  if (filteredNames.length === 0) {
    // Genuinely-empty ("No exported symbols found") already returned above; this is the file
    // having exports but --grep matching none of them -- distinct states per the repo's
    // filtered-store convention.
    if (opts.json === true) {
      const jsonText = JSON.stringify([], null, 2)
      emit(jsonText)
      recordReadStat('exports', fullSourceBytes, jsonText, opts.file)
      return 0
    }
    const text = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'exported symbol', 'exported symbols')
    emit(text)
    recordReadStat('exports', fullSourceBytes, text, opts.file)
    return 0
  }

  if (opts.json === true) {
    const jsonText = JSON.stringify(
      filteredNames.map((n) => {
        const loc = locOf(n)
        return { name: n, kind: kindOf(n), lineStart: loc?.lineStart ?? null, lineEnd: loc?.lineEnd ?? null }
      }),
      null,
      2,
    )
    emit(jsonText)
    recordReadStat('exports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = filteredNames.map((n) => {
    const loc = locOf(n)
    const locSuffix = loc === null ? '' : ` (${loc.lineStart}-${loc.lineEnd})`
    return `${kindOf(n).padEnd(10)} ${n}${locSuffix}`
  })
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
    // Same gap as Kotlin above: Swift's submodule-import form (`import class UIKit.UIView`,
    // importing just one member of a module) has its leading keyword consumed by the dedicated
    // extractor before the real target is captured, but the generic `import|require|use|#include`
    // fallback below has no such stop condition and greedily captures "class UIKit.UIView"
    // verbatim as the import target -- diverging from the symbol index for the same file.
    // swift.ts's own pattern is imported rather than copied here, because a copy is what let the
    // two drift: attributes and Swift 6 access-controlled imports were added to one and not the
    // other, so this command reported no imports for a file the index had indexed correctly.
    for (const line of lines) {
      const m = SWIFT_IMPORT_RE.exec(stripSwiftImportAttributes(line.trim()))
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

/** Handle ``token-goat imports file``. Also accepts the family's comma-separated multi-file spec (`a,b,c`), emitting one headed block per file. */
export function runImports(opts: ImportsExportsOptions): number {
  const multiFiles = parseMultiFileSpec(opts.file)
  if (multiFiles !== null) return runPerFileEmitting(multiFiles, 'Imports', (file) => runImports({ ...opts, file }))

  const diskPath = resolveAgainstProjectRoot(opts.file, opts.projectRoot)
  const text = readFileText(diskPath)
  if (text === null) {
    emitErr(`Could not read: ${opts.file}`)
    return 1
  }
  const imports = extractImports(text, importsExtensionFor(opts.file))

  if (imports.length === 0) {
    emit(`No imports found in '${opts.file}'`)
    return 0
  }

  // --grep narrows on the MODULE SPECIFIER, run before guardJsonRows' truncation so it selects
  // from the whole import list rather than an already-capped page.
  const preFilterCount = imports.length
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const filteredImports = matchesGrep !== undefined ? imports.filter((i) => matchesGrep(i)) : imports

  const fullSourceBytes = sumFileSizes([diskPath])

  if (filteredImports.length === 0) {
    if (opts.json === true) {
      const jsonText = JSON.stringify({ items: [], truncated: false, totalCount: 0 }, null, 2)
      emit(jsonText)
      recordReadStat('imports', fullSourceBytes, jsonText, opts.file)
      return 0
    }
    const text2 = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'import', 'imports')
    emit(text2)
    recordReadStat('imports', fullSourceBytes, text2, opts.file)
    return 0
  }

  if (opts.json === true) {
    const capped = guardJsonRows(filteredImports)
    const jsonText = JSON.stringify({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, null, 2)
    emit(jsonText)
    recordReadStat('imports', fullSourceBytes, jsonText, opts.file)
    return 0
  }

  const outLines = filteredImports.map((imp) => `import  ${imp}`)
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
  /** Filter to hits whose FILE PATH matches this pattern (matched against the path as rendered under displayRoot, same convention as `refs --grep`). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. Applied before the `--limit` slice in both the embeddings and FTS-fallback branches. */
  grep?: string
  /**
   * `--exclude-tests`: drop hits whose file lives in a test file (per isTestFile), matching
   * `refs`/`callers`/`dead`'s flag of the same name. Opt-in; omitted or false leaves output
   * byte-identical to today. Distinct from `grep`, which can only ever *select* paths -- there
   * is no `--grep` pattern that reliably excludes tests, since a negative lookahead silently
   * degrades to a literal substring match on the regex-compile fallback. Composes with `grep`:
   * a hit must satisfy both. Applied before the `--limit` slice in both branches.
   */
  excludeTests?: boolean
}

// Ported from cli.ts's cmdSemantic, which used to throw a CliError (caught by the generic
// `guard` wrapper, which prefixes it with "token-goat: " before printing to stderr) on a
// no-matches miss instead of returning a code. The "token-goat: " prefix is baked into the
// returned text here so the CLI's output stays byte-identical to that historical path.
// Reciprocal Rank Fusion constant (score = sum over lists of 1/(RRF_K + rank)) -- the conventional k=60, chosen because RRF needs only each list's RANK (not its raw score), which sidesteps having to normalize dense cosine/L2 distance against BM25's unbounded score on incomparable scales.
const RRF_K = 60

// One row of runSemantic's fused dense+BM25 candidate set: dense-sourced rows carry a non-null distance and (when resolveEnclosingSymbol found a containing symbol) a name/kind pulled from that containment lookup, while FTS-sourced rows always carry the exact symbol's own name/kind and a null distance (BM25 has no notion of vector distance) -- a row present in both lists keeps its dense fields (distance, containment-derived name/kind) and simply accumulates the FTS list's rank into its score.
interface FusedSemanticHit {
  filePath: string
  startLine: number
  endLine: number
  name: string | null
  kind: string | null
  distance: number | null
  previewText: string
  rrf: number
}

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

  // Real embedding-vector similarity search: chunks/chunk_vectors are populated during indexing whenever indexing.embeddings_enabled is on and the optional onnxruntime-node and sqlite-vec dependencies are present -- searchSemantic degrades to an empty array rather than throwing when either is unavailable or nothing has been embedded yet, so this is always safe to try; BM25 (below) is now ALWAYS consulted too, never gated on this returning zero hits, since a single weak dense hit used to make an exact BM25 keyword match unreachable.
  // Over-fetch a larger candidate set (same ratio searchSemantic already uses internally for its own ANN over-fetch) so mergeNearbyHits has headroom to consolidate nearby/overlapping hits in the SAME file before truncation, instead of merging an already-capped set of `n` raw hits — which can silently drop a hit that would have merged, or shrink the result below `n`.
  // Say what the user is actually getting when the embedding model is absent. This is the default
  // state now: the inference runtime is opt-in rather than something every install receives, so
  // that a feature most installs never invoke does not put a 34 MB native addon on every machine.
  // The result is a real degradation that produces no error and no empty result -- BM25 below
  // still answers -- which is precisely the kind of quiet change nobody discovers. Stated here
  // rather than inside searchSemantic because only this function knows the keyword pass runs, and
  // the message there claimed the whole feature was off while printing above genuine keyword hits.
  if (!embeddingModelAvailable()) {
    console.warn(
      'Matching on meaning is off (onnxruntime-node is not installed); these results come from keyword search alone. ' +
        'Install it with: npm install -g onnxruntime-node (drop -g if token-goat is a project dependency)',
    )
  }
  const overFetchForMerge = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  // The dense half is best-effort, and this catch is the whole of what makes that true. The
  // package being absent is handled inside searchSemantic (it returns no hits), but the model
  // files are a separate thing that can be missing on their own: the runtime installs fine and
  // then the weights cannot be fetched -- offline mode, no cache yet, a network failure, a digest
  // that does not match. That throws out of embedTexts, and before this catch it escaped
  // runSemantic entirely, so `semantic` exited non-zero with nothing on stdout at the exact moment
  // it was supposed to degrade to keyword search. Same treatment as the absent package: say what
  // is missing, then carry on with the BM25 pass below, which is the half that still works.
  let rawHits: SearchHit[] = []
  try {
    rawHits = await searchSemantic(
      getDb(globalDbPath()),
      query,
      overFetchForMerge,
      undefined,
      undefined,
      rootDir,
    )
  } catch (e) {
    console.warn(
      `Matching on meaning is off (${extractErrorMessage(e)}); these results come from keyword search alone.`,
    )
  }
  const mergedHits = mergeNearbyHits(rawHits)
  // BM25 full-text search over symbol names/bodies/docstrings, over-fetched for the same reason as the dense side above: searchSymbolsFts caps at the DB level via its own SQL LIMIT, so a post-hoc filter (--grep/--exclude-tests) or a post-hoc fusion rank on an already-`n`-capped result would silently under-represent this list relative to the dense one -- always called now (previously gated behind the dense branch returning zero hits), reusing the same OVER_FETCH_FACTOR/MAX_OVER_FETCH ratio the dense branch already uses.
  const overFetchFts = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  const ftsRows = searchSymbolsFts(query, overFetchFts, undefined, rootDir)

  // Fuse both candidate lists with Reciprocal Rank Fusion -- a row is keyed by its enclosing symbol (filePath + name) when one is known, since that is the only identity both a dense chunk and a BM25 symbol row can genuinely share; a dense hit with no resolvable enclosing symbol falls back to filePath + start line, which an FTS row (always symbol-backed) can never collide with, so it simply stays its own row.
  const fused = new Map<string, FusedSemanticHit>()
  mergedHits.forEach((h, denseRank) => {
    const enclosing = resolveEnclosingSymbol(h.filePath, h.startLine)
    const key = enclosing !== null ? `${h.filePath}::${enclosing.name}` : `${h.filePath}::L${h.startLine}`
    fused.set(key, {
      filePath: h.filePath,
      startLine: h.startLine,
      endLine: h.endLine,
      name: enclosing?.name ?? null,
      kind: enclosing?.kind ?? null,
      distance: h.distance,
      previewText: h.text,
      rrf: 1 / (RRF_K + denseRank),
    })
  })
  ftsRows.forEach((s, ftsRank) => {
    const key = `${s.filePath}::${s.name}`
    const existing = fused.get(key)
    if (existing !== undefined) {
      // Already present from the dense pass -- keep its dense-sourced fields (distance, containment-derived name/kind) and just add this list's rank contribution to the score.
      existing.rrf += 1 / (RRF_K + ftsRank)
    } else {
      fused.set(key, {
        filePath: s.filePath,
        startLine: s.lineStart,
        endLine: s.lineEnd,
        name: s.name,
        kind: s.kind,
        distance: null,
        previewText: s.body,
        rrf: 1 / (RRF_K + ftsRank),
      })
    }
  })
  // Map insertion order (JS Map iterates in insertion order) puts every dense-pass row ahead of any FTS-only row it didn't merge with, so a stable sort's tie-break (identical RRF score, e.g. both lists' rank-0) prefers the dense-backed row -- deliberate, since a dense hit is a direct answer to the query's semantics while a tied BM25-only row only matched a shared term.
  const fusedHits = Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf)

  // --grep narrows on the FILE PATH AS RENDERED (toDisplayPath), matching `refs --grep`'s convention -- an anchored `^src/` must match what the human/JSON output actually shows, not the stored absolute path; applied here, between fusion and slice, so `--limit 20 --grep '^src/'` returns 20 src/ hits rather than however many of the top-20 *unfiltered* hits happen to live under src/ -- the "filter must precede slice" trap this repo has hit before.
  // --exclude-tests rides the same seam for the same reason: filtering after the slice would return however many of the top-`n` hits happen not to be tests, rather than `n` non-test hits -- it is checked against the STORED path (isTestFile), not the rendered one, because whether a file is a test is a property of the file itself, not of how it is displayed.
  const matchesGrep = opts.grep !== undefined ? compileGrepMatcher(opts.grep) : undefined
  const preFilterCount = fusedHits.length
  const keepHit = (h: { filePath: string }): boolean => {
    if (opts.excludeTests === true && isTestFile(h.filePath)) return false
    return matchesGrep === undefined || matchesGrep(toDisplayPath(rootDir, h.filePath))
  }
  const anyFilter = matchesGrep !== undefined || opts.excludeTests === true
  const filteredHits = anyFilter ? fusedHits.filter(keepHit) : fusedHits
  // Counted on the grep-surviving set, so the number reported by the --exclude-tests notice is "tests hidden among the hits you actually asked for", not tests hidden repo-wide.
  const suppressedTotal = opts.excludeTests === true
    ? fusedHits.filter((h) => (matchesGrep === undefined || matchesGrep(toDisplayPath(rootDir, h.filePath))) && isTestFile(h.filePath)).length
    : 0
  const hits = filteredHits.slice(0, n)

  // Which list(s) actually contributed a candidate decides the reported `source` -- 'hybrid' only when both lists had at least one raw hit (even if they didn't fuse into the same row), never 'embeddings' silently standing in for a result that is partly BM25.
  const hadDense = mergedHits.length > 0
  const hadFts = ftsRows.length > 0
  const source = hadDense && hadFts ? 'hybrid' : hadDense ? 'embeddings' : 'fts'

  if (hits.length > 0) {
    if (opts.json === true) {
      // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json.
      const items = hits.map((h) => ({
        filePath: toDisplayPath(rootDir, h.filePath),
        name: h.name,
        kind: h.kind,
        startLine: h.startLine,
        endLine: h.endLine,
        distance: h.distance,
        preview: previewLines(h.previewText, 3),
      }))
      // Same {items, truncated, totalCount} envelope guardJsonRows returns for symbol/refs/skeleton/outline's --json mode (see the comment at the grep --json call site) -- a bare {source, items} payload would silently hand a JSON consumer fewer hits than actually matched with no way to tell "capped by the overflow guard" apart from "there just weren't more", and would let `--limit 500 --json` emit an unbounded payload.
      const capped = guardJsonRows(items)
      const text = JSON.stringify({ source, ...capped }, null, 2)
      recordReadStat('semantic_search', sumFileSizes(hits.map((h) => h.filePath)), text, query)
      return { text, code: 0 }
    }
    // A dense-sourced row (distance !== null) renders the distance-annotated block the embeddings branch always used, including the "— inside NAME (KIND)" containment suffix when resolved; an FTS-only row (distance === null, always symbol-backed) renders the plain "name (kind) — path" header the FTS fallback always used, with no "distance" or "inside" wording, since it IS the symbol, not a chunk found to be inside one.
    const blocks = hits.map((h) => {
      if (h.distance !== null) {
        const suffix = h.name !== null ? ` — inside ${h.name} (${h.kind})` : ''
        return `# ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine} (distance ${h.distance.toFixed(3)})${suffix}\n${previewLines(h.previewText, 3)}`
      }
      return `# ${h.name} (${h.kind}) — ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine}\n${previewLines(h.previewText, 3)}`
    })
    const text = guardText(blocks.join('\n\n'), 'semantic')
    recordReadStat('semantic_search', sumFileSizes(hits.map((h) => h.filePath)), text, query)
    return { text, code: 0 }
  }

  // Total number of fused hits that existed BEFORE --grep was applied -- used to distinguish "--grep matched none of the N hits that do exist" (this is a real store that a filter emptied out) from a genuinely empty index/search, per this repo's filtered-store convention (dead/refs/exports/imports all draw this same distinction).
  if (matchesGrep !== undefined && preFilterCount > 0) {
    const notice = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'match', 'matches')
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, grepFilteredToEmpty: true, hint: notice.trim() }
      return { text: JSON.stringify(payload, null, 2), code: 0 }
    }
    return { text: `token-goat: ${notice.trim()}`, code: 0 }
  }
  // Same distinction one flag over: "--exclude-tests hid every hit there was" is a filtered store, not an empty one, so it exits 0 with a notice naming the count instead of the exit-1 "no matches" below -- checked after --grep so a run with both flags reports the narrower grep story first, matching runRefs's ordering.
  if (opts.excludeTests === true && suppressedTotal > 0) {
    const notice = `no non-test matches for '${query}' (${excludeTestsHiddenNote(suppressedTotal)})`
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, excludeTestsFilteredToEmpty: true, hint: notice }
      return { text: JSON.stringify(payload, null, 2), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }
  // Evidence is a project-scoped fallback, not a replacement for source-index matches: its
  // entries are redacted historical observations and carry no source line contract. Only consult
  // it after both source retrieval paths miss and when no source-specific filter was requested.
  if (!anyFilter) {
    const evidenceHits = await searchEvidenceSemantically(rootDir, query, n)
    if (evidenceHits.length > 0) {
      // What this hit avoids is re-reading the cached entries in full, so the saving is measured against their whole text: the preview below is what gets emitted, and recordReadStat subtracts it.
      const evidenceFullBytes = evidenceHits.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0)
      if (opts.json === true) {
        const items = evidenceHits.map((entry) => ({
          source: toDisplayPath(rootDir, entry.source),
          representation: entry.representation,
          preview: previewLines(entry.text, 3),
          cachedAt: entry.createdAt,
        }))
        const capped = guardJsonRows(items)
        const text = JSON.stringify({ source: 'workspace-evidence', ...capped }, null, 2)
        recordReadStat('semantic_search', evidenceFullBytes, text, query)
        return { text, code: 0 }
      }
      const text = guardText(
        evidenceHits
          .map((entry) => `# cached ${entry.representation} evidence — ${toDisplayPath(rootDir, entry.source)}\n${previewLines(entry.text, 3)}`)
          .join('\n\n'),
        'semantic',
      )
      recordReadStat('semantic_search', evidenceFullBytes, text, query)
      return { text, code: 0 }
    }
  }
  // Only paid after both the dense search and the BM25 search already came back empty.
  const indexEmpty = isIndexEmptyForProject(globalDbPath(), rootDir)
  if (opts.json === true) {
    // A dedicated field, never prose folded into an existing string field -- same "add a field, don't rewrite an existing one" convention doctor's own {status, message} shape follows, and consistent with this payload's own {source, items, truncated, totalCount} envelope.
    const payload = indexEmpty
      ? { source: 'fts', items: [], truncated: false, totalCount: 0, indexEmpty: true, hint: emptyIndexMessage(rootDir) }
      : { source: 'fts', items: [], truncated: false, totalCount: 0 }
    const text = JSON.stringify(payload, null, 2)
    return { text, code: 1 }
  }
  const text = indexEmpty
    ? `token-goat: no matches for '${query}'\n${emptyIndexMessage(rootDir)}`
    : `token-goat: no matches for '${query}'`
  return { text, code: 1 }
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
    // Distinguish "notes exist but none are stale" from "no notes recorded at all" -- same
    // empty-vs-filtered-store distinction runDead makes for --exclude-tests, so --stale-only
    // finding nothing doesn't read as "there are no notes" when notes just aren't stale.
    if (opts.staleOnly === true && withStale.length > 0) {
      const noun = withStale.length === 1 ? 'note' : 'notes'
      return { text: `No stale notes (${withStale.length} ${noun} recorded, none stale).`, code: 0 }
    }
    return { text: opts.staleOnly === true ? 'No stale notes.' : 'No notes recorded.', code: 0 }
  }
  const noteListDisplayRoot = getDisplayRoot()
  const lines = filtered.map(({ note, stale }) => {
    const displayFile = toDisplayPath(noteListDisplayRoot, note.filePath)
    const target = note.symbol === WHOLE_FILE_NOTE_SYMBOL ? displayFile : `${displayFile}::${note.symbol}`
    return `${stale ? '[STALE] ' : ''}${target}`
  })
  return { text: lines.join('\n'), code: 0 }
}
export { querySymbols, queryRefs, readSection, listSections, extractSection, runSemantic }
