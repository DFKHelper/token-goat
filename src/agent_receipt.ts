/** The evidence receipt a subagent's report carries when its own record gives the parent a reason to doubt it: the last check it ran failed, it edited source after its last passing check, or the report claims a change the subagent never made. A clean subagent gets nothing. The verdict is verification_state.ts's, read for the subagent's own session-state key, so there is no second bookkeeping of what it ran. The receipt is computed when the subagent stops and parked in a sidecar of the parent session, keyed by a hash of the redacted report, because the parent's Agent result arrives on a different event and nothing else ties the two. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getHarnessName } from './bridges/registry.js'
import { loadConfig } from './config.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { echoedValue, nameSubject } from './hint_suggestion_guard.js'
import { contextOutput, getCwd, passOutput } from './hooks_common.js'
import { claimsOwnChange } from './change_claim.js'
import { claimsCommittedChange } from './hooks_session.js'
import { redactSecrets } from './secret_redact.js'
import { sessionSidecarPath } from './session_store.js'
import { recordStat } from './stats.js'
import type { HookOutput } from './types.js'
import { atomicWriteText, ensureDirSync, isWithinQuietHours, runGit, withFileLock } from './util.js'
import { evaluateVerification, type VerificationState } from './verification_state.js'

// Not `.json`: sessionSidecarPath refuses any other file ending in `.json`, because every reader that lists the sessions directory takes one to be a session.
const RECEIPTS_SUFFIX = '.agent-receipts'
/** Receipts kept per parent session, oldest dropped first. */
const MAX_RECEIPTS = 16
const MAX_NAMED_FILES = 3
/** A subagent stop is not a hot path, and the 50 ms hint budget is shorter than a cold git start on Windows. */
const GIT_STATUS_TIMEOUT_MS = 5000
const LINE_PREFIX = 'token-goat:'

/** A parked receipt no delivery has claimed within this long is dropped: the report it belonged to was never delivered here (or was delivered unmatched), and a stale receipt must not attach to a later, unrelated report. */
const RECEIPT_TTL_MS = 30 * 60 * 1000
/** The lock beside the receipts, with a name that does not end in `.json` for the same reason. */
const RECEIPTS_LOCK_SUFFIX = '.agent-receipts.lock'
/** A subagent stop is not a hot path, but a hook that waits long on a peer's lock is worse than a missing receipt. */
const RECEIPT_LOCK_WAIT_MS = 2000

interface StoredReceipt {
  /** sha256 prefix of the redacted report, trimmed. */
  readonly hash: string
  /** Length of that trimmed report, so a result that continues past it can still be matched on its first `length` characters. */
  readonly length: number
  readonly text: string
  /** The stopped subagent's own id, when its stop event carried one: the join key two identical reports ("Done.") cannot share. */
  readonly agentId?: string
  /** Epoch milliseconds the receipt was parked. */
  readonly at: number
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

/** True when the report claims a change the working tree does not show: a first-person change claim, no commit claim anywhere (a commit leaves a clean tree, and a stray mention of one only silences the flag, the safe direction), and git status clean. A dirty tree silences it whoever dirtied it, the parent's own work included: the subagent's Bash edits are not recorded, so the tree is the only evidence left, and a missed flag costs less than a false accusation. */
export function claimsChangeTheTreeLacks(report: string, cwd: string | null): boolean {
  if (cwd === null || !claimsOwnChange(report) || claimsCommittedChange(report)) return false
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
    const oldest = Date.now() - RECEIPT_TTL_MS
    return parsed.filter(
      (r): r is StoredReceipt =>
        r !== null && typeof r === 'object' && typeof r.hash === 'string' && typeof r.length === 'number' && typeof r.text === 'string' && typeof r.at === 'number' && r.at >= oldest,
    )
  } catch {
    return []
  }
}

/** Run `work` on the parent session's parked receipts under a cross-process lock and write back what it leaves, atomically, and only when it changed them. A delivery (`create` false) with no sidecar, or one that holds nothing, returns null without taking the lock or touching the disk: most Agent results have nothing parked, and each of those must cost no write. Every hook is its own OS process and two subagents can stop at once, so an unlocked read-modify-write loses one of their receipts. Null when the lock or the sidecar is unavailable: the report goes out without a receipt rather than failing the hook. */
function withReceipts<T>(sessionId: string, create: boolean, work: (receipts: StoredReceipt[]) => T): T | null {
  const target = sessionSidecarPath(sessionId, RECEIPTS_SUFFIX)
  const lockPath = sessionSidecarPath(sessionId, RECEIPTS_LOCK_SUFFIX)
  if (target === null || lockPath === null) return null
  if (!create && (!existsSync(target) || readReceipts(target).length === 0)) return null
  try {
    ensureDirSync(dirname(target))
    const held = withFileLock(
      lockPath,
      () => {
        const receipts = readReceipts(target)
        const before = JSON.stringify(receipts)
        const out = work(receipts)
        const after = JSON.stringify(receipts.slice(-MAX_RECEIPTS))
        if (after !== before) atomicWriteText(target, after)
        return { out }
      },
      { waitMs: RECEIPT_LOCK_WAIT_MS },
    )
    return held === undefined ? null : held.out
  } catch {
    return null
  }
}

/** Park `text` for the parent session, to be handed to whoever delivers the report that hashes the same or that names `agentId`. An empty `text` parks a clean agent: it hands out nothing, but it makes a clean and a flagged agent that returned the same words ambiguous to a delivery that names neither. The text is redacted again here because it carries file names and a command the subagent chose. */
export function parkAgentReceipt(sessionId: string, redactedReport: string, text: string, agentId?: string): void {
  const trimmed = redactedReport.trim()
  if (trimmed === '') return
  const entry: StoredReceipt = { hash: reportHash(trimmed), length: trimmed.length, text: redactSecrets(text).text, at: Date.now(), ...(agentId ? { agentId } : {}) }
  withReceipts(sessionId, true, (receipts) => {
    receipts.push(entry)
  })
}

// The trailer id is taken to be the agent_id the hook payloads carry; tests/agent_receipt.test.ts pins that through the registry, so a host that stops agreeing fails there instead of silently delivering nothing.
const AGENT_ID_TRAILER_RE = /\bagentId:\s*([A-Za-z0-9_-]{6,})/g

/** The id of the agent a Claude Code Agent result names in the trailer it appends to the report (`agentId: <id> (internal ID ...`), or undefined. The last one wins: a report may quote an earlier trailer. */
function trailerAgentId(resultText: string): string | undefined {
  const matches = [...resultText.slice(-600).matchAll(AGENT_ID_TRAILER_RE)]
  return matches.at(-1)?.[1]
}

/** The parked receipt for a delivered report, consumed so it is delivered once. Matched on the subagent's id when the delivery names one (`agentId`, or the trailer of a Claude Code result), because two subagents can return the same words ("Done.") with different verdicts; otherwise on the report text, which `resultText` may continue past on a new line (the harness appends a trailer). A text match that two entries with different verdicts both satisfy (a clean agent's empty entry included) is ambiguous and delivers nothing: a missing receipt is a smaller error than another agent's. A delivery that names an id never takes a receipt parked under a different id. */
export function takeAgentReceipt(sessionId: string, resultText: string, agentId?: string): string | null {
  const trimmed = resultText.trim()
  const wantedId = agentId ?? trailerAgentId(trimmed)
  // A report that continues past the parked one must continue on a new line, so 'report 1' is never taken for the start of 'report 16'.
  const endsReport = (r: StoredReceipt): boolean => r.length === trimmed.length || trimmed[r.length] === '\n' || trimmed[r.length] === '\r'
  const sameText = (r: StoredReceipt): boolean => r.length <= trimmed.length && endsReport(r) && reportHash(trimmed.slice(0, r.length)) === r.hash
  return withReceipts(sessionId, false, (receipts) => {
    const byId = wantedId === undefined ? -1 : receipts.findIndex((r) => r.agentId === wantedId)
    if (byId >= 0 && (agentId !== undefined || sameText(receipts[byId]!))) return receipts.splice(byId, 1)[0]?.text || null
    if (agentId !== undefined) return null
    const candidates = receipts.map((r, i) => ({ r, i })).filter(({ r }) => sameText(r) && (wantedId === undefined || r.agentId === undefined))
    if (candidates.length === 0 || candidates.some(({ r }) => r.text !== candidates[0]!.r.text)) return null
    return receipts.splice(candidates[0]!.i, 1)[0]?.text || null
  })
}

/** subagent_stop, registered by hooks_agent_spawn.ts, which loads this module on first use to keep it out of the hook entry's eager set: park the receipt for the Agent result the parent is about to get. Copilot CLI delivers it from its own subagentStop rewrite instead (hooks_agent_spawn.ts), so nothing is parked there. */
export function subagentReceiptHandler(event: HookEvent): HookOutput {
  try {
    const raw = event.raw['last_assistant_message']
    if (getHarnessName() === 'copilot_cli' || !event.sessionId || typeof raw !== 'string' || raw === '' || event.raw['stop_hook_active'] === true) return passOutput()
    const report = redactSecrets(raw).text
    const text = receiptForStoppedAgent(event, report)
    if (text !== null || loadConfig().hints.agent_receipt) parkAgentReceipt(event.sessionId, report, text ?? '', event.agentId)
    return passOutput()
  } catch {
    return passOutput()
  }
}

/** subagent_stop, registered by hooks_agent_spawn.ts (lazily, with the receipt handler): a subagent whose report claims a change of its own while `git status` shows a clean tree, and does not also claim a commit or push, gets a warning on the operator's stderr. It never changes the stop. */
export function subagentStopHandler(event: HookEvent): HookOutput {
  try {
    const cwd = getCwd(event)
    if (!event.sessionId || !cwd) return passOutput()
    const result = runGit(['status', '--porcelain'], { cwd, timeoutMs: loadConfig().hints.git_hint_max_ms })
    const message = typeof event.raw['last_assistant_message'] === 'string' ? event.raw['last_assistant_message'] : ''
    if (result.exitCode === 0 && result.stdout.trim() === '' && claimsOwnChange(message) && !claimsCommittedChange(message)) {
      console.warn(`subagent-stop: possible hallucination — session=${event.sessionId} but git status is clean`)
    }
    return passOutput()
  } catch {
    return passOutput()
  }
}

/** The `(thread id, report)` pairs of the subagents that finished, read out of a Codex multi-agent v1 `wait_agent` result: `{ status: { <thread id>: { completed: "<report>" } | "running" | ... }, timed_out }` (codex-rs/core/src/tools/handlers/multi_agents/wait.rs:299-302, AgentStatus in codex-rs/protocol/src/protocol.rs:1932-1948). The result may arrive as that JSON text or already parsed. */
function completedSubagents(toolResponse: unknown): Array<{ agentId: string; report: string }> {
  let parsed: unknown = toolResponse
  if (typeof toolResponse === 'string') {
    try {
      parsed = JSON.parse(toolResponse)
    } catch {
      return []
    }
  }
  const status = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['status'] : undefined
  if (status === null || typeof status !== 'object') return []
  const out: Array<{ agentId: string; report: string }> = []
  for (const [agentId, value] of Object.entries(status)) {
    const report = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)['completed'] : undefined
    if (typeof report === 'string' && report !== '') out.push({ agentId, report })
  }
  return out
}

/** The receipts for the subagents a Codex `wait_agent` call just reported finished, keyed on the thread id Codex stamps on the SubagentStop as `agent_id` (codex-rs/core/src/hook_runtime.rs:1056). That is the only delivery point Codex has: its `spawn_agent` returns a handle, not a report, and v2's wait returns a message string only. With more than one finished agent each block opens with the agent it is about. */
export function waitAgentReceipts(sessionId: string, toolResponse: unknown): string[] {
  const finished = completedSubagents(toolResponse)
  const blocks: string[] = []
  for (const { agentId, report } of finished) {
    const text = takeAgentReceipt(sessionId, redactSecrets(report).text, agentId)
    if (text !== null) blocks.push(finished.length > 1 ? `${LINE_PREFIX} agent ${echoedValue(agentId)}:\n${text}` : text)
  }
  return blocks
}

/** post_tool_use for Codex's multi-agent v1 `wait_agent`, registered by hooks_agent_spawn.ts: Codex hands a subagent's report back through that tool, not through `spawn_agent` (which returns a handle), so the receipt parked at the subagent's stop is delivered here, keyed on the thread id of each finished agent. */
export function waitAgentHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) return passOutput()
    const blocks = waitAgentReceipts(event.sessionId, event.raw['tool_response'])
    if (blocks.length === 0) return passOutput()
    recordStat('agent_receipt', 0, 0, undefined, 'agent')
    return contextOutput(blocks.join('\n'))
  } catch {
    return passOutput()
  }
}
