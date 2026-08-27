import { describe, it, expect } from 'vitest'

import { assignFlatEndLines, type MiniSection } from '../src/languages/common.js'
import { extractSql } from '../src/languages/sql_idx.js'
import { extractHtml } from '../src/languages/html.js'
import { extractMakefile } from '../src/languages/makefile_idx.js'

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
    // Two sections that share a start line are co-extensive: both must run to the line before the next section that actually starts later. The clamp used to leave the first one pinned at its own start line (a 1-line span) while the second got the whole body.
    expect(sections.map((s) => `${s.heading}:${s.line}-${s.endLine}`)).toEqual([
      'first:3-4',
      'second:3-4',
      'third:5-10',
    ])
  })
})

describe('same-line siblings are co-extensive, not collapsed to one line', () => {
  it('Makefile: every target of a multi-target rule gets the full recipe span (regression: `all clean:` gave `all` a 1-line span ending at its own declaration, so `token-goat read "Makefile::all"` returned just the target line and dropped the entire recipe, while `clean` got the real range)', () => {
    const content = 'all clean:\n\techo hi\n\techo bye\n\ntest:\n\techo t\n'
    const symbols = extractMakefile(content, 'Makefile')

    expect(symbols.map((s) => `${s.name}:${s.lineStart}-${s.lineEnd}`)).toEqual([
      'all:1-3',
      'clean:1-3',
      'test:5-6',
    ])
  })

  it('Makefile: a target ends at its last recipe line, not at the blank lines and comment block documenting the next target', () => {
    const content = [
      'all:',
      '\techo hi',
      '',
      '# a comment about clean',
      'clean:',
      '\trm -rf x',
      '',
      'define FOO',
      'body',
      'endef',
      '',
      '# trailing comment',
      '',
    ].join('\n')
    const symbols = extractMakefile(content, 'Makefile')

    expect(symbols.map((s) => `${s.name}:${s.lineStart}-${s.lineEnd}`)).toEqual([
      'all:1-2',
      'clean:5-6',
      'FOO:8-10',
    ])
  })

  it('HTML: a heading with an inline id anchor keeps its own body instead of handing it to the anchor section', () => {
    const content = [
      '<h2 id="sec-1">Pricing</h2>',
      '<p>line2</p>',
      '<p>line3</p>',
      '<h2 id="sec-2">Contact</h2>',
      '<p>line5</p>',
    ].join('\n')
    const { sections } = extractHtml(content, 'x.html')

    expect(sections.map((s) => `${s.heading}:${s.line}-${s.endLine}`)).toEqual([
      'Pricing:1-3',
      'sec-1:1-3',
      'Contact:4-5',
      'sec-2:4-5',
    ])
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
