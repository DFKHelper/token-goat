/** detectDelimiter sampled a fixed 10,000 characters, cutting a record mid-row; the correct delimiter then threw on the ragged tail and detection fell back to a comma. */
import { describe, it, expect } from 'vitest'

import { detectDelimiter, queryCsv } from '../src/csv_query.js'

// Provenance: HAND-DERIVED a 300-column TSV (header column_name_0..299, 8 rows of value0..value299) is ~23k characters, so a 10,000-character cut lands mid-row.
const wideTsv = (() => {
  const header = Array.from({ length: 300 }, (_, i) => `column_name_${i}`).join('\t')
  const row = Array.from({ length: 300 }, (_, i) => `value${i}`).join('\t')
  return `${header}\n${Array.from({ length: 8 }, () => row).join('\n')}\n`
})()

describe('detectDelimiter on a file wider than the sample', () => {
  it('detects a tab rather than falling back to a comma', () => {
    expect(wideTsv.length).toBeGreaterThan(10_000)
    expect(detectDelimiter(wideTsv)).toBe('\t')
  })

  it('queryCsv returns all 300 header columns', () => {
    const result = queryCsv(wideTsv, {})
    expect(result.header).toHaveLength(300)
    expect(result.header[0]).toBe('column_name_0')
    expect(result.header[299]).toBe('column_name_299')
    expect(result.totalRows).toBe(8)
  })

  it('still judges a single huge line with no newline in range on the whole content', () => {
    // Provenance: HAND-DERIVED one 2,000-field line (~14k characters) with no newline at all.
    const oneLine = Array.from({ length: 2000 }, (_, i) => `v${i}`).join('\t')
    expect(detectDelimiter(oneLine)).toBe('\t')
  })
})
