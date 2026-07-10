/**
 * Overflow guard — cap oversized output to protect the model's context.
 *
 * Provides token-count estimation and line-based truncation for safety-net
 * protection against accidentally dumping huge payloads to the model.
 */

import { stripAnsiCodes } from './bash_compress.js'


const safeSlice = (str: string, endIndex: number): string => {
  // Ensure we don't split a UTF-16 surrogate pair. If the code unit at endIndex
  // is a low surrogate (0xDC00-0xDFFF), back up one so the high surrogate stays with it.
  if (endIndex > 0 && endIndex < str.length) {
    const codeUnit = str.charCodeAt(endIndex)
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      endIndex--
    }
  }
  return str.slice(0, endIndex)
}
/**
 * Estimate tokens from text: ~3 chars/token (conservative).
 * Strips ANSI color codes before counting to avoid inflating token estimates.
 */
export function estimateTokens(text: string): number {
  const stripped = stripAnsiCodes(text)
  return Math.max(1, Math.floor(stripped.length / 3) + 1)
}

/**
 * Result of a guard check: whether text overflows budget and how many lines were kept.
 */
export interface OverflowResult {
  budget: number
  used: number
  over: boolean
  trimmedLines: number
}

/**
 * Check if text exceeds a token budget.
 *
 * @param text The text to check.
 * @param budgetTokens The maximum allowed tokens.
 * @returns OverflowResult with budget info.
 */
export function checkOverflow(text: string, budgetTokens: number): OverflowResult {
  const used = estimateTokens(text)
  return {
    budget: budgetTokens,
    used,
    over: used > budgetTokens,
    trimmedLines: 0,
  }
}

/**
 * Trim text to fit within a token budget, keeping leading lines.
 *
 * Preserves as many leading whole lines as fit within the budget, appending
 * a marker line that explains the cap and suggests remediation.
 *
 * @param text The text to trim.
 * @param budgetTokens The maximum allowed tokens.
 * @param command Optional command label for tailored hint text.
 * @returns Trimmed text with marker, or original text if within budget.
 */
export function trimToBudget(text: string, budgetTokens: number, command?: string): string {
  const markerMarginTokens = 64

  const totalTokens = estimateTokens(text)
  if (totalTokens <= budgetTokens) {
    return text
  }

  const lines = text.split('\n')
  const totalLines = lines.length

  const bodyBudget = Math.max(1, budgetTokens - markerMarginTokens)
  const charBudget = bodyBudget * 3

  const kept: string[] = []
  let used = 0

  for (const ln of lines) {
    const stripped = stripAnsiCodes(ln)
    // Charge the RAW line length, not the ANSI-stripped length: kept.push(ln) below retains
    // the raw (un-stripped) line, so accounting must match what is actually emitted. Charging
    // the stripped length would let ANSI-heavy lines discount bytes that are never removed.
    const cost = ln.length + 1
    if (kept.length === 0 && cost > charBudget) {
      // Slice the stripped string so the budget is measured and cut on visible characters; avoids ANSI bytes silently consuming budget and eliminates dangling escape sequences from a mid-code cut.
      // Use safeSlice to avoid splitting UTF-16 surrogate pairs.
      const truncated = safeSlice(stripped, charBudget)
      kept.push(truncated)
      break
    }
    if (kept.length > 0 && used + cost > charBudget) {
      break
    }
    kept.push(ln)
    used += cost
  }

  const shown = kept.length
  const hint = getHintFor(command)
  const marker = `[token-goat: output capped at ~${budgetTokens} tokens to protect context — showing ${shown} of ${totalLines} lines. ${hint}]`

  return kept.join('\n') + '\n' + marker
}

/**
 * Result of capping a JSON-serializable array to a token budget.
 */
export interface JsonRowCapResult<T> {
  items: T[]
  truncated: boolean
  totalCount: number
}

/**
 * Cap a JSON-serializable array to fit within a token budget, keeping as many leading whole
 * items as fit. Unlike {@link trimToBudget}, this never truncates mid-item -- truncating inside
 * a serialized JSON value would corrupt the payload -- so callers must surface the cap via the
 * returned `truncated` flag (e.g. an added `truncated`/`totalCount` field in the JSON response)
 * rather than a trailing text marker. The first item is always kept even if it alone exceeds the
 * budget, matching {@link trimToBudget}'s "never return nothing" behavior.
 */
export function capJsonRows<T>(items: readonly T[], budgetTokens: number): JsonRowCapResult<T> {
  const totalCount = items.length
  const charBudget = Math.max(1, budgetTokens * 3)
  const kept: T[] = []
  let used = 0
  for (const item of items) {
    const cost = JSON.stringify(item).length + 2
    if (kept.length > 0 && used + cost > charBudget) break
    kept.push(item)
    used += cost
  }
  return { items: kept, truncated: kept.length < totalCount, totalCount }
}

/** Get a tailored remediation hint based on the originating command. */
function getHintFor(command?: string): string {
  const cmd = (command || '').toLowerCase().trim()
  if (cmd === 'symbol') {
    return "Request a specific method (file.py::Class.method) or use --json for structured access."
  }
  if (cmd === 'heading' || cmd === 'section') {
    return "Request a narrower sub-heading, e.g. 'doc.md::Section#2'."
  }
  if (cmd === 'lines') {
    return "Request a smaller line range, e.g. 'file.py@100-150'."
  }
  if (cmd === 'bash-output' || cmd === 'web-output') {
    return "Use --grep PATTERN, --section HEADING, or --tail N to narrow the cached output."
  }
  return 'Narrow your query or raise overflow_guard max_tokens in config.'
}
