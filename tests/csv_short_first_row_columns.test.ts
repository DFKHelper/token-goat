/** Column names came from the first parsed record, so a short first data row silently dropped trailing header columns. */
import { describe, it, expect } from 'vitest'

import { queryCsv, profileCsv } from '../src/csv_query.js'

describe('column names with a short first data row', () => {
  // Provenance: HAND-DERIVED from the defect report; the first data row has two cells under a three-column header.
  const shortFirst = 'id,name,email\n1,alice\n2,bob,b@x.com\n'

  it('queryCsv keeps every header column and lets --columns name the last one', () => {
    expect(queryCsv(shortFirst, {}).header).toEqual(['id', 'name', 'email'])
    const picked = queryCsv(shortFirst, { columns: ['email'] })
    expect(picked.rows).toEqual([[''], ['b@x.com']])
  })

  it('profileCsv profiles the email column too', () => {
    expect(profileCsv(shortFirst).map((p) => p.name)).toEqual(['id', 'name', 'email'])
  })

  it('noHeader mode uses the widest row, padding short rows with empty cells', () => {
    const result = queryCsv('1,alice\n2,bob,b@x.com\n', { noHeader: true })
    expect(result.header).toEqual(['col1', 'col2', 'col3'])
    expect(result.rows).toEqual([['1', 'alice', ''], ['2', 'bob', 'b@x.com']])
  })
})
