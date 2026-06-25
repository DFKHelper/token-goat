/**
 * Protocol Buffers (.proto) extractor.
 *
 * Extracts messages, enums, services, RPCs, oneofs, and extend blocks.
 * `import "other.proto"` directives are returned as import entries.
 * Pure-regex; no tree-sitter.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import {
  assignFlatEndLines,
  makeSymbolEmitter,
  propagateEndLinesToSymbols,
  stripCstyleComments,
} from './common.js'

const MAX_SYMBOLS = 500
const MAX_HEADING_LEN = 120

export interface ProtoImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

// Strip // line comments
const LINE_COMMENT_RE = /\/\/[^\n]*/g

function stripComments(text: string): string {
  let out = stripCstyleComments(text)
  out = out.replace(LINE_COMMENT_RE, (m) => ' '.repeat(m.length))
  return out
}

// Top-level: message Name {, enum Name {, service Name {
const TOP_LEVEL_RE =
  /^(?<keyword>message|enum|service)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\{/gm

// extend QualifiedName { } — target may be dotted (google.protobuf.X)
const EXTEND_RE = /^extend\s+(?<name>[A-Za-z_][A-Za-z0-9_.]*)\s*\{/gm

// rpc MethodName(...) inside a service block
const RPC_RE = /^\s+rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm

// oneof name { } inside a message
const ONEOF_RE = /^\s+oneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm

// import "path.proto" — both weak/public modifiers accepted
const IMPORT_RE = /^import\s+(?:weak\s+|public\s+)?["']([^"']+)["']/gm

const KIND_MAP: ReadonlyMap<string, string> = new Map([
  ['message', 'proto_message'],
  ['enum', 'proto_enum'],
  ['service', 'proto_service'],
])

export function extractProto(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: ProtoImport[] } {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const imports: ProtoImport[] = []
  const emit = makeSymbolEmitter(symbols, sections, seen, filePath, MAX_SYMBOLS, MAX_HEADING_LEN)

  const stripped = stripComments(content)
  const totalLines = content.split('\n').length

  // Imports
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const target = m[1]?.trim() ?? ''
    if (target) {
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      imports.push({ kind: 'import', target, line })
    }
  }

  // Top-level: message / enum / service
  for (const m of stripped.matchAll(TOP_LEVEL_RE)) {
    const keyword = m.groups?.['keyword'] ?? ''
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const kind = KIND_MAP.get(keyword) ?? 'proto_message'
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      emit(name, kind, line)
    }
  }

  // extend
  for (const m of stripped.matchAll(EXTEND_RE)) {
    const name = m.groups?.['name']?.trim() ?? ''
    if (name) {
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      emit(name, 'proto_extend', line)
    }
  }

  // rpc
  for (const m of stripped.matchAll(RPC_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      emit(name, 'proto_rpc', line)
    }
  }

  // oneof
  for (const m of stripped.matchAll(ONEOF_RE)) {
    const name = m[1]?.trim() ?? ''
    if (name) {
      const line = stripped.slice(0, m.index ?? 0).split('\n').length
      emit(name, 'proto_oneof', line)
    }
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)
  const finalSymbols = propagateEndLinesToSymbols(symbols, sections)

  return { symbols: finalSymbols, imports }
}
