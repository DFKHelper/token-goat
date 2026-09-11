/**
 * SAS adapter: %MACRO definitions (to their %MEND, nested ones under their parent) and DATA steps named by their first output
 * data set (to RUN, QUIT, or the next step boundary). Statements end with a semicolon; `/* ... *\/` comments, `*` and `%*`
 * comment statements, and quoted strings are skipped, and DATALINES/CARDS data is never read as code. Keywords are
 * case-insensitive. A PROC step is a boundary but not a symbol: the same PROC name repeats all through a program. Imports are
 * %INCLUDE targets.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  /** Statement text with comments removed and string contents blanked. */
  readonly text: string
  /** Statement text with comments removed and strings kept, for %INCLUDE targets. */
  readonly raw: string
  readonly line: number
  readonly endLine: number
}

const DATALINES_RE = /^(?:datalines|cards|lines|parmcards)(4?)$/i

function sasStatements(rawLines: readonly string[]): Statement[] {
  const out: Statement[] = []
  let text = ''
  let raw = ''
  let start = 0
  let quote = ''
  let blockComment = false
  let commentStatement = false
  // 0: code; 1: data lines ended by a line holding `;`; 4: data lines ended by `;;;;`.
  let dataMode = 0
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!
    if (dataMode !== 0) {
      if (dataMode === 4 ? line.trimStart().startsWith(';;;;') : line.includes(';')) dataMode = 0
      continue
    }
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!
      if (blockComment) {
        if (ch === '*' && line[j + 1] === '/') {
          blockComment = false
          j++
        }
        continue
      }
      if (ch === '/' && line[j + 1] === '*' && quote === '') {
        blockComment = true
        j++
        continue
      }
      if (commentStatement) {
        if (ch === ';') commentStatement = false
        continue
      }
      if (quote !== '') {
        raw += ch
        if (ch === quote && line[j + 1] === quote) {
          raw += ch
          text += '  '
          j++
        } else if (ch === quote) {
          quote = ''
          text += ch
        } else text += ' '
        continue
      }
      if (start === 0 && (ch === '*' || (ch === '%' && line[j + 1] === '*'))) {
        commentStatement = true
        continue
      }
      if (ch === ';') {
        const t = text.trim()
        if (t !== '') {
          out.push({ text: t, raw: raw.trim(), line: start, endLine: i + 1 })
          const m = DATALINES_RE.exec(t)
          if (m) {
            dataMode = m[1] === '4' ? 4 : 1
            break
          }
        }
        text = ''
        raw = ''
        start = 0
        continue
      }
      if (ch === "'" || ch === '"') quote = ch
      if (start === 0 && !/\s/.test(ch)) start = i + 1
      text += ch
      raw += ch
    }
    text += ' '
    raw += ' '
  }
  return out
}

/** The first token after a statement's keyword, stopping at whitespace, `(` or `/`. */
function nameAfter(text: string, keywordLength: number): string {
  const rest = text.slice(keywordLength).trimStart()
  let end = 0
  while (end < rest.length && !/[\s(/;]/.test(rest[end]!)) end++
  return rest.slice(0, end)
}

/** A %INCLUDE target: the quoted path, or the fileref or `fileref(member)` written bare. */
function includeTarget(raw: string): string {
  const rest = raw.replace(/^%inc(?:lude)?\b/i, '').trimStart()
  const q = rest[0]
  if (q === "'" || q === '"') {
    const end = rest.indexOf(q, 1)
    return end > 0 ? rest.slice(1, end) : ''
  }
  let end = 0
  while (end < rest.length && !/[\s/;]/.test(rest[end]!)) end++
  return rest.slice(0, end)
}

export function extractSas(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  const statements = sasStatements(rawLines)
  const macros: Array<number | undefined> = []
  let step: number | undefined
  let previous = 0

  const endStep = (end: number): void => {
    spans.close(step, end)
    step = undefined
  }

  for (const st of statements) {
    const keyword = (/^%?[A-Za-z_]\w*/.exec(st.text)?.[0] ?? '').toLowerCase()
    if (keyword === '%macro') {
      endStep(previous)
      const parent = spans.name(macros[macros.length - 1])
      macros.push(spans.open(nameAfter(st.text, keyword.length), 'macro', st.line, parent))
    } else if (keyword === '%mend') {
      endStep(previous)
      spans.close(macros.pop(), st.endLine)
    } else if (keyword === 'data') {
      endStep(previous)
      const name = nameAfter(st.text, keyword.length)
      // DATA _NULL_ writes no data set, so it names nothing a reader would look up.
      if (name !== '' && name.toLowerCase() !== '_null_') step = spans.open(name, 'data_step', st.line, spans.name(macros[macros.length - 1]))
    } else if (keyword === 'proc') {
      endStep(previous)
    } else if (keyword === 'run' || keyword === 'quit') {
      endStep(st.endLine)
    } else if (keyword === '%include' || keyword === '%inc') {
      const target = includeTarget(st.raw)
      if (target !== '') imports.push({ kind: 'include', target, line: st.line })
    }
    previous = st.endLine
  }
  endStep(previous)
  for (const m of macros) spans.close(m, previous)
  return { symbols: spans.finish(rawLines), imports }
}
