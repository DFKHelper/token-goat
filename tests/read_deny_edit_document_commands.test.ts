// replace, insert-section and the document commands honor the host's Read deny rules.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'
import { buildDocxFixture, buildMultiSheetXlsxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

// HAND-DERIVED: one marker per fixture, absent from every command's own text, so any output hit is the file's.
const SECRET = 'TOPSECRETDOCWORD'
const XLSX_CELL = 'p1r2c3'

let root = ''
let project = ''
let env: NodeJS.ProcessEnv = {}

type Run = { status: number | null; stdout: string; stderr: string }
const tg = (args: string[]): Run => bundleTg(project, env, args)
const both = (run: Run): string => `${run.stdout}${run.stderr}`
const tgLines = (run: Run): string[] => run.stderr.split('\n').filter((l) => l.startsWith('[tg]'))

function put(rel: string, body: string | Uint8Array): void {
  const file = path.join(project, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

// FORMAT-DERIVED: object layout and BT/Tf/Td/Tj operators from ISO 32000-1 (9.4.3, 7.5).
const pdfWith = (word: string): Uint8Array => {
  const stream = `BT /F1 8 Tf 20 100 Td (${word}) Tj ET`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> ' +
      '/MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ]
  const tail = 'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n'
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${objects.join('')}${tail}`, 'latin1'))
}

beforeAll(() => {
  ;({ root, project, env } = makeBundleProject('tg-readdeny-docs-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0' }
  put('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  for (const dir of ['secrets', 'open']) {
    put(`${dir}/notes.txt`, `first line\nthe ${SECRET} line here\nlast line\n`)
    put(`${dir}/guide.md`, `# Top\n\n## Heading ${SECRET}\n\nbody\n`)
    put(`${dir}/doc.pdf`, pdfWith(SECRET))
    const paras = [{ text: `Title ${SECRET}`, headingLevel: 1 }, { text: `para ${SECRET}` }]
    put(`${dir}/doc.docx`, buildDocxFixture(paras))
    const slide = { title: `Slide ${SECRET}`, body: [`body ${SECRET}`], notes: `notes ${SECRET}` }
    put(`${dir}/deck.pptx`, buildPptxFixture([slide]))
    put(`${dir}/book.xlsx`, buildMultiSheetXlsxFixture({ sheetCount: 1, aliasOnePart: false, rowsPerSheet: 3 }))
  }
  put('open/edit.txt', `first line\nthe ${SECRET} line here\nlast line\n`)
  put('old.txt', 'the SECRETMISSING line here')
  put('new.txt', 'replacement')
  put('content.md', 'inserted\n')
})

afterAll(() => {
  if (root !== '') fs.rmSync(root, { recursive: true, force: true })
})

describe('replace and insert-section refuse a denied file before any read', () => {
  const nearMiss = (file: string): string[] => [
    'replace', file, '--old-from', 'old.txt', '--new-from', 'new.txt',
  ]
  const oldText = (word: string): string => `first line\nthe ${SECRET} ${word} here`

  it('replace on a denied path prints none of the file text and says so in one [tg] line', () => {
    put('old.txt', oldText('lyne'))
    const refused = tg(nearMiss('secrets/notes.txt'))
    expect(refused.status, 'a denied replace must exit 1').toBe(1)
    expect(both(refused), 'the denied file text must not reach any stream').not.toContain(SECRET)
    expect(tgLines(refused).filter((l) => l.includes('read refused:')), 'one refusal line').toHaveLength(1)
  })

  it('replace on an undenied path still shows the closest region, and still replaces', () => {
    put('old.txt', oldText('lyne'))
    const miss = tg(nearMiss('open/edit.txt'))
    expect(miss.status, 'a not-found replace exits 1').toBe(1)
    expect(both(miss), 'the not-found diff of an open file still prints its region').toContain(SECRET)
    put('old.txt', oldText('line'))
    const hit = tg(nearMiss('open/edit.txt'))
    expect(hit.status, 'a matching replace on an open file exits 0').toBe(0)
    expect(hit.stdout, 'a matching replace reports the occurrence').toContain('replaced 1 occurrence')
  })

  it('insert-section on a denied path prints no heading text and says so in one [tg] line', () => {
    const args = ['insert-section', 'secrets/guide.md', '--after', 'Hedding', '--content-from', 'content.md']
    const refused = tg(args)
    expect(refused.status, 'a denied insert-section must exit 1').toBe(1)
    expect(both(refused), 'the denied file headings must not reach any stream').not.toContain(SECRET)
    expect(tgLines(refused).filter((l) => l.includes('read refused:')), 'one refusal line').toHaveLength(1)
  })

  it('insert-section on an undenied path still lists headings, and still inserts', () => {
    const miss = tg(['insert-section', 'open/guide.md', '--after', 'Hedding', '--content-from', 'content.md'])
    expect(miss.status, 'a missing section exits 1').toBe(1)
    expect(both(miss), 'the heading list of an open file still prints').toContain(SECRET)
    const hit = tg(['insert-section', 'open/guide.md', '--after', 'Top', '--content-from', 'content.md'])
    expect(hit.status, 'an insert after a real heading exits 0').toBe(0)
  })
})

describe('document commands refuse a denied file', () => {
  const cases: Array<[string, string[], string]> = [
    ['pdf-extract', ['pdf-extract', 'DIR/doc.pdf'], SECRET],
    ['pdf-locate', ['pdf-locate', 'DIR/doc.pdf', 'TOPSECRET'], SECRET],
    ['docx-text', ['docx-text', 'DIR/doc.docx'], SECRET],
    ['docx-outline', ['docx-outline', 'DIR/doc.docx'], SECRET],
    ['pptx-text', ['pptx-text', 'DIR/deck.pptx', '--grep', 'Slide'], SECRET],
    ['pptx-outline', ['pptx-outline', 'DIR/deck.pptx'], SECRET],
    ['pptx-slide', ['pptx-slide', 'DIR/deck.pptx', '--slide', '1'], SECRET],
    ['xlsx-head', ['xlsx-head', 'DIR/book.xlsx'], XLSX_CELL],
    ['xlsx-sheets', ['xlsx-sheets', 'DIR/book.xlsx'], 'Sheet1'],
  ]
  const at = (args: string[], dir: string): string[] => args.map((a) => a.replace('DIR', dir))

  it.each(cases)('%s on a denied path prints none of the document text, one [tg] line', (_n, args, marker) => {
    const refused = tg(at(args, 'secrets'))
    expect(refused.status, 'a denied document read must exit 1').toBe(1)
    expect(both(refused), 'the denied document text must not reach any stream').not.toContain(marker)
    expect(tgLines(refused).filter((l) => l.includes('read refused:')), 'one refusal line').toHaveLength(1)
  })

  it.each(cases)('%s on an undenied path still works', (_n, args, marker) => {
    const shown = tg(at(args, 'open'))
    expect(shown.status, `an open document read exits 0: ${shown.stderr.slice(0, 200)}`).toBe(0)
    expect(shown.stdout, 'the open document text is printed').toContain(marker)
  })
})
