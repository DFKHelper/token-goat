import { echoedValue } from './hint_suggestion_guard.js'

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

interface CompareCondition {
  kind: 'compare'
  field: string | null
  op: FilterOperator
  value: FilterLiteral
  caseInsensitive: boolean
  plainField?: string
}

/** One condition of a filter. `field` null means the element itself (`@`). `plainField` is set on `*=`, `^=` and `$=`: before those operators existed `[price$=7]` read a key named `price$`, so an element that has that key is still compared by plain equality on it. */
export type FilterCondition =
  | { kind: 'exists'; field: string }
  | { kind: 'absent'; field: string }
  | CompareCondition

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
export const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

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
          } else if (expr.startsWith('?')) {
            const predicate = expr.slice(1).trim()
            if (isFilterExpression(predicate)) expr = predicate
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
