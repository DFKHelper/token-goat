/** Downloads held to a SHA-256 and byte length recorded in this repository. They are the embedding model's weights (embed_model.ts) and the WebAssembly build of the inference runtime (embed_runtime.ts). Nothing here decides which file is wanted or what URL it comes from; a caller passes both, and every caller builds its URL from constants of its own. Lives outside embed_model.ts, which EMBED_FINGERPRINT hashes, because none of it can change what a vector holds: every byte that leaves this module has already matched a pinned sha256 and length, so an edit here can make a fetch fail but cannot make a different file succeed. Hashing it would re-embed every file on every machine for a change to how bytes are copied. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { loadConfig } from './config.js'
import { ensureDirSync } from './util.js'

/** One pinned file, with the size and digest its bytes must have. */
export interface PinnedFile {
  /** Path within the cache directory that holds it. */
  readonly name: string
  readonly sha256: string
  readonly bytes: number
}

export function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Place one pinned file from the shared cache, reporting whether the caller still needs to download it. The copy is hashed after it lands rather than at the source, so what is verified is the exact bytes that will be used rather than bytes that were equal to them a moment earlier. It costs the same single pass either way. */
export async function copyFromSharedCache(shared: string, file: PinnedFile, target: string): Promise<boolean> {
  const source = path.join(shared, file.name)
  const temp = `${target}.${process.pid}.shared`
  try {
    // lstat rather than exists, and checked before the copy rather than after: the digest can only judge bytes that have already been copied, so it is no help against a source that never finishes producing them. A FIFO here would block the copy forever and a symlink to an endless device would fill the disk under the model directory. The download path has bounded its writes against `file.bytes` all along; this makes the two agree.
    const info = fs.lstatSync(source, { throwIfNoEntry: false })
    if (!info?.isFile() || info.size !== file.bytes) return false
    fs.copyFileSync(source, temp)
    if ((await sha256Of(temp)) !== file.sha256) {
      fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
      // A cached file that does not match is not a file to keep offering to every later run. Drop it so the download below republishes a good one.
      fs.rmSync(source, { force: true, maxRetries: 20, retryDelay: 25 })
      return false
    }
    fs.renameSync(temp, target)
    return true
  } catch {
    // The shared cache is an optimization and never a reason to fail: any trouble here falls through to the download that would have run anyway.
    try {
      fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
    } catch {
      // Nothing to add: the caller is about to download regardless.
    }
    return false
  }
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

/** Fetch one file to its final path, or throw. The digest is checked before the file is put in place, so a partial or wrong download never becomes the cached copy: everything lands on a temporary name in the same directory first. */
export async function downloadPinned(url: string, file: PinnedFile, target: string): Promise<void> {
  // Each caller refuses first with advice of its own; this is the gate every download passes, so a new caller cannot leave the machine in offline mode by forgetting that check.
  if (loadConfig().network.offline) throw new Error(`Offline mode is on (network.offline): refusing to download ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error(`GET ${url} returned no body`)

  const temp = `${target}.${process.pid}.partial`
  const hash = createHash('sha256')
  let written = 0
  const out = fs.createWriteStream(temp)
  try {
    // `pipeline` rather than a hand-rolled write loop, because it owns the three things that loop kept getting wrong: it propagates an error from either end instead of leaving one on a stream with no listener (which Node re-raises as an uncaught exception, killing the CLI); it settles rather than waiting forever for a `drain` that a failed sink will never emit; and it destroys and closes both ends before returning, so the cleanup below is not unlinking a file somebody still has open.
    await pipeline(async function* () {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength
        // The size is pinned along with the digest, so a response that overruns it is already wrong and there is no reason to keep spending disk on it before saying so.
        if (written > file.bytes) throw new Error(`${file.name} is longer than the pinned ${file.bytes} bytes`)
        hash.update(chunk)
        yield chunk
      }
    }, out)

    if (written !== file.bytes) {
      throw new Error(`${file.name} is ${written} bytes, expected the pinned ${file.bytes}`)
    }
    const digest = hash.digest('hex')
    if (digest !== file.sha256) {
      throw new Error(`${file.name} has sha256 ${digest}, expected the pinned ${file.sha256}`)
    }
    fs.renameSync(temp, target)
  } catch (e) {
    // `pipeline` destroys the sink but rejects without waiting for it to close, and the first chunk can be rejected before the file is even open. Removing it at that moment deletes nothing and the open lands afterwards, leaving the scratch file behind for good -- 34 MB of it, on every failed attempt. So wait for the handle to actually close first.
    await new Promise<void>((resolve) => {
      if (out.closed) resolve()
      else out.once('close', () => resolve())
    })
    try {
      // Retries because Windows reports EPERM for a moment after a handle is closed.
      fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
    } catch {
      // The download already failed and that is the news. A cleanup that fails on top of it must not replace the reason with its own, less useful one.
    }
    throw e
  }
}
