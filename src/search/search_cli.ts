import { executeParallelSearch } from './parallel_search.js';
import { ALL_CHANNELS, type FusedSearchResult, type SearchExecutionSummary, type SearchOptions } from './types.js';
import { displaySafeJson, displaySafeText } from '../paths.js';
import { DELETED_TAG } from '../read_commands.js';
import { resolveProjectConfinement } from '../read_spec.js';
import { canQuoteArg, echoedValue, fencedCommand, quotedArg, stripUnsafeSuggestions } from '../hint_suggestion_guard.js'

/** The default `--limit` of `token-goat search`, as src/cli.ts applies it: a rerun prints `--limit` only when the page's search used another. */
const DEFAULT_SEARCH_LIMIT = 20;

/** A weak semantic-only page shows this many hits before it names the one command that lists the rest. limit: three hits unless --channels is named, and --limit does not raise it. revisit-when: a reported weak page hides a hit the user needed, found by a rerun at rank four or lower. */
const WEAK_PAGE_SHOWN_HITS = 3;

/** The flags of the search that printed a page, which its rerun command repeats so it lists the same hits. */
interface WeakPageRerun {
  readonly limit?: number | undefined;
  readonly projectRoot?: string | undefined;
}

/** Formats one fused result as its location line, naming the channels that agreed on it, and a one-line preview. The fusion score stays in `--json`: it orders the list but tells a reader nothing the order does not. */
function formatTerminalHit(hit: FusedSearchResult, rank: number): string {
  const wide = hit.lineStart !== hit.lineEnd;
  const showMatch = hit.matchLine !== undefined && wide;
  const lineRange = showMatch ? `:${hit.matchLine}` : wide ? `:${hit.lineStart}-${hit.lineEnd}` : `:${hit.lineStart}`;
  const loc = `${displaySafeText(hit.filePath)}${lineRange}`;
  const spanInfo = showMatch ? `${hit.lineStart}-${hit.lineEnd}` : '';
  const symInfo = hit.name ? ` (${displaySafeText(hit.name)}${hit.kind ? ` · ${hit.kind}` : ''}${spanInfo ? ` ${spanInfo}` : ''})` : spanInfo ? ` (${spanInfo})` : '';

  const lines = [`${rank}. ${loc}${symInfo} ${hit.channels.join('+')}${hit.deleted === true ? `  ${DELETED_TAG}` : ''}`];

  // A one-line hit shows its text match too: the fused preview is the longest of its channels' previews, and a semantic chunk's opening outlengths a line windowed on the match.
  const shownPreview = hit.matchPreview && (showMatch || hit.matchLine === hit.lineStart) ? hit.matchPreview : hit.preview;
  if (shownPreview) {
    const cleanPreview = shownPreview.replace(/\r?\n/g, ' ').slice(0, 120).trim();
    if (cleanPreview) lines.push(`   ${cleanPreview}`);
  }

  return lines.join('\n');
}

/** Whether the summary is a weak semantic-only page: the semantic channel's best hit is above its weak distance and no other channel found anything. */
function isWeakSemanticPage(summary: SearchExecutionSummary): boolean {
  return summary.lowConfidence !== undefined && ALL_CHANNELS.every((c) => c === 'semantic' || summary.channelCounts[c] === 0);
}

/** The line standing in for the hits a weak page hides: the command that lists them when its query quotes and shows as typed, else the flag to add by hand. */
function hiddenWeakHitsLine(query: string, hidden: number, rerun: WeakPageRerun): string {
  const more = `${hidden} more weak semantic hit${hidden === 1 ? '' : 's'} not shown`;
  const byHand = `(${more}; rerun with -c semantic to list them)`;
  const projectRoot = rerun.projectRoot;
  if (!canQuoteArg(query) || displaySafeText(query) !== query) return byHand;
  if (projectRoot !== undefined && !canQuoteArg(projectRoot)) return byHand;
  const flags = [
    ...(rerun.limit !== undefined && rerun.limit !== DEFAULT_SEARCH_LIMIT ? [`--limit ${rerun.limit}`] : []),
    ...(projectRoot !== undefined ? [`--project ${quotedArg(projectRoot)}`] : []),
  ];
  const line = `(${more} -- ${fencedCommand(['token-goat search', quotedArg(query), ...flags, '-c semantic'].join(' '))} lists them)`;
  return stripUnsafeSuggestions(line) === line ? line : byHand;
}

/** Renders a search summary as terminal text: one header line with the per-channel counts, any degraded-channel and relevance notes, then each hit on consecutive lines. A weak semantic-only page with no channels named shows its first hits and one line for the rest. */
export function formatSearchText(summary: SearchExecutionSummary, explicitChannels = false, rerun: WeakPageRerun = {}): string {
  const notes = [
    ...(summary.degradedChannels ?? []).map((d) => `\n(note: ${d.channel} channel degraded: ${displaySafeText(d.reason)})`),
    ...(summary.notes ?? []).map((n) => `\n(note: ${n.channel} channel ${displaySafeText(n.note)})`),
  ].join('');

  if (summary.totalHits === 0) {
    return `No results found across active channels [${summary.activeChannels.join(', ')}] for: ${echoedValue(summary.query)} (${summary.durationMs}ms)${notes}`;
  }

  const counts = Object.entries(summary.channelCounts).map(([c, n]) => `${c}:${n}`).join(', ');
  const header = `${summary.totalHits} result${summary.totalHits === 1 ? '' : 's'} for ${echoedValue(summary.query)} in ${summary.durationMs}ms [${counts}]${notes}`;
  const capped = !explicitChannels && isWeakSemanticPage(summary) && summary.results.length > WEAK_PAGE_SHOWN_HITS;
  const shown = capped ? summary.results.slice(0, WEAK_PAGE_SHOWN_HITS) : summary.results;
  const lines = [header, ...shown.map((hit, idx) => formatTerminalHit(hit, idx + 1))];
  if (capped) lines.push(hiddenWeakHitsLine(summary.query, summary.results.length - WEAK_PAGE_SHOWN_HITS, rerun));
  return lines.join('\n');
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

  return { text: formatSearchText(summary, options.channels !== undefined, { limit: options.limit, projectRoot: options.projectRoot }), code: 0 };
}
