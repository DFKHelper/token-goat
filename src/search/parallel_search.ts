import * as fs from 'node:fs';
import { getDb } from '../db.js';
import { globalDbPath } from '../constants.js';
import { searchSemantic, mergeNearbyHits, DEFAULT_MODEL, DEFAULT_DISTANCE_THRESHOLD } from '../embeddings.js';
import { searchSymbolsFts, getProjectFileEntries } from '../index_reader.js';
import { fuseChannelHits } from './rrf.js';
import type { ChannelHit, SearchChannel, SearchExecutionSummary, SearchOptions } from './types.js';

const ALL_CHANNELS: ReadonlyArray<SearchChannel> = ['symbol', 'heading', 'text', 'semantic'];

/**
 * Searches symbols via Full-Text Search and symbol queries.
 */
async function searchSymbolChannel(query: string, limit: number, rootDir?: string): Promise<ChannelHit[]> {
  try {
    const hits = searchSymbolsFts(query, limit * 2, globalDbPath(), rootDir);
    return hits
      .filter((s) => s.kind !== 'heading')
      .slice(0, limit)
      .map((sym, idx) => ({
        channel: 'symbol' as SearchChannel,
        filePath: sym.filePath,
        name: sym.name,
        kind: sym.kind,
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        preview: sym.docstring || (sym.body ? sym.body.slice(0, 140).trim() : `Symbol: ${sym.name}`),
        rank: idx + 1,
      }));
  } catch {
    return [];
  }
}

/**
 * Searches document and code section headings.
 */
async function searchHeadingChannel(query: string, limit: number, rootDir?: string): Promise<ChannelHit[]> {
  try {
    const hits = searchSymbolsFts(query, limit * 2, globalDbPath(), rootDir);
    return hits
      .filter((s) => s.kind === 'heading')
      .slice(0, limit)
      .map((sym, idx) => ({
        channel: 'heading' as SearchChannel,
        filePath: sym.filePath,
        name: sym.name,
        kind: 'heading',
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        preview: sym.name,
        rank: idx + 1,
      }));
  } catch {
    return [];
  }
}

/**
 * Searches textual file contents in parallel.
 */
async function searchTextChannel(query: string, limit: number, rootDir?: string): Promise<ChannelHit[]> {
  try {
    const fileEntries = getProjectFileEntries(rootDir ?? process.cwd());
    const hits: ChannelHit[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of fileEntries.values()) {
      if (hits.length >= limit) break;
      const fullPath = file.filePath;
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.size > 200_000) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line && line.toLowerCase().includes(lowerQuery)) {
          hits.push({
            channel: 'text' as SearchChannel,
            filePath: fullPath,
            lineStart: i + 1,
            lineEnd: i + 1,
            preview: line.slice(0, 140).trim(),
            rank: hits.length + 1,
          });
          if (hits.length >= limit) break;
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

/**
 * Searches dense embeddings and semantic vectors.
 */
async function searchSemanticChannel(query: string, limit: number, rootDir?: string): Promise<ChannelHit[]> {
  try {
    const db = getDb(globalDbPath());
    const rawHits = await searchSemantic(db, query, limit * 2, DEFAULT_MODEL, DEFAULT_DISTANCE_THRESHOLD, rootDir);
    const merged = mergeNearbyHits(rawHits);

    return merged.slice(0, limit).map((hit, idx) => ({
      channel: 'semantic' as SearchChannel,
      filePath: hit.filePath,
      kind: hit.kind,
      lineStart: hit.startLine,
      lineEnd: hit.endLine,
      preview: hit.text ? hit.text.slice(0, 140).trim() : `Match in ${hit.filePath}`,
      rawScore: hit.distance,
      rank: idx + 1,
    }));
  } catch {
    // Semantic search degrades gracefully if embeddings model or db is unavailable
    return [];
  }
}

/**
 * Executes multi-angle searches concurrently across all requested channels.
 */
export async function executeParallelSearch(options: SearchOptions): Promise<SearchExecutionSummary> {
  const startTime = Date.now();
  const query = options.query.trim();
  const limit = options.limit ?? 15;
  const projectRoot = options.projectRoot ?? process.cwd();
  const requestedChannels = options.channels && options.channels.length > 0 ? options.channels : ALL_CHANNELS;

  const channelPromises: Array<Promise<{ channel: SearchChannel; hits: ChannelHit[] }>> = [];

  for (const ch of requestedChannels) {
    if (ch === 'symbol') {
      channelPromises.push(searchSymbolChannel(query, limit, projectRoot).then((hits) => ({ channel: ch, hits })));
    } else if (ch === 'heading') {
      channelPromises.push(searchHeadingChannel(query, limit, projectRoot).then((hits) => ({ channel: ch, hits })));
    } else if (ch === 'text') {
      channelPromises.push(searchTextChannel(query, limit, projectRoot).then((hits) => ({ channel: ch, hits })));
    } else if (ch === 'semantic') {
      channelPromises.push(searchSemanticChannel(query, limit, projectRoot).then((hits) => ({ channel: ch, hits })));
    }
  }

  const settled = await Promise.allSettled(channelPromises);
  const channelHitsMap = new Map<SearchChannel, ChannelHit[]>();
  const channelCounts: Record<SearchChannel, number> = {
    symbol: 0,
    heading: 0,
    text: 0,
    semantic: 0,
  };

  for (const res of settled) {
    if (res.status === 'fulfilled') {
      const { channel, hits } = res.value;
      channelHitsMap.set(channel, hits);
      channelCounts[channel] = hits.length;
    }
  }

  const fusedResults = fuseChannelHits(channelHitsMap, {
    limit,
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
  });

  const durationMs = Date.now() - startTime;

  return {
    query,
    durationMs,
    totalHits: fusedResults.length,
    activeChannels: requestedChannels,
    channelCounts,
    results: fusedResults,
  };
}
