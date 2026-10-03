/** Merges semantic search hits from the same file around the best-matching chunk, kept out of embeddings.ts so an edit here does not move EMBED_FINGERPRINT and re-embed every index. */
import type { SearchHit } from './embeddings.js'

/** Chunk kinds that are one distinct unit each (one symbol, one heading section): neighbours of these are different things, so only lines they truly share may fuse them. */
const STRUCTURAL_CHUNK_KINDS: ReadonlySet<string> = new Set(['symbol', 'section'])

/** Merge hits from the same file that are the same region, anchored on the best-matching chunk so a merged hit is always described by its best chunk. Best-first, each unclaimed hit becomes an anchor and absorbs the unclaimed hits that overlap its own line range, or sit within `proximity` lines of it when neither is a distinct symbol/section chunk (window chunks have no structure of their own to respect). Absorption is measured against the anchor's range, never the growing union, so a run of adjacent chunks cannot chain into one whole-file span, and adjacent per-symbol chunks are never fused. The merged hit covers the union of its range, but its kind comes from the anchor, its text lists the anchor's chunk first, and its distance is the best raw distance in the group. Overlap is what sub-split pieces of one oversized symbol share, so those still collapse into one hit. @param hits - Array of search hits. @param proximity - Lines within which to consider window hits as "nearby" (default: 20). @returns Merged array of hits, re-sorted by rerank score (adjustedDistance) when present, falling back to raw distance otherwise. */
export function mergeNearbyHits(
  hits: SearchHit[],
  proximity: number = 20,
): SearchHit[] {
  if (hits.length <= 1) {
    return hits
  }

  const byFile = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const fileHits = byFile.get(hit.filePath)
    if (fileHits) {
      fileHits.push(hit)
    } else {
      byFile.set(hit.filePath, [hit])
    }
  }

  const merged: SearchHit[] = []

  for (const fileHits of byFile.values()) {
    const bestFirst = fileHits
      .map((hit, index) => ({ hit, index }))
      .sort((a, b) => (a.hit.adjustedDistance ?? a.hit.distance) - (b.hit.adjustedDistance ?? b.hit.distance) || a.index - b.index)
      .map((entry) => entry.hit)
    const claimed = new Set<SearchHit>()

    for (const anchor of bestFirst) {
      if (claimed.has(anchor)) continue
      claimed.add(anchor)
      const members: SearchHit[] = []
      for (const hit of bestFirst) {
        if (claimed.has(hit)) continue
        const gap = hit.startLine > anchor.endLine ? hit.startLine - anchor.endLine - 1 : anchor.startLine > hit.endLine ? anchor.startLine - hit.endLine - 1 : -1
        const distinctUnits = STRUCTURAL_CHUNK_KINDS.has(anchor.kind) || STRUCTURAL_CHUNK_KINDS.has(hit.kind)
        if (gap < 0 || (!distinctUnits && gap <= proximity)) {
          claimed.add(hit)
          members.push(hit)
        }
      }
      members.sort((a, b) => a.startLine - b.startLine)
      let startLine = anchor.startLine
      let endLine = anchor.endLine
      let distance = anchor.distance
      let adjusted = anchor.adjustedDistance ?? anchor.distance
      for (const m of members) {
        startLine = Math.min(startLine, m.startLine)
        endLine = Math.max(endLine, m.endLine)
        distance = Math.min(distance, m.distance)
        adjusted = Math.min(adjusted, m.adjustedDistance ?? m.distance)
      }
      merged.push({
        filePath: anchor.filePath,
        startLine,
        endLine,
        kind: anchor.kind,
        distance,
        adjustedDistance: adjusted,
        text: [anchor.text, ...members.map((m) => m.text)].join('\n---\n'),
      })
    }
  }

  // Sort by rerank score when available so rerankHits' ordering (verbatim-token boost, generated-path penalty) survives merging, instead of silently reverting to raw-distance order. Hits that never went through rerankHits (no adjustedDistance) fall back to their raw distance.
  merged.sort((a, b) => (a.adjustedDistance ?? a.distance) - (b.adjustedDistance ?? b.distance))
  return merged
}
