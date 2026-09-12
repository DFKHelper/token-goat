/**
 * OCaml (The OCaml Manual, chapter 11 "The OCaml language", section 1 "Lexical conventions",
 * https://v2.ocaml.org/manual/lex.html) adapter: `module`, `module type`, `type`, `exception`,
 * `class`, `external`, and top-level `let`/`let rec` bindings.
 *
 * Like Haskell, OCaml has no `{`/`}`/`begin`/`end` delimiter forced around every top-level
 * declaration, so this adapter uses the same ctags-style heuristic `haskell.ts` and
 * `kotlin.ts`/`elixir.ts` use for their own languages: a line with NO leading whitespace is a
 * top-level declaration boundary, and a declaration's span runs from its own boundary line to the
 * line just before the next one (or to end of file). Unlike Haskell, OCaml has no multi-equation
 * binding (`f 0 = 1` / `f n = ...` as separate clauses of one binding), so there is no clause-
 * merging pass here: each `let`/`and` boundary is its own symbol. `and`-continuations of a
 * `let rec ... and ...` mutually-recursive group are intentionally NOT classified as definitions by
 * this adapter (real scope-limiting decision, not an oversight -- see the module doc's mask-only
 * focus below); this is a genuine, separate follow-up, the same way `.lhs` is for `haskell.ts`.
 *
 * Masking rules (own pass, independent of every other adapter in this repo, per this batch's
 * one-file-one-citation convention -- see haskell.ts's and scheme.ts's module docs for the
 * rationale):
 *
 *  - `(* *)` block comments NEST (manual, "Comments", https://v2.ocaml.org/manual/lex.html#sss:lex:comments:
 *    "Comments are introduced by the two characters (*, ... and terminated by the characters *) ...
 *    Nested comments are handled correctly."). `maskOcamlBlockComment` counts nesting depth the
 *    same way `haskell.ts::maskHaskellBlockComment` does for `{- -}`, written independently since
 *    the delimiters, citation, and (below) the in-comment string handling differ.
 *
 *  - THE PART THAT MAKES THIS ITS OWN ADAPTER RATHER THAN A COPY OF HASKELL'S: the same "Comments"
 *    section of the manual also says "Comments do not occur inside string or character literals."
 *    Read from the comment scanner's point of view (and confirmed against the real OCaml lexer's
 *    `comment` rule in `lexer.mll`, which has its own `"\""` case that recurses into full string
 *    lexing before resuming the comment scan), this means a `"` seen while scanning a comment
 *    switches the scanner into ordinary string-lexing mode: it looks for the next unescaped `"`,
 *    and any `(*`/`*)` text inside that string does not affect comment nesting or closing. So
 *    `(* " *)` does NOT close the comment at that `*)`: the `"` opened a string, that string is
 *    not yet closed (the `*)` and everything after it, up to the real closing quote, are just
 *    string content), and the comment only actually ends at the first *)* found once the scanner
 *    is not inside such a string. `maskOcamlBlockComment` implements this by delegating to
 *    `endOfOcamlString` (the same string-end scanner top-level code strings use, see below)
 *    whenever it sees a `"` while depth > 0.
 *
 *  - `"..."` string literals (manual, "String literals",
 *    https://v2.ocaml.org/manual/lex.html#sss:stringliterals): backslash escapes the following
 *    character (`\\`, `\"`, `\n`, a decimal/hex/octal numeric escape, a Unicode `\u{...}` escape,
 *    or a line-continuation `\<newline>`), so an escaped `"` never ends the string early. Per the
 *    same section, a string literal may itself span multiple lines (no bare-newline safety net is
 *    needed or wanted here, unlike Haskell's single-line strings): an unterminated string simply
 *    runs to end of file, matching how the real compiler reports it as one lexer error rather than
 *    silently resuming at the next line.
 *
 *  - `{id|...|id}` quoted string literals (same "String literals" section): "Quoted strings are
 *    delimited by a matching pair of `{ quoted-string-id |` and `| quoted-string-id }` with the
 *    same quoted-string-id on both sides. Quoted strings do not interpret any character in a
 *    special way." `quoted-string-id` is `{ lowercase-letter | _ }` (possibly empty, giving the
 *    common `{|...|}` form). Because the id is user-chosen and the body is interpreted literally,
 *    the only correct way to find the end is an exact search for `|id}` -- there is no escaping to
 *    reason about. `src/languages/common.ts::matchRRawOpener` was checked as a possible reusable
 *    helper (R's `r"(id)[...]delim(id)"` raw string opener is a superficially similar
 *    "arbitrary user-chosen delimiter" shape) but is not reusable here: it requires a leading
 *    `r`/`R` prefix character, matches via a bracket-choice regex (`R_RAW_OPENER_RE` picks the
 *    correct closing bracket for `(`/`[`/`{`), and its closer is `bracket + delim + id`, not
 *    OCaml's plain `{id|` / `|id}` pair with no prefix letter and no bracket choice -- so this
 *    adapter implements its own opener/closer scan (`matchOcamlQuotedStringOpener`,
 *    `endOfOcamlQuotedString`) rather than adapting that function.
 *
 *  - `'c'` character literals (manual, "Character literals",
 *    https://v2.ocaml.org/manual/lex.html#sss:character-literals): a regular character (anything
 *    but `'` or `\`), or one of the escape-sequence forms (`\\`, `\"`, `\'`, `\n`, `\t`, `\b`, `\r`,
 *    `\ ` (escaped space), `\ddd` decimal, `\xhh` hex, `\ooo` octal). A `'` is only attempted as a
 *    character-literal opener when the previous character is not itself an identifier character
 *    (OCaml's own `ident` production allows a trailing `'`, e.g. `x'`, `map'`) AND the text at that
 *    position actually matches one of the closed forms above. This is deliberate: OCaml also uses
 *    a bare `'` immediately followed by a lowercase letter for a type variable (`'a`, `'b`), and a
 *    type variable is never followed by a matching close-quote the way a real character literal
 *    is, so a `'a` that doesn't close within the fixed lookahead these patterns check is correctly
 *    left as ordinary code rather than treated as an unterminated character literal.
 *
 * A `'*)'`-shaped character literal appearing *inside* a comment (the OCaml lexer's own `comment`
 * rule also special-cases `'`-delimited literals there) is explicitly OUT of scope: this adapter's
 * in-comment awareness covers only the string-literal case the manual states in the same
 * "Comments do not occur inside string or character literals" sentence. Nesting into a
 * character-literal reader inside a comment is a real, separate follow-up.
 */
import type { SymbolEntry } from '../parser_types.js'

const ESCAPE_SIMPLE = new Set(['\\', '"', "'", 'n', 't', 'b', 'r', ' '])
const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_']/.test(ch)
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9'
const isHexDigit = (ch: string | undefined): boolean => ch !== undefined && /[0-9A-Fa-f]/.test(ch)
const isOctalDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '7'

/** Returns the index just past a `"..."` string literal's closing quote (manual, "String
 * literals"): a backslash escapes exactly the following character, so an escaped `"` never ends
 * the string early. A string may span multiple lines, so an unterminated string runs to end of
 * input rather than stopping at the next bare newline. */
function endOfOcamlString(content: string, start: number): number {
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

/**
 * Skips one nested `(* ... *)` block comment starting at `start` (pointing at the `(`), per the
 * manual's "Comments" section: an opener seen while already inside increments depth, only the
 * matching closer decrements it to zero -- EXCEPT that a `"` seen while scanning switches into
 * string-lexing mode via `endOfOcamlString` first (per the same section: "Comments do not occur
 * inside string or character literals"), so a `*)` inside that string cannot close the comment.
 * Returns the index just past the real closer, or end of input if unclosed.
 */
function maskOcamlBlockComment(content: string, start: number): number {
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
      i = endOfOcamlString(content, i)
      continue
    }
    i++
  }
  return i
}

/** Matches a quoted-string opener `{id|` at `start` (content[start] === '{'), where `id` is a
 * possibly-empty run of lowercase letters/underscores (manual, "String literals",
 * `quoted-string-id`). Returns null when `start` is not such an opener (an ordinary `{`, e.g. a
 * record or module-signature brace). */
function matchOcamlQuotedStringOpener(content: string, start: number): { openerEnd: number; id: string } | null {
  const n = content.length
  let j = start + 1
  while (j < n && /[a-z_]/.test(content[j]!)) j++
  if (content[j] !== '|') return null
  return { openerEnd: j + 1, id: content.slice(start + 1, j) }
}

/** Returns the index just past a quoted string's closer `|id}` (an exact search: quoted strings
 * "do not interpret any character in a special way", so there is no escaping to reason about). */
function endOfOcamlQuotedString(content: string, afterOpener: number, id: string): number {
  const closer = `|${id}}`
  const idx = content.indexOf(closer, afterOpener)
  return idx === -1 ? content.length : idx + closer.length
}

/** Matches a `'c'` character literal at `start` (content[start] === "'"), per the manual's
 * "Character literals" grammar. Returns its length (including both quotes), or null when the text
 * at `start` does not close as a valid literal within the fixed lookahead each form requires --
 * the case that lets a `'a`/`'b` type-variable tick fall through untouched. */
function matchOcamlCharLiteral(content: string, start: number): number | null {
  const c1 = content[start + 1]
  if (c1 === '\\') {
    const c2 = content[start + 2]
    if (c2 !== undefined && ESCAPE_SIMPLE.has(c2) && content[start + 3] === "'") return 4
    if (isDigit(c2) && isDigit(content[start + 3]) && isDigit(content[start + 4]) && content[start + 5] === "'") return 6
    if (c2 === 'x' && isHexDigit(content[start + 3]) && isHexDigit(content[start + 4]) && content[start + 5] === "'") return 6
    if (c2 === 'o' && isOctalDigit(content[start + 3]) && isOctalDigit(content[start + 4]) && isOctalDigit(content[start + 5]) && content[start + 6] === "'") return 7
    return null
  }
  if (c1 !== undefined && c1 !== "'" && content[start + 2] === "'") return 3
  return null
}

/** Masks `(* *)` block comments (nested, string-aware -- see module doc), `"..."` strings,
 * `{id|...|id}` quoted strings, and `'c'` character literals to spaces (newlines preserved), left
 * to right in one pass. */
function maskOcaml(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  let i = 0
  while (i < n) {
    const ch = content[i]!

    if (ch === '(' && content[i + 1] === '*') {
      const start = i
      const end = maskOcamlBlockComment(content, i)
      for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '"') {
      const end = endOfOcamlString(content, i)
      for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
      i = end
      continue
    }

    if (ch === '{') {
      const opener = matchOcamlQuotedStringOpener(content, i)
      if (opener !== null) {
        const end = endOfOcamlQuotedString(content, opener.openerEnd, opener.id)
        for (let k = i; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
        i = end
        continue
      }
    }

    if (ch === "'" && !isIdentChar(i > 0 ? content[i - 1] : undefined)) {
      const len = matchOcamlCharLiteral(content, i)
      if (len !== null) {
        for (let k = i; k < i + len; k++) out[k] = content[k] === '\n' ? '\n' : ' '
        i += len
        continue
      }
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

  if ((m = /^module\s+type\s+([A-Z][A-Za-z0-9_']*)/.exec(line))) return { kind: 'module_type', name: m[1]! }
  if ((m = /^module\s+([A-Z][A-Za-z0-9_']*)/.exec(line))) return { kind: 'module', name: m[1]! }

  if (/^type\s/.test(line)) {
    const rest = line.slice('type'.length).replace(/^\s*nonrec\s+/, '')
    if ((m = /([a-z_][A-Za-z0-9_']*)\s*(?:=|$)/.exec(rest))) return { kind: 'type', name: m[1]! }
  }

  if ((m = /^exception\s+([A-Z][A-Za-z0-9_']*)/.exec(line))) return { kind: 'exception', name: m[1]! }

  if ((m = /^class\s+(?:virtual\s+)?([a-z_][A-Za-z0-9_']*)/.exec(line))) return { kind: 'class', name: m[1]! }

  if ((m = /^external\s+([a-z_][A-Za-z0-9_']*)/.exec(line))) return { kind: 'function', name: m[1]! }

  // `let` / `let rec` -- a prefix binding or a parenthesized-operator binding. `and`-continuations
  // of a mutually-recursive group are deliberately not classified here (see module doc).
  if (/^let\s+/.test(line)) {
    const rest = line.replace(/^let\s+rec\s+|^let\s+/, '')
    if ((m = /^([a-z_][A-Za-z0-9_']*)/.exec(rest))) return { kind: 'function', name: m[1]! }
    if ((m = /^\(([^()]+)\)/.exec(rest))) return { kind: 'function', name: m[1]!.trim() }
  }

  return undefined
}

export function extractOcaml(content: string, filePath: string): SymbolEntry[] {
  if (content.includes('\0')) return []
  const rawLines = content.split(/\r?\n/)
  const masked = maskOcaml(content)
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
