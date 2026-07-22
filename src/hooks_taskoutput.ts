/**
 * TaskOutput poll-delta caching hook.
 *
 * `TaskOutput` polls the accumulated output of a background agent/task by
 * `task_id`. Like `BashOutput`, each poll re-emits the ENTIRE output
 * captured so far, not just what's new since the previous poll -- the
 * caller already saw the earlier prefix on the prior poll, so repeating it
 * is pure waste for a long-running or chatty task.
 *
 * This is a distinct tool from `BashOutput` (distinct id field: `task_id`
 * vs `bash_id`), so it gets its own hook module per this file family's
 * convention (one module per tool-output-poll pattern -- see
 * hooks_bashoutput.ts's docstring) rather than being folded into
 * hooks_bashoutput.ts. It reuses the exact same poll-delta strategy and the
 * same shared disk-backed blob store (`bash_output_cache.ts` /
 * `disk_cache.ts`) for the same cross-process-persistence reason, but under
 * a different cache-id prefix (`taskpoll_` vs `bgpoll_`) so the two tools'
 * cache entries never collide even if a `bash_id` and `task_id` happened to
 * coincide for different sessions.
 *
 * post_tool_use only: caches the last-seen output per `(sessionId,
 * task_id)`. On a repeat poll where the new output is the old output plus
 * a suffix, rewrites the tool result to just that suffix. Additionally
 * collapses runs of identical consecutive lines within the rewritten (or
 * first-seen) text via `dedupeConsecutive` -- real evidence showed a single
 * repeated warning line appearing 247 times within one poll's payload, a
 * within-payload redundancy this hook is well-positioned to catch since it
 * already reshapes the text.
 *
 * No pre_tool_use handler: TaskOutput's `tool_input` carries only `task_id`
 * (and `block`/`timeout`, irrelevant here), nothing worth denying or
 * annotating before the poll runs -- the only useful work happens once the
 * fresh output is known, in the post handler.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, extractToolResultText } from './hooks_common.js'
import { shortFingerprint } from './fingerprint.js'
import { storeBlob } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR, getBashOutput, type BashOutputEntry } from './bash_output_cache.js'
import { loadConfig } from './config.js'
import { dedupeConsecutive } from './tool_filters/helpers.js'
import { redactSecrets } from './secret_redact.js'

/**
 * Deterministic, session-scoped recall id for a TaskOutput poll snapshot --
 * mirrors `pollCacheId` in hooks_bashoutput.ts. Fingerprinting
 * `${sessionId}\x00taskoutput\x00${taskId}` keeps the id within the blob
 * store's id budget and scopes the cache per session, so two sessions
 * polling the same `task_id` never cross-pollinate. The `taskpoll_` prefix
 * (vs BashOutput's `bgpoll_`) keeps the two tools' cache entries distinct
 * even for an identical id string.
 */
function pollCacheId(sessionId: string, taskId: string): string {
  return `taskpoll_${shortFingerprint(`${sessionId}\x00taskoutput\x00${taskId}`)}`
}

/** Persist `output` as the last-seen poll snapshot for `(sessionId, taskId)`. */
function storePollSnapshot(sessionId: string, taskId: string, output: string): void {
  const id = pollCacheId(sessionId, taskId)
  const entry: BashOutputEntry = {
    id,
    command: `taskoutput:${taskId}`,
    output,
    exitCode: 0,
    storedAt: Date.now(),
    sizeBytes: Buffer.byteLength(output, 'utf-8'),
  }
  storeBlob(BASH_OUTPUT_SUBDIR, id, entry)
}

/**
 * Collapse runs of identical consecutive lines in `text` via the shared
 * `dedupeConsecutive` helper (tool_filters/helpers.ts) -- reused rather than
 * hand-rolled per this repo's DRY convention.
 */
function collapseRepeatedLines(text: string): string {
  return dedupeConsecutive(text.split('\n')).join('\n')
}

/**
 * TaskOutput's tool_input `task_id` field (per Claude Code's documented
 * TaskOutput schema). Returns undefined for anything missing/non-string/empty.
 */
function getTaskId(toolInput: Record<string, unknown>): string | undefined {
  const value = toolInput['task_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function postTaskOutputHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'TaskOutput' || !event.sessionId) return passOutput()
    const taskId = getTaskId(getToolInput(event))
    if (taskId === undefined) return passOutput()
    const rawOutput = extractToolResultText(event.raw)
    if (!rawOutput) return passOutput()
    // Redact before any comparison/storage, not just at the storeBlob() choke point: storeBlob
    // (disk_cache.ts) already redacts secret-shaped tokens before persisting, so a `prior` value
    // recovered from disk on a later poll (a near-certainty -- hooks run as a fresh process per
    // call, so there is no living in-memory cache to hit instead) is always the REDACTED text.
    // Diffing that against a still-raw `output` desyncs the startsWith()/slice() append-check the
    // instant a secret-shaped token appears anywhere in the accumulated output, permanently
    // falling through to the "buffer reset" branch on every later poll for this task. Redacting
    // here keeps both sides of every comparison on equal footing, mirroring the redact-before-
    // compare pattern `storeBashOutput` already applies for the same reason.
    const output = redactSecrets(rawOutput).text
    if (!output) return passOutput()

    const prior = getBashOutput(pollCacheId(event.sessionId, taskId))
    const minBytes = loadConfig().bash_compress.cache_min_bytes

    if (prior === null) {
      // First poll ever seen for this task this session -- nothing to diff against
      // yet, but the payload can still carry within-payload line-repeat storms (a
      // single warning line repeated 247 times has been observed in one poll), so
      // apply the same collapse the delta path applies below. Cache stores the
      // original raw output (not the collapsed copy) since future delta diffs must
      // compare against the real prior output.
      storePollSnapshot(event.sessionId, taskId, output)
      const collapsed = collapseRepeatedLines(output)
      if (collapsed === output) return passOutput()
      const savings = Buffer.byteLength(output, 'utf-8') - Buffer.byteLength(collapsed, 'utf-8')
      if (savings < minBytes) return passOutput()
      return {
        hookType: 'rewriteOutput',
        updatedOutput: collapsed,
      }
    }

    if (output === prior.output) {
      // Unchanged since the last poll -- see hooks_bashoutput.ts's docstring for
      // why replacing (not just annotating) is safe here.
      storePollSnapshot(event.sessionId, taskId, output)
      if (Buffer.byteLength(output, 'utf-8') < minBytes) return passOutput()
      return {
        hookType: 'rewriteOutput',
        updatedOutput: `[token-goat: task_id ${taskId} unchanged since last poll -- no new output]`,
      }
    }

    if (!output.startsWith(prior.output)) {
      // The new output isn't a simple append of the cached snapshot (e.g. the
      // task's buffer rotated or reset) -- a suffix diff would misrepresent the
      // result, so pass the fresh output through untouched and re-baseline.
      storePollSnapshot(event.sessionId, taskId, output)
      return passOutput()
    }

    const delta = output.slice(prior.output.length)
    storePollSnapshot(event.sessionId, taskId, output)
    if (Buffer.byteLength(delta, 'utf-8') < minBytes) return passOutput()
    return {
      hookType: 'rewriteOutput',
      updatedOutput: `[token-goat: task_id ${taskId} delta since last poll]\n${collapseRepeatedLines(delta)}`,
    }
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postTaskOutputHandler, { toolName: 'TaskOutput' })
