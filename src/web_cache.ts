/**
 * In-memory web-fetch result cache.
 *
 * Ports the web-fetch dedup concept from `session.py` (mark_web_fetch /
 * lookup_web_entry): a previously fetched URL's body is kept so a redundant
 * re-fetch can be served from cache instead of hitting the network again.
 *
 * Storage is process-local: a `cacheId -> content` map plus a `url -> cacheId`
 * index. Cleared between tests via {@link registerReset}.
 */

import { shortFingerprint } from './fingerprint.js'
import { registerReset } from './reset.js'

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
  return cacheId
}

/** Return the cached body for `cacheId`, or null if not present. */
export function getWebOutput(cacheId: string): string | null {
  return _byId.get(cacheId) ?? null
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
