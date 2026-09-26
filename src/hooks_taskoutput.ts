/** TaskOutput poll-delta caching hook. `TaskOutput` polls the accumulated output of a background agent/task by `task_id`. Like `BashOutput`, each poll re-emits the ENTIRE output captured so far, not just what's new since the previous poll -- the caller already saw the earlier prefix on the prior poll, so repeating it is pure waste for a long-running or chatty task. This is a distinct tool from `BashOutput` (distinct id field: `task_id` vs `bash_id`), so it gets its own hook module per this file family's convention (one module per tool-output-poll pattern) rather than being folded into hooks_bashoutput.ts, but it runs through the same pipeline, `rewritePoll` in hooks_bashoutput.ts: the same poll-delta strategy and the same shared disk-backed blob store (`bash_output_cache.ts` / `disk_cache.ts`) for the same cross-process-persistence reason, under a different cache-id prefix (`taskpoll_` vs `bgpoll_`) so the two tools' cache entries never collide even if a `bash_id` and `task_id` happened to coincide. post_tool_use only: caches the last-seen output per `(sessionId, task_id)`. On a repeat poll where the new output is the old output plus a suffix, rewrites the tool result to just that suffix. Additionally collapses runs of identical consecutive lines within the rewritten (or first-seen) text via `dedupeConsecutive` -- real evidence showed a single repeated warning line appearing 247 times within one poll's payload, a within-payload redundancy this hook is well-positioned to catch since it already reshapes the text. No pre_tool_use handler: TaskOutput's `tool_input` carries only `task_id` (and `block`/`timeout`, irrelevant here), nothing worth denying or annotating before the poll runs -- the only useful work happens once the fresh output is known, in the post handler. */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, extractToolResultText } from './hooks_common.js'
import { rewritePoll, type PollTool } from './hooks_bashoutput.js'
import { dedupeConsecutive } from './tool_filters/helpers.js'

/** Collapse runs of identical consecutive lines in `text` via the shared `dedupeConsecutive` helper (tool_filters/helpers.ts) -- reused rather than hand-rolled per this repo's DRY convention. */
function collapseRepeatedLines(text: string): string {
  return dedupeConsecutive(text.split('\n')).join('\n')
}

/** TaskOutput's tool_input `task_id` field (per Claude Code's documented TaskOutput schema). Returns undefined for anything missing/non-string/empty. */
function getTaskId(toolInput: Record<string, unknown>): string | undefined {
  const value = toolInput['task_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Pull the polled text out of a real TaskOutput `tool_response`. Claude Code sends `{retrieval_status, task: {task_id, task_type, description, status, output, exitCode?}}` -- the accumulated text lives at `task.output`, nested one level down, and nothing at the top level carries it. The shared {@link extractToolResultText} only looks at top-level `output`/`text`/`body`, so every real poll fell through to its `JSON.stringify` fallback: the delta path could never fire (a growing output is not a prefix of the serialised envelope, whose leading `{"retrieval_status":...` bytes shift) and the line collapse saw one line, because newlines are backslash-escaped inside a JSON string. Falls back to the shared extractor for any other envelope so a harness that does put the text at the top level keeps working. */
function extractTaskOutputText(raw: Record<string, unknown>): string {
  const tr = raw['tool_response']
  if (tr !== null && typeof tr === 'object' && !Array.isArray(tr)) {
    const task = (tr as Record<string, unknown>)['task']
    if (task !== null && typeof task === 'object' && !Array.isArray(task)) {
      const output = (task as Record<string, unknown>)['output']
      // Returned even when empty: an empty task.output means the task has produced nothing yet, which the caller must see as "no output" rather than fall through to a stringified envelope.
      if (typeof output === 'string') return output
    }
  }
  return extractToolResultText(raw)
}

const TASK_OUTPUT_POLL: PollTool = { channel: 'taskoutput', blobPrefix: 'taskpoll', idArg: 'task_id', compactDelta: collapseRepeatedLines, compactFirst: collapseRepeatedLines }

export function postTaskOutputHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'TaskOutput' || !event.sessionId) return passOutput()
    const taskId = getTaskId(getToolInput(event))
    if (taskId === undefined) return passOutput()
    return rewritePoll(TASK_OUTPUT_POLL, event.sessionId, taskId, extractTaskOutputText(event.raw))
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postTaskOutputHandler, { toolName: 'TaskOutput' })
