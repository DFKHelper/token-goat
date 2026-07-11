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
 * Strip XML/HTML ``<!-- ... -->`` block comments. Comment content is blanked with spaces (not
 * removed), and newlines inside a multi-line comment are preserved as-is, so line/column offsets
 * are unaffected downstream — mirrors `stripCstyleComments`'s span-blanking approach for `/* ... *\/`
 * comments, just with the `<!--`/`-->` delimiters instead of `/*`/`*\/`.
 */
export function stripXmlComments(text: string): string {
  const lines = text.split('\n')
  let inComment = false
  const outLines: string[] = []
  for (const line of lines) {
    let result = ''
    let j = 0
    while (j < line.length) {
      if (!inComment) {
        const open = line.indexOf('<!--', j)
        if (open === -1) {
          result += line.slice(j)
          break
        }
        result += line.slice(j, open)
        const close = line.indexOf('-->', open + 4)
        if (close === -1) {
          result += ' '.repeat(line.length - open)
          inComment = true
          break
        }
        result += ' '.repeat(close + 3 - open)
        j = close + 3
        inComment = false
      } else {
        const close = line.indexOf('-->', j)
        if (close === -1) {
          result += ' '.repeat(line.length - j)
          break
        }
        result += ' '.repeat(close + 3 - j)
        j = close + 3
        inComment = false
      }
    }
    outLines.push(result)
  }
  return outLines.join('\n')
}

/**
 * Strip `//` line comments, quote-aware (like `stripSqlLineComments`'s `--` handling below) so a
 * `//` inside an open string literal (e.g. a URL like `'https://example.com'`) is not mistaken for
 * a real comment starter. Blank-fills (rather than deletes) the comment span so line/column offsets
 * are preserved for downstream line-based symbol extraction. Unlike `stripCstyleComments`'s
 * `lineCommentRe` parameter, this is quote-aware on its own and does not require callers to blank
 * string literals first — needed by callers (like the Salesforce LWC JS adapter) that still need
 * string-literal content intact after stripping comments, e.g. to read an import path.
 */
export function stripSlashLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let idx = line.indexOf('//')
      while (idx !== -1 && isInsideStringLiteral(line, idx)) {
        idx = line.indexOf('//', idx + 1)
      }
      return idx === -1 ? line : line.slice(0, idx) + ' '.repeat(line.length - idx)
    })
    .join('\n')
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
  return text
    .split('\n')
    .map((line) => {
      let idx = line.indexOf('--')
      while (idx !== -1 && isInsideStringLiteral(line, idx)) {
        idx = line.indexOf('--', idx + 1)
      }
      return idx === -1 ? line : line.slice(0, idx) + ' '.repeat(line.length - idx)
    })
    .join('\n')
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
  let i = 0
  while (i < index) {
    const ch = line[i]
    // Only treat backslash as an escape while already inside a string (mirrors
    // stripStringLiterals below); a bare backslash outside a string can't escape
    // anything, and this avoids miscounting consecutive backslashes preceding a
    // real closing quote as escaping it (e.g. an escaped trailing backslash
    // immediately followed by the actual closing quote, as in a Windows path
    // literal like "C:\\Users\\").
    if (openQuote !== null && ch === '\\' && i + 1 < line.length) {
      i += 2
      continue
    }
    if (ch === '"' || ch === "'") {
      if (openQuote === null) {
        openQuote = ch
      } else if (openQuote === ch) {
        openQuote = null
      }
    }
    i++
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
// Multi-line string masking (heredoc/nowdoc, triple-quoted raw strings, verbatim
// strings, PowerShell here-strings)
// ---------------------------------------------------------------------------

/** Which multi-line string family is currently open, carried across `stripMultilineStringSpan` calls. */
export type MultilineStringKind = 'heredoc' | 'nowdoc' | 'tripleQuote' | 'verbatim' | 'psHereDouble' | 'psHereSingle'

/**
 * Carried-state token for `stripMultilineStringSpan`, mirroring the `inComment: boolean` state
 * `stripBlockCommentSpan` threads across line-by-line calls. `null` means "not currently inside
 * a multi-line string"; a non-null value means the previous line ended mid-span and the next
 * call should look for that span's closer instead of scanning for a new opener.
 */
export interface MultilineStringState {
  kind: MultilineStringKind
  /**
   * Heredoc/nowdoc closing identifier (e.g. `EOT`) for those two kinds. For `tripleQuote`,
   * carries the opening quote-run length as a string (e.g. `'3'`, `'4'`) instead -- C# 11+ raw
   * string literals may open with a run of 3 or more `"` characters, and the closer must match
   * that same run length (or greater), so the fixed 3-quote assumption can't be baked into the
   * `findMultilineCloser` switch. Kotlin's triple-quoted strings are always exactly 3 and use
   * `'3'` here too. Unused for `verbatim`/`psHereDouble`/`psHereSingle`.
   */
  identifier: string
}

/** Language tag selecting which multi-line string openers `stripMultilineStringSpan` looks for. */
export type MultilineStringLang = 'csharp' | 'php' | 'kotlin' | 'powershell'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Result of a closer search: how far into the line the closer (and any preceding string content) extends. */
interface CloserMatch {
  maskEnd: number
}

function findMultilineCloser(line: string, from: number, state: MultilineStringState): CloserMatch | null {
  switch (state.kind) {
    case 'heredoc':
    case 'nowdoc': {
      // PHP 7.3+ allows an indented closing marker; the identifier must be a whole word (not
      // immediately followed by another identifier character).
      const re = new RegExp(`^[ \\t]*${escapeRegExp(state.identifier)}\\b`)
      const m = re.exec(line)
      return m ? { maskEnd: m[0].length } : null
    }
    case 'tripleQuote': {
      // Closer must match the opener's quote-run length (or a longer run) — see the
      // `identifier` field doc on `MultilineStringState` for why a fixed `"""` can't be used.
      const n = state.identifier !== '' ? parseInt(state.identifier, 10) : 3
      const re = new RegExp(`"{${n},}`)
      const m = re.exec(line.slice(from))
      return m === null ? null : { maskEnd: from + m.index + m[0].length }
    }
    case 'verbatim': {
      // A `"` closes the verbatim string unless doubled (`""`), which is an escaped literal
      // quote and does not close it.
      let j = from
      while (j < line.length) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') {
            j += 2
            continue
          }
          return { maskEnd: j + 1 }
        }
        j++
      }
      return null
    }
    case 'psHereDouble':
      return line.startsWith('"@', from) ? { maskEnd: from + 2 } : null
    case 'psHereSingle':
      return line.startsWith("'@", from) ? { maskEnd: from + 2 } : null
    default:
      return null
  }
}

/** Result of an opener search: where the opener starts, and either where it closes on the same line, or the carried state to use if it doesn't. */
interface OpenerMatch {
  openStart: number
  closesSameLine: number | null
  state: MultilineStringState
}

function findMultilineOpener(line: string, from: number, lang: MultilineStringLang): OpenerMatch | null {
  if (lang === 'php') {
    // <<<IDENTIFIER (heredoc) or <<<'IDENTIFIER'/<<<"IDENTIFIER" (nowdoc uses single quotes).
    const re = /<<<\s*(['"]?)([A-Za-z_]\w*)\1/g
    re.lastIndex = from
    const m = re.exec(line)
    if (!m || isInsideStringLiteral(line, m.index)) return null
    const identifier = m[2] ?? ''
    const kind: MultilineStringKind = m[1] === "'" ? 'nowdoc' : 'heredoc'
    // Heredoc/nowdoc syntax never has real code after the opening marker on the same line.
    return { openStart: m.index, closesSameLine: null, state: { kind, identifier } }
  }

  if (lang === 'kotlin') {
    const idx = line.indexOf('"""', from)
    // Mirrors PHP's heredoc-opener guard above: a `"""` that textually appears inside an
    // already-open single-line string literal is not a real raw-string opener.
    if (idx === -1 || isInsideStringLiteral(line, idx)) return null
    const closeIdx = line.indexOf('"""', idx + 3)
    if (closeIdx !== -1) {
      return { openStart: idx, closesSameLine: closeIdx + 3, state: { kind: 'tripleQuote', identifier: '3' } }
    }
    return { openStart: idx, closesSameLine: null, state: { kind: 'tripleQuote', identifier: '3' } }
  }

  if (lang === 'csharp') {
    // C# 11+ raw string literals open with a run of 3 or MORE `"` characters (not just a fixed
    // `"""`); the closer must match that same run length or a longer one. Match the longest
    // available run so a 4- or 5-quote opener is recognized instead of only ever matching 3.
    const tripleRe = /"{3,}/g
    tripleRe.lastIndex = from
    const tripleM = tripleRe.exec(line)
    let tripleIdx = tripleM ? tripleM.index : -1
    const tripleLen = tripleM ? tripleM[0].length : 0
    // Same guard as PHP's heredoc opener and Kotlin above.
    if (tripleIdx !== -1 && isInsideStringLiteral(line, tripleIdx)) tripleIdx = -1

    const verbRe = /\$?@\$?"/g
    verbRe.lastIndex = from
    const verbM = verbRe.exec(line)
    const verbIdx = verbM ? verbM.index : -1

    if (tripleIdx === -1 && verbIdx === -1) return null
    const useTriple = tripleIdx !== -1 && (verbIdx === -1 || tripleIdx < verbIdx)

    if (useTriple) {
      const closeRe = new RegExp(`"{${tripleLen},}`)
      const closeM = closeRe.exec(line.slice(tripleIdx + tripleLen))
      if (closeM !== null) {
        const closeIdx = tripleIdx + tripleLen + closeM.index
        return { openStart: tripleIdx, closesSameLine: closeIdx + closeM[0].length, state: { kind: 'tripleQuote', identifier: String(tripleLen) } }
      }
      return { openStart: tripleIdx, closesSameLine: null, state: { kind: 'tripleQuote', identifier: String(tripleLen) } }
    }

    // Verbatim: content starts right after the opening `"`.
    const quoteIdx = verbIdx + (verbM?.[0].length ?? 1) - 1
    const closer = findMultilineCloser(line, quoteIdx + 1, { kind: 'verbatim', identifier: '' })
    if (closer !== null) {
      return { openStart: verbIdx, closesSameLine: closer.maskEnd, state: { kind: 'verbatim', identifier: '' } }
    }
    return { openStart: verbIdx, closesSameLine: null, state: { kind: 'verbatim', identifier: '' } }
  }

  if (lang === 'powershell') {
    // PowerShell here-strings require `@"` / `@'` to be the last non-whitespace token on the
    // opening line; nothing (not even a trailing comment) may follow it.
    const re = /@("|')\s*$/
    const tail = line.slice(from)
    const m = re.exec(tail)
    if (!m) return null
    const openStart = from + m.index
    const kind: MultilineStringKind = m[1] === '"' ? 'psHereDouble' : 'psHereSingle'
    // Here-strings never close on the opening line by construction.
    return { openStart, closesSameLine: null, state: { kind, identifier: '' } }
  }

  return null
}

/**
 * Multi-line counterpart to `stripStringLiterals`, for the string forms that function's own doc
 * comment calls out as gaps: PHP heredoc/nowdoc, Kotlin/C# triple-quoted raw strings, C# verbatim
 * strings, and PowerShell here-strings. All of these can span multiple lines, so - like
 * `stripBlockCommentSpan` - this takes and returns a carried state token instead of being usable
 * standalone on a single line.
 *
 * Everything from the opener through the closer (inclusive) is replaced with spaces, preserving
 * line length/column positions, so brace/paren characters anywhere in the span - including in the
 * opener or closer syntax itself - are invisible to a caller's brace-depth counter. Content before
 * the opener and after the closer is left untouched.
 *
 * `lang` restricts which opener syntaxes are recognized (each language only has some of these
 * forms), and callers are expected to run this once per line, threading `state` through
 * line-by-line the same way `inComment` is threaded through `stripBlockCommentSpan`.
 *
 * Known limitation: opener detection does not fully cross-check against `stripBlockCommentSpan`'s
 * comment state or single-line string context (beyond the `isInsideStringLiteral` guard PHP's
 * heredoc opener already applies), so a multi-line-string-opener-shaped sequence of characters
 * appearing inside an unrelated comment is a rare false positive this function does not defend
 * against - the same class of imprecision `stripStringLiterals` itself already accepts.
 */
export function stripMultilineStringSpan(
  line: string,
  state: MultilineStringState | null,
  lang: MultilineStringLang,
): { code: string; state: MultilineStringState | null } {
  let code = ''
  let i = 0
  let cur = state

  while (i < line.length) {
    if (cur !== null) {
      const closed = findMultilineCloser(line, i, cur)
      if (closed === null) {
        code += ' '.repeat(line.length - i)
        i = line.length
        continue
      }
      code += ' '.repeat(closed.maskEnd - i)
      i = closed.maskEnd
      cur = null
      continue
    }

    const opened = findMultilineOpener(line, i, lang)
    if (opened === null) {
      code += line.slice(i)
      break
    }
    code += line.slice(i, opened.openStart)
    if (opened.closesSameLine !== null) {
      code += ' '.repeat(opened.closesSameLine - opened.openStart)
      i = opened.closesSameLine
      cur = null
    } else {
      code += ' '.repeat(line.length - opened.openStart)
      i = line.length
      cur = opened.state
    }
  }

  return { code, state: cur }
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
