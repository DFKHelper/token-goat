/** Regression: a heading-looking line inside an HTML comment (`<!-- ... -->`) counted as a section. A commented-out `## Old heading` ended the previous section early and showed up in `outline` and `section`. Provenance: FORMAT-DERIVED from CommonMark spec 0.31.2 section 4.6 (HTML blocks), start/end condition 2: the block starts with a line beginning `<!--` (up to three spaces of indentation) and ends at the line containing `-->` (https://spec.commonmark.org/0.31.2/#html-blocks), and from section 4.5 (fenced code), where a `<!--` inside a fence is literal code. Expected line numbers and heading lists are HAND-DERIVED from the document literals below. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { eachUnfencedLine } from '../src/markdown_lines.js'
import { extractMarkdownSymbols } from '../src/parser_structured.js'
import { findMarkdownHeaders, listSections, readSection } from '../src/section_reader.js'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-htmlcomment-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'doc.md')
  writeFileSync(file, content, 'utf-8')
  return file
}

const headings = (lines: string[]): string[] => findMarkdownHeaders(lines).map((h) => h.heading)

describe('headings inside an HTML comment', () => {
  it('skips a multi-line comment holding a heading-looking line', () => {
    expect(headings(['## Live', '<!--', '## Old heading', '-->', 'tail'])).toEqual(['Live'])
  })

  it('skips a heading-looking line inside a one-line comment followed by text', () => {
    expect(headings(['## Live', '<!-- ## Old --> trailing text', '## Next'])).toEqual(['Live', 'Next'])
  })

  it('resumes parsing on the line after the one holding `-->`', () => {
    expect(headings(['<!--', 'x', '--> ## not a heading, the block runs through this line', '## Next'])).toEqual(['Next'])
  })

  it('allows up to three spaces of indentation on the opener', () => {
    expect(headings(['   <!--', '## Old', '-->', '## Live'])).toEqual(['Live'])
  })

  it('does not start a comment from a `<!--` inside a fenced code block', () => {
    expect(headings(['```html', '<!--', '```', '## After fence'])).toEqual(['After fence'])
  })

  it('does not start a comment from a `<!--` that is not at the start of the line', () => {
    expect(headings(['text <!--', '## Heading', 'more -->'])).toEqual(['Heading'])
  })

  it('treats a fence marker inside a comment as comment text, not a fence opener', () => {
    expect(headings(['<!--', '```', '-->', '## Live'])).toEqual(['Live'])
  })

  it('does not let a skipped comment line underline the previous line as a setext heading', () => {
    expect(headings(['Not a heading', '<!-- -->', '---', '## Live'])).toEqual(['Live'])
  })

  it('keeps comment lines out of eachUnfencedLine but keeps indexes of the rest', () => {
    expect(Array.from(eachUnfencedLine(['a', '<!--', 'b', '-->', 'c']))).toEqual([
      [0, 'a'],
      [4, 'c'],
    ])
  })
})

describe('section and outline over a commented-out heading', () => {
  // HAND-DERIVED: lines 1 '# Doc', 3 '## Live', 5 '<!--', 6 '## Old heading', 7 'old text', 8 '-->', 9 'after the comment', 11 '## Next'.
  const DOC = ['# Doc', '', '## Live', '', '<!--', '## Old heading', 'old text', '-->', 'after the comment', '', '## Next', 'next body', ''].join('\n')

  it('lists only the real headings', () => {
    expect(listSections(tmpFile(DOC))).toEqual(['Doc', 'Live', 'Next'])
  })

  it('keeps the comment and the text after it inside the enclosing section', () => {
    const result = readSection(tmpFile(DOC), 'Live')
    expect(result?.content).toBe('## Live\n\n<!--\n## Old heading\nold text\n-->\nafter the comment')
  })

  it('does not find the commented-out heading', () => {
    expect(readSection(tmpFile(DOC), 'Old heading')).toBeNull()
  })
})

describe('the markdown symbol index over a commented-out heading', () => {
  // HAND-DERIVED: only '## Live' and '## Next' are headings per the CommonMark rule cited above.
  it('indexes the real headings and not the commented-out one', () => {
    const doc = ['## Live', '<!--', '## Old heading', '-->', '## Next', ''].join('\n')
    const names = extractMarkdownSymbols(doc, 'doc.md').map((s) => s.name)
    expect(names).toEqual(['Live', 'Next'])
  })
})
