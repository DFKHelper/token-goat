/**
 * Hook handler registry.
 *
 * Layers 5+ register handler functions for the hook events token-goat reacts
 * to (pre_tool_use, post_tool_use, notification, stop, pre_compact). When a
 * hook fires, {@link runHook} runs the registered handlers in registration
 * order and short-circuits on the first non-`pass` result.
 *
 * This is distinct from the Python `hook_registry.py`, which is a static
 * lookup table of wire-format metadata (event name → module/attr/matcher).
 * That metadata role is filled here by `types.ts` (HookEventName) and the
 * bridges; this module owns the *runtime dispatch* side that Python spreads
 * across `hooks_cli.py`'s dispatcher.
 *
 * Output serialization lives here too: {@link serializeOutput} converts a
 * {@link HookOutput} into the exact Claude Code wire JSON that the harness
 * reads from the hook process's stdout.
 */

import { registerReset } from './reset.js'
import type { HookEventName, HookOutput } from './types.js'

/**
 * The event object passed to every {@link HookHandler}.
 *
 * `toolInput` and `raw` are kept as `Record<string, unknown>` rather than a
 * narrower TypedDict-style shape so handlers can read harness-specific keys
 * the registry doesn't model. `toolName` is `undefined` for non-tool events
 * (notification, stop, pre_compact).
 */
export interface HookEvent {
  readonly eventName: HookEventName
  readonly toolName: string | undefined
  readonly toolInput: Record<string, unknown>
  readonly sessionId: string
  readonly raw: Record<string, unknown>
}

/** A handler reacts to one hook event and returns a {@link HookOutput}. */
export type HookHandler = (event: HookEvent) => HookOutput | Promise<HookOutput>

interface Registration {
  readonly handler: HookHandler
  readonly toolName: string | undefined
}

/**
 * Registered handlers keyed by event name.
 *
 * A `Map` of arrays preserves registration order (the order handlers run in)
 * and keeps per-event lookup O(1). Module-global mutable state, so it is reset
 * via {@link registerReset} below.
 */
const _handlers = new Map<HookEventName, Registration[]>()

/**
 * Register `handler` for `eventName`.
 *
 * When `opts.toolName` is set, the handler only fires for hook events whose
 * `toolName` matches exactly (case-sensitive — names are normalized to
 * canonical PascalCase upstream by the bridge layer). Handlers without a
 * `toolName` filter fire for every event of that name.
 */
export function registerHook(
  eventName: HookEventName,
  handler: HookHandler,
  opts?: { toolName?: string },
): void {
  let list = _handlers.get(eventName)
  if (list === undefined) {
    list = []
    _handlers.set(eventName, list)
  }
  list.push({ handler, toolName: opts?.toolName })
}

/**
 * Run every registered handler for `event.eventName` in registration order.
 *
 * Short-circuits and returns the first `deny`/`context`/`update` result; once
 * a handler claims the event, later handlers do not run (they cannot see or
 * override a decision already made). Returns `{ hookType: 'pass' }` when no
 * handler is registered or every handler passes.
 *
 * A handler whose `toolName` filter does not match `event.toolName` is skipped
 * without being called.
 */
export async function runHook(event: HookEvent): Promise<HookOutput> {
  const list = _handlers.get(event.eventName)
  if (list === undefined) return { hookType: 'pass' }
  for (const { handler, toolName } of list) {
    if (toolName !== undefined && toolName !== event.toolName) continue
    const result = await handler(event)
    if (result.hookType !== 'pass') return result
  }
  return { hookType: 'pass' }
}

/** Drop every registered handler. Internal — invoked by {@link registerReset}. */
function clearHooks(): void {
  _handlers.clear()
}

registerReset(clearHooks)

/** Claude Code's PascalCase spelling for each internal {@link HookEventName}. */
const CLAUDE_CODE_EVENT_NAMES: Record<HookEventName, string> = {
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  notification: 'Notification',
  stop: 'Stop',
  pre_compact: 'PreCompact',
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  subagent_stop: 'SubagentStop',
}

/**
 * Events whose `hookSpecificOutput` does NOT accept `additionalContext`, per
 * https://code.claude.com/docs/en/hooks (verified 2026-07-02). Every other
 * {@link HookEventName} does accept it there. Events listed here must instead
 * inject context via the top-level `systemMessage` field — see {@link serializeOutput}.
 *
 * Kept as an explicit table rather than a single hardcoded event check so a
 * new handler on one of these events cannot silently reproduce the pre_compact
 * wire-format bug (2026-07-02) by inheriting the wrong default.
 */
const EVENTS_WITHOUT_ADDITIONAL_CONTEXT: ReadonlySet<HookEventName> = new Set([
  'notification',
  'pre_compact',
])

/**
 * Serialize a {@link HookOutput} to the Claude Code hook wire JSON.
 *
 * The harness reads this object from the hook process's stdout and acts on it:
 * - `deny`    → `{"decision":"block","reason":"<message>"}`
 * - `context` → `{"hookSpecificOutput":{"hookEventName":"<event>",
 *   "additionalContext":"<content>"}}` — the documented non-blocking hint
 *   shape (see https://code.claude.com/docs/en/hooks); `hookEventName` must
 *   match the event currently running, not be hardcoded. Events in
 *   {@link EVENTS_WITHOUT_ADDITIONAL_CONTEXT} (currently `notification` and
 *   `pre_compact`) instead emit the top-level `{"systemMessage":"<content>"}`
 *   field, since the harness rejects `additionalContext` there outright.
 * - `update`  → `{"updatedInput":{"content":"<content>"}}`
 * - `rewriteInput` → `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *   "permissionDecision":"allow","updatedInput":<obj>}}` — the `PreToolUse`
 *   shape that replaces the whole tool input and lets the call proceed.
 * - `pass`    → `{}` (no-op; the call proceeds unchanged)
 *
 * The `switch` is exhaustive over the `hookType` union; adding a variant to
 * {@link HookOutput} without handling it here is a compile error.
 */
export function serializeOutput(output: HookOutput, eventName: HookEventName): string {
  switch (output.hookType) {
    case 'deny':
      return JSON.stringify({ decision: 'block', reason: output.message })
    case 'context':
      if (EVENTS_WITHOUT_ADDITIONAL_CONTEXT.has(eventName)) {
        return JSON.stringify({ systemMessage: output.context })
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: CLAUDE_CODE_EVENT_NAMES[eventName],
          additionalContext: output.context,
        },
      })
    case 'update':
      return JSON.stringify({ updatedInput: { content: output.content } })
    case 'rewriteInput':
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: output.updatedInput,
        },
      })
    case 'pass':
      return JSON.stringify({})
  }
}
