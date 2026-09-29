/** Wire-format shaping for the Antigravity CLI (agy 1.2.11). FORMAT-DERIVED from agy's own hooks guide (~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md): PreToolUse reads `decision` (allow/deny/ask/force_ask), `reason`, `permissionOverrides` and `overwrite`, a shallow merge into the tool call's arguments; PostToolUse "expects an empty JSON object". Two points shape everything below. `decision: "allow"` auto-approves the call, skipping the user's own permission prompt, so a hook with nothing to say answers `{}` and never "allow" -- an empty reply was checked against a real agy run on 2026-09-29 and leaves the call on its normal permission path. And agy has no field that adds context to a tool call the way Claude Code's `additionalContext` does: `reason` is the only text channel, documented as "shown to the user/agent", so a context note goes there without a decision. Whether agy delivers a `reason` that carries no decision could not be checked live (the account's quota ran out before a tool call fired), and rtk's integration (rtk-ai/rtk PR #2093) reports that agy ignored `overwrite` in its testing. */
import type { HookEventName, HookOutput } from '../types.js'
import type { HookEvent } from '../hook_registry.js'
import { ANTIGRAVITY_TOOL_NAME_KEY, antigravityNativeToolInput } from '../hooks_cli.js'

/** The Antigravity tool the model called, as stashed by normalizePayload's antigravity branch; undefined for non-tool events. */
export function antigravityToolName(event: HookEvent | undefined): string | undefined {
  const name = event?.raw[ANTIGRAVITY_TOOL_NAME_KEY]
  return typeof name === 'string' ? name : undefined
}

/** Serialize a token-goat hook result into the response agy reads. Only pre_tool_use and post_tool_use are wired for agy (antigravity_install.ts), so every other event answers `{}`. Anything agy has no channel for also becomes `{}`: a base64 image payload, a post-tool context note, or a result rewrite for a payload that carried no `result` to replace. */
export function serializeAntigravityOutput(output: HookOutput, eventName: HookEventName, event?: HookEvent): string {
  if (eventName === 'pre_tool_use') {
    switch (output.hookType) {
      case 'deny':
        return JSON.stringify({ decision: 'deny', reason: output.message })
      case 'context':
        // A shrunk image has no channel here: agy cannot be pointed at a replacement file through `reason`, and the base64 text would only cost tokens.
        if (output.context.includes('data:image/')) return '{}'
        return JSON.stringify({ reason: output.context })
      case 'rewriteInput': {
        const tool = antigravityToolName(event)
        const overwrite = tool === undefined ? output.updatedInput : antigravityNativeToolInput(tool, output.updatedInput)
        // No decision: `overwrite` applies on its own, and "allow" would skip the user's confirmation for the rewritten call.
        return JSON.stringify({ overwrite })
      }
      default:
        return '{}'
    }
  }
  // `overwriteResult` is a field of agy's PostToolHookResult message (read out of the proto descriptor in agy.exe 1.2.11), undocumented in its guide, so it is sent only when the payload carried the `result` string it would replace.
  if (eventName === 'post_tool_use' && output.hookType === 'rewriteOutput' && typeof event?.raw['result'] === 'string') {
    return JSON.stringify({ overwriteResult: output.updatedOutput })
  }
  return '{}'
}
