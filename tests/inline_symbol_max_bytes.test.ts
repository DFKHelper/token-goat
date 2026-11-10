import { describe, expect, it } from 'vitest'

import { INLINE_SYMBOL_MAX_BYTES } from '../src/constants.js'
import { INLINE_SYMBOL_MAX_BYTES as REEXPORTED } from '../src/inline_symbol_answer.js'

// HAND-DERIVED: 12,000 is the cap the review disposition R3 records, below the 24,000 of COMPACT_INLINE_MAX_BYTES; pinned so that raising it is a visible edit to this row and to the limit comment in constants.ts.
describe('INLINE_SYMBOL_MAX_BYTES', () => {
  it('is pinned at 12,000 bytes', () => {
    expect(INLINE_SYMBOL_MAX_BYTES).toBe(12_000)
  })

  it('is the one value inline_symbol_answer re-exports, so the deny and the cap cannot disagree', () => {
    expect(REEXPORTED).toBe(INLINE_SYMBOL_MAX_BYTES)
  })
})
