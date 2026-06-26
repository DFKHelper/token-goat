/**
 * Overflow guard — cap oversized output to protect the model's context.
 *
 * Provides token-count estimation and line-based truncation for safety-net
 * protection against accidentally dumping huge payloads to the model.
 */

import { stripAnsiCodes } from './bash_compress.js'

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
    const cost = stripped.length + 1
    if (kept.length === 0 && cost > charBudget) {
      const truncated = stripped.slice(0, charBudget)
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
    return "Request a smaller line range, e.g. 'file.py::100-150'."
  }
  if (cmd === 'bash-output' || cmd === 'web-output') {
    return "Use --grep PATTERN, --section HEADING, or --tail N to narrow the cached output."
  }
  return 'Narrow your query or raise overflow_guard max_tokens in config.'
}
