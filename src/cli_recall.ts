/**
 * CLI handler for `token-goat recall`.
 *
 * Unified full-text search across every bash-output, web-output, and
 * mcp-output cache entry, so an agent that doesn't remember which cache type
 * holds a prior result can search once instead of trying `bash-history` /
 * `web-history` / `mcp-history` in turn. Ranking and storage live in
 * recall_index.ts; this module is presentation only.
 */

import { searchRecall, type RecallCacheType, type RecallHit } from './recall_index.js'

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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function printHits(query: string, hits: readonly RecallHit[]): void {
  const w = (text: string) => { process.stdout.write(text) }
  if (hits.length === 0) {
    w(`No cache entries match: ${query}\n`)
    return
  }
  for (const hit of hits) {
    const label = hit.label.length > 80 ? hit.label.slice(0, 77) + '...' : hit.label
    w(`[${pad(hit.cacheType, 4)}] ${hit.id}  (token-goat ${RECALL_COMMAND[hit.cacheType]} ${hit.id})\n`)
    w(`  ${label}\n`)
    w(`  ${hit.snippet}\n\n`)
  }
}

/** Run the `token-goat recall <query>` command. */
export function runRecallCommand(query: string, opts: RecallCommandOptions = {}): void {
  const hits = searchRecall(query, {
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(hits)}\n`)
    return
  }

  printHits(query, hits)
}
