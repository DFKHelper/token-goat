import { registerReset } from './reset.js'

export interface HintTargetCandidate {
  name: string
  level: number
}

interface CacheEntry {
  candidates: HintTargetCandidate[]
  bytes: number
}

const MAX_ENTRIES = 32
const MAX_ENTRY_BYTES = 24 * 1024
const MAX_TOTAL_BYTES = 128 * 1024
const MAX_KEY_CHARS = 4096
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function copyCandidates(candidates: readonly HintTargetCandidate[]): HintTargetCandidate[] {
  return candidates.map((candidate) => ({ ...candidate }))
}

function estimateBytes(key: string, candidates: readonly HintTargetCandidate[]): number {
  return key.length * 2 + 64 + candidates.reduce((size, candidate) => size + 32 + candidate.name.length * 2, 0)
}

function remove(key: string): void {
  const existing = cache.get(key)
  if (existing === undefined) return
  cache.delete(key)
  cacheBytes -= existing.bytes
}

export function getHintTargetCandidates(key: string): HintTargetCandidate[] | undefined {
  if (key.length > MAX_KEY_CHARS) return undefined
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return copyCandidates(entry.candidates)
}

export function setHintTargetCandidates(key: string, candidates: readonly HintTargetCandidate[]): void {
  if (key.length > MAX_KEY_CHARS) return
  const bytes = estimateBytes(key, candidates)
  if (bytes > MAX_ENTRY_BYTES) return

  remove(key)
  cache.set(key, { candidates: copyCandidates(candidates), bytes })
  cacheBytes += bytes
  while (cache.size > MAX_ENTRIES || cacheBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    remove(oldest.value)
  }
}

export function clearHintTargetCache(): void {
  cache.clear()
  cacheBytes = 0
}

registerReset(clearHintTargetCache)
