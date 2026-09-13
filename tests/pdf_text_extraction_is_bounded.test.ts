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

import type * as pdfjsTypes from 'pdfjs-dist/legacy/build/pdf.mjs'

import {
  assertPdfIsARegularFileWithinBounds,
  assertPdfTextWithinBounds,
  extractPdfMeta,
  extractPdfText,
  locatePdfPages,
  MAX_PDF_INPUT_BYTES,
  MAX_PDF_TEXT_BYTES,
  MAX_PDF_TEXT_ITEMS,
  MAX_PDF_WORK_MILLIS,
  PdfTooLargeError,
  PdfTookTooLongError,
  pdfWorkDeadline,
  readAllWithinReportedSize,
  readPageTextItems,
  readPdfFileWithinBounds,
} from '../src/pdf_extract.js'
import { extractEmbeddableDocumentText, isDocumentRefusal } from '../src/doc_embed_extract.js'
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
  it('refuses a bomb instead of taking the worker down with it', async () => {
    const file = path.join(dir, 'indexed-bomb.pdf')
    fs.writeFileSync(file, BOMB)
    await expect(extractEmbeddableDocumentText(file)).rejects.toThrow(PdfTooLargeError)
  })

  it('tells a refusal apart from a failure, which is what decides whether the file is ever read again', async () => {
    // A refusal is a verdict on these bytes and repeats forever, so the indexer records it and
    // stops. A failure is a fact about this moment, and recording it would retire the document
    // permanently over a condition that has already passed.
    expect(isDocumentRefusal(new PdfTooLargeError('past the budget'))).toBe(true)
    expect(isDocumentRefusal(new PdfTookTooLongError('past the clock'))).toBe(true)
    expect(isDocumentRefusal(new Error('EBUSY: resource busy or locked'))).toBe(false)
    expect(isDocumentRefusal(new TypeError('pdfjs is not a function'))).toBe(false)
  })

  it('surfaces a corrupt document as a failure rather than an empty one', async () => {
    const file = path.join(dir, 'indexed-corrupt.pdf')
    fs.writeFileSync(file, Buffer.from('%PDF-1.7 this is not a PDF'))
    await expect(extractEmbeddableDocumentText(file)).rejects.toThrow()
  })

  it('still indexes an ordinary document', async () => {
    const file = path.join(dir, 'indexed-ordinary.pdf')
    fs.writeFileSync(file, ORDINARY)
    expect(await extractEmbeddableDocumentText(file)).toContain('A'.repeat(40))
  })
})


type FakeItem = { str: string }
type FakeChunk = { items: FakeItem[] }

/** A page read through pdfjs's stream, whose chunks come from `next` until it returns null. */
function streamingPage(next: () => FakeChunk | null): pdfjsTypes.PDFPageProxy {
  return {
    streamTextContent: (): ReadableStream<FakeChunk> =>
      new ReadableStream<FakeChunk>({
        pull(controller) {
          const chunk = next()
          if (chunk === null) controller.close()
          else controller.enqueue(chunk)
        },
      }),
  } as unknown as pdfjsTypes.PDFPageProxy
}

/** A page from a pdfjs build with no streaming reader, which hands over the whole page at once. */
function wholePage(items: FakeItem[]): pdfjsTypes.PDFPageProxy {
  return { getTextContent: async (): Promise<{ items: FakeItem[] }> => ({ items }) } as unknown as pdfjsTypes.PDFPageProxy
}

/** The source of one declaration in `src/pdf_extract.ts`, up to the doc comment of the next one. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, `src/pdf_extract.ts must still define ${name}`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.indexOf('\n/**')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the clock, which bounds the work a byte budget cannot', () => {
  it('stops a producer that never ends', async () => {
    let pulled = 0
    const page = streamingPage(() => {
      pulled++
      return { items: [{ str: 'A' }] }
    })
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() - 1)).rejects.toThrow(PdfTookTooLongError)
    expect(pulled).toBeLessThan(10)
  })

  it('ends the drain that the refusal itself cannot break out of', async () => {
    // Passing the budget frees the memory and nothing else: the refusal keeps reading, because
    // cancelling throws from inside pdfjs and abandoning the reader deadlocks the teardown. So a
    // producer that never ends outlives the byte budget entirely, and the deadline is the only
    // thing that ever ends this call.
    let pulled = 0
    const page = streamingPage(() => {
      pulled++
      return { items: [{ str: 'A'.repeat(2000) }] }
    })
    await expect(readPageTextItems(page, 1000, Date.now() + 200)).rejects.toThrow(PdfTookTooLongError)
    expect(pulled).toBeGreaterThan(1)
  })

  it('names the limit it enforced and the flag that avoids it', async () => {
    const page = streamingPage(() => ({ items: [{ str: 'A' }] }))
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() - 1)).rejects.toThrow(String(MAX_PDF_WORK_MILLIS))
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() - 1)).rejects.toThrow(/--pages/)
  })

  it('is opened by every entry point that reads a page, and taken by every function that drains one', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'pdf_extract.ts'), 'utf8')
    for (const fn of ['extractPdfText', 'locatePdfPages', 'extractPdfMeta']) {
      expect(bodyOf(src, fn), `${fn} reads page text, so it must open a deadline`).toContain('pdfWorkDeadline()')
    }
    for (const fn of ['readPageTextItems', 'pageHasText']) {
      const body = bodyOf(src, fn)
      expect(body, `${fn} drains a page, so it must be handed a deadline`).toContain('deadline: number')
      // Taking the parameter is not checking it. pageHasText holds one boolean, so no byte budget
      // would ever stop it -- the clock is the only bound on the drain, and it only counts if the
      // loop reads it. pageHasText is not exported, so this is checked in the source.
      expect(body, `${fn} must check the deadline inside the loop that drains the page`).toContain('Date.now() > deadline')
    }
  })
})

describe('the bounds that a character count alone does not cover', () => {
  it('refuses more items than any document has, even carrying almost no text', async () => {
    const chunk: FakeChunk = { items: Array.from({ length: 1000 }, () => ({ str: 'x' })) }
    let sent = 0
    const page = streamingPage(() => (sent++ <= MAX_PDF_TEXT_ITEMS / 1000 ? chunk : null))
    await expect(readPageTextItems(page, Number.MAX_SAFE_INTEGER, pdfWorkDeadline())).rejects.toThrow(PdfTooLargeError)
  })

  it('charges an item that carries no text for the separator it still costs', async () => {
    let sent = 0
    const page = streamingPage(() => (sent++ < 1 ? { items: Array.from({ length: 5000 }, () => ({ str: '' })) } : null))
    await expect(readPageTextItems(page, 4999, pdfWorkDeadline())).rejects.toThrow(PdfTooLargeError)
  })

  it('still returns a page that clears both', async () => {
    let sent = 0
    const page = streamingPage(() => (sent++ < 3 ? { items: Array.from({ length: 10 }, () => ({ str: 'hello' })) } : null))
    expect(await readPageTextItems(page, MAX_PDF_TEXT_BYTES, pdfWorkDeadline())).toHaveLength(30)
  })
})

describe('the text budget is stated in bytes, so it is checked in bytes', () => {
  // HAND-DERIVED: 'e' with an acute accent is one UTF-16 code unit and two UTF-8 bytes, so a
  // string one code unit under the limit encodes to nearly twice it. Computed from the encoding,
  // not read off this module's output.
  const accented = 'é'.repeat(MAX_PDF_TEXT_BYTES - 1)

  it('refuses text that fits the character count and not the encoding', () => {
    expect(accented.length).toBeLessThan(MAX_PDF_TEXT_BYTES)
    expect(Buffer.byteLength(accented, 'utf8')).toBeGreaterThan(MAX_PDF_TEXT_BYTES)
    expect(() => assertPdfTextWithinBounds(accented)).toThrow(PdfTooLargeError)
  })

  it('accepts ordinary text of the same character count', () => {
    expect(() => assertPdfTextWithinBounds('a'.repeat(MAX_PDF_TEXT_BYTES))).not.toThrow()
  })
})

describe('a pdfjs build with no streaming reader, which hands over a whole page at once', () => {
  it('refuses a page past the item bound instead of holding it', async () => {
    const page = wholePage(Array.from({ length: MAX_PDF_TEXT_ITEMS + 1 }, () => ({ str: 'x' })))
    await expect(readPageTextItems(page, Number.MAX_SAFE_INTEGER, pdfWorkDeadline())).rejects.toThrow(PdfTooLargeError)
  })

  it('returns a page of more items than one spread call can carry', async () => {
    // The whole page arrives as a single chunk here, and appending it with `push(...chunk)` throws
    // RangeError past V8's argument limit -- an obscure crash in place of either the text or the
    // refusal. Measured: 125,000 arguments already throws on the Node this suite runs on.
    const page = wholePage(Array.from({ length: 150_000 }, () => ({ str: 'x' })))
    expect(await readPageTextItems(page, Number.MAX_SAFE_INTEGER, pdfWorkDeadline())).toHaveLength(150_000)
  })
})

describe('reading the file, which is a second lookup of a name that may have changed', () => {
  it('refuses anything that is not a regular file, because nothing else has a size to bound', () => {
    const notAFile = { isFile: (): boolean => false, size: 0 }
    expect(() => assertPdfIsARegularFileWithinBounds(notAFile, 'pipe.pdf')).toThrow(PdfTooLargeError)
    expect(() => assertPdfIsARegularFileWithinBounds(notAFile, 'pipe.pdf')).toThrow(/not a regular file/)
  })

  it('refuses a file that outgrows the size its own descriptor reported', async () => {
    // HAND-DERIVED: a handle reporting 1,024 bytes that keeps delivering, which is what a file
    // being appended to during the read looks like from the reader's side.
    const endless = { read: async (_buffer: Buffer, _offset: number, length: number): Promise<{ bytesRead: number }> => ({ bytesRead: Math.min(length, 256) }) }
    await expect(readAllWithinReportedSize(endless, 1024, 'growing.pdf')).rejects.toThrow(PdfTooLargeError)
    await expect(readAllWithinReportedSize(endless, 1024, 'growing.pdf')).rejects.toThrow(/grew past/)
  })

  it('returns exactly what a file of the reported size delivers', async () => {
    const payload = Buffer.from('%PDF-1.7 hello')
    let position = 0
    const handle = {
      read: async (buffer: Buffer, offset: number, length: number): Promise<{ bytesRead: number }> => {
        const bytesRead = payload.copy(buffer, offset, position, Math.min(position + length, payload.length))
        position += bytesRead
        return { bytesRead }
      },
    }
    expect(Buffer.from(await readAllWithinReportedSize(handle, payload.length, 'ok.pdf'))).toEqual(payload)
  })

  it('reads a real file through the one descriptor it measured', async () => {
    const file = path.join(dir, 'descriptor.pdf')
    fs.writeFileSync(file, ORDINARY)
    expect(Buffer.from(await readPdfFileWithinBounds(file))).toEqual(Buffer.from(ORDINARY))
  })
})
