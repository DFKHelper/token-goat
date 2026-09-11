/**
 * Objective-C and Objective-C++ symbol extractor. `@interface`, `@implementation` and `@protocol` blocks run to their `@end`;
 * methods are named by their full selector (`tableView:didSelectRowAtIndexPath:`) and bound to their brace body; properties,
 * C functions, structs, enums (`NS_ENUM` too), and C++ classes and namespaces in `.mm` files are found as well.
 */

import { cFunctionHeader, quotedTarget, scanBraceLanguage, trailingIdentifier, withoutTrailingBrace, type BraceAdapterResult, type BraceLanguage, type Decl, type DeclContext } from './brace_engine.js'

// The Objective-C sniffs live in sniff.ts so language detection on the hook path does not load this adapter.
export { isObjcHeader, isObjcSource } from './sniff.js'

// Matchers see trimmed code, and a trailing `{` is removed before TYPEDEF_TAG_RE and TYPE_RE run, so none needs a trailing `\s*$`.
const CONTAINER_RE = /^@(interface|implementation|protocol)\s+([A-Za-z_]\w*)[ \t]*(\([ \t]*(?:([A-Za-z_]\w*)[ \t]*)?\))?/
const NS_ENUM_RE = /^(?:typedef\s+)?NS_(?:ENUM|OPTIONS|CLOSED_ENUM|ERROR_ENUM)\s*\([^,()]*,\s*([A-Za-z_]\w*)\s*\)/
const TYPEDEF_TAG_RE = /^typedef\s+(struct|enum|union)(?:\s+([A-Za-z_]\w*))?$/
const TYPE_RE = /^(struct|union|enum|class|namespace)\s+(?:class\s+)?([A-Za-z_]\w*)(?:\s*:[^;{]*)?$/

function skipParens(s: string, i: number): number {
  if (s[i] !== '(') return i
  let d = 0
  for (; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')' && --d === 0) return i + 1
  }
  return i
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++
  return i
}

function readIdent(s: string, i: number): string {
  let j = i
  while (j < s.length && /\w/.test(s[j]!)) j++
  return /^[A-Za-z_]/.test(s.slice(i, j)) ? s.slice(i, j) : ''
}

/** The selector of a method header such as `- (void)move:(int)x to:(int)y {`: `move:to:`, or `viewDidLoad` for a unary one. */
export function selectorOf(header: string): string {
  let i = skipSpace(header, 1)
  i = skipSpace(header, skipParens(header, i))
  const parts: string[] = []
  for (;;) {
    const word = readIdent(header, i)
    const afterWord = skipSpace(header, i + word.length)
    if (header[afterWord] === ':') {
      parts.push(`${word}:`)
      i = skipSpace(header, skipParens(header, skipSpace(header, afterWord + 1)))
      i = skipSpace(header, i + readIdent(header, i).length)
      continue
    }
    if (parts.length === 0) return word
    return parts.join('')
  }
}

function propertyName(code: string): string {
  const body = code.slice('@property'.length)
  const afterAttrs = skipParens(body, skipSpace(body, 0))
  const text = body.slice(afterAttrs, body.includes(';') ? body.indexOf(';') : body.length)
  const block = /\(\s*\^\s*([A-Za-z_]\w*)\s*\)/.exec(text)
  if (block !== null) return block[1]!
  // Drop macro arguments (`API_AVAILABLE(ios(13))`), then trailing all-caps macros, and keep the last word.
  const words = text.replace(/\([^()]*\)/g, ' ').split(/[\s*]+/).filter((w) => w !== '')
  while (words.length > 2 && /^[A-Z][A-Z0-9_]+$/.test(words[words.length - 1]!)) words.pop()
  return trailingIdentifier(words[words.length - 1] ?? '')?.name ?? ''
}

function matchObjc(code: string, ctx: DeclContext): Decl | null {
  if (code.startsWith('@property')) {
    if (ctx.scope !== 'container') return null
    const name = propertyName(code)
    return name === '' ? null : { name, kind: 'property', end: 'line' }
  }
  if (code.startsWith('@')) {
    if (ctx.scope !== 'top') return null
    const m = CONTAINER_RE.exec(code)
    if (m === null) return null
    // `@protocol A, B;` is a forward declaration.
    if (m[1] === 'protocol' && /^[\s\w,]*;/.test(code.slice('@protocol'.length))) return null
    const kind = m[3] === undefined ? m[1]! : m[4] === undefined ? 'extension' : 'category'
    return { name: m[2]!, kind, container: true, end: 'keyword' }
  }
  if (code.startsWith('-') || code.startsWith('+')) {
    if (ctx.scope !== 'container' || !/^[-+]\s*\(/.test(code)) return null
    const name = selectorOf(ctx.header())
    return name === '' ? null : { name, kind: 'method', end: 'brace' }
  }
  if (ctx.scope === 'function' || ctx.scope === 'block') return null
  const ns = NS_ENUM_RE.exec(code)
  if (ns !== null) return { name: ns[1]!, kind: 'enum', end: 'brace' }
  const head = withoutTrailingBrace(code)
  const td = TYPEDEF_TAG_RE.exec(head)
  if (td !== null) return { name: td[2] ?? '', kind: td[1]!, end: 'brace', nameAfterClose: td[2] === undefined }
  const t = TYPE_RE.exec(head)
  if (t !== null) return { name: t[2]!, kind: t[1]!, container: t[1] === 'class' || t[1] === 'struct' || t[1] === 'namespace', end: 'brace' }
  const fn = cFunctionHeader(code)
  if (fn !== null) return { name: fn.name, kind: 'function', end: 'brace', dropPrototype: true, ...(fn.qualifier === '' ? {} : { parent: fn.qualifier }) }
  return null
}

function importOf(code: string, raw: string): string | null {
  if (/^#\s*(?:import|include)\b/.test(code)) return quotedTarget(raw)
  return /^@import\s+([\w.]+)/.exec(code)?.[1] ?? null
}

const OBJC: BraceLanguage = {
  lex: { lineComments: ['//'], blockComment: ['/*', '*/'], quotes: '"\'' },
  match: matchObjc,
  keywordClose: /^@end\b/,
  preprocessor: true,
  importOf,
  docComments: true,
}

export function extractObjc(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, OBJC)
}
