import { parseYamlDocument } from './read_structured_data.js'
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
import { redactIfDotenv } from './dotenv_redact.js'
import { querySymbols, queryRefs, queryRefCounts, searchSymbolsFts, getFileEntry, countSymbols, countRefs, DEFAULT_QUERY_LIMIT } from './index_reader.js'
import { indexedSourceText, formatSymbolLocation, isVirtualIndexedPath, virtualIndexedScopeNote, NOTEBOOK_CELL_LINES_SUFFIX } from './indexed_source.js'
import { displaySafeText, normalizePath, resolveIndexPath, toDisplayPath, displaySafeJson } from './paths.js'
import { indexFileSync, isTreeSitterAvailable } from './parser.js'
import { compileGuardedRegex } from './regex_guard.js'
import { supportRequestLine } from './version.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { globalDbPath } from './constants.js'
import { extractExportNames, extractImports, importsExtensionFor } from './import_export_extract.js'
export { extractExportNames, extractImports, importsExtensionFor }
import { getDb } from './db.js'
import { fileIsAbsent, fingerprintFile } from './fingerprint.js'
import { searchSemantic, mergeNearbyHits, OVER_FETCH_FACTOR, MAX_OVER_FETCH, isAvailable as embeddingModelAvailable, type SearchHit } from './embeddings.js'
import { searchEvidenceSemantically } from './evidence_cache.js'
import { readSection, listSections, extractSection, findContainingSection } from './section_reader.js'
import type { SectionResult } from './section_reader.js'
import { decodeSource, runGit, ensureNewline, PER_FILE_COUNTERFACTUAL_CEILING, foldPath, foldCaseForContainment, compileGrepMatcher, grepFilteredToEmptyNotice, filtersFilteredToEmptyNotice, excludeTestsHiddenNote, countNoun, requirePositiveStrictInt, extractErrorMessage, buildContextWindow, renderContextWindow, isTestFile, type SourceContextLine } from './util.js'
export { requireNonNegativeStrictInt } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { getDisplayRoot, isInsideRoot, resolveProjectRoot } from './project.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'
import { unsupportedLanguageName, TREE_SITTER_LANGUAGES } from './parser_types.js'
import { loadConfig } from './config.js'
import { fenceUntrustedContent, UNTRUSTED_GITHUB_TAG } from './injection_scan.js'
import { redactSecrets } from './secret_redact.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { isRefIndexedFile, refBlindLanguageNotice, refBlindKindNotice, refBlindKindPartialNote, REF_BLIND_DEF_PROBE_LIMIT } from './ref_blindness.js'
import { detectLanguageOfFile } from './parser_types.js'
import { resolveCallers, enclosingSymbol, ALL_SYMBOLS_IN_FILE_LIMIT, refBlindKindVerdict } from './graph_commands.js'
import type { CallerEntry } from './graph_commands.js'
import { MAX_ZIP_INPUT_BYTES, ZipInputTooLargeError } from './zip_bounds.js'
import {
  isGhAvailable,
  isGhAuthenticated,
  parseGithubRepoFromRemoteUrl,
  isSafeRepoSlug,
  isSafePrNumber,
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
import { extractPdfMeta, extractPdfOutline, extractPdfText, locatePdfPages, readPdfFileWithinBounds, type PdfLocateResult, type PdfMeta, type PdfOutlineEntry } from './pdf_extract.js'
import { isImagePath, probeImageMeta, shrinkImage, ImageDecodeError } from './image_shrink.js'
import { ocrImage, isTextHeavy, isOcrEngineAvailable, ocrIntegrityFailed } from './image_ocr.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { isTsPath, resolveTypedRefs } from './ts_refs.js'
import { isIndexEmptyForProject, emptyIndexMessage, getEmbeddingCoverage } from './index_health.js'

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
export const FIND_SCAN_LIMIT = 20_000
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
export function readFileText(p: string): string | null {
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
export function readFileBytes(p: string): Buffer | null {
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
export function isValidUtf8(buf: Buffer): boolean {
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
  return indexedSourceText(entry.filePath, source)
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

// Bound on how many of a multi-file command's own result files get a staleness check. `refs`,
// `ask`, `semantic`, and a Python `trace --bodies` all answer from several rows at once (one per
// file, not one file the caller named), unlike `symbol`/`read`/`skeleton`/`outline`'s single
// `staleWarning`/`healStaleIndex` call against the one file the caller asked about. A command
// returning a hundred hits across a hundred files would otherwise pay a hundred fingerprints (and
// synchronous reparses) purely for this check; capped here at a number well above what any of
// these commands' own result limits render in practice, so a normal call never bumps the cap.
const STALE_CHECK_FILE_CAP = 25

/**
 * Self-heal AND warn for a multi-file command's own result set, the sibling of the
 * `healStaleIndex`+`staleWarning` pair every single-file surgical-read command already runs, for
 * the shape `refs`/`ask`/`semantic`/`trace --bodies` have instead: several distinct result files
 * from one query, none of which the caller named directly, so there is no one file to check
 * before the query the way `runSymbol` checks the file in its spec. This answers stale rows
 * exactly as loudly as those commands do -- console.warn rather than folded into the JSON body,
 * so JSON consumers get an unambiguous stdout payload while still seeing the warning on stderr --
 * rather than the silent behavior these four commands had before: a wrong answer with no warning
 * is worse than a slow one, and warning-then-still-answering is what every single-file command
 * here already does.
 *
 * MUST be called with the files a query's results actually came from, AFTER that query already
 * ran (mirrors `healStaleIndex`'s own contract: it does not re-fetch anything, so healing here
 * only benefits the *next* call to this command, same as the single-file commands above).
 */
export function warnIfFilesStale(filePaths: readonly string[]): void {
  const checked = new Set<string>()
  let staleCount = 0
  for (const raw of filePaths) {
    if (checked.size >= STALE_CHECK_FILE_CAP) break
    if (checked.has(raw)) continue
    checked.add(raw)
    if (staleWarning(raw) === '') continue
    staleCount++
    // healStaleIndex is best-effort for ordinary parse/I/O failures already; only a detected
    // between-check-and-use path swap (ConfinementIdentityError) is meant to escape it, and that
    // is a real security-relevant condition this wrapper must not paper over either.
    healStaleIndex(raw)
  }
  if (staleCount > 0) {
    console.warn(
      `token-goat: ${countNoun(staleCount, 'file')} behind these results changed on disk since the index last saw ${staleCount === 1 ? 'it' : 'them'} -- a reindex just ran, so a repeat of this command will reflect the current version.`,
    )
  }
}

export function emit(text: string): void {
  const out = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(out))
}

export function emitErr(text: string): void {
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
export function emitGuarded(text: string, command: string): void {
  emit(guardText(text, command))
}

export function guardText(text: string, command: string): string {
  const cfg = loadConfig()
  return cfg.overflow_guard.enabled ? trimToBudget(text, cfg.overflow_guard.max_tokens, command) : text
}

/**
 * Wrap `text` in an untrusted-content fence under {@link UNTRUSTED_GITHUB_TAG}. A PR's title,
 * description, review comments, and diff are all authorable by anyone who opened the PR or left
 * the comment, so the fence follows that provenance and not the scan result. The scan still runs,
 * purely to name matched pattern(s) in the notice and record the stat.
 *
 * Used by every printed `pr-slice` emit site. The `--json` sites use
 * {@link fenceGithubFieldIfMatched} instead -- see the note there.
 */
function fenceGithubText(text: string): string {
  return fenceUntrusted(text, UNTRUSTED_GITHUB_TAG)
}

/**
 * Per-field variant for the `pr-slice --json` envelopes, still gated on a scan hit. Fencing the
 * envelope once would be O(1) and provenance-correct, but a fence wrapped around JSON is no longer
 * JSON, and `--json` output is parsed by callers; fencing each field unconditionally instead pays
 * a fixed ~129-byte wrapper per field, which a short comment body or a PR title does not absorb.
 * Same deliberate exception as `fenceFileFieldIfMatched` in cli.ts, and it needs the same
 * wire-format decision to resolve.
 */
function fenceGithubFieldIfMatched(text: string): string {
  const matches = scanAndRecord(text)
  if (matches.length === 0) return text
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

export function sumFileSizes(filePaths: Iterable<string>): number {
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

/** Counterfactual byte cost of the search `refs` replaces: one `path:line: label` hit line per reference, the shape `grep -n <symbol>` prints. This is deliberately NOT sumFileSizes over the files those references live in: nobody reads forty files end to end to find call sites, they run a search, so crediting `refs` with those files' whole contents overstated a multi-file result by orders of magnitude (a real ledger showed ~466KB claimed per `refs` event, because the 100KB-per-file ceiling in sumFileSizes bounds each file and never the sum). Deliberately a LOWER bound on what the equivalent search would emit, and only a lower bound: `ref.context` is the short enclosing-symbol label refs renders, where a grep hit line carries the whole matched source line, and a textual grep also returns comments, strings and unrelated same-named symbols that are not references at all. Neither of those is knowable without re-reading every hit file, so the ledger claims only what it can prove from rows already in hand. Requested `--context` lines are excluded for the same reason they cannot earn credit: they are extra output the caller asked for on top of what the plain search prints. */
function refsSearchBaselineBytes(rows: Iterable<RefEntry>): number {
  let total = 0
  for (const ref of rows) total += Buffer.byteLength(`${refsDisplayPath(ref.filePath)}:${ref.line}: ${ref.context}\n`, 'utf8')
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
export function recordReadStat(kind: string, fullSourceBytes: number, emittedText: string, detail?: string): void {
  const emittedBytes = Buffer.byteLength(emittedText, 'utf8')
  const bytesSaved = Math.max(1, fullSourceBytes - emittedBytes)
  recordStat(kind, bytesSaved, savedTokensFromBytes(bytesSaved), undefined, detail)
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
  const lines = [`Not a file: '${displaySafeText(name)}'. Did you mean:`]
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
function resolveEnclosingSymbol(filePath: string, chunkStartLine: number): { name: string; kind: string; lineStart: number } | null {
  // No rootDir scope here: filePath alone already narrows to the exact file the hit came from
  // (an absolute path from the embeddings index), so an additional project-prefix filter is
  // redundant and, worse, can spuriously exclude the very row being looked up whenever the
  // stored/queried root strings don't normalize identically (e.g. a symlinked or 8.3-short
  // temp path) -- the same file_path equality check every other exact-file lookup in this
  // file already relies on without a rootDir filter (see the `resolved` lookups above).
  // Unbounded (-1), not a finite cap: querySymbols orders by (file_path, line_start), so a per-file cap on a bare filePath query has no predicate left to combine against and silently drops every symbol past the cutoff -- a generated/data-shaped file with more flat top-level declarations than the old 100,000 cap lost its tail (confirmed with a 100,051-symbol fixture), so a hit landing in the last symbol resolved to no enclosing symbol instead of the real one. Same fix and reasoning as ALL_SYMBOLS_IN_FILE_LIMIT in graph_commands.ts.
  const symbols = querySymbols({ filePath, limit: -1 }, globalDbPath())
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if (s.lineStart <= chunkStartLine && chunkStartLine <= s.lineEnd) {
      if (best === null || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) {
        best = s
      }
    }
  }
  // lineStart is returned alongside name/kind because the fusion key below needs it: a bare name
  // is not unique within a file (two classes can each define a same-named method), and keying on
  // name alone silently collapses two genuinely different symbols into one Map entry, dropping one.
  return best === null ? null : { name: best.name, kind: best.kind, lineStart: best.lineStart }
}

export function trimBlankLines(lines: string[]): string[] {
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
      return { text: displaySafeJson({ items: [], truncated: false, totalCount: 0 }), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }

  if (matchesGrep !== undefined && filtered.length === 0 && preFilterCount > 0) {
    // The scope (--file/--kind/--project) genuinely has symbols, but --grep matched none of
    // them -- distinct from the `results.length === 0` branch below, which means there was
    // nothing in scope at all. Same "filtered store renders as populated" trap already fixed
    // for types/dead/exports.
    if (opts.json === true) {
      const text = displaySafeJson({ items: [], truncated: false, totalCount: 0 })
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
        const where = shown.map((s) => `${s.kind} at ${formatSymbolLocation(toDisplayPath(rootDir, s.filePath), s.lineStart)}`).join('; ')
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
    const text = displaySafeJson(payload)
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
    const header = `# ${sym.name} (${sym.kind}) — ${formatSymbolLocation(toDisplayPath(symbolDisplayRoot, sym.filePath), sym.lineStart, sym.lineEnd)}${statsStr}${goneTag}`
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
 * `countRefs` reruns the SQL filters with no LIMIT, which is exact. The client-side filters (`--exclude-tests`, `--grep`, and the typed-refs tier) have no SQL equivalent, so their total is the post-filter count of the window the rows came from: exact only while that window had room to spare, a floor once it filled.
 *
 * `scanLimit` is the window the rows were actually fetched under, which is NOT one fixed number. `--exclude-tests`/`--grep`/`--top` widen it to REFS_TOP_SCAN_LIMIT, an explicit `--limit` sets it, and a query with none of those gets queryRefs' own DEFAULT_QUERY_LIMIT. Comparing against the widened constant in every case would call a filled narrow window exact, which is the one shape that is certainly a floor.
 *
 * No CLI path reaches that wrong branch today, and the fix is deliberately not sold as one: {@link truncationNotice} prints nothing unless `shown >= limit` and `count > shown`, and on every route that leaves this window narrow the window IS the display limit, so the post-filter count cannot exceed what was shown. That is a coincidence held together three call frames apart, and it is the whole reason to compare against the window actually used instead: widening a default here, or slicing to something other than the query limit there, silently turns a floor into a claimed total with no test able to see it happen.
 */
function refsTotal(clientFiltered: boolean, filteredTotal: number | undefined, shown: number, countExact: () => number, preScanCount: number, scanLimit: number): TruncationTotal {
  if (!clientFiltered) return { count: countExact(), exact: true }
  return { count: filteredTotal ?? shown, exact: preScanCount < scanLimit }
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
    // A symbol name and a file name are chosen by the repository, and this sentence is token-goat instructing the reader what to do next, so a name shaped like a marker would read as part of that instruction.
    `Ambiguous symbol '${displaySafeText(symbol)}' in '${displaySafeText(file)}': ${countNoun(candidates.length, 'definition')} match. ` +
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
    // Narrow the container query by the requested file's basename in SQL, not just via the filePath containment check applied to its results below: without this, a container name shared by more than 50 classes across the index (a common name like "Handler" or "Config") sorts the file we actually want past the LIMIT 50 cutoff before that check ever sees it, and disambiguation silently falls through to the wrong same-named method. `candidates` at this point may already span more than one file (the fallback above matches on a path boundary, not exact equality), so this narrows by basename rather than exact filePath, and the per-candidate filePath equality check a few lines down still picks the right one.
    const containerBaseName = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
    const containers = querySymbols({
      name: symBase,
      limit: 50,
      ...(containerBaseName !== '' ? { fileBaseName: containerBaseName } : {}),
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
        (cls) =>
          cls.filePath === c.filePath &&
          // A container is never its own containment match (mirrors findParentName's `sameSpan`
          // exclusion above): without this, a same-named non-nesting pair on adjacent spans --
          // e.g. an HTML `heading` symbol and an unrelated `html_id` symbol that both happen to
          // be named "Overview" -- lets the OUTER one satisfy containment against ITSELF (its
          // own span trivially contains itself), so `Overview.Overview` (the exact qualifier
          // `formatAmbiguity` printed as the retry hint for the html_id candidate, since
          // findParentName resolved its enclosing heading's name to the same string) kept both
          // candidates in scope and reported ambiguous again -- a disambiguation hint that could
          // never resolve the ambiguity it was emitted for.
          !(cls.lineStart === c.lineStart && cls.lineEnd === c.lineEnd) &&
          c.lineStart >= cls.lineStart &&
          c.lineEnd <= cls.lineEnd,
      )
    })
    if (scoped.length > 0) candidates = scoped
  }

  // A bare name that still matches several distinct definitions (no Parent qualifier, or a
  // qualifier that failed to narrow) resolves to `ambiguous` here — the leaf name is what the
  // user must re-qualify, so it is the display symbol for the error's `Parent.<leaf>` labels.
  return finalize(candidates, lookupName)
}

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
    else if (fs.existsSync(resolved)) {
      const gap = symbolExtractorGap(file, resolved)
      if (gap !== undefined) messages.push(gap)
    }
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
    const text = displaySafeJson(
      {
        ...match,
        body: resolveBody(match),
        // The text branch below prepends staleWarning's DELETED line; without this the JSON form
        // would be the one surface that still passes a deleted file's body off as a live read.
        ...(fileIsGone(match.filePath) ? { deleted: true } : {}),
        ...(refCounts !== undefined ? { refCount: refCounts.get(match.name) ?? 0 } : {}),
      })
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
    const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
    recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
    return { text, code: 0 }
  }

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
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
export function resolveAgainstProjectRoot(file: string, projectRoot: string | undefined): string {
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
    const text = displaySafeJson(result)
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
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
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

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
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
  // The path and the one-line context are repo-chosen text quoted into token-goat's own listing row. The `-C` window below is file content and is deliberately left as it is: that is the payload the reader asked for, and this file's read output is unfenced by design.
  const base = `${indent}${displaySafeText(displayPath)}:${ref.line}: ${displaySafeText(ref.context)}`
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
  const refRows: RefEntry[] = []
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
    const scanLimit = queryOpts.limit ?? DEFAULT_QUERY_LIMIT
    let results = applyTypedRefsTier(symbol, file, scanned)
    // Whether the type-based tier filter itself dropped anything, not merely whether it ran: a query where it dropped nothing is still entitled to the exact-total form. Measured before --exclude-tests/--grep can drop further rows of their own, so this reflects only the typed filter's own effect on the scanned window.
    const typedFilterDropped = results.length < scanned.length
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
    // The typed-tier filter is a client-side filter over the same REFS_TOP_SCAN_LIMIT window as --exclude-tests/--grep, so a query where it alone dropped rows can only report a floor too: see refsTotal's doc comment.
    const clientFiltered = opts.excludeTests === true || matchesGrep !== undefined || typedFilterDropped
    let filteredTotal: number | undefined
    if (clientFiltered) filteredTotal = results.length
    if (clientFiltered && opts.top === undefined) {
      results = results.slice(0, opts.limit ?? 100)
    }
    if (results.length > 0) anyFound = true
    refRows.push(...results)
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
        const trueTotal = clientFiltered ? (filteredTotal ?? results.length) : countRefs(queryOpts)
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
        () => refsTotal(clientFiltered, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount, scanLimit),
        'references',
        '--limit',
      )
      if (notice !== null) lines.push(`  token-goat: ${notice}`)
    }
  }
  warnIfFilesStale(refRows.map((r) => r.filePath))
  const fullSourceBytes = refsSearchBaselineBytes(refRows)
  if (opts.json === true) {
    const text = displaySafeJson(jsonOut)
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
  // How full the query window came back, and how big that window was, so a client-side filter drawn from a window that filled can report its count as a floor rather than as a total. See {@link refsTotal}.
  const preScanCount = scanned.length
  const scanLimit = queryOpts.limit ?? DEFAULT_QUERY_LIMIT
  let results = applyTypedRefsTier(symName, defFileHint, scanned)
  // Whether the type-based tier filter itself dropped anything, not merely whether it ran: a query where it dropped nothing is still entitled to the exact-total form. Measured before --exclude-tests/--grep can drop further rows of their own, so this reflects only the typed filter's own effect on the scanned window.
  const typedFilterDropped = results.length < scanned.length
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
  // The typed-tier filter is a client-side filter over the same REFS_TOP_SCAN_LIMIT window as --exclude-tests/--grep, so a query where it alone dropped rows can only report a floor too: see refsTotal's doc comment.
  const clientFiltered = opts.excludeTests === true || matchesGrep !== undefined || typedFilterDropped
  let filteredTotal: number | undefined
  if (clientFiltered) filteredTotal = results.length
  if (clientFiltered && opts.top === undefined) {
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
        emit(displaySafeJson({ items: [], truncated: false, totalCount: 0, hiddenByGrep: preGrepCount }))
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
    // Fetched as rows rather than as a bare existence count, because the defining file's LANGUAGE decides whether an empty result is an answer at all: parser.ts's REF_LANGUAGES walks call sites for nine tree-sitter languages only, and for a file outside that set the refs table is empty by construction. Capped rather than unbounded -- this only needs to know whether every definition of the name sits in a ref-blind language, and a name with more definitions than this cap in a single project is not a case where one more row changes that verdict.
    const defRows = querySymbols({ name: symName, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    if (defRows.length === 0) {
      emitErr(`Symbol not found: ${symName}${unknownSymbolSuggestion(symName, rootDir)}`)
      // Same empty-index note as the "No references found" branch below -- an empty project
      // index makes EVERY symbol look unindexed, so this must still surface the real cause
      // instead of leaving the caller staring at a suggestion-free "not found" for a project
      // that was simply never indexed.
      if (opts.json !== true && isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
      return 1
    }
    // The honesty gate for Bug B: when EVERY file defining this name is in a language whose call sites are never indexed, "No references found" is a statement about token-goat's index that reads as a statement about the code, and agents delete code on the strength of it. Say which it is. Requires all definitions to be ref-blind: a name also defined in TypeScript has had its call sites genuinely searched, so the ordinary message is still the honest one there.
    const defPaths = defFileHint !== undefined ? [defFileHint] : defRows.map((r) => r.filePath)
    const firstDefPath = defPaths[0]
    if (firstDefPath !== undefined && defPaths.every((fp) => !isRefIndexedFile(fp))) {
      emitErr(refBlindLanguageNotice(symName, detectLanguageOfFile(firstDefPath), refsDisplayPath(firstDefPath)))
      return 1
    }
    // The kind half of the same gate, and the one that fires in TypeScript, where the language half correctly never does: `refs` on an interface returns "No references found" today no matter how many files annotate with it, because extractRefs walks value positions only. Checked after the language half so a symbol blind both ways gets the language message, which names a file and is the more actionable of the two. All-or-nothing, and exit 1, matching both the language gate and the ordinary empty result beside it.
    const kindRows = defFileHint !== undefined ? querySymbols({ name: symName, filePath: defFileHint, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT }) : defRows
    const kindVerdict = refBlindKindVerdict(kindRows)
    if (kindVerdict.allBlind) {
      emitErr(refBlindKindNotice(symName, kindVerdict.blindKinds))
      return 1
    }
    emitErr(`No references found for '${symName}'`)
    // A partial answer presented as a whole one is the same defect as a refusal that was not needed: the other definitions were genuinely searched, so the message above stands, but the ref-blind ones it cannot speak for are named rather than dropped.
    if (kindVerdict.blindCount > 0) emitErr(refBlindKindPartialNote(symName, kindVerdict.blindKinds, kindVerdict.blindCount, kindRows.length))
    // Only paid after the query already came back empty, and only in text mode -- this branch
    // already emits plain prose regardless of --json (there's no separate opts.json check
    // here), so there's no JSON envelope to protect either way.
    if (opts.json !== true) {
      if (isIndexEmptyForProject(globalDbPath(), rootDir)) emitErr(emptyIndexMessage(rootDir))
    }
    return 1
  }

  warnIfFilesStale(results.map((r) => r.filePath))
  const fullSourceBytes = refsSearchBaselineBytes(results)

  if (opts.json === true) {
    let payload: RefsJsonEntry
    if (opts.top !== undefined) {
      payload = topFilesJsonPayload(results, opts.top)
    } else {
      // Same "SQL LIMIT applied before totalCount is taken" fix as runRefs's per-symbol branch above.
      // Same --exclude-tests/--grep honest-total reasoning as runRefs's per-symbol branch above.
      const capped = guardJsonRows(results)
      const trueTotal = clientFiltered ? (filteredTotal ?? results.length) : countRefs(queryOpts)
      payload = { items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
    }
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially
    // filtered page carries the count too rather than only the fully emptied one. Spread onto the
    // emitted object rather than into `payload` so both `--top` and per-reference envelopes get it
    // without either shape's interface growing an optional field the other never sets.
    const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
    const text = displaySafeJson({ ...payload, ...(hiddenByGrep > 0 ? { hiddenByGrep } : {}) })
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
  const refsFooter = opts.top !== undefined ? '' : truncationFooter(results.length, opts.limit ?? 100, () => refsTotal(clientFiltered, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount, scanLimit), 'references', '--limit')
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
    lines.push(`${displaySafeText(displayPath)}:`)
    for (const ref of fileRefs) {
      lines.push(`  :${ref.line}  ${ref.context !== '' ? displaySafeText(ref.context) : '(module scope)'}`)
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
 * Why an existing file has no symbol rows when the cause is token-goat rather than the file:
 * no extractor for its type (a named entry in {@link unsupportedLanguageName}, or an
 * unrecognized extension), or a tree-sitter language whose grammar did not load, so only the
 * coarse regex fallback ran. `undefined` otherwise, where "no symbols" is the honest answer.
 */
export function symbolExtractorGap(displayPath: string, resolvedPath: string): string | undefined {
  const ext = path.extname(resolvedPath).toLowerCase()
  const named = unsupportedLanguageName(resolvedPath)
  const language = detectLanguageOfFile(resolvedPath)
  if (named !== undefined || language === 'unknown') {
    const what = named !== undefined ? `${named}, ${ext}` : ext !== '' ? ext : 'no extension'
    return (
      `'${displayPath}': token-goat has no symbol extractor for this file type (${what}), so there are no symbols to list; grep, plain reads and \`token-goat tokens\` still work on it.\n` +
      supportRequestLine(named ?? (ext !== '' ? `${ext} file` : 'this file type'))
    )
  }
  if (TREE_SITTER_LANGUAGES.includes(language) && !isTreeSitterAvailable(language)) {
    return `No symbols found in '${displayPath}', but tree-sitter parsing for this file type (${ext}) is unavailable, so only a coarse regex fallback ran. Run \`token-goat doctor\` for the cause and the fix.`
  }
  return undefined
}

/** The empty-result line for `outline`/`skeleton`: a missing path, a gap in token-goat's extraction, or a file that genuinely declares nothing. */
function noSymbolsMessage(displayPath: string, resolvedPath: string): string {
  // A path that does not exist reads as "this file has no symbols", so a typo or a stale path guess looks like a definitive answer about a real file and the caller stops looking instead of fixing the path. Checked before the language branch: a missing `foo.scala` is a wrong path, not an unsupported extractor. Wording is `exports`/`imports`/`deps`/`test-for`' verbatim, which already close this same gap.
  if (!fs.existsSync(resolvedPath)) {
    return `Could not read: ${displayPath}`
  }
  return symbolExtractorGap(displayPath, resolvedPath) ?? `No indexed symbols found in '${displayPath}'`
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
): { kind: 'confined'; text: string } | { kind: 'empty'; text: string } | { kind: 'ok'; resolved: string; displayRoot: string | undefined; filtered: SymbolEntry[]; preFilterCount: number; refCounts: Map<string, number> | undefined; fullSourceBytes: number; symbolsTruncated: boolean; trueSymbolCount: number | undefined; totalLines: number } {
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

  // Computed from the unfiltered (pre --min-lines/--grep) symbol set, not `filtered`: a narrowing filter can drop the very symbol that reaches furthest down the file, and reporting the total from what's left would then understate the file's real size instead of just the shown symbol count.
  const totalLines = symbols.length > 0 ? Math.max(...symbols.map((s) => s.lineEnd)) : 0

  return { kind: 'ok', resolved, displayRoot: getDisplayRoot(opts.projectRoot), filtered, preFilterCount: symbols.length, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount, totalLines }
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
  return { text: displaySafeJson(payload), code: anyOk ? 0 : 1 }
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
  const { resolved, displayRoot, filtered, preFilterCount, refCounts, fullSourceBytes, symbolsTruncated, trueSymbolCount, totalLines } = prep

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

// ---- outline ----------------------------------------------------------------

/**
 * Character cap for the per-symbol doc annotation in `outline`'s text mode. The `split('\n')[0]`
 * "first line" clip was written for conventional multi-line doc blocks, where line one is a short
 * summary; a single-line `//` doc comment is ONE physical line however long, so without a
 * character cap the "first line" is the entire doc essay and doc text can dominate the outline's
 * bytes (measured ~80% of the output on doc-heavy files, on a command whose purpose is a compact
 * map). This is the ceiling, not the usual cut: {@link clipDocSummary} ends on the first complete
 * sentence and only falls back to a word boundary at this cap when the line has no sentence end
 * inside it. The cap was once described as keeping roughly the first sentence on its own, which
 * measurement did not bear out: cutting here alone left 297 of 448 annotations in this project's
 * source ending mid-clause. The ellipsis marks the cut,
 * and the full text stays one `read`/`brief` on the symbol away. JSON mode is untouched: it carries
 * the full docstring for machine consumers.
 */
const DOC_SUMMARY_MAX_CHARS = 140

/** Shortest prefix of a doc line that is a complete sentence, or `null` when it has no usable sentence end. Skips the two shapes that are not sentence ends however much they look like one: a known abbreviation (`e.g.`) and a single letter (an initial, or `a.` opening a list). The point in a decimal needs no check of its own, because a terminator only counts here when whitespace or the end of the line follows it, and the digits after `0.75` are neither. A sentence shorter than this floor is a fragment like "Not used." that says less than the words after it, so it is passed over in favour of the next candidate. */
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

/** Clip a doc summary line for the outline. A docstring's first sentence is its summary by convention in every language token-goat parses, so that is the cut: it ends on a complete thought rather than mid-clause, and it is usually shorter than the cap as well. Measured over 448 docstrings in this project's own source, cutting here is 10.6% smaller than cutting at {@link DOC_SUMMARY_MAX_CHARS} and raises the share of annotations ending on a complete thought from 151 to 250. It never costs bytes: of the 448, 110 came out shorter and none came out longer. Where no sentence ends inside the cap the previous behaviour stands: cut at the last word boundary before it, or hard-cut a line with no usable space, such as one giant token. An ellipsis marks any text dropped, so a summary that consumed the whole line still passes through byte-identical. */
function clipDocSummary(firstLine: string): string {
  const sentence = firstSentenceEnd(firstLine)
  if (sentence !== null && sentence <= DOC_SUMMARY_MAX_CHARS) {
    return sentence === firstLine.length ? firstLine : `${firstLine.slice(0, sentence)}…`
  }
  if (firstLine.length <= DOC_SUMMARY_MAX_CHARS) return firstLine
  const cut = firstLine.lastIndexOf(' ', DOC_SUMMARY_MAX_CHARS)
  return `${firstLine.slice(0, cut > 40 ? cut : DOC_SUMMARY_MAX_CHARS).trimEnd()}…`
}

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
    // Same overloaded-column guard as the stats flag: a bare parent name is not a doc comment
    // and must not be rendered as one (see hasRealDocstring).
    const docFirst = hasRealDocstring(sym.docstring) ? `  # ${clipDocSummary(sym.docstring.split('\n')[0] ?? '')}` : ''
    const statsStr = formatStatsSuffix(refCounts, sym)
    // outline has no `path:` prefix on the row to hang formatSymbolLocation's check on (the file is named once, in the header above) -- so the notebook marker is appended directly off the same isVirtualIndexedPath/NOTEBOOK_CELL_LINES_SUFFIX pair that helper uses, rather than routing a bare range through it.
    const notebookSuffix = isVirtualIndexedPath(sym.filePath) ? NOTEBOOK_CELL_LINES_SUFFIX : ''
    lines.push(`  ${rangeStr}  ${kindStr}  ${sym.name}  (${bodyLen}ℓ)${docFirst}${statsStr}${notebookSuffix}`)
  }
  const text = guardText(staleWarning(resolved) + lines.join('\n'), 'symbol')
  recordReadStat('outline', fullSourceBytes, text, opts.file)
  return { text, code: 0 }
}

// ---- github pr-slice ---------------------------------------------------------

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

  // Checked after resolution rather than at argument parsing, so it covers both routes into `repo`: the `--repo` flag and the slug derived from the git remote. The remote route is the one that matters, because a repository controls its own `origin` URL and the slug lands in a `gh api` path sent with the user's token.
  if (!isSafeRepoSlug(repo)) {
    emitErr(`"${repo}" is not a plain owner/name repository slug -- pass --repo owner/repo`)
    return 1
  }
  if (!isSafePrNumber(opts.pr)) {
    emitErr(`"${opts.pr}" is not a pull request number`)
    return 1
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
          const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, 0)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} files`)
        } else {
          // Changed-file paths are structured identifiers, not freeform prose, so they are not
          // fenced here the way diff/comments/description text is -- see this file's
          // fenceGithubText doc comment.
          const text = formatFilesSlice(files)
          emitGuarded(text, 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} files`)
        }
        return 0
      }
      case 'diff': {
        const diffText = fetchPrDiff(opts.pr, repo)
        const rawFileDiff = extractFileDiff(diffText, parsed.path)
        if (rawFileDiff === null) {
          emitErr(`No diff found for '${parsed.path}' in PR #${opts.pr}`)
          return 1
        }
        // A committed-then-reverted secret is a well known way one leaks: it survives in the diff even though the file on disk was cleaned up. Redact before fencing/formatting, mirroring hooks_websearch.ts's "redact once, reuse everywhere" discipline.
        const fileDiff = redactSecrets(rawFileDiff).text
        // "Full source" is the whole multi-file PR diff fetched before slicing down to one
        // file's hunk -- see the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(diffText, 'utf8')
        if (opts.json === true) {
          const jsonText = displaySafeJson({ path: parsed.path, diff: fenceGithubFieldIfMatched(fileDiff) }, 0)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} diff:${parsed.path}`)
        } else {
          emitGuarded(fenceGithubText(fileDiff), 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, fileDiff, `${repo}#${opts.pr} diff:${parsed.path}`)
        }
        return 0
      }
      case 'comments': {
        const rawComments = fetchPrComments(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(rawComments), 'utf8')
        // Review comments are authored by anyone with review access; redact body/diffHunk before formatting or fencing, same reasoning as the diff case above.
        const comments = rawComments.map((c) => ({
          ...c,
          body: redactSecrets(c.body).text,
          ...(c.diffHunk !== undefined ? { diffHunk: redactSecrets(c.diffHunk).text } : {}),
        }))
        if (opts.json === true) {
          const fencedComments = comments.map((c) => ({ ...c, body: fenceGithubFieldIfMatched(c.body) }))
          const capped = guardJsonRows(fencedComments)
          const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, 0)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} comments`)
        } else {
          const text = formatCommentsSlice(comments)
          emitGuarded(fenceGithubText(text), 'pr-slice')
          recordReadStat('pr_slice', fullSourceBytes, text, `${repo}#${opts.pr} comments`)
        }
        return 0
      }
      case 'description': {
        const rawDesc = fetchPrDescription(opts.pr, repo)
        // See the `files` case above for the same recordStat rationale.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(rawDesc), 'utf8')
        // Title/body are PR-author-controlled; redact before formatting or fencing, same reasoning as the diff and comments cases above.
        const desc = {
          ...rawDesc,
          title: redactSecrets(rawDesc.title).text,
          body: rawDesc.body !== null ? redactSecrets(rawDesc.body).text : null,
        }
        if (opts.json === true) {
          const fencedDesc = {
            ...desc,
            title: fenceGithubFieldIfMatched(desc.title),
            body: desc.body !== null ? fenceGithubFieldIfMatched(desc.body) : null,
          }
          const jsonText = displaySafeJson(fencedDesc, 0)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} description`)
        } else {
          const text = formatDescriptionSlice(desc)
          emitGuarded(fenceGithubText(text), 'pr-slice')
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

// ---- pdf / image / screenshot ------------------------------------------------

/** The bytes of a PDF the caller named, refused when the file alone is past the input bound. */
async function readPdfBytes(file: string): Promise<Uint8Array> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  return readPdfFileWithinBounds(file)
}

/** Thin async wrapper: reads the PDF off disk and extracts its text. Kept
 * separate from the synchronous run*(opts): number handlers above because
 * pdfjs-dist's parser is async; the caller (cli.ts's cmdPdfExtract) drives
 * it through guard() (which supports async actions) rather than runExit
 * (sync-only). Throws on error, matching this file's extractPdfText
 * contract, rather than returning an exit code. */
export async function runPdfExtractText(file: string, pagesSpec?: string, layout = false): Promise<string> {
  const result = await extractPdfText(await readPdfBytes(file), pagesSpec, layout)
  return result.text
}

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfOutline(file: string): Promise<PdfOutlineEntry[]> {
  return extractPdfOutline(await readPdfBytes(file))
}

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfMeta(file: string): Promise<PdfMeta> {
  return extractPdfMeta(await readPdfBytes(file))
}

/** Thin async wrapper (same rationale as runPdfExtractText above). */
export async function runPdfLocate(
  file: string,
  pattern: string,
  opts: { ignoreCase?: boolean; maxMatches?: number; context?: number; pages?: string },
): Promise<PdfLocateResult> {
  return locatePdfPages(await readPdfBytes(file), pattern, opts)
}

export interface ImageMeta {
  width: number
  height: number
  format: string | null
  bytes: number
  /** Whether token-goat's image engine could read this file's header at all. Named for the fact, not for a library: nothing here is optional any more. */
  decodable: boolean
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
    // The engine read the header and rejected the bytes: a corrupt or truncated image, which is a
    // real error rather than the "cannot read this format" notice at exit 0.
    if (e instanceof ImageDecodeError) {
      throw new Error(`${file} is not a readable image: ${e.message}`, { cause: e })
    }
    throw e
  }
  if (probe === null) {
    return { width: 0, height: 0, format: null, bytes, decodable: false, wouldShrink: false, shrunkBytes: null }
  }
  const shrink = await shrinkImage(data, { sizeThresholdBytes: 0 })
  return {
    width: probe.width,
    height: probe.height,
    format: probe.format,
    bytes,
    decodable: true,
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
export async function runImageText(file: string, lang?: string): Promise<ImageTextResult> {
  if (!fileExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  if (!isImagePath(file)) {
    throw new Error(`Not an image file: ${file}`)
  }
  const data = fs.readFileSync(file)
  const ocr = await ocrImage(data, lang)
  if (ocr === null) {
    // A null result means "engine not installed" only when the engine is genuinely absent. If it
    // is present, OCR ran and produced nothing for this input -- a corrupt image, a timeout, an
    // offline model fetch -- which must not be reported as a missing dependency at exit 0.
    // An integrity refusal is not one of those three, and the engine is installed, so it would
    // otherwise be reported as a bad image. Name it instead: the model was discarded, the input was
    // fine, and the next run starts from a cold cache and re-downloads from the pinned source.
    if (ocrIntegrityFailed()) {
      throw new Error(`${file} was not OCRed: the cached language model failed its checksum and was discarded, so the next run re-downloads it`)
    }
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
    const jsonText = displaySafeJson(result)
    if (opts.suppressStat !== true) recordReadStat('brief_view', fullSourceBytes, jsonText, opts.spec)
    return { text: jsonText, code: 0 }
  }

  const body = resolveBody(match)
  const bodyLen = match.lineEnd - match.lineStart + 1
  const lines: string[] = [
    // This header is token-goat's own line quoting a repo-chosen name, kind and path, so it is escaped. `body` below it is the source the reader asked for and stays byte-for-byte.
    `# ${displaySafeText(match.name)}  ${displaySafeText(match.kind)}  ${formatSymbolLocation(displaySafeText(toDisplayPath(rootDir, match.filePath)), match.lineStart, match.lineEnd)}`,
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
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
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
  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
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

/** Normalizes a realpath to one comparable spelling: forward slashes via {@link normalizePath}, plus a case fold on win32 where the filesystem is case-insensitive. The fold is ASCII-only -- `toLowerCase()` folds character pairs NTFS keeps apart, which lets a genuinely separate directory compare equal to the root; see `foldCaseForContainment`. */
function foldRealpath(p: string): string {
  const n = normalizePath(p)
  return process.platform === 'win32' ? foldCaseForContainment(n) : n
}

/** Handle ``token-goat grep <pattern>``. */
export function runGrep(opts: GrepOptions): number {
  // A relative search path must resolve against the SAME base its caller's confinement gate
  // measured it against. The MCP `grep` handler validates each `path` entry with
  // `path.resolve(projectRoot, normalizePath(entry))` and pins that spelling, but this function
  // used to hand the raw string straight to the reader, which resolves it against the server
  // process's cwd. Those two bases diverge whenever projectRoot is not the cwd, which is the
  // ordinary case since the client supplies it per call: `grep(path: ["secret.txt"], projectRoot:
  // "/safe")` was gated as `/safe/secret.txt` -- absent, so ABSENT_PIN -- and then opened
  // `<cwd>/secret.txt`, whose pin key never matched, so the identity check degraded to an unpinned
  // raw read and the file's contents came back. Anchoring here makes the value used identical to
  // the value checked, which is the confinement invariant `confineTargets` documents. The CLI
  // passes no projectRoot, so its paths stay cwd-relative exactly as before.
  //
  // Only a RELATIVE entry is anchored. An absolute one has no base to be ambiguous about, and
  // rewriting it would change nothing but its spelling -- `normalizePath` lower-cases the drive
  // letter, which two tests caught immediately by comparing reported paths byte for byte. An
  // absolute entry that points outside the root is the gate's business, not this function's, and
  // the gate refuses it before the search ever starts.
  const anchorSearchPath = (p: string): string => (opts.projectRoot === undefined || path.isAbsolute(p) ? p : path.resolve(opts.projectRoot, p))
  const searchPaths =
    opts.path === undefined
      ? [opts.projectRoot ?? process.cwd()]
      : (Array.isArray(opts.path) ? opts.path : [opts.path]).map(anchorSearchPath)
  const maxLines = opts.maxLines ?? GREP_MAX_LINES
  const contextLines = opts.context ?? 0

  // Refused, not merely reported: an unbounded backtracking pattern cannot be interrupted once
  // `test` has started, and the MCP server that reaches here is single-threaded, so one line of
  // ordinary-looking text would take every other tool down with it. See regex_guard.ts.
  const guarded = compileGuardedRegex(opts.pattern)
  if (!guarded.ok) {
    emitErr(`Invalid regex: ${opts.pattern} -- ${guarded.reason}`)
    return 1
  }
  const regex = guarded.re

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
      // `hit.line` is a line in the file the search read; a virtual-indexed file's symbol ranges are lines in the flattened cell source. Asking which symbol encloses a JSON line is asking the question in the wrong document: it answered null for every notebook hit, and could as easily have named whichever symbol happened to span that number. Refused explicitly, with one note per file below, so the blank label is an answer rather than an absence.
      const enc = isVirtualIndexedPath(hit.file) ? null : enclosingSymbol(syms, hit.line)
      hit.symbol = enc === null ? null : { name: enc.name, kind: enc.kind, lineStart: enc.lineStart, lineEnd: enc.lineEnd }
    }
    // One line per affected file rather than a tag on every hit: a notebook with fifty matches would otherwise repeat the same sentence fifty times.
    for (const file of new Set(truncated.map((h) => h.file).filter(isVirtualIndexedPath))) {
      emit(virtualIndexedScopeNote(displaySafeText(file), 'a match in it cannot be attributed to a symbol and these hits carry no label'))
    }
  }

  if (opts.json === true) {
    // Same {items, truncated, totalCount} envelope guardJsonRows uses for symbol/refs/skeleton/
    // outline's --json mode -- a bare truncated array here would silently hand a JSON consumer
    // fewer hits than actually matched with no way to tell "capped by --max-lines" apart from
    // "there just weren't more".
    const payload: JsonRowCapResult<GrepHit> = { items: truncated, truncated: hits.length > maxLines, totalCount: hits.length }
    emit(displaySafeJson(payload))
    return 0
  }

  for (const hit of truncated) {
    const symbolTag = opts.symbol === true && hit.symbol != null ? ` [${hit.symbol.name} (${hit.symbol.kind})]` : ''
    if (hit.context !== undefined) {
      // Same renderer `refs`/`callers` `-C` use, so the three cannot drift into different dialects.
      for (const line of renderContextWindow(hit.file, hit.line, hit.context, symbolTag)) emit(line)
    } else {
      // The path is token-goat's own row framing and is escaped. `hit.text` is the matched source line, the payload the reader asked for, and stays byte-for-byte.
      emit(`${displaySafeText(hit.file)}:${hit.line}: ${hit.text}${symbolTag}`)
    }
  }

  if (hits.length > maxLines) {
    emitErr(`... (${hits.length - maxLines} more lines omitted)`)
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
      return { text: displaySafeJson({ error: message }), code: 1 }
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
        return { text: displaySafeJson({ error: message }), code: 1 }
      }
      return { text: message, code: 1 }
    }
  }
  const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })

  // Same flag that gates embedding at index time (parser.ts, worker.ts) must also gate it here at query time, or TOKEN_GOAT_EMBEDDINGS_ENABLED=0 -- read by every other embedding-adjacent path in this codebase, including memory_prune.ts's tryEmbeddingClusters -- does nothing for `semantic`: embeddingModelAvailable() below only checks whether the optional onnxruntime-node runtime is installed, not whether the user opted out, so a disabled-but-installed runtime would still call searchSemantic, which calls embedTexts, which downloads the ~34 MB model on a cold cache regardless of this setting. Checked once here so both the availability warning below and the searchSemantic call are skipped together.
  const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true

  // Real embedding-vector similarity search: chunks/chunk_vectors are populated during indexing whenever indexing.embeddings_enabled is on and the optional onnxruntime-node and sqlite-vec dependencies are present -- searchSemantic degrades to an empty array rather than throwing when either is unavailable or nothing has been embedded yet, so this is always safe to try; BM25 (below) is now ALWAYS consulted too, never gated on this returning zero hits, since a single weak dense hit used to make an exact BM25 keyword match unreachable.
  // Over-fetch a larger candidate set (same ratio searchSemantic already uses internally for its own ANN over-fetch) so mergeNearbyHits has headroom to consolidate nearby/overlapping hits in the SAME file before truncation, instead of merging an already-capped set of `n` raw hits — which can silently drop a hit that would have merged, or shrink the result below `n`.
  // Say what the user is actually getting when the embedding model is absent. This is the default
  // state now: the inference runtime is opt-in rather than something every install receives, so
  // that a feature most installs never invoke does not put a 34 MB native addon on every machine.
  // The result is a real degradation that produces no error and no empty result -- BM25 below
  // still answers -- which is precisely the kind of quiet change nobody discovers. Stated here
  // rather than inside searchSemantic because only this function knows the keyword pass runs, and
  // the message there claimed the whole feature was off while printing above genuine keyword hits.
  if (embeddingsEnabled && !embeddingModelAvailable()) {
    console.warn(
      'Matching on meaning is off (onnxruntime-node is not installed); these results come from keyword search alone. ' +
        'Install it with: npm install -g onnxruntime-node (drop -g if token-goat is a project dependency)',
    )
  } else if (!embeddingsEnabled) {
    console.warn(
      'Matching on meaning is off (indexing.embeddings_enabled / TOKEN_GOAT_EMBEDDINGS_ENABLED is disabled); these results come from keyword search alone.',
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
  if (embeddingsEnabled) {
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
  }
  // The dense half contributing nothing is the moment this search is most misleading, because the
  // BM25 pass below still answers and the output looks like a complete result. It is also the only
  // moment worth paying for the coverage query, so it is gated here rather than run every call:
  // with hits, the reader has evidence embeddings are working; with none, they have no way to tell
  // "nothing in your code is similar" from "almost none of your code was ever embedded". Warn only
  // when the model itself is available, since the two branches above already explain that case.
  if (rawHits.length === 0 && embeddingModelAvailable()) {
    try {
      // Config read and coverage query both inside the try: this whole block is a diagnostic aid,
      // and a diagnostic that can throw is worse than no diagnostic -- it would turn a search that
      // otherwise answered into a crash.
      const enabled = loadConfig().indexing.embeddings_enabled
      const { indexedFiles, embeddedFiles } = enabled
        ? getEmbeddingCoverage(globalDbPath(), rootDir)
        : { indexedFiles: 0, embeddedFiles: 0 }
      if (indexedFiles > 0 && embeddedFiles < indexedFiles) {
        console.warn(
          `Matching on meaning found nothing, and only ${embeddedFiles} of ${indexedFiles} indexed file(s) in this ` +
            `project have embeddings — these results come from keyword search alone. Run 'token-goat doctor' for why.`,
        )
      }
    } catch {
      // Coverage is a diagnostic aid, never a reason to fail a search that otherwise works.
    }
  }
  const mergedHits = mergeNearbyHits(rawHits)
  // BM25 full-text search over symbol names/bodies/docstrings, over-fetched for the same reason as the dense side above: searchSymbolsFts caps at the DB level via its own SQL LIMIT, so a post-hoc filter (--grep/--exclude-tests) or a post-hoc fusion rank on an already-`n`-capped result would silently under-represent this list relative to the dense one -- always called now (previously gated behind the dense branch returning zero hits), reusing the same OVER_FETCH_FACTOR/MAX_OVER_FETCH ratio the dense branch already uses.
  const overFetchFts = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  const ftsRows = searchSymbolsFts(query, overFetchFts, undefined, rootDir)

  // Fuse both candidate lists with Reciprocal Rank Fusion -- a row is keyed by its enclosing symbol (filePath + name + the symbol's own lineStart) when one is known, since that is the only identity both a dense chunk and a BM25 symbol row can genuinely share; the lineStart component matters because name alone is not unique within a file (e.g. a same-named method on two different classes), and dropping it would silently collapse two distinct symbols into one fused row. A dense hit with no resolvable enclosing symbol falls back to filePath + start line, which an FTS row (always symbol-backed) can never collide with, so it simply stays its own row.
  const fused = new Map<string, FusedSemanticHit>()
  mergedHits.forEach((h, denseRank) => {
    const enclosing = resolveEnclosingSymbol(h.filePath, h.startLine)
    const key = enclosing !== null ? `${h.filePath}::${enclosing.name}@${enclosing.lineStart}` : `${h.filePath}::L${h.startLine}`
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
    const key = `${s.filePath}::${s.name}@${s.lineStart}`
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
  // Measured before the slice. `guardJsonRows` below counts whatever array it is handed, so
  // running it on the already-sliced list made `totalCount` report the number of survivors and
  // `truncated` describe only the overflow guard: `--limit 2` on a 6-match query answered
  // `totalCount: 2, truncated: false`, which is a wrong number rather than a missing one.
  const eligibleCount = filteredHits.length
  const hits = filteredHits.slice(0, n)
  // Both candidate lists are over-fetched to a bound (OVER_FETCH_FACTOR/MAX_OVER_FETCH). When a
  // list came back AT its bound the fused set may itself be clipped, so `eligibleCount` is a
  // floor rather than a total, and the wording below has to say so rather than name a number it
  // cannot stand behind.
  const candidatesClipped = rawHits.length >= overFetchForMerge || ftsRows.length >= overFetchFts

  // Which list(s) actually contributed a candidate decides the reported `source` -- 'hybrid' only when both lists had at least one raw hit (even if they didn't fuse into the same row), never 'embeddings' silently standing in for a result that is partly BM25.
  const hadDense = mergedHits.length > 0
  const hadFts = ftsRows.length > 0
  const source = hadDense && hadFts ? 'hybrid' : hadDense ? 'embeddings' : 'fts'

  // Same multi-file self-heal-and-warn as runAsk/refs above -- `semantic` fuses hits across
  // however many distinct files matched, none of which the caller named as a single spec.
  warnIfFilesStale(hits.map((h) => h.filePath))

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
      // Two independent losses -- the --limit slice above and the overflow guard inside
      // guardJsonRows -- so `truncated` is the OR of both, and `totalCount` is the count before
      // either ran. `totalCountIsFloor` is set only when the candidate over-fetch was itself at
      // its bound, so a consumer can tell an exact total from a lower bound instead of being
      // handed a number that quietly means different things on different runs.
      const limitTruncated = hits.length < eligibleCount
      const text = displaySafeJson({ source, ...capped, truncated: capped.truncated || limitTruncated, totalCount: eligibleCount, ...(candidatesClipped ? { totalCountIsFloor: true } : {}) })
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
    // stderr rather than appended to `text`: this function returns its text to callers that route
    // it to stdout (and to the MCP server in-process), so a notice folded into the payload would
    // become part of the search result itself.
    if (hits.length < eligibleCount) {
      emitErr(`Showing ${hits.length} of ${candidatesClipped ? 'at least ' : ''}${countNoun(eligibleCount, 'match', 'matches')} (raise --limit to see the rest).`)
    }
    recordReadStat('semantic_search', sumFileSizes(hits.map((h) => h.filePath)), text, query)
    return { text, code: 0 }
  }

  // Total number of fused hits that existed BEFORE --grep was applied -- used to distinguish "--grep matched none of the N hits that do exist" (this is a real store that a filter emptied out) from a genuinely empty index/search, per this repo's filtered-store convention (dead/refs/exports/imports all draw this same distinction).
  if (matchesGrep !== undefined && preFilterCount > 0) {
    const notice = grepFilteredToEmptyNotice(preFilterCount, opts.grep ?? '', 'match', 'matches')
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, grepFilteredToEmpty: true, hint: notice.trim() }
      return { text: displaySafeJson(payload), code: 0 }
    }
    return { text: `token-goat: ${notice.trim()}`, code: 0 }
  }
  // Same distinction one flag over: "--exclude-tests hid every hit there was" is a filtered store, not an empty one, so it exits 0 with a notice naming the count instead of the exit-1 "no matches" below -- checked after --grep so a run with both flags reports the narrower grep story first, matching runRefs's ordering.
  if (opts.excludeTests === true && suppressedTotal > 0) {
    const notice = `no non-test matches for '${query}' (${excludeTestsHiddenNote(suppressedTotal)})`
    if (opts.json === true) {
      const payload = { source: 'fts', items: [], truncated: false, totalCount: 0, excludeTestsFilteredToEmpty: true, hint: notice }
      return { text: displaySafeJson(payload), code: 0 }
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
        const text = displaySafeJson({ source: 'workspace-evidence', ...capped })
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
    const text = displaySafeJson(payload)
    return { text, code: 1 }
  }
  const text = indexEmpty
    ? `token-goat: no matches for '${query}'\n${emptyIndexMessage(rootDir)}`
    : `token-goat: no matches for '${query}'`
  return { text, code: 1 }
}


// ---- notes (note-get / note-list) -------------------------------------------
//
export * from './read_structured_data.js'
export * from './read_git.js'
export * from './read_inspect.js'

export { querySymbols, queryRefs, readSection, listSections, extractSection, runSemantic }
