/**
 * Regression: `compressedTokensSaved` in src/tool_filters/base.ts (the function
 * `bash_runner.ts` calls to book every `bash_compress:*` credit) used to divide by 3
 * (`Math.max(1, Math.floor(bytesSaved / 3) + 1)`), while every other pricing callsite in
 * this repo -- `savedTokensFromBytes` in src/stats.ts, and `TEXT_BYTES_PER_TOKEN` in
 * src/content_store.ts -- divides by 4. That inflated every bash-compression credit by
 * roughly a third relative to every sibling kind summed into the same ledger column.
 *
 * Provenance: HAND-DERIVED. Expected values below are computed independently from the
 * two competing formulas (bytes/3 vs bytes/4), not read out of either implementation, so
 * the test cannot pass by construction agreement with the code it checks.
 */
import { describe, expect, it } from 'vitest'

import { compressedTokensSaved, CompressedOutput } from '../src/tool_filters/base.js'

describe('compressedTokensSaved pricing divisor', () => {
  it('prices at bytes/4 (round), matching the codebase-wide constant, never at bytes/3', () => {
    const cases: Array<[number, number]> = [
      // [bytesSaved, expected bytes/4 result] -- hand-computed, not read off savedTokensFromBytes.
      [12, 3], // 12/4 = 3 exactly. Old formula: floor(12/3)+1 = 5.
      [100, 25], // 100/4 = 25. Old formula: floor(100/3)+1 = 34.
      [1200, 300], // 100/4 = 300. Old formula: floor(1200/3)+1 = 401.
      [7710391, 1927598], // round(7710391/4) = 1927598, a large-magnitude sanity check. Old formula: floor(x/3)+1 = 2570131.
    ]
    for (const [bytesSaved, expected] of cases) {
      const oldFormula = Math.max(1, Math.floor(bytesSaved / 3) + 1)
      expect(compressedTokensSaved(bytesSaved), `at ${bytesSaved} bytes`).toBe(expected)
      expect(compressedTokensSaved(bytesSaved), `at ${bytesSaved} bytes must not still be booking the old /3 formula`).not.toBe(oldFormula)
    }
  })

  it('never returns a negative or zero credit for a real byte saving, still floors non-positive input at zero', () => {
    expect(compressedTokensSaved(0)).toBe(0)
    expect(compressedTokensSaved(-500)).toBe(0)
    expect(compressedTokensSaved(1)).toBe(1)
  })

  it('CompressedOutput.tokensSaved uses the same fixed divisor as compressedTokensSaved', () => {
    const co = new CompressedOutput('out', 100, 25, 'demo')
    expect(co.bytesSaved).toBe(75)
    expect(co.tokensSaved).toBe(compressedTokensSaved(75))
    expect(co.tokensSaved).toBe(19) // hand: round(75/4) = 19. Old formula: floor(75/3)+1 = 26.
  })
})
