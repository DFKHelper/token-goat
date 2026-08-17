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
 * writers cannot corrupt each other. `storeBlob()` also runs every value
 * through {@link file://./secret_redact.ts}'s `redactSecrets()` before it
 * touches disk, so a credential accidentally echoed into cached tool output
 * never gets persisted in plaintext.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { loadConfig } from './config.js'
import { atomicWriteText, sanitizeIdForFilename } from './util.js'
import { redactSecrets } from './secret_redact.js'
import { recordStat } from './stats.js'

/** Default cap on blobs kept per subdir before the oldest are evicted. */
export const DEFAULT_MAX_COUNT = 200
/** Default max age (ms) before a blob is pruned. Mirrors snapshots' 24h stale window. */
export const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000

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
  return sanitizeIdForFilename(id, 64)
}

function blobDir(subdir: string): string {
  return path.join(tokenGoatHome(), subdir)
}

/** Resolve the on-disk path for `id` in `subdir`, or null when the id sanitizes
 * to empty or escapes the subdir (traversal guard, mirrors snapshots). */
export function blobPath(subdir: string, id: string): string | null {
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

/** True when the blob at `subdir`/`id` exists on disk and its mtime is older than DEFAULT_MAX_AGE_MS. A stat error (missing file, permission issue) fails soft to false so the caller falls through to loadBlob, which handles the error case on its own terms. Shared by web_cache.ts's getWebOutput and bash_output_cache.ts's getBashOutput, which previously duplicated this exact stat-and-compare logic. */
export function isBlobStale(subdir: string, id: string): boolean {
  const p = blobPath(subdir, id)
  if (p === null) return false
  try {
    const stat = fs.statSync(p)
    return Date.now() - stat.mtimeMs > DEFAULT_MAX_AGE_MS
  } catch {
    return false
  }
}

/**
 * Resolve the maxCount/maxBytes/maxBytesPerItem eviction budget for a subdir from
 * its matching config section (bash_compress for bash outputs, webfetch for web
 * outputs), falling back to the generic defaults for subdirs with no dedicated
 * config (e.g. the skill/image caches, which manage their own pruning elsewhere).
 */
function subdirCacheDefaults(subdir: string): { maxCount: number; maxBytes: number; maxBytesPerItem: number } {
  try {
    if (subdir === 'bash_outputs') {
      const bc = loadConfig().bash_compress
      return { maxCount: bc.cache_max_file_count, maxBytes: bc.cache_max_bytes, maxBytesPerItem: bc.cache_max_bytes_per_output }
    }
    if (subdir === 'web_outputs') {
      const wf = loadConfig().webfetch
      return { maxCount: wf.max_file_count, maxBytes: wf.max_bytes, maxBytesPerItem: Number.POSITIVE_INFINITY }
    }
  } catch {
    // Config load failed — fall through to the generic, config-independent defaults.
  }
  return { maxCount: DEFAULT_MAX_COUNT, maxBytes: Number.POSITIVE_INFINITY, maxBytesPerItem: Number.POSITIVE_INFINITY }
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
  opts: { maxCount?: number; maxAgeMs?: number; maxBytes?: number; maxBytesPerItem?: number } = {},
): boolean {
  const p = blobPath(subdir, id)
  if (!p) return false
  const defaults = subdirCacheDefaults(subdir)
  const maxBytesPerItem = opts.maxBytesPerItem ?? defaults.maxBytesPerItem
  // Inside the guard, not above it: JSON.stringify itself throws on a value it cannot serialize --
  // a circular reference (an object graph a caller built by hand, or a tool result that references
  // its own request) or a BigInt -- and this function's contract is that it returns false on any
  // error and never throws. Uncaught, it propagated out of the one funnel every cached blob goes
  // through, into a hook, which is the one place a throw is never acceptable.
  let rawJson: string
  try {
    rawJson = JSON.stringify(value)
  } catch {
    return false
  }
  // Defense-in-depth: scan every blob for high-confidence secret patterns
  // (API keys, tokens, private-key blocks) before it ever reaches disk, so a
  // credential accidentally echoed into cached tool output isn't persisted
  // in plaintext. This is the single funnel every blob-persisting caller
  // (bash-output, web-output, mcp-output) goes through. Fail-safe, not
  // fail-open: if the redaction pass itself throws, skip caching this blob
  // entirely rather than risk writing unredacted content — consistent with
  // every other failure path in this function (oversized blob, mkdir
  // failure, write failure all return false without persisting).
  let json: string
  try {
    const result = redactSecrets(rawJson)
    json = result.text
    if (result.count > 0) recordStat('secret_redacted', 0, result.count, undefined, subdir)
  } catch {
    return false
  }
  if (Number.isFinite(maxBytesPerItem) && Buffer.byteLength(json, 'utf-8') > maxBytesPerItem) return false
  try {
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    atomicWriteText(p, json)
  } catch {
    return false
  }
  // Protect the blob this call just wrote from its own eviction pass below — a
  // misconfigured (or future) maxBytesPerItem/maxBytes pairing where the per-item
  // ceiling exceeds the total-directory budget must not silently delete the data
  // storeBlob() is about to report as successfully stored.
  pruneBlobs(
    subdir,
    opts.maxCount ?? defaults.maxCount,
    opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    opts.maxBytes ?? defaults.maxBytes,
    p,
  )
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
  maxBytes: number = Number.POSITIVE_INFINITY,
  protectedPath?: string,
): number {
  return pruneBlobDir(blobDir(subdir), maxCount, maxAgeMs, maxBytes, protectedPath)
}

/**
 * Same policy as {@link pruneBlobs}, but against an absolute directory rather than a subdir of
 * the current {@link tokenGoatHome}. Lets a sweep reach cache directories under a *second* root
 * (see {@link sweepCacheRoots}) without pretending they live under this process's home.
 *
 * The age cutoff applies to every file in the directory, not only `.json` blobs: a cache dir also
 * accumulates companions and debris that no blob id addresses -- `.txt`/`.gz` payloads written by
 * older versions, `.tmp` files from an interrupted atomic write, `.lock` files whose holder died.
 * None of those were ever removed by anything, so they survived every prune forever. The count and
 * byte budgets still consider only `.json` entries, since those are the addressable blobs the
 * budgets are expressed in.
 */
export function pruneBlobDir(
  dir: string,
  maxCount: number = DEFAULT_MAX_COUNT,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  maxBytes: number = Number.POSITIVE_INFINITY,
  protectedPath?: string,
): number {
  let removed = 0
  try {
    if (!fs.existsSync(dir)) return 0
    const cutoff = Date.now() - maxAgeMs
    let kept: Array<[string, number, number]> = []
    // The blob just written by this storeBlob() call, if any — never a candidate
    // for eviction in this pass, no matter how the age/count/byte-budget policies
    // below would otherwise treat it.
    let protectedEntry: [string, number, number] | undefined
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      if (protectedPath !== undefined && full === protectedPath) {
        protectedEntry = [full, stat.mtimeMs, stat.size]
        continue
      }
      if (stat.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(full)
          removed++
        } catch {
          continue
        }
      } else if (file.endsWith('.json')) {
        kept.push([full, stat.mtimeMs, stat.size])
      }
    }
    // The protected entry still occupies one of the maxCount slots.
    const countBudget = protectedEntry ? Math.max(0, maxCount - 1) : maxCount
    if (kept.length > countBudget) {
      kept.sort((a, b) => a[1] - b[1])
      const excess = kept.slice(0, kept.length - countBudget)
      kept = kept.slice(kept.length - countBudget)
      for (const [full] of excess) {
        try {
          fs.unlinkSync(full)
          removed++
        } catch {
          continue
        }
      }
    }
    if (Number.isFinite(maxBytes)) {
      kept.sort((a, b) => a[1] - b[1])
      let total = kept.reduce((sum, [, , size]) => sum + size, 0) + (protectedEntry ? protectedEntry[2] : 0)
      while (total > maxBytes && kept.length > 0) {
        const oldest = kept.shift()
        if (!oldest) break
        const [full, , size] = oldest
        try {
          fs.unlinkSync(full)
          removed++
          total -= size
        } catch {
          break
        }
      }
      // If the protected entry alone still exceeds maxBytes even with every other
      // evictable entry gone, that's a real "budget too small for this item"
      // situation — leave it in place rather than deleting the caller's just-written
      // data out from under a storeBlob() call that already reported success.
    }
  } catch {
    return removed
  }
  return removed
}

/**
 * Every cache subdir a sweep should reap, with the eviction policy that applies to it.
 *
 * Named as string literals rather than imported from their owning modules (bash_output_cache,
 * web_cache, session_store) because those modules all import *this* one -- importing back would
 * make the cycle. `mcp_outputs` has no current writer: MCP results share `bash_outputs` today,
 * but older versions wrote their own directory, and those files are still on disk with nothing
 * that ever removes them.
 *
 * `sessions` is deliberately age-only (no count cap). A session blob is not a cache entry that
 * can be re-fetched: it holds the read-dedup state for a live conversation, and evicting one by
 * count would silently reset that session's state mid-conversation. The age cutoff is safe on its
 * own because `saveSessionState` rewrites the file on every hook, so a live session's mtime never
 * goes stale.
 */
const SWEEPABLE_CACHE_SUBDIRS: ReadonlyArray<{ subdir: string; countCapped: boolean }> = [
  { subdir: 'bash_outputs', countCapped: true },
  { subdir: 'web_outputs', countCapped: true },
  { subdir: 'mcp_outputs', countCapped: true },
  { subdir: 'sessions', countCapped: false },
]

/**
 * Apply the standard blob-eviction policy to every cache subdir under `tokenGoatHome()` plus each
 * of `extraRoots`, and return how many files were removed.
 *
 * Nothing invoked eviction for these directories automatically before this: `storeBlob` prunes the
 * subdir it just wrote, but session state is written outside that funnel (session_store.ts writes
 * through `sessionPath`, not `storeBlob`), so the sessions directory grew without any bound at all
 * -- 83k files on the author's own machine, which every hook that lists sibling session states then
 * had to `readdir` past. `clean-cache`/`prune-cache` could fix it, but only if a human remembered
 * to run them.
 *
 * `extraRoots` exists for a second, older storage root: on Windows the caches used to live under
 * the data dir (`%LOCALAPPDATA%/dfk-helper/token-goat`) rather than `~/.token-goat`. Rather than
 * special-case "delete the legacy directory", the same age policy is applied to both roots. If a
 * root is genuinely still live its files are fresh and survive the cutoff; if it is dead, its
 * contents age out on their own. That reclaims the stranded copies with no bespoke migration code
 * and no way to delete data that is still in use.
 *
 * Fail-soft throughout: a bad root or subdir is skipped, never thrown.
 */
export function sweepCacheRoots(extraRoots: readonly string[] = []): number {
  let removed = 0
  const roots = [tokenGoatHome(), ...extraRoots]
  const seen = new Set<string>()
  for (const root of roots) {
    if (!root || seen.has(root)) continue
    seen.add(root)
    for (const { subdir, countCapped } of SWEEPABLE_CACHE_SUBDIRS) {
      try {
        const defaults = subdirCacheDefaults(subdir)
        removed += pruneBlobDir(
          path.join(root, subdir),
          countCapped ? defaults.maxCount : Number.POSITIVE_INFINITY,
          DEFAULT_MAX_AGE_MS,
          countCapped ? defaults.maxBytes : Number.POSITIVE_INFINITY,
        )
      } catch {
        // Best-effort housekeeping: one unreadable root or subdir must not abort the whole sweep.
      }
    }
  }
  return removed
}
