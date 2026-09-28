/** Which ONNX Runtime build runs the embedding model, and getting it running. Two builds can run the same graph. `onnxruntime-node` is ONNX Runtime's native Node binding: about 288 MB installed (301,642,703 bytes for 1.30.0, every platform's binaries included), so it is never installed for anyone; it is used when it resolves, which is when someone installed it themselves. Everyone else gets `onnxruntime-web`'s WebAssembly build, whose JavaScript esbuild inlines into the bundle and whose 14 MB `.wasm` binary is fetched once, on first use, into the same cache as the model weights. This file is deliberately outside EMBED_FINGERPRINT (scripts/parser-fingerprint.mjs): which runtime loaded, and at which version, is recorded in the vector-space half of the provenance stamp instead (backendId() in embeddings.ts), which discards and rebuilds the stored vectors when it changes. Hashing this file as well would re-embed every file on every machine for an edit to how a runtime is found. tests/guards/embed_runtime_is_unhashed.test.ts keeps it that way. Placing, downloading and starting the WebAssembly build live in embed_runtime_web.ts, which this reaches only through a dynamic import when a session is created, so none of it is parsed on the hook path; its header sets out how that download is secured. */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dataDir } from './constants.js'
import type { WebRuntimeHost } from './embed_runtime_web.js'
import { publishToSharedCache, type PinnedFile } from './pinned_file.js'
import { registerReset } from './reset.js'

const _require = createRequire(import.meta.url)

export type RuntimeName = 'onnxruntime-node' | 'onnxruntime-web'

/** The onnxruntime-web release whose JavaScript is bundled and whose binary is fetched. It must equal the exact devDependency version in package.json, because the bundled JavaScript, the glue and the binary only work as a set; tests/embed_runtime_pins.test.ts checks all three against the installed package. Bump deliberately, together with every digest below, and expect every index built on it to re-embed once, since backendId() keys vectors to its major.minor. */
export const ORT_WEB_VERSION = '1.30.0'

/** The WebAssembly binary the Node build runs, as `package/dist/ort-wasm-simd-threaded.wasm` inside that tarball. CAPTURE: `sha256sum` over the member extracted from the tarball above, identical to the copy npm installed from the lock file. */
export const ORT_WEB_WASM: PinnedFile = {
  name: 'ort-wasm-simd-threaded.wasm',
  sha256: '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2',
  bytes: 14239897,
}

/** How long a failed attempt to get the WebAssembly runtime running is remembered before the next one. While it is remembered the runtime reports itself unavailable, so indexing records files as skipped for want of a runtime (and re-embeds them once it is back) instead of every file in a walk starting its own download. A failure to place the binary (a download that did not complete, offline mode) is kept in this process only, so the next process, which is what each `token-goat index` is, tries afresh; a failure to start is kept on disk as well, for {@link START_FAILURE_HOLD_MS}. */
const WEB_RETRY_AFTER_MS = 10 * 60 * 1000

/** How long a failure of the WebAssembly runtime to start (the binary was in hand, and the bundled JavaScript or the engine under it refused to run it, as `node --jitless` or a Node without WebAssembly SIMD does) is held against every process that shares the data root. Kept only in memory, it was invisible to the next process: the worker's embeds failed while `semantic --preflight` and `doctor`, which only ask and never start the runtime, reported it ready. Such a failure repeats until something changes, so the record carries a key naming what could change it (see startFailureKey) and is ignored the moment the key differs; the day is for a cause the key cannot see, and deleting the record, which the reported reason names, retries at once. */
const START_FAILURE_HOLD_MS = 24 * 60 * 60 * 1000

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
export interface OrtWebModule extends OrtModule {
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
let _webFailure: { readonly error: Error; readonly at: number; readonly started: boolean } | null = null
let _recordChecked = false

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

/** The failure of the last attempt to get the WebAssembly runtime running, while it is still being remembered: this process's own, else a start failure another process recorded under the same key (read once per process). */
function recentWebFailure(): Error | null {
  if (_webFailure === null && !_recordChecked) {
    _recordChecked = true
    _webFailure = recordedStartFailure()
  }
  if (_webFailure === null) return null
  // A start failure stands only while its record does, so deleting the record retries in a long-lived process too, such as the resident hook server that answers `semantic`.
  if (Date.now() - _webFailure.at >= (_webFailure.started ? START_FAILURE_HOLD_MS : WEB_RETRY_AFTER_MS) || (_webFailure.started && !fs.existsSync(startFailurePath()))) {
    _webFailure = null
    return null
  }
  return _webFailure.error
}

/** Where a start failure is recorded: beside the binary it concerns, so a new ORT_WEB_VERSION, a new data root and `uninstall --purge` each leave it behind. */
function startFailurePath(): string {
  return path.join(wasmDir(), 'start-failure.json')
}

/** NODE_OPTIONS as this process started with it. Read at module load, not when a key is built: the resident hook server runs each request with its caller's environment swapped in (swapEnv in batch_serve.ts), while the flags V8 runs under are the ones the server itself started with, and the server loads this module before it takes a request. */
const NODE_OPTIONS_AT_START = process.env['NODE_OPTIONS'] ?? ''

/** Everything whose change could make a runtime that failed to start run: the pinned runtime and binary, this token-goat build (the size and modification time of the file this is bundled into, which any reinstall rewrites), and the Node that ran it with its flags. */
function startFailureKey(): string {
  let build = ''
  try {
    const self = fs.statSync(fileURLToPath(import.meta.url))
    build = `${self.size}:${self.mtimeMs}`
  } catch {
    // Unreadable is still a key; it just cannot tell two builds apart.
  }
  return JSON.stringify([ORT_WEB_VERSION, ORT_WEB_WASM.sha256, build, process.execPath, process.version, process.platform, process.arch, process.execArgv, NODE_OPTIONS_AT_START])
}

/** A start failure recorded under the current key, as this process's own, or null. Fail-soft: a missing, unreadable or foreign record is no record. */
function recordedStartFailure(): { error: Error; at: number; started: true } | null {
  const file = startFailurePath()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { key?: unknown; message?: unknown; at?: unknown }
    if (parsed.key !== startFailureKey() || typeof parsed.message !== 'string' || typeof parsed.at !== 'number') return null
    const when = new Date(parsed.at).toISOString()
    return {
      error: new Error(`${parsed.message} (in an earlier run, at ${when}; it is tried again once Node, its flags or token-goat change, or a day after, and deleting ${file} tries it at once)`),
      at: parsed.at,
      started: true,
    }
  } catch {
    return null
  }
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
export function sharedWasmCacheDir(): string | null {
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

/** The verified `.wasm` bytes, downloading them once when they are not on this machine. See ensureWasmBinary in embed_runtime_web.ts, which does the work behind a dynamic import. */
export async function ensureWasmBinary(): Promise<Uint8Array> {
  return (await import('./embed_runtime_web.js')).ensureWasmBinary(webHost())
}

/** What embed_runtime_web.ts is given instead of importing it; see WebRuntimeHost there. */
function webHost(): WebRuntimeHost {
  return {
    version: ORT_WEB_VERSION,
    wasm: ORT_WEB_WASM,
    dir: wasmDir(),
    sharedDir: sharedWasmCacheDir(),
    publish: publishToSharedCache,
    startFailure: { path: startFailurePath(), key: startFailureKey() },
    failed(e: unknown, started: boolean): Error {
      const error = asError(e)
      _webFailure = { error, at: Date.now(), started }
      return error
    },
  }
}

/** Create an inference session for the model at `modelPath` on the active runtime. Never create one bare. ONNX Runtime sizes its intra-op pool to the host when no count is given, and that pool is what every `run()` fans out across: measured on a 26-logical-core machine, `create()` with no options took the process from 13 OS threads to 30, while the same model with an explicit count added none. Indexing is background work -- a detached daemon draining a queue, or a bulk walk the user started and then went back to their editor -- so it takes a small, fixed share of the machine and finishes later, rather than most of the machine and finishes sooner. `interOpNumThreads` is 1 because the graph is run one sequence at a time (see EmbeddingModel.embed), so there are no parallel branches for a second scheduler to place. The WebAssembly build takes its count from `env.wasm.numThreads` instead, set to the same value when createWebSession in embed_runtime_web.ts starts it, since it runs its pool as worker threads started before any session exists. A failure of the WebAssembly build to get running is remembered (see {@link WEB_RETRY_AFTER_MS} and {@link START_FAILURE_HOLD_MS}), and while it is, this throws it without trying again. */
export async function createInferenceSession(
  modelPath: string,
  threads: number,
): Promise<{ session: OrtSession; Tensor: OrtTensorConstructor }> {
  if (chooseRuntime() === 'onnxruntime-node') {
    const ort = _nodeOrt as OrtModule
    return { session: await ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads, interOpNumThreads: 1 }), Tensor: ort.Tensor }
  }
  const remembered = recentWebFailure()
  if (remembered) throw remembered
  return (await import('./embed_runtime_web.js')).createWebSession(modelPath, threads, webHost())
}

registerReset(() => {
  _chosen = null
  _nodeOrt = null
  _nodeError = null
  _webFailure = null
  _recordChecked = false
})
