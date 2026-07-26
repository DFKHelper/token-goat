/**
 * Narrow structural summary + path-based extraction for `token-goat json-outline` /
 * `json-query`, so a multi-thousand-line JSON document never needs a full `Read` just to
 * answer "what does this contain" or "what's at path X". Deliberately no JSONPath/jq
 * compatibility -- a dot-path with `[n]` index, `[*]` wildcard, and `[field=value]` filter
 * segments covers the common case, matching the project's "no premature abstraction" bar
 * (see csv_query.ts for the same philosophy applied to CSV).
 *
 * `json-query` is the general-purpose sibling of `config-get`'s JSON branch: config-get only
 * resolves a single dotted key to a scalar (no array indexing/wildcard/filter), which is
 * enough for flat config lookups. json-query adds array navigation and filtering on top,
 * for querying JSON data files rather than config.
 */

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
}

export interface JsonOutlinePrimitive {
  kind: 'primitive'
  type: JsonValueType
}

export type JsonOutline = JsonOutlineArray | JsonOutlineObject | JsonOutlinePrimitive

/**
 * Structural summary of a parsed JSON document: for an array, element count plus the merged
 * key set / type shape of the first `sampleSize` elements (and whether that shape varies
 * across the sample); for an object, each top-level key's type and (for arrays/objects) size;
 * for a scalar, just its type. Mirrors what `outline`/`skeleton` do for source symbols, but for
 * JSON structure instead of code.
 */
export function outlineJson(data: unknown, opts: { sampleSize?: number } = {}): JsonOutline {
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
      // Report each key's type/size from whichever sampled element actually has it, not just
      // the first element -- a key that's absent on the first element but present on a later
      // one (a heterogeneous sample) would otherwise be misreported as type 'undefined'.
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
    return { kind: 'object', fields: Object.keys(obj).map((k) => fieldSummary(k, obj[k])) }
  }

  return { kind: 'primitive', type }
}

export function formatJsonOutline(outline: JsonOutline): string {
  if (outline.kind === 'primitive') return `(scalar ${outline.type})`

  if (outline.kind === 'object') {
    if (outline.fields.length === 0) return '(empty object)'
    return outline.fields.map((f) => `${f.name}: ${f.type}${f.size !== undefined ? ` (${f.size})` : ''}`).join('\n')
  }

  const lines = [`array of ${outline.length} element${outline.length === 1 ? '' : 's'} (${outline.elementType})`]
  if (outline.sampleKeys !== undefined) {
    lines.push(outline.heterogeneous === true ? 'keys (from first elements, shape varies across sample):' : 'keys (from first elements):')
    for (const f of outline.sampleKeys) {
      lines.push(`  ${f.name}: ${f.type}${f.size !== undefined ? ` (${f.size})` : ''}`)
    }
  }
  return lines.join('\n')
}

type PathOp =
  | { kind: 'key'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; field: string; value: string }

/**
 * Parses a dot-path query spec into a sequence of ops. Grammar: `key(.key)*` where any key may
 * be followed by zero or more bracket segments -- `[n]` (array index), `[*]` (wildcard, fans
 * out every element), or `[field=value]` (filter, keeps array elements whose `field` stringifies
 * to `value`). An empty spec means "the whole document". Examples: `data.items[3].name`,
 * `items[*].id`, `items[status=active]`, `items[status=active][0].name`.
 */
export function parseJsonPath(spec: string): PathOp[] {
  const ops: PathOp[] = []
  const n = spec.length
  let i = 0
  while (i < n) {
    const ch = spec[i]
    if (ch === '.') {
      i++
      continue
    }
    if (ch === '[') {
      const close = spec.indexOf(']', i)
      if (close === -1) throw new Error(`invalid path spec: unterminated '[' in '${spec}'`)
      const inner = spec.slice(i + 1, close)
      if (inner === '*') {
        ops.push({ kind: 'wildcard' })
      } else if (/^-?\d+$/.test(inner)) {
        ops.push({ kind: 'index', index: Number(inner) })
      } else {
        const m = /^([^=]+)=(.*)$/.exec(inner)
        if (!m) throw new Error(`invalid bracket expression '[${inner}]' in path spec: '${spec}' (expected [n], [*], or [field=value])`)
        ops.push({ kind: 'filter', field: (m[1] as string).trim(), value: m[2] as string })
      }
      i = close + 1
      continue
    }
    let j = i
    while (j < n && spec[j] !== '.' && spec[j] !== '[') j++
    if (j === i) throw new Error(`invalid path spec: '${spec}'`)
    ops.push({ kind: 'key', name: spec.slice(i, j) })
    i = j
  }
  return ops
}

export interface JsonQueryResult {
  /** True once a wildcard or filter op has fanned the traversal out to multiple items. */
  fanned: boolean
  /** Current matched values. Single-element and non-fanned means "one scalar result". */
  items: unknown[]
}

/**
 * Evaluates a parsed path against a JSON document. Plain key/index traversal (no wildcard or
 * filter yet reached) throws on a missing key or out-of-range index, since there is exactly one
 * intended target. Once fanned out by `[*]` or `[field=value]`, a per-item miss (a key absent on
 * one of several matched objects, say) is dropped rather than failing the whole query --
 * projecting across a heterogeneous array is the normal case, not an error.
 */
export function evalJsonPath(data: unknown, ops: readonly PathOp[]): JsonQueryResult {
  let current: unknown[] = [data]
  let fanned = false

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
          next.push(...item)
        } else if (typeof item === 'object' && item !== null) {
          next.push(...Object.values(item as Record<string, unknown>))
        }
      } else {
        fanned = true
        if (Array.isArray(item)) {
          for (const el of item) {
            if (
              typeof el === 'object' &&
              el !== null &&
              !Array.isArray(el) &&
              String((el as Record<string, unknown>)[op.field]) === op.value
            ) {
              next.push(el)
            }
          }
        }
      }
    }
    current = next
  }

  return { fanned, items: current }
}

/** Convenience wrapper: parse + eval a path spec in one call. */
export function queryJson(data: unknown, spec: string): JsonQueryResult {
  return evalJsonPath(data, parseJsonPath(spec))
}
