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

import { shortFingerprint } from './fingerprint.js'
import { registerReset } from './reset.js'
import { storeBlob, loadBlob } from './disk_cache.js'

/** Subdir under the token-goat home where web-output blobs live. */
const WEB_OUTPUT_SUBDIR = 'web_outputs'

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
 */
export function storeWebOutput(url: string, content: string): string {
  const cacheId = cacheIdForUrl(url)
  _byId.set(cacheId, content)
  _urlIndex.set(url, cacheId)
  // Persist so a later, separate process (and the CLI) can recall the body.
  storeBlob(WEB_OUTPUT_SUBDIR, cacheId, { url, content })
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
 * URL (if recorded) re-populates the URL index.
 */
export function getWebOutput(cacheId: string): string | null {
  const hit = _byId.get(cacheId)
  if (hit !== undefined) return hit
  const blob = coerceWebBlob(loadBlob(WEB_OUTPUT_SUBDIR, cacheId))
  if (blob === null) return null
  _byId.set(cacheId, blob.content)
  if (blob.url !== null) _urlIndex.set(blob.url, cacheId)
  return blob.content
}

/**
 * Return the cached body and id for `url`, or null if the URL was not fetched
 * this session.
 */
export function getWebOutputByUrl(url: string): { cacheId: string; content: string } | null {
  const cacheId = _urlIndex.get(url)
  if (cacheId === undefined) return null
  const content = _byId.get(cacheId)
  if (content === undefined) return null
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
