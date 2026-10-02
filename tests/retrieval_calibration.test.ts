/** `evals/retrieval/calibration.ts` scores how the retrieval eval's commands abstain. Provenance: HAND-DERIVED. Every expected rate and threshold below is worked from the listed distances on paper, candidate by candidate, never read back from the implementation. */
import { describe, expect, it } from 'vitest'

import { abstainsAt, abstentionRates, fitWeakThreshold, scoreThreshold } from '../evals/retrieval/calibration.js'

describe('abstentionRates', () => {
  it('splits the rate by whether the answer exists', () => {
    // Absent: two of three abstained (2/3). Present: one of four abstained (1/4), the false alarm rate.
    const rows = [
      { absent: true, abstained: true },
      { absent: true, abstained: true },
      { absent: true, abstained: false },
      { absent: false, abstained: false },
      { absent: false, abstained: false },
      { absent: false, abstained: false },
      { absent: false, abstained: true },
    ]
    const r = abstentionRates(rows)
    expect(r.onAbsent?.mean).toBeCloseTo(2 / 3, 12)
    expect(r.onPresent?.mean).toBe(0.25)
    expect(r.onPresent?.lo).toBeLessThanOrEqual(0.25)
    expect(abstentionRates(rows.filter((x) => !x.absent)).onAbsent).toBeNull()
  })
})

describe('abstainsAt', () => {
  it('abstains strictly above the line, and with no dense match at all', () => {
    expect(abstainsAt(0.85, 0.85)).toBe(false)
    expect(abstainsAt(0.851, 0.85)).toBe(true)
    expect(abstainsAt(null, 2)).toBe(true)
  })
})

// Present queries closest at 0.6, 0.7, 0.9; absent ones at 0.8, 0.95 and one with no dense match.
const ROWS = [
  { absent: false, closest: 0.6 },
  { absent: false, closest: 0.7 },
  { absent: false, closest: 0.9 },
  { absent: true, closest: 0.8 },
  { absent: true, closest: 0.95 },
  { absent: true, closest: null },
]

describe('scoreThreshold', () => {
  it('averages the miss rate on absent queries with the false alarm rate on present ones', () => {
    // At 0.85: absent 0.95 and null abstain (2/3), 0.8 does not; present 0.9 abstains (1/3). (1/3 + 1/3) / 2 = 1/3.
    const s = scoreThreshold(ROWS, 0.85)
    expect(s?.onAbsent).toBeCloseTo(2 / 3, 12)
    expect(s?.onPresent).toBeCloseTo(1 / 3, 12)
    expect(s?.balancedError).toBeCloseTo(1 / 3, 12)
  })

  it('declines to score a set missing one class', () => {
    expect(scoreThreshold(ROWS.filter((r) => r.absent), 0.85)).toBeNull()
    expect(scoreThreshold(ROWS.filter((r) => !r.absent), 0.85)).toBeNull()
  })
})

describe('fitWeakThreshold', () => {
  it('picks the lowest balanced error and breaks a tie toward the higher line', () => {
    // Candidates 0.3, 0.65, 0.75, 0.85, 0.925, 0.95 give balanced errors 1/2, 1/3, 1/6, 1/3, 1/6, 1/3. 0.75 (miss none, alarm on 0.9) and 0.925 (miss 0.8, alarm on none) tie at 1/6; the higher one wins.
    const fit = fitWeakThreshold(ROWS)
    expect(fit?.threshold).toBeCloseTo(0.925, 12)
    expect(fit?.balancedError).toBeCloseTo(1 / 6, 12)
    expect(fit?.onPresent).toBe(0)
  })

  it('separates two clean populations in the gap between them', () => {
    // Present 0.5, 0.6; absent 0.9, 1.0. Only the midpoint 0.75 scores 0.
    const fit = fitWeakThreshold([
      { absent: false, closest: 0.5 },
      { absent: false, closest: 0.6 },
      { absent: true, closest: 0.9 },
      { absent: true, closest: 1.0 },
    ])
    expect(fit).toEqual({ threshold: 0.75, onAbsent: 1, onPresent: 0, balancedError: 0 })
  })

  it('can pick the largest distance itself, abstaining only where no dense match came back', () => {
    // Present 0.5, 0.9; both absent queries matched nothing. Candidates 0.25, 0.7, 0.9 score 1/2, 1/4, 0: only the last keeps 0.9 answered.
    const fit = fitWeakThreshold([
      { absent: false, closest: 0.5 },
      { absent: false, closest: 0.9 },
      { absent: true, closest: null },
      { absent: true, closest: null },
    ])
    expect(fit).toEqual({ threshold: 0.9, onAbsent: 1, onPresent: 0, balancedError: 0 })
  })

  it('returns null with no distance or one class missing', () => {
    expect(fitWeakThreshold([{ absent: true, closest: null }, { absent: false, closest: null }])).toBeNull()
    expect(fitWeakThreshold(ROWS.filter((r) => !r.absent))).toBeNull()
  })
})
