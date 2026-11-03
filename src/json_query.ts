import { echoedValue } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { jsonType } from './json_path_eval.js'
import type { JsonValueType } from './json_path_eval.js'

export type { JsonValueType }
export { jsonType }

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

export type { ProjectionObjectField, FilterOperator, FilterLiteral, FilterCondition, FilterNode, PathOp } from './json_path_parser.js'
export { MAX_RECURSIVE_NODES, MAX_RECURSIVE_DEPTH } from './json_path_eval.js'
export { parseJsonPath } from './json_path_parser.js'
export type { JsonQueryResult } from './json_path_eval.js'
export { noMatchMessage } from './json_path_eval.js'
export { evalJsonPath } from './json_path_eval.js'
export { queryJson } from './json_path_eval.js'
