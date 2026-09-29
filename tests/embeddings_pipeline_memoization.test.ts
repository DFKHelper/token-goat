/**
 * Regression: embedTexts called pipelineFn('feature-extraction', modelName) on every single
 * invocation with no memoization. Building one is not cheap and never has been: back then it was
 * @xenova/transformers' pipeline() reloading weights and tokenizer from scratch each call, and it
 * is EmbeddingModel.load() now, which re-hashes both model files and creates a fresh ONNX session.
 * Either way every embedTexts call -- and by extension every indexFileEmbeddings call in the real
 * indexing path -- paid that repeatedly instead of once per process.
 *
 * The backend is loaded via createRequire (see embed_model.ts's ensureRuntimeLoaded), which
 * resolves through Node's real CJS loader rather than vitest's mockable module graph, so vi.mock
 * cannot intercept it, and the runtime's exports are non-configurable properties that cannot be
 * monkey-patched from a test either (verified: both approaches throw). setPipelineFnForTesting is
 * the test-only injection seam embeddings.ts exposes for exactly this reason, mirroring the
 * setXForTesting pattern already used in skill_cache.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  embedTexts,
  setPipelineFnForTesting,
  setPipelineRetryDelayForTesting,
  isAvailable,
} from '../src/embeddings.js'
import { DownloadCooldownError, DownloadFailedError } from '../src/model_download_gate.js'
import { clearModuleCaches } from '../src/reset.js'

afterEach(() => {
  clearModuleCaches()
})

describe('embedTexts pipeline memoization (regression)', () => {
  it.skipIf(!isAvailable())(
    'constructs the pipeline once per model name across multiple embedTexts calls',
    async () => {
      const fakeVec = new Float32Array(384).fill(0.01)
      const fakeExtractor = vi.fn(async () => ({ data: fakeVec }))
      const pipelineFactory = vi.fn(async () => fakeExtractor)
      setPipelineFnForTesting(pipelineFactory)

      await embedTexts(['first call text'])
      await embedTexts(['second call text'])
      await embedTexts(['third call text'])

      expect(pipelineFactory).toHaveBeenCalledTimes(1)
      expect(fakeExtractor).toHaveBeenCalledTimes(3)
    },
  )

  it.skipIf(!isAvailable())(
    'constructs a separate pipeline per distinct model name',
    async () => {
      const fakeVec = new Float32Array(384).fill(0.01)
      const fakeExtractor = vi.fn(async () => ({ data: fakeVec }))
      const pipelineFactory = vi.fn(async () => fakeExtractor)
      setPipelineFnForTesting(pipelineFactory)

      await embedTexts(['text a'], 'model-a')
      await embedTexts(['text b'], 'model-a')
      await embedTexts(['text c'], 'model-b')

      expect(pipelineFactory).toHaveBeenCalledTimes(2)
    },
  )
})

describe('embedTexts pipeline construction retry (regression)', () => {
  it.skipIf(!isAvailable())(
    'retries a transient pipeline construction failure and succeeds once the factory recovers (regression: pipelineFn had no retry of its own, so a single transient network error during model download failed embedTexts outright)',
    async () => {
      setPipelineRetryDelayForTesting(1)
      const fakeVec = new Float32Array(384).fill(0.01)
      const fakeExtractor = vi.fn(async () => ({ data: fakeVec }))
      let calls = 0
      const pipelineFactory = vi.fn(async () => {
        calls += 1
        if (calls < 3) throw new Error('transient network error')
        return fakeExtractor
      })
      setPipelineFnForTesting(pipelineFactory)

      const vecs = await embedTexts(['some text'])

      expect(vecs).toHaveLength(1)
      expect(pipelineFactory).toHaveBeenCalledTimes(3)
    },
  )

  it.skipIf(!isAvailable())(
    'does not permanently cache a rejected pipeline construction, so a later call can retry fresh after the failure clears (regression: the extractor cache was keyed by model name and stored the raw construction promise for the process lifetime, so once one embedTexts call observed a rejection, every subsequent call for that model name replayed the exact same cached rejection forever, even long after the underlying outage cleared)',
    async () => {
      setPipelineRetryDelayForTesting(1)
      const fakeVec = new Float32Array(384).fill(0.01)
      const fakeExtractor = vi.fn(async () => ({ data: fakeVec }))
      const failingFactory = vi.fn(async () => {
        throw new Error('sustained outage')
      })
      setPipelineFnForTesting(failingFactory)

      await expect(embedTexts(['first text'], 'retry-eviction-model')).rejects.toThrow(
        'sustained outage',
      )

      const recoveredFactory = vi.fn(async () => fakeExtractor)
      setPipelineFnForTesting(recoveredFactory)

      const vecs = await embedTexts(['second text'], 'retry-eviction-model')

      expect(vecs).toHaveLength(1)
      expect(recoveredFactory).toHaveBeenCalledTimes(1)
    },
  )

  // PROVENANCE: HAND-DERIVED from pinned_fetch.ts's contract (a DownloadFailedError is thrown only after its own three attempts, and the failure it records holds every later automatic try). CAPTURE behind it: with the network blocked, a foreground `semantic` on the built 2.9.29 bundle printed "Downloading the embedding model, once (tokenizer.json, 1 MB)" three times, then reported the hold ("Not downloading ... yet: the last try, moments ago, failed with ...") instead of the ECONNREFUSED that caused it, because this retry ran the download twice more into its own fresh hold.
  it.each([
    ['a failed download', () => new DownloadFailedError('GET https://huggingface.co/x/tokenizer.json failed: fetch failed (connect ECONNREFUSED 127.0.0.1:9)', 'https://huggingface.co/x/tokenizer.json', 1_000)],
    ['a held download', () => new DownloadCooldownError('https://huggingface.co/x/tokenizer.json', { host: 'huggingface.co', url: 'https://huggingface.co/x/tokenizer.json', message: 'fetch failed', at: Date.now(), failures: 1, retryAt: Date.now() + 600_000 })],
    ['a failed download wrapped by the loader', () => new Error('could not load the model', { cause: new DownloadFailedError('GET x failed', 'x', 1_000) })],
  ])('does not retry %s, which the download already retried and recorded, and surfaces it unchanged', async (_name, make) => {
    setPipelineRetryDelayForTesting(1)
    const err = make()
    const failingFactory = vi.fn(async () => {
      throw err
    })
    setPipelineFnForTesting(failingFactory)

    await expect(embedTexts(['text'], 'download-failure-model')).rejects.toBe(err)
    expect(failingFactory).toHaveBeenCalledTimes(1)
  })
})
