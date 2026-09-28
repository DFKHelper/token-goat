/** Getting the WebAssembly build of ONNX Runtime running. That is placing its verified `.wasm`, downloading it once when it is not on this machine, and handing it and the glue module to the bundled JavaScript. embed_runtime.ts reaches this only through `await import()`, and only when a session is about to be created, because none of it is needed to decide which runtime to use or to report on one, and embed_runtime.ts is on the hook path (embeddings.ts imports it, and hooks never embed): kept static, the tar reader and the download here were 13 KB that V8 parsed on every hook call. Outside EMBED_FINGERPRINT for the same reason embed_runtime.ts is (see there), and tests/guards/embed_runtime_is_unhashed.test.ts keeps it that way. Security posture of the `.wasm` download, the same one the model weights are held to (embed_model.ts): - The URL is built from constants only: the npm registry's own tarball for one exact onnxruntime-web version. Nothing caller-supplied reaches it. - The tarball is held to a pinned SHA-256 and an exact byte length while it streams (pinned_file.ts), so an overrunning or altered response is refused before anything is read out of it. The pinned digest was taken from the published artifact, whose sha512 matches the registry's own `dist.integrity` for that version. - The one member used is held to its own pinned SHA-256 and length, on extraction and again on every load, and the bytes handed to the runtime are the bytes that were just verified rather than a path it reopens. - The small JavaScript glue the WebAssembly build loads by path (and starts its worker threads from) ships inside the package, beside the bundle, rather than being downloaded, and is checked against a pinned digest before use. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'

import { loadConfig } from './config.js'
import { ensureDataDirPrivate } from './constants.js'
import type { OrtSession, OrtTensorConstructor, OrtWebModule } from './embed_runtime.js'
import { copyFromSharedCache, downloadPinned } from './pinned_fetch.js'
import type { PinnedFile } from './pinned_file.js'
import { registerReset } from './reset.js'
import { atomicWriteText, ensureDirSync } from './util.js'

const _require = createRequire(import.meta.url)

/** What this module needs from embed_runtime.ts and pinned_file.ts, handed over by embed_runtime.ts on every call rather than imported. esbuild makes a dynamically imported module an entry point of its own, and anything it imports statically is then reached from one more entry than embed_model.ts is, which puts it in a separate chunk: importing the two here split them out of the chunk the hook path already loads, and the import and export lists of that boundary alone cost the hook path 738 bytes, measured. Type-only imports are erased and cost nothing. */
export interface WebRuntimeHost {
  /** ORT_WEB_VERSION. */
  readonly version: string
  /** ORT_WEB_WASM. */
  readonly wasm: PinnedFile
  /** wasmDir(). */
  readonly dir: string
  /** sharedWasmCacheDir(). */
  readonly sharedDir: string | null
  /** publishToSharedCache. */
  publish(shared: string, file: PinnedFile, target: string): void
  /** Where a start failure is recorded, and the key a later process has to present to be held to it (startFailurePath and startFailureKey in embed_runtime.ts). */
  readonly startFailure: { readonly path: string; readonly key: string }
  /** Remember a failure in this process, as a failure to start (`started`) or to place the binary; returns it as an Error to throw. */
  failed(e: unknown, started: boolean): Error
}

/** The npm registry tarball of onnxruntime-web at ORT_WEB_VERSION in embed_runtime.ts, whose value its name spells out because this module cannot import it (see {@link WebRuntimeHost}); tests/embed_runtime_pins.test.ts holds the name to the lock file's resolved URL for the devDependency. CAPTURE: fetched from registry.npmjs.org on 2026-09-28; its sha512 equals the registry's `dist.integrity` (sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==) and its sha1 the registry's `dist.shasum`, so these are the published bytes. */
export const ORT_WEB_TARBALL: PinnedFile = {
  name: 'onnxruntime-web-1.30.0.tgz',
  sha256: 'd2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71',
  bytes: 33106585,
}

/** The glue module that instantiates the binary and that each worker thread loads by path. Ships beside the bundle (esbuild.config.mjs copies it into dist/). CAPTURE: `sha256sum` over `package/dist/ort-wasm-simd-threaded.mjs` from the tarball above. */
export const ORT_WEB_GLUE: PinnedFile = {
  name: 'ort-wasm-simd-threaded.mjs',
  sha256: 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b',
  bytes: 24381,
}

/** Where the binary sits inside the tarball. */
const TARBALL_MEMBER = 'package/dist/ort-wasm-simd-threaded.wasm'

/** How onnxruntime-common words a session that could not be created because no backend would initialize, which for this build means the WebAssembly engine refused to start. CAPTURE: `node --jitless` creating a session on the pinned 1.30.0 threw "no available backend found. ERR: [wasm] Error: WebAssembly SIMD is not supported in the current environment., [cpu] Error: previous call to 'initWasm()' failed."; tests/semantic_wasm_runtime_bundle_e2e.test.ts reproduces it against the built bundle. Any other failure to create a session is the model's or the moment's, and is not held against later runs. */
const BACKEND_START_FAILED = 'no available backend found'

let _webLoad: Promise<OrtWebModule> | null = null
let _inFlightWasm: Promise<Uint8Array> | null = null
/** Failures of {@link ensureWasmBinary} as they reach {@link loadWebRuntime}'s caller, which are about getting the binary rather than running it, so a fixed network is tried again at once instead of being held to a record. */
const _placeFailures = new WeakSet<object>()

/** The file's bytes when it is a regular file of exactly the pinned length and digest, else null. lstat first, so a FIFO or a symlink to something endless is refused before anything is read. */
function readVerified(filePath: string, file: PinnedFile): Buffer | null {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size !== file.bytes) return null
  const bytes = fs.readFileSync(filePath)
  if (bytes.length !== file.bytes) return null
  return createHash('sha256').update(bytes).digest('hex') === file.sha256 ? bytes : null
}

/** The verified `.wasm` bytes, downloading them once when they are not on this machine. Single-flight like ensureModelFiles, so concurrent embeds share one download. Re-verified on every load rather than trusted for having the right name. */
export function ensureWasmBinary(host: WebRuntimeHost): Promise<Uint8Array> {
  if (_inFlightWasm === null) {
    _inFlightWasm = (async () => {
      try {
        return await placeWasmBinary(host)
      } finally {
        _inFlightWasm = null
      }
    })()
  }
  return _inFlightWasm
}

/** The copy already under the data root, else one from the shared cache, else a download of the tarball it ships in. */
async function placeWasmBinary(host: WebRuntimeHost): Promise<Uint8Array> {
  ensureDataDirPrivate()
  const { dir, version, wasm } = host
  const target = path.join(dir, wasm.name)
  const cached = readVerified(target, wasm)
  if (cached) return cached
  // Present and wrong is worse than absent: every later load would fail the same way. Replace it.
  fs.rmSync(target, { force: true })
  ensureDirSync(dir)

  const shared = host.sharedDir
  // Ahead of the offline check on purpose: a hit here needs no network, so offline mode has no reason to refuse it.
  if (shared && (await copyFromSharedCache(shared, wasm, target))) {
    const copied = readVerified(target, wasm)
    if (copied) return copied
  }
  if (loadConfig().network.offline) {
    throw new Error(
      `Offline mode is on (network.offline): refusing to download the WebAssembly inference runtime (onnxruntime-web ${version}). ` +
        `Copy ${wasm.name} from that package's dist/ into ${dir} on a connected machine to use semantic search here.`,
    )
  }

  console.warn(
    `Downloading the embedding runtime, once (onnxruntime-web ${version} from registry.npmjs.org, ` +
      `${Math.round(ORT_WEB_TARBALL.bytes / 1024 / 1024)} MB, keeping its ${Math.round(wasm.bytes / 1024 / 1024)} MB ${wasm.name}) into ${dir}`,
  )
  const archive = path.join(dir, ORT_WEB_TARBALL.name)
  try {
    await downloadPinned(tarballUrl(), ORT_WEB_TARBALL, archive)
    await extractTarMember(archive, TARBALL_MEMBER, wasm, target)
  } finally {
    // The archive is only a carrier. Retries because Windows reports EPERM for a moment after a handle is closed.
    fs.rmSync(archive, { force: true, maxRetries: 20, retryDelay: 25 })
  }
  if (shared) host.publish(shared, wasm, target)
  const placed = readVerified(target, wasm)
  if (!placed) throw new Error(`${target} did not verify after extraction`)
  return placed
}

/** The one URL this module fetches. Every component is a constant. */
function tarballUrl(): string {
  return `https://registry.npmjs.org/onnxruntime-web/-/${ORT_WEB_TARBALL.name}`
}

/** Reads exact byte counts out of a stream of arbitrarily sized chunks. */
class ExactReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private ended = false

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.ended) {
      const next = await this.source.next()
      if (next.done === true) {
        this.ended = true
        break
      }
      this.chunks.push(next.value)
      this.buffered += next.value.length
    }
  }

  /** Exactly `n` bytes, or fewer only when the input ends first. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n)
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks)
    const out = all.subarray(0, n)
    const rest = all.subarray(out.length)
    this.chunks = rest.length > 0 ? [rest] : []
    this.buffered = rest.length
    return out
  }

  /** Discard exactly `n` bytes without holding them, or throw if the input ends first. */
  async skip(n: number): Promise<void> {
    let left = n
    while (left > 0) {
      if (this.buffered === 0) await this.fill(1)
      const head = this.chunks[0]
      if (head === undefined) throw new Error('archive ended inside an entry')
      if (head.length <= left) {
        this.chunks.shift()
        this.buffered -= head.length
        left -= head.length
      } else {
        this.chunks[0] = head.subarray(left)
        this.buffered -= left
        left = 0
      }
    }
  }
}

/** A NUL-terminated field of a tar header. */
function tarString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/** An octal number field of a tar header. The base-256 form is for sizes past 8 GiB, which nothing here is. */
function tarOctal(block: Buffer, start: number, length: number): number {
  if ((block[start]! & 0x80) !== 0) throw new Error('tar header uses a base-256 number, which this reader does not support')
  const text = tarString(block, start, length).trim()
  const value = text === '' ? 0 : Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar header holds an invalid number: ${JSON.stringify(text)}`)
  return value
}

/** The `path` record of a pax extended header, which overrides the next entry's name. */
function paxPath(data: Buffer): string | null {
  let at = 0
  let found: string | null = null
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(at, space).toString('latin1'), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > data.length) break
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq !== -1 && record.slice(0, eq) === 'path') found = record.slice(eq + 1)
    at += length
  }
  return found
}

/** Copy one regular-file member out of a gzipped tar archive to `target`, holding it to `file`'s pinned length and digest. The format is POSIX ustar with the pax and GNU long-name extensions npm tarballs use for paths past 100 characters (https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html); every header's checksum is verified before it is believed. Written here rather than taken from a tar package because it is the only archive this reads, and a dependency for it would be a runtime package every install carries. */
export async function extractTarMember(archive: string, member: string, file: PinnedFile, target: string): Promise<void> {
  const raw = fs.createReadStream(archive)
  const gunzip = createGunzip()
  raw.on('error', (e) => gunzip.destroy(e))
  raw.pipe(gunzip)
  const reader = new ExactReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>)
  try {
    let nextName: string | null = null
    for (;;) {
      const header = await reader.read(512)
      if (header.length < 512) throw new Error(`${archive} ended before its end-of-archive marker, without ${member}`)
      if (header.every((b) => b === 0)) throw new Error(`${archive} has no ${member}`)
      let sum = 0
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!
      if (sum !== tarOctal(header, 148, 8)) throw new Error(`${archive} has a tar header with a bad checksum`)

      const size = tarOctal(header, 124, 12)
      const padding = (512 - (size % 512)) % 512
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!)
      let name = tarString(header, 0, 100)
      // POSIX ustar's magic is "ustar\0". GNU tar's "ustar  \0" shares the first five bytes but keeps other fields at offset 345, so it is not read as a prefix.
      if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
        const prefix = tarString(header, 345, 155)
        if (prefix !== '') name = `${prefix}/${name}`
      }
      if (nextName !== null) {
        name = nextName
        nextName = null
      }

      if (type === 'x' || type === 'L') {
        const data = await reader.read(size)
        if (data.length < size) throw new Error(`${archive} ended inside an extended header`)
        await reader.skip(padding)
        nextName = type === 'x' ? paxPath(data) : tarString(data, 0, data.length)
        continue
      }
      if ((type === '0' || type === '7') && name === member) {
        if (size !== file.bytes) throw new Error(`${member} is ${size} bytes in ${archive}, expected the pinned ${file.bytes}`)
        const data = await reader.read(size)
        if (data.length !== file.bytes) throw new Error(`${archive} ended inside ${member}`)
        const digest = createHash('sha256').update(data).digest('hex')
        if (digest !== file.sha256) throw new Error(`${member} has sha256 ${digest}, expected the pinned ${file.sha256}`)
        const temp = `${target}.${process.pid}.partial`
        try {
          fs.writeFileSync(temp, data)
          fs.renameSync(temp, target)
        } catch (e) {
          fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
          throw e
        }
        return
      }
      await reader.skip(size + padding)
    }
  } finally {
    raw.destroy()
    gunzip.destroy()
  }
}

/** The glue module's file URL, after checking it is the one the pinned onnxruntime-web ships. In the built package it sits beside the bundle, where esbuild.config.mjs copies it; run from source, it is read out of the onnxruntime-web devDependency instead. */
function verifiedGlueUrl(version: string): string {
  const beside = fileURLToPath(new URL(`./${ORT_WEB_GLUE.name}`, import.meta.url))
  const file = fs.existsSync(beside) ? beside : _require.resolve(`onnxruntime-web/${ORT_WEB_GLUE.name}`)
  if (readVerified(file, ORT_WEB_GLUE) === null) {
    throw new Error(`${file} is not the ${ORT_WEB_GLUE.name} onnxruntime-web ${version} ships (pinned sha256 ${ORT_WEB_GLUE.sha256})`)
  }
  return pathToFileURL(file).href
}

/** Load the bundled onnxruntime-web once per process, with its binary and glue verified and its thread count set, ready for a first session. A failure is not kept here: the next call tries again, and {@link createWebSession} decides how long to hold one against it. */
function loadWebRuntime(threads: number, host: WebRuntimeHost): Promise<OrtWebModule> {
  if (_webLoad !== null) return _webLoad
  const pending = (async () => {
    const ort = (await import('onnxruntime-web')) as unknown as OrtWebModule
    if (ort.env.versions.web !== host.version) {
      throw new Error(`the bundled onnxruntime-web is ${ort.env.versions.web ?? 'unknown'}, but its binary is pinned for ${host.version}`)
    }
    const glue = verifiedGlueUrl(host.version)
    const binary = await ensureWasmBinary(host).catch((e: unknown) => {
      if (typeof e === 'object' && e !== null) _placeFailures.add(e)
      throw e
    })
    ort.env.wasm.wasmBinary = binary
    ort.env.wasm.wasmPaths = { mjs: glue }
    ort.env.wasm.numThreads = threads
    return ort
  })()
  _webLoad = pending
  pending.catch(() => {
    if (_webLoad === pending) _webLoad = null
  })
  return pending
}

/** A session for the model at `modelPath` on the WebAssembly build, started with its verified binary and glue (createInferenceSession in embed_runtime.ts, the only caller, says why the thread counts are what they are). A failure to place the binary is remembered in this process only. A failure to start, which is a version or glue mismatch at load or no backend initializing at create, is remembered here and recorded under `host.startFailure` for the processes after this one, and the first session that does start under the same key deletes that record. */
export async function createWebSession(
  modelPath: string,
  threads: number,
  host: WebRuntimeHost,
): Promise<{ session: OrtSession; Tensor: OrtTensorConstructor }> {
  let ort: OrtWebModule
  try {
    ort = await loadWebRuntime(threads, host)
  } catch (e) {
    if (typeof e === 'object' && e !== null && _placeFailures.has(e)) throw host.failed(e, false)
    throw startFailed(e, host)
  }
  let session: OrtSession
  try {
    session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads, interOpNumThreads: 1 })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(BACKEND_START_FAILED)) throw startFailed(e, host)
    throw e
  }
  try {
    // Only a record under this process's key is proved wrong by this start. One under another key (another Node, other flags) still describes the runtime there, and is ignored here anyway.
    const recorded = JSON.parse(fs.readFileSync(host.startFailure.path, 'utf8')) as { key?: unknown }
    if (recorded.key === host.startFailure.key) fs.rmSync(host.startFailure.path, { force: true })
  } catch {
    // No record, or one that cannot be read, which the reader ignores the same way.
  }
  return { session, Tensor: ort.Tensor }
}

/** Record a start failure for the processes after this one and remember it in this one. Remembered as a start failure only once the record is written, because embed_runtime.ts holds a start failure only while its record exists (so deleting the record retries even in a long-lived process); unwritable, it is remembered as a failure to place the binary is, for this process and its shorter hold, which is what there was before the record. */
function startFailed(e: unknown, host: WebRuntimeHost): Error {
  const message = e instanceof Error ? e.message : String(e)
  try {
    ensureDirSync(path.dirname(host.startFailure.path))
    atomicWriteText(host.startFailure.path, JSON.stringify({ key: host.startFailure.key, message, at: Date.now() }))
  } catch {
    return host.failed(e, false)
  }
  return host.failed(e, true)
}

registerReset(() => {
  _webLoad = null
  _inFlightWasm = null
})
