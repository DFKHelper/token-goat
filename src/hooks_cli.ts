/**
 * Harness payload normalization: translate harness-specific tool payloads to
 * token-goat's canonical internal shape before dispatch.
 *
 * Ports the payload-normalization slice of Python's hooks_cli.py. Response
 * denormalization and hook dispatch now live in relay.ts / hook_registry.ts.
 */
import { canonicalizeCopilotMcpToolName } from './copilot_mcp_names.js'

// All three levels are wired to console.error (stderr), never console.log/console.debug
// (stdout): `token-goat hook <event>` treats its own stdout as the wire protocol Claude
// Code parses byte-for-byte as JSON, so any diagnostic output landing on stdout corrupts
// the response. console.warn/console.error already default to stderr in Node, but
// console.debug defaults to *stdout* (the same stream as console.log) -- using it here
// silently prepended a debug line in front of the JSON response the moment this code path
// actually ran with a payload missing tool_name (see relay.ts's `relay()`: a payload that
// fails to parse as JSON now degrades to an empty object rather than aborting the whole
// hook call, so this branch became reachable for real where it previously wasn't).
const _LOG = {
  warn: (msg: string, ...args: unknown[]) => console.warn(`[hooks_cli] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => console.error(`[hooks_cli] ${msg}`, ...args),
  error: (msg: string, err?: unknown, ...args: unknown[]) =>
    console.error(`[hooks_cli] ${msg}`, ...(err ? [err] : []), ...args),
}

/**
 * Harness identifier: the Claude Code harness variant token-goat is running under.
 * Determines payload/response shape translation.
 */
export type Harness = 'claude' | 'codex' | 'copilot_cli' | 'gemini' | 'grok' | 'kimi' | 'qwen'

/**
 * Hook payload: unstructured dict from harness stdin.
 *
 * The raw shape is harness-specific (camelCase in Claude, snake_case in Codex/Gemini).
 * normalize_payload translates to internal PascalCase shape before dispatch.
 */
export type HookPayload = Record<string, unknown>

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
  // 'search_file_content' was GREP_TOOL_NAME's value before gemini-cli renamed it to 'grep_search' (confirmed against gemini-cli's current base-declarations.ts, which now defines GREP_TOOL_NAME = 'grep_search'; some of gemini-cli's own docs pages still lag the rename). Kept as a backward-compat entry for older installed gemini-cli versions that still emit the pre-rename name -- not dead/hallucinated, just legacy.
  search_file_content: 'Grep',
  // Gemini's real web-search tool is registered as 'google_web_search' (WEB_SEARCH_TOOL_NAME in gemini-cli's tool-names.ts) -- 'web_search' is not a tool name Gemini CLI ever emits, so the old entry here silently never matched a real invocation.
  google_web_search: 'WebFetch',
  web_fetch: 'WebFetch',
}

/**
 * Gemini tool_input key → internal key, per remapped tool.
 * Only keys that differ between Gemini and token-goat need to appear here.
 */
const GEMINI_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  // Gemini's real write_file/replace tool schemas already use 'file_path' (and replace's 'old_string'/'new_string') verbatim -- identical to token-goat's own canonical keys (see getFilePath() in hooks_common.ts, which reads event.toolInput['file_path']) -- confirmed against gemini-cli's own EditToolParams/WriteFileToolParams interfaces. No remap is needed for Write/Edit; the previous entries here actively renamed a key that was already correct (file_path -> path), which would have silently corrupted the path argument on every real Gemini Write/Edit call.
  // 'Read' covers THREE distinct raw Gemini tools (see GEMINI_TOOL_NAME_MAP above), and they do NOT share one schema: read_file already uses 'file_path' verbatim, no remap needed; list_directory uses 'dir_path' (confirmed against gemini-cli's LSToolParams) -- remapped to 'file_path' below, exactly mirroring Grep's existing dir_path->path fix; read_many_files uses 'include' (confirmed against gemini-cli's ReadManyFilesParams), an ARRAY of glob patterns, not a single file path -- there is no single string to remap it to, so it is deliberately left unmapped. getFilePath() (hooks_common.ts) will return undefined for this call, and preReadHandler/postReadHandler already fall back to passOutput() on an undefined path (see preReadHandler's `if (filePath === undefined) return passOutput()`), so a real read_many_files call still succeeds normally; it just doesn't get session-dedup tracking or read-count hints. Accepted limitation, not a bug to force-fit.
  Read: { dir_path: 'file_path' },
  // Grep's real tool (grep_search) calls its target-directory argument 'dir_path', which preReadHandler's Grep fallback (event.toolInput['path']) doesn't recognize, so that one remains remapped.
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
  // The grok 0.2.93 binary registers its shell tool as `tool.run_terminal_cmd` (tracing-id table in ~/.grok/bin/agent.exe) and its newer embedded hooks doc's PreToolUse example sends `"toolName": "run_terminal_cmd"`, while the older embedded doc revision and a 2026-07-09 live capture on the same version both show `run_terminal_command`. Which spelling arrives is profile/version dependent, so BOTH are mapped: an unmatched extra entry is a harmless no-op, a missing one silently kills every Bash hook (compression, wrap, hints) on that profile.
  run_terminal_cmd: 'Bash',
  grep: 'Grep',
  list_dir: 'Glob',
  // `glob` is a distinct registered grok tool (tool.glob in the 0.2.93 binary's tracing-id table), separate from list_dir; unmapped it arrived as lowercase 'glob' and matched no handler.
  glob: 'Glob',
  // web_fetch/web_search were entirely absent from this map, so grok's URL fetches bypassed token-goat's WebFetch pipeline (URL-policy deny included) and its searches bypassed the WebSearch dedup/compression. Verified against the 0.2.93 binary: tool.web_fetch / tool.web_search registered ids, grok_build WebFetchInput's field described as "The URL to fetch content from" (i.e. `url`), grok_build WebSearchInput's fields query/citations/allowed_domains -- all matching the keys hooks_fetch.ts / hooks_websearch.ts already read, so a name map alone revives both.
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  // The Hashline prompt profile registers hashline_read/hashline_edit/hashline_grep (tool.hashline_* in the binary; grok's own hook alias table pairs them with Read/Edit/Grep). Their input key shapes were not individually verified: if one differs, the mapped handler degrades to the same no-op as an unmapped name, never a wrong rewrite. The *_concise twins are the GrokBuildConcise profile's registrations of the same three core tools.
  hashline_read: 'Read',
  hashline_edit: 'Edit',
  hashline_grep: 'Grep',
  read_file_concise: 'Read',
  search_replace_concise: 'Edit',
  run_terminal_cmd_concise: 'Bash',
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
 * Kimi Code tool name -> internal PascalCase tool name.
 *
 * Kimi's built-in tool vocabulary (`docs/en/reference/tools.md` in
 * MoonshotAI/kimi-code) already matches token-goat's canonical names for
 * `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, and `WebSearch`, so those
 * need no entry here. Only the two that differ are mapped: Kimi calls its URL
 * fetcher `FetchURL` (Claude Code's `WebFetch`) and its image/video reader
 * `ReadMediaFile` (Claude Code reads media through `Read`). Kimi's `Agent`
 * tool is deliberately left unmapped: it is the sub-agent spawner, not Claude
 * Code's generic `Task`, and no handler in this codebase filters on it.
 */
const KIMI_TOOL_NAME_MAP: Record<string, string> = {
  FetchURL: 'WebFetch',
  ReadMediaFile: 'Read',
}

/**
 * Kimi tool_input key -> internal key, per remapped tool.
 *
 * Kimi's v2 tools name their path argument `path`, not Claude Code's
 * `file_path` (`ReadInputSchema` in
 * `packages/agent-core-v2/src/agent/tools/os/read/readTool.ts` reads
 * `args.path`; `packages/acp-server/src/events-map.ts` states "v2 tools use
 * `path`"). getFilePath() in hooks_common.ts reads `file_path`, so Read/Write/
 * Edit/ReadMediaFile need that rename or every path-scoped handler silently
 * sees no path at all. Grep and Glob already send `pattern`/`path`, the keys
 * their handlers read, and Bash already sends `command`, so none is remapped.
 */
const KIMI_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  // line_offset/n_lines are Kimi's Read paging arguments (ReadInputSchema in MoonshotAI/kimi-code packages/agent-core-v2/src/agent/tools/os/read/read.ts: `path`, `line_offset` "the line number to start reading from", `n_lines` "the number of lines to read"). Unmapped, every ranged Kimi read looked unbounded to hooks_read.ts's estimateRequestedSlice and was gated on the whole file's size -- a small slice of a big file could draw the large-file deny meant for full reads. line_offset's 1-indexed positive form matches Read's own offset semantics exactly; its negative tail-read form has no token-goat equivalent and is clamped to 1 by estimateRequestedSlice's `offset >= 1` guard, degrading to a window of the right SIZE (which is all the gate consumes). ReadMediaFile shares this map via its Read rename and carries only `path`, so the extra entries never touch it.
  Read: { path: 'file_path', line_offset: 'offset', n_lines: 'limit' },
  Write: { path: 'file_path' },
  Edit: { path: 'file_path' },
}

/**
 * Qwen Code runtime tool id → internal PascalCase tool name.
 *
 * Qwen Code's hook payloads carry the CANONICAL runtime tool id in `tool_name`
 * (coreToolScheduler.ts passes `canonicalToolName(request.name)` into
 * firePreToolUseHook/firePostToolUseHook, and toolHookTriggers.ts serializes it
 * verbatim), never the PascalCase display name. Ids from QwenLM/qwen-code's own
 * packages/core/src/tools/tool-names.ts (ToolNames plus the ToolNamesMigration
 * legacy aliases, which canonicalToolName resolves before the hook fires -- the
 * legacy spellings are mapped here anyway in case an older Qwen Code build
 * serializes them unresolved; an extra entry is a harmless no-op).
 *
 * Before this map existed, `token-goat install --qwen` wired hooks that FIRED
 * on every tool call (the settings entry uses a catch-all matcher) but never
 * DID anything: `--harness qwen` fell through harnessForNormalization()
 * (src/relay.ts) to 'claude', no rename happened, and a tool_name of
 * `read_file`/`run_shell_command`/... matched no registered handler. Every
 * tool-scoped mechanism -- re-read denial, image shrink, bash compression,
 * post-edit indexing, WebFetch policy, search dedup -- was silently dead on
 * Qwen while the passive events (pre_compact manifest, user_prompt_submit
 * hints) kept working, which is exactly what made the gap invisible.
 *
 * Unmapped on purpose: `agent` (and its `task` legacy alias) -- token-goat's
 * Agent handlers read `prompt`/`subagent_type`, and qwen's agent tool input
 * shape was not verified this pass; `read_many_files` uses an `include` glob
 * array (same reason the Gemini map leaves it alone); everything else in
 * ToolNames (todo_write, save_memory, lsp, cron_*, team_*, ...) has no
 * token-goat equivalent.
 */
const QWEN_TOOL_NAME_MAP: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit: 'Edit',
  replace: 'Edit',
  notebook_edit: 'NotebookEdit',
  run_shell_command: 'Bash',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  list_directory: 'Read',
}

/**
 * Qwen Code's tool_input keys are already token-goat's own canonical names for
 * every mapped tool except list_directory -- verified against qwen-code's own
 * param interfaces: read_file `file_path`/`offset`/`limit` (read-file.ts), edit
 * `file_path`/`old_string`/`new_string` (edit.ts), run_shell_command `command`
 * (shell.ts ShellToolParams), grep_search `pattern`/`path` (grep.ts), web_fetch
 * `url` (web-fetch.ts), web_search `query` (web-search.ts), notebook_edit
 * `notebook_path` (notebook-edit.ts; getFilePath() reads notebook_path
 * natively). list_directory's target is `path` (ls.ts LSToolParams -- NOT the
 * `dir_path` its Gemini CLI ancestor uses), remapped so getFilePath() sees it.
 * read_file carries no `path` key, so sharing the Read entry is safe.
 */
const QWEN_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  Read: { path: 'file_path' },
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
/**
 * Rename `tool_input`'s keys per `keyMap` (unmapped keys pass through
 * unchanged). Shared by the grok and gemini branches of
 * {@link normalizePayload}, which both remap select keys the same way once a
 * tool name has matched.
 */
function remapInputKeys(input: Record<string, unknown>, keyMap: Record<string, string>): Record<string, unknown> {
  const newInput: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    newInput[keyMap[k] || k] = v
  }
  return newInput
}

// Shared by the grok/gemini/kimi normalizePayload branches: all three rename tool_name via a
// per-harness map, then remap tool_input's keys via a second per-harness map.
//
// The input-key map is keyed off the EFFECTIVE tool name -- the renamed one when nameMap has an
// entry, otherwise the name the harness sent verbatim. Keying it off the rename alone would skip
// the case Kimi depends on: a tool whose name already matches token-goat's canonical spelling
// (`Read`) but whose path argument does not (`path`, not `file_path`). Callers whose harness never
// sends a canonical name are unaffected -- grok and gemini both send snake_case, so an unmapped
// name can never collide with their PascalCase input-key-map entries.
//
// `toolName` is guaranteed a non-empty string by normalizePayload's guard above, so assigning
// tool_name unconditionally is identical to assigning it only on a rename.
function remapToolName(
  obj: Record<string, unknown>,
  toolName: string,
  nameMap: Record<string, string>,
  inputKeyMap: Record<string, Record<string, string>>,
): Record<string, unknown> {
  const mapped = nameMap[toolName] ?? toolName
  const result = { ...obj }
  result['tool_name'] = mapped
  const rawInput = obj['tool_input']
  const keyMap = inputKeyMap[mapped]
  if (keyMap && typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)) {
    result['tool_input'] = remapInputKeys(rawInput as Record<string, unknown>, keyMap)
  }
  return result
}

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
    const result = remapToolName(obj, toolName, GROK_TOOL_NAME_MAP, GROK_INPUT_KEY_MAP)
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

  // Copilot CLI's shim (src/bridges/copilot_cli.ts) already remaps the built-ins it knows
  // (bash/powershell->Bash, view->Read, ...) and forwards everything else verbatim, so what
  // arrives here for an MCP call is Copilot's own `<server>-<tool>` spelling. Canonicalise it
  // to `mcp__<server>__<tool>` -- by exact match against Copilot's own tool cache only, never
  // by guessing from the name's shape -- so the MCP dedup/compression and repeat-screenshot
  // handlers, all of which gate on that prefix, stop being dead code on Copilot. A name with
  // no cache entry (including every built-in) passes through untouched.
  if (harness === 'copilot_cli') {
    const result = { ...obj }
    result['tool_name'] = canonicalizeCopilotMcpToolName(toolName)
    result['_tg_harness'] = harness
    return result
  }

  if (harness === 'kimi') {
    const result = remapToolName(obj, toolName, KIMI_TOOL_NAME_MAP, KIMI_INPUT_KEY_MAP)
    result['_tg_harness'] = harness
    return result
  }

  if (harness === 'qwen') {
    const result = remapToolName(obj, toolName, QWEN_TOOL_NAME_MAP, QWEN_INPUT_KEY_MAP)
    // Qwen's PostToolUse tool_response is `{llmContent, returnDisplay}` (coreToolScheduler.ts builds it, toolHookTriggers.ts serializes it verbatim) -- neither key is in OUTPUT_FIRST/BODY_FIRST_TOOL_RESPONSE_KEYS (hooks_common.ts), so every post handler that measures or compresses the result saw an empty string. Add `output` (the first key both lists read) ALONGSIDE the originals rather than renaming, the same safe direction as every other inbound key fix. llmContent is a PartListUnion upstream; only the plain-string case is representable here, and a non-string llmContent falls through untouched.
    const toolResponse = result['tool_response']
    if (toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
      const responseRecord = toolResponse as Record<string, unknown>
      if (typeof responseRecord['llmContent'] === 'string' && responseRecord['output'] === undefined) {
        result['tool_response'] = { ...responseRecord, output: responseRecord['llmContent'] }
      }
    }
    result['_tg_harness'] = harness
    return result
  }

  if (harness === 'gemini') {
    const result = remapToolName(obj, toolName, GEMINI_TOOL_NAME_MAP, GEMINI_INPUT_KEY_MAP)
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
