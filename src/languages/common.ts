/**
 * Shared helpers for regex-based language adapters.
 *
 * Mirrors the subset of `src/token_goat/languages/common.py` that the TS
 * adapters actually need: line-index building, offset→line conversion, comment
 * stripping, and a simple symbol emitter used by the index adapters.
 */

import type { SymbolEntry } from '../parser_types.js'
import { escapeRegExp } from '../util.js'

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
export function offsetToLine(lineIndex: readonly number[], offset: number): number {
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
        const lineCommentIdx = lineCommentStartIndex(line, ['//'], j)
        let open = line.indexOf('/*', j)
        while (
          open !== -1 &&
          (isInsideStringLiteral(line, open, j) || (lineCommentIdx !== -1 && open >= lineCommentIdx))
        ) {
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

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_SCRIPT_BODY_RE = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi
const HTML_CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g
// Liquid's own comment tag, e.g. `{% comment %}...{% endcomment %}` or the whitespace-control
// variant `{%- comment -%}...{%- endcomment -%}`. Blanked the same way as HTML `<!-- -->`
// comments below; applying this mask universally (not just for .liquid files) is harmless since
// `{% comment %}` syntax never occurs in plain HTML/other file kinds this function is used for.
const LIQUID_COMMENT_RE = /{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/gi

// Blanks HTML comments, Liquid {% comment %} blocks, <script> element bodies (tags kept intact so
// callers that still need to read the opening tag, e.g. a script `src=` extractor, are
// unaffected), and CDATA sections - all with spaces, never newlines, so line/offset math against
// the original text stays valid. Without this, a heading-shaped string sitting inside
// a comment, a JS template literal in a <script> block, or a CDATA-wrapped payload
// gets scanned as if it were real markup and produces a phantom section/symbol.
export function maskHtmlNoise(text: string): string {
  // Script bodies are masked FIRST, before HTML-comment masking: a literal `<!--` sitting
  // inside a <script> string (with no matching `-->` in that same script tag) would otherwise
  // be treated by HTML_COMMENT_RE as a real comment opener, greedily matching everything up to
  // the NEXT `-->` anywhere later in the document -- including real headings in between.
  // Masking script bodies first blanks any such literal `<!--`/`-->` substrings before
  // HTML_COMMENT_RE ever runs, so it can no longer misfire across a script boundary. An HTML
  // comment that itself contains a `<script>`-shaped substring is unaffected by this reorder:
  // HTML_SCRIPT_BODY_RE would just mask that fake script body too (a no-op either way, since
  // the surrounding HTML_COMMENT_RE pass immediately after blanks that whole span regardless).
  let out = text.replace(HTML_SCRIPT_BODY_RE, (_m, open: string, body: string, close: string) =>
    open + body.replace(/[^\n]/g, ' ') + close,
  )
  out = out.replace(HTML_COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(LIQUID_COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(HTML_CDATA_RE, (m) => m.replace(/[^\n]/g, ' '))
  return out
}

// ATX-style HTML/Liquid `<h1>`-`<h6>` headings. `s` (dotall) lets `.*?` cross newlines so a
// heading formatted across multiple lines (e.g. `<h1>\n  Title\n</h1>`, common
// HTML-formatter/pretty-printer output) still matches -- the non-greedy `.*?` still stops at
// the first matching `</hN>`, so this doesn't introduce over-greedy matches.
const HTML_HEADING_RE = /<h([1-6])[^>]*>(.*?)<\/h\1>/gis
const HTML_HEADING_TAG_STRIP_RE = /<[^>]+>/g

/** One `<hN>...</hN>` match found by {@link findHtmlHeadingMatches}. */
export interface HtmlHeadingMatch {
  /** Heading level, 1-6. */
  readonly level: number
  /** Inner text with nested tags stripped and whitespace trimmed. May be empty. */
  readonly heading: string
  /** Character offset of the match start in the (unmasked) source text. */
  readonly offset: number
  /** The full matched `<hN ...>...</hN>` text, e.g. for callers that need to inspect attributes
   * on the opening tag (such as an `id=` anchor) without re-scanning the source. */
  readonly tag: string
}

/**
 * Find every `<h1>`-`<h6>` heading in HTML/Liquid `content`, masking comments, `<script>`
 * bodies, and CDATA sections first via {@link maskHtmlNoise} so heading-shaped text sitting
 * inside one of those (a commented-out `<h1>`, a JS template literal, a CDATA payload) is not
 * mistaken for a real heading.
 *
 * Shared by the indexer (`html.ts`, `liquid.ts`) and the live section-reading fallback
 * (`section_reader.ts`) so a heading indexed as a symbol is always reachable via the live
 * `section` command, and vice versa -- one regex/masking implementation instead of two that can
 * drift out of sync.
 */
export function findHtmlHeadingMatches(content: string): HtmlHeadingMatch[] {
  const masked = maskHtmlNoise(content)
  const matches: HtmlHeadingMatch[] = []
  for (const m of masked.matchAll(HTML_HEADING_RE)) {
    const level = parseInt(m[1] ?? '1', 10)
    const raw = m[2] ?? ''
    const heading = raw.replace(HTML_HEADING_TAG_STRIP_RE, '').trim()
    matches.push({ level, heading, offset: m.index ?? 0, tag: m[0] ?? '' })
  }
  return matches
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
export function isInsideStringLiteral(line: string, index: number, from = 0): boolean {
  let openQuote: '"' | "'" | null = null
  let i = from
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
      const lineCommentIdx = lineCommentStartIndex(line, ['//'], j)
      let open = line.indexOf('/*', j)
      while (
        open !== -1 &&
        (isInsideStringLiteral(line, open, j) || (lineCommentIdx !== -1 && open >= lineCommentIdx))
      ) {
        open = line.indexOf('/*', open + 1)
      }
      if (open === -1) {
        code += line.slice(j)
        break
      }
      code += line.slice(j, open)
      const close = line.indexOf('*/', open + 2)
      if (close === -1) {
        code += ' '.repeat(line.length - open)
        comment = true
        break
      }
      code += ' '.repeat(close + 2 - open)
      j = close + 2
      comment = false
    } else {
      const close = line.indexOf('*/', j)
      if (close === -1) {
        code += ' '.repeat(line.length - j)
        break
      }
      code += ' '.repeat(close + 2 - j)
      j = close + 2
      comment = false
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
  const cutIdx = lineCommentStartIndex(line, markers)
  return cutIdx === -1 ? line : line.slice(0, cutIdx)
}

/**
 * Index of the first real (not-inside-a-string-literal) occurrence of any marker in
 * `markers`, or -1 if none is found. Shared scan logic behind {@link stripLineComment} and
 * `findMultilineOpener`'s comment-awareness guard below.
 */
function lineCommentStartIndex(line: string, markers: string[], from = 0): number {
  let cutIdx = -1
  for (const marker of markers) {
    let idx = line.indexOf(marker, from)
    while (idx !== -1 && isInsideStringLiteral(line, idx, from)) {
      idx = line.indexOf(marker, idx + 1)
    }
    if (idx !== -1 && (cutIdx === -1 || idx < cutIdx)) cutIdx = idx
  }
  return cutIdx
}

/**
 * Blanks out the contents of single-line string literals (single- or double-quoted, with
 * backslash-escape awareness) so that brace/paren characters inside string content - e.g. the
 * literal `"{"` in `private string bracket = "{";` - are never miscounted as real code structure
 * by a brace-depth tracker. Quote delimiters themselves are left in place so column positions
 * and any surrounding-context checks are unaffected; only the interior is replaced with spaces.
 *
 * String-interpolation holes are tracked so a nested quote inside one can't prematurely close
 * the outer string: C# `$"...{expr}..."` (a bare `{` opens a hole once the string is `$`-prefixed),
 * Kotlin `"...${expr}..."`, and PHP `"...{$expr}..."` all get a brace-depth-aware hole scan - the
 * hole's own `{`/`}` are left unblanked (they're real code, and balanced, so they don't disturb a
 * caller's net brace count), nested code braces inside the hole (e.g. a lambda body) are tracked
 * via a depth counter so they don't close the hole early, and any string literal nested inside the
 * hole (e.g. `raw.Replace("}", "")`) is recursively scanned with the same quote/escape/hole rules
 * so its content is blanked like any other string and can't leak an unmatched brace. This targets
 * the reported bug: `$"{raw.Replace("}", "")}"` used to read the nested `"` as closing the outer
 * interpolated string early, exposing the hole's own `"}"` as bare unstripped code and leaking an
 * unmatched `}` into the caller's brace-depth counter.
 *
 * C# `{{` (the escape for a literal brace inside an interpolated string) is special-cased so it
 * blanks as a literal `{` rather than opening an interpolation hole.
 *
 * It is intentionally not a full string lexer for every language's syntax, and callers should be
 * aware of these remaining gaps:
 *  - C# verbatim (`@"..."`) strings are still blanked correctly in the common case: an escaped
 *    `""` inside a verbatim string is read as "close quote, immediately reopen", which blanks the
 *    same characters either way. The one edge case this misreads is a literal backslash directly
 *    before the closing quote of a verbatim string (e.g. `@"path\"`), which this function treats
 *    as an escaped quote and so does not close the string where the verbatim-string rules
 *    actually would. Rare in practice.
 *  - PHP heredoc/nowdoc, Kotlin triple-quoted raw strings (`"""..."""`), and PowerShell
 *    here-strings (`@"..."@` / `@'...'@`) can all span multiple lines and are NOT tracked across
 *    lines here - a brace inside one of those can still desync a caller's brace-depth counter.
 *    Handling that would need dedicated multi-line state tracking, similar in spirit to
 *    `stripBlockCommentSpan` above.
 */
export function stripStringLiterals(line: string): string {
  // A string frame blanks its content until the matching quote (unless a hole is open on top of
  // it). A hole frame passes its content through unblanked - it's real code - tracking nested
  // `{`/`}` depth so a nested code brace doesn't close the hole early, and pushing a new string
  // frame for any quote it encounters (e.g. the nested string in `Replace("}", "")`).
  type Frame = { kind: 'string'; quote: string; bareBraceHole: boolean } | { kind: 'hole'; depth: number }

  let out = ''
  let i = 0
  const stack: Frame[] = []

  while (i < line.length) {
    const ch = line[i]

    // A real single-line string/hole never contains a raw, unescaped newline. Some callers (e.g.
    // Apex, which runs this over an entire file's content rather than one line at a time - see
    // extractApex - so it can see a `//` comment's text before comment-stripping runs) can
    // otherwise hand this a false "open string" state, e.g. an apostrophe inside a `// Don't ...`
    // comment. Without this, an unmatched quote like that would blank every character - including
    // newlines - until the next stray matching quote anywhere later in the file, collapsing lines
    // together and desyncing any line-offset bookkeeping built from the original content. Treating
    // `\n` as an implicit terminator that closes everything still open on the stack matches what
    // every other caller of this function already does implicitly by only ever passing it one
    // line (with no embedded `\n`) at a time.
    if (ch === '\n') {
      out += ch
      i++
      stack.length = 0
      continue
    }

    const top = stack[stack.length - 1]

    if (top === undefined) {
      if (ch === '"' || ch === "'") {
        // A `$` immediately before the opening `"` marks a C# interpolated string, where a bare
        // `{` (not `${`) opens an interpolation hole.
        const bareBraceHole = ch === '"' && i > 0 && line[i - 1] === '$'
        stack.push({ kind: 'string', quote: ch, bareBraceHole })
        out += ch
        i++
        continue
      }
      out += ch
      i++
      continue
    }

    if (top.kind === 'hole') {
      if (ch === '"' || ch === "'") {
        const bareBraceHole = ch === '"' && i > 0 && line[i - 1] === '$'
        stack.push({ kind: 'string', quote: ch, bareBraceHole })
        out += ch
        i++
        continue
      }
      if (ch === '{') {
        top.depth++
        out += ch
        i++
        continue
      }
      if (ch === '}') {
        if (top.depth > 0) {
          top.depth--
        } else {
          stack.pop()
        }
        out += ch
        i++
        continue
      }
      out += ch
      i++
      continue
    }

    // top.kind === 'string'
    if (ch === '\\' && i + 1 < line.length) {
      out += '  '
      i += 2
      continue
    }
    if (ch === top.quote) {
      stack.pop()
      out += ch
      i++
      continue
    }
    if (top.quote === '"') {
      if (top.bareBraceHole && ch === '{') {
        if (line[i + 1] === '{') {
          // C# `{{` is the escape for a literal `{` inside an interpolated string, not a hole
          // opener - without this check the first `{` opened a hole unconditionally, passing the
          // rest of the "escaped brace" text (and everything after it on the line) through as
          // real code instead of blanked string content, desyncing brace depth for callers that
          // brace-count this function's output (e.g. csharp.ts).
          out += '  '
          i += 2
          continue
        }
        // C# interpolated-string hole: a bare `{expr}` inside a `$"..."` string.
        stack.push({ kind: 'hole', depth: 0 })
        out += ch
        i++
        continue
      }
      if (!top.bareBraceHole && ch === '$' && line[i + 1] === '{') {
        // Kotlin interpolation hole: `${expr}`.
        stack.push({ kind: 'hole', depth: 0 })
        out += line.slice(i, i + 2)
        i += 2
        continue
      }
      if (!top.bareBraceHole && ch === '{' && line[i + 1] === '$') {
        // PHP complex-variable interpolation: `{$expr}`.
        stack.push({ kind: 'hole', depth: 0 })
        out += ch
        i++
        continue
      }
    }
    out += ' '
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
  /**
   * True only for a C# verbatim *interpolated* string (`$@"..."` / `@$"..."`). A bare `{` inside
   * one opens an interpolation hole (real code, not string content) rather than literal text, so
   * `findMultilineCloser`'s `verbatim` case must scan hole-aware - a `"` opening a nested string
   * literal inside the hole (e.g. `$@"{Map("}")}"`) must not be misread as this verbatim string's
   * own closing quote. Unused (implicitly false) for every other kind, including a plain
   * non-interpolated `@"..."` verbatim string.
   */
  interpolated?: boolean
}

/** Language tag selecting which multi-line string openers `stripMultilineStringSpan` looks for. */
export type MultilineStringLang = 'csharp' | 'php' | 'kotlin' | 'powershell'

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
      if (!state.interpolated) {
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
      // Interpolated verbatim string (`$@"..."` / `@$"..."`): a bare `{` opens an interpolation
      // hole whose content is real code, not string content, so a `"` inside a nested string
      // literal within the hole (e.g. `Map("}")` in `$@"{Map("}")}"`) must not be misread as this
      // verbatim string's own closing quote - mirrors `stripStringLiterals`'s own bareBraceHole
      // handling for the single-line `$"..."` case (see that function's doc comment), scoped to
      // one line only. A hole (or its nested string) that itself spans multiple lines is a known,
      // documented gap - same class of imprecision `stripStringLiterals` and this function's own
      // non-interpolated branch above already accept.
      let j = from
      let holeDepth = 0
      let nestedQuote: string | null = null
      while (j < line.length) {
        const c = line[j]
        if (nestedQuote !== null) {
          if (c === '\\' && j + 1 < line.length) {
            j += 2
            continue
          }
          if (c === nestedQuote) {
            nestedQuote = null
          }
          j++
          continue
        }
        if (holeDepth > 0) {
          if (c === '"' || c === "'") {
            nestedQuote = c
            j++
            continue
          }
          if (c === '{') holeDepth++
          else if (c === '}') holeDepth--
          j++
          continue
        }
        if (c === '{') {
          holeDepth = 1
          j++
          continue
        }
        if (c === '"') {
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

// Line-comment marker(s) recognized for each language's findMultilineOpener guard below --
// an opener-shaped sequence sitting inside one of these is prose, not real syntax.
const MULTILINE_OPENER_COMMENT_MARKERS: Record<MultilineStringLang, string[]> = {
  php: ['//', '#'],
  kotlin: ['//'],
  csharp: ['//'],
  powershell: ['#'],
}

// Languages whose findMultilineOpener guard also needs the `/* ... */` block-comment check
// below. PowerShell is deliberately excluded: its block-comment opener `<#` always contains the
// literal `#` character that MULTILINE_OPENER_COMMENT_MARKERS.powershell already scans for, so
// the line-comment guard above incidentally already treats everything from `<#` onward as
// commented -- an equivalent check here would be redundant.
const MULTILINE_OPENER_BLOCK_COMMENT_LANGS: ReadonlySet<MultilineStringLang> = new Set(['php', 'kotlin', 'csharp'])

/**
 * True if `idx` falls inside a `/* ... *\/` block-comment span that opens on this same line at
 * or before `idx` and has not yet closed by `idx`. Mirrors the open/close scan
 * `stripBlockCommentSpan` performs, but only answers the "is idx inside a same-line block
 * comment" question for `findMultilineOpener`'s guard below -- a block comment that started on
 * a PRIOR line is already handled by each caller's existing `inComment` gate, which skips
 * calling `stripMultilineStringSpan` (and therefore this function) entirely on lines that start
 * already inside one.
 */
function isInsideSameLineBlockComment(line: string, idx: number, from = 0): boolean {
  let comment = false
  let j = from
  while (j < idx) {
    if (!comment) {
      const open = line.indexOf('/*', j)
      if (open === -1 || open >= idx) return false
      if (isInsideStringLiteral(line, open, from)) {
        j = open + 2
        continue
      }
      comment = true
      j = open + 2
    } else {
      const close = line.indexOf('*/', j)
      if (close === -1 || close >= idx) return true
      comment = false
      j = close + 2
    }
  }
  return comment
}

function findMultilineOpener(line: string, from: number, lang: MultilineStringLang): OpenerMatch | null {
  // Where this line's real (not-inside-a-string) `//`/`#` comment begins, if any. An opener
  // match at or after this index is opener-shaped text inside a comment (e.g. `// see """docs`
  // or `# example: @"`), not a genuine multi-line string opener -- without this, such a line
  // desyncs every following line's parse state (brace counting, symbol extraction) until an
  // unrelated later closer happens to be found.
  // `from` marks where a previously-closed multi-line string (that closed mid-line) ends --
  // everything in `line` before it is masked string content, not real code. Scanning these
  // guards from index 0 instead would let a `//`/`#`, unbalanced `/*`, or odd quote count that
  // merely happens to sit inside that ALREADY-CLOSED string's own content wrongly veto a genuine
  // second opener later on the same line, so every guard below is bounded to start at `from`.
  const commentIdx = lineCommentStartIndex(line, MULTILINE_OPENER_COMMENT_MARKERS[lang], from)
  const isCommented = (idx: number): boolean =>
    (commentIdx !== -1 && idx >= commentIdx) ||
    (MULTILINE_OPENER_BLOCK_COMMENT_LANGS.has(lang) && isInsideSameLineBlockComment(line, idx, from))

  if (lang === 'php') {
    // <<<IDENTIFIER (heredoc) or <<<'IDENTIFIER'/<<<"IDENTIFIER" (nowdoc uses single quotes).
    const re = /<<<\s*(['"]?)([A-Za-z_]\w*)\1/g
    re.lastIndex = from
    const m = re.exec(line)
    if (!m || isInsideStringLiteral(line, m.index, from) || isCommented(m.index)) return null
    const identifier = m[2] ?? ''
    const kind: MultilineStringKind = m[1] === "'" ? 'nowdoc' : 'heredoc'
    // Heredoc/nowdoc syntax never has real code after the opening marker on the same line.
    return { openStart: m.index, closesSameLine: null, state: { kind, identifier } }
  }

  if (lang === 'kotlin') {
    const idx = line.indexOf('"""', from)
    // Mirrors PHP's heredoc-opener guard above: a `"""` that textually appears inside an
    // already-open single-line string literal is not a real raw-string opener.
    if (idx === -1 || isInsideStringLiteral(line, idx, from) || isCommented(idx)) return null
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
    if (tripleIdx !== -1 && (isInsideStringLiteral(line, tripleIdx, from) || isCommented(tripleIdx))) tripleIdx = -1

    const verbRe = /\$?@\$?"/g
    verbRe.lastIndex = from
    const verbM = verbRe.exec(line)
    let verbIdx = verbM ? verbM.index : -1
    // Same guard as the triple-quote branch above: an `@"` (or `$@"`) that textually appears
    // inside an already-open single-line string literal - e.g. the ordinary string `"@"` in
    // `private const string At = "@";` - is not a real verbatim-string opener.
    if (verbIdx !== -1 && isCommented(verbIdx)) verbIdx = -1
    if (verbIdx !== -1 && isInsideStringLiteral(line, verbIdx, from)) verbIdx = -1

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

    // Verbatim: content starts right after the opening `"`. `$@"..."` / `@$"..."` marks an
    // interpolated verbatim string - findMultilineCloser needs to know so it scans hole-aware.
    const quoteIdx = verbIdx + (verbM?.[0].length ?? 1) - 1
    const interpolated = (verbM?.[0] ?? '').includes('$')
    const closer = findMultilineCloser(line, quoteIdx + 1, { kind: 'verbatim', identifier: '', interpolated })
    if (closer !== null) {
      return { openStart: verbIdx, closesSameLine: closer.maskEnd, state: { kind: 'verbatim', identifier: '', interpolated } }
    }
    return { openStart: verbIdx, closesSameLine: null, state: { kind: 'verbatim', identifier: '', interpolated } }
  }

  if (lang === 'powershell') {
    // PowerShell here-strings require `@"` / `@'` to be the last non-whitespace token on the
    // opening line; nothing (not even a trailing comment) may follow it. That end-of-line
    // requirement alone doesn't rule out the opener-shaped text itself living inside a `#`
    // comment (e.g. a line that is entirely `# example: @"`), so isCommented is still checked.
    const re = /@("|')\s*$/
    const tail = line.slice(from)
    const m = re.exec(tail)
    if (!m) return null
    const openStart = from + m.index
    if (isCommented(openStart)) return null
    // Same guard as the other branches above: an ordinary string ending in `@"` (e.g.
    // `$email = "admin@"`) is not a real here-string opener - the `@` there falls inside an
    // already-open single-line string literal, not immediately after one.
    if (isInsideStringLiteral(line, openStart, from)) return null
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

/** An import/include/using directive found by a regex-based language adapter. */
export interface AdapterImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

/** A symbol's line span plus its extracted body text, used by adapters that resolve a
 * multi-line block's extent via a forward search (e.g. brace-matching) rather than treating
 * every symbol as single-line. */
export interface AdapterSpan {
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}

/** Build a SymbolEntry from a resolved multi-line span. */
export function makeSpanSymbol(
  filePath: string,
  name: string,
  kind: string,
  span: AdapterSpan,
  docstring = '',
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: span.startLine,
    lineEnd: span.endLine,
    body: span.body,
    docstring,
  }
}

/**
 * Build a single-line SymbolEntry (lineStart === lineEnd === line). `sig` becomes `body`
 * and `parent` becomes `docstring` — the "parent lives in the docstring field" convention
 * several regex adapters share for single-line symbols that don't have a real docstring.
 */
export function makeLineSymbol(
  filePath: string,
  name: string,
  kind: string,
  line: number,
  sig?: string,
  parent?: string,
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: line,
    lineEnd: line,
    body: sig ?? '',
    docstring: parent ?? '',
  }
}

/**
 * Factory that returns a closure for emitting one (symbol + section) pair.
 * Deduplicates by (name, kind, line). Caps at maxSymbols (default 500).
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
    // kind must be part of the key: several adapters (sql_idx, graphql_idx, proto_idx,
    // makefile_idx) funnel multiple distinct symbol kinds through this one shared emitter, and
    // a name can legitimately repeat across kinds on the same line (e.g. a same-line
    // `CREATE TABLE foo (...); CREATE FUNCTION foo() ...`). Keying on (name, line) alone let the
    // first kind's emission silently suppress a later kind's emission of the same name.
    const key = `${name}\0${kind}\0${line}`
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
  // MiniSection carries no `kind`, so two DIFFERENT-kind symbols sharing a name and start line
  // (e.g. a same-line `CREATE TABLE foo (...); CREATE FUNCTION foo() ...`, legal in sql_idx,
  // graphql_idx, proto_idx, and makefile_idx, all of which funnel through makeSymbolEmitter)
  // cannot be told apart by `${heading}\0${line}` alone. A plain Map keyed on that pair let the
  // second kind's section silently overwrite the first's, so both symbols were handed the same
  // (and for one of them, wrong) endLine. Queuing endLines per key instead of overwriting fixes
  // this without needing a `kind` field on MiniSection: makeSymbolEmitter always pushes one
  // symbol and one section per emit() call in lockstep, so for any group of entries sharing a
  // key, the Nth section pushed for that key always corresponds to the Nth symbol pushed for it
  // - callers may stable-sort `sections` and/or `symbols` by line afterward (sql_idx sorts both,
  // proto_idx/graphql_idx/makefile_idx sort only sections), but a stable sort never reorders
  // entries that share the same key, so consuming each key's queue in encounter order still
  // pairs the right symbol with the right section even after sorting.
  const sectionMap = new Map<string, number[]>()
  for (const sec of sections) {
    const key = `${sec.heading}\0${sec.line}`
    const queue = sectionMap.get(key)
    if (queue !== undefined) queue.push(sec.endLine)
    else sectionMap.set(key, [sec.endLine])
  }
  return symbols.map((sym) => {
    const key = `${sym.name}\0${sym.lineStart}`
    const endLine = sectionMap.get(key)?.shift()
    if (endLine !== undefined && endLine !== sym.lineEnd) {
      return { ...sym, lineEnd: endLine }
    }
    return sym
  })
}
