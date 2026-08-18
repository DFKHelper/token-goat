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

import { ensureDirSync, atomicWriteText, foldPath, LOCK_WAIT_MS_HARDENED, sanitizeIdForFilename, withFileLock } from './util.js'
import { tokenGoatHome } from './disk_cache.js'
import { consumedCurlDownloadKeys, consumedOutstandingAgentSpawnKeys, consumedPendingLargeFileHintKeys, curlDownloadsAtLoad, exportSessionState, filesReadCountAtLoad, importSessionState, MAX_OUTSTANDING_AGENT_SPAWNS, MAX_RANGES_PER_FILE, outstandingAgentSpawnKey, outstandingAgentSpawnsAtLoad, pendingLargeFileHintsAtLoad, type FileEntry, type SerializedSession } from './session.js'

/** Cap on tracked file entries kept per session; oldest by last-read are evicted. */
const MAX_FILES = 500
export const SESSIONS_SUBDIR = 'sessions'

/**
 * The sanitized form of relay.ts's `sessionStateKey` agent-salt separator
 * (`:agent:`), as it actually appears in an on-disk filename after
 * {@link sessionPath}'s sanitization (`:` -> `_`). Exported so any
 * code that needs to recognize or exclude a subagent-scoped session blob by
 * filename (sibling-blob discovery for the pre_compact manifest, "latest
 * session" resolution) derives the marker from the same sanitization logic
 * rather than hardcoding a string that could drift out of sync with it.
 */
export const AGENT_SALT_MARKER = sanitizeIdForFilename(':agent:')

/** Resolve the on-disk path for `sessionId`, or null when the id is empty,
 * sanitizes to empty, or would escape the sessions dir (traversal guard).
 *
 * COLLISION RISK: `sessionId` here can be an agent-salted key
 * (`${sessionId}:agent:${agentId}`, see relay.ts's `sessionStateKey`). A UUID
 * session id (36 chars) + the sanitized salt marker (7 chars) already leaves
 * only ~21 of a UUID agent id's 36 chars before the 64-char slice below cuts
 * it off, so two different agent ids that happen to share that ~21-char
 * prefix would collide onto the same filename. This is a known, deliberately
 * accepted low-probability risk (not fixed by hashing instead of truncating,
 * since callers and tests — e.g. `tests/session_persistence_e2e.test.ts` —
 * rely on the plain, human-readable, non-salted case producing an exact
 * `<sessionId>.json` filename; hashing would change that on-disk format for
 * every caller). Leave as-is; do not "fix" by truncating differently without
 * also addressing the human-readable-filename requirement above. */
function sessionPath(sessionId: string): string | null {
  if (!sessionId) return null
  const safe = sanitizeIdForFilename(sessionId, 64)
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
  let entry: FileEntry = {
    path: o['path'],
    readCount: o['readCount'],
    lastReadAt: o['lastReadAt'],
    wasEdited: o['wasEdited'],
    sizeBytes: o['sizeBytes'],
  }
  if (o['wasTruncated'] === true) entry = { ...entry, wasTruncated: true }
  // Preserve the surgical-read tokens so compact.ts's symbolsBonus survives a save -> load round-trip; without this the field is silently dropped and the bonus is always zero.
  if (Array.isArray(o['symbols_read'])) {
    const symbols = (o['symbols_read'] as unknown[]).filter((s): s is string => typeof s === 'string')
    if (symbols.length > 0) entry = { ...entry, symbols_read: symbols }
  }
  return entry
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

/** Coerce an untrusted parsed-JSON value into a valid (possibly empty)
 * {@link SerializedSession}, dropping anything malformed. Never throws.
 *
 * Handles both the TS array format (`files: FileEntry[]`) and the legacy Python
 * dict format (`files: { path: { rel_or_abs, read_count, last_read_ts, ... } }`).
 * Python-format files are transparently migrated to the TS shape on load; the
 * next {@link saveSessionState} call then writes the file in the TS format so
 * subsequent loads use the fast path automatically. */
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
  const scheduledPromptCounts: Array<[string, number]> = Array.isArray(o['scheduledPromptCounts'])
    ? (o['scheduledPromptCounts'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string'
          && typeof p[1] === 'number' && Number.isSafeInteger(p[1]) && p[1] >= 0,
      )
    : []
  const cliReads = Array.isArray(o['cliReads'])
    ? o['cliReads'].filter((h): h is string => typeof h === 'string')
    : []
  const bashReruns = Array.isArray(o['bashReruns'])
    ? o['bashReruns'].filter((h): h is string => typeof h === 'string')
    : []
  const pendingLargeFileHints: Array<[string, number]> = Array.isArray(o['pendingLargeFileHints'])
    ? (o['pendingLargeFileHints'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number',
      )
    : []
  const grepQueries: Array<[string, number]> = Array.isArray(o['grepQueries'])
    ? (o['grepQueries'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number',
      )
    : []
  const globQueries: Array<[string, number]> = Array.isArray(o['globQueries'])
    ? (o['globQueries'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number',
      )
    : []
  const outstandingAgentSpawns: Array<[string, number]> = Array.isArray(o['outstandingAgentSpawns'])
    ? (o['outstandingAgentSpawns'] as unknown[]).filter(
        (p): p is [string, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'number',
      )
    : []
  return {
    files,
    hintsShown,
    ...(scheduledPromptCounts.length > 0 ? { scheduledPromptCounts } : {}),
    webFetches: asStringPairs(o['webFetches']),
    bashOutputs: asStringPairs(o['bashOutputs']),
    curlDownloads: asStringPairs(o['curlDownloads']),
    fileLineRanges: asLineRanges(o['fileLineRanges']),
    cliReads,
    bashReruns,
    pendingLargeFileHints,
    grepQueries,
    globQueries,
    outstandingAgentSpawns,
    ...(typeof o['lastTabContext'] === 'string' ? { lastTabContext: o['lastTabContext'] } : {}),
    ...(typeof o['compactedAt'] === 'number' ? { compactedAt: o['compactedAt'] } : {}),
    ...(typeof o['created_ts'] === 'number' ? { created_ts: o['created_ts'] } : {}),
  }
}

/** Combine two views of one file: keep every read/edit/truncation signal and
 * the size from the more recent read. Never loses a positive flag. */
function mergeFileEntry(a: FileEntry, b: FileEntry): FileEntry {
  const newest = a.lastReadAt >= b.lastReadAt ? a : b
  // readCount is reconciled, not maxed: b (this process's own in-memory view) may have started from a stale disk snapshot and incremented independently of whatever other concurrent processes already wrote into a (the freshest disk read, taken under the save lock in saveSessionState). Math.max(a, b) silently drops a concurrent process's distinct increment whenever the two counters happen to coincide. Instead, add only the reads this process genuinely made since its own load (b.readCount minus its baseline at hydration time) on top of the freshest disk count, so two processes that each record one real read from the same starting point sum to two instead of collapsing to one.
  const baseline = filesReadCountAtLoad().get(b.path) ?? 0
  const newReadsThisProcess = Math.max(0, b.readCount - baseline)
  let merged: FileEntry = {
    path: a.path,
    readCount: a.readCount + newReadsThisProcess,
    lastReadAt: Math.max(a.lastReadAt, b.lastReadAt),
    wasEdited: a.wasEdited || b.wasEdited,
    sizeBytes: newest.sizeBytes,
  }
  if (a.wasTruncated || b.wasTruncated) merged = { ...merged, wasTruncated: true }
  // Union the surgical-read tokens from both views so a concurrent process's
  // symbol reads are not clobbered by whichever save lands last.
  const symbols = Array.from(new Set([...(a.symbols_read ?? []), ...(b.symbols_read ?? [])]))
  if (symbols.length > 0) merged = { ...merged, symbols_read: symbols }
  return merged
}

/** "mem overlays disk" merge: the current process's view is at least as fresh. Shared by every
 * pure-append/overwrite disk/mem pair-list field with no removal path (webFetches, bashOutputs,
 * grepQueries, globQueries). curlDownloads has one (clearCurlDownload) and uses
 * {@link mergeCurlDownloads} instead so a clearing deletion actually sticks. */
function mergePairs<V>(disk: Array<[string, V]>, mem: Array<[string, V]>): Array<[string, V]> {
  return Array.from(new Map([...disk, ...mem]).entries())
}

/** Merge monotonically increasing counters so stale hook processes cannot lower an occurrence. */
function mergeMaxNumberPairs(disk: Array<[string, number]>, mem: Array<[string, number]>): Array<[string, number]> {
  const merged = new Map(disk)
  for (const [key, value] of mem) {
    merged.set(key, Math.max(merged.get(key) ?? 0, value))
  }
  return Array.from(merged.entries())
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

/** Merge two views of curl -o download records: union disk with mem, but drop any URL this
 * process explicitly cleared (see {@link consumedCurlDownloadKeys}) even if a stale disk read
 * still has it -- like mergePendingLargeFileHints, this is NOT a plain set-union field, because
 * clearCurlDownload's removal must actually stick.
 *
 * The overlay only re-asserts URLs this process actually acted on this run: brand-new URLs it
 * recorded, or URLs whose saved path it changed. A URL merely carried unchanged from hydration
 * (same URL, same path as `curlDownloadsAtLoad`) is left alone and instead defers to whatever
 * the freshest disk read says -- otherwise a process that loaded a URL but never touched it would
 * resurrect that URL on every save, even after a *different* concurrent process legitimately
 * cleared it from disk in the meantime. */
function mergeCurlDownloads(
  disk: Array<[string, string]>,
  mem: Array<[string, string]>,
): Array<[string, string]> {
  const merged = new Map(disk)
  for (const key of consumedCurlDownloadKeys()) merged.delete(key)
  const atLoad = curlDownloadsAtLoad()
  for (const [url, savedPath] of mem) {
    if (atLoad.get(url) === savedPath) continue
    merged.set(url, savedPath)
  }
  return Array.from(merged.entries())
}

/** Merge two views of outstanding Agent-spawn prompts. Like mergePendingLargeFileHints below,
 * this is NOT a plain set-union: removal (the post-hook clearing a completed spawn) must actually
 * stick, so a plain disk-union would silently resurrect an entry this process just removed from
 * the pre-update disk snapshot. Start from disk, drop anything this process explicitly removed
 * (see consumedOutstandingAgentSpawnKeys), then overlay only the entries this process newly added
 * (present in mem but not in its own load-time snapshot) -- an entry merely carried over unchanged
 * defers to disk. Finally cap to MAX_OUTSTANDING_AGENT_SPAWNS, dropping the oldest entries first,
 * same oldest-evicted shape as recordOutstandingAgentSpawn's own local cap. */
function mergeOutstandingAgentSpawns(
  disk: Array<[string, number]>,
  mem: Array<[string, number]>,
): Array<[string, number]> {
  const merged = new Map(disk.map(([prompt, ts]) => [outstandingAgentSpawnKey(prompt, ts), [prompt, ts] as [string, number]]))
  for (const key of consumedOutstandingAgentSpawnKeys()) merged.delete(key)
  const atLoad = new Set(outstandingAgentSpawnsAtLoad().map((e) => outstandingAgentSpawnKey(e.prompt, e.ts)))
  for (const [prompt, ts] of mem) {
    const key = outstandingAgentSpawnKey(prompt, ts)
    if (atLoad.has(key)) continue
    merged.set(key, [prompt, ts])
  }
  const result = Array.from(merged.values()).sort((a, b) => a[1] - b[1])
  if (result.length > MAX_OUTSTANDING_AGENT_SPAWNS) {
    result.splice(0, result.length - MAX_OUTSTANDING_AGENT_SPAWNS)
  }
  return result
}

/** Merge the on-disk snapshot with the in-memory one (see module invariants). */
function mergeSessionState(disk: SerializedSession, mem: SerializedSession): SerializedSession {
  const byPath = new Map<string, FileEntry>()
  for (const e of disk.files) byPath.set(foldPath(e.path), e)
  for (const e of mem.files) {
    const key = foldPath(e.path)
    const prev = byPath.get(key)
    byPath.set(key, prev ? mergeFileEntry(prev, e) : e)
  }
  // Compaction epoch is max-wins: it only ever moves forward, so whichever side saw the most recent compaction is authoritative and a concurrent process that predates the stamp can never roll it back. This is exactly why session.ts records an epoch instead of resetting each entry's readCount -- a readCount reset merges to a no-op here (see mergeFileEntry), a max-merged scalar does not.
  const compactedAt = Math.max(disk.compactedAt ?? 0, mem.compactedAt ?? 0)
  // Sed line ranges carry no timestamp of their own, so they cannot be filtered per-range against the epoch the way FileEntry.lastReadAt can. Instead drop the ranges of any side that had not yet observed the winning epoch: they were recorded by a process whose view predates the compaction, so they may describe content the model no longer holds. Erring toward dropping only costs a full read that was already going to be correct; keeping them would keep serving "you already saw lines N-M" against invisible content.
  const diskRanges = (disk.compactedAt ?? 0) === compactedAt ? (disk.fileLineRanges ?? []) : []
  const memRanges = (mem.compactedAt ?? 0) === compactedAt ? (mem.fileLineRanges ?? []) : []
  return {
    files: Array.from(byPath.values()),
    hintsShown: Array.from(new Set([...disk.hintsShown, ...mem.hintsShown])),
    scheduledPromptCounts: mergeMaxNumberPairs(disk.scheduledPromptCounts ?? [], mem.scheduledPromptCounts ?? []),
    webFetches: mergePairs(disk.webFetches, mem.webFetches),
    bashOutputs: mergePairs(disk.bashOutputs, mem.bashOutputs),
    curlDownloads: mergeCurlDownloads(disk.curlDownloads, mem.curlDownloads),
    fileLineRanges: mergeLineRanges(diskRanges, memRanges),
    ...(compactedAt > 0 ? { compactedAt } : {}),
    cliReads: Array.from(new Set([...(disk.cliReads ?? []), ...(mem.cliReads ?? [])])),
    bashReruns: Array.from(new Set([...(disk.bashReruns ?? []), ...(mem.bashReruns ?? [])])),
    pendingLargeFileHints: mergePendingLargeFileHints(disk.pendingLargeFileHints ?? [], mem.pendingLargeFileHints ?? []),
    grepQueries: mergePairs(disk.grepQueries ?? [], mem.grepQueries ?? []),
    globQueries: mergePairs(disk.globQueries ?? [], mem.globQueries ?? []),
    outstandingAgentSpawns: mergeOutstandingAgentSpawns(disk.outstandingAgentSpawns ?? [], mem.outstandingAgentSpawns ?? []),
    // Last-seen scalar, not an accumulating collection: prefer mem's value (this process's freshest observation) over disk's, since a newer write always supersedes an older one.
    ...(mem.lastTabContext !== undefined
      ? { lastTabContext: mem.lastTabContext }
      : disk.lastTabContext !== undefined
        ? { lastTabContext: disk.lastTabContext }
        : {}),
    // Prefer the value already on disk: it marks the original creation time, and must never be bumped forward to the merge's "now". `mem` never carries one (it is not tracked in memory), so this is really "keep whatever disk has".
    ...(disk.created_ts !== undefined
      ? { created_ts: disk.created_ts }
      : mem.created_ts !== undefined
        ? { created_ts: mem.created_ts }
        : {}),
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
 * Read every sibling subagent session-state blob for `sessionId` (i.e. every
 * on-disk file salted with `${sessionId}:agent:${agentId}` per relay.ts's
 * `sessionStateKey`), without touching in-memory session state.
 *
 * `sessionPath` sanitizes and truncates the *whole* salted key to 64 chars,
 * so a sibling's filename is `${sanitize(sessionId)}_agent_<agentId prefix>`
 * possibly truncated mid-agentId — but the `${sanitize(sessionId)}_agent_`
 * prefix itself (well under 64 chars for realistic session ids) always
 * survives intact, which is what this scan matches on. Returns [] when the
 * id is empty/unusable, the sessions dir doesn't exist, or on any read error
 * (fail-soft, mirroring every other read in this module).
 */
export function listSiblingSessionStates(sessionId: string): SerializedSession[] {
  if (!sessionId) return []
  const safeSessionId = sanitizeIdForFilename(sessionId)
  if (!safeSessionId) return []
  const prefix = `${safeSessionId}${AGENT_SALT_MARKER}`
  const dir = path.join(tokenGoatHome(), SESSIONS_SUBDIR)
  const out: SerializedSession[] = []
  try {
    if (!fs.existsSync(dir)) return out
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || !file.startsWith(prefix)) continue
      const state = readDiskState(path.join(dir, file))
      if (state !== null) out.push(state)
    }
  } catch {
    return out
  }
  return out
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
    if (!fs.existsSync(dir)) ensureDirSync(dir)
    const mem = exportSessionState()
    // saveSessionState is the actual race: every hook call is a fresh OS process, and two concurrent processes for the same session can each read the pre-update disk state, merge it with their own view, and write -- whichever write lands last silently clobbers the other's update, with no error. A short-lived lockfile around just this read-merge-write section serializes concurrent savers, so each one's disk read reflects every write that already landed.
    const writeMerged = (): true => {
      const disk = readDiskState(p)
      const merged = capFiles(disk ? mergeSessionState(disk, mem) : mem, MAX_FILES)
      // Stamp the cache's creation time exactly once, on the first write that produces no inherited value (disk had none and mem carries none). Every later write inherits it via readDiskState -> coerce -> mergeSessionState, so it represents creation, not last-modification. Unit: seconds, matching compact.ts's `Date.now() / 1000 - created_ts` age computation.
      if (merged.created_ts === undefined) merged.created_ts = Date.now() / 1000
      atomicWriteText(p, JSON.stringify(merged))
      return true
    }
    // Two concurrent hook processes for the same session_id contend on this lock for their *entire* lifetime (every save re-acquires it), not just once -- so under real machine load (e.g. a parallel test run competing for CPU), the default withFileLock budget (2s) can plausibly miss its deadline even though no lock holder is actually stuck. Falling back to an unprotected write on that miss would reintroduce the exact clobber this lock exists to prevent, precisely when contention (and therefore risk) is highest, so give this hot, contended call site a much larger wait budget instead -- an actually-wedged holder still gets its lock stolen well before this via withFileLock's own staleMs abandonment check, so this only lengthens the wait for *genuine*, resolving contention, not a real hang. The unprotected fallback remains only for withFileLock's other undefined case: a hard failure (e.g. missing dir) that waiting longer cannot fix.
    if (withFileLock(`${p}.lock`, writeMerged, { waitMs: LOCK_WAIT_MS_HARDENED }) === undefined) writeMerged()
  } catch {
    // fail-soft: never let persistence break a hook
  }
}
