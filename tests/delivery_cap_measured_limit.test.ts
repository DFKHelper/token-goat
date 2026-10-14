/** The harness's inline limit lived in two places that disagreed: delivery_cap.ts said Claude Code persists a Bash result past 20,000 bytes, and overflow_guard.ts held token-goat's own answers to 24,000 characters because results up to 26,588 had been seen inline. Measured on this machine's transcripts (2.1.220 to 2.1.296), the longest result delivered inline held 29,706 characters and every persisted one whose saved file survived held 30,695 or more, so the 20,000 figure booked a 25,000-byte result the model saw whole as a 2 KB preview, and clipped rewrites that would have fitted. The limit now has one definition, and the paging ceiling is derived from it. */
import { describe, expect, it } from 'vitest'

import { CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES, CLAUDE_CODE_PERSISTED_PREVIEW_BYTES, deliveredOutputBytes, fitToDeliveryCap } from '../src/delivery_cap.js'
import { HARNESS_INLINE_CEILING_CHARS } from '../src/overflow_guard.js'

// CAPTURE: the longest Bash result seen inline, and the smallest persisted one, in the transcripts named above.
const LONGEST_INLINE = 29_706
const SMALLEST_PERSISTED = 30_695

describe('the measured Claude Code inline limit', () => {
  it('sits in the measured gap, at its lower edge', () => {
    expect(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES).toBe(LONGEST_INLINE)
    expect(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES).toBeLessThan(SMALLEST_PERSISTED)
  })

  it('credits a result between the old 20,000 and the measured limit as delivered whole', () => {
    expect(deliveredOutputBytes(25_000, 'claudecode')).toBe(25_000)
    expect(deliveredOutputBytes(LONGEST_INLINE, 'claudecode')).toBe(LONGEST_INLINE)
    expect(deliveredOutputBytes(SMALLEST_PERSISTED, 'claudecode')).toBe(CLAUDE_CODE_PERSISTED_PREVIEW_BYTES)
  })

  it('leaves a rewrite under the measured limit unclipped', () => {
    const body = 'x'.repeat(25_000)
    expect(fitToDeliveryCap(body, (b, clipped) => (clipped ? b + '\n[cut]' : b), CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES)).toBe(body)
  })

  it('derives the paging ceiling from the same limit, with room left for the notice and stderr', () => {
    expect(HARNESS_INLINE_CEILING_CHARS).toBe(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES - 4096)
  })
})
