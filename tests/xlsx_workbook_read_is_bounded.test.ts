import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildMultiSheetXlsxFixture } from './helpers/ooxml_fixtures.js'
import { isDocumentRefusal } from '../src/doc_embed_extract.js'
import { MAX_OOXML_DOCUMENT_PART_BYTES, OoxmlDocumentTooLargeError, OoxmlTookTooLongError } from '../src/ooxml_extract.js'
import { readXlsxWorkbook } from '../src/xlsx_reader.js'

// readXlsxWorkbook's sheet loop runs once per <sheet> element xl/workbook.xml declares, and nothing made those elements resolve to distinct parts, bounded the loop by a clock, or bounded what the document retained as parse trees at once. Measured through readXlsxWorkbook directly before this suite existed: a 62,730-byte workbook declaring its one sheet once took 64 ms and 100 MB resident; the same 797 KB worksheet part declared 500 times in a 66,438-byte file took 15,150 ms and 1,511 MB; declared 5,000 times in a 99,012-byte file it killed the process outright (Ineffective mark-compacts near heap limit, reproduced at --max-old-space-size=1024). Dedup alone does not answer it: 500 DISTINCT 797 KB parts, 31 MB on disk, passed every existing cap and still cost 17,191 ms and 1,899 MB.
//
// Why the coverage that existed could not have caught any of it: tests/helpers/ooxml_fixtures.ts's buildFarCornerXlsxFixture emits exactly one <sheet>, so no existing fixture makes the loop run twice; and both existing xlsx deadline tests force an ALREADY-EXPIRED deadline into listSheets/allSheetsHeadText, which by construction can only exercise code reached after that deadline was created -- i.e. after loadWorkbook has already returned, which is the entire region that was spending the time.

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xlsx-bound-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeFixture(name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, bytes)
  return file
}

describe('a workbook whose sheets all alias one worksheet part', () => {
  it('costs a small multiple of the one-sheet read, not one full parse per declared sheet', async () => {
    const aliasCount = 60
    const rowsPerSheet = 1200
    const one = writeFixture('alias-1.xlsx', buildMultiSheetXlsxFixture({ sheetCount: 1, aliasOnePart: true, rowsPerSheet }))
    const many = writeFixture('alias-many.xlsx', buildMultiSheetXlsxFixture({ sheetCount: aliasCount, aliasOnePart: true, rowsPerSheet }))

    // Calibrated in-process rather than asserted against a hard-coded millisecond count, which would be a claim about this machine and would read as a regression on a slower CI runner. Warmed first so the one-sheet baseline is not paying for module load and JIT that the second read gets for free -- that asymmetry flatters the very ratio under test.
    await readXlsxWorkbook(one)
    const t0 = Date.now()
    await readXlsxWorkbook(one)
    const oneSheetMillis = Date.now() - t0

    const t1 = Date.now()
    const wb = await readXlsxWorkbook(many)
    const manySheetMillis = Date.now() - t1

    expect(wb.worksheets).toHaveLength(aliasCount)
    // Without dedup this is aliasCount full decode-and-parse passes over the same part, so the honest shape of the failure is a ratio near 60, not near 1. The allowance is deliberately loose (a floor as well as a multiple) because the quantity being refuted is an order of magnitude away from it.
    const allowedMillis = Math.max(oneSheetMillis * 10, 400)
    expect(manySheetMillis, `${aliasCount} aliased sheets took ${manySheetMillis}ms against a ${oneSheetMillis}ms one-sheet baseline`).toBeLessThan(allowedMillis)
  }, 120_000)

  it('still resolves every declared sheet name, because the duplicate is shared and not dropped', async () => {
    const aliasCount = 8
    const file = writeFixture('alias-names.xlsx', buildMultiSheetXlsxFixture({ sheetCount: aliasCount, aliasOnePart: true, rowsPerSheet: 3 }))
    const wb = await readXlsxWorkbook(file)

    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4', 'Sheet5', 'Sheet6', 'Sheet7', 'Sheet8'])
    for (let i = 1; i <= aliasCount; i++) {
      const ws = wb.getWorksheet(`Sheet${i}`)
      expect(ws, `getWorksheet('Sheet${i}') must still find the sheet the workbook declares`).toBeDefined()
      // Dropping the duplicate would satisfy a names-only check on whatever survived; this pins that the surviving name still reaches the part's actual cells.
      expect(ws?.getCell('A1').text).toBe('p1r1c0')
    }
  }, 120_000)
})

describe('a workbook whose distinct parts come to more than one document may decode', () => {
  it('is refused as an OoxmlDocumentTooLargeError, which every existing cap lets through', async () => {
    // Padding rather than rows: the bound under test is on bytes decoded, and reaching 64 MB in cells would spend the several hundred megabytes of parse tree this cap exists to prevent, inside the test asserting the cap.
    const padBytesPerSheet = 1_100_000
    const sheetCount = 64
    expect(sheetCount * padBytesPerSheet).toBeGreaterThan(MAX_OOXML_DOCUMENT_PART_BYTES)
    const file = writeFixture('distinct-over.xlsx', buildMultiSheetXlsxFixture({ sheetCount, aliasOnePart: false, rowsPerSheet: 1, padBytesPerSheet }))

    await expect(readXlsxWorkbook(file)).rejects.toBeInstanceOf(OoxmlDocumentTooLargeError)
  }, 300_000)

  it('is remembered as refused, so the indexer does not re-inflate it on every worker drain', async () => {
    const file = writeFixture('distinct-over-2.xlsx', buildMultiSheetXlsxFixture({ sheetCount: 64, aliasOnePart: false, rowsPerSheet: 1, padBytesPerSheet: 1_100_000 }))
    const err = await readXlsxWorkbook(file).then(() => null, (e: unknown) => e)
    expect(isDocumentRefusal(err)).toBe(true)
  }, 300_000)

  it('still reads a distinct-parts workbook that stays under the budget', async () => {
    // A budget that refused every multi-part workbook would pass the two assertions above just as well.
    const file = writeFixture('distinct-under.xlsx', buildMultiSheetXlsxFixture({ sheetCount: 6, aliasOnePart: false, rowsPerSheet: 4 }))
    const wb = await readXlsxWorkbook(file)
    expect(wb.worksheets).toHaveLength(6)
    expect(wb.getWorksheet('Sheet6')?.getCell('A1').text).toBe('p6r1c0')
  }, 120_000)
})

describe('the sheet loop is under a clock of its own', () => {
  it('refuses inside readXlsxWorkbook, not only in the callers that walk the workbook afterwards', async () => {
    const file = writeFixture('clock.xlsx', buildMultiSheetXlsxFixture({ sheetCount: 4, aliasOnePart: false, rowsPerSheet: 3 }))
    // An expired deadline handed straight to the reader: the only place it can be observed is the loop inside readXlsxWorkbook, since every existing xlsx clock check runs on a workbook this call never returns.
    const err = await readXlsxWorkbook(file, Date.now() - 1).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(OoxmlTookTooLongError)
    expect(isDocumentRefusal(err)).toBe(true)
  }, 120_000)

  it('reads the same workbook normally when the deadline has not passed', async () => {
    const file = writeFixture('clock-ok.xlsx', buildMultiSheetXlsxFixture({ sheetCount: 4, aliasOnePart: false, rowsPerSheet: 3 }))
    const wb = await readXlsxWorkbook(file, Date.now() + 60_000)
    expect(wb.worksheets).toHaveLength(4)
  }, 120_000)
})
