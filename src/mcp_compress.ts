/**
 * Deterministic, structural compression for MCP tool results.
 *
 * Generic pass, not tool-specific parsing: any JSON array of homogeneous
 * plain objects (every element sharing the exact same key set) is rewritten
 * as a compact tab-delimited table -- one header row instead of every key
 * name repeated per element, which is where most of an MCP list/search
 * result's bytes go for shapes like `[{owner,repo,name,url}, ...]`. Columns
 * whose value is identical across every row (a constant `status: "open"` on
 * every item, say) are lifted out of the table body into a single
 * `constant:` line instead of being repeated per row too.
 *
 * Deliberately conservative: anything that is not a JSON array, an array of
 * non-object elements, or an array whose elements don't share an identical
 * key set returns `null` (untouched) rather than guessing at a shape-specific
 * transform. {@link hooks_mcp.ts}'s `postMcpHandler` is the only caller; see
 * its doc comment for why this stays a single generic structural pass rather
 * than per-server parsing packs.
 */

/** Below this size a result is never worth the compression pass at all. */
export const MCP_COMPRESS_MIN_BYTES = 2000

/** Fewer rows than this and a table header buys nothing over the raw JSON. */
const MIN_ROWS = 3

/**
 * Compression must earn its keep: a transform that doesn't shrink the text by
 * at least this fraction isn't worth the "which shape am I looking at" tax it
 * adds for the model reading it, so the caller falls back to the original
 * text instead.
 */
const MIN_SAVINGS_RATIO = 0.15

/** True when every element of `b` appears in `a` and the two are the same length. */
function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((k) => setA.has(k))
}

/** Render a cell value as a single line of text; objects/arrays fall back to compact JSON. */
function cellText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Compress `resultText` when it is a JSON array of at least {@link MIN_ROWS}
 * homogeneous plain objects and doing so saves at least
 * {@link MIN_SAVINGS_RATIO} of its bytes. Returns `null` when the shape
 * doesn't match (not JSON, not an array, elements aren't uniform objects) or
 * when compression would not pay off.
 */
export function compressMcpResult(resultText: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < MIN_ROWS) return null
  if (!parsed.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) return null
  const rows = parsed as Array<Record<string, unknown>>

  const firstKeys = Object.keys(rows[0] as Record<string, unknown>)
  if (firstKeys.length === 0) return null
  if (!rows.every((r) => sameKeySet(firstKeys, Object.keys(r)))) return null

  const constantCols: string[] = []
  const variableCols: string[] = []
  for (const key of firstKeys) {
    const firstVal = cellText(rows[0]?.[key])
    const isConstant = rows.every((r) => cellText(r[key]) === firstVal)
    if (isConstant) constantCols.push(key)
    else variableCols.push(key)
  }
  // Every row identical on every field: naming the fields once already says
  // everything the table would, so let the caller fall back to raw text.
  if (variableCols.length === 0) return null

  const lines: string[] = []
  if (constantCols.length > 0) {
    const constantParts = constantCols.map((k) => `${k}=${cellText(rows[0]?.[k])}`)
    lines.push(`constant: ${constantParts.join(', ')}`)
  }
  lines.push(variableCols.join('\t'))
  for (const row of rows) {
    lines.push(variableCols.map((k) => cellText(row[k])).join('\t'))
  }
  const compressed = lines.join('\n')

  if (compressed.length > resultText.length * (1 - MIN_SAVINGS_RATIO)) return null
  return compressed
}
