import type { ChannelHit, FusedSearchResult, SearchChannel } from './types.js';

export const DEFAULT_RRF_K = 60;

/** Largest gap in lines between two hits that may still fuse into one cluster. */
export const FUSION_GAP_LINES = 20;
/** Span in lines a cluster may grow to by fusing; a single hit that is already wider (a big symbol) is exempt. */
export const FUSION_SPAN_CAP = 200;

/** True when fusing two line ranges stays inside the gap window and the span cap. */
function withinFusionWindow(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const gap = Math.max(aStart, bStart) - Math.min(aEnd, bEnd) - 1;
  if (gap > FUSION_GAP_LINES) return false;
  const merged = Math.max(aEnd, bEnd) - Math.min(aStart, bStart) + 1;
  const widest = Math.max(aEnd - aStart + 1, bEnd - bStart + 1);
  return merged <= Math.max(FUSION_SPAN_CAP, widest);
}

/** Fuses ranked results from multiple search channels using Reciprocal Rank Fusion (RRF). Consolidates overlapping or identical hits from different angles and ranks by multi-channel consensus. Each channel contributes at most once per fused item (using its highest rank) to prevent single-channel clustering from artificially inflating consensus scores. */
export function fuseChannelHits(
  channelHitsMap: Map<SearchChannel, ChannelHit[]>,
  options: { limit?: number | undefined; k?: number | undefined; minScore?: number | undefined; weightOf?: ((filePath: string) => number) | undefined } = {},
): FusedSearchResult[] {
  if (options.limit === 0) return [];

  const k = Number.isFinite(options.k) && (options.k ?? 0) > 0 ? (options.k as number) : DEFAULT_RRF_K;
  const limit = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? (options.limit as number) : 15;
  const minScore = Number.isFinite(options.minScore) && (options.minScore ?? 0) >= 0 ? (options.minScore as number) : 0;

  interface Cluster {
    filePath: string;
    name?: string | undefined;
    kind?: string | undefined;
    lineStart: number;
    lineEnd: number;
    preview: string;
    bestRankPerChannel: Map<SearchChannel, number>;
    hits: ChannelHit[];
  }

  // Pool all hits across channels and sort them canonically so cluster formation is strictly order-independent
  const pooledHits: ChannelHit[] = [];
  for (const [channel, hits] of channelHitsMap.entries()) {
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!hit) continue;
      const rank = hit.rank > 0 ? hit.rank : i + 1;
      pooledHits.push({ ...hit, channel, rank });
    }
  }

  pooledHits.sort((a, b) => {
    const pathCmp = a.filePath.replace(/\\/g, '/').localeCompare(b.filePath.replace(/\\/g, '/'));
    if (pathCmp !== 0) return pathCmp;
    if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
    if (a.lineEnd !== b.lineEnd) return a.lineEnd - b.lineEnd;
    return a.channel.localeCompare(b.channel) || a.rank - b.rank;
  });

  // Group candidate hits by normalized file path
  const fileClusters = new Map<string, Cluster[]>();

  // Named hits form their clusters first so an unnamed hit always sees every enclosing symbol, whatever line order the pool sorted into
  const clusterOrder = [...pooledHits.filter((h) => h.name), ...pooledHits.filter((h) => !h.name)];

  for (const hit of clusterOrder) {
    const normPath = hit.filePath.replace(/\\/g, '/');

    let clusters = fileClusters.get(normPath);
    if (!clusters) {
      clusters = [];
      fileClusters.set(normPath, clusters);
    }

    let matchedCluster: Cluster | undefined;
    let growsSpan = true;

    if (hit.name) {
      for (const cluster of clusters) {
        if (
          cluster.name &&
          hit.name.toLowerCase() === cluster.name.toLowerCase() &&
          withinFusionWindow(cluster.lineStart, cluster.lineEnd, hit.lineStart, hit.lineEnd)
        ) {
          matchedCluster = cluster;
          break;
        }
      }
    } else {
      // An unnamed hit joins the tightest symbol that contains it, else the nearest one within the slack window, and never widens that symbol
      let bestSpan = Infinity;
      let bestDist = Infinity;
      let bestContains = false;
      for (const cluster of clusters) {
        if (!cluster.name) continue;
        const contains = hit.lineStart >= cluster.lineStart && hit.lineEnd <= cluster.lineEnd;
        const near = hit.lineStart >= cluster.lineStart - 5 && hit.lineEnd <= cluster.lineEnd + 5;
        if (!contains && !near) continue;
        const span = cluster.lineEnd - cluster.lineStart;
        const dist = contains ? 0 : Math.max(cluster.lineStart - hit.lineEnd, hit.lineStart - cluster.lineEnd, 0);
        const better =
          !matchedCluster ||
          (contains && !bestContains) ||
          (contains === bestContains && (contains ? span < bestSpan : dist < bestDist || (dist === bestDist && span < bestSpan)));
        if (better) {
          matchedCluster = cluster;
          bestSpan = span;
          bestDist = dist;
          bestContains = contains;
        }
      }
      if (matchedCluster) growsSpan = false;
      else {
        for (const cluster of clusters) {
          if (cluster.name) continue;
          // Both unnamed: match if ranges overlap or are within a 6-line locality margin
          const overlap = Math.max(cluster.lineStart, hit.lineStart) <= Math.min(cluster.lineEnd, hit.lineEnd) + 6;
          if (overlap && withinFusionWindow(cluster.lineStart, cluster.lineEnd, hit.lineStart, hit.lineEnd)) {
            matchedCluster = cluster;
            break;
          }
        }
      }
    }

    if (matchedCluster) {
      const prevBest = matchedCluster.bestRankPerChannel.get(hit.channel);
      if (prevBest === undefined || hit.rank < prevBest) {
        matchedCluster.bestRankPerChannel.set(hit.channel, hit.rank);
      }
      matchedCluster.hits.push(hit);
      if (growsSpan) {
        matchedCluster.lineStart = Math.min(matchedCluster.lineStart, hit.lineStart);
        matchedCluster.lineEnd = Math.max(matchedCluster.lineEnd, hit.lineEnd);
      }

      // Retain symbol name/kind if the existing cluster lacked it
      if (!matchedCluster.name && hit.name) matchedCluster.name = hit.name;
      if (!matchedCluster.kind && hit.kind) matchedCluster.kind = hit.kind;
      if (hit.preview && (!matchedCluster.preview || hit.preview.length > matchedCluster.preview.length)) {
        matchedCluster.preview = hit.preview;
      }
    } else {
      const bestRankMap = new Map<SearchChannel, number>();
      bestRankMap.set(hit.channel, hit.rank);
      clusters.push({
        filePath: hit.filePath,
        name: hit.name,
        kind: hit.kind,
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        preview: hit.preview,
        bestRankPerChannel: bestRankMap,
        hits: [hit],
      });
    }
  }

  // Flatten clusters and compute RRF scores
  const allClusters: Cluster[] = [];
  for (const clusters of fileClusters.values()) {
    allClusters.push(...clusters);
  }

  const results: FusedSearchResult[] = [];

  for (const entry of allClusters) {
    let rawScore = 0;
    const channels: SearchChannel[] = [];
    for (const [channel, bestRank] of entry.bestRankPerChannel.entries()) {
      channels.push(channel);
      rawScore += 1.0 / (k + bestRank);
    }
    // Applied before the minScore filter and the limit cut so a down-weighted hit neither survives on its unweighted score nor wastes a slot.
    if (options.weightOf) rawScore *= options.weightOf(entry.filePath);
    // Filter against unrounded score so borderline results are not dropped prematurely
    if (rawScore >= minScore) {
      // The best text hit keeps its own line so a wide enclosing symbol does not hide where the match is
      let matchHit: ChannelHit | undefined;
      for (const h of entry.hits) {
        if (h.channel === 'text' && (!matchHit || h.rank < matchHit.rank)) matchHit = h;
      }
      results.push({
        filePath: entry.filePath,
        name: entry.name,
        kind: entry.kind,
        lineStart: entry.lineStart,
        lineEnd: entry.lineEnd,
        preview: entry.preview,
        channels,
        score: Number(rawScore.toFixed(6)),
        channelHits: entry.hits,
        ...(matchHit ? { matchLine: matchHit.lineStart, matchPreview: matchHit.preview } : {}),
      });
    }
  }

  results.sort(
    (a, b) =>
      b.score - a.score ||
      a.filePath.localeCompare(b.filePath) ||
      a.lineStart - b.lineStart ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  );

  return results.slice(0, limit);
}
