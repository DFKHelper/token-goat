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
  await wb.xlsx.writeFile(file)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listSheets', () => {
  it('lists sheet names with dimensions', async () => {
    const sheets = await listSheets(file)
    expect(sheets.map((s) => s.name)).toEqual(['Employees', 'Empty', 'WideData', 'Dates', 'Gaps'])
    const employees = sheets.find((s) => s.name === 'Employees')
    expect(employees?.rows).toBe(4)
    expect(employees?.cols).toBe(3)
  })

  it('reports the true row extent for a sheet with an interior blank row', async () => {
    const sheets = await listSheets(file)
    const gaps = sheets.find((s) => s.name === 'Gaps')
    expect(gaps?.rows).toBe(4)
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

  it('preserves data cells beyond the header column count', async () => {
    const text = await headSheet(file, 'WideData', 10)
    const lines = text.split('\n')
    // Header has 2 columns
    expect(lines[0]).toBe('col1,col2')
    // First data row has 4 columns: should not truncate to 2
    expect(lines[1]).toBe('a,b,c,d')
    // Second data row has 3 columns: should preserve all 3
    expect(lines[2]).toBe('x,y,z')
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
})
