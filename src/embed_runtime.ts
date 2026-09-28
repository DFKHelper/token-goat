/** Which ONNX Runtime build runs the embedding model, and getting it running. Two builds can run the same graph. `onnxruntime-node` is ONNX Runtime's native Node binding: about 288 MB installed (301,642,703 bytes for 1.30.0, every platform's binaries included), so it is never installed for anyone; it is used when it resolves, which is when someone installed it themselves. Everyone else gets `onnxruntime-web`'s WebAssembly build, whose JavaScript esbuild inlines into the bundle and whose 14 MB `.wasm` binary is fetched once, on first use, into the same cache as the model weights. This file is deliberately outside EMBED_FINGERPRINT (scripts/parser-fingerprint.mjs): which runtime loaded, and at which version, is recorded in the vector-space half of the provenance stamp instead (backendId() in embeddings.ts), which discards and rebuilds the stored vectors when it changes. Hashing this file as well would re-embed every file on every machine for an edit to how a runtime is found. tests/guards/embed_runtime_is_unhashed.test.ts keeps it that way. Security posture of the `.wasm` download, the same one the model weights are held to (embed_model.ts): - The URL is built from constants in this file only: the npm registry's own tarball for one exact onnxruntime-web version. Nothing caller-supplied reaches it. - The tarball is held to a pinned SHA-256 and an exact byte length while it streams (pinned_file.ts), so an overrunning or altered response is refused before anything is read out of it. The pinned digest was taken from the published artifact, whose sha512 matches the registry's own `dist.integrity` for that version. - The one member used is held to its own pinned SHA-256 and length, on extraction and again on every load, and the bytes handed to the runtime are the bytes that were just verified rather than a path it reopens. - The small JavaScript glue the WebAssembly build loads by path (and starts its worker threads from) ships inside the package, beside the bundle, rather than being downloaded, and is checked against a pinned digest before use. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'

import { loadConfig } from './config.js'
import { dataDir, ensureDataDirPrivate } from './constants.js'
import { copyFromSharedCache, downloadPinned, publishToSharedCache, type PinnedFile } from './pinned_file.js'
import { registerReset } from './reset.js'
import { ensureDirSync } from './util.js'

const _require = createRequire(import.meta.url)

export type RuntimeName = 'onnxruntime-node' | 'onnxruntime-web'

/** The onnxruntime-web release whose JavaScript is bundled and whose binary is fetched. It must equal the exact devDependency version in package.json, because the bundled JavaScript, the glue and the binary only work as a set; tests/embed_runtime_pins.test.ts checks all three against the installed package. Bump deliberately, together with every digest below, and expect every index built on it to re-embed once, since backendId() keys vectors to its major.minor. */
export const ORT_WEB_VERSION = '1.30.0'

/** The npm registry tarball of onnxruntime-web at {@link ORT_WEB_VERSION}. CAPTURE: fetched from registry.npmjs.org on 2026-09-28; its sha512 equals the registry's `dist.integrity` (sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==) and its sha1 the registry's `dist.shasum`, so these are the published bytes. */
export const ORT_WEB_TARBALL: PinnedFile = {
  name: `onnxruntime-web-${ORT_WEB_VERSION}.tgz`,
  sha256: 'd2228df7e4616bc3348bf504ee888f3bec43789a273f0a63f3e68d203ce3bf71',
  bytes: 33106585,
}

/** The WebAssembly binary the Node build runs, as `package/dist/ort-wasm-simd-threaded.wasm` inside that tarball. CAPTURE: `sha256sum` over the member extracted from the tarball above, identical to the copy npm installed from the lock file. */
export const ORT_WEB_WASM: PinnedFile = {
  name: 'ort-wasm-simd-threaded.wasm',
  sha256: '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2',
  bytes: 14239897,
}

/** The glue module that instantiates the binary and that each worker thread loads by path. Ships beside the bundle (esbuild.config.mjs copies it into dist/). CAPTURE: `sha256sum` over `package/dist/ort-wasm-simd-threaded.mjs` from the tarball above. */
export const ORT_WEB_GLUE: PinnedFile = {
  name: 'ort-wasm-simd-threaded.mjs',
  sha256: 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b',
  bytes: 24381,
}

/** Where {@link ORT_WEB_WASM} sits inside the tarball. */
const TARBALL_MEMBER = `package/dist/${ORT_WEB_WASM.name}`

/** How long a failed attempt to get the WebAssembly runtime running is remembered before the next one. While it is remembered the runtime reports itself unavailable, so indexing records files as skipped for want of a runtime (and re-embeds them once it is back) instead of every file in a walk starting its own download; a new process, which is what each `token-goat index` is, always tries afresh. */
const WEB_RETRY_AFTER_MS = 10 * 60 * 1000

/** The other way to get embeddings running, which needs no download from token-goat at all. */
export const NATIVE_RUNTIME_INSTALL = 'install the native runtime with: npm install -g onnxruntime-node (drop -g if token-goat is a project dependency)'

/** Said wherever the runtime is reported unavailable, because the fix is one of these two. */
export const RUNTIME_UNAVAILABLE_ADVICE =
  `The WebAssembly runtime is downloaded once from registry.npmjs.org (onnxruntime-web ${ORT_WEB_VERSION}), so check network access and network.offline; ` +
  `or ${NATIVE_RUNTIME_INSTALL}`

/** What ONNX Runtime hands back from a session run, narrowed to the parts the model uses. */
export interface OrtTensor {
  readonly dims: readonly number[]
  readonly data: ArrayLike<number>
}
export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
}
export type OrtTensorConstructor = new (type: string, data: BigInt64Array, dims: number[]) => unknown

/** The subset of ONNX Runtime's session options this module sets. See {@link createInferenceSession}. */
interface OrtSessionOptions {
  intraOpNumThreads: number
  interOpNumThreads: number
}

/** The part of either build's module this uses. Both export the same API, from onnxruntime-common. */
interface OrtModule {
  InferenceSession: { create(modelPath: string, options?: OrtSessionOptions): Promise<OrtSession> }
  Tensor: OrtTensorConstructor
}

/** The WebAssembly build's global settings, which have to be in place before its first session is created. */
interface OrtWebModule extends OrtModule {
  env: {
    versions: { web?: string }
    wasm: {
      wasmBinary?: Uint8Array
      wasmPaths?: string | { mjs?: string; wasm?: string }
      numThreads?: number
    }
  }
}

// onnxruntime-node is loaded on first use rather than at module load. It is a native addon: requiring it eagerly loads its DLLs into the process, and this module is reachable from the CLI's hot hook path via index_prune.ts, which never embeds anything.
let _chosen: RuntimeName | null = null
let _nodeOrt: OrtModule | null = null
let _nodeError: Error | null = null
let _webLoad: Promise<OrtWebModule> | null = null
let _webFailure: { readonly error: Error; readonly at: number } | null = null
let _inFlightWasm: Promise<Uint8Array> | null = null

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** Pick the runtime once per process: the native binding when it resolves and loads, otherwise the bundled WebAssembly build. A native binding that is installed but throws (a wrong-architecture binary, a missing DLL) falls through to the WebAssembly build too, so semantic search keeps working; {@link nativeRuntimeLoadError} keeps the reason for `doctor`. */
function chooseRuntime(): RuntimeName {
  if (_chosen !== null) return _chosen
  try {
    _nodeOrt = _require('onnxruntime-node') as OrtModule
    _chosen = 'onnxruntime-node'
  } catch (e) {
    _nodeError = asError(e)
    _chosen = 'onnxruntime-web'
  }
  return _chosen
}

/** The failure of the last attempt to get the WebAssembly runtime running, while it is still being remembered. */
function recentWebFailure(): Error | null {
  if (_webFailure === null) return null
  if (Date.now() - _webFailure.at >= WEB_RETRY_AFTER_MS) {
    _webFailure = null
    return null
  }
  return _webFailure.error
}

/** Which runtime computes the vectors in this process. */
export function activeRuntime(): RuntimeName {
  return chooseRuntime()
}

/** Why the native binding is not the one in use, or null when it is. `doctor` separates "not installed" (MODULE_NOT_FOUND) from "installed but throwing", which need different fixes. */
export function nativeRuntimeLoadError(): Error | null {
  chooseRuntime()
  return _nodeError
}

/** Whether embedding can run right now. The native binding is available once it has loaded; the WebAssembly build is available unless its last attempt to start failed recently, in which case the answer stays false until {@link WEB_RETRY_AFTER_MS} has passed. It says nothing about the `.wasm` or the model being on disk yet, which resolves itself by downloading them. */
export function isRuntimeAvailable(): boolean {
  if (chooseRuntime() === 'onnxruntime-node') return true
  return recentWebFailure() === null
}

/** Why embedding cannot run right now, or null when it can. See {@link isRuntimeAvailable}. */
export function runtimeLoadError(): Error | null {
  if (chooseRuntime() === 'onnxruntime-node') return null
  return recentWebFailure()
}

/** The active runtime's version, or 'unknown'. For the WebAssembly build it is the pinned {@link ORT_WEB_VERSION}, which loading checks the bundled JavaScript against. onnxruntime-node exports no version of its own, so for it this reads the package.json beside whatever `onnxruntime-node` resolves to. It deliberately does not require the package.json by subpath: that depends on the package not restricting its `exports` map, and tests/guards/semantic_deps.test.ts reads require strings out of src/ as declared dependency names, so a subpath there reads as an undeclared package. (That guard scans text, so this paragraph does not spell the call out either -- naming it would fail the check it is explaining.) */
export function runtimeVersion(): string {
  if (chooseRuntime() === 'onnxruntime-web') return ORT_WEB_VERSION
  try {
    let dir = path.dirname(_require.resolve('onnxruntime-node'))
    for (let depth = 0; depth < 6; depth++) {
      const manifest = path.join(dir, 'package.json')
      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
        if (parsed.name === 'onnxruntime-node' && typeof parsed.version === 'string') return parsed.version
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  } catch {
    // Fall through: an unreadable manifest is worth reporting as unknown, not worth throwing over.
  }
  return 'unknown'
}

/** Where the verified `.wasm` lives. Under the data root beside the model weights, so `uninstall --purge` takes it too. */
export function wasmDir(): string {
  return path.join(dataDir(), 'models', 'onnxruntime-web', ORT_WEB_VERSION)
}

/** The shared copy {@link ORT_WEB_WASM} can be placed from, under the same `TOKEN_GOAT_MODEL_CACHE_DIR` the model weights use (see sharedModelCacheDir in embed_model.ts), or null when that is not set. Nothing is trusted for being here: a copy is held to the same digest as a download. */
function sharedWasmCacheDir(): string | null {
  const raw = process.env['TOKEN_GOAT_MODEL_CACHE_DIR']?.trim()
  if (!raw) return null
  return path.join(raw, 'onnxruntime-web', ORT_WEB_VERSION)
}

/** Is the `.wasm` already on this machine, so {@link ensureWasmBinary} would place it without the network? Size only, like modelFilesPresent: the digest is checked by the code that uses the file. */
export function wasmBinaryPresent(): boolean {
  const roots = [wasmDir(), sharedWasmCacheDir()].filter((d): d is string => d !== null)
  return roots.some((root) => {
    try {
      return fs.statSync(path.join(root, ORT_WEB_WASM.name)).size === ORT_WEB_WASM.bytes
    } catch {
      return false
    }
  })
}

/** The file's bytes when it is a regular file of exactly the pinned length and digest, else null. lstat first, so a FIFO or a symlink to something endless is refused before anything is read. */
function readVerified(filePath: string, file: PinnedFile): Buffer | null {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false })
  if (!info?.isFile() || info.size !== file.bytes) return null
  const bytes = fs.readFileSync(filePath)
  if (bytes.length !== file.bytes) return null
  return createHash('sha256').update(bytes).digest('hex') === file.sha256 ? bytes : null
}

/** The verified `.wasm` bytes, downloading them once when they are not on this machine. Single-flight like ensureModelFiles, so concurrent embeds share one download. Re-verified on every load rather than trusted for having the right name. */
export function ensureWasmBinary(): Promise<Uint8Array> {
  if (_inFlightWasm === null) {
    _inFlightWasm = (async () => {
      try {
        return await placeWasmBinary()
      } finally {
        _inFlightWasm = null
      }
    })()
  }
  return _inFlightWasm
}

async function placeWasmBinary(): Promise<Uint8Array> {
  ensureDataDirPrivate()
  const dir = wasmDir()
  const target = path.join(dir, ORT_WEB_WASM.name)
  const cached = readVerified(target, ORT_WEB_WASM)
  if (cached) return cached
  // Present and wrong is worse than absent: every later load would fail the same way. Replace it.
  fs.rmSync(target, { force: true })
  ensureDirSync(dir)

  const shared = sharedWasmCacheDir()
  // Ahead of the offline check on purpose: a hit here needs no network, so offline mode has no reason to refuse it.
  if (shared && (await copyFromSharedCache(shared, ORT_WEB_WASM, target))) {
    const copied = readVerified(target, ORT_WEB_WASM)
    if (copied) return copied
  }
  if (loadConfig().network.offline) {
    throw new Error(
      `Offline mode is on (network.offline): refusing to download the WebAssembly inference runtime (onnxruntime-web ${ORT_WEB_VERSION}). ` +
        `Copy ${ORT_WEB_WASM.name} from that package's dist/ into ${dir} on a connected machine to use semantic search here.`,
    )
  }

  console.warn(
    `Downloading the embedding runtime, once (onnxruntime-web ${ORT_WEB_VERSION} from registry.npmjs.org, ` +
      `${Math.round(ORT_WEB_TARBALL.bytes / 1024 / 1024)} MB, keeping its ${Math.round(ORT_WEB_WASM.bytes / 1024 / 1024)} MB ${ORT_WEB_WASM.name}) into ${dir}`,
  )
  const archive = path.join(dir, ORT_WEB_TARBALL.name)
  try {
    await downloadPinned(tarballUrl(), ORT_WEB_TARBALL, archive)
    await extractTarMember(archive, TARBALL_MEMBER, ORT_WEB_WASM, target)
  } finally {
    // The archive is only a carrier. Retries because Windows reports EPERM for a moment after a handle is closed.
    fs.rmSync(archive, { force: true, maxRetries: 20, retryDelay: 25 })
  }
  if (shared) publishToSharedCache(shared, ORT_WEB_WASM, target)
  const placed = readVerified(target, ORT_WEB_WASM)
  if (!placed) throw new Error(`${target} did not verify after extraction`)
  return placed
}

/** The one URL this module fetches. Every component is a constant above. */
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

/** The glue module's file URL, after checking it is the one {@link ORT_WEB_VERSION} ships. In the built package it sits beside the bundle, where esbuild.config.mjs copies it; run from source, it is read out of the onnxruntime-web devDependency instead. */
function verifiedGlueUrl(): string {
  const beside = fileURLToPath(new URL(`./${ORT_WEB_GLUE.name}`, import.meta.url))
  const file = fs.existsSync(beside) ? beside : _require.resolve(`onnxruntime-web/${ORT_WEB_GLUE.name}`)
  if (readVerified(file, ORT_WEB_GLUE) === null) {
    throw new Error(`${file} is not the ${ORT_WEB_GLUE.name} onnxruntime-web ${ORT_WEB_VERSION} ships (pinned sha256 ${ORT_WEB_GLUE.sha256})`)
  }
  return pathToFileURL(file).href
}

/** Load the WebAssembly build once per process, with its binary and glue verified and its thread count set. A failure is remembered for {@link WEB_RETRY_AFTER_MS}; see there. */
function loadWebRuntime(threads: number): Promise<OrtWebModule> {
  if (_webLoad !== null) return _webLoad
  const pending = (async () => {
    const remembered = recentWebFailure()
    if (remembered) throw remembered
    try {
      const ort = (await import('onnxruntime-web')) as unknown as OrtWebModule
      if (ort.env.versions.web !== ORT_WEB_VERSION) {
        throw new Error(`the bundled onnxruntime-web is ${ort.env.versions.web ?? 'unknown'}, but its binary is pinned for ${ORT_WEB_VERSION}`)
      }
      const glue = verifiedGlueUrl()
      const binary = await ensureWasmBinary()
      ort.env.wasm.wasmBinary = binary
      ort.env.wasm.wasmPaths = { mjs: glue }
      ort.env.wasm.numThreads = threads
      return ort
    } catch (e) {
      const error = asError(e)
      _webFailure = { error, at: Date.now() }
      throw error
    }
  })()
  _webLoad = pending
  pending.catch(() => {
    if (_webLoad === pending) _webLoad = null
  })
  return pending
}

/** Create an inference session for the model at `modelPath` on the active runtime. Never create one bare. ONNX Runtime sizes its intra-op pool to the host when no count is given, and that pool is what every `run()` fans out across: measured on a 26-logical-core machine, `create()` with no options took the process from 13 OS threads to 30, while the same model with an explicit count added none. Indexing is background work -- a detached daemon draining a queue, or a bulk walk the user started and then went back to their editor -- so it takes a small, fixed share of the machine and finishes later, rather than most of the machine and finishes sooner. `interOpNumThreads` is 1 because the graph is run one sequence at a time (see EmbeddingModel.embed), so there are no parallel branches for a second scheduler to place. The WebAssembly build takes its count from `env.wasm.numThreads` instead, set to the same value in {@link loadWebRuntime}, since it runs its pool as worker threads started before any session exists. */
export async function createInferenceSession(
  modelPath: string,
  threads: number,
): Promise<{ session: OrtSession; Tensor: OrtTensorConstructor }> {
  const ort: OrtModule = chooseRuntime() === 'onnxruntime-node' ? (_nodeOrt as OrtModule) : await loadWebRuntime(threads)
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  })
  return { session, Tensor: ort.Tensor }
}

registerReset(() => {
  _chosen = null
  _nodeOrt = null
  _nodeError = null
  _webLoad = null
  _webFailure = null
  _inFlightWasm = null
})
