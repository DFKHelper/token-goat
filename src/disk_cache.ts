/**
 * Cross-process disk persistence for id-keyed content caches.
 *
 * token-goat hooks run as a fresh `token-goat hook <event>` process per tool
 * call, so any state kept only in module-level Maps dies when the process exits.
 * This module backs the bash-output and web-output content caches with small
 * JSON blobs on disk, keyed by a content id, so a value stored by one hook
 * process is readable by a later, separate process and by the session-less CLI
 * (`token-goat bash-output <id>` / `web-output <id>`).
 *
 * The storage root mirrors {@link file://./snapshots.ts} (`~/.token-goat/...`),
 * resolved lazily per call so tests can redirect it. Every operation is
 * fail-soft: a disk error never throws into a hook. Blobs are content-addressed,
 * so two processes that store the same id write identical bytes — concurrent
 * writers cannot corrupt each other.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { atomicWriteText } from './util.js'

/** Default cap on blobs kept per subdir before the oldest are evicted. */
export const DEFAULT_MAX_COUNT = 200
/** Default max age (ms) before a blob is pruned. Mirrors snapshots' 24h stale window. */
export const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000

const ID_SANITIZE_RE = /[^a-zA-Z0-9_-]/g

/**
 * Root for token-goat cross-process state, mirroring `snapshots.ts`.
 *
 * Honors `TOKEN_GOAT_HOME` (used by tests to isolate from the real home and by
 * the cross-process e2e child) and otherwise resolves to `~/.token-goat`.
 * Resolved lazily on every call so an env override or spy takes effect.
 */
export function tokenGoatHome(): string {
  const override = process.env['TOKEN_GOAT_HOME']
  if (override !== undefined && override !== '') return override
  return path.join(os.homedir(), '.token-goat')
}

/** Sanitize a content id to a filesystem-safe stem (ids are already hex; this is
 * defense in depth, never trust the key). Empty result means "unusable id". */
function sanitizeId(id: string): string {
  return id.replace(ID_SANITIZE_RE, '_').slice(0, 64)
}

function blobDir(subdir: string): string {
  return path.join(tokenGoatHome(), subdir)
}

/** Resolve the on-disk path for `id` in `subdir`, or null when the id sanitizes
 * to empty or escapes the subdir (traversal guard, mirrors snapshots). */
function blobPath(subdir: string, id: string): string | null {
  const safe = sanitizeId(id)
  if (!safe) return null
  const dir = blobDir(subdir)
  const candidate = path.join(dir, `${safe}.json`)
  try {
    const rel = path.relative(dir, candidate)
    if (rel.startsWith('..')) return null
  } catch {
    return null
  }
  return candidate
}

/**
 * Atomically write `value` as JSON to `<home>/<subdir>/<id>.json`, then prune.
 *
 * Fail-soft: returns false on any error (never throws). A prune failure never
 * undoes the store. The parent dir is created on demand.
 */
export function storeBlob(
  subdir: string,
  id: string,
  value: unknown,
  opts: { maxCount?: number; maxAgeMs?: number } = {},
): boolean {
  const p = blobPath(subdir, id)
  if (!p) return false
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    atomicWriteText(p, JSON.stringify(value))
  } catch {
    return false
  }
  pruneBlobs(subdir, opts.maxCount ?? DEFAULT_MAX_COUNT, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
  return true
}

/**
 * Read and JSON-parse `<home>/<subdir>/<id>.json`.
 *
 * Fail-soft: returns null on any error (missing, corrupt, traversal). The caller
 * validates the parsed shape.
 */
export function loadBlob(subdir: string, id: string): unknown {
  const p = blobPath(subdir, id)
  if (!p) return null
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** List every blob in `subdir`, mirroring the pruneBlobs dir scan. Returns `{ id, mtime, value }` sorted by none (caller decides). Missing dir or any top-level error returns []. Entries whose file cannot be stat-ed get mtime 0; entries whose blob cannot be loaded are skipped. */
export function listBlobs(subdir: string): Array<{ id: string; mtime: number; value: unknown }> {
  const dir = blobDir(subdir)
  const out: Array<{ id: string; mtime: number; value: unknown }> = []
  try {
    if (!fs.existsSync(dir)) return out
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const id = file.slice(0, -5)
      let mtime = 0
      try { mtime = fs.statSync(path.join(dir, file)).mtimeMs } catch {
        // fail-soft: leave mtime at 0
      }
      const value = loadBlob(subdir, id)
      if (value !== null) out.push({ id, mtime, value })
    }
  } catch {
    return out
  }
  return out
}

/**
 * Drop blobs older than `maxAgeMs`, then evict the oldest beyond `maxCount`.
 *
 * Mirrors `snapshots.cleanup_stale` + `evictOldest`. Fail-soft: returns the
 * number removed and never throws.
 */
export function pruneBlobs(
  subdir: string,
  maxCount: number = DEFAULT_MAX_COUNT,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): number {
  const dir = blobDir(subdir)
  let removed = 0
  try {
    if (!fs.existsSync(dir)) return 0
    const cutoff = Date.now() - maxAgeMs
    const kept: Array<[string, number]> = []
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const full = path.join(dir, file)
      let mtime: number
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      if (mtime < cutoff) {
        try {
          fs.unlinkSync(full)
          removed++
        } catch {
          continue
        }
      } else {
        kept.push([full, mtime])
      }
    }
    if (kept.length > maxCount) {
      kept.sort((a, b) => a[1] - b[1])
      for (const [full] of kept.slice(0, kept.length - maxCount)) {
        try {
          fs.unlinkSync(full)
          removed++
        } catch {
          continue
        }
      }
    }
  } catch {
    return removed
  }
  return removed
}
