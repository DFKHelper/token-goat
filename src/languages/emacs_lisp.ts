/**
 * Emacs Lisp adapter: `defun`, `defmacro`, `defvar`, `defcustom`, `defconst`, `defgroup`,
 * `defface`, `define-derived-mode`, `define-minor-mode`, and the `cl-lib` forms `cl-defun`,
 * `cl-defmacro`, `cl-defstruct`, `cl-defgeneric`, `cl-defmethod` that real Emacs Lisp source uses
 * constantly.
 *
 * Its own file with its own masker, per the settled decision in `templates_idx.ts`'s module doc.
 * The GNU Emacs Lisp Reference Manual gives this dialect the simplest comment grammar of the five
 * but a character-literal syntax none of the others share:
 *  - Only `;` line comments exist (Emacs Lisp Reference Manual, node "Comment Tips"; there is no
 *    `#| |#` block comment in Emacs Lisp at all -- like Clojure, but for a different reason: Emacs
 *    Lisp's reader simply never defines that syntax). So this file has no
 *    `maskEmacsLispBlockComment` for the same reason `clojure.ts` has none, and for the same
 *    reason given there: writing one by analogy to Common Lisp/Scheme/Racket would blank real
 *    source between an incidental `#|` and an unrelated later `|#`.
 *  - Character literals are `?<char-or-escape>` (Emacs Lisp Reference Manual, node "Basic Char
 *    Syntax" / "General Escape Syntax"): `?a`, `?\n`, `?\t`, `?\C-a` (control), `?\M-a` (meta),
 *    `?\^A` (caret-control), `?\d` (DEL), octal `?\101`, or hex `?\x41`. None of the other four
 *    Lisp dialects in this batch use a bare `?` to introduce a character -- Common
 *    Lisp/Scheme/Racket all use `#\`, and Clojure uses a bare `\`. A masker written for any of
 *    those would neither recognize `?\C-a` nor stop it from swallowing the file's next `"` or `;`
 *    as though it were still inside the literal.
 *  - `?` is also a legal symbol-constituent character in an Emacs Lisp identifier (rare, but
 *    legal), so this masker only treats `?` as opening a character literal when the immediately
 *    preceding emitted character is a delimiter or start-of-input -- the same technique
 *    `vhdl.ts::maskVhdl` uses to tell a character literal's opening `'` apart from an attribute
 *    tick (`clk'event`).
 *  - `'` is the QUOTE abbreviation, never a string delimiter -- the same reason the other four
 *    Lisp adapters in this batch do not reuse `common.ts::stripStringLiterals`.
 *
 * Strings are `"..."` with `\` escapes (Emacs Lisp Reference Manual, node "String Type").
 *
 * `defalias`/`fset`-style indirect naming (where the defined name is itself a quoted argument
 * rather than the bare next token) is out of scope for v1, matching this repo's convention
 * elsewhere of only listing definitions its adapter can name with confidence.
 */

import { SpanCollector, type StatementAdapterResult } from './span_collector.js'
import { buildLineIndex, offsetToLine } from './common.js'

const DEFINERS: ReadonlyMap<string, string> = new Map([
  ['defun', 'function'],
  ['cl-defun', 'function'],
  ['defmacro', 'macro'],
  ['cl-defmacro', 'macro'],
  ['defvar', 'variable'],
  ['defvar-local', 'variable'],
  ['defcustom', 'variable'],
  ['defconst', 'variable'],
  ['defgroup', 'group'],
  ['defface', 'face'],
  ['define-derived-mode', 'mode'],
  ['define-minor-mode', 'mode'],
  ['cl-defstruct', 'struct'],
  ['cl-defgeneric', 'generic-function'],
  ['cl-defmethod', 'method'],
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)
// Emacs Lisp symbol-constituent characters: anything but whitespace and the syntax characters
// that terminate a token (Emacs Lisp Reference Manual, node "Symbol Type"). `?` is excluded from
// the token scan itself only where it opens a character literal (handled separately in the mask
// loop below); as an ordinary token character elsewhere it is legal, but this adapter never needs
// to read a definer or symbol name containing one.
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && !/[\s()[\]{}"';`,#]/.test(ch)

/** True when `prevEmitted` (the last character the masker has already written to `out`, or
 * `undefined` at start of input) is a position where a new datum may begin -- used to tell a
 * character-literal `?` apart from one occurring inside/after an identifier. */
function atReadPosition(prevEmitted: string | undefined): boolean {
  return prevEmitted === undefined || /[\s([{'`,]/.test(prevEmitted)
}

/** Masks `;` line comments, `"..."` strings (`\` escapes) and `?<char-or-escape>` character
 * literals to spaces (newlines preserved), left to right in one pass. Emacs Lisp has no block
 * comment (GNU Emacs Lisp Reference Manual, node "Comment Tips"), so unlike
 * common_lisp.ts/scheme.ts/racket.ts there is no `#| |#` branch here at all. */
function maskEmacsLisp(content: string): string {
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
    if (ch === '?' && atReadPosition(i > 0 ? out[i - 1] : undefined)) {
      const start = i
      i++
      if (content[i] === '\\') {
        i++
        // General escape syntax: `\C-`/`\M-`/`\S-`/`\A-`/`\H-`/`\s-` modifier prefixes may chain
        // before the final character, and an octal (`\101`) or hex (`\x41`) form runs several
        // digits long. A generous bounded run of escape-safe characters covers every real form
        // without an unbounded scan.
        let guard = 0
        while (i < n && guard < 16 && /[A-Za-z0-9^\-\\]/.test(content[i]!)) {
          i++
          guard++
        }
        // Plain basic escapes (`?\"`, `?\;`, `?\(`, ...) name a character that is not alnum/^/-/\
        // and so never enter the loop above; per Basic Char Syntax, a lone `\<c>` still denotes
        // exactly `c`, so consume that one character rather than leaving it unmasked -- otherwise
        // e.g. `?\"` leaves the `"` to be misread as a real string opener by the branch below.
        if (guard === 0 && i < n && content[i] !== '\n') i++
      } else if (i < n && content[i] !== '\n') {
        i++
      }
      for (let k = start; k < i; k++) out[k] = content[k] === '\n' ? '\n' : ' '
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

export function extractEmacsLisp(content: string, filePath: string): StatementAdapterResult {
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const masked = maskEmacsLisp(content)
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
    if (ch === '(' || ch === '[') {
      depth++
      const tok = readToken(masked, i + 1)
      if (tok !== undefined) {
        const kind = DEFINERS.get(tok.word.toLowerCase())
        if (kind !== undefined) {
          const nameTok = readToken(masked, tok.end)
          const name = nameTok?.word ?? ''
          const idx = spans.open(name, kind, lineOf(i), owner())
          stack.push({ index: idx, depth })
        }
      }
      i++
      continue
    }
    if (ch === ')' || ch === ']') {
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
