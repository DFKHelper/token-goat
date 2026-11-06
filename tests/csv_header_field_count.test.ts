/** csvFieldCount (src/hints/file_type_handler.ts) stands in for csv-parse on the hook path, so it must count a header line exactly as csv-parse does. Provenance: CAPTURE -- every expected value is computed by the real csv-parse/sync (7.x) at run time, never restated from csvFieldCount. */
import { parse } from 'csv-parse/sync'
import { describe, expect, it } from 'vitest'

import { csvFieldCount } from '../src/hints/file_type_handler.js'

/** The count hooks_read's CSV deny printed before csv-parse left the hook path: csv-parse's first record, the naive split when it throws. */
function viaCsvParse(line: string, sep: string): number {
  try {
    return (parse(line, { delimiter: sep }) as string[][])[0]?.length ?? line.split(sep).length
  } catch {
    return line.split(sep).length
  }
}

describe('csvFieldCount', () => {
  it('counts a quoted field holding the delimiter as one field', () => {
    expect(csvFieldCount('id,"Full Name, Preferred",age', ',')).toBe(3)
    expect(csvFieldCount('id\t"a\tb"\tage', '\t')).toBe(3)
  })

  it('falls back to the naive split where csv-parse throws', () => {
    expect(csvFieldCount('a,b"c,d', ',')).toBe(3)
    expect(csvFieldCount('a,"b,c', ',')).toBe(3)
    expect(csvFieldCount('a,"b"c,d', ',')).toBe(3)
  })

  it('counts a semicolon or pipe header by its own delimiter', () => {
    // HAND-DERIVED: three names split by the delimiter each header holds.
    expect(csvFieldCount('name;year;trim', ';')).toBe(3)
    expect(csvFieldCount('name|year|trim', '|')).toBe(3)
  })

  it('agrees with csv-parse on every short line over the characters that decide a count', () => {
    for (const sep of [',', '\t', ';', '|']) {
      const alphabet = ['a', sep, '"', '\r', ' ']
      const disagreements: string[] = []
      const walk = (s: string, depth: number): void => {
        if (csvFieldCount(s, sep) !== viaCsvParse(s, sep)) disagreements.push(JSON.stringify(s))
        if (depth < 6) for (const c of alphabet) walk(s + c, depth + 1)
      }
      walk('', 0)
      expect(disagreements.slice(0, 10), `separator ${JSON.stringify(sep)}`).toEqual([])
    }
  })
})
