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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import { registerHook, type HookEvent } from './hook_registry.js'
import { contextOutput, getFilePath, getToolName, passOutput } from './hooks_common.js'
import { displaySafeText, normalizePath } from './paths.js'
import { redactSecrets } from './secret_redact.js'
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
  // A tool name is not our text: an MCP server chooses the names it advertises, and this notice is delivered in token-goat's own voice, so a server naming a tool after our own marker would otherwise speak through us.
  const tool = toolName === undefined || toolName === '' ? 'This tool' : displaySafeText(toolName)
  return `[token-goat] ${tool} just failed with the same error as an earlier call this session. Retrying it unchanged will fail the same way -- change the arguments, the tool, or the approach.`
}

/** Maximum file size (10 MB) to inspect on an edit failure to avoid memory stalls. */
const MAX_EDIT_DIAGNOSE_BYTES = 10 * 1024 * 1024

/**
 * Inspect an Edit tool failure and generate actionable, surgical guidance.
 *
 * When an agent fails an edit because `old_string` matches multiple locations or zero locations,
 * the raw harness error ("Multiple matches found") provides no line numbers or context, causing
 * blind retry loops. This helper inspects the file on disk to report the exact match counts and
 * line numbers so the agent can disambiguate immediately.
 */
export function diagnoseEditFailure(event: HookEvent, errorText: string): string | null {
  const toolName = getToolName(event)
  if (!toolName || !/^(edit|str_replace_editor)$/i.test(toolName)) {
    return null
  }

  const isMultiple =
    /multiple matches|not unique|found \d+ matches|matches \d+ times|more than one match/i.test(errorText)
  const isNotFound =
    /no match|not found|could not find|zero matches|string to replace.*not found/i.test(errorText)

  if (!isMultiple && !isNotFound) {
    return null
  }

  const filePath =
    getFilePath(event) ?? (typeof event.toolInput['path'] === 'string' ? event.toolInput['path'] : undefined)
  if (!filePath) return null

  const oldString =
    typeof event.toolInput['old_string'] === 'string'
      ? event.toolInput['old_string']
      : typeof event.toolInput['old_str'] === 'string'
        ? event.toolInput['old_str']
        : typeof event.toolInput['target'] === 'string'
          ? event.toolInput['target']
          : undefined

  if (oldString === undefined || oldString === '') return null

  const absPath = normalizePath(filePath)
  if (!existsSync(absPath)) return null

  try {
    const stat = statSync(absPath)
    if (stat.size > MAX_EDIT_DIAGNOSE_BYTES) return null

    const fileContent = readFileSync(absPath, 'utf8')
    const relDisplay = displaySafeText(relative(process.cwd(), absPath).replace(/\\/g, '/') || absPath)

    if (isMultiple) {
      const matchLines: number[] = []
      let pos = 0
      while (pos < fileContent.length) {
        const idx = fileContent.indexOf(oldString, pos)
        if (idx === -1) break
        const line = fileContent.slice(0, idx).split('\n').length
        matchLines.push(line)
        pos = idx + Math.max(1, oldString.length)
      }

      if (matchLines.length > 1) {
        const lineList = matchLines.slice(0, 5).join(', ')
        const overflow = matchLines.length > 5 ? ` (+${matchLines.length - 5} more)` : ''
        return `[token-goat] Edit failed: string matched ${matchLines.length} times in ${relDisplay} on lines ${lineList}${overflow}. Include 2-3 lines of surrounding context to make old_str unique.`
      }
    }

    if (isNotFound) {
      const normOld = oldString.replace(/\r\n/g, '\n')
      const normFile = fileContent.replace(/\r\n/g, '\n')
      if (normFile.includes(normOld)) {
        return `[token-goat] Edit failed: string not found in ${relDisplay}, but matches with normalized line endings. Check CRLF vs LF line endings or whitespace.`
      }

      const firstLine = oldString.split(/\r?\n/)[0]?.trim() ?? ''
      if (firstLine.length >= 10) {
        const fileLines = fileContent.split('\n')
        const similarLines: number[] = []
        for (let i = 0; i < fileLines.length; i++) {
          const lineText = fileLines[i]
          if (lineText !== undefined && lineText.includes(firstLine)) {
            similarLines.push(i + 1)
            if (similarLines.length >= 3) break
          }
        }
        if (similarLines.length > 0) {
          return `[token-goat] Edit failed: string not found in ${relDisplay}. A similar line was found on line ${similarLines.join(', ')} — view that range to copy exact text.`
        }
      }

      return `[token-goat] Edit failed: string not found in ${relDisplay}. View the target lines to copy the exact current content and indentation.`
    }
  } catch {
    // Non-fatal if file reading or parsing fails
  }

  return null
}

export function postToolUseFailureHandler(event: HookEvent): HookOutput {
  try {
    if (!event.sessionId) return passOutput()
    const errorText = extractFailureText(event.raw)
    if (errorText === '') return passOutput()

    const target = ledgerPath(event.sessionId)
    if (target === null) return passOutput()

    const toolName = getToolName(event)
    // Redact before the signature is derived, not after: this signature is the object the ledger persists to disk (writeLedger below), and a tool failure's error text is externally sourced (shell stderr, an MCP tool's own error, a fetch failure) and can carry a credential the failing call happened to echo back.
    const signature = failureSignature(toolName, redactSecrets(errorText).text)
    const ledger = readLedger(target)
    const priorState = ledger.seen[signature]

    const editDiagnostic = diagnoseEditFailure(event, errorText)

    if (priorState === undefined) {
      // First time this exact failure has been seen: record it.
      ledger.seen[signature] = false
      ledger.order.push(signature)
      while (ledger.order.length > MAX_TRACKED_FAILURES) {
        const evicted = ledger.order.shift()
        if (evicted !== undefined) delete ledger.seen[evicted]
      }
      writeLedger(target, ledger)

      // If this is an actionable edit failure (e.g. multiple matches or not found),
      // advise immediately on the first occurrence so the agent does not enter a blind retry loop.
      if (editDiagnostic !== null) {
        ledger.seen[signature] = true
        writeLedger(target, ledger)
        return contextOutput(editDiagnostic)
      }

      return passOutput()
    }

    if (priorState) return passOutput() // Already advised once; repeating it just costs tokens.

    ledger.seen[signature] = true
    writeLedger(target, ledger)

    if (editDiagnostic !== null) {
      return contextOutput(editDiagnostic)
    }

    return contextOutput(repeatFailureNotice(toolName))
  } catch {
    return passOutput()
  }
}

registerHook('post_tool_use_failure', postToolUseFailureHandler)
