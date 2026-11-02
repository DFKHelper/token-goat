/** A did-you-mean list ranked only by length closeness let a name that merely contains the query, or a typo candidate that shares nothing with it but length, outrank a name that begins with what the agent typed. Fixture provenance: HAND-DERIVED. Every expected order below is computed from the tiers by hand (query itself, begins with the query, shares its first character, the rest) and from length differences counted on the strings, independently of rankSimilarNames. */
import { describe, expect, it } from 'vitest'

import { formatNoMatchesHelp, rankSimilarNames } from '../src/read_suggest.js'

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

  // Provenance: HAND-DERIVED (the three rows below; expected orders worked out by hand from each query's length and edit distance, not read from rankSimilarNames).
  it('suggests the real name one edit away first when a long camelCase query also holds fragments', () => {
    // `getReadNavigationEvidense` is 25 characters, two edits allowed; getReadNavigationEvidence is one substitution away. get, DENSE and read are fragments of the query, so the old code never reached the edit-distance pass.
    expect(rankSimilarNames(['get', 'DENSE', 'read', 'getReadNavigationEvidence', 'setup'], 'getReadNavigationEvidense')).toEqual(['getReadNavigationEvidence', 'get', 'DENSE', 'read'])
  })

  it('suggests a two-edit transposed name first when a fragment also matches', () => {
    // `parseCofnig` is 11 characters; parseConfig is two edits away (swap of o and f). parse is a fragment of the query, and config is not.
    expect(rankSimilarNames(['parseConfig', 'config', 'parse'], 'parseCofnig')[0]).toBe('parseConfig')
  })

  it('keeps a short query with an exact-prefix match as the only answer', () => {
    // `get` is 3 characters, below the 8-character floor for the new edit-distance pass; getter contains it.
    expect(rankSimilarNames(['get', 'set', 'getter'], 'get')).toEqual(['get', 'getter'])
  })

  it('formatNoMatchesHelp provides targeted recovery suggestions', () => {
    const grepSuggestions = formatNoMatchesHelp({
      kind: 'grep',
      pattern: 'MySymbol',
      targetPath: 'src/file.ts',
      hasUpper: true,
      isCaseSensitive: true,
    })
    expect(grepSuggestions).toContain('Try case-insensitive search: re-run with inline flag `(?i)` or case-insensitive matching')
    expect(grepSuggestions).toContain('Try inspecting file outline: token-goat outline "src/file.ts"')

    const symbolSuggestions = formatNoMatchesHelp({
      kind: 'symbol',
      targetPath: 'src/file.ts',
    })
    expect(symbolSuggestions).toContain('Try: token-goat outline "src/file.ts"')
  })
})
