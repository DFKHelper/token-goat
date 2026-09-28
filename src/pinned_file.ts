/** Files held to a SHA-256 and byte length recorded in this repository. They are the embedding model's weights (embed_model.ts) and the WebAssembly build of the inference runtime (embed_runtime_web.ts). Nothing here decides which file is wanted or what URL it comes from; a caller passes both, and every caller builds its URL from constants of its own. Lives outside embed_model.ts, which EMBED_FINGERPRINT hashes, because none of it can change what a vector holds: every byte that leaves it has already matched a pinned sha256 and length, so an edit here can make a fetch fail but cannot make a different file succeed. Hashing it would re-embed every file on every machine for a change to how bytes are copied. The hashing, copying and downloading are in pinned_fetch.ts behind a dynamic import, because embed_model.ts imports this module and embed_model.ts is on the hook path, where nothing is ever downloaded; only {@link publishToSharedCache}, which a caller runs synchronously, is here in full. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { ensureDirSync } from './util.js'

/** One pinned file, with the size and digest its bytes must have. */
export interface PinnedFile {
  /** Path within the cache directory that holds it. */
  readonly name: string
  readonly sha256: string
  readonly bytes: number
}

/** The sha256 of the file's bytes, as lowercase hex. */
export async function sha256Of(filePath: string): Promise<string> {
  return (await import('./pinned_fetch.js')).sha256Of(filePath)
}

/** Place one pinned file from the shared cache, reporting whether the caller still needs to download it. See pinned_fetch.ts. */
export async function copyFromSharedCache(shared: string, file: PinnedFile, target: string): Promise<boolean> {
  return (await import('./pinned_fetch.js')).copyFromSharedCache(shared, file, target)
}

/** Fetch one file to its final path, held to its pinned length and digest, or throw. See pinned_fetch.ts. */
export async function downloadPinned(url: string, file: PinnedFile, target: string): Promise<void> {
  return (await import('./pinned_fetch.js')).downloadPinned(url, file, target)
}

/** Offer a freshly downloaded file to the shared cache for the next run. Best effort throughout: a cache that cannot be written is a slower next run, not a failure of this one. */
export function publishToSharedCache(shared: string, file: PinnedFile, target: string): void {
  const destination = path.join(shared, file.name)
  const temp = `${destination}.${process.pid}.partial`
  let created = false
  try {
    if (fs.existsSync(destination)) return
    ensureDirSync(path.dirname(destination))
    // COPYFILE_EXCL, because this is the one write that lands in a directory the operator named and may share. Without it the copy opens the temp name O_CREAT|O_TRUNC and follows a symlink planted there, so anyone who can write this directory can have the model bytes truncate any file the operator can write; measured, not assumed. With it the copy fails EEXIST and publishing is skipped, which costs a later download and nothing else.
    fs.copyFileSync(target, temp, fs.constants.COPYFILE_EXCL)
    created = true
    // Rename last, so a reader never sees a partially written file under the real name however many workers publish at once.
    fs.renameSync(temp, destination)
  } catch {
    // Gated on having created it, because the copy above refuses a name it did not create: a failure before that point means the thing at this name is somebody else's, and cleaning up after ourselves must not mean deleting it.
    if (!created) return
    try {
      fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
    } catch {
      // Same reasoning as the copy path: the model is already in place and that is what the caller asked for.
    }
  }
}
