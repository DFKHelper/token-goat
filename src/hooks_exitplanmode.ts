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
 * This hook detects the "## Approved Plan:" marker and, once it has verified
 * the text after the marker actually corresponds to this same call's own
 * `tool_input.plan`, replaces the echoed plan body with a short pointer,
 * keeping only the "User has approved your plan" confirmation line which is
 * the actually load-bearing part.
 *
 * post_tool_use only: inspects the tool result for the marker. If found, AND
 * the post-marker text corresponds to `tool_input.plan`, rewrites to omit the
 * plan body. Otherwise (marker not found -- e.g. plan was rejected, or result
 * has a different shape; or `tool_input.plan` is missing; or the post-marker
 * text doesn't correspond to it -- e.g. the marker string appears inside
 * unrelated content, or Claude Code echoed something other than a verbatim
 * plan copy) passes through untouched. Truncation is applied only once
 * correspondence is positively confirmed, never on marker presence alone.
 *
 * No pre_tool_use handler: ExitPlanMode's `tool_input` is the plan text
 * itself -- nothing worth denying or annotating before the tool runs.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { getToolName, getToolInput, passOutput, extractToolResultText } from './hooks_common.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { redactSecrets } from './secret_redact.js'

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
    // Unlike its siblings, this handler is not closing a demonstrated leak. The half the rewrite
    // KEEPS is the text up to the approval marker -- harness-authored boilerplate -- while the plan
    // body, the one place a credential realistically appears, is exactly what gets dropped. A probe
    // confirms a secret placed before the marker does survive into the emitted text, so the path is
    // reachable, but no realistic route was found for one to land there.
    //
    // It redacts regardless, because after the grep and subagent-report fixes this is the last
    // rewriting handler without the discipline, and a lone exception is what a future reader copies
    // or trusts. Uniformity is the point: "every handler that composes text redacts it" is a rule
    // someone can rely on, whereas "every handler except this one, for reasons documented
    // elsewhere" is how the same defect has now shipped seven times.
    //
    // No `secret_redacted` stat is recorded here, unlike the grep fold. The redaction runs over the
    // whole result, but the rewrite emits only the prefix -- so a secret in the discarded plan body
    // was removed by being dropped, not by being redacted, and counting it would credit this
    // handler for a protection the truncation had already provided. Counting only the survivors
    // would mean re-scanning the emitted slice for placeholders, which is more machinery than a
    // path with no demonstrated occurrence warrants.
    const rawOutput = extractToolResultText(event.raw)
    if (!rawOutput) return passOutput()
    const redacted = redactSecrets(rawOutput)
    const output = redacted.text

    // Look for the marker that indicates plan approval with echo. If not found,
    // the result has a different shape (rejection, modified plan, etc.) so pass
    // it through untouched rather than guess-truncating.
    const markerIndex = output.indexOf(APPROVED_PLAN_MARKER)
    if (markerIndex === -1) return passOutput()

    // The marker is an unanchored substring match, so it can appear inside
    // unrelated content (including this very file's own source, which quotes
    // it as a literal string). Never truncate on marker presence alone --
    // verify the text after the marker actually corresponds to this call's
    // own approved plan (tool_input.plan) before treating it as the echo.
    const planValue = getToolInput(event)['plan']
    if (typeof planValue !== 'string' || planValue.trim() === '') return passOutput()
    const plan = planValue.trim()
    const suffix = output.slice(markerIndex + APPROVED_PLAN_MARKER.length).trim()
    // Anchored at the start, not an unanchored `includes` either way round. The echo begins where
    // the plan begins, so a genuine echo is a prefix of the plan (truncated) or starts with it
    // (trailing extras); a match anywhere else is a coincidence. An unanchored test made a short
    // plan match almost any body -- a one-word plan like "refactor" appearing anywhere in an
    // unrelated approval message was enough -- and the body was then replaced with the omission
    // pointer, losing content the plan had nothing to do with.
    if (!suffix.startsWith(plan) && !plan.startsWith(suffix)) return passOutput()

    // Keep everything up to and including the marker, then add the pointer.
    // This preserves the "User has approved your plan" confirmation line.
    const prefix = output.slice(0, markerIndex + APPROVED_PLAN_MARKER.length)
    const notice = `\n${PLAN_OMIT_POINTER}`

    // Net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile, shared with
    // bash_runner's filter pipeline): for a short approved plan the pointer
    // text can be as large as (or larger than) the echoed body it replaces --
    // in that case shipping `output` untouched beats destabilising the bytes
    // for a rewrite that saves nothing.
    if (
      !isRewriteWorthwhile({
        originalBytes: Buffer.byteLength(output, 'utf-8'),
        rewrittenBytes: Buffer.byteLength(prefix, 'utf-8'),
        noticeBytes: Buffer.byteLength(notice, 'utf-8'),
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return passOutput()
    }

    return {
      hookType: 'rewriteOutput',
      updatedOutput: `${prefix}${notice}`,
    }
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use', postExitPlanModeHandler, { toolName: 'ExitPlanMode' })
