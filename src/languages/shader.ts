/**
 * Shader symbol extractors. GLSL, HLSL and Metal share C's function syntax: functions (entry points such as `kernel`, `vertex` and
 * `fragment` functions too), structs, GLSL interface blocks, HLSL `cbuffer`/`tbuffer` blocks, and Metal namespaces, plus `#include`
 * targets. WGSL has its own: functions, structs, aliases, and module-scope `const`, `override` and `var` declarations.
 */

import { cFunctionHeader, quotedTarget, scanBraceLanguage, stripLeadingWords, withoutTrailingBrace, type BraceAdapterResult, type BraceLanguage, type Decl, type DeclContext } from './brace_engine.js'

// Run on trimmed code with a trailing `{` removed, so it needs no trailing `\s*$`.
const TYPE_RE = /^(struct|class|namespace|enum)\s+(?:class\s+)?([A-Za-z_]\w*)(?:\s*:[^;{]*)?$/
const CBUFFER_RE = /^(cbuffer|tbuffer)\s+([A-Za-z_]\w*)/
const GLSL_BLOCK_QUALIFIERS: ReadonlySet<string> = new Set(['uniform', 'buffer', 'in', 'out', 'shared', 'readonly', 'writeonly', 'coherent', 'restrict', 'volatile'])

/** A GLSL interface block header (`layout(std140) uniform Matrices {`): its block name, or `''`. */
function glslBlockName(code: string): string {
  let s = code
  if (s.startsWith('layout')) {
    const close = s.indexOf(')')
    if (close < 0) return ''
    s = s.slice(close + 1)
  }
  const words = s.trim().replace(/\{\s*$/, '').trim().split(/\s+/)
  let i = 0
  while (i < words.length && GLSL_BLOCK_QUALIFIERS.has(words[i]!)) i++
  return i > 0 && i === words.length - 1 && /^[A-Za-z_]\w*$/.test(words[i]!) ? words[i]! : ''
}

function matchCShader(code: string, ctx: DeclContext): Decl | null {
  if (ctx.scope !== 'top' && ctx.scope !== 'container') return null
  const t = TYPE_RE.exec(withoutTrailingBrace(code))
  if (t !== null) return { name: t[2]!, kind: t[1]!, container: t[1] !== 'enum', end: 'brace' }
  const cb = CBUFFER_RE.exec(code)
  if (cb !== null) return { name: cb[2]!, kind: cb[1]!, container: true, end: 'brace' }
  if (ctx.scope === 'top') {
    const block = glslBlockName(code)
    if (block !== '') return { name: block, kind: 'block', container: true, end: 'brace' }
  }
  const fn = cFunctionHeader(code)
  if (fn !== null) return { name: fn.name, kind: 'function', end: 'brace', dropPrototype: true, ...(fn.qualifier === '' ? {} : { parent: fn.qualifier }) }
  return null
}

const C_SHADER: BraceLanguage = {
  lex: { lineComments: ['//'], blockComment: ['/*', '*/'], quotes: '"\'' },
  match: matchCShader,
  preprocessor: true,
  importOf: (code, raw) => (/^#\s*include\b/.test(code) ? quotedTarget(raw) : null),
  docComments: true,
}

const WGSL_DECL_RE = /^(fn|struct|alias|const|override)\s+([A-Za-z_]\w*)/
const WGSL_VAR_RE = /^var(?:\s*<[^<>]*>)?\s+([A-Za-z_]\w*)/

function matchWgsl(code: string, ctx: DeclContext): Decl | null {
  if (ctx.scope !== 'top') return null
  const s = stripLeadingWords(code, new Set(), true)
  const d = WGSL_DECL_RE.exec(s)
  if (d !== null) {
    const kind = d[1] === 'fn' ? 'function' : d[1]!
    return { name: d[2]!, kind, end: d[1] === 'fn' || d[1] === 'struct' ? 'brace' : 'line' }
  }
  const v = WGSL_VAR_RE.exec(s)
  return v === null ? null : { name: v[1]!, kind: 'var', end: 'line' }
}

const WGSL: BraceLanguage = {
  lex: { lineComments: ['//'], blockComment: ['/*', '*/'], nestedBlockComments: true, quotes: '' },
  match: matchWgsl,
  docComments: true,
}

/** GLSL, HLSL and Metal. */
export function extractCShader(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, C_SHADER)
}

export function extractWgsl(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, WGSL)
}
