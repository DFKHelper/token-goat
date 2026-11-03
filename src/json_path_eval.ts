import { echoedValue } from './hint_suggestion_guard.js'
import { displaySafeText } from './paths.js'
import { countNoun, pushAll } from './util.js'
import { levenshteinDistance } from './util_suggest.js'
import { NUMBER_TEXT, parseJsonPath } from './json_path_parser.js'
import type { FilterCondition, FilterNode, FilterOperator, PathOp } from './json_path_parser.js'

export type JsonValueType = 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object'

export function jsonType(value: unknown): JsonValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as JsonValueType
}

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
