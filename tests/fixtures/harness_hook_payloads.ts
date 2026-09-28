/** Provenance: each case below names its own source in `provenance`. Hook stdin payloads for the five harnesses that run a token-goat Node shim, one set per event each installer wires, for tests/native_hook_adapter_equivalence.test.ts. FORMAT-DERIVED cases take their key names from the harness's own published schema or source, cited per case; CAPTURE cases reuse shapes an earlier test recorded off a live harness; HAND-DERIVED cases are edge inputs (malformed, oversized, an unknown event) that make no claim about any harness's wire format. Values are filler unless a case says otherwise: the keys are what is load-bearing. `{{PROJ}}` is replaced with the test's project directory and `{{SID}}` with a session id unique to each run. */

export type PayloadHarness = 'claudecode' | 'codex' | 'grok' | 'kimi' | 'copilot_cli'

export interface HookPayloadCase {
  name: string
  harness: PayloadHarness
  /** The event argument the harness command is run with. */
  event: string
  /** The stdin payload as JSON, or `raw` for stdin that is not JSON. */
  payload?: unknown
  raw?: string
  /** Environment the harness sets on its hook process, beyond the test's own. */
  env?: Record<string, string>
  /** How many times the call is made in one session (default 1), for behaviour that answers only on a repeat; every answer is compared. */
  repeat?: number
  provenance: string
}

const CC_DOC = 'FORMAT-DERIVED: https://code.claude.com/docs/en/hooks.md, fetched 2026-09-25, the JSON input example under this event'
const CC_BASH_CAPTURE = 'CAPTURE: Bash tool_response { stdout, stderr, interrupted, isImage, noOutputExpected } recorded off real Claude Code traffic (tests/hooks_real_harness_payload_shape.test.ts), in the envelope of https://code.claude.com/docs/en/hooks.md PostToolUse'
const CODEX_DOC = 'FORMAT-DERIVED: https://developers.openai.com/codex/hooks.md, fetched 2026-09-25, "Common input fields" plus this event\'s table; tool_name "Bash" is CAPTURE, codex-cli 0.155.0 (tests/install_codex.test.ts)'
const GROK_DOC = 'FORMAT-DERIVED: the hooks doc embedded in grok 0.2.93 (~/.grok/bin/agent.exe, "Writing Hook Scripts > Input"): camelCase hookEventName, sessionId, cwd, workspaceRoot, timestamp'
const GROK_CAPTURE = 'CAPTURE: grok 0.2.93 live camelCase tool payloads (tests/hooks_cli.test.ts, grok harness), in the envelope of the hooks doc embedded in ~/.grok/bin/agent.exe'
const KIMI_SRC = 'FORMAT-DERIVED: MoonshotAI/kimi-code at be7d5f5f, docs/en/customization/hooks.md "Event Data Format" (hook_event_name, session_id, session_title, client_type, cwd) and packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts, whose camelCase fields internal/matchHooks.ts toHookInputData snake-cases'
const COPILOT_SCHEMA = 'FORMAT-DERIVED: schemas/copilot_cli.hooks.json, extracted from Copilot CLI 1.0.80 types.d.ts, this event\'s *HookInput interface'
const COPILOT_TOOLARGS = 'FORMAT-DERIVED: schemas/copilot_cli.hooks.json PreToolUseHookInput; toolArgs as a JSON string per https://docs.github.com/en/copilot/reference/hooks-reference ("toolArgs": "{\\"command\\":...}")'
const VSCODE = 'FORMAT-DERIVED: VS Code 1.136.0 ChatHookService.executePreToolUseHook envelope and copilot_readFile inputSchema (tests/wire_format_contract_matrix.test.ts), which VS Code sends to the same Copilot hooks file'
const EDGE = 'HAND-DERIVED: an edge input, no wire-format claim'

/** A Bash command token-goat's pre-tool pipeline redirects to its own CLI, so the relay answers with a block (tests/hook_server.test.ts bashDenyPayload). */
const DENIED_COMMAND = 'find . -name "*.ts" | xargs grep -l TokenGoat'

const ccBase = { session_id: '{{SID}}', transcript_path: '{{PROJ}}/transcript.jsonl', cwd: '{{PROJ}}', permission_mode: 'default' }
const codexBase = { session_id: '{{SID}}', transcript_path: null, cwd: '{{PROJ}}', model: 'gpt-5.5', turn_id: 'turn-1', permission_mode: 'default' }
const grokBase = { sessionId: '{{SID}}', cwd: '{{PROJ}}', workspaceRoot: '{{PROJ}}', timestamp: '2026-04-14T12:00:00Z' }
const kimiBase = { session_id: '{{SID}}', session_title: 'Fix the login page', client_type: 'kimi_code_cli', cwd: '{{PROJ}}' }
const copilotBase = { sessionId: '{{SID}}', timestamp: '2026-08-23T00:00:00.000Z', workingDirectory: '{{PROJ}}' }

const bashResponse = (stdout: string): Record<string, unknown> => ({ stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false })

export const HARNESS_HOOK_PAYLOADS: readonly HookPayloadCase[] = [
  // Claude Code
  { name: 'Bash command', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run test suite', timeout: 120000, run_in_background: false }, tool_use_id: 'toolu_01ABC123' } },
  { name: 'Bash command token-goat redirects (block)', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: DENIED_COMMAND }, tool_use_id: 'toolu_01ABC124' } },
  { name: 'own token-goat command (bypass)', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd {{PROJ}} && token-goat symbol relayInProcess' }, tool_use_id: 'toolu_01ABC125' } },
  { name: 'Bash reading a whole markdown file', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat {{PROJ}}/notes.md' }, tool_use_id: 'toolu_01ABC134' } },
  { name: 'Write', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '{{PROJ}}/src/index.ts', content: 'export const a = 1\n' }, tool_use_id: 'toolu_01ABC126' } },
  { name: 'Read of a project file', harness: 'claudecode', event: 'pre_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '{{PROJ}}/notes.md' }, tool_use_id: 'toolu_01ABC127' } },
  { name: 'Write of a .ts file (async detach)', harness: 'claudecode', event: 'post_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '{{PROJ}}/src/app.ts', content: 'file content' }, tool_response: { filePath: '{{PROJ}}/src/app.ts', type: 'create' }, tool_use_id: 'toolu_01ABC128', duration_ms: 12 } },
  { name: 'Write of a .md file (no detach)', harness: 'claudecode', event: 'post_tool_use', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '{{PROJ}}/notes.md', content: '# Title\n' }, tool_response: { filePath: '{{PROJ}}/notes.md', type: 'update' }, tool_use_id: 'toolu_01ABC129', duration_ms: 12 } },
  { name: 'short Bash result (async detach)', harness: 'claudecode', event: 'post_tool_use', provenance: CC_BASH_CAPTURE, payload: { ...ccBase, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: bashResponse('hi\n'), tool_use_id: 'toolu_01ABC130' } },
  { name: 'long Bash result (no detach)', harness: 'claudecode', event: 'post_tool_use', provenance: CC_BASH_CAPTURE, payload: { ...ccBase, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: bashResponse(Array.from({ length: 40 }, (_, i) => ` PASS  tests/case_${i}.test.ts (${i + 3} tests)`).join('\n')), tool_use_id: 'toolu_01ABC131' } },
  { name: 'oversize Bash result', harness: 'claudecode', event: 'post_tool_use', provenance: `${CC_BASH_CAPTURE}; the 3 MB of output is ${EDGE}`, payload: { ...ccBase, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat big.log' }, tool_response: bashResponse('line of a large log file\n'.repeat(128 * 1024)), tool_use_id: 'toolu_01ABC132' } },
  { name: 'Bash failure', harness: 'claudecode', event: 'post_tool_use_failure', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run test suite' }, tool_use_id: 'toolu_01ABC133', error: "Exit code 1\nError: Cannot find module 'express'", is_interrupt: false, duration_ms: 4187 } },
  { name: 'manual compaction', harness: 'claudecode', event: 'pre_compact', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null } },
  { name: 'after compaction', harness: 'claudecode', event: 'post_compact', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 'Summary of the compacted conversation...' } },
  { name: 'prompt', harness: 'claudecode', event: 'user_prompt_submit', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'UserPromptSubmit', prompt: 'Write a function to calculate the factorial of a number' } },
  { name: 'subagent finished (async detach)', harness: 'claudecode', event: 'subagent_stop', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'def456', agent_type: 'Explore', agent_transcript_path: '{{PROJ}}/agent-def456.jsonl', last_assistant_message: 'Analysis complete. Found 3 potential issues...', background_tasks: [], session_crons: [] } },
  { name: 'resumed session', harness: 'claudecode', event: 'session_start', provenance: CC_DOC, payload: { ...ccBase, hook_event_name: 'SessionStart', source: 'resume', model: 'claude-opus-5', seconds_since_last_response: 5400, context_tokens: 182340, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.1396 } },
  { name: 'unknown event', harness: 'claudecode', event: 'bogus_event', provenance: EDGE, payload: { ...ccBase, hook_event_name: 'Bogus' } },
  { name: 'truncated JSON', harness: 'claudecode', event: 'pre_tool_use', provenance: EDGE, raw: '{"session_id": "{{SID}}", "tool_name": "Bash", "tool_input": {"command": ' },
  { name: 'payload behind a byte order mark', harness: 'claudecode', event: 'pre_tool_use', provenance: `${CC_DOC}; the leading U+FEFF is ${EDGE}`, raw: '\uFEFF{"session_id": "{{SID}}", "cwd": "{{PROJ}}", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "find . -name \\"*.ts\\" | xargs grep -l TokenGoat"}}' },

  // Codex CLI
  { name: 'Bash command', harness: 'codex', event: 'pre_tool_use', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' } } },
  { name: 'Bash command token-goat redirects (block)', harness: 'codex', event: 'pre_tool_use', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_2', tool_input: { command: DENIED_COMMAND } } },
  { name: 'Bash reading a whole markdown file', harness: 'codex', event: 'pre_tool_use', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_5', tool_input: { command: 'cat {{PROJ}}/notes.md' } } },
  { name: 'apply_patch', harness: 'codex', event: 'pre_tool_use', provenance: `${CODEX_DOC}; tool_name "apply_patch" is CAPTURE, codex-cli 0.155.0 (tests/install_codex.test.ts)`, payload: { ...codexBase, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'call_3', tool_input: { command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch\n' } } },
  { name: 'Bash result', harness: 'codex', event: 'post_tool_use', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_4', tool_input: { command: 'echo hi' }, tool_response: 'hi\n' } },
  { name: 'compaction', harness: 'codex', event: 'pre_compact', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'PreCompact', trigger: 'auto' } },
  { name: 'prompt', harness: 'codex', event: 'user_prompt_submit', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the parser' } },
  { name: 'subagent finished', harness: 'codex', event: 'subagent_stop', provenance: CODEX_DOC, payload: { ...codexBase, hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'default', agent_transcript_path: null, stop_hook_active: false, last_assistant_message: 'Done.' } },
  { name: 'unknown event', harness: 'codex', event: 'bogus_event', provenance: EDGE, payload: { ...codexBase, hook_event_name: 'Bogus' } },

  // Grok CLI
  { name: 'run_terminal_command', harness: 'grok', event: 'pre_tool_use', provenance: GROK_DOC, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'pre_tool_use', toolName: 'run_terminal_command', toolInput: { command: 'npm test' } } },
  { name: 'run_terminal_command token-goat redirects (deny, exit 2)', harness: 'grok', event: 'pre_tool_use', provenance: GROK_DOC, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'pre_tool_use', toolName: 'run_terminal_command', toolInput: { command: DENIED_COMMAND } } },
  { name: 'read_file', harness: 'grok', event: 'pre_tool_use', provenance: GROK_CAPTURE, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'pre_tool_use', toolName: 'read_file', toolInput: { target_file: '{{PROJ}}/notes.md' } } },
  { name: 'run_terminal_command result', harness: 'grok', event: 'post_tool_use', provenance: GROK_CAPTURE, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'post_tool_use', toolName: 'run_terminal_command', toolInput: { command: 'echo hi' }, toolResult: { type: 'Bash', output_for_prompt: 'exit: 0\nhi\n', exit_code: 0, command: 'echo hi' } } },
  { name: 'read_file result', harness: 'grok', event: 'post_tool_use', provenance: GROK_CAPTURE, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'post_tool_use', toolName: 'read_file', toolInput: { target_file: '{{PROJ}}/notes.md' }, toolResult: { type: 'FileContent', FileContent: '# Title\n' } } },
  { name: 'compaction', harness: 'grok', event: 'pre_compact', provenance: GROK_DOC, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'pre_compact' } },
  { name: 'prompt', harness: 'grok', event: 'user_prompt_submit', provenance: GROK_DOC, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'user_prompt_submit' } },
  { name: 'subagent finished', harness: 'grok', event: 'subagent_stop', provenance: GROK_DOC, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'subagent_stop' } },
  { name: 'session_start, an event Grok\'s shim does not accept', harness: 'grok', event: 'session_start', provenance: `${GROK_DOC}; event choice is ${EDGE}`, env: { GROK_SESSION_ID: '{{SID}}' }, payload: { ...grokBase, hookEventName: 'session_start' } },
  { name: 'truncated JSON', harness: 'grok', event: 'pre_tool_use', provenance: EDGE, env: { GROK_SESSION_ID: '{{SID}}' }, raw: '{"sessionId": "{{SID}}", "toolName": ' },

  // Kimi Code
  { name: 'Bash command', harness: 'kimi', event: 'pre_tool_use', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_call_id: 'tc-1' } },
  { name: 'Bash command token-goat redirects (deny)', harness: 'kimi', event: 'pre_tool_use', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: DENIED_COMMAND }, tool_call_id: 'tc-2' } },
  { name: 'Read', harness: 'kimi', event: 'pre_tool_use', provenance: `${KIMI_SRC}; Read's path/line_offset/n_lines from packages/agent-core-v2 read.ts ReadInputSchema (tests/hooks_cli.test.ts)`, payload: { ...kimiBase, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { path: '{{PROJ}}/notes.md', line_offset: 1, n_lines: 20 }, tool_call_id: 'tc-3' } },
  { name: 'Bash result', harness: 'kimi', event: 'post_tool_use', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_call_id: 'tc-4', tool_output: 'hi\n' } },
  { name: 'compaction', harness: 'kimi', event: 'pre_compact', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'PreCompact', trigger: 'auto' } },
  { name: 'prompt', harness: 'kimi', event: 'user_prompt_submit', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login page' } },
  { name: 'subagent finished', harness: 'kimi', event: 'subagent_stop', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'SubagentStop' } },
  { name: 'session start', harness: 'kimi', event: 'session_start', provenance: KIMI_SRC, payload: { ...kimiBase, hook_event_name: 'SessionStart', source: 'startup', model: 'kimi-k2', profile: 'default' } },
  { name: 'unknown event', harness: 'kimi', event: 'bogus_event', provenance: EDGE, payload: { ...kimiBase, hook_event_name: 'Bogus' } },

  // Copilot CLI
  { name: 'bash command (toolArgs as a JSON string)', harness: 'copilot_cli', event: 'preToolUse', provenance: COPILOT_TOOLARGS, payload: { ...copilotBase, toolName: 'bash', toolArgs: '{"command":"npm test", "description":"Run tests"}' } },
  { name: 'bash command token-goat redirects (deny)', harness: 'copilot_cli', event: 'preToolUse', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, toolName: 'bash', toolArgs: { command: DENIED_COMMAND } } },
  { name: 'bash deny with toolArgs as a JSON string', harness: 'copilot_cli', event: 'preToolUse', provenance: COPILOT_TOOLARGS, payload: { ...copilotBase, toolName: 'bash', toolArgs: JSON.stringify({ command: DENIED_COMMAND }) } },
  { name: 'powershell, remapped to Bash', harness: 'copilot_cli', event: 'preToolUse', provenance: `${COPILOT_SCHEMA}; the powershell tool name from the shim's cited @github/copilot-sdk tool list`, payload: { ...copilotBase, toolName: 'powershell', toolArgs: { command: DENIED_COMMAND } } },
  { name: 'view, remapped to Read with path to file_path', harness: 'copilot_cli', event: 'preToolUse', provenance: `${COPILOT_SCHEMA}; view's path argument per the shim's cited @github/copilot-sdk tool list`, payload: { ...copilotBase, toolName: 'view', toolArgs: { path: '{{PROJ}}/notes.md', view_range: [1, 20] } } },
  { name: 'view result', harness: 'copilot_cli', event: 'postToolUse', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, toolName: 'view', toolArgs: { path: '{{PROJ}}/notes.md' }, toolResult: { resultType: 'success', textResultForLlm: '# Title\n\nintro\n' } } },
  { name: 'tool failure', harness: 'copilot_cli', event: 'postToolUseFailure', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, toolName: 'bash', toolArgs: { command: 'nope' }, error: 'command not found: nope' } },
  { name: 'the same bash failure twice (repeat notice)', harness: 'copilot_cli', event: 'postToolUseFailure', repeat: 2, provenance: `${COPILOT_SCHEMA} (PostToolUseFailureHookInput: toolName, toolArgs, error); the error text is filler`, payload: { ...copilotBase, toolName: 'bash', toolArgs: { command: 'npm run lint' }, error: 'npm ERR! Missing script: "lint"' } },
  { name: 'edit failure (old_str not found)', harness: 'copilot_cli', event: 'postToolUseFailure', provenance: `${COPILOT_SCHEMA} (PostToolUseFailureHookInput); edit's path/old_str/new_str arguments per the shim's cited @github/copilot-sdk tool list`, payload: { ...copilotBase, toolName: 'edit', toolArgs: { path: '{{PROJ}}/notes.md', old_str: 'alpha bodyy', new_str: 'alpha body' }, error: 'No match found for old_str in notes.md' } },
  { name: 'prompt', harness: 'copilot_cli', event: 'userPromptSubmitted', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, prompt: 'summarize the failing test' } },
  { name: 'session start', harness: 'copilot_cli', event: 'sessionStart', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, source: 'new', initialPrompt: 'fix the build' } },
  { name: 'agent stop', harness: 'copilot_cli', event: 'agentStop', provenance: COPILOT_SCHEMA, payload: { ...copilotBase, stopReason: 'end_turn', stopHookActive: false } },
  { name: 'subagent stop', harness: 'copilot_cli', event: 'subagentStop', provenance: `FORMAT-DERIVED: schemas/copilot_cli.hooks.json BaseHookInput fields (sessionId, timestamp, workingDirectory); the manifest has no subagentStop interface`, payload: { ...copilotBase } },
  { name: 'subagent start', harness: 'copilot_cli', event: 'subagentStart', provenance: 'CAPTURE: tests/fixtures/copilot_cli_1_0_88/C4a-005-subagentStart.json (Copilot CLI 1.0.88, tg-captures C4a/raw/005-subagentStart.json); ids and paths replaced by placeholders', payload: { sessionId: '{{SID}}', timestamp: 1790610897316, cwd: '{{PROJ}}', agentName: 'explore', traceparent: '00-adb58fda9d02a69a53e30dd323c20b4b-2c0262e3f4da9cb6-01' } },
  { name: 'VS Code SubagentStart through the Copilot hooks file', harness: 'copilot_cli', event: 'SubagentStart', provenance: 'FORMAT-DERIVED: VS Code 1.137.0 extensions/copilot/dist/extension.js runStartHooks executeSubagentStartHook({agent_id, agent_type}) plus ChatHookService.executeHook envelope {timestamp, hook_event_name, session_id, cwd}', payload: { timestamp: '2026-09-28T00:00:00.000Z', hook_event_name: 'SubagentStart', session_id: '{{SID}}', cwd: '{{PROJ}}', agent_id: 'subagent-invocation-1', agent_type: 'Explore' } },
  { name: 'compaction', harness: 'copilot_cli', event: 'preCompact', provenance: `FORMAT-DERIVED: schemas/copilot_cli.hooks.json BaseHookInput fields; the manifest has no preCompact interface`, payload: { ...copilotBase } },
  { name: 'VS Code read_file through the Copilot hooks file', harness: 'copilot_cli', event: 'preToolUse', provenance: VSCODE, payload: { timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: 'PreToolUse', session_id: '{{SID}}', cwd: '{{PROJ}}', tool_name: 'read_file', tool_input: { filePath: '{{PROJ}}/notes.md', startLine: 1, endLine: 2000 }, tool_use_id: 'tu-1' } },
  { name: 'unknown event', harness: 'copilot_cli', event: 'notAnEvent', provenance: EDGE, payload: { ...copilotBase } },
  { name: 'malformed JSON', harness: 'copilot_cli', event: 'preToolUse', provenance: EDGE, raw: '{"sessionId": "{{SID}}", "toolName": "bash", ' },
]
