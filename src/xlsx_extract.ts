/**
 * Excel (.xlsx) narrow-slice reader. Reads the OOXML container directly through
 * `xlsx_reader.ts`, which shares the zip+XML core in `ooxml_extract.ts` with the .docx and
 * .pptx readers -- so the size cap, the not-a-file guard and the path-leak-safe error messages
 * are one implementation rather than three.
 */

import { quoteCsvCell, queryCsv, type CsvQueryOptions, type CsvQueryResult } from './csv_query.js'
import { readXlsxWorkbook, type ExcelCell, type ExcelWorksheet, type ExcelWorkbook } from './xlsx_reader.js'

const loadWorkbook: (filePath: string) => Promise<ExcelWorkbook> = readXlsxWorkbook

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
  // A reversed range (e.g. B5:A1, where the start corner is below/right of the end corner) must not silently produce zero rows: the r <= e.r / c <= e.c loops in rangeSheet would never execute, returning an empty result that looks identical to "this range covers no data". Excel itself treats a reversed selection as equivalent to its normalized form, so normalize per axis here rather than error -- callers get the data they asked for either way.
  return {
    s: { r: Math.min(start.r, end.r), c: Math.min(start.c, end.c) },
    e: { r: Math.max(start.r, end.r), c: Math.max(start.c, end.c) },
  }
}

function encodeCell(cell: { r: number; c: number }): string {
  return `${indexToColLetters(cell.c)}${cell.r}`
}

// ExcelJS returns a native JS `Date` for date-formatted cells, and (unlike other cell types) its own `cell.text` getter does NOT apply the cell's number format for dates -- it just calls `.toString()` on the Date internally, so relying on `cell.text` here would still emit the same full locale string (e.g. "Wed Jan 01 2025 00:00:00 GMT+0000 (Coordinated Universal Time)") this fix exists to avoid. Format directly instead: a clean ISO date when the value carries no time-of-day component (the common case for a date-formatted cell), a full ISO datetime otherwise.
function formatDateCell(d: Date): string {
  const isDateOnly =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
  return isDateOnly ? d.toISOString().slice(0, 10) : d.toISOString()
}

function cellText(cell: ExcelCell): string {
  if (cell.value === null || cell.value === undefined) return ''
  if (cell.value instanceof Date) return formatDateCell(cell.value)
  const v = cell.value as { result?: unknown; text?: unknown; richText?: { text: string }[] } | unknown
  if (typeof v === 'object' && v !== null) {
    const obj = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; error?: unknown }
    if (Array.isArray(obj.richText)) return obj.richText.map((t) => t.text).join('')
    // A plain (non-formula) error cell, e.g. #N/A entered directly, is shaped `{ error: '#N/A' }` with no richText/result/text key. Return the error text directly instead of falling through to the generic text/String(value) path below, which would stringify the object itself.
    if (typeof obj.error === 'string') return obj.error
    if (obj.result !== undefined) {
      if (obj.result instanceof Date) return formatDateCell(obj.result)
      if (typeof obj.result === 'object' && obj.result !== null && typeof (obj.result as { error?: unknown }).error === 'string') {
        return (obj.result as { error: string }).error
      }
      return String(obj.result)
    }
    if (obj.text !== undefined) return String(obj.text)
  }
  // Plain (non-rich, non-formula, non-Date) values: prefer ExcelJS's pre-formatted display text (`cell.text`) over stringifying the raw value, e.g. so a number's display formatting (thousands separators, currency symbols) survives.
  return cell.text !== '' ? cell.text : String(cell.value)
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
  const rowCount = ws.rowCount || 0
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
  const rowCount = ws.rowCount || 0
  const aoa: string[][] = []
  // Track the sheet-wide max column inline during this row scan instead of calling usedRange(ws) afterward, which would redo an identical full eachCell pass over every row just to recompute the same maximum this loop already sees one row at a time.
  let sheetCols = 0
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r)
    let maxCol = 0
    row.eachCell({ includeEmpty: false }, (_c, colNumber) => {
      if (colNumber > maxCol) maxCol = colNumber
    })
    if (maxCol > sheetCols) sheetCols = maxCol
    const rowVals: string[] = []
    for (let c = 1; c <= maxCol; c++) {
      rowVals.push(cellText(ws.getCell(encodeCell({ r, c }))))
    }
    aoa.push(rowVals)
  }
  // Pad the header AND every data row to the sheet's actual used-column-count (same fix sheetToCsv already applies below) rather than to the header's own width - a data row wider than the header (e.g. trailing notes columns) must still line up under a header cell, or the CSV output desyncs which value belongs to which column.
  const header = Array.from({ length: sheetCols }, (_, i) => String(aoa[0]?.[i] ?? ''))
  const dataRows = aoa.slice(1, 1 + rows).map((r) =>
    Array.from({ length: sheetCols }, (_, i) => String(r[i] ?? '')),
  )
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
  const rowCount = ws.rowCount || 0
  // Every emitted row must have the same field count, or csv-parse's default strict mode throws "Invalid Record Length" on any row that happens to have empty trailing cells (row.eachCell({includeEmpty:false}) stops at that row's own last populated column, which is not necessarily the sheet's widest column). Pad every row out to the sheet's actual used-column-count, same as headSheet does.
  const { cols: sheetCols } = usedRange(ws)
  const lines: string[] = []
  for (let r = 1; r <= rowCount; r++) {
    const vals: string[] = []
    for (let c = 1; c <= sheetCols; c++) {
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
