/**
 * Shopify Liquid template extractor.
 *
 * Symbols:
 *   `liquid_schema`       — name field from {% schema %} JSON block
 *   `liquid_section_file` — stem of filename when file is under sections/
 *
 * Imports:
 *   `liquid_include` — {% include 'snippet' %}
 *   `liquid_section` — {% section 'name' %}
 *   `liquid_render`  — {% render 'snippet' %}
 *
 * Sections: <h1>–<h6> HTML headings found inside the template.
 */

import * as path from 'node:path'
import type { SymbolEntry } from '../parser_types.js'
import type { MiniSection, AdapterImport } from './common.js'
import { buildLineIndex, offsetToLine, assignFlatEndLines, maskHtmlNoise, findHtmlHeadingMatches } from './common.js'

export interface LiquidSection {
  readonly heading: string
  readonly level: number
  readonly line: number
  readonly endLine: number
}

const INCLUDE_RE = /{%-?\s*include\s+['"]([^'"]+)['"]/gi
const SECTION_RE = /{%-?\s*section\s+['"]([^'"]+)['"]/gi
const RENDER_RE = /{%-?\s*render\s+['"]([^'"]+)['"]/gi
const SCHEMA_RE = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/gi
const LIQUID_TAG_IMPORTS: ReadonlyArray<[RegExp, string]> = [
  [INCLUDE_RE, 'liquid_include'],
  [SECTION_RE, 'liquid_section'],
  [RENDER_RE, 'liquid_render'],
]

export function extractLiquid(
  content: string,
  filePath: string,
  relPath?: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[]; sections: LiquidSection[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const sections: MiniSection[] = []
  const lineIndex = buildLineIndex(content)
  // Blank out HTML comments and CDATA sections (offset-preserving; see maskHtmlNoise in
  // common.ts) before scanning for Liquid tags, so a commented-out {% include %}/{% section
  // %}/{% render %}/{% schema %} block isn't indexed as a live import/symbol.
  const maskedForTags = maskHtmlNoise(content)

  // include / section / render imports
  for (const [pattern, kind] of LIQUID_TAG_IMPORTS) {
    for (const m of maskedForTags.matchAll(pattern)) {
      const target = m[1] ?? ''
      if (target) {
        const line = offsetToLine(lineIndex, m.index ?? 0)
        imports.push({ kind, target, line })
      }
    }
  }

  // schema block
  for (const m of maskedForTags.matchAll(SCHEMA_RE)) {
    const schemaContent = m[1]?.trim() ?? ''
    try {
      const schemaJson = JSON.parse(schemaContent) as unknown
      if (typeof schemaJson === 'object' && schemaJson !== null && 'name' in schemaJson) {
        const name = String((schemaJson as Record<string, unknown>)['name'] ?? '')
        if (name) {
          const line = offsetToLine(lineIndex, m.index ?? 0)
          const endLine = offsetToLine(lineIndex, (m.index ?? 0) + (m[0]?.length ?? 0))
          symbols.push({ filePath, name, kind: 'liquid_schema', lineStart: line, lineEnd: endLine, body: '', docstring: '' })
        }
      }
    } catch {
      // Ignore invalid JSON in schema block
    }
  }

  // Section-file symbol (if file is in sections/ directory)
  const resolvedRel = relPath ?? filePath
  const relPosix = resolvedRel.replace(/\\/g, '/')
  if (relPosix.startsWith('sections/') || relPosix.includes('/sections/')) {
    const stem = path.basename(resolvedRel, path.extname(resolvedRel))
    symbols.push({ filePath, name: stem, kind: 'liquid_section_file', lineStart: 1, lineEnd: 1, body: '', docstring: '' })
  }

  // HTML headings
  const totalLines = content.split('\n').length
  for (const hm of findHtmlHeadingMatches(content)) {
    if (hm.heading) {
      const line = offsetToLine(lineIndex, hm.offset)
      sections.push({ heading: hm.heading, level: hm.level, line, endLine: line })
    }
  }
  sections.sort((a, b) => a.line - b.line)
  assignFlatEndLines(sections, totalLines)

  const finalSections: LiquidSection[] = sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    line: s.line,
    endLine: s.endLine,
  }))

  return { symbols, imports, sections: finalSections }
}
