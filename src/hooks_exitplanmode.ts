/**
 * ExitPlanMode plan-body deduplication hook.
 *
 * `ExitPlanMode` is a Claude Code plan-mode tool that approves, modifies, or
 * rejects a proposed plan. When approving, its tool_result echoes the ENTIRE
 * plan text back verbatim after a "## Approved Plan:" marker. This creates
 * triplication:
 *
 * 1. The plan body is already in the tool's own `tool_input` (the plan the
 *    user approved).
 * 2. The plan body is echoed in the tool's `tool_result` (below the marker).
 * 3. The plan text is separately persisted to the plans file by Claude Code's
 *    own plan-mode mechanism.
 *
 * This hook detects the "## Approved Plan:" marker and replaces the echoed
 * plan body with a short pointer, keeping only the "User has approved your
 * plan" confirmation line which is the actually load-bearing part.
 *
 * post_tool_use only: inspects the tool result for the marker. If found,
 * rewrites to omit the plan body. If the marker is not found (e.g. plan was
 * rejected, or result has a different shape), passes through untouched to
 * avoid guess-truncating an unfamiliar format.
 *
 * No pre_tool_use handler: ExitPlanMode's `tool_input` is the plan text
 * itself -- nothing worth denying or annotating before the tool runs.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, passOutput, extractToolResultText } from './hooks_common.js'

/**
 * Plan-body omission marker that replaces the echoed plan text after we
 * detect the split point. Tells the user why the plan body was removed.
 */
const PLAN_OMIT_POINTER =
  '[token-goat: plan body omitted -- identical to this call\'s own tool_input, already saved to the plans file]'

/**
 * Split marker that demarcates where the plan body echo starts in the tool
 * result. When found, everything after this marker (the plan body) is
 * replaced with PLAN_OMIT_POINTER.
 */
const APPROVED_PLAN_MARKER = '## Approved Plan:'

export function postExitPlanModeHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'ExitPlanMode') return passOutput()
    const output = extractToolResultText(event.raw)
    if (!output) return passOutput()

    // Look for the marker that indicates plan approval with echo. If not found,
    // the result has a different shape (rejection, modified plan, etc.) so pass
    // it through untouched rather than guess-truncating.
    const markerIndex = output.indexOf(APPROVED_PLAN_MARKER)
    if (markerIndex === -1) return passOutput()

    // Keep everything up to and including the marker, then add the pointer.
    // This preserves the "User has approved your plan" confirmation line.
    const prefix = output.slice(0, markerIndex + APPROVED_PLAN_MARKER.length)
    const rewritten = `${prefix}\n${PLAN_OMIT_POINTER}`

    return {
      hookType: 'rewriteOutput',
      updatedOutput: rewritten,
    }
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postExitPlanModeHandler, { toolName: 'ExitPlanMode' })
