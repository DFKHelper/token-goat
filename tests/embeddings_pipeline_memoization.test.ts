/**
 * Regression: embedTexts called pipelineFn('feature-extraction', modelName) on every single
 * invocation with no memoization. @xenova/transformers' pipeline() has no built-in caching of
 * its own (it reloads model weights + tokenizer from scratch each call), so every embedTexts
 * call -- and by extension every indexFileEmbeddings call in the real indexing path -- paid
 * full pipeline-construction cost repeatedly instead of once per process.
 *
 * @xenova/transformers is loaded via createRequire (see embeddings.ts's ensureTransformerLoaded),
 * which resolves through Node's real CJS loader rather than vitest's mockable module graph, so
 * vi.mock('@xenova/transformers', ...) cannot intercept it, and its `pipeline` export is a
 * non-configurable property that cannot be monkey-patched from a test either (verified: both
 * approaches throw). setPipelineFnForTesting is the test-only injection seam embeddings.ts
 * exposes for exactly this reason, mirroring the setXForTesting pattern already used in
 * skill_cache.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  embedTexts,
  setPipelineFnForTesting,
  setPipelineRetryDelayForTesting,
  isAvailable,
} from '../src/embeddings.js'
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
})
