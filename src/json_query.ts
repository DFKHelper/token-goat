/** Narrow structural summary + path-based extraction for `token-goat json-outline` / `json-query`, so a multi-thousand-line JSON document never needs a full `Read` just to answer "what does this contain" or "what's at path X". Deliberately no JSONPath/jq compatibility -- a dot-path with `[n]` index, `[a:b]` slice, `[*]` wildcard, and filter segments (`[field=value]`, comparisons, text matches, presence, `&&` / `||`) covers the common case, matching the project's "no premature abstraction" bar (see csv_query.ts for the same philosophy applied to CSV). `json-query` is the general-purpose sibling of `config-get`'s JSON branch: config-get only resolves a single dotted key to a scalar (no array indexing/wildcard/filter), which is enough for flat config lookups. json-query adds array navigation and filtering on top, for querying JSON data files rather than config. */

import { echoedValue } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { countNoun, pushAll } from './util.js'
import { levenshteinDistance } from './util_suggest.js'

export type JsonValueType = 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object'

export function jsonType(value: unknown): JsonValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as JsonValueType
}

export interface JsonFieldSummary {
  name: string
  type: JsonValueType
  size?: number
}

function fieldSummary(name: string, value: unknown): JsonFieldSummary {
  const type = jsonType(value)
  if (type === 'array') return { name, type, size: (value as unknown[]).length }
  if (type === 'object') return { name, type, size: Object.keys(value as Record<string, unknown>).length }
  return { name, type }
}

export interface JsonOutlineArray {
  kind: 'array'
  length: number
  elementType: JsonValueType | 'mixed' | 'unknown'
  sampleKeys?: JsonFieldSummary[]
  heterogeneous?: boolean
}

export interface JsonOutlineObject {
  kind: 'object'
  fields: JsonFieldSummary[]
  /** Set when `keyFilter` narrowed `fields`: the substring asked for and how many keys the object holds in all. */
  filter?: { needle: string; total: number }
}

export interface JsonOutlinePrimitive {
  kind: 'primitive'
  type: JsonValueType
}

export type JsonOutline = JsonOutlineArray | JsonOutlineObject | JsonOutlinePrimitive

/** Structural summary of a parsed JSON document: for an array, element count plus the merged key set / type shape of the first `sampleSize` elements (and whether that shape varies across the sample); for an object, each top-level key's type and (for arrays/objects) size; for a scalar, just its type. Mirrors what `outline`/`skeleton` do for source symbols, but for JSON structure instead of code. `keyFilter` keeps only the object keys containing it, case-insensitively, so a registry of hundreds of entries can be narrowed to the few an agent is after without listing them all. */
export function outlineJson(data: unknown, opts: { sampleSize?: number; keyFilter?: string } = {}): JsonOutline {
  const sampleSize = opts.sampleSize ?? 5
  const type = jsonType(data)

  if (type === 'array') {
    const arr = data as unknown[]
    const sample = arr.slice(0, sampleSize)
    const elementTypes = new Set(sample.map(jsonType))
    const elementType: JsonOutlineArray['elementType'] =
      elementTypes.size === 0 ? 'unknown' : elementTypes.size === 1 ? ([...elementTypes][0] as JsonValueType) : 'mixed'

    const result: JsonOutlineArray = { kind: 'array', length: arr.length, elementType }

    if (elementType === 'object') {
      const objects = sample as Array<Record<string, unknown>>
      const keySets = objects.map((el) => Object.keys(el))
      const allKeys = [...new Set(keySets.flat())]
      // Report each key's type/size from whichever sampled element actually has it, not just the first element -- a key that's absent on the first element but present on a later one (a heterogeneous sample) would otherwise be misreported as type 'undefined'.
      result.sampleKeys = allKeys.map((k) => {
        const owner = objects.find((el) => Object.prototype.hasOwnProperty.call(el, k))
        return fieldSummary(k, owner?.[k])
      })
      const firstKeySet = keySets[0] ?? []
      result.heterogeneous = keySets.some((ks) => ks.length !== firstKeySet.length || !ks.every((k) => firstKeySet.includes(k)))
    }
    return result
  }

  if (type === 'object') {
    const obj = data as Record<string, unknown>
    const keys = Object.keys(obj)
    const needle = opts.keyFilter?.toLowerCase()
    if (needle === undefined) return { kind: 'object', fields: keys.map((k) => fieldSummary(k, obj[k])) }
    const kept = keys.filter((k) => k.toLowerCase().includes(needle))
    return { kind: 'object', fields: kept.map((k) => fieldSummary(k, obj[k])), filter: { needle: opts.keyFilter as string, total: keys.length } }
  }

  return { kind: 'primitive', type }
}

export function formatJsonOutline(outline: JsonOutline): string {
  if (outline.kind === 'primitive') return `(scalar ${outline.type})`

  if (outline.kind === 'object') {
    const { filter } = outline
    const tally = filter === undefined ? '' : `(${outline.fields.length} of ${filter.total} keys contain ${echoedValue(filter.needle)})`
    if (outline.fields.length === 0) return filter === undefined ? '(empty object)' : tally
    // A JSON object key may hold a newline, and this listing is one entry per line: unescaped, a key could add a line of its own that reads exactly like another field of the document.
    const lines = outline.fields.map((f) => `${displaySafeText(f.name)}: ${f.type}${f.size !== undefined ? ` (${f.size})` : ''}`)
    return (filter === undefined ? lines : [...lines, tally]).join('\n')
  }

  const lines = [`array of ${outline.length} element${outline.length === 1 ? '' : 's'} (${outline.elementType})`]
  if (outline.sampleKeys !== undefined) {
    lines.push(outline.heterogeneous === true ? 'keys (from first elements, shape varies across sample):' : 'keys (from first elements):')
    for (const f of outline.sampleKeys) {
      lines.push(`  ${displaySafeText(f.name)}: ${f.type}${f.size !== undefined ? ` (${f.size})` : ''}`)
    }
  }
  return lines.join('\n')
}

export interface ProjectionObjectField {
  targetKey: string
  sourcePath: string
}

export type FilterOperator = '=' | '!=' | '<' | '<=' | '>' | '>=' | '*=' | '^=' | '$='

/** The right side of a comparison. `text` is what was written (unquoted, unescaped); `number` is set only for an unquoted literal that is a plain decimal, and `typed` only for an unquoted null, true or false. A quoted literal is neither: it is always text. */
export interface FilterLiteral {
  text: string
  quoted: boolean
  number: number | null
  typed: 'null' | 'true' | 'false' | null
}

/** One condition of a filter. `field` null means the element itself (`@`). `plainField` is set on `*=`, `^=` and `$=`: before those operators existed `[price$=7]` read a key named `price$`, so an element that has that key is still compared by plain equality on it. */
export type FilterCondition =
  | { kind: 'exists'; field: string }
  | { kind: 'absent'; field: string }
  | { kind: 'compare'; field: string | null; op: FilterOperator; value: FilterLiteral; caseInsensitive: boolean; plainField?: string }

/** A filter expression: conditions joined by `&&` (binds tighter) and `||`. `source` is the condition as written, for the miss notice. */
export type FilterNode =
  | { kind: 'cond'; cond: FilterCondition; source: string }
  | { kind: 'and' | 'or'; terms: FilterNode[] }

export type PathOp =
  | { kind: 'key'; name: string }
  | { kind: 'recursive_key'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start: number | null; end: number | null }
  | { kind: 'wildcard' }
  | { kind: 'filter'; field: string; value: string }
  | { kind: 'where'; expr: FilterNode; source: string }
  | { kind: 'project_list'; fields: string[] }
  | { kind: 'project_object'; fields: ProjectionObjectField[] }

export const MAX_RECURSIVE_NODES = 50_000
export const MAX_RECURSIVE_DEPTH = 100
/* Deliberately no ceiling on the number of items a query returns. It was tried and removed: `..key` pushes at most once per node it visits, so a recursive result is already bounded by MAX_RECURSIVE_NODES, and `[*]` yields references into a document that is already parsed and already in memory, so a fan-out can never be longer than the document's own node count and costs a pointer each. A cap there bought nothing and broke the guarantee the large-array tests in tests/json_query.test.ts pin, that a wildcard over a 200,000-element array returns all 200,000. What reaches a caller is capped downstream by the overflow guard and `--head`. */

/** One query's remaining allowance, threaded through the whole evaluation rather than held in a local by the function that spends it. {@link collectRecursiveKey} kept its own counter, and `evalJsonPath` calls it once per item an earlier segment fanned out to, so the ceiling multiplied by that fan-out: measured on a 532,931-byte document, `..a..a..blob` reached 408,510 collected items in 9,180 ms, eight times the ceiling the constant names. `exhausted` rides along because a bound that stops quietly returns a short list no caller can tell from a complete one. */
interface QueryBudget {
  nodesLeft: number
  exhausted: boolean
}

/** `seen` stays per-call, deliberately, while `budget` is the query's: it exists to stop a cycle inside ONE walk, and sharing it across the roots a fan-out produced would silently drop values that are genuinely reachable from the second root. The budget is the opposite -- the whole point is that every root spends from the same allowance. */
function collectRecursiveKey(root: unknown, keyName: string, out: unknown[], budget: QueryBudget): void {
  const seen = new Set<object>()

  function walk(val: unknown, depth: number): void {
    if (depth > MAX_RECURSIVE_DEPTH) {
      // Not a silent return. A target below this depth is invisible to the query, and `items: []` is exactly what a misspelled key returns, so without the flag the caller is told "no such key" about a document that has it.
      budget.exhausted = true
      return
    }
    if (val === null || typeof val !== 'object') return
    if (seen.has(val)) return
    seen.add(val)

    if (budget.nodesLeft <= 0) {
      budget.exhausted = true
      return
    }
    budget.nodesLeft--

    // Abandoning the rest of a node's children is the one exhaustion the entry guard above cannot see, because it fires by NOT calling walk again. The `remaining` test keeps it honest: a document whose last node lands exactly on the final unit of budget has had nothing cut from it, and reporting that as truncated would cry wolf on every document that happens to fit.
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        walk(val[i], depth + 1)
        if (budget.nodesLeft <= 0) {
          if (i < val.length - 1) budget.exhausted = true
          return
        }
      }
    } else {
      const obj = val as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(obj, keyName)) {
        out.push(obj[keyName])
      }
      const keys = Object.keys(obj)
      for (let i = 0; i < keys.length; i++) {
        walk(obj[keys[i] as string], depth + 1)
        if (budget.nodesLeft <= 0) {
          if (i < keys.length - 1) budget.exhausted = true
          return
        }
      }
    }
  }

  walk(root, 0)
}

/** Own keys only, at both steps. `in` and a bare property read both see the prototype chain, so `[constructor.name=Object]` resolved to `'Object'` on every plain object in an array and the filter matched all of them -- a filter that selects everything is worse than one that selects nothing, because it looks like data. A document parsed from JSON never puts a data key on the chain, so nothing legitimate is lost by refusing to look there. */
function getNestedField(obj: unknown, fieldPath: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, fieldPath)) {
    return (obj as Record<string, unknown>)[fieldPath]
  }
  const normalized = fieldPath.replace(/^\[(\d+)\]/, '$1').replace(/\[(\d+)\]/g, '.$1')
  const parts = normalized.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      const idx = Number(part)
      if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) {
        cur = cur[idx]
        continue
      }
      return undefined
    }
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function splitByUnquotedChar(str: string, delimiter: string): string[] {
  const parts: string[] = []
  let inQuote: string | null = null
  let depth = 0
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inQuote !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inQuote) {
        inQuote = null
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === '[' || ch === '{') {
      depth++
    } else if (ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
    } else if (ch === delimiter && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts
}

function unquoteIfQuoted(str: string): string {
  const trimmed = str.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.length >= 2) {
      return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1')
    }
  }
  return trimmed
}

function cleanFieldPath(str: string): string {
  let cleaned = str.trim()
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    return unquoteIfQuoted(cleaned)
  }
  if (cleaned.startsWith('.')) {
    cleaned = cleaned.slice(1).trim()
  }
  return cleaned
}

function getLeafKeyName(str: string): string {
  const trimmed = str.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquoteIfQuoted(trimmed)
  }
  let path = trimmed
  if (path.startsWith('.')) path = path.slice(1).trim()
  const lastDot = path.lastIndexOf('.')
  return lastDot !== -1 ? path.slice(lastDot + 1) : path
}

function isValidFieldPath(str: string): boolean {
  const trimmed = str.trim()
  if (!trimmed) return false
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return true
  }
  return /^(\.)?[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(trimmed)
}

function parseListProjectionFields(inner: string, fullSpec: string): string[] {
  const rawParts = splitByUnquotedChar(inner, ',')
  const fields: string[] = []
  for (const raw of rawParts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const source = cleanFieldPath(trimmed)
    if (!source) {
      throw new Error(`invalid list projection ${echoedValue('[' + inner + ']')} in path spec ${echoedValue(fullSpec)}: empty field expression`)
    }
    fields.push(source)
  }
  if (fields.length === 0) {
    throw new Error(`invalid list projection ${echoedValue('[' + inner + ']')} in path spec ${echoedValue(fullSpec)}: must specify at least one field`)
  }
  return fields
}

function parseObjectProjectionFields(inner: string, fullSpec: string): ProjectionObjectField[] {
  const rawParts = splitByUnquotedChar(inner, ',')
  const fields: ProjectionObjectField[] = []
  for (const raw of rawParts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const colonParts = splitByUnquotedChar(trimmed, ':')
    if (colonParts.length === 1) {
      const source = cleanFieldPath(colonParts[0]!.trim())
      if (!source) {
        throw new Error(`invalid object projection ${echoedValue('{' + inner + '}')} in path spec ${echoedValue(fullSpec)}: empty field expression`)
      }
      const target = getLeafKeyName(colonParts[0]!.trim())
      fields.push({ targetKey: target, sourcePath: source })
    } else if (colonParts.length === 2) {
      const rawTarget = colonParts[0]!.trim()
      const rawSource = colonParts[1]!.trim()
      const target = unquoteIfQuoted(rawTarget)
      const source = cleanFieldPath(rawSource)
      if (!target || !source) {
        throw new Error(`invalid object projection field ${echoedValue(trimmed)} in ${echoedValue('{' + inner + '}')} of path spec ${echoedValue(fullSpec)}`)
      }
      fields.push({ targetKey: target, sourcePath: source })
    } else {
      throw new Error(`invalid object projection field ${echoedValue(trimmed)} in ${echoedValue('{' + inner + '}')} of path spec ${echoedValue(fullSpec)}: multiple colons`)
    }
  }
  if (fields.length === 0) {
    throw new Error(`invalid object projection ${echoedValue('{' + inner + '}')} in path spec ${echoedValue(fullSpec)}: must specify at least one field`)
  }
  return fields
}

const EXPECTED_BRACKET = 'expected [n], [a:b], [*], ["key"], or a filter such as [field=value]; filter operators are = != < <= > >= *= ^= $= (an i after a quoted value ignores case), [field] and [!field] test presence, [@>3] tests the element itself, and && or || combine conditions'

function badBracket(inner: string, spec: string, reason?: string): Error {
  const detail = reason === undefined ? EXPECTED_BRACKET : `${reason}; ${EXPECTED_BRACKET}`
  return new Error(`invalid bracket expression ${echoedValue('[' + inner + ']')} in path spec: ${echoedValue(spec)} (${detail})`)
}

/** Most conditions one bracket may hold, so a pasted-in blob cannot make every element pay for thousands of tests. */
const MAX_FILTER_TERMS = 64

const SLICE_BRACKET = /^(?:(-?\d+)\s*)?:(?:\s*(-?\d+))?$/

/** A plain decimal: no hex, no blanks, no empty string, which `Number()` would read as 0. */
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** A whole quoted literal, optionally followed by the case-insensitive flag: `"Bob"`, `'Bob' i`. */
const QUOTED_LITERAL = /^(["'])((?:\\.|(?!\1)[^\\])*)\1(\s+i)?$/

const ORDERING_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['<', '<=', '>', '>='])

const TEXT_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['*=', '^=', '$='])

/** The characters that, directly before an `=`, make a two-character operator: `!=`, `<=`, `>=`, `*=`, `^=`, `$=`, `~=`. */
const OPERATOR_PREFIX = '!<>*^$~'

/** The operator characters a key could end in before this grammar: `n*==x` was an equality on the key `n*`, so a second `=` keeps it one. */
const LEGACY_KEY_SUFFIX = '*^$~'

/** What a piece of a `&&` / `||` split must start with to count as a test of its own: `!field`, or a field, a quoted field or `@` followed by an operator. `npm test` and a bare `b` do not, so they stay part of a plain value. */
const CONDITION_PIECE = /^(?:!\s*[^\s=<>!"'&|]+|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s=<>!"'&|]+)\s*(?:[!<>*^$~=]?=|[<>]))/

/** Splits `str` at every `token` that sits outside quotes. */
function splitOnUnquotedToken(str: string, token: string): string[] {
  const parts: string[] = []
  let inQuote: string | null = null
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inQuote !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inQuote) inQuote = null
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (str.startsWith(token, i)) {
      parts.push(str.slice(start, i))
      i += token.length - 1
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts
}

/** The operator of one condition, outside quotes. The first `=` decides, as it always has: `tag=<b>` is an equality on the value `<b>`, and `a<b=1` one on a key named `a<b`; the character before that `=` makes it `!=`, `<=`, `>=`, `*=`, `^=`, `$=` or `~=` instead. With no `=`, the first `<` or `>`. */
function findFilterOperator(expr: string): { index: number; token: string } | null {
  let inQuote: string | null = null
  let angle = -1
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i] as string
    if (inQuote !== null) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '=') {
      if (i > 0 && OPERATOR_PREFIX.includes(expr[i - 1] as string) && !(expr[i + 1] === '=' && LEGACY_KEY_SUFFIX.includes(expr[i - 1] as string))) return { index: i - 1, token: `${expr[i - 1] as string}=` }
      return expr[i + 1] === '=' ? { index: i, token: '==' } : { index: i, token: '=' }
    }
    if ((ch === '<' || ch === '>') && angle === -1) angle = i
  }
  return angle === -1 ? null : { index: angle, token: expr[angle] as string }
}

/** The bracket as the original grammar read it, `^([^=]+)==?(.*)$`: the field up to the first `=`, the value the rest, quotes and all. Null when that grammar did not take it as an equality (an operator character ends the field, either side starts with a quote, or the field is `@`). */
function plainEquality(expr: string): { field: string; value: string } | null {
  const eq = splitEquality(expr)
  return eq === null || /^["']/.test(eq.value) ? null : eq
}

/** The original grammar's equality including a quoted value, which it stripped of its quotes: the exact meaning of the shapes that stay legacy once an operator character ends the key (`n*==x`, `n*=`, `x~="y"`). */
function legacyEquality(expr: string): { field: string; value: string } | null {
  const eq = splitEquality(expr)
  return eq === null ? null : { field: eq.field, value: unquoteIfQuoted(eq.value) }
}

function splitEquality(expr: string): { field: string; value: string } | null {
  const m = /^([^=]+)==?(.*)$/.exec(expr)
  if (m === null) return null
  let field = (m[1] as string).trim()
  if (field.startsWith('@.')) field = field.slice(2).trim()
  const value = (m[2] as string).trim()
  if (field === '' || field === '@' || /^["']/.test(field) || /[!<>]$/.test(field)) return null
  return { field, value }
}

/** True when a lone condition is one of the original equalities whose key is or ends in `*`, `^`, `$` or `~` and so could read as an operator: `n*==x`, `*=x`, an empty value (`n*=`), or any `~=`, which is not an operator. */
function isLegacyOperatorKey(text: string): boolean {
  const found = findFilterOperator(text)
  if (found === null) return false
  if (found.token === '==') return found.index > 0 && LEGACY_KEY_SUFFIX.includes(text[found.index - 1] as string)
  if (found.token === '~=') return true
  if (found.token !== '*=' && found.token !== '^=' && found.token !== '$=') return false
  const key = text.slice(0, found.index).trim()
  return key === '' || key === '@.' || text.slice(found.index + 2).trim() === ''
}

function isFilterExpression(expr: string): boolean {
  return expr.startsWith('!') || findFilterOperator(expr) !== null || splitOnUnquotedToken(expr, '&&').length > 1 || splitOnUnquotedToken(expr, '||').length > 1
}

/** The field a presence test names, or null when `body` is not a field path. */
function existenceField(body: string): string | null {
  let text = body.trim()
  if (text.startsWith('@.')) text = text.slice(2).trim()
  if (!isValidFieldPath(text)) return null
  return cleanFieldPath(text)
}

/** The field written left of an operator: null for `@` (the element itself), the path for `@.path`, the unquoted name for a quoted one. */
function filterFieldName(raw: string): string | null {
  const text = raw.trim()
  if (text === '@') return null
  return cleanFieldPath(text.startsWith('@.') ? text.slice(2) : text)
}

function parseFilterLiteral(raw: string, op: FilterOperator, token: string, inner: string, spec: string): { value: FilterLiteral; caseInsensitive: boolean } {
  const v = raw.trim()
  const quoted = QUOTED_LITERAL.exec(v)
  if (quoted !== null) {
    return { value: { text: (quoted[2] as string).replace(/\\(["'\\])/g, '$1'), quoted: true, number: null, typed: null }, caseInsensitive: quoted[3] !== undefined }
  }
  if (v.startsWith('"') || v.startsWith("'")) {
    if (/^(["'])(?:\\.|(?!\1)[^\\])*\1\s+\S/.test(v)) throw badBracket(inner, spec, 'only a lowercase i may follow a quoted value')
    throw badBracket(inner, spec, 'unbalanced quote around the value')
  }
  if (op !== '=' && !TEXT_OPERATORS.has(op) && /^[<>=]/.test(v)) throw badBracket(inner, spec, `unsupported comparison operator ${echoedValue(token + (v[0] as string))}; to compare against text that starts with ${echoedValue(v[0] as string)}, quote the value`)
  if (v === '' && op !== '=' && op !== '!=') throw badBracket(inner, spec, `operator ${echoedValue(token)} needs a value after it`)
  const number = NUMBER_TEXT.test(v) && Number.isFinite(Number(v)) ? Number(v) : null
  const typed = v === 'null' || v === 'true' || v === 'false' ? v : null
  if (typed !== null && ORDERING_OPERATORS.has(op)) throw badBracket(inner, spec, `${echoedValue(token)} cannot order against ${typed}`)
  return { value: { text: v, quoted: false, number, typed }, caseInsensitive: false }
}

function parseFilterTerm(term: string, inner: string, spec: string): FilterNode {
  const text = term.trim()
  if (text === '') throw badBracket(inner, spec, 'a condition is empty next to && or ||')
  const found = findFilterOperator(text)
  if (found === null) {
    const negated = text.startsWith('!')
    const field = existenceField(negated ? text.slice(1) : text)
    if (field === null) throw badBracket(inner, spec, presenceReason(text))
    return { kind: 'cond', cond: { kind: negated ? 'absent' : 'exists', field }, source: text }
  }
  if (found.token === '~=') throw badBracket(inner, spec, 'regular-expression matching (~=) is not supported')
  const op = (found.token === '==' ? '=' : found.token) as FilterOperator
  const rawField = text.slice(0, found.index).trim()
  const field = filterFieldName(rawField)
  if (rawField === '' || field === '') throw badBracket(inner, spec, `operator ${echoedValue(found.token)} has no field before it`)
  const { value, caseInsensitive } = parseFilterLiteral(text.slice(found.index + found.token.length), op, found.token, inner, spec)
  const cond: CompareCondition = { kind: 'compare', field, op, value, caseInsensitive }
  if (TEXT_OPERATORS.has(op) && field !== null && !/^["']/.test(rawField)) cond.plainField = `${rawField.startsWith('@.') ? rawField.slice(2).trim() : rawField}${found.token[0] as string}`
  return { kind: 'cond', cond, source: text }
}

/** Why a bare name was refused as a presence test, when it looks like a name at all: only plain names go unquoted. */
function presenceReason(text: string): string | undefined {
  return /^!?[^\s=<>]+$/.test(text) ? 'a presence test spells a name with punctuation in quotes, as [@."first-name"] or [!"first-name"]' : undefined
}

/** Parses one bracket's filter. A lone `field=value` stays the original `filter` op, so everything written before this grammar grew parses to the same op it always did. `&&` and `||` split the bracket only when every piece is a test of its own; otherwise the bracket is the original equality and its value runs to the closing bracket, so `[run=npm ci && npm test]` still looks for that text. */
function parseFilterOp(expr: string, inner: string, spec: string): PathOp {
  let terms = 0
  const build = (t: string): FilterNode => {
    if (++terms > MAX_FILTER_TERMS) throw badBracket(inner, spec, `more than ${MAX_FILTER_TERMS} conditions`)
    return parseFilterTerm(t, inner, spec)
  }
  const groups = splitOnUnquotedToken(expr, '||').map((group) => splitOnUnquotedToken(group, '&&'))
  // A lone `[key~=value]`, `[key*==x]` or `[key$=]` was equality on a key ending in that character before the operator existed, so it stays that, quoted value or not; only inside a combination is `~=` refused.
  const lone = groups.length === 1 && (groups[0] as string[]).length === 1 && isLegacyOperatorKey(expr.trim()) ? legacyEquality(expr) : null
  if (lone !== null) return { kind: 'filter', field: lone.field, value: lone.value }
  const plain = groups.length > 1 || (groups[0] as string[]).length > 1 ? plainEquality(expr) : null
  if (plain !== null && !groups.every((g) => g.every((piece) => CONDITION_PIECE.test(piece.trim())))) return { kind: 'filter', field: plain.field, value: plain.value }
  const alternatives = groups.map((group): FilterNode => {
    const parts = group.map(build)
    return parts.length === 1 ? (parts[0] as FilterNode) : { kind: 'and', terms: parts }
  })
  const node: FilterNode = alternatives.length === 1 ? (alternatives[0] as FilterNode) : { kind: 'or', terms: alternatives }
  if (node.kind === 'cond' && node.cond.kind === 'compare' && node.cond.op === '=' && node.cond.field !== null && !node.cond.caseInsensitive) {
    return { kind: 'filter', field: node.cond.field, value: node.cond.value.text }
  }
  return { kind: 'where', expr: node, source: expr }
}

/** Parses a dot-path query spec into a sequence of ops. Grammar: `(..key|key)(.key)*`, each key followed by zero or more bracket segments: `[n]` index (negative counts from the end), `[a:b]` slice (`[:b]`, `[a:]`), `[*]` wildcard, `["key"]` literal key, and filters that keep array elements: `[field=value]` (text equality, so `[x=1]` matches 1 and "1"), `!=`, `<`, `<=`, `>`, `>=` (numbers compare as numbers, anything else as text), `*=` contains, `^=` starts with, `$=` ends with, `[name*="bob" i]` ignores case, `[field]` / `[!field]` presence, `[@>3]` the element itself, and `&&` / `||` to combine (`&&` binds tighter) when every piece is a test of its own; an unquoted `[field=value]` is otherwise the original equality and its value runs to the closing bracket, `&&` included, so `[run=npm ci && npm test]` still means that text. `[@."first-name"]` tests presence of a key that is not a plain name. `..key` searches every nested level. An empty spec means the whole document. Examples: `data.items[3].name`, `items[*].id`, `items[status=active]`, `items[price>=10 && stock>0].name`, `items[-1]`, `..raw`. */
export function parseJsonPath(spec: string): PathOp[] {
  const ops: PathOp[] = []
  const n = spec.length
  let i = 0
  while (i < n) {
    if (spec[i] === '.' && i + 1 < n && spec[i + 1] === '.') {
      i += 2
      let j = i
      while (j < n && spec[j] !== '.' && spec[j] !== '[' && spec[j] !== '{' && spec[j] !== '|') j++
      // Trailing blanks belong to the separator after the name, as for a bare key below: `..address | city` names `address`.
      const name = spec.slice(i, j).trimEnd()
      if (name === '') throw new Error(`invalid path spec: expected property name after '..' in ${echoedValue(spec)}`)
      ops.push({ kind: 'recursive_key', name })
      i = j
      continue
    }
    const ch = spec[i]
    if (ch === '.') {
      i++
      continue
    }
    if (ch === '|') {
      i++
      while (i < n && (spec[i] === ' ' || spec[i] === '\t')) i++
      if (i < n && spec[i] === '.') i++
      continue
    }
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '{') {
      let inQuote: string | null = null
      let depth = 1
      let close = -1
      for (let k = i + 1; k < n; k++) {
        const c = spec[k]
        if (inQuote !== null) {
          if (c === '\\') {
            k++
            continue
          }
          if (c === inQuote) {
            inQuote = null
          }
        } else if (c === '"' || c === "'") {
          inQuote = c
        } else if (c === '{') {
          depth++
        } else if (c === '}') {
          depth--
          if (depth === 0) {
            close = k
            break
          }
        }
      }
      if (close === -1) throw new Error(`invalid path spec: unterminated '{' in ${echoedValue(spec)}`)
      const inner = spec.slice(i + 1, close)
      const fields = parseObjectProjectionFields(inner, spec)
      ops.push({ kind: 'project_object', fields })
      i = close + 1
      continue
    }
    if (ch === '[') {
      const isDottedPrefix = i > 0 && spec[i - 1] === '.'
      let inQuote: string | null = null
      let depth = 1
      let close = -1
      for (let k = i + 1; k < n; k++) {
        const c = spec[k]
        if (inQuote !== null) {
          if (c === '\\') {
            k++
            continue
          }
          if (c === inQuote) {
            inQuote = null
          }
        } else if (c === '"' || c === "'") {
          inQuote = c
        } else if (c === '[') {
          depth++
        } else if (c === ']') {
          depth--
          if (depth === 0) {
            close = k
            break
          }
        }
      }
      if (close === -1) {
        // A quote left open swallows the closing bracket, so name the bracket as far as its first `]`, which is what the person wrote.
        if (inQuote !== null) {
          const firstClose = spec.indexOf(']', i + 1)
          throw badBracket(spec.slice(i + 1, firstClose === -1 ? n : firstClose), spec, 'unbalanced quote')
        }
        throw new Error(`invalid path spec: unterminated '[' in ${echoedValue(spec)}`)
      }
      const inner = spec.slice(i + 1, close)
      const trimmedInner = inner.trim()
      if (trimmedInner === '' || trimmedInner === '*') {
        ops.push({ kind: 'wildcard' })
      } else if (/^\s*(["'])(?:\\.|(?!\1)[^\\])*\1\s*$/.test(inner)) {
        // A quoted segment is a literal key, the only way to address one holding a dot or a space: a bare segment ends at the first `.`, so `a.b` always meant two keys and a key named `a.b` had no spelling at all.
        const quoted = inner.trim()
        ops.push({ kind: 'key', name: quoted.slice(1, -1).replace(/\\(["'\\])/g, '$1') })
      } else if (/^-?\d+$/.test(inner)) {
        ops.push({ kind: 'index', index: Number(inner) })
      } else {
        const commaParts = splitByUnquotedChar(inner, ',')
        if (commaParts.length > 1) {
          ops.push({ kind: 'project_list', fields: parseListProjectionFields(inner, spec) })
        } else {
          let expr = inner.trim()
          if (expr.startsWith('?(') && expr.endsWith(')')) {
            expr = expr.slice(2, -1).trim()
          }
          if (expr.startsWith('@.')) {
            expr = expr.slice(2).trim()
          }
          const slice = SLICE_BRACKET.exec(expr)
          if (slice !== null) {
            ops.push({ kind: 'slice', start: slice[1] === undefined ? null : Number(slice[1]), end: slice[2] === undefined ? null : Number(slice[2]) })
          } else if (isFilterExpression(expr)) {
            ops.push(parseFilterOp(expr, inner, spec))
          } else if (isDottedPrefix || expr.startsWith('.') || (i === 0 && isValidFieldPath(expr))) {
            ops.push({ kind: 'project_list', fields: [cleanFieldPath(expr)] })
          } else {
            // A bare field after a key is a presence test, `items[price]`; at the start of a path or after a dot it stays the one-field projection above.
            const field = existenceField(expr)
            if (field === null) throw badBracket(inner, spec, presenceReason(expr))
            ops.push({ kind: 'where', expr: { kind: 'cond', cond: { kind: 'exists', field }, source: expr }, source: expr })
          }
        }
      }
      i = close + 1
      continue
    }
    let j = i
    while (j < n && spec[j] !== '.' && spec[j] !== '[' && spec[j] !== '{' && spec[j] !== '|') j++
    // The scan stops only at a separator, so untrimmed, the space written before a pipe (`org | {name, tier}`) would become part of the key and fail the lookup; a key that really ends in whitespace is spelled as a quoted segment, `["org "]`.
    const name = spec.slice(i, j).trimEnd()
    if (name === '') throw new Error(`invalid path spec: ${echoedValue(spec)}`)
    ops.push({ kind: 'key', name })
    i = j
  }
  return ops
}

export interface JsonQueryResult {
  /** True once a wildcard or filter op has fanned the traversal out to multiple items. */
  fanned: boolean
  /** Current matched values. Single-element and non-fanned means "one scalar result". */
  items: unknown[]
  /** True when one of this module's ceilings stopped the evaluation, so `items` is a prefix of the answer rather than the answer. Always present, never left undefined on the complete case: a field that appears only on failure is one every caller forgets to read. */
  truncated: boolean
  /** Set when a fanned query ends with no items: which step left nothing, and what it reached, so a front-end can say why instead of printing an empty line. */
  emptiedBy?: string
}

function describeValue(value: unknown, withArticle: boolean): string {
  const a = (word: string, article: string): string => (withArticle ? `${article} ${word}` : word)
  if (Array.isArray(value)) return value.length === 0 ? a('empty array', 'an') : withArticle ? `an array of ${value.length}` : 'array'
  if (value !== null && typeof value === 'object') return Object.keys(value).length === 0 ? a('empty object', 'an') : a('object', 'an')
  const type = jsonType(value)
  return type === 'null' ? 'null' : a(type, 'a')
}

function describeReached(inputs: readonly unknown[]): string {
  if (inputs.length === 1) return `the value it reached is ${describeValue(inputs[0], true)}`
  const subject = inputs.length === 2 ? 'both values it reached are' : `the ${inputs.length} values it reached are`
  // Each kind of value once, in first-seen order, with how many there were and the first one (for its "an object" / "an array of 3" spelling when there is only one).
  const groups = new Map<string, { count: number; first: unknown }>()
  for (const v of inputs) {
    const label = describeValue(v, false)
    const g = groups.get(label)
    if (g) g.count++
    else groups.set(label, { count: 1, first: v })
  }
  if (groups.size === 1) {
    const label = [...groups.keys()][0] as string
    return `${subject} ${inputs.length === 2 ? '' : 'all '}${label}s`
  }
  const parts = [...groups].map(([label, g]) => (g.count === 1 ? describeValue(g.first, true) : countNoun(g.count, label)))
  return `${subject} ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`
}

type CompareCondition = Extract<FilterCondition, { kind: 'compare' }>

/** A number for a JSON number or a string that is plainly one (`"10"`), else null. */
function numericValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && NUMBER_TEXT.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** The text of a string, number or boolean; null for null, objects and arrays, which a text match never reads. */
function scalarText(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null
}

/** The text `=` compares, as `String()` reads it, or null when it cannot be read: an object that has its own `toString` key makes `String()` throw, and a value no one can read is neither equal nor unequal to anything, so every operator treats it as no match. */
function stringifyValue(v: unknown): string | null {
  try {
    return String(v)
  } catch {
    return null
  }
}

/** `=` compares the text of the value, as it always has, so `[x=1]` matches 1 and "1" and `[x=true]` matches true and "true"; `!=` is exactly its complement, so a missing field passes it. The ordering operators compare numbers as numbers when the literal is an unquoted number and the value is one, and as text otherwise; a null, boolean, object or missing value is never ordered. */
function testCompare(c: CompareCondition, val: unknown, op: FilterOperator = c.op): boolean {
  const fold = (s: string): string => (c.caseInsensitive ? s.toLowerCase() : s)
  const lit = c.value
  switch (op) {
    case '=': {
      const text = val === undefined ? null : stringifyValue(val)
      return text !== null && fold(text) === fold(lit.text)
    }
    case '!=': {
      if (val === undefined) return true
      const text = stringifyValue(val)
      return text !== null && fold(text) !== fold(lit.text)
    }
    case '*=':
    case '^=':
    case '$=': {
      const text = scalarText(val)
      if (text === null) return false
      const hay = fold(text)
      const needle = fold(lit.text)
      return op === '*=' ? hay.includes(needle) : op === '^=' ? hay.startsWith(needle) : hay.endsWith(needle)
    }
    default: {
      let order: number
      const n = !lit.quoted && lit.number !== null ? numericValue(val) : null
      if (n !== null && lit.number !== null) {
        order = n < lit.number ? -1 : n > lit.number ? 1 : 0
      } else {
        if (typeof val !== 'string' && typeof val !== 'number') return false
        const a = fold(String(val))
        const b = fold(lit.text)
        order = a < b ? -1 : a > b ? 1 : 0
      }
      return op === '<' ? order < 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : order >= 0
    }
  }
}

/** A field condition reads only object elements (own keys, via getNestedField); `@` reads any element. */
function testCondition(cond: FilterCondition, el: unknown): boolean {
  if (cond.kind === 'compare' && cond.field === null) {
    // Before `@` named the element, `[@=x]` read a key called `@` (JSON-LD), so an object that has one is still compared by it.
    if (cond.op === '=' && el !== null && typeof el === 'object' && !Array.isArray(el)) {
      const own = getNestedField(el, '@')
      if (own !== undefined) return testCompare(cond, own)
    }
    return testCompare(cond, el)
  }
  if (el === null || typeof el !== 'object' || Array.isArray(el)) return false
  const field = cond.field
  if (field === null) return false
  const val = getNestedField(el, field)
  if (cond.kind === 'exists') return val !== undefined
  if (cond.kind === 'absent') return val === undefined
  if (cond.plainField !== undefined) {
    const own = getNestedField(el, cond.plainField)
    if (own !== undefined) return testCompare(cond, own, '=')
  }
  return testCompare(cond, val)
}

function testFilter(node: FilterNode, el: unknown): boolean {
  if (node.kind === 'cond') return testCondition(node.cond, el)
  if (node.kind === 'and') return node.terms.every((t) => testFilter(t, el))
  return node.terms.some((t) => testFilter(t, el))
}

/** The original `[field=value]` op as a filter node, so a miss on it is explained the same way as a miss on the newer forms. */
function legacyFilterNode(op: { field: string; value: string }): FilterNode {
  return { kind: 'cond', cond: { kind: 'compare', field: op.field, op: '=', value: { text: op.value, quoted: false, number: null, typed: null }, caseInsensitive: false }, source: `${op.field}=${op.value}` }
}

/** A miss explains itself from at most this many elements, so a filter over a huge array does not pay for a second full pass. */
const MISS_SAMPLE = 1000
const MISS_NAMES = 200
const MISS_SHOWN_VALUES = 5
const MISS_SHOWN_NAMES = 3
/** Text out of the document is echoed into a notice only when it is short and plain; anything else is described by its kind, never quoted. */
const NOTICE_TEXT_MAX = 32
const NOTICE_SAFE_TEXT = /^[\w.:@/+-]*$/

function noticeText(s: string): string | null {
  return s.length <= NOTICE_TEXT_MAX && NOTICE_SAFE_TEXT.test(s) ? echoedValue(s) : null
}

function isObjectElement(el: unknown): el is Record<string, unknown> {
  return el !== null && typeof el === 'object' && !Array.isArray(el)
}

function leafConditions(node: FilterNode, out: Array<{ cond: FilterCondition; source: string }> = []): Array<{ cond: FilterCondition; source: string }> {
  if (node.kind === 'cond') out.push({ cond: node.cond, source: node.source })
  else for (const t of node.terms) leafConditions(t, out)
  return out
}

/** Own key names (and `key.child` names one level down) across the sampled objects, with how many objects carry each. */
function fieldNameCounts(objects: readonly Record<string, unknown>[]): Map<string, number> {
  const names = new Map<string, number>()
  const add = (name: string): void => {
    const seen = names.get(name)
    if (seen !== undefined) names.set(name, seen + 1)
    else if (names.size < MISS_NAMES) names.set(name, 1)
  }
  for (const o of objects) {
    for (const key of Object.keys(o).slice(0, MISS_NAMES)) {
      add(key)
      const child = o[key]
      if (isObjectElement(child)) for (const sub of Object.keys(child).slice(0, MISS_NAMES)) add(`${key}.${sub}`)
    }
  }
  return names
}

function similarFieldNames(query: string, names: ReadonlyMap<string, number>): string[] {
  const q = query.toLowerCase()
  const budget = q.length >= 5 ? 2 : 1
  const letters = (s: string): string => [...s].sort().join('')
  const scored: Array<{ name: string; score: number; freq: number }> = []
  for (const [name, freq] of names) {
    const n = name.toLowerCase()
    const leaf = n.slice(n.lastIndexOf('.') + 1)
    let score = -1
    if (leaf === q) score = 0
    else if (n.includes(q) || (n.length >= 3 && q.includes(n))) score = 1
    else if (q.length > 64 || n.length > 128) score = -1
    else if (q.length >= 3 && q.length === leaf.length && letters(q) === letters(leaf)) score = 2
    else if ((levenshteinDistance(q, n, budget) <= budget || (leaf !== n && levenshteinDistance(q, leaf, budget) <= budget))) score = 2
    if (score >= 0) scored.push({ name, score, freq })
  }
  return scored.sort((a, b) => a.score - b.score || b.freq - a.freq || (a.name < b.name ? -1 : 1)).map((s) => s.name)
}

/** What a field holds across the sampled elements: its range when every value is a number, otherwise the commonest values with counts. */
function describeObservedValues(label: string, values: readonly unknown[], plural = false): string {
  if (values.length > 0 && values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const nums = values as number[]
    let min = nums[0] as number
    let max = min
    for (const n of nums) {
      if (n < min) min = n
      if (n > max) max = n
    }
    return min === max ? `${label} ${plural ? 'are' : 'is'} always ${min}` : `${label} ${plural ? 'range' : 'ranges'} from ${min} to ${max}`
  }
  const counts = new Map<string, number>()
  for (const v of values) {
    const key = typeof v === 'string' ? (noticeText(v) ?? 'other text') : v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : String(v)
    if (counts.has(key) || counts.size < 50) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  const shown = ranked.slice(0, MISS_SHOWN_VALUES).map(([key, n]) => `${key} (${n})`)
  const more = ranked.length - shown.length
  return `${label} ${plural ? 'hold' : 'holds'} ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

function explainLeaf(cond: FilterCondition, elements: readonly unknown[], objects: readonly Record<string, unknown>[]): string | null {
  if (cond.kind === 'compare' && cond.field === null) return describeObservedValues('the elements', elements, true)
  const field = cond.field
  if (field === null) return null
  const label = echoedValue(field)
  if (objects.length === 0) return `no element is an object, so ${label} cannot match; test the elements themselves with @, as in [@=value]`
  const present = objects.map((o) => getNestedField(o, field)).filter((v) => v !== undefined)
  if (cond.kind === 'absent') return present.length === objects.length ? `every element has ${label}` : null
  if (present.length === 0) {
    const names = fieldNameCounts(objects)
    const similar = similarFieldNames(field, names).map(noticeText).filter((s): s is string => s !== null).slice(0, MISS_SHOWN_NAMES)
    if (similar.length > 0) return `no element has the field ${label}; did you mean ${similar.join(', ')}?`
    const seen = [...names].sort((a, b) => b[1] - a[1]).map(([name]) => noticeText(name)).filter((s): s is string => s !== null).slice(0, 8)
    return seen.length > 0 ? `no element has the field ${label}; the fields seen are ${seen.join(', ')}` : `no element has the field ${label}`
  }
  let note = describeObservedValues(label, present)
  if (present.length < objects.length) note += `, on ${present.length} of ${objects.length} elements`
  if (cond.kind === 'compare' && cond.op === '=' && !cond.caseInsensitive) {
    const folded = present.find((v): v is string => typeof v === 'string' && v !== cond.value.text && v.toLowerCase() === cond.value.text.toLowerCase())
    const shown = folded === undefined ? null : noticeText(folded)
    if (shown !== null) note += `; ${shown} differs only in case, and an i after a quoted value ignores case, as in [${field}=${echoedValue(cond.value.text)} i]`
  }
  return note
}

/** Why a filter kept nothing, from the elements of the arrays it ran on: the field is not there (with similar names), or what the field holds. Empty when there is nothing useful to add. */
function missNotes(expr: FilterNode, inputs: readonly unknown[]): string {
  const elements: unknown[] = []
  let partial = false
  collect: for (const input of inputs) {
    if (!Array.isArray(input)) continue
    for (const el of input) {
      if (elements.length >= MISS_SAMPLE) {
        partial = true
        break collect
      }
      elements.push(el)
    }
  }
  if (elements.length === 0) return ''
  const leaves = leafConditions(expr)
  const objects = elements.filter(isObjectElement)
  const notes: string[] = []
  let allMatchAlone = true
  for (const leaf of leaves) {
    const alone = elements.some((el) => testCondition(leaf.cond, el))
    if (alone) continue
    allMatchAlone = false
    if (notes.length < 3) {
      const note = explainLeaf(leaf.cond, elements, objects)
      if (note !== null) notes.push(note)
    }
  }
  if (notes.length === 0 && allMatchAlone && expr.kind === 'and') notes.push('each condition matches some elements on its own, but no element passes all of them')
  if (notes.length === 0) return ''
  return `; ${notes.join('; ')}${partial ? ` (from the first ${MISS_SAMPLE} elements)` : ''}`
}

/** A filter or slice acts on an array, so a bracket right after another filter or slice sees single elements and keeps nothing; the way to test two things is one bracket with &&. Said only when such a step came just before, since a bracket on an object or a string misses for a different reason. */
function chainHint(inputs: readonly unknown[], prev: PathOp | undefined): string {
  const afterFilter = prev !== undefined && (prev.kind === 'filter' || prev.kind === 'where' || prev.kind === 'slice')
  return afterFilter && inputs.length > 0 && !inputs.some((v) => Array.isArray(v)) ?'; a filter or slice applies to an array, and a second bracket after a filter sees one element at a time, so put both tests in one bracket with &&' : ''
}

/** An unquoted `[field=value]` takes everything up to the bracket as the value, so a value holding `&&` or `||` was read as text; say so, since that is almost never what a person combining tests meant. */
function plainValueHint(value: string): string {
  return /&&|\|\|/.test(value) ? `; an unquoted value runs to the closing bracket, so this looked for the text ${echoedValue(value)}; to combine tests give each its own operator, as in [a=1 && b>2], or quote the value` : ''
}

/** Why the step `op` produced nothing from `inputs`, worded for a person: the step as written, then what it found there. */
function describeEmptyStep(op: PathOp, inputs: readonly unknown[], prev?: PathOp): string {
  switch (op.kind) {
    case 'key':
      return `.${op.name} found no such key: ${describeReached(inputs)}`
    case 'recursive_key':
      return `..${op.name} found no key named ${echoedValue(op.name)} anywhere under ${inputs.length === 1 ? 'the value it searched' : `the ${inputs.length} values it searched`}`
    case 'index':
      // An index is only ever reached with nothing to show after a fan-out (unfanned, a miss throws), and there it applies to each item, which is the step people mistake for indexing the list of results.
      return `[${op.index}] found nothing to index: ${describeReached(inputs)}. After a fan-out an index applies to each item, not to the list of results; ${op.index === 0 ? 'to keep only the first result, drop the index and pass --head 1' : `to pick one result by position, index the array before the fan-out, as in list[${op.index}].field`}`
    case 'wildcard':
      return `[*] found nothing to iterate: ${describeReached(inputs)}`
    case 'filter':
      return `[${op.field}=${op.value}] matched no element: ${describeReached(inputs)}${missNotes(legacyFilterNode(op), inputs)}${plainValueHint(op.value)}${chainHint(inputs, prev)}`
    case 'where':
      return `[${displaySafeText(op.source)}] matched no element: ${describeReached(inputs)}${missNotes(op.expr, inputs)}${chainHint(inputs, prev)}`
    case 'slice':
      return `[${op.start ?? ''}:${op.end ?? ''}] found nothing to slice: ${describeReached(inputs)}${chainHint(inputs, prev)}`
    case 'project_list':
    case 'project_object':
      return `the projection found nothing to project: ${describeReached(inputs)}`
  }
}

/** The message a front-end shows when a fanned query matched nothing, so zero matches reads as a miss, like a missing key does, rather than as an empty line. */
export function noMatchMessage(spec: string, result: JsonQueryResult): string {
  return `no match for ${echoedValue(spec)}: ${result.emptiedBy ?? 'the path matched no values'}`
}

/** Evaluates a parsed path against a JSON document. Plain key/index traversal (no wildcard or filter yet reached) throws on a missing key or out-of-range index, since there is exactly one intended target. Once fanned out by `[*]` or `[field=value]`, a per-item miss (a key absent on one of several matched objects, say) is dropped rather than failing the whole query -- projecting across a heterogeneous array is the normal case, not an error. */
export function evalJsonPath(data: unknown, ops: readonly PathOp[]): JsonQueryResult {
  let current: unknown[] = [data]
  let fanned = false
  let emptiedBy: string | undefined
  // One allowance for the whole path, opened here rather than inside the op that spends it -- see QueryBudget.
  const budget: QueryBudget = { nodesLeft: MAX_RECURSIVE_NODES, exhausted: false }

  for (const [opIndex, op] of ops.entries()) {
    const next: unknown[] = []
    for (const item of current) {
      if (op.kind === 'key') {
        if (
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          Object.prototype.hasOwnProperty.call(item, op.name)
        ) {
          next.push((item as Record<string, unknown>)[op.name])
        } else if (!fanned) {
          throw new Error(`path not found: key ${echoedValue(op.name)} does not exist on ${jsonType(item)} value`)
        }
      } else if (op.kind === 'recursive_key') {
        fanned = true
        collectRecursiveKey(item, op.name, next, budget)
      } else if (op.kind === 'index') {
        if (Array.isArray(item)) {
          const idx = op.index < 0 ? item.length + op.index : op.index
          if (idx >= 0 && idx < item.length) {
            next.push(item[idx])
          } else if (!fanned) {
            throw new Error(`path not found: index [${op.index}] out of range (length ${item.length})`)
          }
        } else if (!fanned) {
          throw new Error(`path not found: index [${op.index}] on non-array ${jsonType(item)} value`)
        }
      } else if (op.kind === 'wildcard') {
        fanned = true
        if (Array.isArray(item)) {
          pushAll(next, item)
        } else if (typeof item === 'object' && item !== null) {
          pushAll(next, Object.values(item as Record<string, unknown>))
        }
      } else if (op.kind === 'project_list') {
        if (Array.isArray(item) && !fanned) {
          fanned = true
          for (const el of item) {
            next.push(
              op.fields.map((f) => {
                const val = getNestedField(el, f)
                return val === undefined ? null : val
              }),
            )
          }
        } else if (item === null || typeof item !== 'object') {
          if (!fanned) {
            throw new Error(`path not found: cannot project fields on ${jsonType(item)} value`)
          }
          next.push(op.fields.map(() => null))
        } else {
          next.push(
            op.fields.map((f) => {
              const val = getNestedField(item, f)
              return val === undefined ? null : val
            }),
          )
        }
      } else if (op.kind === 'project_object') {
        if (Array.isArray(item) && !fanned) {
          fanned = true
          for (const el of item) {
            const row: Record<string, unknown> = {}
            for (const f of op.fields) {
              const val = getNestedField(el, f.sourcePath)
              row[f.targetKey] = val === undefined ? null : val
            }
            next.push(row)
          }
        } else if (item === null || typeof item !== 'object') {
          if (!fanned) {
            throw new Error(`path not found: cannot project fields on ${jsonType(item)} value`)
          }
          const row: Record<string, unknown> = {}
          for (const f of op.fields) {
            row[f.targetKey] = null
          }
          next.push(row)
        } else {
          const row: Record<string, unknown> = {}
          for (const f of op.fields) {
            const val = getNestedField(item, f.sourcePath)
            row[f.targetKey] = val === undefined ? null : val
          }
          next.push(row)
        }
      } else if (op.kind === 'filter') {
        fanned = true
        if (Array.isArray(item)) {
          for (const el of item) {
            if (typeof el === 'object' && el !== null && !Array.isArray(el)) {
              const val = getNestedField(el, op.field)
              if (val !== undefined && stringifyValue(val) === op.value) {
                next.push(el)
              }
            }
          }
        }
      } else if (op.kind === 'where') {
        fanned = true
        if (Array.isArray(item)) {
          for (const el of item) {
            if (testFilter(op.expr, el)) next.push(el)
          }
        }
      } else if (op.kind === 'slice') {
        fanned = true
        if (Array.isArray(item)) pushAll(next, item.slice(op.start ?? undefined, op.end ?? undefined))
      }
    }
    if (emptiedBy === undefined && current.length > 0 && next.length === 0) emptiedBy = describeEmptyStep(op, current, ops[opIndex - 1])
    current = next
  }

  return emptiedBy === undefined ? { fanned, items: current, truncated: budget.exhausted } : { fanned, items: current, truncated: budget.exhausted, emptiedBy }
}

/** Convenience wrapper: parse + eval a path spec in one call. */
export function queryJson(data: unknown, spec: string): JsonQueryResult {
  return evalJsonPath(data, parseJsonPath(spec))
}
