/**
 * PL/I adapter: labeled PROCEDURE blocks (nested ones under their parent) and PACKAGE blocks, each to the END that closes it.
 * DO groups, BEGIN blocks and SELECT groups are tracked only so every END closes the right block; `END label;` closes the nearest
 * block with that label, and any block left open inside it closes with it. Statements end with a semicolon; `/* ... *\/` comments and
 * quoted strings are skipped, and a column 73-80 sequence field is dropped when most long lines carry one. Keywords are
 * case-insensitive. Imports are %INCLUDE members.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, topLevelWords, type StatementAdapterResult } from './span_collector.js'

interface Statement {
  /** Statement text with comments removed and string contents blanked. */
  readonly text: string
  /** Statement text with comments removed and strings kept, for %INCLUDE targets. */
  readonly raw: string
  readonly line: number
  readonly endLine: number
}

const SEQUENCE_FIELD_RE = /^ *\d+ *$/

/** True when most lines longer than 72 columns carry a numeric sequence field in columns 73-80. */
function hasSequenceField(rawLines: readonly string[]): boolean {
  const long = rawLines.filter((l) => l.length > 72)
  if (long.length === 0) return false
  return long.filter((l) => SEQUENCE_FIELD_RE.test(l.slice(72, 80))).length / long.length >= 0.8
}

function pliStatements(rawLines: readonly string[]): Statement[] {
  const out: Statement[] = []
  const margin = hasSequenceField(rawLines)
  let text = ''
  let raw = ''
  let start = 0
  let quote = ''
  let comment = false
  for (let i = 0; i < rawLines.length; i++) {
    const line = margin ? rawLines[i]!.slice(0, 72) : rawLines[i]!
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!
      if (comment) {
        if (ch === '*' && line[j + 1] === '/') {
          comment = false
          j++
        }
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
      if (ch === '/' && line[j + 1] === '*') {
        comment = true
        j++
        continue
      }
      if (ch === ';') {
        const t = text.trim()
        if (t !== '') out.push({ text: t, raw: raw.trim(), line: start, endLine: i + 1 })
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

const LABEL_RE = /^(%?)([A-Za-z_@#$][\w@#$]*)\s*:/

const isWordChar = (ch: string): boolean => /[\w@#$%]/.test(ch)

const OPENERS: ReadonlySet<string> = new Set(['DO', 'BEGIN', 'SELECT'])
const INTRODUCERS: ReadonlySet<string> = new Set(['THEN', 'ELSE', 'OTHERWISE', 'WHEN'])

interface Open {
  readonly labels: readonly string[]
  readonly index: number | undefined
  /** A procedure or package, whose name nested procedures take as their parent. */
  readonly named: boolean
}

export function extractPli(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  const stack: Open[] = []
  let previous = 0

  for (const st of pliStatements(rawLines)) {
    let rest = st.text
    const labels: string[] = []
    let percent = false
    for (let m = LABEL_RE.exec(rest); m !== null; m = LABEL_RE.exec(rest)) {
      if (m[1] === '%') percent = true
      labels.push(m[2]!)
      rest = rest.slice(m[0].length).trimStart()
    }
    if (rest.startsWith('%')) percent = true
    const words = topLevelWords(rest, isWordChar).map((w) => w.replace(/^%/, '').toUpperCase())
    const w0 = words[0] ?? ''
    // PL/I reserves no keywords: `DO = 1;` assigns to a variable named DO.
    const assignment = /^%?[\w@#$]+\s*=/.test(rest)
    const parent = (): string => spans.name([...stack].reverse().find((o) => o.named)?.index)

    if (w0 === 'END' && !assignment) {
      const label = words[1]
      const at = label === undefined ? -1 : stack.map((o) => o.labels.some((l) => l.toUpperCase() === label)).lastIndexOf(true)
      for (const o of stack.splice(at >= 0 ? at : Math.max(0, stack.length - 1))) spans.close(o.index, st.endLine)
    } else if ((w0 === 'PROC' || w0 === 'PROCEDURE' || w0 === 'PACKAGE') && !assignment) {
      // A %PROCEDURE is a preprocessor procedure: it is tracked for its END but is not part of the program.
      const index = percent || labels.length === 0 ? undefined : spans.open(labels[0]!, w0 === 'PACKAGE' ? 'package' : 'procedure', st.line, parent())
      stack.push({ labels, index, named: index !== undefined })
    } else if ((OPENERS.has(w0) && !assignment) || words.some((w, k) => INTRODUCERS.has(w) && OPENERS.has(words[k + 1] ?? '')) || (w0 === 'ON' && words[words.length - 1] === 'BEGIN')) {
      stack.push({ labels, index: undefined, named: false })
    } else if (percent && (w0 === 'INCLUDE' || w0 === 'XINCLUDE')) {
      const list = st.raw.replace(/^[^%]*%\s*X?INCLUDE\b/i, '')
      for (const item of list.split(',')) {
        const t = item.trim().replace(/^(['"])(.*)\1$/, '$2')
        const member = /\(([^()]+)\)\s*$/.exec(t)
        const target = (member ? member[1]! : t).trim()
        if (target !== '') imports.push({ kind: 'include', target, line: st.line })
      }
    }
    previous = st.endLine
  }
  for (const o of stack) spans.close(o.index, previous)
  return { symbols: spans.finish(rawLines), imports }
}
