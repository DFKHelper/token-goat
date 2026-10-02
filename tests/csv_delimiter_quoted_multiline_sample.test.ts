/** detectDelimiter cut its sample at the last newline before 10,000 characters, which can sit inside a quoted multi-line field; the true delimiter then threw "quote not closed" and detection fell back to a comma. */
import { describe, it, expect } from 'vitest'

import { detectDelimiter, queryCsv } from '../src/csv_query.js'

const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

// Provenance: HAND-DERIVED a 3-column TSV whose notes field is quoted and spans two lines of about 3,000 characters each (the RFC 4180 form spreadsheet exports use for a cell with a line break), so every newline near the 10,000-character mark sits inside an open quote.
const quotedMultilineTsv = (() => {
  const rows = Array.from({ length: 10 }, (_, r) => [String(r), '"' + 'x'.repeat(3000) + NL + 'more ' + 'x'.repeat(3000) + '"', 'z'].join(TAB))
  return ['id', 'notes', 'z'].join(TAB) + NL + rows.join(NL) + NL
})()

describe('detectDelimiter with quoted fields that span lines', () => {
  it('detects a tab when the 10,000-character mark falls inside a quoted field', () => {
    expect(quotedMultilineTsv.length).toBeGreaterThan(10_000)
    expect(detectDelimiter(quotedMultilineTsv)).toBe(TAB)
  })

  it('queryCsv keeps the three columns and every multi-line value whole', () => {
    const result = queryCsv(quotedMultilineTsv, {})
    expect(result.header).toEqual(['id', 'notes', 'z'])
    expect(result.totalRows).toBe(10)
    expect(result.rows[9]?.[1]).toContain(NL + 'more ')
    expect(result.rows[9]?.[2]).toBe('z')
  })

  it('judges only the first sample rows, so a broken record further down does not veto the delimiter', () => {
    // Provenance: HAND-DERIVED six clean tab-separated rows, then a record whose quote never closes; only the sampled rows decide the delimiter.
    const head = ['a' + TAB + 'b', ...Array.from({ length: 6 }, (_, i) => i + TAB + 'v' + i)].join(NL)
    expect(detectDelimiter(head + NL + '"never closed' + TAB + 'x' + NL + 'y' + TAB + 'z' + NL)).toBe(TAB)
  })
})
