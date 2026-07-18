/**
 * MCP read-tool caching hooks.
 *
 * post_tool_use: persist a read-only `mcp__*` result into the shared
 * bash-output store. pre_tool_use: when an identical read-only `mcp__*` call was
 * already cached this session, deny it and point at `token-goat bash-output
 * <id>` so the model recalls a slice instead of paying the round trip again.
 *
 * Both handlers register with no toolName filter (MCP tool names are dynamic)
 * and self-gate on {@link isMcpReadOnly} plus a present sessionId, so they are
 * inert for every non-MCP and mutating tool.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, denyOutput, extractToolResultText } from './hooks_common.js'
import { isMcpReadOnly, getMcpOutput, storeMcpOutput } from './mcp_cache.js'
import { loadConfig } from './config.js'
import { compressMcpResult, MCP_COMPRESS_MIN_BYTES } from './mcp_compress.js'
import { compressMcpResultWithPacks } from './mcp_compress_packs.js'

/**
 * Return true when a tool_response is an MCP `CallToolResult` carrying an
 * in-band `isError: true` — a genuine tool-level failure ("tool not found",
 * bad params, a downstream API error surfaced through MCP) rather than a hard
 * transport failure. Such a response is still a normal, successful protocol
 * round trip, so {@link extractToolResultText} happily returns its text; the
 * caller must exclude it from caching so a one-off or transient error is not
 * served back to every identical retry until the dedup window ages out.
 */
export function isMcpErrorResponse(raw: Record<string, unknown>): boolean {
  const tr = raw['tool_response']
  if (!tr || typeof tr !== 'object') return false
  return (tr as Record<string, unknown>)['isError'] === true
}

function preMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !event.sessionId) return passOutput()
  const toolInput = getToolInput(event)
  if (!isMcpReadOnly(toolName, toolInput)) return passOutput()
  const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
  const id = getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)
  if (!id) return passOutput()
  return denyOutput(
    'Identical read-only MCP call already cached this session. Use `token-goat bash-output ' +
      id +
      '` to recall the result (add `--grep PATTERN`, `--tail N`, or `--head N` to slice) instead of repeating the call.',
  )
}

function postMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !event.sessionId) return passOutput()
  const toolInput = getToolInput(event)
  if (!isMcpReadOnly(toolName, toolInput)) return passOutput()
  // An in-band MCP error is a valid response, not a cacheable one — never let a
  // transient or now-resolved failure block every later identical retry.
  if (isMcpErrorResponse(event.raw)) return passOutput()
  const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
  // Idempotent: a re-fired post for an already-cached, still-fresh call writes nothing.
  if (getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)) return passOutput()
  const resultText = extractToolResultText(event.raw)
  if (!resultText) return passOutput()
  const id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  // Deterministic structural compression (see mcp_compress.ts and mcp_compress_packs.ts): only attempted when the full result was actually cached (id !== null), so the "full via mcp-output <id>" label always resolves, size-gated so small results are never touched, and opt-out (not opt-in) via TOKEN_GOAT_MCP_COMPRESS=0 to match TOKEN_GOAT_BASH_COMPRESS's existing convention elsewhere in this codebase. Per-server packs run first (GitHub, browser-automation): a schema-aware pack strips known boilerplate before handing the result to the same generic table-ifying pass. When no pack matches or pays off, the generic pass runs on the untransformed text exactly as before the packs existed.
  if (id !== null && resultText.length >= MCP_COMPRESS_MIN_BYTES && process.env['TOKEN_GOAT_MCP_COMPRESS'] !== '0') {
    const compressed = compressMcpResultWithPacks(toolName, resultText) ?? compressMcpResult(resultText)
    if (compressed !== null) {
      return {
        hookType: 'rewriteOutput',
        updatedOutput: `[token-goat: compressed, full via mcp-output ${id}]\n${compressed}`,
      }
    }
  }
  return passOutput()
}

registerHook('pre_tool_use', preMcpHandler)
registerHook('post_tool_use', postMcpHandler)
