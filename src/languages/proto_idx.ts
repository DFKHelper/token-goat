/**
 * Protocol Buffers (.proto) extractor.
 *
 * Extracts messages, enums, services, RPCs, oneofs, and extend blocks.
 * `import "other.proto"` directives are returned as import entries.
 * Pure-regex; no tree-sitter.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection, AdapterImport } from './common.js'
import {
  assignFlatEndLines,
  buildLineIndex,
  findMatchingBraceEndLine,
  makeSymbolEmitter,
  offsetToLine,
  propagateEndLinesToSymbols,
  stripCstyleComments,
  stripLineComment,
  countContentLines,
} from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

function stripComments(text: string): string {
  const out = stripCstyleComments(text)
  // Quote-aware per-line scan (via stripLineComment) instead of a plain regex replace, so a
  // "//" inside a string literal (e.g. a URL) is never treated as a real comment start -- a
  // naive regex replace here would blank the rest of the line, including the string's
  // closing quote, desyncing quote-tracking for everything after.
  return out
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n')
}

// Top-level: message Name {, enum Name {, service Name {
// Leading [ \t]* tolerates indentation so a nested message/enum (e.g. a request/response
// wrapper declared inside another message) is matched too, not just column-0 declarations.
const TOP_LEVEL_RE =
  /^[ \t]*(?<keyword>message|enum|service)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\{/gm

// extend QualifiedName { } — target may be dotted (google.protobuf.X). Same indentation
// tolerance as TOP_LEVEL_RE: extend blocks may be nested inside a message.
const EXTEND_RE = /^[ \t]*extend\s+(?<name>[A-Za-z_][A-Za-z0-9_.]*)\s*\{/gm

// rpc MethodName(...) inside a service block. Leading [ \t]* (not +) so an unindented
// (column-0) rpc line inside a column-0 service block is still matched.
const RPC_RE = /^[ \t]*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

// oneof name { } inside a message. Same indentation tolerance as RPC_RE.
const ONEOF_RE = /^[ \t]*oneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm

// import "path.proto" — both weak/public modifiers accepted
const IMPORT_RE = /^import\s+(?:weak\s+|public\s+)?["']([^"']+)["']/gm

const KIND_MAP: ReadonlyMap<string, string> = new Map([
  ['message', 'proto_message'],
  ['enum', 'proto_enum'],
  ['service', 'proto_service'],
])

// message/enum/service/extend/oneof blocks can nest arbitrarily (a message can contain
// another message or enum). The shared assignFlatEndLines/propagateEndLinesToSymbols
// helpers only do flat "ends where the next section starts" propagation, which is wrong
// once nesting is possible: an outer block's end gets truncated to right before its first
// nested child, and an innermost/last-in-file nested block over-extends to EOF instead of
// stopping at its own closing brace. For these block kinds we know the exact offset of the
// opening `{` (each regex ends with `\{`), so find the true matching closing brace instead --
// see findMatchingBraceEndLine in common.ts.

// An rpc statement's real terminator is either a bare `;` (the common case) or a trailing
// method-options block (`rpc Foo(A) returns (B) { option ...; }`). Scans forward from the
// start of the rpc match -- so the request/response type parens the regex already consumed
// are counted too -- tracking paren depth (so a `;` or `{` inside the parameter list's types
// is never mistaken for the statement's own terminator) and quoted strings, same approach as
// findMatchingBraceEndLine in common.ts.
function findRpcEndLine(
  content: string,
  matchStartIndex: number,
  totalLines: number,
  lineIndex: readonly number[],
): number {
  let parenDepth = 0
  let quote: string | null = null
  for (let i = matchStartIndex; i < content.length; i++) {
    const ch = content[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(') { parenDepth++; continue }
    if (ch === ')') { parenDepth--; continue }
    if (parenDepth > 0) continue
    if (ch === ';') return offsetToLine(lineIndex, i)
    if (ch === '{') return findMatchingBraceEndLine(content, i, totalLines, lineIndex)
  }
  return totalLines
}

export function extractProto(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const imports: AdapterImport[] = []
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const stripped = stripComments(content)
  const totalLines = countContentLines(content)
  const lineIndex = buildLineIndex(stripped)

  // name+lineStart -> true end line for block kinds whose opening `{` offset is known, so
  // nested message/enum/extend/oneof blocks get a correct end line regardless of the flat
  // section propagation below (see findMatchingBraceEndLine in common.ts).
  const blockEndLines = new Map<string, number>()

  // Imports
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const target = m[1]?.trim() ?? ''
    if (target) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      imports.push({ kind: 'import', target, line })
    }
  }

  // Top-level: message / enum / service
  for (const m of stripped.matchAll(TOP_LEVEL_RE)) {
    const keyword = m.groups?.['keyword'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const kind = KIND_MAP.get(keyword) ?? 'proto_message'
      const line = offsetToLine(lineIndex, m.index ?? 0)
      const openBraceIndex = (m.index ?? 0) + m[0].length - 1
      blockEndLines.set(`${name}\0${line}`, findMatchingBraceEndLine(stripped, openBraceIndex, totalLines, lineIndex))
      emit(name, kind, line)
    }
  }

  // extend
  for (const m of stripped.matchAll(EXTEND_RE)) {
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      const openBraceIndex = (m.index ?? 0) + m[0].length - 1
      blockEndLines.set(`${name}\0${line}`, findMatchingBraceEndLine(stripped, openBraceIndex, totalLines, lineIndex))
      emit(name, 'proto_extend', line)
    }
  }

  // rpc
  for (const m of stripped.matchAll(RPC_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      blockEndLines.set(`${name}\0${line}`, findRpcEndLine(stripped, m.index ?? 0, totalLines, lineIndex))
      emit(name, 'proto_rpc', line)
    }
  }

  // oneof
  for (const m of stripped.matchAll(ONEOF_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      const openBraceIndex = (m.index ?? 0) + m[0].length - 1
      blockEndLines.set(`${name}\0${line}`, findMatchingBraceEndLine(stripped, openBraceIndex, totalLines, lineIndex))
      emit(name, 'proto_oneof', line)
    }
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  const finalSymbols = propagateEndLinesToSymbols(symbols, sections).map((sym) => {
    const braceEndLine = blockEndLines.get(`${sym.name}\0${sym.lineStart}`)
    return braceEndLine !== undefined && braceEndLine !== sym.lineEnd
      ? { ...sym, lineEnd: braceEndLine }
      : sym
  })

  return { symbols: finalSymbols, imports }
}
