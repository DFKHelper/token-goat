/**
 * Shared factory for the "lazily load an optional npm dependency" pattern used by every
 * optional-dependency reader (pdf_extract.ts, xlsx_extract.ts, ooxml_extract.ts, screenshot.ts,
 * image_shrink.ts): dynamic `import()`, cache the result once resolved -- including a failed
 * load, cached as `null` -- and never throw. Factors out six near-identical hand-written
 * cache/import/catch blocks into one.
 */
export function createLazyModuleLoader<T>(load: () => Promise<T>, errorLabel: string): () => Promise<T | null> {
  let cache: T | null | undefined
  return async () => {
    if (cache !== undefined) return cache
    try {
      cache = await load()
    } catch (err) {
      process.stderr.write(`token-goat: ${errorLabel}: ${String(err)}\n`)
      cache = null
    }
    return cache
  }
}
