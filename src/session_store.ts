/**
 * Per-session state persistence — the dropped Python `SessionCache` JSON.
 *
 * token-goat hooks run as a fresh `token-goat hook <event>` process per tool
 * call, so the session Maps in {@link file://./session.ts} (read/edit tracking,
 * shown-hint dedup, web/bash/curl recall indexes) would die at the end of every
 * hook if kept only in memory. This module loads that state at the start of a
 * hook and saves it at the end, keyed by session id, so re-read dedup and the
 * recall hints work across the separate processes.
 *
 * Mirrors the on-disk conventions of `snapshots.ts`: a per-session file under
 * `~/.token-goat/sessions/`, session-id sanitization, a traversal guard, and an
 * atomic temp-file + rename. Two invariants hold every operation together:
 *  - **Fail-soft.** A disk error never throws; a corrupt/missing file is just an
 *    empty session. {@link file://./relay.ts} additionally guards the calls so a
 *    persistence bug can never drop a hook's real output.
 *  - **Merge-on-save.** Save re-reads the on-disk state and merges it with the
 *    in-memory state (set-union for hints, field-wise for files, newest-wins for
 *    the indexes). Combined with the atomic rename this bounds the cost of two
 *    overlapping same-session hook processes to, at worst, a dropped hint —
 *    never a corrupt file.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { atomicWriteText, withFileLock } from './util.js'
import { tokenGoatHome } from './disk_cache.js'
import { consumedPendingLargeFileHintKeys, exportSessionState, importSessionState, MAX_RANGES_PER_FILE, pendingLargeFileHintsAtLoad, type FileEntry, type SerializedSession } from './session.js'

const SAFE_RE = /[^a-zA-Z0-9_-]/g
/** Cap on tracked file entries kept per session; oldest by last-read are evicted. */
const MAX_FILES = 500
export const SESSIONS_SUBDIR = 'sessions'

/** Resolve the on-disk path for `sessionId`, or null when the id is empty,
 * sanitizes to empty, or would escape the sessions dir (traversal guard). */
function sessionPath(sessionId: string): string | null {
  if (!sessionId) return null
  const safe = sessionId.replace(SAFE_RE, '_').slice(0, 64)
  if (!safe) return null
  const dir = path.join(tokenGoatHome(), SESSIONS_SUBDIR)
  const candidate = path.join(dir, `${safe}.json`)
  try {
    const rel = path.relative(dir, candidate)
    if (rel.startsWith('..')) return null
  } catch {
    return null
  }
  return candidate
}

function asStringPairs(raw: unknown): Array<[string, string]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[string, string]> = []
  for (const item of raw) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
      out.push([item[0], item[1]])
    }
  }
  return out
}

function asFileEntry(raw: unknown): FileEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (
    typeof o['path'] !== 'string' ||
    typeof o['readCount'] !== 'number' ||
    typeof o['lastReadAt'] !== 'number' ||
    typeof o['wasEdited'] !== 'boolean' ||
    typeof o['sizeBytes'] !== 'number'
  ) {
    return null
  }
  const entry: FileEntry = {
    path: o['path'],
    readCount: o['readCount'],
    lastReadAt: o['lastReadAt'],
    wasEdited: o['wasEdited'],
    sizeBytes: o['sizeBytes'],
  }
  return o['wasTruncated'] === true ? { ...entry, wasTruncated: true } : entry
}

/**
 * Parse one entry from a Python-format `files` dict value into a {@link FileEntry}.
 * Returns null for any malformed entry so the caller can skip it safely.
 *
 * Python fields: rel_or_abs (string), read_count (int), last_read_ts (float seconds),
 * read_size (bytes), last_edit_ts (float seconds, may be absent).
 * The dict key itself is used as the path fallback when rel_or_abs is missing.
 */
function asPyFileEntry(dictKey: string, raw: unknown): FileEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const p = typeof v['rel_or_abs'] === 'string' ? v['rel_or_abs'] : dictKey
  if (!p) return null
  const readCount = typeof v['read_count'] === 'number' ? Math.max(1, Math.round(v['read_count'])) : 1
  const lastReadTs = typeof v['last_read_ts'] === 'number' ? v['last_read_ts'] : 0
  const sizeBytes = typeof v['read_size'] === 'number' ? Math.round(v['read_size']) : 0
  const wasEdited = typeof v['last_edit_ts'] === 'number' && v['last_edit_ts'] > 0
  return { path: p, readCount, lastReadAt: lastReadTs * 1000, wasEdited, sizeBytes }
}

/** Coerce an untrusted parsed-JSON value into a valid (possibly empty)
 * {@link SerializedSession}, dropping anything malformed. Never throws.
 *
 * Handles both the TS array format (`files: FileEntry[]`) and the legacy Python
 * dict format (`files: { path: { rel_or_abs, read_count, last_read_ts, ... } }`).
 * Python-format files are transparently migrated to the TS shape on load; the
 * next {@link saveSessionState} call then writes the file in the TS format so
 * subsequent loads use the fast path automatically. */
/** Coerce an untrusted value into the persisted line-ranges shape, dropping anything malformed. Never throws. */
function asLineRanges(raw: unknown): Array<[string, Array<[number, number]>]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[string, Array<[number, number]>]> = []
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const filePath = pair[0]
    const ranges = pair[1]
    if (typeof filePath !== 'string' || !Array.isArray(ranges)) continue
    const valid: Array<[number, number]> = []
    for (const r of ranges) {
      if (Array.isArray(r) && r.length === 2 && typeof r[0] === 'number' && typeof r[1] === 'number') valid.push([r[0], r[1]])
    }
    out.push([filePath, valid])
  }
  return out
}

function coerce(raw: unknown): SerializedSession {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const files: FileEntry[] = []
  if (Array.isArray(o['files'])) {
    for (const f of o['files']) {
      const e = asFileEntry(f)
      if (e !== null) files.push(e)
    }
  } else if (o['files'] !== null && typeof o['files'] === 'object') {
    // Python-format: files is a path-keyed object, not an array.
    for (const [key, val] of Object.entries(o['files'] as Record<string, unknown>)) {
      const e = asPyFileEntry(key, val)
      if (e !== null) files.push(e)
    }
  }
  // TS format uses `hintsShown`; Python format uses `hints_seen` — accept both.
  const hintsShown = Array.isArray(o['hintsShown'])
    ? o['hintsShown'].filter((h): h is string => typeof h === 'string')
    : Array.isArray(o['hints_seen'])
      ? (o['hints_seen'] as unknown[]).filter((h): h is string => typeof h === 'string')
      : []
  const cliReads = Array.isArray(o['cliReads'])
    ? o['cliReads'].filter((h): h is string => typeof h === 'string')
    : []
  const pendingLargeFileHints: Array<[string, number]> = Array.isArray(o['pendingLargeFileHints'])
    ? (o['pendingLargeFileHints'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number',
      )
    : []
  return {
    files,
    hintsShown,
    webFetches: asStringPairs(o['webFetches']),
    bashOutputs: asStringPairs(o['bashOutputs']),
    curlDownloads: asStringPairs(o['curlDownloads']),
    fileLineRanges: asLineRanges(o['fileLineRanges']),
    cliReads,
    pendingLargeFileHints,
  }
}

/** Combine two views of one file: keep every read/edit/truncation signal and
 * the size from the more recent read. Never loses a positive flag. */
function mergeFileEntry(a: FileEntry, b: FileEntry): FileEntry {
  const newest = a.lastReadAt >= b.lastReadAt ? a : b
  const merged: FileEntry = {
    path: a.path,
    readCount: Math.max(a.readCount, b.readCount),
    lastReadAt: Math.max(a.lastReadAt, b.lastReadAt),
    wasEdited: a.wasEdited || b.wasEdited,
    sizeBytes: newest.sizeBytes,
  }
  return a.wasTruncated || b.wasTruncated ? { ...merged, wasTruncated: true } : merged
}

function mergePairs(disk: Array<[string, string]>, mem: Array<[string, string]>): Array<[string, string]> {
  // mem overlays disk: the current process's view is at least as fresh.
  return Array.from(new Map([...disk, ...mem]).entries())
}

/** Merge two views of the per-file served line ranges: union per file, dedup identical ranges, cap per file.
 * The cap never evicts a range already on disk (another process's confirmed, persisted work) — once a
 * file is at the cap, a fresh range from this process's own in-memory view is simply not added rather
 * than displacing a disk-persisted entry. */
function mergeLineRanges(disk: Array<[string, Array<[number, number]>]>, mem: Array<[string, Array<[number, number]>]>): Array<[string, Array<[number, number]>]> {
  const byPath = new Map<string, Array<[number, number]>>()
  for (const [filePath, ranges] of disk) byPath.set(filePath, [...ranges])
  for (const [filePath, ranges] of mem) {
    const prev = byPath.get(filePath) ?? []
    const seen = new Set(prev.map(([s, e]) => s + ':' + e))
    for (const [s, e] of ranges) {
      const key = s + ':' + e
      if (seen.has(key) || prev.length >= MAX_RANGES_PER_FILE) continue
      prev.push([s, e])
      seen.add(key)
    }
    byPath.set(filePath, prev)
  }
  return Array.from(byPath.entries())
}

/** Merge pending large-file hints: union disk with mem, but drop any key this process
 * explicitly consumed (took an outcome for) even if a stale disk read still has it — the
 * other merged fields are monotonic sets where union is always correct, but this one is a
 * pending-to-consumed lifecycle where a deletion must actually stick.
 *
 * The overlay only re-asserts keys this process actually acted on this run: brand-new keys
 * it added, or keys whose value it changed. A key it merely carried unchanged from hydration
 * (same key, same size as `pendingLargeFileHintsAtLoad`) is left alone and instead defers to
 * whatever the freshest disk read says — otherwise a process that loaded a key but never
 * touched it would resurrect that key on every save, even after a *different* concurrent
 * process legitimately consumed and removed it from disk in the meantime. */
function mergePendingLargeFileHints(
  disk: Array<[string, number]>,
  mem: Array<[string, number]>,
): Array<[string, number]> {
  const merged = new Map(disk)
  for (const key of consumedPendingLargeFileHintKeys()) merged.delete(key)
  const atLoad = pendingLargeFileHintsAtLoad()
  for (const [key, size] of mem) {
    if (atLoad.get(key) === size) continue
    merged.set(key, size)
  }
  return Array.from(merged.entries())
}

/** Merge the on-disk snapshot with the in-memory one (see module invariants). */
function mergeSessionState(disk: SerializedSession, mem: SerializedSession): SerializedSession {
  const byPath = new Map<string, FileEntry>()
  for (const e of disk.files) byPath.set(e.path, e)
  for (const e of mem.files) {
    const prev = byPath.get(e.path)
    byPath.set(e.path, prev ? mergeFileEntry(prev, e) : e)
  }
  return {
    files: Array.from(byPath.values()),
    hintsShown: Array.from(new Set([...disk.hintsShown, ...mem.hintsShown])),
    webFetches: mergePairs(disk.webFetches, mem.webFetches),
    bashOutputs: mergePairs(disk.bashOutputs, mem.bashOutputs),
    curlDownloads: mergePairs(disk.curlDownloads, mem.curlDownloads),
    fileLineRanges: mergeLineRanges(disk.fileLineRanges ?? [], mem.fileLineRanges ?? []),
    cliReads: Array.from(new Set([...(disk.cliReads ?? []), ...(mem.cliReads ?? [])])),
    pendingLargeFileHints: mergePendingLargeFileHints(disk.pendingLargeFileHints ?? [], mem.pendingLargeFileHints ?? []),
  }
}

/** Drop all but the `max` most-recently-read file entries (oldest by lastReadAt). */
function capFiles(s: SerializedSession, max: number): SerializedSession {
  if (s.files.length <= max) return s
  const kept = [...s.files].sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, max)
  return { ...s, files: kept }
}

/** Read the on-disk JSON for `sessionPath`, coerced; null on miss/corrupt. */
function readDiskState(p: string): SerializedSession | null {
  try {
    if (!fs.existsSync(p)) return null
    return coerce(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch {
    return null
  }
}

/**
 * Read and coerce the on-disk session state for `sessionId` without touching
 * in-memory session state (unlike {@link loadSessionState}, which imports the
 * result into the live session maps for the hook lifecycle). Handles both the
 * current TS array `files` format and the legacy Python dict format via the
 * same {@link coerce} normalization `loadSessionState`/`saveSessionState`
 * rely on. Returns null if the id is empty/unusable or no file exists.
 */
export function readSessionStateFile(sessionId: string): SerializedSession | null {
  const p = sessionPath(sessionId)
  if (!p) return null
  return readDiskState(p)
}

/**
 * Load the persisted state for `sessionId` into the in-memory session maps.
 *
 * No-op (clean session) when the id is empty/unusable or no file exists.
 * Fail-soft: a corrupt file leaves the session empty rather than throwing.
 */
export function loadSessionState(sessionId: string): void {
  const p = sessionPath(sessionId)
  if (!p) return
  const disk = readDiskState(p)
  if (disk === null) return
  importSessionState(disk)
}

/**
 * Persist the in-memory session state for `sessionId`, merged with whatever is
 * already on disk (so a concurrent same-session hook process is not clobbered).
 *
 * No-op when the id is empty/unusable. Fail-soft: a disk error is swallowed.
 */
export function saveSessionState(sessionId: string): void {
  const p = sessionPath(sessionId)
  if (!p) return
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const mem = exportSessionState()
    // saveSessionState is the actual race: every hook call is a fresh OS process, and two
    // concurrent processes for the same session can each read the pre-update disk state,
    // merge it with their own view, and write -- whichever write lands last silently
    // clobbers the other's update, with no error. A short-lived lockfile around just this
    // read-merge-write section serializes concurrent savers, so each one's disk read
    // reflects every write that already landed. Losing the race to acquire the lock in
    // time falls back to the old unprotected write instead of dropping the update
    // outright, so this can never block or break the caller's real hook.
    const writeMerged = (): true => {
      const disk = readDiskState(p)
      const merged = capFiles(disk ? mergeSessionState(disk, mem) : mem, MAX_FILES)
      atomicWriteText(p, JSON.stringify(merged))
      return true
    }
    if (withFileLock(`${p}.lock`, writeMerged) === undefined) writeMerged()
  } catch {
    // fail-soft: never let persistence break a hook
  }
}
