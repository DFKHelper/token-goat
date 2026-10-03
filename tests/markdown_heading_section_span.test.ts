/** Regression: a markdown heading symbol covered only its own line, so a line inside the section body resolved to a gap (`read file.md:N`) and a changed body did not mark its section changed. Heading symbols now span the section, as the HTML adapters' do. Provenance: HAND-DERIVED. The expected spans are counted by hand from the 1-based lines of the document each test writes, using the section rule of the section reader (a section runs to the line before the next heading of the same or a shallower level, trailing blank lines excluded). */
import { describe, expect, it } from 'vitest'

import { extractMarkdownSymbols } from '../src/parser_structured.js'
import { resolveLineRegions } from '../src/line_regions.js'

function spans(doc: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {}
  for (const s of extractMarkdownSymbols(doc, 'guide.md')) out[s.name] = [s.lineStart, s.lineEnd]
  return out
}

describe('markdown heading symbols span their section', () => {
  it('ends a section before the next heading of the same or shallower level and drops trailing blanks', () => {
    // 1 # Guide / 2 blank / 3 ## One / 4 blank / 5 body / 6 blank / 7 ### Deep / 8 deep body / 9 blank / 10 ## Two / 11 blank / 12 two body
    const doc = ['# Guide', '', '## One', '', 'body', '', '### Deep', 'deep body', '', '## Two', '', 'two body', ''].join('\n')
    expect(spans(doc)).toEqual({ Guide: [1, 12], One: [3, 8], Deep: [7, 8], Two: [10, 12] })
  })

  it('spans setext headings and treats a nameless heading as a boundary', () => {
    // 1 Title / 2 ===== / 3 text / 4 ## / 5 stray / 6 ## Next / 7 last
    const doc = ['Title', '=====', 'text', '##', 'stray', '## Next', 'last'].join('\n')
    expect(spans(doc)).toEqual({ Title: [1, 7], Next: [6, 7] })
  })

  it('resolves a line inside a section body to that section instead of a gap', () => {
    const doc = ['# Guide', '', '## One', 'one body', '', '## Two', 'two body'].join('\n')
    const symbols = extractMarkdownSymbols(doc, 'guide.md')
    const regions = resolveLineRegions(symbols, 7, 4, 4)
    expect(regions.map((r) => r.label)).toEqual(['heading One'])
  })
})
