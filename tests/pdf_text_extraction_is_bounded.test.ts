/**
 * A PDF's content stream is compressed, so the text it yields is bounded by nothing the file's own
 * size reveals. The OOXML readers have refused an over-expanding archive since `zip_bounds.ts`; the
 * PDF readers had no equivalent, and a small crafted file could exhaust the heap in every one of
 * them -- including the indexer's, which opens PDFs unprompted and discards the failure, so the
 * background worker crash-looped where nobody was watching. Measured on the fixture below at
 * `--max-old-space-size=512`: 160 KB of file, 35 million characters of text, 740 MB resident.
 *
 * These tests pin the two fences that now exist: a text budget enforced while pages stream, and an
 * input-size cap applied before a file is read at all. Each is paired with a calibration proving an
 * ordinary document still comes back whole, because a bound that refuses everything satisfies the
 * refusal assertions just as well.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { extractPdfMeta, extractPdfText, locatePdfPages, MAX_PDF_INPUT_BYTES, MAX_PDF_TEXT_BYTES, PdfTooLargeError } from '../src/pdf_extract.js'
import { extractEmbeddableDocumentText } from '../src/doc_embed_extract.js'
import { runPdfExtractText, runPdfLocate, runPdfMeta, runPdfOutline } from '../src/read_commands.js'
import { pdfBomb } from './helpers/pdf-bomb.js'

const BOMB_OPS = 130_000
const BOMB_CHARS_PER_OP = 70
// Past MAX_PDF_TEXT_BYTES of extracted text, in a file of a few dozen kilobytes: the point of the class.
const BOMB = pdfBomb({ ops: BOMB_OPS, charsPerOp: BOMB_CHARS_PER_OP })
const ORDINARY = pdfBomb({ ops: 3, charsPerOp: 40 })

let dir: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pdf-bound-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a PDF whose text expands past the extraction budget', () => {
  it('is far smaller on disk than the text it would produce, which is what makes the bound necessary', () => {
    expect(BOMB.length).toBeLessThan(MAX_PDF_TEXT_BYTES / 10)
    expect(BOMB_OPS * BOMB_CHARS_PER_OP).toBeGreaterThan(MAX_PDF_TEXT_BYTES)
  })

  it('is refused by extractPdfText, naming the flag that would make the read possible', async () => {
    await expect(extractPdfText(new Uint8Array(BOMB))).rejects.toThrow(PdfTooLargeError)
    await expect(extractPdfText(new Uint8Array(BOMB))).rejects.toThrow(/--pages/)
  })

  it('is refused by the locate scan, which reads the same pages', async () => {
    await expect(locatePdfPages(new Uint8Array(BOMB), 'AAAA', {})).rejects.toThrow(PdfTooLargeError)
  })

  it('still lets an ordinary document through whole', async () => {
    const { text, pageCount } = await extractPdfText(new Uint8Array(ORDINARY))
    expect(pageCount).toBe(1)
    expect(text).toContain('A'.repeat(40))
  })

  it('does not stop pdf-meta, which only asks whether a text layer exists', async () => {
    const meta = await extractPdfMeta(new Uint8Array(BOMB))
    expect(meta.pageCount).toBe(1)
    expect(meta.hasTextLayer).toBe(true)
  })
})

describe('a PDF whose size alone is past the input cap', () => {
  let huge: string

  beforeAll(() => {
    huge = path.join(dir, 'huge.pdf')
    fs.writeFileSync(huge, ORDINARY)
    // Sparse on the filesystems this runs on, so the fixture costs no real disk.
    fs.truncateSync(huge, MAX_PDF_INPUT_BYTES + 1)
  })

  it.each([
    ['pdf-extract', async (): Promise<unknown> => runPdfExtractText(huge)],
    ['pdf-outline', async (): Promise<unknown> => runPdfOutline(huge)],
    ['pdf-meta', async (): Promise<unknown> => runPdfMeta(huge)],
    ['pdf-locate', async (): Promise<unknown> => runPdfLocate(huge, 'x', {})],
  ])('is refused by %s before the file is read', async (_name, run) => {
    await expect(run()).rejects.toThrow(PdfTooLargeError)
  })

  it('reports the size that was refused, so the message is actionable', async () => {
    await expect(runPdfMeta(huge)).rejects.toThrow(String(MAX_PDF_INPUT_BYTES + 1))
  })

  it('still reads a file under the cap', async () => {
    const ordinary = path.join(dir, 'ordinary.pdf')
    fs.writeFileSync(ordinary, ORDINARY)
    expect((await runPdfMeta(ordinary)).pageCount).toBe(1)
  })
})

describe('the indexer, which opens every PDF in the tree without being asked', () => {
  it('skips a bomb instead of taking the worker down with it', async () => {
    const file = path.join(dir, 'indexed-bomb.pdf')
    fs.writeFileSync(file, BOMB)
    expect(await extractEmbeddableDocumentText(file)).toBeNull()
  })

  it('still indexes an ordinary document', async () => {
    const file = path.join(dir, 'indexed-ordinary.pdf')
    fs.writeFileSync(file, ORDINARY)
    expect(await extractEmbeddableDocumentText(file)).toContain('A'.repeat(40))
  })
})
