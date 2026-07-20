/**
 * Extracted-text bridge from the binary-document readers (pdf, docx, pptx, xlsx) into the
 * embeddings/chunking pipeline, so `token-goat semantic` can answer questions from spec PDFs,
 * design docs, decks, and spreadsheets, not just git-tracked plain-text source. Reuses the same
 * extraction modules the read-only pdf-read/docx/pptx/xlsx CLI commands already use -- this
 * file only dispatches by extension and normalizes each format's output into one text blob.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { extractPdfText } from './pdf_extract.js'
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

export async function extractEmbeddableDocumentText(filePath: string): Promise<string | null> {
  try {
    switch (path.extname(filePath).toLowerCase()) {
      case '.pdf': {
        const data = await fs.promises.readFile(filePath)
        const { text } = await extractPdfText(new Uint8Array(data))
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
  } catch {
    // Best-effort, matching indexFileEmbeddings' own read-failure handling: a corrupt or
    // unreadable document must never fail the overall index.
    return null
  }
}
