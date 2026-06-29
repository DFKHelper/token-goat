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

import { atomicWriteText } from './util.js'
import { tokenGoatHome } from './disk_cache.js'
import { exportSessionState, importSessionState, type FileEntry, type SerializedSession } from './session.js'

const SAFE_RE = /[^a-zA-Z0-9_-]/g
/** Cap on tracked file entries kept per session; oldest by last-read are evicted. */
const MAX_FILES = 500
const SESSIONS_SUBDIR = 'sessions'

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

/** Coerce an untrusted parsed-JSON value into a valid (possibly empty)
 * {@link SerializedSession}, dropping anything malformed. Never throws. */
function coerce(raw: unknown): SerializedSession {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const files: FileEntry[] = []
  if (Array.isArray(o['files'])) {
    for (const f of o['files']) {
      const e = asFileEntry(f)
      if (e !== null) files.push(e)
    }
  }
  const hintsShown = Array.isArray(o['hintsShown'])
    ? o['hintsShown'].filter((h): h is string => typeof h === 'string')
    : []
  return {
    files,
    hintsShown,
    webFetches: asStringPairs(o['webFetches']),
    bashOutputs: asStringPairs(o['bashOutputs']),
    curlDownloads: asStringPairs(o['curlDownloads']),
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
    const mem = exportSessionState()
    const disk = readDiskState(p)
    const merged = capFiles(disk ? mergeSessionState(disk, mem) : mem, MAX_FILES)
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    atomicWriteText(p, JSON.stringify(merged))
  } catch {
    // fail-soft: never let persistence break a hook
  }
}
