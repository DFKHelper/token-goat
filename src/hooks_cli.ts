/**
 * Hook dispatcher: normalize payloads, denormalize responses, run events end-to-end.
 *
 * Ports Python's hooks_cli.py: normalizePayload, denormalizeResponse, failSoft, and
 * safeRun provide harness-agnostic entry points for tool-code binding.
 */

import { runHook } from './hook_registry.js'

const _LOG = {
  warn: (msg: string, ...args: unknown[]) => console.warn(`[hooks_cli] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => console.debug(`[hooks_cli] ${msg}`, ...args),
  error: (msg: string, err?: unknown, ...args: unknown[]) =>
    console.error(`[hooks_cli] ${msg}`, ...(err ? [err] : []), ...args),
}

/**
 * Harness identifier: the Claude Code harness variant token-goat is running under.
 * Determines payload/response shape translation.
 */
export type Harness = 'claude' | 'codex' | 'gemini'

/**
 * Hook payload: unstructured dict from harness stdin.
 *
 * The raw shape is harness-specific (camelCase in Claude, snake_case in Codex/Gemini).
 * normalize_payload translates to internal PascalCase shape before dispatch.
 */
export type HookPayload = Record<string, unknown>

/**
 * Hook response: internal result dict from dispatch.
 *
 * Contains handler output plus diagnostic keys (_tg_* fields). denormalize_response
 * translates to harness wire format.
 */
export type HookResponse = Record<string, unknown>

/**
 * Codex tool name → internal PascalCase tool name.
 * Codex uses lowercase/snake_case; token-goat handlers expect PascalCase.
 */
const CODEX_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  edit_file: 'Edit',
  edit: 'Edit',
  write_file: 'Write',
  search_files: 'Grep',
  grep: 'Grep',
  list_files: 'Glob',
  glob: 'Glob',
  web_search: 'WebFetch',
}

/**
 * Gemini tool name → internal PascalCase tool name.
 * Gemini uses snake_case; token-goat uses PascalCase.
 */
const GEMINI_TOOL_NAME_MAP: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  list_directory: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  glob: 'Glob',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  web_search: 'WebFetch',
  web_fetch: 'WebFetch',
}

/**
 * Gemini tool_input key → internal key, per remapped tool.
 * Only keys that differ between Gemini and token-goat need to appear here.
 */
const GEMINI_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  Read: { path: 'file_path' },
  Write: { path: 'file_path' },
  Edit: { path: 'file_path', old_str: 'old_string', new_str: 'new_string' },
  Grep: { query: 'pattern' },
}

/**
 * Translate harness-specific payload to internal format.
 *
 * Codex sends snake_case tool names; Claude uses PascalCase.
 * Gemini sends snake_case tool names and may use functionCallId instead of toolUseId.
 *
 * Returns an empty dict on validation failures (non-dict, empty, missing tool_name)
 * so handlers degrade gracefully.
 */
export function normalizePayload(payload: unknown, harness: Harness = 'claude'): HookPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    _LOG.warn('normalizePayload: payload is not a dict; received %s', typeof payload)
    return {}
  }

  const obj = payload as Record<string, unknown>
  const toolName = obj['tool_name']
  if (typeof toolName !== 'string' || !toolName.trim()) {
    _LOG.debug('normalizePayload: tool_name missing or invalid; received %s', toolName)
    return {}
  }

  if (harness === 'codex') {
    const mapped = CODEX_TOOL_NAME_MAP[toolName]
    const result = { ...obj }
    if (mapped) {
      result['tool_name'] = mapped
    }
    result['_tg_harness'] = harness
    return result
  }

  if (harness === 'gemini') {
    const mapped = GEMINI_TOOL_NAME_MAP[toolName]
    const result = { ...obj }
    if (mapped) {
      result['tool_name'] = mapped
      const rawInput = obj['tool_input']
      if (typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)) {
        const keyMap = GEMINI_INPUT_KEY_MAP[mapped]
        if (keyMap) {
          const input = rawInput as Record<string, unknown>
          const newInput: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(input)) {
            newInput[keyMap[k] || k] = v
          }
          result['tool_input'] = newInput
        }
      }
    }
    if ('functionCallId' in result && !('toolUseId' in result)) {
      result['toolUseId'] = result['functionCallId']
      delete result['functionCallId']
    }
    result['_tg_harness'] = harness
    return result
  }

  const result = { ...obj }
  result['_tg_harness'] = harness
  return result
}

/**
 * Translate internal response dict to harness wire format.
 *
 * Codex: strips _tg_* keys and injects hookEventName when absent.
 * Gemini: maps continue→decision, preserves systemMessage and additionalContext.
 * Claude: pass through unchanged.
 */
export function denormalizeResponse(
  response: HookResponse,
  harness: Harness = 'claude',
  _event: string = ''
): HookResponse {
  if (harness === 'codex') {
    const result: HookResponse = {}
    for (const [k, v] of Object.entries(response)) {
      if (!k.startsWith('_tg_')) {
        result[k] = v
      }
    }
    const hso = result['hookSpecificOutput']
    if (typeof hso === 'object' && hso !== null && !('hookEventName' in hso)) {
      result['hookSpecificOutput'] = { hookEventName: '', ...hso }
    }
    return result
  }

  if (harness === 'gemini') {
    const out: HookResponse = {}
    const continueVal = response['continue'] ?? true
    out['decision'] = continueVal ? 'allow' : 'deny'

    const sysmsg = response['systemMessage']
    if (typeof sysmsg === 'string' && sysmsg) {
      out['systemMessage'] = sysmsg
    }

    const hso = response['hookSpecificOutput']
    if (typeof hso === 'object' && hso !== null) {
      const hsoDict = hso as Record<string, unknown>
      const addCtx = hsoDict['additionalContext']
      if (typeof addCtx === 'string' && addCtx) {
        out['hookSpecificOutput'] = { additionalContext: addCtx }
      }
      const reason = hsoDict['permissionDecisionReason']
      if (reason) {
        out['reason'] = reason
      }
    }

    for (const k of ['_tg_elapsed_ms', '_tg_handler', '_tg_error']) {
      if (k in response) {
        out[k] = response[k]
      }
    }
    return out
  }

  return response
}

/**
 * Decorator: wrap a hook handler to never raise or crash the harness.
 *
 * CRITICAL INVARIANT: A broken token-goat hook must NEVER interrupt Claude Code's work.
 * Guarantees:
 *   1. Returns `{ continue: true }` even if handler raises/crashes.
 *   2. Logs exception without surfacing it to the caller.
 *   3. Exits with code 0 (no error signal to harness).
 */
export function failSoft(
  handler: (payload: HookPayload) => HookResponse
): (payload: HookPayload) => HookResponse {
  return function wrapper(payload: HookPayload): HookResponse {
    try {
      return handler(payload)
    } catch (exc) {
      const err = exc instanceof Error ? exc : new Error(String(exc))

      if (err instanceof Error && (err.name === 'Error' || err.constructor.name === 'Error')) {
        const errSummary = `${err.name}: ${err.message}`
        _LOG.error('hook handler crashed: error=%s', errSummary, err)
      }

      return {
        continue: true,
        _tg_error: err instanceof Error ? err.message : String(err),
        _tg_handler: handler.name || 'unknown',
      }
    }
  }
}

/**
 * Run a hook event end-to-end with fail-soft semantics.
 *
 * Reads from stdin (or a file for testing), normalizes the payload, dispatches
 * through the handler registry, denormalizes the response, and writes to stdout.
 * Never throws—always returns normally even on catastrophic failures.
 */
export async function safeRun(
  event: string,
  inputFile: Buffer | string | null = null,
  harness: Harness = 'claude'
): Promise<void> {
  const result: HookResponse = { continue: true }
  try {
    let rawPayload: HookPayload
    if (inputFile !== null) {
      const raw = typeof inputFile === 'string' ? inputFile : inputFile.toString('utf8')
      const trimmed = raw.trim()
      if (!trimmed) {
        rawPayload = {}
      } else {
        try {
          rawPayload = JSON.parse(trimmed)
          if (typeof rawPayload !== 'object' || Array.isArray(rawPayload) || rawPayload === null) {
            rawPayload = {}
          }
        } catch {
          rawPayload = {}
        }
      }
    } else {
      rawPayload = await readStdin()
    }

    const normalized = normalizePayload(rawPayload, harness)
    const hookResult = await runHook({
      eventName: event as Parameters<typeof runHook>[0]['eventName'],
      toolName: (normalized['tool_name'] as string | undefined) || undefined,
      toolInput: (normalized['tool_input'] as Record<string, unknown>) || {},
      sessionId: (normalized['session_id'] as string) || '',
      raw: normalized,
    })

    const denormalized = denormalizeResponse(hookResult, harness, event)
    const json = JSON.stringify(denormalized)
    process.stdout.write(json)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    _LOG.error('safe_run failed: %s', msg, err)
    process.stdout.write(JSON.stringify(result))
  }
}

/**
 * Read all of stdin as UTF-8 text.
 * Returns empty dict if stdin is empty or unparseable.
 */
function readStdin(): Promise<HookPayload> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
    }
    const onEnd = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const data = JSON.parse(raw)
        resolve(typeof data === 'object' && !Array.isArray(data) ? data : {})
      } catch {
        resolve({})
      }
    }
    const onError = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      resolve({})
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
  })
}
