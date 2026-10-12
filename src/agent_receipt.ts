/** The evidence receipt a subagent's report carries when its own record gives the parent a reason to doubt it: the last check it ran failed, it edited source after its last passing check, or the report claims a change the subagent never made. A clean subagent gets nothing. The verdict is verification_state.ts's, read for the subagent's own session-state key, so there is no second bookkeeping of what it ran. The receipt is computed when the subagent stops and parked in a sidecar of the parent session, keyed by a hash of the redacted report, because the parent's Agent result arrives on a different event and nothing else ties the two. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getHarnessName } from './bridges/registry.js'
import { loadConfig } from './config.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { echoedValue, nameSubject } from './hint_suggestion_guard.js'
import { getCwd, passOutput } from './hooks_common.js'
import { claimsCommittedChange, claimsUnnegatedChange } from './hooks_session.js'
import { redactSecrets } from './secret_redact.js'
import { sessionSidecarPath } from './session_store.js'
import type { HookOutput } from './types.js'
import { ensureDirSync, isWithinQuietHours, runGit } from './util.js'
import { evaluateVerification, type VerificationState } from './verification_state.js'

// Not `.json`: sessionSidecarPath refuses any other file ending in `.json`, because every reader that lists the sessions directory takes one to be a session.
const RECEIPTS_SUFFIX = '.agent-receipts'
/** Receipts kept per parent session, oldest dropped first. */
const MAX_RECEIPTS = 16
const MAX_NAMED_FILES = 3
/** A subagent stop is not a hot path, and the 50 ms hint budget is shorter than a cold git start on Windows. */
const GIT_STATUS_TIMEOUT_MS = 5000
const LINE_PREFIX = 'token-goat:'

interface StoredReceipt {
  /** sha256 prefix of the redacted report, trimmed. */
  readonly hash: string
  /** Length of that trimmed report, so a result that continues past it can still be matched on its first `length` characters. */
  readonly length: number
  readonly text: string
}

function reportHash(trimmedReport: string): string {
  return createHash('sha256').update(trimmedReport).digest('hex').slice(0, 16)
}

/** The receipt lines for a verdict, at most three, or an empty list when no red flag fires. */
export function receiptLines(state: VerificationState, claimsChangeWithoutEdit: boolean): string[] {
  const lines: string[] = []
  if (state.failingUnresolved && state.latestRun !== undefined) {
    lines.push(`${LINE_PREFIX} this subagent's last check failed: ${echoedValue(state.latestRun.command)} (exit ${state.latestRun.exitCode}).`)
  }
  if (state.editedSinceLastPass.length > 0) {
    const named = state.editedSinceLastPass.slice(0, MAX_NAMED_FILES).map((name) => nameSubject('file', name)).join(', ')
    const more = state.editedSinceLastPass.length - MAX_NAMED_FILES
    lines.push(`${LINE_PREFIX} this subagent edited after its last passing check: ${named}${more > 0 ? ` (+${more} more)` : ''}.`)
  }
  if (claimsChangeWithoutEdit) lines.push(`${LINE_PREFIX} the report claims a change, but this subagent recorded no edit and the working tree is clean.`)
  return lines
}

/** True when the report claims a change the working tree does not show: an un-negated change verb, no commit claim (a commit leaves a clean tree), and git status clean. */
function claimsChangeTheTreeLacks(report: string, cwd: string | null): boolean {
  if (cwd === null || !claimsUnnegatedChange(report) || claimsCommittedChange(report)) return false
  const result = runGit(['status', '--porcelain'], { cwd, timeoutMs: GIT_STATUS_TIMEOUT_MS })
  return result.exitCode === 0 && result.stdout.trim() === ''
}

/** The receipt text for a subagent that has just stopped, or null when it is clean or the receipt is off. */
export function receiptForStoppedAgent(event: HookEvent, redactedReport: string): string | null {
  const config = loadConfig().hints
  if (!config.agent_receipt || isWithinQuietHours(config.quiet_hours)) return null
  const state = evaluateVerification(sessionStateKey(event))
  const claimsWithoutEdit = !state.editedAnyFile && claimsChangeTheTreeLacks(redactedReport, getCwd(event) || null)
  const lines = receiptLines(state, claimsWithoutEdit)
  return lines.length === 0 ? null : lines.join('\n')
}

function readReceipts(target: string): StoredReceipt[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is StoredReceipt => r !== null && typeof r === 'object' && typeof r.hash === 'string' && typeof r.length === 'number' && typeof r.text === 'string',
    )
  } catch {
    return []
  }
}

function writeReceipts(target: string, receipts: StoredReceipt[]): void {
  try {
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify(receipts.slice(-MAX_RECEIPTS)), 'utf8')
  } catch {
    // Unable to park the receipt: the report goes out without one rather than failing the hook.
  }
}

/** Park `text` for the parent session, to be handed to whoever delivers the report that hashes the same. */
export function parkAgentReceipt(sessionId: string, redactedReport: string, text: string): void {
  const target = sessionSidecarPath(sessionId, RECEIPTS_SUFFIX)
  const trimmed = redactedReport.trim()
  if (target === null || trimmed === '') return
  writeReceipts(target, [...readReceipts(target), { hash: reportHash(trimmed), length: trimmed.length, text }])
}

/** The parked receipt whose report is `resultText`, or that `resultText` begins with (the harness may append its own trailer to a report), consumed so it is delivered once. */
export function takeAgentReceipt(sessionId: string, resultText: string): string | null {
  const target = sessionSidecarPath(sessionId, RECEIPTS_SUFFIX)
  if (target === null) return null
  const receipts = readReceipts(target)
  const trimmed = resultText.trim()
  // A report that continues past the parked one must continue on a new line, so 'report 1' is never taken for the start of 'report 16'.
  const endsReport = (r: StoredReceipt): boolean => r.length === trimmed.length || trimmed[r.length] === '\n' || trimmed[r.length] === '\r'
  const index = receipts.findIndex((r) => r.length <= trimmed.length && endsReport(r) && reportHash(trimmed.slice(0, r.length)) === r.hash)
  if (index < 0) return null
  const [taken] = receipts.splice(index, 1)
  writeReceipts(target, receipts)
  return taken?.text ?? null
}

/** subagent_stop, registered by hooks_agent_spawn.ts, which loads this module on first use to keep it out of the hook entry's eager set: park the receipt for the Agent result the parent is about to get. Copilot CLI delivers it from its own subagentStop rewrite instead (hooks_agent_spawn.ts), so nothing is parked there. */
export function subagentReceiptHandler(event: HookEvent): HookOutput {
  try {
    const raw = event.raw['last_assistant_message']
    if (getHarnessName() === 'copilot_cli' || !event.sessionId || typeof raw !== 'string' || raw === '' || event.raw['stop_hook_active'] === true) return passOutput()
    const report = redactSecrets(raw).text
    const text = receiptForStoppedAgent(event, report)
    if (text !== null) parkAgentReceipt(event.sessionId, report, text)
    return passOutput()
  } catch {
    return passOutput()
  }
}
