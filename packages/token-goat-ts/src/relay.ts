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

import type { HookEvent } from './hook_registry.js'
import { runHook, serializeOutput } from './hook_registry.js'
import { HOOK_EVENTS, type HookEventName } from './types.js'

// Side-effect imports: each registers its handlers with the hook registry.
import './hooks_read.js'
import './hooks_edit.js'
import './hooks_index.js'
import './hooks_compact.js'
import './image_shrink.js'

/** Default stdin read timeout: long enough for a piped payload, short enough
 * that a hung upstream never stalls the tool call. */
const DEFAULT_STDIN_TIMEOUT_MS = 5000

/**
 * Read all of stdin and parse it as JSON, with a timeout.
 *
 * Resolves to the parsed value on success. Rejects when stdin yields no data
 * before `timeoutMs`, when the stream errors, or when the accumulated text is
 * not valid JSON. Callers treat any rejection as "pass" — see {@link relay}.
 */
export function readStdinJson(timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
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

  const rawSession = obj['session_id']
  const sessionId = typeof rawSession === 'string' ? rawSession : ''

  return { eventName, toolName, toolInput, sessionId, raw: obj }
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
    const payload = await readStdinJson()
    const event = buildEvent(eventName, payload)
    const output = await runHook(event)
    process.stdout.write(serializeOutput(output))
  } catch {
    // Pass-through on every failure path — a hook must never block Claude Code.
    process.stdout.write('{}')
  }
}
