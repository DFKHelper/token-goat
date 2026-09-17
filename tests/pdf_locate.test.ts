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

// FORMAT-DERIVED: same object/xref-less layout as THREE_PAGE_PDF above, per ISO 32000-1 (9.4.3, 7.5). The font switch on every other Tj (F1/F2 alternate) is what makes pdfjs 6.3.289 emit 10 separate text items for this one line instead of merging same-font runs into one -- confirmed by a CAPTURE of page.streamTextContent() on this exact fixture (10 items, 1 literal " " item, 2 items with hasEOL: true). A single-Tj-per-line fixture like THREE_PAGE_PDF above never exercises the item-join at all, which is why the regression this fixture guards (a space-join bridging a line break, or an EOL-as-newline join breaking a phrase that legitimately wraps) needed its own fixture.
const MIXED_FONTS_PDF =
  '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n' +
  '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
  '5 0 obj\n<< /Length 247 >>\nstream\n' +
  'BT /F1 12 Tf 72 700 Td (Wagyu Games, LLC.) Tj /F2 12 Tf (, a Kentucky corporation with) Tj 0 -14 Td /F1 12 Tf (1.1 ) Tj /F2 12 Tf (Work Product) Tj /F1 12 Tf (. Any and all code) Tj 0 -14 Td (\\() Tj /F2 12 Tf (Company) Tj /F1 12 Tf (\\), and) Tj ET\n' +
  'endstream\nendobj\n' +
  '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n' +
  'trailer\n<< /Size 7 /Root 1 0 R >>\n%%EOF\n'

function mixedFontsBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(MIXED_FONTS_PDF, 'latin1'))
}

// The new truncated-scan assertions below are HAND-DERIVED: which pages match "a" and how many
// pages the fixture has are read off THREE_PAGE_PDF's own text streams above, independently of
// locatePdfPages's implementation -- not from running the code and pasting its output back.
describe('locatePdfPages', () => {
  it('returns only the single page whose text matches', async () => {
    const { matches, truncated } = await locatePdfPages(threePageBytes(), 'beta', {})
    expect(matches.map((m) => m.page)).toEqual([2])
    // Full line, trailing word included -- guards against the fixture's page text being
    // silently clipped (a too-narrow MediaBox drops the last word, and a snippet check for
    // just "beta" would still pass on the truncated text).
    expect(matches[0]?.snippet).toBe('beta summary detail')
    expect(truncated).toBe(false)
  })

  it('matches a trailing word that a narrow page box would have clipped', async () => {
    // "notes" is the last word of page 3; if the fixture ever truncates, this goes red.
    const { matches } = await locatePdfPages(threePageBytes(), 'notes', {})
    expect(matches.map((m) => m.page)).toEqual([3])
    expect(matches[0]?.snippet).toBe('gamma appendix notes')
  })

  it('returns matching pages in ascending order when several pages match', async () => {
    const { matches } = await locatePdfPages(threePageBytes(), 'alpha|gamma', {})
    expect(matches.map((m) => m.page)).toEqual([1, 3])
  })

  it('matches case-insensitively only when ignoreCase is set', async () => {
    const sensitive = await locatePdfPages(threePageBytes(), 'ALPHA', {})
    expect(sensitive.matches).toEqual([])
    const insensitive = await locatePdfPages(threePageBytes(), 'ALPHA', { ignoreCase: true })
    expect(insensitive.matches.map((m) => m.page)).toEqual([1])
  })

  it('stops after maxMatches page-matches and reports the scan as truncated', async () => {
    // "a" appears on every page (alpha, beta, gamma); the cap must stop at 2 pages, with page 3
    // left unscanned -- this is the case that must be disclosed, not printed as a plain total.
    const { matches, truncated } = await locatePdfPages(threePageBytes(), 'a', { maxMatches: 2 })
    expect(matches.map((m) => m.page)).toEqual([1, 2])
    expect(truncated).toBe(true)
  })

  it('does not report truncated when the cap is reached on the exact last page scanned', async () => {
    // maxMatches equals the number of matching pages in the full 3-page document (and the whole
    // document is scanned) -- the cap and the true total coincide, so this must NOT be reported
    // as truncated even though matches.length === maxMatches. This is the distinction the fix
    // exists to get right: hitting the cap is not the same as stopping early.
    const { matches, truncated } = await locatePdfPages(threePageBytes(), 'a', { maxMatches: 3 })
    expect(matches.map((m) => m.page)).toEqual([1, 2, 3])
    expect(truncated).toBe(false)
  })

  it('returns an empty array when nothing matches', async () => {
    const { matches, truncated } = await locatePdfPages(threePageBytes(), 'zzzznope', {})
    expect(matches).toEqual([])
    expect(truncated).toBe(false)
  })

  it('throws an error naming the bad pattern for an invalid regex', async () => {
    await expect(locatePdfPages(threePageBytes(), '[', {})).rejects.toThrow(/invalid regex pattern: \[/)
  })

  it('restricts the scan to the --pages window', async () => {
    // "a" matches all three pages, but the 2-3 window must exclude page 1.
    const { matches } = await locatePdfPages(threePageBytes(), 'a', { pages: '2-3' })
    expect(matches.map((m) => m.page)).toEqual([2, 3])
  })

  // Regression: locatePdfPages joined every pdfjs text item with a literal space, which happened to bridge cross-line phrases (a line-wrapped phrase still matched) but also inserted a phantom space between adjacent same-line word-fragment items pdfjs never separated, so a phrase spanning a font switch mid-word (e.g. "LLC." next to ", a") never matched. Joining on pdfjs's own hasEOL flag with a space (not a newline, unlike plain-mode extractPdfText) keeps the cross-line match working while fixing the mid-line one.
  it('matches a phrase that spans a font switch mid-line, which the old space-at-every-boundary join already produced text for coincidentally', async () => {
    const { matches } = await locatePdfPages(mixedFontsBytes(), 'LLC\\., a Kentucky', {})
    expect(matches.map((m) => m.page)).toEqual([1])
  })

  it('matches a phrase spanning a font switch after a period', async () => {
    const { matches } = await locatePdfPages(mixedFontsBytes(), 'Work Product\\. Any', {})
    expect(matches.map((m) => m.page)).toEqual([1])
  })

  it('matches a parenthesized phrase that spans a font switch', async () => {
    const { matches } = await locatePdfPages(mixedFontsBytes(), '\\(Company\\)', {})
    expect(matches.map((m) => m.page)).toEqual([1])
  })

  // Cross-line regression guard: if the fix ever maps hasEOL to '\n' in locatePdfPages the same way extractPdfText does, a phrase that legitimately wraps across a line break stops matching. locatePdfPages must keep joining on a space so a page is still one searchable line.
  it('still matches a phrase that wraps across a line break (would regress if EOL were joined as a newline here)', async () => {
    const { matches } = await locatePdfPages(mixedFontsBytes(), 'corporation with 1\\.1 Work', {})
    expect(matches.map((m) => m.page)).toEqual([1])
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
      truncated: boolean
      pages: number[]
      matches: Array<{ page: number; snippet: string }>
    }
    expect(parsed.pattern).toBe('beta')
    expect(parsed.matchCount).toBe(1)
    expect(parsed.truncated).toBe(false)
    expect(parsed.pages).toEqual([2])
    expect(parsed.matches).toHaveLength(1)
    expect(parsed.matches[0]?.page).toBe(2)
    expect(parsed.matches[0]?.snippet).toContain('beta')
  })

  // HAND-DERIVED: "a" matches all three pages of THREE_PAGE_PDF's own text (read off the fixture
  // above), so a --max-matches of 2 must stop with page 3 unscanned -- the exact "cap reached
  // while pages remained" case defect 1 exists to disclose, not the coincidental exact-cap case.
  it('renders a floor with the max-matches escape hatch when the scan is truncated', async () => {
    const code = await runCli(['pdf-locate', '<file>', 'a', '--max-matches', '2'])
    expect(code).toBe(0)
    const text = stdout.join('')
    expect(text).toContain('at least 2 matches across at least 2 pages')
    expect(text).toContain('raise it for more')
    expect(text).not.toMatch(/(?<!at least )\b2 matches across 2 pages\b/)
  })
})
