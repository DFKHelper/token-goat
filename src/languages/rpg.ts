/**
 * ILE RPG adapter. Free form: DCL-PROC procedures to END-PROC, BEGSR subroutines to ENDSR (under their procedure), DCL-PR
 * prototypes and DCL-DS data structures to their END-PR/END-DS (or the one statement when there is none), and top-level
 * DCL-S, DCL-C and DCL-F declarations. Fixed form: P specifications (B in position 24 opens a procedure, E closes it) and
 * C-specification BEGSR/ENDSR. A `**FREE` first line makes every column code; otherwise columns 1-5 are a sequence area,
 * position 6 names a fixed-form specification, a `*` in position 7 comments the line, and free-form code sits in columns
 * 8-80. `//` comments, quoted strings, compiler directives and compile-time data never produce symbols. Keywords are
 * case-insensitive. Imports are /COPY and /INCLUDE members and EXEC SQL INCLUDE.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

const FIXED_SPECS = 'HFDICOP'
const COMPILE_TIME_DATA_RE = /^\*\*(?:\s|$|CTDATA\b|FTRANS\b|ALTSEQ\b)/i
const DIRECTIVE_RE = /^\/(?:COPY|INCLUDE)\s+(\S+)/i
const NAME_RE = /^[A-Za-z@#$_*][\w@#$]*/

/** Blank string contents and drop a `//` comment. */
function codeOf(text: string): string {
  let out = ''
  let quote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === "'" && text[i + 1] === "'") {
        out += '  '
        i++
      } else if (ch === "'") {
        quote = false
        out += ch
      } else out += ' '
      continue
    }
    if (ch === '/' && text[i + 1] === '/') break
    if (ch === "'") quote = true
    out += ch
  }
  return out
}

interface Open {
  /** The END-x keyword (or ENDSR) that closes this block. */
  readonly end: string
  readonly index: number | undefined
}

export function extractRpg(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  const fullyFree = /^\*\*FREE\b/i.test(rawLines[0] ?? '')
  const stack: Open[] = []
  let proc: number | undefined
  let longName = ''
  let text = ''
  let start = 0
  let previous = 0

  const closeTo = (end: string, line: number): void => {
    const at = stack.map((o) => o.end).lastIndexOf(end)
    if (at < 0) return
    for (const o of stack.splice(at)) spans.close(o.index, line)
  }
  const openProc = (name: string, line: number): void => {
    closeTo('END-PROC', previous)
    proc = spans.open(name, 'procedure', line)
    stack.push({ end: 'END-PROC', index: proc })
  }
  const endProc = (line: number): void => {
    closeTo('END-PROC', line)
    proc = undefined
  }
  const inProc = (): boolean => stack.some((o) => o.end === 'END-PROC')

  const statement = (t: string, line: number, endLine: number): void => {
    const words = t.split(/\s+/)
    const w0 = words[0]!.toUpperCase()
    const name = NAME_RE.exec(words[1] ?? '')?.[0] ?? ''
    const upper = words.map((w) => w.toUpperCase())
    if (w0 === 'DCL-PROC') openProc(name, line)
    else if (w0 === 'END-PROC') endProc(endLine)
    else if (w0 === 'BEGSR') stack.push({ end: 'ENDSR', index: spans.open(name, 'subroutine', line, spans.name(proc)) })
    else if (w0 === 'ENDSR') closeTo('ENDSR', endLine)
    else if (w0 === 'DCL-PR' || w0 === 'DCL-DS' || w0 === 'DCL-PI') {
      const end = `END-${w0.slice(4)}`
      // One statement when END-x is on it, or for a data structure defined LIKEDS/LIKEREC, which takes no subfields.
      const single = upper.includes(end) || (w0 === 'DCL-DS' && upper.some((w) => w.startsWith('LIKEDS') || w.startsWith('LIKEREC')))
      const emit = w0 === 'DCL-PR' || (w0 === 'DCL-DS' && !inProc())
      const index = emit && name !== '*N' ? spans.open(name, w0 === 'DCL-PR' ? 'prototype' : 'data_structure', line, '') : undefined
      if (single) spans.close(index, endLine)
      else stack.push({ end, index })
    } else if (w0 === 'END-PR' || w0 === 'END-DS' || w0 === 'END-PI') closeTo(w0, endLine)
    else if ((w0 === 'DCL-S' || w0 === 'DCL-C' || w0 === 'DCL-F') && !inProc()) {
      spans.close(spans.open(name, w0 === 'DCL-S' ? 'variable' : w0 === 'DCL-C' ? 'constant' : 'file', line), endLine)
    } else if (w0 === 'EXEC' && upper[1] === 'SQL' && upper[2] === 'INCLUDE' && words[3] !== undefined) {
      imports.push({ kind: 'include', target: words[3].replace(/^['"]|['"]$/g, ''), line })
    }
  }

  const fixed = (raw: string, line: number): void => {
    const spec = raw[5]!.toUpperCase()
    if (spec === 'P') {
      const field = raw.slice(6, 21).trim()
      if (field.endsWith('...')) {
        longName += field.slice(0, -3)
        return
      }
      const name = longName + field
      longName = ''
      const be = raw.slice(23, 24).toUpperCase()
      if (be === 'B') openProc(name, line)
      else if (be === 'E') endProc(line)
    } else if (spec === 'C') {
      const opcode = raw.slice(25, 35).trim().toUpperCase().replace(/\(.*$/, '')
      if (opcode === 'BEGSR') stack.push({ end: 'ENDSR', index: spans.open(raw.slice(11, 25).trim(), 'subroutine', line, spans.name(proc)) })
      else if (opcode === 'ENDSR') closeTo('ENDSR', line)
    }
  }

  for (let i = fullyFree ? 1 : 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    const line = i + 1
    let code: string
    if (fullyFree) {
      if (COMPILE_TIME_DATA_RE.test(raw)) break
      code = raw
    } else {
      if (COMPILE_TIME_DATA_RE.test(raw)) break
      if (raw.length < 7 || raw[6] === '*') continue
      if (FIXED_SPECS.includes(raw[5]!.toUpperCase())) {
        fixed(raw, line)
        previous = line
        continue
      }
      code = raw.slice(7, 80)
    }
    const trimmed = code.trimStart()
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      const d = DIRECTIVE_RE.exec(trimmed)
      if (d) imports.push({ kind: 'include', target: d[1]!.replace(/^['"]|['"]$/g, ''), line })
      continue
    }
    const c = codeOf(code)
    let from = 0
    for (let k = c.indexOf(';'); k >= 0; k = c.indexOf(';', from)) {
      const part = c.slice(from, k)
      if (start === 0 && part.trim() !== '') start = line
      text += part
      const t = text.trim()
      if (t !== '') statement(t, start, line)
      text = ''
      start = 0
      from = k + 1
      previous = line
    }
    const tail = c.slice(from)
    if (start === 0 && tail.trim() !== '') start = line
    text += `${tail} `
  }
  for (const o of stack) spans.close(o.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}
