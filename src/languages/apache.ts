/**
 * Extracts symbols from Apache HTTP Server configurations (<VirtualHost>, <Directory>, <Location>, etc.).
 */

import type { SymbolEntry } from '../parser_types.js'

interface ApacheSection {
  readonly tag: string
  readonly name: string
  readonly lineStart: number
}

function makeSymbol(
  filePath: string,
  lines: readonly string[],
  name: string,
  kind: string,
  lineStart: number,
  lineEnd: number,
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart,
    lineEnd,
    body: lines.slice(lineStart - 1, lineEnd).join('\n'),
    docstring: '',
    parent: '',
  }
}

export function extractApache(content: string, filePath: string): SymbolEntry[] {
  const lines = content.split('\n')
  const symbols: SymbolEntry[] = []
  const sections: ApacheSection[] = []

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const rawLine = lines[i] ?? ''
    const code = rawLine.replace(/^\s*#.*$/, '').trim()
    if (!code) continue

    const closing = /^<\/\s*([A-Za-z][\w-]*)\s*>/i.exec(code)
    if (closing) {
      const tag = closing[1]?.toLowerCase()
      const index = sections.map((section) => section.tag).lastIndexOf(tag ?? '')
      if (index >= 0) {
        const section = sections[index]
        if (section) {
          sections.splice(index, 1)
          symbols.push(makeSymbol(filePath, lines, section.name, 'apache_section', section.lineStart, lineNumber))
        }
      }
      continue
    }

    const opening = /^<\s*([A-Za-z][\w-]*)(?:\s+([^>\s](?:[^>]*[^>\s])?))?\s*>/i.exec(code)
    if (opening) {
      const tag = opening[1] ?? ''
      const args = opening[2]?.trim() ?? ''
      sections.push({
        tag: tag.toLowerCase(),
        name: args ? `${tag} ${args}` : tag,
        lineStart: lineNumber,
      })
      continue
    }

    const directive = /^(ServerName|DocumentRoot|Listen)\b(?:[ \t]+(\S(?:[^\r\n]*\S)?))?$/i.exec(code)
    if (directive) {
      const name = directive[2] ? `${directive[1]} ${directive[2]}` : directive[1] ?? ''
      symbols.push(makeSymbol(filePath, lines, name, 'apache_directive', lineNumber, lineNumber))
    }
  }

  return symbols.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd)
}
