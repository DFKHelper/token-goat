/**
 * Shared helpers for regex-based language adapters.
 *
 * Mirrors the subset of `src/token_goat/languages/common.py` that the TS
 * adapters actually need: line-index building, offset→line conversion, comment
 * stripping, and a simple symbol emitter used by the index adapters.
 */

import type { SymbolEntry } from '../parser_types.js'

// ---------------------------------------------------------------------------
// Line-index helpers
// ---------------------------------------------------------------------------

/**
 * Build an array of character offsets for the start of each line (0-indexed).
 * Element 0 is always 0 (start of file). Used for O(log n) offset→line lookups.
 */
export function buildLineIndex(text: string): number[] {
  const idx: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') idx.push(i + 1)
  }
  return idx
}

/**
 * Convert a character offset to a 1-based line number using binary search.
 */
export function offsetToLine(lineIndex: number[], offset: number): number {
  let lo = 0
  let hi = lineIndex.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const lineStart = lineIndex[mid]
    if (lineStart === undefined || lineStart > offset) {
      hi = mid - 1
    } else {
      lo = mid
    }
  }
  return lo + 1
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/** Strip C-style block comments (/* ... *\/) and optional line comments. */
export function stripCstyleComments(
  text: string,
  lineCommentRe?: RegExp,
): string {
  // Strip block comments first
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    // Preserve newlines so line numbers stay correct
    return m.replace(/[^\n]/g, ' ')
  })
  if (lineCommentRe !== undefined) {
    out = out.replace(lineCommentRe, (m) => ' '.repeat(m.length))
  }
  return out
}

/** Strip GraphQL / shell / Python style ``# …`` line comments. */
export function stripHashComments(text: string): string {
  return text.replace(/#[^\n]*/g, '')
}

/** Strip SQL ``-- …`` line comments. */
export function stripSqlLineComments(text: string): string {
  return text.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

// ---------------------------------------------------------------------------
// Symbol emitter factory
// ---------------------------------------------------------------------------

export interface MiniSection {
  heading: string
  level: number
  line: number
  endLine: number
}

/**
 * Factory that returns a closure for emitting one (symbol + section) pair.
 * Deduplicates by (name, line). Caps at maxSymbols (default 500).
 */
export function makeSymbolEmitter(
  symbols: SymbolEntry[],
  sections: MiniSection[],
  seen: Set<string>,
  filePath: string,
  maxSymbols = 500,
  maxHeadingLen = 120,
): (name: string, kind: string, line: number) => void {
  return function emit(name: string, kind: string, line: number): void {
    if (!name || name.length > maxHeadingLen) return
    if (symbols.length >= maxSymbols) return
    const key = `${name}\0${line}`
    if (seen.has(key)) return
    seen.add(key)
    symbols.push({
      filePath,
      name,
      kind,
      lineStart: line,
      lineEnd: line,
      body: '',
      docstring: '',
    })
    sections.push({ heading: name, level: 1, line, endLine: line })
  }
}

// ---------------------------------------------------------------------------
// Flat end-line assignment
// ---------------------------------------------------------------------------

/**
 * Assign `endLine` to each section in a sorted flat list.
 * Each section ends at the line before the next section starts, or at
 * `totalLines` for the last one. When two sections share a start line (e.g. an
 * HTML heading and its inline id anchor, or two `CREATE TABLE`s on one line),
 * `next.line - 1` would fall below the section's own start, so the end is
 * floored at `s.line` to keep the range non-inverted (a point section).
 */
export function assignFlatEndLines(sections: MiniSection[], totalLines: number): void {
  for (let i = 0; i < sections.length; i++) {
    const next = sections[i + 1]
    const s = sections[i]
    if (s === undefined) continue
    const end = next !== undefined ? next.line - 1 : totalLines
    s.endLine = end < s.line ? s.line : end
  }
}

/**
 * Propagate computed `endLine` from sections back onto symbols.
 * Matches by (name, lineStart).
 */
export function propagateEndLinesToSymbols(
  symbols: SymbolEntry[],
  sections: MiniSection[],
): SymbolEntry[] {
  const sectionMap = new Map<string, number>()
  for (const sec of sections) {
    sectionMap.set(`${sec.heading}\0${sec.line}`, sec.endLine)
  }
  return symbols.map((sym) => {
    const key = `${sym.name}\0${sym.lineStart}`
    const endLine = sectionMap.get(key)
    if (endLine !== undefined && endLine !== sym.lineEnd) {
      return { ...sym, lineEnd: endLine }
    }
    return sym
  })
}

// ---------------------------------------------------------------------------
// Source decoding
// ---------------------------------------------------------------------------

/** Decode bytes to string, returning null on failure. */
export function decodeSource(source: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(source)
  } catch {
    return null
  }
}
