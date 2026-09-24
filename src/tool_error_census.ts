/** Per-tool and per-model tool-error census behind `session-audit --tool-errors`. Every `is_error` tool result in the corpus classified by {@link classifyToolError}, the same table the live failure brake reads, so the report and the brake never disagree about what a failure is. */

import { displaySafeText } from './paths.js'
import { classifyToolError, CONTENT_DELIVERED_REASON, errorPrefix, type ToolErrorFlags } from './tool_error_class.js'

/** One tool's or one model's row. */
export interface ToolErrorTally {
  readonly name: string
  /** tool_use invocations seen (unique tool_use ids). */
  calls: number
  /** Tool results carrying `is_error: true`. */
  errors: number
  /** Errors no pattern names. */
  unknown: number
  /** `is_error` results that were a token-goat deny delivering the content ({@link CONTENT_DELIVERED_REASON}): the call did its job, so they are left out of `errors` and the rate. */
  delivered: number
  /** Errors per expected reason. */
  readonly expected: Record<string, number>
}

export interface UnknownErrorPrefix {
  readonly tool: string
  /** {@link errorPrefix}: first line with paths, quoted text and digits masked. */
  readonly prefix: string
  count: number
}

export interface ToolErrorCensus {
  /** Sorted by errors, then calls, descending; complete, including tools that never failed. */
  readonly byTool: ToolErrorTally[]
  /** Same order as byTool; the model is the assistant message's `model` field on the line that issued the call. */
  readonly byModel: ToolErrorTally[]
  /** The {@link UNKNOWN_PREFIX_LIMIT} most frequent unknown prefixes: the list a new pattern is promoted from. */
  readonly unknownPrefixes: UnknownErrorPrefix[]
}

/** Accumulates while the corpus streams. Methods rather than free functions so session_audit.ts can hold one through a type-only import and load this module, with the Bash command parser the classifier pulls in, only when a scan runs rather than on every CLI start. */
export interface ToolErrorAccumulator {
  /** `model` is absent when the issuing line named none, or the result's tool_use was never seen. */
  countCall(tool: string, model: string | undefined): void
  countError(tool: string, model: string | undefined, errorText: string, flags: ToolErrorFlags): void
  /** Sorts what was counted into a {@link ToolErrorCensus}. */
  finish(): ToolErrorCensus
}

/** How many unknown prefixes the census keeps, in JSON as in text: enough to show what to classify next without printing the corpus's error text wholesale. */
export const UNKNOWN_PREFIX_LIMIT = 20

/** Expected reasons printed per text row; the rest are summed into one `+N more` figure, and JSON carries every reason. */
const REASONS_PER_ROW = 4

/** The model label for a call whose issuing line named no model, or a result whose tool_use was never seen. */
const UNKNOWN_MODEL = '(unknown)'

function tally(map: Map<string, ToolErrorTally>, name: string): ToolErrorTally {
  let row = map.get(name)
  if (row === undefined) {
    row = { name, calls: 0, errors: 0, unknown: 0, delivered: 0, expected: {} }
    map.set(name, row)
  }
  return row
}

/** Code-unit order rather than localeCompare, so the report is byte-identical on every machine. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortTallies(map: Map<string, ToolErrorTally>): ToolErrorTally[] {
  return [...map.values()].sort((a, b) => b.errors - a.errors || b.calls - a.calls || byCodeUnit(a.name, b.name))
}

export function newToolErrorAccumulator(): ToolErrorAccumulator {
  const tools = new Map<string, ToolErrorTally>()
  const models = new Map<string, ToolErrorTally>()
  const unknownPrefixes = new Map<string, UnknownErrorPrefix>()
  return {
    countCall(tool, model) {
      tally(tools, tool).calls += 1
      tally(models, model ?? UNKNOWN_MODEL).calls += 1
    },
    countError(tool, model, errorText, flags) {
      const verdict = classifyToolError(tool, errorText, flags)
      const rows = [tally(tools, tool), tally(models, model ?? UNKNOWN_MODEL)]
      if (verdict.reason === CONTENT_DELIVERED_REASON) {
        for (const row of rows) row.delivered += 1
        return
      }
      for (const row of rows) {
        row.errors += 1
        if (verdict.kind === 'unknown') row.unknown += 1
        else row.expected[verdict.reason] = (row.expected[verdict.reason] ?? 0) + 1
      }
      if (verdict.kind !== 'unknown') return
      const prefix = errorPrefix(errorText)
      const key = `${tool}\u0000${prefix}`
      const hit = unknownPrefixes.get(key)
      if (hit === undefined) unknownPrefixes.set(key, { tool, prefix, count: 1 })
      else hit.count += 1
    },
    finish() {
      const topUnknown = [...unknownPrefixes.values()].sort((a, b) => b.count - a.count || byCodeUnit(a.tool, b.tool) || byCodeUnit(a.prefix, b.prefix)).slice(0, UNKNOWN_PREFIX_LIMIT)
      return { byTool: sortTallies(tools), byModel: sortTallies(models), unknownPrefixes: topUnknown }
    },
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function rate(errors: number, calls: number): string {
  return calls === 0 ? '-' : `${((errors / calls) * 100).toFixed(1)}%`
}

function reasonsCell(expected: Record<string, number>): string {
  const ranked = Object.entries(expected).sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
  const shown = ranked.slice(0, REASONS_PER_ROW).map(([reason, n]) => `${reason} ${fmt(n)}`)
  const rest = ranked.slice(REASONS_PER_ROW).reduce((sum, [, n]) => sum + n, 0)
  if (rest > 0) shown.push(`+${fmt(rest)} more`)
  return shown.join(', ')
}

/** Width of a name column: its longest entry, since an MCP tool name runs past any fixed width. */
function columnWidth(names: readonly string[], header: string): number {
  return names.reduce((w, n) => Math.max(w, n.length), header.length)
}

function tableLines(rows: readonly ToolErrorTally[]): string[] {
  const failing = rows.filter((r) => r.errors > 0)
  // A tool or model name is third-party text: an MCP server chooses its tool names.
  const names = failing.map((r) => displaySafeText(r.name))
  const width = columnWidth(names, 'name')
  const out = [`${'name'.padEnd(width)} ${'calls'.padStart(9)} ${'errors'.padStart(7)} ${'rate'.padStart(6)} ${'unknown'.padStart(7)}  expected, by reason`]
  failing.forEach((r, i) => out.push(`${names[i]!.padEnd(width)} ${fmt(r.calls).padStart(9)} ${fmt(r.errors).padStart(7)} ${rate(r.errors, r.calls).padStart(6)} ${fmt(r.unknown).padStart(7)}  ${reasonsCell(r.expected)}`.trimEnd()))
  if (failing.length < rows.length) out.push(`(${fmt(rows.length - failing.length)} more ran without an error)`)
  return out
}

/** The one line naming the delivered denies left out of the error counts, per tool, or nothing when there were none. */
function deliveredLines(rows: readonly ToolErrorTally[]): string[] {
  const delivering = rows.filter((r) => r.delivered > 0).sort((a, b) => b.delivered - a.delivered || byCodeUnit(a.name, b.name))
  if (delivering.length === 0) return []
  const total = delivering.reduce((sum, r) => sum + r.delivered, 0)
  return [`Content delivered by a token-goat deny, not counted as errors: ${fmt(total)} (${delivering.map((r) => `${displaySafeText(r.name)} ${fmt(r.delivered)}`).join(', ')}).`]
}

/** Render the census. Deterministic for a given corpus: no runtime, no corpus path, and every tie broken by name. */
export function formatToolErrorCensus(census: ToolErrorCensus, scope: { readonly filesScanned: number; readonly windowDays: number }): string {
  const calls = census.byTool.reduce((sum, r) => sum + r.calls, 0)
  const errors = census.byTool.reduce((sum, r) => sum + r.errors, 0)
  const unknown = census.byTool.reduce((sum, r) => sum + r.unknown, 0)
  const toolWidth = columnWidth(census.unknownPrefixes.map((p) => displaySafeText(p.tool)), '')
  const window = scope.windowDays === 0 ? 'all time' : `transcripts modified in the last ${fmt(scope.windowDays)} days`
  const lines = [
    `# Tool errors (${fmt(scope.filesScanned)} transcripts, ${window})`,
    `Calls ${fmt(calls)}, errors ${fmt(errors)} (${rate(errors, calls)}), unknown ${fmt(unknown)}. Expected means a named failure shape in tool_error_class.ts; unknown is everything else.`,
    ...deliveredLines(census.byTool),
    '',
    '## By tool',
    ...tableLines(census.byTool),
    '',
    '## By model',
    ...tableLines(census.byModel),
    '',
    '## Top unknown error prefixes (paths, quoted text and digits masked)',
    ...census.unknownPrefixes.map((p) => `${fmt(p.count).padStart(7)}  ${displaySafeText(p.tool).padEnd(toolWidth)} ${displaySafeText(p.prefix)}`),
  ]
  if (census.unknownPrefixes.length === 0) lines.push('(none)')
  return lines.join('\n')
}
