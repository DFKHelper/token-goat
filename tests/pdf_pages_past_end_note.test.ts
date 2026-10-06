// `pdf-extract --pages 2-5` on a two-page PDF printed page 2 and said nothing about pages 3-5, while `--pages 9` on the same file failed naming the page count, so a range that ran off the end read as a complete answer for every page it asked for. pdf-locate shares the same page parser and stopped silently too. Both now say on stderr how far the range was cut, and stdout keeps only the extracted text or the --json body.
//
// Provenance: the PDF below is FORMAT-DERIVED from ISO 32000-1 (7.7.3.2 page tree with /Kids and /Count, 9.4.3 BT/Tf/Td/Tj text showing), the same object layout tests/cli_doc_extract_fencing.test.ts builds, here with one page per entry. The expected notes are HAND-DERIVED from the page count the fixture declares. The cases run the built dist/token-goat.mjs.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let pdf: string

function buildPdf(pageTexts: string[]): Buffer {
  const objects: string[] = []
  const fontId = 3
  const kids = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (const [i, text] of pageTexts.entries()) {
    const content = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /MediaBox [0 0 400 200] /Contents ${5 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pdf-pages-home-'))
  pdf = path.join(home, 'two.pdf')
  fs.writeFileSync(pdf, buildPdf(['First sheet', 'Second sheet']))
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function tg(args: string[]): { stdout: string; stderr: string } {
  const r = runBundle(args, { cwd: home, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 60_000 })
  expect(r.status, r.stderr).toBe(0)
  return { stdout: r.stdout.replace(/\r\n/g, '\n'), stderr: r.stderr.replace(/\r\n/g, '\n') }
}

describe('a --pages range past the last page says where it stopped', () => {
  it('pdf-extract names the cut and still prints the pages that exist', () => {
    const one = tg(['pdf-extract', pdf, '--pages', '2-5'])
    expect(one.stdout).toContain('Second sheet')
    expect(one.stdout).not.toContain('First sheet')
    expect(one.stderr.trim()).toBe("--pages 2-5 runs past the document's 2 pages; showing page 2.")
    const both = tg(['pdf-extract', pdf, '--pages', '1-9'])
    expect(both.stderr.trim()).toBe("--pages 1-9 runs past the document's 2 pages; showing pages 1-2.")
  })

  it('pdf-extract says nothing for a range inside the document', () => {
    expect(tg(['pdf-extract', pdf, '--pages', '1-2']).stderr).toBe('')
    expect(tg(['pdf-extract', pdf, '--pages', '2']).stderr).toBe('')
  })

  it('pdf-locate names the cut on stderr in text and --json mode', () => {
    const text = tg(['pdf-locate', pdf, 'sheet', '--pages', '1-4'])
    expect(text.stdout).toContain('p2:')
    expect(text.stderr.trim()).toBe("--pages 1-4 runs past the document's 2 pages; showing pages 1-2.")
    const json = tg(['pdf-locate', pdf, 'sheet', '--pages', '1-4', '--json'])
    expect(JSON.parse(json.stdout).pages).toEqual([1, 2])
    expect(json.stderr.trim()).toBe("--pages 1-4 runs past the document's 2 pages; showing pages 1-2.")
  })
})
