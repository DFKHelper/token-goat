/**
 * Harness payload normalization: translate harness-specific tool payloads to
 * token-goat's canonical internal shape before dispatch.
 *
 * Ports the payload-normalization slice of Python's hooks_cli.py. Response
 * denormalization and hook dispatch now live in relay.ts / hook_registry.ts.
 */

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
  apply_patch: 'Edit',
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
  Read: { file_path: 'path' },
  Write: { file_path: 'path' },
  Edit: { file_path: 'path', old_string: 'old_str', new_string: 'new_str' },
  Grep: { pattern: 'query' },
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
