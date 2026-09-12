/**
 * Fortran adapter: PROGRAM, MODULE, SUBMODULE, SUBROUTINE, FUNCTION, separate MODULE PROCEDURE and BLOCK DATA units, derived
 * TYPE definitions and named INTERFACE blocks, with the unit or type that contains each as its parent. Only the END of a unit,
 * type or interface closes a symbol: END IF, END DO, END SELECT and the other construct ends are recognized and skipped, so a
 * labeled `DO 10 ... 10 CONTINUE` loop, which has no END DO, cannot unbalance the stack. A bare END closes the innermost unit.
 * `.f`, `.for` and `.f77` are read as fixed form (a `C`, `c`, `*` or `!` in column 1 marks a comment line, a character in column 6
 * continues the previous line, text stops at column 72) unless a line starts in column 1 with code, which only free form allows;
 * the other extensions are free form (`!` comments, `&` continuation, `;` separators). Keywords are case-insensitive; strings
 * and comments never produce symbols. Imports are USE modules, INCLUDE files and `#include` lines.
 */

import * as path from 'node:path'

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  /** The statement with comments removed and string contents blanked. */
  readonly text: string
  /** The statement with comments removed and strings kept, for INCLUDE targets. */
  readonly raw: string
  readonly line: number
  readonly endLine: number
}

const FIXED_FORM_EXTENSIONS: ReadonlySet<string> = new Set(['.f', '.for', '.f77'])
// Fixed form ignores everything after column 72 (the old sequence-number field).
const FIXED_TEXT_END = 72

/** Appends `ch` to both statement buffers, blanking it in the masked one when it sits inside a string. */
class Buffers {
  text = ''
  raw = ''
  add(ch: string, inString: boolean): void {
    this.raw += ch
    this.text += inString ? ' ' : ch
  }
}

/** Scans `body` for strings and a `!` comment, appending code to `buf`; returns the open quote at the end of the line. */
function scanCode(body: string, buf: Buffers, quote: string, onSemicolon: (() => void) | null): string {
  for (let j = 0; j < body.length; j++) {
    const ch = body[j]!
    if (quote !== '') {
      if (ch === quote) {
        if (body[j + 1] === quote) {
          buf.add(ch, true)
          buf.add(ch, true)
          j++
          continue
        }
        quote = ''
        buf.add(ch, false)
        continue
      }
      buf.add(ch, true)
      continue
    }
    if (ch === '!') break
    if (ch === "'" || ch === '"') {
      quote = ch
      buf.add(ch, false)
      continue
    }
    if (ch === ';' && onSemicolon !== null) {
      onSemicolon()
      continue
    }
    buf.add(ch, false)
  }
  return quote
}

function preprocessorInclude(line: string, lineNo: number, imports: AdapterImport[]): boolean {
  if (!/^[ \t]*#/.test(line)) return false
  const m = /^[ \t]*#[ \t]*include[ \t]*["<]([^">]+)[">]/.exec(line)
  if (m !== null) imports.push({ kind: 'include', target: m[1]!, line: lineNo })
  return true
}

function freeFormStatements(lines: readonly string[], imports: AdapterImport[]): Statement[] {
  const out: Statement[] = []
  let buf = new Buffers()
  let start = 0
  let end = 0
  let quote = ''
  let continuing = false
  const flush = (): void => {
    if (buf.text.trim() !== '') out.push({ text: buf.text.trim(), raw: buf.raw.trim(), line: start, endLine: end })
    buf = new Buffers()
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    if (!continuing && preprocessorInclude(line, lineNo, imports)) continue
    let body = line
    if (continuing) {
      const first = body.search(/\S/)
      if (first >= 0 && body[first] === '&') body = body.slice(first + 1)
    } else {
      start = lineNo
    }
    const before = buf.text.length
    quote = scanCode(body, buf, quote, () => {
      end = lineNo
      flush()
      start = lineNo
    })
    // Only this line's part is trimmed, so a statement continued over many lines is not rescanned from its start each time.
    const added = buf.text.slice(before)
    const trimmed = added.trimEnd()
    if (trimmed.endsWith('&')) {
      // Both buffers grow by one character per source character, so the mark sits at the same offset from the end of each.
      const cut = added.length - trimmed.length + 1
      buf.text = buf.text.slice(0, buf.text.length - cut)
      buf.raw = buf.raw.slice(0, buf.raw.length - cut)
      continuing = true
      end = lineNo
      continue
    }
    // A comment or blank line between a line and its continuation does not end the statement.
    if (continuing && added.trim() === '') continue
    continuing = false
    quote = ''
    end = lineNo
    flush()
  }
  flush()
  return out
}

function fixedFormStatements(lines: readonly string[], imports: AdapterImport[]): Statement[] {
  const out: Statement[] = []
  let buf = new Buffers()
  let start = 0
  let end = 0
  const flush = (): void => {
    if (buf.text.trim() !== '') out.push({ text: buf.text.trim(), raw: buf.raw.trim(), line: start, endLine: end })
    buf = new Buffers()
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineNo = i + 1
    const c0 = line[0]
    if (c0 === 'C' || c0 === 'c' || c0 === '*' || c0 === '!' || line.trim() === '') continue
    if (preprocessorInclude(line, lineNo, imports)) continue
    let textStart = 6
    let continuation: boolean
    const tab = line.indexOf('\t')
    if (tab >= 0 && tab < 6 && /^[ 0-9]*$/.test(line.slice(0, tab))) {
      // Tab format: the statement starts after the tab, and a digit 1-9 right after it marks a continuation.
      textStart = tab + 1
      continuation = /[1-9]/.test(line[textStart] ?? '')
      if (continuation) textStart++
    } else {
      const label = line.slice(0, 5)
      if (label.includes('!')) continue
      continuation = line.length > 5 && line[5] !== ' ' && line[5] !== '0'
    }
    const body = line.slice(textStart, tab >= 0 && tab < 6 ? undefined : FIXED_TEXT_END)
    if (!continuation) {
      flush()
      start = lineNo
    }
    // A string never continues past the end of a fixed-form line in practice; each line starts outside one.
    scanCode(body, buf, '', () => {
      end = lineNo
      flush()
      start = lineNo
    })
    end = lineNo
  }
  flush()
  return out
}

/** Free-form evidence: code starting in column 1 (which fixed form reserves for labels and comment marks), a `::` declaration, or a trailing `&` continuation. */
function hasFreeFormSignal(line: string): boolean {
  return /^[A-BD-Za-bd-z_&]/.test(line) || line.includes('::') || /&[ \t]*$/.test(line)
}

/** Fixed-form evidence: a column-1 comment mark, or a continuation character in column 6 behind a label field of blanks and digits. */
function hasFixedFormSignal(line: string): boolean {
  const c0 = line[0]
  if (c0 === 'C' || c0 === 'c' || c0 === '*') return true
  // A sequence-number field past column 72 is fixed form's alone: free form has no column limit and nothing to put there.
  if (line.length > 72) return true
  return line.length > 5 && /^[ \d]{5}$/.test(line.slice(0, 5)) && line[5] !== ' ' && line[5] !== '0'
}

/**
 * True for a `.f`, `.for` or `.f77` file that carries positive fixed-form evidence and no free-form signal.
 *
 * "No code in column 1" is not evidence of fixed form: an indented free-form file has none either.
 * Reading one as fixed form makes character 6 of every line a continuation mark, so no statement is
 * ever flushed and the file indexes to zero symbols with no error. Guessing free form for a file
 * that is really fixed form only degrades the result, so the doubt is resolved that way.
 */
function isFixedForm(filePath: string, lines: readonly string[]): boolean {
  if (!FIXED_FORM_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false
  if (lines.some(hasFreeFormSignal)) return false
  return lines.some(hasFixedFormSignal)
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z]/.test(ch)
}

/** Identifiers, `::`, `=>` and single punctuation characters of a masked statement. Linear, no regex backtracking. */
function tokenize(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
      continue
    }
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < s.length && /\w/.test(s[j]!)) j++
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < s.length && /[0-9]/.test(s[j]!)) j++
      out.push(s.slice(i, j))
      i = j
      continue
    }
    if ((ch === ':' && s[i + 1] === ':') || (ch === '=' && s[i + 1] === '>')) {
      out.push(s.slice(i, i + 2))
      i += 2
      continue
    }
    out.push(ch)
    i++
  }
  return out
}

function isIdent(tok: string | undefined): tok is string {
  return tok !== undefined && isIdentStart(tok[0]!)
}

/** Index just past the parenthesized group opening at `k`. */
function skipGroup(toks: readonly string[], k: number): number {
  let depth = 0
  for (; k < toks.length; k++) {
    if (toks[k] === '(') depth++
    else if (toks[k] === ')' && --depth === 0) return k + 1
  }
  return k
}

function hasTopLevelEquals(toks: readonly string[]): boolean {
  let depth = 0
  for (const t of toks) {
    if (t === '(' || t === '[') depth++
    else if (t === ')' || t === ']') depth = Math.max(0, depth - 1)
    else if (t === '=' && depth === 0) return true
  }
  return false
}

const PROCEDURE_PREFIXES: ReadonlySet<string> = new Set(['RECURSIVE', 'NON_RECURSIVE', 'PURE', 'IMPURE', 'ELEMENTAL', 'MODULE'])
const TYPE_SPECS: ReadonlySet<string> = new Set(['INTEGER', 'REAL', 'COMPLEX', 'LOGICAL', 'CHARACTER', 'DOUBLEPRECISION', 'DOUBLECOMPLEX', 'BYTE'])

/** Index past a kind selector after an intrinsic type: `(8)`, `(len=*)`, `*8` or `*(*)`. */
function skipKind(toks: readonly string[], k: number): number {
  if (toks[k] === '(') return skipGroup(toks, k)
  if (toks[k] === '*') return toks[k + 1] === '(' ? skipGroup(toks, k + 1) : k + 2
  return k
}

/** A SUBROUTINE or FUNCTION header after any prefixes and a result type: its keyword and name. */
function procedureHeader(toks: readonly string[]): { kind: 'subroutine' | 'function'; name: string } | null {
  let k = 0
  while (k < toks.length) {
    const u = toks[k]!.toUpperCase()
    if (PROCEDURE_PREFIXES.has(u)) {
      k++
    } else if (u === 'DOUBLE' && /^(?:PRECISION|COMPLEX)$/i.test(toks[k + 1] ?? '')) {
      k = skipKind(toks, k + 2)
    } else if (TYPE_SPECS.has(u)) {
      k = skipKind(toks, k + 1)
    } else if ((u === 'TYPE' || u === 'CLASS') && toks[k + 1] === '(') {
      k = skipGroup(toks, k + 1)
    } else {
      break
    }
  }
  const kw = toks[k]?.toUpperCase()
  if (kw !== 'SUBROUTINE' && kw !== 'FUNCTION') return null
  const name = toks[k + 1]
  const after = toks[k + 2]?.toUpperCase()
  if (!isIdent(name) || (after !== undefined && after !== '(' && after !== 'RESULT' && after !== 'BIND')) return null
  return { kind: kw === 'SUBROUTINE' ? 'subroutine' : 'function', name }
}

/** The name a derived-type definition declares, or null when `toks` is a TYPE(x) declaration, TYPE IS guard or anything else. */
function typeDefinitionName(toks: readonly string[]): string | null {
  if (toks[0]?.toUpperCase() !== 'TYPE') return null
  let k = 1
  if (toks[1] === ',' || toks[1] === '::') {
    k = toks.indexOf('::')
    if (k < 0) return null
    k++
  } else if (toks[1]?.toUpperCase() === 'IS') {
    return null
  }
  const name = toks[k]
  if (!isIdent(name)) return null
  const after = toks[k + 1]
  return after === undefined || after === '(' ? name : null
}

type Role = 'unit' | 'type' | 'interface'

interface Frame {
  readonly index: number | undefined
  readonly kind: string
  readonly role: Role
}

// END <keyword>: the frame kind each closes. Checked in order, so BLOCKDATA wins over a longer name that starts the same.
const END_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['BLOCKDATA', 'block_data'],
  ['SUBMODULE', 'submodule'],
  ['SUBROUTINE', 'subroutine'],
  ['FUNCTION', 'function'],
  ['PROGRAM', 'program'],
  ['MODULE', 'module'],
  ['PROCEDURE', 'procedure'],
  ['INTERFACE', 'interface'],
  ['TYPE', 'type'],
]

export function extractFortran(content: string, filePath: string): StatementAdapterResult {
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports: [] }
  const rawLines = content.split(/\r?\n/)
  const imports: AdapterImport[] = []
  const statements = isFixedForm(filePath, rawLines) ? fixedFormStatements(rawLines, imports) : freeFormStatements(rawLines, imports)
  const stack: Frame[] = []
  let previous = 0

  const parent = (): string => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.index !== undefined) return spans.name(stack[k]!.index)
    return ''
  }
  const inInterface = (): boolean => stack.length > 0 && stack[stack.length - 1]!.role === 'interface'
  const open = (name: string | undefined, kind: string, role: Role, line: number, named = true): void => {
    // An interface body only restates a procedure defined elsewhere, so it is tracked but not listed.
    const index = named && name !== undefined && !inInterface() ? spans.open(name, kind, line, parent()) : undefined
    stack.push({ index, kind, role })
  }
  const closeTo = (match: (f: Frame) => boolean, end: number): void => {
    let k = stack.length - 1
    while (k >= 0 && !match(stack[k]!)) k--
    if (k < 0) return
    while (stack.length > k) spans.close(stack.pop()!.index, end)
  }

  for (const st of statements) {
    let toks = tokenize(st.text)
    // A free-form statement label.
    if (toks.length > 1 && /^[0-9]+$/.test(toks[0]!)) toks = toks.slice(1)
    if (toks.length === 0) continue
    const u0 = toks[0]!.toUpperCase()
    previous = st.endLine
    const compact = toks.join('').toUpperCase()
    if (/^END\w*$/.test(compact)) {
      const rest = compact.slice(3)
      if (rest === '') {
        closeTo((f) => f.role === 'unit', st.endLine)
      } else {
        const hit = END_KINDS.find(([kw]) => rest.startsWith(kw))
        // END BLOCK closes a BLOCK construct, not BLOCK DATA; END IF, END DO and the rest close constructs this adapter does not track.
        if (hit !== undefined && !(hit[0] === 'TYPE' && rest !== 'TYPE' && !isIdent(rest.slice(4)))) closeTo((f) => f.kind === hit[1], st.endLine)
      }
      continue
    }
    if (u0 === 'USE') {
      let k = 1
      if (toks[k] === ',') k += 2
      if (toks[k] === '::') k++
      if (isIdent(toks[k])) imports.push({ kind: 'import', target: toks[k]!, line: st.line })
      continue
    }
    if (u0 === 'INCLUDE') {
      const m = /^include\s*(['"])([^'"]+)\1/i.exec(st.raw)
      if (m !== null) imports.push({ kind: 'include', target: m[2]!, line: st.line })
      continue
    }
    if (hasTopLevelEquals(toks)) continue
    const u1 = toks[1]?.toUpperCase()
    if (u0 === 'PROGRAM' && isIdent(toks[1]) && toks.length === 2) {
      open(toks[1], 'program', 'unit', st.line)
    } else if (u0 === 'MODULE' && u1 === 'PROCEDURE') {
      // Inside an interface block this lists procedures; elsewhere it opens a separate module procedure's body.
      if (!inInterface() && isIdent(toks[2]) && toks.length === 3) open(toks[2], 'procedure', 'unit', st.line)
    } else if (u0 === 'MODULE' && isIdent(toks[1]) && toks.length === 2 && u1 !== 'FUNCTION' && u1 !== 'SUBROUTINE') {
      open(toks[1], 'module', 'unit', st.line)
    } else if (u0 === 'SUBMODULE' && toks[1] === '(') {
      const k = skipGroup(toks, 1)
      if (isIdent(toks[k]) && toks.length === k + 1) open(toks[k], 'submodule', 'unit', st.line)
    } else if ((u0 === 'BLOCK' && u1 === 'DATA') || u0 === 'BLOCKDATA') {
      const name = toks[u0 === 'BLOCK' ? 2 : 1]
      open(name, 'block_data', 'unit', st.line, isIdent(name))
    } else if (u0 === 'INTERFACE' || (u0 === 'ABSTRACT' && u1 === 'INTERFACE')) {
      const named = u0 === 'INTERFACE' && isIdent(toks[1]) && toks.length === 2
      open(toks[1], 'interface', 'interface', st.line, named)
    } else if (u0 === 'TYPE' && typeDefinitionName(toks) !== null) {
      open(typeDefinitionName(toks)!, 'type', 'type', st.line)
    } else {
      // `TYPE(point) FUNCTION make(x)` is a function whose result is a derived type, so it reaches the header check too.
      const header = procedureHeader(toks)
      if (header !== null) open(header.name, header.kind, 'unit', st.line)
    }
  }
  while (stack.length > 0) spans.close(stack.pop()!.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}
