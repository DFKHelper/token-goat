/**
 * PDF -> plain text extraction for `token-goat pdf-extract`, so a PDF's
 * useful content reaches the model as text instead of forcing a full binary
 * `Read` (which token-goat can't index or shrink). Uses `pdfjs-dist`'s legacy
 * Node build directly (zero runtime dependencies, no native canvas binding)
 * rather than the `pdf-parse` wrapper, whose v2 line pulls in `@napi-rs/canvas`
 * purely for a rendering feature this project never needs.
 */

import type * as pdfjsTypes from 'pdfjs-dist/legacy/build/pdf.mjs'

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
  // esbuild bundles this module's code directly into dist/token-goat.mjs, so pdfjs's
  // default relative-path guess for its worker script (next to its own file on disk)
  // resolves to a path inside dist/ that doesn't exist. Point it at the real file in
  // node_modules instead of letting it guess. import.meta.resolve is unavailable under
  // Vite/vitest's SSR transform in tests, so skip it there -- Node resolves the
  // unbundled module's own relative worker path fine outside the built bundle.
  if (typeof import.meta.resolve === 'function') {
    try {
      mod.GlobalWorkerOptions.workerSrc = await import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    } catch {
      // best-effort; extraction still works via pdfjs's own fallback resolution
    }
  }
  return mod
}, 'pdf-extract disabled (pdfjs-dist unavailable)')

/**
 * The most text one page-by-page read may produce, and the largest PDF that may be opened at all.
 *
 * A PDF content stream is Flate-compressed, so its expansion ratio is whatever its author chose. A
 * one-page file of 200 KB decompresses to tens of millions of text-showing operators, and the same
 * trick at 2 MB reaches gigabytes. The OOXML side of this codebase has bounded exactly this since
 * `zip_bounds.ts`; the PDF side had nothing, and the result was not a slow read but a dead process:
 * the heap is exhausted, the CLI aborts, and the background indexer -- which runs the same
 * extractor over a document and discards its output -- crash-loops on a file small enough to sit
 * under its own skip threshold. The file arrives in a repository the user has just cloned, and
 * reading it is something the model does unprompted.
 *
 * The output budget is the one that holds. 8 MB of text is past any document this tool is useful
 * on -- a 500-page book is about 1.5 MB, and 8 MB is already more tokens than any model's context
 * accepts -- while staying far below what it takes to hurt the process. The input cap is a second
 * fence for the shapes that cost before a page is ever read.
 */
export const MAX_PDF_TEXT_BYTES = 8 * 1024 * 1024
/** @see MAX_PDF_TEXT_BYTES */
export const MAX_PDF_INPUT_BYTES = 50 * 1024 * 1024

/** Thrown when a PDF's text passes {@link MAX_PDF_TEXT_BYTES}, or the file itself passes {@link MAX_PDF_INPUT_BYTES}. */
export class PdfTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfTooLargeError'
  }
}

/** Refuse a PDF whose on-disk size alone is past the bound, before any of it is parsed. */
export function assertPdfInputWithinBounds(byteLength: number, file: string): void {
  if (byteLength > MAX_PDF_INPUT_BYTES) {
    throw new PdfTooLargeError(`${file} is ${byteLength} bytes, past the ${MAX_PDF_INPUT_BYTES}-byte limit for a PDF. Split it, or extract from a smaller copy.`)
  }
}

function pdfTextBudgetExceeded(): PdfTooLargeError {
  return new PdfTooLargeError(`this PDF's text passes the ${MAX_PDF_TEXT_BYTES}-byte extraction limit. Narrow the read with --pages, or use a smaller document.`)
}

/**
 * One page's text items in arrival order, read through pdfjs's STREAM rather than its whole-page
 * accessor.
 *
 * `getTextContent()` materializes the entire item array before it returns, so a page carrying tens
 * of millions of text-showing operators exhausts the heap inside pdfjs, where no budget of ours can
 * see it. The stream hands the same items over in chunks, so a consumer can decide per chunk
 * whether to keep them -- which is what makes a bound possible at all.
 *
 * Falls back to the whole-page accessor only when a pdfjs build lacks the stream method, in which
 * case that build's own heap use is once again unbounded and only the input cap applies.
 */
async function* pageTextItems(page: pdfjsTypes.PDFPageProxy): AsyncGenerator<LayoutTextItem[]> {
  const keep = (items: readonly unknown[]): LayoutTextItem[] => items.filter((item) => item !== null && typeof item === 'object' && 'str' in item) as LayoutTextItem[]
  if (typeof page.streamTextContent !== 'function') {
    const content = await page.getTextContent()
    yield keep(content.items)
    return
  }
  const reader = (page.streamTextContent() as ReadableStream<{ items?: readonly unknown[] }>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield keep(value?.items ?? [])
  }
}

/**
 * One page's text items, refusing once they pass `budget` characters.
 *
 * The refusal drops what it has and keeps draining rather than breaking out, because breaking out
 * is not free here: a `cancel()` closes the web-stream controller while pdfjs still believes its
 * own is open -- pdfjs marks that only on its CLOSE message -- so a chunk already in flight calls
 * `enqueue` on a closed controller and throws from inside pdfjs's message handler, as an uncaught
 * exception rather than a rejection of anything a caller awaits. Abandoning the reader without
 * cancelling instead deadlocks `loadingTask.destroy()`. Draining costs parse time, which the input
 * cap already bounds; what it does not cost is the heap, which is the whole point -- nothing past
 * the budget is ever retained.
 *
 * @see MAX_PDF_TEXT_BYTES
 */
async function readPageTextItems(page: pdfjsTypes.PDFPageProxy, budget: number): Promise<LayoutTextItem[]> {
  let items: LayoutTextItem[] = []
  let spent = 0
  let over = false
  for await (const chunk of pageTextItems(page)) {
    if (over) continue
    for (const item of chunk) spent += item.str.length
    if (spent > budget) {
      over = true
      items = []
      continue
    }
    items.push(...chunk)
  }
  if (over) throw pdfTextBudgetExceeded()
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

/**
 * Reconstructs rough reading order from pdfjs's per-item x/y coordinates instead of pdfjs's
 * raw content-stream order (which interleaves columns/sidebars/footnotes on multi-column
 * pages). Groups items into rows by y-proximity, sorts each row left-to-right, and widens the
 * gap between items with a large x-jump (a likely column boundary). This is a heuristic, not
 * a real layout engine -- it will misjudge rotated text, overlapping text boxes, and tables
 * with irregular column widths.
 */
interface LayoutTextItem {
  str: string
  transform: number[]
  width?: number
}

function reconstructLayout(items: LayoutTextItem[]): string {
  const rows: LayoutTextItem[][] = []
  const Y_EPSILON = 2
  for (const item of items) {
    const y = item.transform[5] as number
    // Compare against the row's MOST RECENTLY added item, not its first -- a row is a
    // proximity chain (each item within Y_EPSILON of the item right before it), not a fixed
    // band around the first item's y. A smoothly y-drifting line (baseline jitter from a
    // scanned/rotated PDF, or justified text) where each adjacent pair is within Y_EPSILON but
    // the cumulative drift across the whole line exceeds it would otherwise get wrongly split
    // into multiple rows once compared only against the first item.
    const row = rows.find((r) => Math.abs((r[r.length - 1] as LayoutTextItem).transform[5]! - y) < Y_EPSILON)
    if (row) row.push(item)
    else rows.push([item])
  }
  rows.sort((a, b) => ((b[0] as LayoutTextItem).transform[5] as number) - ((a[0] as LayoutTextItem).transform[5] as number))

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

/**
 * Loads `data` as a pdfjs document, runs `fn` against it, and always destroys the
 * loading task afterward -- centralizes the getDocument options and try/finally
 * teardown shared by extractPdfText/extractPdfOutline/extractPdfMeta.
 */
async function withPdfDocument<T>(pdfjs: PdfjsModule, data: Uint8Array, fn: (doc: pdfjsTypes.PDFDocumentProxy) => Promise<T>): Promise<T> {
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, disableFontFace: true, verbosity: 0 })
  try {
    return await fn(await loadingTask.promise)
  } finally {
    await loadingTask.destroy()
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

  return withPdfDocument(pdfjs, data, async (doc) => {
    const range = parsePageRange(pagesSpec, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const pages: string[] = []
    let spent = 0
    for (let i = start; i <= end; i++) {
      const page = await doc.getPage(i)
      const textItems = await readPageTextItems(page, MAX_PDF_TEXT_BYTES - spent)
      const pageText = layout ? reconstructLayout(textItems) : textItems.map((item) => item.str).join(' ')
      spent += pageText.length
      pages.push(pageText.trim())
    }

    return { text: pages.join('\n\n'), pageCount: doc.numPages, pagesExtracted: end - start + 1 }
  })
}

export interface PdfLocateMatch {
  page: number
  snippet: string
}

/**
 * Cheap where-pass for `token-goat pdf-locate`: returns the pages whose text
 * matches `pattern`, each with a short snippet, so a caller can then run
 * pdf-extract on only those pages instead of pulling the whole document into
 * the model's context. One snippet per matching page (centred on the first
 * match on that page, whitespace collapsed) is enough to confirm the hit --
 * dumping the whole page would defeat the point of locating first.
 */
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
  // Compile up front so an invalid pattern fails with a message naming it, rather than leaking a
  // bare SyntaxError with no indication of which input caused it (or paying pdfjs's document load
  // only to throw afterwards). Guarded rather than compiled: this then runs per page over text the
  // caller does not control, and a backtracking pattern cannot be interrupted. See regex_guard.ts.
  const guarded = compileGuardedRegex(pattern, opts.ignoreCase === true ? 'i' : '')
  if (!guarded.ok) throw new Error(`invalid regex pattern: ${pattern} (${guarded.reason})`)
  const re = guarded.re

  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  const maxMatches = opts.maxMatches ?? 50
  const context = opts.context ?? 80

  return withPdfDocument(pdfjs, data, async (doc) => {
    const range = parsePageRange(opts.pages, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const matches: PdfLocateMatch[] = []
    let i = start
    for (; i <= end && matches.length < maxMatches; i++) {
      const page = await doc.getPage(i)
      const textItems = await readPageTextItems(page, MAX_PDF_TEXT_BYTES)
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

/**
 * A single-lined context window of ~`context` characters centred on the match
 * at [index, index+matchLen). Internal whitespace runs collapse to one space so
 * the snippet stays on one line even when the page text spans multiple lines.
 */
function locateSnippet(text: string, index: number, matchLen: number, context: number): string {
  const pad = Math.max(0, context - matchLen)
  const from = Math.max(0, index - Math.floor(pad / 2))
  const to = Math.min(text.length, index + matchLen + Math.ceil(pad / 2))
  return text.slice(from, to).replace(/\s+/g, ' ').trim()
}

export interface PdfOutlineEntry {
  level: number
  title: string
  page: number | null
}

async function resolveDestPage(doc: pdfjsTypes.PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  let explicitDest = dest
  if (typeof explicitDest === 'string') {
    explicitDest = await doc.getDestination(explicitDest)
  }
  if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null
  try {
    const pageIndex = await doc.getPageIndex(explicitDest[0] as never)
    return pageIndex + 1
  } catch {
    return null
  }
}

export async function extractPdfOutline(data: Uint8Array): Promise<PdfOutlineEntry[]> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-outline')

  return withCrashGuard(
    () => withPdfDocument(pdfjs, data, async (doc) => {
      const outline = await doc.getOutline()
      if (!outline) return []

      const entries: PdfOutlineEntry[] = []
      interface OutlineNode {
        title: string
        dest: string | unknown[] | null
        items: OutlineNode[]
      }
      async function walk(items: OutlineNode[], level: number): Promise<void> {
        if (level >= MAX_OUTLINE_DEPTH) return

        for (const item of items) {
          const page = await resolveDestPage(doc, item.dest)
          entries.push({ level, title: item.title.trim(), page })
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

async function pageHasText(doc: pdfjsTypes.PDFDocumentProxy, pageNum: number): Promise<boolean> {
  const page = await doc.getPage(pageNum)
  // Drained rather than exited on the first hit: leaving the stream unread deadlocks the document
  // teardown, and cancelling it throws from inside pdfjs. See readPageTextItems for the mechanism.
  let found = false
  for await (const chunk of pageTextItems(page)) {
    found ||= chunk.some((item) => item.str.trim().length > 0)
  }
  return found
}

export async function extractPdfMeta(data: Uint8Array): Promise<PdfMeta> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-meta')

  return withPdfDocument(pdfjs, data, async (doc) => {
    const { info } = await doc.getMetadata()
    const infoDict = info as Record<string, unknown>

    // Page 1 alone is a weak signal -- a blank/scanned cover page with real searchable
    // text later in the document would otherwise be misreported as "likely scanned/
    // image-only". Sample a few pages (first, middle, last) instead of the whole
    // document, to keep pdf-meta cheap on large PDFs while cutting false negatives.
    const sampleNums = Array.from(new Set([1, Math.ceil(doc.numPages / 2), doc.numPages].filter((n) => n >= 1 && n <= doc.numPages)))
    let hasTextLayer = false
    for (const n of sampleNums) {
      if (await pageHasText(doc, n)) {
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
