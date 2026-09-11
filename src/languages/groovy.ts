/**
 * Groovy symbol extractor, also used for Gradle build scripts and Jenkinsfiles. Finds classes, interfaces, traits, enums, records and
 * annotation types with their methods and constructors, script-level methods (Spock's `def "a feature"()` too), Gradle tasks, and
 * Jenkins pipeline stages, nested stages taking the enclosing stage as their parent.
 */

import { cFunctionHeader, rawQuoted, scanBraceLanguage, stripLeadingWords, type BraceAdapterResult, type BraceLanguage, type Decl, type DeclContext } from './brace_engine.js'

const MODIFIERS: ReadonlySet<string> = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'sealed', 'non-sealed', 'strictfp', 'synchronized', 'transient',
  'volatile', 'native', 'default',
])
const PRIMITIVES: ReadonlySet<string> = new Set(['void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'def', 'var'])
const TYPE_DECL_RE = /^(class|interface|trait|enum|record|@interface)\s+([A-Za-z_]\w*)/
// Containers whose same-named member is a constructor; a stage is a container too, but has none.
const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'enum', 'record'])

/** A return type Groovy code writes before a method name: `def`, a primitive, or a type whose last dotted segment is capitalized. A lowercase word (`println foo(x)`) is a command call. */
function isReturnType(typeText: string): boolean {
  const first = typeText.split(/[\s<[]/, 1)[0]!
  if (PRIMITIVES.has(first)) return true
  const last = first.split('.').pop() ?? ''
  return /^[A-Z]/.test(last)
}

function matchGroovy(code: string, ctx: DeclContext): Decl | null {
  const s = stripLeadingWords(code, MODIFIERS, true)
  const at = code.length - s.length
  if (ctx.scope === 'top' || ctx.scope === 'container') {
    const t = TYPE_DECL_RE.exec(s)
    if (t !== null) return { name: t[2]!, kind: t[1] === '@interface' ? 'annotation' : t[1]!, container: true, end: 'brace' }
    const member = ctx.scope === 'container' ? 'method' : 'function'
    const spock = /^def\s+(?=["'])/.exec(s)
    if (spock !== null) {
      const name = rawQuoted(ctx, at + spock[0].length)
      return name === '' ? null : { name, kind: member, end: 'brace' }
    }
    if (ctx.scope === 'container' && TYPE_KINDS.has(ctx.parentKind) && s.startsWith(ctx.parent) && /^\s*\(/.test(s.slice(ctx.parent.length))) {
      return { name: ctx.parent, kind: 'constructor', end: 'brace' }
    }
    const fn = cFunctionHeader(s)
    if (fn !== null && fn.qualifier === '' && isReturnType(fn.typeText)) return { name: fn.name, kind: member, end: 'brace' }
  }
  if (ctx.insideFunction) return null
  const stage = /^stage\s*\(\s*(?=["'])/.exec(s)
  if (stage !== null) {
    const name = rawQuoted(ctx, at + stage[0].length)
    return name === '' ? null : { name, kind: 'stage', container: true, end: 'brace' }
  }
  const task = /^task\s+([A-Za-z_]\w*)/.exec(s)
  if (task !== null) return { name: task[1]!, kind: 'task', end: 'brace' }
  const reg = /^tasks\s*\.\s*(?:register|create)\s*\(\s*(?=["'])/.exec(s)
  if (reg !== null) {
    const name = rawQuoted(ctx, at + reg[0].length)
    // `tasks.register('myCopy', Copy)` with no block must not claim the next statement's `{`.
    return name === '' ? null : { name, kind: 'task', end: s.includes('{') ? 'brace' : 'line' }
  }
  return null
}

const GROOVY: BraceLanguage = {
  lex: { lineComments: ['//'], blockComment: ['/*', '*/'], quotes: '"\'', tripleQuotes: true, shebang: true },
  match: matchGroovy,
  importOf: (code) => /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/.exec(code)?.[1] ?? null,
  docComments: true,
}

export function extractGroovy(content: string, filePath: string): BraceAdapterResult {
  return scanBraceLanguage(content, filePath, GROOVY)
}
