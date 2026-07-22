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
import { indexRecallEntry } from './recall_index.js'
import { redactSecrets } from './secret_redact.js'

/** Results larger than this are not cached (recall then degrades to a re-fetch). */
export const MCP_MAX_CACHE_BYTES = 2 * 1024 * 1024

// Allowlist, not a blocklist: any method that doesn't match a known-safe read verb defaults to NOT read-only, since a blocklist of mutating verbs (e.g. `finalize_plan`, `approve`, `cancel`, `deploy`, `toggle`, `pin`, `grant`, `sync`, `commit`, `apply`, `trigger`) can never be exhaustive, so an unclassified/unknown method must fail safe as mutating rather than silently being cached/deduped.
const READ_VERBS_RE =
  /(?:^|_)(?:get|list|search|read|view|fetch|describe|export|download|find|show|query|resolve|context)(?=_|$)/i

// Second guard layer, not a return to blocklist-only: a compound method name can carry a read-verb token (matching READ_VERBS_RE above) alongside a mutating-verb token, e.g. `get_or_create`, `search_and_update`, `view_and_delete` -- READ_VERBS_RE alone only checks that ONE token is a read verb, not that every token is read-safe, so those three would otherwise be misclassified as read-only. A method is only read-only when it matches the read-verb allowlist AND contains none of these mutating-verb tokens. `request` and `run` are anchored to the START of the method only (not any underscore token), same as the old blocklist: a leading `request_*` (e.g. `request_copilot_review`) or `run_*` (e.g. `run_workflow`, a dispatch/trigger call) is a mutating verb, but both also show up as a trailing noun in genuinely read-only names -- `request` in `get_network_request` / `get_console_message`'s siblings, and `run` in GitHub Actions' `get_workflow_run` / `get_workflow_run_logs` / `get_workflow_run_usage` / `list_workflow_run_artifacts` (an execution-instance noun, not the verb "to run") -- so matching either as a normal mid/trailing token would misclassify those real, commonly-called read-only tools as mutating and permanently block their caching/dedup.
const MUTATING_VERBS_RE =
  /^(?:request|run)(?=_|$)|(?:^|_)(?:create|update|delete|send|write|push|post|remove|label|unlabel|merge|modify|draft|fork|reply|move|rename|set|add|execute|close|copy|upload|insert|revoke|reset|archive|restore|annotate|register|unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban|click|fill|press|type|navigate|evaluate|drag|hover|handle|snapshot|wait|emulate|new|select|resize|audit|apply|commit|grant|deploy|toggle|pin|trigger|finalize|approve|cancel|sync)(?=_|$)/i

/**
 * Input keys that make an otherwise read-verb MCP call state-changing
 * regardless of tool name, e.g. `createIfEmpty` on `tabs_context_mcp`,
 * `clear` on the claude-in-chrome console/network readers, or `save_to_disk`
 * on a screenshot call. Anthropic's own permission system already treats
 * these flags as mutating (code.claude.com/docs/en/chrome), so the cache
 * must never dedup/serve a stale result for a call carrying one truthy.
 */
const STATE_CHANGING_INPUT_KEYS = ['createIfEmpty', 'clear', 'save_to_disk']

/**
 * Return true when *toolName* is a read-only MCP tool safe to cache.
 * Only `mcp__`-prefixed tools are considered; the trailing method segment is
 * matched against an ALLOWLIST of known-safe read verbs, so any mutating or
 * unrecognized verb fails safe as NOT read-only (never deduped) instead of
 * requiring every mutating verb to be enumerated up front.
 * *toolInput* is also inspected: a truthy `STATE_CHANGING_INPUT_KEYS` flag
 * overrides the name-based verdict, since it makes the specific call mutate
 * state even though the tool name itself reads as read-only.
 */
export function isMcpReadOnly(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!toolName.startsWith('mcp__')) {
    return false
  }
  const method = toolName.split('__').pop() || ''
  // Screenshots are not idempotent: page content can change between calls, so they must never be cached/dedup'd.
  if (/screenshot/i.test(method)) return false
  if (READ_VERBS_RE.test(method) && !MUTATING_VERBS_RE.test(method)) {
    return !STATE_CHANGING_INPUT_KEYS.some((key) => toolInput[key])
  }
  return false
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
  const rawSizeBytes = Buffer.byteLength(resultText, 'utf-8')
  if (rawSizeBytes > MCP_MAX_CACHE_BYTES) return null
  const id = mcpOutputId(sessionId, mcpHash(toolName, toolInput))
  const label = `mcp:${toolName} ${mcpInputPreview(toolInput)}`.trim()
  // Redact once and reuse everywhere -- storeBlob() applies its own defense-in-depth
  // redaction pass to the JSON it writes to disk, but the recall index write below
  // bypassed that pass entirely (indexed raw resultText), leaking secrets into
  // `token-goat recall`/FTS search. Redacting here keeps disk, in-memory, and the
  // recall index all consistent with the same sanitized text.
  const redactedOutput = redactSecrets(resultText).text
  const entry: BashOutputEntry = {
    id,
    command: label,
    output: redactedOutput,
    exitCode: 0,
    storedAt: Date.now(),
    // Sized off the redacted output, not the raw pre-redaction resultText (rawSizeBytes is only
    // the cache-eligibility gate above) -- mirrors bash_output_cache.ts's storeBashOutput, whose
    // sizeBytes is likewise computed from redactedOutput. Sizing off the raw text here left
    // mcp-audit's per-call token estimate and `mcp-history`'s byte column reporting a stale byte
    // count for any entry a secret was actually stripped from, out of sync with the stored/served
    // (redacted, shorter) output.
    sizeBytes: Buffer.byteLength(redactedOutput, 'utf-8'),
  }
  if (!storeBlob(BASH_OUTPUT_SUBDIR, id, entry)) return null
  // Keep the cross-cache recall index (`token-goat recall`) current -- see recall_index.ts.
  indexRecallEntry('mcp', id, label, `${label}\n${redactedOutput}`, entry.storedAt)
  return id
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
