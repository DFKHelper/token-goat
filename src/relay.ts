/**
 * Hook relay — the `token-goat hook <event>` entry point.
 *
 * Claude Code (and the bridge shims) invoke `token-goat hook <event>` for each
 * hook, piping the payload as JSON on stdin and reading the response JSON from
 * stdout. {@link relay} is that entry point: it reads stdin (with a timeout),
 * shapes the payload into a {@link HookEvent}, runs the registered handlers via
 * {@link runHook}, serializes the result with {@link serializeOutput}, and
 * writes it to stdout.
 *
 * The cardinal rule: never block Claude Code. Any failure results in a wire
 * response on stdout so a broken hook degrades rather than wedging the tool
 * call: an unparseable/unreadable stdin payload degrades to an empty payload
 * (letting each handler apply its own missing-field fallback, e.g.
 * `sessionStartHandler`'s `GENERIC_REMINDER`; see {@link relay}), while a
 * throwing handler or an unknown event still degrades all the way to a bare
 * `{}` no-op pass-through.
 *
 * Importing this module pulls in every hook-registering module for its
 * side-effects, so the registry is populated by the time {@link relay} runs.
 */

import { detectHarness } from './bridges/index.js'
import type { HookEvent } from './hook_registry.js'
import { runHook, serializeOutput } from './hook_registry.js'
import { normalizePayload, type Harness } from './hooks_cli.js'
import { HOOK_EVENTS, type HookEventName } from './types.js'
import { loadSessionState, saveSessionState } from './session_store.js'
// Re-exported below: this was defined here until it was split out (see stdin_json.ts's own note).
import { MAX_STDIN_BYTES, readStdinJson } from './stdin_json.js'

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

/**
 * Shape a raw stdin payload into a {@link HookEvent}.
 *
 * Pulls `tool_name`, `tool_input`, and `session_id` from the Claude Code wire
 * payload (the shapes the relay sees from every supported harness). Missing or
 * malformed fields degrade to safe defaults (`undefined` tool name, empty
 * input, empty session id) rather than throwing — the handlers themselves
 * decide what to do with a thin event.
 */
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

  return { eventName, toolName, toolInput, sessionId, agentId, raw: obj }
}

/**
 * The key used to load/save persisted session state (see {@link file://./session_store.ts}).
 *
 * All subagents spawned by one parent share the parent's `session_id` on the Claude
 * Code wire, so persisting keyed on `sessionId` alone conflates every subagent's reads
 * with its siblings' and the parent's -- a subagent's genuinely-first read of a file
 * gets denied as "already read" because a *different* subagent read it earlier. Salting
 * the key with `agentId` (present only inside a subagent call) gives each subagent its
 * own independent re-read dedup ledger while leaving the main thread (no agentId)
 * keyed on `sessionId` alone, unchanged from before this existed.
 */
function sessionStateKey(event: HookEvent): string {
  return event.agentId !== undefined ? `${event.sessionId}:agent:${event.agentId}` : event.sessionId
}

/**
 * Map the env-detected harness ({@link detectHarness}) onto {@link Harness}, the
 * narrower harness identifier {@link normalizePayload} understands.
 *
 * Codex, Gemini, and Grok all need tool-name remapping (their harness-native
 * names never match the canonical names registerHook(..., { toolName })
 * filters on -- Grok's entire wire payload is also camelCase rather than
 * snake_case, handled in hooks_cli.ts's grok branch); 'claudecode' /
 * 'opencode' / 'generic' payloads already use canonical tool names and pass
 * through unchanged. Uses detectHarness() (uncached) rather than
 * getHarnessName(): each hook invocation is a fresh, short-lived process, so
 * there is no benefit to memoizing and no stale-cache risk to worry about.
 */
function harnessForNormalization(): Harness {
  // detectHarness() (bridges/registry.ts) can return 'gemini' (or 'hermes' / 'openclaw') via env-var detection -- it is the single canonical implementation, unioned with the harness set compact.ts used to detect separately. installGemini() (bridges/gemini_install.ts) wires `token-goat hook <event>` directly into ~/.gemini/settings.json (no shim process like Codex's, so no other layer sets a harness flag) -- the child process inherits Gemini CLI's own environment (GEMINI_API_KEY / GOOGLE_API_KEY), so detectHarness() resolving to 'gemini' here is what makes normalizePayload()'s 'gemini' branch in hooks_cli.ts reachable for a real Gemini CLI install. hermes/openclaw still have no bridge/payload-writer, so they fall through to 'claude' unchanged for now.
  const detected = detectHarness()
  if (detected === 'codex') return 'codex'
  if (detected === 'gemini') return 'gemini'
  if (detected === 'grok') return 'grok'
  // Kimi Code's shim (src/bridges/kimi.ts) sets TOKEN_GOAT_HARNESS_OVERRIDE=kimi before dispatching, so detectHarness() resolves 'kimi' here for a real Kimi install. Its payload needs remapping because Kimi's v2 tools name their path argument `path` rather than `file_path` (and its URL fetcher is `FetchURL`, not `WebFetch`).
  if (detected === 'kimi') return 'kimi'
  return 'claude'
}

/**
 * Run the hook for `eventName` against an already-parsed payload and return the
 * serialized wire JSON response as a string (never writes to stdout/stdin).
 *
 * This is the in-process counterpart of {@link relay}: it contains every step
 * relay() performs after reading stdin, factored out so bridges that already
 * run inside a long-lived Node process (OpenClaw, opencode, pi) or that spawn
 * their own shim process (Codex, Claude Code, Copilot CLI) can call straight
 * into the hook registry via `import()` instead of `spawnSync`-ing a second
 * `token-goat hook <event>` process. On *any* error — invalid event name,
 * malformed payload, handler throw — it resolves to `'{}'` so the caller's
 * tool call proceeds unchanged. This function never throws and never rejects.
 */
export async function relayInProcess(eventName: string, rawPayload: unknown): Promise<string> {
  try {
    if (!isHookEventName(eventName)) {
      return '{}'
    }
    // Read before the CLAUDE_CODE_SESSION_ID seeding below, which sets that variable for every harness and would make a later detection answer 'claudecode' everywhere. serializeOutput needs the true harness to decide the pre_compact wire form, so capture it while the environment still says who we are.
    const harness = detectHarness()
    // Codex and Gemini send harness-native tool names (e.g. `bash`, `read_file`) that never match the canonical names (`Bash`, `Read`, ...) handlers filter on via registerHook(..., { toolName }). Normalization is scoped to the two tool-scoped events: normalizePayload() treats a payload with no tool_name as invalid and returns {}, which would silently drop session_id off pre_compact/stop/notification payloads if run unconditionally.
    const payload =
      eventName === 'pre_tool_use' || eventName === 'post_tool_use'
        ? normalizePayload(rawPayload, harnessForNormalization())
        : rawPayload
    const event = buildEvent(eventName, payload)
    // getSessionId() (session.ts) only ever resolves CLAUDE_CODE_SESSION_ID from the environment, which Claude Code sets itself but every other bridge (Codex, opencode, pi, Gemini, Grok, Copilot, OpenClaw) never does — those harnesses deliver the session id only on the wire, via event.sessionId above. Since each hook invocation is a fresh short-lived process, leaving the env var unseeded means every call on a non-Claude-Code harness gets a brand-new random session id from getSessionId(), breaking read-dedup/reread-diffing, context-pressure tiering, and manifest continuity for those harnesses. Seed it here, once, before any handler runs, rather than patching each getSessionId() call site individually.
    if (!process.env['CLAUDE_CODE_SESSION_ID'] && event.sessionId) {
      process.env['CLAUDE_CODE_SESSION_ID'] = event.sessionId
    }
    // Load persisted session state before handlers run; save the mutated state after. Each is isolated in its own try/catch so a persistence failure can never suppress the handler's real output (the cardinal rule above).
    const stateKey = sessionStateKey(event)
    try {
      loadSessionState(stateKey)
    } catch {
      // fail-soft: a load failure just means a cold session
    }
    const output = await runHook(event)
    try {
      saveSessionState(stateKey)
    } catch {
      // fail-soft: a save failure must not block the tool call
    }
    return serializeOutput(output, event.eventName, harness)
  } catch {
    // Pass-through on every failure path — a hook must never block the caller's tool call.
    return '{}'
  }
}

/**
 * Run the hook for `eventName` and write the wire JSON response to stdout.
 *
 * Reads stdin, then delegates to {@link relayInProcess} for everything else,
 * and prints its result. This function never throws.
 *
 * A stdin read failure (timeout, oversized payload, or -- the common real case on
 * Windows -- a caller that string-interpolated a raw backslash path into the JSON
 * text instead of escaping it, so `JSON.parse` rejects) degrades to an *empty*
 * payload (`{}` as a parsed object) rather than abandoning the call outright: the
 * event name is already known from `eventName` (a CLI arg, never part of the
 * unparseable stdin), so every handler still runs with all-fields-missing input and
 * gets the same chance to apply its own graceful fallback that "field omitted"
 * already gives it (e.g. session_start's `sessionStartHandler` falls back to
 * `GENERIC_REMINDER` when `cwd` is missing -- see hooks_session_start.ts). Treating
 * a malformed payload as strictly worse than a merely incomplete one produced a
 * silent `{"hookType":"pass"}`-shaped `{}` with zero diagnostics, indistinguishable
 * from "no hook registered for this event," even though the event itself was
 * perfectly identifiable and every handler was fully able to degrade gracefully.
 * Only a genuinely unknown/invalid `eventName` -- which no fallback can route --
 * still short-circuits straight to the bare pass-through `{}` below.
 */
export async function relay(eventName: string): Promise<void> {
  try {
    if (!isHookEventName(eventName)) {
      // Still a pass on stdout -- the cardinal rule above holds and a hook must never wedge the
      // tool call. But this branch is a wiring mistake, not a runtime hazard: a settings.json left
      // behind by an older build, a hand-edited entry, or a bridge shim passing its own spelling
      // means every hook for that event does nothing at all. Nothing failed, nothing was logged,
      // and the exit code stayed 0, so image shrinking, read dedup and the dirty-queue enqueue all
      // quietly stopped while the index went stale with no way to see why. Say so on stderr, where
      // normalizePayload already reports a bad payload and where the harness will not mistake it
      // for the response.
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
