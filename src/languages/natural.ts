/**
 * Software AG Natural adapter: the object itself (named by its file stem, kind by extension),
 * inline `DEFINE SUBROUTINE` blocks, the `DEFINE DATA` block and its level-1 fields (also the
 * level-1 fields of a data area), `USING`/`INCLUDE` imports, and `PERFORM`/`CALLNAT`/`FETCH`
 * references.
 *
 * Object types by extension: https://bluinsights.aws/docs/codebase-dependencies-languages-natural/
 * Comments: a line starting `* ` or `**` (or a lone `*`), or `/*`; ` /*` ends a line's code
 * (https://documentation.softwareag.com/naturalONE/natONE912/natov/pg/pg_furth_ucom.htm). A NaturalONE
 * source header is a run of `*` lines, so it is dropped as comments. DEFINE SUBROUTINE ends at
 * END-SUBROUTINE in structured mode (https://documentation.softwareag.com/natural/nat912win/sm/definesu.htm).
 */

import * as path from 'node:path'

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import type { AdapterImport } from './common.js'

const MAX_SYMBOLS = 10_000

const OBJECT_KINDS: ReadonlyMap<string, string> = new Map([
  ['.nsp', 'program'],
  ['.nsn', 'subprogram'],
  ['.nss', 'subroutine'],
  ['.nsh', 'helproutine'],
  ['.nsc', 'copycode'],
  ['.nsa', 'data_area'],
  ['.nsl', 'data_area'],
  ['.nsg', 'data_area'],
])
const DATA_AREA_EXTS: ReadonlySet<string> = new Set(['.nsa', '.nsl', '.nsg'])

const NAME = String.raw`[A-Za-z#&@$_][A-Za-z0-9#&@$_-]*`
const DEFINE_SUBROUTINE_RE = new RegExp(String.raw`^DEFINE\s+(?:SUBROUTINE\s+)?(${NAME})\s*$|^DEFINE\s+SUBROUTINE\s+(${NAME})\b`, 'i')
const NOT_A_SUBROUTINE = /^(?:DATA|WINDOW|PRINTER|WORK|CLASS|PROTOTYPE|FUNCTION|SUBROUTINE)$/i
const DEFINE_DATA_RE = /^DEFINE\s+DATA\b/i
const END_DEFINE_RE = /^END-DEFINE\b/i
const END_SUBROUTINE_RE = /^END-SUBROUTINE\b/i
const LEVEL_ONE_RE = new RegExp(String.raw`^0?1\s+(${NAME})(?:\s+VIEW\s+(?:OF\s+)?(${NAME}))?`, 'i')
const USING_RE = new RegExp(String.raw`\b(?:LOCAL|PARAMETER|GLOBAL|CONTEXT|OBJECT)\s+USING\s+(${NAME})`, 'gi')
const INCLUDE_RE = new RegExp(String.raw`^INCLUDE\s+(${NAME})`, 'i')
// Four-digit line numbers followed by a space, as in a source listing export.
const LINE_NUMBER_RE = /^\d{4}(?: |$)/

interface NaturalLine {
  readonly line: number
  readonly text: string
  /** `text` with string literal contents blanked, so keyword scans never match inside a literal. */
  readonly code: string
  readonly offset: number
  readonly raw: string
}

function isCommentLine(text: string): boolean {
  return /^(?:\*(?:[ *]|$)|\/\*)/.test(text)
}

/** Split off a ` /*` end-of-line comment that is outside a string literal, and blank string contents. */
function codeOf(text: string): { text: string; code: string } {
  let quote = ''
  let code = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) {
        quote = ''
        code += ch
      } else code += ' '
      continue
    }
    if (ch === '/' && text[i + 1] === '*' && (i === 0 || text[i - 1] === ' ')) return { text: text.slice(0, i).trimEnd(), code: code.trimEnd() }
    if (ch === "'" || ch === '"') quote = ch
    code += ch
  }
  return { text, code }
}

function toLines(rawLines: readonly string[]): NaturalLine[] {
  const nonBlank = rawLines.filter((l) => l.trim() !== '')
  const numbered = nonBlank.length > 0 && nonBlank.filter((l) => LINE_NUMBER_RE.test(l)).length / nonBlank.length >= 0.8
  const out: NaturalLine[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    let offset = numbered && LINE_NUMBER_RE.test(raw) ? 5 : 0
    const body = raw.slice(offset)
    const lead = body.length - body.trimStart().length
    offset += lead
    const trimmed = body.trim()
    if (trimmed === '' || isCommentLine(trimmed)) continue
    const { text, code } = codeOf(trimmed)
    if (text === '') continue
    out.push({ line: i + 1, text, code, offset, raw })
  }
  return out
}

/** The object or subprogram name in a literal (`'NAME'`) at `index` of `text`, as CALLNAT and FETCH name them. */
function literalAt(text: string, index: number): string | undefined {
  const m = /^(['"])([^'"]+)\1/.exec(text.slice(index))
  return m ? m[2]!.trim() : undefined
}

export function extractNatural(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; refs: RefEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []
  const imports: AdapterImport[] = []
  if (content.includes('\0')) return { symbols, refs, imports }

  const rawLines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/)
  const lines = toLines(rawLines)
  const ext = path.extname(filePath).toLowerCase()
  const objectName = path.basename(filePath, path.extname(filePath))
  const isDataArea = DATA_AREA_EXTS.has(ext)

  const emit = (name: string, kind: string, line: number, parent: string): number | undefined => {
    if (symbols.length >= MAX_SYMBOLS) return undefined
    symbols.push({ filePath, name, kind, lineStart: line, lineEnd: line, body: '', docstring: '', parent })
    return symbols.length - 1
  }
  const close = (index: number | undefined, end: number): void => {
    if (index === undefined) return
    const sym = symbols[index]!
    symbols[index] = { ...sym, lineEnd: Math.max(sym.lineStart, end) }
  }

  const lastLine = lines.length > 0 ? lines[lines.length - 1]!.line : 1
  const objectKind = OBJECT_KINDS.get(ext)
  if (objectKind !== undefined && lines.length > 0) {
    const index = emit(objectName, objectKind, lines[0]!.line, '')
    close(index, lastLine)
  }

  let inData = isDataArea
  let dataBlock: number | undefined
  let field: number | undefined
  let subroutine: number | undefined
  let previous = 0

  for (const l of lines) {
    const code = l.code.trim()
    if (DEFINE_DATA_RE.test(code)) {
      inData = true
      dataBlock = emit('DEFINE DATA', 'data', l.line, objectName)
    } else if (inData && END_DEFINE_RE.test(code)) {
      close(field, previous)
      field = undefined
      close(dataBlock, l.line)
      dataBlock = undefined
      inData = false
    } else if (inData) {
      for (const m of l.code.matchAll(USING_RE)) imports.push({ kind: 'import', target: m[1]!, line: l.line })
      const m = LEVEL_ONE_RE.exec(code)
      if (m) {
        close(field, previous)
        field = emit(m[1]!, m[2] !== undefined ? 'view' : 'variable', l.line, objectName)
      } else if (/^(?:LOCAL|PARAMETER|GLOBAL|INDEPENDENT|CONTEXT|OBJECT)\b/i.test(code)) {
        close(field, previous)
        field = undefined
      }
    } else {
      const def = DEFINE_SUBROUTINE_RE.exec(code)
      const name = def ? (def[1] ?? def[2]) : undefined
      if (name !== undefined && !NOT_A_SUBROUTINE.test(name)) {
        // Reporting mode has no END-SUBROUTINE: a new DEFINE closes the previous one.
        close(subroutine, previous)
        subroutine = emit(name, 'subroutine', l.line, objectName)
      } else if (END_SUBROUTINE_RE.test(code)) {
        close(subroutine, l.line)
        subroutine = undefined
      } else if (/^END\s*\.?$/i.test(code)) {
        close(subroutine, previous)
        subroutine = undefined
      }
      const include = INCLUDE_RE.exec(code)
      if (include) imports.push({ kind: 'import', target: include[1]!, line: l.line })
      for (const m of l.code.matchAll(new RegExp(String.raw`\bPERFORM\s+(${NAME})`, 'gi'))) {
        refs.push({ filePath, name: m[1]!, line: l.line, col: l.offset + m.index, context: l.raw.trim() })
      }
      for (const m of l.code.matchAll(/\b(?:CALLNAT|FETCH(?:\s+(?:RETURN|REPEAT))*)\s+(?=['"])/gi)) {
        const name = literalAt(l.text, m.index + m[0].length)
        if (name !== undefined) refs.push({ filePath, name, line: l.line, col: l.offset + m.index, context: l.raw.trim() })
      }
    }
    previous = l.line
  }
  close(field, previous)
  close(dataBlock, previous)
  close(subroutine, previous)

  for (let k = 0; k < symbols.length; k++) {
    const sym = symbols[k]!
    symbols[k] = { ...sym, body: rawLines.slice(sym.lineStart - 1, sym.lineEnd).join('\n') }
  }
  return { symbols, refs, imports }
}
