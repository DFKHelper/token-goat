/**
 * Visual Basic symbol extractor, regex-based (no tree-sitter grammar ships for VB).
 *
 * Covers VB.NET (`.vb`), VB6/VBA standard modules (`.bas`), VBScript (`.vbs`), VB6 forms (`.frm`), and VB6 class modules (`.cls`, routed here only when the content sniff in parser_types.ts recognizes the VB6 header; every other `.cls` stays Apex).
 *
 * Extracts: Namespace, Module, Class, Structure, Interface, Enum (members as children), Sub, Function, Property (VB.NET block and auto forms, VB6 Property Get/Let/Set), Event (plain and Custom), Delegate, Declare, Operator, Const, VB6 `Type` blocks and their members, and type-level fields. A `'''` XML doc comment directly above a declaration (or above its attribute lines) becomes that symbol's docstring. `#Region` blocks are sections, read by section_reader.ts rather than indexed here.
 *
 * VB is keyword-terminated and case-insensitive: a declaration opens a frame and `End <Keyword>` closes the nearest frame of that keyword. `End If`/`End Select`/`End With`/`End Try`/`End Using`/`End While` and a bare `End` never close a declaration, `MustOverride` members and interface members have no `End`, and a multi-line lambda (`Sub()` ... `End Sub`) pushes an anonymous frame so its `End Sub` never closes the enclosing procedure.
 *
 * Physical lines are first reduced to code (string contents blanked, `'` and `REM` comments removed), then joined across ` _` continuations and unbalanced parentheses, then split on `:` statement separators.
 */

import type { SymbolEntry } from '../parser_types.js'
import { precedingDocComment } from '../doc_comment.js'
import { makeLineSymbol, type AdapterImport } from './common.js'

/** Same cap every other adapter's emitter applies, so a generated file cannot bloat the index. */
const MAX_SYMBOLS = 10_000
/** Longest run of physical lines one statement may absorb through an unbalanced parenthesis, so a stray `(` cannot swallow the rest of the file. */
const MAX_PAREN_JOIN_LINES = 50

/** One VB statement after comment/string stripping, continuation joining, and `:` splitting. */
interface Statement {
  readonly code: string
  readonly lineStart: number
  readonly lineEnd: number
}

type FrameKind =
  | 'namespace' | 'module' | 'class' | 'structure' | 'interface' | 'enum' | 'type'
  | 'sub' | 'function' | 'property' | 'event' | 'operator'

interface Frame {
  readonly kind: FrameKind
  readonly name: string
  /** True for an anonymous lambda frame: it balances an `End Sub`/`End Function` but is never reported as a parent. */
  readonly isBlock: boolean
  /** Index in `symbols` of the declaration this frame opened, widened to the real body when the matching `End` pops it. */
  readonly symbolIndex?: number
}

const PROCEDURE_KINDS: ReadonlySet<FrameKind> = new Set<FrameKind>(['sub', 'function', 'property', 'event', 'operator'])
const TYPE_KINDS: ReadonlySet<FrameKind> = new Set<FrameKind>(['module', 'class', 'structure', 'interface'])

const ID = String.raw`\[?[A-Za-z_][A-Za-z0-9_]*\]?[$%&!#@]?`

// Declaration modifiers, any number and any order, before the declaring keyword. `Global` is the VB6 spelling of a public module-level variable; `Custom` only ever precedes `Event`.
const MODIFIERS_RE = /^(?:(?:Public|Private|Friend|Protected|Shared|Static|Overrides|Overridable|NotOverridable|MustOverride|MustInherit|NotInheritable|Overloads|Shadows|Partial|Async|Iterator|Default|WithEvents|ReadOnly|WriteOnly|Widening|Narrowing|Custom|Global)\s+)+/i

const NAMESPACE_RE = /^Namespace\s+((?:Global\.)?[A-Za-z_][\w.]*)/i
const CONTAINER_RE = new RegExp(String.raw`^(Module|Class|Structure|Interface|Enum)\s+(${ID})`, 'i')
const VB6_TYPE_RE = new RegExp(String.raw`^Type\s+(${ID})\s*$`, 'i')
const DELEGATE_RE = new RegExp(String.raw`^Delegate\s+(?:Sub|Function)\s+(${ID})`, 'i')
const DECLARE_RE = new RegExp(String.raw`^Declare\s+(?:(?:Ansi|Unicode|Auto|PtrSafe)\s+)*(?:Sub|Function)\s+(${ID})`, 'i')
const VB6_PROPERTY_RE = new RegExp(String.raw`^Property\s+(?:Get|Let|Set)\s+(${ID})`, 'i')
const PROPERTY_RE = new RegExp(String.raw`^Property\s+(${ID})`, 'i')
const PROCEDURE_RE = new RegExp(String.raw`^(Sub|Function)\s+(${ID})`, 'i')
const OPERATOR_RE = /^Operator\s+([^\s(]+)\s*\(/i
const EVENT_RE = new RegExp(String.raw`^Event\s+(${ID})`, 'i')
const CONST_RE = /^Const\s+(\S.*)$/i
const DIM_RE = /^Dim\s+(\S.*)$/i
const FIELD_AFTER_MODIFIERS_RE = new RegExp(String.raw`^(${ID})\s*(?:\(|As\b|=|,|$)`, 'i')
const ENUM_MEMBER_RE = new RegExp(String.raw`^(${ID})\s*(?:=.*)?$`, 'i')
const TYPE_MEMBER_RE = new RegExp(String.raw`^(${ID})(?:\s*\([^)]*\))?\s+As\b`, 'i')
const IMPORTS_RE = /^Imports\s+(\S.*)$/i
const END_RE = /^End\s+(Namespace|Module|Class|Structure|Interface|Enum|Sub|Function|Property|Event|Operator|Type)\b/i
// The line after a VB.NET `Property` header that proves it is a block property rather than an auto-implemented one: a `Get` or `Set` accessor, optionally access-restricted.
const ACCESSOR_RE = /^(?:(?:Public|Private|Friend|Protected)\s+)*(?:Get|Set)\s*(?:\(|$)/i
// A VB6 `Attribute Name.VB_Description = "..."` line, in a module header or inside a procedure: metadata, never a declaration.
const ATTRIBUTE_LINE_RE = /^Attribute\s+[\w.]+\s*=/i
// A physical line holding only a VB.NET attribute block, optionally ending in a ` _` continuation.
const ATTRIBUTE_ONLY_LINE_RE = /^\s*<[^>].*>\s*(?:_\s*)?$/
// The VB compiler also accepts the typographic single quotes U+2018 and U+2019 as comment starters, which editors and word processors substitute for `'`.
const LEFT_SINGLE_QUOTE = String.fromCharCode(0x2018)
const RIGHT_SINGLE_QUOTE = String.fromCharCode(0x2019)

/** A VB identifier as written, minus `[escape]` brackets and any VB6 type-declaration suffix (`Name$`, `Count%`). */
function cleanName(raw: string): string {
  return raw.replace(/^\[/, '').replace(/\]$/, '').replace(/[$%&!#@]$/, '')
}

/**
 * Reduces one physical line to code: string contents are blanked (quotes kept, so a `Lib "x"` clause keeps its shape), and a `'` comment or a `REM` statement ends the line. `""` inside a string is an escaped quote, not a terminator.
 */
function stripLine(line: string): string {
  let out = ''
  let inString = false
  let atStatementStart = true
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inString) {
      if (ch === '"') {
        if (line[i + 1] === '"') { out += '  '; i++; continue }
        inString = false
        out += '"'
        continue
      }
      out += ' '
      continue
    }
    if (ch === '"') { inString = true; atStatementStart = false; out += '"'; continue }
    if (ch === "'" || ch === LEFT_SINGLE_QUOTE || ch === RIGHT_SINGLE_QUOTE) break
    if (atStatementStart && /^REM(?:\s|$)/i.test(line.slice(i))) break
    if (ch === ':') { atStatementStart = true; out += ch; continue }
    if (ch !== ' ' && ch !== '\t') atStatementStart = false
    out += ch
  }
  return out
}

/** Net `(` minus `)` depth of already-stripped code, used to join a parameter list broken across lines without a ` _`. */
function parenDelta(code: string): number {
  let d = 0
  for (const ch of code) {
    if (ch === '(') d++
    else if (ch === ')') d--
  }
  return d
}

/** Splits a logical line on `:` statement separators, never inside parentheses or braces, never on a named-argument `:=`, and never inside a leading `<Assembly: ...>` attribute. */
function splitStatements(code: string): string[] {
  const parts: string[] = []
  let depth = 0
  let angle = 0
  let current = ''
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    const segmentStartsWithAngle = current.trimStart().startsWith('<') || (current.trim() === '' && ch === '<')
    if (ch === '(' || ch === '{') depth++
    else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1)
    else if (segmentStartsWithAngle && ch === '<') angle++
    else if (segmentStartsWithAngle && ch === '>') angle = Math.max(0, angle - 1)
    if (ch === ':' && depth === 0 && angle === 0 && code[i + 1] !== '=') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** Removes leading `<Attribute(...)>` blocks; an attribute-only statement becomes empty. */
function stripAttributes(stmt: string): string {
  let s = stmt.trimStart()
  while (s.startsWith('<')) {
    let depth = 0
    let end = -1
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '<') depth++
      else if (s[i] === '>') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) return ''
    s = s.slice(end + 1).trimStart()
  }
  return s
}

/** Splits a comma list at depth 0 (parentheses and braces), so `Dim a As Dictionary(Of K, V), b` yields two parts. */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '{') depth++
    else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}

/** The leading identifier of each declarator in a `Dim`/`Const`/field list. */
function declaratorNames(list: string): string[] {
  const names: string[] = []
  const lead = new RegExp(String.raw`^\s*(${ID})`)
  for (const part of splitTopLevelCommas(list)) {
    const m = lead.exec(part)
    if (m) names.push(cleanName(m[1]!))
  }
  return names
}

/** True when `code` contains a multi-line lambda header: `Sub(...)`/`Function(...)` whose closing parenthesis ends the statement (optionally followed by `As Type`), leaving the body for the following lines. */
function opensMultilineLambda(code: string): 'sub' | 'function' | null {
  const re = /\b(Sub|Function)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') { depth--; if (depth === 0) break }
    }
    if (depth !== 0) continue
    const after = code.slice(i + 1)
    if (/^\s*(?:As\s+\S.*)?$/i.test(after)) return m[1]!.toLowerCase() as 'sub' | 'function'
  }
  return null
}

/** Blanks a VB6 file header (`VERSION x.xx` then the `Begin ... End` designer block of a form, or the `BEGIN ... END` block of a class module) so its property lines are never read as code. A header that never closes blanks to end of file. */
function blankVb6Header(lines: string[], versionLine: number): void {
  let depth = 0
  let opened = false
  for (let i = versionLine; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim()
    lines[i] = ''
    if (/^Begin(?:Property)?\b/i.test(t)) { depth++; opened = true }
    else if (/^End(?:Property)?\s*$/i.test(t)) depth--
    if (opened && depth <= 0) return
  }
}

/** The 1-based line a doc comment must sit directly above: `lineStart`, moved up past attribute-only lines (`<TestMethod>`, `<Obsolete("x")> _`), since `'''` goes above a declaration's attributes. */
function docAnchorLine(rawLines: readonly string[], lineStart: number): number {
  let line = lineStart
  while (line > 1 && ATTRIBUTE_ONLY_LINE_RE.test(rawLines[line - 2] ?? '')) line--
  return line
}

function firstNonBlankLine(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) if ((lines[i] ?? '').trim() !== '') return i
  return -1
}

/** Builds the statement list: strips comments and strings, joins continuations, splits on `:`, drops attribute-only statements, directives, and VB6 `Attribute` lines. */
function buildStatements(lines: readonly string[]): Statement[] {
  const out: Statement[] = []
  let i = 0
  while (i < lines.length) {
    const lineStart = i + 1
    let code = stripLine(lines[i] ?? '')
    let depth = parenDelta(code)
    let joined = 0
    // Explicit ` _` continuation (the underscore must follow whitespace and end the line; VB 16 allows a comment after it, already stripped here), then implicit continuation while a parenthesis is open.
    for (;;) {
      const trimmed = code.trimEnd()
      const explicit = /(?:^|\s)_$/.test(trimmed)
      const implicit = depth > 0 && joined < MAX_PAREN_JOIN_LINES
      if ((!explicit && !implicit) || i + 1 >= lines.length) {
        if (explicit) code = trimmed.slice(0, -1)
        break
      }
      i++
      joined++
      const next = stripLine(lines[i] ?? '')
      depth += parenDelta(next)
      code = (explicit ? trimmed.slice(0, -1) : trimmed) + ' ' + next.trim()
    }
    const lineEnd = i + 1
    i++
    for (const part of splitStatements(code)) {
      const stmt = stripAttributes(part).trim()
      if (stmt === '' || stmt.startsWith('#') || ATTRIBUTE_LINE_RE.test(stmt)) continue
      out.push({ code: stmt, lineStart, lineEnd })
    }
  }
  return out
}

export function extractVb(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  // NUL bytes mean a binary file that happens to carry a VB extension (a MySQL `.frm` table definition is the common one): nothing in it is VB source.
  if (content.includes('\0')) return { symbols, imports }

  const rawLines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/)
  const lines = rawLines.slice()
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const first = firstNonBlankLine(lines)
  const hasVb6Header = first >= 0 && /^VERSION\s+\d+\.\d+/i.test((lines[first] ?? '').trim())
  // A `.frm` without the VB6 `VERSION 5.00` header is not a VB6 form, so nothing in it is indexed.
  if (ext === '.frm' && !hasVb6Header) return { symbols, imports }
  if (hasVb6Header) blankVb6Header(lines, first)

  const statements = buildStatements(lines)
  const stack: Frame[] = []

  const nearestNamed = (): Frame | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) if (!stack[k]!.isBlock) return stack[k]
    return undefined
  }
  const insideProcedure = (): boolean => stack.some((f) => f.isBlock || PROCEDURE_KINDS.has(f.kind))

  const emit = (name: string, kind: string, stmt: Statement): number | undefined => {
    if (!name || symbols.length >= MAX_SYMBOLS) return undefined
    const parent = nearestNamed()?.name
    const sym = makeLineSymbol(filePath, name, kind, stmt.lineStart, rawLines.slice(stmt.lineStart - 1, stmt.lineEnd).join('\n'), parent)
    symbols.push({ ...sym, lineEnd: stmt.lineEnd, docstring: precedingDocComment(rawLines, docAnchorLine(rawLines, stmt.lineStart), 'vb') })
    return symbols.length - 1
  }
  const open = (kind: FrameKind, name: string, symbolKind: string, stmt: Statement): void => {
    const symbolIndex = emit(name, symbolKind, stmt)
    stack.push(symbolIndex === undefined ? { kind, name, isBlock: false } : { kind, name, isBlock: false, symbolIndex })
  }
  const procedureKind = (): string => {
    const owner = nearestNamed()
    return owner !== undefined && TYPE_KINDS.has(owner.kind) ? 'method' : 'function'
  }

  for (let s = 0; s < statements.length; s++) {
    const stmt = statements[s]!
    const code = stmt.code

    const end = END_RE.exec(code)
    if (end) {
      const kind = end[1]!.toLowerCase() as FrameKind
      let at = -1
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.kind === kind) { at = k; break }
      if (at < 0) continue
      const popped = stack[at]!
      stack.length = at
      if (popped.symbolIndex !== undefined) {
        const sym = symbols[popped.symbolIndex]!
        if (stmt.lineEnd > sym.lineEnd) {
          symbols[popped.symbolIndex] = { ...sym, lineEnd: stmt.lineEnd, body: rawLines.slice(sym.lineStart - 1, stmt.lineEnd).join('\n') }
        }
      }
      continue
    }

    const top = stack[stack.length - 1]
    if (top !== undefined && !top.isBlock && top.kind === 'enum') {
      const em = ENUM_MEMBER_RE.exec(code)
      if (em) emit(cleanName(em[1]!), 'const', stmt)
      continue
    }
    if (top !== undefined && !top.isBlock && top.kind === 'type') {
      const tm = TYPE_MEMBER_RE.exec(code)
      if (tm) emit(cleanName(tm[1]!), 'field', stmt)
      continue
    }

    const modMatch = MODIFIERS_RE.exec(code)
    const modifiers = new Set((modMatch?.[0] ?? '').toLowerCase().split(/\s+/).filter(Boolean))
    const rest = code.slice(modMatch?.[0].length ?? 0)
    const inInterface = nearestNamed()?.kind === 'interface'

    let m: RegExpExecArray | null
    if (modifiers.size === 0 && (m = IMPORTS_RE.exec(rest)) !== null) {
      for (const part of splitTopLevelCommas(m[1]!)) {
        const clause = part.trim()
        if (clause === '' || clause.startsWith('<')) continue
        const alias = /^[A-Za-z_]\w*\s*=\s*(\S.*)$/.exec(clause)
        imports.push({ kind: 'import', target: (alias?.[1] ?? clause).trim(), line: stmt.lineStart })
      }
      continue
    }
    if ((m = NAMESPACE_RE.exec(rest)) !== null) { open('namespace', m[1]!, 'namespace', stmt); continue }
    if ((m = CONTAINER_RE.exec(rest)) !== null) {
      const keyword = m[1]!.toLowerCase() as FrameKind
      const symbolKind = keyword === 'structure' ? 'struct' : keyword
      open(keyword, cleanName(m[2]!), symbolKind, stmt)
      continue
    }
    if ((m = DELEGATE_RE.exec(rest)) !== null) { emit(cleanName(m[1]!), 'type', stmt); continue }
    if ((m = DECLARE_RE.exec(rest)) !== null) { emit(cleanName(m[1]!), 'function', stmt); continue }
    if ((m = VB6_PROPERTY_RE.exec(rest)) !== null) { open('property', cleanName(m[1]!), 'property', stmt); continue }
    if ((m = PROPERTY_RE.exec(rest)) !== null) {
      const name = cleanName(m[1]!)
      const next = statements[s + 1]
      const isBlock = !inInterface && !modifiers.has('mustoverride') && next !== undefined && ACCESSOR_RE.test(next.code)
      if (isBlock) open('property', name, 'property', stmt)
      else emit(name, 'property', stmt)
      continue
    }
    if ((m = PROCEDURE_RE.exec(rest)) !== null) {
      const keyword = m[1]!.toLowerCase() as 'sub' | 'function'
      const name = cleanName(m[2]!)
      if (inInterface || modifiers.has('mustoverride')) emit(name, procedureKind(), stmt)
      else open(keyword, name, procedureKind(), stmt)
      continue
    }
    if ((m = OPERATOR_RE.exec(rest)) !== null) { open('operator', m[1]!, 'method', stmt); continue }
    if ((m = EVENT_RE.exec(rest)) !== null) {
      const name = cleanName(m[1]!)
      if (modifiers.has('custom') && !inInterface) open('event', name, 'event', stmt)
      else emit(name, 'event', stmt)
      continue
    }

    if (!insideProcedure()) {
      if ((m = VB6_TYPE_RE.exec(rest)) !== null) { open('type', cleanName(m[1]!), 'struct', stmt); continue }
      if ((m = CONST_RE.exec(rest)) !== null) {
        for (const name of declaratorNames(m[1]!)) emit(name, 'const', stmt)
        continue
      }
      if ((m = DIM_RE.exec(rest)) !== null) {
        for (const name of declaratorNames(m[1]!)) emit(name, 'field', stmt)
        continue
      }
      // A field needs at least one modifier (`Private x As Integer`, `Friend WithEvents btn As Button`): without one, a type-level statement is `Inherits`/`Implements`/`Option`, and a script-level one is executable code.
      if (modifiers.size > 0 && FIELD_AFTER_MODIFIERS_RE.test(rest) && !/^(?:Sub|Function|Property|Event|Operator|Class|Module|Structure|Interface|Enum|Namespace|Delegate|Declare|Type|Const|Dim)\b/i.test(rest)) {
        for (const name of declaratorNames(rest)) emit(name, 'field', stmt)
        continue
      }
      continue
    }

    const lambda = opensMultilineLambda(code)
    if (lambda !== null) stack.push({ kind: lambda, name: '', isBlock: true })
  }

  return { symbols, imports }
}
