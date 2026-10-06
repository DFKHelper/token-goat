import { executeParallelSearch } from './parallel_search.js';
import type { FusedSearchResult, SearchExecutionSummary, SearchOptions } from './types.js';
import { displaySafeJson, displaySafeText } from '../paths.js';
import { resolveProjectConfinement } from '../read_spec.js';

/** Formats one fused result as its location line, naming the channels that agreed on it, and a one-line preview. The fusion score stays in `--json`: it orders the list but tells a reader nothing the order does not. */
function formatTerminalHit(hit: FusedSearchResult, rank: number): string {
  const wide = hit.lineStart !== hit.lineEnd;
  const showMatch = hit.matchLine !== undefined && wide;
  const lineRange = showMatch ? `:${hit.matchLine}` : wide ? `:${hit.lineStart}-${hit.lineEnd}` : `:${hit.lineStart}`;
  const loc = `${displaySafeText(hit.filePath)}${lineRange}`;
  const spanInfo = showMatch ? `${hit.lineStart}-${hit.lineEnd}` : '';
  const symInfo = hit.name ? ` (${displaySafeText(hit.name)}${hit.kind ? ` · ${hit.kind}` : ''}${spanInfo ? ` ${spanInfo}` : ''})` : spanInfo ? ` (${spanInfo})` : '';

  const lines = [`${rank}. ${loc}${symInfo} ${hit.channels.join('+')}`];

  // A one-line hit shows its text match too: the fused preview is the longest of its channels' previews, and a semantic chunk's opening outlengths a line windowed on the match.
  const shownPreview = hit.matchPreview && (showMatch || hit.matchLine === hit.lineStart) ? hit.matchPreview : hit.preview;
  if (shownPreview) {
    const cleanPreview = shownPreview.replace(/\r?\n/g, ' ').slice(0, 120).trim();
    if (cleanPreview) lines.push(`   ${cleanPreview}`);
  }

  return lines.join('\n');
}

/** Renders a search summary as terminal text: one header line with the per-channel counts, any degraded-channel and relevance notes, then each hit on consecutive lines. */
export function formatSearchText(summary: SearchExecutionSummary): string {
  const notes = [
    ...(summary.degradedChannels ?? []).map((d) => `\n(note: ${d.channel} channel degraded: ${displaySafeText(d.reason)})`),
    ...(summary.notes ?? []).map((n) => `\n(note: ${n.channel} channel ${displaySafeText(n.note)})`),
  ].join('');

  if (summary.totalHits === 0) {
    return `No results found across active channels [${summary.activeChannels.join(', ')}] for: "${displaySafeText(summary.query)}" (${summary.durationMs}ms)${notes}`;
  }

  const counts = Object.entries(summary.channelCounts).map(([c, n]) => `${c}:${n}`).join(', ');
  const header = `${summary.totalHits} result${summary.totalHits === 1 ? '' : 's'} for "${displaySafeText(summary.query)}" in ${summary.durationMs}ms [${counts}]${notes}`;
  return [header, ...summary.results.map((hit, idx) => formatTerminalHit(hit, idx + 1))].join('\n');
}

/** Runs the parallel search command and formats the output. */
export async function runParallelSearch(options: SearchOptions): Promise<{ text: string; code: number }> {
  if (!options.query || options.query.trim().length === 0) {
    return {
      text: 'Usage: token-goat search <query> [--channels symbol,heading,text,semantic] [--limit <n>] [--json]',
      code: 1,
    };
  }

  // The symbol, heading and semantic channels read the machine-wide index, so a `--project` root outside what indexing.cross_project_symbols = false admits is refused the way `symbol --project` refuses it, rather than searched.
  const projectDenial = resolveProjectConfinement(options.projectRoot).denial;
  if (projectDenial !== null) {
    return { text: options.json === true ? displaySafeJson({ error: projectDenial }) : projectDenial, code: 1 };
  }

  const summary = await executeParallelSearch(options);

  if (options.json) {
    return {
      text: displaySafeJson(summary),
      code: 0,
    };
  }

  return { text: formatSearchText(summary), code: 0 };
}
