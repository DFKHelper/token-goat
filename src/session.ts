/**
 * In-memory session state.
 *
 * Ports the session-tracking concepts from `session.py`: which files were
 * read/edited this session, which hints have already fired (so they are not
 * repeated), and the URL/command -> cache-id indexes for web-fetch and
 * bash-output dedup. This module owns the live state in Maps/Sets, cleared
 * between tests via {@link registerReset}.
 *
 * Each Claude Code hook runs as a separate `token-goat hook` process, so these
 * Maps would not survive between tool calls on their own. `session_store.ts`
 * persists them across processes, mirroring the JSON `SessionCache` the Python
 * implementation kept keyed by session ID: `relay` hydrates this state via
 * {@link importSessionState} before a hook runs and writes it back via
 * {@link exportSessionState} afterward.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

import { normalizePath } from './paths.js'
import { registerReset } from './reset.js'
import { foldPath } from './util.js'

/**
 * Tracks reads/edits of a single file within the session.
 *
 * Mirrors the load-bearing fields of `session.py::FileEntry` used by the
 * re-read dedup hint: read count, last-read timestamp, whether the file was
 * edited (which invalidates any cached read window), and its size at last read.
 */
export interface FileEntry {
  /** Normalized absolute path, case-preserved -- also the literal `_files` map key for this entry's first-seen casing. See {@link resolveFilesKey} for how a later read of the same physical file under different casing (case-insensitive filesystems) still resolves to this same entry. */
  readonly path: string
  /** Number of times Read fired for this file this session. */
  readonly readCount: number
  /** Unix-ms timestamp of the most recent read. */
  readonly lastReadAt: number
  /** True once Write/Edit fired on this file this session. */
  readonly wasEdited: boolean
  /** File size in bytes captured at the last read (0 if unreadable). */
  readonly sizeBytes: number
  /** True when a Read result contained a truncation marker ([Truncated:). */
  readonly wasTruncated?: boolean
  /**
   * Symbol/section/range tokens this file was read *surgically* by this session
   * (via `token-goat read|section "file::symbol"` and friends), as opposed to a
   * whole-file Read. Non-empty means the file was engaged with narrowly, which
   * compact.ts's `computeAdaptiveBudget` rewards with a manifest-budget bonus.
   * Populated by {@link recordSymbolRead}; never touched by
   * {@link recordFileRead} (whole-file Read tracking is unchanged).
   */
  readonly symbols_read?: string[]
}

// path -> entry. The key is the normalized absolute path so a file referenced via different relative strings collapses to one entry.
let _files = new Map<string, FileEntry>()

// Snapshot of each file's readCount at hydration time, so session_store.ts's merge can tell "this process's own genuinely new reads since load" apart from "whatever was already on disk" -- Math.max(disk, mem) silently drops a concurrent process's distinct increment whenever the two values happen to coincide (see mergeFileEntry in session_store.ts).
let _filesAtLoad = new Map<string, number>()

// Hint fingerprints already emitted this session (dedup, matches session.py mark_hint_seen / has_hint_fingerprint).
let _hintsShown = new Set<string>()

// url -> cacheId index for web-fetch dedup.
let _webFetches = new Map<string, string>()

// commandHash -> outputId index for bash-output dedup.
let _bashOutputs = new Map<string, string>()

// `${pattern}::${path}::${outputMode}::${glob}` signature -> match count, for Grep dedup-hint
// recall (an identical Grep repeated later in the session, above hints.grep_dedup_min_matches).
let _grepQueries = new Map<string, number>()

// Last-seen "Tab Context:" block text from a browser-automation MCP tool result this session, for hooks_browser_image.ts's dedup: an identical repeat gets shortened to a placeholder instead of resending the full open-tab list.
let _lastTabContext: string | null = null
// Command hashes (same key space as _bashOutputs, i.e. the stripped-command hash used by recordBashOutput/getBashOutputId) for which a store call overwrote an already-present entry this session -- i.e. an older cached run under this exact key was beaten by a newer one. Used only by hooks_compact.ts's SAFE_TO_DISCARD manifest section to identify raw transcript copies that are provably superseded by the surviving cached id.
let _bashReruns = new Set<string>()

// url -> saved file path for curl -o download dedup (Item 2).
let _curlDownloads = new Map<string, string>()

// path (as written on the sed command line) -> served inclusive line ranges this session, for overlap detection across repeated `sed -n 'N,Mp'` reads.
let _fileLineRanges = new Map<string, Array<[number, number]>>()

// `${sub}::${spec}` keys for `token-goat symbol|read|section` invocations already run this session (CLI-side re-read dedup).
let _cliReads = new Set<string>()

// path -> size (bytes) for a large-file hint fired but not yet resolved as followed/ignored (opt-in outcome logging, consume-on-resolve).
let _pendingLargeFileHints = new Map<string, number>()

// Snapshot of `_pendingLargeFileHints` at hydration time, so `consumedPendingLargeFileHintKeys` can tell "this process resolved it" apart from "this process never saw it" — session_store.ts's merge needs that distinction to avoid resurrecting a resolved hint from a stale disk read.
let _pendingLargeFileHintsAtLoad = new Map<string, number>()

// Resolved once per process: env-provided session id or a generated one.
let _sessionId: string | null = null

/**
 * Best-effort file size in bytes, or 0 when the file cannot be stat'd.
 *
 * Never throws: a missing/locked file simply records size 0 so the read is
 * still tracked for dedup.
 */
function fileSize(absPath: string): number {
  try {
    return fs.statSync(absPath).size
  } catch {
    return 0
  }
}

/**
 * Resolve `normalized` to the literal key already used in `_files`, falling back to a
 * case-folded scan only when no exact match exists.
 *
 * `_files`'s primary key stays case-preserved (not folded) rather than folding it outright,
 * because `getSessionFiles()` exposes the raw map and hooks_read.ts's re-read-count branch does
 * a direct `getSessionFiles().get(normalized)` lookup with its own `normalizePath(filePath)` --
 * folding the stored key out from under that direct lookup would break it even for the common
 * case of the identical path queried twice. normalizePath only lowercases the drive letter, so
 * without this fallback, a second Read of the SAME physical file under different casing beyond
 * the drive letter (e.g. "Worker.ts" vs "worker.ts" -- Windows/macOS filesystems are
 * case-insensitive) would create a second, separate entry instead of being recognized as the
 * existing one. The fallback scan is bounded by the small, capped number of files tracked per
 * session (see session_store.ts's capFiles).
 */
function resolveFilesKey(normalized: string): string {
  if (_files.has(normalized)) return normalized
  const folded = foldPath(normalized)
  if (folded === normalized) return normalized
  for (const existingKey of _files.keys()) {
    if (foldPath(existingKey) === folded) return existingKey
  }
  return normalized
}

/**
 * Record that `filePath` was read.
 *
 * First read creates an entry; subsequent reads increment `readCount` and
 * refresh `lastReadAt` / `sizeBytes` while preserving the `wasEdited` flag.
 */
export function recordFileRead(filePath: string): void {
  const normalized = normalizePath(filePath)
  const key = resolveFilesKey(normalized)
  const now = Date.now()
  const size = fileSize(normalized)
  const prev = _files.get(key)
  if (prev === undefined) {
    _files.set(key, {
      path: key,
      readCount: 1,
      lastReadAt: now,
      wasEdited: false,
      sizeBytes: size,
    })
    return
  }
  _files.set(key, {
    ...prev,
    readCount: prev.readCount + 1,
    lastReadAt: now,
    sizeBytes: size,
  })
}

/** Upper bound on distinct symbol tokens tracked per file, so a session that reads many symbols of one file can't grow its entry unboundedly. */
const MAX_SYMBOLS_PER_FILE = 25

/**
 * Record that `filePath` was read *surgically* (by symbol/section/range) this
 * session, e.g. via `token-goat read "file::symbol"`. This is deliberately
 * separate from {@link recordFileRead}: a surgical CLI read is not a whole-file
 * Read tool fire, so it must NOT bump `readCount` (that field means Read-tool
 * hits). It records the narrowing token on the file's entry so the compaction
 * manifest can reward files that were engaged with narrowly. If the file has no
 * entry yet (surgically read but never Read-tooled), a `readCount: 0` entry is
 * created so the read is still represented; otherwise the existing entry is
 * annotated in place, leaving its read/edit state untouched.
 */
export function recordSymbolRead(filePath: string, symbol: string): void {
  const normalized = normalizePath(filePath)
  const key = resolveFilesKey(normalized)
  const prev = _files.get(key)
  if (prev === undefined) {
    _files.set(key, {
      path: key,
      readCount: 0,
      lastReadAt: Date.now(),
      wasEdited: false,
      sizeBytes: fileSize(normalized),
      symbols_read: [symbol],
    })
    return
  }
  const existing = prev.symbols_read ?? []
  if (existing.includes(symbol)) return
  const symbols_read = [...existing, symbol].slice(-MAX_SYMBOLS_PER_FILE)
  _files.set(key, { ...prev, symbols_read })
}

/** Snapshot of each file's readCount exactly as it was at hydration time, before this process
 * made any changes. session_store.ts's merge uses this to compute how many *new* reads this
 * process actually contributed since its own load, rather than assuming the larger of the two
 * counters reflects every read that ever happened -- two concurrent processes that both start
 * from the same on-disk count and each record one genuine read must sum to two, not one. */
export function filesReadCountAtLoad(): ReadonlyMap<string, number> {
  return _filesAtLoad
}

/**
 * Record that `filePath` was edited/written.
 *
 * Sets `wasEdited` true. If the file was never read this session an entry is
 * created with `readCount` 0 so the edit is still tracked. Also drops any
 * previously recorded sed line-range history for the file (see
 * {@link recordFileLineRange}): an edit shifts line numbers and content, so a
 * pre-edit range can no longer be trusted by hooks_bash.ts's overlap check.
 */
export function recordFileEdit(filePath: string): void {
  const normalized = normalizePath(filePath)
  const key = resolveFilesKey(normalized)
  _fileLineRanges.delete(foldPath(normalized))
  const prev = _files.get(key)
  if (prev === undefined) {
    _files.set(key, {
      path: key,
      readCount: 0,
      lastReadAt: 0,
      wasEdited: true,
      sizeBytes: fileSize(normalized),
    })
    return
  }
  _files.set(key, { ...prev, wasEdited: true })
}

/** Return all tracked file entries, keyed by normalized absolute path. */
export function getSessionFiles(): ReadonlyMap<string, FileEntry> {
  return _files
}

/**
 * True if `filePath` was read at least once this session (`readCount > 0`).
 *
 * A file that was only edited (never read) returns false, matching the
 * re-read-hint semantics: there is no prior read to dedup against.
 */
export function wasFileReadThisSession(filePath: string): boolean {
  const entry = _files.get(resolveFilesKey(normalizePath(filePath)))
  return entry !== undefined && entry.readCount > 0
}

/**
 * Case-fold-aware lookup of a file's session entry -- resolves `filePath` through
 * {@link resolveFilesKey} the same way `recordFileRead`/`wasFileReadThisSession` do, so a
 * caller that only has a differently-cased path than the one first recorded (case-insensitive
 * filesystems) still finds the existing entry instead of missing it. Use this instead of a
 * direct `getSessionFiles().get(filePath)` for any single-entry lookup.
 */
export function getSessionFileEntry(filePath: string): FileEntry | undefined {
  return _files.get(resolveFilesKey(normalizePath(filePath)))
}

/** True if `hintKey` has already been marked shown this session. */
export function wasHintShown(hintKey: string): boolean {
  return _hintsShown.has(hintKey)
}

/** Mark `hintKey` as shown so a later {@link wasHintShown} returns true. */
export function markHintShown(hintKey: string): void {
  _hintsShown.add(hintKey)
}

/** True if `cliReadKey` (a `token-goat symbol|read|section` invocation) already ran this session. */
export function wasCliReadThisSession(cliReadKey: string): boolean {
  return _cliReads.has(cliReadKey)
}

/** Record that a `token-goat symbol|read|section` invocation ran this session. */
export function recordCliRead(cliReadKey: string): void {
  _cliReads.add(cliReadKey)
}

/** Record that a large-file hint fired for `filePath` (size in bytes), pending an outcome resolution. */
export function recordLargeFileHintPending(filePath: string, sizeBytes: number): void {
  _pendingLargeFileHints.set(foldPath(normalizePath(filePath)), sizeBytes)
}

/** Consume and return the pending large-file-hint size for `filePath`, or null if none is pending. */
export function takePendingLargeFileHint(filePath: string): number | null {
  const key = foldPath(normalizePath(filePath))
  const size = _pendingLargeFileHints.get(key)
  if (size === undefined) return null
  _pendingLargeFileHints.delete(key)
  return size
}

/** Keys pending at load but resolved (consumed) since — tombstones for session_store.ts's merge. */
export function consumedPendingLargeFileHintKeys(): string[] {
  const consumed: string[] = []
  for (const key of _pendingLargeFileHintsAtLoad.keys()) {
    if (!_pendingLargeFileHints.has(key)) consumed.push(key)
  }
  return consumed
}

/** Snapshot of pending large-file hints exactly as they were at hydration time, before this
 * process made any changes. session_store.ts's merge uses this to tell "this process merely
 * carried the key from load, untouched" apart from "this process genuinely added or updated
 * it" — an untouched key must defer to the freshest disk read instead of being blindly
 * resurrected if another process legitimately removed it in the meantime. */
export function pendingLargeFileHintsAtLoad(): ReadonlyMap<string, number> {
  return _pendingLargeFileHintsAtLoad
}

/** Index a web-fetch result: (`url`, `prompt`) -> `cacheId`. Keyed on the same
 * url+'\x00'+prompt composite already used for the on-disk cache id (see
 * preFetchHandler/postFetchHandler in hooks_fetch.ts), so two WebFetch calls to the
 * same url with different prompts are tracked as separate entries instead of
 * clobbering each other. */
export function recordWebFetch(url: string, prompt: string, cacheId: string): void {
  _webFetches.set(`${url}\x00${prompt}`, cacheId)
}

/** Return the cache id previously recorded for the (`url`, `prompt`) pair, or null. */
export function getWebFetchCacheId(url: string, prompt = ''): string | null {
  return _webFetches.get(`${url}\x00${prompt}`) ?? null
}

/** Return every web-fetch this session as a `url -> cacheId` map (insertion order). */
export function getSessionWebFetches(): ReadonlyMap<string, string> {
  return _webFetches
}

/**
 * Index a bash-output result: `commandHash` -> `outputId`.
 *
 * `sizeBytes` is accepted to match the spec'd signature; the size itself lives
 * with the full entry in the bash-output cache, so it is not stored here.
 */
export function recordBashOutput(commandHash: string, outputId: string, _sizeBytes: number): void {
  _bashOutputs.set(commandHash, outputId)
}

/** All bash-output cache entries currently tracked this session: [commandHash, outputId] pairs. */
export function getSessionBashOutputs(): Array<[string, string]> {
  return Array.from(_bashOutputs.entries())
}

/** Marks `commandHash` as rerun: a store call overwrote an already-present cached entry under this exact key. */
export function recordBashRerun(commandHash: string): void {
  _bashReruns.add(commandHash)
}

/** Command hashes rerun this session (see {@link recordBashRerun}). */
export function getSessionBashReruns(): string[] {
  return Array.from(_bashReruns)
}

/** Return the output id previously recorded for `commandHash`, or null. */
export function getBashOutputId(commandHash: string): string | null {
  return _bashOutputs.get(commandHash) ?? null
}

/** Record a Grep query's match count: `signature` -> matchCount, for dedup-hint recall. */
export function recordGrepQuery(signature: string, matchCount: number): void {
  _grepQueries.set(signature, matchCount)
}

/** Return the previously recorded match count for `signature`, or null if never seen this session. */
export function getGrepMatchCount(signature: string): number | null {
  return _grepQueries.get(signature) ?? null
}

/** Record the most recent "Tab Context:" block text seen this session, for hooks_browser_image.ts's dedup. */
export function setLastTabContext(text: string): void {
  _lastTabContext = text
}

/** Return the last-recorded "Tab Context:" block text this session, or null if none seen yet. */
export function getLastTabContext(): string | null {
  return _lastTabContext
}

/** Record that a curl -o download saved `url` to `savedPath` this session. */
export function recordCurlDownload(url: string, savedPath: string): void {
  _curlDownloads.set(url, savedPath)
}

/** Return the file path where `url` was saved this session via curl -o, or null. */
export function getCurlDownloadPath(url: string): string | null {
  return _curlDownloads.get(url) ?? null
}

/** Forget a recorded curl -o download for `url` (e.g. its saved file is gone). */
export function clearCurlDownload(url: string): void {
  _curlDownloads.delete(url)
}

/** Cap on retained line ranges per file - bounds memory if one file is paged many times. */
export const MAX_RANGES_PER_FILE = 64

/** Record that inclusive line range [start, end] of `filePath` was served via a sed line-range read this session. Deduplicates identical ranges and caps retained ranges per file. */
export function recordFileLineRange(filePath: string, start: number, end: number): void {
  const key = foldPath(normalizePath(filePath))
  const ranges = _fileLineRanges.get(key) ?? []
  if (ranges.some(([s, e]) => s === start && e === end)) return
  ranges.push([start, end])
  if (ranges.length > MAX_RANGES_PER_FILE) ranges.splice(0, ranges.length - MAX_RANGES_PER_FILE)
  _fileLineRanges.set(key, ranges)
}

/** Inclusive line ranges of `filePath` already served via sed this session (empty if none). */
export function getFileLineRanges(filePath: string): ReadonlyArray<readonly [number, number]> {
  return _fileLineRanges.get(foldPath(normalizePath(filePath))) ?? []
}

/**
 * Mark `filePath` as having been truncated during a Read this session.
 *
 * Called by the post_tool_use Read hook when the tool response contains a
 * `[Truncated:` marker. The next pre_tool_use for the same file will deny
 * with a skeleton/surgical-read hint instead of allowing another full read.
 */
export function markFileTruncated(filePath: string): void {
  const normalized = normalizePath(filePath)
  const key = resolveFilesKey(normalized)
  const prev = _files.get(key)
  if (prev === undefined) {
    _files.set(key, {
      path: key,
      readCount: 1,
      lastReadAt: Date.now(),
      wasEdited: false,
      sizeBytes: fileSize(normalized),
      wasTruncated: true,
    })
    return
  }
  _files.set(key, { ...prev, wasTruncated: true })
}

/** True if the file was truncated during a Read this session. */
export function wasFileTruncatedThisSession(filePath: string): boolean {
  const entry = _files.get(resolveFilesKey(normalizePath(filePath)))
  return entry?.wasTruncated === true
}

/**
 * Generate a random session id when `CLAUDE_CODE_SESSION_ID` is unset.
 *
 * Prefers `crypto.randomUUID` (Node >= 19); falls back to hex from
 * `randomBytes` on older runtimes where `randomUUID` is unavailable.
 */
function generateSessionId(): string {
  try {
    return randomUUID()
  } catch {
    return randomBytes(16).toString('hex')
  }
}

/**
 * Return the session id, resolved once per process.
 *
 * Uses `process.env.CLAUDE_CODE_SESSION_ID` when set and non-empty; otherwise a
 * generated id, cached so repeated calls return the same value.
 */
export function getSessionId(): string {
  if (_sessionId !== null) return _sessionId
  const fromEnv = process.env['CLAUDE_CODE_SESSION_ID']
  _sessionId = fromEnv !== undefined && fromEnv !== '' ? fromEnv : generateSessionId()
  return _sessionId
}

/**
 * The serializable snapshot of session state.
 *
 * Maps are flattened to entry arrays so the shape round-trips through JSON.
 * Consumed by `session_store.ts` to persist state across the per-tool-call hook
 * processes (the Python `SessionCache` JSON this port restores).
 */
export interface SerializedSession {
  files: FileEntry[]
  hintsShown: string[]
  webFetches: Array<[string, string]>
  bashOutputs: Array<[string, string]>
  bashReruns?: string[]
  curlDownloads: Array<[string, string]>
  fileLineRanges?: Array<[string, Array<[number, number]>]>
  cliReads?: string[]
  pendingLargeFileHints?: Array<[string, number]>
  grepQueries?: Array<[string, number]>
  lastTabContext?: string
  /**
   * Unix time in *seconds* at which this session's on-disk cache was first
   * written. Set exactly once by `session_store.ts::saveSessionState` and
   * preserved across every later write, so it marks cache creation, not last
   * modification. compact.ts derives the session-age budget multiplier from it.
   */
  created_ts?: number
}

/** Snapshot the current in-memory session state for persistence. */
export function exportSessionState(): SerializedSession {
  return {
    files: Array.from(_files.values()),
    hintsShown: Array.from(_hintsShown),
    webFetches: Array.from(_webFetches.entries()),
    bashOutputs: Array.from(_bashOutputs.entries()),
    bashReruns: Array.from(_bashReruns),
    curlDownloads: Array.from(_curlDownloads.entries()),
    fileLineRanges: Array.from(_fileLineRanges.entries()),
    cliReads: Array.from(_cliReads),
    pendingLargeFileHints: Array.from(_pendingLargeFileHints.entries()),
    grepQueries: Array.from(_grepQueries.entries()),
    ...(_lastTabContext !== null ? { lastTabContext: _lastTabContext } : {}),
  }
}

/**
 * Replace the in-memory session state with `s` (hydrate from a loaded snapshot).
 *
 * Called once per hook process after loading the on-disk state, before any
 * handler runs. `FileEntry.path` is already the normalized map key, so entries
 * re-key directly. Tolerant of a malformed `path` (skips that entry) but assumes
 * the caller has otherwise validated the shape.
 */
export function importSessionState(s: SerializedSession): void {
  _files = new Map()
  for (const e of s.files) {
    if (e && typeof e.path === 'string') _files.set(e.path, e)
  }
  _filesAtLoad = new Map(Array.from(_files, ([key, e]) => [key, e.readCount]))
  _hintsShown = new Set(s.hintsShown)
  _webFetches = new Map(s.webFetches)
  _bashOutputs = new Map(s.bashOutputs)
  _bashReruns = new Set(s.bashReruns ?? [])
  _curlDownloads = new Map(s.curlDownloads)
  _fileLineRanges = new Map(s.fileLineRanges ?? [])
  _cliReads = new Set(s.cliReads ?? [])
  _pendingLargeFileHints = new Map(s.pendingLargeFileHints ?? [])
  _pendingLargeFileHintsAtLoad = new Map(_pendingLargeFileHints)
  _grepQueries = new Map(s.grepQueries ?? [])
  _lastTabContext = s.lastTabContext ?? null
}

registerReset(() => {
  _files = new Map()
  _filesAtLoad = new Map()
  _hintsShown = new Set()
  _webFetches = new Map()
  _bashOutputs = new Map()
  _bashReruns = new Set()
  _curlDownloads = new Map()
  _fileLineRanges = new Map()
  _cliReads = new Set()
  _pendingLargeFileHints = new Map()
  _pendingLargeFileHintsAtLoad = new Map()
  _grepQueries = new Map()
  _lastTabContext = null
  _sessionId = null
})
