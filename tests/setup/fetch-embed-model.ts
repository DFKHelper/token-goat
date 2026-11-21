// Child of tests/setup/seed-embed-model.ts, run with TOKEN_GOAT_HOME on a scratch directory and TOKEN_GOAT_MODEL_CACHE_DIR on the shared test cache: places the pinned embedding model in that cache when it is missing, then exits. One attempt and no backoff, so an offline machine learns that in seconds; scripts/warm-model-cache.ts is the retrying version CI uses.
import { ensureModelFiles, modelFilesPresent } from '../../src/embed_model.js'
import { withExplicitDownload } from '../../src/model_download_gate.js'

async function main(): Promise<void> {
  // The scratch home holds no copy, so this is true only when the shared cache already has every pinned file.
  if (modelFilesPresent()) return
  await withExplicitDownload(() => ensureModelFiles())
  if (!modelFilesPresent()) throw new Error('the download returned but the pinned files are still not all present')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
