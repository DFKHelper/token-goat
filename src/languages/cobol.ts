/**
 * COBOL adapter: programs, procedure-division sections and paragraphs, level-01/77 data items and
 * FD/SD file descriptions, `COPY` imports, and `PERFORM`/`GO TO`/`CALL 'x'` references.
 *
 * Reference format (IBM Enterprise COBOL for z/OS, https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=structure-reference-format):
 * columns 1-6 are the sequence number area, column 7 the indicator area, 8-11 Area A, 12-72 Area B,
 * and 73-80 are ignored. Indicator `*` or `/` makes a comment line, `D`/`d` a debugging line, `-` a
 * continuation line (https://www.ibm.com/docs/en/cobol-zos/6.4.0?topic=format-indicator-area); `*>`
 * starts a floating comment. Free format (`>>SOURCE FORMAT IS FREE`, the ISO 2002 directive) has no
 * columns: text starts at column 1 and only `*>` comments.
 */

import type { RefEntry, SymbolEntry } from '../parser_types.js'
import type { AdapterImport } from './common.js'

const MAX_SYMBOLS = 10_000

/** One source line reduced to its program text: comment lines dropped, strings blanked in `code`. */
interface CobolLine {
  readonly line: number
  /** Program text with comments removed; string literal contents kept. */
  readonly text: string
  /** `text` with string literal contents replaced by spaces, so keyword scans never match inside a literal. */
  readonly code: string
  /** Column offset of `text[0]` in the raw line, for reference columns. */
  readonly offset: number
  /** True when the text begins in Area A (fixed format) or the line is free format, where there are no areas. */
  readonly areaA: boolean
  readonly raw: string
}

const NAME = String.raw`[A-Za-z0-9][A-Za-z0-9_-]*`
const SOURCE_DIRECTIVE_RE = /^\s*>>\s*SOURCE\s+(?:FORMAT\s+)?(?:IS\s+)?(FREE|FIXED)\b/i
const DIVISION_RE = /^(IDENTIFICATION|ID|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\b/i
const ID_PARAGRAPH_RE = /^(PROGRAM|FUNCTION)-ID\b/i
const END_UNIT_RE = new RegExp(String.raw`^END\s+(PROGRAM|FUNCTION)\s+(?:"([^"]+)"|'([^']+)'|(${NAME}))`, 'i')
const SECTION_RE = new RegExp(String.raw`^(${NAME})\s+SECTION(?:\s+\d+)?\s*\.`, 'i')
const PARAGRAPH_RE = new RegExp(String.raw`^(${NAME})\s*\.(?:\s|$)`)
const LEVEL_RE = new RegExp(String.raw`^(\d{1,2})\s+(${NAME})(?=[\s.]|$)`)
const FILE_DESCRIPTION_RE = new RegExp(String.raw`^(FD|SD)\s+(${NAME})`, 'i')
// Single-word statements and compiler-directing words that can stand alone with a period; none can be a paragraph name, since paragraph names may not be reserved words.
const NOT_A_PARAGRAPH = /^(?:EXIT|GOBACK|CONTINUE|ELSE|EJECT|SKIP[123]|DECLARATIVES|END-[A-Z-]+)$/i
const PERFORM_NOT_A_TARGET = /^(?:UNTIL|VARYING|WITH|TEST|FOREVER|TIMES)$/i

/** Free format when a `>>SOURCE` directive says so first, or when a division header or `*>` comment starts in column 1, which fixed format reserves for sequence numbers. */
function startsFree(rawLines: readonly string[]): boolean {
  for (const raw of rawLines) {
    const directive = SOURCE_DIRECTIVE_RE.exec(raw)
    if (directive) return directive[1]!.toUpperCase() === 'FREE'
    if (DIVISION_RE.test(raw) || raw.startsWith('*>')) return true
  }
  return false
}

/** Cut a `*>` floating comment that is outside a string literal. */
function stripFloatingComment(text: string): string {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '*' && text[i + 1] === '>') return text.slice(0, i)
  }
  return text
}

/** Replace the inside of each string literal with spaces, keeping the quotes and every offset. */
function blankStrings(text: string): string {
  let out = ''
  let quote = ''
  for (const ch of text) {
    if (quote !== '') {
      if (ch === quote) {
        quote = ''
        out += ch
      } else out += ' '
    } else {
      if (ch === '"' || ch === "'") quote = ch
      out += ch
    }
  }
  return out
}

function toLines(rawLines: readonly string[]): CobolLine[] {
  const out: CobolLine[] = []
  let free = startsFree(rawLines)
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    const directive = SOURCE_DIRECTIVE_RE.exec(free ? raw : raw.slice(7))
    if (directive) {
      free = directive[1]!.toUpperCase() === 'FREE'
      continue
    }
    let text: string
    let offset: number
    let areaA: boolean
    if (free) {
      if (/^\s*>>/.test(raw)) continue
      text = raw
      offset = 0
      areaA = true
    } else {
      if (raw.length <= 7) continue
      const indicator = raw[6]!
      // Comment, debugging, and continuation lines: none opens a declaration, and a continuation only carries the rest of a word or literal.
      if (indicator === '*' || indicator === '/' || indicator === 'D' || indicator === 'd' || indicator === '-') continue
      text = raw.slice(7, 72)
      offset = 7
      areaA = text.slice(0, 4).trim() !== ''
    }
    text = stripFloatingComment(text).trimEnd()
    if (text.trim() === '') continue
    const lead = text.length - text.trimStart().length
    out.push({ line: i + 1, text: text.trimStart(), code: blankStrings(text.trimStart()), offset: offset + lead, areaA, raw })
  }
  return out
}

/** The name after `PROGRAM-ID.`: a word or a quoted literal, optionally on the next line. */
function unitName(rest: string, next: CobolLine | undefined): string | undefined {
  const source = rest.trim() !== '' ? rest : (next?.text ?? '')
  const m = new RegExp(String.raw`^(?:"([^"]+)"|'([^']+)'|(${NAME}))`).exec(source.trim())
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** The copy member named at `index` in `text` (`COPY name`, `COPY 'name'`, optional `OF|IN library`). */
function copyTarget(text: string, index: number): string | undefined {
  const m = new RegExp(String.raw`^COPY\s+(?:"([^"]+)"|'([^']+)'|(${NAME}))`, 'i').exec(text.slice(index))
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

export function extractCobol(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; refs: RefEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []
  const imports: AdapterImport[] = []
  if (content.includes('\0')) return { symbols, refs, imports }

  const rawLines = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).split(/\r?\n/)
  const lines = toLines(rawLines)
  const isCopybook = /\.cpy$/i.test(filePath)

  // Open declarations, each closed at the last program line before whatever ends it.
  const units: number[] = []
  let section: number | undefined
  let paragraph: number | undefined
  let fileDescription: number | undefined
  let record: number | undefined
  let division = ''
  let lastLine = 0
  let idDivisionLine: number | undefined

  // A copybook with no division header is a fragment: data items when it opens with a level number, procedure text otherwise; its record level is the lowest level it uses.
  let recordLevel = 1
  if (isCopybook && !lines.some((l) => DIVISION_RE.test(l.code))) {
    const levels = lines.map((l) => LEVEL_RE.exec(l.code)).filter((m) => m !== null).map((m) => Number(m[1]))
    const first = lines[0]
    division = first !== undefined && LEVEL_RE.test(first.code) ? 'DATA' : 'PROCEDURE'
    const structural = levels.filter((n) => n >= 1 && n <= 49)
    if (structural.length > 0) recordLevel = Math.min(...structural)
  }

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
  const unitParent = (): string => {
    const top = units[units.length - 1]
    return top === undefined ? '' : symbols[top]!.name
  }
  const closeProcedure = (end: number): void => {
    close(paragraph, end)
    paragraph = undefined
    close(section, end)
    section = undefined
  }
  const closeData = (end: number): void => {
    close(record, end)
    record = undefined
    close(fileDescription, end)
    fileDescription = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const code = l.code.trim()

    for (const m of l.code.matchAll(/\bCOPY\s+/gi)) {
      const target = copyTarget(l.text, m.index)
      if (target !== undefined) imports.push({ kind: 'import', target, line: l.line })
    }
    const include = /\bEXEC\s+SQL\s+INCLUDE\s+([A-Za-z0-9_-]+)/i.exec(l.code)
    if (include) imports.push({ kind: 'import', target: include[1]!, line: l.line })

    const id = ID_PARAGRAPH_RE.exec(code)
    if (id) {
      const name = unitName(l.text.slice(l.text.search(/-ID/i) + 3).replace(/^\s*\.?/, ''), lines[i + 1])
      closeProcedure(lastLine)
      closeData(lastLine)
      if (name !== undefined) {
        // The unit starts at its IDENTIFICATION DIVISION header when that is the program line just before PROGRAM-ID.
        const start = idDivisionLine !== undefined && idDivisionLine === lastLine ? idDivisionLine : l.line
        const index = emit(name, id[1]!.toUpperCase() === 'FUNCTION' ? 'function' : 'program', start, unitParent())
        if (index !== undefined) units.push(index)
      }
      division = 'IDENTIFICATION'
      lastLine = l.line
      continue
    }
    const end = END_UNIT_RE.exec(code)
    if (end) {
      const name = (end[2] ?? end[3] ?? end[4])!.toUpperCase()
      closeProcedure(lastLine)
      closeData(lastLine)
      let at = units.length - 1
      while (at >= 0 && symbols[units[at]!]!.name.toUpperCase() !== name) at--
      if (at >= 0) {
        for (const u of units.splice(at)) close(u, l.line)
      }
      division = ''
      lastLine = l.line
      continue
    }
    const div = DIVISION_RE.exec(code)
    if (div) {
      closeProcedure(lastLine)
      closeData(lastLine)
      division = div[1]!.toUpperCase() === 'ID' ? 'IDENTIFICATION' : div[1]!.toUpperCase()
      if (division === 'IDENTIFICATION') idDivisionLine = l.line
      lastLine = l.line
      continue
    }

    if (division === 'DATA') {
      if (/^[A-Za-z0-9-]+\s+SECTION\s*\./i.test(code)) {
        closeData(lastLine)
      } else if (FILE_DESCRIPTION_RE.test(code)) {
        const m = FILE_DESCRIPTION_RE.exec(code)!
        closeData(lastLine)
        fileDescription = emit(m[2]!, 'file', l.line, unitParent())
      } else {
        const m = LEVEL_RE.exec(code)
        const level = m ? Number(m[1]) : -1
        if (m && (level === recordLevel || level === 77)) {
          close(record, lastLine)
          record = undefined
          if (level === 77) {
            close(fileDescription, lastLine)
            fileDescription = undefined
          }
          if (m[2]!.toUpperCase() !== 'FILLER') {
            const owner = fileDescription !== undefined ? symbols[fileDescription]!.name : unitParent()
            record = emit(m[2]!, 'variable', l.line, owner)
          }
        }
      }
    } else if (division === 'PROCEDURE') {
      const sec = l.areaA ? SECTION_RE.exec(code) : null
      const para = l.areaA && !sec ? PARAGRAPH_RE.exec(code) : null
      if (sec) {
        closeProcedure(lastLine)
        section = emit(sec[1]!, 'section', l.line, unitParent())
      } else if (para && !NOT_A_PARAGRAPH.test(para[1]!)) {
        close(paragraph, lastLine)
        paragraph = emit(para[1]!, 'paragraph', l.line, section !== undefined ? symbols[section]!.name : unitParent())
      }
      for (const m of l.code.matchAll(new RegExp(String.raw`\bPERFORM\s+(${NAME})(?:\s+(?:THRU|THROUGH)\s+(${NAME}))?(\s+TIMES\b)?`, 'gi'))) {
        if (m[3] !== undefined || PERFORM_NOT_A_TARGET.test(m[1]!) || /^\d+$/.test(m[1]!)) continue
        refs.push({ filePath, name: m[1]!, line: l.line, col: l.offset + m.index, context: l.raw.trim() })
        if (m[2] !== undefined) refs.push({ filePath, name: m[2], line: l.line, col: l.offset + m.index, context: l.raw.trim() })
      }
      for (const m of l.code.matchAll(new RegExp(String.raw`\bGO\s+(?:TO\s+)?(${NAME})`, 'gi'))) {
        if (/^DEPENDING$/i.test(m[1]!)) continue
        refs.push({ filePath, name: m[1]!, line: l.line, col: l.offset + m.index, context: l.raw.trim() })
      }
      for (const m of l.code.matchAll(/\bCALL\s+(["'])/gi)) {
        const quote = m.index + m[0].length - 1
        const close = l.text.indexOf(m[1]!, quote + 1)
        const name = close > quote ? l.text.slice(quote + 1, close).trim() : ''
        if (name !== '') refs.push({ filePath, name, line: l.line, col: l.offset + m.index, context: l.raw.trim() })
      }
    }
    lastLine = l.line
  }

  closeProcedure(lastLine)
  closeData(lastLine)
  for (const u of units) close(u, lastLine)
  for (let k = 0; k < symbols.length; k++) {
    const sym = symbols[k]!
    symbols[k] = { ...sym, body: rawLines.slice(sym.lineStart - 1, sym.lineEnd).join('\n') }
  }
  return { symbols, refs, imports }
}
