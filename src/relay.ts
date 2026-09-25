/** Hook relay — the `token-goat hook <event>` entry point. Claude Code (and the bridge shims) invoke `token-goat hook <event>` for each hook, piping the payload as JSON on stdin and reading the response JSON from stdout. {@link relay} is that entry point: it reads stdin (with a timeout), shapes the payload into a {@link HookEvent}, runs the registered handlers via {@link runHook}, serializes the result with {@link serializeOutput}, and writes it to stdout. The cardinal rule: never block Claude Code. Any failure results in a wire response on stdout so a broken hook degrades rather than wedging the tool call: an unparseable/unreadable stdin payload degrades to an empty payload (letting each handler apply its own missing-field fallback, e.g. `sessionStartHandler`'s `GENERIC_REMINDER`; see {@link relay}), while a throwing handler or an unknown event still degrades all the way to a bare `{}` no-op pass-through. Importing this module pulls in every hook-registering module for its side-effects, so the registry is populated by the time {@link relay} runs. */

import { detectHarness, relaySeededSessionId, setRelaySeededSessionId } from './bridges/registry.js'
import { applyCallStreak } from './call_streak.js'
import type { HookEvent } from './hook_registry.js'
import { runHook, serializeOutput, sessionStateKey } from './hook_registry.js'
import { stripUnsafeSuggestions } from './hint_suggestion_guard.js'
import { sharpenRepeatedDeny } from './hint_target.js'
import { normalizePayload, type Harness } from './hooks_cli.js'
import { commitPendingContext } from './pending_context.js'
import { HOOK_EVENTS, type HookEventName, type HookOutput } from './types.js'
import { loadSessionState, saveSessionState } from './session_store.js'
import { setTranscriptPath } from './session.js'
import { recordStat } from './stats.js'
// Re-exported below: this was defined here until it was split out (see stdin_json.ts's own note).
import { MAX_STDIN_BYTES, readStdinJson } from './stdin_json.js'
import { shouldSuppressDuplicateVscodeHook } from './vscode_duplicate.js'

// Side-effect imports: each registers its handlers with the hook registry.
import './hooks_read.js'
import './hooks_grep.js'
import './hooks_glob.js'
import './hooks_edit.js'
import './hooks_write.js'
import './hooks_index.js'
import './hooks_compact.js'
import './hooks_session.js'
import './hooks_session_start.js'
import './hooks_fetch.js'
import './hooks_skill.js'
import './hooks_bash.js'
import './hooks_bashoutput.js'
import './hooks_taskoutput.js'
import './hooks_tool_failure.js'
import './hooks_exitplanmode.js'
import './hooks_mcp.js'
import './hooks_websearch.js'
import './hooks_screenshot.js'
import './hooks_browser_image.js'
import './hooks_agent_spawn.js'
import './image_shrink.js'

export { MAX_STDIN_BYTES, readStdinJson }

/** Validate that `name` is a known internal hook event name. */
function isHookEventName(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name)
}

/** Shape a raw stdin payload into a {@link HookEvent}. Pulls `tool_name`, `tool_input`, and `session_id` from the Claude Code wire payload (the shapes the relay sees from every supported harness). Missing or malformed fields degrade to safe defaults (`undefined` tool name, empty input, empty session id) rather than throwing — the handlers themselves decide what to do with a thin event. */
export function buildEvent(eventName: HookEventName, payload: unknown): HookEvent {
  const obj: Record<string, unknown> =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  const rawToolName = obj['tool_name']
  const toolName = typeof rawToolName === 'string' && rawToolName.trim() !== '' ? rawToolName : undefined

  const rawInput = obj['tool_input']
  const toolInput: Record<string, unknown> =
    typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}

  // Prefer snake_case `session_id` (Claude Code wire format); fall back to camelCase `sessionId` for harnesses that emit camelCase payloads (e.g. Grok, which inherits claudecode's 7-event hook wiring but sends `sessionId`). Without this, non-tool events (stop/pre_compact/notification/...) load and save session state under an empty string.
  const rawSession = obj['session_id'] ?? obj['sessionId']
  const sessionId = typeof rawSession === 'string' ? rawSession : ''

  // agent_id (Claude Code's subagent-invocation id) is present only when this hook fired inside a subagent call; undefined on the main thread. camelCase fallback mirrors sessionId's harness-tolerance above.
  const rawAgentId = obj['agent_id'] ?? obj['agentId']
  const agentId = typeof rawAgentId === 'string' && rawAgentId !== '' ? rawAgentId : undefined

  // traceparent / tracestate: W3C Trace Context headers from Claude Code / OTel spans or environment.
  const rawTraceparent =
    obj['traceparent'] ??
    obj['traceParent'] ??
    process.env['TRACEPARENT'] ??
    process.env['traceparent']
  const traceparent =
    typeof rawTraceparent === 'string' && rawTraceparent.trim() !== '' ? rawTraceparent.trim() : undefined

  const rawTracestate =
    obj['tracestate'] ??
    obj['traceState'] ??
    process.env['TRACESTATE'] ??
    process.env['tracestate']
  const tracestate =
    typeof rawTracestate === 'string' && rawTracestate.trim() !== '' ? rawTracestate.trim() : undefined

  return { eventName, toolName, toolInput, sessionId, agentId, traceparent, tracestate, raw: obj }
}

/** Map the env-detected harness ({@link detectHarness}) onto {@link Harness}, the narrower harness identifier {@link normalizePayload} understands. Codex, Gemini, and Grok all need tool-name remapping (their harness-native names never match the canonical names registerHook(..., { toolName }) filters on -- Grok's entire wire payload is also camelCase rather than snake_case, handled in hooks_cli.ts's grok branch); 'claudecode' / 'opencode' / 'generic' payloads already use canonical tool names and pass through unchanged. Uses detectHarness() (uncached) rather than getHarnessName(): each hook invocation is a fresh, short-lived process, so there is no benefit to memoizing and no stale-cache risk to worry about. */
function harnessForNormalization(): Harness {
  // detectHarness() (bridges/registry.ts) can return 'gemini' (or 'hermes' / 'openclaw') via env-var detection -- it is the single canonical implementation, unioned with the harness set compact.ts used to detect separately. installGemini() (bridges/gemini_install.ts) wires `token-goat hook <event>` directly into ~/.gemini/settings.json (no shim process like Codex's, so no other layer sets a harness flag) -- the child process inherits Gemini CLI's own environment (GEMINI_API_KEY / GOOGLE_API_KEY), so detectHarness() resolving to 'gemini' here is what makes normalizePayload()'s 'gemini' branch in hooks_cli.ts reachable for a real Gemini CLI install. hermes/openclaw still have no bridge/payload-writer, so they fall through to 'claude' unchanged for now.
  const detected = detectHarness()
  if (detected === 'codex') return 'codex'
  if (detected === 'gemini') return 'gemini'
  if (detected === 'grok') return 'grok'
  // Kimi Code's shim (src/bridges/kimi.ts) sets TOKEN_GOAT_HARNESS_OVERRIDE=kimi before dispatching, so detectHarness() resolves 'kimi' here for a real Kimi install. Its payload needs remapping because Kimi's v2 tools name their path argument `path` rather than `file_path` (and its URL fetcher is `FetchURL`, not `WebFetch`).
  if (detected === 'kimi') return 'kimi'
  // Qwen Code's install wires `token-goat hook <event> --harness qwen` (qwen_install.ts), which sets TOKEN_GOAT_HARNESS_OVERRIDE=qwen, so detectHarness() resolves 'qwen' here. Before this branch existed, 'qwen' fell through to 'claude' and Qwen's runtime tool ids (read_file/run_shell_command/grep_search/...) reached dispatch unrenamed, matching no registered handler -- every tool-scoped hook was silently dead on Qwen (see QWEN_TOOL_NAME_MAP in hooks_cli.ts for the full producer-side derivation).
  if (detected === 'qwen') return 'qwen'
  // Copilot CLI's shim (src/bridges/copilot_cli.ts) sets TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli, so detectHarness() resolves it here. Its branch in normalizePayload() exists only to translate Copilot's `<server>-<tool>` MCP tool names into the `mcp__<server>__<tool>` spelling the MCP handlers gate on; the shim has already canonicalised every built-in name, so nothing else changes.
  if (detected === 'copilot_cli') return 'copilot_cli'
  // VS Code's agent hooks run through the shared Copilot shim, which sets TOKEN_GOAT_HARNESS_OVERRIDE=vscode when the payload carries VS Code's `hook_event_name`; its model-facing tool names (read_file, run_in_terminal, ...) need VSCODE_TOOL_NAME_MAP.
  if (detected === 'vscode') return 'vscode'
  return 'claude'
}

/** Remove any `token-goat …` suggestion whose quoting a file path broke out of. Every hook's output passes through here, which is the reason the check lives at this seam rather than at the ~40 places that build one of these strings by concatenation: a new hint site is safe the day it is written, without its author having to know. See {@link stripUnsafeSuggestions} for what a break looks like and why a path can contain one. Only the two variants token-goat composes itself are rewritten. `rewriteInput` is deliberately excluded: the one command token-goat makes executable is the `token-goat compress -c '<cmd>'` wrapper, which is already quoted at its own call site, and a user command legitimately containing `$` would be destroyed by a check meant for suggestions. `rewriteOutput` is excluded for the mirror-image reason: it carries captured tool output, so a file that merely quotes a token-goat command would be edited as though it were one. */
function safeSuggestions(output: HookOutput): HookOutput {
  if (output.hookType === 'deny') return { hookType: 'deny', message: stripUnsafeSuggestions(output.message) }
  if (output.hookType === 'context') return { hookType: 'context', context: stripUnsafeSuggestions(output.context) }
  return output
}

/** Settles when the most recent {@link relayInProcess} call has; never rejects, so one failed call never blocks the next. */
let relayQueue: Promise<unknown> = Promise.resolve()

/** How long a {@link relayInProcess} call waits for the one before it to settle before it runs anyway. A handler that never settles would otherwise stall every later hook call in the host process for good, where the bridges' spawn fallback kills its child after 3000 ms. Set far above what a hook call has been seen to take: of 66,625 `hook:*` rows in this machine's ledger (2026-09-20 to 2026-09-24, Claude Code, Codex and Copilot CLI; each row a whole process lifetime, node startup included) p50 was 98 ms, p99 494 ms, p99.9 2,052 ms and the maximum 31,185 ms, and a document extraction a handler starts may run for MAX_DOCUMENT_WORK_MILLIS (60,000 ms) on its own. */
export const RELAY_QUEUE_WAIT_MS = 120_000

/** Resolves once `previous` settles, or after {@link RELAY_QUEUE_WAIT_MS}, whichever comes first. The timer is cleared on settle and unref'd, so a one-shot `token-goat hook` process never waits on it to exit. */
function afterPredecessor(previous: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RELAY_QUEUE_WAIT_MS)
    timer.unref()
    void previous.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Run the hook for `eventName` against an already-parsed payload and return the serialized wire JSON response as a string (never writes to stdout/stdin). This is the in-process counterpart of {@link relay}: it contains every step relay() performs after reading stdin, factored out so bridges that already run inside a long-lived Node process (OpenClaw, opencode, pi) or that spawn their own shim process (Codex, Claude Code, Copilot CLI) can call straight into the hook registry via `import()` instead of `spawnSync`-ing a second `token-goat hook <event>` process. `harnessWaitMs`, when given, is what the harness actually waited on before it stopped waiting — Claude Code's async-detach shim classifies eligibility and prints its early `{"async":true}` marker before this function ever runs, so the shim's own `performance.now()` at that print is the true harness-visible latency; without it, the `finally` below would keep recording this call's own full process lifetime even though the harness stopped listening long before that. Omitted for every synchronous call, where process lifetime and harness wait are the same number. On *any* error — invalid event name, malformed payload, handler throw — it resolves to `'{}'` so the caller's tool call proceeds unchanged. This function never throws and never rejects. Calls within one process run one at a time, in arrival order: each loads its session's state into module-level maps, awaits the handlers, then saves, so a concurrent call's load (opencode, OpenClaw and pi can run tool calls concurrently in one host process) used to replace the maps mid-call and save one session's reads under another's key. A call waits at most {@link RELAY_QUEUE_WAIT_MS} for the one before it, so one that never settles cannot stall the process's later calls; it still resolves to its own result whenever that arrives. */
/** Options for {@link relayInProcess}. `elapsedMs` replaces the default clock for the duration this call records: `performance.now()` measures this process from its own start, which is what a caller waited on only when this process was started for the call. A resident server (hook_server.ts) serves calls from a process started long before, so it passes the caller's own elapsed time plus its handling time instead. */
export interface RelayInProcessOptions {
  elapsedMs?: () => number
  /** Takes this call's own bookkeeping (its latency row in `stats`) instead of running it before the result is returned, so a caller able to answer first can run it after. `duration_ms` is fixed when the call ends either way. */
  afterReply?: (work: () => void) => void
}

export function relayInProcess(eventName: string, rawPayload: unknown, harnessWaitMs?: number, opts: RelayInProcessOptions = {}): Promise<string> {
  // When this event reached token-goat, before any handler time or wait behind an earlier call: call_streak.ts tells a batched call from a serial one by the gap between events.
  const receivedAt = Date.now()
  const run = afterPredecessor(relayQueue).then(() => relayOne(eventName, rawPayload, harnessWaitMs, receivedAt, opts.elapsedMs ?? (() => performance.now()), opts.afterReply))
  relayQueue = run.catch(() => undefined)
  return run
}

/** One {@link relayInProcess} call, run once every earlier call has settled or {@link RELAY_QUEUE_WAIT_MS} has passed. */
async function relayOne(eventName: string, rawPayload: unknown, harnessWaitMs: number | undefined, receivedAt: number, elapsedMs: () => number, afterReply?: (work: () => void) => void): Promise<string> {
  if (!isHookEventName(eventName)) {
    return '{}'
  }
  // Wall-clock from process start, not from this line: what a harness actually waits on is everything since `node` began -- module load and import resolution included -- not just dispatch, which used to be all this recorded (~28ms of an ~89ms real wait, confirmed against an external stopwatch on the production shim). `performance.now()` reads elapsed time since `performance.timeOrigin` (process start), so reading it once in the finally block below, rather than diffing two timestamps taken inside this function, is what makes the total include everything before this function ever ran -- true for every synchronous call, and for an async-detached one whose caller did not pass `harnessWaitMs`.
  try {
    // serializeOutput needs the true harness to decide the pre_compact wire form. The CLAUDE_CODE_SESSION_ID seeding below does not change this answer: detectHarness() discounts a value relay seeded (registry.ts::relaySeededSessionId), which a long-lived host still carries from its previous call.
    const harness = detectHarness()
    // Codex and Gemini send harness-native tool names (e.g. `bash`, `read_file`) that never match the canonical names (`Bash`, `Read`, ...) handlers filter on via registerHook(..., { toolName }). Normalization is scoped to the two tool-scoped events: normalizePayload() treats a payload with no tool_name as invalid and returns {}, which would silently drop session_id off pre_compact/stop/notification payloads if run unconditionally.
    const payload =
      eventName === 'pre_tool_use' || eventName === 'post_tool_use'
        ? normalizePayload(rawPayload, harnessForNormalization())
        : rawPayload
    const event = buildEvent(eventName, payload)
    // VS Code runs every hooks file it discovers, so one event can arrive here two or more times (user scope alongside project scope, or once per workspace folder). Stand down when another copy is already handling this exact event; see vscode_duplicate.ts for which cases are elected here and which the path gate already settles. Fails open by construction.
    if (shouldSuppressDuplicateVscodeHook(event, harness)) return '{}'
    // getSessionId() (session.ts) only ever resolves CLAUDE_CODE_SESSION_ID from the environment, which Claude Code sets itself but every other bridge (Codex, opencode, pi, Gemini, Grok, Copilot, OpenClaw) never does — those harnesses deliver the session id only on the wire, via event.sessionId above. Since each hook invocation is a fresh short-lived process, leaving the env var unseeded means every call on a non-Claude-Code harness gets a brand-new random session id from getSessionId(), breaking read-dedup/reread-diffing, context-pressure tiering, and manifest continuity for those harnesses. Seed it here, once, before any handler runs, rather than patching each getSessionId() call site individually. The pi, opencode and OpenClaw bridges run this in one long-lived host process serving session after session, so a value seeded here follows the wire id: replaced when the next event names another session, removed when one names none. A value relay did not seed is the harness's own (Claude Code sets it) and is never touched.
    const envSessionId = process.env['CLAUDE_CODE_SESSION_ID']
    const seededSessionId = relaySeededSessionId()
    if (!envSessionId || envSessionId === seededSessionId) {
      if (event.sessionId) {
        process.env['CLAUDE_CODE_SESSION_ID'] = event.sessionId
        setRelaySeededSessionId(event.sessionId)
      } else if (seededSessionId !== undefined) {
        delete process.env['CLAUDE_CODE_SESSION_ID']
        setRelaySeededSessionId(undefined)
      }
    }
    // Record the transcript path so getContextPressure() can measure real prompt size from it (compact.ts::measurePromptTokens) instead of estimating. Paired with the wire session id rather than the env var seeded just above, which the harness may have set itself and relay then leaves alone. See session.ts::setTranscriptPath.
    const rawTranscriptPath = event.raw['transcript_path']
    if (typeof rawTranscriptPath === 'string' && rawTranscriptPath !== '') {
      setTranscriptPath(rawTranscriptPath, event.sessionId ?? '')
    }
    // Propagate W3C trace context to environment if delivered on the payload wire, so child subprocesses/tools can correlate spans.
    if (!process.env['TRACEPARENT'] && event.traceparent) {
      process.env['TRACEPARENT'] = event.traceparent
    }
    if (!process.env['TRACESTATE'] && event.tracestate) {
      process.env['TRACESTATE'] = event.tracestate
    }
    // Load persisted session state before handlers run; save the mutated state after. Each is isolated in its own try/catch so a persistence failure can never suppress the handler's real output (the cardinal rule above).
    const stateKey = sessionStateKey(event)
    try {
      loadSessionState(stateKey)
    } catch {
      // fail-soft: a load failure just means a cold session
    }
    const output = safeSuggestions(sharpenRepeatedDeny(event, applyCallStreak(event, await runHook(event), receivedAt)))
    // Clear the deferred-hint queue only once the text is in the output that is about to be serialized. The handler that reads that queue is advisory, and runHook discards an advisory result whenever a later non-advisory handler returns one of its own, so consuming the queue at read time deleted queued compaction manifests that then reached nothing. Checking the emitted string makes delivery a fact rather than an assumption, and leaves an undelivered hint queued for the next tool call. See pending_context.ts.
    if (event.sessionId) {
      commitPendingContext(stateKey, output.hookType === 'context' ? output.context : null)
    }
    try {
      saveSessionState(stateKey)
    } catch {
      // fail-soft: a save failure must not block the tool call
    }
    return serializeOutput(output, event.eventName, harness, event)
  } catch {
    // Pass-through on every failure path — a hook must never block the caller's tool call.
    return '{}'
  } finally {
    // recordStat() is its own already-open, already-fail-soft synchronous write (the same one every other hook-path stat in this codebase makes), so this adds no new blocking behavior -- including on the async-detach path (shim_common.ts), which prints its early marker before this module ever runs and does not wait for relayInProcess to return either way. duration_ms means one thing everywhere it is read (token-goat stats --hooks, doctor's latency check): what the caller waited on. For an async-detached call that is harnessWaitMs, captured by the shim at the moment it printed the marker and handed in by the caller; for every other call it is this call's own full elapsed time, which is also what the caller waited on since nothing detached early.
    const durationMs = harnessWaitMs ?? elapsedMs()
    const record = (): void => recordStat(`hook:${eventName}`, 0, 0, undefined, undefined, undefined, durationMs)
    if (afterReply) afterReply(record)
    else record()
  }
}

/** Run the hook for `eventName` and write the wire JSON response to stdout. Reads stdin, then delegates to {@link relayInProcess} for everything else, and prints its result. This function never throws. A stdin read failure (timeout, oversized payload, or -- the common real case on Windows -- a caller that string-interpolated a raw backslash path into the JSON text instead of escaping it, so `JSON.parse` rejects) degrades to an *empty* payload (`{}` as a parsed object) rather than abandoning the call outright: the event name is already known from `eventName` (a CLI arg, never part of the unparseable stdin), so every handler still runs with all-fields-missing input and gets the same chance to apply its own graceful fallback that "field omitted" already gives it (e.g. session_start's `sessionStartHandler` falls back to `GENERIC_REMINDER` when `cwd` is missing -- see hooks_session_start.ts). Treating a malformed payload as strictly worse than a merely incomplete one produced a silent `{"hookType":"pass"}`-shaped `{}` with zero diagnostics, indistinguishable from "no hook registered for this event," even though the event itself was perfectly identifiable and every handler was fully able to degrade gracefully. Only a genuinely unknown/invalid `eventName` -- which no fallback can route -- still short-circuits straight to the bare pass-through `{}` below. */
export async function relay(eventName: string): Promise<void> {
  try {
    if (!isHookEventName(eventName)) {
      // Still a pass on stdout -- the cardinal rule above holds and a hook must never wedge the tool call. But this branch is a wiring mistake, not a runtime hazard: a settings.json left behind by an older build, a hand-edited entry, or a bridge shim passing its own spelling means every hook for that event does nothing at all. Nothing failed, nothing was logged, and the exit code stayed 0, so image shrinking, read dedup and the dirty-queue enqueue all quietly stopped while the index went stale with no way to see why. Say so on stderr, where normalizePayload already reports a bad payload and where the harness will not mistake it for the response.
      console.error(
        `[relay] unknown hook event '${eventName}'; nothing ran. Valid events: ${HOOK_EVENTS.join(', ')}`,
      )
      process.stdout.write('{}')
      return
    }
    let rawPayload: unknown
    try {
      rawPayload = await readStdinJson()
    } catch {
      rawPayload = {}
    }
    process.stdout.write(await relayInProcess(eventName, rawPayload))
  } catch {
    // Pass-through on every remaining failure path — a hook must never block Claude Code.
    process.stdout.write('{}')
  }
}
