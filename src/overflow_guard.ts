/** Overflow guard — cap oversized output to protect the model's context. Provides token-count estimation and line-based truncation for safety-net protection against accidentally dumping huge payloads to the model. */

import { stripAnsiEscapes } from './render/ansi.js'
import { safeSlice } from './util.js'
import { forClient } from './mcp_client_text.js'
import { canQuoteArg, echoedValue, fencedCommand, quotedArg } from './hint_suggestion_guard.js'
import type { ContentClass } from './token_estimate.js'
import { classifyContent, guardDivisor } from './token_estimate.js'

/** Estimate tokens from a character count: ~3 chars/token (conservative). Split out from {@link estimateTokens} so a caller that only has a size -- a byte count read from a file stat or a transcript line length, with no string in hand -- estimates against the same ratio instead of reimplementing it or materializing a throwaway string of that length. The two have drifted apart in this codebase before; this keeps the arithmetic in one place. */
/** Never use this to credit a saving. It divides by three at the default class, which over-estimates on purpose: this is an overflow guard's estimator, and guessing high is its safe direction. Crediting a saving reverses that, so savings go through `stats.ts::savedTokensFromBytes` instead. A guard test pins the separation. Pass `cls` when the caller knows the bytes are a dense payload; omitted, it prices them as text, which is what this function has always done. */
export function estimateTokensFromLength(length: number, cls: ContentClass = 'text'): number {
  return Math.max(1, Math.floor(Math.max(0, length) / guardDivisor(cls)) + 1)
}

/** Estimate tokens from text, at ~3 chars/token for ordinary text and ~1.1 for a dense payload. Strips ANSI color codes before counting to avoid inflating token estimates. Classifies rather than taking the class from the caller: this overload is the one that has the string in hand, so the one thing it can do that a byte count cannot is look. A base64 blob costs nearly three times what the flat estimate said, and a guard that under-estimates by that much fires after the context it was protecting is already spent. */
export function estimateTokens(text: string): number {
  const stripped = stripAnsiEscapes(text)
  return estimateTokensFromLength(stripped.length, classifyContent(stripped))
}

/** Trim text to fit within a token budget, keeping leading lines. Preserves as many leading whole lines as fit within the budget, appending a marker line that explains the cap and suggests remediation. @param text The text to trim. @param budgetTokens The maximum allowed tokens. @param command Optional command label for tailored hint text. @param opts.reserveTokens Tokens of the budget a caller will spend around the result (a fence's tags and notice), kept out of both the entry check and the body; the marker still names `budgetTokens`. @returns Trimmed text with marker, or original text if within budget. */
export function trimToBudget(text: string, budgetTokens: number, command?: string, opts: { reserveTokens?: number } = {}): string {
  const markerMarginTokens = 64
  const reserve = Math.max(0, opts.reserveTokens ?? 0)

  // Classify once and spend the same divisor the entry check measured with. These were two different divisors: the check classified, while the char budget below multiplied by guardDivisor()'s `text` default, so a base64 payload was priced at ~1.09 bytes/token on the way in and at 3.0 on the way out. A 1000-token cap then emitted 2583 tokens of it -- an overflow guard overshooting by 2.6x is the one failure it exists to prevent.
  const strippedAll = stripAnsiEscapes(text)
  const contentClass = classifyContent(strippedAll)
  const totalTokens = estimateTokensFromLength(strippedAll.length, contentClass)
  if (totalTokens <= budgetTokens - reserve) {
    return text
  }

  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  // A trailing newline leaves an empty piece behind. Counting it inflates the "of N lines" total, and keeping it can spend budget on a blank line.
  const totalLines = lines.length

  const bodyBudget = Math.max(1, budgetTokens - markerMarginTokens - reserve)
  const charBudget = bodyBudget * guardDivisor(contentClass)

  const kept: string[] = []
  let used = 0

  for (const ln of lines) {
    const stripped = stripAnsiEscapes(ln)
    // Charge the RAW line length, not the ANSI-stripped length: kept.push(ln) below retains the raw (un-stripped) line, so accounting must match what is actually emitted. Charging the stripped length would let ANSI-heavy lines discount bytes that are never removed.
    const cost = ln.length + 1
    if (kept.length === 0 && cost > charBudget) {
      // Slice the stripped string so the budget is measured and cut on visible characters; avoids ANSI bytes silently consuming budget and eliminates dangling escape sequences from a mid-code cut. Use safeSlice to avoid splitting UTF-16 surrogate pairs.
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

  return kept.join('\n') + '\n' + forClient(marker)
}

/** Characters of a token-goat command's own answer that stay inline in Claude Code's Bash tool. CAPTURE from this machine's session transcripts on Claude Code 2.1.29x: results up to 26,588 characters came back inline, while one whose stdout reached 29,926 was persisted to a file and the model shown a 2 KB preview of it. A token-goat answer past that line cost the agent a second call to read the persisted file, and often a third: `section` returned 52.5 KB, `skill-body humanizer` 49 KB and `bash-output --file --grep` 48 KB. 24,000 leaves room for the continuation notice and for stderr. */
export const HARNESS_INLINE_CEILING_CHARS = 24_000

/** Characters a `token-goat read "file@A-B"` header costs, kept out of a continuation range so the read it names fits the ceiling too. */
const READ_HEADER_RESERVE_CHARS = 120

/** How many leading `lines`, joined with line breaks, fit in `maxChars`. Never fewer than one, so a capped answer is never empty; a single line longer than the ceiling is the caller's to cut. */
export function linesWithinChars(lines: readonly string[], maxChars: number): number {
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    used += lines[i]!.length + (i > 0 ? 1 : 0)
    if (used > maxChars) return Math.max(1, i)
  }
  return lines.length
}

/** `lines`, which are lines `firstLine` on of `file`, cut to the leading lines that fit `maxChars` less `reserve` (what the caller prints around them) with room for a closing notice, which names the next part as a `token-goat read "file@A-B"` whose range fits the ceiling itself. Null when the lines already fit. `what` names the output in the notice ("section", "skill body"). A path no quote mark holds in both shells gets the line range without the command. */
export function capFileLines(allLines: readonly string[], firstLine: number, file: string, maxChars: number, what: string, reserve = 0): { kept: string[]; lastLine: number; notice: string } | null {
  if (allLines.join('\n').length + reserve <= maxChars) return null
  // Text ending in a line break splits into a trailing "" that is no line of the file; counting it would page one line past the end.
  const lines = allLines.length > 1 && allLines[allLines.length - 1] === '' ? allLines.slice(0, -1) : allLines
  const kept = lines.slice(0, linesWithinChars(lines, maxChars - reserve - (300 + file.length)))
  const lastLine = firstLine + kept.length - 1
  const finalLine = firstLine + lines.length - 1
  const nextEnd = lastLine + linesWithinChars(lines.slice(kept.length), maxChars - READ_HEADER_RESERVE_CHARS)
  const head = `[token-goat: ${what} capped at ${maxChars} chars to stay under the harness's inline output limit; showing lines ${firstLine}-${lastLine} of ${firstLine}-${finalLine}.`
  const next = canQuoteArg(file)
    ? ` Next part: ${fencedCommand(`token-goat read ${quotedArg(`${file}@${lastLine + 1}-${nextEnd}`)}`)}${nextEnd < finalLine ? `, then on to line ${finalLine}` : ''}.]`
    : ` The rest is lines ${lastLine + 1}-${finalLine} of ${echoedValue(file)}.]`
  return { kept, lastLine, notice: forClient(head + next) }
}

/** Result of capping a JSON-serializable array to a token budget. */
export interface JsonRowCapResult<T> {
  items: T[]
  truncated: boolean
  totalCount: number
}

/** Cap a JSON-serializable array to fit within a token budget, keeping as many leading whole items as fit. Unlike {@link trimToBudget}, this never truncates mid-item -- truncating inside a serialized JSON value would corrupt the payload -- so callers must surface the cap via the returned `truncated` flag (e.g. an added `truncated`/`totalCount` field in the JSON response) rather than a trailing text marker. The first item is always kept even if it alone exceeds the budget, matching {@link trimToBudget}'s "never return nothing" behavior. */
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
