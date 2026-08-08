/**
 * Deterministic, structural compression for MCP tool results.
 *
 * Two independent reduction passes, tried in order, first one to produce
 * output wins:
 *
 * 1. Table-ify -- any JSON array of homogeneous plain objects (every element
 *    sharing the exact same key set) is rewritten as a compact tab-delimited
 *    table -- one header row instead of every key name repeated per element,
 *    which is where most of an MCP list/search result's bytes go for shapes
 *    like `[{owner,repo,name,url}, ...]`. Columns whose value is identical
 *    across every row (a constant `status: "open"` on every item, say) are
 *    lifted out of the table body into a single `constant:` line instead of
 *    being repeated per row too.
 * 2. Prune-empty -- for any JSON object or array (including the arrays the
 *    table pass rejects), recursively drop `null`, `""`, `[]`, and `{}`
 *    values to a fixed point (a container that becomes empty once its own
 *    children are dropped is itself dropped), then render the remainder as
 *    compact JSON with a trailing summary line naming how many values were
 *    removed. `0` and `false` are meaningful values, never dropped.
 *
 * Both passes are deliberately conservative and return `null` (untouched)
 * rather than guessing at a shape-specific transform when they don't apply
 * or don't pay off. {@link hooks_mcp.ts}'s `postMcpHandler` is the only
 * caller; see its doc comment for why this stays a pair of generic
 * structural passes rather than per-server parsing packs.
 */

/** Below this size a result is never worth the compression pass at all. Despite the name, gates on `.length` (UTF-16 code units) like the rest of this file's savings-ratio math, not true UTF-8 byte count -- unlike mcp_cache.ts's MCP_MAX_CACHE_BYTES, which uses Buffer.byteLength. */
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

/**
 * Render a cell value as a single line of text; objects/arrays fall back to compact JSON.
 * Embedded tabs/newlines/CRs are replaced with spaces -- otherwise a value containing one
 * would silently shift later columns out of alignment with the header (a literal tab) or
 * split into extra unindexed lines that read as additional table rows (a literal newline),
 * corrupting the one-row-per-array-element structure a reader of the table assumes.
 */
function cellText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value.replace(/[\t\r\n]+/g, ' ')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Same tab/newline sanitization as {@link cellText}, but for a JSON object key rendered into the header row or `constant:` line -- a key containing a literal tab/newline (legal JSON, however unlikely) would otherwise misalign the header the same way an unsanitized value would. */
function cellKey(key: string): string {
  return key.replace(/[\t\r\n]+/g, ' ')
}

/**
 * Table-ify pass: `parsed` must be a JSON array of at least {@link MIN_ROWS}
 * homogeneous plain objects and the result must save at least
 * {@link MIN_SAVINGS_RATIO} of `resultText`'s bytes. Returns `null` when the
 * shape doesn't match (not an array, elements aren't uniform objects) or
 * when compression would not pay off.
 */
function compressAsTable(parsed: unknown, resultText: string): string | null {
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
  // Every row identical on every field: naming the fields once already says everything the table would, so let the caller fall back to raw text.
  if (variableCols.length === 0) return null

  const lines: string[] = []
  if (constantCols.length > 0) {
    const constantParts = constantCols.map((k) => `${cellKey(k)}=${cellText(rows[0]?.[k])}`)
    lines.push(`constant: ${constantParts.join(', ')}`)
  }
  lines.push(variableCols.map(cellKey).join('\t'))
  for (const row of rows) {
    lines.push(variableCols.map((k) => cellText(row[k])).join('\t'))
  }
  const compressed = lines.join('\n')

  if (compressed.length > resultText.length * (1 - MIN_SAVINGS_RATIO)) return null
  return compressed
}

/** How deep a JSON structure is allowed to nest before the prune-empty pass bails to `null` instead of recursing, so a pathological payload can't blow the call stack. */
const MAX_PRUNE_DEPTH = 200

/** Above this many UTF-16 code units the prune-empty pass bails to `null` rather than walking the whole tree, so an enormous payload can't run unbounded work on every hook call. */
const MAX_PRUNE_INPUT_CHARS = 2_000_000

/** True for the values this pass treats as emptiness: `null`, `""`, `[]`, `{}`. `0` and `false` are deliberately excluded -- they are meaningful values, not emptiness. */
function isEmptyValue(value: unknown): boolean {
  if (value === null) return true
  if (value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

/** True once `value` nests deeper than {@link MAX_PRUNE_DEPTH}; bails out on the first branch that trips the bound rather than walking the whole tree. */
function exceedsMaxDepth(value: unknown, depth: number): boolean {
  if (depth > MAX_PRUNE_DEPTH) return true
  if (Array.isArray(value)) return value.some((v) => exceedsMaxDepth(v, depth + 1))
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => exceedsMaxDepth(v, depth + 1))
  }
  return false
}

/**
 * Recursively drop {@link isEmptyValue} entries from `value` and return the
 * pruned structure, incrementing `counter.dropped` once per dropped key
 * (object) or element (array). Children are pruned before their parent is
 * tested for emptiness, so a container that becomes empty only after its own
 * children were dropped collapses too in this single pass -- no separate
 * fixed-point loop is needed.
 */
function pruneEmpty(value: unknown, counter: { dropped: number }): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const el of value) {
      const prunedEl = pruneEmpty(el, counter)
      if (isEmptyValue(prunedEl)) counter.dropped++
      else out.push(prunedEl)
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const prunedV = pruneEmpty(v, counter)
      if (isEmptyValue(prunedV)) counter.dropped++
      else out[key] = prunedV
    }
    return out
  }
  return value
}

/**
 * Prune-empty pass: `parsed` must be a JSON object or array and the result
 * must save at least {@link MIN_SAVINGS_RATIO} of `resultText`'s bytes.
 * Renders the pruned structure as compact JSON via the same `JSON.stringify`
 * escaping the rest of this codebase relies on for string safety -- this
 * output is a JSON document, not a tab-delimited table, so `cellText`/
 * `cellKey`'s tab/newline sanitization (built for keeping table columns
 * aligned) does not apply here. Returns `null` when nothing was dropped, when
 * the payload is too deep or too large to walk, or when pruning would not
 * pay off.
 */
function compressByPruningEmpty(parsed: unknown, resultText: string): string | null {
  if (parsed === null || typeof parsed !== 'object') return null
  if (resultText.length > MAX_PRUNE_INPUT_CHARS) return null
  if (exceedsMaxDepth(parsed, 0)) return null

  const counter = { dropped: 0 }
  const pruned = pruneEmpty(parsed, counter)
  if (counter.dropped === 0) return null

  const rendered = JSON.stringify(pruned)
  const summary = `dropped ${counter.dropped} empty value${counter.dropped === 1 ? '' : 's'} (null, "", [], {})`
  const compressed = `${rendered}\n${summary}`

  if (compressed.length > resultText.length * (1 - MIN_SAVINGS_RATIO)) return null
  return compressed
}

/**
 * Compress `resultText` via whichever pass applies -- table-ify first, then
 * prune-empty. Returns `null` when neither pass matches the shape (not JSON,
 * or a shape both passes reject) or when neither compression pays off.
 */
export function compressMcpResult(resultText: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return null
  }

  const tableResult = compressAsTable(parsed, resultText)
  if (tableResult !== null) return tableResult

  return compressByPruningEmpty(parsed, resultText)
}
