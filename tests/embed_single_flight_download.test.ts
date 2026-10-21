/** Single-flight sharing of the model download, and the degraded semantic path, with every request answered in-process. The first version of this file called the real `ensureModelFiles` with no stub, so it fetched 34 MB from huggingface.co and passed or failed with the machine's network and cache: a WSL run timed out connecting. `fetch` is replaced here and any URL the test did not expect throws, so a request that would leave the machine cannot be made. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEFAULT_MODEL, PINNED_MODEL_REVISION, ensureModelFiles } from '../src/embed_model.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'
import { runSemantic } from '../src/read_semantic.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// CAPTURE: the pinned tokenizer.json, unzipped from tests/fixtures/wordpiece/tokenizer.json.gz (row in PROVENANCE.tsv); its sha256 is the one MODEL_FILES in src/embed_model.ts pins, so the real digest check accepts it.
const REAL_TOKENIZER: Buffer = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'fixtures', 'wordpiece', 'tokenizer.json.gz')),
)

const URL_PREFIX = `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/`
const TOKENIZER_URL = `${URL_PREFIX}tokenizer.json`
const ONNX_URL = `${URL_PREFIX}onnx/model_quantized.onnx`

const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR'] as const

describe('Embedding Single-Flight Download & Degraded Search Handling', () => {
  let tmp: string
  let saved: Record<string, string | undefined>
  let urls: string[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-single-flight-'))
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env['LOCALAPPDATA'] = tmp
    process.env['XDG_DATA_HOME'] = tmp
    delete process.env['TOKEN_GOAT_OFFLINE']
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    _resetDataDirCacheForTesting()
    clearModuleCaches()
    // The tokenizer is served with its real bytes. The 34 MB weights are answered with an empty body, which the length check refuses: the model cannot be faked past its pinned digest, so the download ends in a rejection, and that rejection is what both callers must share.
    urls = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url === TOKENIZER_URL) return new Response(REAL_TOKENIZER as unknown as BodyInit, { status: 200 })
      if (url === ONNX_URL) return new Response(new Uint8Array(0) as unknown as BodyInit, { status: 200 })
      throw new Error(`unexpected network request: ${url}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('shares single-flight in-progress download promise across concurrent callers', async () => {
    // When ensureModelFiles is called concurrently, they should coalesce onto the same in-flight promise
    const p1 = ensureModelFiles()
    const p2 = ensureModelFiles()
    expect(p1 === p2).toBe(true)
    const [r1, r2] = await Promise.allSettled([p1, p2])
    // Both callers see the one outcome of the one download.
    expect(r1.status).toBe('rejected')
    expect(r2.status).toBe('rejected')
    expect((r1 as PromiseRejectedResult).reason).toBe((r2 as PromiseRejectedResult).reason)
    // Two callers, one download: each file was requested once (a second download would repeat the tokenizer request), and nothing else was.
    expect(urls.filter((u) => u === TOKENIZER_URL)).toHaveLength(1)
    expect(urls.every((u) => u === TOKENIZER_URL || u === ONNX_URL)).toBe(true)
  })

  it('starts a fresh download once the in-flight one has settled', async () => {
    await expect(ensureModelFiles()).rejects.toThrow()
    const afterFirst = urls.filter((u) => u === ONNX_URL).length
    expect(afterFirst).toBeGreaterThan(0)
    await expect(ensureModelFiles()).rejects.toThrow()
    // The failed promise is not cached forever: the second call went back to the weights.
    expect(urls.filter((u) => u === ONNX_URL).length).toBeGreaterThan(afterFirst)
  })

  it('reports degraded status cleanly in runSemantic when semantic search is degraded or misses', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-degraded-'))
    try {
      // Running semantic search in JSON mode on an empty or degraded index
      const res = await runSemantic('arbitrary_test_query_xyz', {
        json: true,
        projectRoot: tmpDir,
      })
      const parsed = JSON.parse(res.text)
      expect(parsed).toHaveProperty('source')
      expect(parsed).toHaveProperty('items')
      expect(Array.isArray(parsed.items)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
