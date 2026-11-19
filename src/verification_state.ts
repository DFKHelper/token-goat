/** What the session has verified. The test, lint, typecheck and build commands a session ran are recorded as they finish (post-Bash and post-failure hooks), and {@link evaluateVerification} sets them against the session's own source edits to answer one question: were files edited after the last command that did not fail? The Stop advisory and the subagent report receipt both read this verdict, so neither keeps bookkeeping of its own. State is read for one session-state key (hook_registry.ts sessionStateKey), so a subagent is judged on its own commands and edits. */

import { isLintCommand } from './bash_output_cache.js'
import { detectHarness } from './bridges/registry.js'
import { isTestRunnerCommand } from './hints/lang_patterns.js'
import { languageHasFlag } from './language_specs.js'
import { detectLanguage } from './parser_types.js'
import { recordVerificationRun, type VerificationRun } from './session.js'
import { readSessionStateFile } from './session_store.js'
import { displaySafePath } from './paths.js'
import { redactSecrets } from './secret_redact.js'
import {
  isDocumentOnlyScriptCheckSegment,
  isScriptCheckSegment,
  launcherCarriedCheck,
} from './verification_commands.js'
import { readHeadCommit } from './git_hint.js'
import * as os from 'node:os'
import { canonicalize, foldPath, isInsideRoot } from './path_containment.js'
import { findProject, isUnderSystemTemp } from './project.js'

/** Build, typecheck and script wrappers that are not covered by the test-runner or lint predicates. Install and dependency commands are deliberately absent: they prove nothing about the edits. */
const OTHER_VERIFICATION_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:npx\s+)?tsc(?:\s|$)/i,
  /^(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?(?:test|build|lint|typecheck|type-check|check|compile|verify)(?::[\w:-]+)?(?:\s|$)/i,
  /^cargo\s+(?:build|check|clippy|test)\b/i,
  /^go\s+(?:build|vet|test)\b/i,
  /^dotnet\s+(?:build|test)\b/i,
  /^(?:mypy|pyright)(?:\s|$)/i,
  /^python3?\s+-m\s+(?:mypy|pyright|ruff|pytest)\b/i,
]

const ENV_ASSIGNMENT_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/
// A lone `&` backgrounds what precedes it; `2>&1`, `&>log`, `>&2`, `|&` and `&&` are not that.
const COMMAND_SEPARATOR = /(&&|\|\||[;|\n]|(?<![>&|])&(?![>&]))/

function isRunnerCheck(trimmed: string): boolean {
  if (isTestRunnerCommand(trimmed) || isLintCommand(trimmed)) return true
  return OTHER_VERIFICATION_PATTERNS.some((re) => re.test(trimmed))
}

/** A segment that is a check itself: a runner or a checking script, not a launcher carrying one. */
function isDirectVerificationSegment(segment: string): boolean {
  const trimmed = segment.trim().replace(ENV_ASSIGNMENT_PREFIX, '')
  return trimmed !== '' && (isRunnerCheck(trimmed) || isScriptCheckSegment(trimmed))
}

function isVerificationSegment(segment: string): boolean {
  if (isDirectVerificationSegment(segment)) return true
  const trimmed = segment.trim().replace(ENV_ASSIGNMENT_PREFIX, '')
  return trimmed !== '' && launcherCarriedCheck(trimmed, isRunnerCheck) !== null
}

// An interpreter's inline code string (`python -c "..."`, `node -e '...'`) is program text, not a command line.
const INLINE_SWITCH = '(?:python3?|node|perl|ruby)(?:\\s+-[\\w-]+)*?\\s+(?:-c|-e|-E|-p|--eval|--print)'
const INLINE_SCRIPT_BODY = new RegExp(`\\b(${INLINE_SWITCH})(\\s+)("(?:[^"\\\\]|\\\\[\\s\\S])*"|'[^']*')`, 'g')

/** The command with each inline interpreter body emptied, so a check word inside one is not read as a run. */
function withoutInlineScriptBodies(command: string): string {
  return command.replace(INLINE_SCRIPT_BODY, "$1$2''")
}

/** The command as the verdict code reads it: no file-writing heredoc body, no inline interpreter body. */
function checkableText(typed: string): string {
  return withoutInlineScriptBodies(withoutFileHeredocBodies(typed))
}

/** True when any segment is a check itself rather than a launcher carrying one. */
function hasDirectCheck(command: string): boolean {
  return withoutInlineScriptBodies(command).split(COMMAND_SEPARATOR).some(isDirectVerificationSegment)
}

/** True when any segment of `command` is a test, lint, typecheck or build invocation. */
export function isVerificationCommand(command: string): boolean {
  return withoutInlineScriptBodies(command).split(COMMAND_SEPARATOR).some(isVerificationSegment)
}

/** A real `set` statement that turns pipefail on or off: `set -o pipefail`, `set -eo pipefail`, `set -euo pipefail`, `set -e -o pipefail`, `set +o pipefail`. Group 1 is the sign. */
const PIPEFAIL_STATEMENT = /^set\s+(?:[-+]\w+\s+|[-+]o\s+\w+\s+)*([-+])\w*o\s+pipefail\b/

/** True when the exit status of `command` is the verdict of its checks: from the first check onward only `&&` joins what follows, no `||`, `;` or newline lets a later segment replace the status, a lone `&` backgrounds the check so nothing finished, and a pipe follows only under a `set -o pipefail` statement that comes before the check (not one in a comment, an `echo` or after it). `npm test 2>&1 | tail`, `npm test || true` and `npm test; echo done` all exit 0 whatever the check did, and a `||` just before the first check means it may not have run at all. */
export function exitStatusIsCheckVerdict(command: string, isCheck: (segment: string) => boolean = isVerificationSegment): boolean {
  // A trailing separator ends the command with no segment after it.
  const parts = command.replace(/[;\s]+$/, '').split(COMMAND_SEPARATOR)
  const first = parts.findIndex(isCheck)
  // The last statement before the check wins: `set -o pipefail; set +o pipefail; npm test | tail` runs with it off.
  let pipefail = false
  parts.slice(0, first).forEach((part, i) => {
    const statement = i % 2 === 0 ? PIPEFAIL_STATEMENT.exec(part.trim()) : null
    if (statement !== null) pipefail = statement[1] === '-'
  })
  const allowed = pipefail ? ['&&', '|'] : ['&&']
  return first >= 0 && parts[first - 1] !== '||' && parts.slice(first + 1).every((part, i) => i % 2 === 1 || allowed.includes(part))
}

/** Claude Code and Copilot CLI deliver a failed call to a separate failure event, so a call that reaches the ordinary post-tool event without a status finished cleanly. Every other host reports failures through the same event, with a status only some of them carry. */
function successImpliedWithoutStatus(): boolean {
  const harness = detectHarness()
  return harness === 'claudecode' || harness === 'copilot_cli'
}

const STORED_COMMAND_MAX_CHARS = 200

/** The check a launcher segment carries, else the segment: a launched check is stored and keyed as itself. */
function carriedOrSelf(segment: string): string {
  if (isScriptCheckSegment(segment)) return segment
  return launcherCarriedCheck(segment, isRunnerCheck) ?? segment
}

/** The command as the session blob keeps it: only the check segments, without their leading `NAME=value` assignments, whitespace collapsed, each cut down to what {@link allowListed} lets through, then capped. The rest of the line (`export GH_PAT=...`, `mysqldump -p...`, `sshpass -p ...`, a curl header) and every argument the allow-list does not know never reach disk or the model, whatever their spelling, which a list of secret shapes cannot promise. redactSecrets still runs last over what was kept, for a path-like word shaped like a known token. Two runs of one command must collapse to one entry, so this is also the identity. */
function storedCommand(command: string, isCheck: (segment: string) => boolean = isVerificationSegment): string {
  const checks = command
    .split(COMMAND_SEPARATOR)
    .filter((_part, i) => i % 2 === 0)
    .map((segment) => segment.trim())
    .filter(isCheck)
    .map((segment) => segment.replace(ENV_ASSIGNMENT_PREFIX, ''))
    .map(carriedOrSelf)

    .map((segment) => segment.replace(/\s+/g, ' '))
    .map((segment) => redactSecrets(allowListed(segment)).text)
  return checks.join('; ').slice(0, STORED_COMMAND_MAX_CHARS)
}

/** The runner and subcommand of a check, as {@link isVerificationSegment} recognises it (OTHER_VERIFICATION_PATTERNS above, lang_patterns.ts TEST_RUNNER_COMMAND_PATTERNS, bash_output_cache.ts lintCommand). Nothing after it is trusted by default. */
const CHECK_HEAD = /^(?:(?:npx\s+)?(?:jest|vitest(?:\s+(?:run|watch))?|eslint|tsc|mypy|pyright)|pytest|(?:uv\s+run\s+)?ruff(?:\s+(?:check|format))?|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|dotnet\s+(?:build|test)|(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?(?:test|build|lint|typecheck|type-check|check|compile|verify)(?::[\w:-]+)?|python3?\s+-m\s+(?:mypy|pyright|ruff|pytest)|python3?(?=\s+\S*\.py(?:\s|$)))(?=\s|$)/i
/** Switches that take no value: each is documented by a test, lint, typecheck or build runner (vitest, jest, pytest, tsc, cargo). A flag that takes a value is absent on purpose, since its name does not say whether the value is a secret. */
const SAFE_FLAGS: ReadonlySet<string> = new Set(['--', '--ci', '--run', '--watch', '--watch=false', '--watchAll=false', '--coverage', '--bail', '--verbose', '--silent', '--no-color', '--noEmit', '--passWithNoTests', '--release', '--locked', '--all-targets', '--self-test', '-x', '-q', '-v', '-vv'])
/** The values of `--reporter=` that name a built-in reporter; any other value could be anything. */
const SAFE_REPORTER = /^--reporter=(?:default|verbose|dot|basic|json|junit|tap|spec|min|list|agent)$/
const PATH_SHAPE = /^[\w./@~][\w./@:\\-]*$/
const PATH_EVIDENCE = /[/\\]|::|\.[A-Za-z]\w*$/
/** A drive letter at the start of a Windows path (`C:/x`, `C:\x`), the one place a single `:` belongs in a path word. */
const DRIVE_PREFIX = /^[A-Za-z]:[/\\]/
/** Three base64url segments, the first an encoded JSON header (`eyJ`): a bearer token spelled as a dotted name, which would otherwise pass for a file with an extension. */
const JWT_SHAPE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/
/** Stands in the stored check for every word the allow-list dropped. */
const DROPPED_MARK = '…'

/** A bare path or test selector (`tests/a.test.ts`, `tests/test_x.py::test_y`): a word with a separator or an extension. `hunter2` alone is not one, and neither is a word with a single `:` outside a drive prefix or `::` (`user:hunter2@host/x`) or one shaped like a JWT. A positional file name is kept because it is what identifies the check; a secret spelled as a path with a separator or an extension is not something a runner is handed as a bare argument, and one that follows a flag is dropped by {@link allowListed}. */
function looksLikePathOrSelector(word: string): boolean {
  if (!PATH_SHAPE.test(word) || !PATH_EVIDENCE.test(word)) return false
  return !JWT_SHAPE.test(word) && !word.replace(DRIVE_PREFIX, '').replace(/::/g, '').includes(':')
}

/** Fail-closed allow-list over one check segment: the runner and subcommand, the switches in {@link SAFE_FLAGS}, a built-in `--reporter=` and path-like words survive; every other word is dropped and the loss is marked, so `npm test --foo hunter2` stores `npm test …`. A word that follows a dropped flag with no `=` may be that flag's value, so it is dropped even when it looks like a path (`-p a/b.c`). A deny-list of secret spellings cannot promise this: a value is not recognisable by its flag name, its position or its shape, which is why the mask that used to sit here is gone. */
function allowListed(segment: string): string {
  const headMatch = CHECK_HEAD.exec(segment)
  const head = headMatch?.[0] ?? /^[A-Za-z]+/.exec(segment)?.[0] ?? ''
  const kept = [head]
  let dropped = headMatch === null
  let afterDroppedFlag: boolean = false
  for (const word of segment.slice(head.length).split(' ')) {
    if (word === '') continue
    const safe: boolean = SAFE_FLAGS.has(word) || SAFE_REPORTER.test(word) || (!afterDroppedFlag && looksLikePathOrSelector(word))
    if (safe) kept.push(word)
    else dropped = true
    afterDroppedFlag = !safe && word.startsWith('-') && !word.includes('=')
  }
  if (dropped) kept.push(DROPPED_MARK)
  return kept.filter((w) => w !== '').join(' ')
}

/** A segment that counts as a check for a failing run: a verification segment, or a checking script run whose only arguments beyond the check are `.md` documents. */
function isFailureCheckSegment(segment: string): boolean {
  return isVerificationSegment(segment) || isDocumentOnlyScriptCheckSegment(segment.trim().replace(ENV_ASSIGNMENT_PREFIX, ''))
}

/** True when a call's only check is a checking script given `.md` documents as positionals (`python scripts/run_self_tests.py README.md`), with its exit status as the verdict. Such a call is recorded only as a failure: its documents are never check inputs, so a pass on them clears nothing. */
function isDocumentOnlyFailure(command: string): boolean {
  return exitStatusIsCheckVerdict(command, isFailureCheckSegment) && command.split(COMMAND_SEPARATOR).some((part, i) => i % 2 === 0 && isDocumentOnlyScriptCheckSegment(part.trim().replace(ENV_ASSIGNMENT_PREFIX, '')))
}

const HEREDOC_WORD = '(?:"[^"`()|;&<>]*"|\'[^\'`]*\'|[^\\s"\'`()|;&<>]+)'
// Allow-list: one `cat` or `tee` statement whose output goes only to a plain file, ending in its one heredoc.
const FILE_HEREDOC_OPENER = new RegExp(
  `(?:^|[;&]\\s*)(?:cat|tee(?:\\s+-a)?)(?:\\s+(?:>>?\\s*)?${HEREDOC_WORD})?` +
    `\\s+<<-?\\s*(['"]?)(\\w+)\\1(?:\\s*>>?\\s*${HEREDOC_WORD})?\\s*$`,
)
// Anything that could run or feed the body: substitution, pipe, a shell word, a `-c` string, `. file`.
const SHELL_FED_LINE =
  /[`()|]|<<<|\b(?:eval|source|exec|xargs|ba?sh|zsh|dash|ksh|python3?|node)\b|\s-c\b|(?:^|[;&]\s*)\.\s/

/** The text up to here is still inside a substitution or a quoted string, or its last line pipes on. */
function isOpenContext(before: string[]): boolean {
  const text = before.join('\n')
  const count = (ch: string): number => text.split(ch).length - 1
  const oddQuote = count('"') % 2 === 1 || count("'") % 2 === 1
  return count('(') > count(')') || oddQuote || /[|\\]\s*$/.test(before[before.length - 1] ?? '')
}

/** True when an unquoted `#` that starts a word begins a shell comment before the text at `end`. */
function hasCommentBefore(line: string, end: number): boolean {
  let quote = ''
  for (let i = 0; i < end; i++) {
    const ch = line[i] ?? ''
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1] ?? ''))) return true
  }
  return false
}

/** The terminator of a file-only heredoc this line opens, else null; an opener in a comment opens none. */
function fileHeredocTerminator(line: string, before: string[]): string | null {
  if (SHELL_FED_LINE.test(line) || line.split('<<').length !== 2 || isOpenContext(before)) return null
  if (hasCommentBefore(line, line.indexOf('<<'))) return null
  return FILE_HEREDOC_OPENER.exec(line)?.[2] ?? null
}

/** The command minus file-writing heredoc bodies: quoting `vitest run` runs no check. Unsure keeps the body. */
function withoutFileHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const terminator = fileHeredocTerminator(line, kept.slice(0, -1))
    if (terminator === null) continue
    const end = lines.findIndex((later, j) => j > i && later.trim() === terminator)
    if (end < 0) continue
    i = end
  }
  return kept.join('\n')
}

/** Record a finished Bash call if it was a verification command. A background launch has not finished, so it is not a verdict, and neither is a call whose exit status something around the check decided ({@link exitStatusIsCheckVerdict}): that call is left unrecorded, so it neither clears the edits made since the last pass nor counts as a failure. An unknown status is not recorded as null here because evaluateVerification reads null as a pass. A failing document-only check is recorded too ({@link isDocumentOnlyFailure}). */
export function noteVerificationRun(
  typed: string,
  exitCode: number | null,
  runInBackground: boolean,
  cwd?: string,
): void {
  if (runInBackground) return
  const command = checkableText(typed)
  if (isVerificationCommand(command) && exitStatusIsCheckVerdict(command)) {
    const status = exitCode ?? (successImpliedWithoutStatus() ? 0 : null)
    // A launcher-carried check may clear a failure by passing but never records one.
    if (status !== null && status !== 0 && !hasDirectCheck(command)) return
    recordVerificationRun(storedCommand(command), status, Date.now(), headAt(cwd))
    return
  }
  if (exitCode !== null && exitCode !== 0 && isDocumentOnlyFailure(command)) {
    recordVerificationRun(storedCommand(command, isFailureCheckSegment), exitCode, Date.now(), headAt(cwd))
  }
}

/** The commit HEAD names in `cwd` now, or undefined when there is no cwd or it cannot be read. */
function headAt(cwd: string | undefined): string | undefined {
  return cwd === undefined ? undefined : (readHeadCommit(cwd) ?? undefined)
}

const HEREDOC_OPENER = /(?<!<)<<(?!<)-?\s*(['"]?)(\w+)\1/g
const TRAILING_CLOSERS = /(?:\n[ \t]*[)"']+)+$/
const EXIT_CODE_IN_ERROR =/^Exit code (\d+)/

/** Command minus each heredoc's terminator, and its body if the opener is a check (a shell's body stays). */
function withoutHeredocFraming(command: string): string {
  const lines = command.split('\n')
  const dropped = new Set<number>()
  let cursor = 0
  for (let i = 0; i < lines.length; i++) {
    if (dropped.has(i)) continue
    const line = lines[i] as string
    for (const opener of line.matchAll(HEREDOC_OPENER)) {
      const own = (line.slice(0, opener.index).split(COMMAND_SEPARATOR).pop() ?? '')
        .trim()
        .replace(ENV_ASSIGNMENT_PREFIX, '')
      const end = lines.findIndex((text, j) => j > Math.max(i, cursor - 1) && text.trim() === opener[2])
      if (end < 0) continue
      dropped.add(end)
      cursor = end + 1
      if (isVerificationSegment(own)) for (let j = i + 1; j < end; j++) dropped.add(j)
    }
  }
  // Closing lines of a substitution or quote (`)`, `)"`, `"`) add no statement after a check ending the script.
  return lines.filter((_text, j) => !dropped.has(j)).join('\n').trimEnd().replace(TRAILING_CLOSERS, '')
}

/** Record a Bash call that failed, from the failure event's error text (Claude Code opens it with `Exit code N`; the status is 1 when the text carries none). An interrupt has no verdict. */
export function noteFailedVerificationRun(
  typed: string,
  errorText: string,
  isInterrupt: boolean,
  cwd?: string,
): void {
  const command = checkableText(typed)
  // Same rule as the pass path; when the status cannot be told to belong to a check, nothing is recorded.
  const isVerdict =
    hasDirectCheck(command) &&
    exitStatusIsCheckVerdict(withoutHeredocFraming(command), isDirectVerificationSegment)
  if (isInterrupt || !(isVerdict || isDocumentOnlyFailure(command))) return
  const status = EXIT_CODE_IN_ERROR.exec(errorText)
  const exitCode = status !== null && Number(status[1]) !== 0 ? Number(status[1]) : 1
  recordVerificationRun(storedCommand(command, isFailureCheckSegment), exitCode, Date.now(), headAt(cwd))
}

export interface VerificationState {
  /** Latest verdict per verification command, oldest first. */
  readonly runs: readonly VerificationRun[]
  /** The most recent run of any verification command. */
  readonly latestRun?: VerificationRun
  /** True when that most recent run failed. */
  readonly failingUnresolved: boolean
  /** Source files this session edited, by display name. */
  readonly editedFiles: readonly string[]
  /** True when the session recorded an edit to any file at all, source or not. */
  readonly editedAnyFile: boolean
  /** Source files edited after the last run that did not fail (all of them when no such run exists). */
  readonly editedSinceLastPass: readonly string[]
}

/** Which edits a verdict is about. */
export interface VerificationScope {
  /** The session's project root. An edit inside it always needs a check; one outside it is dismissed only when it sits under the OS temp dir (throwaway probes, the harness scratchpad), and a sibling package, another repo or a sibling worktree still counts. Absent, only an edit under the OS temp dir is dismissed. */
  readonly projectRoot?: string
  /** The session's cwd (null: none known). When set, a failed run counts only while HEAD there is unchanged. */
  readonly cwd?: string | null
}

/** The project root a session working in `cwd` is judged against: the nearest project marker above it, else `cwd` itself. */
export function verificationScopeFor(cwd: string | undefined): VerificationScope {
  if (cwd === undefined) return { cwd: null }
  return { projectRoot: findProject(cwd)?.root ?? cwd, cwd }
}

/** Whether an edit needs a project check. One inside the session's project root always does, even a project that itself lives under the OS temp dir. Outside the root it is dismissed only when it is under the OS temp dir: a sibling package, another repo or a sibling worktree is still work nothing verified. With no root known, the same temp-dir test alone decides. A path that cannot be judged stays in scope. Both tests also follow links, so a link or junction under the temp dir that leads into the project is a project edit, and a path whose links cannot be resolved is not dismissed. */
function inScope(filePath: string, scope: VerificationScope): boolean {
  try {
    if (scope.projectRoot !== undefined) {
      const root = foldPath(canonicalize(scope.projectRoot))
      const target = foldPath(canonicalize(filePath))
      if (target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)) return true
      if (isInsideRoot(filePath, scope.projectRoot)) return true
    }
    return !(isUnderSystemTemp(filePath) && isInsideRoot(filePath, os.tmpdir()))
  } catch {
    return true
  }
}

/** With a session cwd, a failed run stands only while HEAD there is the stored one; no evidence expires it. */
function failureIsCurrent(run: VerificationRun, scope: VerificationScope | undefined): boolean {
  if (scope?.cwd === undefined) return true
  const now = scope.cwd === null ? null : readHeadCommit(scope.cwd)
  return run.head !== undefined && now !== null && run.head === now
}

/** The verification verdict for one session-state key. An unreadable or absent state is an empty verdict, which never claims an edit. Without a `scope` every source edit counts, which is how the subagent report receipt reads it; the Stop advisory passes the session scope ({@link verificationScopeFor}). */
export function evaluateVerification(stateKey: string, scope?: VerificationScope): VerificationState {
  const state = readSessionStateFile(stateKey)
  const runs = state?.verificationRuns ?? []
  const latestRun = runs.reduce<VerificationRun | undefined>((latest, run) => (latest === undefined || run.at >= latest.at ? run : latest), undefined)
  const latestFailed = latestRun !== undefined && latestRun.exitCode !== null && latestRun.exitCode !== 0
  const lastPassAt = runs.reduce((at, run) => (run.exitCode === null || run.exitCode === 0 ? Math.max(at, run.at) : at), -1)
  const edited = (state?.files ?? []).filter((f) => f.wasEdited && f.lastEditedAt !== undefined && languageHasFlag(detectLanguage(f.path), 'sourceHints') && (scope === undefined || inScope(f.path, scope)))
  const names = (files: typeof edited): string[] => [...new Set(files.map((f) => displaySafePath(f.path.split(/[/\\]/).pop() ?? f.path)))].sort()
  return {
    runs,
    ...(latestRun !== undefined ? { latestRun } : {}),
    failingUnresolved: latestFailed && failureIsCurrent(latestRun, scope),
    editedFiles: names(edited),
    editedAnyFile: (state?.files ?? []).some((f) => f.wasEdited),
    editedSinceLastPass: names(edited.filter((f) => (f.lastEditedAt ?? 0) > lastPassAt)),
  }
}
