/**
 * Regression: the delimiter sniffer must decide by PARSING the sample, never by counting characters in the raw first line.
 *
 * A count on an unparsed line cannot tell a field boundary from the same character sitting inside a quoted field, and the line it counted was the header -- exactly where a compound name lands. Two failures, both on ordinary comma-separated files, both measured against the shipped CLI before the fix:
 *
 * - A header of `"model;year;trim",price` carries two semicolons against one comma, so `;` won and the file did not parse AT ALL: `Invalid Closing Quote: found non trimable byte after quote at line 1`. A perfectly valid CSV was unreadable unless the caller happened to guess `--delimiter ,`.
 * - A header of `a|b|c,description` carries two pipes against one comma, so `|` won and the file quietly became three columns -- `a`, `b`, `c,description` -- with `description` no longer addressable as a column. This is the dangerous one: it returns a table, so nothing looks wrong.
 *
 * The other half of the contract matters just as much and is asserted alongside: sniffing exists so a genuinely tab-, semicolon-, or pipe-separated file is read without `--delimiter`, and a fix that simply always answered `,` would pass every failure case above while breaking the feature. Both directions are driven here.
 */
import { describe, expect, it } from 'vitest'

import { detectDelimiter, queryCsv } from '../src/csv_query.js'

describe('a separator inside a quoted field is not mistaken for a separator', () => {
  it('does not let a quoted header field make a valid CSV unparseable', () => {
    // HAND-DERIVED: a comma-separated file whose first column name legitimately contains semicolons. Two semicolons against one comma on the header line is all it took.
    const content = '"model;year;trim",price\nA,100\nB,200\n'

    expect(detectDelimiter(content)).toBe(',')
    // The real consequence, not just the sniffed character: before the fix this threw out of the parser and the command exited non-zero.
    const res = queryCsv(content, {})
    expect(res.header).toEqual(['model;year;trim', 'price'])
    expect(res.rows).toEqual([['A', '100'], ['B', '200']])
  })

  it('does not silently drop a column when an unquoted header field contains a candidate', () => {
    // HAND-DERIVED: the quieter shape. Nothing throws -- `|` parses this into three consistent columns, so the failure is a plausible-looking table with a column missing.
    const content = 'a|b|c,description\nX|Y|Z,first\nP|Q|R,second\n'

    expect(detectDelimiter(content)).toBe(',')
    const res = queryCsv(content, {})
    // `description` is a column of this file. Under the old sniffer it was the tail of a column called `c,description` and could not be named.
    expect(res.header).toEqual(['a|b|c', 'description'])
    expect(res.rows[0]).toEqual(['X|Y|Z', 'first'])
  })

  it('rejects a candidate that splits the header but leaves the rest ragged', () => {
    // HAND-DERIVED: a semicolon-separated file whose header carries one comma inside a field name. Comma splits row one into two fields and every later row into one, so csv-parse refuses it outright -- `Invalid Record Length: expect 2, got 1 on line 2`, measured -- and the candidate eliminates itself. That refusal is the whole point of not passing `relax_column_count` in the sniffer, and it is why a sniffer that accepted the first candidate merely yielding two columns would answer `,` here and collapse the file to one column. A first draft of the fix also carried an explicit `rows.every(r => r.length === width)` check; mutation testing showed it unreachable, because a ragged parse throws before it can be inspected.
    const content = 'name,surname;age\nAnn;30\nBob;40\n'

    expect(detectDelimiter(content)).toBe(';')
    const res = queryCsv(content, {})
    expect(res.header).toEqual(['name,surname', 'age'])
    expect(res.rows).toEqual([['Ann', '30'], ['Bob', '40']])
  })

  it('is not fooled by a candidate that appears only in the body', () => {
    // The old sniffer looked at the header alone, so this one already worked; it is here because the new sniffer reads several rows and must not regress it.
    const content = 'name,description,price\nWidget,"A widget; strong, light",10\nBolt,"M6; 20mm",2\n'

    expect(detectDelimiter(content)).toBe(',')
    expect(queryCsv(content, {}).header).toEqual(['name', 'description', 'price'])
  })
})

describe('the files sniffing exists for are still sniffed', () => {
  // Calibration, and the guard against the cheapest wrong fix. Every case above is satisfied by a sniffer that unconditionally returns ',', which would silently turn every one of these into a single-column file.
  it.each([
    ['pipe', 'a|b|c\n1|2|3\n4|5|6\n', '|'],
    ['tab', 'x\ty\n1\t2\n', '\t'],
    ['semicolon', 'name;amount\n1;2\n3;4\n', ';'],
    ['comma', 'a,b,c\n1,2,3\n', ','],
  ])('reads a %s-separated file without --delimiter', (_name, content, expected) => {
    expect(detectDelimiter(content)).toBe(expected)
    expect(queryCsv(content, {}).header.length).toBeGreaterThan(1)
  })

  it('reads a semicolon file whose values contain commas', () => {
    // The European convention, and the case that makes counting look reasonable in the first place: here the commas really are inside fields and the semicolons really are separators.
    const content = 'name;amount\n"Widget, large";1.234\nBolt;5\n'

    expect(detectDelimiter(content)).toBe(';')
    const res = queryCsv(content, {})
    expect(res.header).toEqual(['name', 'amount'])
    expect(res.rows[0]).toEqual(['Widget, large', '1.234'])
  })
})

describe('degenerate inputs answer with the default rather than throwing', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\n'],
    ['a single column', 'name\nA\nB\n'],
  ])('falls back to a comma on %s input', (_name, content) => {
    expect(detectDelimiter(content)).toBe(',')
  })
})
