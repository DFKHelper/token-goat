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
import { getToolName, getToolInput, passOutput, denyOutput, extractToolResultText, isMcpErrorResponse, emitRewrite, emitRewriteIfChanged } from './hooks_common.js'
import { isMcpReadOnly, getMcpOutput, mcpOutputBytes, storeMcpOutput } from './mcp_cache.js'
import { PER_FILE_COUNTERFACTUAL_CEILING } from './util.js'
import { loadConfig } from './config.js'
import { compressMcpResult, MCP_COMPRESS_MIN_BYTES } from './mcp_compress.js'
import { compressMcpResultWithPacks } from './mcp_compress_packs.js'
import { redactSecrets } from './secret_redact.js'
import { UNTRUSTED_TOOL_TAG } from './injection_scan.js'
import { scanAndRecord, fenceWithMatches } from './untrusted_fence.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

// Defined in hooks_common.ts alongside extractToolResultText, whose output the rule is about, and re-exported here because this module was its only caller for a while.
export { isMcpErrorResponse } from './hooks_common.js'

function preMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !event.sessionId) return passOutput()
  const toolInput = getToolInput(event)
  if (!isMcpReadOnly(toolName, toolInput)) return passOutput()
  const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
  const id = getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)
  if (!id) return passOutput()
  // The denied call never runs, so its result never reaches the model a second time. Credit that blocked re-arrival the way preSkillHandler credits a blocked skill re-load: the cached entry's stored (redacted) size, capped at PER_FILE_COUNTERFACTUAL_CEILING because the counterfactual being priced is a response that would itself have been truncated. The full raw result is the right counterfactual here specifically because postMcpHandler returns early on a cache hit (see its getMcpOutput guard), so the allowed second call would have shipped the result uncompressed. No sibling stat double-counts these bytes: mcp:compress only ever fires on a call that actually ran, which this deny prevents.
  const denyCredit = Math.min(mcpOutputBytes(id), PER_FILE_COUNTERFACTUAL_CEILING)
  recordStat('mcp:recall', denyCredit, savedTokensFromBytes(denyCredit))
  return denyOutput(
    'Identical read-only MCP call already cached this session. Use `token-goat bash-output ' +
      id +
      '` to recall the result (add `--grep PATTERN`, `--tail N`, or `--head N` to slice) instead of repeating the call.',
  )
}

function postMcpHandler(event: HookEvent): HookOutput {
  const toolName = getToolName(event)
  if (!toolName || !toolName.startsWith('mcp__')) return passOutput()
  const toolInput = getToolInput(event)
  const resultText = extractToolResultText(event.raw)
  if (!resultText) return passOutput()
  // An MCP result is a remote server's output: the least trusted text in the pipeline, and the one surface a page-only injection scan never covered. Scanned before every early return below, because each of those returns was a way for the same hostile text to reach the model unmarked: an in-band error response carries text just as a success does, a harness that omits the session id still shows the model the result, and the read-only dedup return fires on the SECOND of two identical calls -- whose result a hostile or time-varying server is free to make different from the first. Caching is what those guards exist to gate; the fence is not.
  const injectionMatches = scanAndRecord(resultText)
  // Redact secrets on this same live path, computed once here ahead of every early-return guard below -- an MCP result carrying a bare credential (an API key in an env-dump tool's output, a PAT sitting in a commit message) trips no injection pattern at all, so gating redaction on injectionMatches (as fenced() alone used to) would leave every non-fenced return -- no session id, an in-band MCP error, a dedup cache hit, and the terminal "compression did not fire or did not pay off" return below -- shipping it unredacted. Mirrors postWebSearchHandler's and postFetchHandler's fix for the same gap.
  const redactedResult = redactSecrets(resultText)
  const fenced = (): HookOutput =>
    emitRewriteIfChanged(
      resultText,
      fenceWithMatches(redactedResult.text, injectionMatches, UNTRUSTED_TOOL_TAG),
      'mcp',
    )
  // Unconditional: an MCP result is a remote server's output by provenance, so it is fenced
  // whether or not the eight deliberately-narrow patterns matched. It used to pass through
  // unfenced on a clean scan, which meant any payload those patterns miss reached the model
  // unmarked -- the fence's whole job is to survive a miss. The scan result now only decides
  // whether the notice names pattern(s).
  const passOrFence = (): HookOutput => fenced()

  if (!event.sessionId) return passOrFence()
  // An in-band MCP error is a valid response, not a cacheable one - never let a transient or now-resolved failure block every later identical retry.
  if (isMcpErrorResponse(event.raw)) return passOrFence()
  const readOnly = isMcpReadOnly(toolName, toolInput)
  // Caching/dedup remains strictly read-only-gated: a mutating or non-idempotent call (e.g. a browser-automation `take_snapshot`, which trips MUTATING_VERBS_RE's `snapshot` token even though its result is compressible) must never be served back to a later identical pre_tool_use call, since its output can legitimately differ call to call.
  let id: string | null = null
  if (readOnly) {
    const ttlMs = loadConfig().hints.mcp_dedup_ttl_secs * 1000
    // Idempotent: a re-fired post for an already-cached, still-fresh call writes nothing.
    if (getMcpOutput(event.sessionId, toolName, toolInput, ttlMs)) return passOrFence()
    id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
  }
  // Deterministic structural compression (see mcp_compress.ts and mcp_compress_packs.ts) is gated on compressibility, not on cache-eligibility: it used to require id !== null (i.e. the call was already read-only-cached), which silently excluded every non-idempotent tool a compression pack was written for -- e.g. chrome-devtools-mcp's take_snapshot, which trips MUTATING_VERBS_RE's `snapshot` token, never reached mcp_compress_packs.ts's dedicated browser-snapshot pack in production even though that pack exists specifically for it. Size-gated so small results are never touched, and opt-out (not opt-in) via TOKEN_GOAT_MCP_COMPRESS=0 to match TOKEN_GOAT_BASH_COMPRESS's existing convention elsewhere in this codebase. Per-server packs run first (GitHub, browser-automation): a schema-aware pack strips known boilerplate before handing the result to the same generic table-ifying pass. When no pack matches or pays off, the generic pass runs on the untransformed text exactly as before the packs existed.
  if (resultText.length >= MCP_COMPRESS_MIN_BYTES && process.env['TOKEN_GOAT_MCP_COMPRESS'] !== '0') {
    const compressed = compressMcpResultWithPacks(toolName, resultText) ?? compressMcpResult(resultText)
    if (compressed !== null) {
      // A mutating/non-idempotent call was never cached above (readOnly is false), but the "full via mcp-output <id>" label still needs somewhere to resolve, so store it now purely for recall -- this never feeds preMcpHandler's dedup check, which independently re-gates on isMcpReadOnly.
      if (id === null) id = storeMcpOutput(event.sessionId, toolName, toolInput, resultText)
      if (id !== null) {
        // storeMcpOutput() above redacts before writing to the recall cache/index, but this rewriteOutput is what the model actually reads THIS turn -- neither mcp_compress.ts nor mcp_compress_packs.ts run any redaction themselves (they build `compressed` straight from the raw resultText), so a secret sitting in an MCP result's non-stripped fields (a GitHub PAT in a commit message, an API key in an env-dump tool's output) would reach the model unredacted on this live path even though every other place that ever persists MCP output redacts it first. Same defense-in-depth choke point ToolFilter.apply() applies for bash output; mirror it here for MCP's live rewrite.
        const redactedBody = redactSecrets(compressed).text
        const notice = `[token-goat: compressed, full via mcp-output ${id}]\n`
        // Net-benefit gate (shared with bash_runner's filter pipeline, see tool_filters/base.ts::isRewriteWorthwhile): a rewrite that barely beats the original after paying for its own notice destabilises bytes that could otherwise be served from the provider's cached prefix for no real gain -- below the floor, ship resultText untouched instead.
        const originalBytes = Buffer.byteLength(resultText, 'utf-8')
        const worthwhile = isRewriteWorthwhile({
          originalBytes,
          rewrittenBytes: Buffer.byteLength(redactedBody, 'utf-8'),
          noticeBytes: Buffer.byteLength(notice, 'utf-8'),
          minNetSavingsBytes: resolveMinNetSavingsBytes(),
        })
        if (worthwhile) {
          // MCP compression shipped for releases without recording anything, so the whole mechanism was invisible in `token-goat stats` even though the `mcp:` prefix was already registered in KIND_TO_SOURCE. Credited through emitRewrite's savings parameter rather than a hand-written recordStat beside the emit, because that parameter measures the emitted string itself -- notice, fence and redaction placeholders included -- which is the only figure that describes what the model was actually spared. A recordStat here would have to re-derive that per branch and would drift the moment either branch changed, which is exactly how the WebFetch over-report happened.
          // Fenced on the same unconditional provenance rule as passOrFence above: a compressed
          // result is still the remote server's text, and a clean scan is not evidence it is safe.
          return emitRewrite(
            `${notice}${fenceWithMatches(redactedBody, injectionMatches, UNTRUSTED_TOOL_TAG)}`,
            'mcp',
            { kind: 'mcp:compress', originalBytes },
          )
        }
      }
    }
  }
  // Reached when compression did not fire or did not pay off. The fence is a security action, not a compression one, so it must not inherit the size floor, the opt-out env var, or the net-benefit gate above -- a short hostile result is exactly the case those would drop.
  return passOrFence()
}

// Both handlers no-op unless the tool name starts with `mcp__` (preMcpHandler via isMcpReadOnly, postMcpHandler via its own startsWith check), so declaring that prefix lets installHooks narrow the settings.json matcher without losing them.
registerHook('pre_tool_use', preMcpHandler, { toolPattern: '^mcp__' })
registerHook('post_tool_use', postMcpHandler, { toolPattern: '^mcp__' })
