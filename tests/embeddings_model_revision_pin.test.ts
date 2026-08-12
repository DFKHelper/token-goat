/**
 * Security regression: embedTexts called pipelineFn('feature-extraction', modelName) with no
 * options object, so a cold-cache install resolved Xenova/bge-small-en-v1.5 at the mutable
 * 'main' ref on huggingface.co and handed the downloaded ONNX weights to onnxruntime-node (a
 * native execution surface) with no hash/signature pin -- trust-on-first-use against a mutable
 * upstream. Fix pins PINNED_MODEL_REVISION and passes it through to pipelineFn for the default
 * model. setPipelineFnForTesting is the test-only injection seam (see
 * embeddings_pipeline_memoization.test.ts for why: @xenova/transformers loads via
 * createRequire, which vi.mock cannot intercept).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import {
  DEFAULT_MODEL,
  PINNED_MODEL_REVISION,
  embedTexts,
  setPipelineFnForTesting,
} from '../src/embeddings.js'
import { clearModuleCaches } from '../src/reset.js'

afterEach(() => {
  clearModuleCaches()
})

describe('embedTexts model revision pin (security regression)', () => {
  it('calls pipelineFn with the pinned revision for the default model', async () => {
    const fakeVec = new Float32Array(384).fill(0.01)
    const fakeExtractor = vi.fn(async () => ({ data: fakeVec }))
    const pipelineFactory = vi.fn(async () => fakeExtractor)
    setPipelineFnForTesting(pipelineFactory)

    await embedTexts(['some text'], DEFAULT_MODEL)

    expect(pipelineFactory).toHaveBeenCalledWith(
      'feature-extraction',
      DEFAULT_MODEL,
      expect.objectContaining({ revision: PINNED_MODEL_REVISION }),
    )
  })
})
