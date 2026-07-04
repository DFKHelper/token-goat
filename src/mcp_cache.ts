/**
 * MCP tool result cache — dedup repeated read-only MCP calls across hook
 * processes.
 *
 * Read-only `mcp__*` tool results are persisted into the shared bash-output
 * blob store (`~/.token-goat/bash_outputs/<id>.json`) so a result captured by
 * the post_tool_use hook process can be recalled — by a later pre_tool_use
 * process firing on an identical call, and by the session-less
 * `token-goat bash-output <id>` CLI. Reusing that proven cross-process store
 * (rather than a parallel MCP-specific one) keeps recall on a single working
 * path and adds no new CLI surface. The previous in-memory-only implementation
 * could never hit across the fresh-process-per-hook boundary.
 */

import { shortFingerprint } from './fingerprint.js'
import { storeBlob } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR, getBashOutput, type BashOutputEntry } from './bash_output_cache.js'

/** Results larger than this are not cached (recall then degrades to a re-fetch). */
export const MCP_MAX_CACHE_BYTES = 2 * 1024 * 1024

const MUTABLE_VERBS_RE = /^request(?=_|$)|(?:^|_)(?:create|update|delete|send|write|push|post|remove|label|unlabel|merge|modify|draft|fork|reply|move|rename|set|add|run|execute|close|copy|upload|insert|revoke|reset|archive|restore|annotate|register|unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban|click|fill|press|type|navigate|evaluate|drag|hover|handle|snapshot|wait|emulate|new|select|resize|audit)(?=_|$)/i

/**
 * Return true when *toolName* is a read-only MCP tool safe to cache.
 * Only `mcp__`-prefixed tools are considered; the trailing method segment is
 * matched against a verb blocklist so mutating calls are never deduped.
 */
export function isMcpReadOnly(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) {
    return false
  }
  const method = toolName.split('__').pop() || ''
  // Screenshots are not idempotent: page content can change between calls,
  // so they must never be cached/dedup'd.
  if (/screenshot/i.test(method)) return false
  return !MUTABLE_VERBS_RE.test(method)
}

/**
 * Return a 16-char hex hash for the (toolName, toolInput) pair.
 * Input dict is JSON-serialized with sorted keys for stability.
 */
export function mcpHash(toolName: string, toolInput: Record<string, unknown>): string {
  const sortedInput: Record<string, unknown> = {}
  for (const key of Object.keys(toolInput).sort()) {
    sortedInput[key] = toolInput[key]
  }
  const canonical = JSON.stringify({ tool: toolName, input: sortedInput })
  return shortFingerprint(canonical)
}

/**
 * Deterministic, fixed-length, session-scoped recall id for an MCP call.
 * Fingerprinting `${sessionId}\x00${hash}` keeps the id collision-resistant and
 * within the blob-store's 64-char id budget regardless of sessionId length, and
 * scopes the cache per session so two sessions issuing the same call do not
 * cross-pollinate.
 */
export function mcpOutputId(sessionId: string, hash: string): string {
  return `mcp_${shortFingerprint(`${sessionId}\x00${hash}`)}`
}

/** Short readable label stored as the blob's `command` for `bash-history`. */
function mcpInputPreview(toolInput: Record<string, unknown>): string {
  try {
    return JSON.stringify(toolInput).slice(0, 120)
  } catch {
    return ''
  }
}

/**
 * Persist a read-only MCP *resultText* into the shared bash-output store and
 * return its recall id, or null when the result is empty, the inputs are
 * unusable, or the result exceeds {@link MCP_MAX_CACHE_BYTES}.
 */
export function storeMcpOutput(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  resultText: string,
): string | null {
  if (!sessionId || !resultText) return null
  const sizeBytes = Buffer.byteLength(resultText, 'utf-8')
  if (sizeBytes > MCP_MAX_CACHE_BYTES) return null
  const id = mcpOutputId(sessionId, mcpHash(toolName, toolInput))
  const entry: BashOutputEntry = {
    id,
    command: `mcp:${toolName} ${mcpInputPreview(toolInput)}`.trim(),
    output: resultText,
    exitCode: 0,
    storedAt: Date.now(),
    sizeBytes,
  }
  return storeBlob(BASH_OUTPUT_SUBDIR, id, entry) ? id : null
}

/**
 * Return the recall id for a previously-stored identical MCP call, or null on a
 * miss. Resolves through the shared bash-output store, so a value cached by an
 * earlier hook process is found.
 */
export function getMcpOutput(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  ttlMs = Number.POSITIVE_INFINITY,
): string | null {
  if (!sessionId) return null
  const id = mcpOutputId(sessionId, mcpHash(toolName, toolInput))
  const entry = getBashOutput(id)
  if (!entry) return null
  if (Date.now() - entry.storedAt > ttlMs) return null
  return id
}
