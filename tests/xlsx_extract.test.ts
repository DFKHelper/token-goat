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
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['name', 'age', 'dept'],
    ['Alice', 30, 'Eng'],
    ['Bob', 25, 'Sales'],
    ['Carol', 40, 'Eng'],
  ])
  ;(ws['B2'] as { f?: string }).f = 'SUM(29,1)'
  XLSX.utils.book_append_sheet(wb, ws, 'Employees')
  const ws2 = XLSX.utils.aoa_to_sheet([['q', 'revenue']])
  XLSX.utils.book_append_sheet(wb, ws2, 'Empty')
  XLSX.writeFile(wb, file)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listSheets', () => {
  it('lists sheet names with dimensions', async () => {
    const sheets = await listSheets(file)
    expect(sheets.map((s) => s.name)).toEqual(['Employees', 'Empty'])
    const employees = sheets.find((s) => s.name === 'Employees')
    expect(employees?.rows).toBe(4)
    expect(employees?.cols).toBe(3)
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
