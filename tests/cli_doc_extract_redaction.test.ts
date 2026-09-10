// Regression: the document-extraction CLI commands (pdf-outline, xlsx-head, and siblings) fenced
// extracted document text for prompt injection (tests/cli_doc_extract_fencing.test.ts) but never
// redacted it -- a credential embedded in a spreadsheet cell or a PDF bookmark title reached the
// model raw. Fixed at the two shared choke points every one of these commands funnels through:
// src/cli.ts's fenceFileText and fenceFileFieldIfMatched. Drives the real, unmocked run() CLI
// entrypoint against real scratch fixture files, mirroring cli_doc_extract_fencing.test.ts.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// FORMAT-DERIVED: AKIA + 16 alphanumeric chars is exactly the shape src/secret_redact.ts's
// aws_access_key pattern matches (/AKIA[0-9A-Z]{16}/g). The literal value is AWS's own public
// documentation example key (used throughout AWS SDK docs as a placeholder), not a real credential.
const SECRET = 'AKIAIOSFODNN7EXAMPLE'

function buildPdfWithOutlineTitle(title: string): Buffer {
  const content = 'BT /F1 12 Tf 10 100 Td (Hello PDF) Tj ET'
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 400 200] /Contents 5 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
    '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n' +
    `7 0 obj\n<< /Title (${title}) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n` +
    'trailer\n<< /Size 8 /Root 1 0 R >>\n%%EOF\n'
  return Buffer.from(pdf, 'latin1')
}

let root: string
let stdout: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tg-doc-redaction-'))

  writeFileSync(join(root, 'outline.pdf'), buildPdfWithOutlineTitle(`leaked key ${SECRET}`))

  const wb = new ExcelJS.Workbook()
  const data = wb.addWorksheet('Data')
  data.addRow(['note'])
  data.addRow([SECRET])
  await wb.xlsx.writeFile(join(root, 'book.xlsx'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

async function runCli(argv: string[]): Promise<void> {
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  const stderr: string[] = []
  stderrSpy = spyOnWrite(process.stderr, stderr)
  await run(['node', 'token-goat', ...argv])
}

describe('document extractors redact secret-shaped content, not just fence it', () => {
  it('xlsx-head redacts a secret-shaped cell value', async () => {
    await runCli(['xlsx-head', join(root, 'book.xlsx'), '--sheet', 'Data'])
    const text = stdout.join('')
    expect(text).not.toContain(SECRET)
  })

  it('pdf-outline redacts a secret-shaped bookmark title, text mode', async () => {
    await runCli(['pdf-outline', join(root, 'outline.pdf')])
    const text = stdout.join('')
    expect(text).not.toContain(SECRET)
  })

  it('pdf-outline redacts a secret-shaped bookmark title inside valid --json output', async () => {
    await runCli(['pdf-outline', join(root, 'outline.pdf'), '--json'])
    const text = stdout.join('')
    const parsed = JSON.parse(text) as Array<{ title: string }>
    expect(parsed[0]?.title).not.toContain(SECRET)
  })
})
