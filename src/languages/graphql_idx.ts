/**
 * GraphQL schema / document extractor.
 *
 * Extracts types, queries, mutations, subscriptions, fragments, directives,
 * enums, interfaces, inputs, unions, scalars, and schema blocks.
 * Each symbol also becomes a section for surgical `token-goat section` reads.
 * Pure-regex; no tree-sitter dependency.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection, MultilineStringState, AdapterImport } from './common.js'
import {
  assignFlatEndLines,
  buildLineIndex,
  findMatchingBraceEndLine,
  isInsideStringLiteral,
  makeSymbolEmitter,
  offsetToLine,
  propagateEndLinesToSymbols,
  stripHashComments,
  stripMultilineStringSpan,
  stripStringLiterals,
} from './common.js'
import { countContentLines } from '../util.js'

// Finds the index of the first `#` on `line` that isn't sitting inside an open single- or
// double-quoted string literal on that same line - i.e. a real line-comment start. Used by
// `stripGraphqlDescriptions` to decide, when not already inside an open block description,
// whether a `#` or a `"""` description opener comes first on the line: whichever comes first
// wins, since a `#` before any opener starts a real comment (and any `"""`-looking text after it
// is just comment prose, not a real opener), while an opener before any `#` means the rest of the
// line - `#` included - is description content, not a comment.
function findUnquotedHash(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && !isInsideStringLiteral(line, i)) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Import pragma: # import FragmentName from "path.graphql"
// ---------------------------------------------------------------------------
const GRAPHQL_IMPORT_RE =
  /^[ \t]*#[ \t]*import\b(?:[^"'\n]*)?['"]([^'"]+)['"]/gm

// type / interface / input / enum / union / scalar (+ optional extend prefix). The
// keyword-to-name separator is restricted to same-line horizontal whitespace ([ \t]+, not the
// generic \s+, which also matches a newline): GraphQL enum values are ordinary Name tokens, so an
// enum can legally have a member whose text collides with a type-system keyword (e.g. an enum
// value literally named `scalar` or `type`). With a newline-crossing \s+, a keyword-valued enum
// member sitting alone on its line got misread as the keyword itself, greedily binding the next
// physical line's enum value as the declaration name and emitting a phantom top-level symbol.
const TYPE_RE =
  /^[ \t]*(extend[ \t]+)?(?<keyword>type|interface|input|enum|union|scalar)[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)/gm

// directive @name
const DIRECTIVE_RE = /^[ \t]*directive[ \t]+@([A-Za-z_][A-Za-z0-9_]*)/gm

// fragment FragmentName on …
const FRAGMENT_RE = /^[ \t]*fragment[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+on[ \t]+/gm

// query/mutation/subscription Name
const OPERATION_RE =
  /^[ \t]*(?<op>query|mutation|subscription)[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_]*)/gm

// schema { } — a schema block may carry a Directives[Const] list between the keyword and the
// brace (e.g. `schema @auth { ... }`), which the plain `\s*` gap can't absorb; `[^{\n]*` covers
// that without crossing a line boundary, and `\b` keeps `schemaVersion: 1` from false-matching.
const SCHEMA_RE = /^[ \t]*schema\b[^{\n]*\{/gm

const KIND_MAP: ReadonlyMap<string, string> = new Map([
  ['type', 'graphql_type'],
  ['interface', 'graphql_interface'],
  ['input', 'graphql_input'],
  ['enum', 'graphql_enum'],
  ['union', 'graphql_union'],
  ['scalar', 'graphql_scalar'],
])

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

/**
 * Blank GraphQL SDL description strings - both `"""..."""` block descriptions (which can span
 * multiple lines, carrying `stripMultilineStringSpan` state across calls the same way
 * C#/Kotlin/PHP/PowerShell do for their own multi-line string forms) and single-line `"..."`
 * descriptions - before the declaration regexes run. A description's content is arbitrary prose,
 * and a content line that happens to read like a declaration (e.g. `type Foo represents a user`
 * inside a `"""..."""` block) would otherwise be matched by `TYPE_RE`/`OPERATION_RE`/`FRAGMENT_RE`
 * as a real, phantom symbol since those patterns are only anchored to line start, not aware of
 * being inside a description. GraphQL's `"""..."""` uses the same triple-double-quote delimiter
 * as Kotlin's raw strings, so the `'kotlin'` `MultilineStringLang` is reused rather than adding a
 * new one.
 *
 * Also resolves precedence against `#` line comments on lines where no description is
 * currently open: a real `#` comment can textually contain a `"""`-looking sequence (e.g. `#
 * see """ for details`), which must not be misread as a real description opener. On such a
 * line, `findUnquotedHash` locates the earliest real `#`; if it comes before any `"""` on the
 * line, only the portion of the line before the `#` is scanned for a description opener, and the
 * `#`-onward remainder is left untouched here for the later `stripHashComments` pass to strip as
 * an ordinary comment.
 */
function stripGraphqlDescriptions(text: string): string {
  let state: MultilineStringState | null = null
  const outLines: string[] = []
  for (const line of text.split('\n')) {
    if (state === null) {
      const hashPos = findUnquotedHash(line)
      const tripleOpenerPos = line.indexOf('"""')
      if (hashPos !== -1 && (tripleOpenerPos === -1 || hashPos < tripleOpenerPos)) {
        const head = line.slice(0, hashPos)
        const { code, state: nextState } = stripMultilineStringSpan(head, null, 'kotlin')
        state = nextState
        outLines.push(stripStringLiterals(code) + line.slice(hashPos))
        continue
      }
    }
    const { code, state: nextState } = stripMultilineStringSpan(line, state, 'kotlin')
    state = nextState
    // Also blank single-line double-quoted descriptions that aren't part of a triple-quoted span.
    outLines.push(stripStringLiterals(code))
  }
  return outLines.join('\n')
}

/**
 * Index of the `{` that opens a declaration's body, searching `text` from `from` up to (but not
 * including) `until`, or -1 when the declaration has no body inside that window. A GraphQL
 * declaration header can carry an `implements A & B` list and a directive list before its brace,
 * and a directive argument may itself hold an object value (`@cache(policy: {ttl: 5})`) or a list
 * (`@x(vals: [{a: 1}])`), so a `{` nested inside `(...)`/`[...]` is skipped: matching that one
 * would end the symbol at the argument's closing brace instead of the body's. `text` is the
 * already stripped form (comments removed, every string literal blanked), so no quote handling is
 * needed here.
 */
function findDeclarationBraceIndex(text: string, from: number, until: number): number {
  let nesting = 0
  const limit = Math.min(until, text.length)
  for (let i = Math.max(from, 0); i < limit; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') nesting++
    else if (ch === ')' || ch === ']') { if (nesting > 0) nesting-- }
    else if (ch === '{' && nesting === 0) return i
  }
  return -1
}

export function extractGraphql(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const imports: AdapterImport[] = []
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const contentLineIndex = buildLineIndex(content)

  // Mask """..."""/"..." descriptions BEFORE extracting imports or stripping `#` comments.
  // GRAPHQL_IMPORT_RE matches any line that merely starts with `# import ... "..."`, with no
  // way to tell a real import pragma apart from prose inside a """..."""` description that
  // happens to describe or quote the import syntax (e.g. doc text reading `# import Foo from
  // "bar.graphql"` as an example). Running descriptionsStripped first blanks that prose to
  // spaces before the import regex ever sees it, while leaving genuine `#import` comment lines
  // outside any description untouched -- the same reasoning stripGraphqlDescriptions already
  // documents for why declaration extraction runs against blanked descriptions instead of raw
  // content. Reused below instead of calling stripGraphqlDescriptions a second time.
  const descriptionsStripped = stripGraphqlDescriptions(content)

  // Extract imports BEFORE stripping comments — #import pragmas live in comment lines
  for (const m of descriptionsStripped.matchAll(GRAPHQL_IMPORT_RE)) {
    const target = m[1]?.trim() ?? ''
    if (target) {
      const line = offsetToLine(contentLineIndex, m.index ?? 0)
      imports.push({ kind: 'import', target, line })
    }
  }

  // Mask "\"\"\"...\"\"\""/"..." descriptions BEFORE stripping `#` comments, not after.
  // stripHashComments's own quote-awareness (common.ts's isInsideStringLiteral) only tracks
  // quote parity within a single line, so a `#` inside a still-open """..."""` block description
  // - one whose opening """` is on an earlier line - looks "not inside a string" on the
  // description's own content lines and gets treated as a real comment marker. If that happens
  // to blank out the description's closing """` too (e.g. a `#` earlier on the same line as the
  // closer), stripGraphqlDescriptions never finds a matching closer for the rest of the file,
  // and its carried-over "still open" state masks every real declaration after it as description
  // content, silently dropping all of them. Running stripGraphqlDescriptions first means the
  // whole description span - `#` characters included - is already blanked to spaces before
  // stripHashComments ever sees it, so there is no comment marker left inside it to misread.
  const stripped = stripHashComments(descriptionsStripped)
  const totalLines = countContentLines(content)
  const lineIndex = buildLineIndex(stripped)

  // name+lineStart -> offset just past the declaration header, so the post-pass below can locate the `{` that opens the declaration's body and end the symbol at its matching `}` instead of at the next declaration. assignFlatEndLines alone stretches every symbol to the line before the next one, which swallows the blank lines, `#` comments and (most misleadingly) the `"""..."""` description belonging to the NEXT declaration into this one's body -- the same over-reach proto_idx.ts and terraform_idx.ts already correct with findMatchingBraceEndLine.
  const braceScanStarts = new Map<string, number>()

  // type / interface / input / enum / union / scalar (+ extend variants)
  for (const m of stripped.matchAll(TYPE_RE)) {
    const keyword = m.groups?.['keyword'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    const isExtend = Boolean(m[1])
    if (name) {
      const kind = isExtend ? 'graphql_extend' : (KIND_MAP.get(keyword) ?? 'graphql_type')
      const line = offsetToLine(lineIndex, m.index ?? 0)
      braceScanStarts.set(`${name}\0${line}`, (m.index ?? 0) + m[0].length)
      emit(name, kind, line)
    }
  }

  // directive @name
  for (const m of stripped.matchAll(DIRECTIVE_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      emit(`@${name}`, 'graphql_directive', line)
    }
  }

  // fragment
  for (const m of stripped.matchAll(FRAGMENT_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      braceScanStarts.set(`${name}\0${line}`, (m.index ?? 0) + m[0].length)
      emit(name, 'graphql_fragment', line)
    }
  }

  // query / mutation / subscription
  for (const m of stripped.matchAll(OPERATION_RE)) {
    const op = m.groups?.['op'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      braceScanStarts.set(`${name}\0${line}`, (m.index ?? 0) + m[0].length)
      emit(name, `graphql_${op}`, line)
    }
  }

  // schema { }
  for (const m of stripped.matchAll(SCHEMA_RE)) {
    const line = offsetToLine(lineIndex, m.index ?? 0)
    // SCHEMA_RE already consumes the opening brace, so start the scan on it rather than past it.
    braceScanStarts.set(`schema\0${line}`, (m.index ?? 0) + m[0].length - 1)
    emit('schema', 'graphql_schema', line)
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  const finalSymbols = propagateEndLinesToSymbols(symbols, sections).map((sym) => {
    const scanFrom = braceScanStarts.get(`${sym.name}\0${sym.lineStart}`)
    if (scanFrom === undefined) return sym
    // Bounded by the flat end line the pass above assigned: a brace-less declaration (`scalar
    // DateTime`, `union A = B | C`, a bodyless `type Foo`) must not reach forward and adopt the
    // NEXT declaration's block, so the correction can only ever shrink a span, never grow one.
    const windowEnd = lineIndex[sym.lineEnd] ?? stripped.length
    const braceIndex = findDeclarationBraceIndex(stripped, scanFrom, windowEnd)
    if (braceIndex === -1) return sym
    const braceEndLine = findMatchingBraceEndLine(stripped, braceIndex, totalLines, lineIndex)
    if (braceEndLine < sym.lineStart || braceEndLine >= sym.lineEnd) return sym
    return { ...sym, lineEnd: braceEndLine }
  })

  return { symbols: finalSymbols, imports }
}
