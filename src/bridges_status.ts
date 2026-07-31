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

export const BRIDGE_CAPABILITY_MATRIX: readonly BridgeCapabilityRow[] = [
  {
    harness: 'claudecode',
    label: 'Claude Code',
    sourceFile: 'src/install.ts (HOOK_EVENT_MAP)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop', 'session_start']),
    reasons: [{ events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON }],
  },
  {
    harness: 'codex',
    label: 'Codex CLI',
    sourceFile: 'src/bridges/codex_install.ts (CODEX_HOOK_EVENTS, CODEX_GLOBAL_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop']),
    reasons: [
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
      { events: ['notification', 'stop'], reason: NO_SERVER_HANDLER_REASON },
      {
        events: ['session_start'],
        reason:
          "GROK_HOOK_EVENTS (this row's explicit `install --grok` writer) mirrors install.ts's HOOK_EVENT_MAP as of the doc verification date -- Grok's real hooks doc has not been re-checked for SessionStart support since, so it is left unwired rather than guessed at (Grok's *default*, non---grok path still rides Claude Code's own settings.json directly and does receive session_start there, same as claudecode)",
      },
    ],
  },
  {
    harness: 'copilot_cli',
    label: 'Copilot CLI',
    sourceFile: 'src/bridges/copilot_cli_install.ts (COPILOT_CLI_HOOK_EVENTS), src/bridges/copilot_cli.ts (COPILOT_TO_TG_EVENT)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact', 'stop', 'subagent_stop', 'user_prompt_submit']),
    reasons: [
      {
        events: ['notification'],
        reason:
          "Copilot CLI has a real 'notification' hook event, but copilot_cli.ts's COPILOT_TO_TG_EVENT deliberately leaves it (and sessionEnd/postToolUseFailure/subagentStart/errorOccurred/permissionRequest) unimplemented rather than guessed at",
      },
      {
        events: ['session_start'],
        reason: 'COPILOT_TO_TG_EVENT has no session-start mapping wired yet -- left unimplemented rather than guessed at',
      },
    ],
  },
  {
    harness: 'gemini',
    label: 'Gemini CLI',
    sourceFile: 'src/bridges/gemini_install.ts (GEMINI_HOOK_EVENTS)',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
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
    harness: 'opencode',
    label: 'opencode',
    sourceFile: 'src/bridges/opencode.ts',
    implemented: new Set(['pre_tool_use', 'post_tool_use', 'pre_compact']),
    reasons: [
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
