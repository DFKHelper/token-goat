/** Narrow structural summary + path-based extraction for `token-goat json-outline` / `json-query`, so a multi-thousand-line JSON document never needs a full `Read` just to answer "what does this contain" or "what's at path X". Deliberately no JSONPath/jq compatibility -- a dot-path with `[n]` index, `[*]` wildcard, and `[field=value]` filter segments covers the common case, matching the project's "no premature abstraction" bar (see csv_query.ts for the same philosophy applied to CSV). `json-query` is the general-purpose sibling of `config-get`'s JSON branch: config-get only resolves a single dotted key to a scalar (no array indexing/wildcard/filter), which is enough for flat config lookups. json-query adds array navigation and filtering on top, for querying JSON data files rather than config. */

import { displaySafeText } from './paths.js'
import { pushAll } from './util.js'

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
    const tally = filter === undefined ? '' : `(${outline.fields.length} of ${filter.total} keys contain "${displaySafeText(filter.needle)}")`
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

export type PathOp =
  | { kind: 'key'; name: string }
  | { kind: 'recursive_key'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; field: string; value: string }
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

/** Parses a dot-path query spec into a sequence of ops. Grammar: `(..key|key)(.key)*` where any key may be followed by zero or more bracket segments -- `[n]` (array index), `[*]` (wildcard, fans out every element), or `[field=value]` (filter, keeps array elements whose `field` stringifies to `value`). `..key` performs recursive descent, searching for `key` across all nested objects and arrays. An empty spec means "the whole document". Examples: `data.items[3].name`, `items[*].id`, `items[status=active]`, `items[status="active"][0].name`, `..raw`, `..request.url.raw`. */
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
      throw new Error(`invalid list projection '[${inner}]' in path spec '${fullSpec}': empty field expression`)
    }
    fields.push(source)
  }
  if (fields.length === 0) {
    throw new Error(`invalid list projection '[${inner}]' in path spec '${fullSpec}': must specify at least one field`)
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
        throw new Error(`invalid object projection '{${inner}}' in path spec '${fullSpec}': empty field expression`)
      }
      const target = getLeafKeyName(colonParts[0]!.trim())
      fields.push({ targetKey: target, sourcePath: source })
    } else if (colonParts.length === 2) {
      const rawTarget = colonParts[0]!.trim()
      const rawSource = colonParts[1]!.trim()
      const target = unquoteIfQuoted(rawTarget)
      const source = cleanFieldPath(rawSource)
      if (!target || !source) {
        throw new Error(`invalid object projection field '${trimmed}' in '{${inner}}' of path spec '${fullSpec}'`)
      }
      fields.push({ targetKey: target, sourcePath: source })
    } else {
      throw new Error(`invalid object projection field '${trimmed}' in '{${inner}}' of path spec '${fullSpec}': multiple colons`)
    }
  }
  if (fields.length === 0) {
    throw new Error(`invalid object projection '{${inner}}' in path spec '${fullSpec}': must specify at least one field`)
  }
  return fields
}

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
      if (name === '') throw new Error(`invalid path spec: expected property name after '..' in '${spec}'`)
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
      if (close === -1) throw new Error(`invalid path spec: unterminated '{' in '${spec}'`)
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
      if (close === -1) throw new Error(`invalid path spec: unterminated '[' in '${spec}'`)
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
          const m = /^([^=]+)==?(.*)$/.exec(expr)
          if (m) {
            let field = (m[1] as string).trim()
            if (field.startsWith('@.')) field = field.slice(2).trim()
            const swallowedOperator = /[!<>]$/.exec(field)
            if (swallowedOperator !== null) {
              throw new Error(`unsupported comparison operator '${swallowedOperator[0]}=' in '[${inner}]' of path spec '${spec}': this grammar filters by equality only ([field=value])`)
            }
            let rawVal = (m[2] as string).trim()
            if (
              (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
              (rawVal.startsWith("'") && rawVal.endsWith("'"))
            ) {
              if (rawVal.length >= 2) {
                rawVal = rawVal.slice(1, -1).replace(/\\(["'\\])/g, '$1')
              }
            }
            ops.push({ kind: 'filter', field, value: rawVal })
          } else {
            const bareOperator = /[<>]/.exec(expr)
            if (bareOperator !== null) {
              throw new Error(`unsupported comparison operator '${bareOperator[0]}' in '[${inner}]' of path spec '${spec}': this grammar filters by equality only ([field=value])`)
            }
            if (isDottedPrefix || expr.startsWith('.') || (i === 0 && isValidFieldPath(expr))) {
              ops.push({ kind: 'project_list', fields: [cleanFieldPath(expr)] })
            } else {
              throw new Error(`invalid bracket expression '[${inner}]' in path spec: '${spec}' (expected [n], [*], ["key"], or [field=value])`)
            }
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
    if (name === '') throw new Error(`invalid path spec: '${spec}'`)
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
  const labels = [...new Set(inputs.map((v) => describeValue(v, false)))]
  return `the ${inputs.length} values it reached are ${labels.length === 1 ? `all ${labels[0] as string}` : labels.join(', ')}`
}

/** Why the step `op` produced nothing from `inputs`, worded for a person: the step as written, then what it found there. */
function describeEmptyStep(op: PathOp, inputs: readonly unknown[]): string {
  switch (op.kind) {
    case 'key':
      return `.${op.name} found no such key: ${describeReached(inputs)}`
    case 'recursive_key':
      return `..${op.name} found no key named '${op.name}' anywhere under ${inputs.length === 1 ? 'the value it searched' : `the ${inputs.length} values it searched`}`
    case 'index':
      // An index is only ever reached with nothing to show after a fan-out (unfanned, a miss throws), and there it applies to each item, which is the step people mistake for indexing the list of results.
      return `[${op.index}] found nothing to index: ${describeReached(inputs)}. After a fan-out an index applies to each item, not to the list of results; ${op.index === 0 ? 'to keep only the first result, drop the index and pass --head 1' : `to pick one result by position, index the array before the fan-out, as in list[${op.index}].field`}`
    case 'wildcard':
      return `[*] found nothing to iterate: ${describeReached(inputs)}`
    case 'filter':
      return `[${op.field}=${op.value}] matched no element: ${describeReached(inputs)}`
    case 'project_list':
    case 'project_object':
      return `the projection found nothing to project: ${describeReached(inputs)}`
  }
}

/** The message a front-end shows when a fanned query matched nothing, so zero matches reads as a miss, like a missing key does, rather than as an empty line. */
export function noMatchMessage(spec: string, result: JsonQueryResult): string {
  return `no match for '${spec}': ${result.emptiedBy ?? 'the path matched no values'}`
}

/** Evaluates a parsed path against a JSON document. Plain key/index traversal (no wildcard or filter yet reached) throws on a missing key or out-of-range index, since there is exactly one intended target. Once fanned out by `[*]` or `[field=value]`, a per-item miss (a key absent on one of several matched objects, say) is dropped rather than failing the whole query -- projecting across a heterogeneous array is the normal case, not an error. */
export function evalJsonPath(data: unknown, ops: readonly PathOp[]): JsonQueryResult {
  let current: unknown[] = [data]
  let fanned = false
  let emptiedBy: string | undefined
  // One allowance for the whole path, opened here rather than inside the op that spends it -- see QueryBudget.
  const budget: QueryBudget = { nodesLeft: MAX_RECURSIVE_NODES, exhausted: false }

  for (const op of ops) {
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
          throw new Error(`path not found: key '${op.name}' does not exist on ${jsonType(item)} value`)
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
              if (val !== undefined && String(val) === op.value) {
                next.push(el)
              }
            }
          }
        }
      }
    }
    if (emptiedBy === undefined && current.length > 0 && next.length === 0) emptiedBy = describeEmptyStep(op, current)
    current = next
  }

  return emptiedBy === undefined ? { fanned, items: current, truncated: budget.exhausted } : { fanned, items: current, truncated: budget.exhausted, emptiedBy }
}

/** Convenience wrapper: parse + eval a path spec in one call. */
export function queryJson(data: unknown, spec: string): JsonQueryResult {
  return evalJsonPath(data, parseJsonPath(spec))
}
