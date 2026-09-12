/**
 * Scheme (R7RS) adapter: `define`, `define-syntax`, `define-record-type`, `define-values`,
 * `define-library`.
 *
 * Its own file with its own masker -- see `templates_idx.ts`'s module doc for why the six template
 * dialects share one masker while the five Lisp dialects, this one included, each get their own.
 * Scheme's rules genuinely diverge from Common Lisp's and Racket's:
 *  - Block comments (`#| ... |#`) NEST, per R7RS 7.1.2 ("Datum comments"; the nesting rule for `#|
 *    |#` is stated in R7RS section 2.2 "Whitespace and comments": "block comments... can be
 *    nested"). `maskSchemeBlockComment` implements this independently of
 *    `common_lisp.ts::maskCommonLispBlockComment`, even though both count nesting depth the same
 *    way, because each is scoped to its own dialect's grammar and the settled decision for this
 *    batch is not to fold lookalike rules into one shared function.
 *  - Unlike Common Lisp, R7RS defines `#;` (section 2.2): "Datum comments... cause the parser to
 *    skip the next datum." This needs a "skip one datum" scanner (`skipDatum`), since the elided
 *    datum can itself be an atom, a string, a character literal, or an arbitrarily nested list --
 *    something Common Lisp's masker never needs, because CL has no datum-comment syntax.
 *  - Character literals are `#\<name-or-char>` per R7RS 6.7 ("Characters"), the same *shape* as
 *    Common Lisp's `#\` syntax but governed by R7RS's own character-name table (`#\space`,
 *    `#\newline`, `#\alarm`, ...), not CLHS's.
 *  - `'` is the QUOTE abbreviation (R7RS 2.2, "'a" == "(quote a)"), never a string delimiter, the
 *    same reason `common_lisp.ts` gives for not reusing `common.ts::stripStringLiterals`.
 *
 * Line comments are `;` to end of line. Strings are `"..."` with `\` escapes (R7RS 6.13.2).
 *
 * Definitions are found the same structural way as `common_lisp.ts` (masked-text depth scan for a
 * definer keyword right after `(`, name is the next token or, for `(define (name args) body)`
 * function shorthand, the first symbol after peeling one `(` layer) -- the STRUCTURAL walk looks
 * similar across all five Lisp files because every one of them is an s-expression language and a
 * paren-depth walk is unavoidable, but each file's masking pass (the actual point of divergence
 * this batch is about) is independently written and independently cites its own dialect's spec.
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine } from './common.js'

const DEFINERS: ReadonlyMap<string, string> = new Map([
  ['define', 'function'],
  ['define-syntax', 'macro'],
  ['define-record-type', 'record-type'],
  ['define-values', 'variable'],
  ['define-library', 'library'],
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && !/[\s()[\]{}"'`,;|#]/.test(ch)

/** Skips one nested `#| ... |#` block comment starting at `start` (pointing at the `#`), per R7RS
 * section 2.2: a `#|` seen while already inside increments depth, only the matching `|#`
 * decrements it to zero. Returns the index just past the closer, or end of input if unclosed. */
function maskSchemeBlockComment(content: string, start: number): number {
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

/**
 * Returns the index just past one datum starting at `i` (whitespace and comments before it are
 * NOT skipped by this function -- callers position `i` at the first non-space character): a
 * parenthesized form (depth-counted, aware of nested strings so a `)` inside one doesn't close the
 * datum early), a string, a `#\` character literal, or a bare run of symbol characters. Used by
 * {@link maskScheme} to blank the datum that `#;` elides (R7RS section 2.2), so it is never
 * mistaken for a live definition.
 */
function datumEnd(content: string, i: number): number {
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
  if (ch === '"') {
    let p = i + 1
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

/** Masks `;` line comments, nested `#| |#` block comments, `#;`-elided datums, `"..."` strings and
 * `#\<name>` character literals to spaces (newlines preserved), left to right in one pass. */
function maskScheme(content: string): string {
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
      const end = maskSchemeBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '#' && content[i + 1] === ';') {
      const markStart = i
      i += 2
      while (isSpace(content[i])) i++
      const end = datumEnd(content, i)
      for (let k = markStart; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
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

export function extractScheme(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskScheme(content)
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
          // means "function" rather than "variable" (R7RS 5.3.2's two `define` forms).
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
