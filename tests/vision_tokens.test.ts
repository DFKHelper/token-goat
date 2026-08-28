import { describe, expect, it } from 'vitest'

import { visionTokens, visionTokensSaved } from '../src/image_shrink.js'

// Provenance: FORMAT-DERIVED, from the billing authority's own published documentation rather than
// from anything in this repository. Every dimension/token pair below is copied out of the "Resolution
// and token cost" table at
// https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
// and the worked A4 example at
// https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images
// both fetched 2026-08-27. These are the numbers the API says it charges, so a disagreement here is
// our arithmetic being wrong about a real bill, not two of our own files agreeing with each other.
// That distinction is the whole point: a fixture read off our own matcher would have agreed with any
// formula we shipped, including the bytes/4 one this replaces.
//
// Deliberately NOT included: any case computed by running visionTokens and recording what it said.

/** Every row of the doc's table, as `[width, height, standardTierTokens, highResTierTokens]`. */
const DOC_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [200, 200, 64, 64],
  [1000, 1000, 1296, 1296],
  [1092, 1092, 1521, 1521],
  [1920, 1080, 1560, 2691],
  [2000, 1500, 1564, 3888],
  [3840, 2160, 1560, 4784],
]

describe('visionTokens matches Anthropic\'s published per-tier billing', () => {
  for (const [width, height, standard, high] of DOC_TABLE) {
    it(`${width}x${height} costs ${standard} on the standard tier and ${high} on high-resolution`, () => {
      expect(visionTokens(width, height, 'standard')).toBe(standard)
      expect(visionTokens(width, height, 'high')).toBe(high)
    })
  }

  it('resizes on the token budget even when both edges are already under the edge limit', () => {
    // The doc's A4-at-130-DPI example, called out there as the most commonly overlooked case: both
    // sides are below the 1568px standard-tier edge limit, but 39 x 55 = 2145 tokens exceeds the
    // 1568-token budget, so the standard tier still resizes it (to 924x1307 = 33 x 47 = 1551). The
    // high-resolution tier has budget for 2145 and leaves it alone. A "cap the long edge" shortcut
    // gets both of these wrong, which is why this is asserted separately from the table above.
    expect(visionTokens(1075, 1520, 'standard')).toBe(1551)
    expect(visionTokens(1075, 1520, 'high')).toBe(2145)
  })

  it('bills a portrait image exactly as its landscape transpose', () => {
    // A patch count multiplies its two axes, so transposing cannot change it. This is what makes it
    // safe for ShrinkResult to carry pre-EXIF-rotation dimensions, which may be transposed relative
    // to what the model is shown.
    for (const [width, height] of DOC_TABLE) {
      expect(visionTokens(height, width, 'standard')).toBe(visionTokens(width, height, 'standard'))
      expect(visionTokens(height, width, 'high')).toBe(visionTokens(width, height, 'high'))
    }
  })

  it('never exceeds the tier\'s own token budget, however large the input', () => {
    // The cap is the reason a saving must be measured against the downscaled original rather than
    // the raw one. 8000x8000 is the API's documented maximum accepted dimension.
    expect(visionTokens(8000, 8000, 'standard')).toBeLessThanOrEqual(1568)
    expect(visionTokens(8000, 8000, 'high')).toBeLessThanOrEqual(4784)
    expect(visionTokens(8000, 100, 'standard')).toBeLessThanOrEqual(1568)
  })

  it('returns zero for a size a decoder failed to populate, rather than throwing', () => {
    // Dimensions reach this function from image metadata that sharp may leave undefined, which
    // callers coalesce to 0. A stat row must never be the thing that fails a Read.
    expect(visionTokens(0, 0, 'standard')).toBe(0)
    expect(visionTokens(-5, 100, 'standard')).toBe(0)
    expect(visionTokens(Number.NaN, 100, 'high')).toBe(0)
    expect(visionTokens(Number.POSITIVE_INFINITY, 100, 'high')).toBe(0)
  })
})

describe('visionTokensSaved prices a shrink in the unit that bills', () => {
  it('credits nothing for a 4K screenshot on the standard tier, where the API already capped it', () => {
    // The load-bearing case, and the one the old bytes/4 formula got most wrong: 3840x2160 and the
    // 1568x882 token-goat resizes it to are both billed at the same 1560 tokens on this tier,
    // because the API downsizes the original to 1456x819 itself before charging. Megabytes come off
    // the wire and not one visual token comes off the bill.
    expect(visionTokens(1568, 882, 'standard')).toBe(1560)
    expect(visionTokensSaved(3840, 2160, 1568, 882, 'standard')).toBe(0)
  })

  it('credits the real saving for that same screenshot on the high-resolution tier', () => {
    // Same pixels, same resize, a tier that would have paid 4784 for the original and pays
    // 56 x 32 = 1792 for the resize. This is why the tier is configurable rather than assumed.
    expect(visionTokens(1568, 882, 'high')).toBe(1792)
    expect(visionTokensSaved(3840, 2160, 1568, 882, 'high')).toBe(4784 - 1792)
  })

  it('clamps at zero rather than booking a negative saving when the output is larger', () => {
    expect(visionTokensSaved(200, 200, 1000, 1000, 'standard')).toBe(0)
  })

  it('is not the byte ratio in disguise', () => {
    // A guard against quietly reverting to a bytes-shaped approximation: these two shrinks remove
    // very different pixel counts, so any formula that reports the same figure for both, or that
    // scales with the input's byte size, is not measuring patches.
    const small = visionTokensSaved(1000, 1000, 500, 500, 'high')
    const large = visionTokensSaved(3000, 3000, 500, 500, 'high')
    expect(small).toBe(1296 - 324)
    expect(large).toBeGreaterThan(small)
  })
})
