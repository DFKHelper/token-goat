/**
 * Place the pinned embedding model on this machine, then stop.
 *
 * The test suite never downloads it: the seven files that exercise real embeddings gate on
 * `modelFilesPresent()` and skip when the weights are absent, which keeps `npm test` offline by
 * default. That leaves exactly one place allowed to fetch the 33 MB, and this is it: one named step
 * whose failure is reported as a failure, rather than 54 scattered fetches hidden inside a green run.
 *
 * Set `TOKEN_GOAT_MODEL_CACHE_DIR` before running it to have the files published to a shared cache
 * directory that outlives the data root, which is how CI carries them from one run to the next.
 */

import { ensureModelFiles, modelFilesPresent } from '../src/embed_model.js'

/** Absorbs a transient Hugging Face rate-limit or CDN block without turning every pull request red; a real outage still fails after the last one. */
const ATTEMPTS = 3

/** Between attempts. Long enough to outlast a burst limit, short enough not to dominate the job. */
const BACKOFF_MS = 30_000

async function main(): Promise<void> {
  if (modelFilesPresent()) {
    console.log('Embedding model already present, nothing to download.')
    return
  }

  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const dir = await ensureModelFiles()
      // Re-checked rather than trusted, because `ensureModelFiles` returning is not the same claim as the gate the tests read agreeing: a half-placed model would otherwise be reported as a success here and then skip every test that needs it.
      if (!modelFilesPresent()) throw new Error(`ensureModelFiles returned ${dir} but modelFilesPresent() is still false`)
      console.log(`Embedding model placed in ${dir}.`)
      return
    } catch (err) {
      last = err
      console.error(`Attempt ${attempt}/${ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

main().catch((err: unknown) => {
  console.error(`Could not obtain the embedding model: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
