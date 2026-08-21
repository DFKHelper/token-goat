/**
 * The in-house SpreadsheetML reader, against hand-authored XML parts.
 *
 * tests/xlsx_extract.test.ts already reads real workbooks, but every one of them is written by
 * ExcelJS, so it only ever proves the reader against a single producer's output. ExcelJS never
 * emits an inline string, never writes a boolean or error cell, always writes a custom
 * `formatCode` rather than a builtin date `numFmtId`, always names its parts `sheetN.xml`, and
 * never writes a 1904-epoch workbook. Those are exactly the shapes a different producer will hand
 * us, so they are assembled here from literal part strings instead.
 */
import { zipSync } from 'fflate'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { formatCodeIsDate, readXlsxWorkbook, serialToDate } from '../src/xlsx_reader.js'

let dir: string

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
</Types>`

interface SheetSpec {
  /** Workbook-visible name. */
  name: string
  /** Zip path of the worksheet part, relative to `xl/`. Deliberately not forced to `sheetN.xml`. */
  target: string
  xml: string
}

function buildXlsx(opts: {
  sheets: SheetSpec[]
  sharedStrings?: string
  styles?: string
  date1904?: boolean
}): string {
  const rels = opts.sheets
    .map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target}"/>`)
    .join('')
  const sheetTags = opts.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  const workbookPr = opts.date1904 === true ? '<workbookPr date1904="1"/>' : ''
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': new TextEncoder().encode(CONTENT_TYPES),
    'xl/workbook.xml': new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${workbookPr}<sheets>${sheetTags}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    ),
  }
  for (const s of opts.sheets) files[`xl/${s.target}`] = new TextEncoder().encode(s.xml)
  if (opts.sharedStrings !== undefined) files['xl/sharedStrings.xml'] = new TextEncoder().encode(opts.sharedStrings)
  if (opts.styles !== undefined) files['xl/styles.xml'] = new TextEncoder().encode(opts.styles)

  const file = path.join(dir, `wb-${Math.random().toString(36).slice(2)}.xlsx`)
  fs.writeFileSync(file, Buffer.from(zipSync(files)))
  return file
}

function sheetXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
}

/** cellXfs index 0 is General, index 1 is builtin date format 14, index 2 a custom yyyy-mm-dd. */
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs>
</styleSheet>`

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-xlsxreader-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cell types ExcelJS never emits', () => {
  it('reads t="inlineStr" cells from <is><t>', async () => {
    const file = buildXlsx({
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>inline value</t></is></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('A1').value).toBe('inline value')
    expect(ws?.getCell('A1').text).toBe('inline value')
  })

  it('reads t="b" boolean cells as booleans for both 1 and 0', async () => {
    const file = buildXlsx({
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('A1').value).toBe(true)
    expect(ws?.getCell('A1').text).toBe('TRUE')
    expect(ws?.getCell('B1').value).toBe(false)
    expect(ws?.getCell('B1').text).toBe('FALSE')
  })

  it('reads t="e" error cells into the { error } shape cellText expects', async () => {
    const file = buildXlsx({
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="e"><v>#DIV/0!</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('A1').value).toEqual({ error: '#DIV/0!' })
    expect(ws?.getCell('A1').text).toBe('#DIV/0!')
  })
})

describe('date detection and serial conversion', () => {
  it('treats a builtin date numFmtId as a date without any custom formatCode', async () => {
    const file = buildXlsx({
      styles: STYLES,
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" s="1"><v>45658</v></c><c r="B1" s="0"><v>45658</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    const dated = ws?.getCell('A1').value
    expect(dated).toBeInstanceOf(Date)
    expect((dated as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z')
    // Same serial under the General style stays a number: the style, not the value, decides.
    expect(ws?.getCell('B1').value).toBe(45658)
  })

  it('shifts serials across the 1900 Lotus leap-year discontinuity', async () => {
    const file = buildXlsx({
      styles: STYLES,
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" s="1"><v>59</v></c><c r="B1" s="1"><v>61</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    // Serial 60 is Excel's non-existent 1900-02-29, so 59 and 61 sit either side of the fiction.
    expect((ws?.getCell('A1').value as Date).toISOString()).toBe('1900-02-28T00:00:00.000Z')
    expect((ws?.getCell('B1').value as Date).toISOString()).toBe('1900-03-01T00:00:00.000Z')
  })

  it('uses the 1904 epoch when workbookPr/@date1904 is set', async () => {
    const file = buildXlsx({
      styles: STYLES,
      date1904: true,
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>44196</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect((ws?.getCell('A1').value as Date).toISOString()).toBe('1904-01-01T00:00:00.000Z')
    expect((ws?.getCell('B1').value as Date).toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })

  it('serialToDate agrees with the same serial in both epochs', () => {
    expect(serialToDate(59, false).toISOString()).toBe('1900-02-28T00:00:00.000Z')
    expect(serialToDate(61, false).toISOString()).toBe('1900-03-01T00:00:00.000Z')
    expect(serialToDate(0, true).toISOString()).toBe('1904-01-01T00:00:00.000Z')
  })

  it('non-firing guard: real number formats are not mistaken for dates', () => {
    // The quoted-literal and bracketed-section cases carry date letters inside them on purpose: a
    // format whose only y/m/d/h/s live in a literal suffix or a colour tag is still a number
    // format, and that is the whole reason those sections are stripped before the test.
    const numericFormats = ['General', '0.00', '#,##0.00', '0.00%', '"$"#,##0.00', '0.00" days"', '"May"#,##0', '[Red]-#,##0', '@']
    expect(numericFormats.length).toBeGreaterThan(0)
    for (const code of numericFormats) {
      expect(formatCodeIsDate(code), `${code} is a number format, not a date format`).toBe(false)
    }
    const dateFormats = ['yyyy-mm-dd', 'd/m/yy h:mm', '[$-409]mmmm d, yyyy', 'hh:mm:ss']
    expect(dateFormats.length).toBeGreaterThan(0)
    for (const code of dateFormats) {
      expect(formatCodeIsDate(code), `${code} is a date format`).toBe(true)
    }
  })
})

describe('part resolution and whitespace', () => {
  it('resolves a worksheet through its rels target rather than assuming sheetN.xml', async () => {
    const file = buildXlsx({
      sheets: [
        { name: 'Main', target: 'worksheets/data-main.xml', xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>found it</t></is></c></row>') },
      ],
    })
    const wb = await readXlsxWorkbook(file)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Main'])
    expect(wb.getWorksheet('Main')?.getCell('A1').value).toBe('found it')
  })

  it('preserves leading and trailing spaces in <t xml:space="preserve">', async () => {
    const file = buildXlsx({
      sharedStrings: `<?xml version="1.0" encoding="UTF-8"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t xml:space="preserve">  padded  </t></si></sst>`,
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('A1').value).toBe('  padded  ')
  })

  it('joins rich-text runs in a shared string and ignores the phonetic guide', async () => {
    const file = buildXlsx({
      sharedStrings: `<?xml version="1.0" encoding="UTF-8"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>bold</t></r><r><t xml:space="preserve"> plain</t></r><rPh sb="0" eb="4"><t>PRONOUNCE</t></rPh></si></sst>`,
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('A1').value).toBe('bold plain')
  })
})

describe('sparse sheets and malformed input', () => {
  it('reports rowCount as the highest row with content and visits only populated cells', async () => {
    const file = buildXlsx({
      styles: STYLES,
      sheets: [
        {
          name: 'S',
          target: 'worksheets/sheet1.xml',
          xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row><row r="4"><c r="B4"><v>7</v></c></row><row r="6"><c r="A6" s="1"/></row>'),
        },
      ],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    // Row 6 holds a styled but valueless cell, which is not content.
    expect(ws?.rowCount).toBe(4)
    const seen: [number, unknown][] = []
    ws?.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => seen.push([col, cell.value]))
    expect(seen).toEqual([
      [1, 'a'],
      [3, 'c'],
    ])
  })

  it('returns an empty cell rather than throwing for coordinates past the used range', async () => {
    const file = buildXlsx({
      sheets: [{ name: 'S', target: 'worksheets/sheet1.xml', xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>') }],
    })
    const ws = (await readXlsxWorkbook(file)).getWorksheet('S')
    expect(ws?.getCell('ZZ999')).toEqual({ value: null, text: '' })
    expect(() => ws?.getRow(999).eachCell({ includeEmpty: false }, () => undefined)).not.toThrow()
  })

  it('reports a zip with no workbook part as an invalid xlsx rather than a parse error', async () => {
    const file = path.join(dir, 'no-workbook.xlsx')
    fs.writeFileSync(file, Buffer.from(zipSync({ 'hello.txt': new TextEncoder().encode('hi') })))
    await expect(readXlsxWorkbook(file)).rejects.toThrow(`not a valid .xlsx file: ${file}`)
  })
})
