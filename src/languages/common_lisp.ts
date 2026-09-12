/**
 * Common Lisp adapter: `defun`, `defmacro`, `defvar`/`defparameter`/`defconstant`, `defclass`,
 * `defgeneric`, `defmethod`, `defstruct`, `defpackage`, `deftype`, `define-condition`,
 * `define-compiler-macro`, `define-symbol-macro`, `define-method-combination`.
 *
 * Deliberately its own file with its own masker (see the module doc in `templates_idx.ts` for the
 * contrast this repo settled on): Common Lisp's lexical rules diverge from the other four Lisp
 * dialects in ways specific to CLHS, not incidental style choices --
 *  - Block comments (`#| ... |#`) NEST per CLHS 2.4.8.19 ("Comments in Compound Form"... actually
 *    2.4.8.19 "Sharpsign Vertical-Bar" -- "the comment... may contain nested comments"): a `#|`
 *    seen while already inside a `#| |#` comment increments depth, and only the matching `|#`
 *    closes the outermost one. `maskCommonLispBlockComment` implements this with a simple depth
 *    counter, mirroring `stripNestedBlockCommentSpan` in `common.ts` in shape only -- not shared,
 *    since Common Lisp's comment delimiters, escaping and surrounding grammar are its own.
 *  - Common Lisp has NO `#;` datum-comment reader macro (that is a Scheme/Racket-only extension,
 *    R7RS 7.1.2's `#;` and Racket Reference's `#;`; CLHS defines no such syntax), so unlike
 *    scheme.ts / racket.ts this adapter never needs a "skip one datum" scanner.
 *  - Character literals are always `#\<name-or-char>` (CLHS 2.4.6 "Sharpsign Backslash"), never
 *    Clojure's bare `\c` or Emacs Lisp's `?c` -- so the masker must specifically recognize the
 *    `#\` prefix, not a lone backslash or question mark.
 *  - `'` is the QUOTE reader macro (`'foo` == `(quote foo)`), never a string or character
 *    delimiter -- unlike `common.ts`'s shared `stripStringLiterals`, which treats a bare `'` as a
 *    possible char-literal quote (via its Scala-specific `symbolLiterals` option) and would
 *    misparse `'foo` as an unterminated string opener. This is the concrete reason this file hand
 *    rolls its own string/comment pass instead of reusing that shared helper.
 *
 * Line comments are `;` to end of line (CLHS 2.4.8.14). String literals are `"..."` with `\` as
 * the only escape character (CLHS 2.4.5 "Double-Quote"; `""` is NOT a doubled-quote escape the way
 * VHDL's `""` is -- a literal `"` inside a Common Lisp string is always `\"`).
 *
 * Definitions are found by scanning masked text for `(` followed by one of the definer symbols
 * above; a definer's name is the next token, or (for `defstruct` and `defmethod`-with-options) the
 * first symbol found after peeling one extra layer of `(` when the name position itself opens a
 * list (`(defstruct (point (:constructor make-point)) x y)` -> name `point`). Nesting depth is
 * tracked generically ((), [], {} all count toward one counter, matching this repo's convention in
 * vhdl.ts/pascal.ts of depth-counting for scope closure without per-bracket-type matching, since
 * well-formed source never mismatches bracket types at a depth this adapter cares about).
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine } from './common.js'

// Common Lisp definer symbols this adapter recognizes (CLHS Chapter 3, "Evaluation and Compilation" definers), mapped to a symbol kind.
const DEFINERS: ReadonlyMap<string, string> = new Map([
  ['defun', 'function'],
  ['defmacro', 'macro'],
  ['defvar', 'variable'],
  ['defparameter', 'variable'],
  ['defconstant', 'variable'],
  ['defclass', 'class'],
  ['defgeneric', 'generic-function'],
  ['defmethod', 'method'],
  ['defstruct', 'struct'],
  ['defpackage', 'package'],
  ['deftype', 'type'],
  ['define-condition', 'condition'],
  ['define-compiler-macro', 'macro'],
  ['define-symbol-macro', 'variable'],
  ['define-method-combination', 'method-combination'],
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
// Common Lisp symbol-constituent characters: anything but whitespace and the syntax characters
// that always terminate a token (CLHS 2.1.4 "Character Syntax Types").
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && !/[\s()[\]{}"'`,;|#]/.test(ch)

/**
 * Skips one nested `#| ... |#` block comment starting at `start` (which must point at the `#`),
 * per CLHS 2.4.8.19: a `#|` seen while already inside the comment increments depth, and only the
 * matching `|#` decrements it back to zero. Returns the index just past the closing `|#`, or the
 * end of `content` if the comment is never closed.
 */
function maskCommonLispBlockComment(content: string, start: number): number {
  const n = content.length
  let i = start + 2 // past the opening #|
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

/** Masks `;` line comments, nested `#| |#` block comments, `"..."` strings (`\` escapes), and
 * `#\<name>` character literals to spaces (newlines preserved), in one left-to-right pass so a
 * `"` inside a comment or a `;` inside a string is never misread as its own delimiter. */
function maskCommonLisp(content: string): string {
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
      const end = maskCommonLispBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }
    if (ch === '#' && content[i + 1] === '\\') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      // A named character (#\Space, #\Newline) is a run of alphanumerics; anything else
      // (#\(, #\a, #\9) is exactly one character.
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

/** The symbol token starting at `i` (after skipping leading whitespace), or `undefined` at end of input. */
function readToken(masked: string, i: number): { word: string; start: number; end: number } | undefined {
  let p = i
  while (isSpace(masked[p])) p++
  if (p >= masked.length) return undefined
  const start = p
  while (isSymbolChar(masked[p])) p++
  if (p === start) return undefined
  return { word: masked.slice(start, p), start, end: p }
}

export function extractCommonLisp(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskCommonLisp(content)
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
        const kind = DEFINERS.get(tok.word.toLowerCase())
        if (kind !== undefined) {
          let namePos = tok.end
          while (isSpace(masked[namePos])) namePos++
          // (defstruct (point (:constructor make-point)) ...): peel one extra `(` layer when the
          // name position itself opens a list. defmethod qualifiers before the name are out of scope for v1.
          if (masked[namePos] === '(') namePos++
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
