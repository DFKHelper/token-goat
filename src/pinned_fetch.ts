/** Hashing, copying and downloading files pinned by digest and length. The callers are pinned_file.ts's wrappers, through `await import()`, and embed_runtime_web.ts, which is itself only loaded that way. embed_model.ts, which is on the hook path, imports pinned_file.ts statically, so keeping these there put the download and its stream handling in front of V8 on every hook call, which never downloads anything. Outside EMBED_FINGERPRINT for the reason pinned_file.ts gives. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { loadConfig } from './config.js'
import { DownloadCooldownError, DownloadFailedError, activeDownloadCooldown, clearDownloadFailure, describeCause, isExplicitDownload, recordDownloadFailure } from './model_download_gate.js'
import type { PinnedFile } from './pinned_file.js'

const ATTEMPTS = 3
let retryDelayMs = 250

/** Test-only: the pause before retry n is this times n. null restores the default. */
export function setPinnedRetryDelayForTesting(ms: number | null): void {
  retryDelayMs = ms ?? 250
}

/** Error codes on a rejection's cause chain that a retry a quarter second later would only repeat: a host name that does not resolve, a certificate the machine does not trust (as behind an inspecting proxy), and a URL that does not parse. Read off `cause.code` rather than the message, because Node puts the code there and not in the text: "self-signed certificate" arrives as DEPTH_ZERO_SELF_SIGNED_CERT. */
const DETERMINISTIC_CODE = /^(?:ENOTFOUND|EAI_NONAME|ERR_INVALID_URL|ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/

function causeCodes(e: unknown): string[] {
  const codes: string[] = []
  let cursor: unknown = e
  for (let depth = 0; cursor !== null && typeof cursor === 'object' && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    cursor = (cursor as { cause?: unknown }).cause
  }
  return codes
}

/** Whether a failed request is worth repeating at once: a dropped connection, a timeout, or the server saying it is busy. A refusal (4xx), a DNS answer that the host does not exist, or a certificate this machine rejects will say the same thing a quarter second later. */
function transient(e: unknown): boolean {
  if (e instanceof TypeError) return !causeCodes(e).some((code) => DETERMINISTIC_CODE.test(code)) && !/ENOTFOUND/.test(describeCause(e))
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
}

/** A request that got no usable answer from the host: the connection failed, the status was not ok, or the body broke off partway. These are what is retried and recorded against the host. Bytes that arrived whole but were the wrong length or digest came from a host that answered, and a file that could not be written is this machine's trouble, so neither is one of these. */
class HostFailure extends Error {
  readonly retry: boolean
  constructor(message: string, retry: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.retry = retry
  }
}

/** Record a failure that reached no usable answer from the host, and return the error to throw. Recording is best-effort: a data dir that cannot be written to must not hide the reason the download failed. */
function failure(url: string, message: string, cause: unknown, startedAt: number): DownloadFailedError {
  let at = Date.now()
  try {
    at = recordDownloadFailure(url, message, at, startedAt).at
  } catch {
    // The download failure is the news; the bookkeeping failing on top of it is not.
  }
  return new DownloadFailedError(message, url, at, cause)
}

function forgetFailure(url: string): void {
  try {
    clearDownloadFailure(url)
  } catch {
    // A stale record costs one held retry at worst, never a wrong file.
  }
}

/** GET `url`, throwing a {@link HostFailure} for anything short of an ok response. Every response that is not used has its body cancelled, so an error page does not hold its connection open until the collector finds it. The message keeps the cause Node's fetch hides one level down, e.g. "fetch failed (connect ECONNREFUSED 127.0.0.1:9)". */
async function fetchOk(url: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (e) {
    throw new HostFailure(`GET ${url} failed: ${describeCause(e)}`, transient(e), e)
  }
  if (response.ok) return response
  await response.body?.cancel().catch(() => undefined)
  throw new HostFailure(`GET ${url} returned ${response.status} ${response.statusText}`, response.status >= 500 || response.status === 429)
}

/** The body's chunks, with a read that fails partway turned into a {@link HostFailure}: a connection that drops mid-download is the host failing just as a refused one is, and was neither retried nor recorded, so a flaky link failed the whole download on its first drop and left the next caller free to try at once. Only the body's own errors land in the catch: when the consumer stops early, `for await` calls `return()` here, which runs no catch. */
async function* bodyChunks(url: string, body: ReadableStream<Uint8Array>, expected: number): AsyncGenerator<Uint8Array> {
  let received = 0
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength
      yield chunk
    }
  } catch (e) {
    throw new HostFailure(`GET ${url} broke off after ${received} of ${expected} bytes: ${describeCause(e)}`, transient(e), e)
  }
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

/** Fetch one file to its final path, or throw. The digest is checked before the file is put in place, so a partial or wrong download never becomes the cached copy: everything lands on a temporary name in the same directory first. A request that reaches no usable answer, whether it fails to connect, gets an error status or breaks off partway through the body, is tried up to three times when the failure looks passing and is recorded against the host when it gives up. */
export async function downloadPinned(url: string, file: PinnedFile, target: string): Promise<void> {
  // Each caller refuses first with advice of its own; this is the gate every download passes, so a new caller cannot leave the machine in offline mode by forgetting that check.
  if (loadConfig().network.offline) throw new Error(`Offline mode is on (network.offline): refusing to download ${url}`)
  if (!isExplicitDownload()) {
    const cooldown = activeDownloadCooldown(url)
    if (cooldown) throw new DownloadCooldownError(url, cooldown)
  }
  const startedAt = Date.now()
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchAndPlace(url, file, target)
      forgetFailure(url)
      return
    } catch (e) {
      if (!(e instanceof HostFailure)) throw e
      if (attempt < ATTEMPTS && e.retry) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
        continue
      }
      throw failure(url, e.message, e.cause, startedAt)
    }
  }
}

async function fetchAndPlace(url: string, file: PinnedFile, target: string): Promise<void> {
  const response = await fetchOk(url)
  const body = response.body
  if (!body) throw new Error(`GET ${url} returned no body`)

  const temp = `${target}.${process.pid}.partial`
  const hash = createHash('sha256')
  let written = 0
  const out = fs.createWriteStream(temp)
  try {
    // `pipeline` rather than a hand-rolled write loop, because it owns the three things that loop kept getting wrong: it propagates an error from either end instead of leaving one on a stream with no listener (which Node re-raises as an uncaught exception, killing the CLI); it settles rather than waiting forever for a `drain` that a failed sink will never emit; and it destroys and closes both ends before returning, so the cleanup below is not unlinking a file somebody still has open.
    await pipeline(async function* () {
      for await (const chunk of bodyChunks(url, body, file.bytes)) {
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
