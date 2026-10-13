/** sliceToEstimatedTokens returns the longest prefix that estimateTokens prices at the budget or fewer. Provenance: HAND-DERIVED from the documented rates, estimateTokens = floor(characters / 3) + 1 for ASCII text and floor(characters / 0.9) + 1 for CJK ideographs, so a prefix fits while its raw cost is below the budget; the expected lengths are worked out here, not read from the code. */
import { describe, expect, it } from 'vitest'

import { sliceToEstimatedTokens } from '../src/overflow_guard.js'

describe('sliceToEstimatedTokens at the exact edge', () => {
  it('keeps 1646 ASCII characters whole at a budget of 549, which is what they cost', () => {
    const text = 'a'.repeat(1646)
    expect(sliceToEstimatedTokens(text, 549)).toBe(text)
  })

  it('cuts ASCII at the last length that still fits: 1646 characters cost 549, 1647 cost 550', () => {
    expect(sliceToEstimatedTokens('a'.repeat(3000), 549)).toBe('a'.repeat(1646))
  })

  it('cuts CJK at 89 ideographs for a budget of 99: 89 / 0.9 = 98.9 floors to 98, plus 1', () => {
    expect(sliceToEstimatedTokens('函'.repeat(200), 99)).toBe('函'.repeat(89))
  })

  it('never ends in half of a surrogate pair', () => {
    const cut = sliceToEstimatedTokens('😀'.repeat(400), 50)
    expect(cut.length % 2).toBe(0)
    expect(cut.length).toBeGreaterThan(0)
  })
})
