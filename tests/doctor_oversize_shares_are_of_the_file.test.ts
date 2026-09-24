/** The oversized-index warning's category shares are shares of the database file, and they are measured in pages. `oversizeDbMessage` states the file's size, then introduces the breakdown with "Where it went". Until 2026-09-23 each share was computed against the sum of the measured categories, so it reported a fraction of whatever happened to be measurable. After that it was a share of the file, but the categories were still `SUM(LENGTH(column))` over four content columns, which cannot see an index or a fixed-width row: against a 4.9 GB ledger it printed "refs 89 MB (2%)" and "The other 3914 MB is row overhead and indexes, which these commands do not measure", while the refs table and its four indexes held 2.7 GB of that file. The largest consumer was reported as the smallest, and the advice pointed at `reclaim-index --rebuild`, which re-derives the same rows. PROVENANCE: CAPTURE. Every byte figure below was measured on 2026-09-24 against the live global.db at %LOCALAPPDATA%/dfk-helper/token-goat, opened read-only with node:sqlite: file size           5136805888  (stat; also PRAGMA page_count 1254103 x page_size 4096) refs                2807992320  (dbstat aggregate pgsize for `refs` and the four indexes whose sqlite_master tbl_name is `refs`) symbols             1761927168  (`symbols`, its indexes, and the `symbols_fts_*` shadow tables) embeddings           415449088  (`chunks`, its indexes, and the `chunk_vectors_*` shadow tables) usage stats           63328256  (`stats*`, `hint_*`, `unmapped_tools`) recall cache          63119360  (`cache_recall*`) The groups and the page walk are the ones `dbCategoryBreakdown` runs. The expected percentages below are computed from the file size independently of the formatter. */
import { describe, expect, it } from 'vitest'

import { oversizeDbMessage } from '../src/cli_doctor.js'

const FILE_BYTES = 5_136_805_888
const GROWS = 'grows with the files indexed, so it shrinks only when files leave the index'

/** Sorted by bytes descending, as `dbCategoryBreakdown` returns them. */
const LIVE_CATEGORIES = [
  { name: 'refs', bytes: 2_807_992_320, command: GROWS },
  { name: 'symbols and their search index', bytes: 1_761_927_168, command: GROWS },
  { name: 'embeddings', bytes: 415_449_088, command: "these back 'semantic'" },
  { name: 'usage stats', bytes: 63_328_256, command: 'ages out on its own (180-day retention)' },
  { name: 'recall cache', bytes: 63_119_360, command: 'ages out on its own' },
]

describe('the oversized-index breakdown reports shares of the file', () => {
  it('names the table that holds the file, with its indexes counted in', () => {
    const msg = oversizeDbMessage('/data/global.db', FILE_BYTES, 0, 0, LIVE_CATEGORIES)

    // 2807992320 / 5136805888 = 54.7%; 1761927168 / 5136805888 = 34.3%.
    expect(msg).toContain('refs 2678 MB (55%)')
    expect(msg).toContain('symbols and their search index 1680 MB (34%)')
    expect(msg.indexOf('refs 2678 MB')).toBeLessThan(msg.indexOf('symbols and their search index'))
  })

  it('does not call bytes it measured unmeasurable', () => {
    const msg = oversizeDbMessage('/data/global.db', FILE_BYTES, 0, 0, LIVE_CATEGORIES)

    // The three listed groups hold 4985368576 bytes, 97% of the file; the other 3% is below the one-twentieth floor for naming a remainder.
    expect(msg).not.toContain('do not measure')
    expect(msg).not.toContain('The other')
  })

  it('names a remainder the listed groups leave over', () => {
    // One group covering 80% of the file leaves 20 MB, which is worth saying so the one share is not read as the whole file.
    const msg = oversizeDbMessage('/data/global.db', 100 * 1024 * 1024, 0, 0, [{ name: 'refs', bytes: 80 * 1024 * 1024, command: GROWS }])
    expect(msg).toContain('refs 80 MB (80%)')
    expect(msg).toContain('The other 20 MB is smaller tables and free pages.')
  })
})
