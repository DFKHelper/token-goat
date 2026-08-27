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

import type { HarnessName } from './bridges/types.js'
import { registerReset } from './reset.js'
import { recordUnmappedTool } from './stats.js'
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
  /**
   * Unique per-subagent-invocation id (Claude Code's `agent_id` field), present only
   * when this hook fired inside a subagent call. `undefined` for main-thread events.
   * All subagents spawned by one parent share the parent's `session_id`, so this is
   * the only signal that distinguishes a subagent's own reads/edits from a sibling
   * subagent's or the parent's -- used to salt the persisted session-state key so
   * sibling agents get independent re-read dedup ledgers instead of conflating them.
   */
  readonly agentId: string | undefined
  /**
   * W3C Trace Context traceparent header (e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`),
   * passed by Claude Code / OpenTelemetry-instrumented harnesses to correlate hook execution spans.
   */
  readonly traceparent?: string | undefined
  /**
   * W3C Trace Context tracestate header containing vendor-specific routing / state information.
   */
  readonly tracestate?: string | undefined
  readonly raw: Record<string, unknown>
}

/** A handler reacts to one hook event and returns a {@link HookOutput}. */
export type HookHandler = (event: HookEvent) => HookOutput | Promise<HookOutput>

interface Registration {
  readonly handler: HookHandler
  readonly toolName: string | undefined
  // Matcher fragment for a handler that filters tools itself rather than via
  // `toolName` (MCP dedup, browser image shrink, screenshot redirect all match
  // dynamic `mcp__*` names by regex). Purely declarative: runHook still relies on
  // the handler's own check. It exists so installHooks can narrow the settings.json
  // matcher without a hand-written list going stale -- see toolMatcherFor.
  readonly toolPattern: string | undefined
  // An unfiltered handler that nonetheless accepts whatever matcher its event already
  // needs, instead of forcing the catch-all. Set only where seeing strictly fewer tool
  // calls is a documented, accepted behaviour change for that handler -- it is a
  // deliberate opt-out of the safety rule below, not a default.
  readonly followsMatcher: boolean
  // Advisory handlers are never authoritative for their event: a non-pass result from
  // one is remembered as a fallback but never short-circuits runHook, so later
  // (non-advisory) handlers for the same event still always run. This lets a
  // side-effect-only handler (e.g. one that just writes an index snapshot) keep that
  // guarantee true even if its own logic changes later, without depending on
  // registration/import order across files.
  readonly advisory: boolean
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
 *
 * A handler that does its own tool filtering (a regex over dynamic `mcp__*`
 * names, say) should declare `opts.toolPattern` so {@link toolMatcherFor} can
 * still narrow the installed matcher. `toolPattern` does not affect dispatch —
 * the handler's own check remains authoritative.
 */
export function registerHook(
  eventName: HookEventName,
  handler: HookHandler,
  opts?: { toolName?: string; toolPattern?: string; advisory?: boolean; followsMatcher?: boolean },
): void {
  let list = _handlers.get(eventName)
  if (list === undefined) {
    list = []
    _handlers.set(eventName, list)
  }
  list.push({
    handler,
    toolName: opts?.toolName,
    toolPattern: opts?.toolPattern,
    advisory: opts?.advisory === true,
    followsMatcher: opts?.followsMatcher === true,
  })
}

/**
 * Build the Claude Code `matcher` string listing every tool `eventName` can fire for,
 * or `null` when the event cannot safely be narrowed.
 *
 * Claude Code spawns a fresh process per matcher hit, and ~90% of that cost is Node
 * startup plus bundle evaluation rather than the hook's own work — so a catch-all
 * matcher pays full price for every tool token-goat has no handler for. Deriving the
 * list from the live registry (instead of hardcoding it at the install site) is what
 * keeps it from going stale as handlers are added.
 *
 * Returns `null` — meaning "use the catch-all" — in the two cases where narrowing
 * would be wrong or unsafe:
 *  - the event has no registrations, or none carry a tool filter (non-tool events
 *    like pre_compact, which never receive a tool name at all);
 *  - some registration declares neither `toolName` nor `toolPattern`, i.e. it really
 *    does want every tool. Narrowing then would silently stop firing it. A handler
 *    that has weighed that and accepted it opts out with `followsMatcher: true`.
 *
 * The result is a `|`-joined alternation. Claude Code treats a matcher containing
 * only `[a-zA-Z0-9_-]`, spaces, commas and pipes as a list of exact names, and
 * anything else as an unanchored regex — so a `^mcp__`-style pattern makes the whole
 * matcher regex-evaluated, which is exactly what prefix matching needs.
 */
export function toolMatcherFor(eventName: HookEventName): string | null {
  const list = _handlers.get(eventName)
  if (list === undefined || list.length === 0) return null

  const parts: string[] = []
  for (const { toolName, toolPattern, followsMatcher } of list) {
    // Opted out of widening: contributes no fragment and does not block narrowing.
    if (followsMatcher) continue
    // Neither filter: this handler wants every tool, so no narrowing is safe.
    if (toolName === undefined && toolPattern === undefined) return null
    // Anchor exact names. Claude Code evaluates this matcher as an *unanchored*
    // regex (the `^mcp__` fragment guarantees regex mode), so a bare `Write`
    // alternative would also match `TodoWrite` and spawn a process for a tool with
    // no handler -- the exact waste this narrowing exists to remove. Patterns are
    // used verbatim: they carry their own anchoring.
    for (const part of [toolName === undefined ? undefined : `^${toolName}$`, toolPattern]) {
      if (part !== undefined && part !== '' && !parts.includes(part)) parts.push(part)
    }
  }
  if (parts.length === 0) return null
  return parts.join('|')
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
/**
 * Fold a tool name to the form that survives a bridge's renaming step: lower case, no separators.
 *
 * The class this catches is narrow and deliberate. A bridge that fails to rename an inbound tool
 * passes the harness's own spelling straight through -- Copilot's `bash` instead of `Bash`,
 * `web_fetch` instead of `WebFetch` -- and that is a difference of case and underscores only. A
 * bridge whose mapping is *semantic* (Copilot's `view` -> `Read`) produces a name this cannot
 * relate to anything, and it does not pretend otherwise: such a name is simply recorded as
 * unrecognized, with no near-miss claimed.
 */
function foldToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/**
 * Record that `event.toolName` reached an event whose handlers name the tools they want, and
 * matched none of them.
 *
 * Cheap and side-band: the observation never changes what runs. Skipped entirely when the event
 * has no name-filtered handler at all (a non-tool event, or one whose handlers all take every
 * tool), because there is nothing for a name to be unrecognized *against* there.
 */
function noteUnrecognizedTool(event: HookEvent, list: readonly Registration[]): void {
  const toolName = event.toolName
  if (typeof toolName !== 'string' || toolName === '') return
  const named: string[] = []
  for (const { toolName: want } of list) {
    if (want === undefined) continue
    if (want === toolName) return
    named.push(want)
  }
  if (named.length === 0) return
  const folded = foldToolName(toolName)
  const nearMiss = named.find((n) => foldToolName(n) === folded) ?? null
  recordUnmappedTool(toolName, event.eventName, nearMiss)
}

export async function runHook(event: HookEvent): Promise<HookOutput> {
  const list = _handlers.get(event.eventName)
  if (list === undefined) return { hookType: 'pass' }
  noteUnrecognizedTool(event, list)
  // Advisory handlers never short-circuit: their non-pass results are remembered as a
  // fallback, but the loop always continues so every later, non-advisory handler for
  // this event still runs and can still return its own result. This keeps a
  // side-effect-only handler from ever silently suppressing another handler's output,
  // regardless of registration order.
  let advisoryResult: HookOutput | undefined
  for (const { handler, toolName, advisory } of list) {
    if (toolName !== undefined && toolName !== event.toolName) continue
    let result: HookOutput
    try {
      result = await handler(event)
    } catch {
      // A single extension hook must not suppress the remaining handlers.
      continue
    }
    if (result.hookType !== 'pass') {
      if (advisory) {
        advisoryResult = result
        continue
      }
      return result
    }
  }
  return advisoryResult ?? { hookType: 'pass' }
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
  post_compact: 'PostCompact',
  user_prompt_submit: 'UserPromptSubmit',
  subagent_stop: 'SubagentStop',
  session_start: 'SessionStart',
  // Claude Code has no separate failure event -- a failed tool arrives on PostToolUse there,
  // and only Copilot splits it out. This entry exists because the map is exhaustive over
  // HookEventName, and it is a spelling for the response envelope rather than a claim that
  // Claude Code will ever send this event. Nothing iterates this map to build install config,
  // so naming an event Claude Code does not have cannot register one.
  post_tool_use_failure: 'PostToolUseFailure',
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
 *
 * `post_compact` is deliberately absent from this set AND from
 * {@link EVENTS_WITH_RAW_STDOUT_CONTEXT}, because listing it in either would assert something
 * false. Reading `claude.exe` 2.1.240, the PostCompact runner builds its return value from
 * `userDisplayMessage` alone -- a line echoed to the user's terminal -- and reads neither
 * `additionalContext` nor `systemMessage` nor the raw `output`. There is no context channel on
 * that event at all, which is why {@link postCompactHandler} measures and returns `pass`.
 */
const EVENTS_WITHOUT_ADDITIONAL_CONTEXT: ReadonlySet<HookEventName> = new Set([
  'notification',
  'pre_compact',
])

/**
 * Events whose `context` must be written to stdout as plain text rather than wrapped in wire JSON,
 * because the harness forwards that stdout somewhere an envelope is only noise.
 *
 * `pre_compact` on Claude Code is the whole set, and the reason is a piece of the harness that its
 * hook documentation does not describe. Reading `claude.exe` 2.1.240: a command hook that exits 0
 * has its result's `output` field set to `R.stdout` verbatim -- the JSON is parsed alongside it into
 * a separate value, and `systemMessage` is lifted onto its own separate field, but `output` itself
 * is the raw text either way. The PreCompact runner then joins every succeeded hook's `output` into
 * `newCustomInstructions`, and the four compaction call sites pass that straight to the summarising
 * model as `customInstructions`. Nothing in that chain ever reads `systemMessage`.
 *
 * So on this event the bytes we print are not an envelope the harness unpacks; they are a message to
 * a model. Emitting `{"systemMessage":"..."}` sent it the serialized object -- braces, escaped
 * newlines and all -- while the field we meant it to read was dropped. Verified live as well as by
 * reading the binary: a PreCompact hook printing an instruction had that instruction obeyed in the
 * resulting compact summary.
 *
 * Scoped to Claude Code deliberately. This behaviour is undocumented and may not survive an update,
 * and no other harness wants raw text here: Copilot CLI's reference marks `preCompact` output
 * "notification only" and its shim discards the response, while the Codex shim `JSON.parse`s our
 * stdout and degrades to `{}` on anything else. Both are unharmed by the JSON form, so they keep it.
 */
const EVENTS_WITH_RAW_STDOUT_CONTEXT: ReadonlySet<HookEventName> = new Set(['pre_compact'])

/**
 * Serialize a {@link HookOutput} to the Claude Code hook wire JSON.
 *
 * `harness` is a required argument rather than a call to `detectHarness()` here, because by the time
 * this runs the relay has already seeded `CLAUDE_CODE_SESSION_ID` from the event payload for *every*
 * harness -- a detection at this point would answer "claudecode" on Codex and Copilot alike. The
 * relay reads the harness before that seeding and passes it down. Required and not optional so a
 * future caller has to make the same decision consciously.
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
 * - `rewriteOutput` → `{"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *   "updatedToolOutput":"<content>"}}` — the `PostToolUse` shape that replaces
 *   the tool result text the model receives; the tool has already run, so this
 *   cannot undo the call, only change what the model sees of it.
 * - `pass`    → `{}` (no-op; the call proceeds unchanged)
 *
 * The `switch` is exhaustive over the `hookType` union; adding a variant to
 * {@link HookOutput} without handling it here is a compile error.
 */
export function serializeOutput(output: HookOutput, eventName: HookEventName, harness: HarnessName): string {
  switch (output.hookType) {
    case 'deny':
      return JSON.stringify({ decision: 'block', reason: output.message })
    case 'context':
      if (EVENTS_WITH_RAW_STDOUT_CONTEXT.has(eventName) && harness === 'claudecode') {
        return output.context
      }
      if (EVENTS_WITHOUT_ADDITIONAL_CONTEXT.has(eventName)) {
        return JSON.stringify({ systemMessage: output.context })
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: CLAUDE_CODE_EVENT_NAMES[eventName],
          additionalContext: output.context,
        },
      })
    case 'rewriteInput':
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: output.updatedInput,
        },
      })
    case 'rewriteOutput':
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: output.updatedOutput,
        },
      })
    case 'pass':
      return JSON.stringify({})
  }
}
