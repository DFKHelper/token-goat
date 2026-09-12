/**
 * Clojure adapter: `defn`, `defn-`, `def`, `defmacro`, `defprotocol`, `defrecord`, `deftype`,
 * `defmulti`, `defmethod`, `definterface`, `ns`.
 *
 * Its own file with its own masker, per the settled decision in `templates_idx.ts`'s module doc.
 * Clojure's reader (clojure.org/reference/reader) diverges from every other Lisp in this batch in
 * ways that are load-bearing for a masker, not cosmetic:
 *  - Clojure has NO block comment at all. clojure.org/reference/reader lists only `;` line
 *    comments as a comment form (`#_` and the `(comment ...)` macro are the closest things to a
 *    second comment mechanism, and neither is a `/* *\/`-shaped delimited span the
 *    `tests/guards/block_comment_nesting_is_classified.test.ts` guard is scoped to, so this
 *    adapter has no `maskClojureBlockComment` to register there). A masker written by analogy to
 *    Common Lisp's or Scheme's `#| |#` handling would be actively wrong here: it would treat a
 *    `#|` appearing in real Clojure source (which has no meaning to the Clojure reader) as an
 *    open delimiter and blank everything up to a `|#` that may be arbitrarily far away or absent.
 *  - `#_` elides the NEXT FORM (clojure.org/reference/reader, "Discard": "The this next form
 *    following the #_ ... is completely ignored"), the same *shape* of problem as Scheme/Racket's
 *    `#;` but a different reader syntax and a different set of nested forms to recognize (Clojure
 *    adds map `{}` and set `#{}` literals `datumEnd` in the Scheme/Racket files never needs to
 *    skip over).
 *  - Character literals have NO `#\` prefix: clojure.org/reference/reader, "Characters" --
 *    `\newline`, `\space`, `\tab`, `\backspace`, `\formfeed`, `\return`, `\uNNNN`, or a bare
 *    `\c` for any other character. A masker written for Common Lisp/Scheme/Racket's `#\` shape
 *    would completely miss Clojure's char literals (there is no `#` to key off), which is exactly
 *    the kind of near-miss the module doc for this batch warns "only look alike from a distance."
 *  - Reader conditionals (`#?(:clj expr :cljs expr)`) and namespaced keywords (`::foo`) introduce
 *    no delimiter this masker must track specially: `#?` opens an ordinary `(` the depth-counting
 *    walk already handles, and `::` is just two characters inside an otherwise-ordinary keyword
 *    token.
 *  - `'` is the QUOTE abbreviation, never a string delimiter -- the same reason the other four
 *    adapters in this batch do not reuse `common.ts::stripStringLiterals`.
 *
 * Strings are `"..."` with `\` escapes (multi-line strings are legal Clojure, unlike most
 * C-family languages, so this masker -- like every other Lisp masker in this batch -- runs over
 * the whole file rather than one line at a time).
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine } from './common.js'

const DEFINERS: ReadonlyMap<string, string> = new Map([
  ['defn', 'function'],
  ['defn-', 'function'],
  ['def', 'variable'],
  ['defmacro', 'macro'],
  ['defprotocol', 'protocol'],
  ['defrecord', 'record'],
  ['deftype', 'type'],
  ['defmulti', 'multimethod'],
  ['defmethod', 'method'],
  ['definterface', 'interface'],
  ['ns', 'namespace'],
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && !/[\s()[\]{}"'`,;\\]/.test(ch)

/** The end of one datum elided by `#_` (clojure.org/reference/reader, "Discard"): a parenthesized,
 * bracketed, or brace-delimited form (map/vector/set literals all use one of `()[]{}`), a string,
 * a backslash character literal, or a bare symbol/keyword run. */
function datumEnd(content: string, i: number): number {
  const n = content.length
  if (i >= n) return i
  const ch = content[i]!
  if (ch === '(' || ch === '[' || ch === '{') {
    let depth = 1
    let p = i + 1
    while (p < n && depth > 0) {
      if (content[p] === '"') {
        p++
        while (p < n && content[p] !== '"') {
          if (content[p] === '\\') p++
          p++
        }
        p++
        continue
      }
      if (content[p] === '(' || content[p] === '[' || content[p] === '{') depth++
      else if (content[p] === ')' || content[p] === ']' || content[p] === '}') depth--
      p++
    }
    return p
  }
  if (ch === '"') {
    let p = i + 1
    while (p < n && content[p] !== '"') {
      if (content[p] === '\\') p++
      p++
    }
    return Math.min(p + 1, n)
  }
  if (ch === '\\') {
    let p = i + 1
    if (content[p] !== undefined && /[A-Za-z]/.test(content[p]!)) {
      while (p < n && /[A-Za-z0-9]/.test(content[p]!)) p++
    } else {
      p = Math.min(p + 1, n)
    }
    return p
  }
  let p = i
  while (p < n && isSymbolChar(content[p])) p++
  return p === i ? i + 1 : p
}

/** Masks `;` line comments, `#_`-elided datums, `"..."` strings and `\<name>` character literals
 * to spaces (newlines preserved), left to right in one pass. Clojure has no block comment
 * (clojure.org/reference/reader), so unlike common_lisp.ts/scheme.ts/racket.ts there is no
 * `#| |#` branch here at all. */
function maskClojure(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  let i = 0
  while (i < n) {
    const ch = content[i]!
    if (ch === ';') {
      while (i < n && content[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (ch === '#' && content[i + 1] === '_') {
      const markStart = i
      i += 2
      while (isSpace(content[i])) i++
      const end = datumEnd(content, i)
      for (let k = markStart; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    // A backslash character literal only opens in "read position": require the previously
    // emitted, non-blanked character to be a delimiter (or start of input), so a symbol that
    // merely contains a backslash-adjacent sequence is never misread as a char literal. In
    // practice Clojure symbols never contain a bare `\`, so this guard mainly protects against
    // running past the end of a truncated/malformed file.
    if (ch === '\\' && (i === 0 || /[\s([{'"`,]/.test(content[i - 1]!) || content[i - 1] === undefined)) {
      const start = i
      const end = datumEnd(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '"') {
      out[i] = '"'
      i++
      while (i < n) {
        if (content[i] === '\\' && i + 1 < n && content[i + 1] !== '\n') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (content[i] === '"') {
          out[i] = '"'
          i++
          break
        }
        if (content[i] === '\n') break
        out[i] = ' '
        i++
      }
      continue
    }
    out[i] = ch
    i++
  }
  return out.join('')
}

function readToken(masked: string, i: number): { word: string; start: number; end: number } | undefined {
  let p = i
  while (isSpace(masked[p])) p++
  if (p >= masked.length) return undefined
  const start = p
  while (isSymbolChar(masked[p])) p++
  if (p === start) return undefined
  return { word: masked.slice(start, p), start, end: p }
}

export function extractClojure(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskClojure(content)
  const lineIndex = buildLineIndex(masked)
  const lineOf = (offset: number): number => offsetToLine(lineIndex, offset)
  const spans = new SpanCollector(filePath)
  const n = masked.length
  const stack: { index: number | undefined; depth: number }[] = []
  let depth = 0
  let i = 0

  const owner = (): string => (stack.length > 0 ? spans.name(stack[stack.length - 1]!.index) : '')

  while (i < n) {
    const ch = masked[i]!
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      const tok = readToken(masked, i + 1)
      if (tok !== undefined) {
        // `defmethod` names its target multimethod followed by a dispatch value, and `def-` forms
        // in general have the definer immediately followed by the name -- no function-shorthand
        // peeling is needed here (Clojure's `defn` always takes the name directly, unlike Scheme's
        // `(define (name args) ...)`).
        const kind = DEFINERS.get(tok.word.toLowerCase())
        if (kind !== undefined) {
          const nameTok = readToken(masked, tok.end)
          const name = nameTok?.word.replace(/^:+/, '') ?? ''
          const idx = spans.open(name, kind, lineOf(i), owner())
          stack.push({ index: idx, depth })
        }
      }
      i++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length > 0 && stack[stack.length - 1]!.depth === depth) {
        const top = stack.pop()!
        spans.close(top.index, lineOf(i))
      }
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    i++
  }
  for (const top of stack) spans.close(top.index, lineOf(n))
  return { symbols: spans.finish(rawLines), imports: [] }
}
