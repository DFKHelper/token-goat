import { executeParallelSearch } from './parallel_search.js';
import type { FusedSearchResult, SearchOptions } from './types.js';
import { displaySafeJson, displaySafeText } from '../paths.js';

/**
 * Formats a single fused search result for terminal display.
 */
function formatTerminalHit(hit: FusedSearchResult, rank: number): string {
  const channelBadge = hit.channels.map((c) => `[${c}]`).join('');
  const lineRange = hit.lineStart === hit.lineEnd ? `:${hit.lineStart}` : `:${hit.lineStart}-${hit.lineEnd}`;
  const loc = `${displaySafeText(hit.filePath)}${lineRange}`;
  const symInfo = hit.name ? ` (${displaySafeText(hit.name)}${hit.kind ? ` · ${hit.kind}` : ''})` : '';
  const scoreInfo = `score: ${hit.score.toFixed(4)}`;

  const lines = [
    `#${rank} ${channelBadge} ${loc}${symInfo} [${scoreInfo}]`,
  ];

  if (hit.preview) {
    const cleanPreview = hit.preview.replace(/\r?\n/g, ' ').slice(0, 120).trim();
    lines.push(`    ${cleanPreview}`);
  }

  return lines.join('\n');
}

/**
 * Runs the parallel search command and formats the output.
 */
export async function runParallelSearch(options: SearchOptions): Promise<{ text: string; code: number }> {
  if (!options.query || options.query.trim().length === 0) {
    return {
      text: 'Usage: token-goat search <query> [--channels symbol,heading,text,semantic] [--limit <n>] [--json]',
      code: 1,
    };
  }

  const summary = await executeParallelSearch(options);

  if (options.json) {
    return {
      text: displaySafeJson(summary),
      code: 0,
    };
  }

  if (summary.totalHits === 0) {
    return {
      text: `No results found across active channels [${summary.activeChannels.join(', ')}] for: "${displaySafeText(summary.query)}" (${summary.durationMs}ms)`,
      code: 0,
    };
  }

  const header = `Parallel Multi-Angle Search: "${displaySafeText(summary.query)}"\n` +
    `Found ${summary.totalHits} consensus results in ${summary.durationMs}ms ` +
    `[channels: ${Object.entries(summary.channelCounts).map(([c, n]) => `${c}:${n}`).join(', ')}]`;

  const items = summary.results.map((hit, idx) => formatTerminalHit(hit, idx + 1)).join('\n\n');

  return {
    text: `${header}\n\n${items}`,
    code: 0,
  };
}
