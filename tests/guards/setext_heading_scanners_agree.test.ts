/**
 * Three modules scan markdown for setext headings -- a text line underlined by a run of `=` or `-`
 * -- and each holds its own byte-identical copy of the candidacy predicate: the symbol extractor
 * (src/parser_structured.ts::extractMarkdownSymbols), the section header scanner
 * (src/section_reader.ts::findMarkdownHeaders) and the read-hint outline
 * (src/hints/markdown_hints.ts::extractMarkdownHeadings). A rule added to one -- excluding
 * blockquotes, say, or admitting a new underline character -- would leave the other two
 * disagreeing about where a heading is, and nothing about that disagreement is loud: `section`
 * would cut a span the index does not name, and the hint would advertise a heading `section`
 * cannot resolve.
 *
 * Folding the three copies into one shared helper is the obvious fix and is the wrong one here.
 * parser_structured.ts, section_reader.ts and markdown_lines.ts are all in DECISION_SOURCES in
 * scripts/parser-fingerprint.mjs, so editing any of them moves PARSER_FINGERPRINT (and, through
 * markdown_lines.ts, EMBED_FINGERPRINT): every already-indexed file on every machine would be
 * reparsed and re-embedded to buy a refactor with no behaviour change at all. Measured, not
 * assumed -- the extraction was written, `npm run parser:fingerprint` moved the global digest and
 * all 54 per-language digests, and it was reverted. This guard buys the same protection for free,
 * because a test file is in no digest.
 *
 * Fixture provenance: HAND-DERIVED. The document is written against the CommonMark setext rules
 * and the GFM table rules, and the expected verdict for each line was worked out from those rules
 * rather than read off any of the three matchers. The assertion is cross-module agreement, so it
 * holds whatever the shared verdict is -- it pins the three to each other, not to a transcript of
 * one of them.
 */
import { describe, expect, it } from 'vitest'

import { extractMarkdownHeadings } from '../../src/hints/markdown_hints.js'
import { extractMarkdownSymbols } from '../../src/parser_structured.js'
import { findMarkdownHeaders } from '../../src/section_reader.js'

/**
 * One case per candidacy rule the three predicates share, so a rule dropped from any single copy
 * changes that copy's answer for at least one line here. Verified by deleting each rule from each
 * copy in turn and watching this fail. The one exception is the `startsWith('#')` test, which is
 * unreachable in all three -- every one of them matches and `continue`s on an ATX heading before
 * the setext branch is entered -- so deleting it changes nothing anywhere, and line 18 below
 * documents that rather than covering it.
 */
const DOC = [
  'Real Title', // 1  setext level 1
  '==========', // 2
  '', // 3
  'Sub', // 4  setext level 2
  '---', // 5
  '', // 6
  '| a | b |', // 7  table row: the rule on line 9 must not make line 8 a heading
  '|---|---|', // 8
  '| 1 | 2 |', // 9  last data row, followed by a horizontal rule
  '---', // 10
  '', // 11
  '- item', // 12 list item followed by a sibling bullet run
  '------', // 13
  '', // 14
  '1. numbered', // 15 ordered list item, same shape
  '------', // 16
  '', // 17
  '# ATX', // 18 already a heading; the underline below must not re-read it as setext
  '=====', // 19
  '', // 20
  'Fenced apart', // 21 the underline is four source lines away, not adjacent
  '```', // 22
  'code', // 23
  '```', // 24
  '=====', // 25
  '', // 26 blank line sitting directly above an underline run
  '=====', // 27
].join('\n')

/** 1-based line numbers each scanner calls a heading, restricted to lines that do not open with `#` -- that is exactly its setext verdict, in the one form all three can be compared in. */
function setextLinesFromSymbols(): number[] {
  return extractMarkdownSymbols(DOC, 'doc.md')
    .filter((s) => !s.body.startsWith('#'))
    .map((s) => s.lineStart)
    .sort((a, b) => a - b)
}

function setextLinesFromSectionReader(): number[] {
  const lines = DOC.split('\n')
  return findMarkdownHeaders(lines)
    .filter((h) => !(lines[h.index] ?? '').trimStart().startsWith('#'))
    .map((h) => h.index + 1)
    .sort((a, b) => a - b)
}

function setextLinesFromHints(): number[] {
  const lines = DOC.split('\n')
  return extractMarkdownHeadings(DOC, Infinity)
    .filter((h) => !(lines[h.lineNumber - 1] ?? '').trimStart().startsWith('#'))
    .map((h) => h.lineNumber)
    .sort((a, b) => a - b)
}

describe('the three markdown setext scanners agree', () => {
  it('reads the same lines as setext headings in all three', () => {
    const symbols = setextLinesFromSymbols()
    expect(setextLinesFromSectionReader(), 'section_reader disagrees with parser_structured').toEqual(symbols)
    expect(setextLinesFromHints(), 'markdown_hints disagrees with parser_structured').toEqual(symbols)
  })

  it('and that shared verdict is the one the markdown rules give', () => {
    // Only the two genuine setext headings. Every other underline in DOC is excluded by a rule:
    // table row, list item, ordered list item, already-ATX, non-adjacent across a fence.
    expect(setextLinesFromSymbols()).toEqual([1, 4])
  })
})
