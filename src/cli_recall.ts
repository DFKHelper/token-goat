/**
 * CLI handler for `token-goat recall`.
 *
 * Unified full-text search across every bash-output, web-output, and
 * mcp-output cache entry, so an agent that doesn't remember which cache type
 * holds a prior result can search once instead of trying `bash-history` /
 * `web-history` / `mcp-history` in turn. Ranking and storage live in
 * recall_index.ts; this module is presentation only.
 */

import { listRecentRecall, searchRecall, type RecallCacheType, type RecallHit } from './recall_index.js'
import { pad } from './util.js'

export interface RecallCommandOptions {
  type?: RecallCacheType
  limit?: number
  json?: boolean
}

// The existing per-type recall command each hit's id resolves through -- mcp entries share
// bash-output's blob-store subdir but have their own dedicated recall command (mcp-output),
// see mcp_cache.ts's storeMcpOutput and cli.ts's cmdMcpOutput.
const RECALL_COMMAND: Record<RecallCacheType, string> = {
  bash: 'bash-output',
  web: 'web-output',
  mcp: 'mcp-output',
}



function printHits(query: string | undefined, hits: readonly RecallHit[]): void {
  const w = (text: string) => { process.stdout.write(text) }
  if (hits.length === 0) {
    // Browsing an empty cache and searching a populated one for a term that isn't there are different answers, and collapsing them into one message sends the caller off to refine a query against a store that holds nothing.
    w(query === undefined ? 'No cache entries yet.\n' : `No cache entries match: ${query}\n`)
    return
  }
  for (const hit of hits) {
    const label = hit.label.length > 80 ? hit.label.slice(0, 77) + '...' : hit.label
    w(`[${pad(hit.cacheType, 4)}] ${hit.id}  (token-goat ${RECALL_COMMAND[hit.cacheType]} ${hit.id})\n`)
    w(`  ${label}\n`)
    w(`  ${hit.snippet}\n\n`)
  }
}

/** Run the `token-goat recall [query]` command. With no query, browse the index newest-first instead of searching it -- see {@link listRecentRecall}. A whitespace-only query is treated as no query rather than as a search that can only ever match nothing. */
export function runRecallCommand(query: string | undefined, opts: RecallCommandOptions = {}): void {
  const browse = query === undefined || query.trim() === ''
  const scope = {
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  }
  const hits = browse ? listRecentRecall(scope) : searchRecall(query, scope)

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(hits)}\n`)
    return
  }

  printHits(browse ? undefined : query, hits)
}
