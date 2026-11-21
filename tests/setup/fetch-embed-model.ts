// Child of tests/setup/seed-embed-model.ts, run with TOKEN_GOAT_HOME on a scratch directory and TOKEN_GOAT_MODEL_CACHE_DIR on the shared test cache: leaves that cache holding every pinned model file with its pinned sha256, then exits. A shared file of the wrong size or digest is dropped first and counts as missing, so a good cache is only copied from (no network call) and a bad one is replaced when the network is up; when it is not, the failure line names the file. The download makes up to three attempts with a short pause when a failure looks passing (src/pinned_fetch.ts::downloadPinned); scripts/warm-model-cache.ts is the version with a long backoff that CI uses.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MODEL_FILES, ensureModelFiles, sharedModelCacheDir } from '../../src/embed_model.js'
import { withExplicitDownload } from '../../src/model_download_gate.js'
import { sha256Of, type PinnedFile } from '../../src/pinned_file.js'

type Verdict = 'ok' | 'absent' | 'wrong size' | 'sha256 mismatch'

/** Judges one shared-cache file the way src/pinned_fetch.ts::copyFromSharedCache does: a regular file of the pinned size first, so nothing is hashed that the copy would refuse, then the digest. */
async function judge(shared: string, file: PinnedFile): Promise<Verdict> {
  const info = fs.lstatSync(path.join(shared, file.name), { throwIfNoEntry: false })
  if (!info) return 'absent'
  if (!info.isFile() || info.size !== file.bytes) return 'wrong size'
  return (await sha256Of(path.join(shared, file.name))) === file.sha256 ? 'ok' : 'sha256 mismatch'
}

async function main(): Promise<void> {
  const shared = sharedModelCacheDir()
  if (!shared) throw new Error('no shared model cache directory is set, so there is nowhere to seed the model')
  const dropped: string[] = []
  for (const file of MODEL_FILES) {
    const verdict = await judge(shared, file)
    if (verdict === 'ok' || verdict === 'absent') continue
    dropped.push(`${file.name}: ${verdict}`)
    // Only a regular file is removed. The copy that places a file would remove a digest mismatch itself, but never a wrong size, which publishing would then never replace.
    if (fs.lstatSync(path.join(shared, file.name)).isFile()) fs.rmSync(path.join(shared, file.name), { force: true })
  }
  const dropNote = dropped.length ? ` (dropped from the shared cache for failing its pin: ${dropped.join(', ')})` : ''
  if (dropped.length) console.error(`dropped from the shared model cache: ${dropped.join(', ')}`)
  try {
    await withExplicitDownload(() => ensureModelFiles())
  } catch (err) {
    throw new Error(`${(err instanceof Error ? err.message : String(err)).split('\n')[0]}${dropNote}`, { cause: err })
  }
  // Publishing to the shared cache is best effort, so the call returning says nothing about the copy the rows read.
  const bad: string[] = []
  for (const file of MODEL_FILES) {
    const verdict = await judge(shared, file)
    if (verdict !== 'ok') bad.push(`${file.name}: ${verdict}`)
  }
  if (bad.length) throw new Error(`the shared model cache still does not hold the pinned files (${bad.join(', ')})${dropNote}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
