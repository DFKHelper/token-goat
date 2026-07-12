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
 *
 * A third, env-var-gated handler at the bottom of this file
 * (`mcpRewriteSpikeHandler`) is an output-rewrite feasibility spike, not a
 * caching handler — see its doc comment.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, denyOutput } from './hooks_common.js'
import { isMcpReadOnly, getMcpOutput, storeMcpOutput } from './mcp_cache.js'
import { loadConfig } from './config.js'

/**
 * Pull the textual result out of a tool_response payload. Handles the plain
 * string form, the Anthropic MCP `{ content: [{type:'text', text}] }` array,
 * the common `{output|text|body|content}` string fields, and finally a
 * JSON.stringify fallback so structured results still cache.
 */
export function extractMcpResultText(raw: Record<string, unknown>): string {
  const tr = raw['tool_response']
  if (typeof tr === 'string') return tr
  if (!tr || typeof tr !== 'object') return ''
  const resp = tr as Record<string, unknown>
  const content = resp['content']
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const text = (block as Record<string, unknown>)['text']
        if (typeof text === 'string') parts.push(text)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  for (const key of ['output', 'text', 'body']) {
    if (typeof resp[key] === 'string') return resp[key] as string
  }
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(resp)
  } catch {
    return ''
  }
}

/**
 * Return true when a tool_response is an MCP `CallToolResult` carrying an
 * in-band `isError: true` — a genuine tool-level failure ("tool not found",
 * bad params, a downstream API error surfaced through MCP) rather than a hard
 * transport failure. Such a response is still a normal, successful protocol
 * round trip, so {@link extractMcpResultText} happily returns its text; the
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
  const resultText = extractMcpResultText(event.raw)
  if (!resultText) return passOutput()
  storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  return passOutput()
}

registerHook('pre_tool_use', preMcpHandler)
registerHook('post_tool_use', postMcpHandler)

/**
 * Feasibility spike for MCP output rewriting — see the design doc referenced
 * in the commit this landed in. `postMcpHandler` above only ever caches and
 * returns `pass`; this handler is the first place token-goat ever emits a
 * `rewriteOutput` `HookOutput`. It round-trips a single low-traffic MCP
 * tool's result through the new `updatedToolOutput` wire shape UNCHANGED, so
 * the only thing under test is whether Claude Code actually honors a
 * `PostToolUse` output rewrite for an MCP tool call — not any compression
 * logic (there is none here).
 *
 * Inert by default on two independent axes so it is safe to leave wired in:
 * - `TOKEN_GOAT_MCP_REWRITE_SPIKE` must be exactly `'1'`.
 * - Even then, it only fires for {@link REWRITE_SPIKE_TOOL}, an intentionally
 *   rare, read-only, low-traffic MCP call (a GitHub team-membership lookup),
 *   so normal sessions with the env var left on by accident see no change to
 *   any tool they actually use routinely.
 *
 * Registered after `postMcpHandler` (not before): `postMcpHandler` always
 * returns `pass`, so this never races the cache write — the result is still
 * cached under its normal `mcp_<hash>` id via `postMcpHandler` first, and
 * only then does this handler get a chance to rewrite what the model sees.
 */
const REWRITE_SPIKE_TOOL = 'mcp__plugin_github_github__get_teams'

function mcpRewriteSpikeHandler(event: HookEvent): HookOutput {
  if (process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE'] !== '1') return passOutput()
  const resultText = extractMcpResultText(event.raw)
  if (!resultText) return passOutput()
  return { hookType: 'rewriteOutput', updatedOutput: resultText }
}

registerHook('post_tool_use', mcpRewriteSpikeHandler, { toolName: REWRITE_SPIKE_TOOL })
