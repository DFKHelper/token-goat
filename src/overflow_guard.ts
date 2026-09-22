/**
 * Overflow guard — cap oversized output to protect the model's context.
 *
 * Provides token-count estimation and line-based truncation for safety-net
 * protection against accidentally dumping huge payloads to the model.
 */

import { stripAnsiEscapes } from './render/ansi.js'
import { safeSlice } from './util.js'
import type { ContentClass } from './token_estimate.js'
import { classifyContent, guardDivisor } from './token_estimate.js'

/**
 * Estimate tokens from a character count: ~3 chars/token (conservative).
 *
 * Split out from {@link estimateTokens} so a caller that only has a size -- a byte count read from
 * a file stat or a transcript line length, with no string in hand -- estimates against the same
 * ratio instead of reimplementing it or materializing a throwaway string of that length. The two
 * have drifted apart in this codebase before; this keeps the arithmetic in one place.
 */
/** Never use this to credit a saving. It divides by three at the default class, which over-estimates on purpose: this is an overflow guard's estimator, and guessing high is its safe direction. Crediting a saving reverses that, so savings go through `stats.ts::savedTokensFromBytes` instead. A guard test pins the separation. Pass `cls` when the caller knows the bytes are a dense payload; omitted, it prices them as text, which is what this function has always done. */
export function estimateTokensFromLength(length: number, cls: ContentClass = 'text'): number {
  return Math.max(1, Math.floor(Math.max(0, length) / guardDivisor(cls)) + 1)
}

/**
 * Estimate tokens from text, at ~3 chars/token for ordinary text and ~1.1 for a dense payload.
 * Strips ANSI color codes before counting to avoid inflating token estimates.
 *
 * Classifies rather than taking the class from the caller: this overload is the one that has the string in hand, so the one thing it can do that a byte count cannot is look. A base64 blob costs nearly three times what the flat estimate said, and a guard that under-estimates by that much fires after the context it was protecting is already spent.
 */
export function estimateTokens(text: string): number {
  const stripped = stripAnsiEscapes(text)
  return estimateTokensFromLength(stripped.length, classifyContent(stripped))
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

  // Classify once and spend the same divisor the entry check measured with. These were two different divisors: the check classified, while the char budget below multiplied by guardDivisor()'s `text` default, so a base64 payload was priced at ~1.09 bytes/token on the way in and at 3.0 on the way out. A 1000-token cap then emitted 2583 tokens of it -- an overflow guard overshooting by 2.6x is the one failure it exists to prevent.
  const strippedAll = stripAnsiEscapes(text)
  const contentClass = classifyContent(strippedAll)
  const totalTokens = estimateTokensFromLength(strippedAll.length, contentClass)
  if (totalTokens <= budgetTokens) {
    return text
  }

  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  // A trailing newline leaves an empty piece behind. Counting it inflates the
  // "of N lines" total, and keeping it can spend budget on a blank line.
  const totalLines = lines.length

  const bodyBudget = Math.max(1, budgetTokens - markerMarginTokens)
  const charBudget = bodyBudget * guardDivisor(contentClass)

  const kept: string[] = []
  let used = 0

  for (const ln of lines) {
    const stripped = stripAnsiEscapes(ln)
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
  const charBudget = Math.max(1, budgetTokens * guardDivisor())
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
  if (cmd === 'semantic') {
    return 'Narrow your query text or pass --limit to reduce the number of matches returned.'
  }
  return 'Narrow your query or raise overflow_guard max_tokens in config.'
}
