/** The embedding backend: fetch the pinned model, verify it, run it, pool it. This replaces `@xenova/transformers`, which had not shipped a release since May 2024, so its advisories have no forward patch. What it did for us was three separable things -- tokenize, run an ONNX graph, mean-pool the result -- and all three are here. Which ONNX Runtime build runs the graph (the native `onnxruntime-node` when it is installed, otherwise the bundled WebAssembly build) is embed_runtime.ts's business, deliberately outside this file: this one is hashed into EMBED_FINGERPRINT, and the runtime's identity is already recorded in the provenance stamp. Measured standalone in a throwaway directory, not read off a badge: `onnxruntime-node@1.27.0` installs 17 packages and reports 2 high advisories; `@xenova/transformers@2.17.2` installs 80 and reports 5, one of them critical. The two are both GHSA-xcpc-8h2w-3j85 in `adm-zip`, which onnxruntime-node uses in its own postinstall script to unpack the prebuilt binary it just fetched -- never on anything a user or this file hands it. This repository pins `adm-zip` past it with an `overrides` entry, and npm applies overrides only in the root project, so someone who opts in with `npm install -g onnxruntime-node` still resolves the 0.5 line and still sees those two. SECURITY.md says so rather than rounding it to clean. Security posture of the download, which is the only part that touches the network: - Every component of the URL is a constant in this file. There is no caller-supplied repository, revision, filename or hostname anywhere in the path. `huggingface.co` accepts uploads from anyone, so trusting the hostname is not enough on its own -- that is exactly the shape of CVE-2026-54316, where allowlisting the host let an attacker serve whatever they liked from a path under it. - The revision is an immutable commit, not a branch, so the bytes cannot change under us. - Every file is checked against a sha256 recorded here, on download AND on every load, and the exact byte length is enforced while the body streams so a hostile or broken response cannot spend the disk before the digest gets a chance to reject it. The digest is the trust anchor, which is why following redirects (HuggingFace redirects `resolve` to its CDN) is safe. - A model other than the pinned one is refused rather than downloaded unverified. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadConfig } from './config.js'
import { dataDir, ensureDataDirPrivate } from './constants.js'
import { ensureDirSync } from './util.js'
import { BertWordPiece } from './embed_tokenizer.js'
import { NATIVE_RUNTIME_INSTALL, ORT_WEB_WASM, RUNTIME_UNAVAILABLE_ADVICE, activeRuntime, createInferenceSession, isRuntimeAvailable, runtimeLoadError, runtimeVersion, wasmBinaryPresent, wasmDir, type OrtSession, type RuntimeName } from './embed_runtime.js'
import { copyFromSharedCache, downloadPinned, publishToSharedCache, sha256Of, type PinnedFile } from './pinned_file.js'
import { registerReset } from './reset.js'
import { fencedCommand, quotedArg } from './hint_suggestion_guard.js'

/** BAAI/bge-small-en-v1.5, the smallest BGE checkpoint tuned for retrieval. The 384-dimension output is native to it: changing either of these means every stored vector has to be rebuilt, which is what the embedding_provenance stamp in db.ts detects. */
export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
export const DEFAULT_DIM = 384

/** Mirrors `worker.embed_threads`'s default in config_defaults.ts, for callers that mock a partial config. */
export const DEFAULT_EMBED_THREADS = 4

/** The immutable commit this model is pinned to, so a cold cache fetches known-good weights instead of trusting a branch that can move. Read from https://huggingface.co/api/models/Xenova/bge-small-en-v1.5 ("sha") on 2026-08-12; the model itself was last updated 2025-07-22. Bump deliberately, together with the digests below, and expect every index on the machine to rebuild itself once. */
export const PINNED_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'

/** One file of the pinned model, with the size and digest its bytes must have. `name` is its path within the repository, and within our own cache directory. */
type ModelFile = PinnedFile

/** Everything the model needs, and nothing else. Recorded by hand from the pinned revision: `sha256sum` over the files as fetched on 2026-08-22. */
const MODEL_FILES: readonly ModelFile[] = [
  {
    name: 'tokenizer.json',
    sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    bytes: 711396,
  },
  {
    name: 'onnx/model_quantized.onnx',
    sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    bytes: 34014426,
  },
]

/** Where the verified model files live. Under the data root, so `uninstall --purge` takes them too. */
export function modelDir(): string {
  return path.join(dataDir(), 'models', ...DEFAULT_MODEL.split('/'), PINNED_MODEL_REVISION)
}

/** Is every pinned model file already on this machine, so {@link ensureModelFiles} would place it without reaching the network? Both locations count, because both make the fetch unnecessary: the data root's own copy, and the shared cache {@link sharedModelCacheDir} names, which is copied from rather than downloaded. Size only, deliberately: the sha256 of each file is verified by the code that places it, and re-hashing 33 MB just to answer "would this need the network" would cost more than the question is worth. A file of the right size that fails its digest is still discarded and refetched there. This answers a question `isRuntimeAvailable()` does not: the runtime can load perfectly well while the weights are absent, which is the state a fresh checkout is in. */
export function modelFilesPresent(): boolean {
  const roots = [modelDir(), sharedModelCacheDir()].filter((d): d is string => d !== null)
  return roots.some((root) =>
    MODEL_FILES.every((file) => {
      try {
        return fs.statSync(path.join(root, file.name)).size === file.bytes
      } catch {
        return false
      }
    }),
  )
}

/** The one URL shape this module will fetch. Every component is a constant above. */
function downloadUrl(file: ModelFile): string {
  return `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/${file.name}`
}

/** A copy of the pinned model that outlives the data directory, or null when the feature is off. {@link modelDir} sits under the data root, which is exactly what makes it wrong as the only copy in two situations: a test run pins the data root at a fresh temp directory per worker, and several tests build their own data roots on top of that, so one CI run downloaded the 32 MB weights 57 times into 57 directories. Point this at a stable path and each of those becomes a local file copy instead of a network fetch. Reading from here is safe even if the directory is hostile: nothing is trusted on the strength of its location. Bytes copied out of it are hashed and compared against the same pinned sha256 a download is held to, and a file that fails is discarded and refetched, so the worst a bad cache can do is cost the download it was meant to save. */
function sharedModelCacheDir(): string | null {
  const raw = process.env['TOKEN_GOAT_MODEL_CACHE_DIR']?.trim()
  if (!raw) return null
  return path.join(raw, ...DEFAULT_MODEL.split('/'), PINNED_MODEL_REVISION)
}

/** Fetch one model file to its final path, or throw. The URL is the only thing this adds to {@link downloadPinned}, which holds the bytes to the pinned length and digest. */
function download(file: ModelFile, target: string): Promise<void> {
  return downloadPinned(downloadUrl(file), file, target)
}

let _inFlightModelDownload: Promise<string> | null = null

/** Make sure every model file is present and is the file it claims to be, downloading what is missing. Returns the directory holding them. Safe across concurrent calls: multiple callers racing to download the model share a single in-flight promise instead of initiating duplicate concurrent downloads or clashing on temporary files. Cached files are re-verified on every load rather than trusted for having the right name: hashing 33 MB costs a fraction of what loading the graph costs anyway, and the alternative is a marker file recording that a check once passed, which is a record of the past rather than a check. */
export function ensureModelFiles(modelName: string = DEFAULT_MODEL): Promise<string> {
  if (modelName !== DEFAULT_MODEL) {
    return Promise.reject(
      new Error(
        `Only ${DEFAULT_MODEL} is supported: its files are pinned to a revision and to a sha256 each, ` +
          `and "${modelName}" has neither, so there would be nothing to check the download against.`,
      ),
    )
  }

  if (_inFlightModelDownload !== null) {
    return _inFlightModelDownload
  }

  _inFlightModelDownload = (async () => {
    try {
      return await _ensureModelFilesInner(modelName)
    } finally {
      _inFlightModelDownload = null
    }
  })()

  return _inFlightModelDownload
}

async function _ensureModelFilesInner(_modelName: string): Promise<string> {
  ensureDataDirPrivate()
  const dir = modelDir()
  const offline = loadConfig().network.offline
  const shared = sharedModelCacheDir()

  for (const file of MODEL_FILES) {
    const target = path.join(dir, file.name)
    if (fs.existsSync(target)) {
      const digest = await sha256Of(target)
      if (digest === file.sha256) continue
      // A file that is present and wrong is worse than one that is absent: leaving it would make every later run fail the same way. Replace it, which offline mode cannot do.
      fs.rmSync(target, { force: true })
    }
    if (shared) {
      ensureDirSync(path.dirname(target))
      // Ahead of the offline check on purpose: a hit here needs no network, so offline mode has no reason to refuse it.
      if (await copyFromSharedCache(shared, file, target)) continue
    }
    if (offline) {
      throw new Error(
        `Offline mode is on (network.offline): refusing to download ${file.name} for the embedding model. ` +
          `Copy the pinned files into ${dir} on a connected machine to use semantic search here.`,
      )
    }
    ensureDirSync(path.dirname(target))
    console.warn(
      `Downloading the embedding model, once (${file.name}, ${Math.round(file.bytes / 1024 / 1024)} MB) into ${dir}`,
    )
    await download(file, target)
    if (shared) publishToSharedCache(shared, file, target)
  }
  return dir
}

/** Mean-pool a [1, seq, dim] hidden state over the sequence, then scale to unit length. */
function poolAndNormalize(hidden: ArrayLike<number>, seq: number, dim: number): Float32Array {
  const pooled = new Float64Array(dim)
  for (let t = 0; t < seq; t++) {
    const base = t * dim
    for (let d = 0; d < dim; d++) pooled[d] = (pooled[d] ?? 0) + (hidden[base + d] ?? 0)
  }
  let sumOfSquares = 0
  for (let d = 0; d < dim; d++) {
    const mean = (pooled[d] ?? 0) / seq
    pooled[d] = mean
    sumOfSquares += mean * mean
  }
  // A zero-length vector cannot be scaled to unit length, and dividing anyway fills it with NaN, which sqlite-vec reports as no distance at all -- nearer than everything, top of every search. Leave it as zeroes and let embedTexts' finite check reject it as the failure it is.
  const norm = Math.sqrt(sumOfSquares)
  const out = new Float32Array(dim)
  if (norm === 0 || !Number.isFinite(norm)) return out
  for (let d = 0; d < dim; d++) out[d] = (pooled[d] ?? 0) / norm
  return out
}

/** One loaded model: a tokenizer and a session, ready to embed. */
export class EmbeddingModel {
  private constructor(
    private readonly tokenizer: BertWordPiece,
    private readonly session: OrtSession,
    private readonly tensorFactory: new (type: string, data: BigInt64Array, dims: number[]) => unknown,
  ) {}

  static async load(modelName: string = DEFAULT_MODEL): Promise<EmbeddingModel> {
    if (!isRuntimeAvailable()) {
      throw new Error(`the inference runtime is not available: ${runtimeLoadError()?.message ?? 'unknown error'}`)
    }
    const dir = await ensureModelFiles(modelName)
    const tokenizer = BertWordPiece.fromJson(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'))
    // The `??` mirrors worker.ts's fallback: several tests mock loadConfig() with a partial worker section, and a bare read would hand ORT `undefined`. Why the count is passed at all is on createInferenceSession.
    const threads = loadConfig().worker.embed_threads ?? DEFAULT_EMBED_THREADS
    const { session, Tensor } = await createInferenceSession(path.join(dir, 'onnx', 'model_quantized.onnx'), threads)
    return new EmbeddingModel(tokenizer, session, Tensor)
  }

  /** Wordpieces `text` becomes under this model's own tokenizer, markers excluded. */
  countTokens(text: string): number {
    return this.tokenizer.countTokens(text)
  }

  /** Embed one text. Sequences are run singly, so there is no padding and no mask to get wrong. */
  async embed(text: string): Promise<Float32Array> {
    const ids = this.tokenizer.encode(text)
    const length = ids.length
    const feeds: Record<string, unknown> = {
      input_ids: new this.tensorFactory('int64', BigInt64Array.from(ids, BigInt), [1, length]),
      attention_mask: new this.tensorFactory('int64', new BigInt64Array(length).fill(1n), [1, length]),
    }
    // BERT exports usually declare token_type_ids and some do not; passing an input the graph did not declare is an error, so follow what this session says it takes.
    if (this.session.inputNames.includes('token_type_ids')) {
      feeds['token_type_ids'] = new this.tensorFactory('int64', new BigInt64Array(length), [1, length])
    }

    const outputName = this.session.outputNames[0]
    if (outputName === undefined) throw new Error('the model declares no outputs')
    const output = (await this.session.run(feeds))[outputName]
    if (!output) throw new Error(`the model produced no ${outputName}`)

    const [, seq, dim] = output.dims
    if (seq === undefined || dim === undefined) {
      throw new Error(`expected a [batch, sequence, dimension] output, got [${output.dims.join(', ')}]`)
    }
    if (dim !== DEFAULT_DIM) {
      throw new Error(`the model produced ${dim}-dimension vectors, expected ${DEFAULT_DIM}`)
    }
    return poolAndNormalize(output.data, seq, dim)
  }
}

export type EmbeddingPreflightStatus =
  | 'ready'
  | 'missing_runtime'
  | 'missing_model_files'
  | 'load_error'
  | 'disabled'
  | 'no_embeddings'

export interface EmbeddingPreflightResult {
  readonly status: EmbeddingPreflightStatus
  readonly available: boolean
  readonly message: string
  readonly summary: string
  readonly modelName: string
  /** Which ONNX Runtime build runs the model in this process: the native binding when it is installed, else the bundled WebAssembly build. */
  readonly runtime: RuntimeName
  readonly runtimeVersion: string
  readonly runtimeAvailable: boolean
  /** Whether the WebAssembly build's pinned `.wasm` is already on this machine; null on the native binding, which has no such file. */
  readonly runtimeBinaryPresent: boolean | null
  readonly configEnabled: boolean
  readonly modelFilesPresent: boolean
  readonly modelWarmed: boolean
  readonly modelDir: string
  readonly suggestion?: string
  readonly actionRequired?: string
  readonly indexedFiles: number
  readonly embeddedFiles: number
  readonly coveragePercent: number
  readonly coverage?: { indexedFiles: number; embeddedFiles: number }
  readonly error?: string
}

/** Pre-flight health and readiness check for the semantic embedding model. Verifies configuration, inference runtime, weight files, and in-memory loadability. When `warm: true` is passed, initializes and warms the model in memory. */
export async function checkEmbeddingPreflight(options?: {
  warm?: boolean
  projectRoot?: string
  modelName?: string
  coverage?: { indexedFiles: number; embeddedFiles: number }
}): Promise<EmbeddingPreflightResult> {
  const modelName = options?.modelName ?? DEFAULT_MODEL
  const cfg = loadConfig()
  const enabled = cfg.indexing?.embeddings_enabled ?? true
  const mDir = modelDir()
  const rt = activeRuntime()
  const rtVer = runtimeVersion()
  const rtAvail = isRuntimeAvailable()
  const binaryPresent = rt === 'onnxruntime-web' ? wasmBinaryPresent() : null
  const filesPresent = modelFilesPresent()
  let warmed = false

  const buildResult = (params: {
    status: EmbeddingPreflightStatus
    available: boolean
    message: string
    suggestion?: string
    error?: string
    coverage?: { indexedFiles: number; embeddedFiles: number }
  }): EmbeddingPreflightResult => {
    const indexed = params.coverage?.indexedFiles ?? 0
    const embedded = params.coverage?.embeddedFiles ?? 0
    const pct = indexed > 0 ? Math.round((embedded / indexed) * 100) : 0
    return {
      status: params.status,
      available: params.available,
      message: params.message,
      summary: params.message,
      modelName,
      runtime: rt,
      runtimeVersion: rtVer,
      runtimeAvailable: rtAvail,
      runtimeBinaryPresent: binaryPresent,
      configEnabled: enabled,
      modelFilesPresent: filesPresent,
      modelWarmed: warmed,
      modelDir: mDir,
      ...(params.suggestion !== undefined ? { suggestion: params.suggestion, actionRequired: params.suggestion } : {}),
      ...(params.error !== undefined ? { error: params.error } : {}),
      indexedFiles: indexed,
      embeddedFiles: embedded,
      coveragePercent: pct,
      ...(params.coverage !== undefined ? { coverage: params.coverage } : {}),
    }
  }

  if (!enabled) {
    return buildResult({
      status: 'disabled',
      available: false,
      message: 'Matching on meaning is off (indexing.embeddings_enabled / TOKEN_GOAT_EMBEDDINGS_ENABLED is disabled)',
      suggestion: 'Enable in config: set indexing.embeddings_enabled = true or unset TOKEN_GOAT_EMBEDDINGS_ENABLED',
    })
  }

  if (!rtAvail) {
    const err = runtimeLoadError()
    return buildResult({
      status: 'missing_runtime',
      available: false,
      message: `Inference runtime is not available: ${err?.message ?? 'unknown error'}`,
      suggestion: RUNTIME_UNAVAILABLE_ADVICE,
      ...(err?.message ? { error: err.message } : {}),
    })
  }

  if (binaryPresent === false && cfg?.network?.offline) {
    return buildResult({
      status: 'missing_runtime',
      available: false,
      message: `The WebAssembly inference runtime's ${ORT_WEB_WASM.name} is not downloaded yet and offline mode (network.offline) prevents fetching it`,
      suggestion: `Copy ${ORT_WEB_WASM.name} from the onnxruntime-web package's dist/ into ${wasmDir()}, or ${NATIVE_RUNTIME_INSTALL}`,
    })
  }

  if (!filesPresent && cfg?.network?.offline) {
    return buildResult({
      status: 'missing_model_files',
      available: false,
      message: 'Embedding model files are missing and offline mode (network.offline) prevents downloading them',
      suggestion: `Download or copy the pinned model files into ${mDir}`,
    })
  }

  if (options?.warm === true) {
    try {
      await ensureModelFiles(modelName)
      await EmbeddingModel.load(modelName)
      warmed = true
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      return buildResult({
        status: 'load_error',
        available: false,
        message: `Failed to warm/load embedding model: ${err}`,
        suggestion: "Check model integrity or run `token-goat doctor`",
        error: err,
      })
    }
  }

  const coverage = options?.coverage
  if (coverage && coverage.indexedFiles > 0 && coverage.embeddedFiles === 0) {
    return buildResult({
      status: 'no_embeddings',
      available: false,
      message: `Embedding model is available, but 0 of ${coverage.indexedFiles} indexed file(s) in this project have embeddings`,
      suggestion: options?.projectRoot
        ? `Run ${fencedCommand('token-goat index ' + quotedArg(options.projectRoot))} to generate embeddings`
        : 'Run `token-goat index` to generate embeddings',
      coverage,
    })
  }

  return buildResult({
    status: 'ready',
    available: true,
    message: 'Semantic embedding model is ready and available',
    ...(coverage !== undefined ? { coverage } : {}),
  })
}

registerReset(() => {
  _inFlightModelDownload = null
})
