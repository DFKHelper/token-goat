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

import { embedTexts, setPipelineFnForTesting, isAvailable } from '../src/embeddings.js'
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
