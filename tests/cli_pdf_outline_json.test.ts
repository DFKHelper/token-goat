// Regression guard: pdf-outline was the only outline-style CLI command missing --json (skeleton,
// outline, section, symbol, semantic, and json-outline all had it), forcing an agent to
// hand-parse the indented "  Title  (p.N)" text form instead of getting structured entries.
// Drives the real run() entry so this exercises the actual command wiring, not runPdfOutline()
// in isolation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// Same fixture shape as cli_doc_extract_stats.test.ts's PDF_WITH_OUTLINE: a minimal one-page
// PDF plus an /Outlines catalog entry with one bookmark item pointing at the page.
const PDF_WITH_OUTLINE = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n' +
  '7 0 obj\n<< /Title (Chapter 1) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n' +
  'trailer\n<< /Size 8 /Root 1 0 R >>\n%%EOF\n'

let tmpDir: string
let pdfFile: string
let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('pdf-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-pdf-outline-json-'))
    pdfFile = join(tmpDir, 'doc.pdf')
    writeFileSync(pdfFile, Buffer.from(PDF_WITH_OUTLINE, 'latin1'))

    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)

    const code = await runCli(['pdf-outline', pdfFile, '--json'])

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    const parsed = JSON.parse(stdout.join('')) as Array<{ title: string; level: number; page: number | null }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.title).toBe('Chapter 1')
  })
})
