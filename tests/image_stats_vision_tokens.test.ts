// Image savings must be priced in visual tokens, not by the text bytes/4 divisor.
//
// An image is billed as 28x28-pixel patches and a single full-size image cannot exceed the vision
// tier's maximum (1,568 tokens at the standard tier, 4,784 at high). Running an image's BYTE count
// through savedTokensFromBytes therefore prices it in the wrong unit entirely, and in the direction
// that flatters: one real image_meta row credited 1,856,507 tokens for a 7.4 MB source, over a
// thousand times any possible ceiling.
//
// FIXTURE PROVENANCE
// - Tier limits (standard maxEdge/maxTokens 1568/1568, high 2576/4784) are FORMAT-DERIVED from
//   VISION_TIER_LIMITS in src/image_shrink.ts, which is this repo's encoding of Anthropic's
//   documented vision pricing. They are used here only as the CEILING an honest figure must respect,
//   never as the expected value, so the assertions do not reduce to the producer restating itself.
// - Expected token figures are HAND-DERIVED: computed in the test from patch arithmetic
//   (ceil(w/28) * ceil(h/28)) and the emitted text length, independently of the production helper.
// - The 1,856,507-token row is CAPTURE from the real stats ledger. Only that number appears here.

import { describe, it, expect } from 'vitest'
import { visionTokens, visionTokensSaved, visionTokensSavedByText, visionTierMaxTokens } from '../src/image_shrink.js'

const PATCH = 28
/** Patch count for an image small enough that no downscale applies. HAND-DERIVED, not from the producer. */
function patches(w: number, h: number): number {
  return Math.ceil(w / PATCH) * Math.ceil(h / PATCH)
}

describe('image savings are priced in visual tokens', () => {
  it('prices a small image by its own patch count', () => {
    expect(visionTokens(280, 280, 'standard')).toBe(patches(280, 280))
    expect(visionTokens(280, 280, 'standard')).toBe(100)
  })

  it('exposes the per-tier ceiling a single image cannot exceed', () => {
    expect(visionTierMaxTokens('standard')).toBe(1568)
    expect(visionTierMaxTokens('high')).toBe(4784)
  })

  // The load-bearing property: no image, at any pixel size, may be credited above its tier ceiling.
  // This is what the byte divisor violated by three orders of magnitude.
  it('never credits an image above the tier ceiling however large it is', () => {
    const sizes: Array<[number, number]> = [[4000, 3000], [10000, 10000], [40000, 30000]]
    expect(sizes.length).toBeGreaterThan(0)
    for (const tier of ['standard', 'high'] as const) {
      for (const [w, h] of sizes) {
        expect(visionTokens(w, h, tier)).toBeLessThanOrEqual(visionTierMaxTokens(tier))
        expect(visionTokensSavedByText(w, h, 0, tier)).toBeLessThanOrEqual(visionTierMaxTokens(tier))
        expect(visionTokensSaved(w, h, 1, 1, tier)).toBeLessThanOrEqual(visionTierMaxTokens(tier))
      }
    }
  })

  // The specific over-crediting shape the fix removes: a 7.4 MB image whose byte count was booked as
  // 1,856,507 tokens. Whatever its dimensions, the honest figure is orders of magnitude smaller.
  it('credits far less than the byte divisor did for a multi-megabyte image', () => {
    const OVER_CREDITED_ROW_TOKENS = 1_856_507
    const honest = visionTokensSavedByText(6000, 4000, 120, 'standard')
    expect(honest).toBeLessThanOrEqual(visionTierMaxTokens('standard'))
    expect(honest * 1000).toBeLessThan(OVER_CREDITED_ROW_TOKENS)
  })

  // The text side is subtracted at the repo's text rate, so a long emitted body reduces the credit.
  it('subtracts the emitted text at the text rate', () => {
    const imageSide = visionTokens(280, 280, 'standard')
    expect(visionTokensSavedByText(280, 280, 400, 'standard')).toBe(imageSide - Math.round(400 / 4))
  })

  // Dimensions genuinely unavailable (image-text: OCR needs no decoder that reports them) must fall
  // back to the tier ceiling rather than inventing a byte-derived number.
  it('falls back to the tier ceiling when dimensions are unavailable', () => {
    expect(visionTokensSavedByText(null, null, 0, 'standard')).toBe(1568)
    expect(visionTokensSavedByText(null, null, 400, 'standard')).toBe(1568 - 100)
    expect(visionTokensSavedByText(null, null, 0, 'high')).toBe(4784)
  })

  // Clamped at zero: a text body more expensive than the image it replaced is not a negative saving
  // to be booked, it is a branch that should not have been credited.
  it('never returns a negative credit', () => {
    expect(visionTokensSavedByText(56, 56, 1_000_000, 'standard')).toBe(0)
  })

  // NON-FIRING GUARD: pricing in visual tokens must not collapse ordinary images to zero credit.
  // Asserts over a non-empty set, non-emptiness checked before the loop, and every case must produce
  // a strictly positive credit -- so a fix that simply zeroed image savings fails here.
  it('non-firing: every ordinary image still earns a positive credit', () => {
    const cases: Array<{ w: number; h: number; textBytes: number }> = [
      { w: 800, h: 600, textBytes: 120 },
      { w: 1024, h: 768, textBytes: 200 },
      { w: 1920, h: 1080, textBytes: 300 },
      { w: 2560, h: 1440, textBytes: 400 },
    ]
    expect(cases.length).toBeGreaterThan(0)
    let asserted = 0
    for (const { w, h, textBytes } of cases) {
      const credit = visionTokensSavedByText(w, h, textBytes, 'standard')
      expect(credit).toBeGreaterThan(0)
      expect(credit).toBeLessThanOrEqual(visionTierMaxTokens('standard'))
      // Independently computed upper bound: the image side can never exceed its own patch count.
      expect(credit).toBeLessThanOrEqual(patches(w, h))
      asserted += 1
    }
    expect(asserted).toBe(cases.length)
  })
})
