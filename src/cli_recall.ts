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
import { fenceUntrustedContent, UNTRUSTED_WEB_TAG, UNTRUSTED_TOOL_TAG } from './injection_scan.js'
import { fenceUntrusted, scanAndRecord } from './untrusted_fence.js'

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



// recall reads back the same three cache stores that bash-output/web-output/mcp-output fence on
// recall (see _applyFiltersAndPrint in cli.ts), so a recalled snippet carries the same third-party
// provenance -- a fetched page for `web`, a dependency's build/test output or a remote MCP
// server's result for `bash`/`mcp`. `web` gets the web-fetch tag; `bash`/`mcp` share the tool-
// output tag cli.ts already uses for those two cache types.
function fenceTagForCacheType(cacheType: RecallCacheType): string {
  return cacheType === 'web' ? UNTRUSTED_WEB_TAG : UNTRUSTED_TOOL_TAG
}

/**
 * Fence one recall listing under the provenance tag its hits share, or the generic tool tag when
 * they mix. Unconditional: the fence follows the cache entry's provenance, not the scan result.
 * The scan still runs, purely to name matched pattern(s) in the notice and record the stat.
 *
 * Snippets are already-truncated (160-char) excerpts, not full documents, but the excerpt itself
 * is still attacker-authored text reaching the model. Fenced once around the whole listing rather
 * than once per hit: at 160 characters a per-hit wrapper costs a large fraction of the hit it
 * wraps, N times over, and the listing is emitted to the model as one blob regardless.
 */
function fenceRecallListing(text: string, hits: readonly RecallHit[]): string {
  const tags = new Set(hits.map((hit) => fenceTagForCacheType(hit.cacheType)))
  const tag = tags.size === 1 ? [...tags][0] ?? UNTRUSTED_TOOL_TAG : UNTRUSTED_TOOL_TAG
  return fenceUntrusted(text, tag)
}

/**
 * Scan one hit's snippet and, on a match, return it fenced under its cache type's provenance tag.
 * Per-field and still match-gated, for the `--json` envelope only: see the note at its call site
 * in {@link runRecallCommand}, and `fenceFileFieldIfMatched` in cli.ts for the same tradeoff.
 */
function fenceSnippetIfMatched(hit: RecallHit): string {
  const matches = scanAndRecord(hit.snippet)
  if (matches.length === 0) return hit.snippet
  return fenceUntrustedContent(hit.snippet, matches, fenceTagForCacheType(hit.cacheType))
}

function printHits(query: string | undefined, hits: readonly RecallHit[]): void {
  const w = (text: string) => { process.stdout.write(text) }
  if (hits.length === 0) {
    // Browsing an empty cache and searching a populated one for a term that isn't there are different answers, and collapsing them into one message sends the caller off to refine a query against a store that holds nothing.
    // token-goat's own message, carrying nothing from the cache: nothing to fence.
    w(query === undefined ? 'No cache entries yet.\n' : `No cache entries match: ${query}\n`)
    return
  }
  const body = hits
    .map((hit) => {
      const label = hit.label.length > 80 ? hit.label.slice(0, 77) + '...' : hit.label
      return (
        `[${pad(hit.cacheType, 4)}] ${hit.id}  (token-goat ${RECALL_COMMAND[hit.cacheType]} ${hit.id})\n` +
        `  ${label}\n` +
        `  ${hit.snippet}\n`
      )
    })
    .join('\n')
  w(`${fenceRecallListing(body, hits)}\n`)
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
    // Fence only the `snippet` field's value, not the envelope: it stays the same string type at
    // the same key, so a script parsing this JSON for id/cacheType/label/storedAt is unaffected,
    // and one wrapped in fence markup that is itself scanned is safer than one silently unfenced.
    // Still match-gated, unlike the printed branch: fencing the envelope once would be O(1) and
    // provenance-correct, but a fence wrapped around JSON is no longer JSON, and a per-field
    // wrapper on a 160-char snippet costs a large fraction of the snippet, once per hit.
    const fenced = hits.map((hit) => ({ ...hit, snippet: fenceSnippetIfMatched(hit) }))
    process.stdout.write(`${JSON.stringify(fenced)}\n`)
    return
  }

  printHits(browse ? undefined : query, hits)
}
