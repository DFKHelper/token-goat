/**
 * `post_tool_use_failure` handler -- the repeat-failure brake.
 *
 * This event exists for exactly one harness. Copilot CLI routes a *failed* tool result to its own
 * `postToolUseFailure` hook instead of `postToolUse`, and that hook accepts only
 * `additionalContext`: `modifiedResult` is documented as not honored there and the bundle agrees,
 * so a failed tool result cannot be fenced, compressed or shrunk on Copilot the way a successful
 * one can. What the event *can* do is confirmed rather than assumed -- Copilot CLI 1.0.80, app.js
 * offset 2043380 either folds `additionalContext` into `textResultForLlm` or pushes
 * `{content, source:'system'}` onto `toolResult.newMessages`, so the text does reach the model.
 *
 * That makes this the one handler in token-goat whose channel *adds* tokens instead of removing
 * them, and it is written accordingly: it is silent unless staying silent is more expensive than
 * speaking. The only case that clears that bar is a repeat -- the same tool failing with the same
 * error a second time, which is the model about to spend another whole tool call re-learning what
 * it already knows. One short line costs ~25 tokens; the retry it prevents costs the call plus its
 * failure text. So the first failure of any signature returns `pass` and writes nothing to the
 * model, the second returns the line, and every later one returns `pass` again -- a signature is
 * advised at most once per session, because a model that ignored the note will ignore it twice.
 *
 * State is a per-session sidecar, the same mechanism `pending_context.ts` uses, and every read and
 * write is fail-soft: a hook that cannot persist its ledger must still return a valid response.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { registerHook, type HookEvent } from './hook_registry.js'
import { contextOutput, getToolName, passOutput } from './hooks_common.js'
import { sessionSidecarPath } from './session_store.js'
import type { HookOutput } from './types.js'

const FAILURE_SUFFIX = '.tool-failures.json'

/**
 * Signatures tracked per session before the oldest is dropped. A ledger is only ever consulted for
 * membership, so the cap bounds the file rather than the usefulness: a session that has produced 64
 * distinct tool failures is not one where remembering the 65th changes an outcome.
 */
export const MAX_TRACKED_FAILURES = 64

/** Truncation point for the error text inside a signature. */
const SIGNATURE_ERROR_CHARS = 200

interface FailureLedger {
  /** Signature -> whether the advisory has already been emitted for it. */
  seen: Record<string, boolean>
  /** Insertion order, oldest first, so the cap can evict deterministically. */
  order: string[]
}

/**
 * Collapse a failed call to a signature that is stable across a retry but distinct across a
 * genuinely different failure. Whitespace is squeezed and the text truncated because the same
 * underlying error frequently arrives with a different wrapping, and a signature that changes on
 * every occurrence would never match itself.
 */
export function failureSignature(toolName: string | undefined, errorText: string): string {
  const tool = toolName === undefined || toolName === '' ? 'unknown' : toolName
  const normalized = errorText.replace(/\s+/g, ' ').trim().slice(0, SIGNATURE_ERROR_CHARS)
  return `${tool} :: ${normalized}`
}

/**
 * Pull the failure text out of the raw event. Copilot's `PostToolUseFailureHookInput` carries a
 * stringified error rather than the tool result, and the field name is not stable across the
 * shapes token-goat's own bridges emit, so several are accepted. Returns '' when none is present,
 * which the caller treats as "nothing to key on".
 */
export function extractFailureText(raw: Record<string, unknown>): string {
  for (const key of ['error', 'errorMessage', 'tool_error', 'toolError', 'message', 'reason']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const response = raw['tool_response'] ?? raw['toolResponse']
  if (typeof response === 'string' && response.trim() !== '') return response
  if (response !== null && typeof response === 'object') {
    const nested = (response as Record<string, unknown>)['error']
    if (typeof nested === 'string' && nested.trim() !== '') return nested
  }
  return ''
}

function ledgerPath(sessionId: string): string | null {
  return sessionSidecarPath(sessionId, FAILURE_SUFFIX)
}

function readLedger(target: string): FailureLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const seen = (parsed as FailureLedger).seen
      const order = (parsed as FailureLedger).order
      if (seen !== null && typeof seen === 'object' && Array.isArray(order)) {
        return { seen: seen as Record<string, boolean>, order: order.filter((k) => typeof k === 'string') }
      }
    }
  } catch {
    // Missing, unreadable or corrupt: start a fresh ledger rather than fail the hook.
  }
  return { seen: {}, order: [] }
}

function writeLedger(target: string, ledger: FailureLedger): void {
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(ledger), 'utf8')
  } catch {
    // Best-effort: a ledger that cannot be stored degrades to "every failure looks like the first",
    // which is the silent direction, never a spurious advisory.
  }
}

/** The advisory itself. Deliberately one line: it rides alongside a failure the model must read anyway. */
export function repeatFailureNotice(toolName: string | undefined): string {
  const tool = toolName === undefined || toolName === '' ? 'This tool' : toolName
  return `[token-goat] ${tool} just failed with the same error as an earlier call this session. Retrying it unchanged will fail the same way -- change the arguments, the tool, or the approach.`
}

export function postToolUseFailureHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) return passOutput()
    const errorText = extractFailureText(event.raw)
    if (errorText === '') return passOutput()

    const target = ledgerPath(event.sessionId)
    if (target === null) return passOutput()

    const toolName = getToolName(event)
    const signature = failureSignature(toolName, errorText)
    const ledger = readLedger(target)
    const priorState = ledger.seen[signature]

    if (priorState === undefined) {
      // First time this exact failure has been seen: record it and stay silent. A one-off failure
      // is information the model already has from the failure text itself.
      ledger.seen[signature] = false
      ledger.order.push(signature)
      while (ledger.order.length > MAX_TRACKED_FAILURES) {
        const evicted = ledger.order.shift()
        if (evicted !== undefined) delete ledger.seen[evicted]
      }
      writeLedger(target, ledger)
      return passOutput()
    }

    if (priorState) return passOutput() // Already advised once; repeating it just costs tokens.

    ledger.seen[signature] = true
    writeLedger(target, ledger)
    return contextOutput(repeatFailureNotice(toolName))
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use_failure', postToolUseFailureHandler)
