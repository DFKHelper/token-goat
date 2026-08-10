/**
 * Regression: the document-extraction CLI commands defined via thin wrappers in src/cli.ts
 * (NOT src/read_commands.ts) -- pdf-extract, pdf-outline, pdf-meta, xlsx-sheets, xlsx-head,
 * xlsx-range, xlsx-query, pptx-outline, pptx-slide, pptx-notes, pptx-text, docx-outline,
 * docx-text, transcript-outline, transcript -- never called recordStat, and stats.ts's
 * KIND_TO_SOURCE/COMMAND_KINDS registry had no entries for any of them either. Every one of
 * these commands advertises itself as a surgical-read alternative to a raw Read, but their
 * dashboard buckets in `token-goat stats --full` were permanently zero regardless of real
 * usage -- the same class of registry/producer desync already fixed for
 * map_lookup/changed_lookup/csv_query/csv_profile/gdrive_sections (see
 * project_runchanged_missing_stat memory). Drives the real, unmocked `run()` CLI entrypoint
 * against real scratch fixture files for each format and asserts a real stats row appears via
 * summarize() against the real (test-isolated) global stats DB -- a synthetic recordStat/DB
 * insert would not catch the original absence.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import ExcelJS from 'exceljs'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

// Minimal hand-authored single-page PDF (Helvetica text object), same fixture shape as
// tests/helpers/matrix_cases.ts' MINIMAL_PDF.
const MINIMAL_PDF = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n'

// Same page/font/content objects as MINIMAL_PDF, plus an /Outlines catalog entry with one
// bookmark item pointing at the page -- pdf-outline's own code path only calls recordStat once
// pdfjs's getOutline() returns at least one entry, so the plain MINIMAL_PDF above (no bookmarks)
// would only ever exercise the "no bookmarks in this PDF" early return.
const PDF_WITH_OUTLINE = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n' +
  '7 0 obj\n<< /Title (Chapter 1) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n' +
  'trailer\n<< /Size 8 /Root 1 0 R >>\n%%EOF\n'

const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\n<v Alice>Welcome to the meeting.\n'

describe('document-extraction CLI stat recording', () => {
  let root: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tg-statrec-docextract-'))

    writeFileSync(join(root, 'doc.pdf'), Buffer.from(MINIMAL_PDF, 'latin1'))
    writeFileSync(join(root, 'doc_outline.pdf'), Buffer.from(PDF_WITH_OUTLINE, 'latin1'))

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('People')
    ws.addRow(['name', 'age'])
    ws.addRow(['Alice', '30'])
    await wb.xlsx.writeFile(join(root, 'book.xlsx'))

    writeFileSync(join(root, 'deck.pptx'), buildPptxFixture([{ title: 'Intro', body: ['Welcome'], notes: 'Say hello warmly' }]))
    writeFileSync(join(root, 'doc.docx'), buildDocxFixture([{ text: 'Overview', headingLevel: 1 }, { text: 'Some body text.' }]))
    writeFileSync(join(root, 'meeting.vtt'), VTT)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['pdf-extract', () => ['pdf-extract', join(root, 'doc.pdf')], 'pdf_extract'],
    ['pdf-outline', () => ['pdf-outline', join(root, 'doc_outline.pdf')], 'pdf_outline'],
    ['pdf-meta', () => ['pdf-meta', join(root, 'doc.pdf')], 'pdf_meta'],
    ['xlsx-sheets', () => ['xlsx-sheets', join(root, 'book.xlsx')], 'xlsx_sheets'],
    ['xlsx-head', () => ['xlsx-head', join(root, 'book.xlsx'), '--sheet', 'People'], 'xlsx_head'],
    ['xlsx-range', () => ['xlsx-range', join(root, 'book.xlsx'), '--sheet', 'People', '--range', 'A1:B2'], 'xlsx_range'],
    ['xlsx-query', () => ['xlsx-query', join(root, 'book.xlsx'), '--sheet', 'People'], 'xlsx_query'],
    ['pptx-outline', () => ['pptx-outline', join(root, 'deck.pptx')], 'pptx_outline'],
    ['pptx-slide', () => ['pptx-slide', join(root, 'deck.pptx'), '--slide', '1'], 'pptx_slide'],
    ['pptx-notes', () => ['pptx-notes', join(root, 'deck.pptx')], 'pptx_notes'],
    ['pptx-text', () => ['pptx-text', join(root, 'deck.pptx'), '--grep', 'Welcome'], 'pptx_text'],
    ['docx-outline', () => ['docx-outline', join(root, 'doc.docx')], 'docx_outline'],
    ['docx-text', () => ['docx-text', join(root, 'doc.docx')], 'docx_text'],
    ['transcript-outline', () => ['transcript-outline', join(root, 'meeting.vtt')], 'transcript_outline'],
    ['transcript', () => ['transcript', join(root, 'meeting.vtt')], 'transcript'],
    // --json is a rendering choice, not a reason to stop recording the saving: an early --json rollout left transcript-outline's recordDocStat inside the text-only branch, so JSON callers silently recorded nothing while its siblings did.
    ['pptx-outline --json', () => ['pptx-outline', join(root, 'deck.pptx'), '--json'], 'pptx_outline'],
    ['docx-outline --json', () => ['docx-outline', join(root, 'doc.docx'), '--json'], 'docx_outline'],
    [
      'transcript-outline --json',
      () => ['transcript-outline', join(root, 'meeting.vtt'), '--json'],
      'transcript_outline',
    ],
    ['xlsx-sheets --json', () => ['xlsx-sheets', join(root, 'book.xlsx'), '--json'], 'xlsx_sheets'],
    ['pdf-meta --json', () => ['pdf-meta', join(root, 'doc.pdf'), '--json'], 'pdf_meta'],
  ] as const)('`token-goat %s` records a %s stat row through the real global stats DB', async (_cmd, argsFn, kind) => {
    const before = summarize(30).by_kind[kind]
    const beforeEvents = before?.events ?? 0

    await run(['node', 'token-goat', ...argsFn()])

    const after = summarize(30).by_kind[kind]
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
  })
})
