/** Excel (.xlsx) narrow-slice reader. Reads the OOXML container directly through `xlsx_reader.ts`, which shares the zip+XML core in `ooxml_extract.ts` with the .docx and .pptx readers -- so the size cap, the not-a-file guard and the path-leak-safe error messages are one implementation rather than three. */

import { DocumentRefusedError } from './document_refusal.js'
import { assertOoxmlWithinDeadline, ooxmlWorkDeadline } from './ooxml_extract.js'
import { displaySafeText } from './paths.js'
import { quoteCsvCell, queryCsv, type CsvQueryOptions, type CsvQueryResult } from './csv_query.js'
import { readXlsxWorkbook, type ExcelCell, type ExcelWorksheet, type ExcelWorkbook } from './xlsx_reader.js'

const loadWorkbook: (filePath: string, deadline?: number) => Promise<ExcelWorkbook> = readXlsxWorkbook

function requireSheet(wb: ExcelWorkbook, sheetName?: string): ExcelWorksheet {
  if (sheetName !== undefined && sheetName.trim() !== '') {
    const ws = wb.getWorksheet(sheetName)
    if (ws === undefined) {
      throw new Error(`unknown sheet: ${sheetName} (available: ${wb.worksheets.map((s) => s.name).join(', ')})`)
    }
    return ws
  }
  const first = wb.worksheets[0]
  if (first === undefined) {
    throw new Error('workbook contains no worksheets')
  }
  return first
}

// ws.rowCount and ws.columnCount come straight from the highest row/column number declared in any populated cell's `r="..."` attribute in the sheet XML (xlsx_reader.ts's parseSheet); OOXML allows up to 2^20 rows by 2^14 columns, and a single cell placed at that far corner is enough to declare it, cheaply, in an otherwise tiny file. A full scan of the declared range (as usedRange/headSheet/sheetToCsv all do) is then quadratic in numbers the file merely states, not in anything it actually contains. This ceiling rejects that before the scan starts rather than after it has spent seconds to minutes finding almost nothing there.
const MAX_XLSX_SCAN_CELLS = 20_000_000

/** Thrown when a declared or requested cell extent is past {@link MAX_XLSX_SCAN_CELLS}. A DocumentRefusedError, not a plain one, for the same reason the zip size caps are: the extent comes from the sheet, so the answer is the same every time the indexer looks, and a transient-looking failure has it re-open the workbook on every pass forever. */
export class XlsxScanTooLargeError extends DocumentRefusedError {
  constructor(extent: string, cells: number, hint: string) {
    super(`${extent} (${cells.toLocaleString()} cells), over the ${MAX_XLSX_SCAN_CELLS.toLocaleString()}-cell scan limit; ${hint}`, 'XlsxScanTooLargeError')
  }
}

/** One ceiling for both extents a cell scan can be driven by, because both cost the same per cell. `assertScannableExtent` bounds the extent the FILE declares; `rangeSheet` bounds the one the CALLER asks for. Only the first existed, so `--range A1:XFD1048576` -- 17,179,869,184 cells, all of them accumulating a string -- reached no guard at all and exhausted the heap. */
function assertCellCount(cells: number, extent: string, hint: string): void {
  if (cells > MAX_XLSX_SCAN_CELLS) throw new XlsxScanTooLargeError(extent, cells, hint)
}

function assertScannableExtent(ws: ExcelWorksheet): void {
  assertCellCount(
    (ws.rowCount || 0) * (ws.columnCount || 0),
    `sheet "${ws.name}" declares a used range of ${ws.rowCount} rows x ${ws.columnCount} cols`,
    'read a bounded range with xlsx-range --range',
  )
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
  assertScannableExtent(ws)
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
  // A never-written sheet has no cells, and flooring it to A1:A1 / 1x1 announced one phantom cell
  // that xlsx-head correctly returns nothing for. Report it as empty so the two commands agree.
  if (rows === 0 || cols === 0) {
    return { ref: '(empty)', rows: 0, cols: 0 }
  }
  return { ref: `A1:${indexToColLetters(cols)}${rows}`, rows, cols }
}

export interface SheetInfo {
  name: string
  ref: string
  rows: number
  cols: number
}

export async function listSheets(filePath: string, deadline: number = ooxmlWorkDeadline()): Promise<SheetInfo[]> {
  // Passed down rather than letting loadWorkbook open its own: the sheet loop inside the reader and the extent walk below are two halves of one document's work, and two clocks over one document is twice the bound this file is supposed to be under.
  const wb = await loadWorkbook(filePath, deadline)
  return wb.worksheets.map((ws) => {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to specific sheets with xlsx-head, or use a smaller workbook.')
    const { ref, rows, cols } = usedRange(ws)
    return { name: ws.name, ref, rows, cols }
  })
}

/** The actual per-sheet head extraction, given a worksheet the caller already has (from a workbook it may be reusing across sheets). Split out of headSheet so a bulk walk over every sheet (allSheetsHeadText) can load the workbook once instead of each sheet re-triggering loadWorkbook's own full archive read and re-parse of every other sheet in the file. */
function headSheetFromWorksheet(ws: ExcelWorksheet, rows: number, columns?: string[]): string {
  assertScannableExtent(ws)
  const rowCount = ws.rowCount || 0
  // The sheet-wide used-column count, taken from the worksheet rather than recomputed. An earlier version tracked this maximum inline while walking every row, which is what forced the whole sheet to be read for a preview of a few lines of it: `xlsx-head --rows 5` and `--rows 20` on a 550,000-row sheet both took about five seconds, because the cost was the scan and not the rows asked for. readXlsxWorkbook already records the maximum while parsing the sheet (see parseSheetXml), so reading it here costs nothing and is the same number -- verified equal to a full scan on a sheet whose widest row is its last.
  const sheetCols = ws.columnCount || 0
  // Header plus exactly the data rows requested. Everything past this was built and then dropped by the slice below.
  const scanRows = Math.min(rowCount, rows + 1)
  const aoa: string[][] = []
  for (let r = 1; r <= scanRows; r++) {
    const rowVals: string[] = []
    for (let c = 1; c <= sheetCols; c++) {
      rowVals.push(cellText(ws.getCell(encodeCell({ r, c }))))
    }
    aoa.push(rowVals)
  }
  // Pad the header AND every data row to the sheet's actual used-column-count (same fix sheetToCsv already applies below) rather than to the header's own width - a data row wider than the header (e.g. trailing notes columns) must still line up under a header cell, or the CSV output desyncs which value belongs to which column.
  let header = Array.from({ length: sheetCols }, (_, i) => String(aoa[0]?.[i] ?? ''))
  let dataRows = aoa.slice(1, 1 + rows).map((r) =>
    Array.from({ length: sheetCols }, (_, i) => String(r[i] ?? '')),
  )

  if (columns !== undefined && columns.length > 0) {
    const normCols = columns.map((c) => c.trim()).filter(Boolean)
    const selectedIndices: number[] = []
    for (const req of normCols) {
      let idx = header.findIndex((h) => h === req)
      if (idx === -1) {
        idx = header.findIndex((h) => h.toLowerCase() === req.toLowerCase())
      }
      if (idx === -1 && /^[A-Za-z]+$/.test(req)) {
        const colNum = colLettersToIndex(req)
        if (colNum >= 1 && colNum <= sheetCols) {
          idx = colNum - 1
        }
      }
      if (idx !== -1 && !selectedIndices.includes(idx)) {
        selectedIndices.push(idx)
      } else if (idx === -1) {
        throw new Error(`unknown column: ${req} (available: ${header.filter(Boolean).join(', ')})`)
      }
    }
    header = selectedIndices.map((i) => header[i] ?? '')
    dataRows = dataRows.map((r) => selectedIndices.map((i) => r[i] ?? ''))
  }

  const lines = [header.map(quoteCsvCell).join(',')]
  for (const r of dataRows) lines.push(r.map(quoteCsvCell).join(','))
  // From rowCount, not from aoa: the scan no longer reaches the end of the sheet, and the count of what was left out is exactly what a truncated scan cannot see. The old expression was `aoa.length - 1`, which was equal to this only because the loop above visited every row.
  if (rowCount - 1 > dataRows.length) {
    lines.push(`...(${rowCount - 1 - dataRows.length} more rows elided; use --rows to see more, or xlsx-query for filtering)`)
  }
  return lines.join('\n')
}

export async function headSheet(filePath: string, sheetName?: string, rows = 20, columns?: string[]): Promise<string> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  return headSheetFromWorksheet(ws, rows, columns)
}

/** Every sheet's head text from one archive read, for callers that need the whole workbook rather than one sheet at a time (the embeddings pipeline via doc_embed_extract.ts). Looping headSheet itself once per sheet used to cost one full archive read-and-reparse of EVERY sheet per sheet requested -- listSheets's own workbook load plus one more per sheet, none of it cached -- because loadWorkbook has no cache and nothing bounded how many sheets a workbook could make it run for. `deadline` defaults to a fresh {@link ooxmlWorkDeadline} so a caller can pass one down across several documents (or its own remaining budget) but doesn't have to. */
export async function allSheetsHeadText(filePath: string, rows: number, deadline: number = ooxmlWorkDeadline()): Promise<string> {
  // Same one-clock-per-document reason as listSheets: the reader's own sheet loop is inside this deadline, not beside it.
  const wb = await loadWorkbook(filePath, deadline)
  const sheetTexts: string[] = []
  for (const ws of wb.worksheets) {
    assertOoxmlWithinDeadline(deadline, 'Narrow the read to specific sheets with xlsx-head, or use a smaller workbook.')
    sheetTexts.push(`# Sheet: ${ws.name}\n${headSheetFromWorksheet(ws, rows)}`)
  }
  return sheetTexts.join('\n\n')
}

export interface XlsxRangeResult {
  header: string[]
  rows: string[][]
}

export async function rangeSheet(filePath: string, sheetName: string | undefined, rangeSpec: string, showFormulas: boolean): Promise<XlsxRangeResult> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  const range = decodeRange(rangeSpec)
  const rangeRows = range.e.r - range.s.r + 1
  const rangeCols = range.e.c - range.s.c + 1
  assertCellCount(rangeRows * rangeCols, `range ${rangeSpec} covers ${rangeRows} rows x ${rangeCols} cols`, 'ask for a smaller --range')
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

export async function querySheet(filePath: string, sheetName: string | undefined, opts: CsvQueryOptions): Promise<CsvQueryResult> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  const csvText = await sheetToCsv(ws)
  return queryCsv(csvText, opts)
}

export interface XlsxColumnSummary {
  letter: string
  name: string
  index: number
  nonEmptyRows: number
  sampleRows: number
  sampleValues: string[]
}

export interface XlsxColumnsResult {
  sheetName: string
  totalSheetRows: number
  sampleRows: number
  columns: XlsxColumnSummary[]
}

export async function xlsxColumns(
  filePath: string,
  sheetName?: string,
  sampleLimit = 100,
): Promise<XlsxColumnsResult> {
  const wb = await loadWorkbook(filePath)
  const ws = requireSheet(wb, sheetName)
  assertScannableExtent(ws)
  const rowCount = ws.rowCount || 0
  const { cols: sheetCols } = usedRange(ws)
  if (rowCount === 0 || sheetCols === 0) {
    return { sheetName: ws.name, totalSheetRows: 0, sampleRows: 0, columns: [] }
  }

  const sampleRows = Math.min(Math.max(1, sampleLimit), Math.max(1, rowCount - 1))
  const headers: string[] = []
  for (let c = 1; c <= sheetCols; c++) {
    const val = cellText(ws.getCell(encodeCell({ r: 1, c })))
    headers.push(val || `(col ${indexToColLetters(c)})`)
  }

  const colSummaries: XlsxColumnSummary[] = headers.map((name, i) => ({
    letter: indexToColLetters(i + 1),
    name,
    index: i + 1,
    nonEmptyRows: 0,
    sampleRows,
    sampleValues: [],
  }))

  for (let r = 2; r <= 1 + sampleRows; r++) {
    for (let c = 1; c <= sheetCols; c++) {
      const txt = cellText(ws.getCell(encodeCell({ r, c })))
      if (txt !== '') {
        const summary = colSummaries[c - 1]!
        summary.nonEmptyRows++
        if (summary.sampleValues.length < 3 && !summary.sampleValues.includes(txt)) {
          summary.sampleValues.push(txt)
        }
      }
    }
  }

  return {
    sheetName: ws.name,
    totalSheetRows: Math.max(0, rowCount - 1),
    sampleRows,
    columns: colSummaries,
  }
}

export function formatXlsxColumns(result: XlsxColumnsResult): string {
  if (result.columns.length === 0) return `Sheet "${displaySafeText(result.sheetName)}" is empty`
  const lines = [
    `Sheet: ${displaySafeText(result.sheetName)} (${result.totalSheetRows} data rows, ${result.columns.length} columns; sampled first ${result.sampleRows} rows)`,
  ]
  for (const c of result.columns) {
    const pct = result.sampleRows > 0 ? Math.round((c.nonEmptyRows / c.sampleRows) * 100) : 0
    const samples =
      c.sampleValues.length > 0
        ? ` (e.g. ${c.sampleValues.map((v) => JSON.stringify(v.length > 30 ? v.slice(0, 27) + '...' : v)).join(', ')})`
        : ' (all empty)'
    lines.push(`  ${c.letter.padEnd(4)} ${displaySafeText(c.name).padEnd(25)} ${c.nonEmptyRows}/${c.sampleRows} (${pct}%)${samples}`)
  }
  return lines.join('\n')
}
