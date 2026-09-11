/**
 * Shared scanner for the brace-language adapters (Objective-C, Groovy, Solidity, Thrift, GLSL, HLSL, WGSL, Metal). Comments and
 * string contents are blanked first, so a brace, quote or keyword inside either is never read as code. One pass then tracks brace
 * depth, asks the language's matcher about each line, and binds a declaration to the `{` that opens its body, so its span ends at
 * the matching `}`. A `;` reached first makes it a one-line prototype.
 */

import { precedingDocComment } from '../doc_comment.js'
import type { SymbolEntry } from '../parser_types.js'
import type { AdapterImport } from './common.js'

/** How a language writes comments and strings, for {@link maskSource}. */
export interface BraceLexOpts {
  readonly lineComments: readonly string[]
  readonly blockComment: readonly [string, string] | null
  readonly nestedBlockComments?: boolean
  /** Single-line string delimiters, each backslash-escaped, e.g. `"'`. */
  readonly quotes: string
  /** `'''` and `"""` strings, which may span lines (Groovy). */
  readonly tripleQuotes?: boolean
  /** A `#!` first line is a comment (Groovy scripts). */
  readonly shebang?: boolean
}

/** Where a line sits: at file level, directly in a container's body, in a function body, or in an unnamed block. */
export type Scope = 'top' | 'container' | 'function' | 'block'

export interface DeclContext {
  readonly scope: Scope
  /** Some enclosing brace belongs to a function, however deep. */
  readonly insideFunction: boolean
  /** Name and kind of the nearest enclosing container, `''` at file level. */
  readonly parent: string
  readonly parentKind: string
  /** The raw line, and the offset in it where the trimmed code handed to the matcher starts. */
  readonly raw: string
  readonly codeOffset: number
  /** The blanked text from this line up to the first `{` or `;`, joined over at most a dozen lines. */
  header(): string
}

export interface Decl {
  readonly name: string
  readonly kind: string
  /** Members declared in this one's body take its name as their parent. */
  readonly container?: boolean
  /** `brace`: ends at the `}` matching the next `{`, or at a `;` reached first. `line`: this line only. `keyword`: at the language's closing keyword line (`@end`). */
  readonly end: 'brace' | 'line' | 'keyword'
  /** Overrides the enclosing container, for a qualified `Foo::bar` definition. */
  readonly parent?: string
  /** `typedef struct { ... } Name;`: the name is the identifier after the closing brace. */
  readonly nameAfterClose?: boolean
  /** A `;` before the body makes it a prototype, which is not emitted. */
  readonly dropPrototype?: boolean
}

export interface BraceLanguage {
  readonly lex: BraceLexOpts
  readonly match: (code: string, ctx: DeclContext) => Decl | null
  /** A trimmed line this matches closes the innermost `keyword` declaration. */
  readonly keywordClose?: RegExp
  /** Lines starting with `#` are preprocessor directives: never declarations, and their braces are not counted. */
  readonly preprocessor?: boolean
  /** Reads an import from a trimmed, blanked line; `raw` is the untouched line, for a quoted target the blanking emptied. */
  readonly importOf?: (code: string, raw: string) => string | null
  /** Doc comments above a declaration are recovered in C style. */
  readonly docComments?: boolean
}

export interface BraceAdapterResult {
  readonly symbols: SymbolEntry[]
  readonly imports: AdapterImport[]
}

const MAX_SYMBOLS = 10_000
const MAX_NAME_LENGTH = 200
// A declaration header waits this many lines for its `{` before it is kept as a one-line symbol.
const PENDING_MAX_LINES = 12
const HEADER_MAX_LINES = 12
const HEADER_MAX_CHARS = 2000

function blankText(s: string): string {
  return s.replace(/[^\r\n]/g, ' ')
}

/** Find the end of a nested block comment opened at `from`, or `content.length` when it never closes. */
function nestedCommentEnd(content: string, from: number, open: string, close: string): number {
  let depth = 0
  let i = from
  while (i < content.length) {
    if (content.startsWith(open, i)) {
      depth++
      i += open.length
    } else if (content.startsWith(close, i)) {
      depth--
      i += close.length
      if (depth === 0) return i
    } else {
      i++
    }
  }
  return content.length
}

/** `content` with every comment and every string's contents replaced by spaces; delimiters, newlines and offsets are kept. Linear. */
export function maskSource(content: string, opts: BraceLexOpts): string {
  const parts: string[] = []
  let keepFrom = 0
  const blank = (a: number, b: number): void => {
    parts.push(content.slice(keepFrom, a), blankText(content.slice(a, b)))
    keepFrom = b
  }
  const n = content.length
  let i = 0
  if (opts.shebang === true && content.startsWith('#!')) {
    const e = content.indexOf('\n')
    i = e < 0 ? n : e
    blank(0, i)
  }
  while (i < n) {
    const c = content[i]!
    if (opts.lineComments.some((p) => content.startsWith(p, i))) {
      const e = content.indexOf('\n', i)
      const end = e < 0 ? n : e
      blank(i, end)
      i = end
      continue
    }
    const bc = opts.blockComment
    if (bc !== null && content.startsWith(bc[0], i)) {
      let end: number
      if (opts.nestedBlockComments === true) {
        end = nestedCommentEnd(content, i, bc[0], bc[1])
      } else {
        const e = content.indexOf(bc[1], i + bc[0].length)
        end = e < 0 ? n : e + bc[1].length
      }
      blank(i, end)
      i = end
      continue
    }
    if (opts.tripleQuotes === true && (content.startsWith('"""', i) || content.startsWith("'''", i))) {
      const q = content.slice(i, i + 3)
      let j = i + 3
      while (j < n && !content.startsWith(q, j)) j += content[j] === '\\' ? 2 : 1
      const closed = j < n
      blank(i + 3, Math.min(j, n))
      i = closed ? j + 3 : n
      continue
    }
    if (opts.quotes.includes(c)) {
      let j = i + 1
      while (j < n) {
        const ch = content[j]
        if (ch === '\\') {
          j += 2
          continue
        }
        if (ch === c || ch === '\n') break
        j++
      }
      const end = Math.min(j, n)
      blank(i + 1, end)
      i = end < n && content[end] === c ? end + 1 : end
      continue
    }
    i++
  }
  parts.push(content.slice(keepFrom))
  return parts.join('')
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch)
}

/** The identifier `s` ends with, and the `::` qualifier before it: `Foo::bar` gives bar and Foo. Scans back rather than using an end-anchored regex, which is quadratic on a long line. */
export function trailingIdentifier(s: string): { name: string; qualifier: string } | null {
  let start = s.length
  while (start > 0 && (isIdentChar(s[start - 1]) || s[start - 1] === ':' || s[start - 1] === '~')) start--
  const seg = s.slice(start)
  const parts = seg.split('::')
  const name = parts.pop() ?? ''
  if (!/^~?[A-Za-z_$][\w$]*$/.test(name) || parts.some((p) => !/^[A-Za-z_]\w*$/.test(p))) return null
  return { name, qualifier: parts.join('::') }
}

/** `s` with trailing characters from `chars` removed; linear, unlike an unanchored `[...]+$` regex. */
export function trimEndChars(s: string, chars: string): string {
  let end = s.length
  while (end > 0 && chars.includes(s[end - 1]!)) end--
  return s.slice(0, end)
}

/** Trimmed `code` without a trailing `{`, so a declaration regex can end at `$` rather than a backtracking `\{?\s*$`. */
export function withoutTrailingBrace(code: string): string {
  return code.endsWith('{') ? code.slice(0, -1).trimEnd() : code
}

/** The text inside the quote that starts at `ctx.raw[ctx.codeOffset + at]`, or `''`. */
export function rawQuoted(ctx: DeclContext, at: number): string {
  const start = ctx.codeOffset + at
  const q = ctx.raw[start]
  if (q !== '"' && q !== "'") return ''
  const end = ctx.raw.indexOf(q, start + 1)
  return end < 0 ? '' : ctx.raw.slice(start + 1, end).trim()
}

/** The first quoted or `<...>` target on a raw line, for an include or import. */
export function quotedTarget(raw: string): string | null {
  const m = /["'<]([^"'<>]+)["'>]/.exec(raw)
  return m === null ? null : m[1]!.trim()
}

// Words that start a statement or expression, never a declaration's type.
const C_NOT_A_TYPE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'else', 'do', 'sizeof', 'case', 'new', 'delete', 'throw', 'catch', 'typedef', 'using',
  'goto', 'static_assert', 'alignof', 'decltype', 'defined', 'foreach', 'synchronized', 'assert', 'emit', 'await', 'yield', 'in', 'not',
])
const C_PREFIX_RE = /^[A-Za-z_][\w\s*&:<>,[\].]*$/

/**
 * A C-style function header: a type, then the name, then `(`. The text before the parenthesis must be only type words, pointer and
 * reference marks, template brackets and `::`; a single word (a call, a macro) or anything with `=` does not qualify. Returns the
 * name, its `::` qualifier, and the words before it.
 */
export function cFunctionHeader(code: string): { name: string; qualifier: string; typeText: string } | null {
  const paren = code.indexOf('(')
  if (paren <= 0) return null
  const prefix = code.slice(0, paren).trimEnd()
  if (!C_PREFIX_RE.test(prefix) || prefix.replace(/::/g, '').includes(':')) return null
  const id = trailingIdentifier(prefix)
  if (id === null) return null
  const typeText = prefix.slice(0, prefix.length - (id.qualifier === '' ? id.name.length : id.qualifier.length + 2 + id.name.length)).trim()
  if (typeText === '' || typeText.endsWith('.') || typeText.endsWith(',')) return null
  const first = typeText.split(/[\s*&<>,[\]]/, 1)[0]!
  if (C_NOT_A_TYPE.has(first) || C_NOT_A_TYPE.has(id.name)) return null
  return { ...id, typeText }
}

interface Item {
  name: string
  kind: string
  lineStart: number
  lineEnd: number
  parent: string
  container: boolean
  nameAfterClose: boolean
}

interface Frame {
  /** The item this brace or keyword opened, or -1 for an unnamed block. */
  readonly item: number
  readonly keyword: boolean
  readonly depth: number
}

/** Run `lang` over `content`: symbols with exact spans and parents, plus the imports read on the same pass. */
export function scanBraceLanguage(content: string, filePath: string, lang: BraceLanguage): BraceAdapterResult {
  const rawLines = content.split(/\r?\n/)
  const masked = maskSource(content, lang.lex).split('\n')
  const items: Item[] = []
  const imports: AdapterImport[] = []
  const frames: Frame[] = []
  let depth = 0
  // `parens` counts the unclosed `(` of the pending header, so a parameter line inside it is not read as a new declaration.
  let pending: { item: number; depth: number; line: number; parens: number; dropPrototype: boolean } | null = null
  let continuation = false

  const close = (index: number, line: number): void => {
    const it = items[index]!
    it.lineEnd = Math.max(it.lineStart, line)
  }

  for (let i = 0; i < masked.length; i++) {
    const code = masked[i]!
    const raw = rawLines[i] ?? ''
    const trimmed = code.trim()
    const directive = lang.preprocessor === true && (continuation || trimmed.startsWith('#'))
    if (directive) {
      continuation = trimmed.endsWith('\\')
      const target = lang.importOf?.(trimmed, raw) ?? null
      if (target !== null && target !== '') imports.push({ kind: 'import', target, line: i + 1 })
      continue
    }
    if (trimmed !== '') {
      if (lang.keywordClose?.test(trimmed) === true) {
        let k = frames.length - 1
        while (k >= 0 && !frames[k]!.keyword) k--
        if (k >= 0) {
          // Any brace frame still open above it was left unbalanced; the keyword ends them all.
          close(frames[k]!.item, i + 1)
          frames.length = k
          pending = null
        }
        continue
      }
      const target = lang.importOf?.(trimmed, raw) ?? null
      if (target !== null && target !== '') imports.push({ kind: 'import', target, line: i + 1 })
      const top = frames[frames.length - 1]
      const topItem = top !== undefined && top.item >= 0 ? items[top.item]! : undefined
      const scope: Scope = top === undefined ? 'top' : topItem === undefined ? 'block' : topItem.container ? 'container' : 'function'
      let parentIdx = -1
      for (let f = frames.length - 1; f >= 0 && parentIdx < 0; f--) {
        const idx = frames[f]!.item
        if (idx >= 0 && items[idx]!.container) parentIdx = idx
      }
      const parent = parentIdx >= 0 ? items[parentIdx]! : undefined
      const ctx: DeclContext = {
        scope,
        insideFunction: frames.some((f) => f.item >= 0 && !items[f.item]!.container),
        parent: parent?.name ?? '',
        parentKind: parent?.kind ?? '',
        raw,
        codeOffset: code.length - code.trimStart().length,
        header: () => headerFrom(masked, i),
      }
      const inHeader: boolean = pending !== null && pending.parens > 0
      const d: Decl | null = items.length < MAX_SYMBOLS && !inHeader ? lang.match(trimmed, ctx) : null
      if (d !== null && d.name.length <= MAX_NAME_LENGTH && (d.name !== '' || d.nameAfterClose === true)) {
        pending = null
        items.push({
          name: d.name,
          kind: d.kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          parent: d.parent ?? ctx.parent,
          container: d.container === true,
          nameAfterClose: d.nameAfterClose === true,
        })
        const idx = items.length - 1
        if (d.end === 'brace') pending = { item: idx, depth, line: i, parens: 0, dropPrototype: d.dropPrototype === true }
        else if (d.end === 'keyword') frames.push({ item: idx, keyword: true, depth })
      }
    }
    for (let c = 0; c < code.length; c++) {
      const ch = code.charCodeAt(c)
      if (ch === 123) {
        depth++
        if (pending !== null && pending.depth === depth - 1) {
          frames.push({ item: pending.item, keyword: false, depth })
          pending = null
        } else {
          frames.push({ item: -1, keyword: false, depth })
        }
      } else if (ch === 125) {
        const top = frames[frames.length - 1]
        if (top !== undefined && !top.keyword && top.depth === depth) {
          frames.pop()
          if (top.item >= 0) {
            close(top.item, i + 1)
            const it = items[top.item]!
            if (it.nameAfterClose && it.name === '') it.name = /^[\s*]*([A-Za-z_]\w*)/.exec(code.slice(c + 1))?.[1] ?? ''
          }
        }
        depth = Math.max(0, depth - 1)
        if (pending !== null && depth < pending.depth) pending = null
      } else if (ch === 40 && pending !== null) {
        pending.parens++
      } else if (ch === 41 && pending !== null) {
        pending.parens = Math.max(0, pending.parens - 1)
      } else if (ch === 59 && pending !== null && depth === pending.depth && pending.parens === 0) {
        close(pending.item, i + 1)
        // A prototype of a language that also has a definition would list the name twice, so it is dropped.
        if (pending.dropPrototype) items[pending.item]!.name = ''
        pending = null
      }
    }
    if (pending !== null && i - pending.line >= PENDING_MAX_LINES) pending = null
  }

  const symbols: SymbolEntry[] = items
    .filter((it) => it.name !== '')
    .map((it) => ({
      filePath,
      name: it.name,
      kind: it.kind,
      lineStart: it.lineStart,
      lineEnd: it.lineEnd,
      body: rawLines.slice(it.lineStart - 1, it.lineEnd).join('\n'),
      docstring: lang.docComments === true ? precedingDocComment(rawLines, it.lineStart, 'c') : '',
      parent: it.parent,
    }))
  return { symbols, imports }
}

function headerFrom(masked: readonly string[], from: number): string {
  let s = ''
  for (let j = from; j < masked.length && j < from + HEADER_MAX_LINES; j++) {
    const t = masked[j]!
    const cut = t.search(/[{;]/)
    s += ` ${cut < 0 ? t : t.slice(0, cut)}`
    if (cut >= 0 || s.length > HEADER_MAX_CHARS) break
  }
  return s.trim()
}

/** `code` with leading annotations (`@Name`, `@Name(...)`, `@a.b.Name`) and any of `words` removed. Linear. */
export function stripLeadingWords(code: string, words: ReadonlySet<string>, annotations: boolean): string {
  let i = 0
  for (;;) {
    while (i < code.length && /\s/.test(code[i]!)) i++
    if (annotations && code[i] === '@' && /[A-Za-z_]/.test(code[i + 1] ?? '') && !code.startsWith('@interface', i)) {
      i++
      while (i < code.length && (isIdentChar(code[i]) || code[i] === '.')) i++
      let j = i
      while (j < code.length && code[j] === ' ') j++
      if (code[j] === '(') {
        let d = 0
        for (; j < code.length; j++) {
          if (code[j] === '(') d++
          else if (code[j] === ')' && --d === 0) break
        }
        i = j + 1
      }
      continue
    }
    let j = i
    while (j < code.length && (isIdentChar(code[j]) || code[j] === '-')) j++
    if (j > i && words.has(code.slice(i, j)) && (j === code.length || /\s/.test(code[j]!))) {
      i = j
      continue
    }
    return code.slice(i)
  }
}
