/**
 * Racket adapter: `define`, `define-values`, `define-syntax`, `define-syntax-rule`, `struct`,
 * `define-struct`.
 *
 * Its own file with its own masker, per the settled decision documented in `templates_idx.ts`'s
 * module doc: Racket looks like Scheme from a distance (it descends from it) but the Racket
 * Reference documents lexical forms neither Scheme nor Common Lisp has --
 *  - Block comments (`#| ... |#`) NEST: Racket Reference, "Reading Text", `#|...|#` -- "Nested
 *    `#|...|#` comments are supported." `maskRacketBlockComment` implements this independently of
 *    `scheme.ts::maskSchemeBlockComment` and `common_lisp.ts::maskCommonLispBlockComment` even
 *    though the nesting-depth-counter shape is the same in all three, because each is scoped to
 *    its own dialect's cited grammar rather than folded into one shared rule.
 *  - `#;` datum comments (Racket Reference, "Reading Text", `#;` -- "Comments out the S-expression
 *    following the #;."), needing the same "skip one datum" shape as Scheme's -- but Racket's own
 *    reader additionally recognizes here-strings and byte strings inside that datum (see below),
 *    which Scheme's R7RS reader does not, so `racketDatumEnd` is its own function rather than a
 *    reuse of `scheme.ts::datumEnd`.
 *  - Here-strings: Racket Reference, "Reading Text", `#<<id ... id` -- "reads text up to a line
 *    that contains only `id`", used for embedding multi-line raw text without escaping. Neither
 *    Common Lisp nor Scheme's standard reader has an equivalent form.
 *  - Byte strings: Racket Reference, "Reading Text", `#"..."` reads a byte string with the same
 *    escape rules as a normal string but a `#` prefix; masked the same way a `"..."` string is,
 *    with the leading `#` left untouched (it is not part of the string body).
 *  - Character literals are `#\<name-or-char>` (Racket Reference, "Reading Text", `#\`), the same
 *    shape as Common Lisp/Scheme but governed by Racket's own character-name table.
 *  - `'` is the QUOTE abbreviation, never a string delimiter -- the same reason the other four
 *    Lisp adapters in this batch do not reuse `common.ts::stripStringLiterals`.
 *
 * Line comments are `;` to end of line. Strings are `"..."` with `\` escapes.
 *
 * Definitions are found the same structural way as `scheme.ts`/`common_lisp.ts`: a masked-text
 * depth scan for a definer keyword right after `(`, with the name taken as the next token or, for
 * function-shorthand `(define (name args) body)`, the first symbol after peeling one `(` layer.
 * `struct`/`define-struct` name lookup is identical (the struct name is the token right after the
 * keyword; Racket's optional supertype-name-in-parens form `(struct name (field ...) #:super sup)`
 * still has a bare name token first, so no extra peeling is needed the way `defstruct` needs it in
 * Common Lisp).
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine } from './common.js'

const DEFINERS: ReadonlyMap<string, string> = new Map([
  ['define', 'function'],
  ['define-values', 'variable'],
  ['define-syntax', 'macro'],
  ['define-syntax-rule', 'macro'],
  ['struct', 'struct'],
  ['define-struct', 'struct'],
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && !/[\s()[\]{}"'`,;|#]/.test(ch)

/** Skips one nested `#| ... |#` block comment starting at `start` (pointing at the `#`), per the
 * Racket Reference's "Nested #|...|# comments are supported." Returns the index past the closer. */
function maskRacketBlockComment(content: string, start: number): number {
  const n = content.length
  let i = start + 2
  let depth = 1
  while (i < n && depth > 0) {
    if (content[i] === '#' && content[i + 1] === '|') {
      depth++
      i += 2
      continue
    }
    if (content[i] === '|' && content[i + 1] === '#') {
      depth--
      i += 2
      continue
    }
    i++
  }
  return i
}

/** Skips a `#<<id ... id` here-string starting at `start` (pointing at the `#`), per the Racket
 * Reference: reads an identifier to end of line, then everything up to (and including) the next
 * line that contains only that identifier. Returns the index just past the terminator line, or
 * end of input if the terminator never appears -- a single bounded `indexOf`, so an unterminated
 * here-string costs one linear scan, never a per-line quadratic one. */
function skipHereString(content: string, start: number): number {
  const n = content.length
  let p = start + 3 // past "#<<"
  const idStart = p
  while (p < n && content[p] !== '\n' && !isSpace(content[p])) p++
  const id = content.slice(idStart, p)
  while (p < n && content[p] !== '\n') p++ // rest of the opening line
  if (id === '') return p
  const terminator = '\n' + id
  const found = content.indexOf(terminator, p)
  if (found === -1) return n
  // The terminator line must contain only `id`: its next character is a newline or end of input.
  const after = found + terminator.length
  if (after >= n || content[after] === '\n' || content[after] === '\r') return Math.min(after, n)
  // False match (id was a prefix of a longer line) -- fall back to end of input rather than
  // risking an unbounded rescan; here-strings whose id text recurs mid-line are rare in practice.
  return n
}

/** The end of one datum for Racket's `#;` (parenthesized form, string, byte string, character
 * literal, here-string, or bare symbol run) -- its own function, not a reuse of
 * `scheme.ts::datumEnd`, because Racket's reader recognizes here-strings and byte strings inside a
 * `#;`-elided datum that Scheme's standard reader has no equivalent for. */
function racketDatumEnd(content: string, i: number): number {
  const n = content.length
  if (i >= n) return i
  const ch = content[i]!
  if (ch === '(' || ch === '[') {
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
      if (content[p] === '(' || content[p] === '[') depth++
      else if (content[p] === ')' || content[p] === ']') depth--
      p++
    }
    return p
  }
  if (ch === '#' && content[i + 1] === '<' && content[i + 2] === '<') return skipHereString(content, i)
  if ((ch === '"') || (ch === '#' && content[i + 1] === '"')) {
    let p = ch === '#' ? i + 2 : i + 1
    while (p < n && content[p] !== '"') {
      if (content[p] === '\\') p++
      p++
    }
    return Math.min(p + 1, n)
  }
  if (ch === '#' && content[i + 1] === '\\') {
    let p = i + 2
    if (content[p] !== undefined && /[A-Za-z0-9]/.test(content[p]!)) {
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

/** Masks `;` line comments, nested `#| |#` block comments, `#;`-elided datums, here-strings,
 * `"..."`/`#"..."` strings and `#\<name>` character literals to spaces (newlines preserved). */
function maskRacket(content: string): string {
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
    if (ch === '#' && content[i + 1] === '|') {
      const start = i
      const end = maskRacketBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '#' && content[i + 1] === ';') {
      const markStart = i
      i += 2
      while (isSpace(content[i])) i++
      const end = racketDatumEnd(content, i)
      for (let k = markStart; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '#' && content[i + 1] === '<' && content[i + 2] === '<') {
      const start = i
      const end = skipHereString(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '#' && content[i + 1] === '\\') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      if (content[i] !== undefined && /[A-Za-z0-9]/.test(content[i]!)) {
        while (i < n && /[A-Za-z0-9]/.test(content[i]!)) {
          out[i] = ' '
          i++
        }
      } else if (i < n && content[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (ch === '"' || (ch === '#' && content[i + 1] === '"')) {
      const hashPrefixed = ch === '#'
      if (hashPrefixed) {
        out[i] = '#'
        i++
      }
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

export function extractRacket(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskRacket(content)
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
        let kind = DEFINERS.get(tok.word.toLowerCase())
        if (kind !== undefined) {
          let namePos = tok.end
          while (isSpace(masked[namePos])) namePos++
          // (define (name args...) body): function-shorthand define peels one `(` layer and
          // means "function" rather than "variable" (Racket Reference, "define").
          const isDefine = tok.word.toLowerCase() === 'define'
          if (masked[namePos] === '(') {
            namePos++
            if (isDefine) kind = 'function'
          } else if (isDefine) {
            kind = 'variable'
          }
          const nameTok = readToken(masked, namePos)
          const name = nameTok?.word ?? ''
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
