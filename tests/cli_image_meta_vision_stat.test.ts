// The recordStat CALL SITES, not just the helper.
//
// visionTokensSavedByText being correct proves nothing about whether cmdImageMeta and cmdImageText
// actually call it -- the two halves can each be right while the wiring between them is not. This
// file drives the real, unmocked `run()` CLI entrypoint against a real image and asserts the row
// that lands in the real (test-isolated) stats DB respects the vision ceiling.
//
// FIXTURE PROVENANCE
// - assets/logo.png is a real image checked into this repository (CAPTURE: a real file, decoded by
//   the real sharp path at test time, not a synthesised byte string).
// - The 4,784-token bound is FORMAT-DERIVED from VISION_TIER_LIMITS in src/image_shrink.ts, this
//   repo's encoding of Anthropic's documented vision pricing. It is used as a CEILING the recorded
//   figure must respect, never as an expected value.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'
import { visionTierMaxTokens } from '../src/image_shrink.js'

/** The largest a single image can bill at the most expensive tier. No row may exceed it. */
const ABSOLUTE_CEILING = Math.max(visionTierMaxTokens('standard'), visionTierMaxTokens('high'))

describe('image-meta records a vision-priced saving, not a byte-derived one', () => {
  it('books tokens within the vision ceiling for a real image', async () => {
    const image = join(process.cwd(), 'assets', 'logo.png')
    // Fail closed: a silent skip must never read as a pass.
    expect(existsSync(image)).toBe(true)

    const before = summarize(30).by_kind['image_meta']
    const beforeEvents = before?.events ?? 0
    const beforeTokens = before?.tokens_saved ?? 0

    await run(['node', 'token-goat', 'image-meta', image])

    const after = summarize(30).by_kind['image_meta']
    expect(after).toBeDefined()
    const events = (after?.events ?? 0) - beforeEvents
    expect(events).toBeGreaterThan(0)

    const tokens = (after?.tokens_saved ?? 0) - beforeTokens
    // The load-bearing assertion. Before the fix this figure was the image's BYTE count over four,
    // so for this file it would have run into the tens of thousands of tokens against a ceiling in
    // the low thousands.
    expect(tokens).toBeLessThanOrEqual(ABSOLUTE_CEILING * events)

    // Independent cross-check that the old formula genuinely would have failed this bound, so the
    // assertion is not vacuously satisfied by a small input.
    const byteDerived = Math.round(statSync(image).size / 4)
    expect(byteDerived).toBeGreaterThan(ABSOLUTE_CEILING)

    // NON-FIRING half: the command must still book a real, positive saving. A fix that simply
    // stopped recording anything would pass a ceiling check alone.
    expect(tokens).toBeGreaterThan(0)
  })
})
