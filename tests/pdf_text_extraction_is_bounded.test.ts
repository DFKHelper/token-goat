/** A PDF's content stream is compressed, so the text it yields is bounded by nothing the file's own size reveals. The OOXML readers have refused an over-expanding archive since `zip_bounds.ts`; the PDF readers had no equivalent, and a small crafted file could exhaust the heap in every one of them -- including the indexer's, which opens PDFs unprompted and discards the failure, so the background worker crash-looped where nobody was watching. Measured on the fixture below at `--max-old-space-size=512`: 160 KB of file, 35 million characters of text, 740 MB resident. These tests pin the two fences that now exist: a text budget enforced while pages stream, and an input-size cap applied before a file is read at all. Each is paired with a calibration proving an ordinary document still comes back whole, because a bound that refuses everything satisfies the refusal assertions just as well. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as pdfjsTypes from 'pdfjs-dist/legacy/build/pdf.mjs'

import {
  assertPdfIsARegularFileWithinBounds,
  assertPdfTextWithinBounds,
  extractPdfMeta,
  extractPdfOutline,
  extractPdfText,
  locatePdfPages,
  MAX_PDF_INPUT_BYTES,
  MAX_PDF_TEXT_BYTES,
  MAX_LOCATE_CONTEXT_CHARS,
  MAX_LOCATE_MATCHES,
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_TITLE_CHARS,
  MAX_PDF_TEXT_ITEMS,
  MAX_PDF_WORK_MILLIS,
  PDF_TEARDOWN_MILLIS,
  reconstructLayout,
  PdfTooLargeError,
  PdfTookTooLongError,
  pdfWorkDeadline,
  readAllWithinReportedSize,
  readPageTextItems,
  readPdfFileWithinBounds,
  withPdfDocument,
} from '../src/pdf_extract.js'
import { extractEmbeddableDocumentText, isDocumentRefusal } from '../src/doc_embed_extract.js'
import { runPdfExtractText, runPdfLocate, runPdfMeta, runPdfOutline } from '../src/read_commands.js'
import { ZipInputTooLargeError, ZipOutputTooLargeError } from '../src/zip_bounds.js'
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
    // A refusal is a verdict on these bytes and repeats forever, so the indexer records it and stops. A failure is a fact about this moment, and recording it would retire the document permanently over a condition that has already passed.
    expect(isDocumentRefusal(new PdfTooLargeError('past the budget'))).toBe(true)
    expect(isDocumentRefusal(new PdfTookTooLongError('past the clock'))).toBe(true)
    expect(isDocumentRefusal(new Error('EBUSY: resource busy or locked'))).toBe(false)
    expect(isDocumentRefusal(new TypeError('pdfjs is not a function'))).toBe(false)
  })

  it('says the same of the other three formats it routes, whose bounds are enforced elsewhere', () => {
    // The predicate was written when PDFs were the only bounded format and kept checking only for theirs after the dispatcher grew three more. A zip bomb in a .docx is exactly as settled a verdict as one in a .pdf, and it was being re-decompressed on every index pass instead.
    expect(isDocumentRefusal(new ZipInputTooLargeError('big.docx', 999, 100))).toBe(true)
    expect(isDocumentRefusal(new ZipOutputTooLargeError('word/document.xml', 100, 999))).toBe(true)
    // Every extension the dispatcher routes must reach a bound whose refusal is classified here.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'doc_embed_extract.ts'), 'utf8')
    const routed = [...src.matchAll(/case '(\.[a-z]+)':/g)].map((m) => m[1])
    expect(routed, 'the dispatcher must still route the formats this guard names').toEqual(expect.arrayContaining(['.pdf', '.docx', '.pptx', '.xlsx']))
    for (const ext of routed) {
      const refusal = REFUSAL_PER_FORMAT[ext as string]
      expect(refusal, `${ext} is routed, so name the refusal its bound raises`).toBeDefined()
      expect(isDocumentRefusal(refusal), `${ext}'s bound must read as settled, not as a bad moment`).toBe(true)
    }
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


/** One refusal per format the embedding dispatcher routes. Provenance: HAND-DERIVED. Each is the error that format's own size bound constructs, built here from its constructor signature rather than captured from a run, since what is under test is how the indexer classifies the type and not what the message says. */
const REFUSAL_PER_FORMAT: Record<string, Error> = {
  '.pdf': new PdfTooLargeError('past the text budget'),
  '.docx': new ZipOutputTooLargeError('word/document.xml', 100, 999),
  '.pptx': new ZipOutputTooLargeError('ppt/presentation.xml', 100, 999),
  '.xlsx': new ZipInputTooLargeError('book.xlsx', 999, 100),
}

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

/** A page that costs without producing: its reader is pulled and never answers. This is what a content stream of pure graphics operators looks like from here -- pdfjs parses every one of them and hands back no text item, so a bound that counts what arrives counts zero and a check written in the consumer's loop body never runs. */
function silentPage(): pdfjsTypes.PDFPageProxy {
  return {
    streamTextContent: (): ReadableStream<FakeChunk> => new ReadableStream<FakeChunk>({ pull: () => new Promise<void>(() => undefined) }),
  } as unknown as pdfjsTypes.PDFPageProxy
}

/** A page from a pdfjs build with no streaming reader, which hands over the whole page at once. */
function wholePage(items: FakeItem[]): pdfjsTypes.PDFPageProxy {
  return { getTextContent: async (): Promise<{ items: FakeItem[] }> => ({ items }) } as unknown as pdfjsTypes.PDFPageProxy
}

/** The source of one declaration in `src/pdf_extract.ts`, up to the doc comment of the next one. */
function bodyOf(src: string, name: string): string {
  // `<T>` after the name for the generic ones, so match up to the parameter list rather than to a literal open paren -- otherwise a declaration silently reads as missing and the guard passes by scanning nothing.
  const start = src.search(new RegExp(`function\\*? ${name}(<[^>]*>)?\\(`))
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
    // Passing the budget frees the memory and nothing else: the refusal keeps reading, because cancelling throws from inside pdfjs and abandoning the reader deadlocks the teardown. So a producer that never ends outlives the byte budget entirely, and the deadline is the only thing that ever ends this call.
    let pulled = 0
    const page = streamingPage(() => {
      pulled++
      return { items: [{ str: 'A'.repeat(2000) }] }
    })
    await expect(readPageTextItems(page, 1000, Date.now() + 200)).rejects.toThrow(PdfTookTooLongError)
    expect(pulled).toBeGreaterThan(1)
  })

  it('stops a page that costs without producing, which no loop body ever sees', async () => {
    // The clock was read inside `for await (const chunk of ...)`, so a page yielding no chunk never reached it: bytes saw nothing, items saw nothing, and the parse ran as long as it liked. The wait is the only thing that observes work of that shape, so the wait is what carries the bound.
    const started = Date.now()
    await expect(readPageTextItems(silentPage(), MAX_PDF_TEXT_BYTES, Date.now() + 200)).rejects.toThrow(PdfTookTooLongError)
    expect(Date.now() - started, 'the refusal must arrive on the clock, not on the producer').toBeLessThan(5_000)
  })

  it('stops the same page on a build with no streaming reader', async () => {
    const page = { getTextContent: (): Promise<never> => new Promise<never>(() => undefined) } as unknown as pdfjsTypes.PDFPageProxy
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() + 200)).rejects.toThrow(PdfTookTooLongError)
  })

  it('refuses a real document of this shape on the clock, through the shipping path', async () => {
    // The end-to-end shape, against pdfjs rather than a fake: a file of pure graphics operators, which the unit tests above model but none of them actually parses. Before the clock moved onto the awaits, the same document ran 92 seconds through the installed binary under a bound advertised as 60. This pays a real minute to prove the minute is what it costs. It does NOT cover the teardown bound -- the refusal here lands between pages, with nothing outstanding for destroy() to settle, and it passes with that bound removed; the fake loading task at the end of this file is what covers it. A thousand pages of the one shared stream: about ninety bytes of fixture each, and several times more parse work than the budget allows, so the refusal comes from the clock on any machine rather than from this input happening to outrun a particular one. At two hundred pages the margin was under twice the budget and a quiet runner finished the document.
    const silent = new Uint8Array(pdfBomb({ ops: 0, charsPerOp: 1, pages: 1_000, graphicsOps: 300_000 }))
    const started = Date.now()
    await expect(extractPdfText(silent, undefined)).rejects.toThrow(PdfTookTooLongError)
    expect(Date.now() - started, 'the refusal must arrive on the clock plus teardown, not later').toBeLessThan(MAX_PDF_WORK_MILLIS + PDF_TEARDOWN_MILLIS + 20_000)
  }, 180_000)

  it('names the limit it enforced and the flag that avoids it', async () => {
    const page = streamingPage(() => ({ items: [{ str: 'A' }] }))
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() - 1)).rejects.toThrow(String(MAX_PDF_WORK_MILLIS))
    await expect(readPageTextItems(page, MAX_PDF_TEXT_BYTES, Date.now() - 1)).rejects.toThrow(/--pages/)
  })

  it('is opened once by the document wrapper and taken by every entry point, so no command can be written without one', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'pdf_extract.ts'), 'utf8')
    // A clock each caller opens for itself is a clock a new caller forgets: pdf-outline and pageHasText both shipped without one. withPdfDocument owns it now, and every entry point takes it from there, so forgetting it is a type error rather than a silent omission.
    const wrapper = bodyOf(src, 'withPdfDocument')
    expect(wrapper, 'withPdfDocument must open the one deadline per document').toContain('pdfWorkDeadline()')
    expect(wrapper, 'loading is work too, so the load itself must race the deadline').toContain('raceDeadline(loadingTask.promise, deadline)')
    for (const fn of ['extractPdfText', 'locatePdfPages', 'extractPdfMeta', 'extractPdfOutline']) {
      expect(bodyOf(src, fn), `${fn} reads a document, so it must take the deadline withPdfDocument opened`).toContain('async (doc, deadline)')
    }
    expect(bodyOf(src, 'pdfWorkDeadline'), 'pdfWorkDeadline must still be the only place the clock starts').toContain('MAX_PDF_WORK_MILLIS')
    // Nothing outside the wrapper may start its own clock: a second one would drift past the first.
    expect(src.split('= pdfWorkDeadline()').length - 1, 'pdfWorkDeadline() must be called in exactly one place').toBe(1)
    for (const fn of ['readPageTextItems', 'pageHasText', 'reconstructLayout']) {
      const body = bodyOf(src, fn)
      expect(body, `${fn} works through a page's items, so it must be handed a deadline`).toContain('deadline: number')
      // Taking the parameter is not checking it. pageHasText holds one boolean, so no byte budget would ever stop it -- the clock is the only bound on the drain, and it only counts if the loop reads it. pageHasText is not exported, so this is checked in the source.
      expect(body, `${fn} must check the deadline inside the loop that drains the page`).toContain('Date.now() > deadline')
    }
    // A loop body is only reached by a chunk that arrives. The awaits are what a page yielding nothing spends, so they are what the clock has to sit on.
    const stream = bodyOf(src, 'pageTextItems')
    expect(stream, 'the text stream must be handed the deadline').toContain('deadline: number')
    expect(stream.split('await raceDeadline(').length - 1, 'both the streaming read and the whole-page fallback must race the deadline').toBe(2)
    // Walking to a further page is work too, and no command here walks pages any other way.
    expect(src.split('doc.getPage(').length - 1, 'every page fetch must go through getPageWithinDeadline').toBe(1)
    expect(bodyOf(src, 'getPageWithinDeadline'), 'the page fetch must refuse on a clock that has already run out').toContain('Date.now() > deadline')
  })
})

describe('the bounds that a character count alone does not cover', () => {
  it('refuses more items than any document has, even carrying almost no text', async () => {
    const chunk: FakeChunk = { items: Array.from({ length: 1000 }, () => ({ str: 'x' })) }
    let sent = 0
    const page = streamingPage(() => (sent++ <= MAX_PDF_TEXT_ITEMS / 1000 ? chunk : null))
    await expect(readPageTextItems(page, Number.MAX_SAFE_INTEGER, pdfWorkDeadline())).rejects.toThrow(PdfTooLargeError)
  })

  it('names the bound that actually refused, since the two have different answers', async () => {
    // A dense page was refused with the byte budget's message and its advice to narrow the read. The bytes were nowhere near spent -- it was the item count -- and --pages does not help with either one when a single page is what is over.
    const chunk: FakeChunk = { items: Array.from({ length: 1000 }, () => ({ str: 'x' })) }
    let sent = 0
    const dense = streamingPage(() => (sent++ <= MAX_PDF_TEXT_ITEMS / 1000 ? chunk : null))
    await expect(readPageTextItems(dense, Number.MAX_SAFE_INTEGER, pdfWorkDeadline())).rejects.toThrow(String(MAX_PDF_TEXT_ITEMS))
    let words = 0
    const wordy = streamingPage(() => (words++ < 1 ? { items: [{ str: 'A'.repeat(10_000) }] } : null))
    await expect(readPageTextItems(wordy, 5_000, pdfWorkDeadline())).rejects.toThrow(String(MAX_PDF_TEXT_BYTES))
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
  // HAND-DERIVED: 'e' with an acute accent is one UTF-16 code unit and two UTF-8 bytes, so a string one code unit under the limit encodes to nearly twice it. Computed from the encoding, not read off this module's output.
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
    // The whole page arrives as a single chunk here, and appending it with `push(...chunk)` throws RangeError past V8's argument limit -- an obscure crash in place of either the text or the refusal. Measured: 125,000 arguments already throws on the Node this suite runs on.
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
    // HAND-DERIVED: a handle reporting 1,024 bytes that keeps delivering, which is what a file being appended to during the read looks like from the reader's side.
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

  it('does not keep the whole reported size alive for a file that shrank to nothing', async () => {
    // The buffer is sized from the stat; the file can be truncated between the stat and the read. A view over the original allocation has the right LENGTH and the wrong footprint, and it is then handed to pdfjs, which holds it for the life of the document.
    const reported = 8 * 1024 * 1024
    let delivered = false
    const shrunk = {
      read: async (buffer: Buffer, offset: number): Promise<{ bytesRead: number }> => {
        if (delivered) return { bytesRead: 0 }
        delivered = true
        buffer[offset] = 0x25
        return { bytesRead: 1 }
      },
    }
    const out = await readAllWithinReportedSize(shrunk, reported, 'shrunk.pdf')
    expect(out).toHaveLength(1)
    expect(out.buffer.byteLength, 'the one byte that arrived must not be backed by the size that was promised').toBe(1)
  })

  it('reads a real file through the one descriptor it measured', async () => {
    const file = path.join(dir, 'descriptor.pdf')
    fs.writeFileSync(file, ORDINARY)
    expect(Buffer.from(await readPdfFileWithinBounds(file))).toEqual(Buffer.from(ORDINARY))
  })
})

/** The bounds that apply after the drain has finished, and the ones that apply to a command that never drains a page at all. Every bound above watches the stream. Work done on what the stream already delivered, and work done on parts of a document that are not page text, were both outside all of them -- which is how a page that passes every one of the four could still hold the process for over a minute. */
describe('the work that happens once the page has already been read', () => {
  // HAND-DERIVED: one item per row, each 3 units below the last, so no two ever group together and the row list grows with the item count. Nothing here is read off the implementation; the shape is chosen from what the grouping rule says makes a new row.
  const oneItemPerRow = (n: number): { str: string; transform: number[]; width: number }[] =>
    Array.from({ length: n }, (_, i) => ({ str: 'x', transform: [1, 0, 0, 1, 0, i * 3], width: 1 }))

  it('groups a page of MAX_PDF_TEXT_ITEMS rows in seconds, not the minutes a per-item rescan costs', () => {
    // Scanning every prior row per item is quadratic: measured 1.8 s at 32,000 items and rising as the square, so ~70 s at the cap -- spent after the deadline-checked drain has already returned. The ceiling here is ~60x the measured post-fix cost and ~1/20th of the pre-fix one, so it separates the two on any machine rather than pinning a speed.
    const started = Date.now()
    const out = reconstructLayout(oneItemPerRow(MAX_PDF_TEXT_ITEMS), Date.now() + 600_000)
    expect(out.split('\n')).toHaveLength(MAX_PDF_TEXT_ITEMS)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 120_000)

  it('still stops on the clock, whatever the grouping costs', () => {
    expect(() => reconstructLayout(oneItemPerRow(5_000), Date.now() - 1)).toThrow(PdfTookTooLongError)
  })

  it('reads the same rows out of a page it always did', () => {
    // Calibration: the fast path has to agree with the rule, not merely be fast. Two items on one row (y within the epsilon) and one on another, with the lower row printed last.
    const items = [
      { str: 'a', transform: [1, 0, 0, 1, 0, 100], width: 5 },
      { str: 'b', transform: [1, 0, 0, 1, 6, 100.5], width: 5 },
      { str: 'c', transform: [1, 0, 0, 1, 0, 50], width: 5 },
    ]
    expect(reconstructLayout(items, Date.now() + 10_000)).toBe('ab\nc')
  })

  it('follows a baseline that drifts across a bucket edge, which is the case the buckets can lose', () => {
    // Every gap here is under the epsilon, so all four belong to one row, but the run crosses two bucket boundaries. A row is found by its LAST item, so its bucket has to move with that item; an index that files a row once, where it started, stops finding it and splits the line. The three-item case above cannot see this -- 100 and 100.5 share a bucket, so nothing ever moves.
    const drift = [0, 1.5, 3, 4.5].map((y, i) => ({ str: 'abcd'[i] as string, transform: [1, 0, 0, 1, i * 6, y], width: 5 }))
    expect(reconstructLayout(drift, Date.now() + 10_000)).toBe('abcd')
  })

  // HAND-DERIVED from the grouping rule, not from any output of it. Fifty rows drifting upward together, each item 1.9 units above the last -- under the 2-unit epsilon, so every row stays one row -- and the rows 4.2 units apart, so the nearest item of any other row is never closer than 2.3 units and no two rows merge. Every row crosses a bucket edge on nineteen items in twenty, so a row is found through an index entry it has moved past unless the index moves with it. The one-item-per-row page above cannot see this at all, because a row that never moves is never re-filed.
  const driftingRows = (rows: number, perRow: number): { str: string; transform: number[]; width: number }[] => {
    const items: { str: string; transform: number[]; width: number }[] = []
    for (let step = 0; step < perRow; step++) {
      for (let row = 0; row < rows; row++) items.push({ str: 'x', transform: [1, 0, 0, 1, step, row * 4.2 + step * 1.9], width: 1 })
    }
    return items
  }

  it('holds fifty drifting baselines apart over a full page of items', () => {
    // The four-item case above proves a row can cross one bucket edge. This is the same rule under sustained drift at the item cap: 200,000 items, every row migrating almost every time, rows close enough that a lost or misfiled entry merges two of them or splits one rather than quietly costing time. Vacating the bucket a row has left is a separate matter and deliberately not asserted here -- it changes no output, because the epsilon is re-checked against the row's current last item whichever list the candidate came from, and its cost is bounded by MAX_PDF_TEXT_ITEMS at 74 ms against 121 ms measured. A stopwatch pinning a ratio that small would fail on a loaded runner more often than on a real regression.
    const out = reconstructLayout(driftingRows(50, 4_000), Date.now() + 600_000).split('\n')
    expect(out, 'the drift must still read as one row per baseline').toHaveLength(50)
    expect(new Set(out).size, 'every row must have collected all four thousand of its own items').toBe(1)
    expect(out[0]).toBe('x'.repeat(4_000))
  }, 120_000)
})

/** The bound on the exit, which is the one a passing refusal hides. Everything this module refuses, it refuses with pdfjs still holding a half-finished document, and `destroy()` has to settle that before it resolves. An open-ended await there converts a refusal that took a minute into a call that never returns -- and it returns nothing to log either, so in the indexer it reads as a slot that simply stopped. No PDF drives this reliably: the graphics-only document above refuses between pages, where there is nothing outstanding for teardown to settle, and it passes with the bound removed. The loading task is faked for that reason and only for that reason -- the module is a parameter of the function under test on the shipping path too, so nothing here is supplied that production omits. */
describe('the teardown that runs after the refusal', () => {
  type PdfjsModuleArg = Parameters<typeof withPdfDocument>[0]
  const neverSettles = <T,>(): Promise<T> => new Promise<T>(() => undefined)
  const taskWith = (destroy: () => Promise<void>, load: () => Promise<pdfjsTypes.PDFDocumentProxy>): PdfjsModuleArg =>
    ({ getDocument: () => ({ promise: load(), destroy }) }) as unknown as PdfjsModuleArg

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the refusal back rather than waiting on a destroy that never settles', async () => {
    const run = withPdfDocument(taskWith(neverSettles<void>, neverSettles<pdfjsTypes.PDFDocumentProxy>), new Uint8Array(), async () => 'unreachable')
    const outcome = run.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(MAX_PDF_WORK_MILLIS + PDF_TEARDOWN_MILLIS + 2)
    expect(await outcome, 'the clock refused the load, and teardown must not swallow that').toBeInstanceOf(PdfTookTooLongError)
  })

  it('does not spend the teardown budget when destroy settles, so the bound costs an ordinary read nothing', async () => {
    let destroyed = false
    const doc = { numPages: 1 } as unknown as pdfjsTypes.PDFDocumentProxy
    const module = taskWith(async () => {
      destroyed = true
    }, async () => doc)
    await expect(withPdfDocument(module, new Uint8Array(), async (loaded) => loaded.numPages)).resolves.toBe(1)
    expect(destroyed, 'the document is still destroyed on the ordinary path').toBe(true)
  })
})

/** HAND-DERIVED. Object/xref/trailer syntax and the `/Outlines`, `/First`, `/Last`, `/Next`, `/Prev`, `/Count` outline keys are per ISO 32000-1 7.5 and 12.3.3, written from the specification rather than read off `src/pdf_extract.ts`. A FLAT outline: `count` siblings all at level 0, each with a title of `titleChars` characters. The existing deep-chain fixture tests the depth cap; nothing tested breadth, and the depth cap never fires on a tree that is one level tall however wide it grows. */
function wideOutlinePdfBytes(count: number, titleChars: number): Uint8Array {
  const objs: string[] = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'
  const first = 5
  const last = first + count - 1
  objs[4] = `<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count ${count} >>`
  for (let i = 0; i < count; i++) {
    const objNum = first + i
    const parts = [`/Title (${'T'.repeat(titleChars)}${i})`, '/Parent 4 0 R']
    if (i > 0) parts.push(`/Prev ${objNum - 1} 0 R`)
    if (i < count - 1) parts.push(`/Next ${objNum + 1} 0 R`)
    objs[objNum] = `<< ${parts.join(' ')} >>`
  }
  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(body, 'latin1')
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefStart = Buffer.byteLength(body, 'latin1')
  const total = objs.length
  body += `xref\n0 ${total}\n0000000000 65535 f \n`
  for (let i = 1; i < total; i++) body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}

describe('a bookmark tree that is wide rather than deep', () => {
  it('stops at MAX_OUTLINE_ENTRIES, which the depth cap never sees', async () => {
    const entries = await extractPdfOutline(wideOutlinePdfBytes(MAX_OUTLINE_ENTRIES + 200, 4))
    expect(entries).toHaveLength(MAX_OUTLINE_ENTRIES)
  }, 180_000)

  it('shortens a title long enough to be an attack on its own', async () => {
    const entries = await extractPdfOutline(wideOutlinePdfBytes(2, MAX_OUTLINE_TITLE_CHARS * 4))
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.title.length).toBeLessThanOrEqual(MAX_OUTLINE_TITLE_CHARS + 3)
    }
    expect(entries[0]?.title.endsWith('...')).toBe(true)
  })

  it('still returns an ordinary outline untouched', async () => {
    const entries = await extractPdfOutline(wideOutlinePdfBytes(3, 6))
    expect(entries.map((e) => e.title)).toEqual(['TTTTTT0', 'TTTTTT1', 'TTTTTT2'])
  })
})

describe('the bounds on the answers a command may return', () => {
  // --max-matches and --context are command-line integers, and the per-page budget bounds ONE page's text rather than the product of the two. Every per-page check passes while the retained answer grows without limit.
  const MANY_PAGES = MAX_LOCATE_MATCHES + 50
  // 1,000 operators of 70 characters: ~71 KB of text per page, far past MAX_LOCATE_CONTEXT_CHARS and far under the page budget, so an uncapped --context returns the whole page and a capped one cannot. Rebuilt per call: pdfjs TRANSFERS the backing ArrayBuffer into its worker port, so a second getDocument over the same view fails with DataCloneError on a detached buffer.
  const WIDE = pdfBomb({ ops: 300, charsPerOp: 70, pages: MANY_PAGES })
  const wide = (): Uint8Array => new Uint8Array(WIDE)

  it('has a fixture that really is wider than both caps, or neither assertion below means anything', async () => {
    const { pageCount, text } = await extractPdfText(wide(), '1')
    expect(pageCount).toBe(MANY_PAGES)
    expect(text.length).toBeGreaterThan(MAX_LOCATE_CONTEXT_CHARS * 4)
  }, 120_000)

  it('caps how many matches and how much context pdf-locate will hold, whatever the flags ask for', async () => {
    const result = await locatePdfPages(wide(), 'AAAA', { maxMatches: 10_000_000, context: 10_000_000 })
    expect(result.matches).toHaveLength(MAX_LOCATE_MATCHES)
    // locateSnippet centres the window, so the widest honest snippet is about twice the setting.
    for (const match of result.matches) {
      expect(match.snippet.length).toBeLessThanOrEqual(MAX_LOCATE_CONTEXT_CHARS + 8)
    }
  }, 180_000)

  it('sizes the snippet by the setting and not by how much the pattern chose to match', async () => {
    // --context caps what is added AROUND the match; the match itself was copied whole. A greedy pattern is one match covering the entire page, so the flag said 80 characters and the answer held a page each -- with a thousand of them retained, that is the byte budget times a thousand, past every per-page bound that had just passed.
    const result = await locatePdfPages(wide(), '[\\s\\S]+', { context: 80, maxMatches: 5 })
    expect(result.matches.length, 'a greedy pattern must still find its pages').toBeGreaterThan(0)
    for (const match of result.matches) {
      expect(match.snippet.length).toBeLessThanOrEqual(80 + 8)
    }
  }, 180_000)

  it('still answers an ordinary locate at the size it was asked for', async () => {
    const result = await locatePdfPages(new Uint8Array(ORDINARY), 'AAAA', { context: 20 })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.snippet.length).toBeLessThan(60)
  })
})
