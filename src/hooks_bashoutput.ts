/**
 * BashOutput poll-delta caching hook.
 *
 * `BashOutput` polls the accumulated stdout/stderr of a `run_in_background`
 * Bash command by `bash_id`. Each poll typically re-emits the ENTIRE output
 * captured so far, not just what's new since the previous poll -- the caller
 * already saw the earlier prefix on the prior poll, so repeating it is pure
 * waste for a long-running or chatty background command.
 *
 * post_tool_use only: caches the last-seen output per `(sessionId, bash_id)`
 * in the shared bash-output blob store (same disk-backed store
 * `mcp_cache.ts` uses for the same reason -- each hook invocation is a fresh
 * process, so only a cross-process store lets a later poll see what an
 * earlier poll cached). On a repeat poll where the new output is the old
 * output plus a suffix, rewrites the tool result to just that suffix via
 * `rewriteOutput` -- mirroring `hooks_mcp.ts`'s compression rewrite, not
 * `hooks_bash.ts`'s `summarizeOutputDelta` (that one emits an additive
 * line-count *summary* alongside the untouched full text, because a rerun
 * command's earlier output is a distinct, still-relevant prior result; here
 * the accumulated prefix is the SAME text the caller already received, so
 * it is genuinely redundant and safe to replace rather than merely annotate).
 *
 * No pre_tool_use handler: BashOutput's `tool_input` carries only `bash_id`
 * (and an optional output-size-limiting `filter`), nothing worth denying or
 * annotating before the poll runs -- the only useful work happens once the
 * fresh output is known, in the post handler.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, extractToolResultText, emitRewrite } from './hooks_common.js'
import { shortFingerprint } from './fingerprint.js'
import { storeBlob } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR, getBashOutput, type BashOutputEntry } from './bash_output_cache.js'
import { loadConfig } from './config.js'
import { redactSecrets } from './secret_redact.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

/**
 * Deterministic, session-scoped recall id for a BashOutput poll snapshot --
 * mirrors `mcpOutputId` in mcp_cache.ts. Fingerprinting
 * `${sessionId}\x00bashoutput\x00${bashId}` keeps the id within the blob
 * store's id budget and scopes the cache per session, so two sessions
 * polling the same `bash_id` never cross-pollinate.
 */
function pollCacheId(sessionId: string, bashId: string): string {
  return `bgpoll_${shortFingerprint(`${sessionId}\x00bashoutput\x00${bashId}`)}`
}

/** Persist `output` as the last-seen poll snapshot for `(sessionId, bashId)`. */
function storePollSnapshot(sessionId: string, bashId: string, output: string): void {
  const id = pollCacheId(sessionId, bashId)
  const entry: BashOutputEntry = {
    id,
    command: `bashoutput:${bashId}`,
    output,
    exitCode: 0,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(output, 'utf-8'),
  }
  storeBlob(BASH_OUTPUT_SUBDIR, id, entry)
}

/**
 * BashOutput's tool_input `bash_id` field (per Claude Code's documented
 * BashOutput schema -- the only other producer of this key is the Copilot CLI
 * shim, which mirrors read_bash/read_powershell's `shellId` onto it
 * deliberately, so this is still the best-understood wire shape for Claude
 * Code rather than a verified one). Returns undefined for anything
 * missing/non-string/empty.
 */
function getBashId(toolInput: Record<string, unknown>): string | undefined {
  const value = toolInput['bash_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function postBashOutputHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'BashOutput' || !event.sessionId) return passOutput()
    const bashId = getBashId(getToolInput(event))
    if (bashId === undefined) return passOutput()
    const rawOutput = extractToolResultText(event.raw)
    if (!rawOutput) return passOutput()
    // Redact before any comparison/storage, not just at the storeBlob() choke point: storeBlob (disk_cache.ts) already redacts secret-shaped tokens before persisting, so a `prior` value recovered from disk on a later poll (a near-certainty -- hooks run as a fresh process per call, so there is no living in-memory cache to hit instead) is always the REDACTED text. Diffing that against a still-raw `output` desyncs the startsWith()/slice() append-check the instant a secret-shaped token appears anywhere in the accumulated output, permanently falling through to the "buffer reset" branch on every later poll for this bash_id. Redacting here keeps both sides of every comparison on equal footing (mirrors hooks_taskoutput.ts's fix for the same shared bug, and storeBashOutput's own redact-before-compare pattern).
    const output = redactSecrets(rawOutput).text
    if (!output) return passOutput()

    const prior = getBashOutput(pollCacheId(event.sessionId, bashId))
    const minBytes = loadConfig().bash_compress.cache_min_bytes

    if (prior === null) {
      // First poll ever seen for this task this session -- nothing to diff against yet.
      storePollSnapshot(event.sessionId, bashId, output)
      return passOutput()
    }

    if (output === prior.output) {
      // Unchanged since the last poll: the caller gains nothing from seeing the same accumulated text again. Below the size floor there is no meaningful savings from replacing it, so pass through untouched; at or above it, rewrite to a short no-new-output marker instead of repeating the whole blob -- see the module docstring for why replacing (not just annotating) is safe here.
      storePollSnapshot(event.sessionId, bashId, output)
      if (Buffer.byteLength(output, 'utf-8') < minBytes) return passOutput()
      const unchangedNotice = `[token-goat: bash_id ${bashId} unchanged since last poll -- no new output]`
      // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with bash_runner's filter pipeline): cache_min_bytes above only answers "is the input big enough to bother" -- this separately confirms the marker itself doesn't eat the whole saving before shipping the rewrite.
      if (
        !isRewriteWorthwhile({
          originalBytes: Buffer.byteLength(output, 'utf-8'),
          rewrittenBytes: 0,
          noticeBytes: Buffer.byteLength(unchangedNotice, 'utf-8'),
          minNetSavingsBytes: resolveMinNetSavingsBytes(),
        })
      ) {
        return passOutput()
      }
      return emitRewrite(unchangedNotice, 'bashoutput', { kind: 'bashoutput:unchanged', originalBytes: Buffer.byteLength(output, 'utf-8') })
    }

    if (!output.startsWith(prior.output)) {
      // The new output isn't a simple append of the cached snapshot (e.g. the harness rotated or reset the buffer) -- a suffix diff would misrepresent the result, so pass the fresh output through untouched and re-baseline.
      storePollSnapshot(event.sessionId, bashId, output)
      return passOutput()
    }

    const delta = output.slice(prior.output.length)
    storePollSnapshot(event.sessionId, bashId, output)
    if (Buffer.byteLength(delta, 'utf-8') < minBytes) return passOutput()
    const deltaNotice = `[token-goat: bash_id ${bashId} delta since last poll]\n`
    if (
      !isRewriteWorthwhile({
        originalBytes: Buffer.byteLength(output, 'utf-8'),
        rewrittenBytes: Buffer.byteLength(delta, 'utf-8'),
        noticeBytes: Buffer.byteLength(deltaNotice, 'utf-8'),
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return passOutput()
    }
    return emitRewrite(`${deltaNotice}${delta}`, 'bashoutput', { kind: 'bashoutput:delta', originalBytes: Buffer.byteLength(output, 'utf-8') })
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postBashOutputHandler, { toolName: 'BashOutput' })
