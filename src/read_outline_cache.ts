import type { SymbolEntry } from './parser_types.js'
import { registerReset } from './reset.js'

export interface OutlineListingCacheValue {
  resolved: string
  displayRoot: string | undefined
  filtered: SymbolEntry[]
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

const MAX_ENTRIES = 16
const MAX_ENTRY_BYTES = 96 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function copyValue(value: OutlineListingCacheValue): OutlineListingCacheValue {
  return {
    ...value,
    filtered: value.filtered.map((symbol) => ({ ...symbol })),
    refCounts: value.refCounts === undefined ? undefined : new Map(value.refCounts),
  }
}

function estimateBytes(value: OutlineListingCacheValue): number {
  let bytes = 128 + value.filtered.length * 64 + (value.refCounts?.size ?? 0) * 40
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

function remove(key: string): void {
  const existing = cache.get(key)
  if (existing === undefined) return
  cache.delete(key)
  cacheBytes -= existing.bytes
}

export function getOutlineListingCache(key: string): OutlineListingCacheValue | undefined {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return copyValue(entry.value)
}

export function setOutlineListingCache(key: string, value: OutlineListingCacheValue): void {
  const bytes = estimateBytes(value)
  if (bytes > MAX_ENTRY_BYTES) return

  remove(key)
  cache.set(key, { value: copyValue(value), bytes })
  cacheBytes += bytes

  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    remove(oldest.value)
  }
}

export function clearOutlineListingCache(): void {
  cache.clear()
  cacheBytes = 0
}

registerReset(clearOutlineListingCache)
