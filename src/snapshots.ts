// Per-session content snapshots for diff-aware re-read hints. When a file is read, a snapshot is captured. If edited later, a diff is computed.

import * as fs from 'node:fs'
import * as path from 'node:path'

import { fingerprintContent } from './fingerprint.js'
import { foldPath, normalizePath, atomicWriteBytes } from './util.js'
import { tokenGoatHome } from './disk_cache.js'

export const MAX_SNAPSHOTS_PER_SESSION = 150
export const MAX_SNAPSHOT_BYTES = 256 * 1024
export const SNAPSHOT_TRUNCATE_BYTES = 50 * 1024

export interface SnapshotResult {
  path: string
  content_sha: string
  size_bytes: number
}

const KIND_READ = 'read'
const KIND_PREDICTIVE = 'predictive'
const VALID_KINDS = new Set([KIND_READ, KIND_PREDICTIVE])
const _TRUNCATED_MARKER = Buffer.from('\n<snapshot truncated at ')
const SESSION_DIR_RE = /[^a-zA-Z0-9_-]/g

function sessionDir(sessionId: string): string | null {
  if (!sessionId) return null
  const safe = sessionId.replace(SESSION_DIR_RE, '_').slice(0, 64) || 'anon'
  const base = path.join(tokenGoatHome(), 'session_snapshots')
  const candidate = path.join(base, safe)

  try {
    const rel = path.relative(base, candidate)
    if (rel.startsWith('..')) return null
  } catch {
    return null
  }

  return candidate
}

function pathKey(filePath: string): string {
  // Case-insensitive filesystems (Windows, macOS) resolve two differently-cased paths to the
  // same physical file. normalizePath only lowercases the drive letter, so fold the whole
  // string through foldPath (util.ts) -- matching the established convention from session.ts's
  // read-dedup map key -- or a file read under two casings in one session gets two different
  // snapshot files on disk, and load() silently fails to find the prior
  // snapshot under the new casing.
  return fingerprintContent(foldPath(normalizePath(filePath))).slice(0, 32)
}

export function snapshot_path(sessionId: string, filePath: string): string | null {
  const d = sessionDir(sessionId)
  if (!d) return null
  return path.join(d, `${pathKey(filePath)}.bin`)
}

function kindSidecarPath(snapshotPath: string): string {
  return snapshotPath + '.kind'
}

function readSnapshotKind(sidecarPath: string): string | null {
  try {
    if (!fs.existsSync(sidecarPath)) return null
    const raw = fs.readFileSync(sidecarPath, 'utf8').trim()
    return VALID_KINDS.has(raw) ? raw : null
  } catch {
    return null
  }
}

function writeSnapshotKind(sidecarPath: string, kind: string): boolean {
  try {
    const safeKind = VALID_KINDS.has(kind) ? kind : KIND_READ
    const dir = path.dirname(sidecarPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(sidecarPath, safeKind, 'utf8')
    return true
  } catch {
    return false
  }
}

function evictOldest(d: string, maxCount: number): number {
  try {
    const entries: Array<[string, number]> = []
    const files = fs.readdirSync(d)
    for (const file of files) {
      const fullPath = path.join(d, file)
      if (!file.endsWith('.bin')) continue
      try {
        const stat = fs.statSync(fullPath)
        entries.push([fullPath, stat.mtimeMs])
      } catch {
        continue
      }
    }

    if (entries.length <= maxCount) return 0

    entries.sort((a, b) => a[1] - b[1])
    let removed = 0
    const over = entries.length - maxCount
    for (const [p] of entries.slice(0, over)) {
      try {
        fs.unlinkSync(p)
        removed++
        try {
          fs.unlinkSync(kindSidecarPath(p))
        } catch {
          // ignore sidecar unlink failure
        }
      } catch {
        continue
      }
    }
    return removed
  } catch {
    return 0
  }
}

export function store(
  sessionId: string,
  filePath: string,
  content: Buffer,
  opts: { kind?: string } = {},
): SnapshotResult | null {
  const kind = opts.kind ?? KIND_READ
  const origLen = content.length

  if (origLen > MAX_SNAPSHOT_BYTES) {
    return null
  }

  let stored = content
  if (origLen > SNAPSHOT_TRUNCATE_BYTES) {
    const marker = Buffer.from(`\n<snapshot truncated at ${origLen} bytes>\n`)
    stored = Buffer.concat([content.slice(0, SNAPSHOT_TRUNCATE_BYTES), marker])
  }

  const p = snapshot_path(sessionId, filePath)
  if (!p) return null

  const sha = fingerprintContent(stored)

  try {
    const isNewEntry = !fs.existsSync(p)

    if (!isNewEntry) {
      try {
        const existing = fs.readFileSync(p)
        if (Buffer.from(existing).equals(stored)) {
          return {
            path: p,
            content_sha: sha,
            size_bytes: stored.length,
          }
        }
      } catch {
        // continue with write
      }
    }

    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    if (isNewEntry) {
      evictOldest(dir, MAX_SNAPSHOTS_PER_SESSION - 1)
    }

    // Write atomically via shared helper: uses pid + hrtime for unique temp names
    // (avoiding collisions between concurrent writers) and wraps rename in
    // withRetryOnLock for Windows file-lock resilience.
    atomicWriteBytes(p, stored)

    const sidecar = kindSidecarPath(p)
    writeSnapshotKind(sidecar, kind)

    return {
      path: p,
      content_sha: sha,
      size_bytes: stored.length,
    }
  } catch {
    return null
  }
}

export function load_kind(sessionId: string, filePath: string): string | null {
  const p = snapshot_path(sessionId, filePath)
  if (!p) return null
  const sidecar = kindSidecarPath(p)
  return readSnapshotKind(sidecar)
}

export function load(sessionId: string, filePath: string, opts: { expected_sha?: string } = {}): Buffer | null {
  const p = snapshot_path(sessionId, filePath)
  if (!p || !fs.existsSync(p)) return null

  try {
    const stat = fs.statSync(p)
    if (stat.size > MAX_SNAPSHOT_BYTES) {
      return null
    }
  } catch {
    return null
  }

  try {
    const data = fs.readFileSync(p)
    if (opts.expected_sha) {
      const actualSha = fingerprintContent(data)
      if (actualSha.toLowerCase() !== opts.expected_sha.toLowerCase()) {
        return null
      }
    }
    return data
  } catch {
    return null
  }
}

export function cleanup_session(sessionId: string): number {
  const d = sessionDir(sessionId)
  if (!d || !fs.existsSync(d)) return 0

  let removed = 0
  try {
    const files = fs.readdirSync(d)
    for (const file of files) {
      const fullPath = path.join(d, file)
      try {
        const stat = fs.lstatSync(fullPath)
        // Skip symlinks
        if ((stat.mode & 0o170000) === 0o120000) {
          continue
        }
        fs.unlinkSync(fullPath)
        if (file.endsWith('.bin')) {
          removed++
        }
      } catch {
        continue
      }
    }
    try {
      fs.rmdirSync(d)
    } catch {
      // ignore: directory not empty is fine
    }
  } catch {
    return removed
  }

  return removed
}

export function cleanup_stale(maxAgeHours: number = 24.0): number {
  const base = path.join(tokenGoatHome(), 'session_snapshots')
  if (!fs.existsSync(base)) return 0

  const cutoff = Date.now() - maxAgeHours * 3600 * 1000
  let removed = 0

  try {
    const sessionDirs = fs.readdirSync(base)
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(base, sessionDir)
      try {
        const stat = fs.statSync(sessionPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      try {
        const files = fs.readdirSync(sessionPath)
        for (const file of files) {
          const fullPath = path.join(sessionPath, file)
          try {
            const stat = fs.lstatSync(fullPath)
            // Skip symlinks
            if ((stat.mode & 0o170000) === 0o120000) {
              continue
            }
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(fullPath)
              if (file.endsWith('.bin')) {
                removed++
              }
            }
          } catch {
            continue
          }
        }
        try {
          fs.rmdirSync(sessionPath)
        } catch {
          // ignore: directory not empty
        }
      } catch {
        continue
      }
    }
  } catch {
    return removed
  }

  return removed
}
