// Regression: pdf-locate and pptx-text --grep cut each snippet to a window around the match before redacting it, so a credential straddling the window edge reached the output as a fragment the redaction patterns no longer recognised. The page or slide text is now redacted before it is matched and clipped. Drives the real, unmocked run() CLI entrypoint against real scratch documents.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { buildPptxFixture } from './helpers/ooxml_fixtures.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// HAND-DERIVED from the published AWS access key id shape (`AKIA` plus 16 uppercase alphanumerics; this is the example id AWS's own documentation prints), not read off token-goat's redaction patterns.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
// HAND-DERIVED: with --context 30 the window around the five-character match "label" at offset 0 ends at offset 18 (5 kept plus ceil(25/2) of padding), which is "label xx AKIAIOSFO": the key is cut nine characters in, too short for the 16-character tail its pattern needs.
const PAGE_TEXT = `label xx ${AWS_KEY} tail words`

// FORMAT-DERIVED: one-page layout per ISO 32000-1 (7.5, 9.4.3), the same shape as tests/cli_doc_extract_fencing.test.ts's buildPdfWithText, with /Length computed from the content stream.
function buildPdfWithText(text: string): Buffer {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
    'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n'
  return Buffer.from(pdf, 'latin1')
}

describe('pdf-locate redacts before it clips a snippet', () => {
  let tmpDir: string
  let stdout: string[]
  let stdoutSpy: WriteSpy
  let stderrSpy: WriteSpy

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function locate(extra: string[]): Promise<string> {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-pdf-locate-redact-'))
    const file = join(tmpDir, 'doc.pdf')
    writeFileSync(file, buildPdfWithText(PAGE_TEXT))
    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderrSpy = spyOnWrite(process.stderr, [])
    const prev = process.exitCode
    process.exitCode = 0
    try {
      await run(['node', 'token-goat', 'pdf-locate', file, 'label', ...extra])
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = prev
    }
    return stdout.join('')
  }

  it('keeps a key cut by the --context window out of the text output', async () => {
    const out = await locate(['--context', '30'])
    expect(out).toContain('label')
    expect(out).not.toContain('AKIAIOSF')
  })

  it('keeps a key cut by the --context window out of the JSON output', async () => {
    const out = await locate(['--context', '30', '--json'])
    expect(out).toContain('label')
    expect(out).not.toContain('AKIAIOSF')
  })

  it('still redacts a key the window holds whole', async () => {
    const out = await locate([])
    expect(out).toContain('label')
    expect(out).toContain('tail')
    expect(out).not.toContain(AWS_KEY)
  })
})

// HAND-DERIVED: "label " plus 32 "x " pairs puts the key at offset 70, and pptx-text keeps the 80 characters after a match at offset 0, so the window ends ten characters into the key ("AKIAIOSFOD"), too short for its pattern.
const SLIDE_TEXT = `label ${'x '.repeat(32)}${AWS_KEY} tail`

describe('pptx-text --grep redacts before it clips a snippet', () => {
  let tmpDir: string
  let stdoutSpy: WriteSpy
  let stderrSpy: WriteSpy

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps a key cut by the snippet window out of the output', async () => {
    expect(SLIDE_TEXT.indexOf(AWS_KEY)).toBe(70)
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-pptx-text-redact-'))
    const file = join(tmpDir, 'deck.pptx')
    writeFileSync(file, buildPptxFixture([{ title: SLIDE_TEXT }]))
    const stdout: string[] = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderrSpy = spyOnWrite(process.stderr, [])
    const prev = process.exitCode
    process.exitCode = 0
    try {
      await run(['node', 'token-goat', 'pptx-text', file, '--grep', 'label'])
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = prev
    }
    const out = stdout.join('')
    expect(out).toContain('label')
    expect(out).not.toContain('AKIAIOSF')
  })
})
