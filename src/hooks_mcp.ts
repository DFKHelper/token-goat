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
import { getToolName, getToolInput, passOutput, denyOutput } from './hooks_common.js'
import { isMcpReadOnly, getMcpOutput, storeMcpOutput } from './mcp_cache.js'

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

function preMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !isMcpReadOnly(toolName) || !event.sessionId) return passOutput()
  const id = getMcpOutput(event.sessionId, toolName, getToolInput(event))
  if (!id) return passOutput()
  return denyOutput(
    'Identical read-only MCP call already cached this session. Use `token-goat bash-output ' +
      id +
      '` to recall the result (add `--grep PATTERN`, `--tail N`, or `--head N` to slice) instead of repeating the call.',
  )
}

function postMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !isMcpReadOnly(toolName) || !event.sessionId) return passOutput()
  const toolInput = getToolInput(event)
  // Idempotent: a re-fired post for an already-cached call writes nothing.
  if (getMcpOutput(event.sessionId, toolName, toolInput)) return passOutput()
  const resultText = extractMcpResultText(event.raw)
  if (!resultText) return passOutput()
  storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  return passOutput()
}

registerHook('pre_tool_use', preMcpHandler)
registerHook('post_tool_use', postMcpHandler)
