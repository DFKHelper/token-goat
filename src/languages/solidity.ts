/**
 * Solidity symbol extractor: contracts, interfaces and libraries with their functions, constructors, fallback and receive functions,
 * modifiers, structs, enums, events and errors, plus file-level functions, structs, enums, errors and user-defined value types.
 * Imports are the quoted path of each `import` form.
 */

import { quotedTarget, scanBraceLanguage, type BraceAdapterResult, type BraceLanguage, type Decl, type DeclContext } from './brace_engine.js'

const CONTRACT_RE = /^(?:abstract\s+)?(contract|interface|library)\s+([A-Za-z_$][\w$]*)/
const FUNCTION_RE = /^function\s+([A-Za-z_$][\w$]*)/
const SPECIAL_FUNCTION_RE = /^(constructor|fallback|receive)\s*\(/
const MODIFIER_RE = /^modifier\s+([A-Za-z_$][\w$]*)/
const TYPE_RE = /^(struct|enum)\s+([A-Za-z_$][\w$]*)/
const LINE_RE = /^(event|error)\s+([A-Za-z_$][\w$]*)/
const VALUE_TYPE_RE = /^type\s+([A-Za-z_$][\w$]*)\s+is\b/

function matchSolidity(code: string, ctx: DeclContext): Decl | null {
  if (ctx.scope === 'top') {
    const c = CONTRACT_RE.exec(code)
    if (c !== null) return { name: c[2]!, kind: c[1]!, container: true, end: 'brace' }
  }
  if (ctx.scope !== 'top' && ctx.scope !== 'container') return null
  const f = FUNCTION_RE.exec(code)
  if (f !== null) return { name: f[1]!, kind: 'function', end: 'brace' }
  const sp = SPECIAL_FUNCTION_RE.exec(code)
  if (sp !== null) return { name: sp[1]!, kind: sp[1] === 'constructor' ? 'constructor' : 'function', end: 'brace' }
  const m = MODIFIER_RE.exec(code)
  if (m !== null) return { name: m[1]!, kind: 'modifier', end: 'brace' }
  const t = TYPE_RE.exec(code)
  if (t !== null) return { name: t[2]!, kind: t[1]!, end: 'brace' }
  const l = LINE_RE.exec(code)
  if (l !== null) return { name: l[2]!, kind: l[1]!, end: 'line' }
  const v = VALUE_TYPE_RE.exec(code)
  if (v !== null) return { name: v[1]!, kind: 'type', end: 'line' }
  return null
}

const SOLIDITY: BraceLanguage = {
  lex: { lineComments: ['//'], blockComment: ['/*', '*/'], quotes: '"\'' },
  match: matchSolidity,
  importOf: (code, raw) => (/^import\b/.test(code) ? quotedTarget(raw) : null),
  docComments: true,
}

export function extractSolidity(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, SOLIDITY)
}
