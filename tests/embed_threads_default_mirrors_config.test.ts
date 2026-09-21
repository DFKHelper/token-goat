/**
 * `DEFAULT_EMBED_THREADS` exists so a caller that mocks a partial config still runs the model at the
 * thread count the product uses, and its doc comment says it mirrors `worker.embed_threads`. It said
 * that while holding 2 against a shipped default of 4, so a test running under the fallback embedded
 * at half the threads -- 105.8 ms/chunk against 56.6 measured on a 26-core machine, a 1.9x error in
 * any timing taken there. Nothing on the shipping path reads it, which is exactly why the drift sat
 * unnoticed: the only reader is the `??` branch a mock reaches.
 *
 * Provenance: HAND-DERIVED. Both sides are read live from their own modules rather than pinned to a
 * literal here, so this asserts the two agree rather than restating what one of them currently says.
 */
import { describe, expect, it } from 'vitest'

import { defaultConfig } from '../src/config_defaults.js'
import { DEFAULT_EMBED_THREADS } from '../src/embed_model.js'

describe('the embed-model thread fallback mirrors the shipped config default', () => {
  it('agrees with worker.embed_threads', () => {
    expect(DEFAULT_EMBED_THREADS).toBe(defaultConfig().worker.embed_threads)
  })

  it('is a usable thread count, so neither side can satisfy the mirror by going to zero', () => {
    expect(Number.isInteger(DEFAULT_EMBED_THREADS)).toBe(true)
    expect(DEFAULT_EMBED_THREADS).toBeGreaterThanOrEqual(1)
  })
})
