// Every reader that prints a file the user named must hold its output to overflow_guard.max_tokens: the csv, sqlite and Office readers fenced what they printed and never capped it, so a large workbook, deck, table or database filled the context in one call.

// HAND-DERIVED: each input is generated to be larger than the cap by a wide margin (hundreds of rows, sheets, slides, headings or cues, each far past the 1000-token floor together) and holds nothing a reader would decline to print; the only expectation is the cap marker and a closing fence tag, which follow from the overflow_guard contract and not from any reader's output.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ExcelJS from 'exceljs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { invalidateConfigCache } from '../src/config.js'
import Database from '../src/sqlite_driver.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'
import { buildDocxFixture, buildDocxWithTableFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

const COUNT = 400
const CLOSE_TAG = '</untrusted-file-content>'
const MARKER = '[token-goat: output capped'
/** Well past the 1000-token floor (about 4000 characters) and well under what an uncapped COUNT-entry listing prints. */
const CEILING_CHARS = 12_000

let root: string
let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

function pdfWithOutline(titles: string[]): Buffer {
  const content = 'BT /F1 12 Tf 10 100 Td (Hello) Tj ET'
  const first = 7
  const items = titles.map((t, i) => {
    const num = first + i
    const next = i + 1 < titles.length ? ` /Next ${num + 1} 0 R` : ''
    const prev = i > 0 ? ` /Prev ${num - 1} 0 R` : ''
    return `${num} 0 obj\n<< /Title (${t}) /Parent 6 0 R${prev}${next} /Dest [3 0 R /Fit] >>\nendobj\n`
  })
  const last = first + titles.length - 1
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 400 200] /Contents 5 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
    `6 0 obj\n<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count ${titles.length} >>\nendobj\n` +
    items.join('') +
    `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** One page per entry, each holding one line of text, so a search matches once on every page. */
function pdfWithPages(lines: string[]): Buffer {
  const pageNum = (i: number): number => 4 + i * 2
  const kids = lines.map((_, i) => `${pageNum(i)} 0 R`).join(' ')
  const objs = lines.map((l, i) => {
    const content = `BT /F1 12 Tf 10 100 Td (${l}) Tj ET`
    return (
      `${pageNum(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 400 200] /Contents ${pageNum(i) + 1} 0 R >>\nendobj\n` +
      `${pageNum(i) + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
    )
  })
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>\nendobj\n` +
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    objs.join('') +
    `trailer\n<< /Size ${4 + lines.length * 2} /Root 1 0 R >>\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const WIDE = 'wide-cell-text-'.repeat(8)

beforeAll(async () => {
  process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '1000'
  invalidateConfigCache()
  root = mkdtempSync(join(tmpdir(), 'tg-reader-cap-'))

  const csvRows = ['name,note', ...Array.from({ length: COUNT }, (_, i) => `row${i},${WIDE}${i}`)]
  writeFileSync(join(root, 'big.csv'), `${csvRows.join('\n')}\n`)
  const csvWide = [Array.from({ length: COUNT }, (_, i) => `column_number_${i}`).join(','), Array.from({ length: COUNT }, (_, i) => `v${i}`).join(',')]
  writeFileSync(join(root, 'wide.csv'), `${csvWide.join('\n')}\n`)

  const db = new Database(join(root, 'big.db'))
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
  for (let i = 0; i < COUNT; i++) db.exec(`CREATE TABLE table_with_a_long_name_${i} (id INTEGER PRIMARY KEY, value_${i} TEXT)`)
  db.exec(`INSERT INTO notes (body) VALUES ${Array.from({ length: COUNT }, (_, i) => `('${WIDE}${i}')`).join(',')}`)
  db.close()

  const book = new ExcelJS.Workbook()
  for (let s = 0; s < 60; s++) book.addWorksheet(`sheet_with_a_long_name_${s}`.slice(0, 31))
  const data = book.worksheets[0]!
  data.addRow(['key', 'note'])
  for (let i = 0; i < COUNT; i++) data.addRow([`row${i}`, `${WIDE}${i}`])
  const wide = book.addWorksheet('wide')
  wide.addRow(Array.from({ length: COUNT }, (_, i) => `column_number_${i}`))
  wide.addRow(Array.from({ length: COUNT }, (_, i) => `v${i}`))
  await book.xlsx.writeFile(join(root, 'big.xlsx'))

  writeFileSync(join(root, 'big.pptx'), buildPptxFixture([
    ...Array.from({ length: COUNT }, (_, i) => ({ title: `slide number ${i} with a long title`, body: [`needle ${i}`] })),
    { title: 'last', body: Array.from({ length: COUNT }, (_, i) => `${WIDE}${i}`), notes: Array.from({ length: COUNT }, (_, i) => `${WIDE}${i}`).join(' ') },
  ]))

  writeFileSync(join(root, 'big.docx'), buildDocxFixture(Array.from({ length: COUNT }, (_, i) => ({ text: `heading number ${i} with a long title`, headingLevel: 1 }))))
  writeFileSync(join(root, 'tables.docx'), buildDocxWithTableFixture([Array.from({ length: COUNT }, (_, i) => [`cell ${i}`, `${WIDE}${i}`])], [{ text: 'intro' }]))

  const cues = Array.from({ length: COUNT }, (_, i) => {
    const sec = String(i % 60).padStart(2, '0')
    const min = String(Math.floor(i / 60)).padStart(2, '0')
    return `${min}:${sec}.000 --> ${min}:${sec}.900\nSpeaker: ${WIDE}${i}\n`
  })
  writeFileSync(join(root, 'big.vtt'), `WEBVTT\n\n${cues.join('\n')}`)

  writeFileSync(join(root, 'outline.pdf'), pdfWithOutline(Array.from({ length: COUNT }, (_, i) => `bookmark ${i} with a long title`)))
  writeFileSync(join(root, 'text.pdf'), pdfWithPages(Array.from({ length: COUNT }, (_, i) => `needle on page ${i} with some words around it`)))
}, 120_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
})

afterAll(() => {
  delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
  invalidateConfigCache()
})

async function printed(argv: string[]): Promise<string> {
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
  process.exitCode = 0
  await run(['node', 'token-goat', ...argv])
  const text = stdout.join('')
  expect(process.exitCode ?? 0, `${argv.join(' ')} failed: ${stderr.join('')}`).toBe(0)
  return text
}

/** One command per reader, each aimed at the input in `root` that makes its uncapped output the longest. */
const CASES: ReadonlyArray<readonly [string, (p: (name: string) => string) => string[]]> = [
  ['csv-query', (p) => ['csv-query', p('big.csv'), '--head', '1000']],
  ['csv-profile', (p) => ['csv-profile', p('wide.csv')]],
  ['sqlite-schema', (p) => ['sqlite-schema', p('big.db')]],
  ['sqlite-tables', (p) => ['sqlite-tables', p('big.db')]],
  ['sqlite-query', (p) => ['sqlite-query', p('big.db'), 'SELECT body FROM notes', '--head', '1000']],
  ['xlsx-sheets', (p) => ['xlsx-sheets', p('big.xlsx')]],
  ['xlsx-head', (p) => ['xlsx-head', p('big.xlsx'), '--sheet', 'sheet_with_a_long_name_0', '--rows', '400']],
  ['xlsx-columns', (p) => ['xlsx-columns', p('big.xlsx'), '--sheet', 'wide']],
  ['xlsx-range', (p) => ['xlsx-range', p('big.xlsx'), '--sheet', 'sheet_with_a_long_name_0', '--range', 'A1:B400']],
  ['xlsx-query', (p) => ['xlsx-query', p('big.xlsx'), '--sheet', 'sheet_with_a_long_name_0', '--head', '1000']],
  ['pptx-outline', (p) => ['pptx-outline', p('big.pptx')]],
  ['pptx-slide', (p) => ['pptx-slide', p('big.pptx'), '--slide', String(COUNT + 1)]],
  ['pptx-notes', (p) => ['pptx-notes', p('big.pptx'), '--slide', String(COUNT + 1)]],
  ['pptx-text', (p) => ['pptx-text', p('big.pptx'), '--grep', 'needle']],
  ['docx-outline', (p) => ['docx-outline', p('big.docx')]],
  ['docx-tables', (p) => ['docx-tables', p('tables.docx')]],
  ['transcript', (p) => ['transcript', p('big.vtt')]],
  ['pdf-outline', (p) => ['pdf-outline', p('outline.pdf')]],
  ['pdf-locate', (p) => ['pdf-locate', p('text.pdf'), 'needle', '--max-matches', '1000']],
]

describe('readers hold their output to the overflow cap', () => {
  for (const [name, argvFor] of CASES) {
    it(name, async () => {
      const text = await printed(argvFor((file) => join(root, file)))
      expect(text, 'the cap marker is present').toContain(MARKER)
      expect(text.length, 'the output is held to the cap').toBeLessThan(CEILING_CHARS)
      expect(text.indexOf(CLOSE_TAG), 'the fence closes before the marker').toBeGreaterThan(0)
      expect(text.indexOf(CLOSE_TAG)).toBeLessThan(text.indexOf(MARKER))
    })
  }
})
