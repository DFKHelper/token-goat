/** Round-15 indexer findings for Markdown: an ATX heading indented 1-3 spaces, TOML (`+++`) front matter, and a multi-line setext heading. Each is asserted against all three scanners (symbol extractor, section reader, read-hint outline), which must agree on where a heading is. Fixture provenance: HAND-DERIVED from CommonMark 0.31.2. Section 4.2 lets an ATX heading start after up to three spaces (four is an indented code block); section 4.3 makes a setext heading's content the whole paragraph above the underline; Hugo's front-matter documentation fences TOML with `+++`. The shapes mirror the CAPTURE of `token-goat outline` on a scratch edge.md (indented `### Indented Three` missing, `# toml comment` listed as a heading, `para line two` named alone), but every expected value below is worked out from the spec rules, not read off any scanner. */
import { describe, expect, it } from 'vitest'

import { extractMarkdownHeadings } from '../src/hints/markdown_hints.js'
import { extractMarkdownSymbols } from '../src/parser_structured.js'
import { findMarkdownHeaders } from '../src/section_reader.js'

interface Seen {
  symbols: Array<{ name: string; lineStart: number; lineEnd: number }>
  sections: Array<{ heading: string; line: number; level: number }>
  hints: Array<{ text: string; line: number; level: number }>
}

function scan(lines: string[]): Seen {
  const doc = lines.join('\n')
  return {
    symbols: extractMarkdownSymbols(doc, 'doc.md').map((s) => ({ name: s.name, lineStart: s.lineStart, lineEnd: s.lineEnd })),
    sections: findMarkdownHeaders(lines).map((h) => ({ heading: h.heading, line: h.index + 1, level: h.level })),
    hints: extractMarkdownHeadings(doc, Infinity).map((h) => ({ text: h.text, line: h.lineNumber, level: h.level })),
  }
}

describe('ATX heading indented up to three spaces', () => {
  const doc = ['### Closing Hashes ###', 'body', '', '  ### Indented Three', '', 'tail', '', '    ### four spaces is code']

  it('is a heading in all three scanners and ends the section above it', () => {
    const seen = scan(doc)
    expect(seen.symbols).toEqual([
      { name: 'Closing Hashes', lineStart: 1, lineEnd: 2 },
      // The four-space line is body text (an indented code block), so it stays inside this section, through line 8.
      { name: 'Indented Three', lineStart: 4, lineEnd: 8 },
    ])
    expect(seen.sections).toEqual([
      { heading: 'Closing Hashes', line: 1, level: 3 },
      { heading: 'Indented Three', line: 4, level: 3 },
    ])
    expect(seen.hints).toEqual([
      { text: 'Closing Hashes', line: 1, level: 3 },
      { text: 'Indented Three', line: 4, level: 3 },
    ])
  })

  it('accepts one and three spaces and refuses four', () => {
    expect(scan([' # One', '   ## Three']).sections.map((h) => h.heading)).toEqual(['One', 'Three'])
    expect(scan(['    # Four']).sections).toEqual([])
  })
})

describe('TOML front matter', () => {
  it('is skipped like YAML front matter, so its comment is not a heading', () => {
    const seen = scan(['+++', 'title = "toml front"', '# toml comment', '+++', '', '# Top'])
    expect(seen.symbols.map((s) => s.lineStart)).toEqual([6])
    expect(seen.sections.map((h) => h.line)).toEqual([6])
    expect(seen.hints.map((h) => h.line)).toEqual([6])
  })

  it('needs a closing `+++`: an unclosed fence, or a `---` closer, is not front matter', () => {
    expect(scan(['+++', '# not a comment here', '', 'text']).sections.map((h) => h.line)).toEqual([2])
    expect(scan(['+++', '# kept', '---', '']).sections.map((h) => h.line)).toEqual([2])
  })
})

describe('multi-line setext heading', () => {
  it('is named after the whole paragraph and starts on its first line, in all three scanners', () => {
    const seen = scan(['Para line one', 'para line two', '=============', '', 'text'])
    expect(seen.symbols).toEqual([{ name: 'Para line one para line two', lineStart: 1, lineEnd: 5 }])
    expect(seen.sections).toEqual([{ heading: 'Para line one para line two', line: 1, level: 1 }])
    expect(seen.hints).toEqual([{ text: 'Para line one para line two', line: 1, level: 1 }])
  })

  it('takes level 2 from a dash underline', () => {
    const seen = scan(['one', 'two', 'three', '---'])
    expect(seen.sections).toEqual([{ heading: 'one two three', line: 1, level: 2 }])
  })

  it('does not reach back across a blank line, a list item or an ATX heading', () => {
    expect(scan(['gone', '', 'kept', '===']).sections).toEqual([{ heading: 'kept', line: 3, level: 1 }])
    expect(scan(['- item', 'kept', '===']).sections).toEqual([{ heading: 'kept', line: 2, level: 1 }])
    expect(scan(['# Top', 'kept', '===']).sections.map((h) => h.heading)).toEqual(['Top', 'kept'])
  })

  it('still reads the single-line case', () => {
    expect(scan(['Title', '=====']).sections).toEqual([{ heading: 'Title', line: 1, level: 1 }])
  })
})
