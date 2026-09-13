/**
 * Extracted-text bridge from the binary-document readers (pdf, docx, pptx, xlsx) into the
 * embeddings/chunking pipeline, so `token-goat semantic` can answer questions from spec PDFs,
 * design docs, decks, and spreadsheets, not just git-tracked plain-text source. Reuses the same
 * extraction modules the read-only pdf-read/docx/pptx/xlsx CLI commands already use -- this
 * file only dispatches by extension and normalizes each format's output into one text blob.
 */
import * as path from 'node:path'

import { PdfRefusedError, extractPdfText, readPdfFileWithinBounds } from './pdf_extract.js'
import { docxText } from './docx_extract.js'
import { pptxOutline, pptxSlideText } from './pptx_extract.js'
import { listSheets, headSheet } from './xlsx_extract.js'

const EMBEDDABLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

// A full-sheet dump could produce a huge low-signal chunk set for large spreadsheets -- same
// "avoid low-signal chunk explosion" reasoning parser.ts's indexFileEmbeddings already applies
// to .profile-meta.xml / oversized Salesforce metadata, just capped by row count instead of
// byte size since a spreadsheet's signal density is per-row, not per-byte.
const XLSX_SHEET_ROW_CAP = 500

export function isEmbeddableDocument(filePath: string): boolean {
  return EMBEDDABLE_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * Whether an extraction error is a verdict on the document rather than a failure to read it.
 *
 * The difference decides whether the indexer ever looks at this file again. A refusal is
 * deterministic -- the same bytes are past the same bound on every run -- so recording it as
 * settled costs one wasted attempt and saves the bound being re-spent on every worker drain. A
 * failure is not: pdfjs was momentarily unavailable, the file was being written, the disk
 * blinked. Recording that as settled means the document is never embedded again even after the
 * cause is gone, which is the failure this predicate exists to keep apart from the other one.
 */
export function isDocumentRefusal(err: unknown): boolean {
  return err instanceof PdfRefusedError
}

/**
 * One document's text, or null when the extension carries none. Throws on anything that went
 * wrong: see {@link isDocumentRefusal} for why the caller has to tell the two kinds apart.
 */
export async function extractEmbeddableDocumentText(filePath: string): Promise<string | null> {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf': {
      // The indexer reaches this unprompted, for every PDF in a repository the user has just
      // cloned, and nobody is watching what it costs. So the bounds matter more here than at the
      // CLI: without them a single crafted file crash-loops the background worker.
      const { text } = await extractPdfText(await readPdfFileWithinBounds(filePath))
      return text
    }
    case '.docx':
      return await docxText(filePath)
    case '.pptx': {
      const outline = await pptxOutline(filePath)
      const slideTexts: string[] = []
      for (let i = 1; i <= outline.length; i++) {
        slideTexts.push(await pptxSlideText(filePath, i, true))
      }
      return slideTexts.join('\n\n')
    }
    case '.xlsx': {
      const sheets = await listSheets(filePath)
      const sheetTexts: string[] = []
      for (const sheet of sheets) {
        const body = await headSheet(filePath, sheet.name, XLSX_SHEET_ROW_CAP)
        sheetTexts.push(`# Sheet: ${sheet.name}\n${body}`)
      }
      return sheetTexts.join('\n\n')
    }
    default:
      return null
  }
}
