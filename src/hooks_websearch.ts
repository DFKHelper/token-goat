/** WebSearch caching/dedup hooks. post_tool_use: persist every WebSearch result into the shared MCP/bash-output store via {@link storeMcpOutput} (same mechanism `hooks_mcp.ts` uses for `mcp__*` calls), so results show up in `token-goat recall`/`mcp-history` and are retrievable via `token-goat mcp-output <id>` / `token-goat bash-output <id>`. pre_tool_use: when a same-or-near-identical query already ran this session (within the dedup TTL), deny the repeat and point at the cached result -- mirrors `hooks_grep.ts`'s dedup-deny shape, but keyed through the MCP cache (`getMcpOutput`) instead of the grep-specific session ledger. Deliberately no size floor on what gets cached (unlike hooks_agent_spawn.ts's AGENT_RESULT_CACHE_MIN_BYTES, which exists to keep typical small subagent reports out of the cache entirely): WebSearch results are usually small, and the whole point of this handler is dedup, so even a short result is worth pointing a repeat query at instead of re-running the search. The only size gate is `storeMcpOutput`'s own MCP_MAX_CACHE_BYTES ceiling and the empty-body guard shared with every other cache path in this codebase. */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, denyOutput, getToolName, getToolInput, extractToolResultText, isMcpErrorResponse, emitRewrite, emitRewriteIfChanged } from './hooks_common.js'
import { storeMcpOutput, getMcpOutput } from './mcp_cache.js'
import { loadConfig } from './config.js'
import { recordStat } from './stats.js'
import { scanAndRecord, fenceWithMatches, fenceJsonStrings } from './untrusted_fence.js'
import { neutralizeFenceMarkers, UNTRUSTED_WEB_TAG } from './injection_scan.js'
import { countRedactionPlaceholders, redactSecrets } from './secret_redact.js'
import { detectHarness } from './bridges/registry.js'

/** Collapse whitespace and case so "React hooks" and "  react   HOOKS  " dedup as the same query, mirroring grepSignature's normalization intent in hooks_grep.ts. */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Canonical, order-stable input to hash/store this WebSearch call under. Keyed on the normalized query plus sorted allow/block domain lists (both change what results come back, so they must be part of the identity), never on the raw `query` string, so near-identical repeats collapse to one cache entry the same way `grepSignature` does for Grep. Returns `null` when there is no usable query to key on. */
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

/** Claude Code's WebSearch result with every string element of `results` (the model's own summary of the pages) redacted and fenced in place, every string inside a hit object redacted and neutralized in place, and every other key left exactly as the harness built it. The harness validates a rewrite against the tool's output schema (claude.exe 2.1.296: `query` string, `results` an array of `{tool_use_id, content}` objects and/or strings, `durationSeconds` number, `searchCount` optional number) and keeps the original on a mismatch, so the fence has to go inside each string rather than around the whole result. Each string is redacted and fenced on its own: the text the rest of this handler works on is the whole result serialized as JSON, which cannot be split back into the elements it came from. A hit object reaches the model as `Links: <json>` beside the fenced summary, outside any fence, and fencing a title or a URL would break what it is, so its strings are cleaned where they sit instead: redacted, and stripped of the web fence's tag and of token-goat's own voice, either of which a page title can print. Its keys and nesting are kept, so the copy still validates. Null when the response is not that shape, or when no string in it changes: there is then nothing a valid rewrite would carry. */
function fenceWebSearchResults(toolResponse: unknown, injectionMatches: readonly string[]): Record<string, unknown> | null {
  const results = webSearchResults(toolResponse)
  if (results === null) return null
  let changed = false
  const clean = (text: string): string => {
    const cleaned = neutralizeFenceMarkers(redactSecrets(text).text, UNTRUSTED_WEB_TAG)
    if (cleaned !== text) changed = true
    return cleaned
  }
  const fenced = results.map((element: unknown) => {
    if (typeof element !== 'string') return fenceJsonStrings(element, clean)
    const rewritten = fenceWithMatches(redactSecrets(element).text, injectionMatches)
    if (rewritten !== element) changed = true
    return rewritten
  })
  return changed ? { ...(toolResponse as Record<string, unknown>), results: fenced } : null
}

/** The `results` array of Claude Code's WebSearch result object, or null when `toolResponse` is not that shape. */
function webSearchResults(toolResponse: unknown): unknown[] | null {
  if (toolResponse === null || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return null
  const results = (toolResponse as Record<string, unknown>)['results']
  return Array.isArray(results) ? results : null
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
    if (getToolName(event) !== 'WebSearch') return passOutput()
    const resultText = extractToolResultText(event.raw)
    if (!resultText) return passOutput()
    // A WebSearch result is third-party web content, exactly as untrusted as a WebFetch result -- fenced with the same UNTRUSTED_WEB_TAG for consistency with hooks_fetch.ts's postFetchHandler. Scanned and the fence decision computed before every guard below that can return early with this text already extracted, per CLAUDE.arch.md's Security Boundaries: a guard that exists to save cache work (an in-band error, a missing session id, an unkeyable query) must never double as a way around the injection scan.
    const injectionMatches = scanAndRecord(resultText)
    // Redact secrets on the same live path the fence above protects, computed here at the same point ahead of every early-return guard below rather than folded into any one of them -- a large WebSearch result can carry a credential (an API key pasted into a forum answer, a leaked token in an indexed gist) that trips no injection pattern at all, so gating redaction on injectionMatches would leave it unredacted. redactSecrets() is pure/synchronous and its own doc comment says it does not swallow a regex-engine failure itself, so it relies on this handler's outer try/catch the same way hooks_mcp.ts's postMcpHandler calls it unwrapped too.
    const redacted = redactSecrets(resultText)
    // Claude Code rejects any rewrite that is not its own result shape, so there the redacted, fenced strings travel inside a copy of that shape. Built here, beside the string form, for the same ordering reason as the two lines above.
    const shapedResponse = fenceWebSearchResults(event.raw['tool_response'], injectionMatches)
    const shipsShaped = detectHarness() === 'claudecode' && webSearchResults(event.raw['tool_response']) !== null
    // Unconditional: a WebSearch result is third-party web content by provenance, so it is fenced whether or not the eight deliberately-narrow patterns matched. It used to pass through unfenced on a clean scan, which meant any payload those patterns miss reached the model unmarked -- the fence's whole job is to survive a miss. The scan result now only decides whether the notice names pattern(s).
    const passOrFence = (): HookOutput => {
      const fenced = fenceWithMatches(redacted.text, injectionMatches)
      if (!shipsShaped) return emitRewriteIfChanged(resultText, fenced, 'websearch')
      // On Claude Code the shaped copy is the whole rewrite: with nothing in it to change, nothing ships.
      if (shapedResponse === null) return passOutput()
      // 'counted-elsewhere': the secret_redacted count is booked just below from the shaped copy, which is what Claude Code receives, rather than from the fenced string, which it never sees.
      const out = emitRewrite(fenced, 'websearch', undefined, 'counted-elsewhere')
      if (out.hookType !== 'rewriteOutput') return out
      const shippedRedactions = countRedactionPlaceholders(JSON.stringify(shapedResponse))
      if (shippedRedactions > 0) recordStat('secret_redacted', 0, shippedRedactions, undefined, 'websearch')
      return { ...out, updatedToolResponse: shapedResponse }
    }

    if (!event.sessionId) return passOrFence()
    const signature = webSearchSignatureInput(getToolInput(event))
    if (signature === null) return passOrFence()
    // An in-band error is a valid response, not a cacheable one. This cache is the one the pre-hook above denies against, so caching a failed search meant the next identical search was blocked and the model was pointed at the error message instead of being allowed to retry -- for the whole dedup window. Exactly the reasoning already written down in hooks_mcp.ts's isMcpErrorResponse, which WebSearch writes past into the same store.
    if (isMcpErrorResponse(event.raw)) return passOrFence()
    storeMcpOutput(event.sessionId, 'WebSearch', signature, resultText)
    return passOrFence()
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preWebSearchDedupHandler, { toolName: 'WebSearch' })
registerHook('post_tool_use', postWebSearchHandler, { toolName: 'WebSearch' })
