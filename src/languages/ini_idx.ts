/**
 * INI/CFG section extractor and .env key extractor.
 *
 * `extractIni` — one symbol+section per `[header]` at column 0.
 * `extractEnv` — one symbol per `KEY=value` assignment at column 0.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import { assignFlatEndLines } from './common.js'

const MAX_SECTIONS = 200
const MAX_HEADING_LEN = 200
const MAX_ENV_KEYS = 200

// Column-0-anchored [name] header. Allows letters, digits, underscores, hyphens,
// dots, colons, slashes — covers [tool.black], [mysqld:replica], [group/sub].
const HEADER_RE = /^\[([A-Za-z0-9_\-.:/]+)\]\s*(?:[;#].*)?$/

// Column-0 KEY= or KEY: assignment (dotenv / envrc).
const ENV_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  lineStart: number,
): SymbolEntry {
  return { filePath, name, kind, lineStart, lineEnd: lineStart, body: '', docstring: '' }
}

export function extractIni(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const sections: MiniSection[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)
  const totalLines = lines.length

  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_SECTIONS) break
    const line = lines[i] ?? ''
    if (!line || line[0] !== '[') continue
    const m = HEADER_RE.exec(line)
    if (m === null) continue
    const name = m[1]?.trim() ?? ''
    if (!name || name.length > MAX_HEADING_LEN) continue
    const key = `${name}\0${i + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push(makeSymbol(filePath, name, 'ini_section', i + 1))
    sections.push({ heading: name, level: 1, line: i + 1, endLine: i + 1 })
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)

  return symbols.map((sym) => {
    const sec = sections.find((s) => s.heading === sym.name && s.line === sym.lineStart)
    return sec !== undefined ? { ...sym, lineEnd: sec.endLine } : sym
  })
}

export function extractEnv(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_ENV_KEYS) break
    const line = lines[i] ?? ''
    if (!line || line[0] === '#' || line[0] === ';' || line[0] === ' ' || line[0] === '\t') continue
    const m = ENV_KEY_RE.exec(line)
    if (m === null) continue
    const name = m[1]?.trim() ?? ''
    if (!name || name.length > MAX_HEADING_LEN) continue
    const key = `${name}\0${i + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push(makeSymbol(filePath, name, 'env_key', i + 1))
  }

  return symbols
}
