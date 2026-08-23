/**
 * Bridge hook-event parity matrix.
 *
 * `token-goat bridges-status` is read-only introspection: it never invokes a
 * real external harness binary. The matrix below is a hand-maintained,
 * hardcoded snapshot of what each bridge module in `src/bridges/` actually
 * wires, verified by reading each bridge's install writer and hook shim
 * directly (not guessed) -- see each row's `sourceFile` and, for a gap, its
 * `reasons` entry, which quotes or paraphrases the bridge module's own
 * documented explanation where one exists.
 *
 * Columns are `HOOK_EVENTS` (`src/types.ts`) -- the closed set of internal
 * hook event names every bridge shim validates against and every bridge
 * install writer maps its harness-native event names onto. This is the one
 * concrete, verifiable "shared interface" surface `types.ts`'s thin
 * `BridgeConfig` (harness / hookScriptPath / hookSpecificOutput) doesn't
 * itself enumerate.
 *
 * `hermes` and `generic` are deliberately excluded: `hermes` has no
 * install-writer at all (see `bridges/types.ts`'s `HarnessName` docstring --
 * it's a real detectable identity, but not a bridge module with anything to
 * introspect), and `generic` is the no-signal-matched fallback, not a harness.
 *
 * This file must be kept in sync by hand when a bridge's wiring changes --
 * there is deliberately no dynamic source-parsing here (that would be fragile
 * against comment drift and wouldn't work against the built bundle, where
 * bridge source comments don't exist). `tests/bridges_status.test.ts` guards
 * against silent drift two ways: for `codex` and `grok` (the two bridges with
 * a self-contained, easily isolated install writer) it actually runs the real
 * installer against a temp `$HOME` and diffs the resulting config's wired
 * events against this file's `implemented` set; for the rest it greps each
 * bridge's own source file for the exact phrase this file's `reasons` entry
 * is paraphrasing, so a docstring rewrite that changes the documented
 * capability set fails the test instead of leaving this file stale.
 */

import { HOOK_EVENTS, type HookEventName } from './types.js'
import type { HarnessName } from './bridges/types.js'

export { HOOK_EVENTS }

/** One row of the parity matrix: one bridge, which of `HOOK_EVENTS` it wires, and why the rest are missing. */
export interface BridgeCapabilityRow {
  readonly harness: HarnessName
  /** Display label used in text output. */
  readonly label: string
  /** File(s) this row's data was verified against. */
  readonly sourceFile: string
  /** Subset of `HOOK_EVENTS` this bridge actually wires to a real hook entry. */
  readonly implemented: ReadonlySet<HookEventName>
  /** Short, documented reason for one or more *not*-implemented events -- omitted when no in-code explanation exists. */
  readonly reasons: ReadonlyArray<{ readonly events: readonly HookEventName[]; readonly reason: string }>
}

/**
 * `notification` and `stop` have zero `registerHook('notification', ...)` /
 * `registerHook('stop', ...)` call sites anywhere in `src/` (confirmed via a
 * full-repo grep of `registerHook(` -- every real handler registers against
 * `pre_tool_use`, `post_tool_use`, `pre_compact`, `user_prompt_submit`, or
 * `subagent_stop`). No bridge wiring either event would currently do
 * anything: token-goat's own relay has no server-side handler to dispatch to.
 * Shared reason text for the several rows below that cite it.
 */
const NO_SERVER_HANDLER_REASON =
  "token-goat has no registered server-side handler for this event (zero registerHook('notification'|'stop', ...) call sites in src/) -- wiring it client-side would currently be a no-op"

/**
 * `post_compact` is Claude Code's own event, confirmed by reading the installed binary: its hook
 * input schema declares `hook_event_name: "PostCompact"` with a `compact_summary` string, and the
 * runner hands a hook the finished summary verbatim. No other harness here has been shown to have
 * an equivalent. Several have something adjacent -- pi emits `session_compact` and opencode
 * `experimental.session.compacting` -- but neither bridge forwards a summary, and the Claude Code
 * forks (grok, qwen, kimi) have not been re-checked against their own hooks docs. Left unwired
 * rather than guessed at, the same standard every other row's gaps are held to.
 */
const NO_POST_COMPACT_EVENT_REASON =
  "post_compact is a Claude Code event (hook_event_name PostCompact, carrying compact_summary); no equivalent has been confirmed for this harness, so it is left unwired rather than guessed at"

/**
 * Only Copilot CLI is known to route a failed tool result to its own event. Every other harness
 * here either delivers failures on its ordinary post-tool event or is not known to distinguish
 * them at all, and this deliberately asserts the second thing about token-goat rather than the
 * first thing about the harness: what is being stated is that no separate failure event is wired,
 * not that the harness lacks one. Establishing the latter would need the same bundle-level read
 * that was done for Copilot, and it has not been done for these.
 */
const NO_SEPARATE_FAILURE_EVENT_REASON =
  'post_tool_use_failure exists because Copilot CLI routes a failed tool result to a separate postToolUseFailure event instead of postToolUse. No separate failure event is wired for this harness, so a failed tool call either arrives on post_tool_use like any other result or is not seen; which of the two has not been checked here'


/**
 * Copilot CLI is the one harness where this has actually been checked rather than left open, so it
 * gets its own reason. Read from the installed Copilot CLI 1.0.79 (`app.js` and
 * `schemas/api.schema.json`): the `HookType` enum lists `preCompact` and has no `postCompact`
 * member at all, and both `preCompact` call sites are a bare
 * `await this.nativeHookProcessor?.event("preCompact", ...)` whose return value is never assigned
 * -- so unlike `notification`, which reads `.additionalContext` off the same runner, nothing there
 * consumes a pre-compaction hook's output either. That is also why copilot keeps the JSON wrapper
 * on `pre_compact` (see EVENTS_WITH_RAW_STDOUT_CONTEXT in src/hook_registry.ts): there is nothing
 * on the other end to read bare text.
 */
const COPILOT_NO_POST_COMPACT_REASON =
  "Copilot CLI has no post-compaction hook: its HookType enum (schemas/api.schema.json, 1.0.79 and 1.0.80) declares preCompact and no postCompact, and both preCompact call sites in app.js await the hook and never assign its result. Whether the summary is reachable another way is open. app.js does emit session.compaction_complete carrying summaryContent, and the session event writer subscribes to '*' -- but emit() vs emitEphemeral() does NOT gate that writer: dispatchEventHandlers runs outside the ephemeral branch in emitInternal, on('*') early-returns past every filter, and the writer's callback applies no filter of its own before handing the JSON to native recordEventJson. The durable-vs-ephemeral decision is in Rust (api_session_event_writer.rs) and was not readable. Nor is the event uniformly summary-bearing: two of the four emit sites are the branches taken when no summary exists, summaryContent is optional in the schema, and the relay session class emits the same event via emitEphemeral. No compaction has ever been observed on the machines checked, so nothing empirical anchors any of it. Context can be written back on the next turn through userPromptSubmitted additionalContext"

export const BRIDGE_CAPABILITY_MATRIX: readonly BridgeCapabilityRow[] = [
  {
    harness: 'claudecode',
    label: 'Claude Code',
    sourceFile: 'src/install.ts (HOOK_EVENT_MAP)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'post_compact', 'user_prompt_submit', 'subagent_stop', 'session_start']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON },
    ],
  },
  {
    harness: 'codex',
    label: 'Codex CLI',
    sourceFile: 'src/bridges/codex_install.ts (CODEX_HOOK_EVENTS, CODEX_GLOBAL_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      { events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON },
      {
        events: ['session_start'],
        reason:
          "Codex CLI's hook config schema (CODEX_EVENT_ARG) has no session-start-equivalent event to map onto token-goat's session_start -- unlike Claude Code's real SessionStart hook",
      },
    ],
  },
  {
    harness: 'grok',
    label: 'Grok CLI',
    sourceFile: 'src/bridges/grok_install.ts (GROK_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      { events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON },
      {
        events: ['session_start'],
        reason:
          "GROK_HOOK_EVENTS (this row's explicit `install --grok` writer) mirrors install.ts's HOOK_EVENT_MAP as of the doc verification date -- Grok's real hooks doc has not been re-checked for SessionStart support since, so it is left unwired rather than guessed at (Grok's *default*, non---grok path still rides Claude Code's own settings.json directly and does receive session_start there, same as claudecode)",
      },
    ],
  },
  /**
   * What Copilot CLI's wired events can actually carry, read from the shipping 1.0.80 bundle
   * rather than from its hooks reference page. A row's `implemented` set says an event is wired;
   * it deliberately says nothing about how much of that event's response the harness honors, and
   * for Copilot the difference matters:
   *
   * - `pre_tool_use` deny is real, and the reason text reaches the model. The native string table
   *   (runtime.node offset 98057208) carries `permissionDecision`, `permissionDecisionReason`, the
   *   default "No reason provided." and the formatter "Denied by preToolUse hook: " as distinct
   *   literals, and app.js sets `{textResultForLlm: reason, resultType: "denied"}` per denial and
   *   filters that call out of execution. This was previously only an inference drawn from an
   *   incident comment; it is now confirmed. The fail-closed "(hook errored)" deny-all strings sit
   *   beside these, so that incident was behavior layered on top of a working deny handler, not a
   *   substitute for one.
   * - `post_tool_use` honors `modifiedResult`, so compression, injection fencing and image shrink
   *   do reach the model: `postToolExecution` (app.js offset 2043150) assigns the returned
   *   `toolResultJson` onto the tool result in place.
   * - `post_tool_use` drops `additionalContext` on the JS path -- no supplier for the
   *   `onAdditionalContext` callback anywhere in the bundle, and no `additional_contexts` key in
   *   that event's native return payload, unlike its pre-tool sibling. Whether native folds it
   *   into the returned result instead was not verified.
   * - Failed tool calls never reach `post_tool_use` at all. Copilot routes them to a separate
   *   `postToolUseFailure` event, which is handed only a stringified error and honors only
   *   `additionalContext`; `modifiedResult` is documented as not honored there. So on Copilot the
   *   output of a failed tool call reaches the model unfenced, uncompressed and unshrunk, and no
   *   response shape token-goat's shim can emit changes that. Known gap, deliberately recorded.
   *   What `additionalContext` does on that event is no longer doc-derived: app.js offset 2043380
   *   reads the native processor's return and, when it carries `additionalContext`, either folds
   *   it into `textResultForLlm` (if `appendFailureContextToToolResult` is set) or formats it and
   *   pushes `{content, source: "system"}` onto `toolResult.newMessages`. So the channel is real
   *   and model-visible -- it just carries advice alongside the failure, never a replacement for
   *   it. It is wired now, as its own `post_tool_use_failure` event rather than a reuse of
   *   `post_tool_use`: routing failures through the success event would let success-path handlers
   *   mark a file as successfully read when the read failed. Because the channel spends tokens
   *   instead of saving them, its handler (`src/hooks_tool_failure.ts`) stays silent on a first
   *   failure and speaks only on an exact repeat.
   * - `pre_compact` is wired and fires, but nothing it returns can reach the model. Both dispatch
   *   sites call it in statement position and drop the result: app.js offset 2467452 (the manual
   *   `/compact` path) and offset 2571216 (`case "execute_pre_compact_hook"`). The contrast is
   *   what makes this conclusive rather than an absence of evidence -- the same `event()` runner's
   *   return IS read for other events, e.g. `notification` at offset 2296123 assigns it and
   *   forwards `additionalContext` as a prepended system prompt. The compaction prompt is then
   *   built from session history and the user's own focus text, with no hook channel into it.
   *   So token-goat's `pre_compact` registration here is observe-only by construction, not merely
   *   unused: a future attempt to inject a session manifest through it would silently do nothing.
   *   Not verified: whether the native declarative runner applies `additionalContext` itself. The
   *   trail ends in stripped Rust. That it would make the explicit JS handling for `notification`
   *   and `userPromptSubmitted` redundant is an argument, not a proof.
   */
  {
    harness: 'copilot_cli',
    label: 'Copilot CLI',
    sourceFile: 'src/bridges/copilot_cli_install.ts (COPILOT_CLI_HOOK_EVENTS), src/bridges/copilot_cli.ts (COPILOT_TO_TG_EVENT)',
    implemented: new Set([
      'session_start',
      'pre_tool_use',
      'post_tool_use',
      'pre_compact',
      'stop',
      'subagent_stop',
      'user_prompt_submit',
      'post_tool_use_failure',
    ]),
    reasons: [
      { events: ['post_compact'], reason: COPILOT_NO_POST_COMPACT_REASON },
      {
        events: ['notification'],
        reason:
          "Copilot CLI has a real 'notification' hook event, but copilot_cli.ts's COPILOT_TO_TG_EVENT deliberately leaves it (and sessionEnd/subagentStart/errorOccurred/permissionRequest) unimplemented rather than guessed at",
      },
    ],
  },
  {
    harness: 'gemini',
    label: 'Gemini CLI',
    sourceFile: 'src/bridges/gemini_install.ts (GEMINI_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      {
        events: ['notification', 'stop', 'user_prompt_submit', 'subagent_stop', 'session_start'],
        reason: "Gemini CLI's hooks integration only wires BeforeTool/AfterTool/PreCompress (README \"Gemini CLI users\")",
      },
    ],
  },
  {
    harness: 'qwen',
    label: 'Qwen Code',
    sourceFile: 'src/bridges/qwen_install.ts (QWEN_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      {
        events: ['notification'],
        reason:
          "Only five Qwen Code events have a token-goat handler; every other real event (Notification, SessionEnd, PostToolUseFailure, StopFailure, SubagentStart, PermissionRequest, TodoCreated, TodoCompleted) is left unimplemented rather than guessed at (qwen_install.ts)",
      },
      { events: ['stop'], reason: NO_SERVER_HANDLER_REASON },
      {
        events: ['session_start'],
        reason: 'QWEN_EVENT_ARG has no session-start mapping wired yet -- left unimplemented rather than guessed at',
      },
    ],
  },
  {
    harness: 'kimi',
    label: 'Kimi Code CLI',
    sourceFile: 'src/bridges/kimi_install.ts (KIMI_EVENT_ARG), src/bridges/kimi.ts (KIMI_HOOK_SCRIPT)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop', 'session_start']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },{ events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON }],
  },
  {
    harness: 'opencode',
    label: 'opencode',
    sourceFile: 'src/bridges/opencode.ts',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      {
        events: ['notification', 'stop', 'user_prompt_submit', 'subagent_stop', 'session_start'],
        reason:
          "opencode's plugin API only exposes three relevant hooks -- tool.execute.before, tool.execute.after, experimental.session.compacting (opencode.ts module docstring, verified against opencode's real source)",
      },
    ],
  },
  {
    harness: 'openclaw',
    label: 'OpenClaw',
    sourceFile: 'src/bridges/openclaw.ts',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      {
        events: ['notification', 'stop', 'user_prompt_submit', 'subagent_stop', 'session_start'],
        reason:
          "OpenClaw's in-process plugin API only exposes before_tool_call/after_tool_call/before_compaction as api.on() handlers relevant here",
      },
    ],
  },
  {
    harness: 'pi',
    label: 'pi (pi-coding-agent)',
    sourceFile: 'src/bridges/pi.ts',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
      { events: ['post_tool_use_failure'], reason: NO_SEPARATE_FAILURE_EVENT_REASON },
      { events: ['post_compact'], reason: NO_POST_COMPACT_EVENT_REASON },
      {
        events: ['notification', 'stop', 'user_prompt_submit', 'subagent_stop', 'session_start'],
        reason:
          "pi's extension API subscribes to session_start/tool_call/tool_result/session_before_compact/session_compact, of which only tool_call/tool_result/session_before_compact map onto real HOOK_EVENTS names (pre_tool_use/post_tool_use/pre_compact) -- pi's own session_start event is never forwarded to token-goat's callHook()",
      },
    ],
  },
]

/** JSON-serializable shape of one matrix row, used by `--json` output. */
export interface BridgeCapabilityRowJson {
  readonly harness: HarnessName
  readonly label: string
  readonly sourceFile: string
  readonly events: Readonly<Record<HookEventName, boolean>>
  readonly reasons: Readonly<Record<string, string>>
}

/** Convert the static matrix into a plain-object shape safe for `JSON.stringify`. */
export function bridgesStatusToJson(matrix: readonly BridgeCapabilityRow[] = BRIDGE_CAPABILITY_MATRIX): BridgeCapabilityRowJson[] {
  return matrix.map((row) => {
    const events = {} as Record<HookEventName, boolean>
    for (const event of HOOK_EVENTS) {
      events[event] = row.implemented.has(event)
    }
    const reasons: Record<string, string> = {}
    for (const { events: missingEvents, reason } of row.reasons) {
      for (const event of missingEvents) {
        reasons[event] = reason
      }
    }
    return { harness: row.harness, label: row.label, sourceFile: row.sourceFile, events, reasons }
  })
}

/** Render the matrix as a fixed-width text table (one row per bridge, one column per `HOOK_EVENTS` entry), followed by a documented-gap legend. */
export function formatBridgesStatus(matrix: readonly BridgeCapabilityRow[] = BRIDGE_CAPABILITY_MATRIX): string {
  const lines: string[] = []
  lines.push('# Bridge hook-event parity matrix')
  lines.push('')
  lines.push('Columns: ' + HOOK_EVENTS.join(', ') + ' (source: HOOK_EVENTS in src/types.ts)')
  lines.push('Read-only static analysis of src/bridges/*_install.ts and *.ts -- never invokes a real harness binary.')
  lines.push('')

  const harnessWidth = Math.max(...matrix.map((r) => r.harness.length), 'harness'.length)
  const header = ['harness'.padEnd(harnessWidth), ...HOOK_EVENTS.map((e) => e), 'score'].join('  ')
  lines.push(header)

  for (const row of matrix) {
    const cells = HOOK_EVENTS.map((event) => {
      const cell = row.implemented.has(event) ? 'yes' : 'no'
      return cell.padEnd(event.length)
    })
    const score = `${row.implemented.size}/${HOOK_EVENTS.length}`
    lines.push([row.harness.padEnd(harnessWidth), ...cells, score].join('  '))
  }

  const gapRows = matrix.filter((r) => r.reasons.length > 0)
  if (gapRows.length > 0) {
    lines.push('')
    lines.push('## Documented gaps')
    for (const row of gapRows) {
      for (const { events, reason } of row.reasons) {
        lines.push(`- ${row.harness}: ${events.join(', ')} -- ${reason}`)
      }
    }
  }

  return lines.join('\n')
}
