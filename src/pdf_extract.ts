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

export async function extractPdfText(data: Uint8Array, pagesSpec?: string, layout = false): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  return withPdfDocument(pdfjs, data, async (doc) => {
    const range = parsePageRange(pagesSpec, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const pages: string[] = []
    for (let i = start; i <= end; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const textItems = content.items.filter((item) => 'str' in item) as unknown as LayoutTextItem[]
      const pageText = layout ? reconstructLayout(textItems) : textItems.map((item) => item.str).join(' ')
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
export async function locatePdfPages(
  data: Uint8Array,
  pattern: string,
  opts: { ignoreCase?: boolean; maxMatches?: number; context?: number; pages?: string },
): Promise<PdfLocateMatch[]> {
  // Compile up front so an invalid pattern fails with a message naming it,
  // rather than leaking a bare SyntaxError with no indication of which input
  // caused it (or paying pdfjs's document load only to throw afterwards).
  let re: RegExp
  try {
    re = new RegExp(pattern, opts.ignoreCase === true ? 'i' : '')
  } catch (e) {
    throw new Error(`invalid regex pattern: ${pattern} (${e instanceof Error ? e.message : String(e)})`, { cause: e })
  }

  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  const maxMatches = opts.maxMatches ?? 50
  const context = opts.context ?? 80

  return withPdfDocument(pdfjs, data, async (doc) => {
    const range = parsePageRange(opts.pages, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const matches: PdfLocateMatch[] = []
    for (let i = start; i <= end && matches.length < maxMatches; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const textItems = content.items.filter((item) => 'str' in item) as unknown as LayoutTextItem[]
      const pageText = textItems.map((item) => item.str).join(' ')
      // Non-global regex: exec always starts at 0, so reusing `re` across pages carries no lastIndex state.
      const m = re.exec(pageText)
      if (m === null) continue
      matches.push({ page: i, snippet: locateSnippet(pageText, m.index, m[0].length, context) })
    }
    return matches
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

  return withPdfDocument(pdfjs, data, async (doc) => {
    const outline = await doc.getOutline()
    if (!outline) return []

    const entries: PdfOutlineEntry[] = []
    interface OutlineNode {
      title: string
      dest: string | unknown[] | null
      items: OutlineNode[]
    }
    async function walk(items: OutlineNode[], level: number): Promise<void> {

      for (const item of items) {
        const page = await resolveDestPage(doc, item.dest)
        entries.push({ level, title: item.title.trim(), page })
        if (item.items.length > 0) await walk(item.items, level + 1)
      }
    }
    await walk(outline, 0)
    return entries
  })
}

export interface PdfMeta {
  pageCount: number
  title: string | null
  author: string | null
  hasTextLayer: boolean
}

async function pageHasText(doc: pdfjsTypes.PDFDocumentProxy, pageNum: number): Promise<boolean> {
  const page = await doc.getPage(pageNum)
  const content = await page.getTextContent()
  return content.items.some((item) => 'str' in item && item.str.trim().length > 0)
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
