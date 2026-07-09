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
export type Harness = 'claude' | 'codex' | 'gemini' | 'grok'

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
export const GEMINI_TOOL_NAME_MAP: Record<string, string> = {
  run_shell_command: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  list_directory: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  glob: 'Glob',
  grep_search: 'Grep',
  // 'search_file_content' was GREP_TOOL_NAME's value before gemini-cli
  // renamed it to 'grep_search' (confirmed against gemini-cli's current
  // base-declarations.ts, which now defines GREP_TOOL_NAME = 'grep_search';
  // some of gemini-cli's own docs pages still lag the rename). Kept as a
  // backward-compat entry for older installed gemini-cli versions that still
  // emit the pre-rename name -- not dead/hallucinated, just legacy.
  search_file_content: 'Grep',
  // Gemini's real web-search tool is registered as 'google_web_search'
  // (WEB_SEARCH_TOOL_NAME in gemini-cli's tool-names.ts) -- 'web_search' is
  // not a tool name Gemini CLI ever emits, so the old entry here silently
  // never matched a real invocation.
  google_web_search: 'WebFetch',
  web_fetch: 'WebFetch',
}

/**
 * Gemini tool_input key → internal key, per remapped tool.
 * Only keys that differ between Gemini and token-goat need to appear here.
 */
const GEMINI_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  // Gemini's real write_file/replace tool schemas already use 'file_path'
  // (and replace's 'old_string'/'new_string') verbatim -- identical to
  // token-goat's own canonical keys (see getFilePath() in hooks_common.ts,
  // which reads event.toolInput['file_path']) -- confirmed against
  // gemini-cli's own EditToolParams/WriteFileToolParams interfaces. No remap
  // is needed for Write/Edit; the previous entries here actively renamed a
  // key that was already correct (file_path -> path), which would have
  // silently corrupted the path argument on every real Gemini Write/Edit call.
  //
  // 'Read' covers THREE distinct raw Gemini tools (see GEMINI_TOOL_NAME_MAP
  // above), and they do NOT share one schema:
  //   - read_file: already uses 'file_path' verbatim, no remap needed.
  //   - list_directory: uses 'dir_path' (confirmed against gemini-cli's
  //     LSToolParams) -- remapped to 'file_path' below, exactly mirroring
  //     Grep's existing dir_path->path fix.
  //   - read_many_files: uses 'include' (confirmed against gemini-cli's
  //     ReadManyFilesParams), an ARRAY of glob patterns, not a single file
  //     path -- there is no single string to remap it to, so it is
  //     deliberately left unmapped. getFilePath() (hooks_common.ts) will
  //     return undefined for this call, and preReadHandler/postReadHandler
  //     already fall back to passOutput() on an undefined path (see
  //     preReadHandler's `if (filePath === undefined) return passOutput()`),
  //     so a real read_many_files call still succeeds normally; it just
  //     doesn't get session-dedup tracking or read-count hints. Accepted
  //     limitation, not a bug to force-fit.
  Read: { dir_path: 'file_path' },
  //
  // Grep's real tool (grep_search) calls its target-directory argument
  // 'dir_path', which preReadHandler's Grep fallback
  // (event.toolInput['path']) doesn't recognize, so that one remains remapped.
  Grep: { dir_path: 'path' },
}

/**
 * Grok CLI tool name -> internal PascalCase tool name.
 *
 * Confirmed empirically (2026-07-09) against grok 0.2.93: `grok inspect`
 * reports "claude" as a supported Harness Compatibility target, and grok
 * genuinely executes the *global* `~/.claude/settings.json` hooks config
 * (not any project-local .claude/settings.json -- a project-scoped
 * settings.json never fired; `grok inspect` reported "Project: (none)" even
 * with one present in the working directory). Verified by patching a
 * diagnostic hook alongside the real `token-goat hook pre_tool_use` /
 * `token-goat hook post_tool_use` commands already registered there and
 * inspecting the literal stdin JSON grok sent for each of Read/Write/Edit/
 * Bash/Grep/list-directory tool calls.
 */
const GROK_TOOL_NAME_MAP: Record<string, string> = {
  read_file: 'Read',
  write: 'Write',
  search_replace: 'Edit',
  run_terminal_command: 'Bash',
  grep: 'Grep',
  list_dir: 'Glob',
}

/**
 * Grok tool_input key -> internal key, per remapped tool.
 *
 * Confirmed alongside GROK_TOOL_NAME_MAP above: write/search_replace/
 * run_terminal_command/grep already send token-goat's own canonical
 * argument key names verbatim (file_path/content, file_path/old_string/
 * new_string, command, pattern/path) -- only read_file's `target_file`
 * needs remapping to `file_path` (getFilePath() in hooks_common.ts).
 * list_dir's `target_directory` is left unmapped: unlike Grep, no handler in
 * this codebase currently reads Glob's tool_input by key at all, so there is
 * nothing for a remap to fix yet.
 */
const GROK_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  Read: { target_file: 'file_path' },
}

/**
 * Translate grok's camelCase wire keys (toolName/toolInput/sessionId) to the
 * snake_case shape the rest of normalizePayload expects, and unwrap
 * post_tool_use's tagged `toolResult` object into the `tool_response` shape
 * extractBashOutput/extractReadOutput (hooks_bash.ts/hooks_read.ts) already
 * know how to read (a string, or an object with an 'output'/'content'/
 * 'text'/'body' string key). Unlike Codex/Gemini, grok's entire wire payload
 * is camelCase, not just its tool-name vocabulary -- `toolName`/`toolInput`/
 * `sessionId`, never `tool_name`/`tool_input`/`session_id` -- confirmed via
 * the same live capture as GROK_TOOL_NAME_MAP above. run_terminal_command's
 * `toolResult` carries a ready-made `output_for_prompt` string plus a real
 * `exit_code` number, both pulled through directly; other tools' toolResult
 * keys are dynamic and PascalCase (`Content`/`FileContent`/`EditsApplied`,
 * confirmed for list_dir/read_file/search_replace respectively). Rather than
 * hard-code every one of those (and go stale the next time grok renames a
 * field, exactly as happened to Gemini's grep_search rename above), the
 * first string-valued field other than 'type' is used as a best-effort
 * 'content' value.
 */
function grokToCanonicalWire(obj: Record<string, unknown>): Record<string, unknown> {
  const wire = { ...obj }
  if (typeof wire['toolName'] === 'string' && wire['tool_name'] === undefined) {
    wire['tool_name'] = wire['toolName']
  }
  if (
    typeof wire['toolInput'] === 'object' &&
    wire['toolInput'] !== null &&
    !Array.isArray(wire['toolInput']) &&
    wire['tool_input'] === undefined
  ) {
    wire['tool_input'] = wire['toolInput']
  }
  if (typeof wire['sessionId'] === 'string' && wire['session_id'] === undefined) {
    wire['session_id'] = wire['sessionId']
  }

  const toolResult = wire['toolResult']
  if (toolResult !== null && typeof toolResult === 'object' && !Array.isArray(toolResult)) {
    const tr = toolResult as Record<string, unknown>
    if (typeof tr['output_for_prompt'] === 'string') {
      wire['tool_response'] = { content: tr['output_for_prompt'], exit_code: tr['exit_code'] }
    } else {
      const firstString = Object.entries(tr).find(([k, v]) => k !== 'type' && typeof v === 'string')
      if (firstString) {
        wire['tool_response'] = { content: firstString[1] }
      }
    }
  }

  return wire
}

/**
 * Translate harness-specific payload to internal format.
 *
 * Codex sends snake_case tool names; Claude uses PascalCase.
 * Gemini sends snake_case tool names and may use functionCallId instead of toolUseId.
 * Grok sends an entirely camelCase wire payload with its own tool-name vocabulary.
 *
 * Returns an empty dict on validation failures (non-dict, empty, missing tool_name)
 * so handlers degrade gracefully.
 */
export function normalizePayload(payload: unknown, harness: Harness = 'claude'): HookPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    _LOG.warn('normalizePayload: payload is not a dict; received %s', typeof payload)
    return {}
  }

  const rawObj = payload as Record<string, unknown>
  const obj = harness === 'grok' ? grokToCanonicalWire(rawObj) : rawObj
  const toolName = obj['tool_name']
  if (typeof toolName !== 'string' || !toolName.trim()) {
    _LOG.debug('normalizePayload: tool_name missing or invalid; received %s', toolName)
    return {}
  }

  if (harness === 'grok') {
    const mapped = GROK_TOOL_NAME_MAP[toolName]
    const result = { ...obj }
    if (mapped) {
      result['tool_name'] = mapped
      const rawInput = obj['tool_input']
      if (typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)) {
        const keyMap = GROK_INPUT_KEY_MAP[mapped]
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
    result['_tg_harness'] = harness
    return result
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
