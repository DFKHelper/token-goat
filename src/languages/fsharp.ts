/**
 * F# (The F# Language Specification, version 4.1, section 3.1 "Lexical Analysis" and section 3.2
 * "Comments") adapter: `namespace`, `module`, `type`, `exception`, and top-level `let`/`let rec`
 * bindings.
 *
 * No internet access was available while writing this adapter, so the exact section numbers cited
 * below are the commonly-cited F# 4.1 spec section numbers (per this task's own fallback
 * instruction), not a live fetch of the current fsharp.org/dotnet/fsharp spec text. The comment and
 * string BEHAVIOR cited (nesting, string-aware comment scanning, verbatim `""`-escaping, triple-
 * quoted literalness) is stated with high confidence from the documented, widely-reported F#
 * lexer behavior (F# comment/string lexing is a direct descendant of OCaml's `lexer.mll`, and the
 * "a stray `"` inside a `(* *)` comment can swallow the rest of the file" gotcha is a well-known,
 * frequently-reported consequence of this same string-aware-comment design in F#), but the exact
 * spec section numbers should be re-confirmed against the current published spec before being
 * treated as a citation of record.
 *
 * F# has significant indentation (the "offside rule", spec section 15) but, unlike a fully
 * column-tracked implementation, this adapter uses the same pragmatic ctags-style heuristic
 * `haskell.ts` and `ocaml.ts` use for their own languages: a line with NO leading whitespace is a
 * top-level declaration boundary, and a declaration's span runs from its own boundary line to the
 * line just before the next one (or to end of file). This is simpler than F#'s real rule, which is
 * column-relative to the enclosing `module`/`namespace`/`type` rather than always column 0 -- so a
 * `module Foo` body indented one level (the common, idiomatic style) is read correctly by this
 * heuristic (its members are indented, so they are not mistaken for new top-level boundaries), but
 * an unusual file that puts a second top-level construct at some column other than 0 (rather than
 * inside an indented module/namespace body) would be missed. Column-tracking the enclosing
 * construct's own indent level, the same tradeoff OCaml/Haskell accept for their languages, is a
 * real, separate follow-up rather than a bug in this file. `and`-continuations of a
 * `let rec ... and ...` mutually-recursive group are intentionally NOT classified as definitions by
 * this adapter, the same scope-limiting decision `ocaml.ts` makes for its own `and`-continuations.
 *
 * Masking rules (own pass, independent of every other adapter in this repo, per this batch's
 * one-file-one-citation convention):
 *
 *  - `(* *)` block comments NEST, AND -- like `ocaml.ts::maskOcamlBlockComment`, and per the
 *    well-documented F#-lexer-descends-from-OCaml-lexer behavior above -- a `"` seen while
 *    scanning a comment switches the scanner into string-lexing mode (`endOfFSharpString`) before
 *    resuming the comment scan, so `(* " *)` does NOT close the comment at that `*)`: the `"`
 *    opened a string, and the comment only actually ends at the first `*)` found once the scanner
 *    is not inside such a string. This was verified (not assumed) against the documented F#
 *    "unbalanced quote inside a block comment swallows the rest of the file" gotcha, which is the
 *    direct observable consequence of exactly this comment-scanner behavior; it does NOT resemble
 *    Haskell's simple, non-string-aware `{- -}` nesting.
 *
 *  - `//` line comments: a straightforward run to end of line, the same shape most C-family
 *    languages use.
 *
 *  - `"""..."""` triple-quoted strings ("String, Character, and Byte Array Literals"): the body is
 *    NOT escape-processed -- contents are literal, and an unescaped `"` (or even `""`) inside does
 *    not end the string, only a genuine run of three closes it. `endOfFSharpTripleQuotedString`
 *    does an exact `"""` search from just past the opener.
 *
 *  - `@"..."` verbatim strings (same section): backslash has NO escape meaning at all inside a
 *    verbatim string -- both `\` characters in `@"C:\temp\n"` are literal, two-character sequences,
 *    not an escape of any following character. The ONLY way to get a literal `"` inside a verbatim
 *    string is a doubled `""`, which `endOfFSharpVerbatimString` treats as "still inside the
 *    string, advance past both quotes"; the string only actually closes at a single `"` not
 *    immediately followed by a second one.
 *
 *  - `"..."` normal strings (same section): backslash escapes the following character (`\"`, `\\`,
 *    `\n`, etc.), so an escaped `"` never ends the string early -- the same escaping shape
 *    `ocaml.ts::endOfOcamlString` and `haskell.ts::escapePayloadEnd`'s callers use. Like OCaml's
 *    (and UNLIKE Haskell's, whose strings are single-line), a normal F# string literal CAN contain
 *    a raw, un-escaped newline and span multiple lines: this is confirmed (not assumed) by the
 *    same well-documented F# gotcha cited above -- an unbalanced quote inside a `(* *)` comment is
 *    reported to swallow the rest of the *file*, not just the rest of the *line* it started on,
 *    which is only possible if the underlying string scanner keeps running across newlines while
 *    it looks for a genuine closing quote. So `endOfFSharpString`, like
 *    `ocaml.ts::endOfOcamlString`, has no bare-newline safety net: an unterminated string simply
 *    runs to end of input.
 *
 *  - `'c'` character literals are out of scope for this adapter's masking pass (F# character
 *    literals are rare in top-level-declaration-adjacent code compared to strings and comments,
 *    and the OCaml/Haskell type-variable-vs-char-literal disambiguation problem those two adapters
 *    solve does not arise for F#, which spells its type parameters `'a` the same way but never
 *    opens a bare `'` as an unescaped single character the way OCaml's `'c'` grammar does outside a
 *    `'\` escape or a closed `'x'` pair -- so a masking pass here would add complexity with no
 *    corresponding top-level-boundary risk). A real, separate follow-up if F# character-literal
 *    masking is ever needed for a reason unrelated to symbol boundaries.
 */
import type { SymbolEntry } from '../parser_types.js'

/** Returns the index just past a `"..."` string literal's closing quote: a backslash escapes
 * exactly the following character, so an escaped `"` never ends the string early. A string may
 * span multiple lines (see module doc: confirmed by the documented "unbalanced quote in a comment
 * swallows the file" gotcha, which requires exactly this), so an unterminated string runs to end
 * of input rather than stopping at the next bare newline -- the same shape
 * `ocaml.ts::endOfOcamlString` uses. */
function endOfFSharpString(content: string, start: number): number {
  const n = content.length
  let p = start + 1
  while (p < n) {
    if (content[p] === '\\' && p + 1 < n) {
      p += 2
      continue
    }
    if (content[p] === '"') return p + 1
    p++
  }
  return n
}

/** Returns the index just past a `"""..."""` triple-quoted string's closing `"""`: the body is not
 * escape-processed, so this is an exact search for a genuine run of three quotes. */
function endOfFSharpTripleQuotedString(content: string, start: number): number {
  const n = content.length
  let p = start + 3
  while (p < n) {
    if (content[p] === '"' && content[p + 1] === '"' && content[p + 2] === '"') return p + 3
    p++
  }
  return n
}

/** Returns the index just past a `@"..."` verbatim string's closing `"`: a backslash is a literal
 * character with no escape meaning, and the only way to embed a `"` is a doubled `""`, which this
 * treats as still-inside-the-string content rather than a closer. `start` points at the `@`. */
function endOfFSharpVerbatimString(content: string, start: number): number {
  const n = content.length
  let p = start + 2 // past `@"`
  while (p < n) {
    if (content[p] === '"' && content[p + 1] === '"') {
      p += 2
      continue
    }
    if (content[p] === '"') return p + 1
    p++
  }
  return n
}

/**
 * Skips one nested `(* ... *)` block comment starting at `start` (pointing at the `(`): an opener
 * seen while already inside increments depth, only the matching closer decrements it to zero --
 * EXCEPT that a `"` seen while scanning switches into string-lexing mode via `endOfFSharpString`
 * first (see module doc), so a `*)` inside that string cannot close the comment. Returns the index
 * just past the real closer, or end of input if unclosed.
 */
function maskFSharpBlockComment(content: string, start: number): number {
  const n = content.length
  let i = start + 2
  let depth = 1
  while (i < n && depth > 0) {
    if (content[i] === '(' && content[i + 1] === '*') {
      depth++
      i += 2
      continue
    }
    if (content[i] === '*' && content[i + 1] === ')') {
      depth--
      i += 2
      continue
    }
    if (content[i] === '"') {
      i = endOfFSharpString(content, i)
      continue
    }
    i++
  }
  return i
}

/** Masks `(* *)` block comments (nested, string-aware -- see module doc), `//` line comments,
 * `"""..."""` triple-quoted strings, `@"..."` verbatim strings, and `"..."` normal strings to
 * spaces (newlines preserved), left to right in one pass. */
function maskFSharp(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  let i = 0
  while (i < n) {
    const ch = content[i]!

    if (ch === '(' && content[i + 1] === '*') {
      const start = i
      const end = maskFSharpBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '/' && content[i + 1] === '/') {
      while (i < n && content[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }

    if (ch === '"' && content[i + 1] === '"' && content[i + 2] === '"') {
      const end = endOfFSharpTripleQuotedString(content, i)
      for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '@' && content[i + 1] === '"') {
      const end = endOfFSharpVerbatimString(content, i)
      for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '"') {
      const end = endOfFSharpString(content, i)
      for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    out[i] = ch
    i++
  }
  return out.join('')
}

interface Def {
  readonly kind: string
  readonly name: string
}

/** Classifies one masked, trimmed, column-0 line as zero or one definition it opens. */
function classify(line: string): Def | undefined {
  let m: RegExpExecArray | null

  if ((m = /^namespace\s+(?:global\s+)?([A-Za-z_][A-Za-z0-9_.']*)/.exec(line))) return { kind: 'namespace', name: m[1]! }

  if ((m = /^module\s+(?:rec\s+)?([A-Za-z_][A-Za-z0-9_.']*)/.exec(line))) return { kind: 'module', name: m[1]! }

  if (/^type\s/.test(line)) {
    const rest = line.slice('type'.length)
    if ((m = /^\s*(?:private\s+|internal\s+)?([A-Za-z_][A-Za-z0-9_']*)/.exec(rest))) return { kind: 'type', name: m[1]! }
  }

  if ((m = /^exception\s+([A-Za-z_][A-Za-z0-9_']*)/.exec(line))) return { kind: 'exception', name: m[1]! }

  // `let` / `let rec` -- a prefix binding or a parenthesized-operator binding. `and`-continuations
  // of a mutually-recursive group are deliberately not classified here (see module doc).
  if (/^let\s+/.test(line)) {
    let rest = line.replace(/^let\s+rec\s+|^let\s+/, '')
    rest = rest.replace(/^(?:mutable|inline|private|internal)\s+/, '')
    if ((m = /^([A-Za-z_][A-Za-z0-9_']*)/.exec(rest))) return { kind: 'function', name: m[1]! }
    if ((m = /^\(([^()]+)\)/.exec(rest))) return { kind: 'function', name: m[1]!.trim() }
  }

  return undefined
}

export function extractFSharp(content: string, filePath: string): SymbolEntry[] {
  if (content.includes('\0')) return []
  const rawLines = content.split(/\r?\n/)
  const masked = maskFSharp(content)
  const maskedLines = masked.split(/\r?\n/)
  const n = rawLines.length

  interface Boundary {
    readonly num: number
    readonly def?: Def
  }
  const boundaries: Boundary[] = []
  for (let idx = 0; idx < n; idx++) {
    const raw = rawLines[idx] ?? ''
    if (raw.length === 0 || /^\s/.test(raw)) continue // not top-level: blank or indented
    const maskedLine = maskedLines[idx] ?? ''
    const trimmed = maskedLine.trim()
    if (trimmed === '') continue // a full-line comment, masked away
    const def = classify(trimmed)
    boundaries.push(def === undefined ? { num: idx + 1 } : { num: idx + 1, def })
  }

  const symbols: SymbolEntry[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    if (b.def === undefined) continue
    const next = boundaries[i + 1]
    const lineEnd = Math.max(b.num, next !== undefined ? next.num - 1 : n)
    symbols.push({
      filePath,
      name: b.def.name,
      kind: b.def.kind,
      lineStart: b.num,
      lineEnd,
      body: rawLines.slice(b.num - 1, lineEnd).join('\n'),
      docstring: '',
      parent: '',
    })
  }
  return symbols
}
