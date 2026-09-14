/** Minimal in-memory .pptx/.docx/.xlsx fixture builder for tests, via fflate.zipSync (already a project optionalDependency, so no extra test-only dep). Includes only the ZIP parts the extraction code actually reads: slide/notes/document XML always, plus presentation.xml and its rels when `buildPptxFixture`'s optional `order` param is used (to exercise presentation-display-order resolution) -- not the full OOXML skeleton (Content_Types.xml etc.) real PowerPoint/Word would require to open the file. `buildFarCornerXlsxFixture` is the exception and does carry the full skeleton, because it has to survive a real workbook parse to reach the check it targets. */

import { strToU8, zipSync } from 'fflate'

export interface FixtureSlide {
  title?: string
  body?: string[]
  notes?: string
}

function runXml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<a:p><a:r><a:t>${escaped}</a:t></a:r></a:p>`
}

function slideXml(slide: FixtureSlide): string {
  const titleShape = slide.title !== undefined
    ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${runXml(slide.title)}</p:txBody></p:sp>`
    : ''
  const bodyShape =
    slide.body && slide.body.length > 0
      ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${slide.body.map(runXml).join('')}</p:txBody></p:sp>`
      : ''
  return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${titleShape}${bodyShape}</p:spTree></p:cSld></p:sld>`
}

function notesXml(notes: string): string {
  return `<?xml version="1.0"?><p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${runXml(notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
}

/** `order`: 1-based physical `slideN.xml` indices in display order, e.g. `[3, 1, 2]` means physical slide 3 displays first. When provided, emits `ppt/presentation.xml` + `ppt/_rels/presentation.xml.rels` so tests can exercise presentation-order resolution (`slidePathsInPresentationOrder` in src/pptx_extract.ts) instead of the filename-order fallback -- a reordered/duplicated/deleted-slide deck is exactly the case filename order gets wrong, since PowerPoint never renames `slideN.xml` parts to match display order. */
/** `notesTargets`: maps a 1-based physical slide index to the physical `notesSlideN.xml` index its relationship should point at (defaults to the same index). Lets tests simulate PowerPoint's independent notesSlide numbering counter, e.g. a duplicated slide whose notes part lands at a non-matching number. */
export function buildPptxFixture(slides: FixtureSlide[], order?: number[], notesTargets?: Record<number, number>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  slides.forEach((slide, i) => {
    const slideNum = i + 1
    files[`ppt/slides/slide${slideNum}.xml`] = strToU8(slideXml(slide))
    if (slide.notes !== undefined) {
      const notesNum = notesTargets?.[slideNum] ?? slideNum
      files[`ppt/notesSlides/notesSlide${notesNum}.xml`] = strToU8(notesXml(slide.notes))
      files[`ppt/slides/_rels/slide${slideNum}.xml.rels`] =
        strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNum}.xml"/></Relationships>`)
    }
  })
  if (order !== undefined) {
    const sldIds = order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')
    files['ppt/presentation.xml'] =
      strToU8(`<?xml version="1.0"?><p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`)
    const rels = order.map((n, i) => `<Relationship Id="rId${i + 1}" Type="slide" Target="slides/slide${n}.xml"/>`).join('')
    files['ppt/_rels/presentation.xml.rels'] =
      strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)
  }
  return zipSync(files)
}

export interface FixtureParagraph {
  text: string
  headingLevel?: number
}

function paragraphXml(p: FixtureParagraph): string {
  const escaped = p.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const pPr = p.headingLevel !== undefined ? `<w:pPr><w:pStyle w:val="Heading${p.headingLevel}"/></w:pPr>` : ''
  return `<w:p>${pPr}<w:r><w:t>${escaped}</w:t></w:r></w:p>`
}

export function buildDocxFixture(paragraphs: FixtureParagraph[]): Uint8Array {
  const body = paragraphs.map(paragraphXml).join('')
  const xml = `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`
  return zipSync({ 'word/document.xml': strToU8(xml) })
}

function tableXml(table: string[][]): string {
  const rowsXml = table
    .map((row) => {
      const cellsXml = row
        .map((cell) => {
          const escaped = cell.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<w:tc><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:tc>`
        })
        .join('')
      return `<w:tr>${cellsXml}</w:tr>`
    })
    .join('')
  return `<w:tbl>${rowsXml}</w:tbl>`
}

export function buildDocxWithTableFixture(tables: string[][][], paragraphs: FixtureParagraph[] = []): Uint8Array {
  const pXml = paragraphs.map(paragraphXml).join('')
  const tblXml = tables.map(tableXml).join('')
  const xml = `<?xml version="1.0"?><w:document><w:body>${pXml}${tblXml}</w:body></w:document>`
  return zipSync({ 'word/document.xml': strToU8(xml) })
}

/** A valid .xlsx whose one sheet declares a populated cell at `cellRef`, so the worksheet's reported extent is the rectangle from A1 to there while the file itself stays tiny. Provenance: FORMAT-DERIVED from ECMA-376 part 1 -- the package parts (`[Content_Types].xml`, the two `.rels`, `xl/workbook.xml`, `xl/worksheets/sheet1.xml`) and the cell `r="..."` reference that declares the extent. At the default far corner the declared range is 1,048,576 x 16,384 = 17,179,869,184 cells in about 1.5 KB on disk, which is the whole point: the cost of scanning it is quadratic in numbers the file merely states, not in anything it contains. */
export function buildFarCornerXlsxFixture(cellRef = 'XFD1048576'): Uint8Array {
  const row = cellRef.replace(/^[A-Z]+/, '')
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="A1" t="inlineStr"><is><t>near</t></is></c></row>' +
          `<row r="${row}"><c r="${cellRef}" t="inlineStr"><is><t>far</t></is></c></row></sheetData></worksheet>`,
      ),
    },
    { level: 9 },
  )
}

export interface MultiSheetXlsxOptions {
  /** How many `<sheet>` elements `xl/workbook.xml` declares. Each gets its own name and its own `r:id`. */
  sheetCount: number
  /** True: every `r:id` resolves to the single `xl/worksheets/sheet1.xml`, which is what a reader with no dedup pays for N times over. False: each `r:id` resolves to its own `xl/worksheets/sheetK.xml`. */
  aliasOnePart: boolean
  /** Rows of five inline-string cells per worksheet part, i.e. how much real parse work one part is worth. */
  rowsPerSheet?: number
  /** Bytes of inert padding appended to each worksheet part inside one element, so a fixture can be heavy in DECODED BYTES without being heavy in parse-tree nodes -- the cumulative-byte bound is a bound on the former, and a fixture reaching it through rows alone would spend the heap it is meant to be protecting. */
  padBytesPerSheet?: number
}

/** A valid .xlsx declaring `sheetCount` sheets, with control over whether their relationships alias one worksheet part or name distinct ones. Provenance: FORMAT-DERIVED from ECMA-376 -- Part 2 (OPC) for `[Content_Types].xml` and `_rels/.rels`, and Part 1 §18.2.20 (SpreadsheetML) for `xl/workbook.xml`'s `<sheets>`/`<sheet name sheetId r:id>` and for the worksheet relationship part `xl/_rels/workbook.xml.rels`, whose `Relationship/@Target` resolves relative to `xl/`. Nothing here is read off token-goat's own reader: the format permits several `<sheet>` elements to carry distinct `r:id`s that resolve to one target, and that permission -- not our parser -- is what this fixture exercises. */
export function buildMultiSheetXlsxFixture(opts: MultiSheetXlsxOptions): Uint8Array {
  const { sheetCount, aliasOnePart } = opts
  const rowsPerSheet = opts.rowsPerSheet ?? 200
  const padBytesPerSheet = opts.padBytesPerSheet ?? 0
  const partCount = aliasOnePart ? 1 : sheetCount
  const partPathFor = (k: number): string => `xl/worksheets/sheet${k}.xml`

  const sheetXml = (k: number): string => {
    const rows: string[] = []
    for (let r = 1; r <= rowsPerSheet; r++) {
      const cells: string[] = []
      for (let c = 0; c < 5; c++) {
        const ref = `${String.fromCharCode(65 + c)}${r}`
        cells.push(`<c r="${ref}" t="inlineStr"><is><t>p${k}r${r}c${c}</t></is></c>`)
      }
      rows.push(`<row r="${r}">${cells.join('')}</row>`)
    }
    const pad = padBytesPerSheet > 0 ? `<extLst><ext uri="pad">${'A'.repeat(padBytesPerSheet)}</ext></extLst>` : ''
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData>${pad}</worksheet>`
  }

  const sheetDecls: string[] = []
  const relDecls: string[] = []
  for (let i = 1; i <= sheetCount; i++) {
    sheetDecls.push(`<sheet name="Sheet${i}" sheetId="${i}" r:id="rId${i}"/>`)
    const target = aliasOnePart ? 'worksheets/sheet1.xml' : `worksheets/sheet${i}.xml`
    relDecls.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`)
  }

  const overrides: string[] = []
  const files: Record<string, Uint8Array> = {}
  for (let k = 1; k <= partCount; k++) {
    overrides.push(`<Override PartName="/${partPathFor(k)}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    files[partPathFor(k)] = strToU8(sheetXml(k))
  }

  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      `${overrides.join('')}</Types>`,
  )
  files['_rels/.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  )
  files['xl/workbook.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheetDecls.join('')}</sheets></workbook>`,
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `${relDecls.join('')}</Relationships>`,
  )

  return zipSync(files, { level: 6 })
}
