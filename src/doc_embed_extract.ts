/** Extracted-text bridge from the binary-document readers (pdf, docx, pptx, xlsx) into the embeddings/chunking pipeline, so `token-goat semantic` can answer questions from spec PDFs, design docs, decks, and spreadsheets, not just git-tracked plain-text source. Reuses the same extraction modules the read-only pdf-read/docx/pptx/xlsx CLI commands already use -- this file only dispatches by extension and normalizes each format's output into one text blob. */
import * as path from 'node:path'

// Only the error class is imported statically. The four format readers pull in pdfjs, the OOXML/zip machinery and the xlsx reader -- together the largest single block in the hook bundle's eager set -- and every hook that reaches parser.ts for a hint pays to parse all of it, while `isEmbeddableDocument` below answers from an extension alone and the extraction path runs for a handful of files during an index. So each reader is imported where it is used, the same way parser.ts already defers languages/registry.ts. `document_refusal.js` stays static because the two predicates below are synchronous `instanceof` checks and it carries nothing heavy.
import { DocumentRefusedError } from './document_refusal.js'

const EMBEDDABLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

// A full-sheet dump could produce a huge low-signal chunk set for large spreadsheets -- same "avoid low-signal chunk explosion" reasoning parser.ts's indexFileEmbeddings already applies to .profile-meta.xml / oversized Salesforce metadata, just capped by row count instead of byte size since a spreadsheet's signal density is per-row, not per-byte.
const XLSX_SHEET_ROW_CAP = 500

export function isEmbeddableDocument(filePath: string): boolean {
  return EMBEDDABLE_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/** Whether an extraction error is a verdict on the document rather than a failure to read it. The difference decides whether the indexer ever looks at this file again. A refusal is deterministic -- the same bytes are past the same bound on every run -- so recording it as settled costs one wasted attempt and saves the bound being re-spent on every worker drain. A failure is not: pdfjs was momentarily unavailable, the file was being written, the disk blinked. Recording that as settled means the document is never embedded again even after the cause is gone, which is the failure this predicate exists to keep apart from the other one. */
export function isDocumentRefusal(err: unknown): boolean {
  return err instanceof DocumentRefusedError
}

/** Whether a refusal is a verdict on the bytes or on the clock. {@link isDocumentRefusal} tells a refusal apart from a failure; this tells the two kinds of refusal apart. A size or count bound is past on every run forever, so recording it as settled is free and correct. A clock bound is not: it measured one machine under one load, and the same document can extract fine on the next pass, so recording it as settled is the permanent-verdict-from-a-temporary-condition mistake the failure branch exists to avoid. Reads the flag the error class declares rather than matching names, so a format added later cannot be forgotten by a list. */
export function isTransientDocumentRefusal(err: unknown): boolean {
  return err instanceof DocumentRefusedError && err.transient
}

/** One document's text, or null when the extension carries none. Throws on anything that went wrong: see {@link isDocumentRefusal} for why the caller has to tell the two kinds apart. */
export async function extractEmbeddableDocumentText(filePath: string): Promise<string | null> {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf': {
      // The indexer reaches this unprompted, for every PDF in a repository the user has just cloned, and nobody is watching what it costs. So the bounds matter more here than at the CLI: without them a single crafted file crash-loops the background worker.
      const { extractPdfText, readPdfFileWithinBounds } = await import('./pdf_extract.js')
      const { text } = await extractPdfText(await readPdfFileWithinBounds(filePath))
      return text
    }
    case '.docx':
      return await (await import('./docx_extract.js')).docxText(filePath)
    case '.pptx':
      // pptxAllSlidesText reads the archive once and reuses it across every slide, rather than looping pptxSlideText (one full archive read+reinflate per call) once per slide -- see its own doc comment for why that used to cost N+1 reads for an N-slide deck.
      return await (await import('./pptx_extract.js')).pptxAllSlidesText(filePath, true)
    case '.xlsx':
      // Same shape as the pptx case above: allSheetsHeadText loads the workbook once and reuses it across every sheet, rather than looping headSheet (one full archive read+reparse of every sheet, per sheet requested).
      return await (await import('./xlsx_extract.js')).allSheetsHeadText(filePath, XLSX_SHEET_ROW_CAP)
    default:
      return null
  }
}
