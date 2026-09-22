/**
 * Which harnesses discard which hook event's response.
 *
 * One table, because the question is the same shape at every event -- "does what this hook returns
 * reach the model on this harness" -- and the answer decides between returning the text and queuing
 * it for a later channel. Two copies of that decision, one per event, is how one of them goes stale
 * without anything failing: a hook keeps returning text, the harness keeps throwing it away, and
 * every surface reports a hint emitted.
 *
 * Membership is evidence-backed in both directions and neither direction is safe by default. Adding
 * a harness silently reroutes its output through {@link module:pending_context}; removing one
 * silently discards it. Neither move rests on documentation alone -- see BRIDGES_STATUS in
 * src/bridges_status.ts for the harness-level record of what each event can actually carry.
 */

import { getHarnessName } from './bridges/registry.js'

/**
 * Harnesses that run the prompt-submit hook but drop whatever it returns.
 *
 * Empty today, and that is a finding rather than an oversight. Copilot CLI was the only member,
 * on the strength of its own hooks reference saying command-hook output "is dropped"
 * (https://docs.github.com/en/copilot/reference/hooks-reference). That documentation is wrong for
 * `additionalContext`, at least as of 1.0.80: a project-scope config-file command hook (under
 * `<cwd>/.github/hooks/`) returned `{"additionalContext":"<marker>"}` and the marker appeared
 * verbatim in the session's `user.message.transformedContent`, wrapped in `<system_reminder>`.
 * That it reached the model rather than only the on-disk record is settled by the provider's own
 * returned usage: ~140 input tokens billed for a turn whose raw `content` is 35 bytes. Scope: this
 * was demonstrated once, on one of two turns, and the delivery rate is unknown -- see the longer
 * account in `src/bridges/copilot_cli.ts`. The doc's claim about `modifiedPrompt` was not retested
 * and is assumed to still hold; token-goat does not want that field regardless.
 *
 * The set and the reroute below are kept rather than deleted because they are the fallback if a
 * future Copilot release makes the documentation true again. Re-adding a harness name here used to
 * be described as the whole fix, with no other code change, and for Copilot that was once false:
 * a hint queued by this reroute drains through `post_tool_use`, and Copilot's `postToolUse` never
 * forwards `additionalContext` to the model on the JS path (no supplier for `onAdditionalContext`,
 * no `additional_contexts` key in that event's native return payload). The `postToolUse` branch in
 * `src/bridges/copilot_cli.ts` now folds the drained text into `modifiedResult.textResultForLlm`
 * instead, which that same bundle applies in place, so the drain side is no longer the weak link.
 * Membership stays evidence-backed in both directions --
 * adding a harness silently reroutes its hints and removing one silently discards them, so
 * neither move should ever rest on documentation alone. See BRIDGES_STATUS for the harness-level
 * record of what each event can actually carry.
 */
export const PROMPT_SUBMIT_CONTEXT_DROPPED = new Set<string>([])

export function dropsPromptSubmitContext(): boolean {
  return PROMPT_SUBMIT_CONTEXT_DROPPED.has(getHarnessName())
}

/**
 * Harnesses that fire the pre-compact hook but discard whatever it returns.
 *
 * Copilot CLI is the member, and unlike the prompt-submit set above this one is not a documentation
 * claim. Its own `schemas/api.schema.json` (1.0.79 and 1.0.80) declares `preCompact` in the
 * `HookType` enum and has no `postCompact` member at all, and both `preCompact` call sites in app.js
 * are a bare `await this.nativeHookProcessor?.event("preCompact", ...)` whose return value is never
 * assigned to anything. The event fires; the response goes nowhere.
 *
 * That makes it a usable trigger and an unusable channel, which is exactly the shape
 * {@link module:pending_context} exists for: build the manifest when the harness tells us a
 * compaction is starting, queue it, and let the next tool call carry it on a channel that is read.
 * The manifest lands after the compaction rather than before it, so it functions as recovery rather
 * than as instructions to the summarizer -- a strictly weaker delivery than Claude Code's, and the
 * best this harness allows.
 *
 * Claude Code is deliberately absent: its PreCompact runner joins every succeeded hook's raw stdout
 * into `newCustomInstructions` and hands that to the summarizing model, which is the strongest
 * channel any harness offers here. See EVENTS_WITH_RAW_STDOUT_CONTEXT in src/hook_registry.ts.
 */
export const PRE_COMPACT_CONTEXT_DROPPED = new Set<string>(['copilot_cli'])

export function dropsPreCompactContext(): boolean {
  return PRE_COMPACT_CONTEXT_DROPPED.has(getHarnessName())
}
