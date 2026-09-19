/**
 * HTML extractor — headings, id/class attributes, link/script imports.
 *
 * Symbols:
 *   `html_id`    — id="..." attribute values (noise-filtered)
 *   `html_class` — individual class tokens from class="..." (noise-filtered)
 *
 * Imports:
 *   `html_link`   — href values from <link> tags
 *   `html_script` — src values from <script> tags
 *
 * Sections: <h1>–<h6> headings with computed end-lines.
 */

import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection, AdapterImport } from './common.js'
import { buildLineIndex, offsetToLine, assignFlatEndLines, maskHtmlNoise, findHtmlHeadingMatches} from './common.js'
import { countContentLines } from '../util.js'

export interface HtmlSection {
  readonly heading: string
  readonly level: number
  readonly line: number
  readonly endLine: number
}

// id and class attributes. The negative lookbehind requires a proper left boundary (not
// preceded by a word char or hyphen) so this only matches a bare `id=`/`class=` attribute,
// not the tail of a longer attribute name like `data-id=`, `data-testid=`, `data-class=`, etc.
// The closing quote must match the SAME character that opened it (captured in group 1) --
// a static ["'] charclass on both ends lets a literal apostrophe inside a double-quoted
// value (or vice versa) prematurely truncate the match, since [^"']+ excludes both quote
// characters unconditionally regardless of which one is actually delimiting this value. A
// per-character negative lookahead against the captured opener (rather than a static
// exclusion charclass) is required so the body can legally contain the non-delimiting quote.
// [\s\S] (not a bare `.`) so an attribute value spanning a literal newline -- valid HTML, produced by some auto-formatters wrapping long id/class/href/src lists -- still matches instead of silently dropping the symbol/ref. Mirrors liquid.ts's INCLUDE_RE/SECTION_RE/RENDER_RE, which already use this idiom for the same quoted-value-capture shape.
const ID_RE = /(?<![\w-])id=(["'])((?:(?!\1)[\s\S])+)\1/gi
const CLASS_RE = /(?<![\w-])class=(["'])((?:(?!\1)[\s\S])+)\1/gi

// Link and script imports
const LINK_RE = /<link[^>]*href=(["'])((?:(?!\1)[\s\S])+)\1/gi
const SCRIPT_RE = /<script[^>]*src=(["'])((?:(?!\1)[\s\S])+)\1/gi

// Common/noisy ids and classes to suppress
const NOISE_IDS_CLASSES = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'container', 'wrapper', 'row', 'col', 'main', 'content',
  'header', 'footer', 'nav', 'navbar', 'menu', 'button', 'link', 'text',
  'box', 'section', 'page',
])

function isNoise(name: string): boolean {
  return NOISE_IDS_CLASSES.has(name.toLowerCase())
}

// Cap on total html_id/html_class symbols emitted, consistent with the MAX_SYMBOLS convention
// used by the other language adapters (e.g. powershell_idx.ts, ini_idx.ts) - minified or
// framework-generated HTML can otherwise emit thousands of duplicate symbol rows.
const MAX_SYMBOLS = 10_000 // raised from 500: see makeSymbolEmitter's own comment in common.ts for the measurement

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

// Matches one open/close/self-closing tag, consuming quoted attribute values as a unit so an embedded `>` inside an attribute (`title="a > b"`) can't end the match early. The attribute section is gated behind a mandatory leading `\s`, so it can never overlap with the preceding tag-name quantifier -- self-closing is read off the raw match text afterward rather than a trailing `(\/?)` capture, which would otherwise be ambiguous with the same attribute section swallowing that `/` first.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?:\s(?:"[^"]*"|'[^']*'|[^'">])*)?>/g

// Total bytes of `code` a single extractHtml call will spend computing element spans, bounding the cost on a pathological file (deeply malformed or enormous markup) the same way MAX_SYMBOLS bounds the id/class loops below.
const ELEMENT_SPAN_SCAN_CAP = 2_000_000

/**
 * One forward pass over `code` giving, for every non-void element whose close tag was found, the offset from its opening `<tag` to the end of its matching `</tag>`, keyed by the opening tag's own start offset. An id/class match sitting inside an opening tag looks up that tag's start in {@link openTagRanges} to find which element owns it, then in this map for the element's real end; a void element, a self-closing tag, or one whose close tag is never found (or the scan cap is hit first) is simply absent, so its id/class falls back to today's one-line span. `<style>` bodies are skipped whole rather than walked, since raw CSS is not masked by {@link maskHtmlNoise} and could otherwise contain `<`/`>` text that desyncs the tag balance.
 */
function buildElementSpans(code: string): { spans: Map<number, number>; openTagRanges: { start: number; end: number }[] } {
  const spans = new Map<number, number>()
  const openTagRanges: { start: number; end: number }[] = []
  const stack: { name: string; start: number }[] = []
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(code)) !== null) {
    if (m.index > ELEMENT_SPAN_SCAN_CAP) break
    const isClose = m[1] === '/'
    const name = (m[2] ?? '').toLowerCase()
    const selfClosing = m[0][m[0].length - 2] === '/'
    const tagEnd = m.index + m[0].length
    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          spans.set(stack[i]!.start, tagEnd)
          stack.length = i
          break
        }
      }
      continue
    }
    openTagRanges.push({ start: m.index, end: tagEnd })
    if (selfClosing || VOID_ELEMENTS.has(name)) continue
    if (name === 'style') {
      const closeMatch = /<\/style\s*>/gi.exec(code.slice(tagEnd))
      if (closeMatch !== null) TAG_RE.lastIndex = tagEnd + closeMatch.index + closeMatch[0].length
      continue
    }
    stack.push({ name, start: m.index })
  }
  return { spans, openTagRanges }
}

// Binary search for the open tag whose own `<name attrs>` text contains `offset` (where an id/class attribute match always lands), so its start can key into `spans`. Tag ranges are non-overlapping and strictly increasing, since one tag's own attribute text cannot legally contain another tag's `<`.
function findEnclosingTagStart(openTagRanges: readonly { start: number; end: number }[], offset: number): number | null {
  let lo = 0
  let hi = openTagRanges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = openTagRanges[mid]!
    if (offset < range.start) hi = mid - 1
    else if (offset >= range.end) lo = mid + 1
    else return range.start
  }
  return null
}

export function extractHtml(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[]; sections: HtmlSection[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const sections: MiniSection[] = []
  // Blank out comments, <script> bodies, and CDATA sections (offset-preserving; see
  // maskHtmlNoise in common.ts) before running any extraction regexes, so commented-out
  // markup, JS inside a <script> tag, and CDATA payloads aren't indexed as live
  // symbols/sections/imports and don't corrupt section line-range bookkeeping for the
  // real markup that follows.
  const code = maskHtmlNoise(content)
  const lineIndex = buildLineIndex(code)

  // Headings → sections
  for (const hm of findHtmlHeadingMatches(content)) {
    if (hm.heading) {
      const line = offsetToLine(lineIndex, hm.offset)
      sections.push({ heading: hm.heading, level: hm.level, line, endLine: line })
    }
    // Check for id anchor inside the tag. [\s\S] (not a bare `.`) for the same reason as
    // ID_RE above -- hm.tag's opening-tag segment can span a literal newline (HTML_HEADING_RE's
    // `[^>]*` attributes match already permits it), so an id value wrapped across lines must
    // still match instead of silently dropping the heading's anchor-id section.
    const idM = /(?<![\w-])id=(["'])((?:(?!\1)[\s\S])+)\1/i.exec(hm.tag)
    if (idM) {
      const anchorId = idM[2] ?? ''
      if (anchorId && !isNoise(anchorId)) {
        const line = offsetToLine(lineIndex, hm.offset)
        sections.push({ heading: anchorId, level: hm.level, line, endLine: line })
      }
    }
  }

  // Sort and assign end-lines
  sections.sort((a, b) => a.line - b.line)
  const totalLines = countContentLines(code)
  assignFlatEndLines(sections, totalLines)

  // id and class attributes. Deduped by (kind, name, line) - first occurrence wins within its
  // own kind, mirroring makeSymbolEmitter's `${name}\0${line}` key semantics in common.ts - and
  // capped at MAX_SYMBOLS total, consistent with the other language adapters. `kind` must be
  // part of the key: html_id and html_class are distinct namespaces, and an element commonly
  // repeats the same token as both (`id="pricing" class="pricing"`); a shared set keyed only on
  // (name, line) let the id loop, which runs first, silently swallow the class as a false
  // duplicate.
  const seenId = new Set<string>()
  const seenClass = new Set<string>()

  // id attributes. Spans the whole element (open tag through its matching close tag), found by buildElementSpans's tag-balance scan, so `read`/`section "file.html::someId"` returns the element instead of just the line its opening tag's id sits on; a void element, a self-closing tag, or one with no discoverable close tag keeps today's one-line span.
  const { spans: elementSpans, openTagRanges } = buildElementSpans(code)
  for (const m of code.matchAll(ID_RE)) {
    if (symbols.length >= MAX_SYMBOLS) break
    const idVal = m[2] ?? ''
    if (idVal && !isNoise(idVal)) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      const key = `${idVal}\0${line}`
      if (!seenId.has(key)) {
        seenId.add(key)
        const tagStart = findEnclosingTagStart(openTagRanges, m.index ?? 0)
        const elementEnd = tagStart !== null ? elementSpans.get(tagStart) : undefined
        const lineEnd = elementEnd !== undefined ? offsetToLine(lineIndex, elementEnd - 1) : line
        symbols.push({ filePath, name: idVal, kind: 'html_id', lineStart: line, lineEnd, body: '', docstring: '', parent: '' })
      }
    }
  }

  // class attributes
  for (const m of code.matchAll(CLASS_RE)) {
    if (symbols.length >= MAX_SYMBOLS) break
    const classVal = m[2] ?? ''
    if (classVal) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      for (const cls of classVal.split(/\s+/)) {
        if (symbols.length >= MAX_SYMBOLS) break
        if (cls && !isNoise(cls)) {
          const key = `${cls}\0${line}`
          if (!seenClass.has(key)) {
            seenClass.add(key)
            symbols.push({ filePath, name: cls, kind: 'html_class', lineStart: line, lineEnd: line, body: '', docstring: '', parent: '' })
          }
        }
      }
    }
  }

  // link href
  for (const m of code.matchAll(LINK_RE)) {
    const href = m[2] ?? ''
    if (href) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      imports.push({ kind: 'html_link', target: href, line })
    }
  }

  // script src
  for (const m of code.matchAll(SCRIPT_RE)) {
    const src = m[2] ?? ''
    if (src) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      imports.push({ kind: 'html_script', target: src, line })
    }
  }

  const finalSections: HtmlSection[] = sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    line: s.line,
    endLine: s.endLine,
  }))

  return { symbols, imports, sections: finalSections }
}
