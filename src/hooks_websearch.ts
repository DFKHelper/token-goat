/**
 * WebSearch caching/dedup hooks.
 *
 * post_tool_use: persist every WebSearch result into the shared MCP/bash-output
 * store via {@link storeMcpOutput} (same mechanism `hooks_mcp.ts` uses for
 * `mcp__*` calls), so results show up in `token-goat recall`/`mcp-history` and
 * are retrievable via `token-goat mcp-output <id>` / `token-goat bash-output <id>`.
 * pre_tool_use: when a same-or-near-identical query already ran this session
 * (within the dedup TTL), deny the repeat and point at the cached result --
 * mirrors `hooks_grep.ts`'s dedup-deny shape, but keyed through the MCP cache
 * (`getMcpOutput`) instead of the grep-specific session ledger.
 *
 * Deliberately no size floor on what gets cached (unlike hooks_agent_spawn.ts's
 * AGENT_RESULT_CACHE_MIN_BYTES, which exists to keep typical small subagent
 * reports out of the cache entirely): WebSearch results are usually small, and
 * the whole point of this handler is dedup, so even a short result is worth
 * pointing a repeat query at instead of re-running the search. The only size
 * gate is `storeMcpOutput`'s own MCP_MAX_CACHE_BYTES ceiling and the empty-body
 * guard shared with every other cache path in this codebase.
 */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, denyOutput, getToolName, getToolInput, extractToolResultText } from './hooks_common.js'
import { storeMcpOutput, getMcpOutput } from './mcp_cache.js'
import { loadConfig } from './config.js'
import { recordStat } from './stats.js'

/** Collapse whitespace and case so "React hooks" and "  react   HOOKS  " dedup as the
 *  same query, mirroring grepSignature's normalization intent in hooks_grep.ts. */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Canonical, order-stable input to hash/store this WebSearch call under.
 * Keyed on the normalized query plus sorted allow/block domain lists (both
 * change what results come back, so they must be part of the identity), never
 * on the raw `query` string, so near-identical repeats collapse to one cache
 * entry the same way `grepSignature` does for Grep. Returns `null` when there
 * is no usable query to key on.
 */
function webSearchSignatureInput(toolInput: Record<string, unknown>): Record<string, unknown> | null {
  const query = toolInput['query']
  if (typeof query !== 'string' || query.trim() === '') return null
  const canonical: Record<string, unknown> = { query: normalizeQuery(query) }
  const allowed = toolInput['allowed_domains']
  if (Array.isArray(allowed) && allowed.length > 0) {
    canonical['allowed_domains'] = [...allowed].sort()
  }
  const blocked = toolInput['blocked_domains']
  if (Array.isArray(blocked) && blocked.length > 0) {
    canonical['blocked_domains'] = [...blocked].sort()
  }
  return canonical
}

export function preWebSearchDedupHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'WebSearch' || !event.sessionId) return passOutput()
    const signature = webSearchSignatureInput(getToolInput(event))
    if (signature === null) return passOutput()
    const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
    const id = getMcpOutput(event.sessionId, 'WebSearch', signature, ttlMs)
    if (!id) return passOutput()
    recordStat('websearch_dedup_hint', 0, 0)
    return denyOutput(
      'An identical (or near-identical) WebSearch already ran this session and is cached. ' +
        'Use `token-goat bash-output ' + id + '` to recall it ' +
        '(add `--grep PATTERN`, `--tail N`, or `--head N` to slice) instead of repeating the search.',
    )
  } catch {
    return passOutput()
  }
}

export function postWebSearchHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'WebSearch' || !event.sessionId) return passOutput()
    const signature = webSearchSignatureInput(getToolInput(event))
    if (signature === null) return passOutput()
    const resultText = extractToolResultText(event.raw)
    if (!resultText) return passOutput()
    storeMcpOutput(event.sessionId, 'WebSearch', signature, resultText)
    return passOutput()
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preWebSearchDedupHandler, { toolName: 'WebSearch' })
registerHook('post_tool_use', postWebSearchHandler, { toolName: 'WebSearch' })
