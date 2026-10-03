import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { docxOutline, docxTables, docxText } from '../src/docx_extract.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-r6d-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

let spies: WriteSpy[] = []
afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
})

async function runCli(argv: string[]): Promise<{ code: number | string | undefined; out: string; err: string }> {
  const stdout: string[] = []
  const stderr: string[] = []
  spies = [spyOnWrite(process.stdout, stdout), spyOnWrite(process.stderr, stderr)]
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, out: stdout.join(''), err: stderr.join('') }
  } finally {
    process.exitCode = prev
  }
}

function writeDocxXml(name: string, bodyXml: string): string {
  const p = join(dir, name)
  writeFileSync(p, zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${bodyXml}</w:body></w:document>`) }))
  return p
}

describe('docx-text --section (O2)', () => {
  // Provenance: HAND-DERIVED. Styles Title/Heading1/Heading2 are Word's built-in pStyle ids (ECMA-376 part 1 17.7.4.17 style ids); the expected `#` counts are the levels docx-outline reports for the same paragraphs.
  const body =
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Doc Title</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Budget</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Fifty thousand.</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Detail</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Line items.</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Timeline</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Q1 only.</w:t></w:r></w:p>'

  it('extracts one section by heading name', async () => {
    const f = writeDocxXml('sections.docx', body)
    const r = await runCli(['docx-text', f, '--section', 'Budget'])
    expect(r.err).toBe('')
    expect(r.out).toContain('Fifty thousand.')
    expect(r.out).toContain('Line items.')
    expect(r.out).not.toContain('Q1 only.')
  })

  it('renders Title and Heading N paragraphs with the level docx-outline reports', async () => {
    const f = writeDocxXml('levels.docx', body)
    const outline = await docxOutline(f)
    const text = await docxText(f, { markdownHeadings: true })
    const headingLines = text.split('\n\n').filter((l) => l.startsWith('#'))
    expect(headingLines).toEqual(outline.map((h) => `${'#'.repeat(h.level)} ${h.text}`))
    expect(headingLines).toEqual(['# Doc Title', '# Budget', '## Detail', '# Timeline'])
  })

  it('leaves the plain text untouched for callers that do not ask for markdown headings', async () => {
    const f = writeDocxXml('plain.docx', body)
    expect((await docxText(f)).split('\n\n')[0]).toBe('Doc Title')
  })
})

describe('docx-tables merged cells (O3)', () => {
  // Provenance: FORMAT-DERIVED from ECMA-376 part 1 17.4.17 (`w:gridSpan` in `w:tcPr`: the cell spans n grid columns) and 17.4.85 (`w:vMerge`: a continuation cell is a real, empty `w:tc` in each following row; `w:vMerge w:val="restart"` starts the merge).
  const tbl =
    '<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>' +
    '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Last</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>' +
    '</w:tbl>'

  it('expands a gridSpan cell into n columns so later cells stay aligned', async () => {
    const t = (await docxTables(writeDocxXml('span.docx', tbl)))[0]!
    expect(t.rows).toEqual([['Merged', '', 'Last'], ['A', 'B', 'C']])
    expect(t.colCount).toBe(3)
  })

  it('keeps columns aligned across a vMerge continuation cell', async () => {
    const vm =
      '<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R1</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>R2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const t = (await docxTables(writeDocxXml('vmerge.docx', vm)))[0]!
    expect(t.rows).toEqual([['Tall', 'R1'], ['', 'R2']])
  })
})

describe('xlsx-query --no-header and blank headers (O4, O1)', () => {
  async function writeXlsx(name: string, rows: string[][]): Promise<string> {
    const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    for (const r of rows) ws.addRow(r)
    const p = join(dir, name)
    await wb.xlsx.writeFile(p)
    return p
  }

  it('accepts --no-header, the flag its own duplicate-header error suggests', async () => {
    const f = await writeXlsx('dup.xlsx', [['a', 'a'], ['1', '2']])
    const bad = await runCli(['xlsx-query', f])
    expect(bad.err + bad.out).toContain('--no-header')
    const ok = await runCli(['xlsx-query', f, '--no-header', '--columns', 'col2'])
    expect(ok.err).toBe('')
    expect(ok.out).toContain('col2')
    expect(ok.out).toContain('2')
  })

  it('keeps every column when several header cells are blank', async () => {
    const f = await writeXlsx('blank.xlsx', [['id', '', ''], ['1', 'x', 'y']])
    const r = await runCli(['xlsx-query', f, '--json'])
    expect(r.err).toBe('')
    const parsed = JSON.parse(r.out) as { items: Array<Record<string, string>> }
    expect(parsed.items[0]).toEqual({ id: '1', col2: 'x', col3: 'y' })
  })
})
