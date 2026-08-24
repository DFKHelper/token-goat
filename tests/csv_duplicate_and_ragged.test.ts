/**
 * Two `csv-profile`/`csv-query` defects, one about honesty and one about resilience:
 *
 * 1. Two columns sharing a header name collapsed to one under csv-parse's `columns: true`, and the
 *    profile then read as complete with a whole column silently gone. The tool's object-keyed model
 *    genuinely cannot carry both, so it must refuse and name the collision rather than drop it.
 * 2. A single ragged row (fewer fields than the header) aborted the entire file with
 *    `Invalid Record Length`, taking every good row down with it. A short row should read its
 *    present cells and blank the rest instead.
 */
import { describe, it, expect } from 'vitest'

import { queryCsv, profileCsv } from '../src/csv_query.js'

describe('duplicate header columns', () => {
  const dup = 'id,name,name\n1,alice,smith\n2,bob,jones\n'

  it('queryCsv refuses instead of silently dropping the second same-named column', () => {
    expect(() => queryCsv(dup, {})).toThrow(/duplicate column/i)
    // The message must name the offending column so the caller knows what to rename.
    expect(() => queryCsv(dup, {})).toThrow(/name/)
  })

  it('profileCsv refuses the same file rather than profiling one fewer column than exists', () => {
    expect(() => profileCsv(dup)).toThrow(/duplicate column/i)
  })

  it('fires on a header-only duplicate too, before any data row exists', () => {
    expect(() => queryCsv('a,b,a\n', {})).toThrow(/duplicate column/i)
  })

  it('--no-header sidesteps the collision by addressing columns positionally', () => {
    // Positional col1/col2/col3 are distinct even when the first data row repeats a value, so the
    // no-header path must not raise and must keep all three columns.
    const result = queryCsv('1,alice,smith\n2,bob,jones\n', { noHeader: true })
    expect(result.header).toEqual(['col1', 'col2', 'col3'])
    expect(result.totalRows).toBe(2)
  })
})

describe('ragged rows', () => {
  const ragged = 'a,b,c,d\n1,2,3,4\n5,6,7\n8,9,10,11\n'

  it('queryCsv reads a short row instead of aborting the whole file', () => {
    const result = queryCsv(ragged, {})
    expect(result.totalRows, 'all three data rows must survive one ragged row').toBe(3)
    // The short row's missing trailing cell reads back as empty, not as a dropped row.
    const short = result.rows[1]
    expect(short).toEqual(['5', '6', '7', ''])
  })

  it('profileCsv profiles the file rather than throwing on the ragged row', () => {
    const profile = profileCsv(ragged)
    expect(profile.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd'])
    // Column d has one empty cell (the short row) out of three, so its null count is 1.
    const d = profile.find((c) => c.name === 'd')
    expect(d?.nullCount).toBe(1)
  })
})
