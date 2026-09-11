/**
 * The shared model cache: the copy of the pinned weights that survives the data directory.
 *
 * `modelDir()` lives under the data root, and a test run repoints that root at a fresh temp
 * directory per worker while several tests build their own roots on top of that. The result was
 * that one CI run fetched the 32 MB weights 57 times into 57 directories, roughly 1.8 GB from
 * huggingface.co per run, which is also what the `Test` step's retry wrapper cites as a known
 * cause of an otherwise-green run failing: a CDN rate limit on exactly this download. A
 * `node_modules/@xenova/transformers/.cache` cache step existed to stop this and never could,
 * because no fixed path can name a directory that is regenerated per worker. `actions/cache`
 * reported `Path Validation Error` on every job for as long as it had been there.
 *
 * So the interesting assertions here are about *avoided network*, not about files appearing:
 * every test drives the real `ensureModelFiles` with `fetch` substituted and checks which URLs
 * were asked for. A file that appears is not evidence, because a download produces one too.
 *
 * PROVENANCE: CAPTURE. `tokenizer.json` is the genuine pinned model file, unzipped from the same
 * fixture the tokenizer oracle reads, and its sha256 is the one pinned in embed_model.ts. It is
 * also the first entry in MODEL_FILES, so a run that gets as far as requesting
 * `onnx/model_quantized.onnx` has already accepted the tokenizer, which is what lets these tests
 * exercise every branch without the 32 MB second file.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { DEFAULT_MODEL, PINNED_MODEL_REVISION, ensureModelFiles, modelDir } from '../src/embed_model.js'
import { clearModuleCaches } from '../src/reset.js'
import { CAN_SYMLINK } from './helpers/can-symlink.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The real pinned tokenizer.json, unzipped from the fixture the oracle test also reads. */
const REAL_TOKENIZER: Buffer = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'fixtures', 'wordpiece', 'tokenizer.json.gz')),
)

const ONNX_URL = `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/onnx/model_quantized.onnx`

const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR'] as const

let tmp: string
let cacheRoot: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-model-shared-'))
  cacheRoot = path.join(tmp, 'shared-cache')
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['LOCALAPPDATA'] = path.join(tmp, 'data')
  process.env['XDG_DATA_HOME'] = path.join(tmp, 'data')
  delete process.env['TOKEN_GOAT_OFFLINE']
  delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A response with the given body, in the shape `download` consumes. */
function bodyResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 })
}

/** Substitute `fetch`, recording every URL asked for. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    return handler(url)
  })
  return { urls }
}

/** Turn the shared cache on, pointed at this test's own directory. */
function enableSharedCache(): void {
  process.env['TOKEN_GOAT_MODEL_CACHE_DIR'] = cacheRoot
}

/** Where a file sits inside the shared cache, which is keyed by model and pinned revision. */
function sharedPath(name: string): string {
  return path.join(cacheRoot, ...DEFAULT_MODEL.split('/'), PINNED_MODEL_REVISION, ...name.split('/'))
}

/** Where a given model file lands once accepted. */
function cachedPath(name: string): string {
  return path.join(modelDir(), ...name.split('/'))
}

function writeShared(name: string, bytes: Buffer): void {
  const target = sharedPath(name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

describe('the shared model cache serves files the data directory does not have', () => {
  it('places a cached file without asking the network for it', async () => {
    enableSharedCache()
    writeShared('tokenizer.json', REAL_TOKENIZER)
    // Any request at all is a failure here, so the handler refuses rather than returning a body.
    const { urls } = stubFetch((url) => {
      throw new Error(`unexpected network request: ${url}`)
    })

    await expect(ensureModelFiles()).rejects.toThrow()

    // The tokenizer never went over the wire, and reaching the onnx file proves it was accepted.
    expect(urls).toEqual([ONNX_URL])
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
  })

  it('stays off unless it is switched on, so an unset variable cannot silently redirect reads', async () => {
    writeShared('tokenizer.json', REAL_TOKENIZER)
    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )

    await expect(ensureModelFiles()).rejects.toThrow()

    // With no TOKEN_GOAT_MODEL_CACHE_DIR the seeded copy is invisible and the tokenizer is fetched.
    expect(urls[0]).toMatch(/tokenizer\.json$/)
  })

  it('serves a hit in offline mode, because a local copy needs no network to refuse', async () => {
    enableSharedCache()
    writeShared('tokenizer.json', REAL_TOKENIZER)
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    const { urls } = stubFetch(() => bodyResponse(Buffer.alloc(0)))

    // Offline still stops the onnx file, which has no cached copy, and that is the right refusal.
    await expect(ensureModelFiles()).rejects.toThrow(/model_quantized\.onnx/)
    expect(urls).toEqual([])
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
  })
})

describe('the shared model cache is verified, not trusted', () => {
  it('refetches when a cached file does not hash, and evicts it so later runs do not repeat the copy', async () => {
    enableSharedCache()
    writeShared('tokenizer.json', Buffer.alloc(REAL_TOKENIZER.length, 0x41))
    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )

    await expect(ensureModelFiles()).rejects.toThrow()

    // Right length, wrong bytes: only the digest can tell, which is the whole point of checking it.
    expect(urls[0]).toMatch(/tokenizer\.json$/)
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
    expect(fs.readFileSync(sharedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
  })

  it('leaves no partial file behind in the model directory when a cached copy is rejected', async () => {
    enableSharedCache()
    writeShared('tokenizer.json', Buffer.alloc(REAL_TOKENIZER.length, 0x41))
    stubFetch(() => {
      throw new Error('no network')
    })

    await expect(ensureModelFiles()).rejects.toThrow()

    const strays = fs.existsSync(modelDir()) ? fs.readdirSync(modelDir()).filter((f) => f.includes('.shared')) : []
    expect(strays).toEqual([])
  })
})

/**
 * The shared directory is the one place these functions touch that the operator names and may
 * share, so it is the one place another principal's file can be waiting. A security review of the
 * 2.9.9 code found two ways that mattered, both confirmed by running them rather than by reading:
 * a copy that followed a symlink planted at the temp name and overwrote its target with the model
 * bytes, and a read path with no bound on what it was willing to copy.
 *
 * PROVENANCE: HAND-DERIVED. Both cases are constructed from the documented behaviour of the
 * syscalls, not from what these functions do: `open` with `O_CREAT|O_TRUNC` and no `O_NOFOLLOW`
 * follows a symlink, `O_EXCL` refuses one, and a `stat` size is knowable without running the copy.
 * The symlink case is skipped where the platform will not create one unprivileged, which is
 * ordinary Windows: the code path it guards is the same on every platform.
 */
describe('the shared model cache does not trust the directory it writes into', () => {
  it.skipIf(!CAN_SYMLINK)('refuses to publish through a symlink planted at its temp name', async () => {
    enableSharedCache()

    const victim = path.join(tmp, 'victim.txt')
    fs.writeFileSync(victim, 'PRECIOUS')
    // The temp name is derived, not guessed: the pid is readable from the process table for as long as a 32 MB download takes.
    const planted = `${sharedPath('tokenizer.json')}.${process.pid}.partial`
    fs.mkdirSync(path.dirname(planted), { recursive: true })
    fs.symlinkSync(victim, planted)

    stubFetch((url) => (url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0))))
    await expect(ensureModelFiles()).rejects.toThrow()

    expect(fs.readFileSync(victim, 'utf8'), 'the model bytes went through the link and truncated the file').toBe(
      'PRECIOUS',
    )
    // The model still had to land where the caller asked for it: refusing to publish is not refusing to work.
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
  })

  it('leaves a file already sitting at its temp name alone rather than overwriting it', async () => {
    enableSharedCache()
    const occupied = `${sharedPath('tokenizer.json')}.${process.pid}.partial`
    fs.mkdirSync(path.dirname(occupied), { recursive: true })
    fs.writeFileSync(occupied, 'SOMEONE ELSE')

    stubFetch((url) => (url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0))))
    await expect(ensureModelFiles()).rejects.toThrow()

    // Portable stand-in for the symlink case above: both are the same refusal to write to a name it did not create.
    expect(fs.readFileSync(occupied, 'utf8')).toBe('SOMEONE ELSE')
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)
  })

  it('will not copy a cached entry that is not a plain file of the expected size', async () => {
    enableSharedCache()
    // Right name, wrong size. A digest cannot rule this out ahead of the copy, which is the point: the check has to happen before any bytes move, or a source that never ends is never judged at all.
    const wrongSize = Buffer.alloc(REAL_TOKENIZER.length + 1, 0x41)
    writeShared('tokenizer.json', wrongSize)
    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )

    await expect(ensureModelFiles()).rejects.toThrow()

    expect(urls[0], 'a wrong-sized entry must send the run to the network').toMatch(/tokenizer\.json$/)
    expect(fs.readFileSync(cachedPath('tokenizer.json')).equals(REAL_TOKENIZER)).toBe(true)

    // The load-bearing half, and the reason the assertion above is not enough on its own: the digest check
    // already sent a wrong-sized file to the network before any of this existed, so "it refetched" is equally
    // true of the code without the size bound. What is only true with it is that nothing was read. Reading the
    // bytes is what leads to the eviction below, so the entry surviving is the visible shape of the copy that
    // did not happen.
    expect(
      fs.readFileSync(sharedPath('tokenizer.json')).equals(wrongSize),
      'a size mismatch is judged from stat alone, so the entry is neither copied nor evicted',
    ).toBe(true)
  })

  it.skipIf(!CAN_SYMLINK)('will not copy a cached entry that is a symlink, however good its target looks', async () => {
    enableSharedCache()

    const real = path.join(tmp, 'real-tokenizer.json')
    fs.writeFileSync(real, REAL_TOKENIZER)
    const link = sharedPath('tokenizer.json')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(real, link)

    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )
    await expect(ensureModelFiles()).rejects.toThrow()

    // The bytes behind this link are correct, so a digest check would have accepted it. What the link could have been instead is the reason not to follow it.
    expect(urls[0]).toMatch(/tokenizer\.json$/)
  })
})

describe('the shared model cache is filled by the downloads it will later replace', () => {
  it('publishes a freshly downloaded file so the next run copies instead of fetching', async () => {
    enableSharedCache()
    stubFetch((url) => (url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0))))

    await expect(ensureModelFiles()).rejects.toThrow()

    // Published under its digest-checked name, so the next run's copy passes the same check.
    expect(fs.existsSync(sharedPath('tokenizer.json'))).toBe(true)
    expect(sha256(sharedPath('tokenizer.json'))).toBe(sha256(cachedPath('tokenizer.json')))
  })

  it('publishes nothing when the cache is switched off, so a second run still has to fetch', async () => {
    // Asserting only that `cacheRoot` stays absent is a control that cannot fail: nothing in the
    // source knows that path, so no regression could write there. A default switched on by
    // mistake writes somewhere else entirely, and checking the working directory for it is
    // order-dependent once an earlier test in the file has already created it.
    //
    // What is not order-dependent is the invariant itself. With the cache off there is nowhere for
    // the first run to leave anything, so the second run has to go back to the network for the
    // same file. Under `?.trim() || 'SOMEWHERE'` the first run publishes, the second run hits that
    // copy, and the fetch count drops, which is the kill.
    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )

    await expect(ensureModelFiles()).rejects.toThrow()
    // The data directory would otherwise answer the second run itself, which is a different cache.
    fs.rmSync(modelDir(), { recursive: true, force: true })
    await expect(ensureModelFiles()).rejects.toThrow()

    expect(urls.filter((u) => u.endsWith('tokenizer.json'))).toHaveLength(2)
    expect(fs.existsSync(cacheRoot)).toBe(false)
  })
})
