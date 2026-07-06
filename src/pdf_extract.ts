/**
 * PDF -> plain text extraction for `token-goat pdf-extract`, so a PDF's
 * useful content reaches the model as text instead of forcing a full binary
 * `Read` (which token-goat can't index or shrink). Uses `pdfjs-dist`'s legacy
 * Node build directly (zero runtime dependencies, no native canvas binding)
 * rather than the `pdf-parse` wrapper, whose v2 line pulls in `@napi-rs/canvas`
 * purely for a rendering feature this project never needs.
 */

import type * as pdfjsTypes from 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfExtractResult {
  text: string
  pageCount: number
  pagesExtracted: number
}

type PdfjsModule = typeof pdfjsTypes

let _pdfjsCache: PdfjsModule | null | undefined

async function loadPdfjs(): Promise<PdfjsModule | null> {
  if (_pdfjsCache !== undefined) return _pdfjsCache
  try {
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
    _pdfjsCache = mod
  } catch (err) {
    process.stderr.write(`token-goat: pdf-extract disabled (pdfjs-dist unavailable): ${String(err)}\n`)
    _pdfjsCache = null
  }
  return _pdfjsCache
}

/** Parses a 1-indexed inclusive page spec like "1-5" or "3". Returns null (all pages) when unset. */
export function parsePageRange(spec: string | undefined, pageCount: number): { start: number; end: number } | null {
  if (!spec) return null
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) throw new Error(`invalid --pages spec: ${spec} (expected "N" or "N-M")`)
  const start = parseInt(m[1] as string, 10)
  const end = m[2] ? parseInt(m[2], 10) : start
  if (start < 1 || end < start) throw new Error(`invalid --pages spec: ${spec}`)
  return { start: Math.min(start, pageCount), end: Math.min(end, pageCount) }
}

export async function extractPdfText(data: Uint8Array, pagesSpec?: string): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs()
  if (!pdfjs) throw new Error('pdfjs-dist is not installed; run `npm install pdfjs-dist` to enable pdf-extract')

  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, disableFontFace: true, verbosity: 0 })
  try {
    const doc = await loadingTask.promise
    const range = parsePageRange(pagesSpec, doc.numPages)
    const start = range ? range.start : 1
    const end = range ? range.end : doc.numPages

    const pages: string[] = []
    for (let i = start; i <= end; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      pages.push(pageText.trim())
    }

    return { text: pages.join('\n\n'), pageCount: doc.numPages, pagesExtracted: end - start + 1 }
  } finally {
    await loadingTask.destroy()
  }
}
