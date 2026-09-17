/** Word (.docx) narrow-slice reader. Body text lives at `word/document.xml`, a `w:document > w:body` tree of paragraphs (`w:p`), each holding runs (`w:r`) of text (`w:t`). A paragraph is a heading when its `w:pPr.w:pStyle.@_w:val` matches `HeadingN`/`Heading N`/`Title` (the exact style ID Word writes depends on the template, so both forms are checked). */

import { displaySafeText } from './paths.js'
import { collectElements, collectParagraphTexts, collectTextRuns, decodeZipEntry, dropAlternateContentFallbacks, NotAnOfficeDocumentError, ooxmlPartBudget, parseOoxmlPart, readOoxmlZip } from './ooxml_extract.js'

interface ParagraphLike {
  'w:pPr'?: { 'w:pStyle'?: { '@_w:val'?: string } }
}

export interface DocxHeading {
  level: number
  text: string
}

export interface DocxTable {
  tableIndex: number
  rowCount: number
  colCount: number
  rows: string[][]
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

/** A tab in Word is not text: it is an empty `<w:tab/>` element sitting between `<w:t>` runs (`Section 1.<w:tab/>Definitions.`), and a line break inside a paragraph is `<w:br/>` (`<w:cr/>` the legacy form) the same way. The parse folds same-name siblings into one array per name, so once the part is a tree the element's position among the runs is gone -- `<w:t>A</w:t><w:tab/><w:t>B</w:t>` arrives as `{'w:t': ['A', 'B'], 'w:tab': ''}` -- and every reader glued the words on either side together. Rewriting each into a `<w:t>` run holding the character BEFORE the parse makes it a same-name sibling of the text it sits between, and those the parse does keep in order. Only the bare `<w:tab/>` is a tab character; `<w:tab w:val=".." w:pos=".."/>` under `w:tabs` is a tab-stop definition and always carries attributes. */
function inlineRunSeparators(xml: string): string {
  return xml.replace(/<w:tab\s*\/>/g, '<w:t>\t</w:t>').replace(/<w:(?:br|cr)(?:\s[^/>]*)?\/>/g, '<w:t>\n</w:t>')
}

async function loadDocumentBody(filePath: string): Promise<unknown> {
  const entries = await readOoxmlZip(filePath, '.docx')
  const xml = decodeZipEntry(entries, 'word/document.xml', ooxmlPartBudget())
  if (xml === null) throw new NotAnOfficeDocumentError(`no word/document.xml found in ${filePath} (not a valid .docx?)`)
  const parsed = await parseOoxmlPart(inlineRunSeparators(xml))
  dropAlternateContentFallbacks(parsed)
  return parsed
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

export async function docxTables(filePath: string): Promise<DocxTable[]> {
  const parsed = await loadDocumentBody(filePath)
  // A table nested in a cell is a table in its own right: without includeNested it is never reported, and its rows are only visible as the text they leak into the parent cell.
  const tbls = collectElements(parsed, 'w:tbl', { includeNested: true })
  const out: DocxTable[] = []

  for (let i = 0; i < tbls.length; i++) {
    const tbl = tbls[i]
    const trElements = collectElements(tbl, 'w:tr')
    const rows: string[][] = []
    let maxCols = 0

    for (const tr of trElements) {
      const tcElements = collectElements(tr, 'w:tc')
      const rowCells: string[] = []
      for (const tc of tcElements) {
        // Paragraph-aware, and blind to a nested table: the nested rows are reported as their own table instead of being flattened into this cell. A line break is already a `\n` run by the time the tree is parsed (see inlineRunSeparators), and a markdown cell cannot hold a newline, so it becomes a space here.
        const cellText = collectParagraphTexts(tc, 'w:p', 'w:t', ['w:tbl'])
          .map((t) => t.replace(/\r?\n/g, ' ').trim())
          .filter((t) => t.length > 0)
          .join(' ')
        rowCells.push(cellText)
      }
      if (rowCells.length > maxCols) maxCols = rowCells.length
      rows.push(rowCells)
    }

    if (rows.length > 0) {
      out.push({
        tableIndex: i + 1,
        rowCount: rows.length,
        colCount: maxCols,
        rows,
      })
    }
  }

  return out
}

export function formatDocxTables(tables: DocxTable[], opts?: { tableIndex?: number | undefined }): string {
  if (tables.length === 0) return 'no tables found in document'

  const selected = opts?.tableIndex !== undefined
    ? tables.filter((t) => t.tableIndex === opts.tableIndex)
    : tables

  if (selected.length === 0) {
    return `table ${opts?.tableIndex} not found (document has ${tables.length} table${tables.length === 1 ? '' : 's'})`
  }

  const sections: string[] = []

  for (const table of selected) {
    const lines: string[] = [
      `Table ${table.tableIndex} (${table.rowCount} row${table.rowCount === 1 ? '' : 's'} x ${table.colCount} col${table.colCount === 1 ? '' : 's'}):`,
    ]
    if (table.rows.length === 0) {
      lines.push('  (empty)')
      sections.push(lines.join('\n'))
      continue
    }

    const header = table.rows[0]!
    const padCols = Math.max(table.colCount, 1)
    const paddedHeader = [...header]
    while (paddedHeader.length < padCols) paddedHeader.push('')
    lines.push('| ' + paddedHeader.map((c) => displaySafeText(c.replace(/\|/g, '\\|'))).join(' | ') + ' |')
    lines.push('| ' + Array.from({ length: padCols }, () => '---').join(' | ') + ' |')

    for (let r = 1; r < table.rows.length; r++) {
      const row = table.rows[r]!
      const paddedRow = [...row]
      while (paddedRow.length < padCols) paddedRow.push('')
      lines.push('| ' + paddedRow.map((c) => displaySafeText(c.replace(/\|/g, '\\|'))).join(' | ') + ' |')
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
