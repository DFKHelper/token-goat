/**
 * The embedding backend: fetch the pinned model, verify it, run it, pool it.
 *
 * This replaces `@xenova/transformers`, which had not shipped a release since May 2024, so its
 * advisories have no forward patch. What it did for us was three separable things -- tokenize, run
 * an ONNX graph, mean-pool the result -- and all three are here, on `onnxruntime-node` alone.
 *
 * Measured standalone in a throwaway directory, not read off a badge: `onnxruntime-node@1.27.0`
 * installs 17 packages and reports 2 high advisories; `@xenova/transformers@2.17.2` installs 80 and
 * reports 5, one of them critical. The two are both GHSA-xcpc-8h2w-3j85 in `adm-zip`, which
 * onnxruntime-node uses in its own postinstall script to unpack the prebuilt binary it just
 * fetched -- never on anything a user or this file hands it. This repository pins `adm-zip` past it
 * with an `overrides` entry, and npm applies overrides only in the root project, so someone who
 * opts in with `npm install -g onnxruntime-node` still resolves the 0.5 line and still sees those
 * two. SECURITY.md says so rather than rounding it to clean.
 *
 * Security posture of the download, which is the only part that touches the network:
 *
 * - Every component of the URL is a constant in this file. There is no caller-supplied repository,
 *   revision, filename or hostname anywhere in the path. `huggingface.co` accepts uploads from
 *   anyone, so trusting the hostname is not enough on its own -- that is exactly the shape of
 *   CVE-2026-54316, where allowlisting the host let an attacker serve whatever they liked from a
 *   path under it.
 * - The revision is an immutable commit, not a branch, so the bytes cannot change under us.
 * - Every file is checked against a sha256 recorded here, on download AND on every load, and the
 *   exact byte length is enforced while the body streams so a hostile or broken response cannot
 *   spend the disk before the digest gets a chance to reject it. The digest is the trust anchor,
 *   which is why following redirects (HuggingFace redirects `resolve` to its CDN) is safe.
 * - A model other than the pinned one is refused rather than downloaded unverified.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { loadConfig } from './config.js'
import { dataDir, ensureDataDirPrivate } from './constants.js'
import { BertWordPiece } from './embed_tokenizer.js'
import { registerReset } from './reset.js'

const _require = createRequire(import.meta.url)

/**
 * BAAI/bge-small-en-v1.5, the smallest BGE checkpoint tuned for retrieval. The 384-dimension output
 * is native to it: changing either of these means every stored vector has to be rebuilt, which is
 * what the embedding_provenance stamp in db.ts detects.
 */
export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
export const DEFAULT_DIM = 384

/**
 * The immutable commit this model is pinned to, so a cold cache fetches known-good weights instead
 * of trusting a branch that can move. Read from https://huggingface.co/api/models/Xenova/bge-small-en-v1.5
 * ("sha") on 2026-08-12; the model itself was last updated 2025-07-22. Bump deliberately, together
 * with the digests below, and expect every index on the machine to rebuild itself once.
 */
export const PINNED_MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3'

/** One file of the pinned model, with the size and digest its bytes must have. */
interface ModelFile {
  /** Path within the repository, and within our own cache directory. */
  readonly name: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * Everything the model needs, and nothing else. Recorded by hand from the pinned revision:
 * `sha256sum` over the files as fetched on 2026-08-22.
 */
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

/** The one URL shape this module will fetch. Every component is a constant above. */
function downloadUrl(file: ModelFile): string {
  return `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/${file.name}`
}

// onnxruntime-node is optional and loaded on first use rather than at module load. It is a native
// addon: requiring it eagerly loads its DLLs into the process, and this module is reachable from
// the CLI's hot hook path via index_prune.ts, which never embeds anything.
let _ort: unknown = null
let _ortError: Error | null = null
let _ortLoadAttempted = false

function ensureRuntimeLoaded(): void {
  if (_ortLoadAttempted) return
  _ortLoadAttempted = true
  try {
    _ort = _require('onnxruntime-node')
  } catch (e) {
    _ortError = e instanceof Error ? e : new Error(String(e))
  }
}

/** Whether the inference runtime is installed and loadable. */
export function isRuntimeAvailable(): boolean {
  ensureRuntimeLoaded()
  return _ort !== null && _ortError === null
}

/**
 * Why the runtime did not load, or null when it loaded. `isRuntimeAvailable()` collapses "absent"
 * and "present but throwing" into false, which is right for a caller deciding whether to embed and
 * wrong for `doctor`, whose job is naming the fix -- those two need different fixes.
 */
export function runtimeLoadError(): Error | null {
  ensureRuntimeLoaded()
  return _ortError
}

/**
 * The installed runtime's version, or 'unknown'. onnxruntime-node exports no version of its own, so
 * this reads the package.json beside whatever `onnxruntime-node` resolves to. It deliberately does
 * not require the package.json by subpath: that depends on the package not restricting its
 * `exports` map, and tests/guards/semantic_deps.test.ts reads require strings out of src/ as
 * declared dependency names, so a subpath there reads as an undeclared package. (That guard scans
 * text, so this paragraph does not spell the call out either -- naming it would fail the check it
 * is explaining.)
 */
export function runtimeVersion(): string {
  ensureRuntimeLoaded()
  if (_ort === null) return 'unknown'
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

function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Fetch one file to its final path, or throw. The digest is checked before the file is put in
 * place, so a partial or wrong download never becomes the cached copy: everything lands on a
 * temporary name in the same directory first.
 */
async function download(file: ModelFile, target: string): Promise<void> {
  const url = downloadUrl(file)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error(`GET ${url} returned no body`)

  const temp = `${target}.${process.pid}.partial`
  const hash = createHash('sha256')
  let written = 0
  const out = fs.createWriteStream(temp)
  try {
    // `pipeline` rather than a hand-rolled write loop, because it owns the three things that loop
    // kept getting wrong: it propagates an error from either end instead of leaving one on a
    // stream with no listener (which Node re-raises as an uncaught exception, killing the CLI); it
    // settles rather than waiting forever for a `drain` that a failed sink will never emit; and it
    // destroys and closes both ends before returning, so the cleanup below is not unlinking a file
    // somebody still has open.
    await pipeline(async function* () {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        written += chunk.byteLength
        // The size is pinned along with the digest, so a response that overruns it is already
        // wrong and there is no reason to keep spending disk on it before saying so.
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
    // `pipeline` destroys the sink but rejects without waiting for it to close, and the first
    // chunk can be rejected before the file is even open. Removing it at that moment deletes
    // nothing and the open lands afterwards, leaving the scratch file behind for good -- 34 MB of
    // it, on every failed attempt. So wait for the handle to actually close first.
    await new Promise<void>((resolve) => {
      if (out.closed) resolve()
      else out.once('close', () => resolve())
    })
    try {
      // Retries because Windows reports EPERM for a moment after a handle is closed.
      fs.rmSync(temp, { force: true, maxRetries: 20, retryDelay: 25 })
    } catch {
      // The download already failed and that is the news. A cleanup that fails on top of it must
      // not replace the reason with its own, less useful one.
    }
    throw e
  }
}

/**
 * Make sure every model file is present and is the file it claims to be, downloading what is
 * missing. Returns the directory holding them.
 *
 * Cached files are re-verified on every load rather than trusted for having the right name: hashing
 * 33 MB costs a fraction of what loading the graph costs anyway, and the alternative is a marker
 * file recording that a check once passed, which is a record of the past rather than a check.
 */
export async function ensureModelFiles(modelName: string = DEFAULT_MODEL): Promise<string> {
  if (modelName !== DEFAULT_MODEL) {
    throw new Error(
      `Only ${DEFAULT_MODEL} is supported: its files are pinned to a revision and to a sha256 each, ` +
        `and "${modelName}" has neither, so there would be nothing to check the download against.`,
    )
  }

  ensureDataDirPrivate()
  const dir = modelDir()
  const offline = loadConfig().network.offline

  for (const file of MODEL_FILES) {
    const target = path.join(dir, file.name)
    if (fs.existsSync(target)) {
      const digest = await sha256Of(target)
      if (digest === file.sha256) continue
      // A file that is present and wrong is worse than one that is absent: leaving it would make
      // every later run fail the same way. Replace it, which offline mode cannot do.
      fs.rmSync(target, { force: true })
    }
    if (offline) {
      throw new Error(
        `Offline mode is on (network.offline): refusing to download ${file.name} for the embedding model. ` +
          `Copy the pinned files into ${dir} on a connected machine to use semantic search here.`,
      )
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    console.warn(
      `Downloading the embedding model, once (${file.name}, ${Math.round(file.bytes / 1024 / 1024)} MB) into ${dir}`,
    )
    await download(file, target)
  }
  return dir
}

/** What ONNX Runtime hands back from a session run, narrowed to the parts this uses. */
interface OrtTensor {
  readonly dims: readonly number[]
  readonly data: ArrayLike<number>
}
interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
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
  // A zero-length vector cannot be scaled to unit length, and dividing anyway fills it with NaN,
  // which sqlite-vec reports as no distance at all -- nearer than everything, top of every search.
  // Leave it as zeroes and let embedTexts' finite check reject it as the failure it is.
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
      throw new Error(`onnxruntime-node is not available: ${_ortError?.message ?? 'unknown error'}`)
    }
    const dir = await ensureModelFiles(modelName)
    const tokenizer = BertWordPiece.fromJson(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'))
    const ort = _ort as {
      InferenceSession: { create(p: string): Promise<OrtSession> }
      Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown
    }
    const session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model_quantized.onnx'))
    return new EmbeddingModel(tokenizer, session, ort.Tensor)
  }

  /** Embed one text. Sequences are run singly, so there is no padding and no mask to get wrong. */
  async embed(text: string): Promise<Float32Array> {
    const ids = this.tokenizer.encode(text)
    const length = ids.length
    const feeds: Record<string, unknown> = {
      input_ids: new this.tensorFactory('int64', BigInt64Array.from(ids, BigInt), [1, length]),
      attention_mask: new this.tensorFactory('int64', new BigInt64Array(length).fill(1n), [1, length]),
    }
    // BERT exports usually declare token_type_ids and some do not; passing an input the graph did
    // not declare is an error, so follow what this session says it takes.
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

registerReset(() => {
  _ort = null
  _ortError = null
  _ortLoadAttempted = false
})
