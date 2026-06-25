/**
 * In-memory session state.
 *
 * Ports the session-tracking concepts from `session.py` to a process-local,
 * in-memory model: which files were read/edited this session, which hints have
 * already fired (so they are not repeated), and the URL/command -> cache-id
 * indexes for web-fetch and bash-output dedup.
 *
 * The Python implementation persists a `SessionCache` to JSON keyed by session
 * ID; this TypeScript port keeps the same observable behavior within a single
 * process using Maps/Sets, cleared between tests via {@link registerReset}.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

import { normalizePath } from './paths.js'
import { registerReset } from './reset.js'

/**
 * Tracks reads/edits of a single file within the session.
 *
 * Mirrors the load-bearing fields of `session.py::FileEntry` used by the
 * re-read dedup hint: read count, last-read timestamp, whether the file was
 * edited (which invalidates any cached read window), and its size at last read.
 */
export interface FileEntry {
  /** Normalized absolute path (the dedup map key). */
  readonly path: string
  /** Number of times Read fired for this file this session. */
  readonly readCount: number
  /** Unix-ms timestamp of the most recent read. */
  readonly lastReadAt: number
  /** True once Write/Edit fired on this file this session. */
  readonly wasEdited: boolean
  /** File size in bytes captured at the last read (0 if unreadable). */
  readonly sizeBytes: number
}

// path -> entry. The key is the normalized absolute path so a file referenced
// via different relative strings collapses to one entry.
let _files = new Map<string, FileEntry>()

// Hint fingerprints already emitted this session (dedup, matches
// session.py mark_hint_seen / has_hint_fingerprint).
let _hintsShown = new Set<string>()

// url -> cacheId index for web-fetch dedup.
let _webFetches = new Map<string, string>()

// commandHash -> outputId index for bash-output dedup.
let _bashOutputs = new Map<string, string>()

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
 * Record that `filePath` was read.
 *
 * First read creates an entry; subsequent reads increment `readCount` and
 * refresh `lastReadAt` / `sizeBytes` while preserving the `wasEdited` flag.
 */
export function recordFileRead(filePath: string): void {
  const key = normalizePath(filePath)
  const now = Date.now()
  const size = fileSize(key)
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
    path: key,
    readCount: prev.readCount + 1,
    lastReadAt: now,
    wasEdited: prev.wasEdited,
    sizeBytes: size,
  })
}

/**
 * Record that `filePath` was edited/written.
 *
 * Sets `wasEdited` true. If the file was never read this session an entry is
 * created with `readCount` 0 so the edit is still tracked.
 */
export function recordFileEdit(filePath: string): void {
  const key = normalizePath(filePath)
  const prev = _files.get(key)
  if (prev === undefined) {
    _files.set(key, {
      path: key,
      readCount: 0,
      lastReadAt: 0,
      wasEdited: true,
      sizeBytes: fileSize(key),
    })
    return
  }
  _files.set(key, {
    path: prev.path,
    readCount: prev.readCount,
    lastReadAt: prev.lastReadAt,
    wasEdited: true,
    sizeBytes: prev.sizeBytes,
  })
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
  const entry = _files.get(normalizePath(filePath))
  return entry !== undefined && entry.readCount > 0
}

/** True if `hintKey` has already been marked shown this session. */
export function wasHintShown(hintKey: string): boolean {
  return _hintsShown.has(hintKey)
}

/** Mark `hintKey` as shown so a later {@link wasHintShown} returns true. */
export function markHintShown(hintKey: string): void {
  _hintsShown.add(hintKey)
}

/** Index a web-fetch result: `url` -> `cacheId`. */
export function recordWebFetch(url: string, cacheId: string): void {
  _webFetches.set(url, cacheId)
}

/** Return the cache id previously recorded for `url`, or null. */
export function getWebFetchCacheId(url: string): string | null {
  return _webFetches.get(url) ?? null
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

/** Return the output id previously recorded for `commandHash`, or null. */
export function getBashOutputId(commandHash: string): string | null {
  return _bashOutputs.get(commandHash) ?? null
}

/**
 * Generate a random session id when `CLAUDE_SESSION_ID` is unset.
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
 * Uses `process.env.CLAUDE_SESSION_ID` when set and non-empty; otherwise a
 * generated id, cached so repeated calls return the same value.
 */
export function getSessionId(): string {
  if (_sessionId !== null) return _sessionId
  const fromEnv = process.env['CLAUDE_SESSION_ID']
  _sessionId = fromEnv !== undefined && fromEnv !== '' ? fromEnv : generateSessionId()
  return _sessionId
}

registerReset(() => {
  _files = new Map()
  _hintsShown = new Set()
  _webFetches = new Map()
  _bashOutputs = new Map()
  _sessionId = null
})
