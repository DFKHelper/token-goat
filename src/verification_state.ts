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
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/

/** True when any segment of `command` is a test, lint, typecheck or build invocation. */
export function isVerificationCommand(command: string): boolean {
  return command.split(COMMAND_SEPARATOR).some((segment) => {
    const trimmed = segment.trim().replace(ENV_ASSIGNMENT_PREFIX, '')
    return trimmed !== '' && (isTestRunnerCommand(trimmed) || isLintCommand(trimmed) || OTHER_VERIFICATION_PATTERNS.some((re) => re.test(trimmed)))
  })
}

/** Claude Code and Copilot CLI deliver a failed call to a separate failure event, so a call that reaches the ordinary post-tool event without a status finished cleanly. Every other host reports failures through the same event, with a status only some of them carry. */
function successImpliedWithoutStatus(): boolean {
  const harness = detectHarness()
  return harness === 'claudecode' || harness === 'copilot_cli'
}

const STORED_COMMAND_MAX_CHARS = 200

/** The command as the session blob keeps it: secrets redacted, whitespace collapsed, capped. Two runs of one command must collapse to one entry, so this is also the identity. */
function storedCommand(command: string): string {
  return redactSecrets(command.replace(/\s+/g, ' ').trim()).text.slice(0, STORED_COMMAND_MAX_CHARS)
}

/** Record a finished Bash call if it was a verification command. A background launch has not finished, so it is not a verdict. */
export function noteVerificationRun(command: string, exitCode: number | null, runInBackground: boolean): void {
  if (runInBackground || !isVerificationCommand(command)) return
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
