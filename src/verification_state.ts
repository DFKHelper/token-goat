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

/** The command as the session blob keeps it: only the check segments, without their leading `NAME=value` assignments, then secrets redacted, whitespace collapsed, capped. The rest of the line (`export GH_PAT=...`, `mysqldump -p...`, `sshpass -p ...`, a curl header) never reaches disk or the model, whatever its spelling, which a list of secret shapes cannot promise. Two runs of one command must collapse to one entry, so this is also the identity. */
function storedCommand(command: string): string {
  const checks = command
    .split(COMMAND_SEPARATOR)
    .filter((_part, i) => i % 2 === 0)
    .map((segment) => segment.trim())
    .filter(isVerificationSegment)
    .map((segment) => segment.replace(ENV_ASSIGNMENT_PREFIX, '').replace(/\s+/g, ' '))
  return maskCommandCredentials(redactSecrets(checks.join('; ')).text).slice(0, STORED_COMMAND_MAX_CHARS)
}

const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASS(?:WD|WORD)?|PWD|AUTH|COOKIE|CREDENTIAL|BEARER/i
// An unquoted value stops at a separator, so `TOKEN=abc; npm test` keeps its `;`.
const ENV_ASSIGNMENT = /(^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g
const LONG_FLAG = /(--[\w-]+(?:=|\s+))("[^"]*"|'[^']*'|\S+)/g
// A flag name says it takes a secret when it contains one of these words, or is exactly `pass`, `pwd` or `key` or ends in `-key`: `--passWithNoTests` and `--keyboard` stay as they are.
const SECRET_FLAG_NAME = /password|passwd|passphrase|token|secret|api-?key|auth|bearer|credential|cookie|^pass$|^pwd$|(?:^|-)key$|-(?:pass|pwd)$/i
const BASIC_AUTH_FLAG = /(^|\s)(-u\s+)\S+:\S+/g
const DB_CLIENT = /\b(?:mysql|psql|mariadb)\b/
const DB_PASSWORD_FLAG = /(^|\s)-p\s*(?!-)\S+/g
const QUOTED_AUTH_HEADER = /(["'])((?:proxy-)?authorization|cookie|x-api-key)(\s*:)[^"']*\1/gi
const BARE_AUTH_HEADER = /(^|\s)((?:proxy-)?authorization|cookie|x-api-key)(\s*:\s*)\S+/gi

/** Second layer over {@link storedCommand}'s segment filter, for what sits on the check itself: `NAME=value` where the name says it is a secret, the value of a long flag whose name says it takes one (`--password`, `--token`, `--private-key`, `--pass`, `--bearer`, `--credentials`), `-u user:pass`, an Authorization or Cookie header value, and `-p<password>` on a mysql, psql or mariadb command. secret_redact.ts matches value shapes and misses `API_TOKEN=abcd1234 npm test`; the receipt and the Stop advisory repeat this text to the model, so it is masked here, where it is stored. */
export function maskCommandCredentials(command: string): string {
  const masked = command
    .replace(ENV_ASSIGNMENT, (whole, lead: string, name: string) => (SECRET_ENV_NAME.test(name) ? `${lead}${name}=***` : whole))
    .replace(LONG_FLAG, (whole, flag: string, value: string) => (SECRET_FLAG_NAME.test(flag.replace(/^--/, '').replace(/[=\s]+$/, '')) && !value.startsWith('--') ? `${flag}***` : whole))
    .replace(BASIC_AUTH_FLAG, (_whole, lead: string, flag: string) => `${lead}${flag}***`)
    .replace(QUOTED_AUTH_HEADER, (_whole, quote: string, header: string, colon: string) => `${quote}${header}${colon} ***${quote}`)
    .replace(BARE_AUTH_HEADER, (_whole, lead: string, header: string, colon: string) => `${lead}${header}${colon}***`)
  return DB_CLIENT.test(masked) ? masked.replace(DB_PASSWORD_FLAG, (_whole, lead: string) => `${lead}-p***`) : masked
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
