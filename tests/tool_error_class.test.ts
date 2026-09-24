import { describe, expect, it } from 'vitest'

import { classifyToolError, errorPrefix, ERROR_PREFIX_CHARS, EXPECTED_REASONS, unwrapToolError, UNKNOWN_REASON, type ToolErrorFlags } from '../src/tool_error_class.js'

interface Case {
  readonly reason: string
  readonly tool: string
  readonly text: string
  readonly flags?: ToolErrorFlags
}

// CAPTURE: the shortest real `is_error` tool_result per reason from the local Claude Code transcript corpus census (2026-09-24, 3,692 transcripts, Claude Code 2.1.x), text verbatim and the Bash command read from the paired tool_use input; the two long harness messages are cut at a sentence boundary.
const CENSUS_CASES: readonly Case[] = [
  { reason: 'auto_mode_blocked', tool: 'mcp__claude-in-chrome__navigate', text: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [External System Writes].', flags: { denialKind: 'automode-blocked' } },
  { reason: 'command_not_found', tool: 'Bash', text: 'Exit code 127\nbash: line 1: node: command not found', flags: { command: "wsl -e bash -lc 'node --version' 2>&1" } },
  { reason: 'command_timeout', tool: 'Bash', text: 'Exit code 143\nCommand timed out after 2s', flags: { command: 'sleep 1' } },
  { reason: 'edit_multiple_matches', tool: 'Edit', text: '<tool_use_error>Found 8 matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ### Fixed\n</tool_use_error>' },
  { reason: 'edit_string_not_found', tool: 'Edit', text: "<tool_use_error>String to replace not found in file.\nString: const ctrl = ''</tool_use_error>" },
  { reason: 'file_modified_since_read', tool: 'Edit', text: '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>' },
  { reason: 'file_not_read_yet', tool: 'Edit', text: '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>' },
  { reason: 'file_too_large', tool: 'Read', text: 'File content (895KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.' },
  { reason: 'hook_deny', tool: 'Read', text: 'Generated/build artifact — read the source file instead.', flags: { denialKind: 'permission-rule' } },
  { reason: 'input_validation', tool: 'Read', text: '<tool_use_error>InputValidationError: Read failed due to the following issue:\nAn unexpected parameter `limter` was provided</tool_use_error>' },
  { reason: 'path_not_found', tool: 'Read', text: 'File does not exist. Note: your current working directory is C:\\Projects\\token-goat.' },
  { reason: 'schema_mismatch', tool: 'StructuredOutput', text: 'Output does not match required schema: root: must NOT have additional properties' },
  { reason: 'script_exception', tool: 'Bash', text: 'Exit code 1\nTraceback (most recent call last):\r\n  File "<stdin>", line 8, in <module>\r\nAssertionError' },
  { reason: 'script_exception', tool: 'Bash', text: "Exit code 1\nC:\\Projects\\token-goat\\node_modules\\exceljs\\lib\\xlsx\\xlsx.js:51\r\n      throw new Error(`File not found: ${filename}`);\r\n            ^\r\n\r\nError: File not found: /c/Projects/_tg-df-2/work/sample.xlsx\r\n    at XLSX.readFile (C:\\Projects\\token-goat\\node_modules\\exceljs\\lib\\xlsx\\xlsx.js:51:13)\r\n    at async [eval]:5:3\r\n\r\nNode.js v24.12.0" },
  { reason: 'search_no_match', tool: 'Bash', text: 'Exit code 1', flags: { command: 'rg "COPILOT_AGENTS_HOME"' } },
  { reason: 'shell_syntax_error', tool: 'Bash', text: 'Exit code 2\n/usr/bin/bash: eval: line 1: unexpected EOF while looking for matching `"\'', flags: { command: 'ls "C:\\Projects\\claude-skills\\game-audio\\"' } },
  { reason: 'sleep_blocked', tool: 'Bash', text: '<tool_use_error>Blocked: standalone sleep 60. To wait for a condition, use Monitor with an until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.</tool_use_error>', flags: { command: 'sleep 60' } },
  { reason: 'subagent_limit', tool: 'Agent', text: 'Concurrent subagent limit reached. You can run 20 subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.' },
  { reason: 'test_or_build_failed', tool: 'Bash', text: 'Exit code 1\n.F..\r\n======================================================================\r\nFAIL: test_calibration_totals_match_the_emitters (tools.test_selfdescribing_counts.ContractCheckCalibration.test_calibration_totals_match_the_emitters)', flags: { command: 'cd C:/Projects/claude-agents && python -m unittest tools.test_selfdescribing_counts.ContractCheckCalibration 2>&1' } },
  { reason: 'tg_deny', tool: 'Glob', text: 'PreToolUse:Glob hook error: [tg] test deny', flags: { denialKind: 'permission-rule' } },
  { reason: 'tool_unavailable', tool: 'Grag', text: '<tool_use_error>Error: No such tool available: Grag</tool_use_error>' },
  { reason: 'user_rejected', tool: 'Bash', text: 'This command requires approval', flags: { denialKind: 'user-rejected', command: 'python3 -m unittest test_pricing -v' } },
  { reason: UNKNOWN_REASON, tool: 'mcp__claude-in-chrome__browser_batch', text: 'No tab available' },
]

// CAPTURE: the `error` field of the two PostToolUseFailure payloads Claude Code 2.1.281 sent on 2026-09-24 (a missing-file Read and `ls nonexistent_dir`).
const HOOK_READ_ERROR = 'File does not exist. Note: your current working directory is C:\\Users\\zelys\\AppData\\Local\\Temp\\tg_capture\\proj.'
const HOOK_BASH_ERROR = "Exit code 2\nls: cannot access 'nonexistent_dir': No such file or directory"

describe('classifyToolError', () => {
  it('names every census shape by its reason, and leaves an unmeasured one unknown', () => {
    const actual = CENSUS_CASES.map((c) => ({ reason: c.reason, got: classifyToolError(c.tool, c.text, c.flags) }))
    expect(actual.map((a) => [a.reason, a.got.reason])).toEqual(CENSUS_CASES.map((c) => [c.reason, c.reason]))
    for (const a of actual) expect(a.got.kind).toBe(a.reason === UNKNOWN_REASON ? 'unknown' : 'expected')
  })

  it('every reason the census cases name is one EXPECTED_REASONS lists, and every listed reason has a census case or a flag-only route', () => {
    const named = new Set(CENSUS_CASES.map((c) => c.reason).filter((r) => r !== UNKNOWN_REASON))
    expect([...named].filter((r) => !EXPECTED_REASONS.includes(r))).toEqual([])
    // `interrupted` comes from the hook's `is_interrupt` flag alone and has no text shape to capture.
    expect(EXPECTED_REASONS.filter((r) => !named.has(r))).toEqual(['interrupted'])
  })

  it('classifies both captured hook payloads as path_not_found', () => {
    expect(classifyToolError('Read', HOOK_READ_ERROR)).toEqual({ kind: 'expected', reason: 'path_not_found' })
    expect(classifyToolError('Bash', HOOK_BASH_ERROR, { command: 'ls nonexistent_dir' })).toEqual({ kind: 'expected', reason: 'path_not_found' })
  })

  it('an interrupt outranks the text', () => {
    expect(classifyToolError('Bash', HOOK_BASH_ERROR, { isInterrupt: true })).toEqual({ kind: 'expected', reason: 'interrupted' })
  })

  it('reads a hook deny off the rendered text when the transcript entry carries no denial field', () => {
    expect(classifyToolError('Glob', 'PreToolUse:Glob hook error: [tg] test deny').reason).toBe('tg_deny')
    expect(classifyToolError('Read', 'PreToolUse:Read hook error: blocked by policy').reason).toBe('hook_deny')
  })

  it('an empty exit 1 counts as a search miss only when the command is a search', () => {
    expect(classifyToolError('Bash', 'Exit code 1', { command: 'rg "COPILOT_AGENTS_HOME"' }).reason).toBe('search_no_match')
    expect(classifyToolError('Bash', 'Exit code 1', { command: 'node scripts/check.mjs' }).reason).toBe(UNKNOWN_REASON)
    expect(classifyToolError('Bash', 'Exit code 1').reason).toBe(UNKNOWN_REASON)
  })

  it('credits a test or build runner only at command position, never when a command merely names one as an argument', () => {
    // CAPTURE: two census rows the unanchored runner pattern once counted as test_or_build_failed; the `which` PATH list is cut to its first two entries.
    expect(classifyToolError('Bash', 'Exit code 1\nwhich: no jest in (/mingw64/bin:/usr/bin)', { command: 'which jest npx go cargo node 2>&1' }).reason).toBe(UNKNOWN_REASON)
    expect(classifyToolError('Bash', 'Exit code 15', { command: 'wsl bash -lc \'pkill -f "python -m pytest"; sleep 2; echo "All pytest processes terminated"\'' }).reason).toBe(UNKNOWN_REASON)
    // HAND-DERIVED: a leading environment assignment does not hide the runner.
    expect(classifyToolError('Bash', 'Exit code 1', { command: 'CI=1 npx vitest run tests/a.test.ts' }).reason).toBe('test_or_build_failed')
  })

  it('keeps a tool-scoped wording to its own tool', () => {
    expect(classifyToolError('Bash', 'String to replace not found in file.').reason).toBe(UNKNOWN_REASON)
  })
})

describe('unwrapToolError', () => {
  it('strips each tag on its own, so a copy clipped before the closing tag still unwraps', () => {
    expect(unwrapToolError('<tool_use_error>File has not been read yet.</tool_use_error>')).toBe('File has not been read yet.')
    expect(unwrapToolError('<tool_use_error>File has not been read yet. Read it fi')).toBe('File has not been read yet. Read it fi')
  })
})

describe('errorPrefix', () => {
  it('keys a Bash failure on its exit code and first output line, with paths, quotes and digits masked', () => {
    expect(errorPrefix(HOOK_BASH_ERROR)).toBe('exit 2: ls: cannot access <q>: No such file or directory')
    expect(errorPrefix('File does not exist. Note: cwd is C:\\Users\\zelys\\proj.')).toBe('File does not exist. Note: cwd is <path>')
    expect(errorPrefix('Exit code 1\nTraceback (most recent call last):\n  File "x.py", line 3')).toBe('exit 1: Traceback (most recent call last):')
    expect(errorPrefix('Error: ENOENT: no such file, open /home/u/a/b.txt')).toBe('Error: ENOENT: no such file, open <path>')
  })

  it('never cuts a surrogate pair in half at the width limit, which printed as U+FFFD and made the JSON report unparseable to jq', () => {
    // CAPTURE: a dotenv banner from the 2026-09-24 corpus census, whose emoji straddles the 60th code unit once masked.
    const prefix = errorPrefix('Exit code 1\n[dotenv@17.2.3] injecting env (48) from .env -- tip: 📡 add observability to secrets: https://dotenvx.com/ops')
    expect(prefix).toBe('exit 1: [dotenv@N.N.N] injecting env (N) from .env -- tip: ')
  })

  it('never exceeds the printed width and never returns an empty key', () => {
    expect(errorPrefix('x'.repeat(500))).toHaveLength(ERROR_PREFIX_CHARS)
    expect(errorPrefix('Exit code 1')).toBe('exit 1: (empty)')
  })
})
