/** Place the pinned embedding model, and the WebAssembly inference runtime's binary, on this machine, then stop. The test suite never downloads either: the files that exercise real embeddings gate on `modelFilesPresent()` (and the bundled-runtime ones on `wasmBinaryPresent()` too) and skip when they are absent, which keeps `npm test` offline by default. That leaves exactly one place allowed to fetch the 33 MB of weights and the runtime's 33 MB npm tarball, and this is it: one named step whose failure is reported as a failure, rather than scattered fetches hidden inside a green run. Set `TOKEN_GOAT_MODEL_CACHE_DIR` before running it to have the files published to a shared cache directory that outlives the data root, which is how CI carries them from one run to the next. */

import { ensureModelFiles, modelFilesPresent } from '../src/embed_model.js'
import { ensureWasmBinary, wasmBinaryPresent, wasmDir } from '../src/embed_runtime.js'
import { withExplicitDownload } from '../src/model_download_gate.js'

/** Absorbs a transient registry rate-limit or CDN block without turning every pull request red; a real outage still fails after the last one. */
const ATTEMPTS = 3

/** Between attempts. Long enough to outlast a burst limit, short enough not to dominate the job. */
const BACKOFF_MS = 30_000

/** Run `place` until `present()` agrees it worked, retrying a failure. */
async function warm(what: string, present: () => boolean, place: () => Promise<string>): Promise<void> {
  if (present()) {
    console.log(`${what} already present, nothing to download.`)
    return
  }

  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const where = await place()
      // Re-checked rather than trusted, because the placing call returning is not the same claim as the gate the tests read agreeing: a half-placed file would otherwise be reported as a success here and then skip every test that needs it.
      if (!present()) throw new Error(`placing it returned ${where} but its presence check is still false`)
      console.log(`${what} placed in ${where}.`)
      return
    } catch (err) {
      last = err
      console.error(`${what}: attempt ${attempt}/${ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function main(): Promise<void> {
  await warm('Embedding model', modelFilesPresent, ensureModelFiles)
  await warm('WebAssembly runtime binary', wasmBinaryPresent, async () => {
    const bytes = await ensureWasmBinary()
    return `${wasmDir()} (${bytes.byteLength} bytes)`
  })
}

// A CI cache warm is a download asked for by name: its retry loop above must reach the network each attempt rather than stop at the hold the first failure records.
withExplicitDownload(main).catch((err: unknown) => {
  console.error(`Could not obtain the embedding model or its runtime: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
