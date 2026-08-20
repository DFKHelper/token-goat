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

  it('SQL: a table and a function sharing a name and start line each keep their own lineEnd (regression: propagateEndLinesToSymbols keyed its section lookup on `heading\\0line` with no `kind` dimension, so the second kind pushed for that key silently overwrote the first, and both symbols were handed the wrong, later kind\'s endLine)', () => {
    const content = [
      'CREATE TABLE foo (id INT); CREATE FUNCTION foo() RETURNS INT AS $$',
      'BEGIN',
      '  RETURN 1;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
    ].join('\n')
    const symbols = extractSql(content, 'x.sql')

    const table = symbols.find((s) => s.kind === 'sql_table' && s.name === 'foo')
    const fn = symbols.find((s) => s.kind === 'sql_function' && s.name === 'foo')
    expect(table).toBeDefined()
    expect(fn).toBeDefined()
    // The table statement is entirely on line 1; the function body runs through
    // line 5, which is the last line the fixture actually has. The `6` this
    // asserted before was the phantom line a trailing newline used to add.
    expect(table?.lineEnd).toBe(1)
    expect(fn?.lineEnd).toBe(5)
  })

  it('SQL: a fully single-line function statement does not absorb unrelated trailing statements (regression: the flat model extended whichever same-line statement happened to sort last -- by PATTERNS processing order, not textual position -- all the way to the next distinct line/EOF, even when that statement had already terminated with its own `;` on its own start line)', () => {
    const content = [
      'CREATE FUNCTION foo() RETURNS INT AS $$ SELECT 1; $$ LANGUAGE sql; CREATE TABLE bar (id INT);',
      'SELECT 1;',
      'SELECT 2;',
      'SELECT 3;',
      '',
    ].join('\n')
    const symbols = extractSql(content, 'x.sql')

    const bar = symbols.find((s) => s.name === 'bar')
    const foo = symbols.find((s) => s.name === 'foo')
    expect(bar?.lineEnd).toBe(1)
    expect(foo?.lineEnd).toBe(1)
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
