import { describe, it, expect } from 'vitest'

import { assignFlatEndLines, type MiniSection } from '../src/languages/common.js'
import { extractSql } from '../src/languages/sql_idx.js'
import { extractHtml } from '../src/languages/html.js'

describe('assignFlatEndLines', () => {
  it('never produces an inverted range when two sections share a start line', () => {
    // Two sections on the same line (line 3) followed by one on line 5.
    const sections: MiniSection[] = [
      { heading: 'first', level: 1, line: 3, endLine: 3 },
      { heading: 'second', level: 1, line: 3, endLine: 3 },
      { heading: 'third', level: 1, line: 5, endLine: 5 },
    ]
    assignFlatEndLines(sections, 10)

    // Before the fix, the first section got endLine = next.line - 1 = 2, which is below its own start line (3) — an inverted range.
    for (const s of sections) {
      expect(s.endLine).toBeGreaterThanOrEqual(s.line)
    }
    expect(sections[0]?.endLine).toBe(3)
    expect(sections[1]?.endLine).toBe(4)
    expect(sections[2]?.endLine).toBe(10)
  })
})

describe('language adapters never emit inverted symbol ranges', () => {
  it('SQL: two CREATE statements on one line keep lineEnd >= lineStart', () => {
    const content = 'CREATE TABLE a (id INT); CREATE TABLE b (id INT);\nSELECT 1;\n'
    const symbols = extractSql(content, 'x.sql')

    // Both tables must be captured...
    expect(symbols.map((s) => s.name).sort()).toEqual(['a', 'b'])
    // ...and neither may have an inverted (lineEnd < lineStart) range.
    for (const s of symbols) {
      expect(s.lineEnd).toBeGreaterThanOrEqual(s.lineStart)
    }
  })

  it('HTML: a heading with an inline id anchor keeps endLine >= line', () => {
    const content = [
      '<html>',
      '<body>',
      '<h2 id="intro">Introduction</h2>',
      '<p>text</p>',
      '<h2>Second</h2>',
      '</body>',
      '</html>',
    ].join('\n')
    const { sections } = extractHtml(content, 'x.html')

    for (const s of sections) {
      expect(s.endLine).toBeGreaterThanOrEqual(s.line)
    }
  })
})
