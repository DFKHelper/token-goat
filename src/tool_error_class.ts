/** Classifies a failed tool call as `expected` (a known failure shape with a named cause) or `unknown` (everything else). One table, read by both the live `post_tool_use_failure` brake and the `session-audit --tool-errors` report, so the two can never disagree about what a failure is. Every pattern was chosen from a census of the local Claude Code transcript corpus (2026-09-24: 3,692 transcripts, about 259,000 tool calls, 7,935 `is_error` tool results, Claude Code 2.1.x) and carries its own count, as `session-audit --tool-errors --json` reported it over that corpus; a failure shape nobody has measured stays `unknown`, so the report's unknown prefixes are the list to promote from rather than a guess about what might go wrong. Inputs arrive from two producers. The hook payload (Claude Code `PostToolUseFailure`, captured on 2.1.281) carries `error` and `is_interrupt`; a transcript `tool_result` carries the same text, often wrapped in `<tool_use_error>`, plus the entry's `toolDenialKind` when the call was refused before it ran. A refused call never reaches the failure hook -- a PreToolUse deny fired neither PostToolUse nor PostToolUseFailure in a capture on 2.1.281 -- so the denial reasons are populated from transcripts alone. */

import { splitShellSegments, stripLeadingAssignments } from './bash_extractors.js'
import { safeSlice } from './util.js'

/** Whether a failure has a named, understood cause. */
export type ToolErrorKind = 'expected' | 'unknown'

/** Structured signals that travel beside the error text. Each is optional because each producer carries a different subset. */
export interface ToolErrorFlags {
  /** Transcript entry `toolDenialKind` (`permission-rule`, `user-rejected`, `automode-blocked`): the call was refused, not run. */
  readonly denialKind?: string
  /** Hook payload `is_interrupt`: the user stopped the call mid-flight. */
  readonly isInterrupt?: boolean
  /** The Bash command, for the patterns an exit code alone cannot decide. */
  readonly command?: string
}

export interface ToolErrorClass {
  readonly kind: ToolErrorKind
  readonly reason: string
}

/** The reason every unmatched failure carries. */
export const UNKNOWN_REASON = 'unclassified'

interface ExpectedPattern {
  readonly reason: string
  /** Tools whose results can carry this wording; omitted when the wording is the harness's own and any tool can produce it. */
  readonly tools?: readonly string[]
  /** Tested against the error text with any `<tool_use_error>` wrapper removed. */
  readonly re: RegExp
  /** When present, some command in the Bash call's chain must start with this ({@link runsCommand}): the exit code alone does not say why a command failed. */
  readonly command?: RegExp
}

/** A denial is a structured harness field, not text, so it is decided before any pattern runs. `permission-rule` is a PreToolUse hook deny or a settings rule (2,767 in the census); 2,764 of them carried token-goat's own wording and are split out as `tg_deny` below. */
const DENIAL_KIND_REASONS: Readonly<Record<string, string>> = {
  'permission-rule': 'hook_deny',
  // 73 in the census: the user declined an approval prompt.
  'user-rejected': 'user_rejected',
  // 1 in the census; kept because it is an enumerated harness value, not a text guess.
  'automode-blocked': 'auto_mode_blocked',
}

/** Token-goat's deny wording: the `[tg]` prefix `denyOutput` adds, or a command pointer from releases that predate it. */
const TG_DENY_RE = /\[tg\]|token-goat/

/** A hook deny as Claude Code renders it into the tool result when no denial field survives (`PreToolUse:Glob hook error: [tg] ...`, captured on 2.1.281). */
const HOOK_DENY_TEXT_RE = /^PreToolUse:\S+ hook error: /

const TEST_OR_BUILD_COMMAND_RE = /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck))|npx\s+(?:vitest|tsc|eslint|jest|playwright)|vitest|jest|pytest|tsc|eslint|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|make|gradle|mvn|dotnet\s+(?:test|build)|ruff|mypy|python3?\s+-m\s+(?:pytest|unittest))\b/

export const SEARCH_COMMAND_RE = /^(?:grep|egrep|fgrep|rg|findstr)\b/

/** Whether any command in a Bash call's chain starts with `head` once its own environment assignments are peeled; a runner named only as an argument (`which jest`, `pkill -f "python -m pytest"`, `ls vitest.config.*`) does not count. */
function runsCommand(command: string, head: RegExp): boolean {
  return splitShellSegments(command).some((segment) => head.test(stripLeadingAssignments(segment)))
}

/** First match wins, so the narrow command-scoped Bash shapes run before the broad text ones. Counts are this pattern's matches in the census after every earlier row has taken its share. */
const EXPECTED_PATTERNS: readonly ExpectedPattern[] = [
  // 176: the Bash tool's own timeout, reported as SIGTERM's 143 plus this line.
  { reason: 'command_timeout', tools: ['Bash'], re: /^Exit code \d+\s+Command timed out after / },
  // 289: exit 1 with no output from a search command, which is how grep and rg report zero hits.
  { reason: 'search_no_match', tools: ['Bash'], re: /^Exit code 1\s*$/, command: SEARCH_COMMAND_RE },
  // 252: a test, build, lint or typecheck run reporting failures, which is the tool doing its job.
  { reason: 'test_or_build_failed', tools: ['Bash'], re: /^Exit code \d+/, command: TEST_OR_BUILD_COMMAND_RE },
  // 302: an unbalanced quote or bracket in the command itself.
  { reason: 'shell_syntax_error', tools: ['Bash'], re: /unexpected EOF while looking for matching|syntax error near unexpected token/ },
  // 29: a binary missing from PATH.
  { reason: 'command_not_found', tools: ['Bash'], re: /command not found/ },
  // 272: the harness refusing a bare or leading `sleep` and pointing at Monitor instead.
  { reason: 'sleep_blocked', tools: ['Bash'], re: /^Blocked: (?:sleep \d+ followed by|standalone sleep)/ },
  // 114: old_string absent from the file.
  { reason: 'edit_string_not_found', tools: ['Edit', 'MultiEdit'], re: /^String to replace not found in file/ },
  // 37: old_string present more than once with replace_all false.
  { reason: 'edit_multiple_matches', tools: ['Edit', 'MultiEdit'], re: /^Found \d+ matches of the string to replace/ },
  // 37: the harness's read-before-write guard.
  { reason: 'file_not_read_yet', tools: ['Edit', 'MultiEdit', 'Write'], re: /^File has not been read yet/ },
  // 16: the file changed on disk after the last read.
  { reason: 'file_modified_since_read', tools: ['Edit', 'MultiEdit', 'Write'], re: /^File has been modified since read/ },
  // 643 (578 Bash, 53 Read, 11 Grep, 1 Edit): a path that does not exist, in each tool's own wording.
  { reason: 'path_not_found', re: /No such file or directory|^File does not exist\.|^Path does not exist:/ },
  // 1,171: an interpreter raising: a Python traceback header, the `Node.js vN.N.N` line Node prints under every uncaught error, or a named error line (`SyntaxError: ...`). After path_not_found, so a missing file stays a missing file whichever language reported it.
  { reason: 'script_exception', tools: ['Bash'], re: /^(?:Traceback \(most recent call last\):|Node\.js v\d+\.\d+\.\d+\b|[A-Z]\w*(?:Error|Exception)(?: \[\w+\])?: )/m },
  // 14: a Read over the harness's size ceiling.
  { reason: 'file_too_large', tools: ['Read'], re: /^File content \([^)]*\) exceeds maximum allowed/ },
  // 85: arguments the tool's schema rejected before it ran.
  { reason: 'input_validation', re: /^InputValidationError/ },
  // 68: a StructuredOutput call that did not match the requested schema.
  { reason: 'schema_mismatch', tools: ['StructuredOutput'], re: /^Output does not match required schema/ },
  // 35: the harness's concurrent-subagent ceiling.
  { reason: 'subagent_limit', tools: ['Agent', 'Task'], re: /^Concurrent subagent limit reached/ },
  // 37: a tool disabled for this session or a misspelled tool name.
  { reason: 'tool_unavailable', re: /^Error: No such tool available/ },
]

/** Every reason {@link classifyToolError} can return as `expected`, for tests and for a report that wants a stable column order. */
export const EXPECTED_REASONS: readonly string[] = [
  'interrupted',
  'tg_deny',
  ...new Set(Object.values(DENIAL_KIND_REASONS)),
  ...EXPECTED_PATTERNS.map((p) => p.reason),
]

const TOOL_USE_ERROR_OPEN = '<tool_use_error>'
const TOOL_USE_ERROR_CLOSE = '</tool_use_error>'

/** The error text as the tool wrote it: transcripts wrap harness-side failures in `<tool_use_error>`, hook payloads do not. Each tag is stripped on its own because a clipped copy of the text keeps the opening tag and loses the closing one. */
export function unwrapToolError(errorText: string): string {
  let text = errorText.trim()
  if (text.startsWith(TOOL_USE_ERROR_OPEN)) text = text.slice(TOOL_USE_ERROR_OPEN.length)
  if (text.endsWith(TOOL_USE_ERROR_CLOSE)) text = text.slice(0, text.length - TOOL_USE_ERROR_CLOSE.length)
  return text.trim()
}

function expected(reason: string): ToolErrorClass {
  return { kind: 'expected', reason }
}

/** Classify one failed tool call. Pure and cheap: it runs on every failure the hook sees. */
export function classifyToolError(tool: string | undefined, errorText: string, flags: ToolErrorFlags = {}): ToolErrorClass {
  if (flags.isInterrupt === true) return expected('interrupted')
  const text = unwrapToolError(errorText)
  const denial = flags.denialKind
  if (denial !== undefined && denial !== '') {
    const reason = DENIAL_KIND_REASONS[denial] ?? 'hook_deny'
    return expected(reason === 'hook_deny' && TG_DENY_RE.test(text) ? 'tg_deny' : reason)
  }
  if (HOOK_DENY_TEXT_RE.test(text)) return expected(TG_DENY_RE.test(text) ? 'tg_deny' : 'hook_deny')
  for (const p of EXPECTED_PATTERNS) {
    if (p.tools !== undefined && (tool === undefined || !p.tools.includes(tool))) continue
    if (!p.re.test(text)) continue
    if (p.command !== undefined && (flags.command === undefined || !runsCommand(flags.command, p.command))) continue
    return expected(p.reason)
  }
  return { kind: 'unknown', reason: UNKNOWN_REASON }
}

/** Longest error prefix the report prints; enough to tell clusters apart, short enough to stay one line. */
export const ERROR_PREFIX_CHARS = 60

const EXIT_CODE_HEADER_RE = /^Exit code (\d+)\s*/

/** A cluster key for an error: its first meaningful line with paths, quoted strings and digits masked, so the same failure from different files counts as one. A Bash failure's first line is always `Exit code N`, which says nothing, so its key is the exit code plus the first line of the command's own output. */
export function errorPrefix(errorText: string): string {
  let text = unwrapToolError(errorText)
  let lead = ''
  const exit = EXIT_CODE_HEADER_RE.exec(text)
  if (exit !== null) {
    lead = `exit ${exit[1] ?? ''}: `
    text = text.slice(exit[0].length)
  }
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const masked = line
    .trim()
    .replace(/\b[A-Za-z]:[\\/]\S*|~?\/[\w.~-]+(?:\/[\w.~-]*)+/g, '<path>')
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '<q>')
    .replace(/\d+/g, 'N')
  return safeSlice(`${lead}${masked === '' ? '(empty)' : masked}`, ERROR_PREFIX_CHARS)
}
