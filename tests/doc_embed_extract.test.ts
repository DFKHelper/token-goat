import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { extractEmbeddableDocumentText, isDocumentRefusal, isEmbeddableDocument } from '../src/doc_embed_extract.js'
import * as ooxmlExtract from '../src/ooxml_extract.js'
import { pptxAllSlidesText } from '../src/pptx_extract.js'
import { allSheetsHeadText } from '../src/xlsx_extract.js'
import { buildDocxFixture, buildFarCornerXlsxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

// Minimal hand-authored single-page PDF (Helvetica text object), the standard fixture shape for
// exercising a PDF parser without a binary test asset -- same shape as tests/pdf_extract.test.ts.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doc-embed-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isEmbeddableDocument', () => {
  it('is true for pdf, docx, pptx, xlsx, case-insensitively', () => {
    expect(isEmbeddableDocument('spec.pdf')).toBe(true)
    expect(isEmbeddableDocument('spec.PDF')).toBe(true)
    expect(isEmbeddableDocument('design.docx')).toBe(true)
    expect(isEmbeddableDocument('deck.pptx')).toBe(true)
    expect(isEmbeddableDocument('budget.xlsx')).toBe(true)
  })

  it('is false for plain-text formats and extensionless paths', () => {
    expect(isEmbeddableDocument('notes.txt')).toBe(false)
    expect(isEmbeddableDocument('README.md')).toBe(false)
    expect(isEmbeddableDocument('LICENSE')).toBe(false)
  })
})

describe('extractEmbeddableDocumentText', () => {
  it('extracts text from a real .pdf fixture', async () => {
    const file = path.join(dir, 'sample.pdf')
    fs.writeFileSync(file, Buffer.from(MINIMAL_PDF, 'latin1'))
    const text = await extractEmbeddableDocumentText(file)
    expect(text).not.toBeNull()
    expect(text).toContain('Hello PDF')
  })

  it('extracts text from a real .docx fixture', async () => {
    const file = path.join(dir, 'sample.docx')
    const bytes = buildDocxFixture([
      { text: 'Project Plan', headingLevel: 1 },
      { text: 'This document outlines the plan for the widget launch.' },
    ])
    fs.writeFileSync(file, bytes)
    const text = await extractEmbeddableDocumentText(file)
    expect(text).not.toBeNull()
    expect(text).toContain('This document outlines the plan for the widget launch.')
  })

  it('extracts text from a real .pptx fixture, including speaker notes', async () => {
    const file = path.join(dir, 'sample.pptx')
    const bytes = buildPptxFixture([
      { title: 'Quarterly Review', body: ['Q3 2026 Results'], notes: 'Remember to mention the new hires.' },
    ])
    fs.writeFileSync(file, bytes)
    const text = await extractEmbeddableDocumentText(file)
    expect(text).not.toBeNull()
    expect(text).toContain('Quarterly Review')
    expect(text).toContain('Remember to mention the new hires.')
  })

  it('extracts text from a real .xlsx fixture', async () => {
    const file = path.join(dir, 'sample.xlsx')
    const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Employees')
    ws.addRow(['name', 'age', 'dept'])
    ws.addRow(['Alice', 30, 'Eng'])
    await wb.xlsx.writeFile(file)
    const text = await extractEmbeddableDocumentText(file)
    expect(text).not.toBeNull()
    expect(text).toContain('# Sheet: Employees')
    expect(text).toContain('Alice')
  })

  // Both of these used to resolve to null, and the indexer read null as "this document holds no
  // text": a settled verdict that clears the file's embeddings and records it as done, so nothing
  // ever read it again. A missing or corrupt file is not a verdict, it is a failure, and the two
  // have to arrive differently for the caller to treat them differently. See
  // tests/document_extraction_failure_is_retried.test.ts for what the indexer does with each.
  it('throws for a nonexistent path rather than reporting an empty document', async () => {
    await expect(extractEmbeddableDocumentText(path.join(dir, 'does-not-exist.pdf'))).rejects.toThrow()
  })

  it('throws for a corrupt file with a .pdf extension', async () => {
    const file = path.join(dir, 'garbage.pdf')
    fs.writeFileSync(file, 'this is not a real pdf, just garbage bytes')
    await expect(extractEmbeddableDocumentText(file)).rejects.toThrow()
  })
})

// Regression for the bug an audit found in extractEmbeddableDocumentText's .pptx/.xlsx branches: looping pptxSlideText/headSheet once per slide/sheet each re-ran readOoxmlZip's full fs.readFileSync-plus-unzipBounded from scratch, so an N-slide deck or N-sheet workbook cost N+1 full archive reads for one document -- measured directly against a real fixture rather than asserting on wall-clock time, which would be flaky. pptxAllSlidesText/allSheetsHeadText fix this by loading the archive once and reusing it; this pins that readOoxmlZip is called exactly once no matter how many slides/sheets the document has.
describe('extractEmbeddableDocumentText reads the archive once per document, not once per slide/sheet', () => {
  it('.pptx: readOoxmlZip is called exactly once for a 12-slide deck', async () => {
    const file = path.join(dir, 'many-slides.pptx')
    const slides = Array.from({ length: 12 }, (_, i) => ({ title: `Slide ${i + 1}`, body: [`body text ${i + 1}`] }))
    fs.writeFileSync(file, buildPptxFixture(slides))
    const spy = vi.spyOn(ooxmlExtract, 'readOoxmlZip')
    const text = await extractEmbeddableDocumentText(file)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(text).toContain('Slide 12')
    expect(text).toContain('body text 1')
  })

  it('.xlsx: readOoxmlZip is called exactly once for a 6-sheet workbook', async () => {
    const file = path.join(dir, 'many-sheets.xlsx')
    const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
    const wb = new ExcelJS.Workbook()
    for (let i = 1; i <= 6; i++) {
      const ws = wb.addWorksheet(`Sheet${i}`)
      ws.addRow(['col'])
      ws.addRow([`value-${i}`])
    }
    await wb.xlsx.writeFile(file)
    const spy = vi.spyOn(ooxmlExtract, 'readOoxmlZip')
    const text = await extractEmbeddableDocumentText(file)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(text).toContain('# Sheet: Sheet6')
    expect(text).toContain('value-1')
  })
})

// The re-read fix above still leaves a document free to be wide enough that even O(1)-per-slide work adds up, and unlike pdf_extract.ts's MAX_PDF_WORK_MILLIS there was no wall clock anywhere on this path. Both bulk walkers take an optional `deadline` precisely so a test can force it already-expired rather than waiting out the real 60s default.
describe('pptxAllSlidesText / allSheetsHeadText refuse past their deadline as a DocumentRefusedError', () => {
  it('pptxAllSlidesText throws a document refusal once the deadline has passed, not a plain Error', async () => {
    const file = path.join(dir, 'deadline.pptx')
    fs.writeFileSync(file, buildPptxFixture([{ title: 'One' }, { title: 'Two' }]))
    const expiredDeadline = Date.now() - 1
    let caught: unknown
    try {
      await pptxAllSlidesText(file, false, expiredDeadline)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isDocumentRefusal(caught)).toBe(true)
  })

  it('allSheetsHeadText throws a document refusal once the deadline has passed, not a plain Error', async () => {
    const file = path.join(dir, 'deadline.xlsx')
    const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('A').addRow(['x'])
    wb.addWorksheet('B').addRow(['y'])
    await wb.xlsx.writeFile(file)
    const expiredDeadline = Date.now() - 1
    let caught: unknown
    try {
      await allSheetsHeadText(file, 500, expiredDeadline)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(isDocumentRefusal(caught)).toBe(true)
  })
})

// The .xlsx cell-extent ceiling is a verdict on the sheet's own declared extent, so it repeats on every pass and the indexer has to stop rather than re-open the workbook forever. The over-cap fixtures elsewhere cannot reach it: they are oversize FILES, so the zip input cap refuses them first, and the existing extent tests only assert on the message text, which a plain Error satisfies just as well. This drives the real dispatcher with a file small enough to be read and wide enough to be refused, and asks the one question that separates the two.
describe('a workbook whose declared extent is past the cell-scan ceiling', () => {
  it('is refused by the indexer as a settled verdict rather than a bad moment', async () => {
    const file = path.join(dir, 'far-corner.xlsx')
    fs.writeFileSync(file, buildFarCornerXlsxFixture())
    expect(fs.statSync(file).size, 'the fixture must be small enough that no size cap can refuse it first').toBeLessThan(64 * 1024)
    const raised = await extractEmbeddableDocumentText(file).then(
      () => new Error('the workbook was read instead of refused'),
      (err: unknown) => err as Error,
    )
    expect(raised.message, 'the refusal must be the cell-scan one, not a size or parse failure').toMatch(/scan limit/)
    expect(isDocumentRefusal(raised), `raised ${raised.name}, which the indexer reads as retryable`).toBe(true)
  })
})
