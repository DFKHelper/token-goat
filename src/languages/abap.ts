/**
 * ABAP adapter: the REPORT/PROGRAM/FUNCTION-POOL name, local and global classes (DEFINITION and IMPLEMENTATION, each to its
 * ENDCLASS) with their METHOD blocks as children, interfaces, FORM subroutines, function modules, dialog MODULEs and DEFINE
 * macros. Statements end with a period; a `*` in column 1 comments the line and `"` comments the rest of it; '...', `...`
 * and |...| literals are blanked before any keyword is read. Keywords are case-insensitive. Imports are INCLUDE programs.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  /** Statement text with comments removed and literal contents blanked. */
  readonly text: string
  readonly line: number
  readonly endLine: number
}

function abapStatements(rawLines: readonly string[]): Statement[] {
  const out: Statement[] = []
  let buf = ''
  let start = 0
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    if (raw.startsWith('*')) continue
    let quote = ''
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j]!
      if (quote !== '') {
        if (quote === '|' && ch === '\\') {
          buf += '  '
          j++
        } else if (ch === quote && quote !== '|' && raw[j + 1] === quote) {
          buf += '  '
          j++
        } else if (ch === quote) {
          quote = ''
          buf += ch
        } else buf += ' '
        continue
      }
      if (ch === '"') break
      if (ch === "'" || ch === '`' || ch === '|') quote = ch
      if (ch === '.') {
        if (buf.trim() !== '') out.push({ text: buf.trim(), line: start, endLine: i + 1 })
        buf = ''
        start = 0
        continue
      }
      if (start === 0 && !/\s/.test(ch)) start = i + 1
      // A chain colon (`DATA: a, b.`) separates nothing this adapter reads.
      buf += ch === ':' ? ' ' : ch
    }
    buf += ' '
  }
  return out
}

const CLOSERS: ReadonlyMap<string, string> = new Map([
  ['ENDCLASS', 'CLASS'],
  ['ENDINTERFACE', 'INTERFACE'],
  ['ENDMETHOD', 'METHOD'],
  ['ENDFORM', 'FORM'],
  ['ENDFUNCTION', 'FUNCTION'],
  ['ENDMODULE', 'MODULE'],
  ['END-OF-DEFINITION', 'DEFINE'],
])

const BLOCK_KINDS: ReadonlyMap<string, string> = new Map([
  ['FORM', 'form'],
  ['FUNCTION', 'function'],
  ['MODULE', 'module'],
  ['DEFINE', 'macro'],
])

interface Open {
  readonly opener: string
  readonly index: number | undefined
  /** The class or interface name methods inside this block belong to. */
  readonly owner: string
}

export function extractAbap(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  const statements = abapStatements(rawLines)
  const lastLine = statements.length > 0 ? statements[statements.length - 1]!.endLine : 1
  const stack: Open[] = []
  let program = false

  for (const st of statements) {
    const words = st.text.split(/\s+/)
    const w0 = words[0]!.toUpperCase()
    const name = words[1] ?? ''
    const rest = words.slice(2).map((w) => w.toUpperCase())
    const inMacro = stack.length > 0 && stack[stack.length - 1]!.opener === 'DEFINE'
    const closes = CLOSERS.get(w0)
    if (closes !== undefined) {
      const at = stack.map((o) => o.opener).lastIndexOf(closes)
      if (at < 0) continue
      for (const o of stack.splice(at)) spans.close(o.index, st.endLine)
      continue
    }
    // A macro body is replayed where the macro is used, so nothing inside it declares anything here.
    if (inMacro || name === '') continue
    if (!program && (w0 === 'REPORT' || w0 === 'PROGRAM' || w0 === 'FUNCTION-POOL')) {
      program = true
      spans.close(spans.open(name, 'program', st.line), lastLine)
    } else if (w0 === 'CLASS' && (rest[0] === 'DEFINITION' || rest[0] === 'IMPLEMENTATION')) {
      // DEFERRED, LOAD and LOCAL FRIENDS forms are single statements with no ENDCLASS.
      if (rest.includes('DEFERRED') || rest.includes('LOAD') || (rest.includes('LOCAL') && rest.includes('FRIENDS'))) continue
      const kind = rest[0] === 'DEFINITION' ? 'class' : 'implementation'
      stack.push({ opener: 'CLASS', index: spans.open(name, kind, st.line), owner: name })
    } else if (w0 === 'INTERFACE' && !rest.includes('DEFERRED') && !rest.includes('LOAD')) {
      stack.push({ opener: 'INTERFACE', index: spans.open(name, 'interface', st.line), owner: name })
    } else if (w0 === 'METHOD') {
      const owner = [...stack].reverse().find((o) => o.owner !== '')?.owner ?? ''
      stack.push({ opener: 'METHOD', index: spans.open(name, 'method', st.line, owner), owner: '' })
    } else if (BLOCK_KINDS.has(w0)) {
      stack.push({ opener: w0, index: spans.open(name, BLOCK_KINDS.get(w0)!, st.line), owner: '' })
    } else if (w0 === 'INCLUDE') {
      const target = name.toUpperCase()
      // INCLUDE TYPE / INCLUDE STRUCTURE copy a structure's components, not a program.
      if (target !== 'TYPE' && target !== 'STRUCTURE') imports.push({ kind: 'include', target: name, line: st.line })
    }
  }
  for (const o of stack) spans.close(o.index, lastLine)
  return { symbols: spans.finish(rawLines), imports }
}
