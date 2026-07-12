/**
 * GraphQL schema / document extractor.
 *
 * Extracts types, queries, mutations, subscriptions, fragments, directives,
 * enums, interfaces, inputs, unions, scalars, and schema blocks.
 * Each symbol also becomes a section for surgical `token-goat section` reads.
 * Pure-regex; no tree-sitter dependency.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection, MultilineStringState } from './common.js'
import {
  assignFlatEndLines,
  buildLineIndex,
  makeSymbolEmitter,
  offsetToLine,
  propagateEndLinesToSymbols,
  stripHashComments,
  stripMultilineStringSpan,
  stripStringLiterals,
} from './common.js'

// ---------------------------------------------------------------------------
// Import pragma: # import FragmentName from "path.graphql"
// ---------------------------------------------------------------------------
const GRAPHQL_IMPORT_RE =
  /^[ \t]*#[ \t]*import\b(?:[^"'\n]*)?['"]([^'"]+)['"]/gm

// type / interface / input / enum / union / scalar (+ optional extend prefix)
const TYPE_RE =
  /^[ \t]*(extend\s+)?(?<keyword>type|interface|input|enum|union|scalar)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/gm

// directive @name
const DIRECTIVE_RE = /^[ \t]*directive\s+@([A-Za-z_][A-Za-z0-9_]*)/gm

// fragment FragmentName on …
const FRAGMENT_RE = /^[ \t]*fragment\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+/gm

// query/mutation/subscription Name
const OPERATION_RE =
  /^[ \t]*(?<op>query|mutation|subscription)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/gm

// schema { }
const SCHEMA_RE = /^[ \t]*schema\s*\{/gm

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
 */
function stripGraphqlDescriptions(text: string): string {
  let state: MultilineStringState | null = null
  const outLines: string[] = []
  for (const line of text.split('\n')) {
    const { code, state: nextState } = stripMultilineStringSpan(line, state, 'kotlin')
    state = nextState
    // Also blank single-line double-quoted descriptions that aren't part of a triple-quoted span.
    outLines.push(stripStringLiterals(code))
  }
  return outLines.join('\n')
}

export interface GraphqlImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

export function extractGraphql(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: GraphqlImport[] } {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const imports: GraphqlImport[] = []
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const contentLineIndex = buildLineIndex(content)

  // Extract imports BEFORE stripping comments — #import pragmas live in comment lines
  for (const m of content.matchAll(GRAPHQL_IMPORT_RE)) {
    const target = m[1]?.trim() ?? ''
    if (target) {
      const line = offsetToLine(contentLineIndex, m.index ?? 0)
      imports.push({ kind: 'import', target, line })
    }
  }

  const stripped = stripGraphqlDescriptions(stripHashComments(content))
  const totalLines = content.split('\n').length
  const lineIndex = buildLineIndex(stripped)

  // type / interface / input / enum / union / scalar (+ extend variants)
  for (const m of stripped.matchAll(TYPE_RE)) {
    const keyword = m.groups?.['keyword'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    const isExtend = Boolean(m[1])
    if (name) {
      const kind = isExtend ? 'graphql_extend' : (KIND_MAP.get(keyword) ?? 'graphql_type')
      const line = offsetToLine(lineIndex, m.index ?? 0)
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
      emit(name, 'graphql_fragment', line)
    }
  }

  // query / mutation / subscription
  for (const m of stripped.matchAll(OPERATION_RE)) {
    const op = m.groups?.['op'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      emit(name, `graphql_${op}`, line)
    }
  }

  // schema { }
  for (const m of stripped.matchAll(SCHEMA_RE)) {
    const line = offsetToLine(lineIndex, m.index ?? 0)
    emit('schema', 'graphql_schema', line)
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  const finalSymbols = propagateEndLinesToSymbols(symbols, sections)

  return { symbols: finalSymbols, imports }
}
