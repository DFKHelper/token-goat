import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { formatXlsxRange, headSheet, listSheets, querySheet, rangeSheet } from '../src/xlsx_extract.js'

let dir: string
let file: string

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xlsx-'))
  file = path.join(dir, 'sample.xlsx')
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Employees')
  ws.addRow(['name', 'age', 'dept'])
  ws.addRow(['Alice', 30, 'Eng'])
  ws.getCell('B2').value = { formula: 'SUM(29,1)', result: 30 }
  ws.addRow(['Bob', 25, 'Sales'])
  ws.addRow(['Carol', 40, 'Eng'])
  const ws2 = wb.addWorksheet('Empty')
  ws2.addRow(['q', 'revenue'])
  // Create a sheet with header narrower than some data rows (regression test for cell truncation)
  const ws3 = wb.addWorksheet('WideData')
  ws3.addRow(['col1', 'col2'])
  ws3.addRow(['a', 'b', 'c', 'd'])
  ws3.addRow(['x', 'y', 'z'])
  // Date-formatted cell (regression test for cellText's locale-string fallback bug)
  const ws4 = wb.addWorksheet('Dates')
  ws4.addRow(['event', 'when'])
  const dateRow = ws4.addRow(['Launch', new Date(Date.UTC(2025, 0, 1))])
  dateRow.getCell(2).numFmt = 'yyyy-mm-dd'
  // Sheet with an interior blank row (regression test for actualRowCount undercounting trailing
  // rows -- actualRowCount only counts *populated* rows, so a sheet with a blank row in the
  // middle has actualRowCount < rowCount, and loop bounds using actualRowCount silently drop
  // the trailing data row).
  const ws5 = wb.addWorksheet('Gaps')
  ws5.getRow(1).values = ['name', 'value']
  ws5.getRow(2).values = ['first', 1]
  // row 3 intentionally left untouched/blank
  ws5.getRow(4).values = ['last', 2]
  // Formula cells whose cached result is a Date or an error object (regression test for
  // cellText's object/formula branch falling through to `String(obj.result)`, which produces
  // a JS locale string for a Date result and the literal text "[object Object]" for an error
  // result).
  const ws6 = wb.addWorksheet('FormulaResults')
  ws6.addRow(['label', 'value'])
  const formulaDateRow = ws6.addRow(['launch', null])
  formulaDateRow.getCell(2).value = { formula: 'A1', result: new Date(Date.UTC(2025, 0, 1)) }
  const formulaErrorRow = ws6.addRow(['broken', null])
  formulaErrorRow.getCell(2).value = { formula: 'A1/0', result: { error: '#N/A' } }
  // Plain (non-formula) error cell, e.g. #N/A entered directly rather than produced by a
  // formula -- shaped `{ error: '#N/A' }` with no richText/result/text key (regression test
  // for cellText falling through to `String(cell.value)` and producing "[object Object]").
  const plainErrorRow = ws6.addRow(['direct-error', null])
  plainErrorRow.getCell(2).value = { error: '#N/A' }
  // Sheet where the last data row has empty trailing cells, so `row.eachCell` stops earlier
  // than the sheet's actual width (regression test for sheetToCsv producing ragged CSV rows
  // that csv-parse's strict column-count check rejects with "Invalid Record Length").
  const ws7 = wb.addWorksheet('Ragged')
  ws7.addRow(['a', 'b', 'c', 'd', 'e'])
  ws7.addRow(['1', '2', '3', '4', '5'])
  ws7.addRow(['6', '7', '8'])
  // A never-written sheet (no rows at all). usedRange used to floor this to A1:A1 / 1x1,
  // announcing one phantom cell that xlsx-head then returned nothing for -- the two commands
  // disagreed. It must report as empty (ref '(empty)', 0 rows, 0 cols) instead.
  wb.addWorksheet('Blank')
  await wb.xlsx.writeFile(file)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listSheets', () => {
  it('lists sheet names with dimensions', async () => {
    const sheets = await listSheets(file)
    expect(sheets.map((s) => s.name)).toEqual([
      'Employees',
      'Empty',
      'WideData',
      'Dates',
      'Gaps',
      'FormulaResults',
      'Ragged',
      'Blank',
    ])
    const employees = sheets.find((s) => s.name === 'Employees')
    expect(employees?.rows).toBe(4)
    expect(employees?.cols).toBe(3)
  })

  it('reports the true row extent for a sheet with an interior blank row', async () => {
    const sheets = await listSheets(file)
    const gaps = sheets.find((s) => s.name === 'Gaps')
    expect(gaps?.rows).toBe(4)
  })

  it('reports a never-written sheet as empty rather than a phantom 1x1 cell', async () => {
    const sheets = await listSheets(file)
    const blank = sheets.find((s) => s.name === 'Blank')
    expect(blank?.rows, 'an empty sheet has zero rows, not a floored 1').toBe(0)
    expect(blank?.cols, 'an empty sheet has zero cols, not a floored 1').toBe(0)
    expect(blank?.ref).toBe('(empty)')
  })

  // Regression: a non-.xlsx/corrupt file forwarded jszip's raw internal parse error ("Can't
  // find end of central directory : is this a zip file ? If it is, see
  // https://stuk.github.io/jszip/documentation/howto/read_zip.html") straight to the CLI user
  // instead of a clean message. loadWorkbook (shared by listSheets/headSheet/rangeSheet/
  // querySheet) now catches that and re-throws a clear "not a valid .xlsx file" error.
  it('throws a clean error instead of leaking the raw jszip parse error for a non-zip file', async () => {
    const notXlsx = path.join(dir, 'plain-text.xlsx')
    fs.writeFileSync(notXlsx, 'this is plain text, not a zip file\n')
    await expect(listSheets(notXlsx)).rejects.toThrow(`not a valid .xlsx file: ${notXlsx}`)
    await expect(listSheets(notXlsx)).rejects.not.toThrow(/central directory|jszip/i)
  })
})

describe('headSheet', () => {
  it('returns the header row and up to N data rows as CSV text', async () => {
    const text = await headSheet(file, 'Employees', 2)
    const lines = text.split('\n')
    expect(lines[0]).toBe('name,age,dept')
    expect(lines[1]).toBe('Alice,30,Eng')
    expect(lines[2]).toBe('Bob,25,Sales')
    expect(text).toContain('more rows elided')
  })

  it('throws a clear error for an unknown sheet', async () => {
    await expect(headSheet(file, 'Nope', 10)).rejects.toThrow(/unknown sheet/)
  })

  // Regression: header and each data row were padded independently to Math.max(header.length,
  // row.length) -- a per-row floor derived only from the header's own width -- instead of the
  // sheet-wide widest-row column count. A row wider than the header kept its extra trailing
  // columns with no corresponding header column, and different data rows ended up with
  // different line widths from each other and from the header, desyncing which value belongs
  // to which column. Header and every row must now pad to the sheet's actual used-column-count
  // (WideData's widest row is 4 columns), same fix sheetToCsv already applies.
  it('pads the header and every data row to the sheet-wide widest-row column count, not just the header width', async () => {
    const text = await headSheet(file, 'WideData', 10)
    const lines = text.split('\n')
    // Header padded from 2 columns to the sheet-wide max of 4
    expect(lines[0]).toBe('col1,col2,,')
    // First data row already has 4 columns
    expect(lines[1]).toBe('a,b,c,d')
    // Second data row has 3 columns: padded to 4, not left ragged against the header
    expect(lines[2]).toBe('x,y,z,')
  })

  // Regression: cellText fell through to `String(cell.value)` for any non-rich/non-formula
  // cell, and ExcelJS returns native Date objects for date-formatted cells -- so a date cell
  // rendered as a full JS locale string (e.g. "Wed Jan 01 2025 00:00:00 GMT...") instead of a
  // clean formatted date. cellText must prefer ExcelJS's pre-formatted `cell.text` instead.
  it('renders a date-formatted cell as a clean date, not a JS locale string', async () => {
    const text = await headSheet(file, 'Dates', 10)
    const lines = text.split('\n')
    expect(lines[0]).toBe('event,when')
    expect(lines[1]).toBe('Launch,2025-01-01')
    expect(lines[1]).not.toContain('GMT')
    expect(lines[1]).not.toContain('Coordinated Universal Time')
  })

  // Regression: a formula cell's cached result can itself be a Date or an error object.
  // cellText's object/formula branch stringified `obj.result` directly, so a Date result
  // produced a JS locale string (not the clean ISO format the plain-Date branch already
  // produces) and an error-shaped result (`{error: '#N/A'}`) produced the literal text
  // "[object Object]".
  it('renders a formula cell whose cached result is a Date as a clean date, not a locale string', async () => {
    const text = await headSheet(file, 'FormulaResults', 10)
    const lines = text.split('\n')
    expect(lines[0]).toBe('label,value')
    expect(lines[1]).toBe('launch,2025-01-01')
    expect(lines[1]).not.toContain('GMT')
    expect(lines[1]).not.toContain('Coordinated Universal Time')
  })

  it('renders a formula cell whose cached result is an error object as the error text, not [object Object]', async () => {
    const text = await headSheet(file, 'FormulaResults', 10)
    const lines = text.split('\n')
    expect(lines[2]).toBe('broken,#N/A')
    expect(lines[2]).not.toContain('[object Object]')
  })

  it('renders a plain (non-formula) error cell as the error text, not [object Object]', async () => {
    const text = await headSheet(file, 'FormulaResults', 10)
    const lines = text.split('\n')
    expect(lines[3]).toBe('direct-error,#N/A')
    expect(lines[3]).not.toContain('[object Object]')
  })

  it('does not drop a trailing data row that comes after an interior blank row', async () => {
    const text = await headSheet(file, 'Gaps', 10)
    const lines = text.split('\n')
    expect(lines[0]).toBe('name,value')
    expect(lines[1]).toBe('first,1')
    expect(lines).toContain('last,2')
  })
})

describe('rangeSheet', () => {
  it('extracts a bounded cell range with computed values by default', async () => {
    const result = await rangeSheet(file, 'Employees', 'A1:B3', false)
    expect(formatXlsxRange(result)).toBe('A,B\nname,age\nAlice,30\nBob,25')
  })

  it('shows a formula instead of the computed value when --formulas is set', async () => {
    const result = await rangeSheet(file, 'Employees', 'A2:B2', true)
    expect(formatXlsxRange(result)).toBe('A,B\nAlice,"=SUM(29,1)"')
  })

  // Regression: a reversed range (start corner below/right of the end corner) decoded to a
  // start row/col greater than the end row/col, so the r <= e.r / c <= e.c iteration loops
  // never executed -- silently producing an empty result instead of the requested data, with
  // no signal that the range order was backwards. Excel treats a reversed selection as
  // equivalent to its normalized form, so rangeSheet must too.
  it('normalizes a reversed range to the same result as its forward form', async () => {
    const forward = await rangeSheet(file, 'Employees', 'A1:B3', false)
    const reversed = await rangeSheet(file, 'Employees', 'B3:A1', false)
    expect(formatXlsxRange(reversed)).toBe(formatXlsxRange(forward))
    expect(formatXlsxRange(reversed)).toBe('A,B\nname,age\nAlice,30\nBob,25')
  })
})

describe('querySheet', () => {
  it('filters rows via the shared queryCsv equality filter', async () => {
    const result = await querySheet(file, 'Employees', { wheres: [{ column: 'dept', op: '=', value: 'Eng' }] })
    expect(result.rows).toEqual([
      ['Alice', '30', 'Eng'],
      ['Carol', '40', 'Eng'],
    ])
  })

  it('projects a subset of columns', async () => {
    const result = await querySheet(file, 'Employees', { columns: ['name'] })
    expect(result.header).toEqual(['name'])
    expect(result.rows).toEqual([['Alice'], ['Bob'], ['Carol']])
  })

  // Regression: sheetToCsv emitted each row only up to that row's own last non-empty column,
  // so a row with empty/unset trailing cells produced fewer CSV fields than the header --
  // csv-parse's default strict column-count check then threw "Invalid Record Length" instead
  // of returning results.
  it('does not throw on a sheet where a data row has empty trailing cells', async () => {
    const result = await querySheet(file, 'Ragged', {})
    expect(result.header).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.rows).toEqual([
      ['1', '2', '3', '4', '5'],
      ['6', '7', '8', '', ''],
    ])
  })
})
