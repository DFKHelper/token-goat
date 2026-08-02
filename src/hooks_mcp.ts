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
import { redactSecrets } from './secret_redact.js'

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
  if (!toolName || !event.sessionId || !toolName.startsWith('mcp__')) return passOutput()
  const toolInput = getToolInput(event)
  // An in-band MCP error is a valid response, not a cacheable one — never let a
  // transient or now-resolved failure block every later identical retry.
  if (isMcpErrorResponse(event.raw)) return passOutput()
  const readOnly = isMcpReadOnly(toolName, toolInput)
  const resultText = extractToolResultText(event.raw)
  if (!resultText) return passOutput()
  // Caching/dedup remains strictly read-only-gated: a mutating or non-idempotent
  // call (e.g. a browser-automation `take_snapshot`, which trips MUTATING_VERBS_RE's
  // `snapshot` token even though its result is compressible) must never be served
  // back to a later identical pre_tool_use call, since its output can legitimately
  // differ call to call.
  let id: string | null = null
  if (readOnly) {
    const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
    // Idempotent: a re-fired post for an already-cached, still-fresh call writes nothing.
    if (getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)) return passOutput()
    id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  }
  // Deterministic structural compression (see mcp_compress.ts and mcp_compress_packs.ts) is gated
  // on compressibility, not on cache-eligibility: it used to require id !== null (i.e. the call was
  // already read-only-cached), which silently excluded every non-idempotent tool a compression pack
  // was written for -- e.g. chrome-devtools-mcp's take_snapshot, which trips MUTATING_VERBS_RE's
  // `snapshot` token, never reached mcp_compress_packs.ts's dedicated browser-snapshot pack in
  // production even though that pack exists specifically for it. Size-gated so small results are
  // never touched, and opt-out (not opt-in) via TOKEN_GOAT_MCP_COMPRESS=0 to match
  // TOKEN_GOAT_BASH_COMPRESS's existing convention elsewhere in this codebase. Per-server packs run
  // first (GitHub, browser-automation): a schema-aware pack strips known boilerplate before handing
  // the result to the same generic table-ifying pass. When no pack matches or pays off, the generic
  // pass runs on the untransformed text exactly as before the packs existed.
  if (resultText.length >= MCP_COMPRESS_MIN_BYTES && process.env['TOKEN_GOAT_MCP_COMPRESS'] !== '0') {
    const compressed = compressMcpResultWithPacks(toolName, resultText) ?? compressMcpResult(resultText)
    if (compressed !== null) {
      // A mutating/non-idempotent call was never cached above (readOnly is false), but the "full via
      // mcp-output <id>" label still needs somewhere to resolve, so store it now purely for recall --
      // this never feeds preMcpHandler's dedup check, which independently re-gates on isMcpReadOnly.
      if (id === null) id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
      if (id !== null) {
        // storeMcpOutput() above redacts before writing to the recall cache/index, but this
        // rewriteOutput is what the model actually reads THIS turn -- neither mcp_compress.ts nor
        // mcp_compress_packs.ts run any redaction themselves (they build `compressed` straight from
        // the raw resultText), so a secret sitting in an MCP result's non-stripped fields (a GitHub
        // PAT in a commit message, an API key in an env-dump tool's output) would reach the model
        // unredacted on this live path even though every other place that ever persists MCP output
        // redacts it first. Same defense-in-depth choke point ToolFilter.apply() applies for bash
        // output; mirror it here for MCP's live rewrite.
        return {
          hookType: 'rewriteOutput',
          updatedOutput: `[token-goat: compressed, full via mcp-output ${id}]\n${redactSecrets(compressed).text}`,
        }
      }
    }
  }
  return passOutput()
}

// Both handlers no-op unless the tool name starts with `mcp__` (preMcpHandler via
// isMcpReadOnly, postMcpHandler via its own startsWith check), so declaring that
// prefix lets installHooks narrow the settings.json matcher without losing them.
registerHook('pre_tool_use', preMcpHandler, { toolPattern: '^mcp__' })
registerHook('post_tool_use', postMcpHandler, { toolPattern: '^mcp__' })
