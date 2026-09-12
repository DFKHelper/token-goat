/**
 * Haskell (Haskell 2010 Language Report) adapter: `module`, `data`/`newtype`, `type`, `class`,
 * `instance`, and top-level function bindings (a type signature and/or one or more equations).
 *
 * Haskell has no `{`/`}`/`begin`/`end` delimiter around a top-level declaration -- the layout
 * rule (Report section 2.7) infers braces and semicolons from indentation instead. Rather than
 * implement the full layout algorithm, this adapter uses the same heuristic every Haskell ctags
 * generator uses: a line with NO leading whitespace is a top-level declaration boundary, and a
 * declaration's span runs from its own boundary line to the line just before the next one (or to
 * end of file). This is exact for idiomatically-formatted Haskell (every real-world style guide
 * requires top-level declarations to start in column 1) and is the same assumption
 * `elixir.ts`/`kotlin.ts` make for their own languages' equivalent "what counts as a top-level
 * name" question.
 *
 * Masking rules (own pass, independent of every other adapter in this repo, per this batch's
 * established one-file-one-citation convention -- see scheme.ts's module doc for the rationale):
 *
 *  - `{- -}` block comments NEST (Report section 2.3, "Comments": "A nested comment begins with
 *    "{-" and ends with "-}" ... Nested comments are also used for compiler pragmas.", and the
 *    lexer grammar's `ncomment` production is defined recursively over `ANY | ncomment`, i.e. a
 *    complete nested comment is itself a legal ANY-run inside another one). `maskHaskellBlockComment`
 *    counts nesting depth the same way `scheme.ts::maskSchemeBlockComment` does for `#| |#`, written
 *    independently since the delimiters and citation differ.
 *  - `--` line comments, per Report section 2.3: "An ordinary comment begins with a sequence of
 *    two or more consecutive dashes (e.g. --) and extends to the following newline. The sequence
 *    of dashes must not form part of a legal lexeme. For example, "-->" or "|--" do not begin a
 *    comment, because both of these are legal lexemes; however "--foo" does start a comment."
 *    Section 2.4's lexical grammar backs this precisely: `varsym -> ( symbol⟨:⟩ {symbol} ) ⟨reservedop | dashes⟩`
 *    where `dashes -> -- {-}` (two or more dashes) is explicitly EXCLUDED from the legal-varsym
 *    set. So a maximal run of two-or-more dashes is a comment marker only when nothing after it
 *    extends it into a longer symbolic token; if the character right after the run is itself one
 *    of `ascSymbol`'s characters (section 2.4: `! # $ % & * + . / < = > ? @ \ ^ | - ~ :`), the
 *    whole thing is one operator lexeme (e.g. `-->`) and not a comment. `isSymbolChar` below is
 *    exactly that `ascSymbol` set (ASCII only -- `uniSymbol` is out of scope for this adapter).
 *    The dash run itself is only ever attempted at a token boundary (the previous character is
 *    not itself a symbol char), so a dash run glued onto a preceding symbolic prefix (the
 *    Report's own "|--" example) is never mistaken for a comment opener either.
 *  - `"..."` strings and `'x'` characters follow section 2.6: backslash escapes a following
 *    character (including a literal `"` inside a string, or `'` inside a character literal), and
 *    a named/numeric escape (`\n`, `\NUL`, `\233`) is consumed as a run of letters or digits so a
 *    multi-character escape doesn't leave a stray character live. A `'` is only attempted as a
 *    character-literal opener when the previous character is not itself an identifier character
 *    (section 2.4's `varid`/`conid` both allow a trailing `'`, e.g. `x'`, `map'`), since a genuine
 *    character literal can never immediately follow an identifier character with no separator.
 *
 * `.lhs` (literate Haskell) is explicitly OUT of scope: this adapter only claims `.hs`. Literate
 * Haskell interleaves prose and code using either bird tracks (`>`-prefixed lines) or
 * `\begin{code}`/`\end{code}` LaTeX blocks (GHC User's Guide, "Literate comments"), and correctly
 * telling code from prose needs its own masking pass this adapter does not implement. Extending
 * to `.lhs` is a real, separate follow-up, not a a bug in this file.
 */

import type { SymbolEntry } from '../parser_types.js'

// Report section 2.4, `ascSymbol` production (ASCII subset only -- `uniSymbol` is out of scope).
const SYMBOL_CHARS = new Set(['!', '#', '$', '%', '&', '*', '+', '.', '/', '<', '=', '>', '?', '@', '\\', '^', '|', '-', '~', ':'])
const isSymbolChar = (ch: string | undefined): boolean => ch !== undefined && SYMBOL_CHARS.has(ch)
const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_']/.test(ch)

/**
 * Skips one nested `{- ... -}` block comment starting at `start` (pointing at the `{`), per
 * Report section 2.3: a `{-` seen while already inside increments depth, only the matching `-}`
 * decrements it to zero. Returns the index just past the closer, or end of input if unclosed.
 */
function maskHaskellBlockComment(content: string, start: number): number {
  const n = content.length
  let i = start + 2
  let depth = 1
  while (i < n && depth > 0) {
    if (content[i] === '{' && content[i + 1] === '-') {
      depth++
      i += 2
      continue
    }
    if (content[i] === '-' && content[i + 1] === '}') {
      depth--
      i += 2
      continue
    }
    i++
  }
  return i
}

/** Consumes an escape's payload after the backslash in a string/char literal: a run of letters or
 * digits for a named/numeric escape (`\NUL`, `\ESC`, `\233`), otherwise exactly one character
 * (`\\`, `\"`, `\'`, `\n`). Returns the index just past the consumed payload. */
function escapePayloadEnd(content: string, afterBackslash: number): number {
  const n = content.length
  const ch = content[afterBackslash]
  if (ch !== undefined && /[0-9]/.test(ch)) {
    let p = afterBackslash
    while (p < n && /[0-9]/.test(content[p]!)) p++
    return p
  }
  if (ch !== undefined && /[A-Za-z]/.test(ch)) {
    let p = afterBackslash
    while (p < n && /[A-Za-z0-9]/.test(content[p]!)) p++
    return p
  }
  return Math.min(afterBackslash + 1, n)
}

/** Masks `--` line comments, nested `{- -}` block comments, `"..."` strings, and `'x'` character
 * literals to spaces (newlines preserved), left to right in one pass. */
function maskHaskell(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  let i = 0
  while (i < n) {
    const ch = content[i]!

    if (ch === '{' && content[i + 1] === '-') {
      const start = i
      const end = maskHaskellBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '-') {
      const prev = i > 0 ? content[i - 1] : undefined
      if (!isSymbolChar(prev)) {
        let j = i
        while (content[j] === '-') j++
        if (j - i >= 2 && !isSymbolChar(content[j])) {
          while (i < n && content[i] !== '\n') {
            out[i] = ' '
            i++
          }
          continue
        }
      }
      out[i] = ch
      i++
      continue
    }

    if (ch === '"') {
      out[i] = '"'
      i++
      while (i < n) {
        if (content[i] === '\\' && i + 1 < n) {
          const end = escapePayloadEnd(content, i + 1)
          for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
          i = end
          continue
        }
        if (content[i] === '"') {
          out[i] = '"'
          i++
          break
        }
        if (content[i] === '\n') break // unterminated safety net: never swallow past a bare newline
        out[i] = ' '
        i++
      }
      continue
    }

    if (ch === "'" && !isIdentChar(i > 0 ? content[i - 1] : undefined)) {
      let j = i + 1
      if (content[j] === '\\' && j + 1 <= n) {
        j = escapePayloadEnd(content, j + 1)
      } else if (content[j] !== undefined && content[j] !== '\n') {
        j++
      }
      if (content[j] === "'") {
        for (let k = i; k <= j; k++) out[k] = content[k] === '\n' ? '\n' : ' '
        i = j + 1
        continue
      }
      // Not a closed character literal within reach: a Template Haskell quote (`'Con`, `''Type`)
      // or a stray apostrophe -- leave it as ordinary code.
      out[i] = ch
      i++
      continue
    }

    out[i] = ch
    i++
  }
  return out.join('')
}

const RESERVED_TOP = new Set([
  'module', 'import', 'data', 'newtype', 'type', 'class', 'instance', 'deriving',
  'infixl', 'infixr', 'infix', 'foreign', 'default', 'where', 'let', 'in', 'do',
  'case', 'of', 'if', 'then', 'else',
])

interface Def {
  readonly kind: string
  readonly name: string
}

/** Returns true when `line` (already comment/string/char masked) has a bare `=` that is not part
 * of `==`, `<=`, `>=`, `/=`, or `=>` -- the "this line's shape is an equation" test. */
function hasTopLevelEquals(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '=') continue
    const prev = line[i - 1]
    const next = line[i + 1]
    if (prev === '<' || prev === '>' || prev === '!' || prev === '/' || prev === '=') continue
    if (next === '=' || next === '>') continue
    return true
  }
  return false
}

/** Skips a leading `(context) =>` / `context =>` on a `class`/`instance` head, via a plain
 * string search (not a `.*=>` regex, which overlaps with the surrounding `\s` runs). */
function afterContext(rest: string): string {
  const arrow = rest.indexOf('=>')
  return (arrow >= 0 ? rest.slice(arrow + 2) : rest).trimStart()
}

/** Classifies one masked, trimmed, column-0 line as zero or more definitions it opens. */
function classify(line: string): Def[] | undefined {
  let m: RegExpExecArray | null

  if ((m = /^module\s+([A-Za-z_][A-Za-z0-9_.']*)/.exec(line))) return [{ kind: 'module', name: m[1]! }]

  if ((m = /^(?:data|newtype)\s+(?:instance\s+)?([A-Z][A-Za-z0-9_']*)/.exec(line))) return [{ kind: 'type', name: m[1]! }]

  if ((m = /^type\s+(?:family\s+)?([A-Z][A-Za-z0-9_']*)/.exec(line))) return [{ kind: 'type', name: m[1]! }]

  // `class Foo a where` / `class Eq a => Ord a where` -- a leading `context =>` is skipped by a
  // plain string search rather than a `.*=>` regex, which ReDoS-linting flags for the overlap
  // between `.*` and the surrounding `\s` runs.
  if (/^class\s/.test(line)) {
    const rest = afterContext(line.slice('class'.length))
    if ((m = /^([A-Z][A-Za-z0-9_']*)/.exec(rest))) return [{ kind: 'class', name: m[1]! }]
  }

  if (/^instance\s/.test(line)) {
    const rest = afterContext(line.slice('instance'.length))
    const name = rest.replace(/\bwhere\s*$/, '').trim().slice(0, 120)
    if (name) return [{ kind: 'instance', name }]
  }

  // `name, name2 :: Type` -- a signature may name several bindings at once.
  if ((m = /^([a-z_][A-Za-z0-9_']*(?:\s*,\s*[a-z_][A-Za-z0-9_']*)*)\s*::/.exec(line))) {
    return m[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((name) => ({ kind: 'function', name }))
  }
  // `(op) :: Type` -- an operator's own signature.
  if ((m = /^\(([^()]+)\)\s*::/.exec(line))) return [{ kind: 'function', name: m[1]!.trim() }]

  // `name args... = ...` / `name = ...` -- a prefix equation.
  if ((m = /^([a-z_][A-Za-z0-9_']*)\b/.exec(line))) {
    const name = m[1]!
    if (!RESERVED_TOP.has(name) && hasTopLevelEquals(line)) return [{ kind: 'function', name }]
    return undefined
  }
  // `(op) args... = ...` -- a parenthesized-operator equation.
  if ((m = /^\(([^()]+)\)/.exec(line))) {
    if (hasTopLevelEquals(line)) return [{ kind: 'function', name: m[1]!.trim() }]
  }

  return undefined
}

export function extractHaskell(content: string, filePath: string): SymbolEntry[] {
  if (content.includes('\0')) return []
  const rawLines = content.split(/\r?\n/)
  const masked = maskHaskell(content)
  const maskedLines = masked.split(/\r?\n/)
  const n = rawLines.length

  interface Boundary {
    readonly num: number
    readonly def?: Def
    consumed: boolean
  }
  const boundaries: Boundary[] = []
  for (let idx = 0; idx < n; idx++) {
    const raw = rawLines[idx] ?? ''
    if (raw.length === 0 || /^\s/.test(raw)) continue // not top-level: blank or indented
    const maskedLine = maskedLines[idx] ?? ''
    const trimmed = maskedLine.trim()
    if (trimmed === '') continue // a full-line comment/pragma, masked away
    const defs = classify(trimmed)
    if (defs === undefined) {
      boundaries.push({ num: idx + 1, consumed: false })
      continue
    }
    for (const def of defs) boundaries.push({ num: idx + 1, def, consumed: false })
  }

  const symbols: SymbolEntry[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    if (b.def === undefined || b.consumed) continue
    let endIdx = i
    if (b.def.kind === 'function') {
      while (
        endIdx + 1 < boundaries.length &&
        boundaries[endIdx + 1]!.def?.kind === 'function' &&
        boundaries[endIdx + 1]!.def?.name === b.def.name
      ) {
        boundaries[endIdx + 1]!.consumed = true
        endIdx++
      }
    }
    const next = boundaries[endIdx + 1]
    const lineEnd = Math.max(b.num, (next !== undefined ? next.num - 1 : n))
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
