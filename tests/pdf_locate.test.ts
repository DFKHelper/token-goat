import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { locatePdfPages } from '../src/pdf_extract.js'
import { run } from '../src/cli.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

// Hand-authored 3-page PDF with DISTINCT text per page (same fixture shape as
// tests/pdf_extract.test.ts's MINIMAL_PDF), so a locate pass can prove it
// returns the right page numbers and nothing more. The MediaBox is standard
// Letter (612x792) at 12pt: pdfjs clips glyphs that fall outside the page box,
// so a narrow 200x200 box would silently drop the trailing word of each line
// and the fixture text would not be what it reads as. /Length is exact.
const THREE_PAGE_PDF =
  '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /MediaBox [0 0 612 792] /Contents 6 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /MediaBox [0 0 612 792] /Contents 7 0 R >>\nendobj\n' +
  '5 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 9 0 R >> >> /MediaBox [0 0 612 792] /Contents 8 0 R >>\nendobj\n' +
  '6 0 obj\n<< /Length 50 >>\nstream\nBT /F1 12 Tf 20 100 Td (alpha invoice total) Tj ET\nendstream\nendobj\n' +
  '7 0 obj\n<< /Length 50 >>\nstream\nBT /F1 12 Tf 20 100 Td (beta summary detail) Tj ET\nendstream\nendobj\n' +
  '8 0 obj\n<< /Length 51 >>\nstream\nBT /F1 12 Tf 20 100 Td (gamma appendix notes) Tj ET\nendstream\nendobj\n' +
  '9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  'trailer\n<< /Size 10 /Root 1 0 R >>\n%%EOF\n'

function threePageBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(THREE_PAGE_PDF, 'latin1'))
}

describe('locatePdfPages', () => {
  it('returns only the single page whose text matches', async () => {
    const matches = await locatePdfPages(threePageBytes(), 'beta', {})
    expect(matches.map((m) => m.page)).toEqual([2])
    // Full line, trailing word included -- guards against the fixture's page text being
    // silently clipped (a too-narrow MediaBox drops the last word, and a snippet check for
    // just "beta" would still pass on the truncated text).
    expect(matches[0]?.snippet).toBe('beta summary detail')
  })

  it('matches a trailing word that a narrow page box would have clipped', async () => {
    // "notes" is the last word of page 3; if the fixture ever truncates, this goes red.
    const matches = await locatePdfPages(threePageBytes(), 'notes', {})
    expect(matches.map((m) => m.page)).toEqual([3])
    expect(matches[0]?.snippet).toBe('gamma appendix notes')
  })

  it('returns matching pages in ascending order when several pages match', async () => {
    const matches = await locatePdfPages(threePageBytes(), 'alpha|gamma', {})
    expect(matches.map((m) => m.page)).toEqual([1, 3])
  })

  it('matches case-insensitively only when ignoreCase is set', async () => {
    const sensitive = await locatePdfPages(threePageBytes(), 'ALPHA', {})
    expect(sensitive).toEqual([])
    const insensitive = await locatePdfPages(threePageBytes(), 'ALPHA', { ignoreCase: true })
    expect(insensitive.map((m) => m.page)).toEqual([1])
  })

  it('stops after maxMatches page-matches', async () => {
    // "a" appears on every page (alpha, beta, gamma); the cap must stop at 2 pages.
    const matches = await locatePdfPages(threePageBytes(), 'a', { maxMatches: 2 })
    expect(matches.map((m) => m.page)).toEqual([1, 2])
  })

  it('returns an empty array when nothing matches', async () => {
    const matches = await locatePdfPages(threePageBytes(), 'zzzznope', {})
    expect(matches).toEqual([])
  })

  it('throws an error naming the bad pattern for an invalid regex', async () => {
    await expect(locatePdfPages(threePageBytes(), '[', {})).rejects.toThrow(/invalid regex pattern: \[/)
  })

  it('restricts the scan to the --pages window', async () => {
    // "a" matches all three pages, but the 2-3 window must exclude page 1.
    const matches = await locatePdfPages(threePageBytes(), 'a', { pages: '2-3' })
    expect(matches.map((m) => m.page)).toEqual([2, 3])
  })
})

describe('pdf-locate CLI', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-pdf-locate-cli-'))
    pdfFile = join(tmpDir, 'doc.pdf')
    writeFileSync(pdfFile, Buffer.from(THREE_PAGE_PDF, 'latin1'))
    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
    stderr = []
    stderrSpy = spyOnWrite(process.stderr, stderr)
    const prev = process.exitCode
    process.exitCode = 0
    try {
      await run(['node', 'token-goat', ...argv.map((a) => (a === '<file>' ? pdfFile : a))])
      return process.exitCode
    } finally {
      process.exitCode = prev
    }
  }

  it('prints one line per match and a summary line', async () => {
    const code = await runCli(['pdf-locate', '<file>', 'alpha|gamma'])
    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    const text = stdout.join('')
    expect(text).toContain('p1: ')
    expect(text).toContain('p3: ')
    expect(text).toContain('2 matches across 2 pages')
  })

  it('prints (no matches) and exits 0 when nothing matches', async () => {
    const code = await runCli(['pdf-locate', '<file>', 'zzzznope'])
    expect(code).toBe(0)
    expect(stdout.join('').trim()).toBe('(no matches)')
  })

  it('emits the documented JSON object shape with --json', async () => {
    const code = await runCli(['pdf-locate', '<file>', 'beta', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.join('')) as {
      file: string
      pattern: string
      matchCount: number
      pages: number[]
      matches: Array<{ page: number; snippet: string }>
    }
    expect(parsed.pattern).toBe('beta')
    expect(parsed.matchCount).toBe(1)
    expect(parsed.pages).toEqual([2])
    expect(parsed.matches).toHaveLength(1)
    expect(parsed.matches[0]?.page).toBe(2)
    expect(parsed.matches[0]?.snippet).toContain('beta')
  })
})
