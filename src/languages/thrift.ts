/**
 * Apache Thrift IDL symbol extractor: structs, unions, exceptions, enums and services, the functions inside each service, typedefs,
 * and constants. Imports are `include "file.thrift"` targets.
 */

import { cFunctionHeader, quotedTarget, scanBraceLanguage, trailingIdentifier, trimEndChars, type BraceAdapterResult, type BraceLanguage, type Decl, type DeclContext } from './brace_engine.js'

const DEFINITION_RE = /^(struct|union|exception|service|enum|senum)\s+([A-Za-z_][\w.]*)/

function matchThrift(code: string, ctx: DeclContext): Decl | null {
  if (ctx.scope === 'top') {
    const d = DEFINITION_RE.exec(code)
    if (d !== null) return { name: d[2]!, kind: d[1]!, container: true, end: 'brace' }
    if (/^typedef\s/.test(code)) {
      const name = trailingIdentifier(trimEndChars(code, ';, \t'))?.name
      return name === undefined ? null : { name, kind: 'typedef', end: 'line' }
    }
    if (/^const\s/.test(code) && code.includes('=')) {
      const name = trailingIdentifier(code.slice(0, code.indexOf('=')).trimEnd())?.name
      return name === undefined ? null : { name, kind: 'const', end: 'line' }
    }
    return null
  }
  if (ctx.scope === 'container' && ctx.parentKind === 'service') {
    const fn = cFunctionHeader(code)
    if (fn !== null && fn.qualifier === '') return { name: fn.name, kind: 'method', end: 'line' }
  }
  return null
}

const THRIFT: BraceLanguage = {
  lex: { lineComments: ['//', '#'], blockComment: ['/*', '*/'], quotes: '"\'' },
  match: matchThrift,
  importOf: (code, raw) => (/^include\s/.test(code) ? quotedTarget(raw) : null),
  docComments: true,
}

export function extractThrift(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, THRIFT)
}
