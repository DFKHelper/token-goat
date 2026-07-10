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
 * The cardinal rule: never block Claude Code. Any failure — empty stdin,
 * non-JSON, a throwing handler, an unknown event — results in `{}` (a no-op
 * pass-through) on stdout, so a broken hook degrades to "do nothing" rather
 * than wedging the tool call.
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

// Side-effect imports: each registers its handlers with the hook registry.
import './hooks_read.js'
import './hooks_edit.js'
import './hooks_index.js'
import './hooks_compact.js'
import './hooks_session.js'
import './hooks_fetch.js'
import './hooks_skill.js'
import './hooks_bash.js'
import './hooks_mcp.js'
import './hooks_screenshot.js'
import './image_shrink.js'

/** Default stdin read timeout: long enough for a piped payload, short enough
 * that a hung upstream never stalls the tool call. */
const DEFAULT_STDIN_TIMEOUT_MS = 5000

/**
 * Default cap on accumulated stdin bytes before readStdinJson aborts the read
 * early, rather than relying solely on DEFAULT_STDIN_TIMEOUT_MS to eventually
 * stop a malformed or adversarial stream. Matches the magnitude of
 * bash_runner.ts's MAX_CAPTURE_BYTES (32 MiB), the closest existing precedent
 * for bounding an unbounded input stream in this codebase, doubled to leave
 * headroom for JSON-string-escaping overhead on the largest legitimate
 * payload today (a captured bash output embedded in a tool_response).
 */
export const MAX_STDIN_BYTES = 64 * 1024 * 1024

/**
 * Read all of stdin and parse it as JSON, with a timeout.
 *
 * Resolves to the parsed value on success. Rejects when stdin yields no data
 * before `timeoutMs`, when the stream errors, or when the accumulated text is
 * not valid JSON. Callers treat any rejection as "pass" — see {@link relay}.
 */
export function readStdinJson(
  timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS,
  maxBytes: number = MAX_STDIN_BYTES,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('readStdinJson: timed out waiting for stdin')))
    }, timeoutMs)

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        // Detaching listeners alone leaves the stream flowing at the OS/event-loop level;
        // destroy it so the fd is released and nothing keeps buffering data no one will read.
        finish(() => {
          process.stdin.destroy()
          reject(new Error(`readStdinJson: stdin exceeded ${maxBytes} bytes`))
        })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') {
          reject(new Error('readStdinJson: empty stdin'))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    }
    const onError = (err: unknown): void => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
  })
}

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

  // Prefer snake_case `session_id` (Claude Code wire format); fall back to
  // camelCase `sessionId` for harnesses that emit camelCase payloads (e.g. Grok,
  // which inherits claudecode's 7-event hook wiring but sends `sessionId`). Without
  // this, non-tool events (stop/pre_compact/notification/...) load and save session
  // state under an empty string.
  const rawSession = obj['session_id'] ?? obj['sessionId']
  const sessionId = typeof rawSession === 'string' ? rawSession : ''

  // agent_id (Claude Code's subagent-invocation id) is present only when this hook
  // fired inside a subagent call; undefined on the main thread. camelCase fallback
  // mirrors sessionId's harness-tolerance above.
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
  // detectHarness() (bridges/registry.ts) can return 'gemini' (or 'hermes' /
  // 'openclaw') via env-var detection -- it is the single canonical
  // implementation, unioned with the harness set compact.ts used to detect
  // separately. installGemini() (bridges/gemini_install.ts) wires
  // `token-goat hook <event>` directly into ~/.gemini/settings.json (no shim
  // process like Codex's, so no other layer sets a harness flag) -- the child
  // process inherits Gemini CLI's own environment (GEMINI_API_KEY /
  // GOOGLE_API_KEY), so detectHarness() resolving to 'gemini' here is what
  // makes normalizePayload()'s 'gemini' branch in hooks_cli.ts reachable for
  // a real Gemini CLI install. hermes/openclaw still have no bridge/
  // payload-writer, so they fall through to 'claude' unchanged for now.
  const detected = detectHarness()
  if (detected === 'codex') return 'codex'
  if (detected === 'gemini') return 'gemini'
  if (detected === 'grok') return 'grok'
  return 'claude'
}

/**
 * Run the hook for `eventName` and write the wire JSON response to stdout.
 *
 * Reads and parses stdin, builds the event, dispatches it through the registry,
 * and prints the serialized output. On *any* error — invalid event name,
 * stdin failure, handler throw — it writes `{}` so the tool call proceeds
 * unchanged. This function never throws.
 */
export async function relay(eventName: string): Promise<void> {
  try {
    if (!isHookEventName(eventName)) {
      process.stdout.write('{}')
      return
    }
    const rawPayload = await readStdinJson()
    // Codex and Gemini send harness-native
    // tool names (e.g. `bash`, `read_file`) that never match the canonical names
    // (`Bash`, `Read`, ...) handlers filter on via registerHook(..., { toolName }).
    // Normalization is scoped to the two tool-scoped events: normalizePayload()
    // treats a payload with no tool_name as invalid and returns {}, which would
    // silently drop session_id off pre_compact/stop/notification payloads if run
    // unconditionally.
    const payload =
      eventName === 'pre_tool_use' || eventName === 'post_tool_use'
        ? normalizePayload(rawPayload, harnessForNormalization())
        : rawPayload
    const event = buildEvent(eventName, payload)
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
    process.stdout.write(serializeOutput(output, event.eventName))
  } catch {
    // Pass-through on every failure path — a hook must never block Claude Code.
    process.stdout.write('{}')
  }
}
