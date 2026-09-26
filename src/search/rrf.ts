import type { ChannelHit, FusedSearchResult, SearchChannel } from './types.js';

export const DEFAULT_RRF_K = 60;

/**
 * Fuses ranked results from multiple search channels using Reciprocal Rank Fusion (RRF).
 * Consolidates overlapping or identical hits from different angles and ranks by multi-channel consensus.
 */
export function fuseChannelHits(
  channelHitsMap: Map<SearchChannel, ChannelHit[]>,
  options: { limit?: number | undefined; k?: number | undefined; minScore?: number | undefined } = {},
): FusedSearchResult[] {
  const k = options.k ?? DEFAULT_RRF_K;
  const limit = options.limit ?? 15;
  const minScore = options.minScore ?? 0;

  // Map keyed by canonical identifier: filePath + normalized symbol name or line bucket
  const aggregated = new Map<
    string,
    {
      filePath: string;
      name?: string | undefined;
      kind?: string | undefined;
      lineStart: number;
      lineEnd: number;
      preview: string;
      channels: Set<SearchChannel>;
      score: number;
      hits: ChannelHit[];
    }
  >();

  for (const [channel, hits] of channelHitsMap.entries()) {
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!hit) continue;
      const rank = hit.rank > 0 ? hit.rank : i + 1;
      const rrfScore = 1.0 / (k + rank);

      // Create grouping key: if symbol name exists, group by file + symbol name;
      // otherwise group by file + line bucket (+/- 3 lines)
      const lineBucket = Math.floor(hit.lineStart / 4) * 4;
      const key = hit.name
        ? `${hit.filePath}::${hit.name.toLowerCase()}`
        : `${hit.filePath}#${lineBucket}`;

      const existing = aggregated.get(key);
      if (existing) {
        existing.channels.add(channel);
        existing.score += rrfScore;
        existing.hits.push(hit);
        // Retain more specific symbol/kind/preview if available
        if (!existing.name && hit.name) existing.name = hit.name;
        if (!existing.kind && hit.kind) existing.kind = hit.kind;
        if (hit.preview && (!existing.preview || hit.preview.length > existing.preview.length)) {
          existing.preview = hit.preview;
        }
      } else {
        aggregated.set(key, {
          filePath: hit.filePath,
          name: hit.name,
          kind: hit.kind,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          preview: hit.preview,
          channels: new Set<SearchChannel>([channel]),
          score: rrfScore,
          hits: [hit],
        });
      }
    }
  }

  const results: FusedSearchResult[] = Array.from(aggregated.values())
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      filePath: entry.filePath,
      name: entry.name,
      kind: entry.kind,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      preview: entry.preview,
      channels: Array.from(entry.channels),
      score: Number(entry.score.toFixed(6)),
      channelHits: entry.hits,
    }));

  return results;
}
