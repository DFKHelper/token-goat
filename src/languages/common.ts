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
  // Strip block comments first, quote-aware (like isInsideStringLiteral /
  // stripBlockCommentSpan below) so a stray "/*" inside a string literal is not
  // mistaken for a real comment opener. Comment content is blanked with spaces
  // (not removed) so line/column offsets are preserved.
  const lines = text.split('\n')
  let inComment = false
  const outLines: string[] = []
  for (const line of lines) {
    let result = ''
    let j = 0
    while (j < line.length) {
      if (!inComment) {
        let open = line.indexOf('/*', j)
        while (open !== -1 && isInsideStringLiteral(line, open)) {
          open = line.indexOf('/*', open + 1)
        }
        if (open === -1) {
          result += line.slice(j)
          break
        }
        result += line.slice(j, open)
        const close = line.indexOf('*/', open + 2)
        if (close === -1) {
          result += ' '.repeat(line.length - open)
          inComment = true
          break
        }
        result += ' '.repeat(close + 2 - open)
        j = close + 2
        inComment = false
      } else {
        const close = line.indexOf('*/', j)
        if (close === -1) {
          result += ' '.repeat(line.length - j)
          break
        }
        result += ' '.repeat(close + 2 - j)
        j = close + 2
        inComment = false
      }
    }
    outLines.push(result)
  }
  let out = outLines.join('\n')
  if (lineCommentRe !== undefined) {
    out = out.replace(lineCommentRe, (m) => ' '.repeat(m.length))
  }
  return out
}

/**
 * Strip GraphQL / shell / Python style ``# …`` line comments. Quote-aware: a `#` inside an
 * open single- or double-quoted string literal on the same line is not treated as a comment
 * starter, so e.g. a GraphQL description string containing a literal `#` is preserved.
 * Blank-fills (rather than deletes) the comment span so line/column offsets are preserved for
 * downstream line-based symbol extraction, matching `stripSqlLineComments` below.
 */
export function stripHashComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '#' && !isInsideStringLiteral(line, i)) {
          return line.slice(0, i) + ' '.repeat(line.length - i)
        }
      }
      return line
    })
    .join('\n')
}

/** Strip SQL ``-- …`` line comments. */
export function stripSqlLineComments(text: string): string {
  return text.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

/**
 * True when `index` falls inside an opening single- or double-quoted string literal earlier
 * on `line`. Tracked as a single state machine (which quote character, if any, is currently
 * open) rather than independent odd/even counts per quote type - a line of code is inside at
 * most one kind of string at a time, since a `'` can't open while a `"`-delimited string is
 * already open (and vice versa). Using independent parity counters instead misreads an
 * apostrophe inside a double-quoted string, e.g. `"don't panic"`, as opening a single-quoted
 * string that never closes.
 */
function isInsideStringLiteral(line: string, index: number): boolean {
  let openQuote: '"' | "'" | null = null
  for (let i = 0; i < index; i++) {
    const ch = line[i]
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      if (openQuote === null) {
        openQuote = ch
      } else if (openQuote === ch) {
        openQuote = null
      }
    }
  }
  return openQuote !== null
}

/**
 * Strip a ``/* ... *\/`` block-comment span from one line, carrying `inComment` state across
 * calls (one per line, in order) so a comment spanning multiple lines is tracked correctly.
 * A `/*` occurrence that falls inside an open single- or double-quoted string literal on the
 * same line (e.g. `glob('src/*.php')`) is not treated as a comment opener, so a string that
 * merely contains that two-character sequence doesn't swallow the rest of the file as a
 * never-closed comment.
 */
export function stripBlockCommentSpan(line: string, inComment: boolean): { code: string; inComment: boolean } {
  let code = ''
  let j = 0
  let comment = inComment
  while (j < line.length) {
    if (!comment) {
      let open = line.indexOf('/*', j)
      while (open !== -1 && isInsideStringLiteral(line, open)) {
        open = line.indexOf('/*', open + 1)
      }
      if (open === -1) {
        code += line.slice(j)
        break
      }
      code += line.slice(j, open)
      comment = true
      j = open + 2
    } else {
      const close = line.indexOf('*/', j)
      if (close === -1) break
      comment = false
      j = close + 2
    }
  }
  return { code, inComment: comment }
}

/**
 * Strip a `//` line comment from `line`, returning only the code portion before it.
 * A `//` occurrence that falls inside an open single- or double-quoted string literal (e.g.
 * `"http://example.com"`) is not treated as a comment opener, mirroring the quote-awareness
 * `stripBlockCommentSpan` applies to `/*`. Returns `line` unchanged when no real `//` is found.
 */
export function stripLineComment(line: string, markers: string[] = ['//']): string {
  let cutIdx = -1
  for (const marker of markers) {
    let idx = line.indexOf(marker)
    while (idx !== -1 && isInsideStringLiteral(line, idx)) {
      idx = line.indexOf(marker, idx + 1)
    }
    if (idx !== -1 && (cutIdx === -1 || idx < cutIdx)) cutIdx = idx
  }
  return cutIdx === -1 ? line : line.slice(0, cutIdx)
}

/**
 * Blanks out the contents of single-line string literals (single- or double-quoted, with
 * backslash-escape awareness) so that brace/paren characters inside string content - e.g. the
 * literal `"{"` in `private string bracket = "{";` - are never miscounted as real code structure
 * by a brace-depth tracker. Quote delimiters themselves are left in place so column positions
 * and any surrounding-context checks are unaffected; only the interior is replaced with spaces.
 *
 * This targets the common case that caused the reported bug: a single-line double- or
 * single-quoted string containing an unbalanced brace. It is intentionally not a full string
 * lexer for every language's syntax, and callers should be aware of these gaps:
 *  - C# verbatim (`@"..."`) and interpolated (`$"..."`) strings are still blanked correctly in
 *    the common case: an escaped `""` inside a verbatim string is read as "close quote,
 *    immediately reopen", which blanks the same characters either way. The one edge case this
 *    misreads is a literal backslash directly before the closing quote of a verbatim string
 *    (e.g. `@"path\"`), which this function treats as an escaped quote and so does not close the
 *    string where the verbatim-string rules actually would. Rare in practice.
 *  - PHP heredoc/nowdoc, Kotlin triple-quoted raw strings (`"""..."""`), and PowerShell
 *    here-strings (`@"..."@` / `@'...'@`) can all span multiple lines and are NOT tracked across
 *    lines here - a brace inside one of those can still desync a caller's brace-depth counter.
 *    Handling that would need dedicated multi-line state tracking, similar in spirit to
 *    `stripBlockCommentSpan` above.
 */
export function stripStringLiterals(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += quote
      i++
      while (i < line.length) {
        const c = line[i]
        if (c === '\\' && i + 1 < line.length) {
          out += '  '
          i += 2
          continue
        }
        if (c === quote) {
          out += quote
          i++
          break
        }
        out += ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
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
