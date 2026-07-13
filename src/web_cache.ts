/**
 * Web-fetch result cache with cross-process disk persistence.
 *
 * Ports the web-fetch dedup concept from `session.py` (mark_web_fetch /
 * lookup_web_entry): a previously fetched URL's body is kept so a redundant
 * re-fetch can be served from cache instead of hitting the network again, and so
 * `token-goat web-output <id>` can recall it.
 *
 * A per-process `cacheId -> content` map plus a `url -> cacheId` index front a
 * content-addressed disk store (`~/.token-goat/web_outputs/<cacheId>.json`).
 * Since the hooks and CLI run as separate processes, the disk layer is what lets
 * a body cached by one process be recalled by another. The in-memory maps are
 * cleared between tests via {@link registerReset}; the disk store is pruned by
 * age/count on each write.
 */

import fs from 'fs'
import { shortFingerprint } from './fingerprint.js'
import { registerReset } from './reset.js'
import { blobPath, DEFAULT_MAX_AGE_MS, loadBlob, storeBlob } from './disk_cache.js'
import { indexRecallEntry } from './recall_index.js'

/** Subdir under the token-goat home where web-output blobs live. */
export const WEB_OUTPUT_SUBDIR = 'web_outputs'

// cacheId -> stored body.
let _byId = new Map<string, string>()

// url -> cacheId (the most recent fetch wins for a given URL).
let _urlIndex = new Map<string, string>()

/**
 * Derive the deterministic cache id for `url`.
 *
 * The id is a 16-hex-char prefix of the URL's SHA-256, matching the
 * short-hash convention used across the Python cache layer
 * (`cache_common.py`, `bash_cache.py`). Deterministic so the same URL maps to
 * the same id within and across sessions.
 */
function cacheIdForUrl(url: string): string {
  return shortFingerprint(url)
}

/**
 * Store `content` for `url` and return its cache id.
 *
 * Re-storing the same URL overwrites the body and keeps the same id, so the
 * URL index always points at the latest content.
 *
 * `dedupKey` (default: `url`) is what the cache id is derived from. A caller
 * whose identity for "is this the same request" is broader than the bare URL
 * (e.g. hooks_fetch.ts, where a WebFetch answer is specific to the `prompt`
 * asked, not just the URL) can pass a composite key so two requests for the
 * same URL with different keys get distinct ids - while the blob's stored
 * `url` field (and `_urlIndex`, used by getWebOutputByUrl /
 * wasUrlFetchedThisSession) stay keyed on the real URL for display and
 * URL-only lookups.
 */
export function storeWebOutput(url: string, content: string, dedupKey: string = url): string {
  const cacheId = cacheIdForUrl(dedupKey)
  _byId.set(cacheId, content)
  _urlIndex.set(url, cacheId)
  // Persist so a later, separate process (and the CLI) can recall the body.
  storeBlob(WEB_OUTPUT_SUBDIR, cacheId, { url, content })
  // Keep the cross-cache recall index (`token-goat recall`) current -- see recall_index.ts.
  // Web blobs carry no storedAt field of their own; Date.now() at write time is the closest
  // available signal, same as bash-history/web-history's own mtime-based ordering fallback.
  indexRecallEntry('web', cacheId, url, `${url}\n${content}`, Date.now())
  return cacheId
}

/** Coerce an untrusted parsed-JSON blob into `{ url?, content }`, or null when
 * `content` is missing or not a string. */
function coerceWebBlob(raw: unknown): { url: string | null; content: string } | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['content'] !== 'string') return null
  return { url: typeof o['url'] === 'string' ? o['url'] : null, content: o['content'] }
}

/**
 * Return the cached body for `cacheId`, or null if not present.
 *
 * Falls back to the disk store on an in-memory miss so a body cached by an
 * earlier process (or run) resolves; a disk hit is cached in-process, and its
 * URL (if recorded) re-populates the URL index. Returns null if the disk entry
 * is older than DEFAULT_MAX_AGE_MS (stale cache).
 */
export function getWebOutput(cacheId: string): string | null {
  const hit = _byId.get(cacheId)
  if (hit !== undefined) return hit

  // Check TTL: if the file exists and is stale, treat as cache miss
  const p = blobPath(WEB_OUTPUT_SUBDIR, cacheId)
  if (p !== null) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p)
        const ageMs = Date.now() - stat.mtimeMs
        if (ageMs > DEFAULT_MAX_AGE_MS) {
          return null // Cache entry is stale
        }
      }
    } catch {
      // If we can't stat the file, fall through to loadBlob which will handle the error
    }
  }

  const blob = coerceWebBlob(loadBlob(WEB_OUTPUT_SUBDIR, cacheId))
  if (blob === null) return null
  _byId.set(cacheId, blob.content)
  if (blob.url !== null) _urlIndex.set(blob.url, cacheId)
  return blob.content
}

/**
 * Return the cached body and id for `url`, or null if the URL was not fetched
 * this session.
 *
 * In-memory only (by design — see `clearModuleCaches clears the in-memory
 * maps` in web_cache.test.ts): does not read through to the disk store, so a
 * URL fetched by an earlier, separate process will not resolve here even
 * though its body is still on disk. For a cross-process/cross-invocation
 * lookup keyed on a URL (each CLI run is a fresh process with no in-memory
 * state), use {@link getWebOutputByUrlFromDisk} instead.
 */
export function getWebOutputByUrl(url: string): { cacheId: string; content: string } | null {
  const cacheId = _urlIndex.get(url)
  if (cacheId === undefined) return null
  const content = _byId.get(cacheId)
  if (content === undefined) return null
  return { cacheId, content }
}

/**
 * Return the cached body and id for `url`, reading through to the disk store
 * on an in-memory miss.
 *
 * `cacheIdForUrl` is a pure function of `url` (a content-address, not a
 * value that needs to have been seen this process to compute), so the id can
 * be derived directly and handed to {@link getWebOutput}, which already reads
 * through to disk. This is what lets a URL-keyed cross-process caller (e.g.
 * `gdrive.ts`, where each CLI invocation is a fresh process) recall a body
 * persisted by an earlier invocation instead of always re-fetching over the
 * network.
 */
export function getWebOutputByUrlFromDisk(url: string): { cacheId: string; content: string } | null {
  const cacheId = cacheIdForUrl(url)
  const content = getWebOutput(cacheId)
  if (content === null) return null
  return { cacheId, content }
}

/** True if `url` was fetched (stored) this session. */
export function wasUrlFetchedThisSession(url: string): boolean {
  return _urlIndex.has(url)
}

registerReset(() => {
  _byId = new Map()
  _urlIndex = new Map()
})
