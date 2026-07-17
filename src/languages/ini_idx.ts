/**
 * INI/CFG section extractor and .env key extractor.
 *
 * `extractIni` — one symbol+section per `[header]` at column 0.
 * `extractEnv` — one symbol per `KEY=value` assignment at column 0, with an optional leading `export `.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection } from './common.js'
import { assignFlatEndLines, propagateEndLinesToSymbols, makeLineSymbol } from './common.js'

const MAX_SECTIONS = 200
const MAX_HEADING_LEN = 200
const MAX_ENV_KEYS = 200

// Column-0-anchored [name] header. Captures anything up to the next `]` — covers plain names like [tool.black]/[mysqld:replica]/[group/sub] as well as quoted/spaced git-config-style subsection headers like [branch "master"], which a name-charset allowlist would reject.
const HEADER_RE = /^\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/

// Optional leading `export ` (shell-sourced .env / direnv .envrc) is consumed so the captured key is the variable name, not the literal `export`. A var literally named `export` (`export=5`, no following space) still captures as `export` because the prefix group requires whitespace. A bare URL on its own line (e.g. `https://example.com`) must NOT match as a false `https` key - the colon there is a URL scheme separator immediately followed by `//`, not a key/value split. Mirrors the same `:(?!\/\/)` guard the live section reader's KEYVALUE_HEADER_RE already applies (section_reader.ts). Matches ENV_KEYVALUE_HEADER_RE in section_reader.ts - includes '.'/'-' so keys like NODE-ENV or DB.HOST are indexed the same as the live section reader finds them.
const ENV_KEY_RE = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:(?!\/\/))/

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
    symbols.push(makeLineSymbol(filePath, name, 'ini_section', i + 1))
    sections.push({ heading: name, level: 1, line: i + 1, endLine: i + 1 })
  }

  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)

  return propagateEndLinesToSymbols(symbols, sections)
}

/** Returns true if the quote char `q` at index `i` in `line` is escaped: an odd count of
 * consecutive backslashes immediately precedes it (each `\\` pair is one literal backslash, so
 * only an odd run actually escapes the quote — an escaped backslash before the quote must not
 * count as escaping it). Single quotes have no escape semantics in dotenv/POSIX, so this check
 * is skipped entirely for them — any `'` closes the value regardless of what precedes it. */
function _isEscapedQuote(line: string, i: number, q: string): boolean {
  if (q === "'") return false
  let backslashes = 0
  let j = i - 1
  while (j >= 0 && line[j] === '\\') {
    backslashes++
    j--
  }
  return backslashes % 2 === 1
}

/** Returns true if `line` contains an unescaped occurrence of the open quote char `q`, closing it. */
export function _lineClosesQuote(line: string, q: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === q && !_isEscapedQuote(line, i, q)) return true
  }
  return false
}

/** If a value's leading char is a quote that isn't closed again later on the same line, returns
 * that quote char (the value continues, embedded-newline-style, onto following lines); else null. */
export function _detectOpenQuote(value: string): string | null {
  const trimmed = value.replace(/^\s+/, '')
  const q = trimmed[0]
  if (q !== '"' && q !== "'") return null
  for (let i = 1; i < trimmed.length; i++) {
    if (trimmed[i] === q && !_isEscapedQuote(trimmed, i, q)) return null
  }
  return q
}

export function extractEnv(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)
  // Tracks a quote char opened on a prior line whose multi-line value hasn't closed yet, so a continuation line's content (which can look like its own `KEY=value` assignment) is never re-scanned as a new key.
  let openQuote: string | null = null

  for (let i = 0; i < lines.length; i++) {
    if (symbols.length >= MAX_ENV_KEYS) break
    const line = lines[i] ?? ''

    if (openQuote !== null) {
      if (_lineClosesQuote(line, openQuote)) openQuote = null
      continue
    }

    if (!line || line[0] === '#' || line[0] === ';' || line[0] === ' ' || line[0] === '\t') continue
    const m = ENV_KEY_RE.exec(line)
    if (m === null) continue
    const name = m[1]?.trim() ?? ''
    if (!name || name.length > MAX_HEADING_LEN) continue
    const key = `${name}\0${i + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push(makeLineSymbol(filePath, name, 'env_key', i + 1))
    openQuote = _detectOpenQuote(line.slice(m[0].length))
  }

  return symbols
}
