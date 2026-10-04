import * as fs from 'node:fs';
import { getDb } from '../db.js';
import { globalDbPath } from '../constants.js';
import { searchSemantic, DEFAULT_MODEL, DEFAULT_DISTANCE_THRESHOLD } from '../embeddings.js';
import { mergeNearbyHits } from '../semantic_merge.js';
import { checkSemanticReadiness } from '../embed_preflight.js';
import { getOwnProjectFileEntries } from '../index_reader.js';
import { searchSymbolsFtsByKind } from './symbol_fts.js';
import { projectPathIsConsultable } from '../bridges/project_scope_guard.js';
import { readFileText } from '../read_commands.js';
import { fuseChannelHits } from './rrf.js';
import { bodyFromDeclaration } from '../read_suggest.js';
import { pathPriorityWeight } from './path_weight.js';
import { loadConfig } from '../config.js';
import { snippetAround } from '../snippet_window.js';
import { ALL_CHANNELS, type ChannelHit, type SearchChannel, type SearchExecutionSummary, type SearchOptions } from './types.js';

/** A symbol hit's preview: its docstring, else the first 140 characters of its body from the declaration on, so a decorated symbol previews as `def area(...)` rather than `@property`. */
export function symbolPreview(sym: { name: string; docstring?: string | null; body?: string | null }): string {
  if (sym.docstring) return sym.docstring;
  return sym.body ? bodyFromDeclaration(sym.body).slice(0, 140).trim() : `Symbol: ${sym.name}`;
}

/** A text hit's preview: a window of its line around the match, sized to fit the terminal's 120-character preview, so a match past the line's opening columns is still in what gets printed. */
function matchPreview(line: string, lowerQuery: string): string {
  const text = line.trim();
  return snippetAround(text, Math.max(0, text.toLowerCase().indexOf(lowerQuery)), 114);
}

/** Searches symbols via Full-Text Search and symbol queries. */
async function searchSymbolChannel(query: string, limit: number, rootDir?: string): Promise<{ hits: ChannelHit[]; degradedReason?: string }> {
  try {
    const hits = searchSymbolsFtsByKind(query, limit, globalDbPath(), rootDir, { notEquals: 'heading' });
    return {
      hits: hits.slice(0, limit).map((sym, idx) => ({
        channel: 'symbol' as SearchChannel,
        filePath: sym.filePath,
        name: sym.name,
        kind: sym.kind,
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        preview: symbolPreview(sym),
        rank: idx + 1,
      })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hits: [], degradedReason: msg };
  }
}

/** Searches document and code section headings. */
async function searchHeadingChannel(query: string, limit: number, rootDir?: string): Promise<{ hits: ChannelHit[]; degradedReason?: string }> {
  try {
    const hits = searchSymbolsFtsByKind(query, limit, globalDbPath(), rootDir, { equals: 'heading' });
    return {
      hits: hits.slice(0, limit).map((sym, idx) => ({
        channel: 'heading' as SearchChannel,
        filePath: sym.filePath,
        name: sym.name,
        kind: 'heading',
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        preview: sym.name,
        rank: idx + 1,
      })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hits: [], degradedReason: msg };
  }
}

/** Searches textual file contents in parallel with resource bounding. */
async function searchTextChannel(query: string, limit: number, rootDir?: string): Promise<{ hits: ChannelHit[]; degradedReason?: string }> {
  await Promise.resolve();
  try {
    const fileEntries = getOwnProjectFileEntries(rootDir ?? process.cwd());
    const lowerQuery = query.toLowerCase();
    let totalBytesScanned = 0;
    let filesScanned = 0;
    let visited = 0;
    let unreadableCount = 0;
    let capped = false;
    // A byte budget, not a file count: a count of 300 stopped this repo's scan at src/ while its 1,874 indexed files came to 22.8 MB, read in under 200 ms.
    const MAX_BYTES = 64 * 1024 * 1024;
    const PER_FILE_HITS = 3;
    const matched: Array<{ lines: Array<{ line: number; preview: string }>; count: number; filePath: string }> = [];

    for (const file of fileEntries.values()) {
      if (totalBytesScanned >= MAX_BYTES) {
        capped = true;
        break;
      }
      if (++visited % 50 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const fullPath = file.filePath;
      try {
        if (!projectPathIsConsultable(fullPath, rootDir ?? process.cwd())) continue;
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.size > 200_000) continue;
        filesScanned++;
        totalBytesScanned += stat.size;

        // Through the reader seam, not a plain utf-8 read: the matching line is printed as the preview, so a dotenv value has to come back masked the way `read` shows it, and a UTF-16 file has to be decoded before a query can match it.
        const content = readFileText(fullPath);
        if (content === null) {
          unreadableCount++;
          continue;
        }
        const lines = content.split(/\r?\n/);
        const found: { lines: Array<{ line: number; preview: string }>; count: number; filePath: string } = { lines: [], count: 0, filePath: fullPath };
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line && line.toLowerCase().includes(lowerQuery)) {
            found.count++;
            if (found.lines.length < PER_FILE_HITS) found.lines.push({ line: i + 1, preview: matchPreview(line, lowerQuery) });
          }
        }
        if (found.count > 0) matched.push(found);
      } catch {
        unreadableCount++;
      }
    }

    // Every file is scanned before any hit is kept, then the files that mention the query most go first and each gives one line per round: stopping at the first `limit` matching lines handed every slot to whatever sorted first, so a changelog or a docs folder that mentions a name often could crowd out the file that defines it.
    matched.sort((a, b) => b.count - a.count);
    const hits: ChannelHit[] = [];
    for (let round = 0; round < PER_FILE_HITS && hits.length < limit; round++) {
      for (const file of matched) {
        const hit = file.lines[round];
        if (!hit) continue;
        hits.push({ channel: 'text' as SearchChannel, filePath: file.filePath, lineStart: hit.line, lineEnd: hit.line, preview: hit.preview, rank: hits.length + 1 });
        if (hits.length >= limit) break;
      }
    }

    const degradedParts: string[] = [];
    if (capped) {
      degradedParts.push(`Scanned ${filesScanned} files (${Math.round(totalBytesScanned / 1024)} KB, capped)`);
    }
    if (unreadableCount > 0) {
      degradedParts.push(`${unreadableCount} files skipped due to read errors`);
    }

    return {
      hits,
      ...(degradedParts.length > 0 ? { degradedReason: degradedParts.join('; ') } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hits: [], degradedReason: msg };
  }
}

/** Searches dense embeddings and semantic vectors. */
async function searchSemanticChannel(query: string, limit: number, rootDir?: string): Promise<{ hits: ChannelHit[]; degradedReason?: string }> {
  try {
    const preflight = await checkSemanticReadiness(rootDir !== undefined ? { projectRoot: rootDir } : undefined);
    if (preflight.status !== 'ready') {
      return { hits: [], degradedReason: `Semantic indexing not ready: ${preflight.summary}` };
    }
    const db = getDb(globalDbPath());
    const rawHits = await searchSemantic(db, query, limit * 2, DEFAULT_MODEL, DEFAULT_DISTANCE_THRESHOLD, rootDir);
    const merged = mergeNearbyHits(rawHits);

    const hits = merged.slice(0, limit).map((hit, idx) => ({
      channel: 'semantic' as SearchChannel,
      filePath: hit.filePath,
      kind: hit.kind,
      lineStart: hit.startLine,
      lineEnd: hit.endLine,
      preview: hit.text ? hit.text.slice(0, 140).trim() : `Match in ${hit.filePath}`,
      rawScore: hit.distance,
      rank: idx + 1,
    }));
    return { hits };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { hits: [], degradedReason: msg };
  }
}

/** Executes multi-angle searches concurrently across all requested channels. */
export async function executeParallelSearch(options: SearchOptions): Promise<SearchExecutionSummary> {
  const startTime = Date.now();
  const query = options.query.trim().slice(0, 500);
  const limit = options.limit ?? 15;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (options.limit === 0) {
    return {
      query,
      durationMs: 0,
      totalHits: 0,
      activeChannels: [],
      channelCounts: { symbol: 0, heading: 0, text: 0, semantic: 0 },
      results: [],
    };
  }

  const requestedChannels = options.channels && options.channels.length > 0
    ? options.channels.filter((ch) => ALL_CHANNELS.includes(ch))
    : ALL_CHANNELS;

  const channelPromises: Array<Promise<{ channel: SearchChannel; hits: ChannelHit[]; degradedReason?: string }>> = [];

  for (const ch of requestedChannels) {
    if (ch === 'symbol') {
      channelPromises.push(
        searchSymbolChannel(query, limit, projectRoot)
          .then((res) => ({
            channel: ch,
            hits: res.hits,
            ...(res.degradedReason !== undefined ? { degradedReason: res.degradedReason } : {}),
          }))
          .catch((err: unknown) => ({ channel: ch, hits: [], degradedReason: String(err) })),
      );
    } else if (ch === 'heading') {
      channelPromises.push(
        searchHeadingChannel(query, limit, projectRoot)
          .then((res) => ({
            channel: ch,
            hits: res.hits,
            ...(res.degradedReason !== undefined ? { degradedReason: res.degradedReason } : {}),
          }))
          .catch((err: unknown) => ({ channel: ch, hits: [], degradedReason: String(err) })),
      );
    } else if (ch === 'text') {
      channelPromises.push(
        searchTextChannel(query, limit, projectRoot)
          .then((res) => ({
            channel: ch,
            hits: res.hits,
            ...(res.degradedReason !== undefined ? { degradedReason: res.degradedReason } : {}),
          }))
          .catch((err: unknown) => ({ channel: ch, hits: [], degradedReason: String(err) })),
      );
    } else if (ch === 'semantic') {
      channelPromises.push(
        searchSemanticChannel(query, limit, projectRoot)
          .then((res) => ({
            channel: ch,
            hits: res.hits,
            ...(res.degradedReason !== undefined ? { degradedReason: res.degradedReason } : {}),
          }))
          .catch((err: unknown) => ({ channel: ch, hits: [], degradedReason: String(err) })),
      );
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
  const degradedChannels: Array<{ channel: SearchChannel; reason: string }> = [];

  for (const res of settled) {
    if (res.status === 'fulfilled') {
      const { channel, hits, degradedReason } = res.value;
      channelHitsMap.set(channel, hits);
      channelCounts[channel] = hits.length;
      if (degradedReason) {
        degradedChannels.push({ channel, reason: degradedReason });
      }
    }
  }

  const semanticConfig = loadConfig().semantic;
  const fusedResults = fuseChannelHits(channelHitsMap, {
    limit,
    weightOf: (p) => pathPriorityWeight(p, semanticConfig),
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
  });

  const durationMs = Date.now() - startTime;

  return {
    query,
    durationMs,
    totalHits: fusedResults.length,
    activeChannels: requestedChannels,
    channelCounts,
    ...(degradedChannels.length > 0 ? { degradedChannels } : {}),
    results: fusedResults,
  };
}
