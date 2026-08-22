/**
 * Minimal in-house SpreadsheetML (.xlsx) reader.
 *
 * .xlsx is an OOXML zip-of-XML container exactly like .docx and .pptx, both of which this repo
 * already reads with `fflate` + `fast-xml-parser` through `ooxml_extract.ts`. Reading .xlsx the
 * same way removes the only reason `exceljs` was ever installed: 55 packages, and the sole source
 * of every deprecated package in the tree (`inflight`, `lodash.isequal`, `bluebird`, `unzipper`,
 * old `glob`, `tmp`, `fs-extra`, plus eleven `lodash.*` micro-packages).
 *
 * The shapes produced here deliberately match what ExcelJS produced, because `cellText` and
 * `cellFormula` in `xlsx_extract.ts` branch on them and are unchanged: a native `Date` for a
 * date-formatted cell, `{ formula, result }` for a formula cell (whose `result` may itself be a
 * `Date` or `{ error }`), `{ error }` for a directly-entered error cell, and a plain primitive
 * otherwise with `text` carrying the display string.
 */

import { decodeZipEntry, parseOoxmlPart, readOoxmlZip } from './ooxml_extract.js'

export interface ExcelCell {
  value: unknown
  text: string
  formula?: string
}

export interface ExcelRow {
  values: unknown[]
  eachCell: (opts: { includeEmpty: boolean }, cb: (cell: ExcelCell, colNumber: number) => void) => void
}

export interface ExcelWorksheet {
  name: string
  rowCount: number
  columnCount: number
  actualRowCount: number
  getRow: (r: number) => ExcelRow
  getCell: (addr: string) => ExcelCell
}

export interface ExcelWorkbook {
  worksheets: ExcelWorksheet[]
  getWorksheet: (name: string) => ExcelWorksheet | undefined
}

type XmlNode = Record<string, unknown>

const EMPTY_CELL: ExcelCell = Object.freeze({ value: null, text: '' })

/** fast-xml-parser folds repeated sibling elements into an array and a lone one into an object. */
function asArray(val: unknown): XmlNode[] {
  if (val === undefined || val === null) return []
  if (Array.isArray(val)) return val.filter((v) => v !== null && typeof v === 'object') as XmlNode[]
  if (typeof val === 'object') return [val as XmlNode]
  return []
}

/**
 * Text content of an element. With `ignoreAttributes: false`, an element carrying an attribute
 * (`<t xml:space="preserve"> a </t>`) parses to an object with a `#text` key rather than a bare
 * string, so both shapes have to be handled or every whitespace-preserving run reads as empty.
 */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const t = (node as XmlNode)['#text']
  return t === undefined ? '' : String(t)
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (node === undefined) return undefined
  const v = node[`@_${name}`]
  return v === undefined || v === null ? undefined : String(v)
}

function isTruthyAttr(v: string | undefined): boolean {
  return v === '1' || v === 'true'
}

/** Column letters of an A1 reference to a 1-based column index. `B2` -> 2. */
export function refToColumn(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const code = ch.toUpperCase().charCodeAt(0)
    if (code < 65 || code > 90) break
    n = n * 26 + (code - 64)
  }
  return n
}

function refToRow(ref: string): number {
  const m = /(\d+)\s*$/.exec(ref)
  return m ? parseInt(m[1]!, 10) : 0
}

// The builtin number formats Excel reserves for dates and times. 14-22 are the date/time set,
// 45-47 the elapsed-time set. Everything else builtin is numeric, currency, percent or text.
const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/**
 * Whether a custom `formatCode` describes a date or time. Quoted literals, bracketed
 * colour/locale/condition sections and backslash escapes are stripped first, because a literal
 * `"May"` or a `[$-409]` locale tag would otherwise make a plain currency format read as a date.
 */
export function formatCodeIsDate(formatCode: string): boolean {
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  return /[ymdhs]/i.test(stripped)
}

/**
 * Serial number to a UTC `Date`. Two epochs exist: the default 1900 mode where serial 1 is
 * 1900-01-01, and 1904 mode (`workbookPr/@date1904`) where serial 0 is 1904-01-01. The 1900 mode
 * also carries the Lotus 1-2-3 leap-year bug Excel keeps for compatibility: serial 60 is the
 * non-existent 1900-02-29, so every serial from 61 up is one day ahead of the true count and has
 * to be shifted back. Built from UTC because `formatDateCell` reads `getUTCHours()` and friends.
 */
export function serialToDate(serial: number, date1904: boolean): Date {
  if (date1904) return new Date(Date.UTC(1904, 0, 1) + Math.round(serial * 86400000))
  const adjusted = serial >= 61 ? serial - 1 : serial
  return new Date(Date.UTC(1899, 11, 31) + Math.round(adjusted * 86400000))
}

function numberToText(n: number): string {
  return String(n)
}

interface StyleInfo {
  /** Per-`cellXfs` index: does this style format its cell as a date? */
  dateStyles: boolean[]
}

function parseStyles(xml: string | null, parsed: unknown): StyleInfo {
  if (xml === null || parsed === null || typeof parsed !== 'object') return { dateStyles: [] }
  const sheet = (parsed as XmlNode)['styleSheet']
  if (sheet === undefined || sheet === null || typeof sheet !== 'object') return { dateStyles: [] }
  const root = sheet as XmlNode

  const customDateFormats = new Set<number>()
  for (const fmt of asArray((root['numFmts'] as XmlNode | undefined)?.['numFmt'])) {
    const id = Number(attr(fmt, 'numFmtId'))
    const code = attr(fmt, 'formatCode')
    if (Number.isFinite(id) && code !== undefined && formatCodeIsDate(code)) customDateFormats.add(id)
  }

  const dateStyles: boolean[] = []
  for (const xf of asArray((root['cellXfs'] as XmlNode | undefined)?.['xf'])) {
    const id = Number(attr(xf, 'numFmtId') ?? '0')
    dateStyles.push(Number.isFinite(id) && (BUILTIN_DATE_FORMAT_IDS.has(id) || customDateFormats.has(id)))
  }
  return { dateStyles }
}

function parseSharedStrings(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== 'object') return []
  const sst = (parsed as XmlNode)['sst']
  if (sst === undefined || sst === null || typeof sst !== 'object') return []
  return asArray((sst as XmlNode)['si']).map((si) => {
    // A plain string is `<si><t>..</t></si>`; a rich-text one splits into `<si><r><t>..</t></r>..`.
    // `<rPh>` phonetic runs also carry a `<t>` but are a pronunciation guide, not the cell's text,
    // so the runs are read off `r` explicitly rather than by collecting every `t` in the subtree.
    if (si['t'] !== undefined) return textOf(si['t'])
    const runs = asArray(si['r'])
    if (runs.length > 0) return runs.map((r) => textOf(r['t'])).join('')
    return ''
  })
}

/** `rId3` -> the zip path of the part it points at, resolved relative to `xl/`. */
function parseWorkbookRels(parsed: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (parsed === null || typeof parsed !== 'object') return out
  const rels = (parsed as XmlNode)['Relationships']
  if (rels === undefined || rels === null || typeof rels !== 'object') return out
  for (const rel of asArray((rels as XmlNode)['Relationship'])) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id === undefined || target === undefined) continue
    // An absolute target is package-rooted, so it only loses its leading slash; a relative one
    // resolves against the part's own folder, which for xl/workbook.xml is `xl/`.
    const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    out.set(id, normalized)
  }
  return out
}

interface SheetData {
  cells: Map<number, Map<number, ExcelCell>>
  rowCount: number
  columnCount: number
  populatedRows: number
}

function buildCell(
  c: XmlNode,
  shared: string[],
  styles: StyleInfo,
  date1904: boolean,
): ExcelCell | null {
  const type = attr(c, 't') ?? 'n'
  const styleIdx = Number(attr(c, 's') ?? '-1')
  const isDateStyle = Number.isInteger(styleIdx) && styleIdx >= 0 && styles.dateStyles[styleIdx] === true

  const hasV = c['v'] !== undefined
  const hasIs = c['is'] !== undefined
  const fNode = c['f']
  // A shared-formula follower (`<f t="shared" si="0"/>`) carries no formula text of its own. It
  // still has a cached `<v>`, so it is read as a plain value rather than reported as a formula
  // with an empty string, which would render as a bare `=` under --formulas.
  const formula = fNode === undefined ? '' : textOf(fNode)
  if (!hasV && !hasIs && formula === '') return null

  let raw: unknown
  let text: string
  if (type === 's') {
    const idx = Number(textOf(c['v']))
    const s = Number.isInteger(idx) ? (shared[idx] ?? '') : ''
    raw = s
    text = s
  } else if (type === 'inlineStr') {
    const isNode = c['is']
    const s =
      isNode !== undefined && isNode !== null && typeof isNode === 'object'
        ? (() => {
            const node = isNode as XmlNode
            if (node['t'] !== undefined) return textOf(node['t'])
            return asArray(node['r'])
              .map((r) => textOf(r['t']))
              .join('')
          })()
        : textOf(isNode)
    raw = s
    text = s
  } else if (type === 'str') {
    const s = textOf(c['v'])
    raw = s
    text = s
  } else if (type === 'b') {
    const b = textOf(c['v']).trim() === '1'
    raw = b
    text = b ? 'TRUE' : 'FALSE'
  } else if (type === 'e') {
    const e = textOf(c['v'])
    raw = { error: e }
    text = e
  } else {
    const n = Number(textOf(c['v']))
    if (!Number.isFinite(n)) {
      raw = null
      text = ''
    } else if (isDateStyle) {
      const d = serialToDate(n, date1904)
      raw = d
      text = d.toISOString()
    } else {
      raw = n
      text = numberToText(n)
    }
  }

  if (formula !== '') return { value: { formula, result: raw }, text, formula }
  return { value: raw, text }
}

function parseSheet(parsed: unknown, shared: string[], styles: StyleInfo, date1904: boolean): SheetData {
  const cells = new Map<number, Map<number, ExcelCell>>()
  let rowCount = 0
  let columnCount = 0
  let populatedRows = 0
  if (parsed === null || typeof parsed !== 'object') return { cells, rowCount, columnCount, populatedRows }
  const ws = (parsed as XmlNode)['worksheet']
  if (ws === undefined || ws === null || typeof ws !== 'object') return { cells, rowCount, columnCount, populatedRows }
  const sheetData = (ws as XmlNode)['sheetData']
  if (sheetData === undefined || sheetData === null || typeof sheetData !== 'object') {
    return { cells, rowCount, columnCount, populatedRows }
  }

  let fallbackRow = 0
  for (const row of asArray((sheetData as XmlNode)['row'])) {
    const declaredRow = Number(attr(row, 'r'))
    const rowIdx = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow : fallbackRow + 1
    fallbackRow = rowIdx
    let fallbackCol = 0
    const rowCells = new Map<number, ExcelCell>()
    for (const c of asArray(row['c'])) {
      const ref = attr(c, 'r')
      const declaredCol = ref === undefined ? 0 : refToColumn(ref)
      const colIdx = declaredCol > 0 ? declaredCol : fallbackCol + 1
      fallbackCol = colIdx
      const cell = buildCell(c, shared, styles, date1904)
      if (cell === null) continue
      rowCells.set(colIdx, cell)
      if (colIdx > columnCount) columnCount = colIdx
    }
    if (rowCells.size === 0) continue
    cells.set(rowIdx, rowCells)
    populatedRows++
    // The row extent is the highest row that actually holds content. A trailing `<row/>` carrying
    // only a style, or a row of styled-but-valueless cells, is not content: counting it would make
    // every consumer scan past the real data.
    if (rowIdx > rowCount) rowCount = rowIdx
  }
  return { cells, rowCount, columnCount, populatedRows }
}

function makeWorksheet(name: string, data: SheetData): ExcelWorksheet {
  function getRow(r: number): ExcelRow {
    const rowCells = data.cells.get(r)
    return {
      get values(): unknown[] {
        const out: unknown[] = []
        if (rowCells !== undefined) for (const [col, cell] of rowCells) out[col] = cell.value
        return out
      },
      eachCell(opts, cb) {
        if (opts.includeEmpty) {
          // This row's own last populated column, not the sheet-wide maximum. ExcelJS, which this
          // shim stands in for, walks a row out to its own width: on a sheet whose widest row has 9
          // columns, a 4-column row yields 4 cells, not 9. Using the sheet maximum handed every
          // short row a tail of empty cells that the real library never emits. No caller passes
          // includeEmpty today -- every consumer in xlsx_extract.ts passes false -- which is why
          // nothing caught it, and is also why it would have been a trap for the first one that did.
          let maxCol = 0
          if (rowCells !== undefined) for (const c of rowCells.keys()) if (c > maxCol) maxCol = c
          for (let c = 1; c <= maxCol; c++) cb(rowCells?.get(c) ?? EMPTY_CELL, c)
          return
        }
        if (rowCells === undefined) return
        for (const col of [...rowCells.keys()].sort((a, b) => a - b)) cb(rowCells.get(col)!, col)
      },
    }
  }
  return {
    name,
    rowCount: data.rowCount,
    columnCount: data.columnCount,
    actualRowCount: data.populatedRows,
    getRow,
    getCell(addr: string): ExcelCell {
      return data.cells.get(refToRow(addr))?.get(refToColumn(addr)) ?? EMPTY_CELL
    },
  }
}

/**
 * Reads a .xlsx file into the workbook shape `xlsx_extract.ts` consumes.
 *
 * The zip is opened through `readOoxmlZip`, which already carries the input size cap, the
 * not-a-file guard, and the message shapes that stop a bare filename echoing the reader's home
 * directory back at the caller -- rather than a second zip reader repeating all three.
 */
export async function readXlsxWorkbook(filePath: string): Promise<ExcelWorkbook> {
  const entries = await readOoxmlZip(filePath, '.xlsx')

  const workbookXml = decodeZipEntry(entries, 'xl/workbook.xml')
  // A zip that opens fine but holds no workbook part is not a spreadsheet. Answered with the same
  // message a non-zip file gets, rather than letting a missing-part TypeError reach the CLI user.
  if (workbookXml === null) throw new Error(`not a valid .xlsx file: ${filePath}`)

  const workbookRoot = await parseOoxmlPart(workbookXml)
  const wbNode = (workbookRoot as XmlNode | null)?.['workbook']
  if (wbNode === undefined || wbNode === null || typeof wbNode !== 'object') {
    throw new Error(`not a valid .xlsx file: ${filePath}`)
  }
  const wb = wbNode as XmlNode
  const date1904 = isTruthyAttr(attr(wb['workbookPr'] as XmlNode | undefined, 'date1904'))

  const relsXml = decodeZipEntry(entries, 'xl/_rels/workbook.xml.rels')
  const rels = parseWorkbookRels(relsXml === null ? null : await parseOoxmlPart(relsXml))

  const sharedXml = decodeZipEntry(entries, 'xl/sharedStrings.xml')
  const shared = sharedXml === null ? [] : parseSharedStrings(await parseOoxmlPart(sharedXml))

  const stylesXml = decodeZipEntry(entries, 'xl/styles.xml')
  const styles = parseStyles(stylesXml, stylesXml === null ? null : await parseOoxmlPart(stylesXml))

  const worksheets: ExcelWorksheet[] = []
  for (const sheet of asArray((wb['sheets'] as XmlNode | undefined)?.['sheet'])) {
    const name = attr(sheet, 'name') ?? ''
    const rid = attr(sheet, 'r:id') ?? attr(sheet, 'relationshipId')
    // Resolved through the rels part, never by assuming `xl/worksheets/sheetN.xml` matches the
    // workbook's sheet order: producers other than Excel itself do not guarantee that naming.
    const partPath = rid === undefined ? undefined : rels.get(rid)
    const sheetXml = partPath === undefined ? null : decodeZipEntry(entries, partPath)
    const data =
      sheetXml === null
        ? { cells: new Map(), rowCount: 0, columnCount: 0, populatedRows: 0 }
        : parseSheet(await parseOoxmlPart(sheetXml), shared, styles, date1904)
    worksheets.push(makeWorksheet(name, data))
  }

  return {
    worksheets,
    getWorksheet: (name: string) => worksheets.find((ws) => ws.name === name),
  }
}
