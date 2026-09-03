// The image-text recordStat CALL SITE.
//
// A mutation that reverted this one line to the text divisor survived the rest of the image test
// suite green, because nothing exercised cmdImageText's recording path. This file closes that gap.
//
// The OCR engine itself is mocked -- not the accounting. runImageText is replaced with a fixed
// result so the test is deterministic and does not depend on tesseract being installed or on what
// OCR happens to read off a logo, while the code under test (cmdImageText's real recordStat line,
// reached through the real `run()` CLI entrypoint) is the genuine shipping path.
//
// FIXTURE PROVENANCE
// - assets/logo.png is a real image checked into this repository; only its on-disk SIZE is used,
//   which is what the old byte-derived formula consumed.
// - The OCR result is HAND-DERIVED: a plain fixed string, chosen independently of any producer.
// - The 4,784-token bound is FORMAT-DERIVED from VISION_TIER_LIMITS in src/image_shrink.ts. It is a
//   CEILING the recorded figure must respect, never an expected value.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/read_commands.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    runImageText: vi.fn(async () => ({
      ocrAvailable: true,
      confidence: 92,
      chars: 44,
      textHeavy: true,
      text: 'a short deterministic ocr body for the test',
    })),
  }
})

import { run } from '../src/cli.js'
import { summarize } from '../src/stats.js'
import { visionTierMaxTokens } from '../src/image_shrink.js'

const ABSOLUTE_CEILING = Math.max(visionTierMaxTokens('standard'), visionTierMaxTokens('high'))

describe('image-text records a vision-priced saving, not a byte-derived one', () => {
  it('books tokens within the vision ceiling', async () => {
    const image = join(process.cwd(), 'assets', 'logo.png')
    // Fail closed: a silent skip must never read as a pass.
    expect(existsSync(image)).toBe(true)

    const before = summarize(30).by_kind['image_text']
    const beforeEvents = before?.events ?? 0
    const beforeTokens = before?.tokens_saved ?? 0

    await run(['node', 'token-goat', 'image-text', image])

    const after = summarize(30).by_kind['image_text']
    expect(after).toBeDefined()
    const events = (after?.events ?? 0) - beforeEvents
    expect(events).toBeGreaterThan(0)

    const tokens = (after?.tokens_saved ?? 0) - beforeTokens
    // The load-bearing assertion: this command never learns the image's pixel dimensions, so the
    // honest figure is bounded by the tier ceiling. The old formula used the file's byte count.
    expect(tokens).toBeLessThanOrEqual(ABSOLUTE_CEILING * events)

    // Independent cross-check that the pre-fix formula genuinely would have breached that bound, so
    // the assertion above is not vacuously satisfied by a small input.
    const byteDerived = Math.round(statSync(image).size / 4)
    expect(byteDerived).toBeGreaterThan(ABSOLUTE_CEILING)

    // NON-FIRING half: the command must still book a real, positive saving. A fix that simply
    // stopped recording would pass a ceiling check on its own.
    expect(tokens).toBeGreaterThan(0)
  })
})
