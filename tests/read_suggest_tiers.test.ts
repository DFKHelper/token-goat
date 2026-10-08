/** A did-you-mean list ranked only by length closeness let a name that merely contains the query, or a typo candidate that shares nothing with it but length, outrank a name that begins with what the agent typed. Fixture provenance: HAND-DERIVED. Every expected order below is computed from the tiers by hand (query itself, begins with the query, shares its first character, the rest) and from length differences counted on the strings, independently of rankSimilarNames. */
import { describe, expect, it } from 'vitest'

import { rankSimilarNames } from '../src/read_suggest.js'

describe('rankSimilarNames tiers', () => {
  it('puts a name that begins with the query ahead of one that only contains it', () => {
    // Length differences from `render` (6): prerender 3, renderAll 3, unrender 2. By length alone: unrender, then the alphabetical tie prerender, renderAll.
    expect(rankSimilarNames(['prerender', 'renderAll', 'unrender'], 'render')).toEqual(['renderAll', 'unrender', 'prerender'])
  })

  it('puts a typo candidate sharing the first character ahead of one that does not', () => {
    // `rendr` is 5 characters, one edit allowed. tendr is one substitution away and the same length; render is one insertion away, one longer. By length alone: tendr, render.
    expect(rankSimilarNames(['tendr', 'render'], 'rendr')).toEqual(['render', 'tendr'])
  })

  it('keeps length closeness inside a tier', () => {
    expect(rankSimilarNames(['renderAllTheThings', 'renderAll'], 'render')).toEqual(['renderAll', 'renderAllTheThings'])
  })
})
