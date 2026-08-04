/**
 * Local, bounded storage for generic compressed text and named handoffs.
 *
 * Content is redacted before compression and persistence, then stored through
 * the shared blob funnel so the existing cache bounds and secret protection
 * remain in force.
 */
import { deflateRawSync } from 'node:zlib'
import * as path from 'node:path'

import { isBlobStale, loadBlob, listBlobs, storeBlob } from './disk_cache.js'
import { shortFingerprint } from './fingerprint.js'
import { findProject } from './project.js'
import { redactSecrets } from './secret_redact.js'
import { recordStat } from './stats.js'

export const CONTENT_MAX_INPUT_CHARS = 512 * 1024
export const CONTENT_MAX_ITEMS = 256
export const CONTENT_MAX_BYTES = 32 * 1024 * 1024
// JSON escaping can expand a 512 KiB string to nearly 3 MiB (for example,
// every character being a control character). Keep the advertised input limit
// valid for all legal text while the directory-wide cache limit still bounds use.
export const CONTENT_MAX_ITEM_BYTES = CONTENT_MAX_INPUT_CHARS * 7
export const CONTENT_SUBDIR = 'content'

interface StoredContent {
  kind: 'content'
  id: string
  text: string
  createdAt: number
}

interface StoredHandoff {
  kind: 'handoff'
  id: string
  name: string
  projectRoot: string
  contentId: string
  text: string
  createdAt: number
}

export interface CompressionResult {
  id: string
  compact: string
  encoding: 'deflate-raw-base64url'
  originalBytes: number
  compactBytes: number
  bytesSaved: number
  recovery: string
}

export interface HandoffResult {
  id: string
  name: string
  contentId: string
  projectRoot: string
  recovery: string
}

function assertInput(text: string): void {
  if (text.length > CONTENT_MAX_INPUT_CHARS) {
    throw new Error(`text exceeds the ${CONTENT_MAX_INPUT_CHARS}-character safety limit`)
  }
}

function contentId(text: string): string {
  return `tg_${shortFingerprint(text)}`
}

function normalizeProjectRoot(projectRoot?: string): string {
  const candidate = path.resolve(projectRoot ?? process.cwd())
  return findProject(candidate)?.root ?? candidate
}

function handoffId(name: string, projectRoot: string): string {
  return `tg_handoff_${shortFingerprint(`${projectRoot}\x00${name}`)}`
}

function storeContent(text: string): string {
  const id = contentId(text)
  const value: StoredContent = { kind: 'content', id, text, createdAt: Date.now() }
  const ok = storeBlob(CONTENT_SUBDIR, id, value, {
    maxCount: CONTENT_MAX_ITEMS,
    maxBytes: CONTENT_MAX_BYTES,
    maxBytesPerItem: CONTENT_MAX_ITEM_BYTES,
  })
  if (!ok) throw new Error('unable to persist compressed content within the local cache bounds')
  return id
}

function readContent(id: string): string | null {
  if (!/^tg_[0-9a-f]{16}$/.test(id)) return null
  if (isBlobStale(CONTENT_SUBDIR, id)) return null
  const value = loadBlob(CONTENT_SUBDIR, id)
  if (value === null || typeof value !== 'object' || value === null) return null
  const entry = value as Partial<StoredContent>
  return entry.kind === 'content' && entry.id === id && typeof entry.text === 'string' ? entry.text : null
}

export function compressText(text: string): CompressionResult {
  assertInput(text)
  const safeText = redactSecrets(text).text
  const id = storeContent(safeText)
  const compact = deflateRawSync(Buffer.from(safeText, 'utf8'), { level: 9 }).toString('base64url')
  const originalBytes = Buffer.byteLength(safeText, 'utf8')
  const compactBytes = Buffer.byteLength(compact, 'utf8')
  const bytesSaved = Math.max(0, originalBytes - compactBytes)
  recordStat('content_compress', bytesSaved, Math.round(bytesSaved / 4))
  return {
    id,
    compact,
    encoding: 'deflate-raw-base64url',
    originalBytes,
    compactBytes,
    bytesSaved,
    recovery: `token-goat retrieve ${id}`,
  }
}

export function retrieveText(id: string): string | null {
  const text = readContent(id)
  if (text === null) return null
  recordStat('content_retrieve')
  return text
}

export function createHandoff(name: string, text: string, projectRoot?: string): HandoffResult {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new Error('handoff name must be 1-128 characters using letters, numbers, dot, underscore, or hyphen')
  }
  assertInput(text)
  const root = normalizeProjectRoot(projectRoot)
  const safeText = redactSecrets(text).text
  const contentIdValue = storeContent(safeText)
  const id = handoffId(name, root)
  const value: StoredHandoff = {
    kind: 'handoff',
    id,
    name,
    projectRoot: root,
    contentId: contentIdValue,
    // Keep the handoff independently resolvable if the generic content entry
    // is later evicted from the shared bounded cache.
    text: safeText,
    createdAt: Date.now(),
  }
  const ok = storeBlob(CONTENT_SUBDIR, id, value, {
    maxCount: CONTENT_MAX_ITEMS,
    maxBytes: CONTENT_MAX_BYTES,
    maxBytesPerItem: CONTENT_MAX_ITEM_BYTES,
  })
  if (!ok) throw new Error('unable to persist handoff within the local cache bounds')
  recordStat('handoff_create')
  return { id, name, contentId: contentIdValue, projectRoot: root, recovery: `token-goat handoff-resolve ${name}` }
}

export function resolveHandoff(name: string, opts: { projectRoot?: string; full?: boolean } = {}): CompressionResult | string | null {
  const root = normalizeProjectRoot(opts.projectRoot)
  const id = handoffId(name, root)
  if (isBlobStale(CONTENT_SUBDIR, id)) return null
  const value = loadBlob(CONTENT_SUBDIR, id)
  if (value === null || typeof value !== 'object' || value === null) return null
  const entry = value as Partial<StoredHandoff>
  if (
    entry.kind !== 'handoff' ||
    entry.projectRoot !== root ||
    typeof entry.contentId !== 'string' ||
    typeof entry.text !== 'string'
  ) return null
  const text = entry.text
  recordStat('handoff_resolve')
  if (opts.full === true) return text
  return compressText(text)
}

export function listContentForTesting(): Array<{ id: string; mtime: number }> {
  return listBlobs(CONTENT_SUBDIR).map(({ id, mtime }) => ({ id, mtime }))
}
