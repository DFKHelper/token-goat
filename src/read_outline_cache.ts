import { createHash } from 'node:crypto'

import { globalDbPath } from './constants.js'
import { getDb, getReadDb, isReadOnlyDb } from './db.js'
import { queryFileSymbolsWithIds } from './index_reader.js'
import type { SymbolEntry } from './parser_types.js'
import { redactSerializedJson } from './secret_redact.js'
import { registerReset } from './reset.js'

export interface OutlineListingCacheValue {
  resolved: string
  displayRoot: string | undefined
  filtered: SymbolEntry[]
  symbolIds: number[]
  preFilterCount: number
  refCounts: Map<string, number> | undefined
  fullSourceBytes: number
  symbolsTruncated: boolean
  trueSymbolCount: number | undefined
  totalLines: number
}

interface CacheEntry {
  value: OutlineListingCacheValue
  bytes: number
}

interface SerializedOutlineListing {
  version: number
  symbolIds: number[]
  preFilterCount: number
  fullSourceBytes: number
  symbolsTruncated: boolean
  trueSymbolCount: number | null
  totalLines: number
}

interface CacheReadContext {
  dbPath?: string
  resolved: string
  filePath: string
  displayRoot: string | undefined
}

interface CacheWriteOptions {
  dbPath?: string
}

const MAX_ENTRIES = 16
const MAX_ENTRY_BYTES = 96 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const PERSISTENT_CACHE_VERSION = 2
// limit: 5 persistent listings (at most 480 KiB of payload) revisit-when: measured misses show five entries are evicted before reuse.
const MAX_PERSISTENT_ENTRIES = Math.floor(MAX_TOTAL_BYTES / MAX_ENTRY_BYTES)
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function copyValue(value: OutlineListingCacheValue): OutlineListingCacheValue {
  return {
    ...value,
    filtered: value.filtered.map((symbol) => ({ ...symbol })),
    symbolIds: [...value.symbolIds],
    refCounts: value.refCounts === undefined ? undefined : new Map(value.refCounts),
  }
}

function estimateBytes(value: OutlineListingCacheValue): number {
  let bytes = 128 + value.filtered.length * 64 + value.symbolIds.length * 8 + (value.refCounts?.size ?? 0) * 40
  for (const symbol of value.filtered) {
    bytes +=
      2 *
      (symbol.filePath.length +
        symbol.name.length +
        symbol.kind.length +
        symbol.body.length +
        symbol.docstring.length +
        symbol.parent.length)
  }
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function serializedListing(value: OutlineListingCacheValue): string {
  const listing: SerializedOutlineListing = {
    version: PERSISTENT_CACHE_VERSION,
    symbolIds: value.symbolIds,
    preFilterCount: value.preFilterCount,
    fullSourceBytes: value.fullSourceBytes,
    symbolsTruncated: value.symbolsTruncated,
    trueSymbolCount: value.trueSymbolCount ?? null,
    totalLines: value.totalLines,
  }
  return redactSerializedJson(JSON.stringify(listing)).text
}

function parseSerializedListing(payload: string): SerializedOutlineListing | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['version'] !== PERSISTENT_CACHE_VERSION) return undefined

  const symbolIdsValue = parsed['symbolIds']
  if (!Array.isArray(symbolIdsValue)) return undefined
  const symbolIds = symbolIdsValue.filter(isNonNegativeInteger)
  if (symbolIds.length !== symbolIdsValue.length || new Set(symbolIds).size !== symbolIds.length) return undefined

  const preFilterCount = parsed['preFilterCount']
  const fullSourceBytes = parsed['fullSourceBytes']
  const symbolsTruncated = parsed['symbolsTruncated']
  const trueSymbolCount = parsed['trueSymbolCount']
  const totalLines = parsed['totalLines']
  if (
    !isNonNegativeInteger(preFilterCount) ||
    !isNonNegativeInteger(fullSourceBytes) ||
    typeof symbolsTruncated !== 'boolean' ||
    (trueSymbolCount !== null && !isNonNegativeInteger(trueSymbolCount)) ||
    !isNonNegativeInteger(totalLines)
  ) {
    return undefined
  }

  return {
    version: PERSISTENT_CACHE_VERSION,
    symbolIds,
    preFilterCount,
    fullSourceBytes,
    symbolsTruncated,
    trueSymbolCount,
    totalLines,
  }
}

function persistentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function readPersistentCache(key: string, context: CacheReadContext): OutlineListingCacheValue | undefined {
  try {
    const db = getReadDb(context.dbPath ?? globalDbPath())
    const row: unknown = db
      .prepare('SELECT payload FROM outline_listing_cache WHERE cache_version = ? AND cache_key = ?')
      .get(PERSISTENT_CACHE_VERSION, persistentKey(key))
    if (!isRecord(row) || typeof row['payload'] !== 'string' || Buffer.byteLength(row['payload'], 'utf8') > MAX_ENTRY_BYTES) {
      return undefined
    }

    const stored = parseSerializedListing(row['payload'])
    if (stored === undefined) return undefined
    const symbols = queryFileSymbolsWithIds(
      { filePath: context.filePath, ids: stored.symbolIds },
      context.dbPath ?? globalDbPath(),
    )
    if (symbols.length !== stored.symbolIds.length) return undefined
    return {
      resolved: context.resolved,
      displayRoot: context.displayRoot,
      filtered: symbols.map(({ symbol }) => symbol),
      symbolIds: symbols.map(({ id }) => id),
      preFilterCount: stored.preFilterCount,
      refCounts: undefined,
      fullSourceBytes: stored.fullSourceBytes,
      symbolsTruncated: stored.symbolsTruncated,
      trueSymbolCount: stored.trueSymbolCount ?? undefined,
      totalLines: stored.totalLines,
    }
  } catch {
    // A read-only database from an older build may lack this optional table; the index query remains authoritative.
    return undefined
  }
}

function writePersistentCache(key: string, value: OutlineListingCacheValue, dbPath: string): void {
  try {
    if (isReadOnlyDb(dbPath)) return
    const payload = serializedListing(value)
    if (Buffer.byteLength(payload, 'utf8') > MAX_ENTRY_BYTES) return

    const db = getDb(dbPath, { create: false })
    const save = db.transaction(() => {
      db.prepare('DELETE FROM outline_listing_cache WHERE cache_version = ? AND cache_key = ?').run(
        PERSISTENT_CACHE_VERSION,
        persistentKey(key),
      )
      db.prepare('INSERT INTO outline_listing_cache (cache_version, cache_key, payload) VALUES (?, ?, ?)').run(
        PERSISTENT_CACHE_VERSION,
        persistentKey(key),
        payload,
      )
      db.prepare(
        `DELETE FROM outline_listing_cache
         WHERE rowid NOT IN (
           SELECT rowid FROM outline_listing_cache ORDER BY rowid DESC LIMIT ?
         )`,
      ).run(MAX_PERSISTENT_ENTRIES)
    })
    save.immediate()
  } catch {
    // The optional cache is fail-soft: a redaction, lock, or database failure must not block outline or skeleton output.
  }
}

function remove(key: string): void {
  const existing = cache.get(key)
  if (existing === undefined) return
  cache.delete(key)
  cacheBytes -= existing.bytes
}

function remember(key: string, value: OutlineListingCacheValue): boolean {
  const bytes = estimateBytes(value)
  if (bytes > MAX_ENTRY_BYTES) return false
  remove(key)
  cache.set(key, { value: copyValue(value), bytes })
  cacheBytes += bytes

  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    remove(oldest.value)
  }
  return true
}

export function getOutlineListingCache(key: string, context?: CacheReadContext): OutlineListingCacheValue | undefined {
  const entry = cache.get(key)
  if (entry !== undefined) {
    cache.delete(key)
    cache.set(key, entry)
    const value = copyValue(entry.value)
    if (context !== undefined) {
      value.resolved = context.resolved
      value.displayRoot = context.displayRoot
      value.filtered = value.filtered.map((symbol) => ({ ...symbol, filePath: context.filePath }))
    }
    return value
  }
  if (context === undefined) return undefined

  const value = readPersistentCache(key, context)
  if (value === undefined || !remember(key, value)) return undefined
  return copyValue(value)
}

export function setOutlineListingCache(key: string, value: OutlineListingCacheValue, options: CacheWriteOptions = {}): void {
  if (!remember(key, value)) return
  writePersistentCache(key, value, options.dbPath ?? globalDbPath())
}

export function clearOutlineListingCache(): void {
  cache.clear()
  cacheBytes = 0
}

registerReset(clearOutlineListingCache)
