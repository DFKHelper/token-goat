// tg-no-regex-preload

import { describe, expect, it } from 'vitest'

// This file carries the opt-out line, so tests/setup/load-regex-extractors.ts must leave the regex adapters unloaded in this fork. The preload stores them on these global slots, so a preload that ignored the opt-out would fill them and fail this test.
describe('the regex preload opt-out', () => {
  it('leaves the regex adapters unloaded for a file that opts out', () => {
    const slots = globalThis as unknown as Record<symbol, unknown>
    expect(slots[Symbol.for('token-goat.regex-adapters')]).toBeUndefined()
    expect(slots[Symbol.for('token-goat.salesforce-frontend')]).toBeUndefined()
  })
})
