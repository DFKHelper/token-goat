/**
 * Windows batch adapter for `.bat` and `.cmd` files: the labels cmd.exe jumps to, each running to the line before the next
 * label or to the end of the file, with the batch files a `call` statement runs as imports. Command names and labels are
 * matched case-insensitively.
 *
 * A line that begins with a colon is a label and the rest of that line is ignored, so a `::` line (a colon whose label name
 * would be empty) and a `rem` line never produce a symbol. `goto :EOF` names no label of its own and is left alone.
 */

import { lastContentLine, type AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

/** A label definition: a colon starting the line, then a name that stops at the first separator. */
const LABEL_RE = /^:([A-Za-z0-9_.$#@[\]{}-][^\s;=,]*)/
const REM_RE = /^rem(?:[\s]|$)/i
/** `call [drive:][path]filename [parameters]`: the called file must carry a `.bat` or `.cmd` extension. */
const CALL_RE = /(?:^|[\s&(])call[\s]+(?:"([^"]+\.(?:bat|cmd))"|([^\s"&|<>]+\.(?:bat|cmd)))/i

export function extractBatch(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  let label: number | undefined

  for (let i = 0; i < rawLines.length; i++) {
    const line = i + 1
    const text = rawLines[i]!.replace(/^[\s@]+/, '')
    if (text === '') continue

    const found = LABEL_RE.exec(text)
    if (found) {
      spans.close(label, line - 1)
      label = spans.open(found[1]!, 'label', line)
      continue
    }
    if (text.startsWith(':') || REM_RE.test(text)) continue

    const call = CALL_RE.exec(text)
    if (call) imports.push({ kind: 'call', target: (call[1] ?? call[2])!, line })
  }
  spans.close(label, lastContentLine(rawLines))
  return { symbols: spans.finish(rawLines), imports }
}
