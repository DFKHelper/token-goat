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

/**
 * Serialize a {@link HookOutput} to the Claude Code hook wire JSON.
 *
 * The harness reads this object from the hook process's stdout and acts on it:
 * - `deny`    → `{"decision":"block","reason":"<message>"}`
 * - `context` → `{"context":"<content>"}`
 * - `update`  → `{"updatedInput":{"content":"<content>"}}`
 * - `pass`    → `{}` (no-op; the call proceeds unchanged)
 *
 * The `switch` is exhaustive over the `hookType` union; adding a variant to
 * {@link HookOutput} without handling it here is a compile error.
 */
export function serializeOutput(output: HookOutput): string {
  switch (output.hookType) {
    case 'deny':
      return JSON.stringify({ decision: 'block', reason: output.message })
    case 'context':
      return JSON.stringify({ context: output.context })
    case 'update':
      return JSON.stringify({ updatedInput: { content: output.content } })
    case 'pass':
      return JSON.stringify({})
  }
}
