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
import { isBlobStale, loadBlob, storeBlob } from './disk_cache.js'
import { indexRecallEntry } from './recall_index.js'
import { redactSecrets } from './secret_redact.js'

/** Subdir under the token-goat home where web-output blobs live. */
export const WEB_OUTPUT_SUBDIR = 'web_outputs'

// cacheId -> stored body.
let _byId = new Map<string, string>()

// cacheId -> raw (pre-clean) body, only populated when the stored body was cleaned via extractCleanText (see hooks_fetch.ts) and therefore differs from the raw fetch.
let _rawById = new Map<string, string>()

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
 *
 * `rawContent`, if given and different from `content`, is the body as actually fetched, before
 * hooks_fetch.ts's extractCleanText cleaning pass. Stored alongside the cleaned `content` so the
 * cache stays lossless (recoverable via {@link getWebOutputRaw} / `web-output --raw`) even though
 * the default read path still returns the cleaned text.
 */
export function storeWebOutput(url: string, content: string, dedupKey: string = url, rawContent?: string): string {
  const cacheId = cacheIdForUrl(dedupKey)
  // Redact once and reuse everywhere -- storeBlob() applies its own defense-in-depth
  // redaction pass to the JSON it writes to disk, but the in-memory _byId cache and the
  // recall index write below both bypassed that pass entirely (served/indexed raw
  // content), leaking secrets via same-process reads and `token-goat recall`/FTS search.
  // Redacting here keeps disk, in-memory, and the recall index all consistent.
  const redactedContent = redactSecrets(content).text
  _byId.set(cacheId, redactedContent)
  _urlIndex.set(url, cacheId)
  const redactedRaw = rawContent !== undefined && rawContent !== content ? redactSecrets(rawContent).text : undefined
  if (redactedRaw !== undefined) _rawById.set(cacheId, redactedRaw)
  else _rawById.delete(cacheId)
  // Persist so a later, separate process (and the CLI) can recall the body.
  storeBlob(WEB_OUTPUT_SUBDIR, cacheId, redactedRaw !== undefined ? { url, content: redactedContent, raw: redactedRaw } : { url, content: redactedContent })
  // The url itself can carry a secret (a signed URL's token query param, an embedded API key)
  // just like content can -- redact ONLY the copy fed to the recall index (label/content), not
  // the `url` used above for _urlIndex/storeBlob: those need the real url intact for exact-match
  // lookups (getWebOutputByUrl) and display, and storeBlob() already applies its own whole-JSON
  // redaction pass to what actually lands on disk there. Without this, the recall index (a
  // separate, directly FTS-searchable table) indexed the raw url unconditionally, bypassing that
  // protection -- the same gap already closed for content/output above.
  const redactedUrl = redactSecrets(url).text
  // Keep the cross-cache recall index (`token-goat recall`) current -- see recall_index.ts. Web blobs carry no storedAt field of their own; Date.now() at write time is the closest available signal, same as bash-history/web-history's own mtime-based ordering fallback.
  indexRecallEntry('web', cacheId, redactedUrl, `${redactedUrl}\n${redactedContent}`, Date.now())
  return cacheId
}

/** Coerce an untrusted parsed-JSON blob into `{ url?, content, raw? }`, or null when `content` is missing or not a string. */
function coerceWebBlob(raw: unknown): { url: string | null; content: string; raw: string | null } | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['content'] !== 'string') return null
  return { url: typeof o['url'] === 'string' ? o['url'] : null, content: o['content'], raw: typeof o['raw'] === 'string' ? o['raw'] : null }
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

  if (isBlobStale(WEB_OUTPUT_SUBDIR, cacheId)) return null

  const blob = coerceWebBlob(loadBlob(WEB_OUTPUT_SUBDIR, cacheId))
  if (blob === null) return null
  _byId.set(cacheId, blob.content)
  if (blob.raw !== null) _rawById.set(cacheId, blob.raw)
  if (blob.url !== null) _urlIndex.set(blob.url, cacheId)
  return blob.content
}

/** Return the body as actually fetched for `cacheId`, before extractCleanText's cleaning pass -- the recovery path `web-output --raw` uses. Falls back to the cleaned body (same disk/staleness rules as {@link getWebOutput}) when no separate raw copy was stored, which covers both "the entry predates this raw-recovery feature" and "cleaning never ran for this entry (webfetch.compress_bodies was off, or the body was too small/not HTML)" -- in both cases the cleaned body IS the raw body, so there is nothing to lose. */
export function getWebOutputRaw(cacheId: string): string | null {
  const cleaned = getWebOutput(cacheId)
  if (cleaned === null) return null
  return _rawById.get(cacheId) ?? cleaned
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
 * `cacheIdForUrl` is a pure function of `dedupKey` (a content-address, not a
 * value that needs to have been seen this process to compute), so the id can
 * be derived directly and handed to {@link getWebOutput}, which already reads
 * through to disk. This is what lets a URL-keyed cross-process caller (e.g.
 * `gdrive.ts`, where each CLI invocation is a fresh process) recall a body
 * persisted by an earlier invocation instead of always re-fetching over the
 * network.
 *
 * `dedupKey` defaults to `url`, mirroring {@link storeWebOutput}'s own
 * default -- pass the exact same `dedupKey` used at store time (e.g. a
 * composite `${url}\x00${prompt}` key) so the id this function derives
 * always matches the id `storeWebOutput` actually persisted under.
 */
export function getWebOutputByUrlFromDisk(url: string, dedupKey: string = url): { cacheId: string; content: string } | null {
  const cacheId = cacheIdForUrl(dedupKey)
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
  _rawById = new Map()
  _urlIndex = new Map()
})
