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

function isVerificationSegment(segment: string): boolean {
  const trimmed = segment.trim().replace(ENV_ASSIGNMENT_PREFIX, '')
  return trimmed !== '' && (isTestRunnerCommand(trimmed) || isLintCommand(trimmed) || OTHER_VERIFICATION_PATTERNS.some((re) => re.test(trimmed)))
}

/** True when any segment of `command` is a test, lint, typecheck or build invocation. */
export function isVerificationCommand(command: string): boolean {
  return command.split(COMMAND_SEPARATOR).some(isVerificationSegment)
}

/** A real `set` statement that turns pipefail on or off: `set -o pipefail`, `set -eo pipefail`, `set -euo pipefail`, `set -e -o pipefail`, `set +o pipefail`. Group 1 is the sign. */
const PIPEFAIL_STATEMENT = /^set\s+(?:[-+]\w+\s+|[-+]o\s+\w+\s+)*([-+])\w*o\s+pipefail\b/

/** True when the exit status of `command` is the verdict of its checks: from the first check onward only `&&` joins what follows, no `||`, `;` or newline lets a later segment replace the status, a lone `&` backgrounds the check so nothing finished, and a pipe follows only under a `set -o pipefail` statement that comes before the check (not one in a comment, an `echo` or after it). `npm test 2>&1 | tail`, `npm test || true` and `npm test; echo done` all exit 0 whatever the check did, and a `||` just before the first check means it may not have run at all. */
export function exitStatusIsCheckVerdict(command: string): boolean {
  // A trailing separator ends the command with no segment after it.
  const parts = command.replace(/[;\s]+$/, '').split(COMMAND_SEPARATOR)
  const first = parts.findIndex(isVerificationSegment)
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

/** The command as the session blob keeps it: only the check segments, without their leading `NAME=value` assignments, whitespace collapsed, each cut down to what {@link allowListed} lets through, then capped. The rest of the line (`export GH_PAT=...`, `mysqldump -p...`, `sshpass -p ...`, a curl header) and every argument the allow-list does not know never reach disk or the model, whatever their spelling, which a list of secret shapes cannot promise. redactSecrets still runs last over what was kept, for a path-like word shaped like a known token. Two runs of one command must collapse to one entry, so this is also the identity. */
function storedCommand(command: string): string {
  const checks = command
    .split(COMMAND_SEPARATOR)
    .filter((_part, i) => i % 2 === 0)
    .map((segment) => segment.trim())
    .filter(isVerificationSegment)
    .map((segment) => segment.replace(ENV_ASSIGNMENT_PREFIX, '').replace(/\s+/g, ' '))
    .map((segment) => redactSecrets(allowListed(segment)).text)
  return checks.join('; ').slice(0, STORED_COMMAND_MAX_CHARS)
}

/** The runner and subcommand of a check, as {@link isVerificationSegment} recognises it (OTHER_VERIFICATION_PATTERNS above, lang_patterns.ts TEST_RUNNER_COMMAND_PATTERNS, bash_output_cache.ts lintCommand). Nothing after it is trusted by default. */
const CHECK_HEAD = /^(?:(?:npx\s+)?(?:jest|vitest(?:\s+(?:run|watch))?|eslint|tsc|mypy|pyright)|pytest|(?:uv\s+run\s+)?ruff(?:\s+(?:check|format))?|go\s+(?:test|build|vet)|cargo\s+(?:test|build|check|clippy)|dotnet\s+(?:build|test)|(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?(?:test|build|lint|typecheck|type-check|check|compile|verify)(?::[\w:-]+)?|python3?\s+-m\s+(?:mypy|pyright|ruff|pytest))(?=\s|$)/i
/** Switches that take no value: each is documented by a test, lint, typecheck or build runner (vitest, jest, pytest, tsc, cargo). A flag that takes a value is absent on purpose, since its name does not say whether the value is a secret. */
const SAFE_FLAGS: ReadonlySet<string> = new Set(['--', '--ci', '--run', '--watch', '--watch=false', '--watchAll=false', '--coverage', '--bail', '--verbose', '--silent', '--no-color', '--noEmit', '--passWithNoTests', '--release', '--locked', '--all-targets', '-x', '-q', '-v', '-vv'])
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

/** Record a finished Bash call if it was a verification command. A background launch has not finished, so it is not a verdict, and neither is a call whose exit status something around the check decided ({@link exitStatusIsCheckVerdict}): that call is left unrecorded, so it neither clears the edits made since the last pass nor counts as a failure. An unknown status is not recorded as null here because evaluateVerification reads null as a pass. */
export function noteVerificationRun(command: string, exitCode: number | null, runInBackground: boolean): void {
  if (runInBackground || !isVerificationCommand(command) || !exitStatusIsCheckVerdict(command)) return
  recordVerificationRun(storedCommand(command), exitCode ?? (successImpliedWithoutStatus() ? 0 : null))
}

const EXIT_CODE_IN_ERROR = /^Exit code (\d+)/

/** Record a Bash call that failed, from the failure event's error text (Claude Code opens it with `Exit code N`; the status is 1 when the text carries none). An interrupt has no verdict. */
export function noteFailedVerificationRun(command: string, errorText: string, isInterrupt: boolean): void {
  if (isInterrupt || !isVerificationCommand(command)) return
  const status = EXIT_CODE_IN_ERROR.exec(errorText)
  const exitCode = status !== null && Number(status[1]) !== 0 ? Number(status[1]) : 1
  recordVerificationRun(storedCommand(command), exitCode)
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

/** The verification verdict for one session-state key. An unreadable or absent state is an empty verdict, which never claims an edit. */
export function evaluateVerification(stateKey: string): VerificationState {
  const state = readSessionStateFile(stateKey)
  const runs = state?.verificationRuns ?? []
  const latestRun = runs.reduce<VerificationRun | undefined>((latest, run) => (latest === undefined || run.at >= latest.at ? run : latest), undefined)
  const lastPassAt = runs.reduce((at, run) => (run.exitCode === null || run.exitCode === 0 ? Math.max(at, run.at) : at), -1)
  const edited = (state?.files ?? []).filter((f) => f.wasEdited && f.lastEditedAt !== undefined && languageHasFlag(detectLanguage(f.path), 'sourceHints'))
  const names = (files: typeof edited): string[] => [...new Set(files.map((f) => displaySafePath(f.path.split(/[/\\]/).pop() ?? f.path)))].sort()
  return {
    runs,
    ...(latestRun !== undefined ? { latestRun } : {}),
    failingUnresolved: latestRun !== undefined && latestRun.exitCode !== null && latestRun.exitCode !== 0,
    editedFiles: names(edited),
    editedAnyFile: (state?.files ?? []).some((f) => f.wasEdited),
    editedSinceLastPass: names(edited.filter((f) => (f.lastEditedAt ?? 0) > lastPassAt)),
  }
}
