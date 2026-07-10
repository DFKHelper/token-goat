/**
 * Excel (.xlsx) narrow-slice reader, via ExcelJS (`exceljs` on npm). Follows the
 * loadPdfjs() optional-dependency template: module-level cache, try/catch import, a clear
 * "not installed" error on first real use rather than a crash.
 */

import { quoteCsvCell, queryCsv, type CsvQueryOptions, type CsvQueryResult } from './csv_query.js'

interface ExcelCell {
  value: unknown
  text: string
  formula?: string
}

interface ExcelRow {
  values: unknown[]
  eachCell: (opts: { includeEmpty: boolean }, cb: (cell: ExcelCell, colNumber: number) => void) => void
}

interface ExcelWorksheet {
  name: string
  rowCount: number
  columnCount: number
  actualRowCount: number
  getRow: (r: number) => ExcelRow
  getCell: (addr: string) => ExcelCell
}

interface ExcelWorkbook {
  worksheets: ExcelWorksheet[]
  getWorksheet: (name: string) => ExcelWorksheet | undefined
  xlsx: {
    readFile: (path: string) => Promise<unknown>
  }
}

interface ExcelJSModule {
  Workbook: new () => ExcelWorkbook
}

let _exceljsCache: ExcelJSModule | null | undefined

async function loadExcelJs(): Promise<ExcelJSModule | null> {
  if (_exceljsCache !== undefined) return _exceljsCache
  try {
    const mod = (await import('exceljs')) as unknown as { default?: ExcelJSModule } & ExcelJSModule
    _exceljsCache = mod.default ?? mod
  } catch (err) {
    process.stderr.write(`token-goat: xlsx reading disabled (exceljs package unavailable): ${String(err)}\n`)
    _exceljsCache = null
  }
  return _exceljsCache
}

async function requireExcelJs(): Promise<ExcelJSModule> {
  const mod = await loadExcelJs()
  if (!mod) throw new Error('exceljs is not installed; run `npm install exceljs` to enable this command')
  return mod
}

async function loadWorkbook(filePath: string): Promise<ExcelWorkbook> {
  const ExcelJS = await requireExcelJs()
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.readFile(filePath)
  } catch (err) {
    // ExcelJS's own "File not found: <path>" message (thrown before it ever touches the
    // underlying jszip parser) is already clean and useful -- pass it through unchanged.
    // Anything else here is jszip's raw internal parse error surfacing through ExcelJS for a
    // non-.xlsx or corrupt file (e.g. "Can't find end of central directory : is this a zip
    // file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html"),
    // which leaks library internals and a docs URL straight to the CLI user instead of a clear
    // message. Shared by every xlsx-* command (listSheets, headSheet, rangeSheet, querySheet
    // all call loadWorkbook), so this one fix covers all four.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('File not found:')) throw err
    throw new Error(`not a valid .xlsx file: ${filePath}`, { cause: err })
  }
  return wb
}

function requireSheet(wb: ExcelWorkbook, sheetName: string): ExcelWorksheet {
  const ws = wb.getWorksheet(sheetName)
  if (ws === undefined) {
    throw new Error(`unknown sheet: ${sheetName} (available: ${wb.worksheets.map((s) => s.name).join(', ')})`)
  }
  return ws
}

// --- A1-notation helpers (hand-rolled: ExcelJS exposes no public decode_range/encode_cell util) ---

function colLettersToIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n // 1-indexed, matching ExcelJS column numbers
}

function indexToColLetters(idx: number): string {
  let n = idx
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function decodeCellRef(ref: string): { r: number; c: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim())
  if (!m) throw new Error(`invalid cell reference: ${ref}`)
  return { c: colLettersToIndex(m[1]!), r: parseInt(m[2]!, 10) }
}

function decodeRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const parts = ref.split(':')
  const startRef: string = parts[0] !== undefined && parts[0] !== '' ? parts[0] : ref
  const endRef: string = parts[1] !== undefined && parts[1] !== '' ? parts[1] : startRef
  const start = decodeCellRef(startRef)
  const end = decodeCellRef(endRef)
  return { s: start, e: end }
}

function encodeCell(cell: { r: number; c: number }): string {
  return `${indexToColLetters(cell.c)}${cell.r}`
}

function cellText(cell: ExcelCell): string {
  if (cell.value === null || cell.value === undefined) return ''
  const v = cell.value as { result?: unknown; text?: unknown; richText?: { text: string }[] } | unknown
  if (typeof v === 'object' && v !== null) {
    const obj = v as { result?: unknown; text?: unknown; richText?: { text: string }[] }
    if (Array.isArray(obj.richText)) return obj.richText.map((t) => t.text).join('')
    if (obj.result !== undefined) return String(obj.result)
    if (obj.text !== undefined) return String(obj.text)
  }
  return String(cell.value)
}

function cellFormula(cell: ExcelCell): string | undefined {
  const v = cell.value as { formula?: string } | unknown
  if (typeof v === 'object' && v !== null) {
    const obj = v as { formula?: string }
    if (typeof obj.formula === 'string') return obj.formula
  }
  return undefined
}

/** Compute the used range of a worksheet as {rows, cols} plus an A1:X#-style ref string. */
function usedRange(ws: ExcelWorksheet): { ref: string; rows: number; cols: number } {
  let maxCol = 0
  const rowCount = ws.actualRowCount || ws.rowCount || 0
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
      if (colNumber > maxCol) maxCol = colNumber
    })
  }
  const rows = rowCount
  const cols = maxCol
  const ref = rows > 0 && cols > 0 ? `A1:${indexToColLetters(cols)}${rows}` : 'A1:A1'
  return { ref, rows: Math.max(rows, 1), cols: Math.max(cols, 1) }
}

export interface SheetInfo {
  name: string
  ref: string
  rows: number
  cols: number
}

export async function listSheets(filePath: string): Promise<SheetInfo[]> {
  const wb = await loadWorkbook(filePath)
  return wb.worksheets.map((ws) => {
    const { ref, rows, cols } = usedRange(ws)
    return { name: ws.name, ref, rows, cols }
  })
}

export async function headSheet(filePath: string, sheetName: string, rows: number): Promise<string> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  const rowCount = ws.actualRowCount || ws.rowCount || 0
  const aoa: string[][] = []
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    let maxCol = 0
    row.eachCell({ includeEmpty: false }, (_c, colNumber) => {
      if (colNumber > maxCol) maxCol = colNumber
    })
    const rowVals: string[] = []
    for (let c = 1; c <= maxCol; c++) {
      rowVals.push(cellText(ws.getCell(encodeCell({ r, c }))))
    }
    aoa.push(rowVals)
  }
  const header = (aoa[0] ?? []).map((c) => String(c ?? ''))
  const dataRows = aoa.slice(1, 1 + rows).map((r) => {
    const cellCount = Math.max(header.length, r.length)
    return Array.from({ length: cellCount }, (_, i) => String(r[i] ?? ''))
  })
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
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  const range = decodeRange(rangeSpec)
  const rowsOut: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const rowOut: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = encodeCell({ r, c })
      const cell = ws.getCell(addr)
      if (showFormulas && cellFormula(cell) !== undefined) {
        rowOut.push(`=${cellFormula(cell)}`)
      } else {
        rowOut.push(cellText(cell))
      }
    }
    rowsOut.push(rowOut)
  }
  const colLabels = rowsOut[0]?.map((_, i) => indexToColLetters(range.s.c + i)) ?? []
  return { header: colLabels, rows: rowsOut }
}

export function formatXlsxRange(result: XlsxRangeResult): string {
  const lines = [result.header.map(quoteCsvCell).join(',')]
  for (const r of result.rows) lines.push(r.map(quoteCsvCell).join(','))
  return lines.join('\n')
}

/** Hand-rolled sheet_to_csv equivalent: ExcelJS has no direct API for this. */
async function sheetToCsv(ws: ExcelWorksheet): Promise<string> {
  const rowCount = ws.actualRowCount || ws.rowCount || 0
  const lines: string[] = []
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    let maxCol = 0
    row.eachCell({ includeEmpty: false }, (_c, colNumber) => {
      if (colNumber > maxCol) maxCol = colNumber
    })
    const vals: string[] = []
    for (let c = 1; c <= maxCol; c++) {
      vals.push(cellText(ws.getCell(encodeCell({ r, c }))))
    }
    lines.push(vals.map(quoteCsvCell).join(','))
  }
  return lines.join('\n')
}

export async function querySheet(filePath: string, sheetName: string, opts: CsvQueryOptions): Promise<CsvQueryResult> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  const csvText = await sheetToCsv(ws)
  return queryCsv(csvText, opts)
}
