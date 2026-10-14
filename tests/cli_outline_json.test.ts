// Regression guard: pdf-outline was the only outline-style CLI command missing --json (skeleton, outline, section, symbol, semantic, and json-outline all had it), forcing an agent to hand-parse the indented "  Title  (p.N)" text form instead of getting structured entries. Drives the real run() entry so this exercises the actual command wiring, not runPdfOutline() in isolation. The docx, pptx, pdf and transcript outline commands share one spy/runCli/tmpdir setup here and keep their own field-shape assertions.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCliExitCode } from './helpers/run-cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'
import { buildDocxFixture, buildPptxFixture } from './helpers/ooxml_fixtures.js'

// Same fixture shape as cli_doc_extract_stats.test.ts's PDF_WITH_OUTLINE: a minimal one-page PDF plus an /Outlines catalog entry with one bookmark item pointing at the page.
const PDF_WITH_OUTLINE = '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n' +
  '6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n' +
  '7 0 obj\n<< /Title (Chapter 1) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n' +
  'trailer\n<< /Size 8 /Root 1 0 R >>\n%%EOF\n'

// Minimal WebVTT fixture with speaker cues
const VTT_WITH_CUES = `WEBVTT

00:00:00.000 --> 00:00:05.000
<v Speaker A>Hello world

00:00:05.000 --> 00:00:10.000
<v Speaker B>This is a test
`

let tmpDir: string
let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Writes `data` to a fresh temp file, runs `<command> <file> --json` under the stdio spies, asserts a clean exit, and returns the parsed stdout.
async function outlineJson(command: string, prefix: string, fileName: string, data: string | Uint8Array): Promise<unknown> {
  tmpDir = mkdtempSync(join(tmpdir(), prefix))
  const file = join(tmpDir, fileName)
  writeFileSync(file, data)

  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderr = []
  stderrSpy = spyOnWrite(process.stderr, stderr)

  const code = await runCliExitCode([command, file, '--json'])

  expect(code).toBe(0)
  expect(stderr.join('')).toBe('')
  return JSON.parse(stdout.join(''))
}

describe('docx-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    const docxData = buildDocxFixture([{ text: 'Heading 1', headingLevel: 1 }, { text: 'Heading 2', headingLevel: 2 }])
    const parsed = (await outlineJson('docx-outline', 'tg-docx-outline-json-', 'doc.docx', docxData)) as Array<{ level: number; text: string }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.level).toBe(1)
    expect(parsed[0]?.text).toBe('Heading 1')
    expect(parsed[1]?.level).toBe(2)
    expect(parsed[1]?.text).toBe('Heading 2')
  })
})

describe('pptx-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    const pptxData = buildPptxFixture([{ title: 'Slide 1', body: ['Hello'] }])
    const parsed = (await outlineJson('pptx-outline', 'tg-pptx-outline-json-', 'doc.pptx', pptxData)) as Array<{ slide: number; title: string; bodyChars: number; hasNotes: boolean }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.slide).toBe(1)
    expect(parsed[0]?.title).toBe('Slide 1')
  })
})

describe('pdf-outline --json', () => {
  it('emits structured JSON entries instead of rejecting --json as unknown', async () => {
    const parsed = (await outlineJson('pdf-outline', 'tg-pdf-outline-json-', 'doc.pdf', Buffer.from(PDF_WITH_OUTLINE, 'latin1'))) as Array<{ title: string; level: number; page: number | null }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.title).toBe('Chapter 1')
  })
})

describe('transcript-outline --json', () => {
  it('emits structured JSON instead of rejecting --json as unknown', async () => {
    const parsed = (await outlineJson('transcript-outline', 'tg-transcript-outline-json-', 'transcript.vtt', VTT_WITH_CUES)) as { durationSeconds: number; speakers: Array<{ name: string; cueCount: number }>; markers: Array<{ timestamp: string; preview: string }> }
    expect(parsed).toHaveProperty('durationSeconds')
    expect(parsed).toHaveProperty('speakers')
    expect(parsed).toHaveProperty('markers')
    expect(Array.isArray(parsed.speakers)).toBe(true)
    expect(Array.isArray(parsed.markers)).toBe(true)
    expect(parsed.speakers.length).toBeGreaterThan(0)
  })
})
