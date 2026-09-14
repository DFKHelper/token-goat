/**
 * Regression: previewing the top of a sheet must cost what the preview is, not what the sheet is.
 *
 * `headSheetFromWorksheet` walked every row of the sheet into an array and then kept `slice(1, 1 + rows)` of it. The rest was built and thrown away, so the cost tracked the sheet's size and not the request. Measured against the built binary on a 550,000-row sheet, `xlsx-head --rows 5` took 5.1 s and `--rows 20` took 4.6 s -- the same work either way, for 11 lines of output. After the fix both take about 1.6 s, which is the XML parse alone (`xlsx-sheets` on the same file takes 2.0 s and does no scan at all).
 *
 * The full walk existed to learn the sheet's widest column, which pads the header and every data row so a row wider than the header still lines up. That number was already recorded while the sheet was parsed, as `ws.columnCount` (see parseSheetXml in xlsx_reader.ts), and verified equal to a full scan on a sheet whose widest row is its last -- so the walk was recomputing something already in hand. The count of elided rows likewise comes from `ws.rowCount` rather than from how far the scan happened to get.
 *
 * Nothing about the OUTPUT changed, which is what makes this worth a dedicated test: before and after produce byte-identical text on both fixtures below, so no assertion on the returned string can tell the two apart. The discriminating fact is how many cells were read, so that is what is asserted, through the real `headSheet` entry point with the workbook reader stubbed to count.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExcelCell, ExcelRow, ExcelWorkbook, ExcelWorksheet } from '../src/xlsx_reader.js'

vi.mock('../src/xlsx_reader.js', () => ({
  readXlsxWorkbook: vi.fn(),
}))

const { readXlsxWorkbook } = await import('../src/xlsx_reader.js')
const { headSheet } = await import('../src/xlsx_extract.js')

/**
 * A worksheet of `rows` x `cols` filled with `r{row}c{col}`, counting every cell read.
 *
 * HAND-DERIVED: the cell values are computed from their coordinates, so every assertion below can be worked out from the fixture's shape without consulting the extractor. `rowCount`/`columnCount` are set to the real extent, which is what a parsed sheet reports.
 */
function countingSheet(rows: number, cols: number): { ws: ExcelWorksheet; reads: () => number } {
  let reads = 0
  const cellAt = (r: number, c: number): ExcelCell => {
    reads++
    return { value: `r${r}c${c}`, text: `r${r}c${c}` }
  }
  const ws: ExcelWorksheet = {
    name: 'S',
    rowCount: rows,
    columnCount: cols,
    actualRowCount: rows,
    getRow: (r: number): ExcelRow => ({
      values: [],
      eachCell: (_opts, cb) => {
        for (let c = 1; c <= cols; c++) cb(cellAt(r, c), c)
      },
    }),
    getCell: (addr: string): ExcelCell => {
      const m = /^([A-Z]+)(\d+)$/.exec(addr)
      const col = [...(m?.[1] ?? 'A')].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0)
      return cellAt(Number(m?.[2] ?? 1), col)
    },
  }
  return { ws, reads: () => reads }
}

function stubWorkbook(ws: ExcelWorksheet): void {
  const wb: ExcelWorkbook = { worksheets: [ws], getWorksheet: (n) => (n === ws.name ? ws : undefined) }
  vi.mocked(readXlsxWorkbook).mockResolvedValue(wb)
}

describe('a head preview reads the rows it was asked for, not the whole sheet', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not read cells from rows it will never show', async () => {
    const ROWS = 100_000
    const COLS = 3
    const WANT = 5
    const { ws, reads } = countingSheet(ROWS, COLS)
    stubWorkbook(ws)

    const out = await headSheet('book.xlsx', undefined, WANT)

    // Header plus the requested rows, three cells each. Pre-fix this was 300,000 -- one read per cell of the sheet -- and the extra 299,982 were built into an array that the next line sliced away.
    expect(reads()).toBe((WANT + 1) * COLS)
    // Calibration: it really did produce the preview. An early return that read nothing would satisfy the count above and nothing else.
    const lines = out.split('\n')
    expect(lines[0]).toBe('r1c1,r1c2,r1c3')
    expect(lines[WANT]).toBe(`r${WANT + 1}c1,r${WANT + 1}c2,r${WANT + 1}c3`)
  })

  it('still reports how many rows it left out, which the scan no longer reaches', async () => {
    // The count used to be a property of how far the loop got. It is now taken from the sheet's own row count, and this is the assertion that would catch it being taken from the truncated scan instead -- that mistake reads as "...(4 more rows elided)" on a 100,000-row sheet.
    const { ws } = countingSheet(100_000, 2)
    stubWorkbook(ws)

    const out = await headSheet('book.xlsx', undefined, 5)

    expect(out).toContain('...(99994 more rows elided')
  })

  it('pads to the sheet width even when the widest row is far below the preview', async () => {
    // Why the old code walked the whole sheet: a data row wider than the header must still line up under a header cell. The width now comes from the parsed sheet's own columnCount, so a sheet whose widest row is its last is still padded correctly without reading it.
    const { ws, reads } = countingSheet(50_000, 5)
    stubWorkbook(ws)

    const out = await headSheet('book.xlsx', undefined, 2)

    for (const line of out.split('\n').slice(0, 3)) {
      expect(line.split(',')).toHaveLength(5)
    }
    expect(reads()).toBe(3 * 5)
  })

  it('reads more when more is asked for', async () => {
    // The other direction: a fix that simply capped the scan at a constant would pass every test above.
    const { ws, reads } = countingSheet(100_000, 2)
    stubWorkbook(ws)

    await headSheet('book.xlsx', undefined, 500)

    expect(reads()).toBe(501 * 2)
  })

  it('does not read past the end of a sheet shorter than the request', async () => {
    const { ws, reads } = countingSheet(4, 2)
    stubWorkbook(ws)

    const out = await headSheet('book.xlsx', undefined, 100)

    expect(reads()).toBe(4 * 2)
    expect(out).not.toContain('more rows elided')
  })
})
