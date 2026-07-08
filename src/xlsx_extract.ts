/**
 * Excel (.xlsx/.xls/.ods) narrow-slice reader, via SheetJS (`xlsx` on npm). Follows the
 * loadPdfjs() optional-dependency template: module-level cache, try/catch import, a clear
 * "not installed" error on first real use rather than a crash.
 */

import { quoteCsvCell, queryCsv, type CsvQueryOptions, type CsvQueryResult } from './csv_query.js'

interface CellObject {
  v?: string | number | boolean
  f?: string
  w?: string
}

interface WorkSheet {
  '!ref'?: string
  [cell: string]: CellObject | string | undefined
}

interface WorkBook {
  SheetNames: string[]
  Sheets: Record<string, WorkSheet>
}

interface XlsxUtils {
  decode_range: (ref: string) => { s: { r: number; c: number }; e: { r: number; c: number } }
  encode_cell: (cell: { r: number; c: number }) => string
  sheet_to_json: (ws: WorkSheet, opts?: { header?: 1 }) => unknown[]
  sheet_to_csv: (ws: WorkSheet) => string
}

interface XlsxModule {
  readFile: (path: string) => WorkBook
  utils: XlsxUtils
}

let _xlsxCache: XlsxModule | null | undefined

async function loadXlsx(): Promise<XlsxModule | null> {
  if (_xlsxCache !== undefined) return _xlsxCache
  try {
    _xlsxCache = (await import('xlsx')) as unknown as XlsxModule
  } catch (err) {
    process.stderr.write(`token-goat: xlsx reading disabled (xlsx package unavailable): ${String(err)}\n`)
    _xlsxCache = null
  }
  return _xlsxCache
}

async function requireXlsx(): Promise<XlsxModule> {
  const mod = await loadXlsx()
  if (!mod) throw new Error('xlsx is not installed; run `npm install xlsx` to enable this command')
  return mod
}

async function loadWorkbook(filePath: string): Promise<{ xlsx: XlsxModule; wb: WorkBook }> {
  const xlsx = await requireXlsx()
  const wb = xlsx.readFile(filePath)
  return { xlsx, wb }
}

function requireSheet(xlsx: XlsxModule, wb: WorkBook, sheetName: string): WorkSheet {
  const ws = wb.Sheets[sheetName]
  if (ws === undefined) {
    throw new Error(`unknown sheet: ${sheetName} (available: ${wb.SheetNames.join(', ')})`)
  }
  return ws
}

export interface SheetInfo {
  name: string
  ref: string
  rows: number
  cols: number
}

export async function listSheets(filePath: string): Promise<SheetInfo[]> {
  const { xlsx, wb } = await loadWorkbook(filePath)
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name] as WorkSheet
    const ref = ws['!ref'] ?? 'A1:A1'
    const range = xlsx.utils.decode_range(ref)
    return {
      name,
      ref,
      rows: range.e.r - range.s.r + 1,
      cols: range.e.c - range.s.c + 1,
    }
  })
}

export async function headSheet(filePath: string, sheetName: string, rows: number): Promise<string> {
  const { xlsx, wb } = await loadWorkbook(filePath)
  const ws = requireSheet(xlsx, wb, sheetName)
  const aoa = xlsx.utils.sheet_to_json(ws, { header: 1 }) as unknown[][]
  const header = (aoa[0] ?? []).map((c) => String(c ?? ''))
  const dataRows = aoa.slice(1, 1 + rows).map((r) => header.map((_, i) => String(r[i] ?? '')))
  const lines = [header.map(quoteCsvCell).join(',')]
  for (const r of dataRows) lines.push(r.map(quoteCsvCell).join(','))
  if (aoa.length - 1 > dataRows.length) {
    lines.push(`...(${aoa.length - 1 - dataRows.length} more rows elided; use --rows to see more, or xlsx-query for filtering)`)
  }
  return lines.join('\n')
}

export interface XlsxRangeResult {
  header: string[]
  rows: string[][]
}

export async function rangeSheet(filePath: string, sheetName: string, rangeSpec: string, showFormulas: boolean): Promise<XlsxRangeResult> {
  const { xlsx, wb } = await loadWorkbook(filePath)
  const ws = requireSheet(xlsx, wb, sheetName)
  const range = xlsx.utils.decode_range(rangeSpec)
  const rowsOut: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const rowOut: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = xlsx.utils.encode_cell({ r, c })
      const cell = ws[addr] as CellObject | undefined
      if (cell === undefined) {
        rowOut.push('')
      } else if (showFormulas && cell.f !== undefined) {
        rowOut.push(`=${cell.f}`)
      } else {
        rowOut.push(cell.w ?? String(cell.v ?? ''))
      }
    }
    rowsOut.push(rowOut)
  }
  const colLabels = rowsOut[0]?.map((_, i) => xlsx.utils.encode_cell({ r: 0, c: range.s.c + i }).replace(/\d+$/, '')) ?? []
  return { header: colLabels, rows: rowsOut }
}

export function formatXlsxRange(result: XlsxRangeResult): string {
  const lines = [result.header.map(quoteCsvCell).join(',')]
  for (const r of result.rows) lines.push(r.map(quoteCsvCell).join(','))
  return lines.join('\n')
}

export async function querySheet(filePath: string, sheetName: string, opts: CsvQueryOptions): Promise<CsvQueryResult> {
  const { xlsx, wb } = await loadWorkbook(filePath)
  const ws = requireSheet(xlsx, wb, sheetName)
  const csvText = xlsx.utils.sheet_to_csv(ws)
  return queryCsv(csvText, opts)
}
