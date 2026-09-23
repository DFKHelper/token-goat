/**
 * The oversized-index warning's category shares are shares of the database file.
 *
 * `oversizeDbMessage` states the file's size, then introduces the breakdown with "Where it went".
 * Until 2026-09-23 each share was computed against the sum of the measured categories instead, so
 * it reported a fraction of whatever happened to be measurable. The categories cover variable-length
 * content columns only -- `symbols.body`, `refs.context`, `chunks.text`, `stats.detail`, and the
 * fixed-width embedding vectors -- so on a database whose bytes are mostly indexes and fixed-width
 * row storage they account for a small slice of the file, and the shares silently rescaled to fill
 * it.
 *
 * The harm is that this number is what a reader prices a reclaim against. Seeing "symbol bodies
 * 167 MB (76%)" beside a stated 1633 MB total, the arithmetic says roughly 1.2 GB is recoverable by
 * the `reclaim-index --rebuild` the same clause recommends; the true figure is the 167 MB printed
 * next to it, and the rebuild reparses every indexed file to get there.
 *
 * PROVENANCE: CAPTURE. Every byte figure below was measured on 2026-09-23 against the live global.db
 * at %LOCALAPPDATA%/dfk-helper/token-goat, read-only:
 *   file size           1712799744  (stat)
 *   symbols.body         174675521  (SELECT SUM(LENGTH(body)) FROM symbols)
 *   refs.context          29596923  (SELECT SUM(LENGTH(context)) FROM refs)
 *   stats.detail          10229079  (SELECT SUM(LENGTH(detail)) FROM stats)
 *   chunks.text            5282310  (SELECT SUM(LENGTH(text)) FROM chunks)
 *   embedding vectors      9315840  (6065 chunk rows x VECTOR_BYTES_PER_ROW, the row count read
 *                                    from `SELECT count(*) FROM chunks`; chunk_vectors itself needs
 *                                    sqlite-vec loaded and cannot be counted from the sqlite3 CLI)
 * `token-goat doctor` against that database printed "symbol bodies 167 MB (76%)", which those
 * figures reproduce exactly under the old denominator, so the inputs are confirmed to be the ones
 * the shipping path actually saw rather than a reconstruction that merely resembles it. The
 * expected percentages below are computed from the file size independently of the formatter.
 */
import { describe, expect, it } from 'vitest'

import { oversizeDbMessage } from '../src/cli_doctor.js'

const FILE_BYTES = 1_712_799_744

/** Sorted by bytes descending, as `dbCategoryBreakdown` returns them and as the live run printed them. */
const LIVE_CATEGORIES = [
  { name: 'symbol bodies', bytes: 174_675_521, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" },
  { name: 'refs', bytes: 29_596_923, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" },
  { name: 'stats detail', bytes: 10_229_079, command: 'ages out on its own (180-day retention)' },
  { name: 'embedding vectors', bytes: 9_315_840, command: "'token-goat reclaim-index --rebuild' drops them" },
  { name: 'chunk text', bytes: 5_282_310, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" },
]

describe('the oversized-index breakdown reports shares of the file', () => {
  it('prices the dominant category against the file rather than against the measured subtotal', () => {
    const msg = oversizeDbMessage('/data/global.db', FILE_BYTES, 0, 0, LIVE_CATEGORIES)

    // 174675521 / 1712799744 = 10.2%. The old denominator was the categories' own sum, 229095673,
    // which made the same 167 MB read as 76% of a 1633 MB file.
    expect(msg).toContain('symbol bodies 167 MB (10%)')
    expect(msg, 'a share of the measured subtotal must not be presented as a share of the file').not.toContain('(76%)')
  })

  it('names the bytes the categories do not measure, so the shares are not read as exhaustive', () => {
    const msg = oversizeDbMessage('/data/global.db', FILE_BYTES, 0, 0, LIVE_CATEGORIES)

    // 1712799744 - 229095673 = 1483704071 bytes, 1415 MB: 87% of the file, and the single most
    // consequential fact for someone deciding whether a reclaim is worth running.
    expect(msg).toContain('The other 1415 MB is row overhead and indexes')
  })

  it('stays silent about a remainder too small to change the reading', () => {
    // One category covering all but 4% of the file. Naming a remainder here would add noise to a
    // breakdown that already accounts for the file, so the clause is suppressed below one twentieth.
    const msg = oversizeDbMessage('/data/global.db', 100 * 1024 * 1024, 0, 0, [
      { name: 'symbol bodies', bytes: 96 * 1024 * 1024, command: "'token-goat reclaim-index --rebuild' drops and re-derives them" },
    ])
    expect(msg).toContain('symbol bodies 96 MB (96%)')
    expect(msg).not.toContain('row overhead and indexes')
  })
})
