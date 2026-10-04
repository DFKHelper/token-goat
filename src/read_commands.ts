/** CLI command handlers for surgical-read commands. Ports the public command functions from ``read_commands.py`` to TypeScript. The DB-query layer lives in ``index_reader.ts``, section extraction in ``section_reader.ts``, and the "did you mean?" hints in ``read_suggest.ts``. A command with a module of its own (``read_outline.ts``, ``read_semantic.ts`` and the other ``read_*.ts`` files) is imported from that module, since this one re-exports nothing. This module owns argument parsing and output formatting for the commands defined here. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { SKIP_DIRS } from './baseline.js'
import { redactIfDotenv } from './dotenv_redact.js'
import { querySymbols, queryRefCounts, getFileEntry } from './index_reader.js'
import { indexedSourceText, isVirtualIndexedPath, virtualIndexedScopeNote } from './indexed_source.js'
import { displaySafeText, normalizePath, displaySafeJson } from './paths.js'
import { expandSpecPath, resolveSpecPath } from './spec_path.js'
import { indexFileSync } from './parser.js'
import { compileGuardedRegex } from './regex_guard.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { dataDir, globalDbPath } from './constants.js'
import { recordKnownRootThrottled } from './known_roots.js'
import { LARGE_SYMBOL_LINE_THRESHOLD } from './hints/file_type_handler.js'
import { isReadOnlyDb } from './db.js'
import { fileIsAbsent, fingerprintFile } from './fingerprint.js'
import { decodeSource, runGit, PER_FILE_COUNTERFACTUAL_CEILING, foldCaseForContainment, countNoun, requirePositiveStrictInt } from './util.js'
import { renderContextWindow } from './util_context.js'
import { emit, emitErr } from './emit.js'
import { FIND_SCAN_LIMIT } from './query_limits.js'
import { resolveProjectRoot } from './project.js'
import { loadConfig } from './config.js'
import { fenceUntrustedContent, UNTRUSTED_GITHUB_TAG } from './injection_scan.js'
import { redactSecrets } from './secret_redact.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'
import { trimToBudget, capJsonRows, type JsonRowCapResult } from './overflow_guard.js'
import { enclosingSymbol, ALL_SYMBOLS_IN_FILE_LIMIT } from './graph_commands.js'
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
import { canShrinkFormat, decoderRefusal, isImagePath, probeImageMeta, shrinkImage, ImageDecodeError } from './image_shrink.js'
import { ocrImage, isTextHeavy, isOcrEngineAvailable, ocrIntegrityFailed } from './image_ocr.js'
import { takeScreenshot } from './screenshot.js'
import { recordStat, savedTokensFromBytes } from './stats.js'

// ---- constants --------------------------------------------------------------

import {
  didYouMean,
  formatBareNameSpecError,
  formatCrossFileLead,
  rankSimilarNames,
  trimBlankLines,
} from './read_suggest.js'
import {
  formatAmbiguity,
  parseColonLineRange,
  parseColonLineSpec,
  parseCrossFileMultiSpec,
  parseLineRange,
  parseReadSpec,
  qualifiedSpellings,
  resolveSymbolSpec,
  runLineRange,
  runLineRegion,
} from './read_spec.js'
import {
  formatStatsSuffix,
  symbolExtractorGap,
} from './read_meta.js'
import { formatCommandError } from './command_error.js'

const GREP_MAX_LINES = 200

// `refs --top`, `--exclude-tests` and `--grep` all narrow the resolved set in JavaScript AFTER the query returns, and `--top` additionally aggregates by file before truncating. queryRefs orders rows by file_path then line -- alphabetical, not count-based -- so any finite cap ahead of those steps drops every ref in alphabetically-later files regardless of how many they hold, producing a "top files by reference count" that is really "top files among whichever sort first alphabetically", and an --exclude-tests/--grep page selected from a prefix of the matches instead of from all of them.
//
// This was a cap of 100 before, then 20,000 with a comment calling it "large enough to cover any realistic single-symbol fanout". Measured against the live index that belief was false by 7.2x: `expect` has 143,666 references, `toBe` 62,841 and `test` 52,484, with four more names past the window. `refs expect --top 8` therefore ranked the alphabetically-first 13.9% of the rows and reported a top file of 695 references while the real leader held 1,571 and never appeared; for `push --exclude-tests`, 2,459 of 17,484 genuine non-test references (14.1%) sat past the window and were unreachable at any --limit. A bigger finite number would only move the project size at which that recurs, so these paths scan unbounded and the cap is gone rather than raised.

// ---- helpers ----------------------------------------------------------------

/** True when `p` names a regular file, following a symlink. The read commands share this one check for "is there a document here to read": a directory, a missing path and one stat cannot examine are all answered "Could not read" rather than getting as far as a read that fails on them. A check that means anything at the path uses {@link pathExists}. */
export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** True when stat sees anything at `p`, a directory included: a search path that may be a directory, a PDF path whose bounded reader refuses a non-regular file by name, and a path validated as absent that must still be absent. */
function pathExists(p: string): boolean {
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

/** Opens `p` and returns the descriptor once the OPENED DESCRIPTOR's identity matches `pinned`; on a mismatch it closes the descriptor and throws {@link ConfinementIdentityError}. The caller owns the returned descriptor. Checking the descriptor rather than the path is the whole point: the confinement gate validated a path, and between that check and this open the path can be repointed at something outside the root. fstat answers "what did I actually open", which a second path-based stat cannot. */
function openPinned(p: string, pinned: string): number {
  // Deliberately a plain O_RDONLY, NOT O_NOFOLLOW. Adding O_NOFOLLOW here looks like free hardening and is not: measured on Linux, opening an ordinary in-root symlink with it fails ELOOP, which a caller turns into a silent "could not read" for a file the user is entitled to. It would also buy nothing, since the fstat identity comparison below -- not the open flags -- is what closes the check-vs-use window, and it resolves symlinks the same way the gate's stat did.
  const fd = fs.openSync(p, fs.constants.O_RDONLY)
  try {
    const actual = fileIdentity(fs.fstatSync(fd, { bigint: true }))
    if (actual !== pinned) {
      throw new ConfinementIdentityError(
        `refused: "${p}" changed identity between validation and read (validated ${pinned}, opened ${actual}). ` +
          'The file was replaced or redirected after the confinement check, so the read was not performed.',
      )
    }
    return fd
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
}

/** Returns `p`'s bytes, read through the descriptor {@link openPinned} verified against `pinned`, so the bytes are those of the file the gate validated. */
function readPinnedBytes(p: string, pinned: string): Buffer {
  const fd = openPinned(p, pinned)
  try {
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Verifies `p`'s CURRENT identity matches `pinned` through the same {@link openPinned} check, without reading any content: used for directories, where `readPinnedBytes` itself cannot be reused because `fs.readFileSync` on a directory fails with EISDIR. Throws {@link ConfinementIdentityError} on a mismatch; returns normally when it matches. */
function verifyPinnedIdentity(p: string, pinned: string): void {
  fs.closeSync(openPinned(p, pinned))
}

/** Verifies a target pinned as {@link ABSENT_PIN} is STILL absent from disk. Throws {@link ConfinementIdentityError} when something now exists at `p` -- the create-after- validated-absent race the negative pin exists to catch (an attacker names an in-root path that does not exist yet, waits for the gate to validate it as absent-but-in-root, then creates an out-of-root symlink there before the read runs). Returns normally when still absent, which the caller then treats exactly like the pre-existing "no pin recorded" missing-file path. */
function verifyStillAbsent(p: string): void {
  if (pathExists(p)) {
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

/** Symbols indexed with an empty stored `body` (e.g. HTML/Liquid heading symbols produced by `sectionsToHeadingSymbols`, which store `body: ''`) need their content re-read from disk by line range instead of rendering blank. Markdown heading symbols span their whole section but store only the heading line (hint_target.ts parses its level from it), so they are re-read the same way, provided the file still has that heading line at lineStart -- an edited file keeps the stored line rather than splicing in unrelated text. Shared by runSymbol, runRead, and runBrief so all three read surfaces resolve these symbols the same way. */
export function resolveBody(entry: { body: string; filePath: string; lineStart: number; lineEnd: number; kind?: string }): string {
  const storedFirstLine = entry.body.split(/\r?\n/)[0]!
  const storedLineCount = entry.body === '' ? 0 : entry.body.split(/\r?\n/).length
  const widenedHeading = entry.kind === 'heading' && storedLineCount > 0 && storedLineCount < entry.lineEnd - entry.lineStart + 1
  if (entry.body !== '' && !widenedHeading) return entry.body
  const source = readFileText(entry.filePath)
  if (source === null) return entry.body
  const diskLines = indexedSourceText(entry.filePath, source).split(/\r?\n/)
  if (widenedHeading && diskLines[entry.lineStart - 1]?.trim() !== storedFirstLine.trim()) return entry.body
  return diskLines.slice(Math.max(0, entry.lineStart - 1), entry.lineEnd).join('\n')
}

// The one-line warning prepended by staleWarning() when the on-disk file has changed since the index last saw it. Reuses fingerprintFile/files.sha -- the same sha the worker's dirty-queue gate (makeIndexer in worker.ts) compares against -- so "stale" here means exactly what it means there, rather than reinventing a second freshness signal.
const STALE_WARNING =
  "⚠ STALE: index is older than the file on disk (worker hasn't reindexed yet — retry shortly, or read the file directly)"

// STALE_WARNING's form for a run that reads the index without writing it (see db.ts's allowReadOnlyIndex): no reindex can land, so retrying would return the same old rows.
const STALE_READ_ONLY_WARNING = '⚠ STALE: index is older than the file on disk and cannot be updated this run (the index is read-only here), so read the file directly'

// Prepended instead of STALE_WARNING when the file is not on disk at all. fingerprintFile returns null for "deleted" and for "there but unreadable right now" alike, and staleWarning used to treat both as "nothing to say" -- so a read of a deleted file returned its indexed body, byte-identical to a live read, exit 0, with no sign the file was gone. That is the worst shape this tool can take: the caller goes on to edit or quote a file that no longer exists. Only a genuine absence gets this line; a lock or permission error still falls through silently, because that file really is still there and the index really may still match it.
const DELETED_WARNING =
  '⚠ DELETED: this file is no longer on disk — what follows is what the index last saw of it'

/** Is `absPath` gone from disk? Used to tag index rows that outlived their file. Absolute paths only. A bare `symbol NAME` searches every indexed project, so a relative path would be resolved against whatever directory the command happened to run in -- a live file belonging to another project would then read as missing and get labelled deleted. Indexed rows store absolute paths, so this costs nothing in practice; it only refuses to guess when a caller hands over a path whose meaning depends on the current directory. Saying nothing is the right answer there: a false "this file is gone" is worse than the silence this whole change replaces. */
export function fileIsGone(absPath: string): boolean {
  // A relative path would be resolved against the current directory, which for a symbol search spanning every indexed project is the wrong one -- so it is never judged. Past that, fileIsAbsent answers ENOENT and only ENOENT: a file that is present but unreadable stays silent, the same as before.
  if (!path.isAbsolute(absPath)) return false
  return fileIsAbsent(absPath)
}

/** What {@link DELETED_WARNING} says, as a suffix rather than a banner, for surfaces that render one line per match (`symbol`, `refs`) and cannot put a banner above a single row. */
export const DELETED_TAG = '⚠ DELETED: file no longer on disk'

/** Stable reorder that moves rows whose file is gone from disk after every live row, keeping each group's incoming order. Rows outlive their file for as long as sweepKnownRoots' missing-root grace (a deleted worktree looks like an unmounted disk), and a deleted checkout named `proj-wt/` sorts ahead of `proj/` because `-` precedes `/`, so without this the first answer a caller read was the dead copy. Nothing is dropped: the gone rows still print, tagged {@link DELETED_TAG}. */
export function sinkGoneRows<T>(rows: readonly T[], pathOf: (row: T) => string): T[] {
  const gone = new Map<string, boolean>()
  const isGone = (row: T): boolean => {
    const p = pathOf(row)
    let g = gone.get(p)
    if (g === undefined) {
      g = fileIsGone(p)
      gone.set(p, g)
    }
    return g
  }
  const live = rows.filter((r) => !isGone(r))
  return live.length === rows.length ? [...rows] : [...live, ...rows.filter(isGone)]
}

/** Returns the STALE_WARNING line (plus trailing newline) when `resolvedPath`'s current on-disk SHA-256 differs from the SHA-256 stamped on its `files` row at the time it was last indexed, the DELETED_WARNING line when the file is gone from disk entirely, or '' when they match, the file isn't indexed, or the file is present but momentarily unreadable. Cheap by design: a single fs.readFileSync + hash, not a reparse, so it's safe to call on every read/outline/skeleton/symbol lookup. A caller serving its answer from these rows passes its command name as `servedBy`, which books the answer through {@link recordStaleServed}; a caller only asking the question (a heal loop) leaves it out. */
export function staleWarning(resolvedPath: string, servedBy?: string): string {
  const state = indexFreshness(resolvedPath)
  if (servedBy !== undefined) recordStaleServed(servedBy, state)
  if (state === 'deleted') return `${DELETED_WARNING}\n`
  if (state === 'fresh') return ''
  return `${isReadOnlyDb(globalDbPath()) ? STALE_READ_ONLY_WARNING : STALE_WARNING}\n`
}

/** How a file's index rows compare with the file on disk, the judgement {@link staleWarning} renders: 'deleted' when the file is gone, 'stale' when its bytes no longer match the SHA its rows were indexed from, 'fresh' otherwise, including a file that is not indexed or is present but momentarily unreadable. */
export type IndexFreshness = 'fresh' | 'stale' | 'deleted'

export function indexFreshness(resolvedPath: string): IndexFreshness {
  const entry = getFileEntry(resolvedPath)
  // A sha-less row is not an indexed file (see indexMatchesDisk), and it stays quiet here for the same reason entry === null does: "stale" says the index holds an older version of this file, which is a different and more alarming claim than "this file is not indexed", and the caller's own no-symbols message already covers the latter. This is the one place the two cases should agree, so it is deliberately NOT the false-means-stale treatment the other two readers now give a sha-less row.
  if (entry === null || entry.sha === '') return 'fresh'
  const diskSha = fingerprintFile(resolvedPath)
  if (diskSha === null) {
    // Separate the two reasons fingerprintFile gives up. Gone from disk is a fact worth saying out loud; unreadable-right-now is transient and stays quiet as before.
    return fileIsGone(resolvedPath) ? 'deleted' : 'fresh'
  }
  return diskSha === entry.sha ? 'fresh' : 'stale'
}

/** Books one `stale_served:<state>` event in the stats ledger for an answer served from index rows that no longer match the disk, with the serving command as the row's detail. One event per answer, not per file: the count says how often a reply carried an old answer, which is what the warnings in the reply itself cannot add up. Zero bytes and zero tokens, since serving an old answer saves nothing. A fresh answer books nothing. */
export function recordStaleServed(command: string, state: IndexFreshness): void {
  if (state === 'fresh') return
  recordStat(`stale_served:${state}`, 0, 0, undefined, command)
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

/** Self-heal AND warn for a multi-file command's own result set, the sibling of the `healStaleIndex`+`staleWarning` pair every single-file surgical-read command already runs, for the shape `refs`/`ask`/`semantic`/`trace --bodies`/`locate` have instead: several distinct result files from one query, none of which the caller named directly, so there is no one file to check before the query the way `runSymbol` checks the file in its spec. This answers stale rows exactly as loudly as those commands do -- console.warn rather than folded into the JSON body, so JSON consumers get an unambiguous stdout payload while still seeing the warning on stderr -- rather than the silent behavior these commands had before: a wrong answer with no warning is worse than a slow one, and warning-then-still-answering is what every single-file command here already does. MUST be called with the files a query's results actually came from, AFTER that query already ran (mirrors `healStaleIndex`'s own contract: it does not re-fetch anything, so healing here only benefits the *next* call to this command, same as the single-file commands above). `servedBy` names the command, which books the answer through {@link recordStaleServed}. */
export function warnIfFilesStale(filePaths: readonly string[], servedBy: string): void {
  const checked = new Set<string>()
  let staleCount = 0
  let goneCount = 0
  for (const raw of filePaths) {
    if (checked.size >= STALE_CHECK_FILE_CAP) break
    if (checked.has(raw)) continue
    checked.add(raw)
    // A gone file is not "changed on disk", and no reindex can make a repeat current: it would only delete the rows. Counted apart so the note below says what is true of it.
    if (fileIsGone(raw)) {
      goneCount++
      continue
    }
    if (staleWarning(raw) === '') continue
    staleCount++
    // healStaleIndex is best-effort for ordinary parse/I/O failures already; only a detected between-check-and-use path swap (ConfinementIdentityError) is meant to escape it, and that is a real security-relevant condition this wrapper must not paper over either.
    healStaleIndex(raw)
  }
  if (staleCount > 0) recordStaleServed(servedBy, 'stale')
  if (goneCount > 0) recordStaleServed(servedBy, 'deleted')
  if (staleCount > 0) {
    const after = isReadOnlyDb(globalDbPath())
      ? 'the index is read-only this run, so these results are from the older version.'
      : 'a reindex just ran, so a repeat of this command will reflect the current version.'
    console.warn(`token-goat: ${countNoun(staleCount, 'file')} behind these results changed on disk since the index last saw ${staleCount === 1 ? 'it' : 'them'} -- ${after}`)
  }
  if (goneCount > 0) {
    console.warn(`token-goat: ${countNoun(goneCount, 'file')} behind these results ${goneCount === 1 ? 'is' : 'are'} no longer on disk -- results from ${goneCount === 1 ? 'it' : 'them'} are what the index last saw.`)
  }
}

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

/** Per-field variant for the `pr-slice --json` envelopes, still gated on a scan hit. Fencing the envelope once would be O(1) and provenance-correct, but a fence wrapped around JSON is no longer JSON, and `--json` output is parsed by callers; fencing each field unconditionally instead pays a fixed ~129-byte wrapper per field, which a short comment body or a PR title does not absorb. Same deliberate exception as `fenceFileFieldIfMatched` in cli_office.ts, and it needs the same wire-format decision to resolve. */
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

/** The "you are not seeing all of it" line for a text-mode result set, or an empty string when nothing was dropped. `--json` has always carried an honest `totalCount`; text mode rendered exactly `limit` rows and stopped, which is indistinguishable from "that is all there is" -- `symbol dup` printed 20 definitions of 40 with nothing on stdout or stderr to say so. Same no-silent-caps rule the `refs --top` summary and `json-outline`'s `--head` note already follow. `total` is a thunk because computing it costs another count query, and it is only worth paying when the page came back full: a result set shorter than the limit cannot have been truncated. Appended after `guardText`, so the overflow guard cannot trim off the very line that explains the trimming. */
export function truncationFooter(shown: number, limit: number, total: () => TruncationTotal, plural: string, flag: string): string {
  const notice = truncationNotice(shown, limit, total, plural, flag)
  return notice === null ? '' : `\n\ntoken-goat: ${notice}`
}

/** The honest total behind a truncated page. `exact: false` means the count came from a bounded client-side scan (`--grep`, `--exclude-tests`) that itself filled up, so `count` is a floor and not a total: saying "of 20000" there would trade one silent cap for a confident wrong number. */
export interface TruncationTotal {
  count: number
  exact: boolean
}

/** The sentence {@link truncationFooter} wraps, or null when nothing was dropped. See its doc comment. */
export function truncationNotice(shown: number, limit: number, total: () => TruncationTotal, plural: string, flag: string): string | null {
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
    const resolved = resolveSpecPath(file, opts.projectRoot ?? process.cwd())
    // Query a bounded superset (FIND_SCAN_LIMIT) scoped to this one file, THEN rank by similarity and cap at DIDYOUMEAN_LIMIT -- capping in the query itself would return an arbitrary storage-order first-N that can omit the actual closest match entirely.
    const scanned = querySymbols({ filePath: resolved, limit: FIND_SCAN_LIMIT }).map((s) => s.name)
    const qualified = symbol.includes('.') ? qualifiedSpellings(resolved, symbol.slice(symbol.lastIndexOf('.') + 1)) : []
    const closes = qualified.length > 0 ? qualified : rankSimilarNames(scanned, symbol)
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
    recordStaleServed('read', indexFreshness(match.filePath))
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
  const warning = staleWarning(match.filePath, 'read')
  // Appended after the overflow guard, not folded into the guarded lines, so this advisory note never shifts the "showing N of M lines" count the guard reports for the actual body.
  const narrowerSliceHint = bodyLen > LARGE_SYMBOL_LINE_THRESHOLD
    ? `\n# for a narrower slice: token-goat grep "<pattern>" ${file} -C 15 --symbol`
    : ''
  const text = guardText(warning + trimBlankLines(lines).join('\n'), 'symbol') + narrowerSliceHint
  if (opts.suppressStat !== true) recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
  return { text, code: 0 }
}

/** Handle ``token-goat read "file::a,b,c"`` -- fetch several symbol bodies from one file in a single call, mirroring `refs`'s comma-separated multi-symbol grammar (see `read_refs.ts::parseMultiRefsSpec`). Delegates each symbol to a recursive {@link runRead} call (`suppressStat: true`) rather than reimplementing resolution, so ambiguity handling, not-found + did-you-mean, and JSON shape all come from the exact same code path the single-symbol form already exercises -- a failure to resolve one symbol is reported inline instead of aborting the whole call, same as `runRefs`'s per-symbol handling. */
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
    const fullSourceBytes = sumFileSizes(Array.from(distinctFiles, (f) => resolveSpecPath(f, opts.projectRoot ?? process.cwd())))
    const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
    recordReadStat('read_replacement', fullSourceBytes, text, opts.spec)
    return { text, code: 0 }
  }

  const text = opts.json === true ? displaySafeJson(jsonOut) : textBlocks.join('\n\n')
  return { text, code: 1 }
}

// ---- section ----------------------------------------------------------------

/** The base a relative file path resolves against on disk. Resolves against `projectRoot` only when one was explicitly given AND the path is relative: an absolute path, or the no-projectRoot default every CLI caller takes, is returned untouched so those paths stay byte-identical to the long-standing behavior of resolving against `process.cwd()` inside the read helpers themselves. This is the execution-side half of the MCP confinement invariant (see `resolveToolRoot` in mcp_server.ts): the gate admits a relative target by resolving it against the project root, so every disk read on that path must resolve it against the same root or the check guards a different file than the one served. The typed spelling first goes through expandSpecPath, the same front end resolveSpecPath applies for the index key, so `~/x` and a Git Bash `/c/x` open the file `read` and `outline` already look up; the MCP gate expands it the same way before measuring it. */
export function resolveAgainstProjectRoot(file: string, projectRoot: string | undefined): string {
  const f = expandSpecPath(file)
  return projectRoot !== undefined && !path.isAbsolute(f) ? path.resolve(projectRoot, f) : f
}

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
    emitErr(formatCommandError(`Invalid slice '${opts.slice}' -- expected one of: files, diff:<path>, comments, description`))
    return 1
  }

  if (!isGhAvailable()) {
    emitErr(formatCommandError('gh (GitHub CLI) not found on PATH -- install it from https://cli.github.com and run `gh auth login`'))
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
      emitErr(formatCommandError("Could not resolve a GitHub repo from the current directory's git remote 'origin' -- pass --repo owner/repo"))
      return 1
    }
    repo = resolved
  }

  // Checked after resolution rather than at argument parsing, so it covers both routes into `repo`: the `--repo` flag and the slug derived from the git remote. The remote route is the one that matters, because a repository controls its own `origin` URL and the slug lands in a `gh api` path sent with the user's token.
  if (!isSafeRepoSlug(repo)) {
    emitErr(formatCommandError(`"${repo}" is not a plain owner/name repository slug -- pass --repo owner/repo`))
    return 1
  }
  if (!isSafePrNumber(opts.pr)) {
    emitErr(formatCommandError(`"${opts.pr}" is not a pull request number`))
    return 1
  }

  if (!isGhAuthenticated()) {
    emitErr(formatCommandError('gh is not authenticated -- run `gh auth login`'))
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
          emitErr(formatCommandError(`No diff found for '${parsed.path}' in PR #${opts.pr}`))
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
    emitErr(formatCommandError(e))
    return 1
  }
}

// ---- pdf / image / screenshot ------------------------------------------------

/** The bytes of a PDF the caller named, refused when the file alone is past the input bound. */
async function readPdfBytes(file: string): Promise<Uint8Array> {
  if (!pathExists(file)) {
    throw new Error(`Could not read: ${file}`)
  }
  return readPdfFileWithinBounds(file)
}

/** Thin async wrapper: reads the PDF off disk and extracts its text. Kept separate from the synchronous run*(opts): number handlers above because pdfjs-dist's parser is async; the caller (cli_office.ts's cmdPdfExtract) drives it through guard() (which supports async actions) rather than runExit (sync-only). Throws on error, matching this file's extractPdfText contract, rather than returning an exit code. */
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
  /** Set when the format has a decoder but it refused this file (a 16-bit or interlaced PNG): the shrink was not attempted, which is not the same as having no benefit. Null otherwise. */
  shrinkRefusal: string | null
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
    return { width: 0, height: 0, format: null, bytes, decodable: false, shrinkable: false, wouldShrink: false, shrunkBytes: null, shrinkRefusal: null }
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
    shrinkRefusal: shrinkable && shrink === null ? decoderRefusal(data, probe.format) : null,
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
    emitErr(formatCommandError(`Invalid regex: ${opts.pattern} -- ${guarded.reason}`))
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
    if (!pathExists(searchPath)) {
      emitErr(formatCommandError(`Path not found: ${searchPath}`))
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
    emitErr(formatCommandError(`No matches for '${opts.pattern}'`))
    return 1
  }

  const truncated = hits.slice(0, maxLines)

  if (opts.symbol === true) {
    // Memoize querySymbols per file so N hits in the same file cost one DB query, not N.
    const symbolsByFile = new Map<string, ReturnType<typeof querySymbols>>()
    for (const hit of truncated) {
      let syms = symbolsByFile.get(hit.file)
      if (syms === undefined) {
        syms = querySymbols({ filePath: resolveSpecPath(hit.file), limit: ALL_SYMBOLS_IN_FILE_LIMIT })
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
    emitErr(`... (${countNoun(hits.length - maxLines, 'more line')} omitted)`)
    emitErr(`Tip: To avoid broad grepping and reduce token expenditure, locate specific symbols with:`)
    emitErr(`  token-goat symbol <name>`)
    emitErr(`  token-goat locate <name>`)
    emitErr(`  token-goat outline <file> / token-goat skeleton <file>`)
  }

  return 0
}
