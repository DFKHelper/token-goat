/** Pure helpers of the chunking hillclimb (scripts/eval-chunking.ts). Every fixture is HAND-DERIVED: vectors, token counts and intervals are written here and the expected distances, orderings and verdicts worked out by hand from them, never read back from the script. */
import { describe, expect, it } from 'vitest'
import { MAX_CHUNK_TOKENS } from '../src/embeddings.js'
import { BASELINE, decide, l2, nearest, scaledCounter } from '../scripts/eval-chunking.js'

const words = (t: string): number => t.split(' ').filter(Boolean).length

describe('scaledCounter', () => {
  it('passes the real count through at the production budget', () => {
    const count = scaledCounter(words, MAX_CHUNK_TOKENS)
    expect(count('a b c')).toBe(3)
  })

  it('makes a text fit a smaller budget exactly when its real count does', () => {
    const count = scaledCounter(words, 128)
    const at = Array.from({ length: 128 }, () => 'w').join(' ')
    expect(count(at)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS)
    expect(count(`${at} w`)).toBeGreaterThan(MAX_CHUNK_TOKENS)
  })

  it('rounds a fractional scaled count up, so a chunk never fits a budget its real count overruns', () => {
    // 1 word at a 384-token budget scales to 512/384 = 1.33, which has to count as 2.
    expect(scaledCounter(words, 384)('w')).toBe(2)
  })

  it('never shrinks the count for a budget above the model window, which chunkFile cannot honour anyway', () => {
    expect(scaledCounter(words, MAX_CHUNK_TOKENS * 2)('a b c')).toBe(3)
  })
})

describe('l2 and nearest', () => {
  it('measures Euclidean distance', () => {
    expect(l2([0, 0], [3, 4])).toBe(5)
  })

  it('keeps the k nearest within the threshold, nearest first, ties in corpus order', () => {
    const q = [0, 0]
    const vs = [[0, 2], [1, 0], [0, 1], [5, 0], [0, 0.5]]
    expect(nearest(q, vs, 3, 1.2)).toEqual([
      { index: 4, distance: 0.5 },
      { index: 1, distance: 1 },
      { index: 2, distance: 1 },
    ])
  })

  it('keeps a vector exactly at the threshold, as the `<=` in the production distance filter does', () => {
    expect(nearest([0, 0], [[0, 1]], 5, 1)).toEqual([{ index: 0, distance: 1 }])
  })

  it('stops at k even when more vectors fall within the threshold', () => {
    expect(nearest([0, 0], [[0, 0.5], [0, 0.25], [0, 0.75]], 2, 1).map((h) => h.index)).toEqual([1, 0])
  })

  it('drops everything past the threshold even when k is not reached', () => {
    expect(nearest([0, 0], [[2, 0], [0, 3]], 10, 1.2)).toEqual([])
  })
})

describe('decide', () => {
  const iv = (mean: number, lo: number, hi: number) => ({ mean, lo, hi })

  it('accepts when the train interval clears zero and the test delta is positive', () => {
    expect(decide(iv(0.05, 0.01, 0.09), iv(0.02, -0.03, 0.07)).accept).toBe(true)
  })

  it('rejects a train interval that touches zero', () => {
    expect(decide(iv(0.05, 0, 0.09), iv(0.05, 0.01, 0.09)).accept).toBe(false)
  })

  it('rejects a train gain the held-out split does not share', () => {
    const v = decide(iv(0.05, 0.01, 0.09), iv(0, -0.04, 0.04))
    expect(v.accept).toBe(false)
    expect(v.reason).toMatch(/test delta/)
  })
})

it('pins the baseline to the production chunking', () => {
  expect(BASELINE).toEqual({ name: 'baseline', tokens: MAX_CHUNK_TOKENS, overlap: 200, boundaries: true })
})
