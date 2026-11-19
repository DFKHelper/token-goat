// The PDF readers in read_commands refuse a denied file themselves, not only through the CLI wrapper above them.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runPdfExtractText, runPdfLocate, runPdfMeta, runPdfOutline } from '../src/read_commands.js'
import { resetReadDenyCache } from '../src/read_deny.js'

const SECRET = 'PDFSECRETWORDX'
let dir = ''
let saved: string | undefined

// FORMAT-DERIVED: object layout and BT/Tf/Td/Tj operators from ISO 32000-1 (9.4.3, 7.5).
function pdfWith(word: string): Buffer {
  const stream = `BT /F1 8 Tf 20 100 Td (${word}) Tj ET`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ]
  return Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`, 'latin1')
}

beforeEach(() => {
  saved = process.env['CLAUDE_PROJECT_DIR']
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rdpdf-')))
  fs.mkdirSync(path.join(dir, '.claude'))
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(secrets/**)'] } }))
  for (const sub of ['secrets', 'open']) {
    fs.mkdirSync(path.join(dir, sub))
    fs.writeFileSync(path.join(dir, sub, 'doc.pdf'), pdfWith(SECRET))
  }
  process.env['CLAUDE_PROJECT_DIR'] = dir
  resetReadDenyCache()
})

afterEach(() => {
  if (saved === undefined) delete process.env['CLAUDE_PROJECT_DIR']
  else process.env['CLAUDE_PROJECT_DIR'] = saved
  fs.rmSync(dir, { recursive: true, force: true })
  resetReadDenyCache()
})

describe('PDF readers and the host Read rules', () => {
  it('extracts the text of an allowed pdf (control)', async () => {
    const res = await runPdfExtractText(path.join(dir, 'open', 'doc.pdf'))
    expect(JSON.stringify(res)).toContain(SECRET)
  })

  it('refuses every reader on a denied pdf with a refusal that holds no file text', async () => {
    const file = path.join(dir, 'secrets', 'doc.pdf')
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['extract', () => runPdfExtractText(file)],
      ['outline', () => runPdfOutline(file)],
      ['meta', () => runPdfMeta(file)],
      ['locate', () => runPdfLocate(file, SECRET, {})],
    ]
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err, `${name} must refuse a denied pdf`).not.toBeNull()
      expect(err?.message, name).toMatch(/read refused/)
      expect(err?.message, name).not.toContain(SECRET)
    }
  })
})
