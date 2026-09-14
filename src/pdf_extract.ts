/** PDF -> plain text extraction for `token-goat pdf-extract`, so a PDF's useful content reaches the model as text instead of forcing a full binary `Read` (which token-goat can't index or shrink). Uses `pdfjs-dist`'s legacy Node build directly (zero runtime dependencies, no native canvas binding) rather than the `pdf-parse` wrapper, whose v2 line pulls in `@napi-rs/canvas` purely for a rendering feature this project never needs. */

import * as fs from 'node:fs'

import type * as pdfjsTypes from 'pdfjs-dist/legacy/build/pdf.mjs'

import { DocumentRefusedError, MAX_DOCUMENT_WORK_MILLIS } from './document_refusal.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { compileGuardedRegex } from './regex_guard.js'

export interface PdfExtractResult {
  text: string
  pageCount: number
  pagesExtracted: number
}

type PdfjsModule = typeof pdfjsTypes

const loadPdfjs = createLazyModuleLoader(async () => {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // esbuild bundles this module's code directly into dist/token-goat.mjs, so pdfjs's default relative-path guess for its worker script (next to its own file on disk) resolves to a path inside dist/ that doesn't exist. Point it at the real file in node_modules instead of letting it guess. import.meta.resolve is unavailable under Vite/vitest's SSR transform in tests, so skip it there -- Node resolves the unbundled module's own relative worker path fine outside the built bundle.
  if (typeof import.meta.resolve === 'function') {
    try {
      mod.GlobalWorkerOptions.workerSrc = await import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    } catch {
      // best-effort; extraction still works via pdfjs's own fallback resolution
    }
  }
  return mod
}, 'pdf-extract disabled (pdfjs-dist unavailable)')

/** The most text one page-by-page read may produce, and the largest PDF that may be opened at all. A PDF content stream is Flate-compressed, so its expansion ratio is whatever its author chose. A one-page file of 200 KB decompresses to tens of millions of text-showing operators, and the same trick at 2 MB reaches gigabytes. The OOXML side of this codebase has bounded exactly this since `zip_bounds.ts`; the PDF side had nothing, and the result was not a slow read but a dead process: the heap is exhausted, the CLI aborts, and the background indexer -- which runs the same extractor over a document and discards its output -- crash-loops on a file small enough to sit under its own skip threshold. The file arrives in a repository the user has just cloned, and reading it is something the model does unprompted. The output budget is the one that holds. 8 MB of text is past any document this tool is useful on -- a 500-page book is about 1.5 MB, and 8 MB is already more tokens than any model's context accepts -- while staying far below what it takes to hurt the process. The input cap is a second fence for the shapes that cost before a page is ever read. */
export const MAX_PDF_TEXT_BYTES = 8 * 1024 * 1024
/** @see MAX_PDF_TEXT_BYTES */
export const MAX_PDF_INPUT_BYTES = 50 * 1024 * 1024

/** The most text items one page may retain, whatever they weigh in characters. Characters are not the only thing a page can spend. Every item is an object -- a string, a direction, a width, a height, a six-number transform, a font name -- so a page of a million one-character items sits comfortably inside an 8 MB character budget while costing hundreds of megabytes to hold. The two bounds measure different things and a document has to pass both. A dense real page runs to a few thousand items; a hundred times that is not a document. */
export const MAX_PDF_TEXT_ITEMS = 200_000

/** The most bookmark entries `pdf-outline` may return, and the most characters one entry's title may carry into that answer. {@link MAX_OUTLINE_DEPTH} caps how DEEP the walk goes, which is a different question from how WIDE it goes: a tree one level deep with a million siblings passes the depth cap untouched, and every one of those titles is attacker-chosen text of any length. The walk also resolves a destination per entry, so breadth costs page lookups and not just memory. */
export const MAX_OUTLINE_ENTRIES = 20_000
/** @see MAX_OUTLINE_ENTRIES */
export const MAX_OUTLINE_TITLE_CHARS = 500

/** The most `pdf-locate` matches that may be retained, and the widest snippet each may be. `--max-matches` and `--context` come off the command line, and the per-page text budget bounds one snippet at 8 MB, not their product. Without a ceiling on both, `--max-matches 100000 --context 99999999` retains every matching page in full while every per-page bound still passes. */
export const MAX_LOCATE_MATCHES = 1_000
/** @see MAX_LOCATE_MATCHES */
export const MAX_LOCATE_CONTEXT_CHARS = 4_000

/** How long one document's text may take to read, whatever it costs in memory. A byte budget bounds what is retained, not what is done. This extractor cannot stop pdfjs mid-page -- cancelling the stream throws from inside its message handler, and abandoning the reader can leave the teardown unable to settle (see readPageTextItems) -- so refusing at 8 MB frees the memory and leaves the producer inflating. Under the 50 MB input cap and the expansion ratio the fixture measures, that is hours of arithmetic for a file the indexer opened without being asked. The clock is the only bound that covers it. A minute is far past any honest read (a 500-page book is a few seconds) and short enough that a crafted file costs a stall rather than a wedged worker. */
export const MAX_PDF_WORK_MILLIS = MAX_DOCUMENT_WORK_MILLIS

/** Refusals from this module: the text budget, the input cap, and the clock. */
export class PdfRefusedError extends DocumentRefusedError {}

/** Thrown when a PDF's text passes {@link MAX_PDF_TEXT_BYTES}, or the file itself passes {@link MAX_PDF_INPUT_BYTES}. */
export class PdfTooLargeError extends PdfRefusedError {
  constructor(message: string) {
    super(message, 'PdfTooLargeError')
  }
}

/** Thrown when reading one document's text passes {@link MAX_PDF_WORK_MILLIS}. Transient, unlike its siblings here: the clock measures this machine under this load, not the bytes, so the indexer must not record it as a settled verdict. */
export class PdfTookTooLongError extends PdfRefusedError {
  constructor(message: string) {
    super(message, 'PdfTookTooLongError', true)
  }
}

/** The instant past which this document's text work must stop. One per document, not per page. */
export function pdfWorkDeadline(): number {
  return Date.now() + MAX_PDF_WORK_MILLIS
}

function pdfWorkTookTooLong(): PdfTookTooLongError {
  return new PdfTookTooLongError(`reading this PDF's text passed the ${MAX_PDF_WORK_MILLIS}ms limit. Narrow the read with --pages, or use a smaller document.`)
}

/** Refuse a PDF before any of it is parsed: one that is too large, and one whose size is not a number worth believing. The size check is only as good as its oracle. `stat` reports 0 for a character device, a FIFO, and most synthetic files, and 0 passes any ceiling -- so a repository holding `report.pdf` as a link to an endless device would take the cap's own blessing into an unbounded read. Nothing except a regular file has a length this bound can be stated against, so nothing else is read. */
export function assertPdfIsARegularFileWithinBounds(stat: { isFile(): boolean; size: number }, file: string): void {
  if (!stat.isFile()) {
    throw new PdfTooLargeError(`${file} is not a regular file, so its size cannot be checked before reading it.`)
  }
  if (stat.size > MAX_PDF_INPUT_BYTES) {
    throw new PdfTooLargeError(`${file} is ${stat.size} bytes, past the ${MAX_PDF_INPUT_BYTES}-byte limit for a PDF. Split it, or extract from a smaller copy.`)
  }
}

function pdfTextBudgetExceeded(): PdfTooLargeError {
  return new PdfTooLargeError(`this PDF's text passes the ${MAX_PDF_TEXT_BYTES}-byte extraction limit. Narrow the read with --pages, or use a smaller document.`)
}

/** Says which of the two per-page bounds actually fired, since --pages does not help with either one on a single page and naming the wrong one sends the reader after the wrong fix. */
function pdfPageTooDenseToRead(): PdfTooLargeError {
  return new PdfTooLargeError(`a page of this PDF holds more than ${MAX_PDF_TEXT_ITEMS} separate pieces of text, past what extraction will hold whatever they weigh. Use a smaller document.`)
}

/** Refuse a finished document whose text passes {@link MAX_PDF_TEXT_BYTES} once encoded. The per-page budget counts UTF-16 code units, because that is what the strings cost while they are being held. What leaves this module is UTF-8, and the two differ by up to threefold: eight million accented characters clear a code-unit budget of eight million and encode to sixteen megabytes. The limit is stated in bytes, so it is checked in bytes, on the one value that is actually measured in them. */
export function assertPdfTextWithinBounds(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_PDF_TEXT_BYTES) throw pdfTextBudgetExceeded()
}

/** Read a PDF's bytes under {@link MAX_PDF_INPUT_BYTES}, from the same file the size was measured on. Statting a path and then reading it are two lookups of one name, and a working tree is not quiet between them: the file can grow, or the name can be swapped for a link to something endless, and the second lookup then gets a file the cap never blessed. So the descriptor is opened once and everything -- the regular-file test, the size, the bytes -- is taken off it. */
export async function readPdfFileWithinBounds(file: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    assertPdfIsARegularFileWithinBounds(stat, file)
    return await readAllWithinReportedSize(handle, stat.size, file)
  } finally {
    await handle.close()
  }
}

/** The part of {@link readPdfFileWithinBounds} a test can hand a descriptor that lies about its size. */
export interface PdfReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
}

/**
 * Every byte a descriptor delivers, refusing one that delivers more than it said it would. The buffer is one byte longer than the reported size, so a file that outgrows its own stat mid-read fills it and is refused rather than silently truncated to whatever the cap blessed.
 * @see readPdfFileWithinBounds
 */
export async function readAllWithinReportedSize(handle: PdfReadHandle, reportedSize: number, file: string): Promise<Uint8Array> {
  const buffer = Buffer.alloc(reportedSize + 1)
  let read = 0
  for (;;) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
    if (bytesRead === 0) break
    read += bytesRead
    if (read === buffer.length) {
      throw new PdfTooLargeError(`${file} grew past the ${reportedSize} bytes it reported while it was being read. Extract from a copy that is not being written to.`)
    }
  }
  // A view over the original allocation keeps all of it alive, and the allocation was sized from the stat, not from what arrived. A file statted at 50 MB and then truncated to one byte would hand pdfjs a one-byte document backed by 50 MB that nothing can release until the document is. Copy out whenever the two disagree; the common case, where they agree, still copies nothing.
  return read === reportedSize
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, read)
    : new Uint8Array(buffer.subarray(0, read))
}

/** One page's text items in arrival order, read through pdfjs's STREAM rather than its whole-page accessor. `getTextContent()` materializes the entire item array before it returns, so a page carrying tens of millions of text-showing operators exhausts the heap inside pdfjs, where no budget of ours can see it. The stream hands the same items over in chunks, so a consumer can decide per chunk whether to keep them -- which is what makes a bound possible at all. Falls back to the whole-page accessor only when a pdfjs build lacks the stream method, in which case that build's own heap use is once again unbounded and only the input cap applies. The clock is spent on the AWAIT and not on the chunk that comes back, because a page can cost without producing: a content stream of pure graphics operators is parsed in full and yields no text item at all, so a consumer checking its own loop body never runs. Bytes and items both measure what arrives, which on such a page is nothing; only the wait sees the work. */
async function* pageTextItems(page: pdfjsTypes.PDFPageProxy, deadline: number): AsyncGenerator<LayoutTextItem[]> {
  const keep = (items: readonly unknown[]): LayoutTextItem[] => items.filter((item) => item !== null && typeof item === 'object' && 'str' in item) as LayoutTextItem[]
  if (typeof page.streamTextContent !== 'function') {
    const content = await raceDeadline(page.getTextContent(), deadline)
    yield keep(content.items)
    return
  }
  const reader = (page.streamTextContent() as ReadableStream<{ items?: readonly unknown[] }>).getReader()
  for (;;) {
    const { done, value } = await raceDeadline(reader.read(), deadline)
    if (done) return
    yield keep(value?.items ?? [])
  }
}

/** `doc`'s page `pageNum`, refusing if the document's clock has already run out. Every command here walks pages in a loop of its own, and the cost of one page is not bounded by the cost of the last: a scan that has already spent its minute must not fetch a further page. Going through one function is what keeps that true of a command written later. */
async function getPageWithinDeadline(doc: pdfjsTypes.PDFDocumentProxy, pageNum: number, deadline: number): Promise<pdfjsTypes.PDFPageProxy> {
  if (Date.now() > deadline) throw pdfWorkTookTooLong()
  return raceDeadline(doc.getPage(pageNum), deadline)
}

/**
 * One page's text items, refusing once they pass `budget` characters or {@link MAX_PDF_TEXT_ITEMS} items. `budget` is spent in UTF-16 code units plus one per item for the separator the caller will join with, which is what the retained strings actually weigh in this process. It is not a count of the UTF-8 bytes those strings encode to -- a page of accented or CJK text encodes to two or three times its code units -- so it bounds the memory here and not the size of the finished document. {@link assertPdfTextWithinBounds} is what bounds that, once there is a document to measure. The refusal drops what it has and keeps draining rather than breaking out, because breaking out is not free here: a `cancel()` closes the web-stream controller while pdfjs still believes its own is open -- pdfjs marks that only on its CLOSE message -- so a chunk already in flight calls `enqueue` on a closed controller and throws from inside pdfjs's message handler, as an uncaught exception rather than a rejection of anything a caller awaits. Abandoning the reader without cancelling can instead leave `loadingTask.destroy()` waiting on a read that will never arrive, which is why teardown is raced rather than awaited -- a refused document must not be able to convert its refusal into a hang, whether or not any particular file manages to. Draining costs parse time, which the input cap already bounds; what it does not cost is the heap, which is the whole point -- nothing past the budget is ever retained. Draining is what makes the clock load-bearing rather than belt-and-braces: it is the only thing that stops the drain itself. Exported for the test that proves the deadline fires, which needs a producer that never ends and so cannot go through a real document.
 * @see MAX_PDF_TEXT_BYTES
 * @see MAX_PDF_WORK_MILLIS
 */
export async function readPageTextItems(page: pdfjsTypes.PDFPageProxy, budget: number, deadline: number): Promise<LayoutTextItem[]> {
  let items: LayoutTextItem[] = []
  let spent = 0
  let count = 0
  let over: 'items' | 'bytes' | null = null
  for await (const chunk of pageTextItems(page, deadline)) {
    if (Date.now() > deadline) throw pdfWorkTookTooLong()
    if (over) continue
    // One per item beyond its characters: the caller joins these with a separator, so an item that carries no text still costs a byte in the result, and a page of a million empty items would otherwise be free.
    for (const item of chunk) spent += item.str.length + 1
    count += chunk.length
    if (spent > budget || count > MAX_PDF_TEXT_ITEMS) {
      over = count > MAX_PDF_TEXT_ITEMS ? 'items' : 'bytes'
      items = []
      continue
    }
    // Appended one at a time: on the no-stream fallback below, `chunk` is a whole page's items, and spreading an array of a few hundred thousand into a call throws RangeError past V8's argument limit -- an obscure failure in place of the refusal this function exists to give.
    for (const item of chunk) items.push(item)
  }
  if (over) throw over === 'items' ? pdfPageTooDenseToRead() : pdfTextBudgetExceeded()
  return items
}

/** Parses a 1-indexed inclusive page spec like "1-5" or "3". Returns null (all pages) when unset. */
export function parsePageRange(spec: string | undefined, pageCount: number): { start: number; end: number } | null {
  if (!spec) return null
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) throw new Error(`invalid --pages spec: ${spec} (expected "N" or "N-M")`)
  const start = parseInt(m[1] as string, 10)
  const end = m[2] ? parseInt(m[2], 10) : start
  if (start < 1 || end < start) throw new Error(`invalid --pages spec: ${spec}`)
  if (start > pageCount) throw new Error(`invalid --pages spec: ${spec} (page ${start} is past end of document with ${pageCount} pages)`)
  return { start, end: Math.min(end, pageCount) }
}

/** Reconstructs rough reading order from pdfjs's per-item x/y coordinates instead of pdfjs's raw content-stream order (which interleaves columns/sidebars/footnotes on multi-column pages). Groups items into rows by y-proximity, sorts each row left-to-right, and widens the gap between items with a large x-jump (a likely column boundary). This is a heuristic, not a real layout engine -- it will misjudge rotated text, overlapping text boxes, and tables with irregular column widths. */
export interface LayoutTextItem {
  str: string
  transform: number[]
  width?: number
}

const Y_EPSILON = 2

export function reconstructLayout(items: LayoutTextItem[], deadline: number): string {
  const rows: LayoutTextItem[][] = []
  // Rows are indexed by the y of the item each one currently ends with. Scanning every prior row per item instead is quadratic, and MAX_PDF_TEXT_ITEMS alone permits 200,000 items on one page: measured 1.8 s at 32,000 items, growing as the square, so roughly 70 s at the cap -- all of it spent AFTER the deadline-checked drain has finished, where nothing was watching. A row within Y_EPSILON of y can only end in the bucket holding y or in one of its two neighbours, so three bucket lookups replace the scan, and taking the lowest row index among the candidates returns the same row the scan did. Bucket occupancy stays small because a new row is only created when no existing row was within Y_EPSILON, but it is not provably O(1) under a crafted drift pattern, so the clock is checked here too rather than trusted away.
  const bucketOf = (y: number): number => Math.floor(y / Y_EPSILON)
  const byBucket = new Map<number, number[]>()
  const bucketOfRow: number[] = []
  const place = (bucket: number, row: number): void => {
    const list = byBucket.get(bucket)
    if (list) list.push(row)
    else byBucket.set(bucket, [row])
    bucketOfRow[row] = bucket
  }
  let checked = 0
  for (const item of items) {
    if ((checked++ & 0x3ff) === 0 && Date.now() > deadline) throw pdfWorkTookTooLong()
    const y = item.transform[5] as number
    // A non-finite y never enters the index. The three-bucket lookup is O(1) only while `Math.abs(a - b) < Y_EPSILON` partitions, and for NaN or either infinity that comparison is always false -- `Infinity - Infinity` is NaN too -- so no row ever matches, every item lands in the one bucket `bucketOf` maps them all to, and the lookup walks every row created so far: exactly the quadratic scan the index was introduced to remove. Measured through the shipping path at 66 s for a 412 KB file of 60,000 items, which buys the whole per-document budget. A document reaches this: PDF real literals have no exponent syntax, so `1e310` lexes as `1` and an unknown operator, but a plain 311-digit integer in a `Tm` overflows to Infinity in `transform[5]`, and combining two of them yields NaN. Since nothing can ever be within Y_EPSILON of such an item, its own row is the answer the scan would have reached anyway, and skipping the index gets there in constant time.
    if (!Number.isFinite(y)) {
      rows.push([item])
      continue
    }
    const home = bucketOf(y)
    // Compare against the row's MOST RECENTLY added item, not its first -- a row is a proximity chain (each item within Y_EPSILON of the item right before it), not a fixed band around the first item's y. A smoothly y-drifting line (baseline jitter from a scanned/rotated PDF, or justified text) where each adjacent pair is within Y_EPSILON but the cumulative drift across the whole line exceeds it would otherwise get wrongly split into multiple rows once compared only against the first item.
    let found = -1
    // Iterated as an explicit triple rather than `for (let b = home - 1; b <= home + 1; b++)`. A document sets `transform[5]` through `Tm`, and pdfjs passes it through unclamped as long as the page's `/MediaBox` is tall enough to keep the glyph on it -- both under the file's control. Past 2^53 the increment is a no-op, since `home + 1 === home`, so the counting form never advanced and never exited: one text item at y = 2e16 in a 600-byte PDF held `pdf-extract --layout` forever. Nothing could interrupt it either, this loop being synchronous and the clock above sitting outside it. Naming the three buckets removes the counter the arithmetic broke, and terminates for +/-Infinity and NaN as well.
    for (const bucket of [home - 1, home, home + 1]) {
      for (const row of byBucket.get(bucket) ?? []) {
        const last = (rows[row] as LayoutTextItem[])[(rows[row] as LayoutTextItem[]).length - 1] as LayoutTextItem
        if (Math.abs((last.transform[5] as number) - y) < Y_EPSILON && (found === -1 || row < found)) found = row
      }
    }
    if (found === -1) {
      rows.push([item])
      place(home, rows.length - 1)
      continue
    }
    ;(rows[found] as LayoutTextItem[]).push(item)
    const was = bucketOfRow[found] as number
    if (was !== home) {
      const list = byBucket.get(was) as number[]
      const at = list.indexOf(found)
      if (at >= 0) list.splice(at, 1)
      place(home, found)
    }
  }
  // Top of the page first, with the non-finite rows admitted above kept together at the end in the order the document gave them. Subtracting straight through would return NaN for every comparison involving one, and a comparator that answers NaN leaves the whole ordering up to the sort implementation -- including the ordering of the ordinary rows beside it.
  rows.sort((a, b) => {
    const ya = (a[0] as LayoutTextItem).transform[5] as number
    const yb = (b[0] as LayoutTextItem).transform[5] as number
    const finiteA = Number.isFinite(ya)
    const finiteB = Number.isFinite(yb)
    if (finiteA && finiteB) return yb - ya
    if (finiteA) return -1
    if (finiteB) return 1
    return 0
  })

  const lines: string[] = []
  for (const row of rows) {
    row.sort((a, b) => (a.transform[4] as number) - (b.transform[4] as number))
    let line = ''
    let prevEndX: number | null = null
    for (const item of row) {
      const x = item.transform[4] as number
      if (prevEndX !== null) {
        const gap = x - prevEndX
        line += gap > 20 ? '   ' : gap > 4 ? ' ' : ''
      }
      line += item.str
      prevEndX = x + (item.width ?? 0)
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Loads `data` as a pdfjs document, runs `fn` against it, and always destroys the loading task afterward -- centralizes the getDocument options and try/finally teardown shared by extractPdfText/extractPdfOutline/extractPdfMeta. Takes the pdfjs module rather than reaching for it, which is also how the teardown bound below is tested: a real document that refuses on the clock does not reliably leave `destroy()` unable to settle, so the only honest way to show the bound holds is to hand this a loading task that never settles. */
export async function withPdfDocument<T>(pdfjs: PdfjsModule, data: Uint8Array, fn: (doc: pdfjsTypes.PDFDocumentProxy, deadline: number) => Promise<T>): Promise<T> {
  // The deadline is opened HERE rather than by each caller, for two reasons. One: loading is work too, and a caller that starts its clock after `loadingTask.promise` resolves has left the whole xref/catalog parse unbounded -- nothing downstream ever runs to notice. Two: every entry point that reads a document goes through this function, so a clock owned here cannot be the one a new command forgets, which is exactly how both pageHasText and pdf-outline shipped without one.
  const deadline = pdfWorkDeadline()
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, disableFontFace: true, verbosity: 0 })
  try {
    return await fn(await raceDeadline(loadingTask.promise, deadline), deadline)
  } finally {
    // Teardown gets its own small bound rather than an open-ended await. Everything this module refuses, it refuses with pdfjs still working, and destroy() has to settle whatever state that left behind -- an unresolved load, a half-drained page stream. Waiting forever for a tidy exit would hand back exactly the hang the refusal existed to prevent, and the process is about to drop the document either way.
    await raceDeadline(loadingTask.destroy(), Date.now() + PDF_TEARDOWN_MILLIS).catch(() => undefined)
  }
}

/** How long teardown of a refused document may take before it is left to the garbage collector. */
export const PDF_TEARDOWN_MILLIS = 5_000

/** `work`, or {@link PdfTookTooLongError} once `deadline` passes -- whichever comes first. Losing the race does not stop `work`: pdfjs cannot be interrupted, so the producer runs on until its own teardown collects it. What this buys is that the caller stops waiting, which is the part that matters when the alternative is a command that never returns. */
async function raceDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(pdfWorkTookTooLong()), Math.max(0, deadline - Date.now()))
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** ISO 32000-1 12.3.3 places no bound on how deeply an outline (bookmark) tree may nest, and pdfjs-dist marshals the whole tree it builds through an in-process structuredClone (its LoopbackPort simulates postMessage even though there is no real worker thread), so a crafted PDF with a few hundred KB of single-child bookmark chaining (measured: ~800 levels) blows the JS call stack during that clone. That RangeError surfaces as an unhandled promise rejection from deep inside pdfjs's own internals rather than as a rejection of the promise this module is awaiting, so it is not caught by an ordinary try/catch around the await; under plain Node's default `--unhandled-rejections=throw` it also re-emits as `uncaughtException` and crashes the process outright. Listening for both events for the duration of the call is the only way to intercept it and turn it into a normal rejection instead. */
function withCrashGuard<T>(fn: () => Promise<T>, wrapCrash: (err: unknown) => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.removeListener('uncaughtException', onCrash)
      process.removeListener('unhandledRejection', onCrash)
    }
    const onCrash = (err: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(wrapCrash(err))
    }
    process.on('uncaughtException', onCrash)
    process.on('unhandledRejection', onCrash)
    fn().then(
      (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** Depth cap for the outline walk below: a defensive backstop independent of the crash-guard above, so a future pdfjs-dist build that raises or removes its own stack limit still can't make this walk itself unbounded. */
const MAX_OUTLINE_DEPTH = 500

export async function extractPdfText(data: Uint8Array, pagesSpec?: string, layout = false): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  return withPdfDocument(pdfjs, data, async (doc, deadline) => {
    const range = parsePageRange(pagesSpec, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const pages: string[] = []
    let spent = 0
    for (let i = start; i <= end; i++) {
      const page = await getPageWithinDeadline(doc, i, deadline)
      const textItems = await readPageTextItems(page, MAX_PDF_TEXT_BYTES - spent, deadline)
      const pageText = layout ? reconstructLayout(textItems, deadline) : textItems.map((item) => item.str).join(' ')
      spent += pageText.length
      pages.push(pageText.trim())
    }

    const text = pages.join('\n\n')
    assertPdfTextWithinBounds(text)
    return { text, pageCount: doc.numPages, pagesExtracted: end - start + 1 }
  })
}

export interface PdfLocateMatch {
  page: number
  snippet: string
}

/** Cheap where-pass for `token-goat pdf-locate`: returns the pages whose text matches `pattern`, each with a short snippet, so a caller can then run pdf-extract on only those pages instead of pulling the whole document into the model's context. One snippet per matching page (centred on the first match on that page, whitespace collapsed) is enough to confirm the hit -- dumping the whole page would defeat the point of locating first. */
export interface PdfLocateResult {
  matches: PdfLocateMatch[]
  // True only when the scan stopped because maxMatches was reached while pages remained unscanned: a scan that covered every requested page and happened to find exactly maxMatches results is a complete answer, not a truncated one, and must report false here so a caller can print a plain total instead of a floor for that case.
  truncated: boolean
}

export async function locatePdfPages(
  data: Uint8Array,
  pattern: string,
  opts: { ignoreCase?: boolean; maxMatches?: number; context?: number; pages?: string },
): Promise<PdfLocateResult> {
  // Compile up front so an invalid pattern fails with a message naming it, rather than leaking a bare SyntaxError with no indication of which input caused it (or paying pdfjs's document load only to throw afterwards). Guarded rather than compiled: this then runs per page over text the caller does not control, and a backtracking pattern cannot be interrupted. See regex_guard.ts.
  const guarded = compileGuardedRegex(pattern, opts.ignoreCase === true ? 'i' : '')
  if (!guarded.ok) throw new Error(`invalid regex pattern: ${pattern} (${guarded.reason})`)
  const re = guarded.re

  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  const maxMatches = Math.min(opts.maxMatches ?? 50, MAX_LOCATE_MATCHES)
  const context = Math.min(opts.context ?? 80, MAX_LOCATE_CONTEXT_CHARS)

  return withPdfDocument(pdfjs, data, async (doc, deadline) => {
    const range = parsePageRange(opts.pages, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const matches: PdfLocateMatch[] = []
    // The byte budget is per page here, not per document: a locate scan reads a page, keeps a snippet, and drops the rest, so a thousand-page book is not a thousand pages held at once and capping the sum would refuse documents this command exists to search. What the sum does cost is time, and that is what the deadline -- one for the whole scan -- bounds.
    let i = start
    for (; i <= end && matches.length < maxMatches; i++) {
      const page = await getPageWithinDeadline(doc, i, deadline)
      const textItems = await readPageTextItems(page, MAX_PDF_TEXT_BYTES, deadline)
      const pageText = textItems.map((item) => item.str).join(' ')
      // Non-global regex: exec always starts at 0, so reusing `re` across pages carries no lastIndex state.
      const m = re.exec(pageText)
      if (m === null) continue
      matches.push({ page: i, snippet: locateSnippet(pageText, m.index, m[0].length, context) })
    }
    // The loop above exits either by scanning through `end` (i > end, a complete answer) or by hitting maxMatches with pages still left to scan (i <= end). Only the latter is truncation: a scan that covered every page and happened to land exactly on maxMatches results is not missing anything and must not be reported as a floor.
    const truncated = matches.length >= maxMatches && i <= end
    return { matches, truncated }
  })
}

/** A single-lined context window of ~`context` characters centred on the match at [index, index+matchLen). Internal whitespace runs collapse to one space so the snippet stays on one line even when the page text spans multiple lines. */
function locateSnippet(text: string, index: number, matchLen: number, context: number): string {
  // How long the match is, is up to the pattern: `[\s\S]+` is one match covering a whole page, so a window measured from it is a window the caller sizes. `context` is the width the flag promises and the only number either side of the match is measured against.
  const kept = Math.min(matchLen, context)
  const pad = Math.max(0, context - kept)
  const from = Math.max(0, index - Math.floor(pad / 2))
  const to = Math.min(text.length, index + kept + Math.ceil(pad / 2))
  const snippet = text.slice(from, to).replace(/\s+/g, ' ').trim()
  // Marked when the match itself was the thing cut, so a wide pattern does not hand back a prefix presented as the whole match -- the same courtesy the outline titles get.
  return matchLen > kept ? `${snippet}...` : snippet
}

export interface PdfOutlineEntry {
  level: number
  title: string
  page: number | null
}

/** The page one outline entry points at, or null when the destination does not resolve to one. Both awaits are raced against the document's deadline, as every other document await in this file is. The walk above checks the clock once per entry, which bounds how many times this runs but says nothing about how long one call takes, and both of these resolve a name through structures the file supplies: `getDestination` walks the name tree under `/Dests`, `getPageIndex` walks the page tree looking for the referenced page. Either can be made to search a large or pathological tree by the document, and without the race a single entry could hold the command open past the deadline the clock above exists to enforce. */
export async function resolveDestPage(doc: pdfjsTypes.PDFDocumentProxy, dest: string | unknown[] | null, deadline: number): Promise<number | null> {
  let explicitDest = dest
  if (typeof explicitDest === 'string') {
    explicitDest = await raceDeadline(doc.getDestination(explicitDest), deadline)
  }
  if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null
  try {
    const pageIndex = await raceDeadline(doc.getPageIndex(explicitDest[0] as never), deadline)
    return pageIndex + 1
  } catch (err) {
    // A destination that does not resolve is a property of the file, not a failure: it answers null and the entry keeps its title with no page. The deadline is not that -- it is the command giving up -- so it is rethrown rather than swallowed into a null the caller cannot tell apart from an ordinary unresolved destination.
    if (err instanceof PdfTookTooLongError) throw err
    return null
  }
}

export async function extractPdfOutline(data: Uint8Array): Promise<PdfOutlineEntry[]> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-outline')

  return withCrashGuard(
    () => withPdfDocument(pdfjs, data, async (doc, deadline) => {
      // Raced like every other document await: the whole /First-/Next chain is materialised before the entry cap is consulted once, so the cap bounds what the walk keeps and not what pdfjs built.
      const outline = await raceDeadline(doc.getOutline(), deadline)
      if (!outline) return []

      const entries: PdfOutlineEntry[] = []
      interface OutlineNode {
        title: string
        dest: string | unknown[] | null
        items: OutlineNode[]
      }
      // Depth was bounded here; breadth, title length and wall clock were not. A tree one level deep with a million siblings never reaches MAX_OUTLINE_DEPTH, and each sibling costs a destination resolution as well as its own attacker-chosen title.
      async function walk(items: OutlineNode[], level: number): Promise<void> {
        if (level >= MAX_OUTLINE_DEPTH) return

        for (const item of items) {
          if (entries.length >= MAX_OUTLINE_ENTRIES) return
          if (Date.now() > deadline) throw pdfWorkTookTooLong()
          const page = await resolveDestPage(doc, item.dest, deadline)
          const title = item.title.trim()
          entries.push({ level, title: title.length > MAX_OUTLINE_TITLE_CHARS ? `${title.slice(0, MAX_OUTLINE_TITLE_CHARS)}...` : title, page })
          if (item.items.length > 0) await walk(item.items, level + 1)
        }
      }
      await walk(outline, 0)
      return entries
    }),
    (err) => new Error(`PDF outline is too deeply nested to read safely (pdfjs-dist crashed marshaling it): ${err instanceof Error ? err.message : String(err)}`),
  )
}

export interface PdfMeta {
  pageCount: number
  title: string | null
  author: string | null
  hasTextLayer: boolean
}

async function pageHasText(doc: pdfjsTypes.PDFDocumentProxy, pageNum: number, deadline: number): Promise<boolean> {
  const page = await getPageWithinDeadline(doc, pageNum, deadline)
  // Drained rather than exited on the first hit: leaving the stream unread can leave the document teardown unable to settle, and cancelling it throws from inside pdfjs. See readPageTextItems for the mechanism. Which is exactly why this needs the deadline too -- it holds one boolean, so no byte budget would ever stop it, and the work it cannot decline to do is the whole point of the attack.
  let found = false
  for await (const chunk of pageTextItems(page, deadline)) {
    if (Date.now() > deadline) throw pdfWorkTookTooLong()
    found ||= chunk.some((item) => item.str.trim().length > 0)
  }
  return found
}

export async function extractPdfMeta(data: Uint8Array): Promise<PdfMeta> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-meta')

  return withPdfDocument(pdfjs, data, async (doc, deadline) => {
    const { info } = await raceDeadline(doc.getMetadata(), deadline)
    const infoDict = info as Record<string, unknown>

    // Page 1 alone is a weak signal -- a blank/scanned cover page with real searchable text later in the document would otherwise be misreported as "likely scanned/ image-only". Sample a few pages (first, middle, last) instead of the whole document, to keep pdf-meta cheap on large PDFs while cutting false negatives.
    const sampleNums = Array.from(new Set([1, Math.ceil(doc.numPages / 2), doc.numPages].filter((n) => n >= 1 && n <= doc.numPages)))
    let hasTextLayer = false
    for (const n of sampleNums) {
      if (await pageHasText(doc, n, deadline)) {
        hasTextLayer = true
        break
      }
    }

    return {
      pageCount: doc.numPages,
      title: typeof infoDict['Title'] === 'string' && infoDict['Title'].trim().length > 0 ? infoDict['Title'] : null,
      author: typeof infoDict['Author'] === 'string' && infoDict['Author'].trim().length > 0 ? infoDict['Author'] : null,
      hasTextLayer,
    }
  })
}
