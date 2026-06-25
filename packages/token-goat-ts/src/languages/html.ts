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
import type { MiniSection } from './common.js'
import { buildLineIndex, offsetToLine, assignFlatEndLines } from './common.js'

export interface HtmlImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

export interface HtmlSection {
  readonly heading: string
  readonly level: number
  readonly line: number
  readonly endLine: number
}

// id and class attributes
const ID_RE = /id=["']([^"']+)["']/gi
const CLASS_RE = /class=["']([^"']+)["']/gi

// Link and script imports
const LINK_RE = /<link[^>]*href=["']([^"']+)["']/gi
const SCRIPT_RE = /<script[^>]*src=["']([^"']+)["']/gi

// ATX headings (h1–h6)
const HEADING_RE = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
const TAG_STRIP_RE = /<[^>]+>/g

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

export function extractHtml(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: HtmlImport[]; sections: HtmlSection[] } {
  const symbols: SymbolEntry[] = []
  const imports: HtmlImport[] = []
  const sections: MiniSection[] = []
  const lineIndex = buildLineIndex(content)

  // Headings → sections
  for (const m of content.matchAll(HEADING_RE)) {
    const level = parseInt(m[1] ?? '1', 10)
    const raw = m[2] ?? ''
    const heading = raw.replace(TAG_STRIP_RE, '').trim()
    if (heading) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      sections.push({ heading, level, line, endLine: line })
    }
    // Check for id anchor inside the tag
    const tagPart = m[0] ?? ''
    const idM = /id=["']([^"']+)["']/i.exec(tagPart)
    if (idM) {
      const anchorId = idM[1] ?? ''
      if (anchorId && !isNoise(anchorId)) {
        const line = offsetToLine(lineIndex, m.index ?? 0)
        sections.push({ heading: anchorId, level, line, endLine: line })
      }
    }
  }

  // Sort and assign end-lines
  sections.sort((a, b) => a.line - b.line)
  const totalLines = content.split('\n').length
  assignFlatEndLines(sections, totalLines)

  // id attributes
  for (const m of content.matchAll(ID_RE)) {
    const idVal = m[1] ?? ''
    if (idVal && !isNoise(idVal)) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      symbols.push({ filePath, name: idVal, kind: 'html_id', lineStart: line, lineEnd: line, body: '', docstring: '' })
    }
  }

  // class attributes
  for (const m of content.matchAll(CLASS_RE)) {
    const classVal = m[1] ?? ''
    if (classVal) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      for (const cls of classVal.split(/\s+/)) {
        if (cls && !isNoise(cls)) {
          symbols.push({ filePath, name: cls, kind: 'html_class', lineStart: line, lineEnd: line, body: '', docstring: '' })
        }
      }
    }
  }

  // link href
  for (const m of content.matchAll(LINK_RE)) {
    const href = m[1] ?? ''
    if (href) {
      const line = offsetToLine(lineIndex, m.index ?? 0)
      imports.push({ kind: 'html_link', target: href, line })
    }
  }

  // script src
  for (const m of content.matchAll(SCRIPT_RE)) {
    const src = m[1] ?? ''
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
