import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { extractEmbeddableDocumentText, isEmbeddableDocument } from '../src/doc_embed_extract.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

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

  it('returns null for a nonexistent path', async () => {
    const text = await extractEmbeddableDocumentText(path.join(dir, 'does-not-exist.pdf'))
    expect(text).toBeNull()
  })

  it('returns null (never throws) for a corrupt file with a .pdf extension', async () => {
    const file = path.join(dir, 'garbage.pdf')
    fs.writeFileSync(file, 'this is not a real pdf, just garbage bytes')
    await expect(extractEmbeddableDocumentText(file)).resolves.toBeNull()
  })
})
