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
import { shortFingerprint } from './fingerprint.js'
import { redactSecrets } from './secret_redact.js'

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

// sessionId -> number of scheduled prompts observed. The prompt marker is a scheduler identifier
// in some hosts, so it cannot reliably represent the number of deliveries.
let _scheduledPromptCounts = new Map<string, number>()

// url -> cacheId index for web-fetch dedup.
let _webFetches = new Map<string, string>()

// commandHash -> outputId index for bash-output dedup.
let _bashOutputs = new Map<string, string>()

// `${pattern}::${path}::${outputMode}::${glob}` signature -> match count, for Grep dedup-hint
// recall (an identical Grep repeated later in the session, above hints.grep_dedup_min_matches).
let _grepQueries = new Map<string, number>()

// `[pattern, path]` signature -> match count, for Glob dedup-hint recall (an identical Glob
// repeated later in the session, above hints.glob_dedup_min_matches). Mirrors _grepQueries.
let _globQueries = new Map<string, number>()

// Last-seen "Tab Context:" block text from a browser-automation MCP tool result this session, for hooks_browser_image.ts's dedup: an identical repeat gets shortened to a placeholder instead of resending the full open-tab list.
let _lastTabContext: string | null = null // fingerprint of the block, never the block; see setLastTabContext
let _seenImageHashes: string[] = []

/** A currently-outstanding Agent-tool (subagent) spawn tracked for hooks_agent_spawn.ts's
 * duplicate-brief detection: the original prompt text (before any briefing/advisory the
 * pre-hook appends) and when it was recorded. */
export interface OutstandingAgentSpawn {
  readonly prompt: string
  readonly ts: number
}

// Prompts of Agent-tool spawns fired this session whose matching post_tool_use has not yet
// arrived. Populated by recordOutstandingAgentSpawn (pre_tool_use), cleared by
// removeOutstandingAgentSpawn (post_tool_use) once the corresponding spawn completes.
let _outstandingAgentSpawns: OutstandingAgentSpawn[] = []

// Snapshot of _outstandingAgentSpawns at hydration time, so session_store.ts's merge can tell
// "this process explicitly removed an entry that was here at load" apart from "this process
// never saw it" -- a plain disk-union merge (like the other pair-list fields use) would silently
// resurrect a removed entry from the pre-update disk snapshot, since removal, unlike every other
// field here, is not a monotonic set-union operation. Mirrors pendingLargeFileHintsAtLoad's role
// for the exact same class of problem.
let _outstandingAgentSpawnsAtLoad: OutstandingAgentSpawn[] = []

// Command hashes (same key space as _bashOutputs, i.e. the stripped-command hash used by recordBashOutput/getBashOutputId) for which a store call overwrote an already-present entry this session -- i.e. an older cached run under this exact key was beaten by a newer one. Used only by hooks_compact.ts's SAFE_TO_DISCARD manifest section to identify raw transcript copies that are provably superseded by the surviving cached id.
let _bashReruns = new Set<string>()

// url -> saved file path for curl -o download dedup (Item 2).
let _curlDownloads = new Map<string, string>()

// Snapshot of `_curlDownloads` at hydration time, so `consumedCurlDownloadKeys` can tell "this
// process explicitly cleared it" apart from "this process never saw it" -- mirrors
// `_pendingLargeFileHintsAtLoad`/`_outstandingAgentSpawnsAtLoad`'s role for the same
// removal-is-not-a-union-op reason: clearCurlDownload's deletion must actually stick, so
// session_store.ts's merge needs this to avoid resurrecting a cleared entry from a stale disk read.
let _curlDownloadsAtLoad = new Map<string, string>()

// path (as written on the sed command line) -> served inclusive line ranges this session, for overlap detection across repeated `sed -n 'N,Mp'` reads.
let _fileLineRanges = new Map<string, Array<[number, number]>>()

// path -> bash-output cache ids whose body this session was actually shown for that file, oldest first. Distinct from `_fileLineRanges`, which stores only line numbers: numbers cannot prove a later read's bytes were already served, because a change token-goat never observed (an external editor, a pull in another terminal) leaves the recorded range in place while the lines behind it move. These ids point at the served text itself, so containment can be decided on the bytes and a stale entry simply fails to match.
let _fileServedOutputs = new Map<string, string[]>()

// Unix-ms of the most recent context compaction (0 = never compacted this session). After Claude Code compacts, the model's context no longer holds any file content it read earlier, so every read whose `lastReadAt` predates this stamp must be treated as NOT read -- see `wasFileReadThisSession`. Stored as a monotonically increasing scalar rather than resetting each entry's `readCount` to 0 because session_store.ts's `mergeFileEntry` reconciles `readCount` as "freshest disk count + this process's own increments since load", so an in-memory reset to 0 contributes a 0 delta and the disk value is handed straight back -- the reset would be silently resurrected across concurrent hook processes. A max-merged scalar has no such resurrection path.
let _compactedAt = 0

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
  // Same reason as the line ranges above: an edit changes the bytes, so a body served before it is no longer evidence of what the file now holds.
  _fileServedOutputs.delete(foldPath(normalized))
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
 * True if `filePath` was read at least once this session (`readCount > 0`) AND that read is
 * still in the model's context (its `lastReadAt` is at or after the last compaction epoch).
 *
 * A file that was only edited (never read) returns false, matching the
 * re-read-hint semantics: there is no prior read to dedup against.
 *
 * This means "content is currently in the model's context", not "this session touched this
 * file at some point" -- consumers that want the historical fact (the compact manifest, stats,
 * hot/recent listings, edit tracking) must read `getSessionFiles()`/`readCount` directly
 * instead of calling this.
 */
export function wasFileReadThisSession(filePath: string): boolean {
  const entry = _files.get(resolveFilesKey(normalizePath(filePath)))
  return entry !== undefined && entry.readCount > 0 && entry.lastReadAt >= _compactedAt
}

/** Unix-ms of the last context compaction this session, or 0 if none. See `_compactedAt`. */
export function getCompactedAt(): number {
  return _compactedAt
}

/** Stamp a context-compaction epoch at `now`, invalidating every earlier read for context-presence purposes. Also clears the sed line-range ledger, which is the same "content is in context" assumption at sub-file granularity. Monotonic: an out-of-order or replayed stamp never moves the epoch backwards. Callers must build anything that depends on the pre-compaction read set (e.g. the compact manifest) BEFORE calling this. */
export function markCompacted(now: number = Date.now()): void {
  if (now <= _compactedAt) return
  _compactedAt = now
  _fileLineRanges = new Map()
  // Same assumption at whole-body granularity: after compaction the served text is no longer in context, so it can no longer justify withholding a later read.
  _fileServedOutputs = new Map()
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

/** Record one scheduled-prompt delivery and return its session-local occurrence number. */
export function recordScheduledPrompt(sessionId: string): number {
  const count = (_scheduledPromptCounts.get(sessionId) ?? 0) + 1
  _scheduledPromptCounts.set(sessionId, count)
  return count
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

/** Field separator inside the composite webFetch session-state key. */
export const WEB_FETCH_KEY_SEP = '\x00'

/**
 * Build the session-state key for a fetched url + prompt.
 *
 * The session-state file is written without storeBlob's redaction pass, so a signed url or one
 * with an embedded api key was persisted in full -- as was the prompt, which can carry a header
 * or token the caller pasted in. Both halves are redacted here.
 *
 * Redaction alone is not a safe key: two urls differing only inside the redacted span collapse
 * to one entry, silently dropping a fetch from the compaction manifest and breaking the exact
 * (url, prompt) lookup contract. A digest of the raw pair is appended to restore identity while
 * the readable, redacted halves stay first -- the manifest displays those (hooks_compact.ts,
 * compact.ts), and both read only the leading fields.
 */
function webFetchKey(url: string, prompt: string): string {
  const digest = shortFingerprint(`${url}${WEB_FETCH_KEY_SEP}${prompt}`)
  return [redactSecrets(url).text, redactSecrets(prompt).text, digest].join(WEB_FETCH_KEY_SEP)
}

/** Index a web-fetch result: (`url`, `prompt`) -> `cacheId`, so two WebFetch calls to the same
 * url with different prompts are tracked separately instead of clobbering each other. */
export function recordWebFetch(url: string, prompt: string, cacheId: string): void {
  _webFetches.set(webFetchKey(url, prompt), cacheId)
}

/** Return the cache id previously recorded for the (`url`, `prompt`) pair, or null. */
export function getWebFetchCacheId(url: string, prompt = ''): string | null {
  return _webFetches.get(webFetchKey(url, prompt)) ?? null
}

/**
 * Rewrite a persisted session-state key written by an older token-goat into the current shape.
 *
 * Old state files on disk hold the pre-redaction spellings: a curl key was the raw url, and a
 * webFetch key was `url\x00prompt` with both halves unredacted. Left alone those rows are worse
 * than useless -- they keep a signed url or an embedded api key sitting in the state file for the
 * life of the session, and every lookup misses because the reader now computes the new key, so a
 * cached fetch is silently re-fetched and re-billed.
 *
 * Migration happens at `coerce()` in session_store.ts, the single boundary every disk read passes
 * through (including the fresh read the save path performs), so no caller has to remember it.
 *
 * Detection is shape-based, not versioned: a current curl key is exactly 16 hex chars, which no
 * url can be, and a current webFetch key has three separator-delimited fields where the legacy
 * one had two. A key already in the current shape is returned unchanged.
 */
export function migrateCurlDownloadKey(key: string): string {
  if (/^[0-9a-f]{16}$/.test(key)) return key
  return curlDownloadKey(key)
}

/** Legacy two-field `url + separator + prompt` key -> the current three-field key. See {@link migrateCurlDownloadKey}. */
export function migrateWebFetchKey(key: string): string {
  const parts = key.split(WEB_FETCH_KEY_SEP)
  if (parts.length !== 2) return key
  return webFetchKey(parts[0] ?? '', parts[1] ?? '')
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

/** Record a Glob query's match count: `signature` -> matchCount, for dedup-hint recall. */
export function recordGlobQuery(signature: string, matchCount: number): void {
  _globQueries.set(signature, matchCount)
}

/** Return the previously recorded match count for `signature`, or null if never seen this session. */
export function getGlobMatchCount(signature: string): number | null {
  return _globQueries.get(signature) ?? null
}

/**
 * Record the most recent "Tab Context:" block seen this session, for hooks_browser_image.ts's dedup.
 *
 * A fingerprint is stored, never the block itself. The only question ever asked of this value is
 * whether the next block is identical to it ({@link lastTabContextMatches}), and a fingerprint
 * answers that exactly. The block does not: it is a list of the tabs open in the user's browser,
 * titles and full URLs, and session state is written to disk, so keeping the text would put
 * whatever a URL happens to carry -- a session token, a signed link, a password-reset parameter --
 * into a file on disk that nothing ever reads back for its content.
 */
export function setLastTabContext(text: string): void {
  _lastTabContext = shortFingerprint(text)
}

/** Whether `text` is the same "Tab Context:" block already seen this session. */
export function lastTabContextMatches(text: string): boolean {
  return _lastTabContext !== null && _lastTabContext === shortFingerprint(text)
}

/**
 * Upper bound on screenshot fingerprints remembered per session.
 *
 * Bounded for the same reason MAX_OUTSTANDING_AGENT_SPAWNS is: a long browsing session takes
 * hundreds of screenshots and this list is written to disk on every hook. Oldest is evicted
 * first, which is also the right policy on merit -- a screenshot from an hour ago being
 * repeated now is a coincidence, while one from three tool calls ago is a poll loop.
 */
export const MAX_SEEN_IMAGE_HASHES = 16

/** True when a screenshot with this fingerprint has already been shown this session. */
export function hasSeenImage(hash: string): boolean {
  return _seenImageHashes.includes(hash)
}

/** Remember a screenshot fingerprint, evicting the oldest once {@link MAX_SEEN_IMAGE_HASHES} is reached. */
export function recordSeenImage(hash: string): void {
  const at = _seenImageHashes.indexOf(hash)
  if (at !== -1) _seenImageHashes.splice(at, 1)
  _seenImageHashes.push(hash)
  if (_seenImageHashes.length > MAX_SEEN_IMAGE_HASHES) {
    _seenImageHashes.splice(0, _seenImageHashes.length - MAX_SEEN_IMAGE_HASHES)
  }
}

/** Upper bound on outstanding Agent-spawn prompts tracked per session; oldest recorded first once exceeded, mirroring MAX_RANGES_PER_FILE's cap-then-evict shape. A long session that spawns many subagents must not grow this list unboundedly. */
export const MAX_OUTSTANDING_AGENT_SPAWNS = 30

/** Record that an Agent-tool spawn with `prompt` (the original prompt text, before any
 * briefing/advisory is appended) is now outstanding this session. Caps the tracked list at
 * {@link MAX_OUTSTANDING_AGENT_SPAWNS}, evicting the oldest entries first. */
export function recordOutstandingAgentSpawn(prompt: string): void {
  _outstandingAgentSpawns.push({ prompt, ts: Date.now() })
  if (_outstandingAgentSpawns.length > MAX_OUTSTANDING_AGENT_SPAWNS) {
    _outstandingAgentSpawns.splice(0, _outstandingAgentSpawns.length - MAX_OUTSTANDING_AGENT_SPAWNS)
  }
}

/** Every Agent-spawn prompt currently outstanding this session (insertion order). */
export function getOutstandingAgentSpawns(): ReadonlyArray<OutstandingAgentSpawn> {
  return _outstandingAgentSpawns
}

/** Remove the outstanding entry whose tracked prompt is a prefix of `finishedPrompt` -- prefix,
 * not exact equality, because preAgentHandler's rewriteInput only ever appends text
 * (briefing/advisory) after the original prompt tracked here, so a completed spawn's actual
 * tool_input prompt always starts with the tracked original. Removes the oldest match first (the
 * earliest still-outstanding entry with that prefix) and is a no-op if none match. */
export function removeOutstandingAgentSpawn(finishedPrompt: string): void {
  const idx = _outstandingAgentSpawns.findIndex((e) => finishedPrompt.startsWith(e.prompt))
  if (idx !== -1) _outstandingAgentSpawns.splice(idx, 1)
}

/** A stable identity key for one outstanding-spawn entry (prompt + record timestamp), used by
 * session_store.ts's merge to tell entries apart even when two distinct spawns share identical
 * prompt text. */
export function outstandingAgentSpawnKey(prompt: string, ts: number): string {
  return `${prompt} ${ts}`
}

/** Snapshot of outstanding Agent-spawn entries exactly as they were at hydration time, before
 * this process made any changes. session_store.ts's merge uses this to compute which entries
 * this process explicitly removed (see {@link consumedOutstandingAgentSpawnKeys}). */
export function outstandingAgentSpawnsAtLoad(): ReadonlyArray<OutstandingAgentSpawn> {
  return _outstandingAgentSpawnsAtLoad
}

/** Keys (see {@link outstandingAgentSpawnKey}) present at load but removed (consumed by
 * {@link removeOutstandingAgentSpawn}) since -- tombstones for session_store.ts's merge, mirroring
 * {@link consumedPendingLargeFileHintKeys} for the same removal-is-not-a-union-op reason. */
export function consumedOutstandingAgentSpawnKeys(): string[] {
  const currentKeys = new Set(_outstandingAgentSpawns.map((e) => outstandingAgentSpawnKey(e.prompt, e.ts)))
  const consumed: string[] = []
  for (const e of _outstandingAgentSpawnsAtLoad) {
    const key = outstandingAgentSpawnKey(e.prompt, e.ts)
    if (!currentKeys.has(key)) consumed.push(key)
  }
  return consumed
}

/** Record that a curl -o download saved `url` to `savedPath` this session. */
/**
 * Key the curl-download map by a digest of the url rather than the url itself.
 *
 * A download url routinely carries a credential -- an `api_key=` query parameter, a signed
 * link's `X-Amz-Signature` -- and this map is serialized verbatim into the session-state file,
 * which is written directly rather than through storeBlob's redaction pass. web_cache.ts
 * already redacts a url for exactly this reason. A digest rather than a redaction because the
 * only consumer is an exact-match lookup that DENIES a repeat download: two urls differing only
 * inside a redacted span would collide and block a legitimate fetch of a different resource.
 * Nothing displays this key, so a digest costs nothing.
 */
function curlDownloadKey(url: string): string {
  return shortFingerprint(url)
}

export function recordCurlDownload(url: string, savedPath: string): void {
  _curlDownloads.set(curlDownloadKey(url), savedPath)
}

/** Return the file path where `url` was saved this session via curl -o, or null. */
export function getCurlDownloadPath(url: string): string | null {
  return _curlDownloads.get(curlDownloadKey(url)) ?? null
}

/** Forget a recorded curl -o download for `url` (e.g. its saved file is gone). */
export function clearCurlDownload(url: string): void {
  _curlDownloads.delete(curlDownloadKey(url))
}

/** Snapshot of curl-download entries exactly as they were at hydration time, before this process
 * made any changes. session_store.ts's merge uses this to compute which entries this process
 * explicitly cleared (see {@link consumedCurlDownloadKeys}). */
export function curlDownloadsAtLoad(): ReadonlyMap<string, string> {
  return _curlDownloadsAtLoad
}

/** URLs present at load but cleared (consumed by {@link clearCurlDownload}) since -- tombstones
 * for session_store.ts's merge, mirroring {@link consumedPendingLargeFileHintKeys} for the same
 * removal-is-not-a-union-op reason. */
export function consumedCurlDownloadKeys(): string[] {
  const consumed: string[] = []
  for (const url of _curlDownloadsAtLoad.keys()) {
    if (!_curlDownloads.has(url)) consumed.push(url)
  }
  return consumed
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
 * Cap on retained served-output ids per file.
 *
 * Deliberately small: every id retained here is a blob the containment check may have to read from
 * disk before it can decide, so this is a bound on that read fan-out and not just on memory. Newest
 * ids are kept, since a later body is the more likely container of the next read of the same file.
 */
export const MAX_SERVED_OUTPUTS_PER_FILE = 8

/** Record that the body cached under `outputId` was served to this session as a read of `filePath`. */
export function recordFileServedOutput(filePath: string, outputId: string): void {
  const key = foldPath(normalizePath(filePath))
  const ids = (_fileServedOutputs.get(key) ?? []).filter((id) => id !== outputId)
  ids.push(outputId)
  if (ids.length > MAX_SERVED_OUTPUTS_PER_FILE) ids.splice(0, ids.length - MAX_SERVED_OUTPUTS_PER_FILE)
  _fileServedOutputs.set(key, ids)
}

/** Cache ids whose body this session was shown as a read of `filePath`, newest last (empty if none). */
export function getFileServedOutputs(filePath: string): readonly string[] {
  return _fileServedOutputs.get(foldPath(normalizePath(filePath))) ?? []
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
  scheduledPromptCounts?: Array<[string, number]>
  webFetches: Array<[string, string]>
  bashOutputs: Array<[string, string]>
  bashReruns?: string[]
  curlDownloads: Array<[string, string]>
  fileLineRanges?: Array<[string, Array<[number, number]>]>
  /** path -> bash-output ids whose body this session was shown as a read of that file, oldest first. Optional: sessions written before this field existed simply have none. */
  fileServedOutputs?: Array<[string, string[]]>
  cliReads?: string[]
  pendingLargeFileHints?: Array<[string, number]>
  grepQueries?: Array<[string, number]>
  globQueries?: Array<[string, number]>
  outstandingAgentSpawns?: Array<[string, number]>
  /** Fingerprint of the last "Tab Context:" block, never the block itself. See `setLastTabContext`. */
  lastTabContextDigest?: string
  /** Fingerprints of screenshots already shown this session, oldest first. See `_seenImageHashes`. */
  seenImageHashes?: string[]
  /** Unix-ms of the most recent context compaction, or absent if none. Merged max-wins by session_store.ts so a stamp made by one hook process is never lost to a concurrent process that predates it. See `_compactedAt`. */
  compactedAt?: number
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
    ...(_scheduledPromptCounts.size > 0 ? { scheduledPromptCounts: Array.from(_scheduledPromptCounts.entries()) } : {}),
    webFetches: Array.from(_webFetches.entries()),
    bashOutputs: Array.from(_bashOutputs.entries()),
    bashReruns: Array.from(_bashReruns),
    curlDownloads: Array.from(_curlDownloads.entries()),
    fileLineRanges: Array.from(_fileLineRanges.entries()),
    ...(_fileServedOutputs.size > 0 ? { fileServedOutputs: Array.from(_fileServedOutputs.entries()) } : {}),
    cliReads: Array.from(_cliReads),
    pendingLargeFileHints: Array.from(_pendingLargeFileHints.entries()),
    grepQueries: Array.from(_grepQueries.entries()),
    globQueries: Array.from(_globQueries.entries()),
    outstandingAgentSpawns: _outstandingAgentSpawns.map((e) => [e.prompt, e.ts]),
    ...(_lastTabContext !== null ? { lastTabContextDigest: _lastTabContext } : {}),
    ...(_seenImageHashes.length > 0 ? { seenImageHashes: [..._seenImageHashes] } : {}),
    ...(_compactedAt > 0 ? { compactedAt: _compactedAt } : {}),
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
  _scheduledPromptCounts = new Map(s.scheduledPromptCounts ?? [])
  _webFetches = new Map(s.webFetches)
  _bashOutputs = new Map(s.bashOutputs)
  _bashReruns = new Set(s.bashReruns ?? [])
  _curlDownloads = new Map(s.curlDownloads)
  _curlDownloadsAtLoad = new Map(_curlDownloads)
  _fileLineRanges = new Map(s.fileLineRanges ?? [])
  _fileServedOutputs = new Map(s.fileServedOutputs ?? [])
  _cliReads = new Set(s.cliReads ?? [])
  _pendingLargeFileHints = new Map(s.pendingLargeFileHints ?? [])
  _pendingLargeFileHintsAtLoad = new Map(_pendingLargeFileHints)
  _grepQueries = new Map(s.grepQueries ?? [])
  _globQueries = new Map(s.globQueries ?? [])
  _outstandingAgentSpawns = (s.outstandingAgentSpawns ?? []).map(([prompt, ts]) => ({ prompt, ts }))
  _outstandingAgentSpawnsAtLoad = [..._outstandingAgentSpawns]
  _lastTabContext = s.lastTabContextDigest ?? null
  _seenImageHashes = [...(s.seenImageHashes ?? [])]
  _compactedAt = s.compactedAt ?? 0
}

registerReset(() => {
  _files = new Map()
  _filesAtLoad = new Map()
  _hintsShown = new Set()
  _scheduledPromptCounts = new Map()
  _webFetches = new Map()
  _bashOutputs = new Map()
  _bashReruns = new Set()
  _curlDownloads = new Map()
  _curlDownloadsAtLoad = new Map()
  _fileLineRanges = new Map()
  _fileServedOutputs = new Map()
  _cliReads = new Set()
  _pendingLargeFileHints = new Map()
  _pendingLargeFileHintsAtLoad = new Map()
  _grepQueries = new Map()
  _globQueries = new Map()
  _outstandingAgentSpawns = []
  _outstandingAgentSpawnsAtLoad = []
  _lastTabContext = null
  _seenImageHashes = []
  _compactedAt = 0
  _sessionId = null
})
