/**
 * Word (.docx) narrow-slice reader. Body text lives at `word/document.xml`, a
 * `w:document > w:body` tree of paragraphs (`w:p`), each holding runs (`w:r`) of text (`w:t`).
 * A paragraph is a heading when its `w:pPr.w:pStyle.@_w:val` matches `HeadingN`/`Heading N`/`Title`
 * (the exact style ID Word writes depends on the template, so both forms are checked).
 */

import { collectElements, collectTextRuns, decodeZipEntry, parseOoxmlPart, readOoxmlZip } from './ooxml_extract.js'

interface ParagraphLike {
  'w:pPr'?: { 'w:pStyle'?: { '@_w:val'?: string } }
}

export interface DocxHeading {
  level: number
  text: string
}

function paragraphStyleVal(p: unknown): string | undefined {
  return (p as ParagraphLike)['w:pPr']?.['w:pStyle']?.['@_w:val']
}

function headingLevel(styleVal: string | undefined): number | null {
  if (styleVal === undefined) return null
  if (/^title$/i.test(styleVal)) return 1
  const m = /^heading\s*(\d)$/i.exec(styleVal)
  return m?.[1] !== undefined ? parseInt(m[1], 10) : null
}

async function loadDocumentBody(filePath: string): Promise<unknown> {
  const entries = await readOoxmlZip(filePath, '.docx')
  const xml = decodeZipEntry(entries, 'word/document.xml')
  if (xml === null) throw new Error(`no word/document.xml found in ${filePath} (not a valid .docx?)`)
  return parseOoxmlPart(xml)
}

export async function docxOutline(filePath: string): Promise<DocxHeading[]> {
  const parsed = await loadDocumentBody(filePath)
  const paragraphs = collectElements(parsed, 'w:p')
  const out: DocxHeading[] = []
  for (const p of paragraphs) {
    const level = headingLevel(paragraphStyleVal(p))
    if (level === null) continue
    const text = collectTextRuns(p, 'w:t').join('').trim()
    if (text.length > 0) out.push({ level, text })
  }
  return out
}

export async function docxText(filePath: string): Promise<string> {
  const parsed = await loadDocumentBody(filePath)
  const paragraphs = collectElements(parsed, 'w:p')
  const lines = paragraphs.map((p) => collectTextRuns(p, 'w:t').join('')).filter((t) => t.trim().length > 0)
  return lines.join('\n\n')
}
