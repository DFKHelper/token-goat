/** CLI command handlers for surgical-read commands. Ports the public command functions from ``read_commands.py`` to TypeScript. The DB-query layer lives in ``index_reader.ts``; section extraction lives in ``section_reader.ts``.  This module owns argument parsing, output formatting, and the "did you mean?" hint logic. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { SKIP_DIRS, isIgnoredIndexPath } from './baseline.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { querySymbols, queryRefs, queryRefCounts, searchSymbolsFts, getFileEntry, countSymbols, countRefs, DEFAULT_QUERY_LIMIT } from './index_reader.js'
import { indexedSourceText, formatSymbolLocation, isVirtualIndexedPath, virtualIndexedScopeNote } from './indexed_source.js'
import { displaySafeText, normalizePath, resolveIndexPath, toDisplayPath, displaySafeJson } from './paths.js'
import { indexFileSync } from './parser.js'
import { compileGuardedRegex } from './regex_guard.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { dataDir, globalDbPath } from './constants.js'
import { recordKnownRootThrottled } from './known_roots.js'
import { LARGE_SYMBOL_LINE_THRESHOLD } from './hints/file_type_handler.js'
import { extractExportNames, extractImports, importsExtensionFor } from './import_export_extract.js'
export { extractExportNames, extractImports, importsExtensionFor }
import { getDb, isReadOnlyDb } from './db.js'
import { fileIsAbsent, fingerprintFile } from './fingerprint.js'
import { searchSemantic, mergeNearbyHits, OVER_FETCH_FACTOR, MAX_OVER_FETCH, isAvailable as embeddingModelAvailable, checkEmbeddingPreflight, type SearchHit } from './embeddings.js'
import { searchEvidenceSemantically } from './evidence_cache.js'
import { readSection, listSections, extractSection } from './section_reader.js'
import { decodeSource, runGit, PER_FILE_COUNTERFACTUAL_CEILING, foldCaseForContainment, compileGrepMatcher, grepFilteredToEmptyNotice, excludeTestsHiddenNote, countNoun, requirePositiveStrictInt, extractErrorMessage, isTestFile } from './util.js'
import { buildContextWindow, renderContextWindow, type SourceContextLine } from './util_context.js'
export { requireNonNegativeStrictInt } from './util.js'
import { emit, emitErr } from './emit.js'
import { UNBOUNDED_QUERY_LIMIT } from './query_limits.js'
import { getDisplayRoot, resolveProjectRoot } from './project.js'
import type { SymbolEntry, RefEntry } from './parser_types.js'
import { loadConfig } from './config.js'
import { fenceUntrustedContent, UNTRUSTED_GITHUB_TAG } from './injection_scan.js'
import { redactSecrets } from './secret_redact.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { isRefIndexedFile, refBlindLanguageNotice, refBlindKindNotice, refBlindKindPartialNote, REF_BLIND_DEF_PROBE_LIMIT } from './ref_blindness.js'
import { detectLanguageOfFile } from './parser_types.js'
import { enclosingSymbol, ALL_SYMBOLS_IN_FILE_LIMIT, refBlindKindVerdict } from './graph_commands.js'
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
import { canShrinkFormat, isImagePath, probeImageMeta, shrinkImage, ImageDecodeError } from './image_shrink.js'
import { ocrImage, isTextHeavy, isOcrEngineAvailable, ocrIntegrityFailed } from './image_ocr.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { deliveredOutputBytes } from './delivery_cap.js'
import { forEachSymbol } from './symbol_scan.js'
import { isTsPath, resolveTypedRefs } from './ts_refs.js'
import { isIndexEmptyForProject, emptyIndexMessage, getEmbeddingCoverage } from './index_health.js'

// ---- constants --------------------------------------------------------------

import {
  DIDYOUMEAN_LIMIT,
  didYouMean,
  findStructuredKeyPath,
  formatBareNameSpecError,
  formatCrossFileLead,
  rankSimilarNames,
  trimBlankLines,
  unknownSymbolSuggestion,
} from './read_suggest.js'
import {
  confinedProjectRoot,
  confinementRefusal,
  formatAmbiguity,
  isProjectRootAllowed,
  parseColonLineRange,
  parseColonLineSpec,
  parseCrossFileMultiSpec,
  parseLineRange,
  parseReadSpec,
  resolveSymbolSpec,
  runLineRange,
  runLineRegion,
  stripHtmlIdSpelling,
} from './read_spec.js'
import {
  formatStatsSuffix,
  hasRealDocstring,
  previewLines,
  symbolExtractorGap,
} from './read_meta.js'

/** Body lines shown per `symbol` match before the preview is cut and the cut is announced. */
const SYMBOL_PREVIEW_LINES = 5
const GREP_MAX_LINES = 200
// Symbol rows scanned when matching `find <pattern>` by substring — large enough to cover this tool's own index (thousands of symbols) without paging.
export const FIND_SCAN_LIMIT = 20_000

// `refs --top`, `--exclude-tests` and `--grep` all narrow the resolved set in JavaScript AFTER the query returns, and `--top` additionally aggregates by file before truncating. queryRefs orders rows by file_path then line -- alphabetical, not count-based -- so any finite cap ahead of those steps drops every ref in alphabetically-later files regardless of how many they hold, producing a "top files by reference count" that is really "top files among whichever sort first alphabetically", and an --exclude-tests/--grep page selected from a prefix of the matches instead of from all of them.
//
// This was a cap of 100 before, then 20,000 with a comment calling it "large enough to cover any realistic single-symbol fanout". Measured against the live index that belief was false by 7.2x: `expect` has 143,666 references, `toBe` 62,841 and `test` 52,484, with four more names past the window. `refs expect --top 8` therefore ranked the alphabetically-first 13.9% of the rows and reported a top file of 695 references while the real leader held 1,571 and never appeared; for `push --exclude-tests`, 2,459 of 17,484 genuine non-test references (14.1%) sat past the window and were unreachable at any --limit. A bigger finite number would only move the project size at which that recurs, so these paths scan unbounded and the cap is gone rather than raised.

// ---- helpers ----------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** Thrown when the identity of the file actually opened does not match the identity captured when that path was validated -- i.e. the object behind the path was swapped between check and use. This is deliberately NOT swallowed by the `catch { return null }` fallbacks around it: a silent "could not read" would make a detected confinement bypass indistinguishable from a missing file. */
export class ConfinementIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfinementIdentityError'
  }
}

// Identity pins for the confined read currently executing, keyed by canonical absolute path. Null for every CLI caller, which is the default: the optional chaining in the read helpers below short-circuits before pinKey() runs, so the non-MCP path costs exactly zero extra syscalls and zero extra work.
let activePins: ReadonlyMap<string, string> | null = null

/** Sentinel pin value for a target the confinement gate validated as in-root but could not stat (missing, or any other stat failure) at validation time -- so there is no dev:ino to pin. Absence of a map entry means "confinement is off" or "this path was never gated"; this sentinel is the distinct third state, "confined, in-root, but unpinnable", so a missing map entry can no longer be misread as "unconfined" by a pin-aware read helper. Never collides with a real fileIdentity() value, which is always `${bigint}:${bigint}` (digits and a colon only). */
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

/** Opens `p`, verifies the OPENED DESCRIPTOR's identity against `pinned`, and returns its bytes. Checking the descriptor rather than the path is the whole point: the confinement gate validated a path, and between that check and this open the path can be repointed at something outside the root. fstat answers "what did I actually open", which a second path-based stat cannot. */
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

/** Verifies `p`'s CURRENT identity (via an open+fstat, same technique as {@link readPinnedBytes}) matches `pinned`, without reading any content -- used for directories, where `readPinnedBytes` itself cannot be reused because `fs.readFileSync` on a directory fails with EISDIR. Throws {@link ConfinementIdentityError} on a mismatch; returns normally when it matches. */
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

/** Verifies a target pinned as {@link ABSENT_PIN} is STILL absent from disk. Throws {@link ConfinementIdentityError} when something now exists at `p` -- the create-after- validated-absent race the negative pin exists to catch (an attacker names an in-root path that does not exist yet, waits for the gate to validate it as absent-but-in-root, then creates an out-of-root symlink there before the read runs). Returns normally when still absent, which the caller then treats exactly like the pre-existing "no pin recorded" missing-file path. */
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

/** Pin-aware wrapper around `indexFileSync`, used by every read-command call site that can trigger a mid-request reindex (healStaleIndex's self-heal, and each command's `--force-refresh`). Without this wrapper, `indexFileSync` opens `resolvedPath` with its own independent `fs.readFileSync`, which never consults `activePins` -- an MCP caller's confinement pin, validated once against the path before the read command runs, is silently bypassed the moment a stale-index heal or forced reindex kicks in, so a path swapped (e.g. an in-root symlink repointed) between validation and that reindex is never caught. When a pin exists for `resolvedPath`, this verifies it via the same fstat-identity check `readFileBytes` uses (a ConfinementIdentityError propagates up exactly like every other pinned read), then hands the already-verified bytes straight into `indexFileSync` so it never reopens the path itself. With no active pin (every CLI caller, and every MCP call with confinement disabled), this is byte-for-byte the pre-existing behavior: indexFileSync does its own read. */
export function indexFileSyncPinned(resolvedPath: string, dbPath: string): void {
  // A read-only index cannot take the reparse, whether a heal or `--force-refresh` asked for it; the caller's staleWarning says the rows are old instead.
  if (isReadOnlyDb(dbPath)) return
  // A heal triggered by a read can be the only thing that ever indexes a project, so register its root here too rather than relying on a later edit or bulk walk. See recordKnownRootThrottled.
  recordKnownRootThrottled(resolvedPath, dataDir(), dbPath)
  const pinned = activePins?.get(pinKey(path.resolve(resolvedPath)))
  if (pinned === undefined) {
    indexFileSync(resolvedPath, dbPath)
    return
  }
  if (pinned === ABSENT_PIN) {
    // Throws if something now exists (the race); otherwise mirrors indexFileSync's own ENOENT handling -- nothing to reindex.
    verifyStillAbsent(resolvedPath)
    return
  }
  let bytes: Buffer
  try {
    bytes = readPinnedBytes(resolvedPath, pinned)
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
    // Once a pin exists, never retry through the unpinned indexFileSync -- that would reopen `resolvedPath` itself with a fresh, unverified fs.readFileSync, exactly the bypass the pin exists to prevent. ENOENT is the one expected failure (the file was genuinely deleted since validation): return cleanly, mirroring indexFileSync's own ENOENT handling. Any other open failure (permission denied, replaced by a directory/device, etc.) is treated as a confinement refusal instead of silently falling back to an unverified raw read.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ConfinementIdentityError(
      `refused: "${resolvedPath}" could not be opened for pinned re-index (${err instanceof Error ? err.message : String(err)}). ` +
        'The file may have changed since validation, so the read was not performed.',
    )
  }
  indexFileSync(resolvedPath, dbPath, bytes)
}

/** Read a file's text for display. Every read command that prints file content comes through here, which is why the dotenv redaction sits at this seam rather than in each command: `read`, `symbol` and the rest print a slice of a live disk read, and the symbol table they slice against stores env keys with empty bodies precisely because the values are not the model's business. A future read command gets the same protection without having to remember it. Nothing here writes back to disk, so redacting the returned text cannot corrupt a file. See dotenv_redact.ts. */
export function readFileText(p: string): string | null {
  const pinned = activePins?.get(pinKey(path.resolve(p)))
  try {
    if (pinned === ABSENT_PIN) {
      verifyStillAbsent(p)
      return null
    }
    // decodeSource, not a plain utf-8 read: a UTF-16 file (what PowerShell 5.1 writes by default) decodes to NUL-interleaved mojibake that is twice the size and useless to a reader.
    if (pinned !== undefined) return redactIfDotenv(p, decodeSource(readPinnedBytes(p, pinned)))
    return redactIfDotenv(p, decodeSource(fs.readFileSync(p)))
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
    return null
  }
}

/** Raw-bytes counterpart to {@link readFileText}, for binary formats (zip-format archives) that must never be decoded as UTF-8 before parsing -- decoding first would corrupt any byte sequence that isn't valid UTF-8, which is the common case for compressed/binary member data. The only callers are `zip-list`/`zip-read`, so the `MAX_ZIP_INPUT_BYTES` cap lives here rather than in a general-purpose helper: this file's ZIP entries get decompressed downstream, and DEFLATE's worst-case ~1032:1 ratio makes the on-disk (compressed) size the one lever available to bound before any decompression happens at all (see zip_bounds.ts for the decompressed-side bound). The unpinned path stats before reading, so an oversized file is never pulled into memory; the pinned path reads via the fd `readPinnedBytes` already opened for its identity check and rejects by the bytes actually returned; a compressed-input size cap does not carry the same unbounded-allocation risk decompression does, so reading up to the limit before rejecting on that path is an acceptable trade against duplicating `readPinnedBytes`'s fd handling. */
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

/** True when re-encoding `buf`'s lossy UTF-8 decode reproduces the exact original bytes -- i.e. `buf` is valid UTF-8 text, not binary data that merely decodes without throwing (Node's UTF-8 decoder never throws; it substitutes U+FFFD for invalid sequences instead). */
export function isValidUtf8(buf: Buffer): boolean {
  return Buffer.compare(Buffer.from(buf.toString('utf-8'), 'utf-8'), buf) === 0
}

/** Symbols indexed with an empty stored `body` (e.g. HTML/Liquid heading symbols produced by `sectionsToHeadingSymbols`, which store `body: ''`) need their content re-read from disk by line range instead of rendering blank. Shared by runSymbol, runRead, and runBrief so all three read surfaces resolve empty-body symbols the same way. */
export function resolveBody(entry: { body: string; filePath: string; lineStart: number; lineEnd: number }): string {
  if (entry.body !== '') return entry.body
  const source = readFileText(entry.filePath)
  if (source === null) return entry.body
  return indexedSourceText(entry.filePath, source)
    .split(/\r?\n/)
    .slice(Math.max(0, entry.lineStart - 1), entry.lineEnd)
    .join('\n')
}

// The one-line warning prepended by staleWarning() when the on-disk file has changed since the index last saw it. Reuses fingerprintFile/files.sha -- the same sha the worker's dirty-queue gate (makeIndexer in worker.ts) compares against -- so "stale" here means exactly what it means there, rather than reinventing a second freshness signal.
const STALE_WARNING =
  "⚠ STALE: index is older than the file on disk (worker hasn't reindexed yet — retry shortly, or read the file directly)"

// STALE_WARNING's form for a run that reads the index without writing it (see db.ts's allowReadOnlyIndex): no reindex can land, so retrying would return the same old rows.
const STALE_READ_ONLY_WARNING = '⚠ STALE: index is older than the file on disk and cannot be updated this run (the index is read-only here), so read the file directly'

// Prepended instead of STALE_WARNING when the file is not on disk at all. fingerprintFile returns null for "deleted" and for "there but unreadable right now" alike, and staleWarning used to treat both as "nothing to say" -- so a read of a deleted file returned its indexed body, byte-identical to a live read, exit 0, with no sign the file was gone. That is the worst shape this tool can take: the caller goes on to edit or quote a file that no longer exists. Only a genuine absence gets this line; a lock or permission error still falls through silently, because that file really is still there and the index really may still match it.
const DELETED_WARNING =
  '⚠ DELETED: this file is no longer on disk — what follows is what the index last saw of it'

// The same fact as a suffix rather than a banner, for surfaces that render one line per match and cannot put a whole-output warning at the top without it applying to every hit. Shares the '⚠ DELETED' prefix so callers (and tests) have one marker to look for.
const DELETED_TAG = '⚠ DELETED: file no longer on disk'

// The STALE counterpart of DELETED_TAG, for a result row whose file changed on disk and whose reindex was attempted and failed. A per-row suffix for the same reason DELETED_TAG is one: a bare `symbol NAME` spans every indexed project, so one hit can be current and the next one not.
const STALE_TAG = '⚠ STALE: file changed on disk and could not be reindexed'

/** Shared empty set for the common path where nothing was left stale, so the ordinary lookup allocates nothing. */
const EMPTY_PATH_SET: ReadonlySet<string> = new Set<string>()

/** Is `absPath` gone from disk? Used to tag index rows that outlived their file. Absolute paths only. A bare `symbol NAME` searches every indexed project, so a relative path would be resolved against whatever directory the command happened to run in -- a live file belonging to another project would then read as missing and get labelled deleted. Indexed rows store absolute paths, so this costs nothing in practice; it only refuses to guess when a caller hands over a path whose meaning depends on the current directory. Saying nothing is the right answer there: a false "this file is gone" is worse than the silence this whole change replaces. */
export function fileIsGone(absPath: string): boolean {
  // A relative path would be resolved against the current directory, which for a symbol search spanning every indexed project is the wrong one -- so it is never judged. Past that, fileIsAbsent answers ENOENT and only ENOENT: a file that is present but unreadable stays silent, the same as before.
  if (!path.isAbsolute(absPath)) return false
  return fileIsAbsent(absPath)
}

/** Returns the STALE_WARNING line (plus trailing newline) when `resolvedPath`'s current on-disk SHA-256 differs from the SHA-256 stamped on its `files` row at the time it was last indexed, the DELETED_WARNING line when the file is gone from disk entirely, or '' when they match, the file isn't indexed, or the file is present but momentarily unreadable. Cheap by design: a single fs.readFileSync + hash, not a reparse, so it's safe to call on every read/outline/skeleton/symbol lookup. */
export function staleWarning(resolvedPath: string): string {
  const entry = getFileEntry(resolvedPath)
  // A sha-less row is not an indexed file (see indexMatchesDisk), and it stays quiet here for the same reason entry === null does: "stale" says the index holds an older version of this file, which is a different and more alarming claim than "this file is not indexed", and the caller's own no-symbols message already covers the latter. This is the one place the two cases should agree, so it is deliberately NOT the false-means-stale treatment the other two readers now give a sha-less row.
  if (entry === null || entry.sha === '') return ''
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null) {
    // Separate the two reasons fingerprintFile gives up. Gone from disk is a fact worth saying out loud; unreadable-right-now is transient and stays quiet as before.
    return fileIsGone(resolvedPath) ? `${DELETED_WARNING}\n` : ''
  }
  if (diskSha === entry.sha) return ''
  return `${isReadOnlyDb(globalDbPath()) ? STALE_READ_ONLY_WARNING : STALE_WARNING}\n`
}

/** Self-heals a stale index entry instead of just warning about it: on the same SHA mismatch {@link staleWarning} detects, synchronously reparses `resolvedPath` in-process via {@link indexFileSync} -- the exact entry point the worker's dirty-queue drain (worker.ts's makeIndexer) and `--force-refresh` already use, so this shares `writeParseResult`'s single DELETE+INSERT transaction and db.ts's WAL journal mode + 15s busy_timeout. A background worker racing to reindex the very same file just makes whichever write goes second wait for the held lock instead of corrupting either write; no new concurrency handling is needed here. MUST be called before the caller's own DB query (querySymbols/etc.) so a successful heal is picked up by that query automatically -- this function does not itself return or re-fetch any rows. Every call site keeps its existing trailing `staleWarning(...)` call unchanged: once the heal has landed, that check naturally finds the sha now matches and emits nothing, so the surgical-read command just serves fresh data instead of a warning telling the agent to burn a full-file read. On a genuine reparse failure (syntax error, unsupported file type, I/O error) this fails safe -- the stale rows are left in place and the trailing `staleWarning(...)` call falls back to the original warning text unchanged. Also enqueues the dirty-queue path on a successful heal, mirroring `--force-refresh`'s own indexFileSync + enqueueDirtyPathSafe pairing (see that function's doc): indexFileSync always wipes `files.embed_sha`, so semantic search needs the same re-embed signal here too. Best-effort for ordinary parse/I/O failures (never throws for those); a ConfinementIdentityError from the pinned reindex is the one exception -- that signals a detected between-check-and-use swap, and the pinning contract requires a detected replacement to be refused rather than silently treated as an ordinary heal failure, so it is rethrown rather than swallowed. */
export function healStaleIndex(resolvedPath: string): void {
  const entry = getFileEntry(resolvedPath)
  // A read-only index cannot take the reparse (see db.ts's allowReadOnlyIndex), so there is nothing to attempt; the caller's staleWarning still says the rows are old.
  if (isReadOnlyDb(globalDbPath())) return
  // A sha-less row joins the never-indexed case rather than being accepted as a legacy row: no parse writer has ever left that column empty, so the only rows that reach it came from the read-retry counter files used to carry (removed in 2.9.22), which minted a row for a path it had failed to READ. See indexMatchesDisk in index_freshness.ts for the full history. writeParseResult deletes the file's rows before inserting, so parsing here replaces the stub rather than colliding with its primary key.
  if (entry === null || entry.sha === '') {
    // Never indexed. If the file is actually present on disk, parse it once on demand so symbol/read/skeleton/outline can serve a surgical slice instead of returning "no symbols" and forcing the caller to fall back to a full-file Read/grep -- the exact token cost this tool exists to avoid. This is the common case for a project whose background worker never ran (or hasn't caught up) and for a freshly-created/renamed file: real sessions repeatedly hit "not found -> full Read" here. fingerprintFile doubles as the on-disk probe -- it returns null for a missing/unreadable path, so an absent file (or a bare name that resolves to nothing, as in unit tests) is skipped cleanly with no parse and no dirty-queue enqueue.
    if (fingerprintFile(resolvedPath) === null) return
    try {
      indexFileSyncPinned(resolvedPath, globalDbPath())
      enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
    } catch (err) {
      if (err instanceof ConfinementIdentityError) throw err
      // Best-effort: leave it unindexed; the caller emits its normal "no symbols" message rather than crashing a surgical-read command on a parse failure.
    }
    return
  }
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null || diskSha === entry.sha) return
  try {
    indexFileSyncPinned(resolvedPath, globalDbPath())
    enqueueDirtyPathSafe(resolvedPath, { alreadyResolved: true })
  } catch (err) {
    if (err instanceof ConfinementIdentityError) throw err
    // Fail-safe: leave the stale rows in place. The caller's trailing staleWarning(...) call will detect the still-mismatched sha and fall back to the pre-existing warning text -- never let a reparse failure turn a surgical-read command into a hard crash.
  }
}

// Bound on how many of a multi-file command's own result files get a staleness check. `refs`, `ask`, `semantic`, and a Python `trace --bodies` all answer from several rows at once (one per file, not one file the caller named), unlike `symbol`/`read`/`skeleton`/`outline`'s single `staleWarning`/`healStaleIndex` call against the one file the caller asked about. A command returning a hundred hits across a hundred files would otherwise pay a hundred fingerprints (and synchronous reparses) purely for this check; capped here at a number well above what any of these commands' own result limits render in practice, so a normal call never bumps the cap.
const STALE_CHECK_FILE_CAP = 25

/** Self-heal AND warn for a multi-file command's own result set, the sibling of the `healStaleIndex`+`staleWarning` pair every single-file surgical-read command already runs, for the shape `refs`/`ask`/`semantic`/`trace --bodies` have instead: several distinct result files from one query, none of which the caller named directly, so there is no one file to check before the query the way `runSymbol` checks the file in its spec. This answers stale rows exactly as loudly as those commands do -- console.warn rather than folded into the JSON body, so JSON consumers get an unambiguous stdout payload while still seeing the warning on stderr -- rather than the silent behavior these four commands had before: a wrong answer with no warning is worse than a slow one, and warning-then-still-answering is what every single-file command here already does. MUST be called with the files a query's results actually came from, AFTER that query already ran (mirrors `healStaleIndex`'s own contract: it does not re-fetch anything, so healing here only benefits the *next* call to this command, same as the single-file commands above). */
/** Heals the index rows behind a result set whose files the caller never named, and reports whether anything was reindexed so the caller can re-run its query and answer from the fresh rows. This is the self-healing half of what {@link healStaleIndex} gives a command that resolves one named file up front: heal, then query. A command that finds its files only by querying has to do it the other way round, so it has to ask again. A file that is gone from disk is skipped rather than healed. Its rows are what the index last saw, every surface here tags them DELETED per row, and reindexing would delete them -- turning a labelled answer into no answer at all. */
export function healStaleResultFiles(filePaths: readonly string[]): { healed: boolean; stillStale: ReadonlySet<string> } {
  const checked = new Set<string>()
  const stillStale = new Set<string>()
  let healed = false
  for (const raw of filePaths) {
    if (checked.size >= STALE_CHECK_FILE_CAP) break
    if (checked.has(raw) || fileIsGone(raw)) continue
    checked.add(raw)
    if (staleWarning(raw) === '') continue
    healStaleIndex(raw)
    // healStaleIndex is best-effort: a parse error, an unreadable file or a DB error leaves the stale rows in place and says nothing. A single-file command notices because its trailing staleWarning() call runs after the heal; this is that same second look. Without it a failed heal is indistinguishable from a successful one and the caller gets the old body, silently, which is the exact shape of the defect this whole function exists to close.
    if (staleWarning(raw) === '') healed = true
    else stillStale.add(raw)
  }
  return { healed, stillStale }
}

export function warnIfFilesStale(filePaths: readonly string[]): void {
  const checked = new Set<string>()
  let staleCount = 0
  for (const raw of filePaths) {
    if (checked.size >= STALE_CHECK_FILE_CAP) break
    if (checked.has(raw)) continue
    checked.add(raw)
    if (staleWarning(raw) === '') continue
    staleCount++
    // healStaleIndex is best-effort for ordinary parse/I/O failures already; only a detected between-check-and-use path swap (ConfinementIdentityError) is meant to escape it, and that is a real security-relevant condition this wrapper must not paper over either.
    healStaleIndex(raw)
  }
  if (staleCount > 0) {
    const after = isReadOnlyDb(globalDbPath())
      ? 'the index is read-only this run, so these results are from the older version.'
      : 'a reindex just ran, so a repeat of this command will reflect the current version.'
    console.warn(`token-goat: ${countNoun(staleCount, 'file')} behind these results changed on disk since the index last saw ${staleCount === 1 ? 'it' : 'them'} -- ${after}`)
  }
}

export { emit, emitErr }

/** Emit text through the overflow guard: caps output at `config.overflow_guard.max_tokens` (when enabled), appending a truncation marker with a hint tailored to `command`. Mirrors the pre-port Python `_emit_text_result` -> `overflow_guard.guard` call, which capped the same three text paths (read's symbol body, read's line-range slice, and section's heading body) before the TS port dropped the wiring. JSON output paths must never call this — line-based truncation would corrupt the JSON payload. */
export function emitGuarded(text: string, command: string): void {
  emit(guardText(text, command))
}

export function guardText(text: string, command: string): string {
  const cfg = loadConfig()
  return cfg.overflow_guard.enabled ? trimToBudget(text, cfg.overflow_guard.max_tokens, command) : text
}

/** Wrap `text` in an untrusted-content fence under {@link UNTRUSTED_GITHUB_TAG}. A PR's title, description, review comments, and diff are all authorable by anyone who opened the PR or left the comment, so the fence follows that provenance and not the scan result. The scan still runs, purely to name matched pattern(s) in the notice and record the stat. Used by every printed `pr-slice` emit site. The `--json` sites use {@link fenceGithubFieldIfMatched} instead -- see the note there. */
function fenceGithubText(text: string): string {
  return fenceUntrusted(text, UNTRUSTED_GITHUB_TAG)
}

/** Per-field variant for the `pr-slice --json` envelopes, still gated on a scan hit. Fencing the envelope once would be O(1) and provenance-correct, but a fence wrapped around JSON is no longer JSON, and `--json` output is parsed by callers; fencing each field unconditionally instead pays a fixed ~129-byte wrapper per field, which a short comment body or a PR title does not absorb. Same deliberate exception as `fenceFileFieldIfMatched` in cli.ts, and it needs the same wire-format decision to resolve. */
function fenceGithubFieldIfMatched(text: string): string {
  const matches = scanAndRecord(text)
  if (matches.length === 0) return text
  return fenceUntrustedContent(text, matches, UNTRUSTED_GITHUB_TAG)
}

/** JSON-mode counterpart to {@link guardText}: caps a JSON-serializable array at `config.overflow_guard.max_tokens` (when enabled) by dropping trailing whole items rather than truncating text mid-payload. `symbol`/`refs`/`skeleton`/`outline`'s `--json` branches were the one output path the overflow guard didn't reach -- their text-mode siblings already route through {@link guardText}/{@link emitGuarded}, but JSON mode returned the raw, unbounded array. Exported so `graph_commands.ts` (`types`/`callers`/`dead`/`test-for`) builds the same `{items, truncated, totalCount}` envelope from the same helper rather than reimplementing the cap, which is how the two halves of the envelope migration stay byte-compatible. */
export function guardJsonRows<T>(items: readonly T[]): JsonRowCapResult<T> {
  const cfg = loadConfig()
  if (!cfg.overflow_guard.enabled) return { items: [...items], truncated: false, totalCount: items.length }
  return capJsonRows(items, cfg.overflow_guard.max_tokens)
}

/** Sum of on-disk byte sizes for a set of file paths, deduplicated so a command that matched several symbols/refs/hits in the same file only counts that file's size once. Used as the "full source" side of a stat's bytes-saved calculation. Best-effort: a path that no longer exists on disk (stale index entry) or can't be stat'd contributes 0 rather than throwing -- stat recording must never turn a successful read into a hard error. */
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

/** The "full source" side for a search-shaped result: the largest one of the matched files, each capped like sumFileSizes, rather than their sum. A `symbol NAME` or `semantic` result lists matches across files the caller never named, and the alternative it replaces is a search followed by a read of the file wanted, not a read of every file that matched: summing them credited one `symbol main` lookup 1.92M tokens on a real ledger, the same overstatement `refs` was corrected for. One file is the lower bound the result can prove; a caller who names several files (`read a::x,b::y`) still gets sumFileSizes, since each named file is a read the call replaced. */
export function largestFileSize(filePaths: Iterable<string>): number {
  let largest = 0
  for (const fp of new Set(filePaths)) {
    try {
      largest = Math.max(largest, Math.min(fs.statSync(fp).size, PER_FILE_COUNTERFACTUAL_CEILING))
    } catch {
      // Stale index entry pointing at a deleted/moved file — contributes nothing.
    }
  }
  return largest
}

/** Counterfactual byte cost of the search `refs` replaces: one `path:line: label` hit line per reference, the shape `grep -n <symbol>` prints. This is deliberately NOT sumFileSizes over the files those references live in: nobody reads forty files end to end to find call sites, they run a search, so crediting `refs` with those files' whole contents overstated a multi-file result by orders of magnitude (a real ledger showed ~466KB claimed per `refs` event, because the 100KB-per-file ceiling in sumFileSizes bounds each file and never the sum). Deliberately a LOWER bound on what the equivalent search would emit, and only a lower bound: `ref.context` is the short enclosing-symbol label refs renders, where a grep hit line carries the whole matched source line, and a textual grep also returns comments, strings and unrelated same-named symbols that are not references at all. Neither of those is knowable without re-reading every hit file, so the ledger claims only what it can prove from rows already in hand. Requested `--context` lines are excluded for the same reason they cannot earn credit: they are extra output the caller asked for on top of what the plain search prints. That search is one shell command, so its output is priced the way every shell saving is, by what the harness would have delivered of it (deliveredOutputBytes): a 10MB hit list reaches the model as a 2KB preview, not 10MB, and a real ledger credited one `refs` call 2.5M tokens by skipping that step. */
function refsSearchBaselineBytes(rows: Iterable<RefEntry>): number {
  let total = 0
  for (const ref of rows) total += Buffer.byteLength(`${refsDisplayPath(ref.filePath)}:${ref.line}: ${ref.context}\n`, 'utf8')
  return deliveredOutputBytes(total)
}

/** Records a surgical-read stat event: bytes saved is the full on-disk source size minus the emitted slice, floored at 1 (mirrors image_shrink.ts's recordStat call and the retired Python read_commands.py's `max(1, saved // 3 + 1)` -- this repo drops the //3 constant-token fudge factor in favor of the same bytes/4 approximation image_shrink already uses, for consistency across every recordStat call site). Fail-soft via recordStat itself: never blocks or fails a read on a stats-recording error. */
export function recordReadStat(kind: string, fullSourceBytes: number, emittedText: string, detail?: string): void {
  const emittedBytes = Buffer.byteLength(emittedText, 'utf8')
  const bytesSaved = Math.max(1, fullSourceBytes - emittedBytes)
  recordStat(kind, bytesSaved, savedTokensFromBytes(bytesSaved), undefined, detail)
}

// Finds the `::` separator in a `file::symbol` or `file::Heading` spec, splitting on the LAST occurrence rather than the first: a file path is far more likely to contain a literal `::` than a symbol/heading name is. Returns -1 when absent, matching `String.indexOf`'s no-match contract so callers can drop straight into their existing `=== -1` checks.
export function findSpecSeparator(spec: string): number {
  return spec.lastIndexOf('::')
}

// Resolves the enclosing symbol for a semantic chunk's line range, keyed off its `startLine`.
//
// Containment rule (documented per the semantic-fields task): a symbol is a candidate only if `symbol.lineStart <= chunk.startLine <= symbol.lineEnd` -- the chunk's START line must fall strictly inside the symbol's own indexed range. This deliberately does NOT use "nearest symbol by start line": a top-of-file chunk (imports/module header, before any symbol starts) would otherwise get wrongly labelled with whatever symbol happens to sit below it, even though it isn't inside that symbol at all. Chunk boundaries don't always align with symbol boundaries (embeddings.ts's chunkFile folds short boundary ranges into neighbors and can merge across gaps), so a chunk may overlap zero, one, or several symbols -- using the START line is the same "does this line belong to a definition" question `read`/`skeleton` already answer elsewhere in this file, and needs no separate end-line/overlap policy.
//
// Among all containing candidates, innermost wins: the smallest range (fewest lines) is preferred, e.g. a method chunk resolves to the method itself, not its enclosing class.
function resolveEnclosingSymbol(filePath: string, chunkStartLine: number): { name: string; kind: string; lineStart: number } | null {
  // No rootDir scope here: filePath alone already narrows to the exact file the hit came from (an absolute path from the embeddings index), so an additional project-prefix filter is redundant and, worse, can spuriously exclude the very row being looked up whenever the stored/queried root strings don't normalize identically (e.g. a symlinked or 8.3-short temp path) -- the same file_path equality check every other exact-file lookup in this file already relies on without a rootDir filter (see the `resolved` lookups above). Unbounded (-1), not a finite cap: querySymbols orders by (file_path, line_start), so a per-file cap on a bare filePath query has no predicate left to combine against and silently drops every symbol past the cutoff -- a generated/data-shaped file with more flat top-level declarations than the old 100,000 cap lost its tail (confirmed with a 100,051-symbol fixture), so a hit landing in the last symbol resolved to no enclosing symbol instead of the real one. Same fix and reasoning as ALL_SYMBOLS_IN_FILE_LIMIT in graph_commands.ts.
  const symbols = querySymbols({ filePath, limit: -1 }, globalDbPath())
  let best: SymbolEntry | null = null
  for (const s of symbols) {
    if (s.lineStart <= chunkStartLine && chunkStartLine <= s.lineEnd) {
      if (best === null || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) {
        best = s
      }
    }
  }
  // lineStart is returned alongside name/kind because the fusion key below needs it: a bare name is not unique within a file (two classes can each define a same-named method), and keying on name alone silently collapses two genuinely different symbols into one Map entry, dropping one.
  return best === null ? null : { name: best.name, kind: best.kind, lineStart: best.lineStart }
}

// ---- symbol lookup ----------------------------------------------------------

export interface SymbolOptions {
  name?: string
  file?: string
  kind?: string
  limit?: number
  json?: boolean
  context?: number
  /** Project root to scope the search to. Defaults to `process.cwd()`; same field name as {@link SemanticOptions.projectRoot}. When `file` is a relative path, this is the base it resolves against. When no `file` filter is given, this also scopes a bare-name search to the given project instead of matching a same-named symbol anywhere across the machine-wide index -- relevant for callers (e.g. an MCP server) whose cwd is not the workspace root. */
  projectRoot?: string
  /** Only list symbols whose NAME matches this pattern, project-wide. Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. Mutually exclusive with `name`: an exact `name` match is already pinned to one identifier, so regex-filtering that same fixed name is never useful. */
  grep?: string
  /** `--exclude-tests`: drop symbols DEFINED in a test file (per isTestFile), matching the flag already on refs/callers/dead/semantic. Opt-in; omitted or false leaves output byte-identical to today. Like `--grep`, this filters client-side, so it forces the over-fetch below -- filtering after the SQL LIMIT would let suppressed test symbols occupy slots ahead of the cutoff and silently under-return. */
  excludeTests?: boolean
  /** `--exclude-vendored`: drop symbols DEFINED under a directory the indexer itself skips (node_modules, dist, site-packages, ... -- the shared `isIgnoredIndexPath` predicate, not a second copy). Older index generations still hold such rows, so a bare name search can answer with a `node_modules/pdfjs-dist/...` definition ahead of the project's own. Opt-in; omitted or false leaves output byte-identical to today. Filters client-side like `--grep`, so it forces the same over-fetch -- filtering after the SQL LIMIT would let vendored rows occupy slots ahead of the cutoff and silently under-return. */
  excludeVendored?: boolean
  /** `--stats`: add a per-result reference count and doc-coverage flag, same shape as read/skeleton/outline's `--stats`. Opt-in; omitted or false leaves output byte-identical to today, and the extra `queryRefCounts` round trip is only paid when this is set. `symbol` is the one command in the family where this matters most for disambiguation -- it can return several same-named candidates across files -- but that is also where its known limitation bites hardest: `queryRefCounts` keys by symbol NAME (project-wide), not by definition site, so several same-named symbols in different files (e.g. under `--grep`) all show the identical count rather than a per-file one. Documented, not fixed, here for the same reason it is not fixed in read/skeleton/outline. */
  stats?: boolean
}

/** Handle ``token-goat symbol <name>``. */
// A destructuring re-bind of an imported name: `const { x } = require('m')`, or the `await import()` form. The parser records one of these as a symbol named `x`, which is true as far as scope goes and wrong as an answer to "where is x defined" -- the definition is in the module being imported from, and this line is a use of it. Matched on the body rather than on `kind` because the kind these land in is `variable`, which is also what a genuine `export const HINT_CATEGORIES = [...]` is: demoting by kind would sink real definitions to fix a shape this regex identifies exactly. Linear-time by construction -- `[^}]*` is bounded by the following `\}` and no quantifier nests inside another.
const IMPORT_BIND_BODY_RE = /^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(/

/** Orders import re-binds after everything else while preserving the incoming order within each group (Array.prototype.sort is stable), so an exact-name lookup leads with a definition when one is present. */
function stableSortImportBindsLast<T extends { body?: string | null }>(rows: readonly T[]): T[] {
  const isBind = (r: T): number => (typeof r.body === 'string' && IMPORT_BIND_BODY_RE.test(r.body) ? 1 : 0)
  return [...rows].sort((a, b) => isBind(a) - isBind(b))
}

export function runSymbol(opts: SymbolOptions): { text: string; code: number } {
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero rows regardless of whether the symbol exists -- silently reporting "no matches" for a symbol that's actually indexed. Reject it explicitly instead of querying with it.
  if (opts.limit !== undefined && opts.limit <= 0) {
    return { text: `--limit must be a positive number, got: ${opts.limit}`, code: 1 }
  }
  // `--grep` IS the query when there is no exact name to anchor on. Combining it with a name is near-useless -- an exact `name = ?` match is already pinned to one identifier, so regex-filtering that same fixed name either matches everything or nothing -- and more likely a caller mistake than real intent, so reject the combination outright rather than silently pick a winner.
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
  const excludeVendored = opts.excludeVendored === true

  // `symbol` is the one read command that searches the machine-wide index by default, which is documented and useful on a personal machine and a disclosure channel on a shared one: from any indexed directory, `symbol --grep .` enumerates every symbol of every project ever indexed here, bodies included, without touching the filesystem -- so a directory sandbox around the agent does not contain it. `indexing.cross_project_symbols = false` confines the command to the project it is run from. The confinement has to cover --project and an absolute --file as well, or the setting is bypassed by the same caller it exists to constrain.
  const baseConfined = confinedProjectRoot()
  const confinedRoot = opts.projectRoot !== undefined && baseConfined !== null && isProjectRootAllowed(opts.projectRoot, baseConfined)
    ? (confinedProjectRoot(opts.projectRoot) ?? baseConfined)
    : baseConfined
  if (baseConfined !== null) {
    const requested = opts.projectRoot
    const projectDenial = requested === undefined || (confinedRoot !== baseConfined)
      ? null
      : confinementRefusal('--project', requested, baseConfined)
    if (projectDenial !== null) return { text: projectDenial, code: 1 }
    if (opts.file !== undefined) {
      const fileDenial = confinementRefusal('--file', resolveIndexPath(opts.file, requested ?? process.cwd()), confinedRoot)
      if (fileDenial !== null) return { text: fileDenial, code: 1 }
    }
  }

  const queryOpts: Parameters<typeof querySymbols>[0] = {}
  if (opts.file !== undefined) {
    queryOpts.filePath = resolveIndexPath(opts.file, opts.projectRoot ?? process.cwd())
    // Self-heal before querying so a stale index serves fresh data instead of a warning.
    healStaleIndex(queryOpts.filePath)
  }
  if (opts.name !== undefined) queryOpts.name = queryOpts.filePath !== undefined ? stripHtmlIdSpelling(opts.name, queryOpts.filePath) : opts.name
  if (opts.kind !== undefined) queryOpts.kind = opts.kind
  // `--grep` filters client-side on NAME (no regex support in SQL) and `--exclude-tests`/`--exclude-vendored` on file path, so none of the three can become a SQL `LIMIT`: filtering after the slice returns however many of the top-N unfiltered rows happen to match, not N matching rows, and N test-file symbols could fill the result set and leave nothing to show, reporting "no matches" for a symbol that is indexed. That was papered over by over-fetching 20,000 rows first, which is a cap all the same -- three indexed projects on the machine this was measured on exceed it -- so the filtered path now walks the whole scope (src/symbol_scan.ts) and keeps only what it will print. The unfiltered path keeps its SQL `LIMIT`, which is exact there because nothing narrows the rows after the query.
  const anyClientFilter = matchesGrep !== undefined || excludeTests || excludeVendored
  // Matches querySymbols's own fallback, so the unfiltered path's SQL `LIMIT` and the filtered path's keep-ceiling stay the same number rather than two spellings of it.
  const effectiveLimit = opts.limit ?? DEFAULT_QUERY_LIMIT
  if (!anyClientFilter && opts.limit !== undefined) {
    queryOpts.limit = opts.limit
  }
  // Only scope a bare-name search to projectRoot; when `file` already pins an exact indexed path there's nothing left to disambiguate across projects.
  if (opts.file === undefined && opts.projectRoot !== undefined) queryOpts.rootDir = opts.projectRoot
  // Confinement supplies the scope the caller left open, so a bare-name lookup with no --project searches this project instead of the whole machine.
  if (opts.file === undefined && queryOpts.rootDir === undefined && confinedRoot !== null) queryOpts.rootDir = confinedRoot

  // One pass over the scope that keeps only the rows this call can print, alongside the exact counts the notices below quote. Both shapes run through it so the filter, the counts and the heal retry stay in one place: a client-filtered call walks every row, a plain lookup takes the single SQL-limited page it always did.
  interface SymbolSweep { kept: SymbolEntry[]; keptCount: number; scanned: number; hiddenByExcludeTests: number; files: Set<string> }
  const runSweep = (): SymbolSweep => {
    const found: SymbolSweep = { kept: [], keptCount: 0, scanned: 0, hiddenByExcludeTests: 0, files: new Set() }
    const take = (s: SymbolEntry): void => {
      found.scanned++
      found.files.add(s.filePath)
      const nameKept = matchesGrep === undefined || matchesGrep(s.name)
      if (nameKept && !(excludeTests && isTestFile(s.filePath)) && !(excludeVendored && isIgnoredIndexPath(s.filePath))) {
        found.keptCount++
        if (found.kept.length < effectiveLimit) found.kept.push(s)
      } else if (excludeTests && nameKept && isTestFile(s.filePath)) {
        // Counted after --grep so the two filters never report the same row twice; only used to explain an empty result below.
        found.hiddenByExcludeTests++
      }
    }
    if (anyClientFilter) forEachSymbol(queryOpts, take)
    else for (const row of querySymbols(queryOpts)) take(row)
    return found
  }

  let sweep = runSweep()
  // A bare `symbol NAME` names no file, so the pre-query heal above never ran for it -- and that is the form `symbol --help` documents first. It answered from stale rows with no warning at all, while `read "file::symbol"` against the same file self-healed and returned the current body: the same data, two documented commands, two different answers. Heal whatever the query actually hit, then ask again.
  let stillStale: ReadonlySet<string> = EMPTY_PATH_SET
  if (opts.file === undefined) {
    const heal = healStaleResultFiles([...sweep.files])
    stillStale = heal.stillStale
    if (heal.healed) sweep = runSweep()
  }
  const preFilterCount = sweep.scanned
  const unordered = sweep.kept.slice(0, effectiveLimit)
  // An exact-name lookup asks where a thing is defined, and `file_path, line_start` answers it by alphabet: `const { ambigProbeFn } = await import('../src/thing.js')` in scripts/ sorts ahead of the real function in src/ purely because "scripts" precedes "src", so the first block a caller reads is an import statement rather than the body it went looking for. Sink the rows that only re-bind an imported name, keeping the query's own order within each group so the existing tie-breaks and paging behaviour are untouched. Nothing is dropped -- every candidate still prints, so a misjudged row costs one position and never an answer, which is the reason this reorders rather than filters. `--grep` listings are deliberately excluded: those are a browse of many different names, where file order is the useful one.
  const results = opts.name === undefined ? unordered : stableSortImportBindsLast(unordered)

  const hiddenByExcludeTests = sweep.hiddenByExcludeTests

  if (excludeTests && sweep.keptCount === 0 && hiddenByExcludeTests > 0) {
    // The symbol IS indexed, just only ever in test files. Saying "No matches" here would be a lie that stops the caller looking; name the filter that hid them instead.
    const label = opts.name ?? opts.grep ?? '*'
    const notice = `no non-test matches for '${label}' (${excludeTestsHiddenNote(hiddenByExcludeTests)})`
    if (opts.json === true) {
      return { text: displaySafeJson({ items: [], truncated: false, totalCount: 0 }), code: 0 }
    }
    return { text: `token-goat: ${notice}`, code: 0 }
  }

  if (matchesGrep !== undefined && sweep.keptCount === 0 && preFilterCount > 0) {
    // The scope (--file/--kind/--project) genuinely has symbols, but --grep matched none of them -- distinct from the `results.length === 0` branch below, which means there was nothing in scope at all. Same "filtered store renders as populated" trap already fixed for types/dead/exports.
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
    // --json callers parse this string as an error message, not human-facing prose -- keep it byte-identical to before and only append the suggestion in text mode.
    if (opts.name !== undefined && emptyIndexRoot !== null) {
      // Same near-name mechanism as `find`: scan the index and match by case-insensitive substring in either direction, so a typo'd or partial name still gets a cheap next step instead of dead-ending into a full-file Read or a wide Grep.
      const rootDir = emptyIndexRoot
      // Walked in full rather than fetched as one capped page: a cap is applied by SQLite, ahead of the name tests below, so a symbol that sorts past it is reported as absent by the very branch whose job is to say it is present but out of scope. Only names, distinct paths and exact hits are retained, none of which grows with the project's symbol count. See src/symbol_scan.ts.
      const exactMatches: SymbolEntry[] = []
      const allNames = new Set<string>()
      const structuredFileSet = new Set<string>()
      forEachSymbol({ rootDir }, (s) => {
        allNames.add(s.name)
        structuredFileSet.add(s.filePath)
        if (s.name === opts.name) exactMatches.push(s)
      })
      // An EXACT name match in this scan cannot be a typo: the caller spelled the symbol correctly and the lookup above only came back empty because a scope filter (--kind/--file) narrowed it away. Reporting that as "Did you mean: alphaOne" for the query `alphaOne` prints a correction byte-identical to what was typed, and pairs it with a "No matches" line that reads as proof the symbol does not exist -- so the caller concludes it is absent and falls back to a full Read. Name the scope that hid it instead.
      if (exactMatches.length > 0) {
        const shown = exactMatches.slice(0, DIDYOUMEAN_LIMIT)
        const where = shown.map((s) => `${s.kind} at ${formatSymbolLocation(toDisplayPath(rootDir, s.filePath), s.lineStart)}`).join('; ')
        const more = exactMatches.length > shown.length ? ` (+${exactMatches.length - shown.length} more)` : ''
        const flags = [opts.kind !== undefined ? '--kind' : null, opts.file !== undefined ? '--file' : null].filter((f): f is string => f !== null)
        const widen = flags.length > 0 ? `drop ${flags.join('/')} to see it` : 'widen the search scope to see it'
        text += `\n'${opts.name}' IS indexed (${where}${more}) -- ${widen}`
      } else {
        // On an empty index `semantic` fails exactly as `symbol` just did, so suggesting it sends the caller into a second dead end before they ever reach the note below that names the real fix. Suppressed only in that case: with any index at all the fallback is still the right next step.
        const candidates = rankSimilarNames([...allNames], opts.name)
        text += candidates.length > 0 ? `\n${didYouMean(candidates)}` : indexEmpty ? '' : `\nTry: token-goat semantic "${opts.name}"`
      }
      // Appended in BOTH branches on purpose: the didYouMean case is exactly the one that needs correcting, since a near-name suggestion ("Did you mean: sql" for `better-sqlite3`) reads as a confident answer and points away from the real one. Candidate files come from the scan already in hand above, so this costs no extra DB round trip.
      const structuredFiles = [...structuredFileSet].sort()
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

  const fullSourceBytes = largestFileSize(results.map((s) => s.filePath))

  // Shared by both the --json payload and the human blocks below, so a caller-supplied projectRoot (or none) resolves the same way for either output mode.
  const symbolDisplayRoot = getDisplayRoot(opts.projectRoot)

  // Only queried when --stats is actually requested, and only after every early-return above -- a zero-result or filtered-to-empty call must not pay for an extra DB round trip. Same call shape as read's single-symbol lookup and prepareSymbolListing's skeleton/outline lookup.
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
      // No SQL regex support, and no SQL notion of "is a test file" either -- `keptCount` is the post-filter count over the whole scope, since the sweep above walks every row rather than a window, so it is the honest total for what --grep/--exclude-tests actually matched. countSymbols(queryOpts) would instead report the pre-filter count of the whole kind/file/rootDir scope, which contradicts the filtered rows below.
      trueTotal = sweep.keptCount
      truncatedFlag = capped.truncated || results.length < sweep.keptCount
    } else {
      // `results` is already truncated by querySymbols's own SQL `LIMIT` (opts.limit, or the default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length) is not the real number of matching symbols -- countSymbols reruns the same filters with no LIMIT to report an honest total, the same distinction json_query's --head already makes (its totalCount survives --head unlike this one used to).
      trueTotal = countSymbols(queryOpts)
      truncatedFlag = capped.truncated || trueTotal > results.length
    }
    // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(symbolDisplayRoot, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json.
    const items = capped.items.map((s) => ({
      ...s,
      filePath: toDisplayPath(symbolDisplayRoot, s.filePath),
      // Only present when true, so a result set of live files stays byte-identical to what this command has always emitted and only the genuinely-gone rows grow a field.
      ...(fileIsGone(s.filePath) ? { deleted: true } : {}),
      ...(stillStale.has(s.filePath) ? { stale: true } : {}),
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
    // Per match, not one banner for the whole result set: a bare `symbol NAME` searches every indexed project, so one hit can be a live file and the next one a checkout that was deleted months ago. A single header line would have to lie about one of them.
    const goneTag = fileIsGone(sym.filePath) ? `  ${DELETED_TAG}` : ''
    const staleTag = stillStale.has(sym.filePath) ? `  ${STALE_TAG}` : ''
    const header = `# ${sym.name} (${sym.kind}) — ${formatSymbolLocation(toDisplayPath(symbolDisplayRoot, sym.filePath), sym.lineStart, sym.lineEnd)}${statsStr}${goneTag}${staleTag}`
    const body = resolveBody(sym)
    const bodyLines = body.split(/\r?\n/)
    const preview = bodyLines.slice(0, SYMBOL_PREVIEW_LINES).join('\n')
    // The header states the symbol's real line span, so a five-line preview of a forty-line function looked like the whole thing was five lines long -- a silent cap of exactly the kind truncationFooter below exists to prevent. Say what was cut and how to get the rest.
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
  // Under a client-side filter the count is only as complete as the FIND_SCAN_LIMIT window the rows were drawn from, so a scan that filled reports its count as a floor rather than as a total.
  const symbolTotal = (): TruncationTotal =>
    anyClientFilter ? { count: sweep.keptCount, exact: true } : { count: countSymbols(queryOpts), exact: true }
  return { text: text + truncationFooter(results.length, effectiveLimit, symbolTotal, 'matches', '--limit'), code: 0 }
}

/** The "you are not seeing all of it" line for a text-mode result set, or an empty string when nothing was dropped. `--json` has always carried an honest `totalCount`; text mode rendered exactly `limit` rows and stopped, which is indistinguishable from "that is all there is" -- `symbol dup` printed 20 definitions of 40 with nothing on stdout or stderr to say so. Same no-silent-caps rule the `refs --top` summary and `json-outline`'s `--head` note already follow. `total` is a thunk because computing it costs another count query, and it is only worth paying when the page came back full: a result set shorter than the limit cannot have been truncated. Appended after `guardText`, so the overflow guard cannot trim off the very line that explains the trimming. */
function truncationFooter(shown: number, limit: number, total: () => TruncationTotal, plural: string, flag: string): string {
  const notice = truncationNotice(shown, limit, total, plural, flag)
  return notice === null ? '' : `\n\ntoken-goat: ${notice}`
}

/** The honest total behind a truncated page. `exact: false` means the count came from a bounded client-side scan (`--grep`, `--exclude-tests`) that itself filled up, so `count` is a floor and not a total: saying "of 20000" there would trade one silent cap for a confident wrong number. */
interface TruncationTotal {
  count: number
  exact: boolean
}

/** The honest reference total for a page of `refs` output. `countRefs` reruns the SQL filters with no LIMIT, which is exact. The client-side filters (`--exclude-tests`, `--grep`, and the typed-refs tier) have no SQL equivalent, so their total is the post-filter count of the window the rows came from: exact only while that window had room to spare, a floor once it filled. `scanLimit` is the window the rows were actually fetched under, which is NOT one fixed number. `--exclude-tests`/`--grep`/`--top` scan unbounded (`UNBOUNDED_QUERY_LIMIT`, negative), an explicit `--limit` sets it, and a query with none of those gets queryRefs' own DEFAULT_QUERY_LIMIT. A negative window never fills, so the client-side filters on those routes saw every matching row and their post-filter count is the exact total rather than a floor -- which is why the sign is tested rather than the count compared against a constant that no longer exists. No CLI path reaches that wrong branch today, and the fix is deliberately not sold as one: {@link truncationNotice} prints nothing unless `shown >= limit` and `count > shown`, and on every route that leaves this window narrow the window IS the display limit, so the post-filter count cannot exceed what was shown. That is a coincidence held together three call frames apart, and it is the whole reason to compare against the window actually used instead: widening a default here, or slicing to something other than the query limit there, silently turns a floor into a claimed total with no test able to see it happen. */
function refsTotal(clientFiltered: boolean, filteredTotal: number | undefined, shown: number, countExact: () => number, preScanCount: number, scanLimit: number): TruncationTotal {
  if (!clientFiltered) return { count: countExact(), exact: true }
  if (scanLimit < 0) return { count: filteredTotal ?? shown, exact: true }
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
  /** `file::symbol`, `file@N-M` / `file@N` (raw line range), `file:N-M` / `file:N` (the region enclosing those lines -- see {@link runLineRegion}), a bare file path, or a comma-separated symbol list (`file::a,b,c`) to fetch several symbol bodies in one call, mirroring `refs`'s multi-symbol grammar. See {@link runReadMulti}. */
  spec: string
  json?: boolean
  contextLines?: number
  forceRefresh?: boolean
  /** Add per-symbol reference count and doc-coverage flag, same as `skeleton`/`outline`'s `--stats`. */
  stats?: boolean
  /** Project root to scope symbol resolution to. Defaults to `process.cwd()`; same field name as {@link SemanticOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g. an MCP server launched from an opaque directory) should pass the actual workspace root explicitly -- otherwise a bare/partial file spec can resolve against the wrong project, or an ambiguous symbol name can match a same-named definition in an unrelated project. */
  projectRoot?: string
  /** Internal only -- set by {@link runReadMulti} on each per-symbol recursive `runRead` call so the single-symbol path skips its own `recordReadStat`. Without this, N symbols from the same file would each record a stat against the full file size, inflating the recorded token-savings by a factor of N for what is really one read. `runReadMulti` records the stat itself, once, for the whole multi-symbol call. Not a CLI/MCP-facing option. */
  suppressStat?: boolean
}

/** Handle ``token-goat read "file::symbol"`` and ``token-goat read "file@N-M"``. */
export function runRead(opts: ReadOptions): { text: string; code: number } {
  const range = parseLineRange(opts.spec)
  if (range !== null) return runLineRange(range, opts)

  // `file:142` / `file:142-160`: a line number is what an agent actually holds at the moment it reads (a grep hit, a stack frame, a diff hunk), and nothing bridged that to the `file::symbol` grammar. Resolved to the enclosing region rather than served as raw lines -- that is the whole point of the form, and it is why it does not just delegate to runLineRange like the `@` spelling does. Checked after `@` and before parseCrossFileMultiSpec, matching the order those two already ran in; parseColonLineSpec declines every spec they handle (a `::` prefix ends in `:`, and a symbol name is not all digits).
  const region = parseColonLineSpec(opts.spec)
  if (region !== null) return runLineRegion(region, opts)

  // Cross-file multi-spec `src/a.ts::alphaFn,src/b.ts::betaFn`. Checked before the single-file `parseReadSpec` below because that function's `lastIndexOf('::')` would otherwise fold the whole spec into one bogus file/symbol pair -- see parseCrossFileMultiSpec for why it declines (and falls through here) on every spec the single-file path already handles correctly.
  const crossFilePairs = parseCrossFileMultiSpec(opts.spec)
  if (crossFilePairs !== null) return runReadMulti(crossFilePairs, opts)

  const { file, symbol } = parseReadSpec(opts.spec)

  // Multi-symbol form: `file::a,b,c`. Guarded against the numeric line-range spec `file::N,M` (parseColonLineRange, consulted a few lines below on a resolution miss) so a comma there is never misread as two symbol names -- `parseColonLineRange(symbol) === null` fails fast for the numeric form and falls straight through to the existing single-symbol path, which still reaches the `::N,M` fallback later exactly as before.
  if (symbol !== undefined && symbol !== '' && symbol.includes(',') && parseColonLineRange(symbol) === null) {
    const multiSymbols = symbol.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    if (multiSymbols.length > 1) return runReadMulti(multiSymbols.map((s) => ({ file, symbol: s })), opts)
  }

  if (symbol === undefined || symbol === '') {
    // Only resolve against projectRoot when explicitly given and the path is relative -- same convention as runSection, so absent-projectRoot CLI behavior stays byte-identical (readFileText resolves a relative path against process.cwd() itself, as the CLI always has). Without this the MCP confinement gate validated `<projectRoot>/x` while this read fetched `<server cwd>/x`: two different files, so a relative spec escaped the workspace.
    const text = readFileText(resolveAgainstProjectRoot(file, opts.projectRoot))
    if (text === null) {
      // A bare name (no `::` at all, as opposed to a `file::` with an empty symbol) that isn't a readable file is very likely a symbol name passed without its `file::` prefix -- "Could not read" would wrongly frame that as a filesystem problem.
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
    // Genuine same-file ambiguity (a bare name matching several classes' methods, or a qualifier that failed to narrow): refuse to guess. The error lists every candidate and the qualified retry syntax instead of silently returning the first-ordered row.
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
    // Ergonomic fallback: `read "file::120-140"` (or `::120:140` / `::120,140` / `::120`) is an agent using the `::` symbol separator for a line range. Serve the lines instead of failing to a sed/full-Read round-trip. Only reached once no symbol matched, so a real definition is never shadowed.
    const lineSpec = parseColonLineRange(symbol)
    if (lineSpec !== null) {
      return runLineRange({ file, start: lineSpec.start, end: lineSpec.end }, opts)
    }
    const messages = [`Symbol '${symbol}' not found in '${file}'`]
    const crossFileLead = formatCrossFileLead('read', symbol, file, opts.projectRoot)
    if (crossFileLead !== '') messages.push(crossFileLead)
    const resolved = resolveIndexPath(file, opts.projectRoot ?? process.cwd())
    // Query a bounded superset (FIND_SCAN_LIMIT, same bound runSymbol's near-name scan uses) scoped to this one file, THEN rank by similarity and cap at DIDYOUMEAN_LIMIT -- capping in the query itself would return an arbitrary storage-order first-N that can omit the actual closest match entirely.
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const closes = rankSimilarNames(scanned, symbol)
    if (closes.length > 0) messages.push(didYouMean(closes))
    // No candidate resembled the query -- point at the command that lists the file's real symbols instead of leaving the miss with no next step.
    else if (scanned.length > 0) {
      if (/\.(yaml|yml)$/i.test(file)) {
        messages.push(`Try: token-goat yaml-outline ${file}\nQuery subtree: token-goat yaml-query ${file} '<path>'`)
      } else if (/\.xml$/i.test(file)) {
        messages.push(`Try: token-goat xml-outline ${file}\nQuery subtree: token-goat xml-query ${file} '<path>'`)
      } else if (/\.json$/i.test(file)) {
        messages.push(`Try: token-goat json-outline ${file}\nQuery subtree: token-goat json-query ${file} '<path>'`)
      } else {
        messages.push(`Try: token-goat outline ${file}`)
      }
    } else if (fs.existsSync(resolved)) {
      if (/\.(yaml|yml)$/i.test(file)) {
        messages.push(
          `'${file}' is a YAML file -- YAML keys below top level are not symbols; inspect structure or query values with:\n  token-goat yaml-outline ${file}\n  token-goat yaml-query ${file} '<path>'`,
        )
      } else if (/\.xml$/i.test(file)) {
        messages.push(
          `'${file}' is an XML file -- inspect structure or query nodes with:\n  token-goat xml-outline ${file}\n  token-goat xml-query ${file} '<path>'`,
        )
      } else if (/\.json$/i.test(file)) {
        messages.push(
          `'${file}' is a JSON file -- inspect structure or query values with:\n  token-goat json-outline ${file}\n  token-goat json-query ${file} '<path>'`,
        )
      } else {
        const gap = symbolExtractorGap(file, resolved)
        if (gap !== undefined) messages.push(gap)
      }
    }
    return { text: messages.join('\n'), code: 1 }
  }

  const match = resolution.entry
  const fullSourceBytes = sumFileSizes([match.filePath])

  // Only queried when --stats is actually requested -- an extra DB round trip the common (non-stats) path shouldn't pay for. Same call shape as prepareSymbolListing's ref-count lookup for skeleton/outline.
  const refCounts =
    opts.stats === true
      ? queryRefCounts([match.name], globalDbPath(), resolveProjectRoot({ project: opts.projectRoot ?? process.cwd() }))
      : undefined

  if (opts.json === true) {
    // Serialize the resolved body, not the raw row. `symbols.body` is stored empty for symbols an extractor emits without text and for any symbol over parser.ts's MAX_SYMBOL_BODY_CHARS (deliberately elided so it can be re-derived here rather than stored truncated). Emitting the row verbatim would hand a JSON consumer `"body": ""` for those, which is the one output shape with no honest signal that the text is available elsewhere -- the text form below already resolves it.
    const text = displaySafeJson(
      {
        ...match,
        body: resolveBody(match),
        // The text branch below prepends staleWarning's DELETED line; without this the JSON form would be the one surface that still passes a deleted file's body off as a live read.
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
  // Appended after the overflow guard, not folded into the guarded lines, so this advisory note never shifts the "showing N of M lines" count the guard reports for the actual body.
  const narrowerSliceHint = bodyLen > LARGE_SYMBOL_LINE_THRESHOLD
    ? `\n# for a narrower slice: token-goat grep "<pattern>" ${file} -C 15 --symbol`
    : ''
  const text = guardText(warning + trimBlankLines(lines).join('\n'), 'symbol') + narrowerSliceHint
  if (opts.suppressStat !== true) recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

/** Handle ``token-goat read "file::a,b,c"`` -- fetch several symbol bodies from one file in a single call, mirroring `refs`'s comma-separated multi-symbol grammar (see {@link parseMultiRefsSpec}). Delegates each symbol to a recursive {@link runRead} call (`suppressStat: true`) rather than reimplementing resolution, so ambiguity handling, not-found + did-you-mean, and JSON shape all come from the exact same code path the single-symbol form already exercises -- a failure to resolve one symbol is reported inline instead of aborting the whole call, same as `runRefs`'s per-symbol handling. */
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
      // Parse the sub-call's JSON string back into an object so the multi envelope nests real JSON per symbol, never an embedded string -- a failed sub-call has no JSON body of its own, so it is represented by its plain-text error instead.
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

/** The base a relative file path resolves against on disk. Resolves against `projectRoot` only when one was explicitly given AND the path is relative: an absolute path, or the no-projectRoot default every CLI caller takes, is returned untouched so those paths stay byte-identical to the long-standing behavior of resolving against `process.cwd()` inside the read helpers themselves. This is the execution-side half of the MCP confinement invariant (see `resolveToolRoot` in mcp_server.ts): the gate admits a relative target by resolving it against the project root, so every disk read on that path must resolve it against the same root or the check guards a different file than the one served. */
export function resolveAgainstProjectRoot(file: string, projectRoot: string | undefined): string {
  return projectRoot !== undefined && !path.isAbsolute(file) ? path.resolve(projectRoot, file) : file
}

// ---- refs -------------------------------------------------------------------

export interface RefsOptions {
  spec: string
  callers?: boolean
  json?: boolean
  limit?: number
  /** Group references by file (count only, no per-line context) and show only the top N files by reference count. For a high-fanout symbol (hundreds of refs across dozens of files -- e.g. a widely-extended base class or widely-implemented interface) the normal per-line output degrades into the unusable wall of text this tool exists to prevent; this mode stays surgical by trading per-line context for a ranked-by-fanout summary. Independent of `--callers`: when both are set, `--top` wins for text output (its summary supersedes the caller-grouped per-line view; the choice is between them, not a composition of both). */
  top?: number
  /** `-C, --context <n>`: lines of real source text to show either side of each reference. The existing per-reference line already answers *where* a symbol is used and names the enclosing symbol, but never shows the call site itself; this adds the surrounding source in `grep -C`'s exact framing (see {@link renderContextWindow}). Defaults to 0, in which case every output byte -- text and JSON alike -- is unchanged. */
  context?: number
  /** `--exclude-tests`: drop references whose call site lives in a test file (per isTestFile). Opt-in; omitted or false leaves output byte-identical to today. */
  excludeTests?: boolean
  /** Only list references whose call-site FILE PATH matches this pattern (rows render as `file:line: symbol`, so this is the field each row is keyed on -- matched against the path as RENDERED under displayRoot, so an anchored `--grep "^src/"` matches what the caller sees; the high-value case is a wide-fanout symbol where that drops test/vendored hits). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. */
  grep?: string
  /** Workspace root to scope this lookup to: resolves the `file::symbol` defining-file hint against, and scopes queryRefs' call-site rows to this root (the same `queryOpts.rootDir` mechanism `symbol` uses) so refs from other projects in the shared global index never surface. Optional and unset for CLI callers, who resolve against `process.cwd()` -- see `resolveAgainstProjectRoot`/`SemanticOptions.projectRoot` for the established convention this mirrors. */
  projectRoot?: string
}

/** One reference rendered as `path:line: <enclosing symbol>` (today's line, always emitted verbatim), optionally followed by its `-C` source window. Shared by all three `refs` rendering paths (single, multi-symbol, cross-file) so `-C` cannot drift between them. */
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

/** Best-effort "exact" tier for `refs`: name-based matching (via `queryRefs`) conflates two unrelated symbols that happen to share a name -- see `ts_refs.ts`'s module doc. When the symbol's definition is unambiguous (exactly one `querySymbols` hit for `symName`/`file`) and is a TypeScript file, this narrows `results` using the TypeScript compiler API's type checker. Always degrades to `results` unchanged when the tier can't apply: ambiguous or missing definition, non-TS definition file, `typescript` unavailable, or any resolution failure. No CLI flag gates this -- it applies silently whenever the file type qualifies, the same best-available-accuracy pattern `embeddings.ts`'s `isAvailable()`-gated semantic tier uses. */
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
/** The root every `refs` query is scoped to. `refs` searches the whole index by symbol NAME, so unlike the file-spec commands it cannot be gated by one path: leaving `rootDir` unset returns reference sites -- path, line and surrounding source context -- from every project on the machine. Falling back to the confining root scopes the search the same way `symbol`'s bare-name path already does. */
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

/** Render references for several named targets, one block (or JSON entry) each. Shared by runRefs's same-file multi-symbol path (`file::a,b`, keyed by bare symbol) and runRefsCrossFile's pair path (`a.ts::x,b.ts::y`, keyed by symbol or by the full `file::symbol` pair). Those were two loops written out separately and kept in step by hand, described in runRefsCrossFile's own docblock as mirroring this one -- same query construction, same `--callers`/`--limit`/`--top`/`--grep`/`--exclude-tests`/`--json` handling, differing only in where each target's `file` and output key come from. Keeping two copies of that in step by hand is how they drift, and they already had (see `annotateHiddenByGrep`). Prints directly and returns a bare exit code rather than `{text, code}`, per runRefs's own existing convention. */
function renderRefsTargets(
  targets: RefsTarget[],
  opts: RefsOptions,
  {
    annotateHiddenByGrep,
  }: {
    /** Whether a JSON entry filtered by --grep carries a `hiddenByGrep` count. True for the same-file multi-symbol path and false for the cross-file one, which is not a design decision but the drift this consolidation found: the fix that added the key was applied to one of the two mirrored loops and not the other, so `refs "a.ts::x,b.ts::y" --json --grep` still cannot tell "--grep matched none of the N that exist" from a genuine absence. Preserved exactly as-is here rather than quietly corrected, because changing what a command emits is not a refactor's call to make; it is now one flag in one place instead of a silent difference a hundred lines apart. */
    annotateHiddenByGrep: boolean
  },
): number {
  // Every entry uses the same envelope shape as the single-symbol `refs`/`symbol`/`skeleton`/ `outline` JSON output ({ items, truncated, totalCount }), whether or not it was truncated — a JSON consumer should never have to branch on shape depending on truncation. `--top` opts into a distinct, deliberately different envelope ({ fileCounts, totalFiles, totalRefs, shown }) since the caller explicitly asked for the grouped summary shape instead.
  const jsonOut: Record<string, RefsJsonEntry> = {}
  let anyFound = false
  const lines: string[] = []
  const refRows: RefEntry[] = []
  for (const { file, symbol, key } of targets) {
    const queryOpts: Parameters<typeof queryRefs>[0] = { name: symbol }
    // The `file` in `file::symbol` names where the symbol is DEFINED, only used to disambiguate a same-named symbol elsewhere in the index via applyTypedRefsTier below. It must never be passed to queryRefs/countRefs -- refs.file_path there is the file a REFERENCE occurs in, not where the symbol is defined, so doing so would wrongly narrow every result (not just --callers) to same-file references only. --grep needs the same full-headroom query as --exclude-tests -- see runRefsSingle's sibling comment.
    if (opts.excludeTests === true || opts.grep !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
    else if (opts.limit !== undefined) queryOpts.limit = opts.limit
    else if (opts.top !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
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
    // The typed-tier filter is a client-side filter over the same window as --exclude-tests/--grep, so a query where it alone dropped rows reports a floor whenever that window was finite: see refsTotal's doc comment.
    const clientFiltered = opts.excludeTests === true || matchesGrep !== undefined || typedFilterDropped
    let filteredTotal: number | undefined
    if (clientFiltered) filteredTotal = results.length
    if (clientFiltered && opts.top === undefined) {
      results = results.slice(0, opts.limit ?? 100)
    }
    if (results.length > 0) anyFound = true
    refRows.push(...results)
    if (opts.json === true) {
      // Same omit-when-zero `hiddenByGrep` the single-spec JSON path emits, per target here: a symbol whose entry is `items: []` because --grep matched none of its references must not be indistinguishable from one that genuinely has none.
      const hiddenByGrep = matchesGrep !== undefined ? preGrepCount - (filteredTotal ?? results.length) : 0
      const withHidden = <T extends object>(payload: T): T => ({ ...payload, ...(annotateHiddenByGrep && hiddenByGrep > 0 ? { hiddenByGrep } : {}) })
      if (opts.top !== undefined) {
        jsonOut[key] = withHidden(topFilesJsonPayload(results, opts.top))
      } else {
        // `results` is already truncated by queryRefs's own SQL `LIMIT` (opts.limit, or the default 100) before guardJsonRows ever sees it, so capped.totalCount (== results.length) is not the real number of matching refs -- countRefs reruns the same filters with no LIMIT to report an honest total (same fix as runSymbol's countSymbols call). Under --exclude-tests or --grep, countRefs has no way to rerun that filter, so filteredTotal (the pre-slice filtered count, already scanned with full headroom above) is the honest total.
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
    // Per target, not once for the whole call: each name has its own total, and a single footer under the last block would read as applying to all of them. `--top` renders its own note.
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
  // A limit of 0 (or negative) would translate to SQL `LIMIT 0`, which always returns zero rows regardless of whether references exist -- silently reporting "no references found" for a symbol that's actually referenced. Reject it explicitly instead of querying with it. Both callers (this multi-symbol path and the single-symbol runRefsSingle it delegates to) are covered by this one check since runRefsSingle is never called from outside this file.
  if (opts.limit !== undefined && opts.limit <= 0) {
    emitErr(`--limit must be a positive number, got: ${opts.limit}`)
    return 1
  }
  // Same reasoning: --top 0 (or negative) is never a meaningful request -- reject explicitly rather than silently rendering an empty summary.
  if (opts.top !== undefined && opts.top <= 0) {
    emitErr(`--top must be a positive number, got: ${opts.top}`)
    return 1
  }

  // Same confinement the file-spec read commands enforce, applied before any query: an explicit --project or an out-of-root file in the spec would otherwise re-open the channel that refsRootDir closes for the bare-name form.
  const baseConfined = confinedProjectRoot()
  const confinedRoot = opts.projectRoot !== undefined && baseConfined !== null && isProjectRootAllowed(opts.projectRoot, baseConfined)
    ? (confinedProjectRoot(opts.projectRoot) ?? baseConfined)
    : baseConfined
  if (baseConfined !== null) {
    const requested = opts.projectRoot
    const projectDenial = requested === undefined || (confinedRoot !== baseConfined)
      ? null
      : confinementRefusal('--project', requested, baseConfined)
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
    // Not annotated today; renderRefsTargets's own option doc explains why that is a preserved divergence rather than a decision.
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
  // --grep needs the same full-headroom query as --exclude-tests, since it also filters the resolved set client-side (on filePath) AFTER the query -- slicing to the requested limit before it runs would silently under-return by letting non-matching refs occupy slots ahead of the cutoff.
  if (opts.excludeTests === true || opts.grep !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
  else if (opts.limit !== undefined) queryOpts.limit = opts.limit
  else if (opts.top !== undefined) queryOpts.limit = UNBOUNDED_QUERY_LIMIT
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
  // The typed-tier filter is a client-side filter over the same window as --exclude-tests/--grep, so a query where it alone dropped rows reports a floor whenever that window was finite: see refsTotal's doc comment.
  const clientFiltered = opts.excludeTests === true || matchesGrep !== undefined || typedFilterDropped
  let filteredTotal: number | undefined
  if (clientFiltered) filteredTotal = results.length
  if (clientFiltered && opts.top === undefined) {
    results = results.slice(0, opts.limit ?? 100)
  }

  if (results.length === 0) {
    // Distinguish "--grep matched none of the N references that do exist" from a symbol that genuinely has no references (or none outside tests) -- same "filtered store renders as populated" trap already fixed for dead/deps/types. Checked first so it takes priority over the --exclude-tests message below when both filters are active and --grep is what zeroed the remaining set.
    if (matchesGrep !== undefined && preGrepCount > 0) {
      // Exits 0, so under --json a prose notice would pair a success status with an unparseable body. Same `{items, truncated, totalCount}` envelope the populated branch emits, with the post-filter count; text mode keeps the human notice.
      if (opts.json === true) {
        // `hiddenByGrep` (brief --json's own convention) is what tells the consumer this empty envelope is a filtered view rather than a symbol with no references -- `totalCount: 0` alone reads identically for both.
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
    // Distinguish "not indexed at all" from "indexed, genuinely zero references" -- the latter keeps today's message byte-identical (see unknownSymbolSuggestion's own doc comment for why this matters). Resolved here rather than hoisted to the top of the function since it's only ever paid once the query already came back empty.
    const rootDir = opts.projectRoot ?? resolveProjectRoot({ project: process.cwd() })
    // Fetched as rows rather than as a bare existence count, because the defining file's LANGUAGE decides whether an empty result is an answer at all: parser.ts's REF_LANGUAGES walks call sites for nine tree-sitter languages only, and for a file outside that set the refs table is empty by construction. Capped rather than unbounded -- this only needs to know whether every definition of the name sits in a ref-blind language, and a name with more definitions than this cap in a single project is not a case where one more row changes that verdict.
    const defRows = querySymbols({ name: symName, rootDir, limit: REF_BLIND_DEF_PROBE_LIMIT })
    if (defRows.length === 0) {
      emitErr(`Symbol not found: ${symName}${unknownSymbolSuggestion(symName, rootDir)}`)
      // Same empty-index note as the "No references found" branch below -- an empty project index makes EVERY symbol look unindexed, so this must still surface the real cause instead of leaving the caller staring at a suggestion-free "not found" for a project that was simply never indexed.
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
    // Only paid after the query already came back empty, and only in text mode -- this branch already emits plain prose regardless of --json (there's no separate opts.json check here), so there's no JSON envelope to protect either way.
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
      // Same "SQL LIMIT applied before totalCount is taken" fix as runRefs's per-symbol branch above. Same --exclude-tests/--grep honest-total reasoning as runRefs's per-symbol branch above.
      const capped = guardJsonRows(results)
      const trueTotal = clientFiltered ? (filteredTotal ?? results.length) : countRefs(queryOpts)
      payload = { items: refsJsonItems(capped.items, opts.context ?? 0), truncated: capped.truncated || trueTotal > results.length, totalCount: trueTotal }
    }
    // Same omit-when-zero `hiddenByGrep` as the filtered-to-empty branch above, so a partially filtered page carries the count too rather than only the fully emptied one. Spread onto the emitted object rather than into `payload` so both `--top` and per-reference envelopes get it without either shape's interface growing an optional field the other never sets.
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
  // `--top` renders its own elision note; the per-reference modes printed exactly `limit` lines and stopped, so 100 of 150 references read as "these are all of them". Same honest total the --json branch above computes, and only paid when the page came back full.
  const refsFooter = opts.top !== undefined ? '' : truncationFooter(results.length, opts.limit ?? 100, () => refsTotal(clientFiltered, filteredTotal, results.length, () => countRefs(queryOpts), preScanCount, scanLimit), 'references', '--limit')
  const text = lines.join('\n')
  // Guarded first, footer after: the overflow guard must not be able to trim off the very line that says how much was left out.
  emit(guardText(text, 'symbol') + refsFooter)
  recordReadStat('symbol_read', fullSourceBytes, text + refsFooter, symName)
  return 0
}

interface FileRefCount {
  readonly file: string
  readonly count: number
}

/** `--exclude-tests`: drops references whose call site is a test file, per {@link isTestFile}. Callers must query unbounded so this runs BEFORE any `--limit`/`--top` slicing, or the flag silently under-returns by letting suppressed test refs occupy slots ahead of the cutoff -- and no finite headroom is sufficient, since the rows are ordered alphabetically rather than by relevance. */
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

// ---- skeleton / stub_view / outline -----------------------------------------

export * from './read_outline.js'

/** Why an existing file has no symbol rows when the cause is token-goat rather than the file: no extractor for its type (a named entry in {@link unsupportedLanguageName}, or an unrecognized extension), or a tree-sitter language whose grammar did not load, so only the coarse regex fallback ran. `undefined` otherwise, where "no symbols" is the honest answer. */
// ---- github pr-slice ---------------------------------------------------------

export interface PrSliceCliOptions {
  pr: string
  slice: string
  repo?: string
  json?: boolean
  projectRoot?: string
}

/** Handle ``token-goat pr-slice <pr> <slice>``: fetch and format exactly one slice of a GitHub PR via `gh` -- `files` (changed files with +/- counts), `diff:<path>` (one file's diff hunk), `comments` (review comments), or `description` (title/body/metadata) -- instead of a raw `gh pr view`/`gh pr diff` dump. Resolves the target repo from `--repo`, falling back to the current directory's `origin` git remote when omitted. */
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
        // pr-slice carries a live entry in stats.ts's KIND_TO_SOURCE/COMMAND_KINDS registry (pr_slice), but nothing here ever called recordStat -- the pr-slice bucket in `token-goat stats --full` stayed permanently zero regardless of real usage, the same class of registry/producer desync previously fixed for map_lookup/changed_lookup/csv_query/brief_view/gdrive_sections (see project_runchanged_missing_stat memory). "Full source" is the raw fetched GH API payload (what a manual `gh pr view --json files` dump would be) vs the formatted/ guarded slice actually emitted, mirroring recordReadStat's convention elsewhere in this file.
        const fullSourceBytes = Buffer.byteLength(JSON.stringify(files), 'utf8')
        if (opts.json === true) {
          const capped = guardJsonRows(files)
          const jsonText = displaySafeJson({ items: capped.items, truncated: capped.truncated, totalCount: capped.totalCount }, 0)
          emit(jsonText)
          recordReadStat('pr_slice', fullSourceBytes, jsonText, `${repo}#${opts.pr} files`)
        } else {
          // Changed-file paths are structured identifiers, not freeform prose, so they are not fenced here the way diff/comments/description text is -- see this file's fenceGithubText doc comment.
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
        // "Full source" is the whole multi-file PR diff fetched before slicing down to one file's hunk -- see the `files` case above for the same recordStat rationale.
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

/** Thin async wrapper: reads the PDF off disk and extracts its text. Kept separate from the synchronous run*(opts): number handlers above because pdfjs-dist's parser is async; the caller (cli.ts's cmdPdfExtract) drives it through guard() (which supports async actions) rather than runExit (sync-only). Throws on error, matching this file's extractPdfText contract, rather than returning an exit code. */
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
  /** Whether the engine has a decoder for this format, i.e. whether a shrink was even attemptable. A header probe reads more formats than the re-encoder handles, so `decodable: true, shrinkable: false` is an ordinary webp or tiff -- and reporting that as "no benefit" states a capability limit as a measurement. */
  shrinkable: boolean
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
    // The engine read the header and rejected the bytes: a corrupt or truncated image, which is a real error rather than the "cannot read this format" notice at exit 0.
    if (e instanceof ImageDecodeError) {
      throw new Error(`${file} is not a readable image: ${e.message}`, { cause: e })
    }
    throw e
  }
  if (probe === null) {
    return { width: 0, height: 0, format: null, bytes, decodable: false, shrinkable: false, wouldShrink: false, shrunkBytes: null }
  }
  const shrinkable = canShrinkFormat(probe.format)
  const shrink = shrinkable ? await shrinkImage(data, { sizeThresholdBytes: 0 }) : null
  return {
    width: probe.width,
    height: probe.height,
    format: probe.format,
    bytes,
    decodable: true,
    shrinkable,
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
    // A null result means "engine not installed" only when the engine is genuinely absent. If it is present, OCR ran and produced nothing for this input -- a corrupt image, a timeout, an offline model fetch -- which must not be reported as a missing dependency at exit 0. An integrity refusal is not one of those three, and the engine is installed, so it would otherwise be reported as a bad image. Name it instead: the model was discarded, the input was fine, and the next run starts from a cold cache and re-downloads from the pinned source.
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

/** Thin async wrapper (same rationale as runPdfExtractText above): drives a real headless browser, so it needs guard()'s async support rather than runExit. */
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

// ---- brief ------------------------------------------------------------------

export * from './read_brief.js'

// ---- grep -------------------------------------------------------------------

export interface GrepOptions {
  pattern: string
  path?: string | string[]
  /** Root the search falls back to when `path` is omitted. Defaults to `process.cwd()` (the CLI's long-standing behavior, unchanged when this is absent). An MCP server must pass its resolved project root: without it, a client omitting `path` searched the server process's own cwd with no confinement check at all -- see the invariant on `resolveToolRoot` in mcp_server.ts. */
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
  // A relative search path must resolve against the SAME base its caller's confinement gate measured it against. The MCP `grep` handler validates each `path` entry with `path.resolve(projectRoot, normalizePath(entry))` and pins that spelling, but this function used to hand the raw string straight to the reader, which resolves it against the server process's cwd. Those two bases diverge whenever projectRoot is not the cwd, which is the ordinary case since the client supplies it per call: `grep(path: ["secret.txt"], projectRoot: "/safe")` was gated as `/safe/secret.txt` -- absent, so ABSENT_PIN -- and then opened `<cwd>/secret.txt`, whose pin key never matched, so the identity check degraded to an unpinned raw read and the file's contents came back. Anchoring here makes the value used identical to the value checked, which is the confinement invariant `confineTargets` documents. The CLI passes no projectRoot, so its paths stay cwd-relative exactly as before.
  //
  // Only a RELATIVE entry is anchored. An absolute one has no base to be ambiguous about, and rewriting it would change nothing but its spelling -- `normalizePath` lower-cases the drive letter, which two tests caught immediately by comparing reported paths byte for byte. An absolute entry that points outside the root is the gate's business, not this function's, and the gate refuses it before the search ever starts.
  const anchorSearchPath = (p: string): string => (opts.projectRoot === undefined || path.isAbsolute(p) ? p : path.resolve(opts.projectRoot, p))
  const searchPaths =
    opts.path === undefined
      ? [opts.projectRoot ?? process.cwd()]
      : (Array.isArray(opts.path) ? opts.path : [opts.path]).map(anchorSearchPath)
  const maxLines = opts.maxLines ?? GREP_MAX_LINES
  const contextLines = opts.context ?? 0

  // Refused, not merely reported: an unbounded backtracking pattern cannot be interrupted once `test` has started, and the MCP server that reaches here is single-threaded, so one line of ordinary-looking text would take every other tool down with it. See regex_guard.ts.
  const guarded = compileGuardedRegex(opts.pattern)
  if (!guarded.ok) {
    emitErr(`Invalid regex: ${opts.pattern} -- ${guarded.reason}`)
    return 1
  }
  const regex = guarded.re

  const hits: GrepHit[] = []

  function searchFile(filePath: string): void {
    try {
      // Pin-aware: consults `activePins` when this exact path was validated and pinned by the MCP confinement gate (see readFileText), so an explicitly-requested `path` argument gets the same swap-between-validate-and-read protection every other surgical-read command gets. Files discovered by searchDir's own recursion below were never individually pinned by the gate -- their protection is the realpath boundary check in searchDir, not this identity check, which only fires for paths the gate itself validated.
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

  // True when `candidateReal` (a realpath) is `boundaryReal` itself or nested inside it. Both sides are pre-normalized realpaths, so this is a plain string comparison -- no further symlink resolution needed at the call site.
  function withinRealpathBoundary(candidateReal: string, boundaryReal: string): boolean {
    const cFold = foldRealpath(candidateReal)
    const bFold = foldRealpath(boundaryReal)
    return cFold === bFold || cFold.startsWith(bFold.endsWith('/') ? bFold : `${bFold}/`)
  }

  // Realpaths already visited by the confined walk, folded by `foldRealpath`, so a symlink that resolves back into the tree neither loops forever nor reports the same file twice. Reset before each top-level search path so overlapping explicit `--path` arguments keep their existing independent-walk semantics rather than silently deduplicating against each other.
  let visitedRealDirs = new Set<string>()

  // `boundaryReal` is `dir`'s own top-level search root, realpath-resolved once by the caller. `fs.statSync` (unlike `fs.lstatSync`) follows symlinks, so a directory symlink inside the search root that points outside it would otherwise be silently descended into and its out-of-root contents searched -- a confinement bypass distinct from searchFile's own pin check above (that one guards HOW an explicitly-requested file is opened; this one guards WHICH files a recursive walk enumerates in the first place). The earlier check-then-use shape was itself a TOCTOU window: it validated the symlink PATHNAME and then re-used that same pathname for fs.statSync/recursion, so the link could be repointed outside the root in between. Under confinement the walk now resolves the entry ONCE with fs.realpathSync, boundary-checks that realpath, and then stats/recurses/reads the REALPATH only -- so repointing the LINK afterwards cannot affect the walk, which never references that pathname again. That is the variant this closes, and it is the one the regression test exercises. It does NOT close the resolved-target variant: `target` is a path string, not a pinned descriptor, so fs.statSync(target) and the recursive walk both re-resolve it, and swapping a component of that realpath in between would still be followed. No portable descriptor-relative traversal API exists to eliminate that window, so the recursive entry re-checks the boundary on every call (below) to bound it rather than trusting one check, and the residual race is accepted under a threat model with no concurrent writer inside the confined root. Unconfined CLI grep keeps following the symlink pathname exactly as before, since there is no attacker in that model.
  function searchDir(dir: string, boundaryReal: string): void {
    if (activePins !== null) {
      // Cycle and duplicate protection, confined-only so unconfined output stays byte-identical: a symlink resolving back into the already-walked tree would otherwise recurse forever (a -> b -> a) or report the same files twice via two different pathnames.
      let realDir: string
      try {
        realDir = foldRealpath(fs.realpathSync(dir))
      } catch {
        return
      }
      // Re-checked on every entry, not just at the caller's one-time resolution: `dir` is already a boundary-checked realpath on the recursive path, so this normally re-derives the same string and passes -- it only ever fires if a component of that realpath was swapped between the caller's check and this re-resolution, which is exactly the residual race the docblock above scopes. Cheap enough to pay unconditionally rather than trust the caller's check.
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
        // Everything below stats, recurses into, and reads `target` -- identical to `full` for an ordinary entry, and the realpath (never the link pathname) for a confined symlink.
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
      // Pin-aware: when this exact top-level directory was validated and pinned by the MCP confinement gate (see confineTargets), verify its identity has not changed since before deriving the search boundary from it below. Without this, a directory swapped to an out-of-root symlink between gate validation and this call would have its (attacker- controlled) realpath silently accepted as the boundary, and the recursive walk below would search outside the root -- searchDir's own lstat/realpath boundary check only guards entries discovered WITHIN the search, not the root of the search itself.
      const pinned = activePins?.get(pinKey(path.resolve(searchPath)))
      if (pinned !== undefined) verifyPin(searchPath, pinned)
      let boundaryReal: string
      try {
        boundaryReal = fs.realpathSync(searchPath)
      } catch (err) {
        // A swap that makes the path unresolvable (e.g. it was replaced with something realpathSync can't stat) is exactly the failure mode this check exists to catch -- falling back to path.resolve(searchPath) here would derive the search boundary from an unverified, possibly-attacker-controlled pathname at the one moment something is already known to be wrong. Refuse instead of weakening the boundary; unpinned callers (every CLI invocation, and MCP with confinement disabled) keep the pre-existing resolve-and-continue fallback since there is no pin to have been swapped away from.
        if (pinned === undefined) {
          boundaryReal = path.resolve(searchPath)
        } else {
          throw new ConfinementIdentityError(
            `refused: "${searchPath}" could not be resolved after validation (${String(err)}). ` +
              'The path may have been replaced or redirected after the confinement check, so the search was not performed.',
          )
        }
      }
      // NARROWS, does not close, the finding-2 TOCTOU window: re-verify pinned identity immediately after deriving boundaryReal, so a swap landing between the first verifyPinnedIdentity call above and fs.realpathSync is detected here rather than silently accepted into the search boundary. This does not eliminate the race -- Node has no portable openat-style directory-descriptor traversal API (no `/proc/self/fd` on Windows/macOS, no equivalent Node API on any platform), and this project's CI gates on ubuntu, windows, and macos, so a swap landing in the small residual gap between this second verification and searchDir's first entry read is still possible and undetected.
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
    // Same {items, truncated, totalCount} envelope guardJsonRows uses for symbol/refs/skeleton/ outline's --json mode -- a bare truncated array here would silently hand a JSON consumer fewer hits than actually matched with no way to tell "capped by --max-lines" apart from "there just weren't more".
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
    emitErr(`Tip: To avoid broad grepping and reduce token expenditure, locate specific symbols with:`)
    emitErr(`  token-goat symbol <name>`)
    emitErr(`  token-goat locate <name>`)
    emitErr(`  token-goat outline <file> / token-goat skeleton <file>`)
  }

  return 0
}

// ---- re-export underlying layers -------------------------------------------

export type { SymbolEntry, RefEntry }
/** Collect assistant text in order from a Claude Code / subagent JSONL transcript. Each line is one JSON record; keep `type:"assistant"` records and pull their `message.content[]` text blocks (or a plain-string `content`), joined in order. Malformed lines, non-assistant records, and non-text blocks (thinking, tool_use, tool_result) are skipped. Returns the joined text, or '' when nothing matches, which keeps `--transcript` harmless on a file that is not a transcript. */
interface SemanticOptions {
  limit?: number
  /** Project root to scope the search to. Defaults to `process.cwd()`; same field name as {@link ChangedOptions.projectRoot}. Callers whose cwd is not the workspace root (e.g. an MCP server launched by a client from an opaque directory) should pass the actual workspace root explicitly -- otherwise the search silently scopes to the wrong project (or the whole machine-wide index yields nothing under it). */
  projectRoot?: string
  /** Emit machine-readable JSON instead of the human-formatted preview blocks, matching every other surgical-read command's --json convention (symbol, skeleton, outline, refs). */
  json?: boolean
  /** Filter to hits whose FILE PATH matches this pattern (matched against the path as rendered under displayRoot, same convention as `refs --grep`). Regex, falling back to a literal substring match when it does not compile -- see compileGrepMatcher. Applied before the `--limit` slice in both the embeddings and FTS-fallback branches. */
  grep?: string
  /** `--exclude-tests`: drop hits whose file lives in a test file (per isTestFile), matching `refs`/`callers`/`dead`'s flag of the same name. Opt-in; omitted or false leaves output byte-identical to today. Distinct from `grep`, which can only ever *select* paths -- there is no `--grep` pattern that reliably excludes tests, since a negative lookahead silently degrades to a literal substring match on the regex-compile fallback. Composes with `grep`: a hit must satisfy both. Applied before the `--limit` slice in both branches. */
  excludeTests?: boolean
  /** Run semantic embedding preflight check and exit. */
  preflight?: boolean
  /** Warm up the embedding model session in memory before query execution. */
  warm?: boolean
}

// Ported from cli.ts's cmdSemantic, which used to throw a CliError (caught by the generic `guard` wrapper, which prefixes it with "token-goat: " before printing to stderr) on a no-matches miss instead of returning a code. The "token-goat: " prefix is baked into the returned text here so the CLI's output stays byte-identical to that historical path. Reciprocal Rank Fusion constant (score = sum over lists of 1/(RRF_K + rank)) -- the conventional k=60, chosen because RRF needs only each list's RANK (not its raw score), which sidesteps having to normalize dense cosine/L2 distance against BM25's unbounded score on incomparable scales.
const RRF_K = 60

// Best surviving dense distance above which runSemantic says its closest match is weak. Measured on this repo's index on 2026-09-24: 38 questions about code that is present had best hits from 0.565 to 0.800, and 12 nonsense or off-topic ones from 0.863 to 1.043 (8 questions from other programming domains spread over 0.718-0.952, the low ones landing on code that is genuinely related, so those are not separable by distance), so the cut sits in that gap nearer the noise edge, because a small corpus pushes genuine matches farther out (0.934 in a two-file project, see semantic.max_distance) and a false alarm on a right answer costs more than a missed one. Advisory only: it removes nothing, unlike that floor.
const WEAK_MATCH_DISTANCE = 0.85

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
  // Which of the two retrievals produced this row. Derivable from `distance` for the dense leg alone, but not for the lexical one: a row the dense pass found and the FTS pass also voted for keeps its dense fields and only accumulates rank into `rrf`, so before these flags a both-lists row and a dense-only row rendered identically while sorting differently. That is the whole of what a reader cannot otherwise reconstruct from the printed output.
  inDense: boolean
  inLexical: boolean
}

/** Splits dense hits on the relevance floor, returning what survives and the closest distance that did not. The rejected minimum is what lets the caller say why the half came back empty: a floor is a threshold on a continuum, so "nothing matched" and "the best thing was 0.91 against a floor of 0.9" are different facts and only the second one is actionable. Compares raw `distance` rather than the rerank's `adjustedDistance`, since the floor was measured against raw distances and the rerank's boosts and path penalties are a ranking device with no calibrated scale. */
export function applyRelevanceFloor(
  hits: readonly SearchHit[],
  floor: number,
): { kept: SearchHit[]; nearestRejected: number | null } {
  const kept: SearchHit[] = []
  let nearestRejected: number | null = null
  for (const h of hits) {
    if (h.distance <= floor) {
      kept.push(h)
    } else if (nearestRejected === null || h.distance < nearestRejected) {
      nearestRejected = h.distance
    }
  }
  return { kept, nearestRejected }
}

async function runSemantic(query: string, opts: SemanticOptions): Promise<{ text: string; code: number }> {
  // Same reasoning as runSymbol above: a limit of 0 (or negative) would silently query for zero results instead of surfacing a clear "you asked for nothing" error.
  if (opts.limit !== undefined && opts.limit <= 0) {
    const message = `--limit must be a positive number, got: ${opts.limit}`
    if (opts.json === true) {
      return { text: displaySafeJson({ error: message }), code: 1 }
    }
    return { text: message, code: 1 }
  }

  const n = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : 20

  // A caller-supplied projectRoot must be an absolute, existing directory -- otherwise searchSemantic silently finds nothing under the bogus root and this function falls back to the (now project-scoped) FTS search using that same bogus root, which also finds nothing, and the caller gets a plain "no matches" instead of a clear signal that the scope they asked for doesn't exist. Fail loudly instead of silently widening/losing scope.
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
  let projectCoverage: { indexedFiles: number; embeddedFiles: number } | undefined
  try {
    projectCoverage = getEmbeddingCoverage(globalDbPath(), rootDir)
  } catch {
    // DB or project root not yet initialized
  }

  if (opts.preflight === true) {
    const preflight = await checkEmbeddingPreflight({
      ...(opts.warm !== undefined ? { warm: opts.warm } : {}),
      projectRoot: rootDir,
      ...(projectCoverage !== undefined ? { coverage: projectCoverage } : {}),
    })
    if (opts.json === true) {
      return { text: displaySafeJson(preflight), code: preflight.status === 'ready' ? 0 : 1 }
    }
    const lines = [
      `Semantic embedding status: ${preflight.status.toUpperCase()}`,
      `  Summary: ${preflight.summary}`,
      `  Config (indexing.embeddings_enabled): ${preflight.configEnabled ? 'enabled' : 'disabled'}`,
      `  ONNX runtime (onnxruntime-node): ${preflight.runtimeAvailable ? 'available' : 'missing'}`,
      `  Model files (~34 MB): ${preflight.modelFilesPresent ? 'present' : 'missing'}`,
      `  In-memory session: ${preflight.modelWarmed ? 'ready / warmed' : 'not loaded'}`,
      `  Project coverage: ${preflight.embeddedFiles}/${countNoun(preflight.indexedFiles, 'file')} (${preflight.coveragePercent}%)`,
    ]
    if (preflight.actionRequired) {
      lines.push(`  Action: ${preflight.actionRequired}`)
    }
    return { text: lines.join('\n'), code: preflight.status === 'ready' ? 0 : 1 }
  }

  // Preflight check surfaces broken or degraded embeddings before a query is attempted.
  const preflight = await checkEmbeddingPreflight({
    ...(opts.warm !== undefined ? { warm: opts.warm } : {}),
    projectRoot: rootDir,
    ...(projectCoverage !== undefined ? { coverage: projectCoverage } : {}),
  })

  // Same flag that gates embedding at index time (parser.ts, worker.ts) must also gate it here at query time, or TOKEN_GOAT_EMBEDDINGS_ENABLED=0 -- read by every other embedding-adjacent path in this codebase, including memory_prune.ts's tryEmbeddingClusters -- does nothing for `semantic`: embeddingModelAvailable() below only checks whether the optional onnxruntime-node runtime is installed, not whether the user opted out, so a disabled-but-installed runtime would still call searchSemantic, which calls embedTexts, which downloads the ~34 MB model on a cold cache regardless of this setting. Checked once here so both the availability warning below and the searchSemantic call are skipped together.
  const embeddingsEnabled = loadConfig().indexing?.embeddings_enabled ?? true

  if (embeddingsEnabled && !embeddingModelAvailable()) {
    console.warn(
      'Matching on meaning is off (onnxruntime-node is not installed); these results come from keyword search alone. ' +
        'Install it with: npm install -g onnxruntime-node (drop -g if token-goat is a project dependency)',
    )
  } else if (!embeddingsEnabled) {
    console.warn(
      'Matching on meaning is off (indexing.embeddings_enabled / TOKEN_GOAT_EMBEDDINGS_ENABLED is disabled); these results come from keyword search alone.',
    )
  } else if (preflight.status !== 'ready') {
    console.warn(
      `Matching on meaning is degraded (${preflight.summary}); these results come from keyword search alone.${preflight.actionRequired ? ` Action: ${preflight.actionRequired}` : ''}`,
    )
  }
  const overFetchForMerge = Math.min(MAX_OVER_FETCH, n * OVER_FETCH_FACTOR)
  // The dense half is best-effort, and this catch is the whole of what makes that true. The package being absent is handled inside searchSemantic (it returns no hits), but the model files are a separate thing that can be missing on their own: the runtime installs fine and then the weights cannot be fetched -- offline mode, no cache yet, a network failure, a digest that does not match. That throws out of embedTexts, and before this catch it escaped runSemantic entirely, so `semantic` exited non-zero with nothing on stdout at the exact moment it was supposed to degrade to keyword search. Same treatment as the absent package: say what is missing, then carry on with the BM25 pass below, which is the half that still works.
  let rawHits: SearchHit[] = []
  let searchSemanticError: string | null = null
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
      searchSemanticError = extractErrorMessage(e)
      if (preflight.status === 'ready') {
        console.warn(
          `Matching on meaning is off (${searchSemanticError}); these results come from keyword search alone.`,
        )
      }
    }
  }

  // Relevance floor, applied here rather than inside the scan -- see the max_distance comment on SemanticConfig for why the scan's own bound is the wrong place for it. Reading the nearest rejected distance before filtering is the whole point of the diagnostic below: without it, a floor set too tight for a given corpus removes real answers and says nothing, which is the silent-recall-loss shape this command already had one instance of (an empty dense half only warns when the project is partly unembedded, so on a fully embedded project it warned about nothing at all).
  let floorNearestRejected: number | null = null
  if (rawHits.length > 0) {
    const floor = loadConfig().semantic.max_distance
    const { kept, nearestRejected } = applyRelevanceFloor(rawHits, floor)
    floorNearestRejected = nearestRejected
    // Only when the floor emptied the half outright: trimming a weak tail off a list that still has its best hit is the floor working as intended, and saying so on every ordinary search would be noise.
    if (kept.length === 0 && nearestRejected !== null) {
      console.warn(
        `Matching on meaning found nothing within ${floor} (closest was ${nearestRejected.toFixed(3)}); ` +
          `these results come from keyword search alone. Raise semantic.max_distance to see weaker matches.`,
      )
    }
    rawHits = kept
  }
  // Nearest-neighbour search always returns something, so a page of noise prints exactly like a page of answers; the floor above is left loose on purpose and cannot say so. Measured on the floor's survivors, and only when there are any: an empty dense half already has its own warning.
  const closestDense = rawHits.reduce<number | null>((best, h) => (best === null || h.distance < best ? h.distance : best), null)
  const weakClosestDistance = closestDense !== null && closestDense > WEAK_MATCH_DISTANCE ? closestDense : null

  // The dense half contributing nothing is the moment this search is most misleading, because the BM25 pass below still answers and the output looks like a complete result. It is also the only moment worth paying for the coverage query, so it is gated here rather than run every call: with hits, the reader has evidence embeddings are working; with none, they have no way to tell "nothing in your code is similar" from "almost none of your code was ever embedded". Warn only when the model itself is available and didn't fail with an error, since those branches already explain that case. floorNearestRejected guards this: when the floor is what emptied the half, it has already said so with the concrete distance, and following that with a coverage hypothesis would offer a second explanation for something already explained.
  if (
    rawHits.length === 0 &&
    floorNearestRejected === null &&
    embeddingModelAvailable() &&
    preflight.status === 'ready' &&
    !searchSemanticError
  ) {
    try {
      // Config read and coverage query both inside the try: this whole block is a diagnostic aid, and a diagnostic that can throw is worse than no diagnostic -- it would turn a search that otherwise answered into a crash.
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
    // A long symbol is several chunks, and the list is best-first, so the first chunk to claim a symbol is its best: a later one taking the row would report a worse range at a worse rank.
    if (fused.has(key)) return
    fused.set(key, {
      filePath: h.filePath,
      startLine: h.startLine,
      endLine: h.endLine,
      name: enclosing?.name ?? null,
      kind: enclosing?.kind ?? null,
      distance: h.distance,
      previewText: h.text,
      rrf: 1 / (RRF_K + denseRank),
      inDense: true,
      inLexical: false,
    })
  })
  ftsRows.forEach((s, ftsRank) => {
    const key = `${s.filePath}::${s.name}@${s.lineStart}`
    const existing = fused.get(key)
    if (existing !== undefined) {
      // Already present from the dense pass -- keep its dense-sourced fields (distance, containment-derived name/kind) and just add this list's rank contribution to the score.
      existing.rrf += 1 / (RRF_K + ftsRank)
      existing.inLexical = true
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
        inDense: false,
        inLexical: true,
      })
    }
  })
  // Map insertion order (JS Map iterates in insertion order) puts every dense-pass row ahead of any FTS-only row it didn't merge with, so a stable sort's tie-break (identical RRF score, e.g. both lists' rank-0) prefers the dense-backed row -- deliberate, since a dense hit is a direct answer to the query's semantics while a tied BM25-only row only matched a shared term.
  const fusedHits = Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf)

  // --grep narrows on the FILE PATH AS RENDERED (toDisplayPath), matching `refs --grep`'s convention -- an anchored `^src/` must match what the human/JSON output actually shows, not the stored absolute path; applied here, between fusion and slice, so `--limit 20 --grep '^src/'` returns 20 src/ hits rather than however many of the top-20 *unfiltered* hits happen to live under src/ -- the "filter must precede slice" trap this repo has hit before. --exclude-tests rides the same seam for the same reason: filtering after the slice would return however many of the top-`n` hits happen not to be tests, rather than `n` non-test hits -- it is checked against the STORED path (isTestFile), not the rendered one, because whether a file is a test is a property of the file itself, not of how it is displayed.
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
  // Measured before the slice. `guardJsonRows` below counts whatever array it is handed, so running it on the already-sliced list made `totalCount` report the number of survivors and `truncated` describe only the overflow guard: `--limit 2` on a 6-match query answered `totalCount: 2, truncated: false`, which is a wrong number rather than a missing one.
  const eligibleCount = filteredHits.length
  const hits = filteredHits.slice(0, n)
  // Both candidate lists are over-fetched to a bound (OVER_FETCH_FACTOR/MAX_OVER_FETCH). When a list came back AT its bound the fused set may itself be clipped, so `eligibleCount` is a floor rather than a total, and the wording below has to say so rather than name a number it cannot stand behind.
  const candidatesClipped = rawHits.length >= overFetchForMerge || ftsRows.length >= overFetchFts

  // Which list(s) actually contributed a candidate decides the reported `source` -- 'hybrid' only when both lists had at least one raw hit (even if they didn't fuse into the same row), never 'embeddings' silently standing in for a result that is partly BM25.
  const hadDense = mergedHits.length > 0
  const hadFts = ftsRows.length > 0
  const source = hadDense && hadFts ? 'hybrid' : hadDense ? 'embeddings' : 'fts'

  // Same multi-file self-heal-and-warn as runAsk/refs above -- `semantic` fuses hits across however many distinct files matched, none of which the caller named as a single spec.
  warnIfFilesStale(hits.map((h) => h.filePath))

  if (hits.length > 0) {
    if (opts.json === true) {
      // `filePath` rewritten to the same root-relative spelling the human blocks below render (toDisplayPath(rootDir, ...)) -- root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, matching outline/skeleton/refs --json. `rank`, `rrf` and `retrieval` are what make the ordering reproducible: `distance` is the dense leg's own score and does not explain the order, since the list is sorted by the fused rrf total and an FTS-only row has no distance at all. A consumer given distance alone can only conclude the results are mis-sorted.
      const items = hits.map((h, i) => ({
        filePath: toDisplayPath(rootDir, h.filePath),
        name: h.name,
        kind: h.kind,
        startLine: h.startLine,
        endLine: h.endLine,
        rank: i + 1,
        rrf: h.rrf,
        retrieval: h.inDense && h.inLexical ? 'both' : h.inDense ? 'dense' : 'lexical',
        distance: h.distance,
        preview: previewLines(h.previewText, 3),
      }))
      // Same {items, truncated, totalCount} envelope guardJsonRows returns for symbol/refs/skeleton/outline's --json mode (see the comment at the grep --json call site) -- a bare {source, items} payload would silently hand a JSON consumer fewer hits than actually matched with no way to tell "capped by the overflow guard" apart from "there just weren't more", and would let `--limit 500 --json` emit an unbounded payload.
      const capped = guardJsonRows(items)
      // Two independent losses -- the --limit slice above and the overflow guard inside guardJsonRows -- so `truncated` is the OR of both, and `totalCount` is the count before either ran. `totalCountIsFloor` is set only when the candidate over-fetch was itself at its bound, so a consumer can tell an exact total from a lower bound instead of being handed a number that quietly means different things on different runs.
      const limitTruncated = hits.length < eligibleCount
      const text = displaySafeJson({
        source,
        ...capped,
        truncated: capped.truncated || limitTruncated,
        totalCount: eligibleCount,
        ...(candidatesClipped ? { totalCountIsFloor: true } : {}),
        ...(weakClosestDistance !== null ? { lowConfidence: { closestDistance: weakClosestDistance, threshold: WEAK_MATCH_DISTANCE } } : {}),
        ...(preflight.status !== 'ready'
          ? {
              preflightStatus: preflight.status,
              warning: preflight.summary,
              ...(preflight.actionRequired ? { actionRequired: preflight.actionRequired } : {}),
            }
          : searchSemanticError !== null
            ? {
                preflightStatus: 'degraded',
                warning: `Matching on meaning failed (${searchSemanticError}); results come from keyword search alone.`,
              }
            : {}),
      })
      recordReadStat('semantic_search', largestFileSize(hits.map((h) => h.filePath)), text, query)
      return { text, code: 0 }
    }
    // A dense-sourced row (distance !== null) renders the distance-annotated block the embeddings branch always used, including the "— inside NAME (KIND)" containment suffix when resolved; an FTS-only row (distance === null, always symbol-backed) renders the plain "name (kind) — path" header the FTS fallback always used, with no "distance" or "inside" wording, since it IS the symbol, not a chunk found to be inside one.
    const blocks = hits.map((h, i) => {
      // The rank prefix is the fix for a list whose printed numbers do not explain its order: rows are sorted by the fused rrf total, so a dense row at distance 0.850 legitimately outranks one at 0.776 when the keyword pass voted for the first as well, and without the position that reads as a sorting bug. `+keyword` marks exactly those rows, and `keyword` marks a row the dense pass never returned -- which is why it carries no distance to print. A dense-only row stays byte-identical to what it always rendered, so the common case costs nothing extra.
      const mark = h.inDense && h.inLexical ? ', +keyword' : ''
      if (h.distance !== null) {
        const suffix = h.name !== null ? ` — inside ${h.name} (${h.kind})` : ''
        return `# ${i + 1}. ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine} (distance ${h.distance.toFixed(3)}${mark})${suffix}\n${previewLines(h.previewText, 3)}`
      }
      return `# ${i + 1}. ${h.name} (${h.kind}) — ${toDisplayPath(rootDir, h.filePath)}:${h.startLine}-${h.endLine} (keyword)\n${previewLines(h.previewText, 3)}`
    })
    const text = guardText(blocks.join('\n\n'), 'semantic')
    // stderr rather than appended to `text`: this function returns its text to callers that route it to stdout (and to the MCP server in-process), so a notice folded into the payload would become part of the search result itself.
    if (hits.length < eligibleCount) {
      emitErr(`Showing ${hits.length} of ${candidatesClipped ? 'at least ' : ''}${countNoun(eligibleCount, 'match', 'matches')} (raise --limit to see the rest).`)
    }
    // Names the query because a multi-query call prints every block's stderr ahead of the blocks themselves.
    if (weakClosestDistance !== null) {
      console.warn(
        `Matching on meaning found nothing close for '${query}' (closest was ${weakClosestDistance.toFixed(3)}, weak above ${WEAK_MATCH_DISTANCE}); these results may be unrelated. ` +
          `For a known name try token-goat symbol --grep <pattern> or rg, or rephrase the query.`,
      )
    }
    recordReadStat('semantic_search', largestFileSize(hits.map((h) => h.filePath)), text, query)
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
  // Evidence is a project-scoped fallback, not a replacement for source-index matches: its entries are redacted historical observations and carry no source line contract. Only consult it after both source retrieval paths miss and when no source-specific filter was requested.
  if (!anyFilter) {
    const evidenceHits = await searchEvidenceSemantically(rootDir, query, n)
    if (evidenceHits.length > 0) {
      // What this hit avoids is re-reading the cached entries in full, so the saving is measured against their whole text: the preview below is what gets emitted, and recordReadStat subtracts it.
      // Each entry is recalled by its own shell command, so each is priced at what the harness would have delivered of it.
      const evidenceFullBytes = evidenceHits.reduce((sum, entry) => sum + deliveredOutputBytes(Buffer.byteLength(entry.text, 'utf8')), 0)
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
    let symFound = false
    const trimmedQuery = query.trim()
    const isIdentifier = /^[A-Za-z0-9_.:-]+$/.test(trimmedQuery)
    if (!indexEmpty && isIdentifier) {
      try {
        const symMatches = querySymbols({ name: trimmedQuery, rootDir, limit: 1 })
        if (symMatches.length > 0) {
          symFound = true
        }
      } catch {
        // Ignore DB errors during symbol lookup fallback
      }
    }
    const payload = indexEmpty
      ? {
          source: 'fts',
          items: [],
          truncated: false,
          totalCount: 0,
          indexEmpty: true,
          hint: emptyIndexMessage(rootDir),
          ...(preflight.status !== 'ready'
            ? {
                preflightStatus: preflight.status,
                warning: preflight.summary,
                ...(preflight.actionRequired ? { actionRequired: preflight.actionRequired } : {}),
              }
            : searchSemanticError !== null
              ? {
                  preflightStatus: 'degraded',
                  warning: `Matching on meaning failed (${searchSemanticError}); results come from keyword search alone.`,
                }
              : {}),
        }
      : {
          source: 'fts',
          items: [],
          truncated: false,
          totalCount: 0,
          ...(preflight.status !== 'ready'
            ? {
                preflightStatus: preflight.status,
                warning: preflight.summary,
                ...(preflight.actionRequired ? { actionRequired: preflight.actionRequired } : {}),
              }
            : searchSemanticError !== null
              ? {
                  preflightStatus: 'degraded',
                  warning: `Matching on meaning failed (${searchSemanticError}); results come from keyword search alone.`,
                }
              : {}),
          ...(!indexEmpty && isIdentifier
            ? {
                symbolSuggestion: `token-goat symbol "${trimmedQuery}"`,
                ...(symFound ? { indexedSymbolFound: true } : {}),
              }
            : {}),
        }
    const text = displaySafeJson(payload)
    return { text, code: 1 }
  }
  let text = indexEmpty
    ? `token-goat: no matches for '${query}'\n${emptyIndexMessage(rootDir)}`
    : `token-goat: no matches for '${query}'`
  const trimmedQuery = query.trim()
  const isIdentifier = /^[A-Za-z0-9_.:-]+$/.test(trimmedQuery)
  if (!indexEmpty && isIdentifier) {
    let symFound = false
    try {
      const symMatches = querySymbols({ name: trimmedQuery, rootDir, limit: 1 })
      if (symMatches.length > 0) {
        symFound = true
      }
    } catch {
      // Ignore DB errors during symbol lookup fallback
    }
    if (symFound) {
      text += `\n(note: '${trimmedQuery}' is an indexed symbol name; use: token-goat symbol "${trimmedQuery}")`
    } else {
      text += `\nTry: token-goat symbol "${trimmedQuery}"`
    }
  }
  if (preflight.status !== 'ready') {
    text += `\n(note: semantic indexing is degraded [${preflight.status}]: ${preflight.summary}${preflight.actionRequired ? ` — ${preflight.actionRequired}` : ''})`
  } else if (searchSemanticError !== null) {
    text += `\n(note: semantic matching degraded: ${searchSemanticError}; results come from keyword search alone)`
  }
  return { text, code: 1 }
}

/** `semantic "a" "b" ...`: one runSemantic call per query in argument order, each block headed by its query, or in JSON an array of `{ query, ...what a single-query call returns }`. Sequential in one process, so the embedding extractor and config the first query loads serve the rest; `warm` goes to the first call only, since each warm loads the model afresh. Exits 0 when any query answered, as runReadMulti does. */
export async function runSemanticMulti(queries: readonly string[], opts: SemanticOptions): Promise<{ text: string; code: number }> {
  const laterOpts: SemanticOptions = { ...opts }
  delete laterOpts.warm
  const blocks: string[] = []
  const entries: unknown[] = []
  let anyOk = false
  for (const [i, query] of queries.entries()) {
    const sub = await runSemantic(query, i === 0 ? opts : laterOpts)
    if (sub.code === 0) anyOk = true
    if (opts.json === true) {
      // Every JSON return from runSemantic is a displaySafeJson object, so it nests as real JSON rather than an embedded string.
      entries.push({ query, ...(JSON.parse(sub.text) as Record<string, unknown>) })
      continue
    }
    blocks.push(`'${query}':\n${sub.text}`)
  }
  return { text: opts.json === true ? displaySafeJson(entries) : blocks.join('\n\n'), code: anyOk ? 0 : 1 }
}


// ---- notes (note-get / note-list) -------------------------------------------
//
export * from './read_structured_data.js'
export * from './read_git.js'
export * from './read_inspect.js'
export * from './read_suggest.js'
export * from './read_section.js'
export * from './read_spec.js'
export * from './read_meta.js'

export { querySymbols, queryRefs, readSection, listSections, extractSection, runSemantic }
