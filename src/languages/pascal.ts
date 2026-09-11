/**
 * Pascal, Delphi and Free Pascal adapter: the program, unit, library or package header, classes, records, objects, interfaces
 * and enumerations from type sections, their methods, constructors, destructors and properties, and routines with their
 * nested routines. A method implemented as `TFoo.Bar` is listed once, under TFoo, spanning its body; the declaration inside
 * the class is dropped when that body exists. A routine body runs from its `begin` or `asm` to the `end` that balances it,
 * counting `begin`, `case`, `try` and `asm` as openers. Keywords and names are case-insensitive. `{ }`, `(* *)` and `//`
 * comments (compiler directives too) and `'...'` strings never produce symbols. Imports are the `uses`, `requires` and
 * `contains` clauses. Delphi form files (`.dfm`) in text form list each `object`, `inherited` or `inline` component under
 * its owner; a binary form (it starts with `TPF0`) produces nothing.
 */

import * as path from 'node:path'

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

type TokenType = 'id' | 'str' | 'num' | 'sym'

interface Token {
  readonly type: TokenType
  readonly text: string
  readonly upper: string
  readonly line: number
}

// How deep nested routines and nested type sections are followed; a deeper one is skipped rather than recursed into.
const MAX_DEPTH = 32

/** Tokens of a Pascal source with comments removed. Linear: each comment and string is closed with one indexOf or a single scan. */
function tokenize(src: string): Token[] {
  const toks: Token[] = []
  let line = 1
  let i = 0
  const n = src.length
  const push = (type: TokenType, text: string, at: number): void => {
    toks.push({ type, text, upper: text.toUpperCase(), line: at })
  }
  const countLines = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (src.charCodeAt(k) === 10) line++
  }
  while (i < n) {
    const ch = src[i]!
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') {
      i++
      continue
    }
    if (ch === '{') {
      const end = src.indexOf('}', i + 1)
      const stop = end < 0 ? n : end + 1
      countLines(i, stop)
      i = stop
      continue
    }
    if (ch === '(' && src[i + 1] === '*') {
      const end = src.indexOf('*)', i + 2)
      const stop = end < 0 ? n : end + 2
      countLines(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      i = end < 0 ? n : end
      continue
    }
    if (ch === "'" || ch === '#') {
      // A string literal: quoted runs with `''` escapes, joined with `#13`-style character codes.
      const at = line
      while (i < n && (src[i] === "'" || src[i] === '#')) {
        if (src[i] === '#') {
          i++
          while (i < n && /[$\w]/.test(src[i]!)) i++
          continue
        }
        i++
        while (i < n && src[i] !== '\n') {
          if (src[i] === "'") {
            if (src[i + 1] === "'") {
              i += 2
              continue
            }
            break
          }
          i++
        }
        if (src[i] === "'") i++
      }
      push('str', "'", at)
      continue
    }
    if (/[A-Za-z_&]/.test(ch)) {
      let j = i + 1
      while (j < n && /\w/.test(src[j]!)) j++
      const text = src.slice(ch === '&' ? i + 1 : i, j)
      if (text !== '') push('id', text, line)
      i = j
      continue
    }
    if (/[0-9$%]/.test(ch)) {
      let j = i + 1
      while (j < n && /[\w.]/.test(src[j]!) && !(src[j] === '.' && src[j + 1] === '.')) j++
      push('num', src.slice(i, j), line)
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === ':=' || two === '..' || two === '<=' || two === '>=' || two === '<>') {
      push('sym', two, line)
      i += 2
      continue
    }
    push('sym', ch, line)
    i++
  }
  return toks
}

const ROUTINE_WORDS: ReadonlySet<string> = new Set(['PROCEDURE', 'FUNCTION', 'CONSTRUCTOR', 'DESTRUCTOR', 'OPERATOR'])
const VISIBILITY: ReadonlySet<string> = new Set(['PRIVATE', 'PROTECTED', 'PUBLIC', 'PUBLISHED', 'STRICT', 'AUTOMATED'])
// Words that end a type section, and the members that end a nested type section inside a class.
const SECTION_WORDS: ReadonlySet<string> = new Set([
  'VAR', 'CONST', 'RESOURCESTRING', 'THREADVAR', 'LABEL', 'EXPORTS', 'IMPLEMENTATION', 'INITIALIZATION', 'FINALIZATION', 'BEGIN', 'ASM',
  'END', 'USES', 'PROPERTY', 'CLASS', ...ROUTINE_WORDS, ...VISIBILITY,
])
const DIRECTIVES: ReadonlySet<string> = new Set([
  'OVERLOAD', 'OVERRIDE', 'VIRTUAL', 'DYNAMIC', 'ABSTRACT', 'REINTRODUCE', 'STATIC', 'INLINE', 'CDECL', 'STDCALL', 'REGISTER', 'PASCAL',
  'SAFECALL', 'WINAPI', 'EXPORT', 'FORWARD', 'EXTERNAL', 'ASSEMBLER', 'DEPRECATED', 'PLATFORM', 'LIBRARY', 'EXPERIMENTAL', 'FINAL',
  'VARARGS', 'MESSAGE', 'DISPID', 'FAR', 'NEAR', 'NOSTACKFRAME', 'CPPDECL', 'ALIAS', 'NORETURN', 'UNIMPLEMENTED', 'INTERRUPT', 'MWPASCAL',
  'MS_ABI_DEFAULT', 'SYSV_ABI_DEFAULT', 'VECTORCALL', 'DELAYED',
])
const HEADER_WORDS: ReadonlySet<string> = new Set(['PROGRAM', 'UNIT', 'LIBRARY', 'PACKAGE'])
const IMPORT_WORDS: ReadonlySet<string> = new Set(['USES', 'REQUIRES', 'CONTAINS'])
const MEMBER_KINDS: Readonly<Record<string, string>> = { PROCEDURE: 'method', FUNCTION: 'method', CONSTRUCTOR: 'constructor', DESTRUCTOR: 'destructor', OPERATOR: 'operator' }

/** True when a `.pp` file (Puppet uses it too) opens, after any comments, with a Pascal `unit`, `program` or `library` header. */
export function isPascalSource(content: string): boolean {
  const head = content.slice(0, 8192)
  let i = 0
  for (;;) {
    while (i < head.length && /\s/.test(head[i]!)) i++
    if (head[i] === '{') {
      const end = head.indexOf('}', i)
      if (end < 0) return false
      i = end + 1
    } else if (head.startsWith('(*', i)) {
      const end = head.indexOf('*)', i)
      if (end < 0) return false
      i = end + 2
    } else if (head.startsWith('//', i)) {
      const end = head.indexOf('\n', i)
      if (end < 0) return false
      i = end + 1
    } else {
      break
    }
  }
  return /^(?:unit|program|library)[ \t\r\n]+[A-Za-z_][\w.]*[ \t\r\n]*[;(]/i.test(head.slice(i, i + 300))
}

class PascalParser {
  private p = 0
  readonly imports: AdapterImport[] = []
  // Symbols that are declarations inside a class, keyed so an implementation can replace them.
  readonly declarations = new Map<number, string>()
  readonly implementations = new Set<string>()

  constructor(
    private readonly toks: readonly Token[],
    readonly spans: SpanCollector,
  ) {}

  private at(k = 0): Token | undefined {
    return this.toks[this.p + k]
  }

  private upper(k = 0): string {
    return this.toks[this.p + k]?.upper ?? ''
  }

  private isSym(text: string, k = 0): boolean {
    const t = this.toks[this.p + k]
    return t !== undefined && t.type === 'sym' && t.text === text
  }

  private lastLine(): number {
    return this.toks[Math.min(this.p, this.toks.length) - 1]?.line ?? 1
  }

  /** Advance past the next `;` outside brackets, returning that `;`'s line. */
  private skipStatement(): number {
    let depth = 0
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++]!
      if (t.type !== 'sym') continue
      if (t.text === '(' || t.text === '[') depth++
      else if (t.text === ')' || t.text === ']') depth = Math.max(0, depth - 1)
      else if (t.text === ';' && depth === 0) return t.line
    }
    return this.lastLine()
  }

  /** Advance past a balanced `(...)`, `[...]` or `<...>` group starting at the current token. */
  private skipGroup(open: string, close: string): void {
    let depth = 0
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++]!
      if (t.type !== 'sym') continue
      if (t.text === open) depth++
      else if (t.text === close && --depth === 0) return
      else if (t.text === ';' && open === '<') return
    }
  }

  /** A dotted name with generic parameters removed: `TList<T>.Add` gives ['TList', 'Add']. */
  private dottedName(): string[] {
    const parts: string[] = []
    while (this.at()?.type === 'id') {
      parts.push(this.at()!.text)
      this.p++
      if (this.isSym('<')) this.skipGroup('<', '>')
      if (this.isSym('.') && this.at(1)?.type === 'id') this.p++
      else break
    }
    return parts
  }

  /** True when the routine keyword at the current token starts a declaration rather than a procedural type or anonymous method. */
  private isRoutineStart(): boolean {
    let k = this.p - 1
    if (this.toks[k]?.upper === 'CLASS') k--
    const prev = this.toks[k]
    if (prev === undefined) return true
    if (prev.type === 'sym') return prev.text === ';' || prev.text === ']'
    return prev.upper === 'IMPLEMENTATION' || prev.upper === 'INTERFACE' || VISIBILITY.has(prev.upper)
  }

  /** Skip the directives after a routine header; true when one of them says the routine has no body here. */
  private skipDirectives(): boolean {
    let bodiless = false
    for (;;) {
      if (this.isSym('[')) {
        this.skipGroup('[', ']')
        continue
      }
      const u = this.upper()
      if (this.at()?.type !== 'id' || !DIRECTIVES.has(u)) return bodiless
      if (u === 'FORWARD' || u === 'EXTERNAL') bodiless = true
      this.skipStatement()
    }
  }

  /** Parse a routine header at a routine keyword (after any `class`); the cursor ends past its `;`. */
  private routineHeader(): { word: string; parts: string[]; line: number; end: number } {
    if (this.upper() === 'CLASS') this.p++
    const word = this.upper()
    const line = this.at()!.line
    this.p++
    let parts = this.dottedName()
    // Free Pascal names an operator by its symbol: `operator + (a, b: T) r: T;`.
    if (parts.length === 0 && word === 'OPERATOR' && this.at()?.type === 'sym') parts = [this.toks[this.p++]!.text]
    const end = this.skipStatement()
    return { word, parts, line, end }
  }

  /** A routine in a unit's implementation part or a program, with its nested routines, to the `end` that closes its body. */
  private routine(parent: string, depth: number): void {
    const h = this.routineHeader()
    const bodiless = this.skipDirectives()
    if (bodiless || h.parts.length === 0) return
    const name = h.parts[h.parts.length - 1]!
    const qualifier = h.parts.length > 1 ? h.parts[h.parts.length - 2]! : ''
    const kind = qualifier === '' ? h.word.toLowerCase() : MEMBER_KINDS[h.word]!
    const index = this.spans.open(name, kind, h.line, qualifier === '' ? parent : qualifier)
    if (qualifier !== '') this.implementations.add(`${qualifier.toUpperCase()}.${name.toUpperCase()}`)
    if (depth >= MAX_DEPTH) return
    // Declarations: labels, constants, types, variables and nested routines, up to the body.
    while (this.p < this.toks.length) {
      const u = this.upper()
      if (u === 'BEGIN' || u === 'ASM') break
      if (this.at()!.type === 'id' && (ROUTINE_WORDS.has(u) || (u === 'CLASS' && ROUTINE_WORDS.has(this.upper(1)))) && this.isRoutineStart()) {
        this.routine(this.spans.name(index) || parent, depth + 1)
        continue
      }
      if (u === 'TYPE' && this.at()!.type === 'id') {
        this.typeSection(this.spans.name(index), depth + 1)
        continue
      }
      this.p++
    }
    this.spans.close(index, this.block())
  }

  /** Skip a `begin` or `asm` block to its balancing `end`, returning that line. */
  private block(): number {
    let depth = 0
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++]!
      if (t.type !== 'id') continue
      if (t.upper === 'BEGIN' || t.upper === 'CASE' || t.upper === 'TRY' || t.upper === 'ASM') depth++
      else if (t.upper === 'END' && --depth <= 0) return t.line
    }
    return this.lastLine()
  }

  /** A `type` section: each declaration of a class, record, object, interface or enumeration becomes a symbol under `parent`. */
  private typeSection(parent: string, depth: number): void {
    this.p++
    while (this.p < this.toks.length) {
      const t = this.at()!
      if (this.isSym('[')) {
        this.skipGroup('[', ']')
        continue
      }
      if (t.type === 'id' && SECTION_WORDS.has(t.upper)) return
      if (t.type === 'id' && t.upper === 'TYPE') {
        this.p++
        continue
      }
      if (t.type !== 'id' || !(this.isSym('=', 1) || this.isSym('<', 1))) {
        this.p++
        continue
      }
      this.p++
      if (this.isSym('<')) this.skipGroup('<', '>')
      if (!this.isSym('=')) continue
      this.p++
      this.typeDefinition(t, parent, depth)
    }
  }

  private typeDefinition(name: Token, parent: string, depth: number): void {
    while (this.upper() === 'PACKED' || this.upper() === 'BITPACKED') this.p++
    const u = this.upper()
    if (u === 'CLASS') {
      this.p++
      if (this.isSym(';') || this.upper() === 'OF') {
        this.skipStatement()
        return
      }
      while (this.upper() === 'SEALED' || this.upper() === 'ABSTRACT') this.p++
      if (this.upper() === 'HELPER') {
        this.p++
        if (this.isSym('(')) this.skipGroup('(', ')')
        if (this.upper() === 'FOR') this.p++
        this.dottedName()
      }
      if (this.isSym('(')) this.skipGroup('(', ')')
      if (this.isSym(';')) {
        // `TError = class(Exception);` declares a class with no members of its own.
        this.spans.close(this.spans.open(name.text, 'class', name.line, parent), this.toks[this.p++]!.line)
        return
      }
      this.body(name, 'class', parent, depth)
      return
    }
    if (u === 'RECORD' || u === 'OBJECT') {
      this.p++
      if (this.upper() === 'HELPER') {
        this.p++
        if (this.upper() === 'FOR') this.p++
        this.dottedName()
      }
      if (u === 'OBJECT' && this.isSym('(')) this.skipGroup('(', ')')
      this.body(name, u.toLowerCase(), parent, depth)
      return
    }
    if (u === 'INTERFACE' || u === 'DISPINTERFACE') {
      this.p++
      if (this.isSym(';')) {
        this.p++
        return
      }
      if (this.isSym('(')) this.skipGroup('(', ')')
      this.body(name, 'interface', parent, depth)
      return
    }
    if (this.isSym('(')) {
      this.skipGroup('(', ')')
      const end = this.isSym(';') ? this.toks[this.p++]!.line : this.lastLine()
      this.spans.close(this.spans.open(name.text, 'enum', name.line, parent), end)
      return
    }
    // Aliases, pointers, sets, arrays and procedural types: skip to the `;`, stepping over any record inside.
    let records = 0
    let brackets = 0
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++]!
      if (t.type === 'id' && t.upper === 'RECORD') records++
      else if (t.type === 'id' && t.upper === 'END') records = Math.max(0, records - 1)
      else if (t.type === 'sym' && (t.text === '(' || t.text === '[')) brackets++
      else if (t.type === 'sym' && (t.text === ')' || t.text === ']')) brackets = Math.max(0, brackets - 1)
      else if (t.type === 'sym' && t.text === ';' && records === 0 && brackets === 0) return
    }
  }

  /** The members of a class, record, object or interface body, up to its `end`. */
  private body(name: Token, kind: string, parent: string, depth: number): void {
    const index = this.spans.open(name.text, kind, name.line, parent)
    const owner = this.spans.name(index)
    let records = 0
    while (this.p < this.toks.length) {
      const t = this.at()!
      if (t.type !== 'id') {
        if (this.isSym('[')) this.skipGroup('[', ']')
        else this.p++
        continue
      }
      if (t.upper === 'END') {
        this.p++
        if (records > 0) {
          records--
          continue
        }
        this.spans.close(index, t.line)
        if (this.isSym(';')) this.p++
        return
      }
      if (t.upper === 'RECORD') {
        records++
        this.p++
        continue
      }
      if (records === 0 && (ROUTINE_WORDS.has(t.upper) || (t.upper === 'CLASS' && ROUTINE_WORDS.has(this.upper(1))))) {
        this.member(owner)
        continue
      }
      if (records === 0 && t.upper === 'PROPERTY' && this.at(1)?.type === 'id') {
        const prop = this.at(1)!
        this.p += 2
        let end = this.skipStatement()
        if (this.upper() === 'DEFAULT' && this.isSym(';', 1)) {
          end = this.toks[this.p + 1]!.line
          this.p += 2
        }
        this.spans.close(this.spans.open(prop.text, 'property', prop.line, owner), end)
        continue
      }
      if (records === 0 && t.upper === 'TYPE' && depth < MAX_DEPTH) {
        this.typeSection(owner, depth + 1)
        continue
      }
      this.p++
    }
    this.spans.close(index, this.lastLine())
  }

  private member(owner: string): void {
    const h = this.routineHeader()
    // `procedure IFoo.Bar = Baz;` maps an interface method to another name and declares nothing new.
    if (h.parts.length !== 1) return
    const end = this.skipMemberDirectives(h.end)
    const index = this.spans.open(h.parts[0]!, MEMBER_KINDS[h.word]!, h.line, owner)
    this.spans.close(index, end)
    if (index !== undefined) this.declarations.set(index, `${owner.toUpperCase()}.${h.parts[0]!.toUpperCase()}`)
  }

  /** Like skipDirectives, but returns the line the last directive ended on. */
  private skipMemberDirectives(end: number): number {
    for (;;) {
      if (this.at()?.type !== 'id' || !DIRECTIVES.has(this.upper())) return end
      end = this.skipStatement()
    }
  }

  parse(): void {
    let header: number | undefined
    let inInterface = false
    if (this.at()?.type === 'id' && HEADER_WORDS.has(this.upper())) {
      const word = this.upper().toLowerCase()
      const line = this.at()!.line
      this.p++
      const parts = this.dottedName()
      header = this.spans.open(parts.join('.'), word, line)
      this.skipStatement()
    }
    while (this.p < this.toks.length) {
      const t = this.at()!
      if (t.type !== 'id') {
        this.p++
        continue
      }
      const u = t.upper
      if (IMPORT_WORDS.has(u) && this.importAllowed()) {
        this.p++
        this.importList(u)
        continue
      }
      if (u === 'INTERFACE') inInterface = true
      else if (u === 'IMPLEMENTATION') inInterface = false
      if (u === 'TYPE') {
        this.typeSection('', 0)
        continue
      }
      if ((ROUTINE_WORDS.has(u) || (u === 'CLASS' && ROUTINE_WORDS.has(this.upper(1)))) && this.isRoutineStart()) {
        if (inInterface) {
          // A unit's interface part only restates the header of a routine its implementation part defines.
          this.routineHeader()
          this.skipDirectives()
        } else {
          this.routine('', 0)
        }
        continue
      }
      if (u === 'BEGIN' || u === 'ASM') {
        this.block()
        if (this.isSym('.')) {
          this.spans.close(header, this.toks[this.p - 1]!.line)
          header = undefined
          break
        }
        continue
      }
      if (u === 'END' && this.isSym('.', 1)) {
        this.spans.close(header, t.line)
        header = undefined
        break
      }
      this.p++
    }
    this.spans.close(header, this.lastLine())
  }

  private importAllowed(): boolean {
    const prev = this.toks[this.p - 1]
    return prev === undefined || (prev.type === 'sym' && prev.text === ';') || prev.upper === 'INTERFACE' || prev.upper === 'IMPLEMENTATION'
  }

  private importList(word: string): void {
    while (this.p < this.toks.length) {
      const line = this.at()!.line
      const parts = this.dottedName()
      if (parts.length > 0) this.imports.push({ kind: word === 'USES' ? 'import' : word.toLowerCase(), target: parts.join('.'), line })
      if (this.upper() === 'IN') this.p += 2
      if (this.isSym(',')) {
        this.p++
        continue
      }
      this.skipStatement()
      return
    }
  }
}

const DFM_OBJECT_RE = /^(?:object|inherited|inline)[ \t]+([A-Za-z_]\w*)/i

/** A text-form Delphi or Lazarus form: every component, nested under the one that owns it. */
function extractDfm(content: string, filePath: string): StatementAdapterResult {
  const spans = new SpanCollector(filePath)
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  // Binary forms start with the TPF0 signature, or with the resource header 0xFF 0x0A that decodes as a replacement character.
  if (text.startsWith('TPF0') || text.includes('\0') || text.charCodeAt(0) === 0xfffd || text.charCodeAt(0) === 0xff) return { symbols: [], imports: [] }
  const rawLines = text.split(/\r?\n/)
  const stack: Array<number | undefined> = []
  const owner = (): string => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k] !== undefined) return spans.name(stack[k])
    return ''
  }
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!.trim()
    const m = DFM_OBJECT_RE.exec(line)
    if (m !== null) {
      stack.push(spans.open(m[1]!, 'component', i + 1, owner()))
    } else if (/^item$/i.test(line)) {
      stack.push(undefined)
    } else if (/^end>?$/i.test(line) && stack.length > 0) {
      spans.close(stack.pop(), i + 1)
    }
  }
  while (stack.length > 0) spans.close(stack.pop(), rawLines.length)
  return { symbols: spans.finish(rawLines), imports: [] }
}

export function extractPascal(content: string, filePath: string): StatementAdapterResult {
  if (path.extname(filePath).toLowerCase() === '.dfm') return extractDfm(content, filePath)
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const spans = new SpanCollector(filePath)
  const parser = new PascalParser(tokenize(content), spans)
  parser.parse()
  const rawLines = content.split(/\r?\n/)
  const symbols = spans.finish(rawLines)
  // A method declared in a class and implemented below it is listed once, at the implementation that carries its body.
  const dropped = new Set<number>()
  for (const [index, key] of parser.declarations) if (parser.implementations.has(key)) dropped.add(index)
  return { symbols: symbols.filter((_, k) => !dropped.has(k)), imports: parser.imports }
}
